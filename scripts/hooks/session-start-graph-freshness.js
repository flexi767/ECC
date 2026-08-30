#!/usr/bin/env node
/**
 * code-review-graph freshness surfacing (SessionStart)
 *
 * Cross-platform (Windows, macOS, Linux)
 *
 * The code-review-graph MCP tools (detect_changes, semantic_search_nodes,
 * get_impact_radius, ...) answer from a persistent index at
 * `<repo>/.code-review-graph/graph.db`. When that index lags the working tree
 * they return confidently-wrong guidance with no warning — e.g. reporting
 * newly-added tests as untested "test gaps", or failing to find files added
 * since the last build.
 *
 * At session start, if this repo uses code-review-graph and its index is stale
 * or missing, surface a heads-up so the session rebuilds before trusting graph
 * output. Stays silent for the common case (repos with no index at all).
 *
 * Never blocks: returns '' on every error, and prints nothing when the index
 * is fresh or absent.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { checkGraphFreshness, DAY_MS } = require('../lib/graph-freshness');

// Only surface when this repo actually uses code-review-graph. Most projects
// have no `.code-review-graph/` directory at all; warning there would be noise
// on every session start.
function graphInUse(dbPath) {
  try {
    return fs.existsSync(path.dirname(dbPath));
  } catch (_error) {
    return false;
  }
}

function buildWarning(report) {
  const lines = [];
  if (report.status === 'missing') {
    lines.push(
      '[GraphFreshness] code-review-graph is set up for this repo but its index (graph.db) is missing.'
    );
    lines.push(
      '  detect_changes / semantic_search / get_impact_radius have nothing to read.'
    );
  } else {
    const days = Number.isFinite(report.ageMs)
      ? Math.round(report.ageMs / DAY_MS)
      : '?';
    lines.push(
      `[GraphFreshness] code-review-graph index is STALE (~${days}d). ${report.reason}`
    );
    lines.push(
      '  detect_changes / semantic_search / get_impact_radius may be wrong: newly-added tests can show as gaps and new files are unfindable.'
    );
  }
  lines.push(`  ${report.remediation}`);
  return `${lines.join('\n')}\n`;
}

function run(rawInput, context = {}) {
  try {
    const cwd = context && context.cwd ? context.cwd : process.cwd();
    const report = checkGraphFreshness(cwd);
    if (report.status === 'fresh') {
      return '';
    }
    if (report.status === 'missing' && !graphInUse(report.dbPath)) {
      return '';
    }
    return buildWarning(report);
  } catch (_error) {
    // Never block session start on a freshness probe.
    return '';
  }
}

if (require.main === module) {
  try {
    const out = run('');
    if (out) {
      process.stdout.write(out);
    }
  } catch (_error) {
    // fail open
  }
  process.exit(0);
}

module.exports = { run, buildWarning, graphInUse };
