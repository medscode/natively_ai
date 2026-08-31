// scripts/ingest-shared-kb.js
//
// Batch ingestion script for the shared legal knowledge base (kb-shared/).
// Scans the kb-shared/ folder, extracts text from PDF/DOCX/TXT/MD files,
// chunks them, embeds them, and stores them under the sentinel case ID
// `__shared_legal_kb__` so they're searchable by all lawyers.
//
// Authority tier is inferred from the folder structure:
//   kb-shared/Authoritative/*  → authoritative (Acts, Judgements, etc.)
//   kb-shared/bending/*        → bending (Articles, News, etc.)
//
// Run:  npm run ingest-kb
// Which executes:  ./node_modules/.bin/electron scripts/ingest-shared-kb.js
//
// Re-running is safe — files are identified by SHA-256 hash. Already-ingested
// files are skipped. Only new or changed files are processed.

'use strict';
const nodePath = require('node:path');
const nodeFs = require('node:fs');
const nodeOs = require('node:os');
const nodeCrypto = require('node:crypto');
const { app } = require('electron');

const repoRoot = nodePath.resolve(__dirname, '..');
const distRoot = nodePath.join(repoRoot, 'dist-electron', 'electron');
const KB_SHARED_DIR = nodePath.join(repoRoot, 'kb-shared');

// ── Constants ─────────────────────────────────────────────────────────
const SHARED_KB_CASE_ID = '__shared_legal_kb__';
const SHARED_KB_CASE_NAME = 'Shared Legal Knowledge Base';

// Supported file extensions (must match SafeDocumentTextExtractor)
const SUPPORTED_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.csv', '.tsv',
  '.xml', '.html', '.htm', '.pdf', '.docx',
]);

// Authority tier hierarchy (highest priority first)
const CATEGORY_LABELS = {
  acts: 'Authoritative — Acts & Statutes',
  judgements: 'Authoritative — Judgements',
  amendments: 'Authoritative — Amendments',
  commentaries: 'Authoritative — Commentaries',
  articles: 'Bending — Articles',
  whitepapers: 'Bending — Whitepapers',
  news: 'Bending — News',
};

// ── Helpers ───────────────────────────────────────────────────────────

function inferAuthorityFromPath(relativePath) {
  const lower = relativePath.toLowerCase().replace(/\\/g, '/');
  let tier = 'bending';
  let category = 'articles';

  if (lower.startsWith('authoritative/')) {
    tier = 'authoritative';
  } else if (lower.startsWith('bending/')) {
    tier = 'bending';
  }

  // Infer category from sub-folder name
  const categoryMap = {
    'acts': 'acts',
    'judgements': 'judgements',
    'amendments': 'amendments',
    'commentaries': 'commentaries',
    'articles': 'articles',
    'news': 'news',
    'whitepapers': 'whitepapers',
  };
  for (const [folder, cat] of Object.entries(categoryMap)) {
    if (lower.includes(`/${folder}/`) || lower.includes(`\\${folder}\\`)) {
      category = cat;
      break;
    }
  }

  // Files directly in Authoritative/ without a sub-folder default to 'acts'
  if (tier === 'authoritative' && !['acts', 'judgements', 'amendments', 'commentaries'].includes(category)) {
    category = 'acts';
  }

  return { tier, category };
}

function scanDirectory(dirPath, baseDir) {
  const files = [];
  if (!nodeFs.existsSync(dirPath)) return files;

  const entries = nodeFs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = nodePath.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...scanDirectory(fullPath, baseDir));
    } else if (entry.isFile()) {
      const ext = nodePath.extname(entry.name).toLowerCase();
      if (SUPPORTED_EXTENSIONS.has(ext) && !entry.name.startsWith('.')) {
        const relativePath = nodePath.relative(baseDir, fullPath);
        files.push({ fullPath, relativePath, fileName: entry.name, ext });
      }
    }
  }
  return files;
}

function hashFile(filePath) {
  const binary = nodeFs.readFileSync(filePath);
  return nodeCrypto.createHash('sha256').update(binary).digest('hex');
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  await app.whenReady();

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║          Natively — Shared Legal KB Ingestion               ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  // Verify kb-shared/ exists
  if (!nodeFs.existsSync(KB_SHARED_DIR)) {
    console.error(`ERROR: kb-shared/ directory not found at: ${KB_SHARED_DIR}`);
    console.error('Create it and add your legal documents before running this script.');
    process.exit(1);
  }

  // Scan for files
  console.log(`📂 Scanning: ${KB_SHARED_DIR}`);
  const files = scanDirectory(KB_SHARED_DIR, KB_SHARED_DIR);
  console.log(`   Found ${files.length} supported file(s)\n`);

  if (files.length === 0) {
    console.log('No files to ingest. Add PDF/DOCX/TXT/MD files to kb-shared/ and re-run.');
    process.exit(0);
  }

  // Print what we found
  for (const file of files) {
    const { tier, category } = inferAuthorityFromPath(file.relativePath);
    console.log(`   ${tier === 'authoritative' ? '📖' : '⚠️ '} ${file.fileName}`);
    console.log(`      Path: ${file.relativePath}`);
    console.log(`      Tier: ${CATEGORY_LABELS[category] || category}`);
  }
  console.log('');

  // Load the built modules
  let DatabaseManager, KnowledgeBaseManager, extractSafeDocumentText, EmbeddingPipeline, VectorStore;
  try {
    DatabaseManager = require(nodePath.join(distRoot, 'db/DatabaseManager.js')).DatabaseManager;
    KnowledgeBaseManager = require(nodePath.join(distRoot, 'rag/KnowledgeBaseManager.js')).KnowledgeBaseManager;
    extractSafeDocumentText = require(nodePath.join(distRoot, 'services/SafeDocumentTextExtractor.js')).extractSafeDocumentText;
    EmbeddingPipeline = require(nodePath.join(distRoot, 'rag/EmbeddingPipeline.js')).EmbeddingPipeline;
    VectorStore = require(nodePath.join(distRoot, 'rag/VectorStore.js')).VectorStore;
  } catch (e) {
    console.error('ERROR: Could not load built modules. Run "npm run build:electron" first.');
    console.error(e.message);
    process.exit(1);
  }

  // Initialize DB
  const dm = DatabaseManager.getInstance();
  const db = dm.getDb();
  if (!db) {
    console.error('ERROR: Database not available');
    process.exit(1);
  }

  // Initialize KB Manager
  const kb = KnowledgeBaseManager.getInstance();
  const vs = new VectorStore(db);
  const ep = new EmbeddingPipeline(db, vs);

  // Load API keys/settings if available, or gracefully use local on-device MiniLM embeddings
  let config = {};
  try {
    const { SettingsManager } = require(nodePath.join(distRoot, 'services/SettingsManager.js'));
    const { CredentialsManager } = require(nodePath.join(distRoot, 'services/CredentialsManager.js'));
    const sm = SettingsManager.getInstance();
    const cm = CredentialsManager.getInstance();
    const creds = cm.getCredentials() || {};
    config = {
      geminiKey: creds.geminiKey || sm.get('geminiApiKey') || process.env.GEMINI_API_KEY,
      openaiKey: creds.openaiKey || sm.get('openaiApiKey') || process.env.OPENAI_API_KEY,
      ollamaUrl: sm.get('ollamaUrl'),
    };
  } catch { /* use local fallback */ }

  await ep.initialize(config);
  kb.setPipeline(vs, ep);

  // Ensure the sentinel client case + meeting row exists
  console.log('🔧 Ensuring shared KB case exists...');
  kb.createClientCase({
    id: SHARED_KB_CASE_ID,
    name: SHARED_KB_CASE_NAME,
    company: 'Shared across all lawyers',
    notes: 'Global legal knowledge base — Acts, Judgements, Commentaries, Articles, etc.',
  });

  // Check which files are already ingested (by hash in knowledge_sources metadata_json)
  let existingHashes = new Set();
  try {
    const existing = db.prepare(
      `SELECT metadata_json FROM knowledge_sources WHERE client_case_id = ?`
    ).all(SHARED_KB_CASE_ID);
    for (const row of existing) {
      try {
        const meta = JSON.parse(row.metadata_json || '{}');
        if (meta.file_hash) existingHashes.add(meta.file_hash);
      } catch { /* ignore */ }
    }
    console.log(`   ${existingHashes.size} file(s) already ingested\n`);
  } catch { /* ignore — table may not exist yet */ }

  // Ingest files
  let ingested = 0;
  let skipped = 0;
  let failed = 0;
  let totalChunks = 0;

  for (const file of files) {
    const fileHash = hashFile(file.fullPath);
    if (existingHashes.has(fileHash)) {
      console.log(`  ⏭  SKIP (unchanged): ${file.fileName}`);
      skipped++;
      continue;
    }

    const { tier, category } = inferAuthorityFromPath(file.relativePath);
    console.log(`  ⏳ Ingesting: ${file.fileName} [${tier}/${category}]`);

    try {
      const result = await kb.addSource({
        clientCaseId: SHARED_KB_CASE_ID,
        sourceType: 'file',
        sourcePath: file.fullPath,
        title: file.fileName.replace(/\.[^.]+$/, ''), // strip extension for title
        id: `shared_${fileHash.slice(0, 16)}`,
        metadata: {
          authority_tier: tier,
          source_category: category,
          file_hash: fileHash,
          file_path: file.relativePath,
          shared_kb: true,
        },
      });

      if (!result.success) {
        console.log(`  ❌ FAILED: ${file.fileName} — ${result.error}`);
        failed++;
        continue;
      }

      // Count chunks
      try {
        const chunkCount = db.prepare(
          `SELECT COUNT(*) as cnt FROM chunks WHERE meeting_id = ?`
        ).get(SHARED_KB_CASE_ID);
        const currentChunks = chunkCount?.cnt || 0;
        console.log(`  ✅ OK: ${file.fileName} — total chunks in KB: ${currentChunks}`);
      } catch { /* ignore */ }

      ingested++;
    } catch (e) {
      console.log(`  ❌ ERROR: ${file.fileName} — ${e.message}`);
      failed++;
    }
  }

  // Wait for embedding pipeline to process
  if (ingested > 0) {
    console.log('\n⏳ Processing embeddings for newly ingested chunks...');
    try {
      await ep.processQueue();

      // Poll until queue is drained or timeout (max 120s)
      const maxWaitMs = 120000;
      const startWait = Date.now();
      while (Date.now() - startWait < maxWaitMs) {
        const pending = db.prepare(
          `SELECT COUNT(*) as cnt FROM embedding_queue WHERE meeting_id = ? AND status IN ('pending', 'processing')`
        ).get(SHARED_KB_CASE_ID)?.cnt || 0;

        const embedded = db.prepare(
          `SELECT COUNT(*) as cnt FROM chunks WHERE meeting_id = ? AND embedding IS NOT NULL`
        ).get(SHARED_KB_CASE_ID)?.cnt || 0;

        const total = db.prepare(
          `SELECT COUNT(*) as cnt FROM chunks WHERE meeting_id = ?`
        ).get(SHARED_KB_CASE_ID)?.cnt || 0;

        process.stdout.write(`\r   Progress: ${embedded}/${total} chunks embedded (${pending} in queue)...`);

        if (pending === 0 || embedded >= total) break;
        await new Promise(r => setTimeout(r, 1000));
      }
      console.log('');

      const embeddedCount = db.prepare(
        `SELECT COUNT(*) as cnt FROM chunks WHERE meeting_id = ? AND embedding IS NOT NULL`
      ).get(SHARED_KB_CASE_ID);
      const totalCount = db.prepare(
        `SELECT COUNT(*) as cnt FROM chunks WHERE meeting_id = ?`
      ).get(SHARED_KB_CASE_ID);
      totalChunks = totalCount?.cnt || 0;
      console.log(`   Final: ${embeddedCount?.cnt || 0}/${totalChunks} chunks embedded.`);
    } catch (e) {
      console.warn('   Embedding check note:', e.message);
    }
  }

  // Summary
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║                      INGESTION SUMMARY                      ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Total files scanned:  ${String(files.length).padStart(5)}                               ║`);
  console.log(`║  Newly ingested:       ${String(ingested).padStart(5)}                               ║`);
  console.log(`║  Skipped (unchanged):  ${String(skipped).padStart(5)}                               ║`);
  console.log(`║  Failed:               ${String(failed).padStart(5)}                               ║`);
  console.log(`║  Total chunks in KB:   ${String(totalChunks).padStart(5)}                               ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  // List knowledge_sources
  try {
    const sources = db.prepare(
      `SELECT title, metadata_json FROM knowledge_sources WHERE client_case_id = ? ORDER BY created_at`
    ).all(SHARED_KB_CASE_ID);
    if (sources.length > 0) {
      console.log('📚 Sources in shared KB:');
      for (const src of sources) {
        const meta = JSON.parse(src.metadata_json || '{}');
        const tierIcon = meta.authority_tier === 'authoritative' ? '📖' : '⚠️ ';
        console.log(`   ${tierIcon} ${src.title} [${meta.source_category || 'unknown'}]`);
      }
    }
  } catch { /* ignore */ }

  console.log('\nDone. Exiting.');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
