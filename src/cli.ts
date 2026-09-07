#!/usr/bin/env node
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { explore } from "./explore/explorer.js";
import { loadManifest } from "./manifest.js";
import { MapStore } from "./map/store.js";
import { log } from "./log.js";

const program = new Command();
program.name("cartographer").description("Build a map of any app before your agent touches it.");

program
  .command("explore")
  .argument("<manifest>", "path to carto.target.json")
  .option("--max-actions <n>", "override the manifest action budget", Number)
  .option("--resume", "continue from pending affordances in an existing map", false)
  .option("--keep-snapshot", "do not delete the root snapshot at teardown", false)
  .action(async (manifestPath: string, opts) => {
    const m = loadManifest(manifestPath);
    const { doc, run, mapPath } = await explore(m, {
      resume: Boolean(opts.resume),
      keepSnapshot: Boolean(opts.keepSnapshot),
      ...(opts.maxActions ? { maxActions: opts.maxActions } : {}),
    });

    const mutated = doc.edges.filter((e) => e.mutated).length;
    const reverted = doc.edges.filter((e) => e.reverted).length;
    const s = run.spent;
    console.log(
      [
        "",
        `target         ${m.name}`,
        `states         ${Object.keys(doc.states).length}`,
        `edges          ${doc.edges.length}`,
        `mutated        ${mutated}  (reverted ${reverted})`,
        `vision calls   ${s.visionCalls}`,
        `reverts        ${s.reverts}`,
        `sandbox min    ${s.sandboxMinutes.toFixed(2)}`,
        `browser min    ${s.browserMinutes.toFixed(2)}`,
        `est. USD       ${s.estUsd.toFixed(3)}`,
        `map            ${mapPath}`,
      ].join("\n"),
    );
    if (mutated > reverted) {
      console.error(`\nWARNING: ${mutated - reverted} mutating edge(s) were not reverted.`);
      process.exit(1);
    }
  });

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

program
  .command("view")
  .argument("[mapDir]", "map directory, e.g. maps/target-shop", "maps/target-shop")
  .option("-p, --port <n>", "port", (v) => Number(v), 4173)
  .action((mapDir: string, opts: { port: number }) => {
    const dir = resolve(mapDir);
    const store = new MapStore(dir);
    if (!existsSync(store.mapPath)) {
      console.error(`No map.json in ${dir}. Run \`cartographer explore\` first.`);
      process.exit(1);
    }
    const viewerDir = resolve(fileURLToPath(new URL("../viewer", import.meta.url)));

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      // Serve the viewer at /, and the map dir (map.json + shots/) beneath it.
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
      if (rel.includes("..")) {
        res.writeHead(400).end("bad path");
        return;
      }
      const candidates =
        rel === "index.html" ? [join(viewerDir, "index.html")] : [join(dir, rel), join(viewerDir, rel)];
      const file = candidates.find((p) => existsSync(p) && statSync(p).isFile());
      if (!file) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
      createReadStream(file).pipe(res);
    });

    server.listen(opts.port, () => {
      log.info(`viewer: http://localhost:${opts.port}  (serving ${dir})`);
      console.log(`http://localhost:${opts.port}`);
    });
  });

await program.parseAsync(process.argv);
