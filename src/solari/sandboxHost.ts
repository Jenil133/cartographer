import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { SandboxClient } from "@solarisdk/sandbox";
import { config } from "../config.js";
import { log } from "../log.js";
import { retry, sleep } from "../util/sleep.js";
import type { TargetManifest } from "../types.js";

/** Files never worth uploading into the sandbox. shop.db is regenerated on boot. */
const SKIP_UPLOAD = new Set(["shop.db", "__pycache__", ".git", ".DS_Store", "node_modules"]);

const APP_DIR = "/work/app";

export class SandboxHost {
  readonly mode = "sandbox" as const;

  private client = new SandboxClient({
    apiKey: config.SOLARI_API_KEY,
    baseUrl: config.SOLARI_BASE_URL,
    // Long per-RPC timeout so installs can stream over the control channel.
    callTimeoutMs: 900_000,
  });

  // Assigned during boot(); reading them before boot is a programming error.
  sbx!: Awaited<ReturnType<SandboxClient["create"]>>;
  id!: string;
  previewBase!: string;
  previewToken!: string;
  rootSnapshotId!: string;
  rootDigest!: string;

  private m!: TargetManifest;
  private bootedAt = 0;

  /** Minutes this VM has been alive, for the spend report. */
  get sandboxMinutes(): number {
    return this.bootedAt ? (Date.now() - this.bootedAt) / 60_000 : 0;
  }

  async boot(m: TargetManifest, localDir?: string): Promise<void> {
    this.m = m;
    this.bootedAt = Date.now();

    this.sbx = await this.client.create({
      template: "base",
      cpu: m.runtime.cpu ?? 2,
      memMb: m.runtime.memMb ?? 4096,
      diskGb: m.runtime.diskGb ?? 4,
      timeoutMs: 30 * 60_000,
      lifecycle: { onTimeout: "kill" },
      metadata: { app: "cartographer", target: m.name },
    });
    this.id = this.sbx.id;
    log.info({ sandboxId: this.id }, "sandbox created");

    // Control channel must be open before files.*, git.* and streamed commands.
    await this.sbx.connect();

    await this.sh(`mkdir -p ${APP_DIR}`);
    if (m.source.type === "local") {
      if (!localDir) throw new Error("local source needs localDir");
      await this.uploadDir(localDir, APP_DIR);
    } else {
      await this.sbx.git.clone(m.source.repo, {
        path: APP_DIR,
        ...(m.source.ref ? { branch: m.source.ref } : {}),
        depth: 1,
      });
    }

    for (const cmd of m.runtime.install) await this.runLong(cmd, 10 * 60_000);

    await this.startServer();
    this.rootDigest = await this.digest();
    this.rootSnapshotId = await this.sbx.snapshot("cartographer-root");
    log.info(
      { snapshotId: this.rootSnapshotId, digest: this.rootDigest.slice(0, 12) },
      "root snapshot taken",
    );
  }

  /** Every command goes through `sh -c`: the guest runs argv directly, with no shell. */
  private async sh(cmd: string, timeoutMs?: number) {
    return this.sbx.commands.run("sh", {
      args: ["-c", cmd],
      ...(timeoutMs ? { timeoutMs } : {}),
    });
  }

  private async uploadDir(localDir: string, remoteDir: string): Promise<void> {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (SKIP_UPLOAD.has(entry)) continue;
        const abs = join(dir, entry);
        if (statSync(abs).isDirectory()) walk(abs);
        else files.push(abs);
      }
    };
    walk(localDir);

    for (const abs of files) {
      const rel = relative(localDir, abs).split(sep).join(posix.sep);
      await this.sbx.files.write(posix.join(remoteDir, rel), readFileSync(abs));
    }
    log.info({ count: files.length, remoteDir }, "uploaded app files");
  }

  /**
   * Run a long command.
   *
   * Once connect() is open, commands.run with stream callbacks goes over the
   * control channel and honours callTimeoutMs. The ~28s cap people hit applies
   * to the warm REST fast path, not this. nohup+poll stays as the fallback.
   */
  async runLong(cmd: string, timeoutMs: number): Promise<void> {
    try {
      const r = await this.sbx.commands.run("sh", {
        args: ["-c", cmd],
        timeoutMs,
        onStdout: (d: string) => log.debug(d.trimEnd()),
        onStderr: (d: string) => log.debug(d.trimEnd()),
      });
      if (r.exitCode !== 0) {
        throw new Error(`command failed (${r.exitCode}): ${cmd}\n${r.stderr.slice(-2000)}`);
      }
      return;
    } catch (err) {
      if (!/timeout/i.test(String((err as Error)?.message))) throw err;
      log.warn("streamed run timed out; falling back to nohup+poll");
    }
    return this.runLongDetached(cmd, timeoutMs);
  }

  private async runLongDetached(cmd: string, timeoutMs: number): Promise<void> {
    const tag = "c" + Date.now();
    const escaped = cmd.replace(/'/g, `'\\''`);
    await this.sh(`nohup sh -c '${escaped}' > /tmp/${tag}.log 2>&1; echo $? > /tmp/${tag}.done &`);

    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await sleep(2000);
      const r = await this.sh(`cat /tmp/${tag}.done 2>/dev/null || true`);
      const code = r.stdout.trim();
      if (code === "") continue;
      if (code !== "0") {
        const tail = await this.sh(`tail -50 /tmp/${tag}.log`);
        throw new Error(`command failed (${code}): ${cmd}\n${tail.stdout}`);
      }
      return;
    }
    throw new Error("runLong timeout: " + cmd);
  }

  async startServer(): Promise<void> {
    const escaped = this.m.runtime.start.replace(/'/g, `'\\''`);
    await this.sh(`nohup sh -c '${escaped}' > /tmp/app.log 2>&1 &`);
    await this.refreshPreview();
    await this.waitReady(120_000);
  }

  async refreshPreview(): Promise<void> {
    const { url, token } = await this.sbx.previewUrl(this.m.runtime.port);
    const u = new URL(url);
    // The gateway may sign the token into the query string instead of returning it.
    this.previewToken = token ?? u.searchParams.get("pt_token") ?? "";
    u.search = "";
    this.previewBase = u.toString().replace(/\/$/, "");
  }

  /** Token goes in a header on every request; concatenating it into the URL breaks paths. */
  previewHeaders(): Record<string, string> {
    return this.previewToken ? { "x-pinetree-preview-token": this.previewToken } : {};
  }

  async waitReady(timeoutMs: number): Promise<void> {
    const t0 = Date.now();
    let lastStatus = "no response";
    while (Date.now() - t0 < timeoutMs) {
      try {
        const r = await fetch(this.previewBase + this.m.runtime.readyPath, {
          headers: this.previewHeaders(),
        });
        if (r.ok) return;
        lastStatus = `HTTP ${r.status}`;
        // 401 = preview token expired (1h TTL). 425 = nothing listening yet.
        if (r.status === 401) await this.refreshPreview();
      } catch (err) {
        lastStatus = String((err as Error)?.message).slice(0, 80);
      }
      await sleep(1500);
    }
    const appLog = await this.sh("tail -30 /tmp/app.log 2>/dev/null || true");
    throw new Error(
      `app not ready at ${this.m.runtime.readyPath} (${lastStatus})\n${appLog.stdout}`,
    );
  }

  /** sha256 over the app's data files. Changing = the world mutated. */
  async digest(): Promise<string> {
    const paths = this.m.dataPaths.map((p) => `'${p}'`).join(" ");
    const r = await this.sh(
      `find ${paths} -type f -print0 2>/dev/null | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1`,
    );
    const d = r.stdout.trim();
    if (!d) throw new Error("digest empty - are dataPaths correct?");
    return d;
  }

  /**
   * Restore the world to the root snapshot. Returns how long it took, which is
   * the number the whole project is judged on.
   */
  async revertToRoot(): Promise<number> {
    const t0 = Date.now();
    await this.sbx.revert(this.rootSnapshotId);
    // revert boots a fresh VM and swaps it in: the control channel drops.
    await retry(() => this.sbx.reconnect(), { tries: 5, baseMs: 1000 });
    await this.refreshPreview();

    // The snapshot captured RAM, so the app process should still be up.
    // Fail-closed: verify, and restart it if not.
    try {
      await this.waitReady(30_000);
    } catch {
      log.warn("app not alive after revert; restarting");
      await this.startServer();
    }

    const d = await this.digest();
    if (d !== this.rootDigest) {
      throw new Error(`revert did not restore root digest (${d} != ${this.rootDigest})`);
    }
    return Date.now() - t0;
  }

  /** kill(), never close(): close() leaves the VM running and billing. */
  async kill(): Promise<void> {
    try {
      await this.sbx.kill();
      log.info({ sandboxId: this.id }, "sandbox killed");
    } catch (err) {
      log.warn({ err: String(err).slice(0, 200) }, "kill failed");
    }
  }

  async deleteRootSnapshot(): Promise<void> {
    if (!this.rootSnapshotId) return;
    try {
      await this.client.deleteSnapshot(this.rootSnapshotId);
    } catch (err) {
      log.warn({ err: String(err).slice(0, 200) }, "snapshot delete failed");
    }
  }
}
