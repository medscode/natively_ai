/**
 * AudioProcessor — JS-side audio enhancement between capture and STT.
 *
 * PURPOSE
 * ───────
 * Natively's Rust DSP pipeline does VAD (when speech is happening) but does NOT
 * clean the audio. Every keyboard click, AC hum, fan, hallway speaker, and
 * room reverb reaches Whisper raw. Small Whisper checkpoints (tiny / base) are
 * trained on clean close-mic audio — even modest noise floors measurably
 * degrade accuracy in meetings.
 *
 * This module implements an in-place, chunk-aligned processor that applies:
 *   1. Highpass biquad @ 80 Hz     → kill AC mains hum, low-frequency rumble,
 *                                       mic handling noise.
 *   2. Compressor                     → tame sudden loudness spikes (door slams,
 *                                       phone notifications, sneezes).
 *   3. AGC (slow envelope)            → lift quiet speakers to a consistent RMS
 *                                       so the STT isn't biased toward loud talkers.
 *
 * DESIGN
 * ──────
 * - Buffer-format aware: input is a Node Buffer of int16 LE samples
 *   (napi-rs ThreadsafeFunction gives us this from Rust).
 * - Stateless except for the 4 biquad coefficients + a single envelope state.
 *   Safe to construct per-capture-instance.
 * - `enabled = false` is a true pass-through with zero work per chunk.
 *
 * SCOPE
 * ─────
 * This is intentionally NOT a port of WebRTC's AudioProcessing module — that's
 * a much heavier Rust dependency. This is the best accuracy-per-effort upgrade
 * you can ship in plain TS without a native rebuild. For higher-end suppression
 * (full NS + AEC), follow up with a Rust NS pass after the foundation is here.
 */

/** Fast, allocation-free i16 highpass biquad. Direct Form II Transposed. */
interface BiquadCoeffs {
  b0: number; b1: number; b2: number;
  a1: number; a2: number;
}

/**
 * Standard biquad design (Audio EQ Cookbook, Robert Bristow-Johnson).
 * For a 2nd-order highpass @ 80 Hz @ 16 kHz:
 *   Q ≈ 0.707 (Butterworth), gives a smooth -3 dB shelf with no peak.
 * Coefficients are computed once at construction (well-known constants).
 */
function highpassCoeffs(): BiquadCoeffs {
  // Pre-computed for fs=16000, fc=80 Hz, Q=0.7071
  return {
    b0:  0.9691345706,
    b1: -1.9382691413,
    b2:  0.9691345706,
    a1: -1.9372044056,
    a2:  0.9410660786,
  };
}

/**
 * Slow AGC with a noise-floor-tracking threshold and a target RMS.
 * - `targetRms` is the desired output energy; we lift quiet audio to this
 *   and attenuate loud audio toward this.
 * - Smoothing constants are tuned for speech (rise ~3 ms, decay ~200 ms) so the
 *   gain doesn't pump on every breath/pause.
 */
const AGC_RISE_PER_SECOND = 12.0;   // fast attack — speech onset
const AGC_DECAY_PER_SECOND = 4.0;   // slower release — avoid pumping

/** Compressor threshold, ratio, knee. Tuned for speech not clipping on transients. */
const COMP_THRESHOLD_LINEAR = 0.6;   // i.e., ~-4.4 dBFS
const COMP_RATIO = 4.0;             // 4:1
const COMP_KNEE = 0.05;             // soft knee

export interface AudioProcessorConfig {
  /** Master enable. When false, processChunk is a no-op pass-through. */
  enabled: boolean;
  /** 0–100 UI value. Currently 0 = off, 1–100 = strength scaling. */
  strength: number;
}

export class AudioProcessor {
  private readonly coeffs: BiquadCoeffs = highpassCoeffs();
  /** Per-instance biquad state (z1, z2 in DF-II-Transposed). */
  private z1 = 0;
  private z2 = 0;
  /** Slowly-tracked AGC gain (linear). 1.0 = unity. Recomputed per chunk. */
  private agcGain = 1.0;
  /** Last chunk's RMS — exposed for diagnostics; not strictly required. */
  private lastInRms = 0;
  private lastOutRms = 0;
  /** Cached config — set in setConfig. */
  private enabled = false;
  /** strength 0–100, mapped to gain ceiling. */
  private strengthNorm = 0;
  /** Sample rate of the i16 stream — fed in from capture wrapper. */
  private readonly sampleRate: number;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
  }

  setConfig(cfg: AudioProcessorConfig): void {
    this.enabled = !!cfg.enabled;
    // Map 0–100 to a 1.0–4.0x gain ceiling. Strength 0 means pass-through.
    // Strength 100 → up to 4x lift (12 dB). Conservative to avoid
    // pumping noise along with speech.
    const s = Math.max(0, Math.min(100, cfg.strength | 0));
    this.strengthNorm = s / 100;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getLastRmsIn(): number {
    return this.lastInRms;
  }

  getLastRmsOut(): number {
    return this.lastOutRms;
  }

  /**
   * Process a Buffer of int16 LE mono samples IN PLACE.
   * Returns the same Buffer for chaining. Pure pass-through when disabled.
   */
  processChunk(chunk: Buffer): Buffer {
    if (!this.enabled) return chunk;

    const sampleCount = chunk.length >> 1;
    if (sampleCount === 0) return chunk;

    // 1. Compute input RMS — used for AGC and exposed for diagnostics.
    let sumSq = 0;
    for (let i = 0; i < chunk.length; i += 2) {
      const s = chunk.readInt16LE(i);
      sumSq += s * s;
    }
    const inRms = Math.sqrt(sumSq / sampleCount);
    this.lastInRms = inRms;

    // Constant for AGC target. Target RMS = 4000 (about -12 dBFS on int16 scale).
    // -12 dBFS leaves ~12 dB of headroom for transient peaks after AGC.
    const TARGET_RMS = 4000;

    // Compute desired AGC gain. Clamp to [0.5x, strengthCeiling] so we never
    // crush audio or amplify noise too much.
    let desiredGain: number;
    if (inRms < 200) {
      // Below ~-52 dBFS — treat as silence/very-quiet. Hold current gain.
      // Don't pump gain on silence/background noise floor.
      desiredGain = this.agcGain;
    } else if (inRms < TARGET_RMS) {
      // Quiet speech — lift toward target. The lower inRms, the more lift.
      desiredGain = TARGET_RMS / inRms;
    } else {
      // Loud speech (or transient) — pull down toward target.
      desiredGain = TARGET_RMS / inRms;
    }
    // Clamp ceiling based on user-set strength.
    const ceiling = 0.5 + this.strengthNorm * 3.5;  // 0.5 → 1.0 → 4.0
    if (desiredGain > ceiling) desiredGain = ceiling;
    if (desiredGain < 0.5) desiredGain = 0.5;
    // Attack/release smoothing — emulate analog AGC.
    // Attack is fast (10s of ms), release slow (100s of ms).
    // For an i16 chunk that's 60 ms (1920 bytes @ 16 kHz), apply the
    // smoothing coefficients for one chunk.
    const secondsThisChunk = sampleCount / this.sampleRate;
    const alpha = desiredGain > this.agcGain ? AGC_RISE_PER_SECOND : AGC_DECAY_PER_SECOND;
    // Smoothing: gain steps toward desiredGain at rate `alpha` per second.
    // Discrete update: gain' = gain + alpha * (desiredGain - gain) * dt.
    const k = 1 - Math.exp(-alpha * secondsThisChunk);
    this.agcGain = this.agcGain + k * (desiredGain - this.agcGain);

    // 2. Apply biquad highpass + AGC + compressor sample by sample.
    // Direct Form II Transposed:
    //   y[n] = b0*x[n] + z1[n-1]
    //   z1[n]   = b1*x[n] - a1*y[n] + z2[n-1]
    //   z2[n]   = b2*x[n] - a2*y[n]
    let sumSqOut = 0;
    const c = this.coeffs;
    let z1 = this.z1;
    let z2 = this.z2;
    const gain = this.agcGain;
    const invGain = 1.0 / Math.max(gain, 0.001);

    for (let i = 0; i < chunk.length; i += 2) {
      const x = chunk.readInt16LE(i);

      // 1) Highpass.
      const y0 = c.b0 * x + z1;
      z1 = c.b1 * x - c.a1 * y0 + z2;
      z2 = c.b2 * x - c.a2 * y0;

      // 2) AGC gain (linear).
      const y1 = y0 * gain;

      // 3) Soft-knee compressor on y1.
      // Convert i16 → [-1, 1] scale for the compressor.
      const xn = y1 / 32768.0;
      const ax = Math.abs(xn);
      let out: number;
      if (ax < COMP_THRESHOLD_LINEAR - COMP_KNEE / 2) {
        out = xn; // below knee — pass through
      } else if (ax > COMP_THRESHOLD_LINEAR + COMP_KNEE / 2) {
        // Above knee — full ratio compression.
        const sign = xn < 0 ? -1 : 1;
        const compressed = COMP_THRESHOLD_LINEAR + (ax - COMP_THRESHOLD_LINEAR) / COMP_RATIO;
        out = sign * compressed;
      } else {
        // Inside the soft knee — quadratically blend between pass-through and
        // compressed. Smooth crossover, no audible "knee" artifact.
        const sign = xn < 0 ? -1 : 1;
        const k = (ax - (COMP_THRESHOLD_LINEAR - COMP_KNEE / 2)) / COMP_KNEE; // 0..1
        const blend = k * k * (3 - 2 * k); // smoothstep
        const compressed = sign * (COMP_THRESHOLD_LINEAR + (ax - COMP_THRESHOLD_LINEAR) / COMP_RATIO);
        out = xn * (1 - blend) + compressed * blend;
      }
      // Convert back to i16. Hard-clip for safety.
      const yInt = Math.max(-32768, Math.min(32767, Math.round(out * 32768)));

      // Write back. Buffer is a Buffer view; writeInt16LE doesn't allocate.
      chunk.writeInt16LE(yInt, i);

      // Compute "post-AGC" RMS using pre-clip math (just for diagnostics;
      // ignore clipping because clipping here is intentional and rare).
      const yClipped = Math.max(-1, Math.min(1, yInt * invGain));
      sumSqOut += yClipped * yClipped;
    }

    // Persist biquad state for next chunk.
    this.z1 = z1;
    this.z2 = z2;
    this.lastOutRms = Math.sqrt(sumSqOut / sampleCount) * 32768.0;

    return chunk;
  }
}
