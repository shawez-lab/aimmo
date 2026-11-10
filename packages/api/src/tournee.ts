/**
 * Les routes de la carte des opportunités et de la tournée de prospection (HX19), sous `/v1/tournee` (BR28).
 *
 * L'agent en activité seul : la carte et la tournée sont les siennes, la direction n'en a pas [R16, R297]. Le rôle est
 * contrôlé avant tout ; un refus est écrit au journal. Aucune adresse hors des zones de l'agent n'est montrée, elle est
 * seulement comptée [R297] ; la tournée tient dans ses disponibilités, autour de ses rendez-vous, route comprise [R298] ;
 * le lien de la vue des rues ne porte que la position arrondie [R299]. Rien n'est réservé ni envoyé.
 *
 * L'agenda relié (V03) et la position des biens n'ont encore aucune source dans l'API : la tournée ne voit que les
 * rendez-vous d'AIMMO, et la réponse le dit (`agendaRelie: false`). Un paramètre non prévu : 400 `unknown_field`.
 */
import type { Geocoder, JournalStore, SqlDatabase, Viewer } from '@aimmo/core';
import { appendEvent } from '../../core/src/journal/journal.ts';
import { TourneeProspection } from '../../core/src/tournee-prospection/index.ts';

export const TRIAL_MODE = 'essai';

export interface TourneeServices {
  db: SqlDatabase;
  journal: JournalStore;
  now: () => Date;
  /** La Base adresse nationale, pour placer les panneaux ; absente, leur lieu est inconnu. */
  geocoder: Geocoder | null;
}

export interface TourneeRoute {
  method: 'GET';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  handle: (s: TourneeServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...HEADERS } });

type Outcome = { ok: true; value: unknown } | { ok: false; rule: string | null; code: string };

/** 200 ; 403 pour un refus de droits ; 409 pour une règle ; 400 sinon. */
function reply(result: Outcome): Response {
  if (result.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: result.value });
  if (result.rule === 'R16') return json(403, { ok: false, rule: result.rule, code: result.code });
  return json(result.rule ? 409 : 400, { ok: false, rule: result.rule, code: result.code });
}

/** Le refus d'un rôle, écrit au journal comme ceux de la couche métier, avant toute lecture [R16]. */
async function refuseRole(s: TourneeServices, viewer: Viewer): Promise<Response> {
  await appendEvent(
    s.journal,
    { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: null, data: { rule: 'R16', role: String(viewer.role), kind: 'tournee_prospection', code: 'role' } },
    s.now,
  );
  return json(403, { ok: false, rule: 'R16', code: 'role' });
}

const tournee = (s: TourneeServices) => new TourneeProspection(s.db, s.journal, { now: s.now, ...(s.geocoder ? { geocoder: s.geocoder } : {}) });

/** Le seul paramètre prévu est `date` (AAAA-MM-JJ) ; absent, le jour de Paris. Une date répétée est refusée. */
function dateParam(request: Request): { ok: true; date: string | undefined } | { ok: false; field: string } {
  const params = new URL(request.url).searchParams;
  for (const k of params.keys()) if (k !== 'date') return { ok: false, field: k };
  const all = params.getAll('date');
  if (all.length > 1) return { ok: false, field: 'date' };
  return { ok: true, date: all[0] };
}

/** Les routes de `/v1/tournee`, à ajouter à celles de `app.ts`. */
export function tourneeRoutes(): TourneeRoute[] {
  const agentOnly =
    (fn: (s: TourneeServices, v: Viewer, date: string | undefined) => Promise<Outcome>): TourneeRoute['handle'] =>
    async (s, v, _params, request) => {
      if (String(v.role) !== 'agent') return refuseRole(s, v);
      const q = dateParam(request);
      if (!q.ok) return json(400, { ok: false, rule: null, code: 'unknown_field', field: q.field });
      return reply(await fn(s, v, q.date));
    };

  return [
    {
      method: 'GET',
      pattern: /^\/tournee\/carte$/,
      name: 'tournee.carte',
      handle: agentOnly(async (s, v, date) => {
        const r = await tournee(s).map(v, date);
        if (!r.ok) return r;
        return { ok: true, value: { opportunities: r.opportunities, outsideZone: r.outsideZone, agendaRelie: false } };
      }),
    },
    {
      method: 'GET',
      pattern: /^\/tournee$/,
      name: 'tournee.plan',
      handle: agentOnly(async (s, v, date) => {
        // Sans date, le jour de Paris, comme la carte.
        const r = await tournee(s).plan(v, date ?? parisToday(s.now()));
        if (!r.ok) return r;
        const { ok: _ok, ...tour } = r;
        return { ok: true, value: { ...tour, agendaRelie: false } };
      }),
    },
  ];
}

/** Le jour de Paris (AAAA-MM-JJ) d'un instant. */
function parisToday(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
