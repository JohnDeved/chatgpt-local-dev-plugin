export type Dict = Record<string, unknown>;
export const object = (value: unknown): Dict =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Dict) : {};
export const string = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;
export type ActivityEvent = {
  version: number;
  runtimeId: string;
  sequence: number;
  timestamp: string;
  type: string;
  operationId?: string;
  parentId?: string;
  runId?: string;
  detail: unknown;
};
export type Channel = "all" | "stdout" | "stderr";
export interface AskOption {
  id: string;
  label: string;
  description?: string;
}
export interface AskItem {
  id: string;
  operationId?: string;
  runId?: string;
  question: string;
  header?: string;
  options: AskOption[];
  recommended: string;
  allowOther: boolean;
  createdAt: string;
  expiresAt?: string;
}
export interface CommandItem {
  id: string;
  argv: string[];
  cwd: string;
  state: string;
  pid?: number;
  startedAt?: string;
  endedAt?: string;
  exitCode?: number;
  signal?: string;
  output: Record<Channel, string>;
  bytes: Record<Channel, number>;
  previewLimited: boolean;
}
export interface CallItem {
  id: string;
  runtimeId: string;
  operationId: string;
  runId?: string;
  parentId?: string;
  tool: string;
  title: string;
  target: string;
  state: string;
  startedAt: string;
  endedAt?: string;
  approval?: string;
  summary: string;
  inputPreview: string;
  inputLimited: boolean;
  commands: CommandItem[];
  eventCount: number;
}
export type TaskStatus = "queued" | "in_progress" | "paused" | "completed" | "cancelled";
export interface RunTodo {
  id: string;
  title: string;
  status: TaskStatus;
  steeringId?: string;
  note?: string;
  createdAt?: string;
  updatedAt: string;
  activeElapsedMs?: number;
  activeStartedAt?: string;
  endedAt?: string;
}
export interface SteeringItem {
  id: string;
  text: string;
  state: "queued" | "returned" | "acknowledged";
  createdAt: string;
  response?: string;
  taskStatus?: TaskStatus;
  taskNote?: string;
  taskUpdatedAt?: string;
}
export interface RunItem {
  id: string;
  runtimeId: string;
  runId: string;
  title: string;
  goal: string | null;
  origin: string;
  state: string;
  startedAt: string;
  endedAt?: string;
  summary?: string;
  backgroundProcesses: number;
  backgroundProcessPolicy: "cleanup" | "keep";
  contextScope: string;
  notes: { id: string; kind: string; text: string; timestamp: string }[];
  steering: SteeringItem[];
  todos?: RunTodo[];
  connected: boolean;
}
export interface RuntimeItem {
  id: string;
  pid: number;
  connected: boolean;
  supportsRuns: boolean;
  workTracking?: boolean;
  supportsAsk?: boolean;
  askAutoTimeoutMs?: number;
  fault?: string;
  policy: { autoApprove: boolean; remember: boolean; paused: boolean };
  asks: AskItem[];
  operations: {
    id: string;
    runId?: string;
    tool: string;
    title: string;
    arguments: Dict;
    state: string;
    startedAt: string;
  }[];
  processes: {
    id: string;
    runId?: string;
    operationId: string;
    pid: number;
    argv: string[];
    cwd: string;
    startedAt: string;
  }[];
  runs: RunItem[];
}
export interface UiSnapshot {
  systemClock?: { hour12: boolean; locale: string; source: "macos" | "locale" };
  revision: number;
  runs: RunItem[];
  calls: CallItem[];
  runtimes: RuntimeItem[];
  archive: {
    directory: string;
    bytes: number;
    events: number;
    calls: number;
    runs: number;
    loading: boolean;
    shown: number;
  };
  errors: string[];
  preference: { autoApprove: boolean; remember: boolean; paused: boolean; pending: boolean };
  connection: {
    status: "connected" | "checking" | "offline" | "update" | "error" | "connecting";
    message: string;
    configured: boolean;
    diagnostics: string;
  };
  platform: string;
  version: string;
}
export type ControlAction =
  | { type: "approve" | "deny" | "stop"; runtimeId: string; operationId: string }
  | { type: "stopProcess"; runtimeId: string; processId: string }
  | { type: "steer"; runtimeId: string; runId: string; messageId: string; text: string }
  | { type: "answerAsk"; runtimeId: string; askId: string; optionId?: string; text?: string }
  | { type: "policy"; autoApprove: boolean; remember: boolean }
  | { type: "pause"; paused: boolean }
  | { type: "stopAll" }
  | { type: "reconnect" | "checkConnection" | "openArchive" | "openLoginSettings" | "quit" };
export interface DetailRequest {
  runtimeId: string;
  operationId: string;
  processId?: string;
  mode: "raw" | "input" | "result" | "output";
  channel?: Channel;
}
export interface DetailResponse {
  text: string;
  images: { mimeType: string; data: string }[];
}
export interface ActionResult {
  ok: boolean;
  message?: string;
  cancelled?: boolean;
}
export interface DesktopBridge {
  ready(): Promise<ActionResult>;
  snapshot(limit?: number): Promise<UiSnapshot>;
  subscribe(listener: (value: UiSnapshot) => void): () => void;
  act(action: ControlAction): Promise<ActionResult>;
  details(request: DetailRequest): Promise<DetailResponse>;
  copy(text: string): Promise<ActionResult>;
  exportDetails(request: DetailRequest): Promise<ActionResult>;
}
export interface DesktopRpc {
  bun: {
    requests: {
      ready: { params: {}; response: ActionResult };
      snapshot: { params: { limit?: number }; response: UiSnapshot };
      act: { params: ControlAction; response: ActionResult };
      details: { params: DetailRequest; response: DetailResponse };
      copy: { params: { text: string }; response: ActionResult };
      exportDetails: { params: DetailRequest; response: ActionResult };
    };
    messages: {};
  };
  webview: { requests: {}; messages: { state: UiSnapshot } };
}
export function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(value);
}
export function validateAction(input: unknown): ControlAction {
  const action = object(input);
  if (
    ["approve", "deny", "stop"].includes(string(action.type)) &&
    validIdentifier(action.runtimeId) &&
    validIdentifier(action.operationId)
  )
    return action as unknown as ControlAction;
  if (
    action.type === "stopProcess" &&
    validIdentifier(action.runtimeId) &&
    validIdentifier(action.processId)
  )
    return action as unknown as ControlAction;
  if (
    action.type === "answerAsk" &&
    validIdentifier(action.runtimeId) &&
    validIdentifier(action.askId) &&
    ((validIdentifier(action.optionId) && action.text === undefined) ||
      (action.optionId === undefined &&
        typeof action.text === "string" &&
        !!action.text.trim() &&
        action.text.length <= 2000))
  )
    return action as unknown as ControlAction;
  if (
    action.type === "steer" &&
    validIdentifier(action.runtimeId) &&
    validIdentifier(action.runId) &&
    validIdentifier(action.messageId) &&
    typeof action.text === "string" &&
    action.text.trim() &&
    action.text.length <= 4000
  )
    return action as unknown as ControlAction;
  if (
    action.type === "policy" &&
    typeof action.autoApprove === "boolean" &&
    typeof action.remember === "boolean"
  )
    return action as unknown as ControlAction;
  if (action.type === "pause" && typeof action.paused === "boolean")
    return action as unknown as ControlAction;
  if (
    [
      "stopAll",
      "reconnect",
      "checkConnection",
      "openArchive",
      "openLoginSettings",
      "quit",
    ].includes(string(action.type))
  )
    return action as unknown as ControlAction;
  throw new Error("Invalid desktop action. No command was sent.");
}
export function validateDetail(input: unknown): DetailRequest {
  const value = object(input);
  if (
    !validIdentifier(value.runtimeId) ||
    !validIdentifier(value.operationId) ||
    !["raw", "input", "result", "output"].includes(string(value.mode)) ||
    (value.processId !== undefined && !validIdentifier(value.processId)) ||
    (value.channel !== undefined && !["all", "stdout", "stderr"].includes(string(value.channel)))
  )
    throw new Error("Invalid detail selection.");
  return value as unknown as DetailRequest;
}
