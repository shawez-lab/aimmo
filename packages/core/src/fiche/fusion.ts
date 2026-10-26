import type { FicheClient, NewIdentifier } from '../db/fiche-client.ts';
import type { SqlDatabase, SqlValue } from '../db/sql.ts';
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
    return existing ?? this.store.addIdentifier({ ...input, value });
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
    if (survivor.agent_id && merged.agent_id && survivor.agent_id !== merged.agent_id) {
      // Lecture prudente : deux agents suivent chacun cette personne. La direction tranche avant toute fusion.
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
    await this.db.run(
      `INSERT INTO person_merges (${columns.join(', ')}) VALUES (${placeholders(columns.length)})`,
      Object.values(row),
    );
    return row as unknown as PersonMerge;
  }

  /** Défait une fusion : les deux fiches redeviennent séparées, avec chacune exactement son historique. */
  async undoMerge(mergeId: string): Promise<string> {
    const at = this.now().toISOString();
    const { changes } = await this.db.run(
      'UPDATE person_merges SET undone_at = ? WHERE id = ? AND undone_at IS NULL',
      [at, mergeId],
    );
    if (changes === 1) return at;
    const row = await this.db.first<{ undone_at: string | null }>(
      'SELECT undone_at FROM person_merges WHERE id = ?',
      [mergeId],
    );
    if (!row?.undone_at) throw new Error(`Fusion inconnue : ${mergeId}`);
    return row.undone_at;
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
