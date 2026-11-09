/**
 * Les agents pilotes signent-ils plus qu'avant leur arrivée ? (HX69 ; Feuille de route, « Les phases et leurs
 * conditions », phase 3 : « Les agents pilotes signent plus de mandats qu'avant leur arrivée, mesuré sur 3 mois »)
 * [R640, R641, R642, R14, R16].
 *
 * La direction désigne les agents pilotes. Pour chacun, elle range les mandats qu'il a signés dans chacun des 3 mois de
 * Paris qui précèdent son mois d'arrivée, avec la référence de leur preuve (l'extrait de son ancien registre des
 * mandats), par versions qui ne changent plus [R640, R17]. L'après se lit dans le registre des mandats (R39), comme le
 * compteur de la preuve (IN01) : un mandat inscrit, signé par le pilote (l'agent figé par la ligne du registre) dans un
 * des 3 mois de Paris qui suivent son mois d'arrivée ; une annulation pour erreur ou une rétractation le retire, une
 * résiliation le laisse compter. Le mois d'arrivée, à cheval, n'est ni avant ni après : il est dit à part [R641].
 *
 * Jamais vu : la comparaison ne peut pas être arrangée après coup. Seule compte la dernière version de l'avant rangée
 * avant le premier instant de la mesure ; une version rangée ensuite est gardée et montrée, jamais comptée. Chaque
 * mandat d'après porte son numéro du registre.
 *
 * Décidé, lecture prudente : l'arrivée est l'entrée du candidat devenu agent (J04), sinon la création de sa fiche ;
 * jamais une date saisie. « Plus » veut dire strictement plus. Un pilote parti avant la fin de sa mesure (départ
 * maintenu dont le jour est atteint au plus tard le dernier jour de son 3e mois, ou fiche « partie ») est « parti ».
 * La condition n'est remplie qu'avec au moins 3 pilotes (« 3 à 5 agents »), tous finis et tous « plus », et un
 * registre sain. Passer à la phase suivante reste une décision de Shawez : rien ne bascule seul.
 *
 * Aucun classement : les pilotes se lisent dans l'ordre de leur arrivée, rien n'est montré à un agent [R14]. La
 * direction seule désigne, déclare et lit ; la lecture est écrite au journal avant d'être rendue [R16].
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { RegistreMandats } from '../mandats/registre.ts';
import { monthBounds } from '../pilotage/indicateurs-reseau.ts';
import { parisMonth } from '../pilotage/preuve.ts';

/** Le nombre de mois de Paris mesurés de chaque côté de l'arrivée. */
export const PILOT_MONTHS = 3;
/** Le nombre de pilotes en dessous duquel la condition n'est jamais remplie (« 3 à 5 agents »). */
export const PILOT_MINIMUM = 3;
/** Le plus grand nombre de mandats d'un mois déclarable. */
export const PILOT_MONTH_MAX = 500;

export const PILOT_DESIGNATION_FIELDS = ['agentId'] as const;
export const PILOT_DECLARATION_FIELDS = ['agentId', 'months', 'proofRef'] as const;

/** Une référence de stockage : lettres, chiffres et `/ _ . : -`, sans espace, sans `..`. */
const PROOF_REF = /^[A-Za-z0-9][A-Za-z0-9/_.:-]{2,199}$/;

export type PilotRefusal = { ok: false; rule: 'R16'; code: 'role' } | { ok: false; rule: 'R640' | null; code: string };

export type PilotStatus = 'en_cours' | 'parti' | 'avant_non_declare' | 'plus' | 'pas_plus';
export type PilotConditionReason = 'moins_de_3_pilotes' | 'pilote_en_cours' | 'pilote_parti' | 'avant_non_declare' | 'pas_plus' | 'registre_abime';

export interface PilotDeclaration {
  version: number;
  months: [number, number, number];
  proofRef: string;
  declaredAt: string;
  /** Rangée avant le premier instant de la mesure : seule la plus haute de celles-ci compte [R640]. */
  inTime: boolean;
  counts: boolean;
}

export interface PilotMonth {
  month: string;
  counted: number;
}

export interface PilotLine {
  month: string;
  number: string;
  hash: string;
  /** Résilié depuis : compte quand même, et se voit [R641]. */
  terminated: boolean;
}

export interface PilotReportLine {
  agentId: string;
  arrivedAt: string;
  arrivalMonth: string;
  /** Le premier instant de la mesure : le 1er du mois de Paris qui suit l'arrivée. */
  measureStart: string;
  /** Le dernier mois de la mesure, `AAAA-MM`. */
  measureEndMonth: string;
  /** Les 3 mois d'avant, dans l'ordre, avec la déclaration qui compte ; `null` sans déclaration à temps. */
  beforeMonths: string[];
  before: number[] | null;
  beforeTotal: number | null;
  /** Les 3 mois d'après lus dans le registre ; un mois pas encore fini se lit, et se voit. */
  after: PilotMonth[];
  afterTotal: number;
  lines: PilotLine[];
  /** Le mois d'arrivée, à cheval : ni avant ni après [R641]. */
  arrivalMonthCounted: number;
  withdrawnOrCancelled: number;
  declarations: PilotDeclaration[];
  status: PilotStatus;
}

export interface PilotReport {
  currentMonth: string;
  minimum: number;
  pilots: PilotReportLine[];
  registerSound: boolean;
  condition: { met: boolean; reasons: PilotConditionReason[] };
}

const nextMonth = (month: string): string => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};
const previousMonth = (month: string): string => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};
/** Le jour de Paris d'un instant. */
const parisDate = (iso: string): string => localTime(new Date(iso), 'Europe/Paris').date;
/** Le dernier jour de Paris d'un mois, `AAAA-MM-JJ`. */
const lastDayOf = (month: string): string => parisDate(new Date(Date.parse(monthBounds(month)[1]) - 1).toISOString());

/** Le statut d'un pilote, dans cet ordre : parti, en cours, avant non déclaré à temps, plus ou pas plus [R642]. */
export function pilotStatus(p: { gone: boolean; finished: boolean; beforeTotal: number | null; afterTotal: number }): PilotStatus {
  if (p.gone) return 'parti';
  if (!p.finished) return 'en_cours';
  if (p.beforeTotal === null) return 'avant_non_declare';
  return p.afterTotal > p.beforeTotal ? 'plus' : 'pas_plus';
}

/** La condition de la phase 3 : au moins 3 pilotes, tous finis et « plus », registre sain [R642]. */
export function pilotCondition(statuses: readonly PilotStatus[], registerSound: boolean): { met: boolean; reasons: PilotConditionReason[] } {
  const reasons: PilotConditionReason[] = [];
  if (statuses.length < PILOT_MINIMUM) reasons.push('moins_de_3_pilotes');
  if (statuses.includes('en_cours')) reasons.push('pilote_en_cours');
  if (statuses.includes('parti')) reasons.push('pilote_parti');
  if (statuses.includes('avant_non_declare')) reasons.push('avant_non_declare');
  if (statuses.includes('pas_plus')) reasons.push('pas_plus');
  if (!registerSound) reasons.push('registre_abime');
  return { met: reasons.length === 0, reasons };
}

interface PilotRow {
  agent_id: string;
  status: string;
  arrived_at: string;
}

interface DeclarationRow {
  agent_id: string;
  version: number;
  month_1: number;
  month_2: number;
  month_3: number;
  proof_ref: string;
  declared_at: string;
}

interface RegisterRow {
  agent_id: string;
  number: string;
  hash: string;
  signed_at: string;
  cancel_reason: string | null;
}

interface Options {
  now?: () => Date;
}

export class AgentsPilotes {
  private readonly now: () => Date;
  private readonly registre: RegistreMandats;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: Options = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.registre = new RegistreMandats(db, journal, { now: this.now });
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  /** La direction seule ; tout autre rôle est refusé et le refus écrit au journal [R16]. */
  private async direction(viewer: Viewer, kind: string): Promise<PilotRefusal | null> {
    if (viewer.role === 'direction') return null;
    await appendEvent(
      this.journal,
      { type: 'acces.refuse', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind, code: 'role' } },
      this.now,
    );
    return { ok: false, rule: 'R16', code: 'role' };
  }

  private async refuse(viewer: Viewer, refusal: PilotRefusal): Promise<PilotRefusal> {
    await appendEvent(this.journal, { type: 'agents_pilotes.refuse', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: refusal.rule, code: refusal.code } }, this.now);
    return refusal;
  }

  private static shape(input: unknown, fields: readonly string[]): Record<string, unknown> | 'bad_shape' | 'unknown_field' {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return 'bad_shape';
    const raw = input as Record<string, unknown>;
    if (Object.keys(raw).some((k) => !fields.includes(k))) return 'unknown_field';
    return raw;
  }

  /** Désigne un agent actif du réseau comme pilote, une fois [R640]. */
  async designate(viewer: Viewer, input: unknown): Promise<{ ok: true; value: { agentId: string } } | PilotRefusal> {
    const denied = await this.direction(viewer, 'pilot_designation');
    if (denied) return denied;
    const raw = AgentsPilotes.shape(input, PILOT_DESIGNATION_FIELDS);
    if (typeof raw === 'string') return this.refuse(viewer, { ok: false, rule: null, code: raw });
    if (typeof raw.agentId !== 'string' || raw.agentId.length === 0) return this.refuse(viewer, { ok: false, rule: null, code: 'bad_agent' });
    const agent = await this.db.first<{ status: string }>('SELECT status FROM agents WHERE id = ? AND network_id = ?', [raw.agentId, viewer.networkId]);
    // Un agent d'un autre réseau est dit inconnu, comme un agent qui n'existe pas.
    if (!agent) return this.refuse(viewer, { ok: false, rule: 'R640', code: 'agent_inconnu' });
    if (agent.status !== 'active') return this.refuse(viewer, { ok: false, rule: 'R640', code: 'agent_parti' });
    try {
      await this.db.run('INSERT INTO pilot_agents (network_id, agent_id, designated_by, designated_at) VALUES (?, ?, ?, ?)', [
        viewer.networkId,
        raw.agentId,
        this.actor(viewer),
        this.now().toISOString(),
      ]);
    } catch {
      return this.refuse(viewer, { ok: false, rule: 'R640', code: 'deja_pilote' });
    }
    await appendEvent(this.journal, { type: 'agents_pilotes.designe', actor: this.actor(viewer), subject: `agent:${raw.agentId}`, data: {} }, this.now);
    return { ok: true, value: { agentId: raw.agentId } };
  }

  /**
   * Range les mandats signés dans chacun des 3 mois d'avant, avec la référence de leur preuve ; une version s'ajoute.
   * Une version rangée après le premier instant de la mesure est gardée, et ne comptera jamais [R640].
   */
  async declareBefore(viewer: Viewer, input: unknown): Promise<{ ok: true; value: { agentId: string; version: number; inTime: boolean } } | PilotRefusal> {
    const denied = await this.direction(viewer, 'pilot_before_declaration');
    if (denied) return denied;
    const raw = AgentsPilotes.shape(input, PILOT_DECLARATION_FIELDS);
    if (typeof raw === 'string') return this.refuse(viewer, { ok: false, rule: null, code: raw });
    if (typeof raw.agentId !== 'string' || raw.agentId.length === 0) return this.refuse(viewer, { ok: false, rule: null, code: 'bad_agent' });
    const months = raw.months;
    if (!Array.isArray(months) || months.length !== PILOT_MONTHS || !months.every((n) => Number.isSafeInteger(n) && n >= 0 && n <= PILOT_MONTH_MAX)) {
      return this.refuse(viewer, { ok: false, rule: 'R640', code: 'bad_months' });
    }
    if (typeof raw.proofRef !== 'string' || !PROOF_REF.test(raw.proofRef) || raw.proofRef.includes('..')) return this.refuse(viewer, { ok: false, rule: 'R640', code: 'bad_proof' });
    const pilot = await this.pilot(viewer.networkId, raw.agentId);
    if (!pilot) return this.refuse(viewer, { ok: false, rule: 'R640', code: 'pas_pilote' });
    const last = await this.db.first<{ version: number }>('SELECT MAX(version) AS version FROM pilot_before_declarations WHERE network_id = ? AND agent_id = ?', [viewer.networkId, raw.agentId]);
    const version = Number(last?.version ?? 0) + 1;
    const at = this.now().toISOString();
    const [m1, m2, m3] = months as [number, number, number];
    try {
      await this.db.run(
        'INSERT INTO pilot_before_declarations (network_id, agent_id, version, month_1, month_2, month_3, proof_ref, declared_by, declared_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [viewer.networkId, raw.agentId, version, m1, m2, m3, raw.proofRef, this.actor(viewer), at],
      );
    } catch {
      // Une autre déclaration est passée entre la lecture et l'écriture : rien n'est rangé.
      return this.refuse(viewer, { ok: false, rule: 'R640', code: 'conflit' });
    }
    const inTime = at < measureStartOf(pilot.arrived_at);
    // Les nombres et la preuve restent dans la table : le journal ne dit que la version et si elle compte.
    await appendEvent(this.journal, { type: 'agents_pilotes.avant_range', actor: this.actor(viewer), subject: `agent:${raw.agentId}`, data: { version, inTime } }, this.now);
    return { ok: true, value: { agentId: raw.agentId, version, inTime } };
  }

  private pilot(networkId: string, agentId: string): Promise<PilotRow | null> {
    return this.db.first<PilotRow>(
      `SELECT p.agent_id, a.status, COALESCE(o.created_at, a.created_at) AS arrived_at
         FROM pilot_agents p JOIN agents a ON a.id = p.agent_id AND a.network_id = p.network_id
         LEFT JOIN agent_onboardings o ON o.agent_id = p.agent_id AND o.network_id = p.network_id
        WHERE p.network_id = ? AND p.agent_id = ?`,
      [networkId, agentId],
    );
  }

  /** La comparaison de chaque pilote et la condition de la phase 3, recalculées à chaque lecture [R641, R642]. */
  async report(viewer: Viewer): Promise<{ ok: true; value: PilotReport } | PilotRefusal> {
    const denied = await this.direction(viewer, 'pilot_report');
    if (denied) return denied;
    const value = await this.compute(viewer.networkId);
    await appendEvent(
      this.journal,
      { type: 'agents_pilotes.lecture', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R16', pilots: value.pilots.length, met: value.condition.met } },
      this.now,
    );
    return { ok: true, value };
  }

  /** Le calcul, sans droits. */
  async compute(networkId: string): Promise<PilotReport> {
    const nowIso = this.now().toISOString();
    const currentMonth = parisMonth(this.now());
    const today = parisDate(nowIso);
    const pilots = await this.db.all<PilotRow>(
      `SELECT p.agent_id, a.status, COALESCE(o.created_at, a.created_at) AS arrived_at
         FROM pilot_agents p JOIN agents a ON a.id = p.agent_id AND a.network_id = p.network_id
         LEFT JOIN agent_onboardings o ON o.agent_id = p.agent_id AND o.network_id = p.network_id
        WHERE p.network_id = ?`,
      [networkId],
    );
    // Dans l'ordre de l'arrivée, jamais d'un nombre [R14].
    pilots.sort((a, b) => (a.arrived_at < b.arrived_at ? -1 : a.arrived_at > b.arrived_at ? 1 : a.agent_id < b.agent_id ? -1 : 1));
    const declarations = await this.db.all<DeclarationRow>(
      'SELECT agent_id, version, month_1, month_2, month_3, proof_ref, declared_at FROM pilot_before_declarations WHERE network_id = ? ORDER BY agent_id, version',
      [networkId],
    );
    // L'agent et le jour de signature sont ceux figés par la ligne du registre. Une rétractation rangée vaut retrait
    // même si la ligne d'annulation n'a pas pu s'écrire : le compte ne penche jamais vers le haut (comme IN01).
    const lines = await this.db.all<RegisterRow>(
      `SELECT r.agent_id, r.number, r.hash, r.signed_at, CASE WHEN w.mandate_id IS NOT NULL THEN 'withdrawal' ELSE c.reason END AS cancel_reason
         FROM mandate_register r
         JOIN pilot_agents p ON p.network_id = r.network_id AND p.agent_id = r.agent_id
         LEFT JOIN mandate_register c ON c.network_id = r.network_id AND c.kind = 'annulation' AND c.cancels_seq = r.seq
         LEFT JOIN mandate_withdrawals w ON w.mandate_id = r.mandate_id
        WHERE r.network_id = ? AND r.kind = 'inscription'
        ORDER BY r.seq`,
      [networkId],
    );
    const departures = await this.db.all<{ agent_id: string; leaves_on: string }>(
      `SELECT d.agent_id, d.leaves_on FROM agent_departures d JOIN pilot_agents p ON p.network_id = d.network_id AND p.agent_id = d.agent_id
        WHERE d.network_id = ? AND d.cancelled_at IS NULL`,
      [networkId],
    );

    const result: PilotReportLine[] = pilots.map((p) => {
      const arrivalMonth = parisMonth(new Date(p.arrived_at));
      const beforeMonths: string[] = [];
      for (let m = arrivalMonth, i = 0; i < PILOT_MONTHS; i++) beforeMonths.unshift((m = previousMonth(m)));
      const afterMonths: string[] = [];
      for (let m = arrivalMonth, i = 0; i < PILOT_MONTHS; i++) afterMonths.push((m = nextMonth(m)));
      const measureStart = measureStartOf(p.arrived_at);
      const measureEndMonth = afterMonths[PILOT_MONTHS - 1]!;
      const finished = currentMonth > measureEndMonth;

      const own = declarations.filter((d) => d.agent_id === p.agent_id);
      const inTime = own.filter((d) => d.declared_at < measureStart);
      const counting = inTime.length > 0 ? inTime[inTime.length - 1]! : null;
      const decl: PilotDeclaration[] = own.map((d) => ({
        version: Number(d.version),
        months: [Number(d.month_1), Number(d.month_2), Number(d.month_3)],
        proofRef: d.proof_ref,
        declaredAt: d.declared_at,
        inTime: d.declared_at < measureStart,
        counts: counting !== null && Number(d.version) === Number(counting.version),
      }));
      const before = counting ? [Number(counting.month_1), Number(counting.month_2), Number(counting.month_3)] : null;
      const beforeTotal = before ? before.reduce((s, n) => s + n, 0) : null;

      const after = afterMonths.map((month) => ({ month, counted: 0 }));
      const own_lines: PilotLine[] = [];
      let arrivalMonthCounted = 0;
      let withdrawnOrCancelled = 0;
      for (const l of lines) {
        if (l.agent_id !== p.agent_id) continue;
        const month = parisMonth(new Date(l.signed_at));
        const slot = after.find((a) => a.month === month);
        if (month !== arrivalMonth && !slot) continue;
        if (l.cancel_reason === 'error' || l.cancel_reason === 'withdrawal') {
          if (slot) withdrawnOrCancelled += 1;
          continue;
        }
        if (!slot) {
          arrivalMonthCounted += 1;
          continue;
        }
        slot.counted += 1;
        own_lines.push({ month, number: l.number, hash: l.hash, terminated: l.cancel_reason === 'termination' });
      }
      const afterTotal = after.reduce((s, a) => s + a.counted, 0);

      // Parti avant la fin de la mesure : départ maintenu dont le jour est atteint au plus tard le dernier jour du 3e
      // mois, ou fiche « partie » sans départ rangé.
      const lastDay = lastDayOf(measureEndMonth);
      const leaving = departures.filter((d) => d.agent_id === p.agent_id && d.leaves_on <= lastDay && d.leaves_on <= today);
      const gone = leaving.length > 0 || (p.status !== 'active' && !departures.some((d) => d.agent_id === p.agent_id && d.leaves_on > lastDay));

      return {
        agentId: p.agent_id,
        arrivedAt: p.arrived_at,
        arrivalMonth,
        measureStart,
        measureEndMonth,
        beforeMonths,
        before,
        beforeTotal,
        after,
        afterTotal,
        lines: own_lines,
        arrivalMonthCounted,
        withdrawnOrCancelled,
        declarations: decl,
        status: pilotStatus({ gone, finished, beforeTotal, afterTotal }),
      };
    });

    const registerSound = (await this.registre.check(networkId)).ok;
    return {
      currentMonth,
      minimum: PILOT_MINIMUM,
      pilots: result,
      registerSound,
      condition: pilotCondition(
        result.map((r) => r.status),
        registerSound,
      ),
    };
  }
}

/** Le premier instant de la mesure : le 1er du mois de Paris qui suit le mois d'arrivée, à minuit de Paris [R640]. */
export function measureStartOf(arrivedAt: string): string {
  return monthBounds(nextMonth(parisMonth(new Date(arrivedAt))))[0];
}
