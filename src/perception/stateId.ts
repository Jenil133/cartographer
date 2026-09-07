import sharp from "sharp";
import { sha10, sha256 } from "../util/hash.js";
import type { StateNode } from "../types.js";

/**
 * 64-bit difference hash of a screenshot, as 16 hex chars.
 *
 * WHY dHash: robust to minor rendering noise (antialiasing, cursor, scrollbar),
 * cheap, no ML dependency, and identical in shape for desktop screenshots.
 * Resize to 9x8 and compare each pixel with its right-hand neighbour -> 8x8 bits.
 */
export async function dHash(png: Buffer): Promise<string> {
  const { data } = await sharp(png)
    .grayscale()
    .resize(9, 8, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  let bits = "";
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits += data[y * 9 + x] < data[y * 9 + x + 1] ? "1" : "0";
    }
  }
  return BigInt("0b" + bits).toString(16).padStart(16, "0");
}

/** Number of differing bits between two dHashes. */
export function hamming(a: string, b: string): number {
  let x = BigInt("0x" + a) ^ BigInt("0x" + b);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

/**
 * Hash of a page's visible text, normalized so incidental churn does not
 * create new states: digits become '#' (order counts, totals, timestamps),
 * whitespace collapses, case is dropped.
 */
export function textDigest(visibleText: string): string {
  const norm = visibleText
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return sha256(norm);
}

export function stateIdFor(urlPath: string, domDigest: string): string {
  return "s_" + sha10(urlPath + "|" + domDigest);
}

export interface StateObservation {
  urlPath: string;
  phash: string;
  domDigest: string;
}

/** Max dHash distance still considered "the same screen". */
export const PHASH_TOLERANCE = 6;

/**
 * Resolve an observation to an already-known state, or null if it is new.
 * Exact id match first, then a fuzzy match on the same urlPath within tolerance.
 */
export function resolveState(
  obs: StateObservation,
  states: Record<string, StateNode>,
): StateNode | null {
  const exact = states[stateIdFor(obs.urlPath, obs.domDigest)];
  if (exact) return exact;
  for (const s of Object.values(states)) {
    if (s.urlPath === obs.urlPath && hamming(s.phash, obs.phash) <= PHASH_TOLERANCE) {
      return s;
    }
  }
  return null;
}
