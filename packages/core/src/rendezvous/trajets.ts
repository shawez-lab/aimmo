/**
 * Le meilleur créneau, trajets compris (HX02, « Jamais vu »).
 *
 * Parmi les créneaux libres (V01 : disponibilités [R33], aucun chevauchement, trajet minimal laissé [R32]), l'appli
 * propose d'abord ceux qui coûtent le moins de route à l'agent ce jour-là [R237] :
 *   - le trajet se compte depuis le rendez-vous sur place qui précède (ou l'agence, en début de tournée) jusqu'au
 *     nouveau bien, puis du nouveau bien au rendez-vous qui suit (ou l'agence) ; on retire le trajet direct qu'il aurait
 *     fait sans lui ;
 *   - un créneau dont le trajet estimé ne tient pas dans l'écart avec le rendez-vous voisin n'est pas proposé : le
 *     trajet réel ne descend jamais sous le trajet minimal de R32, il peut seulement l'allonger ;
 *   - au même bien que le rendez-vous voisin, la marge du même lieu remplace le trajet minimal (AU055) ;
 *   - un lieu inconnu (bien sans position) ne fait rien inventer : le créneau reste proposé, après les autres, avec la
 *     règle du trajet minimal seule, et le dit.
 * L'estimation est faite à vol d'oiseau, majorée pour la route, sans service extérieur ni adresse envoyée. Le motif
 * donné à l'agent ne porte que des minutes, jamais une adresse ni un nom [R09].
 */
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { AGENDA_TIME_ZONE, DEFAULT_SLOT_SETTINGS, gapMinutes, isOnSite, type AppointmentKind, type Slot, type SlotSettings } from './creneaux.ts';

export interface Place {
  lat: number;
  lon: number;
}

/** La position d'un bien, ou `null` si elle n'est pas connue. */
export interface PlaceSource {
  placeOf(propertyId: string): Promise<Place | null>;
}

/** Le temps de route estimé entre deux lieux, en minutes. */
export type TravelEstimator = (from: Place, to: Place) => number;

/** Coefficient de détour de la route sur le vol d'oiseau, vitesse moyenne en ville et alentours, et temps pour se garer. */
export const TRAVEL_DETOUR = 1.3;
export const TRAVEL_KMH = 35;
export const TRAVEL_PARKING_MINUTES = 5;

/** Distance à vol d'oiseau, en kilomètres. */
export function distanceKm(a: Place, b: Place): number {
  const r = 6371;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Estimation par défaut : vol d'oiseau majoré, plus le temps de se garer, arrondi aux 5 minutes au-dessus. Le même lieu : 0. */
export const roadEstimate: TravelEstimator = (from, to) => {
  const km = distanceKm(from, to);
  if (km < 0.05) return 0;
  return Math.ceil(((km * TRAVEL_DETOUR) / TRAVEL_KMH) * 60 / 5 + TRAVEL_PARKING_MINUTES / 5) * 5;
};

export const validPlace = (p: Place | null | undefined): p is Place =>
  !!p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;

export interface RankedSlot extends Slot {
  /** Minutes de route ajoutées à la journée par ce créneau ; `null` si un lieu manque. */
  addedMinutes: number | null;
  /** Minutes depuis le rendez-vous précédent (ou l'agence), et vers le suivant ; `null` si inconnu. */
  travelBefore: number | null;
  travelAfter: number | null;
  /** Le motif en une ligne : des minutes seulement. */
  reason: string;
}

export interface BestSlotsInput {
  agentId: string;
  kind: AppointmentKind;
  /** Le lieu du nouveau rendez-vous ; `null` s'il est inconnu. */
  target: Place | null;
  /** Le bien du nouveau rendez-vous, s'il est connu (AU055). */
  propertyId?: string | null;
  /** Les créneaux libres, déjà vérifiés par V01. */
  free: readonly Slot[];
  /** Le point de départ et de retour de la journée (l'agence), s'il est connu. */
  base?: Place | null;
  settings?: SlotSettings;
  estimate?: TravelEstimator;
  /** Combien de créneaux rendre. */
  limit?: number;
}

interface Neighbour {
  start: Date;
  end: Date;
  place: Place | null;
  kind: AppointmentKind;
  propertyId: string | null;
}

const MINUTE = 60_000;
const dayOf = (d: Date): string => localTime(d, AGENDA_TIME_ZONE).date;

/** Classe les créneaux libres par minutes de route ajoutées, à partir des rendez-vous sur place de l'agent [R237]. */
export class MeilleursCreneaux {
  constructor(
    private readonly db: SqlDatabase,
    private readonly places: PlaceSource,
  ) {}

  private async onSiteOf(agentId: string, from: Date, to: Date): Promise<Neighbour[]> {
    const rows = await this.db.all<{ kind: AppointmentKind; start_at: string; end_at: string; property_id: string | null }>(
      "SELECT kind, start_at, end_at, property_id FROM appointments WHERE agent_id = ? AND status = 'booked' AND start_at < ? AND end_at > ? ORDER BY start_at",
      [agentId, to.toISOString(), from.toISOString()],
    );
    const out: Neighbour[] = [];
    for (const r of rows) {
      if (!isOnSite(r.kind)) continue;
      const place = r.property_id ? await this.places.placeOf(r.property_id) : null;
      out.push({ start: new Date(r.start_at), end: new Date(r.end_at), place: validPlace(place) ? place : null, kind: r.kind, propertyId: r.property_id });
    }
    return out;
  }

  async rank(input: BestSlotsInput): Promise<RankedSlot[]> {
    const settings = input.settings ?? DEFAULT_SLOT_SETTINGS;
    const estimate = input.estimate ?? roadEstimate;
    const limit = input.limit ?? 3;
    const target = validPlace(input.target) ? input.target : null;
    const base = validPlace(input.base) ? input.base : null;
    if (input.free.length === 0) return [];
    // Un appel se fait à distance : aucune route, les créneaux restent dans l'ordre.
    if (!isOnSite(input.kind)) {
      return input.free.slice(0, limit).map((s) => ({ ...s, addedMinutes: 0, travelBefore: null, travelAfter: null, reason: 'Appel : aucun trajet.' }));
    }
    const from = new Date(Math.min(...input.free.map((s) => s.start.getTime())) - 86_400_000);
    const to = new Date(Math.max(...input.free.map((s) => s.end.getTime())) + 86_400_000);
    const booked = await this.onSiteOf(input.agentId, from, to);
    const floor = settings.travelMinutes;
    const self = { kind: input.kind, propertyId: input.propertyId ?? null };
    // Le trajet minimal avec un voisin : la marge du même lieu au même bien (AU055), sinon celui de R32.
    const floorWith = (n: Neighbour): number => gapMinutes(self, n, settings);
    const known: RankedSlot[] = [];
    const unknown: RankedSlot[] = [];
    for (const slot of input.free) {
      const day = dayOf(slot.start);
      const sameDay = booked.filter((b) => dayOf(b.start) === day);
      const prev = sameDay.filter((b) => b.end.getTime() <= slot.start.getTime()).at(-1) ?? null;
      const next = sameDay.find((b) => b.start.getTime() >= slot.end.getTime()) ?? null;
      const fromPlace = prev ? prev.place : base;
      const toPlace = next ? next.place : base;
      // Sans voisin et sans agence connue, ce côté ne coûte rien ; un voisin sans lieu rend le côté inconnu.
      const leg = (a: Place | null, b: Place | null, neighbour: Neighbour | null): number | null => {
        if (!target) return null;
        if (!neighbour && !base) return 0;
        return a && b ? estimate(a, b) : null;
      };
      const before = leg(fromPlace, target, prev);
      const after = leg(target, toPlace, next);
      // Le trajet réel doit tenir dans l'écart avec le voisin ; jamais moins que le trajet minimal de R32.
      if (prev && before !== null && slot.start.getTime() - prev.end.getTime() < Math.max(floorWith(prev), before) * MINUTE) continue;
      if (next && after !== null && next.start.getTime() - slot.end.getTime() < Math.max(floorWith(next), after) * MINUTE) continue;
      if (before === null || after === null) {
        unknown.push({ ...slot, addedMinutes: null, travelBefore: before, travelAfter: after, reason: `Lieu inconnu : ${floor} min de trajet laissées de chaque côté.` });
        continue;
      }
      const direct = fromPlace && toPlace ? estimate(fromPlace, toPlace) : 0;
      const added = Math.max(0, before + after - direct);
      const origin = prev ? 'le rendez-vous précédent' : base ? "l'agence" : 'le départ';
      const destination = next ? 'le suivant' : base ? "l'agence" : 'la fin de journée';
      known.push({ ...slot, addedMinutes: added, travelBefore: before, travelAfter: after, reason: `${before} min depuis ${origin}, ${after} min vers ${destination} : ${added} min de route en plus.` });
    }
    known.sort((a, b) => a.addedMinutes! - b.addedMinutes! || a.start.getTime() - b.start.getTime());
    unknown.sort((a, b) => a.start.getTime() - b.start.getTime());
    return [...known, ...unknown].slice(0, limit);
  }
}
