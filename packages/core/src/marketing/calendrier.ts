/**
 * Calendrier de publication sur tous les réseaux (HX52, M07, M19).
 *
 * L'agent règle son calendrier : combien de publications par réseau et par jour (0 à 3), à quelles heures de Paris.
 * Le calendrier réserve alors, jour par jour, les créneaux avec des publications prêtes (préparées et validées par
 * l'agent, X05) de ses propres biens, en rotation stricte : à chaque créneau, le bien choisi est un de ceux qui sont
 * le moins sortis sur ce réseau ; aucun bien n'est donc repris tant qu'un bien prêt n'est jamais sorti, et parmi les
 * biens jamais sortis le plus récent passe d'abord : un bien nouveau chaque jour [R580].
 *
 * Le nombre réglé est tenu par la base : un rang au-delà du nombre de la version en vigueur est refusé, même rejoué
 * ou demandé deux fois en même temps ; une nouvelle version ne vaut qu'à partir du lendemain, jamais pour un jour
 * déjà commencé [R581].
 *
 * Le calendrier n'appelle aucun réseau : chaque créneau dû passe une seule fois, réservé en base, par le seul chemin
 * de publication de X05 (`Publications.publish`), qui relit la validation de l'agent, la porte de diffusion, les
 * certificats, et n'admet que le mode essai [R134, R42, R26]. Un créneau ne part qu'avec son lien marqué vers la
 * page du bien (AT20) ; sans lien, ou l'agent parti, rien ne part [R582, R156, R86]. Au journal : les issues et les
 * règles, jamais le texte [R13].
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { PropertyStatus } from '../db/types.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { agentGone } from '../reseau/depart.ts';
import { EVENT_STATUSES, SOCIAL_CHANNELS, type PostResult, type SocialChannelName, type SocialEvent, type SocialPost } from '../studio/publications.ts';

const TIME_ZONE = 'Europe/Paris';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const HOUR = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** Le calendrier se réserve au plus deux semaines à l'avance. */
export const MAX_DAYS_AHEAD = 13;
/** Un créneau dû qui n'est pas passé dans les deux heures est manqué : il ne part jamais en retard. */
export const LATE_MS = 2 * 3_600_000;
export const MAX_PER_DAY = 3;

export type CalendarRule = 'R10' | 'R16' | 'R86' | 'R580' | 'R581' | 'R582';
export type CalendarResult<T> = { ok: true; value: T } | { ok: false; rule: CalendarRule; code: string };

export interface CalendarRules {
  version: number;
  perDay: Record<SocialChannelName, number>;
  hours: string[];
  effectiveDay: string;
}

export interface CalendarSlot {
  id: string;
  day: string;
  channel: SocialChannelName;
  rank: number;
  dueAt: string;
  postId: string;
  propertyId: string;
  /**
   * La référence du bien, lue dans la base à chaque lecture et seulement dans le réseau du créneau (RC74) : l'agent
   * sait quel bien sortira. null si le bien n'est pas trouvé dans ce réseau, jamais la référence d'un autre [R16].
   */
  propertyReference: string | null;
  /** null : à venir, ou pas encore passé. */
  outcome: 'envoye' | 'echec' | 'refuse' | 'manque' | null;
  /**
   * Pour un créneau refusé au passage seulement, la raison dans une liste fermée (BR111) : `sans_lien` (aucun lien
   * marqué vers la page du bien) [R582], `non_diffusable` (porte de diffusion fermée) [R42], `agent_parti` [R86],
   * `manque` (passé trop tard), `controle` (tout autre refus du chemin de publication). null sinon.
   */
  reason: SlotReason | null;
}

export type SlotReason = 'sans_lien' | 'non_diffusable' | 'agent_parti' | 'manque' | 'controle';
const REASONS: Readonly<Record<string, SlotReason>> = { sans_lien: 'sans_lien', bien_non_diffusable: 'non_diffusable', agent_parti: 'agent_parti', manque: 'manque' };

/** Le seul chemin de publication, celui de X05 : `Publications` le remplit [R582]. */
export interface PublicationGate {
  publish(viewer: Viewer, postId: string, targets: unknown, options?: { requireLink?: boolean }): Promise<PostResult<SocialPost>>;
}

export interface CalendarDeps {
  gate: PublicationGate;
  /** La porte de diffusion de D05 [R42]. */
  diffusion: { canDiffuse(networkId: string, propertyId: string, at?: Date): Promise<{ allowed: boolean }> };
  /** Le lien marqué de AT20, vers la page de référence du bien ; null sans page en ligne [R156]. */
  links: { studioLink(networkId: string, kind: 'publication', ref: string, propertyId: string): Promise<{ contentId: string; link: string | null } | null> };
}

export interface CalendarOptions {
  now?: () => Date;
  newId?: () => string;
}

interface RulesRow {
  id: string;
  version: number;
  instagram: number;
  facebook: number;
  linkedin: number;
  google: number;
  tiktok: number;
  youtube: number;
  hours: string;
  effective_day: string;
}

interface SlotRow {
  id: string;
  network_id: string;
  agent_id: string;
  rules_id: string;
  day: string;
  channel: SocialChannelName;
  rank: number;
  post_id: string;
  property_id: string;
  due_at: string;
  outcome: 'envoye' | 'echec' | 'refuse' | null;
  code: string | null;
  claimed: string | null;
  /** Lu seulement par `slots`. */
  property_reference?: string | null;
}

const validDay = (v: unknown): v is string => {
  if (typeof v !== 'string' || !DAY.test(v)) return false;
  const d = new Date(`${v}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** L'instant d'une heure de Paris un jour donné, heure d'été ou d'hiver. */
export function parisInstant(day: string, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const base = Date.parse(`${day}T${hhmm}:00Z`);
  for (const offsetHours of [1, 2, 0]) {
    const candidate = new Date(base - offsetHours * 3_600_000);
    const l = localTime(candidate, TIME_ZONE);
    if (l.date === day && l.minutes === h * 60 + m) return candidate;
  }
  // L'heure qui n'existe pas au passage à l'heure d'été (2 h 30) : la première qui suit.
  return new Date(base - 3_600_000);
}

const rulesOf = (r: RulesRow): CalendarRules => ({
  version: r.version,
  perDay: { instagram: r.instagram, facebook: r.facebook, linkedin: r.linkedin, google: r.google, tiktok: r.tiktok, youtube: r.youtube },
  hours: JSON.parse(r.hours) as string[],
  effectiveDay: r.effective_day,
});

export class CalendrierPublications {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly deps: CalendarDeps,
    options: CalendarOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  private today(): string {
    return localTime(this.now(), TIME_ZONE).date;
  }

  /** L'agent en activité, pour son propre calendrier [R16, R86]. */
  private async self(viewer: Viewer): Promise<CalendarResult<null>> {
    if (viewer.role !== 'agent') return { ok: false, rule: 'R16', code: 'role' };
    if (await agentGone(this.db, viewer.networkId, viewer.userId, this.now())) return { ok: false, rule: 'R86', code: 'agent_parti' };
    return { ok: true, value: null };
  }

  /**
   * Une nouvelle version des réglages : elle vaut à partir du lendemain (heure de Paris), jamais pour un jour commencé
   * ; les créneaux réservés sous une version remplacée ne passent plus [R581].
   */
  async setRules(viewer: Viewer, input: { perDay: unknown; hours: unknown }): Promise<CalendarResult<CalendarRules>> {
    const me = await this.self(viewer);
    if (!me.ok) return me;
    const bad = (code: string): CalendarResult<CalendarRules> => ({ ok: false, rule: 'R581', code });
    if (!Array.isArray(input.hours) || input.hours.length < 1 || input.hours.length > MAX_PER_DAY || input.hours.some((h) => typeof h !== 'string' || !HOUR.test(h))) return bad('heures_invalides');
    const hours = [...(input.hours as string[])];
    for (let i = 1; i < hours.length; i++) if (hours[i]! <= hours[i - 1]!) return bad('heures_invalides');
    if (typeof input.perDay !== 'object' || input.perDay === null || Array.isArray(input.perDay)) return bad('nombres_invalides');
    const given = input.perDay as Record<string, unknown>;
    if (Object.keys(given).some((k) => !(SOCIAL_CHANNELS as readonly string[]).includes(k))) return bad('reseau_inconnu');
    const perDay = {} as Record<SocialChannelName, number>;
    for (const c of SOCIAL_CHANNELS) {
      const n = given[c] ?? 0;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > hours.length) return bad('nombres_invalides');
      perDay[c] = n;
    }
    const last = await this.db.first<{ v: number | null }>('SELECT max(version) AS v FROM social_calendar_rules WHERE agent_id = ?', [viewer.userId]);
    const version = Number(last?.v ?? 0) + 1;
    const effectiveDay = addDays(this.today(), 1);
    const { changes } = await this.db.run(
      `INSERT INTO social_calendar_rules (id, network_id, agent_id, version, instagram, facebook, linkedin, google, tiktok, youtube, hours, effective_day, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      [this.newId(), viewer.networkId, viewer.userId, version, perDay.instagram, perDay.facebook, perDay.linkedin, perDay.google, perDay.tiktok, perDay.youtube, JSON.stringify(hours), effectiveDay, this.now().toISOString()],
    );
    if (changes !== 1) return bad('version_concurrente');
    await appendEvent(this.journal, { type: 'marketing.calendrier.reglage', actor: `agent:${viewer.userId}`, subject: `agent:${viewer.userId}`, data: { version, effectiveDay, rule: 'R581' } }, this.now);
    return { ok: true, value: { version, perDay, hours, effectiveDay } };
  }

  /** La version en vigueur un jour donné : la plus récente qui vaut déjà ce jour-là. */
  private async inForce(agentId: string, day: string): Promise<RulesRow | null> {
    return this.db.first<RulesRow>('SELECT * FROM social_calendar_rules WHERE agent_id = ? AND effective_day <= ? ORDER BY version DESC LIMIT 1', [agentId, day]);
  }

  /** Les réglages en vigueur aujourd'hui, et la prochaine version si elle n'a pas encore commencé. */
  async rules(viewer: Viewer): Promise<CalendarResult<{ today: CalendarRules | null; next: CalendarRules | null }>> {
    const me = await this.self(viewer);
    if (!me.ok) return me;
    const today = await this.inForce(viewer.userId, this.today());
    const latest = await this.db.first<RulesRow>('SELECT * FROM social_calendar_rules WHERE agent_id = ? ORDER BY version DESC LIMIT 1', [viewer.userId]);
    return { ok: true, value: { today: today ? rulesOf(today) : null, next: latest && latest.id !== today?.id ? rulesOf(latest) : null } };
  }

  /**
   * Réserve les créneaux d'une semaine, jour par jour, à partir d'un jour (aujourd'hui ou plus tard, deux semaines au
   * plus) : les contenus prêts de la semaine. Rejoué, rien de plus n'est réservé au-delà du nombre réglé [R581].
   */
  async planWeek(viewer: Viewer, from: unknown): Promise<CalendarResult<CalendarSlot[]>> {
    const me = await this.self(viewer);
    if (!me.ok) return me;
    if (!validDay(from)) return { ok: false, rule: 'R10', code: 'jour_invalide' };
    const today = this.today();
    if (from < today || from > addDays(today, MAX_DAYS_AHEAD)) return { ok: false, rule: 'R10', code: 'jour_hors_calendrier' };
    const last = [addDays(from, 6), addDays(today, MAX_DAYS_AHEAD)].sort()[0]!;
    // Toujours dans l'ordre des jours, depuis aujourd'hui : un jour n'est jamais réservé avant un jour plus proche,
    // pour que la rotation suive l'ordre où les biens sortiront [R580].
    for (let day = today; day <= last; day = addDays(day, 1)) await this.planDay(viewer, day);
    return this.slots(viewer, from, last);
  }

  /** Les créneaux d'un jour, réseau par réseau, rang par rang, en rotation stricte [R580]. */
  private async planDay(viewer: Viewer, day: string): Promise<void> {
    const rules = await this.inForce(viewer.userId, day);
    if (!rules) return;
    const hours = JSON.parse(rules.hours) as string[];
    for (const channel of SOCIAL_CHANNELS) {
      const n = rules[channel];
      for (let rank = 0; rank < n; rank++) {
        const due = parisInstant(day, hours[rank]!);
        if (due.getTime() <= this.now().getTime()) continue;
        const booked = await this.book(viewer, rules.id, day, channel, rank, due);
        if (booked === 'aucun_contenu') break;
      }
    }
    await appendEvent(this.journal, { type: 'marketing.calendrier.jour', actor: `agent:${viewer.userId}`, subject: `agent:${viewer.userId}`, data: { day, version: rules.version, rule: 'R580' } }, this.now);
  }

  /**
   * Réserve un rang d'un jour. Deux planifications du même agent peuvent tourner en même temps, sans transaction : une
   * réservation qui ne change rien est relue. Rang pris par l'autre : rien de plus, aucun doublon. Rang encore libre :
   * la publication choisie vient d'être réservée ailleurs sous cette version, le choix est refait pour ce même rang,
   * rotation à jour. Chaque nouvel essai écarte une publication de plus (désormais réservée), la boucle finit donc
   * toujours [R580, R581].
   */
  private async book(viewer: Viewer, rulesId: string, day: string, channel: SocialChannelName, rank: number, due: Date): Promise<'reserve' | 'pris' | 'aucun_contenu'> {
    for (;;) {
      const taken = await this.db.first<{ id: string }>('SELECT id FROM social_calendar_slots WHERE rules_id = ? AND day = ? AND channel = ? AND rank = ?', [rulesId, day, channel, rank]);
      if (taken) return 'pris';
      const pick = await this.pick(viewer, channel, rulesId);
      if (!pick) return 'aucun_contenu';
      const { changes } = await this.db.run(
        `INSERT INTO social_calendar_slots (id, network_id, agent_id, rules_id, day, channel, rank, post_id, property_id, due_at, booked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        [this.newId(), viewer.networkId, viewer.userId, rulesId, day, channel, rank, pick.postId, pick.propertyId, due.toISOString(), this.now().toISOString()],
      );
      if (changes === 1) return 'reserve';
      // Ni le rang ni la publication pris par l'autre (un identifiant déjà vu) : on n'insiste pas, la planification
      // suivante remplira ce rang.
      const elsewhere = await this.db.first<{ id: string }>('SELECT id FROM social_calendar_slots WHERE rules_id = ? AND post_id = ? AND channel = ?', [rulesId, pick.postId, channel]);
      if (!elsewhere) return 'pris';
    }
  }

  /**
   * Le bien du prochain créneau d'un réseau. Un bien est prêt quand il a une publication prête pour ce réseau, que la
   * porte de diffusion est ouverte et que son lien marqué existe [R42, R582]. Parmi les biens prêts : un de ceux qui
   * sont le moins sortis ; à égalité, celui qui est sorti le plus tôt, et parmi les jamais sortis le plus récent
   * [R580].
   */
  private async pick(viewer: Viewer, channel: SocialChannelName, rulesId: string): Promise<{ postId: string; propertyId: string } | null> {
    const ready = await this.readyPosts(viewer, channel, rulesId);
    if (ready.length === 0) return null;
    const out = await this.outings(viewer.userId, channel);
    const byProperty = new Map<string, { postId: string; createdAt: string }>();
    for (const r of ready) if (!byProperty.has(r.property_id)) byProperty.set(r.property_id, { postId: r.post_id, createdAt: r.property_created_at });
    const candidates: { propertyId: string; postId: string; createdAt: string; count: number; lastAt: string }[] = [];
    for (const [propertyId, v] of byProperty) {
      if (!(await this.deps.diffusion.canDiffuse(viewer.networkId, propertyId, this.now())).allowed) continue;
      let link: { link: string | null } | null = null;
      try {
        link = await this.deps.links.studioLink(viewer.networkId, 'publication', v.postId, propertyId);
      } catch (error) {
        // Une panne de l'origine n'est pas « aucun contenu prêt » : elle est écrite au journal, sans donnée.
        await appendEvent(this.journal, { type: 'marketing.calendrier.lien_indisponible', actor: `agent:${viewer.userId}`, subject: `property:${propertyId}`, data: { channel, rule: 'R582', error: error instanceof Error ? error.name : 'inconnue' } }, this.now);
        link = null;
      }
      if (!link?.link) continue;
      candidates.push({ propertyId, postId: v.postId, createdAt: v.createdAt, count: out.get(propertyId)?.count ?? 0, lastAt: out.get(propertyId)?.lastAt ?? '' });
    }
    candidates.sort((a, b) => a.count - b.count || (a.lastAt < b.lastAt ? -1 : a.lastAt > b.lastAt ? 1 : 0) || (a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 : 0) || (a.propertyId < b.propertyId ? -1 : 1));
    const first = candidates[0];
    return first ? { postId: first.postId, propertyId: first.propertyId } : null;
  }

  /**
   * Les publications prêtes d'un réseau : validées, d'un bien encore à l'agent dans l'état que l'événement exige,
   * jamais parties sur ce réseau depuis le compte de l'agent, ni réservées sur un créneau en attente, ni déjà réservées
   * sous la version en vigueur.
   */
  private async readyPosts(viewer: Viewer, channel: SocialChannelName, rulesId: string): Promise<{ post_id: string; property_id: string; property_created_at: string }[]> {
    const rows = await this.db.all<{ post_id: string; property_id: string; property_created_at: string; event: SocialEvent; status: PropertyStatus }>(
      `SELECT s.id AS post_id, s.property_id, p.created_at AS property_created_at, s.event, p.status
       FROM social_posts s
       JOIN social_post_validations v ON v.post_id = s.id
       JOIN properties p ON p.id = s.property_id AND p.network_id = s.network_id
       WHERE s.network_id = ? AND p.agent_id = ?
         AND NOT EXISTS (SELECT 1 FROM social_post_attempts a JOIN social_post_sends d ON d.attempt_id = a.id
                         WHERE a.post_id = s.id AND a.channel = ? AND a.account = 'agent' AND d.outcome = 'envoye')
         -- Une vraie publication (AU036) compte comme un essai réussi : elle est sortie.
         AND NOT EXISTS (SELECT 1 FROM social_live_attempts a JOIN social_live_sends d ON d.attempt_id = a.id
                         WHERE a.post_id = s.id AND a.channel = ? AND a.account = 'agent' AND d.outcome = 'envoye')
         -- Déjà réservée sous cette version sur ce réseau (même passée, manquée ou en échec) : la base ne la reprendrait pas.
         AND NOT EXISTS (SELECT 1 FROM social_calendar_slots k WHERE k.rules_id = ? AND k.post_id = s.id AND k.channel = ?)
       ORDER BY v.validated_at DESC, s.id`,
      [viewer.networkId, viewer.userId, channel, channel, rulesId, channel],
    );
    const pending = new Set((await this.pendingSlots(viewer.userId, channel)).map((s) => s.post_id));
    return rows.filter((r) => EVENT_STATUSES[r.event].includes(r.status) && !pending.has(r.post_id));
  }

  /** Les créneaux encore à passer d'un réseau, sous la version en vigueur de leur jour. */
  private async pendingSlots(agentId: string, channel: SocialChannelName): Promise<SlotRow[]> {
    const rows = await this.db.all<SlotRow>(
      `SELECT c.*, o.outcome, o.code, r.claimed_at AS claimed FROM social_calendar_slots c
       LEFT JOIN social_calendar_runs r ON r.slot_id = c.id LEFT JOIN social_calendar_outcomes o ON o.slot_id = c.id
       WHERE c.agent_id = ? AND c.channel = ? AND r.slot_id IS NULL AND c.due_at > ?`,
      [agentId, channel, new Date(this.now().getTime() - LATE_MS).toISOString()],
    );
    const out: SlotRow[] = [];
    for (const r of rows) if ((await this.inForce(agentId, r.day))?.id === r.rules_id) out.push(r);
    return out;
  }

  /**
   * Les sorties de chaque bien sur un réseau, depuis le compte de l'agent : chaque publication partie, par le
   * calendrier ou à la main, et chaque créneau en attente, quel que soit son jour.
   */
  private async outings(agentId: string, channel: SocialChannelName): Promise<Map<string, { count: number; lastAt: string }>> {
    const sent = await this.db.all<{ property_id: string; at: string }>(
      `SELECT s.property_id, min(d.at) AS at FROM (
         SELECT a.post_id, a.claimed_by, a.channel, a.account, d.outcome, d.done_at AS at FROM social_post_attempts a JOIN social_post_sends d ON d.attempt_id = a.id
         UNION ALL
         SELECT a.post_id, a.claimed_by, a.channel, a.account, d.outcome, d.done_at AS at FROM social_live_attempts a JOIN social_live_sends d ON d.attempt_id = a.id
       ) d JOIN social_posts s ON s.id = d.post_id
       WHERE d.claimed_by = ? AND d.channel = ? AND d.account = 'agent' AND d.outcome = 'envoye'
       GROUP BY s.id, s.property_id`,
      // Les sorties de cet agent-là, depuis son compte, essais et vraies publications (AU036) : celles d'un ancien
      // agent du bien ne comptent pas pour lui.
      [`agent:${agentId}`, channel],
    );
    const pending = (await this.pendingSlots(agentId, channel)).map((s) => ({ property_id: s.property_id, at: s.due_at }));
    const out = new Map<string, { count: number; lastAt: string }>();
    for (const r of [...sent, ...pending]) {
      const cur = out.get(r.property_id) ?? { count: 0, lastAt: '' };
      out.set(r.property_id, { count: cur.count + 1, lastAt: r.at > cur.lastAt ? r.at : cur.lastAt });
    }
    return out;
  }

  /** Les créneaux de l'agent sur une période, sous la version en vigueur de leur jour, avec leur issue. */
  async slots(viewer: Viewer, from: unknown, to: unknown): Promise<CalendarResult<CalendarSlot[]>> {
    const me = await this.self(viewer);
    if (!me.ok) return me;
    if (!validDay(from) || !validDay(to) || to < from || to > addDays(from, 31)) return { ok: false, rule: 'R10', code: 'periode_invalide' };
    const rows = await this.db.all<SlotRow>(
      `SELECT c.*, o.outcome, o.code, r.claimed_at AS claimed, p.reference AS property_reference FROM social_calendar_slots c
       LEFT JOIN social_calendar_runs r ON r.slot_id = c.id LEFT JOIN social_calendar_outcomes o ON o.slot_id = c.id
       LEFT JOIN properties p ON p.id = c.property_id AND p.network_id = c.network_id
       WHERE c.agent_id = ? AND c.network_id = ? AND c.day BETWEEN ? AND ? ORDER BY c.due_at, c.channel, c.rank`,
      [viewer.userId, viewer.networkId, from, to],
    );
    const value: CalendarSlot[] = [];
    for (const r of rows) {
      if ((await this.inForce(viewer.userId, r.day))?.id !== r.rules_id) continue;
      const late = r.claimed === null && Date.parse(r.due_at) <= this.now().getTime() - LATE_MS;
      value.push({ id: r.id, day: r.day, channel: r.channel, rank: r.rank, dueAt: r.due_at, postId: r.post_id, propertyId: r.property_id, propertyReference: r.property_reference ?? null, outcome: r.outcome ?? (late ? 'manque' : null), reason: r.outcome === 'refuse' ? (REASONS[r.code ?? ''] ?? 'controle') : null });
    }
    return { ok: true, value };
  }

  /**
   * Le passage des créneaux dus d'un réseau (travail planifié) : chacun une seule fois, réservé avant d'appeler le
   * chemin de publication de X05, seul à parler aux réseaux, en mode essai [R582, R134, R26]. Un créneau dû depuis
   * plus de deux heures est manqué : il ne part jamais en retard.
   */
  async runDue(networkId: string): Promise<{ passed: number }> {
    const now = this.now();
    const rows = await this.db.all<SlotRow>(
      `SELECT c.*, NULL AS outcome, NULL AS code, NULL AS claimed FROM social_calendar_slots c
       LEFT JOIN social_calendar_runs r ON r.slot_id = c.id
       WHERE c.network_id = ? AND r.slot_id IS NULL AND c.due_at <= ? AND c.due_at > ? ORDER BY c.due_at, c.channel, c.rank`,
      [networkId, now.toISOString(), new Date(now.getTime() - LATE_MS).toISOString()],
    );
    let passed = 0;
    for (const slot of rows) {
      if ((await this.inForce(slot.agent_id, slot.day))?.id !== slot.rules_id) continue;
      // L'heure est relue à chaque créneau : un passage lent ne fait jamais partir un créneau devenu manqué.
      if (this.late(slot)) continue;
      const { changes } = await this.db.run('INSERT INTO social_calendar_runs (slot_id, claimed_at) VALUES (?, ?) ON CONFLICT DO NOTHING', [slot.id, this.now().toISOString()]);
      if (changes !== 1) continue;
      passed++;
      await this.pass(slot);
    }
    return { passed };
  }

  private late(slot: SlotRow): boolean {
    return Date.parse(slot.due_at) <= this.now().getTime() - LATE_MS;
  }

  private async pass(slot: SlotRow): Promise<void> {
    const done = async (outcome: 'envoye' | 'echec' | 'refuse', rule: string | null, code: string | null): Promise<void> => {
      await this.db.run('INSERT INTO social_calendar_outcomes (slot_id, outcome, rule, code, done_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING', [slot.id, outcome, rule, code, this.now().toISOString()]);
      await appendEvent(
        this.journal,
        { type: 'marketing.calendrier.passage', actor: 'system:calendrier', subject: `property:${slot.property_id}`, data: { slot: slot.id, post: slot.post_id, channel: slot.channel, outcome, rule: rule ?? 'R582', ...(code ? { code } : {}) } },
        this.now,
      );
    };
    if (await agentGone(this.db, slot.network_id, slot.agent_id, this.now())) return done('refuse', 'R86', 'agent_parti');
    // Le lien marqué est relu juste avant : sans page en ligne, la publication ne part pas sans son origine [R582, R156].
    let link: { link: string | null } | null = null;
    try {
      link = await this.deps.links.studioLink(slot.network_id, 'publication', slot.post_id, slot.property_id);
    } catch {
      link = null;
    }
    if (!link?.link) return done('refuse', 'R582', 'sans_lien');
    if (this.late(slot)) return done('refuse', 'R582', 'manque');
    const viewer = { role: 'agent', networkId: slot.network_id, userId: slot.agent_id } as Viewer;
    let r: PostResult<SocialPost>;
    try {
      r = await this.deps.gate.publish(viewer, slot.post_id, [{ channel: slot.channel, account: 'agent' }], { requireLink: true });
    } catch {
      return done('echec', null, null);
    }
    if (!r.ok) return done('refuse', r.rule, r.code);
    const send = r.value.sends.find((s) => s.channel === slot.channel && s.account === 'agent');
    return done(send?.outcome === 'envoye' ? 'envoye' : 'echec', null, null);
  }
}
