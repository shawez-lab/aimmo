/**
 * Procédure de fuite de données (M12, L08) [R16, R97].
 *
 * Cahier, Conformité, « Fuite de données » : couper l'accès, évaluer, prévenir la CNIL sous 72 heures s'il existe un
 * risque, et les personnes si le risque est élevé (RGPD, articles 33 et 34).
 *
 * - Le responsable de la conformité enregistre la fuite avec le moment où il en a eu connaissance ; le code calcule
 *   l'échéance, 72 heures plus tard, en heures exactes (un changement d'heure n'y change rien).
 * - Les accès se coupent d'un geste : toutes les clés du réseau, sauf celles du responsable, ou celles d'une seule
 *   personne. Les clés remises par invitation sont retirées en base ; celles du secret `API_KEYS`, que le code ne
 *   peut pas réécrire, sont refusées par `accessCut`, que le socle lit avant toute route (branchement : L09). La
 *   direction peut aussi couper : une fuite n'attend pas.
 * - L'évaluation est saisie par le responsable, en listes fermées, sans texte libre : risque, nature, catégories de
 *   données et personnes concernées. Le code en tire ce qui est dû : la CNIL dès qu'il existe un risque, les personnes
 *   si le risque est élevé ; la liste des personnes concernées est figée à chaque évaluation, par fiche gardée.
 * - Les alertes au responsable partent dès la connaissance, 24 heures puis 6 heures avant l'échéance, puis à
 *   l'échéance, une fois chacune, tant que la CNIL n'est pas prévenue et que l'évaluation ne dit pas « aucun risque ».
 * - Rien n'est envoyé : ni à la CNIL, ni aux personnes. Le responsable note ce qu'il a fait ; une notification à la
 *   CNIL après l'échéance porte sa raison (article 33.1).
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { FicheUnique } from '../fiche/fusion.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { sha256Of } from './demandes-personnes.ts';

const HOUR = 3_600_000;
/** L'échéance de la CNIL : 72 heures après la connaissance de la fuite (article 33.1). */
export const BREACH_DEADLINE_HOURS = 72;
/** Les alertes au responsable, en heures avant l'échéance. */
export const BREACH_ALERTS = [
  { kind: 'connaissance', before: BREACH_DEADLINE_HOURS },
  { kind: 'h24', before: 24 },
  { kind: 'h6', before: 6 },
  { kind: 'echeance', before: 0 },
] as const;
export type BreachAlertKind = (typeof BREACH_ALERTS)[number]['kind'];

export const BREACH_RISKS = ['aucun', 'risque', 'eleve'] as const;
export type BreachRisk = (typeof BREACH_RISKS)[number];
export const BREACH_NATURES = ['confidentialite', 'integrite', 'disponibilite'] as const;
export type BreachNature = (typeof BREACH_NATURES)[number];
export const BREACH_CATEGORIES = ['identite', 'coordonnees', 'projet_et_budget', 'messages', 'pieces_identite', 'donnees_financieres', 'documents_signes', 'acces_et_cles'] as const;
export type BreachCategory = (typeof BREACH_CATEGORIES)[number];
export const BREACH_LATE_CAUSES = ['evaluation_en_cours', 'information_du_sous_traitant', 'autre'] as const;
export type BreachLateCause = (typeof BREACH_LATE_CAUSES)[number];

export type BreachScope = { kind: 'reseau' } | { kind: 'agent'; agentId: string } | { kind: 'personnes'; personIds: readonly string[] };
export type CutScope = { kind: 'tous' } | { kind: 'utilisateur'; userId: string };

export interface BreachEvaluation {
  version: number;
  risk: BreachRisk;
  nature: BreachNature[];
  categories: BreachCategory[];
  scope: BreachScope['kind'];
  agentId: string | null;
  personsCount: number;
  personsSha256: string;
}

export interface Breach {
  id: string;
  awareAt: string;
  deadlineAt: string;
  evaluation: BreachEvaluation | null;
  /** Ce que la loi demande, d'après la dernière évaluation ; sans évaluation, la CNIL est due par prudence. */
  due: { cnil: boolean; personnes: boolean };
  notified: { cnil: { at: string; late: boolean } | null; personnes: { at: string; late: boolean } | null };
  cuts: { id: string; scope: CutScope['kind']; userId: string | null; keysRevoked: number; cutAt: string; restoredAt: string | null }[];
}

export interface BreachAlert {
  breachId: string;
  kind: BreachAlertKind;
  deadlineAt: string;
  createdAt: string;
  text: string;
}

export type BreachRefusal = { ok: false; rule: 'R16' | null; code: string };
type Result<T> = { ok: true; value: T } | BreachRefusal;

interface BreachRow {
  id: string;
  network_id: string;
  aware_at: string;
  deadline_at: string;
}

const validInstant = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(v) && !Number.isNaN(Date.parse(v));
const closedList = <T extends string>(values: unknown, allowed: readonly T[]): T[] | null => {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (!values.every((v) => typeof v === 'string' && (allowed as readonly string[]).includes(v))) return null;
  return [...new Set(values as T[])].sort();
};

/** Ce que la loi demande pour une évaluation : la CNIL dès qu'il existe un risque, les personnes s'il est élevé. */
export function breachDue(risk: BreachRisk | null): { cnil: boolean; personnes: boolean } {
  if (risk === null) return { cnil: true, personnes: false };
  return { cnil: risk !== 'aucun', personnes: risk === 'eleve' };
}

/** L'échéance, en heures exactes. */
export function breachDeadline(awareAt: string): string {
  return new Date(Date.parse(awareAt) + BREACH_DEADLINE_HOURS * HOUR).toISOString();
}

export class Fuites {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly fiche: FicheUnique,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, code: string): Promise<BreachRefusal> {
    await appendEvent(
      this.journal,
      { type: 'acces.refuse', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'fuites', code } },
      this.now,
    );
    return { ok: false, rule: 'R16', code };
  }

  private async breachOf(viewer: Viewer, breachId: string): Promise<BreachRow | null> {
    if (typeof breachId !== 'string') return null;
    return this.db.first<BreachRow>('SELECT * FROM data_breaches WHERE id = ? AND network_id = ?', [breachId, viewer.networkId]);
  }

  private async latestEvaluation(breachId: string): Promise<BreachEvaluation | null> {
    const r = await this.db.first<{ version: number; risk: BreachRisk; nature: string; categories: string; scope: BreachScope['kind']; agent_id: string | null; concerned_count: number; persons_sha256: string }>(
      'SELECT * FROM data_breach_evaluations WHERE breach_id = ? ORDER BY version DESC LIMIT 1',
      [breachId],
    );
    if (!r) return null;
    return { version: r.version, risk: r.risk, nature: JSON.parse(r.nature) as BreachNature[], categories: JSON.parse(r.categories) as BreachCategory[], scope: r.scope, agentId: r.agent_id, personsCount: r.concerned_count, personsSha256: r.persons_sha256 };
  }

  private async view(row: BreachRow): Promise<Breach> {
    const evaluation = await this.latestEvaluation(row.id);
    const notes = await this.db.all<{ target: 'cnil' | 'personnes'; notified_at: string; late: number }>('SELECT target, notified_at, late FROM data_breach_notifications WHERE breach_id = ?', [row.id]);
    const note = (target: 'cnil' | 'personnes') => {
      const n = notes.find((x) => x.target === target);
      return n ? { at: n.notified_at, late: n.late === 1 } : null;
    };
    const cuts = await this.db.all<{ id: string; scope: CutScope['kind']; user_id: string | null; keys_revoked: number; cut_at: string; restored_at: string | null }>(
      'SELECT c.id, c.scope, c.user_id, c.keys_revoked, c.cut_at, r.restored_at FROM data_breach_cuts c LEFT JOIN data_breach_restores r ON r.cut_id = c.id WHERE c.breach_id = ? ORDER BY c.cut_at, c.id',
      [row.id],
    );
    return {
      id: row.id,
      awareAt: row.aware_at,
      deadlineAt: row.deadline_at,
      evaluation,
      due: breachDue(evaluation?.risk ?? null),
      notified: { cnil: note('cnil'), personnes: note('personnes') },
      cuts: cuts.map((c) => ({ id: c.id, scope: c.scope, userId: c.user_id, keysRevoked: c.keys_revoked, cutAt: c.cut_at, restoredAt: c.restored_at })),
    };
  }

  /** Le responsable enregistre une fuite et le moment où il en a eu connaissance ; l'échéance est calculée par le code. */
  async declare(viewer: Viewer, input: { awareAt: string }): Promise<Result<Breach>> {
    if (viewer.role !== 'compliance') return this.refuse(viewer, 'role');
    if (!validInstant(input.awareAt)) return { ok: false, rule: null, code: 'bad_date' };
    const awareAt = new Date(Date.parse(input.awareAt)).toISOString();
    if (Date.parse(awareAt) > this.now().getTime()) return { ok: false, rule: null, code: 'future_date' };
    const id = this.newId();
    const deadlineAt = breachDeadline(awareAt);
    await this.db.run('INSERT INTO data_breaches (id, network_id, aware_at, deadline_at, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?)', [
      id,
      viewer.networkId,
      awareAt,
      deadlineAt,
      this.actor(viewer),
      this.now().toISOString(),
    ]);
    await appendEvent(this.journal, { type: 'rgpd.fuite', actor: this.actor(viewer), subject: `breach:${id}`, data: { rule: 'R97', awareAt, deadlineAt } }, this.now);
    return { ok: true, value: await this.view((await this.breachOf(viewer, id))!) };
  }

  /**
   * Coupe les accès d'un geste. `tous` : chaque clé du réseau remise par invitation est retirée, sauf celles du
   * responsable, et `accessCut` refuse aussi les clés du secret ; `utilisateur` : les clés d'une seule personne.
   */
  async cutAccess(viewer: Viewer, breachId: string, scope: CutScope): Promise<Result<Breach>> {
    if (viewer.role !== 'compliance' && viewer.role !== 'direction') return this.refuse(viewer, 'role');
    const row = await this.breachOf(viewer, breachId);
    if (!row) return { ok: false, rule: null, code: 'unknown' };
    if (!scope || (scope.kind !== 'tous' && scope.kind !== 'utilisateur')) return { ok: false, rule: null, code: 'bad_scope' };
    if (scope.kind === 'utilisateur' && (typeof scope.userId !== 'string' || scope.userId.trim() === '')) return { ok: false, rule: null, code: 'bad_scope' };
    const at = this.now().toISOString();
    const { changes } = scope.kind === 'tous'
      ? await this.db.run("UPDATE access_keys SET revoked_at = ? WHERE network_id = ? AND revoked_at IS NULL AND role <> 'compliance'", [at, viewer.networkId])
      : await this.db.run("UPDATE access_keys SET revoked_at = ? WHERE network_id = ? AND revoked_at IS NULL AND user_id = ? AND role <> 'compliance'", [at, viewer.networkId, scope.userId]);
    const id = this.newId();
    await this.db.run('INSERT INTO data_breach_cuts (id, breach_id, network_id, scope, user_id, keys_revoked, cut_by, cut_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      id,
      row.id,
      viewer.networkId,
      scope.kind,
      scope.kind === 'utilisateur' ? scope.userId : null,
      changes,
      this.actor(viewer),
      at,
    ]);
    await appendEvent(this.journal, { type: 'rgpd.fuite_acces_coupes', actor: this.actor(viewer), subject: `breach:${row.id}`, data: { rule: 'R97', scope: scope.kind, keysRevoked: changes } }, this.now);
    return { ok: true, value: await this.view(row) };
  }

  /** Rétablit une coupure, une fois : les clés retirées le restent, il faut une nouvelle invitation. */
  async restoreAccess(viewer: Viewer, breachId: string, cutId: string): Promise<Result<Breach>> {
    if (viewer.role !== 'compliance') return this.refuse(viewer, 'role');
    const row = await this.breachOf(viewer, breachId);
    if (!row) return { ok: false, rule: null, code: 'unknown' };
    const cut = typeof cutId === 'string' ? await this.db.first('SELECT id FROM data_breach_cuts WHERE id = ? AND breach_id = ?', [cutId, row.id]) : null;
    if (!cut) return { ok: false, rule: null, code: 'unknown_cut' };
    const { changes } = await this.db.run('INSERT INTO data_breach_restores (cut_id, restored_by, restored_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [cutId, this.actor(viewer), this.now().toISOString()]);
    if (changes === 0) return { ok: false, rule: null, code: 'already_restored' };
    await appendEvent(this.journal, { type: 'rgpd.fuite_acces_retablis', actor: this.actor(viewer), subject: `breach:${row.id}`, data: { rule: 'R97' } }, this.now);
    return { ok: true, value: await this.view(row) };
  }

  /**
   * Une coupure en cours ferme-t-elle l'accès de cette personne ? Le responsable de la conformité n'est jamais coupé :
   * c'est lui qui traite la fuite. Lu par le socle avant toute route (L09).
   */
  async accessCut(networkId: string, role: string, userId: string): Promise<boolean> {
    if (role === 'compliance') return false;
    const cut = await this.db.first(
      `SELECT 1 FROM data_breach_cuts c WHERE c.network_id = ? AND (c.scope = 'tous' OR c.user_id = ?)
       AND NOT EXISTS (SELECT 1 FROM data_breach_restores r WHERE r.cut_id = c.id) LIMIT 1`,
      [networkId, userId],
    );
    return cut !== null;
  }

  private async scopePersons(networkId: string, scope: BreachScope): Promise<string[] | null> {
    let ids: string[];
    if (scope.kind === 'reseau') ids = (await this.db.all<{ id: string }>('SELECT id FROM persons WHERE network_id = ?', [networkId])).map((r) => r.id);
    else if (scope.kind === 'agent') {
      if (typeof scope.agentId !== 'string' || !(await this.db.first('SELECT 1 FROM agents WHERE id = ? AND network_id = ?', [scope.agentId, networkId]))) return null;
      ids = (await this.db.all<{ id: string }>('SELECT id FROM persons WHERE network_id = ? AND agent_id = ?', [networkId, scope.agentId])).map((r) => r.id);
    } else {
      if (!Array.isArray(scope.personIds) || scope.personIds.length === 0 || !scope.personIds.every((p) => typeof p === 'string')) return null;
      ids = [];
      for (const id of new Set(scope.personIds)) {
        if (!(await this.db.first('SELECT 1 FROM persons WHERE id = ? AND network_id = ?', [id, networkId]))) return null;
        ids.push(id);
      }
    }
    const roots = new Set<string>();
    for (const id of ids) roots.add(await this.fiche.rootOf(id));
    return [...roots].sort();
  }

  /** L'évaluation du responsable, en listes fermées ; la liste des personnes concernées est figée par le code. */
  async evaluate(
    viewer: Viewer,
    breachId: string,
    input: { risk: BreachRisk; nature: readonly BreachNature[]; categories: readonly BreachCategory[]; scope: BreachScope },
  ): Promise<Result<Breach>> {
    if (viewer.role !== 'compliance') return this.refuse(viewer, 'role');
    const row = await this.breachOf(viewer, breachId);
    if (!row) return { ok: false, rule: null, code: 'unknown' };
    if (!BREACH_RISKS.includes(input.risk)) return { ok: false, rule: null, code: 'bad_risk' };
    const nature = closedList(input.nature, BREACH_NATURES);
    if (!nature) return { ok: false, rule: null, code: 'bad_nature' };
    const categories = closedList(input.categories, BREACH_CATEGORIES);
    if (!categories) return { ok: false, rule: null, code: 'bad_categories' };
    if (!input.scope || !['reseau', 'agent', 'personnes'].includes(input.scope.kind)) return { ok: false, rule: null, code: 'bad_scope' };
    const persons = await this.scopePersons(viewer.networkId, input.scope);
    if (!persons) return { ok: false, rule: null, code: 'bad_scope' };
    const previous = await this.latestEvaluation(row.id);
    const version = (previous?.version ?? 0) + 1;
    const personsSha256 = await sha256Of(persons);
    await this.db.run(
      `INSERT INTO data_breach_evaluations (breach_id, version, risk, nature, categories, scope, agent_id, concerned_count, persons_sha256, evaluated_by, evaluated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, version, input.risk, JSON.stringify(nature), JSON.stringify(categories), input.scope.kind, input.scope.kind === 'agent' ? input.scope.agentId : null, persons.length, personsSha256, this.actor(viewer), this.now().toISOString()],
    );
    for (const p of persons) await this.db.run('INSERT INTO data_breach_persons (breach_id, version, person_id) VALUES (?, ?, ?)', [row.id, version, p]);
    const due = breachDue(input.risk);
    await appendEvent(
      this.journal,
      { type: 'rgpd.fuite_evaluee', actor: this.actor(viewer), subject: `breach:${row.id}`, data: { rule: 'R97', version, risk: input.risk, persons: persons.length, cnil: due.cnil, personnes: due.personnes } },
      this.now,
    );
    return { ok: true, value: await this.view(row) };
  }

  /** La liste des personnes concernées, telle que la dernière évaluation l'a figée : le responsable seul. */
  async concerned(viewer: Viewer, breachId: string): Promise<Result<{ version: number; personIds: string[]; sha256: string }>> {
    if (viewer.role !== 'compliance') return this.refuse(viewer, 'role');
    const row = await this.breachOf(viewer, breachId);
    if (!row) return { ok: false, rule: null, code: 'unknown' };
    const evaluation = await this.latestEvaluation(row.id);
    if (!evaluation) return { ok: false, rule: null, code: 'not_evaluated' };
    const ids = (await this.db.all<{ person_id: string }>('SELECT person_id FROM data_breach_persons WHERE breach_id = ? AND version = ? ORDER BY person_id', [row.id, evaluation.version])).map((r) => r.person_id);
    await appendEvent(this.journal, { type: 'rgpd.fuite_liste_lue', actor: this.actor(viewer), subject: `breach:${row.id}`, data: { rule: 'R97', version: evaluation.version, persons: ids.length } }, this.now);
    return { ok: true, value: { version: evaluation.version, personIds: ids, sha256: evaluation.personsSha256 } };
  }

  /**
   * Le responsable note une notification faite, une fois par destinataire. Rien n'est envoyé par le code. Une
   * notification à la CNIL après l'échéance porte sa raison (article 33.1).
   */
  async notified(viewer: Viewer, breachId: string, input: { target: 'cnil' | 'personnes'; notifiedAt: string; lateCause?: BreachLateCause }): Promise<Result<Breach>> {
    if (viewer.role !== 'compliance') return this.refuse(viewer, 'role');
    const row = await this.breachOf(viewer, breachId);
    if (!row) return { ok: false, rule: null, code: 'unknown' };
    if (input.target !== 'cnil' && input.target !== 'personnes') return { ok: false, rule: null, code: 'bad_target' };
    if (!validInstant(input.notifiedAt)) return { ok: false, rule: null, code: 'bad_date' };
    const notifiedAt = new Date(Date.parse(input.notifiedAt)).toISOString();
    if (Date.parse(notifiedAt) > this.now().getTime()) return { ok: false, rule: null, code: 'future_date' };
    if (Date.parse(notifiedAt) < Date.parse(row.aware_at)) return { ok: false, rule: null, code: 'before_breach' };
    const late = Date.parse(notifiedAt) > Date.parse(row.deadline_at);
    const lateCause = input.lateCause ?? null;
    if (lateCause !== null && !BREACH_LATE_CAUSES.includes(lateCause)) return { ok: false, rule: null, code: 'bad_late_cause' };
    if (late && input.target === 'cnil' && lateCause === null) return { ok: false, rule: null, code: 'late_cause_required' };
    const { changes } = await this.db.run(
      'INSERT INTO data_breach_notifications (breach_id, target, notified_at, late, late_cause, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      [row.id, input.target, notifiedAt, late ? 1 : 0, late ? lateCause : null, this.actor(viewer), this.now().toISOString()],
    );
    if (changes === 0) return { ok: false, rule: null, code: 'already_notified' };
    await appendEvent(this.journal, { type: 'rgpd.fuite_notifiee', actor: this.actor(viewer), subject: `breach:${row.id}`, data: { rule: 'R97', target: input.target, late } }, this.now);
    return { ok: true, value: await this.view(row) };
  }

  /** Les fuites du réseau, la plus proche de son échéance d'abord : le responsable seul. */
  async list(viewer: Viewer): Promise<Result<Breach[]>> {
    if (viewer.role !== 'compliance') return this.refuse(viewer, 'role');
    const rows = await this.db.all<BreachRow>('SELECT * FROM data_breaches WHERE network_id = ? ORDER BY deadline_at, id', [viewer.networkId]);
    const out: Breach[] = [];
    for (const r of rows) out.push(await this.view(r));
    return { ok: true, value: out };
  }

  /**
   * Le passage du planificateur, à chaque créneau : chaque alerte due part une fois, même si un passage a manqué,
   * tant que la CNIL n'est pas prévenue et que l'évaluation ne dit pas « aucun risque ». Rend le nombre d'alertes.
   */
  async run(networkId: string): Promise<number> {
    const now = this.now().getTime();
    const rows = await this.db.all<BreachRow>(
      `SELECT b.* FROM data_breaches b WHERE b.network_id = ?
       AND NOT EXISTS (SELECT 1 FROM data_breach_notifications n WHERE n.breach_id = b.id AND n.target = 'cnil') ORDER BY b.deadline_at, b.id`,
      [networkId],
    );
    let raised = 0;
    for (const b of rows) {
      const evaluation = await this.latestEvaluation(b.id);
      if (!breachDue(evaluation?.risk ?? null).cnil) continue;
      const deadline = Date.parse(b.deadline_at);
      for (const a of BREACH_ALERTS) {
        if (now < deadline - a.before * HOUR) continue;
        const { changes } = await this.db.run('INSERT INTO data_breach_alerts (breach_id, kind, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [b.id, a.kind, this.now().toISOString()]);
        if (changes === 0) continue;
        raised += 1;
        await appendEvent(this.journal, { type: 'rgpd.fuite_alerte', actor: 'system:fuites', subject: `breach:${b.id}`, data: { rule: 'R97', kind: a.kind, deadlineAt: b.deadline_at } }, this.now);
      }
    }
    return raised;
  }

  /** Les alertes du responsable, avec leur texte, à l'heure de Paris. */
  async alerts(viewer: Viewer): Promise<Result<BreachAlert[]>> {
    if (viewer.role !== 'compliance') return this.refuse(viewer, 'role');
    const rows = await this.db.all<{ breach_id: string; kind: BreachAlertKind; created_at: string; deadline_at: string }>(
      `SELECT a.breach_id, a.kind, a.created_at, b.deadline_at FROM data_breach_alerts a JOIN data_breaches b ON b.id = a.breach_id
       WHERE b.network_id = ? ORDER BY b.deadline_at, a.breach_id, a.created_at, a.kind`,
      [viewer.networkId],
    );
    const paris = (iso: string): string =>
      new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)).replace(' ', ' à ');
    const text: Record<BreachAlertKind, (d: string) => string> = {
      connaissance: (d) => `Fuite de données : coupez les accès, évaluez le risque ; la CNIL doit être prévenue avant le ${d} s'il existe un risque.`,
      h24: (d) => `Fuite de données : 24 heures avant l'échéance de la CNIL, le ${d}.`,
      h6: (d) => `Fuite de données : 6 heures avant l'échéance de la CNIL, le ${d}.`,
      echeance: (d) => `Fuite de données : l'échéance de la CNIL du ${d} est passée, la notification n'est pas notée.`,
    };
    return { ok: true, value: rows.map((r) => ({ breachId: r.breach_id, kind: r.kind, deadlineAt: r.deadline_at, createdAt: r.created_at, text: text[r.kind](paris(r.deadline_at)) })) };
  }
}
