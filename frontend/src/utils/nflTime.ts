/**
 * Football-week day helpers.
 *
 * NFL game labels such as "Sunday Night Football" and "Monday Night Football"
 * use the league's Pacific-time calendar, never the viewer's local calendar.
 */

const NFL_TIME_ZONE = "America/Los_Angeles";

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const weekdayFormatter = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  timeZone: NFL_TIME_ZONE,
});

export function nflWeekday(value: Date | string): number {
  const weekday = weekdayFormatter.format(new Date(value));
  return WEEKDAY_INDEX[weekday];
}

export function isNflSunday(value: Date | string): boolean {
  return nflWeekday(value) === 0;
}

export function isNflMonday(value: Date | string): boolean {
  return nflWeekday(value) === 1;
}
