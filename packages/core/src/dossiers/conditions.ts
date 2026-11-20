/**
 * Les conditions suspensives du dossier de vente autres que le prêt (AU082, M10) [R10, R16, R17, R61, R62].
 *
 * Vente d'un autre bien, permis de construire, certificat d'urbanisme, autre condition : chacune a son responsable
 * (acquéreur, vendeur, notaire, agent), sa date limite lue dans le compromis, son état (en attente, réalisée, défaillie,
 * renoncée) et son justificatif. L'agent du dossier les saisit, chaque saisie avec sa preuve ; une correction ou un
 * changement d'état s'ajoute en nouvelle version, l'ancienne reste [R17]. Rien n'est inventé : une condition de l'offre
 * que le compromis n'a pas encore datée est « à saisir » [R10].
 *
 * Chaque condition a ses propres alertes à l'agent, indépendantes des autres et de l'échéancier : une quand elle est à
 * saisir, une avant sa date limite (jours d'avance en réglage), une quand la date est passée et qu'elle est encore en
 * attente. Une condition levée (réalisée, défaillie, renoncée) n'alerte plus ; les autres continuent. Rien n'est envoyé
 * aux clients.
 *
 * Décidé, lecture prudente : le prêt garde sa date limite dans l'échéancier et son suivi dans le financement ; une
 * condition se saisit après la signature du compromis, et sa date limite ne la précède pas ; une condition que le
 * compromis ajoute sans que l'offre la portait est acceptée et dite « ajoutée par le compromis », pour que l'écart avec
 * l'offre se voie ; aucun texte libre n'est gardé (ni nom ni adresse d'un autre bien) : la preuve rangée suffit [R13].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { PROOF_REF } from '../offres/transmission.ts';
import { actorOf, gateSaleFile, openFile, type FileRefusal, type FileUnknown } from './acces-dossier.ts';
import { addDays } from './echeancier.ts';

const TIME_ZONE = 'Europe/Paris';

/** Les conditions suivies ici, dans l'ordre de l'offre ; le prêt reste à l'échéancier et au financement. */
export const FILE_CONDITION_KINDS = ['vente_autre_bien', 'permis_construire', 'certificat_urbanisme', 'autre'] as const;
export type FileConditionKind = (typeof FILE_CONDITION_KINDS)[number];
export const CONDITION_RESPONSIBLES = ['acquereur', 'vendeur', 'notaire', 'agent'] as const;
export type ConditionResponsible = (typeof CONDITION_RESPONSIBLES)[number];
export const CONDITION_STATES = ['en_attente', 'realisee', 'defaillie', 'renoncee'] as const;
export type ConditionState = (typeof CONDITION_STATES)[number];

/** Jours d'avance de l'alerte avant la date limite d'une condition : un réglage. */
export const DEFAULT_CONDITION_NOTICE_DAYS = 10;

export interface ConditionLine {
  kind: FileConditionKind;
  /** `offre` : la condition est dans l'offre acceptée ; `compromis` : seul le compromis la porte. */
  source: 'offre' | 'compromis';
  /** `a_saisir` : dans l'offre, pas encore saisie ; `echue` : en attente, date limite passée ; sinon l'état saisi. */
  status: 'a_saisir' | 'en_attente' | 'echue' | 'realisee' | 'defaillie' | 'renoncee';
  responsible: ConditionResponsible | null;
  /** La date limite, `AAAA-MM-JJ`, ou null tant qu'elle n'est pas saisie. */
  day: string | null;
  /** Le justificatif de la dernière saisie, ou null. */
  proofRef: string | null;
  version: number | null;
}

interface Recorded {
  kind: FileConditionKind;
  version: number;
  responsible: ConditionResponsible;
  due_day: string;
  state: ConditionState;
  proof_ref: string;
}

/**
 * Les lignes des conditions, depuis celles de l'offre et les saisies. Fonction pure, dans l'ordre fixe des conditions :
 * mêmes faits, mêmes lignes [R61]. Une condition en attente dont la date limite est passée est « échue ».
 */
export function conditionLines(offerKinds: readonly string[], recorded: readonly Recorded[], today: string): ConditionLine[] {
  const lines: ConditionLine[] = [];
  for (const kind of FILE_CONDITION_KINDS) {
    const r = recorded.find((x) => x.kind === kind);
    const inOffer = offerKinds.includes(kind);
    if (!r) {
      if (inOffer) lines.push({ kind, source: 'offre', status: 'a_saisir', responsible: null, day: null, proofRef: null, version: null });
      continue;
    }
    const status = r.state === 'en_attente' && r.due_day < today ? 'echue' : r.state;
    lines.push({ kind, source: inOffer ? 'offre' : 'compromis', status, responsible: r.responsible, day: r.due_day, proofRef: r.proof_ref, version: Number(r.version) });
  }
  return lines;
}

export interface ConditionTask {
  fileId: string;
  propertyId: string;
  condition: FileConditionKind;
  /** `a_saisir` : la condition attend sa saisie ; `avant_echeance` : sa date approche ; `echue` : passée, toujours en attente. */
  reason: 'a_saisir' | 'avant_echeance' | 'echue';
  day: string | null;
  createdAt: string;
}

export type ConditionProblem = {
  ok: false;
  rule: null;
  code: 'unknown_condition' | 'bad_responsible' | 'bad_state' | 'bad_day' | 'bad_proof' | 'not_stored' | 'compromis_first' | 'before_compromis' | 'busy' | 'closed';
};

export interface FileConditions {
  fileId: string;
  lines: ConditionLine[];
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
function validDay(v: unknown): v is string {
  if (typeof v !== 'string' || !DAY.test(v)) return false;
  const d = new Date(`${v}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export class ConditionsDossier {
  private readonly now: () => Date;
  private readonly noticeDays: number;
  private readonly proofs: { has(ref: string): Promise<boolean> } | null;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date; noticeDays?: number; /** Une preuve qui n'est pas rangée est refusée [R10]. */ proofs?: { has(ref: string): Promise<boolean> } } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.noticeDays = options.noticeDays ?? DEFAULT_CONDITION_NOTICE_DAYS;
    this.proofs = options.proofs ?? null;
    if (!Number.isInteger(this.noticeDays) || this.noticeDays < 0 || this.noticeDays > 60) throw new Error("Délai de rappel d'une condition : de 0 à 60 jours.");
  }

  private today(): string {
    return localTime(this.now(), TIME_ZONE).date;
  }

  private async recordedOf(fileId: string): Promise<Recorded[]> {
    return this.db.all<Recorded>(
      `SELECT kind, version, responsible, due_day, state, proof_ref FROM sale_file_conditions c WHERE file_id = ?
       AND version = (SELECT MAX(version) FROM sale_file_conditions d WHERE d.file_id = c.file_id AND d.kind = c.kind)`,
      [fileId],
    );
  }

  private async offerKindsOf(offerId: string): Promise<string[]> {
    const offer = await this.db.first<{ conditions: string }>('SELECT conditions FROM offer_register WHERE id = ?', [offerId]);
    return offer ? (JSON.parse(offer.conditions) as { kind: string }[]).map((c) => c.kind) : [];
  }

  /** Les conditions d'un dossier, pour les passages du système, qui ne montrent rien à personne : sans contrôle d'accès. */
  async conditionsOf(file: { id: string; offer_id: string }): Promise<FileConditions> {
    return { fileId: file.id, lines: conditionLines(await this.offerKindsOf(file.offer_id), await this.recordedOf(file.id), this.today()) };
  }

  /** Les conditions du dossier : agent du bien, direction, conformité [R16]. */
  async conditions(viewer: Viewer, fileId: string): Promise<{ ok: true; value: FileConditions } | FileRefusal | FileUnknown> {
    const g = await gateSaleFile({ db: this.db, acces: this.acces, journal: this.journal, now: this.now }, viewer, fileId, false, 'sale_file_conditions');
    if (!g.ok) return g;
    return { ok: true, value: await this.conditionsOf(g.file) };
  }

  /**
   * L'agent du dossier saisit une condition : responsable, date limite, état, justificatif. Une correction ou un
   * changement d'état s'ajoute en nouvelle version [R17].
   */
  async record(
    viewer: Viewer,
    fileId: string,
    input: { kind: unknown; responsible: unknown; day: unknown; state: unknown; proofRef: unknown },
  ): Promise<{ ok: true; value: FileConditions } | FileRefusal | FileUnknown | ConditionProblem> {
    const g = await gateSaleFile({ db: this.db, acces: this.acces, journal: this.journal, now: this.now }, viewer, fileId, true, 'sale_file_conditions');
    if (!g.ok) return g;
    if (await this.db.first('SELECT 1 FROM sale_file_closings WHERE file_id = ?', [fileId])) return { ok: false, rule: null, code: 'closed' };
    if (typeof input.kind !== 'string' || !(FILE_CONDITION_KINDS as readonly string[]).includes(input.kind)) return { ok: false, rule: null, code: 'unknown_condition' };
    const kind = input.kind as FileConditionKind;
    if (typeof input.responsible !== 'string' || !(CONDITION_RESPONSIBLES as readonly string[]).includes(input.responsible)) return { ok: false, rule: null, code: 'bad_responsible' };
    if (typeof input.state !== 'string' || !(CONDITION_STATES as readonly string[]).includes(input.state)) return { ok: false, rule: null, code: 'bad_state' };
    if (!validDay(input.day)) return { ok: false, rule: null, code: 'bad_day' };
    if (typeof input.proofRef !== 'string' || !PROOF_REF.test(input.proofRef)) return { ok: false, rule: null, code: 'bad_proof' };
    // Les conditions viennent du compromis : sa signature se saisit d'abord, à l'échéancier.
    const signed = await this.db.first<{ day: string }>(
      "SELECT day FROM sale_file_dates WHERE file_id = ? AND kind = 'compromis_signe' ORDER BY version DESC LIMIT 1",
      [fileId],
    );
    if (!signed) return { ok: false, rule: null, code: 'compromis_first' };
    if (input.day < signed.day) return { ok: false, rule: null, code: 'before_compromis' };
    if (this.proofs && !(await this.proofs.has(input.proofRef))) return { ok: false, rule: null, code: 'not_stored' };
    const last = await this.db.first<{ version: number }>('SELECT MAX(version) AS version FROM sale_file_conditions WHERE file_id = ? AND kind = ?', [fileId, kind]);
    const version = Number(last?.version ?? 0) + 1;
    try {
      await this.db.run(
        'INSERT INTO sale_file_conditions (file_id, network_id, kind, version, responsible, due_day, state, proof_ref, at, by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [fileId, g.file.network_id, kind, version, input.responsible, input.day, input.state, input.proofRef, this.now().toISOString(), actorOf(viewer)],
      );
    } catch (error) {
      if (/UNIQUE|PRIMARY/i.test(String(error))) return { ok: false, rule: null, code: 'busy' };
      throw error;
    }
    await appendEvent(this.journal, { type: 'dossier.condition', actor: actorOf(viewer), subject: `sale_file:${fileId}`, data: { rule: 'R61', kind, state: input.state, version } }, this.now);
    return { ok: true, value: await this.conditionsOf(g.file) };
  }

  /**
   * Le passage du jour : pour chaque dossier ouvert dont le compromis est signé, une alerte par condition à saisir, par
   * condition dont la date limite approche, par condition échue encore en attente. Une seule par condition, raison et
   * date. Rend le nombre d'alertes créées.
   */
  async run(networkId: string): Promise<number> {
    const today = this.today();
    const files = await this.db.all<{ id: string; offer_id: string; agent_id: string | null }>(
      `SELECT f.id, f.offer_id, p.agent_id FROM sale_files f JOIN properties p ON p.id = f.property_id
       WHERE f.network_id = ? AND EXISTS (SELECT 1 FROM sale_file_dates d WHERE d.file_id = f.id AND d.kind = 'compromis_signe')
       AND NOT EXISTS (SELECT 1 FROM sale_file_closings c WHERE c.file_id = f.id) AND ${openFile('f')}
       ORDER BY f.opened_at, f.id`,
      [networkId],
    );
    let created = 0;
    for (const f of files) {
      if (!f.agent_id) continue;
      for (const l of (await this.conditionsOf(f)).lines) {
        let task: { reason: ConditionTask['reason']; due: string } | null = null;
        if (l.status === 'a_saisir') task = { reason: 'a_saisir', due: '' };
        else if (l.status === 'echue') task = { reason: 'echue', due: l.day! };
        else if (l.status === 'en_attente' && addDays(l.day!, -this.noticeDays) <= today) task = { reason: 'avant_echeance', due: l.day! };
        if (!task) continue;
        const { changes } = await this.db.run(
          'INSERT INTO sale_file_condition_tasks (file_id, network_id, agent_id, kind, reason, due_day, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (file_id, kind, reason, due_day, agent_id) DO NOTHING',
          [f.id, networkId, f.agent_id, l.kind, task.reason, task.due, this.now().toISOString()],
        );
        if (changes !== 1) continue;
        created += 1;
        await appendEvent(this.journal, { type: 'dossier.condition_alerte', actor: 'system:dossiers', subject: `sale_file:${f.id}`, data: { rule: 'R61', kind: l.kind, reason: task.reason, ...(task.due ? { day: task.due } : {}) } }, this.now);
      }
    }
    return created;
  }

  /**
   * Les alertes de l'agent sur les conditions, pour lui seul, encore utiles : la condition est toujours dans l'état qui
   * les a fait naître, à la même date [R16].
   */
  async tasksOf(viewer: Viewer): Promise<{ ok: true; tasks: ConditionTask[] } | FileRefusal> {
    const refuse = async (code: 'not_agent' | 'agent_inactive') => {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: actorOf(viewer), subject: null, data: { rule: 'R16', role: String(viewer.role), kind: 'sale_file_condition_tasks', code } }, this.now);
      return { ok: false as const, rule: 'R16' as const, code };
    };
    if (viewer.role !== 'agent') return refuse('not_agent');
    const agent = await this.db.first<{ network_id: string; status: string }>('SELECT network_id, status FROM agents WHERE id = ?', [viewer.userId]);
    if (!agent || agent.network_id !== viewer.networkId || agent.status !== 'active') return refuse('agent_inactive');
    const rows = await this.db.all<{ file_id: string; property_id: string; offer_id: string; kind: FileConditionKind; reason: ConditionTask['reason']; due_day: string; created_at: string }>(
      `SELECT k.file_id, f.property_id, f.offer_id, k.kind, k.reason, k.due_day, k.created_at FROM sale_file_condition_tasks k JOIN sale_files f ON f.id = k.file_id
       JOIN properties p ON p.id = f.property_id
       WHERE k.network_id = ? AND k.agent_id = ? AND p.agent_id = k.agent_id AND NOT EXISTS (SELECT 1 FROM sale_file_closings c WHERE c.file_id = k.file_id) AND ${openFile('f')}
       ORDER BY k.created_at, k.kind`,
      [viewer.networkId, viewer.userId],
    );
    const today = this.today();
    const byFile = new Map<string, FileConditions>();
    const tasks: ConditionTask[] = [];
    for (const r of rows) {
      if (!byFile.has(r.file_id)) byFile.set(r.file_id, await this.conditionsOf({ id: r.file_id, offer_id: r.offer_id }));
      const line = byFile.get(r.file_id)!.lines.find((l) => l.kind === r.kind);
      if (!line) continue;
      const still =
        r.reason === 'a_saisir' ? line.status === 'a_saisir'
        : r.reason === 'echue' ? line.status === 'echue' && line.day === r.due_day
        : line.status === 'en_attente' && line.day === r.due_day && r.due_day >= today;
      if (still) tasks.push({ fileId: r.file_id, propertyId: r.property_id, condition: r.kind, reason: r.reason, day: r.due_day || null, createdAt: r.created_at });
    }
    // Chaque lecture est écrite au journal, sans donnée personnelle : qui, quand, quels dossiers [R16].
    await appendEvent(this.journal, { type: 'dossier.conditions_lues', actor: actorOf(viewer), subject: `agent:${viewer.userId}`, data: { rule: 'R16', files: [...new Set(tasks.map((x) => `sale_file:${x.fileId}`))] } }, this.now);
    tasks.sort((a, b) => ((a.day ?? '') < (b.day ?? '') ? -1 : (a.day ?? '') > (b.day ?? '') ? 1 : FILE_CONDITION_KINDS.indexOf(a.condition) - FILE_CONDITION_KINDS.indexOf(b.condition)));
    return { ok: true, tasks };
  }
}
