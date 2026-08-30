'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseArgs,
  usage,
  formatAge,
  formatHumanReport,
  main
} = require('../scripts/graph-freshness');

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

// Run main() with stdout captured so the suite output stays clean.
function runMain(argv) {
  const original = process.stdout.write;
  let out = '';
  process.stdout.write = (chunk) => {
    out += chunk;
    return true;
  };
  try {
    const code = main(['node', 'graph-freshness.js', ...argv]);
    return { code, out };
  } finally {
    process.stdout.write = original;
  }
}

function runTests() {
  console.log('\n=== Testing graph-freshness CLI ===\n');

  let passed = 0;
  let failed = 0;

  if (test('parseArgs reads flags, --repo, and --stale-after-days (both forms)', () => {
    const a = parseArgs(['node', 'cli', '--json', '--strict', '--repo', '/x', '--stale-after-days', '7']);
    assert.strictEqual(a.json, true);
    assert.strictEqual(a.strict, true);
    assert.strictEqual(a.repo, '/x');
    assert.strictEqual(a.staleAfterMs, 7 * DAY_MS);

    const b = parseArgs(['node', 'cli', '--repo=/y', '--stale-after-days=3']);
    assert.strictEqual(b.repo, '/y');
    assert.strictEqual(b.staleAfterMs, 3 * DAY_MS);

    const c = parseArgs(['node', 'cli', '-h']);
    assert.strictEqual(c.help, true);
  })) passed++; else failed++;

  if (test('parseArgs ignores a non-numeric --stale-after-days', () => {
    const a = parseArgs(['node', 'cli', '--stale-after-days', 'abc']);
    assert.strictEqual(a.staleAfterMs, undefined);
  })) passed++; else failed++;

  if (test('usage mentions the command and key options', () => {
    const text = usage();
    assert.match(text, /graph-freshness/);
    assert.match(text, /--strict/);
  })) passed++; else failed++;

  if (test('formatAge renders days, hours, and unknown', () => {
    assert.match(formatAge(2 * DAY_MS), /2\.0 day/);
    assert.match(formatAge(3 * 60 * 60 * 1000), /3\.0 hour/);
    assert.strictEqual(formatAge(null), 'unknown');
  })) passed++; else failed++;

  if (test('formatHumanReport shows label and the fix line when stale', () => {
    const text = formatHumanReport({
      status: 'stale',
      repoRoot: '/r',
      dbPath: '/r/.code-review-graph/graph.db',
      ageMs: 20 * DAY_MS,
      reason: 'old',
      remediation: 'rebuild it'
    });
    assert.match(text, /STALE/);
    assert.match(text, /fix:\s+rebuild it/);
  })) passed++; else failed++;

  if (test('formatHumanReport omits the fix line when fresh', () => {
    const text = formatHumanReport({
      status: 'fresh',
      repoRoot: '/r',
      dbPath: '/r/.code-review-graph/graph.db',
      ageMs: DAY_MS,
      reason: 'ok',
      remediation: null
    });
    assert.match(text, /FRESH/);
    assert.ok(!/fix:/.test(text));
  })) passed++; else failed++;

  if (test('main --help prints usage and returns 0', () => {
    const { code, out } = runMain(['--help']);
    assert.strictEqual(code, 0);
    assert.match(out, /Usage: graph-freshness/);
  })) passed++; else failed++;

  if (test('main returns 0 non-strict and 1 --strict for a repo with no index', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-freshness-cli-'));
    try {
      const lenient = runMain(['--repo', dir]);
      assert.strictEqual(lenient.code, 0);
      assert.match(lenient.out, /MISSING/);

      const strict = runMain(['--repo', dir, '--strict']);
      assert.strictEqual(strict.code, 1);

      const asJson = runMain(['--repo', dir, '--json']);
      const parsed = JSON.parse(asJson.out);
      assert.strictEqual(parsed.status, 'missing');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
