# Local MCP call dashboard

Run `local-dev dashboard` while the Local Dev tunnel runtime is active. Use `local-dev dashboard --json` when another local tool needs the current URL without opening a browser.

The live dashboard records every `tools/call` request handled by Local Dev, including:

- the exact exposed tool name and owning server alias;
- bounded, JSON-formatted arguments;
- running, successful, or failed status;
- start time and elapsed milliseconds;
- bounded MCP result content and structured content; and
- image/audio type, MIME type, and decoded byte size.

The journal is process-local and retains the newest 200 calls. Restarting the tunnel runtime clears it. There is no database, analytics export, public ingress, or remote dashboard transport.

## Local security boundary

The HTTP server binds an operating-system-assigned port on `127.0.0.1` only. Each runtime generates a new 192-bit random path token, writes its complete URL to `~/.local-dev/dashboard.url` with mode `0600`, sends no CORS headers, and accepts read-only GET routes. The tunnel continues to transport MCP over stdio and does not expose the dashboard.

Keys matching authorization, cookie, password, secret, token, API-key, credential, and private-key patterns are replaced with `[redacted]`. Bearer, Basic, and OpenAI-style key values are also redacted. Long strings, arrays, and nesting are bounded. Base64 image and audio bodies are replaced by byte-count summaries so a screenshot does not fill the journal or browser memory.

The dashboard is intended for development observability, not as an audit log. If the runtime is unavailable or the URL file is stale, `local-dev dashboard` exits with a concise repair message rather than opening the stale address.
