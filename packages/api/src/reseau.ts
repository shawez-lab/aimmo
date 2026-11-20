/**
 * Les routes de M14 Réseau et académie (J12), sous `/v1/reseau`.
 *
 * Chaque route passe par les droits de la couche métier [R16], qui écrit chaque refus au journal : la direction lit les
 * candidatures, décide des entrées, range les pièces des autres et les départs ; un agent lit son dossier, sa formation,
 * ses primes et ses dossiers couverts, jamais ceux d'un autre. Aucune route ne note, ne classe ni ne trie un candidat
 * [R81] : la liste vient de la couche métier dans l'ordre d'arrivée, rendue telle quelle. Aucun texte de recrutement ne
 * passe sans le contrôle des promesses de revenus [R80]. Rien n'est envoyé d'ici : les réponses aux candidats restent
 * dans la boîte d'essai.
 *
 * Le branchement dans le socle (J13) : ces routes suivent celles de `app.ts`, qui refuse d'abord un agent parti et,
 * hors des routes de son intégration, un agent au dossier incomplet.
 */
import { DecisionEnvoi, FicheClient, FicheUnique, appendEvent, type JournalStore, type SqlDatabase, type Viewer } from '@aimmo/core';
import {
  AccesSortie,
  Academie,
  Accompagnement,
  BacASable,
  Candidatures,
  Departs,
  DossierAgent,
  Entrainement,
  Entretiens,
  ImportAgent,
  Parrainage,
  ReponsesCandidats,
  AGENT_PIECE_MAX_BYTES,
  type AgentPieceExt,
  type AgentPieceStore,
  type BacASableOptions,
  type ObjectionCoach,
} from '../../core/src/reseau/index.ts';

/** Le stockage R2 des pièces des dossiers d'agent : l'existence d'une référence, et le rangement d'un projet. */
export interface R2AgentBucket {
  head(key: string): Promise<unknown | null>;
  put(key: string, value: string | Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get?(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; httpMetadata?: { contentType?: string } } | null>;
}

/**
 * Les pièces des dossiers d'agent dans le compartiment R2 des pièces, sous `agents/<agent>/` (J13). Un projet préparé
 * par le réseau y est rangé sous un nom tiré au hasard ; aucun contenu n'est jamais relu d'ici.
 */
export class R2AgentPieceStore implements AgentPieceStore {
  constructor(
    private readonly bucket: R2AgentBucket,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  async has(ref: string): Promise<boolean> {
    return (await this.bucket.head(ref)) !== null;
  }

  async putDraft(agentId: string, text: string): Promise<string> {
    const ref = `agents/${agentId}/${this.newId()}.txt`;
    await this.bucket.put(ref, text, { httpMetadata: { contentType: 'text/plain; charset=utf-8' } });
    return ref;
  }

  /** Relit une pièce pour l'accès de sortie (AU111) : ses octets et son type ; absente, `null`. */
  async read(ref: string): Promise<{ body: Uint8Array; contentType: string } | null> {
    const object = this.bucket.get ? await this.bucket.get(ref) : null;
    if (!object) return null;
    return { body: new Uint8Array(await object.arrayBuffer()), contentType: object.httpMetadata?.contentType ?? 'application/octet-stream' };
  }

  /** AU024 · Le fichier d'une pièce déposée depuis l'écran, sous un nom tiré au hasard ; jamais relu d'ici. */
  async putFile(agentId: string, bytes: Uint8Array, ext: AgentPieceExt, contentType: string): Promise<string> {
    const ref = `agents/${agentId}/${this.newId()}.${ext}`;
    await this.bucket.put(ref, bytes, { httpMetadata: { contentType } });
    return ref;
  }
}

/**
 * AU024 · Le fichier d'une pièce, lu dans le corps brut sans jamais dépasser le poids admis : la longueur annoncée
 * d'abord, puis les octets reçus, par morceaux.
 */
async function readPieceFile(request: Request): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const contentType = request.headers.get('content-type') ?? '';
  const announced = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(announced) && announced > AGENT_PIECE_MAX_BYTES) return null;
  if (!request.body) return { bytes: new Uint8Array(0), contentType };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > AGENT_PIECE_MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return { bytes, contentType };
}

export const TRIAL_MODE = 'essai';
const MAX_BODY_BYTES = 16_000;
/** Un import tient dans un export de quelques milliers de lignes : au-delà, il est refusé sans rien ranger. */
const MAX_IMPORT_BYTES = 2_000_000;
const ID = '([A-Za-z0-9_-]{1,64})';

export interface ReseauServices {
  db: SqlDatabase;
  journal: JournalStore;
  now: () => Date;
}

export interface ReseauOptions {
  /** Le stockage des pièces des dossiers d'agent. Absent : les routes des pièces répondent « indisponible ». */
  pieces?: AgentPieceStore | null;
  /** L'IA de l'entraînement aux objections. Absente : les répliques écrites des cas, toujours. */
  coach?: ObjectionCoach;
  /** Le bac à sable, avec son stockage à part. Absent : sa progression répond « indisponible ». */
  sandbox?: Omit<BacASableOptions, 'now'> | null;
}

export interface ReseauRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  handle: (s: ReseauServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...HEADERS } });

type Outcome = { ok: true; [k: string]: unknown } | { ok: false; rule: string | null; code: string; [k: string]: unknown };

/** 200 ; 403 pour un refus de droits (404 pour un inconnu) ; 409 pour une autre règle ; 404 pour un objet inconnu ; 400 sinon. */
export function reply(result: Outcome): Response {
  if (result.ok) {
    const { ok: _ok, value, ...rest } = result as { ok: true; value?: unknown; [k: string]: unknown };
    return json(200, { ok: true, mode: TRIAL_MODE, data: value ?? null, ...rest });
  }
  const { ok: _ok, ...rest } = result;
  if (result.rule === 'R16') return json(/^unknown/.test(result.code) ? 404 : 403, { ok: false, ...rest });
  if (result.rule) return json(409, { ok: false, ...rest });
  // Un objet inconnu est un 404 ; une valeur inconnue (format, champ) reste une demande mal formée.
  if (/^unknown(?!_(?:format|field|kind|topic|track))/.test(result.code) || result.code === 'not_found') return json(404, { ok: false, ...rest });
  return json(400, { ok: false, ...rest });
}

async function readJson(request: Request, max = MAX_BODY_BYTES): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).length > max) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const badBody = (): Response => json(400, { ok: false, rule: null, code: 'invalid_body', message: 'Corps JSON attendu.' });
const unavailable = (what: string): Response => json(503, { ok: false, rule: null, code: 'unavailable', message: `${what} n’est pas encore en service.` });

/** Les seules clés admises dans un corps : une clé de plus est refusée, sans rien ranger. */
const only = (body: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(body).every((k) => keys.includes(k));

/**
 * Qui peut appeler une route, contrôlé avant tout le reste : `direction` ; `self`, la direction ou l'agent dont
 * l'identifiant est dans l'adresse ; les variantes `_or_compliance` ajoutent la lecture par la conformité ; `member`,
 * tout rôle du réseau sauf un partenaire, la couche métier décidant du reste. Un partenaire n'a aucune route de M14.
 */
type Access = 'direction' | 'direction_or_compliance' | 'self' | 'self_or_compliance' | 'member';

const ACCESS: Readonly<Record<string, Access>> = Object.freeze({
  candidatures: 'direction',
  fiche_entretien: 'direction',
  entretien: 'direction',
  entretien_tenu: 'direction',
  decision: 'direction',
  reponses_candidat: 'direction',
  reponses: 'direction',
  reponse_ecrite: 'direction',
  questions: 'direction',
  question_faite: 'direction',
  admettre: 'direction',
  projet_piece: 'direction',
  import_direction: 'direction',
  module: 'direction',
  seance: 'direction',
  presence: 'direction',
  formation_periode: 'direction',
  formation_anterieure: 'direction',
  referent: 'direction',
  binome: 'direction',
  assistance_repondue: 'direction',
  parrainage_regles: 'direction',
  parrain: 'direction',
  depart_range: 'direction',
  depart_annule: 'direction',
  successeur: 'direction',
  successeur_decision: 'direction',
  reprises: 'direction',
  reprise: 'direction',
  depart: 'direction_or_compliance',
  acces_sortie: 'direction',
  acces_sortie_retrait: 'direction',
  solde: 'direction_or_compliance',
  contenus: 'direction_or_compliance',
  dossier: 'self_or_compliance',
  piece: 'self',
  piece_fichier: 'self',
  absence: 'self',
  formation: 'self',
  primes: 'self',
  bac_a_sable: 'self',
});

/** Le code du refus, ou `null` si le rôle peut appeler la route. */
function gate(access: Access, method: ReseauRoute['method'], v: Viewer, agentId: string | undefined): string | null {
  if (v.role === 'direction') return null;
  const compliance = v.role === 'compliance' && method === 'GET' && (access === 'direction_or_compliance' || access === 'self_or_compliance');
  if (compliance) return null;
  if (access === 'member') return v.role === 'partner' ? 'role' : null;
  if ((access === 'self' || access === 'self_or_compliance') && v.role === 'agent') return v.userId === agentId ? null : 'not_assigned';
  return 'role';
}

/** Les services de M14, construits pour une requête. */
export function reseauServices(s: ReseauServices, options: ReseauOptions = {}) {
  const opts = { now: s.now };
  const fiches = new FicheClient(s.db, opts);
  const unique = new FicheUnique(s.db, fiches, opts);
  const entretiens = new Entretiens(s.db, s.journal, opts);
  const academie = new Academie(s.db, s.journal, opts);
  return {
    candidatures: new Candidatures(s.db, s.journal, opts),
    reponses: new ReponsesCandidats(s.db, s.journal, opts),
    entretiens,
    dossier: options.pieces ? new DossierAgent(s.db, fiches, entretiens, options.pieces, s.journal, opts) : null,
    import: new ImportAgent(s.db, fiches, unique, new DecisionEnvoi(s.db, fiches, unique, opts), s.journal, opts),
    academie,
    sandbox: options.sandbox ? new BacASable(s.db, s.journal, academie, { ...options.sandbox, now: s.now }) : null,
    entrainement: new Entrainement(s.db, s.journal, { ...opts, ...(options.coach ? { coach: options.coach } : {}) }),
    accompagnement: new Accompagnement(s.db, s.journal, opts),
    parrainage: new Parrainage(s.db, s.journal, opts),
    departs: new Departs(s.db, s.journal, opts),
    sortie: new AccesSortie(s.db, s.journal, opts),
  };
}

/** Les routes de M14, à ajouter à celles de `app.ts` (J13). */
export function reseauRoutes(options: ReseauOptions = {}): ReseauRoute[] {
  type Handler = (m: ReturnType<typeof reseauServices>, v: Viewer, params: string[], body: Record<string, unknown>) => Promise<Response>;
  /** Une écriture : un corps JSON, aux seules clés admises. */
  const write =
    (keys: readonly string[], fn: Handler, max = MAX_BODY_BYTES): ReseauRoute['handle'] =>
    async (s, v, params, request) => {
      const body = await readJson(request, max);
      if (!body || !only(body, keys)) return badBody();
      return fn(reseauServices(s, options), v, params, body);
    };
  /** Une lecture : aucun corps. */
  const read =
    (fn: (m: ReturnType<typeof reseauServices>, v: Viewer, params: string[]) => Promise<Response>): ReseauRoute['handle'] =>
    async (s, v, params) =>
      fn(reseauServices(s, options), v, params);
  const P = '^/reseau';
  const A = `${P}/agents/${ID}`;
  // Le rôle est contrôlé avant même de lire le corps : un refus est toujours écrit au journal, quel que soit le corps [R16].
  // La couche métier refait son propre contrôle, plus fin, derrière.
  const route = (method: ReseauRoute['method'], path: string, name: string, handle: ReseauRoute['handle']): ReseauRoute => {
    const access = ACCESS[name] ?? 'member';
    return {
      method,
      pattern: new RegExp(`${path}$`),
      name: `reseau.${name}`,
      handle: async (s, v, params, request) => {
        const code = gate(access, method, v, params[0]);
        if (code === null) return handle(s, v, params, request);
        const subject = path.startsWith(A) && params[0] ? `agent:${params[0]}` : null;
        await appendEvent(s.journal, { type: 'acces.refuse', actor: `${String(v.role)}:${v.userId}`, subject, data: { rule: 'R16', role: String(v.role), kind: `reseau.${name}`, code } }, s.now);
        return json(403, { ok: false, rule: 'R16', code });
      },
    };
  };
  const noPieces = (): Response => unavailable('Le stockage des pièces du dossier d’agent');

  return [
    /* ---------- Candidatures, entretiens, décisions : la direction seule [R81, R16]. ---------- */
    // L'ordre d'arrivée, tel que la couche métier le rend : aucun tri, aucun filtre, aucun paramètre de classement [R81].
    route('GET', `${P}/candidatures`, 'candidatures', read(async (m, v) => reply(await m.candidatures.list(v)))),
    route('GET', `${P}/candidatures/${ID}/entretien`, 'fiche_entretien', read(async (m, v, [id]) => reply(await m.entretiens.prepare(v, id!)))),
    route('POST', `${P}/candidatures/${ID}/entretien`, 'entretien', write(['at', 'interviewer'], async (m, v, [id], b) => reply(await m.entretiens.schedule(v, id!, { at: b.at, interviewer: b.interviewer })))),
    route('POST', `${P}/entretiens/${ID}/tenu`, 'entretien_tenu', write(['heldByName'], async (m, v, [id], b) => reply(await m.entretiens.markHeld(v, id!, b.heldByName)))),
    // La décision d'un humain nommé, avec sa raison : la couche métier refuse toute autre clé [R81].
    route('POST', `${P}/candidatures/${ID}/decision`, 'decision', write(['decision', 'reason', 'deciderName'], async (m, v, [id], b) => reply(await m.entretiens.decide(v, id!, b)))),
    route('GET', `${P}/candidatures/${ID}/reponses`, 'reponses_candidat', read(async (m, v, [id]) => reply(await m.reponses.repliesOf(v, id!)))),
    route('GET', `${P}/reponses`, 'reponses', read(async (m, v) => reply(await m.reponses.current(v)))),
    // Une réponse écrite par la direction passe le contrôle des promesses de revenus [R80] dans la couche métier.
    route('POST', `${P}/reponses`, 'reponse_ecrite', write(['topic', 'body'], async (m, v, _p, b) => reply(await m.reponses.write(v, b.topic, b.body)))),
    route('GET', `${P}/questions`, 'questions', read(async (m, v) => reply(await m.reponses.openTasks(v)))),
    route('POST', `${P}/questions/${ID}/faite`, 'question_faite', read(async (m, v, [id]) => reply(await m.reponses.taskDone(v, id!)))),

    /* ---------- Dossier d'agent [R82]. ---------- */
    route('POST', `${P}/candidatures/${ID}/admettre`, 'admettre', write(['zone'], async (m, v, [id], b) => (m.dossier ? reply(await m.dossier.admit(v, id!, b.zone === undefined ? {} : { zone: b.zone })) : noPieces()))),
    route('GET', `${P}/mon-dossier`, 'mon_dossier', read(async (m, v) => (m.dossier ? reply(await m.dossier.status(v, v.userId)) : noPieces()))),
    route('GET', `${A}/dossier`, 'dossier', read(async (m, v, [id]) => (m.dossier ? reply(await m.dossier.status(v, id!)) : noPieces()))),
    route(
      'POST',
      `${A}/pieces`,
      'piece',
      write(['kind', 'ref', 'issuedOn', 'validUntil'], async (m, v, [id], b) =>
        m.dossier ? reply(await m.dossier.addPiece(v, id!, { kind: b.kind, ref: b.ref, issuedOn: b.issuedOn, ...(b.validUntil === undefined ? {} : { validUntil: b.validUntil }) })) : noPieces(),
      ),
    ),
    // AU024 · Le fichier même d'une pièce, déposé depuis l'écran : corps brut (PDF, JPEG, PNG), pièce et dates dans l'adresse.
    route('POST', `${A}/pieces/fichier`, 'piece_fichier', async (s, v, [id], request) => {
      const m = reseauServices(s, options);
      if (!m.dossier) return noPieces();
      const file = await readPieceFile(request);
      if (!file) return json(413, { ok: false, rule: null, code: 'file_too_large' });
      const q = new URL(request.url).searchParams;
      const validUntil = q.get('validUntil');
      return reply(await m.dossier.addPieceFile(v, id!, { kind: q.get('kind'), issuedOn: q.get('issuedOn'), ...(validUntil === null ? {} : { validUntil }) }, file));
    }),
    route('POST', `${A}/projets`, 'projet_piece', write(['kind'], async (m, v, [id], b) => (m.dossier ? reply(await m.dossier.prepareDraft(v, id!, b.kind)) : noPieces()))),

    /* ---------- Import des contacts et des biens de l'agent : rien n'est envoyé [R84]. ---------- */
    route(
      'POST',
      `${P}/import`,
      'import',
      write(
        ['format', 'contacts', 'properties', 'history'],
        async (m, v, _p, b) => {
          if ((['contacts', 'properties', 'history'] as const).some((k) => b[k] !== undefined && typeof b[k] !== 'string')) return badBody();
          const r = await m.import.run(v, v.userId, {
            format: b.format,
            ...(b.contacts === undefined ? {} : { contacts: b.contacts as string }),
            ...(b.properties === undefined ? {} : { properties: b.properties as string }),
            ...(b.history === undefined ? {} : { history: b.history as string }),
          });
          return reply(r.ok ? { ok: true, value: r.report } : r);
        },
        MAX_IMPORT_BYTES,
      ),
    ),
    route('GET', `${P}/import/a-reprendre`, 'import_direction', read(async (m, v) => reply(await m.import.referrals(v)))),
    // AU029 : le suivi repris d'une fiche (échanges, notes, rappels), et les rappels repris de l'agent. Rien n'est envoyé.
    route('GET', `${P}/import/suivi/${ID}`, 'import_suivi', read(async (m, v, [id]) => reply(await m.import.followUpOf(v, id!)))),
    route('GET', `${P}/import/rappels`, 'mes_rappels_repris', read(async (m, v) => reply(await m.import.openReminders(v)))),
    route('POST', `${P}/import/rappels/fait`, 'rappel_repris_fait', write(['id'], async (m, v, _p, b) => reply(await m.import.closeReminder(v, b.id)))),

    /* ---------- Académie : aucun horaire imposé, heures comptées par le code [R85]. ---------- */
    route('GET', `${P}/academie`, 'academie', read(async (m, v) => reply(await m.academie.tracks(v)))),
    route(
      'POST',
      `${P}/academie/modules`,
      'module',
      write(['title', 'track', 'position', 'videoId', 'scriptRef', 'durationMinutes', 'topic', 'mandatory'], async (m, v, _p, b) =>
        reply(await m.academie.addModule(v, b as Parameters<Academie['addModule']>[1])),
      ),
    ),
    route('POST', `${P}/academie/modules/${ID}/fait`, 'module_fait', read(async (m, v, [id]) => reply(await m.academie.complete(v, id!)))),
    route(
      'POST',
      `${P}/academie/seances`,
      'seance',
      write(['kind', 'title', 'heldOn', 'durationMinutes', 'topic', 'mandatory'], async (m, v, _p, b) => reply(await m.academie.addSession(v, b as Parameters<Academie['addSession']>[1]))),
    ),
    route('POST', `${P}/academie/seances/${ID}/presence`, 'presence', write(['agentId', 'recorderName'], async (m, v, [id], b) => reply(await m.academie.recordAttendance(v, id!, { agentId: b.agentId, recorderName: b.recorderName })))),
    route('GET', `${P}/ma-formation`, 'ma_formation', read(async (m, v) => reply(await m.academie.counter(v, v.userId)))),
    route('GET', `${A}/formation`, 'formation', read(async (m, v, [id]) => reply(await m.academie.counter(v, id!)))),
    // AU028 : la direction reprend le cycle de formation d'avant l'arrivée, pièce et nom de la personne qui saisit à l'appui.
    route(
      'POST',
      `${A}/formation/periode-anterieure`,
      'formation_periode',
      write(['cycleStart', 'proofRef', 'recorderName'], async (m, v, [id], b) => reply(await m.academie.setPriorPeriod(v, id!, { cycleStart: b.cycleStart, proofRef: b.proofRef, recorderName: b.recorderName }))),
    ),
    route(
      'POST',
      `${A}/formation/anterieures`,
      'formation_anterieure',
      write(['heldOn', 'durationMinutes', 'topic', 'proofRef', 'recorderName'], async (m, v, [id], b) =>
        reply(await m.academie.addPriorTraining(v, id!, b as Parameters<Academie['addPriorTraining']>[2])),
      ),
    ),
    // Le parcours d'essai de l'agent lui-même, sans son identifiant dans l'adresse (J14).
    route('GET', `${P}/mon-bac-a-sable`, 'mon_bac_a_sable', read(async (m, v) => (m.sandbox ? reply(await m.sandbox.progress(v, v.userId)) : unavailable('Le bac à sable')))),
    // AU025 : l'agent ouvre son exercice depuis son écran, puis y fait les étapes une à une ; lui seul [R16].
    route('POST', `${P}/mon-bac-a-sable`, 'mon_bac_a_sable_ouvrir', read(async (m, v) => {
      if (!m.sandbox) return unavailable('Le bac à sable');
      const opened = await m.sandbox.open(v);
      return reply(opened.ok ? await m.sandbox.progress(v, v.userId) : opened);
    })),
    route('POST', `${P}/mon-bac-a-sable/etapes/([a-z_]{1,32})`, 'mon_bac_a_sable_etape', read(async (m, v, [step]) => (m.sandbox ? reply(await m.sandbox.act(v, step!)) : unavailable('Le bac à sable')))),
    route('GET', `${A}/bac-a-sable`, 'bac_a_sable', read(async (m, v, [id]) => (m.sandbox ? reply(await m.sandbox.progress(v, id!)) : unavailable('Le bac à sable')))),

    /* ---------- Entraînement aux objections, sur des cas inventés. ---------- */
    route('GET', `${P}/entrainement/cas`, 'entrainement_cas', read(async (m, v) => reply(await m.entrainement.cases(v)))),
    route('POST', `${P}/entrainement`, 'entrainement', write(['caseKey'], async (m, v, _p, b) => (typeof b.caseKey === 'string' ? reply(await m.entrainement.start(v, b.caseKey)) : badBody()))),
    route('POST', `${P}/entrainement/${ID}/tour`, 'entrainement_tour', write(['text'], async (m, v, [id], b) => reply(await m.entrainement.turn(v, id!, b.text)))),
    route('POST', `${P}/entrainement/${ID}/fin`, 'entrainement_fin', read(async (m, v, [id]) => reply(await m.entrainement.end(v, id!)))),

    /* ---------- Référent, binôme, absences, assistance. ---------- */
    // L'agent lit son référent en cours : un prénom et une date, rien d'autre (J14) [R16].
    route('GET', `${P}/mon-referent`, 'mon_referent', read(async (m, v) => reply(await m.accompagnement.myReferent(v)))),
    route('POST', `${A}/referent`, 'referent', write(['referentId'], async (m, v, [id], b) => reply(await m.accompagnement.assignReferent(v, id!, b.referentId)))),
    route('POST', `${P}/binomes`, 'binome', write(['agentA', 'agentB', 'coverSharePct'], async (m, v, _p, b) => reply(await m.accompagnement.writePair(v, { agentA: b.agentA, agentB: b.agentB, coverSharePct: b.coverSharePct })))),
    route('POST', `${A}/absence`, 'absence', write(['from', 'until', 'coverAgentId'], async (m, v, [id], b) => reply(await m.accompagnement.declareAbsence(v, id!, { from: b.from, until: b.until, coverAgentId: b.coverAgentId })))),
    // Le binôme ne lit les dossiers de l'absent que pendant l'absence déclarée [R16].
    route('GET', `${A}/dossiers-couverts`, 'dossiers_couverts', read(async (m, v, [id]) => reply(await m.accompagnement.coverFiles(v, id!)))),
    route('POST', `${P}/assistance`, 'assistance', write(['level', 'topic', 'body'], async (m, v, _p, b) => reply(await m.accompagnement.ask(v, { level: b.level, topic: b.topic, body: b.body })))),
    route('POST', `${P}/assistance/${ID}/repondue`, 'assistance_repondue', read(async (m, v, [id]) => reply(await m.accompagnement.answer(v, id!)))),

    /* ---------- Parrainage [R83]. ---------- */
    route('POST', `${P}/parrainage/regles`, 'parrainage_regles', write(['rateBp', 'levels'], async (m, v, _p, b) => reply(await m.parrainage.setRules(v, { rateBp: b.rateBp, ...(b.levels === undefined ? {} : { levels: b.levels }) })))),
    route('POST', `${A}/parrain`, 'parrain', write(['sponsorId'], async (m, v, [id], b) => reply(await m.parrainage.recordSponsor(v, id!, b.sponsorId)))),
    route('GET', `${P}/mes-primes`, 'mes_primes', read(async (m, v) => reply(await m.parrainage.primesOf(v, v.userId)))),
    route('GET', `${A}/primes`, 'primes', read(async (m, v, [id]) => reply(await m.parrainage.primesOf(v, id!)))),

    /* ---------- Départ d'un agent [R86]. ---------- */
    route('GET', `${A}/depart`, 'depart', read(async (m, v, [id]) => reply(await m.departs.get(v, id!)))),
    route(
      'POST',
      `${A}/depart`,
      'depart_range',
      write(['noticeGivenOn', 'leavesOn', 'reason', 'contractStartedOn'], async (m, v, [id], b) =>
        reply(await m.departs.schedule(v, id!, { noticeGivenOn: b.noticeGivenOn, leavesOn: b.leavesOn, reason: b.reason, ...(b.contractStartedOn === undefined ? {} : { contractStartedOn: b.contractStartedOn }) })),
      ),
    ),
    route('POST', `${A}/depart/annuler`, 'depart_annule', read(async (m, v, [id]) => reply(await m.departs.cancel(v, id!)))),
    route('POST', `${A}/successeur`, 'successeur', write(['successorId'], async (m, v, [id], b) => reply(await m.departs.presentSuccessor(v, id!, b.successorId)))),
    route('POST', `${A}/successeur/decision`, 'successeur_decision', write(['accept'], async (m, v, [id], b) => reply(await m.departs.decideSuccessor(v, id!, b.accept)))),
    route('GET', `${A}/solde`, 'solde', read(async (m, v, [id]) => reply(await m.departs.settlement(v, id!)))),
    route('GET', `${A}/contenus`, 'contenus', read(async (m, v, [id]) => reply(await m.departs.personalContents(v, id!)))),
    // AU111 · le lien de sortie d'un agent parti : rendu une fois, à la direction, qui le lui remet ; et son retrait.
    route('POST', `${A}/acces-sortie`, 'acces_sortie', write(['days'], async (m, v, [id], b) => reply(await m.sortie.grant(v, id!, b.days === undefined ? {} : { days: b.days })))),
    route('POST', `${P}/acces-sortie/${ID}/retrait`, 'acces_sortie_retrait', read(async (m, v, [id]) => reply(await m.sortie.revoke(v, id!)))),
    route('GET', `${P}/reprises`, 'reprises', read(async (m, v) => reply(await m.departs.queue(v)))),
    route('POST', `${P}/reprises`, 'reprise', write(['kind', 'subjectId', 'toAgentId'], async (m, v, _p, b) => reply(await m.departs.reassign(v, { kind: b.kind, subjectId: b.subjectId, toAgentId: b.toAgentId })))),
  ];
}

/** L'adresse publique de l'accès de sortie (AU111), sans clé : le lien seul ouvre, et seulement ce qui est à l'agent. */
export const EXIT_PATH = /^\/sortie\/([a-z2-7]{32})(?:\/pieces\/([a-z_]{1,64}))?$/;

/**
 * L'accès de sortie d'un agent parti (AU111) : `GET /v1/sortie/<lien>` rend son solde, ses pièces, son temps de
 * formation et son relevé ; `GET /v1/sortie/<lien>/pieces/<sorte>` remet la pièce, si le stockage sait la relire. Un
 * lien inconnu, retiré ou échu reçoit toujours la même réponse. `null` si l'adresse n'est pas la sienne.
 */
export async function handleSortiePublic(request: Request, path: string, s: ReseauServices, pieces: AgentPieceStore | null): Promise<Response | null> {
  if (!path.startsWith('/sortie/')) return null;
  const m = EXIT_PATH.exec(path);
  if (request.method !== 'GET') return json(405, { ok: false, rule: null, code: 'method_not_allowed' });
  const gone = json(404, { ok: false, rule: 'R16', code: 'unknown_link' });
  if (!m) return gone;
  const sortie = new AccesSortie(s.db, s.journal, { now: s.now });
  if (!m[2]) {
    const r = await sortie.read(m[1]!);
    return r.ok ? json(200, { ok: true, mode: TRIAL_MODE, data: r.value }) : gone;
  }
  const ref = await sortie.pieceRef(m[1]!, m[2]);
  if (!ref) return gone;
  const read = pieces?.read?.bind(pieces);
  if (!read) return unavailable('La remise des pièces');
  const file = await read(ref);
  if (!file) return gone;
  return new Response(file.body, { status: 200, headers: { 'content-type': file.contentType, 'content-disposition': `attachment; filename="${m[2]}"`, ...HEADERS } });
}
