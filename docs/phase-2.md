# CARTOGRAPHER — PHASE 2: Core Value Build (CLI, MCP, Live Mode, Solver + Benchmark)

> You are the builder. You have ONLY this file. It contains everything you need: project context, architecture, the exact current state of the code, data model, and step-by-step instructions. Do not assume any prior conversation. If something is marked ⚠️ verify, check it against the live docs/package before relying on it.

---

## 1. Project & Challenge Context

### The challenge (ground truth)
- **Who:** Pinetree Research (Palo Alto AI lab, ~6 people) is hiring one remote SWE intern ("$300K annualized") via a public build challenge run by Harry Chow (Head of Growth & Ops, X `@harrychow_`). Pinetree builds **pure-vision computer-use agents** (screen/keyboard/mouse; explicitly not DOM/API-based) and states its architecture is "a general reasoning engine + a specialized world model."
- **Their product we build on:** **Solari** (getsolari.com) — cloud infra for agents behind one API key `slr_live_…` and base URL `https://api.getsolari.com`: **cloud browsers** (Playwright-shaped; stealth/proxies/captcha on paid plans; session recording), **sandboxes** (headless Linux microVMs: commands, files, git, port preview URLs, **snapshot / revert / fork**), **desktops** (microVM + X display + VNC; mouse/keyboard/screenshot API).
- **Rules:** fork `https://github.com/solari-sdk/solari-cookbook`, build "a real use case" with Solari, publish on public GitHub (standalone repo + a copy inside the fork is officially fine), post on X/LinkedIn tagging `@harrychow_` and `@getsolari`. Judged on: **product-market fit, real users, building in public.** ~500 submissions. **No deadline announced; it can be announced any day** → this phase ends with a public v0 launch post.
- **The field:** ~1/3 of entries are "QA for AI-generated code". Almost nobody uses snapshot/revert as an agent primitive or the desktop primitive. Nobody builds world models.

### The product: Cartographer
**One-liner:** *Build a map of any app before your agent touches it.* Cartographer hosts a target app inside a Solari sandbox, snapshots the booted world, and explores every clickable path **vision-first** (screenshot → Gemini proposes affordances → click by coordinates). Any action that mutates the app's data (detected by digesting the app's data files) is **undone with `revert()`** to the root snapshot, so exploring "Delete" and "Refund" is safe. Output: a **map** (states, affordances, edges, mutation flags, screenshots). **This phase makes the map useful to agents**: an MCP server answers `atlas_route(goal)` with the exact clicks to get there, and a benchmark proves an agent with the map completes tasks in fewer steps than one without.

**Why it wins:** it produces the "world model" Pinetree says agents need, using the Solari primitives nobody else uses, and is vision-first like Pinetree's agents. The benchmark number is the headline of the launch post.

**Non-negotiable principles (apply in every file you write):**
1. **Vision-first.** Which element to click is decided from the screenshot; clicks execute by coordinates. DOM data is metadata/cross-check only — never decides or executes an action.
2. **Fail-closed.** No state without a screenshot; no edge without evidence; uncertain = `unknown`, never success.
3. **No external side effects.** Sandbox mode: browser network allowlisted to the preview host. Live mode: all non-GET requests aborted.
4. **Every mutation is reverted** (sandbox mode). Live mode cannot revert, so it blocks writes instead and says so in the data.
5. **Everything is measured.** Spend and counts are in `map.json`; benchmark results are files with exact numbers.

### Phase arc (700 engineering hours total, solo)
- **Phase 1 (done, ~110 h):** scaffold, sample target app, sandbox host with snapshot/revert, cloud browser pool, Gemini affordances, BFS explorer, `map.json` + screenshots, static viewer.
- **Phase 2 (this file, ~250 h):** `init` for arbitrary repos/URLs, npm-publishable CLI, MCP server (`atlas_*`), path search, live-URL read-only mode, solver agent + with/without-map benchmark, maps of ≥ 2 real OSS apps, README/docs, v0 launch post draft.
- **Phase 3 (~250 h):** desktop (screenshot-only) mode, parallel forks, hosted maps site, demo path, cookbook fork/PR, bug reports, submission.

---

## 2. Architecture Overview

```
 ┌────────────┐  carto.target.json   ┌──────────────────────────────────┐
 │ CLI        │ ───────────────────▶ │ Explorer: BFS over (state, aff.) │
 │ init/explore│                     │ budget · frontier · dedupe       │
 │ route/mcp  │                      │ mode: sandbox | live             │
 │ bench/view │                      └────┬─────────────┬────────────┬─┘
 └─────┬──────┘           ┌───────────────▼───┐  ┌──────▼───────┐ ┌──▼──────────┐
       │                  │ SandboxHost       │  │ BrowserPool  │ │ Vision      │
       │                  │ boot app · digest │◀─│ Solari cloud │ │ Gemini:     │
       │                  │ snapshot · revert │  │ Chrome       │ │ screenshot →│
       │                  │ previewUrl(port)  │─▶│ click / shot │ │ affordances │
       │                  │ (absent in live)  │  │ (stealth in  │ │ next-action │
       │                  └───────────────────┘  │  live mode)  │ │ (solver)    │
       │                                         └──────┬───────┘ └─────────────┘
       │                                                ▼
       │                                  ┌──────────────────────────┐
       │                                  │ MapStore maps/<name>/    │
       │                                  │ map.json · shots/*.png   │
       │                                  └──────┬───────────────────┘
       │                       ┌─────────────────┼──────────────────┐
       ▼                       ▼                 ▼                  ▼
 ┌────────────┐   ┌────────────────────┐  ┌─────────────┐  ┌─────────────────────┐
 │ Viewer     │   │ Graph: shortest    │  │ MCP server  │  │ Solver + Bench       │
 │ (static)   │   │ path, goal→state   │  │ atlas_*     │  │ naive vs with-map    │
 │ + routes   │   │ (lexical + Gemini) │  │ (stdio)     │  │ → bench/results/*.json│
 └────────────┘   └────────────────────┘  └─────────────┘  └─────────────────────┘
```

**Exploration episode (unchanged from Phase 1, sandbox mode):** pop `(state, affordance)` → ensure world at root digest (else revert) → reach state (navigate; replay path if needed) → screenshot → click at bbox center → observe → resolve/create state → digest → if changed: mark mutated, revert → persist edge → push new affordances.

**Live mode (new):** same loop, but no SandboxHost: `previewBase` = target URL origin, no digest, no revert; `ctx.route` aborts every request whose method ≠ GET (forms can't submit) and every request to a different origin than the target (no third-party side effects). Edges get `mutationMode: "blocked-writes"`, `mutated: false`, `digestBefore/After: ""`. Stealth browser is used because public sites block datacenter Chrome.

**Route answering (new):** `atlas_route(goal)` → pick goal state (lexical search over titles/urlPaths/affordance labels; Gemini rerank when ambiguous) → BFS shortest path in the edge graph from `fromState` (default root) → return ordered `RouteStep[]` with coordinates and mutation warnings.

**Solver + benchmark (new):** a deliberately simple vision agent (screenshot + goal → next click) runs each task twice: `naive` (no map) and `with-map` (the route is injected as a hint). Success is checked inside the sandbox (a command that inspects the DB). The sandbox is reverted to root between tasks. Result: steps, vision calls, seconds, success per condition.

---

## 3. Current State (what exists at the start of this phase)

Repository `cartographer/` (npm package `solari-cartographer`, ESM, Node 22, TypeScript strict). All of the following exist and work:

- `src/config.ts` — zod-validated env: `SOLARI_API_KEY`, `SOLARI_BASE_URL`, `GEMINI_API_KEY`, `GEMINI_MODEL` (default `gemini-3.7-flash`; confirm current id at ai.google.dev/gemini-api/docs/models), `CARTO_MAPS_DIR` (`./maps`), `LOG_LEVEL`. Exposes `config`.
- `src/log.ts` — pino `log`.
- `src/types.ts` — all shared types (reproduced in §7).
- `src/manifest.ts` — `loadManifest(path): TargetManifest` (zod; defaults for blocklist/viewport/budget).
- `src/util/hash.ts` (`sha256`, `sha10`), `src/util/sleep.ts` (`sleep`, `withTimeout`, `retry`), `src/util/budget.ts` (`BudgetTracker { spent, canAct(), note(kind, n) }`).
- `src/perception/stateId.ts` — `dHash(png)`, `hamming(a,b)`, `textDigest(text)`, `stateIdFor(urlPath, domDigest)`, `resolveState(obs, states)` (same urlPath + hamming ≤ 6).
- `src/vision/gemini.ts` — `proposeAffordances(png, {stateId,width,height,title}) → Affordance[]` via `@google/genai` structured JSON.
- `src/solari/sandboxHost.ts` — `class SandboxHost { boot(m, localDir?), runLong(cmd, ms), startServer(m), refreshPreview(port), waitReady(path, ms), digest(paths), revertToRoot(m) → ms, kill(); fields id, previewBase, previewToken, rootSnapshotId, rootDigest }`. Uses `@solarisdk/sandbox` `SandboxClient` (`create`, `list`, `kill`, `deleteSnapshot`) and the `Sandbox` handle.
- `src/solari/browserPool.ts` — `class BrowserPool { constructor(host, manifest); login(); newContext() → {ctx, page}; observe(page) → {png, visible, doms, url, title}; clickAt(page, x, y); close() }`. Uses `@solarisdk/browser` `Solari.launch()`. Network allowlisted to `host.previewBase` with `x-pinetree-preview-token` header via `ctx.route`.
- `src/explore/frontier.ts` — `Frontier { push, pop, size, static fromMap(doc, blocklist) }`.
- `src/explore/explorer.ts` — `explore(manifest, {resume, maxActions})` implementing the episode loop; helpers `observeAndRegister`, `reach`.
- `src/map/store.ts` — `MapStore { load(), init(target), save(doc) (atomic), shotPath(name), writeShot(name, png) }`, `nextEdgeId(doc)`.
- `src/cli.ts` — `explore <manifest> [--max-actions] [--resume]`, `view [mapDir]` (serves `viewer/index.html` + map dir on :4173).
- `viewer/index.html` — Cytoscape graph, red dashed mutated edges, screenshot hover.
- `examples/target-shop/` — Flask + sqlite admin app (login admin/admin, orders with Refund/Delete, customers, settings Save; `/health`), `carto.target.json` manifest (`source.type: "local"`).
- `scripts/e2e-explore.ts` — real-API integration run; `test/*.test.ts` — unit tests (vitest) for perception, frontier, store.
- `maps/target-shop/map.json` exists from Phase 1 runs (≥ 8 states, ≥ 1 `mutated && reverted` edge).
- `NOTES.md` — measured revert latency, SDK name adaptations, Solari bugs hit.

Known facts recorded in Phase 1 that you must keep respecting: sandbox commands need `sh -c`; `connect()` before files/git; exec cap ~28 s → `runLong` (nohup + poll); `kill()` not `close()`; preview token goes in a header on every request; browser sessions may die ~10 min after creation → relaunch on demand; Solari `newPage()` opens a fresh context → always `newContext({storageState})`.

---

## 4. Phase Goal & Scope

**Goal:** Cartographer becomes a tool other developers can install and use: `npx solari-cartographer init <repo|url>` → `explore` → `mcp` gives any agent `atlas_route`. A published benchmark shows the with-map condition beats naive on the sample app and on ≥ 1 real OSS app. ≥ 2 real OSS app maps exist. README and a v0 launch post draft are ready.

**In scope**
1. `init` command: manifest generation for repo/URL targets (heuristics + prompts).
2. Live-URL read-only mode (no sandbox; blocked writes; stealth browser).
3. Graph module: shortest path, goal → state selection (lexical + Gemini rerank), `Route` type.
4. MCP server (stdio) with `atlas_list_maps`, `atlas_map_summary`, `atlas_find_state`, `atlas_route`, `atlas_affordances`, `atlas_state_screenshot`.
5. Solver agent (vision-only next-action loop) + benchmark runner + task files + results writer + markdown report.
6. Viewer: highlight a route; show mutation warnings; per-run stats.
7. npm packaging (`bin`, `files`, `npm pack` smoke test), `README.md`, `docs/` (getting started, manifest reference, MCP tools, benchmark method), `docs/POST-v0.md` launch draft.
8. Maps of ≥ 2 real OSS apps committed under `maps/` (JSON + screenshots, or JSON + a zip if screenshots exceed 30 MB).
9. Unit tests for graph/route/solver-parsing; integration test for MCP over stdio; benchmark run on the sample app.

**Out of scope (do NOT build here)**
- Desktop mode, parallel forks, hosted maps website, GitHub Pages, cookbook fork/PR, bug-report write-ups, submission posts (Phase 3).
- Typing/keyboard affordances in exploration (`kind: "type"`) — exploration remains click-only. (The solver may type when the task requires it; see Step 9.)
- Any persistence beyond JSON files; any web backend.

---

## 5. Prerequisites & Setup

- Everything from Phase 1 installed and working (`npm test`, `npm run e2e` pass). Solari **Starter** plan (stealth is required for live mode; Free plan has none). Gemini API key.
- Additional dependencies:
```bash
npm i @modelcontextprotocol/sdk minisearch
npm i -D @types/node
```
**Verified (2026-09-07):** two supported lines exist. v1: `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`, `StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js`, `server.registerTool(name, { title, description, inputSchema: { a: z.number() } }, handler)` (zod shape). v2: packages `@modelcontextprotocol/server` (+ `/stdio`) with `inputSchema: z.object(...)` from `zod/v4`. Use whichever is current on npm; `server.tool()` is deprecated — use `registerTool`. Handler returns `{ content: [{ type: "text", text }] }`; image blocks are `{ type: "image", data, mimeType }`.
- `.env` unchanged from Phase 1. New optional env: `CARTO_BENCH_DIR` (default `./bench/results`).
- `package.json` additions:
```json
{
  "bin": { "cartographer": "dist/cli.js", "solari-cartographer": "dist/cli.js" },
  "files": ["dist", "viewer", "README.md", "LICENSE"],
  "scripts": {
    "build": "tsc -p . && chmod +x dist/cli.js",
    "mcp": "tsx src/cli.ts mcp",
    "bench": "tsx src/cli.ts bench",
    "test:mcp": "tsx scripts/mcp-smoke.ts",
    "pack:test": "npm run build && npm pack --dry-run"
  }
}
```
`dist/cli.js` must start with `#!/usr/bin/env node` (add a banner via `tsc` is not possible — put the shebang as the first line of `src/cli.ts`; `tsc` preserves it).

---

## 6. File Structure for This Phase

```
cartographer/
├── package.json                      MODIFIED (bin, files, scripts, deps)
├── README.md                         MODIFIED (full product README)
├── docs/
│   ├── getting-started.md            NEW
│   ├── manifest.md                   NEW  (TargetManifest reference)
│   ├── mcp-tools.md                  NEW
│   ├── benchmark.md                  NEW  (method + latest results table)
│   └── POST-v0.md                    NEW  (launch post draft, X + LinkedIn + Discord #showcase)
├── src/
│   ├── types.ts                      MODIFIED (source url, mutationMode, Route, Bench types)
│   ├── manifest.ts                   MODIFIED (url source, live defaults)
│   ├── cli.ts                        MODIFIED (init, route, mcp, bench; explore --mode)
│   ├── init/
│   │   └── detect.ts                 NEW  repo/url heuristics → manifest draft
│   ├── solari/
│   │   ├── sandboxHost.ts            (unchanged)
│   │   ├── liveHost.ts               NEW  Host interface impl with no sandbox
│   │   ├── host.ts                   NEW  `Host` interface shared by both
│   │   └── browserPool.ts            MODIFIED (live-mode route policy, stealth flag, typing helper)
│   ├── explore/
│   │   ├── explorer.ts               MODIFIED (Host abstraction; live-mode edge fields)
│   │   └── frontier.ts               (unchanged)
│   ├── map/
│   │   ├── store.ts                  MODIFIED (listMaps, loadByName)
│   │   ├── graph.ts                  NEW  adjacency, BFS shortest path
│   │   └── goal.ts                   NEW  goal text → state selection
│   ├── mcp/
│   │   └── server.ts                 NEW  stdio MCP server, atlas_* tools
│   ├── solve/
│   │   ├── solver.ts                 NEW  vision-only next-action agent
│   │   └── prompts.ts                NEW  solver prompts (naive / with-map)
│   ├── bench/
│   │   ├── runner.ts                 NEW  runs tasks × conditions, reverts between
│   │   └── report.ts                 NEW  JSON → markdown table
│   └── vision/
│       └── gemini.ts                 MODIFIED (nextAction, rerankStates)
├── viewer/index.html                 MODIFIED (route highlight, warnings, stats)
├── bench/
│   ├── tasks/target-shop.json        NEW
│   └── results/                      NEW (gitignored except *.md summaries)
├── examples/
│   ├── target-shop/                  (unchanged)
│   └── manifests/                    NEW  manifests for real OSS apps you map
├── scripts/
│   ├── e2e-explore.ts                (unchanged)
│   ├── mcp-smoke.ts                  NEW  spawns server over stdio, calls tools
│   └── e2e-live.ts                   NEW  live-mode run on a safe public site
└── test/
    ├── graph.test.ts                 NEW
    ├── goal.test.ts                  NEW
    ├── solverParse.test.ts           NEW
    └── (Phase 1 tests unchanged)
```

---

## 7. Data Model / Schema

`src/types.ts` — full definition after this phase. Lines marked `// P2` are new; everything else is unchanged from Phase 1 and must not be renamed.

```ts
export type Bbox = { x: number; y: number; w: number; h: number };
export type ActionKind = "click" | "type" | "press" | "navigate";
export type Risk = "read" | "write" | "unknown";

export interface DomHint { tag: string; text: string; selectorHint: string; bbox: Bbox; href?: string; }

export interface Affordance {
  id: string; stateId: string; label: string; kind: ActionKind; bbox: Bbox;
  expected: string; risk: Risk; dom?: DomHint;
  status: "pending" | "explored" | "skipped" | "failed"; skipReason?: string;
}

export interface StateNode {
  id: string; kind: "web" | "desktop";
  url: string; urlPath: string; title: string;
  phash: string; domDigest: string; screenshot: string;
  affordances: Affordance[]; pathFromRoot: string[]; discoveredInRun: string;
}

export interface EdgeAction { kind: ActionKind; x: number; y: number; label: string; text?: string; key?: string; affordanceId: string; }

export interface Edge {
  id: string; from: string; to: string; action: EdgeAction;
  mutated: boolean; reverted: boolean; digestBefore: string; digestAfter: string;
  evidence: { before: string; after: string; replayUrl?: string };
  durationMs: number; ts: string; runId: string;
  mutationMode?: "digest" | "blocked-writes";      // P2: "digest" in sandbox mode, "blocked-writes" in live mode
}

export interface Budget { maxActions: number; maxStates: number; maxVisionCalls: number; maxMinutes: number; }
export interface Spent { actions: number; states: number; visionCalls: number; reverts: number; sandboxMinutes: number; browserMinutes: number; estUsd: number; }

export interface RunMeta {
  id: string; startedAt: string; finishedAt?: string; targetName: string;
  mode: "sandbox" | "live" | "desktop"; budget: Budget; spent: Spent;
  sandboxId?: string; rootSnapshotId?: string; rootDigest?: string; notes: string[];
}

export interface TargetManifest {
  name: string;
  source: { type: "repo"; repo: string; ref?: string; subdir?: string }
        | { type: "local"; dir: string }
        | { type: "url"; url: string };                                        // P2: live mode
  runtime?: { install: string[]; start: string; port: number; readyPath: string; cpu?: number; memMb?: number; diskGb?: number; }; // P2: optional (absent for url)
  dataPaths?: string[];                                                        // P2: optional (absent for url)
  login?: { url: string; steps: Array<{ fill: [string, string] } | { click: string }> };
  blocklist: string[]; viewport: { width: number; height: number }; budget: Budget;
  live?: { stealth: boolean; proxyCountry?: string; maxDepth: number; sameOriginOnly: boolean; }; // P2
}

export interface MapDoc { version: 1; target: TargetManifest; rootStateId: string | null; states: Record<string, StateNode>; edges: Edge[]; runs: RunMeta[]; updatedAt: string; }

// ---- P2: routing ----
export interface RouteStep { edgeId: string; from: string; to: string; action: EdgeAction; mutated: boolean; }
export interface Route {
  map: string; fromState: string; goalState: string; goalScore: number;   // goalScore 0..1 confidence in goal-state selection
  steps: RouteStep[]; warnings: string[];                                   // e.g. "step 3 mutates data (Refund button)"
  alternatives: Array<{ stateId: string; title: string; score: number }>;  // other candidate goal states
}

// ---- P2: benchmark ----
export interface BenchTask { id: string; goal: string; check: string; maxSteps: number; }   // check: sh command in sandbox; exit 0 = success
export interface BenchStepLog { n: number; action: { kind: "click"|"type"|"done"|"fail"; x?: number; y?: number; text?: string }; reasoning: string; stateId?: string; ms: number; }
export interface BenchResult {
  taskId: string; condition: "naive" | "with-map"; success: boolean; steps: number; visionCalls: number;
  seconds: number; estUsd: number; routeUsed?: Route; log: BenchStepLog[]; failureReason?: string;
}
export interface BenchReport { target: string; ranAt: string; results: BenchResult[]; summary: Record<"naive"|"with-map", { tasks: number; successes: number; avgSteps: number; avgVisionCalls: number; avgSeconds: number }>; }
```

**Task file format** `bench/tasks/target-shop.json`:
```json
[
  { "id": "refund-3", "goal": "Refund order #3", "check": "cd /work/app && python3 -c \"import sqlite3,sys; c=sqlite3.connect('shop.db'); sys.exit(0 if c.execute('select status from orders where id=3').fetchone()[0]=='refunded' else 1)\"", "maxSteps": 12 },
  { "id": "delete-7", "goal": "Delete order #7", "check": "cd /work/app && python3 -c \"import sqlite3,sys; c=sqlite3.connect('shop.db'); sys.exit(0 if c.execute('select count(*) from orders where id=7').fetchone()[0]==0 else 1)\"", "maxSteps": 12 },
  { "id": "settings-currency", "goal": "Change the store currency to EUR and save", "check": "cd /work/app && python3 -c \"import sqlite3,sys; c=sqlite3.connect('shop.db'); sys.exit(0 if c.execute('select currency from settings').fetchone()[0]=='EUR' else 1)\"", "maxSteps": 12 },
  { "id": "view-customer-4", "goal": "Open the detail page of customer #4", "check": "true", "maxSteps": 8 }
]
```
For `check: "true"` (navigation-only tasks) success = final observed state's `urlPath` matches the goal state chosen by `goal.ts` for the goal text.

**MCP tool I/O** — see §9.

---

## 8. Implementation Steps

### Step 1 — Types, manifest, host abstraction
1. Apply the §7 changes to `src/types.ts`.
2. `src/manifest.ts`: accept `source.type: "url"`; when `url`, require no `runtime`/`dataPaths`, default `live: { stealth: true, maxDepth: 3, sameOriginOnly: true }`; when `repo`/`local`, require `runtime` and `dataPaths`.
3. `src/solari/host.ts`:
```ts
export interface Host {
  mode: "sandbox" | "live";
  previewBase: string; previewToken: string | null;   // live: origin of target url, token null
  boot(m: TargetManifest, localDir?: string): Promise<void>;
  digest(): Promise<string>;         // live: returns "" (WHY: no ground truth → caller must treat as unknown)
  rootDigest: string;                // live: ""
  revertToRoot(): Promise<number>;   // live: throws Error("revert unsupported in live mode")
  kill(): Promise<void>;
}
```
Make `SandboxHost implements Host` (wrap `digest(m.dataPaths)` and `revertToRoot(m)` by storing `m` at boot).
`src/solari/liveHost.ts`: `LiveHost implements Host` with `boot` setting `previewBase = new URL(m.source.url).origin`.
**Verify:** `npm test` still green; `explore` on the sample still passes e2e (no behavior change in sandbox mode).

### Step 2 — BrowserPool: mode-aware route policy + stealth + typing
Modify `newContext()`:
```ts
const b = await this.ensureBrowser();      // live mode: launch({ stealth: m.live.stealth, proxy: m.live.proxyCountry ?? undefined })
await ctx.route("**/*", (route) => {
  const req = route.request(); const u = new URL(req.url());
  if (this.host.mode === "sandbox") {
    if (this.host.previewBase.includes(u.host)) return route.continue({ headers: { ...req.headers(), "x-pinetree-preview-token": this.host.previewToken! } });
    return route.abort("blockedbyclient");
  }
  // live: same-origin GET only. Principle 3 — we cannot revert, so we prevent writes.
  const sameOrigin = u.origin === this.host.previewBase;
  const allowedAssetHost = !this.m.live?.sameOriginOnly && ["document","stylesheet","script","image","font","xhr","fetch"].includes(req.resourceType());
  if (req.method() !== "GET") return route.abort("blockedbyclient");
  if (sameOrigin || allowedAssetHost) return route.continue();
  return route.abort("blockedbyclient");
});
```
Assert on launch in live mode: if `m.live.stealth` and `browser.proxy` is undefined while `proxyCountry` was requested, log a warning "proxy silently degraded" (Solari creates an unproxied session when a tier is unavailable) and write it to `run.notes`.
Add `typeAt(page, x, y, text)`: click at (x,y), `page.keyboard.type(text, { delay: 20 })`, then `page.keyboard.press("Enter")` only if `pressEnter` flag. Used by the solver only.
**Verify:** scratch script in live mode against `https://example.com`: a `fetch("/x", {method:"POST"})` from `page.evaluate` fails; GET to same origin succeeds; a request to `https://google.com` fails.

### Step 3 — Explorer: Host abstraction + live edges
- Replace `new SandboxHost()` with `host = m.source.type === "url" ? new LiveHost() : new SandboxHost()`.
- Sandbox mode unchanged. Live mode: skip the drift check (`digest()` returns ""), set `mutated: false, reverted: false, digestBefore: "", digestAfter: "", mutationMode: "blocked-writes"`; enforce `m.live.maxDepth` (skip affordances whose state `pathFromRoot.length >= maxDepth`, `skipReason: "maxDepth"`); mark affordances whose DOM hint `href` is off-origin as `skipped: "off-origin"` (metadata used for *skipping*, never for acting — this is allowed because it prevents side effects; document it in code).
- Sandbox edges get `mutationMode: "digest"`.
- Root URL for live mode = `m.source.url` (not `/`).
- Set `run.mode` accordingly.
**Verify:** `scripts/e2e-live.ts` explores `https://books.toscrape.com` (⚠️ verify still online; it is a scraping practice site) with `maxActions: 15` → ≥ 6 states, every edge `mutationMode: "blocked-writes"`, no POST ever attempted (count aborted non-GET requests via a route counter and print it).

### Step 4 — `init` command
`src/init/detect.ts`: `draftManifest(input: string): Promise<TargetManifest>`:
- If input starts with `http` → url manifest (name = hostname with dots → dashes; `live` defaults; budget 40/30/40/20).
- Else treat as GitHub repo URL or `owner/name`: fetch `https://raw.githubusercontent.com/<owner>/<repo>/HEAD/` for `package.json`, `requirements.txt`, `pyproject.toml`, `README.md` (Node `fetch`). Heuristics:
  - `requirements.txt`/`pyproject` → `install: ["cd /work/app && python3 -m pip install --user -r requirements.txt"]` (or `pip install --user .`), `start` guessed from README code blocks matching `python .*\.py|flask run|uvicorn .*|gunicorn .*` else `python3 app.py`; port guessed from README (`localhost:(\d+)`) else 8000; `readyPath: "/"`.
  - `package.json` → `install: ["cd /work/app && npm ci --omit=dev || npm install"]`, `start: "cd /work/app && npm start"` (or `scripts.dev`), port from README else 3000. Add a manifest comment field `_notes: ["base sandbox ships Node 18 — if the app needs Node >= 20, add an install step that downloads a Node 22 tarball into /work/node and prefix start with PATH=/work/node/bin:$PATH"]`.
  - `dataPaths`: any `*.db|*.sqlite|*.sqlite3|data/|db/` mentioned in README or tree; else `["/work/app"]` with `_notes` warning that digesting the whole app dir will flag log files as mutations — narrow it.
- Write to `./carto.target.json` (or `--out`), print it, and print "Edit runtime/dataPaths/login before exploring."
`cli.ts`: `init <repo-or-url> [--out <path>]`.
**Verify:** `init https://books.toscrape.com` writes a valid url manifest; `init pallets/flask` (any Python repo) writes a repo manifest that `loadManifest` accepts.

### Step 5 — Graph + goal selection
`src/map/graph.ts`:
```ts
export function adjacency(doc: MapDoc): Map<string, Edge[]> { /* from → edges (exclude self-loops) */ }
export function shortestPath(doc: MapDoc, from: string, to: string, opts?: { avoidMutations?: boolean }): Edge[] | null {
  // BFS on states; when avoidMutations, first try excluding mutated edges, then fall back including them.
}
export function reachable(doc: MapDoc, from: string): Set<string> {}
```
`src/map/goal.ts`:
```ts
export interface Candidate { stateId: string; title: string; urlPath: string; score: number; why: string }
export async function selectGoalState(doc: MapDoc, goal: string, opts: { useLlm: boolean }): Promise<{ best: Candidate; alternatives: Candidate[] }> {
  // 1) lexical: MiniSearch over documents {id, title, urlPath, labels: affordance labels joined, expected: affordance expected joined}
  //    fields weighted title 3, urlPath 2, labels 2, expected 1; fuzzy 0.2; prefix true. Normalize scores to 0..1 by dividing by top score.
  // 2) if useLlm and (top score < 0.6 or top two within 0.15): Gemini rerank — send goal + top 8 candidates (id, title, urlPath, top 6 labels) → JSON {stateId, confidence, why}. Count visionCalls? No: count as "llmCalls" in a local counter; do not touch map budget.
  // 3) return best + up to 4 alternatives.
}
```
`src/vision/gemini.ts` add `rerankStates(goal, candidates) → {stateId, confidence, why}` with a JSON schema. Extract a shared `generateJson(parts, schema)` helper used by all three Gemini functions.
Tests: `graph.test.ts` (synthetic 6-state map: shortest path length, avoidMutations preference, unreachable → null); `goal.test.ts` (lexical only: "refund order" ranks the order-detail state above the orders list; "settings" ranks the settings state first).
**Verify:** `npm test` green.

### Step 6 — `route` command
`cli.ts`: `route <mapNameOrDir> "<goal>" [--from <stateId>] [--no-llm] [--json]` → loads map, `selectGoalState`, `shortestPath` from `--from` (default `rootStateId`) → prints:
```
Goal: Refund order #3
Goal state: s_ab12… "Order #3" (/orders/3)  confidence 0.83
Route (3 steps, 1 mutation):
  1. click (412, 96)  "Orders link"        s_root → s_9f…
  2. click (300, 244) "Order #3 row link"  s_9f… → s_ab12…
  3. click (640, 520) "Refund button"      s_ab12… → s_77…   ⚠ mutates data
```
`--json` prints the `Route` object. Warnings: mutated steps; `goalScore < 0.5` → "low confidence — alternatives: …".
**Verify:** on `maps/target-shop`, `route target-shop "refund order 3"` returns a route ending in a mutated Refund edge.

### Step 7 — MCP server
`src/mcp/server.ts` (stdio). Tools (names are the contract; see §9 for schemas):
- `atlas_list_maps` → maps available under `CARTO_MAPS_DIR`.
- `atlas_map_summary(map)` → counts + root + top-level states.
- `atlas_find_state(map, {url?, description?, screenshot_base64?})` → resolves by urlPath, then phash (if screenshot given: compute dHash, hamming ≤ 10), then lexical description.
- `atlas_route(map, goal, from_state?, avoid_mutations?)` → `Route`.
- `atlas_affordances(map, state_id)` → affordances with coordinates and risk.
- `atlas_state_screenshot(map, state_id)` → image content block (PNG base64) + text with title/url.
Implementation: `McpServer({ name: "cartographer", version })`, register tools with zod shapes, return `{ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }` (image tool returns `{ type: "image", data, mimeType: "image/png" }`). Load maps lazily and cache by mtime. Never write to disk from the MCP server.
`cli.ts`: `mcp [--maps <dir>]`. Document registration in `docs/mcp-tools.md`:
```
claude mcp add cartographer -- npx -y solari-cartographer mcp --maps /abs/path/maps
```
`scripts/mcp-smoke.ts`: spawn `tsx src/cli.ts mcp`, use `@modelcontextprotocol/sdk` `Client` + `StdioClientTransport`, call `atlas_list_maps`, `atlas_route` on target-shop, assert a route with ≥ 1 step; `atlas_state_screenshot` returns an image block.
**Verify:** `npm run test:mcp` passes; in Claude Code, after `claude mcp add …`, asking "how do I refund order 3 in target-shop?" makes it call `atlas_route` and quote the steps.

### Step 8 — Solver agent (vision-only)
`src/solve/solver.ts`:
```ts
export interface SolveOpts { goal: string; maxSteps: number; hint?: Route; }
export async function solve(host: Host, pool: BrowserPool, m: TargetManifest, opts: SolveOpts): Promise<{ log: BenchStepLog[]; finalState?: StateNode; visionCalls: number; done: boolean; failReason?: string }> {
  const { ctx, page } = await pool.newContext(); await page.goto(host.previewBase + rootPath(m), { waitUntil: "networkidle" });
  const history: string[] = [];
  for (let n = 1; n <= opts.maxSteps; n++) {
    const obs = await pool.observe(page); const t0 = Date.now();
    const next = await nextAction(obs.png, { goal: opts.goal, history, hint: opts.hint && hintText(opts.hint, n), width: m.viewport.width, height: m.viewport.height });   // Gemini
    history.push(`${n}: ${next.kind} ${next.x ?? ""},${next.y ?? ""} ${next.text ?? ""} — ${next.reasoning}`);
    log.push({ n, action: next, reasoning: next.reasoning, ms: Date.now() - t0 });
    if (next.kind === "done") return { done: true, ... }; if (next.kind === "fail") return { done: false, failReason: next.reasoning, ... };
    if (next.kind === "click") await pool.clickAt(page, next.x!, next.y!); else if (next.kind === "type") await pool.typeAt(page, next.x!, next.y!, next.text!, { pressEnter: false });
  }
  return { done: false, failReason: "maxSteps", ... };
}
```
`src/vision/gemini.ts` add `nextAction(png, ctx) → { kind: "click"|"type"|"done"|"fail", x?, y?, text?, reasoning }` with a JSON schema. `src/solve/prompts.ts`:
- **naive prompt:** "You control a web app by looking at the screenshot only. Goal: … . History: … . Choose exactly one next action: click at pixel coordinates, type text into a field at coordinates, done (goal is visibly achieved), or fail. Coordinates must be inside the screenshot."
- **with-map prompt:** same + `hint`: "A map of this app suggests this route to the goal state: step k: click (x,y) '<label>' … . You are likely at step <n>. Prefer following the route; deviate only if the screenshot clearly disagrees." `hintText(route, n)` renders the full route and marks the current step.
The solver is intentionally simple — the benchmark measures the *map's* contribution, not solver cleverness. Do not add DOM access to the solver.
Test `solverParse.test.ts`: schema validation of nextAction outputs (reject off-screen coords, reject `type` without text).
**Verify:** run `solve` manually on the sample with goal "Refund order #3" in both conditions; watch step counts.

### Step 9 — Benchmark runner + report
`src/bench/runner.ts`: `runBench(m, tasksPath, opts: { conditions: ("naive"|"with-map")[]; repeats: number })`:
1. Boot `SandboxHost` (sandbox mode only — success checks need the DB), `pool.login()`.
2. Load `maps/<name>/map.json` (must exist; else exit with "explore first").
3. For each task × condition × repeat: ensure root digest (revert if drifted); for `with-map` compute `Route` via `selectGoalState` + `shortestPath(avoidMutations: false)`; `solve(...)`; run `task.check` via `host.sbx.commands.run("sh", {args:["-c", task.check]})` → `success = exitCode === 0` (for `check: "true"`, compare final `urlPath` with goal state's `urlPath`); record `BenchResult`; if the task mutated (digest ≠ root) → `revertToRoot` (count as bench overhead, not in result seconds).
4. Write `bench/results/<name>-<ts>.json` (`BenchReport`) and `bench/results/<name>-latest.md` via `report.ts` (table: task | condition | success | steps | vision calls | seconds).
`cli.ts`: `bench <manifest> [--tasks <path>] [--repeats 3] [--conditions naive,with-map]`.
Summary computed per condition: success rate, mean steps (successes only and overall), mean vision calls, mean seconds. Print the headline: "with-map: X/Y tasks in avg A steps vs naive: X'/Y in avg B steps".
**Verify:** `npm run bench examples/target-shop/carto.target.json --repeats 3` completes; results JSON validates; markdown table renders; total cost printed (< $2).

### Step 10 — Viewer upgrades
`viewer/index.html`: add a goal input → calls nothing server-side; instead `cartographer view` now also serves `GET /route?goal=…` (reusing `goal.ts` + `graph.ts` with `--no-llm` by default, `?llm=1` to enable) and the viewer highlights the returned path (thicker edges, numbered badges) and lists warnings. Show `runs[last].spent` and mode badge (sandbox/live). Screenshot panel shows before/after for the selected edge.
**Verify:** entering "refund order 3" highlights a path ending at a red edge.

### Step 11 — Real OSS targets (≥ 2 maps)
Selection rule (all must hold): runs natively on Python 3 or Node 18 in the `base` sandbox (no Docker, no Postgres); SQLite or file-based data; boots in < 2 min; ≤ 4 GB disk; has login + list/detail + at least one destructive action. Candidates to evaluate (⚠️ verify each runs on Node 18/Python 3 with SQLite before committing time): a Django-admin-based demo project (Django ships a full admin UI over SQLite — create a small project with 2 models if no suitable public repo exists, and commit it under `examples/django-admin-demo`), a Flask-Admin example app, a `gothinkster/realworld` Python/Flask or Node/Express+SQLite implementation, Wiki.js/Ghost only if a Node 22 tarball install step proves cheap. Prefer apps a reviewer recognizes.
For each: `init` → edit manifest (login steps, dataPaths pointing at the SQLite file, blocklist) → `explore --max-actions 80` → commit `maps/<name>/map.json` + screenshots (if > 30 MB, commit JSON + a `shots.zip` and add a `docs/maps.md` note). Write `bench/tasks/<name>.json` with 4 tasks for one of them and run the bench.
**Verify:** two maps committed with ≥ 20 states each and ≥ 2 reverted mutations; one bench report for a real app.

### Step 12 — Packaging, README, docs, launch draft
- `README.md`: pitch (3 sentences), the loop diagram (from §2), 60-second quickstart (`npx solari-cartographer init …` → `explore` → `route` → `mcp`), the benchmark table (from `bench/results/*-latest.md`), the measured revert latency, "how it's safe" (revert + network policy), limitations (click-only exploration, live mode blocks writes, single region), Solari features used (sandbox, snapshot/revert, preview URL, cloud browser, stealth), license MIT.
- `docs/getting-started.md`, `docs/manifest.md` (every field with defaults), `docs/mcp-tools.md` (schemas + Claude Code/Cursor registration), `docs/benchmark.md` (method: conditions, checks, repeats, caveats, exact numbers).
- `docs/POST-v0.md`: three drafts — X (≤ 280 chars + thread of 4), LinkedIn (≈ 150 words), Discord #showcase (What / Problem / Stack / Demo+repo / Feedback wanted) — all with real numbers from the bench and the map (states, reverted mutations, revert p50 ms, cost per map), tagging `@harrychow_ @getsolari`, and a request: "if you build browser agents, try `atlas_route` on your app and tell me the step count".
- `npm run pack:test` shows only `dist`, `viewer`, `README.md`, `LICENSE`; `npx ./solari-cartographer-0.2.0.tgz --help` works from an empty directory.
**Verify:** a fresh clone + `npm ci && npm run build && npm test && npm run test:mcp` passes; `npx <tgz> route maps/target-shop "refund order 3"` works.

---

## 9. API / Interface Contracts

**CLI**
| Command | Behavior |
|---|---|
| `init <repo\|url> [--out p]` | writes manifest draft; exit 0 |
| `explore <manifest> [--max-actions n] [--resume]` | sandbox or live per `source.type`; writes `maps/<name>/map.json` |
| `route <map> "<goal>" [--from id] [--no-llm] [--json]` | prints/returns `Route` |
| `mcp [--maps dir]` | stdio MCP server; never exits on its own |
| `bench <manifest> [--tasks p] [--repeats n] [--conditions a,b]` | writes `bench/results/<name>-<ts>.json` + `-latest.md` |
| `view [mapDir]` | http://localhost:4173, `GET /map.json`, `GET /shots/*`, `GET /route?goal=&from=&llm=` |

**MCP tools (JSON in/out; text content unless noted)**
| Tool | Input (zod) | Output |
|---|---|---|
| `atlas_list_maps` | `{}` | `{ maps: [{ name, states, edges, mutatedEdges, updatedAt, mode }] }` |
| `atlas_map_summary` | `{ map: string }` | `{ name, rootStateId, states, edges, mutatedEdges, runs, topStates: [{id,title,urlPath,affordances}] (≤ 15) }` |
| `atlas_find_state` | `{ map, url?: string, description?: string, screenshot_base64?: string }` | `{ stateId, title, urlPath, confidence, method: "url"\|"phash"\|"lexical" } \| { stateId: null, reason }` |
| `atlas_route` | `{ map, goal: string, from_state?: string, avoid_mutations?: boolean }` | `Route` (§7) |
| `atlas_affordances` | `{ map, state_id }` | `{ stateId, affordances: [{ id, label, x, y, kind, risk, expected, status }] }` |
| `atlas_state_screenshot` | `{ map, state_id }` | image block (PNG) + text `{ stateId, title, url }` |
Errors: unknown map/state → `isError: true` with `{ error: "MapNotFound" | "StateNotFound" | "NoRoute", detail }`.

**Library**
- `shortestPath(doc, from, to, {avoidMutations}) → Edge[] | null`
- `selectGoalState(doc, goal, {useLlm}) → { best: Candidate, alternatives }`
- `solve(host, pool, m, {goal, maxSteps, hint?}) → { log, finalState?, visionCalls, done, failReason? }`
- `runBench(m, tasksPath, {conditions, repeats}) → BenchReport`
- `Host` interface (§8 Step 1).

**Solari facts relied on:** stealth requires a paid plan (402 `FeatureRequiresPlan` on Free); `proxy` requires `stealth: true`; proxy can silently degrade (assert on `browser.proxy`); `launch()` returns a Playwright-shaped browser; `ctx.route` works on it; everything from Phase 1 (`sh -c`, `connect()`, preview token header, `kill()`, session death/relaunch).

---

## 10. Error Handling & Edge Cases

| Situation | Handling |
|---|---|
| Live mode target blocks the browser (Cloudflare page, empty body) | Detect: title matches `/just a moment\|access denied\|attention required/i` or visible text < 40 chars → abort run with note "blocked"; suggest `live.proxyCountry`. Never retry in a loop (cost). |
| Live mode: affordance click triggers navigation off-origin | Request aborted by route → page shows error → observed state text digest is the browser error page; skip state creation if `visible` contains `blockedbyclient`/`ERR_` and mark affordance `failed: "off-origin"`. |
| Live mode: same-origin GET has side effects (e.g. `/logout`, `/delete?id=`) | Blocklist defaults extended in live mode with `["delete","remove","logout","sign ?out","unsubscribe","cancel"]` (label regex). Document that GET-with-side-effects cannot be fully prevented; that's why live mode is "read-only best effort" and sandbox mode is the real product. |
| `atlas_route` goal ambiguous | Return best with `goalScore` and `alternatives`; warnings include "low confidence". Never return an empty route silently. |
| No path from `from_state` | `NoRoute` error including `reachable` count and nearest lexical candidates. |
| Map has states without affordances (vision budget hit) | `atlas_map_summary` reports `unexploredStates`; `route` warns if goal state was never expanded. |
| Solver returns off-screen coords | Reject via schema; ask once more with "coordinates were outside the viewport"; then `fail`. |
| Solver loops (same click 3×) | Detect identical action 3 times in a row → `fail: "loop"`. |
| Bench check command fails to run (non-0/1 exit, e.g. python error) | Result `success: false, failureReason: "check-error: <stderr>"`; do not count as naive/with-map failure in the summary — count separately as `invalid` and print it. |
| Revert between bench tasks fails | Abort bench, save partial report, `host.kill()`. |
| Sandbox concurrency 429 (bench + explore at once) | Starter = 2 running VMs; print running cartographer VMs and exit. |
| `npm pack` includes `maps/` or screenshots | `files` whitelist prevents it; assert in `pack:test`. |
| MCP client sends a relative `--maps` path | Resolve against `process.cwd()` at startup and log the absolute path to stderr (never stdout — stdout is the protocol channel). |
| Gemini rate limit (429) | `retry` with backoff up to 3 tries; then lexical-only for goal selection, `fail` for solver step. |

---

## 11. Testing & Verification

**Unit:** `npm test` — Phase 1 tests + `graph.test.ts`, `goal.test.ts` (lexical only, deterministic), `solverParse.test.ts`.

**MCP integration:** `npm run test:mcp` — stdio client calls all six tools on `maps/target-shop`; asserts shapes; asserts `atlas_route("refund order 3")` ends in a mutated edge and `avoid_mutations: true` yields a route without mutated edges or a `NoRoute`/warning.

**Live e2e:** `tsx scripts/e2e-live.ts` on books.toscrape.com (⚠️ verify availability): ≥ 6 states, zero non-GET requests continued (route counter), all edges `blocked-writes`.

**Benchmark:** `npm run bench examples/target-shop/carto.target.json --repeats 3`. Expected shape of result (your numbers will differ):
```
| condition | tasks | success | avg steps (success) | avg vision calls | avg s |
| naive     | 12    | 8/12    | 6.9                 | 7.9              | 71    |
| with-map  | 12    | 12/12   | 3.4                 | 4.2              | 39    |
```
If with-map is **not** better, do not massage the prompt to make it win — investigate goal selection and route coordinates (stale coordinates after layout shifts are the usual culprit) and report honestly in `docs/benchmark.md`. An honest "with-map helps on 3 of 4 tasks" is publishable; a rigged table is not.

**Fresh-clone check:** `git clone … && npm ci && npm run build && npm test && npm run test:mcp`.

---

## 12. Definition of Done

- [ ] `init` produces valid manifests for a URL and a Python repo.
- [ ] Live mode explores a public site with zero non-GET requests continued; all edges `mutationMode: "blocked-writes"`; blocked-site detection works.
- [ ] `route` returns correct multi-step routes with mutation warnings on target-shop; `--json` matches the `Route` type.
- [ ] MCP server exposes the six `atlas_*` tools; `npm run test:mcp` passes; registered and used successfully from Claude Code at least once (screenshot in `docs/mcp-tools.md`).
- [ ] Solver is vision-only (no DOM reads in `src/solve/**` — grep `evaluate(` returns nothing there).
- [ ] Benchmark runs 4 tasks × 2 conditions × 3 repeats on target-shop; report JSON + markdown committed; numbers reproduced within ±1 step on a second run.
- [ ] ≥ 2 real OSS app maps committed (≥ 20 states, ≥ 2 reverted mutations each); one bench report on a real app.
- [ ] `npm pack` contains only `dist`, `viewer`, `README.md`, `LICENSE`; `npx <tgz> --help` works from an empty dir; shebang present.
- [ ] README + 4 docs pages complete; `docs/POST-v0.md` has three drafts with real numbers.
- [ ] `NOTES.md` updated: live-mode block rate observed, proxy degradation incidents, any SDK adaptations, Solari bugs hit (for Phase 3 reports).
- [ ] No orphaned sandboxes after any command (Ctrl-C handlers cover `bench` too).

---

## 13. Notes & Pitfalls

- **Do not build Phase 3 things here:** no desktop mode, no fork parallelism, no hosted site, no cookbook PR.
- **MCP stdout is sacred.** All logging in `mcp` mode must go to stderr (`pino({}, pino.destination(2))`), or clients will fail to parse the protocol.
- **Stale coordinates.** Routes carry pixel coordinates captured at exploration time. If the app has dynamic layout (banners, variable-length lists), the with-map solver may click slightly off. Keep the viewport fixed at 1280×800 and let the solver treat the hint as guidance, not a script. Record how often this happens in `docs/benchmark.md`.
- **Goal-state selection is the weak link**, not path search. Invest in lexical fields (include `expected` text) before adding LLM calls.
- **Live mode is not the flagship.** It exists so people can try Cartographer on any URL in 30 seconds; the write-up must say sandbox mode is where revert makes exploration safe.
- **Respect the sites you explore live.** Keep `maxActions` small, one browser, no parallelism, honor obvious rate limits. Use a practice site for the committed example.
- **Stealth costs more per hour** than the fast pool; only live mode uses it.
- **Node 18 in the base sandbox** will bite on Node-based OSS targets. The Node-22-tarball install step in `init` notes is the fix; keep it in `docs/manifest.md`.
- **Keep the solver dumb on purpose.** A smarter solver shrinks the with/without gap and muddies the claim.
- **Screenshots in git** balloon the repo. Cap committed maps at ~30 MB; zip beyond that.
- **Do not publish to npm yet** if the package name is taken — check `npm view solari-cartographer` first; Phase 3 handles publish + scope fallback.
- Everything from Phase 1 still applies: `sh -c`, `connect()`, `kill()`, preview token header, session relaunches, `newContext({storageState})`.

---

## 14. Handoff to Next Phase

**What works after Phase 2:** anyone can `init` a repo or URL, `explore` it (sandbox with revert, or live read-only), ask `route`/MCP `atlas_route` for exact clicks to a goal, and see a benchmark proving the map reduces steps. Two real app maps and a launch draft exist.

**Next (Phase 3):** desktop mode (screenshot-only exploration of GUI apps on a Solari desktop — the Pinetree-thesis showpiece), parallel exploration with sandbox forks on Pro, a hosted maps site, the rock-solid demo path and pitch script, the cookbook fork + PR, Solari bug reports, and the submission checklist against the judging criteria.
