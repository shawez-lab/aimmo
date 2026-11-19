/**
 * SV06, SV07 · Les biens du client et son nom, depuis sa fiche.
 *   GET  /v1/fiches/<id>/biens   les biens liés à son projet de vente
 *   POST /v1/fiches/<id>/biens   { requestId, kind, postalCode, city, surfaceM2, rooms, priceEur } : crée le bien et le lie
 *   POST /v1/fiches/<id>/nom     { firstName, lastName } : remplit ce qui est vide, n'écrase rien
 *   GET  /v1/fiches/<id>/nom/corrections   la direction relit les corrections et les valeurs d'avant (SV10)
 *   POST /v1/fiches/<id>/nom/corrections   { firstName, lastName, reason } : la direction corrige, la valeur d'avant reste
 * Le rôle et le droit sur la fiche sont contrôlés avant le corps [R16]. Rien n'est envoyé [R26].
 */
import { CompleterNom, CorrigerNom, NouveauBien, appendEvent, type Acces, type JournalStore, type SqlDatabase, type Viewer } from '@aimmo/core';

export const MAX_BIEN_BODY_BYTES = 2048;
const ID = '([0-9a-f-]{36})';
const FIELDS = new Set(['requestId', 'kind', 'dwelling', 'postalCode', 'city', 'surfaceM2', 'rooms', 'priceEur']);
const ROLES: readonly string[] = ['agent', 'direction'];

export interface BiensFicheServices {
  db: SqlDatabase;
  acces: Acces;
  journal: JournalStore;
  now: () => Date;
}

export interface BiensFicheRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  name: string;
  handle: (s: BiensFicheServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BIEN_BODY_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const statusOf = (rule: string | null, code: string): number => (code === 'unknown' ? 404 : rule === 'R16' ? 403 : code === 'already_named' || code === 'name_changed' ? 409 : 400);
const answer = <T>(r: { ok: true; value: T } | { ok: false; rule: string | null; code: string }): Response =>
  r.ok ? json(200, { ok: true, mode: 'essai', sent: false, data: r.value }) : json(statusOf(r.rule, r.code), { ok: false, rule: r.rule, code: r.code });
const corrections = (s: BiensFicheServices): CorrigerNom => new CorrigerNom(s.db, s.acces, s.journal, { now: s.now });
const core = (s: BiensFicheServices): NouveauBien => new NouveauBien(s.db, s.acces, s.journal, { now: s.now });

function guarded(handle: BiensFicheRoute['handle']): BiensFicheRoute['handle'] {
  return async (s, viewer, params, request) => {
    if (!ROLES.includes(viewer.role)) {
      await appendEvent(s.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'new_property', code: 'role' } }, s.now);
      return json(403, { ok: false, rule: 'R16', code: 'role' });
    }
    return handle(s, viewer, params, request);
  };
}

export function biensFicheRoutes(): BiensFicheRoute[] {
  return [
    // Le rôle et le droit sur la fiche d'abord, dans `CorrigerNom`, écrits au journal : le corps n'est lu que pour la direction [R16].
    { method: 'GET', pattern: new RegExp(`^/fiches/${ID}/nom/corrections$`), name: 'fiche.nom.corrections', handle: async (s, viewer, [id]) => answer(await corrections(s).list(viewer, id!)) },
    {
      method: 'POST',
      pattern: new RegExp(`^/fiches/${ID}/nom/corrections$`),
      name: 'fiche.nom.corrige',
      handle: async (s, viewer, [id], request) => answer(await corrections(s).correct(viewer, id!, viewer.role === 'direction' ? await readJson(request) : null)),
    },
    { method: 'GET', pattern: new RegExp(`^/fiches/${ID}/biens$`), name: 'fiche.biens', handle: guarded(async (s, viewer, [id]) => answer(await core(s).list(viewer, id!))) },
    {
      method: 'POST',
      pattern: new RegExp(`^/fiches/${ID}/biens$`),
      name: 'fiche.bien.cree',
      handle: guarded(async (s, viewer, [id], request) => {
        const body = await readJson(request);
        if (!body) return json(400, { ok: false, rule: null, code: 'invalid_body' });
        if (Object.keys(body).some((k) => !FIELDS.has(k))) return json(400, { ok: false, rule: null, code: 'unexpected_field' });
        return answer(await core(s).create(viewer, id!, body));
      }),
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/fiches/${ID}/nom$`),
      name: 'fiche.nom',
      handle: guarded(async (s, viewer, [id], request) => {
        const body = await readJson(request);
        if (!body) return json(400, { ok: false, rule: null, code: 'invalid_body' });
        if (Object.keys(body).some((k) => k !== 'firstName' && k !== 'lastName')) return json(400, { ok: false, rule: null, code: 'unexpected_field' });
        return answer(await new CompleterNom(s.db, s.acces, s.journal, { now: s.now }).complete(viewer, id!, body));
      }),
    },
  ];
}
