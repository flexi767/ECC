# code-review-graph index freshness

The `code-review-graph` MCP server builds a persistent structural index at
`<repo>/.code-review-graph/graph.db`. Its review tools — `detect_changes`,
`get_impact_radius`, `semantic_search_nodes`, `get_review_context` — read that
index rather than re-parsing the working tree on every call.

That is what makes the tools fast. It is also a silent failure mode: when the
index falls behind the working tree, the tools keep answering **confidently
from stale data**. Observed symptoms:

- `detect_changes` reports newly-added tests as **untested "test gaps"**, because
  the `TESTED_BY` edges predate the new test files.
- `semantic_search_nodes` returns **nothing** for files added since the last
  build (and silently falls back to keyword mode when no embeddings exist).
- `get_impact_radius` computes blast radius from an outdated call graph.

Nothing in the MCP/CLI workflow surfaced this, so an operator had no signal that
the index was stale before trusting its output.

## Freshness check

`scripts/graph-freshness.js` reports whether the index for a repository is
`FRESH`, `STALE`, or `MISSING`. It never opens the SQLite database; it reasons
purely from the index build time (the `graph.db` file mtime) against two repo
signals.

```bash
node scripts/graph-freshness.js --repo /path/to/repo
```

```text
code-review-graph index: STALE
  repo:  /path/to/repo
  db:    /path/to/repo/.code-review-graph/graph.db
  age:   31.7 day(s)
  why:   Graph index is older than the 14-day freshness window.
  fix:   Rebuild the index: call build_or_update_graph_tool (code-review-graph MCP), ...
```

### Options

| Option | Meaning |
| --- | --- |
| `--repo <path>` | Repository root (default: current directory). |
| `--stale-after-days <n>` | Age ceiling before the index is called stale (default: 14). |
| `--json` | Print the full report as JSON. |
| `--strict` | Exit `1` when the index is stale or missing (for a hook or CI gate). |
| `-h`, `--help` | Show help. |

Without `--strict` the CLI always exits `0`, so it is safe to drop into a
session-start hook that only warns.

### Environment overrides

- `ECC_GRAPH_DB_PATH` — full path to the index database (highest precedence).
- `CRG_DATA_DIR` — the code-review-graph data directory; the index is expected at
  `<CRG_DATA_DIR>/graph.db`.

Otherwise the repo-local `<repo>/.code-review-graph/graph.db` is used.

## Automatic warning at session start

Running the CLI by hand only helps if you remember to. The `SessionStart` hook
`scripts/hooks/session-start-graph-freshness.js` (id `session-start:graph-freshness`,
registered in `hooks/hooks.json`, profiles `standard,strict`) runs the same
check once per session and surfaces a heads-up when the index is stale or
missing — so a fresh session rebuilds before trusting graph output:

```text
[GraphFreshness] code-review-graph index is STALE (~39d). Graph index is older than the 14-day freshness window.
  detect_changes / semantic_search / get_impact_radius may be wrong: newly-added tests can show as gaps and new files are unfindable.
  Rebuild the index: call build_or_update_graph_tool (code-review-graph MCP), ...
```

It stays **silent** for the common case — a repo with no `.code-review-graph/`
directory at all (i.e. one that does not use code-review-graph). It only speaks
up when the graph is actually in use and has gone stale or lost its `graph.db`.
Like every ECC hook it fails open (prints nothing, never blocks) and can be
turned off with `ECC_DISABLED_HOOKS=session-start:graph-freshness` or by running
the `minimal` hook profile.

## How staleness is decided

The classifier (`scripts/lib/graph-freshness.js`) uses two independent signals:

1. **High confidence — source newer than the index.** If the newest committed
   source change (`HEAD` commit time) is provably newer than the index build,
   the index cannot represent it → `STALE`.
2. **Advisory backstop — age ceiling.** Rebased or imported history can carry
   commit timestamps that predate the build, so signal (1) can miss a stale
   index. If the index is older than the freshness window (14 days by default),
   it is flagged `STALE` regardless.

`MISSING` is reported when no `graph.db` exists for the repo — the cue to run an
initial build.

## Recovery

Rebuild the index so the review tools reflect the current tree:

- MCP: call `build_or_update_graph_tool` (incremental by default;
  `full_rebuild: true` re-parses every file).
- CLI: run the `code-review-graph` build for the repository.

The `graph.db` is machine-local and git-ignored (via the nested
`.code-review-graph/.gitignore`); it is never committed.
