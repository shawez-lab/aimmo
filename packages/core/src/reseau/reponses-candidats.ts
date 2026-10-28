/**
 * Réponses de l'assistant aux questions des candidats (M14, J02).
 *
 * L'assistant ne répond qu'à partir des réponses écrites et datées par la direction, une par sujet ; il ne rédige rien
 * lui-même [R10]. Le sujet d'une question est reconnu par une liste fermée de mots, sans IA, la même pour tous. Une
 * question sur ce que gagne un agent renvoie toujours à la réponse « rémunération », c'est-à-dire à la grille écrite,
 * jamais à un chiffre de revenu [R80]. Sans réponse écrite, rien n'est inventé : le candidat reçoit un texte de secours
 * qui dit qu'une personne lui répond, et la direction reçoit une tâche [R12].
 *
 * Chaque réponse écrite et chaque réponse préparée passent le contrôle des promesses de revenus [R80] et celui du texte
 * (aucun mot sur l'IA hors la mention légale [R06], formules interdites [R07, R08]). La première réponse à un candidat
 * porte la mention de l'assistant [R06]. Un candidat sans accord d'être recontacté ne reçoit rien [R03]. Une question ne
 * reçoit qu'une réponse [R18].
 *
 * Rien ne part d'ici : la réponse est rangée dans la boîte d'essai (`mode = 'essai'`), tant que le plan n'a pas mis
 * d'envoi aux candidats en service. Le texte de la question n'est jamais rangé ni écrit au journal [R13].
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { checkText, plain } from '../envoi/texte.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { checkRecruitingText } from './recrutement.ts';

export const RECRUITING_TOPICS = ['remuneration', 'frais', 'essai', 'statut', 'formation', 'parrainage', 'zone', 'outils'] as const;
export type RecruitingTopic = (typeof RECRUITING_TOPICS)[number];

/**
 * Les mots qui désignent chaque sujet, sans accents ni majuscules, dans l'ordre où ils sont essayés : la rémunération
 * d'abord, pour qu'une question sur l'argent ne reçoive jamais une autre réponse.
 */
export const TOPIC_WORDS: Readonly<Record<RecruitingTopic, RegExp>> = Object.freeze({
  remuneration: /\b(?:gagn\w*|gains?|salaires?|revenus?|remuner\w*|commissions?|combien\s+(?:je|on|vous|un agent|les agents)|pay[eé]s?|payer|paie|chiffre d'affaires|rapporte|vivre de|baremes?|grille|pourcentages?|part de l'agent)\b/,
  frais: /\b(?:frais|pack|abonnements?|cout\w*|tarifs?|prix|payant|gratuit\w*|facture\w*)\b/,
  essai: /\b(?:essai|30 jours|trente jours|engagement|preavis|partir|quitter|sans engagement)\b/,
  statut: /\b(?:statut|agent commercial|independant|auto.?entrepreneur|micro.?entreprise|rsac|immatricul\w*|siret|carte|attestation|assurance|salarie)\b/,
  formation: /\b(?:formations?|former|academie|debutants?|experience|apprendre|reconversion|loi alur|heures)\b/,
  parrainage: /\b(?:parrain\w*|filleuls?|recruter|coopter|cooptation)\b/,
  zone: /\b(?:zones?|secteurs?|villes?|communes?|region|departement|dijon|cote.d'or|bourgogne|clients? transmis|clients? fournis)\b/,
  outils: /\b(?:logiciels?|applications?|outils?|crm|telephone|ordinateur|signature|portails?|annonces?)\b/,
});

/** Mention légale de l'assistant, au premier message à un candidat [R06]. */
export const CANDIDATE_MENTION = 'Réponse immédiate de l’assistant IA du réseau AIMMO, une personne de l’équipe vous recontacte personnellement.';
/** Texte de secours, sans IA, quand aucune réponse écrite ne couvre la question [R12]. */
export const CANDIDATE_FALLBACK = 'Merci pour votre question. Une personne de l’équipe vous répond directement, au plus vite.';

export function topicOf(question: string): RecruitingTopic | null {
  const p = plain(question);
  for (const topic of RECRUITING_TOPICS) if (TOPIC_WORDS[topic].test(p)) return topic;
  return null;
}

export type PreparedReply =
  | { status: 'prepared'; replyId: string; topic: RecruitingTopic | null; answered: boolean }
  | { status: 'already'; replyId: string }
  | { status: 'refused'; rule: 'R03' | 'R80' | 'R06' | null; code: string };

export interface ReponsesCandidatsOptions {
  now?: () => Date;
  newId?: () => string;
}

const actorOf = (viewer: Viewer): string => `${String(viewer.role)}:${viewer.userId}`;

/** Les problèmes d'un texte destiné à un candidat : promesse de revenus, puis contrôle du texte (sans chiffre imposé). */
function problemsOf(body: string): { rule: 'R80' | 'R06' | null; code: string } | null {
  if (!checkRecruitingText(body).ok) return { rule: 'R80', code: 'income_promise' };
  const problems = checkText(body, { audience: 'client', channel: 'email', figures: body.match(/\d+/g) ?? [] }).filter((p) => p.rule !== 'question');
  if (problems.length === 0) return null;
  const first = problems[0]!;
  return { rule: first.rule === 'R06' ? 'R06' : null, code: `text_${first.rule}` };
}

export class ReponsesCandidats {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: ReponsesCandidatsOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  private async deny(viewer: Viewer, kind: string): Promise<{ ok: false; rule: 'R16'; code: 'role' }> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: actorOf(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind, code: 'role' } }, this.now);
    return { ok: false, rule: 'R16', code: 'role' };
  }

  /** La direction écrit, ou réécrit, la réponse d'un sujet. Une promesse de revenus est refusée [R80]. */
  async write(viewer: Viewer, topic: unknown, body: unknown): Promise<{ ok: true; id: string } | { ok: false; rule: 'R16' | 'R80' | 'R06' | null; code: string }> {
    if (viewer.role !== 'direction') return this.deny(viewer, 'recruiting_answer');
    if (typeof topic !== 'string' || !(RECRUITING_TOPICS as readonly string[]).includes(topic)) return { ok: false, rule: null, code: 'bad_topic' };
    if (typeof body !== 'string' || body.trim() === '' || body.trim().length > 1500) return { ok: false, rule: null, code: 'bad_body' };
    const text = body.trim();
    const problem = problemsOf(text);
    if (problem) {
      await appendEvent(this.journal, { type: 'reponse_candidat.refusee', actor: actorOf(viewer), subject: `network:${viewer.networkId}`, data: { rule: problem.rule, code: problem.code, topic } }, this.now);
      return { ok: false, ...problem };
    }
    const id = this.newId();
    await this.db.run('INSERT INTO recruiting_answers (id, network_id, topic, body, written_by, written_at) VALUES (?, ?, ?, ?, ?, ?)', [id, viewer.networkId, topic, text, actorOf(viewer), this.now().toISOString()]);
    await appendEvent(this.journal, { type: 'reponse_candidat.ecrite', actor: actorOf(viewer), subject: `recruiting_answer:${id}`, data: { topic } }, this.now);
    return { ok: true, id };
  }

  /** Les réponses en vigueur, une par sujet, la plus récente. */
  async current(viewer: Viewer): Promise<{ ok: true; value: { topic: RecruitingTopic; body: string; writtenAt: string }[] } | { ok: false; rule: 'R16'; code: 'role' }> {
    if (viewer.role !== 'direction') return this.deny(viewer, 'recruiting_answer');
    const out: { topic: RecruitingTopic; body: string; writtenAt: string }[] = [];
    for (const topic of RECRUITING_TOPICS) {
      const row = await this.latest(viewer.networkId, topic);
      if (row) out.push({ topic, body: row.body, writtenAt: row.written_at });
    }
    return { ok: true, value: out };
  }

  private latest(networkId: string, topic: RecruitingTopic): Promise<{ id: string; body: string; written_at: string } | null> {
    return this.db.first('SELECT id, body, written_at FROM recruiting_answers WHERE network_id = ? AND topic = ? ORDER BY written_at DESC, rowid DESC LIMIT 1', [networkId, topic]);
  }

  /**
   * Prépare la réponse à une question d'un candidat. `questionKey` identifie la question (l'identifiant du message
   * reçu) : une question ne reçoit qu'une réponse [R18]. Le texte de la question sert seulement à reconnaître son sujet.
   */
  async answer(networkId: string, candidateId: string, questionKey: string, question: string): Promise<PreparedReply> {
    const candidate = await this.db.first<{ id: string; contact_consent_at: string | null }>('SELECT id, contact_consent_at FROM candidates WHERE id = ? AND network_id = ?', [candidateId, networkId]);
    if (!candidate) return { status: 'refused', rule: null, code: 'unknown_candidate' };
    if (typeof questionKey !== 'string' || questionKey === '' || questionKey.length > 128) return { status: 'refused', rule: null, code: 'bad_key' };
    const refuse = async (rule: 'R03' | 'R80' | 'R06' | null, code: string): Promise<PreparedReply> => {
      await appendEvent(this.journal, { type: 'reponse_candidat.non_preparee', actor: 'assistant', subject: `candidate:${candidateId}`, data: { rule, code } }, this.now);
      return { status: 'refused', rule, code };
    };
    // Sans accord d'être recontacté, aucune réponse [R03].
    if (candidate.contact_consent_at === null) return refuse('R03', 'no_consent');
    const existing = await this.db.first<{ id: string }>('SELECT id FROM candidate_replies WHERE candidate_id = ? AND question_key = ?', [candidateId, questionKey]);
    if (existing) return { status: 'already', replyId: existing.id };

    const topic = typeof question === 'string' ? topicOf(question) : null;
    const written = topic ? await this.latest(networkId, topic) : null;
    // La réponse écrite, revérifiée ; sinon le texte de secours et une tâche pour la direction [R10, R12].
    let core = written?.body ?? CANDIDATE_FALLBACK;
    let answered = written !== null;
    if (written && problemsOf(written.body)) {
      core = CANDIDATE_FALLBACK;
      answered = false;
    }
    const first = (await this.db.first('SELECT id FROM candidate_replies WHERE candidate_id = ? LIMIT 1', [candidateId])) === null;
    const body = first ? `${core}\n\n${CANDIDATE_MENTION}` : core;
    // Dernier filet : le texte final passe le contrôle des promesses de revenus [R80].
    if (!checkRecruitingText(body).ok) return refuse('R80', 'income_promise');

    const at = this.now().toISOString();
    const id = this.newId();
    const { changes } = await this.db.run(
      `INSERT INTO candidate_replies (id, network_id, candidate_id, question_key, topic, answer_id, body, with_mention, mode, prepared_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'essai', ?) ON CONFLICT (candidate_id, question_key) DO NOTHING`,
      [id, networkId, candidateId, questionKey, topic, answered ? written!.id : null, body, first ? 1 : 0, at],
    );
    if (changes !== 1) {
      const row = await this.db.first<{ id: string }>('SELECT id FROM candidate_replies WHERE candidate_id = ? AND question_key = ?', [candidateId, questionKey]);
      return { status: 'already', replyId: row?.id ?? id };
    }
    if (!answered) {
      await this.db.run('INSERT INTO recruiting_tasks (id, network_id, candidate_id, question_key, topic, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (candidate_id, question_key) DO NOTHING', [
        this.newId(),
        networkId,
        candidateId,
        questionKey,
        topic,
        at,
      ]);
    }
    await appendEvent(this.journal, { type: 'reponse_candidat.preparee', actor: 'assistant', subject: `candidate:${candidateId}`, data: { topic, answered, mode: 'essai', mention: first } }, this.now);
    return { status: 'prepared', replyId: id, topic, answered };
  }

  /** Les questions sans réponse écrite, pour la direction, de la plus ancienne à la plus récente. */
  async openTasks(viewer: Viewer): Promise<{ ok: true; value: { taskId: string; candidateId: string; topic: RecruitingTopic | null; createdAt: string }[] } | { ok: false; rule: 'R16'; code: 'role' }> {
    if (viewer.role !== 'direction') return this.deny(viewer, 'recruiting_task');
    const rows = await this.db.all<{ id: string; candidate_id: string; topic: RecruitingTopic | null; created_at: string }>(
      'SELECT id, candidate_id, topic, created_at FROM recruiting_tasks WHERE network_id = ? AND done_at IS NULL ORDER BY created_at, id',
      [viewer.networkId],
    );
    return { ok: true, value: rows.map((r) => ({ taskId: r.id, candidateId: r.candidate_id, topic: r.topic, createdAt: r.created_at })) };
  }

  /** « Répondu » par la direction ; la tâche reste [R17]. */
  async taskDone(viewer: Viewer, taskId: string): Promise<{ ok: true } | { ok: false; rule: 'R16' | null; code: string }> {
    if (viewer.role !== 'direction') return this.deny(viewer, 'recruiting_task');
    const { changes } = await this.db.run('UPDATE recruiting_tasks SET done_at = ?, done_by = ? WHERE id = ? AND network_id = ? AND done_at IS NULL', [this.now().toISOString(), actorOf(viewer), taskId, viewer.networkId]);
    return changes === 1 ? { ok: true } : { ok: false, rule: null, code: 'unknown' };
  }

  /** Les réponses préparées pour un candidat, dans la boîte d'essai, pour la direction. */
  async repliesOf(viewer: Viewer, candidateId: string): Promise<{ ok: true; value: { replyId: string; topic: string | null; body: string; mode: 'essai'; preparedAt: string }[] } | { ok: false; rule: 'R16'; code: 'role' }> {
    if (viewer.role !== 'direction') return this.deny(viewer, 'candidate_reply');
    const rows = await this.db.all<{ id: string; topic: string | null; body: string; prepared_at: string }>(
      'SELECT id, topic, body, prepared_at FROM candidate_replies WHERE network_id = ? AND candidate_id = ? ORDER BY prepared_at, id',
      [viewer.networkId, candidateId],
    );
    return { ok: true, value: rows.map((r) => ({ replyId: r.id, topic: r.topic, body: r.body, mode: 'essai' as const, preparedAt: r.prepared_at })) };
  }
}
