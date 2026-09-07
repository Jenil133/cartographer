import type { Affordance, MapDoc } from "../types.js";

export interface FrontierItem {
  stateId: string;
  affordanceId: string;
}

/**
 * FIFO queue of (state, affordance) pairs still to try.
 *
 * BFS order falls out of insertion order: states are discovered breadth-first,
 * and within a state the vision model returns its most important affordances
 * first, so the queue explores the obvious paths before the obscure ones.
 */
export class Frontier {
  private queue: FrontierItem[] = [];
  private seen = new Set<string>();
  private blocked: RegExp[];

  constructor(blocklist: string[] = []) {
    this.blocked = blocklist.map((p) => new RegExp(p, "i"));
  }

  private key(item: FrontierItem): string {
    return item.stateId + "|" + item.affordanceId;
  }

  isBlocked(label: string): boolean {
    return this.blocked.some((re) => re.test(label));
  }

  /**
   * Queue an affordance. Returns false if it was a duplicate or blocklisted.
   * A blocklisted affordance is marked skipped in place so the map records why
   * it was never explored.
   */
  push(item: FrontierItem, affordance?: Affordance): boolean {
    if (affordance && this.isBlocked(affordance.label)) {
      affordance.status = "skipped";
      affordance.skipReason = "blocklist";
      return false;
    }
    const k = this.key(item);
    if (this.seen.has(k)) return false;
    this.seen.add(k);
    this.queue.push(item);
    return true;
  }

  pop(): FrontierItem | undefined {
    return this.queue.shift();
  }

  size(): number {
    return this.queue.length;
  }

  /** Rebuild from every still-pending affordance in a map, for --resume. */
  static fromMap(doc: MapDoc, blocklist: string[] = []): Frontier {
    const f = new Frontier(blocklist);
    for (const state of Object.values(doc.states)) {
      for (const a of state.affordances) {
        if (a.status === "pending") f.push({ stateId: state.id, affordanceId: a.id }, a);
      }
    }
    return f;
  }
}
