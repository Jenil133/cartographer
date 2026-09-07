import type { Budget, Spent } from "../types.js";

// Starter rates. ⚠️ verify at https://docs.getsolari.com/pricing
const USD_PER_SANDBOX_MINUTE = 0.114 / 60; // 2 vCPU / 4 GB
const USD_PER_BROWSER_MINUTE = 0.1 / 60;
const USD_PER_VISION_CALL = 0.002;

export function zeroSpent(): Spent {
  return {
    actions: 0,
    states: 0,
    visionCalls: 0,
    reverts: 0,
    sandboxMinutes: 0,
    browserMinutes: 0,
    estUsd: 0,
  };
}

export class BudgetTracker {
  readonly spent: Spent;
  private readonly startedAt = Date.now();

  constructor(
    private readonly budget: Budget,
    spent: Spent = zeroSpent(),
  ) {
    this.spent = spent;
  }

  get elapsedMinutes(): number {
    return (Date.now() - this.startedAt) / 60_000;
  }

  /** True while every budget dimension still has room. */
  canAct(): boolean {
    return (
      this.spent.actions < this.budget.maxActions &&
      this.spent.states < this.budget.maxStates &&
      this.spent.visionCalls < this.budget.maxVisionCalls &&
      this.elapsedMinutes < this.budget.maxMinutes
    );
  }

  /** Why `canAct()` is false, for run notes. */
  exhaustedReason(): string | null {
    if (this.spent.actions >= this.budget.maxActions) return "maxActions";
    if (this.spent.states >= this.budget.maxStates) return "maxStates";
    if (this.spent.visionCalls >= this.budget.maxVisionCalls)
      return "maxVisionCalls";
    if (this.elapsedMinutes >= this.budget.maxMinutes) return "maxMinutes";
    return null;
  }

  note(kind: keyof Spent, n = 1): void {
    this.spent[kind] += n;
    this.recomputeUsd();
  }

  /** Called at teardown so VM/browser minutes land in the map. */
  setMinutes(sandboxMinutes: number, browserMinutes: number): void {
    this.spent.sandboxMinutes = sandboxMinutes;
    this.spent.browserMinutes = browserMinutes;
    this.recomputeUsd();
  }

  private recomputeUsd(): void {
    this.spent.estUsd =
      this.spent.sandboxMinutes * USD_PER_SANDBOX_MINUTE +
      this.spent.browserMinutes * USD_PER_BROWSER_MINUTE +
      this.spent.visionCalls * USD_PER_VISION_CALL;
  }
}
