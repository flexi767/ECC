'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  run,
  buildWarning,
  graphInUse
} = require('../../scripts/hooks/session-start-graph-freshness');

const DAY_MS = 24 * 60 * 60 * 1000;

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

// Build a throwaway repo dir; optionally create the graph dir and db, and
// optionally backdate the db mtime to force staleness.
function makeRepo({ withGraphDir = false, withDb = false, dbAgeDays = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-graph-fresh-'));
  if (withGraphDir) {
    const graphDir = path.join(dir, '.code-review-graph');
    fs.mkdirSync(graphDir);
    if (withDb) {
      const dbPath = path.join(graphDir, 'graph.db');
      fs.writeFileSync(dbPath, 'x');
      if (dbAgeDays > 0) {
        const when = (Date.now() - dbAgeDays * DAY_MS) / 1000;
        fs.utimesSync(dbPath, when, when);
      }
    }
  }
  return dir;
}

function runTests() {
  console.log('\n=== Testing session-start-graph-freshness.js ===\n');

  let passed = 0;
  let failed = 0;

  if (test('buildWarning (stale) names the tools and the fix', () => {
    const text = buildWarning({
      status: 'stale',
      ageMs: 30 * DAY_MS,
      reason: 'Graph index is older than the 14-day freshness window.',
      remediation: 'Rebuild the index: call build_or_update_graph_tool ...'
    });
    assert.match(text, /STALE \(~30d\)/);
    assert.match(text, /detect_changes/);
    assert.match(text, /build_or_update_graph_tool/);
  })) passed++; else failed++;

  if (test('buildWarning (missing) explains the index is gone', () => {
    const text = buildWarning({
      status: 'missing',
      ageMs: null,
      reason: 'No code-review-graph index found for this repository.',
      remediation: 'Rebuild the index ...'
    });
    assert.match(text, /index \(graph\.db\) is missing/);
    assert.match(text, /Rebuild the index/);
  })) passed++; else failed++;

  if (test('graphInUse reflects whether the graph directory exists', () => {
    const withDir = makeRepo({ withGraphDir: true });
    const withoutDir = makeRepo({ withGraphDir: false });
    try {
      assert.strictEqual(graphInUse(path.join(withDir, '.code-review-graph', 'graph.db')), true);
      assert.strictEqual(graphInUse(path.join(withoutDir, '.code-review-graph', 'graph.db')), false);
    } finally {
      fs.rmSync(withDir, { recursive: true, force: true });
      fs.rmSync(withoutDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('run stays silent for a repo with no code-review-graph', () => {
    const dir = makeRepo({ withGraphDir: false });
    try {
      assert.strictEqual(run('', { cwd: dir }), '');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('run stays silent for a fresh index', () => {
    const dir = makeRepo({ withGraphDir: true, withDb: true, dbAgeDays: 0 });
    try {
      assert.strictEqual(run('', { cwd: dir }), '');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('run warns STALE for an aged index', () => {
    const dir = makeRepo({ withGraphDir: true, withDb: true, dbAgeDays: 30 });
    try {
      const out = run('', { cwd: dir });
      assert.match(out, /STALE/);
      assert.match(out, /Rebuild the index/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('run warns MISSING when the graph dir exists but the db is gone', () => {
    const dir = makeRepo({ withGraphDir: true, withDb: false });
    try {
      const out = run('', { cwd: dir });
      assert.match(out, /missing/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('run never throws — returns empty string on a bogus cwd', () => {
    assert.strictEqual(run('', { cwd: path.join(os.tmpdir(), 'does-not-exist-xyz-123') }), '');
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
