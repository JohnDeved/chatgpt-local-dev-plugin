import { basename } from "node:path";

const MAX_LABEL_LENGTH = 120;
const MAX_VISIBLE_ARGUMENTS = 4;
const INLINE_CODE_FLAGS = new Set(["-e", "--eval", "--execute"]);
const SENSITIVE_FLAG = /(?:authorization|credential|password|passwd|secret|token|api[-_]?key)/iu;

interface LabelState {
  redactNext: boolean;
  summarizeInlineCode: boolean;
}

function display(argument: string): string {
  return /\s/u.test(argument) ? JSON.stringify(argument) : argument;
}

function inlineSensitiveArgument(argument: string): string | undefined {
  const equals = argument.indexOf("=");
  if (equals <= 0 || !SENSITIVE_FLAG.test(argument.slice(0, equals))) return undefined;
  return `${display(argument.slice(0, equals))}=••••`;
}

function visibleArgument(argument: string, index: number, state: LabelState): string {
  if (index === 0) return display(basename(argument));
  if (state.redactNext) {
    state.redactNext = false;
    return "••••";
  }
  if (state.summarizeInlineCode) {
    state.summarizeInlineCode = false;
    return "<inline code>";
  }
  const sensitive = inlineSensitiveArgument(argument);
  if (sensitive !== undefined) return sensitive;
  if (INLINE_CODE_FLAGS.has(argument)) state.summarizeInlineCode = true;
  else if (argument.startsWith("-") && SENSITIVE_FLAG.test(argument)) state.redactNext = true;
  return display(argument);
}

function visibleArguments(argv: string[]): string[] {
  const state: LabelState = { redactNext: false, summarizeInlineCode: false };
  const visible: string[] = [];
  for (const [index, argument] of argv.entries()) {
    if (visible.length >= MAX_VISIBLE_ARGUMENTS) return [...visible, "…"];
    visible.push(visibleArgument(argument, index, state));
  }
  return visible;
}

export function commandLabel(argv: string[]): string {
  const label = visibleArguments(argv).join(" ");
  return label.length <= MAX_LABEL_LENGTH
    ? label
    : `${label.slice(0, MAX_LABEL_LENGTH - 1)}…`;
}
