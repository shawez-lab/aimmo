/**
 * Suivi du financement déclaré (M10, N04) [R14, R16, R17].
 *
 * L'agent du dossier range les étapes du prêt telles que l'acquéreur ou son courtier les déclarent, chacune avec sa
 * date et qui l'a déclarée : demande déposée, accord de principe, offre de prêt émise, offre de prêt acceptée, refus.
 * Pour l'offre de prêt, le jour déclaré est celui où l'acquéreur l'a reçue : le délai de réflexion en part (N07).
 * Une liste fermée, sans montant, sans taux, sans pièce : aucune note, aucun score, aucun tri sur le financement, ni
 * dans les données ni dans ce qui est rendu [R14]. Chaque jour, une alerte à l'agent quand la date limite du prêt
 * approche (réglage : 15 jours) sans offre de prêt déclarée, une seule par date limite ; et une alerte dès qu'un refus
 * est déclaré, une seule par refus. Rien n'est envoyé aux clients.
 *
 * Décidé, lecture prudente : sans condition de prêt dans l'offre, le suivi n'a pas d'objet et rien ne se range ; une
 * étape déclarée ne se corrige pas, une nouvelle s'ajoute ; les étapes ne sont pas contrôlées dans leur ordre, car un
 * acquéreur peut changer de banque ; seule l'offre de prêt émise ou acceptée éteint l'alerte de la date limite.
 *
 * AU083 : quand deux banques (ou un courtier et une banque) travaillent sur le dossier, chaque étape peut dire à quelle
 * demande elle appartient (`demande` : le nom de la banque ou du courtier, tel qu'il est dit, sans numéro de compte ni de
 * dossier). Les suites de chaque demande restent séparées : un refus ne clôt que sa demande, et seule une offre de prêt
 * encore vivante dans une demande (pas suivie d'un refus de cette même demande) éteint l'alerte de la date limite. Les
 * étapes sans demande dite forment une seule demande, comme avant.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { actorOf, gateSaleFile, openFile, type FileRefusal, type FileUnknown } from './acces-dossier.ts';
import { Echeancier, addDays } from './echeancier.ts';

const TIME_ZONE = 'Europe/Paris';
export const FINANCING_STEPS = ['demande_deposee', 'accord_principe', 'offre_pret_emise', 'offre_pret_acceptee', 'refus'] as const;
export type FinancingStep = (typeof FINANCING_STEPS)[number];
export const DECLARED_BY = ['acquereur', 'courtier'] as const;
export type DeclaredBy = (typeof DECLARED_BY)[number];
export const DEFAULT_LOAN_NOTICE_DAYS = 15;

export interface DeclaredStep {
  step: FinancingStep;
  day: string;
  declaredBy: DeclaredBy;
  recordedAt: string;
  /** La demande de financement (banque ou courtier) à laquelle l'étape appartient ; absente si personne ne l'a dite. */
  demande?: string;
}

export const REQUEST_LABEL_MAX = 60;
/** Un nom de banque ou de courtier : lettres, chiffres, espaces et ponctuation courte, jamais 4 chiffres de suite. */
const REQUEST_LABEL = /^[\p{L}\p{N}][\p{L}\p{N} '’&.\-]*$/u;

/** Le nom d'une demande, nettoyé ; null s'il n'est pas un nom de banque ou de courtier. */
export function requestLabel(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const label = v.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (!label || label.length > REQUEST_LABEL_MAX || !REQUEST_LABEL.test(label) || /\d{4}/.test(label)) return null;
  return label;
}

/** La clé d'une demande : deux façons d'écrire le même nom sont la même demande. */
export function requestKey(step: Pick<DeclaredStep, 'demande'>): string {
  return (step.demande ?? '').normalize('NFC').toLocaleLowerCase('fr');
}

/** Les étapes réparties par demande, chacune dans l'ordre où elles ont été rangées. */
export function byRequest<T extends Pick<DeclaredStep, 'demande'>>(steps: readonly T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const s of steps) {
    const k = requestKey(s);
    const g = groups.get(k);
    if (g) g.push(s);
    else groups.set(k, [s]);
  }
  return [...groups.values()];
}

/** Une offre de prêt est vivante dans une demande quand elle vient après le dernier refus de cette même demande. */
export function hasLiveOffer(steps: readonly Pick<DeclaredStep, 'step' | 'demande'>[]): boolean {
  return byRequest(steps).some((g) => {
    const tail = g.slice(g.map((x) => x.step).lastIndexOf('refus') + 1);
    return tail.some((x) => x.step === 'offre_pret_emise' || x.step === 'offre_pret_acceptee');
  });
}

/** Ce que le suivi rend : des faits déclarés, dans l'ordre où ils ont été rangés. Rien d'autre [R14]. */
export interface Financing {
  fileId: string;
  /** false : l'offre n'a pas de condition de prêt, le suivi n'a pas d'objet. */
  hasLoanCondition: boolean;
  steps: DeclaredStep[];
}

export interface FinancingAlert {
  fileId: string;
  propertyId: string;
  kind: 'sans_offre_de_pret' | 'refus_declare';
  day: string;
  createdAt: string;
}

export type FinancingProblem = { ok: false; rule: null; code: 'bad_input' | 'unknown_step' | 'bad_day' | 'future_day' | 'bad_request' | 'no_loan_condition' | 'busy' | 'closed' };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
function validDay(v: unknown): v is string {
  if (typeof v !== 'string' || !DAY.test(v)) return false;
  const d = new Date(`${v}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export class FinancementDossier {
  private readonly now: () => Date;
  private readonly notice: number;
  private readonly echeancier: Echeancier;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date; loanNoticeDays?: number } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.notice = options.loanNoticeDays ?? DEFAULT_LOAN_NOTICE_DAYS;
    if (!Number.isInteger(this.notice) || this.notice < 1 || this.notice > 60) throw new Error('Alerte avant la date limite du prêt : de 1 à 60 jours.');
    this.echeancier = new Echeancier(db, acces, journal, { now: this.now });
  }

  private gate(viewer: Viewer, fileId: string, write: boolean) {
    return gateSaleFile({ db: this.db, acces: this.acces, journal: this.journal, now: this.now }, viewer, fileId, write, 'sale_file_financing');
  }

  private async hasLoanCondition(offerId: string): Promise<boolean> {
    const offer = await this.db.first<{ conditions: string }>('SELECT conditions FROM offer_register WHERE id = ?', [offerId]);
    return offer ? (JSON.parse(offer.conditions) as { kind: string }[]).some((c) => c.kind === 'pret') : false;
  }

  private async read(fileId: string, offerId: string): Promise<Financing> {
    const rows = await this.db.all<{ step: FinancingStep; day: string; declared_by: DeclaredBy; at: string; request_label: string }>(
      'SELECT step, day, declared_by, at, request_label FROM sale_file_financing WHERE file_id = ? ORDER BY seq',
      [fileId],
    );
    return {
      fileId,
      hasLoanCondition: await this.hasLoanCondition(offerId),
      steps: rows.map((r) => ({ step: r.step, day: r.day, declaredBy: r.declared_by, recordedAt: r.at, ...(r.request_label ? { demande: r.request_label } : {}) })),
    };
  }

  /** Le suivi : agent du bien, direction, conformité [R16]. */
  async financing(viewer: Viewer, fileId: string): Promise<{ ok: true; value: Financing } | FileRefusal | FileUnknown> {
    const g = await this.gate(viewer, fileId, false);
    if (!g.ok) return g;
    return { ok: true, value: await this.read(fileId, g.file.offer_id) };
  }

  /** L'agent du dossier range une étape déclarée. Tout champ en plus est refusé, jamais ignoré [R14]. */
  async declare(viewer: Viewer, fileId: string, input: unknown): Promise<{ ok: true; value: Financing } | FileRefusal | FileUnknown | FinancingProblem> {
    const g = await this.gate(viewer, fileId, true);
    if (!g.ok) return g;
    // Un dossier clos par l'acte ne reçoit plus rien, de l'agent comme de l'acquéreur (N13).
    if (await this.db.first('SELECT 1 FROM sale_file_closings WHERE file_id = ?', [fileId])) return { ok: false, rule: null, code: 'closed' };
    return this.write(g.file, input, ['step', 'day', 'declaredBy', 'demande'], null, actorOf(viewer));
  }

  /**
   * L'acquéreur range lui-même une étape de son financement, depuis son espace (EC10) [R165] : les mêmes contrôles que
   * pour l'agent, l'étape dite « déclarée par l'acquéreur », et l'auteur écrit tel qu'il est (`client:<séance>`), jamais
   * l'agent. Seul l'acquéreur du dossier (une de ses fiches réunies) le peut ; un dossier clos par l'acte ne reçoit plus
   * rien. `declaredBy` n'est pas un champ permis : il est fixé, jamais choisi par le client.
   */
  async declareByBuyer(
    networkId: string,
    buyerPersonIds: readonly string[],
    fileId: string,
    input: unknown,
    actor: string,
  ): Promise<{ ok: true; value: Financing } | FileRefusal | FileUnknown | FinancingProblem> {
    const file = await this.db.first<{ id: string; network_id: string; offer_id: string; buyer_person_id: string }>('SELECT id, network_id, offer_id, buyer_person_id FROM sale_files WHERE id = ?', [fileId]);
    if (!file || file.network_id !== networkId) return { ok: false, rule: null, code: 'unknown_file' };
    if (!buyerPersonIds.includes(file.buyer_person_id)) {
      await appendEvent(this.journal, { type: 'acces.refuse', actor, subject: `sale_file:${fileId}`, data: { rule: 'R16', role: 'client', kind: 'sale_file_financing', code: 'not_buyer' } }, this.now);
      return { ok: false, rule: 'R16', code: 'not_buyer' };
    }
    if (await this.db.first('SELECT 1 FROM sale_file_closings WHERE file_id = ?', [fileId])) return { ok: false, rule: null, code: 'closed' };
    if (await this.db.first('SELECT 1 FROM sale_file_stops WHERE file_id = ?', [fileId])) return { ok: false, rule: null, code: 'file_stopped' };
    return this.write(file, input, ['step', 'day', 'demande'], 'acquereur', actor);
  }

  private async write(
    file: { id: string; network_id: string; offer_id: string },
    input: unknown,
    allowed: readonly string[],
    fixedBy: DeclaredBy | null,
    actor: string,
  ): Promise<{ ok: true; value: Financing } | FinancingProblem> {
    const fileId = file.id;
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, rule: null, code: 'bad_input' };
    const i = input as Record<string, unknown>;
    if (Object.keys(i).some((k) => !allowed.includes(k))) return { ok: false, rule: null, code: 'bad_input' };
    const declaredBy = fixedBy ?? i.declaredBy;
    if (typeof i.step !== 'string' || !(FINANCING_STEPS as readonly string[]).includes(i.step)) return { ok: false, rule: null, code: 'unknown_step' };
    if (typeof declaredBy !== 'string' || !(DECLARED_BY as readonly string[]).includes(declaredBy)) return { ok: false, rule: null, code: 'bad_input' };
    if (!validDay(i.day)) return { ok: false, rule: null, code: 'bad_day' };
    if (i.day > localTime(this.now(), TIME_ZONE).date) return { ok: false, rule: null, code: 'future_day' };
    // La demande est facultative ; dite, elle doit être un nom de banque ou de courtier, jamais un numéro.
    const demande = i.demande === undefined ? '' : requestLabel(i.demande);
    if (demande === null) return { ok: false, rule: null, code: 'bad_request' };
    if (!(await this.hasLoanCondition(file.offer_id))) return { ok: false, rule: null, code: 'no_loan_condition' };
    const last = await this.db.first<{ n: number | null }>('SELECT MAX(seq) AS n FROM sale_file_financing WHERE file_id = ?', [fileId]);
    try {
      await this.db.run(
        'INSERT INTO sale_file_financing (file_id, seq, network_id, step, day, declared_by, at, by, request_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [fileId, Number(last?.n ?? 0) + 1, file.network_id, i.step, i.day, declaredBy, this.now().toISOString(), actor, demande],
      );
    } catch (error) {
      if (/UNIQUE|PRIMARY/i.test(String(error))) return { ok: false, rule: null, code: 'busy' };
      throw error;
    }
    await appendEvent(this.journal, { type: 'dossier.financement', actor, subject: `sale_file:${fileId}`, data: { step: i.step, declaredBy, request: demande !== '' } }, this.now);
    return { ok: true, value: await this.read(fileId, file.offer_id) };
  }

  /** Le passage du jour : les alertes de l'agent du bien. Rend le nombre d'alertes créées. */
  async run(networkId: string): Promise<number> {
    const today = localTime(this.now(), TIME_ZONE).date;
    const files = await this.db.all<{ id: string; offer_id: string; property_id: string; agent_id: string | null }>(
      `SELECT f.id, f.offer_id, f.property_id, p.agent_id FROM sale_files f JOIN properties p ON p.id = f.property_id
       WHERE f.network_id = ? AND p.status = 'under_offer' AND ${openFile('f')} ORDER BY f.opened_at, f.id`,
      [networkId],
    );
    let created = 0;
    const alert = async (f: { id: string; agent_id: string }, kind: FinancingAlert['kind'], day: string, seq = '') => {
      const { changes } = await this.db.run(
        'INSERT INTO sale_file_financing_alerts (file_id, network_id, agent_id, kind, due_day, step_seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
        [f.id, networkId, f.agent_id, kind, day, seq, this.now().toISOString()],
      );
      if (changes !== 1) return;
      created += 1;
      await appendEvent(this.journal, { type: 'dossier.alerte_financement', actor: 'system:dossiers', subject: `sale_file:${f.id}`, data: { kind, day } }, this.now);
    };
    for (const f of files) {
      if (!f.agent_id) continue;
      const fin = await this.read(f.id, f.offer_id);
      if (!fin.hasLoanCondition) continue;
      // Une alerte par refus déclaré, même deux le même jour.
      for (const [i, s] of fin.steps.entries()) if (s.step === 'refus') await alert({ id: f.id, agent_id: f.agent_id }, 'refus_declare', s.day, String(i + 1));
      const limit = (await this.echeancier.scheduleOf(f)).lines.find((l) => l.deadline === 'date_limite_pret')?.day ?? null;
      if (!limit || today > limit || addDays(limit, -this.notice) > today) continue;
      if (hasLiveOffer(fin.steps)) continue;
      await alert({ id: f.id, agent_id: f.agent_id }, 'sans_offre_de_pret', limit);
    }
    return created;
  }

  /** Les alertes encore utiles de l'agent, pour lui seul, sur les biens qu'il suit [R16]. */
  async alertsOf(viewer: Viewer): Promise<{ ok: true; alerts: FinancingAlert[] } | FileRefusal> {
    const refuse = async (code: string): Promise<FileRefusal> => {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: actorOf(viewer), subject: null, data: { rule: 'R16', role: String(viewer.role), kind: 'sale_file_financing_alerts', code } }, this.now);
      return { ok: false, rule: 'R16', code };
    };
    if (viewer.role !== 'agent') return refuse('not_agent');
    const agent = await this.db.first<{ network_id: string; status: string }>('SELECT network_id, status FROM agents WHERE id = ?', [viewer.userId]);
    if (!agent || agent.network_id !== viewer.networkId || agent.status !== 'active') return refuse('agent_inactive');
    const today = localTime(this.now(), TIME_ZONE).date;
    const rows = await this.db.all<{ file_id: string; property_id: string; offer_id: string; kind: FinancingAlert['kind']; due_day: string; created_at: string }>(
      `SELECT a.file_id, f.property_id, f.offer_id, a.kind, a.due_day, a.created_at FROM sale_file_financing_alerts a JOIN sale_files f ON f.id = a.file_id
       JOIN properties p ON p.id = f.property_id
       WHERE a.network_id = ? AND a.agent_id = ? AND p.agent_id = a.agent_id AND p.status = 'under_offer' AND ${openFile('f')} ORDER BY a.created_at, a.kind`,
      [viewer.networkId, viewer.userId],
    );
    const alerts: FinancingAlert[] = [];
    for (const r of rows) {
      if (r.kind === 'sans_offre_de_pret') {
        // Éteinte par une offre de prêt encore vivante dans une demande, ou par une date limite passée ou déplacée.
        const fin = await this.read(r.file_id, r.offer_id);
        if (hasLiveOffer(fin.steps)) continue;
        const limit = (await this.echeancier.scheduleOf({ id: r.file_id, offer_id: r.offer_id, property_id: r.property_id })).lines.find((l) => l.deadline === 'date_limite_pret')?.day;
        if (limit !== r.due_day || r.due_day < today) continue;
      }
      alerts.push({ fileId: r.file_id, propertyId: r.property_id, kind: r.kind, day: r.due_day, createdAt: r.created_at });
    }
    // Chaque lecture est écrite au journal, sans donnée personnelle : qui, quand, combien de dossiers [R16].
    await appendEvent(this.journal, { type: 'dossier.alertes_lues', actor: actorOf(viewer), subject: `agent:${viewer.userId}`, data: { rule: 'R16', files: [...new Set(alerts.map((x) => `sale_file:${x.fileId}`))] } }, this.now);
    return { ok: true, alerts };
  }
}
