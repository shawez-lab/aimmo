import type { FicheClient, NewMessage } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { Exclusion, Message } from '../db/types.ts';
import type { FicheUnique } from '../fiche/fusion.ts';
import {
  DEFAULT_SEND_SETTINGS,
  decideSend,
  type PersonRelation,
  type SendDecision,
  type SendFacts,
  type SendKind,
  type SendRequest,
  type SendSettings,
} from './decision.ts';
import { localTime } from './horaires.ts';

export interface DecisionEnvoiOptions {
  settings?: SendSettings;
  newId?: () => string;
  now?: () => Date;
}

export interface PersonRelationRow {
  id: string;
  network_id: string;
  agent_id: string | null;
  person_id: string;
  relation: PersonRelation;
  noted_at: string;
  ended_at: string | null;
  created_at: string;
}

const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

/** Mots qui, seuls, valent demande d'arrêt. */
const STOP_ALONE = new Set(['stop', 'arret', 'arrete', 'arretez', 'desinscription', 'unsubscribe', 'stop svp', 'stop merci']);
/** Formules qui valent demande d'arrêt où qu'elles soient dans le message. */
const STOP_ANYWHERE = [
  /\bstop\b/,
  /\bdesinscri/,
  /\bunsubscribe\b/,
  /\bne (?:plus|pas) m(?:e |')(?:contacter|recontacter|ecrire|appeler|relancer)\b/,
  /\bne (?:m(?:e |')|nous )(?:contactez|recontactez|ecrivez|appelez|relancez|derangez|envoyez)(?: \S+){0,2} (?:plus|pas|jamais)\b/,
  /\barretez de m(?:e|') ?(?:contacter|ecrire|appeler|relancer)\b/,
  /\bretirez[- ]moi\b/,
  /\bplus de (?:messages?|mails?|sms|appels?)\b/,
  /\bne (?:veux|veut|voulons|souhaite|souhaitons|desire) (?:plus|pas) (?:etre|recevoir|de\b)/,
  /\bn'?(?:ecrivez|appelez|contactez|relancez|envoyez) plus\b/,
  /\blaissez[- ]moi tranquille\b/,
  /\b(?:supprimez|effacez|retirez|enlevez) (?:mon|mes|ma) (?:numero|coordonnees|adresse|mail|contact|donnees)/,
  // Filet pour le doute : « plus » suivi, à quelques mots près, d'un verbe de contact.
  /\bplus\b(?: \S+){0,3} (?:contacte|contacter|recontacter|ecrire|appele|appeler|relance|relancer|recevoir|deranger|derange)\w*/,
];

/**
 * Demande d'arrêt reconnue dans un message reçu [R04]. Lecture prudente : dans le doute, c'est un arrêt,
 * car écrire à tort coûte plus cher que se taire à tort.
 */
function plainText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^a-z0-9' -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isStopRequest(text: string): boolean {
  const plain = plainText(text);
  return STOP_ALONE.has(plain) || STOP_ANYWHERE.some((pattern) => pattern.test(plain));
}

/** Refus : « non », « non merci », « pas intéressé » [R02]. */
const REFUSAL = [/^non\b/, /\bpas interesse/, /\bca ne m'interesse pas\b/, /\bne suis pas interesse/, /\bpas vendeur/, /\bpas a vendre\b/];
/** Bien vendu [R02]. Une question (« est-il vendu ? ») ne vaut pas. */
const SOLD = [/^vendu\b/, /\bdeja vendu\b/, /\b(?:est|c'est|ete|a ete|bien|maison|appartement) vendue?s?\b/, /\b(?:avons|avez|ai|a|ont) (?:deja )?vendu\b/, /\bsous compromis\b/];

export type ReceivedExclusion = 'stop' | 'refused' | 'sold';

/**
 * Ce qu'un message reçu impose : arrêt [R04], refus ou bien vendu [R02], ou rien.
 * Lecture prudente : dans le doute, se taire.
 */
export function classifyReceived(text: string): ReceivedExclusion | null {
  if (isStopRequest(text)) return 'stop';
  const plain = plainText(text);
  if (REFUSAL.some((pattern) => pattern.test(plain))) return 'refused';
  if (!text.includes('?') && SOLD.some((pattern) => pattern.test(plain))) return 'sold';
  return null;
}

/**
 * Lit la fiche, toutes fiches fusionnées comprises, et rend la décision d'envoi avec la règle qui a décidé.
 * Range aussi ce qui la nourrit : demandes d'arrêt, liens de proximité, type des messages partis.
 */
export class DecisionEnvoi {
  private readonly settings: SendSettings;
  private readonly newId: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly db: SqlDatabase,
    private readonly store: FicheClient,
    private readonly fiche: FicheUnique,
    options: DecisionEnvoiOptions = {},
  ) {
    this.settings = options.settings ?? DEFAULT_SEND_SETTINGS;
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => new Date());
  }

  async facts(personId: string, at: Date, ignoreMessageIds: ReadonlySet<string> = new Set()): Promise<SendFacts> {
    const view = await this.fiche.view(personId);
    const ids = view.members.map((p) => p.id);
    const relations = await this.db.all<PersonRelationRow>(
      `SELECT * FROM person_relations WHERE person_id IN (${placeholders(ids.length)})`,
      ids,
    );
    return {
      exclusions: view.exclusions,
      consents: view.consents,
      messages: view.messages.filter((m) => !ignoreMessageIds.has(m.id)),
      relations,
      sentToday: await this.sentToday(view.person.network_id, at),
    };
  }

  /**
   * `ignoreMessageIds` : messages rangés dont l'envoi a échoué. Ils ne valent pas réponse : une réponse en panne
   * laisse le message reçu en attente de réponse [R01, R03].
   */
  async decide(personId: string, request: SendRequest, ignoreMessageIds: ReadonlySet<string> = new Set()): Promise<SendDecision> {
    return decideSend(request, await this.facts(personId, request.at, ignoreMessageIds), this.settings);
  }

  /** Messages partis dans le réseau le même jour local, par type plafonné [R11]. */
  async sentToday(networkId: string, at: Date): Promise<SendFacts['sentToday']> {
    const day = localTime(at, this.settings.timeZone).date;
    // Une journée locale tient toujours dans ± 36 heures autour de l'instant.
    const rows = await this.db.all<{ kind: SendKind; occurred_at: string }>(
      `SELECT kind, occurred_at FROM message_kinds
       WHERE network_id = ? AND kind IN ('review_request', 'partner') AND occurred_at >= ? AND occurred_at <= ?`,
      [networkId, new Date(at.getTime() - 36 * 3_600_000).toISOString(), new Date(at.getTime() + 36 * 3_600_000).toISOString()],
    );
    const counts = { review_request: 0, partner: 0 };
    for (const row of rows) {
      if (localTime(new Date(row.occurred_at), this.settings.timeZone).date !== day) continue;
      if (row.kind === 'review_request' || row.kind === 'partner') counts[row.kind] += 1;
    }
    return counts;
  }

  /** Range un message parti avec son type, pour les plafonds [R11]. N'envoie rien. */
  async recordSent(input: Omit<NewMessage, 'direction'>, kind: SendKind): Promise<Message> {
    const message = await this.store.recordMessage({ ...input, direction: 'out' });
    await this.db.run(
      'INSERT INTO message_kinds (message_id, network_id, agent_id, kind, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [message.id, message.network_id, message.agent_id, kind, message.occurred_at, this.now().toISOString()],
    );
    return message;
  }

  /**
   * Range un message reçu. S'il demande l'arrêt [R04], refuse ou dit le bien vendu [R02], la personne est
   * aussitôt exclue sur tous les canaux.
   */
  async recordReceived(
    input: Omit<NewMessage, 'direction' | 'authorKind'>,
  ): Promise<{ message: Message; exclusion: Exclusion | null }> {
    const message = await this.store.recordMessage({ ...input, direction: 'in', authorKind: 'person' });
    const reason = classifyReceived(input.body);
    const exclusion = reason
      ? await this.recordExclusion({ networkId: input.networkId, agentId: input.agentId ?? null, personId: input.personId, at: input.occurredAt, reason })
      : null;
    return { message, exclusion };
  }

  /** Demande d'arrêt reçue, sur n'importe quel canal : exclusion « stop » sur tous les canaux [R04]. */
  recordStopRequest(input: { networkId: string; agentId?: string | null; personId: string; at: Date }): Promise<Exclusion> {
    return this.recordExclusion({ ...input, reason: 'stop' });
  }

  /** Exclusion sur tous les canaux. Une exclusion déjà en cours pour la même raison n'est pas doublée ; rien n'est effacé. */
  async recordExclusion(input: {
    networkId: string;
    agentId?: string | null;
    personId: string;
    at: Date;
    reason: ReceivedExclusion;
  }): Promise<Exclusion> {
    const ids = await this.fiche.membersOf(input.personId);
    const existing = await this.db.first<Exclusion>(
      `SELECT * FROM exclusions WHERE person_id IN (${placeholders(ids.length)})
       AND reason = ? AND lifted_at IS NULL AND noted_at <= ? ORDER BY noted_at, id LIMIT 1`,
      [...ids, input.reason, input.at.toISOString()],
    );
    if (existing) return existing;
    return this.store.addExclusion({
      networkId: input.networkId,
      agentId: input.agentId ?? null,
      personId: input.personId,
      reason: input.reason,
      channel: null,
      notedAt: input.at,
    });
  }

  /** Note qu'une personne est un collègue, un associé ou un proche : jamais de demande d'avis [R11]. */
  async addRelation(input: {
    networkId: string;
    agentId?: string | null;
    personId: string;
    relation: PersonRelation;
    notedAt: Date;
  }): Promise<PersonRelationRow> {
    const row: PersonRelationRow = {
      id: this.newId(),
      network_id: input.networkId,
      agent_id: input.agentId ?? null,
      person_id: input.personId,
      relation: input.relation,
      noted_at: input.notedAt.toISOString(),
      ended_at: null,
      created_at: this.now().toISOString(),
    };
    await this.db.run(
      `INSERT INTO person_relations (id, network_id, agent_id, person_id, relation, noted_at, ended_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.network_id, row.agent_id, row.person_id, row.relation, row.noted_at, row.ended_at, row.created_at],
    );
    return row;
  }
}
