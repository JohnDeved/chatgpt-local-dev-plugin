import type { ProgressNotification, ProgressToken } from "@modelcontextprotocol/sdk/types.js";

export interface ToolProgress {
  report(message: string, fraction?: number): Promise<void>;
}

export interface ToolCallContext {
  meta?: Record<string, unknown>;
  runOwner?: string;
  signal?: AbortSignal;
  progress?: ToolProgress;
}

type NotificationSender = (notification: ProgressNotification) => Promise<void>;

function progressToken(meta: Record<string, unknown> | undefined): ProgressToken | undefined {
  const token = meta?.progressToken;
  return typeof token === "string" || typeof token === "number" ? token : undefined;
}

export function createToolProgress(
  meta: Record<string, unknown> | undefined,
  sendNotification: NotificationSender,
): ToolProgress | undefined {
  const token = progressToken(meta);
  if (token === undefined) return undefined;
  let sequence = -1;
  return {
    async report(message) {
      // Heartbeats are activity, not measurable work. No invented percentages or total.
      await sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress: ++sequence, message },
      }).catch(() => undefined);
    },
  };
}
