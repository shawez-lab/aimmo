/**
 * Rapports sur mesure (M13, HX62) [R14, R16, R69, R560].
 *
 * Un rapport se compose dans un catalogue fermé : des mesures (contacts attribués, rendez-vous tenus, mandats signés,
 * ventes conclues) et un regroupement (total ou mois de Paris). Il se lit sur une période d'un an au plus, pour un seul
 * agent ou pour le réseau entier, jamais agent par agent : aucun regroupement, aucune portée ne met deux agents côte à
 * côte [R14]. Chaque chiffre est le nombre exact des lignes qu'il montre, comme en K04 [R69] ; les lignes ne portent
 * que des identifiants et des dates, la fiche se lit à part sous ses droits.
 *
 * Un agent ne lit que ses propres chiffres ; la direction lit ceux d'un agent de son réseau ou le total du réseau ; les
 * autres rôles ne lisent rien [R16]. Un rapport enregistré n'est lu que par celui qui l'a enregistré.
 */
import { decideAccess, type Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { MAX_PERIOD_DAYS, parisDayStart } from '../pilotage/tableau-agent.ts';

const TIME_ZONE = 'Europe/Paris';
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const REPORT_MEASURES = ['contacts', 'rendez_vous', 'mandats', 'ventes'] as const;
export type ReportMeasure = (typeof REPORT_MEASURES)[number];
export const REPORT_GROUPINGS = ['total', 'mois'] as const;
export type ReportGrouping = (typeof REPORT_GROUPINGS)[number];

export interface ReportDefinition {
  measures: ReportMeasure[];
  grouping: ReportGrouping;
}

export interface ReportLine {
  id: string;
  at: string;
}

export interface ReportCell {
  measure: ReportMeasure;
  /** `total`, ou le mois de Paris `AAAA-MM`. */
  key: string;
  value: number;
  lines: ReportLine[];
}

export interface ReportResult {
  scope: 'agent' | 'reseau';
  /** L'agent lu ; absent pour le total du réseau. */
  agentId?: string;
  from: string;
  to: string;
  definition: ReportDefinition;
  cells: ReportCell[];
}

type Refusal = { ok: false; rule: 'R16' | 'R14' | 'R560'; code: string };
type Problem = { ok: false; rule: null; code: 'bad_period' | 'bad_name' | 'unknown_report' };

const validDay = (v: unknown): v is string => {
  if (typeof v !== 'string' || !DAY.test(v)) return false;
  const d = new Date(`${v}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
const nextDay = (day: string): string => new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** Mots qui mettraient des agents côte à côte : refusés au nom de R14, où qu'ils soient dans la définition. */
const COMPARING = /agent|conseiller|classement|rang|compar/i;

/** Vérifie une définition venue de l'écran : catalogue fermé, aucune clé de plus [R560], jamais par agent [R14]. */
export function parseDefinition(input: unknown): { ok: true; value: ReportDefinition } | { ok: false; rule: 'R14' | 'R560'; code: string } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { ok: false, rule: 'R560', code: 'bad_definition' };
  if (COMPARING.test(JSON.stringify(input))) return { ok: false, rule: 'R14', code: 'compares_agents' };
  const o = input as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== 'measures' && k !== 'grouping')) return { ok: false, rule: 'R560', code: 'bad_definition' };
  const { measures, grouping } = o;
  if (!Array.isArray(measures) || measures.length === 0 || measures.length > REPORT_MEASURES.length) return { ok: false, rule: 'R560', code: 'bad_measures' };
  if (!measures.every((m): m is ReportMeasure => typeof m === 'string' && (REPORT_MEASURES as readonly string[]).includes(m))) return { ok: false, rule: 'R560', code: 'bad_measures' };
  if (new Set(measures).size !== measures.length) return { ok: false, rule: 'R560', code: 'bad_measures' };
  if (typeof grouping !== 'string' || !(REPORT_GROUPINGS as readonly string[]).includes(grouping)) return { ok: false, rule: 'R560', code: 'bad_grouping' };
  // Ordre du catalogue : deux définitions des mêmes mesures s'écrivent pareil.
  return { ok: true, value: { measures: REPORT_MEASURES.filter((m) => measures.includes(m)), grouping: grouping as ReportGrouping } };
}

export class RapportsSurMesure {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  private async refuse(viewer: Viewer, rule: Refusal['rule'], code: string): Promise<Refusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule, role: String(viewer.role), kind: 'custom_report', code } }, this.now);
    return { ok: false, rule, code };
  }

  /** Un agent encore actif dans le réseau du lecteur, ou la direction ; personne d'autre ne compose de rapport [R16]. */
  private async author(viewer: Viewer): Promise<string | null> {
    if (viewer.role === 'direction') {
      const d = decideAccess(viewer, { kind: 'figures', networkId: viewer.networkId, agentId: viewer.userId });
      return d.allowed ? null : d.code;
    }
    if (viewer.role !== 'agent') return 'role';
    const me = await this.db.first<{ network_id: string; status: string }>('SELECT network_id, status FROM agents WHERE id = ?', [viewer.userId]);
    return me && me.network_id === viewer.networkId && me.status === 'active' ? null : 'agent_inactive';
  }

  /** Enregistre une définition, pour la relire plus tard ; elle ne change plus. */
  async save(viewer: Viewer, input: { name: unknown; definition: unknown }): Promise<{ ok: true; value: { id: string } } | Refusal | Problem> {
    const blocked = await this.author(viewer);
    if (blocked) return this.refuse(viewer, 'R16', blocked);
    const def = parseDefinition(input.definition);
    if (!def.ok) return this.refuse(viewer, def.rule, def.code);
    if (typeof input.name !== 'string' || input.name.trim().length < 1 || input.name.trim().length > 80) return { ok: false, rule: null, code: 'bad_name' };
    const id = this.newId();
    await this.db.run('INSERT INTO custom_reports (id, network_id, owner_id, owner_role, name, definition, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      id,
      viewer.networkId,
      viewer.userId,
      viewer.role,
      input.name.trim(),
      JSON.stringify(def.value),
      this.now().toISOString(),
    ]);
    await appendEvent(this.journal, { type: 'rapport.enregistre', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `report:${id}`, data: { measures: def.value.measures, grouping: def.value.grouping } }, this.now);
    return { ok: true, value: { id } };
  }

  /** Les rapports enregistrés par le lecteur, et par lui seul. */
  async list(viewer: Viewer): Promise<{ ok: true; value: { id: string; name: string; definition: ReportDefinition; createdAt: string }[] } | Refusal> {
    const blocked = await this.author(viewer);
    if (blocked) return this.refuse(viewer, 'R16', blocked);
    const rows = await this.db.all<{ id: string; name: string; definition: string; created_at: string }>(
      'SELECT id, name, definition, created_at FROM custom_reports WHERE network_id = ? AND owner_id = ? AND owner_role = ? ORDER BY created_at, id',
      [viewer.networkId, viewer.userId, viewer.role],
    );
    return { ok: true, value: rows.map((r) => ({ id: r.id, name: r.name, definition: JSON.parse(r.definition) as ReportDefinition, createdAt: r.created_at })) };
  }

  /** Lit un rapport enregistré par le lecteur. */
  async runSaved(viewer: Viewer, reportId: string, input: { from: unknown; to: unknown; agentId?: string; network?: boolean }): Promise<{ ok: true; value: ReportResult } | Refusal | Problem> {
    const blocked = await this.author(viewer);
    if (blocked) return this.refuse(viewer, 'R16', blocked);
    const row = await this.db.first<{ definition: string }>('SELECT definition FROM custom_reports WHERE id = ? AND network_id = ? AND owner_id = ? AND owner_role = ?', [
      reportId,
      viewer.networkId,
      viewer.userId,
      viewer.role,
    ]);
    if (!row) return { ok: false, rule: null, code: 'unknown_report' };
    return this.run(viewer, { ...input, definition: JSON.parse(row.definition) as unknown });
  }

  /**
   * Lit un rapport. Portée : l'agent lecteur par défaut ; `agentId` pour la direction qui lit un agent de son réseau ;
   * `network: true` pour le total du réseau, par la direction seule. Jamais deux agents à la fois [R14].
   */
  async run(viewer: Viewer, input: { definition: unknown; from: unknown; to: unknown; agentId?: string; network?: boolean }): Promise<{ ok: true; value: ReportResult } | Refusal | Problem> {
    const blocked = await this.author(viewer);
    if (blocked) return this.refuse(viewer, 'R16', blocked);
    const def = parseDefinition(input.definition);
    if (!def.ok) return this.refuse(viewer, def.rule, def.code);
    if (input.network === true && input.agentId !== undefined) return this.refuse(viewer, 'R14', 'compares_agents');

    let agentId: string | undefined;
    if (input.network === true) {
      if (viewer.role !== 'direction') return this.refuse(viewer, 'R16', 'role');
    } else {
      agentId = input.agentId ?? viewer.userId;
      const agent = await this.db.first<{ network_id: string }>('SELECT network_id FROM agents WHERE id = ?', [agentId]);
      const decision = decideAccess(viewer, { kind: 'figures', networkId: agent?.network_id ?? '', agentId });
      if (!agent || !decision.allowed) return this.refuse(viewer, 'R16', agent ? (decision.allowed ? 'role' : decision.code) : 'unknown');
    }
    if (!validDay(input.from) || !validDay(input.to) || input.from > input.to) return { ok: false, rule: null, code: 'bad_period' };
    if ((Date.parse(`${input.to}T12:00:00Z`) - Date.parse(`${input.from}T12:00:00Z`)) / 86_400_000 >= MAX_PERIOD_DAYS) return { ok: false, rule: null, code: 'bad_period' };
    const start = parisDayStart(input.from).toISOString();
    const end = parisDayStart(nextDay(input.to)).toISOString();
    const net = viewer.networkId;
    const who = agentId === undefined ? '' : ' AND agent_id = ?';
    const args = (bounds: [string, string]) => (agentId === undefined ? [net, ...bounds] : [net, agentId, ...bounds]);

    const cells: ReportCell[] = [];
    for (const measure of def.value.measures) {
      let lines: ReportLine[];
      if (measure === 'contacts') {
        lines = await this.db.all<ReportLine>(`SELECT id, created_at AS at FROM attributions WHERE network_id = ?${who} AND created_at >= ? AND created_at < ? ORDER BY created_at, id`, args([start, end]));
      } else if (measure === 'rendez_vous') {
        lines = await this.db.all<ReportLine>(
          `SELECT id, start_at AS at FROM appointments WHERE network_id = ?${who} AND status = 'honored' AND start_at >= ? AND start_at < ? ORDER BY start_at, id`,
          args([start, end]),
        );
      } else if (measure === 'mandats') {
        lines = await this.db.all<ReportLine>(`SELECT id, signed_at AS at FROM mandates WHERE network_id = ?${who} AND signed_at >= ? AND signed_at < ? ORDER BY signed_at, id`, args([start, end]));
      } else {
        // Une vente : un acte signé ce jour de Paris, comme en K04.
        lines = await this.db.all<ReportLine>(`SELECT file_id AS id, due_on AS at FROM sale_commissions WHERE network_id = ?${who} AND due_on >= ? AND due_on <= ? ORDER BY due_on, file_id`, args([input.from, input.to]));
      }
      const groups = new Map<string, ReportLine[]>();
      if (def.value.grouping === 'total') groups.set('total', lines);
      else {
        // Chaque mois de la période apparaît, même vide : un mois sans ligne se lit zéro, il ne disparaît pas.
        for (let m = input.from.slice(0, 7); m <= input.to.slice(0, 7); m = nextMonth(m)) groups.set(m, []);
        for (const line of lines) groups.get(monthOf(line.at))?.push(line);
      }
      for (const [key, ls] of groups) cells.push({ measure, key, value: ls.length, lines: ls.map((l) => ({ id: l.id, at: l.at })) });
    }
    const value: ReportResult = { scope: agentId === undefined ? 'reseau' : 'agent', ...(agentId === undefined ? {} : { agentId }), from: input.from, to: input.to, definition: def.value, cells };
    // Au journal : qui a lu quoi, jamais un chiffre [R13].
    await appendEvent(
      this.journal,
      { type: 'pilotage.lecture', actor: `${String(viewer.role)}:${viewer.userId}`, subject: agentId === undefined ? `network:${net}` : `agent:${agentId}`, data: { kind: 'custom_report', from: input.from, to: input.to, measures: def.value.measures, grouping: def.value.grouping } },
      this.now,
    );
    return { ok: true, value };
  }
}

const nextMonth = (m: string): string => {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
};

/** Le mois de Paris d'un instant ; un jour `AAAA-MM-JJ` est déjà un jour de Paris. */
const monthOf = (at: string): string => (DAY.test(at) ? at.slice(0, 7) : localTime(new Date(at), TIME_ZONE).date.slice(0, 7));
