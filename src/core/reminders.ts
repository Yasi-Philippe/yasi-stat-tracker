/**
 * Reminder planning. Pure: given metrics, what is already logged and the
 * current time, returns the notifications to schedule for the coming days.
 * Reminders for today are skipped once everything due today is logged.
 */

import { type DayNum, fromDayNum, todayDayNum, weekday } from './model/dates';
import type { MetricDef } from './model/types';
import type { ScheduledReminder } from '../platform/types';

export const REMINDER_DAYS = 21;

export function planReminders(
  metrics: MetricDef[],
  hasEntry: (metric: MetricDef, day: DayNum) => boolean,
  now: Date = new Date(),
  days = REMINDER_DAYS,
): ScheduledReminder[] {
  const active = metrics.filter((m) => !m.archived && m.cadence === 'daily' && m.reminder?.enabled && /^\d\d:\d\d$/.test(m.reminder.time));
  if (!active.length) return [];
  const today = todayDayNum(now);
  const out: ScheduledReminder[] = [];

  for (let day = today; day < today + days; day++) {
    // Group by time so metrics due at the same minute share one notification.
    const byTime = new Map<string, MetricDef[]>();
    for (const m of active) {
      const wd = m.reminder!.weekdays;
      if (wd && wd.length && !wd.includes(weekday(day))) continue;
      if (day === today && hasEntry(m, day)) continue;
      const list = byTime.get(m.reminder!.time) ?? [];
      list.push(m);
      byTime.set(m.reminder!.time, list);
    }
    for (const [time, list] of byTime) {
      const [h, min] = time.split(':').map(Number) as [number, number];
      const [y, mo, d] = fromDayNum(day).split('-').map(Number) as [number, number, number];
      const at = new Date(y, mo - 1, d, h, min, 0, 0);
      if (at.getTime() <= now.getTime() + 30_000) continue;
      const names = list.map((m) => m.name);
      out.push({
        id: reminderId(day, h * 60 + min),
        at,
        title: names.length === 1 ? `Time to log your ${names[0]!.toLowerCase()}` : 'Time to log today’s values',
        body: names.length === 1 ? 'It takes five seconds.' : names.join(' · '),
      });
    }
  }
  return out;
}

/** Deterministic 31-bit id per day and minute. */
export function reminderId(day: DayNum, minuteOfDay: number): number {
  return ((day % 100_000) * 1440 + minuteOfDay) % 2_147_483_647;
}
