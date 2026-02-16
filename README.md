# taco-performance

Performance monitor and analysis tool for the [TACo](https://threshold.network/taco) threshold signing network. Runs signing requests against live cohorts, generates interactive reports, and posts daily health summaries to Discord.

## Quick Start

```bash
cp .env.example .env
# Fill in RPC URLs and bundler key

npm install

# Run a quick test (2 req/s for 30s against cohort 1)
npx tsx src/runner.ts --config=configs/daily-cohort1.yml --cohort=1

# Generate an interactive report from the latest data
npx tsx src/report.ts --latest
```

## Usage

### Test Runner

```bash
# Steady mode — fixed rate
npx tsx src/runner.ts --config=configs/daily-cohort1.yml --rate=2 --duration=30

# Sweep mode — test multiple rates
npx tsx src/runner.ts --config=configs/analysis.yml --mode=sweep

# Mainnet
npx tsx src/runner.ts --config=configs/daily-cohort1.yml --domain=mainnet --cohort=1 --chain=8453

# JSON output for CI
npx tsx src/runner.ts --config=configs/daily-cohort1.yml --json

# Verbose (scrolling logs instead of compact display)
npx tsx src/runner.ts --config=configs/daily-cohort1.yml -v
```

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `--config=<file>` | Config file with payloads (required) | — |
| `--mode=<mode>` | `steady`, `burst`, or `sweep` | `steady` |
| `--rate=<n>` | Requests per second | `1` |
| `--duration=<s>` | Duration per rate level (seconds) | `60` |
| `--domain=<d>` | `devnet` or `mainnet` | `devnet` |
| `--cohort=<id>` | Cohort ID | `3` |
| `--chain=<id>` | Chain ID | `84532` |
| `--json` | Print JSON summary to stdout | — |
| `--verbose`, `-v` | Scrolling log output | — |

### Report Generator

```bash
# From latest data file
npx tsx src/report.ts --latest

# From a specific data file
npx tsx src/report.ts results/data/2026-02-16-123456.json

# Custom output path
npx tsx src/report.ts --latest --output=my-report.html
```

Reports are self-contained HTML files using [Plotly.js](https://plotly.com/javascript/) with interactive charts: zoom, pan, box select, hover tooltips, and PNG export.

**Charts included:**

- Request latency scatter over elapsed time (success/fail color-coded)
- Latency distribution histogram
- Concurrent in-flight requests over time
- In-flight vs latency correlation
- Success rate and latency percentiles across request rates (sweep mode)
- Per-node error attribution
- Expandable full error messages for every unique failure

## Environment Variables

RPC URLs are resolved based on the `--domain` flag. Mainnet vars are prefixed with `MAINNET_` and fall back to the unprefixed versions if not set.

| Variable | Domain | Description |
|----------|--------|-------------|
| `ETH_RPC_URL` | devnet | Sepolia RPC (signing coordinator) |
| `SIGNING_CHAIN_RPC_URL` | devnet | Base Sepolia RPC (signing chain) |
| `BUNDLER_URL` | devnet | ERC-4337 bundler (Pimlico) |
| `MAINNET_ETH_RPC_URL` | mainnet | Ethereum mainnet RPC |
| `MAINNET_SIGNING_CHAIN_RPC_URL` | mainnet | Base mainnet RPC |
| `MAINNET_BUNDLER_URL` | mainnet | Mainnet bundler |
| `DISCORD_WEBHOOK_URL` | — | Discord webhook (CI only) |

## CI/CD

### Daily Health Check

Runs at 8am UTC via cron. Tests both cohorts on devnet:

- **Cohort 1** — simple conditions (`blocktime > 0`), bare payload
- **Cohort 3** — Discord signature verification, full payload

Results are uploaded as GitHub artifacts (90-day retention) and a summary is posted to the Discord monitoring channel.

### Analysis Mode

Triggered manually via `workflow_dispatch` with inputs for domain, cohort, chain, mode, rate, and duration. Use this after deploying new code to nodes.

### Required Secrets

`ETH_RPC_URL`, `SIGNING_CHAIN_RPC_URL`, `BUNDLER_URL`, `MAINNET_ETH_RPC_URL`, `MAINNET_SIGNING_CHAIN_RPC_URL`, `MAINNET_BUNDLER_URL`, `DISCORD_WEBHOOK_URL`

## Test Configs

| Config | Cohort | Rate | Duration | Use Case |
|--------|--------|------|----------|----------|
| `daily-cohort1.yml` | 1 (simple) | 2 req/s | 30s | Daily health check |
| `daily-cohort3.yml` | 3 (Discord) | 2 req/s | 30s | Daily health check |
| `analysis.yml` | any | sweep | 60s/rate | Post-deployment analysis |

## Project Structure

```
src/
  runner.ts    — test execution engine
  report.ts    — Plotly.js HTML report generator
  types.ts     — shared TypeScript interfaces
configs/       — YAML test configurations
scripts/       — CI helper scripts
.github/       — GitHub Actions workflows
```

