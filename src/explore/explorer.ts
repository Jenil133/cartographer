import path from "node:path";
import { config } from "../config.js";
import { log } from "../log.js";
import { MapStore, nextEdgeId } from "../map/store.js";
import { dHash, resolveState, stateIdFor, textDigest } from "../perception/stateId.js";
import { BrowserPool, matchDomHint, type Observation } from "../solari/browserPool.js";
import { SandboxHost } from "../solari/sandboxHost.js";
import { BudgetTracker, zeroSpent } from "../util/budget.js";
import { proposeAffordances } from "../vision/gemini.js";
import { Frontier } from "./frontier.js";
import type { Edge, MapDoc, RunMeta, StateNode, TargetManifest } from "../types.js";

/** Same shape as proposeAffordances, so it can be swapped without touching callers. */
export type VisionFn = typeof proposeAffordances;

export interface ExploreOptions {
  resume: boolean;
  maxActions?: number;
  keepSnapshot?: boolean;
  /**
   * Override the affordance source. Defaults to Gemini. Injecting a stub lets the
   * loop (BFS, mutation detection, revert, persistence) be exercised against real
   * infrastructure without spending vision quota.
   */
  vision?: VisionFn;
}

export interface ExploreResult {
  doc: MapDoc;
  run: RunMeta;
  mapPath: string;
}

type Page = Awaited<ReturnType<BrowserPool["newContext"]>>["page"];

export async function explore(
  m: TargetManifest,
  opts: ExploreOptions,
): Promise<ExploreResult> {
  const vision: VisionFn = opts.vision ?? proposeAffordances;
  const store = new MapStore(path.join(config.CARTO_MAPS_DIR, m.name));
  const doc = (opts.resume && store.load()) || store.init(m);

  const run: RunMeta = {
    id: "r_" + new Date().toISOString().replace(/[-:.TZ]/g, ""),
    startedAt: new Date().toISOString(),
    targetName: m.name,
    mode: "sandbox",
    budget: { ...m.budget, maxActions: opts.maxActions ?? m.budget.maxActions },
    spent: zeroSpent(),
    notes: [],
  };
  doc.runs.push(run);

  const budget = new BudgetTracker(run.budget, run.spent);
  const host = new SandboxHost();
  const pool = new BrowserPool(host, m);

  // An orphaned VM bills until its idle timeout, so teardown must survive Ctrl-C.
  let tornDown = false;
  const teardown = async () => {
    if (tornDown) return;
    tornDown = true;
    run.finishedAt = new Date().toISOString();
    budget.setMinutes(host.sandboxMinutes, pool.browserMinutes);
    store.save(doc);
    await pool.close();
    if (!opts.keepSnapshot) await host.deleteRootSnapshot();
    await host.kill();
  };
  const onSignal = () => void teardown().then(() => process.exit(130));
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, onSignal);

  /** Turn an observation into a known state, creating and expanding it if new. */
  async function observeAndRegister(
    obs: Observation,
    pathFromRoot: string[],
  ): Promise<StateNode> {
    const urlPath = new URL(obs.url).pathname;
    const phash = await dHash(obs.png);
    const domDigest = textDigest(obs.visible);

    const existing = resolveState({ urlPath, phash, domDigest }, doc.states);
    if (existing) return existing;

    const id = stateIdFor(urlPath, domDigest);
    const node: StateNode = {
      id,
      kind: "web",
      url: obs.url,
      urlPath,
      title: obs.title,
      phash,
      domDigest,
      screenshot: store.writeShot(id, obs.png),
      affordances: [],
      pathFromRoot,
      discoveredInRun: run.id,
    };
    doc.states[id] = node;
    budget.note("states");

    if (budget.spent.visionCalls < run.budget.maxVisionCalls) {
      budget.note("visionCalls");
      node.affordances = await vision(obs.png, {
        stateId: id,
        width: m.viewport.width,
        height: m.viewport.height,
        title: obs.title,
      });
      // DOM hints are metadata only; they never decide or execute an action.
      for (const a of node.affordances) {
        const hint = matchDomHint(a.bbox, obs.doms);
        if (hint) a.dom = hint;
      }
      if (node.affordances.length === 0) {
        run.notes.push(`no affordances proposed for ${id} (${urlPath})`);
      }
    } else {
      run.notes.push(`vision budget exhausted before expanding ${id}`);
    }

    log.info(
      { stateId: id, urlPath, affordances: node.affordances.length },
      "new state",
    );
    return node;
  }

  /**
   * Put the browser on state S. Navigating by URL is enough for most states;
   * when it is not, replay the click path from the root. Replay is deterministic
   * because the world has been reverted to the root digest.
   */
  async function reach(page: Page, S: StateNode): Promise<boolean> {
    await page.goto(S.url, { waitUntil: "networkidle" });
    const obs = await pool.observe(page);
    const resolved = resolveState(
      {
        urlPath: new URL(obs.url).pathname,
        phash: await dHash(obs.png),
        domDigest: textDigest(obs.visible),
      },
      doc.states,
    );
    if (resolved?.id === S.id) return true;
    if (S.pathFromRoot.length === 0) return false;

    await page.goto(host.previewBase + "/", { waitUntil: "networkidle" });
    for (const edgeId of S.pathFromRoot) {
      const e = doc.edges.find((x) => x.id === edgeId);
      if (!e) return false;
      await pool.clickAt(page, e.action.x, e.action.y);
    }
    const after = await pool.observe(page);
    const again = resolveState(
      {
        urlPath: new URL(after.url).pathname,
        phash: await dHash(after.png),
        domDigest: textDigest(after.visible),
      },
      doc.states,
    );
    return again?.id === S.id;
  }

  try {
    log.info({ target: m.name }, "booting sandbox");
    await host.boot(m, m.source.type === "local" ? m.source.dir : undefined);
    run.sandboxId = host.id;
    run.rootSnapshotId = host.rootSnapshotId;
    run.rootDigest = host.rootDigest;
    store.save(doc);

    await pool.login();

    // Root state
    if (!doc.rootStateId) {
      const { ctx, page } = await pool.newContext();
      try {
        await page.goto(host.previewBase + "/", { waitUntil: "networkidle" });
        const root = await observeAndRegister(await pool.observe(page), []);
        doc.rootStateId = root.id;
        store.save(doc);
      } finally {
        await ctx.close();
      }
    }

    const frontier = Frontier.fromMap(doc, m.blocklist);
    log.info({ frontier: frontier.size() }, "starting exploration");

    while (frontier.size() > 0 && budget.canAct()) {
      const item = frontier.pop();
      if (!item) break;
      const S = doc.states[item.stateId];
      const A = S?.affordances.find((a) => a.id === item.affordanceId);
      if (!S || !A) continue;

      const t0 = Date.now();
      const { ctx, page } = await pool.newContext();
      try {
        // The world must be at root before every episode, or the edge is a lie.
        if ((await host.digest()) !== host.rootDigest) {
          run.notes.push("world drifted before episode; reverting");
          await host.revertToRoot();
          budget.note("reverts");
        }

        if (!(await reach(page, S))) {
          A.status = "failed";
          A.skipReason = "could not reach state";
          run.notes.push(`could not reach ${S.id} for ${A.id}`);
          continue;
        }

        const edgeId = nextEdgeId(doc);
        const before = await pool.observe(page);
        store.writeShot(`${edgeId}-before`, before.png);
        const digestBefore = host.rootDigest;

        const x = A.bbox.x + A.bbox.w / 2;
        const y = A.bbox.y + A.bbox.h / 2;
        await pool.clickAt(page, x, y);
        budget.note("actions");

        const after = await pool.observe(page);
        store.writeShot(`${edgeId}-after`, after.png);

        const digestAfter = await host.digest();
        const mutated = digestAfter !== digestBefore;

        const T = await observeAndRegister(after, [...S.pathFromRoot, edgeId]);

        let reverted = false;
        if (mutated) {
          const ms = await host.revertToRoot();
          reverted = true;
          budget.note("reverts");
          run.notes.push(`revert ${edgeId} took ${ms}ms`);
          log.info({ edgeId, ms, label: A.label }, "mutation reverted");
        }

        const edge: Edge = {
          id: edgeId,
          from: S.id,
          to: T.id,
          action: {
            kind: "click",
            x: Math.round(x),
            y: Math.round(y),
            label: A.label,
            affordanceId: A.id,
          },
          mutated,
          reverted,
          digestBefore,
          digestAfter,
          evidence: {
            before: `shots/${edgeId}-before.png`,
            after: `shots/${edgeId}-after.png`,
          },
          durationMs: Date.now() - t0,
          ts: new Date().toISOString(),
          runId: run.id,
        };
        doc.edges.push(edge);
        A.status = "explored";

        for (const a of T.affordances) {
          frontier.push({ stateId: T.id, affordanceId: a.id }, a);
        }
      } catch (err) {
        const msg = String((err as Error)?.message ?? err).slice(0, 200);
        A.status = "failed";
        A.skipReason = msg;
        run.notes.push(`episode error ${A.id}: ${msg}`);
        log.warn({ affordanceId: A.id, err: msg }, "episode failed");
        if (/disconnected|target closed|closed/i.test(msg)) {
          await pool.close();
          run.notes.push("browser relaunch after disconnect");
        }
      } finally {
        try {
          await ctx.close();
        } catch {
          /* context may already be gone */
        }
        store.save(doc);
      }
    }

    const why = budget.exhaustedReason();
    if (why) run.notes.push(`budget exhausted: ${why}`);
    log.info({ states: Object.keys(doc.states).length, edges: doc.edges.length }, "exploration finished");
  } finally {
    for (const sig of ["SIGINT", "SIGTERM"] as const) process.off(sig, onSignal);
    await teardown();
  }

  return { doc, run, mapPath: store.mapPath };
}
