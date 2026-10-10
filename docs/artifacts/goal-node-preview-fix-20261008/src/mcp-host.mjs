import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const MAX_SERVERS = 16;
const MAX_TOOLS_PER_SERVER = 64;
const MAX_OUTPUT_CHARS = 64 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SECRET_ENV = /(?:key|token|secret|password|credential|authorization)/iu;

const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const forbiddenHost = (host) => {
  const normalized = String(host).toLowerCase().replace(/^\[|\]$/gu, '');
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === 'metadata.google.internal') return true;
  if (isIP(normalized) === 4) {
    const octets = normalized.split('.').map(Number);
    return octets[0] === 10 || octets[0] === 127 || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168);
  }
  if (isIP(normalized) === 6) return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb');
  return false;
};

const validateConfig = (config) => {
  if (!plainObject(config) || !Array.isArray(config.servers) || config.servers.length > MAX_SERVERS) throw new Error('MCP_CONFIG_INVALID');
  const servers = config.servers.map((server) => {
    if (!plainObject(server) || typeof server.id !== 'string' || !ID_PATTERN.test(server.id)
      || !['stdio', 'http'].includes(server.transport)) throw new Error('MCP_CONFIG_INVALID');
    const readOnlyTools = Array.isArray(server.readOnlyTools)
      ? [...new Set(server.readOnlyTools.filter((name) => typeof name === 'string' && /^[A-Za-z0-9._:-]{1,128}$/u.test(name)))]
      : [];
    if (readOnlyTools.length > MAX_TOOLS_PER_SERVER) throw new Error('MCP_CONFIG_INVALID');
    if (server.transport === 'stdio') {
      if (typeof server.command !== 'string' || !server.command.trim() || server.command.length > 512) throw new Error('MCP_CONFIG_INVALID');
      const args = server.args === undefined ? [] : server.args;
      if (!Array.isArray(args) || args.length > 64 || args.some((arg) => typeof arg !== 'string' || arg.length > 512)) throw new Error('MCP_CONFIG_INVALID');
      const env = server.env === undefined ? {} : server.env;
      if (!plainObject(env) || Object.keys(env).length > 16) throw new Error('MCP_CONFIG_INVALID');
      for (const [key, value] of Object.entries(env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || SECRET_ENV.test(key) || typeof value !== 'string' || value.length > 4096) throw new Error('MCP_CONFIG_INVALID');
      }
      return { id: server.id, transport: 'stdio', command: server.command.trim(), args, env, ...(server.cwd ? { cwd: String(server.cwd).slice(0, 512) } : {}), readOnlyTools };
    }
    let url;
    try {
      url = new URL(server.url);
    } catch {
      throw new Error('MCP_CONFIG_INVALID');
    }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || forbiddenHost(url.hostname)) throw new Error('MCP_CONFIG_INVALID');
    return { id: server.id, transport: 'http', url: url.toString(), readOnlyTools };
  });
  if (new Set(servers.map((server) => server.id)).size !== servers.length) throw new Error('MCP_CONFIG_DUPLICATE');
  return { servers };
};

export const loadMcpConfig = async (configPath) => {
  if (!configPath) return { servers: [] };
  let parsed;
  try {
    parsed = JSON.parse(await readFile(configPath, 'utf8'));
  } catch {
    throw new Error('MCP_CONFIG_READ_FAILED');
  }
  return validateConfig(parsed);
};

const safeSchema = (schema, depth = 0) => {
  if (!plainObject(schema) || depth > 8) return { type: 'object', properties: {}, required: [], additionalProperties: false };
  const output = {};
  for (const key of ['title', 'description', 'type', 'enum', 'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems', 'pattern']) {
    if (schema[key] !== undefined) output[key] = schema[key];
  }
  if (Array.isArray(schema.required)) output.required = schema.required.filter((item) => typeof item === 'string').slice(0, 128);
  if (plainObject(schema.properties)) {
    output.properties = Object.fromEntries(Object.entries(schema.properties).slice(0, 128).map(([key, value]) => [key, safeSchema(value, depth + 1)]));
  }
  if (plainObject(schema.items)) output.items = safeSchema(schema.items, depth + 1);
  output.type ??= plainObject(output.properties) ? 'object' : 'string';
  if (output.type === 'object') output.additionalProperties = false;
  return output;
};

const contentText = (result) => {
  const parts = Array.isArray(result?.content) ? result.content.map((item) => {
    if (item?.type === 'text' && typeof item.text === 'string') return item.text;
    if (item?.type === 'resource' && typeof item.resource?.text === 'string') return item.resource.text;
    return item?.type ? `[${item.type}]` : '';
  }).filter(Boolean) : [];
  return parts.join('\n').slice(0, MAX_OUTPUT_CHARS);
};

const safeStdioEnv = (provided) => {
  const env = {};
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'ComSpec']) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key];
  }
  return { ...env, ...provided };
};

const serverFetch = (origin) => async (input, init = {}) => {
  const target = new URL(typeof input === 'string' ? input : input.url, origin);
  if (target.origin !== origin.origin || !['https:', 'http:'].includes(target.protocol)) throw new Error('MCP_NETWORK_TARGET_FORBIDDEN');
  return fetch(target, { ...init, redirect: 'error' });
};

export class McpReadOnlyHost {
  #configs;
  #connections = new Map();

  constructor({ config = { servers: [] } } = {}) {
    this.#configs = validateConfig(config);
  }

  async connectAndRegister(registry) {
    for (const config of this.#configs.servers) {
      const client = new Client({ name: 'dda', version: '0.1.0' });
      let transport;
      if (config.transport === 'stdio') {
        transport = new StdioClientTransport({ command: config.command, args: config.args, cwd: config.cwd, env: safeStdioEnv(config.env), stderr: 'pipe' });
      } else {
        const url = new URL(config.url);
        transport = new StreamableHTTPClientTransport(url, { fetch: serverFetch(url) });
      }
      try {
        await client.connect(transport);
        const listing = await client.listTools();
        const tools = Array.isArray(listing?.tools) ? listing.tools.slice(0, MAX_TOOLS_PER_SERVER) : [];
        for (const remote of tools) {
          const remoteName = typeof remote?.name === 'string' ? remote.name : '';
          const explicitlyReadOnly = config.readOnlyTools.includes(remoteName);
          const annotatedReadOnly = remote?.annotations?.readOnlyHint === true;
          if (!remoteName || (!explicitlyReadOnly && !annotatedReadOnly)) continue;
          const name = `mcp.${config.id}.${remoteName}`;
          registry.register({
            name,
            description: `Read-only MCP tool ${config.id}/${remoteName}.`,
            inputSchema: safeSchema(remote.inputSchema),
            readOnly: true,
            metadata: { actionClass: 'READ_ONLY', mcpServer: config.id, mcpTool: remoteName },
            handler: async (input) => {
              const result = await client.callTool({ name: remoteName, arguments: input });
              return {
                server: config.id,
                tool: remoteName,
                isError: result?.isError === true,
                text: contentText(result)
              };
            }
          });
        }
        this.#connections.set(config.id, { client, transport });
      } catch (error) {
        await client.close().catch(() => {});
        throw new Error(`MCP_CONNECT_FAILED:${config.id}`);
      }
    }
    return registry;
  }

  async close() {
    for (const { client } of this.#connections.values()) await client.close().catch(() => {});
    this.#connections.clear();
  }
}

export const createMcpReadOnlyHost = (options) => new McpReadOnlyHost(options);
