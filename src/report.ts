#!/usr/bin/env node

/**
 * TACo Performance Report Generator
 *
 * Generates interactive Plotly.js HTML reports from test data.
 *
 * Usage:
 *   npx tsx src/report.ts results/data/2026-02-16-123456.json
 *   npx tsx src/report.ts --latest
 *   npx tsx src/report.ts results/data/2026-02-16-123456.json --output=report.html
 */

import * as fs from "fs";
import * as path from "path";
import { parseArgs } from "node:util";
import type { TestData, RunResult, Stats, ErrorWithCount, TimelineRequest } from "./types";

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
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return now.getFullYear() + "-" + p(now.getMonth() + 1) + "-" + p(now.getDate()) + "-" + p(now.getHours()) + p(now.getMinutes()) + p(now.getSeconds());
}

function getLatestDataFile(): string | null {
  ensureResultsDirs();
  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json"));
  if (files.length === 0) return null;
  files.sort().reverse();
  return path.join(DATA_DIR, files[0]);
}

// =============================================================================
// Color Palette
// =============================================================================

const COLORS = {
  bg: "#000000",
  cardBg: "#111111",
  text: "#ffffff",
  textMuted: "#909090",
  accent: "#96FF5E",
  success: "#96FF5E",
  warning: "#ffa726",
  error: "#ef5350",
  border: "#333333",
  cohort1: "#00bcd4",
  cohort2: "#ff9800",
  grid: "#222222",
};

// =============================================================================
// Report Generator
// =============================================================================

function generateReport(data: TestData): string {
  const { steadyResults, burstResults, config: testConfig } = data;
  const allResults = [...steadyResults, ...burstResults];
  const totalRequests = allResults.reduce((a, r) => a + r.requests.total, 0);
  const totalSuccess = allResults.reduce((a, r) => a + r.requests.success, 0);
  const overallSuccessRate = totalRequests > 0 ? (totalSuccess / totalRequests) * 100 : 0;

  const isTimeline = steadyResults.length === 1 && steadyResults[0].timeline && steadyResults[0].timeline.length > 0;
  const isSweep = steadyResults.length > 1 || burstResults.length > 1;

  const fmtDuration = (ms: number): string => {
    if (ms < 1000) return ms + "ms";
    return (ms / 1000).toFixed(2) + "s";
  };

  // Collect errors
  const allErrors: Array<{ source: string; errors: ErrorWithCount[] }> = [];
  for (const r of steadyResults) {
    if (r.errors.length > 0) allErrors.push({ source: (r.label || "Steady @ " + r.targetRate + " req/s"), errors: r.errors });
  }
  for (const r of burstResults) {
    if (r.errors.length > 0) allErrors.push({ source: (r.label || "Burst size " + r.targetRate), errors: r.errors });
  }

  // (errors are shown directly, no grouping)

  // Build chart data as JSON for embedding
  const chartData: Record<string, unknown> = {};

  // Timeline data (for single steady mode with timeline)
  if (isTimeline) {
    const tl = steadyResults[0].timeline!;
    chartData.timeline = {
      success: { x: [] as number[], y: [] as number[], text: [] as string[] },
      fail: { x: [] as number[], y: [] as number[], text: [] as string[] },
      inFlight: { x: [] as number[], y: [] as number[] },
    };
    for (const t of tl) {
      const bucket = t.success ? (chartData.timeline as any).success : (chartData.timeline as any).fail;
      (bucket as any).x.push(t.elapsedSec);
      (bucket as any).y.push(t.duration / 1000);
      const errText = t.error ? t.error.replace(/(.{80})/g, "<br>") : "";
      (bucket as any).text.push("#" + t.index + (errText ? "<br>" + errText : ""));
    }
    chartData.timelineInFlight = {
      x: tl.map((t: TimelineRequest) => t.elapsedSec),
      y: tl.map((t: TimelineRequest) => t.inFlight),
    };
    // Latency histogram
    const successDurations = tl.filter((t: TimelineRequest) => t.success).map((t: TimelineRequest) => t.duration / 1000);
    const failDurations = tl.filter((t: TimelineRequest) => !t.success).map((t: TimelineRequest) => t.duration / 1000);
    chartData.latencyHist = { success: successDurations, fail: failDurations };
    // In-flight vs latency scatter
    chartData.inFlightVsLatency = {
      x: tl.map((t: TimelineRequest) => t.inFlight),
      y: tl.map((t: TimelineRequest) => t.duration / 1000),
      success: tl.map((t: TimelineRequest) => t.success),
    };
  }

  // Sweep data (multiple rates)
  if (isSweep) {
    chartData.steadySweep = steadyResults.map((r) => ({
      rate: r.targetRate,
      label: r.label || r.targetRate + " req/s",
      successPct: r.requests.total > 0 ? (r.requests.success / r.requests.total) * 100 : 0,
      p50: r.latency.p50 / 1000,
      p95: r.latency.p95 / 1000,
      p99: r.latency.p99 / 1000,
      tacoP50: r.tacoSigningTime ? r.tacoSigningTime.p50 / 1000 : null,
      tacoP95: r.tacoSigningTime ? r.tacoSigningTime.p95 / 1000 : null,
      stoppedEarly: r.stoppedEarly || false,
    }));
    chartData.burstSweep = burstResults.map((r) => ({
      size: r.targetRate,
      successPct: r.requests.total > 0 ? (r.requests.success / r.requests.total) * 100 : 0,
      p50: r.latency.p50 / 1000,
      p95: r.latency.p95 / 1000,
    }));
  }

  // Node failures across all results
  const nodeMap = new Map<string, { timeouts: number; otherErrors: number }>();
  for (const r of allResults) {
    for (const nf of r.nodeFailures) {
      const ex = nodeMap.get(nf.address) || { timeouts: 0, otherErrors: 0 };
      ex.timeouts += nf.timeouts;
      ex.otherErrors += nf.otherErrors;
      nodeMap.set(nf.address, ex);
    }
  }
  if (nodeMap.size > 0) {
    const entries = Array.from(nodeMap.entries()).sort((a, b) => (b[1].timeouts + b[1].otherErrors) - (a[1].timeouts + a[1].otherErrors));
    chartData.nodeFailures = {
      labels: entries.map(([a]) => a.slice(0, 10) + "..."),
      fullLabels: entries.map(([a]) => a),
      timeouts: entries.map(([, v]) => v.timeouts),
      otherErrors: entries.map(([, v]) => v.otherErrors),
    };
  }

  const domainLabel = testConfig.domain || "devnet";
  const cohortLabel = testConfig.cohortId !== undefined ? "Cohort " + testConfig.cohortId : "";
  const chainLabel = testConfig.chainId !== undefined ? "Chain " + testConfig.chainId : "";
  const configLabel = [domainLabel, cohortLabel, chainLabel].filter(Boolean).join(" | ");

  const dateStr = new Date(data.timestamp).toLocaleString("en-US", {
    weekday: "short", year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", timeZoneName: "short",
  });

  // Summary cards data
  const summaryCards = allResults.map((r) => {
    const successPct = r.requests.total > 0 ? (r.requests.success / r.requests.total) * 100 : 0;
    return {
      label: r.label || r.mode + " @ " + r.targetRate + (r.mode === "burst" ? " concurrent" : " req/s"),
      total: r.requests.total,
      success: r.requests.success,
      failed: r.requests.failed,
      successPct,
      duration: r.duration,
      p50: fmtDuration(r.latency.p50),
      p95: fmtDuration(r.latency.p95),
      p99: fmtDuration(r.latency.p99),
      tacoP50: r.tacoSigningTime ? fmtDuration(r.tacoSigningTime.p50) : "N/A",
      tacoP95: r.tacoSigningTime ? fmtDuration(r.tacoSigningTime.p95) : "N/A",
      stopReason: r.stopReason,
    };
  });

  return generateHTML(data, chartData, summaryCards, allErrors, dateStr, configLabel, overallSuccessRate);
}

function generateHTML(
  data: TestData,
  chartData: Record<string, unknown>,
  summaryCards: Array<Record<string, unknown>>,
  allErrors: Array<{ source: string; errors: ErrorWithCount[] }>,
  dateStr: string,
  configLabel: string,
  overallSuccessRate: number,
): string {
  const successColor = overallSuccessRate >= 95 ? COLORS.success : overallSuccessRate >= 80 ? COLORS.warning : COLORS.error;

  // Build error sections HTML — show every unique error with full message
  let errorSectionsHTML = "";
  let errorId = 0;
  for (const { source, errors } of allErrors) {
    let rows = "";
    const totalFailed = errors.reduce((a, e) => a + e.count, 0);
    for (const { message, count } of errors) {
      const eid = "err-" + (errorId++);
      const shortMsg = message.length > 120 ? message.slice(0, 120) + "..." : message;
      const escapedFull = message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      const isLong = message.length > 120;
      rows += '<div class="error-entry">';
      rows += '<div class="error-header"' + (isLong ? ' onclick="toggleError(\'' + eid + '\')" style="cursor:pointer"' : '') + '>';

      rows += '<span class="error-count">' + count + 'x</span>';
      rows += '<span class="error-summary">' + (isLong ? '<span class="expand-icon" id="icon-' + eid + '">+</span> ' : '') + shortMsg.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") + '</span>';
      rows += '</div>';
      if (isLong) {
        rows += '<pre class="error-full" id="' + eid + '" style="display:none">' + escapedFull + '</pre>';
      }
      rows += '</div>';
    }
    errorSectionsHTML += '<div class="error-section"><h3>' + source + ' <span class="error-total">' + totalFailed + ' failed</span></h3>' + rows + '</div>';
  }

  // Build summary cards HTML
  let cardsHTML = "";
  for (const c of summaryCards) {
    const pctColor = (c.successPct as number) >= 95 ? COLORS.success : (c.successPct as number) >= 80 ? COLORS.warning : COLORS.error;
    cardsHTML += '<div class="result-card"><h3>' + c.label + '</h3>' +
      '<div class="stat-row"><span class="stat-label">Requests</span><span class="stat-value">' + c.success + ' / ' + c.total + '</span></div>' +
      '<div class="stat-row"><span class="stat-label">Success Rate</span><span class="stat-value" style="color:' + pctColor + '">' + (c.successPct as number).toFixed(1) + '%</span></div>' +
      '<div class="stat-row"><span class="stat-label">Duration</span><span class="stat-value">' + c.duration + 's</span></div>' +
      '<div class="stat-row"><span class="stat-label">p50</span><span class="stat-value">' + c.p50 + '</span></div>' +
      '<div class="stat-row"><span class="stat-label">p95</span><span class="stat-value">' + c.p95 + '</span></div>' +
      '<div class="stat-row"><span class="stat-label">p99</span><span class="stat-value">' + c.p99 + '</span></div>' +
      '<div class="stat-row"><span class="stat-label">TACo p50</span><span class="stat-value">' + c.tacoP50 + '</span></div>' +
      '<div class="stat-row"><span class="stat-label">TACo p95</span><span class="stat-value">' + c.tacoP95 + '</span></div>' +
      (c.stopReason && c.stopReason !== "completed" ? '<div class="stat-row"><span class="stat-label">Stop</span><span class="stat-value" style="color:' + COLORS.warning + '">' + c.stopReason + '</span></div>' : "") +
      '</div>';
  }

  // Determine which chart divs to include
  const hasTimeline = !!(chartData as any).timeline;
  const hasSweep = !!(chartData as any).steadySweep;
  const hasNodeFailures = !!(chartData as any).nodeFailures;

  // HTML built via string concatenation (template literals not used due to tooling)
  let html = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n";
  html += "<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n";
  html += "<title>TACo Performance Report</title>\n";
  html += '<script src=\"https://cdn.plot.ly/plotly-2.35.2.min.js\"></script>\n';
  html += "<style>\n";
  html += ":root { --bg: " + COLORS.bg + "; --card-bg: " + COLORS.cardBg + "; --text: " + COLORS.text + "; --text-muted: " + COLORS.textMuted + "; --accent: " + COLORS.accent + "; --success: " + COLORS.success + "; --warning: " + COLORS.warning + "; --error: " + COLORS.error + "; --border: " + COLORS.border + "; }\n";
  html += "* { box-sizing: border-box; margin: 0; padding: 0; }\n";
  html += "body { font-family: 'SF Mono', 'Monaco', 'Inconsolata', monospace; background: var(--bg); color: var(--text); line-height: 1.6; padding: 2rem; }\n";
  html += ".container { max-width: 1400px; margin: 0 auto; }\n";
  html += ".header { display: flex; align-items: center; gap: 1rem; margin-bottom: 0.5rem; }\n";
  html += "h1 { font-size: 1.5rem; font-weight: 700; letter-spacing: 0.05em; }\n";
  html += "h2 { font-size: 1.25rem; margin: 2rem 0 1rem; color: var(--accent); border-bottom: 1px solid var(--border); padding-bottom: 0.5rem; }\n";
  html += "h3 { font-size: 1rem; margin: 0 0 0.75rem; }\n";
  html += ".timestamp { color: var(--text-muted); font-size: 0.85rem; }\n";
  html += ".config-label { color: var(--text-muted); font-size: 0.8rem; margin-bottom: 2rem; }\n";
  html += ".overall-badge { display: inline-block; padding: 0.25rem 1rem; border-radius: 3px; font-weight: bold; font-size: 1.5rem; }\n";
  html += ".cards-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1rem; margin-bottom: 2rem; }\n";
  html += ".result-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 4px; padding: 1.25rem; }\n";
  html += ".result-card h3 { color: var(--accent); font-size: 0.9rem; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 1rem; }\n";
  html += ".stat-row { display: flex; justify-content: space-between; padding: 0.3rem 0; border-bottom: 1px solid var(--border); }\n";
  html += ".stat-row:last-child { border-bottom: none; }\n";
  html += ".stat-label { color: var(--text-muted); font-size: 0.85rem; }\n";
  html += ".stat-value { font-weight: 600; font-size: 0.85rem; }\n";
  html += ".chart-container { background: var(--card-bg); border: 1px solid var(--border); border-radius: 4px; padding: 1rem; margin-bottom: 1.5rem; }\n";
  html += ".chart-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(500px, 1fr)); gap: 1.5rem; }\n";
  html += "@media (max-width: 1100px) { .chart-row { grid-template-columns: 1fr; } }\n";
  html += ".error-section { background: var(--card-bg); border: 1px solid var(--border); border-radius: 4px; padding: 1.25rem; margin-bottom: 1rem; }\n";
  html += ".error-section h3 { color: var(--text-muted); font-size: 0.85rem; }\n";
  html += ".error-type { display: flex; justify-content: space-between; align-items: center; padding: 0.5rem 0; border-bottom: 1px solid var(--border); font-size: 0.85rem; }\n";
  html += ".error-type:last-child { border-bottom: none; }\n";
  html += ".error-count { background: var(--error); color: white; padding: 0.15rem 0.5rem; border-radius: 2px; font-size: 0.8rem; font-weight: bold; }\n";
  html += "</style>\n</head>\n<body>\n<div class=\"container\">\n";
  html += '<div class=\"header\"><h1>TACo Performance Report</h1>';
  html += '<span class=\"overall-badge\" style=\"color:' + successColor + '\">' + overallSuccessRate.toFixed(1) + '%</span></div>\n';
  html += '<div class=\"timestamp\">' + dateStr + '</div>\n';
  html += '<div class=\"config-label\">' + configLabel + '</div>\n';
  html += '<div class=\"cards-grid\">' + cardsHTML + '</div>\n';

  if (hasTimeline) {
    html += '<h2>Request Timeline</h2><div class=\"chart-container\"><div id=\"timelineChart\" style=\"height:400px\"></div></div>\n';
    html += '<div class=\"chart-row\"><div class=\"chart-container\"><div id=\"latencyHistChart\" style=\"height:350px\"></div></div>';
    html += '<div class=\"chart-container\"><div id=\"inFlightChart\" style=\"height:350px\"></div></div></div>\n';
    html += '<div class=\"chart-container\"><div id=\"inFlightVsLatencyChart\" style=\"height:350px\"></div></div>\n';
  }
  if (hasSweep) {
    html += '<h2>Rate Analysis</h2><div class=\"chart-row\">';
    html += '<div class=\"chart-container\"><div id=\"sweepSuccessChart\" style=\"height:350px\"></div></div>';
    html += '<div class=\"chart-container\"><div id=\"sweepLatencyChart\" style=\"height:350px\"></div></div></div>\n';
  }
  if (hasNodeFailures) {
    html += '<h2>Node Errors</h2><div class=\"chart-container\"><div id=\"nodeFailureChart\" style=\"height:350px\"></div></div>\n';
  }
  if (allErrors.length > 0) {
    html += '<h2>Error Details</h2>' + errorSectionsHTML + '\n';
  }
  html += '</div>\n';
  html += buildPlotlyScript(chartData);
  html += '\n</body>\n</html>';
  return html;
}


// =============================================================================
// Plotly.js Script Builder
// =============================================================================

function buildPlotlyScript(chartData: Record<string, unknown>): string {
  const C = COLORS;
  let s = "<script>\n";
  s += "function toggleError(id) {\n";
  s += "  var el = document.getElementById(id);\n";
  s += "  var icon = document.getElementById('icon-' + id);\n";
  s += "  if (el.style.display === 'none') { el.style.display = 'block'; icon.textContent = '-'; }\n";
  s += "  else { el.style.display = 'none'; icon.textContent = '+'; }\n";
  s += "}\n";
  s += "const chartData = " + JSON.stringify(chartData) + ";\n";
  s += "const plotlyLayout = {\n";
  s += "  paper_bgcolor: '" + C.bg + "', plot_bgcolor: '" + C.cardBg + "',\n";
  s += "  font: { family: 'SF Mono, Monaco, Inconsolata, monospace', color: '" + C.text + "', size: 11 },\n";
  s += "  xaxis: { gridcolor: '" + C.grid + "', zerolinecolor: '" + C.grid + "' },\n";
  s += "  yaxis: { gridcolor: '" + C.grid + "', zerolinecolor: '" + C.grid + "' },\n";
  s += "  margin: { l: 60, r: 30, t: 40, b: 50 }, hovermode: 'closest'\n";
  s += "};\n";
  s += "const plotlyConfig = { responsive: true, displayModeBar: true, modeBarButtonsToRemove: ['lasso2d', 'select2d'], displaylogo: false };\n";

  // Timeline chart
  s += "if (chartData.timeline) {\n";
  s += "  var tl = chartData.timeline;\n";
  s += "  Plotly.newPlot('timelineChart', [\n";
  s += "    { x: tl.success.x, y: tl.success.y, text: tl.success.text, mode: 'markers', type: 'scatter', name: 'Success',\n";
  s += "      marker: { color: '" + C.success + "', size: 6, opacity: 0.7 }, hovertemplate: '%{text}<br>%{y:.2f}s<extra>Success</extra>' },\n";
  s += "    { x: tl.fail.x, y: tl.fail.y, text: tl.fail.text, mode: 'markers', type: 'scatter', name: 'Failed',\n";
  s += "      marker: { color: '" + C.error + "', size: 8, symbol: 'x', opacity: 0.9 }, hovertemplate: '%{text}<br>%{y:.2f}s<extra>Failed</extra>' }\n";
  s += "  ], { ...plotlyLayout, title: 'Request Latency Over Time',\n";
  s += "    xaxis: { ...plotlyLayout.xaxis, title: 'Elapsed Time (s)' },\n";
  s += "    yaxis: { ...plotlyLayout.yaxis, title: 'Latency (s)' } }, plotlyConfig);\n";
  s += "}\n";

  // Latency histogram
  s += "if (chartData.latencyHist) {\n";
  s += "  var h = chartData.latencyHist;\n";
  s += "  Plotly.newPlot('latencyHistChart', [\n";
  s += "    { x: h.success, type: 'histogram', name: 'Success', marker: { color: '" + C.success + "' }, opacity: 0.7 },\n";
  s += "    { x: h.fail, type: 'histogram', name: 'Failed', marker: { color: '" + C.error + "' }, opacity: 0.7 }\n";
  s += "  ], { ...plotlyLayout, title: 'Latency Distribution', barmode: 'overlay',\n";
  s += "    xaxis: { ...plotlyLayout.xaxis, title: 'Latency (s)' },\n";
  s += "    yaxis: { ...plotlyLayout.yaxis, title: 'Count' } }, plotlyConfig);\n";
  s += "}\n";

  // In-flight over time
  s += "if (chartData.timelineInFlight) {\n";
  s += "  var inf = chartData.timelineInFlight;\n";
  s += "  Plotly.newPlot('inFlightChart', [\n";
  s += "    { x: inf.x, y: inf.y, type: 'scatter', mode: 'lines', name: 'In-flight',\n";
  s += "      line: { color: '" + C.warning + "', width: 1.5 }, fill: 'tozeroy', fillcolor: 'rgba(255,167,38,0.15)' }\n";
  s += "  ], { ...plotlyLayout, title: 'Concurrent In-flight Requests',\n";
  s += "    xaxis: { ...plotlyLayout.xaxis, title: 'Elapsed Time (s)' },\n";
  s += "    yaxis: { ...plotlyLayout.yaxis, title: 'In-flight' } }, plotlyConfig);\n";
  s += "}\n";

  // In-flight vs latency scatter
  s += "if (chartData.inFlightVsLatency) {\n";
  s += "  var iv = chartData.inFlightVsLatency;\n";
  s += "  var ivColors = iv.success.map(function(ok) { return ok ? '" + C.success + "' : '" + C.error + "'; });\n";
  s += "  Plotly.newPlot('inFlightVsLatencyChart', [\n";
  s += "    { x: iv.x, y: iv.y, mode: 'markers', type: 'scatter',\n";
  s += "      marker: { color: ivColors, size: 5, opacity: 0.6 },\n";
  s += "      hovertemplate: 'In-flight: %{x}<br>Latency: %{y:.2f}s<extra></extra>' }\n";
  s += "  ], { ...plotlyLayout, title: 'In-flight vs Latency',\n";
  s += "    xaxis: { ...plotlyLayout.xaxis, title: 'Concurrent In-flight' },\n";
  s += "    yaxis: { ...plotlyLayout.yaxis, title: 'Latency (s)' } }, plotlyConfig);\n";
  s += "}\n";

  // Sweep: success rate
  s += "if (chartData.steadySweep) {\n";
  s += "  var sw = chartData.steadySweep;\n";
  s += "  Plotly.newPlot('sweepSuccessChart', [\n";
  s += "    { x: sw.map(function(d){return d.label}), y: sw.map(function(d){return d.successPct}),\n";
  s += "      type: 'scatter', mode: 'lines+markers', name: 'Success Rate',\n";
  s += "      line: { color: '" + C.success + "', width: 3 },\n";
  s += "      marker: { size: 10, color: sw.map(function(d){ return d.successPct >= 95 ? '" + C.success + "' : d.successPct >= 80 ? '" + C.warning + "' : '" + C.error + "'; }),\n";
  s += "        line: { color: '" + C.bg + "', width: 2 } },\n";
  s += "      hovertemplate: '%{x}<br>%{y:.1f}%<extra></extra>' }\n";
  s += "  ], { ...plotlyLayout, title: 'Success Rate vs Request Rate',\n";
  s += "    xaxis: { ...plotlyLayout.xaxis, title: 'Request Rate' },\n";
  s += "    yaxis: { ...plotlyLayout.yaxis, title: 'Success Rate (%)', range: [0, 105] } }, plotlyConfig);\n";
  s += "}\n";

  // Sweep: latency percentiles
  s += "if (chartData.steadySweep) {\n";
  s += "  var sw2 = chartData.steadySweep;\n";
  s += "  Plotly.newPlot('sweepLatencyChart', [\n";
  s += "    { x: sw2.map(function(d){return d.label}), y: sw2.map(function(d){return d.p50}),\n";
  s += "      type: 'scatter', mode: 'lines+markers', name: 'p50', line: { color: '" + C.success + "', width: 3 }, marker: { size: 8 } },\n";
  s += "    { x: sw2.map(function(d){return d.label}), y: sw2.map(function(d){return d.p95}),\n";
  s += "      type: 'scatter', mode: 'lines+markers', name: 'p95', line: { color: '" + C.warning + "', width: 2, dash: 'dash' }, marker: { size: 6 } },\n";
  s += "    { x: sw2.map(function(d){return d.label}), y: sw2.map(function(d){return d.p99}),\n";
  s += "      type: 'scatter', mode: 'lines+markers', name: 'p99', line: { color: '" + C.error + "', width: 1, dash: 'dot' }, marker: { size: 5 } }\n";
  s += "  ], { ...plotlyLayout, title: 'Latency Percentiles vs Request Rate',\n";
  s += "    xaxis: { ...plotlyLayout.xaxis, title: 'Request Rate' },\n";
  s += "    yaxis: { ...plotlyLayout.yaxis, title: 'Latency (s)' } }, plotlyConfig);\n";
  s += "}\n";

  // Node failures bar chart
  s += "if (chartData.nodeFailures) {\n";
  s += "  var nf = chartData.nodeFailures;\n";
  s += "  Plotly.newPlot('nodeFailureChart', [\n";
  s += "    { x: nf.labels, y: nf.timeouts, type: 'bar', name: 'Timeouts', marker: { color: '" + C.warning + "' },\n";
  s += "      text: nf.fullLabels, hovertemplate: '%{text}<br>Timeouts: %{y}<extra></extra>' },\n";
  s += "    { x: nf.labels, y: nf.otherErrors, type: 'bar', name: 'Other Errors', marker: { color: '" + C.error + "' },\n";
  s += "      text: nf.fullLabels, hovertemplate: '%{text}<br>Errors: %{y}<extra></extra>' }\n";
  s += "  ], { ...plotlyLayout, title: 'Per-Node Error Attribution', barmode: 'stack',\n";
  s += "    xaxis: { ...plotlyLayout.xaxis, title: 'Node' },\n";
  s += "    yaxis: { ...plotlyLayout.yaxis, title: 'Error Count' } }, plotlyConfig);\n";
  s += "}\n";

  s += "</script>\n";
  return s;
}

// =============================================================================
// CLI
// =============================================================================

function buildReportFilename(data: TestData): string {
  const ts = generateTimestamp();
  const mode = data.config.mode || "steady";
  const rate = data.config.rate + "rps";
  const dur = data.config.duration + "s";
  const cohort = data.config.cohortId !== undefined ? "c" + data.config.cohortId : "";
  const parts = [ts, mode, rate, dur, cohort].filter(Boolean);
  return parts.join("_") + ".html";
}

function saveReport(data: TestData, outputPath?: string): string {
  ensureResultsDirs();
  const html = generateReport(data);
  const filepath = outputPath || path.join(REPORTS_DIR, buildReportFilename(data));
  fs.writeFileSync(filepath, html);
  return filepath;
}

function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      latest: { type: "boolean" },
      output: { type: "string" },
    },
    strict: false,
    allowPositionals: true,
  });

  let dataPath: string | null = null;
  let outputPath = values.output as string | undefined;

  if (values.latest) {
    dataPath = getLatestDataFile();
    if (!dataPath) {
      console.error("Error: No data files found in results/data/");
      process.exit(1);
    }
  } else if (positionals.length > 0) {
    dataPath = positionals[0];
  }

  if (!dataPath) {
    console.log("Usage:");
    console.log("  npx tsx src/report.ts <data-file.json>");
    console.log("  npx tsx src/report.ts --latest");
    console.log("  npx tsx src/report.ts <data-file.json> --output=report.html");
    process.exit(1);
  }

  if (!fs.existsSync(dataPath)) {
    console.error("Error: File not found: " + dataPath);
    process.exit(1);
  }

  console.log("[taco-perf] Loading: " + dataPath);
  const data: TestData = JSON.parse(fs.readFileSync(dataPath, "utf-8"));
  const reportPath = saveReport(data, outputPath);
  console.log("[taco-perf] Report saved: " + reportPath);
}

main();
