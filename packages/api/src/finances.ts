/**
 * Les routes des finances du réseau (HX49, HX62), sous `/v1/finances` (BR04) : factures fournisseurs lues et
 * recomptées, relevé de la banque et rapprochement, encaissement prouvé par sa ligne, relances des impayés, rapports
 * sur mesure.
 *
 * Chaque route dit les rôles qu'elle admet ; un autre rôle est refusé et écrit au journal avant que le corps soit lu
 * [R16]. La couche métier refait ses propres contrôles derrière (la direction et ses droits sur les chiffres, l'agent
 * actif pour ses rapports).
 *
 * Aucun montant n'entre par une route, sauf la correction nommée d'une facture fournisseur lue, que le code et la base
 * recomptent [R550] : le relevé est un fichier de la banque [R551], le rapprochement et l'encaissement ne portent que
 * des identifiants [R551, R552], la relance est écrite par le code et seulement validée ici [R553]. Rien ne part :
 * l'envoi des relances validées et le rapprochement seul restent des passages du planificateur, en mode essai.
 *
 * L'export complet de l'agent (HX62) exige la preuve d'une clé d'appareil [R601] : il vient avec les routes des clés
 * (BR05).
 */
import { Acces, FicheClient, FicheUnique, appendEvent, type JournalStore, type SqlDatabase, type Viewer } from '@aimmo/core';
import { FacturesFournisseurs, Rapprochements, RelancesImpayes, bankStatementFreshness, type Corrections, type LecteurFactures } from '../../core/src/facturation/index.ts';
import { RapportsSurMesure } from '../../core/src/rapports/index.ts';

export const TRIAL_MODE = 'essai';
const MAX_BODY_BYTES = 8_000;
/** Un relevé compte au plus 5 000 lignes : son dépôt seul a droit à un corps plus gros. */
const MAX_STATEMENT_BYTES = 1_000_000;
const ID = '([A-Za-z0-9_-]{1,64})';

export interface FinancesServices {
  db: SqlDatabase;
  journal: JournalStore;
  now: () => Date;
  /** Le lecteur des factures fournisseurs (l'IA, H13) ; absent, la lecture est fermée. */
  lecteur: LecteurFactures | null;
}

type Role = Viewer['role'];
const DIRECTION: readonly Role[] = ['direction'];
const WORK: readonly Role[] = ['agent', 'direction'];
/** AU107 · les lectures ouvertes aussi au comptable. */
const DIRECTION_ACCOUNTANT: readonly Role[] = ['direction', 'accountant'];

export interface FinancesRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  /** Les rôles admis : un autre est refusé avant toute lecture du corps [R16]. */
  roles: readonly Role[];
  handle: (s: FinancesServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...HEADERS } });

/** Ce qui n'existe pas pour ce lecteur : 404, sans dire s'il existe ailleurs. */
const NOT_FOUND = new Set(['unknown', 'unknown_line', 'unknown_invoice', 'unknown_report']);

type Outcome = { ok: true; value?: unknown; [k: string]: unknown } | { ok: false; rule: string | null; code: string; [k: string]: unknown };

/** 200 ; 403 pour un refus de droits ; 404 introuvable ; 409 pour une règle ; 400 sinon. */
function reply(result: Outcome): Response {
  if (result.ok) {
    const { ok: _ok, value, ...rest } = result;
    return json(200, { ok: true, mode: TRIAL_MODE, data: value ?? null, ...rest });
  }
  const { ok: _ok, ...rest } = result;
  if (result.rule === 'R16') return json(403, { ok: false, ...rest });
  if (NOT_FOUND.has(result.code)) return json(404, { ok: false, ...rest });
  return json(result.rule ? 409 : 400, { ok: false, ...rest });
}

async function readText(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > max) return null;
  const text = await request.text();
  return new TextEncoder().encode(text).length > max ? null : text;
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
  const text = await readText(request, MAX_BODY_BYTES);
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Le relevé envoyé en JSON (BR93) : `{ "csv": "<le fichier tel quel>" }`, rien d'autre. Le texte garde la même limite
 * que le CSV direct ; l'enveloppe JSON a droit à un peu plus, pour ses échappements.
 */
async function readStatementJson(request: Request): Promise<string | 'unknown_field' | null> {
  const text = await readText(request, MAX_STATEMENT_BYTES * 2);
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.some((k) => k !== 'csv')) return 'unknown_field';
  const csv = (value as { csv?: unknown }).csv;
  if (typeof csv !== 'string' || new TextEncoder().encode(csv).length > MAX_STATEMENT_BYTES) return null;
  return csv;
}

const badBody = (): Response => json(400, { ok: false, rule: null, code: 'invalid_body', message: 'Corps JSON attendu.' });
const unknownField = (): Response => json(400, { ok: false, rule: null, code: 'unknown_field' });

type Handler = (s: FinancesServices, v: Viewer, params: string[], body: Record<string, unknown>) => Promise<Response>;
/** Un corps JSON qui ne porte que les clés prévues ; une autre, même un montant, est refusée sans rien ranger. */
const withBody =
  (keys: readonly string[], fn: Handler): FinancesRoute['handle'] =>
  async (s, v, params, request) => {
    const body = await readJson(request);
    if (!body) return badBody();
    if (Object.keys(body).some((k) => !keys.includes(k))) return unknownField();
    return fn(s, v, params, body);
  };

const opts = (s: FinancesServices) => ({ now: s.now });
function acces(s: FinancesServices): Acces {
  const store = new FicheClient(s.db, opts(s));
  return new Acces(s.db, store, new FicheUnique(s.db, store, opts(s)), s.journal, opts(s));
}
const banque = (s: FinancesServices) => new Rapprochements(s.db, acces(s), s.journal, opts(s));
const relances = (s: FinancesServices) => new RelancesImpayes(s.db, s.journal, opts(s));
const rapports = (s: FinancesServices) => new RapportsSurMesure(s.db, s.journal, opts(s));

/** Ranger ou lister ne lit aucune facture : un lecteur fermé suffit quand l'IA n'est pas configurée. */
const CLOSED_READER: LecteurFactures = { read: async () => null };

/** Les seuls champs qu'une correction nomme [R550]. */
const CORRECTABLE = ['supplier', 'number', 'issuedOn', 'vatLines', 'htCents', 'vatCents', 'ttcCents'] as const;

/** La portée d'un rapport : l'agent lecteur par défaut, un agent nommé ou le total du réseau pour la direction [R560]. */
function scope(b: Record<string, unknown>): { from: unknown; to: unknown; agentId?: string; network?: boolean } | null {
  if (b.agentId !== undefined && typeof b.agentId !== 'string') return null;
  if (b.network !== undefined && typeof b.network !== 'boolean') return null;
  return { from: b.from, to: b.to, ...(typeof b.agentId === 'string' ? { agentId: b.agentId } : {}), ...(typeof b.network === 'boolean' ? { network: b.network } : {}) };
}

/** Les routes de `/v1/finances`, à ajouter à celles de `app.ts`. */
export function financesRoutes(): FinancesRoute[] {
  const P = '^/finances';
  const routes: FinancesRoute[] = [
    // Factures fournisseurs (HX49) : lues par le lecteur, recomptées, rangées par la direction [R550].
    {
      method: 'POST',
      pattern: new RegExp(`${P}/fournisseurs/lectures$`),
      name: 'finances.fournisseurs.lecture',
      roles: DIRECTION,
      handle: withBody(['documentRef'], async (s, v, _p, b) => {
        if (!s.lecteur) return json(503, { ok: false, rule: null, code: 'lecteur_absent', message: 'Lecture des factures fermée : aucun lecteur configuré.' });
        return reply(await new FacturesFournisseurs(s.db, s.journal, s.lecteur, opts(s)).read(v, b.documentRef as string));
      }),
    },
    {
      method: 'POST',
      pattern: new RegExp(`${P}/fournisseurs/lectures/${ID}/rangement$`),
      name: 'finances.fournisseurs.rangement',
      roles: DIRECTION,
      // Le corps est la liste des corrections nommées, vide pour ranger la facture telle que lue.
      handle: withBody(CORRECTABLE, async (s, v, [id], b) => reply(await new FacturesFournisseurs(s.db, s.journal, s.lecteur ?? CLOSED_READER, opts(s)).record(v, id!, b as Corrections))),
    },
    {
      method: 'GET',
      pattern: new RegExp(`${P}/fournisseurs$`),
      name: 'finances.fournisseurs',
      roles: DIRECTION_ACCOUNTANT,
      handle: async (s, v) => reply(await new FacturesFournisseurs(s.db, s.journal, s.lecteur ?? CLOSED_READER, opts(s)).list(v)),
    },
    // Banque (HX49) : relevé déposé tel quel, rapprochement une ligne pour une facture, encaissement prouvé [R551, R552].
    {
      method: 'POST',
      pattern: new RegExp(`${P}/banque/releve$`),
      name: 'finances.banque.releve',
      roles: DIRECTION,
      handle: async (s, v, _p, r) => {
        const type = (r.headers.get('content-type') ?? '').toLowerCase();
        // L'écran de la direction (BR93) n'envoie que du JSON : le même relevé, tel quel, sous la seule clé `csv`.
        if (type.startsWith('application/json')) {
          const csv = await readStatementJson(r);
          if (csv === 'unknown_field') return unknownField();
          if (csv === null) return json(400, { ok: false, rule: null, code: 'invalid_body', message: 'Relevé CSV attendu, sous la clé csv.' });
          return reply(await banque(s).importStatement(v, csv));
        }
        if (!type.startsWith('text/csv')) return json(400, { ok: false, rule: null, code: 'invalid_body', message: 'Relevé CSV attendu.' });
        const csv = await readText(r, MAX_STATEMENT_BYTES);
        if (csv === null) return json(400, { ok: false, rule: null, code: 'invalid_body', message: 'Relevé trop gros.' });
        return reply(await banque(s).importStatement(v, csv));
      },
    },
    {
      method: 'GET',
      pattern: new RegExp(`${P}/banque/propositions$`),
      name: 'finances.banque.propositions',
      roles: DIRECTION,
      handle: async (s, v) => reply(await banque(s).proposals(v)),
    },
    {
      method: 'POST',
      pattern: new RegExp(`${P}/banque/lignes/${ID}/rapprochement$`),
      name: 'finances.banque.rapprochement',
      roles: DIRECTION,
      handle: withBody(['invoiceId'], async (s, v, [lineId], b) => (typeof b.invoiceId === 'string' ? reply(await banque(s).confirm(v, lineId!, b.invoiceId)) : badBody())),
    },
    // AU094 · une ligne partagée entre factures, au centime, et les soldes qui en restent [R551].
    {
      method: 'POST',
      pattern: new RegExp(`${P}/banque/lignes/${ID}/parts$`),
      name: 'finances.banque.parts',
      roles: DIRECTION,
      handle: withBody(['parts'], async (s, v, [lineId], b) => reply(await banque(s).allocate(v, lineId!, b.parts))),
    },
    {
      method: 'GET',
      pattern: new RegExp(`${P}/banque/soldes$`),
      name: 'finances.banque.soldes',
      roles: DIRECTION_ACCOUNTANT,
      handle: async (s, v) => reply(await banque(s).balances(v)),
    },
    {
      method: 'GET',
      pattern: new RegExp(`${P}/banque/rapprochements$`),
      name: 'finances.banque.rapprochements',
      roles: DIRECTION_ACCOUNTANT,
      handle: async (s, v) => reply(await banque(s).list(v)),
    },
    {
      method: 'POST',
      pattern: new RegExp(`${P}/banque/factures/${ID}/encaissement$`),
      name: 'finances.banque.encaissement',
      roles: DIRECTION,
      handle: async (s, v, [invoiceId]) => reply((await banque(s).recordReceipt(v, invoiceId!)) as Outcome),
    },
    // Fraîcheur du dernier relevé (RC55, BR92) : au-delà de 7 jours, ou sans relevé, aucune relance n'est préparée.
    // Le jour du dernier dépôt et son âge seulement, jamais un montant ni une ligne [R13, R553].
    {
      method: 'GET',
      pattern: new RegExp(`${P}/banque/fraicheur$`),
      name: 'finances.banque.fraicheur',
      roles: DIRECTION_ACCOUNTANT,
      handle: async (s, v) => reply({ ok: true, value: await bankStatementFreshness(s.db, v.networkId, s.now()) }),
    },
    // Relances des impayés (HX49) : préparées par le passage, validées ici, envoyées par le passage en essai [R553].
    {
      method: 'GET',
      pattern: new RegExp(`${P}/relances$`),
      name: 'finances.relances',
      roles: DIRECTION,
      handle: async (s, v) => reply(await relances(s).list(v)),
    },
    {
      method: 'POST',
      pattern: new RegExp(`${P}/relances/${ID}/validation$`),
      name: 'finances.relances.validation',
      roles: DIRECTION,
      // Le texte validé est celui que la direction a lu : sa préparation l'identifie (AU094b) [R553].
      handle: withBody(['preparedAt'], async (s, v, [id], b) => (typeof b.preparedAt === 'string' ? reply(await relances(s).validate(v, id!, { preparedAt: b.preparedAt })) : json(400, { ok: false, rule: null, code: 'bad_revision' }))),
    },
    // Rapports sur mesure (HX62) : un agent ses chiffres, la direction un agent ou le total, jamais deux côte à côte [R560].
    {
      method: 'GET',
      pattern: new RegExp(`${P}/rapports$`),
      name: 'finances.rapports',
      roles: WORK,
      handle: async (s, v) => reply(await rapports(s).list(v)),
    },
    {
      method: 'POST',
      pattern: new RegExp(`${P}/rapports$`),
      name: 'finances.rapports.enregistrer',
      roles: WORK,
      handle: withBody(['name', 'definition'], async (s, v, _p, b) => reply(await rapports(s).save(v, { name: b.name, definition: b.definition }))),
    },
    {
      method: 'POST',
      pattern: new RegExp(`${P}/rapports/lecture$`),
      name: 'finances.rapports.lecture',
      roles: WORK,
      handle: withBody(['definition', 'from', 'to', 'agentId', 'network'], async (s, v, _p, b) => {
        const sc = scope(b);
        return sc ? reply(await rapports(s).run(v, { ...sc, definition: b.definition })) : badBody();
      }),
    },
    {
      method: 'POST',
      pattern: new RegExp(`${P}/rapports/${ID}/lecture$`),
      name: 'finances.rapports.relire',
      roles: WORK,
      handle: withBody(['from', 'to', 'agentId', 'network'], async (s, v, [id], b) => {
        const sc = scope(b);
        return sc ? reply(await rapports(s).runSaved(v, id!, sc)) : badBody();
      }),
    },
  ];
  return routes.map((route) => ({
    ...route,
    handle: async (s, v, params, request) => {
      if (route.roles.includes(v.role)) return route.handle(s, v, params, request);
      await appendEvent(s.journal, { type: 'acces.refuse', actor: `${String(v.role)}:${v.userId}`, subject: `network:${v.networkId}`, data: { rule: 'R16', role: String(v.role), kind: route.name, code: 'role' } }, s.now);
      return json(403, { ok: false, rule: 'R16', code: 'role' });
    },
  }));
}

