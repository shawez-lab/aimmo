/**
 * Carte des opportunités et tournée de prospection (HX19) [R297, R298, R299].
 *
 * - La carte des opportunités d'un agent en activité ne montre que ce qui est dans les communes de ses zones en cours :
 *   les panneaux à récupérer de HX14 (tâche rangée, pas encore récupéré), les lettres de G06 pas encore déposées, et
 *   les nouveaux diagnostics de HX16 de ses secteurs suivis. Ce qui est hors de ses zones est compté, jamais montré.
 *   Aucun nom, aucun propriétaire ; rien n'est envoyé [R297].
 * - Chaque lieu connu porte un lien vers la vue des rues : la seule position arrondie, sans clé, sans adresse, sans
 *   nom ni référence [R299].
 * - Jamais vu : une seule tournée du jour mêle les rendez-vous déjà pris (fixes), les panneaux, les lettres et les
 *   diagnostics, calée dans les créneaux libres de V01 : chaque arrêt tient dans les disponibilités de l'agent, hors de
 *   ses rendez-vous (trajet minimal de R32 compris) et de ses événements occupés [R33], et laisse le temps de route
 *   estimé depuis l'arrêt d'avant et jusqu'au rendez-vous d'après. Ce qui ne tient pas est dit, avec sa raison. C'est une
 *   proposition : rien n'est réservé ni envoyé [R298].
 * - Au journal : des comptes, jamais une adresse [R13].
 */
import type { Viewer } from '../acces/droits.ts';
import { agentState } from '../acces/etat-agent.ts';
import { communeSlug } from '../attirer/liste-biens.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import type { Geocoder } from '../estimation/collecte.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { dayInFrench } from '../location/logement.ts';
import { LETTER_MIN_GEOCODE_SCORE } from '../mandats/gagner/lettres-quartier.ts';
import {
  AGENDA_TIME_ZONE,
  DEFAULT_SLOT_SETTINGS,
  conflictOf,
  isOnSite,
  parisInstant,
  withinAvailability,
  type AppointmentKind,
  type Availability,
  type BookedInterval,
  type BusySource,
  type Interval,
  type SlotSettings,
} from '../rendezvous/creneaux.ts';
import { roadEstimate, validPlace, type Place, type PlaceSource, type TravelEstimator } from '../rendezvous/trajets.ts';

export const PROSPECT_KINDS = ['panneau', 'lettres', 'diagnostic'] as const;
export type ProspectKind = (typeof PROSPECT_KINDS)[number];

export interface ProspectSettings {
  /** Minutes pour récupérer un panneau. */
  pickupMinutes: number;
  /** Minutes par lettre à déposer, et bornes du temps d'un lot de lettres. */
  letterMinutes: number;
  lettersMinMinutes: number;
  lettersMaxMinutes: number;
  /** Minutes de porte-à-porte pour un nouveau diagnostic. */
  doorMinutes: number;
  /** Les diagnostics remontés par la veille dans ces derniers jours. */
  diagnosisDays: number;
  /** Arrêts de prospection étudiés au plus pour une tournée. */
  maxStops: number;
  /** Les arrêts commencent sur des tranches de ces minutes. */
  stepMinutes: number;
}

export const DEFAULT_PROSPECT_SETTINGS: ProspectSettings = Object.freeze({
  pickupMinutes: 10,
  letterMinutes: 2,
  lettersMinMinutes: 5,
  lettersMaxMinutes: 60,
  doorMinutes: 10,
  diagnosisDays: 14,
  maxStops: 30,
  stepMinutes: 5,
});

/** Une opportunité de la carte : jamais un nom, jamais un propriétaire [R297]. */
export interface Opportunity {
  /** `panneau:<pose>`, `lettres:<campagne>` ou `diagnostic:<diagnostic>`. */
  id: string;
  kind: ProspectKind;
  town: string;
  /** Les adresses à visiter, toutes dans les zones de l'agent. */
  addresses: string[];
  place: Place | null;
  /** Le lien vers la vue des rues, ou `null` sans position [R299]. */
  streetView: string | null;
  minutes: number;
  detail: string;
}

export interface OpportunityMap {
  ok: true;
  opportunities: Opportunity[];
  /** Combien d'opportunités de l'agent sont hors de ses zones : comptées, jamais montrées [R297]. */
  outsideZone: number;
}

export interface Refusal {
  ok: false;
  rule: 'R16' | 'R298';
  code: string;
}

/** Un arrêt de la tournée : un rendez-vous déjà pris (fixe), ou un arrêt de prospection proposé. */
export type TourStop =
  | { kind: 'rendez-vous'; appointmentKind: AppointmentKind; start: Date; end: Date; town: string | null }
  | { kind: ProspectKind; opportunityId: string; start: Date; end: Date; travelMinutes: number; town: string; addresses: string[]; streetView: string | null; detail: string };

export interface LeftOut {
  opportunityId: string;
  kind: ProspectKind;
  reason: 'lieu_inconnu' | 'pas_de_place';
}

export interface Tour {
  ok: true;
  date: string;
  stops: TourStop[];
  left: LeftOut[];
  outsideZone: number;
  /** Minutes de route estimées entre les arrêts de prospection et leurs voisins. */
  travelMinutes: number;
}

export interface TourneeProspectionOptions {
  now?: () => Date;
  settings?: SlotSettings;
  prospect?: ProspectSettings;
  /** Les événements occupés de l'agenda (V03). */
  agenda?: BusySource;
  /** La position des biens des rendez-vous ; absente, le trajet minimal de R32 seul vaut autour d'eux. */
  places?: PlaceSource;
  /** Le géocodage des adresses des panneaux (Base adresse nationale) ; absent, leur lieu est inconnu. */
  geocoder?: Geocoder;
  estimate?: TravelEstimator;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MINUTE = 60_000;

const validDate = (date: unknown): date is string => {
  if (typeof date !== 'string' || !DATE.test(date)) return false;
  const d = new Date(`${date}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
};
const addDays = (date: string, days: number): string => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

/**
 * Le lien vers la vue des rues d'un lieu : la seule position, arrondie au mètre près, sans clé ni rien d'autre [R299].
 * `null` pour une position non valable.
 */
export function streetViewLink(place: Place | null | undefined): string | null {
  if (!validPlace(place)) return null;
  return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${place.lat.toFixed(5)},${place.lon.toFixed(5)}`;
}

const addressLine = (number: string | null, street: string, postcode: string, city: string): string =>
  `${number ? `${number.trim()} ` : ''}${street.trim()}, ${postcode} ${city.trim()}`;

interface Fixed {
  appointmentKind: AppointmentKind;
  start: Date;
  end: Date;
  town: string | null;
  place: Place | null;
}

/** Ce qui précède ou suit un arrêt, pour compter la route. */
interface Neighbour {
  end: Date;
  start: Date;
  place: Place | null;
  /** Un rendez-vous déjà pris : le trajet minimal de R32 vaut toujours. */
  booked: boolean;
}

export class TourneeProspection {
  private readonly now: () => Date;
  private readonly settings: SlotSettings;
  private readonly prospect: ProspectSettings;
  private readonly estimate: TravelEstimator;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly options: TourneeProspectionOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.settings = options.settings ?? DEFAULT_SLOT_SETTINGS;
    this.prospect = options.prospect ?? DEFAULT_PROSPECT_SETTINGS;
    this.estimate = options.estimate ?? roadEstimate;
  }

  private async refuse(viewer: Viewer, code: string): Promise<Refusal> {
    await appendEvent(
      this.journal,
      { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: null, data: { rule: 'R16', role: String(viewer.role), kind: 'tournee_prospection', code } },
      this.now,
    );
    return { ok: false, rule: 'R16', code };
  }

  /** Seul un agent du réseau en activité a une carte et une tournée : elles sont les siennes [R16, R297]. */
  private async blocked(viewer: Viewer): Promise<Refusal | null> {
    if (viewer.role !== 'agent') return this.refuse(viewer, 'role');
    const a = await this.db.first<{ id: string }>('SELECT id FROM agents WHERE id = ? AND network_id = ?', [viewer.userId, viewer.networkId]);
    if (!a || (await agentState(this.db, viewer.networkId, viewer.userId, this.now())) !== 'actif') return this.refuse(viewer, 'agent_inactive');
    return null;
  }

  private async zoneSlugs(viewer: Viewer): Promise<Set<string>> {
    const rows = await this.db.all<{ commune: string }>('SELECT commune FROM agent_zones WHERE network_id = ? AND agent_id = ? AND ended_at IS NULL', [viewer.networkId, viewer.userId]);
    return new Set(rows.map((r) => communeSlug(r.commune)));
  }

  private lettersMinutes(count: number): number {
    const p = this.prospect;
    return Math.min(p.lettersMaxMinutes, Math.max(p.lettersMinMinutes, count * p.letterMinutes));
  }

  private async signPlace(number: string, street: string, postcode: string, city: string): Promise<Place | null> {
    if (!this.options.geocoder) return null;
    try {
      const g = await this.options.geocoder.geocode(`${number} ${street} ${postcode} ${city}`);
      if (!g || g.score < LETTER_MIN_GEOCODE_SCORE || g.postalCode !== postcode || communeSlug(g.town) !== communeSlug(city)) return null;
      const place = { lat: g.lat, lon: g.lon };
      return validPlace(place) ? place : null;
    } catch {
      // Un géocodage en panne laisse le lieu inconnu ; l'arrêt est dit « lieu inconnu », jamais placé au hasard.
      return null;
    }
  }

  /** Les opportunités de l'agent, celles de ses zones montrées, les autres comptées [R297]. */
  private async collect(viewer: Viewer, date: string): Promise<{ opportunities: Opportunity[]; outsideZone: number }> {
    const zones = await this.zoneSlugs(viewer);
    const inZone = (city: string): boolean => zones.has(communeSlug(city));
    const opportunities: Opportunity[] = [];
    let outsideZone = 0;

    // Les panneaux à récupérer : tâche rangée par HX14, due au plus tard ce jour, panneau pas encore récupéré ni perdu.
    const signs = await this.db.all<{ id: string; number: number; reason: 'vendu' | 'fin_mandat'; street_number: string; street: string; postcode: string; city: string }>(
      `SELECT p.id, s.number, t.reason, p.street_number, p.street, p.postcode, p.city
       FROM sign_pickup_tasks t
       JOIN sign_placements p ON p.id = t.placement_id AND p.network_id = t.network_id
       JOIN signs s ON s.id = p.sign_id AND s.network_id = p.network_id
       WHERE t.network_id = ? AND t.agent_id = ? AND t.due_day <= ?
         AND NOT EXISTS (SELECT 1 FROM sign_removals r WHERE r.placement_id = p.id)
       ORDER BY t.due_day, s.number`,
      [viewer.networkId, viewer.userId, date],
    );
    for (const s of signs) {
      if (!inZone(s.city)) {
        outsideZone += 1;
        continue;
      }
      const place = await this.signPlace(s.street_number, s.street, s.postcode, s.city);
      opportunities.push({
        id: `panneau:${s.id}`,
        kind: 'panneau',
        town: s.city.trim(),
        addresses: [addressLine(s.street_number, s.street, s.postcode, s.city)],
        place,
        streetView: streetViewLink(place),
        minutes: this.prospect.pickupMinutes,
        detail: `Panneau n° ${s.number} à récupérer : ${s.reason === 'vendu' ? 'bien vendu' : 'fin du mandat'}.`,
      });
    }

    // Les lettres de G06 pas encore déposées, un lot par campagne, au centre de la campagne.
    const letters = await this.db.all<{ campaign_id: string; recipient: string; center_lat: number; center_lon: number; street_number: string; street: string; postcode: string; city: string }>(
      `SELECT c.id AS campaign_id, c.recipient, c.center_lat, c.center_lon, l.street_number, l.street, l.postcode, l.city
       FROM neighbourhood_letters l JOIN neighbourhood_campaigns c ON c.id = l.campaign_id AND c.network_id = l.network_id
       WHERE c.network_id = ? AND c.agent_id = ? AND l.deposited_at IS NULL
       ORDER BY c.created_at, c.id, l.position`,
      [viewer.networkId, viewer.userId],
    );
    const campaigns = new Map<string, typeof letters>();
    for (const l of letters) {
      if (!inZone(l.city)) {
        outsideZone += 1;
        continue;
      }
      campaigns.set(l.campaign_id, [...(campaigns.get(l.campaign_id) ?? []), l]);
    }
    for (const [id, list] of campaigns) {
      const first = list[0]!;
      const place = { lat: first.center_lat, lon: first.center_lon };
      const known = validPlace(place) ? place : null;
      const towns = [...new Set(list.map((l) => l.city.trim()))];
      opportunities.push({
        id: `lettres:${id}`,
        kind: 'lettres',
        town: towns.join(', '),
        addresses: list.map((l) => addressLine(l.street_number, l.street, l.postcode, l.city)),
        place: known,
        streetView: streetViewLink(known),
        minutes: this.lettersMinutes(list.length),
        detail: `${list.length} ${list.length > 1 ? 'lettres' : 'lettre'} ${first.recipient === 'aux_habitants' ? 'aux habitants' : 'au propriétaire'} à déposer.`,
      });
    }

    // Les nouveaux diagnostics de ses secteurs suivis, remontés ces derniers jours.
    const since = addDays(date, -this.prospect.diagnosisDays);
    const diagnoses = await this.db.all<{ id: string; energy_class: string; diagnosed_on: string; street_number: string | null; street: string; postcode: string; commune: string; lat: number | null; lon: number | null }>(
      `SELECT DISTINCT d.id, d.energy_class, d.diagnosed_on, d.street_number, d.street, d.postcode, d.commune, d.lat, d.lon
       FROM dpe_alert_items a
       JOIN dpe_watch_sectors s ON s.id = a.sector_id AND s.network_id = a.network_id
       JOIN dpe_diagnoses d ON d.id = a.diagnosis_id AND d.network_id = a.network_id
       WHERE s.network_id = ? AND s.agent_id = ? AND a.alerted_on >= ? AND a.alerted_on <= ?
         AND NOT EXISTS (SELECT 1 FROM dpe_watch_stops x WHERE x.sector_id = s.id)
       ORDER BY d.id`,
      [viewer.networkId, viewer.userId, since, date],
    );
    for (const d of diagnoses) {
      if (!inZone(d.commune)) {
        outsideZone += 1;
        continue;
      }
      const place = d.lat !== null && d.lon !== null ? { lat: d.lat, lon: d.lon } : null;
      const known = validPlace(place) ? place : null;
      opportunities.push({
        id: `diagnostic:${d.id}`,
        kind: 'diagnostic',
        town: d.commune.trim(),
        addresses: [addressLine(d.street_number, d.street, d.postcode, d.commune)],
        place: known,
        streetView: streetViewLink(known),
        minutes: this.prospect.doorMinutes,
        detail: `Nouveau diagnostic classé ${d.energy_class}, établi le ${dayInFrench(d.diagnosed_on)}.`,
      });
    }
    return { opportunities, outsideZone };
  }

  /** La carte des opportunités de l'agent, pour un jour (aujourd'hui par défaut) [R297, R299]. */
  async map(viewer: Viewer, date?: unknown): Promise<OpportunityMap | Refusal> {
    const blocked = await this.blocked(viewer);
    if (blocked) return blocked;
    const day = date === undefined ? localTime(this.now(), AGENDA_TIME_ZONE).date : date;
    if (!validDate(day)) return { ok: false, rule: 'R298', code: 'bad_date' };
    const { opportunities, outsideZone } = await this.collect(viewer, day);
    return { ok: true, opportunities, outsideZone };
  }

  /**
   * La tournée du jour : les rendez-vous déjà pris restent où ils sont ; les panneaux, les lettres et les diagnostics
   * sont placés, un par un, au plus tôt, dans le temps libre de l'agent, route comprise [R298]. Rien n'est réservé.
   * `base` est le point de départ de la journée (l'agence), s'il est connu.
   */
  async plan(viewer: Viewer, date: unknown, base: Place | null = null): Promise<Tour | Refusal> {
    const blocked = await this.blocked(viewer);
    if (blocked) return blocked;
    if (!validDate(date)) return { ok: false, rule: 'R298', code: 'bad_date' };
    const dayStart = parisInstant(date, 0);
    const dayEnd = parisInstant(addDays(date, 1), 0);
    if (!dayStart || !dayEnd) return { ok: false, rule: 'R298', code: 'bad_date' };

    const { opportunities, outsideZone } = await this.collect(viewer, date);
    const row = await this.db.first<{ availability: string }>('SELECT availability FROM agent_availabilities WHERE agent_id = ?', [viewer.userId]);
    const availability = row ? (JSON.parse(row.availability) as Availability) : null;

    // Les rendez-vous déjà pris de l'agent, autour du jour : fixes ; seuls ceux du jour sont montrés.
    const travel = this.settings.travelMinutes * MINUTE;
    const around = await this.db.all<{ kind: AppointmentKind; start_at: string; end_at: string; property_id: string | null; city: string | null }>(
      `SELECT a.kind, a.start_at, a.end_at, a.property_id, p.city FROM appointments a LEFT JOIN properties p ON p.id = a.property_id AND p.network_id = a.network_id
       WHERE a.agent_id = ? AND a.network_id = ? AND a.status = 'booked' AND a.start_at < ? AND a.end_at > ?
       ORDER BY a.start_at, a.id`,
      [viewer.userId, viewer.networkId, new Date(dayEnd.getTime() + travel).toISOString(), new Date(dayStart.getTime() - travel).toISOString()],
    );
    const fixed: Fixed[] = [];
    for (const r of around) {
      let place: Place | null = null;
      if (r.property_id && this.options.places && isOnSite(r.kind)) {
        try {
          const p = await this.options.places.placeOf(r.property_id);
          place = validPlace(p) ? p : null;
        } catch {
          place = null;
        }
      }
      fixed.push({ appointmentKind: r.kind, start: new Date(r.start_at), end: new Date(r.end_at), town: r.city?.trim() || null, place });
    }
    const booked: BookedInterval[] = fixed.map((f) => ({ kind: f.appointmentKind, start: f.start, end: f.end }));
    const busy: Interval[] = this.options.agenda ? await this.options.agenda.busy(viewer.userId, new Date(dayStart.getTime() - travel), new Date(dayEnd.getTime() + travel)) : [];
    const onSite = fixed.filter((f) => isOnSite(f.appointmentKind));

    const left: LeftOut[] = [];
    const candidates: Opportunity[] = [];
    for (const o of opportunities) {
      if (!o.place) left.push({ opportunityId: o.id, kind: o.kind, reason: 'lieu_inconnu' });
      else if (candidates.length >= this.prospect.maxStops) left.push({ opportunityId: o.id, kind: o.kind, reason: 'pas_de_place' });
      else candidates.push(o);
    }

    const floor = this.settings.travelMinutes;
    const step = this.prospect.stepMinutes * MINUTE;
    const chosen: { o: Opportunity; start: Date; end: Date; travel: number }[] = [];
    // L'arrêt d'avant : le dernier arrêt choisi ou rendez-vous sur place fini avant `start`, sinon le départ.
    const previous = (start: number): Neighbour | null => {
      const all: Neighbour[] = [
        ...onSite.map((f) => ({ start: f.start, end: f.end, place: f.place, booked: true })),
        ...chosen.map((c) => ({ start: c.start, end: c.end, place: c.o.place, booked: false })),
      ].filter((n) => n.end.getTime() <= start);
      all.sort((a, b) => a.end.getTime() - b.end.getTime());
      return all.at(-1) ?? null;
    };
    const following = (end: number): Fixed | null => onSite.filter((f) => f.start.getTime() >= end).sort((a, b) => a.start.getTime() - b.start.getTime())[0] ?? null;

    /** Le trajet d'avant, en minutes, si l'arrêt peut commencer à `start` ; `null` sinon. */
    const fits = (o: Opportunity, start: number): number | null => {
      const end = start + o.minutes * MINUTE;
      if (end > dayEnd.getTime()) return null;
      const interval = { start: new Date(start), end: new Date(end) };
      if (!availability || !withinAvailability(interval, availability)) return null;
      // Sur place : le trajet minimal de R32 autour des rendez-vous, et autour des événements occupés [R33].
      if (conflictOf({ kind: 'visite', ...interval }, booked, busy, this.settings) !== null) return null;
      // Ni chevauchement avec un arrêt déjà choisi.
      if (chosen.some((c) => c.start.getTime() < end && start < c.end.getTime())) return null;
      const prev = previous(start);
      const from = prev ? prev.place : base && validPlace(base) ? base : null;
      let before = from ? this.estimate(from, o.place!) : 0;
      if (prev?.booked) before = Math.max(before, floor);
      if (prev && start < prev.end.getTime() + before * MINUTE) return null;
      const next = following(end);
      if (next) {
        const after = Math.max(floor, next.place ? this.estimate(o.place!, next.place) : floor);
        if (next.start.getTime() < end + after * MINUTE) return null;
      }
      return before;
    };

    // Au plus tôt : la tournée ne commence pas avant maintenant, alignée sur une tranche.
    const earliest = Math.max(dayStart.getTime(), this.now().getTime());
    let cursor = dayStart.getTime() + Math.ceil((earliest - dayStart.getTime()) / step) * step;
    const remaining = [...candidates];
    const rank = (k: ProspectKind): number => PROSPECT_KINDS.indexOf(k);
    while (remaining.length > 0) {
      let best: { i: number; start: number; travel: number } | null = null;
      for (const [i, o] of remaining.entries()) {
        for (let s = cursor; s + o.minutes * MINUTE <= dayEnd.getTime(); s += step) {
          const t = fits(o, s);
          if (t === null) continue;
          const end = s + o.minutes * MINUTE;
          const b = best ? remaining[best.i]! : null;
          const bestEnd = best ? best.start + b!.minutes * MINUTE : Infinity;
          if (
            !best ||
            end < bestEnd ||
            (end === bestEnd && (t < best.travel || (t === best.travel && (rank(o.kind) < rank(b!.kind) || (o.kind === b!.kind && o.id < b!.id)))))
          ) {
            best = { i, start: s, travel: t };
          }
          break;
        }
      }
      if (!best) break;
      const o = remaining.splice(best.i, 1)[0]!;
      const start = new Date(best.start);
      const end = new Date(best.start + o.minutes * MINUTE);
      chosen.push({ o, start, end, travel: best.travel });
      cursor = end.getTime();
    }
    for (const o of remaining) left.push({ opportunityId: o.id, kind: o.kind, reason: 'pas_de_place' });

    const stops: TourStop[] = [
      ...fixed
        .filter((f) => localTime(f.start, AGENDA_TIME_ZONE).date === date)
        .map((f): TourStop => ({ kind: 'rendez-vous', appointmentKind: f.appointmentKind, start: f.start, end: f.end, town: f.town })),
      ...chosen.map(
        (c): TourStop => ({
          kind: c.o.kind,
          opportunityId: c.o.id,
          start: c.start,
          end: c.end,
          travelMinutes: c.travel,
          town: c.o.town,
          addresses: c.o.addresses,
          streetView: c.o.streetView,
          detail: c.o.detail,
        }),
      ),
    ].sort((a, b) => a.start.getTime() - b.start.getTime());

    const travelMinutes = chosen.reduce((sum, c) => sum + c.travel, 0);
    await appendEvent(
      this.journal,
      {
        type: 'prospection.tournee_proposee',
        actor: `agent:${viewer.userId}`,
        subject: `agent:${viewer.userId}`,
        data: {
          rule: 'R298',
          panneaux: chosen.filter((c) => c.o.kind === 'panneau').length,
          lettres: chosen.filter((c) => c.o.kind === 'lettres').length,
          diagnostics: chosen.filter((c) => c.o.kind === 'diagnostic').length,
          laisses: left.length,
          hors_zone: outsideZone,
        },
      },
      this.now,
    );
    return { ok: true, date, stops, left, outsideZone, travelMinutes };
  }
}
