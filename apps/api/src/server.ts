import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface ServerDeps {
  port: number;
  /** Trading mode reported by /health — paper unless the loader allowed live. */
  tradingMode: "paper" | "live";
  /** Live trading flag reported by /health (defensive transparency). */
  liveTradingEnabled: boolean;
  /** Live readiness probe for /ready (flipped by the entrypoint once warm). */
  isReady(): boolean;
}

export interface HealthStatus {
  status: "ok";
  service: string;
  /** Trading mode the process is configured for. */
  tradingMode: "paper" | "live";
  /** Defensive transparency: live trading must always be false today. */
  liveTradingEnabled: boolean;
  env: string;
}

export interface ReadyStatus {
  ready: boolean;
  service: string;
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function healthStatus(deps: ServerDeps): HealthStatus {
  return {
    status: "ok",
    service: "api",
    tradingMode: deps.tradingMode,
    liveTradingEnabled: deps.liveTradingEnabled,
    env: `port:${deps.port}`,
  };
}

export function requestHandler(deps: ServerDeps) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const url = (req.url ?? "/").split("?")[0] ?? "/";
    if (url === "/health") {
      sendJson(res, 200, healthStatus(deps));
      return;
    }
    if (url === "/ready") {
      const ready = deps.isReady();
      sendJson(res, ready ? 200 : 503, {
        ready,
        service: "api",
      } satisfies ReadyStatus);
      return;
    }
    // Security: do not echo the raw request URL back — it is attacker-
    // controlled input and would be reflected into responses (and any
    // downstream logs) verbatim. A static 404 body leaks nothing.
    sendJson(res, 404, { error: "not_found" });
  };
}

/** Create (but do not start) the API server. */
export function createApiServer(deps: ServerDeps): Server {
  return createServer(requestHandler(deps));
}

/** Start listening and resolve once the socket is bound. */
export function startApiServer(deps: ServerDeps): Promise<Server> {
  const server = createApiServer(deps);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(deps.port, () => resolve(server));
  });
}

/**
 * Graceful shutdown: stop accepting new connections, wait for in-flight
 * requests to drain (bounded), then close. Resolves when the server is
 * fully closed or the grace period elapses (destroying lingering sockets).
 */
export function stopApiServer(server: Server, gracePeriodMs = 10_000): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    const timer = setTimeout(() => {
      server.closeAllConnections();
      finish();
    }, gracePeriodMs);
    server.close((err) => {
      clearTimeout(timer);
      if (err !== undefined) {
        // "Server is not running" and similar: nothing to drain.
        server.closeAllConnections();
      }
      finish();
    });
  });
}
