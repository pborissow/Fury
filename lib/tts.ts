import { KokoroTTS, TextSplitterStream } from 'kokoro-js';
import Anthropic from '@anthropic-ai/sdk';
import type { AppSettings } from '@/lib/settingsPersistence';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const VOICE = 'af_heart';
const MODEL_LOAD_TIMEOUT_MS = 90_000;
const GENERATION_TIMEOUT_MS = 120_000;
const REMOTE_TIMEOUT_MS = 30_000;
const MAX_TEXT_LENGTH = 50_000;
const SUMMARY_THRESHOLD = 300;

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
    .replace(/```[\s\S]*?```/g, ' (code block omitted) ')
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

async function summarizeWithHaiku(text: string, apiKey: string): Promise<string> {
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: `Summarize the following in 2-3 sentences for text-to-speech. Write in natural speaking style, no markdown or formatting:\n\n${text}`,
    }],
  });
  const block = response.content[0];
  if (block.type === 'text' && block.text.trim()) return block.text.trim();
  throw new Error('Empty AI summary');
}

async function summarizeWithOllama(text: string, host: string, port: string): Promise<string> {
  const h = sanitizeHost(host);
  const p = sanitizePort(port);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
  try {
    const res = await fetch(`http://${h}:${p}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3.2:3b',
        messages: [{
          role: 'user',
          content: `Summarize the following in 2-3 sentences for text-to-speech. Write in natural speaking style, no markdown or formatting:\n\n${text}`,
        }],
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

async function summarizeText(clean: string, settings: AppSettings): Promise<{ text: string; method: string }> {
  if (clean.length <= SUMMARY_THRESHOLD) return { text: clean, method: 'short' };

  if (settings.summarizerProvider === 'haiku' && settings.anthropicApiKey) {
    try {
      return { text: await summarizeWithHaiku(clean, settings.anthropicApiKey), method: 'haiku' };
    } catch (err) {
      console.warn('[TTS] Haiku summarization failed, falling back to truncation:', err);
    }
  }

  if (settings.summarizerProvider === 'ollama' && settings.ollamaHost) {
    try {
      return { text: await summarizeWithOllama(clean, settings.ollamaHost, settings.ollamaPort), method: 'ollama' };
    } catch (err) {
      console.warn('[TTS] Ollama summarization failed, falling back to truncation:', err);
    }
  }

  return { text: truncateForSpeech(clean), method: 'truncate' };
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
    const res = await fetch(`http://${h}:${p}/api/tts`, {
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

export async function generateSpeech(text: string, signal?: AbortSignal, settings?: AppSettings): Promise<Buffer> {
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
  };
  const s = settings || defaultSettings;

  const { text: spoken, method } = await summarizeText(clean, s);
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
