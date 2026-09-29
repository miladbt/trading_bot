/**
 * Transport seam for Polymarket CLOB calls.
 *
 * The adapter depends on this small interface, never on HTTP directly —
 * integration tests inject `MockClobTransport`; a real implementation would
 * wrap fetch with credentials and lives behind the same seam. All calls are
 * timeout-bounded: the transport reports `timeout` as a failure reason rather
 * than hanging.
 */

import type { Result } from "@bot/domain";

import type { RawCancelResponse, RawFillDto, RawOrderDto, RawOrderPostResponse } from "./dto.js";

export type ClobFailureReason =
  "timeout" | "network" | "rate_limited" | "auth_failed" | "server_error" | "bad_response";

export type ClobResult<T> = Result<T, ClobFailureReason>;

export interface ClobTransport {
  /** POST an order; venue responds with an acceptance/ack payload. */
  postOrder(body: string, timeoutMs: number): Promise<ClobResult<RawOrderPostResponse>>;
  /** DELETE (cancel) an order by venue id. */
  cancelOrder(venueOrderId: string, timeoutMs: number): Promise<ClobResult<RawCancelResponse>>;
  /** GET one order by venue id. */
  getOrder(venueOrderId: string, timeoutMs: number): Promise<ClobResult<RawOrderDto>>;
  /** GET all open orders. */
  getOpenOrders(timeoutMs: number): Promise<ClobResult<readonly RawOrderDto[]>>;
  /** GET recent trades (fills). */
  getTrades(timeoutMs: number): Promise<ClobResult<readonly RawFillDto[]>>;
}

/**
 * Mock transport for integration tests: scripted, deterministic responses per
 * call, with optional latency simulation handled by the test (the adapter's
 * timeout logic operates on the transport's promise result, so tests script
 * `timeout` results directly).
 */
export class MockClobTransport implements ClobTransport {
  readonly postOrderCalls: string[] = [];
  readonly cancelCalls: string[] = [];
  readonly getOrderCalls: string[] = [];
  openOrdersCalls = 0;
  tradesCalls = 0;

  postOrderResults: ClobResult<RawOrderPostResponse>[] = [];
  cancelResults: ClobResult<RawCancelResponse>[] = [];
  getOrderResults: ClobResult<RawOrderDto>[] = [];
  openOrdersResults: ClobResult<readonly RawOrderDto[]>[] = [];
  tradesResults: ClobResult<readonly RawFillDto[]>[] = [];

  postOrder(body: string): Promise<ClobResult<RawOrderPostResponse>> {
    this.postOrderCalls.push(body);
    const r = this.postOrderResults.shift();
    return Promise.resolve(r ?? { ok: false, error: "bad_response" });
  }

  cancelOrder(venueOrderId: string): Promise<ClobResult<RawCancelResponse>> {
    this.cancelCalls.push(venueOrderId);
    const r = this.cancelResults.shift();
    return Promise.resolve(r ?? { ok: false, error: "bad_response" });
  }

  getOrder(venueOrderId: string): Promise<ClobResult<RawOrderDto>> {
    this.getOrderCalls.push(venueOrderId);
    const r = this.getOrderResults.shift();
    return Promise.resolve(r ?? { ok: false, error: "bad_response" });
  }

  getOpenOrders(): Promise<ClobResult<readonly RawOrderDto[]>> {
    this.openOrdersCalls += 1;
    const r = this.openOrdersResults.shift();
    return Promise.resolve(r ?? { ok: false, error: "bad_response" });
  }

  getTrades(): Promise<ClobResult<readonly RawFillDto[]>> {
    this.tradesCalls += 1;
    const r = this.tradesResults.shift();
    return Promise.resolve(r ?? { ok: false, error: "bad_response" });
  }
}
