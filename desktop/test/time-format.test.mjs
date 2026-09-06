import assert from "node:assert/strict";
import test from "node:test";
import { readSystemClock, localeClock, parseAppleLocale } from "../src/main/system-clock.ts";
import { timestamp, validTimeFormat } from "../src/shared/time-format.ts";
const at = new Date(2026, 8, 5, 17, 8, 12).toISOString();
const preference = (mode, hour12, locale = "en-US") => ({
  mode,
  system: { hour12, locale, source: "macos" },
});

test("system clock mode follows the detected host cycle rather than assuming AM/PM", () => {
  assert.equal(timestamp(at, preference("system", false, "en-DE"), "clock"), "17:08");
  assert.match(timestamp(at, preference("system", true), "clock"), /^05:08.*pm$/i);
  assert.match(timestamp(at, preference("12h", false, "en-DE"), "clock"), /^05:08.*pm$/i);
  assert.equal(timestamp(at, preference("24h", true), "clock"), "17:08");
});

test("AppleLocale region overrides become an effective Intl locale", () => {
  assert.deepEqual(parseAppleLocale("en_US@rg=dezzzz"), { locale: "en-DE" });
  assert.deepEqual(parseAppleLocale("de_DE"), { locale: "de-DE" });
  assert.deepEqual(parseAppleLocale("en_US@hours=h23"), { locale: "en-US", hour12: false });
  assert.deepEqual(parseAppleLocale("en_US@hours=h12"), { locale: "en-US", hour12: true });
  assert.equal(parseAppleLocale("not a locale @@@"), undefined);
});

test("macOS regional override drives 24-hour System mode when force keys are absent", async () => {
  const requested = [];
  const values = { AppleLocale: "en_US@rg=dezzzz" };
  const clock = await readSystemClock("darwin", async (key) => {
    requested.push(key);
    if (!(key in values)) throw new Error("Not set");
    return values[key];
  });
  assert.equal(clock.hour12, false);
  assert.equal(clock.locale, "en-DE");
  assert.equal(clock.source, "macos");
  assert.deepEqual(requested.sort(), [
    "AppleICUForce12HourTime",
    "AppleICUForce24HourTime",
    "AppleLocale",
  ]);
});

test("explicit macOS hour-cycle preferences override the regional default", async () => {
  const clock12 = await readSystemClock("darwin", async (key) =>
    key === "AppleICUForce12HourTime" ? "1" : key === "AppleLocale" ? "en_US@rg=dezzzz" : "",
  );
  assert.equal(clock12.hour12, true);
  assert.equal(clock12.locale, "en-DE");
  const clock24 = await readSystemClock("darwin", async (key) =>
    key === "AppleICUForce24HourTime" ? "1" : key === "AppleLocale" ? "en_US" : "",
  );
  assert.equal(clock24.hour12, false);
  assert.equal(clock24.source, "macos");
});

test("overrides cover history and tooltips, including midnight as 00", () => {
  for (const style of ["clock", "history", "full"]) {
    assert.doesNotMatch(timestamp(at, preference("24h", true), style), /AM|PM/);
    assert.match(timestamp(at, preference("12h", false), style), /pm/i);
  }
  assert.equal(
    timestamp(new Date(2026, 8, 5, 0, 4).toISOString(), preference("24h", true), "clock"),
    "00:04",
  );
  assert.equal(timestamp("invalid", preference("system", false), "clock"), "");
  assert.equal(validTimeFormat("other"), "system");
});

test("missing macOS locale keeps the runtime locale fallback", async () => {
  const missing = await readSystemClock("darwin", async () => {
    throw new Error("Not set");
  });
  assert.equal(missing.source, "locale");
  assert.equal(missing.hour12, localeClock().hour12);
});

test("other platforms never execute macOS preference commands", async () => {
  const clock = await readSystemClock("linux", async () => {
    throw new Error("Must not run");
  });
  assert.equal(clock.source, "locale");
});
