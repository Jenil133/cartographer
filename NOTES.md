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
| Revert latency p50 (web) | _not measured yet_ | Phase 1 Step 6 |
| Revert latency p50 (desktop) | _not measured yet_ | Phase 3 |
| Browser session relaunches per run | _not measured yet_ | Phase 1 |
| Cost per map | _not measured yet_ | Phase 1 |

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

### Verified: digest only moves on writes (Step 2)
Baseline digest, then 5 read-only page loads (`/orders`, `/orders/3`, `/customers`,
`/customers/4`, `/settings`) -> digest byte-identical. Each of refund / settings-save /
delete changed it. No `shop.db-wal` or `-journal` sidecars appeared, confirming
`PRAGMA journal_mode=DELETE` keeps mutations inside the digested file.
