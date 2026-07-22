// electron/rag/extractors/YouTubeExtractor.ts
// Extracts transcript/subtitles from YouTube video URLs.
// Uses the YouTube oEmbed API for metadata and a third-party transcript service
// for the caption text. See the warning below before relying on this in production.

import { ExtractedContent } from './types';

const YOUTUBE_TRANSCRIPT_API = 'https://youtubetranscript.com/';

/**
 * Extract transcript text from a YouTube video.
 * Supports standard youtube.com and youtu.be URLs.
 *
 * WARNING: this uses the free youtubetranscript.com API (a third-party service
 * unaffiliated with Google/YouTube). That service may go down, rate-limit,
 * or change its response shape without notice. For production use:
 *   - consider the official YouTube Data API + captions endpoint (requires API key)
 *   - or self-host a transcript extractor (e.g. youtube-transcript npm package,
 *     which scrapes the timedtext endpoint directly)
 * The 10s timeout and single-attempt fetch here are intentionally minimal —
 * add retries and a fallback before this is user-facing.
 */
export async function extractYouTubeTranscript(urlOrId: string): Promise<ExtractedContent> {
    const warnings: string[] = [];
    const videoId = extractYouTubeId(urlOrId);

    if (!videoId) {
        throw new Error(`Could not extract YouTube video ID from: ${urlOrId}`);
    }

    // Try the free youtubetranscript.com API first (no API key required)
    let transcriptData: any;
    try {
        const response = await fetch(`${YOUTUBE_TRANSCRIPT_API}?v=${videoId}`, {
            signal: AbortSignal.timeout(10_000),
        });

        if (!response.ok) {
            throw new Error(`Transcript API returned ${response.status}`);
        }

        transcriptData = await response.json();
    } catch (e: any) {
        if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
            throw new Error('YouTube transcript fetch timed out after 10s');
        }
        throw new Error(`Failed to fetch transcript for video ${videoId}: ${e?.message || e}`);
    }

    // The API returns an array of { text, duration, offset } objects
    if (!Array.isArray(transcriptData) || transcriptData.length === 0) {
        throw new Error('No transcript available for this video (may be missing captions)');
    }

    // Extract plain text transcript with timestamps
    const segments: string[] = [];
    for (const segment of transcriptData) {
        if (segment.text) {
            // Clean YouTube transcript text (remove typical formatting)
            const cleanText = segment.text
                .replace(/&#39;/g, "'")
                .replace(/&amp;/g, '&')
                .replace(/&quot;/g, '"')
                .replace(/[ \t]+/g, ' ')
                .trim();

            if (cleanText) {
                const timestamp = formatTimestamp(segment.offset);
                segments.push(`[${timestamp}] ${cleanText}`);
            }
        }
    }

    if (segments.length === 0) {
        throw new Error('Transcript contained no usable text segments');
    }

    const text = segments.join('\n');
    const estimatedTokens = Math.round(text.length / 4);

    // Try to get video metadata (title) via the official oEmbed endpoint
    let videoTitle = `YouTube Video (${videoId})`;
    try {
        const ogResponse = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`, {
            signal: AbortSignal.timeout(5_000),
        });
        if (ogResponse.ok) {
            const meta = await ogResponse.json();
            if (meta.title) videoTitle = meta.title;
        }
    } catch { /* non-fatal */ }

    return {
        text,
        title: videoTitle,
        estimatedTokens,
        warnings: warnings.length > 0 ? warnings : undefined,
        metadata: {
            sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
            sourceType: 'youtube',
            extractedAt: new Date().toISOString(),
            durationSeconds: transcriptData.reduce((sum: number, s: any) => sum + (s.duration || 0), 0),
        },
    };
}

/**
 * Extract YouTube video ID from various URL formats.
 */
function extractYouTubeId(url: string): string | null {
    const trimmed = url.trim();

    // Already just an ID (11 characters, alphanumeric + underscore + dash)
    if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) {
        return trimmed;
    }

    // youtube.com/watch?v=VIDEO_ID, /embed/, /v/, /shorts/
    const watchMatch = trimmed.match(
        /(?:youtube\.com|youtu\.be)\/(?:watch\?v=|embed\/|v\/|shorts\/)?([A-Za-z0-9_-]{11})/
    );
    if (watchMatch) return watchMatch[1];

    // youtu.be/VIDEO_ID
    const shortMatch = trimmed.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
    if (shortMatch) return shortMatch[1];

    return null;
}

/**
 * Format offset in seconds to MM:SS or HH:MM:SS.
 */
function formatTimestamp(offsetSeconds: number): string {
    const hours = Math.floor(offsetSeconds / 3600);
    const minutes = Math.floor((offsetSeconds % 3600) / 60);
    const seconds = Math.floor(offsetSeconds % 60);

    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
