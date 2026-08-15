// Debounces AI-reply generation per conversation so a burst of several short
// messages sent seconds apart (e.g. "hi", "table for 2", "tonight 8pm" as
// three bubbles) becomes ONE Claude call instead of three. In-memory, same
// spirit as queue.ts's in-process concurrency gate — this app is already a
// single long-lived Render process (not serverless), so per-process state is
// consistent with an existing, already-accepted constraint, not a new one.

export const DEBOUNCE_MS = 6000;

const timers = new Map<string, NodeJS.Timeout>();

/** Runs `fn` after `delayMs` of quiet on `key` — each call resets the timer. */
export function debounce(key: string, delayMs: number, fn: () => void): void {
  const existing = timers.get(key);
  if (existing) clearTimeout(existing);
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      fn();
    }, delayMs)
  );
}
