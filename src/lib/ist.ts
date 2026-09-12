// IST (Asia/Kolkata, UTC+5:30) — the outlets' clock.
//
// The rest of the codebase stores and reasons in UTC, but every human-facing date in this app is a
// wall-clock date in India: "closed Tuesday" means Tuesday in Surat, and a booking on the 15th is the
// 15th there regardless of where the operator's laptop is. Until now the offset was copy-pasted into
// four files with no shared home, which is fine for display but not for logic — this module exists
// because closed-days needs to DERIVE a weekday, not just format one.
//
// A fixed offset is correct here and not a shortcut: India has never observed DST, so there is no
// transition for a zone database to know about.

export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * The IST weekday of an instant: 0 = Sunday … 2 = Tuesday.
 *
 * The naive version — `new Date(ms).getUTCDay()` — is wrong by a whole day for the exact bookings
 * that matter. A Tuesday 9:30 PM IST reservation is stored as Tuesday 16:00 UTC, which happens to
 * agree; but a Tuesday 4:00 AM IST instant is MONDAY 22:30 UTC and would read as Monday. Shifting
 * into IST first is what makes the answer the restaurant's answer.
 */
export function istWeekday(ms: number): number {
  return new Date(ms + IST_OFFSET_MS).getUTCDay();
}

/** The IST calendar date of an instant as "YYYY-MM-DD", for comparing against a `date` column. */
export function istDateKey(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Midnight starting `ms`'s IST calendar day, as a UTC epoch. */
export function istDayStart(ms: number): number {
  return Math.floor((ms + IST_OFFSET_MS) / 86_400_000) * 86_400_000 - IST_OFFSET_MS;
}

/**
 * An `<input type="date">` value ("2026-09-15") → the UTC instant of that IST day's midnight.
 *
 * `new Date("2026-09-15")` parses as UTC midnight and `new Date(v + "T00:00")` parses in the
 * BROWSER's zone — neither is the outlet's midnight. Appending the Z and subtracting the offset
 * pins it to IST whatever the operator's machine is set to.
 */
export function fromIstDateStart(v: string): string | null {
  if (!v) return null;
  const t = new Date(`${v}T00:00:00Z`).getTime();
  return isNaN(t) ? null : new Date(t - IST_OFFSET_MS).toISOString();
}

/** Same, but the END of that IST day — i.e. the following midnight, so the whole day is covered. */
export function fromIstDateEnd(v: string): string | null {
  if (!v) return null;
  const t = new Date(`${v}T00:00:00Z`).getTime();
  return isNaN(t) ? null : new Date(t + 86_400_000 - IST_OFFSET_MS).toISOString();
}

/**
 * An `<input type="datetime-local">` value ("2026-09-15T18:30") read as IST → the UTC instant.
 *
 * The Unavailable page previously did `new Date(v).toISOString()` on this, which interprets the
 * value in whatever zone the operator's machine is set to — so a closure entered from outside India
 * ended at the wrong moment. Appending the Z makes the parse explicit, and subtracting the offset
 * puts it on the outlet's clock.
 */
export function fromIstDateTime(v: string): string | null {
  if (!v) return null;
  const t = new Date(`${v.length === 16 ? v : v.slice(0, 16)}:00Z`).getTime();
  return isNaN(t) ? null : new Date(t - IST_OFFSET_MS).toISOString();
}

/** A UTC ISO instant → the `<input type="date">` value for its IST day. */
export function toIstDateInput(iso: string | null): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  return isNaN(t) ? "" : istDateKey(t);
}

/** "Tue 15 Sep" — the compact IST label used in the AI prompt and the Unavailable list. */
export function istDayLabel(ms: number): string {
  return new Date(ms).toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
