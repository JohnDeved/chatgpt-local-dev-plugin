function display(argument: string): string {
  return JSON.stringify(argument);
}

export function commandLabel(argv: string[]): string {
  return argv.map(display).join(" ");
}
