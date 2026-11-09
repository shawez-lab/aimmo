/**
 * La porte des phases (HX71 ; Feuille de route : « Cinq phases, chacune ouverte seulement si la précédente a rempli sa
 * condition ») [R646, R647, R648, R16, R17].
 *
 * Chaque condition est déjà comptée dans son module, sans droits : la phase 1 par `ConditionPhase1` (HX70), la phase 2
 * par la page publiée de la preuve (`SceauxPreuve`, IN02 : le cahier dit « chiffres publiés », le compteur vivant seul
 * ne suffit pas), la phase 3 par `AgentsPilotes` (HX69), la phase 4 par le coût complet de l'agent moyen (`CoutAgent`,
 * HX65). Ce module les lit à l'instant, dit quelle phase est ouverte et laisse la direction ouvrir la suivante.
 *
 * Décidé, lecture prudente :
 *   - la phase 1 est ouverte d'office ; les autres ne s'ouvrent que par une décision de la direction, jamais seules ;
 *   - une condition dont le module ne se lit pas est « inconnue » : jamais remplie, et l'ouverture est refusée ;
 *   - phase 4, « la part du réseau couvre le coût complet de chaque agent » : les 3 mois finis de Paris qui précèdent
 *     le mois en cours sont tous complets et couverts (HX65, l'agent moyen), et tous commencés après le mois de
 *     l'ouverture de la phase 4 ; une phase 4 pas ouverte n'a pas de condition remplie.
 *
 * Jamais vu : une ouverture ne peut pas précéder sa preuve. Elle range la condition de la phase d'avant telle qu'elle
 * était lue à l'instant, avec son empreinte, et ne change plus. Si cette condition retombe ensuite (une annulation
 * tardive, un jour salissant recompté), l'état le dit « retombée » ; rien ne se ferme seul : revenir en arrière reste
 * une décision de Shawez.
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { sha256 } from '../documents/modeles.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { SceauxPreuve } from '../pilotage/preuve-sceau.ts';
import { parisMonth } from '../pilotage/preuve.ts';
import { CoutAgent } from '../reseau/cout-agent.ts';
import { ConditionPhase1 } from './phase1.ts';
import { AgentsPilotes } from './pilotes.ts';

export type PhaseNumber = 1 | 2 | 3 | 4 | 5;
export type GatedPhase = 1 | 2 | 3 | 4;
export const PHASE_NUMBERS: readonly PhaseNumber[] = [1, 2, 3, 4, 5];
export const PHASE_NAMES: Readonly<Record<PhaseNumber, string>> = {
  1: 'Socle',
  2: 'Preuve à Dijon',
  3: 'Pilote',
  4: '100 premiers agents',
  5: 'National, puis licence',
};
/** Les mois de suite, complets et couverts, qu'il faut à la phase 4. */
export const PHASE4_MONTHS = 3;
export const PHASE_OPEN_FIELDS = ['phase'] as const;
export const PHASE_OPENING_JOURNAL_TYPE = 'phases.ouverture';

/** Ce qu'un module rend pour une condition : jamais un nom, seulement des nombres, des mois et des raisons. */
export interface PhaseConditionReading {
  met: boolean;
  reasons: string[];
  evidence: Record<string, unknown>;
}

export type PhaseConditionState = 'remplie' | 'non_remplie' | 'inconnue' | 'sans_condition';

export interface PhaseConditionLine {
  state: PhaseConditionState;
  reasons: string[];
  evidence: Record<string, unknown> | null;
  /** L'empreinte de ce qui a été lu, `null` pour une condition inconnue ou sans condition. */
  hash: string | null;
}

export interface PhaseOpening {
  phase: PhaseNumber;
  openedAt: string;
  evidence: PhaseConditionReading;
  evidenceHash: string;
}

export interface PhaseLine {
  phase: PhaseNumber;
  name: string;
  open: boolean;
  /** `null` pour la phase 1, ouverte d'office, et pour une phase fermée. */
  opening: PhaseOpening | null;
  /** La condition pour passer à la phase suivante, lue à l'instant. */
  condition: PhaseConditionLine;
  /** La phase suivante est ouverte, mais cette condition ne se lit plus remplie [R648]. */
  fellSince: boolean;
  /** La direction peut ouvrir la phase suivante maintenant. */
  nextOpenable: boolean;
}

export interface PhasesReport {
  readAt: string;
  /** La dernière phase ouverte. */
  current: PhaseNumber;
  phases: PhaseLine[];
}

/** Chaque condition se lit par une fonction ; `openings` dit quand chaque phase s'est ouverte. */
export type PhaseConditionSources = Record<GatedPhase, (viewer: Viewer, openings: ReadonlyMap<PhaseNumber, string>) => Promise<PhaseConditionReading>>;

export type PhasesRefusal =
  | { ok: false; rule: 'R16'; code: 'role' }
  | { ok: false; rule: 'R647' | null; code: string; reasons?: string[] };

/** L'empreinte d'une condition lue : la phase, le verdict, les raisons et la preuve, dans cet ordre. */
export const phaseConditionHash = (phase: GatedPhase, r: PhaseConditionReading): Promise<string> => sha256(JSON.stringify([phase, r.met, r.reasons, r.evidence]));

const previousMonth = (month: string): string => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

/** Les mois finis à lire pour la phase 4, du plus ancien au plus récent : les 3 qui précèdent le mois en cours. */
export function phase4Months(currentMonth: string): string[] {
  const months: string[] = [];
  let m = currentMonth;
  for (let i = 0; i < PHASE4_MONTHS; i += 1) {
    m = previousMonth(m);
    months.unshift(m);
  }
  return months;
}

/**
 * La condition de la phase 4 [R648] : phase 4 ouverte, puis chacun des 3 mois finis qui précèdent le mois en cours
 * commencé après le mois de l'ouverture, complet et couvert. Chaque raison contraire est dite.
 */
export function phase4Condition(
  openedMonth: string | null,
  months: readonly { month: string; complete: boolean; covered: boolean }[],
): PhaseConditionReading {
  if (openedMonth === null) return { met: false, reasons: ['phase_non_ouverte'], evidence: { months: [] } };
  const reasons = new Set<string>();
  if (months.length < PHASE4_MONTHS) reasons.add('pas_assez_de_mois');
  for (const m of months) {
    if (m.month <= openedMonth) reasons.add('pas_assez_de_mois');
    if (!m.complete) reasons.add('mois_incomplet');
    else if (!m.covered) reasons.add('mois_non_couvert');
  }
  return {
    met: reasons.size === 0,
    reasons: [...reasons],
    evidence: { openedMonth, months: months.map((m) => ({ month: m.month, complete: m.complete, covered: m.covered })) },
  };
}

/** Les conditions lues dans les modules qui les comptent, sans droits de plus que ceux de la direction. */
export function defaultPhaseSources(db: SqlDatabase, journal: JournalStore, now: () => Date): PhaseConditionSources {
  const phase1 = new ConditionPhase1(db, journal, { now });
  const seals = new SceauxPreuve(db, journal, { now });
  const pilots = new AgentsPilotes(db, journal, { now });
  const cost = new CoutAgent(db, journal, { now });
  return {
    1: async (viewer) => {
      const r = await phase1.compute(viewer.networkId);
      const last = r.inventories.at(-1);
      return {
        met: r.condition.met,
        reasons: [...r.condition.reasons],
        evidence: { lastDay: r.lastDay, required: r.required, countFrom: r.countFrom, countedSeries: r.countedSeries, inventory: last ? { version: last.version, total: last.total } : null },
      };
    },
    2: async (viewer) => {
      const p = await seals.publication(viewer.networkId);
      const reasons: string[] = [];
      if (!p.chainSound) reasons.push('chaine_abimee');
      if (!p.registerSound) reasons.push('registre_abime');
      if (!p.condition.met && reasons.length === 0) reasons.push('serie_publiee_trop_courte');
      return {
        met: p.condition.met,
        reasons,
        evidence: {
          metOn: p.condition.metOn,
          months: p.months.map((m) => ({ month: m.month, counted: m.counted, sealSeq: m.sealSeq, changedSinceSeal: m.changedSinceSeal })),
          lastSealHash: p.seals.at(-1)?.hash ?? null,
        },
      };
    },
    3: async (viewer) => {
      const r = await pilots.compute(viewer.networkId);
      const statuses: Record<string, number> = {};
      for (const p of r.pilots) statuses[p.status] = (statuses[p.status] ?? 0) + 1;
      return { met: r.condition.met, reasons: [...r.condition.reasons], evidence: { pilots: r.pilots.length, statuses, registerSound: r.registerSound } };
    },
    4: async (viewer, openings) => {
      const openedAt = openings.get(4);
      if (openedAt === undefined) return phase4Condition(null, []);
      const months: { month: string; complete: boolean; covered: boolean }[] = [];
      for (const month of phase4Months(parisMonth(now()))) {
        const r = await cost.month(viewer, month);
        if (!r.ok) throw new Error(`phase 4 : mois ${month} illisible (${r.code})`);
        months.push({ month, complete: r.value.complete, covered: r.value.covered });
      }
      return phase4Condition(parisMonth(new Date(openedAt)), months);
    },
  };
}

interface OpeningRow {
  phase: number;
  opened_at: string;
  evidence: string;
  evidence_hash: string;
}

export class PortesPhases {
  private readonly now: () => Date;
  private readonly sources: PhaseConditionSources;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: { now?: () => Date; sources?: PhaseConditionSources } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.sources = options.sources ?? defaultPhaseSources(db, journal, this.now);
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  /** La direction seule ; tout autre rôle est refusé et le refus écrit au journal [R16]. */
  private async direction(viewer: Viewer, kind: string): Promise<PhasesRefusal | null> {
    if (viewer.role === 'direction') return null;
    await appendEvent(
      this.journal,
      { type: 'acces.refuse', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind, code: 'role' } },
      this.now,
    );
    return { ok: false, rule: 'R16', code: 'role' };
  }

  private async refuse(viewer: Viewer, refusal: Exclude<PhasesRefusal, { rule: 'R16' }>): Promise<PhasesRefusal> {
    await appendEvent(
      this.journal,
      { type: 'phases.refuse', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: refusal.rule, code: refusal.code, reasons: refusal.reasons ?? [] } },
      this.now,
    );
    return refusal;
  }

  private async openings(networkId: string): Promise<PhaseOpening[]> {
    const rows = await this.db.all<OpeningRow>('SELECT phase, opened_at, evidence, evidence_hash FROM phase_openings WHERE network_id = ? ORDER BY phase', [networkId]);
    return rows.map((r) => ({ phase: Number(r.phase) as PhaseNumber, openedAt: r.opened_at, evidence: JSON.parse(r.evidence) as PhaseConditionReading, evidenceHash: r.evidence_hash }));
  }

  /** Une condition lue à l'instant ; une lecture impossible est « inconnue », jamais remplie [R646]. */
  private async condition(phase: GatedPhase, viewer: Viewer, openedAt: ReadonlyMap<PhaseNumber, string>): Promise<{ line: PhaseConditionLine; reading: PhaseConditionReading | null }> {
    let reading: PhaseConditionReading;
    try {
      reading = await this.sources[phase](viewer, openedAt);
    } catch {
      return { line: { state: 'inconnue', reasons: ['lecture_impossible'], evidence: null, hash: null }, reading: null };
    }
    if (typeof reading?.met !== 'boolean' || !Array.isArray(reading.reasons)) {
      return { line: { state: 'inconnue', reasons: ['lecture_impossible'], evidence: null, hash: null }, reading: null };
    }
    const hash = await phaseConditionHash(phase, reading);
    return { line: { state: reading.met ? 'remplie' : 'non_remplie', reasons: [...reading.reasons], evidence: reading.evidence, hash }, reading };
  }

  private static openedMap(openings: readonly PhaseOpening[]): Map<PhaseNumber, string> {
    const map = new Map<PhaseNumber, string>();
    for (const o of openings) map.set(o.phase, o.openedAt);
    return map;
  }

  /** L'état des cinq phases, pour la direction seule ; la lecture est écrite au journal avant d'être rendue [R646, R648, R16]. */
  async report(viewer: Viewer): Promise<{ ok: true; value: PhasesReport } | PhasesRefusal> {
    const denied = await this.direction(viewer, 'phases_report');
    if (denied) return denied;
    const openings = await this.openings(viewer.networkId);
    const openedAt = PortesPhases.openedMap(openings);
    const isOpen = (p: PhaseNumber): boolean => p === 1 || openedAt.has(p);
    const phases: PhaseLine[] = [];
    for (const phase of PHASE_NUMBERS) {
      const condition: PhaseConditionLine = phase === 5 ? { state: 'sans_condition', reasons: [], evidence: null, hash: null } : (await this.condition(phase, viewer, openedAt)).line;
      const next = (phase + 1) as PhaseNumber;
      const nextOpen = phase < 5 && isOpen(next);
      phases.push({
        phase,
        name: PHASE_NAMES[phase],
        open: isOpen(phase),
        opening: openings.find((o) => o.phase === phase) ?? null,
        condition,
        fellSince: nextOpen && condition.state !== 'remplie',
        nextOpenable: phase < 5 && isOpen(phase) && !nextOpen && condition.state === 'remplie',
      });
    }
    const current = [...PHASE_NUMBERS].reverse().find((p) => isOpen(p)) ?? 1;
    const value: PhasesReport = { readAt: this.now().toISOString(), current, phases };
    await appendEvent(
      this.journal,
      {
        type: 'phases.lecture',
        actor: this.actor(viewer),
        subject: `network:${viewer.networkId}`,
        data: { rule: 'R16', current, conditions: phases.map((p) => p.condition.state), fell: phases.filter((p) => p.fellSince).map((p) => p.phase) },
      },
      this.now,
    );
    return { ok: true, value };
  }

  /**
   * Ouvre une phase, de 2 à 5, pour la direction seule [R647] : la phase d'avant doit être ouverte et sa condition
   * remplie à cet instant ; la condition lue est rangée avec son empreinte, une seule fois, et ne change plus.
   */
  async open(viewer: Viewer, input: unknown): Promise<{ ok: true; value: PhaseOpening } | PhasesRefusal> {
    const denied = await this.direction(viewer, 'phase_open');
    if (denied) return denied;
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return this.refuse(viewer, { ok: false, rule: null, code: 'bad_shape' });
    const raw = input as Record<string, unknown>;
    if (Object.keys(raw).some((k) => !(PHASE_OPEN_FIELDS as readonly string[]).includes(k))) return this.refuse(viewer, { ok: false, rule: null, code: 'unknown_field' });
    const phase = raw.phase;
    if (typeof phase !== 'number' || !Number.isInteger(phase) || phase < 2 || phase > 5) return this.refuse(viewer, { ok: false, rule: 'R647', code: 'bad_phase' });
    const target = phase as 2 | 3 | 4 | 5;
    const before = (target - 1) as GatedPhase;
    const openings = await this.openings(viewer.networkId);
    const openedAt = PortesPhases.openedMap(openings);
    if (openedAt.has(target)) return this.refuse(viewer, { ok: false, rule: 'R647', code: 'deja_ouverte' });
    if (before !== 1 && !openedAt.has(before)) return this.refuse(viewer, { ok: false, rule: 'R647', code: 'phase_precedente_fermee' });
    const { line, reading } = await this.condition(before, viewer, openedAt);
    if (reading === null || line.hash === null) return this.refuse(viewer, { ok: false, rule: 'R647', code: 'condition_inconnue', reasons: line.reasons });
    if (!reading.met) return this.refuse(viewer, { ok: false, rule: 'R647', code: 'condition_non_remplie', reasons: line.reasons });
    const at = this.now().toISOString();
    try {
      await this.db.run('INSERT INTO phase_openings (network_id, phase, opened_at, opened_by, evidence, evidence_hash) VALUES (?, ?, ?, ?, ?, ?)', [
        viewer.networkId,
        target,
        at,
        this.actor(viewer),
        JSON.stringify(reading),
        line.hash,
      ]);
    } catch (error) {
      // Une autre ouverture est passée entre la lecture et l'écriture : la base garde la première [R647]. Toute autre
      // panne remonte telle quelle : rien n'est dit ouvert.
      const again = PortesPhases.openedMap(await this.openings(viewer.networkId));
      if (again.has(target)) return this.refuse(viewer, { ok: false, rule: 'R647', code: 'deja_ouverte' });
      throw error;
    }
    await appendEvent(
      this.journal,
      { type: PHASE_OPENING_JOURNAL_TYPE, actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R647', phase: target, hash: line.hash } },
      this.now,
    );
    return { ok: true, value: { phase: target, openedAt: at, evidence: reading, evidenceHash: line.hash } };
  }
}
