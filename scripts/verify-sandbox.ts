/**
 * Step 6 verification against the real Solari API.
 *
 *   npx tsx scripts/verify-sandbox.ts [revertCycles]
 *
 * Boots the sample app in a sandbox, proves the preview URL works, mutates the
 * database through it, and measures how long revert() takes to put the world
 * back. Reports p50 over N cycles.
 *
 * Always kills the VM: an orphan bills until its idle timeout.
 */
import { loadManifest } from "../src/manifest.js";
import { SandboxHost } from "../src/solari/sandboxHost.js";

const CYCLES = Number(process.argv[2] ?? 5);
const m = loadManifest("examples/target-shop/carto.target.json");
const host = new SandboxHost();

let killed = false;
async function teardown(reason: string) {
  if (killed) return;
  killed = true;
  console.log(`\n[teardown: ${reason}]`);
  await host.deleteRootSnapshot();
  await host.kill();
}
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void teardown(sig).then(() => process.exit(130));
  });
}

const ok = (b: boolean) => (b ? "PASS" : "FAIL");
const results: Record<string, boolean> = {};
const revertMs: number[] = [];

try {
  console.log("booting sandbox (install + start can take a few minutes)...");
  const tBoot = Date.now();
  await host.boot(m, "examples/target-shop");
  const bootSec = ((Date.now() - tBoot) / 1000).toFixed(1);
  console.log(`booted in ${bootSec}s  sandbox=${host.id}`);
  console.log(`preview: ${host.previewBase}  token=${host.previewToken ? "yes" : "none"}`);

  // 1. health through the preview URL
  const health = await fetch(host.previewBase + "/health", { headers: host.previewHeaders() });
  const healthBody = (await health.text()).trim();
  results["/health returns ok"] = health.ok && healthBody === "ok";
  console.log(`\nhealth: HTTP ${health.status} "${healthBody}"`);

  // 2. digest shape
  results["digest is 64 hex"] = /^[0-9a-f]{64}$/.test(host.rootDigest);
  results["snapshot id present"] = typeof host.rootSnapshotId === "string" && host.rootSnapshotId.length > 0;
  console.log(`root digest:   ${host.rootDigest}`);
  console.log(`root snapshot: ${host.rootSnapshotId}`);

  // 3. reads must not move the digest
  const jar = await login();
  for (const path of ["/", "/orders", "/orders/3", "/customers"]) {
    await fetch(host.previewBase + path, { headers: { ...host.previewHeaders(), cookie: jar } });
  }
  const afterReads = await host.digest();
  results["reads leave digest unchanged"] = afterReads === host.rootDigest;
  console.log(`\nafter 4 reads: ${afterReads === host.rootDigest ? "unchanged" : "CHANGED"}`);

  // 4. revert cycles
  console.log(`\nrunning ${CYCLES} mutate -> revert cycles...`);
  for (let i = 1; i <= CYCLES; i++) {
    const res = await fetch(host.previewBase + `/orders/${i}/refund`, {
      method: "POST",
      headers: { ...host.previewHeaders(), cookie: jar },
      redirect: "manual",
    });
    const mutated = await host.digest();
    const didMutate = mutated !== host.rootDigest;

    const ms = await host.revertToRoot();
    revertMs.push(ms);
    const restored = (await host.digest()) === host.rootDigest;

    console.log(
      `  ${i}. refund HTTP ${res.status} | mutated=${didMutate} | revert ${ms}ms | restored=${restored}`,
    );
    results[`cycle ${i} mutated then restored`] = didMutate && restored;
  }

  const sorted = [...revertMs].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length / 2)] ?? 0;
  console.log(
    `\nrevert ms: min=${sorted[0]} p50=${p50} max=${sorted[sorted.length - 1]} (n=${sorted.length})`,
  );
  console.log(`sandbox minutes: ${host.sandboxMinutes.toFixed(2)}`);

  console.log("\n--- checks ---");
  for (const [name, pass] of Object.entries(results)) {
    console.log(`${ok(pass)}  ${name}`);
  }
  const allPass = Object.values(results).every(Boolean);
  console.log(`\n${allPass ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"}`);
  await teardown("done");
  process.exit(allPass ? 0 : 1);
} catch (err) {
  console.error("\nERROR:", (err as Error)?.message ?? err);
  await teardown("error");
  process.exit(1);
}

/**
 * Log in through the preview URL and return every cookie to replay.
 *
 * The preview gateway sits behind an AWS ALB which sets its own AWSALB /
 * AWSALBCORS cookies alongside Flask's `session`. headers.get("set-cookie")
 * returns only the FIRST of them, so grabbing that silently yields the load
 * balancer cookie and every later request is unauthenticated - a 302 to /login
 * that looks like a successful redirect. Use getSetCookie() and send them all.
 */
async function login(): Promise<string> {
  const res = await fetch(host.previewBase + "/login", {
    method: "POST",
    headers: {
      ...host.previewHeaders(),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "username=admin&password=admin",
    redirect: "manual",
  });
  const all = res.headers.getSetCookie();
  const jar = all.map((c) => c.split(";")[0]).join("; ");
  if (!all.some((c) => c.startsWith("session="))) {
    throw new Error(`login did not set a Flask session cookie; got: ${all.map((c) => c.split("=")[0]).join(", ")}`);
  }
  return jar;
}
