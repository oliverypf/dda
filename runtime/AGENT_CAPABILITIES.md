# Agent capability switches

The runtime keeps external capabilities opt-in. The model cannot invent a
server command, URL, browser target, or patch target.

## Network requests

Run a controlled task with an explicit capability, target, and one-shot lease:

```powershell
npm run start -- task `
  --execution-mode CONTROLLED `
  --lease-capabilities network.request `
  --network-targets '[{"host":"docs.example.com","scheme":"https","methods":["GET"]}]' `
  --workspace C:\Users\User\hmCodex-local `
  --prompt "Read the approved documentation endpoint"
```

The adapter performs DNS/private-address checks before and after the request,
blocks redirects, bounds response size and timeout, and limits concurrency.

## MCP search/docs/Git tools

The runtime uses `@modelcontextprotocol/client` 2.x. Point `--mcp-config` (or
`HMCODEX_MCP_CONFIG`) at a static configuration file:

```json
{
  "servers": [
    {
      "id": "docs",
      "transport": "stdio",
      "command": "npx.cmd",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\Users\\User\\hmCodex-local\\docs"],
      "readOnlyTools": ["search"]
    },
    {
      "id": "git",
      "transport": "http",
      "url": "https://git.example.com/mcp",
      "readOnlyTools": ["search", "get_file"]
    }
  ]
}
```

Only tools marked `readOnlyHint` by the server or named in `readOnlyTools` are
registered as `mcp.<server>.<tool>`. HTTP redirects, credentials in URLs,
loopback/private literal addresses, secret-looking stdio environment keys, and
unbounded tool output are rejected.

## Browser worker

In `CONTROLLED` mode, the same explicit `--network-targets` list enables
`browser.open`. Playwright runs in a child Node process. Each task gets its own
browser context with no persisted cookies or storage. Navigation and every
subrequest must match an approved hostname; a redirected final URL is rejected.

The runtime dependency is `playwright@1.63.0`; install a browser binary on the
host with `npx playwright install chromium` when browser execution is needed.

## Patch and diff

`CONTROLLED` mode exposes `file.patch` and `file.diff`. A patch is a bounded
list of exact text replacements and may include `expectedDigest` to prevent a
stale agent from overwriting a newer edit. The write still uses the existing
atomic workspace writer and returns before/after digests plus a unified diff.
