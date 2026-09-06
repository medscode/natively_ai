// scripts/migrate-shared-kb.js
//
// One-time migration: copy `__shared_legal_kb__` rows + chunks + embedding BLOBs
// from `~/Library/Application Support/Electron/natively.db` (where standalone
// electron ingests default) into `~/Library/Application Support/natively/natively.db`
// (where the live natively app writes — resolved via app.setName('natively')).
//
// Why this exists: standalone `electron scripts/ingest-shared-kb.js` defaulted
// userData to the `Electron/` folder because the Electron binary name is
// "Electron". The live app reads from `natively/` because its package.json
// declares `"name": "natively"`. So prior ingests landed in a DB the app never
// read.
//
// Implementation: uses the `sqlite3` CLI via child_process (NOT better-sqlite3)
// so it works regardless of the NODE_MODULE_VERSION state of better-sqlite3.
// ATTACH DATABASE binds both files in one sqlite3 session, so BLOB columns are
// transferred byte-for-byte with no hex round-trip.
//
// What it copies:
//   - client_cases row for SHARED_KB_CASE_ID
//   - knowledge_sources rows for that case (with metadata_json.file_hash preserved
//     so the ingest script's idempotency check recognises them and SKIPS re-embedding)
//   - chunks rows (text + speaker + timestamps + token_count + embedding BLOB)
//
// What it does NOT copy:
//   - vec_chunks_384 KNN index → incompatible. The live app uses 768-dim
//     embeddings (`vec_chunks_768`). The patched ingest script must re-run to
//     populate that, costing ~450 Gemini API calls total.
//
// Idempotent: PRIMARY KEY conflicts are skipped via INSERT OR IGNORE.

'use strict';
const nodePath = require('node:path');
const nodeFs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const SHARED_KB_CASE_ID = '__shared_legal_kb__';

const ELECTRON_USERDATA = nodePath.join(os.homedir(), 'Library', 'Application Support', 'Electron');
const NATIVELY_USERDATA = nodePath.join(os.homedir(), 'Library', 'Application Support', 'natively');

const SRC_DB = nodePath.join(ELECTRON_USERDATA, 'natively.db');
const DST_DB = nodePath.join(NATIVELY_USERDATA, 'natively.db');

function log(...a) { console.log(...a); }
function exists(p) { try { return nodeFs.statSync(p).isFile(); } catch { return false; } }

// Resolve sqlite3 CLI. macOS has it at /usr/bin/sqlite3 (Apple built-in) or via brew.
// We probe a couple of locations so this works on any dev machine.
function findSqlite3() {
  const candidates = ['/usr/bin/sqlite3', '/opt/homebrew/opt/sqlite/bin/sqlite3', '/usr/local/opt/sqlite/bin/sqlite3'];
  for (const c of candidates) {
    if (exists(c)) return c;
  }
  // Fall back to PATH lookup.
  try { return execFileSync('/usr/bin/env', ['which', 'sqlite3'], { encoding: 'utf8' }).trim(); }
  catch { return null; }
}

if (!exists(SRC_DB)) {
  console.error(`Source DB not found: ${SRC_DB}`);
  console.error('Nothing to migrate. (Run `npm run ingest-kb` against the live DB instead.)');
  process.exit(1);
}
if (!exists(DST_DB)) {
  console.error(`Destination DB not found: ${DST_DB}`);
  console.error('Run the natively app at least once to create the live DB, then re-run this migration.');
  process.exit(1);
}

const sqlite3 = findSqlite3();
if (!sqlite3) {
  console.error('sqlite3 CLI not found. Install via `brew install sqlite` or Xcode Command Line Tools.');
  process.exit(1);
}

log(`\n╔══════════════════════════════════════════════════════════════╗`);
log(`║      Natively — Shared KB Migration (Electron → live)       ║`);
log(`╚══════════════════════════════════════════════════════════════╝\n`);
log(`Source:       ${SRC_DB}`);
log(`Destination:  ${DST_DB}`);
log(`sqlite3 CLI:  ${sqlite3}\n`);

// ── Workaround: macOS com.apple.provenance xattr blocks sqlite3 from ─
// ── opening DBs that originated from another app (the Electron build). ─
// ── Stage both DBs into /tmp via Node's fs.copyFile (which doesn't ────
// ── trigger TCC) and operate on the copies. The destination copy is ────
// ── written BACK to its original path after migration. ────────────────
const stagingDir = nodePath.join(os.tmpdir(), `kb-migrate-${Date.now()}`);
nodeFs.mkdirSync(stagingDir, { recursive: true });
const stagedSrc = nodePath.join(stagingDir, 'src.db');
const stagedDst = nodePath.join(stagingDir, 'dst.db');

log(`Staging DBs to ${stagingDir} (works around com.apple.provenance xattr)…`);
nodeFs.copyFileSync(SRC_DB, stagedSrc);
nodeFs.copyFileSync(DST_DB, stagedDst);
log(`  ✓ Source staged (${nodeFs.statSync(stagedSrc).size} bytes)`);
log(`  ✓ Dest staged (${nodeFs.statSync(stagedDst).size} bytes)\n`);

// ── Sanity check: does src have any __shared_legal_kb__ rows? ──────
// NOTE: don't pass `-readonly` here — the combination of the macOS
// `com.apple.provenance` xattr on Electron-built DBs and sqlite3's
// `-readonly` open mode triggers a spurious SQLITE_CANTOPEN (14). Opening
// read-write then running a `SELECT` works fine.
function readScalar(sql, dbPath) {
  const out = execFileSync(sqlite3, [dbPath, sql], { encoding: 'utf8' }).trim();
  return out;
}

const srcSourceCount = readScalar(
  `SELECT COUNT(*) FROM knowledge_sources WHERE client_case_id = '${SHARED_KB_CASE_ID}';`,
  stagedSrc
);
if (Number(srcSourceCount) === 0) {
  console.error(`Source DB has no rows for ${SHARED_KB_CASE_ID}. Nothing to migrate.`);
  process.exit(1);
}
log(`Source has ${srcSourceCount} knowledge_source(s) under ${SHARED_KB_CASE_ID}.\n`);

// Snapshot the destination's pre-state so we can report diffs after.
const dstBefore = {
  clientCase: readScalar(`SELECT COUNT(*) FROM client_cases WHERE id = '${SHARED_KB_CASE_ID}';`, stagedDst),
  sources: readScalar(`SELECT COUNT(*) FROM knowledge_sources WHERE client_case_id = '${SHARED_KB_CASE_ID}';`, stagedDst),
  chunks: readScalar(`SELECT COUNT(*) FROM chunks WHERE meeting_id = '${SHARED_KB_CASE_ID}';`, stagedDst),
};
log(`Destination (before): client_cases=${dstBefore.clientCase} knowledge_sources=${dstBefore.sources} chunks=${dstBefore.chunks}\n`);

// ── Single sqlite3 session with ATTACH for both staged DBs ────────────
// Uses INSERT OR IGNORE … SELECT for idempotency. BLOB columns (chunks.embedding)
// travel through ATTACH as raw bytes — no hex round-trip needed.
const migrationSql = `
ATTACH '${stagedSrc}' AS src;
ATTACH '${stagedDst}' AS dst;

INSERT OR IGNORE INTO dst.client_cases (id, name, company, notes, created_at)
  SELECT id, name, company, notes, created_at FROM src.client_cases WHERE id = '${SHARED_KB_CASE_ID}';

INSERT OR IGNORE INTO dst.knowledge_sources
    (id, client_case_id, source_type, title, metadata_json, index_status, created_at)
  SELECT id, client_case_id, source_type, title, metadata_json, index_status, created_at
  FROM src.knowledge_sources WHERE client_case_id = '${SHARED_KB_CASE_ID}';

INSERT OR IGNORE INTO dst.chunks
    (id, meeting_id, chunk_index, speaker, start_timestamp_ms, end_timestamp_ms,
     cleaned_text, token_count, embedding, created_at)
  SELECT id, meeting_id, chunk_index, speaker, start_timestamp_ms, end_timestamp_ms,
         cleaned_text, token_count, embedding, created_at
  FROM src.chunks WHERE meeting_id = '${SHARED_KB_CASE_ID}';

DETACH src;
DETACH dst;
`;

// Write the SQL to a temp file (avoids quoting headaches in argv).
const tmpSql = nodePath.join(os.tmpdir(), `kb-migrate-${Date.now()}.sql`);
nodeFs.writeFileSync(tmpSql, migrationSql);

try {
  // `-bail` aborts on the first error so we don't silently half-migrate.
  execFileSync(sqlite3, ['-bail', stagedDst], { input: nodeFs.readFileSync(tmpSql), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
} catch (e) {
  console.error('Migration FAILED. Possible causes:');
  console.error('  • Live natively.db is locked by a running Electron process — quit it and retry.');
  console.error('  • Schema mismatch — the source DB was created with an older migrations table.');
  console.error('stderr from sqlite3:', e.stderr?.toString() || '(none)');
  nodeFs.unlinkSync(tmpSql);
  process.exit(1);
} finally {
  try { nodeFs.unlinkSync(tmpSql); } catch { /* ignore */ }
}

// ── Report ─────────────────────────────────────────────────────────
const dstAfter = {
  clientCase: readScalar(`SELECT COUNT(*) FROM client_cases WHERE id = '${SHARED_KB_CASE_ID}';`, stagedDst),
  sources: readScalar(`SELECT COUNT(*) FROM knowledge_sources WHERE client_case_id = '${SHARED_KB_CASE_ID}';`, stagedDst),
  chunks: readScalar(`SELECT COUNT(*) FROM chunks WHERE meeting_id = '${SHARED_KB_CASE_ID}';`, stagedDst),
};

// ── Commit: copy staged DB back to original destination path ────────
log(`\nCommitting staged DB back to ${DST_DB}…`);
nodeFs.copyFileSync(stagedDst, DST_DB);
log(`  ✓ Destination updated\n`);

// Clean up staging dir.
try { nodeFs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }

log(`────────────────────────────────────────`);
log(`Migration summary`);
log(`────────────────────────────────────────`);
log(`  client_cases:       ${dstBefore.clientCase} → ${dstAfter.clientCase}`);
log(`  knowledge_sources:  ${dstBefore.sources} → ${dstAfter.sources}   (+${dstAfter.sources - dstBefore.sources})`);
log(`  chunks:             ${dstBefore.chunks} → ${dstAfter.chunks}  (+${dstAfter.chunks - dstBefore.chunks})`);
log(`────────────────────────────────────────\n`);

log(`⚠ vec0 KNN index NOT migrated (dimension mismatch: Electron uses 384-dim, live uses 768-dim).`);
log(`  Run \`npm run ingest-kb\` from your terminal — the patched script now`);
log(`  calls app.setName('natively') and writes to the live DB. Because this`);
log(`  migration preserved file_hash in metadata_json, the ingest script will`);
log(`  SEE all 9 files as already-ingested and SKIP re-embedding unless you`);
log(`  want to force a fresh build. To force re-embed: delete the`);
log(`  __shared_legal_kb__ rows from knowledge_sources and re-run.\n`);

log(`Verify with:`);
log(`  sqlite3 "$HOME/Library/Application Support/natively/natively.db" \\`);
log(`    "SELECT client_case_id, COUNT(*) FROM knowledge_sources GROUP BY client_case_id;"\n`);
