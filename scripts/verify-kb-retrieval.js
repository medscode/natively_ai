// scripts/verify-kb-retrieval.js
//
// Three-layer diagnostic for the shared legal KB:
//   Layer 1: file count in KB-shared/ (on-disk)
//   Layer 2: row counts in the live DB (ingested)
//   Layer 3: actual retrieval — does a real KB query return the right chunks?
//
// Usage:
//   NATIVELY_TEST_USERDATA="$HOME/Library/Application Support/natively" \
//     node scripts/verify-kb-retrieval.js [--query "what is section 302?"]
//
// Exits 0 if all 3 layers are healthy, 1 otherwise. Prints a checklist.

'use strict';
const nodePath = require('node:path');
const nodeFs = require('node:fs');

const KB_SHARED_DIR = nodeFs.existsSync(nodePath.join(repoRoot, 'KB-shared'))
  ? nodePath.join(repoRoot, 'KB-shared')
  : nodePath.join(repoRoot, 'kb-shared');
const distRoot = nodePath.join(repoRoot, 'dist-electron', 'electron');

const args = process.argv.slice(2);
const queryArgIdx = args.indexOf('--query');
const TEST_QUERY = queryArgIdx >= 0 ? args[queryArgIdx + 1] : 'what is section 302 of bharatiya nyaya sanhita?';
const SHARED_CASE = '__shared_legal_kb__';

function ok(msg) { console.log('  ✓', msg); }
function fail(msg) { console.log('  ✗', msg); }
function warn(msg) { console.log('  ⚠', msg); }

(async () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║         Shared KB — 3-Layer Retrieval Diagnostic            ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  let allPass = true;

  // ─── Layer 1: on-disk files ─────────────────────────────────────
  console.log('─── Layer 1: Files in kb-shared/ ───');
  if (!nodeFs.existsSync(KB_SHARED_DIR)) {
    fail(`kb-shared/ not found at ${KB_SHARED_DIR}`);
    allPass = false;
  } else {
    function walk(dir) {
      const out = [];
      for (const e of nodeFs.readdirSync(dir, { withFileTypes: true })) {
        const full = nodePath.join(dir, e.name);
        if (e.isDirectory()) out.push(...walk(full));
        else if (/\.(pdf|md|docx|txt|markdown)$/i.test(e.name)) out.push(full);
      }
      return out;
    }
    const files = walk(KB_SHARED_DIR);
    if (files.length === 0) {
      fail(`0 supported files under ${KB_SHARED_DIR}`);
      allPass = false;
    } else {
      ok(`${files.length} file(s) ready to ingest:`);
      for (const f of files) console.log('       •', nodePath.relative(KB_SHARED_DIR, f));
    }
  }
  console.log('');

  // ─── Layer 2: DB rows ───────────────────────────────────────────
  console.log('─── Layer 2: DB rows in live SQLite ───');
  let DatabaseManager, KnowledgeBaseManager;
  try {
    DatabaseManager = require(nodePath.join(distRoot, 'db/DatabaseManager.js')).DatabaseManager;
    KnowledgeBaseManager = require(nodePath.join(distRoot, 'rag/KnowledgeBaseManager.js')).KnowledgeBaseManager;
  } catch (e) {
    fail(`Cannot load built modules — run \`npm run build:electron\` first. (${e.message})`);
    process.exit(1);
  }

  const dm = DatabaseManager.getInstance();
  let db = dm.isAvailable() ? dm.getDb() : null;
  if (!db) {
    const err = dm.getInitError?.();
    const isAbi = /NODE_MODULE_VERSION/.test(String(err?.message || ''));
    if (isAbi) {
      warn(`better-sqlite3 ABI mismatch — falling back to \`sqlite3\` CLI for Layers 2 & 3.`);
      const dbPath = dm.getDbPath?.();
      if (!dbPath) { fail('Cannot resolve DB path'); process.exit(1); }
      // Hand off the rest of Layer 2 + Layer 3 to the CLI fallback below.
      db = { __sqliteCli: true, __dbPath: dbPath };
    } else {
      fail(`DatabaseManager not connected: ${err?.message || 'unknown'}`);
      process.exit(1);
    }
  } else {
    ok(`DB open at ${dm.getDbPath?.() || '(no getter)'}`);
  }

  // Helper that runs a SQL query via either better-sqlite3 or sqlite3 CLI fallback.
  // NOTE: sqlite3 CLI doesn't support `?` placeholders — it expects fully-inlined
  // SQL. So when we hit the CLI fallback, we substitute params into the SQL string
  // ourselves, wrapping string params in single quotes (sqlite3 CLI's only string
  // delimiter). NULL and integer params are emitted bare. This is safe ONLY
  // because every caller in this script uses the hardcoded SHARED_CASE constant
  // or numeric literals — no user-controlled strings ever reach here. Do not
  // extend this pattern to arbitrary string inputs without proper SQL escaping.
  const sqlAll = (sql, params = []) => {
    if (!db.__sqliteCli) {
      return db.prepare(sql).all(...params);
    }
    let inlined = sql;
    for (const p of params) {
      const replacement = p === null || p === undefined
        ? 'NULL'
        : typeof p === 'number'
          ? String(p)
          : `'${String(p).replace(/'/g, "''")}'`;
      inlined = inlined.replace('?', replacement);
    }
    const { execSync } = require('node:child_process');
    const escaped = db.__dbPath.replace(/"/g, '\\"');
    const cmd = `sqlite3 -separator '|' "${escaped}" "${inlined.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;
    const out = execSync(cmd, { encoding: 'utf8' });
    const lines = out.split('\n').filter(l => l.length > 0);
    if (lines.length === 0) return [];
    // Extract column aliases from the SELECT clause (best-effort, single-table
    // queries only — sufficient for this diagnostic). Falls back to c0..cN.
    const aliasMatch = inlined.match(/SELECT\s+(.+?)\s+FROM/i);
    let aliases = [];
    if (aliasMatch) {
      aliases = aliasMatch[1].split(',').map(s => {
        const m = s.trim().match(/(?:AS\s+)?["`'[]?(\w+)["`'\]]?$/i);
        return m ? m[1] : null;
      });
    }
    return lines.map(l => l.split('|')).map(arr => {
      const obj = {};
      for (let i = 0; i < arr.length; i++) {
        obj[aliases[i] || `c${i}`] = arr[i];
      }
      return obj;
    });
  };
  const sqlGet = (sql, params = []) => {
    const rows = sqlAll(sql, params);
    return rows[0];
  };

  const ks = sqlAll(`SELECT id, title, source_type, index_status FROM knowledge_sources WHERE client_case_id = ? ORDER BY created_at`, [SHARED_CASE]);
  if (ks.length === 0) {
    fail(`0 knowledge_sources rows under ${SHARED_CASE}`);
    warn(`Run \`node scripts/migrate-shared-kb.js\` and/or \`npm run ingest-kb\` to populate.`);
    allPass = false;
  } else {
    ok(`${ks.length} knowledge_source(s) under ${SHARED_CASE}:`);
    for (const r of ks) console.log(`       • ${r.title || r.c1} [${r.source_type || r.c2}] status=${r.index_status || r.c3}`);
  }

  const chunkCount = Number(sqlGet(`SELECT COUNT(*) c FROM chunks WHERE meeting_id = ?`, [SHARED_CASE])?.c || 0);
  const embeddedCount = Number(sqlGet(`SELECT COUNT(*) c FROM chunks WHERE meeting_id = ? AND embedding IS NOT NULL`, [SHARED_CASE])?.c || 0);
  if (chunkCount === 0) {
    fail(`0 chunks under ${SHARED_CASE}`);
    allPass = false;
  } else {
    if (embeddedCount === chunkCount) ok(`${chunkCount}/${chunkCount} chunks embedded (KNN ready)`);
    else if (embeddedCount > 0) warn(`${embeddedCount}/${chunkCount} chunks embedded (${chunkCount - embeddedCount} pending)`);
    else { fail(`0/${chunkCount} chunks have embeddings — KNN search will return nothing`); allPass = false; }
  }
  console.log('');

  // ─── Layer 3: live retrieval ────────────────────────────────────
  console.log(`─── Layer 3: Real retrieval (query: "${TEST_QUERY}") ───`);
  if (db.__sqliteCli) {
    fail(`Cannot exercise the real retrieval path via sqlite3 CLI fallback — needs better-sqlite3.`);
    warn(`Run this script via \`npm run app:dev\`'s renderer DevTools, or after \`npm run rebuild:native\` from the right terminal.`);
    allPass = false;
  } else {
    const kb = KnowledgeBaseManager.getInstance();
    const vs = require(nodePath.join(distRoot, 'rag/VectorStore.js')).VectorStore;
    const ep = require(nodePath.join(distRoot, 'rag/EmbeddingPipeline.js')).EmbeddingPipeline;
    kb.setPipeline(new vs(db), new ep(db, null));
    try {
      const t0 = Date.now();
      const result = await kb.querySharedAndCaseKB(TEST_QUERY, SHARED_CASE, { limit: 5, minSimilarity: 0.30 });
      const ms = Date.now() - t0;
      const chunks = result?.chunks || [];
      if (chunks.length === 0) {
        fail(`0 chunks retrieved for "${TEST_QUERY}" in ${ms}ms`);
        warn(`Either embedding model mismatch (vec_chunks_384 vs 768), or no chunks embedded yet.`);
        allPass = false;
      } else {
        ok(`${chunks.length} chunk(s) retrieved in ${ms}ms (similarity ≥ 0.30):`);
        for (const c of chunks.slice(0, 5)) {
          const sim = (c.similarity ?? c.score ?? 0).toFixed(3);
          const auth = c.authorityTier || c.tier || '?';
          const snippet = (c.text || c.snippet || '').slice(0, 140).replace(/\s+/g, ' ');
          console.log(`       [sim=${sim}] [tier=${auth}] ${c.sourceTitle || c.title || '(no title)'}`);
          console.log(`         "${snippet}${snippet.length >= 140 ? '…' : ''}"`);
        }
      }
    } catch (e) {
      fail(`Retrieval threw: ${e.message}`);
      allPass = false;
    }
  }
  console.log('');

  console.log('─'.repeat(64));
  console.log(allPass ? '✓ ALL THREE LAYERS HEALTHY' : '✗ ONE OR MORE LAYERS BROKEN — see ✗ marks above');
  console.log('─'.repeat(64));
  console.log('');
  process.exit(allPass ? 0 : 1);
})().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
