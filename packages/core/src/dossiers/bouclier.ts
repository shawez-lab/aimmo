/**
 * Aucun fonds, bouclier contre le faux RIB (M10, N05) [R01 à R05, R13, R15, R18, R62]. Jamais vu.
 *
 * AIMMO ne reçoit jamais de fonds : ni séquestre, ni acompte, aucune table ni route ne suit de l'argent. Deux gardes :
 *
 * - en sortie, `fundsInOutgoing` refuse tout texte d'AIMMO à un client ou au notaire qui porte un IBAN, un RIB, un BIC,
 *   des coordonnées bancaires données, ou qui demande de payer ; les relances de M10 passent par elle ;
 * - en entrée, `scan` lit chaque message reçu d'une partie d'un dossier en cours (vendeur ou acquéreur, fiches réunies
 *   comprises) : s'il parle de virement, d'acompte, de séquestre, de RIB ou de changement de coordonnées bancaires, ou
 *   s'il porte un IBAN, une alerte part aussitôt à l'agent du bien, une seule par message ; seules les sortes de
 *   signaux sont rangées, jamais le texte ni l'IBAN, et rien n'est lu par une IA [R15]. Le client reçoit, par le
 *   contrôle central, dans les heures d'envoi, le rappel écrit qu'AIMMO ne demande jamais de fonds ni de changement
 *   de coordonnées bancaires.
 *
 * C'est la fraude la plus coûteuse d'une vente : un faux mail du « notaire » ou de l'« agence » qui donne un nouveau
 * RIB. Aucun réseau ni logiciel ne surveille ainsi toute la vente.
 *
 * Décidé, lecture prudente : le rappel part une fois par personne et par dossier (sujet `rappel_fonds:<dossier>`),
 * pour ne pas noyer le client ; une alerte de l'agent part à chaque message suspect ; un rappel refusé pour l'heure
 * repart au passage suivant. Le branchement de `scan` à la réception des messages, et le masquage de l'IBAN dans le
 * message rangé, sont dans le socle (N09).
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import { trialChannels } from '../captation/essai.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { ControleEnvois } from '../envoi/controle.ts';
import { SqlSendJournal } from '../envoi/journal-envois.ts';
import { DecisionEnvoi } from '../envoi/service.ts';
import { plain } from '../envoi/texte.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { actorOf, type FileRefusal } from './acces-dossier.ts';
import { SALE_FOLLOW_UP_PURPOSE } from './relances.ts';

/** Un IBAN, avec ou sans espaces tous les 4 caractères : deux lettres, deux chiffres, puis 12 à 30 caractères. */
const IBAN = /\b[a-z]{2}\d{2}(?: ?[a-z0-9]{4}){3,7}(?: ?[a-z0-9]{1,4})?\b/i;

export type FundSignal = 'iban' | 'coordonnees_bancaires' | 'virement' | 'acompte' | 'sequestre' | 'paiement';

// Les formes courantes, pluriels et impératifs compris. « Règlement » seul ne compte pas : règlement de copropriété.
const INBOUND: [FundSignal, RegExp][] = [
  ['coordonnees_bancaires', /\b(?:ribs?|bic|swift|iban|coordonnees bancaires|releve d'identite bancaire|nouveaux? comptes?|changement de (?:compte|banque|coordonnees)|autre compte|comptes? bancaires?|numero de compte|nouvelles? coordonnees|coordonnees (?:\w+ )?(?:ont |a )?change\w*|sur (?:le|ce|notre|un|leur|votre) (?:nouveau )?compte|compte ci-(?:joint|dessous|apres))\b/],
  ['virement', /\b(?:virements?|vire[rsz]?|virons|virent|transferts? de fonds|transfere[rsz]?|fonds(?! de commerce))\b/],
  ['acompte', /\b(?:acomptes?|arrhes|depots? de garantie)\b/],
  ['sequestre', /\b(?:sequestres?|consignation)\b/],
  ['paiement', /\b(?:paye[rsz]?|paie[sz]?|payons|paiements?|verse[rsz]?|versons|versements?|regle[rz]|reglons|regler la somme|reglement de la somme|frais a regler)\b/],
];

/** Les signaux d'argent d'un message reçu, dans un ordre fixe, sans rien garder du texte. */
export function fundSignals(text: string): FundSignal[] {
  const p = plain(text);
  const found: FundSignal[] = [];
  if (IBAN.test(text.replace(/\s+/g, ' '))) found.push('iban');
  for (const [signal, re] of INBOUND) if (re.test(p)) found.push(signal);
  return found;
}

const OUTGOING: RegExp[] = [
  /\b(?:rib|bic|swift|iban)\b/,
  /\b(?:nos|nouvelles|voici les|voici nos|ci-joint nos|ci-joint les) coordonnees bancaires\b/,
  /\b(?:sur le compte|a l'ordre de)\b/,
  /\b(?:veuillez|merci de|vous pouvez|pensez a|il vous faut|vous devez|il faut|je vous prie de|nous vous prions de)\s+(?:bien vouloir\s+)?(?:nous\s+)?(?:virer|verser|regler|payer|transferer|effectuer)\b/,
  // L'impératif direct : « payez », « versez », « virez », « réglez », « effectuez le virement ».
  /\b(?:payez|versez|virez|reglez|transferez|effectuez)\b/,
  /\b(?:le|un|votre) (?:virement|versement|paiement) (?:de|du|des|sur|a|avant)\b/,
];

/** Un texte d'AIMMO qui donne des coordonnées bancaires ou demande un paiement : jamais [R62]. */
export function fundsInOutgoing(text: string): boolean {
  if (IBAN.test(text.replace(/\s+/g, ' '))) return true;
  const p = plain(text);
  return OUTGOING.some((re) => re.test(p));
}

/** Le rappel au client, écrit par le code, sans chiffre ni coordonnée. */
export function fundsReminderText(firstName: string | null): string {
  return `${firstName ? `Bonjour ${firstName},` : 'Bonjour,'} un rappel important pour votre vente : votre agent immobilier ne vous demandera jamais de virement, d'acompte ni de changement de coordonnées bancaires, et ne reçoit jamais de fonds. L'argent de la vente passe seulement par le notaire. Au moindre doute sur un message, appelez votre notaire au numéro que vous connaissez déjà, avant tout paiement.`;
}

export interface FundAlert {
  messageId: string;
  fileId: string;
  propertyId: string;
  side: 'vendeur' | 'acquereur';
  signals: FundSignal[];
  createdAt: string;
  reminder: 'sent' | 'waiting' | 'refused' | 'failed' | null;
  reminderRule: string | null;
}

export class BouclierFonds {
  private readonly now: () => Date;
  private readonly unique: FicheUnique;
  private readonly controle: ControleEnvois;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    const fiches = new FicheClient(db, { now: this.now });
    this.unique = new FicheUnique(db, fiches, { now: this.now });
    this.controle = new ControleEnvois(db, this.unique, new DecisionEnvoi(db, fiches, this.unique, { now: this.now }), {
      channels: trialChannels(db, journal, this.now),
      journal: new SqlSendJournal(db, undefined, this.now),
      now: this.now,
    });
  }

  /**
   * Tous les dossiers en cours dont la personne est une partie, et de quel côté : une personne qui achète et vend à la
   * fois a deux dossiers, et chaque agent doit être prévenu.
   */
  private async filesOf(networkId: string, personId: string): Promise<{ id: string; property_id: string; agent_id: string; side: 'vendeur' | 'acquereur' }[]> {
    const ids = await this.unique.membersOf(personId);
    const marks = ids.map(() => '?').join(', ');
    const buyer = await this.db.all<{ id: string; property_id: string; agent_id: string | null }>(
      `SELECT f.id, f.property_id, p.agent_id FROM sale_files f JOIN properties p ON p.id = f.property_id
       WHERE f.network_id = ? AND p.status = 'under_offer' AND f.buyer_person_id IN (${marks}) ORDER BY f.opened_at, f.id`,
      [networkId, ...ids],
    );
    const seller = await this.db.all<{ id: string; property_id: string; agent_id: string | null }>(
      `SELECT f.id, f.property_id, p.agent_id FROM sale_files f JOIN properties p ON p.id = f.property_id
       WHERE f.network_id = ? AND p.status = 'under_offer'
       AND (SELECT m.person_id FROM mandates m WHERE m.network_id = f.network_id AND m.property_id = f.property_id ORDER BY m.signed_at DESC LIMIT 1) IN (${marks})
       ORDER BY f.opened_at, f.id`,
      [networkId, ...ids],
    );
    return [
      ...buyer.filter((f) => f.agent_id).map((f) => ({ id: f.id, property_id: f.property_id, agent_id: f.agent_id!, side: 'acquereur' as const })),
      ...seller.filter((f) => f.agent_id).map((f) => ({ id: f.id, property_id: f.property_id, agent_id: f.agent_id!, side: 'vendeur' as const })),
    ];
  }

  /**
   * Lit un message reçu, rangé dans `messages`. Rend les signaux trouvés, ou null s'il n'y a rien à faire (message
   * sortant, personne hors d'un dossier en cours, aucun signal). Une alerte par message et par dossier de la personne,
   * même lu deux fois [R18].
   */
  async scan(messageId: string): Promise<FundSignal[] | null> {
    const m = await this.db.first<{ id: string; network_id: string; person_id: string; direction: string; body: string }>('SELECT id, network_id, person_id, direction, body FROM messages WHERE id = ?', [messageId]);
    if (!m || m.direction !== 'in') return null;
    const signals = fundSignals(m.body);
    if (signals.length === 0) return null;
    const files = await this.filesOf(m.network_id, m.person_id);
    if (files.length === 0) return null;
    for (const file of files) {
      const { changes } = await this.db.run(
        "INSERT INTO sale_file_fund_alerts (message_id, file_id, network_id, agent_id, person_id, side, signals, created_at, reminder_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'waiting') ON CONFLICT (message_id, file_id) DO NOTHING",
        [m.id, file.id, m.network_id, file.agent_id, m.person_id, file.side, JSON.stringify(signals), this.now().toISOString()],
      );
      if (changes !== 1) continue;
      // Au journal : les sortes de signaux, jamais le texte, l'IBAN ni la coordonnée [R13, R15].
      await appendEvent(this.journal, { type: 'dossier.alerte_fonds', actor: 'system:dossiers', subject: `sale_file:${file.id}`, data: { rule: 'R62', message: `message:${m.id}`, side: file.side, signals } }, this.now);
    }
    for (const file of files) await this.remind(m.id, file.id);
    return signals;
  }

  /** Le rappel au client d'une alerte, par le contrôle central, en mode essai. */
  private async remind(messageId: string, fileId: string): Promise<void> {
    const a = await this.db.first<{ file_id: string; network_id: string; agent_id: string; person_id: string; reminder_status: string | null }>(
      'SELECT file_id, network_id, agent_id, person_id, reminder_status FROM sale_file_fund_alerts WHERE message_id = ? AND file_id = ?',
      [messageId, fileId],
    );
    if (!a || (a.reminder_status !== null && a.reminder_status !== 'waiting' && a.reminder_status !== 'failed')) return;
    const first = await this.db.first<{ first_name: string | null }>('SELECT first_name FROM persons WHERE id = ?', [a.person_id]);
    const text = fundsReminderText(first?.first_name ?? null);
    if (fundsInOutgoing(text)) throw new Error('Le rappel du bouclier ne peut pas porter de coordonnée bancaire [R62].');
    const r = await this.controle.send({
      networkId: a.network_id,
      agentId: a.agent_id,
      personId: a.person_id,
      channel: 'email',
      kind: 'follow_up',
      purpose: SALE_FOLLOW_UP_PURPOSE,
      // Une fois par personne et par dossier [R05].
      subject: `rappel_fonds:${a.file_id}`,
      fallbackTexts: [text],
      figures: [],
    });
    const status = r.status === 'sent' ? 'sent' : r.status === 'failed' ? 'failed' : r.rule === 'R01' ? 'waiting' : 'refused';
    await this.db.run('UPDATE sale_file_fund_alerts SET reminder_status = ?, reminder_rule = ? WHERE message_id = ? AND file_id = ?', [status, r.status === 'sent' ? null : r.rule, messageId, fileId]);
    await appendEvent(this.journal, { type: 'dossier.rappel_fonds', actor: 'system:dossiers', subject: `sale_file:${a.file_id}`, data: { mode: 'essai', status, rule: r.status === 'sent' ? null : r.rule } }, this.now);
  }

  /**
   * Le filet : relit les messages reçus du réseau depuis `since` (une lecture déjà faite n'ajoute rien), et reprend les
   * rappels qui attendaient l'heure ou sont restés sans issue après une panne. Rend le nombre d'alertes nouvelles.
   */
  async run(networkId: string, since: Date): Promise<number> {
    const before = (await this.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM sale_file_fund_alerts WHERE network_id = ?', [networkId]))!.n;
    const rows = await this.db.all<{ id: string }>("SELECT m.id FROM messages m WHERE m.network_id = ? AND m.direction = 'in' AND m.occurred_at >= ? ORDER BY m.occurred_at, m.id", [networkId, since.toISOString()]);
    for (const r of rows) await this.scan(r.id);
    for (const w of await this.db.all<{ message_id: string; file_id: string }>("SELECT message_id, file_id FROM sale_file_fund_alerts WHERE network_id = ? AND (reminder_status IS NULL OR reminder_status IN ('waiting', 'failed'))", [networkId])) await this.remind(w.message_id, w.file_id);
    return (await this.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM sale_file_fund_alerts WHERE network_id = ?', [networkId]))!.n - before;
  }

  /** Les alertes de l'agent, pour lui seul, sur les biens qu'il suit ; chaque lecture au journal [R16]. */
  async alertsOf(viewer: Viewer): Promise<{ ok: true; alerts: FundAlert[] } | FileRefusal> {
    const refuse = async (code: string): Promise<FileRefusal> => {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: actorOf(viewer), subject: null, data: { rule: 'R16', role: String(viewer.role), kind: 'sale_file_fund_alerts', code } }, this.now);
      return { ok: false, rule: 'R16', code };
    };
    if (viewer.role !== 'agent') return refuse('not_agent');
    const agent = await this.db.first<{ network_id: string; status: string }>('SELECT network_id, status FROM agents WHERE id = ?', [viewer.userId]);
    if (!agent || agent.network_id !== viewer.networkId || agent.status !== 'active') return refuse('agent_inactive');
    const rows = await this.db.all<{ message_id: string; file_id: string; property_id: string; side: 'vendeur' | 'acquereur'; signals: string; created_at: string; reminder_status: FundAlert['reminder']; reminder_rule: string | null }>(
      `SELECT a.message_id, a.file_id, f.property_id, a.side, a.signals, a.created_at, a.reminder_status, a.reminder_rule FROM sale_file_fund_alerts a
       JOIN sale_files f ON f.id = a.file_id JOIN properties p ON p.id = f.property_id
       WHERE a.network_id = ? AND p.agent_id = ? ORDER BY a.created_at DESC, a.message_id`,
      [viewer.networkId, viewer.userId],
    );
    const alerts = rows.map((r) => ({ messageId: r.message_id, fileId: r.file_id, propertyId: r.property_id, side: r.side, signals: JSON.parse(r.signals) as FundSignal[], createdAt: r.created_at, reminder: r.reminder_status, reminderRule: r.reminder_rule }));
    await appendEvent(this.journal, { type: 'dossier.alertes_fonds_lues', actor: actorOf(viewer), subject: `agent:${viewer.userId}`, data: { rule: 'R16', files: [...new Set(alerts.map((x) => `sale_file:${x.fileId}`))] } }, this.now);
    return { ok: true, alerts };
  }
}
