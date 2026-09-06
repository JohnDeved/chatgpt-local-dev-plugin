import { Electroview } from "electrobun/view";
import type { ActionResult, DesktopBridge, DesktopRpc, UiSnapshot } from "../shared/contracts.ts";

declare const __LD_TEST__: boolean;
declare global {
  interface Window {
    __localDevTestBridge?: DesktopBridge;
  }
}
export function connectDesktop(): DesktopBridge {
  // This branch is compiled out of production. Fixtures never enter a packaged app.
  if (__LD_TEST__ && window.__localDevTestBridge) return window.__localDevTestBridge;
  const listeners = new Set<(value: UiSnapshot) => void>();
  const rpc = Electroview.defineRPC<DesktopRpc>({
    maxRequestTime: 120000,
    handlers: {
      requests: {},
      messages: {
        state: (value) => {
          for (const listener of listeners) listener(value);
        },
      },
    },
  });
  new Electroview({ rpc });
  const actionResult = (pending: Promise<ActionResult>): Promise<ActionResult> =>
    pending.catch((error: unknown) => ({ ok: false, message: String(error) }));
  return {
    ready: () => actionResult(rpc.request.ready({})),
    snapshot: (limit) => rpc.request.snapshot({ limit }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    act: (action) => actionResult(rpc.request.act(action)),
    details: (request) => rpc.request.details(request),
    copy: (text) => actionResult(rpc.request.copy({ text })),
    exportDetails: (request) => actionResult(rpc.request.exportDetails(request)),
  };
}
