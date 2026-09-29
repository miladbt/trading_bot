# @bot/trader

Long-running trading process: market-data → strategy → risk → execution loop.

**Stub.** The loop, Polymarket connectivity, and all trading logic are
intentionally not implemented yet (see `AGENTS.md`). The entrypoint wires
config + logging and exits cleanly; `pnpm dev:trader` runs it.
