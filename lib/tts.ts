import { KokoroTTS, TextSplitterStream } from 'kokoro-js';
import Anthropic from '@anthropic-ai/sdk';
import type { AppSettings } from '@/lib/settingsPersistence';
import type { TurnMeta } from '@/lib/transcriptParser';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const VOICE = 'af_heart';
const MODEL_LOAD_TIMEOUT_MS = 90_000;
const GENERATION_TIMEOUT_MS = 120_000;
const REMOTE_TIMEOUT_MS = 30_000;
const OLLAMA_MODEL_SELECT_TIMEOUT_MS = 5_000;
const MAX_TEXT_LENGTH = 50_000;
const SUMMARY_THRESHOLD = 300;
const PASS2_WORD_LIMIT = 80;
const SEE_DETAILS = 'See details below.';

function sanitizeHost(host: string): string {
  const clean = host.replace(/[^a-zA-Z0-9.\-[\]]/g, '');
  if (!clean || clean.includes('//') || clean.includes('#')) {
    throw new Error(`Invalid host: ${host}`);
  }
  return clean;
}

function sanitizePort(port: string): string {
  const n = parseInt(port, 10);
  if (!Number.isFinite(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid port: ${port}`);
  }
  return String(n);
}

function parseParamSize(paramSize: string): number {
  const match = paramSize.match(/^([\d.]+)\s*([bBmMkK])/);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  if (unit === 'B') return num * 1e9;
  if (unit === 'M') return num * 1e6;
  if (unit === 'K') return num * 1e3;
  return num;
}

interface OllamaModelInfo {
  name: string;
  size: number;
  details?: { parameter_size?: string };
}

function pickBestModel(models: OllamaModelInfo[]): OllamaModelInfo {
  return models.sort((a, b) => {
    const aParams = parseParamSize(a.details?.parameter_size ?? '');
    const bParams = parseParamSize(b.details?.parameter_size ?? '');
    if (aParams !== bParams) return bParams - aParams;
    return b.size - a.size;
  })[0];
}

async function selectOllamaModel(host: string, port: string): Promise<string> {
  const h = sanitizeHost(host);
  const p = sanitizePort(port);
  const baseUrl = `http://${h}:${p}`;

  async function fetchModels(endpoint: string): Promise<OllamaModelInfo[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OLLAMA_MODEL_SELECT_TIMEOUT_MS);
    try {
      const res = await fetch(`${baseUrl}${endpoint}`, { signal: controller.signal });
      if (!res.ok) return [];
      const data = await res.json();
      return data.models ?? [];
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  const loaded = await fetchModels('/api/ps');
  if (loaded.length > 0) {
    const best = pickBestModel(loaded);
    console.log(`[TTS] Ollama model: ${best.name} (loaded, ${best.details?.parameter_size ?? '?'})`);
    return best.name;
  }

  const downloaded = await fetchModels('/api/tags');
  if (downloaded.length > 0) {
    const best = pickBestModel(downloaded);
    console.log(`[TTS] Ollama model: ${best.name} (downloaded, ${best.details?.parameter_size ?? '?'})`);
    return best.name;
  }

  console.warn('[TTS] No Ollama models found, falling back to llama3.2:3b');
  return 'llama3.2:3b';
}

let ttsInstance: KokoroTTS | null = null;
let ttsLoading: Promise<KokoroTTS> | null = null;

export async function getTTS(): Promise<KokoroTTS> {
  if (ttsInstance) return ttsInstance;
  if (ttsLoading) return ttsLoading;

  let timer: ReturnType<typeof setTimeout>;
  ttsLoading = Promise.race([
    KokoroTTS.from_pretrained(MODEL_ID, { dtype: 'q8', device: 'cpu' }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('TTS model loading timed out')), MODEL_LOAD_TIMEOUT_MS);
    }),
  ]).then(instance => {
    clearTimeout(timer!);
    ttsInstance = instance;
    ttsLoading = null;
    return instance;
  }).catch(err => {
    clearTimeout(timer!);
    ttsLoading = null;
    throw err;
  });

  return ttsLoading;
}

export function warmupTTS(): void {
  getTTS().catch(err => console.warn('[TTS] warmup failed:', err));
}

export function prepareTextForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~(\d)/g, 'approximately $1')
    .replace(/\bdemos\b/gi, 'demonstrations')
    .replace(/\(lines?\s*\d+[\s\-–,\d]*\)/gi, '')
    .replace(/\|[^\n]+\|/g, '')
    .replace(/[-|:]{3,}/g, '')
    .replace(/#{1,6}\s+/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]*[/\\])([^/\\`]+?)(\.[a-zA-Z0-9]+)`/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[A-Za-z]:[/\\][^\s,)]+/g, (m) => {
      const base = m.split(/[/\\]/).pop() || m;
      return base.replace(/\.[a-zA-Z0-9]+$/, '');
    })
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/\n+/g, '. ')
    .replace(/\.\s*\./g, '.')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function truncateForSpeech(clean: string): string {
  if (clean.length <= SUMMARY_THRESHOLD) return clean;
  const cutoff = clean.indexOf('. ', SUMMARY_THRESHOLD);
  if (cutoff === -1) return clean;
  return clean.substring(0, cutoff + 1) + ' See details below.';
}

const TTS_SYSTEM_PROMPT =
  'You are preparing your own responses for text-to-speech playback. ' +
  'Speak in first person ("I" / "we") as the assistant who performed the work described. ' +
  'Output ONLY the result — never start with "Here\'s a summary" or similar preamble. ' +
  'No markdown, no formatting.';

const TTS_SUMMARIZE_PROMPT = 'Summarize this in 2-3 sentences for audio playback:\n\n';
const TTS_NATURALIZE_PROMPT = 'Rewrite this so it sounds natural when spoken aloud. Keep it brief, same meaning:\n\n';
const TTS_TIGHTEN_PROMPT = `Your previous summary is still too long for audio playback. Rewrite it in ${PASS2_WORD_LIMIT} words or fewer, keeping all key points but dropping minor details. No lists, no numbering, plain prose only:\n\n`;
const TTS_HEADLINE_PROMPT = 'In one short sentence under 20 words, say what this work accomplished. Do not mention file names or counts. Do not start with "this", "the", or "a". Output only the sentence:\n\n';
const IMPL_HEADLINE_MIN_CHARS = 200;

function countWords(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function postProcessSummary(s: string): string {
  return s
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\n+/g, '. ')
    // Drop the ":." artifact that appears when a line ending in ":" is
    // followed by a newline (the newline becomes a period above).
    .replace(/:\s*\./g, '.')
    .replace(/\.\s*\./g, '.')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Return the first sentence of a string. Trims to the first period,
 * exclamation, or question mark followed by whitespace (or end of string),
 * ignoring punctuation that immediately follows a colon or another period
 * (artifacts left over from postProcessSummary).
 */
function firstSentence(s: string): string {
  const m = s.match(/^.*?[^:.!?\s][.!?](?=\s|$)/);
  return m ? m[0] : s;
}

function withSeeDetails(s: string): string {
  const stripped = s
    .replace(/\s*[Ss]ee\s+(more\s+)?details?\s+below\.?\s*$/, '')
    .replace(/[.!?]+\s*$/, '')
    .trim();
  return `${stripped}. ${SEE_DETAILS}`;
}

async function summarizeWithHaiku(text: string, apiKey: string, prompt: string): Promise<string> {
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    system: TTS_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `${prompt}${text}`,
    }],
  });
  const block = response.content[0];
  if (block.type === 'text' && block.text.trim()) return block.text.trim();
  throw new Error('Empty AI summary');
}

async function summarizeWithOllama(text: string, host: string, port: string, prompt: string): Promise<string> {
  const h = sanitizeHost(host);
  const p = sanitizePort(port);
  const model = await selectOllamaModel(host, port);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
  try {
    const res = await fetch(`http://${h}:${p}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: TTS_SYSTEM_PROMPT },
          { role: 'user', content: `${prompt}${text}` },
        ],
        stream: false,
        options: { temperature: 0.3 },
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
    const data = await res.json();
    const summary = data.message?.content?.trim();
    if (!summary) throw new Error('Empty Ollama summary');
    return summary;
  } finally {
    clearTimeout(timer);
  }
}

function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const dataLength = samples.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataLength);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * numChannels * bytesPerSample, 28);
  buffer.writeUInt16LE(numChannels * bytesPerSample, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataLength, 40);

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7FFF, 44 + i * 2);
  }
  return buffer;
}

async function callSummarizer(
  text: string,
  prompt: string,
  settings: AppSettings,
): Promise<{ text: string; provider: 'haiku' | 'ollama' } | null> {
  if (settings.summarizerProvider === 'haiku' && settings.anthropicApiKey) {
    try {
      return { text: await summarizeWithHaiku(text, settings.anthropicApiKey, prompt), provider: 'haiku' };
    } catch (err) {
      console.warn('[TTS] Haiku failed, falling back:', err);
    }
  }
  if (settings.summarizerProvider === 'ollama' && settings.ollamaHost) {
    try {
      return { text: await summarizeWithOllama(text, settings.ollamaHost, settings.ollamaPort, prompt), provider: 'ollama' };
    } catch (err) {
      console.warn('[TTS] Ollama failed, falling back:', err);
    }
  }
  return null;
}

function basename(p: string): string {
  return p.split(/[/\\]/).pop() || p;
}

function implementationFilePhrase(meta: TurnMeta): string {
  const n = meta.writeFileCount;
  const first = meta.firstWriteFile ? basename(meta.firstWriteFile) : null;
  if (n === 1 && first) return `I updated ${first}`;
  if (n >= 2 && first) return `I updated ${n} files, starting with ${first}`;
  return `I updated ${n} files`;
}

async function summarizeText(clean: string, settings: AppSettings, turnMeta?: TurnMeta): Promise<{ text: string; method: string }> {
  // Implementation report path: when the turn touched any files, template
  // the file count deterministically. For longer responses also pull a
  // 1-sentence "what was accomplished" headline so the audio carries some
  // context, not just a filename. Short responses skip the LLM entirely.
  if (turnMeta && turnMeta.writeFileCount >= 1) {
    const filePhrase = implementationFilePhrase(turnMeta);
    let body = filePhrase;
    let method = 'impl-template';
    if (clean.length > IMPL_HEADLINE_MIN_CHARS) {
      const hl = await callSummarizer(clean, TTS_HEADLINE_PROMPT, settings);
      if (hl && hl.text.trim()) {
        const headline = firstSentence(postProcessSummary(hl.text));
        // Only use the headline if it survives trimming and stays under a
        // reasonable size (Mistral occasionally returns a verbose first
        // sentence; in that case the pure template is better).
        const words = countWords(headline);
        if (words > 0 && words <= 30) {
          body = `${headline.replace(/[.!?]+\s*$/, '')}. ${filePhrase}`;
          method = `impl-template+${hl.provider}`;
        }
      }
    }
    return { text: withSeeDetails(body), method };
  }

  const isShort = clean.length <= SUMMARY_THRESHOLD;
  const prompt = isShort ? TTS_NATURALIZE_PROMPT : TTS_SUMMARIZE_PROMPT;

  const pass1 = await callSummarizer(clean, prompt, settings);

  if (!pass1) {
    // No LLM available — short text spoken as-is, long text truncated
    if (isShort) return { text: clean, method: 'short' };
    return { text: truncateForSpeech(clean), method: 'truncate' };
  }

  if (isShort) {
    return { text: pass1.text, method: `${pass1.provider}-natural` };
  }

  // Long path: tighten with a second pass if pass 1 is still verbose,
  // then strip any list markers the model left behind and append the
  // "See details below." cue deterministically (never trust the model
  // to add it consistently).
  let body = pass1.text;
  let method: string = pass1.provider;
  if (countWords(body) > PASS2_WORD_LIMIT) {
    const pass2 = await callSummarizer(body, TTS_TIGHTEN_PROMPT, settings);
    if (pass2) {
      body = pass2.text;
      method = `${pass1.provider}-2pass`;
    }
  }
  body = postProcessSummary(body);
  return { text: withSeeDetails(body), method };
}

async function generateLocalAudio(spoken: string, signal?: AbortSignal): Promise<Buffer> {
  const tts = await getTTS();
  const genStart = Date.now();
  const chunks: Float32Array[] = [];
  const splitter = new TextSplitterStream();
  const stream = tts.stream(splitter, { voice: VOICE });
  splitter.push(spoken);
  splitter.close();

  for await (const { audio } of stream) {
    if (signal?.aborted) throw new DOMException('TTS aborted', 'AbortError');
    if (Date.now() - genStart > GENERATION_TIMEOUT_MS) {
      throw new Error('TTS generation timed out');
    }
    chunks.push(audio.audio);
  }
  if (chunks.length === 0) throw new Error('No audio generated');

  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const merged = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return encodeWav(merged, 24_000);
}

async function generateRemoteAudio(spoken: string, host: string, port: string, signal?: AbortSignal): Promise<Buffer> {
  const h = sanitizeHost(host);
  const p = sanitizePort(port);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    const res = await fetch(`http://${h}:${p}/kokoro/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: spoken }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Remote TTS returned ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

export async function generateSpeech(text: string, signal?: AbortSignal, settings?: AppSettings, turnMeta?: TurnMeta): Promise<Buffer> {
  if (text.length > MAX_TEXT_LENGTH) {
    throw new Error(`Text too long (${text.length} chars, max ${MAX_TEXT_LENGTH})`);
  }

  const t0 = Date.now();
  const clean = prepareTextForSpeech(text);
  if (!clean) throw new Error('No speakable text');

  const defaultSettings: AppSettings = {
    summarizerProvider: 'none', ollamaHost: '', ollamaPort: '11434',
    anthropicApiKey: null, ttsProvider: 'local', ttsRemoteHost: '', ttsRemotePort: '5656',
    promptSuggestionsEnabled: true, ttsEnabled: false, localhostOnly: true,
    authUsername: null, authPasswordHash: null,
    bedrockAwsProfile: '', bedrockAwsRegion: '', bedrockModel: '',
    bedrockSmallFastModel: '', bedrockAuthRefreshCmd: '',
    bedrockClaudeFailoverEnabled: false,
    pricingPollEnabled: true, pricingPollIntervalDays: 7,
  };
  const s = settings || defaultSettings;

  const { text: spoken, method } = await summarizeText(clean, s, turnMeta);
  const t1 = Date.now();

  let wav: Buffer;
  if (s.ttsProvider === 'remote' && s.ttsRemoteHost) {
    wav = await generateRemoteAudio(spoken, s.ttsRemoteHost, s.ttsRemotePort, signal);
  } else {
    wav = await generateLocalAudio(spoken, signal);
  }
  const t2 = Date.now();

  const audioDuration = (wav.length - 44) / 2 / 24000;
  console.log(`[TTS] summarize(${method})=${t1 - t0}ms  generate(${s.ttsProvider})=${t2 - t1}ms  total=${t2 - t0}ms  input=${clean.length}→${spoken.length}chars  audio=${audioDuration.toFixed(1)}s`);
  return wav;
}
