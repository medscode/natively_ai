// electron/rag/suggest/KnowledgeBaseGate.ts
// Module-scoped active client case for KB-grounded chat and context injection.

import { KnowledgeBaseManager } from '../KnowledgeBaseManager';

let _activeClientCaseId: string | null = null;
let _activeClientCaseName: string = '';
let _activeClientCaseCompany: string = '';

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

export function setActiveClientCase(params: {
    clientCaseId: string | null;
    clientCaseName?: string;
    clientCaseCompany?: string;
}): void {
    _activeClientCaseId = params.clientCaseId;
    _activeClientCaseName = params.clientCaseName || '';
    _activeClientCaseCompany = params.clientCaseCompany || '';
}

export function getActiveClientCase(): {
    clientCaseId: string | null;
    clientCaseName: string;
    clientCaseCompany: string;
} {
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
