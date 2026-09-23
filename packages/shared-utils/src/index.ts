export { normalise } from './number-normaliser';
export {
  canonicaliseCircuitDesignation,
  designationCanonicalisesToEmpty,
  repairCircuitDesignation,
} from './designation-canonicaliser';
export { generateKeywordBoosts } from './keyword-boost-generator';
export { cn } from './cn';
export { buildLocalJob } from './build-local-job';
export type { LocalJobInput, LocalJobRecord } from './build-local-job';
export { downloadBlob } from './download-blob';
export {
  applyZsCalculation,
  applyR1R2Calculation,
  calculateZsFromR1R2,
  calculateR1R2FromZs,
  formatImpedance,
} from './impedance';
export type { CalcResult, CalcSkipReason, BulkCalcOutcome } from './impedance';
export { applyDefaultsToCircuit, applyDefaultsToCircuits } from './apply-defaults';
export type {
  ApplyDefaultsOptions,
  ApplyDefaultsSummary,
  ApplyDefaultsBulkResult,
} from './apply-defaults';
export { DEFAULTS_BY_CIRCUIT, GLOBAL_DEFAULTS, inferCircuitType } from './circuit-defaults-schema';
export type { CircuitTypeKey } from './circuit-defaults-schema';
export {
  parseVoiceCommand,
  parseCalculateCommand,
  parseScopeTextWithRemainder,
  clientCommandForCalculate,
  applyVoiceCommand,
  voiceCommandTargetsDesignation,
  voiceCommandTargetsOcpdStandard,
  DEVICE_ATTRIBUTE_FIELDS,
  NO_ZE_RESPONSE,
} from './voice-commands';
export type {
  VoiceCommand,
  VoiceCommandOutcome,
  VoiceCommandJob,
  VoiceCommandCircuit,
  VoiceCommandScope,
  ClientCommandMarker,
  CalculateSkipReason,
} from './voice-commands';
export {
  GUARDED_CLOSED_ENUM_FIELDS,
  CLOSED_ENUM_OPTIONS,
  CLOSED_ENUM_LABELS,
  WIRING_TYPE_DESCRIPTION_TO_CODE,
  isGuardedClosedEnumField,
  isValueCheckedCircuitField,
  canonicaliseClosedEnumValue,
  cleanClosedEnumResidue,
  parseClosedEnumBsCode,
  parseClosedEnumRefMethod,
  renderClosedEnumReask,
  reaskForClosedEnumOutcome,
} from './closed-enum-guard';
export type {
  GuardedClosedEnumField,
  ClosedEnumReaskField,
  ClosedEnumOutcome,
  ClosedEnumReaskReason,
  ClosedEnumSparePolicy,
  GuardedTarget,
} from './closed-enum-guard';
export { matchCircuits, similarityScore, normaliseLabel } from './circuit-matcher';
export type { CircuitMatch, MatcherNewCircuit, MatcherExistingCircuit } from './circuit-matcher';
export {
  maxZsLookup,
  maxZsString,
  maxZsForOcpdTuple,
  maxZsForOcpdTupleNumber,
  recomputeMaxZsForOcpdTuple,
  writeMaxZs,
  clearMaxZs,
  readMaxZsSource,
  ocpdMaxZsStatus,
  ocpdMaxZsWarningText,
  ocpdStandardStatus,
  ocpdStandardWarningText,
  ocpdRowWarnings,
  applyOcpdAwarePatch,
} from './max-zs-lookup';
export type {
  MaxZsLookupArgs,
  OcpdTupleLookupArgs,
  MaxZsSource,
  MaxZsRow,
  MaxZsChange,
  MaxZsChangeLogger,
  OcpdMaxZsStatus,
} from './max-zs-lookup';
export {
  canonicaliseOcpdStandard,
  canonicaliseOcpdStandardForImport,
  isCanonicalOcpdStandard,
  OCPD_STANDARD_INPUT_CAP,
  OCPD_STANDARD_MAX_GRAMMAR_OUTPUT,
} from './ocpd-standard';
export {
  recompute,
  recomputeAll,
  resolveZe,
  resolveJobZe,
  jobBoardCount,
  soleJobBoard,
  clampImpedance,
  DERIVATION_SENTINELS,
} from './circuit-derivations';
export type {
  DerivationOutcome,
  ImpedanceField,
  ClampOutcome,
  JobZeResolution,
  JobZeSource,
  JobZeLike,
} from './circuit-derivations';
