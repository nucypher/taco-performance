#!/usr/bin/env node

/**
 * TACo Performance Test Runner
 *
 * Usage:
 *   npx tsx src/runner.ts --config=configs/daily.yml
 *   npx tsx src/runner.ts --config=configs/daily.yml --json
 */

import { initialize } from "@nucypher/taco";
import * as dotenv from "dotenv";
import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { parseArgs as nodeParseArgs } from "node:util";
import YAML from "yaml";
import { createPublicClient, encodeFunctionData, http, Address } from "viem";
import {
  createBundlerClient,
  createPaymasterClient,
} from "viem/account-abstraction";
import { baseSepolia, base } from "viem/chains";

import { SigningCoordinatorAgent } from "@nucypher/shared";
import {
  conditions,
  domains,
  Domain,
  signUserOp,
  UserOperationToSign,
} from "@nucypher/taco";
import {
  Implementation,
  toMetaMaskSmartAccount,
} from "@metamask/delegation-toolkit";

import type {
  Payload, PreparedPayload, Config, CLIOptions, RequestResult,
  Stats, NodeFailure, ErrorWithCount, TimelineRequest, StopReason,
  RunResult, TestData, SteadyModeOptions, SteadyModeResult, JsonSummary,
} from "./types";

dotenv.config();

const TOKEN_ADDRESSES: Record<string, Address> = {
  USDC: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

const ERC20_TRANSFER_ABI = [
  {
    name: "transfer",
    type: "function",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

const SIGNING_COORDINATOR_CHILD_ADDRESS =
  "0xcc537b292d142dABe2424277596d8FFCC3e6A12D";

const CHAINS: Record<number, any> = {
  84532: baseSepolia,
  8453: base,
};

// Global State
let signingCoordinatorProvider: ethers.providers.JsonRpcProvider;
let signingChainProvider: ethers.providers.JsonRpcProvider;
let publicClient: any;
let bundlerClient: any;
let initialized = false;
let VERBOSE = false;
let REQUEST_TIMEOUT_SECONDS = 120;
let TACO_DOMAIN: Domain = domains.DEVNET;
let COHORT_ID = 3;
let CHAIN_ID = 84532;
let AA_VERSION = "mdt";

// =============================================================================
// ANSI Terminal Display
// =============================================================================

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  clearLine: "\x1b[2K",
  cursorUp: (n: number) => `\x1b[${n}A`,
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
};

const isTTY = process.stdout.isTTY === true;

class ProgressDisplay {
  private lineCount = 10;
  private rendered = false;
  private lastRenderTime = 0;
  private minRenderInterval = 100;
  private mode: "steady" | "burst";
  private targetRate: number;
  private totalRequests: number | undefined;
  private testStartTime: number;
  private successCount = 0;
  private failCount = 0;
  private inFlight = 0;
  private consecutiveFailures = 0;
  private lastDuration = 0;
  private latencies: number[] = [];
  private lastSuccess = true;

  constructor(mode: "steady" | "burst", targetRate: number, totalRequests: number | undefined, testStartTime: number) {
    this.mode = mode;
    this.targetRate = targetRate;
    this.totalRequests = totalRequests;
    this.testStartTime = testStartTime;
    process.stdout.write(ANSI.hideCursor);
  }

  update(result: RequestResult, inFlight: number, consecutiveFailures: number) {
    if (result.success) { this.successCount++; this.latencies.push(result.duration); }
    else { this.failCount++; }
    this.inFlight = inFlight;
    this.consecutiveFailures = consecutiveFailures;
    this.lastDuration = result.duration;
    this.lastSuccess = result.success;
    this.throttledRender();
  }

  updateBatch(batchNum: number, totalBatches: number, batchResults: RequestResult[]) {
    for (const r of batchResults) {
      if (r.success) { this.successCount++; this.latencies.push(r.duration); }
      else { this.failCount++; }
    }
    this.inFlight = 0;
    this.lastDuration = batchResults.reduce((a, r) => a + r.duration, 0) / batchResults.length;
    this.lastSuccess = batchResults.some((r) => r.success);
    this.render();
  }

  private throttledRender() {
    const now = Date.now();
    if (now - this.lastRenderTime < this.minRenderInterval) return;
    this.lastRenderTime = now;
    this.render();
  }

  private render() {
    const elapsed = (Date.now() - this.testStartTime) / 1000;
    const completed = this.successCount + this.failCount;
    const total = this.totalRequests;
    const successPct = completed > 0 ? ((this.successCount / completed) * 100).toFixed(1) : "0.0";
    const actualRate = completed > 0 ? (completed / elapsed).toFixed(2) : "0.00";
    const barWidth = 20;
    const progress = total ? Math.min(completed / total, 1) : 0;
    const filled = Math.round(progress * barWidth);
    const bar = total ? `${ANSI.green}${"█".repeat(filled)}${ANSI.dim}${"░".repeat(barWidth - filled)}${ANSI.reset}` : "";
    const progressPct = total ? ` ${((completed / total) * 100).toFixed(0)}%` : "";
    let p50Str = "—";
    let p95Str = "—";
    if (this.latencies.length > 0) {
      const sorted = [...this.latencies].sort((a, b) => a - b);
      p50Str = (sorted[Math.floor(sorted.length * 0.5)] / 1000).toFixed(2) + "s";
      p95Str = (sorted[Math.floor(sorted.length * 0.95)] / 1000).toFixed(2) + "s";
    }
    const lastStr = this.lastSuccess
      ? `${ANSI.green}${(this.lastDuration / 1000).toFixed(2)}s${ANSI.reset}`
      : `${ANSI.red}${(this.lastDuration / 1000).toFixed(2)}s${ANSI.reset}`;
    const modeLabel = this.mode === "burst" ? `burst × ${this.targetRate}` : `steady @ ${this.targetRate} req/s`;
    const elapsedFmt = elapsed >= 60
      ? `${Math.floor(elapsed / 60)}m ${Math.floor(elapsed % 60).toString().padStart(2, "0")}s`
      : `${Math.floor(elapsed)}s`;
    const completedStr = total ? `${completed} / ${total}` : `${completed}`;
    const lines = [
      `${ANSI.bold}${ANSI.cyan} TACo Perf${ANSI.reset}  ${ANSI.dim}${modeLabel}${ANSI.reset}`,
      ``,
      `  ${ANSI.dim}Elapsed${ANSI.reset}   ${ANSI.white}${elapsedFmt.padEnd(14)}${ANSI.reset}${ANSI.dim}Completed${ANSI.reset}  ${ANSI.white}${completedStr}${ANSI.reset}`,
      `  ${ANSI.dim}In-flight${ANSI.reset} ${ANSI.yellow}${this.inFlight.toString().padEnd(14)}${ANSI.reset}${ANSI.dim}Rate${ANSI.reset}       ${ANSI.white}${actualRate} req/s${ANSI.reset}`,
      ``,
      `  ${ANSI.green}Success${ANSI.reset}   ${ANSI.green}${this.successCount.toString().padEnd(6)}${ANSI.reset}${ANSI.dim}(${successPct}%)${ANSI.reset}  ${bar}${progressPct}`,
      `  ${ANSI.red}Failed${ANSI.reset}    ${this.failCount > 0 ? ANSI.red : ANSI.dim}${this.failCount.toString().padEnd(6)}${ANSI.reset}${this.failCount > 0 ? `${ANSI.dim}(${(100 - parseFloat(successPct)).toFixed(1)}%)${ANSI.reset}` : ""}`,
      ``,
      `  ${ANSI.dim}Latency${ANSI.reset}   last ${lastStr}   ${ANSI.dim}p50${ANSI.reset} ${p50Str}   ${ANSI.dim}p95${ANSI.reset} ${p95Str}`,
      `  ${this.consecutiveFailures > 0 ? `${ANSI.red}Consec Fail  ${this.consecutiveFailures}${ANSI.reset}` : ""}`,
    ];
    if (this.rendered) process.stdout.write(ANSI.cursorUp(this.lineCount));
    for (const line of lines) process.stdout.write(ANSI.clearLine + line + "\n");
    this.rendered = true;
  }

  finish() { this.render(); process.stdout.write(ANSI.showCursor); }
}

process.on("SIGINT", () => {
  if (isTTY) process.stdout.write(ANSI.showCursor);
  process.exit(130);
});

// =============================================================================
// TACo Viem Account (inline)
// =============================================================================

function createViemTacoAccount(multisigAddress: Address) {
  return {
    address: multisigAddress,
    type: "local" as const,
    source: "taco-threshold-signer",
    async signMessage() { throw new Error("TACo account signs via signUserOp"); },
    async signTypedData() { throw new Error("TACo account signs via signUserOp"); },
    async signTransaction() { throw new Error("TACo account signs via signUserOp"); },
  };
}

// =============================================================================
// Client Initialization
// =============================================================================

async function initializeClients(): Promise<void> {
  if (initialized) return;
  if (VERBOSE) console.log("[taco-perf] Initializing...");
  await initialize();

  // Resolve RPC URLs based on domain using INFURA_API_KEY
  // Devnet (lynx): coordinator on Sepolia, signing chain on Base Sepolia
  // Mainnet: coordinator on Ethereum, signing chain on Base
  const infuraKey = process.env.INFURA_API_KEY;
  if (!infuraKey) throw new Error("INFURA_API_KEY is not set");

  const isMainnet = TACO_DOMAIN === domains.MAINNET;
  const coordinatorRpc = isMainnet
    ? "https://mainnet.infura.io/v3/" + infuraKey
    : "https://sepolia.infura.io/v3/" + infuraKey;
  const signingChainRpc = isMainnet
    ? "https://base-mainnet.infura.io/v3/" + infuraKey
    : "https://base-sepolia.infura.io/v3/" + infuraKey;

  const pimlicoKey = process.env.PIMLICO_API_KEY;
  const bundlerUrl = pimlicoKey
    ? "https://api.pimlico.io/v2/" + CHAIN_ID + "/rpc?apikey=" + pimlicoKey
    : undefined;

  if (VERBOSE) {
    console.log("[taco-perf] Coordinator RPC: " + coordinatorRpc.replace(/v3\/.*/, "v3/***"));
    console.log("[taco-perf] Signing chain RPC: " + signingChainRpc.replace(/v3\/.*/, "v3/***"));
    if (bundlerUrl) console.log("[taco-perf] Bundler: " + bundlerUrl.replace(/apikey=[^&]+/i, "apikey=***"));
  }

  const coordinatorNetwork = isMainnet ? { name: "mainnet", chainId: 1 } : { name: "sepolia", chainId: 11155111 };
  const signingChainNetwork = isMainnet ? { name: "base", chainId: 8453 } : { name: "base-sepolia", chainId: 84532 };
  signingCoordinatorProvider = new ethers.providers.JsonRpcProvider(coordinatorRpc, coordinatorNetwork);
  signingChainProvider = new ethers.providers.JsonRpcProvider(signingChainRpc, signingChainNetwork);
  const chain = CHAINS[CHAIN_ID] || baseSepolia;
  publicClient = createPublicClient({ chain, transport: http(signingChainRpc) });
  const paymasterClient = createPaymasterClient({ transport: http(bundlerUrl) });
  bundlerClient = createBundlerClient({ transport: http(bundlerUrl), paymaster: paymasterClient, chain });
  await prefetchSigningCondition();
  if (VERBOSE) console.log("[taco-perf] Initialized");
  initialized = true;
}

// =============================================================================
// TACo Helpers
// =============================================================================

async function createTacoSmartAccount(deploySalt: `0x${string}` = "0x") {
  const coordinator = new ethers.Contract(
    SIGNING_COORDINATOR_CHILD_ADDRESS,
    ["function cohortMultisigs(uint32) view returns (address)"],
    signingChainProvider,
  );
  const cohortMultisigAddress = await coordinator.cohortMultisigs(COHORT_ID);
  const participants = await SigningCoordinatorAgent.getParticipants(signingCoordinatorProvider, TACO_DOMAIN, COHORT_ID);
  const threshold = await SigningCoordinatorAgent.getThreshold(signingCoordinatorProvider, TACO_DOMAIN, COHORT_ID);
  const signers = participants.map((p) => p.signerAddress as Address);
  const tacoAccount = createViemTacoAccount(cohortMultisigAddress as Address);
  const smartAccount = await (toMetaMaskSmartAccount as any)({
    client: publicClient,
    implementation: Implementation.MultiSig,
    deployParams: [signers, BigInt(threshold)],
    deploySalt,
    signatory: [{ account: tacoAccount }],
  });
  return { smartAccount, threshold, signers, cohortMultisigAddress };
}

async function deriveDiscordUserAA(discordUserId: string): Promise<Address> {
  const salt = ethers.utils.keccak256(
    ethers.utils.toUtf8Bytes(`${discordUserId}|Discord|Collab.Land`),
  ) as `0x${string}`;
  const { smartAccount } = await createTacoSmartAccount(salt);
  return smartAccount.address;
}

let cachedCondition: InstanceType<typeof conditions.condition.Condition> | null = null;

async function prefetchSigningCondition(): Promise<void> {
  if (VERBOSE) console.log("[taco-perf] Pre-fetching signing condition...");
  const hex = await SigningCoordinatorAgent.getSigningCohortConditions(
    signingCoordinatorProvider, TACO_DOMAIN, COHORT_ID, CHAIN_ID,
  );
  const json = ethers.utils.toUtf8String(hex);
  const expr = conditions.conditionExpr.ConditionExpression.fromJSON(json);
  cachedCondition = expr.condition;
  if (VERBOSE) console.log("[taco-perf] Signing condition pre-fetched");
}

function buildSigningContext(discordContext: { timestamp: string; signature: string; payload: string }) {
  if (!cachedCondition) throw new Error("Signing condition not pre-fetched");
  const ctx = new conditions.context.ConditionContext(cachedCondition);
  ctx.addCustomContextParameterValues({
    ":timestamp": discordContext.timestamp,
    ":signature": discordContext.signature,
    ":discordPayload": discordContext.payload,
  });
  return ctx;
}

async function signUserOpWithTaco(
  userOp: Record<string, unknown>,
  provider: ethers.providers.JsonRpcProvider,
  signingContext?: InstanceType<typeof conditions.context.ConditionContext>,
) {
  return await signUserOp(provider, TACO_DOMAIN, COHORT_ID, CHAIN_ID, userOp as UserOperationToSign, AA_VERSION, signingContext);
}


// =============================================================================
// Payload Preparation
// =============================================================================

function isBarePayload(payload: Payload): boolean {
  return !!payload.senderAddress;
}

async function preparePayload(payload: Payload): Promise<PreparedPayload> {
  if (isBarePayload(payload)) {
    return prepareBarePayload(payload);
  }
  return prepareDiscordPayload(payload);
}

async function prepareBarePayload(payload: Payload): Promise<PreparedPayload> {
  const senderAddress = payload.senderAddress as Address;
  const recipientAddress = payload.recipientAddress as Address;
  const tokenType = String(payload.token ?? "ETH").toUpperCase();
  const amountStr = String(payload.amount ?? "0.0001");

  if (!recipientAddress) {
    throw new Error("Bare payload must have recipientAddress");
  }

  const senderSalt = ethers.utils.keccak256(
    ethers.utils.toUtf8Bytes(senderAddress),
  ) as `0x${string}`;

  const { smartAccount } = await createTacoSmartAccount(senderSalt);

  const tokenDecimals = tokenType === "USDC" ? 6 : 18;
  const transferAmount = ethers.utils.parseUnits(amountStr, tokenDecimals);
  const tokenAddress = TOKEN_ADDRESSES[tokenType];
  const calls: Array<{ to: Address; value: bigint; data?: `0x${string}` }> =
    tokenAddress
      ? [{
          to: tokenAddress,
          value: 0n,
          data: encodeFunctionData({
            abi: ERC20_TRANSFER_ABI,
            functionName: "transfer",
            args: [recipientAddress, BigInt(transferAmount.toString())],
          }),
        }]
      : [{ to: recipientAddress, value: BigInt(transferAmount.toString()) }];

  const userOp = await bundlerClient.prepareUserOperation({
    account: smartAccount,
    calls,
    maxFeePerGas: 3_000_000_000n,
    maxPriorityFeePerGas: 3_000_000_000n,
    verificationGasLimit: BigInt(500_000),
  });

  return { payload, smartAccount, recipientAA: recipientAddress, calls, userOp };
}

async function prepareDiscordPayload(payload: Payload): Promise<PreparedPayload> {
  const body = payload.bodyJson ? JSON.parse(payload.bodyJson) : payload.body;
  if (!body) throw new Error("Payload must have either body or bodyJson");

  const senderDiscordId = String(body?.member?.user?.id || "");
  if (!senderDiscordId) throw new Error("Missing member.user.id in payload body");

  const executeCmd = body?.data?.options?.find((o: any) => o?.name === "execute");
  const opts = executeCmd?.options || [];
  const amountOpt = opts.find((o: any) => o?.name === "amount")?.value;
  const tokenOpt = opts.find((o: any) => o?.name === "token")?.value;
  const tokenType = String(tokenOpt ?? "ETH").toUpperCase();

  const senderSalt = ethers.utils.keccak256(
    ethers.utils.toUtf8Bytes(`${senderDiscordId}|Discord|Collab.Land`),
  ) as `0x${string}`;

  const { smartAccount } = await createTacoSmartAccount(senderSalt);
  const recipientAA = await deriveDiscordUserAA(payload.recipientUserId!);

  const amountStr = String(amountOpt ?? "0.0001");
  const tokenDecimals = tokenType === "USDC" ? 6 : 18;
  const transferAmount = ethers.utils.parseUnits(amountStr, tokenDecimals);
  const tokenAddress = TOKEN_ADDRESSES[tokenType];
  const calls: Array<{ to: Address; value: bigint; data?: `0x${string}` }> =
    tokenAddress
      ? [{
          to: tokenAddress,
          value: 0n,
          data: encodeFunctionData({
            abi: ERC20_TRANSFER_ABI,
            functionName: "transfer",
            args: [recipientAA, BigInt(transferAmount.toString())],
          }),
        }]
      : [{ to: recipientAA, value: BigInt(transferAmount.toString()) }];

  const bodyString = payload.bodyJson || JSON.stringify(payload.body);
  const discordContext = {
    timestamp: payload.timestamp!,
    signature: payload.signature!.replace(/^0x/, ""),
    payload: bodyString,
  };

  const userOp = await bundlerClient.prepareUserOperation({
    account: smartAccount,
    calls,
    maxFeePerGas: 3_000_000_000n,
    maxPriorityFeePerGas: 3_000_000_000n,
    verificationGasLimit: BigInt(500_000),
  });

  const signingContext = buildSigningContext(discordContext);

  return { payload, smartAccount, recipientAA, calls, userOp, discordContext, signingContext };
}

async function prepareAllPayloads(payloads: Payload[]): Promise<PreparedPayload[]> {
  if (VERBOSE) console.log("[taco-perf] Preparing " + payloads.length + " payload(s)...");
  const prepared: PreparedPayload[] = [];
  for (let i = 0; i < payloads.length; i++) {
    if (VERBOSE) console.log("[taco-perf]   Preparing payload " + (i + 1) + "/" + payloads.length + "...");
    prepared.push(await preparePayload(payloads[i]));
  }
  if (VERBOSE) console.log("[taco-perf] All payloads prepared");
  return prepared;
}

// =============================================================================
// Request Executor
// =============================================================================

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string,
): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

async function executeSigningRequest(prepared: PreparedPayload): Promise<RequestResult> {
  const startTime = Date.now();
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const timeoutMs = REQUEST_TIMEOUT_SECONDS * 1000;
    return await withTimeout(
      executeSigningRequestInner(prepared, startTime),
      timeoutMs,
      "Request timed out after " + REQUEST_TIMEOUT_SECONDS + "s",
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      duration: Date.now() - startTime,
      startTime,
      endTime: Date.now(),
      error: "[timeout] " + errorMessage,
      index: 0,
    };
  } finally {
    console.error = originalConsoleError;
  }
}

async function executeSigningRequestInner(
  prepared: PreparedPayload,
  startTime: number,
): Promise<RequestResult> {
  let tacoSigningTimeMs: number | undefined;

  try {
    const signingContext = prepared.discordContext
      ? buildSigningContext(prepared.discordContext)
      : prepared.signingContext;
    const tacoStartTime = Date.now();
    await signUserOpWithTaco(prepared.userOp, signingCoordinatorProvider, signingContext);
    tacoSigningTimeMs = Date.now() - tacoStartTime;

    const endTime = Date.now();
    return {
      index: 0, startTime, endTime,
      duration: endTime - startTime,
      success: true,
      tacoSigningTimeMs,
    };
  } catch (error) {
    const endTime = Date.now();
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      index: 0, startTime, endTime,
      duration: endTime - startTime,
      success: false,
      error: "[taco-signing] " + errorMessage,
      tacoSigningTimeMs,
    };
  }
}

// =============================================================================
// Statistics
// =============================================================================

function calculateStats(values: number[]): Stats {
  if (values.length === 0) {
    return { min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0, stdDev: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / sorted.length;
  const squaredDiffs = sorted.map((v) => Math.pow(v - mean, 2));
  const avgSquaredDiff = squaredDiffs.reduce((a, b) => a + b, 0) / sorted.length;
  const stdDev = Math.sqrt(avgSquaredDiff);
  const percentile = (p: number) => {
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
  };
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: Math.round(mean),
    p50: percentile(50),
    p95: percentile(95),
    p99: percentile(99),
    stdDev: Math.round(stdDev),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cooldownTimer(seconds: number, label: string): Promise<void> {
  for (let remaining = seconds; remaining > 0; remaining--) {
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    const time = mins > 0 ? mins + "m " + String(secs).padStart(2, "0") + "s" : secs + "s";
    process.stdout.write("\r" + ANSI.dim + "[taco-perf] " + label + " " + ANSI.cyan + time + ANSI.reset + "  ");
    await sleep(1000);
  }
  process.stdout.write("\r" + ANSI.dim + "[taco-perf] " + label + " done" + ANSI.reset + " ".repeat(20) + "\n");
}

// =============================================================================
// Rate Controllers
// =============================================================================

async function runSteadyMode(
  preparedPayloads: PreparedPayload[],
  options: SteadyModeOptions,
): Promise<SteadyModeResult> {
  const { rate, duration, requestCount, maxDuration, maxConsecutiveFailures } = options;
  const intervalMs = 1000 / rate;
  const hasStopConditions = maxDuration !== undefined || maxConsecutiveFailures !== undefined;
  const totalRequests = !hasStopConditions
    ? (requestCount ?? Math.floor((duration || 60) * rate))
    : undefined;

  let payloadIndex = 0;
  let completedCount = 0;
  let consecutiveFailures = 0;

  if (VERBOSE) {
    const modeDesc = hasStopConditions
      ? rate + " req/s, max " + (maxDuration || "inf") + "s, max " + (maxConsecutiveFailures || "inf") + " consecutive failures"
      : rate + " req/s, " + totalRequests + " total requests";
    console.log("[taco-perf] Starting steady mode: " + modeDesc);
  }

  const testStartTime = Date.now();
  const results: RequestResult[] = [];
  const timeline: TimelineRequest[] = [];
  const pendingRequests: Map<number, Promise<RequestResult>> = new Map();
  let nextRequestIndex = 0;
  let stopReason: StopReason = "completed";
  let shouldStop = false;

  const display = !VERBOSE && isTTY
    ? new ProgressDisplay("steady", rate, totalRequests, testStartTime)
    : null;

  const processResult = (result: RequestResult): boolean => {
    completedCount++;
    results.push(result);
    if (result.success) { consecutiveFailures = 0; }
    else { consecutiveFailures++; }

    const elapsed = (result.endTime - testStartTime) / 1000;
    const inFlight = pendingRequests.size;
    timeline.push({
      index: result.index,
      timestamp: result.endTime,
      elapsedSec: elapsed,
      duration: result.duration,
      tacoSigningTimeMs: result.tacoSigningTimeMs ?? null,
      success: result.success,
      error: result.error,
      inFlight,
    });

    if (display) {
      display.update(result, inFlight, consecutiveFailures);
    } else {
      const totalDesc = totalRequests ? "/" + totalRequests : "";
      console.log(
        "[" + elapsed.toFixed(0).padStart(3, "0") + "s] Completed " + completedCount + totalDesc + " | " +
        "in-flight: " + inFlight + " | " +
        (result.success ? "ok" : "FAIL") + " " + (result.duration / 1000).toFixed(2) + "s" +
        (consecutiveFailures > 0 ? " | consec-fail: " + consecutiveFailures : ""),
      );
    }

    if (maxConsecutiveFailures !== undefined && consecutiveFailures >= maxConsecutiveFailures) {
      stopReason = "consecutive-failures";
      return true;
    }
    return false;
  };

  while (!shouldStop) {
    const elapsedSec = (Date.now() - testStartTime) / 1000;
    if (maxDuration !== undefined && elapsedSec >= maxDuration) {
      stopReason = "duration";
      break;
    }
    if (totalRequests !== undefined && nextRequestIndex >= totalRequests) {
      break;
    }

    const prepared = preparedPayloads[payloadIndex % preparedPayloads.length];
    payloadIndex++;
    const requestIndex = nextRequestIndex++;

    const requestPromise = executeSigningRequest(prepared).then((result) => {
      result.index = requestIndex;
      pendingRequests.delete(requestIndex);
      shouldStop = processResult(result);
      return result;
    });
    pendingRequests.set(requestIndex, requestPromise);

    const elapsed = Date.now() - testStartTime;
    const expectedElapsed = nextRequestIndex * intervalMs;
    const waitTime = Math.max(0, expectedElapsed - elapsed);
    if (waitTime > 0) await sleep(waitTime);
  }

  if (pendingRequests.size > 0 && stopReason !== "completed") {
    if (VERBOSE) console.log("[taco-perf] Stop condition reached, abandoning " + pendingRequests.size + " in-flight requests");
  } else if (pendingRequests.size > 0) {
    if (VERBOSE) console.log("[taco-perf] Waiting for " + pendingRequests.size + " in-flight requests...");
    const remaining = await Promise.all(pendingRequests.values());
    for (const result of remaining) {
      if (!results.find((r) => r.index === result.index)) processResult(result);
    }
  }

  if (display) display.finish();

  if (VERBOSE) {
    console.log("[taco-perf] Steady mode complete. Stop reason: " + stopReason +
      ((stopReason as string) === "consecutive-failures" ? " (" + consecutiveFailures + " consecutive failures)" : ""));
  }

  return {
    results,
    timeline,
    stopReason,
    consecutiveFailuresAtStop: (stopReason as string) === "consecutive-failures" ? consecutiveFailures : undefined,
  };
}

async function runBurstMode(
  preparedPayloads: PreparedPayload[],
  burstSize: number,
  totalBatches: number,
): Promise<RequestResult[]> {
  const results: RequestResult[] = [];
  const totalRequests = totalBatches * burstSize;
  let payloadIndex = 0;
  let requestIndex = 0;

  if (VERBOSE) console.log("[taco-perf] Starting burst mode: size=" + burstSize + ", batches=" + totalBatches);

  const startTime = Date.now();
  const display = !VERBOSE && isTTY
    ? new ProgressDisplay("burst", burstSize, totalRequests, startTime)
    : null;

  for (let batch = 0; batch < totalBatches; batch++) {
    const batchPromises: Promise<RequestResult>[] = [];
    const currentBatchSize = Math.min(burstSize, totalRequests - requestIndex);

    for (let i = 0; i < currentBatchSize; i++) {
      const prepared = preparedPayloads[payloadIndex % preparedPayloads.length];
      payloadIndex++;
      const idx = requestIndex++;
      batchPromises.push(executeSigningRequest(prepared).then((r) => ({ ...r, index: idx })));
    }

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);

    if (display) {
      display.updateBatch(batch + 1, totalBatches, batchResults);
    } else {
      const elapsed = (Date.now() - startTime) / 1000;
      const successCount = results.filter((r) => r.success).length;
      const avgDuration = results.reduce((a, r) => a + r.duration, 0) / results.length;
      console.log(
        "[" + elapsed.toFixed(0).padStart(3, "0") + "s] Batch " + (batch + 1) + "/" + totalBatches + " | " +
        results.length + "/" + totalRequests + " requests | " +
        successCount + " ok, " + (results.length - successCount) + " fail | " +
        "avg: " + (avgDuration / 1000).toFixed(2) + "s",
      );
    }
  }

  if (display) display.finish();
  return results;
}

// =============================================================================
// Results Processing
// =============================================================================

function formatStats(stats: Stats): string {
  const fmt = (ms: number) => (ms / 1000).toFixed(2) + "s";
  return (
    "    Min:    " + fmt(stats.min) + "\n" +
    "    Max:    " + fmt(stats.max) + "\n" +
    "    Mean:   " + fmt(stats.mean) + "\n" +
    "    p50:    " + fmt(stats.p50) + "\n" +
    "    p95:    " + fmt(stats.p95) + "\n" +
    "    p99:    " + fmt(stats.p99) + "\n" +
    "    StdDev: " + fmt(stats.stdDev)
  );
}

function parseNodeFailures(errors: string[]): NodeFailure[] {
  const nodeMap = new Map<string, { timeouts: number; otherErrors: number }>();
  for (const error of errors) {
    const timeoutMatches = error.matchAll(/Node\s+(0x[a-fA-F0-9]+)\s+did not respond before timeout/g);
    for (const match of timeoutMatches) {
      const addr = match[1];
      const existing = nodeMap.get(addr) || { timeouts: 0, otherErrors: 0 };
      existing.timeouts++;
      nodeMap.set(addr, existing);
    }
    const jsonMatch = error.match(/TACo signing failed with errors:\s*(\{[^}]+\})/);
    if (jsonMatch) {
      try {
        const errObj = JSON.parse(jsonMatch[1]);
        for (const [addr, msg] of Object.entries(errObj)) {
          const existing = nodeMap.get(addr) || { timeouts: 0, otherErrors: 0 };
          if (String(msg).includes("timeout")) existing.timeouts++;
          else existing.otherErrors++;
          nodeMap.set(addr, existing);
        }
      } catch {}
    }
  }
  return Array.from(nodeMap.entries())
    .map(([address, counts]) => ({ address, timeouts: counts.timeouts, otherErrors: counts.otherErrors }))
    .sort((a, b) => b.timeouts + b.otherErrors - (a.timeouts + a.otherErrors));
}

function printResults(results: RequestResult[], mode: string, rate: number, label?: string): RunResult {
  const totalDuration = (results[results.length - 1].endTime - results[0].startTime) / 1000;
  const successResults = results.filter((r) => r.success);
  const failedResults = results.filter((r) => !r.success);

  const latencyStats = calculateStats(results.map((r) => r.duration));
  const successLatencyStats = successResults.length > 0 ? calculateStats(successResults.map((r) => r.duration)) : null;
  const failureLatencyStats = failedResults.length > 0 ? calculateStats(failedResults.map((r) => r.duration)) : null;

  const tacoTimes = results.filter((r) => r.tacoSigningTimeMs !== undefined).map((r) => r.tacoSigningTimeMs!);
  const tacoStats = tacoTimes.length > 0 ? calculateStats(tacoTimes) : null;
  const successTacoTimes = successResults.filter((r) => r.tacoSigningTimeMs !== undefined).map((r) => r.tacoSigningTimeMs!);
  const failureTacoTimes = failedResults.filter((r) => r.tacoSigningTimeMs !== undefined).map((r) => r.tacoSigningTimeMs!);
  const successTacoStats = successTacoTimes.length > 0 ? calculateStats(successTacoTimes) : null;
  const failureTacoStats = failureTacoTimes.length > 0 ? calculateStats(failureTacoTimes) : null;

  const allErrors = failedResults.map((r) => r.error || "Unknown error");
  const nodeFailures = parseNodeFailures(allErrors);
  const errorCountMap = new Map<string, number>();
  for (const err of allErrors) errorCountMap.set(err, (errorCountMap.get(err) || 0) + 1);
  const errorsWithCounts: ErrorWithCount[] = Array.from(errorCountMap.entries()).map(([message, count]) => ({ message, count }));

  const modeLabel = mode === "burst" ? "Burst size: " + rate : "Rate: " + rate + " req/s";

  console.log("\n" + "=".repeat(60));
  console.log("                    TEST RESULTS" + (label ? " (" + label + ")" : ""));
  console.log("=".repeat(60));
  console.log();
  console.log("Mode: " + mode + " | " + modeLabel + " | Duration: " + totalDuration.toFixed(1) + "s");
  console.log();
  console.log("REQUESTS");
  console.log("    Total:       " + results.length + " requests");
  console.log("    Success:     " + successResults.length + " (" + ((successResults.length / results.length) * 100).toFixed(1) + "%)");
  console.log("    Failed:      " + failedResults.length + " (" + ((failedResults.length / results.length) * 100).toFixed(1) + "%)");
  console.log();
  console.log("LATENCY");
  console.log(formatStats(latencyStats));

  if (tacoStats) {
    console.log();
    console.log("TACO SIGNING TIME");
    console.log(formatStats(tacoStats));
  }

  if (errorsWithCounts.length > 0) {
    console.log();
    console.log("ERRORS");
    for (const { message, count } of errorsWithCounts.slice(0, 5)) {
      const shortErr = message.length > 60 ? message.slice(0, 60) + "..." : message;
      console.log("    [" + count + "x] " + shortErr);
    }
    if (errorsWithCounts.length > 5) {
      console.log("    ... and " + (errorsWithCounts.length - 5) + " more unique errors");
    }
  }
  console.log();
  console.log("=".repeat(60));

  return {
    mode: mode as "steady" | "burst",
    targetRate: rate,
    duration: Math.round(totalDuration * 10) / 10,
    label,
    requests: { total: results.length, success: successResults.length, failed: failedResults.length },
    latency: latencyStats,
    successLatency: successLatencyStats,
    failureLatency: failureLatencyStats,
    tacoSigningTime: tacoStats,
    successTacoSigningTime: successTacoStats,
    failureTacoSigningTime: failureTacoStats,
    nodeFailures,
    errors: errorsWithCounts,
  };
}

// =============================================================================
// File I/O
// =============================================================================

const RESULTS_DIR = "results";
const DATA_DIR = path.join(RESULTS_DIR, "data");
const REPORTS_DIR = path.join(RESULTS_DIR, "reports");

function ensureResultsDirs(): void {
  for (const dir of [RESULTS_DIR, DATA_DIR, REPORTS_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

function generateTimestamp(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return yyyy + "-" + mm + "-" + dd + "-" + hh + min + ss;
}

function saveTestData(data: TestData): string {
  ensureResultsDirs();
  const filepath = path.join(DATA_DIR, generateTimestamp() + ".json");
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
  return filepath;
}

function loadTestData(filepath: string): TestData {
  return JSON.parse(fs.readFileSync(filepath, "utf-8")) as TestData;
}

function getLatestDataFile(): string | null {
  ensureResultsDirs();
  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json"));
  if (files.length === 0) return null;
  files.sort().reverse();
  return path.join(DATA_DIR, files[0]);
}

// =============================================================================
// CLI
// =============================================================================

function parseArgs(args: string[]): CLIOptions {
  const { values } = nodeParseArgs({
    args,
    options: {
      config:        { type: "string" },
      mode:          { type: "string" },
      rate:          { type: "string" },
      duration:      { type: "string" },
      requests:      { type: "string" },
      rates:         { type: "string" },
      output:        { type: "string" },
      "from-data":   { type: "string" },
      regenerate:    { type: "boolean" },
      "max-duration": { type: "string" },
      "max-failures": { type: "string" },
      verbose:       { type: "boolean", short: "v" },
      json:          { type: "boolean" },
      domain:        { type: "string" },
      cohort:        { type: "string" },
      chain:         { type: "string" },
    },
    strict: false,
  });

  return {
    config: (values.config as string) || "",
    mode: values.mode as CLIOptions["mode"],
    rate: values.rate ? parseFloat(values.rate as string) : undefined,
    duration: values.duration ? parseInt(values.duration as string, 10) : undefined,
    requests: values.requests ? parseInt(values.requests as string, 10) : undefined,
    rates: values.rates ? (values.rates as string).split(",").map((r) => parseFloat(r.trim())) : undefined,
    output: values.output as string | undefined,
    fromData: values["from-data"] as string | undefined,
    regenerate: values.regenerate as boolean | undefined,
    maxDuration: values["max-duration"] ? parseInt(values["max-duration"] as string, 10) : undefined,
    maxConsecutiveFailures: values["max-failures"] ? parseInt(values["max-failures"] as string, 10) : undefined,
    verbose: values.verbose as boolean | undefined,
    json: values.json as boolean | undefined,
    domain: values.domain as string | undefined,
    cohortId: values.cohort ? parseInt(values.cohort as string, 10) : undefined,
    chainId: values.chain ? parseInt(values.chain as string, 10) : undefined,
  };
}

function loadConfig(cliOptions: CLIOptions): {
  config: Config;
  mode: "steady" | "burst" | "sweep";
  rate: number;
  duration: number;
  requests?: number;
  rates: number[];
  burstSizes: number[];
  batchesPerBurst: number;
  cooldown: number;
  timeout: number;
  maxDuration?: number;
  maxConsecutiveFailures?: number;
  output?: string;
} {
  if (!cliOptions.config) {
    console.error("Error: --config=<file> is required");
    process.exit(1);
  }

  const configPath = path.resolve(process.cwd(), cliOptions.config);
  if (!fs.existsSync(configPath)) {
    console.error("Error: Config file not found: " + configPath);
    process.exit(1);
  }

  const config: Config = YAML.parse(fs.readFileSync(configPath, "utf-8"));
  if (!config.payloads || config.payloads.length === 0) {
    console.error("Error: Config must contain at least one payload");
    process.exit(1);
  }

  const d = config.defaults || {};
  return {
    config,
    mode: (cliOptions.mode || d.mode || "steady") as "steady" | "burst" | "sweep",
    rate: cliOptions.rate ?? d.rate ?? 1,
    duration: cliOptions.duration ?? d.duration ?? 60,
    requests: cliOptions.requests ?? d.requests,
    rates: cliOptions.rates || d.rates || [0.5, 1, 3, 5, 10],
    burstSizes: d.burstSizes || [1, 3, 5, 10],
    batchesPerBurst: d.batchesPerBurst || 10,
    cooldown: d.cooldown ?? 30,
    timeout: d.timeout ?? 120,
    maxDuration: cliOptions.maxDuration ?? d.maxDuration,
    maxConsecutiveFailures: cliOptions.maxConsecutiveFailures ?? d.maxConsecutiveFailures,
    output: cliOptions.output,
  };
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const cliOptions = parseArgs(process.argv.slice(2));

  // Handle --from-data: regenerate report from existing data
  if (cliOptions.fromData) {
    const dataPath = cliOptions.fromData;
    if (!fs.existsSync(dataPath)) {
      console.error("Error: Data file not found: " + dataPath);
      process.exit(1);
    }
    console.log("[taco-perf] Loading test data from: " + dataPath);
    const data = loadTestData(dataPath);
    // Report generation will be handled by report.ts
    console.log("[taco-perf] Data loaded. Use report.ts to generate reports.");
    process.exit(0);
  }

  // Handle --regenerate: regenerate report from latest data
  if (cliOptions.regenerate) {
    const latestData = getLatestDataFile();
    if (!latestData) {
      console.error("Error: No test data found in results/data/");
      process.exit(1);
    }
    console.log("[taco-perf] Latest data: " + latestData);
    process.exit(0);
  }

  if (!cliOptions.config) {
    console.log("\nTACo Performance Test Tool\n");
    console.log("Usage:");
    console.log("  npx tsx src/runner.ts --config=<file.yml> [options]\n");
    console.log("Options:");
    console.log("  --config=<file>     Config file (required)");
    console.log("  --mode=<mode>       steady, burst, or sweep (default: steady)");
    console.log("  --rate=<n>          Requests per second (default: 1)");
    console.log("  --duration=<sec>    Duration per rate level (default: 60)");
    console.log("  --requests=<n>      Fixed request count (overrides duration)");
    console.log("  --domain=<domain>   TACo domain: devnet or mainnet (default: devnet)");
    console.log("  --cohort=<id>       Cohort ID (default: 3)");
    console.log("  --chain=<id>        Chain ID (default: 84532)");
    console.log("  --json              Output JSON summary (for CI)");
    console.log("  --verbose, -v       Verbose scrolling output");
    console.log();
    process.exit(1);
  }

  const {
    config, mode, rate, duration, requests, rates, burstSizes,
    batchesPerBurst, cooldown, timeout, maxDuration, maxConsecutiveFailures, output,
  } = loadConfig(cliOptions);

  // Set global state from CLI/config
  REQUEST_TIMEOUT_SECONDS = timeout;
  VERBOSE = cliOptions.verbose || !isTTY;

  if (cliOptions.domain === "mainnet") {
    TACO_DOMAIN = domains.MAINNET;
    CHAIN_ID = 8453;
  }
  if (cliOptions.cohortId !== undefined) COHORT_ID = cliOptions.cohortId;
  if (cliOptions.chainId !== undefined) CHAIN_ID = cliOptions.chainId;

  if (VERBOSE) {
    console.log("[taco-perf] TACo Performance Test");
    console.log("[taco-perf] Config: " + cliOptions.config);
    console.log("[taco-perf] Mode: " + mode);
    console.log("[taco-perf] Domain: " + (cliOptions.domain || "devnet") + " | Cohort: " + COHORT_ID + " | Chain: " + CHAIN_ID);
    console.log("[taco-perf] Timeout: " + timeout + "s");
  }

  await initializeClients();

  const preparedPayloads = await prepareAllPayloads(config.payloads);

  const steadyResults: RunResult[] = [];
  const burstResults: RunResult[] = [];

  if (mode === "sweep") {
    console.log("\n[taco-perf] Starting sweep mode");
    console.log("[taco-perf] Steady rates: " + rates.join(", ") + " req/s");
    console.log("[taco-perf] Burst sizes: " + burstSizes.join(", "));
    console.log("[taco-perf] Duration per rate: " + duration + "s\n");

    for (const testRate of rates) {
      console.log("\n" + "-".repeat(60));
      console.log("Steady @ " + testRate + " req/s");
      console.log("-".repeat(60));
      const steadyResult = await runSteadyMode(preparedPayloads, { rate: testRate, duration, requestCount: requests });
      const runResult = printResults(steadyResult.results, "steady", testRate);
      const last10 = steadyResult.results.slice(-10);
      if (last10.length >= 10 && last10.every((r) => !r.success)) {
        runResult.stoppedEarly = true;
      }
      steadyResults.push(runResult);
      if (testRate !== rates[rates.length - 1]) await cooldownTimer(cooldown, "Cooling down...");
    }

    await cooldownTimer(cooldown, "Cooling down before burst tests...");

    for (const burstSize of burstSizes) {
      console.log("\n" + "-".repeat(60));
      console.log("Burst size " + burstSize + " (" + batchesPerBurst + " batches)");
      console.log("-".repeat(60));
      const results = await runBurstMode(preparedPayloads, burstSize, batchesPerBurst);
      burstResults.push(printResults(results, "burst", burstSize));
      if (burstSize !== burstSizes[burstSizes.length - 1]) await cooldownTimer(cooldown, "Cooling down...");
    }
  } else if (mode === "burst") {
    const results = await runBurstMode(preparedPayloads, rate, batchesPerBurst);
    burstResults.push(printResults(results, "burst", rate));
  } else {
    const steadyResult = await runSteadyMode(preparedPayloads, {
      rate, duration, requestCount: requests, maxDuration, maxConsecutiveFailures,
    });
    const runResult = printResults(steadyResult.results, "steady", rate);
    runResult.timeline = steadyResult.timeline;
    runResult.stopReason = steadyResult.stopReason;
    runResult.consecutiveFailuresAtStop = steadyResult.consecutiveFailuresAtStop;
    steadyResults.push(runResult);
  }

  // Save test data
  const testData: TestData = {
    version: 1,
    timestamp: new Date().toISOString(),
    config: {
      mode, rate, duration,
      rates, burstSizes, batchesPerBurst,
      domain: cliOptions.domain || "devnet",
      cohortId: COHORT_ID,
      chainId: CHAIN_ID,
      maxDuration, maxConsecutiveFailures,
    },
    steadyResults,
    burstResults,
  };

  const dataPath = saveTestData(testData);
  console.log("\n[taco-perf] Test data saved to: " + dataPath);

  // JSON summary output (for CI)
  if (cliOptions.json) {
    const allResults = [...steadyResults, ...burstResults];
    const summary: JsonSummary = {
      timestamp: testData.timestamp,
      domain: cliOptions.domain || "devnet",
      cohortId: COHORT_ID,
      chainId: CHAIN_ID,
      results: allResults.map((r) => ({
        label: r.label || (r.mode + " @ " + r.targetRate),
        mode: r.mode,
        targetRate: r.targetRate,
        total: r.requests.total,
        success: r.requests.success,
        failed: r.requests.failed,
        successRate: r.requests.total > 0 ? (r.requests.success / r.requests.total) * 100 : 0,
        p50: r.latency.p50,
        p95: r.latency.p95,
      })),
    };
    console.log("\n" + JSON.stringify(summary, null, 2));
  }

  console.log("\n[taco-perf] Done!");
  process.exit(0);
}

main().catch((err) => {
  console.error("[taco-perf] Fatal error:", err);
  process.exit(1);
});
