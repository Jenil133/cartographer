import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  dHash,
  hamming,
  resolveState,
  stateIdFor,
  textDigest,
} from "../src/perception/stateId.js";
import type { StateNode } from "../src/types.js";

const solid = (r: number, g: number, b: number) =>
  sharp({ create: { width: 120, height: 90, channels: 3, background: { r, g, b } } })
    .png()
    .toBuffer();

/** Horizontal gradient, so neighbouring-pixel comparisons differ from a flat fill. */
async function gradient(): Promise<Buffer> {
  const w = 120, h = 90;
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = Math.round((x / (w - 1)) * 255);
      const i = (y * w + x) * 3;
      raw[i] = v; raw[i + 1] = v; raw[i + 2] = v;
    }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

describe("dHash", () => {
  it("is stable across a re-encode of the same image", async () => {
    const png = await gradient();
    const reencoded = await sharp(png).png({ compressionLevel: 1 }).toBuffer();
    expect(png.equals(reencoded)).toBe(false); // different bytes...
    expect(await dHash(reencoded)).toBe(await dHash(png)); // ...same hash
  });

  it("returns 16 hex chars", async () => {
    expect(await dHash(await gradient())).toMatch(/^[0-9a-f]{16}$/);
  });

  it("separates visually different images by more than the match tolerance", async () => {
    const d = hamming(await dHash(await solid(255, 255, 255)), await dHash(await gradient()));
    expect(d).toBeGreaterThan(10);
  });
});

describe("hamming", () => {
  it("is 0 for identical hashes", async () => {
    const h = await dHash(await gradient());
    expect(hamming(h, h)).toBe(0);
  });

  it("counts differing bits", () => {
    expect(hamming("0000000000000000", "0000000000000001")).toBe(1);
    expect(hamming("0000000000000000", "000000000000000f")).toBe(4);
    expect(hamming("ffffffffffffffff", "0000000000000000")).toBe(64);
  });
});

describe("textDigest", () => {
  it("ignores digits so counters and totals do not fork states", () => {
    expect(textDigest("Order 12 total 5")).toBe(textDigest("Order 99 total 7"));
  });

  it("ignores whitespace and case", () => {
    expect(textDigest("  Hello   World \n")).toBe(textDigest("hello world"));
  });

  it("still separates genuinely different text", () => {
    expect(textDigest("Orders")).not.toBe(textDigest("Customers"));
  });
});

describe("resolveState", () => {
  const mk = (urlPath: string, phash: string, domDigest: string): StateNode => ({
    id: stateIdFor(urlPath, domDigest),
    kind: "web", url: "http://x" + urlPath, urlPath, title: urlPath,
    phash, domDigest, screenshot: "", affordances: [], pathFromRoot: [],
    discoveredInRun: "r_test",
  });

  const orders = mk("/orders", "ffffffffffffffff", "d1");
  const states: Record<string, StateNode> = { [orders.id]: orders };

  it("matches exactly on urlPath + domDigest", () => {
    expect(resolveState({ urlPath: "/orders", phash: "0000000000000000", domDigest: "d1" }, states)?.id)
      .toBe(orders.id);
  });

  it("matches fuzzily within tolerance on the same urlPath", () => {
    // one bit different -> same screen with trivial rendering noise
    expect(resolveState({ urlPath: "/orders", phash: "fffffffffffffffe", domDigest: "other" }, states)?.id)
      .toBe(orders.id);
  });

  it("rejects a far-off phash as a new state", () => {
    expect(resolveState({ urlPath: "/orders", phash: "0000000000000000", domDigest: "other" }, states))
      .toBeNull();
  });

  it("never matches across different urlPaths", () => {
    expect(resolveState({ urlPath: "/customers", phash: "ffffffffffffffff", domDigest: "other" }, states))
      .toBeNull();
  });
});
