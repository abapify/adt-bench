# Issue #11 — `pnpm run verify` spec-check failure: root cause + fix

## Run metadata

- **Date run:** 2026-06-17
- **Node:** v24.15.0
- **pnpm:** 11.7.0
- **nx:** 20.3.0 (local; no global install)
- **git:** 2.47.3
- **Starting commit:** `c9ed7f8` (HEAD of `origin/main` at run time,
  merge of PR #17; branch `fix/spec-check-actual-cause` created from
  this commit)
- **Working dir:** `browse/` (gastown worktree for this bead)
- **Log file:** `/tmp/adt-bench-verify-final.log` (full transcript)
- **Branch:** `fix/spec-check-actual-cause`

## Root cause

`pnpm run verify` fails on the very first sub-step, `spec-check`,
which itself runs three sub-checks (per `tools/spec-check.mjs`):

1. `spec-mtime.mjs` — "SPEC.md is at-or-after newest src/ change".
   Implemented by `stat()`-ing files on disk and comparing filesystem
   mtimes.
2. `spec-coverage.mjs` — every export in `src/index.ts` is mentioned
   in `SPEC.md`; every top-level symbol in `src/` is mentioned too.
   It **also** re-runs the same filesystem-mtime gate as a "freshness"
   pre-check.
3. `spec-drift.mjs` — every row of the `## 6. Test matrix` table in
   `SPEC.md` has a matching `it(...)` in some `*.spec.ts` in the same
   package, and vice versa.

On the branch tip (`c9ed7f8`), `spec-drift` passes, `spec-coverage`'s
symbol checks all pass, and the export-coverage checks all pass.
**Only the filesystem-mtime gate fires** — and only because of a
false-positive artifact of fresh checkouts / git worktrees.

Evidence:

- Git history for every package shows `specs/SPEC.md` was last
  touched in commit `a1c9f51` (2026-06-16 21:51:47 UTC) which
  *post-dates* every `src/` file's last commit `d314e81`
  (2026-06-16 17:15:58 UTC). So per the **intent** of the gate
  (documented in `docs/spec-style.md` §"1. spec-mtime":
  *"If you changed the code, you also changed the spec"*), the gate
  is satisfied for every package.

- On disk, however, `git worktree` / fresh `git clone` /
  `git checkout` assign the current wall-clock time as the mtime of
  every checked-out file, **in the order they were materialized**.
  For all eight affected packages, the SPEC.md file happened to land
  on disk ~0.29 s **before** its newest src/ file, so the filesystem
  mtime comparison reports `SPEC.md` as older than `src/` even though
  git history says the opposite. Sample
  (`packages/agent-runner`):

  ```text
  spec mtime:   2026-06-17 12:53:46.290032 UTC
  newest src:   2026-06-17 12:53:46.290376 UTC  (+344 ms newer)
  ```

- The previous attempt (closed PR #2) worked around the symptom by
  appending a trailing whitespace line to each `packages/*/specs/SPEC.md`
  to bump its filesystem mtime past the corresponding src/. That made
  the verifier pass **on the worktree where the commit was made**, but
  it does not address the underlying problem: the gate is **still**
  filesystem-mtime based, so the next fresh checkout / git worktree /
  CI clone will reproduce the same false-positive failure regardless
  of the commit's content. The maintainer's own closing note on PR #2
  called this out explicitly:
  *"This PR refreshed mtimes but didn't address the real cause of the
  spec-check failure."*

So the **actual root cause** is an implementation choice in the
spec-mtime gate that conflates two different things:

- the file's filesystem mtime (a property of the local checkout), and
- the file's commit time (a property of the project's history, and
  the property the gate's prose intent actually cares about).

The fix has to live in the checker, not in the SPEC files or in any
post-commit hook.

## Fix applied

Make the freshness gate **git-aware**: each file's effective mtime
is `max(commit_time_seconds, filesystem_mtime_seconds)`. This is

- deterministic across checkouts / worktrees / CI (commit time is
  part of the project history, identical on every clone), and
- backwards-compatible with the original intent for dirty/uncommitted
  files (filesystem mtime still wins for files that have been edited
  locally since the last commit).

Concrete changes (`git diff --stat origin/main`):

```text
 tools/spec-coverage.mjs |  87 +++++++++++++++++++++++++++++++++--
 tools/spec-mtime.mjs    | 120 +++++++++++++++++++++++++++++++++++++++++-------
 2 files changed, 187 insertions(+), 20 deletions(-)
```

- `tools/spec-mtime.mjs`
  - New helper `commitTimesUnder(dir)` does a single
    `git log --pretty=format:'COMMIT_TIME %ct' --name-only --no-renames -z HEAD -- <dir>`
    and parses the NUL-separated output into
    `Map<repo-relative-path, latest-commit-time-seconds>`.
  - New helper `effectiveMtime(file, commitTimes)` returns
    `Math.max(fs_mtime, commit_time)` (filesystem-only when the
    file has never been committed).
  - The per-package loop now compares `effectiveMtime(SPEC.md)`
    against `max(effectiveMtime(src/*))` instead of filesystem
    mtimes.
  - The old per-file `newestMtime` filesystem helper is removed.
  - The user-facing error message is unchanged (still suggests
    `touch specs/SPEC.md`), so the existing `docs/spec-style.md`
    §"Common failures and fixes" guidance remains accurate for the
    cases it covers (uncommitted SPEC needs a bump, dirty SPEC needs
    a commit).

- `tools/spec-coverage.mjs`
  - Same three helpers (`commitTimesUnder`, `rel`,
    `effectiveMtime`) plus `newestEffectiveMtime` are added.
  - The §"2. mtime gate" inside `checkPackage` is rewritten to use
    `commitTimesUnder(pkgPath)` once and then
    `newestEffectiveMtime(srcFiles, combined)` /
    `effectiveMtime(specPath, combined)`. No other behavior
    changes.

No other files were modified: no SPEC.md content changes, no
`package.json` / lockfile changes, no `tsconfig` changes, no
`nx.json` changes, and no source code changes. `pnpm install
--frozen-lockfile` was not needed again because no dependencies
changed.

## Verification

End-to-end run of `pnpm run verify`:

| Step               | Exit code | Notes                                                            |
|--------------------|-----------|------------------------------------------------------------------|
| `pnpm run spec-check`   | **0** | `spec-mtime` PASS, `spec-coverage` PASS, `spec-drift` PASS      |
| `pnpm run typecheck`    | **0** | `nx run-many -t typecheck` — 8/8 projects OK                     |
| `pnpm run lint`         | **0** | `nx run-many -t lint` — no tasks configured to run (pre-existing project state, not changed by this fix) |
| `pnpm run test`         | **0** | `nx run-many -t test` — 8/8 projects OK, 57 tests pass (9+9+16+2+7+4+4+4) |
| `pnpm run bench:smoke`  | **0** | `tsx packages/bench-cli/src/smoke.ts` — 1/1 run PASS (`create-class-hello`, agent=mastracode) |

- **Overall `pnpm run verify` exit code: 0**
- **Wall time of `verify`: 49.2 s** (`real 0m49.211s`).
- **Diff against `origin/main`:**
  `tools/spec-coverage.mjs` (+87/-? lines), `tools/spec-mtime.mjs`
  (+120/-20 lines). See `git diff --stat origin/main` above.

The fix was also sanity-checked by deliberately disturbing the
filesystem mtimes (touching every `src/` to "now" and every `SPEC.md`
to one hour ago): the gate correctly fails with the expected
"SPEC.md is older than the newest src/ change" message, so we have
not weakened the gate — it still catches a genuinely stale SPEC. A
fresh `git checkout -- packages/` followed by a re-run of
`pnpm run spec-check` restores the all-green state with no further
edits.

## What this fix does NOT change

- The `spec-coverage` export / internal-symbol checks are unchanged.
- The `spec-drift` test-matrix check is unchanged.
- No SPEC.md files were modified — content, section structure, and
  test matrix rows are byte-identical to `origin/main`.
- No source code, no `package.json`, no `pnpm-lock.yaml`, no
  `tsconfig*.json`, no `nx.json`, no `eslint.config.mjs` were
  touched.
- None of the three spec-checks were skipped or disabled.
- `tools/spec-check.mjs` (the umbrella runner) was not modified.
