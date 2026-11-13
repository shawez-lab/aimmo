/**
 * Les routes des scénarios automatiques (HX24, RC18, RC19), sous `/v1/scenarios`, et leur passage au planificateur
 * (BR55).
 *
 * Chaque route est réservée à la direction, contrôlée avant toute lecture du corps ; un refus est écrit au journal
 * [R16, R403]. La couche métier refait ses propres contrôles : listes fermées, texte fixe, essai de la version exacte
 * avant l'allumage [R400, R403]. Aucune route n'envoie rien : un message de scénario ne part qu'au passage, par le
 * contrôle central, qui ne reçoit que les canaux du mode essai [R401, R26].
 */
import type { JournalStore, ScheduledJob, SqlDatabase, Viewer } from '@aimmo/core';
import { ScenariosAutomatiques, type ScenarioResult } from '../../core/src/automatismes/scenarios.ts';
import { appendEvent } from '../../core/src/journal/journal.ts';

export const TRIAL_MODE = 'essai';
/** Un nom, un texte de 4 000 caractères au plus, une tâche, et leur enveloppe. */
const MAX_BODY_BYTES = 16_384;
const ID = '([A-Za-z0-9_-]{1,64})';
const DEFINITION_FIELDS = ['name', 'trigger', 'projectKind', 'waitHours', 'message', 'task'] as const;

export interface ScenariosServices {
  db: SqlDatabase;
  journal: JournalStore;
  now: () => Date;
}

export interface ScenariosRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  handle: (s: ScenariosServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...HEADERS } });

/** Chaque refus dit en mots, pour l'écran comme pour un humain qui lit la réponse [R16]. */
export const SCENARIO_REFUSALS: Readonly<Record<string, string>> = {
  not_direction: 'Seule la direction compose, essaie, allume et arrête un scénario.',
  unknown: 'Ce scénario n’existe pas dans votre réseau.',
  bad_definition: 'Le scénario attendu est un objet : nom, déclencheur, attente, message, tâche.',
  unknown_field: 'Un champ n’est pas prévu dans un scénario.',
  bad_name: 'Le nom du scénario est obligatoire, en 80 caractères au plus.',
  bad_trigger: 'Ce déclencheur n’existe pas : nouveau contact, nouveau projet, visite faite ou mandat signé.',
  bad_project_kind: 'Le type de projet ne se choisit que pour un nouveau projet, dans la liste des types.',
  bad_wait: 'L’attente est un nombre entier d’heures, de zéro à quatre-vingt-dix jours.',
  bad_message: 'Le message attendu a un canal et un texte.',
  bad_channel: 'Ce canal n’existe pas : mail, SMS ou WhatsApp.',
  bad_text: 'Le texte du message est obligatoire.',
  first_name_slot: 'Le texte porte le prénom une seule fois, écrit {prenom}, et aucune autre accolade.',
  text_length: 'Le texte est trop long pour ce canal, mention comprise.',
  bad_task: 'La tâche attendue a un titre et un délai.',
  bad_task_title: 'Le titre de la tâche est obligatoire, en 120 caractères au plus.',
  bad_task_due: 'Le délai de la tâche est un nombre entier de jours, de zéro à trente.',
  empty_scenario: 'Un scénario a au moins un message ou une tâche.',
  not_simulated: 'Essayez d’abord cette version sur le mois passé : sans essai, rien ne s’allume.',
  simulation_too_old: 'Le dernier essai a plus de vingt-quatre heures : refaites l’essai avant d’allumer.',
  simulation_before_last_switch_on: 'Un autre scénario a été allumé depuis cet essai : refaites l’essai avant d’allumer.',
  same_day_twice: 'L’essai montre deux messages automatiques le même jour à une même personne : ce scénario ne peut pas être allumé.',
};

/** Les contrôles du texte, par règle : le code `text_R..` dit la règle du contrôle central que le texte enfreint. */
const TEXT_RULES: Readonly<Record<string, string>> = {
  R06: 'Le texte ne parle pas de l’IA : seule la mention légale du premier message le fait.',
  R07: 'On écrit « offert », jamais « gratuit », et « agent immobilier », jamais « mandataire ».',
  R08: 'Le texte vouvoie la personne par son prénom, sans « Salut », sans parenthèses ni formule administrative.',
  R09: 'Le texte ne porte ni adresse exacte ni nom de client.',
  R10: 'Un texte fixe ne porte aucun chiffre : ni prix, ni surface, ni date, ni remise.',
  R19: 'Le texte ne porte jamais le nom d’un vendeur.',
  R62: 'AIMMO ne demande jamais de paiement et ne donne jamais de coordonnée bancaire.',
}

/** Les mots d'un refus : connus, ou une phrase prudente qui ne cache pas la règle. */
export function refusalWords(code: string, rule: string | null): string {
  const known = SCENARIO_REFUSALS[code];
  if (known) return known;
  const text = /^text_(R\d+)$/.exec(code);
  if (text) return TEXT_RULES[text[1]!] ?? `Le texte enfreint la règle ${text[1]!} du contrôle des envois.`;
  return rule ? `Refusé par la règle ${rule}.` : 'Demande refusée.';
}

/** 200 ; 403 pour un refus de droits ; 404 inconnu ; 409 pour une règle ; 400 sinon. Toujours avec ses mots. */
function reply(result: ScenarioResult<unknown>): Response {
  if (result.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: result.value ?? null });
  const { rule, code } = result;
  const body = { ok: false, rule, code, message: refusalWords(code, rule) };
  if (rule === 'R16' && code === 'unknown') return json(404, body);
  if (rule === 'R16') return json(403, body);
  return json(rule ? 409 : 400, body);
}

const badBody = (): Response => json(400, { ok: false, rule: null, code: 'invalid_body', message: 'Corps JSON attendu.' });
const unknownField = (field: string): Response => json(400, { ok: false, rule: null, code: 'unknown_field', field, message: SCENARIO_REFUSALS['unknown_field'] });

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
async function refuseRole(s: ScenariosServices, viewer: Viewer, gesture: string): Promise<Response> {
  await appendEvent(
    s.journal,
    { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'automation_scenario', code: 'not_direction', gesture } },
    s.now,
  );
  return reply({ ok: false, rule: 'R16', code: 'not_direction' });
}

/** Aucun paramètre de requête n'est prévu : le premier venu est refusé. */
function extraQuery(request: Request): string | null {
  for (const k of new URL(request.url).searchParams.keys()) return k;
  return null;
}

/** Le module des scénarios : il bâtit lui-même son contrôle central sur les seuls canaux du mode essai [R401, R26]. */
export const scenariosOf = (db: SqlDatabase, journal: JournalStore, now: () => Date): ScenariosAutomatiques => new ScenariosAutomatiques(db, journal, { now });

/** Les routes de `/v1/scenarios`, à ajouter à celles de `app.ts`. */
export function scenariosRoutes(): ScenariosRoute[] {
  /**
   * La direction d'abord ; puis le corps, avec ses seuls champs prévus. Un geste sans corps (`fields` vide) n'accepte que
   * `{}` ou rien.
   */
  const direction =
    (gesture: string, fields: readonly string[], fn: (s: ScenariosServices, v: Viewer, params: string[], body: Record<string, unknown>) => Promise<ScenarioResult<unknown>>): ScenariosRoute['handle'] =>
    async (s, v, params, request) => {
      if (v.role !== 'direction') return refuseRole(s, v, gesture);
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
      return reply(await fn(s, v, params, body));
    };
  const S = (db: ScenariosServices) => scenariosOf(db.db, db.journal, db.now);

  return [
    {
      method: 'GET',
      pattern: /^\/scenarios$/,
      name: 'scenarios.liste',
      handle: direction('list', [], async (s, v) => S(s).list(v)),
    },
    {
      method: 'POST',
      pattern: /^\/scenarios$/,
      name: 'scenarios.composer',
      // Le corps est la définition elle-même ; la couche métier la relit champ par champ, en listes fermées [R403].
      handle: direction('compose', DEFINITION_FIELDS, async (s, v, _p, b) => S(s).compose(v, b)),
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/scenarios/${ID}$`),
      name: 'scenarios.nouvelle_version',
      handle: direction('compose', DEFINITION_FIELDS, async (s, v, [id], b) => S(s).compose(v, b, id!)),
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/scenarios/${ID}/essai$`),
      name: 'scenarios.essai',
      // L'essai rejoue le mois passé et n'envoie rien [R400].
      handle: direction('simulate', [], async (s, v, [id]) => S(s).simulate(v, id!)),
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/scenarios/${ID}/allumer$`),
      name: 'scenarios.allumer',
      handle: direction('switch_on', [], async (s, v, [id]) => S(s).switchOn(v, id!)),
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/scenarios/${ID}/eteindre$`),
      name: 'scenarios.eteindre',
      handle: direction('switch_off', [], async (s, v, [id]) => S(s).switchOff(v, id!)),
    },
  ];
}

/** Le nom du passage des scénarios, sans donnée. */
export const SCENARIOS_JOB = 'automatismes.scenarios';

/**
 * Le passage des scénarios (HX24, BR55), à chaque heure : pour chaque réseau qui a au moins un allumage, les faits venus
 * depuis l'allumage sont rangés une fois, puis les passages dus sont faits. Un message attend la prochaine heure
 * permise et ne part que par le contrôle central, sur les canaux du mode essai : rien ne part vers une personne
 * [R401, R402, R05, R26]. Le planificateur ne passe que s'il est lui-même en mode essai. Un réseau en panne n'empêche
 * pas les autres ; la première erreur remonte au planificateur, qui l'écrit au journal [R13].
 */
export function scenariosJob(db: SqlDatabase, journal: JournalStore, options: { now: () => Date }): ScheduledJob {
  return {
    name: SCENARIOS_JOB,
    hours: Array.from({ length: 24 }, (_, h) => h),
    run: async () => {
      const scenarios = scenariosOf(db, journal, options.now);
      let failure: unknown = null;
      for (const n of await db.all<{ network_id: string }>('SELECT DISTINCT network_id FROM automation_switches WHERE lit = 1 ORDER BY network_id')) {
        try {
          await scenarios.tick(n.network_id);
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure !== null) throw failure;
    },
  };
}
