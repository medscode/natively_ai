/**
 * RestSTT - REST-based Speech-to-Text for Groq, OpenAI Whisper, ElevenLabs, Azure, and IBM Watson
 *
 * Implements the same EventEmitter interface as GoogleSTT:
 *   Events: 'transcript' ({ text, isFinal, confidence }), 'error' (Error)
 *   Methods: start(), stop(), write(chunk: Buffer)
 *
 * Buffers raw PCM chunks, prepends a WAV header, and uploads via REST every ~3 seconds.
 * Supports two upload modes:
 *   - Multipart FormData (Groq, OpenAI, ElevenLabs)
 *   - Raw binary body (Azure, IBM Watson)
 */

import { EventEmitter } from 'events';
import axios from 'axios';
import FormData from 'form-data';
import { RECOGNITION_LANGUAGES } from '../config/languages';
import { isValidSttRegion } from '../utils/curlUtils';
import { buildWhisperPrompt } from './whisper/contextPrompt';
import { SettingsManager } from '../services/SettingsManager';

// Decides whether to attach the language param. For 'hindi' / 'auto' we omit
// it so Whisper-large-v3-turbo can preserve Hinglish code-mixing (otherwise
// the decoder forces a single-script output). English variants still send
// `language: 'en'` for monolingual callers.
const wantsExplicitLang = (languageKey: string | undefined): boolean => {
    if (!languageKey || languageKey === 'auto' || languageKey === 'hindi') return false;
    return languageKey.startsWith('english-');
};

const shouldInjectHinglishPrompt = (languageKey: string | undefined): boolean =>
    languageKey === 'hindi' || languageKey === 'auto';

export type RestSttProvider = 'groq' | 'openai' | 'elevenlabs' | 'azure' | 'ibmwatson' | 'sarvam';

interface RestSttProviderConfig {
    endpoint: string;
    model: string;
    authHeader: Record<string, string>;
    uploadType: 'multipart' | 'binary';
    extraFormFields?: Record<string, string>;
    /** Extract transcript text from the API response */
    extractTranscript: (data: any) => string;
}

type ProviderConfigFactory = (apiKey: string, region?: string, languageKey?: string) => RestSttProviderConfig;

const PROVIDER_CONFIGS: Record<RestSttProvider, ProviderConfigFactory> = {
    groq: (apiKey, region, languageKey) => {
        const lang = wantsExplicitLang(languageKey)
            ? RECOGNITION_LANGUAGES[languageKey!]?.iso639
            : undefined;
        const prompt = shouldInjectHinglishPrompt(languageKey)
            ? buildWhisperPrompt(SettingsManager.getInstance().get('whisperContextPrompt'))
            : undefined;
        return {
            endpoint: 'https://api.groq.com/openai/v1/audio/transcriptions',
            model: 'whisper-large-v3-turbo',
            authHeader: { Authorization: `Bearer ${apiKey}` },
            uploadType: 'multipart',
            extraFormFields: {
                temperature: '0',
                response_format: 'json',
                ...(lang ? { language: lang } : {}),
                ...(prompt ? { prompt } : {})
            },
            extractTranscript: (data: any) => {
                if (typeof data === 'string') return data;
                return data?.text ?? '';
            },
        };
    },
    openai: (apiKey, region, languageKey) => {
        const lang = wantsExplicitLang(languageKey)
            ? RECOGNITION_LANGUAGES[languageKey!]?.iso639
            : undefined;
        const prompt = shouldInjectHinglishPrompt(languageKey)
            ? buildWhisperPrompt(SettingsManager.getInstance().get('whisperContextPrompt'))
            : undefined;
        return {
            endpoint: 'https://api.openai.com/v1/audio/transcriptions',
            model: 'whisper-1',
            authHeader: { Authorization: `Bearer ${apiKey}` },
            uploadType: 'multipart',
            extraFormFields: {
                ...(lang ? { language: lang } : {}),
                ...(prompt ? { prompt } : {})
            },
            extractTranscript: (data: any) => {
                if (typeof data === 'string') return data;
                return data?.text ?? '';
            },
        };
    },
    elevenlabs: (apiKey, region, languageKey) => {
        const lang = (languageKey && languageKey !== 'auto') ? RECOGNITION_LANGUAGES[languageKey]?.iso639 : undefined;
        return {
            endpoint: 'https://api.elevenlabs.io/v1/speech-to-text',
            model: 'scribe_v2',
            authHeader: { 'xi-api-key': apiKey },
            uploadType: 'multipart',
            extraFormFields: {
                ...(lang ? { language_code: lang } : {})
            },
            extractTranscript: (data: any) => {
                if (typeof data === 'string') return data;
                return data?.text ?? '';
            },
        };
    },
    azure: (apiKey, region = 'eastus', languageKey) => {
        const lang = (languageKey && languageKey !== 'auto') ? RECOGNITION_LANGUAGES[languageKey]?.bcp47 : undefined;
        const finalLang = lang || 'en-US';
        return {
            endpoint: `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${finalLang}`,
            model: '',
            authHeader: { 'Ocp-Apim-Subscription-Key': apiKey },
            uploadType: 'binary',
            extractTranscript: (data: any) => {
                return data?.DisplayText ?? '';
            },
        };
    },
    ibmwatson: (apiKey, region = 'us-south', languageKey) => {
        const lang = (languageKey && languageKey !== 'auto') ? RECOGNITION_LANGUAGES[languageKey]?.bcp47 : undefined;
        const finalLang = lang || 'en-US';
        return {
            endpoint: `https://api.${region}.speech-to-text.watson.cloud.ibm.com/v1/recognize?language=${finalLang}`,
            model: '',
            authHeader: { Authorization: `Basic ${Buffer.from(`apikey:${apiKey}`).toString('base64')}` },
            uploadType: 'binary',
            extractTranscript: (data: any) => {
                try {
                    return data?.results?.[0]?.alternatives?.[0]?.transcript ?? '';
                } catch {
                    return '';
                }
            },
        };
    },
    sarvam: (apiKey, region, languageKey) => {
        // Sarvam AI: Indic-first STT with native Hinglish support. The
        // `mode` parameter forces output script: 'translit' produces
        // Latin/Roman output regardless of input script — exactly the
        // WhatsApp-style Hinglish the user wants. 'language_code: unknown'
        // lets Sarvam auto-detect.
        const sm = SettingsManager.getInstance();
        const model = (sm.get('sarvamSttModel') as string) || 'saaras:v3';
        const mode = (sm.get('sarvamSttMode') as string) || 'translit';
        const explicitLang = (sm.get('sarvamSttLanguage') as string) || '';

        let languageCode: string | undefined;
        if (explicitLang) {
            languageCode = explicitLang;
        } else if (!languageKey || languageKey === 'auto' || languageKey === 'hindi') {
            languageCode = languageKey === 'hindi' ? 'hi-IN' : 'unknown';
        } else {
            languageCode = RECOGNITION_LANGUAGES[languageKey]?.bcp47 ?? 'unknown';
        }

        return {
            endpoint: 'https://api.sarvam.ai/speech-to-text',
            // model is appended via extraFormFields (Sarvam takes `model` as
            // a form field, not a config-only value). Empty string here so
            // uploadMultipart's hardcoded `form.append('model', this.config.model)`
            // becomes a no-op for this provider (handled by the provider guard below).
            model: '',
            authHeader: { 'api-subscription-key': apiKey },
            uploadType: 'multipart',
            extraFormFields: {
                model,
                mode,
                ...(languageCode ? { language_code: languageCode } : {})
            },
            extractTranscript: (data: any) => {
                return data?.transcript ?? '';
            },
        };
    },
};

// Minimum buffer size before sending (avoid sending tiny fragments)
// 16kHz * 2 bytes/sample * 1 channel * ~0.375s = 12000 bytes. Tuned via
// electron/audio/__tests__/scratch/sttPipelineHarness.mjs to flush short
// utterances like "Yes" / "OK" (typically 8-12 KB of audio) without
// dropping them, while still rejecting transient noise bursts < 200ms.
// The silence-tail debounce below merges intra-sentence pauses so the
// minimum effective upload grows beyond this floor for longer phrases.
const MIN_BUFFER_BYTES = 12000;

// Safety-net upload interval (ms). Primary flush is triggered by speech_ended events.
// This fires as a backstop if someone talks continuously for >10s without any pause,
// preventing unbounded buffer growth and STT API file-size/timeout errors.
const SAFETY_NET_INTERVAL_MS = 10000;

// Silence-tail debounce: when the native VAD reports speech_ended, wait this
// long for new audio to arrive before flushing. If a new chunk arrives within
// the window, cancel the timer — the user is still mid-sentence. 400ms halves
// the previous latency while still absorbing clause-boundary pauses in
// English/Hinglish. Tuned via sttPipelineHarness.mjs.
const FLUSH_DEBOUNCE_MS = 400;

// Silence threshold - if RMS is below this, skip the upload. On the int16
// scale (0..32767), 15 ≈ -67 dBFS — quieter than ambient room tone. The Rust
// SilenceSuppressor (mic=100 RMS, sys=30 RMS + adaptive EMA) is the first
// filter; this is the second. Anything below 15 is effectively zero amplitude.
const SILENCE_RMS_THRESHOLD = 15;

// Max concurrent uploads in flight. Allows a short utterance to flush while
// a long upload is still in progress — without this, head-of-line blocking on
// the network causes the next flush to wait for the previous upload's full
// network round-trip latency (often 500-1000ms). Cap of 2 keeps Sarvam
// rate limits (~5 req/s free tier) comfortable.
const MAX_CONCURRENT_UPLOADS = 2;

export class RestSTT extends EventEmitter {
    private provider: RestSttProvider;
    private apiKey: string;
    private region?: string;
    private config: RestSttProviderConfig;

    private chunks: Buffer[] = [];
    private totalBufferedBytes = 0;
    private safetyNetTimer: NodeJS.Timeout | null = null;
    private isActive = false;
    private isUploading = false;          // kept for legacy callers; replaced by activeUploads
    private activeUploads = 0;            // parallel-upload counter; replaces single-bit isUploading
    private flushPending = false;         // coalescing flag: drain when any slot frees up
    private flushDebounceTimer: NodeJS.Timeout | null = null;  // Silence-tail debounce: wait for new audio after speech_ended

    // Audio config (must match SystemAudioCapture output)
    private sampleRate = 16000;
    private numChannels = 1;
    private bitsPerSample = 16;

    constructor(provider: RestSttProvider, apiKey: string, modelOverride?: string, region?: string) {
        super();
        this.provider = provider;
        this.apiKey = apiKey;
        // SSRF guard (defense in depth): the region is interpolated into the
        // Azure/IBM endpoint hostname. If a malformed region ever reaches this
        // far (e.g. persisted before the IPC guard existed), drop it so the
        // PROVIDER_CONFIGS default region is used instead of a poisoned host.
        this.region = isValidSttRegion(region) ? region : undefined;
        this.config = PROVIDER_CONFIGS[provider](apiKey, this.region);
        if (modelOverride) {
            this.config.model = modelOverride;
        }
        console.log(`[RestSTT] Initialized for provider: ${provider}, model: ${this.config.model || '(default)'}`);
    }

    /**
     * Update API key (e.g., when user saves a new key)
     */
    public setApiKey(apiKey: string): void {
        this.apiKey = apiKey;
        this.config = PROVIDER_CONFIGS[this.provider](apiKey, this.region);
        console.log(`[RestSTT] API key updated for ${this.provider}`);
    }

    /**
     * Update sample rate to match the audio source
     */
    public setSampleRate(rate: number): void {
        if (this.sampleRate === rate) return;
        console.log(`[RestSTT] Updating sample rate to ${rate}Hz`);
        this.sampleRate = rate;
    }

    /**
     * Update channel count
     */
    public setAudioChannelCount(count: number): void {
        if (this.numChannels === count) return;
        console.log(`[RestSTT] Updating channel count to ${count}`);
        this.numChannels = count;
    }

    /**
     * Update recognition language
     */
    public setRecognitionLanguage(key: string): void {
        console.log(`[RestSTT] Updating recognition language to: ${key}`);
        this.config = PROVIDER_CONFIGS[this.provider](this.apiKey, this.region, key);
    }

    /**
     * No-op for RestSTT (no Google credentials needed)
     */
    public setCredentials(_keyFilePath: string): void {
        console.log(`[RestSTT] setCredentials called (no-op for REST provider)`);
    }

    /**
     * Start the upload timer
     */
    public start(): void {
        if (this.isActive) return;

        console.log(`[RestSTT] Starting (${this.provider})...`);
        this.isActive = true;
        this.chunks = [];
        this.totalBufferedBytes = 0;

        // Safety-net timer: flush even during continuous speech to prevent
        // unbounded buffer growth and Whisper API file-size/timeout errors.
        // Primary flush is driven by Rust speech_ended events.
        this.safetyNetTimer = setInterval(() => {
            this.flushAndUpload();
        }, SAFETY_NET_INTERVAL_MS);
    }

    /**
     * Stop the upload timer and flush remaining buffer
     */
    public stop(): void {
        if (!this.isActive) return;

        console.log(`[RestSTT] Stopping (${this.provider})...`);
        this.isActive = false;

        if (this.safetyNetTimer) {
            clearInterval(this.safetyNetTimer);
            this.safetyNetTimer = null;
        }
        if (this.flushDebounceTimer) {
            clearTimeout(this.flushDebounceTimer);
            this.flushDebounceTimer = null;
        }

        // Flush remaining audio
        this.flushAndUpload();
    }

    /**
     * Write raw PCM audio data to the internal buffer
     */
    public write(audioData: Buffer): void {
        if (!this.isActive) return;
        // Cancel any pending flush debounce — new audio means the user is still
        // speaking (intra-sentence pause was absorbed). Without this, the 800ms
        // debounce would fire and break one sentence into two uploads.
        if (this.flushDebounceTimer) {
            clearTimeout(this.flushDebounceTimer);
            this.flushDebounceTimer = null;
        }
        this.chunks.push(audioData);
        this.totalBufferedBytes += audioData.length;
    }

    /**
     * Called when the native SilenceSuppressor detects speech has ended.
     *
     * Debounce: wait FLUSH_DEBOUNCE_MS before flushing, so intra-sentence pauses
     * (typical clause boundaries in English/Hinglish) merge into a single upload.
     * If `write()` fires during the debounce window (the user kept talking), the
     * timer is cancelled and the buffer keeps accumulating. If the meeting ends
     * (`stop()`/`finalize()`) before the timer fires, the timer is flushed
     * immediately so trailing audio isn't lost.
     *
     * Why this exists: the native Rust VAD reports speech_ended on every pause
     * ≥ ~200ms, but Sarvam/Whisper needs ~1s of contiguous audio to return a
     * clean transcript. Flushing every 200ms produced 11-char partial chunks.
     */
    public notifySpeechEnded(): void {
        if (!this.isActive) return;

        // If a debounce is already pending, leave it. Multiple rapid
        // speech_ended events (e.g. "uh" between words) shouldn't keep
        // resetting the timer — we want one flush at the end of the silence.
        if (this.flushDebounceTimer) return;

        console.log(`[RestSTT] Speech ended detected by native VAD — debouncing flush (${FLUSH_DEBOUNCE_MS}ms)`);
        this.flushDebounceTimer = setTimeout(() => {
            this.flushDebounceTimer = null;
            this.flushAndUpload();
        }, FLUSH_DEBOUNCE_MS);
    }

    public finalize(): void {
        if (!this.isActive) return;
        // Cancel any pending debounce — finalize is a hard flush, no point waiting.
        if (this.flushDebounceTimer) {
            clearTimeout(this.flushDebounceTimer);
            this.flushDebounceTimer = null;
        }
        console.log(`[RestSTT] Finalize — flushing immediately`);
        this.flushAndUpload();
    }

    /**
     * Concatenate buffered chunks, add WAV header, and upload to REST API
     */
    private async flushAndUpload(): Promise<void> {
        // Gate every flush on isActive. Without this, the
        // finally-re-entrancy below (`if (this.flushPending) this.flushAndUpload()`)
        // can fire AFTER stop() has set isActive=false, and the body below
        // would happily upload trailing audio to the REST provider for the
        // rest of the process lifetime. The re-arm block below would also
        // resurrect a fresh setInterval if safetyNetTimer happened to be
        // non-null in some race window. Bailing here closes both holes.
        if (!this.isActive) return;

        // Skip if no data
        if (this.chunks.length === 0 || this.totalBufferedBytes < MIN_BUFFER_BYTES) return;

        // Parallel upload gate: allow up to MAX_CONCURRENT_UPLOADS in flight.
        // Beyond that, coalesce into flushPending so we don't burst past the
        // provider's rate limit. When any in-flight upload finishes, the
        // finally block below drains whatever accumulated during the slot.
        if (this.activeUploads >= MAX_CONCURRENT_UPLOADS) {
            this.flushPending = true;
            return;
        }

        // Reset safety-net timer to prevent double-flush. The outer
        // `if (!this.isActive) return` above guarantees we never re-arm
        // after stop() — but keep the timer guard here too as belt-and-braces
        // in case a future caller invokes flushAndUpload from a path that
        // skips the isActive check.
        if (this.safetyNetTimer && this.isActive) {
            clearInterval(this.safetyNetTimer);
            this.safetyNetTimer = setInterval(() => {
                this.flushAndUpload();
            }, SAFETY_NET_INTERVAL_MS);
        }

        // Grab current buffer and reset
        const currentChunks = this.chunks;
        this.chunks = [];
        const currentBytes = this.totalBufferedBytes;
        this.totalBufferedBytes = 0;

        // Concatenate all chunks
        const rawPcm = Buffer.concat(currentChunks);

        // Check for silence (skip upload if audio is too quiet)
        if (this.isSilent(rawPcm)) {
            if (Math.random() < 0.1) {
                console.log(`[RestSTT] Skipping silent buffer (${rawPcm.length} bytes)`);
            }
            return;
        }

        // Resample to 16kHz mono before upload. At 48kHz stereo this produces a
        // 6x smaller WAV file, reducing upload latency and keeping file sizes well
        // under the Groq/OpenAI 25MB limit even for 10-second safety-net flushes.
        const TARGET_RATE = 16_000;
        const pcm16k = this.sampleRate === TARGET_RATE && this.numChannels === 1
            ? rawPcm
            : this.resampleTo16kHz(rawPcm);

        // Add WAV header — stamp with actual rate/channel after resampling (always 16kHz mono)
        const wavBuffer = this.addWavHeader(pcm16k, TARGET_RATE);

        this.activeUploads++;
        this.isUploading = this.activeUploads > 0;  // legacy flag for any external readers

        try {
            const transcript = await this.uploadAudio(wavBuffer);

            if (transcript && transcript.trim().length > 0) {
                console.log(`[RestSTT] Transcript received`, { length: transcript.trim().length });
                this.emit('transcript', {
                    text: transcript.trim(),
                    isFinal: true,
                    confidence: 1.0,
                });
            }
        } catch (err) {
            console.error(`[RestSTT] Upload error:`, err);
            this.emit('error', err instanceof Error ? err : new Error(String(err)));
        } finally {
            this.activeUploads--;
            this.isUploading = this.activeUploads > 0;

            // Drain any flush that was queued while slots were full. Same slot
            // is now free; the recursive call hits the activeUploads check
            // and proceeds immediately.
            if (this.flushPending && this.activeUploads < MAX_CONCURRENT_UPLOADS) {
                this.flushPending = false;
                this.flushAndUpload();
            }
        }
    }

    /**
     * Upload WAV audio to the REST endpoint
     */
    private async uploadAudio(wavBuffer: Buffer): Promise<string> {
        if (this.config.uploadType === 'binary') {
            return this.uploadBinary(wavBuffer);
        }
        return this.uploadMultipart(wavBuffer);
    }

    /**
     * Upload via multipart FormData (Groq, OpenAI, ElevenLabs)
     */
    private async uploadMultipart(wavBuffer: Buffer): Promise<string> {
        const form = new FormData();

        form.append('file', wavBuffer, {
            filename: 'audio.wav',
            contentType: 'audio/wav',
        });

        // ElevenLabs uses 'model_id' instead of 'model'. Sarvam sends `model` as a
        // form field via extraFormFields below (because the value comes from a
        // settings key, not the static config.model), so we skip the append
        // entirely here.
        if (this.provider === 'elevenlabs') {
            form.append('model_id', this.config.model);
        } else if (this.provider !== 'sarvam') {
            form.append('model', this.config.model);
        }

        if (this.config.extraFormFields) {
            for (const [key, value] of Object.entries(this.config.extraFormFields)) {
                form.append(key, value);
            }
        }

        const response = await axios.post(this.config.endpoint, form, {
            headers: {
                ...this.config.authHeader,
                ...form.getHeaders(),
            },
            timeout: 30000,
        });

        return this.config.extractTranscript(response.data);
    }

    /**
     * Upload via raw binary body (Azure, IBM Watson)
     */
    private async uploadBinary(wavBuffer: Buffer): Promise<string> {
        const response = await axios.post(this.config.endpoint, wavBuffer, {
            headers: {
                ...this.config.authHeader,
                'Content-Type': 'audio/wav',
            },
            timeout: 30000,
        });

        return this.config.extractTranscript(response.data);
    }

    /**
     * Resample Int16LE PCM from inputRate/numChannels → 16kHz mono.
     * Uses integer decimation (same approach as Rust DSP and OpenAIStreamingSTT).
     * Returns a new Buffer containing the resampled 16-bit mono PCM.
     */
    private resampleTo16kHz(raw: Buffer): Buffer {
        const TARGET_RATE = 16_000;

        // Build Int16Array from the raw buffer using safe byte-by-byte reads
        // to avoid alignment issues with unaligned ArrayBuffer slices.
        const numSamples = Math.floor(raw.length / 2);
        const inputS16 = new Int16Array(numSamples);
        for (let i = 0; i < numSamples; i++) {
            inputS16[i] = raw.readInt16LE(i * 2);
        }

        // Already at target rate and mono — return as-is
        if (this.sampleRate === TARGET_RATE && this.numChannels === 1) {
            return Buffer.from(inputS16.buffer);
        }

        // Mix down multi-channel to mono
        let monoS16: Int16Array;
        if (this.numChannels > 1) {
            const monoLen = Math.floor(inputS16.length / this.numChannels);
            monoS16 = new Int16Array(monoLen);
            for (let i = 0; i < monoLen; i++) {
                let sum = 0;
                for (let c = 0; c < this.numChannels; c++) {
                    sum += inputS16[i * this.numChannels + c];
                }
                monoS16[i] = Math.round(sum / this.numChannels);
            }
        } else {
            monoS16 = inputS16;
        }

        // Decimate to target rate
        if (this.sampleRate === TARGET_RATE) {
            return Buffer.from(monoS16.buffer);
        }

        const factor = this.sampleRate / TARGET_RATE;
        const outLen = Math.floor(monoS16.length / factor);
        const outS16 = new Int16Array(outLen);
        for (let i = 0; i < outLen; i++) {
            outS16[i] = monoS16[Math.floor(i * factor)];
        }
        return Buffer.from(outS16.buffer);
    }

    /**
     * Check if audio buffer is essentially silence
     */
    private isSilent(pcmBuffer: Buffer): boolean {
        let sum = 0;
        const step = 20; // Sample every 20th sample for speed
        let count = 0;

        for (let i = 0; i < pcmBuffer.length - 1; i += 2 * step) {
            const sample = pcmBuffer.readInt16LE(i);
            sum += sample * sample;
            count++;
        }

        if (count === 0) return true;
        const rms = Math.sqrt(sum / count);
        return rms < SILENCE_RMS_THRESHOLD;
    }

    /**
     * Add a WAV RIFF header to raw PCM data.
     * channels defaults to 1 (mono) because callers always resample to mono first.
     * Critical: Most REST STT APIs require a valid WAV file, NOT raw PCM.
     */
    private addWavHeader(samples: Buffer, sampleRate: number = 16_000, channels: number = 1): Buffer {
        const buffer = Buffer.alloc(44 + samples.length);
        // RIFF chunk descriptor
        buffer.write('RIFF', 0);
        buffer.writeUInt32LE(36 + samples.length, 4);
        buffer.write('WAVE', 8);
        // fmt sub-chunk
        buffer.write('fmt ', 12);
        buffer.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
        buffer.writeUInt16LE(1, 20);  // AudioFormat (1 = PCM)
        buffer.writeUInt16LE(channels, 22);
        buffer.writeUInt32LE(sampleRate, 24);
        buffer.writeUInt32LE(sampleRate * channels * (this.bitsPerSample / 8), 28); // ByteRate
        buffer.writeUInt16LE(channels * (this.bitsPerSample / 8), 32);              // BlockAlign
        buffer.writeUInt16LE(this.bitsPerSample, 34);
        // data sub-chunk
        buffer.write('data', 36);
        buffer.writeUInt32LE(samples.length, 40);
        // Copy raw PCM data
        samples.copy(buffer, 44);

        return buffer;
    }
}
