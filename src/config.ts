import "dotenv/config";
import { z } from "zod";

// WHY: fail at startup with a readable error instead of a 401 twenty minutes into a run.
const Env = z.object({
  SOLARI_API_KEY: z.string().startsWith("slr_live_"),
  SOLARI_BASE_URL: z.url().default("https://api.getsolari.com"),
  GEMINI_API_KEY: z.string().min(10),
  // Flash-class. Confirmed live 2026-09-07. Cheaper fallback: a Flash-Lite model.
  GEMINI_MODEL: z.string().default("gemini-3.7-flash"),
  CARTO_MAPS_DIR: z.string().default("./maps"),
  LOG_LEVEL: z.string().default("info"),
});

const parsed = Env.safeParse(process.env);

if (!parsed.success) {
  const lines = parsed.error.issues.map(
    (i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`,
  );
  console.error(
    [
      "Invalid environment. Copy .env.example to .env and fill it in.",
      ...lines,
    ].join("\n"),
  );
  process.exit(1);
}

export const config = parsed.data;
