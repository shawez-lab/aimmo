/**
 * Entraînement aux objections avec l'IA, sur des cas inventés (M14, J08).
 *
 * L'agent s'entraîne contre l'IA, qui joue le vendeur ou l'acquéreur d'un cas inventé de la bibliothèque : une objection
 * sur les honoraires, l'exclusivité ou le prix. Le retour, écrit par le code, cite les règles et les points de script
 * de l'académie que l'agent a abordés ou non ; il ne note jamais l'agent, rien n'est rangé comme note et rien n'en est
 * montré à la direction, qui ne lit que le temps passé [R14]. La séance compte en temps d'académie, pas en heures
 * obligatoires (`TRAINING_COUNTS_MANDATORY`, faux tant que la direction n'en décide pas autrement).
 *
 * Un cas ne contient aucune donnée de client : il est refusé s'il cite une coordonnée ou une fiche [R15]. Ce que
 * l'agent écrit passe le même contrôle avant d'aller à l'IA. Sans IA (H13), en panne, trop lente ou hors des règles, la
 * réplique écrite du cas prend sa place et un texte le dit : rien ne casse [R12]. Aucune réplique ne promet de revenus
 * [R80]. Au journal, des identifiants et des nombres [R13].
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { checkRecruitingText } from './recrutement.ts';

export const TRAINING_OBJECTIONS = ['honoraires', 'exclusivite', 'prix'] as const;
export type TrainingObjection = (typeof TRAINING_OBJECTIONS)[number];
export type TrainingRole = 'vendeur' | 'acquereur';

/** La séance d'entraînement compte en temps d'académie ; en heures obligatoires seulement si la direction le règle. */
export const TRAINING_COUNTS_MANDATORY = false;

export interface TrainingCase {
  key: string;
  role: TrainingRole;
  objection: TrainingObjection;
  title: string;
  situation: string;
  opening: string;
  /** Les répliques écrites du cas, dites dans l'ordre quand l'IA ne répond pas. */
  replies: string[];
}

/** Les règles et points de script que le retour cite, par objection. Écrits une fois, les mêmes pour tous. */
export const OBJECTION_GUIDE: Readonly<Record<TrainingObjection, { rules: string[]; points: { label: string; words: RegExp }[] }>> = Object.freeze({
  honoraires: {
    rules: [
      'Les honoraires sont affichés toutes taxes comprises, avec qui les paie, avant tout engagement (R43).',
      'Le mandat écrit fixe les honoraires ; rien ne se promet à l’oral (M06).',
    ],
    points: [
      { label: 'Dire ce que les honoraires paient : le travail fait pour le vendeur', words: /accompagn|service|travail|diffus|visite|negoci|dossier/ },
      { label: 'Montrer le prix net vendeur, pas seulement le pourcentage', words: /net vendeur|net pour vous|ce qui vous reste|prix net/ },
      { label: 'Proposer une étape concrète', words: /rendez-vous|rdv|passer|venir|signer|mandat|on se voit/ },
    ],
  },
  exclusivite: {
    rules: [
      'Un mandat exclusif porte un paragraphe mis en évidence et une durée écrite (M06).',
      'Le vendeur peut se rétracter dans les délais légaux ; on le lui dit (R42).',
    ],
    points: [
      { label: 'Dire ce que l’exclusivité change pour le vendeur : un seul interlocuteur, un plan écrit', words: /seul interlocuteur|un interlocuteur|plan|engag|suivi|compte rendu/ },
      { label: 'Rassurer sur la durée et la sortie du mandat', words: /duree|mois|resili|sortir|retract|preavis/ },
      { label: 'Poser une question au vendeur', words: /\?/ },
    ],
  },
  prix: {
    rules: [
      'Le prix part des ventes réelles publiées, citées avec leur date (R28, R29).',
      'La décision du prix appartient au vendeur, conseillé par son agent (avis de valeur).',
    ],
    points: [
      { label: 'Appuyer le prix sur les ventes réelles du quartier', words: /vente|vendu|comparable|dvf|quartier|marche/ },
      { label: 'Reconnaître ce que la personne ressent avant de répondre', words: /comprends|entends|normal|legitime|je vois/ },
      { label: 'Laisser la décision à la personne', words: /vous decidez|votre choix|a vous de|decision vous|vous choisissez/ },
    ],
  },
});

/** La bibliothèque de cas inventés, écrits dans le code. Aucune vraie personne, aucun vrai bien. */
export const TRAINING_CASES: readonly TrainingCase[] = Object.freeze([
  {
    key: 'honoraires-vendeur',
    role: 'vendeur',
    objection: 'honoraires',
    title: 'Le vendeur trouve les honoraires trop élevés',
    situation: 'Maison familiale à vendre, vendeur pressé, il a vu une annonce de particulier à particulier chez son voisin.',
    opening: 'Vos honoraires, c’est trop. Mon voisin a vendu tout seul, sans payer personne.',
    replies: ['Oui, mais concrètement, qu’est-ce que vous faites de plus que lui ?', 'Et si je baisse un peu le prix moi-même, ça revient au même, non ?', 'D’accord, je vais y réfléchir.'],
  },
  {
    key: 'exclusivite-vendeur',
    role: 'vendeur',
    objection: 'exclusivite',
    title: 'Le vendeur refuse l’exclusivité',
    situation: 'Appartement en centre-ville, la vendeuse a déjà signé deux mandats simples ailleurs.',
    opening: 'Je ne veux pas d’exclusivité. Plus il y a d’agences, plus ça se vend vite.',
    replies: ['Et si ça ne marche pas, je suis coincée avec vous combien de temps ?', 'Les autres agences ne me demandent rien de tel.', 'Bon, expliquez-moi ce que vous feriez exactement.'],
  },
  {
    key: 'prix-vendeur',
    role: 'vendeur',
    objection: 'prix',
    title: 'Le vendeur veut un prix bien au-dessus du marché',
    situation: 'Maison avec jardin, le vendeur a fait des travaux et estime son bien bien plus haut que les ventes du quartier.',
    opening: 'Votre estimation est trop basse. Avec tous mes travaux, ma maison vaut beaucoup plus.',
    replies: ['Une autre agence m’a dit bien plus que vous.', 'Les ventes du quartier, ce n’est pas ma maison.', 'Et si on essaie plus haut pendant un mois ?'],
  },
  {
    key: 'prix-acquereur',
    role: 'acquereur',
    objection: 'prix',
    title: 'L’acquéreur veut négocier très bas',
    situation: 'Jeune couple, premier achat, ils ont visité deux fois et hésitent.',
    opening: 'On aime bien, mais c’est trop cher. On ne fera une offre que bien en dessous.',
    replies: ['Le diagnostic énergétique ne nous rassure pas.', 'Le vendeur acceptera, vous croyez ?', 'On va en parler ce soir.'],
  },
  {
    key: 'honoraires-acquereur',
    role: 'acquereur',
    objection: 'honoraires',
    title: 'L’acquéreur conteste les honoraires à sa charge',
    situation: 'Acquéreur qui achète pour louer, il compare plusieurs biens et tous les frais.',
    opening: 'Pourquoi c’est à moi de payer vos honoraires ? C’est le vendeur qui vous a appelé.',
    replies: ['Sur un autre bien, c’était le vendeur qui payait.', 'Ça fait monter les frais de notaire, non ?', 'Bon, et qu’est-ce que j’ai en échange ?'],
  },
]);

/** L'IA qui joue le rôle du cas. Absente tant que H13 n'est pas fait. */
export interface ObjectionCoach {
  reply(input: { case: Pick<TrainingCase, 'role' | 'objection' | 'situation' | 'opening'>; history: { speaker: 'agent' | 'role'; text: string }[] }): Promise<string>;
}

export const TRAINING_FALLBACK_NOTICE = 'L’entraînement avec l’IA n’est pas disponible pour le moment : voici la réplique écrite du cas.';

export type TrainingRefusal = { ok: false; rule: 'R16' | 'R15' | 'R80' | null; code: string };

export interface TrainingFeedback {
  objection: TrainingObjection;
  rules: string[];
  /** Les points de script abordés ou non : un repère pour l'agent, jamais une note. */
  points: { label: string; touched: boolean }[];
}

export interface EntrainementOptions {
  now?: () => Date;
  newId?: () => string;
  coach?: ObjectionCoach;
  aiTimeoutMs?: number;
}

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PHONE = /(?:\+33|0033|\b0)\s*[1-9](?:[\s.-]*\d{2}){4}\b/;
const FICHE_REF = /\b(?:person|personne|fiche|client|property|bien)\s*[:#]\s*\S+|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const IBAN = /\bFR\d{2}[\s\d]{20,}/i;

const plain = (text: string): string => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Vrai si le texte cite une coordonnée, une fiche ou un compte : il n'a rien à faire dans un entraînement [R15]. */
export function citesClientData(text: string): boolean {
  return EMAIL.test(text) || PHONE.test(text) || FICHE_REF.test(text) || IBAN.test(text);
}

function timeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('délai dépassé')), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

interface CaseRow {
  id: string;
  role: TrainingRole;
  objection: TrainingObjection;
  title: string;
  situation: string;
  opening: string;
  replies: string;
}

export class Entrainement {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly options: EntrainementOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, subject: string | null, code: string): Promise<TrainingRefusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind: 'training', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  private async activeAgent(viewer: Viewer): Promise<boolean> {
    if (viewer.role !== 'agent') return false;
    const row = await this.db.first<{ status: string }>('SELECT status FROM agents WHERE id = ? AND network_id = ?', [viewer.userId, viewer.networkId]);
    return row?.status === 'active';
  }

  /** La direction ajoute un cas inventé. Une coordonnée, une fiche ou une promesse de revenus : refusé. */
  async addCase(
    viewer: Viewer,
    input: { role: unknown; objection: unknown; title: unknown; situation: unknown; opening: unknown; replies: unknown },
  ): Promise<{ ok: true; key: string } | TrainingRefusal> {
    if (viewer.role !== 'direction') return this.refuse(viewer, null, 'role');
    if (input.role !== 'vendeur' && input.role !== 'acquereur') return { ok: false, rule: null, code: 'invalid_role' };
    if (typeof input.objection !== 'string' || !(TRAINING_OBJECTIONS as readonly string[]).includes(input.objection)) return { ok: false, rule: null, code: 'invalid_objection' };
    const text = (v: unknown, min: number, max: number): string | null => (typeof v === 'string' && v.trim().length >= min && v.trim().length <= max ? v.trim() : null);
    const title = text(input.title, 3, 120);
    const situation = text(input.situation, 10, 800);
    const opening = text(input.opening, 5, 400);
    const replies = Array.isArray(input.replies) ? input.replies.map((r) => text(r, 2, 400)) : [];
    if (!title || !situation || !opening || replies.length === 0 || replies.length > 10 || replies.some((r) => r === null)) return { ok: false, rule: null, code: 'invalid_case' };
    const all = [title, situation, opening, ...(replies as string[])];
    if (all.some(citesClientData)) {
      await appendEvent(this.journal, { type: 'entrainement.cas_refuse', actor: this.actor(viewer), subject: null, data: { rule: 'R15' } }, this.now);
      return { ok: false, rule: 'R15', code: 'client_data' };
    }
    if (all.some((t) => !checkRecruitingText(t).ok)) return { ok: false, rule: 'R80', code: 'income_promise' };
    const id = this.newId();
    await this.db.run(
      'INSERT INTO training_cases (id, network_id, role, objection, title, situation, opening, replies, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, viewer.networkId, input.role, input.objection, title, situation, opening, JSON.stringify(replies), this.actor(viewer), this.now().toISOString()],
    );
    await appendEvent(this.journal, { type: 'entrainement.cas', actor: this.actor(viewer), subject: `training_case:${id}`, data: { objection: input.objection } }, this.now);
    return { ok: true, key: `reseau:${id}` };
  }

  /** La bibliothèque : les cas du code, puis ceux du réseau. Lue par les agents actifs et la direction. */
  async cases(viewer: Viewer): Promise<{ ok: true; value: TrainingCase[] } | TrainingRefusal> {
    if (viewer.role !== 'direction' && !(await this.activeAgent(viewer))) return this.refuse(viewer, null, 'role');
    const rows = await this.db.all<CaseRow>('SELECT id, role, objection, title, situation, opening, replies FROM training_cases WHERE network_id = ? ORDER BY created_at, id', [viewer.networkId]);
    return { ok: true, value: [...TRAINING_CASES, ...rows.map((r) => this.fromRow(r))] };
  }

  private fromRow(r: CaseRow): TrainingCase {
    return { key: `reseau:${r.id}`, role: r.role, objection: r.objection, title: r.title, situation: r.situation, opening: r.opening, replies: JSON.parse(r.replies) as string[] };
  }

  private async caseOf(networkId: string, key: string): Promise<TrainingCase | null> {
    const builtIn = TRAINING_CASES.find((c) => c.key === key);
    if (builtIn) return builtIn;
    if (!key.startsWith('reseau:')) return null;
    const row = await this.db.first<CaseRow>('SELECT id, role, objection, title, situation, opening, replies FROM training_cases WHERE id = ? AND network_id = ?', [key.slice(7), networkId]);
    return row ? this.fromRow(row) : null;
  }

  /** L'agent ouvre une séance sur un cas : le rôle dit sa première réplique. */
  async start(viewer: Viewer, caseKey: string): Promise<{ ok: true; sessionId: string; opening: string } | TrainingRefusal> {
    if (!(await this.activeAgent(viewer))) return this.refuse(viewer, null, viewer.role === 'agent' ? 'agent_inactive' : 'role');
    const c = await this.caseOf(viewer.networkId, caseKey);
    if (!c) return { ok: false, rule: null, code: 'unknown_case' };
    const id = this.newId();
    const at = this.now().toISOString();
    await this.db.run('INSERT INTO training_sessions (id, network_id, agent_id, case_key, started_at, ended_at, minutes) VALUES (?, ?, ?, ?, ?, NULL, NULL)', [id, viewer.networkId, viewer.userId, c.key, at]);
    await this.db.run("INSERT INTO training_turns (session_id, n, speaker, body, at) VALUES (?, 1, 'secours', ?, ?)", [id, c.opening, at]);
    await appendEvent(this.journal, { type: 'entrainement.debut', actor: this.actor(viewer), subject: `training_session:${id}`, data: { objection: c.objection } }, this.now);
    return { ok: true, sessionId: id, opening: c.opening };
  }

  private async session(viewer: Viewer, sessionId: string): Promise<{ case: TrainingCase; endedAt: string | null; startedAt: string } | TrainingRefusal> {
    const row = await this.db.first<{ agent_id: string; network_id: string; case_key: string; ended_at: string | null; started_at: string }>(
      'SELECT agent_id, network_id, case_key, ended_at, started_at FROM training_sessions WHERE id = ?',
      [sessionId],
    );
    // La séance est à l'agent seul : ni la direction ni un autre agent ne la lisent [R14, R16].
    if (!row || row.network_id !== viewer.networkId || viewer.role !== 'agent' || row.agent_id !== viewer.userId) return this.refuse(viewer, `training_session:${sessionId}`, 'not_owner');
    const c = await this.caseOf(row.network_id, row.case_key);
    if (!c) return { ok: false, rule: null, code: 'unknown_case' };
    return { case: c, endedAt: row.ended_at, startedAt: row.started_at };
  }

  private async turns(sessionId: string): Promise<{ n: number; speaker: 'agent' | 'ia' | 'secours'; body: string }[]> {
    return this.db.all('SELECT n, speaker, body FROM training_turns WHERE session_id = ? ORDER BY n', [sessionId]);
  }

  /**
   * L'agent répond ; le rôle réplique. Ce que l'agent écrit ne doit citer aucune donnée de client [R15]. La réplique de
   * l'IA doit tenir les règles ; sinon, ou sans IA, la réplique écrite du cas, annoncée comme telle [R12, R80].
   */
  async turn(viewer: Viewer, sessionId: string, text: unknown): Promise<{ ok: true; reply: string; byAi: boolean; notice: string | null } | TrainingRefusal> {
    const s = await this.session(viewer, sessionId);
    if ('ok' in s) return s;
    if (s.endedAt !== null) return { ok: false, rule: null, code: 'ended' };
    const said = typeof text === 'string' ? text.trim() : '';
    if (said.length < 1 || said.length > 1000) return { ok: false, rule: null, code: 'invalid_text' };
    if (citesClientData(said)) {
      await appendEvent(this.journal, { type: 'entrainement.texte_refuse', actor: this.actor(viewer), subject: `training_session:${sessionId}`, data: { rule: 'R15' } }, this.now);
      return { ok: false, rule: 'R15', code: 'client_data' };
    }
    const history = await this.turns(sessionId);
    const n = history.length + 1;
    await this.db.run("INSERT INTO training_turns (session_id, n, speaker, body, at) VALUES (?, ?, 'agent', ?, ?)", [sessionId, n, said, this.now().toISOString()]);

    let reply: string | null = null;
    let cause: string | null = null;
    if (this.options.coach) {
      try {
        const out = await timeout(
          this.options.coach.reply({
            case: { role: s.case.role, objection: s.case.objection, situation: s.case.situation, opening: s.case.opening },
            history: [...history, { n, speaker: 'agent' as const, body: said }].map((t) => ({ speaker: t.speaker === 'agent' ? ('agent' as const) : ('role' as const), text: t.body })),
          }),
          this.options.aiTimeoutMs ?? 20_000,
        );
        const clean = typeof out === 'string' ? out.trim() : '';
        if (clean.length < 1 || clean.length > 800) cause = 'length';
        else if (citesClientData(clean)) cause = 'client_data';
        else if (!checkRecruitingText(clean).ok) cause = 'income_promise';
        else reply = clean;
      } catch (error) {
        cause = error instanceof Error && error.message === 'délai dépassé' ? 'timeout' : 'error';
      }
      if (cause) await appendEvent(this.journal, { type: 'entrainement.ia_refusee', actor: 'system:entrainement', subject: `training_session:${sessionId}`, data: { cause } }, this.now);
    }
    const byAi = reply !== null;
    if (!byAi) {
      const agentTurns = history.filter((t) => t.speaker === 'agent').length;
      reply = s.case.replies[Math.min(agentTurns, s.case.replies.length - 1)]!;
    }
    await this.db.run('INSERT INTO training_turns (session_id, n, speaker, body, at) VALUES (?, ?, ?, ?, ?)', [sessionId, n + 1, byAi ? 'ia' : 'secours', reply!, this.now().toISOString()]);
    return { ok: true, reply: reply!, byAi, notice: byAi ? null : TRAINING_FALLBACK_NOTICE };
  }

  /** La séance se termine : sa durée compte en temps d'académie ; le retour cite les règles et les points de script. */
  async end(viewer: Viewer, sessionId: string): Promise<{ ok: true; minutes: number; feedback: TrainingFeedback } | TrainingRefusal> {
    const s = await this.session(viewer, sessionId);
    if ('ok' in s) return s;
    if (s.endedAt !== null) return { ok: false, rule: null, code: 'ended' };
    const at = this.now();
    const minutes = Math.min(120, Math.max(1, Math.ceil((at.getTime() - Date.parse(s.startedAt)) / 60_000)));
    const { changes } = await this.db.run('UPDATE training_sessions SET ended_at = ?, minutes = ? WHERE id = ? AND ended_at IS NULL', [at.toISOString(), minutes, sessionId]);
    if (changes !== 1) return { ok: false, rule: null, code: 'ended' };
    await appendEvent(this.journal, { type: 'entrainement.fin', actor: this.actor(viewer), subject: `training_session:${sessionId}`, data: { minutes } }, this.now);
    const said = plain((await this.turns(sessionId)).filter((t) => t.speaker === 'agent').map((t) => t.body).join('\n'));
    const guide = OBJECTION_GUIDE[s.case.objection];
    return { ok: true, minutes, feedback: { objection: s.case.objection, rules: [...guide.rules], points: guide.points.map((p) => ({ label: p.label, touched: p.words.test(said) })) } };
  }

  /** Le temps d'entraînement d'un agent : lu par lui-même et par la direction. Rien d'autre n'en sort [R14, R16]. */
  async academyMinutes(viewer: Viewer, agentId: string): Promise<{ ok: true; minutes: number; sessions: number } | TrainingRefusal> {
    const allowed = viewer.role === 'direction' || (viewer.role === 'agent' && viewer.userId === agentId);
    if (!allowed) return this.refuse(viewer, `agent:${agentId}`, viewer.role === 'agent' ? 'not_assigned' : 'role');
    const row = await this.db.first<{ minutes: number | null; sessions: number }>(
      'SELECT sum(minutes) AS minutes, count(*) AS sessions FROM training_sessions WHERE agent_id = ? AND network_id = ? AND ended_at IS NOT NULL',
      [agentId, viewer.networkId],
    );
    return { ok: true, minutes: Number(row?.minutes ?? 0), sessions: Number(row?.sessions ?? 0) };
  }
}
