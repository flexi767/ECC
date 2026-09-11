'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  DAY_MS,
  classifyFreshness,
  resolveGraphDbPath,
  getGraphMtimeMs,
  getRepoHeadTimeMs,
  checkGraphFreshness
} = require('../../scripts/lib/graph-freshness');

// Minimal, isolated git repo in a temp dir (no network, no shared config).
function makeGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-freshness-git-'));
  const git = (...args) =>
    spawnSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t'
      }
    });
  git('init', '-q');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'x');
  git('add', 'f.txt');
  git('commit', '-q', '-m', 'init');
  return { dir, git };
}

function gitAvailable() {
  try {
    return spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
  } catch (_error) {
    return false;
  }
}

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

function runTests() {
  console.log('\n=== Testing graph-freshness.js ===\n');

  let passed = 0;
  let failed = 0;

  if (test('classifyFreshness reports missing when no index exists', () => {
    const result = classifyFreshness({ graphMtimeMs: null });
    assert.strictEqual(result.status, 'missing');
    assert.strictEqual(result.ageMs, null);
  })) passed++; else failed++;

  if (test('classifyFreshness is stale when source is newer than the index', () => {
    const graphMtimeMs = 1000 * DAY_MS;
    const result = classifyFreshness({
      graphMtimeMs,
      sourceTimeMs: graphMtimeMs + 60_000,
      nowMs: graphMtimeMs + 60_000
    });
    assert.strictEqual(result.status, 'stale');
    assert.strictEqual(result.ageMs, 60_000);
    assert.match(result.reason, /newer than the graph index/);
  })) passed++; else failed++;

  if (test('classifyFreshness is stale by age even when source predates the build', () => {
    const graphMtimeMs = 1000 * DAY_MS;
    // Source commit is OLDER than the build (rebased history), but the index
    // itself has aged past the freshness window.
    const result = classifyFreshness({
      graphMtimeMs,
      sourceTimeMs: graphMtimeMs - 5 * DAY_MS,
      nowMs: graphMtimeMs + 30 * DAY_MS,
      staleAfterMs: 14 * DAY_MS
    });
    assert.strictEqual(result.status, 'stale');
    assert.match(result.reason, /freshness window/);
  })) passed++; else failed++;

  if (test('classifyFreshness is fresh when index is recent and ahead of source', () => {
    const graphMtimeMs = 1000 * DAY_MS;
    const result = classifyFreshness({
      graphMtimeMs,
      sourceTimeMs: graphMtimeMs - 2 * DAY_MS,
      nowMs: graphMtimeMs + 1 * DAY_MS,
      staleAfterMs: 14 * DAY_MS
    });
    assert.strictEqual(result.status, 'fresh');
  })) passed++; else failed++;

  if (test('classifyFreshness prefers the high-confidence source signal over age', () => {
    const graphMtimeMs = 1000 * DAY_MS;
    // Both signals fire; the source-newer reason should win.
    const result = classifyFreshness({
      graphMtimeMs,
      sourceTimeMs: graphMtimeMs + 100 * DAY_MS,
      nowMs: graphMtimeMs + 100 * DAY_MS,
      staleAfterMs: 14 * DAY_MS
    });
    assert.strictEqual(result.status, 'stale');
    assert.match(result.reason, /newer than the graph index/);
  })) passed++; else failed++;

  if (test('resolveGraphDbPath defaults to repo-local .code-review-graph/graph.db', () => {
    const dbPath = resolveGraphDbPath('/tmp/some-repo', {});
    assert.strictEqual(
      dbPath,
      path.join('/tmp/some-repo', '.code-review-graph', 'graph.db')
    );
  })) passed++; else failed++;

  if (test('resolveGraphDbPath honours ECC_GRAPH_DB_PATH override', () => {
    const dbPath = resolveGraphDbPath('/tmp/some-repo', {
      ECC_GRAPH_DB_PATH: '/custom/graph.db'
    });
    assert.strictEqual(dbPath, path.resolve('/custom/graph.db'));
  })) passed++; else failed++;

  if (test('resolveGraphDbPath honours CRG_DATA_DIR override', () => {
    const dbPath = resolveGraphDbPath('/tmp/some-repo', {
      CRG_DATA_DIR: '/data/crg'
    });
    assert.strictEqual(dbPath, path.join(path.resolve('/data/crg'), 'graph.db'));
  })) passed++; else failed++;

  if (test('getGraphMtimeMs returns mtime for a real file and null when absent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-freshness-'));
    try {
      const filePath = path.join(dir, 'graph.db');
      fs.writeFileSync(filePath, 'x');
      const mtime = getGraphMtimeMs(filePath);
      assert.ok(Number.isFinite(mtime) && mtime > 0);
      assert.strictEqual(getGraphMtimeMs(path.join(dir, 'missing.db')), null);
      // A zero-byte (aborted/truncated) build is not a usable index.
      const emptyPath = path.join(dir, 'empty.db');
      fs.writeFileSync(emptyPath, '');
      assert.strictEqual(getGraphMtimeMs(emptyPath), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('checkGraphFreshness attaches remediation when stale, omits it when fresh', () => {
    const base = 1000 * DAY_MS;
    const stale = checkGraphFreshness('/tmp/repo', {
      graphMtimeMs: base,
      sourceTimeMs: base + DAY_MS,
      nowMs: base + DAY_MS
    });
    assert.strictEqual(stale.status, 'stale');
    assert.ok(stale.remediation && stale.remediation.includes('build_or_update_graph_tool'));

    const fresh = checkGraphFreshness('/tmp/repo', {
      graphMtimeMs: base,
      sourceTimeMs: base - DAY_MS,
      nowMs: base + DAY_MS,
      staleAfterMs: 14 * DAY_MS
    });
    assert.strictEqual(fresh.status, 'fresh');
    assert.strictEqual(fresh.remediation, null);
  })) passed++; else failed++;

  if (test('checkGraphFreshness reports missing for a repo with no index', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-freshness-'));
    try {
      const report = checkGraphFreshness(dir, { sourceTimeMs: null, nowMs: Date.now() });
      assert.strictEqual(report.status, 'missing');
      assert.ok(report.dbPath.endsWith(path.join('.code-review-graph', 'graph.db')));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('checkGraphFreshness treats a zero-byte graph.db as missing, not a false fresh', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-freshness-'));
    try {
      fs.mkdirSync(path.join(dir, '.code-review-graph'));
      fs.writeFileSync(path.join(dir, '.code-review-graph', 'graph.db'), '');
      const report = checkGraphFreshness(dir, { sourceTimeMs: null, nowMs: Date.now() });
      assert.strictEqual(report.status, 'missing');
      assert.ok(report.remediation);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  // Real-git coverage for the high-confidence "source newer than index" signal.
  // The rest of the suite injects sourceTimeMs; this exercises the actual
  // getRepoHeadTimeMs success path end-to-end.
  if (gitAvailable()) {
    if (test('getRepoHeadTimeMs returns HEAD commit time for a real repo', () => {
      const { dir } = makeGitRepo();
      try {
        const headMs = getRepoHeadTimeMs(dir);
        assert.ok(Number.isFinite(headMs) && headMs > 0);
        // Commit was just made; its time is within a generous window of now.
        assert.ok(Math.abs(Date.now() - headMs) < 10 * 60 * 1000);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    })) passed++; else failed++;

    if (test('checkGraphFreshness flags STALE when a real commit post-dates the index', () => {
      const { dir } = makeGitRepo();
      try {
        // Build a graph.db whose mtime predates HEAD by ~1 day.
        const graphDir = path.join(dir, '.code-review-graph');
        fs.mkdirSync(graphDir);
        const dbPath = path.join(graphDir, 'graph.db');
        fs.writeFileSync(dbPath, 'x');
        const headMs = getRepoHeadTimeMs(dir);
        const when = (headMs - DAY_MS) / 1000;
        fs.utimesSync(dbPath, when, when);

        // No injected sourceTimeMs: this uses the real getRepoHeadTimeMs path.
        const report = checkGraphFreshness(dir, { nowMs: headMs });
        assert.strictEqual(report.status, 'stale');
        assert.match(report.reason, /newer than the graph index/);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    })) passed++; else failed++;
  } else {
    console.log('  - (skipped git-backed tests: git not available)');
  }

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
