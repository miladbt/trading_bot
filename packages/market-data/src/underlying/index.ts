// Underlying (spot) market data subsystem — signal-generation input only.
// No order placement surface exists in this package.

export type {
  ConnectionStatus,
  UnderlyingBookTop,
  UnderlyingLastPrice,
  UnderlyingMarketDataProvider,
  UnderlyingMarketSnapshot,
  UnderlyingSymbol,
  UnderlyingVolume,
} from "./types.js";
export { isUnderlyingSymbol, UNDERLYING_SYMBOLS } from "./types.js";

export {
  BINANCE_WS_HOST,
  binanceStreamUrl,
  isOutOfOrder,
  normalizeTicker,
  parseCombinedStream,
  streamSymbol,
  type NormalizedTicker,
  type WebSocketFactory,
  type WebSocketLike,
} from "./binance.js";
export { BinanceUnderlyingProvider, type ProviderOptions } from "./provider.js";

// Test support (exported for consumers writing their own deterministic tests).
export {
  MockSocketFactory,
  MockWebSocket,
  WS_CLOSED,
  WS_CLOSING,
  WS_CONNECTING,
  WS_OPEN,
} from "./mock-ws.js";
