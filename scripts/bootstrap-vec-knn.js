// scripts/bootstrap-vec-knn.js
//
// One-time bootstrap: populate the vec_chunks_<dim> KNN virtual table from
// existing rows in `chunks.embedding` BLOBs. This is needed when chunks have
// been migrated (or indexed) but the matching vec0 KNN rows weren't written.
//
// Why this exists:
//   - migrate-shared-kb.js migrates the chunks table (and its embedding BLOB
//     column) but does NOT populate vec_chunks_<dim>. sqlite-vec's vec0
//     virtual table is a separate structure that must be populated via
//     INSERT OR REPLACE INTO vec_chunks_<dim>(chunk_id, embedding).
//   - Without this, every retrieval query returns 0 chunks until the
//     EmbeddingPipeline finishes re-embedding all migrated chunks serially.
//     For ~4500 chunks that takes ~10 minutes.
//
// Usage:
//   NATIVELY_TEST_USERDATA="$HOME/Library/Application Support/natively" \
//     node scripts/bootstrap-vec-knn.js
//
// Flags:
//   --dry-run      Show what would be done without writing.
//   --dim <N>      Override the dimension (default: derive from active space).
//   --meeting <id> Only bootstrap chunks for one meeting (e.g. "__shared_legal_kb__").
//
// Exit codes:
//   0  → all rows bootstrapped
//   1  → error (also printed)

'use strict';

const nodePath = require('node:path');
const repoRoot = nodePath.resolve(__dirname, '..');
const distRoot = nodePath.join(repoRoot, 'dist-electron', 'electron');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const dimIdx = args.indexOf('--dim');
const DIM_OVERRIDE = dimIdx >= 0 ? parseInt(args[dimIdx + 1], 10) : null;
const meetIdx = args.indexOf('--meeting');
const MEETING_FILTER = meetIdx >= 0 ? args[meetIdx + 1] : null;

function ok(msg)   { console.log('  ✓', msg); }
function fail(msg) { console.log('  ✗', msg); }
function warn(msg) { console.log('  ⚠', msg); }

(async () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║     KNN Bootstrap — populate vec_chunks_<dim> from BLOBs    ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  let DatabaseManager, VectorStore;
  try {
    DatabaseManager = require(nodePath.join(distRoot, 'db/DatabaseManager.js')).DatabaseManager;
    VectorStore      = require(nodePath.join(distRoot, 'rag/VectorStore.js')).VectorStore;
  } catch (e) {
    fail(`Cannot load built modules — run \`npm run build:electron\` first. (${e.message})`);
    process.exit(1);
  }

  const dm = DatabaseManager.getInstance();
  if (!dm.isAvailable()) {
    fail(`DatabaseManager not connected: ${dm.getInitError?.()?.message || 'unknown'}`);
    process.exit(1);
  }
  const db = dm.getDb();
  const dbPath = dm.getDbPath();
  ok(`DB open at ${dbPath}`);

  // ─── Determine the dimension to bootstrap ────────────────────────
  const spaceRow = db.prepare(`
    SELECT embedding_space FROM meetings
    WHERE embedding_space IS NOT NULL
    GROUP BY embedding_space
    ORDER BY COUNT(*) DESC
    LIMIT 1
  `).get();
  if (!spaceRow?.embedding_space) {
    fail('No meetings have a stamped embedding_space — cannot infer dimension.');
    process.exit(1);
  }
  // Composite key: provider:model:dim
  const parts = String(spaceRow.embedding_space).split(':');
  const DIM = DIM_OVERRIDE || parseInt(parts[parts.length - 1], 10);
  if (!Number.isInteger(DIM) || DIM <= 0) {
    fail(`Could not parse dimension from "${spaceRow.embedding_space}". Use --dim N to override.`);
    process.exit(1);
  }
  ok(`Active embedding space: ${spaceRow.embedding_space} → bootstrapping vec_chunks_${DIM}`);

  // ─── Confirm vec0 table exists ───────────────────────────────────
  const vecTable = `vec_chunks_${DIM}`;
  try {
    db.prepare(`SELECT count(*) FROM ${vecTable} LIMIT 1`).get();
  } catch (e) {
    fail(`vec0 table ${vecTable} not available — vec0 extension missing or dim not provisioned. (${e.message})`);
    process.exit(1);
  }

  // ─── Confirm there are chunks to bootstrap ───────────────────────
  const countSql = MEETING_FILTER
    ? `SELECT COUNT(*) AS c FROM chunks WHERE embedding IS NOT NULL AND meeting_id = ?`
    : `SELECT COUNT(*) AS c FROM chunks WHERE embedding IS NOT NULL`;
  const total = MEETING_FILTER
    ? db.prepare(countSql).get(MEETING_FILTER).c
    : db.prepare(countSql).get().c;

  const existingVec = db.prepare(`SELECT COUNT(*) AS c FROM ${vecTable}`).get().c;
  console.log('');
  console.log(`  chunks.embedding BLOB rows to bootstrap: ${total}`);
  console.log(`  ${vecTable} rows already present:        ${existingVec}`);
  if (total === 0) {
    fail('0 chunks have embeddings to bootstrap — nothing to do.');
    process.exit(1);
  }
  if (existingVec >= total) {
    ok(`${vecTable} already fully populated (${existingVec} ≥ ${total}). No-op.`);
    process.exit(0);
  }
  if (DRY_RUN) {
    ok(`Dry-run: would insert ${total - existingVec} row(s) into ${vecTable}.`);
    process.exit(0);
  }

  // ─── Bootstrap — stream chunks in batches ───────────────────────
  // Each BLOB is little-endian float32 (matches VectorStore.embeddingToBlob).
  // The chunk_id is the row's primary key; pass as BigInt so sqlite-vec stores it.
  console.log('');
  console.log(`  Bootstrapping ${vecTable} from chunks.embedding ...`);

  const BATCH = 200;
  const selectSql = MEETING_FILTER
    ? `SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL AND meeting_id = ? ORDER BY id`
    : `SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL ORDER BY id`;
  const insertSql = `INSERT OR REPLACE INTO ${vecTable}(chunk_id, embedding) VALUES (?, ?)`;

  const select = MEETING_FILTER
    ? db.prepare(selectSql)
    : db.prepare(selectSql);
  const insert = db.prepare(insertSql);

  let bootstrapped = 0;
  let failed = 0;
  const start = Date.now();

  const runBatch = db.transaction((rows) => {
    for (const row of rows) {
      try {
        insert.run(BigInt(row.id), row.embedding);
        bootstrapped++;
      } catch (e) {
        failed++;
        if (failed <= 3) warn(`  Failed chunk_id=${row.id}: ${e.message}`);
      }
    }
  });

  let rows;
  if (MEETING_FILTER) {
    rows = select.all(MEETING_FILTER);
  } else {
    rows = select.all();
  }

  for (let i = 0; i < rows.length; i += BATCH) {
    runBatch(rows.slice(i, i + BATCH));
    if ((i / BATCH) % 5 === 0) {
      const pct = ((i + rows.slice(i, i + BATCH).length) / rows.length * 100).toFixed(1);
      process.stdout.write(`\r  progress: ${pct}%  (${bootstrapped} inserted, ${failed} failed)   `);
    }
  }
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log('');
  console.log('');
  if (failed === 0) {
    ok(`Bootstrapped ${bootstrapped} row(s) into ${vecTable} in ${elapsed}s`);
  } else {
    warn(`Bootstrapped ${bootstrapped} row(s); ${failed} failed in ${elapsed}s`);
  }

  const finalCount = db.prepare(`SELECT COUNT(*) AS c FROM ${vecTable}`).get().c;
  console.log(`  ${vecTable} row count: ${finalCount}`);
  console.log('');

  if (failed === 0 && finalCount === total) {
    console.log('─'.repeat(64));
    console.log('✓ KNN index fully populated — retrieval should now work immediately.');
    console.log('─'.repeat(64));
    process.exit(0);
  } else {
    console.log('─'.repeat(64));
    console.log('⚠ Bootstrap incomplete — see warnings above.');
    console.log('─'.repeat(64));
    process.exit(1);
  }
})().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
