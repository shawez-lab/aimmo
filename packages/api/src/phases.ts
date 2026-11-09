/**
 * Les routes des conditions de passage des phases (HX69, HX70), sous `/v1/phases` (BR10), et le relevé de chaque nuit.
 *
 * Chaque route passe par les droits de la couche métier [R16] : la direction seule, tout autre rôle est refusé et le
 * refus écrit au journal. Les rapports sont recalculés à chaque lecture [R641, R642, R643] ; rien n'est envoyé.
 * Le relevé d'un jour de Paris fini est un geste du système, jamais d'une route : seul le planificateur le prend, la
 * nuit qui suit, et une seule fois [R643, R17].
 */
import type { JournalStore, ScheduledJob, SqlDatabase, Viewer } from '@aimmo/core';
import { AgentsPilotes, ConditionPhase1 } from '../../core/src/conditions-phases/index.ts';
import { localTime } from '../../core/src/envoi/horaires.ts';
import { addDays } from '../../core/src/facturation/commun.ts';

export const TRIAL_MODE = 'essai';
const MAX_BODY_BYTES = 8_000;
const TZ = 'Europe/Paris';

export interface PhasesServices {
  db: SqlDatabase;
  journal: JournalStore;
  now: () => Date;
}

export interface PhasesRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  handle: (s: PhasesServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...HEADERS } });

type Outcome = { ok: true; value?: unknown } | { ok: false; rule: string | null; code: string };

/** 200 ; 403 pour un refus de droits ; 404 pour un agent inconnu ; 409 pour une règle ; 400 sinon. */
function reply(result: Outcome): Response {
  if (result.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: result.value ?? null });
  const { ok: _ok, ...rest } = result;
  if (result.rule === 'R16') return json(403, { ok: false, ...rest });
  if (/inconnu$/.test(result.code)) return json(404, { ok: false, ...rest });
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

const badBody = (): Response => json(400, { ok: false, rule: null, code: 'invalid_body', message: 'Corps JSON attendu.' });

const pilotes = (s: PhasesServices) => new AgentsPilotes(s.db, s.journal, { now: s.now });
const phase1 = (s: PhasesServices) => new ConditionPhase1(s.db, s.journal, { now: s.now });

/** Les routes de `/v1/phases`, à ajouter à celles de `app.ts`. */
export function phasesRoutes(): PhasesRoute[] {
  type Handler = (s: PhasesServices, v: Viewer, body: Record<string, unknown>) => Promise<Response>;
  // Le corps est lu après les droits : un autre rôle est refusé et écrit au journal même sans corps lisible [R16].
  // La couche métier vérifie le rôle avant de regarder le corps : un corps vide suffit à écrire le refus.
  const withBody = (fn: Handler): PhasesRoute['handle'] => async (s, v, _params, request) => {
    if (v.role !== 'direction') return fn(s, v, {});
    const body = await readJson(request);
    if (!body) return badBody();
    return fn(s, v, body);
  };
  const P = '^/phases';
  return [
    // Agents pilotes, condition de la phase 3 (HX69).
    { method: 'GET', pattern: new RegExp(`${P}/pilotes$`), name: 'phases.pilotes', handle: async (s, v) => reply(await pilotes(s).report(v)) },
    { method: 'POST', pattern: new RegExp(`${P}/pilotes$`), name: 'phases.pilotes.designer', handle: withBody(async (s, v, b) => reply(await pilotes(s).designate(v, b))) },
    { method: 'POST', pattern: new RegExp(`${P}/pilotes/avant$`), name: 'phases.pilotes.avant', handle: withBody(async (s, v, b) => reply(await pilotes(s).declareBefore(v, b))) },
    // Condition de la phase 1 (HX70).
    { method: 'GET', pattern: new RegExp(`${P}/phase1$`), name: 'phases.phase1', handle: async (s, v) => reply(await phase1(s).report(v)) },
    { method: 'POST', pattern: new RegExp(`${P}/phase1/envois-hors-aimmo$`), name: 'phases.phase1.envoi_hors_aimmo', handle: withBody(async (s, v, b) => reply(await phase1(s).declareOutsideSend(v, b))) },
    { method: 'POST', pattern: new RegExp(`${P}/phase1/inventaire$`), name: 'phases.phase1.inventaire', handle: withBody(async (s, v, b) => reply(await phase1(s).declareInventory(v, b))) },
  ];
}

/** Le nom du passage du relevé de la phase 1, sans donnée. */
export const PHASE1_READING_JOB = 'phases.releve_phase1';

/**
 * Le relevé de la veille (HX70), au planificateur : au premier passage de la nuit, de minuit à 3 h de Paris, le jour de
 * Paris qui vient de finir est figé pour chaque réseau. Un relevé déjà pris est rendu sans rien changer ; un jour
 * manqué n'est jamais rattrapé plus tard, il reste « sans donnée » et jamais propre [R643, R17]. Un réseau en panne
 * n'empêche pas les autres ; la première erreur remonte au planificateur, qui l'écrit au journal [R13].
 */
export function phase1ReadingJob(db: SqlDatabase, journal: JournalStore, options: { now: () => Date }): ScheduledJob {
  return {
    name: PHASE1_READING_JOB,
    hours: [0, 1, 2, 3],
    run: async () => {
      const day = addDays(localTime(options.now(), TZ).date, -1);
      const condition = new ConditionPhase1(db, journal, { now: options.now });
      let failure: unknown = null;
      for (const n of await db.all<{ id: string }>('SELECT id FROM networks ORDER BY id')) {
        try {
          const r = await condition.takeReading(n.id, day);
          if (!r.ok) failure ??= new Error(`Relevé refusé : ${r.code}`);
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure !== null) throw failure;
    },
  };
}
