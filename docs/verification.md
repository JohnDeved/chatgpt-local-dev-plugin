# Verification record

This file separates automated coverage, real-environment evidence, and evidence that is still outstanding. An unchecked item is not a claimed pass.

## Automated gate

- [x] `npm run check` passes formatting, policy lint, strict TypeScript checking, build, and 17 credential-free tests on Node 22.16.0.
- [x] Temporary-home tests cover Codex/Local Dev parsing, redacted errors, strict selections, nested project hooks, core argument rejection, foreground/background execution, output bounds, stdio and Streamable HTTP proxying, pagination, filters, metadata preservation, required/optional server behavior, setup resume, rollback, service lifecycle, safe status, and uninstall preservation.
- [x] The packed `local-dev` bin has executable mode and `npm link` produces a working command.

## Real macOS environment — 2026-07-13

- [x] `local-dev setup` reused the existing native tunnel runtime and stored runtime-key reference without reading or copying a literal key.
- [x] Native tunnel status reported `process_running`, `healthy`, and `ready`; `/healthz` was live and `/readyz` was ready. Control-plane polling remained separately reported as `unknown` because the native status had no live admin UI snapshot.
- [x] The macOS LaunchAgent was loaded, had one successful run, and invokes native `tunnel-client runtimes connect` rather than supervising the daemon itself.
- [x] `local-dev status` passed its direct MCP discovery/call smoke test and reported ready.
- [x] The shared registry selected pinned Serena 1.5.3 and Chrome DevTools MCP 1.5.0 entries with explicit allowlists. The production Local Dev registry exposed five native tools, 20 namespaced Serena tools with shell execution absent, and three namespaced Chrome slim tools.
- [x] Through the combined registry, `project.open` activated the repository, Serena edited `README.md`, and `dev.run` ran the complete 17-test repository gate successfully.
- [x] Through the namespaced Chrome DevTools tools, an isolated headless Chrome opened the live tunnel admin UI, evaluated its title/heading/health text, and produced a screenshot artifact.
- [x] The resulting repository diff passed formatting, tests, `git diff --check`, and a credential-pattern scan; the only bearer-like match was an intentional fake value in an HTTP fixture.

## Required final evidence

- [ ] Refresh the signed-in ChatGPT private connector and call the production namespaced registry through the Secure MCP Tunnel. Chrome, the ChatGPT Chrome Extension, and its native host all passed diagnostics, but the extension control connection was unavailable; opening a fresh Chrome window requires user permission.
- [ ] Reboot macOS, then repeat `local-dev status`, native tunnel readiness, direct MCP smoke, and one private-connector call. A reboot is intentionally never initiated without explicit user permission.
