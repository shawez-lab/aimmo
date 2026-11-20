/**
 * Départ d'un agent (M14, J11) [R86, R16, R17].
 *
 * La direction range un départ d'avance : le jour où le préavis est donné, le jour du départ et un motif codé, jamais
 * un texte libre. Le préavis légal de l'agent commercial (1 mois la première année, 2 la deuxième commencée, 3 ensuite,
 * prolongé jusqu'à la fin du mois civil) est calculé par le code depuis le début du contrat : le premier contrat signé du
 * dossier, ou la date saisie par la direction, jamais la création de la fiche. Un départ plus court n'est admis que pour
 * une faute grave ou un accord des deux parties, et il est alors signalé. Une indemnité de fin de contrat n'est jamais chiffrée ici : le code
 * dit seulement, selon le motif, qu'elle est possible et qu'elle est à faire chiffrer par l'avocat.
 *
 * L'agent qui part peut présenter un successeur, un agent du réseau en activité ; il ne reprend les clients et les biens
 * qu'avec l'accord du réseau, rangé par la direction avant le départ.
 *
 * Le jour du départ, à Paris, `isGone` est vrai dès minuit : les droits d'accès et le contrôle des envois le lisent au
 * branchement (J13), avant même le passage du planificateur. `runDue`, lancé par le planificateur, fait le reste, et se
 * relance sans rien changer : l'agent passe à « parti », chacun de ses clients, de ses biens et de ses projets passe à son successeur
 * accepté, sinon à la file de la direction ; chaque passage est rangé, aucune fiche n'est effacée [R17], aucune ne reste
 * sans agent ni hors de la file [R86]. La direction réattribue ensuite depuis sa file.
 *
 * Pour solder : `settlement` liste les commissions de l'agent pas encore payées, et ses parts ; `personalContents` liste
 * ce qui est à lui rendre (pièces de son dossier, temps de formation). Aucun nom ni aucune référence au journal [R13].
 * Rien n'est envoyé ici.
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

const TIME_ZONE = 'Europe/Paris';

export const DEPARTURE_REASONS = ['demission_agent', 'fin_par_reseau', 'accord_mutuel', 'faute_grave', 'age_maladie', 'cession_successeur'] as const;
export type DepartureReason = (typeof DEPARTURE_REASONS)[number];

export const DEPARTURE_REASON_LABELS: Readonly<Record<DepartureReason, string>> = Object.freeze({
  demission_agent: 'Fin du contrat à l’initiative de l’agent',
  fin_par_reseau: 'Fin du contrat à l’initiative du réseau',
  accord_mutuel: 'Fin du contrat d’un commun accord',
  faute_grave: 'Fin du contrat pour faute grave',
  age_maladie: 'Fin du contrat pour âge, infirmité ou maladie de l’agent',
  cession_successeur: 'Cession du contrat à un successeur',
});

/** Motifs où un départ avant la fin du préavis légal est admis. */
const SHORT_NOTICE_ALLOWED: readonly DepartureReason[] = ['faute_grave', 'accord_mutuel'];
/** Motifs où une indemnité de fin de contrat peut être due (Code de commerce, L134-12 et L134-13) : à faire chiffrer. */
// Une fin à l'initiative de l'agent ouvre droit à l'indemnité si elle est justifiée par des circonstances imputables au
// réseau (L134-13, 2°) : le code ne peut pas en juger, l'avocat l'examine.
const INDEMNITY_POSSIBLE: readonly DepartureReason[] = ['demission_agent', 'fin_par_reseau', 'accord_mutuel', 'age_maladie'];

export const HANDOVER_KINDS = ['person', 'property', 'project'] as const;
export type HandoverKind = (typeof HANDOVER_KINDS)[number];
const TABLE_OF: Readonly<Record<HandoverKind, string>> = Object.freeze({ person: 'persons', property: 'properties', project: 'projects' });

export type DepartureRefusal = { ok: false; rule: 'R16' | 'R86' | null; code: string };

export interface Departure {
  id: string;
  agentId: string;
  noticeGivenOn: string;
  leavesOn: string;
  reason: DepartureReason;
  reasonLabel: string;
  /** Le préavis légal, en mois, à la date du préavis. */
  noticeMonths: number;
  /** Le dernier jour couvert par le préavis légal ; un départ ce jour-là ou avant est un préavis réduit. */
  noticeEndsOn: string;
  reducedNotice: boolean;
  /** Une indemnité de fin de contrat peut être due : jamais chiffrée par le code. */
  indemnityToReview: boolean;
  successor: { agentId: string; status: 'presente' | 'accepte' | 'refuse' } | null;
  processed: boolean;
  /** L'étape suivante, en une phrase. */
  nextStep: string;
}

export interface HandoverLine {
  departureId: string;
  kind: HandoverKind;
  subjectId: string;
  fromAgentId: string;
  since: string;
}

export interface SettlementLine {
  fileId: string;
  /** La dernière étape de la commission : prévue, due ou facturée ; jamais payée ici. */
  status: 'prevue' | 'due' | 'facturee';
  feeCents: number;
  /** Ce qui revient à l'agent parti sur cette vente, toutes parts comprises. */
  agentShareCents: number;
}

export interface PersonalContents {
  /** Les pièces signées de son dossier, par leur référence de stockage, dernière version de chacune. */
  pieces: { kind: string; version: number; ref: string }[];
  /** Le temps de formation suivi au réseau, en minutes, pour son attestation. */
  trainingMinutes: number;
}

interface DepartureRow {
  id: string;
  network_id: string;
  agent_id: string;
  notice_given_on: string;
  leaves_on: string;
  reason: DepartureReason;
  notice_months: number;
  successor_agent_id: string | null;
  successor_status: 'presente' | 'accepte' | 'refuse' | null;
  processed_at: string | null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (v: unknown): v is string => {
  if (typeof v !== 'string' || !DAY.test(v)) return false;
  const d = new Date(`${v}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
const frDate = (day: string): string => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;

/** Ajoute des mois à un jour, en restant au dernier jour du mois s'il le faut. */
export function addMonths(day: string, months: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

/**
 * Le préavis légal de l'agent commercial (Code de commerce, L134-11) : 1 mois pendant la première année du contrat,
 * 2 mois pendant la deuxième année commencée, 3 mois à partir de la troisième année commencée.
 */
/** Le dernier jour du mois civil d'un jour. */
export function endOfMonth(day: string): string {
  const [y, m] = day.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/**
 * La fin du préavis légal : le délai compté depuis le jour du préavis, puis prolongé jusqu'à la fin du mois civil
 * (L134-11, alinéa 4, lecture prudente : le contrat type ne dit pas le contraire). Le contrat court jusqu'à ce jour
 * inclus ; le départ, jour où l'accès est coupé, vient au plus tôt le lendemain.
 */
export function legalNoticeEnd(noticeGivenOn: string, months: number): string {
  return endOfMonth(addMonths(noticeGivenOn, months));
}

export function legalNoticeMonths(startedOn: string, noticeGivenOn: string): 1 | 2 | 3 {
  if (noticeGivenOn < addMonths(startedOn, 12)) return 1;
  if (noticeGivenOn < addMonths(startedOn, 24)) return 2;
  return 3;
}

const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

/**
 * L'agent est-il parti à cet instant ? Inconnu, d'un autre réseau, plus en activité, ou au jour de son départ à Paris,
 * dès minuit [R86]. Sans journal : lu par les droits d'accès et le contrôle des envois, qui écrivent leur refus.
 */
export async function agentGone(db: SqlDatabase, networkId: string, agentId: string, at: Date): Promise<boolean> {
  const a = await db.first<{ network_id: string; status: string }>('SELECT network_id, status FROM agents WHERE id = ?', [agentId]);
  if (!a || a.network_id !== networkId) return true;
  if (a.status !== 'active') return true;
  const row = await db.first<{ n: number }>('SELECT count(*) AS n FROM agent_departures WHERE agent_id = ? AND cancelled_at IS NULL AND leaves_on <= ?', [agentId, localTime(at, TIME_ZONE).date]);
  return Number(row?.n ?? 0) > 0;
}

export interface DepartsOptions {
  now?: () => Date;
  newId?: () => string;
}

export class Departs {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: DepartsOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private today(at: Date = this.now()): string {
    return localTime(at, TIME_ZONE).date;
  }

  private async refuse(viewer: Viewer, subject: string, code: string): Promise<DepartureRefusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind: 'agent_departure', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  /** Seule la direction range, change ou lit un départ ; la conformité lit [R16]. */
  private async gate(viewer: Viewer, agentId: string, write: boolean): Promise<{ status: string; created_at: string } | DepartureRefusal> {
    if (!(viewer.role === 'direction' || (viewer.role === 'compliance' && !write))) return this.refuse(viewer, `agent:${agentId}`, 'role');
    const agent = await this.db.first<{ network_id: string; status: string; created_at: string }>('SELECT network_id, status, created_at FROM agents WHERE id = ?', [agentId]);
    if (!agent || agent.network_id !== viewer.networkId) return this.refuse(viewer, `agent:${agentId}`, 'unknown');
    return agent;
  }

  private async current(agentId: string): Promise<DepartureRow | null> {
    return this.db.first<DepartureRow>('SELECT * FROM agent_departures WHERE agent_id = ? AND cancelled_at IS NULL', [agentId]);
  }

  private describe(row: DepartureRow): Departure {
    const noticeEndsOn = legalNoticeEnd(row.notice_given_on, row.notice_months);
    const reducedNotice = row.leaves_on <= noticeEndsOn;
    const processed = row.processed_at !== null;
    const indemnityToReview = INDEMNITY_POSSIBLE.includes(row.reason);
    let nextStep = `Départ prévu le ${frDate(row.leaves_on)} : ce jour-là, l’accès de l’agent est coupé et ses clients passent ${row.successor_status === 'accepte' ? 'à son successeur' : 'à la direction'}.`;
    if (processed) nextStep = 'Départ fait : réattribuez les clients et les biens de la file, puis soldez les commissions en cours.';
    else if (row.successor_status === 'presente') nextStep = `Un successeur est présenté : acceptez-le ou refusez-le avant le ${frDate(row.leaves_on)}.`;
    if (indemnityToReview && !processed) nextStep += ' Indemnité de fin de contrat possible : à faire chiffrer par l’avocat.';
    return {
      id: row.id,
      agentId: row.agent_id,
      noticeGivenOn: row.notice_given_on,
      leavesOn: row.leaves_on,
      reason: row.reason,
      reasonLabel: DEPARTURE_REASON_LABELS[row.reason],
      noticeMonths: Number(row.notice_months),
      noticeEndsOn,
      reducedNotice,
      indemnityToReview,
      successor: row.successor_agent_id && row.successor_status ? { agentId: row.successor_agent_id, status: row.successor_status } : null,
      processed,
      nextStep,
    };
  }

  /**
   * La direction range le départ d'un agent en activité : jour du préavis, jour du départ, motif. Le préavis légal est
   * calculé par le code ; un départ avant sa fin n'est admis que pour faute grave ou d'un commun accord.
   */
  async schedule(viewer: Viewer, agentId: string, input: { noticeGivenOn: unknown; leavesOn: unknown; reason: unknown; contractStartedOn?: unknown }): Promise<{ ok: true; value: Departure } | DepartureRefusal> {
    const agent = await this.gate(viewer, agentId, true);
    if ('ok' in agent) return agent;
    if (agent.status !== 'active') return { ok: false, rule: 'R86', code: 'already_left' };
    if (typeof input.reason !== 'string' || !(DEPARTURE_REASONS as readonly string[]).includes(input.reason)) return { ok: false, rule: null, code: 'bad_reason' };
    const reason = input.reason as DepartureReason;
    const today = this.today();
    if (!validDay(input.noticeGivenOn) || input.noticeGivenOn > today) return { ok: false, rule: null, code: 'bad_notice_date' };
    // Le jour du départ ne se range jamais dans le passé : ce qui a été fait ce jour-là ne se réécrit pas.
    if (!validDay(input.leavesOn) || input.leavesOn < today || input.leavesOn < input.noticeGivenOn) return { ok: false, rule: null, code: 'bad_leave_date' };
    // Le début du contrat, jamais la date de création de la fiche : le premier contrat signé du dossier, ou la date
    // saisie par la direction depuis le contrat ; avec les deux, la plus ancienne, qui donne le préavis le plus long.
    const signed = await this.db.first<{ d: string | null }>(
      "SELECT MIN(issued_on) AS d FROM agent_file_pieces WHERE agent_id = ? AND kind = 'contrat_agent_commercial' AND is_draft = 0",
      [agentId],
    );
    const given = input.contractStartedOn;
    if (given !== undefined && given !== null && given !== '' && (!validDay(given) || given > today)) return { ok: false, rule: null, code: 'bad_contract_date' };
    const starts = [signed?.d ?? null, validDay(given) ? given : null].filter((d): d is string => d !== null).sort();
    const startedOn = starts[0];
    if (!startedOn) return { ok: false, rule: null, code: 'no_contract_date' };
    if (input.noticeGivenOn < startedOn) return { ok: false, rule: null, code: 'bad_notice_date' };
    const months = legalNoticeMonths(startedOn, input.noticeGivenOn);
    if (input.leavesOn <= legalNoticeEnd(input.noticeGivenOn, months) && !SHORT_NOTICE_ALLOWED.includes(reason)) return { ok: false, rule: null, code: 'notice_too_short' };
    if (await this.current(agentId)) return { ok: false, rule: null, code: 'already_scheduled' };
    const id = this.newId();
    try {
      await this.db.run(
        'INSERT INTO agent_departures (id, network_id, agent_id, notice_given_on, leaves_on, reason, notice_months, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, viewer.networkId, agentId, input.noticeGivenOn, input.leavesOn, reason, months, this.actor(viewer), this.now().toISOString()],
      );
    } catch (error) {
      if (/UNIQUE/i.test(String(error))) return { ok: false, rule: null, code: 'already_scheduled' };
      throw error;
    }
    const row = (await this.db.first<DepartureRow>('SELECT * FROM agent_departures WHERE id = ?', [id]))!;
    const value = this.describe(row);
    await appendEvent(
      this.journal,
      { type: 'agent.depart_range', actor: this.actor(viewer), subject: `agent:${agentId}`, data: { rule: 'R86', reason, leavesOn: input.leavesOn, reducedNotice: value.reducedNotice ? 1 : 0 } },
      this.now,
    );
    return { ok: true, value };
  }

  /** La direction annule un départ tant que son jour n'est pas venu ; la ligne reste, annulée [R17]. */
  async cancel(viewer: Viewer, agentId: string): Promise<{ ok: true } | DepartureRefusal> {
    const agent = await this.gate(viewer, agentId, true);
    if ('ok' in agent) return agent;
    const row = await this.current(agentId);
    if (!row) return { ok: false, rule: null, code: 'no_departure' };
    if (row.processed_at !== null || row.leaves_on <= this.today()) return { ok: false, rule: 'R86', code: 'too_late' };
    const { changes } = await this.db.run('UPDATE agent_departures SET cancelled_at = ?, cancelled_by = ? WHERE id = ? AND cancelled_at IS NULL AND processed_at IS NULL', [
      this.now().toISOString(),
      this.actor(viewer),
      row.id,
    ]);
    if (changes !== 1) return { ok: false, rule: 'R86', code: 'too_late' };
    await appendEvent(this.journal, { type: 'agent.depart_annule', actor: this.actor(viewer), subject: `agent:${agentId}`, data: { rule: 'R86' } }, this.now);
    return { ok: true };
  }

  /**
   * L'agent présente un successeur, rangé par la direction : un autre agent du réseau, en activité, qui ne part pas
   * lui-même. Il ne reprend rien sans l'accord du réseau (`decideSuccessor`).
   */
  async presentSuccessor(viewer: Viewer, agentId: string, successorId: unknown): Promise<{ ok: true; value: Departure } | DepartureRefusal> {
    const agent = await this.gate(viewer, agentId, true);
    if ('ok' in agent) return agent;
    const row = await this.current(agentId);
    if (!row) return { ok: false, rule: null, code: 'no_departure' };
    if (row.processed_at !== null || row.leaves_on <= this.today()) return { ok: false, rule: 'R86', code: 'too_late' };
    if (row.successor_status === 'accepte' || row.successor_status === 'refuse') return { ok: false, rule: null, code: 'already_decided' };
    if (typeof successorId !== 'string' || successorId === agentId || !(await this.canReceive(viewer.networkId, successorId))) return { ok: false, rule: null, code: 'bad_successor' };
    await this.db.run("UPDATE agent_departures SET successor_agent_id = ?, successor_status = 'presente' WHERE id = ? AND processed_at IS NULL", [successorId, row.id]);
    await appendEvent(this.journal, { type: 'agent.successeur_presente', actor: this.actor(viewer), subject: `agent:${agentId}`, data: { rule: 'R86', successor: `agent:${successorId}` } }, this.now);
    return { ok: true, value: this.describe((await this.current(agentId))!) };
  }

  /** L'accord du réseau, ou son refus, sur le successeur présenté : rangé une fois, par un humain de la direction. */
  async decideSuccessor(viewer: Viewer, agentId: string, accept: unknown): Promise<{ ok: true; value: Departure } | DepartureRefusal> {
    const agent = await this.gate(viewer, agentId, true);
    if ('ok' in agent) return agent;
    if (typeof accept !== 'boolean') return { ok: false, rule: null, code: 'bad_decision' };
    const row = await this.current(agentId);
    if (!row) return { ok: false, rule: null, code: 'no_departure' };
    if (row.processed_at !== null || row.leaves_on <= this.today()) return { ok: false, rule: 'R86', code: 'too_late' };
    if (row.successor_status !== 'presente') return { ok: false, rule: null, code: row.successor_status === null ? 'no_successor' : 'already_decided' };
    if (accept && !(await this.canReceive(viewer.networkId, row.successor_agent_id!))) return { ok: false, rule: null, code: 'bad_successor' };
    const { changes } = await this.db.run(
      "UPDATE agent_departures SET successor_status = ?, successor_decided_by = ?, successor_decided_at = ? WHERE id = ? AND successor_status = 'presente' AND processed_at IS NULL",
      [accept ? 'accepte' : 'refuse', this.actor(viewer), this.now().toISOString(), row.id],
    );
    if (changes !== 1) return { ok: false, rule: null, code: 'already_decided' };
    await appendEvent(this.journal, { type: accept ? 'agent.successeur_accepte' : 'agent.successeur_refuse', actor: this.actor(viewer), subject: `agent:${agentId}`, data: { rule: 'R86' } }, this.now);
    return { ok: true, value: this.describe((await this.current(agentId))!) };
  }

  /** Le départ en vigueur d'un agent, pour la direction et la conformité [R16]. */
  async get(viewer: Viewer, agentId: string): Promise<{ ok: true; value: Departure | null } | DepartureRefusal> {
    const agent = await this.gate(viewer, agentId, false);
    if ('ok' in agent) return agent;
    const row = (await this.current(agentId)) ?? (await this.db.first<DepartureRow>('SELECT * FROM agent_departures WHERE agent_id = ? AND processed_at IS NOT NULL', [agentId]));
    return { ok: true, value: row ? this.describe(row) : null };
  }

  /** Un agent qui peut recevoir des clients : du réseau, en activité, sans départ venu. */
  private async canReceive(networkId: string, agentId: string): Promise<boolean> {
    const a = await this.db.first<{ network_id: string; status: string }>('SELECT network_id, status FROM agents WHERE id = ?', [agentId]);
    if (!a || a.network_id !== networkId || a.status !== 'active') return false;
    return !(await this.isGone(networkId, agentId, this.now()));
  }

  /**
   * L'agent est-il parti à cet instant ? Vrai s'il est « parti », ou si le jour de son départ est venu à Paris, même
   * avant le passage du planificateur. Lu par les droits d'accès et par le contrôle des envois au branchement (J13) :
   * plus aucune lecture ni écriture, et rien de ce qu'il avait préparé ne part plus [R86, R16].
   */
  async isGone(networkId: string, agentId: string, at: Date): Promise<boolean> {
    return agentGone(this.db, networkId, agentId, at);
  }

  /**
   * Un envoi préparé au nom d'un agent, ou par lui, peut-il encore partir ? Non dès le jour de son départ [R86]. Le
   * contrôle central des envois le demande avant tout envoi (J13) ; un envoi sans agent n'est pas concerné ici.
   */
  async sendAllowed(networkId: string, order: { agentId?: string | null; preparedBy?: string | null }, at: Date): Promise<boolean> {
    for (const id of [order.agentId, order.preparedBy]) {
      if (typeof id === 'string' && id !== '' && (await this.isGone(networkId, id, at))) return false;
    }
    return true;
  }

  /**
   * Les départs du jour, lancés par le planificateur : chaque agent dont le jour est venu passe à « parti » ; ses
   * clients et ses biens passent à son successeur accepté, sinon à la file de la direction. Se relance sans rien
   * changer. Rend les départs faits à ce passage.
   */
  async runDue(networkId: string): Promise<{ agentId: string; persons: number; properties: number; projects: number; toSuccessor: boolean }[]> {
    const day = this.today();
    const due = await this.db.all<DepartureRow>(
      'SELECT * FROM agent_departures WHERE network_id = ? AND cancelled_at IS NULL AND processed_at IS NULL AND leaves_on <= ? ORDER BY leaves_on, agent_id',
      [networkId, day],
    );
    const done: { agentId: string; persons: number; properties: number; projects: number; toSuccessor: boolean }[] = [];
    for (const row of due) {
      const at = this.now().toISOString();
      // 1. L'accès est coupé d'abord : c'est ce qui ne doit jamais attendre [R86, R16].
      await this.db.run("UPDATE agents SET status = 'left', updated_at = ? WHERE id = ? AND network_id = ? AND status = 'active'", [at, row.agent_id, networkId]);
      // Un successeur accepté qui ne peut plus recevoir (parti entre-temps) : tout va à la direction.
      const successor = row.successor_status === 'accepte' && row.successor_agent_id && (await this.canReceive(networkId, row.successor_agent_id)) ? row.successor_agent_id : null;
      const persons = await this.handOver(row, 'person', successor);
      const properties = await this.handOver(row, 'property', successor);
      // Les projets de l'agent (vente, achat, location…) suivent : aucun ne reste sans suivi [R86].
      const projects = await this.handOver(row, 'project', successor);
      const { changes } = await this.db.run('UPDATE agent_departures SET processed_at = ? WHERE id = ? AND processed_at IS NULL AND cancelled_at IS NULL', [at, row.id]);
      if (changes !== 1) continue;
      const total = await this.db.first<{ p: number; b: number; j: number }>(
        "SELECT sum(kind = 'person') AS p, sum(kind = 'property') AS b, sum(kind = 'project') AS j FROM agent_departure_handovers WHERE departure_id = ?",
        [row.id],
      );
      const entry = { agentId: row.agent_id, persons: Number(total?.p ?? persons), properties: Number(total?.b ?? properties), projects: Number(total?.j ?? projects), toSuccessor: successor !== null };
      await appendEvent(
        this.journal,
        {
          type: 'agent.parti',
          actor: 'system:planificateur',
          subject: `agent:${row.agent_id}`,
          data: { rule: 'R86', persons: entry.persons, properties: entry.properties, projects: entry.projects, to: successor ? `agent:${successor}` : 'direction' },
        },
        this.now,
      );
      done.push(entry);
    }
    return done;
  }

  /**
   * Passe chaque client (ou bien) de l'agent parti à `to` (NULL : la direction), en rangeant le passage avant de le
   * faire ; recommence tant qu'il en reste, pour qu'une fiche rangée entre-temps ne reste pas chez l'agent parti.
   */
  private async handOver(row: DepartureRow, kind: HandoverKind, to: string | null): Promise<number> {
    const table = TABLE_OF[kind];
    let moved = 0;
    for (let round = 0; round < 5; round++) {
      const ids = (await this.db.all<{ id: string }>(`SELECT id FROM ${table} WHERE network_id = ? AND agent_id = ? ORDER BY id`, [row.network_id, row.agent_id])).map((r) => r.id);
      if (ids.length === 0) break;
      const at = this.now().toISOString();
      for (const id of ids) {
        await this.db.run(
          'INSERT INTO agent_departure_handovers (departure_id, network_id, kind, subject_id, from_agent_id, to_agent_id, at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
          [row.id, row.network_id, kind, id, row.agent_id, to, at],
        );
      }
      for (let i = 0; i < ids.length; i += 50) {
        const part = ids.slice(i, i + 50);
        const { changes } = await this.db.run(`UPDATE ${table} SET agent_id = ?, updated_at = ? WHERE agent_id = ? AND id IN (${placeholders(part.length)})`, [to, at, row.agent_id, ...part]);
        moved += changes;
      }
    }
    return moved;
  }

  /**
   * La file de la direction : chaque client et chaque bien laissé par un agent parti, qui n'a pas encore été
   * réattribué. Direction seule [R16].
   */
  async queue(viewer: Viewer): Promise<{ ok: true; value: HandoverLine[] } | DepartureRefusal> {
    if (viewer.role !== 'direction') return this.refuse(viewer, 'agent_departure:queue', 'role');
    const rows = await this.db.all<{ departure_id: string; kind: HandoverKind; subject_id: string; from_agent_id: string; at: string }>(
      `SELECT h.departure_id, h.kind, h.subject_id, h.from_agent_id, h.at FROM agent_departure_handovers h
       WHERE h.network_id = ? AND h.to_agent_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM agent_departure_reassignments r WHERE r.departure_id = h.departure_id AND r.kind = h.kind AND r.subject_id = h.subject_id)
         AND ((h.kind = 'person' AND EXISTS (SELECT 1 FROM persons p WHERE p.id = h.subject_id AND p.agent_id IS NULL))
           OR (h.kind = 'property' AND EXISTS (SELECT 1 FROM properties b WHERE b.id = h.subject_id AND b.agent_id IS NULL))
           OR (h.kind = 'project' AND EXISTS (SELECT 1 FROM projects j WHERE j.id = h.subject_id AND j.agent_id IS NULL)))
       ORDER BY h.at, h.kind, h.subject_id`,
      [viewer.networkId],
    );
    await appendEvent(this.journal, { type: 'agent_depart.file_lue', actor: this.actor(viewer), subject: null, data: { rule: 'R16', count: rows.length } }, this.now);
    return { ok: true, value: rows.map((r) => ({ departureId: r.departure_id, kind: r.kind, subjectId: r.subject_id, fromAgentId: r.from_agent_id, since: r.at })) };
  }

  /**
   * La direction réattribue un client, un bien ou un projet de sa file à un agent en activité ; une fois [R86, R16].
   * Les projets du client qui attendent dans la file le suivent chez le même agent.
   */
  async reassign(viewer: Viewer, input: { kind: unknown; subjectId: unknown; toAgentId: unknown }): Promise<{ ok: true } | DepartureRefusal> {
    if (viewer.role !== 'direction') return this.refuse(viewer, 'agent_departure:queue', 'role');
    if (typeof input.kind !== 'string' || !(HANDOVER_KINDS as readonly string[]).includes(input.kind)) return { ok: false, rule: null, code: 'bad_kind' };
    if (typeof input.subjectId !== 'string' || typeof input.toAgentId !== 'string') return { ok: false, rule: null, code: 'bad_input' };
    if (!(await this.canReceive(viewer.networkId, input.toAgentId))) {
      return (await this.inQueue(viewer.networkId, input.kind as HandoverKind, input.subjectId)) ? { ok: false, rule: 'R86', code: 'bad_agent' } : { ok: false, rule: null, code: 'not_in_queue' };
    }
    const done = await this.reassignOne(viewer, input.kind as HandoverKind, input.subjectId, input.toAgentId);
    if (!done) return { ok: false, rule: null, code: 'not_in_queue' };
    if (input.kind === 'person') {
      const projects = await this.db.all<{ id: string }>('SELECT id FROM projects WHERE person_id = ? AND agent_id IS NULL ORDER BY id', [input.subjectId]);
      for (const p of projects) await this.reassignOne(viewer, 'project', p.id, input.toAgentId);
    }
    return { ok: true };
  }

  private async inQueue(networkId: string, kind: HandoverKind, subjectId: string): Promise<string | null> {
    const table = TABLE_OF[kind];
    const h = await this.db.first<{ departure_id: string }>(
      `SELECT h.departure_id FROM agent_departure_handovers h JOIN ${table} t ON t.id = h.subject_id
       WHERE h.network_id = ? AND h.kind = ? AND h.subject_id = ? AND h.to_agent_id IS NULL AND t.agent_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM agent_departure_reassignments r WHERE r.departure_id = h.departure_id AND r.kind = h.kind AND r.subject_id = h.subject_id)
       ORDER BY h.at DESC`,
      [networkId, kind, subjectId],
    );
    return h?.departure_id ?? null;
  }

  /** Réattribue une ligne de la file ; faux si elle n'y est pas (ou plus). */
  private async reassignOne(viewer: Viewer, kind: HandoverKind, subjectId: string, toAgentId: string): Promise<boolean> {
    const table = TABLE_OF[kind];
    const departureId = await this.inQueue(viewer.networkId, kind, subjectId);
    if (!departureId) return false;
    const at = this.now().toISOString();
    try {
      await this.db.run('INSERT INTO agent_departure_reassignments (departure_id, kind, subject_id, network_id, to_agent_id, by, at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        departureId,
        kind,
        subjectId,
        viewer.networkId,
        toAgentId,
        this.actor(viewer),
        at,
      ]);
    } catch (error) {
      if (/UNIQUE|PRIMARY/i.test(String(error))) return false;
      throw error;
    }
    await this.db.run(`UPDATE ${table} SET agent_id = ?, updated_at = ? WHERE id = ? AND agent_id IS NULL`, [toAgentId, at, subjectId]);
    await appendEvent(
      this.journal,
      { type: 'agent_depart.reattribue', actor: this.actor(viewer), subject: `${kind}:${subjectId}`, data: { rule: 'R86', to: `agent:${toAgentId}` } },
      this.now,
    );
    return true;
  }

  /** Les commissions de l'agent pas encore payées, et ce qui lui en revient : à solder. Direction et conformité [R16]. */
  async settlement(viewer: Viewer, agentId: string): Promise<{ ok: true; value: SettlementLine[] } | DepartureRefusal> {
    const agent = await this.gate(viewer, agentId, false);
    if ('ok' in agent) return agent;
    const value = await settlementOf(this.db, viewer.networkId, agentId);
    await appendEvent(this.journal, { type: 'agent_depart.solde_lu', actor: this.actor(viewer), subject: `agent:${agentId}`, data: { rule: 'R16', count: value.length } }, this.now);
    return { ok: true, value };
  }

  /** Ce qui est à rendre à l'agent : ses pièces signées et son temps de formation. Direction et conformité [R16]. */
  async personalContents(viewer: Viewer, agentId: string): Promise<{ ok: true; value: PersonalContents } | DepartureRefusal> {
    const agent = await this.gate(viewer, agentId, false);
    if ('ok' in agent) return agent;
    const value = await personalContentsOf(this.db, agentId);
    await appendEvent(this.journal, { type: 'agent_depart.contenus_lus', actor: this.actor(viewer), subject: `agent:${agentId}`, data: { rule: 'R16', pieces: value.pieces.length } }, this.now);
    return { ok: true, value };
  }
}

/** Les commissions d'un agent pas encore payées, et ses parts (J11) : lu pour la direction, et par l'accès de sortie (AU111). */
export async function settlementOf(db: SqlDatabase, networkId: string, agentId: string): Promise<SettlementLine[]> {
  const rows = await db.all<{ file_id: string; fee_cents: number; status: SettlementLine['status'] | 'payee'; share: number | null }>(
    `SELECT c.file_id, c.fee_cents,
       (SELECT s.status FROM commission_steps s WHERE s.file_id = c.file_id
         ORDER BY CASE s.status WHEN 'payee' THEN 4 WHEN 'facturee' THEN 3 WHEN 'due' THEN 2 ELSE 1 END DESC LIMIT 1) AS status,
       (SELECT sum(x.amount_cents) FROM commission_shares x WHERE x.file_id = c.file_id AND x.beneficiary_id = ? AND x.kind <> 'reseau') AS share
     FROM commissions c
     WHERE c.network_id = ? AND NOT EXISTS (SELECT 1 FROM sale_file_stops stop_ WHERE stop_.file_id = c.file_id) AND (c.agent_id = ? OR EXISTS (SELECT 1 FROM commission_shares y WHERE y.file_id = c.file_id AND y.beneficiary_id = ? AND y.kind <> 'reseau'))
     ORDER BY c.compromis_on, c.file_id`,
    [agentId, networkId, agentId, agentId],
  );
  return rows
    .filter((r) => r.status !== 'payee')
    .map((r) => ({ fileId: r.file_id, status: (r.status ?? 'prevue') as SettlementLine['status'], feeCents: Number(r.fee_cents), agentShareCents: Number(r.share ?? 0) }));
}

/** Ce qui est à rendre à un agent : ses pièces signées et son temps de formation (J11, AU111). */
export async function personalContentsOf(db: SqlDatabase, agentId: string): Promise<PersonalContents> {
  const pieces = await db.all<{ kind: string; version: number; ref: string }>(
    `SELECT p.kind, p.version, p.ref FROM agent_file_pieces p
     WHERE p.agent_id = ? AND p.is_draft = 0 AND p.version = (SELECT MAX(q.version) FROM agent_file_pieces q WHERE q.agent_id = p.agent_id AND q.kind = p.kind AND q.is_draft = 0)
     ORDER BY p.kind`,
    [agentId],
  );
  const minutes = await db.first<{ m: number | null }>(
    `SELECT (SELECT COALESCE(sum(s.duration_minutes), 0) FROM academy_attendance a JOIN academy_sessions s ON s.id = a.session_id WHERE a.agent_id = ?)
          + (SELECT COALESCE(sum(t.minutes), 0) FROM training_sessions t WHERE t.agent_id = ? AND t.minutes IS NOT NULL) AS m`,
    [agentId, agentId],
  );
  return { pieces: pieces.map((p) => ({ kind: p.kind, version: Number(p.version), ref: p.ref })), trainingMinutes: Number(minutes?.m ?? 0) };
}
