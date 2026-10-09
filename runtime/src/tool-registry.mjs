/**
 * Provider-neutral registry for tools that are safe to expose to the runtime.
 *
 * A tool is deliberately just a name, JSON schemas and a function.  The
 * registry does not know which model/provider requested the call and never
 * exposes the function through list(); callers only receive immutable
 * metadata.  Definitions are read-only by construction: an explicitly
 * writable definition is rejected at registration time.
 */

import { createHash } from 'node:crypto';
import { cordisPlugin } from './plugins/cordis-plugin.mjs';

const OBJECT_TAG = '[object Object]';
const MAX_SCHEMA_DEPTH = 24;
const MAX_SCHEMA_NODES = 512;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_OUTPUT_CHARS = 64 * 1024;

const SUPPORTED_SCHEMA_KEYS = new Set([
  '$schema',
  'title',
  'description',
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'anyOf',
  'oneOf',
  'allOf'
]);

const JSON_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const DEFINITION_KEYS = new Set([
  'name',
  'id',
  'description',
  'inputSchema',
  'outputSchema',
  'handler',
  'invoke',
  'execute',
  'readOnly',
  'metadata'
]);

export const TOOL_ERROR_CODES = Object.freeze({
  INVALID_DEFINITION: 'TOOL_INVALID_DEFINITION',
  INVALID_NAME: 'TOOL_INVALID_NAME',
  DUPLICATE: 'TOOL_DUPLICATE',
  NOT_FOUND: 'TOOL_NOT_FOUND',
  INVALID_SCHEMA: 'TOOL_INVALID_SCHEMA',
  UNSUPPORTED_SCHEMA: 'TOOL_UNSUPPORTED_SCHEMA',
  NON_STRICT_SCHEMA: 'TOOL_SCHEMA_NOT_STRICT',
  INVALID_INPUT: 'TOOL_INVALID_INPUT',
  INVALID_OUTPUT: 'TOOL_INVALID_OUTPUT',
  OUTPUT_TOO_LARGE: 'TOOL_OUTPUT_TOO_LARGE',
  HANDLER_FAILED: 'TOOL_HANDLER_FAILED'
});

const isObject = (value) => value !== null && typeof value === 'object';

const isPlainObject = (value) => isObject(value)
  && Object.prototype.toString.call(value) === OBJECT_TAG
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const isSafePropertyName = (name) => name !== '__proto__' && name !== 'prototype' && name !== 'constructor';

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const ownKeys = (value) => Object.keys(value);

const pathJoin = (path, key) => path ? `${path}.${key}` : key;

const clone = (value, code, message) => {
  try {
    return structuredClone(value);
  } catch {
    throw new ToolRegistryError(code, message);
  }
};

const freeze = (value, seen = new WeakSet()) => {
  if (!isObject(value) || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
};

const isJsonValue = (value, seen = new WeakSet()) => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    const valid = value.every((child) => isJsonValue(child, seen));
    seen.delete(value);
    return valid;
  }
  if (!isPlainObject(value)) return false;
  const valid = ownKeys(value).every((key) => isSafePropertyName(key) && isJsonValue(value[key], seen));
  seen.delete(value);
  return valid;
};

const jsonEqual = (left, right) => {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
};

const safeInvocationErrorMessage = (error) => {
  const raw = error instanceof Error ? error.message : '';
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,96}$/.test(error.code)
    ? error.code
    : typeof raw === 'string' ? raw.match(/^([A-Z][A-Z0-9_]{1,96})(?::|$)/)?.[1] : undefined;
  if (!code || !/^(?:TOOL|WORKSPACE|SAFETY|EXECUTOR)_[A-Z0-9_]+$/u.test(code)) return undefined;
  const message = raw.startsWith(`${code}:`) ? raw.slice(code.length + 1) : raw;
  const normalized = message.replace(/[\u0000-\u001f\u007f\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 640);
  return normalized || undefined;
};

const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

const digest = (value) => `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;

const schemaError = (code, path, message) => {
  throw new ToolRegistryError(code, `${path}: ${message}`, { path });
};

const assertFiniteInteger = (value, path, name, { minimum = 0 } = {}) => {
  if (!Number.isInteger(value) || value < minimum) schemaError(TOOL_ERROR_CODES.INVALID_SCHEMA, path, `${name} must be an integer >= ${minimum}`);
};

/**
 * Validate and normalize the small JSON Schema dialect used by tools.  The
 * normalization makes object schemas strict by default; explicitly setting
 * additionalProperties to true is rejected because it defeats the registry's
 * input boundary.
 */
const normalizeSchema = (schema, path = 'schema', state = { depth: 0, nodes: 0 }) => {
  if (!isPlainObject(schema)) schemaError(TOOL_ERROR_CODES.INVALID_SCHEMA, path, 'schema must be an object');
  state.nodes += 1;
  if (state.nodes > MAX_SCHEMA_NODES) schemaError(TOOL_ERROR_CODES.INVALID_SCHEMA, path, 'schema is too large');
  if (state.depth > MAX_SCHEMA_DEPTH) schemaError(TOOL_ERROR_CODES.INVALID_SCHEMA, path, 'schema is too deep');

  for (const key of ownKeys(schema)) {
    if (!SUPPORTED_SCHEMA_KEYS.has(key)) schemaError(TOOL_ERROR_CODES.UNSUPPORTED_SCHEMA, pathJoin(path, key), 'unsupported keyword');
    if (!isSafePropertyName(key)) schemaError(TOOL_ERROR_CODES.INVALID_SCHEMA, pathJoin(path, key), 'unsafe keyword');
  }

  const output = {};
  if (hasOwn(schema, '$schema')) {
    if (typeof schema.$schema !== 'string' || schema.$schema.length > 256) schemaError(TOOL_ERROR_CODES.INVALID_SCHEMA, path, '$schema must be a short string');
    output.$schema = schema.$schema;
  }
  for (const key of ['title', 'description']) {
    if (hasOwn(schema, key)) {
      if (typeof schema[key] !== 'string' || schema[key].length > 4096) schemaError(TOOL_ERROR_CODES.INVALID_SCHEMA, pathJoin(path, key), `${key} must be a string`);
      output[key] = schema[key];
    }
  }

  if (hasOwn(schema, 'type')) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.length || types.some((type) => typeof type !== 'string' || !JSON_TYPES.has(type))) {
      schemaError(TOOL_ERROR_CODES.INVALID_SCHEMA, pathJoin(path, 'type'), 'type must be a JSON type or list of JSON types');
    }
    output.type = Array.isArray(schema.type) ? [...schema.type] : schema.type;
  }

  if (hasOwn(schema, 'properties')) {
    if (!isPlainObject(schema.properties)) schemaError(TOOL_ERROR_CODES.INVALID_SCHEMA, pathJoin(path, 'properties'), 'properties must be an object');
    const properties = {};
    for (const [key, child] of Object.entries(schema.properties)) {
      if (!isSafePropertyName(key)) schemaError(TOOL_ERROR_CODES.INVALID_SCHEMA, pathJoin(path, `properties.${key}`), 'unsafe property name');
      const childState = { depth: state.depth + 1, nodes: state.nodes };
      properties[key] = normalizeSchema(child, pathJoin(path, `properties.${key}`), childState);
      state.nodes = childState.nodes;
    }
    output.properties = properties;
  }

  if (hasOwn(schema, 'required')) {
    if (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== 'string' || !isSafePropertyName(key))) {
      schemaError(TOOL_ERROR_CODES.INVALID_SCHEMA, pathJoin(path, 'required'), 'required must be a list of safe property names');
    }
    if (new Set(schema.required).size !== schema.required.length) schemaError(TOOL_ERROR_CODES.INVALID_SCHEMA, pathJoin(path, 'required'), 'required contains duplicates');
    if (schema.properties && schema.required.some((key) => !hasOwn(schema.properties, key))) {
      schemaError(TOOL_ERROR_CODES.INVALID_SCHEMA, pathJoin(path, 'required'), 'required property is not declared');
    }
    output.required = [...schema.required];
  }

  if (hasOwn(schema, 'additionalProperties')) {
    if (schema.additionalProperties !== false) schemaError(TOOL_ERROR_CODES.NON_STRICT_SCHEMA, pathJoin(path, 'additionalProperties'), 'must be false');
    output.additionalProperties = false;
  } else if (schema.type === 'object' || (Array.isArray(schema.type) && schema.type.includes('object')) || hasOwn(schema, 'properties')) {
    output.additionalProperties = false;
  }

  if (hasOwn(schema, 'items')) {
    if (Array.isArray(schema.items)) schemaError(TOOL_ERROR_CODES.UNSUPPORTED_SCHEMA, pathJoin(path, 'items'), 'tuple schemas are unsupported');
    const childState = { depth: state.depth + 1, nodes: state.nodes };
    output.items = normalizeSchema(schema.items, pathJoin(path, 'items'), childState);
    state.nodes = childState.nodes;
  }

  if (hasOwn(schema, 'enum')) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0 || !schema.enum.every((value) => isJsonValue(value))) {
      schemaError(TOOL_ERROR_CODES.INVALID_SCHEMA, pathJoin(path, 'enum'), 'enum must be a non-empty JSON value list');
    }
    output.enum = clone(schema.enum, TOOL_ERROR_CODES.INVALID_SCHEMA, 'enum cannot be cloned');
  }
  if (hasOwn(schema, 'const')) {
    if (!isJsonValue(schema.const)) schemaError(TOOL_ERROR_CODES.INVALID_SCHEMA, pathJoin(path, 'const'), 'const must be a JSON value');
    output.const = clone(schema.const, TOOL_ERROR_CODES.INVALID_SCHEMA, 'const cannot be cloned');
  }

  const integerKeywords = [
    ['minLength', 0], ['maxLength', 0], ['minItems', 0], ['maxItems', 0],
    ['minProperties', 0], ['maxProperties', 0]
  ];
  for (const [key, minimum] of integerKeywords) {
    if (hasOwn(schema, key)) {
      assertFiniteInteger(schema[key], pathJoin(path, key), key, { minimum });
      output[key] = schema[key];
    }
  }
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']) {
    if (hasOwn(schema, key)) {
      if (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]) || (key === 'multipleOf' && schema[key] <= 0)) {
        schemaError(TOOL_ERROR_CODES.INVALID_SCHEMA, pathJoin(path, key), `${key} must be a finite number`);
      }
      output[key] = schema[key];
    }
  }
  if (hasOwn(schema, 'pattern')) {
    if (typeof schema.pattern !== 'string' || schema.pattern.length > 1024) schemaError(TOOL_ERROR_CODES.INVALID_SCHEMA, pathJoin(path, 'pattern'), 'pattern must be a short string');
    try { new RegExp(schema.pattern); } catch { schemaError(TOOL_ERROR_CODES.INVALID_SCHEMA, pathJoin(path, 'pattern'), 'pattern is invalid'); }
    output.pattern = schema.pattern;
  }
  if (hasOwn(schema, 'uniqueItems')) {
    if (typeof schema.uniqueItems !== 'boolean') schemaError(TOOL_ERROR_CODES.INVALID_SCHEMA, pathJoin(path, 'uniqueItems'), 'uniqueItems must be boolean');
    output.uniqueItems = schema.uniqueItems;
  }

  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (hasOwn(schema, key)) {
      if (!Array.isArray(schema[key]) || schema[key].length === 0) schemaError(TOOL_ERROR_CODES.INVALID_SCHEMA, pathJoin(path, key), `${key} must be a non-empty list`);
      const childState = { depth: state.depth + 1, nodes: state.nodes };
      output[key] = schema[key].map((child, index) => normalizeSchema(child, pathJoin(path, `${key}.${index}`), childState));
      state.nodes = childState.nodes;
    }
  }

  return output;
};

const typeMatches = (value, type) => {
  switch (type) {
    case 'object': return isPlainObject(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return true;
  }
};

const validateValue = (value, schema, path = 'input') => {
  if (hasOwn(schema, 'type')) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(value, type))) return `${path} must be ${types.join(' or ')}`;
  }
  if (hasOwn(schema, 'const') && !jsonEqual(value, schema.const)) return `${path} must equal const`; 
  if (hasOwn(schema, 'enum') && !schema.enum.some((item) => jsonEqual(value, item))) return `${path} is not an allowed value`;

  if (typeof value === 'string') {
    if (hasOwn(schema, 'minLength') && value.length < schema.minLength) return `${path} is shorter than ${schema.minLength}`;
    if (hasOwn(schema, 'maxLength') && value.length > schema.maxLength) return `${path} is longer than ${schema.maxLength}`;
    if (hasOwn(schema, 'pattern') && !new RegExp(schema.pattern).test(value)) return `${path} does not match pattern`;
  }
  if (typeof value === 'number') {
    if (hasOwn(schema, 'minimum') && value < schema.minimum) return `${path} is below minimum`;
    if (hasOwn(schema, 'maximum') && value > schema.maximum) return `${path} is above maximum`;
    if (hasOwn(schema, 'exclusiveMinimum') && value <= schema.exclusiveMinimum) return `${path} is not above exclusiveMinimum`;
    if (hasOwn(schema, 'exclusiveMaximum') && value >= schema.exclusiveMaximum) return `${path} is not below exclusiveMaximum`;
    if (hasOwn(schema, 'multipleOf') && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > Number.EPSILON * 10) return `${path} is not a multipleOf value`;
  }
  if (Array.isArray(value)) {
    if (hasOwn(schema, 'minItems') && value.length < schema.minItems) return `${path} has too few items`;
    if (hasOwn(schema, 'maxItems') && value.length > schema.maxItems) return `${path} has too many items`;
    if (schema.uniqueItems) {
      for (let index = 0; index < value.length; index += 1) {
        if (value.slice(index + 1).some((item) => jsonEqual(item, value[index]))) return `${path} must contain unique items`;
      }
    }
    if (schema.items) {
      for (let index = 0; index < value.length; index += 1) {
        const error = validateValue(value[index], schema.items, `${path}[${index}]`);
        if (error) return error;
      }
    }
  }
  if (isPlainObject(value)) {
    const keys = ownKeys(value);
    if (hasOwn(schema, 'minProperties') && keys.length < schema.minProperties) return `${path} has too few properties`;
    if (hasOwn(schema, 'maxProperties') && keys.length > schema.maxProperties) return `${path} has too many properties`;
    for (const key of schema.required ?? []) {
      if (!hasOwn(value, key)) return `${path}.${key} is required`;
    }
    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      const unknown = keys.find((key) => !hasOwn(properties, key));
      if (unknown !== undefined) return `${path}.${unknown} is not allowed`;
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (hasOwn(value, key)) {
        const error = validateValue(value[key], childSchema, `${path}.${key}`);
        if (error) return error;
      }
    }
  }

  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    if (!schema[key]) continue;
    const matches = schema[key].map((child) => validateValue(value, child, path)).filter((error) => !error).length;
    if (key === 'allOf' && matches !== schema[key].length) return `${path} does not satisfy allOf`;
    if (key === 'anyOf' && matches === 0) return `${path} does not satisfy anyOf`;
    if (key === 'oneOf' && matches !== 1) return `${path} does not satisfy oneOf`;
  }
  return null;
};

export class ToolRegistryError extends Error {
  constructor(code, message = '', details = undefined) {
    super(message ? `${code}:${message}` : code);
    this.name = 'ToolRegistryError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const fail = (code, message, details) => { throw new ToolRegistryError(code, message, details); };

const normalizeDefinition = (definition) => {
  if (!isPlainObject(definition)) fail(TOOL_ERROR_CODES.INVALID_DEFINITION, 'definition must be an object');
  for (const key of ownKeys(definition)) {
    if (!DEFINITION_KEYS.has(key)) fail(TOOL_ERROR_CODES.INVALID_DEFINITION, `unknown field ${key}`, { field: key });
  }
  const name = definition.name ?? definition.id;
  if (typeof name !== 'string' || name.length < 1 || name.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(name)) {
    fail(TOOL_ERROR_CODES.INVALID_NAME, 'name must be 1-128 non-whitespace characters', { name });
  }
  if (hasOwn(definition, 'name') && hasOwn(definition, 'id') && definition.name !== definition.id) {
    fail(TOOL_ERROR_CODES.INVALID_DEFINITION, 'name and id must match');
  }
  if (hasOwn(definition, 'description') && (typeof definition.description !== 'string' || definition.description.length > 4096)) {
    fail(TOOL_ERROR_CODES.INVALID_DEFINITION, 'description must be at most 4096 characters');
  }
  if (hasOwn(definition, 'readOnly') && typeof definition.readOnly !== 'boolean') {
    fail(TOOL_ERROR_CODES.INVALID_DEFINITION, 'readOnly must be boolean');
  }
  const handlers = ['handler', 'invoke', 'execute'].filter((key) => typeof definition[key] === 'function');
  if (handlers.length !== 1) fail(TOOL_ERROR_CODES.INVALID_DEFINITION, 'exactly one handler/invoke/execute function is required');
  for (const key of ['handler', 'invoke', 'execute']) {
    if (hasOwn(definition, key) && typeof definition[key] !== 'function') fail(TOOL_ERROR_CODES.INVALID_DEFINITION, `${key} must be a function`);
  }
  const inputSchema = normalizeSchema(definition.inputSchema ?? {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false
  }, 'inputSchema');
  if (!inputSchema.type || (Array.isArray(inputSchema.type) ? !inputSchema.type.includes('object') : inputSchema.type !== 'object')) {
    fail(TOOL_ERROR_CODES.INVALID_SCHEMA, 'inputSchema root must include object type');
  }
  const outputSchema = definition.outputSchema === undefined ? undefined : normalizeSchema(definition.outputSchema, 'outputSchema');
  if (hasOwn(definition, 'metadata') && (!isPlainObject(definition.metadata) || !isJsonValue(definition.metadata))) {
    fail(TOOL_ERROR_CODES.INVALID_DEFINITION, 'metadata must be a JSON object');
  }
  return {
    name,
    description: definition.description ?? '',
    inputSchema,
    ...(outputSchema === undefined ? {} : { outputSchema }),
    readOnly: definition.readOnly !== false,
    ...(definition.metadata === undefined ? {} : { metadata: clone(definition.metadata, TOOL_ERROR_CODES.INVALID_DEFINITION, 'metadata cannot be cloned') }),
    handler: definition[handlers[0]]
  };
};

const publicDefinition = (definition) => {
  const result = {
    name: definition.name,
    description: definition.description,
    inputSchema: clone(definition.inputSchema, TOOL_ERROR_CODES.INVALID_DEFINITION, 'schema cannot be cloned'),
    ...(definition.outputSchema === undefined ? {} : { outputSchema: clone(definition.outputSchema, TOOL_ERROR_CODES.INVALID_DEFINITION, 'schema cannot be cloned') }),
    readOnly: definition.readOnly,
    ...(definition.metadata === undefined ? {} : { metadata: clone(definition.metadata, TOOL_ERROR_CODES.INVALID_DEFINITION, 'metadata cannot be cloned') })
  };
  return freeze(result);
};

export class ToolRegistry {
  #tools = new Map();
  #maxOutputBytes;
  #maxOutputChars;
  #onInvocation;
  #allowSideEffects;
  #strictInvocationPersistence;

  constructor(options = {}) {
    if (!isPlainObject(options)) fail(TOOL_ERROR_CODES.INVALID_DEFINITION, 'options must be an object');
    const maxSize = options.maxOutputSize ?? options.maxOutputBytes;
    this.#maxOutputBytes = maxSize === undefined ? DEFAULT_MAX_OUTPUT_BYTES : maxSize;
    this.#maxOutputChars = options.maxOutputChars === undefined ? DEFAULT_MAX_OUTPUT_CHARS : options.maxOutputChars;
    this.#allowSideEffects = options.allowSideEffects === true;
    this.#strictInvocationPersistence = options.strictInvocationPersistence === true;
    if (!Number.isInteger(this.#maxOutputBytes) || this.#maxOutputBytes < 1) fail(TOOL_ERROR_CODES.INVALID_DEFINITION, 'maxOutputBytes must be a positive integer');
    if (!Number.isInteger(this.#maxOutputChars) || this.#maxOutputChars < 1) fail(TOOL_ERROR_CODES.INVALID_DEFINITION, 'maxOutputChars must be a positive integer');
    this.#onInvocation = options.onInvocation;
    if (this.#onInvocation !== undefined && typeof this.#onInvocation !== 'function') fail(TOOL_ERROR_CODES.INVALID_DEFINITION, 'onInvocation must be a function');
    const unknown = ownKeys(options).find((key) => !['maxOutputSize', 'maxOutputBytes', 'maxOutputChars', 'onInvocation', 'allowSideEffects', 'strictInvocationPersistence'].includes(key));
    if (unknown) fail(TOOL_ERROR_CODES.INVALID_DEFINITION, `unknown option ${unknown}`, { field: unknown });
  }

  register(definition) {
    const normalized = normalizeDefinition(definition);
    if (!normalized.readOnly && !this.#allowSideEffects) {
      fail(TOOL_ERROR_CODES.INVALID_DEFINITION, 'side-effect tools require allowSideEffects');
    }
    if (this.#tools.has(normalized.name)) fail(TOOL_ERROR_CODES.DUPLICATE, normalized.name, { name: normalized.name });
    this.#tools.set(normalized.name, normalized);
    return publicDefinition(normalized);
  }

  list() {
    return [...this.#tools.values()].map(publicDefinition);
  }

  async invoke(name, input = {}) {
    const startedAt = Date.now();
    let inputDigest;
    let invocationCallbackFailed = false;
    try {
      if (typeof name !== 'string' || !this.#tools.has(name)) fail(TOOL_ERROR_CODES.NOT_FOUND, String(name), { name });
      const tool = this.#tools.get(name);
      const safeInput = clone(input, TOOL_ERROR_CODES.INVALID_INPUT, 'input must be cloneable');
      if (!isJsonValue(safeInput)) fail(TOOL_ERROR_CODES.INVALID_INPUT, 'input must be JSON data');
      inputDigest = digest(safeInput);
      const inputError = validateValue(safeInput, tool.inputSchema, 'input');
      if (inputError) fail(TOOL_ERROR_CODES.INVALID_INPUT, inputError, { name, path: inputError.split(' ')[0] });

      let value;
      try {
        value = await tool.handler(safeInput);
      } catch (error) {
        if (error instanceof ToolRegistryError) throw error;
        const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,96}$/.test(error.code)
          ? error.code
          : typeof error?.message === 'string' && /^(?:WORKSPACE|SAFETY|EXECUTOR)_[A-Z0-9_]+(?::.*)?$/.test(error.message)
            ? error.message.split(':', 1)[0]
            : undefined;
        if (code) throw new ToolRegistryError(code, error.message.includes(':') ? error.message.slice(code.length + 1) : '');
        throw new ToolRegistryError(TOOL_ERROR_CODES.HANDLER_FAILED, 'handler failed', { name });
      }
      if (!isJsonValue(value)) fail(TOOL_ERROR_CODES.INVALID_OUTPUT, 'output must be JSON data', { name });
      let serialized;
      try {
        serialized = JSON.stringify(value);
      } catch {
        fail(TOOL_ERROR_CODES.INVALID_OUTPUT, 'output is not serializable', { name });
      }
      const bytes = Buffer.byteLength(serialized, 'utf8');
      if (bytes > this.#maxOutputBytes || serialized.length > this.#maxOutputChars) {
        fail(TOOL_ERROR_CODES.OUTPUT_TOO_LARGE, 'output exceeds configured limit', {
          name,
          bytes,
          chars: serialized.length,
          maxBytes: this.#maxOutputBytes,
          maxChars: this.#maxOutputChars
        });
      }
      if (tool.outputSchema) {
        const outputError = validateValue(value, tool.outputSchema, 'output');
        if (outputError) fail(TOOL_ERROR_CODES.INVALID_OUTPUT, outputError, { name, path: outputError.split(' ')[0] });
      }
      const result = clone(value, TOOL_ERROR_CODES.INVALID_OUTPUT, 'output cannot be cloned');
      if (this.#onInvocation) {
        const summary = Object.freeze({
          name,
          ok: true,
          inputDigest,
          outputDigest: digest(value),
          outputBytes: bytes,
          outputChars: serialized.length,
          durationMs: Math.max(0, Date.now() - startedAt)
        });
        try { await this.#onInvocation(summary); } catch (error) {
          invocationCallbackFailed = true;
          if (this.#strictInvocationPersistence) throw new ToolRegistryError('TOOL_INVOCATION_PERSIST_FAILED', 'invocation persistence failed', { name });
        }
      }
      return result;
    } catch (error) {
      if (this.#onInvocation && !invocationCallbackFailed) {
        const summary = Object.freeze({
          name: typeof name === 'string' ? name : String(name),
          ok: false,
          ...(inputDigest ? { inputDigest } : {}),
          errorCode: error?.code ?? 'TOOL_ERROR',
          ...(safeInvocationErrorMessage(error) ? { message: safeInvocationErrorMessage(error) } : {}),
          ...(typeof error?.details?.path === 'string' ? { path: error.details.path.slice(0, 512) } : {}),
          durationMs: Math.max(0, Date.now() - startedAt)
        });
        try { await this.#onInvocation(summary); } catch (callbackError) {
          if (this.#strictInvocationPersistence) throw new ToolRegistryError('TOOL_INVOCATION_PERSIST_FAILED', 'invocation persistence failed', { name: summary.name });
        }
      }
      throw error;
    }
  }

  call(name, input = {}) {
    return this.invoke(name, input);
  }

  has(name) {
    return typeof name === 'string' && this.#tools.has(name);
  }
}

export const createToolRegistry = (options) => new ToolRegistry(options);

export const registerReadonlyWorkspaceTools = (registry, workspace) => {
  if (!(registry instanceof ToolRegistry)) fail(TOOL_ERROR_CODES.INVALID_DEFINITION, 'registry must be a ToolRegistry');
  if (!workspace || typeof workspace.list !== 'function' || typeof workspace.read !== 'function') {
    fail(TOOL_ERROR_CODES.INVALID_DEFINITION, 'workspace must expose list() and read()');
  }
  registry.register({
    name: 'workspace.list',
    description: "List visible entries in the authorized workspace or a child directory. path MUST be relative, such as empty string or src; never pass a drive-letter or UNC absolute path.",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', maxLength: 512 }
      },
      required: [],
      additionalProperties: false
    },
    handler: ({ path = '' }) => workspace.list(path)
  });
  registry.register({
    name: 'workspace.read',
    description: "Read a bounded UTF-8 text file from the authorized workspace. path MUST be relative, such as README.md or src/main.ts; never pass a drive-letter or UNC absolute path. For files larger than 32KB, use offsetChars to read the next window."
      + (typeof workspace.readMatching === 'function' ? ' To locate a named function or known text, pass findText (literal, not regex) and a small maxChars instead of scanning every page. Returns found and the actual offsetChars of the first match at or after the requested offset. Continue from returned offsetChars + content.length; a missing match returns found:false and empty content.' : ''),
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, maxLength: 512 },
        maxChars: { type: 'integer', minimum: 1, maximum: 32768 },
        offsetChars: { type: 'integer', minimum: 0 },
        ...(typeof workspace.readMatching === 'function' ? { findText: { type: 'string', minLength: 1, maxLength: 512 } } : {})
      },
      required: ['path'],
      additionalProperties: false
    },
    handler: ({ path, maxChars = 32768, offsetChars = 0, findText }) => findText === undefined
      ? workspace.read(path, maxChars, offsetChars)
      : workspace.readMatching(path, findText, maxChars, offsetChars)
  });
  if (typeof workspace.readMatching === 'function') registry.register({
    name: 'workspace.focus',
    description: 'Extract current source data around one unique literal locator in a known relative file. Prefer this for a remaining defect or named function instead of rescanning the repository. Returns the full-file SHA-256 digest, actual offset and at most 6000 characters of untrusted source data. Missing or ambiguous locators fail; narrow the locator before retrying. The digest can be used as expectedDigest for a subsequent file patch/write.',
    inputSchema: {
      type: 'object', properties: {
        path: { type: 'string', minLength: 1, maxLength: 512 },
        findText: { type: 'string', minLength: 1, maxLength: 512 },
        maxChars: { type: 'integer', minimum: 1, maximum: 6000 }
      }, required: ['path', 'findText'], additionalProperties: false
    },
    handler: ({ path, findText, maxChars = 2000 }) => workspace.readMatching(path, findText, maxChars, 0, true)
  });
  return registry;
};

export const createReadonlyToolRegistry = (workspace, options = {}) => {
  if (workspace === undefined) return new ToolRegistry(options);
  const { registry: providedRegistry, ...registryOptions } = options;
  const registry = providedRegistry ?? new ToolRegistry({
    maxOutputBytes: 256 * 1024,
    maxOutputChars: 128 * 1024,
    ...registryOptions
  });
  return registerReadonlyWorkspaceTools(registry, workspace);
};

/** Expose a registry through Cordis without coupling tools to a provider. */
export const toolRegistryPlugin = (registry = new ToolRegistry()) => {
  if (!(registry instanceof ToolRegistry)) fail(TOOL_ERROR_CODES.INVALID_DEFINITION, 'registry must be a ToolRegistry');
  return cordisPlugin((ctx) => {
    ctx.provide('toolRegistry', registry);
  }, 'tool-registry');
};

export const validateToolInput = (input, schema) => {
  const normalized = normalizeSchema(schema, 'schema');
  const safeInput = clone(input, TOOL_ERROR_CODES.INVALID_INPUT, 'input must be cloneable');
  if (!isJsonValue(safeInput)) return { valid: false, error: 'input must be JSON data' };
  const error = validateValue(safeInput, normalized, 'input');
  return error ? { valid: false, error } : { valid: true };
};
