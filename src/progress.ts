import type { ProgressNotification, ProgressToken } from "@modelcontextprotocol/sdk/types.js";

export interface ToolProgress {
  report(message: string, fraction?: number): Promise<void>;
}

export interface ToolCallContext {
  meta?: Record<string, unknown>;
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

  let last = -1;
  return {
    async report(message, fraction) {
      const requested = fraction === undefined
        ? last + 5
        : Math.round(Math.min(Math.max(fraction, 0), 1) * 100);
      const progress = Math.min(100, Math.max(last + 1, requested));
      last = progress;
      await sendNotification({
        method: "notifications/progress",
        params: {
          progressToken: token,
          progress,
          total: 100,
          message,
        },
      }).catch(() => undefined);
    },
  };
}
