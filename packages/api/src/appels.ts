/**
 * Route des appels notés par l'agent (AC09), branchée dans le socle (AC12) [R204, R16].
 *
 *   POST /v1/fiches/<id>/appels   { outcome: 'called' | 'refused' } : note un appel ou le refus de la personne
 *   GET  /v1/fiches/<id>/appels-recus : les appels reçus et rangés de la fiche, fiches réunies comprises (BR61, HX21)
 *
 * Le rôle est contrôlé avant de lire le corps, et son refus va au journal [R16]. Rien n'est envoyé d'ici.
 */
import { AppelsFiche, appendEvent, type Acces, type JournalStore, type SqlDatabase, type Viewer } from '@aimmo/core';
import { callsOfFiche, type CallView } from '../../core/src/voix/appels.ts';

export const MAX_APPEL_BODY_BYTES = 1024;
const ID = '([A-Za-z0-9_-]{1,64})';
const ROLES: readonly Viewer['role'][] = ['agent', 'direction'];

export interface AppelsServices {
  db: SqlDatabase;
  acces: Acces;
  journal: JournalStore;
  now: () => Date;
}

export interface AppelsRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  name: string;
  handle: (s: AppelsServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
  if (Number(request.headers.get('content-length') ?? '0') > MAX_APPEL_BODY_BYTES) return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_APPEL_BODY_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Chaque refus de la lecture des appels reçus, dit en mots [R16]. */
export const APPELS_RECUS_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  role: 'Les appels reçus se relisent par l’agent de la fiche ou la direction.',
  not_assigned: 'Les appels reçus sont réservés à l’agent de cette fiche.',
  other_network: 'Cette fiche n’est pas dans votre réseau.',
  agent_file_incomplete: 'Votre dossier d’agent n’est pas complet : les fiches clients restent fermées.',
  unknown: 'Cette fiche n’existe pas.',
  unexpected_field: 'Cette lecture ne prend aucun paramètre.',
});

/** Ce que la route rend d'un appel : jamais la référence de l'enregistrement, seulement s'il y en a un. */
export type AppelRecu = Omit<CallView, 'recordingRef' | 'origin'> & { hasRecording: boolean; originKind: string };

const recu = (v: CallView): AppelRecu => {
  const { recordingRef, origin, ...rest } = v;
  return { ...rest, hasRecording: recordingRef !== null, originKind: origin.kind };
};

const refuseRecus = (status: number, rule: string | null, code: string): Response =>
  json(status, { ok: false, rule, code, message: APPELS_RECUS_REFUSALS[code] ?? 'Les appels reçus ne se lisent pas.' });

export function appelsRoutes(): AppelsRoute[] {
  return [
    {
      method: 'POST',
      pattern: new RegExp(`^/fiches/${ID}/appels$`),
      name: 'fiche.appel.note',
      handle: async (s, viewer, [id], request) => {
        if (!ROLES.includes(viewer.role)) {
          await appendEvent(s.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), code: 'role' } }, s.now);
          return json(403, { ok: false, rule: 'R16', code: 'role' });
        }
        const body = await readJson(request);
        if (!body) return json(400, { ok: false, rule: null, code: 'invalid_body' });
        if (Object.keys(body).some((k) => k !== 'outcome')) return json(400, { ok: false, rule: null, code: 'unexpected_field' });
        const r = await new AppelsFiche(s.db, s.acces, s.journal, { now: s.now }).note(viewer, id!, { outcome: body.outcome });
        if (r.ok) return json(200, { ok: true, mode: 'essai', sent: false, data: r.value });
        const status = r.code === 'unknown' ? 404 : r.rule === 'R16' ? 403 : 400;
        return json(status, { ok: false, rule: r.rule, code: r.code });
      },
    },
    {
      method: 'GET',
      pattern: new RegExp(`^/fiches/${ID}/appels-recus$`),
      name: 'fiche.appels_recus.lire',
      // BR61 · sous les droits de la fiche, refus au journal [R16] ; rien d'autre au journal que la lecture [R13].
      handle: async (s, viewer, [id], request) => {
        if (!ROLES.includes(viewer.role)) {
          await appendEvent(s.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), code: 'role' } }, s.now);
          return refuseRecus(403, 'R16', 'role');
        }
        if ([...new URL(request.url).searchParams.keys()].length > 0) return refuseRecus(400, null, 'unexpected_field');
        const r = await callsOfFiche(s.db, s.acces, viewer, id!);
        if (!r.ok) return refuseRecus(r.code === 'unknown' ? 404 : 403, r.rule, r.code);
        return json(200, { ok: true, data: r.value.map(recu) });
      },
    },
  ];
}
