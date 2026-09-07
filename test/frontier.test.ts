import { describe, expect, it } from "vitest";
import { Frontier } from "../src/explore/frontier.js";
import type { Affordance, MapDoc, StateNode, TargetManifest } from "../src/types.js";

const aff = (id: string, stateId: string, label: string): Affordance => ({
  id, stateId, label, kind: "click",
  bbox: { x: 0, y: 0, w: 10, h: 10 },
  expected: "", risk: "unknown", status: "pending",
});

const state = (id: string, affordances: Affordance[]): StateNode => ({
  id, kind: "web", url: "http://x/" + id, urlPath: "/" + id, title: id,
  phash: "0000000000000000", domDigest: "d", screenshot: "", affordances,
  pathFromRoot: [], discoveredInRun: "r",
});

describe("Frontier", () => {
  it("is FIFO", () => {
    const f = new Frontier();
    f.push({ stateId: "s1", affordanceId: "a1" });
    f.push({ stateId: "s1", affordanceId: "a2" });
    expect(f.pop()?.affordanceId).toBe("a1");
    expect(f.pop()?.affordanceId).toBe("a2");
    expect(f.pop()).toBeUndefined();
  });

  it("ignores duplicates", () => {
    const f = new Frontier();
    expect(f.push({ stateId: "s1", affordanceId: "a1" })).toBe(true);
    expect(f.push({ stateId: "s1", affordanceId: "a1" })).toBe(false);
    expect(f.size()).toBe(1);
  });

  it("treats the same affordance id on different states as distinct", () => {
    const f = new Frontier();
    f.push({ stateId: "s1", affordanceId: "a1" });
    f.push({ stateId: "s2", affordanceId: "a1" });
    expect(f.size()).toBe(2);
  });

  it("still refuses a duplicate after it has been popped", () => {
    const f = new Frontier();
    f.push({ stateId: "s1", affordanceId: "a1" });
    f.pop();
    expect(f.push({ stateId: "s1", affordanceId: "a1" })).toBe(false);
  });

  it("blocklist is case-insensitive and matches as a regex", () => {
    const f = new Frontier(["log ?out", "sign ?out"]);
    expect(f.isBlocked("Logout button")).toBe(true);
    expect(f.isBlocked("Log Out")).toBe(true);
    expect(f.isBlocked("SIGN OUT link")).toBe(true);
    expect(f.isBlocked("Refund order")).toBe(false);
  });

  it("marks a blocklisted affordance skipped instead of queueing it", () => {
    const f = new Frontier(["log ?out"]);
    const a = aff("a1", "s1", "Logout button");
    expect(f.push({ stateId: "s1", affordanceId: "a1" }, a)).toBe(false);
    expect(a.status).toBe("skipped");
    expect(a.skipReason).toBe("blocklist");
    expect(f.size()).toBe(0);
  });

  it("rebuilds from a map, taking only pending affordances", () => {
    const pending = aff("a1", "s1", "Orders link");
    const explored = aff("a2", "s1", "Customers link");
    explored.status = "explored";
    const logout = aff("a3", "s1", "Logout button");

    const doc = {
      version: 1,
      target: {} as TargetManifest,
      rootStateId: "s1",
      states: { s1: state("s1", [pending, explored, logout]) },
      edges: [],
      runs: [],
      updatedAt: "",
    } satisfies MapDoc;

    const f = Frontier.fromMap(doc, ["log ?out"]);
    expect(f.size()).toBe(1); // explored skipped, logout blocklisted
    expect(f.pop()?.affordanceId).toBe("a1");
    expect(logout.status).toBe("skipped");
  });
});
