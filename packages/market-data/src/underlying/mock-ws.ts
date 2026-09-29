/**
 * Deterministic mock WebSocket for tests: a scripted event pump with manual
 * control over open/message/close/error timing.
 */

import type { CloseEventLike, WebSocketFactory, WebSocketLike } from "./binance.js";

export const WS_CONNECTING = 0;
export const WS_OPEN = 1;
export const WS_CLOSING = 2;
export const WS_CLOSED = 3;

/** Build a CloseEventLike omitting absent fields (exactOptionalPropertyTypes). */
function closeEvent(code?: number, reason?: string): CloseEventLike {
  const ev: { code?: number; reason?: string } = {};
  if (code !== undefined) ev.code = code;
  if (reason !== undefined) ev.reason = reason;
  return ev;
}

export class MockWebSocket implements WebSocketLike {
  readyState: number = WS_CONNECTING;
  onopen: (() => void) | null = null;
  onclose: ((event: CloseEventLike) => void) | null = null;
  onerror: ((event: { message?: string }) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  readonly sent: string[] = [];
  closedWith: CloseEventLike | undefined;

  constructor(readonly url: string) {}

  // -- client-side (provider) actions --------------------------------------

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === WS_CLOSED || this.readyState === WS_CLOSING) return;
    this.readyState = WS_CLOSING;
    const event = closeEvent(code, reason);
    this.closedWith = event;
    // Closing is asynchronous on real sockets; tests can poll readyState.
    queueMicrotask(() => {
      this.readyState = WS_CLOSED;
      this.onclose?.(event);
    });
  }

  // -- test-side (venue) actions -------------------------------------------

  /** Simulate the connection succeeding. */
  serverAccept(): void {
    if (this.readyState !== WS_CONNECTING) throw new Error("socket already opened");
    this.readyState = WS_OPEN;
    this.onopen?.();
  }

  /** Deliver a raw payload from the venue. */
  serverMessage(data: unknown): void {
    if (this.readyState !== WS_OPEN) throw new Error("socket not open");
    this.onmessage?.({ data });
  }

  /** Simulate the venue dropping the connection. */
  serverClose(code = 1006, reason = "abnormal"): void {
    if (this.readyState === WS_CLOSED) return;
    this.readyState = WS_CLOSED;
    this.onclose?.(closeEvent(code, reason));
  }

  /** Simulate a socket-level error (connection may still close afterwards). */
  serverError(message = "boom"): void {
    this.onerror?.({ message });
  }
}

/** WebSocketFactory bound to MockWebSocket; records created sockets. */
export class MockSocketFactory {
  readonly sockets: MockWebSocket[] = [];

  readonly factory: WebSocketFactory = (url: string) => {
    const ws = new MockWebSocket(url);
    this.sockets.push(ws);
    return ws;
  };

  get last(): MockWebSocket | undefined {
    return this.sockets[this.sockets.length - 1];
  }
}
