// @bot/calibration — probability calibration (T2).
// Pure fitters + versioned serialization + metrics. No I/O, no clocks, no orders.

export {
  CALIBRATION_SCHEMA_VERSION,
  brierScore,
  deserializeCalibration,
  evaluateCalibration,
  fitBinnedCalibration,
  fitIsotonicCalibration,
  logLoss,
  reliabilityTable,
  serializeCalibration,
  CalibrationFormatError,
  type CalibrationModel,
  type CalibrationSample,
  type CalibrationStep,
  type ReliabilityBin,
} from "./calibration.js";
