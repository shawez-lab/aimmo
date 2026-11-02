import type { FicheClient, NewIdentifier } from '../db/fiche-client.ts';
import { runBatch, type SqlDatabase, type SqlValue } from '../db/sql.ts';
import type {
  Consent,
  Exclusion,
  IdentifierKind,
  Message,
  Person,
  PersonIdentifier,
  PersonMerge,
  Project,
  Source,
} from '../db/types.ts';
import { consentInForce } from '../envoi/decision.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { matchKey, normalizeIdentifier } from './normalize.ts';

export interface FicheComplete {
  /** La fiche gardée. */
  person: Person;
  /** La fiche gardée, puis les fiches qui y sont fusionnées. */
  members: Person[];
  identifiers: PersonIdentifier[];
  consents: Consent[];
  exclusions: Exclusion[];
  projects: Project[];
  sources: Source[];
  messages: Message[];
  merges: PersonMerge[];
}

export interface MergeRequest {
  survivorId: string;
  mergedId: string;
  /** Pourquoi : identifiant commun, décision de l'agent… */
  reason: string;
  agentId?: string | null;
}

/** Où et au nom de qui défaire une fusion : le geste ferme des accords, il va au journal. */
export interface UndoMergeTrace {
  journal: JournalStore;
  actor: string;
}

export interface FicheUniqueOptions {
  now?: () => Date;
  newId?: () => string;
}

const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

/**
 * Une seule fiche par personne : identifiants normalisés, doublons repérés, fusion réversible.
 * Une fusion ne déplace ni n'efface aucune ligne [R17] : elle relie deux fiches, et la défaire les sépare
 * exactement comme avant.
 */
export class FicheUnique {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly store: FicheClient,
    options: FicheUniqueOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /** Ajoute un identifiant tel que saisi : il est normalisé, refusé s'il n'est pas valable, ignoré s'il existe déjà. */
  async addIdentifier(input: NewIdentifier): Promise<PersonIdentifier> {
    const value = normalizeIdentifier(input.kind, input.value);
    if (value === null) throw new Error(`Identifiant non valable (${input.kind}).`);
    const existing = await this.db.first<PersonIdentifier>(
      'SELECT * FROM person_identifiers WHERE person_id = ? AND kind = ? AND value = ?',
      [input.personId, input.kind, value],
    );
    return existing ?? this.store.addIdentifier(input);
  }

  /** Les fiches du réseau qui portent cet identifiant, ramenées à leur fiche gardée. */
  async findByIdentifier(networkId: string, kind: IdentifierKind, raw: string): Promise<Person[]> {
    const value = normalizeIdentifier(kind, raw);
    if (value === null) return [];
    const kinds = kind === 'phone' || kind === 'whatsapp' ? ['phone', 'whatsapp'] : [kind];
    const rows = await this.db.all<{ person_id: string }>(
      `SELECT DISTINCT person_id FROM person_identifiers
       WHERE network_id = ? AND kind IN (${placeholders(kinds.length)}) AND value = ?`,
      [networkId, ...kinds, value],
    );
    const roots = [...new Set(await Promise.all(rows.map((r) => this.rootOf(r.person_id))))].sort();
    const persons = await Promise.all(roots.map((id) => this.store.getPerson(id)));
    return persons.filter((p): p is Person => p !== null);
  }

  /** La fiche gardée au bout des fusions actives. */
  async rootOf(personId: string): Promise<string> {
    let current = personId;
    const seen = new Set<string>();
    for (;;) {
      if (seen.has(current)) throw new Error('Boucle de fusions : à corriger à la main.');
      seen.add(current);
      const merge = await this.db.first<{ survivor_id: string }>(
        'SELECT survivor_id FROM person_merges WHERE merged_id = ? AND undone_at IS NULL',
        [current],
      );
      if (!merge) return current;
      current = merge.survivor_id;
    }
  }

  /** La fiche gardée, puis toutes les fiches qui y sont fusionnées, directement ou non. */
  async membersOf(personId: string): Promise<string[]> {
    const root = await this.rootOf(personId);
    const members = [root];
    for (let i = 0; i < members.length; i++) {
      const children = await this.db.all<{ merged_id: string }>(
        'SELECT merged_id FROM person_merges WHERE survivor_id = ? AND undone_at IS NULL ORDER BY merged_at, id',
        [members[i] as string],
      );
      for (const child of children) if (!members.includes(child.merged_id)) members.push(child.merged_id);
    }
    return members;
  }

  /**
   * Groupes de fiches qui partagent au moins un identifiant normalisé, de proche en proche.
   * Chaque groupe liste des fiches gardées distinctes, triées ; les groupes sont triés par leur première fiche.
   * Les noms ne servent jamais à rapprocher : deux homonymes restent deux personnes.
   */
  async findDuplicateGroups(networkId: string): Promise<string[][]> {
    const rows = await this.db.all<{ person_id: string; kind: IdentifierKind; value: string }>(
      'SELECT person_id, kind, value FROM person_identifiers WHERE network_id = ?',
      [networkId],
    );
    const merges = await this.db.all<{ survivor_id: string; merged_id: string }>(
      'SELECT survivor_id, merged_id FROM person_merges WHERE network_id = ? AND undone_at IS NULL',
      [networkId],
    );
    const survivorOf = new Map(merges.map((m) => [m.merged_id, m.survivor_id]));
    const root = (id: string): string => {
      let current = id;
      const seen = new Set<string>();
      while (survivorOf.has(current) && !seen.has(current)) {
        seen.add(current);
        current = survivorOf.get(current) as string;
      }
      return current;
    };

    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r) as string;
      parent.set(x, r);
      return r;
    };
    const union = (a: string, b: string): void => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
    };

    const byKey = new Map<string, string>();
    for (const row of rows) {
      const person = root(row.person_id);
      if (!parent.has(person)) parent.set(person, person);
      const normalized = normalizeIdentifier(row.kind, row.value);
      if (normalized === null) continue;
      const key = matchKey(row.kind, normalized);
      const other = byKey.get(key);
      if (other === undefined) byKey.set(key, person);
      else union(other, person);
    }

    const groups = new Map<string, string[]>();
    for (const person of parent.keys()) {
      const r = find(person);
      groups.set(r, [...(groups.get(r) ?? []), person]);
    }
    return [...groups.values()]
      .filter((g) => g.length > 1)
      .map((g) => g.sort())
      .sort((a, b) => (a[0] as string).localeCompare(b[0] as string));
  }

  /** Fusionne la fiche `mergedId` (et celles qui y sont déjà fusionnées) dans `survivorId`. */
  async merge(request: MergeRequest): Promise<PersonMerge> {
    if (request.reason.trim() === '') throw new Error('Une fusion doit dire pourquoi.');
    const survivorId = await this.rootOf(request.survivorId);
    const mergedId = await this.rootOf(request.mergedId);
    if (survivorId === mergedId) throw new Error('Ces deux fiches sont déjà réunies.');
    const [survivor, merged] = await Promise.all([
      this.store.getPerson(survivorId),
      this.store.getPerson(mergedId),
    ]);
    if (!survivor || !merged) throw new Error('Fiche inconnue.');
    if (survivor.network_id !== merged.network_id) throw new Error('Deux fiches de réseaux différents ne se fusionnent pas.');
    // Lecture prudente : si plusieurs agents suivent les fiches à réunir, la direction attribue d'abord la personne.
    const memberIds = [...(await this.membersOf(survivorId)), ...(await this.membersOf(mergedId))];
    // Repère pour l'écriture : les lignes ne sont jamais effacées, donc ce nombre ne fait que croître
    // si une autre fusion rattache une fiche à l'un des deux côtés pendant ce contrôle.
    const attachedSql = `SELECT count(*) FROM person_merges WHERE survivor_id IN (${placeholders(memberIds.length)})`;
    const attached = Number(
      (await this.db.first<{ n: number }>(attachedSql.replace('count(*)', 'count(*) AS n'), memberIds))?.n ?? 0,
    );
    const members = await Promise.all(memberIds.map((id) => this.store.getPerson(id)));
    const agents = new Set(members.map((p) => p?.agent_id).filter((a): a is string => !!a));
    if (agents.size > 1) {
      throw new Error('Ces fiches sont suivies par deux agents différents : la direction doit d’abord attribuer la personne.');
    }
    const at = this.now().toISOString();
    const row: Record<string, SqlValue> = {
      id: this.newId(),
      network_id: survivor.network_id,
      agent_id: request.agentId ?? null,
      survivor_id: survivorId,
      merged_id: mergedId,
      reason: request.reason,
      merged_at: at,
      undone_at: null,
      created_at: at,
    };
    const columns = Object.keys(row);
    // Une seule instruction : si l'une des deux fiches vient d'être fusionnée ailleurs, ou si une autre fiche
    // vient d'être rattachée à l'un des deux côtés depuis le contrôle des agents, rien n'est écrit.
    const { changes } = await this.db.run(
      `INSERT INTO person_merges (${columns.join(', ')})
       SELECT ${placeholders(columns.length)}
       WHERE NOT EXISTS (SELECT 1 FROM person_merges WHERE undone_at IS NULL AND merged_id IN (?, ?))
         AND (${attachedSql}) = ?`,
      [...Object.values(row), survivorId, mergedId, ...memberIds, attached],
    );
    if (changes !== 1) throw new Error('Une autre fusion vient de toucher ces fiches : recommencer.');
    return row as unknown as PersonMerge;
  }

  /**
   * Défait une fusion : les deux fiches redeviennent séparées, avec chacune son historique.
   * Un accord créé pendant la fusion est fermé, jamais effacé [R03, R17] : on ne sait plus laquelle des deux personnes
   * l'a donné. Une exclusion ou un arrêt noté pendant la fusion est recopié sur chaque fiche [R02, R04] : pour la même
   * raison, il vaut pour toutes, avec sa date et sa levée s'il en a une, pour qu'un accord plus ancien ne compte pas de
   * nouveau. Une exclusion d'avant la fusion ne bouge pas. Fusion, accords et exclusions changent dans un seul lot.
   * Rappeler une fusion déjà défaite écrit la ligne du journal si une coupure l'avait empêchée, sans rien changer de plus.
   */
  async undoMerge(mergeId: string, trace: UndoMergeTrace): Promise<string> {
    const merge = await this.db.first<PersonMerge>('SELECT * FROM person_merges WHERE id = ?', [mergeId]);
    if (!merge) throw new Error(`Fusion inconnue : ${mergeId}`);
    let undoneAt = merge.undone_at;
    if (undoneAt === null) {
      const at = this.now().toISOString();
      const ids = await this.membersOf(merge.survivor_id);
      const [undo] = await runBatch(this.db, [
        { sql: 'UPDATE person_merges SET undone_at = ? WHERE id = ? AND undone_at IS NULL', params: [at, mergeId] },
        {
          // Fermés seulement si cette fusion est bien défaite par ce lot : le premier geste compte, comme pour la fusion.
          sql: `UPDATE consents SET withdrawn_at = ?
                WHERE person_id IN (${placeholders(ids.length)}) AND created_at >= ? AND withdrawn_at IS NULL
                  AND EXISTS (SELECT 1 FROM person_merges WHERE id = ? AND undone_at = ?)`,
          params: [at, ...ids, merge.merged_at, mergeId, at],
        },
        // Une instruction par fiche, en SQL : un arrêt rangé pendant ce geste n'échappe pas à la copie. Les colonnes de la
        // ligne servent de clé : l'original et ses copies ne font qu'un, et rien n'est doublé.
        ...ids.map((target) => ({
          sql: `INSERT INTO exclusions (id, network_id, agent_id, person_id, reason, channel, noted_at, lifted_at, created_at)
                SELECT lower(hex(randomblob(16))), e.network_id, MIN(e.agent_id), ?, e.reason, e.channel, e.noted_at, e.lifted_at, ?
                FROM exclusions e
                WHERE e.person_id IN (${placeholders(ids.length)}) AND e.person_id <> ? AND e.created_at >= ?
                  AND NOT EXISTS (SELECT 1 FROM exclusions t WHERE t.person_id = ? AND t.reason = e.reason AND t.channel IS e.channel
                                    AND t.noted_at = e.noted_at AND t.lifted_at IS e.lifted_at)
                  AND EXISTS (SELECT 1 FROM person_merges WHERE id = ? AND undone_at = ?)
                GROUP BY e.network_id, e.reason, e.channel, e.noted_at, e.lifted_at`,
          params: [target, at, ...ids, target, merge.merged_at, target, mergeId, at],
        })),
      ]);
      if (undo?.changes === 1) undoneAt = at;
      else {
        const row = await this.db.first<{ undone_at: string | null }>('SELECT undone_at FROM person_merges WHERE id = ?', [mergeId]);
        undoneAt = row?.undone_at ?? null;
        if (undoneAt === null) throw new Error(`Fusion inconnue : ${mergeId}`);
      }
    }
    const subject = `person:${merge.survivor_id}`;
    const logged = await trace.journal.bySubject(subject);
    if (!logged.some((e) => e.type === 'fiche.fusion_defaite' && e.data.merge === mergeId)) {
      const ids = [...new Set([...(await this.membersOf(merge.survivor_id)), ...(await this.membersOf(merge.merged_id))])];
      const closed = await this.db.all<{ id: string }>(
        `SELECT id FROM consents WHERE person_id IN (${placeholders(ids.length)}) AND created_at >= ? AND withdrawn_at = ? ORDER BY id`,
        [...ids, merge.merged_at, undoneAt],
      );
      const copied = await this.db.all<{ id: string }>(
        `SELECT id FROM exclusions WHERE person_id IN (${placeholders(ids.length)}) AND created_at = ? ORDER BY id`,
        [...ids, undoneAt],
      );
      await appendEvent(
        trace.journal,
        {
          type: 'fiche.fusion_defaite',
          actor: trace.actor,
          subject,
          data: { rule: 'R03', merge: mergeId, consents: closed.map((c) => c.id), exclusions: copied.map((c) => c.id) },
        },
        this.now,
      );
    }
    return undoneAt;
  }

  /**
   * Vrai si un accord compte encore pour cette finalité et ce canal, fiches réunies comprises, comme pour le contrôle
   * central [R03] : un module n'en range pas de nouveau seulement dans ce cas. Une ligne ouverte mais plus ancienne qu'un
   * retrait ou qu'une levée ne suffit pas : la nouvelle demande de la personne se perdrait en silence. Tout ce que la
   * fiche sait à ce jour compte, quelle que soit la date du retrait.
   */
  async hasConsentInForce(personId: string, purpose: string, channel: string): Promise<boolean> {
    return (await this.channelsInForce(personId, purpose)).includes(channel);
  }

  /** Les canaux où un accord compte encore pour cette finalité : une seule lecture, pour un passage sur beaucoup de fiches. */
  async channelsInForce(personId: string, purpose: string): Promise<string[]> {
    const ids = await this.membersOf(personId);
    const of = <T>(table: string): Promise<T[]> => this.db.all<T>(`SELECT * FROM ${table} WHERE person_id IN (${placeholders(ids.length)})`, ids);
    const [consents, exclusions] = await Promise.all([of<Consent>('consents'), of<Exclusion>('exclusions')]);
    return [...new Set(consents.filter((c) => c.purpose === purpose && consentInForce(c, { consents, exclusions }, Infinity)).map((c) => c.channel))];
  }

  /** Toute la fiche de la personne : ses lignes et celles de chaque fiche qui y est fusionnée. */
  async view(personId: string): Promise<FicheComplete> {
    const ids = await this.membersOf(personId);
    const people = await Promise.all(ids.map((id) => this.store.getPerson(id)));
    const members = people.filter((p): p is Person => p !== null);
    const person = members[0];
    if (!person || person.id !== ids[0]) throw new Error(`Fiche inconnue : ${personId}`);
    const of = <T>(table: string, order: string): Promise<T[]> =>
      this.db.all<T>(
        `SELECT * FROM ${table} WHERE person_id IN (${placeholders(ids.length)}) ORDER BY ${order}, id`,
        ids,
      );
    const [identifiers, consents, exclusions, projects, sources, messages] = await Promise.all([
      of<PersonIdentifier>('person_identifiers', 'created_at'),
      of<Consent>('consents', 'given_at'),
      of<Exclusion>('exclusions', 'noted_at'),
      of<Project>('projects', 'created_at'),
      of<Source>('sources', 'occurred_at'),
      of<Message>('messages', 'occurred_at'),
    ]);
    const merges = await this.db.all<PersonMerge>(
      `SELECT * FROM person_merges
       WHERE survivor_id IN (${placeholders(ids.length)}) OR merged_id IN (${placeholders(ids.length)})
       ORDER BY merged_at, id`,
      [...ids, ...ids],
    );
    return { person, members, identifiers, consents, exclusions, projects, sources, messages, merges };
  }
}
