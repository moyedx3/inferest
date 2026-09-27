/** How long an owner waits between two report calls and between two settle calls on one vault. */
export type CooldownWindows = { reportMs: number; settleMs: number };
export type CooldownKind = "report" | "settle";

/**
 * Limits how often a signed-in owner may make the keeper send a report or settle transaction for their vault.
 * The last accepted call per kind and vault lives in an in-process Map, so a server restart forgets it; that
 * is acceptable, since a restart at worst allows one extra call per vault.
 */
export class OwnerCooldown {
  private readonly last = new Map<string, number>();
  private readonly windows: CooldownWindows;

  constructor(windows: CooldownWindows) {
    this.windows = windows;
  }

  /**
   * Answers 0 and records `now` when the call may proceed, or the whole seconds left (rounded up) when it may
   * not. A refused call does not restart the window.
   */
  check(kind: CooldownKind, vault: string, now: number): number {
    const key = `${kind}:${vault}`;
    const window = kind === "report" ? this.windows.reportMs : this.windows.settleMs;
    const prev = this.last.get(key);
    if (prev !== undefined && now - prev < window) return Math.ceil((prev + window - now) / 1000);
    this.last.set(key, now);
    return 0;
  }
}
