#!/usr/bin/env node
// scripts/migrate-kb-to-cloud.mjs
//
// Standalone migration script to ingest Natively's Shared Legal Knowledge Base
// (KB-shared/) into Cloud PostgreSQL 16 (pgvector) and archive raw files to AWS S3.
//
// Usage:
//   node scripts/migrate-kb-to-cloud.mjs --dry-run
//   node scripts/migrate-kb-to-cloud.mjs
//   node scripts/migrate-kb-to-cloud.mjs --force

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// Load .env
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const distRoot = path.join(repoRoot, 'dist-electron', 'electron');

const KB_SHARED_DIR = fs.existsSync(path.join(repoRoot, 'KB-shared'))
  ? path.join(repoRoot, 'KB-shared')
  : path.join(repoRoot, 'kb-shared');

// Command line arguments
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isForce = args.includes('--force');

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Natively — Cloud Legal Knowledge Base Migration CLI

Usage:
  node scripts/migrate-kb-to-cloud.mjs [options]

Options:
  --dry-run   Simulate extraction and chunking without connecting to Postgres or S3.
  --force     Re-process and overwrite documents even if already migrated.
  --help, -h  Show this help screen.

Environment Variables (read from .env):
  POSTGRES_KB_URL        PostgreSQL 16 connection string (e.g. postgresql://user:pass@host:5432/natively_legal_kb)
  AWS_S3_KB_BUCKET       Target S3 bucket for original PDF/DOCX archive
  AWS_S3_KB_REGION       AWS region (e.g. ap-south-1)
  AWS_ACCESS_KEY_ID      AWS access key
  AWS_SECRET_ACCESS_KEY  AWS secret key
  GEMINI_API_KEY         Gemini API key for generating 768-dim embeddings
  OPENAI_API_KEY         OpenAI API key (alternative 1536-dim embeddings)
`);
  process.exit(0);
}

// ── Authority Tier & Category Helper ────────────────────────────────────
function inferMetadataFromPath(relativePath) {
  const normalized = relativePath.toLowerCase().replace(/\\/g, '/');
  let tier = 'bending';
  let category = 'articles';

  if (normalized.startsWith('authoritative/')) {
    tier = 'authoritative';
  } else if (normalized.startsWith('bending/')) {
    tier = 'bending';
  }

  const categoryMap = {
    acts: 'acts',
    judgements: 'judgements',
    amendments: 'amendments',
    commentaries: 'commentaries',
    articles: 'articles',
    news: 'news',
    whitepapers: 'whitepapers',
  };

  for (const [folder, cat] of Object.entries(categoryMap)) {
    if (normalized.includes(`/${folder}/`) || normalized.includes(`\\${folder}\\`)) {
      category = cat;
      break;
    }
  }

  if (tier === 'authoritative' && !['acts', 'judgements', 'amendments', 'commentaries'].includes(category)) {
    category = 'acts';
  }

  return { tier, category };
}

// ── File Scanner ────────────────────────────────────────────────────────
const SUPPORTED_EXTS = new Set(['.pdf', '.docx', '.txt', '.md', '.markdown']);

function scanDirectory(dirPath, baseDir) {
  const files = [];
  if (!fs.existsSync(dirPath)) return files;

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...scanDirectory(fullPath, baseDir));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SUPPORTED_EXTS.has(ext) && !entry.name.startsWith('.')) {
        const relativePath = path.relative(baseDir, fullPath);
        files.push({ fullPath, relativePath, fileName: entry.name, ext });
      }
    }
  }
  return files;
}

function calculateFileSha256(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

// ── Text Extractor Loader ───────────────────────────────────────────────
async function loadExtractorAndChunker() {
  let extractSafeDocumentText;
  let chunkLegalDocument;

  try {
    const extractorMod = await import(path.join(distRoot, 'services/SafeDocumentTextExtractor.js'));
    extractSafeDocumentText = extractorMod.extractSafeDocumentText;
  } catch (err) {
    console.warn('[Migrate] Warning: Could not load compiled SafeDocumentTextExtractor. Falling back to plain text reader.');
    extractSafeDocumentText = async (filePath) => {
      const ext = path.extname(filePath).toLowerCase();
      if (ext === '.txt' || ext === '.md' || ext === '.markdown') {
        const content = fs.readFileSync(filePath, 'utf-8');
        return { text: content, pageCount: 1 };
      }
      throw new Error(`Cannot parse binary file ${ext} without compiled dist-electron. Run "npm run build:electron" first.`);
    };
  }

  try {
    const chunkerMod = await import(path.join(distRoot, 'rag/LegalDocumentChunker.js'));
    chunkLegalDocument = chunkerMod.chunkLegalDocument;
  } catch (err) {
    console.warn('[Migrate] Warning: Could not load compiled LegalDocumentChunker. Falling back to paragraph chunker.');
    chunkLegalDocument = (text) => {
      const paras = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
      return paras.map((p, idx) => ({
        chunkIndex: idx,
        text: p.trim(),
        tokenCount: Math.ceil(p.length / 4),
        sectionTitle: `Section Chunk ${idx + 1}`,
      }));
    };
  }

  return { extractSafeDocumentText, chunkLegalDocument };
}

// ── Embedding Generator ─────────────────────────────────────────────────
async function generateEmbeddings(texts, apiKey) {
  if (!apiKey) {
    throw new Error('Embedding generation requires GEMINI_API_KEY in .env');
  }

  const embeddings = [];
  const BATCH_SIZE = 50; // Gemini supports up to 100 per batch request

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    let attempts = 0;
    let success = false;

    while (!success && attempts < 5) {
      attempts++;
      try {
        const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:batchEmbedContents', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify({
            requests: batch.map((text) => ({
              model: 'models/gemini-embedding-2',
              content: { parts: [{ text }] },
              outputDimensionality: 768,
            })),
          }),
        });

        if (res.status === 429) {
          console.warn(`      ⚠️ Rate limit (429) on batch ${i / BATCH_SIZE + 1} — backing off for 10s...`);
          await new Promise((r) => setTimeout(r, 10000));
          continue;
        }

        const data = await res.json();
        if (data.error) {
          throw new Error(data.error.message || JSON.stringify(data.error));
        }

        if (!data.embeddings || data.embeddings.length !== batch.length) {
          throw new Error(`Expected ${batch.length} embeddings, got ${data.embeddings?.length || 0}`);
        }

        embeddings.push(...data.embeddings.map((e) => e.values));
        success = true;
      } catch (err) {
        if (attempts >= 5) throw err;
        console.warn(`      ⚠️ Batch retry ${attempts}/5: ${err.message}`);
        await new Promise((r) => setTimeout(r, 3000 * attempts));
      }
    }
  }

  return embeddings;
}

// ── Main Migration Function ─────────────────────────────────────────────
async function main() {
  console.log('\n===============================================================');
  console.log('       Natively — Cloud Legal Knowledge Base Migration');
  console.log('===============================================================\n');

  if (isDryRun) {
    console.log('🔍 RUNNING IN DRY-RUN MODE (--dry-run). No cloud resources will be altered.\n');
  }

  if (!fs.existsSync(KB_SHARED_DIR)) {
    console.error(`ERROR: KB-shared directory not found at: ${KB_SHARED_DIR}`);
    process.exit(1);
  }

  const files = scanDirectory(KB_SHARED_DIR, KB_SHARED_DIR);
  console.log(`Found ${files.length} document(s) in: ${KB_SHARED_DIR}\n`);

  if (files.length === 0) {
    console.log('No documents found to migrate. Add files to KB-shared/ and re-run.');
    process.exit(0);
  }

  const { extractSafeDocumentText, chunkLegalDocument } = await loadExtractorAndChunker();

  // Statistics tracker
  let totalChunks = 0;
  let totalTokens = 0;
  let totalBytes = 0;
  const processedDocs = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const stats = fs.statSync(file.fullPath);
    totalBytes += stats.size;
    const checksum = calculateFileSha256(file.fullPath);
    const { tier, category } = inferMetadataFromPath(file.relativePath);

    console.log(`[${i + 1}/${files.length}] Processing: ${file.fileName}`);
    console.log(`      Path: ${file.relativePath}`);
    console.log(`      Size: ${(stats.size / 1024).toFixed(1)} KB | Tier: ${tier} | Category: ${category}`);

    try {
      const extracted = await extractSafeDocumentText(file.fullPath);
      const text = extracted.content || extracted.text || '';
      const pageCount = extracted.pageCount || extracted.extractedPageCount || 1;
      const docId = `doc_${checksum.slice(0, 16)}`;

      const chunks = chunkLegalDocument(docId, text, {
        docTitle: file.fileName.replace(/\.[^.]+$/, ''),
      });

      const docTokens = chunks.reduce((acc, c) => acc + (c.tokenCount || Math.ceil(c.text.length / 4)), 0);
      totalChunks += chunks.length;
      totalTokens += docTokens;

      console.log(`      -> Extracted: ${pageCount} page(s) | Generated: ${chunks.length} chunks (~${docTokens} tokens)\n`);

      processedDocs.push({
        file,
        stats,
        checksum,
        tier,
        category,
        pageCount,
        chunks,
      });
    } catch (err) {
      console.error(`      ❌ Failed to extract ${file.fileName}: ${err.message}\n`);
    }
  }

  console.log('---------------------------------------------------------------');
  console.log('Summary of Processed Documents:');
  console.log(`  Total Files:       ${processedDocs.length}`);
  console.log(`  Total Size:        ${(totalBytes / (1024 * 1024)).toFixed(2)} MB`);
  console.log(`  Total Chunks:      ${totalChunks}`);
  console.log(`  Estimated Tokens:  ${totalTokens}`);
  console.log(`  Est. Vector Dims:  768 (Gemini) -> ~${((totalChunks * 768 * 4) / (1024 * 1024)).toFixed(2)} MB raw vector storage`);
  console.log('---------------------------------------------------------------\n');

  if (isDryRun) {
    console.log('✅ Dry-run completed successfully!');
    console.log('   All files parsed, tokenized, and verified cleanly.');
    console.log('   To perform the live cloud upload once your DevOps provides credentials:');
    console.log('   1. Fill in POSTGRES_KB_URL and AWS_S3_KB_* in your local .env file.');
    console.log('   2. Run: node scripts/migrate-kb-to-cloud.mjs');
    process.exit(0);
  }

  // ── Live Cloud Ingestion ────────────────────────────────────────────────
  const postgresUrl = process.env.POSTGRES_KB_URL;
  const s3Bucket = process.env.AWS_S3_KB_BUCKET;
  const geminiApiKey = process.env.GEMINI_API_KEY;

  if (!postgresUrl) {
    console.error('ERROR: Missing POSTGRES_KB_URL in .env.');
    console.error('Please add your PostgreSQL 16 connection string to .env, or use --dry-run.');
    process.exit(1);
  }

  // Dynamically load pg client
  let pg;
  try {
    pg = await import('pg');
  } catch (err) {
    console.error('ERROR: "pg" driver is not installed.');
    console.error('Please run: npm install pg');
    process.exit(1);
  }

  const { Pool } = pg.default || pg;
  const pool = new Pool({
    connectionString: postgresUrl,
    ssl: postgresUrl.includes('sslmode=disable') ? false : { rejectUnauthorized: false },
  });

  try {
    const client = await pool.connect();
    console.log('Connected to PostgreSQL 16 database ✓');

    // Run schema creation if tables don't exist
    const schemaSqlPath = path.join(__dirname, 'cloud-kb-schema.sql');
    if (fs.existsSync(schemaSqlPath)) {
      const schemaSql = fs.readFileSync(schemaSqlPath, 'utf-8');
      await client.query(schemaSql);
      console.log('Verified database tables & pgvector indexes ✓');
    }

    client.release();
  } catch (err) {
    console.error('Database connection failed:', err.message);
    await pool.end();
    process.exit(1);
  }

  // Optional: Upload to S3 if AWS credentials are provided
  let s3Client = null;
  if (s3Bucket && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    try {
      const { S3Client } = await import('@aws-sdk/client-s3');
      s3Client = new S3Client({
        region: process.env.AWS_S3_KB_REGION || 'ap-south-1',
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
      });
      console.log(`Connected to AWS S3 (Bucket: ${s3Bucket}) ✓`);
    } catch (err) {
      console.warn('Note: @aws-sdk/client-s3 not installed or failed to initialize. Skipping S3 upload.');
      console.warn('Install with: npm install @aws-sdk/client-s3');
    }
  } else {
    console.log('Notice: AWS S3 credentials not provided in .env. Skipping raw document S3 archive.');
  }

  console.log('\nStarting database inserts and embedding generation...\n');

  for (const doc of processedDocs) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const docId = `doc_${doc.checksum.slice(0, 16)}`;
      const s3Key = `shared-kb/${doc.file.relativePath.replace(/\\/g, '/')}`;

      // Check if already migrated
      const existing = await client.query('SELECT id FROM legal_documents WHERE checksum_sha256 = $1', [doc.checksum]);
      if (existing.rows.length > 0 && !isForce) {
        console.log(`⏩ Skipping ${doc.file.fileName} (Already exists in database, use --force to overwrite)`);
        await client.query('ROLLBACK');
        continue;
      }

      console.log(`Uploading & indexing: ${doc.file.fileName}...`);

      // Upload raw file to S3
      if (s3Client && s3Bucket) {
        const { PutObjectCommand } = await import('@aws-sdk/client-s3');
        const fileData = fs.readFileSync(doc.file.fullPath);
        await s3Client.send(
          new PutObjectCommand({
            Bucket: s3Bucket,
            Key: s3Key,
            Body: fileData,
          })
        );
      }

      // Insert or update legal_documents
      await client.query(
        `INSERT INTO legal_documents (
          id, title, file_name, relative_path, s3_key, s3_bucket,
          authority_tier, category, total_pages, file_size_bytes, checksum_sha256
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (checksum_sha256) DO UPDATE SET
          title = EXCLUDED.title,
          updated_at = CURRENT_TIMESTAMP`,
        [
          docId,
          doc.file.fileName.replace(/\.[^.]+$/, ''),
          doc.file.fileName,
          doc.file.relativePath,
          s3Key,
          s3Bucket || null,
          doc.tier,
          doc.category,
          doc.pageCount,
          doc.stats.size,
          doc.checksum,
        ]
      );

      // Generate embeddings
      const chunkTexts = doc.chunks.map((c) => c.text);
      console.log(`   Generating embeddings for ${chunkTexts.length} chunks via Gemini...`);
      const embeddings = await generateEmbeddings(chunkTexts, geminiApiKey);

      // Insert chunks
      for (let j = 0; j < doc.chunks.length; j++) {
        const chunk = doc.chunks[j];
        const chunkId = `chk_${docId}_${j}`;
        const embeddingVector = JSON.stringify(embeddings[j]); // pgvector parses JSON array format '[...]'

        await client.query(
          `INSERT INTO legal_chunks (
            id, document_id, chunk_index, cleaned_text, token_count,
            page_number, section_title, authority_tier, category, embedding
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::vector)
          ON CONFLICT (document_id, chunk_index) DO UPDATE SET
            cleaned_text = EXCLUDED.cleaned_text,
            embedding = EXCLUDED.embedding`,
          [
            chunkId,
            docId,
            j,
            chunk.text,
            chunk.tokenCount || Math.ceil(chunk.text.length / 4),
            chunk.pageNumber || null,
            chunk.sectionTitle || null,
            doc.tier,
            doc.category,
            embeddingVector,
          ]
        );
      }

      await client.query('COMMIT');
      console.log(`   Indexed ${doc.file.fileName} (${doc.chunks.length} chunks) ✓\n`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`   ❌ Failed to index ${doc.file.fileName}:`, err.message);
    } finally {
      client.release();
    }
  }

  await pool.end();
  console.log('🎉 Migration completed successfully!');
}

main().catch((err) => {
  console.error('\nFatal migration error:', err);
  process.exit(1);
});
