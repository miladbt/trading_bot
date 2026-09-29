/**
 * Execution order lifecycle: the adapter-level state machine.
 *
 * This is the venue-facing lifecycle (uppercase, venue-style), deliberately
 * separate from `@bot/domain`'s order model (lowercase, domain-style). Every
 * execution adapter — the paper simulator now, a live Polymarket adapter
 * later — must express order state in these terms.
 *
 * Transitions:
 * - CREATED      → SUBMITTED | REJECTED        (initial; validation gate)
 * - SUBMITTED    → LIVE | CANCEL_REQUESTED | REJECTED
 * - LIVE         → PARTIALLY_FILLED | FILLED | CANCEL_REQUESTED | REJECTED
 * - PARTIALLY_FILLED → PARTIALLY_FILLED | FILLED | CANCEL_REQUESTED
 * - CANCEL_REQUESTED → CANCELLED | PARTIALLY_FILLED | FILLED
 *    (the cancel may lose the race against a final fill)
 * - FILLED / CANCELLED / REJECTED are terminal.
 */

export type ExecutionStatus =
  | "CREATED"
  | "SUBMITTED"
  | "LIVE"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCEL_REQUESTED"
  | "CANCELLED"
  | "REJECTED";

export const EXECUTION_STATUSES: readonly ExecutionStatus[] = [
  "CREATED",
  "SUBMITTED",
  "LIVE",
  "PARTIALLY_FILLED",
  "FILLED",
  "CANCEL_REQUESTED",
  "CANCELLED",
  "REJECTED",
] as const;

const EXECUTION_TRANSITIONS: Readonly<Record<ExecutionStatus, readonly ExecutionStatus[]>> = {
  CREATED: ["SUBMITTED", "REJECTED"],
  SUBMITTED: ["LIVE", "CANCEL_REQUESTED", "REJECTED"],
  LIVE: ["PARTIALLY_FILLED", "FILLED", "CANCEL_REQUESTED", "REJECTED"],
  PARTIALLY_FILLED: ["PARTIALLY_FILLED", "FILLED", "CANCEL_REQUESTED"],
  FILLED: [],
  CANCEL_REQUESTED: ["CANCELLED", "PARTIALLY_FILLED", "FILLED"],
  CANCELLED: [],
  REJECTED: [],
};

export function canTransitionExecution(from: ExecutionStatus, to: ExecutionStatus): boolean {
  return EXECUTION_TRANSITIONS[from].includes(to);
}

/** Statuses from which the order may still trade. */
export function isWorkingExecution(s: ExecutionStatus): boolean {
  return s === "SUBMITTED" || s === "LIVE" || s === "PARTIALLY_FILLED";
}

/** Statuses that can accept a cancel request. */
export function isCancellableExecution(s: ExecutionStatus): boolean {
  return isWorkingExecution(s);
}

/** Terminal statuses: no further transitions. */
export function isTerminalExecution(s: ExecutionStatus): boolean {
  return s === "FILLED" || s === "CANCELLED" || s === "REJECTED";
}
