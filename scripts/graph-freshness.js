#!/usr/bin/env node
'use strict';

/**
 * CLI: report whether the code-review-graph index is fresh for a repository.
 *
 * The code-review-graph MCP tools (detect_changes, semantic_search, …) read a
 * persistent index that goes stale silently. This surfaces the staleness so an
 * operator — or a session-start hook / CI step — knows to rebuild before
 * trusting review output.
 *
 * Exit codes: 0 always, unless --strict is passed, in which case a stale or
 * missing index exits 1 (for gating a hook or CI step).
 */

const { checkGraphFreshness, DAY_MS } = require('./lib/graph-freshness');

function parseArgs(argv = process.argv) {
  const args = argv.slice(2);
  const options = {
    repo: process.cwd(),
    json: false,
    strict: false,
    help: false,
    staleAfterMs: undefined
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--strict') {
      options.strict = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--repo') {
      options.repo = args[i + 1] || options.repo;
      i += 1;
    } else if (arg.startsWith('--repo=')) {
      options.repo = arg.slice('--repo='.length) || options.repo;
    } else if (arg === '--stale-after-days') {
      const days = Number(args[i + 1]);
      if (Number.isFinite(days) && days >= 0) options.staleAfterMs = days * DAY_MS;
      i += 1;
    } else if (arg.startsWith('--stale-after-days=')) {
      const days = Number(arg.slice('--stale-after-days='.length));
      if (Number.isFinite(days) && days >= 0) options.staleAfterMs = days * DAY_MS;
    }
  }

  return options;
}

function usage() {
  return [
    'Usage: graph-freshness [options]',
    '',
    'Report whether the code-review-graph index for a repository is fresh,',
    'stale, or missing, so stale change-detection / search output is caught',
    'before it is trusted.',
    '',
    'Options:',
    '  --repo <path>              Repository root (default: current directory)',
    '  --stale-after-days <n>     Age ceiling before the index is called stale',
    '                             (default: 14)',
    '  --json                     Print the full report as JSON',
    '  --strict                   Exit 1 when the index is stale or missing',
    '  -h, --help                 Show this help'
  ].join('\n');
}

function formatAge(ageMs) {
  if (!Number.isFinite(ageMs)) return 'unknown';
  const days = ageMs / DAY_MS;
  if (days >= 1) return `${days.toFixed(1)} day(s)`;
  const hours = ageMs / (60 * 60 * 1000);
  return `${hours.toFixed(1)} hour(s)`;
}

function formatHumanReport(report) {
  const label = { fresh: 'FRESH', stale: 'STALE', missing: 'MISSING' }[report.status];
  const lines = [
    `code-review-graph index: ${label}`,
    `  repo:  ${report.repoRoot}`,
    `  db:    ${report.dbPath}`,
    `  age:   ${formatAge(report.ageMs)}`,
    `  why:   ${report.reason}`
  ];
  if (report.remediation) {
    lines.push(`  fix:   ${report.remediation}`);
  }
  return lines.join('\n');
}

function main(argv = process.argv) {
  const options = parseArgs(argv);

  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const report = checkGraphFreshness(options.repo, {
    staleAfterMs: options.staleAfterMs
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatHumanReport(report)}\n`);
  }

  if (options.strict && report.status !== 'fresh') {
    return 1;
  }
  return 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { parseArgs, usage, formatAge, formatHumanReport, main };
