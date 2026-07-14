import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

export interface RegistryEntry {
  tool: Tool;
  call: (arguments_: Record<string, unknown>) => Promise<CallToolResult> | CallToolResult;
}

export class ToolRegistry {
  private readonly entries = new Map<string, RegistryEntry>();

  add(entry: RegistryEntry): void {
    if (this.entries.has(entry.tool.name)) throw new Error("DUPLICATE_TOOL");
    this.entries.set(entry.tool.name, entry);
  }

  addAll(entries: RegistryEntry[]): void {
    for (const entry of entries) this.add(entry);
  }

  list(): Tool[] {
    return [...this.entries.values()].map(({ tool }) => tool);
  }

  get(name: string): RegistryEntry | undefined {
    return this.entries.get(name);
  }
}
