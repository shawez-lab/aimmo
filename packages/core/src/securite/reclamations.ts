/**
 * Réclamations des clients et médiateur de la consommation (Sécurité et conformité, HX58) [R13, R16, R17, R606, R607].
 *
 * L'agent du client, ou la direction, range chaque réclamation avec le jour où elle est arrivée. La base écrit son
 * échéance (le délai de réponse du réglage du réseau, 30 jours sans réglage) et refuse toute réponse antidatée. Le
 * passage de chaque heure range les alertes de l'échéance (7 jours avant, 2 jours avant, le jour même), une de chaque
 * sorte, pour l'agent et la direction, tant qu'aucune réponse n'est donnée.
 *
 * Jamais vu : le médiateur est proposé de lui-même au client, sans attendre qu'on y pense, dès que la réclamation n'est
 * pas réglée à l'échéance, ou dès qu'une réponse « non réglée » est rangée. Le texte est écrit par le code, sans IA,
 * avec le nom et le site du médiateur du réglage, et passe par le contrôle central des envois, en réponse dans la
 * conversation de la réclamation ; quand il ne peut pas partir (courrier, réclamation orale, envoi refusé), il est
 * rangé « à remettre » avec une alerte à l'agent, qui note ensuite qu'il l'a remis.
 *
 * Décidé, lecture prudente :
 * - « réglée » veut dire que le client est d'accord avec la réponse ; tout le reste est « non réglé » ;
 * - une réponse réglée après l'échéance ne retire pas la proposition déjà faite ; elle est notée en retard ;
 * - sans médiateur réglé (H09, adhésion à la création de la société), rien n'est inventé : une alerte
 *   « médiateur manquant » va à la direction, et la proposition part au premier passage qui suit le réglage ;
 * - le délai de réponse par défaut (30 jours) et le texte de la proposition attendent la relecture de l'avocat ;
 * - au journal, des codes sous la référence de la réclamation, jamais le motif, la réponse ni le texte [R13].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { ScheduledJob } from '../bascule/planificateur.ts';
import { trialChannels } from '../captation/essai.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { Channel } from '../db/types.ts';
import { ControleEnvois, type SendOrder, type SendResult } from '../envoi/controle.ts';
import { localTime } from '../envoi/horaires.ts';
import { SqlSendJournal } from '../envoi/journal-envois.ts';
import { DecisionEnvoi } from '../envoi/service.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

const TIME_ZONE = 'Europe/Paris';
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Le délai de réponse sans réglage, en jours. */
export const DEFAULT_COMPLAINT_RESPONSE_DAYS = 30;
export const COMPLAINT_RECEIVED_BY = ['mail', 'courrier', 'message', 'oral'] as const;
export type ComplaintReceivedBy = (typeof COMPLAINT_RECEIVED_BY)[number];
export const COMPLAINT_REPLY_CHANNELS: readonly Channel[] = ['email', 'sms', 'whatsapp', 'instagram', 'facebook'];
export type ComplaintOutcome = 'reglee' | 'non_reglee';
export type ComplaintAlertKind = 'j7' | 'j2' | 'echeance' | 'mediateur_manquant' | 'a_remettre';
export type ComplaintStatus = 'ouverte' | 'reglee' | 'non_reglee';

export interface Complaint {
  complaintId: string;
  personId: string;
  agentId: string | null;
  receivedOn: string;
  receivedBy: ComplaintReceivedBy;
  summary: string;
  responseDays: number;
  dueOn: string;
  status: ComplaintStatus;
  answer: { outcome: ComplaintOutcome; note: string; answeredOn: string; late: boolean } | null;
  alerts: { kind: ComplaintAlertKind; createdOn: string }[];
  mediator: { cause: 'echeance' | 'non_reglee'; status: 'envoye' | 'a_remettre' | 'remis'; text: string; createdOn: string; sendRule: string | null } | null;
}

export type ComplaintRefusal = { ok: false; rule: 'R16' | 'R606' | 'R607' | null; code: string };

/** Le texte de la proposition du médiateur : écrit par le code, sans IA, sans chiffre ni date ; « sans frais », jamais « gratuit » [R07]. */
export function mediatorOfferText(mediator: { name: string; site: string }, firstName?: string | null): string {
  const hello = firstName && firstName.trim() !== '' ? `Bonjour ${firstName.trim()}, ` : 'Bonjour, ';
  return (
    `${hello}votre réclamation n’a pas pu être réglée. ` +
    `Vous pouvez saisir, sans frais pour vous, le médiateur de la consommation de notre réseau : ${mediator.name}, ${mediator.site}. ` +
    'Vous avez un an à compter de votre réclamation écrite pour le faire.'
  );
}

/** Le jour de Paris `days` jours après `day`. */
function addDays(day: string, days: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

interface ComplaintRow {
  id: string;
  network_id: string;
  person_id: string;
  agent_id: string | null;
  received_on: string;
  received_via: ComplaintReceivedBy;
  reply_channel: Channel | null;
  conversation_id: string | null;
  summary: string;
  response_days: number;
  due_on: string;
}

interface Settings {
  version: number;
  response_days: number;
  mediator_name: string;
  mediator_site: string;
}

type Sender = (order: SendOrder) => Promise<SendResult>;

export class Reclamations {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly send: Sender;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string; send?: Sender } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    if (options.send) {
      this.send = options.send;
    } else {
      // Les seuls canaux du mode essai : rangé dans la boîte d'essai, jamais envoyé [R26].
      const store = new FicheClient(db, { now: this.now });
      const fiche = new FicheUnique(db, store, { now: this.now });
      const controle = new ControleEnvois(db, fiche, new DecisionEnvoi(db, store, fiche, { now: this.now }), {
        channels: trialChannels(db, journal, this.now),
        journal: new SqlSendJournal(db, undefined, this.now),
        now: this.now,
      });
      this.send = (order) => controle.send(order);
    }
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private today(): string {
    return localTime(this.now(), TIME_ZONE).date;
  }

  private async refuse(viewer: Viewer, code: string): Promise<ComplaintRefusal> {
    await appendEvent(
      this.journal,
      { type: 'acces.refuse', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'reclamation', code } },
      this.now,
    );
    return { ok: false, rule: 'R16', code };
  }

  private async settings(networkId: string): Promise<Settings | null> {
    return this.db.first<Settings>(
      'SELECT version, response_days, mediator_name, mediator_site FROM complaint_settings WHERE network_id = ? ORDER BY version DESC LIMIT 1',
      [networkId],
    );
  }

  /** La direction règle le délai de réponse et le médiateur, par une nouvelle version. */
  async configure(viewer: Viewer, input: { responseDays: unknown; mediatorName: unknown; mediatorSite: unknown }): Promise<{ ok: true; version: number } | ComplaintRefusal> {
    if (viewer.role !== 'direction') return this.refuse(viewer, 'role');
    const days = input.responseDays;
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 60) return { ok: false, rule: null, code: 'bad_days' };
    if (typeof input.mediatorName !== 'string' || input.mediatorName.trim() === '' || input.mediatorName.trim().length > 120) return { ok: false, rule: null, code: 'bad_mediator' };
    let site: URL | null = null;
    try {
      site = typeof input.mediatorSite === 'string' ? new URL(input.mediatorSite) : null;
    } catch {
      site = null;
    }
    if (!site || site.protocol !== 'https:' || site.username || site.password || (input.mediatorSite as string).length > 200) return { ok: false, rule: null, code: 'bad_site' };
    const last = await this.settings(viewer.networkId);
    const version = (last?.version ?? 0) + 1;
    await this.db.run(
      'INSERT INTO complaint_settings (network_id, version, response_days, mediator_name, mediator_site, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [viewer.networkId, version, days, input.mediatorName.trim(), input.mediatorSite as string, this.actor(viewer), this.now().toISOString()],
    );
    await appendEvent(this.journal, { type: 'reclamation.reglage', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R607', version, days } }, this.now);
    return { ok: true, version };
  }

  /** L'agent qui suit la fiche (vue complète), ou la direction, range une réclamation. */
  async record(
    viewer: Viewer,
    personId: string,
    input: { receivedOn: unknown; receivedBy: unknown; summary: unknown; reply?: { channel: unknown; conversationId: unknown } | null },
  ): Promise<{ ok: true; value: Complaint } | ComplaintRefusal> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refuse(viewer, 'role');
    const read = await this.acces.readFiche(viewer, personId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (viewer.role === 'agent' && read.view !== 'full') return this.refuse(viewer, 'not_assigned');
    const today = this.today();
    if (typeof input.receivedOn !== 'string' || !DAY.test(input.receivedOn) || new Date(`${input.receivedOn}T12:00:00Z`).toISOString().slice(0, 10) !== input.receivedOn) {
      return { ok: false, rule: null, code: 'bad_date' };
    }
    if (input.receivedOn > today) return { ok: false, rule: null, code: 'future_date' };
    if (!COMPLAINT_RECEIVED_BY.includes(input.receivedBy as ComplaintReceivedBy)) return { ok: false, rule: null, code: 'bad_received_via' };
    if (typeof input.summary !== 'string' || input.summary.trim() === '' || input.summary.length > 2000) return { ok: false, rule: null, code: 'bad_summary' };
    let channel: Channel | null = null;
    let conversationId: string | null = null;
    if (input.reply) {
      if (input.receivedBy !== 'mail' && input.receivedBy !== 'message') return { ok: false, rule: null, code: 'bad_reply' };
      if (!COMPLAINT_REPLY_CHANNELS.includes(input.reply.channel as Channel)) return { ok: false, rule: null, code: 'bad_reply' };
      if (typeof input.reply.conversationId !== 'string' || input.reply.conversationId.length < 1 || input.reply.conversationId.length > 200) return { ok: false, rule: null, code: 'bad_reply' };
      channel = input.reply.channel as Channel;
      conversationId = input.reply.conversationId;
    }
    const person = await this.db.first<{ agent_id: string | null }>('SELECT agent_id FROM persons WHERE id = ? AND network_id = ?', [personId, viewer.networkId]);
    if (!person) return { ok: false, rule: null, code: 'unknown_person' };
    const days = (await this.settings(viewer.networkId))?.response_days ?? DEFAULT_COMPLAINT_RESPONSE_DAYS;
    const id = this.newId();
    await this.db.run(
      `INSERT INTO complaints (id, network_id, person_id, agent_id, received_on, received_via, reply_channel, conversation_id, summary, response_days, due_on, recorded_by, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, viewer.networkId, personId, person.agent_id, input.receivedOn, input.receivedBy as string, channel, conversationId, input.summary.trim(), days, addDays(input.receivedOn, days), this.actor(viewer), this.now().toISOString()],
    );
    await appendEvent(this.journal, { type: 'reclamation.rangee', actor: this.actor(viewer), subject: `complaint:${id}`, data: { rule: 'R606', days } }, this.now);
    // Une réclamation rangée en retard peut être déjà à l'échéance : ses alertes et le médiateur passent aussitôt.
    await this.tick(viewer.networkId);
    return { ok: true, value: (await this.load(id))! };
  }

  /** Peut-il agir sur cette réclamation ? La direction du réseau, ou l'agent qui suit la fiche. */
  private async allowed(viewer: Viewer, row: ComplaintRow): Promise<boolean> {
    if (viewer.role === 'direction') return true;
    if (viewer.role !== 'agent') return false;
    const read = await this.acces.readFiche(viewer, row.person_id);
    return read.ok && read.view === 'full';
  }

  private async row(networkId: string, complaintId: string): Promise<ComplaintRow | null> {
    return this.db.first<ComplaintRow>('SELECT * FROM complaints WHERE id = ? AND network_id = ?', [complaintId, networkId]);
  }

  /** La réponse, une fois : réglée (le client est d'accord) ou non réglée, avec une note. */
  async answer(viewer: Viewer, complaintId: string, input: { outcome: unknown; note: unknown }): Promise<{ ok: true; value: Complaint } | ComplaintRefusal> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refuse(viewer, 'role');
    const row = await this.row(viewer.networkId, complaintId);
    if (!row) return { ok: false, rule: null, code: 'unknown_complaint' };
    if (!(await this.allowed(viewer, row))) return this.refuse(viewer, 'not_assigned');
    if (input.outcome !== 'reglee' && input.outcome !== 'non_reglee') return { ok: false, rule: null, code: 'bad_outcome' };
    if (typeof input.note !== 'string' || input.note.trim() === '' || input.note.length > 2000) return { ok: false, rule: null, code: 'bad_note' };
    const today = this.today();
    const late = today > row.due_on;
    const { changes } = await this.db.run(
      `INSERT INTO complaint_answers (complaint_id, network_id, outcome, note, answered_on, late, answered_by, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (complaint_id) DO NOTHING`,
      [complaintId, viewer.networkId, input.outcome, input.note.trim(), today, late ? 1 : 0, this.actor(viewer), this.now().toISOString()],
    );
    if (changes === 0) return { ok: false, rule: null, code: 'already_answered' };
    await appendEvent(this.journal, { type: 'reclamation.reponse', actor: this.actor(viewer), subject: `complaint:${complaintId}`, data: { rule: 'R606', outcome: input.outcome, late } }, this.now);
    if (input.outcome === 'non_reglee') await this.tick(viewer.networkId);
    return { ok: true, value: (await this.load(complaintId))! };
  }

  /** L'agent note qu'il a remis lui-même la proposition du médiateur au client. */
  async handed(viewer: Viewer, complaintId: string): Promise<{ ok: true; value: Complaint } | ComplaintRefusal> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refuse(viewer, 'role');
    const row = await this.row(viewer.networkId, complaintId);
    if (!row) return { ok: false, rule: null, code: 'unknown_complaint' };
    if (!(await this.allowed(viewer, row))) return this.refuse(viewer, 'not_assigned');
    const { changes } = await this.db.run(
      "UPDATE complaint_mediator_offers SET status = 'remis', handed_at = ?, handed_by = ? WHERE complaint_id = ? AND status = 'a_remettre'",
      [this.now().toISOString(), this.actor(viewer), complaintId],
    );
    if (changes === 0) return { ok: false, rule: null, code: 'nothing_to_hand' };
    await appendEvent(this.journal, { type: 'reclamation.mediateur_remis', actor: this.actor(viewer), subject: `complaint:${complaintId}`, data: { rule: 'R607' } }, this.now);
    return { ok: true, value: (await this.load(complaintId))! };
  }

  private async alert(row: ComplaintRow, kind: ComplaintAlertKind, today: string): Promise<void> {
    const { changes } = await this.db.run(
      'INSERT INTO complaint_alerts (complaint_id, network_id, kind, created_on, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (complaint_id, kind) DO NOTHING',
      [row.id, row.network_id, kind, today, this.now().toISOString()],
    );
    if (changes > 0) {
      await appendEvent(this.journal, { type: 'reclamation.alerte', actor: 'system:reclamations', subject: `complaint:${row.id}`, data: { rule: kind === 'a_remettre' || kind === 'mediateur_manquant' ? 'R607' : 'R606', kind } }, this.now);
    }
  }

  /**
   * Le passage : pour chaque réclamation du réseau sans proposition du médiateur, les alertes dues, puis le médiateur
   * à l'échéance sans réponse réglée, ou après une réponse non réglée.
   */
  async tick(networkId: string): Promise<{ alerts: number; offers: number }> {
    const today = this.today();
    let alerts = 0;
    let offers = 0;
    const rows = await this.db.all<ComplaintRow & { outcome: ComplaintOutcome | null; answered_on: string | null }>(
      `SELECT c.*, a.outcome, a.answered_on FROM complaints c LEFT JOIN complaint_answers a ON a.complaint_id = c.id
       WHERE c.network_id = ? AND NOT EXISTS (SELECT 1 FROM complaint_mediator_offers o WHERE o.complaint_id = c.id)
       ORDER BY c.due_on, c.id`,
      [networkId],
    );
    for (const row of rows) {
      const settled = row.outcome === 'reglee' && row.answered_on !== null && row.answered_on <= row.due_on;
      if (settled) continue;
      if (row.outcome === null) {
        const before = await this.db.first<{ n: number }>('SELECT count(*) AS n FROM complaint_alerts WHERE complaint_id = ?', [row.id]);
        if (today >= addDays(row.due_on, -7)) await this.alert(row, 'j7', today);
        if (today >= addDays(row.due_on, -2)) await this.alert(row, 'j2', today);
        if (today >= row.due_on) await this.alert(row, 'echeance', today);
        const after = await this.db.first<{ n: number }>('SELECT count(*) AS n FROM complaint_alerts WHERE complaint_id = ?', [row.id]);
        alerts += (after?.n ?? 0) - (before?.n ?? 0);
      }
      const cause = row.outcome === 'non_reglee' ? 'non_reglee' : today >= row.due_on ? 'echeance' : null;
      if (cause === null) continue;
      const settings = await this.settings(networkId);
      if (!settings) {
        await this.alert(row, 'mediateur_manquant', today);
        continue;
      }
      if (await this.offer(row, cause, settings, today)) offers++;
    }
    return { alerts, offers };
  }

  /** La proposition du médiateur, une fois : par le contrôle central quand elle le peut, sinon à remettre par l'agent. */
  private async offer(row: ComplaintRow, cause: 'echeance' | 'non_reglee', settings: Settings, today: string): Promise<boolean> {
    // Vouvoiement avec le prénom, comme tout premier message [R08].
    const person = await this.db.first<{ first_name: string | null }>('SELECT first_name FROM persons WHERE id = ?', [row.person_id]);
    const text = mediatorOfferText({ name: settings.mediator_name, site: settings.mediator_site }, person?.first_name ?? null);
    // La proposition est d'abord réservée : un passage rejoué ou simultané n'envoie jamais deux fois.
    const { changes } = await this.db.run(
      `INSERT INTO complaint_mediator_offers (complaint_id, network_id, cause, settings_version, text, status, send_rule, created_on, created_at)
       VALUES (?, ?, ?, ?, ?, 'a_remettre', NULL, ?, ?) ON CONFLICT (complaint_id) DO NOTHING`,
      [row.id, row.network_id, cause, settings.version, text, today, this.now().toISOString()],
    );
    if (changes === 0) return false;
    await appendEvent(this.journal, { type: 'reclamation.mediateur', actor: 'system:reclamations', subject: `complaint:${row.id}`, data: { rule: 'R607', cause } }, this.now);
    let result: SendResult | null = null;
    if (row.reply_channel !== null && row.conversation_id !== null) {
      result = await this.send({
        networkId: row.network_id,
        agentId: row.agent_id,
        personId: row.person_id,
        conversationId: row.conversation_id,
        channel: row.reply_channel,
        kind: 'reply',
        fallbackTexts: [text],
      });
    }
    if (result !== null) {
      await this.db.run(
        "UPDATE complaint_mediator_offers SET status = ?, send_rule = ? WHERE complaint_id = ? AND status = 'a_remettre' AND send_rule IS NULL",
        [result.status === 'sent' ? 'envoye' : 'a_remettre', result.status === 'sent' ? (result.rule ?? 'envoye') : (result.rule ?? result.status), row.id],
      );
      await appendEvent(this.journal, { type: 'reclamation.mediateur_envoi', actor: 'system:reclamations', subject: `complaint:${row.id}`, data: { rule: 'R607', status: result.status, sendRule: result.rule ?? null } }, this.now);
      if (result.status === 'sent') return true;
    }
    await this.alert(row, 'a_remettre', today);
    return true;
  }

  private async load(complaintId: string): Promise<Complaint | null> {
    const row = await this.db.first<ComplaintRow>('SELECT * FROM complaints WHERE id = ?', [complaintId]);
    if (!row) return null;
    const a = await this.db.first<{ outcome: ComplaintOutcome; note: string; answered_on: string; late: number }>(
      'SELECT outcome, note, answered_on, late FROM complaint_answers WHERE complaint_id = ?',
      [complaintId],
    );
    const alerts = await this.db.all<{ kind: ComplaintAlertKind; created_on: string }>(
      "SELECT kind, created_on FROM complaint_alerts WHERE complaint_id = ? ORDER BY CASE kind WHEN 'j7' THEN 1 WHEN 'j2' THEN 2 WHEN 'echeance' THEN 3 WHEN 'mediateur_manquant' THEN 4 ELSE 5 END",
      [complaintId],
    );
    const o = await this.db.first<{ cause: 'echeance' | 'non_reglee'; status: 'envoye' | 'a_remettre' | 'remis'; text: string; created_on: string; send_rule: string | null }>(
      'SELECT cause, status, text, created_on, send_rule FROM complaint_mediator_offers WHERE complaint_id = ?',
      [complaintId],
    );
    return {
      complaintId: row.id,
      personId: row.person_id,
      agentId: row.agent_id,
      receivedOn: row.received_on,
      receivedBy: row.received_via,
      summary: row.summary,
      responseDays: row.response_days,
      dueOn: row.due_on,
      status: a ? a.outcome : 'ouverte',
      answer: a ? { outcome: a.outcome, note: a.note, answeredOn: a.answered_on, late: a.late === 1 } : null,
      alerts: alerts.map((x) => ({ kind: x.kind, createdOn: x.created_on })),
      mediator: o ? { cause: o.cause, status: o.status, text: o.text, createdOn: o.created_on, sendRule: o.send_rule } : null,
    };
  }

  /** Les réclamations : la direction voit celles du réseau, l'agent celles des fiches qu'il suit ; l'échéance la plus proche d'abord. */
  async list(viewer: Viewer): Promise<{ ok: true; value: Complaint[] } | ComplaintRefusal> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refuse(viewer, 'role');
    const rows = await this.db.all<ComplaintRow>('SELECT * FROM complaints WHERE network_id = ? ORDER BY due_on, id', [viewer.networkId]);
    const out: Complaint[] = [];
    for (const row of rows) if (await this.allowed(viewer, row)) out.push((await this.load(row.id))!);
    return { ok: true, value: out };
  }
}

/** Le nom du passage des réclamations, sans donnée. */
export const COMPLAINTS_JOB = 'securite.reclamations';

/** Le passage des réclamations, de 9 h à 19 h, du lundi au samedi, pour chaque réseau. */
export function complaintsJob(db: SqlDatabase, journal: JournalStore, acces: Acces, options: { now?: () => Date } = {}): ScheduledJob {
  return {
    name: COMPLAINTS_JOB,
    hours: [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
    weekdays: [1, 2, 3, 4, 5, 6],
    run: async () => {
      const r = new Reclamations(db, acces, journal, options.now ? { now: options.now } : {});
      let failure: unknown = null;
      for (const n of await db.all<{ network_id: string }>('SELECT DISTINCT network_id FROM complaints ORDER BY network_id')) {
        try {
          await r.tick(n.network_id);
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure !== null) throw failure;
    },
  };
}
