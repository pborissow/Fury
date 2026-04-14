import { test, expect } from '@playwright/test';

const AB_FORM_FILLER_TEXT = `All 4 steps are complete. Here's a summary:

**1. AcroForm templates copied** — 4 \`*_template.pdf\` files now in \`web/forms/pdf_templates/\`

**2. \`PdfGenerator.java\` rewritten** — Uses PDFBox AcroForm filling instead of OpenHTMLToPDF HTML rendering:
- \`fillTemplate()\` loads each PDF template, sets text fields via \`PDField.setValue()\`, checks checkboxes via \`PDCheckBox.check()\`, then flattens
- \`generatePdf()\` fills all 4 templates and merges them with \`PDFMergerUtility\`
- \`generateSinglePdf()\` fills one template
- \`buildFieldMap()\` preserved with the same field derivation logic (initials, date components, \`patientNamePrint\`, \`patientNameInsurance\`)
- \`getCheckedBoxes()\` replaces the old Unicode checkbox text with actual checkbox field names

**3. OpenHTMLToPDF removed** — Removed \`openhtmltopdf-core\`, \`openhtmltopdf-pdfbox\`, and \`graphics2d\` JARs from the classpath. Kept PDFBox, fontbox, pdfbox-io, xmpbox, and commons-logging (still needed).

**4. HTML templates deleted** — Removed the 4 \`.html\` files and the \`images/\` subdirectory from \`pdf_templates/\`.

No changes were needed to \`RegistrationService.java\`, \`Website.java\`, or any frontend code — the public API (\`generatePdf\`/\`generateSinglePdf\`) is unchanged.`;

// Service config is read from persisted settings — no hardcoded keys or hosts.
// Tests that require a specific service skip if it's not configured.

interface TimingResult {
  totalMs: number;
  wavBytes: number;
  audioDurationSec: number;
}

async function loadSettings(request: any) {
  const res = await request.get('/api/settings');
  expect(res.ok()).toBe(true);
  return res.json();
}

async function configureServices(
  request: any,
  opts: {
    summarizer: 'haiku' | 'ollama' | 'none';
    tts: 'local' | 'remote';
  },
) {
  const body: Record<string, unknown> = {
    ttsEnabled: true,
    summarizerProvider: opts.summarizer,
    ttsProvider: opts.tts,
  };
  const res = await request.post('/api/settings', { data: body });
  expect(res.ok()).toBe(true);
  return res.json();
}

async function generateSpeech(request: any): Promise<TimingResult> {
  const t0 = Date.now();
  const res = await request.post('/api/tts', {
    data: { text: AB_FORM_FILLER_TEXT },
  });
  const totalMs = Date.now() - t0;

  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('audio/wav');

  const body = await res.body();
  const wavBytes = body.length;
  const audioDurationSec = (wavBytes - 44) / 2 / 24000;

  return { totalMs, wavBytes, audioDurationSec };
}

function logResult(label: string, result: TimingResult) {
  console.log(
    `[${label}] ${result.totalMs}ms | ` +
    `${(result.wavBytes / 1024).toFixed(0)} KB | ` +
    `${result.audioDurationSec.toFixed(1)}s audio`
  );
}

test.describe('TTS service configurations', () => {
  test.setTimeout(120_000);

  let savedSettings: Record<string, unknown>;

  test.beforeAll(async ({ request }) => {
    const res = await request.get('/api/settings');
    savedSettings = await res.json();
  });

  test.afterAll(async ({ request }) => {
    await request.post('/api/settings', {
      data: {
        ttsEnabled: savedSettings.ttsEnabled,
        summarizerProvider: savedSettings.summarizerProvider,
        ttsProvider: savedSettings.ttsProvider,
        ollamaHost: savedSettings.ollamaHost,
        ollamaPort: savedSettings.ollamaPort,
        ttsRemoteHost: savedSettings.ttsRemoteHost,
        ttsRemotePort: savedSettings.ttsRemotePort,
      },
    });
  });

  test('Local TTS + Haiku summarizer', async ({ request }) => {
    const current = await loadSettings(request);
    test.skip(!current.hasAnthropicApiKey, 'No Anthropic API key configured');

    const settings = await configureServices(request, { summarizer: 'haiku', tts: 'local' });
    expect(settings.summarizerProvider).toBe('haiku');
    expect(settings.hasAnthropicApiKey).toBe(true);
    expect(settings.ttsProvider).toBe('local');

    const result = await generateSpeech(request);
    logResult('Local + Haiku', result);

    expect(result.wavBytes).toBeGreaterThan(10_000);
    expect(result.audioDurationSec).toBeGreaterThan(1);
    expect(result.audioDurationSec).toBeLessThan(60);
  });

  test('Local TTS + Ollama summarizer', async ({ request }) => {
    const current = await loadSettings(request);
    test.skip(!current.ollamaHost, 'No Ollama host configured');

    const settings = await configureServices(request, { summarizer: 'ollama', tts: 'local' });
    expect(settings.summarizerProvider).toBe('ollama');
    expect(settings.ollamaHost).toBeTruthy();
    expect(settings.ollamaPort).toBeTruthy();
    expect(settings.ttsProvider).toBe('local');

    const result = await generateSpeech(request);
    logResult('Local + Ollama', result);

    expect(result.wavBytes).toBeGreaterThan(10_000);
    expect(result.audioDurationSec).toBeGreaterThan(1);
    expect(result.audioDurationSec).toBeLessThan(60);
  });

  test('Remote TTS + Haiku summarizer', async ({ request }) => {
    const current = await loadSettings(request);
    test.skip(!current.hasAnthropicApiKey, 'No Anthropic API key configured');
    test.skip(!current.ttsRemoteHost, 'No remote TTS host configured');

    const settings = await configureServices(request, { summarizer: 'haiku', tts: 'remote' });
    expect(settings.summarizerProvider).toBe('haiku');
    expect(settings.hasAnthropicApiKey).toBe(true);
    expect(settings.ttsProvider).toBe('remote');
    expect(settings.ttsRemoteHost).toBeTruthy();
    expect(settings.ttsRemotePort).toBeTruthy();

    const result = await generateSpeech(request);
    logResult('Remote + Haiku', result);

    expect(result.wavBytes).toBeGreaterThan(10_000);
    expect(result.audioDurationSec).toBeGreaterThan(1);
    expect(result.audioDurationSec).toBeLessThan(60);
  });

  test('Remote TTS + Ollama summarizer', async ({ request }) => {
    const current = await loadSettings(request);
    test.skip(!current.ollamaHost, 'No Ollama host configured');
    test.skip(!current.ttsRemoteHost, 'No remote TTS host configured');

    const settings = await configureServices(request, { summarizer: 'ollama', tts: 'remote' });
    expect(settings.summarizerProvider).toBe('ollama');
    expect(settings.ollamaHost).toBeTruthy();
    expect(settings.ollamaPort).toBeTruthy();
    expect(settings.ttsProvider).toBe('remote');
    expect(settings.ttsRemoteHost).toBeTruthy();
    expect(settings.ttsRemotePort).toBeTruthy();

    const result = await generateSpeech(request);
    logResult('Remote + Ollama', result);

    expect(result.wavBytes).toBeGreaterThan(10_000);
    expect(result.audioDurationSec).toBeGreaterThan(1);
    expect(result.audioDurationSec).toBeLessThan(60);
  });
});
