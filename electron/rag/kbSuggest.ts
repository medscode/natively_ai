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

    const kb = KnowledgeBaseManager.getInstance();
    const ragManager = appState.getRAGManager();
    if (!kb.isReady() && ragManager && ragManager.isReady()) {
        const vs = (ragManager as any).vectorStore;
        const ep = (ragManager as any).embeddingPipeline;
        if (vs && ep) kb.setPipeline(vs, ep);
    }

    // Use authority-aware query that searches shared KB + active case
    const result = await kb.querySharedAndCaseKB(question, active.clientCaseId, { limit: 4 });
    const chunks = result?.chunks || [];
    const citations = chunks.map((c, idx: number) => ({
        id: c.id != null ? String(c.id) : `chunk-${idx}`,
        sourceType: c.sourceCategory ?? 'file',
        title: c.needsVerification
            ? `⚠️ ${c.sourceTitle} [Needs Verification]`
            : `📖 ${c.sourceTitle}`,
        similarity: c.authorityScore,
        snippet: (c.text || '').slice(0, 250),
    }));

    if (chunks.length === 0) {
        return { success: false, error: 'no_relevant_chunks', question };
    }

    // Build suggestion prompt with authority-labeled context and strict Indian legal formatting
    const ctxBlock = result.formattedContext || chunks.map((c, i: number) =>
        `[${i + 1} — ${c.sourceTitle} (${c.sourceCategory})]\n${c.text || ''}`
    ).join('\n\n');

    const prompt = `You are an expert legal co-counsel coaching a lawyer during a live client meeting.
The client just said / asked:
"${question}"

${transcriptContext ? `Recent conversation transcript:\n${transcriptContext.slice(0, 800)}\n\n` : ''}Retrieved Knowledge Base Context:
${ctxBlock}

STRUCTURE YOUR RESPONSE IN THIS EXACT ORDER:
1. DIRECT ANSWER (BOTTOM LINE): Provide a direct, clear 1-2 sentence answer that the lawyer can speak immediately to address the client's question. No preamble (do NOT say "Here is what to say" or "As a lawyer...").
2. KEY POINTS & STATUTORY BASIS: Follow with 2-3 concise bullet points with legal reasoning, conditions, exceptions, or procedural steps.
3. CITATION CONVENTION: Use the Indian legal notation format: use "Sec." or "Section" (e.g. "Sec. 126 of the Transfer of Property Act, 1882", "Sec. 6 of the Hindu Succession Act, 1956", "Order XXXIX of CPC, 1908"). NEVER use the "§" symbol.
4. EXACT DOCUMENT CITATION: Explicitly name the document/Act from which the rule is drawn. If relying on secondary sources (⚠️), note that it requires verification.`;

    const llmHelper = appState.processingHelper.getLLMHelper();
    let suggestion = '';
    try {
        suggestion = await llmHelper.chatWithGemini(prompt, undefined, undefined, true);
    } catch (e) {
        suggestion = await llmHelper.generateSuggestion(transcriptContext || ctxBlock, question);
    }

    // Send to all renderer windows so MeetingChatPanel picks it up via its
    // own onSuggestion listener
    const { BrowserWindow } = await import('electron');
    BrowserWindow.getAllWindows().forEach((win: any) => {
        if (!win.isDestroyed()) {
            win.webContents.send('suggestion-generated', {
                question,
                suggestion,
                confidence: 0.85,
                citations,
            });
        }
    });

    return { success: true, suggestion, citations, question };
}
