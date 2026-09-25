// electron/rag/CloudLegalRetriever.ts
//
// Cloud-backed Legal Retriever using PostgreSQL 16 + pgvector.
// Queries the centralized Shared Legal Knowledge Base (Acts, Judgements, etc.)
// with sub-50ms HNSW cosine similarity search, authority boosting, and
// automatic offline fallback to local SQLite (natively.db).

import type { AuthorityTier, SourceCategory, AuthorityScoredChunk } from './KnowledgeBaseManager';
import { AUTHORITY_BOOST } from './KnowledgeBaseManager';

export interface CloudSearchOptions {
    limit?: number;
    minSimilarity?: number;
    category?: SourceCategory;
    tier?: AuthorityTier;
}

export class CloudLegalRetriever {
    private static instance: CloudLegalRetriever | null = null;
    private pool: any = null;
    private isAvailable: boolean | null = null;
    private lastCheckTime = 0;
    private readonly RETRY_INTERVAL_MS = 60_000; // 1 min before re-probing if offline

    private constructor() {}

    public static getInstance(): CloudLegalRetriever {
        if (!CloudLegalRetriever.instance) {
            CloudLegalRetriever.instance = new CloudLegalRetriever();
        }
        return CloudLegalRetriever.instance;
    }

    /**
     * Lazily initializes the PostgreSQL connection pool.
     */
    private async getPool(): Promise<any | null> {
        const PROD_KB_URL = 'postgresql://admin:8IrDxroMls19g9sq@65.2.123.187:5432/natively_db';
        const connectionString = process.env.POSTGRES_KB_URL || PROD_KB_URL;
        if (!connectionString) {
            this.isAvailable = false;
            return null;
        }

        if (this.pool) return this.pool;

        try {
            // @ts-ignore
            const pg: any = await import('pg');
            const { Pool } = pg.default || pg;
            this.pool = new Pool({
                connectionString,
                connectionTimeoutMillis: 5000,
                max: 5,
                idleTimeoutMillis: 30000,
                ssl: connectionString.includes('sslmode=disable') ? false : { rejectUnauthorized: false },
            });

            this.pool.on('error', (err: any) => {
                console.warn('[CloudLegalRetriever] PostgreSQL idle client error (non-fatal):', err.message);
            });

            return this.pool;
        } catch (err: any) {
            console.warn('[CloudLegalRetriever] Could not initialize PostgreSQL pool:', err.message);
            this.isAvailable = false;
            return null;
        }
    }

    /**
     * Checks if the cloud PostgreSQL database is configured and reachable.
     */
    public async checkHealth(): Promise<boolean> {
        const now = Date.now();
        if (this.isAvailable !== null && now - this.lastCheckTime < this.RETRY_INTERVAL_MS) {
            return this.isAvailable;
        }

        this.lastCheckTime = now;
        const pool = await this.getPool();
        if (!pool) {
            this.isAvailable = false;
            return false;
        }

        try {
            const client = await pool.connect();
            await client.query('SELECT 1');
            client.release();
            this.isAvailable = true;
            return true;
        } catch (err: any) {
            console.warn('[CloudLegalRetriever] Health check failed (falling back to local SQLite):', err.message);
            this.isAvailable = false;
            return false;
        }
    }

    /**
     * Executes HNSW vector similarity search on cloud PostgreSQL pgvector.
     * Returns authority-boosted chunks matching the AuthorityScoredChunk interface.
     */
    public async search(
        queryEmbedding: number[],
        options: CloudSearchOptions = {},
    ): Promise<AuthorityScoredChunk[]> {
        const isHealthy = await this.checkHealth();
        if (!isHealthy || !this.pool) {
            return [];
        }

        const limit = options.limit || 8;
        const minSimilarity = options.minSimilarity || 0.45;
        const vectorStr = JSON.stringify(queryEmbedding);

        const whereClauses = ['1 - (c.embedding <=> $1::vector) >= $2'];
        const queryParams: any[] = [vectorStr, minSimilarity];

        if (options.tier) {
            queryParams.push(options.tier);
            whereClauses.push(`c.authority_tier = $${queryParams.length}`);
        }

        if (options.category) {
            queryParams.push(options.category);
            whereClauses.push(`c.category = $${queryParams.length}`);
        }

        queryParams.push(limit);
        const limitParamIndex = queryParams.length;

        const querySql = `
            SELECT 
                c.id,
                c.document_id,
                c.chunk_index,
                c.cleaned_text,
                c.token_count,
                c.page_number,
                c.section_title,
                c.authority_tier,
                c.category,
                d.title as doc_title,
                d.file_name,
                (1 - (c.embedding <=> $1::vector)) as similarity
            FROM legal_chunks c
            JOIN legal_documents d ON c.document_id = d.id
            WHERE ${whereClauses.join(' AND ')}
            ORDER BY similarity DESC
            LIMIT $${limitParamIndex}
        `;

        try {
            const result = await this.pool.query(querySql, queryParams);

            const scoredChunks: AuthorityScoredChunk[] = result.rows.map((row: any, idx: number) => {
                const category = (row.category || 'acts') as SourceCategory;
                const tier = (row.authority_tier || 'authoritative') as AuthorityTier;
                const boost = AUTHORITY_BOOST[category] ?? 1.0;
                const rawSim = parseFloat(row.similarity) || 0;
                const authorityScore = Math.min(1.0, rawSim * boost);

                return {
                    id: idx + 1,
                    meetingId: '__shared_legal_kb__',
                    text: row.cleaned_text,
                    similarity: rawSim,
                    tokenCount: row.token_count || Math.ceil(row.cleaned_text.length / 4),
                    startMs: 0,
                    endMs: 0,
                    speaker: row.section_title || row.doc_title || 'Legal Knowledge Base',
                    chunkIndex: row.chunk_index,
                    authorityTier: tier,
                    sourceCategory: category,
                    sourceTitle: row.doc_title || row.file_name,
                    authorityScore,
                    needsVerification: tier === 'bending',
                };
            });

            // Re-rank by authority-boosted score
            scoredChunks.sort((a, b) => b.authorityScore - a.authorityScore);
            return scoredChunks;
        } catch (err: any) {
            console.error('[CloudLegalRetriever] Search failed (falling back to local SQLite):', err.message);
            return [];
        }
    }

    /**
     * Cleanly terminates database connections upon application shutdown.
     */
    public async destroy(): Promise<void> {
        if (this.pool) {
            try {
                await this.pool.end();
            } catch {
                /* ignore */
            }
            this.pool = null;
        }
    }
}
