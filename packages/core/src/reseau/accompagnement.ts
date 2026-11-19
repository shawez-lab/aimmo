/**
 * Référent des 90 jours, binôme d'absence et assistance suivie (M14, J09).
 *
 * - La direction attribue à chaque nouvel agent un référent, un autre agent actif, pour 90 jours.
 * - Deux agents forment un binôme, avec le partage des honoraires de l'agent qui reprend écrit d'avance ; un partage
 *   écrit ne change plus, un nouveau s'ajoute [R17].
 * - Une absence se déclare avec un binôme dont le partage était écrit avant elle. Pendant l'absence, et seulement
 *   pendant, le binôme lit les dossiers en cours de l'absent ; après, plus rien [R16]. Le branchement dans les droits
 *   d'accès du socle vient avec J13 (`Accompagnement.coversAt`).
 * - Une demande d'assistance est suivie avec son délai, calculé par le code en heures ouvrées (jours ouvrés, de 9 h à
 *   18 h, heure de Paris) : 2 h pour un humain du réseau, 48 h pour l'avocat. La direction est prévenue avant
 *   l'échéance, puis à l'échéance dépassée, une seule fois chaque. Une demande ne porte aucune donnée de client : une
 *   coordonnée, une fiche ou un compte sont refusés, d'abord pour l'avocat [R15].
 * Au journal, des identifiants et des nombres [R13]. Rien n'est envoyé ici : les alertes vont au planificateur (J13).
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { isWorkingDay, localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { citesClientData } from './entrainement.ts';

const TIME_ZONE = 'Europe/Paris';
export const REFERENT_DAYS = 90;

export const ASSISTANCE_LEVELS = ['humain', 'avocat'] as const;
export type AssistanceLevel = (typeof ASSISTANCE_LEVELS)[number];
export const ASSISTANCE_TOPICS = ['mandat', 'offre', 'compromis', 'conformite', 'outil', 'autre'] as const;
export type AssistanceTopic = (typeof ASSISTANCE_TOPICS)[number];

export interface AssistanceSettings {
  /** Heures ouvrées avant l'échéance, par niveau. */
  hours: Readonly<Record<AssistanceLevel, number>>;
  /** Minutes ouvrées avant l'échéance où la direction est prévenue. */
  alertBeforeMinutes: Readonly<Record<AssistanceLevel, number>>;
  /** Fenêtre des heures ouvrées, en minutes depuis minuit, heure de Paris. */
  workFrom: number;
  workUntil: number;
}

export const ASSISTANCE_SETTINGS: Readonly<AssistanceSettings> = Object.freeze({
  hours: Object.freeze({ humain: 2, avocat: 48 }),
  alertBeforeMinutes: Object.freeze({ humain: 30, avocat: 240 }),
  workFrom: 9 * 60,
  workUntil: 18 * 60,
});

/**
 * L'instant où `minutes` minutes ouvrées se sont écoulées depuis `start` : jours ouvrés seulement (ni samedi, ni
 * dimanche, ni jour férié), dans la fenêtre réglée, heure de Paris, changements d'heure compris.
 */
export function addWorkingMinutes(start: Date, minutes: number, settings: Pick<AssistanceSettings, 'workFrom' | 'workUntil'> = ASSISTANCE_SETTINGS): Date {
  let remaining = minutes;
  let cursor = new Date(Math.ceil(start.getTime() / 60_000) * 60_000);
  for (let guard = 0; guard < 20_000; guard += 1) {
    const local = localTime(cursor, TIME_ZONE);
    const working = isWorkingDay(local);
    if (working && local.minutes >= settings.workFrom && local.minutes < settings.workUntil) {
      // Aucun changement d'heure dans la fenêtre de jour : une minute locale y vaut une minute.
      const available = settings.workUntil - local.minutes;
      if (remaining <= available) return new Date(cursor.getTime() + remaining * 60_000);
      remaining -= available;
      cursor = new Date(cursor.getTime() + available * 60_000);
      continue;
    }
    // Hors fenêtre : avancer par pas d'une heure au plus, pour ne pas sauter un changement d'heure.
    const toStart = working && local.minutes < settings.workFrom ? settings.workFrom - local.minutes : 1440 - local.minutes + settings.workFrom;
    cursor = new Date(cursor.getTime() + Math.min(toStart, 60) * 60_000);
  }
  throw new Error('Échéance introuvable.');
}

/** Les minutes ouvrées entre deux instants (0 si `to` est avant `from`). */
export function workingMinutesBetween(from: Date, to: Date, settings: Pick<AssistanceSettings, 'workFrom' | 'workUntil'> = ASSISTANCE_SETTINGS): number {
  let total = 0;
  let cursor = new Date(Math.ceil(from.getTime() / 60_000) * 60_000);
  for (let guard = 0; guard < 20_000 && cursor < to; guard += 1) {
    const local = localTime(cursor, TIME_ZONE);
    const working = isWorkingDay(local);
    if (working && local.minutes >= settings.workFrom && local.minutes < settings.workUntil) {
      const step = Math.min(settings.workUntil - local.minutes, Math.floor((to.getTime() - cursor.getTime()) / 60_000));
      if (step <= 0) break;
      total += step;
      cursor = new Date(cursor.getTime() + step * 60_000);
      continue;
    }
    const toStart = working && local.minutes < settings.workFrom ? settings.workFrom - local.minutes : 1440 - local.minutes + settings.workFrom;
    cursor = new Date(cursor.getTime() + Math.min(toStart, 60) * 60_000);
  }
  return total;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (v: unknown): v is string => {
  if (typeof v !== 'string' || !DAY.test(v)) return false;
  const d = new Date(`${v}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export type AccompagnementRefusal = { ok: false; rule: 'R16' | 'R15' | 'R17' | null; code: string };

export interface AssistanceAlert {
  requestId: string;
  agentId: string;
  level: AssistanceLevel;
  kind: 'avant_echeance' | 'echeance_depassee';
  dueAt: string;
  text: string;
}

export interface AccompagnementOptions {
  now?: () => Date;
  newId?: () => string;
  settings?: AssistanceSettings;
}

export class Accompagnement {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly settings: AssistanceSettings;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: AccompagnementOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.settings = options.settings ?? ASSISTANCE_SETTINGS;
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private today(at: Date = this.now()): string {
    return localTime(at, TIME_ZONE).date;
  }

  private async refuse(viewer: Viewer, subject: string | null, kind: string, code: string): Promise<AccompagnementRefusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind, code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  private async active(networkId: string, agentId: unknown): Promise<boolean> {
    if (typeof agentId !== 'string') return false;
    const row = await this.db.first<{ status: string }>('SELECT status FROM agents WHERE id = ? AND network_id = ?', [agentId, networkId]);
    return row?.status === 'active';
  }

  /** La direction attribue un référent pour 90 jours, à partir d'aujourd'hui. */
  async assignReferent(viewer: Viewer, agentId: string, referentId: unknown): Promise<{ ok: true; until: string } | AccompagnementRefusal> {
    if (viewer.role !== 'direction') return this.refuse(viewer, `agent:${agentId}`, 'referent', 'role');
    if (!(await this.active(viewer.networkId, agentId))) return { ok: false, rule: null, code: 'unknown_agent' };
    if (referentId === agentId || !(await this.active(viewer.networkId, referentId))) return { ok: false, rule: null, code: 'invalid_referent' };
    const from = this.today();
    const until = addDays(from, REFERENT_DAYS - 1);
    const id = this.newId();
    await this.db.run(
      'INSERT INTO agent_referents (id, network_id, agent_id, referent_id, from_day, until_day, assigned_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, viewer.networkId, agentId, referentId as string, from, until, this.actor(viewer), this.now().toISOString()],
    );
    await appendEvent(this.journal, { type: 'accompagnement.referent', actor: this.actor(viewer), subject: `agent:${agentId}`, data: { referent: `agent:${referentId as string}`, days: REFERENT_DAYS } }, this.now);
    return { ok: true, until };
  }

  /** Le référent en cours d'un agent ce jour-là : le dernier attribué dont les 90 jours courent encore. */
  async referentOf(networkId: string, agentId: string, at: Date = this.now()): Promise<{ referentId: string; until: string } | null> {
    const day = this.today(at);
    const row = await this.db.first<{ referent_id: string; until_day: string }>(
      'SELECT referent_id, until_day FROM agent_referents WHERE network_id = ? AND agent_id = ? AND from_day <= ? AND until_day >= ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      [networkId, agentId, day, day],
    );
    return row ? { referentId: row.referent_id, until: row.until_day } : null;
  }

  /**
   * L'agent lit son propre référent en cours (J14) : son prénom, la fin de ses 90 jours et, pour le joindre (AU112), ses
   * seules coordonnées professionnelles publiques (sa carte d'agent : téléphone et adresse mail), rien d'autre [R16].
   * Aucun référent en cours : `null`. Sans carte d'agent, les coordonnées sont `null`.
   */
  async myReferent(viewer: Viewer): Promise<{ ok: true; value: { firstName: string; until: string; phone: string | null; email: string | null } | null } | AccompagnementRefusal> {
    if (viewer.role !== 'agent') return this.refuse(viewer, null, 'my_referent', 'role');
    const current = await this.referentOf(viewer.networkId, viewer.userId);
    if (!current) return { ok: true, value: null };
    const row = await this.db.first<{ first_name: string }>('SELECT first_name FROM agents WHERE id = ? AND network_id = ?', [current.referentId, viewer.networkId]);
    if (!row) return { ok: true, value: null };
    const card = await this.db.first<{ phone: string; email: string }>('SELECT phone, email FROM agent_public_cards WHERE agent_id = ? AND network_id = ? ORDER BY set_at DESC, id DESC LIMIT 1', [current.referentId, viewer.networkId]);
    return { ok: true, value: { firstName: row.first_name, until: current.until, phone: card ? card.phone : null, email: card ? card.email : null } };
  }

  /** La direction écrit un binôme et son partage des honoraires, d'avance. Un partage écrit ne change plus [R17]. */
  async writePair(viewer: Viewer, input: { agentA: unknown; agentB: unknown; coverSharePct: unknown }): Promise<{ ok: true; pairId: string } | AccompagnementRefusal> {
    if (viewer.role !== 'direction') return this.refuse(viewer, null, 'pair', 'role');
    if (input.agentA === input.agentB || !(await this.active(viewer.networkId, input.agentA)) || !(await this.active(viewer.networkId, input.agentB))) return { ok: false, rule: null, code: 'invalid_pair' };
    if (!Number.isInteger(input.coverSharePct) || (input.coverSharePct as number) < 0 || (input.coverSharePct as number) > 100) return { ok: false, rule: null, code: 'invalid_share' };
    const [a, b] = [input.agentA as string, input.agentB as string].sort() as [string, string];
    const id = this.newId();
    await this.db.run('INSERT INTO agent_pairs (id, network_id, agent_a, agent_b, cover_share_pct, written_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      id,
      viewer.networkId,
      a,
      b,
      input.coverSharePct as number,
      this.actor(viewer),
      this.now().toISOString(),
    ]);
    await appendEvent(this.journal, { type: 'accompagnement.binome', actor: this.actor(viewer), subject: `agent_pair:${id}`, data: { coverSharePct: input.coverSharePct as number } }, this.now);
    return { ok: true, pairId: id };
  }

  /**
   * Une absence est déclarée par l'agent lui-même ou par la direction, pour aujourd'hui ou plus tard. Elle exige un
   * binôme dont le partage a été écrit avant sa déclaration ; le dernier partage écrit est celui de l'absence [R17].
   */
  async declareAbsence(viewer: Viewer, agentId: string, input: { from: unknown; until: unknown; coverAgentId: unknown }): Promise<{ ok: true; absenceId: string; coverSharePct: number } | AccompagnementRefusal> {
    const allowed = viewer.role === 'direction' || (viewer.role === 'agent' && viewer.userId === agentId);
    if (!allowed) return this.refuse(viewer, `agent:${agentId}`, 'absence', viewer.role === 'agent' ? 'not_assigned' : 'role');
    if (!(await this.active(viewer.networkId, agentId))) return { ok: false, rule: null, code: 'unknown_agent' };
    if (!validDay(input.from) || !validDay(input.until) || input.from > input.until) return { ok: false, rule: null, code: 'invalid_days' };
    if (input.from < this.today()) return { ok: false, rule: null, code: 'past_absence' };
    if (typeof input.coverAgentId !== 'string' || input.coverAgentId === agentId || !(await this.active(viewer.networkId, input.coverAgentId))) return { ok: false, rule: null, code: 'invalid_cover' };
    const [a, b] = [agentId, input.coverAgentId].sort() as [string, string];
    const pair = await this.db.first<{ id: string; cover_share_pct: number }>(
      'SELECT id, cover_share_pct FROM agent_pairs WHERE network_id = ? AND agent_a = ? AND agent_b = ? AND created_at < ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      [viewer.networkId, a, b, this.now().toISOString()],
    );
    if (!pair) return { ok: false, rule: 'R17', code: 'no_share_written' };
    const id = this.newId();
    await this.db.run(
      'INSERT INTO agent_absences (id, network_id, agent_id, pair_id, cover_agent_id, from_day, until_day, declared_by, declared_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, viewer.networkId, agentId, pair.id, input.coverAgentId, input.from, input.until, this.actor(viewer), this.now().toISOString()],
    );
    await appendEvent(this.journal, { type: 'accompagnement.absence', actor: this.actor(viewer), subject: `agent:${agentId}`, data: { cover: `agent:${input.coverAgentId}`, pair: `agent_pair:${pair.id}` } }, this.now);
    return { ok: true, absenceId: id, coverSharePct: pair.cover_share_pct };
  }

  /** Vrai si `coverId` reprend les dossiers de `absentId` à cet instant : pendant l'absence déclarée, et seulement alors [R16]. */
  async coversAt(networkId: string, coverId: string, absentId: string, at: Date = this.now()): Promise<{ absenceId: string; coverSharePct: number } | null> {
    const day = this.today(at);
    const row = await this.db.first<{ id: string; cover_share_pct: number }>(
      `SELECT x.id, p.cover_share_pct FROM agent_absences x JOIN agent_pairs p ON p.id = x.pair_id
       WHERE x.network_id = ? AND x.agent_id = ? AND x.cover_agent_id = ? AND x.from_day <= ? AND x.until_day >= ?
       ORDER BY x.declared_at DESC, x.rowid DESC LIMIT 1`,
      [networkId, absentId, coverId, day, day],
    );
    if (!row) return null;
    const cover = await this.active(networkId, coverId);
    return cover ? { absenceId: row.id, coverSharePct: row.cover_share_pct } : null;
  }

  /**
   * Les dossiers en cours de l'absent, pour son binôme : les fiches qu'il suit et leurs projets, par leur
   * identifiant. Lus pendant l'absence seulement ; avant et après, refusés au journal [R16].
   */
  async coverFiles(viewer: Viewer, absentId: string): Promise<{ ok: true; value: { personIds: string[]; projectIds: string[]; coverSharePct: number } } | AccompagnementRefusal> {
    if (viewer.role !== 'agent') return this.refuse(viewer, `agent:${absentId}`, 'cover_files', 'role');
    const covers = await this.coversAt(viewer.networkId, viewer.userId, absentId);
    if (!covers) return this.refuse(viewer, `agent:${absentId}`, 'cover_files', 'not_covering');
    const persons = await this.db.all<{ id: string }>('SELECT id FROM persons WHERE network_id = ? AND agent_id = ? ORDER BY id', [viewer.networkId, absentId]);
    const projects = await this.db.all<{ id: string }>("SELECT id FROM projects WHERE network_id = ? AND agent_id = ? ORDER BY id", [viewer.networkId, absentId]);
    await appendEvent(this.journal, { type: 'accompagnement.dossiers_lus', actor: this.actor(viewer), subject: `agent:${absentId}`, data: { absence: `absence:${covers.absenceId}`, persons: persons.length } }, this.now);
    return { ok: true, value: { personIds: persons.map((p) => p.id), projectIds: projects.map((p) => p.id), coverSharePct: covers.coverSharePct } };
  }

  /** L'agent demande de l'aide. Aucune donnée de client dans la demande [R15] ; l'échéance est calculée par le code. */
  async ask(viewer: Viewer, input: { level: unknown; topic: unknown; body: unknown }): Promise<{ ok: true; requestId: string; dueAt: string } | AccompagnementRefusal> {
    if (viewer.role !== 'agent' || !(await this.active(viewer.networkId, viewer.userId))) return this.refuse(viewer, null, 'assistance', 'role');
    if (typeof input.level !== 'string' || !(ASSISTANCE_LEVELS as readonly string[]).includes(input.level)) return { ok: false, rule: null, code: 'invalid_level' };
    if (typeof input.topic !== 'string' || !(ASSISTANCE_TOPICS as readonly string[]).includes(input.topic)) return { ok: false, rule: null, code: 'invalid_topic' };
    const body = typeof input.body === 'string' ? input.body.trim() : '';
    if (body.length < 5 || body.length > 1000) return { ok: false, rule: null, code: 'invalid_body' };
    if (citesClientData(body)) {
      await appendEvent(this.journal, { type: 'assistance.refusee', actor: this.actor(viewer), subject: null, data: { rule: 'R15', level: input.level } }, this.now);
      return { ok: false, rule: 'R15', code: 'client_data' };
    }
    const level = input.level as AssistanceLevel;
    const at = this.now();
    const dueAt = addWorkingMinutes(at, this.settings.hours[level] * 60, this.settings).toISOString();
    const id = this.newId();
    await this.db.run('INSERT INTO assistance_requests (id, network_id, agent_id, level, topic, body, created_at, due_at, answered_at, answered_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)', [
      id,
      viewer.networkId,
      viewer.userId,
      level,
      input.topic,
      body,
      at.toISOString(),
      dueAt,
    ]);
    await appendEvent(this.journal, { type: 'assistance.demande', actor: this.actor(viewer), subject: `assistance:${id}`, data: { level, topic: input.topic } }, this.now);
    return { ok: true, requestId: id, dueAt };
  }

  /** La direction note la réponse, une fois. */
  async answer(viewer: Viewer, requestId: string): Promise<{ ok: true; late: boolean } | AccompagnementRefusal> {
    if (viewer.role !== 'direction') return this.refuse(viewer, `assistance:${requestId}`, 'assistance', 'role');
    const row = await this.db.first<{ due_at: string }>('SELECT due_at FROM assistance_requests WHERE id = ? AND network_id = ?', [requestId, viewer.networkId]);
    if (!row) return { ok: false, rule: null, code: 'unknown' };
    const at = this.now();
    const { changes } = await this.db.run('UPDATE assistance_requests SET answered_at = ?, answered_by = ? WHERE id = ? AND answered_at IS NULL', [at.toISOString(), this.actor(viewer), requestId]);
    if (changes !== 1) return { ok: false, rule: null, code: 'already_answered' };
    const late = at.getTime() >= Date.parse(row.due_at);
    await appendEvent(this.journal, { type: 'assistance.repondue', actor: this.actor(viewer), subject: `assistance:${requestId}`, data: { late } }, this.now);
    return { ok: true, late };
  }

  /** Les alertes du jour pour la direction : avant l'échéance, puis échéance dépassée, une fois chacune. */
  async dueAlerts(networkId: string): Promise<AssistanceAlert[]> {
    const at = this.now();
    const open = await this.db.all<{ id: string; agent_id: string; level: AssistanceLevel; due_at: string }>(
      'SELECT id, agent_id, level, due_at FROM assistance_requests WHERE network_id = ? AND answered_at IS NULL ORDER BY due_at, id',
      [networkId],
    );
    const out: AssistanceAlert[] = [];
    for (const r of open) {
      const due = new Date(r.due_at);
      const left = at < due ? workingMinutesBetween(at, due, this.settings) : 0;
      const kind = at >= due ? 'echeance_depassee' : left <= this.settings.alertBeforeMinutes[r.level] ? 'avant_echeance' : null;
      if (!kind) continue;
      const { changes } = await this.db.run('INSERT INTO assistance_alerts (request_id, kind, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [r.id, kind, at.toISOString()]);
      if (changes !== 1) continue;
      const who = r.level === 'avocat' ? "l'avocat" : 'un humain du réseau';
      const when = localTime(due, TIME_ZONE);
      const hhmm = `${Math.floor(when.minutes / 60)} h ${String(when.minutes % 60).padStart(2, '0')}`;
      const day = `${when.date.slice(8, 10)}/${when.date.slice(5, 7)}`;
      out.push({
        requestId: r.id,
        agentId: r.agent_id,
        level: r.level,
        kind,
        dueAt: r.due_at,
        text: kind === 'avant_echeance' ? `Une demande d'assistance attend ${who} avant le ${day} à ${hhmm}.` : `Une demande d'assistance attend ${who} depuis le ${day} à ${hhmm} : le délai est dépassé.`,
      });
      await appendEvent(this.journal, { type: 'assistance.alerte', actor: 'system:assistance', subject: `assistance:${r.id}`, data: { kind, level: r.level } }, this.now);
    }
    return out;
  }
}
