/**
 * Phase 1 end-to-end run against the real APIs.
 *
 *   npm run e2e            # default budget
 *   npx tsx scripts/e2e-explore.ts 25
 *
 * Explores the sample app and asserts the properties Phase 1 is defined by:
 * every state has a screenshot, every edge has before/after evidence and 64-hex
 * digests, and every mutating edge was reverted.
 *
 * Costs roughly $0.30 and ~10 minutes. Hard-capped at 30 minutes.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { config } from "../src/config.js";
import { explore } from "../src/explore/explorer.js";
import { loadManifest } from "../src/manifest.js";
import { MapStore } from "../src/map/store.js";

const MAX_ACTIONS = Number(process.argv[2] ?? 25);
const HARD_TIMEOUT_MS = 30 * 60_000;

const timeout = setTimeout(() => {
  console.error("\nHARD TIMEOUT: 30 minutes elapsed. Check the console for stray VMs.");
  process.exit(1);
}, HARD_TIMEOUT_MS);
timeout.unref();

const m = loadManifest("examples/target-shop/carto.target.json");
const { doc, run, mapPath } = await explore(m, { resume: false, maxActions: MAX_ACTIONS });

const dir = path.join(config.CARTO_MAPS_DIR, m.name);
const states = Object.values(doc.states);
const mutatedEdges = doc.edges.filter((e) => e.mutated);
const hex64 = /^[0-9a-f]{64}$/;

const checks: Record<string, boolean> = {
  "root state is set": typeof doc.rootStateId === "string" && doc.rootStateId.length > 0,
  "at least 8 states": states.length >= 8,
  "at least 1 edge": doc.edges.length >= 1,
  "every state has a screenshot on disk": states.every(
    (s) => s.screenshot !== "" && existsSync(path.join(dir, s.screenshot)),
  ),
  "every edge has before/after evidence on disk": doc.edges.every(
    (e) =>
      existsSync(path.join(dir, e.evidence.before)) &&
      existsSync(path.join(dir, e.evidence.after)),
  ),
  "every edge has 64-hex digests": doc.edges.every(
    (e) => hex64.test(e.digestBefore) && hex64.test(e.digestAfter),
  ),
  "at least 1 mutating edge": mutatedEdges.length >= 1,
  "every mutating edge was reverted": mutatedEdges.every((e) => e.reverted),
  "a destructive action was exercised": doc.edges.some(
    (e) => /refund|delete|save/i.test(e.action.label) && e.mutated,
  ),
  "map.json reloads and matches": (() => {
    const reloaded = new MapStore(dir).load();
    return (
      reloaded !== null &&
      reloaded.edges.length === doc.edges.length &&
      Object.keys(reloaded.states).length === states.length
    );
  })(),
};

const s = run.spent;
console.log(
  `\n${m.name}  states=${states.length} edges=${doc.edges.length} ` +
    `mutated=${mutatedEdges.length} reverted=${mutatedEdges.filter((e) => e.reverted).length} ` +
    `visionCalls=${s.visionCalls} reverts=${s.reverts} estUsd=${s.estUsd.toFixed(3)} map=${mapPath}`,
);

const revertNotes = run.notes.filter((n) => /^revert .* took/.test(n));
if (revertNotes.length) {
  const ms = revertNotes
    .map((n) => Number(n.match(/(\d+)ms/)?.[1] ?? 0))
    .sort((a, b) => a - b);
  console.log(`revert ms: min=${ms[0]} p50=${ms[Math.floor(ms.length / 2)]} max=${ms[ms.length - 1]}`);
}

console.log("\n--- checks ---");
for (const [name, pass] of Object.entries(checks)) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
}

const failed = Object.entries(checks).filter(([, p]) => !p);
if (failed.length) {
  console.error(`\n${failed.length} check(s) failed.`);
  process.exit(1);
}
console.log("\nALL CHECKS PASSED");
process.exit(0);
