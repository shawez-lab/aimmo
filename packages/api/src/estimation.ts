import { EstimationEnLigne, SqlJournalStore, appendEvent, type CommuneResult, type DetailedSales, type Geocoder, type SqlDatabase } from '@aimmo/core';
import { renderEstimationPage, type EstimationFormError } from '../../core/src/attirer/page-estimation.ts';
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

const POSTAL_CODE = /^\d{5}$/;
const validTown = (town: string): boolean => town.trim() !== '' && town.length <= 80 && !/\d/.test(town);
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
  if (typeof postalCode !== 'string' || !POSTAL_CODE.test(postalCode)) return failure(400, 'invalid_postal_code', 'postalCode : 5 chiffres.');
  if (typeof town !== 'string' || !validTown(town)) return failure(400, 'invalid_town', 'town : le nom de la commune.');
  if (typeof kind !== 'string' || !KINDS[kind]) return failure(400, 'invalid_kind', 'kind : appartement ou maison.');

  const result = await estimateForVisitor({ db: config.db, services: config.services, limits: config.limits, now: config.now }, intake.networkId, visitorId, postalCode, town, kind, 'intake:site_estimate');
  if (!result) return failure(429, 'too_many_requests', 'Trop de demandes : réessayez plus tard.');
  return result.ok
    ? json(200, { ok: true, mode: 'essai', data: result.value })
    : json(200, { ok: true, mode: 'essai', data: null, reason: result.reason, next: 'appointment' });
}

interface EstimateContext {
  db: SqlDatabase;
  services: { geocoder: Geocoder; sales: DetailedSales };
  limits?: EstimationLimits | undefined;
  now: () => Date;
}

/** Une demande de fourchette, sous les limites de E05 ; `null` au-delà. L'API et la page du site passent toutes deux ici. */
async function estimateForVisitor(c: EstimateContext, networkId: string, visitorId: string, postalCode: string, town: string, kind: string, actor: string): Promise<CommuneResult | null> {
  const at = c.now();
  const limits = c.limits ?? DEFAULT_ESTIMATION_LIMITS;
  // L'empreinte change à chaque heure pleine : elle sert la limite de l'heure, et ne relie pas les demandes d'un
  // visiteur d'une heure à l'autre. Rien n'est effacé [R17], rien n'est gardé qui suive le visiteur [R15].
  const visitor = await sha256Hex(`${networkId}:${visitorId}:${at.toISOString().slice(0, 13)}`);
  if (!(await takeSlot(c.db, networkId, `estimation:${visitor}`, limits.perVisitor, at)) || !(await takeSlot(c.db, networkId, 'estimation:reseau', limits.perNetwork, at))) return null;
  const result = await new EstimationEnLigne(c.services.geocoder, c.services.sales, undefined, c.now).forTown(postalCode, town, KINDS[kind]!);
  await appendEvent(
    new SqlJournalStore(c.db),
    { type: 'estimation.commune', actor, subject: null, data: { mode: 'essai', ok: result.ok, reason: result.ok ? null : result.reason, missingFiles: result.ok ? null : (result.missingFiles ?? null) } },
    c.now,
  );
  return result;
}

export const ESTIMATION_PAGE_PATH = '/estimation';
const MAX_FORM_BYTES = 2000;
// Ni script ni ressource extérieure ; le formulaire ne part que vers ce site.
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

export interface EstimationPageConfig {
  db: SqlDatabase;
  networkId: string;
  services?: { geocoder: Geocoder; sales: DetailedSales } | null | undefined;
  limits?: EstimationLimits | undefined;
  now: () => Date;
  mode: 'essai' | 'reel';
  appointmentHref: string;
}

/**
 * La page `/estimation` d'un site (RS04), sans clé ni script. Une limite par visite comme celle de E05 : l'identifiant vient
 * du formulaire, chaque page en reçoit un nouveau. Il ne suit personne, et la limite du réseau tient quoi qu'il arrive.
 */
export async function handleEstimationPage(request: Request, config: EstimationPageConfig): Promise<Response> {
  const open = Boolean(config.services);
  const page = (status: number, extra: { values?: { postalCode: string; town: string; kind: string }; error?: EstimationFormError; result?: CommuneResult }): Response =>
    new Response(request.method === 'HEAD' ? null : renderEstimationPage({ visitorId: crypto.randomUUID(), open, appointmentHref: config.appointmentHref, ...extra }), {
      status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': PAGE_CSP,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        // Chaque page porte sa propre visite, et une réponse ne se garde nulle part.
        'cache-control': 'no-store',
        ...(config.mode === 'essai' ? { 'x-robots-tag': 'noindex, nofollow' } : {}),
      },
    });
  if (request.method === 'GET' || request.method === 'HEAD') return page(200, {});
  if (request.method !== 'POST') return new Response('Méthode non permise.', { status: 405, headers: { allow: 'GET, HEAD, POST', 'cache-control': 'no-store' } });
  if (!config.services) return page(200, {});
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded')) return page(400, { error: 'invalid_form' });
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_FORM_BYTES) return page(400, { error: 'invalid_form' });
  const form = new URLSearchParams(raw);
  const names = [...form.keys()];
  // Ni surface, ni adresse, ni rien d'autre : sans visite, on ne parle pas d'un bien précis [R31].
  if (new Set(names).size !== names.length || names.some((k) => !ALLOWED.has(k))) return page(400, { error: 'invalid_form' });
  const visitorId = form.get('visitorId') ?? '';
  const values = { postalCode: (form.get('postalCode') ?? '').trim(), town: (form.get('town') ?? '').trim(), kind: form.get('kind') ?? '' };
  if (!VISITOR.test(visitorId)) return page(400, { values, error: 'invalid_form' });
  if (!POSTAL_CODE.test(values.postalCode)) return page(400, { values, error: 'invalid_postal_code' });
  if (!validTown(values.town)) return page(400, { values, error: 'invalid_town' });
  if (!Object.hasOwn(KINDS, values.kind)) return page(400, { values, error: 'invalid_kind' });
  let result: CommuneResult | null;
  try {
    result = await estimateForVisitor({ db: config.db, services: config.services, limits: config.limits, now: config.now }, config.networkId, visitorId, values.postalCode, values.town, values.kind, 'public:estimation');
  } catch (error) {
    // Une panne du géocodage ou des ventes : le visiteur garde sa page, sa saisie et le rendez-vous. Rien de lui au journal [R13].
    await appendEvent(new SqlJournalStore(config.db), { type: 'api.erreur', actor: 'public:estimation', subject: null, data: { route: 'estimation.page', error: error instanceof Error ? error.name : 'unknown' } }, config.now);
    return page(503, { values, error: 'unavailable' });
  }
  return result ? page(200, { values, result }) : page(429, { values, error: 'too_many_requests' });
}
