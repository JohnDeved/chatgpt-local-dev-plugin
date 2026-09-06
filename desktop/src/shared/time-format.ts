export type TimeFormat = "system" | "12h" | "24h";
export interface ClockPreference {
  hour12: boolean;
  locale: string;
  source: "macos" | "locale";
}
export interface TimePresentation {
  mode: TimeFormat;
  system?: ClockPreference;
}
export function validTimeFormat(value: string): TimeFormat {
  return value === "12h" || value === "24h" ? value : "system";
}

/** One policy for headers, history, action rows and full timestamp tooltips. */
export function timestamp(
  value: string,
  preference: TimePresentation,
  style: "clock" | "history" | "full",
  now = new Date(),
): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const hour12 =
    preference.mode === "12h"
      ? true
      : preference.mode === "24h"
        ? false
        : preference.system?.hour12;
  const cycle: Intl.DateTimeFormatOptions =
    hour12 === undefined ? {} : { hourCycle: hour12 ? "h12" : "h23" };
  const dated =
    style === "full" || (style === "history" && date.toDateString() !== now.toDateString());
  const options: Intl.DateTimeFormatOptions = {
    ...cycle,
    ...(dated ? { month: "short", day: "numeric" } : {}),
    ...(style === "full" ? { year: "numeric", second: "2-digit", timeZoneName: "short" } : {}),
    hour: "2-digit",
    minute: "2-digit",
  };
  try {
    return new Intl.DateTimeFormat(preference.system?.locale || undefined, options).format(date);
  } catch {
    return new Intl.DateTimeFormat(undefined, options).format(date);
  }
}
