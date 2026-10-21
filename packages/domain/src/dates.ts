import { TZDate } from '@date-fns/tz';
import * as chrono from 'chrono-node';
import { addDays, startOfDay } from 'date-fns';

export interface ResolvedDate {
  /** UTC instant as ISO-8601. */
  at: string;
  /** True when the phrase named a day but no time ("tomorrow", "next month"). */
  allDay: boolean;
  /** The span of the phrase that chrono matched. */
  matchedText: string;
}

/** Hour used for date-only phrases so all-day items sort and remind sensibly. */
export const ALL_DAY_HOUR = 9;

/** Minutes east of UTC for `timeZone` at `instant` (chrono's convention). */
export function tzOffsetMinutes(timeZone: string, instant: Date): number {
  return -new TZDate(instant, timeZone).getTimezoneOffset();
}

/**
 * Resolve a natural-language date phrase relative to `now` in the user's IANA
 * timezone. The LLM extracts the phrase verbatim; this function does the maths,
 * so results are deterministic, testable and immune to model date arithmetic
 * mistakes.
 */
export function resolveDatePhrase(phrase: string, now: Date, timeZone: string): ResolvedDate | null {
  const results = chrono.parse(
    phrase,
    { instant: now, timezone: tzOffsetMinutes(timeZone, now) },
    { forwardDate: true },
  );
  const first = results[0];
  if (!first) return null;

  const start = first.start;
  const hasTime = start.isCertain('hour');
  if (hasTime) {
    return { at: start.date().toISOString(), allDay: false, matchedText: first.text };
  }
  // Rebuild date-only results in the user's zone so DST and offsets are right.
  const local = new TZDate(
    start.get('year')!,
    start.get('month')! - 1,
    start.get('day')!,
    ALL_DAY_HOUR,
    0,
    0,
    timeZone,
  );
  return { at: new Date(local.getTime()).toISOString(), allDay: true, matchedText: first.text };
}

/** [start, end) of the user's local calendar day containing `now`, as UTC Dates. */
export function localDayBounds(now: Date, timeZone: string): { start: Date; end: Date } {
  const start = startOfDay(new TZDate(now, timeZone));
  const end = addDays(start, 1);
  return { start: new Date(start.getTime()), end: new Date(end.getTime()) };
}

/** Human-friendly local date-time string for prompts and notifications. */
export function formatLocal(instant: Date, timeZone: string, locale = 'en-US'): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(instant);
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
