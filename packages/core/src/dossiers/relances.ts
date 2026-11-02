/**
 * Relances des pièces manquantes, en mode essai (M10, N03) [R01, R02, R04, R05, R10, R19, R26].
 *
 * Chaque jour, pour chaque dossier de vente ouvert et chaque pièce manquante que le client fournit lui-même, une
 * relance écrite par le code, sans IA, qui nomme la pièce. Elle passe par le contrôle central, comme tout envoi :
 * heures d'envoi, exclusions, arrêts, accord pour le suivi de la vente, anti-doublon ; en mode essai, elle est rangée
 * dans la boîte d'essai, rien ne part [R26]. Une relance par pièce et par période (réglage : 3 jours) ; une relance
 * refusée pour l'heure attend le passage suivant ; une pièce reçue arrête ses relances. L'agent voit ce qui est parti
 * et ce qui a été refusé, avec la règle.
 *
 * Décidé, lecture prudente :
 * - seules les pièces que le client a lui-même sont relancées par message : titre de propriété, fiche de
 *   renseignements, règlement de copropriété et procès-verbaux d'assemblée pour le vendeur, fiche de renseignements
 *   pour l'acquéreur ; les diagnostics et les pièces du syndic restent des tâches de l'agent (liste des manquantes) ;
 * - le vendeur est celui du dossier, rangé à son ouverture (`sale_file_sellers`) ; aucun nom d'une partie dans le message de l'autre [R19] ;
 * - le canal est le mail, la finalité celle du suivi de la vente (`suivi_vente`), dont l'accord est exigé [R03].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import { trialChannels } from '../captation/essai.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { ControleEnvois } from '../envoi/controle.ts';
import { SqlSendJournal } from '../envoi/journal-envois.ts';
import { localTime } from '../envoi/horaires.ts';
import { DecisionEnvoi } from '../envoi/service.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { ficheFirstName } from '../fiche/prenom.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { ScheduledJob } from '../bascule/planificateur.ts';
import { SELLER_UPDATE_PURPOSE, nameWords } from '../visites/compte-rendu.ts';
import { gateSaleFile, type FileRefusal, type FileUnknown } from './acces-dossier.ts';
import { fundsInOutgoing } from './bouclier.ts';
import { PiecesDossier, type Piece, type PieceStore } from './pieces.ts';

const TIME_ZONE = 'Europe/Paris';
export const SALE_FOLLOW_UP_PURPOSE = SELLER_UPDATE_PURPOSE;
export const DEFAULT_REMINDER_DAYS = 3;

/** Les pièces relancées par message, et à qui : celles que le client a lui-même. */
export const CLIENT_PIECES: Partial<Record<Piece, 'vendeur' | 'acquereur'>> = {
  titre_propriete: 'vendeur',
  fiche_renseignements_vendeur: 'vendeur',
  reglement_copropriete: 'vendeur',
  pv_assemblees: 'vendeur',
  fiche_renseignements_acquereur: 'acquereur',
};

/** Le nom de chaque pièce dans un message, en français simple. */
export const PIECE_LABELS: Record<Piece, string> = {
  titre_propriete: 'le titre de propriété',
  fiche_renseignements_vendeur: 'la fiche de renseignements du vendeur remplie',
  etat_risques: "l'état des risques",
  dpe: 'le diagnostic de performance énergétique',
  amiante: 'le diagnostic amiante',
  plomb: 'le constat plomb',
  electricite: "le diagnostic de l'installation électrique",
  gaz: "le diagnostic de l'installation de gaz",
  bornage: 'le plan de bornage',
  reglement_copropriete: 'le règlement de copropriété',
  pv_assemblees: "les procès-verbaux des assemblées générales des trois dernières années",
  fiche_synthetique: 'la fiche synthétique de la copropriété',
  pre_etat_date: "le pré-état daté",
  carnet_entretien: "le carnet d'entretien de l'immeuble",
  mesurage_carrez: 'le mesurage loi Carrez',
  notice_information: "la notice d'information de la copropriété",
  pppt_dtg: 'le plan pluriannuel de travaux ou le diagnostic technique global',
  dta_parties_communes: 'le dossier technique amiante des parties communes',
  fiche_renseignements_acquereur: "la fiche de renseignements de l'acquéreur remplie",
};

/**
 * Le texte d'une relance, écrit par le code : vouvoiement avec le prénom, aucune parenthèse [R08]. Un rappel porte sa
 * date, `AAAA-MM-JJ` à Paris, la seule donnée chiffrée, pour ne jamais répéter le même message [R05, R10].
 */
export function reminderText(firstName: string | null, piece: Piece, reminderOn: string | null = null, property: { city: string | null; reference: string } | null = null): string {
  const hello = firstName ? `Bonjour ${firstName},` : 'Bonjour,';
  const lead = reminderOn ? `${hello} petit rappel du ${reminderOn.slice(8, 10)}/${reminderOn.slice(5, 7)} :` : hello;
  // Le bien est nommé par sa commune et sa référence d'agence, jamais par son adresse [R19] : deux dossiers d'une même
  // personne ne donnent jamais le même message [R05].
  const sale = property ? `la vente de votre bien${property.city ? ` à ${property.city}` : ''}, référence ${property.reference},` : 'la vente';
  return `${lead} pour préparer ${sale} chez le notaire, il manque encore ${PIECE_LABELS[piece]}. Il vous suffit de répondre à ce message avec la pièce jointe, votre agent immobilier la range dans le dossier. Merci !`;
}

export type ReminderStatus = 'sent' | 'waiting' | 'refused' | 'failed' | 'closed';

export interface Reminder {
  piece: Piece;
  side: 'vendeur' | 'acquereur';
  day: string;
  status: ReminderStatus;
  rule: string | null;
  updatedAt: string;
}

const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export class RelancesPieces {
  private readonly now: () => Date;
  private readonly every: number;
  private readonly controle: ControleEnvois;
  private readonly pieces: PiecesDossier;
  private readonly unique: FicheUnique;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    store: PieceStore,
    options: { now?: () => Date; reminderDays?: number } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.every = options.reminderDays ?? DEFAULT_REMINDER_DAYS;
    if (!Number.isInteger(this.every) || this.every < 1 || this.every > 30) throw new Error('Période des relances de pièces : de 1 à 30 jours.');
    const fiches = new FicheClient(db, { now: this.now });
    const unique = new FicheUnique(db, fiches, { now: this.now });
    this.unique = unique;
    this.controle = new ControleEnvois(db, unique, new DecisionEnvoi(db, fiches, unique, { now: this.now }), {
      channels: trialChannels(db, journal, this.now),
      journal: new SqlSendJournal(db, undefined, this.now),
      now: this.now,
    });
    this.pieces = new PiecesDossier(db, acces, journal, store, { now: this.now });
  }

  private async firstName(personId: string): Promise<string | null> {
    return ficheFirstName(this.db, await this.unique.membersOf(personId));
  }

  /**
   * Les mots des noms de l'autre partie, fiches réunies comprises, interdits dans le message [R19] ; sauf ceux du prénom
   * du destinataire, qui ouvre le message : deux parties qui portent le même prénom ne bloquent pas la relance.
   */
  private async forbiddenNames(otherId: string, recipientFirstName: string | null): Promise<string[]> {
    const members = await this.unique.membersOf(otherId);
    const rows = await this.db.all<{ first_name: string | null; last_name: string | null }>(`SELECT first_name, last_name FROM persons WHERE id IN (${members.map(() => '?').join(', ')})`, members);
    const greeting = new Set(recipientFirstName ? nameWords(recipientFirstName) : []);
    const words = new Set(rows.flatMap((r) => [r.first_name, r.last_name]).filter((n): n is string => !!n).flatMap(nameWords));
    return [...words].filter((w) => !greeting.has(w));
  }

  /**
   * Le passage : pour chaque dossier ouvert du réseau, une relance par pièce manquante du client et par période.
   * Rend le nombre de relances rangées dans la boîte d'essai.
   */
  async run(networkId: string): Promise<number> {
    const today = localTime(this.now(), TIME_ZONE).date;
    // Une relance restée en attente un jour passé ne repartira plus : elle est close, avec sa raison.
    await this.db.run("UPDATE sale_file_reminders SET status = 'closed', rule = 'jour_passe', updated_at = ? WHERE network_id = ? AND status IN ('waiting', 'failed') AND day < ?", [this.now().toISOString(), networkId, today]);
    const files = await this.db.all<{ id: string; property_id: string; buyer_person_id: string; agent_id: string | null; city: string | null; reference: string }>(
      `SELECT f.id, f.property_id, f.buyer_person_id, p.agent_id, p.city, p.reference FROM sale_files f JOIN properties p ON p.id = f.property_id
       WHERE f.network_id = ? AND p.status = 'under_offer' ORDER BY f.opened_at, f.id`,
      [networkId],
    );
    let sent = 0;
    for (const f of files) {
      if (!f.agent_id) continue;
      const seller = await this.db.first<{ person_id: string }>('SELECT person_id FROM sale_file_sellers WHERE file_id = ?', [f.id]);
      // Le système lit le dossier comme l'agent du bien, sans rien ouvrir de plus que lui.
      const status = await this.pieces.status({ role: 'agent', networkId, userId: f.agent_id }, f.id);
      if (!status.ok) continue;
      // Une pièce reçue ferme sa relance encore en attente.
      for (const l of status.value.lines) {
        if (l.received) await this.db.run("UPDATE sale_file_reminders SET status = 'closed', rule = 'piece_recue', updated_at = ? WHERE file_id = ? AND piece = ? AND status IN ('waiting', 'failed')", [this.now().toISOString(), f.id, l.piece]);
      }
      for (const piece of status.value.missing) {
        const side = CLIENT_PIECES[piece];
        if (!side) continue;
        const personId = side === 'vendeur' ? seller?.person_id : f.buyer_person_id;
        if (!personId) continue;
        // Une relance déjà partie dans la période : rien de plus [R05].
        const last = await this.db.first<{ day: string }>("SELECT day FROM sale_file_reminders WHERE file_id = ? AND piece = ? AND status = 'sent' ORDER BY day DESC LIMIT 1", [f.id, piece]);
        if (last && today < addDays(last.day, this.every)) continue;
        const row = await this.db.first<{ status: ReminderStatus }>('SELECT status FROM sale_file_reminders WHERE file_id = ? AND piece = ? AND day = ?', [f.id, piece, today]);
        if (row && row.status !== 'waiting' && row.status !== 'failed') continue;
        if (!row) {
          await this.db.run(
            "INSERT INTO sale_file_reminders (file_id, piece, day, network_id, person_id, side, status, rule, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'waiting', NULL, ?) ON CONFLICT DO NOTHING",
            [f.id, piece, today, networkId, personId, side, this.now().toISOString()],
          );
        }
        const other = side === 'vendeur' ? f.buyer_person_id : seller?.person_id;
        const firstName = await this.firstName(personId);
        const reference = { city: f.city, reference: f.reference };
        const text = reminderText(firstName, piece, last ? today : null, reference);
        // Jamais de coordonnée bancaire ni de demande de paiement dans un texte d'AIMMO [R62].
        if (fundsInOutgoing(text)) {
          await this.db.run("UPDATE sale_file_reminders SET status = 'refused', rule = 'R62', updated_at = ? WHERE file_id = ? AND piece = ? AND day = ? AND status IN ('waiting', 'failed')", [this.now().toISOString(), f.id, piece, today]);
          await appendEvent(this.journal, { type: 'dossier.relance', actor: 'system:dossiers', subject: `sale_file:${f.id}`, data: { mode: 'essai', side, client: `person:${personId}`, piece, status: 'refused', rule: 'R62' } }, this.now);
          continue;
        }
        const result = await this.controle.send({
          networkId,
          agentId: f.agent_id,
          personId,
          channel: 'email',
          kind: 'follow_up',
          purpose: SALE_FOLLOW_UP_PURPOSE,
          subject: `relance_piece:${f.id}:${piece}:${today}`,
          fallbackTexts: [text],
          // La date du rappel et les chiffres de la référence du bien, lus dans la base [R10].
          figures: [...(last ? [Number(today.slice(8, 10)), Number(today.slice(5, 7))] : []), ...(f.reference.match(/\d+/g) ?? []).map(Number)],
          // Le nom de l'autre partie n'apparaît jamais [R19].
          sellerNames: other ? await this.forbiddenNames(other, firstName) : [],
        });
        const outcome: ReminderStatus = result.status === 'sent' ? 'sent' : result.status === 'failed' ? 'failed' : result.rule === 'R01' ? 'waiting' : 'refused';
        const rule = result.status === 'sent' ? null : result.rule;
        await this.db.run(
          "UPDATE sale_file_reminders SET status = ?, rule = ?, message_id = COALESCE(?, message_id), updated_at = ? WHERE file_id = ? AND piece = ? AND day = ? AND status IN ('waiting', 'failed')",
          [outcome, rule, result.messageId, this.now().toISOString(), f.id, piece, today],
        );
        await appendEvent(this.journal, { type: 'dossier.relance', actor: 'system:dossiers', subject: `sale_file:${f.id}`, data: { mode: 'essai', side, client: `person:${personId}`, piece, status: outcome, rule } }, this.now);
        if (outcome === 'sent') sent += 1;
      }
    }
    return sent;
  }

  /** Ce que l'agent voit des relances d'un dossier : agent du bien, direction, conformité [R16]. */
  async ofFile(viewer: Viewer, fileId: string): Promise<{ ok: true; value: Reminder[] } | FileRefusal | FileUnknown> {
    const g = await gateSaleFile({ db: this.db, acces: this.acces, journal: this.journal, now: this.now }, viewer, fileId, false, 'sale_file_reminders');
    if (!g.ok) return g;
    const rows = await this.db.all<{ piece: Piece; side: 'vendeur' | 'acquereur'; day: string; status: ReminderStatus; rule: string | null; updated_at: string }>(
      'SELECT piece, side, day, status, rule, updated_at FROM sale_file_reminders WHERE file_id = ? ORDER BY day, piece',
      [fileId],
    );
    return { ok: true, value: rows.map((r) => ({ piece: r.piece, side: r.side, day: r.day, status: r.status, rule: r.rule, updatedAt: r.updated_at })) };
  }
}

export const PIECE_REMINDER_JOB = 'dossiers.relances_pieces';

/** Du lundi au samedi, d'heure en heure dans les heures d'envoi : les relances du jour, et celles qui attendaient [R01]. */
export function pieceReminderJob(db: SqlDatabase, journal: JournalStore, acces: () => Acces, store: PieceStore, options: { reminderDays?: number; now?: () => Date } = {}): ScheduledJob {
  return {
    name: PIECE_REMINDER_JOB,
    hours: [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
    weekdays: [1, 2, 3, 4, 5, 6],
    run: async () => {
      const r = new RelancesPieces(db, acces(), journal, store, options);
      for (const n of await db.all<{ id: string }>('SELECT id FROM networks')) await r.run(n.id);
    },
  };
}
