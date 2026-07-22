// electron/rag/extractors/index.ts
// Barrel export for all knowledge-base source extractors.
// Each extractor converts its source type into plain text
// before it enters the existing chunk-and-embed pipeline.

export type { ExtractedContent } from './types';

export { extractWebPage, isWebPageUrl } from './WebPageExtractor';
export { extractPptSlides } from './PptExtractor';
export { extractYouTubeTranscript } from './YouTubeExtractor';
