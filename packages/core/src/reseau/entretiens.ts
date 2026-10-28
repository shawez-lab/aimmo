/**
 * Entretien d'un candidat (M14, J03) : préparé par le code à partir de ce que le candidat a déclaré, puis fixé, mené et
 * décidé par un humain.
 *
 * La fiche d'entretien ne contient que le déclaré, les mêmes questions pour tous et les pièces que le candidat devra
 * fournir : aucune note, aucun résumé, aucun avis, ni de l'IA ni du code [R81, R14]. Cette fiche n'appelle aucune IA.
 * La décision d'entrée (oui, non, à revoir) est rangée par la direction, au nom d'une personne nommée, avec son motif
 * écrit ; un « oui » exige un entretien tenu : fixé à une date à venir, puis marqué tenu une fois cette date passée,
 * avec la personne qui l'a mené. Une décision ne change plus, une nouvelle s'ajoute et la dernière compte
 * [R17]. Seule la direction lit les candidatures et décide [R16] ; chaque lecture d'une fiche d'entretien est écrite au
 * journal avant d'être rendue. Ni nom, ni motif, ni coordonnée au journal [R13].
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { CandidateExperience, CandidateSource, CandidateStatus } from './candidatures.ts';

/** Les questions de l'entretien, les mêmes pour tous les candidats, dans le même ordre [R81]. */
export const INTERVIEW_QUESTIONS: readonly string[] = Object.freeze([
  'Qu’est-ce qui vous amène vers le métier d’agent immobilier, et vers AIMMO ?',
  'Comment imaginez-vous une semaine de travail, avec votre propre organisation ?',
  'Dans quel secteur souhaitez-vous travailler ?',
  'Le statut d’agent commercial indépendant : qu’en savez-vous, et qu’en attendez-vous ?',
  'Quelles questions avez-vous sur la formation, l’essai de 30 jours ou le partage des commissions ?',
  'Qu’attendez-vous de votre référent pendant vos 90 premiers jours ?',
]);

/** Les pièces que le candidat retenu devra fournir pour son dossier d'agent (J04), dites dès l'entretien. */
export const AGENT_FILE_PIECES = Object.freeze([
  { kind: 'contrat_agent_commercial', label: 'Contrat d’agent commercial signé' },
  { kind: 'attestation_habilitation', label: 'Attestation d’habilitation délivrée par le titulaire de la carte' },
  { kind: 'immatriculation_rsac', label: 'Immatriculation au registre spécial des agents commerciaux' },
  { kind: 'assurance_rcp', label: 'Assurance de responsabilité civile professionnelle' },
  { kind: 'attestation_vigilance', label: 'Attestation de vigilance de moins de 6 mois' },
] as const);
export type AgentFilePiece = (typeof AGENT_FILE_PIECES)[number]['kind'];

export const INTERVIEW_DECISIONS = ['oui', 'non', 'a_revoir'] as const;
export type InterviewDecision = (typeof INTERVIEW_DECISIONS)[number];

/** La fiche d'entretien : le déclaré tel quel, les questions communes, les pièces. Rien d'autre [R81]. */
export interface InterviewSheet {
  candidateId: string;
  declared: {
    firstName: string;
    lastName: string | null;
    town: string | null;
    currentStatus: CandidateStatus;
    experience: CandidateExperience;
    question: string | null;
    source: CandidateSource;
  };
  questions: readonly string[];
  pieces: readonly { kind: AgentFilePiece; label: string }[];
  interviews: { interviewId: string; scheduledAt: string; interviewer: string; held: boolean }[];
  decision: { decision: InterviewDecision; reason: string; deciderName: string; decidedAt: string } | null;
}

export type InterviewRefusal = { ok: false; rule: 'R16' | 'R81' | null; code: string };

export interface EntretiensOptions {
  now?: () => Date;
  newId?: () => string;
}

const actorOf = (viewer: Viewer): string => `${String(viewer.role)}:${viewer.userId}`;
const clean = (v: unknown, min: number, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim().replace(/\s+/g, ' ');
  return t.length >= min && t.length <= max ? t : null;
};

export class Entretiens {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: EntretiensOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /** La direction seule, et une candidature de son réseau ; sinon refus au journal [R16]. */
  private async gate(viewer: Viewer, candidateId: string): Promise<InterviewRefusal | null> {
    const refuse = async (code: string): Promise<InterviewRefusal> => {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: actorOf(viewer), subject: `candidate:${candidateId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'candidate', code } }, this.now);
      return { ok: false, rule: 'R16', code };
    };
    if (viewer.role !== 'direction') return refuse('role');
    const row = await this.db.first<{ id: string }>('SELECT id FROM candidates WHERE id = ? AND network_id = ?', [candidateId, viewer.networkId]);
    return row ? null : refuse('unknown');
  }

  /** La fiche d'entretien d'une candidature. Préparée par le code, sans IA, la même forme pour tous [R81]. */
  async prepare(viewer: Viewer, candidateId: string): Promise<{ ok: true; value: InterviewSheet } | InterviewRefusal> {
    const denied = await this.gate(viewer, candidateId);
    if (denied) return denied;
    const c = (await this.db.first<{
      first_name: string;
      last_name: string | null;
      town: string | null;
      current_status: CandidateStatus;
      experience: CandidateExperience;
      question: string | null;
      source: CandidateSource;
    }>('SELECT first_name, last_name, town, current_status, experience, question, source FROM candidates WHERE id = ?', [candidateId]))!;
    const interviews = await this.db.all<{ id: string; scheduled_at: string; interviewer: string; held: number }>(
      `SELECT i.id, i.scheduled_at, i.interviewer, CASE WHEN o.interview_id IS NULL THEN 0 ELSE 1 END AS held
       FROM candidate_interviews i LEFT JOIN candidate_interview_outcomes o ON o.interview_id = i.id
       WHERE i.candidate_id = ? ORDER BY i.scheduled_at, i.id`,
      [candidateId],
    );
    const decision = await this.decisionOf(candidateId);
    // La lecture est écrite au journal avant que la fiche soit rendue [R16].
    await appendEvent(this.journal, { type: 'candidature.lue', actor: actorOf(viewer), subject: `candidate:${candidateId}`, data: { rule: 'R16', kind: 'interview_sheet' } }, this.now);
    return {
      ok: true,
      value: {
        candidateId,
        declared: { firstName: c.first_name, lastName: c.last_name, town: c.town, currentStatus: c.current_status, experience: c.experience, question: c.question, source: c.source },
        questions: INTERVIEW_QUESTIONS,
        pieces: AGENT_FILE_PIECES,
        interviews: interviews.map((i) => ({ interviewId: i.id, scheduledAt: i.scheduled_at, interviewer: i.interviewer, held: i.held === 1 })),
        decision,
      },
    };
  }

  /** La direction fixe un entretien à venir, avec la personne qui le mène ; une date passée est refusée. */
  async schedule(viewer: Viewer, candidateId: string, input: { at: unknown; interviewer: unknown }): Promise<{ ok: true; interviewId: string } | InterviewRefusal> {
    const denied = await this.gate(viewer, candidateId);
    if (denied) return denied;
    const at = typeof input.at === 'string' && !Number.isNaN(Date.parse(input.at)) ? new Date(input.at).toISOString() : null;
    if (!at) return { ok: false, rule: null, code: 'bad_date' };
    if (Date.parse(at) <= this.now().getTime()) return { ok: false, rule: 'R81', code: 'past_date' };
    const interviewer = clean(input.interviewer, 1, 80);
    if (!interviewer) return { ok: false, rule: null, code: 'bad_interviewer' };
    const id = this.newId();
    await this.db.run('INSERT INTO candidate_interviews (id, network_id, candidate_id, scheduled_at, interviewer, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      id,
      viewer.networkId,
      candidateId,
      at,
      interviewer,
      actorOf(viewer),
      this.now().toISOString(),
    ]);
    await appendEvent(this.journal, { type: 'entretien.fixe', actor: actorOf(viewer), subject: `candidate:${candidateId}`, data: { interview: id } }, this.now);
    return { ok: true, interviewId: id };
  }

  /** La direction marque un entretien tenu, une fois sa date passée, avec la personne qui l'a mené [R81]. */
  async markHeld(viewer: Viewer, interviewId: string, heldByName: unknown): Promise<{ ok: true } | InterviewRefusal> {
    const row = await this.db.first<{ candidate_id: string; network_id: string; scheduled_at: string }>('SELECT candidate_id, network_id, scheduled_at FROM candidate_interviews WHERE id = ?', [interviewId]);
    const denied = await this.gate(viewer, row && row.network_id === viewer.networkId ? row.candidate_id : `interview:${interviewId}`);
    if (denied) return denied;
    const name = clean(heldByName, 2, 80);
    if (!name) return { ok: false, rule: 'R81', code: 'no_interviewer' };
    if (Date.parse(row!.scheduled_at) > this.now().getTime()) return { ok: false, rule: 'R81', code: 'not_yet' };
    const { changes } = await this.db.run(
      'INSERT INTO candidate_interview_outcomes (interview_id, network_id, held_by_name, marked_by, marked_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (interview_id) DO NOTHING',
      [interviewId, viewer.networkId, name, actorOf(viewer), this.now().toISOString()],
    );
    if (changes === 1) await appendEvent(this.journal, { type: 'entretien.tenu', actor: actorOf(viewer), subject: `candidate:${row!.candidate_id}`, data: { interview: interviewId } }, this.now);
    return { ok: true };
  }

  /**
   * La décision d'entrée, par un humain nommé, avec son motif [R81, R14]. Aucun champ de note ni de score : la saisie
   * n'a que la décision, le motif et le nom de la personne qui décide. Un « oui » exige un entretien déjà tenu.
   */
  async decide(viewer: Viewer, candidateId: string, input: unknown): Promise<{ ok: true; decision: InterviewDecision; opensOnboarding: boolean } | InterviewRefusal> {
    const denied = await this.gate(viewer, candidateId);
    if (denied) return denied;
    const stop = async (rule: InterviewRefusal['rule'], code: string): Promise<InterviewRefusal> => {
      await appendEvent(this.journal, { type: 'decision_candidat.refusee', actor: actorOf(viewer), subject: `candidate:${candidateId}`, data: { rule, code } }, this.now);
      return { ok: false, rule, code };
    };
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return stop(null, 'bad_shape');
    const raw = input as Record<string, unknown>;
    if (Object.keys(raw).some((k) => !['decision', 'reason', 'deciderName'].includes(k))) return stop('R81', 'unknown_field');
    if (typeof raw.decision !== 'string' || !(INTERVIEW_DECISIONS as readonly string[]).includes(raw.decision)) return stop(null, 'bad_decision');
    const reason = clean(raw.reason, 5, 1000);
    if (!reason) return stop('R81', 'no_reason');
    const deciderName = clean(raw.deciderName, 2, 80);
    if (!deciderName) return stop('R81', 'no_decider');
    const decision = raw.decision as InterviewDecision;
    const at = this.now().toISOString();
    const held = await this.db.first<{ id: string }>(
      `SELECT i.id FROM candidate_interviews i JOIN candidate_interview_outcomes o ON o.interview_id = i.id
       WHERE i.candidate_id = ? AND i.scheduled_at <= ? ORDER BY i.scheduled_at DESC, i.id DESC LIMIT 1`,
      [candidateId, at],
    );
    if (decision === 'oui' && !held) return stop('R81', 'no_interview');
    await this.db.run(
      'INSERT INTO candidate_decisions (id, network_id, candidate_id, decision, reason, decided_by, decider_name, interview_id, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [this.newId(), viewer.networkId, candidateId, decision, reason, actorOf(viewer), deciderName, decision === 'oui' ? held!.id : null, at],
    );
    await appendEvent(this.journal, { type: 'decision_candidat.rangee', actor: actorOf(viewer), subject: `candidate:${candidateId}`, data: { rule: 'R81', decision } }, this.now);
    return { ok: true, decision, opensOnboarding: decision === 'oui' };
  }

  /**
   * Une candidature du réseau a-t-elle pour dernière décision « oui » ? Lu par le dossier d'agent (J04). Ne rend que
   * cela : ni motif, ni nom de la personne qui a décidé.
   */
  async acceptedIn(networkId: string, candidateId: string): Promise<boolean> {
    const row = await this.db.first<{ network_id: string }>('SELECT network_id FROM candidates WHERE id = ?', [candidateId]);
    if (!row || row.network_id !== networkId) return false;
    return (await this.decisionOf(candidateId))?.decision === 'oui';
  }

  /** La dernière décision d'une candidature, ou null ; lue seulement par la fiche, derrière ses droits. */
  private async decisionOf(candidateId: string): Promise<InterviewSheet['decision']> {
    const row = await this.db.first<{ decision: InterviewDecision; reason: string; decider_name: string; decided_at: string }>(
      'SELECT decision, reason, decider_name, decided_at FROM candidate_decisions WHERE candidate_id = ? ORDER BY decided_at DESC, rowid DESC LIMIT 1',
      [candidateId],
    );
    return row ? { decision: row.decision, reason: row.reason, deciderName: row.decider_name, decidedAt: row.decided_at } : null;
  }
}
