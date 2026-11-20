/**
 * Rattachement de chaque message reçu à la fiche de la personne [C02].
 * Retrouve la personne par mail, téléphone ou compte normalisés (S04), ou par son identifiant chez le canal,
 * sinon crée sa fiche. Rattache le message, la source et, quand la personne écrit d'elle-même, l'accord pour lui
 * répondre (S05). Une demande d'arrêt [R04], un refus ou « vendu » [R02] excluent dès la réception.
 * N'envoie rien : toute réponse sortira par le contrôle central (S06). Rien n'est jamais effacé [R17].
 */
import { storedForms } from '../fiche/empreinte.ts';
import type { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { Channel, Exclusion, IdentifierKind, Person } from '../db/types.ts';
import { classifyReceived, type DecisionEnvoi, type ReceivedExclusion } from '../envoi/service.ts';
import { CALL_REQUEST_DAYS, lastCallRefusal, type CallNote } from '../acces/fiche-agent.ts';
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
  /**
   * Un message pris depuis plus longtemps est tenu pour abandonné (traitement coupé net) et repris.
   * Bien plus long que tout traitement réel : un Worker est arrêté bien avant.
   */
  staleAfterMinutes?: number;
  /**
   * Appelé une fois le message rangé dans sa fiche, à chaque rattachement, reprise comprise : le bouclier contre le faux
   * RIB (N05) le lit aussitôt. Il ne doit jamais lever d'erreur ; il est idempotent.
   */
  afterAttach?: (messageId: string) => Promise<void>;
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
    this.staleAfterMinutes = options.staleAfterMinutes ?? 10;
    this.afterAttach = options.afterAttach ?? null;
  }

  private readonly afterAttach: ((messageId: string) => Promise<void>) | null;

  private readonly staleAfterMinutes: number;

  /**
   * Rend à la file les messages pris mais jamais finis (traitement coupé net, sans même passer par l'erreur).
   * Une seule instruction ; la reprise est sans doublon, car chaque étape du rattachement se reprend sans se répéter.
   */
  async reclaimStale(networkId: string): Promise<number> {
    const cutoff = new Date(this.now().getTime() - this.staleAfterMinutes * 60_000).toISOString();
    const { changes } = await this.db.run(
      `UPDATE inbound_messages SET status = 'received'
       WHERE network_id = ? AND status = 'processing'
         AND COALESCE((SELECT claimed_at FROM attach_claims c WHERE c.inbound_id = inbound_messages.id), created_at) < ?`,
      [networkId, cutoff],
    );
    return changes;
  }

  /** Reprend les messages abandonnés, puis traite tous les messages rangés et pas encore pris, les plus anciens d'abord. */
  async attachPending(networkId: string): Promise<Attached[]> {
    await this.reclaimStale(networkId);
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
      const claimedAt = this.now().toISOString();
      await this.db.run(
        `INSERT INTO attach_claims (inbound_id, claimed_at) VALUES (?, ?)
         ON CONFLICT (inbound_id) DO UPDATE SET claimed_at = excluded.claimed_at`,
        [inboundId, claimedAt],
      );
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
    // Reprise : la fiche déjà notée sur le message reçu en fait partie, et n'est jamais recréée.
    let roots = await this.candidates(networkId, identifiers, keys);
    const noted = row.person_id ? await this.store.getPerson(row.person_id) : null;
    if (noted) roots = await this.distinctRoots([...roots, noted]);
    let outcome: AttachOutcome;
    if (roots.length === 0) {
      const created = await this.store.createPerson({ networkId, firstName: row.sender_name });
      await this.db.run('UPDATE inbound_messages SET person_id = ? WHERE id = ? AND person_id IS NULL', [created.id, inboundId]);
      roots = [created];
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

    // 4. Compléter la fiche : identifiants, prénom, source. Une fiche effacée ne reprend que des empreintes (AU020c).
    const erased = await this.fiche.isErased(target.id);
    await this.complete(target, identifiers, row, erased);

    // 5. Le message, rangé une seule fois même après une reprise [R18] : son numéro est noté aussitôt sur le message reçu.
    const occurredAt = new Date(row.received_at);
    let messageId = row.message_id;
    if (messageId === null) {
      // Deux instructions sans transaction possible : seule une coupure entre les deux pourrait encore doubler le message.
      const message = await this.store.recordMessage({
        direction: 'in',
        authorKind: 'person',
        networkId,
        agentId: target.agent_id,
        personId: target.id,
        conversationId: `${row.channel}:${row.conversation_ref ?? `${row.kind}:${row.external_id}`}`,
        channel: row.channel,
        body: row.body,
        occurredAt,
      });
      messageId = message.id;
      await this.db.run('UPDATE inbound_messages SET message_id = ?, person_id = COALESCE(person_id, ?) WHERE id = ? AND message_id IS NULL', [
        messageId,
        target.id,
        inboundId,
      ]);
    }

    // Ce que le message impose, sur la fiche gardée et sur chaque fiche restée à part : arrêt sur tous les canaux [R04],
    // refus ou vendu [R02]. `recordExclusion` ne double jamais une exclusion en cours : la reprise ne répète rien.
    const exclusionReason = classifyReceived(row.body);
    if (exclusionReason) {
      for (const p of [target, ...apart]) {
        await this.decisions.recordExclusion({ networkId, agentId: p.agent_id, personId: p.id, at: occurredAt, reason: exclusionReason });
      }
    }
    // Fiches restées à part : la même personne, donc les exclusions de l'une valent pour toutes, dans le doute.
    if (apart.length > 0) await this.shareExclusions([target, ...apart], at);

    // 6. L'accord pour lui répondre, quand la personne a écrit d'elle-même et n'a pas demandé l'arrêt (S05, R03).
    if (!exclusionReason && !erased) {
      for (const channel of replyChannels(row, identifiers)) await this.addReplyConsent(target, channel, inboundId, new Date(row.received_at));
    }

    const view = await this.fiche.view(target.id);
    const silenced = view.exclusions.some((e) => activeAt(e, at.getTime()));
    await this.reception.markProcessed(inboundId, { personId: target.id, messageId });
    if (this.afterAttach) await this.afterAttach(messageId);
    const reason =
      outcome === 'created'
        ? 'fiche créée'
        : outcome === 'matched'
          ? 'fiche retrouvée'
          : outcome === 'merged'
            ? 'fiches de la même personne réunies'
            : 'fiches suivies par deux agents : rattaché à la plus ancienne, la direction doit attribuer la personne';
    await this.log(networkId, inboundId, target.id, messageId, outcome, exclusionReason, silenced, reason, at);
    return {
      inboundId,
      outcome,
      personId: target.id,
      messageId,
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
  private async complete(target: Person, identifiers: readonly SenderIdentifier[], row: InboundRow, erased: boolean): Promise<void> {
    const members = await this.fiche.membersOf(target.id);
    for (const id of identifiers) {
      // En clair ou sous empreinte : une fiche effacée qui reconnaît la personne ne reçoit pas sa valeur en clair (AU020c).
      const forms = await storedForms(target.network_id, id.kind, id.value);
      if (forms.length === 0) continue;
      const known = await this.db.first<{ n: number }>(
        `SELECT count(*) AS n FROM person_identifiers WHERE person_id IN (${placeholders(members.length)}) AND kind = ? AND value IN (?, ?)`,
        [...members, id.kind, ...forms],
      );
      if (Number(known?.n ?? 0) === 0) {
        await this.fiche.addIdentifier({ networkId: target.network_id, agentId: target.agent_id, personId: target.id, kind: id.kind, value: id.value });
      }
    }
    // Une fiche effacée ne reprend ni nom ni source : la personne a demandé l'effacement, son arrêt tient [R04, R17].
    if (erased) return;
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

  /** Chaque exclusion en cours d'une fiche du groupe est ajoutée aux autres qui ne l'ont pas encore [R02, R04]. */
  private async shareExclusions(group: readonly Person[], at: Date): Promise<void> {
    const views = await Promise.all(group.map((p) => this.fiche.view(p.id)));
    const reasons = new Set(views.flatMap((v) => v.exclusions.filter((e) => activeAt(e, at.getTime())).map((e) => e.reason)));
    for (const [index, person] of group.entries()) {
      const mine = views[index]?.exclusions.filter((e) => activeAt(e, at.getTime())) ?? [];
      for (const reason of reasons) {
        if (mine.some((e) => e.reason === reason)) continue;
        await this.store.addExclusion({ networkId: person.network_id, agentId: person.agent_id, personId: person.id, reason, channel: null, notedAt: at });
      }
    }
  }

  /** L'accord pour répondre sur ce canal, avec la preuve : le message reçu. Pas de second accord s'il y en a un en cours. */
  private async addReplyConsent(target: Person, channel: Channel, inboundId: string, givenAt: Date): Promise<void> {
    const view = await this.fiche.view(target.id);
    // Un accord périmé ne retient pas la nouvelle demande : plus ancien que 13 mois, qu'un retrait sur ce canal ou qu'une
    // levée d'exclusion, il n'ouvre plus l'appel [R03].
    // Un refus noté retire sa valeur à une demande plus ancienne : la nouvelle demande doit être rangée [R204].
    const notes = await this.db.all<CallNote>(`SELECT outcome, basis, noted_at FROM call_notes WHERE person_id IN (${view.members.map(() => '?').join(', ')})`, view.members.map((m) => m.id));
    const closedAt = Math.max(
      givenAt.getTime() - CALL_REQUEST_DAYS * 86_400_000,
      lastCallRefusal(notes, givenAt.getTime()),
      ...view.exclusions.filter((e) => e.lifted_at !== null).map((e) => Date.parse(e.lifted_at!)),
      ...view.consents.filter((c) => c.channel === channel && c.withdrawn_at !== null).map((c) => Date.parse(c.withdrawn_at!)),
    );
    if (view.consents.some((c) => c.channel === channel && c.purpose === REPLY_PURPOSE && c.withdrawn_at === null && Date.parse(c.given_at) > closedAt)) return;
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
