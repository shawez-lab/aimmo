import { ONLINE_KINDS, ONLINE_SOURCES, ReservationEnLigne, SqlJournalStore, parisInstant, type AppointmentKind, type AppointmentSource, type BusySource, type SqlDatabase } from '@aimmo/core';
import { AgendaUnavailableError } from './agenda-reel.ts';
import { intakeFromRequest, parseIntakeKeys, sha256Hex } from './auth.ts';
import { journalError } from './app.ts';
import { VISITOR, takeSlot } from './assistant.ts';

/**
 * La réservation des rendez-vous depuis le site, l'assistant et l'espace client (V08), en mode essai, avec la seule clé
 * de dépôt `site_booking`, qui ne lit aucune fiche :
 *
 *   POST /v1/rendez-vous/creneaux     { visitorId, agentId, kind, from: "AAAA-MM-JJ", days, propertyId? }
 *   POST /v1/rendez-vous/reservation  { visitorId, agentId, kind, start, source, firstName?, email | phone, consentProof, propertyId? }
 *
 * Les créneaux ne portent que début et fin [R33]. La réservation enregistre l'accord « rendez-vous » avec sa preuve
 * [R03] et rend sa confirmation tout de suite, la même pour tous : rien n'y dit si la personne était connue, exclue ou
 * avait demandé l'arrêt [R16] ; rien ne part en mode essai [R26]. Limites d'appels par visiteur et par
 * réseau, à l'heure.
 */
export const BOOKING_SLOTS_PATH = '/rendez-vous/creneaux';
export const BOOKING_PATH = '/rendez-vous/reservation';

export interface BookingLimits {
  /** Demandes de créneaux par visiteur et par heure. */
  slotsPerVisitor: number;
  /** Réservations par visiteur et par heure. */
  bookingsPerVisitor: number;
  /** Demandes de tout le réseau par heure. */
  perNetwork: number;
}
export const DEFAULT_BOOKING_LIMITS: BookingLimits = Object.freeze({ slotsPerVisitor: 30, bookingsPerVisitor: 3, perNetwork: 1000 });

export interface BookingConfig {
  db: SqlDatabase;
  intakeKeys: string | undefined;
  limits?: BookingLimits;
  /** Variable `RDV_LINK_BASE` : début du lien pour décaler ou annuler. */
  linkBase?: string | null;
  /** AU053 · les événements occupés des agendas reliés (H21, H53) ; absent, seuls les rendez-vous d'AIMMO comptent. */
  agenda?: BusySource | undefined;
  now: () => Date;
}

const MAX_BODY = 4_000;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?Z$/;
const SLOT_FIELDS = new Set(['visitorId', 'agentId', 'kind', 'from', 'days', 'propertyId']);
const BOOKING_FIELDS = new Set(['visitorId', 'agentId', 'kind', 'start', 'source', 'firstName', 'email', 'phone', 'consentProof', 'propertyId']);

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
const failure = (status: number, code: string, message: string): Response => json(status, { ok: false, code, message });

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** `null` quand l'agenda relié de l'agent n'a pas pu être lu : rien n'est réservé. */
async function agendaOrClosed<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AgendaUnavailableError) return null;
    throw error;
  }
}
const agendaClosed = (): Response => json(503, { ok: false, mode: 'essai', code: 'agenda_indisponible', rule: 'R702', message: 'Agenda de l’agent injoignable : réessayez dans quelques minutes.' });

export async function handleBooking(request: Request, path: string, config: BookingConfig): Promise<Response> {
  if (request.method !== 'POST') return failure(405, 'method_not_allowed', 'Méthode non admise.');
  const keys = parseIntakeKeys(config.intakeKeys);
  if (keys === null) return failure(503, 'keys_not_configured', 'Réservation fermée : aucune clé configurée.');
  const intake = await intakeFromRequest(request, keys, 'site_booking');
  if (intake === null) return failure(401, 'unauthorized', 'Clé absente ou refusée.');
  const body = await readBody(request);
  if (body === null) return failure(400, 'invalid_body', 'Corps JSON attendu.');
  const allowed = path === BOOKING_PATH ? BOOKING_FIELDS : SLOT_FIELDS;
  if (Object.keys(body).some((k) => !allowed.has(k))) return failure(400, 'unexpected_field', `Seuls ${[...allowed].join(', ')} sont admis.`);
  const { visitorId, agentId, kind } = body;
  if (typeof visitorId !== 'string' || !VISITOR.test(visitorId)) return failure(400, 'invalid_visitor', 'visitorId : identifiant opaque de 16 à 128 caractères.');
  if (typeof agentId !== 'string' || !ID.test(agentId)) return failure(400, 'invalid_agent', 'agentId manquant ou mal formé.');
  if (typeof kind !== 'string' || !(ONLINE_KINDS as readonly string[]).includes(kind)) return failure(400, 'invalid_kind', `kind attendu parmi : ${ONLINE_KINDS.join(', ')}.`);
  const { propertyId } = body;
  if (propertyId !== undefined && propertyId !== null && (typeof propertyId !== 'string' || !ID.test(propertyId))) return failure(400, 'invalid_property', 'propertyId mal formé.');

  const at = config.now();
  const limits = config.limits ?? DEFAULT_BOOKING_LIMITS;
  // L'empreinte du visiteur change chaque heure : elle sert la limite, sans suivre le visiteur d'une heure à l'autre.
  const visitor = await sha256Hex(`${intake.networkId}:${visitorId}:${at.toISOString().slice(0, 13)}`);
  const booking = path === BOOKING_PATH;
  if (
    !(await takeSlot(config.db, intake.networkId, `${booking ? 'rdv_reservation' : 'rdv_creneaux'}:${visitor}`, booking ? limits.bookingsPerVisitor : limits.slotsPerVisitor, at)) ||
    !(await takeSlot(config.db, intake.networkId, 'rdv:reseau', limits.perNetwork, at))
  ) {
    return failure(429, 'too_many_requests', 'Trop de demandes : réessayez plus tard.');
  }
  const journal = new SqlJournalStore(config.db);
  const service = new ReservationEnLigne(config.db, journal, { now: config.now, linkBase: config.linkBase ?? null, ...(config.agenda ? { agenda: config.agenda } : {}) });

  if (!booking) {
    const { from, days } = body;
    if (typeof from !== 'string' || !DATE.test(from)) return failure(400, 'invalid_from', 'from : une date AAAA-MM-JJ.');
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 14) return failure(400, 'invalid_days', 'days : de 1 à 14.');
    const start = parisInstant(from, 0);
    if (!start) return failure(400, 'invalid_from', 'from : une date AAAA-MM-JJ.');
    // Avec le bien, un créneau juste après un rendez-vous au même bien est proposé avec la marge du même lieu (AU055).
    // Un agenda relié injoignable ferme la réservation : aucun créneau n'est supposé libre [R33, R702].
    const result = await agendaOrClosed(() => service.slots({
      networkId: intake.networkId,
      agentId,
      kind: kind as AppointmentKind,
      from: start,
      to: new Date(start.getTime() + days * 86_400_000),
      propertyId: (propertyId as string | null | undefined) ?? null,
    }));
    if (result === null) return agendaClosed();
    // Un agent inconnu rend une liste vide, comme un agent sans créneau : rien n'est dit de l'équipe.
    return json(200, { ok: true, mode: 'essai', slots: result.ok ? result.slots : [] });
  }

  const { start, source, firstName, email, phone, consentProof } = body;
  if (typeof start !== 'string' || !INSTANT.test(start) || Number.isNaN(Date.parse(start))) return failure(400, 'invalid_start', 'start : un instant ISO en UTC, tel que rendu par les créneaux.');
  if (typeof source !== 'string' || !(ONLINE_SOURCES as readonly string[]).includes(source)) return failure(400, 'invalid_source', `source attendue parmi : ${ONLINE_SOURCES.join(', ')}.`);
  if (firstName !== undefined && firstName !== null && (typeof firstName !== 'string' || firstName.length > 60)) return failure(400, 'invalid_first_name', 'firstName : 60 caractères au plus.');
  if (email !== undefined && email !== null && (typeof email !== 'string' || email.length > 254)) return failure(400, 'invalid_email', 'email mal formé.');
  if (phone !== undefined && phone !== null && (typeof phone !== 'string' || phone.length > 30)) return failure(400, 'invalid_phone', 'phone mal formé.');
  if (typeof consentProof !== 'string' || consentProof.trim() === '' || consentProof.length > 300) {
    return failure(400, 'invalid_consent', 'consentProof : ce que la personne a accepté, et où (300 caractères au plus) [R03].');
  }
  const result = await agendaOrClosed(() => service.book({
    networkId: intake.networkId,
    agentId,
    kind: kind as AppointmentKind,
    start: new Date(start),
    source: source as AppointmentSource,
    firstName: (firstName as string | null | undefined) ?? null,
    email: (email as string | null | undefined) ?? null,
    phone: (phone as string | null | undefined) ?? null,
    consentProof,
    propertyId: (propertyId as string | null | undefined) ?? null,
  }));
  if (result === null) return agendaClosed();
  if (!result.ok) {
    const status = ['not_free', 'taken', 'agenda_busy', 'outside_availability', 'no_availability', 'too_soon', 'bad_time'].includes(result.code) ? 409 : 400;
    return json(status, { ok: false, mode: 'essai', code: result.code, rule: result.rule });
  }
  // La confirmation rendue est toujours la même : l'état réel de son envoi (refus pour exclusion, arrêt, doublon) dirait
  // si la personne est connue du réseau. Il reste sur le rendez-vous et au journal [R16].
  if (result.warning) {
    // Le rendez-vous et son jeton sont rendus ; la panne du journal est notée à part, sans donnée [R13].
    await journalError(new SqlJournalStore(config.db), 'intake:site_booking', 'rendez-vous.journal', new Error('journal_failed'), config.now).catch(() => undefined);
  }
  return json(200, { ok: true, mode: 'essai', sent: false, appointment: result.appointment, token: result.token, confirmation: { booked: true }, ...(result.warning ? { warning: result.warning } : {}) });
}
