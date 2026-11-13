/**
 * Les routes des scénarios automatiques (HX24, RC18, RC19), sous `/v1/scenarios`, et leur passage au planificateur
 * (BR55). Les routes des dates des clients (HX25), sous `/v1/dates-clients`, et leur passage juste après (BR56) ;
 * leurs lectures, la date retenue d'une fiche et les textes en service (BR59).
 *
 * Chaque route est réservée à la direction, contrôlée avant toute lecture du corps ; un refus est écrit au journal
 * [R16, R403]. La couche métier refait ses propres contrôles : listes fermées, texte fixe, essai de la version exacte
 * avant l'allumage [R400, R403]. Aucune route n'envoie rien : un message de scénario ne part qu'au passage, par le
 * contrôle central, qui ne reçoit que les canaux du mode essai [R401, R26].
 */
import type { JournalStore, ScheduledJob, SqlDatabase, Viewer } from '@aimmo/core';
import { DatesClients } from '../../core/src/automatismes/dates-clients.ts';
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
function reply(result: ScenarioResult<unknown>, words: (code: string, rule: string | null) => string = refusalWords): Response {
  if (result.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: result.value ?? null });
  const { rule, code } = result;
  const body = { ok: false, rule, code, message: words(code, rule) };
  if (rule === 'R16' && code === 'unknown') return json(404, body);
  if (rule === 'R16') return json(403, body);
  return json(rule ? 409 : 400, body);
}

const badBody = (): Response => json(400, { ok: false, rule: null, code: 'invalid_body', message: 'Corps JSON attendu.' });
const unknownField = (field: string, message = SCENARIO_REFUSALS['unknown_field']): Response => json(400, { ok: false, rule: null, code: 'unknown_field', field, message });

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


/** Les refus des dates des clients, dits en mots [R16, R404, R405]. Les contrôles du texte sont ceux d'un scénario. */
export const DATE_REFUSALS: Readonly<Record<string, string>> = {
  role: 'Seuls l’agent qui suit la fiche et la direction rangent et relisent la date d’un client.',
  not_direction: 'Seule la direction écrit et relit les textes des messages de date.',
  unknown: 'Cette fiche n’existe pas.',
  other_network: 'Cette fiche appartient à un autre réseau.',
  not_assigned: 'Seul l’agent qui suit cette fiche peut y ranger une date.',
  agent_inactive: 'Votre compte d’agent n’est pas actif : rien n’est rangé.',
  agent_file_incomplete: 'Votre dossier d’agent n’est pas complet : aucune fiche client avant.',
  bad_person: 'La fiche attendue est un identifiant.',
  bad_kind: 'Cette sorte de date n’existe pas : anniversaire ou fête.',
  bad_date: 'Cette date n’existe pas : un mois de 1 à 12 et un jour qui existe dans ce mois.',
  no_proof: 'Dites d’où vient la date, en 200 caractères au plus : la personne l’a donnée, jamais devinée ni tirée d’une pièce d’identité.',
  bad_texts: 'Écrivez de un à cinq textes pour cette sorte de date et ce canal.',
  unknown_field: 'Un champ n’est pas prévu pour une date de client.',
};

export function dateRefusalWords(code: string, rule: string | null): string {
  return DATE_REFUSALS[code] ?? refusalWords(code, rule);
}

const DATE_FIELDS = ['personId', 'kind', 'month', 'day', 'proof'] as const;
const DATE_TEXT_FIELDS = ['kind', 'channel', 'texts'] as const;

/** Le module des dates : lui aussi bâtit son contrôle central sur les seuls canaux du mode essai [R26]. */
export const datesOf = (db: SqlDatabase, journal: JournalStore, now: () => Date): DatesClients => new DatesClients(db, journal, { now });

/** Un refus de rôle des dates, au journal comme ceux de la couche métier, avant que le corps soit lu [R16]. */
async function refuseDateRole(s: ScenariosServices, viewer: Viewer, code: string, gesture: string): Promise<Response> {
  await appendEvent(
    s.journal,
    { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: null, data: { rule: 'R16', role: String(viewer.role), kind: 'client_date', code, gesture } },
    s.now,
  );
  return reply({ ok: false, rule: 'R16', code }, dateRefusalWords);
}

/** Les routes de `/v1/dates-clients`, à ajouter à celles de `app.ts` (BR56). Aucune n'envoie rien [R405, R26]. */
export function datesRoutes(): ScenariosRoute[] {
  const route =
    (gesture: string, allowed: (v: Viewer) => boolean, code: string, fields: readonly string[], fn: (s: ScenariosServices, v: Viewer, body: Record<string, unknown>) => Promise<ScenarioResult<unknown>>): ScenariosRoute['handle'] =>
    async (s, v, _params, request) => {
      if (!allowed(v)) return refuseDateRole(s, v, code, gesture);
      const extra = extraQuery(request);
      if (extra !== null) return unknownField(extra, DATE_REFUSALS['unknown_field']);
      const body = await readBody(request);
      if (!body) return badBody();
      const field = Object.keys(body).find((k) => !fields.includes(k));
      if (field !== undefined) return unknownField(field, DATE_REFUSALS['unknown_field']);
      return reply(await fn(s, v, body), dateRefusalWords);
    };
  return [
    {
      method: 'POST',
      pattern: /^\/dates-clients$/,
      name: 'dates_clients.ranger',
      // L'agent qui suit la fiche ou la direction ; la couche métier relit la fiche sous droits [R16, R404].
      handle: route('record', (v) => v.role === 'agent' || v.role === 'direction', 'role', DATE_FIELDS, async (s, v, b) => {
        if (typeof b['personId'] !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(b['personId'])) return { ok: false, rule: 'R404', code: 'bad_person' };
        return datesOf(s.db, s.journal, s.now).recordDate(v, { personId: b['personId'], kind: b['kind'], month: b['month'], day: b['day'], proof: b['proof'] });
      }),
    },
    {
      method: 'POST',
      pattern: /^\/dates-clients\/textes$/,
      name: 'dates_clients.textes',
      // La direction seule écrit les textes, jamais l'IA ; chacun contrôlé comme ceux d'un scénario [R403, R405].
      handle: route('texts', (v) => v.role === 'direction', 'not_direction', DATE_TEXT_FIELDS, async (s, v, b) => datesOf(s.db, s.journal, s.now).setTexts(v, { kind: b['kind'], channel: b['channel'], texts: b['texts'] })),
    },
    {
      method: 'GET',
      pattern: /^\/dates-clients$/,
      name: 'dates_clients.lire',
      // BR59 · les dates retenues d'une fiche : sous les mêmes droits que pour les ranger, fiche lue sous droits [R16, R404].
      handle: async (s, v, _params, request) => {
        if (v.role !== 'agent' && v.role !== 'direction') return refuseDateRole(s, v, 'role', 'read');
        const query = new URL(request.url).searchParams;
        const extra = [...query.keys()].find((k) => k !== 'personId');
        if (extra !== undefined) return unknownField(extra, DATE_REFUSALS['unknown_field']);
        const personId = query.getAll('personId');
        if (personId.length !== 1 || !/^[A-Za-z0-9_-]{1,64}$/.test(personId[0]!)) return reply({ ok: false, rule: 'R404', code: 'bad_person' }, dateRefusalWords);
        return reply(await datesOf(s.db, s.journal, s.now).datesOf(v, personId[0]!), dateRefusalWords);
      },
    },
    {
      method: 'GET',
      pattern: /^\/dates-clients\/textes$/,
      name: 'dates_clients.textes_lire',
      // BR59 · les textes en service, la direction seule [R16, R405].
      handle: async (s, v, _params, request) => {
        if (v.role !== 'direction') return refuseDateRole(s, v, 'not_direction', 'read_texts');
        const extra = extraQuery(request);
        if (extra !== null) return unknownField(extra, DATE_REFUSALS['unknown_field']);
        return reply(await datesOf(s.db, s.journal, s.now).textsInForce(v), dateRefusalWords);
      },
    },
  ];
}

/** Le nom du passage des dates des clients, sans donnée. */
export const DATES_JOB = 'automatismes.dates';

/**
 * Le passage des dates des clients (HX25, BR56), à chaque heure, inscrit juste après celui des scénarios : une place de
 * scénario prise ce jour fait attendre la date [R402]. Pour chaque réseau qui a rangé une date, les messages du jour
 * sont préparés par le contrôle central, en mode essai ; hors des heures permises, rien n'est préparé [R404, R405, R26].
 * Un réseau en panne n'empêche pas les autres ; la première erreur remonte au planificateur [R13].
 */
export function datesJob(db: SqlDatabase, journal: JournalStore, options: { now: () => Date }): ScheduledJob {
  return {
    name: DATES_JOB,
    hours: Array.from({ length: 24 }, (_, h) => h),
    run: async () => {
      const dates = datesOf(db, journal, options.now);
      let failure: unknown = null;
      for (const n of await db.all<{ network_id: string }>('SELECT DISTINCT network_id FROM client_dates ORDER BY network_id')) {
        try {
          await dates.tick(n.network_id);
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure !== null) throw failure;
    },
  };
}
