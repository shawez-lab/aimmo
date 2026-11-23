/**
 * AU044 · Le vrai transcripteur des notes vocales, et la reprise de celles qu'il n'a pas pu lire, sous
 * `/v1/notes-vocales/reprises` [R696, R240, R241].
 *
 * Le transcripteur n'est fait que si tout est rangé (H52) : `TRANSCRIPTION_MODE` vaut `reel`, `TRANSCRIPTION_URL` est
 * l'adresse https du service (terminée par `/audio/transcriptions`), `TRANSCRIPTION_MODEL` son modèle et le secret
 * `TRANSCRIPTION_KEY` sa clé. Il manque une pièce, ou l'une est mal formée : aucun transcripteur, chaque note passe à
 * l'agent par sa reprise [R241]. Les notes WhatsApp demandent en plus le secret `WHATSAPP_MEDIA_TOKEN` (le jeton du
 * compte WhatsApp Business) pour lire le média ; Instagram et Messenger n'en demandent pas.
 *
 * Routes, pour un agent en activité du réseau ou la direction [R16] :
 *   GET  /v1/notes-vocales/reprises               : la file des reprises (à faire, puis les dernières faites)
 *   GET  /v1/notes-vocales/reprises/<id>/audio    : l'audio d'origine, lu chez Meta à l'instant, jamais gardé ici
 *   POST /v1/notes-vocales/reprises/<id>/faite    : la reprise faite, une fois
 */
import type { JournalStore, SqlDatabase, Viewer } from '@aimmo/core';
import type { Transcriber } from '../../core/src/voix/notes-vocales.ts';
import { ReprisesVocales } from '../../core/src/voix/reprises-vocales.ts';
import { AudioError, MetaAudioSource, SpeechTranscriber, validSpeechService, type AudioHttpFn, type AudioSource } from '../../core/src/voix/transcripteur-reel.ts';

export interface TranscriptionEnv {
  TRANSCRIPTION_MODE?: string | undefined;
  TRANSCRIPTION_URL?: string | undefined;
  TRANSCRIPTION_MODEL?: string | undefined;
  TRANSCRIPTION_KEY?: string | undefined;
  WHATSAPP_MEDIA_TOKEN?: string | undefined;
}

/** La lecture de l'audio chez Meta : toujours possible pour Instagram et Messenger, WhatsApp avec son jeton. */
export function audioSourceFromEnv(env: TranscriptionEnv, http: AudioHttpFn): AudioSource {
  const token = env.WHATSAPP_MEDIA_TOKEN?.trim() ?? '';
  return new MetaAudioSource({ whatsappToken: /^[\x21-\x7e]{10,1024}$/.test(token) ? token : null, http });
}

/** Le vrai transcripteur, ou `null` tant que la mise en service n'est pas complète [R696]. */
export function transcriberFromEnv(env: TranscriptionEnv, http: AudioHttpFn): Transcriber | null {
  if (env.TRANSCRIPTION_MODE !== 'reel') return null;
  const url = env.TRANSCRIPTION_URL?.trim() ?? '';
  const model = env.TRANSCRIPTION_MODEL?.trim() ?? '';
  const apiKey = env.TRANSCRIPTION_KEY?.trim() ?? '';
  if (!validSpeechService(url, model, apiKey)) return null;
  return new SpeechTranscriber(audioSourceFromEnv(env, http), { url, model, apiKey, http });
}

export interface ReprisesServices {
  db: SqlDatabase;
  journal: JournalStore;
  now: () => Date;
  /** La lecture de l'audio chez Meta ; absente, l'écoute est fermée. */
  audio: AudioSource | null;
}

export interface ReprisesRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  name: string;
  handle: (s: ReprisesServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...HEADERS } });

const MESSAGES: Readonly<Record<string, string>> = {
  role: 'Seuls un agent en activité du réseau ou la direction reprennent les notes vocales.',
  introuvable: 'Cette reprise de note vocale est introuvable.',
  deja_faite: 'Cette reprise est déjà faite.',
  unknown_field: 'Cette demande ne prend aucun paramètre.',
  ecoute_fermee: "L'écoute des notes vocales n'est pas encore ouverte.",
  reference: "L'audio de cette note n'est pas à une adresse lue par AIMMO.",
  acces: "AIMMO n'a pas le droit de lire cet audio chez le canal : le jeton WhatsApp manque ou a été retiré.",
  introuvable_audio: "Le canal n'a plus cet audio (il l'efface après quelques semaines) : rappelez la personne.",
  trop_gros: 'Cet audio est trop gros pour être écouté ici.',
  format: "Ce fichier n'est pas un audio lisible.",
  limite: 'Le canal limite les lectures : réessayez dans quelques minutes.',
  panne: 'Le canal ne répond pas : réessayez dans quelques minutes.',
};

const fail = (status: number, code: string, rule: string | null = 'R696'): Response => json(status, { ok: false, rule, code, message: MESSAGES[code] ?? code });

function noParams(request: Request): string | null {
  for (const k of new URL(request.url).searchParams.keys()) return k;
  return null;
}

const ID = '([A-Za-z0-9_-]{1,64})';

/** Les routes de `/v1/notes-vocales/reprises`, à ajouter à celles de `app.ts`. */
export function reprisesVocalesRoutes(): ReprisesRoute[] {
  return [
    {
      method: 'GET',
      pattern: /^\/notes-vocales\/reprises$/,
      name: 'notes_vocales.reprises',
      handle: async (s, viewer, _params, request) => {
        const field = noParams(request);
        if (field) return json(400, { ok: false, rule: null, code: 'unknown_field', field, message: MESSAGES.unknown_field });
        const r = await new ReprisesVocales(s.db, s.journal, { now: s.now }).list(viewer);
        if (!r.ok) return fail(r.status, r.code, r.code === 'role' ? 'R16' : 'R696');
        return json(200, { ok: true, data: { ...r.value, ecoute: s.audio !== null } });
      },
    },
    {
      method: 'GET',
      pattern: new RegExp(`^/notes-vocales/reprises/${ID}/audio$`),
      name: 'notes_vocales.reprise.audio',
      handle: async (s, viewer, params, request) => {
        const field = noParams(request);
        if (field) return json(400, { ok: false, rule: null, code: 'unknown_field', field, message: MESSAGES.unknown_field });
        const r = await new ReprisesVocales(s.db, s.journal, { now: s.now }).audioOf(viewer, params[0]!);
        if (!r.ok) return fail(r.status, r.code, r.code === 'role' ? 'R16' : 'R696');
        if (!s.audio) return fail(503, 'ecoute_fermee');
        try {
          const file = await s.audio.read(r.value);
          return new Response(file.bytes, { status: 200, headers: { 'content-type': file.type, 'content-disposition': 'inline', ...HEADERS } });
        } catch (error) {
          const code = error instanceof AudioError ? error.code : 'panne';
          const status = code === 'introuvable' ? 410 : code === 'limite' || code === 'panne' ? 502 : 422;
          return fail(status, code === 'introuvable' ? 'introuvable_audio' : code);
        }
      },
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/notes-vocales/reprises/${ID}/faite$`),
      name: 'notes_vocales.reprise.faite',
      handle: async (s, viewer, params, request) => {
        const field = noParams(request);
        if (field) return json(400, { ok: false, rule: null, code: 'unknown_field', field, message: MESSAGES.unknown_field });
        const r = await new ReprisesVocales(s.db, s.journal, { now: s.now }).done(viewer, params[0]!);
        if (!r.ok) return fail(r.status, r.code, r.code === 'role' ? 'R16' : 'R696');
        return json(200, { ok: true, data: r.value });
      },
    },
  ];
}
