# CARTOGRAPHER — PHASE 1: Foundation & Thin End-to-End Slice

> You are the builder. You have ONLY this file. It contains everything you need: project context, architecture, exact stack, data model, and step-by-step instructions. Do not assume any prior conversation. If something is marked ⚠️ verify, check it against the live docs/package before relying on it.

---

## 1. Project & Challenge Context

### The challenge (ground truth)
- **Who:** Pinetree Research (Palo Alto AI lab, ~6 people) is hiring one remote SWE intern ("$300K annualized") via a public build challenge run by Harry Chow (Head of Growth & Ops, X `@harrychow_`). Pinetree builds **pure-vision computer-use agents** (screen/keyboard/mouse; explicitly not DOM/API-based) and states its architecture is "a general reasoning engine + a specialized world model."
- **Their product we must build on:** **Solari** (getsolari.com) — cloud infra for agents behind one API key `slr_live_…` and one base URL `https://api.getsolari.com`:
  - **Cloud browsers** (Playwright-shaped, stealth/proxies/captcha on paid plans, session recording).
  - **Sandboxes** (headless Linux microVMs: commands, files, git, port preview URLs, **snapshot / revert / fork**).
  - **Desktops** (same microVM + X display + VNC; mouse/keyboard/screenshot API).
- **Rules:** fork `https://github.com/solari-sdk/solari-cookbook`, build "a real use case" with Solari, publish on public GitHub (standalone repo + a copy inside the fork is officially fine), post on X/LinkedIn tagging `@harrychow_` and `@getsolari`. Judged on: **product-market fit, real users, building in public.** ~500 submissions. **No deadline announced; it can be announced any day** → ship a public v0 early, iterate publicly.
- **The field:** ~1/3 of entries are "QA for AI-generated code" (sandbox builds repo → browser tests it). Almost nobody uses snapshot/revert as an agent primitive or the desktop primitive. Nobody builds world models.

### The product: Cartographer
**One-liner:** *Build a map of any app before your agent touches it.* Cartographer hosts a target app inside a Solari sandbox, snapshots the booted world, and explores every clickable path **vision-first** (screenshot → Gemini proposes affordances → click by coordinates). Any action that mutates the app's data is detected by digesting the app's data files and **undone with `revert()`** to the root snapshot, so exploring "Delete" and "Refund" is safe. Output: a **map** — states, affordances, edges, mutation flags, screenshots — that any agent can later query to complete tasks in fewer steps.

**Why it wins:** it produces the "world model" Pinetree says agents need, using the two Solari primitives nobody else uses (snapshot/revert, desktop), and is vision-first like Pinetree's own agents.

**Non-negotiable principles (apply in every file you write):**
1. **Vision-first.** Which element to click is decided from the screenshot. Clicks are executed by coordinates. DOM data is captured only as *metadata/cross-check* and must never be the thing that decides or executes an action.
2. **Fail-closed.** No state exists without a screenshot on disk. No edge exists without before/after digests. If anything is uncertain, record it as `unknown`, never as success.
3. **No external side effects.** The exploring browser may only talk to the sandbox preview host; all other network requests are aborted.
4. **Every mutation is reverted.** If the data digest changes after an action, the sandbox is reverted to the root snapshot before continuing.
5. **Everything is measured.** Actions, states, vision calls, reverts, VM/browser minutes, estimated USD go into `map.json`.

### Phase arc (700 engineering hours total, solo)
- **Phase 1 (this file, ~110 h):** scaffold, sample target app, sandbox host with snapshot/revert, cloud browser pool, Gemini affordances, BFS explorer, `map.json` + screenshots, static viewer. Result: `cartographer explore` produces a real map of the sample app with ≥1 reverted mutation.
- **Phase 2 (~250 h):** CLI polish + npm publish, MCP server (`atlas_route` etc.), live-URL read-only mode, solver agent + with/without-map benchmark, maps of real OSS apps, first users.
- **Phase 3 (~250 h):** desktop (screenshot-only) mode, parallel forks, hosted maps site, demo path, cookbook fork/PR, bug reports, submission.

---

## 2. Architecture Overview

```
 ┌────────────┐  carto.target.json   ┌──────────────────────────────────┐
 │ CLI        │ ───────────────────▶ │ Explorer: BFS over (state, aff.) │
 │ (P1)       │                      │ budget · frontier · dedupe       │
 └────────────┘                      └────┬─────────────┬────────────┬─┘
                          ┌───────────────▼───┐  ┌──────▼───────┐ ┌──▼──────────┐
                          │ SandboxHost       │  │ BrowserPool  │ │ Vision      │
                          │ boot app · digest │◀─│ Solari cloud │ │ Gemini:     │
                          │ snapshot · revert │  │ Chrome       │ │ screenshot →│
                          │ previewUrl(port)  │─▶│ click / shot │ │ affordances │
                          └───────────────────┘  └──────┬───────┘ └─────────────┘
                                                        ▼
                                          ┌──────────────────────────┐
                                          │ MapStore maps/<name>/    │
                                          │ map.json · shots/*.png   │
                                          └──────┬───────────────────┘
                                                 ▼
                                          ┌──────────────────────────┐
                                          │ Viewer (static HTML +    │
                                          │ Cytoscape from CDN)      │
                                          └──────────────────────────┘
```

**One exploration episode (the core loop):**
1. Pop `(stateId S, affordance A)` from the frontier.
2. Ensure the world is at the root snapshot: `digest() === rootDigest`, else `revert(rootSnapshotId)` + reconnect + wait for app ready.
3. Browser: reach S (navigate to `S.url`; verify the observed stateId matches S; if not, replay `S.pathFromRoot` actions from the root URL).
4. Take `before` screenshot; click at A's bbox center; wait for network idle / settle (1.2 s).
5. Observe: screenshot + URL + normalized visible text → compute `phash`, `domDigest` → resolve to an existing state (same `urlPath` and hamming(phash) ≤ 6) or create a new `StateNode`.
6. `digest()` again. If changed → edge `mutated=true`, revert sandbox, `reverted=true`.
7. Persist edge S→T. If T is new: call Vision on T's screenshot, attach affordances, push them to the frontier (except blocklisted labels).
8. Repeat until budget exhausted or frontier empty. Save `map.json` after every episode (resumable).

**Components and boundaries**
| Component | File | Responsibility | Talks to |
|---|---|---|---|
| CLI | `src/cli.ts` | parse args, load manifest, run explorer, serve viewer | Explorer, MapStore |
| Explorer | `src/explore/explorer.ts` | BFS, frontier, budget, episode loop | SandboxHost, BrowserPool, Vision, Perception, MapStore |
| SandboxHost | `src/solari/sandboxHost.ts` | create sandbox, install/start app, preview URL, digest, snapshot, revert | Solari VM API |
| BrowserPool | `src/solari/browserPool.ts` | launch cloud browser, storageState login, network allowlist + preview token, auto-relaunch | Solari browser API |
| Vision | `src/vision/gemini.ts` | screenshot → affordance JSON | Gemini API |
| Perception | `src/perception/stateId.ts` | dHash, text digest, state matching | — (pure) |
| MapStore | `src/map/store.ts` | load/save `map.json`, write screenshots | disk |
| Sample target | `examples/target-shop/` | Flask + sqlite admin app with mutating actions | — |
| Viewer | `viewer/index.html` | render map graph | reads `map.json` |

---

## 3. Current State

**Nothing exists yet.** Empty repository. This phase creates everything from scratch.

---

## 4. Phase Goal & Scope

**Goal:** A minimal but real end-to-end run: `npx tsx src/cli.ts explore examples/target-shop/carto.target.json --max-actions 40` boots the sample app in a Solari sandbox, explores it vision-first in a Solari cloud browser, reverts at least one mutating action, and writes `maps/target-shop/map.json` + screenshots that render in the viewer.

**In scope**
- Repo scaffold, TypeScript config, env handling, logging.
- Sample target app (`examples/target-shop`) with login, list/detail pages, and mutating actions (refund, delete, settings save).
- `TargetManifest` JSON schema + loader with validation.
- SandboxHost: create → install (long-running, nohup+poll) → start server → preview URL → ready poll → root snapshot → digest → revert → reconnect.
- BrowserPool: launch (fast pool, no stealth), login recipe → storageState, new context per episode with route handler (preview token header + external-host abort), viewport 1280×800, screenshot, coordinate click, auto-relaunch on disconnect.
- Vision: Gemini structured output → `Affordance[]`.
- Perception: dHash (64-bit), text digest, state resolution.
- Explorer: BFS with budget, mutation detection, revert, resumable persistence.
- MapStore + `map.json` format v1.
- Viewer: static page rendering states/edges with screenshots on hover.
- Unit tests for pure modules; one integration script against the real API.

**Out of scope (do NOT build here)**
- MCP server, `atlas_route`, path search, solver agent, benchmarks (Phase 2).
- Live-URL (no sandbox) mode (Phase 2).
- Desktop mode, parallel forks, hosted site, npm publishing, submission posts (Phase 3).
- Any DOM-driven action execution (never).

---

## 5. Prerequisites & Setup

**Accounts / keys**
- Solari account with API key (`slr_live_…`) from https://console.getsolari.com. **Starter plan ($20/mo) is required** — Free plan allows 1 machine and 1-hour sessions, which is too tight for snapshot/revert loops. Note: the console's first "create key" modal may close before you copy the secret (known bug) — just create a second key.
- Gemini API key from Google AI Studio.

**Local tools:** Node 22 LTS, npm 10+, git. Python is not needed locally (the sample app runs inside the sandbox).

**Install**
```bash
mkdir cartographer && cd cartographer && git init
npm init -y
npm pkg set type=module name=solari-cartographer version=0.1.0 license=MIT
npm pkg set engines.node=">=22"
npm i @solarisdk/sandbox@^0.1.3 @solarisdk/browser@^0.1.3 @google/genai sharp commander zod pino dotenv
npm i -D typescript tsx vitest @types/node
npx tsc --init --target ES2022 --module NodeNext --moduleResolution NodeNext --outDir dist --rootDir . --strict --esModuleInterop --resolveJsonModule --skipLibCheck
```
**Verified against docs.getsolari.com (2026-09-07):** `@solarisdk/sandbox` exports `SandboxClient` (methods `create`, `createDesktop`, `connect`, `get`, `list`, `kill`, `listSnapshots`, `deleteSnapshot`) and the `Sandbox` handle (`connect`, `reconnect`, `close`, `commands.run/start`, `files.*`, `git.clone(url, {path, branch, depth})`, `snapshot(name?) → Promise<string>`, `revert(id) → Promise<void>`, `previewUrl(port) → {url, token?}`, `kill`). `@solarisdk/browser` exports `Solari` with `launch()`. Still open `node_modules/@solarisdk/*/dist/*.d.ts` after install to confirm nothing changed. The API surface documented at https://docs.getsolari.com/sdk/typescript/sandboxes and https://docs.getsolari.com/sdk/typescript/browser is the reference; where this file and the `.d.ts` disagree, the `.d.ts` wins — adapt names, not behavior.

**Environment (`.env.example`, copy to `.env`; never commit `.env`)**
```
SOLARI_API_KEY=slr_live_xxx
SOLARI_BASE_URL=https://api.getsolari.com
GEMINI_API_KEY=xxx
GEMINI_MODEL=gemini-3.7-flash
CARTO_MAPS_DIR=./maps
LOG_LEVEL=info
```
No Solari SDK reads env vars — you must pass `apiKey`/`baseUrl` explicitly from `src/config.ts`.

**package.json scripts**
```json
{
  "scripts": {
    "build": "tsc -p .",
    "dev": "tsx src/cli.ts",
    "test": "vitest run",
    "e2e": "tsx scripts/e2e-explore.ts"
  }
}
```

---

## 6. File Structure for This Phase

```
cartographer/
├── package.json                      NEW
├── tsconfig.json                     NEW
├── .env.example                      NEW
├── .gitignore                        NEW  (node_modules, dist, .env, maps/*/shots, *.log)
├── README.md                         NEW  (short: what it is, how to run)
├── src/
│   ├── config.ts                     NEW  env loading + validation (zod)
│   ├── log.ts                        NEW  pino logger
│   ├── types.ts                      NEW  ALL shared types (data model below)
│   ├── manifest.ts                   NEW  load + validate carto.target.json
│   ├── util/
│   │   ├── hash.ts                   NEW  sha256, shortId
│   │   ├── sleep.ts                  NEW  sleep, withTimeout, retry
│   │   └── budget.ts                 NEW  Budget class (counters + estUsd)
│   ├── perception/
│   │   └── stateId.ts                NEW  dHash, textDigest, hamming, resolveState
│   ├── vision/
│   │   └── gemini.ts                 NEW  screenshot → Affordance[]
│   ├── solari/
│   │   ├── sandboxHost.ts            NEW  sandbox lifecycle, digest, snapshot/revert
│   │   └── browserPool.ts            NEW  cloud browser lifecycle, contexts, actions
│   ├── explore/
│   │   ├── frontier.ts               NEW  FIFO frontier with dedupe
│   │   └── explorer.ts               NEW  episode loop
│   ├── map/
│   │   └── store.ts                  NEW  load/save map.json, screenshots
│   └── cli.ts                        NEW  `explore`, `view`
├── viewer/
│   └── index.html                    NEW  static graph viewer
├── examples/
│   └── target-shop/
│       ├── app.py                    NEW  Flask + sqlite sample admin app
│       ├── requirements.txt          NEW  flask==3.0.3
│       └── carto.target.json         NEW  manifest for the sample
├── scripts/
│   └── e2e-explore.ts                NEW  integration run with small budget
└── test/
    ├── stateId.test.ts               NEW
    ├── frontier.test.ts              NEW
    └── store.test.ts                 NEW
```

---

## 7. Data Model / Schema

Put exactly these in `src/types.ts`. Later phases extend but never rename.

```ts
// src/types.ts
export type Bbox = { x: number; y: number; w: number; h: number }; // screenshot pixels
export type ActionKind = "click" | "type" | "press" | "navigate";
export type Risk = "read" | "write" | "unknown";

export interface DomHint {            // cross-check metadata ONLY — never used to act
  tag: string; text: string; selectorHint: string; bbox: Bbox; href?: string;
}

export interface Affordance {
  id: string;                         // "a_" + sha10(stateId + label + round(cx) + round(cy))
  stateId: string;
  label: string;                      // e.g. "Refund order button"
  kind: ActionKind;                   // P1 only produces "click"
  bbox: Bbox;
  expected: string;                   // model's one-line guess of the effect
  risk: Risk;                         // model's guess; informational
  dom?: DomHint;
  status: "pending" | "explored" | "skipped" | "failed";
  skipReason?: string;
}

export interface StateNode {
  id: string;                         // "s_" + sha10(urlPath + "|" + domDigest)
  kind: "web" | "desktop";
  url: string; urlPath: string; title: string;
  phash: string;                      // 16 hex chars (64-bit dHash)
  domDigest: string;                  // sha256 of normalized visible text ("" for desktop)
  screenshot: string;                 // relative: "shots/<id>.png"
  affordances: Affordance[];
  pathFromRoot: string[];             // edge ids from root state to here
  discoveredInRun: string;
}

export interface EdgeAction {
  kind: ActionKind; x: number; y: number; label: string;
  text?: string; key?: string; affordanceId: string;
}

export interface Edge {
  id: string;                         // "e_" + zero-padded counter, e.g. e_000017
  from: string; to: string;
  action: EdgeAction;
  mutated: boolean;                   // data digest changed after action
  reverted: boolean;                  // sandbox reverted to root snapshot afterwards
  digestBefore: string; digestAfter: string;
  evidence: { before: string; after: string; replayUrl?: string }; // shot paths
  durationMs: number; ts: string; runId: string;
}

export interface Budget {
  maxActions: number; maxStates: number; maxVisionCalls: number; maxMinutes: number;
}
export interface Spent {
  actions: number; states: number; visionCalls: number; reverts: number;
  sandboxMinutes: number; browserMinutes: number; estUsd: number;
}

export interface RunMeta {
  id: string;                         // "r_" + ISO timestamp compact
  startedAt: string; finishedAt?: string;
  targetName: string; mode: "sandbox" | "live" | "desktop";   // P1: "sandbox" only
  budget: Budget; spent: Spent;
  sandboxId?: string; rootSnapshotId?: string; rootDigest?: string;
  notes: string[];                    // free-form incidents (relaunches, revert timings)
}

export interface TargetManifest {
  name: string;                       // [a-z0-9-]+, used as maps/<name>
  source: { type: "repo"; repo: string; ref?: string; subdir?: string }
        | { type: "local"; dir: string };            // P1 sample uses "local"
  runtime: {
    install: string[];                // sh commands run once in the sandbox
    start: string;                    // sh command; must listen on runtime.port
    port: number; readyPath: string;  // GET readyPath must return 2xx
    cpu?: number; memMb?: number; diskGb?: number;
  };
  dataPaths: string[];                // absolute paths in sandbox to digest (files/dirs)
  login?: { url: string; steps: Array<{ fill: [string, string] } | { click: string }> };
  blocklist: string[];                // regexes on affordance label, default ["log ?out","sign ?out"]
  viewport: { width: number; height: number };   // 1280x800
  budget: Budget;
}

export interface MapDoc {
  version: 1;
  target: TargetManifest;
  rootStateId: string | null;
  states: Record<string, StateNode>;
  edges: Edge[];
  runs: RunMeta[];
  updatedAt: string;
}
```

**On-disk layout:** `maps/<target.name>/map.json`, `maps/<target.name>/shots/<stateId>.png`, `maps/<target.name>/shots/<edgeId>-before.png`, `…-after.png`.

**Sample manifest (`examples/target-shop/carto.target.json`)**
```json
{
  "name": "target-shop",
  "source": { "type": "local", "dir": "examples/target-shop" },
  "runtime": {
    "install": ["cd /work/app && python3 -m pip install --user -r requirements.txt"],
    "start": "cd /work/app && python3 app.py",
    "port": 5000, "readyPath": "/health", "cpu": 2, "memMb": 4096, "diskGb": 4
  },
  "dataPaths": ["/work/app/shop.db"],
  "login": { "url": "/login", "steps": [ { "fill": ["#username", "admin"] }, { "fill": ["#password", "admin"] }, { "click": "button[type=submit]" } ] },
  "blocklist": ["log ?out", "sign ?out"],
  "viewport": { "width": 1280, "height": 800 },
  "budget": { "maxActions": 40, "maxStates": 30, "maxVisionCalls": 40, "maxMinutes": 25 }
}
```

---

## 8. Implementation Steps

Work in this order. Each step ends with a **Verify** line — do not proceed until it passes.

### Step 1 — Scaffold, config, logging
`src/config.ts`
```ts
import { z } from "zod";
import "dotenv/config"; // npm i dotenv  (add to deps)
const Env = z.object({
  SOLARI_API_KEY: z.string().startsWith("slr_live_"),
  SOLARI_BASE_URL: z.string().url().default("https://api.getsolari.com"),
  GEMINI_API_KEY: z.string().min(10),
  GEMINI_MODEL: z.string().default("gemini-3.7-flash"), // Flash-class; confirm the current id at ai.google.dev/gemini-api/docs/models. Cheaper fallback: a Flash-Lite model.
  CARTO_MAPS_DIR: z.string().default("./maps"),
  LOG_LEVEL: z.string().default("info"),
});
export const config = Env.parse(process.env);
// WHY: fail at startup with a readable error instead of a 401 twenty minutes into a run.
```
`src/log.ts`: `export const log = pino({ level: config.LOG_LEVEL })`.
`src/util/hash.ts`: `sha256(str)`, `sha10(str) = sha256(str).slice(0,10)`.
`src/util/sleep.ts`: `sleep(ms)`, `withTimeout(promise, ms, label)`, `retry(fn, {tries, baseMs})` (exponential, jitter).
`src/util/budget.ts`: class `BudgetTracker { constructor(budget: Budget); spent: Spent; canAct(): boolean; note(kind: keyof Spent, n=1) }`. `estUsd` formula (Starter rates, ⚠️ verify at https://docs.getsolari.com/pricing): sandbox 2vCPU/4GB ≈ $0.114/h; browser ≈ $0.10/h; vision call ≈ $0.002.
**Verify:** `npx tsx -e "import('./src/config.ts').then(m=>console.log(Object.keys(m.config)))"` prints the keys with a valid `.env`, and fails loudly with an invalid one.

### Step 2 — Sample target app
`examples/target-shop/app.py` — Flask, server-rendered HTML, stdlib sqlite3. Requirements:
- `GET /health` → `ok`.
- `/login` form (`#username`, `#password`, submit) → session cookie; all other routes redirect to `/login` when not logged in.
- `/` dashboard with nav links: Orders, Customers, Settings, Logout.
- `/orders` table of ~12 seeded orders with links to `/orders/<id>`.
- `/orders/<id>` detail with buttons: **Refund** (POST `/orders/<id>/refund` → sets status `refunded`), **Delete** (POST `/orders/<id>/delete`), link back.
- `/customers` list → `/customers/<id>` detail (read-only).
- `/settings` form (store name, currency) with **Save** (POST → updates `settings` table).
- DB file `shop.db` next to `app.py`; on start, if missing, create schema + seed deterministically (fixed ids/names). Open sqlite with `isolation_level=None` and run `PRAGMA journal_mode=DELETE` so writes land in `shop.db` itself (WHY: our digest hashes the file; WAL mode would put changes in a sidecar file).
- Listen on `0.0.0.0:5000`, `debug=False`.
- Keep the UI plain but with visible, distinct button text (vision needs readable labels). Buttons must be real `<button>`/`<a>` elements ≥ 32px tall.
**Verify:** locally `pip install flask && python examples/target-shop/app.py` → login works, refund changes status, `sha256sum shop.db` changes after refund and not after viewing pages.

### Step 3 — Manifest loader
`src/manifest.ts`: zod schema mirroring `TargetManifest`; `loadManifest(path): TargetManifest`; defaults: `blocklist` ∪ `["log ?out","sign ?out"]`, `viewport` 1280×800, `budget` defaults `{40,30,40,25}`. Reject `name` not matching `/^[a-z0-9-]+$/`.
**Verify:** loading the sample manifest returns an object; a manifest with `port: "abc"` throws with a field path.

### Step 4 — Perception (pure, tested)
`src/perception/stateId.ts`
```ts
import sharp from "sharp";
export async function dHash(png: Buffer): Promise<string> {
  // WHY dHash: robust to minor rendering noise, 64-bit, no ML dependency, identical for desktop shots.
  const { data } = await sharp(png).grayscale().resize(9, 8, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  let bits = "";
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += data[y * 9 + x] < data[y * 9 + x + 1] ? "1" : "0";
  return BigInt("0b" + bits).toString(16).padStart(16, "0");
}
export function hamming(a: string, b: string): number {
  let x = BigInt("0x" + a) ^ BigInt("0x" + b), n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; } return n;
}
export function textDigest(visibleText: string): string {
  // normalize: collapse whitespace, drop digits (timestamps/counters), lowercase
  const norm = visibleText.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().toLowerCase();
  return sha256(norm);
}
export function stateIdFor(urlPath: string, domDigest: string) { return "s_" + sha10(urlPath + "|" + domDigest); }
export function resolveState(obs: {urlPath: string; phash: string; domDigest: string}, states: Record<string, StateNode>): StateNode | null {
  // exact id match first, then fuzzy: same urlPath and hamming <= 6
  const exact = states[stateIdFor(obs.urlPath, obs.domDigest)]; if (exact) return exact;
  for (const s of Object.values(states)) if (s.urlPath === obs.urlPath && hamming(s.phash, obs.phash) <= 6) return s;
  return null;
}
```
Tests (`test/stateId.test.ts`): dHash of an image equals dHash of the same image re-encoded; hamming of identical = 0; two visually different generated images (sharp `create` solid vs gradient) differ by > 10; `textDigest("Order 12 total 5")` equals `textDigest("Order 99 total 7")`.
**Verify:** `npm test` green.

### Step 5 — Vision (Gemini → affordances)
`src/vision/gemini.ts`
```ts
import { GoogleGenAI } from "@google/genai";   // ⚠️ verify import name/ctor in the installed version
const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });

const SCHEMA = { type: "object", properties: { affordances: { type: "array", items: { type: "object",
  properties: { label: {type:"string"}, kind: {type:"string", enum:["click"]},
    bbox: { type:"object", properties:{ x:{type:"number"}, y:{type:"number"}, w:{type:"number"}, h:{type:"number"} }, required:["x","y","w","h"] },
    expected: {type:"string"}, risk: {type:"string", enum:["read","write","unknown"]} },
  required: ["label","kind","bbox","expected","risk"] } } }, required: ["affordances"] };

export async function proposeAffordances(png: Buffer, ctx: {stateId: string; width: number; height: number; title: string}): Promise<Affordance[]> {
  const prompt = `You are mapping a web application by looking ONLY at this screenshot (${ctx.width}x${ctx.height} px).
List every distinct clickable affordance a user could act on: buttons, links, tabs, menu items, table row links, form submit buttons.
Return pixel bounding boxes in screenshot coordinates. Do not invent elements you cannot see. Skip decorative text.
For each give: label (visible text + role, e.g. "Refund button"), expected (one sentence: what likely happens), risk: "read" if it only navigates/shows, "write" if it likely changes data, else "unknown".
Return at most 25 items, most important first.`;
  const res = await ai.models.generateContent({ model: config.GEMINI_MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: "image/png", data: png.toString("base64") } }] }],
    config: { responseMimeType: "application/json", responseSchema: SCHEMA, temperature: 0.1 } });
  const parsed = JSON.parse(res.text ?? "{}");  // res.text is a property in @google/genai (verified). If the installed SDK rejects `responseSchema`, use `responseJsonSchema` or the newer `responseFormat: { text: { mimeType, schema } }` — check the SDK README. If the model supports a thinking level, set it to the lowest for this extraction call (thinking tokens bill as output).
  return (parsed.affordances ?? []).filter(validBbox(ctx)).map(a => ({ ...a, id: "a_" + sha10(ctx.stateId + a.label + Math.round(a.bbox.x + a.bbox.w/2) + Math.round(a.bbox.y + a.bbox.h/2)), stateId: ctx.stateId, status: "pending" as const }));
}
// validBbox: inside viewport, w>=8, h>=8, w*h < 0.5*area. WHY: model sometimes returns a whole-page box.
```
Retry once on JSON parse failure with `temperature: 0`. Count every call in the budget.
**Verify:** run against a saved screenshot of the sample app's `/orders/1` page → returns Refund, Delete, back link with sane boxes (print them; eyeball on the PNG).

### Step 6 — SandboxHost
`src/solari/sandboxHost.ts` (⚠️ verify each SDK method name against the installed `.d.ts`; behavior must match what's described).
```ts
import { SandboxClient } from "@solarisdk/sandbox";
export class SandboxHost {
  private client = new SandboxClient({ apiKey: config.SOLARI_API_KEY, baseUrl: config.SOLARI_BASE_URL, callTimeoutMs: 900_000 }); // long per-RPC timeout so installs can stream over the control channel
  sbx!: any; id!: string; previewBase!: string; previewToken!: string; rootSnapshotId!: string; rootDigest!: string;

  async boot(m: TargetManifest, localDir?: string) {
    this.sbx = await this.client.create({ template: "base", cpu: m.runtime.cpu ?? 2, memMb: m.runtime.memMb ?? 4096,
      diskGb: m.runtime.diskGb ?? 4, timeoutMs: 30 * 60_000, lifecycle: { onTimeout: "kill" }, metadata: { app: "cartographer", target: m.name } });
    this.id = this.sbx.id ?? this.sbx.sandboxId;
    await this.sbx.connect();                              // WHY: files.*, commands.start need the control channel
    await this.sbx.commands.run("sh", { args: ["-c", "mkdir -p /work/app"] });
    if (m.source.type === "local") await this.uploadDir(localDir!, "/work/app");   // files.write per file
    else await this.sbx.git.clone(m.source.repo, { path: "/work/app", branch: m.source.ref, depth: 1 });  // verified signature
    for (const cmd of m.runtime.install) await this.runLong(cmd, 10 * 60_000);
    await this.startServer(m);
    this.rootDigest = await this.digest(m.dataPaths);
    this.rootSnapshotId = await this.sbx.snapshot("cartographer-root");  // ⚠️ verify: returns id string or {snapshotId}
  }
  // Long commands. Two paths (verified in docs): once connect() is open, commands.run() with an onStdout callback runs over the
  // control channel (default 300 s per call; raised via callTimeoutMs above) — use that first. The ~28 s cap reported by the
  // community applies to the warm REST fast path (no callbacks, no open channel). Keep nohup+poll as the fallback.
  async runLong(cmd: string, timeoutMs: number) {
    try {
      const r = await this.sbx.commands.run("sh", { args: ["-c", cmd], timeoutMs, onStdout: (d: string) => log.debug(d.trimEnd()), onStderr: (d: string) => log.debug(d.trimEnd()) });
      if (r.exitCode !== 0) throw new Error(`install failed (${r.exitCode}): ${cmd}\n${r.stderr.slice(-2000)}`);
      return;
    } catch (e: any) { if (!/timeout/i.test(String(e?.message))) throw e; log.warn("streamed run timed out; falling back to nohup+poll"); }
    return this.runLongDetached(cmd, timeoutMs);
  }
  async runLongDetached(cmd: string, timeoutMs: number) {
    const tag = "c" + Date.now();
    await this.sbx.commands.run("sh", { args: ["-c", `nohup sh -c '${cmd.replace(/'/g, `'\\''`)}' > /tmp/${tag}.log 2>&1; echo $? > /tmp/${tag}.done &`] });
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) { await sleep(2000);
      const r = await this.sbx.commands.run("sh", { args: ["-c", `cat /tmp/${tag}.done 2>/dev/null || true`] });
      if (r.stdout.trim() !== "") { if (r.stdout.trim() !== "0") throw new Error(`install failed: ${cmd}\n` + (await this.sbx.commands.run("sh",{args:["-c",`tail -50 /tmp/${tag}.log`]})).stdout); return; } }
    throw new Error("runLong timeout: " + cmd);
  }
  async startServer(m: TargetManifest) {
    await this.sbx.commands.run("sh", { args: ["-c", `nohup sh -c '${m.runtime.start}' > /tmp/app.log 2>&1 &`] });
    await this.refreshPreview(m.runtime.port);
    await this.waitReady(m.runtime.readyPath, 120_000);
  }
  async refreshPreview(port: number) {
    const { url, token } = await this.sbx.previewUrl(port);    // url may already contain ?pt_token=
    const u = new URL(url); this.previewToken = token ?? u.searchParams.get("pt_token") ?? ""; u.search = ""; this.previewBase = u.toString().replace(/\/$/, "");
  }
  async waitReady(readyPath: string, timeoutMs: number) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { const r = await fetch(this.previewBase + readyPath, { headers: { "x-pinetree-preview-token": this.previewToken } });
        if (r.ok) return; if (r.status === 401) await this.refreshPreview(portFromBase()); /* token expired */ } catch {}
      await sleep(1500);                                        // 425 = nothing listening yet; keep polling
    }
    throw new Error("app not ready: " + readyPath);
  }
  async digest(paths: string[]): Promise<string> {
    const r = await this.sbx.commands.run("sh", { args: ["-c", `find ${paths.map(p=>`'${p}'`).join(" ")} -type f -print0 2>/dev/null | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1`] });
    if (!r.stdout.trim()) throw new Error("digest empty — dataPaths wrong?");
    return r.stdout.trim();
  }
  async revertToRoot(m: TargetManifest): Promise<number> {
    const t0 = Date.now();
    await this.sbx.revert(this.rootSnapshotId);              // boots fresh VM from snapshot, swaps in; control channel drops
    await retry(() => this.sbx.reconnect(), { tries: 5, baseMs: 1000 });   // ⚠️ verify: reconnect() vs client.connect(id)
    // The snapshot captured RAM, so the app process should be running. Fail-closed: verify, restart if not.
    await this.refreshPreview(m.runtime.port);
    try { await this.waitReady(m.runtime.readyPath, 30_000); } catch { await this.startServer(m); }
    const d = await this.digest(m.dataPaths);
    if (d !== this.rootDigest) throw new Error(`revert did not restore root digest (${d} != ${this.rootDigest})`);
    return Date.now() - t0;
  }
  async kill() { try { await this.sbx.kill(); } catch {} }   // kill(), never close(): close() leaves the VM running and billing
}
```
`uploadDir`: walk local dir, `files.mkdir` + `files.write(path, buffer)` for each file (skip `shop.db`, `__pycache__`).
**Verify:** a scratch script boots the sample, prints preview URL, `curl -H "x-pinetree-preview-token: …" <base>/health` → `ok`; digest is 64 hex chars; `POST /orders/1/refund` via the same curl changes the digest; `revertToRoot()` restores it and prints the revert duration (record this number — you will report it).

### Step 7 — BrowserPool
`src/solari/browserPool.ts`
```ts
import { Solari } from "@solarisdk/browser";
export class BrowserPool {
  private solari = new Solari({ apiKey: config.SOLARI_API_KEY, baseUrl: config.SOLARI_BASE_URL });
  private browser: any | null = null; storageState: any | null = null;
  constructor(private host: SandboxHost, private m: TargetManifest) {}

  private async ensureBrowser() {
    if (this.browser && this.browser.isConnected?.() !== false) return this.browser;
    // Sessions are cheap and reportedly die ~10 min after creation on Starter; relaunch on demand and log it.
    this.browser = await this.solari.launch({ recording: false });   // fast pool; no stealth needed for our own preview host
    log.info({ sessionId: this.browser.id }, "browser launched");
    return this.browser;
  }
  async newContext() {
    const b = await this.ensureBrowser();
    const ctx = await b.newContext({ viewport: this.m.viewport, storageState: this.storageState ?? undefined, deviceScaleFactor: 1 });
    // Principle 3: network allowlist + preview token on every request.
    await ctx.route("**/*", (route: any) => {
      const u = new URL(route.request().url());
      if (this.host.previewBase.includes(u.host)) return route.continue({ headers: { ...route.request().headers(), "x-pinetree-preview-token": this.host.previewToken } });
      return route.abort("blockedbyclient");
    });
    const page = await ctx.newPage(); page.setDefaultTimeout(15_000);
    return { ctx, page };
  }
  async login() {                     // one-time DOM-driven setup; explicitly NOT exploration
    if (!this.m.login) return;
    const { ctx, page } = await this.newContext();
    await page.goto(this.host.previewBase + this.m.login.url, { waitUntil: "networkidle" });
    for (const s of this.m.login.steps) { if ("fill" in s) await page.fill(s.fill[0], s.fill[1]); else await page.click(s.click); }
    await page.waitForLoadState("networkidle");
    this.storageState = await ctx.storageState(); await ctx.close();
  }
  async observe(page: any) {
    const png: Buffer = await page.screenshot({ type: "png", fullPage: false });
    const visible: string = await page.evaluate(() => document.body?.innerText ?? "");
    const doms: DomHint[] = await page.evaluate(() => [...document.querySelectorAll("a,button,[role=button],input[type=submit]")].map(el => {
      const r = el.getBoundingClientRect(); return { tag: el.tagName.toLowerCase(), text: (el as HTMLElement).innerText?.trim().slice(0,80) ?? "",
        selectorHint: el.id ? "#"+el.id : el.tagName.toLowerCase(), bbox: { x: r.x, y: r.y, w: r.width, h: r.height }, href: (el as HTMLAnchorElement).href || undefined }; }));
    return { png, visible, doms, url: page.url(), title: await page.title() };
  }
  async clickAt(page: any, x: number, y: number) {
    await page.mouse.move(x, y); await page.mouse.click(x, y);          // coordinates only — vision-first execution
    await Promise.race([page.waitForLoadState("networkidle").catch(() => {}), sleep(4000)]); await sleep(1200);
  }
  async close() { try { await this.browser?.close(); } catch {} try { await this.solari.close(); } catch {} }
}
```
Attach DOM hints to affordances by max-overlap IoU ≥ 0.3 (metadata only).
**Verify:** scratch script: boot host → `login()` → `newContext()` → `goto(previewBase + "/")` → `observe()` shows the dashboard title and ≥ 3 DomHints; a `goto("https://example.com")` in the same context fails (blocked).

### Step 8 — MapStore
`src/map/store.ts`: `class MapStore { constructor(dir); load(): MapDoc | null; init(target): MapDoc; save(doc) (atomic: write tmp then rename); shotPath(name); writeShot(name, png) }`. Screenshot names: `shots/<stateId>.png`, `shots/<edgeId>-before.png`, `shots/<edgeId>-after.png`. `nextEdgeId(doc)` = `e_` + `String(doc.edges.length).padStart(6,"0")`.
Tests: init→save→load roundtrip; atomic save leaves no `.tmp`.
**Verify:** `npm test` green.

### Step 9 — Frontier
`src/explore/frontier.ts`: FIFO of `{stateId, affordanceId}`; `push` ignores duplicates and blocklisted labels (mark affordance `skipped`, `skipReason:"blocklist"`); `pop`; `size`; `fromMap(doc)` rebuilds from all `pending` affordances (WHY: `--resume`). BFS order = state discovery order, then affordance order (vision returns most important first).
**Verify:** unit test: duplicates ignored; blocklist regex is case-insensitive.

### Step 10 — Explorer (the loop)
`src/explore/explorer.ts`
```ts
export async function explore(m: TargetManifest, opts: { resume: boolean; maxActions?: number }) {
  const store = new MapStore(path.join(config.CARTO_MAPS_DIR, m.name));
  const doc = (opts.resume && store.load()) || store.init(m);
  const run: RunMeta = { id: "r_" + new Date().toISOString().replace(/[-:.TZ]/g, ""), startedAt: new Date().toISOString(), targetName: m.name, mode: "sandbox",
    budget: { ...m.budget, maxActions: opts.maxActions ?? m.budget.maxActions }, spent: zeroSpent(), notes: [] };
  doc.runs.push(run); const budget = new BudgetTracker(run.budget, run.spent);
  const host = new SandboxHost(); const pool = new BrowserPool(host, m);
  try {
    await host.boot(m, m.source.type === "local" ? m.source.dir : undefined);
    run.sandboxId = host.id; run.rootSnapshotId = host.rootSnapshotId; run.rootDigest = host.rootDigest; store.save(doc);
    await pool.login();
    // Root state
    if (!doc.rootStateId) { const { ctx, page } = await pool.newContext(); await page.goto(host.previewBase + "/", { waitUntil: "networkidle" });
      const root = await observeAndRegister(page, [], /*from*/ null); doc.rootStateId = root.id; await ctx.close(); store.save(doc); }
    const frontier = Frontier.fromMap(doc, m.blocklist);
    while (frontier.size() > 0 && budget.canAct()) {
      const { stateId, affordanceId } = frontier.pop()!; const S = doc.states[stateId]; const A = S.affordances.find(a => a.id === affordanceId)!;
      const t0 = Date.now(); const { ctx, page } = await pool.newContext();
      try {
        if (await host.digest(m.dataPaths) !== host.rootDigest) { run.notes.push("world drifted before episode; reverting"); await host.revertToRoot(m); budget.note("reverts"); }
        if (!(await reach(page, S))) { A.status = "failed"; A.skipReason = "could not reach state"; continue; }
        const before = await pool.observe(page); store.writeShot(`${pendingEdgeId(doc)}-before`, before.png);
        const digestBefore = host.rootDigest;
        await pool.clickAt(page, A.bbox.x + A.bbox.w / 2, A.bbox.y + A.bbox.h / 2); budget.note("actions");
        const after = await pool.observe(page);
        const digestAfter = await host.digest(m.dataPaths); const mutated = digestAfter !== digestBefore;
        const edgeId = nextEdgeId(doc); store.writeShot(`${edgeId}-after`, after.png);
        const T = await observeAndRegister(page, [...S.pathFromRoot, edgeId], S, after);   // resolves existing or creates new + vision
        let reverted = false;
        if (mutated) { const ms = await host.revertToRoot(m); reverted = true; budget.note("reverts"); run.notes.push(`revert ${edgeId} took ${ms}ms`); }
        doc.edges.push({ id: edgeId, from: S.id, to: T.id, action: { kind: "click", x: Math.round(A.bbox.x + A.bbox.w/2), y: Math.round(A.bbox.y + A.bbox.h/2), label: A.label, affordanceId: A.id },
          mutated, reverted, digestBefore, digestAfter, evidence: { before: `shots/${edgeId}-before.png`, after: `shots/${edgeId}-after.png` }, durationMs: Date.now() - t0, ts: new Date().toISOString(), runId: run.id });
        A.status = "explored";
        if (T.discoveredInRun === run.id && T.affordances.length === 0) { /* observeAndRegister already ran vision */ }
        for (const a of T.affordances) frontier.push({ stateId: T.id, affordanceId: a.id });
      } catch (err: any) { A.status = "failed"; A.skipReason = String(err?.message ?? err).slice(0, 200); run.notes.push(`episode error ${A.id}: ${A.skipReason}`);
        if (/disconnected|Target closed|closed/i.test(A.skipReason)) { await pool.close(); run.notes.push("browser relaunch"); } }
      finally { try { await ctx.close(); } catch {} store.save(doc); }
    }
  } finally { run.finishedAt = new Date().toISOString(); store.save(doc); await pool.close(); await host.kill(); }
}
```
Helper `observeAndRegister(page, pathFromRoot, fromState, obs?)`: obs → `{phash: await dHash(png), domDigest: textDigest(visible), urlPath: new URL(url).pathname}` → `resolveState` → if found return it; else create `StateNode` (`id = stateIdFor(...)`, write `shots/<id>.png`), call `proposeAffordances` (budget `visionCalls`; if over budget, leave `affordances: []` and note it), attach DOM hints, `budget.note("states")`, return.
Helper `reach(page, S)`: `goto(S.url)`, observe, `resolveState` → if it resolves to `S` return true; else if `S.pathFromRoot.length > 0` replay: goto root url, for each edge id click `edge.action.x/y` with `clickAt`, then check again; return result. (Replaying is deterministic because the world is at root digest.)
**Verify:** `npm run e2e` (Step 12) completes with ≥ 8 states, ≥ 1 edge with `mutated: true, reverted: true`, and `map.json` is valid JSON that `MapStore.load()` reads back.

### Step 11 — CLI + Viewer
`src/cli.ts` (commander):
- `explore <manifest> [--max-actions <n>] [--resume]` → `explore()`; print a summary table at the end: states, edges, mutated/reverted, vision calls, reverts, est. USD, map path.
- `view [mapDir]` → serve `viewer/index.html` and the map dir on `http://localhost:4173` (Node `http` + static file handling; no framework), open URL in log.
`viewer/index.html`: loads `./map.json` (served alongside), renders with Cytoscape (CDN `https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.30.2/cytoscape.min.js` ⚠️ verify version exists), `breadthfirst` layout rooted at `rootStateId`; node label = `title` (fallback `urlPath`); edge label = `action.label`; red dashed edges for `mutated`; hover node → side panel shows screenshot; click edge → before/after screenshots. Show run stats from `runs[last]`.
**Verify:** `npm run dev view maps/target-shop` renders the graph; a mutated edge is red; hovering shows screenshots.

### Step 12 — Integration script
`scripts/e2e-explore.ts`: runs `explore(loadManifest("examples/target-shop/carto.target.json"), { resume: false, maxActions: 25 })`, then asserts the conditions in Step 10's Verify and prints spend. Wrap in a 30-minute hard timeout that calls `host.kill()`.
**Verify:** passes twice in a row; second run with `--resume` continues from pending affordances without re-creating the root state.

---

## 9. API / Interface Contracts

**Manifest → Explorer:** `explore(manifest: TargetManifest, opts: { resume: boolean; maxActions?: number }): Promise<void>`; writes `maps/<name>/map.json`.

**SandboxHost**
| Method | Contract |
|---|---|
| `boot(m, localDir?)` | creates VM, installs, starts server, sets `previewBase`, `previewToken`, `rootDigest`, `rootSnapshotId` |
| `digest(paths) → string` | 64-hex sha256; throws if empty |
| `revertToRoot(m) → ms` | after return: reconnected, app ready, `digest() === rootDigest` (throws otherwise) |
| `kill()` | destroys VM; idempotent |

**BrowserPool**
| Method | Contract |
|---|---|
| `login()` | populates `storageState` or no-op |
| `newContext() → {ctx, page}` | 1280×800, allowlisted network, token header |
| `observe(page) → {png, visible, doms, url, title}` | png is viewport-only PNG |
| `clickAt(page, x, y)` | coordinates in viewport px; waits for settle |

**Vision:** `proposeAffordances(png, {stateId,width,height,title}) → Affordance[]` (≤ 25, all bboxes inside viewport, `status:"pending"`).

**Perception:** `dHash(png) → 16-hex`, `hamming(a,b) → number`, `textDigest(text) → sha256`, `stateIdFor(urlPath, domDigest) → "s_…"`, `resolveState(obs, states) → StateNode|null`.

**Solari wire facts you rely on** (from docs): sandbox `commands.run(cmd, {args})` has no shell → always `sh -c`; `connect()` required before `files.*`, `git.*`, `commands.start`; `previewUrl(port)` returns a URL whose token must be sent as `?pt_token=` or header `x-pinetree-preview-token`; 425 from preview = nothing listening yet; `snapshot()` needs a running (not paused) machine; `revert()` boots a fresh VM and swaps — open control/stream connections drop; `kill()` destroys, `close()` does not; browser `launch()` returns a Playwright-shaped browser; browser sessions expire (`expiresAt`) and may die early — liveness comes from the connection, not `GET /sessions/:id`.

---

## 10. Error Handling & Edge Cases

| Situation | Handling |
|---|---|
| `429 ConcurrencyLimitExceeded` on create | Not retried by SDK. Print: "Starter allows 2 running VMs — kill stale sandboxes in console" and exit 2. Before exiting, `client.list({state:"running", metadata:{app:"cartographer"}})` and print their ids. |
| `402 InsufficientCredit` / `FeatureRequiresPlan` | Exit with the code and the pricing URL. |
| Install > 10 min or non-zero exit | `runLong` throws with last 50 log lines. |
| Preview 401 | Token expired (1 h): `refreshPreview()` and retry once. |
| Preview 425 | Keep polling until `readyPath` timeout. |
| Browser disconnected mid-episode | Mark affordance `failed`, close pool, relaunch on next episode, note in `run.notes`. Never treat REST `GET /sessions/:id` "active" as alive. |
| Revert fails or digest ≠ root after revert | Throw → run ends (fail-closed). Map is already saved; `--resume` will continue on next run with a fresh VM. |
| Vision returns zero affordances / invalid JSON | Retry once at temperature 0; if still empty, state gets `affordances: []` and a note. |
| Vision bbox outside viewport or huge | Filtered by `validBbox`. |
| Click lands on nothing (state unchanged and not mutated) | Still record the edge (self-loop `from === to`); it's information ("this looked clickable but isn't"). |
| Same target state reached via different urlPath | Treated as different states by design (URL is part of identity). |
| Text digest noise (counters, timestamps) | Digits are replaced by `#` before hashing; phash fuzzy match with hamming ≤ 6 catches the rest. |
| App writes to `shop.db-journal` transiently | Digest may flicker during a write; we digest after settle (≥ 1.2 s). If flakiness observed, digest twice 500 ms apart and take the second. |
| Budget exhausted | Loop exits cleanly; `run.finishedAt` set; frontier state preserved in map for `--resume`. |
| Process killed (Ctrl-C) | `SIGINT` handler: save map, `pool.close()`, `host.kill()`. WHY: an orphaned VM bills until idle timeout (30 min). |

---

## 11. Testing & Verification

**Unit (no network):** `npm test`
- `stateId.test.ts`: dHash stability, hamming, textDigest digit-normalization, resolveState fuzzy match.
- `frontier.test.ts`: dedupe, blocklist, rebuild from map.
- `store.test.ts`: roundtrip, atomic write, edge id formatting.

**Integration (real APIs, ~$0.30 and ~10 min per run):** `npm run e2e`
Expected: exits 0; prints summary like
```
target-shop  states=14 edges=25 mutated=3 reverted=3 visionCalls=14 reverts=3 estUsd=0.21 map=maps/target-shop/map.json
```
Key checks the script asserts: every state has an existing PNG; every edge has before/after PNGs and 64-hex digests; every `mutated` edge has `reverted: true`; `doc.rootStateId` is set; at least one edge whose `action.label` matches `/refund|delete|save/i` is `mutated`.

**Manual:** `npm run dev view maps/target-shop` and look at the graph; screenshot it for the README.

---

## 12. Definition of Done

- [ ] `npm run build` and `npm test` pass on Node 22.
- [ ] `examples/target-shop` runs in the Solari `base` sandbox (Python 3 + Flask) with deterministic seed data.
- [ ] `npm run e2e` passes twice; second run with `--resume` continues without duplicating the root state.
- [ ] `map.json` validates against the `MapDoc` type; every state has a screenshot; every edge has before/after evidence.
- [ ] At least one `mutated: true, reverted: true` edge; after each revert `digest() === rootDigest` was verified.
- [ ] No request from the exploring browser ever left the preview host (assert in e2e by attempting `example.com` in a context and expecting failure).
- [ ] Vision-first invariant holds: grep shows no `page.click(selector)` outside `BrowserPool.login()`.
- [ ] Run summary reports actions, states, vision calls, reverts, VM/browser minutes, est. USD.
- [ ] Viewer renders the graph with red mutated edges and screenshot hover.
- [ ] Ctrl-C leaves no running sandbox (check console → Sandboxes).
- [ ] README has: one-paragraph pitch, the loop diagram, run instructions, the measured revert time.
- [ ] You recorded in `NOTES.md`: revert latency (p50 over ≥ 5 reverts), any SDK name mismatches you had to adapt, any Solari bugs hit (these become Phase 3 bug reports).

---

## 13. Notes & Pitfalls

- **Do not build Phase 2 things here** (MCP, route search, solver, live-URL mode). The thin slice must run first.
- **`sh -c` everywhere.** `commands.run("cd x && ls")` looks for a binary literally named that.
- **Never call `sbx.close()` expecting the VM to stop.** Only `kill()` stops billing.
- **Node inside the sandbox is 18.** Irrelevant for the Python sample, but don't try to run the Solari SDK inside the sandbox.
- **No Docker in the sandbox.** Targets must run natively (Python/Node 18).
- **Exec cap ~28 s** (community-observed, not documented): all installs go through `runLong`.
- **Preview token** goes in a header on every request (via `ctx.route`), not string-concatenated into URLs — concatenating `/path` after `?pt_token=` breaks the path.
- **`newPage()` on the Solari browser opens a fresh context** with no storageState — always use `newContext({storageState})` as written.
- **Playwright version pin:** you are using the SDK's `launch()` which ships its own client — do not install `playwright` separately for Phase 1.
- **Browser sessions may die ~10 min after creation** regardless of activity (open issue at the time of writing). Episodes are short; relaunch is cheap; log every relaunch to `run.notes` — that count is a data point for the write-up.
- **Snapshot RAM capture:** after `revert()` the Flask process should still be alive. If you observe it isn't, `revertToRoot` restarts it — record which happened in `NOTES.md`; it matters for the Phase 3 bug report.
- **Snapshot storage is billed from Oct 1, 2026** (10 GB free/org). One root snapshot per run is fine; delete old ones (`client.deleteSnapshot(id)`) at the end of `explore` unless `--keep-snapshot`.
- **Idle timeout is a rolling window;** polling (`digest`) keeps the VM alive — this is desired during a run, which is why `lifecycle.onTimeout: "kill"` protects you after a crash.
- **Cost sanity:** a 25-action run ≈ 10–15 min of a 2 vCPU/4 GB sandbox (~$0.03) + browser minutes (~$0.02) + ~15 vision calls (~$0.03). If a run costs > $1, something is looping.
- **Don't over-engineer the viewer.** One HTML file. Phase 3 hosts it.

---

## 14. Handoff to Next Phase

**What works after Phase 1:** `cartographer explore <manifest>` boots a target in a Solari sandbox, explores it vision-first in a Solari cloud browser, reverts every mutation to the root snapshot, and writes a resumable `map.json` + screenshots with full evidence and spend; `cartographer view` renders it.

**Next (Phase 2):** turn the map into something agents use — `cartographer init` for arbitrary repos, npm-publishable CLI, MCP server with `atlas_route(goal)`, live-URL read-only exploration for public sites, a solver agent, and a with-map vs without-map benchmark that produces the headline number for the public launch.
