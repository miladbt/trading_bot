# @bot/risk

The authoritative RiskEngine. **Every future live order passes through
`evaluateRiskOrder` before anything may act on it.**

## Design

- **Pure and deterministic.** `evaluateRiskOrder(request, limits)` performs no
  network calls, reads no clock, consults no model. Every observation (health,
  data ages, losses, exposure) arrives as data in the request; identical
  inputs always produce the identical verdict.
- **Fail closed.** Health inputs are tri-state (`"healthy" | "degraded" |
  "unhealthy"` with `undefined` = unknown). Unknown or unhealthy means **no
  new orders**. Malformed request data throws `ValidationError` rather than
  guessing.
- **Decision only.** The engine returns a `RiskEvaluation`
  (`allowed` / `reason` / `halted` / `limits` / `exposure`). It never submits,
  amends, or cancels orders.

## Canonical check order (first failure wins)

1. market expiration *(halts)*
2. account reconciliation — unknown counts as not reconciled *(halts)*
3. API health — unknown counts as unhealthy *(halts)*
4. WebSocket health — unknown counts as unhealthy *(halts)*
5. stale market data *(halts)*
6. stale underlying data *(halts)*
7. maximum daily loss *(halts)*
8. maximum market loss *(halts)*
9. maximum total capital
10. maximum market capital
11. maximum order size
12. maximum open orders (the new order occupies one slot)
13. maximum directional exposure (signed: breaches in either direction reject)
14. maximum residual inventory
15. maximum orphan inventory

Environmental failures set `halted: true` (the whole engine should pause);
single-order limit breaches reject just that order.

`riskLimitsFromConfig` maps the validated `AppConfig` (risk + strategy groups)
onto the engine's `RiskLimits`, so environment config is the single source of
truth for the numbers.

```ts
import { evaluateRiskOrder, riskLimitsFromConfig } from "@bot/risk";

const evaluation = evaluateRiskOrder(request, riskLimitsFromConfig(config));
if (!evaluation.allowed) {
  // evaluation.reason is stable and machine-parseable, e.g. "max_daily_loss"
}
```

This package never submits orders.
