// electron/rag/suggest/KnowledgeBaseGate.ts
// Module-scoped active client case for KB-grounded chat and context injection.
// Persists across Electron restarts via SettingsManager (key: `activeClientCaseId`).

import { KnowledgeBaseManager } from '../KnowledgeBaseManager';
import { SettingsManager } from '../../services/SettingsManager';

let _activeClientCaseId: string | null = null;
let _activeClientCaseName: string = '';
let _activeClientCaseCompany: string = '';
let _hydrated = false;

export interface SuggestionCitation {
    sourceType: string;
    title: string;
    chunkId: string;
    similarity?: number;
    snippet?: string;
}

export interface KBInjectedContext {
    contextBlock: string;
    citations: SuggestionCitation[];
    kbUsed: boolean;
}

/**
 * Hydrate the in-memory active case from SettingsManager on first call.
 * This is called lazily from getActiveClientCase() so it works on first read.
 */
function ensureHydrated(): void {
    if (_hydrated) return;
    _hydrated = true;
    try {
        const settings = SettingsManager.getInstance();
        const persistedId = settings.get('activeClientCaseId') as string | undefined;
        if (persistedId) {
            _activeClientCaseId = persistedId;
            // Look up name/company from DB
            try {
                const db = (require('../db/DatabaseManager') as any).DatabaseManager.getInstance().getDb();
                if (db) {
                    const row = db.prepare(`SELECT name, company FROM client_cases WHERE id = ?`).get(persistedId) as { name: string; company: string } | undefined;
                    if (row) {
                        _activeClientCaseName = row.name || '';
                        _activeClientCaseCompany = row.company || '';
                    } else {
                        // Case was deleted — clear the persisted id
                        _activeClientCaseId = null;
                        settings.set('activeClientCaseId', null);
                    }
                }
            } catch { /* ignore */ }
        }
    } catch { /* ignore */ }
}

export function setActiveClientCase(params: {
    clientCaseId: string | null;
    clientCaseName?: string;
    clientCaseCompany?: string;
}): void {
    _hydrated = true;
    _activeClientCaseId = params.clientCaseId;
    _activeClientCaseName = params.clientCaseName || '';
    _activeClientCaseCompany = params.clientCaseCompany || '';
    // Persist so the active case survives Electron restarts.
    try {
        SettingsManager.getInstance().set('activeClientCaseId', params.clientCaseId || null);
    } catch { /* ignore */ }
}

export function getActiveClientCase(): {
    clientCaseId: string | null;
    clientCaseName: string;
    clientCaseCompany: string;
} {
    ensureHydrated();
    return {
        clientCaseId: _activeClientCaseId,
        clientCaseName: _activeClientCaseName,
        clientCaseCompany: _activeClientCaseCompany,
    };
}

/**
 * Query the knowledge base for the active client case and return formatted context.
 */
export async function injectKBContext(question: string): Promise<KBInjectedContext> {
    if (!_activeClientCaseId) {
        return { contextBlock: '', citations: [], kbUsed: false };
    }

    try {
        const kb = KnowledgeBaseManager.getInstance();
        const res = await kb.queryKnowledgeBase(_activeClientCaseId, question, { limit: 5 });
        if (!res || !res.chunks || res.chunks.length === 0) {
            return { contextBlock: '', citations: [], kbUsed: false };
        }

        const xml = `<knowledge_base_context>
The following background reference chunks are retrieved from the knowledge base of the client case "${_activeClientCaseName}" (${_activeClientCaseCompany}) for context:

${res.formattedContext}
</knowledge_base_context>`;

        const citations: SuggestionCitation[] = res.chunks.map((c: any) => ({
            sourceType: c.sourceType || 'file',
            title: c.title || 'Knowledge Source',
            chunkId: c.id,
            similarity: c.score,
            snippet: c.text,
        }));

        return {
            contextBlock: xml,
            citations,
            kbUsed: true,
        };
    } catch (e: any) {
        console.warn('[KnowledgeBaseGate] Failed to inject KB context:', e?.message);
        return { contextBlock: '', citations: [], kbUsed: false };
    }
}
