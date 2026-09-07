import { Solari } from "@solarisdk/browser";
import { config } from "../config.js";
import { log } from "../log.js";
import { sleep } from "../util/sleep.js";
import type { SandboxHost } from "./sandboxHost.js";
import type { Bbox, DomHint, TargetManifest } from "../types.js";

export interface Observation {
  png: Buffer;
  visible: string;
  doms: DomHint[];
  url: string;
  title: string;
}

/** Minimum overlap for a DOM element to be considered the same thing as an affordance. */
const IOU_MATCH = 0.3;

export class BrowserPool {
  private solari = new Solari({
    apiKey: config.SOLARI_API_KEY,
    baseUrl: config.SOLARI_BASE_URL,
  });

  private browser: Awaited<ReturnType<Solari["launch"]>> | null = null;
  storageState: unknown = null;
  relaunches = 0;
  private launchedAt = 0;

  constructor(
    private host: SandboxHost,
    private m: TargetManifest,
  ) {}

  get browserMinutes(): number {
    return this.launchedAt ? (Date.now() - this.launchedAt) / 60_000 : 0;
  }

  /**
   * Sessions are cheap and reportedly die ~10 min after creation regardless of
   * activity, so relaunch on demand rather than holding one open for a whole run.
   */
  private async ensureBrowser() {
    if (this.browser && this.browser.isConnected()) return this.browser;
    if (this.browser) {
      this.relaunches++;
      log.warn({ relaunches: this.relaunches }, "browser session died; relaunching");
    }
    // Fast pool, no stealth: we only ever talk to our own preview host.
    this.browser = await this.solari.launch({ recording: false });
    if (!this.launchedAt) this.launchedAt = Date.now();
    log.info({ sessionId: this.browser.id }, "browser launched");
    return this.browser;
  }

  async newContext() {
    const b = await this.ensureBrowser();
    const ctx = await b.newContext({
      viewport: this.m.viewport,
      deviceScaleFactor: 1,
      ...(this.storageState ? { storageState: this.storageState as never } : {}),
    });

    // Principle 3, enforced at the network layer: the exploring browser may only
    // reach the sandbox preview host, and every request carries the preview token.
    await ctx.route("**/*", (route) => {
      const req = route.request();
      const host = new URL(req.url()).host;
      if (this.host.previewBase.includes(host)) {
        return route.continue({
          headers: { ...req.headers(), ...this.host.previewHeaders() },
        });
      }
      return route.abort("blockedbyclient");
    });

    const page = await ctx.newPage();
    page.setDefaultTimeout(15_000);
    return { ctx, page };
  }

  /**
   * One-time, DOM-driven login. Explicitly NOT exploration: this is the only
   * place a selector may drive an action, and it runs before any mapping starts.
   */
  async login(): Promise<void> {
    if (!this.m.login) return;
    const { ctx, page } = await this.newContext();
    try {
      await page.goto(this.host.previewBase + this.m.login.url, { waitUntil: "networkidle" });
      for (const step of this.m.login.steps) {
        if ("fill" in step) await page.fill(step.fill[0], step.fill[1]);
        else await page.click(step.click);
      }
      await page.waitForLoadState("networkidle");
      this.storageState = await ctx.storageState();
      log.info("login complete; storageState captured");
    } finally {
      await ctx.close();
    }
  }

  async observe(page: Awaited<ReturnType<BrowserPool["newContext"]>>["page"]): Promise<Observation> {
    const png = Buffer.from(await page.screenshot({ type: "png", fullPage: false }));
    const visible: string = await page.evaluate(() => document.body?.innerText ?? "");
    const doms: DomHint[] = await page.evaluate(() =>
      [...document.querySelectorAll("a,button,[role=button],input[type=submit]")].map((el) => {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          text: (el as HTMLElement).innerText?.trim().slice(0, 80) ?? "",
          selectorHint: el.id ? "#" + el.id : el.tagName.toLowerCase(),
          bbox: { x: r.x, y: r.y, w: r.width, h: r.height },
          href: (el as HTMLAnchorElement).href || undefined,
        };
      }),
    );
    return { png, visible, doms, url: page.url(), title: await page.title() };
  }

  /** Coordinates only. Vision decides where; this just executes. */
  async clickAt(
    page: Awaited<ReturnType<BrowserPool["newContext"]>>["page"],
    x: number,
    y: number,
  ): Promise<void> {
    await page.mouse.move(x, y);
    await page.mouse.click(x, y);
    await Promise.race([page.waitForLoadState("networkidle").catch(() => {}), sleep(4000)]);
    await sleep(1200); // settle: let any transition finish before observing
  }

  async close(): Promise<void> {
    try {
      await this.browser?.close();
    } catch {
      /* session may already be gone */
    }
    try {
      await this.solari.close();
    } catch {
      /* ignore */
    }
  }
}

function iou(a: Bbox, b: Bbox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (inter <= 0) return 0;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

/**
 * Best-overlapping DOM element for a vision-proposed box, or undefined.
 * Metadata only: this never changes where we click, it only annotates the map.
 */
export function matchDomHint(bbox: Bbox, doms: DomHint[]): DomHint | undefined {
  let best: DomHint | undefined;
  let bestScore = IOU_MATCH;
  for (const d of doms) {
    const score = iou(bbox, d.bbox);
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}
