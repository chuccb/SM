/** Bounded fixed-window admission limit; runtime policy, NOT recovered game logic. */
export class CRateLimiter {
  private readonly entries = new Map<
    string,
    { start: number; count: number }
  >();
  constructor(
    readonly limit: number,
    readonly windowMs: number,
    readonly maxKeys: number,
    readonly clock: () => number = Date.now,
  ) {}
  Admit(key: string): boolean {
    const now = this.clock();
    let current = this.entries.get(key);
    if (!current || now - current.start >= this.windowMs) {
      for (const [id, entry] of this.entries)
        if (now - entry.start >= this.windowMs) this.entries.delete(id);
      if (!this.entries.has(key) && this.entries.size >= this.maxKeys)
        return false;
      current = { start: now, count: 0 };
      this.entries.set(key, current);
    }
    if (current.count >= this.limit) return false;
    current.count++;
    return true;
  }
}
