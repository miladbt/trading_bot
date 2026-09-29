/**
 * HTTP transport for public Gamma API access.
 *
 * - `fetch` is injectable: unit tests pass a stub, production uses globalThis.
 * - No credentials are ever attached: discovery uses only public endpoints.
 * - Timeouts and HTTP errors map to typed `TransportError`s; body text is
 *   truncated in errors so payloads never flood logs.
 */

export class TransportError extends Error {
  constructor(
    message: string,
    public readonly kind: "timeout" | "http" | "network",
    public readonly status: number | undefined,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

export interface TransportOptions {
  readonly host: string;
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof fetch | undefined;
}

function truncate(text: string, max = 300): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export class HttpTransport {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: TransportOptions) {
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
  }

  /** GET a JSON resource. Throws TransportError on timeout/HTTP/network failure. */
  async getJson(path: string): Promise<unknown> {
    const url = `${this.options.host.replace(/\/$/, "")}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new TransportError(
          `GET ${path} failed: HTTP ${res.status} ${truncate(res.statusText, 80)}`,
          "http",
          res.status,
        );
      }
      return await res.json();
    } catch (e: unknown) {
      if (e instanceof TransportError) throw e;
      if (e instanceof Error && e.name === "AbortError") {
        throw new TransportError(
          `GET ${path} timed out after ${this.options.timeoutMs}ms`,
          "timeout",
          undefined,
        );
      }
      throw new TransportError(
        `GET ${path} network error: ${e instanceof Error ? e.message : String(e)}`,
        "network",
        undefined,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Minimal page shape shared by Gamma list endpoints. */
export interface GammaPage {
  readonly items: readonly unknown[];
  readonly nextCursor: string | undefined;
}
