/**
 * Execution package: order-lifecycle ports and the deterministic paper
 * execution adapter.
 *
 * `PaperExecutionAdapter` implements the same `ExecutionAdapter` port a future
 * Polymarket live adapter will implement. It simulates limit orders, post-only
 * behavior, partial and full fills, cancellations, rejections, order-book
 * interaction, fees, and configured latency — with total determinism (the
 * simulation advances only when the caller advances the clock).
 *
 * Paper mode guarantee: `createExecutionAdapter("paper", ...)` is the only
 * construction path and always yields the paper simulator, which holds no
 * venue client, no credentials, and no network code. Live execution does not
 * exist; asking for it fails closed.
 */

export type {
  ExecutionAdapter,
  ExecutionFill,
  ExecutionOrder,
  ExecutionOrderRequest,
  ExecutionResult,
} from "./adapter.js";

export {
  EXECUTION_STATUSES,
  canTransitionExecution,
  isCancellableExecution,
  isTerminalExecution,
  isWorkingExecution,
  type ExecutionStatus,
} from "./lifecycle.js";

export {
  bookDepth,
  createSimulatedBook,
  matchAgainstBook,
  type BookLevel,
  type MatchOutcome,
  type SimulatedBook,
} from "./book.js";

export {
  DEFAULT_PESSIMISTIC_FILL_PARAMS,
  PaperExecutionAdapter,
  type FillModel,
  type PaperAdapterConfig,
  type PaperTokenConfig,
  type PessimisticFillParams,
} from "./paper-adapter.js";

export {
  LiveExecutionNotImplementedError,
  assertPaperBackend,
  createExecutionAdapter,
  type ExecutionBackend,
  type LiveExecutionAdapter,
} from "./factory.js";

export {
  normalizeFill,
  normalizeOrder,
  normalizeStatus,
  parseDecimal,
  type RawCancelResponse,
  type RawFillDto,
  type RawOrderDto,
  type RawOrderPostResponse,
  type RawOrderStatus,
} from "./polymarket/dto.js";

export {
  MockClobTransport,
  type ClobFailureReason,
  type ClobResult,
  type ClobTransport,
} from "./polymarket/transport.js";

export {
  PolymarketExecutionAdapter,
  type AsyncExecutionAdapter,
  type PolymarketAdapterConfig,
  type RiskGate,
} from "./polymarket/polymarket-adapter.js";
