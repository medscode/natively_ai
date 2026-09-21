-- scripts/cloud-kb-schema.sql
-- PostgreSQL 16 + pgvector DDL Schema for Natively Shared Legal Knowledge Base
--
-- This schema stores statutory acts, judgements, amendments, and legal commentaries.
-- It supports:
--   1. Sub-50ms HNSW vector similarity search via pgvector (vector_cosine_ops).
--   2. Full-text search (BM25 hybrid ranking via PostgreSQL tsvector).
--   3. Two-tier legal authority hierarchy (authoritative vs bending).
--   4. Document-level tracking with S3 archive links and SHA-256 deduplication.

-- 1. Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Documents table (Acts, Judgements, Codes)
CREATE TABLE IF NOT EXISTS legal_documents (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    file_name TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    s3_key TEXT,
    s3_bucket TEXT,
    authority_tier TEXT NOT NULL CHECK (authority_tier IN ('authoritative', 'bending')),
    category TEXT NOT NULL CHECK (category IN (
        'acts', 'judgements', 'amendments', 'commentaries',
        'articles', 'whitepapers', 'news'
    )),
    total_pages INTEGER,
    file_size_bytes BIGINT,
    checksum_sha256 TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Index for category / authority tier filtering
CREATE INDEX IF NOT EXISTS idx_legal_docs_tier ON legal_documents(authority_tier);
CREATE INDEX IF NOT EXISTS idx_legal_docs_category ON legal_documents(category);

-- 3. Legal Chunks table (stores text + 768-dim embeddings for Gemini or 1536-dim for OpenAI)
-- Default is 768 dimensions (Gemini text-embedding-004 / standard)
CREATE TABLE IF NOT EXISTS legal_chunks (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES legal_documents(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    cleaned_text TEXT NOT NULL,
    token_count INTEGER NOT NULL,
    page_number INTEGER,
    section_title TEXT,
    authority_tier TEXT NOT NULL CHECK (authority_tier IN ('authoritative', 'bending')),
    category TEXT NOT NULL,
    embedding vector(768),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(document_id, chunk_index)
);

-- 4. HNSW Vector Index for fast cosine similarity search
CREATE INDEX IF NOT EXISTS idx_legal_chunks_embedding_hnsw 
ON legal_chunks USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- 5. Foreign Key & Query Filter Indexes
CREATE INDEX IF NOT EXISTS idx_legal_chunks_doc_id ON legal_chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_legal_chunks_tier_cat ON legal_chunks(authority_tier, category);

-- 6. Full-Text Search Index (GIN) for hybrid lexical + semantic search
CREATE INDEX IF NOT EXISTS idx_legal_chunks_fts 
ON legal_chunks USING gin(to_tsvector('english', cleaned_text));
