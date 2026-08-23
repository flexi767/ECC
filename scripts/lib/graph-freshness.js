'use strict';

/**
 * code-review-graph index freshness.
 *
 * The code-review-graph MCP server builds a persistent structural index at
 * `<repo>/.code-review-graph/graph.db`. Change-detection and search tools read
 * that index. When it falls behind the working tree, the guidance goes stale
 * silently — e.g. change-detection reports newly-added tests as "test gaps",
 * and semantic search cannot find files added since the last build.
 *
 * This module reports whether the index is FRESH, STALE, or MISSING so the CLI
 * / a session hook can warn before anyone trusts stale review output. It has no
 * knowledge of the graph's SQLite schema — it reasons purely from the index
 * build time (the db file mtime) versus repository signals.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STALE_AFTER_MS = 14 * DAY_MS;

function isNil(value) {
  return value === null || value === undefined;
}

/**
 * Pure freshness classifier — no I/O. Two independent signals:
 *
 *  1. High confidence: the newest source change is provably newer than the
 *     index build. The index cannot represent that change → STALE.
 *  2. Advisory backstop: the index is older than the freshness window. Rebased
 *     or imported history can carry commit timestamps that predate the build,
 *     so signal (1) can miss; an age ceiling catches indexes that quietly rot.
 *
 * @param {object} input
 * @param {number|null} input.graphMtimeMs  Index build time (db mtime), or null if absent.
 * @param {number|null} [input.sourceTimeMs] Newest source-change time (e.g. HEAD commit time).
 * @param {number|null} [input.nowMs]        Current time, for the age backstop.
 * @param {number} [input.staleAfterMs]      Age ceiling before the index is called stale.
 * @returns {{status:'missing'|'stale'|'fresh', ageMs:number|null, reason:string}}
 */
function classifyFreshness({
  graphMtimeMs,
  sourceTimeMs = null,
  nowMs = null,
  staleAfterMs = DEFAULT_STALE_AFTER_MS
} = {}) {
  if (!Number.isFinite(graphMtimeMs)) {
    return {
      status: 'missing',
      ageMs: null,
      reason: 'No code-review-graph index found for this repository.'
    };
  }

  if (Number.isFinite(sourceTimeMs) && sourceTimeMs > graphMtimeMs) {
    return {
      status: 'stale',
      ageMs: sourceTimeMs - graphMtimeMs,
      reason:
        'Repository source is newer than the graph index; changes since the ' +
        'last build are not represented.'
    };
  }

  if (
    Number.isFinite(nowMs) &&
    staleAfterMs > 0 &&
    nowMs - graphMtimeMs > staleAfterMs
  ) {
    return {
      status: 'stale',
      ageMs: nowMs - graphMtimeMs,
      reason: `Graph index is older than the ${Math.round(
        staleAfterMs / DAY_MS
      )}-day freshness window.`
    };
  }

  return {
    status: 'fresh',
    ageMs: Number.isFinite(nowMs) ? nowMs - graphMtimeMs : null,
    reason: 'Graph index reflects the current repository state.'
  };
}

/**
 * Resolve the graph db path for a repo. Honours the code-review-graph
 * `CRG_DATA_DIR` override and an `ECC_GRAPH_DB_PATH` full-path override;
 * otherwise defaults to the repo-local `.code-review-graph/graph.db`.
 */
function resolveGraphDbPath(repoRoot, env = process.env) {
  if (env && env.ECC_GRAPH_DB_PATH) {
    return path.resolve(env.ECC_GRAPH_DB_PATH);
  }
  const root = repoRoot ? path.resolve(repoRoot) : process.cwd();
  const dataDir =
    env && env.CRG_DATA_DIR
      ? path.resolve(env.CRG_DATA_DIR)
      : path.join(root, '.code-review-graph');
  return path.join(dataDir, 'graph.db');
}

/** Index build time as the db file mtime in ms, or null if the file is absent. */
function getGraphMtimeMs(dbPath) {
  try {
    const stat = fs.statSync(dbPath);
    return stat.isFile() ? stat.mtimeMs : null;
  } catch (_error) {
    return null;
  }
}

/** Newest committed source time (HEAD commit time) in ms, or null on failure. */
function getRepoHeadTimeMs(repoRoot) {
  try {
    const result = spawnSync(
      'git',
      ['-C', repoRoot || process.cwd(), 'log', '-1', '--format=%ct'],
      { encoding: 'utf8', timeout: 5000 }
    );
    if (result.status !== 0 || !result.stdout) {
      return null;
    }
    const seconds = Number(result.stdout.trim());
    return Number.isFinite(seconds) ? seconds * 1000 : null;
  } catch (_error) {
    return null;
  }
}

const REMEDIATION =
  'Rebuild the index: call build_or_update_graph_tool (code-review-graph MCP), ' +
  'or run the code-review-graph CLI build for this repository.';

/**
 * Full freshness report for a repo. All I/O inputs can be injected via options
 * (dbPath, graphMtimeMs, sourceTimeMs, nowMs, staleAfterMs, env) for testing.
 */
function checkGraphFreshness(repoRoot, options = {}) {
  const env = options.env || process.env;
  const root = repoRoot ? path.resolve(repoRoot) : process.cwd();
  const dbPath = options.dbPath
    ? path.resolve(options.dbPath)
    : resolveGraphDbPath(root, env);
  const graphMtimeMs = isNil(options.graphMtimeMs)
    ? getGraphMtimeMs(dbPath)
    : options.graphMtimeMs;
  const sourceTimeMs = isNil(options.sourceTimeMs)
    ? getRepoHeadTimeMs(root)
    : options.sourceTimeMs;
  const nowMs = isNil(options.nowMs) ? Date.now() : options.nowMs;
  const staleAfterMs = isNil(options.staleAfterMs)
    ? DEFAULT_STALE_AFTER_MS
    : options.staleAfterMs;

  const verdict = classifyFreshness({
    graphMtimeMs,
    sourceTimeMs,
    nowMs,
    staleAfterMs
  });

  return {
    status: verdict.status,
    reason: verdict.reason,
    ageMs: verdict.ageMs,
    repoRoot: root,
    dbPath,
    graphMtimeMs: isNil(graphMtimeMs) ? null : graphMtimeMs,
    sourceTimeMs: isNil(sourceTimeMs) ? null : sourceTimeMs,
    nowMs,
    staleAfterMs,
    remediation: verdict.status === 'fresh' ? null : REMEDIATION
  };
}

module.exports = {
  DAY_MS,
  DEFAULT_STALE_AFTER_MS,
  REMEDIATION,
  classifyFreshness,
  resolveGraphDbPath,
  getGraphMtimeMs,
  getRepoHeadTimeMs,
  checkGraphFreshness
};
