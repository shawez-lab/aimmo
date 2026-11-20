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
import { HASHED_PREFIX, identifierHash, isHashedIdentifier } from './empreinte.ts';
import { matchKey, normalizeIdentifier } from './normalize.ts';

/** Un identifiant au format UUID, tiré dans la base : le journal le reconnaît et ne le prend jamais pour un numéro [R13]. */
const SQL_UUID = `lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6)))`;

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
 * Rattrapage d'une fusion défaite [R02, R04, R204] : une demande qui a lu les fiches réunies juste avant le lot peut ranger
 * son arrêt ou sa note après lui, sur une seule fiche. Ce qui est rangé jusqu'à `graceMs` après la fusion défaite vaut
 * donc pour les deux, comme pendant la réunion : plus prudent. `windowMs` borne les fusions que le passage relit.
 */
export const UNDO_MERGE_CATCH_UP = Object.freeze({ graceMs: 2 * 60_000, windowMs: 10 * 60_000 });

/** Ce qu'un rattrapage a recopié : les identifiants des copies seulement [R13]. */
export interface UndoMergeCatchUp {
  merge: string;
  exclusions: string[];
  calls: string[];
}

interface SeparatedPair {
  source: string;
  target: string;
  since: string;
}

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
    const hashed = await identifierHash(input.networkId, input.kind, value);
    const existing = await this.db.first<PersonIdentifier>(
      'SELECT * FROM person_identifiers WHERE person_id = ? AND kind = ? AND value IN (?, ?) ORDER BY value LIMIT 1',
      [input.personId, input.kind, value, hashed],
    );
    if (existing) return existing;
    // Une fiche effacée ne reçoit plus rien en clair : l'identifiant nouveau n'y est rangé que sous son empreinte, pour
    // reconnaître la personne et tenir son arrêt [R04, R17] (AU020c).
    if (await this.isErased(input.personId)) {
      const row: PersonIdentifier = {
        id: this.newId(),
        network_id: input.networkId,
        agent_id: input.agentId ?? null,
        person_id: input.personId,
        kind: input.kind,
        value: hashed,
        created_at: this.now().toISOString(),
      } as PersonIdentifier;
      await this.db.run('INSERT INTO person_identifiers (id, network_id, agent_id, person_id, kind, value, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING', [
        row.id,
        row.network_id,
        row.agent_id,
        row.person_id,
        row.kind,
        row.value,
        row.created_at,
      ]);
      return (await this.db.first<PersonIdentifier>('SELECT * FROM person_identifiers WHERE person_id = ? AND kind = ? AND value = ?', [input.personId, input.kind, hashed])) ?? row;
    }
    return this.store.addIdentifier(input);
  }

  /** Vrai si la fiche, ou une fiche qui lui est réunie, a été effacée : ses identifiants ou ses clés sont sous empreinte (AU020c). */
  async isErased(personId: string): Promise<boolean> {
    const members = await this.membersOf(personId);
    const q = placeholders(members.length);
    // Les valeurs qui commencent comme une empreinte, puis le contrôle entier en code : une adresse acceptée peut aussi
    // commencer par `#sha256:` sans en être une.
    const ids = await this.db.all<{ v: string }>(`SELECT value AS v FROM person_identifiers WHERE person_id IN (${q}) AND substr(value, 1, ?) = ?`, [...members, HASHED_PREFIX.length, HASHED_PREFIX]);
    if (ids.some((r) => isHashedIdentifier(r.v))) return true;
    // Les clés de contact (migration 0007) : une fiche qui n'a écrit qu'en message privé n'est reconnue que par elles.
    let keys: { v: string }[];
    try {
      keys = await this.db.all<{ v: string }>(`SELECT key AS v FROM contact_keys WHERE person_id IN (${q}) AND substr(key, 1, ?) = ?`, [...members, HASHED_PREFIX.length, HASHED_PREFIX]);
    } catch (error) {
      if (/no such table/i.test(error instanceof Error ? error.message : String(error))) return false;
      throw error;
    }
    return keys.some((r) => isHashedIdentifier(r.v));
  }

  /** Les fiches du réseau qui portent cet identifiant, en clair ou sous empreinte, ramenées à leur fiche gardée. */
  async findByIdentifier(networkId: string, kind: IdentifierKind, raw: string): Promise<Person[]> {
    const value = normalizeIdentifier(kind, raw);
    if (value === null) return [];
    const kinds = kind === 'phone' || kind === 'whatsapp' ? ['phone', 'whatsapp'] : [kind];
    const hashed = await identifierHash(networkId, kind, value);
    const rows = await this.db.all<{ person_id: string }>(
      `SELECT DISTINCT person_id FROM person_identifiers
       WHERE network_id = ? AND kind IN (${placeholders(kinds.length)}) AND value IN (?, ?)`,
      [networkId, ...kinds, value, hashed],
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
    // Une fiche effacée ne garde que des empreintes (AU020c) : dès qu'il y en a une, chaque valeur est comparée par son
    // empreinte, pour qu'une fiche neuve de la même personne la retrouve et que son arrêt tienne [R04].
    const anyHashed = rows.some((r) => isHashedIdentifier(r.value));
    for (const row of rows) {
      const person = root(row.person_id);
      if (!parent.has(person)) parent.set(person, person);
      let key: string;
      if (isHashedIdentifier(row.value)) key = row.value;
      else {
        const normalized = normalizeIdentifier(row.kind, row.value);
        if (normalized === null) continue;
        key = anyHashed ? await identifierHash(networkId, row.kind, normalized) : matchKey(row.kind, normalized);
      }
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
   * l'a donné. Une exclusion ou un arrêt noté alors que deux fiches étaient réunies est recopié de l'une à l'autre
   * [R02, R04] : pour la même raison, il vaut pour les deux, avec sa date et sa levée s'il en a une, pour qu'un accord plus
   * ancien ne compte pas de nouveau. Une exclusion d'avant leur réunion ne bouge pas. Une note d'appel rangée pendant la
   * réunion est recopiée de même [R204], avec son heure, son résultat et sa base : le refus et le plafond valent des deux
   * côtés, et rien n'est effacé [R17]. Fusion, accords, exclusions et notes changent dans un seul lot.
   * Rappeler une fusion déjà défaite écrit la ligne du journal si une coupure l'avait empêchée, sans rien changer de plus.
   */
  async undoMerge(mergeId: string, trace: UndoMergeTrace): Promise<string> {
    const merge = await this.db.first<PersonMerge>('SELECT * FROM person_merges WHERE id = ?', [mergeId]);
    if (!merge) throw new Error(`Fusion inconnue : ${mergeId}`);
    let undoneAt = merge.undone_at;
    if (undoneAt === null) {
      const at = this.now().toISOString();
      const ids = await this.membersOf(merge.survivor_id);
      const pairs = await this.separatedPairs(merge, at);
      const [undo] = await runBatch(this.db, [
        { sql: 'UPDATE person_merges SET undone_at = ? WHERE id = ? AND undone_at IS NULL', params: [at, mergeId] },
        {
          // Fermés seulement si cette fusion est bien défaite par ce lot : le premier geste compte, comme pour la fusion.
          sql: `UPDATE consents SET withdrawn_at = ?
                WHERE person_id IN (${placeholders(ids.length)}) AND created_at >= ? AND withdrawn_at IS NULL
                  AND EXISTS (SELECT 1 FROM person_merges WHERE id = ? AND undone_at = ?)`,
          params: [at, ...ids, merge.merged_at, mergeId, at],
        },
        // En SQL : un arrêt rangé pendant ce geste n'échappe pas à la copie. Les colonnes de la ligne servent de clé :
        // l'original et ses copies ne font qu'un, et rien n'est doublé. La copie garde la date de création de l'original,
        // pour qu'une fusion défaite plus tard la lise comme lui.
        ...copyStatements(pairs, mergeId, at, null),
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
        'SELECT id FROM exclusions WHERE undone_merge_id = ? ORDER BY id',
        [mergeId],
      );
      const calls = await this.db.all<{ id: string }>('SELECT id FROM call_notes WHERE undone_merge_id = ? ORDER BY id', [mergeId]);
      await appendEvent(
        trace.journal,
        {
          type: 'fiche.fusion_defaite',
          actor: trace.actor,
          subject,
          data: { rule: 'R03', merge: mergeId, consents: closed.map((c) => c.id), exclusions: copied.map((c) => c.id), calls: calls.map((c) => c.id) },
        },
        this.now,
      );
    }
    return undoneAt;
  }

  /**
   * Rattrape une fusion défaite [R02, R04, R204] : une exclusion ou une note d'appel rangée sur l'une des fiches séparées,
   * depuis leur réunion et jusqu'à `UNDO_MERGE_CATCH_UP.graceMs` après la fusion défaite, est recopiée sur l'autre, avec sa
   * date, sa levée, son heure et sa base, comme par `undoMerge`. C'est la demande qui avait lu les fiches réunies juste
   * avant le lot et rangé après lui. Rien n'est doublé ni effacé [R17] ; une fusion pas défaite ne change rien. Les
   * copies faites vont au journal, par leurs identifiants seulement [R13].
   */
  async catchUpUndoneMerge(mergeId: string, trace: UndoMergeTrace): Promise<UndoMergeCatchUp> {
    const merge = await this.db.first<PersonMerge>('SELECT * FROM person_merges WHERE id = ?', [mergeId]);
    if (!merge) throw new Error(`Fusion inconnue : ${mergeId}`);
    const done: UndoMergeCatchUp = { merge: mergeId, exclusions: [], calls: [] };
    const undoneAt = merge.undone_at;
    if (undoneAt === null) return done;
    const until = new Date(Date.parse(undoneAt) + UNDO_MERGE_CATCH_UP.graceMs).toISOString();
    const pairs = await this.separatedPairs(merge, undoneAt);
    if (pairs.length === 0) return done;
    await runBatch(this.db, copyStatements(pairs, mergeId, undoneAt, until));
    // Toute copie de cette fusion pas encore au journal y va : celles de ce passage, et celles d'un passage coupé avant
    // sa ligne. Les copies du lot sont déjà dites par `fiche.fusion_defaite`.
    const said = new Set<string>();
    for (const e of await trace.journal.bySubject(`person:${merge.survivor_id}`)) {
      if ((e.type !== 'fiche.fusion_defaite' && e.type !== 'fiche.fusion_defaite_rattrapee') || e.data.merge !== mergeId) continue;
      for (const key of ['exclusions', 'calls'] as const) {
        const ids = e.data[key];
        if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') said.add(id);
      }
    }
    const unsaid = async (table: 'exclusions' | 'call_notes') =>
      (await this.db.all<{ id: string }>(`SELECT id FROM ${table} WHERE undone_merge_id = ? ORDER BY id`, [mergeId])).map((r) => r.id).filter((id) => !said.has(id));
    done.exclusions = await unsaid('exclusions');
    done.calls = await unsaid('call_notes');
    if (done.exclusions.length > 0 || done.calls.length > 0) {
      await appendEvent(
        trace.journal,
        {
          type: 'fiche.fusion_defaite_rattrapee',
          actor: trace.actor,
          subject: `person:${merge.survivor_id}`,
          data: { rule: 'R04', merge: mergeId, exclusions: done.exclusions, calls: done.calls },
        },
        this.now,
      );
    }
    return done;
  }

  /**
   * Rattrape chaque fusion défaite depuis `UNDO_MERGE_CATCH_UP.windowMs` : à appeler par un passage régulier, après
   * tout geste qui défait une fusion. Rend seulement les fusions où quelque chose a été recopié.
   */
  async catchUpUndoneMerges(trace: UndoMergeTrace): Promise<UndoMergeCatchUp[]> {
    const since = new Date(this.now().getTime() - UNDO_MERGE_CATCH_UP.windowMs).toISOString();
    const rows = await this.db.all<{ id: string }>(
      'SELECT id FROM person_merges WHERE undone_at IS NOT NULL AND undone_at >= ? ORDER BY undone_at, id',
      [since],
    );
    const caught: UndoMergeCatchUp[] = [];
    for (const { id } of rows) {
      const done = await this.catchUpUndoneMerge(id, trace);
      if (done.exclusions.length > 0 || done.calls.length > 0) caught.push(done);
    }
    return caught;
  }

  /**
   * Les couples de fiches que la fusion défaite sépare, chacun avec la date où ils ont été réunis : la plus récente des
   * fusions qui les relient. Une exclusion ou une note plus ancienne que cette date n'a jamais valu pour l'autre fiche et ne la suit pas.
   * Les fusions sont lues telles qu'elles étaient à `asOf`, l'instant où la fusion est défaite : celles déjà faites et pas
   * encore défaites, elle comprise. Le rattrapage retrouve ainsi les mêmes couples que le lot.
   */
  private async separatedPairs(merge: PersonMerge, asOf: string): Promise<SeparatedPair[]> {
    const edges = await this.db.all<{ survivor_id: string; merged_id: string; merged_at: string }>(
      `SELECT survivor_id, merged_id, merged_at FROM person_merges
       WHERE network_id = ? AND merged_at <= ? AND (undone_at IS NULL OR undone_at >= ?) ORDER BY merged_at, id`,
      [merge.network_id, asOf, asOf],
    );
    const parent = new Map(edges.map((e) => [e.merged_id, e]));
    // Les fiches réunies à cet instant : la fiche gardée au bout des fusions, puis tout ce qui y est fusionné.
    let root = merge.survivor_id;
    const up = new Set([root]);
    for (let edge = parent.get(root); edge && !up.has(edge.survivor_id); edge = parent.get(edge.survivor_id)) {
      root = edge.survivor_id;
      up.add(root);
    }
    const ids = [root];
    for (let i = 0; i < ids.length; i++) {
      for (const edge of edges) if (edge.survivor_id === ids[i] && !ids.includes(edge.merged_id)) ids.push(edge.merged_id);
    }
    // Du haut de la fiche vers elle-même : chaque ancêtre, avec la date la plus récente du chemin jusqu'à la fiche.
    const climb = (id: string): Map<string, string> => {
      const seen = new Map([[id, '']]);
      let latest = '';
      for (let edge = parent.get(id); edge && !seen.has(edge.survivor_id); edge = parent.get(edge.survivor_id)) {
        if (edge.merged_at > latest) latest = edge.merged_at;
        seen.set(edge.survivor_id, latest);
      }
      return seen;
    };
    const paths = new Map(ids.map((id) => [id, climb(id)]));
    const cut = ids.filter((id) => paths.get(id)?.has(merge.merged_id));
    const kept = ids.filter((id) => !cut.includes(id));
    const pairs: { source: string; target: string; since: string }[] = [];
    for (const a of kept) {
      for (const b of cut) {
        const up = paths.get(a) as Map<string, string>;
        // Le premier ancêtre commun en montant depuis la fiche séparée : c'est là que les deux chemins se rejoignent.
        const meet = [...(paths.get(b) as Map<string, string>).entries()].find(([id]) => up.has(id));
        if (!meet) continue;
        const left = up.get(meet[0]) as string;
        const since = left > meet[1] ? left : meet[1];
        pairs.push({ source: a, target: b, since }, { source: b, target: a, since });
      }
    }
    return pairs;
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

/**
 * Les copies d'exclusions et de notes d'appel d'une fiche séparée vers l'autre, faites seulement si la fusion est bien
 * défaite à `undoneAt`. `until` borne la date de ce qui est recopié (le rattrapage) ; `null` : tout depuis la réunion.
 * Au rattrapage, une exclusion déjà présente de l'autre côté, levée ou non, n'est jamais recopiée : une levée faite
 * après la fusion défaite sur l'une des fiches n'est pas défaite par la copie encore ouverte de l'autre.
 */
function copyStatements(pairs: SeparatedPair[], mergeId: string, undoneAt: string, until: string | null): { sql: string; params: SqlValue[] }[] {
  const bound = (column: string): string => (until === null ? '' : ` AND ${column} <= ?`);
  const upTo: SqlValue[] = until === null ? [] : [until];
  return [
    ...pairs.map(({ source, target, since }) => ({
      sql: `INSERT INTO exclusions (id, network_id, agent_id, person_id, reason, channel, noted_at, lifted_at, created_at, undone_merge_id)
            SELECT ${SQL_UUID}, e.network_id, MIN(e.agent_id), ?, e.reason, e.channel, e.noted_at, e.lifted_at, MIN(e.created_at), ?
            FROM exclusions e
            WHERE e.person_id = ? AND e.created_at >= ?${bound('e.created_at')}
              AND NOT EXISTS (SELECT 1 FROM exclusions t WHERE t.person_id = ? AND t.reason = e.reason AND t.channel IS e.channel
                                AND t.noted_at = e.noted_at${until === null ? ' AND t.lifted_at IS e.lifted_at' : ''})
              AND EXISTS (SELECT 1 FROM person_merges WHERE id = ? AND undone_at = ?)
            GROUP BY e.network_id, e.reason, e.channel, e.noted_at, e.lifted_at`,
      params: [target, mergeId, source, since, ...upTo, target, mergeId, undoneAt],
    })),
    // De même pour les notes d'appel : l'original et ses copies ne font qu'un, et se relisent comme un seul appel.
    ...pairs.map(({ source, target, since }) => ({
      sql: `INSERT INTO call_notes (id, network_id, person_id, outcome, basis, noted_by, noted_at, undone_merge_id)
            SELECT ${SQL_UUID}, n.network_id, ?, n.outcome, n.basis, MIN(n.noted_by), n.noted_at, ?
            FROM call_notes n
            WHERE n.person_id = ? AND n.noted_at >= ?${bound('n.noted_at')}
              AND NOT EXISTS (SELECT 1 FROM call_notes t WHERE t.person_id = ? AND t.outcome = n.outcome AND t.basis = n.basis AND t.noted_at = n.noted_at)
              AND EXISTS (SELECT 1 FROM person_merges WHERE id = ? AND undone_at = ?)
            GROUP BY n.network_id, n.outcome, n.basis, n.noted_at`,
      params: [target, mergeId, source, since, ...upTo, target, mergeId, undoneAt],
    })),
  ];
}
