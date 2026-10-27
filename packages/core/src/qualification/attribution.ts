/**
 * L'attribution d'un contact qualifié à l'agent de sa commune (M03, Q03), par des règles fixes écrites ici, sans IA,
 * les mêmes pour tous [R14, R25]. Elles sont rendues lisibles par `ATTRIBUTION_RULES`, pour l'application.
 *
 * Une personne exclue ou qui a demandé l'arrêt n'est jamais attribuée [R25]. Rien n'est envoyé à personne ici.
 */
import type { SqlDatabase } from '../db/sql.ts';
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
  'Un client déjà suivi par un agent en activité reste à cet agent.',
  'Sinon, le contact va à un agent en activité dont la zone couvre sa commune, celle qu’il a donnée ou, à défaut, celle du bien cité.',
  'Si plusieurs agents couvrent la commune, le choix se fait par un tirage fixe sur l’identifiant de la fiche : le même contact va toujours au même agent.',
  'Si aucun agent ne couvre la commune, le contact va à la direction, jamais au hasard.',
  'Un contact qui n’a pas été rappelé dans le délai de la charte est réattribué une fois par délai, par la même règle, à un agent qui ne l’a pas encore eu ; s’il n’y en a plus, à la direction.',
  'Aucune IA ne participe à l’attribution.',
]);

const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

/** FNV-1a sur 32 bits : un tirage fixe, le même à chaque fois pour la même fiche. */
function stableIndex(key: string, n: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % n;
}

/** Choisit un agent parmi ceux qui couvrent la commune, par tirage fixe sur la fiche ; null : la direction. */
export function chooseAgent(personId: string, candidates: readonly string[], tried: ReadonlySet<string> = new Set()): string | null {
  const open = [...new Set(candidates)].filter((id) => !tried.has(id)).sort();
  return open.length === 0 ? null : open[stableIndex(personId, open.length)]!;
}

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
    const q = await this.db.first<{ id: string; network_id: string; person_id: string; category: string; city: string | null; property_id: string | null }>(
      'SELECT id, network_id, person_id, category, city, property_id FROM qualifications WHERE id = ?',
      [qualificationId],
    );
    if (!q || q.category === 'spam') return null;
    const done = await this.db.first<AttributionRow>('SELECT * FROM attributions WHERE qualification_id = ?', [qualificationId]);
    if (done) return done;

    const view = await this.fiche.view(q.person_id);
    const root = view.person;
    const ids = view.members.map((m) => m.id);
    if (await this.excluded(ids)) {
      await this.log('attribution.refusee', root.id, { rule: 'R25', reason: 'Personne exclue ou qui a demandé l’arrêt : jamais attribuée.' });
      return null;
    }

    let agentId: string | null = null;
    let reason: AttributionReason;
    const followed = root.agent_id ? await this.activeAgent(q.network_id, root.agent_id) : null;
    if (followed) {
      agentId = followed;
      reason = 'already_followed';
    } else if (q.category === 'partner') {
      reason = 'no_zone';
    } else {
      const commune = q.city ?? (await this.propertyCommune(q.property_id));
      agentId = commune ? chooseAgent(root.id, await this.agentsOf(q.network_id, commune)) : null;
      reason = agentId ? 'zone' : 'no_zone';
    }

    const hot = await this.db.first<{ temperature: string }>('SELECT temperature FROM contact_scores WHERE qualification_id = ?', [qualificationId]);
    const hours = hot?.temperature === 'hot' ? this.settings.hotCallbackHours : this.settings.otherCallbackHours;
    const { changes } = await this.db.run(
      `INSERT INTO attributions (id, network_id, person_id, qualification_id, agent_id, reason, callback_hours, replaces_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?) ON CONFLICT (qualification_id) DO NOTHING`,
      [this.newId(), q.network_id, root.id, qualificationId, agentId, reason, hours, this.now().toISOString()],
    );
    const row = await this.db.first<AttributionRow>('SELECT * FROM attributions WHERE qualification_id = ?', [qualificationId]);
    if (changes === 1 && row) {
      if (agentId) await this.assign(root.id, agentId, null);
      await this.log('attribution', root.id, { rule: 'R25', reason, toDirection: agentId === null, callbackHours: hours });
    }
    return row;
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
    for (const a of open) {
      if (Date.parse(a.created_at) + a.callback_hours * 3_600_000 > at.getTime()) continue;
      const view = await this.fiche.view(a.person_id);
      const root = view.person;
      const ids = view.members.map((m) => m.id);
      // Une attribution plus récente de la même fiche fait foi : celle-ci n'est plus la bonne.
      const latest = await this.current(root.id);
      if (latest?.id !== a.id) continue;
      if (await this.excluded(ids)) continue;
      if (await this.calledBack(ids, a.created_at)) continue;

      const chain = await this.chain(a);
      const tried = new Set(chain.map((c) => c.agent_id).filter((id): id is string => id !== null));
      const first = chain[chain.length - 1]!;
      const q = first.qualification_id
        ? await this.db.first<{ city: string | null; property_id: string | null }>('SELECT city, property_id FROM qualifications WHERE id = ?', [first.qualification_id])
        : null;
      const commune = q ? (q.city ?? (await this.propertyCommune(q.property_id))) : null;
      const next = commune ? chooseAgent(root.id, await this.agentsOf(networkId, commune), tried) : null;
      const id = this.newId();
      const { changes } = await this.db.run(
        `INSERT INTO attributions (id, network_id, person_id, qualification_id, agent_id, reason, callback_hours, replaces_id, created_at)
         VALUES (?, ?, ?, NULL, ?, 'reassigned', ?, ?, ?) ON CONFLICT (replaces_id) DO NOTHING`,
        [id, networkId, root.id, next, a.callback_hours, a.id, at.toISOString()],
      );
      if (changes !== 1) continue;
      await this.assign(root.id, next, a.agent_id);
      await this.log('attribution.reattribuee', root.id, { rule: 'R25', toDirection: next === null, tries: tried.size });
      const row = await this.db.first<AttributionRow>('SELECT * FROM attributions WHERE id = ?', [id]);
      if (row) made.push(row);
    }
    return made;
  }

  /** La fiche passe à l'agent ; seulement si elle n'a pas d'agent en activité, ou si elle était à `from`. */
  private async assign(personId: string, agentId: string | null, from: string | null): Promise<void> {
    const at = this.now().toISOString();
    if (from !== null) {
      await this.db.run('UPDATE persons SET agent_id = ?, updated_at = ? WHERE id = ? AND agent_id = ?', [agentId, at, personId, from]);
      return;
    }
    await this.db.run(
      `UPDATE persons SET agent_id = ?, updated_at = ? WHERE id = ?
         AND (agent_id IS NULL OR agent_id IN (SELECT id FROM agents WHERE status = 'left'))`,
      [agentId, at, personId],
    );
  }

  /** La suite des attributions, de la plus récente à la première. */
  private async chain(a: AttributionRow): Promise<AttributionRow[]> {
    const chain = [a];
    let cur: AttributionRow | null = a;
    while (cur?.replaces_id) {
      cur = await this.db.first<AttributionRow>('SELECT * FROM attributions WHERE id = ?', [cur.replaces_id]);
      if (cur) chain.push(cur);
    }
    return chain;
  }

  private async excluded(ids: readonly string[]): Promise<boolean> {
    const at = this.now().toISOString();
    const row = await this.db.first<{ n: number }>(
      `SELECT count(*) AS n FROM exclusions WHERE person_id IN (${placeholders(ids.length)}) AND noted_at <= ? AND (lifted_at IS NULL OR lifted_at > ?)`,
      [...ids, at, at],
    );
    return Number(row?.n ?? 0) > 0;
  }

  /** Un humain du réseau a écrit à la personne depuis l'attribution : elle a été rappelée. */
  private async calledBack(ids: readonly string[], since: string): Promise<boolean> {
    const row = await this.db.first<{ n: number }>(
      `SELECT count(*) AS n FROM messages WHERE person_id IN (${placeholders(ids.length)}) AND direction = 'out' AND author_kind = 'agent' AND occurred_at >= ?`,
      [...ids, since],
    );
    return Number(row?.n ?? 0) > 0;
  }

  private async activeAgent(networkId: string, agentId: string): Promise<string | null> {
    const row = await this.db.first<{ id: string }>("SELECT id FROM agents WHERE id = ? AND network_id = ? AND status = 'active'", [agentId, networkId]);
    return row?.id ?? null;
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
    await appendEvent(this.journal, { type, actor: 'system:attribution', subject: `person:${personId}`, data }, this.now);
  }
}
