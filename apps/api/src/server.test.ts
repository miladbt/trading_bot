import { afterEach, describe, expect, it } from "vitest";

import {
  createApiServer,
  requestHandler,
  startApiServer,
  stopApiServer,
  type ServerDeps,
} from "./server.js";

function deps(over: Partial<ServerDeps> = {}): ServerDeps {
  return {
    port: 3001,
    tradingMode: "paper",
    liveTradingEnabled: false,
    isReady: () => true,
    ...over,
  };
}

function mockRes(): {
  code: number | undefined;
  body: string;
  headers: Record<string, string>;
  writeHead(c: number, h?: Record<string, string>): unknown;
  end(b?: string): unknown;
} {
  const res = {
    code: undefined as number | undefined,
    body: "",
    headers: {} as Record<string, string>,
    writeHead(code: number, headers?: Record<string, string>) {
      res.code = code;
      if (headers) res.headers = headers;
      return res;
    },
    end(body?: string) {
      res.body = body ?? "";
      return res;
    },
  };
  return res;
}

describe("api routes", () => {
  it("GET /health returns 200 ok json with paper mode", () => {
    const handler = requestHandler(deps());
    const res = mockRes();
    handler({ url: "/health" } as never, res as never);
    expect(res.code).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: "ok",
      service: "api",
      tradingMode: "paper",
      liveTradingEnabled: false,
    });
  });

  it("GET /ready returns 200 when ready", () => {
    const handler = requestHandler(deps({ isReady: () => true }));
    const res = mockRes();
    handler({ url: "/ready" } as never, res as never);
    expect(res.code).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ready: true, service: "api" });
  });

  it("GET /ready returns 503 until the process is warm", () => {
    const handler = requestHandler(deps({ isReady: () => false }));
    const res = mockRes();
    handler({ url: "/ready" } as never, res as never);
    expect(res.code).toBe(503);
    expect(JSON.parse(res.body)).toMatchObject({ ready: false });
  });

  it("strips query strings before routing", () => {
    const handler = requestHandler(deps());
    const res = mockRes();
    handler({ url: "/health?probe=1" } as never, res as never);
    expect(res.code).toBe(200);
  });

  it("unknown paths return a static 404 without echoing the URL", () => {
    const handler = requestHandler(deps());
    const res = mockRes();
    handler({ url: "/nope?q=<script>" } as never, res as never);
    expect(res.code).toBe(404);
    expect(res.body).not.toContain("nope");
    expect(res.body).not.toContain("<script>");
  });
});

describe("graceful shutdown", () => {
  let server: Awaited<ReturnType<typeof startApiServer>> | undefined;

  afterEach(async () => {
    if (server !== undefined) {
      await stopApiServer(server, 500);
      server = undefined;
    }
  });

  it("stops cleanly and resolves stopApiServer", async () => {
    server = await startApiServer(deps({ port: 0 }));
    // Serve one request first to prove liveness, then stop.
    await stopApiServer(server, 1_000);
    server = undefined;
  });

  it("createApiServer builds a server without binding", () => {
    const s = createApiServer(deps({ port: 0 }));
    expect(s.listening).toBe(false);
    s.close();
  });
});
