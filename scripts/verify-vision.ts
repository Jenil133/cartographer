/**
 * Eyeball check for the vision step: run proposeAffordances against a saved
 * screenshot, print what came back, and draw the boxes onto a copy so you can
 * see whether a click at each bbox centre would actually land on the control.
 *
 *   npx tsx scripts/verify-vision.ts <screenshot.png> [outOverlay.png]
 *
 * Costs one Gemini call. Kept in the repo because prompt changes need re-checking.
 */
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { proposeAffordances } from "../src/vision/gemini.js";

const src = process.argv[2];
const out = process.argv[3] ?? "vision-overlay.png";
if (!src) {
  console.error("usage: tsx scripts/verify-vision.ts <screenshot.png> [out.png]");
  process.exit(2);
}

const png = readFileSync(src);
const meta = await sharp(png).metadata();
const W = meta.width ?? 1280;
const H = meta.height ?? 800;

const t0 = Date.now();
const affs = await proposeAffordances(png, {
  stateId: "s_verify0000",
  width: W,
  height: H,
  title: "verify",
});
console.log(`${W}x${H} | vision call ${Date.now() - t0}ms | ${affs.length} affordances\n`);

const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
console.log(pad("#", 3), pad("label", 28), pad("risk", 7), pad("click at", 11), "bbox");
affs.forEach((a, i) => {
  const cx = Math.round(a.bbox.x + a.bbox.w / 2);
  const cy = Math.round(a.bbox.y + a.bbox.h / 2);
  console.log(
    pad(String(i), 3),
    pad(a.label, 28),
    pad(a.risk, 7),
    pad(`${cx},${cy}`, 11),
    `${Math.round(a.bbox.x)},${Math.round(a.bbox.y)} ${Math.round(a.bbox.w)}x${Math.round(a.bbox.h)}`,
  );
});

const has = (re: RegExp) => affs.some((a) => re.test(a.label));
console.log("\n--- checks ---");
console.log("finds Refund       :", has(/refund/i));
console.log("finds Delete       :", has(/delete/i));
console.log("finds back link    :", has(/back/i));
console.log(
  "bboxes inside view :",
  affs.every(
    (a) => a.bbox.x >= 0 && a.bbox.y >= 0 && a.bbox.x + a.bbox.w <= W && a.bbox.y + a.bbox.h <= H,
  ),
);
console.log("ids unique         :", new Set(affs.map((a) => a.id)).size === affs.length);
console.log("all pending        :", affs.every((a) => a.status === "pending"));
console.log(
  "flagged write      :",
  JSON.stringify(affs.filter((a) => a.risk === "write").map((a) => a.label)),
);

const rects = affs
  .map((a, i) => {
    const { x, y, w, h } = a.bbox;
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#ff00aa" stroke-width="3"/>
      <circle cx="${x + w / 2}" cy="${y + h / 2}" r="4" fill="#00d0ff"/>
      <text x="${x + 2}" y="${y - 4}" font-family="monospace" font-size="13" fill="#ff00aa">${i}</text>`;
  })
  .join("");
await sharp(png)
  .composite([{ input: Buffer.from(`<svg width="${W}" height="${H}">${rects}</svg>`), top: 0, left: 0 }])
  .png()
  .toFile(out);
console.log(`\noverlay -> ${out}  (pink box = affordance, blue dot = click point)`);
