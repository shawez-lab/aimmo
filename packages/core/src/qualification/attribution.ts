/**
 * L'attribution d'un contact qualifié à l'agent de sa commune (M03, Q03), par des règles fixes écrites ici, sans IA,
 * les mêmes pour tous [R14, R25]. Elles sont rendues lisibles par `ATTRIBUTION_RULES`, pour l'application.
 *
 * Une personne exclue ou qui a demandé l'arrêt n'est jamais attribuée [R25]. Un agent absent ce jour-là (absence
 * déclarée en M14, J09) n'est jamais candidat : le contact suit la règle de remplacement, son binôme d'abord [R680].
 * Rien n'est envoyé à personne ici.
 */
import { runBatch, type SqlDatabase, type SqlStatement } from '../db/sql.ts';
import type { FicheUnique } from '../fiche/fusion.ts';
import { localTime } from '../envoi/horaires.ts';
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
  'Sinon, le contact va à un agent en activité dont la zone couvre sa commune, celle qu’il a donnée, à défaut celle du bien cité, à défaut celle d’un message d’avant, et qui ne l’a pas encore eu.',
  'Si plusieurs agents couvrent la commune, le choix se fait par un tirage fixe sur l’identifiant de la fiche : le même contact va toujours au même agent.',
  'Si aucun agent ne couvre la commune, le contact va à la direction, jamais au hasard.',
  'Un contact qui n’a pas été rappelé dans le délai de la charte est réattribué une fois par délai, par la même règle, à un agent qui ne l’a pas encore eu ; s’il n’y en a plus, à la direction.',
  'Un nouveau message ne repousse jamais le délai en cours : tant que personne n’a rappelé, le délai le plus court fait foi.',
  'Un agent absent ce jour-là, par une absence déclarée, n’est jamais candidat : un client qu’il suit va au binôme de son absence, s’il est en activité et présent, sinon à la direction ; la fiche reste à l’absent, qui la retrouve à son retour.',
  'Un nouveau contact dont tous les agents de la commune sont absents va, par le même tirage fixe, au binôme présent de l’un d’eux, sinon à la direction.',
  'Un contact en attente chez un agent qui devient absent est réattribué dès le premier passage, sans attendre la fin du délai, par la même règle.',
  'Chaque agent écarté pour absence est noté avec l’absence qui l’a écarté.',
  'Aucune IA ne participe à l’attribution.',
]);

const TIME_ZONE = 'Europe/Paris';

/** L'absence qui écarte un agent aujourd'hui, et le binôme qui reprend [R680]. */
interface AwayAgent {
  absenceId: string;
  coverId: string;
}

/** Un agent écarté pour absence, et son binôme quand c'est lui qui a reçu le contact. */
interface Skipped {
  agentId: string;
  absenceId: string;
  coverId: string | null;
}

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
    let skipped: Skipped[] = [];
    // Un client suivi par un absent va à son binôme, mais sa fiche reste à l'absent [R680].
    let covering = false;
    const away = await this.awayAgents(q.network_id);
    // L'agent qui suit déjà le client, sur toutes les fiches réunies : la fiche gardée d'abord.
    const followed = await this.followedBy(q.network_id, [root.agent_id, ...view.members.map((m) => m.agent_id)]);
    if (followed) {
      reason = 'already_followed';
      const absence = away.get(followed);
      if (!absence) agentId = followed;
      else {
        agentId = await this.coverOf(q.network_id, absence, away);
        skipped = [{ agentId: followed, absenceId: absence.absenceId, coverId: agentId }];
        covering = true;
      }
    } else if (q.category === 'partner') {
      reason = 'no_zone';
    } else {
      // Un message sans commune garde celle d'un message d'avant, et un agent qui a déjà eu le contact sans le
      // rappeler ne le reçoit pas de nouveau parce que la personne a réécrit.
      const history = await this.history(ids);
      const tried = new Set(history.map((c) => c.agent_id).filter((id): id is string => id !== null));
      const commune = q.city ?? (await this.propertyCommune(q.property_id)) ?? (await this.lastCommune(history));
      const picked = commune ? await this.pick(q.network_id, root.id, await this.agentsOf(q.network_id, commune), tried, away) : { agentId: null, skipped: [] };
      agentId = picked.agentId;
      skipped = picked.skipped;
      reason = agentId ? 'zone' : 'no_zone';
    }

    const hot = await this.db.first<{ temperature: string }>('SELECT temperature FROM contact_scores WHERE qualification_id = ?', [qualificationId]);
    const hours = hot?.temperature === 'hot' ? this.settings.hotCallbackHours : this.settings.otherCallbackHours;
    // L'attribution, ses absences et le passage de la fiche, tout ou rien : une coupure ne laisse jamais un agent
    // sans accès.
    const attributionId = this.newId();
    const [inserted] = await runBatch(this.db, [
      {
        sql: `INSERT INTO attributions (id, network_id, person_id, qualification_id, agent_id, reason, callback_hours, replaces_id, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?) ON CONFLICT (qualification_id) DO NOTHING`,
        params: [attributionId, q.network_id, root.id, qualificationId, agentId, reason, hours, this.now().toISOString()],
      },
      ...this.skippedRows(attributionId, q.network_id, skipped),
      ...this.takeOver(root.id, ids, covering ? null : agentId, Boolean(followed)),
    ]);
    const row = await this.db.first<AttributionRow>('SELECT * FROM attributions WHERE qualification_id = ?', [qualificationId]);
    if (inserted?.changes === 1 && row) {
      await this.log('attribution', root.id, { rule: 'R25', reason, toDirection: agentId === null, callbackHours: hours, ...this.absenceData(skipped) });
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
    const seen = new Set<string>();
    const away = await this.awayAgents(networkId);
    for (const row of open) {
      // Seule une ligne déjà échue peut porter le délai le plus court : les autres n'ont rien à décider, sauf chez un
      // agent absent aujourd'hui, qui ne garde rien en attente [R680].
      if (Date.parse(row.created_at) + row.callback_hours * 3_600_000 > at.getTime() && !away.has(row.agent_id!)) continue;
      const view = await this.fiche.view(row.person_id);
      const root = view.person;
      const ids = view.members.map((m) => m.id);
      // L'attribution en cours de la fiche fait foi, et un message de plus ne remet pas son délai à zéro.
      const a = await this.current(root.id);
      if (!a || a.agent_id === null || seen.has(a.id)) continue;
      seen.add(a.id);
      if (await this.excluded(ids)) continue;
      const history = await this.history(ids);
      const absence = away.get(a.agent_id);
      const delay = await this.openDelay(a, history, ids);
      // Un agent qui a rappelé depuis n'a rien en attente, absent ou non.
      if (delay === null || (delay.deadline > at.getTime() && !absence)) continue;

      const tried = new Set(history.map((c) => c.agent_id).filter((id): id is string => id !== null));
      let next: string | null = null;
      let skipped: Skipped[] = [];
      if (absence) {
        // L'absent passe la main à son binôme d'abord, s'il ne l'a pas déjà eu.
        const cover = await this.coverOf(networkId, absence, away);
        if (cover !== null && !tried.has(cover)) next = cover;
        skipped = [{ agentId: a.agent_id, absenceId: absence.absenceId, coverId: next }];
      }
      if (next === null) {
        const commune = await this.lastCommune(history);
        const picked = commune ? await this.pick(networkId, root.id, await this.agentsOf(networkId, commune), tried, away) : { agentId: null, skipped: [] };
        next = picked.agentId;
        skipped = [...skipped, ...picked.skipped.filter((s) => s.agentId !== a.agent_id)];
      }
      const id = this.newId();
      const [inserted] = await runBatch(this.db, [
        {
          sql: `INSERT INTO attributions (id, network_id, person_id, qualification_id, agent_id, reason, callback_hours, replaces_id, created_at)
                VALUES (?, ?, ?, NULL, ?, 'reassigned', ?, ?, ?) ON CONFLICT (replaces_id) DO NOTHING`,
          params: [id, networkId, root.id, next, delay.hours, a.id, at.toISOString()],
        },
        ...this.skippedRows(id, networkId, skipped),
        // Toutes les fiches réunies que suivait l'agent, ou un agent parti, changent de mains : jamais deux agents.
        // Les fiches d'un absent lui restent : il les retrouve à son retour, son binôme les lit pendant l'absence.
        absence
          ? {
              sql: `UPDATE persons SET agent_id = ?, updated_at = ? WHERE id IN (${placeholders(ids.length)}) AND agent_id IN (SELECT id FROM agents WHERE status = 'left')`,
              params: [next, at.toISOString(), ...ids],
            }
          : {
              sql: `UPDATE persons SET agent_id = ?, updated_at = ? WHERE id IN (${placeholders(ids.length)})
                AND (agent_id = ? OR agent_id IN (SELECT id FROM agents WHERE status = 'left'))`,
              params: [next, at.toISOString(), ...ids, a.agent_id],
            },
      ]);
      if (inserted?.changes !== 1) continue;
      await this.log('attribution.reattribuee', root.id, { rule: 'R25', toDirection: next === null, tries: tried.size, ...this.absenceData(skipped) });
      const made1 = await this.db.first<AttributionRow>('SELECT * FROM attributions WHERE id = ?', [id]);
      if (made1) made.push(made1);
    }
    return made;
  }

  /**
   * Ce que l'attribution change sur les fiches : un ancien agent parti, sur une fiche réunie, bloquerait l'accès du
   * nouvel agent [R16]. La fiche gardée sans agent prend l'agent, sauf s'il suit déjà l'une de ses fiches réunies.
   */
  private takeOver(rootId: string, ids: readonly string[], agentId: string | null, followed: boolean): SqlStatement[] {
    if (agentId === null) return [];
    const at = this.now().toISOString();
    const statements: SqlStatement[] = [
      {
        sql: `UPDATE persons SET agent_id = ?, updated_at = ? WHERE id IN (${placeholders(ids.length)}) AND agent_id IN (SELECT id FROM agents WHERE status = 'left')`,
        params: [agentId, at, ...ids],
      },
    ];
    if (!followed) statements.push({ sql: 'UPDATE persons SET agent_id = ?, updated_at = ? WHERE id = ? AND agent_id IS NULL', params: [agentId, at, rootId] });
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
  private async openDelay(current: AttributionRow, history: readonly AttributionRow[], ids: readonly string[]): Promise<{ deadline: number; hours: number } | null> {
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
      const q = await this.db.first<{ city: string | null; property_id: string | null }>('SELECT city, property_id FROM qualifications WHERE id = ?', [row.qualification_id]);
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

  /**
   * Les agents absents aujourd'hui (jour de Paris), par une absence déclarée en M14 : pour chacun, la dernière absence
   * déclarée qui couvre ce jour, et son binôme [R680].
   */
  private async awayAgents(networkId: string): Promise<Map<string, AwayAgent>> {
    const day = localTime(this.now(), TIME_ZONE).date;
    const rows = await this.db.all<{ id: string; agent_id: string; cover_agent_id: string }>(
      `SELECT id, agent_id, cover_agent_id FROM agent_absences WHERE network_id = ? AND from_day <= ? AND until_day >= ?
       ORDER BY declared_at, rowid`,
      [networkId, day, day],
    );
    const away = new Map<string, AwayAgent>();
    for (const r of rows) away.set(r.agent_id, { absenceId: r.id, coverId: r.cover_agent_id });
    return away;
  }

  /** Le binôme de l'absence, s'il est en activité et présent lui-même ; null sinon [R680]. */
  private async coverOf(networkId: string, absence: AwayAgent, away: ReadonlyMap<string, AwayAgent>): Promise<string | null> {
    if (away.has(absence.coverId)) return null;
    return this.followedBy(networkId, [absence.coverId]);
  }

  /**
   * Le tirage fixe parmi les agents présents de la commune ; si tous ceux qui restent sont absents, parmi leurs binômes
   * présents, par le même tirage ; sinon la direction. Rend aussi les absents écartés [R25, R680].
   */
  private async pick(
    networkId: string,
    rootId: string,
    candidates: readonly string[],
    tried: ReadonlySet<string>,
    away: ReadonlyMap<string, AwayAgent>,
  ): Promise<{ agentId: string | null; skipped: Skipped[] }> {
    const absent = [...new Set(candidates)].filter((id) => away.has(id) && !tried.has(id)).sort();
    const chosen = chooseAgent(
      rootId,
      candidates.filter((id) => !away.has(id)),
      tried,
    );
    if (chosen !== null) return { agentId: chosen, skipped: absent.map((id) => ({ agentId: id, absenceId: away.get(id)!.absenceId, coverId: null })) };
    const covers: string[] = [];
    for (const id of absent) {
      const cover = await this.coverOf(networkId, away.get(id)!, away);
      if (cover !== null) covers.push(cover);
    }
    const viaCover = chooseAgent(rootId, covers, tried);
    return {
      agentId: viaCover,
      skipped: absent.map((id) => {
        const absence = away.get(id)!;
        return { agentId: id, absenceId: absence.absenceId, coverId: viaCover !== null && absence.coverId === viaCover ? viaCover : null };
      }),
    };
  }

  /** Les absents écartés, rangés avec l'attribution, seulement si elle a bien été écrite [R17, R680]. */
  private skippedRows(attributionId: string, networkId: string, skipped: readonly Skipped[]): SqlStatement[] {
    const at = this.now().toISOString();
    return skipped.map((s) => ({
      sql: `INSERT INTO attribution_absences (attribution_id, network_id, absent_agent_id, absence_id, cover_agent_id, created_at)
            SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM attributions WHERE id = ?)`,
      params: [attributionId, networkId, s.agentId, s.absenceId, s.coverId, at, attributionId],
    }));
  }

  /** Au journal, des nombres : combien d'absents écartés, et si un binôme a repris [R13]. */
  private absenceData(skipped: readonly Skipped[]): Record<string, number | boolean> {
    if (skipped.length === 0) return {};
    return { absentSkipped: skipped.length, byCover: skipped.some((s) => s.coverId !== null) };
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
