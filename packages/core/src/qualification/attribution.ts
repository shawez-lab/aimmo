/**
 * L'attribution d'un contact qualifié à l'agent de sa commune (M03, Q03), par des règles fixes écrites ici, sans IA,
 * les mêmes pour tous [R14, R25]. Elles sont rendues lisibles par `ATTRIBUTION_RULES`, pour l'application.
 *
 * Une personne exclue ou qui a demandé l'arrêt n'est jamais attribuée [R25]. Rien n'est envoyé à personne ici.
 */
import type { Viewer } from '../acces/droits.ts';
import { runBatch, type SqlDatabase, type SqlStatement } from '../db/sql.ts';
import type { FicheUnique } from '../fiche/fusion.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { DEFAULT_COMMUNES } from './regles.ts';

export type AttributionReason = 'zone' | 'already_followed' | 'no_zone' | 'reassigned';

export interface AttributionRow {
  id: string;
  network_id: string;
  person_id: string;
  qualification_id: string | null;
  agent_id: string | null;
  reason: AttributionReason;
  callback_hours: number;
  replaces_id: string | null;
  created_at: string;
}

/** Les délais de la charte de service : des réglages, pas des règles, en attendant que Shawez les fixe. */
export interface AttributionSettings {
  /** Un contact chaud est rappelé le jour même. */
  hotCallbackHours: number;
  otherCallbackHours: number;
  communes: readonly string[];
}

export const DEFAULT_ATTRIBUTION_SETTINGS: AttributionSettings = Object.freeze({
  hotCallbackHours: 8,
  otherCallbackHours: 24,
  communes: DEFAULT_COMMUNES,
});

/** Les règles, telles que l'application les publie, les mêmes pour tous. */
export const ATTRIBUTION_RULES: readonly string[] = Object.freeze([
  'Une personne exclue ou qui a demandé l’arrêt n’est jamais attribuée.',
  'Un message indésirable n’est attribué à personne ; un partenaire va à la direction.',
  'Un client déjà suivi par un agent en activité reste à cet agent, même si sa capacité est atteinte.',
  'Sinon, le contact va à un agent en activité dont la zone couvre sa commune, celle qu’il a donnée, à défaut celle du bien cité, à défaut celle d’un message d’avant, et qui ne l’a pas encore eu.',
  'Si plusieurs agents couvrent la commune, le choix se fait par un tirage fixe sur l’identifiant de la fiche : le même contact va toujours au même agent.',
  'Un agent dont la capacité déclarée est atteinte (0 : aucun nouveau contact) ne reçoit pas de nouveau contact : le tirage passe au suivant, dans l’ordre alphabétique des identifiants à partir de l’agent tiré ; si tous sont pleins, le contact va à la direction. La capacité compte les contacts attribués à l’agent qui attendent encore son rappel.',
  'Si aucun agent ne couvre la commune, le contact va à la direction, jamais au hasard.',
  'Un contact qui n’a pas été rappelé dans le délai de la charte est réattribué une fois par délai, par la même règle, à un agent qui ne l’a pas encore eu ; s’il n’y en a plus, à la direction.',
  'Un nouveau message ne repousse jamais le délai en cours : tant que personne n’a rappelé, le délai le plus court fait foi.',
  'Aucune IA ne participe à l’attribution.',
]);

const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

/**
 * Les contacts en attente de rappel chez un agent (paramètres : réseau, réseau, agent) [R681]. Chaque fiche est prise
 * entière, fiches réunies comprises, comme `current` la lit : elle compte une fois si sa dernière attribution
 * qu'aucune autre ne remplace est à l'agent, et qu'aucun agent n'a écrit à l'une de ses fiches depuis.
 */
const WAITING_SQL = `(WITH RECURSIVE up(start, id) AS (
    SELECT p.id, p.id FROM persons p WHERE p.network_id = ?
    UNION SELECT up.start, m.survivor_id FROM up JOIN person_merges m ON m.merged_id = up.id AND m.undone_at IS NULL
  ),
  fiche(person_id, root) AS (
    SELECT u.start, u.id FROM up u WHERE NOT EXISTS (SELECT 1 FROM person_merges m WHERE m.merged_id = u.id AND m.undone_at IS NULL)
  ),
  cur(root, agent_id, created_at, rid) AS (
    SELECT f.root, a.agent_id, a.created_at, a.rowid FROM attributions a JOIN fiche f ON f.person_id = a.person_id
     WHERE a.network_id = ? AND NOT EXISTS (SELECT 1 FROM attributions r WHERE r.replaces_id = a.id)
  ),
  latest(root, agent_id, created_at) AS (
    SELECT c.root, c.agent_id, c.created_at FROM cur c
     WHERE NOT EXISTS (SELECT 1 FROM cur d WHERE d.root = c.root AND (d.created_at > c.created_at OR (d.created_at = c.created_at AND d.rid > c.rid)))
  )
  SELECT count(*) FROM latest l WHERE l.agent_id = ?
    AND NOT EXISTS (
      SELECT 1 FROM messages m JOIN fiche f ON f.person_id = m.person_id
       WHERE f.root = l.root AND m.direction = 'out' AND m.author_kind = 'agent' AND m.occurred_at >= l.created_at
    ))`;

/**
 * La place chez l'agent, revérifiée par la base dans le lot qui attribue (paramètres : `roomParams`) : aucun agent
 * (la direction, ou un client déjà suivi), pas de plafond, ou moins de contacts en attente que sa capacité [R681].
 */
const ROOM_SQL = `(? IS NULL OR COALESCE((SELECT c.capacity FROM agent_capacities c WHERE c.network_id = ? AND c.agent_id = ? ORDER BY c.version DESC LIMIT 1), ${Number.MAX_SAFE_INTEGER}) > ${WAITING_SQL})`;
const roomParams = (networkId: string, agentId: string | null): (string | null)[] => [agentId, networkId, agentId, networkId, networkId, agentId];

/** FNV-1a sur 32 bits : un tirage fixe, le même à chaque fois pour la même fiche. */
function stableIndex(key: string, n: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % n;
}

/**
 * Choisit un agent parmi ceux qui couvrent la commune, par tirage fixe sur la fiche ; null : la direction. Un agent
 * plein (`full`) est passé : la file de secours suit l'ordre des identifiants à partir de l'agent tiré [R681].
 */
export function chooseAgent(
  personId: string,
  candidates: readonly string[],
  tried: ReadonlySet<string> = new Set(),
  full: ReadonlySet<string> = new Set(),
): string | null {
  const open = [...new Set(candidates)].filter((id) => !tried.has(id)).sort();
  if (open.length === 0) return null;
  const start = stableIndex(personId, open.length);
  for (let i = 0; i < open.length; i += 1) {
    const id = open[(start + i) % open.length]!;
    if (!full.has(id)) return id;
  }
  return null;
}

export const AGENT_CAPACITY_FIELDS = ['agentId', 'capacity', 'reason'] as const;
/** Le plus haut plafond qu'on peut déclarer. */
export const MAX_AGENT_CAPACITY = 200;

export interface AgentCapacity {
  agentId: string;
  /** null : sans plafond déclaré. */
  capacity: number | null;
  /** Les contacts attribués à l'agent qui attendent encore son rappel. */
  waiting: number;
  full: boolean;
  version: number;
}

export type CapacityRefusal = { ok: false; rule: 'R16'; code: 'role' } | { ok: false; rule: 'R681' | null; code: string };

export interface AttributionOptions {
  settings?: AttributionSettings;
  now?: () => Date;
  newId?: () => string;
}

export class Attribution {
  readonly settings: AttributionSettings;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly fiche: FicheUnique,
    private readonly journal: JournalStore,
    options: AttributionOptions = {},
  ) {
    this.settings = options.settings ?? DEFAULT_ATTRIBUTION_SETTINGS;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /** Donne une commune à un agent. Une commune hors de la liste est refusée. */
  async addZone(networkId: string, agentId: string, commune: string): Promise<string> {
    if (!this.settings.communes.includes(commune)) throw new Error('Commune hors de la liste.');
    const id = this.newId();
    await this.db.run('INSERT INTO agent_zones (id, network_id, agent_id, commune, created_at, ended_at) VALUES (?, ?, ?, ?, ?, NULL)', [
      id,
      networkId,
      agentId,
      commune,
      this.now().toISOString(),
    ]);
    return id;
  }

  /** Retire une commune à un agent, sans effacer la ligne [R17]. */
  async endZone(zoneId: string): Promise<void> {
    await this.db.run('UPDATE agent_zones SET ended_at = ? WHERE id = ? AND ended_at IS NULL', [this.now().toISOString(), zoneId]);
  }

  /** L'attribution en cours de la fiche : la dernière, qu'aucune autre ne remplace. */
  async current(personId: string): Promise<AttributionRow | null> {
    const view = await this.fiche.view(personId);
    const ids = view.members.map((m) => m.id);
    return this.db.first<AttributionRow>(
      `SELECT a.* FROM attributions a
       WHERE a.person_id IN (${placeholders(ids.length)}) AND NOT EXISTS (SELECT 1 FROM attributions b WHERE b.replaces_id = a.id)
       ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1`,
      ids,
    );
  }

  /** Attribue le contact d'une qualification, une seule fois [R18] ; null : rien à attribuer, ou personne exclue [R25]. */
  async attribute(qualificationId: string): Promise<AttributionRow | null> {
    const q = await this.db.first<{
      id: string;
      network_id: string;
      person_id: string;
      category: string;
      city: string | null;
      property_id: string | null;
    }>('SELECT id, network_id, person_id, category, city, property_id FROM qualifications WHERE id = ?', [qualificationId]);
    if (!q || q.category === 'spam') return null;
    const done = await this.db.first<AttributionRow>('SELECT * FROM attributions WHERE qualification_id = ?', [qualificationId]);
    if (done) return done;

    const view = await this.fiche.view(q.person_id);
    const root = view.person;
    const ids = view.members.map((m) => m.id);
    if (await this.excluded(ids)) {
      await this.log('attribution.refusee', root.id, {
        rule: 'R25',
        reason: 'Personne exclue ou qui a demandé l’arrêt : jamais attribuée.',
      });
      return null;
    }

    const hot = await this.db.first<{ temperature: string }>('SELECT temperature FROM contact_scores WHERE qualification_id = ?', [qualificationId]);
    const hours = hot?.temperature === 'hot' ? this.settings.hotCallbackHours : this.settings.otherCallbackHours;
    // Un agent rempli entre la lecture et l'écriture est pris pour plein, et le choix refait : la base revérifie la
    // capacité dans le même lot que l'attribution [R681].
    const raced = new Set<string>();
    for (;;) {
      let agentId: string | null = null;
      let fullAgents = 0;
      let reason: AttributionReason;
      // L'agent qui suit déjà le client, sur toutes les fiches réunies : la fiche gardée d'abord.
      const followed = await this.followedBy(q.network_id, [root.agent_id, ...view.members.map((m) => m.agent_id)]);
      if (followed) {
        agentId = followed;
        reason = 'already_followed';
      } else if (q.category === 'partner') {
        reason = 'no_zone';
      } else {
        // Un message sans commune garde celle d'un message d'avant, et un agent qui a déjà eu le contact sans le
        // rappeler ne le reçoit pas de nouveau parce que la personne a réécrit.
        const history = await this.history(ids);
        const tried = new Set(history.map((c) => c.agent_id).filter((id): id is string => id !== null));
        const commune = q.city ?? (await this.propertyCommune(q.property_id)) ?? (await this.lastCommune(history));
        if (commune) {
          const pick = await this.pick(q.network_id, root.id, commune, tried, raced);
          agentId = pick.agentId;
          fullAgents = pick.fullAgents;
        }
        reason = agentId ? 'zone' : 'no_zone';
      }

      // L'attribution et le passage de la fiche, tout ou rien : une coupure ne laisse jamais un agent sans accès.
      const attributionId = this.newId();
      const [inserted] = await runBatch(this.db, [
        {
          sql: `INSERT INTO attributions (id, network_id, person_id, qualification_id, agent_id, reason, callback_hours, replaces_id, created_at)
              SELECT ?, ?, ?, ?, ?, ?, ?, NULL, ? WHERE ${ROOM_SQL} ON CONFLICT (qualification_id) DO NOTHING`,
          params: [
            attributionId,
            q.network_id,
            root.id,
            qualificationId,
            agentId,
            reason,
            hours,
            this.now().toISOString(),
            ...roomParams(q.network_id, reason === 'zone' ? agentId : null),
          ],
        },
        ...this.capacityTrace(attributionId, q.network_id, fullAgents),
        ...this.takeOver(attributionId, root.id, ids, agentId, Boolean(followed)),
      ]);
      const row = await this.db.first<AttributionRow>('SELECT * FROM attributions WHERE qualification_id = ?', [qualificationId]);
      if (!row && agentId !== null && reason === 'zone') {
        raced.add(agentId);
        continue;
      }
      if (inserted?.changes === 1 && row) {
        await this.log('attribution', root.id, {
          rule: 'R25',
          reason,
          toDirection: agentId === null,
          callbackHours: hours,
          ...(fullAgents > 0 ? { fullAgents } : {}),
        });
      }
      return row;
    }
  }

  /**
   * Réattribue, par la même règle, chaque contact qui n'a pas été rappelé dans le délai de la charte : une seule fois
   * par délai, à un agent qui ne l'a pas encore eu, sinon à la direction. Rend les nouvelles attributions.
   */
  async reassignOverdue(networkId: string): Promise<AttributionRow[]> {
    const at = this.now();
    const open = await this.db.all<AttributionRow>(
      `SELECT a.* FROM attributions a
       WHERE a.network_id = ? AND a.agent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM attributions b WHERE b.replaces_id = a.id)
       ORDER BY a.created_at`,
      [networkId],
    );
    const made: AttributionRow[] = [];
    const seen = new Set<string>();
    for (const row of open) {
      // Seule une ligne déjà échue peut porter le délai le plus court : les autres n'ont rien à décider.
      if (Date.parse(row.created_at) + row.callback_hours * 3_600_000 > at.getTime()) continue;
      const view = await this.fiche.view(row.person_id);
      const root = view.person;
      const ids = view.members.map((m) => m.id);
      // L'attribution en cours de la fiche fait foi, et un message de plus ne remet pas son délai à zéro.
      const a = await this.current(root.id);
      if (!a || a.agent_id === null || seen.has(a.id)) continue;
      seen.add(a.id);
      if (await this.excluded(ids)) continue;
      const history = await this.history(ids);
      const delay = await this.openDelay(a, history, ids);
      if (delay === null || delay.deadline > at.getTime()) continue;

      const tried = new Set(history.map((c) => c.agent_id).filter((id): id is string => id !== null));
      const commune = await this.lastCommune(history);
      const raced = new Set<string>();
      let pick: { agentId: string | null; fullAgents: number } = {
        agentId: null,
        fullAgents: 0,
      };
      let id = '';
      let inserted: { changes: number } | undefined;
      for (;;) {
        pick = commune ? await this.pick(networkId, root.id, commune, tried, raced) : { agentId: null, fullAgents: 0 };
        id = this.newId();
        [inserted] = await runBatch(this.db, [
          {
            sql: `INSERT INTO attributions (id, network_id, person_id, qualification_id, agent_id, reason, callback_hours, replaces_id, created_at)
                  SELECT ?, ?, ?, NULL, ?, 'reassigned', ?, ?, ? WHERE ${ROOM_SQL} ON CONFLICT (replaces_id) DO NOTHING`,
            params: [id, networkId, root.id, pick.agentId, delay.hours, a.id, at.toISOString(), ...roomParams(networkId, pick.agentId)],
          },
          ...this.capacityTrace(id, networkId, pick.fullAgents),
          // Toutes les fiches réunies que suivait l'agent, ou un agent parti, changent de mains : jamais deux agents.
          {
            sql: `UPDATE persons SET agent_id = ?, updated_at = ? WHERE id IN (${placeholders(ids.length)})
                  AND (agent_id = ? OR agent_id IN (SELECT id FROM agents WHERE status = 'left')) AND EXISTS (SELECT 1 FROM attributions WHERE id = ?)`,
            params: [pick.agentId, at.toISOString(), ...ids, a.agent_id, id],
          },
        ]);
        if (inserted?.changes === 1 || pick.agentId === null) break;
        if (await this.db.first('SELECT 1 AS x FROM attributions WHERE replaces_id = ?', [a.id])) break;
        raced.add(pick.agentId);
      }
      const next = pick.agentId;
      if (inserted?.changes !== 1) continue;
      await this.log('attribution.reattribuee', root.id, {
        rule: 'R25',
        toDirection: next === null,
        tries: tried.size,
        ...(pick.fullAgents > 0 ? { fullAgents: pick.fullAgents } : {}),
      });
      const made1 = await this.db.first<AttributionRow>('SELECT * FROM attributions WHERE id = ?', [id]);
      if (made1) made.push(made1);
    }
    return made;
  }

  /** La capacité en cours de l'agent : la version la plus haute ; null : sans plafond déclaré. */
  private async capacityOf(networkId: string, agentId: string): Promise<{ capacity: number | null; version: number }> {
    const row = await this.db.first<{
      capacity: number | null;
      version: number;
    }>('SELECT capacity, version FROM agent_capacities WHERE network_id = ? AND agent_id = ? ORDER BY version DESC LIMIT 1', [networkId, agentId]);
    return row
      ? {
          capacity: row.capacity === null ? null : Number(row.capacity),
          version: Number(row.version),
        }
      : { capacity: null, version: 0 };
  }

  /**
   * Les contacts attribués à l'agent qui attendent encore son rappel [R681] : la même lecture que celle que la base
   * refait au moment d'attribuer (`WAITING_SQL`).
   */
  async waiting(networkId: string, agentId: string): Promise<number> {
    const row = await this.db.first<{ n: number }>(`SELECT ${WAITING_SQL} AS n`, [networkId, networkId, agentId]);
    return Number(row?.n ?? 0);
  }

  /** L'agent tiré pour la commune, agents pleins passés [R681] ; le nombre d'agents pleins qui ont changé le choix. */
  private async pick(
    networkId: string,
    personId: string,
    commune: string,
    tried: ReadonlySet<string>,
    raced: ReadonlySet<string> = new Set(),
  ): Promise<{ agentId: string | null; fullAgents: number }> {
    const candidates = (await this.agentsOf(networkId, commune)).filter((id) => !tried.has(id));
    const full = new Set<string>(raced);
    for (const id of candidates) {
      if (full.has(id)) continue;
      const { capacity } = await this.capacityOf(networkId, id);
      if (capacity !== null && (capacity === 0 || (await this.waiting(networkId, id)) >= capacity)) full.add(id);
    }
    const agentId = chooseAgent(personId, candidates, tried, full);
    const free = chooseAgent(personId, candidates, tried);
    return { agentId, fullAgents: agentId === free ? 0 : full.size };
  }

  /** La trace d'un choix changé par la capacité, rangée seulement si l'attribution l'a été dans le même lot. */
  private capacityTrace(attributionId: string, networkId: string, fullAgents: number): SqlStatement[] {
    if (fullAgents === 0) return [];
    return [
      {
        sql: `INSERT INTO attribution_capacity (attribution_id, network_id, full_agents, created_at)
              SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM attributions WHERE id = ?)`,
        params: [attributionId, networkId, fullAgents, this.now().toISOString(), attributionId],
      },
    ];
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, refusal: CapacityRefusal): Promise<CapacityRefusal> {
    const type = refusal.rule === 'R16' ? 'acces.refuse' : 'attribution.capacite.refusee';
    const data =
      refusal.rule === 'R16'
        ? {
            rule: 'R16',
            role: String(viewer.role),
            kind: 'agent_capacity',
            code: 'role',
          }
        : { rule: refusal.rule ?? 'none', code: refusal.code };
    await appendEvent(
      this.journal,
      {
        type,
        actor: this.actor(viewer),
        subject: `network:${viewer.networkId}`,
        data,
      },
      this.now,
    );
    return refusal;
  }

  /** Les capacités visibles : la direction voit chaque agent en activité, un agent la sienne seulement [R16]. */
  async capacities(viewer: Viewer): Promise<{ ok: true; value: AgentCapacity[] } | { ok: false; rule: 'R16'; code: 'role' }> {
    let agentIds: string[];
    if (viewer.role === 'direction') {
      const rows = await this.db.all<{ id: string }>("SELECT id FROM agents WHERE network_id = ? AND status = 'active' ORDER BY id", [viewer.networkId]);
      agentIds = rows.map((r) => r.id);
    } else if (viewer.role === 'agent') {
      agentIds = [viewer.userId];
    } else {
      await this.refuse(viewer, { ok: false, rule: 'R16', code: 'role' });
      return { ok: false, rule: 'R16', code: 'role' };
    }
    const value: AgentCapacity[] = [];
    for (const agentId of agentIds) {
      const { capacity, version } = await this.capacityOf(viewer.networkId, agentId);
      const waiting = await this.waiting(viewer.networkId, agentId);
      value.push({
        agentId,
        capacity,
        waiting,
        full: capacity !== null && waiting >= capacity,
        version,
      });
    }
    return { ok: true, value };
  }

  /**
   * Déclare la capacité d'un agent : l'agent pour lui-même, ou la direction pour un agent en activité du réseau, avec
   * une raison [R681, R16]. Une version s'ajoute, rien ne change [R17]. `capacity` null : sans plafond.
   */
  async declareCapacity(
    viewer: Viewer,
    input: unknown,
  ): Promise<
    | {
        ok: true;
        value: { agentId: string; capacity: number | null; version: number };
      }
    | CapacityRefusal
  > {
    if (viewer.role !== 'direction' && viewer.role !== 'agent') return this.refuse(viewer, { ok: false, rule: 'R16', code: 'role' });
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return this.refuse(viewer, { ok: false, rule: null, code: 'bad_shape' });
    const raw = input as Record<string, unknown>;
    if (Object.keys(raw).some((k) => !(AGENT_CAPACITY_FIELDS as readonly string[]).includes(k)))
      return this.refuse(viewer, {
        ok: false,
        rule: null,
        code: 'unknown_field',
      });
    const agentId = raw.agentId === undefined && viewer.role === 'agent' ? viewer.userId : raw.agentId;
    if (typeof agentId !== 'string' || agentId.length === 0) return this.refuse(viewer, { ok: false, rule: null, code: 'bad_agent' });
    if (viewer.role === 'agent' && agentId !== viewer.userId) return this.refuse(viewer, { ok: false, rule: 'R16', code: 'role' });
    const capacity = raw.capacity;
    if (capacity !== null && !(typeof capacity === 'number' && Number.isInteger(capacity) && capacity >= 0 && capacity <= MAX_AGENT_CAPACITY)) {
      return this.refuse(viewer, {
        ok: false,
        rule: 'R681',
        code: 'bad_capacity',
      });
    }
    const reason = typeof raw.reason === 'string' ? raw.reason.trim().replace(/\s+/g, ' ') : '';
    if (reason.length < 3 || reason.length > 200) return this.refuse(viewer, { ok: false, rule: null, code: 'bad_reason' });
    const agent = await this.db.first<{ id: string }>("SELECT id FROM agents WHERE id = ? AND network_id = ? AND status = 'active'", [
      agentId,
      viewer.networkId,
    ]);
    if (!agent)
      return this.refuse(viewer, {
        ok: false,
        rule: 'R681',
        code: 'agent_inconnu',
      });
    const last = await this.capacityOf(viewer.networkId, agentId);
    if (last.version > 0 && last.capacity === capacity)
      return this.refuse(viewer, {
        ok: false,
        rule: 'R681',
        code: 'inchangee',
      });
    const version = last.version + 1;
    try {
      await this.db.run('INSERT INTO agent_capacities (network_id, agent_id, version, capacity, reason, decided_by, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        viewer.networkId,
        agentId,
        version,
        capacity,
        reason,
        this.actor(viewer),
        this.now().toISOString(),
      ]);
    } catch {
      // Une autre déclaration est passée entre la lecture et l'écriture : la base refuse, rien n'est rangé.
      return this.refuse(viewer, { ok: false, rule: 'R681', code: 'conflit' });
    }
    await appendEvent(
      this.journal,
      {
        type: 'attribution.capacite',
        actor: this.actor(viewer),
        subject: `agent:${agentId}`,
        data: { version, capacity: capacity ?? 'sans_plafond' },
      },
      this.now,
    );
    return { ok: true, value: { agentId, capacity, version } };
  }

  /**
   * Ce que l'attribution change sur les fiches : un ancien agent parti, sur une fiche réunie, bloquerait l'accès du
   * nouvel agent [R16]. La fiche gardée sans agent prend l'agent, sauf s'il suit déjà l'une de ses fiches réunies.
   */
  private takeOver(attributionId: string, rootId: string, ids: readonly string[], agentId: string | null, followed: boolean): SqlStatement[] {
    if (agentId === null) return [];
    const at = this.now().toISOString();
    // Rien ne passe si l'attribution n'a pas été rangée dans le même lot (capacité atteinte entre-temps) [R681].
    const made = 'AND EXISTS (SELECT 1 FROM attributions WHERE id = ?)';
    const statements: SqlStatement[] = [
      {
        sql: `UPDATE persons SET agent_id = ?, updated_at = ? WHERE id IN (${placeholders(ids.length)}) AND agent_id IN (SELECT id FROM agents WHERE status = 'left') ${made}`,
        params: [agentId, at, ...ids, attributionId],
      },
    ];
    if (!followed)
      statements.push({
        sql: `UPDATE persons SET agent_id = ?, updated_at = ? WHERE id = ? AND agent_id IS NULL ${made}`,
        params: [agentId, at, rootId, attributionId],
      });
    return statements;
  }

  /** Toutes les attributions de la fiche, de la plus récente à la première. */
  private history(ids: readonly string[]): Promise<AttributionRow[]> {
    return this.db.all<AttributionRow>(`SELECT * FROM attributions WHERE person_id IN (${placeholders(ids.length)}) ORDER BY created_at DESC, rowid DESC`, ids);
  }

  /**
   * Le délai en cours : l'heure limite est la plus proche des délais ouverts chez cet agent depuis le dernier rappel
   * humain, et le plus court d'entre eux passe à l'agent suivant. Un message de plus ne repousse jamais ni l'une ni
   * l'autre. Null : l'agent a rappelé depuis la dernière attribution.
   */
  private async openDelay(
    current: AttributionRow,
    history: readonly AttributionRow[],
    ids: readonly string[],
  ): Promise<{ deadline: number; hours: number } | null> {
    const last = await this.db.first<{ at: string | null }>(
      `SELECT max(occurred_at) AS at FROM messages WHERE person_id IN (${placeholders(ids.length)}) AND direction = 'out' AND author_kind = 'agent'`,
      ids,
    );
    const calledAt = last?.at ? Date.parse(last.at) : null;
    let deadline = Number.POSITIVE_INFINITY;
    let hours = Number.POSITIVE_INFINITY;
    for (const row of history) {
      if (row.agent_id !== current.agent_id) break;
      const created = Date.parse(row.created_at);
      if (calledAt !== null && calledAt >= created) break;
      deadline = Math.min(deadline, created + row.callback_hours * 3_600_000);
      hours = Math.min(hours, row.callback_hours);
    }
    return Number.isFinite(deadline) ? { deadline, hours } : null;
  }

  /** La commune du contact : celle du message le plus récent qui en dit une. */
  private async lastCommune(history: readonly AttributionRow[]): Promise<string | null> {
    for (const row of history) {
      if (!row.qualification_id) continue;
      const q = await this.db.first<{
        city: string | null;
        property_id: string | null;
      }>('SELECT city, property_id FROM qualifications WHERE id = ?', [row.qualification_id]);
      const commune = q ? (q.city ?? (await this.propertyCommune(q.property_id))) : null;
      if (commune) return commune;
    }
    return null;
  }

  private async excluded(ids: readonly string[]): Promise<boolean> {
    const at = this.now().toISOString();
    const row = await this.db.first<{ n: number }>(
      `SELECT count(*) AS n FROM exclusions WHERE person_id IN (${placeholders(ids.length)}) AND noted_at <= ? AND (lifted_at IS NULL OR lifted_at > ?)`,
      [...ids, at, at],
    );
    return Number(row?.n ?? 0) > 0;
  }

  /** Le premier agent en activité de la liste, dans l'ordre donné ; null s'il n'y en a pas. */
  private async followedBy(networkId: string, agentIds: readonly (string | null)[]): Promise<string | null> {
    for (const agentId of agentIds) {
      if (!agentId) continue;
      const row = await this.db.first<{ id: string }>("SELECT id FROM agents WHERE id = ? AND network_id = ? AND status = 'active'", [agentId, networkId]);
      if (row) return row.id;
    }
    return null;
  }

  private async agentsOf(networkId: string, commune: string): Promise<string[]> {
    const rows = await this.db.all<{ agent_id: string }>(
      `SELECT DISTINCT z.agent_id FROM agent_zones z JOIN agents g ON g.id = z.agent_id AND g.network_id = z.network_id
       WHERE z.network_id = ? AND z.commune = ? AND z.ended_at IS NULL AND g.status = 'active'`,
      [networkId, commune],
    );
    return rows.map((r) => r.agent_id);
  }

  private async propertyCommune(propertyId: string | null): Promise<string | null> {
    if (!propertyId) return null;
    const row = await this.db.first<{ city: string | null }>('SELECT city FROM properties WHERE id = ?', [propertyId]);
    const city = row?.city ?? null;
    return city && this.settings.communes.includes(city) ? city : null;
  }

  private async log(type: string, personId: string, data: Record<string, string | number | boolean>): Promise<void> {
    await appendEvent(
      this.journal,
      {
        type,
        actor: 'system:attribution',
        subject: `person:${personId}`,
        data,
      },
      this.now,
    );
  }
}
