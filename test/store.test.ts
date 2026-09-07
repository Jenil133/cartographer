import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MapStore, nextEdgeId } from "../src/map/store.js";
import { loadManifest } from "../src/manifest.js";
import type { Edge, MapDoc } from "../src/types.js";

const manifest = loadManifest("examples/target-shop/carto.target.json");

let dir: string;
let store: MapStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "carto-store-"));
  store = new MapStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const edge = (id: string): Edge => ({
  id, from: "s1", to: "s2",
  action: { kind: "click", x: 1, y: 2, label: "x", affordanceId: "a1" },
  mutated: false, reverted: false, digestBefore: "a", digestAfter: "a",
  evidence: { before: "", after: "" }, durationMs: 1, ts: "", runId: "r",
});

describe("MapStore", () => {
  it("returns null before anything is saved", () => {
    expect(store.load()).toBeNull();
  });

  it("round-trips init -> save -> load", () => {
    const doc = store.init(manifest);
    doc.rootStateId = "s_root";
    doc.edges.push(edge("e_000000"));
    store.save(doc);

    const loaded = store.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(1);
    expect(loaded!.rootStateId).toBe("s_root");
    expect(loaded!.edges).toHaveLength(1);
    expect(loaded!.target.name).toBe("target-shop");
  });

  it("stamps updatedAt on save", () => {
    const doc = store.init(manifest);
    store.save(doc);
    expect(Date.parse(store.load()!.updatedAt)).toBeGreaterThan(0);
  });

  it("leaves no .tmp file behind (atomic write)", () => {
    const doc = store.init(manifest);
    store.save(doc);
    store.save(doc);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
  });

  it("writes screenshots and returns a map-relative path", () => {
    const png = Buffer.from("fake-png");
    const rel = store.writeShot("s_abc", png);
    expect(rel).toBe("shots/s_abc.png");
    expect(existsSync(store.shotPath("s_abc"))).toBe(true);
  });
});

describe("nextEdgeId", () => {
  it("is zero-padded to six digits and tracks edge count", () => {
    const doc = { edges: [] } as unknown as MapDoc;
    expect(nextEdgeId(doc)).toBe("e_000000");
    doc.edges.push(edge("e_000000"));
    expect(nextEdgeId(doc)).toBe("e_000001");
    doc.edges.length = 17;
    expect(nextEdgeId(doc)).toBe("e_000017");
  });
});
