/**
 * Lettre recommandée électronique et notification de l'avant-contrat (M06, HX36) [R460 à R463].
 *
 * Après la signature du compromis, l'acquéreur reçoit la notification qui ouvre son délai de rétractation de 10 jours
 * (code de la construction et de l'habitation, article L271-1). L'agent du bien la prépare : le compromis signé, rangé,
 * y est joint, le texte est écrit par le code, jamais par l'IA. Elle ne part que par le contrôle central des envois,
 * après le geste de l'agent, avec l'accord de l'acquéreur à recevoir ses notifications par lettre recommandée
 * électronique [R461] ; une seule fois.
 *
 * Le prestataire de la lettre rend ses preuves : dépôt, première présentation, puis acceptation, refus ou lettre non
 * réclamée. Chacune est rangée au dossier avec sa référence, en ajout seul [R462]. Jamais vu : la date de première
 * présentation lue dans la preuve remplit seule l'échéancier du dossier (N02), sans ressaisie, et la fin du délai de
 * rétractation se calcule aussitôt [R460].
 *
 * Décidé, lecture prudente :
 * - le délai court du lendemain de la première présentation, même si l'acquéreur refuse ou ne réclame pas la lettre :
 *   ces preuves sont rangées, elles ne changent pas la date ;
 * - la date de la preuve l'emporte sur une date saisie à la main ; la saisie reste, la preuve s'ajoute en nouvelle
 *   version [R17] ; une date qui ne tiendrait pas dans l'ordre du compromis n'est pas écrite et la raison est dite ;
 * - une lettre restée dans la boîte d'essai n'est pas partie : elle n'a ni preuve ni date [R463] ;
 * - une preuve doit citer la référence que le prestataire a rendue à l'envoi : une preuve d'une autre lettre est
 *   refusée ;
 * - le texte de la lettre est un texte de travail : sa version définitive est écrite et validée par la conformité (H08).
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import { trialChannels } from '../captation/essai.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { actorOf, gateSaleFile, type FileRefusal, type FileUnknown } from '../dossiers/acces-dossier.ts';
import { buyersInAlsaceMoselle, calendarFor, propertyPlaceOf } from '../dossiers/calendrier.ts';
import { BUYER_WITHDRAWAL_DAYS, DATE_KINDS, buyerWithdrawalLastDay, orderProblem, type DateKind } from '../dossiers/echeancier.ts';
import type { PieceStore } from '../dossiers/pieces.ts';
import type { DeliveryReceipt, OutboundChannel, OutboundMessage } from '../envoi/canaux.ts';
import { ControleEnvois, type ChannelStaging } from '../envoi/controle.ts';
import { localTime } from '../envoi/horaires.ts';
import { SqlSendJournal } from '../envoi/journal-envois.ts';
import { DecisionEnvoi } from '../envoi/service.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { ficheFirstName } from '../fiche/prenom.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { PROOF_REF } from '../offres/transmission.ts';

const TIME_ZONE = 'Europe/Paris';

/** La finalité de l'accord de l'acquéreur : recevoir ses notifications par lettre recommandée électronique [R461]. */
export const REGISTERED_LETTER_PURPOSE = 'notification_recommandee';

export const LETTER_PROOFS = ['depot', 'premiere_presentation', 'acceptation', 'refus', 'non_reclamee'] as const;
export type LetterProof = (typeof LETTER_PROOFS)[number];
/** Ce qui suit la première présentation : un seul des trois. */
const OUTCOMES: readonly LetterProof[] = ['acceptation', 'refus', 'non_reclamee'];

export type LetterEventKind = 'envoi' | 'envoi_refuse' | LetterProof;

export interface LetterEvent {
  kind: LetterEventKind;
  occurredAt: string;
  day: string;
  proofRef: string | null;
  /** Envoi seulement : resté dans la boîte d'essai. */
  trial: boolean | null;
  rule: string | null;
}

export type LetterStatus = 'preparee' | 'essai' | 'envoyee' | 'deposee' | 'presentee' | LetterProof;

export interface Letter {
  id: string;
  fileId: string;
  purpose: 'notification_avant_contrat';
  documentRef: string;
  preparedAt: string;
  status: LetterStatus;
  events: LetterEvent[];
}

export type LetterProblem = {
  ok: false;
  rule: 'R460' | 'R461' | 'R462' | 'R463' | null;
  code:
    | 'closed'
    | 'compromis_not_signed'
    | 'bad_ref'
    | 'not_stored'
    | 'already_sent'
    | 'unknown_letter'
    | 'changed'
    | 'unknown_proof'
    | 'bad_time'
    | 'not_sent'
    | 'trial'
    | 'unknown_ref'
    | 'out_of_order'
    | 'already_recorded'
    | 'proof_used'
    | 'busy';
};

/** Ce que la première présentation a fait à l'échéancier. */
export interface ScheduleFill {
  filled: boolean;
  /** `ecrite` : nouvelle version ; `deja_la` : la même date y était ; sinon pourquoi rien n'est écrit. */
  reason: 'ecrite' | 'deja_la' | 'closed' | 'file_stopped' | 'compromis_first' | 'before_compromis' | 'out_of_order' | 'busy';
  day: string;
  /** Le dernier jour de la rétractation, si la date est à l'échéancier. */
  withdrawalLastDay: string | null;
}

interface LetterRow {
  id: string;
  network_id: string;
  file_id: string;
  purpose: 'notification_avant_contrat';
  person_id: string;
  document_ref: string;
  hash: string;
  prepared_by: string;
  prepared_at: string;
}

interface EventRow {
  seq: number;
  kind: LetterEventKind;
  occurred_at: string;
  day: string;
  proof_ref: string | null;
  message_id: string | null;
  trial: number | null;
  rule: string | null;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

/** « 10 mars 2027 », depuis `2027-03-10`. */
export function frenchDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return `${d === 1 ? '1er' : d} ${MONTHS[m - 1]} ${y}`;
}

/**
 * Le texte de la lettre, écrit par le code : prénom de l'acquéreur, jour de la signature, nom de l'agent. Aucun prix,
 * aucune adresse. Texte de travail : la version définitive est celle que valide la conformité (H08).
 */
export function letterText(input: { firstName: string; signedOn: string; agentName: string }): string {
  return [
    `Bonjour ${input.firstName},`,
    `Cette lettre recommandée vous notifie le compromis de vente que vous avez signé le ${frenchDay(input.signedOn)}. Le compromis signé est joint à cette lettre.`,
    `Vous disposez d’un délai de rétractation de ${BUYER_WITHDRAWAL_DAYS} jours, qui commence le lendemain de la première présentation de cette lettre. Vous pouvez vous rétracter sans donner de motif, avant la fin de ce délai, par lettre recommandée avec demande d’avis de réception ou par lettre recommandée électronique.`,
    `${input.agentName}, votre agent immobilier`,
  ].join('\n\n');
}

/** Les chiffres que porte la lettre : le délai, le jour et l'année de la signature [R10]. */
function letterFigures(signedOn: string): (string | number)[] {
  const [y, , d] = signedOn.split('-').map(Number) as [number, number, number];
  return [BUYER_WITHDRAWAL_DAYS, d, y];
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Le prestataire de lettre recommandée électronique. Il reçoit la lettre et la référence du compromis joint, qu'il
 * va chercher au stockage des pièces, et rend la référence sous laquelle il enverra ses preuves.
 */
export interface RegisteredLetterProvider {
  post(letter: { to: string; body: string; messageId: string; attachmentRef: string }): Promise<{ externalId: string }>;
}

/**
 * Le port du prestataire, sur le canal `email`, remis au seul contrôle central pour une lettre : il y joint le compromis
 * de cette lettre [R461]. Une remise sans référence de preuve est une panne : aucune preuve ne pourrait s'y rattacher.
 */
class LetterPort implements OutboundChannel {
  readonly channel = 'email' as const;
  constructor(
    private readonly provider: RegisteredLetterProvider,
    private readonly attachmentRef: string,
  ) {}

  async deliver(message: OutboundMessage): Promise<DeliveryReceipt> {
    const r = await this.provider.post({ to: message.to, body: message.body, messageId: message.messageId, attachmentRef: this.attachmentRef });
    if (typeof r?.externalId !== 'string' || r.externalId.trim() === '') throw new Error('Le prestataire n’a pas rendu de référence.');
    return { externalId: r.externalId };
  }
}

export interface RecommandeOptions {
  now?: () => Date;
  newId?: () => string;
  /** Le prestataire de lettre recommandée électronique. Absent : la boîte d'essai, rien ne part [R463]. */
  provider?: RegisteredLetterProvider;
}

export class RecommandeElectronique {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly fiche: FicheUnique;
  private readonly decisions: DecisionEnvoi;
  private readonly provider: RegisteredLetterProvider | null;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    private readonly store: PieceStore,
    options: RecommandeOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.provider = options.provider ?? null;
    const fiches = new FicheClient(db, { now: this.now });
    this.fiche = new FicheUnique(db, fiches, { now: this.now });
    this.decisions = new DecisionEnvoi(db, fiches, this.fiche, { now: this.now });
  }

  /**
   * Le contrôle central pour une lettre : la boîte d'essai, et un palier qui ne mène qu'au port du prestataire avec le
   * compromis de cette lettre. Sans prestataire, la lettre reste en essai et ne compte pour rien : ni sujet, ni texte
   * [R05, R463]. Aucun autre canal ne peut recevoir la lettre [R461].
   */
  private controleFor(attachmentRef: string): ControleEnvois {
    const real = this.provider ? new LetterPort(this.provider, attachmentRef) : null;
    const staging: ChannelStaging = {
      route: async (_network, channel) => ({ real: channel === 'email' ? real : null, confirm: async () => {} }),
      failed: async () => {},
    };
    const channels = trialChannels(this.db, this.journal, this.now).filter((c) => c.channel === 'email');
    return new ControleEnvois(this.db, this.fiche, this.decisions, { channels, staging, journal: new SqlSendJournal(this.db, undefined, this.now), now: this.now });
  }

  private gate(viewer: Viewer, fileId: string, write: boolean) {
    return gateSaleFile({ db: this.db, acces: this.acces, journal: this.journal, now: this.now }, viewer, fileId, write, 'registered_letter');
  }

  private async closed(fileId: string): Promise<boolean> {
    return (await this.db.first('SELECT 1 FROM sale_file_closings WHERE file_id = ?', [fileId])) !== null;
  }

  /** La dernière version de chaque date du dossier. */
  private async dates(fileId: string): Promise<Partial<Record<DateKind, { day: string; version: number }>>> {
    const rows = await this.db.all<{ kind: DateKind; day: string; version: number }>(
      `SELECT kind, day, version FROM sale_file_dates d WHERE file_id = ?
       AND version = (SELECT MAX(version) FROM sale_file_dates e WHERE e.file_id = d.file_id AND e.kind = d.kind)`,
      [fileId],
    );
    return Object.fromEntries(rows.map((r) => [r.kind, { day: r.day, version: Number(r.version) }]));
  }

  /** Le texte tel qu'il partirait maintenant, ou null si le compromis n'est pas signé. */
  private async text(fileId: string, personId: string, agentId: string): Promise<{ body: string; figures: (string | number)[] } | null> {
    const signed = (await this.dates(fileId)).compromis_signe;
    if (!signed) return null;
    // Le prénom de la fiche gardée, fiches réunies comprises [R08].
    const firstName = await ficheFirstName(this.db, await this.fiche.membersOf(personId));
    const agent = await this.db.first<{ first_name: string; last_name: string }>('SELECT first_name, last_name FROM agents WHERE id = ?', [agentId]);
    if (!firstName || !agent) return null;
    return {
      body: letterText({ firstName, signedOn: signed.day, agentName: `${agent.first_name} ${agent.last_name}` }),
      figures: letterFigures(signed.day),
    };
  }

  private async eventsOf(letterId: string): Promise<EventRow[]> {
    return this.db.all<EventRow>('SELECT seq, kind, occurred_at, day, proof_ref, message_id, trial, rule FROM registered_letter_events WHERE letter_id = ? ORDER BY seq', [letterId]);
  }

  private async addEvent(letter: LetterRow, e: { kind: LetterEventKind; occurredAt: string; proofRef: string | null; messageId: string | null; trial: boolean | null; rule: string | null; by: string }): Promise<boolean> {
    const last = await this.db.first<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM registered_letter_events WHERE letter_id = ?', [letter.id]);
    try {
      await this.db.run(
        `INSERT INTO registered_letter_events (letter_id, network_id, file_id, seq, kind, occurred_at, day, proof_ref, message_id, trial, rule, recorded_at, recorded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          letter.id,
          letter.network_id,
          letter.file_id,
          Number(last?.seq ?? 0) + 1,
          e.kind,
          e.occurredAt,
          localTime(new Date(e.occurredAt), TIME_ZONE).date,
          e.proofRef,
          e.messageId,
          e.trial === null ? null : e.trial ? 1 : 0,
          e.rule,
          this.now().toISOString(),
          e.by,
        ],
      );
      return true;
    } catch (error) {
      if (/UNIQUE|PRIMARY/i.test(String(error))) return false;
      throw error;
    }
  }

  /**
   * Une lettre que le contrôle central a remise au prestataire, sans que son envoi ait été rangé ici (une coupure entre
   * les deux) : l'envoi est retrouvé par le sujet du dossier, le fil de la lettre et la référence rendue par le
   * prestataire, et rangé, sans renvoyer
   * [R461, R462]. Rend vrai si la lettre a un envoi rangé.
   */
  private async reconcile(letter: LetterRow): Promise<boolean> {
    if (await this.db.first("SELECT 1 FROM registered_letter_events WHERE letter_id = ? AND kind = 'envoi'", [letter.id])) return true;
    const m = await this.db.first<{ message_id: string; occurred_at: string }>(
      `SELECT s.message_id, m.occurred_at FROM message_subjects s JOIN messages m ON m.id = s.message_id
       JOIN outbound_refs r ON r.message_id = s.message_id AND r.channel = 'email'
       WHERE s.subject = ? AND s.network_id = ? AND m.conversation_id = ? ORDER BY m.occurred_at LIMIT 1`,
      [`recommande:${letter.file_id}`, letter.network_id, `recommande:${letter.id}`],
    );
    if (!m) return false;
    await this.addEvent(letter, { kind: 'envoi', occurredAt: new Date(Date.parse(m.occurred_at)).toISOString(), proofRef: null, messageId: m.message_id, trial: false, rule: null, by: 'system:recommande' });
    await appendEvent(this.journal, { type: 'dossier.recommande_envoye', actor: 'system:recommande', subject: `sale_file:${letter.file_id}`, data: { rule: 'R461', letter: letter.id, message: m.message_id } }, this.now);
    return true;
  }

  /** La lettre d'un dossier qui est vraiment partie, s'il y en a une. */
  private async sentLetterOf(fileId: string): Promise<boolean> {
    return (await this.db.first("SELECT 1 FROM registered_letter_events WHERE file_id = ? AND kind = 'envoi' AND trial = 0", [fileId])) !== null;
  }

  /**
   * L'agent du bien prépare la notification de l'avant-contrat : le compromis est signé et daté à l'échéancier, le
   * compromis signé est rangé au dossier. Rien ne part encore.
   */
  async prepare(viewer: Viewer, fileId: string, input: { documentRef: unknown }): Promise<{ ok: true; value: Letter } | FileRefusal | FileUnknown | LetterProblem> {
    const g = await this.gate(viewer, fileId, true);
    if (!g.ok) return g;
    if (await this.closed(fileId)) return { ok: false, rule: null, code: 'closed' };
    const ref = input.documentRef;
    if (typeof ref !== 'string' || !new RegExp(`^dossiers/${fileId.replace(/[^0-9a-zA-Z-]/g, '')}/${UUID}\\.pdf$`).test(ref)) return { ok: false, rule: null, code: 'bad_ref' };
    if (!(await this.store.has(ref))) return { ok: false, rule: 'R462', code: 'not_stored' };
    if (await this.sentLetterOf(fileId)) return { ok: false, rule: 'R461', code: 'already_sent' };
    const text = await this.text(fileId, g.file.buyer_person_id, viewer.userId);
    if (!text) return { ok: false, rule: null, code: 'compromis_not_signed' };
    const id = this.newId();
    await this.db.run(
      'INSERT INTO registered_letters (id, network_id, file_id, purpose, person_id, document_ref, hash, prepared_by, prepared_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, g.file.network_id, fileId, 'notification_avant_contrat', g.file.buyer_person_id, ref, await sha256(text.body), actorOf(viewer), this.now().toISOString()],
    );
    await appendEvent(this.journal, { type: 'dossier.recommande_prepare', actor: actorOf(viewer), subject: `sale_file:${fileId}`, data: { letter: id } }, this.now);
    return { ok: true, value: (await this.view(id))! };
  }

  /**
   * Le geste de l'agent du bien : la lettre part par le contrôle central, qui redécide tout (accord de l'acquéreur à la
   * voie électronique, heures, une seule fois) [R461]. Sans le port du prestataire, elle reste dans la boîte d'essai.
   */
  async send(viewer: Viewer, letterId: string): Promise<{ ok: true; value: Letter & { sent: boolean; rule: string | null } } | FileRefusal | FileUnknown | LetterProblem> {
    const letter = await this.db.first<LetterRow>('SELECT * FROM registered_letters WHERE id = ?', [letterId]);
    if (!letter || letter.network_id !== viewer.networkId) return { ok: false, rule: null, code: 'unknown_letter' };
    const g = await this.gate(viewer, letter.file_id, true);
    if (!g.ok) return g;
    if (await this.closed(letter.file_id)) return { ok: false, rule: null, code: 'closed' };
    // Déjà remise au prestataire : rien ne repart, l'envoi est rangé s'il manquait.
    const before = (await this.eventsOf(letterId)).some((e) => e.kind === 'envoi');
    if (await this.reconcile(letter)) {
      if (before) return { ok: false, rule: 'R461', code: 'already_sent' };
      return { ok: true, value: { ...(await this.view(letterId))!, sent: true, rule: null } };
    }
    if (await this.sentLetterOf(letter.file_id)) return { ok: false, rule: 'R461', code: 'already_sent' };
    if (!(await this.store.has(letter.document_ref))) return { ok: false, rule: 'R462', code: 'not_stored' };
    // Le texte est refait maintenant : une date de signature corrigée depuis la préparation demande une nouvelle lettre.
    const text = await this.text(letter.file_id, letter.person_id, viewer.userId);
    if (!text || (await sha256(text.body)) !== letter.hash) return { ok: false, rule: null, code: 'changed' };
    // L'heure de l'envoi est prise avant la remise : une preuve de dépôt faite pendant la remise la suit [R462].
    const at = this.now().toISOString();
    const result = await this.controleFor(letter.document_ref).send({
      networkId: letter.network_id,
      agentId: viewer.userId,
      preparedBy: viewer.userId,
      personId: letter.person_id,
      channel: 'email',
      kind: 'alert',
      purpose: REGISTERED_LETTER_PURPOSE,
      // Le sujet est le dossier : le contrôle central le réserve d'un coup avant la remise, une seule lettre part par
      // dossier même si deux gestes se croisent ; une lettre d'essai, refusée ou en panne le rend [R05, R461].
      subject: `recommande:${letter.file_id}`,
      fallbackTexts: [text.body],
      figures: text.figures,
      // Le texte du code, tel quel : ni IA, ni mention de l'assistant ajoutée à un acte juridique.
      asWritten: { refuseWithoutMention: false, thread: `recommande:${letterId}` },
    });
    const by = actorOf(viewer);
    if (result.status === 'sent' && result.messageId) {
      const trial = result.trial !== false;
      if (!(await this.addEvent(letter, { kind: 'envoi', occurredAt: at, proofRef: null, messageId: result.messageId, trial, rule: null, by }))) return { ok: false, rule: null, code: 'busy' };
      if (trial) await appendEvent(this.journal, { type: 'dossier.recommande_essai', actor: by, subject: `sale_file:${letter.file_id}`, data: { rule: 'R463', letter: letterId, message: result.messageId } }, this.now);
      else await appendEvent(this.journal, { type: 'dossier.recommande_envoye', actor: by, subject: `sale_file:${letter.file_id}`, data: { rule: 'R461', letter: letterId, message: result.messageId } }, this.now);
      return { ok: true, value: { ...(await this.view(letterId))!, sent: !trial, rule: trial ? 'R463' : null } };
    }
    const rule = result.rule ?? (result.status === 'failed' ? 'panne' : 'refus');
    await this.addEvent(letter, { kind: 'envoi_refuse', occurredAt: at, proofRef: null, messageId: result.messageId, trial: null, rule, by });
    await appendEvent(this.journal, { type: 'dossier.recommande_refuse', actor: by, subject: `sale_file:${letter.file_id}`, data: { rule, letter: letterId } }, this.now);
    return { ok: true, value: { ...(await this.view(letterId))!, sent: false, rule } };
  }

  /**
   * Une preuve du prestataire, reçue par le système (pas d'agent) : rangée au dossier [R462]. La première présentation
   * remplit l'échéancier [R460].
   */
  async recordProof(input: { letterId: unknown; providerRef: unknown; kind: unknown; occurredAt: unknown; proofRef: unknown }): Promise<{ ok: true; value: { letter: Letter; schedule: ScheduleFill | null } } | LetterProblem> {
    if (typeof input.letterId !== 'string') return { ok: false, rule: null, code: 'unknown_letter' };
    const letter = await this.db.first<LetterRow>('SELECT * FROM registered_letters WHERE id = ?', [input.letterId]);
    if (!letter) return { ok: false, rule: null, code: 'unknown_letter' };
    if (typeof input.kind !== 'string' || !(LETTER_PROOFS as readonly string[]).includes(input.kind)) return { ok: false, rule: null, code: 'unknown_proof' };
    const kind = input.kind as LetterProof;
    if (typeof input.occurredAt !== 'string' || !ISO.test(input.occurredAt) || Number.isNaN(Date.parse(input.occurredAt))) return { ok: false, rule: null, code: 'bad_time' };
    const occurred = new Date(Date.parse(input.occurredAt));
    if (occurred.getTime() > this.now().getTime()) return { ok: false, rule: null, code: 'bad_time' };
    if (typeof input.proofRef !== 'string' || !PROOF_REF.test(input.proofRef)) return { ok: false, rule: 'R462', code: 'bad_ref' };
    if (!(await this.store.has(input.proofRef))) return { ok: false, rule: 'R462', code: 'not_stored' };
    await this.reconcile(letter);
    const events = await this.eventsOf(letter.id);
    const sent = events.find((e) => e.kind === 'envoi');
    if (!sent) return { ok: false, rule: 'R461', code: 'not_sent' };
    if (sent.trial === 1) return { ok: false, rule: 'R463', code: 'trial' };
    // La preuve cite la référence que le prestataire a rendue pour cette lettre, et aucune autre.
    const ref = await this.db.first<{ external_id: string }>("SELECT external_id FROM outbound_refs WHERE message_id = ? AND channel = 'email'", [sent.message_id]);
    if (!ref || typeof input.providerRef !== 'string' || input.providerRef !== ref.external_id) return { ok: false, rule: 'R462', code: 'unknown_ref' };
    const same = events.find((e) => e.kind === kind);
    if (same) {
      // La même preuve reçue deux fois : rien de plus n'est rangé ; une première présentation reprend l'échéancier,
      // qu'une coupure aurait pu laisser sans sa date [R460].
      if (same.proof_ref === input.proofRef && Date.parse(same.occurred_at) === occurred.getTime()) {
        const schedule = kind === 'premiere_presentation' ? await this.fillSchedule(letter, same.day, input.proofRef) : null;
        return { ok: true, value: { letter: (await this.view(letter.id))!, schedule } };
      }
      return { ok: false, rule: 'R462', code: 'already_recorded' };
    }
    const previous: LetterEventKind = kind === 'depot' ? 'envoi' : kind === 'premiere_presentation' ? 'depot' : 'premiere_presentation';
    const before = events.find((e) => e.kind === previous);
    if (!before || occurred.getTime() < Date.parse(before.occurred_at)) return { ok: false, rule: null, code: 'out_of_order' };
    if (OUTCOMES.includes(kind) && events.some((e) => OUTCOMES.includes(e.kind as LetterProof))) return { ok: false, rule: 'R462', code: 'already_recorded' };
    if (await this.db.first('SELECT 1 FROM registered_letter_events WHERE proof_ref = ?', [input.proofRef])) return { ok: false, rule: 'R462', code: 'proof_used' };
    if (!(await this.addEvent(letter, { kind, occurredAt: occurred.toISOString(), proofRef: input.proofRef, messageId: null, trial: null, rule: 'R462', by: 'system:recommande' }))) return { ok: false, rule: null, code: 'busy' };
    await appendEvent(this.journal, { type: 'dossier.recommande_preuve', actor: 'system:recommande', subject: `sale_file:${letter.file_id}`, data: { rule: 'R462', letter: letter.id, kind } }, this.now);
    const schedule = kind === 'premiere_presentation' ? await this.fillSchedule(letter, localTime(occurred, TIME_ZONE).date, input.proofRef) : null;
    return { ok: true, value: { letter: (await this.view(letter.id))!, schedule } };
  }

  /** La date de première présentation entre à l'échéancier, avec sa preuve, sans ressaisie [R460]. */
  private async fillSchedule(letter: LetterRow, day: string, proofRef: string): Promise<ScheduleFill> {
    // Le délai dans le calendrier du bien et du domicile de l'acquéreur notifié (AU085).
    const file = await this.db.first<{ property_id: string }>('SELECT property_id FROM sale_files WHERE id = ?', [letter.file_id]);
    const place = file ? await propertyPlaceOf(this.db, file.property_id) : 'inconnu';
    const { calendar } = calendarFor(place, (await buyersInAlsaceMoselle(this.db, [letter.person_id])).has(letter.person_id));
    const done = (filled: boolean, reason: ScheduleFill['reason']): ScheduleFill => ({ filled, reason, day, withdrawalLastDay: filled ? buyerWithdrawalLastDay(day, calendar) : null });
    const refuse = async (reason: ScheduleFill['reason']) => {
      await appendEvent(this.journal, { type: 'dossier.recommande_date_non_ecrite', actor: 'system:recommande', subject: `sale_file:${letter.file_id}`, data: { rule: 'R460', letter: letter.id, reason } }, this.now);
      return done(false, reason);
    };
    if (await this.closed(letter.file_id)) return refuse('closed');
    if (await this.db.first('SELECT 1 FROM sale_file_stops WHERE file_id = ?', [letter.file_id])) return refuse('file_stopped');
    const dates = await this.dates(letter.file_id);
    // Déjà là avec cette preuve même : rien à écrire. La même date saisie à la main reçoit la preuve en nouvelle version.
    const current = dates.notification_acquereur;
    if (current?.day === day) {
      const latest = await this.db.first<{ proof_ref: string }>("SELECT proof_ref FROM sale_file_dates WHERE file_id = ? AND kind = 'notification_acquereur' AND version = ?", [letter.file_id, current.version]);
      if (latest?.proof_ref === proofRef) return done(true, 'deja_la');
    }
    const proposed = Object.fromEntries(Object.entries(dates).map(([k, v]) => [k, v.day])) as Partial<Record<DateKind, string>>;
    proposed.notification_acquereur = day;
    const problem = orderProblem(proposed);
    if (problem) return refuse(problem);
    const version = (dates.notification_acquereur?.version ?? 0) + 1;
    try {
      await this.db.run('INSERT INTO sale_file_dates (file_id, network_id, kind, version, day, proof_ref, at, by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
        letter.file_id,
        letter.network_id,
        'notification_acquereur' satisfies (typeof DATE_KINDS)[number],
        version,
        day,
        proofRef,
        this.now().toISOString(),
        'system:recommande',
      ]);
    } catch (error) {
      if (/UNIQUE|PRIMARY/i.test(String(error))) return refuse('busy');
      throw error;
    }
    await appendEvent(this.journal, { type: 'dossier.date', actor: 'system:recommande', subject: `sale_file:${letter.file_id}`, data: { rule: 'R460', kind: 'notification_acquereur', version, letter: letter.id } }, this.now);
    return done(true, 'ecrite');
  }

  private async view(letterId: string): Promise<Letter | null> {
    const l = await this.db.first<LetterRow>('SELECT * FROM registered_letters WHERE id = ?', [letterId]);
    if (!l) return null;
    const events = await this.eventsOf(letterId);
    const has = (k: LetterEventKind) => events.some((e) => e.kind === k);
    const outcome = events.find((e) => OUTCOMES.includes(e.kind as LetterProof));
    const sent = events.find((e) => e.kind === 'envoi');
    const status: LetterStatus = outcome
      ? (outcome.kind as LetterProof)
      : has('premiere_presentation')
        ? 'presentee'
        : has('depot')
          ? 'deposee'
          : sent
            ? sent.trial === 1
              ? 'essai'
              : 'envoyee'
            : 'preparee';
    return {
      id: l.id,
      fileId: l.file_id,
      purpose: l.purpose,
      documentRef: l.document_ref,
      preparedAt: l.prepared_at,
      status,
      events: events.map((e) => ({ kind: e.kind, occurredAt: e.occurred_at, day: e.day, proofRef: e.proof_ref, trial: e.trial === null ? null : e.trial === 1, rule: e.rule })),
    };
  }

  /** Les lettres du dossier et leurs preuves : agent du bien, direction, conformité [R16]. */
  async letters(viewer: Viewer, fileId: string): Promise<{ ok: true; value: Letter[] } | FileRefusal | FileUnknown> {
    const g = await this.gate(viewer, fileId, false);
    if (!g.ok) return g;
    const rows = await this.db.all<{ id: string }>('SELECT id FROM registered_letters WHERE file_id = ? ORDER BY prepared_at, id', [fileId]);
    const value: Letter[] = [];
    for (const r of rows) value.push((await this.view(r.id))!);
    return { ok: true, value };
  }
}
