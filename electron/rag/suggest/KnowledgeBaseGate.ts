// electron/rag/suggest/KnowledgeBaseGate.ts
// Module-scoped active client case for KB-grounded chat and context injection.
// Persists across Electron restarts via SettingsManager (key: `activeClientCaseId`).
// Extended (2026-08): also queries shared legal KB with authority-weighted scoring.

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
 * Extended (2026-08): also queries the shared legal KB with authority-weighted scoring.
 */
export async function injectKBContext(question: string): Promise<KBInjectedContext> {
    // Even without an active case, we should still search the shared KB.
    const activeCase = getActiveClientCase();

    try {
        const { KnowledgeBaseManager, SHARED_KB_CASE_ID } = await import('../KnowledgeBaseManager');
        const kb = KnowledgeBaseManager.getInstance();

        // Use the authority-aware query that searches both shared KB + active case
        const res = await kb.querySharedAndCaseKB(
            question,
            activeCase.clientCaseId, // null if no active case — shared KB still searched
            { limit: 6 }
        );

        if (!res || !res.chunks || res.chunks.length === 0) {
            return { contextBlock: '', citations: [], kbUsed: false };
        }

        // Build the XML context block with authority tier labels
        const caseLabel = activeCase.clientCaseId
            ? ` for the client case "${_activeClientCaseName}" (${_activeClientCaseCompany})`
            : '';
        const xml = `<knowledge_base_context>
The following reference material is retrieved from the legal knowledge base${caseLabel}.
IMPORTANT: Authoritative sources (Acts, Judgements, Amendments, Commentaries) are trusted — cite them directly.
Secondary sources are informational only — always label them with "⚠️ Needs verification" when citing.
When authoritative and secondary sources conflict, ALWAYS follow the authoritative source.
Always mention which Act/Section/Judgement the answer is based on.

${res.formattedContext}
</knowledge_base_context>`;

        const citations: SuggestionCitation[] = res.chunks.map((c) => ({
            sourceType: c.sourceCategory || 'file',
            title: c.needsVerification
                ? `⚠️ ${c.sourceTitle} [Needs Verification]`
                : `📖 ${c.sourceTitle}`,
            chunkId: String(c.id),
            similarity: c.authorityScore,
            snippet: c.text?.slice(0, 200),
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
