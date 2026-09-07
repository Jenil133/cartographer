# Cartographer

**Build a map of any app before your agent touches it.**

Cartographer hosts a target app inside a [Solari](https://getsolari.com) sandbox, snapshots the
booted world, and explores every clickable path **vision-first**: it screenshots the page, asks
Gemini what looks clickable, and clicks by pixel coordinates. Any action that changes the app's
data — detected by hashing the app's data files — is **undone with `revert()`** back to the root
snapshot, so exploring "Delete" and "Refund" is safe. The output is a map of states, affordances,
edges, mutation flags and screenshots that an agent can consult instead of rediscovering the app
one click at a time.

Built on the two Solari primitives most agent projects never touch: **snapshot/revert** as an undo
button, and the sandbox preview URL as an isolated world.

## The loop

```
 pop (state, affordance) from the frontier
        |
        v
 world at root digest?  --no-->  revert(rootSnapshot)
        |
        v
 reach the state (navigate, or replay the click path)
        |
        v
 screenshot -> click at the affordance's bbox centre -> screenshot
        |
        v
 digest the data files
        |
        +-- unchanged --> record a read-only edge
        |
        +-- changed ----> record a MUTATING edge, then revert() to root
        |
        v
 new state? -> vision proposes affordances -> push them on the frontier
```

## Principles

1. **Vision-first.** What to click is decided from the screenshot, and clicks execute by
   coordinates. DOM data is captured as cross-check metadata and never decides or performs an
   action. The only selector-driven step is the one-time login.
2. **Fail-closed.** No state without a screenshot; no edge without before/after evidence and
   digests. Uncertain is recorded as `unknown`, never as success.
3. **No external side effects.** The exploring browser can reach the sandbox preview host and
   nothing else; every other request is aborted at the network layer.
4. **Every mutation is reverted.** If the data digest moves, the sandbox goes back to the root
   snapshot before exploration continues.
5. **Everything is measured.** Actions, states, vision calls, reverts, VM and browser minutes and
   estimated USD all land in `map.json`.

## Quickstart

Requires Node 22, a Solari API key and a Gemini API key **with billing enabled** (the free tier
allows 20 requests/day/model, which is not enough for one run).

```bash
npm install
cp .env.example .env      # fill in SOLARI_API_KEY and GEMINI_API_KEY
npm test                  # unit tests, no network

npx tsx src/cli.ts explore examples/target-shop/carto.target.json --max-actions 25
npx tsx src/cli.ts view maps/target-shop      # http://localhost:4173
```

`explore` prints a summary of states, edges, mutations, reverts and estimated spend. The viewer
draws the graph with **mutating edges in red**; click one to see the before/after screenshots and
the digests that prove the data changed.

Ctrl-C is safe: the run saves the map, closes the browser and kills the VM. An orphaned sandbox
bills until its idle timeout, so teardown always runs.

## Measured

| | |
|---|---|
| Revert latency (web) | **p50 62.4 s**, min 30.4, max 64.1 (n=5) |
| Sandbox boot to root snapshot | 18.9 s |

Revert is the dominant cost in a run: eight mutating actions is roughly eight minutes of pure
reverting. The distribution is bimodal, which suggests a warm/cold path rather than noise.
`NOTES.md` carries the running log of measurements and platform gotchas.

## Status

Phase 1 (foundation and a thin end-to-end slice). Not yet published to npm. Phase 2 adds the MCP
server (`atlas_route`), live-URL mode and a with-map vs naive benchmark; Phase 3 adds desktop
(screenshot-only) exploration.

## Licence

MIT
