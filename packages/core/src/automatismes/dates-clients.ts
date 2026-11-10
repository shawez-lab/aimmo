/**
 * Dates des clients : anniversaire et fête (HX25).
 *
 * Jamais vu : un message de date n'est préparé que pour une date que la personne a elle-même donnée, rangée avec d'où
 * elle vient, et seulement si son accord « dates des clients » est rangé sur ce canal [R404]. Jamais la nuit ni le
 * dimanche : un passage hors des heures permises ne prépare rien, et une date tombée un dimanche est souhaitée le lundi
 * [R01, R405]. Un seul message par fiche gardée, par sorte de date et par an ; il part par le contrôle central des
 * envois, en mode essai : rien ne part vraiment [R26]. Le texte est fixe, écrit par la direction, jamais par l'IA
 * [R403]. Le journal ne garde ni date ni texte [R13]. Rien ne s'efface [R17].
 */
import { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import { trialChannels } from '../captation/essai.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { DEFAULT_SEND_SETTINGS } from '../envoi/decision.ts';
import { afterSendingTime, localTime, type SendingWindow } from '../envoi/horaires.ts';
import { SqlSendJournal } from '../envoi/journal-envois.ts';
import { DecisionEnvoi } from '../envoi/service.ts';
import { ControleEnvois } from '../envoi/controle.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { ficheFirstName } from '../fiche/prenom.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { AUTOMATION_CHANNELS, IDENTIFIER_FOR, checkFixedText, renderScenarioText, type AutomationChannel, type ScenarioResult } from './scenarios.ts';

/** Finalité de l'accord d'un message de date [R03, R404]. */
export const DATES_PURPOSE = 'dates_clients';
export const CLIENT_DATE_KINDS = ['anniversaire', 'fete'] as const;
export type ClientDateKind = (typeof CLIENT_DATE_KINDS)[number];
const MAX_TEXTS = 5;
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export interface DatesSettings {
  window: SendingWindow;
}

export const DEFAULT_DATES_SETTINGS: DatesSettings = Object.freeze({
  window: Object.freeze({
    timeZone: DEFAULT_SEND_SETTINGS.timeZone,
    initiativeFrom: DEFAULT_SEND_SETTINGS.initiativeFrom,
    initiativeUntil: DEFAULT_SEND_SETTINGS.initiativeUntil,
    initiativeDays: DEFAULT_SEND_SETTINGS.initiativeDays,
  }),
});

export interface DatesOptions {
  now?: () => Date;
  newId?: () => string;
  settings?: DatesSettings;
}

export interface DatesTickReport {
  /** Hors des heures permises : rien n'a été regardé ni préparé [R405]. */
  closed: boolean;
  messagesInTrial: number;
  refused: number;
  postponed: number;
  /** Dates du jour laissées sans message : pas d'accord en vigueur, personne exclue, ou aucun canal permis à la fois écrit et joignable [R404]. */
  withoutConsent: number;
}

interface DateRow {
  id: string;
  person_id: string;
  kind: ClientDateKind;
  month: number;
  day: number;
}

const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const marks = (n: number): string => Array.from({ length: n }, () => '?').join(', ');
const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** Le jour de l'année où l'on souhaite une date : un 29 février se souhaite le 28 les années sans 29 [R405]. */
export function occasionOf(month: number, day: number, year: number): string {
  const d = month === 2 && day === 29 && !isLeap(year) ? 28 : day;
  return `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const weekdayOf = (isoDay: string): number => {
  const w = new Date(`${isoDay}T12:00:00Z`).getUTCDay();
  return w === 0 ? 7 : w;
};
const shift = (isoDay: string, days: number): string => new Date(Date.parse(`${isoDay}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Les jours dont on souhaite les dates aujourd'hui : aujourd'hui, et les jours d'avant sans heure permise depuis le
 * dernier jour permis (le dimanche, souhaité le lundi). Jamais une date plus ancienne [R405].
 */
export function occasionDays(today: string, window: SendingWindow): string[] {
  const days = [today];
  let d = shift(today, -1);
  for (let i = 0; i < 7 && !window.initiativeDays.includes(weekdayOf(d)); i += 1) {
    days.push(d);
    d = shift(d, -1);
  }
  return days;
}

export class DatesClients {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly settings: DatesSettings;
  private readonly fiche: FicheUnique;
  private readonly controle: ControleEnvois;
  private readonly acces: Acces;
  private readonly decisions: DecisionEnvoi;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: DatesOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.settings = options.settings ?? DEFAULT_DATES_SETTINGS;
    const store = new FicheClient(db, { now: this.now });
    this.fiche = new FicheUnique(db, store, { now: this.now });
    this.acces = new Acces(db, store, this.fiche, journal, { now: this.now });
    const decisions = new DecisionEnvoi(db, store, this.fiche, { now: this.now });
    this.decisions = decisions;
    // Seuls les canaux du mode essai : aucun vrai canal ne peut être passé de l'extérieur [R26].
    this.controle = new ControleEnvois(db, this.fiche, decisions, { channels: trialChannels(db, journal, this.now), journal: new SqlSendJournal(db, undefined, this.now), now: this.now });
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse<T>(viewer: Viewer, code: string, gesture: string, rule = 'R16'): Promise<ScenarioResult<T>> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: null, data: { rule, role: String(viewer.role), kind: 'client_date', code, gesture } }, this.now);
    return { ok: false, rule, code };
  }

  /**
   * Range une date que la personne a donnée, avec d'où elle vient. Seuls l'agent qui suit la fiche et la direction
   * la rangent [R16, R404]. Une correction est une nouvelle ligne : la dernière compte.
   */
  async recordDate(viewer: Viewer, input: { personId: string; kind: unknown; month: unknown; day: unknown; proof: unknown }): Promise<ScenarioResult<{ dateId: string }>> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refuse(viewer, 'role', 'record');
    // La fiche lue sous droits : agent qui la suit, actif, au dossier complet, ou direction ; la lecture va au journal [R16, R82].
    const read = await this.acces.readFiche(viewer, input.personId);
    if (!read.ok) return { ok: false, rule: read.rule, code: read.code };
    const view = read.value;
    const person = { network_id: view.person.network_id };
    if (typeof input.kind !== 'string' || !(CLIENT_DATE_KINDS as readonly string[]).includes(input.kind)) return { ok: false, rule: 'R404', code: 'bad_kind' };
    if (!isInt(input.month, 1, 12) || !isInt(input.day, 1, DAYS_IN_MONTH[input.month - 1]!)) return { ok: false, rule: 'R404', code: 'bad_date' };
    // D'où vient la date : la personne l'a donnée. Jamais une date devinée, ni tirée d'une pièce d'identité [R404, R15].
    if (typeof input.proof !== 'string' || input.proof.trim() === '' || input.proof.length > 200) return { ok: false, rule: 'R404', code: 'no_proof' };
    const id = this.newId();
    await this.db.run('INSERT INTO client_dates (id, network_id, person_id, kind, month, day, proof, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      id,
      person.network_id,
      view.person.id,
      input.kind,
      input.month,
      input.day,
      input.proof.trim(),
      this.actor(viewer),
      this.now().toISOString(),
    ]);
    await appendEvent(this.journal, { type: 'dates.rangee', actor: this.actor(viewer), subject: `person:${view.person.id}`, data: { rule: 'R404', kind: input.kind } }, this.now);
    return { ok: true, value: { dateId: id } };
  }

  /** Les textes d'une sorte de date et d'un canal, écrits par la direction : de 1 à 5, chacun contrôlé [R403, R405]. */
  async setTexts(viewer: Viewer, input: { kind: unknown; channel: unknown; texts: unknown }): Promise<ScenarioResult<{ seq: number }>> {
    if (viewer.role !== 'direction') return this.refuse(viewer, 'not_direction', 'texts');
    if (typeof input.kind !== 'string' || !(CLIENT_DATE_KINDS as readonly string[]).includes(input.kind)) return { ok: false, rule: 'R405', code: 'bad_kind' };
    if (typeof input.channel !== 'string' || !(AUTOMATION_CHANNELS as readonly string[]).includes(input.channel)) return { ok: false, rule: 'R405', code: 'bad_channel' };
    if (!Array.isArray(input.texts) || input.texts.length < 1 || input.texts.length > MAX_TEXTS) return { ok: false, rule: 'R405', code: 'bad_texts' };
    const texts: string[] = [];
    for (const t of input.texts) {
      const checked = checkFixedText(input.channel as AutomationChannel, t, 'R405');
      if (!checked.ok) return checked;
      texts.push(checked.value);
    }
    const last = await this.db.first<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM client_date_texts WHERE network_id = ? AND kind = ? AND channel = ?', [viewer.networkId, input.kind, input.channel]);
    const seq = (last?.seq ?? 0) + 1;
    await this.db.run('INSERT INTO client_date_texts (id, network_id, kind, channel, texts, seq, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      this.newId(),
      viewer.networkId,
      input.kind,
      input.channel,
      JSON.stringify(texts),
      seq,
      this.actor(viewer),
      this.now().toISOString(),
    ]);
    await appendEvent(this.journal, { type: 'dates.textes', actor: this.actor(viewer), subject: null, data: { rule: 'R405', kind: input.kind, channel: input.channel, seq, count: texts.length } }, this.now);
    return { ok: true, value: { seq } };
  }

  private async textsOf(networkId: string, kind: ClientDateKind, channel: AutomationChannel): Promise<string[] | null> {
    const row = await this.db.first<{ texts: string }>('SELECT texts FROM client_date_texts WHERE network_id = ? AND kind = ? AND channel = ? ORDER BY seq DESC LIMIT 1', [networkId, kind, channel]);
    return row ? (JSON.parse(row.texts) as string[]) : null;
  }

  /**
   * Un passage : prépare les messages de date du jour, par le contrôle central, en mode essai. Hors des heures permises
   * (la nuit, le dimanche), il ne prépare rien [R01, R405].
   */
  async tick(networkId: string): Promise<DatesTickReport> {
    const report: DatesTickReport = { closed: false, messagesInTrial: 0, refused: 0, postponed: 0, withoutConsent: 0 };
    const now = this.now();
    if (afterSendingTime(now, 0, this.settings.window).getTime() > now.getTime()) return { ...report, closed: true };
    const local = localTime(now, this.settings.window.timeZone);
    const wanted = occasionDays(local.date, this.settings.window);
    // L'ordre où les dates ont été rangées, même à la même milliseconde : le numéro de ligne, jamais l'identifiant [R404].
    const rows = await this.db.all<DateRow>('SELECT id, person_id, kind, month, day FROM client_dates WHERE network_id = ? ORDER BY created_at, rowid', [networkId]);
    // La dernière date rangée compte, par fiche gardée et par sorte : une correction remplace l'ancienne [R404].
    const latest = new Map<string, DateRow & { root: string }>();
    for (const r of rows) {
      const root = await this.fiche.rootOf(r.person_id);
      latest.set(`${root}|${r.kind}`, { ...r, root });
    }
    for (const d of latest.values()) {
      // L'année est celle du jour souhaité : un 31 décembre tombé un dimanche se souhaite le 1er janvier, pour son année [R405].
      const occasion = wanted.find((day) => occasionOf(d.month, d.day, Number(day.slice(0, 4))) === day);
      if (occasion === undefined) continue;
      const year = Number(occasion.slice(0, 4));
      const members = await this.fiche.membersOf(d.root);
      let channel: AutomationChannel | null = null;
      let texts: string[] | null = null;
      // Les coordonnées de toutes les fiches réunies : un canal où la personne n'est pas joignable n'est jamais pris, sinon
      // le contrôle central le refuserait et la place de l'année serait perdue alors qu'un autre canal permis servait [R404].
      const kinds = new Set((await this.fiche.view(d.root)).identifiers.map((i) => i.kind as string));
      for (const c of AUTOMATION_CHANNELS) {
        if (!IDENTIFIER_FOR[c].some((k) => kinds.has(k))) continue;
        // La même décision que le contrôle central, lue sans rien écrire : l'accord « dates des clients » en vigueur sur
        // ce canal, toutes fiches réunies et retraits compris, et aucune exclusion [R03, R02, R04, R404].
        const decision = await this.decisions.decide(d.root, { channel: c, kind: 'follow_up', purpose: DATES_PURPOSE, conversationId: null, at: now });
        if (!decision.allowed) continue;
        const t = await this.textsOf(networkId, d.kind, c);
        if (t) {
          channel = c;
          texts = t;
          break;
        }
      }
      // Sans accord en vigueur, exclue, sans texte ou sans coordonnée pour un canal permis : rien n'est préparé, aucune place
      // n'est prise [R404].
      if (channel === null || texts === null) {
        report.withoutConsent += 1;
        continue;
      }
      // Prendre la place de l'année : de deux passages en même temps, un seul prépare [R18]. Une place reportée se reprend.
      const createdAt = now.toISOString();
      const taken = await this.db.run(
        "INSERT OR IGNORE INTO client_date_messages (network_id, person_id, kind, year, date_id, status, created_at) VALUES (?, ?, ?, ?, ?, 'en_cours', ?)",
        [networkId, d.root, d.kind, year, d.id, createdAt],
      );
      if (taken.changes !== 1) {
        const retaken = await this.db.run(
          "UPDATE client_date_messages SET status = 'en_cours', created_at = ? WHERE network_id = ? AND person_id = ? AND kind = ? AND year = ? AND status = 'reporte'",
          [createdAt, networkId, d.root, d.kind, year],
        );
        if (retaken.changes !== 1) continue;
      }
      // Une place prise avant une réunion de fiches, sous une autre fiche de la personne, compte aussi [R405].
      const others = await this.db.first<{ n: number }>(
        `SELECT 1 AS n FROM client_date_messages WHERE network_id = ? AND kind = ? AND year = ? AND person_id IN (${marks(members.length)}) AND person_id <> ? LIMIT 1`,
        [networkId, d.kind, year, ...members, d.root],
      );
      if (others) {
        await this.finish(networkId, d, year, 'refuse', 'R405', null);
        report.refused += 1;
        continue;
      }
      let result;
      try {
        const firstName = await ficheFirstName(this.db, members);
        result = await this.controle.send({
          networkId,
          agentId: (await this.db.first<{ agent_id: string | null }>('SELECT agent_id FROM persons WHERE id = ?', [d.root]))?.agent_id ?? null,
          personId: d.root,
          channel,
          kind: 'follow_up',
          purpose: DATES_PURPOSE,
          subject: `date:${d.kind}:${year}`,
          fallbackTexts: texts.map((t) => renderScenarioText(t, firstName)),
          figures: [],
        });
      } catch (error) {
        // Une panne rend la place : le passage suivant reprend, l'erreur remonte, jamais avalée.
        await this.db.run("UPDATE client_date_messages SET status = 'reporte' WHERE network_id = ? AND person_id = ? AND kind = ? AND year = ? AND status = 'en_cours'", [networkId, d.root, d.kind, year]);
        throw error;
      }
      // Refusé pour l'heure seulement (passé 20 h pendant le passage) : reporté au prochain passage permis [R01].
      if (result.status === 'refused' && result.rule === 'R01') {
        await this.db.run("UPDATE client_date_messages SET status = 'reporte' WHERE network_id = ? AND person_id = ? AND kind = ? AND year = ? AND status = 'en_cours'", [networkId, d.root, d.kind, year]);
        report.postponed += 1;
        continue;
      }
      const delivered = result.messageId !== null && (await this.db.first<{ n: number }>('SELECT 1 AS n FROM trial_outbox WHERE message_id = ?', [result.messageId])) !== null;
      await this.finish(networkId, d, year, delivered ? 'essai' : 'refuse', delivered ? null : (result.rule ?? result.status), result.messageId);
      if (delivered) report.messagesInTrial += 1;
      else report.refused += 1;
    }
    return report;
  }

  private async finish(networkId: string, d: DateRow & { root: string }, year: number, status: 'essai' | 'refuse', rule: string | null, messageId: string | null): Promise<void> {
    await this.db.run(
      "UPDATE client_date_messages SET status = ?, rule = ?, message_id = ?, done_at = ? WHERE network_id = ? AND person_id = ? AND kind = ? AND year = ? AND status = 'en_cours'",
      [status, rule, messageId, this.now().toISOString(), networkId, d.root, d.kind, year],
    );
    await appendEvent(this.journal, { type: 'dates.message', actor: 'system:dates', subject: `person:${d.root}`, data: { rule: 'R405', kind: d.kind, mode: 'essai', status, messageRule: rule } }, this.now);
  }
}
