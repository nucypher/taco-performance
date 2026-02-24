import type { Address } from "viem";

// =============================================================================
// Configuration
// =============================================================================

export interface Payload {
  name?: string;
  // Discord payload fields (for cohorts with Discord conditions)
  timestamp?: string;
  signature?: string;
  recipientUserId?: string;
  body?: Record<string, unknown>;
  bodyJson?: string;
  // Bare payload fields (for cohorts with simple conditions like blocktime > 0)
  senderAddress?: string;
  recipientAddress?: string;
  token?: string;
  amount?: string;
}

export interface ConfigDefaults {
  mode?: "steady" | "burst" | "sweep";
  duration?: number;
  rates?: number[];
  rate?: number;
  requests?: number;
  burstSizes?: number[];
  batchesPerBurst?: number;
  cooldown?: number;
  timeout?: number;
  maxDuration?: number;
  maxConsecutiveFailures?: number;
}

export interface Config {
  defaults?: ConfigDefaults;
  payloads: Payload[];
}

export interface CLIOptions {
  config: string;
  mode?: "steady" | "burst" | "sweep";
  rate?: number;
  duration?: number;
  requests?: number;
  rates?: number[];
  output?: string;
  fromData?: string;
  regenerate?: boolean;
  exportRequest?: boolean;
  payload?: string;
  maxDuration?: number;
  maxConsecutiveFailures?: number;
  verbose?: boolean;
  json?: boolean;
  // Network configuration
  domain?: string;
  cohortId?: number;
  chainId?: number;
}

// =============================================================================
// Execution
// =============================================================================

export interface PreparedPayload {
  payload: Payload;
  smartAccount: any;
  recipientAA: Address;
  calls: Array<{ to: Address; value: bigint; data?: `0x${string}` }>;
  userOp: Record<string, unknown>;
  discordContext?: {
    timestamp: string;
    signature: string;
    payload: string;
  };
  signingContext?: any;
}

export interface RequestResult {
  index: number;
  startTime: number;
  endTime: number;
  duration: number;
  success: boolean;
  error?: string;
  tacoSigningTimeMs?: number;
}

// =============================================================================
// Statistics & Results
// =============================================================================

export interface Stats {
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  stdDev: number;
}

export interface NodeFailure {
  address: string;
  timeouts: number;
  otherErrors: number;
}

export interface ErrorWithCount {
  message: string;
  count: number;
}

export interface TimelineRequest {
  index: number;
  timestamp: number;
  elapsedSec: number;
  duration: number;
  tacoSigningTimeMs: number | null;
  success: boolean;
  error?: string;
  inFlight: number;
}

export type StopReason = "duration" | "consecutive-failures" | "completed";

export interface RunResult {
  mode: "steady" | "burst";
  targetRate: number;
  duration: number;
  label?: string;
  requests: {
    total: number;
    success: number;
    failed: number;
  };
  latency: Stats;
  successLatency: Stats | null;
  failureLatency: Stats | null;
  tacoSigningTime: Stats | null;
  successTacoSigningTime: Stats | null;
  failureTacoSigningTime: Stats | null;
  nodeFailures: NodeFailure[];
  errors: ErrorWithCount[];
  timeline?: TimelineRequest[];
  stopReason?: StopReason;
  consecutiveFailuresAtStop?: number;
  stoppedEarly?: boolean;
}

export interface TestData {
  version: 1;
  timestamp: string;
  config: {
    mode: string;
    rate: number;
    duration: number;
    rates: number[];
    burstSizes: number[];
    batchesPerBurst: number;
    domain?: string;
    cohortId?: number;
    chainId?: number;
    maxDuration?: number;
    maxConsecutiveFailures?: number;
  };
  steadyResults: RunResult[];
  burstResults: RunResult[];
}

export interface SteadyModeOptions {
  rate: number;
  duration?: number;
  requestCount?: number;
  maxDuration?: number;
  maxConsecutiveFailures?: number;
}

export interface SteadyModeResult {
  results: RequestResult[];
  timeline: TimelineRequest[];
  stopReason: StopReason;
  consecutiveFailuresAtStop?: number;
}

// =============================================================================
// JSON Summary (for CI output)
// =============================================================================

export interface JsonSummary {
  timestamp: string;
  domain: string;
  cohortId: number;
  chainId: number;
  results: Array<{
    label: string;
    mode: string;
    targetRate: number;
    total: number;
    success: number;
    failed: number;
    successRate: number;
    p50: number;
    p95: number;
  }>;
}
