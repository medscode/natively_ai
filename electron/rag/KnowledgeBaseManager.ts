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
        const db = DatabaseManager.getInstance().getDb();
        if (!db) return false;
        try {
            db.prepare(`INSERT OR IGNORE INTO client_cases (id, name, company, notes, created_at) VALUES (?, ?, ?, ?, ?)`)
                .run(data.id, data.name, data.company || '', data.notes || '', new Date().toISOString());
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
                // Simple web page fetch
                extractedText = `[Web page source: ${params.sourcePath}]`;
                resolvedTitle = params.title || params.sourcePath;
                metadata = { originalUrl: params.sourcePath };
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
        const chunks = chunkTranscript(sourceId, cleaned);
        let chunkIds: number[] = [];

        if (chunks.length > 0 && this.vectorStore) {
            chunkIds = this.vectorStore.saveChunks(chunks, params.clientCaseId);
        }

        // Save source record
        const db = DatabaseManager.getInstance().getDb();
        if (db) {
            try {
                db.prepare(`INSERT INTO knowledge_sources (id, client_case_id, source_type, title, metadata_json, index_status, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`)
                    .run(sourceId, params.clientCaseId, params.sourceType, resolvedTitle,
                        JSON.stringify(metadata), 'indexed', new Date().toISOString());
            } catch (e: any) {
                console.warn('[KnowledgeBaseManager] Failed to save source record:', e?.message);
            }
        }

        // Queue for embedding
        if (chunkIds.length > 0 && this.embeddingPipeline) {
            this.embeddingPipeline.enqueueChunks(chunkIds);
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
        // Use the vector store's search with tenant scoping
        const results = await this.vectorStore.search(query, {
            tenantId: clientCaseId,
            topK: opts?.limit || 5,
            embeddingPipeline: this.embeddingPipeline,
        });
        const formattedContext = results.map((r: any) =>
            `[Source: ${r.meetingId || 'unknown'}] ${r.text}`
        ).join('\n\n');
        return { chunks: results, formattedContext };
    }
}
