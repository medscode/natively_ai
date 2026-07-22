// electron/rag/KnowledgeBaseManager.ts
// Knowledge Base orchestrator — manages client/case-scoped document ingestion.

import * as path from 'path';
import * as fs from 'fs';
import { DatabaseManager } from '../db/DatabaseManager';
import { VectorStore } from './VectorStore';
import { EmbeddingPipeline } from './EmbeddingPipeline';
import { chunkTranscript } from './SemanticChunker';
import type { Chunk } from './SemanticChunker';
import { preprocessTranscript, type RawSegment } from './TranscriptPreprocessor';

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

        // Chunk the text using the existing pipeline
        const rawSegments: RawSegment[] = [{
            speaker: 'source',
            text: extractedText,
            timestamp: 0,
        }];

        const cleaned = preprocessTranscript(rawSegments);
        const chunks = chunkTranscript(params.clientCaseId, cleaned);
        let chunkIds: number[] = [];

        if (chunks.length > 0 && this.vectorStore) {
            chunkIds = this.vectorStore.saveChunks(chunks);
        }

        // Save source record
        const db = DatabaseManager.getInstance().getDb();
        let dbSaveError: string | null = null;
        if (db) {
            try {
                db.prepare(`INSERT INTO knowledge_sources (id, client_case_id, source_type, title, metadata_json, index_status, created_at)
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
        // Lowered threshold to 0.0 — for the demo, surface any chunk from the
        // active case so the user sees real answers instead of an empty KB.
        const minSimilarity = opts?.minSimilarity ?? 0.0;
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
}
