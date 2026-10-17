/**
 * Hybrid logical clock. Stamps sort as plain strings and always move forward,
 * even when a device's wall clock is behind a stamp it has already seen. That
 * makes last-writer-wins merges deterministic across devices.
 *
 * Layout: 9 base-36 chars of milliseconds, 4 of counter, then the device id.
 */

const L_WIDTH = 9;
const C_WIDTH = 4;

export class Hlc {
  private l = 0;
  private c = 0;

  constructor(
    private readonly node: string,
    private readonly now: () => number = Date.now,
  ) {
    if (!/^[A-Za-z0-9_-]{4,16}$/.test(node)) throw new Error('Invalid HLC node id');
  }

  tick(): string {
    const pt = this.now();
    if (pt > this.l) {
      this.l = pt;
      this.c = 0;
    } else {
      this.c++;
    }
    return encodeStamp(this.l, this.c, this.node);
  }

  /** Fold in a stamp seen from elsewhere so later ticks sort after it. */
  receive(stamp: string): void {
    const s = decodeStamp(stamp);
    if (!s) return;
    if (s.l > this.l) {
      this.l = s.l;
      this.c = s.c;
    } else if (s.l === this.l && s.c > this.c) {
      this.c = s.c;
    }
  }
}

export function encodeStamp(l: number, c: number, node: string): string {
  return l.toString(36).padStart(L_WIDTH, '0') + c.toString(36).padStart(C_WIDTH, '0') + node;
}

export function decodeStamp(stamp: string): { l: number; c: number; node: string } | null {
  if (stamp.length < L_WIDTH + C_WIDTH + 4) return null;
  const l = parseInt(stamp.slice(0, L_WIDTH), 36);
  const c = parseInt(stamp.slice(L_WIDTH, L_WIDTH + C_WIDTH), 36);
  if (!Number.isFinite(l) || !Number.isFinite(c)) return null;
  return { l, c, node: stamp.slice(L_WIDTH + C_WIDTH) };
}
