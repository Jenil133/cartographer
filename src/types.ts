// Shared data model. Phases 2 and 3 EXTEND these types but never rename a field.

export type Bbox = { x: number; y: number; w: number; h: number }; // screenshot pixels
export type ActionKind = "click" | "type" | "press" | "navigate";
export type Risk = "read" | "write" | "unknown";

/** Cross-check metadata ONLY. Never used to decide or execute an action. */
export interface DomHint {
  tag: string;
  text: string;
  selectorHint: string;
  bbox: Bbox;
  href?: string;
}

export interface Affordance {
  id: string; // "a_" + sha10(stateId + label + round(cx) + round(cy))
  stateId: string;
  label: string; // e.g. "Refund order button"
  kind: ActionKind; // P1 only produces "click"
  bbox: Bbox;
  expected: string; // model's one-line guess of the effect
  risk: Risk; // model's guess; informational
  dom?: DomHint;
  status: "pending" | "explored" | "skipped" | "failed";
  skipReason?: string;
}

export interface StateNode {
  id: string; // "s_" + sha10(urlPath + "|" + domDigest)
  kind: "web" | "desktop";
  url: string;
  urlPath: string;
  title: string;
  phash: string; // 16 hex chars (64-bit dHash)
  domDigest: string; // sha256 of normalized visible text ("" for desktop)
  screenshot: string; // relative: "shots/<id>.png"
  affordances: Affordance[];
  pathFromRoot: string[]; // edge ids from root state to here
  discoveredInRun: string;
}

export interface EdgeAction {
  kind: ActionKind;
  x: number;
  y: number;
  label: string;
  text?: string;
  key?: string;
  affordanceId: string;
}

export interface Edge {
  id: string; // "e_" + zero-padded counter, e.g. e_000017
  from: string;
  to: string;
  action: EdgeAction;
  mutated: boolean; // data digest changed after action
  reverted: boolean; // sandbox reverted to root snapshot afterwards
  digestBefore: string;
  digestAfter: string;
  evidence: { before: string; after: string; replayUrl?: string }; // shot paths
  durationMs: number;
  ts: string;
  runId: string;
}

export interface Budget {
  maxActions: number;
  maxStates: number;
  maxVisionCalls: number;
  maxMinutes: number;
}

export interface Spent {
  actions: number;
  states: number;
  visionCalls: number;
  reverts: number;
  sandboxMinutes: number;
  browserMinutes: number;
  estUsd: number;
}

export interface RunMeta {
  id: string; // "r_" + ISO timestamp compact
  startedAt: string;
  finishedAt?: string;
  targetName: string;
  mode: "sandbox" | "live" | "desktop"; // P1: "sandbox" only
  budget: Budget;
  spent: Spent;
  sandboxId?: string;
  rootSnapshotId?: string;
  rootDigest?: string;
  notes: string[]; // free-form incidents (relaunches, revert timings)
}

export interface TargetManifest {
  name: string; // [a-z0-9-]+, used as maps/<name>
  source:
    | { type: "repo"; repo: string; ref?: string; subdir?: string }
    | { type: "local"; dir: string };
  runtime: {
    install: string[]; // sh commands run once in the sandbox
    start: string; // sh command; must listen on runtime.port
    port: number;
    readyPath: string; // GET readyPath must return 2xx
    cpu?: number;
    memMb?: number;
    diskGb?: number;
  };
  dataPaths: string[]; // absolute paths in sandbox to digest (files/dirs)
  login?: {
    url: string;
    steps: Array<{ fill: [string, string] } | { click: string }>;
  };
  blocklist: string[]; // regexes on affordance label
  viewport: { width: number; height: number };
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
