import { describe, expect, it } from 'vitest';
import { localDayBounds, resolveDatePhrase, tzOffsetMinutes } from './dates.js';

// Wednesday 2026-10-21 15:00 UTC == 11:00 in New York (EDT, UTC-4).
const now = new Date('2026-10-21T15:00:00Z');

describe('resolveDatePhrase', () => {
  it('resolves date-only phrases as all-day at 09:00 local', () => {
    const r = resolveDatePhrase('tomorrow', now, 'America/New_York');
    expect(r).toMatchObject({ allDay: true, at: '2026-10-22T13:00:00.000Z' });
  });

  it('resolves explicit times in the user timezone', () => {
    const r = resolveDatePhrase('tomorrow at 5pm', now, 'Asia/Tokyo');
    // 15:00Z is already 00:00 Oct 22 in Tokyo, so "tomorrow" is Oct 23.
    expect(r).toMatchObject({ allDay: false, at: '2026-10-23T08:00:00.000Z' });
  });

  it('handles DST transitions (New York falls back on 2026-11-01)', () => {
    const r = resolveDatePhrase('November 2', now, 'America/New_York');
    expect(r?.at).toBe('2026-11-02T14:00:00.000Z'); // 09:00 EST == 14:00Z
  });

  it('prefers future dates for ambiguous weekdays', () => {
    const r = resolveDatePhrase('monday', now, 'Europe/London');
    expect(r?.at.startsWith('2026-10-26')).toBe(true);
  });

  it('returns null for text without a date', () => {
    expect(resolveDatePhrase('buy milk', now, 'UTC')).toBeNull();
  });
});

describe('tzOffsetMinutes', () => {
  it('is positive east of UTC', () => {
    expect(tzOffsetMinutes('Asia/Kolkata', now)).toBe(330);
    expect(tzOffsetMinutes('America/New_York', now)).toBe(-240);
  });
});

describe('localDayBounds', () => {
  it('returns the local calendar day', () => {
    const { start, end } = localDayBounds(now, 'America/Los_Angeles');
    expect(start.toISOString()).toBe('2026-10-21T07:00:00.000Z');
    expect(end.toISOString()).toBe('2026-10-22T07:00:00.000Z');
  });
});
