/**
 * Le vrai transcripteur des notes vocales (AU044), derrière l'interface `Transcriber` de HX23.
 *
 * Il n'est fait que par le Worker, et seulement quand tout est rangé (H52) : le mode `reel`, l'adresse https du service
 * de transcription, son modèle et sa clé. Sinon, aucun transcripteur : chaque note passe à l'agent [R241, R696].
 *
 * Deux pièces :
 * - `MetaAudioSource` va chercher l'audio d'origine chez le canal, en lecture seule : pour WhatsApp, le média par son
 *   identifiant à l'API Graph puis son fichier, avec le jeton du compte WhatsApp ; pour Instagram et Messenger, le
 *   fichier à l'adresse que Meta a donnée. Seules les adresses https des serveurs de fichiers de Meta sont lues (une
 *   autre adresse, un port, un identifiant mal formé sont refusés sans rien appeler), 25 Mo au plus. La même pièce
 *   sert à l'agent qui écoute une note en reprise.
 * - `SpeechTranscriber` envoie ce seul fichier au service, au format des services compatibles avec l'API de
 *   transcription d'OpenAI (`/audio/transcriptions`, réponse `verbose_json`) : ni fiche, ni nom, ni numéro, ni le texte
 *   d'un autre message [R15]. La confiance est tirée des segments rendus (probabilité moyenne des mots, moins la part de
 *   silence) ; un service qui ne rend pas de segments donne une confiance nulle, donc une note incertaine passée à
 *   l'agent [R241] : jamais une confiance devinée.
 *
 * Chaque échec devient une `AudioError` au code fermé : `reference` (identifiant ou adresse refusés), `acces` (jeton
 * absent ou refusé), `introuvable` (média expiré ou effacé), `trop_gros`, `format` (fichier qui n'est pas un audio lu par
 * le service), `limite` (quota), `panne` (service indisponible ou réponse illisible). Ni la clé, ni le jeton, ni
 * l'adresse du média, ni la réponse du service ne sortent d'ici : seul le code [R13].
 */
import type { Transcript, Transcriber, VoiceAudio } from './notes-vocales.ts';

export const AUDIO_ERROR_CODES = ['reference', 'acces', 'introuvable', 'trop_gros', 'format', 'limite', 'panne'] as const;
export type AudioErrorCode = (typeof AUDIO_ERROR_CODES)[number];

/** Une panne de la lecture de l'audio ou de sa transcription : le code seul, jamais le message du service [R13]. */
export class AudioError extends Error {
  override readonly name = 'AudioError';
  constructor(readonly code: AudioErrorCode) {
    super(`Note vocale : ${code}.`);
  }
}

export type AudioHttpFn = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: FormData | string; redirect?: 'manual'; signal?: AbortSignal },
) => Promise<Response>;

/** Au-delà, l'audio n'est ni lu ni transcrit : WhatsApp en limite les notes à 16 Mo, les services à 25 Mo. */
export const AUDIO_MAX_BYTES = 25 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const GRAPH = 'https://graph.facebook.com/v21.0';
/** Un identifiant de média WhatsApp : des chiffres seulement. */
const WA_MEDIA_ID = /^[0-9]{1,32}$/;
/** Les serveurs de fichiers de Meta, seuls lus. */
const META_FILE_HOSTS = [/^lookaside\.fbsbx\.com$/, /^[a-z0-9-]+(\.[a-z0-9-]+)*\.fbcdn\.net$/, /^[a-z0-9-]+(\.[a-z0-9-]+)*\.cdninstagram\.com$/, /^[a-z0-9-]+(\.[a-z0-9-]+)*\.fbsbx\.com$/];

/** Les sortes d'audio envoyées au service, et le nom de fichier qui les dit. Une autre sorte : `format`. */
const AUDIO_TYPES: Readonly<Record<string, string>> = Object.freeze({
  'audio/ogg': 'note.ogg',
  'audio/opus': 'note.ogg',
  'audio/mpeg': 'note.mp3',
  'audio/mp3': 'note.mp3',
  'audio/mp4': 'note.m4a',
  'audio/m4a': 'note.m4a',
  'audio/x-m4a': 'note.m4a',
  'audio/aac': 'note.m4a',
  'audio/wav': 'note.wav',
  'audio/x-wav': 'note.wav',
  'audio/webm': 'note.webm',
  'video/mp4': 'note.mp4',
});

/** La sorte d'un audio, sans ses paramètres (`audio/ogg; codecs=opus` → `audio/ogg`), ou null si elle n'est pas lue. */
export function audioType(mime: string | null | undefined): string | null {
  const base = (mime ?? '').split(';')[0]!.trim().toLowerCase();
  return base in AUDIO_TYPES ? base : null;
}

/** Vrai pour une adresse https d'un serveur de fichiers de Meta, sans port ni identifiants. */
export function isMetaFileUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') return false;
  return META_FILE_HOSTS.some((h) => h.test(url.hostname.toLowerCase()));
}

export interface AudioFile {
  bytes: Uint8Array;
  /** La sorte lue (`audio/ogg`…), toujours l'une de celles que le service reçoit. */
  type: string;
}

/** Ce qui va chercher l'audio d'origine d'une note. */
export interface AudioSource {
  fetch(audio: VoiceAudio): Promise<AudioFile>;
}

export interface MetaAudioConfig {
  /** Le jeton du compte WhatsApp Business (un secret du Worker) ; absent, une note WhatsApp donne `acces`. */
  whatsappToken: string | null;
  http: AudioHttpFn;
  timeoutMs?: number;
}

function statusError(status: number): AudioError {
  if (status === 401 || status === 403) return new AudioError('acces');
  if (status === 404 || status === 410) return new AudioError('introuvable');
  if (status === 413) return new AudioError('trop_gros');
  if (status === 415 || status === 400 || status === 422) return new AudioError('format');
  if (status === 429) return new AudioError('limite');
  return new AudioError('panne');
}

/** Lit un corps sans jamais dépasser la limite. */
async function readCapped(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > AUDIO_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new AudioError('trop_gros');
  }
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > AUDIO_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new AudioError('trop_gros');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export class MetaAudioSource implements AudioSource {
  private readonly timeoutMs: number;
  constructor(private readonly config: MetaAudioConfig) {
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  async fetch(audio: VoiceAudio): Promise<AudioFile> {
    if (audio.channel === 'whatsapp') return this.whatsApp(audio);
    if (!isMetaFileUrl(audio.mediaRef)) throw new AudioError('reference');
    return this.file(audio.mediaRef, null, audio.mime);
  }

  private async whatsApp(audio: VoiceAudio): Promise<AudioFile> {
    if (!WA_MEDIA_ID.test(audio.mediaRef)) throw new AudioError('reference');
    const token = this.config.whatsappToken?.trim() ?? '';
    if (token === '') throw new AudioError('acces');
    const auth = { authorization: `Bearer ${token}` };
    const meta = await this.call(`${GRAPH}/${audio.mediaRef}`, auth);
    if (!meta.ok) throw statusError(meta.status);
    let body: unknown;
    try {
      body = await meta.json();
    } catch {
      throw new AudioError('panne');
    }
    const url = body !== null && typeof body === 'object' ? (body as Record<string, unknown>).url : undefined;
    const mime = body !== null && typeof body === 'object' ? (body as Record<string, unknown>).mime_type : undefined;
    if (typeof url !== 'string' || !isMetaFileUrl(url)) throw new AudioError('panne');
    return this.file(url, auth, typeof mime === 'string' ? mime : audio.mime);
  }

  /** Le fichier, en suivant au plus trois renvois, chacun vérifié ; le jeton ne suit jamais un renvoi. */
  private async file(start: string, auth: Record<string, string> | null, declared: string | null): Promise<AudioFile> {
    let url = start;
    let headers = auth ?? {};
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await this.call(url, headers);
      if (response.status >= 300 && response.status < 400) {
        const next = response.headers.get('location');
        await response.body?.cancel().catch(() => undefined);
        if (next === null) throw new AudioError('panne');
        let resolved: string;
        try {
          resolved = new URL(next, url).toString();
        } catch {
          throw new AudioError('reference');
        }
        if (!isMetaFileUrl(resolved)) throw new AudioError('reference');
        url = resolved;
        headers = {};
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw statusError(response.status);
      }
      const type = audioType(response.headers.get('content-type')) ?? audioType(declared);
      if (type === null) {
        await response.body?.cancel().catch(() => undefined);
        throw new AudioError('format');
      }
      const bytes = await readCapped(response);
      if (bytes.length === 0) throw new AudioError('format');
      return { bytes, type };
    }
    throw new AudioError('panne');
  }

  private async call(url: string, headers: Record<string, string>): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.config.http(url, { method: 'GET', headers, redirect: 'manual', signal: controller.signal });
    } catch {
      throw new AudioError('panne');
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Les langues que le service peut rendre par leur nom ; un code court est gardé tel quel. */
const LANGUAGE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  french: 'fr',
  english: 'en',
  arabic: 'ar',
  spanish: 'es',
  german: 'de',
  italian: 'it',
  portuguese: 'pt',
  dutch: 'nl',
  turkish: 'tr',
  russian: 'ru',
  chinese: 'zh',
  japanese: 'ja',
  polish: 'pl',
  romanian: 'ro',
  ukrainian: 'uk',
});
const LANGUAGE_CODE = /^[a-z]{2,3}$/;

/**
 * Lit la réponse `verbose_json` du service. La confiance est la moyenne, pondérée par la durée de chaque segment, de
 * exp(probabilité moyenne des mots) × (1 − probabilité de silence). Sans segment lisible : 0, jamais une valeur devinée.
 */
export function readSpeechResponse(body: unknown): Transcript {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new AudioError('panne');
  const b = body as Record<string, unknown>;
  if (typeof b.text !== 'string') throw new AudioError('panne');
  const rawLanguage = typeof b.language === 'string' ? b.language.trim().toLowerCase() : '';
  const language = LANGUAGE_CODE.test(rawLanguage) ? rawLanguage : (LANGUAGE_NAMES[rawLanguage] ?? null);
  let weight = 0;
  let total = 0;
  const segments = Array.isArray(b.segments) ? b.segments : [];
  for (const s of segments) {
    if (s === null || typeof s !== 'object') continue;
    const seg = s as Record<string, unknown>;
    const logprob = seg.avg_logprob;
    const silence = typeof seg.no_speech_prob === 'number' && Number.isFinite(seg.no_speech_prob) ? Math.min(1, Math.max(0, seg.no_speech_prob)) : null;
    if (typeof logprob !== 'number' || !Number.isFinite(logprob) || logprob > 0 || silence === null) continue;
    const start = typeof seg.start === 'number' ? seg.start : NaN;
    const end = typeof seg.end === 'number' ? seg.end : NaN;
    const span = Number.isFinite(start) && Number.isFinite(end) && end > start ? end - start : 0;
    if (span <= 0) continue;
    weight += span;
    total += span * Math.exp(logprob) * (1 - silence);
  }
  const confidence = weight > 0 ? Math.round((total / weight) * 1000) / 1000 : 0;
  return { text: b.text, language, confidence: Math.min(1, Math.max(0, confidence)) };
}

export interface SpeechServiceConfig {
  /** L'adresse https du service, terminée par `/audio/transcriptions`. */
  url: string;
  /** La clé du service (un secret du Worker, jamais écrite ailleurs). */
  apiKey: string;
  /** Le modèle, qui doit rendre des segments en `verbose_json` (par exemple `whisper-1`). */
  model: string;
  http: AudioHttpFn;
  timeoutMs?: number;
}

const SPEECH_URL = /^https:\/\/[a-z0-9.-]+(\/[A-Za-z0-9._~\/-]*)?\/audio\/transcriptions$/;
const MODEL = /^[A-Za-z0-9._:\/-]{1,100}$/;

/** Vrai si la configuration du service est bien formée ; sinon le Worker ne fait aucun transcripteur [R696]. */
export function validSpeechService(url: string, model: string, apiKey: string): boolean {
  return SPEECH_URL.test(url) && MODEL.test(model) && /^[\x21-\x7e]{10,512}$/.test(apiKey);
}

/** Le vrai transcripteur : l'audio d'origine seul part au service [R15]. Un échec lève une `AudioError`. */
export class SpeechTranscriber implements Transcriber {
  private readonly timeoutMs: number;
  constructor(
    private readonly source: AudioSource,
    private readonly service: SpeechServiceConfig,
  ) {
    if (!validSpeechService(service.url, service.model, service.apiKey)) throw new Error('Service de transcription mal réglé.');
    this.timeoutMs = service.timeoutMs ?? 15_000;
  }

  async transcribe(audio: VoiceAudio): Promise<Transcript> {
    const file = await this.source.fetch(audio);
    const form = new FormData();
    form.append('file', new Blob([file.bytes], { type: file.type }), AUDIO_TYPES[file.type] ?? 'note.ogg');
    form.append('model', this.service.model);
    form.append('response_format', 'verbose_json');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.service.http(this.service.url, { method: 'POST', headers: { authorization: `Bearer ${this.service.apiKey}` }, body: form, redirect: 'manual', signal: controller.signal });
    } catch {
      throw new AudioError('panne');
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw statusError(response.status);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new AudioError('panne');
    }
    return readSpeechResponse(body);
  }
}
