/**
 * Les appels entrants (HX21) : chaque appel reçu est rangé une seule fois [R18, R244], rattaché à la fiche de l'appelant
 * par son numéro, résumé et qualifié comme un message écrit (Q01).
 *
 * Rien n'est enregistré ni transcrit sans l'annonce de l'enregistrement et l'accord de l'appelant, rangés avec leur heure
 * pendant l'appel [R242] : sans eux, la référence de l'enregistrement n'est pas gardée et le transcripteur n'est jamais
 * appelé. Chaque champ tiré de l'appel renvoie à un passage dit par l'appelant ; un champ qu'aucun passage ne porte à lui
 * seul n'est pas rangé [R243]. La provenance ne vient que d'un code de contenu de AT05 porté par l'appel (bouton d'appel
 * marqué du site), jamais d'un second numéro ni d'un rapprochement par l'heure : sinon elle est « inconnue » [R245, R156].
 *
 * Une demande d'arrêt dite par l'appelant dans un appel transcrit (« ne m'appelez plus ») vaut un « STOP » écrit : elle
 * est lue par la même lecture que les messages reçus et range l'exclusion « stop » sur tous les canaux [R04] (RC20).
 *
 * Un numéro masqué ne crée aucune fiche : rien n'est gardé de l'appel que son heure, et l'agent est prévenu [R244].
 * Ni texte, ni numéro, ni référence d'enregistrement au journal [R13]. Le transcripteur ne reçoit que la référence de
 * l'enregistrement ; l'IA de qualification, que les paroles de l'appelant sans coordonnées [R15].
 */
import { keyLookupForms } from '../fiche/empreinte.ts';
import type { Acces, AccessResult } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { Person } from '../db/types.ts';
import { DecisionEnvoi, isStopRequest } from '../envoi/service.ts';
import { maskIban } from '../envoi/texte.ts';
import type { FicheUnique } from '../fiche/fusion.ts';
import { matchKey, normalizePhone } from '../fiche/normalize.ts';
import { withoutContactDetails } from '../captation/premiere-reponse.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { Qualifier } from '../qualification/qualification.ts';
import {
  DEFAULT_COMMUNES,
  amountsIn,
  checkAiQualification,
  declaredFinancing,
  findCommune,
  qualifyByRules,
  withoutNames,
  type Category,
  type Qualified,
  type Route,
} from '../qualification/regles.ts';

/** Un appel tel que le service téléphonique le décrit, une fois l'appel fini. */
export interface IncomingCall {
  /** Le service qui a pris l'appel : `essai`, puis le fournisseur retenu. */
  provider: string;
  /** Identifiant de l'appel chez ce service : la clé de l'appel unique [R18]. */
  callId: string;
  /** Numéro de l'appelant tel que le service le donne ; null pour un numéro masqué. */
  from: string | null;
  startedAt: Date;
  endedAt: Date;
  /** Heure à laquelle l'annonce de l'enregistrement a été dite. */
  announcedAt: Date | null;
  /** Heure à laquelle l'appelant a accepté l'enregistrement. */
  consentAt: Date | null;
  /** Référence de l'enregistrement chez le service. Ignorée sans accord [R242]. */
  recordingRef: string | null;
  /** Code de contenu de AT05 porté par le bouton d'appel marqué, s'il y en a un. */
  originCode: string | null;
}

export type Speaker = 'appelant' | 'agent';

/** Un passage de la transcription : qui parle, quand, et ce qui est dit. */
export interface CallSegment {
  speaker: Speaker;
  startS: number;
  endS: number;
  text: string;
}

/** Ce que le transcripteur reçoit : la référence de l'enregistrement, rien d'autre [R15]. */
export interface CallRecording {
  provider: string;
  recordingRef: string;
}

/** Le service de transcription des appels. Absent : chaque appel enregistré passe à l'agent. */
export interface CallTranscriber {
  transcribe(recording: CallRecording): Promise<unknown>;
}

export type CallStatus = 'en_cours' | 'traite' | 'sans_enregistrement' | 'impossible' | 'masque';
export type CallFailure = 'indisponible' | 'echec' | 'vide' | 'incertaine';
export type CallAttach = 'created' | 'matched' | 'ambiguous';

/** Un champ tiré de l'appel, avec le passage qui le porte [R243]. */
export interface CitedField {
  key: 'city' | 'budgetMinEur' | 'budgetMaxEur' | 'priceEur' | 'deadline' | 'financing' | 'criterion';
  value: string | number;
  /** Rang du passage dans la transcription. */
  segment: number;
}

export interface CallRow {
  id: string;
  network_id: string;
  provider: string;
  call_id: string;
  status: CallStatus;
  failure: CallFailure | null;
  person_id: string | null;
  attach: CallAttach | null;
  started_at: string | null;
  ended_at: string | null;
  consent_announced_at: string | null;
  consent_given_at: string | null;
  recording_ref: string | null;
  transcript: string | null;
  language: string | null;
  confidence: number | null;
  category: Category | null;
  route: Route | null;
  fields: string | null;
  qualification_source: 'ai' | 'rules' | null;
  origin_content_id: string | null;
  origin_kind: string | null;
  created_at: string;
}

/** Une ligne du résumé : le champ, sa valeur, et la phrase dite qui la porte. */
export interface SummaryLine {
  key: CitedField['key'];
  value: string | number;
  quote: string;
  atS: number;
}

/** Ce que la fiche montre d'un appel. */
export interface CallView {
  id: string;
  startedAt: string | null;
  durationS: number | null;
  status: Exclude<CallStatus, 'en_cours'>;
  failure: CallFailure | null;
  /** L'agent doit écouter ou rappeler : rien n'a été résumé. */
  needsAgent: boolean;
  /** Plusieurs fiches portent ce numéro : rattaché à la plus ancienne, à vérifier. */
  ambiguous: boolean;
  recordingRef: string | null;
  category: Category | null;
  route: Route | null;
  summary: SummaryLine[];
  transcript: CallSegment[];
  /** Le passage où l'appelant a demandé l'arrêt [R04], s'il y en a un. */
  stop: { quote: string; atS: number } | null;
  origin: { contentId: string | null; kind: string };
}

export type ReceiveResult =
  | { ok: true; callId: string; status: Exclude<CallStatus, 'en_cours'>; personId: string | null; already: boolean }
  | { ok: true; callId: string; status: 'en_cours'; personId: null; already: true }
  | { ok: false; code: 'bad_call' };

export interface AppelsOptions {
  now?: () => Date;
  newId?: () => string;
  qualifier?: Qualifier;
  communes?: readonly string[];
  /** Au-delà, le service est dit indisponible. 60 secondes par défaut : un appel est plus long qu'une note. */
  timeoutMs?: number;
  /** Sous ce seuil, la transcription est incertaine et passe à l'agent. 0,6 par défaut. */
  minConfidence?: number;
  /** Au-delà, l'IA de qualification est réputée ne pas répondre : les règles fixes. */
  aiTimeoutMs?: number;
}

const PROVIDER = /^[a-z0-9-]{1,32}$/;
const CALL_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const CODE = /^[a-z2-7]{12}$/;
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;
const MAX_SEGMENTS = 400;
export const MAX_SEGMENT_TEXT = 2000;
/** Un appel de plus de 4 heures n'est pas un appel lisible. */
const MAX_CALL_MS = 4 * 3600_000;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const validDate = (d: unknown): d is Date => d instanceof Date && Number.isFinite(d.getTime());

/** L'annonce puis l'accord, tous deux pendant l'appel, avec une référence d'enregistrement [R242]. */
export function recordingAllowed(call: IncomingCall): boolean {
  const { announcedAt, consentAt, startedAt, endedAt, recordingRef } = call;
  if (!validDate(announcedAt) || !validDate(consentAt) || typeof recordingRef !== 'string' || recordingRef.trim() === '') return false;
  const s = startedAt.getTime();
  const e = endedAt.getTime();
  return s <= announcedAt.getTime() && announcedAt.getTime() <= consentAt.getTime() && consentAt.getTime() <= e;
}

function wellFormed(call: unknown): call is IncomingCall {
  if (!isObj(call)) return false;
  if (typeof call.provider !== 'string' || !PROVIDER.test(call.provider)) return false;
  if (typeof call.callId !== 'string' || !CALL_ID.test(call.callId)) return false;
  if (!validDate(call.startedAt) || !validDate(call.endedAt)) return false;
  const length = call.endedAt.getTime() - call.startedAt.getTime();
  if (length < 0 || length > MAX_CALL_MS) return false;
  if (call.from !== null && typeof call.from !== 'string') return false;
  return true;
}

/** Vérifie un retour du transcripteur : des passages lisibles, dans l'appel, et une confiance. */
export function readCallTranscript(
  value: unknown,
  durationS: number,
  minConfidence: number,
): { segments: CallSegment[]; language: string | null; confidence: number } | CallFailure {
  if (!isObj(value) || !Array.isArray(value.segments) || typeof value.confidence !== 'number') return 'echec';
  if (!Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) return 'echec';
  if (value.segments.length > MAX_SEGMENTS) return 'echec';
  const segments: CallSegment[] = [];
  for (const raw of value.segments) {
    if (!isObj(raw) || (raw.speaker !== 'appelant' && raw.speaker !== 'agent')) return 'echec';
    if (typeof raw.text !== 'string' || typeof raw.startS !== 'number' || typeof raw.endS !== 'number') return 'echec';
    if (!Number.isFinite(raw.startS) || !Number.isFinite(raw.endS) || raw.startS < 0 || raw.endS < raw.startS || raw.endS > durationS + 1) return 'echec';
    const text = raw.text.replace(/\s+/g, ' ').trim();
    if (text.length > MAX_SEGMENT_TEXT) return 'echec';
    // Un IBAN dicté ne se range jamais en clair [R15].
    if (text !== '') segments.push({ speaker: raw.speaker, startS: raw.startS, endS: raw.endS, text: maskIban(text) });
  }
  if (!segments.some((s) => s.speaker === 'appelant')) return 'vide';
  if (value.confidence < minConfidence) return 'incertaine';
  const language = typeof value.language === 'string' && LANGUAGE.test(value.language) ? value.language : null;
  return { segments, language, confidence: value.confidence };
}

/**
 * Ne garde d'une qualification que les champs qu'un passage de l'appelant porte à lui seul [R243] : la commune citée
 * dans le passage, le montant que Q01 lit dans ce seul passage comme ce même champ, le délai, le financement déclaré ou le critère que les règles fixes
 * lisent dans ce seul passage. Le premier passage qui porte le champ est sa source.
 */
export function citeFields(q: Qualified, segments: readonly CallSegment[], communes: readonly string[]): CitedField[] {
  const caller = segments.map((s, i) => ({ i, s })).filter(({ s }) => s.speaker === 'appelant');
  const read = caller.map(({ i, s }) => ({ i, text: s.text, rules: qualifyByRules(s.text, { communes }), amounts: amountsIn(s.text) }));
  const first = (ok: (r: (typeof read)[number]) => boolean): number | null => read.find(ok)?.i ?? null;
  const out: CitedField[] = [];
  const push = (key: CitedField['key'], value: string | number, segment: number | null): void => {
    if (segment !== null) out.push({ key, value, segment });
  };
  if (q.city !== null) push('city', q.city, first((r) => findCommune(r.text, communes) === q.city));
  for (const key of ['budgetMinEur', 'budgetMaxEur', 'priceEur'] as const) {
    const v = q[key];
    // Le passage doit porter ce montant comme ce champ, selon Q01 : un apport, des frais ou un revenu du même montant ne
    // sont jamais la source d'un budget ou d'un prix.
    if (v !== null) push(key, v, first((r) => r.amounts.includes(v) && r.rules[key] === v));
  }
  if (q.deadline !== null) push('deadline', q.deadline, first((r) => r.rules.deadline === q.deadline));
  if (q.financing !== null) push('financing', q.financing, first((r) => declaredFinancing(r.text) === q.financing));
  for (const c of q.criteria) push('criterion', c, first((r) => r.rules.criteria.includes(c)));
  return out;
}

/** Un arrêt se lit sur quatre passages de l'appelant à la suite au plus. */
export const STOP_SPAN = 4;

/**
 * Le premier arrêt demandé par l'appelant, lu comme un message reçu [R04] : dans le doute, c'est un arrêt. Le
 * transcripteur peut couper une phrase en plusieurs passages (« Ne m'appelez » puis « plus. ») : les passages de
 * l'appelant qui se suivent sans parole de l'agent entre eux sont lus ensemble, jusqu'à quatre. Le texte rendu est le
 * plus court qui demande l'arrêt, avec l'heure de son premier passage. Les paroles de l'agent ne comptent jamais, ni
 * seules ni collées à celles de l'appelant.
 */
export function stopSegment(segments: readonly CallSegment[]): { text: string; startS: number } | null {
  let run: CallSegment[] = [];
  for (const segment of segments) {
    if (segment.speaker !== 'appelant') {
      run = [];
      continue;
    }
    run.push(segment);
    // Le passage qui vient d'arriver termine la phrase : du plus court au plus long en remontant.
    for (let start = run.length - 1; start >= Math.max(0, run.length - STOP_SPAN); start -= 1) {
      const text = run.slice(start).map((s) => s.text).join(' ');
      if (isStopRequest(text)) return { text, startS: run[start]!.startS };
    }
  }
  return null;
}

const SUMMARY_ORDER: readonly CitedField['key'][] = ['city', 'priceEur', 'budgetMinEur', 'budgetMaxEur', 'deadline', 'financing', 'criterion'];

export class Appels {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly communes: readonly string[];
  private readonly timeoutMs: number;
  private readonly minConfidence: number;
  private readonly aiTimeoutMs: number;
  private readonly qualifier: Qualifier | null;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly store: FicheClient,
    private readonly fiche: FicheUnique,
    private readonly transcriber: CallTranscriber | null,
    options: AppelsOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.communes = options.communes ?? DEFAULT_COMMUNES;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.minConfidence = options.minConfidence ?? 0.6;
    this.aiTimeoutMs = options.aiTimeoutMs ?? 10_000;
    this.qualifier = options.qualifier ?? null;
  }

  /** Range un appel fini, une seule fois [R18, R244]. Une nouvelle livraison du même appel relit ce qui est rangé. */
  async receive(networkId: string, call: unknown): Promise<ReceiveResult> {
    if (!wellFormed(call)) return { ok: false, code: 'bad_call' };
    const at = this.now();
    const stale = new Date(at.getTime() - 3 * (this.timeoutMs + this.aiTimeoutMs)).toISOString();
    const { changes: claimed } = await this.db.run(
      `INSERT INTO calls (id, network_id, provider, call_id, status, created_at) VALUES (?, ?, ?, ?, 'en_cours', ?)
       ON CONFLICT (network_id, provider, call_id) DO UPDATE SET created_at = excluded.created_at
       WHERE calls.status = 'en_cours' AND calls.created_at < ?`,
      [this.newId(), networkId, call.provider, call.callId, at.toISOString(), stale],
    );
    const held = await this.find(networkId, call);
    if (!held) throw new Error('Appel non rangé.');
    if (claimed === 0) {
      if (held.status === 'en_cours') return { ok: true, callId: held.id, status: 'en_cours', personId: null, already: true };
      await this.journalOnce(held);
      return { ok: true, callId: held.id, status: held.status, personId: held.person_id, already: true };
    }

    const durationS = (call.endedAt.getTime() - call.startedAt.getTime()) / 1000;
    const phone = typeof call.from === 'string' ? normalizePhone(call.from) : null;
    const allowed = recordingAllowed(call);
    const base = {
      started_at: call.startedAt.toISOString(),
      ended_at: call.endedAt.toISOString(),
      consent_announced_at: allowed ? call.announcedAt!.toISOString() : null,
      consent_given_at: allowed ? call.consentAt!.toISOString() : null,
      ...(await this.origin(networkId, call.originCode)),
    };

    let update: Partial<CallRow> & { status: Exclude<CallStatus, 'en_cours'> };
    if (phone === null) {
      // Numéro masqué ou illisible : aucune fiche, donc rien de ce qui a été dit n'est gardé [R244].
      update = { ...base, status: 'masque', consent_announced_at: null, consent_given_at: null };
    } else {
      const { person, attach } = await this.attachTo(networkId, phone, at);
      if (!allowed) update = { ...base, status: 'sans_enregistrement', person_id: person.id, attach };
      else {
        const recordingRef = call.recordingRef!.trim();
        const outcome = await this.transcribe({ provider: call.provider, recordingRef }, durationS);
        if (typeof outcome === 'string') {
          update = { ...base, status: 'impossible', failure: outcome, person_id: person.id, attach, recording_ref: recordingRef };
        } else {
          // L'arrêt est rangé avant l'appel fini : une coupure entre les deux, la livraison suivante reprend l'appel et
          // l'exclusion déjà en cours n'est pas doublée [R04, R18].
          const stop = stopSegment(outcome.segments);
          if (stop) {
            const said = Math.min(call.startedAt.getTime() + stop.startS * 1000, call.endedAt.getTime());
            await new DecisionEnvoi(this.db, this.store, this.fiche, { now: this.now, newId: this.newId }).recordStopRequest({
              networkId,
              agentId: null,
              personId: person.id,
              at: new Date(said),
            });
          }
          const { qualified, source } = await this.qualify(outcome.segments, person);
          const fields = citeFields(qualified, outcome.segments, this.communes);
          update = {
            ...base,
            status: 'traite',
            person_id: person.id,
            attach,
            recording_ref: recordingRef,
            transcript: JSON.stringify(outcome.segments),
            language: outcome.language,
            confidence: outcome.confidence,
            category: qualified.category,
            route: qualified.route,
            fields: JSON.stringify(fields),
            qualification_source: source,
          };
        }
      }
    }

    const columns = Object.keys(update) as (keyof CallRow)[];
    const { changes } = await this.db.run(
      `UPDATE calls SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND status = 'en_cours' AND created_at = ?`,
      [...columns.map((c) => update[c] ?? null), held.id, at.toISOString()],
    );
    const row = await this.find(networkId, call);
    if (!row) throw new Error('Appel non rangé.');
    // Repris entre-temps par une autre livraison : c'est elle qui finit.
    if (changes === 0) {
      if (row.status === 'en_cours') return { ok: true, callId: row.id, status: 'en_cours', personId: null, already: true };
      await this.journalOnce(row);
      return { ok: true, callId: row.id, status: row.status, personId: row.person_id, already: true };
    }
    await this.journalOnce(row);
    return { ok: true, callId: row.id, status: row.status as Exclude<CallStatus, 'en_cours'>, personId: row.person_id, already: false };
  }

  /**
   * L'appel va au journal une seule fois [R244] : une livraison suivante d'un appel rangé dont l'événement manque (journal
   * en panne après le rangement) l'ajoute, sans rien retranscrire. Ni texte, ni numéro, ni enregistrement [R13].
   */
  private async journalOnce(row: CallRow): Promise<void> {
    const subject = `call:${row.id}`;
    const claim = this.now().toISOString();
    const stale = new Date(this.now().getTime() - 60_000).toISOString();
    // Une seule livraison à la fois tient la réservation : deux relivraisons simultanées n'ajoutent qu'un événement.
    const { changes } = await this.db.run(
      `INSERT INTO call_journal (call_id, claimed_at) VALUES (?, ?)
       ON CONFLICT (call_id) DO UPDATE SET claimed_at = excluded.claimed_at
       WHERE call_journal.done = 0 AND call_journal.claimed_at < ?`,
      [row.id, claim, stale],
    );
    if (changes === 0) return;
    try {
      // Un précédent détenteur a pu écrire l'événement avant d'être coupé : il n'est jamais doublé.
      if (!(await this.journal.bySubject(subject)).some((e) => e.type === 'voix.appel_recu')) await this.appendCallEvent(row, subject);
    } catch (error) {
      // Journal en panne : la réservation est lâchée tout de suite, la livraison suivante réessaiera.
      await this.db.run("UPDATE call_journal SET claimed_at = '' WHERE call_id = ? AND claimed_at = ? AND done = 0", [row.id, claim]);
      throw error;
    }
    await this.db.run('UPDATE call_journal SET done = 1 WHERE call_id = ? AND done = 0', [row.id]);
  }

  private async appendCallEvent(row: CallRow, subject: string): Promise<void> {
    await appendEvent(
      this.journal,
      {
        type: 'voix.appel_recu',
        actor: 'system',
        subject,
        data: {
          rule: row.status === 'traite' ? 'R243' : row.status === 'masque' ? 'R244' : 'R242',
          status: row.status,
          failure: row.failure,
          attach: row.attach,
          origin: row.origin_kind,
          // Seulement « arrêt demandé », jamais la phrase [R13].
          stop: row.transcript ? stopSegment(JSON.parse(row.transcript) as CallSegment[]) !== null : false,
        },
      },
      this.now,
    );
  }

  /** Les appels d'une fiche, du plus récent au plus ancien, fiches réunies comprises. */
  /**
   * Range l'arrêt demandé de vive voix pendant un appel déjà rangé, par l'assistant vocal par exemple (RC21) : exclusion
   * « stop » sur tous les canaux de la fiche de l'appelant, datée de l'instant dit [R04]. Une exclusion déjà en cours
   * n'est pas doublée [R18]. Rend « sans_fiche » pour un numéro masqué (aucune fiche, rien à arrêter [R244]) et
   * « en_cours » tant qu'une autre livraison range encore l'appel : à refaire ensuite.
   */
  async recordSpokenStop(networkId: string, callRowId: string, at: Date): Promise<'rangé' | 'sans_fiche' | 'en_cours'> {
    const row = await this.db.first<{ status: CallStatus; person_id: string | null; ended_at: string | null }>(
      'SELECT status, person_id, ended_at FROM calls WHERE id = ? AND network_id = ?',
      [callRowId, networkId],
    );
    if (!row || row.status === 'en_cours') return 'en_cours';
    if (row.person_id === null) return 'sans_fiche';
    const said = row.ended_at && Date.parse(row.ended_at) < at.getTime() ? new Date(row.ended_at) : at;
    await new DecisionEnvoi(this.db, this.store, this.fiche, { now: this.now, newId: this.newId }).recordStopRequest({ networkId, agentId: null, personId: row.person_id, at: said });
    return 'rangé';
  }

  async forPerson(networkId: string, personId: string): Promise<CallView[]> {
    const root = await this.fiche.rootOf(personId);
    const rows = await this.db.all<CallRow>(
      `SELECT c.* FROM calls c
       WHERE c.network_id = ? AND c.status <> 'en_cours'
         AND (c.person_id = ? OR c.person_id IN (SELECT merged_id FROM person_merges WHERE undone_at IS NULL))
       ORDER BY c.started_at DESC, c.id`,
      [networkId, root],
    );
    const views: CallView[] = [];
    for (const row of rows) {
      if ((await this.fiche.rootOf(row.person_id!)) === root) views.push(this.view(row));
    }
    return views;
  }

  /** Un appel rangé, tel que la fiche le montre. */
  async get(networkId: string, id: string): Promise<CallView | null> {
    const row = await this.db.first<CallRow>("SELECT * FROM calls WHERE network_id = ? AND id = ? AND status <> 'en_cours'", [networkId, id]);
    return row ? this.view(row) : null;
  }

  private view(row: CallRow): CallView {
    return callView(row);
  }

  private find(networkId: string, call: IncomingCall): Promise<CallRow | null> {
    return this.db.first<CallRow>('SELECT * FROM calls WHERE network_id = ? AND provider = ? AND call_id = ?', [networkId, call.provider, call.callId]).then((r) => r ?? null);
  }

  /** L'origine d'un appel : le contenu de AT05 désigné par le code porté par l'appel, sinon inconnue [R245]. */
  private async origin(networkId: string, code: unknown): Promise<{ origin_content_id: string | null; origin_kind: string }> {
    if (typeof code !== 'string' || !CODE.test(code)) return { origin_content_id: null, origin_kind: 'inconnue' };
    const content = await this.db.first<{ id: string; kind: string }>('SELECT id, kind FROM public_contents WHERE id = ? AND network_id = ?', [code, networkId]);
    return content ? { origin_content_id: content.id, origin_kind: content.kind } : { origin_content_id: null, origin_kind: 'inconnue' };
  }

  /**
   * La fiche de l'appelant, retrouvée par son numéro (téléphone ou WhatsApp, fiches réunies ramenées à la gardée), sinon
   * créée. Plusieurs fiches distinctes : la plus ancienne, marquée à vérifier, sans rien réunir ici. La clé de contact
   * du numéro est réservée comme pour un message (C02) : un message simultané du même numéro rejoint la même fiche.
   */
  private async attachTo(networkId: string, phone: string, at: Date): Promise<{ person: Person; attach: CallAttach }> {
    const key = matchKey('phone', phone);
    const found = await this.roots(networkId, phone, key);
    if (found.length > 0) return { person: found[0]!, attach: found.length > 1 ? 'ambiguous' : 'matched' };
    const created = await this.store.createPerson({ networkId });
    await this.db.run('INSERT INTO contact_keys (network_id, key, person_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (network_id, key) DO NOTHING', [
      networkId,
      key,
      created.id,
      at.toISOString(),
    ]);
    const owner = await this.db.first<{ person_id: string }>('SELECT person_id FROM contact_keys WHERE network_id = ? AND key = ?', [networkId, key]);
    const ownerRoot = owner ? await this.fiche.rootOf(owner.person_id) : created.id;
    if (ownerRoot !== created.id) {
      // Le même numéro est arrivé au même moment par un autre chemin : sa fiche gagne, la nôtre, vide, la rejoint (S04).
      const person = await this.store.getPerson(ownerRoot);
      if (person) {
        await this.fiche.merge({ survivorId: person.id, mergedId: created.id, reason: 'même numéro, appel simultané' });
        return { person, attach: 'matched' };
      }
    }
    await this.fiche.addIdentifier({ networkId, personId: created.id, kind: 'phone', value: phone });
    return { person: created, attach: 'created' };
  }

  private async roots(networkId: string, phone: string, key: string): Promise<Person[]> {
    const persons = [...(await this.fiche.findByIdentifier(networkId, 'phone', phone))];
    const owner = await this.db.first<{ person_id: string }>('SELECT person_id FROM contact_keys WHERE network_id = ? AND key IN (?, ?) ORDER BY key LIMIT 1', [networkId, ...(await keyLookupForms(networkId, [key]))]);
    if (owner) {
      const p = await this.store.getPerson(await this.fiche.rootOf(owner.person_id));
      if (p) persons.push(p);
    }
    const unique = [...new Map(persons.map((p) => [p.id, p])).values()];
    return unique.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  }

  private async transcribe(recording: CallRecording, durationS: number) {
    if (!this.transcriber) return 'indisponible' as const;
    const value = await this.withTimeout(() => this.transcriber!.transcribe({ ...recording }), this.timeoutMs);
    if (value === 'late') return 'indisponible' as const;
    if (value === 'error') return 'echec' as const;
    return readCallTranscript(value, durationS, this.minConfidence);
  }

  /**
   * Q01 sur les seules paroles de l'appelant. L'IA ne reçoit ni coordonnée, ni nom de la fiche, ni le nom que l'appelant se
   * donne [R15] ; sa sortie, contrôlée sur ce même texte, refusée, laisse les règles fixes [R23].
   */
  private async qualify(segments: readonly CallSegment[], person: Person): Promise<{ qualified: Qualified; source: 'ai' | 'rules' }> {
    const text = withoutContactDetails(segments.filter((s) => s.speaker === 'appelant').map((s) => s.text).join('\n'));
    const rules = qualifyByRules(text, { communes: this.communes });
    if (!this.qualifier) return { qualified: rules, source: 'rules' };
    const names = [person.first_name, person.last_name].filter((n): n is string => typeof n === 'string' && n.trim() !== '');
    const brief = withoutNames(text, names, this.communes);
    const raw = await this.withTimeout(
      () => this.qualifier!.qualify({ text: brief, channel: 'phone', propertyRecognized: false, communes: this.communes }),
      this.aiTimeoutMs,
    );
    if (raw === 'late' || raw === 'error') return { qualified: rules, source: 'rules' };
    const checked = checkAiQualification(raw, brief, this.communes);
    if ('rule' in checked) return { qualified: rules, source: 'rules' };
    return { qualified: checked, source: 'ai' };
  }

  private async withTimeout<T>(run: () => Promise<T>, ms: number): Promise<T | 'late' | 'error'> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), ms);
    });
    try {
      return await Promise.race([run(), late]);
    } catch {
      return 'error';
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Ce que la fiche montre d'un appel rangé. */
export function callView(row: CallRow): CallView {
  const transcript: CallSegment[] = row.transcript ? (JSON.parse(row.transcript) as CallSegment[]) : [];
  const fields: CitedField[] = row.fields ? (JSON.parse(row.fields) as CitedField[]) : [];
  const summary = fields
    .filter((f) => transcript[f.segment]?.speaker === 'appelant')
    .map((f) => ({ key: f.key, value: f.value, quote: transcript[f.segment]!.text, atS: transcript[f.segment]!.startS }))
    .sort((a, b) => SUMMARY_ORDER.indexOf(a.key) - SUMMARY_ORDER.indexOf(b.key));
  const durationS = row.started_at && row.ended_at ? (Date.parse(row.ended_at) - Date.parse(row.started_at)) / 1000 : null;
  const stop = stopSegment(transcript);
  return {
    id: row.id,
    startedAt: row.started_at,
    durationS,
    status: row.status as Exclude<CallStatus, 'en_cours'>,
    failure: row.failure,
    needsAgent: row.status !== 'traite',
    ambiguous: row.attach === 'ambiguous',
    recordingRef: row.recording_ref,
    category: row.category,
    route: row.route,
    summary,
    transcript,
    stop: stop ? { quote: stop.text, atS: stop.startS } : null,
    origin: { contentId: row.origin_content_id, kind: row.origin_kind ?? 'inconnue' },
  };
}


/**
 * BR61 · Les appels reçus d'une fiche, sous les droits de la fiche : l'agent qui la suit ou la direction, refus au
 * journal par `Acces.readFiche` [R16]. Les appels des fiches réunies se relisent sur la fiche gardée ; un appel en cours
 * n'est pas montré. Rien de plus au journal que la lecture de la fiche : ni phrase, ni numéro [R13].
 */
export async function callsOfFiche(db: SqlDatabase, acces: Acces, viewer: Viewer, personId: string): Promise<AccessResult<CallView[]>> {
  const read = await acces.readFiche(viewer, personId);
  if (!read.ok) return read;
  const members = read.value.members.map((m) => m.id);
  if (members.length === 0) return { ok: true, view: read.view, value: [] };
  const rows = await db.all<CallRow>(
    `SELECT * FROM calls WHERE network_id = ? AND status <> 'en_cours' AND person_id IN (${members.map(() => '?').join(', ')})
     ORDER BY started_at DESC, id`,
    [read.value.person.network_id, ...members],
  );
  return { ok: true, view: read.view, value: rows.map(callView) };
}
