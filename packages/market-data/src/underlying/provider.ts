/**
 * BinanceUnderlyingProvider: the concrete `UnderlyingMarketDataProvider`.
 *
 * Behaviors:
 * - subscribe once per start(); the socket factory is injected (tests use a
 *   mock; production uses a real WebSocket).
 * - reconnect with exponential backoff (configurable base/cap) on abnormal
 *   close or socket error; never reconnects after an explicit stop().
 * - heartbeat: if no message arrives within `heartbeatIntervalMs`, the
 *   provider force-reconnects (a hung socket is as bad as a closed one).
 * - staleness: `freshnessMs()` and snapshot.stale derive from the configured
 *   `maxDataAgeMs` (mirrors RISK_MAX_DATA_AGE_MS).
 * - out-of-order rejection: events strictly older than the newest seen venue
 *   time for that symbol are dropped and counted.
 *
 * There is deliberately no order-placement surface here.
 */

import { millis, nowMillis, type Millis } from "@bot/domain";

import {
  binanceStreamUrl,
  isOutOfOrder,
  normalizeTicker,
  parseCombinedStream,
  streamSymbol,
  type CloseEventLike,
  type ErrorEventLike,
  type WebSocketFactory,
  type WebSocketLike,
} from "./binance.js";
import type {
  ConnectionStatus,
  UnderlyingMarketDataProvider,
  UnderlyingMarketSnapshot,
  UnderlyingSymbol,
} from "./types.js";

export interface ProviderOptions {
  readonly symbols: readonly UnderlyingSymbol[];
  readonly wsFactory: WebSocketFactory;
  readonly url?: string;
  /** First backoff delay; doubles up to maxReconnectDelayMs. Default 500ms. */
  readonly reconnectBaseDelayMs?: number;
  readonly maxReconnectDelayMs?: number;
  /** Force reconnect when silent this long. Default 10s. */
  readonly heartbeatIntervalMs?: number;
  /** Data older than this is stale. Default 5s. */
  readonly maxDataAgeMs?: number;
  /** Wall-clock accessor; injectable for deterministic tests. */
  readonly clock?: () => Millis;
}

interface SymbolState {
  lastPrice: string | undefined;
  bid: string | undefined;
  ask: string | undefined;
  baseVolume: string | undefined;
  quoteVolume: string | undefined;
  /** Venue event time of the newest accepted event. */
  lastEventTime: number | undefined;
  /** Receive time of the newest accepted event. */
  lastReceivedAt: Millis | undefined;
  outOfOrderDropped: number;
  malformedDropped: number;
}

type EventListener = (symbol: UnderlyingSymbol, snapshot: UnderlyingMarketSnapshot) => void;
type StatusListener = (status: ConnectionStatus, detail?: string) => void;

const CLOSING = 2;
const CLOSED = 3;

export class BinanceUnderlyingProvider implements UnderlyingMarketDataProvider {
  private readonly symbols: readonly UnderlyingSymbol[];
  private readonly wsFactory: WebSocketFactory;
  private readonly url: string;
  private readonly baseDelay: number;
  private readonly maxDelay: number;
  private readonly heartbeatIntervalMs: number;
  private readonly maxDataAgeMs: number;
  private readonly clock: () => Millis;

  private socket: WebSocketLike | null = null;
  private connectionState: ConnectionStatus = "idle";
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;

  private readonly states = new Map<UnderlyingSymbol, SymbolState>();
  private readonly eventListeners = new Set<EventListener>();
  private readonly statusListeners = new Set<StatusListener>();
  private unattributableMalformed = 0;

  constructor(options: ProviderOptions) {
    if (options.symbols.length === 0) {
      throw new Error("BinanceUnderlyingProvider requires at least one symbol");
    }
    this.symbols = [...options.symbols];
    this.wsFactory = options.wsFactory;
    this.url = options.url ?? binanceStreamUrl(this.symbols);
    this.baseDelay = options.reconnectBaseDelayMs ?? 500;
    this.maxDelay = options.maxReconnectDelayMs ?? 15_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
    this.maxDataAgeMs = options.maxDataAgeMs ?? 5_000;
    this.clock = options.clock ?? nowMillis;
    for (const s of this.symbols) {
      this.states.set(s, {
        lastPrice: undefined,
        bid: undefined,
        ask: undefined,
        baseVolume: undefined,
        quoteVolume: undefined,
        lastEventTime: undefined,
        lastReceivedAt: undefined,
        outOfOrderDropped: 0,
        malformedDropped: 0,
      });
    }
  }

  // ------------------------------------------------------------------ lifecycle

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempts = 0;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearHeartbeat();
    const socket = this.socket;
    this.socket = null;
    this.setStatus("closed");
    if (socket !== null && socket.readyState !== CLOSED) {
      socket.close(1000, "provider stop");
    }
  }

  private connect(): void {
    if (this.stopped) return;
    if (this.attempts === 0) {
      this.setStatus("connecting");
    } else {
      this.setStatus("reconnecting", this.lastReconnectDetail);
    }
    let socket: WebSocketLike;
    try {
      socket = this.wsFactory(this.url);
    } catch (e: unknown) {
      this.scheduleReconnect(`factory error: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.attempts = 0;
      this.setStatus("connected");
      this.armHeartbeat();
    };

    socket.onmessage = (event: { data: unknown }) => {
      this.armHeartbeat(); // any traffic proves liveness
      this.handleRawMessage(event.data);
    };

    socket.onerror = (event: ErrorEventLike) => {
      // Error events are informational; close (if any) triggers the reconnect.
      if (this.connectionState === "connected") {
        this.setStatus("reconnecting", event.message ?? "socket error");
      }
    };

    socket.onclose = (event: CloseEventLike) => {
      this.clearHeartbeat();
      this.socket = null;
      if (this.stopped) {
        this.setStatus("closed");
        return;
      }
      this.scheduleReconnect(`closed (code=${event.code ?? "?"})`);
    };
  }

  private lastReconnectDetail: string | undefined = undefined;

  private scheduleReconnect(detail: string): void {
    if (this.stopped) return;
    // A reconnect is already pending (e.g. heartbeat fired and the subsequent
    // close also requested one): one scheduled reconnect is enough.
    if (this.reconnectTimer !== null) return;
    this.attempts += 1;
    const delay = Math.min(this.baseDelay * 2 ** (this.attempts - 1), this.maxDelay);
    this.lastReconnectDetail = detail;
    this.setStatus("reconnecting", `${detail}; retry ${this.attempts} in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private armHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setTimeout(() => {
      // Silence beyond the heartbeat window: treat the socket as hung.
      this.teardownSocket(`heartbeat timeout after ${this.heartbeatIntervalMs}ms silence`);
      this.scheduleReconnect("heartbeat timeout");
    }, this.heartbeatIntervalMs);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private teardownSocket(reason: string): void {
    const socket = this.socket;
    this.socket = null;
    if (socket !== null && socket.readyState !== CLOSED && socket.readyState !== CLOSING) {
      socket.close(4000, reason);
    }
  }

  private setStatus(status: ConnectionStatus, detail?: string): void {
    this.connectionState = status;
    for (const l of this.statusListeners) l(status, detail);
  }

  // ------------------------------------------------------------------ messages

  private handleRawMessage(raw: unknown): void {
    const at = this.clock();
    const combined = parseCombinedStream(raw);
    if (combined === undefined) {
      // Bare payloads (single-stream mode) are also accepted.
      this.handleTickerObject(raw, at);
      return;
    }
    const symbol = streamSymbol(combined.stream);
    if (symbol === undefined) {
      this.malformedFor(undefined);
      return;
    }
    this.handleTickerObject(combined.data, at, symbol);
  }

  private handleTickerObject(data: unknown, at: Millis, symbolHint?: UnderlyingSymbol): void {
    if (typeof data !== "object" || data === null) {
      this.malformedFor(symbolHint);
      return;
    }
    const obj = data as Record<string, unknown>;
    const ticker = normalizeTicker(obj);
    if (ticker === undefined) {
      this.malformedFor(symbolHint);
      return;
    }
    const state = this.states.get(ticker.symbol);
    if (state === undefined) {
      this.malformedFor(ticker.symbol);
      return;
    }
    if (isOutOfOrder(ticker.eventTime, state.lastEventTime)) {
      state.outOfOrderDropped += 1;
      return;
    }
    state.lastPrice = ticker.lastPrice;
    state.bid = ticker.bid ?? state.bid;
    state.ask = ticker.ask ?? state.ask;
    state.baseVolume = ticker.baseVolume ?? state.baseVolume;
    state.quoteVolume = ticker.quoteVolume ?? state.quoteVolume;
    state.lastEventTime = Number.isNaN(ticker.eventTime) ? state.lastEventTime : ticker.eventTime;
    state.lastReceivedAt = at;
    for (const l of this.eventListeners) l(ticker.symbol, this.snapshotFor(ticker.symbol, at));
  }

  private malformedFor(symbol: UnderlyingSymbol | undefined): void {
    if (symbol === undefined) {
      this.unattributableMalformed += 1;
      return;
    }
    const state = this.states.get(symbol);
    if (state !== undefined) state.malformedDropped += 1;
  }

  private snapshotFor(symbol: UnderlyingSymbol, at: Millis): UnderlyingMarketSnapshot {
    const state = this.states.get(symbol);
    if (state === undefined) {
      throw new Error(`no state for symbol ${symbol}`);
    }
    const newest = state.lastReceivedAt ?? at;
    const age = Math.max(0, at - newest);
    const spread =
      state.bid !== undefined && state.ask !== undefined
        ? computeSpread(state.bid, state.ask)
        : undefined;
    return {
      symbol,
      lastPrice: state.lastPrice,
      bid: state.bid,
      ask: state.ask,
      spread,
      baseVolume: state.baseVolume,
      quoteVolume: state.quoteVolume,
      timestamp: millis(state.lastEventTime ?? newest),
      receivedAt: newest,
      stale: age > this.maxDataAgeMs,
      ageMs: age,
    };
  }

  // ------------------------------------------------------------------ public API

  snapshot(symbol: UnderlyingSymbol): UnderlyingMarketSnapshot | undefined {
    const state = this.states.get(symbol);
    // No snapshot until the first event arrives (interface contract).
    if (state === undefined || state.lastReceivedAt === undefined) return undefined;
    return this.snapshotFor(symbol, this.clock());
  }

  lastEventAt(symbol: UnderlyingSymbol): Millis | undefined {
    const state = this.states.get(symbol);
    if (state === undefined || state.lastEventTime === undefined) return undefined;
    return millis(state.lastEventTime);
  }

  freshnessMs(symbol: UnderlyingSymbol, now: Millis): number {
    const state = this.states.get(symbol);
    if (state === undefined || state.lastReceivedAt === undefined) return Number.POSITIVE_INFINITY;
    return Math.max(0, now - state.lastReceivedAt);
  }

  status(): ConnectionStatus {
    return this.connectionState;
  }

  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onStatusChange(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Test/diagnostics hook: per-symbol drop counters. */
  counters(symbol: UnderlyingSymbol): { outOfOrderDropped: number; malformedDropped: number } {
    const state = this.states.get(symbol);
    return {
      outOfOrderDropped: state?.outOfOrderDropped ?? 0,
      malformedDropped: state?.malformedDropped ?? 0,
    };
  }

  /** Malformed payloads that could not be attributed to a tracked symbol. */
  unattributableMalformedCount(): number {
    return this.unattributableMalformed;
  }
}

/** ask - bid, keeping at most 8 decimal places via string arithmetic on floats-free paths. */
function computeSpread(bid: string, ask: string): string {
  const b = Number(bid);
  const a = Number(ask);
  if (!Number.isFinite(b) || !Number.isFinite(a) || a < b) return "0";
  // Ticker fields carry exchange precision; a display-grade difference is fine here.
  return (a - b).toFixed(8).replace(/0+$/, "").replace(/\.$/, "") || "0";
}
