#!/usr/bin/env node
/**
 * tools/spec-mtime.mjs
 *
 * For each package, ensure that `specs/SPEC.md` reflects (or
 * post-dates) the most recent change under `src/`. This is the
 * cheap, fast gate. The deeper checks (spec-coverage, spec-drift)
 * live in their own tools.
 *
 * Implementation note (issue #11): the original implementation
 * compared filesystem mtimes, which produced false-positive failures
 * on fresh checkouts / git worktrees where wall-clock mtimes do not
 * match commit-time ordering (files checked out in the same second
 * can have mtimes that are sub-second newer than the spec they
 * post-date). The spec's intent — documented in docs/spec-style.md
 * §"1. spec-mtime" — is "if you changed the code, you also changed
 * the spec", which is a property of the git history, not the
 * filesystem.
 *
 * We therefore compute each file's effective mtime as
 *     max(git_commit_time_seconds, filesystem_mtime_seconds)
 * so that:
 *   - committed files are compared by their commit time (deterministic
 *     across checkouts, CI, containers), and
 *   - uncommitted/dirty files (filesystem_mtime > commit_time) keep
 *     behaving like the old filesystem-mtime gate.
 *
 * Exits 0 if every package's SPEC.md is fresh, 1 otherwise.
 */
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  walk,
  effectiveMtime,
  newestEffectiveMtime,
  commitTimesUnder,
  root,
} from './lib/git-mtime.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const packagesDir = join(root, 'packages');

let failed = false;
const entries = await readdir(packagesDir, { withFileTypes: true });
for (const e of entries) {
  if (!e.isDirectory()) continue;
  const pkg = join(packagesDir, e.name);
  const specPath = join(pkg, 'specs', 'SPEC.md');
  try {
    await stat(specPath);
  } catch {
    console.error(`  FAIL: ${e.name}/specs/SPEC.md is missing`);
    failed = true;
    continue;
  }
  const srcDir = join(pkg, 'src');
  const srcFiles = [];
  try {
    for await (const f of walk(srcDir)) srcFiles.push(f);
  } catch {
    // no src/ directory; data-only package
    console.log(`  OK:   ${e.name}/specs/SPEC.md (no src/ tree)`);
    continue;
  }
  if (srcFiles.length === 0) {
    console.log(`  OK:   ${e.name}/specs/SPEC.md (no src/ tree)`);
    continue;
  }

  // Single git log per package covering both src/ and specs/.
  const combined = await commitTimesUnder(pkg);

  const newestSrc = await newestEffectiveMtime(srcFiles, combined);
  const specT = await effectiveMtime(specPath, combined);
  if (specT < newestSrc) {
    console.error(
      `  FAIL: ${e.name}/specs/SPEC.md is older than the newest src/ change. ` +
        `Run \`touch ${specPath}\` after updating the spec.`
    );
    failed = true;
  } else {
    console.log(`  OK:   ${e.name}/specs/SPEC.md`);
  }
}

if (failed) {
  console.error('\nspec-mtime: FAIL');
  process.exit(1);
}
console.log('\nspec-mtime: PASS');
process.exit(0);