/**
 * Les notes vocales reçues (HX23) : une note vocale sur WhatsApp, Instagram ou Messenger entre dans la chaîne de
 * captation (C01, C06) comme le même texte écrit. Elle est transcrite une seule fois [R18], la transcription est rangée
 * comme telle et liée à son audio d'origine chez le canal [R240], puis la chaîne la reçoit, la qualifie (Q01) et y répond
 * exactement comme à un message écrit.
 *
 * Une transcription impossible (service absent, en panne, trop lent, vide ou incertaine) ne devient jamais un texte :
 * la note est rangée illisible, son contenu brut gardé pour que l'agent l'écoute, et rien ne lui répond [R241].
 *
 * Ni le texte ni l'audio ne vont au journal [R13]. Le transcripteur ne reçoit que la référence de l'audio, jamais la
 * fiche ni les coordonnées de la personne [R15]. La chaîne, les adaptateurs et la réception ne changent pas : la note est
 * réécrite dans la notification brute avant qu'elle ne la lise.
 */
import type { Acces, AccessResult } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { ChaineCaptation, ChainHooks, ChainResult } from '../captation/chaine.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { maskIban } from '../envoi/texte.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { AdaptContext, UnreadableInbound } from '../reception/entrant.ts';
import type { Reception } from '../reception/reception.ts';

export type VoiceChannel = 'whatsapp' | 'instagram' | 'facebook';

/** Ce que le transcripteur reçoit : la référence de l'audio chez le canal, rien d'autre [R15]. */
export interface VoiceAudio {
  channel: VoiceChannel;
  /** Identifiant du média WhatsApp, ou adresse du fichier chez Meta. */
  mediaRef: string;
  mime: string | null;
}

/** Ce que rend un transcripteur. Tout autre retour est traité comme un échec. */
export interface Transcript {
  text: string;
  /** Langue reconnue (code court : `fr`, `en`, `ar`…), ou null. */
  language: string | null;
  /** Confiance de 0 à 1. */
  confidence: number;
}

/** Le service de transcription. Absent : chaque note passe à l'agent [R241]. */
export interface Transcriber {
  transcribe(audio: VoiceAudio): Promise<unknown>;
}

export type ImpossibleReason = 'indisponible' | 'echec' | 'vide' | 'incertaine';

export interface VoiceNoteRow {
  id: string;
  network_id: string;
  channel: VoiceChannel;
  external_id: string;
  status: 'en_cours' | 'transcrite' | 'impossible';
  failure: ImpossibleReason | null;
  media_ref: string | null;
  mime: string | null;
  transcript: string | null;
  language: string | null;
  confidence: number | null;
  created_at: string;
}

/** Ce que la fiche montre d'un message reçu qui était une note vocale [R240]. */
export interface VoiceNoteView {
  transcription: true;
  channel: VoiceChannel;
  mediaRef: string;
  mime: string | null;
  language: string | null;
  confidence: number;
}

export interface NotesVocalesOptions {
  now?: () => Date;
  newId?: () => string;
  /** Au-delà, la transcription est dite indisponible : la réponse ne doit pas attendre. 20 secondes par défaut. */
  timeoutMs?: number;
  /** Sous ce seuil, la transcription est dite incertaine et passe à l'agent [R241]. 0,6 par défaut. */
  minConfidence?: number;
}

/** Un texte transcrit plus long n'est pas rangé ; masquer un IBAN ne l'allonge jamais. */
export const MAX_TEXT = 4000;
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** Une note que le transcripteur n'a pas pu lire, de quoi ouvrir sa reprise [R696]. */
export interface FailedNote {
  noteId: string;
  channel: VoiceChannel;
  failure: ImpossibleReason;
  mediaRef: string;
  mime: string | null;
}

/** Une note vocale trouvée dans une notification brute, avec de quoi la réécrire. */
interface FoundNote {
  channel: VoiceChannel;
  externalId: string;
  audio: VoiceAudio;
  /** Remplace la note par un texte écrit, à sa place dans la notification. */
  asText(text: string): void;
  /** Retire la note de la notification et rend son contenu brut, pour la ranger illisible. */
  remove(): unknown;
}

/** Les notes vocales d'une notification WhatsApp ou Meta. Une notification d'une autre source n'en a pas. */
function findNotes(source: string, raw: unknown, ownIds: readonly string[]): FoundNote[] {
  if (source === 'whatsapp') return findWhatsApp(raw);
  if (source === 'instagram' || source === 'facebook') return findMeta(source, raw, new Set(ownIds));
  return [];
}

function findWhatsApp(raw: unknown): FoundNote[] {
  const found: FoundNote[] = [];
  if (!isObj(raw) || !Array.isArray(raw.entry)) return found;
  for (const entry of raw.entry) {
    if (!isObj(entry) || !Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      if (!isObj(change) || change.field !== 'messages' || !isObj(change.value)) continue;
      const messages = change.value.messages;
      if (!Array.isArray(messages)) continue;
      for (const item of [...messages]) {
        if (!isObj(item) || item.type !== 'audio' || !isObj(item.audio)) continue;
        const externalId = str(item.id);
        const mediaRef = str(item.audio.id);
        // Une note sans identifiant ni média reste à l'adaptateur, qui la range illisible ou en pièce jointe.
        if (externalId === null || mediaRef === null) continue;
        const mime = str(item.audio.mime_type);
        found.push({
          channel: 'whatsapp',
          externalId,
          audio: { channel: 'whatsapp', mediaRef, mime },
          asText(text) {
            delete item.audio;
            item.type = 'text';
            item.text = { body: text };
          },
          remove() {
            const at = messages.indexOf(item);
            if (at >= 0) messages.splice(at, 1);
            return structuredClone(item);
          },
        });
      }
    }
  }
  return found;
}

function findMeta(channel: 'instagram' | 'facebook', raw: unknown, own: ReadonlySet<string>): FoundNote[] {
  const found: FoundNote[] = [];
  if (!isObj(raw) || !Array.isArray(raw.entry)) return found;
  for (const entry of raw.entry) {
    if (!isObj(entry)) continue;
    // Comme l'adaptateur : `standby` porte les messages reçus pendant qu'une autre application a la main.
    for (const key of ['messaging', 'standby']) {
      const messaging = entry[key];
      if (!Array.isArray(messaging)) continue;
      for (const item of [...messaging]) {
      if (!isObj(item) || !isObj(item.message) || item.message.is_echo === true) continue;
      // Nos propres messages ne sont pas des messages reçus.
      const senderId = isObj(item.sender) ? str(item.sender.id) : null;
      if (senderId !== null && own.has(senderId)) continue;
      const message = item.message;
      const attachments = Array.isArray(message.attachments) ? message.attachments : [];
      const audio = attachments.find((a) => isObj(a) && a.type === 'audio' && isObj(a.payload) && str(a.payload.url) !== null);
      const externalId = str(message.mid);
      // Une note accompagnée d'un texte écrit garde ce texte : la note n'est transcrite que seule.
      if (!isObj(audio) || !isObj(audio.payload) || externalId === null || str(message.text) !== null) continue;
      const mediaRef = str(audio.payload.url)!;
      found.push({
        channel,
        externalId,
        audio: { channel, mediaRef, mime: null },
        asText(text) {
          message.text = text;
          const rest = attachments.filter((a) => a !== audio);
          if (rest.length > 0) message.attachments = rest;
          else delete message.attachments;
        },
        remove() {
          const at = messaging.indexOf(item);
          if (at >= 0) messaging.splice(at, 1);
          return structuredClone(item);
        },
      });
      }
    }
  }
  return found;
}

/** Vérifie un retour du transcripteur : un texte non vide, une confiance lisible. */
function readTranscript(value: unknown, minConfidence: number): Transcript | ImpossibleReason {
  if (!isObj(value) || typeof value.text !== 'string' || typeof value.confidence !== 'number') return 'echec';
  if (!Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) return 'echec';
  const text = value.text.replace(/\s+/g, ' ').trim();
  if (text === '') return 'vide';
  if (text.length > MAX_TEXT) return 'echec';
  if (value.confidence < minConfidence) return 'incertaine';
  const language = typeof value.language === 'string' && LANGUAGE.test(value.language) ? value.language : null;
  return { text, language, confidence: value.confidence };
}

const REASON_TEXT: Readonly<Record<ImpossibleReason, string>> = {
  indisponible: 'transcription indisponible',
  echec: 'transcription en échec',
  vide: 'transcription vide',
  incertaine: 'transcription incertaine',
};

export class NotesVocales {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly timeoutMs: number;
  private readonly minConfidence: number;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly transcriber: Transcriber | null,
    options: NotesVocalesOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.minConfidence = options.minConfidence ?? 0.6;
  }

  /**
   * Prépare une notification brute pour la chaîne : chaque note vocale devient le texte transcrit, ou sort de la
   * notification pour être rangée illisible. La notification d'origine n'est pas modifiée.
   */
  async prepare(
    networkId: string,
    source: string,
    raw: unknown,
    ownIds: readonly string[] = [],
  ): Promise<{ raw: unknown; unreadable: UnreadableInbound[]; failed: FailedNote[]; inProgress: number }> {
    if (findNotes(source, raw, ownIds).length === 0) return { raw, unreadable: [], failed: [], inProgress: 0 };
    const copy = structuredClone(raw);
    const unreadable: UnreadableInbound[] = [];
    const failed: FailedNote[] = [];
    let inProgress = 0;
    for (const note of findNotes(source, copy, ownIds)) {
      const row = await this.transcribeOnce(networkId, note);
      if (row === 'en_cours') {
        // Une autre livraison de la même note la transcrit en ce moment : elle seule la fera entrer dans la chaîne [R18].
        note.remove();
        inProgress += 1;
      } else if (row.status === 'transcrite') note.asText(row.transcript!);
      else {
        unreadable.push({ channel: note.channel, reason: `note vocale : ${REASON_TEXT[row.failure!]}`, raw: JSON.stringify(note.remove()) });
        failed.push({ noteId: row.id, channel: note.channel, failure: row.failure!, mediaRef: note.audio.mediaRef, mime: note.audio.mime });
      }
    }
    return { raw: copy, unreadable, failed, inProgress };
  }

  /**
   * AU044 · La tâche de reprise d'une note impossible, liée au message illisible rangé [R696] : une seule par note, même
   * livrée deux fois. Au journal, ni la référence de l'audio, ni le texte [R13].
   */
  async openRecovery(networkId: string, note: FailedNote, inboundId: string): Promise<void> {
    const id = this.newId();
    const { changes } = await this.db.run(
      `INSERT INTO voice_note_recoveries (id, network_id, voice_note_id, inbound_id, channel, failure, media_ref, mime, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (voice_note_id) DO NOTHING`,
      [id, networkId, note.noteId, inboundId, note.channel, note.failure, note.mediaRef.slice(0, 2048), note.mime, this.now().toISOString()],
    );
    if (changes === 0) return;
    await appendEvent(
      this.journal,
      { type: 'voix.reprise_ouverte', actor: 'system', subject: `voice_recovery:${id}`, data: { rule: 'R696', channel: note.channel, failure: note.failure } },
      this.now,
    );
  }

  /** La note d'un message reçu, telle que la fiche la montre, ou null si ce message n'était pas une note transcrite. */
  async forInbound(networkId: string, inboundId: string): Promise<VoiceNoteView | null> {
    const [row] = await this.db.all<VoiceNoteRow>(
      `SELECT v.* FROM voice_notes v JOIN inbound_messages i
         ON i.network_id = v.network_id AND i.channel = v.channel AND i.external_id = v.external_id
       WHERE i.network_id = ? AND i.id = ? AND v.status = 'transcrite'`,
      [networkId, inboundId],
    );
    if (!row) return null;
    return { transcription: true, channel: row.channel, mediaRef: row.media_ref!, mime: row.mime, language: row.language, confidence: row.confidence! };
  }

  /**
   * Une note n'est transcrite qu'une fois [R18, R240] : elle est d'abord réservée, et une seule livraison gagne la
   * réservation ; une livraison suivante relit la transcription, ou dit « en cours » tant qu'elle n'est pas finie. Une
   * réservation restée en cours au-delà de trois délais (Worker coupé) est reprise.
   */
  private async transcribeOnce(networkId: string, note: FoundNote): Promise<VoiceNoteRow | 'en_cours'> {
    const id = this.newId();
    const at = this.now();
    const stale = new Date(at.getTime() - 3 * this.timeoutMs).toISOString();
    const { changes: claimed } = await this.db.run(
      `INSERT INTO voice_notes (id, network_id, channel, external_id, status, created_at) VALUES (?, ?, ?, ?, 'en_cours', ?)
       ON CONFLICT (network_id, channel, external_id) DO UPDATE SET created_at = excluded.created_at
       WHERE voice_notes.status = 'en_cours' AND voice_notes.created_at < ?`,
      [id, networkId, note.channel, note.externalId, at.toISOString(), stale],
    );
    const held = await this.find(networkId, note);
    if (!held) throw new Error('Note vocale non rangée.');
    if (claimed === 0) return held.status === 'en_cours' ? 'en_cours' : held;
    const outcome = await this.transcribe(note.audio);
    const ok = typeof outcome !== 'string';
    // Un IBAN dicté ne se range jamais en clair, comme dans un message écrit [R15].
    const { changes } = await this.db.run(
      `UPDATE voice_notes SET status = ?, failure = ?, media_ref = ?, mime = ?, transcript = ?, language = ?, confidence = ?
       WHERE id = ? AND status = 'en_cours' AND created_at = ?`,
      [
        ok ? 'transcrite' : 'impossible',
        ok ? null : outcome,
        ok ? note.audio.mediaRef : null,
        ok ? note.audio.mime : null,
        ok ? maskIban(outcome.text) : null,
        ok ? outcome.language : null,
        ok ? outcome.confidence : null,
        held.id,
        at.toISOString(),
      ],
    );
    const row = await this.find(networkId, note);
    if (!row) throw new Error('Note vocale non rangée.');
    // Reprise entre-temps par une autre livraison : c'est elle qui finit.
    if (changes === 0) return row.status === 'en_cours' ? 'en_cours' : row;
    // Ni texte, ni audio, ni identifiant du canal au journal [R13].
    await appendEvent(
      this.journal,
      { type: 'voix.note_recue', actor: 'system', subject: `voice_note:${row.id}`, data: { rule: ok ? 'R240' : 'R241', channel: note.channel, status: row.status, failure: row.failure } },
      this.now,
    );
    return row;
  }

  private find(networkId: string, note: FoundNote): Promise<VoiceNoteRow | null> {
    return this.db
      .all<VoiceNoteRow>('SELECT * FROM voice_notes WHERE network_id = ? AND channel = ? AND external_id = ?', [networkId, note.channel, note.externalId])
      .then((rows) => rows[0] ?? null);
  }

  private async transcribe(audio: VoiceAudio): Promise<Transcript | ImpossibleReason> {
    if (!this.transcriber) return 'indisponible';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), this.timeoutMs);
    });
    try {
      const value = await Promise.race([this.transcriber.transcribe(structuredClone(audio)), late]);
      if (value === 'late') return 'indisponible';
      return readTranscript(value, this.minConfidence);
    } catch {
      return 'echec';
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * La langue parlée d'un message reçu qui était une note transcrite, réduite à son code court (`en-GB` → `en`), ou null
 * si ce message n'était pas une note transcrite, si la langue n'a pas été reconnue, ou s'il vient d'un autre réseau.
 * Une note rangée « transcrite » a passé le seuil de confiance [R241] : sa langue est celle que la personne a parlée.
 */
export async function voiceNoteLanguage(db: SqlDatabase, networkId: string, inboundId: string): Promise<string | null> {
  const [row] = await db.all<{ language: string | null }>(
    `SELECT v.language FROM voice_notes v JOIN inbound_messages i
       ON i.network_id = v.network_id AND i.channel = v.channel AND i.external_id = v.external_id
     WHERE i.network_id = ? AND i.id = ? AND v.status = 'transcrite'`,
    [networkId, inboundId],
  );
  const language = row?.language;
  return typeof language === 'string' && LANGUAGE.test(language) ? language.split('-')[0]!.toLowerCase() : null;
}

/** Ce que la fiche relit d'une note vocale transcrite (BR62) : jamais la référence de l'audio chez le canal [R15]. */
export interface VoiceNoteOfFiche {
  id: string;
  receivedAt: string;
  channel: VoiceChannel;
  /** Le texte transcrit, un IBAN dicté masqué [R15]. */
  transcript: string;
  /** Code court de la langue parlée (`en-GB` → `en`), ou null. */
  language: string | null;
  confidence: number;
  /** L'audio d'origine reste chez le canal : la fiche dit seulement qu'il est gardé. */
  hasAudio: boolean;
}

/**
 * BR62 · Les notes vocales transcrites d'une fiche, sous les droits de la fiche : l'agent qui la suit ou la direction,
 * refus au journal par `Acces.readFiche` [R16]. Les notes des fiches réunies se relisent sur la fiche gardée ; une note en
 * cours ou impossible n'est pas montrée (une note impossible n'a pas de fiche). Rien de plus au journal que la lecture de
 * la fiche : ni texte, ni identifiant du canal [R13].
 */
export async function voiceNotesOfFiche(db: SqlDatabase, acces: Acces, viewer: Viewer, personId: string): Promise<AccessResult<VoiceNoteOfFiche[]>> {
  const read = await acces.readFiche(viewer, personId);
  if (!read.ok) return read;
  const members = read.value.members.map((m) => m.id);
  if (members.length === 0) return { ok: true, view: read.view, value: [] };
  const rows = await db.all<VoiceNoteRow & { received_at: string }>(
    `SELECT v.*, i.received_at FROM voice_notes v JOIN inbound_messages i
       ON i.network_id = v.network_id AND i.channel = v.channel AND i.external_id = v.external_id
     WHERE v.network_id = ? AND v.status = 'transcrite' AND i.person_id IN (${members.map(() => '?').join(', ')})
     ORDER BY i.received_at DESC, v.id`,
    [read.value.person.network_id, ...members],
  );
  return {
    ok: true,
    view: read.view,
    value: rows.map((r) => ({
      id: r.id,
      receivedAt: r.received_at,
      channel: r.channel,
      transcript: r.transcript!,
      language: typeof r.language === 'string' && LANGUAGE.test(r.language) ? r.language.split('-')[0]!.toLowerCase() : null,
      confidence: r.confidence!,
      hasAudio: r.media_ref !== null,
    })),
  };
}

/**
 * La chaîne de captation qui comprend les notes vocales : la notification passe par `NotesVocales.prepare`, puis par la
 * chaîne telle quelle ; les notes non transcrites sont rangées illisibles et signalées à l'agent, sans réponse [R241].
 */
export class ChaineVocale {
  constructor(
    private readonly notes: NotesVocales,
    private readonly chaine: ChaineCaptation,
    private readonly reception: Reception,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async receive(networkId: string, source: Parameters<ChaineCaptation['receive']>[1], raw: unknown, ctx: Partial<AdaptContext> = {}, hooks: ChainHooks = {}): Promise<ChainResult[]> {
    const started = this.now().getTime();
    const prepared = await this.notes.prepare(networkId, source, raw, ctx.ownIds ?? []);
    const results = await this.chaine.receive(networkId, source, prepared.raw, ctx, hooks);
    if (prepared.unreadable.length > 0) {
      const stored = await this.reception.store(networkId, { messages: [], unreadable: prepared.unreadable, ignored: 0 });
      // Chaque note impossible ouvre sa reprise, liée à son message illisible : l'audio reste à écouter [R696].
      for (const [i, item] of stored.received.entries()) {
        const failed = prepared.failed[i];
        if (failed) await this.notes.openRecovery(networkId, failed, item.inboundId);
      }
      for (const item of stored.received) {
        results.push({ inboundId: item.inboundId, status: item.outcome === 'duplicate' ? 'duplicate' : 'unreadable', messageId: null, elapsedMs: this.now().getTime() - started });
      }
    }
    return results;
  }
}
