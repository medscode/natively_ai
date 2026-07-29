// Shared guard for tests that assert against the PRIVATE `premium/` submodule.
//
// `premium/` is declared in .gitmodules but is a private repo, and CI checks out
// with plain `actions/checkout@v4` (no `submodules: true`). On a clean
// open-source checkout the directory is empty, so any test that reads
// `premium/...` at module scope throws at IMPORT time and takes its whole file
// down with it — which is why several suites were red before this helper existed.
//
// Usage:
//   import { premiumGuard, readPremium } from '../../test/premiumSubmodule.mjs';
//   const src = readPremium('premium/electron/knowledge/ContextAssembler.ts');
//   describe('...', premiumGuard, () => { ... });
//
// `readPremium` returns '' when the submodule is absent (so module scope never
// throws) and `premiumGuard` skips the assertions that would depend on it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** True when the private premium submodule is checked out in this worktree. */
export const premiumAvailable = fs.existsSync(
  path.join(repoRoot, 'premium/electron/knowledge/ContextAssembler.ts'),
);

/** node:test options object — spread into test()/describe() to skip without premium. */
export const premiumGuard = {
  skip: premiumAvailable ? false : 'premium submodule not checked out',
};

/** Read a repo-relative premium file, or '' when the submodule is absent. */
export function readPremium(relPath) {
  if (!premiumAvailable) return '';
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
}

// ── Compiled premium output (dist-electron/premium/...) ──────────────────────
// Tests that exercise the REAL compiled premium classes import from
// dist-electron. That output only exists when the submodule was present at
// build time, so it needs its own probe — `premiumAvailable` (a source check)
// can be true while the build output is still missing.

/** True when compiled premium output is present in dist-electron. */
export const premiumDistAvailable = fs.existsSync(
  path.join(repoRoot, 'dist-electron/premium/electron/knowledge/KnowledgeDatabaseManager.js'),
);

/** node:test options object for suites that need the COMPILED premium output. */
export const premiumDistGuard = {
  skip: premiumDistAvailable ? false : 'premium submodule not built into dist-electron',
};

/**
 * Import a compiled premium module by ABSOLUTE path, or resolve to `{}` when it
 * is absent, so a top-level `const { X } = await importPremiumDist(p)` yields
 * `undefined` instead of throwing at module scope and failing the whole file.
 * Pair with `premiumDistGuard` on the suites that use the binding.
 */
export async function importPremiumDist(absPath) {
  if (!fs.existsSync(absPath)) return {};
  return import(pathToFileURL(absPath).href);
}
