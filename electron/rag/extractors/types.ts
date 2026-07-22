// electron/rag/extractors/types.ts
// Shared types for all knowledge-base source extractors.

export interface ExtractedContent {
    /** The extracted plain text ready for chunking and embedding. */
    text: string;
    /** Human-readable title / source identifier (page title, deck name, video title). */
    title: string;
    /** Estimated token count (for chunk-size planning). */
    estimatedTokens: number;
    /** Any warnings encountered during extraction (e.g. partial extraction, rate limiting). */
    warnings?: string[];
    /** Source metadata for provenance tracking. */
    metadata: {
        sourceUrl?: string;
        sourceType: 'web_page' | 'ppt' | 'youtube' | 'file';
        extractedAt: string;
        pageCount?: number;
        durationSeconds?: number;
    };
}
