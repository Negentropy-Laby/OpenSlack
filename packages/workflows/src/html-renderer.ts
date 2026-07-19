import type { RunStatus, PhaseCheckpoint } from './types.js';
import { redactRunBundle } from './redact.js';
import type { RedactionOptions } from './redact.js';

// ── HTML Renderer ────────────────────────────────────────────────────────────
//
// Generates a self-contained HTML document for workflow run inspection.
// Key security properties:
// - Content Security Policy meta tag restricting inline scripts
// - All user data is XSS-escaped before embedding
// - Inline CSS (no external stylesheets)
// - No JavaScript in the output document
// - Raw run data never reaches the template without passing through redaction

/**
 * Escape HTML special characters to prevent XSS.
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Escape a value for safe embedding in a JSON string inside an HTML attribute
 * or script tag. This handles the full JSON-in-HTML attack surface.
 */
export function escapeJsonInHtml(value: unknown): string {
  const json = JSON.stringify(value, null, 0);
  return escapeHtml(json);
}

/**
 * Format a duration between two ISO timestamp strings.
 */
function formatDuration(startIso: string, endIso: string): string {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'N/A';
  const diffMs = end - start;
  if (diffMs < 1000) return `${diffMs}ms`;
  if (diffMs < 60000) return `${(diffMs / 1000).toFixed(1)}s`;
  const minutes = Math.floor(diffMs / 60000);
  const seconds = Math.floor((diffMs % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/**
 * Format an ISO timestamp for display.
 */
function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short',
    });
  } catch {
    return iso;
  }
}

/**
 * Generate inline CSS for the HTML artifact.
 */
function getInlineCss(): string {
  return `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      font-size: 14px;
      line-height: 1.6;
      color: #1a1a1a;
      background: #ffffff;
      padding: 24px;
      max-width: 960px;
      margin: 0 auto;
    }
    h1 { font-size: 22px; font-weight: 600; margin-bottom: 16px; color: #111; }
    h2 { font-size: 17px; font-weight: 600; margin-top: 24px; margin-bottom: 12px; color: #333; border-bottom: 1px solid #e0e0e0; padding-bottom: 4px; }
    h3 { font-size: 15px; font-weight: 600; margin-top: 16px; margin-bottom: 8px; color: #444; }
    .meta { color: #666; font-size: 13px; margin-bottom: 16px; }
    .meta span { margin-right: 16px; }
    .status-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .status-running { background: #fff3cd; color: #856404; }
    .status-completed { background: #d4edda; color: #155724; }
    .status-failed { background: #f8d7da; color: #721c24; }
    .status-paused { background: #cce5ff; color: #004085; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
    th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #e0e0e0; font-size: 13px; }
    th { background: #f8f9fa; font-weight: 600; color: #555; }
    tr:hover { background: #fafbfc; }
    pre { background: #f6f8fa; border: 1px solid #e1e4e8; border-radius: 6px; padding: 12px; overflow-x: auto; font-size: 12px; line-height: 1.5; }
    code { font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; }
    .phase-status-completed { color: #155724; }
    .phase-status-failed { color: #721c24; }
    .phase-status-skipped { color: #6c757d; }
    .footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #e0e0e0; font-size: 12px; color: #888; }
  `.trim();
}

/**
 * Generate the CSP meta tag content.
 */
function getCspContent(): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "img-src 'none'",
    "script-src 'none'",
    "font-src 'none'",
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "media-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/**
 * Render the status badge HTML.
 */
function renderStatusBadge(status: string): string {
  const cssClass = `status-${status}`;
  return `<span class="status-badge ${escapeHtml(cssClass)}">${escapeHtml(status)}</span>`;
}

/**
 * Render phases as an HTML table.
 */
function renderPhasesTable(phases: PhaseCheckpoint[]): string {
  if (!phases || phases.length === 0) {
    return '<p><em>No phases recorded.</em></p>';
  }

  let html =
    '<table><thead><tr><th>Phase</th><th>Status</th><th>Timestamp</th><th>Cache Key</th></tr></thead><tbody>';

  for (const phase of phases) {
    const statusClass = `phase-status-${phase.status}`;
    html += '<tr>';
    html += `<td><code>${escapeHtml(phase.phase)}</code></td>`;
    html += `<td class="${escapeHtml(statusClass)}">${escapeHtml(phase.status)}</td>`;
    html += `<td>${escapeHtml(formatTimestamp(phase.timestamp))}</td>`;
    html += `<td>${phase.cacheKey ? escapeHtml(phase.cacheKey) : '<em>-</em>'}</td>`;
    html += '</tr>';
  }

  html += '</tbody></table>';
  return html;
}

/**
 * Render output data as a formatted pre block.
 */
function renderOutput(output: unknown): string {
  if (output === null || output === undefined) {
    return '<p><em>No output recorded.</em></p>';
  }

  const json = JSON.stringify(output, null, 2);
  return `<pre><code>${escapeHtml(json)}</code></pre>`;
}

/**
 * Render log entries as a table.
 */
function renderLogTable(logEntries: Array<Record<string, unknown>> | undefined): string {
  if (!logEntries || logEntries.length === 0) {
    return '<p><em>No log entries recorded.</em></p>';
  }

  let html =
    '<table><thead><tr><th>Timestamp</th><th>Phase</th><th>Message</th></tr></thead><tbody>';

  for (const entry of logEntries) {
    html += '<tr>';
    html += `<td>${escapeHtml(String(entry.ts ?? ''))}</td>`;
    html += `<td>${escapeHtml(String(entry.phase ?? '-'))}</td>`;
    html += `<td>${escapeHtml(String(entry.message ?? ''))}</td>`;
    html += '</tr>';
  }

  html += '</tbody></table>';
  return html;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Options for HTML rendering.
 */
export interface HtmlRenderOptions extends RedactionOptions {
  /** Whether to include the raw JSON output section. Default: true. */
  includeOutput?: boolean;
  /** Whether to include log entries. Default: true. */
  includeLog?: boolean;
}

/**
 * Render a complete workflow run as a self-contained HTML document.
 *
 * The output is a single HTML file with:
 * - CSP meta tag (no scripts, no external resources)
 * - Inline CSS
 * - XSS-escaped data
 * - All run data passed through the redaction layer first
 */
export function renderRunHtml(
  status: RunStatus,
  phases: PhaseCheckpoint[],
  logEntries: Array<Record<string, unknown>>,
  output: unknown,
  options?: HtmlRenderOptions,
): string {
  const opts: HtmlRenderOptions = {
    includeOutput: true,
    includeLog: true,
    ...options,
  };

  // Redact all data before rendering
  const redacted = redactRunBundle({ status, phases, logEntries, output }, opts);

  // Type the redacted data for rendering
  const redactedStatus = redacted.data as {
    status: Record<string, unknown>;
    phases: unknown[];
    logEntries?: unknown[];
    output?: unknown;
  };
  const rStatus = redactedStatus.status as unknown as RunStatus;
  const rPhases = redactedStatus.phases as unknown as PhaseCheckpoint[];
  const rLog = redactedStatus.logEntries as Array<Record<string, unknown>> | undefined;
  const rOutput = redactedStatus.output;

  // Build HTML
  const duration =
    rStatus.startedAt && rStatus.updatedAt
      ? formatDuration(rStatus.startedAt, rStatus.updatedAt)
      : 'N/A';

  let body = '';

  // Header
  body += `<h1>Workflow Run: ${escapeHtml(rStatus.runId)}</h1>`;

  // Meta info
  body += '<div class="meta">';
  body += `<span>Workflow: <strong>${escapeHtml(rStatus.workflowName)}</strong></span>`;
  body += `<span>Mode: <code>${escapeHtml(rStatus.mode)}</code></span>`;
  body += `<span>Status: ${renderStatusBadge(rStatus.status)}</span>`;
  body += '</div>';

  // Timing
  body += '<div class="meta">';
  body += `<span>Started: ${escapeHtml(formatTimestamp(rStatus.startedAt))}</span>`;
  body += `<span>Updated: ${escapeHtml(formatTimestamp(rStatus.updatedAt))}</span>`;
  body += `<span>Duration: ${escapeHtml(duration)}</span>`;
  if (rStatus.currentPhase) {
    body += `<span>Current Phase: <code>${escapeHtml(rStatus.currentPhase)}</code></span>`;
  }
  body += '</div>';

  // Phases
  body += '<h2>Phases</h2>';
  body += renderPhasesTable(rPhases);

  // Log entries
  if (opts.includeLog) {
    body += '<h2>Log Entries</h2>';
    body += renderLogTable(rLog);
  }

  // Output
  if (opts.includeOutput) {
    body += '<h2>Output</h2>';
    body += renderOutput(rOutput);
  }

  // Footer
  body += '<div class="footer">';
  body +=
    '<p>Generated by OpenSlack workflow inspector. All data has been redacted for security.</p>';
  body += `<p>Rendered at ${escapeHtml(new Date().toISOString())}</p>`;
  body += '</div>';

  // Assemble full document
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${getCspContent()}">
  <title>Workflow Run: ${escapeHtml(rStatus.runId)}</title>
  <style>${getInlineCss()}</style>
</head>
<body>
${body}
</body>
</html>`;
}

/**
 * Render run data as JSON (redacted).
 */
export function renderRunJson(
  status: RunStatus,
  phases: PhaseCheckpoint[],
  logEntries: Array<Record<string, unknown>>,
  output: unknown,
  options?: RedactionOptions,
): string {
  const redacted = redactRunBundle({ status, phases, logEntries, output }, options);
  return JSON.stringify(redacted.data, null, 2);
}

/**
 * Render run data as Markdown (redacted).
 */
export function renderRunMarkdown(
  status: RunStatus,
  phases: PhaseCheckpoint[],
  logEntries: Array<Record<string, unknown>>,
  output: unknown,
  options?: RedactionOptions,
): string {
  const redacted = redactRunBundle({ status, phases, logEntries, output }, options);

  const rStatus = (redacted.data as Record<string, unknown>).status as unknown as RunStatus;
  const rPhases = (redacted.data as Record<string, unknown>).phases as unknown as PhaseCheckpoint[];
  const rLog = (redacted.data as Record<string, unknown>).logEntries as
    | Array<Record<string, unknown>>
    | undefined;
  const rOutput = (redacted.data as Record<string, unknown>).output;

  const duration =
    rStatus.startedAt && rStatus.updatedAt
      ? formatDuration(rStatus.startedAt, rStatus.updatedAt)
      : 'N/A';

  let md = '';
  md += `# Workflow Run: ${rStatus.runId}\n\n`;
  md += `- **Workflow:** ${rStatus.workflowName}\n`;
  md += `- **Mode:** ${rStatus.mode}\n`;
  md += `- **Status:** ${rStatus.status}\n`;
  md += `- **Started:** ${formatTimestamp(rStatus.startedAt)}\n`;
  md += `- **Updated:** ${formatTimestamp(rStatus.updatedAt)}\n`;
  md += `- **Duration:** ${duration}\n`;
  if (rStatus.currentPhase) {
    md += `- **Current Phase:** ${rStatus.currentPhase}\n`;
  }
  md += '\n';

  // Phases table
  md += '## Phases\n\n';
  if (rPhases.length === 0) {
    md += '_No phases recorded._\n\n';
  } else {
    md += '| Phase | Status | Timestamp | Cache Key |\n';
    md += '|-------|--------|-----------|----------|\n';
    for (const phase of rPhases) {
      md += `| ${phase.phase} | ${phase.status} | ${formatTimestamp(phase.timestamp)} | ${phase.cacheKey ?? '-'} |\n`;
    }
    md += '\n';
  }

  // Log entries
  if (rLog && rLog.length > 0) {
    md += '## Log Entries\n\n';
    md += '| Timestamp | Phase | Message |\n';
    md += '|-----------|-------|--------|\n';
    for (const entry of rLog) {
      md += `| ${entry.ts ?? ''} | ${entry.phase ?? '-'} | ${entry.message ?? ''} |\n`;
    }
    md += '\n';
  }

  // Output
  if (rOutput !== null && rOutput !== undefined) {
    md += '## Output\n\n';
    md += '```json\n';
    md += JSON.stringify(rOutput, null, 2);
    md += '\n```\n\n';
  }

  md += '---\n\n';
  md += `_Generated by OpenSlack workflow inspector at ${new Date().toISOString()}_\n`;

  return md;
}
