/**
 * Les routes de la boutique de l'agent (HX07), sous `/v1/boutique` (BR22).
 *
 * Chaque route dit le rôle qu'elle admet, contrôlé avant toute lecture du corps ; un refus est écrit au journal [R16].
 * La direction règle et lit les tarifs ; l'agent tire un support de son bien (ou sa carte de visite), prépare une
 * commande et la valide d'un geste [R263, R264, R265]. Préparer ne commande rien. La commande ne part qu'à l'imprimeur
 * d'essai : rien n'est imprimé, rien n'est payé [R26]. Un champ non prévu : 400 `unknown_field`.
 */
import type { Acces, JournalStore, SqlDatabase, Viewer } from '@aimmo/core';
import { Boutique } from '../../core/src/boutique/index.ts';
import { appendEvent } from '../../core/src/journal/journal.ts';

export const TRIAL_MODE = 'essai';
const MAX_BODY_BYTES = 4_000;
const ID = '([A-Za-z0-9_-]{1,64})';

export interface BoutiqueServices {
  db: SqlDatabase;
  journal: JournalStore;
  acces: Acces;
  now: () => Date;
}

export interface BoutiqueRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  handle: (s: BoutiqueServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...HEADERS } });

type Outcome = { ok: true; value?: unknown; [k: string]: unknown } | { ok: false; rule?: string | null; code: string; [k: string]: unknown };

/** Les refus du support lui-même, que la couche métier rend sans règle : ce sont ceux de R263. */
const SUPPORT_REFUSALS = new Set(['annonce_pas_en_vente', 'annonce_incomplete', 'pas_de_telephone', 'adresse_invalide', 'qr_trop_long', 'chiffre_invente', 'reference_illisible', 'pas_de_page', 'pas_de_site']);
/** Les refus qui tiennent au prix ou à la commande : ceux de R264 et R265. */
const ORDER_REFUSALS: Record<string, string> = { pas_de_tarif: 'R264', imprimeur_different: 'R264', tarif_change: 'R264', support_perime: 'R264', deja_validee: 'R265', demande_differente: 'R265' };

/** 200 ; 403 pour un refus de droits ; 404 inconnu ; 409 pour une règle ; 502 imprimeur en panne ; 400 sinon. */
function reply(result: Outcome): Response {
  if (result.ok) {
    const { ok: _ok, value, ...rest } = result;
    return json(200, { ok: true, mode: TRIAL_MODE, data: value ?? null, ...rest });
  }
  const { ok: _ok, rule: given, ...rest } = result;
  const rule = given ?? (SUPPORT_REFUSALS.has(result.code) ? 'R263' : (ORDER_REFUSALS[result.code] ?? null));
  if (rule === 'R16') return json(403, { ok: false, rule, ...rest });
  if (/^unknown/.test(result.code)) return json(404, { ok: false, rule, ...rest });
  if (result.code === 'imprimeur_en_panne') return json(502, { ok: false, rule, ...rest });
  return json(rule ? 409 : 400, { ok: false, rule, ...rest });
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const badBody = (): Response => json(400, { ok: false, rule: null, code: 'invalid_body', message: 'Corps JSON attendu.' });

/** Le refus d'un rôle, écrit au journal comme ceux de la couche métier, avant que le corps soit lu [R16]. */
async function refuseRole(s: BoutiqueServices, viewer: Viewer): Promise<Response> {
  await appendEvent(
    s.journal,
    { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'boutique', code: 'role' } },
    s.now,
  );
  return json(403, { ok: false, rule: 'R16', code: 'role' });
}

/** La boutique de la séance : l'imprimeur d'essai, seul imprimeur branché [R26]. */
const boutique = (s: BoutiqueServices) => new Boutique(s.db, s.acces, s.journal, { now: s.now });

type Role = 'agent' | 'direction';

/** Les routes de `/v1/boutique`, à ajouter à celles de `app.ts`. */
export function boutiqueRoutes(): BoutiqueRoute[] {
  /** Le rôle d'abord ; puis seulement le corps, avec ses champs prévus. */
  const withBody =
    (role: Role, fields: readonly string[], fn: (s: BoutiqueServices, v: Viewer, params: string[], body: Record<string, unknown>) => Promise<Outcome>): BoutiqueRoute['handle'] =>
    async (s, v, params, request) => {
      if (v.role !== role) return refuseRole(s, v);
      const body = await readJson(request);
      if (!body) return badBody();
      const extra = Object.keys(body).find((k) => !fields.includes(k));
      if (extra !== undefined) return json(400, { ok: false, rule: null, code: 'unknown_field', field: extra });
      return reply(await fn(s, v, params, body));
    };
  const only =
    (role: Role, fn: (s: BoutiqueServices, v: Viewer, params: string[]) => Promise<Outcome>): BoutiqueRoute['handle'] =>
    async (s, v, params) =>
      v.role !== role ? refuseRole(s, v) : reply(await fn(s, v, params));

  return [
    {
      method: 'GET',
      pattern: /^\/boutique\/tarifs$/,
      name: 'boutique.tarifs',
      handle: only('direction', async (s, v) => boutique(s).tariffs(v)),
    },
    {
      method: 'POST',
      pattern: /^\/boutique\/tarifs$/,
      name: 'boutique.tarif_regler',
      handle: withBody('direction', ['support', 'quantity', 'priceCents', 'printer', 'source', 'validUntil'], async (s, v, _p, b) => {
        const r = await boutique(s).setTariff(v, { support: b.support, quantity: b.quantity, priceCents: b.priceCents, printer: b.printer, source: b.source, validUntil: b.validUntil });
        return r.ok ? { ok: true, value: { tariffId: r.tariffId } } : r;
      }),
    },
    {
      method: 'POST',
      pattern: /^\/boutique\/apercu$/,
      name: 'boutique.apercu',
      handle: withBody('agent', ['support', 'propertyId'], async (s, v, _p, b) => {
        const r = await boutique(s).preview(v, { support: b.support, propertyId: b.propertyId });
        return r.ok ? { ok: true, value: { support: r.support, html: r.html, keyword: r.keyword, url: r.url } } : r;
      }),
    },
    {
      method: 'GET',
      pattern: /^\/boutique\/commandes$/,
      name: 'boutique.commandes',
      handle: only('agent', async (s, v) => ({ ok: true, value: await boutique(s).orders(v) })),
    },
    {
      method: 'POST',
      pattern: /^\/boutique\/commandes$/,
      name: 'boutique.preparer',
      handle: withBody('agent', ['requestId', 'support', 'propertyId', 'quantity'], async (s, v, _p, b) => {
        const r = await boutique(s).prepare(v, { requestId: b.requestId, support: b.support, propertyId: b.propertyId, quantity: b.quantity });
        if (!r.ok) return r;
        if (!('orderId' in r)) return { ok: false, rule: null, code: 'bad_request' };
        return { ok: true, value: { orderId: r.orderId, priceCents: r.priceCents, html: r.html } };
      }),
    },
    // Sans corps : le geste est dans l'adresse, rien à lire avant les droits.
    {
      method: 'POST',
      pattern: new RegExp(`^/boutique/commandes/${ID}/validation$`),
      name: 'boutique.valider',
      handle: only('agent', async (s, v, [orderId]) => {
        const r = await boutique(s).validate(v, orderId!);
        return r.ok ? { ok: true, value: { printerRef: r.printerRef } } : r;
      }),
    },
  ];
}
