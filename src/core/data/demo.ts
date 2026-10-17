/**
 * Demo mode: the Body and Money templates filled with about three years of
 * made-up data, generated from a fixed seed. Nothing here is real.
 */

import { type DayNum, fromDayNum, ymd } from '../model/dates';
import type { MetricDef } from '../model/types';
import type { Vault } from '../vault/vault';
import { newId, savePeriod, setEntry } from './repo';
import { applyTemplate } from './templates';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedDemo(vault: Vault, today: DayNum, seed = 20240611): void {
  const rnd = mulberry32(seed);
  const gauss = () => {
    const u = Math.max(rnd(), 1e-9);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
  };
  const days = 1180;
  const start = today - days;
  const iso = (d: DayNum) => fromDayNum(d);

  const body = applyTemplate(vault, 'body');
  const money = applyTemplate(vault, 'money');
  const m = (list: MetricDef[], slug: string) => list.find((x) => x.slug === slug)!;
  const weight = m(body.metrics, body.slug('weight'));
  const height = m(body.metrics, body.slug('height'));
  const bank = m(money.metrics, money.slug('bank'));
  const fundA = m(money.metrics, money.slug('fund_a'));
  const fundB = m(money.metrics, money.slug('fund_b'));
  const capA = m(money.metrics, money.slug('fund_a_capital'));
  const capB = m(money.metrics, money.slug('fund_b_capital'));
  const need = m(money.metrics, money.slug('monthly_need'));
  const lifetime = m(money.metrics, money.slug('lifetime_need'));
  const monthNet = m(money.metrics, money.slug('month_net'));
  const monthSpend = m(money.metrics, money.slug('month_spend'));
  const cuts = body.sets[0]!;
  const places = money.sets[0]!;

  vault.batch(() => {
    // Body ------------------------------------------------------------------
    const campaigns: Array<[DayNum, DayNum | null, string]> = [
      [start + 110, start + 196, 'Spring cut'],
      [start + 505, start + 590, 'Before summer'],
      [today - 62, null, 'Autumn reset'],
    ];
    for (const [s, e, name] of campaigns) {
      savePeriod(vault, { id: newId(), setId: cuts.id, name, start: iso(s), end: e === null ? null : iso(e) });
    }
    setEntry(vault, height, iso(start), 176.5);
    setEntry(vault, height, iso(start + 640), 177.5);

    let w = 84.2;
    for (let d = start; d <= today; d++) {
      const cutting = campaigns.some(([s, e]) => d >= s && d <= (e ?? today));
      w += cutting ? -0.055 + gauss() * 0.04 : 0.014 + gauss() * 0.035;
      w = Math.min(Math.max(w, 70), 95);
      if (d !== today && rnd() < 0.16) continue;
      setEntry(vault, weight, iso(d), w + gauss() * 0.3);
    }

    // Money -----------------------------------------------------------------
    const aStart = start + 75;
    const bStart = start + 430;
    setEntry(vault, capA, iso(aStart), 3000);
    setEntry(vault, capB, iso(bStart), 1500);
    setEntry(vault, need, iso(start), 1650);
    setEntry(vault, lifetime, iso(start), 1650 * 12 * 52);

    const placeBounds: Array<[DayNum, DayNum | null, string, number]> = [
      [start, start + 420, 'Lisbon', 2350],
      [start + 421, start + 860, 'Berlin', 3100],
      [start + 861, null, 'Copenhagen', 2700],
    ];
    for (const [s, e, name] of placeBounds) {
      savePeriod(vault, { id: newId(), setId: places.id, name, start: iso(s), end: e === null ? null : iso(e) });
    }

    let cash = 4200;
    let a = 0;
    let bVal = 0;
    let monthIn = 0;
    let monthOut = 0;
    for (let d = start; d <= today; d++) {
      const { d: dom } = ymd(d);
      const salary = placeBounds.find(([s, e]) => d >= s && d <= (e ?? today))![3];
      if (dom === 1) {
        cash += salary;
        monthIn += salary;
      }
      if (dom === 3) {
        const rent = Math.round(salary * 0.31);
        cash -= rent;
        monthOut += rent;
      }
      const spend = Math.max(0, 33 + gauss() * 22);
      cash -= spend;
      monthOut += spend;
      if (d === aStart) {
        cash -= 3000;
        a = 3000;
      }
      if (d === bStart) {
        cash -= 1500;
        bVal = 1500;
      }
      const weekend = (d + 4) % 7 === 0 || (d + 4) % 7 === 6;
      if (a && !weekend) a *= 1 + 0.00032 + gauss() * 0.0095;
      if (bVal && !weekend) bVal *= 1 + 0.00028 + gauss() * 0.0012;

      if (d === today || rnd() > 0.07) setEntry(vault, bank, iso(d), cash);
      if (a && !weekend) setEntry(vault, fundA, iso(d), a);
      if (bVal && !weekend) setEntry(vault, fundB, iso(d), bVal);

      const next = ymd(d + 1);
      if (next.d === 1 && d < today) {
        setEntry(vault, monthNet, iso(d), monthIn - monthOut);
        setEntry(vault, monthSpend, iso(d), monthOut);
        monthIn = 0;
        monthOut = 0;
      }
    }
  });
}
