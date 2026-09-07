import { createHash } from "node:crypto";

export function sha256(str: string): string {
  return createHash("sha256").update(str).digest("hex");
}

export function sha10(str: string): string {
  return sha256(str).slice(0, 10);
}
