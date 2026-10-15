/**
 * Reconnect delays: exponential, capped, and jittered.
 *
 * The jitter matters more than the curve. Every page watching an office loses its
 * socket at the same instant when realtime restarts, and a fixed delay would bring
 * them all back in the same millisecond — onto a service that then has to authorize
 * each of them against the api.
 */

export const FIRST_DELAY_MS = 500;
export const MAX_DELAY_MS = 20_000;

/** `attempt` counts from 1. `random` is injectable so the test is not a coin flip. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const n = Math.max(1, Math.floor(attempt));
  const target = Math.min(FIRST_DELAY_MS * 2 ** (n - 1), MAX_DELAY_MS);
  // ±25% around the target, never below the first delay.
  const jittered = target * (0.75 + random() * 0.5);
  return Math.round(Math.max(FIRST_DELAY_MS, Math.min(MAX_DELAY_MS, jittered)));
}
