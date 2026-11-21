/**
 * Les routes de M12 Conformité (L09), sous `/v1/conformite`, et ses passages au planificateur.
 *
 * Chaque route passe par les droits de la couche métier [R16], qui écrit chaque refus au journal : le responsable de la
 * conformité lit et décide ; l'agent dépose une pièce au coffre, déclare son client (personne ou société, avec ses
 * bénéficiaires effectifs), prépare la fiche de risque, fait examiner un dossier et signale un soupçon, pour ses seuls
 * clients ; la direction ne lit rien de la conformité, mais peut couper les accès lors d'une fuite.
 *
 * Le coffre est le seul dépôt des pièces d'identité depuis L03 [R90, R92] : son contenu entre par le corps brut de la
 * requête (PDF, JPEG ou PNG), jamais dans un journal ; il est rangé dans un stockage à part (`COFFRE`, R2). Sans ce
 * stockage, le dépôt et l'ouverture d'une pièce répondent « indisponible », sans rien lire.
 *
 * Les passages : chaque heure, les alertes de fuite (`Fuites.run`) ; à 6 h, les durées des prospects
 * (`DureesProspects.run`), les échéances des demandes des personnes et la relecture du registre. Rien n'est envoyé :
 * les alertes sont rangées pour l'écran du responsable.
 */
import {
  FicheClient,
  FicheUnique,
  conformite,
  type Acces,
  type CopyKey,
  type ErasureLedgerStore,
  type JournalStore,
  type ScheduledJob,
  type SqlDatabase,
  type Viewer,
} from '@aimmo/core';

export const TRIAL_MODE = 'essai';
const MAX_BODY_BYTES = 8_000;
const ID = '([A-Za-z0-9_-]{1,64})';

/** Le compartiment R2 du coffre (`COFFRE`), séparé de tout autre stockage. */
export interface R2VaultBucket {
  put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

/** Le coffre sur R2 : une clé tirée au hasard, rangée sous le réseau ; jamais un nom ni un numéro de pièce. */
export class R2VaultStorage implements conformite.VaultStorage {
  constructor(
    private readonly bucket: R2VaultBucket,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}
  async put(networkId: string, content: Uint8Array, contentType: conformite.VaultContentType): Promise<string> {
    const key = `coffre/${networkId}/${this.newId()}`;
    await this.bucket.put(key, content, { httpMetadata: { contentType } });
    return key;
  }
  async read(key: string): Promise<Uint8Array | null> {
    const object = await this.bucket.get(key);
    return object ? new Uint8Array(await object.arrayBuffer()) : null;
  }
}

/** Ce que les routes lisent du coffre : ranger une pièce, puis la relire pour le responsable. */
export interface VaultFiles extends conformite.VaultStorage {
  read(key: string): Promise<Uint8Array | null>;
}

/** Celui qui pose l'arrêt sur tous les canaux après une opposition [R04] : le contrôle central des envois. */
export type StopRecorder = ConstructorParameters<typeof conformite.DemandesPersonnes>[3];

export interface ConformiteServices {
  db: SqlDatabase;
  journal: JournalStore;
  acces: Acces;
  stop: StopRecorder;
  vault: VaultFiles | null;
  now: () => Date;
  /**
   * L'effacement réel (AU020) : son mode, le registre des effacements et le stockage des objets. Absent, ou mode autre
   * que `reel` écrit tel quel, la route refuse et rien n'est effacé : la mise en service attend H29.
   */
  erasure?: { mode: conformite.ErasureMode; ledger: { store: ErasureLedgerStore; key: CopyKey } | null; objects: conformite.ObjectEraser | null } | null;
}

export interface ConformiteRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  handle: (s: ConformiteServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...HEADERS } });

type Outcome = { ok: true; value?: unknown; [k: string]: unknown } | { ok: false; rule: string | null; code: string; [k: string]: unknown };

/** 200 ; 403 pour un refus de droits ; 404 inconnu ; 409 pour une règle ; 400 sinon. */
function reply(result: Outcome): Response {
  if (result.ok) {
    const { ok: _ok, value, ...rest } = result;
    return json(200, { ok: true, mode: TRIAL_MODE, data: value ?? null, ...rest });
  }
  const { ok: _ok, ...rest } = result;
  // Un refus de droits reste un refus de droits, quelle que soit la règle que la couche métier y attache (R90, R92).
  if (result.code === 'role' || result.code === 'not_assigned') return json(403, { ok: false, ...rest });
  if (result.rule === 'R16') return json(result.code === 'unknown' ? 404 : 403, { ok: false, ...rest });
  if (/^unknown/.test(result.code)) return json(404, { ok: false, ...rest });
  return json(result.rule ? 409 : 400, { ok: false, ...rest });
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
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
const noVault = (): Response => json(503, { ok: false, rule: null, code: 'vault_not_configured', message: 'Coffre indisponible : aucun stockage du coffre.' });
/** Les refus de lecture d'une pièce du coffre (RC51), dits en mots au responsable. */
export const VAULT_READ_MESSAGES = {
  altered: 'La pièce n’est pas remise : ses octets au stockage ne sont plus ceux du dépôt (empreinte différente).',
  missing: 'La pièce n’est pas remise : elle est introuvable au stockage du coffre, ou le stockage ne répond pas.',
} as const;

/** L'en-tête `Repr-Digest` (RFC 9530) d'une empreinte SHA-256 rangée en hexadécimal : `sha-256=:<base64>:`. */
export function reprDigest(sha256: string): string {
  const pairs = sha256.match(/../g) ?? [];
  return `sha-256=:${btoa(String.fromCharCode(...pairs.map((h) => parseInt(h, 16))))}:`;
}
const query = (r: Request, name: string): string | null => new URL(r.url).searchParams.get(name);

/**
 * Le contenu d'une pièce, lu dans le corps brut, sans jamais dépasser la taille admise : la longueur annoncée d'abord,
 * puis les octets reçus.
 */
async function readPiece(request: Request): Promise<{ content: Uint8Array; contentType: string } | { code: string }> {
  const contentType = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!(conformite.VAULT_CONTENT_TYPES as readonly string[]).includes(contentType)) return { code: 'bad_content_type' };
  const announced = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(announced) && announced > conformite.VAULT_MAX_BYTES) return { code: 'too_large' };
  // Lu par morceaux : sans longueur annoncée, la lecture s'arrête dès que la taille admise est dépassée.
  if (!request.body) return { content: new Uint8Array(0), contentType };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > conformite.VAULT_MAX_BYTES) {
      await reader.cancel();
      return { code: 'too_large' };
    }
    chunks.push(value);
  }
  const content = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    content.set(c, at);
    at += c.byteLength;
  }
  return { content, contentType };
}

const services = (s: ConformiteServices) => {
  const fiche = new FicheUnique(s.db, new FicheClient(s.db, { now: s.now }), { now: s.now });
  const coffre = new conformite.CoffreConformite(s.db, s.acces, s.vault ?? NO_VAULT, s.journal, { now: s.now });
  return {
    coffre,
    identification: new conformite.Identification(s.db, s.acces, s.journal, { now: s.now }),
    risque: new conformite.FicheRisque(s.db, s.acces, coffre, s.journal, { now: s.now }),
    vigilance: new conformite.VigilanceRenforcee(s.db, s.acces, s.journal, { now: s.now }),
    signalement: new conformite.SignalementSoupcon(s.db, s.acces, s.journal, { now: s.now }),
    dispositif: new conformite.DispositifLcb(s.db, s.journal, { now: s.now }),
    demandes: new conformite.DemandesPersonnes(s.db, s.journal, fiche, s.stop, { now: s.now }),
    durees: new conformite.DureesProspects(s.db, s.journal, fiche, { now: s.now }),
    registre: new conformite.RelectureRegistre(s.db, s.journal, { now: s.now }),
    fuites: new conformite.Fuites(s.db, s.journal, fiche, { now: s.now }),
    effacement: new conformite.EffacementReel(s.db, s.journal, fiche, {
      mode: conformite.erasureModeOf(s.erasure?.mode),
      ledger: s.erasure?.ledger ?? null,
      objects: s.erasure?.objects ?? null,
      now: s.now,
    }),
  };
};

/** Sans stockage, le coffre ne range rien : les routes qui en ont besoin répondent « indisponible » avant d'y venir. */
const NO_VAULT: conformite.VaultStorage = { put: () => Promise.reject(new Error('Coffre sans stockage.')) };

/**
 * La coupure lue avant toute route du socle (L08) : une fuite peut fermer l'accès de tout le réseau, sauf celui du
 * responsable, ou d'une seule personne ; les clés du secret, que le code ne réécrit pas, sont refusées ici.
 */
export async function accessCut(db: SqlDatabase, journal: JournalStore, viewer: Viewer, now: () => Date): Promise<boolean> {
  const fiche = new FicheUnique(db, new FicheClient(db, { now }), { now });
  return new conformite.Fuites(db, journal, fiche, { now }).accessCut(viewer.networkId, String(viewer.role), viewer.userId);
}

/** Les routes de M12, à ajouter à celles de `app.ts`. */
export function conformiteRoutes(): ConformiteRoute[] {
  const route = (method: 'GET' | 'POST', path: string, name: string, handle: ConformiteRoute['handle']): ConformiteRoute => ({
    method,
    pattern: new RegExp(`^/conformite${path}$`),
    name: `conformite.${name}`,
    handle,
  });
  /** Un corps JSON aux seules clés admises : une clé de plus est refusée, sans rien ranger. */
  const write = (allowed: readonly string[], fn: (s: ConformiteServices, v: Viewer, params: string[], body: Record<string, unknown>) => Promise<Response>): ConformiteRoute['handle'] => async (s, v, params, request) => {
    const body = await readJson(request);
    if (!body || Object.keys(body).some((k) => !allowed.includes(k))) return badBody();
    return fn(s, v, params, body);
  };
  const P = `/personnes/${ID}`;
  return [
    // Le coffre (L01) : dépôt par l'agent de la fiche ou le responsable ; lecture et ouverture par le responsable seul.
    route('POST', `${P}/coffre`, 'coffre_depot', async (s, v, [personId], r) => {
      if (!s.vault) return noVault();
      const piece = await readPiece(r);
      if ('code' in piece) return json(piece.code === 'too_large' ? 413 : 400, { ok: false, rule: null, code: piece.code });
      const optional = (name: string): string | null => query(r, name);
      return reply(
        await services(s).coffre.deposit(v, personId!, {
          kind: query(r, 'sorte'),
          content: piece.content,
          contentType: piece.contentType,
          verifiedOn: query(r, 'verifie'),
          validUntil: optional('valide'),
          caseRef: optional('dossier'),
          replaces: optional('remplace'),
        }),
      );
    }),
    route('GET', `${P}/coffre`, 'coffre_liste', async (s, v, [personId]) => reply(await services(s).coffre.list(v, personId!))),
    route('GET', `${P}/coffre/recus`, 'coffre_recus', async (s, v, [personId]) => reply(await services(s).coffre.receipts(v, personId!))),
    // RC51 : la pièce n'est remise que si ses octets sont ceux du dépôt (RC44), avec son empreinte vérifiée en en-tête.
    route('GET', `/coffre/${ID}`, 'coffre_ouvrir', async (s, v, [pieceId]) => {
      if (!s.vault) return noVault();
      const read = await services(s).coffre.read(v, pieceId!, s.vault);
      if (!read.ok) {
        if (read.code === 'altered') return json(409, { ...read, message: VAULT_READ_MESSAGES.altered });
        if (read.code === 'missing') return json(404, { ...read, message: VAULT_READ_MESSAGES.missing });
        return reply(read);
      }
      const extension = read.contentType === 'application/pdf' ? 'pdf' : read.contentType === 'image/png' ? 'png' : 'jpg';
      return new Response(read.content, {
        status: 200,
        headers: {
          'content-type': read.contentType,
          'content-disposition': `attachment; filename="piece.${extension}"`,
          'repr-digest': reprDigest(read.sha256),
          ...HEADERS,
        },
      });
    }),

    // L'identification (L03) : personne ou société, avec ses bénéficiaires effectifs [R92].
    route('POST', `${P}/identification`, 'identification', write(['entity', 'beneficialOwners'], async (s, v, [personId], b) => reply(await services(s).identification.declare(v, personId!, { entity: b.entity, beneficialOwners: b.beneficialOwners })))),

    // La fiche de risque (L02) : préparée par l'agent, validée par le responsable, rejouée à l'identique.
    route('POST', `${P}/risque`, 'risque_preparer', write(['relation', 'caseRef', 'declarations'], async (s, v, [personId], b) => reply(await services(s).risque.prepare(v, personId!, { relation: b.relation, caseRef: b.caseRef, declarations: b.declarations })))),
    route('GET', '/risque', 'risque_attente', async (s, v) => reply(await services(s).risque.pending(v))),
    route('GET', `${P}/risque`, 'risque_liste',async (s, v, [personId]) => reply(await services(s).risque.list(v, personId!))),
    route('POST', `/risque/${ID}/valider`, 'risque_valider', write(['validatorName', 'level', 'reason'], async (s, v, [id], b) => reply(await services(s).risque.validate(v, id!, { validatorName: b.validatorName, level: b.level, reason: b.reason })))),
    route('GET', `/risque/${ID}/rejouer`, 'risque_rejouer', async (s, v, [id]) => reply(await services(s).risque.replay(v, id!))),

    // La vigilance renforcée (L04) : le réglage et les décisions du responsable ; l'examen d'un dossier.
    route('POST', '/vigilance/reglage', 'vigilance_reglage', write(['priceGapPercent', 'amountThresholdEur', 'validatorName'], async (s, v, _p, b) => reply(await services(s).vigilance.setSettings(v, { priceGapPercent: b.priceGapPercent, amountThresholdEur: b.amountThresholdEur, validatorName: b.validatorName })))),
    route('POST', '/vigilance/examiner', 'vigilance_examiner', write(['caseRef'], async (s, v, _p, b) => reply(await services(s).vigilance.examine(v, b.caseRef)))),
    route('GET', '/vigilance', 'vigilance_alertes', async (s, v) => reply(await services(s).vigilance.list(v))),
    route('POST', `/vigilance/${ID}/decider`, 'vigilance_decider', write(['decision', 'reason', 'validatorName'], async (s, v, [id], b) => reply(await services(s).vigilance.decide(v, id!, { decision: b.decision, reason: b.reason, validatorName: b.validatorName })))),

    // Le signalement d'un soupçon (L05) : par l'agent, décidé par le responsable seul ; le dossier reste figé.
    // AU089 : le dispositif anti-blanchiment, un responsable nommé et une procédure approuvée, rangés par la direction [R94].
    route('GET', '/lcb/dispositif', 'lcb_dispositif', async (s, v) => reply(await services(s).dispositif.status(v))),
    route('POST', '/lcb/responsable', 'lcb_responsable', write(['officerUserId'], async (s, v, _p, b) => reply(await services(s).dispositif.designate(v, b.officerUserId)))),
    route('POST', '/lcb/procedure', 'lcb_procedure', write(['documentRef', 'documentSha256', 'approvedBy', 'approvedOn'], async (s, v, _p, b) => reply(await services(s).dispositif.approveProcedure(v, { documentRef: b.documentRef, documentSha256: b.documentSha256, approvedBy: b.approvedBy, approvedOn: b.approvedOn })))),
    route('POST', '/signalements', 'signalement', write(['caseRef', 'note'], async (s, v, _p, b) => reply(await services(s).signalement.report(v, b.caseRef, { note: b.note })))),
    route('GET', '/signalements', 'signalements', async (s, v) => reply(await services(s).signalement.list(v))),
    route('GET', `/signalements/${ID}/fige`, 'signalement_fige', async (s, v, [id]) => reply(await services(s).signalement.checkFrozen(v, id!))),
    route('POST', `/signalements/${ID}/decider`, 'signalement_decider', write(['decision', 'reason', 'validatorName'], async (s, v, [id], b) => reply(await services(s).signalement.decide(v, id!, { decision: b.decision, reason: b.reason, validatorName: b.validatorName })))),

    // Les demandes des personnes (L07) : enregistrées, préparées et répondues par le responsable [R96].
    route(
      'POST',
      '/demandes',
      'demande',
      write(['personId', 'kind', 'channel', 'receivedOn'], async (s, v, _p, b) =>
        reply(await services(s).demandes.record(v, b as unknown as Parameters<conformite.DemandesPersonnes['record']>[1])),
      ),
    ),
    route('GET', '/demandes', 'demandes', async (s, v) => reply(await services(s).demandes.list(v))),
    route('GET', '/demandes/alertes', 'demandes_alertes', async (s, v) => reply(await services(s).demandes.alerts(v))),
    route('GET', `/demandes/${ID}/acces`, 'demande_acces', async (s, v, [id]) => reply(await services(s).demandes.prepareAccess(v, id!))),
    route('GET', `/demandes/${ID}/effacement`, 'demande_effacement', async (s, v, [id]) => reply(await services(s).demandes.prepareErasure(v, id!))),
    // L'effacement réel (AU020) : après le plan d'essai, par le responsable seul, noté au registre avant d'effacer [R17, R231].
    route('POST', `/demandes/${ID}/effacer`, 'demande_effacer', write([], async (s, v, [id]) => {
        const r = await services(s).effacement.erase(v, id!);
        // Le seul succès qui n'est pas un essai : la réponse le dit.
        return r.ok ? json(200, { ok: true, mode: 'reel', data: r.value }) : reply(r);
      })),
    route('POST', `/demandes/${ID}/repondre`, 'demande_repondre', write(['answeredOn'], async (s, v, [id], b) => reply(await services(s).demandes.answer(v, id!, { answeredOn: b.answeredOn as string })))),

    // Le registre des traitements (L06) : sa relecture, tous les 12 mois [R95].
    route('GET', '/registre', 'registre', async (s, v) => reply(await services(s).registre.status(v))),
    route('POST', '/registre/relecture', 'registre_relecture', write(['reviewedOn', 'validatorName'], async (s, v, _p, b) => reply(await services(s).registre.recordReview(v, { reviewedOn: b.reviewedOn as string, validatorName: b.validatorName as string })))),
    route('GET', '/registre/alertes', 'registre_alertes', async (s, v) => reply(await services(s).registre.alerts(v))),

    // Les prospects arrivés à 3 ans (L08) [R97].
    route('GET', '/prospects', 'prospects', async (s, v) => reply(await services(s).durees.list(v))),

    // La procédure de fuite (L08) [R97].
    route('POST', '/fuites', 'fuite', write(['awareAt'], async (s, v, _p, b) => reply(await services(s).fuites.declare(v, { awareAt: b.awareAt as string })))),
    route('GET', '/fuites', 'fuites', async (s, v) => reply(await services(s).fuites.list(v))),
    route('GET', '/fuites/alertes', 'fuites_alertes', async (s, v) => reply(await services(s).fuites.alerts(v))),
    route(
      'POST',
      `/fuites/${ID}/couper`,
      'fuite_couper',
      write(['scope', 'userId'], async (s, v, [id], b) => {
        const scope: conformite.CutScope | null = b.scope === 'tous' && b.userId === undefined ? { kind: 'tous' } : b.scope === 'utilisateur' && typeof b.userId === 'string' ? { kind: 'utilisateur', userId: b.userId } : null;
        if (!scope) return json(400, { ok: false, rule: null, code: 'bad_scope' });
        return reply(await services(s).fuites.cutAccess(v, id!, scope));
      }),
    ),
    route('POST', `/fuites/${ID}/retablir`, 'fuite_retablir', write(['cutId'], async (s, v, [id], b) => reply(await services(s).fuites.restoreAccess(v, id!, b.cutId as string)))),
    route(
      'POST',
      `/fuites/${ID}/evaluer`,
      'fuite_evaluer',
      write(['risk', 'nature', 'categories', 'scope'], async (s, v, [id], b) => reply(await services(s).fuites.evaluate(v, id!, b as unknown as Parameters<conformite.Fuites['evaluate']>[2]))),
    ),
    route('GET', `/fuites/${ID}/personnes`, 'fuite_personnes', async (s, v, [id]) => reply(await services(s).fuites.concerned(v, id!))),
    route(
      'POST',
      `/fuites/${ID}/notification`,
      'fuite_notification',
      write(['target', 'notifiedAt', 'lateCause'], async (s, v, [id], b) => reply(await services(s).fuites.notified(v, id!, b as unknown as Parameters<conformite.Fuites['notified']>[2]))),
    ),
  ];
}

export const CONFORMITE_HOURLY_JOB = 'conformite.fuites';
export const CONFORMITE_DAILY_JOB = 'conformite.echeances';

const networks = (db: SqlDatabase): Promise<{ id: string }[]> => db.all<{ id: string }>('SELECT id FROM networks ORDER BY id');

/**
 * Les passages de M12 au planificateur : chaque heure, les alertes de fuite ; à 6 h, les durées des prospects, les
 * échéances des demandes des personnes et la relecture du registre. Le planificateur ne passe une tâche qu'une fois
 * par créneau, et chaque alerte n'est rangée qu'une fois par sa couche métier [R18].
 */
export function conformiteJobs(db: SqlDatabase, journal: JournalStore, stop: StopRecorder, options: { now?: () => Date } = {}): ScheduledJob[] {
  const now = options.now ?? (() => new Date());
  const fiche = () => new FicheUnique(db, new FicheClient(db, { now }), { now });
  return [
    {
      name: CONFORMITE_HOURLY_JOB,
      hours: Array.from({ length: 24 }, (_, h) => h),
      run: async () => {
        const fuites = new conformite.Fuites(db, journal, fiche(), { now });
        for (const n of await networks(db)) await fuites.run(n.id);
      },
    },
    {
      name: CONFORMITE_DAILY_JOB,
      hours: [6],
      run: async () => {
        const f = fiche();
        const durees = new conformite.DureesProspects(db, journal, f, { now });
        const demandes = new conformite.DemandesPersonnes(db, journal, f, stop, { now });
        const registre = new conformite.RelectureRegistre(db, journal, { now });
        for (const n of await networks(db)) {
          await durees.run(n.id);
          await demandes.run(n.id);
          await registre.run(n.id);
        }
      },
    },
  ];
}
