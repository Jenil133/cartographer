import { readFileSync } from "node:fs";
import { z } from "zod";
import type { TargetManifest } from "./types.js";

// Always skipped: logging out ends the session and strands the explorer.
const DEFAULT_BLOCKLIST = ["log ?out", "sign ?out"];
const DEFAULT_BUDGET = {
  maxActions: 40,
  maxStates: 30,
  maxVisionCalls: 40,
  maxMinutes: 25,
};

const LoginStep = z.union([
  z.object({ fill: z.tuple([z.string(), z.string()]) }),
  z.object({ click: z.string() }),
]);

const ManifestSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9-]+$/, "must match /^[a-z0-9-]+$/ (used as maps/<name>)"),
  source: z.union([
    z.object({
      type: z.literal("repo"),
      repo: z.string(),
      ref: z.string().optional(),
      subdir: z.string().optional(),
    }),
    z.object({ type: z.literal("local"), dir: z.string() }),
  ]),
  runtime: z.object({
    install: z.array(z.string()),
    start: z.string(),
    port: z.number().int().positive(),
    readyPath: z.string().startsWith("/"),
    cpu: z.number().int().positive().optional(),
    memMb: z.number().int().positive().optional(),
    diskGb: z.number().int().positive().optional(),
  }),
  dataPaths: z.array(z.string()).min(1),
  login: z.object({ url: z.string(), steps: z.array(LoginStep) }).optional(),
  blocklist: z.array(z.string()).default([]),
  viewport: z
    .object({ width: z.number().int().positive(), height: z.number().int().positive() })
    .default({ width: 1280, height: 800 }),
  budget: z
    .object({
      maxActions: z.number().int().positive(),
      maxStates: z.number().int().positive(),
      maxVisionCalls: z.number().int().positive(),
      maxMinutes: z.number().positive(),
    })
    .default(DEFAULT_BUDGET),
});

/** Parse an already-loaded object. Throws with field paths on invalid input. */
export function parseManifest(raw: unknown, origin = "manifest"): TargetManifest {
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid ${origin}:\n${detail}`);
  }
  const m = parsed.data;
  return {
    ...m,
    // Union, not override: a manifest may add blocklist entries but never drop the defaults.
    blocklist: [...new Set([...m.blocklist, ...DEFAULT_BLOCKLIST])],
  } as TargetManifest;
}

export function loadManifest(path: string): TargetManifest {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`Cannot read manifest: ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`Manifest is not valid JSON (${path}): ${(err as Error).message}`);
  }
  return parseManifest(raw, path);
}
