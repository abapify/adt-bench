#!/usr/bin/env node
/**
 * tools/lib/git-mtime.mjs
 *
 * Shared helpers for git-aware file mtimes, used by both
 * tools/spec-mtime.mjs and tools/spec-coverage.mjs.
 *
 * Issue #11: filesystem-only mtime comparisons are unreliable on
 * fresh checkouts / git worktrees, where wall-clock mtimes don't
 * match commit-time ordering. We compute each file's effective
 * mtime as `max(commit_time_seconds, filesystem_mtime_seconds)`:
 *   - committed files: compared by their commit time (deterministic
 *     across checkouts, CI, containers), and
 *   - dirty/uncommitted files (filesystem_mtime > commit_time)
 *     keep behaving like the old filesystem-mtime gate.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '..', '..');

/* Normalize an absolute path to forward-slash form so the
 * repo-relative string we hand to `git log` is platform-independent
 * (git itself uses forward slashes regardless of the host OS). */
function toRepoRelative(absOrRel) {
  let tail = absOrRel;
  if (absOrRel.startsWith(root + sep) || absOrRel.startsWith(root + '/')) {
    tail = absOrRel.slice(root.length + 1);
  }
  return tail.split(sep).join('/');
}

export async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git') continue;
      yield* walk(p);
    } else {
      yield p;
    }
  }
}

export function rel(file) {
  return toRepoRelative(file);
}

/* Return a Map<repo-relative-path, latest-commit-time-seconds> for
 * every path under <dir> that has been touched by some commit
 * reachable from HEAD. One `git log` invocation per call.
 *
 * `dir` may be absolute or repo-relative; we always pass a
 * repo-relative path to `git log` so the invocation is robust to
 * the cwd of the spawned process and to symlinked worktrees. */
export async function commitTimesUnder(dir) {
  const out = new Map();
  const relDir = toRepoRelative(dir);
  let res;
  try {
    res = await execFileP(
      'git',
      [
        'log',
        '--pretty=format:COMMIT_TIME %ct',
        '--name-only',
        '--no-renames',
        '-z',
        'HEAD',
        '--',
        relDir,
      ],
      { cwd: root }
    );
  } catch {
    return out;
  }
  // With `-z`, `git log` emits records separated by NUL. Each
  // record is: "COMMIT_TIME <digits>\n<path1>\0<path2>\0...\0".
  const tokens = res.stdout.split('\0');
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (!tok) { i++; continue; }
    const m = tok.match(/^COMMIT_TIME (\d+)\n([\s\S]*)$/);
    if (!m) { i++; continue; }
    const ct = Number(m[1]);
    const inline = m[2].trim();
    if (inline) out.set(inline, Math.max(out.get(inline) ?? 0, ct));
    i++;
    while (i < tokens.length && tokens[i] && !tokens[i].startsWith('COMMIT_TIME ')) {
      const pth = tokens[i].trim();
      if (pth) out.set(pth, Math.max(out.get(pth) ?? 0, ct));
      i++;
    }
  }
  return out;
}

export async function effectiveMtime(file, commitTimes) {
  let fsMtime = 0;
  try {
    const s = await stat(file);
    fsMtime = Math.floor(s.mtimeMs / 1000);
  } catch {}
  const ct = commitTimes.get(rel(file));
  if (ct === undefined) return fsMtime; // never committed: filesystem only
  return Math.max(ct, fsMtime);          // dirty file: filesystem mtime wins
}

export async function newestEffectiveMtime(files, commitTimes) {
  let max = 0;
  for (const f of files) {
    const t = await effectiveMtime(f, commitTimes);
    if (t > max) max = t;
  }
  return max;
}

export { root };
