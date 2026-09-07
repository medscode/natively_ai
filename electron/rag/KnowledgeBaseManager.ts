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

export function cleanDocumentTitle(rawTitle: string): string {
    if (!rawTitle) return 'Legal Knowledge Base';
    let clean = rawTitle
        .replace(/^\[+|\]+$/g, '')
        .replace(/\.(pdf|docx|txt|md|markdown|json|csv)$/i, '')
        .replace(/^[_\s-]+|[_\s-]+$/g, '')
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    // Normalize casing and clean up common act names
    clean = clean.replace(/\b\w/g, (c) => c.toUpperCase());
    clean = clean
        .replace(/The Code Of Civil Procedure/i, 'Code of Civil Procedure')
        .replace(/The Indian Succession Act/i, 'Indian Succession Act')
        .replace(/The Transfer Of Property Act/i, 'Transfer of Property Act')
        .replace(/The Hindu Succession Act/i, 'Hindu Succession Act')
        .replace(/The Registration Act/i, 'Registration Act')
        .replace(/The Indian Contract Act/i, 'Indian Contract Act')
        .replace(/The Specific Relief Act/i, 'Specific Relief Act')
        .replace(/The Bharatiya Nyaya Sanhita/i, 'Bharatiya Nyaya Sanhita')
        .replace(/The Bharatiya Nagarik Suraksha Sanhita/i, 'Bharatiya Nagarik Suraksha Sanhita')
        .replace(/The Bharatiya Sakshya Adhiniyam/i, 'Bharatiya Sakshya Adhiniyam');
    return clean;
}

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

    /**
     * Resolve the dedicated on-disk storage directory for a client case's uploaded documents.
     * Stored at: ~/Library/Application Support/natively/storage/cases/<caseId>/documents/
     */
    public static getCaseStorageDir(caseId: string): string {
        const dbm = DatabaseManager.getInstance();
        const userDataPath = dbm.getUserDataPath();
        const dir = path.join(userDataPath, 'storage', 'cases', caseId, 'documents');
        fs.mkdirSync(dir, { recursive: true });
        return dir;
    }

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

        let workingFilePath = params.sourcePath;
        // Copy lawyer-uploaded case attachments to the managed case storage directory
        if (params.sourceType === 'file' && params.sourcePath && params.clientCaseId !== SHARED_KB_CASE_ID) {
            try {
                const caseDir = KnowledgeBaseManager.getCaseStorageDir(params.clientCaseId);
                const baseName = path.basename(params.sourcePath);
                const sanitizedName = baseName.replace(/[^\w\d._-]/g, '_');
                const managedPath = path.join(caseDir, `${Date.now()}_${sanitizedName}`);
                if (path.resolve(params.sourcePath) !== path.resolve(managedPath)) {
                    fs.copyFileSync(params.sourcePath, managedPath);
                    workingFilePath = managedPath;
                    console.log(`[KnowledgeBaseManager] Copied case attachment to managed storage: ${managedPath}`);
                }
            } catch (copyErr: any) {
                console.warn('[KnowledgeBaseManager] Failed to copy file to case directory, using original:', copyErr?.message);
            }
        }

        let extractedText: string;
        let resolvedTitle: string;
        let metadata: Record<string, any> = {};

        try {
            if (params.content) {
                extractedText = params.content;
                resolvedTitle = params.title || path.basename(workingFilePath || 'unknown');
                metadata = { filePath: workingFilePath };
            } else if (params.sourceType === 'file' && workingFilePath) {
                const { extractSafeDocumentText } = require('../services/SafeDocumentTextExtractor');
                const safeRes = await extractSafeDocumentText(workingFilePath);
                extractedText = safeRes.content;
                resolvedTitle = params.title || safeRes.fileName;
                metadata = { filePath: workingFilePath, originalPath: params.sourcePath, fileSize: safeRes.content.length, pageCount: safeRes.pageCount };
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
            // Fast race: if cloud embedding takes > 2000ms (e.g. rate limit/network cooldown),
            // immediately proceed with local 384d MiniLM embedding
            let embeddingResult = await Promise.race([
                this.embeddingPipeline.getEmbeddingWithFallback(query),
                new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
            ]).catch(() => null);

            let embedding = embeddingResult?.embedding;
            let spaceKey = embeddingResult?.space || this.embeddingPipeline.getActiveSpaceKey();

            // If primary cloud embedding timed out or failed, use local 384d provider via pipeline
            if (!embedding) {
                try {
                    const localQueryEmbed = await Promise.race([
                        this.embeddingPipeline.getEmbeddingForQueryLocalOnly(query),
                        new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
                    ]).catch(() => null);
                    if (localQueryEmbed && localQueryEmbed.length === 384) {
                        embedding = localQueryEmbed;
                        spaceKey = this.embeddingPipeline.localSpaceKey || 'local:Xenova/all-MiniLM-L6-v2:384';
                    }
                } catch (e: any) {
                    console.warn('[KnowledgeBaseManager] Local fallback embedding failed:', e?.message);
                }
            }

            if (!embedding) {
                return { chunks: [], formattedContext: '', authoritativeContext: '', bendingContext: '', citations: [] };
            }

            // Search shared KB with timeout protection
            let sharedResults: any[] = [];
            try {
                sharedResults = await Promise.race([
                    this.vectorStore.searchSimilar(embedding, {
                        meetingId: SHARED_KB_CASE_ID,
                        limit: limit * 2, // over-fetch for authority reranking
                        minSimilarity,
                        spaceKey,
                    }),
                    new Promise<any[]>((resolve) => setTimeout(() => resolve([]), 1500)),
                ]);
            } catch (err: any) {
                console.warn('[KnowledgeBaseManager] Shared KB search error:', err?.message);
            }

            // Resilience fallback: if primary space returned 0 chunks from shared KB,
            // query using the local 384d MiniLM vector space (where the pre-indexed legal statutes live)
            if (sharedResults.length === 0) {
                try {
                    const localQueryEmbed = await Promise.race([
                        this.embeddingPipeline.getEmbeddingForQueryLocalOnly(query),
                        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
                    ]).catch(() => null);
                    if (localQueryEmbed && localQueryEmbed.length === 384) {
                        const localSpaceKey = this.embeddingPipeline.localSpaceKey || 'local:Xenova/all-MiniLM-L6-v2:384';
                        const fallbackSharedResults = await Promise.race([
                            this.vectorStore.searchSimilar(localQueryEmbed, {
                                meetingId: SHARED_KB_CASE_ID,
                                limit: limit * 2,
                                minSimilarity: Math.min(minSimilarity, 0.25),
                                spaceKey: localSpaceKey,
                            }),
                            new Promise<any[]>((resolve) => setTimeout(() => resolve([]), 1500)),
                        ]);
                        if (fallbackSharedResults && fallbackSharedResults.length > 0) {
                            console.log(`[KnowledgeBaseManager] Retrieved ${fallbackSharedResults.length} chunks from local 384d shared KB space`);
                            sharedResults = fallbackSharedResults;
                        }
                    }
                } catch (fallbackErr: any) {
                    console.warn('[KnowledgeBaseManager] Local 384d fallback search note:', fallbackErr?.message);
                }
            }

            // Search active case (if any and different from shared)
            let caseResults: any[] = [];
            if (activeCaseId && activeCaseId !== SHARED_KB_CASE_ID) {
                try {
                    caseResults = await Promise.race([
                        this.vectorStore.searchSimilar(embedding, {
                            meetingId: activeCaseId,
                            limit,
                            minSimilarity,
                            spaceKey,
                        }),
                        new Promise<any[]>((resolve) => setTimeout(() => resolve([]), 1500)),
                    ]);
                } catch (err: any) {
                    console.warn('[KnowledgeBaseManager] Case KB search error:', err?.message);
                }

                if (caseResults.length === 0) {
                    try {
                        const localQueryEmbed = await Promise.race([
                            this.embeddingPipeline.getEmbeddingForQueryLocalOnly(query),
                            new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
                        ]).catch(() => null);
                        if (localQueryEmbed && localQueryEmbed.length === 384) {
                            const localSpaceKey = this.embeddingPipeline.localSpaceKey || 'local:Xenova/all-MiniLM-L6-v2:384';
                            const fallbackCase = await Promise.race([
                                this.vectorStore.searchSimilar(localQueryEmbed, {
                                    meetingId: activeCaseId,
                                    limit,
                                    minSimilarity: Math.min(minSimilarity, 0.25),
                                    spaceKey: localSpaceKey,
                                }),
                                new Promise<any[]>((resolve) => setTimeout(() => resolve([]), 1500)),
                            ]);
                            if (fallbackCase && fallbackCase.length > 0) {
                                caseResults = fallbackCase;
                            }
                        }
                    } catch (_) {}
                }
            }

            // Look up source metadata for authority tier resolution
            const db = DatabaseManager.getInstance().getDb();
            const sourceMetadataCache = new Map<string, { authorityTier: AuthorityTier; sourceCategory: SourceCategory; title: string }>();

            const resolveSourceMeta = (meetingId: string): { authorityTier: AuthorityTier; sourceCategory: SourceCategory; title: string } => {
                if (sourceMetadataCache.has(meetingId)) return sourceMetadataCache.get(meetingId)!;
                let tier: AuthorityTier = 'bending';
                let category: SourceCategory = 'articles';
                let title = 'Unknown Source';
                if (db) {
                    try {
                        const sources: any[] = db.prepare(
                            `SELECT title, metadata_json FROM knowledge_sources WHERE client_case_id = ? ORDER BY created_at DESC`
                        ).all(meetingId);
                        if (sources.length > 0) {
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

            // Score and merge all results with true document title resolution
            const allChunks: AuthorityScoredChunk[] = [];

            for (const chunk of [...sharedResults, ...caseResults]) {
                const chunkText = chunk.text || chunk.cleaned_text || '';
                const headerMatch = chunkText.match(/^\[([^\]\n>]+)(?:\s*>|\s*\])/);
                const specificTitle = headerMatch && headerMatch[1] ? headerMatch[1].trim() : '';

                const meta = resolveSourceMeta(chunk.meetingId);
                const rawTitle = specificTitle || (chunk as any).title || meta.title;
                const sourceTitle = cleanDocumentTitle(rawTitle);

                // Refine category & authority tier from specific document title
                let tier = meta.authorityTier;
                let category = meta.sourceCategory;
                const { tier: inferredTier, category: inferredCat } = KnowledgeBaseManager.inferAuthorityFromPath(sourceTitle);
                if (inferredTier) tier = inferredTier;
                if (inferredCat) category = inferredCat;

                const boost = AUTHORITY_BOOST[category] ?? 1.0;
                const authorityScore = (chunk.similarity || 0) * boost;
                allChunks.push({
                    id: chunk.id,
                    meetingId: chunk.meetingId,
                    text: chunkText,
                    similarity: chunk.similarity || 0,
                    tokenCount: chunk.tokenCount || 0,
                    startMs: chunk.startMs || 0,
                    endMs: chunk.endMs || 0,
                    speaker: chunk.speaker || 'source',
                    chunkIndex: chunk.chunkIndex || 0,
                    authorityTier: tier,
                    sourceCategory: category,
                    sourceTitle,
                    authorityScore,
                    needsVerification: tier === 'bending',
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

    /**
     * Resolve the on-disk directory for the shared legal KB (supports both 'KB-shared' and 'kb-shared').
     * Checks packaged app resources as well as development source directories.
     */
    public static resolveSharedKBDir(): string | null {
        const candidates: string[] = [
            path.join(process.resourcesPath, 'KB-shared'),
            path.join(process.resourcesPath, 'kb-shared'),
        ];
        try {
            const { app } = require('electron');
            if (app && typeof app.getAppPath === 'function') {
                const appPath = app.getAppPath();
                candidates.push(path.join(appPath, 'KB-shared'));
                candidates.push(path.join(appPath, 'kb-shared'));
                candidates.push(path.join(appPath, '..', 'KB-shared'));
                candidates.push(path.join(appPath, '..', 'kb-shared'));
                candidates.push(path.join(appPath, '..', '..', 'KB-shared'));
                candidates.push(path.join(appPath, '..', '..', 'kb-shared'));
            }
        } catch (_) {}
        candidates.push(path.join(process.cwd(), 'KB-shared'));
        candidates.push(path.join(process.cwd(), 'kb-shared'));

        for (const c of candidates) {
            try {
                if (fs.existsSync(c) && fs.statSync(c).isDirectory()) {
                    return c;
                }
            } catch (_) {}
        }
        return null;
    }

    /**
     * Automated startup synchronization for the Shared Legal KB.
     * Checks if the sentinel case exists and if all files in KB-shared/ are ingested.
     * Uses on-device MiniLM (384d) for 100% offline, zero-cloud-quota indexing.
     */
    public async autoSyncSharedLegalKB(): Promise<{ synced: number; skipped: number; total: number }> {
        const kbDir = KnowledgeBaseManager.resolveSharedKBDir();
        if (!kbDir) {
            console.log('[KnowledgeBaseManager] No KB-shared directory found, skipping auto-sync.');
            return { synced: 0, skipped: 0, total: 0 };
        }

        const db = DatabaseManager.getInstance().getDb();
        if (!db) {
            console.warn('[KnowledgeBaseManager] DB not ready for Shared Legal KB sync.');
            return { synced: 0, skipped: 0, total: 0 };
        }

        // Ensure sentinel case and meeting exist with local 384d space stamp
        this.createClientCase({
            id: SHARED_KB_CASE_ID,
            name: 'Shared Legal Knowledge Base',
            company: 'Global Indian Law Library',
            notes: 'Authoritative Indian Statutes, Acts, Codes, and Persuasive Legal Commentary',
        });
        db.prepare(`INSERT OR IGNORE INTO meetings (id, title, created_at, source, embedding_space) VALUES (?, ?, ?, 'kb_client_case', ?)`).run(
            SHARED_KB_CASE_ID,
            'Shared Legal Knowledge Base',
            new Date().toISOString(),
            'local:xenova/all-minilm-l6-v2:384'
        );

        // Scan supported documents in Authoritative and bending
        const files: Array<{ fullPath: string; relativePath: string; fileName: string }> = [];
        const scan = (dir: string, base: string) => {
            if (!fs.existsSync(dir)) return;
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    scan(full, base);
                } else if (entry.isFile() && !entry.name.startsWith('.')) {
                    const ext = path.extname(entry.name).toLowerCase();
                    if (['.pdf', '.docx', '.txt', '.md', '.markdown', '.json', '.csv'].includes(ext)) {
                        files.push({
                            fullPath: full,
                            relativePath: path.relative(base, full),
                            fileName: entry.name,
                        });
                    }
                }
            }
        };
        scan(kbDir, kbDir);

        if (files.length === 0) {
            return { synced: 0, skipped: 0, total: 0 };
        }

        const existingHashes = new Set<string>();
        try {
            const rows = db.prepare(`SELECT metadata_json FROM knowledge_sources WHERE client_case_id = ?`).all(SHARED_KB_CASE_ID) as any[];
            for (const r of rows) {
                try {
                    const meta = JSON.parse(r.metadata_json || '{}');
                    if (meta.file_hash) existingHashes.add(meta.file_hash);
                } catch (_) {}
            }
        } catch (_) {}

        let synced = 0;
        let skipped = 0;
        const crypto = require('crypto');

        for (const file of files) {
            try {
                const binary = fs.readFileSync(file.fullPath);
                const fileHash = crypto.createHash('sha256').update(binary).digest('hex');
                if (existingHashes.has(fileHash)) {
                    skipped++;
                    continue;
                }

                const { tier, category } = KnowledgeBaseManager.inferAuthorityFromPath(file.relativePath);
                console.log(`[KnowledgeBaseManager] Auto-syncing legal file: ${file.fileName} [${tier}/${category}]`);

                const title = file.fileName.replace(/\.[^.]+$/, '');
                await this.addSource({
                    clientCaseId: SHARED_KB_CASE_ID,
                    sourceType: 'file',
                    sourcePath: file.fullPath,
                    title,
                    id: `shared_${fileHash.slice(0, 16)}`,
                    metadata: {
                        authority_tier: tier,
                        source_category: category,
                        file_hash: fileHash,
                        file_path: file.relativePath,
                        shared_kb: true,
                    },
                });
                existingHashes.add(fileHash);
                synced++;
            } catch (err: any) {
                console.warn(`[KnowledgeBaseManager] Failed to auto-sync file ${file.fileName}:`, err?.message);
            }
        }

        console.log(`[KnowledgeBaseManager] Shared Legal KB auto-sync finished: synced=${synced}, skipped=${skipped}, totalFiles=${files.length}`);
        return { synced, skipped, total: files.length };
    }
}
