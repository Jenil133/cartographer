# Cartographer — build notes

Running log of measured numbers, SDK adaptations, and platform surprises.
Phase 3 turns this into bug reports (Discord `#support-requests`) and the numbers in the launch post.

---

## Environment

| Item | Value |
|---|---|
| Node (project) | 22.23.2, npm 10.9.8 — Homebrew `node@22`, **keg-only** |
| Node (machine default) | 26.3.0 at `/opt/homebrew/bin/node` — NOT used here |
| PATH prefix required | `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"` |
| SDK versions | `@solarisdk/sandbox` 0.1.3, `@solarisdk/browser` 0.1.3, `@solarisdk/core` 0.1.3 |
| Gemini model | `gemini-3.7-flash` (confirmed live 2026-09-07) |

No nvm on this machine. `.nvmrc` pins `22` for future version managers.

---

## Solari API facts (verified 2026-09-07)

- **Auth is `Authorization: Bearer <key>`.** `x-api-key` returns `401 {"error":"Unauthorized"}`.
  Confirmed by raw curl against `GET /sandboxes` → `200 {"sandboxes":[]}`.
- **Browser region resolution:** `SolariOptions.region` defaults to `us-west`, whose URL is
  `https://api.getsolari.com` — identical to the sandbox base URL. So passing
  `baseUrl: SOLARI_BASE_URL` to the browser client is a no-op, not a misconfiguration.

## Spec ⚠️-verify items resolved against the installed `.d.ts`

| Spec question | Answer from `.d.ts` |
|---|---|
| `snapshot()` returns id string or `{snapshotId}`? | **`snapshot(name?): Promise<string>`** — plain id string. |
| `reconnect()` vs `client.connect(id)`? | **`reconnect()` exists on the handle.** `client.connect(id)` also exists, for re-attaching to a sandbox by id from scratch. |
| Does `close()` stop billing? | **No** — doc comment: "Close the control channel locally (does NOT release the remote session)." Confirms: always `kill()`. |
| `commands.run` shape | `run(cmd, { args, cwd, env, user, timeoutMs, background, onStdout, onStderr })` → `{ exitCode, stdout, stderr }`. Doc says explicitly: no shell, so use `run("sh", { args: ["-c", …] })`. |
| `previewUrl(port)` | `→ { url, token? }` as specced. |
| `git.clone(url, opts)` | `{ path, branch, depth, username, password, cwd }` as specced. |

Verdict: **the Phase 1 spec matches the installed SDK.** No renames needed so far.

## SDK capabilities the spec does not use (worth knowing later)

- `pause()` / `resume()` — "snapshot RAM+disk, free the slot". Directly relevant to the
  Starter 2-running-VM cap: a paused VM should not count against concurrency.
- `files.upload()` / `files.download()` plus signed `uploadUrl()` / `downloadUrl()` —
  likely faster than per-file `files.write` for `uploadDir` if the sample app grows.
- `metrics()` — live resource metrics; could sharpen `estUsd` beyond the flat-rate estimate.
- `SessionHooks.exec` — the one-shot REST fast path (the ~28 s cap the spec warns about).
- `client.promoteSnapshot(id, name)` — turn a booted root snapshot into a reusable template.
  Could cut boot time across runs; evaluate in Phase 2.
- Browser `sessions.getReplayUrl()` / `downloadReplay()` — session recordings as evidence.
- `BrowserSession.proxy` getter exists → Phase 2's "proxy silently degraded" assert is doable;
  `ResolvedProxyConfig.tier` is what to compare against the requested tier.

---

## Measurements

| Metric | Value | When |
|---|---|---|
| **Revert latency p50 (web)** | **62.4 s** (min 30.4, max 64.1, n=5) | Step 6, 2026-09-07 |
| Sandbox boot (create -> ready -> snapshot) | 18.9 s | Step 6 |
| Revert latency p50 (desktop) | _not measured yet_ | Phase 3 |
| Browser session relaunches per run | _not measured yet_ | Phase 1 |
| Cost per map | _not measured yet_ | Phase 1 |

### Revert is slow, and it shapes the budget
`revert()` + `reconnect()` + ready-poll + digest costs **30-64 s**, clustering around 62 s.
The distribution is bimodal (two runs at ~30 s, three at ~63 s), suggesting a warm/cold path
rather than noise. This is the single biggest cost in an exploration run: 8 mutating actions
means ~8 minutes of pure reverting against a 25-minute default budget. Worth reporting
honestly and worth asking Solari about — it is the headline number for the write-up.

The app process **did survive** every revert (RAM was restored, the ready-poll passed without
needing `startServer()`), which is the behaviour the snapshot is supposed to give.

### Deterministic seeding confirmed across boots
Two independent sandbox boots produced the byte-identical root digest
`5e555e246470aca2465c67a7339a366ec9d2af847f77f637b24ce7b20d1c28f2`. The fixed seed data means
digests are comparable across runs and machines, which Phase 3's fork-based parallelism needs.

## Cookbook fork

https://github.com/Jenil133/solari-cookbook — forked, untouched until Phase 3 Step 9
(add `examples/cartographer-ts` + `projects/cartographer/README.md`, then a small PR
upstream containing only that one runnable example plus a README table row).

## Bugs / gotchas hit

### macOS owns port 5000 (local only, not a Solari issue)
`examples/target-shop` listens on 5000, which is what `carto.target.json` declares and what
the Linux sandbox uses. On macOS, **ControlCenter (AirPlay Receiver) already binds :5000** and
answers every request `403 Forbidden` with `Server: AirTunes/950.7.1` — so a local smoke test
looks like a broken app rather than a port clash. Flask's own log says it plainly:

    Address already in use
    Port 5000 is in use by another program.

`app.py` therefore reads `PORT` from the environment, defaulting to 5000. Sandbox behaviour is
unchanged; local runs use `PORT=5055 python3 app.py`. Do **not** change the manifest port.

### Gemini returns 0-1000 normalized boxes, NOT pixels (Step 5) — critical
The spec's prompt asks for "pixel bounding boxes in screenshot coordinates". Gemini ignores
that and uses its native normalized scale. Treating the numbers as pixels put every click
roughly 100 px away from its target, on empty background. Nothing errors: clicks land on
nothing, states never transition, and the map fills up with junk. Only drawing the returned
boxes back onto the screenshot exposed it.

Worse, asking for `{x, y, w, h}` is itself the trap. With that schema the model translates out
of its native format and mangles the vertical axis specifically: x and w came back pixel-exact
after scaling, while y stayed ~24% too large across every box — consistent, so not noise.

Fix: ask for Gemini's native `box_2d: [ymin, xmin, ymax, xmax]` normalized 0-1000, then convert.
After the switch all 8 affordances landed dead centre on their controls.

Takeaway for any vision-first agent on Gemini: use `box_2d`, and always draw the boxes back
onto the image before trusting them. `scripts/verify-vision.ts` does this and is kept for
re-checking after prompt changes.

### gemini-3.7-flash 503s under load; the model list is not a capability check
`gemini-3.7-flash` returned `503 UNAVAILABLE "experiencing high demand"` for image+schema calls
for roughly two minutes, while a plain text call to the same model succeeded seconds earlier.
It recovered on its own. `proposeAffordances` now backs off (3 tries, 2 s base) per pass.

Also: `models.list` returning a model does NOT mean the key can use it. `gemini-2.5-flash`
appears in the list but answers
`404 "no longer available to new users. Please update to models/gemini-3.6-flash"`.
Confirmed working for vision+schema: 3.5-flash (6.3 s), 3.6-flash (19.3 s), 3.7-flash (7.4 s).
Staying on 3.7 per spec.

### BLOCKER: Gemini free tier is 20 requests/day/model (Step 7)
`429 RESOURCE_EXHAUSTED`, quota `GenerateRequestsPerDayPerProjectPerModel-FreeTier`,
**limit 20**, metric `generate_content_free_tier_requests`.

Exploration spends one vision call per newly discovered state, so a 30-state map needs ~30
calls. **The free tier cannot complete a single Phase 1 e2e run.** Billing must be enabled on
the Gemini API project before Steps 10-12 can run.

The limit is per-model, so spreading calls across 3.5/3.6/3.7 would give 60/day — do not do
this: mixing models mid-run makes the Phase 2 benchmark numbers meaningless.

### A blocked navigation parks the page on chrome-error:// (Step 7)
When `ctx.route` aborts a navigation, the page lands on `chrome-error://chromewebdata/` and the
*next* `goto` fails with "interrupted by another navigation to chrome-error://chromewebdata/".
The error navigation is still settling when the new one starts.

Matters for exploration: any click that tries to leave the preview host poisons that page. The
explorer already builds a fresh context per episode, which contains it, but any code doing two
navigations in one page after a block needs to expect this.

### Preview gateway is behind an AWS ALB that injects its own cookies (Step 6)
Logging in over the preview URL with raw `fetch`, `res.headers.get("set-cookie")` returns
**`AWSALB=...`**, not Flask's `session`. The gateway's load balancer sets `AWSALB` and
`AWSALBCORS` alongside the app's own cookie, and `.get()` yields only the first header.

The failure is silent and convincing: every later request is unauthenticated, `POST
/orders/1/refund` answers `302` (to `/login`, not to the order page), the digest never moves,
and it all reads as "revert worked, nothing mutated". Cost an entire debug VM to spot.

Fix: `res.headers.getSetCookie()` (array of every Set-Cookie) and replay them all — keeping
`AWSALB` is desirable anyway for load-balancer stickiness. Playwright's `storageState` handles
this correctly on its own, so this bites raw-fetch callers only.

### Verified: digest only moves on writes (Step 2)
Baseline digest, then 5 read-only page loads (`/orders`, `/orders/3`, `/customers`,
`/customers/4`, `/settings`) -> digest byte-identical. Each of refund / settings-save /
delete changed it. No `shop.db-wal` or `-journal` sidecars appeared, confirming
`PRAGMA journal_mode=DELETE` keeps mutations inside the digested file.
