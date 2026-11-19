import { describe, expect, it } from 'vitest';
import { DAY, WEEK, clockText, dayAtText, dayText, isoWeekId, lastCompleteWeek, rangeText, weekStartOf } from '../../../src/lifecycle/email/time';

const utc = (y: number, m: number, d: number, h = 0, min = 0, s = 0): number => Date.UTC(y, m - 1, d, h, min, s) / 1000;

describe('constants', () => {
  it('a day and a week in seconds', () => {
    expect(DAY).toBe(86400);
    expect(WEEK).toBe(604800);
  });
});

describe('dayText, clockText, dayAtText', () => {
  it('writes Mon 16 Nov in UTC', () => {
    expect(utc(2026, 11, 16, 11)).toBe(1794826800);
    expect(dayText(1794826800)).toBe('Mon 16 Nov');
    expect(clockText(1794826800)).toBe('11:00');
    expect(dayAtText(1794826800)).toBe('Mon 16 Nov at 11:00 UTC');
  });
  it('uses UTC, never the local zone: the last second of a day and the first of the next', () => {
    expect(dayText(utc(2026, 11, 15, 23, 59, 59))).toBe('Sun 15 Nov');
    expect(dayText(utc(2026, 11, 16, 0, 0, 0))).toBe('Mon 16 Nov');
  });
  it('pads the clock, does not pad the day', () => {
    expect(dayAtText(utc(2026, 3, 4, 7, 5))).toBe('Wed 4 Mar at 07:05 UTC');
    expect(clockText(utc(2026, 3, 4, 0, 0))).toBe('00:00');
    expect(clockText(utc(2026, 3, 4, 23, 59))).toBe('23:59');
  });
  it('knows every weekday and month', () => {
    const days = Array.from({ length: 7 }, (_, i) => dayText(utc(2026, 11, 8 + i)).split(' ')[0]);
    expect(days).toEqual(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
    const months = Array.from({ length: 12 }, (_, i) => dayText(utc(2026, i + 1, 1)).split(' ')[2]);
    expect(months).toEqual(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
  });
  it('handles a leap day', () => {
    expect(dayText(utc(2028, 2, 29))).toBe('Tue 29 Feb');
  });
});

describe('weekStartOf', () => {
  const monday = utc(2026, 11, 9);
  it('is Monday 00:00 UTC for any moment of the week', () => {
    expect(weekStartOf(monday)).toBe(monday);
    expect(weekStartOf(monday + 1)).toBe(monday);
    expect(weekStartOf(utc(2026, 11, 12, 15, 30))).toBe(monday);
    expect(weekStartOf(utc(2026, 11, 15, 23, 59, 59))).toBe(monday);
    expect(weekStartOf(utc(2026, 11, 16))).toBe(utc(2026, 11, 16));
  });
  it('the Sunday belongs to the week that began the Monday before', () => {
    expect(weekStartOf(utc(2026, 11, 15, 12))).toBe(monday);
  });
  it('crosses a month and a year boundary', () => {
    expect(weekStartOf(utc(2027, 1, 1, 10))).toBe(utc(2026, 12, 28));
    expect(weekStartOf(utc(2026, 12, 1))).toBe(utc(2026, 11, 30));
  });
});

describe('lastCompleteWeek', () => {
  it('on Monday 16 Nov 11:00 it is Mon 9 to Mon 16 Nov (end exclusive)', () => {
    expect(lastCompleteWeek(1794826800)).toEqual({ start: utc(2026, 11, 9), end: utc(2026, 11, 16) });
  });
  it('at Monday 00:00 sharp the week has just ended', () => {
    expect(lastCompleteWeek(utc(2026, 11, 16))).toEqual({ start: utc(2026, 11, 9), end: utc(2026, 11, 16) });
  });
  it('one second earlier, the week of 9 Nov is not complete yet', () => {
    expect(lastCompleteWeek(utc(2026, 11, 15, 23, 59, 59))).toEqual({ start: utc(2026, 11, 2), end: utc(2026, 11, 9) });
  });
  it('mid-week it is the week before', () => {
    expect(lastCompleteWeek(utc(2026, 11, 19, 11))).toEqual({ start: utc(2026, 11, 9), end: utc(2026, 11, 16) });
  });
  it('is always exactly one week long, starting on a Monday', () => {
    for (let d = 0; d < 21; d++) {
      const w = lastCompleteWeek(utc(2026, 12, 20 + d, 11));
      expect(w.end - w.start).toBe(WEEK);
      expect(new Date(w.start * 1000).getUTCDay()).toBe(1);
    }
  });
});

describe('isoWeekId', () => {
  it('the week starting Mon 9 Nov 2026 is 2026-W46', () => {
    expect(isoWeekId(utc(2026, 11, 9))).toBe('2026-W46');
  });
  it('the neighbours are W45 and W47', () => {
    expect(isoWeekId(utc(2026, 11, 2))).toBe('2026-W45');
    expect(isoWeekId(utc(2026, 11, 16))).toBe('2026-W47');
  });
  it('2026 has 53 ISO weeks: the week starting 28 Dec 2026 is 2026-W53', () => {
    expect(isoWeekId(utc(2026, 12, 28))).toBe('2026-W53');
    expect(isoWeekId(utc(2026, 12, 21))).toBe('2026-W52');
  });
  it('the week starting Mon 4 Jan 2027 is 2027-W01', () => {
    expect(isoWeekId(utc(2027, 1, 4))).toBe('2027-W01');
    expect(isoWeekId(utc(2027, 1, 11))).toBe('2027-W02');
  });
  it('a week that begins in December and ends in January takes the year of its Thursday', () => {
    // Mon 29 Dec 2025 - Sun 4 Jan 2026 is 2026-W01 (its Thursday is 1 Jan 2026)
    expect(isoWeekId(utc(2025, 12, 29))).toBe('2026-W01');
    // Mon 30 Dec 2024 - Sun 5 Jan 2025 is 2025-W01
    expect(isoWeekId(utc(2024, 12, 30))).toBe('2025-W01');
  });
  it('a week that begins in January but whose Thursday is in the old year does not exist for Mondays: Mon 1 Jan 2024 is 2024-W01', () => {
    expect(isoWeekId(utc(2024, 1, 1))).toBe('2024-W01');
  });
  it('2020 also has a week 53', () => {
    expect(isoWeekId(utc(2020, 12, 28))).toBe('2020-W53');
    expect(isoWeekId(utc(2021, 1, 4))).toBe('2021-W01');
  });
  it('the id of lastCompleteWeek on Mon 16 Nov 2026 is 2026-W46', () => {
    expect(isoWeekId(lastCompleteWeek(1794826800).start)).toBe('2026-W46');
  });
  it('matches a reference ISO-week calculation for every Monday of 2020-2030', () => {
    const ref = (ms: number): string => {
      const d = new Date(ms);
      const dow = d.getUTCDay() || 7;
      d.setUTCDate(d.getUTCDate() + 4 - dow);
      const y = d.getUTCFullYear();
      const wk = Math.ceil(((d.getTime() - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
      return `${y}-W${String(wk).padStart(2, '0')}`;
    };
    for (let t = utc(2020, 1, 6); t < utc(2031, 1, 1); t += WEEK) expect(isoWeekId(t), new Date(t * 1000).toISOString()).toBe(ref(t * 1000));
  });
});

describe('rangeText', () => {
  const nov9 = utc(2026, 11, 9);
  it('same month: "9–15 Nov"', () => {
    expect(rangeText(nov9, nov9 + WEEK)).toBe('9–15 Nov');
    expect(rangeText(nov9, nov9 + WEEK, false)).toBe('9–15 Nov');
  });
  it('same month with weekdays: "Mon 9 – Sun 15 Nov"', () => {
    expect(rangeText(nov9, nov9 + WEEK, true)).toBe('Mon 9 – Sun 15 Nov');
  });
  it('cross month: "30 Nov – 6 Dec"', () => {
    const s = utc(2026, 11, 30);
    expect(rangeText(s, s + WEEK)).toBe('30 Nov – 6 Dec');
    expect(rangeText(s, s + WEEK, true)).toBe('Mon 30 Nov – Sun 6 Dec');
  });
  it('cross year: both years are written', () => {
    const s = utc(2026, 12, 28);
    expect(rangeText(s, s + WEEK)).toBe('28 Dec 2026 – 3 Jan 2027');
    expect(rangeText(s, s + WEEK, true)).toBe('Mon 28 Dec 2026 – Sun 3 Jan 2027');
  });
  it('the end is exclusive: the last day is the one before it', () => {
    expect(rangeText(nov9, nov9 + DAY)).toBe('9–9 Nov');
    expect(rangeText(nov9, nov9 + 2 * DAY)).toBe('9–10 Nov');
  });
  it('two weeks: "2–15 Nov"', () => {
    expect(rangeText(utc(2026, 11, 2), utc(2026, 11, 16))).toBe('2–15 Nov');
  });
});
