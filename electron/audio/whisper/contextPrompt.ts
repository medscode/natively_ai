// Shared vocabulary prompt for Whisper-family STT.
//
// Used by Groq (whisper-large-v3-turbo), OpenAI REST (whisper-1), and the
// local onnx-whisper worker to bias the decoder toward roman-script Hinglish
// / Hindi-English code-mixing. Without a prompt, Whisper-large-v3-turbo
// auto-detects the dominant language and forces output to one script — which
// destroys in-the-moment code-mixing like "mai ye keh rhi thi ki we can go
// there and check...".
//
// The exemplar set is intentionally ~80 tokens / ~500 chars so it stays well
// inside Whisper's prompt budget when concatenated with user-supplied
// vocabulary. If a user pastes a long custom prompt, the local-whisper worker
// truncates at 224 tokens (see whisperWorker.updatePromptCache); the cloud
// REST providers truncate silently server-side.

export const HINGLISH_DEFAULT_PROMPT = `mai, hum, tum, aap, ye, wo, kya, kab, kahan, kaise, kyun, theek, chalo, jaldi, abhi, baad mein, pehle, kal, aaj, roz, bahut, bahut accha, ekdum, mast, yaar, yaaron, bhai, behen, didi, bhaiya, uncle, aunty, sir, ma'am, sahab, fix kar dunga, fix kar dungi, ho jayega, ho gaya, ho gayi, ho jayegi, dekh, suno, bolo, laga, laga diya, laga dunga, laga dungi, pata, pata nahi, samajh, samajh gaya, samajh gayi, chalta hai, chalega, nahi, haan, hanji, arey, arre, ohho, ugh, hmm, achha, okay ok, on me, don't worry, no problem, sorted, done, will do, let's see, let's go, by the way, hang on, hold on`;

export function buildWhisperPrompt(userPrompt: string | undefined | null): string {
    const trimmed = (userPrompt ?? '').toString().trim();
    // User-supplied vocabulary wins; falls back to the Hinglish default
    // when the setting is empty / unset.
    return trimmed || HINGLISH_DEFAULT_PROMPT;
}