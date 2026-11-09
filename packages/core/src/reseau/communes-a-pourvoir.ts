/**
 * Les communes où des clients attendent un agent, ouvertes au recrutement (HX68 ; Feuille de route, phase 4,
 * « Recrutement en Bourgogne-Franche-Comté » ; M14, « Candidature » ; M03, attribution) [R626, R627, R628].
 *
 * Pour un mois fini de Paris, le code seul lit dans la base, commune par commune de la liste réglée, les personnes
 * dont un contact est allé à la direction parce qu'aucun agent n'avait de zone ouverte sur sa commune à l'instant de
 * l'attribution (M03, « Si aucun agent ne couvre la commune, le contact va à la direction ») ; et les agents en
 * activité qui la couvrent aujourd'hui. Un partenaire, un curieux ou un indésirable ne compte pas : ce ne sont pas
 * des clients qui attendent. Un contact sans commune connue (ni la sienne ni celle du bien cité) est compté à part,
 * jamais rangé dans une commune au hasard [R626].
 *
 * La direction seule ouvre ou ferme une commune au recrutement, par versions qui ne changent plus [R627, R17]. La
 * page de candidature ne lit que les noms des communes ouvertes, rangés par ordre alphabétique, sans aucun chiffre :
 * rien n'y promet des clients ni un revenu [R628, R80].
 *
 * Jamais vu : le recrutement guidé par la demande réelle, lue dans la base et non supposée. La direction voit où des
 * clients sont restés sans agent ce mois-là, et chaque commune ouverte qu'un agent couvre désormais lui est signalée
 * pour être fermée. Aucun nom de personne ni d'agent n'est rendu, aucun agent n'est classé [R14].
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { monthBounds } from '../pilotage/indicateurs-reseau.ts';
import { parisMonth } from '../pilotage/preuve.ts';
import { DEFAULT_COMMUNES } from '../qualification/regles.ts';

/** Les sortes de contacts qui sont des clients : un partenaire, un curieux ou un indésirable n'attendent pas d'agent. */
export const WAITING_CLIENT_CATEGORIES = ['seller', 'buyer', 'valuation', 'rent_out', 'professional'] as const;

export const RECRUITING_COMMUNE_FIELDS = ['commune', 'open', 'reason'] as const;

export type CommunesRefusal = { ok: false; rule: 'R16'; code: 'role' } | { ok: false; rule: 'R626' | 'R627' | null; code: string };

export interface CommuneAPourvoir {
  commune: string;
  /** Personnes dont un contact du mois est allé à la direction faute d'agent sur la commune. */
  clientsWaiting: number;
  /** Agents en activité dont une zone ouverte couvre la commune aujourd'hui. */
  agentsNow: number;
  /** Ouverte au recrutement aujourd'hui, par la dernière décision de la direction. */
  open: boolean;
  openSince: string | null;
  /** Des clients ont attendu, aucun agent ne la couvre et elle n'est pas ouverte : à décider. */
  toOpen: boolean;
  /** Ouverte alors qu'un agent la couvre désormais : à fermer, si la direction le décide. */
  toClose: boolean;
}

export interface CommunesMonth {
  month: string;
  communes: CommuneAPourvoir[];
  /** Personnes allées à la direction sans commune connue, ou hors de la liste : jamais rangées dans une commune. */
  withoutCommune: number;
}

interface Options {
  now?: () => Date;
  /** La liste des communes, celle de l'attribution (M03). */
  communes?: readonly string[];
}

const isMonth = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
const byName = (a: string, b: string): number => a.localeCompare(b, 'fr');
/** Le jour de Paris d'un instant : un agent est parti dès le jour de son départ, passé ou non (J11, `agentGone`). */
const parisDate = (iso: string): string => localTime(new Date(iso), 'Europe/Paris').date;

export class CommunesAPourvoir {
  private readonly now: () => Date;
  readonly communes: readonly string[];

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: Options = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.communes = options.communes ?? DEFAULT_COMMUNES;
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  /** La direction seule ; tout autre rôle est refusé et le refus écrit au journal [R16]. */
  private async direction(viewer: Viewer, kind: string): Promise<CommunesRefusal | null> {
    if (viewer.role === 'direction') return null;
    await appendEvent(
      this.journal,
      { type: 'acces.refuse', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind, code: 'role' } },
      this.now,
    );
    return { ok: false, rule: 'R16', code: 'role' };
  }

  private async refuse(viewer: Viewer, refusal: CommunesRefusal): Promise<CommunesRefusal> {
    await appendEvent(this.journal, { type: 'communes_recrutement.refuse', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: refusal.rule, code: refusal.code } }, this.now);
    return refusal;
  }

  /** L'état de chaque commune : la décision la plus haute, ouverte ou fermée. */
  private async states(networkId: string): Promise<Map<string, { open: boolean; at: string }>> {
    const rows = await this.db.all<{ commune: string; is_open: number; decided_at: string }>(
      `SELECT d.commune, d.is_open, d.decided_at FROM recruiting_commune_decisions d
        WHERE d.network_id = ? AND d.version = (SELECT MAX(e.version) FROM recruiting_commune_decisions e WHERE e.network_id = d.network_id AND e.commune = d.commune)`,
      [networkId],
    );
    return new Map(rows.map((r) => [r.commune, { open: Number(r.is_open) === 1, at: r.decided_at }]));
  }

  /** Les communes d'un mois fini de Paris, pour la direction seule ; la lecture est écrite au journal avant d'être rendue [R626, R16]. */
  async month(viewer: Viewer, month: unknown): Promise<{ ok: true; value: CommunesMonth } | CommunesRefusal> {
    const denied = await this.direction(viewer, 'recruiting_communes_month');
    if (denied) return denied;
    if (!isMonth(month)) return this.refuse(viewer, { ok: false, rule: null, code: 'bad_month' });
    if (month >= parisMonth(this.now())) return this.refuse(viewer, { ok: false, rule: 'R626', code: 'month_not_finished' });
    const net = viewer.networkId;
    const [start, end] = monthBounds(month);
    const listed = new Set(this.communes);

    // Les premières attributions du mois allées à la direction faute de zone (M03, `no_zone`) ; une réattribution
    // n'est jamais comptée : le contact avait alors un agent. La commune est celle que l'attribution a lue : celle du
    // contact, à défaut celle du bien cité (dans la liste) ; un contact sans l'une ni l'autre est compté à part.
    const placeholders = WAITING_CLIENT_CATEGORIES.map(() => '?').join(', ');
    const rows = await this.db.all<{ person_id: string; city: string | null; property_city: string | null; created_at: string }>(
      `SELECT a.person_id, q.city, p.city AS property_city, a.created_at
         FROM attributions a
         JOIN qualifications q ON q.id = a.qualification_id AND q.network_id = a.network_id
         LEFT JOIN properties p ON p.id = q.property_id AND p.network_id = a.network_id
        WHERE a.network_id = ? AND a.reason = 'no_zone' AND a.agent_id IS NULL AND a.replaces_id IS NULL
          AND q.category IN (${placeholders}) AND a.created_at >= ? AND a.created_at < ?
        ORDER BY a.created_at, a.id`,
      [net, ...WAITING_CLIENT_CATEGORIES, start, end],
    );

    // Chaque fiche ramenée à sa fiche gardée : une personne dont deux fiches ont été réunies compte une fois (S04).
    const merges = await this.db.all<{ survivor_id: string; merged_id: string }>('SELECT survivor_id, merged_id FROM person_merges WHERE network_id = ? AND undone_at IS NULL', [net]);
    const survivorOf = new Map(merges.map((m) => [m.merged_id, m.survivor_id]));
    const rootOf = (id: string): string => {
      let current = id;
      const seen = new Set<string>();
      while (survivorOf.has(current) && !seen.has(current)) {
        seen.add(current);
        current = survivorOf.get(current)!;
      }
      return current;
    };

    const waiting = new Map<string, Set<string>>();
    const withoutCommune = new Set<string>();
    for (const row of rows) {
      const r = { ...row, person_id: rootOf(row.person_id) };
      const commune = r.city ?? (r.property_city && listed.has(r.property_city) ? r.property_city : null);
      if (!commune || !listed.has(commune)) {
        withoutCommune.add(r.person_id);
        continue;
      }
      // Une zone ouverte sur la commune à l'instant de l'attribution, d'un agent alors en activité : le contact
      // n'attendait pas faute d'agent (tous ses agents l'avaient déjà eu) ; il n'est pas compté. Un départ ne ferme pas
      // les zones (J11) : un agent était en activité si aucun départ en vigueur n'était arrivé ce jour-là (jour de
      // Paris, comme `agentGone`), et s'il est encore actif ou que son départ en vigueur arrive après. Un agent parti
      // avant, ou « parti » sans départ rangé, ne couvre rien.
      const day = parisDate(r.created_at);
      const covered = await this.db.first<{ one: number }>(
        `SELECT 1 AS one FROM agent_zones z JOIN agents g ON g.id = z.agent_id AND g.network_id = z.network_id
          WHERE z.network_id = ? AND z.commune = ? AND z.created_at <= ? AND (z.ended_at IS NULL OR z.ended_at > ?)
            AND NOT EXISTS (SELECT 1 FROM agent_departures d
                             WHERE d.agent_id = g.id AND d.network_id = g.network_id AND d.cancelled_at IS NULL AND d.leaves_on <= ?)
            AND (g.status = 'active' OR EXISTS (SELECT 1 FROM agent_departures d
                             WHERE d.agent_id = g.id AND d.network_id = g.network_id AND d.cancelled_at IS NULL AND d.leaves_on > ?))
          LIMIT 1`,
        [net, commune, r.created_at, r.created_at, day, day],
      );
      if (covered) continue;
      const set = waiting.get(commune) ?? new Set<string>();
      set.add(r.person_id);
      waiting.set(commune, set);
    }

    // Une personne comptée dans une commune ne l'est pas aussi « sans commune ».
    for (const set of waiting.values()) for (const id of set) withoutCommune.delete(id);

    const agents = await this.db.all<{ commune: string; n: number }>(
      `SELECT z.commune, COUNT(DISTINCT z.agent_id) AS n FROM agent_zones z
         JOIN agents g ON g.id = z.agent_id AND g.network_id = z.network_id
        WHERE z.network_id = ? AND z.ended_at IS NULL AND g.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM agent_departures d
                           WHERE d.agent_id = g.id AND d.network_id = g.network_id AND d.cancelled_at IS NULL AND d.leaves_on <= ?)
        GROUP BY z.commune`,
      // Le jour de son départ, un agent ne couvre plus rien, même avant le passage qui le dit « parti » (J11).
      [net, parisDate(this.now().toISOString())],
    );
    const agentsBy = new Map(agents.map((a) => [a.commune, Number(a.n)]));
    const states = await this.states(net);

    const communes: CommuneAPourvoir[] = [...listed]
      .map((commune) => {
        const clientsWaiting = waiting.get(commune)?.size ?? 0;
        const agentsNow = agentsBy.get(commune) ?? 0;
        const state = states.get(commune);
        const open = state?.open ?? false;
        return {
          commune,
          clientsWaiting,
          agentsNow,
          open,
          openSince: open ? state!.at : null,
          toOpen: clientsWaiting > 0 && agentsNow === 0 && !open,
          toClose: open && agentsNow > 0,
        };
      })
      .sort((a, b) => b.clientsWaiting - a.clientsWaiting || byName(a.commune, b.commune));

    const value: CommunesMonth = { month, communes, withoutCommune: withoutCommune.size };
    await appendEvent(
      this.journal,
      {
        type: 'communes_recrutement.mois_lu',
        actor: this.actor(viewer),
        subject: `network:${net}`,
        data: { rule: 'R16', month, waiting: communes.reduce((s, c) => s + c.clientsWaiting, 0), withoutCommune: value.withoutCommune },
      },
      this.now,
    );
    return { ok: true, value };
  }

  /** Ouvre ou ferme une commune de la liste au recrutement, par la direction seule ; une version s'ajoute [R627]. */
  async decide(viewer: Viewer, input: unknown): Promise<{ ok: true; value: { commune: string; version: number; open: boolean } } | CommunesRefusal> {
    const denied = await this.direction(viewer, 'recruiting_commune_decision');
    if (denied) return denied;
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return this.refuse(viewer, { ok: false, rule: null, code: 'bad_shape' });
    const raw = input as Record<string, unknown>;
    if (Object.keys(raw).some((k) => !(RECRUITING_COMMUNE_FIELDS as readonly string[]).includes(k))) return this.refuse(viewer, { ok: false, rule: null, code: 'unknown_field' });
    if (typeof raw.commune !== 'string' || !this.communes.includes(raw.commune)) return this.refuse(viewer, { ok: false, rule: 'R627', code: 'commune_inconnue' });
    if (typeof raw.open !== 'boolean') return this.refuse(viewer, { ok: false, rule: null, code: 'bad_open' });
    const reason = typeof raw.reason === 'string' ? raw.reason.trim().replace(/\s+/g, ' ') : '';
    if (reason.length < 3 || reason.length > 200) return this.refuse(viewer, { ok: false, rule: null, code: 'bad_reason' });
    const commune = raw.commune;
    const last = await this.db.first<{ version: number; is_open: number }>(
      'SELECT version, is_open FROM recruiting_commune_decisions WHERE network_id = ? AND commune = ? ORDER BY version DESC LIMIT 1',
      [viewer.networkId, commune],
    );
    const current = last ? Number(last.is_open) === 1 : false;
    if (current === raw.open) return this.refuse(viewer, { ok: false, rule: 'R627', code: raw.open ? 'deja_ouverte' : 'deja_fermee' });
    const version = Number(last?.version ?? 0) + 1;
    try {
      await this.db.run('INSERT INTO recruiting_commune_decisions (network_id, commune, version, is_open, reason, decided_by, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        viewer.networkId,
        commune,
        version,
        raw.open ? 1 : 0,
        reason,
        this.actor(viewer),
        this.now().toISOString(),
      ]);
    } catch {
      // Une autre décision sur la même commune est passée entre la lecture et l'écriture : rien n'est rangé.
      return this.refuse(viewer, { ok: false, rule: 'R627', code: 'conflit' });
    }
    await appendEvent(this.journal, { type: 'communes_recrutement.decision', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { commune, version, open: raw.open } }, this.now);
    return { ok: true, value: { commune, version, open: raw.open } };
  }

  /**
   * Ce que la page publique de candidature lit : les noms des communes ouvertes au recrutement, dans la liste réglée,
   * par ordre alphabétique, et rien d'autre : aucun chiffre, aucune personne, aucune promesse [R628].
   */
  async openCommunes(networkId: string): Promise<string[]> {
    const states = await this.states(networkId);
    return this.communes.filter((c) => states.get(c)?.open === true).sort(byName);
  }
}
