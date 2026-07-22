// electron/rag/extractors/PptExtractor.ts
// Extracts slide text from PowerPoint (.pptx) files.
// .pptx is a ZIP archive containing XML files — we parse the slide XML
// directly using adm-zip (already installed as a dependency).

import { ExtractedContent } from './types';
import * as fs from 'fs';
import * as path from 'path';

// adm-zip is a CommonJS module; use require to match the codebase style
const AdmZip = require('adm-zip');

const MAX_PPT_CHARS = 200_000;

/**
 * Extract text from a PowerPoint .pptx file.
 * Parses the ZIP structure and reads slide XML files.
 *
 * Note: text in shapes, tables, SmartArt, and notes is captured from <a:t>
 * elements in each slide's XML. Images, charts, and embedded media are NOT
 * extracted (would require OCR / chart-understanding). Older .ppt (binary)
 * files are not supported — convert to .pptx first.
 */
export async function extractPptSlides(filePath: string): Promise<ExtractedContent> {
    const warnings: string[] = [];

    // Validate file exists
    if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
    }

    const ext = path.extname(filePath).toLowerCase();
    if (ext !== '.pptx') {
        throw new Error(`Unsupported format: ${ext}. Only .pptx is supported.`);
    }

    let zip: any;
    try {
        zip = new AdmZip(filePath);
    } catch (e: any) {
        throw new Error(`Failed to open .pptx file (invalid ZIP): ${e?.message || e}`);
    }

    // Find all slide XML entries (sorted by slide number)
    const entries: any[] = zip.getEntries();
    const slideEntries = entries
        .filter((e: any) => !e.isDirectory && /^ppt\/slides\/slide\d+\.xml$/i.test(e.entryName))
        .sort((a: any, b: any) => {
            const aNum = parseInt(a.entryName.match(/slide(\d+)/i)?.[1] || '0', 10);
            const bNum = parseInt(b.entryName.match(/slide(\d+)/i)?.[1] || '0', 10);
            return aNum - bNum;
        });

    if (slideEntries.length === 0) {
        throw new Error('No slides found in the .pptx file');
    }

    // Extract text from each slide
    const slideTexts: string[] = [];
    let totalChars = 0;

    for (const entry of slideEntries) {
        if (totalChars >= MAX_PPT_CHARS) {
            warnings.push('Slides truncated at 200,000 characters');
            break;
        }

        const slideNum = parseInt(entry.entryName.match(/slide(\d+)/i)?.[1] || '0', 10);
        const xmlContent = entry.getData().toString('utf8');

        // Extract text from <a:t> elements (PowerPoint text body)
        const textParts: string[] = [];
        const textMatches = xmlContent.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g);
        for (const tMatch of textMatches) {
            const text = tMatch[1].trim();
            if (text) textParts.push(text);
        }

        if (textParts.length > 0) {
            let slideBlock = `## Slide ${slideNum}\n\n`;
            slideBlock += textParts.join('\n\n');

            if (totalChars + slideBlock.length > MAX_PPT_CHARS) {
                const remaining = MAX_PPT_CHARS - totalChars;
                slideBlock = slideBlock.slice(0, remaining);
            }
            slideTexts.push(slideBlock);
            totalChars += slideBlock.length;
        }
    }

    const text = slideTexts.join('\n\n---\n\n');
    const estimatedTokens = Math.round(text.length / 4);

    // Extract deck title from core.xml
    let deckTitle = path.basename(filePath, '.pptx');
    try {
        const coreXml = zip.readAsText('docProps/core.xml', 'utf8');
        const titleMatch = coreXml.match(/<dc:title[^>]*>([^<]*)<\/dc:title>/i);
        if (titleMatch && titleMatch[1].trim()) {
            deckTitle = titleMatch[1].trim();
        }
    } catch { /* non-fatal */ }

    return {
        text,
        title: deckTitle,
        estimatedTokens,
        warnings: warnings.length > 0 ? warnings : undefined,
        metadata: {
            sourceType: 'ppt',
            extractedAt: new Date().toISOString(),
            pageCount: slideTexts.length,
        },
    };
}
