import type { ProgressNotification, ProgressToken } from "@modelcontextprotocol/sdk/types.js";

const MAX_MESSAGE_LENGTH = 200;

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

function message(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= MAX_MESSAGE_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_MESSAGE_LENGTH - 1)}…`;
}

export function createToolProgress(
  meta: Record<string, unknown> | undefined,
  sendNotification: NotificationSender,
): ToolProgress | undefined {
  const token = progressToken(meta);
  if (token === undefined) return undefined;

  let last = -1;
  return {
    async report(value, fraction) {
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
          message: message(value),
        },
      }).catch(() => undefined);
    },
  };
}
