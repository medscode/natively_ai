// scripts/test-cloud-retrieval.mjs
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;
const connectionString = process.env.POSTGRES_KB_URL;
const apiKey = process.env.GEMINI_API_KEY;

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  console.log('\n--- Verifying Cloud Vector Database Query ---');
  
  // 1. Verify counts in Postgres
  const docCount = await pool.query('SELECT count(*) FROM legal_documents');
  const chunkCount = await pool.query('SELECT count(*) FROM legal_chunks');
  console.log(`📊 Documents in Cloud DB: ${docCount.rows[0].count}`);
  console.log(`📊 Chunks in Cloud DB:    ${chunkCount.rows[0].count}`);

  // 2. Perform a real semantic search
  const query = 'What are the conditions for a valid will and execution under the Indian Succession Act?';
  console.log(`\n🔍 Test Query: "${query}"`);

  // Generate embedding for query
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:batchEmbedContents', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      requests: [{
        model: 'models/gemini-embedding-2',
        content: { parts: [{ text: `task: search result | query: ${query}` }] },
        outputDimensionality: 768,
      }],
    }),
  });

  const data = await res.json();
  const vectorStr = JSON.stringify(data.embeddings[0].values);

  const startMs = Date.now();
  const searchRes = await pool.query(`
    SELECT 
      c.id, c.cleaned_text, c.section_title, c.authority_tier, c.category,
      d.title as doc_title,
      (1 - (c.embedding <=> $1::vector)) as similarity
    FROM legal_chunks c
    JOIN legal_documents d ON c.document_id = d.id
    ORDER BY c.embedding <=> $1::vector ASC
    LIMIT 3
  `, [vectorStr]);
  const latencyMs = Date.now() - startMs;

  console.log(`⚡ Query Latency: ${latencyMs}ms\n`);
  console.log('Top Results:');
  searchRes.rows.forEach((r, idx) => {
    console.log(`\n[Result ${idx + 1}] Similarity: ${(parseFloat(r.similarity) * 100).toFixed(1)}%`);
    console.log(`Document: ${r.doc_title}`);
    console.log(`Section:  ${r.section_title || 'N/A'}`);
    console.log(`Snippet:  ${r.cleaned_text.slice(0, 160).replace(/\n/g, ' ')}...`);
  });

  await pool.end();
  console.log('\n✅ Cloud Vector Search Verified Successfully!');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
