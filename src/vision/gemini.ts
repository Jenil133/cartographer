import { GoogleGenAI } from "@google/genai";
import { config } from "../config.js";
import { log } from "../log.js";
import { sha10 } from "../util/hash.js";
import { retry } from "../util/sleep.js";
import type { Affordance, Bbox, Risk } from "../types.js";

const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });

/** Max affordances we ask for per screen. Keeps cost and frontier width bounded. */
const MAX_AFFORDANCES = 25;

const SCHEMA = {
  type: "object",
  properties: {
    affordances: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          kind: { type: "string", enum: ["click"] },
          // Gemini's native detection format. Asking for {x,y,w,h} instead makes
          // the model translate, and it reliably mangles the vertical axis.
          box_2d: {
            type: "array",
            items: { type: "integer" },
            minItems: 4,
            maxItems: 4,
          },
          expected: { type: "string" },
          risk: { type: "string", enum: ["read", "write", "unknown"] },
        },
        required: ["label", "kind", "box_2d", "expected", "risk"],
      },
    },
  },
  required: ["affordances"],
};

export interface VisionContext {
  stateId: string;
  width: number;
  height: number;
  title: string;
}

interface RawAffordance {
  label: string;
  kind: "click";
  /** [ymin, xmin, ymax, xmax], normalized 0-1000. Gemini's native box format. */
  box_2d: [number, number, number, number];
  expected: string;
  risk: Risk;
}

/**
 * Gemini emits box coordinates normalized to 0-1000 on both axes, and does so
 * regardless of being asked for pixels. Asking for its native convention and
 * converting here is stable; prompting for pixels is not.
 */
const COORD_SCALE = 1000;

function prompt(ctx: VisionContext): string {
  return `You are mapping a web application by looking ONLY at this screenshot (${ctx.width}x${ctx.height} px).
List every distinct clickable affordance a user could act on: buttons, links, tabs, menu items, table row links, form submit buttons.
Do not invent elements you cannot see. Skip decorative text.
For each, give box_2d as [ymin, xmin, ymax, xmax] normalized to 0-${COORD_SCALE}, a label (visible text + role, e.g. "Refund button"), expected (one sentence: what likely happens), and risk: "read" if it only navigates/shows, "write" if it likely changes data, else "unknown".
Return at most ${MAX_AFFORDANCES} items, most important first.`;
}

/** [ymin, xmin, ymax, xmax] normalized 0-1000 -> pixel {x,y,w,h}. */
function toPixels(box: [number, number, number, number], ctx: VisionContext): Bbox {
  const [ymin, xmin, ymax, xmax] = box;
  const x = (xmin / COORD_SCALE) * ctx.width;
  const y = (ymin / COORD_SCALE) * ctx.height;
  return {
    x,
    y,
    w: (xmax / COORD_SCALE) * ctx.width - x,
    h: (ymax / COORD_SCALE) * ctx.height - y,
  };
}

/**
 * Reject boxes that cannot be real controls.
 *
 * WHY: the model sometimes returns a box covering the whole page, or a sliver
 * with zero area. Clicking either wastes an action and pollutes the map.
 */
function validBbox(ctx: VisionContext) {
  const area = ctx.width * ctx.height;
  return (a: { bbox: Bbox }): boolean => {
    const b = a?.bbox;
    if (!b || [b.x, b.y, b.w, b.h].some((n) => typeof n !== "number" || !Number.isFinite(n))) {
      return false;
    }
    if (b.w < 8 || b.h < 8) return false;
    if (b.w * b.h >= 0.5 * area) return false;
    if (b.x < 0 || b.y < 0) return false;
    if (b.x + b.w > ctx.width || b.y + b.h > ctx.height) return false;
    return true;
  };
}

function affordanceId(ctx: VisionContext, a: { label: string; bbox: Bbox }): string {
  const cx = Math.round(a.bbox.x + a.bbox.w / 2);
  const cy = Math.round(a.bbox.y + a.bbox.h / 2);
  return "a_" + sha10(ctx.stateId + a.label + cx + cy);
}

async function callGemini(png: Buffer, ctx: VisionContext, temperature: number): Promise<string> {
  const res = await ai.models.generateContent({
    model: config.GEMINI_MODEL,
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt(ctx) },
          { inlineData: { mimeType: "image/png", data: png.toString("base64") } },
        ],
      },
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: SCHEMA as never,
      temperature,
    },
  });
  return res.text ?? "{}";
}

/**
 * Screenshot -> affordances. Vision-first: this is the ONLY thing that decides
 * what is clickable. DOM hints are attached later as metadata and never used here.
 *
 * Every call counts against the run's vision budget; the caller records it.
 */
export async function proposeAffordances(
  png: Buffer,
  ctx: VisionContext,
): Promise<Affordance[]> {
  let raw: RawAffordance[] = [];

  for (const [attempt, temperature] of [[0, 0.1], [1, 0]] as const) {
    try {
      // Transient 429/503 gets its own backoff ladder: the model is shared and
      // "high demand" clears on the order of seconds. Retrying immediately just
      // hits the same overload window, so back off before giving up on a pass.
      const text = await retry(() => callGemini(png, ctx, temperature), {
        tries: 3,
        baseMs: 2000,
      });
      const parsed = JSON.parse(text) as { affordances?: RawAffordance[] };
      raw = parsed.affordances ?? [];
      if (raw.length > 0) break;
      log.warn({ stateId: ctx.stateId, attempt }, "vision returned zero affordances");
    } catch (err) {
      // Fail-closed: a second pass at temperature 0, then give up with [].
      log.warn(
        { stateId: ctx.stateId, attempt, err: String(err).slice(0, 200) },
        "vision call failed",
      );
      if (attempt === 1) return [];
    }
  }

  // Convert to pixels BEFORE validating, so the viewport checks are meaningful.
  const scaled = raw
    .filter(
      (a) =>
        Array.isArray(a?.box_2d) &&
        a.box_2d.length === 4 &&
        a.box_2d.every((n) => typeof n === "number" && Number.isFinite(n)),
    )
    .map((a) => ({ ...a, bbox: toPixels(a.box_2d, ctx) }));

  const keep = scaled.filter(validBbox(ctx)).slice(0, MAX_AFFORDANCES);
  if (keep.length < raw.length) {
    log.debug(
      { stateId: ctx.stateId, dropped: raw.length - keep.length },
      "dropped affordances with implausible bboxes",
    );
  }

  return keep.map((a) => ({
    id: affordanceId(ctx, a),
    stateId: ctx.stateId,
    label: a.label,
    kind: "click" as const,
    bbox: a.bbox,
    expected: a.expected,
    risk: a.risk,
    status: "pending" as const,
  }));
}
