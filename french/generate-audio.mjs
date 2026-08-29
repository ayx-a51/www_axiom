#!/usr/bin/env node
/**
 * Erzeugt MP3-Aufnahmen für alle Vokabeln in index.html via ElevenLabs
 * und pflegt die AUDIO-Map in index.html.
 *
 * Nutzung (im Ordner french/ oder mit Pfad):
 *   ELEVENLABS_API_KEY=... node generate-audio.mjs        # fehlende Aufnahmen erzeugen
 *   node generate-audio.mjs --rescan                      # nur Map aus vorhandenen Dateien bauen
 *
 * Optionen:
 *   --force            alle Aufnahmen neu erzeugen (auch vorhandene)
 *   --dry              nur anzeigen, was erzeugt würde
 *   --voice <id>       bestimmte ElevenLabs-Stimme benutzen (sonst: erste
 *                      französische Stimme der eigenen Bibliothek, sonst
 *                      Standard-Stimme mit erzwungenem Französisch)
 *   --model <id>       Modell überschreiben (Standard: eleven_multilingual_v2)
 *   --no-context       ohne Satz-Kontext erzeugen (Standard: mit Kontext —
 *                      previous_text/next_text geben der Stimme einen
 *                      gedachten Satz drumherum, was einzelne Wörter viel
 *                      natürlicher klingen lässt; der Kontext selbst wird
 *                      nicht mitgesprochen)
 *   --speed <n>        Sprechtempo 0.7–1.2 (Standard: 0.8 — etwas langsamer,
 *                      gut zum Lernen; 1.0 = natürliches Tempo der Stimme)
 *
 * Der API-Schlüssel kommt NUR aus der Umgebung (ELEVENLABS_API_KEY) und
 * landet nie im Repo. Stimme wahlweise auch via ELEVEN_VOICE_ID.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(DIR, 'index.html');
const AUDIO_DIR = join(DIR, 'audio');
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

// WICHTIG: identisch zu audioSlug() in index.html halten!
const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/œ/g, 'oe').replace(/æ/g, 'ae')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const stripParens = (s) => s.replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();

const html = readFileSync(HTML_PATH, 'utf8');
const m = html.match(/const VOCAB = (\[[\s\S]*?\n\]);/);
if (!m) { console.error('VOCAB-Array in index.html nicht gefunden.'); process.exit(1); }
const vocab = new Function('return ' + m[1])();
const entries = vocab.map((w) => ({ slug: slug(w.fr), text: stripParens(w.fr) }));
console.log(entries.length + ' Vokabeln in index.html gefunden.');

mkdirSync(AUDIO_DIR, { recursive: true });
const filesOnDisk = () => new Set(
  readdirSync(AUDIO_DIR).filter((f) => f.endsWith('.mp3')).map((f) => f.slice(0, -4)),
);

function updateMap() {
  const disk = filesOnDisk();
  const map = {};
  for (const e of entries) if (disk.has(e.slug)) map[e.slug] = 1;
  const json = JSON.stringify(map);
  const fresh = readFileSync(HTML_PATH, 'utf8');
  const updated = fresh.replace(
    /\/\*AUDIO-MAP\*\/[\s\S]*?\/\*AUDIO-MAP-END\*\//,
    '/*AUDIO-MAP*/' + json + '/*AUDIO-MAP-END*/',
  );
  if (updated === fresh && !fresh.includes('/*AUDIO-MAP*/' + json + '/*AUDIO-MAP-END*/')) {
    console.error('AUDIO-MAP-Marker in index.html nicht gefunden.');
    process.exit(1);
  }
  writeFileSync(HTML_PATH, updated);
  console.log('AUDIO-Map aktualisiert: ' + Object.keys(map).length + ' Aufnahmen eingetragen.');
  const stale = [...disk].filter((s) => !entries.some((e) => e.slug === s));
  if (stale.length) console.log('Hinweis: verwaiste Dateien ohne Vokabel: ' + stale.join(', '));
}

async function pickVoice(KEY) {
  const explicit = opt('--voice') || process.env.ELEVEN_VOICE_ID;
  if (explicit) return { voice: explicit, model: opt('--model') || 'eleven_multilingual_v2', langCode: false };
  const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': KEY } });
  if (!r.ok) { console.error('Stimmen-Abruf fehlgeschlagen: ' + r.status + ' ' + (await r.text())); process.exit(1); }
  const { voices } = await r.json();
  const isFrench = (v) => {
    const hay = JSON.stringify(v.labels || {}) + ' ' + (v.name || '') + ' ' +
      JSON.stringify(v.verified_languages || []);
    return /fran[cç]ais|french|"fr"|'fr'|\bfr\b/i.test(hay);
  };
  const fr = voices.find(isFrench);
  if (fr) {
    console.log('Französische Stimme gefunden: ' + fr.name + ' (' + fr.voice_id + ')');
    return { voice: fr.voice_id, model: opt('--model') || 'eleven_multilingual_v2', langCode: false };
  }
  const v0 = voices[0];
  if (!v0) { console.error('Keine Stimmen im Konto gefunden.'); process.exit(1); }
  console.log('Keine französisch markierte Stimme – nutze «' + v0.name + '» mit erzwungenem Französisch (eleven_turbo_v2_5).');
  return { voice: v0.voice_id, model: opt('--model') || 'eleven_turbo_v2_5', langCode: true };
}

// Gedachter Satz um das Wort herum: wird nicht mitgesprochen, gibt aber
// natürliche Betonung statt abgehacktem Einzelwort-Klang.
const CTX_PREV = 'Écoute bien, voici le mot : ';
const CTX_NEXT = ' Tu peux le répéter.';

async function ttsOne(KEY, cfg, text, outPath) {
  const useCtx = !has('--no-context');
  const speed = Math.min(1.2, Math.max(0.7, parseFloat(opt('--speed') || '0.8')));
  const body = { text, model_id: cfg.model };
  if (cfg.langCode) body.language_code = 'fr';
  if (useCtx) { body.previous_text = CTX_PREV; body.next_text = CTX_NEXT; }
  if (speed !== 1) body.voice_settings = { speed };
  for (let attempt = 1; attempt <= 4; attempt++) {
    const r = await fetch(
      'https://api.elevenlabs.io/v1/text-to-speech/' + cfg.voice + '?output_format=mp3_44100_64',
      {
        method: 'POST',
        headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    if (r.ok) {
      writeFileSync(outPath, Buffer.from(await r.arrayBuffer()));
      return;
    }
    const errText = await r.text();
    if (r.status === 400 && body.voice_settings) {
      // Modell mag das Tempo nicht → einmal ohne voice_settings versuchen
      console.log('  400 mit voice_settings – Versuch ohne Tempo-Einstellung');
      delete body.voice_settings;
      continue;
    }
    if (r.status === 400 && (body.previous_text || body.next_text)) {
      // Modell/Endpoint mag den Kontext nicht → einmal ohne versuchen
      console.log('  400 mit Kontext – Versuch ohne previous_text/next_text');
      delete body.previous_text;
      delete body.next_text;
      continue;
    }
    if ((r.status === 429 || r.status >= 500) && attempt < 4) {
      const wait = 2000 * attempt;
      console.log('  ' + r.status + ' – neuer Versuch in ' + wait / 1000 + 's');
      await new Promise((res) => setTimeout(res, wait));
      continue;
    }
    throw new Error('ElevenLabs ' + r.status + ': ' + errText.slice(0, 300));
  }
}

async function generate() {
  const KEY = process.env.ELEVENLABS_API_KEY;
  if (!KEY) {
    console.error('ELEVENLABS_API_KEY fehlt. Nur Map bauen: --rescan');
    process.exit(1);
  }
  const disk = filesOnDisk();
  const todo = entries.filter((e) => has('--force') || !disk.has(e.slug));
  const chars = todo.reduce((n, e) => n + e.text.length, 0);
  console.log(todo.length + ' Aufnahmen zu erzeugen (' + chars + ' Zeichen).');
  if (!todo.length) { updateMap(); return; }
  if (has('--dry')) { todo.forEach((e) => console.log('  ' + e.slug + '  ←  «' + e.text + '»')); return; }

  const cfg = await pickVoice(KEY);
  let done = 0;
  for (const e of todo) {
    await ttsOne(KEY, cfg, e.text, join(AUDIO_DIR, e.slug + '.mp3'));
    done++;
    console.log('  [' + done + '/' + todo.length + '] ' + e.slug + '.mp3  («' + e.text + '»)');
    await new Promise((res) => setTimeout(res, 350));   // sanft zum Rate-Limit
  }
  updateMap();
  console.log('Fertig. Dateien in french/audio/ — committen nicht vergessen.');
}

if (has('--rescan')) updateMap();
else generate().catch((e) => { console.error(e.message || e); process.exit(1); });
