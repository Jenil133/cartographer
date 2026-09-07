# CARTOGRAPHER — PHASE 3: Desktop Mode, Parallel Forks, Hosted Maps, Demo & Submission

> You are the builder. You have ONLY this file. It contains everything you need: project context, architecture, the exact current state of the code, data model, and step-by-step instructions. Do not assume any prior conversation. If something is marked ⚠️ verify, check it against the live docs/package before relying on it.

---

## 1. Project & Challenge Context

### The challenge (ground truth)
- **Who:** Pinetree Research (Palo Alto AI lab, ~6 people) is hiring one remote SWE intern ("$300K annualized") via a public build challenge run by Harry Chow (Head of Growth & Ops, X `@harrychow_`). Pinetree builds **pure-vision computer-use agents** (screen/keyboard/mouse; explicitly not DOM/API-based) for healthcare, finance, legal and operations software "with no APIs", and states its architecture is "a general reasoning engine + a specialized world model."
- **Their product we build on:** **Solari** (getsolari.com) — cloud infra for agents behind one API key `slr_live_…` and base URL `https://api.getsolari.com`: **cloud browsers** (Playwright-shaped; stealth/proxies/captcha on paid plans; session recording), **sandboxes** (headless Linux microVMs: commands, files, git, port preview URLs, **snapshot / revert / fork**), **desktops** (microVM + X display + VNC; `mouse.*`, `keyboard.*`, `screenshot()`, `open(app)`, `pkg.install`, server-side mp4 recording; templates `default`/`workstation`, `office` (LibreOffice, GIMP, Inkscape), `code` (VS Code)).
- **Rules:** fork `https://github.com/solari-sdk/solari-cookbook`, build "a real use case" with Solari, publish on public GitHub (standalone repo + a copy inside the fork is officially fine — Harry: "build a standalone OSS then submit a copy as a fork"), post on X/LinkedIn tagging exactly `@harrychow_` and `@getsolari`, and also post in the Solari Discord `#showcase` (format: What you built / What problem it solves / Tools+stack / Screenshot, demo, repo / What feedback you want). Judged on **product-market fit, real users, building in public**; Harry: "prove people need it… getting people to use it is what proves real fit." ~500 submissions, one opening, individual review promised. **No deadline announced; it can be announced any day.**
- **Cookbook conventions:** examples are small, one idea each, runnable end-to-end against the real API, and "put anything surprising in a comment right where it bites." All 43 PRs so far are unmerged; README-gotcha PRs and bug reports were publicly thanked by the team. Bugs are reported privately via Discord `#support-requests` (server rules), never with API keys.
- **The field:** ~1/3 of entries are "QA for AI-generated code". Only ~5 of ~95 catalogued builds use the desktop primitive; 2–3 use snapshot/fork as an agent primitive; nobody builds world models.

### The product: Cartographer
**One-liner:** *Build a map of any app before your agent touches it.* Cartographer hosts a target app inside a Solari sandbox (or opens a GUI app on a Solari desktop), snapshots the booted world, and explores every clickable path **vision-first** (screenshot → Gemini proposes affordances → click by coordinates). Any action that mutates the app's data (detected by digesting the app's data files) is **undone with `revert()`** to the root snapshot. Output: a **map** (states, affordances, edges, mutation flags, screenshots) that any agent queries through MCP (`atlas_route(goal)`) to complete tasks in fewer steps — proven by a with-map vs naive benchmark.

**This phase** adds the Pinetree-thesis showpiece (desktop, screenshot-only, on a legacy finance app), parallel exploration with forks, a hosted site of maps, the demo path, the cookbook contribution, bug reports, and the submission.

**Non-negotiable principles (apply in every file you write):**
1. **Vision-first.** Which element to click is decided from the screenshot; clicks execute by coordinates. Desktop mode has no DOM at all — it is the purest expression of the principle.
2. **Fail-closed.** No state without a screenshot; no edge without evidence; uncertain = `unknown`, never success.
3. **No external side effects.** Sandbox mode: browser network allowlisted to the preview host. Live mode: non-GET aborted. Desktop mode: no network for the GUI app unless the manifest allows it.
4. **Every mutation is reverted** (sandbox/desktop). Live mode blocks writes and says so.
5. **Everything is measured.** Spend/counts in `map.json`; bench results are files; the demo shows real numbers.

### Phase arc (700 engineering hours total, solo)
- **Phase 1 (done, ~110 h):** scaffold, sample Flask app, sandbox host with snapshot/revert, cloud browser pool, Gemini affordances, BFS explorer, `map.json` + screenshots, viewer.
- **Phase 2 (done, ~250 h):** `init`, live read-only mode, graph/route, MCP server, solver + benchmark, ≥ 2 real OSS maps, README/docs, v0 post draft.
- **Phase 3 (this file, ~250 h + ~90 h reserve):** desktop mode, parallel forks, hosted maps site, demo path + pitch, cookbook fork/PR, bug reports, users, npm publish, submission.

---

## 2. Architecture Overview

```
 ┌──────────────┐  carto.target.json  ┌────────────────────────────────────────┐
 │ CLI          │ ──────────────────▶ │ Explorer: BFS over (state, affordance) │
 │ init/explore │                     │ shared Frontier · Budget · MapStore    │
 │ route/mcp   │                     │ workers[0..N) — each owns one Actor    │
 │ bench/view  │                     └───┬──────────────┬─────────────────┬───┘
 │ publish     │             ┌───────────▼──┐   ┌───────▼────────┐  ┌─────▼──────────┐
 └──────┬───────┘             │ Host          │   │ Actor          │  │ Vision (Gemini)│
        │                     │ SandboxHost   │   │ BrowserActor   │  │ affordances    │
        │                     │ LiveHost      │   │ (cloud Chrome) │  │ next-action    │
        │                     │ DesktopHost ◀─┼───│ DesktopActor   │  │ rerank         │
        │                     │  boot/digest/ │   │ (VNC desktop:  │  └────────────────┘
        │                     │  snapshot/    │   │  screenshot,   │
        │                     │  revert/fork  │   │  mouse.click)  │
        │                     └───────────────┘   └────────────────┘
        │                                                ▼
        │                                  ┌──────────────────────────┐
        │                                  │ MapStore maps/<name>/    │
        │                                  │ map.json · shots · media │
        │                                  └──────┬───────────────────┘
        │              ┌───────────────┬──────────┼──────────────┬─────────────────┐
        ▼              ▼               ▼          ▼              ▼                 ▼
  ┌──────────┐  ┌────────────┐  ┌───────────┐ ┌──────────┐ ┌────────────────┐ ┌────────────────┐
  │ Viewer   │  │ Graph/goal │  │ MCP atlas │ │ Solver + │ │ Site builder → │ │ Cookbook fork  │
  │ (live    │  │            │  │ (stdio)   │ │ Bench    │ │ GitHub Pages   │ │ examples/      │
  │ refresh) │  └────────────┘  └───────────┘ └──────────┘ │ (maps index)   │ │ cartographer-ts│
  └──────────┘                                             └────────────────┘ └────────────────┘
```

**Actor abstraction (new):** the explorer no longer talks to `BrowserPool` directly. `Actor` = `{ observe(), clickAt(x,y), reach(state), close() }`. `BrowserActor` wraps a browser context/page (web); `DesktopActor` wraps a Solari desktop control channel (screenshot + `mouse.click`). Host and Actor are created per **worker**.

**Desktop episode:** ensure world at root (digest; revert if drifted) → `reach(S)`: since GUIs have no URLs, `reach` = verify current phash ≈ root (else revert) then replay `S.pathFromRoot` clicks → screenshot → click → settle → screenshot → phash + active window title → resolve/create state → digest → revert if mutated → persist. Because open dialogs/menus are GUI state that no "navigation" undoes, after every episode the actor presses `Escape` twice and, if the phash is not ≈ root, the worker reverts (cheap insurance; counted as `reverts`).

**Parallel forks (new):** worker 0 boots the target and takes the root snapshot; workers 1..N-1 are created with `create({ fromSnapshot: rootSnapshotId, memMb: same })` (independent copies, each with its own preview URL / VNC). Each worker reverts **its own machine** to the shared root snapshot when it mutates. All workers pull from one in-process `Frontier` and write through one `MapStore`; edge ids are allocated synchronously. Concurrency is capped by plan (Starter 2 running VMs, Pro 10).

**Hosted site (new):** `site/` static build: index of maps (states, edges, mutations, mode, cost), one viewer page per map, benchmark tables, the desktop demo video. Deployed to GitHub Pages by a workflow.

---

## 3. Current State (what exists at the start of this phase)

Repository `cartographer/` (npm package `solari-cartographer`, ESM, Node 22, TypeScript strict, bins `cartographer` and `solari-cartographer` → `dist/cli.js`). All of the following exist and work:

- `src/config.ts` (`SOLARI_API_KEY`, `SOLARI_BASE_URL`, `GEMINI_API_KEY`, `GEMINI_MODEL` default `gemini-3.7-flash` (confirm current id), `CARTO_MAPS_DIR`, `CARTO_BENCH_DIR`, `LOG_LEVEL`), `src/log.ts` (pino; stderr in mcp mode).
- `src/types.ts` — all types (reproduced in §7).
- `src/manifest.ts` — `loadManifest(path)`; supports `source.type` `local` | `repo` | `url`; `live` defaults.
- `src/util/{hash,sleep,budget}.ts`.
- `src/perception/stateId.ts` — `dHash`, `hamming`, `textDigest`, `stateIdFor(urlPath, domDigest)`, `resolveState(obs, states)` (same `urlPath` + hamming ≤ 6).
- `src/vision/gemini.ts` — `generateJson(parts, schema)`, `proposeAffordances(png, ctx)`, `nextAction(png, ctx)`, `rerankStates(goal, candidates)`.
- `src/solari/host.ts` — `Host` interface `{ mode, previewBase, previewToken, boot(m, localDir?), digest(), rootDigest, revertToRoot() → ms, kill() }`; `src/solari/sandboxHost.ts` (`SandboxHost`: create/install via `runLong`/start/`refreshPreview`/`waitReady`/`digest`/`revertToRoot`/`kill`; fields `sbx`, `id`, `rootSnapshotId`); `src/solari/liveHost.ts` (`LiveHost`).
- `src/solari/browserPool.ts` — `BrowserPool { login(); newContext() → {ctx, page}; observe(page) → {png, visible, doms, url, title}; clickAt(page,x,y); typeAt(page,x,y,text,{pressEnter}); close() }` with mode-aware `ctx.route` policy (preview-token header + allowlist in sandbox mode; same-origin GET only in live mode), stealth in live mode.
- `src/explore/frontier.ts` (`Frontier`), `src/explore/explorer.ts` (`explore(manifest, {resume, maxActions})`, helpers `observeAndRegister`, `reach`) — talks to `BrowserPool` directly.
- `src/map/store.ts` (`MapStore`, `nextEdgeId`, `listMaps`, `loadByName`), `src/map/graph.ts` (`adjacency`, `shortestPath(doc, from, to, {avoidMutations})`, `reachable`), `src/map/goal.ts` (`selectGoalState(doc, goal, {useLlm})` — MiniSearch + Gemini rerank).
- `src/mcp/server.ts` — stdio MCP server with tools `atlas_list_maps`, `atlas_map_summary`, `atlas_find_state`, `atlas_route`, `atlas_affordances`, `atlas_state_screenshot`.
- `src/solve/{solver,prompts}.ts` — vision-only solver `solve(host, pool, m, {goal, maxSteps, hint?})`; `src/bench/{runner,report}.ts` — `runBench(m, tasksPath, {conditions, repeats})` → `bench/results/<name>-<ts>.json` + `-latest.md`.
- `src/init/detect.ts` — `draftManifest(input)`.
- `src/cli.ts` — `init`, `explore`, `route`, `mcp`, `bench`, `view` (serves viewer + `GET /route`).
- `viewer/index.html` — Cytoscape graph, mutated edges red, route highlight, stats.
- `examples/target-shop/` (Flask+sqlite sample + manifest), `examples/manifests/*.json` (real OSS targets), `bench/tasks/*.json`, `bench/results/*-latest.md`.
- `maps/target-shop/`, plus ≥ 2 real OSS app maps committed.
- `docs/{getting-started,manifest,mcp-tools,benchmark,POST-v0}.md`, `README.md`, `NOTES.md` (revert latency p50, SDK adaptations, Solari bugs hit, live-mode block rate).
- Tests: unit (perception, frontier, store, graph, goal, solverParse), `scripts/e2e-explore.ts`, `scripts/e2e-live.ts`, `scripts/mcp-smoke.ts`. `npm run pack:test` clean.

Facts you must keep respecting (from Phases 1–2): sandbox commands need `sh -c`; `connect()` before files/git/`commands.start`; exec cap ~28 s → `runLong`; `kill()` not `close()`; preview token in a header on every request; browser sessions may die ~10 min after creation → relaunch; Solari `newPage()` opens a fresh context → `newContext({storageState})`; MCP stdout is protocol-only; stealth only in live mode; proxy may silently degrade.

---

## 4. Phase Goal & Scope

**Goal:** Cartographer is submission-ready: a desktop (screenshot-only) map of a legacy finance app with reverted destructive actions and a recording; parallel exploration; a public site of maps; a rehearsed 3-minute demo; the cookbook fork + PR; bug reports filed; 4–5 real users with quotes; npm published; posts published with real numbers.

**In scope**
1. `Actor` abstraction; `BrowserActor`; `DesktopActor` + `DesktopHost`; manifest `desktop` section; desktop exploration; per-episode recording for evidence.
2. Desktop target: **GnuCash** on the `office`/`default` template (legacy finance desktop app, file-based data) — fallback LibreOffice Calc if GnuCash can't install/boot within limits (⚠️ verify apt availability and boot time).
3. `--workers N` parallel exploration via forks; plan-aware cap; shared frontier/store.
4. Viewer live refresh (polls `map.json` while exploring) for the demo.
5. `site/` builder + GitHub Pages workflow; maps index; bench tables; media.
6. `demo/` — `demo.sh`, pitch script, fallback recording; rehearsed ×3.
7. Cookbook fork: `examples/cartographer-ts` (small runnable example) + `projects/cartographer/` pointer; PR to `solari-sdk/solari-cookbook` with the small example only.
8. Bug/gotcha reports (from `NOTES.md`) via Discord `#support-requests` + README-gotcha PR if a docs gap.
9. Users: recruit 4–5, `docs/try-it.md`, `USERS.md` (consented quotes + their step counts).
10. npm publish (name check + scoped fallback), version 1.0.0.
11. Final posts (X thread, LinkedIn, Discord #showcase) + submission checklist against the criteria.

**Out of scope**
- New exploration action kinds (typing during exploration), multi-region, any backend/service, auth/accounts, a SaaS.
- Desktop benchmark with the solver (nice-to-have only if all DoD items are done and ≥ 40 h remain).

---

## 5. Prerequisites & Setup

- Phases 1–2 complete and green. Solari **Starter** (2 running VMs → `--workers 2`); **Pro ($200)** only if you decide to demo `--workers 6+` (optional; do not buy it for the sake of it). Gemini key. GitHub account with Pages enabled on the repo.
- Desktop entitlement: the changelog (Sep 2) says Free-plan machines are creatable from the API; API reference still says desktops need a paid plan. On Starter you are fine. Desktop adds +$0.02/h for the live screen.
- Dependencies:
```bash
npm i -D gh-pages   # optional; the Actions workflow is the primary deploy path
```
No new runtime dependencies: `@solarisdk/sandbox`'s `SandboxClient.createDesktop({ template, resolution, cpu, memMb, timeoutMs, lifecycle, metadata, record? })` returns a `Desktop` handle. **Verified against docs.getsolari.com/sdk/typescript/vms (2026-09-07):** `health() → {ready, display, vnc}`, `screenshot({format}) → Uint8Array`, `mouse.move/click(x, y, {humanize})`, `keyboard.type(text)`, `keyboard.press(keys)` (key names are xdotool-style, e.g. `"Return"`, `"Escape"`), `open(name, args) → pid`, `pkg.install("apt", [...]) → {exitCode, stdout, stderr}`, `exec(cmd, {args})` (no shell → `sh -c`), `record.start({fps}) → {path, fps}`, `record.stop() → {path, sizeBytes}`, `downloadUrl(path) → {url}`, plus inherited `connect/reconnect/snapshot/revert/kill/files/commands`. The docs' own example calls `vm.exec("xdotool", …)`, so xdotool is expected in the desktop templates. Do not add `@solarisdk/desktop` (0.1.2 pins an older core).
- New optional env: `CARTO_WORKERS` (default 1), `CARTO_SITE_BASE` (Pages base path, e.g. `/cartographer/`).
- `package.json` scripts additions:
```json
{
  "site:build": "tsx scripts/build-site.ts",
  "site:serve": "npx serve site -l 4174",
  "demo": "bash demo/demo.sh",
  "e2e:desktop": "tsx scripts/e2e-desktop.ts"
}
```

---

## 6. File Structure for This Phase

```
cartographer/
├── package.json                      MODIFIED (scripts, version 1.0.0, repository/homepage)
├── README.md                         MODIFIED (desktop section, site link, users, demo video)
├── USERS.md                          NEW  (consented user quotes + numbers)
├── .github/workflows/pages.yml       NEW  (build site → GitHub Pages)
├── src/
│   ├── types.ts                      MODIFIED (desktop manifest, workers, recording evidence)
│   ├── manifest.ts                   MODIFIED (source.type "desktop-app")
│   ├── cli.ts                        MODIFIED (--workers, --mode auto, publish helper, view --watch)
│   ├── explore/
│   │   ├── actor.ts                  NEW  Actor interface + Observation type
│   │   ├── browserActor.ts           NEW  wraps BrowserPool page/context
│   │   ├── desktopActor.ts           NEW  wraps Desktop handle
│   │   ├── explorer.ts               MODIFIED (Actor + workers; episode() extracted)
│   │   ├── worker.ts                 NEW  per-worker loop; fork creation
│   │   └── frontier.ts               MODIFIED (claim/release for concurrency)
│   ├── solari/
│   │   ├── host.ts                   MODIFIED (fork(), workerIndex, kind)
│   │   ├── sandboxHost.ts            MODIFIED (fork(rootSnapshotId), revert on own machine)
│   │   ├── desktopHost.ts            NEW  create desktop, open app, digest, snapshot/revert, record
│   │   └── browserPool.ts            (unchanged)
│   └── site/
│       └── build.ts                  NEW  generates site/ from maps/ + bench/ + docs/
├── scripts/
│   ├── build-site.ts                 NEW  (thin wrapper)
│   ├── e2e-desktop.ts                NEW
│   └── e2e-workers.ts                NEW
├── site/                             NEW (generated; committed)
│   ├── index.html · maps/<name>/index.html · media/
├── viewer/index.html                 MODIFIED (watch mode polling, desktop badge, video link)
├── examples/
│   ├── gnucash/carto.target.json     NEW  (desktop target)
│   └── libreoffice-calc/carto.target.json  NEW (fallback desktop target)
├── demo/
│   ├── demo.sh                       NEW
│   ├── PITCH.md                      NEW  (3-minute script, timings)
│   ├── fallback.mp4 (or link)        NEW
│   └── checklist.md                  NEW  (pre-demo checks)
├── docs/
│   ├── desktop.md                    NEW
│   ├── parallel.md                   NEW
│   ├── try-it.md                     NEW  (for users)
│   ├── bug-reports.md                NEW  (what was reported, where, status)
│   ├── POST-final.md                 NEW
│   └── SUBMISSION.md                 NEW  (checklist vs criteria)
└── cookbook-fork/                    NOT in this repo — a separate clone of your fork of solari-sdk/solari-cookbook:
    ├── examples/cartographer-ts/     NEW  (index.ts, README.md, package.json, .env.example)
    └── projects/cartographer/README.md  NEW (pointer to the main repo + site)
```

---

## 7. Data Model / Schema

`src/types.ts` — full definition after this phase. `// P3` marks new fields; nothing existing is renamed.

```ts
export type Bbox = { x: number; y: number; w: number; h: number };
export type ActionKind = "click" | "type" | "press" | "navigate";
export type Risk = "read" | "write" | "unknown";
export interface DomHint { tag: string; text: string; selectorHint: string; bbox: Bbox; href?: string; }

export interface Affordance {
  id: string; stateId: string; label: string; kind: ActionKind; bbox: Bbox; expected: string; risk: Risk;
  dom?: DomHint; status: "pending" | "explored" | "skipped" | "failed"; skipReason?: string;
}

export interface StateNode {
  id: string; kind: "web" | "desktop";
  url: string; urlPath: string;   // desktop: url = "desktop://<app>", urlPath = normalized active window title
  title: string; phash: string; domDigest: string;   // desktop: domDigest = ""
  screenshot: string; affordances: Affordance[]; pathFromRoot: string[]; discoveredInRun: string;
}

export interface EdgeAction { kind: ActionKind; x: number; y: number; label: string; text?: string; key?: string; affordanceId: string; }

export interface Edge {
  id: string; from: string; to: string; action: EdgeAction;
  mutated: boolean; reverted: boolean; digestBefore: string; digestAfter: string;
  evidence: { before: string; after: string; replayUrl?: string; recording?: string };  // P3: recording = relative mp4 path (desktop)
  durationMs: number; ts: string; runId: string; mutationMode?: "digest" | "blocked-writes";
  worker?: number;                                                                      // P3
}

export interface Budget { maxActions: number; maxStates: number; maxVisionCalls: number; maxMinutes: number; }
export interface Spent { actions: number; states: number; visionCalls: number; reverts: number; sandboxMinutes: number; browserMinutes: number; estUsd: number; }

export interface RunMeta {
  id: string; startedAt: string; finishedAt?: string; targetName: string;
  mode: "sandbox" | "live" | "desktop"; budget: Budget; spent: Spent;
  sandboxId?: string; rootSnapshotId?: string; rootDigest?: string; notes: string[];
  workers?: number; forkIds?: string[];                                                 // P3
  revertMsSamples?: number[];                                                            // P3: for p50 reporting
}

export interface DesktopSpec {                                                          // P3
  template: "default" | "workstation" | "office" | "code" | string;
  install?: string[];               // sh commands (e.g. apt-get install), run via runLong-equivalent
  app: string; args: string[];      // desktop.open(app, args)
  readyWindowTitle: string;         // regex; root state is reached when active window title matches
  settleMs: number;                 // wait after click before observing (default 1500)
  windowTitleCmd: string;           // default: "xdotool getactivewindow getwindowname"
  allowNetwork: boolean;            // default false → block egress inside the VM for the app (see Step 3)
  resolution: string;               // "1280x800"
}

export interface TargetManifest {
  name: string;
  source: { type: "repo"; repo: string; ref?: string; subdir?: string }
        | { type: "local"; dir: string }
        | { type: "url"; url: string }
        | { type: "desktop-app" };                                                      // P3
  runtime?: { install: string[]; start: string; port: number; readyPath: string; cpu?: number; memMb?: number; diskGb?: number; };
  dataPaths?: string[];             // desktop: absolute paths of the app's data files in the VM
  login?: { url: string; steps: Array<{ fill: [string, string] } | { click: string }> };
  blocklist: string[]; viewport: { width: number; height: number }; budget: Budget;
  live?: { stealth: boolean; proxyCountry?: string; maxDepth: number; sameOriginOnly: boolean; };
  desktop?: DesktopSpec;                                                                 // P3 (required when source.type = "desktop-app")
}

export interface MapDoc { version: 1; target: TargetManifest; rootStateId: string | null; states: Record<string, StateNode>; edges: Edge[]; runs: RunMeta[]; updatedAt: string; }

export interface RouteStep { edgeId: string; from: string; to: string; action: EdgeAction; mutated: boolean; }
export interface Route { map: string; fromState: string; goalState: string; goalScore: number; steps: RouteStep[]; warnings: string[]; alternatives: Array<{ stateId: string; title: string; score: number }>; }

export interface BenchTask { id: string; goal: string; check: string; maxSteps: number; }
export interface BenchStepLog { n: number; action: { kind: "click"|"type"|"done"|"fail"; x?: number; y?: number; text?: string }; reasoning: string; stateId?: string; ms: number; }
export interface BenchResult { taskId: string; condition: "naive" | "with-map"; success: boolean; steps: number; visionCalls: number; seconds: number; estUsd: number; routeUsed?: Route; log: BenchStepLog[]; failureReason?: string; }
export interface BenchReport { target: string; ranAt: string; results: BenchResult[]; summary: Record<"naive"|"with-map", { tasks: number; successes: number; avgSteps: number; avgVisionCalls: number; avgSeconds: number }>; }

// ---- P3: actor ----
export interface Observation { png: Buffer; visible: string; doms: DomHint[]; url: string; title: string; }
export interface Actor {
  kind: "web" | "desktop";
  observe(): Promise<Observation>;
  clickAt(x: number, y: number): Promise<void>;
  reach(state: StateNode, doc: MapDoc): Promise<boolean>;   // true iff observed state resolves to `state`
  resetToRoot(): Promise<void>;                               // web: new context at root URL; desktop: Escape×2, revert if phash ≠ root
  close(): Promise<void>;
}

// ---- P3: site index ----
export interface SiteMapEntry { name: string; mode: "sandbox"|"live"|"desktop"; states: number; edges: number; mutated: number; reverted: number; estUsd: number; updatedAt: string; cover: string; }
```

**Desktop manifest — GnuCash (`examples/gnucash/carto.target.json`)** ⚠️ verify package name, binary, data file path, and boot time on the `office` template before relying on it:
```json
{
  "name": "gnucash-desktop",
  "source": { "type": "desktop-app" },
  "desktop": {
    "template": "office",
    "install": ["sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq gnucash xdotool", "mkdir -p /home/user/books && cp /work/seed/demo.gnucash /home/user/books/demo.gnucash"],
    "app": "gnucash", "args": ["/home/user/books/demo.gnucash"],
    "readyWindowTitle": "demo.*GnuCash|GnuCash.*demo",
    "settleMs": 1500, "windowTitleCmd": "xdotool getactivewindow getwindowname",
    "allowNetwork": false, "resolution": "1280x800"
  },
  "dataPaths": ["/home/user/books"],
  "blocklist": ["quit", "exit", "close window", "log ?out"],
  "viewport": { "width": 1280, "height": 800 },
  "budget": { "maxActions": 60, "maxStates": 40, "maxVisionCalls": 60, "maxMinutes": 45 }
}
```
`demo.gnucash` (seed): create locally with GnuCash (XML, uncompressed) with ~8 accounts and ~15 transactions, commit under `examples/gnucash/seed/`. Whether `sudo` exists in the template is ⚠️ verify — if the guest user is root, drop `sudo`.

**Fallback (`examples/libreoffice-calc`):** `app: "libreoffice", args: ["--calc", "/home/user/books/ledger.ods"]`, `dataPaths: ["/home/user/books"]`, no install (office template ships LibreOffice). Mutations = Save (Ctrl-S is a keyboard action; expose a "Save" toolbar click as an affordance instead).

---

## 8. Implementation Steps

### Step 1 — Actor abstraction (refactor without behavior change)
1. `src/explore/actor.ts` — types from §7.
2. `src/explore/browserActor.ts` — `class BrowserActor implements Actor` constructed with `(pool: BrowserPool, host: Host, m: TargetManifest)`; `open()` creates a context/page at the root URL; `observe()` delegates to `pool.observe(page)`; `clickAt` → `pool.clickAt`; `reach(state, doc)` = existing `reach` logic from Phase 2 moved here (goto URL, verify via `resolveState`, else replay `pathFromRoot` using `doc.edges`); `resetToRoot()` = close context, open a new one at the root URL; `close()`.
3. `src/explore/explorer.ts` — extract `episode(ctx: EpisodeCtx, item: FrontierItem)` where `EpisodeCtx = { doc, store, host, actor, budget, run, m, workerIndex }`; the loop becomes `while (frontier.size() && budget.canAct()) await episode(...)`. Behavior identical to Phase 2.
**Verify:** `npm test`, `npm run e2e`, `npm run test:mcp` all still pass; map output for target-shop is structurally identical (same state ids for the same app).

### Step 2 — DesktopHost
`src/solari/desktopHost.ts` (⚠️ verify method names against the installed `.d.ts`):
```ts
export class DesktopHost implements Host {
  mode = "desktop" as const; previewBase = ""; previewToken = null; rootDigest = ""; rootSnapshotId!: string; id!: string;
  private client = new SandboxClient({ apiKey: config.SOLARI_API_KEY, baseUrl: config.SOLARI_BASE_URL, callTimeoutMs: 900_000 });
  desktop!: any; private m!: TargetManifest;
  async boot(m: TargetManifest) {
    this.m = m; const d = m.desktop!;
    this.desktop = await this.client.createDesktop({ template: d.template, resolution: d.resolution, cpu: 2, memMb: 4096,
      timeoutMs: 45 * 60_000, lifecycle: { onTimeout: "kill" }, metadata: { app: "cartographer", target: m.name } });   // or client.desktops.create(...)
    this.id = this.desktop.id ?? this.desktop.sessionId;
    await this.desktop.connect();                                    // control channel BEFORE any GUI method
    await this.waitHealthy(120_000);                                 // desktop.health() → {ready, display, vnc}
    await this.uploadSeed(m);                                        // files.write into /work/seed
    for (const cmd of d.install ?? []) await this.runLong(cmd, 15 * 60_000);   // same nohup+poll pattern as SandboxHost, using desktop.exec
    if (!d.allowNetwork) await this.blockAppEgress();                // Step 3
    await this.desktop.open(d.app, d.args);                          // returns pid
    await this.waitWindow(d.readyWindowTitle, 120_000);
    await sleep(d.settleMs);
    this.rootDigest = await this.digest();
    this.rootSnapshotId = await this.desktop.snapshot("cartographer-root");
  }
  async activeWindowTitle(): Promise<string> { const r = await this.desktop.exec("sh", { args: ["-c", `DISPLAY=:0 ${this.m.desktop!.windowTitleCmd} 2>/dev/null || echo ""`] }); return r.stdout.trim(); }
  async digest(): Promise<string> { /* identical find|sha256sum over m.dataPaths via desktop.exec("sh", …) */ }
  async revertToRoot(): Promise<number> {
    const t0 = Date.now(); await this.desktop.revert(this.rootSnapshotId);
    await retry(() => this.desktop.reconnect(), { tries: 6, baseMs: 1000 }); await this.waitHealthy(60_000);
    await this.waitWindow(this.m.desktop!.readyWindowTitle, 30_000).catch(async () => { await this.desktop.open(this.m.desktop!.app, this.m.desktop!.args); await this.waitWindow(this.m.desktop!.readyWindowTitle, 60_000); });
    const d = await this.digest(); if (d !== this.rootDigest) throw new Error("revert did not restore root digest");
    return Date.now() - t0;
  }
  async screenshot(): Promise<Buffer> { return Buffer.from(await this.desktop.screenshot({ format: "png" })); }
  async click(x: number, y: number) { await this.desktop.mouse.move(x, y, { humanize: true }); await this.desktop.mouse.click(x, y, { button: "left", humanize: true }); }
  async pressEscape() { await this.desktop.keyboard.press("Escape"); }
  async startRecording() { await this.desktop.record.start({ fps: 5 }); }                       // in-guest recording; restart after every revert
  async stopRecording(): Promise<Buffer> { const p = await this.desktop.record.stop(); const { url } = await this.desktop.downloadUrl(p); return Buffer.from(await (await fetch(url)).arrayBuffer()); }
  async kill() { try { await this.client.kill(this.id); } catch {} }
}
```
Notes baked into code comments: `desktop.exec` is a convenience over the control channel (no shell → `sh -c`); the desktop is also a sandbox, so `snapshot/revert/files` work; **server-side `record: true` only works on golden-template boots and stops at the first `revert()`**, which is why in-guest `record.start/stop` is used per episode window (start after each revert). If `xdotool` is missing and cannot be installed, set `windowTitleCmd` to `echo ""` and rely on phash only (state `urlPath` becomes `""`; `resolveState` then matches on phash alone with hamming ≤ 8 — implement this branch in `resolveState`: when `obs.urlPath === ""`, ignore urlPath).
**Verify:** `tsx scripts/e2e-desktop.ts --boot-only` boots the fallback LibreOffice target, prints the active window title, a 1280×800 PNG is saved, digest is 64-hex; then GnuCash: install time and boot time recorded in `NOTES.md`.

### Step 3 — App egress block (Principle 3 for desktop)
`blockAppEgress()`: inside the VM, if `iptables` exists: `iptables -A OUTPUT -o lo -j ACCEPT; iptables -A OUTPUT -j DROP` after the control channel is established (the control channel is vsock/host-side, not guest TCP — ⚠️ verify by testing that `desktop.exec` still works after the rule; if it breaks, fall back to `unshare -n`-style app launch: `app` started via `sh -c "unshare -n <app> <args>"` requires root; if neither works, set `allowNetwork: true`, log a warning into `run.notes`, and document it). The point is that a GUI app being explored must not phone home or send email when a button is clicked.
**Verify:** after the block, `desktop.exec("sh",{args:["-c","curl -m 3 -sI https://example.com >/dev/null; echo $?"]})` prints non-zero while `desktop.screenshot()` still works.

### Step 4 — DesktopActor
`src/explore/desktopActor.ts`:
```ts
export class DesktopActor implements Actor {
  kind = "desktop" as const;
  constructor(private host: DesktopHost, private m: TargetManifest, private rootPhash: () => string | null) {}
  async observe(): Promise<Observation> { const png = await this.host.screenshot(); const title = await this.host.activeWindowTitle();
    return { png, visible: "", doms: [], url: "desktop://" + this.m.desktop!.app, title }; }
  async clickAt(x, y) { await this.host.click(x, y); await sleep(this.m.desktop!.settleMs); }
  async reach(state, doc) { await this.resetToRoot(); for (const eid of state.pathFromRoot) { const e = doc.edges.find(x => x.id === eid)!; await this.clickAt(e.action.x, e.action.y); }
    const obs = await this.observe(); const r = resolveState({ urlPath: normTitle(obs.title), phash: await dHash(obs.png), domDigest: "" }, doc.states); return r?.id === state.id; }
  async resetToRoot() { await this.host.pressEscape(); await this.host.pressEscape(); await sleep(400);
    const ph = await dHash(await this.host.screenshot()); const root = this.rootPhash(); if (root && hamming(ph, root) > 8) { await this.host.revertToRoot(); } }
  async close() {}
}
```
`normTitle(t)`: lowercase, strip digits and `*` (unsaved marker), collapse spaces. State creation for desktop: `urlPath = normTitle(title)`, `domDigest = ""`, `kind: "desktop"`. Explorer: in desktop mode, `observeAndRegister` uses hamming ≤ 8 (dialogs shift pixels); `revert` after mutation is followed by `host.startRecording()` again; the per-episode mp4 is saved as `shots/<edgeId>.mp4` only for mutated edges (evidence of "clicked Delete → reverted"), else discarded, to bound repo size.
Explorer wiring: `host = source.type === "desktop-app" ? new DesktopHost() : …`; `actor = kind === "desktop" ? new DesktopActor(...) : new BrowserActor(...)`; root state for desktop = first observation after boot.
**Verify:** `npm run e2e:desktop` on GnuCash (or fallback) with `maxActions: 30`: ≥ 12 states, ≥ 2 mutated+reverted edges (e.g. delete account/transaction, save), each with an mp4; viewer shows the desktop badge; `NOTES.md` records desktop revert p50.

### Step 5 — Parallel workers via forks
1. `src/solari/host.ts`: add `fork(): Promise<Host>` — `SandboxHost.fork()` = `client.create({ fromSnapshot: this.rootSnapshotId, memMb: sameAsRoot, cpu: same, timeoutMs, lifecycle: {onTimeout:"kill"}, metadata })` → new `SandboxHost` sharing `rootSnapshotId`/`rootDigest`, own `id`, own preview URL (`refreshPreview` + `waitReady`; if the server isn't alive after fork, `startServer`). `DesktopHost.fork()` analogous. `LiveHost.fork()` = new `LiveHost` (no VM).
2. `src/explore/frontier.ts`: `claim() → FrontierItem | null` (moves item to `inflight`), `release(item, ok)` (on failure re-queue once). Since workers are async tasks in one process, no locks are needed; keep every frontier/store/edge-id operation synchronous between `await`s.
3. `src/explore/worker.ts`: `runWorker(i, ctx)` loop: `claim` → `episode` → `release`; each worker has its own `Host` (fork for i > 0), its own `BrowserPool`/actor, and its own `rootDigest` check against its own machine. Edge gets `worker: i`. `run.forkIds` records fork ids.
4. Explorer: `--workers N` → cap N by plan: try creating forks; on `429 ConcurrencyLimitExceeded` stop creating more, log "plan allows K running VMs; continuing with K workers" — never crash. Budget counters are shared. Reverts are per machine.
5. Teardown: kill all forks and the root; delete the root snapshot unless `--keep-snapshot`.
**Verify:** `tsx scripts/e2e-workers.ts` with `--workers 2` on target-shop: two distinct `sandboxId`s in `run.forkIds`, edges carry `worker: 0|1`, no duplicate edges for the same `(from, affordanceId)`, wall time lower than the 1-worker run of the same budget (record both numbers). Console shows zero running VMs afterwards.

### Step 6 — Viewer watch mode
`view --watch`: page polls `map.json` every 2 s and diffs node/edge ids; new nodes animate in; a counter shows "states / edges / reverted mutations / est. $" from `runs[last].spent`. This is the "watch the map grow" shot for the demo.
**Verify:** run `explore` and `view --watch` side by side; the graph grows live.

### Step 7 — Site builder + GitHub Pages
`src/site/build.ts` → `site/`: `index.html` (cards from `SiteMapEntry[]` computed from every `maps/*/map.json`: mode badge, counts, cost, cover = root screenshot thumbnail), `maps/<name>/index.html` (the viewer with `map.json` and thumbnails inlined/relative), `bench.html` (all `bench/results/*-latest.md` rendered), `media/` (the GnuCash reverted-delete mp4 or a YouTube embed if > 25 MB), `about.html` (README pitch + loop diagram). Thumbnails: `sharp` resize to 480px width (WHY: repo/site size). `.github/workflows/pages.yml`: on push to `main`, `npm ci && npm run site:build`, upload `site/` with `actions/upload-pages-artifact` + `actions/deploy-pages` (⚠️ verify current action versions). Set `CARTO_SITE_BASE` so relative links work under `https://<user>.github.io/cartographer/`.
**Verify:** site deploys; opening a map page renders the graph with screenshots; `bench.html` shows the tables; total site size < 60 MB.

### Step 8 — Demo path (rock-solid)
`demo/demo.sh` (bash, idempotent, numbered stages, each with a hard timeout and a fallback):
1. **Hook (0:00–0:20):** open the site index (pre-built) — "these are maps of apps, made by an agent that can press Delete safely."
2. **Watch it explore (0:20–1:20):** `cartographer explore examples/target-shop/carto.target.json --max-actions 12 --workers 2` with `view --watch` open. Fixed budget so it ends in ~60 s. Point at a red edge: "it pressed Refund, saw the database change, reverted the VM in N ms."
3. **Ask the map (1:20–2:00):** in Claude Code with the MCP registered: "How do I refund order 3?" → `atlas_route` output. Then `cartographer bench …` is NOT run live — show `bench/results/target-shop-latest.md`: "with-map X/Y in A steps vs naive X'/Y in B steps."
4. **Desktop (2:00–2:45):** play `demo/media/gnucash-delete-reverted.mp4` (recorded in Step 4): screenshot-only exploration of a legacy finance app; Delete → digest changed → revert. "No DOM, no API — just pixels, like Pinetree's agents."
5. **Close (2:45–3:00):** users' numbers from `USERS.md`; repo, npm, site links; "what I'd build next inside Pinetree."
`demo/PITCH.md` has the exact words per stage and the fallbacks: if Solari returns 429/503 during stage 2, play `demo/fallback.mp4` (a recording of a successful stage 2) and say so. `demo/checklist.md`: kill stray VMs, credits ≥ $5, MCP registered, site deployed, fallback video present, terminal font size, network.
**Verify:** rehearse three times end-to-end with a timer; all three under 3:15; record the best as `fallback.mp4`.

### Step 9 — Cookbook fork + PR
In a separate clone of **your fork** of `solari-sdk/solari-cookbook` (must be a real GitHub fork, public):
1. `examples/cartographer-ts/` — one small, self-contained example in cookbook style: `index.ts` (~150 lines): create sandbox → upload a 40-line Flask app (inline string) → start → preview URL → `snapshot()` → in a cloud browser click a "Delete" button by coordinates → digest changes → `revert()` → digest restored → print timings. `README.md`: what it shows ("snapshot/revert as an undo button for agents"), run steps, and the gotchas encountered as comments "right where they bite" (preview token header, `sh -c`, `kill()` vs `close()`, revert drops the control channel → `reconnect()`, exec cap → nohup). `package.json` with `@solarisdk/sandbox`, `@solarisdk/browser`, `tsx`, `typescript`; `.env.example` with `SOLARI_API_KEY=slr_live_...` only.
2. `projects/cartographer/README.md` — 10-line pointer: what Cartographer is, links to the main repo, npm, site, benchmark; the challenge hashtag-free, factual.
3. Add one row to the cookbook's root README examples table under Sandbox: `cartographer-ts | TypeScript | Snapshot, act, detect mutation, revert`.
4. Open a PR to `solari-sdk/solari-cookbook` containing **only** `examples/cartographer-ts` and the README row (small, reviewable). Title: `Add sandbox-snapshot-revert example: undo an agent's action (cartographer-ts)`. Body: what it shows, how to run, measured revert time, 2 gotchas.
**Verify:** `cd examples/cartographer-ts && npm i && npm start` runs green from the fork; PR opened; fork URL recorded in `docs/SUBMISSION.md`.

### Step 10 — Bug/gotcha reports
From `NOTES.md` across all phases, for each verified item: reproducible steps, SDK version, expected vs actual. File via Discord `#support-requests` (private, per server rules — no keys, no screenshots with tokens). Candidates you likely have: revert latency numbers; whether the app process survives revert (RAM restore) or needs restart; browser session death timing; any SDK `.d.ts` mismatches vs docs; `record: true` + revert behavior; preview 401/425 timings; desktop `xdotool` availability. If a docs page is wrong/missing, open a **separate tiny PR** to the cookbook README "Gotchas" section (that pattern was publicly thanked). Track all in `docs/bug-reports.md` (what, where, date, status).
**Verify:** ≥ 3 reports filed; `docs/bug-reports.md` complete.

### Step 11 — Users
`docs/try-it.md`: 5-minute path for an agent developer: `npx solari-cartographer init <their app repo>` → explore with `--max-actions 30` → `route` → optional MCP. Recruit 4–5 people from the Solari Discord (`#showcase` thread replies, `#open-space`) and X (people who posted browser-agent builds). Ask each for: their app name (or "private"), states mapped, one goal + naive vs with-map step count (they can run `bench` if their app has a check, else just `route` + manual count), and a one-sentence quote with permission to publish. `USERS.md`: table + quotes, dates. Respond to every issue they hit within a day; each fix is a commit and a public update post.
**Verify:** `USERS.md` has ≥ 4 entries with consented quotes; ≥ 2 external maps exist (in their repos or shared privately — do not commit users' maps without permission).

### Step 12 — Publish + posts + submission
1. **npm:** `npm view solari-cartographer` — if taken, publish as `@<your-npm-handle>/cartographer` keeping bin `cartographer`; update README/docs commands accordingly. `npm publish --access public` at `1.0.0`; verify `npx solari-cartographer@latest --help` (or scoped) from an empty dir.
2. **Repo hygiene:** MIT `LICENSE`, `CONTRIBUTING.md` (short), topics `solari`, `computer-use`, `agents`, `mcp`, `world-model`; GitHub description = one-liner; social preview image = site index screenshot; releases: tag `v1.0.0` with notes.
3. **`docs/POST-final.md`** — update the Phase 2 drafts with final numbers: states across all maps, reverted mutations count, revert p50 (web and desktop), bench headline, users count + a quote, site/npm/repo links, the cookbook PR link, and the ask ("try it on your app; tell me the step count"). X: a hook tweet + 5-tweet thread (map GIF, red-edge screenshot, bench table image, GnuCash video, links); LinkedIn: ~150 words + video; Discord `#showcase`: What / Problem / Stack / Demo+repo / Feedback wanted. Tag exactly `@harrychow_` and `@getsolari` (LinkedIn: Harry Chow, Solari). No API keys, no tokens, no user credentials in any media.
4. **`docs/SUBMISSION.md`** — checklist (§12) with links and dates; post the final posts; reply to comments within 24 h; plan 2 follow-up "build in public" updates (a new user's map; a new real-app map) for the following week.
**Verify:** all links resolve from a private browser window; posts published; `docs/SUBMISSION.md` fully checked.

---

## 9. API / Interface Contracts

**Actor** (§7): `observe() → Observation`, `clickAt(x,y)`, `reach(state, doc) → boolean`, `resetToRoot()`, `close()`.

**Host additions:** `fork() → Promise<Host>` (new machine at root state, sharing `rootSnapshotId`/`rootDigest`); `DesktopHost` adds `screenshot() → Buffer`, `click(x,y)`, `pressEscape()`, `activeWindowTitle() → string`, `startRecording()`, `stopRecording() → Buffer`.

**CLI additions**
| Command | Behavior |
|---|---|
| `explore <manifest> [--workers N] [--keep-snapshot]` | N capped by plan; forks from root snapshot; desktop mode when `source.type = "desktop-app"` |
| `view [mapDir] [--watch]` | polls map.json every 2 s |
| `site:build` (npm script) | regenerates `site/` from `maps/`, `bench/results`, `docs/` |

**Solari facts relied on (desktop):** `createDesktop()`/`POST /sandboxes {kind:"desktop"}`; `connect()` before any GUI method; `health()` → `{ready, display, vnc}`; `mouse.click(x,y,{humanize})`, `keyboard.press`, `screenshot({format:"png"})` → bytes; `open(app,args)` → pid; `exec` is `sh`-less; desktops are sandboxes (snapshot/revert/files work; `revert` drops connections → `reconnect()`); server-side `record:true` works only on golden-template boots and ends at revert; in-guest `record.start/stop` → mp4 path → `downloadUrl(path)`; forks via `create({fromSnapshot})` inherit memory topology (pass same `memMb`) and keep the snapshot's disk size; concurrency cap counts running (not paused) machines; 429 is never retried by SDKs.

**Site contract:** `site/index.json` = `SiteMapEntry[]`; each map page loads `./map.json` (copied) and `./shots/*` (thumbnails).

---

## 10. Error Handling & Edge Cases

| Situation | Handling |
|---|---|
| Desktop template lacks `xdotool` and apt install fails | `windowTitleCmd = "echo"`, phash-only state identity (hamming ≤ 8); note in run. |
| GnuCash install > 15 min or app never shows the window | Fall back to `examples/libreoffice-calc`; record in `NOTES.md`; the demo still shows a reverted mutation (Save). |
| After `revert()` the GUI app is not running (RAM restore didn't preserve it) | `revertToRoot` re-opens the app and waits for the window; count as a note; this is a bug report candidate. |
| Modal dialog blocks everything (e.g. "Save changes?") | `resetToRoot` presses Escape ×2; if phash still ≠ root → revert. Affordance whose click opened a blocking dialog remains a valid edge (state = dialog). |
| Click on a menu that opens a submenu which closes on the next screenshot | Desktop `settleMs` ≥ 1500; screenshots are taken without moving the mouse afterwards. |
| Egress block breaks the control channel | Detect immediately (`exec` fails) → `revert()` isn't possible yet; kill and reboot with `allowNetwork: true` + warning; document. |
| Fork creation 429 | Continue with fewer workers; never abort a run for lack of parallelism. |
| Two workers claim the same `(state, affordance)` | Impossible by construction (single-process `claim()`); assert in `e2e-workers` anyway. |
| A worker's machine dies mid-run (503/`gone`) | Mark its in-flight item failed, `release(item, false)` (re-queue once), drop the worker; run continues with the rest. |
| Snapshot deletion blocked (`409 SnapshotHasChildren`) | Kill forks first, then root, then delete snapshot; on failure log the id for manual cleanup and print the console URL. |
| Site > 60 MB | Thumbnails only (no full-size shots on the site); videos via YouTube link. |
| Demo day: Solari incident | Fallback video per stage; say it plainly. |
| npm name taken | Scoped publish; update every doc/command in one commit. |
| User's app needs Node ≥ 20 in the sandbox | `docs/manifest.md` Node-22 tarball recipe; help them in DM; add the recipe to `init` notes if not already. |
| A user asks you to commit their map | Only with written OK; otherwise summarize numbers in `USERS.md`. |

---

## 11. Testing & Verification

- **Unit:** all previous tests + `actor` tests with a fake host (reach replays path; resetToRoot reverts when phash drifts); `frontier` claim/release tests; `site/build` test on the target-shop map (index entry counts match map.json).
- **Integration:** `npm run e2e` (web, 1 worker) unchanged; `tsx scripts/e2e-workers.ts --workers 2` (web, forks); `npm run e2e:desktop` (desktop, ≥ 12 states, ≥ 2 reverted mutations with mp4s); `npm run test:mcp`.
- **Regression:** map state ids for target-shop unchanged vs Phase 2 (`resolveState` semantics untouched for web).
- **Site:** `npm run site:build && npm run site:serve` → click every map; check bench page; check video plays.
- **Demo:** three timed rehearsals (§8 Step 8) with `demo/checklist.md` before each.
- **Fresh machine:** clone → `npm ci && npm run build && npm test` → `npx <published pkg> init https://books.toscrape.com` works.

---

## 12. Definition of Done — Submission Checklist (mapped to the judging criteria)

**Product-market fit / real users (35%)**
- [ ] `USERS.md`: ≥ 4 users, consented quotes, their step counts; ≥ 2 external apps mapped.
- [ ] `npx` install works from a clean machine; `docs/try-it.md` is the 5-minute path.
- [ ] Benchmark tables (sample + ≥ 1 real app) published on the site with method and caveats.

**Shipped, polished, built in public (20%)**
- [ ] npm published `1.0.0`; GitHub release; site live with ≥ 5 maps (target-shop, ≥ 2 real web apps, GnuCash or fallback desktop, ≥ 1 live-mode map).
- [ ] Posts published on X, LinkedIn, Discord `#showcase` in the required format, tagging `@harrychow_` and `@getsolari`; two follow-up updates scheduled.
- [ ] 3-minute demo rehearsed ×3; fallback video recorded.

**Solari depth (20%)**
- [ ] Uses sandbox + snapshot/revert + fork + preview URL + cloud browser (fast pool) + stealth (live) + desktop (screenshot/mouse/keyboard) + recording.
- [ ] ≥ 3 bug/gotcha reports filed; `docs/bug-reports.md`; cookbook PR opened with a small runnable example; fork is public and a true fork of `solari-sdk/solari-cookbook`.
- [ ] Measured numbers published: web revert p50, desktop revert p50, session-relaunch count, cost per map.

**Differentiation / thesis alignment (25%)**
- [ ] Desktop map exists with ≥ 2 reverted destructive actions and video evidence, screenshot-only (no DOM anywhere in desktop code: grep `evaluate(` in `src/explore/desktopActor.ts` and `src/solari/desktopHost.ts` returns nothing).
- [ ] README states the world-model framing and the vision-first invariant in the first screen.
- [ ] Repo hygiene: LICENSE, topics, description, social preview, `CONTRIBUTING.md`.

**Safety of the process**
- [ ] No API keys/tokens/user credentials in any commit, screenshot, or video (search history: `git log -p | grep -c slr_live_` = 0).
- [ ] Zero running Solari VMs and no orphan snapshots after the final run.

---

## 13. Notes & Pitfalls

- **Don't rebuild what exists.** Phases 1–2 code is the base; this phase adds `Actor`, desktop, forks, site, demo, submission. Resist refactoring the explorer beyond the `Actor` extraction.
- **Desktop mode is the showpiece; keep its scope tight.** One legacy finance app, ≥ 12 states, ≥ 2 reverted mutations, one great video. Don't chase desktop benchmarks.
- **Recording behaviors are subtle:** server-side `record: true` is per-boot and dies at revert; in-guest recording restarts after each revert. Save mp4s only for mutated edges.
- **Forks inherit memory topology** — always pass the root's `memMb`. `diskGb` is ignored on forks.
- **Reverting to a shared snapshot from a fork** is allowed (any snapshot your org owns); each machine reverts *itself*.
- **Snapshot storage bills from Oct 1, 2026** (10 GB free/org): delete run snapshots at teardown unless `--keep-snapshot`.
- **Starter = 2 running VMs.** `--workers 2` is the max there; the demo runs with 2. Don't buy Pro unless a user needs it.
- **Site size discipline:** thumbnails, zipped full-size shots, videos external.
- **Cookbook PR must be small.** The full project lives in your repo; the PR is one runnable example + one README row. Big PRs in that repo sit unreviewed.
- **Bug reports go to `#support-requests`, privately** — posting them publicly violates the server rules and reads as hostile. A README-gotcha PR is the public-facing form.
- **Posts:** numbers, evidence, links, a specific ask. No hype words. Don't @-spam; one tag each of `@harrychow_` and `@getsolari` per post. Never include demo credentials.
- **Reserve ~90 h** for platform surprises, user support, and the follow-up updates. Do not spend the reserve on features.
- Everything from Phases 1–2 still applies: `sh -c`, `connect()`, `kill()`, preview token header, session relaunches, `newContext({storageState})`, MCP stdout, stealth only live, proxy degradation check.

---

## 14. Handoff — Deploy & Submission Steps (final)

**What works now:** Cartographer maps web apps (sandbox with revert, live read-only) and desktop apps (screenshot-only), optionally in parallel via forks; agents query maps via MCP; benchmarks quantify the gain; maps are hosted publicly; the demo is rehearsed.

**Final sequence (do in this order, same day):**
1. `npm test && npm run e2e && npm run e2e:desktop && npm run test:mcp` green; kill all VMs; delete run snapshots.
2. `npm version 1.0.0 && npm publish --access public`; verify `npx` from a clean directory.
3. `npm run site:build`; commit; push; confirm Pages deploy; open every map page once.
4. Update `README.md`/`USERS.md`/`docs/benchmark.md` with final numbers; commit; tag `v1.0.0`; GitHub release with the demo video link.
5. Cookbook fork: confirm `examples/cartographer-ts` runs; `projects/cartographer/README.md` links resolve; PR open.
6. Publish `docs/POST-final.md`: Discord `#showcase` first (team watches it), then X thread, then LinkedIn. Tag `@harrychow_` and `@getsolari` exactly.
7. Fill `docs/SUBMISSION.md` with every link and timestamp; set reminders for the two follow-up updates and for replying to comments within 24 h.

There is no Phase 4. After submission, the work is: respond to users, ship the two follow-up updates, and keep the site green.
