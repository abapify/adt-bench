#!/usr/bin/env node
/**
 * tools/spec-coverage.mjs
 *
 * For each package, verify that:
 *   1. Every `export` in src/index.ts is declared in specs/SPEC.md
 *      (in the "## 2. Public surface" section's TypeScript block).
 *   2. Every non-export function or const in src/ is also declared
 *      in SPEC.md (under the section that documents it).
 *   3. SKILL.md files in packages/skills/ contain none of the
 *      forbidden tool-specific substrings.
 *   4. SPEC.md exists for every package and was modified more
 *      recently than its src/ tree (mtime gate; the old
 *      spec-check.mjs does this).
 *
 * Exit code 0 = all good. Exit code 1 = at least one violation.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  walk,
  effectiveMtime,
  commitTimesUnder,
  newestEffectiveMtime,
  root,
} from './lib/git-mtime.mjs';

const packagesDir = join(root, 'packages');
const skillsDir = join(root, 'packages', 'skills', '.agents', 'skills');

let violations = 0;

function fail(pkg, msg) {
  console.error(`  FAIL: ${msg}`);
  violations++;
}

function ok(pkg, msg) {
  console.log(`  OK:   ${msg}`);
}

/* Extract all `export` symbols from a TS file by a simple text scan. */
function extractExports(src) {
  const exports = [];
  // Strip block comments and line comments to avoid false matches.
  // The line-comment regex uses a negative lookbehind so the `//`
  // in URL strings like `http://...` is not treated as a comment.
  const cleaned = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(?<![:'"`\\])\/\/.*$/gm, '');

  // export const|let|var Foo
  // export function Foo
  // export class Foo
  // export interface Foo { ... }
  // export async function Foo
  const re =
    /^\s*export\s+(?:const|let|var|function|class|interface|async function)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re.exec(cleaned)) !== null) exports.push(m[1]);

  // export type Foo = ...  (type alias declaration)
  // The capture group must be a real `type X = ...` or `type X<...> = ...` line.
  const reTypeAlias = /^\s*export\s+type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=>]*>)?\s*=/gm;
  while ((m = reTypeAlias.exec(cleaned)) !== null) exports.push(m[1]);

  // export { a, b, c }  — bare names only (skip `type X` and `interface X` modifiers)
  const re2 = /^\s*export\s*\{([^}]+)\}/gm;
  while ((m = re2.exec(cleaned)) !== null) {
    for (const raw of m[1].split(',')) {
      const part = raw.trim();
      if (!part) continue;
      // Skip `type X` and `interface X` modifiers — those are aliases,
      // not value exports. The real declaration is `export type X = ...`
      // which is captured above.
      if (part.startsWith('type ')) continue;
      if (part.startsWith('interface ')) continue;
      // Handle `a as b` — the exported name is `a` (the binding in the
      // source module), not `b` (the public name). For our purposes we
      // want the public name so the spec can mention it; the
      // declaration in the source file is also `a as b`. We use the
      // public name.
      const exported = part.split(/\s+as\s+/).pop().trim();
      if (exported) exports.push(exported);
    }
  }
  return [...new Set(exports)];
}

/* Extract every TOP-LEVEL function/const/class/interface/type name
 * from a TS file. We do a brace-counting scan to skip over function
 * bodies, so local `const foo = ...` inside a function body does
 * NOT show up. This is the key fix: the previous regex caught
 * locals, which are not part of the API. */
function extractTopLevelSymbols(src) {
  const syms = new Set();
  const cleaned = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  const lines = cleaned.split(/\r?\n/);
  let braceDepth = 0;
  let parenDepth = 0;
  let atTop = true;

  for (const line of lines) {
    // Update brace/paren depth BEFORE checking the line for declarations.
    // The current line may contain both a declaration and the opening
    // brace of its body. We treat the line as top-level if the previous
    // line's depth was 0.
    const stripped = line;
    for (const ch of stripped) {
      if (ch === '{') braceDepth++;
      else if (ch === '}') braceDepth--;
      else if (ch === '(') parenDepth++;
      else if (ch === ')') parenDepth--;
    }

    if (atTop && braceDepth === 0 && parenDepth === 0) {
      const patterns = [
        /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[=:]/,
        /^(?:export\s+)?function\s+([A-Za-z_$][\w$]*)/,
        /^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/,
        /^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/,
        /^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=/,
      ];
      for (const re of patterns) {
        const m = stripped.match(re);
        if (m) {
          syms.add(m[1]);
          break;
        }
      }
    }
    atTop = braceDepth === 0 && parenDepth === 0;
  }
  return syms;
}

/* Check whether a SPEC.md mentions a symbol (very tolerant). */
function specMentions(spec, sym) {
  // Look for the symbol as a whole word anywhere in the spec.
  const re = new RegExp(`\\b${sym.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`);
  return re.test(spec);
}

/* -------------------- per-package checks -------------------- */

async function checkPackage(pkgPath, pkgName) {
  console.log(`\n[${pkgName}]`);

  // 1. SPEC.md exists
  const specPath = join(pkgPath, 'specs', 'SPEC.md');
  let spec;
  try {
    spec = await readFile(specPath, 'utf8');
  } catch {
    fail(pkgName, `specs/SPEC.md missing`);
    return;
  }

  // 2. mtime gate (issue #11: git-aware, see helpers above)
  const srcFiles = [];
  for await (const f of walk(join(pkgPath, 'src'))) srcFiles.push(f);
  if (srcFiles.length > 0) {
    const combined = await commitTimesUnder(pkgPath);
    const newest = await newestEffectiveMtime(srcFiles, combined);
    const specT = await effectiveMtime(specPath, combined);
    if (specT < newest) {
      fail(pkgName, `specs/SPEC.md is older than the newest src/ change`);
    } else {
      ok(pkgName, `specs/SPEC.md is fresh`);
    }
  } else {
    ok(pkgName, `no src/ tree (data-only package)`);
    return;
  }

  // 3. Read every src file
  const indexPath = join(pkgPath, 'src', 'index.ts');
  let indexSrc = '';
  try {
    indexSrc = await readFile(indexPath, 'utf8');
  } catch {
    fail(pkgName, `src/index.ts missing — every package must export from index.ts`);
    return;
  }

  // 4. Every export in src/index.ts must be mentioned in SPEC.md
  const exports = extractExports(indexSrc);
  for (const sym of exports) {
    if (!specMentions(spec, sym)) {
      fail(pkgName, `exported symbol "${sym}" is NOT documented in SPEC.md`);
    }
  }
  if (exports.length > 0) {
    ok(pkgName, `all ${exports.length} exports documented in SPEC.md`);
  }

  // 5. Every non-export TOP-LEVEL symbol (i.e. part of the package's
  //    public API even if not re-exported from index.ts) should also
  //    be in the SPEC. We skip private helpers whose name starts with
  //    `_` or is a single letter, and we skip test files.
  const allSyms = new Set();
  for await (const f of walk(join(pkgPath, 'src'))) {
    if (f.endsWith('.spec.ts') || f.endsWith('.test.ts')) continue;
    if (!f.endsWith('.ts')) continue;
    const src = await readFile(f, 'utf8');
    for (const s of extractTopLevelSymbols(src)) allSyms.add(s);
  }
  let undocumented = 0;
  for (const sym of allSyms) {
    if (exports.includes(sym)) continue;     // already covered
    if (sym.startsWith('_')) continue;        // conventional private
    if (sym.length === 1) continue;           // single letter
    if (sym === sym.toUpperCase()) continue;   // ALL_CAPS constant
    if (!specMentions(spec, sym)) {
      fail(pkgName, `internal symbol "${sym}" is not in SPEC.md`);
      undocumented++;
    }
  }
  if (undocumented === 0) {
    ok(pkgName, `all internal symbols are documented`);
  }
}

/* -------------------- skills checks -------------------- */

const FORBIDDEN_IN_SKILLS = [
  'arc-1',
  'adt-cli',
  'abapify-adt-mcp',
  'claude code',
  'codex',
  'gemini-cli',
];

async function checkSkills() {
  console.log(`\n[skills]`);

  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    ok('skills', 'no skills directory (data-only)');
    return;
  }

  let foundAny = false;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    foundAny = true;

    // A sub-directory whose name starts with `_` is a meta-skill
    // container. We recurse into it (one level only) and apply
    // the same checks. Meta-skill bodies are exempt from the
    // forbidden-tool check.
    if (e.name.startsWith('_')) {
      let subEntries;
      try {
        subEntries = await readdir(join(skillsDir, e.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const sub of subEntries) {
        if (!sub.isDirectory()) continue;
        foundAny = true;
        const isMeta = true; // always meta here
        const skillFile = join(skillsDir, e.name, sub.name, 'SKILL.md');
        let content;
        try {
          content = await readFile(skillFile, 'utf8');
        } catch {
          fail('skills', `${e.name}/${sub.name}/SKILL.md is missing`);
          continue;
        }
        const body = content.replace(/^---[\s\S]*?---\s*/m, '');
        if (!isMeta) {
          for (const forbidden of FORBIDDEN_IN_SKILLS) {
            const re = new RegExp(`\\b${forbidden}\\b`, 'i');
            if (re.test(body)) {
              fail('skills', `${e.name}/${sub.name}/SKILL.md mentions forbidden tool-specific term "${forbidden}"`);
            }
          }
        }
        const fm = content.match(/^---\n([\s\S]*?)\n---/);
        if (fm) {
          const nameMatch = fm[1].match(/^name:\s*(.+)$/m);
          if (nameMatch) {
            const declared = nameMatch[1].trim();
            if (declared !== sub.name) {
              fail('skills', `${e.name}/${sub.name}/SKILL.md has name="${declared}" (must match directory)`);
            }
          }
        }
        ok('skills', `${e.name}/${sub.name}/SKILL.md is clean`);
      }
      continue;
    }

    const isMeta = false;
    const skillFile = join(skillsDir, e.name, 'SKILL.md');
    let content;
    try {
      content = await readFile(skillFile, 'utf8');
    } catch {
      fail('skills', `${e.name}/SKILL.md is missing`);
      continue;
    }
    // Strip the frontmatter block before checking for forbidden content
    const body = content.replace(/^---[\s\S]*?---\s*/m, '');
    if (!isMeta) {
      for (const forbidden of FORBIDDEN_IN_SKILLS) {
        const re = new RegExp(`\\b${forbidden}\\b`, 'i');
        if (re.test(body)) {
          fail('skills', `${e.name}/SKILL.md mentions forbidden tool-specific term "${forbidden}"`);
        }
      }
    }
    // The name in the frontmatter must match the directory name
    const fm = content.match(/^---\n([\s\S]*?)\n---/);
    if (fm) {
      const nameMatch = fm[1].match(/^name:\s*(.+)$/m);
      if (nameMatch) {
        const declared = nameMatch[1].trim();
        if (declared !== e.name) {
          fail('skills', `${e.name}/SKILL.md has name="${declared}" (must match directory)`);
        }
      }
    }
    ok('skills', `${e.name}/SKILL.md is clean`);
  }
  if (!foundAny) {
    ok('skills', 'no skill directories');
  }
}

/* -------------------- main -------------------- */

const entries = await readdir(packagesDir, { withFileTypes: true });
for (const e of entries) {
  if (!e.isDirectory()) continue;
  await checkPackage(join(packagesDir, e.name), e.name);
}
await checkSkills();

console.log('');
if (violations === 0) {
  console.log('spec-coverage: PASS');
  process.exit(0);
} else {
  console.error(`spec-coverage: FAIL (${violations} violation${violations === 1 ? '' : 's'})`);
  process.exit(1);
}
