/**
 * Les routes de l'avant-contrat (HX45) et de la prélecture du projet du notaire (RC39, RC40 ; RC54), sous
 * `/v1/dossiers/<id>/avant-contrat`. Comme `copropriete.ts`, ce fichier ne touche pas au socle : il expose
 * `avantContratRoutes()`, de la même forme que les routes de `app.ts`, à brancher par la voie 1.
 *
 * - `GET …` : l'état (note, dernier projet et ses différences, dépôt), pour l'agent du bien, la direction et la conformité.
 * - `POST …/note` : la note au notaire, prix et conditions repris du dossier et de l'offre acceptée [R510].
 * - `POST …/projet` : le projet du notaire rangé avec ce que l'agent y lit, comparé à la note [R511].
 * - `POST …/dates` : les dates du dernier projet reportées à l'échéancier, compromis signé [R513].
 * - `POST …/depot` : le dépôt de garantie, reçu par le notaire seul [R512].
 * - `POST …/prelecture` : la prélecture sur le texte des pages fourni ; rien n'est rangé.
 * - `POST …/pdf?documentRef=preuves/<uuid>.pdf` : le PDF du projet, son texte tiré sans IA (RC40), puis prélu.
 *
 * Jamais vu : le PDF prélu doit être, octet pour octet, celui déposé au dossier sous cette référence (`POST …/preuves`).
 * Son SHA-256 est recalculé ici et comparé à l'empreinte écrite au journal au dépôt ; un autre fichier, même envoyé sous
 * la même référence, est refusé et rien n'est prélu. Ce que l'IA propose porte donc sur le fichier même qui reste au
 * dossier, et que `…/projet` range ensuite. Ni le PDF, ni son texte, ni son empreinte ne sont gardés ou écrits au
 * journal par la prélecture [R13].
 */
import { Acces, FicheClient, FicheUnique, appendEvent, type JournalStore, type SqlDatabase, type Viewer } from '@aimmo/core';
import { AvantContrat, LectureProjet, MAX_PAGES, type DraftReader } from '../../core/src/avant-contrat/index.ts';
import { PDF_LIMITS, PDF_TEXT_REFUSAL_TEXT, pagesForReading, pagesToRead, pdfPagesText } from '../../core/src/documents/index.ts';
import { gateSaleFile } from '../../core/src/dossiers/acces-dossier.ts';
import { PROOF_REF } from '../../core/src/offres/transmission.ts';
import { readCapped } from './studio.ts';

export const TRIAL_MODE = 'essai';
/** Le corps JSON d'une requête : le texte de 200 pages de 20 000 caractères, accents compris, y tient. */
export const MAX_AVANT_CONTRAT_BODY_BYTES = 9 * 1024 * 1024;
/** Le PDF déposé : la limite de la lecture du texte (RC40). */
export const MAX_PROJET_PDF_BYTES = PDF_LIMITS.maxBytes;
const ID = '([A-Za-z0-9_-]{1,64})';

export interface AvantContratServices {
  db: SqlDatabase;
  journal: JournalStore;
  now: () => Date;
  newId?: () => string;
  /** Le stockage des pièces : il dit seulement si une référence y est rangée. */
  pieces: { has(ref: string): Promise<boolean> };
  /** Le lecteur IA de la prélecture ; absent, rien n'est proposé et tout est à lire [R12]. */
  reader?: DraftReader | null;
}

type Role = Viewer['role'];
const WRITER: readonly Role[] = ['agent'];
const READERS: readonly Role[] = ['agent', 'direction', 'compliance'];

export interface AvantContratRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  /** Les rôles admis : un autre est refusé, au journal, avant toute lecture du corps [R16]. */
  roles: readonly Role[];
  handle: (s: AvantContratServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });

type Outcome = { ok: true; value?: unknown } | { ok: false; rule: string | null; code: string };

/** 200 ; 403 refus de droits ; 404 dossier inconnu ; 409 règle, dossier clos ou arrêté, écriture simultanée ; 400 sinon. */
function reply(result: Outcome): Response {
  if (result.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: result.value ?? null });
  const { rule, code } = result;
  if (/^unknown/.test(code)) return json(404, { ok: false, rule, code });
  if (rule === 'R16') return json(403, { ok: false, rule, code });
  if (rule !== null || code === 'closed' || code === 'busy' || code === 'file_stopped' || code === 'no_brief' || code === 'no_draft') return json(409, { ok: false, rule, code });
  return json(400, { ok: false, rule, code });
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_AVANT_CONTRAT_BODY_BYTES) return null;
  // Lu par morceaux et coupé dès le plafond, même sans longueur annoncée : jamais tout en mémoire.
  const bytes = await readCapped(request, MAX_AVANT_CONTRAT_BODY_BYTES);
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const badBody = (): Response => json(400, { ok: false, rule: null, code: 'invalid_body', message: 'Corps JSON attendu.' });

/** Les objets métier, faits à chaque requête sur les mêmes services. */
export function avantContratCore(s: AvantContratServices) {
  const store = new FicheClient(s.db, { now: s.now });
  const acces = new Acces(s.db, store, new FicheUnique(s.db, store, { now: s.now }), s.journal, { now: s.now });
  return {
    acces,
    contrat: new AvantContrat(s.db, acces, s.journal, s.pieces, { now: s.now, ...(s.newId ? { newId: s.newId } : {}) }),
    lecture: new LectureProjet(s.db, acces, s.journal, s.pieces, s.reader ?? null, { now: s.now }),
  };
}

const actor = (v: Viewer): string => `${String(v.role)}:${v.userId}`;

/** Un rôle que la route n'admet pas : refusé et écrit au journal, avant toute lecture [R16]. */
async function refuseRole(s: AvantContratServices, v: Viewer, fileId: string): Promise<Response> {
  await appendEvent(s.journal, { type: 'acces.refuse', actor: actor(v), subject: `sale_file:${fileId}`, data: { rule: 'R16', role: String(v.role), kind: 'pre_contract', code: 'role' } }, s.now);
  return reply({ ok: false, rule: 'R16', code: 'role' });
}

const guarded =
  (roles: readonly Role[], fn: (s: AvantContratServices, v: Viewer, fileId: string, request: Request) => Promise<Response>) =>
  async (s: AvantContratServices, v: Viewer, [fileId]: string[], request: Request): Promise<Response> =>
    roles.includes(v.role) ? fn(s, v, fileId!, request) : refuseRole(s, v, fileId!);

const withBody =
  (fn: (s: AvantContratServices, v: Viewer, fileId: string, body: Record<string, unknown>) => Promise<Response>) =>
  async (s: AvantContratServices, v: Viewer, fileId: string, request: Request): Promise<Response> => {
    const body = await readJson(request);
    return body ? fn(s, v, fileId, body) : badBody();
  };

const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

const pagesInWords = (pages: number[]): string | null =>
  pages.length === 0
    ? null
    : pages.length === 1
      ? `La page ${pages[0]} n’a pas pu être lue : lisez-la vous-même.`
      : `Les pages ${pages.slice(0, -1).join(', ')} et ${pages[pages.length - 1]} n’ont pas pu être lues : lisez-les vous-même.`;

/**
 * L'empreinte écrite au journal quand cette référence a été déposée à ce dossier (`dossier.depot`), ou `null`. Le
 * dernier dépôt sous cette référence fait foi ; une référence déposée à un autre dossier n'est pas trouvée ici.
 */
async function depositedSha(s: AvantContratServices, fileId: string, ref: string): Promise<string | null> {
  let found: string | null = null;
  for (const e of await s.journal.bySubject(`sale_file:${fileId}`)) {
    if (e.type !== 'dossier.depot' || e.data.ref !== ref) continue;
    found = typeof e.data.sha256 === 'string' && /^[0-9a-f]{64}$/.test(e.data.sha256) ? e.data.sha256 : null;
  }
  return found;
}

/** Le PDF du projet : seule une preuve PDF déposée sous `preuves/` peut ensuite être rangée par `…/projet` [R511]. */
const PDF_REF = /\.pdf$/;

/**
 * Le PDF du projet du notaire prélu (RC54). Le dossier est contrôlé avant toute lecture du corps [R16] ; le PDF doit
 * être celui déposé au dossier sous `documentRef`, octet pour octet ; son texte est tiré sans IA, une page qu'on ne sait
 * pas lire est nommée, jamais devinée [R12] ; puis la prélecture de RC39, qui ne range rien.
 */
async function preReadPdf(s: AvantContratServices, v: Viewer, fileId: string, request: Request): Promise<Response> {
  const documentRef = new URL(request.url).searchParams.get('documentRef');
  if (documentRef === null || !PROOF_REF.test(documentRef) || !PDF_REF.test(documentRef))
    return json(400, { ok: false, rule: null, code: 'bad_document', message: 'Déposez d’abord le projet en PDF au dossier, puis donnez sa référence.' });

  const c = avantContratCore(s);
  // Le dossier d'abord : un refus ne lit jamais le PDF [R16].
  const g = await gateSaleFile({ db: s.db, acces: c.acces, journal: s.journal, now: s.now }, v, fileId, true, 'pre_contract');
  if (!g.ok) return reply(g);

  const type = (request.headers.get('content-type') ?? '').toLowerCase().split(';')[0]!.trim();
  if (type !== 'application/pdf') return json(415, { ok: false, rule: null, code: 'not_pdf_body', message: 'Déposez le projet en PDF.' });
  const expected = await depositedSha(s, fileId, documentRef);
  if (expected === null) return json(409, { ok: false, rule: null, code: 'not_deposited', message: 'Ce projet n’a pas été déposé à ce dossier : déposez-le d’abord.' });
  const declared = Number(request.headers.get('content-length') ?? '0');
  const tooLarge = () => json(413, { ok: false, rule: null, code: 'too_large', message: PDF_TEXT_REFUSAL_TEXT.too_large });
  if (Number.isFinite(declared) && declared > MAX_PROJET_PDF_BYTES) return tooLarge();
  const bytes = await readCapped(request, MAX_PROJET_PDF_BYTES);
  if (!bytes) return tooLarge();
  if (hex(await crypto.subtle.digest('SHA-256', bytes)) !== expected)
    return json(409, { ok: false, rule: null, code: 'not_the_deposited_file', message: 'Ce PDF n’est pas celui déposé au dossier sous cette référence : rien n’a été prélu.' });

  const read = await pdfPagesText(bytes);
  if (!read.ok) return json(422, { ok: false, rule: null, code: read.code, message: PDF_TEXT_REFUSAL_TEXT[read.code] });
  const pages = pagesForReading(read.value.pages);
  if (pages.length === 0 || pages.every((p) => p.length === 0)) return json(422, { ok: false, rule: null, code: 'unreadable', message: PDF_TEXT_REFUSAL_TEXT.unreadable });
  if (pages.length > MAX_PAGES) return json(422, { ok: false, rule: null, code: 'too_many_pages', message: `Ce projet a plus de ${MAX_PAGES} pages : il ne peut pas être prélu. Lisez-le vous-même.` });

  const r = await c.lecture.preRead(v, fileId, { documentRef, pages });
  if (!r.ok && r.code === 'bad_pages') return json(422, { ok: false, rule: null, code: 'page_too_long', message: 'Une page de ce projet porte trop de texte pour être prélue. Lisez-la vous-même.' });
  if (!r.ok) return reply(r);
  const unread = pagesToRead(read.value.pages);
  return reply({ ok: true, value: { documentRef, pageCount: pages.length, pagesToRead: unread, pagesToReadText: pagesInWords(unread), reading: r.value } });
}

export function avantContratRoutes(): AvantContratRoute[] {
  const base = `^/dossiers/${ID}/avant-contrat`;
  const post = (path: string, name: string, fn: (s: AvantContratServices, v: Viewer, fileId: string, request: Request) => Promise<Response>): AvantContratRoute => ({
    method: 'POST',
    pattern: new RegExp(`${base}/${path}$`),
    name,
    roles: WRITER,
    handle: guarded(WRITER, fn),
  });
  return [
    { method: 'GET', pattern: new RegExp(`${base}$`), name: 'avant_contrat.etat', roles: READERS, handle: guarded(READERS, async (s, v, fileId) => reply(await avantContratCore(s).contrat.state(v, fileId))) },
    post(
      'note',
      'avant_contrat.note',
      withBody(async (s, v, fileId, b) => reply(await avantContratCore(s).contrat.prepare(v, fileId, { depositEur: b.depositEur, loanDeadline: b.loanDeadline, deedBy: b.deedBy }))),
    ),
    post(
      'projet',
      'avant_contrat.projet',
      withBody(async (s, v, fileId, b) => reply(await avantContratCore(s).contrat.recordDraft(v, fileId, b))),
    ),
    post('dates', 'avant_contrat.dates', async (s, v, fileId) => reply(await avantContratCore(s).contrat.reportDates(v, fileId))),
    post(
      'depot',
      'avant_contrat.depot',
      withBody(async (s, v, fileId, b) => reply(await avantContratCore(s).contrat.recordDeposit(v, fileId, { amountEur: b.amountEur, receivedBy: b.receivedBy, receivedOn: b.receivedOn, proofRef: b.proofRef }))),
    ),
    post(
      'prelecture',
      'avant_contrat.prelecture',
      withBody(async (s, v, fileId, b) => reply(await avantContratCore(s).lecture.preRead(v, fileId, { documentRef: b.documentRef, pages: b.pages }))),
    ),
    post('pdf', 'avant_contrat.pdf', preReadPdf),
  ];
}
