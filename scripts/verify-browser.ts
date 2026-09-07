/**
 * Step 7 verification: cloud browser against the sandboxed sample app.
 *
 *   npx tsx scripts/verify-browser.ts
 *
 * Checks login via storageState, observation, coordinate clicking, and that the
 * network allowlist really does stop the exploring browser reaching the outside.
 */
import { writeFileSync } from "node:fs";
import { loadManifest } from "../src/manifest.js";
import { SandboxHost } from "../src/solari/sandboxHost.js";
import { BrowserPool, matchDomHint } from "../src/solari/browserPool.js";
import { proposeAffordances } from "../src/vision/gemini.js";
import { dHash, textDigest } from "../src/perception/stateId.js";

const m = loadManifest("examples/target-shop/carto.target.json");
const host = new SandboxHost();
const pool = new BrowserPool(host, m);
const results: Record<string, boolean> = {};

let done = false;
async function teardown(reason: string) {
  if (done) return;
  done = true;
  console.log(`\n[teardown: ${reason}]`);
  await pool.close();
  await host.deleteRootSnapshot();
  await host.kill();
}
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => void teardown(sig).then(() => process.exit(130)));
}

try {
  console.log("booting sandbox...");
  await host.boot(m, "examples/target-shop");
  console.log("preview:", host.previewBase);

  await pool.login();
  results["login captured storageState"] = pool.storageState !== null;

  const { ctx, page } = await pool.newContext();
  await page.goto(host.previewBase + "/", { waitUntil: "networkidle" });

  const obs = await pool.observe(page);
  console.log(`\ntitle: "${obs.title}"`);
  console.log(`url:   ${obs.url}`);
  console.log(`dom hints: ${obs.doms.length}`);
  console.log(`visible text starts: ${JSON.stringify(obs.visible.slice(0, 70))}`);

  results["reached dashboard, not login"] = !obs.url.includes("/login");
  results["title looks like the app"] = /cartographer|dashboard|admin/i.test(obs.title);
  results["3+ dom hints"] = obs.doms.length >= 3;
  results["screenshot is a PNG"] = obs.png.subarray(1, 4).toString() === "PNG";

  const phash = await dHash(obs.png);
  console.log(`phash: ${phash}  domDigest: ${textDigest(obs.visible).slice(0, 12)}`);
  results["phash is 16 hex"] = /^[0-9a-f]{16}$/.test(phash);

  // --- Principle 3: the outside world must be unreachable ---
  // Run in a THROWAWAY context: a blocked navigation parks the page on
  // chrome-error://chromewebdata/, and the next goto in that same page races
  // against the error navigation still settling ("interrupted by another
  // navigation"). Isolating it keeps the main context usable.
  {
    const probe = await pool.newContext();
    let blocked = false;
    try {
      await probe.page.goto("https://example.com", {
        waitUntil: "domcontentloaded",
        timeout: 8000,
      });
    } catch (err) {
      blocked = /blockedbyclient|ERR_|aborted|net::/i.test(String((err as Error)?.message));
    }
    results["external host is blocked"] = blocked;
    console.log(`\nexternal navigation blocked: ${blocked}`);
    await probe.ctx.close();
  }

  // --- vision + coordinate click on a real page ---
  await page.goto(host.previewBase + "/orders/1", { waitUntil: "networkidle" });
  const detail = await pool.observe(page);
  const affs = await proposeAffordances(detail.png, {
    stateId: "s_verify0000",
    width: m.viewport.width,
    height: m.viewport.height,
    title: detail.title,
  });
  console.log(`\nvision on /orders/1: ${affs.length} affordances`);

  const withDom = affs.filter((a) => matchDomHint(a.bbox, detail.doms));
  console.log(`matched to a DOM element: ${withDom.length}/${affs.length}`);
  results["vision found affordances"] = affs.length > 0;
  // Guard against a vacuous pass: 0 >= ceil(0/2) is true but proves nothing.
  results["vision boxes align with real DOM elements"] =
    affs.length > 0 && withDom.length >= Math.ceil(affs.length / 2);

  const refund = affs.find((a) => /refund/i.test(a.label));
  results["found Refund affordance"] = !!refund;
  if (refund) {
    const cx = refund.bbox.x + refund.bbox.w / 2;
    const cy = refund.bbox.y + refund.bbox.h / 2;
    const hint = matchDomHint(refund.bbox, detail.doms);
    console.log(`clicking "${refund.label}" at ${Math.round(cx)},${Math.round(cy)}`);
    console.log(`  nearest DOM element: <${hint?.tag}> "${hint?.text}"`);

    const before = await host.digest();
    await pool.clickAt(page, cx, cy);
    const after = await host.digest();
    const post = await pool.observe(page);

    console.log(`  url now: ${post.url}`);
    console.log(`  digest changed: ${before !== after}`);
    results["coordinate click mutated the database"] = before !== after;
    writeFileSync("vision-overlay.png", post.png);

    const ms = await host.revertToRoot();
    console.log(`  reverted in ${ms}ms`);
    results["revert restored root after click"] = (await host.digest()) === host.rootDigest;
  }

  await ctx.close();

  console.log("\n--- checks ---");
  for (const [name, pass] of Object.entries(results)) {
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  }
  console.log(`browser relaunches: ${pool.relaunches}`);
  const allPass = Object.values(results).every(Boolean);
  console.log(`\n${allPass ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"}`);
  await teardown("done");
  process.exit(allPass ? 0 : 1);
} catch (err) {
  console.error("\nERROR:", (err as Error)?.message ?? err);
  await teardown("error");
  process.exit(1);
}
