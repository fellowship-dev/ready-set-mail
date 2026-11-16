// Dates in lifecycle emails: UTC, written "Mon 16 Nov"; weeks are ISO weeks (Monday 00:00 to Sunday 24:00 UTC).

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
export const DAY = 86400;
export const WEEK = 7 * DAY;

const at = (unix: number) => new Date(unix * 1000);

/** "Mon 16 Nov" */
export const dayText = (unix: number): string => `${DAYS[at(unix).getUTCDay()]} ${at(unix).getUTCDate()} ${MONTHS[at(unix).getUTCMonth()]}`;
/** "11:00" */
export const clockText = (unix: number): string => `${String(at(unix).getUTCHours()).padStart(2, '0')}:${String(at(unix).getUTCMinutes()).padStart(2, '0')}`;
/** "Mon 16 Nov at 11:00 UTC" */
export const dayAtText = (unix: number): string => `${dayText(unix)} at ${clockText(unix)} UTC`;

/** Monday 00:00 UTC of the week `unix` falls in. */
export function weekStartOf(unix: number): number {
  const day = Math.floor(unix / DAY);
  const dow = (at(unix).getUTCDay() + 6) % 7; // Monday = 0
  return (day - dow) * DAY;
}

/** The last week that has ended by `now`: [start, end), end being the Monday 00:00 UTC on or before now. */
export function lastCompleteWeek(now: number): { start: number; end: number } {
  const end = weekStartOf(now);
  return { start: end - WEEK, end };
}

/** "2026-W46": the ISO week (year of its Thursday) of the Monday-00:00-UTC `weekStart`. */
export function isoWeekId(weekStart: number): string {
  const thursday = at(weekStart + 3 * DAY);
  const year = thursday.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1) / 1000;
  const n = Math.floor((weekStart + 3 * DAY - jan1) / WEEK) + 1;
  return `${year}-W${String(n).padStart(2, '0')}`;
}

/** A range of whole days [start, end) as "9–15 Nov", "30 Nov – 6 Dec" or, with a year change, "30 Dec 2026 – 5 Jan 2027". */
export function rangeText(start: number, end: number, weekdays = false): string {
  const a = at(start), b = at(end - 1);
  const dn = (d: Date) => (weekdays ? `${DAYS[d.getUTCDay()]} ` : '');
  if (a.getUTCFullYear() !== b.getUTCFullYear()) return `${dn(a)}${a.getUTCDate()} ${MONTHS[a.getUTCMonth()]} ${a.getUTCFullYear()} – ${dn(b)}${b.getUTCDate()} ${MONTHS[b.getUTCMonth()]} ${b.getUTCFullYear()}`;
  if (a.getUTCMonth() !== b.getUTCMonth()) return `${dn(a)}${a.getUTCDate()} ${MONTHS[a.getUTCMonth()]} – ${dn(b)}${b.getUTCDate()} ${MONTHS[b.getUTCMonth()]}`;
  return weekdays ? `${dn(a)}${a.getUTCDate()} – ${dn(b)}${b.getUTCDate()} ${MONTHS[b.getUTCMonth()]}` : `${a.getUTCDate()}–${b.getUTCDate()} ${MONTHS[b.getUTCMonth()]}`;
}
