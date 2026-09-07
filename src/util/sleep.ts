export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reject with a labelled error if `p` has not settled within `ms`. */
export async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timeout after ${ms}ms: ${label}`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Exponential backoff with jitter. Throws the last error if every try fails. */
export async function retry<T>(
  fn: () => Promise<T>,
  opts: { tries: number; baseMs: number },
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < opts.tries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === opts.tries - 1) break;
      const backoff = opts.baseMs * 2 ** attempt;
      await sleep(backoff + Math.random() * opts.baseMs);
    }
  }
  throw lastErr;
}
