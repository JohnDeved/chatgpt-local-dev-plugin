# ChatGPT UI

Local Dev uses the MCP Apps UI protocol to render focused interfaces inside ChatGPT. Each widget is a self-contained HTML resource served as `text/html;profile=mcp-app`. Tool descriptors link to resources with `_meta.ui.resourceUri`; the OpenAI compatibility alias `_meta["openai/outputTemplate"]` is also emitted.

The widgets receive tool results over `ui/notifications/tool-result`. Interactive controls call MCP tools through `tools/call` (or `window.openai.callTool` in ChatGPT). The question form sends the completed answers back into the conversation with `ui/message` (or `window.openai.sendFollowUpMessage`).

## Implemented widgets

### Command and process viewer

Resource: `ui://widget/local-dev-command-v1.html`

Attached to:

- `dev.run`
- `dev.poll`
- `dev.stop`

The widget shows the original argv, working directory, foreground/background mode, PID, state, start time, exit status, bounded output, truncation state, and detected loopback URLs. A tracked background process can be refreshed or stopped from the widget. Output can be expanded to fullscreen, and detected preview URLs can be opened through the ChatGPT host API.

### Project picker

Resource: `ui://widget/local-dev-projects-v1.html`

Attached to `project.list`. The tool performs bounded project discovery under configured roots. The widget supports text filtering and calls `project.open` when the user chooses a project. Project discovery includes configured roots and directories with common project markers such as `.git`, `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, and common Java build files.

### Recent-call inspector

Resource: `ui://widget/local-dev-calls-v1.html`

Attached to `observability.recent_calls`. It displays recent entries from the existing 200-entry in-memory call journal. Arguments and results use the same bounding and credential redaction rules as the loopback dashboard. The current inspector call is excluded from its own result.

### Structured question form

Resource: `ui://widget/local-dev-question-v1.html`

Attached to `question.ask`. The design follows the useful parts of coding-agent question tools:

- Ask one to four related questions together.
- Give every question a short header and a clear prompt.
- Offer two to six concrete options with optional descriptions.
- Support either single-select or multi-select behavior.
- Allow a custom answer by default.
- Validate required questions before submission.
- Submit all answers once, then post a concise human-readable summary plus structured JSON into the conversation.

The question call is not held open while the user decides. The render tool returns immediately, the component owns temporary form state, and submission creates a user-authored follow-up message. This keeps the MCP interaction retry-safe and avoids long-running tool calls.

Example tool input:

```json
{
  "title": "Choose implementation details",
  "intro": "These choices affect the initial scaffold.",
  "questions": [
    {
      "id": "ui_stack",
      "header": "UI stack",
      "question": "Which widget implementation should be used?",
      "options": [
        {
          "id": "vanilla",
          "label": "Vanilla TypeScript",
          "description": "Small dependency surface and simple bundling."
        },
        {
          "id": "react",
          "label": "React",
          "description": "Better fit for larger stateful interfaces."
        }
      ],
      "multiSelect": false,
      "allowCustom": true,
      "required": true
    }
  ]
}
```

### Media viewer

Resource: `ui://widget/local-dev-media-v1.html`

This existing widget renders native or allowlisted inlined image/audio content returned by selected downstream tools.

## Downstream MCP Apps resources

When a selected downstream tool advertises `_meta.ui.resourceUri` or `_meta["openai/outputTemplate"]`, Local Dev:

1. Creates a stable namespaced URI under `ui://local-dev/<alias>/...`.
2. Rewrites both metadata fields on the exposed tool descriptor.
3. Lists only resources referenced by exposed tools.
4. Reads the original resource from the matching downstream MCP client on demand.
5. Rewrites the primary returned content URI to the namespaced URI.

This prevents URI collisions between downstream servers. Local Dev preserves the downstream resource contents and metadata; it does not broaden CSP permissions. Self-contained HTML bundles work best. Relative auxiliary assets or resource-template-driven bundles may require additional proxy support in a future revision.

## Security and data boundaries

- Widget HTML is local and contains no remote scripts, fonts, or styles.
- Local widget CSP allowlists are empty.
- Widgets treat tool results as untrusted data and render values with DOM `textContent`.
- The command widget can only call the existing bounded native process tools.
- The call inspector receives already-redacted journal records.
- Question answers are deliberately sent into the conversation because the agent must read them to continue.
- Downstream UI is exposed only when referenced by an enabled downstream tool.

## Versioning

Widget URIs include a version suffix. Change the URI whenever markup or behavior changes incompatibly so ChatGPT does not reuse a stale cached resource.

## Current exclusions

A tunnel health/status card is intentionally not included. Setup and repair remain CLI workflows because they can affect local services, credentials, tunnel configuration, and persisted state.

## References

- OpenAI Apps SDK: Build your ChatGPT UI
- OpenAI Apps SDK: Build your MCP server
- OpenAI Apps SDK reference
- MCP Apps bridge (`ui/*` notifications and requests)
