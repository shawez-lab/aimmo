/**
 * Les routes de la copropriété et de l'urbanisme résumés (HX35, RC42, RC43 ; RC52), sous
 * `/v1/dossiers/<id>/copropriete`.
 *
 * - `POST …/prelecture` : la prélecture des documents (RC42), rien n'est rangé ; sans lecteur IA, tout est à lire.
 * - `POST …/pdf?kind=<type>[&meetingDay=AAAA-MM-JJ]` : un PDF déposé tel quel (RC53), son texte tiré sans IA (RC40)
 *   puis prélu ; la référence du document est l'empreinte du fichier, jamais un nom venu de l'écran, et rien n'est gardé.
 * - `POST …/resume` : le résumé préparé par l'agent du bien (HX35), phrases vérifiées contre leur page [R448].
 * - `GET …/resume` : le dernier résumé, pour qui voit le dossier en entier [R16].
 * - `GET …/acquereur` : les travaux votés à venir, tels qu'ils se disent à l'acquéreur [R451].
 *
 * Jamais vu : les données publiques ne sont jamais reçues de l'écran. Un corps qui en porte est refusé [R449]. La zone
 * du plan d'urbanisme est lue ici, au Géoportail, au point du bien : l'agent tape l'adresse du bien, la Base adresse
 * nationale la géocode, et la zone n'est demandée que si l'adresse trouvée est sûre et dans la commune du bien (même
 * code postal). Seuls la position et le code INSEE partent au Géoportail ; l'adresse n'est ni gardée ni écrite au
 * journal [R13]. Le dossier est contrôlé avant tout géocodage : un refus ne fait partir aucune requête [R16].
 *
 * Le registre des copropriétés reste « non collecté » : il n'a pas d'API ouverte stable.
 */
import {
  Acces,
  FicheClient,
  FicheUnique,
  appendEvent,
  type JournalStore,
  type SqlDatabase,
  type Viewer,
} from "@aimmo/core";
import {
  CoproprieteUrbanisme,
  DOCUMENT_KINDS,
  PUBLIC_SOURCES,
  type PublicFact,
  type UrbanismValue,
} from "../../core/src/documents/copropriete-urbanisme.ts";
import {
  LectureCopropriete,
  PDF_LIMITS,
  PDF_TEXT_REFUSAL_TEXT,
  pagesForReading,
  pagesToRead,
  pdfPagesText,
  type CoproReader,
  type UrbanismPoint,
} from "../../core/src/documents/index.ts";
import { gateSaleFile } from "../../core/src/dossiers/acces-dossier.ts";
import type { Geocoder } from "../../core/src/estimation/collecte.ts";
import { readCapped } from "./studio.ts";

export const TRIAL_MODE = "essai";
/** Le corps d'une requête : le texte des pages de 30 documents tient largement dans 4 Mo. */
export const MAX_COPROPRIETE_BODY_BYTES = 4 * 1024 * 1024;
/** La confiance minimale du géocodage pour demander la zone : en dessous, l'adresse n'est pas sûre. */
export const MIN_GEOCODE_SCORE = 0.6;
const MAX_ADDRESS = 200;
/** Le délai d'un service public (géocodage, Géoportail) : au-delà, il est en panne et le résumé se prépare sans lui. */
export const PUBLIC_SERVICE_TIMEOUT_MS = 8_000;
const ID = "([A-Za-z0-9_-]{1,64})";

export interface CoproprieteServices {
  db: SqlDatabase;
  journal: JournalStore;
  now: () => Date;
  newId?: () => string;
  /** Le lecteur IA de la prélecture ; absent, aucune phrase n'est proposée et tout est à lire [R12]. */
  reader?: CoproReader | null;
  /** La Base adresse nationale ; absente, la zone n'est pas collectée. */
  geocoder?: Geocoder | null;
  /** Le Géoportail de l'urbanisme (`GpuUrbanism`) ; absent, la zone n'est pas collectée. */
  urbanism?: {
    collect(point: UrbanismPoint): Promise<PublicFact<UrbanismValue>>;
  } | null;
  /** Le délai de chaque service public ; `PUBLIC_SERVICE_TIMEOUT_MS` par défaut. */
  timeoutMs?: number;
}

const TIMED_OUT = Symbol("délai");

/** La réponse du service, ou `TIMED_OUT` s'il ne répond pas à temps : un service lent ne bloque jamais le résumé. */
async function within<T>(
  ms: number,
  work: () => Promise<T>,
): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<typeof TIMED_OUT>(
        (resolve) => (timer = setTimeout(() => resolve(TIMED_OUT), ms)),
      ),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

type Role = Viewer["role"];
const WRITER: readonly Role[] = ["agent"];
const READERS: readonly Role[] = ["agent", "direction", "compliance"];

export interface CoproprieteRoute {
  method: "GET" | "POST";
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  /** Les rôles admis : un autre est refusé, au journal, avant toute lecture du corps [R16]. */
  roles: readonly Role[];
  handle: (
    s: CoproprieteServices,
    viewer: Viewer,
    params: string[],
    request: Request,
  ) => Promise<Response>;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });

type Outcome =
  | { ok: true; value?: unknown }
  | { ok: false; rule: string | null; code: string };

/** 200 ; 403 refus de droits ; 404 dossier ou résumé inconnu ; 409 dossier arrêté ou préparation simultanée ; 400 sinon. */
function reply(result: Outcome): Response {
  if (result.ok)
    return json(200, {
      ok: true,
      mode: TRIAL_MODE,
      data: result.value ?? null,
    });
  const { rule, code } = result;
  if (code === "unknown_file" || code === "no_summary")
    return json(404, { ok: false, rule, code });
  if (rule === "R16") return json(403, { ok: false, rule, code });
  if (code === "file_stopped" || code === "busy")
    return json(409, { ok: false, rule, code });
  return json(400, { ok: false, rule, code });
}

async function readJson(
  request: Request,
): Promise<Record<string, unknown> | null> {
  if (
    !(request.headers.get("content-type") ?? "")
      .toLowerCase()
      .startsWith("application/json")
  )
    return null;
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_COPROPRIETE_BODY_BYTES)
    return null;
  // Lu par morceaux et coupé dès le plafond, même sans longueur annoncée : jamais tout en mémoire (remarque de Codex).
  const bytes = await readCapped(request, MAX_COPROPRIETE_BODY_BYTES);
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Les objets métier, faits à chaque requête sur les mêmes services. */
export function coproprieteCore(s: CoproprieteServices) {
  const store = new FicheClient(s.db, { now: s.now });
  const acces = new Acces(
    s.db,
    store,
    new FicheUnique(s.db, store, { now: s.now }),
    s.journal,
    { now: s.now },
  );
  return {
    acces,
    summary: new CoproprieteUrbanisme(s.db, acces, s.journal, {
      now: s.now,
      ...(s.newId ? { newId: s.newId } : {}),
    }),
    preReading: new LectureCopropriete(
      s.db,
      acces,
      s.journal,
      s.reader ?? null,
      { now: s.now },
    ),
  };
}

const actor = (v: Viewer): string => `${String(v.role)}:${v.userId}`;

/** Un rôle que la route n'admet pas : refusé et écrit au journal, avant toute lecture [R16]. */
async function refuseRole(
  s: CoproprieteServices,
  v: Viewer,
  fileId: string,
): Promise<Response> {
  await appendEvent(
    s.journal,
    {
      type: "acces.refuse",
      actor: actor(v),
      subject: `sale_file:${fileId}`,
      data: {
        rule: "R16",
        role: String(v.role),
        kind: "coownership_summary",
        code: "role",
      },
    },
    s.now,
  );
  return reply({ ok: false, rule: "R16", code: "role" });
}

const guarded =
  (
    roles: readonly Role[],
    fn: (
      s: CoproprieteServices,
      v: Viewer,
      fileId: string,
      request: Request,
    ) => Promise<Response>,
  ) =>
  async (
    s: CoproprieteServices,
    v: Viewer,
    [fileId]: string[],
    request: Request,
  ): Promise<Response> =>
    roles.includes(v.role)
      ? fn(s, v, fileId!, request)
      : refuseRole(s, v, fileId!);

type Collection = "trouve" | "introuvable" | "panne" | "non_collecte";

/**
 * La zone d'urbanisme au point du bien, ou `undefined` quand elle n'est pas collectée. L'adresse tapée ne sert qu'au
 * géocodage : elle n'est ni rendue, ni gardée, ni écrite au journal [R13].
 */
async function collectUrbanism(
  s: CoproprieteServices,
  propertyId: string,
  address: string | null,
): Promise<{
  fact: PublicFact<UrbanismValue> | undefined;
  outcome: Collection;
  why: string | null;
}> {
  if (address === null || !s.geocoder || !s.urbanism)
    return {
      fact: undefined,
      outcome: "non_collecte",
      why: address === null ? "sans_adresse" : "service_absent",
    };
  const failed = (reason: "introuvable" | "panne", why: string) => ({
    fact: {
      ok: false as const,
      source: PUBLIC_SOURCES.urbanism,
      collectedAt: s.now().toISOString(),
      reason,
    },
    outcome: reason,
    why,
  });
  const property = await s.db.first<{ postal_code: string | null }>(
    "SELECT postal_code FROM properties WHERE id = ?",
    [propertyId],
  );
  const timeout = s.timeoutMs ?? PUBLIC_SERVICE_TIMEOUT_MS;
  const geocoder = s.geocoder;
  let place;
  try {
    place = await within(timeout, () => geocoder.geocode(address));
  } catch {
    return failed("panne", "geocodage_en_panne");
  }
  if (place === TIMED_OUT) return failed("panne", "geocodage_en_panne");
  if (!place) return failed("introuvable", "adresse_introuvable");
  if (!(typeof place.score === "number" && place.score >= MIN_GEOCODE_SCORE))
    return failed("introuvable", "adresse_incertaine");
  // La zone n'est demandée que dans la commune du bien : une adresse d'ailleurs ne décrit pas ce bien.
  if (!property?.postal_code || place.postalCode !== property.postal_code)
    return failed("introuvable", "autre_commune");
  if (
    !Number.isFinite(place.lat) ||
    !Number.isFinite(place.lon) ||
    typeof place.inseeCode !== "string"
  )
    return failed("introuvable", "adresse_introuvable");
  const urbanism = s.urbanism;
  const point = { lat: place.lat, lon: place.lon, inseeCode: place.inseeCode };
  try {
    const fact = await within(timeout, () => urbanism.collect(point));
    if (fact === TIMED_OUT) return failed("panne", "geoportail_en_panne");
    return { fact, outcome: fact.ok ? "trouve" : fact.reason, why: null };
  } catch {
    return failed("panne", "geoportail_en_panne");
  }
}

async function prepare(
  s: CoproprieteServices,
  v: Viewer,
  fileId: string,
  request: Request,
): Promise<Response> {
  const body = await readJson(request);
  if (!body) return json(400, { ok: false, rule: null, code: "invalid_body" });
  // Une donnée publique ne vient jamais de l'écran : elle est collectée ici, à sa source [R449].
  if ("publicData" in body || "registry" in body || "urbanism" in body)
    return json(400, {
      ok: false,
      rule: "R449",
      code: "public_data_not_accepted",
    });
  const rawAddress = body.address;
  if (
    rawAddress !== undefined &&
    rawAddress !== null &&
    (typeof rawAddress !== "string" || rawAddress.length > MAX_ADDRESS)
  )
    return json(400, { ok: false, rule: null, code: "invalid_address" });
  const address =
    typeof rawAddress === "string" && rawAddress.trim().length > 0
      ? rawAddress.trim()
      : null;

  const c = coproprieteCore(s);
  // Le dossier d'abord : un refus ne fait partir aucune requête, ni au géocodage ni au Géoportail [R16].
  const g = await gateSaleFile(
    { db: s.db, acces: c.acces, journal: s.journal, now: s.now },
    v,
    fileId,
    true,
    "coownership_summary",
  );
  if (!g.ok) return reply(g);
  if (!Array.isArray(body.documents) || !Array.isArray(body.sentences))
    return json(400, { ok: false, rule: null, code: "bad_documents" });

  const urbanism = await collectUrbanism(s, g.file.property_id, address);
  await appendEvent(
    s.journal,
    {
      type: "dossier.urbanisme_collecte",
      actor: actor(v),
      subject: `sale_file:${fileId}`,
      data: { rule: "R449", outcome: urbanism.outcome, why: urbanism.why },
    },
    s.now,
  );
  const r = await c.summary.prepare(v, fileId, {
    documents: body.documents as never,
    sentences: body.sentences as never,
    publicData: urbanism.fact ? { urbanism: urbanism.fact } : {},
  });
  return reply(r);
}

async function preRead(
  s: CoproprieteServices,
  v: Viewer,
  fileId: string,
  request: Request,
): Promise<Response> {
  const body = await readJson(request);
  if (!body) return json(400, { ok: false, rule: null, code: "invalid_body" });
  return reply(
    await coproprieteCore(s).preReading.preRead(v, fileId, {
      documents: body.documents,
    }),
  );
}

/** Le PDF déposé : la limite de la lecture du texte (RC40). */
export const MAX_COPROPRIETE_PDF_BYTES = PDF_LIMITS.maxBytes;
/** Le texte d'une page au-delà duquel la prélecture la refuse. */
const MAX_PAGE_CHARS = 100_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const hex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

const pagesInWords = (pages: number[]): string | null =>
  pages.length === 0
    ? null
    : pages.length === 1
      ? `La page ${pages[0]} n’a pas pu être lue : lisez-la vous-même.`
      : `Les pages ${pages.slice(0, -1).join(", ")} et ${pages[pages.length - 1]} n’ont pas pu être lues : lisez-les vous-même.`;

/**
 * Un PDF de la copropriété ou de l'urbanisme déposé tel quel (RC53). Le dossier est contrôlé avant toute lecture du
 * corps [R16] ; le texte est tiré sans IA, une page qu'on ne sait pas lire est nommée, jamais devinée [R12] ; la
 * prélecture reçoit le document sous la référence `sha256:<empreinte du fichier>`. Ni le PDF ni son texte ne sont
 * gardés ni écrits au journal [R13] : ils sont rendus à l'agent, qui les envoie au résumé.
 */
async function preReadPdf(
  s: CoproprieteServices,
  v: Viewer,
  fileId: string,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind");
  const meetingDay = url.searchParams.get("meetingDay");
  if (kind === null || !(DOCUMENT_KINDS as readonly string[]).includes(kind))
    return json(400, { ok: false, rule: null, code: "bad_kind" });
  if (
    kind === "pv_assemblee"
      ? meetingDay === null || !DAY.test(meetingDay)
      : meetingDay !== null
  )
    return json(400, { ok: false, rule: null, code: "bad_meeting_day" });

  const c = coproprieteCore(s);
  // Le dossier d'abord : un refus ne lit jamais le PDF [R16].
  const g = await gateSaleFile(
    { db: s.db, acces: c.acces, journal: s.journal, now: s.now },
    v,
    fileId,
    true,
    "coownership_summary",
  );
  if (!g.ok) return reply(g);

  const type = (request.headers.get("content-type") ?? "")
    .toLowerCase()
    .split(";")[0]!
    .trim();
  if (type !== "application/pdf")
    return json(415, {
      ok: false,
      rule: null,
      code: "not_pdf_body",
      message: "Déposez le document en PDF.",
    });
  const declared = Number(request.headers.get("content-length") ?? "0");
  const tooLarge = () =>
    json(413, {
      ok: false,
      rule: null,
      code: "too_large",
      message: PDF_TEXT_REFUSAL_TEXT.too_large,
    });
  if (Number.isFinite(declared) && declared > MAX_COPROPRIETE_PDF_BYTES)
    return tooLarge();
  const bytes = await readCapped(request, MAX_COPROPRIETE_PDF_BYTES);
  if (!bytes) return tooLarge();

  const read = await pdfPagesText(bytes);
  if (!read.ok)
    return json(422, {
      ok: false,
      rule: null,
      code: read.code,
      message: PDF_TEXT_REFUSAL_TEXT[read.code],
    });
  const pages = pagesForReading(read.value.pages);
  if (pages.length === 0)
    return json(422, {
      ok: false,
      rule: null,
      code: "unreadable",
      message: PDF_TEXT_REFUSAL_TEXT.unreadable,
    });
  if (pages.some((p) => p.length > MAX_PAGE_CHARS))
    return json(422, {
      ok: false,
      rule: null,
      code: "page_too_long",
      message:
        "Une page de ce PDF porte trop de texte pour être prélue. Lisez-la vous-même.",
    });

  const ref = `sha256:${hex(await crypto.subtle.digest("SHA-256", bytes))}`;
  const document = {
    kind,
    ref,
    pages,
    ...(meetingDay !== null ? { meetingDay } : {}),
  };
  const r = await c.preReading.preRead(v, fileId, { documents: [document] });
  if (!r.ok) return reply(r);
  const unread = pagesToRead(read.value.pages);
  return reply({
    ok: true,
    value: {
      document,
      pagesToRead: unread,
      pagesToReadText: pagesInWords(unread),
      reading: r.value,
    },
  });
}

export function coproprieteRoutes(): CoproprieteRoute[] {
  return [
    {
      method: "POST",
      pattern: new RegExp(`^/dossiers/${ID}/copropriete/pdf$`),
      name: "copropriete.pdf",
      roles: WRITER,
      handle: guarded(WRITER, preReadPdf),
    },
    {
      method: "POST",
      pattern: new RegExp(`^/dossiers/${ID}/copropriete/prelecture$`),
      name: "copropriete.prelecture",
      roles: WRITER,
      handle: guarded(WRITER, preRead),
    },
    {
      method: "POST",
      pattern: new RegExp(`^/dossiers/${ID}/copropriete/resume$`),
      name: "copropriete.preparer",
      roles: WRITER,
      handle: guarded(WRITER, prepare),
    },
    {
      method: "GET",
      pattern: new RegExp(`^/dossiers/${ID}/copropriete/resume$`),
      name: "copropriete.resume",
      roles: READERS,
      handle: guarded(READERS, async (s, v, fileId) =>
        reply(await coproprieteCore(s).summary.latest(v, fileId)),
      ),
    },
    {
      method: "GET",
      pattern: new RegExp(`^/dossiers/${ID}/copropriete/acquereur$`),
      name: "copropriete.acquereur",
      roles: READERS,
      handle: guarded(READERS, async (s, v, fileId) =>
        reply(await coproprieteCore(s).summary.buyerNotice(v, fileId)),
      ),
    },
  ];
}
