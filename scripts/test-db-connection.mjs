// scripts/test-db-connection.mjs
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;
const connectionString = process.env.POSTGRES_KB_URL;

if (!connectionString) {
  console.error('❌ ERROR: POSTGRES_KB_URL is not set in .env');
  process.exit(1);
}

// Parse host and db without exposing password
let safeHost = 'unknown';
let safeDb = 'unknown';
try {
  const parsed = new URL(connectionString);
  safeHost = `${parsed.hostname}:${parsed.port || '5432'}`;
  safeDb = parsed.pathname.replace(/^\//, '');
} catch {
  // If parsing fails, don't log raw string
}

console.log(`Testing connection to PostgreSQL target: ${safeHost} (Database: ${safeDb})...`);

const pool = new Pool({
  connectionString,
  connectionTimeoutMillis: 8000,
  ssl: connectionString.includes('sslmode=disable') ? false : { rejectUnauthorized: false },
});

async function testConnection() {
  let client;
  try {
    client = await pool.connect();
    console.log('✅ Connection to PostgreSQL established successfully!');

    // Check version
    const versionRes = await client.query('SELECT version();');
    console.log('📊 Server Version:', versionRes.rows[0].version.split(',')[0]);

    // Check pgvector extension
    const extRes = await client.query("SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';");
    if (extRes.rows.length > 0) {
      console.log(`✅ pgvector extension is ENABLED! (Version: ${extRes.rows[0].extversion})`);
    } else {
      console.warn('⚠️ WARNING: pgvector extension is NOT yet enabled on this database.');
      console.warn('Attempting to enable pgvector extension (CREATE EXTENSION IF NOT EXISTS vector)...');
      try {
        await client.query('CREATE EXTENSION IF NOT EXISTS vector;');
        console.log('✅ Successfully created and enabled pgvector extension!');
      } catch (extErr) {
        console.error('❌ Could not enable pgvector automatically:', extErr.message);
        console.error('Please ask your DevOps to run: CREATE EXTENSION IF NOT EXISTS vector;');
      }
    }

    client.release();
    await pool.end();
    console.log('\n🎉 Everything looks ready for migration!');
  } catch (err) {
    console.error('❌ Connection test failed:', err.message);
    if (client) client.release();
    await pool.end();
    process.exit(1);
  }
}

testConnection();
