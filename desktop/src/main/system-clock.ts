import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
export interface SystemClock {
  hour12: boolean;
  locale: string;
  source: "macos" | "locale";
}
export interface MacLocalePreference {
  locale: string;
  hour12?: boolean;
}

export function localeClock(locale?: string): SystemClock {
  try {
    const options = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions();
    const hour12 = options.hour12 ?? (options.hourCycle === "h11" || options.hourCycle === "h12");
    return { hour12, locale: options.locale, source: "locale" };
  } catch {
    const options = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions();
    const hour12 = options.hour12 ?? (options.hourCycle === "h11" || options.hourCycle === "h12");
    return { hour12, locale: options.locale, source: "locale" };
  }
}

/** Translate Apple's ICU locale keywords into a locale/hour cycle Intl can actually honor. */
export function parseAppleLocale(value: string): MacLocalePreference | undefined {
  const raw = value.trim().replace(/^"|"$/g, "");
  if (!raw) return;
  const [base, keywordText = ""] = raw.split("@", 2);
  const keywords = new Map(
    keywordText
      .split(";")
      .map((entry) => entry.split("=", 2) as [string, string])
      .filter(([key, entryValue]) => !!key && entryValue !== undefined),
  );
  let locale: Intl.Locale;
  try {
    locale = new Intl.Locale(base.replaceAll("_", "-"));
  } catch {
    return;
  }
  const regionKeyword = keywords.get("rg")?.toLowerCase();
  const match = regionKeyword?.match(/^([a-z]{2}|[0-9]{3})zzzz$/u);
  if (match) {
    const language = locale.language;
    const script = locale.script ? `-${locale.script}` : "";
    try {
      locale = new Intl.Locale(`${language}${script}-${match[1].toUpperCase()}`);
    } catch {
      /* Keep the base locale. */
    }
  }
  const hours = (keywords.get("hours") ?? keywords.get("hc"))?.toLowerCase();
  const hour12 =
    hours === "h11" || hours === "h12"
      ? true
      : hours === "h23" || hours === "h24"
        ? false
        : undefined;
  return { locale: locale.toString(), ...(hour12 === undefined ? {} : { hour12 }) };
}

/** Read-only macOS preference lookup. No renderer-controlled command, key, path, or environment. */
export async function readSystemClock(
  platform = process.platform,
  read: (key: string) => Promise<string> = async (key) => {
    const result = await execute("/usr/bin/defaults", ["read", "-g", key], {
      timeout: 2000,
      maxBuffer: 4096,
    });
    return result.stdout.trim();
  },
): Promise<SystemClock> {
  const fallback = localeClock();
  if (platform !== "darwin") return fallback;
  const safeRead = async (key: string) => {
    try {
      return (await read(key)).trim();
    } catch {
      return "";
    }
  };
  const [force24, force12, appleLocale] = await Promise.all([
    safeRead("AppleICUForce24HourTime"),
    safeRead("AppleICUForce12HourTime"),
    safeRead("AppleLocale"),
  ]);
  const macLocale = parseAppleLocale(appleLocale);
  const regional = macLocale ? localeClock(macLocale.locale) : fallback;
  const effective: SystemClock = {
    ...regional,
    hour12: macLocale?.hour12 ?? regional.hour12,
    source: macLocale ? "macos" : "locale",
  };
  const yes = (value: string) => /^(1|true|yes)$/i.test(value);
  const no = (value: string) => /^(0|false|no)$/i.test(value);
  if (yes(force24) || no(force12)) return { ...effective, hour12: false, source: "macos" };
  if (yes(force12) || no(force24)) return { ...effective, hour12: true, source: "macos" };
  return effective;
}
