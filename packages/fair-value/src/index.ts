// @bot/fair-value — Strategy V2 probability + mispricing + gate (paper only).
// Pure functions only: no orders, no execution, no network, no clocks.

export {
  DEFAULT_BUFFERS,
  DEFAULT_FAIR_VALUE_CONFIG,
  DEFAULT_GATE_CONFIG,
  MIN_GATE_SAMPLES,
  dormant,
  evaluateGate,
  fairValueEstimate,
  mispricing,
  totalBuffer,
  type BufferConfig,
  type BufferInput,
  type Dormant,
  type FairValueConfig,
  type FairValueEstimate,
  type FairValueInput,
  type GateConfig,
  type GateEvaluation,
  type GateObservation,
  type GateVerdict,
  type MarketEvidence,
  type MispricingInput,
  type MispricingResult,
  type UnderlyingEvidence,
} from "./fair-value.js";

export {
  anchorDistFrac,
  momentumPerMin,
  volAccelPerMin2,
  type Obs,
  type Series,
} from "./evidence.js";
