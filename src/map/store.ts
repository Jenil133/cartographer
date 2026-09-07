import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MapDoc, TargetManifest } from "../types.js";

export function nextEdgeId(doc: MapDoc): string {
  return "e_" + String(doc.edges.length).padStart(6, "0");
}

export class MapStore {
  constructor(private readonly dir: string) {}

  get mapPath(): string {
    return join(this.dir, "map.json");
  }

  get shotsDir(): string {
    return join(this.dir, "shots");
  }

  private ensureDirs(): void {
    mkdirSync(this.shotsDir, { recursive: true });
  }

  load(): MapDoc | null {
    if (!existsSync(this.mapPath)) return null;
    return JSON.parse(readFileSync(this.mapPath, "utf8")) as MapDoc;
  }

  init(target: TargetManifest): MapDoc {
    this.ensureDirs();
    return {
      version: 1,
      target,
      rootStateId: null,
      states: {},
      edges: [],
      runs: [],
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Atomic write: a run saves after every episode, so a crash mid-write must not
   * leave a truncated map.json that makes --resume unusable.
   */
  save(doc: MapDoc): void {
    this.ensureDirs();
    doc.updatedAt = new Date().toISOString();
    const tmp = this.mapPath + ".tmp";
    writeFileSync(tmp, JSON.stringify(doc, null, 2));
    renameSync(tmp, this.mapPath);
  }

  shotPath(name: string): string {
    return join(this.shotsDir, `${name}.png`);
  }

  writeShot(name: string, png: Buffer): string {
    this.ensureDirs();
    writeFileSync(this.shotPath(name), png);
    return `shots/${name}.png`;
  }
}
