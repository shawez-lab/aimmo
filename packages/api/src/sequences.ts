/**
 * Les routes de la séquence de prospection sur plusieurs canaux (HX20), sous `/v1/sequences`, et son passage au
 * planificateur (BR31).
 *
 * Chaque route est réservée à l'agent, contrôlée avant toute lecture du corps ; un refus est écrit au journal [R16]. La
 * couche métier refait ses propres contrôles (agent en activité, fiche à lui, oppositions). Rien ne part d'une route :
 * un mail ou un SMS ne part qu'au passage, par le contrôle central, qui ne reçoit d'ici que les canaux du mode essai
 * [R300, R26]. La séquence s'arrête d'elle-même sur tous les canaux à la première réponse ou opposition [R301]. Un appel
 * n'est proposé que si le bouton d'appel de la fiche est ouvert ; la liste d'opposition au démarchage (Bloctel) n'est
 * pas encore branchée (H61) : un appel qui ne repose que sur la prospection n'est donc jamais proposé [R302].
 */
import {
  Acces,
  AppelsFiche,
  ControleEnvois,
  DecisionEnvoi,
  FicheAgent,
  FicheClient,
  FicheUnique,
  SqlSendJournal,
  sequenceProspection,
  trialChannels,
  type JournalStore,
  type ScheduledJob,
  type SqlDatabase,
  type Viewer,
} from '@aimmo/core';
import { appendEvent } from '../../core/src/journal/journal.ts';

export const TRIAL_MODE = 'essai';
/** Huit étapes de mille caractères au plus, et leur enveloppe. */
const MAX_BODY_BYTES = 16_384;
const ID = '([A-Za-z0-9_-]{1,64})';
const STEP_FIELDS = ['channel', 'afterDays', 'text'] as const;

export interface SequencesServices {
  db: SqlDatabase;
  journal: JournalStore;
  acces: Acces;
  now: () => Date;
  /** La liste d'opposition au démarchage (Bloctel) ; absente tant que H61 n'est pas fait. */
  opposition: sequenceProspection.OppositionList | null;
}

export interface SequencesRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  handle: (s: SequencesServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...HEADERS } });

type Outcome = { ok: true; value?: unknown } | { ok: false; rule?: string | null; code: string };

/** 200 ; 403 pour un refus de droits ; 404 inconnu ; 409 pour une règle ; 400 sinon. */
function reply(result: Outcome): Response {
  if (result.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: result.value ?? null });
  const { rule = null, code } = result;
  if (rule === 'R16' && code === 'unknown') return json(404, { ok: false, rule, code });
  if (rule === 'R16') return json(403, { ok: false, rule, code });
  return json(rule ? 409 : 400, { ok: false, rule, code });
}

const badBody = (): Response => json(400, { ok: false, rule: null, code: 'invalid_body', message: 'Corps JSON attendu.' });
const unknownField = (field: string): Response => json(400, { ok: false, rule: null, code: 'unknown_field', field });

/** Le corps : vide, il vaut `{}` ; sinon un objet JSON de taille bornée, ou null. */
async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return null;
  if (text.trim() === '') return {};
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Le refus d'un rôle, écrit au journal comme ceux de la couche métier, avant que le corps soit lu [R16]. */
async function refuseRole(s: SequencesServices, viewer: Viewer): Promise<Response> {
  await appendEvent(
    s.journal,
    { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'sequence_prospection', code: 'role' } },
    s.now,
  );
  return json(403, { ok: false, rule: 'R16', code: 'role' });
}

/**
 * Le module de la séquence, avec un contrôle central qui ne reçoit que les canaux du mode essai : rien ne part vers une
 * personne, d'une route comme du passage [R300, R26].
 */
export function sequencesOf(db: SqlDatabase, journal: JournalStore, acces: Acces, now: () => Date, opposition: sequenceProspection.OppositionList | null): sequenceProspection.SequencesProspection {
  const store = new FicheClient(db, { now });
  const unique = new FicheUnique(db, store, { now });
  const controle = new ControleEnvois(db, unique, new DecisionEnvoi(db, store, unique, { now }), { channels: trialChannels(db, journal, now), journal: new SqlSendJournal(db, undefined, now), now });
  return new sequenceProspection.SequencesProspection(db, acces, unique, controle, new FicheAgent(db, acces, { now }), new AppelsFiche(db, acces, journal, { now }), journal, {
    now,
    ...(opposition ? { opposition } : {}),
  });
}

const seq = (s: SequencesServices) => sequencesOf(s.db, s.journal, s.acces, s.now, s.opposition);

/** Les étapes du corps, vérifiées champ par champ ; la couche métier refait ses contrôles de règle [HX20]. */
function readSteps(raw: unknown): { ok: true; steps: sequenceProspection.StepInput[] } | { ok: false; field: string | null } {
  if (!Array.isArray(raw)) return { ok: false, field: null };
  const steps: sequenceProspection.StepInput[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return { ok: false, field: null };
    const o = item as Record<string, unknown>;
    const extra = Object.keys(o).find((k) => !(STEP_FIELDS as readonly string[]).includes(k));
    if (extra !== undefined) return { ok: false, field: extra };
    if (typeof o['channel'] !== 'string' || typeof o['afterDays'] !== 'number' || (o['text'] !== undefined && typeof o['text'] !== 'string')) return { ok: false, field: null };
    steps.push({ channel: o['channel'] as sequenceProspection.SequenceChannel, afterDays: o['afterDays'], ...(o['text'] === undefined ? {} : { text: o['text'] as string }) });
  }
  return { ok: true, steps };
}

/** Aucun paramètre de requête n'est prévu : le premier venu est refusé. */
function extraQuery(request: Request): string | null {
  for (const k of new URL(request.url).searchParams.keys()) return k;
  return null;
}

/** Les routes de `/v1/sequences`, à ajouter à celles de `app.ts`. */
export function sequencesRoutes(): SequencesRoute[] {
  /** L'agent d'abord ; puis le corps, avec ses seuls champs prévus. */
  const agent =
    (fields: readonly string[], fn: (s: SequencesServices, v: Viewer, params: string[], body: Record<string, unknown>) => Promise<Response | Outcome>): SequencesRoute['handle'] =>
    async (s, v, params, request) => {
      if (v.role !== 'agent') return refuseRole(s, v);
      const extra = extraQuery(request);
      if (extra !== null) return unknownField(extra);
      let body: Record<string, unknown> = {};
      if (request.method === 'POST') {
        const read = await readBody(request);
        if (!read) return badBody();
        body = read;
        const field = Object.keys(body).find((k) => !fields.includes(k));
        if (field !== undefined) return unknownField(field);
      }
      const out = await fn(s, v, params, body);
      return out instanceof Response ? out : reply(out);
    };

  return [
    {
      method: 'POST',
      pattern: /^\/sequences$/,
      name: 'sequences.preparer',
      handle: agent(['personId', 'steps'], async (s, v, _p, b) => {
        if (typeof b['personId'] !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(b['personId'])) return badBody();
        const steps = readSteps(b['steps']);
        if (!steps.ok) return steps.field ? unknownField(steps.field) : badBody();
        // Rien ne part ici : la séquence est préparée, le passage remettra au contrôle central ce qui sera dû [R300].
        return seq(s).start(v, { personId: b['personId'], steps: steps.steps });
      }),
    },
    {
      method: 'GET',
      pattern: /^\/sequences\/jour$/,
      name: 'sequences.jour',
      handle: agent([], async (s, v) => seq(s).today(v)),
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/sequences/etapes/${ID}/fait$`),
      name: 'sequences.fait',
      handle: agent(['callOutcome'], async (s, v, [stepId], b) => {
        const outcome = b['callOutcome'];
        if (outcome !== undefined && outcome !== 'called' && outcome !== 'refused') return badBody();
        return seq(s).markDone(v, stepId!, outcome === undefined ? {} : { callOutcome: outcome });
      }),
    },
  ];
}

/** Le nom du passage des séquences, sans donnée. */
export const SEQUENCES_JOB = 'sequences.passage';

/**
 * Le passage des séquences (HX20, BR31), de 9 h à 19 h du lundi au samedi : chaque séquence en cours est arrêtée si elle
 * doit l'être, puis ses mails et SMS dus sont remis au contrôle central, qui redécide heures, plafond et accords au
 * moment même. Les canaux sont ceux du mode essai : rien ne part vers une personne [R300, R301, R26].
 */
export function sequencesJob(db: SqlDatabase, journal: JournalStore, options: { now: () => Date; opposition?: sequenceProspection.OppositionList | null }): ScheduledJob {
  return {
    name: SEQUENCES_JOB,
    hours: [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
    weekdays: [1, 2, 3, 4, 5, 6],
    run: async () => {
      const store = new FicheClient(db, { now: options.now });
      const acces = new Acces(db, store, new FicheUnique(db, store, { now: options.now }), journal, { now: options.now });
      await sequencesOf(db, journal, acces, options.now, options.opposition ?? null).run();
    },
  };
}
