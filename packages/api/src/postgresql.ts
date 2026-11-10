/**
 * Les routes des seuils du passage à PostgreSQL (HX66, BR25), sous `/v1/postgresql`, et le relevé de chaque semaine.
 *
 * Les nombres couvrent toute la base : seule la direction du réseau qui exploite la plateforme (`PLATFORM_NETWORK_ID`)
 * relève, lit et décide ; tout autre rôle, la direction d'un autre réseau, et tout le monde sans ce réglage, sont
 * refusés par la couche métier et le refus écrit au journal [R16]. Une mesure absente ou en échec est « inconnue »,
 * jamais « sous le seuil » [R630] ; rien ne bascule seul, le passage lui-même reste un geste humain [R631].
 *
 * Lecture prudente : le rapport chronométré est le tableau du réseau de la plateforme (M13) sur la plus longue période
 * permise, lu sous l'acteur du système. Un tableau refusé est une mesure en échec, jamais un rapport rapide [R630].
 */
import type { JournalStore, ScheduledJob, SqlDatabase, Viewer } from '@aimmo/core';
import { pilotage } from '@aimmo/core';
import { PassagePostgresql } from '../../core/src/passage-postgresql/index.ts';
import { MAX_PERIOD_DAYS } from '../../core/src/pilotage/tableau-agent.ts';
import { localTime } from '../../core/src/envoi/horaires.ts';
import { addDays } from '../../core/src/facturation/commun.ts';

export const TRIAL_MODE = 'essai';
const MAX_BODY_BYTES = 8_000;
const TZ = 'Europe/Paris';
/** L'acteur du rapport chronométré : le système, jamais une personne. */
export const POSTGRES_REPORT_ACTOR = 'systeme-passage-postgresql';

export interface PostgresqlServices {
  db: SqlDatabase;
  journal: JournalStore;
  now: () => Date;
  /** Le réseau qui exploite la plateforme (`PLATFORM_NETWORK_ID`) ; absent, tout est refusé [R16]. */
  platformNetworkId: string | null;
}

export interface PostgresqlRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal. */
  name: string;
  handle: (s: PostgresqlServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...HEADERS } });

type Outcome = { ok: true; value?: unknown } | { ok: false; rule: string | null; code: string };

/** 200 ; 403 pour un refus de droits ; 409 pour une règle ; 400 sinon. */
function reply(result: Outcome): Response {
  if (result.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: result.value ?? null });
  const { ok: _ok, ...rest } = result;
  if (result.rule === 'R16') return json(403, { ok: false, ...rest });
  return json(result.rule ? 409 : 400, { ok: false, ...rest });
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

/**
 * Le rapport du réseau à chronométrer : le tableau du réseau de la plateforme sur 366 jours finis aujourd'hui (jour de
 * Paris). Un refus ou une période refusée lève une erreur : la mesure est alors en échec, jamais rapide [R630].
 */
export function networkReport(db: SqlDatabase, journal: JournalStore, platformNetworkId: string, now: () => Date): () => Promise<unknown> {
  return async () => {
    const to = localTime(now(), TZ).date;
    const from = addDays(to, -(MAX_PERIOD_DAYS - 1));
    const viewer = { role: 'direction', networkId: platformNetworkId, userId: POSTGRES_REPORT_ACTOR } as Viewer;
    const r = await new pilotage.TableauReseau(db, journal, { now }).of(viewer, { from, to });
    if (!r.ok) throw new Error(`Rapport du réseau refusé : ${r.code}`);
    return r.value;
  };
}

/** Les seuils, avec le réseau de la plateforme et le rapport chronométré quand il est réglé. */
export function passagePostgresql(db: SqlDatabase, journal: JournalStore, platformNetworkId: string | null, now: () => Date): PassagePostgresql {
  return new PassagePostgresql(db, journal, {
    now,
    ...(platformNetworkId ? { platformNetworkId, networkReport: networkReport(db, journal, platformNetworkId, now) } : {}),
  });
}

const seuils = (s: PostgresqlServices) => passagePostgresql(s.db, s.journal, s.platformNetworkId, s.now);

/** Les routes de `/v1/postgresql`, à ajouter à celles de `app.ts`. */
export function postgresqlRoutes(): PostgresqlRoute[] {
  const P = '^/postgresql';
  return [
    // L'état des seuils, leurs alertes, la décision en cours et le jour estimé de chaque seuil [R630, R631, R632].
    { method: 'GET', pattern: new RegExp(`${P}$`), name: 'postgresql.etat', handle: async (s, v) => reply(await seuils(s).state(v)) },
    // Un relevé demandé par la direction : il est rangé et ne change plus [R630].
    { method: 'POST', pattern: new RegExp(`${P}/releve$`), name: 'postgresql.releve', handle: async (s, v) => reply(await seuils(s).measureNow(v)) },
    // « passer » ou « attendre », seulement après un seuil franchi ; rien ne bascule seul [R631].
    {
      method: 'POST',
      pattern: new RegExp(`${P}/decision$`),
      name: 'postgresql.decision',
      handle: async (s, v, _params, request) => {
        // Les droits d'abord : un autre rôle ou un autre réseau est refusé et écrit au journal, même sans corps lisible
        // [R16]. Le choix vide ne passe jamais la vérification du choix.
        if (v.role !== 'direction' || !s.platformNetworkId || v.networkId !== s.platformNetworkId) return reply(await seuils(s).decide(v, null));
        const body = await readJson(request);
        if (!body) return json(400, { ok: false, rule: null, code: 'invalid_body', message: 'Corps JSON attendu.' });
        const extra = Object.keys(body).filter((k) => k !== 'choice');
        if (extra.length > 0) return json(400, { ok: false, rule: null, code: 'unknown_field', message: `Champ non prévu : ${extra.join(', ')}.` });
        return reply(await seuils(s).decide(v, body.choice));
      },
    },
  ];
}

/** Le nom du passage des seuils, sans donnée. */
export const POSTGRES_READING_JOB = 'postgresql.releve';

/**
 * Le relevé des seuils (HX66), au planificateur : chaque lundi à 4 h de Paris, une fois. Un relevé manqué n'est pas
 * rattrapé : au-delà de 8 jours sans relevé, l'état n'est plus jamais « sous les seuils » [R630]. Rien n'est envoyé.
 */
export function postgresReadingJob(db: SqlDatabase, journal: JournalStore, options: { now: () => Date; platformNetworkId: string | null }): ScheduledJob {
  return {
    name: POSTGRES_READING_JOB,
    hours: [4],
    weekdays: [1],
    run: async () => {
      await passagePostgresql(db, journal, options.platformNetworkId, options.now).measureScheduled();
    },
  };
}
