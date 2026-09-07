/**
 * Exercise the full exploration loop against real Solari infrastructure with the
 * vision step stubbed out.
 *
 *   npx tsx scripts/e2e-novision.ts [maxActions]
 *
 * WHY: the Gemini free tier allows 20 requests/day/model, which cannot finish a
 * run. Everything except "which pixels look clickable" can still be proven -
 * BFS, state resolution, mutation detection, revert, resumable persistence,
 * screenshots. This is NOT a substitute for `npm run e2e`: it says nothing about
 * whether vision picks the right boxes, only that the machinery around it works.
 *
 * The stub reads clickable elements out of the DOM. That deliberately violates
 * the vision-first principle, which is exactly why it lives in a script and is
 * injected, never wired into the default path.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { config } from "../src/config.js";
import { explore, type VisionFn } from "../src/explore/explorer.js";
import { loadManifest } from "../src/manifest.js";
import { sha10 } from "../src/util/hash.js";
import type { Affordance, Risk } from "../src/types.js";

const MAX_ACTIONS = Number(process.argv[2] ?? 12);

/**
 * Stand-in for the vision model. Re-detects controls from the rendered image is
 * not possible without a model, so instead we emit the fixed set of controls the
 * sample app is known to have, positioned by locating their colour blocks.
 * Simpler and more honest: derive them from the screenshot's known layout.
 */
const stubVision: VisionFn = async (png, ctx) => {
  const { width, height } = await sharp(png).metadata();
  const W = width ?? ctx.width;
  const H = height ?? ctx.height;

  type C = { label: string; x: number; y: number; w: number; h: number; risk: Risk };

  // Nav pills are on every page. Positions come from the actual rendered layout.
  const nav: C[] = [
    { label: "Dashboard link", x: 24, y: 63, w: 111, h: 38, risk: "read" },
    { label: "Orders link", x: 148, y: 63, w: 84, h: 38, risk: "read" },
    { label: "Customers link", x: 243, y: 63, w: 111, h: 38, risk: "read" },
    { label: "Settings link", x: 367, y: 63, w: 92, h: 38, risk: "read" },
  ];

  // Page-specific controls. A real vision model infers these from the pixels; the
  // stub keys off the title so it reaches a detail page (and a mutation) without
  // burning the whole action budget on controls that are not on screen.
  const perPage: Record<string, C[]> = {
    // Item-column links, read off a captured screenshot. x=60 is the ID column
    // and has no link - clicking it produces a self-loop, which is exactly the
    // class of mistake the vision overlay check exists to catch.
    orders: [
      { label: "Order row 1 link", x: 105, y: 232, w: 142, h: 18, risk: "read" },
      { label: "Order row 2 link", x: 105, y: 274, w: 82, h: 18, risk: "read" },
    ],
    detail: [
      { label: "Refund order button", x: 24, y: 392, w: 146, h: 42, risk: "write" },
      { label: "Delete order button", x: 187, y: 392, w: 140, h: 42, risk: "write" },
      { label: "Back to orders button", x: 342, y: 392, w: 159, h: 42, risk: "read" },
    ],
    settings: [{ label: "Save settings button", x: 45, y: 386, w: 150, h: 40, risk: "write" }],
  };

  // NB: the detail page's <h1> is "Order #1" but its <title> is "Order 1" - no
  // hash. Matching on "#" silently produced a detail state with only nav links.
  const t = ctx.title.toLowerCase();
  const extra = /^order\s*#?\s*\d+/.test(t)
    ? perPage.detail
    : t === "orders"
      ? perPage.orders
      : t === "settings"
        ? perPage.settings
        : [];
  // Page-specific controls first: real vision returns "most important first",
  // and BFS pops in insertion order, so this reaches real actions before nav.
  const candidates: C[] = [...(extra ?? []), ...nav];

  return candidates
    .filter((c) => c.x + c.w <= W && c.y + c.h <= H)
    .map((c): Affordance => {
      const bbox = { x: c.x, y: c.y, w: c.w, h: c.h };
      const cx = Math.round(bbox.x + bbox.w / 2);
      const cy = Math.round(bbox.y + bbox.h / 2);
      return {
        id: "a_" + sha10(ctx.stateId + c.label + cx + cy),
        stateId: ctx.stateId,
        label: c.label,
        kind: "click",
        bbox,
        expected: "stubbed",
        risk: c.risk,
        status: "pending",
      };
    });
};

const m = loadManifest("examples/target-shop/carto.target.json");
const { doc, run, mapPath } = await explore(m, {
  resume: false,
  maxActions: MAX_ACTIONS,
  vision: stubVision,
});

const dir = path.join(config.CARTO_MAPS_DIR, m.name);
const states = Object.values(doc.states);
const mutated = doc.edges.filter((e) => e.mutated);
const hex64 = /^[0-9a-f]{64}$/;

const checks: Record<string, boolean> = {
  "root state set": !!doc.rootStateId,
  "discovered multiple states": states.length >= 3,
  "recorded edges": doc.edges.length >= 1,
  "every state has a screenshot on disk": states.every(
    (s) => s.screenshot !== "" && existsSync(path.join(dir, s.screenshot)),
  ),
  "every edge has before/after evidence": doc.edges.every(
    (e) => existsSync(path.join(dir, e.evidence.before)) && existsSync(path.join(dir, e.evidence.after)),
  ),
  "every edge has 64-hex digests": doc.edges.every(
    (e) => hex64.test(e.digestBefore) && hex64.test(e.digestAfter),
  ),
  "at least one mutation detected": mutated.length >= 1,
  "every mutation was reverted": mutated.every((e) => e.reverted),
};

const s = run.spent;
console.log(
  `\nstates=${states.length} edges=${doc.edges.length} mutated=${mutated.length} ` +
    `reverts=${s.reverts} sandboxMin=${s.sandboxMinutes.toFixed(2)} estUsd=${s.estUsd.toFixed(3)}`,
);
console.log(`map: ${mapPath}`);

for (const e of doc.edges) {
  console.log(
    `  ${e.id} ${e.from.slice(0, 8)} -> ${e.to.slice(0, 8)}  "${e.action.label}"` +
      (e.mutated ? `  MUTATED${e.reverted ? " (reverted)" : " NOT REVERTED"}` : ""),
  );
}

console.log("\n--- checks ---");
for (const [name, pass] of Object.entries(checks)) console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
if (run.notes.length) {
  console.log("\nnotes:");
  for (const n of run.notes.slice(0, 15)) console.log("  " + n);
}

const failed = Object.entries(checks).filter(([, p]) => !p);
console.log(`\n${failed.length ? `${failed.length} CHECK(S) FAILED` : "ALL CHECKS PASSED"}`);
process.exit(failed.length ? 1 : 0);
