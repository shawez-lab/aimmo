/**
 * Rattachement de chaque message reçu à la fiche de la personne [C02].
 * Retrouve la personne par mail, téléphone ou compte normalisés (S04), ou par son identifiant chez le canal,
 * sinon crée sa fiche. Rattache le message, la source et, quand la personne écrit d'elle-même, l'accord pour lui
 * répondre (S05). Une demande d'arrêt [R04], un refus ou « vendu » [R02] excluent dès la réception.
 * N'envoie rien : toute réponse sortira par le contrôle central (S06). Rien n'est jamais effacé [R17].
 */
import type { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { Channel, Exclusion, IdentifierKind, Person } from '../db/types.ts';
import type { DecisionEnvoi, ReceivedExclusion } from '../envoi/service.ts';
import type { FicheUnique } from '../fiche/fusion.ts';
import { matchKey, normalizeIdentifier } from '../fiche/normalize.ts';
import type { SenderIdentifier } from './entrant.ts';
import { senderIdentifiers, type InboundRow, type Reception } from './reception.ts';

/**
 * `created` : fiche créée ; `matched` : fiche retrouvée ; `merged` : plusieurs fiches de la même personne retrouvées
 * et réunies (S04) ; `ambiguous` : plusieurs fiches qui ne peuvent pas être réunies sans la direction (deux agents) :
 * message rattaché à la plus ancienne, exclusions des autres reprises, agent prévenu.
 */
export type AttachOutcome = 'created' | 'matched' | 'merged' | 'ambiguous';

export interface Attached {
  inboundId: string;
  /** null : le message était déjà pris par un autre traitement [R18]. */
  outcome: AttachOutcome | null;
  personId: string | null;
  messageId: string | null;
  /** Ce que le message lui-même impose : arrêt, refus ou bien vendu. */
  exclusion: ReceivedExclusion | null;
  /** Vrai si la personne est exclue au moment du rattachement : rien d'automatique ne doit lui répondre [R02, R04]. */
  silenced: boolean;
  /** Vrai si un humain doit regarder : fiches à réunir par la direction. */
  needsHuman: boolean;
}

export interface AttachLogRow {
  id: string;
  network_id: string;
  inbound_id: string;
  person_id: string | null;
  message_id: string | null;
  outcome: AttachOutcome;
  exclusion: ReceivedExclusion | null;
  silenced: number;
  reason: string;
  occurred_at: string;
  created_at: string;
}

export interface RattachementOptions {
  now?: () => Date;
  newId?: () => string;
}

/** Finalité de l'accord né d'un message que la personne a écrit d'elle-même : lui répondre (S05). */
export const REPLY_PURPOSE = 'reply';

const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

/** Identifiants valables du message, renormalisés : on ne rapproche jamais sur une valeur incomprise. */
function validIdentifiers(row: InboundRow): SenderIdentifier[] {
  const seen = new Set<string>();
  const out: SenderIdentifier[] = [];
  for (const id of senderIdentifiers(row)) {
    const value = normalizeIdentifier(id.kind, id.value);
    if (value === null) continue;
    const key = `${id.kind}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: id.kind, value });
  }
  return out;
}

/** Clés de contact du message : identifiants normalisés, puis identifiant propre au canal. */
export function contactKeys(row: Pick<InboundRow, 'channel' | 'kind' | 'sender_channel_id' | 'sender_identifiers'>): string[] {
  const keys = new Set<string>();
  for (const id of senderIdentifiers(row)) {
    const value = normalizeIdentifier(id.kind, id.value);
    if (value !== null) keys.add(matchKey(id.kind, value));
  }
  // Un identifiant chez le canal n'a de sens que dans son espace : canal et type (message privé, commentaire, session).
  if (row.sender_channel_id) keys.add(`${row.channel}:${row.kind}:${row.sender_channel_id}`);
  return [...keys].sort();
}

/** Canaux sur lesquels la personne a demandé une réponse en écrivant [R03]. */
function replyChannels(row: InboundRow, identifiers: readonly SenderIdentifier[]): Channel[] {
  switch (row.channel) {
    case 'instagram':
    case 'facebook':
    case 'whatsapp':
    case 'email':
      return [row.channel];
    case 'site': {
      // Formulaire « Être rappelé » : la personne demande qu'on la rappelle aux coordonnées qu'elle donne.
      if (row.kind !== 'form') return [];
      const kinds = new Set<IdentifierKind>(identifiers.map((i) => i.kind));
      return (['phone', 'email'] as const).filter((c) => kinds.has(c));
    }
  }
}

function activeAt(e: Pick<Exclusion, 'noted_at' | 'lifted_at'>, at: number): boolean {
  return Date.parse(e.noted_at) <= at && (e.lifted_at === null || Date.parse(e.lifted_at) > at);
}

export class Rattachement {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly store: FicheClient,
    private readonly fiche: FicheUnique,
    private readonly decisions: DecisionEnvoi,
    private readonly reception: Reception,
    options: RattachementOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /** Traite tous les messages rangés et pas encore pris, les plus anciens d'abord. */
  async attachPending(networkId: string): Promise<Attached[]> {
    const done: Attached[] = [];
    for (const row of await this.reception.pending(networkId)) done.push(await this.attach(row.id));
    return done;
  }

  /**
   * Rattache un message reçu à sa fiche. Le message est d'abord pris par `claim` : deux traitements simultanés
   * du même message n'en rattachent qu'un [R18]. En cas d'erreur, il est rendu pour être repris, jamais perdu.
   */
  async attach(inboundId: string): Promise<Attached> {
    if (!(await this.reception.claim(inboundId))) {
      return { inboundId, outcome: null, personId: null, messageId: null, exclusion: null, silenced: false, needsHuman: false };
    }
    try {
      return await this.attachClaimed(inboundId);
    } catch (error) {
      await this.reception.release(inboundId);
      throw error;
    }
  }

  journal(inboundId: string): Promise<AttachLogRow[]> {
    return this.db.all<AttachLogRow>('SELECT * FROM attach_log WHERE inbound_id = ? ORDER BY occurred_at, id', [inboundId]);
  }

  private async attachClaimed(inboundId: string): Promise<Attached> {
    const row = await this.reception.get(inboundId);
    if (!row || row.kind === 'unreadable') throw new Error(`Message reçu inconnu ou illisible : ${inboundId}`);
    const networkId = row.network_id;
    const at = this.now();
    const identifiers = validIdentifiers(row);
    const keys = contactKeys(row);

    // 1. Retrouver : toutes les fiches gardées qui portent un des identifiants ou une des clés du message.
    let roots = await this.candidates(networkId, identifiers, keys);
    let outcome: AttachOutcome;
    if (roots.length === 0) {
      roots = [await this.store.createPerson({ networkId, firstName: row.sender_name })];
      outcome = 'created';
    } else {
      outcome = roots.length === 1 ? 'matched' : 'merged';
    }

    // 2. Réserver les clés. Une clé déjà à une autre fiche (message simultané de la même personne) la fait rejoindre.
    await this.claimKeys(networkId, roots[0]?.id as string, keys, at);
    const owners = await this.keyOwners(networkId, keys);
    for (const owner of owners) if (!roots.some((p) => p.id === owner.id)) roots.push(owner);
    roots = await this.distinctRoots(roots);

    // 3. Une seule fiche par personne : réunir les fiches trouvées, sauf si la direction doit d'abord attribuer.
    const { target, apart } = await this.mergeAll(roots);
    if (roots.length > 1) outcome = 'merged';
    if (apart.length > 0) outcome = 'ambiguous';

    // 4. Compléter la fiche : identifiants, prénom, source.
    await this.complete(target, identifiers, row);
    if (apart.length > 0) await this.carryExclusions(target, apart, at);

    // 5. Le message, et ce qu'il impose : arrêt sur tous les canaux [R04], refus ou vendu [R02].
    const { message, exclusion } = await this.decisions.recordReceived({
      networkId,
      agentId: target.agent_id,
      personId: target.id,
      conversationId: `${row.channel}:${row.conversation_ref ?? `${row.kind}:${row.external_id}`}`,
      channel: row.channel,
      body: row.body,
      occurredAt: new Date(row.received_at),
    });
    const exclusionReason = exclusion ? (exclusion.reason as ReceivedExclusion) : null;

    // 6. L'accord pour lui répondre, quand la personne a écrit d'elle-même et n'a pas demandé l'arrêt (S05, R03).
    if (!exclusionReason) {
      for (const channel of replyChannels(row, identifiers)) await this.addReplyConsent(target, channel, inboundId, new Date(row.received_at));
    }

    const view = await this.fiche.view(target.id);
    const silenced = view.exclusions.some((e) => activeAt(e, at.getTime()));
    await this.reception.markProcessed(inboundId, { personId: target.id, messageId: message.id });
    const reason =
      outcome === 'created'
        ? 'fiche créée'
        : outcome === 'matched'
          ? 'fiche retrouvée'
          : outcome === 'merged'
            ? 'fiches de la même personne réunies'
            : 'fiches suivies par deux agents : rattaché à la plus ancienne, la direction doit attribuer la personne';
    await this.log(networkId, inboundId, target.id, message.id, outcome, exclusionReason, silenced, reason, at);
    return {
      inboundId,
      outcome,
      personId: target.id,
      messageId: message.id,
      exclusion: exclusionReason,
      silenced,
      needsHuman: apart.length > 0,
    };
  }

  /** Fiches gardées qui portent un identifiant ou une clé du message, de la plus ancienne à la plus récente. */
  private async candidates(networkId: string, identifiers: readonly SenderIdentifier[], keys: readonly string[]): Promise<Person[]> {
    const found: Person[] = [];
    for (const id of identifiers) found.push(...(await this.fiche.findByIdentifier(networkId, id.kind, id.value)));
    found.push(...(await this.keyOwners(networkId, keys)));
    return this.distinctRoots(found);
  }

  private async keyOwners(networkId: string, keys: readonly string[]): Promise<Person[]> {
    if (keys.length === 0) return [];
    const rows = await this.db.all<{ person_id: string }>(
      `SELECT DISTINCT person_id FROM contact_keys WHERE network_id = ? AND key IN (${placeholders(keys.length)})`,
      [networkId, ...keys],
    );
    const persons = await Promise.all(rows.map((r) => this.store.getPerson(r.person_id)));
    return persons.filter((p): p is Person => p !== null);
  }

  /** Ramène chaque fiche à sa fiche gardée, sans doublon, triées de la plus ancienne à la plus récente. */
  private async distinctRoots(persons: readonly Person[]): Promise<Person[]> {
    const ids = [...new Set(await Promise.all(persons.map((p) => this.fiche.rootOf(p.id))))];
    const roots = (await Promise.all(ids.map((id) => this.store.getPerson(id)))).filter((p): p is Person => p !== null);
    return roots.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  }

  /** Une seule instruction par clé : la première fiche qui la réserve la garde. */
  private async claimKeys(networkId: string, personId: string, keys: readonly string[], at: Date): Promise<void> {
    if (keys.length === 0) return;
    await this.db.run(
      `INSERT INTO contact_keys (network_id, key, person_id, created_at)
       VALUES ${keys.map(() => '(?, ?, ?, ?)').join(', ')}
       ON CONFLICT (network_id, key) DO NOTHING`,
      keys.flatMap((key) => [networkId, key, personId, at.toISOString()]),
    );
  }

  /**
   * Réunit les fiches dans la plus ancienne (S04, réversible). Une fusion refusée parce que deux agents suivent
   * les fiches laisse la fiche à part : la direction attribuera la personne.
   */
  private async mergeAll(roots: readonly Person[]): Promise<{ target: Person; apart: Person[] }> {
    const [first, ...others] = roots;
    if (!first) throw new Error('Rattachement : aucune fiche.');
    const apart: Person[] = [];
    for (const other of others) {
      try {
        await this.fiche.merge({ survivorId: first.id, mergedId: other.id, reason: 'identifiant commun dans un message reçu' });
      } catch (error) {
        // Une autre réception vient peut-être de faire la même fusion.
        if ((await this.fiche.rootOf(other.id)) === (await this.fiche.rootOf(first.id))) continue;
        // Seul le refus « deux agents » laisse une fiche à part ; toute autre erreur rend le message pour reprise.
        if (error instanceof Error && error.message.includes('deux agents')) apart.push(other);
        else throw error;
      }
    }
    const rootId = await this.fiche.rootOf(first.id);
    const target = rootId === first.id ? first : await this.store.getPerson(rootId);
    if (!target) throw new Error(`Fiche inconnue : ${rootId}`);
    return { target, apart };
  }

  /** Ajoute les identifiants que la fiche n'a pas encore, et le prénom s'il manque. Rien n'est remplacé. */
  private async complete(target: Person, identifiers: readonly SenderIdentifier[], row: InboundRow): Promise<void> {
    const members = await this.fiche.membersOf(target.id);
    for (const id of identifiers) {
      const known = await this.db.first<{ n: number }>(
        `SELECT count(*) AS n FROM person_identifiers WHERE person_id IN (${placeholders(members.length)}) AND kind = ? AND value = ?`,
        [...members, id.kind, id.value],
      );
      if (Number(known?.n ?? 0) === 0) {
        await this.fiche.addIdentifier({ networkId: target.network_id, agentId: target.agent_id, personId: target.id, kind: id.kind, value: id.value });
      }
    }
    if (row.sender_name && target.first_name === null) {
      await this.db.run('UPDATE persons SET first_name = ?, updated_at = ? WHERE id = ? AND first_name IS NULL', [
        row.sender_name,
        this.now().toISOString(),
        target.id,
      ]);
    }
    const detail =
      [row.kind, row.portal && `portail ${row.portal}`, row.post_ref && `publication ${row.post_ref}`, row.property_ref && `bien ${row.property_ref}`]
        .filter((part): part is string => !!part)
        .join(' · ');
    const knownSource = await this.db.first<{ n: number }>(
      `SELECT count(*) AS n FROM sources WHERE person_id IN (${placeholders(members.length)}) AND channel = ? AND detail = ?`,
      [...members, row.channel, detail],
    );
    if (Number(knownSource?.n ?? 0) === 0) {
      await this.store.addSource({
        networkId: target.network_id,
        agentId: target.agent_id,
        personId: target.id,
        channel: row.channel,
        detail,
        occurredAt: new Date(row.received_at),
      });
    }
  }

  /** Fiches restées à part : leurs exclusions en cours valent aussi pour la fiche gardée, dans le doute [R02, R04]. */
  private async carryExclusions(target: Person, apart: readonly Person[], at: Date): Promise<void> {
    for (const other of apart) {
      const view = await this.fiche.view(other.id);
      for (const exclusion of view.exclusions.filter((e) => activeAt(e, at.getTime()))) {
        const mine = await this.fiche.view(target.id);
        if (mine.exclusions.some((e) => e.reason === exclusion.reason && activeAt(e, at.getTime()))) continue;
        await this.store.addExclusion({
          networkId: target.network_id,
          agentId: target.agent_id,
          personId: target.id,
          reason: exclusion.reason,
          channel: null,
          notedAt: at,
        });
      }
    }
  }

  /** L'accord pour répondre sur ce canal, avec la preuve : le message reçu. Pas de second accord s'il y en a un en cours. */
  private async addReplyConsent(target: Person, channel: Channel, inboundId: string, givenAt: Date): Promise<void> {
    const view = await this.fiche.view(target.id);
    if (view.consents.some((c) => c.channel === channel && c.purpose === REPLY_PURPOSE && c.withdrawn_at === null)) return;
    await this.store.addConsent({
      networkId: target.network_id,
      agentId: target.agent_id,
      personId: target.id,
      purpose: REPLY_PURPOSE,
      channel,
      proof: `message reçu ${inboundId}`,
      givenAt,
    });
  }

  private async log(
    networkId: string,
    inboundId: string,
    personId: string,
    messageId: string,
    outcome: AttachOutcome,
    exclusion: ReceivedExclusion | null,
    silenced: boolean,
    reason: string,
    at: Date,
  ): Promise<void> {
    await this.db.run(
      `INSERT INTO attach_log (id, network_id, inbound_id, person_id, message_id, outcome, exclusion, silenced, reason, occurred_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [this.newId(), networkId, inboundId, personId, messageId, outcome, exclusion, silenced ? 1 : 0, reason, at.toISOString(), this.now().toISOString()],
    );
  }
}
