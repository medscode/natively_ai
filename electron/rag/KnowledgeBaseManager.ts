// electron/rag/KnowledgeBaseManager.ts
// Knowledge Base orchestrator — manages client/case-scoped document ingestion.
// Extended (2026-08) with shared legal KB support: two-tier authority system
// (authoritative vs bending), authority-weighted retrieval, and citation labels.

import * as path from 'path';
import * as fs from 'fs';
import { DatabaseManager } from '../db/DatabaseManager';
import { VectorStore } from './VectorStore';
import { EmbeddingPipeline } from './EmbeddingPipeline';
import { chunkTranscript } from './SemanticChunker';
import type { Chunk } from './SemanticChunker';
import { preprocessTranscript, type RawSegment } from './TranscriptPreprocessor';
import { chunkLegalDocument, isStatutoryText } from './LegalDocumentChunker';

// ── Shared KB Constants ────────────────────────────────────────────────

/** Sentinel case ID for the shared legal knowledge base (not a real client case). */
export const SHARED_KB_CASE_ID = '__shared_legal_kb__';

/** Authority tiers — authoritative sources are trusted, bending sources need verification. */
export type AuthorityTier = 'authoritative' | 'bending';

/**
 * Source categories within each tier.
 * Authoritative: acts > judgements > amendments > commentaries
 * Bending: articles > whitepapers > news
 */
export type SourceCategory =
    | 'acts' | 'judgements' | 'amendments' | 'commentaries'
    | 'articles' | 'whitepapers' | 'news';

/** Hardcoded authority boost weights — higher means more prioritized in retrieval. */
export const AUTHORITY_BOOST: Record<SourceCategory, number> = {
    acts: 1.40,
    judgements: 1.30,
    amendments: 1.25,
    commentaries: 1.15,
    articles: 0.80,
    whitepapers: 0.75,
    news: 0.70,
};

/** Conflict resolution: authoritative always wins. This is the priority order (index 0 = highest). */
export const SOURCE_PRIORITY_ORDER: SourceCategory[] = [
    'acts', 'judgements', 'amendments', 'commentaries',
    'articles', 'whitepapers', 'news',
];

export interface KnowledgeSource {
    id: string;
    clientCaseId: string;
    sourceType: 'file' | 'web_page' | 'ppt' | 'youtube';
    title: string;
    content?: string;
    metadata?: Record<string, any>;
    indexStatus: string;
    createdAt: string;
}

export interface AuthorityScoredChunk {
    /** Original chunk data from VectorStore search. */
    id: number;
    meetingId: string;
    text: string;
    similarity: number;
    tokenCount: number;
    startMs: number;
    endMs: number;
    speaker: string;
    chunkIndex: number;
    /** Authority tier of the source document. */
    authorityTier: AuthorityTier;
    /** Source category (acts, judgements, articles, etc.). */
    sourceCategory: SourceCategory;
    /** Title of the source document. */
    sourceTitle: string;
    /** Authority-boosted final score. */
    authorityScore: number;
    /** Whether this source needs verification (true for all bending sources). */
    needsVerification: boolean;
}

export class KnowledgeBaseManager {
    private static instance: KnowledgeBaseManager;
    private vectorStore: VectorStore | null = null;
    private embeddingPipeline: EmbeddingPipeline | null = null;

    private constructor() {}

    public static getInstance(): KnowledgeBaseManager {
        if (!KnowledgeBaseManager.instance) {
            KnowledgeBaseManager.instance = new KnowledgeBaseManager();
        }
        return KnowledgeBaseManager.instance;
    }

    public setPipeline(vectorStore: VectorStore, embeddingPipeline: EmbeddingPipeline): void {
        this.vectorStore = vectorStore;
        this.embeddingPipeline = embeddingPipeline;
    }

    public isReady(): boolean {
        return this.vectorStore !== null && this.embeddingPipeline !== null;
    }

    // ── Client Case CRUD ──────────────────────────────────────────────

    public createClientCase(data: { id: string; name: string; company?: string; notes?: string }): boolean {
        if (!data || typeof data.id !== 'string' || data.id.trim().length === 0) {
            console.warn('[KnowledgeBaseManager] createClientCase: missing id');
            return false;
        }
        if (typeof data.name !== 'string' || data.name.trim().length === 0) {
            console.warn('[KnowledgeBaseManager] createClientCase: missing name');
            return false;
        }
        const db = DatabaseManager.getInstance().getDb();
        if (!db) return false;
        try {
            db.prepare(`INSERT OR IGNORE INTO client_cases (id, name, company, notes, created_at) VALUES (?, ?, ?, ?, ?)`)
                .run(data.id, data.name.trim(), data.company || '', data.notes || '', new Date().toISOString());
            db.prepare(`INSERT OR IGNORE INTO meetings (id, title, created_at, source) VALUES (?, ?, ?, 'kb_client_case')`)
                .run(data.id, data.name.trim(), new Date().toISOString());
            return true;
        } catch (e: any) {
            console.error('[KnowledgeBaseManager] createClientCase error:', e?.message);
            return false;
        }
    }

    public getClientCases(): any[] {
        const db = DatabaseManager.getInstance().getDb();
        if (!db) return [];
        try {
            return db.prepare(`SELECT id, name, company, notes, created_at as createdAt FROM client_cases ORDER BY created_at DESC`).all();
        } catch { return []; }
    }

    public getClientCase(id: string): any | null {
        const db = DatabaseManager.getInstance().getDb();
        if (!db) return null;
        try {
            return db.prepare(`SELECT id, name, company, notes, created_at as createdAt FROM client_cases WHERE id = ?`).get(id) || null;
        } catch { return null; }
    }

    public updateClientCase(id: string, updates: { name?: string; company?: string; notes?: string }): boolean {
        const db = DatabaseManager.getInstance().getDb();
        if (!db) return false;
        try {
            const sets: string[] = [];
            const vals: any[] = [];
            if (updates.name !== undefined) { sets.push('name = ?'); vals.push(updates.name); }
            if (updates.company !== undefined) { sets.push('company = ?'); vals.push(updates.company); }
            if (updates.notes !== undefined) { sets.push('notes = ?'); vals.push(updates.notes); }
            if (sets.length === 0) return true;
            vals.push(id);
            db.prepare(`UPDATE client_cases SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
            return true;
        } catch { return false; }
    }

    public deleteClientCase(id: string): void {
        const db = DatabaseManager.getInstance().getDb();
        if (!db) return;
        db.prepare(`DELETE FROM client_cases WHERE id = ?`).run(id);
        db.prepare(`DELETE FROM meetings WHERE id = ?`).run(id);
    }

    // ── Source Management ─────────────────────────────────────────────

    public async addSource(params: {
        clientCaseId: string;
        sourceType: 'file' | 'web_page' | 'ppt' | 'youtube';
        title?: string;
        sourcePath?: string;
        content?: string;
        id?: string;
        metadata?: Record<string, any>;
    }): Promise<{ success: boolean; source?: KnowledgeSource; error?: string }> {
        const sourceId = params.id || `src_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

        // Verify the parent case exists BEFORE doing expensive extraction work.
        // Also ensure a corresponding meeting parent row exists so chunk saving doesn't fail on FK constraints.
        {
            const db = DatabaseManager.getInstance().getDb();
            if (!db) return { success: false, error: 'database_unavailable' };
            const existing = db.prepare(`SELECT id, name FROM client_cases WHERE id = ?`).get(params.clientCaseId) as any;
            if (!existing) {
                return {
                    success: false,
                    error: `client case not found: ${params.clientCaseId}. Create the case first or pick a different one from the dropdown.`,
                };
            }
            db.prepare(`INSERT OR IGNORE INTO meetings (id, title, created_at, source) VALUES (?, ?, ?, 'kb_client_case')`)
                .run(params.clientCaseId, existing.name || 'Client Case', new Date().toISOString());
        }

        let extractedText: string;
        let resolvedTitle: string;
        let metadata: Record<string, any> = {};

        try {
            if (params.content) {
                extractedText = params.content;
                resolvedTitle = params.title || path.basename(params.sourcePath || 'unknown');
                metadata = { filePath: params.sourcePath };
            } else if (params.sourceType === 'file' && params.sourcePath) {
                const { extractSafeDocumentText } = require('../services/SafeDocumentTextExtractor');
                const safeRes = await extractSafeDocumentText(params.sourcePath);
                extractedText = safeRes.content;
                resolvedTitle = params.title || safeRes.fileName;
                metadata = { filePath: params.sourcePath, fileSize: safeRes.content.length, pageCount: safeRes.pageCount };
            } else if (params.sourceType === 'web_page' && params.sourcePath) {
                // Lazy import: extractors/ is a sibling module that's safe to load
                // on demand. Static top-level import here would force this code path
                // into the boot bundle even though most meetings never ingest a URL.
                const { extractWebPage } = require('./extractors');
                const extracted = await extractWebPage(params.sourcePath);
                extractedText = extracted.text;
                resolvedTitle = params.title || extracted.title;
                metadata = { originalUrl: params.sourcePath, ...extracted.metadata, warnings: extracted.warnings };
            } else if (params.sourceType === 'ppt' && params.sourcePath) {
                const { extractPptSlides } = require('./extractors');
                const extracted = await extractPptSlides(params.sourcePath);
                extractedText = extracted.text;
                resolvedTitle = params.title || extracted.title;
                metadata = { filePath: params.sourcePath, ...extracted.metadata, warnings: extracted.warnings };
            } else if (params.sourceType === 'youtube' && params.sourcePath) {
                const { extractYouTubeTranscript } = require('./extractors');
                const extracted = await extractYouTubeTranscript(params.sourcePath);
                extractedText = extracted.text;
                resolvedTitle = params.title || extracted.title;
                metadata = { originalUrl: params.sourcePath, ...extracted.metadata, warnings: extracted.warnings };
            } else {
                return { success: false, error: 'No content or source path provided' };
            }
            metadata.extractedAt = new Date().toISOString();
        } catch (e: any) {
            return { success: false, error: `Extraction failed: ${e?.message || e}` };
        }

        // Choose chunking strategy based on document type:
        // - Legal documents (shared KB, authoritative sources, statutory text) → LegalDocumentChunker
        // - Everything else (transcripts, general docs) → existing SemanticChunker pipeline
        const isLegalDoc =
            params.clientCaseId === SHARED_KB_CASE_ID ||
            (params.metadata?.authority_tier != null) ||
            (params.metadata?.source_category && ['acts', 'judgements', 'amendments', 'commentaries'].includes(params.metadata.source_category)) ||
            isStatutoryText(extractedText);

        let chunks: Chunk[];
        if (isLegalDoc) {
            console.log(`[KnowledgeBaseManager] Using LegalDocumentChunker for "${resolvedTitle}"`);
            chunks = chunkLegalDocument(params.clientCaseId, extractedText, {
                docTitle: resolvedTitle,
                forceStatutory: params.metadata?.source_category === 'acts' ||
                    params.metadata?.source_category === 'amendments',
            });
        } else {
            // Existing transcript-based chunking for non-legal content
            const rawSegments: RawSegment[] = [{
                speaker: 'source',
                text: extractedText,
                timestamp: 0,
            }];
            const cleaned = preprocessTranscript(rawSegments);
            chunks = chunkTranscript(params.clientCaseId, cleaned);
        }

        let chunkIds: number[] = [];

        if (chunks.length > 0 && this.vectorStore) {
            chunkIds = this.vectorStore.saveChunks(chunks);
        }

        // Merge any caller-provided metadata with extraction metadata
        if (params.metadata) {
            metadata = { ...metadata, ...params.metadata };
        }

        // Save source record (INSERT OR REPLACE for idempotent re-ingestion)
        const db = DatabaseManager.getInstance().getDb();
        let dbSaveError: string | null = null;
        if (db) {
            try {
                db.prepare(`INSERT OR REPLACE INTO knowledge_sources (id, client_case_id, source_type, title, metadata_json, index_status, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`)
                    .run(sourceId, params.clientCaseId, params.sourceType, resolvedTitle,
                        JSON.stringify(metadata), 'indexed', new Date().toISOString());
            } catch (e: any) {
                console.warn('[KnowledgeBaseManager] Failed to save source record:', e?.message);
                dbSaveError = e?.message || 'unknown';
            }
        }

        // Queue for embedding
        if (chunkIds.length > 0 && this.embeddingPipeline) {
            await this.embeddingPipeline.queueMeeting(params.clientCaseId);
        }

        const source: KnowledgeSource = {
            id: sourceId,
            clientCaseId: params.clientCaseId,
            sourceType: params.sourceType,
            title: resolvedTitle,
            metadata,
            indexStatus: 'indexed',
            createdAt: new Date().toISOString(),
        };

        if (dbSaveError) {
            console.error(`[KnowledgeBaseManager] Source "${resolvedTitle}" was extracted but DB row failed: ${dbSaveError}`);
            return {
                success: false,
                error: `Source was extracted but the database record could not be saved: ${dbSaveError}`,
                source,
            };
        }

        console.log(`[KnowledgeBaseManager] Added source "${resolvedTitle}" (${chunks.length} chunks, ${chunkIds.length} saved)`);
        return { success: true, source };
    }

    public getSourcesForClient(clientCaseId: string): KnowledgeSource[] {
        const db = DatabaseManager.getInstance().getDb();
        if (!db) return [];
        try {
            const rows: any[] = db.prepare(
                `SELECT id, client_case_id as clientCaseId, source_type as sourceType, title,
                        metadata_json, index_status as indexStatus, created_at as createdAt
                 FROM knowledge_sources WHERE client_case_id = ? ORDER BY created_at DESC`
            ).all(clientCaseId);
            return rows.map(r => ({
                ...r,
                metadata: r.metadata_json ? JSON.parse(r.metadata_json) : {},
            }));
        } catch { return []; }
    }

    public deleteAllSourcesForClient(clientCaseId: string): void {
        const db = DatabaseManager.getInstance().getDb();
        if (!db) return;
        db.prepare(`DELETE FROM knowledge_sources WHERE client_case_id = ?`).run(clientCaseId);
    }

    public async queryKnowledgeBase(clientCaseId: string, query: string, opts?: { limit?: number; minSimilarity?: number }) {
        if (!this.vectorStore || !this.embeddingPipeline) {
            return { chunks: [], formattedContext: '' };
        }
        const limit = opts?.limit || 5;
        // Floor at 0.35 to suppress noise. Phase 2-lite fix — was 0.0 which
        // let irrelevant chunks through and produced garbage during streaming.
        // Override with opts.minSimilarity for callers that need looser recall.
        // Tune in Phase 5 with the eval suite.
        const minSimilarity = opts?.minSimilarity ?? 0.35;
        try {
            const embeddingResult = await this.embeddingPipeline.getEmbeddingWithFallback(query);
            const embedding = embeddingResult?.embedding;
            if (!embedding) {
                return { chunks: [], formattedContext: '' };
            }
            // Get the active embedding space key — without it, searchSimilar
            // returns empty (it refuses to search across embedding spaces).
            const spaceKey = this.embeddingPipeline.getActiveSpaceKey();
            const results = await this.vectorStore.searchSimilar(embedding, {
                meetingId: clientCaseId,
                limit,
                minSimilarity,
                spaceKey,
            });
            const formattedContext = results.map((r: any) =>
                `[Source: ${r.title || r.meetingId || 'unknown'}] ${r.text || ''}`
            ).join('\n\n');
            return { chunks: results, formattedContext };
        } catch (e: any) {
            console.warn('[KnowledgeBaseManager] queryKnowledgeBase failed:', e?.message);
            return { chunks: [], formattedContext: '' };
        }
    }

    // ── Shared KB: Authority-Weighted Query ────────────────────────────

    /**
     * Query BOTH the shared legal KB and an optional active client case.
     * Results are scored with authority boosts and returned with tier labels.
     *
     * This is the primary query method for the lawyer copilot — it searches
     * the shared legal knowledge base (Acts, Judgements, Commentaries, etc.)
     * and, if a client case is active, also searches that case's documents.
     * Results are ranked by: vector_similarity × authority_boost.
     */
    public async querySharedAndCaseKB(
        query: string,
        activeCaseId?: string | null,
        opts?: { limit?: number; minSimilarity?: number }
    ): Promise<{
        chunks: AuthorityScoredChunk[];
        formattedContext: string;
        authoritativeContext: string;
        bendingContext: string;
        citations: Array<{ title: string; tier: AuthorityTier; category: SourceCategory; needsVerification: boolean }>;
    }> {
        if (!this.vectorStore || !this.embeddingPipeline) {
            return { chunks: [], formattedContext: '', authoritativeContext: '', bendingContext: '', citations: [] };
        }
        const limit = opts?.limit || 8;
        const minSimilarity = opts?.minSimilarity ?? 0.30;

        try {
            const embeddingResult = await this.embeddingPipeline.getEmbeddingWithFallback(query);
            const embedding = embeddingResult?.embedding;
            if (!embedding) {
                return { chunks: [], formattedContext: '', authoritativeContext: '', bendingContext: '', citations: [] };
            }
            const spaceKey = this.embeddingPipeline.getActiveSpaceKey();

            // Search shared KB
            const sharedResults = await this.vectorStore.searchSimilar(embedding, {
                meetingId: SHARED_KB_CASE_ID,
                limit: limit * 2, // over-fetch for authority reranking
                minSimilarity,
                spaceKey,
            });

            // Search active case (if any and different from shared)
            let caseResults: any[] = [];
            if (activeCaseId && activeCaseId !== SHARED_KB_CASE_ID) {
                caseResults = await this.vectorStore.searchSimilar(embedding, {
                    meetingId: activeCaseId,
                    limit,
                    minSimilarity,
                    spaceKey,
                });
            }

            // Look up source metadata for authority tier resolution
            const db = DatabaseManager.getInstance().getDb();
            const sourceMetadataCache = new Map<string, { authorityTier: AuthorityTier; sourceCategory: SourceCategory; title: string }>();

            const resolveSourceMeta = (meetingId: string): { authorityTier: AuthorityTier; sourceCategory: SourceCategory; title: string } => {
                if (sourceMetadataCache.has(meetingId)) return sourceMetadataCache.get(meetingId)!;
                // Default: if it's from the shared KB, look up knowledge_sources
                let tier: AuthorityTier = 'bending';
                let category: SourceCategory = 'articles';
                let title = 'Unknown Source';
                if (db) {
                    try {
                        const sources: any[] = db.prepare(
                            `SELECT title, metadata_json FROM knowledge_sources WHERE client_case_id = ? ORDER BY created_at DESC`
                        ).all(meetingId);
                        if (sources.length > 0) {
                            // Use the first source's metadata (all chunks for a meeting share the case ID)
                            for (const src of sources) {
                                const meta = src.metadata_json ? JSON.parse(src.metadata_json) : {};
                                if (meta.authority_tier) {
                                    tier = meta.authority_tier as AuthorityTier;
                                    category = (meta.source_category || 'articles') as SourceCategory;
                                    title = src.title || title;
                                    break;
                                }
                            }
                            if (title === 'Unknown Source' && sources[0].title) {
                                title = sources[0].title;
                            }
                        }
                    } catch { /* ignore */ }
                }
                const result = { authorityTier: tier, sourceCategory: category, title };
                sourceMetadataCache.set(meetingId, result);
                return result;
            };

            // Score and merge all results
            const allChunks: AuthorityScoredChunk[] = [];

            for (const chunk of [...sharedResults, ...caseResults]) {
                const meta = resolveSourceMeta(chunk.meetingId);
                const boost = AUTHORITY_BOOST[meta.sourceCategory] ?? 1.0;
                const authorityScore = (chunk.similarity || 0) * boost;
                allChunks.push({
                    id: chunk.id,
                    meetingId: chunk.meetingId,
                    text: chunk.text || chunk.cleaned_text || '',
                    similarity: chunk.similarity || 0,
                    tokenCount: chunk.tokenCount || 0,
                    startMs: chunk.startMs || 0,
                    endMs: chunk.endMs || 0,
                    speaker: chunk.speaker || 'source',
                    chunkIndex: chunk.chunkIndex || 0,
                    authorityTier: meta.authorityTier,
                    sourceCategory: meta.sourceCategory,
                    sourceTitle: meta.title,
                    authorityScore,
                    needsVerification: meta.authorityTier === 'bending',
                });
            }

            // ── Phase 3: Cross-Encoder Reranking ──────────────────────────
            // Use the existing LocalReranker (BGE-reranker-base ONNX) to re-score
            // candidates more accurately. The cross-encoder reads (query, passage)
            // jointly — much more precise than cosine similarity alone.
            // Falls through to cosine × authority scoring if the reranker is
            // unavailable (model not downloaded, poisoned, or timed out).
            try {
                const { getLocalReranker } = require('./LocalReranker');
                const reranker = getLocalReranker();
                if (allChunks.length > 1) {
                    const passages = allChunks.map(c => c.text);
                    const RERANK_TIMEOUT_MS = 100;
                    const rerankResults = await Promise.race([
                        reranker.rerank(query, passages),
                        new Promise<null>((resolve) => setTimeout(() => resolve(null), RERANK_TIMEOUT_MS)),
                    ]);
                    if (rerankResults && rerankResults.length === allChunks.length) {
                        // Blend cross-encoder score with authority boost:
                        // finalScore = crossEncoderScore * 0.6 + authorityBoost * 0.4
                        // Normalize cross-encoder scores to 0-1 range using sigmoid
                        const maxCE = Math.max(...rerankResults.map((r: any) => r.score));
                        const minCE = Math.min(...rerankResults.map((r: any) => r.score));
                        const rangeCE = maxCE - minCE || 1;
                        for (const rr of rerankResults) {
                            const chunkIdx = rr.index;
                            if (chunkIdx >= 0 && chunkIdx < allChunks.length) {
                                const normalizedCE = (rr.score - minCE) / rangeCE;
                                const boost = AUTHORITY_BOOST[allChunks[chunkIdx].sourceCategory] ?? 1.0;
                                allChunks[chunkIdx].authorityScore = normalizedCE * 0.6 + (boost / 1.4) * 0.4;
                            }
                        }
                        console.log(`[KnowledgeBaseManager] Cross-encoder reranked ${allChunks.length} chunks`);
                    }
                }
            } catch (e: any) {
                // Reranker unavailable — keep cosine × authority scoring
                console.log(`[KnowledgeBaseManager] Reranker unavailable (${e?.message || 'unknown'}), using vector scores`);
            }

            // Sort by authority-boosted score (highest first)
            allChunks.sort((a, b) => b.authorityScore - a.authorityScore);

            // Take top N
            const topChunks = allChunks.slice(0, limit);

            // Separate into authoritative and bending for prompt formatting
            const authoritativeChunks = topChunks.filter(c => c.authorityTier === 'authoritative');
            const bendingChunks = topChunks.filter(c => c.authorityTier === 'bending');

            // Format authoritative context
            const authoritativeContext = authoritativeChunks.length > 0
                ? authoritativeChunks.map((c, i) =>
                    `[${i + 1}] 📖 ${c.sourceTitle} (${c.sourceCategory}):\n${c.text}`
                ).join('\n\n')
                : '';

            // Format bending context with verification warnings
            const bendingContext = bendingChunks.length > 0
                ? bendingChunks.map((c, i) =>
                    `[${authoritativeChunks.length + i + 1}] ⚠️ ${c.sourceTitle} (${c.sourceCategory}) [NEEDS VERIFICATION]:\n${c.text}`
                ).join('\n\n')
                : '';

            // Build the full formatted context for LLM prompt injection
            const parts: string[] = [];
            if (authoritativeContext) {
                parts.push(`### AUTHORITATIVE SOURCES (trusted — cite directly)\n${authoritativeContext}`);
            }
            if (bendingContext) {
                parts.push(`### SECONDARY SOURCES (⚠️ needs verification — label in your answer)\n${bendingContext}`);
            }
            const formattedContext = parts.join('\n\n');

            // Build citation list
            const seenTitles = new Set<string>();
            const citations = topChunks
                .filter(c => { if (seenTitles.has(c.sourceTitle)) return false; seenTitles.add(c.sourceTitle); return true; })
                .map(c => ({
                    title: c.sourceTitle,
                    tier: c.authorityTier,
                    category: c.sourceCategory,
                    needsVerification: c.needsVerification,
                }));

            return { chunks: topChunks, formattedContext, authoritativeContext, bendingContext, citations };
        } catch (e: any) {
            console.warn('[KnowledgeBaseManager] querySharedAndCaseKB failed:', e?.message);
            return { chunks: [], formattedContext: '', authoritativeContext: '', bendingContext: '', citations: [] };
        }
    }

    /**
     * Infer the authority tier from a file's relative path within kb-shared/.
     * E.g. 'Authoritative/acts/some-act.pdf' → { tier: 'authoritative', category: 'acts' }
     */
    public static inferAuthorityFromPath(relativePath: string): { tier: AuthorityTier; category: SourceCategory } {
        const lower = relativePath.toLowerCase().replace(/\\/g, '/');
        let tier: AuthorityTier = 'bending';
        let category: SourceCategory = 'articles';

        if (lower.startsWith('authoritative/') || lower.startsWith('authoritative\\')) {
            tier = 'authoritative';
        } else if (lower.startsWith('bending/') || lower.startsWith('bending\\')) {
            tier = 'bending';
        }

        // Infer category from sub-folder
        const categoryMap: Record<string, SourceCategory> = {
            'acts': 'acts',
            'judgements': 'judgements',
            'amendments': 'amendments',
            'commentaries': 'commentaries',
            'articles': 'articles',
            'news': 'news',
            'whitepapers': 'whitepapers',
        };
        for (const [folder, cat] of Object.entries(categoryMap)) {
            if (lower.includes(`/${folder}/`) || lower.includes(`\\${folder}\\`) || lower.includes(`/${folder}\\`)) {
                category = cat;
                break;
            }
        }

        // If the tier is authoritative but category is a bending one, auto-fix
        // (e.g. someone puts an article in authoritative/ — still authoritative)
        if (tier === 'authoritative' && !['acts', 'judgements', 'amendments', 'commentaries'].includes(category)) {
            // Files directly in Authoritative/ without a sub-folder default to 'acts'
            category = 'acts';
        }

        return { tier, category };
    }
}
