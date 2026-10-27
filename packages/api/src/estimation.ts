import { EstimationEnLigne, SqlJournalStore, appendEvent, type DetailedSales, type Geocoder, type SqlDatabase } from '@aimmo/core';
import { intakeFromRequest, parseIntakeKeys, sha256Hex } from './auth.ts';
import { VISITOR, takeSlot } from './assistant.ts';

/**
 * L'estimation en ligne du site (E05) : `POST /v1/estimation/commune` `{ visitorId, postalCode, town, kind }`.
 * Ouverte à la seule clé de dépôt `site_estimate`, qui ne lit aucune fiche. Rend la fourchette de prix au m² de la
 * commune et propose un rendez-vous ; jamais le prix d'un bien, et aucune surface ni adresse n'est acceptée [R31].
 * Rien du visiteur n'est gardé, sauf l'empreinte de son identifiant opaque, pour les limites [R15].
 */
export const ESTIMATION_PATH = '/estimation/commune';

export interface EstimationLimits {
  perVisitor: number;
  perNetwork: number;
}
export const DEFAULT_ESTIMATION_LIMITS: EstimationLimits = Object.freeze({ perVisitor: 10, perNetwork: 600 });

export interface EstimationConfig {
  db: SqlDatabase;
  intakeKeys: string | undefined;
  /** Base adresse nationale et ventes DVF ; absents : le service est fermé. */
  services?: { geocoder: Geocoder; sales: DetailedSales };
  limits?: EstimationLimits;
  now: () => Date;
}

const KINDS: Record<string, 'apartment' | 'house'> = { appartement: 'apartment', maison: 'house' };
const ALLOWED = new Set(['visitorId', 'postalCode', 'town', 'kind']);

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
const failure = (status: number, code: string, message: string): Response => json(status, { ok: false, code, message });

export async function handleEstimation(request: Request, config: EstimationConfig): Promise<Response> {
  if (request.method !== 'POST') return failure(405, 'method_not_allowed', 'Méthode non admise.');
  const keys = parseIntakeKeys(config.intakeKeys);
  if (keys === null) return failure(503, 'keys_not_configured', 'Estimation fermée : aucune clé configurée.');
  const intake = await intakeFromRequest(request, keys, 'site_estimate');
  if (intake === null) return failure(401, 'unauthorized', 'Clé absente ou refusée.');
  if (!config.services) return failure(503, 'not_configured', 'Estimation fermée : données non branchées.');
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return failure(400, 'invalid_body', 'Corps JSON attendu.');
  const raw = await request.text();
  if (raw.length > 2000) return failure(400, 'invalid_body', 'Corps trop long.');
  let body: Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(raw);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return failure(400, 'invalid_body', 'Corps JSON attendu.');
    body = v as Record<string, unknown>;
  } catch {
    return failure(400, 'invalid_body', 'Corps JSON attendu.');
  }
  // Ni surface, ni adresse, ni rien d'autre : sans visite, on ne parle pas d'un bien précis [R31].
  const extra = Object.keys(body).filter((k) => !ALLOWED.has(k));
  if (extra.length > 0) return failure(400, 'unexpected_field', 'Seuls visitorId, postalCode, town et kind sont admis.');
  const { visitorId, postalCode, town, kind } = body;
  if (typeof visitorId !== 'string' || !VISITOR.test(visitorId)) return failure(400, 'invalid_visitor', 'visitorId : identifiant opaque de 16 à 128 caractères.');
  if (typeof postalCode !== 'string' || !/^\d{5}$/.test(postalCode)) return failure(400, 'invalid_postal_code', 'postalCode : 5 chiffres.');
  if (typeof town !== 'string' || town.trim() === '' || town.length > 80 || /\d/.test(town)) return failure(400, 'invalid_town', 'town : le nom de la commune.');
  if (typeof kind !== 'string' || !KINDS[kind]) return failure(400, 'invalid_kind', 'kind : appartement ou maison.');

  const at = config.now();
  const limits = config.limits ?? DEFAULT_ESTIMATION_LIMITS;
  const visitor = await sha256Hex(`${intake.networkId}:${visitorId}`);
  if (
    !(await takeSlot(config.db, intake.networkId, `estimation:${visitor}`, limits.perVisitor, at)) ||
    !(await takeSlot(config.db, intake.networkId, 'estimation:reseau', limits.perNetwork, at))
  ) {
    return failure(429, 'too_many_requests', 'Trop de demandes : réessayez plus tard.');
  }
  const journal = new SqlJournalStore(config.db);
  const result = await new EstimationEnLigne(config.services.geocoder, config.services.sales, undefined, config.now).forTown(postalCode, town, KINDS[kind]!);
  await appendEvent(
    journal,
    { type: 'estimation.commune', actor: 'intake:site_estimate', subject: null, data: { mode: 'essai', ok: result.ok, reason: result.ok ? null : result.reason } },
    config.now,
  );
  return result.ok
    ? json(200, { ok: true, mode: 'essai', data: result.value })
    : json(200, { ok: true, mode: 'essai', data: null, reason: result.reason, next: 'appointment' });
}
