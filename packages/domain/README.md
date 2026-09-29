# @bot/domain

Pure, framework-free domain models for the trading bot: assets, markets,
phases, orders, fills, positions, inventory, complete sets, signals, risk
decisions, trading decisions, PnL, and balances.

Design rules (see `ARCHITECTURE.md` at the repo root):

- No Polymarket SDK/API types — adapters translate external DTOs into these models.
- Financial values use `Decimal` (BigInt-scaled, 8 dp) — never `number` floats.
- Timestamps are `Millis` (UTC epoch ms) or `UtcIso` (`Z`-suffixed ISO-8601).
- Behavior is exposed as pure functions; models are immutable data.
- No I/O: no network calls, no order submission, no live trading.
