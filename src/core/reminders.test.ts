import { describe, expect, it } from 'vitest';
import { toDayNum } from './model/dates';
import type { MetricDef } from './model/types';
import { planReminders } from './reminders';

const m = (over: Partial<MetricDef>): MetricDef => ({
  id: over.slug ?? 'x',
  slug: 'x',
  name: 'X',
  unit: '',
  cadence: 'daily',
  fill: 'none',
  decimals: 1,
  step: 1,
  order: 1,
  ...over,
});

describe('reminders', () => {
  const now = new Date(2026, 9, 13, 7, 0); // 07:00 local
  const weight = m({ id: 'w', slug: 'weight', name: 'Weight', reminder: { enabled: true, time: '08:00' } });
  const bank = m({ id: 'b', slug: 'bank', name: 'Bank', reminder: { enabled: true, time: '08:00' } });

  it('groups metrics due at the same time and skips what is already logged today', () => {
    const today = toDayNum('2026-10-13');
    const plan = planReminders([weight, bank], (metric, day) => metric.id === 'w' && day === today, now, 3);
    expect(plan).toHaveLength(3);
    expect(plan[0]!.title).toBe('Time to log your bank');
    expect(plan[1]!.body).toBe('Weight · Bank');
    expect(new Set(plan.map((p) => p.id)).size).toBe(3);
  });

  it('skips times already past and respects weekdays', () => {
    const late = new Date(2026, 9, 13, 9, 0);
    const onlyMonday = m({ id: 'r', name: 'Run', reminder: { enabled: true, time: '08:00', weekdays: [1] } });
    const plan = planReminders([onlyMonday], () => false, late, 8);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.at.getDay()).toBe(1);
  });

  it('ignores disabled, archived and non-daily metrics', () => {
    const plan = planReminders(
      [m({ reminder: { enabled: false, time: '08:00' } }), m({ archived: true, reminder: { enabled: true, time: '08:00' } }), m({ cadence: 'monthly', reminder: { enabled: true, time: '08:00' } })],
      () => false,
      now,
    );
    expect(plan).toEqual([]);
  });
});
