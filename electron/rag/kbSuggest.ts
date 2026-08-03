// electron/rag/kbSuggest.ts
// KB-grounded live suggestion: pull active case KB chunks, build a coaching
// prompt, call llmHelper.generateSuggestion, broadcast suggestion-generated.
//
// Body extracted from the original `kb:suggest` IPC handler (ipcHandlers.ts:737)
// so both the IPC channel and the live auto-trigger in main.ts can call it
// without going through IPC plumbing.

import type { AppState } from '../main';

export interface KbSuggestInput {
    question: string;
    transcriptContext?: string;
}

export interface KbSuggestResult {
    success: boolean;
    suggestion?: string;
    citations?: Array<{ id: string; sourceType: string; title: string; similarity?: number; snippet?: string }>;
    question?: string;
    error?: string;
}

export async function runKbSuggest(
    input: KbSuggestInput,
    appState: AppState
): Promise<KbSuggestResult> {
    const question = (input?.question || '').trim();
    const transcriptContext = (input?.transcriptContext || '').trim();
    if (!question) {
        return { success: false, error: 'question is required' };
    }

    const { getActiveClientCase } = await import('./suggest/KnowledgeBaseGate');
    const { KnowledgeBaseManager } = await import('./KnowledgeBaseManager');
    const active = getActiveClientCase();
    if (!active.clientCaseId) {
        return { success: false, error: 'no_active_client_case', question };
    }

    const kb = KnowledgeBaseManager.getInstance();
    const ragManager = appState.getRAGManager();
    if (!kb.isReady() && ragManager && ragManager.isReady()) {
        const vs = (ragManager as any).vectorStore;
        const ep = (ragManager as any).embeddingPipeline;
        if (vs && ep) kb.setPipeline(vs, ep);
    }

    const result = await kb.queryKnowledgeBase(active.clientCaseId, question, { limit: 4 });
    const chunks = (result && (result as any).chunks) || [];
    const citations = chunks.map((c: any, idx: number) => ({
        id: c.id ?? `chunk-${idx}`,
        sourceType: c.sourceType ?? 'file',
        title: c.title ?? 'Knowledge Source',
        similarity: c.score,
        snippet: (c.text || '').slice(0, 200),
    }));

    if (chunks.length === 0) {
        return { success: false, error: 'no_relevant_chunks', question };
    }

    // Build a short suggestion prompt
    const ctxBlock = chunks.map((c: any, i: number) =>
        `[${i + 1}${c.title ? ` — ${c.title}` : ''}] ${c.text || ''}`
    ).join('\n\n');
    const prompt = `You are coaching a user during a live conversation. The user just heard/asked:

"${question}"

${transcriptContext ? `Recent transcript:\n${transcriptContext.slice(0, 800)}\n\n` : ''}Reference context from the active client's knowledge base:
${ctxBlock}

Write a SHORT (1-3 sentence) suggested follow-up the user could say next, grounded in the reference context. Be direct, conversational, and natural. Do not include citations, footnotes, or preamble — just the words they could say.`;

    const llmHelper = appState.processingHelper.getLLMHelper();
    const suggestion = await llmHelper.generateSuggestion(transcriptContext || ctxBlock, question);

    // Send to all renderer windows so MeetingChatPanel picks it up via its
    // own onSuggestion listener (the legacy SuggestionOverlay has been removed).
    const { BrowserWindow } = await import('electron');
    BrowserWindow.getAllWindows().forEach((win: any) => {
        if (!win.isDestroyed()) {
            win.webContents.send('suggestion-generated', {
                question,
                suggestion,
                confidence: 0.8,
                citations,
            });
        }
    });

    return { success: true, suggestion, citations, question };
}
