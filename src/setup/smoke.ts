import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CORE_TOOLS = ["project.open", "project.current", "dev.run", "dev.poll", "dev.stop"];

export async function smokeServer(home: string, nodePath: string, cliPath: string): Promise<void> {
  const transport = new StdioClientTransport({
    command: nodePath,
    args: [cliPath],
    env: { ...getDefaultEnvironment(), HOME: home },
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => undefined);
  const client = new Client({ name: "local-dev-setup-smoke", version: "1.0.0" });
  try {
    await client.connect(transport, { timeout: 15_000 });
    const tools = await client.listTools(undefined, { timeout: 15_000 });
    const names = new Set(tools.tools.map(({ name }) => name));
    if (CORE_TOOLS.some((name) => !names.has(name))) throw new Error("SMOKE_TOOLS_MISSING");
    const result = await client.callTool({ name: "project.current", arguments: {} }, undefined, { timeout: 5_000 });
    if (!("content" in result) || result.isError === true) throw new Error("SMOKE_CALL_FAILED");
  } finally {
    await client.close().catch(() => undefined);
  }
}
