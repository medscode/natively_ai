/**
 * Node.js Worker Thread for ASR inference via @huggingface/transformers v3+.
 *
 * Supports two model families:
 *   - Whisper (and Distil-Whisper): batch-architected, 30s windows, slow but
 *     widely supported and multilingual.
 *   - Moonshine: streaming-architected with encoder caching + decoder state
 *     reuse, ~100× lower latency than Whisper Large v3 at comparable WER.
 *     English-only. Models load in 26–60MB quantized.
 *
 * @huggingface/transformers is ESM-only. The electron tsconfig compiles to
 * CommonJS, which means TypeScript rewrites `import()` to `require()`.
 * We bypass this by loading the package through `new Function(...)` so
 * the compiler never sees the import expression and Node.js handles it
 * natively as a true dynamic ESM import at runtime.
 */
import { parentPort } from 'worker_threads';
import { WhisperProgressAggregator } from './whisperProgressAggregator';
import { getBoundedOnnxSessionOptions } from '../../utils/onnxThreadConfig';

/**
 * Maps the persisted STT language key onto a Whisper decoder language name.
 *
 * The KEYS here must match what SettingsManager actually stores, which is the
 * INTERNAL key from electron/config/languages.ts RECOGNITION_LANGUAGES
 * ('hindi', 'english-us', 'auto', …) — the same key the UI language picker
 * round-trips via getRecognitionLanguages()/setRecognitionLanguage().
 *
 * This map previously keyed off BCP-47 codes ('hi-IN', 'en-US', …), which are
 * the `bcp47` FIELD of those entries and never the key. Every lookup therefore
 * missed, fell through to `?? null`, and silently ran the decoder on
 * auto-detect no matter what the user selected — auto-detect on short VAD
 * segments is unreliable and was the cause of poor non-English accuracy.
 * The bcp47 aliases are retained below so any older persisted value, or a
 * caller that passes a BCP-47 code directly, still resolves.
 */
const LANG_MAP: Record<string, string | null> = {
  'auto': null,

  // ── Canonical RECOGNITION_LANGUAGES keys (what Settings persists) ───────
  'english-us': 'english',
  'english-uk': 'english',
  'english-in': 'english',
  'english-au': 'english',
  'english-ca': 'english',
  'arabic': 'arabic',
  'bulgarian': 'bulgarian',
  'chinese': 'chinese',
  'czech': 'czech',
  'danish': 'danish',
  'dutch': 'dutch',
  'finnish': 'finnish',
  'french': 'french',
  'german': 'german',
  'greek': 'greek',
  'hebrew': 'hebrew',
  'hindi': 'hindi',
  'hungarian': 'hungarian',
  'indonesian': 'indonesian',
  'italian': 'italian',
  'japanese': 'japanese',
  'korean': 'korean',
  'malay': 'malay',
  'norwegian': 'norwegian',
  'polish': 'polish',
  'portuguese': 'portuguese',
  'romanian': 'romanian',
  'russian': 'russian',
  'spanish': 'spanish',
  'swedish': 'swedish',
  'thai': 'thai',
  'turkish': 'turkish',
  'ukrainian': 'ukrainian',
  'vietnamese': 'vietnamese',

  // ── Legacy/BCP-47 aliases (back-compat; not what the picker stores) ─────
  'en-US': 'english',
  'en-GB': 'english',
  'en-IN': 'english',
  'en-AU': 'english',
  'en-CA': 'english',
  'fr-FR': 'french',
  'de-DE': 'german',
  'es-ES': 'spanish',
  'ja-JP': 'japanese',
  'ko-KR': 'korean',
  'zh-CN': 'chinese',
  'zh-TW': 'chinese',
  'pt-BR': 'portuguese',
  'it-IT': 'italian',
  'ru-RU': 'russian',
  'ar': 'arabic',
  'hi-IN': 'hindi',
};

let pipe: any = null;
let loadedModelId = '';

// Tokenized prompt cache — populated by `setPrompt` messages, reused by
// every subsequent transcribe. Cleared on model swap.
//
// The transcribe message handler must remain serial w.r.t. setPrompt so we
// don't read a half-updated cache; the host-side caller (LocalWhisperSTT)
// posts setPrompt via the same MessagePort which Node guarantees orders
// strictly with transcribe messages. As long as no two transcribe messages
// are in flight concurrently (the streamingTaskInFlight guard ensures this),
// the cache is consistent.
let cachedPromptText = '';
let cachedPromptIds: number[] | null = null;

// Moonshine doesn't have Whisper's prompt_ids mechanism. Detect by model id
// so we silently skip the prompt parameter for Moonshine variants.
const isMoonshineModel = (id: string) => /\/moonshine-/i.test(id);

const PROMPT_TOKEN_CAP = 224; // Whisper's prompt window per generation_whisper.js

async function updatePromptCache(promptText: string): Promise<void> {
  const trimmed = (promptText ?? '').trim();
  if (!trimmed) {
    cachedPromptText = '';
    cachedPromptIds = null;
    return;
  }
  if (trimmed === cachedPromptText && cachedPromptIds !== null) return;
  if (!pipe?.tokenizer) return; // model not yet loaded
  if (isMoonshineModel(loadedModelId)) {
    // Skip tokenization entirely for Moonshine — no prompt mechanism.
    cachedPromptText = trimmed;
    cachedPromptIds = null;
    return;
  }
  try {
    // add_special_tokens=false: Whisper inserts <|startofprev|> itself.
    const encoded = await pipe.tokenizer(trimmed, { add_special_tokens: false });
    const raw = encoded?.input_ids?.tolist?.()?.[0] ?? [];
    // Truncate from the END (keep first 224). Session-static biasing prompts
    // typically front-load the most important vocabulary (attendee names,
    // company/project names, glossary terms), so dropping the tail of less
    // important tokens preserves the user's priority order.
    cachedPromptIds = raw.slice(0, PROMPT_TOKEN_CAP).map((n: bigint | number) => {
      const v = Number(n);
      // Whisper vocab is ~50k tokens — well under 2^53 — but if a future
      // model ships sentinel ids with high bits set, fail loud rather than
      // silently bias on a precision-lost token id.
      if (!Number.isSafeInteger(v)) {
        throw new Error(`Token id ${n} exceeds Number.MAX_SAFE_INTEGER — cannot use as prompt_id`);
      }
      return v;
    });
    cachedPromptText = trimmed;
    if (cachedPromptIds.length === 0) {
      console.debug('[WhisperWorker] Prompt tokenized to 0 ids — biasing disabled');
    }
  } catch (e: any) {
    console.warn('[WhisperWorker] Prompt tokenization failed:', e.message);
    cachedPromptText = '';
    cachedPromptIds = null;
  }
}

// Distil-Whisper checkpoints have NO multilingual decoder. If the user picks
// 'auto' or any non-English language, the worker will silently transcribe
// non-English audio as phonetic English. Force language='english' so the
// behaviour is at least documented and consistent.
const ENGLISH_ONLY_MODELS = new Set([
  // Moonshine — English-only by design
  'onnx-community/moonshine-tiny-ONNX',
  'onnx-community/moonshine-base-ONNX',
  // Distil-Whisper — English-only checkpoints
  'distil-whisper/distil-small.en',
  'distil-whisper/distil-medium.en',
  'distil-whisper/distil-large-v2',
  'distil-whisper/distil-large-v3',
  // Whisper .en variants
  'Xenova/whisper-tiny.en',
  'Xenova/whisper-base.en',
  'Xenova/whisper-small.en',
  'Xenova/whisper-medium.en',
]);

if (!parentPort) throw new Error('whisperWorker must be run as a Worker thread');

// Loads @huggingface/transformers via a real dynamic import() at runtime.
// Using new Function prevents TypeScript from rewriting import() → require()
// in the CommonJS output, which would fail because the package is ESM-only.
async function loadTransformers(): Promise<{ pipeline: any; env: any }> {
  return (new Function('return import("@huggingface/transformers")')()) as any;
}

parentPort.on('message', async (msg: any) => {
  if (msg.type === 'init') {
    // Validate required fields BEFORE entering the try/catch so the error
    // surfaces as a structured `error` postMessage rather than an unhandled
    // worker throw (which would leave the host's workerReady stuck false).
    if (msg.dtype === undefined || msg.dtype === null) {
      parentPort!.postMessage({
        type: 'error',
        message: 'init.dtype is required (use resolveInferenceConfig().dtype)',
      });
      return;
    }
    try {
      const { pipeline, env } = await loadTransformers();

      env.cacheDir = msg.cacheDir;
      env.allowRemoteModels = true;

      // Apply hardware-specific execution providers (CoreML, DirectML, CUDA, CPU)
      const providers: string[] = msg.executionProviders ?? ['cpu'];
      if (env.backends?.onnx) {
        env.backends.onnx.executionProviders = providers;
      }
      // Per-module dtype: required. @huggingface/transformers v3 no longer
      // honors the v2 `quantized: true` flag — must use `dtype` explicitly.
      const dtype: string | Record<string, string> = msg.dtype;
      // Sort entries for deterministic log output across runs.
      const dtypeDesc = typeof dtype === 'string'
        ? dtype
        : 'mixed:' + Object.entries(dtype).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join(',');
      const sessionOptions = getBoundedOnnxSessionOptions();

      console.log(`[WhisperWorker] Loading ${msg.modelId} | providers=${providers.join(',')} | dtype=${dtypeDesc}`);

      // DIAGNOSTICS (2026-06-13): the model files load fine in isolation (raw ORT +
      // transformers, both in system node), yet the live worker can fail with
      // "Protobuf parsing failed". Log the exact runtime view so the failing GUI run
      // prints precisely WHY — cacheDir, resolved file paths + sizes, ORT backend, and
      // the ORT version transformers actually bound. Cheap, init-only (not per-token).
      try {
        const _fs = require('fs');
        const _path = require('path');
        const _orgName = String(msg.modelId).split('/');
        const _modelDir = _path.join(String(msg.cacheDir), _orgName[0] || '', _orgName[1] || '', 'onnx');
        const _encName = typeof dtype === 'string' && dtype !== 'fp32' ? `encoder_model_${dtype}.onnx` : 'encoder_model.onnx';
        const _decName = typeof dtype === 'string' && dtype !== 'fp32' ? `decoder_model_merged_${dtype}.onnx` : 'decoder_model_merged.onnx';
        const _stat = (p: string) => { try { return _fs.statSync(p).size; } catch { return -1; } };
        let _ortVer = 'unknown';
        try { _ortVer = require('onnxruntime-node/package.json').version; } catch { /* bundled? */ }
        console.log('[WhisperWorker][diag]', JSON.stringify({
          cacheDir: String(msg.cacheDir),
          modelDir: _modelDir,
          modelDirExists: _fs.existsSync(_modelDir),
          encoderFile: _encName, encoderBytes: _stat(_path.join(_modelDir, _encName)),
          decoderFile: _decName, decoderBytes: _stat(_path.join(_modelDir, _decName)),
          providers, dtype: dtypeDesc,
          sessionOptions,
          ortNodeVersion: _ortVer,
          ortBackend: (env.backends?.onnx ? Object.keys(env.backends.onnx) : []),
          execEnv: { execPath: process.execPath, nodeVer: process.version, modules: process.versions.modules, electron: process.versions.electron || 'n/a' },
        }));
      } catch (diagErr: any) {
        console.log('[WhisperWorker][diag] diagnostics failed (non-fatal):', diagErr?.message);
      }

      // HF Transformers fires progress_callback per *file* (encoder, decoder,
      // tokenizer, config…). The raw `data.progress` is per-file 0..100, which
      // makes a model-level bar bounce around (3 → 2 → 100 → 5 → …) as files
      // start, complete, and new ones enter the stream. The byte-weighted
      // aggregation that turns those per-file events into a smooth model-level
      // percentage lives in whisperProgressAggregator.ts (pure + unit-tested);
      // see that file for the full rationale on why count-averaging produced
      // the old "jumps to ~80% then stalls" bug.
      //
      // expectedBytes = catalog download size, the denominator from byte zero.
      // 0 when unknown / lookup failed → the aggregator falls back to observed
      // file totals. The constructor sanitizes any non-finite/negative value.
      const aggregator = new WhisperProgressAggregator(Number(msg.expectedBytes));
      // External-data format: forwarded only when the catalog declares it (for
      // checkpoints whose config.json omits it, e.g. Whisper Large v3 Turbo).
      // When undefined, transformers falls back to the model's own config —
      // preserving prior behaviour for every self-declaring model. Without this
      // the sibling `*.onnx_data` weight file is never fetched and ORT aborts:
      // "filesystem error: in file_size: ... encoder_model.onnx_data".
      const useExternalDataFormat: boolean | Record<string, boolean> | undefined =
        msg.useExternalDataFormat;
      pipe = await pipeline('automatic-speech-recognition', msg.modelId, {
        dtype,
        session_options: sessionOptions,
        ...(useExternalDataFormat !== undefined
          ? { use_external_data_format: useExternalDataFormat }
          : {}),
        progress_callback: (data: any) => {
          const { pct } = aggregator.update(data);
          if (pct === null) return;
          parentPort!.postMessage({
            type: 'progress',
            modelId: msg.modelId,
            progress: pct,
          });
        },
      });
      loadedModelId = msg.modelId;
      // New model = stale prompt cache (different tokenizer vocab)
      cachedPromptText = '';
      cachedPromptIds = null;

      parentPort!.postMessage({ type: 'ready' });
    } catch (e: any) {
      // Full failure dump (2026-06-13 diag): the error message alone ("Protobuf
      // parsing failed") doesn't say WHICH file or WHY. Log the full error, stack,
      // and any ORT-specific cause so the failing GUI run is self-diagnosing.
      try {
        console.error('[WhisperWorker][diag] MODEL LOAD FAILED:', {
          modelId: msg.modelId,
          message: e?.message,
          name: e?.name,
          code: e?.code,
          cause: e?.cause ? String(e.cause).slice(0, 300) : undefined,
          stackHead: String(e?.stack || '').split('\n').slice(0, 5).join(' | '),
        });
      } catch { /* noop */ }
      parentPort!.postMessage({
        type: 'error',
        message: `Failed to load model: ${e.message}`,
      });
    }
  } else if (msg.type === 'setPrompt') {
    await updatePromptCache(msg.prompt);
  } else if (msg.type === 'transcribe') {
    if (!pipe) {
      parentPort!.postMessage({ type: 'error', message: 'Model not loaded' });
      return;
    }
    try {
      let language: string | null = LANG_MAP[msg.language] ?? null;
      const streaming: boolean = !!msg.streaming;
      const isEnglishOnly = ENGLISH_ONLY_MODELS.has(loadedModelId);

      // English-only checkpoints (Distil-Whisper + .en variants) have no
      // multilingual decoder. Transformers.js rejects `task` or `language`
      // params for these models with "Cannot specify `task` or `language`
      // for an English-only model". Drop BOTH params — the model is English
      // by definition, no need to force a language string.
      if (isEnglishOnly) {
        language = null;
      }

      // Streaming partial passes use deterministic settings so consecutive
      // overlapping windows are stable enough for LocalAgreement-2 to
      // converge on a committed prefix. Final passes use a different set of
      // params tuned for accuracy: condition_on_previous_text is enabled so
      // the decoder leverages state across the full segment, and the
      // no-speech / compression-ratio / logprob thresholds are tightened to
      // suppress the two main hallucination modes (repetition loops on quiet
      // audio, and low-confidence trailing words).
      //
      // `task` is set ONLY for multilingual models — same reason as above.
      const opts: any = streaming
        ? {
            sampling_rate: 16000,
            temperature: 0,
            // Streaming uses Whisper's default 0.6 — tighter gates on
            // partials cause flicker (text appears, then disappears when
            // the next partial gates it out). The final pass is the one
            // that commits or rejects.
            no_speech_threshold: 0.6,
            compression_ratio_threshold: 2.4,
            condition_on_previous_text: false,
            return_timestamps: false,
          }
        : {
            sampling_rate: 16000,
            temperature: 0,
            // Enable cross-sentence conditioning ONLY on finals. With it
            // off, the decoder re-decodes each segment from scratch and
            // loses coherence across sentence boundaries ("the meeting is
            // . the meeting is . the meeting is"). With it on, the
            // decoder leverages its previous output for the current chunk.
            // Safe on finals because the final pass runs once per segment
            // (no flapping).
            condition_on_previous_text: true,
            // Tighten Whisper's anti-loop gate from 2.4 → 2.0. Catches
            // "I am a big player I am a big player" repetitions on
            // near-silent segments that slip past 2.4.
            compression_ratio_threshold: 2.0,
            // Reject low-confidence trailing words. Whisper's default is
            // −1.0 (very permissive); −0.5 trims hallucinations without
            // chopping real words on typical speech.
            logprob_threshold: -0.5,
            // Lower threshold so quiet speakers aren't gated as silence.
            // 0.6 was the streaming default; 0.4 lets the model attempt
            // transcription on lower-energy audio that would otherwise be
            // skipped.
            no_speech_threshold: 0.4,
          };
      if (!isEnglishOnly) opts.task = 'transcribe';
      if (language) opts.language = language;

      // Use the pre-tokenized prompt cache populated by setPrompt messages.
      // Skip for Moonshine (cached IDs are null in that case anyway).
      if (cachedPromptIds && cachedPromptIds.length > 0 && !isMoonshineModel(loadedModelId)) {
        opts.prompt_ids = cachedPromptIds;
      }

      const result = await pipe(msg.audio, opts);
      parentPort!.postMessage({
        type: streaming ? 'partial' : 'result',
        taskId: msg.taskId,
        text: result.text ?? '',
      });
    } catch (e: any) {
      parentPort!.postMessage({
        type: 'error',
        taskId: msg.taskId,
        message: `Transcription failed: ${e.message}`,
      });
    }
  }
});
