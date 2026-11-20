import { expect, it } from 'vitest';
import { DecisionEnvoi, FicheClient, FicheUnique, Planificateur, copyKeyFromSecret, type ErasureLedgerStore, type Viewer } from '@aimmo/core';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { CONFORMITE_DAILY_JOB, CONFORMITE_HOURLY_JOB, R2VaultStorage, conformiteJobs, conformiteRoutes, type ConformiteServices, type R2VaultBucket } from '../src/conformite.ts';
import { sha256Hex } from '../src/index.ts';
import { runScheduler } from '../src/planificateur.ts';
import { setupDossier } from '../../core/test/dossiers-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// Tout est inventé : réseau, agents, clients, pièces (quelques octets sans signification), clés.
const PDF = new TextEncoder().encode('%PDF-1.7 piece inventee pour le test');

/** Un faux compartiment R2 : les octets rangés, sous leur clé. */
class FakeBucket implements R2VaultBucket {
  readonly objects = new Map<string, { bytes: Uint8Array; type: string | undefined }>();
  async put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown> {
    this.objects.set(key, { bytes: new Uint8Array(value), type: options?.httpMetadata?.contentType });
    return { key };
  }
  async get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null> {
    const o = this.objects.get(key);
    return o ? { arrayBuffer: async () => o.bytes.slice().buffer } : null;
  }
}

let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

async function setup() {
  const t = await setupDossier('appartement');
  const fiches = new FicheClient(t.db, { now: t.now });
  const stop = new DecisionEnvoi(t.db, fiches, new FicheUnique(t.db, fiches, { now: t.now }), { now: t.now });
  const bucket = new FakeBucket();
  const vault = new R2VaultStorage(bucket, uuid);
  const routes = conformiteRoutes();
  const compliance: Viewer = { ...t.direction, role: 'compliance', userId: 'conformite-1' };
  const call = async (
    viewer: Viewer,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    options: { raw?: Uint8Array; type?: string; vault?: boolean; erasure?: ConformiteServices['erasure'] } = {},
  ) => {
    const bare = `/conformite${path.split('?')[0]!}`;
    const route = routes.find((r) => r.method === method && r.pattern.test(bare));
    if (!route) throw new Error(`route inconnue ${method} ${path}`);
    const params = (route.pattern.exec(bare) ?? []).slice(1);
    const init: RequestInit = options.raw
      ? { method, headers: { 'content-type': options.type ?? 'application/pdf' }, body: options.raw }
      : body === undefined
        ? { method }
        : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
    const s: ConformiteServices = { db: t.db, journal: t.journal, acces: t.acces, stop, vault: options.vault === false ? null : vault, now: t.now, ...(options.erasure !== undefined ? { erasure: options.erasure } : {}) };
    const response = await route.handle(s, viewer, params, new Request(`https://api.exemple.test/v1/conformite${path}`, init));
    const type = response.headers.get('content-type') ?? '';
    return {
      status: response.status,
      type,
      headers: response.headers,
      bytes: type.startsWith('application/json') ? null : new Uint8Array(await response.arrayBuffer()),
      body: type.startsWith('application/json') ? ((await response.json()) as { ok: boolean; data?: any; code?: string; rule?: string; receipt?: any; id?: string; status?: string }) : null,
    };
  };
  const refusals = async () => (await t.journal.all()).filter((e) => e.type === 'acces.refuse').length;
  return { ...t, stop, bucket, vault, routes, compliance, call, refusals };
}

describeWithSqlite('L09 · routes de M12', () => {
  it('[R16] chaque lecture et chaque décision du responsable refuse l’agent et la direction, au journal', async () => {
    const t = await setup();
    const before = await t.refusals();
    const reads = [
      `/personnes/${t.buyerId}/coffre`,
      '/coffre/piece-1',
      '/vigilance',
      '/signalements',
      '/signalements/s-1/fige',
      '/demandes',
      '/demandes/alertes',
      '/demandes/d-1/acces',
      '/demandes/d-1/effacement',
      '/registre/alertes',
      '/prospects',
      '/fuites',
      '/fuites/alertes',
      '/fuites/f-1/personnes',
      '/risque',
    ];
    for (const path of reads) {
      for (const v of [t.agent, t.direction]) expect([path, v.role, (await t.call(v, 'GET', path)).status]).toEqual([path, v.role, 403]);
    }
    const writes: [string, unknown][] = [
      ['/vigilance/reglage', { priceGapPercent: 20, amountThresholdEur: 10000, validatorName: 'Responsable Test' }],
      ['/vigilance/a-1/decider', { decision: 'classee', reason: 'Test', validatorName: 'Responsable Test' }],
      ['/signalements/s-1/decider', { decision: 'classe', reason: 'Test', validatorName: 'Responsable Test' }],
      ['/demandes', { personId: t.buyerId, kind: 'acces', channel: 'mail', receivedOn: '2027-03-01' }],
      ['/demandes/d-1/repondre', { answeredOn: '2027-03-01' }],
      ['/demandes/d-1/effacer', {}],
      ['/registre/relecture', { reviewedOn: '2027-03-01', validatorName: 'Responsable Test' }],
      ['/fuites', { awareAt: '2027-03-01T08:00:00.000Z' }],
      ['/fuites/f-1/retablir', { cutId: 'c-1' }],
      ['/fuites/f-1/evaluer', { risk: 'eleve', nature: ['confidentialite'], categories: ['identite'], scope: { kind: 'reseau' } }],
      ['/fuites/f-1/notification', { target: 'cnil', notifiedAt: '2027-03-01T09:00:00.000Z' }],
      [`/risque/r-1/valider`, { validatorName: 'Responsable Test' }],
    ];
    for (const [path, body] of writes) {
      for (const v of [t.agent, t.direction]) expect([path, v.role, (await t.call(v, 'POST', path, body)).status]).toEqual([path, v.role, 403]);
    }
    expect((await t.refusals()) - before).toBe((reads.length + writes.length) * 2);
    // L'état de la relecture du registre est lu aussi par la direction, jamais par un agent [R95].
    expect((await t.call(t.direction, 'GET', '/registre')).status).toBe(200);
    expect((await t.call(t.agent, 'GET', '/registre')).status).toBe(403);
  });

  it('[R90] l’agent dépose une pièce par son corps brut ; seul le responsable la lit et l’ouvre, octet pour octet', async () => {
    const t = await setup();
    const path = `/personnes/${t.buyerId}/coffre?sorte=passeport&verifie=2027-03-01&valide=2031-03-01`;
    const deposit = await t.call(t.agent, 'POST', path, undefined, { raw: PDF });
    expect(deposit.status).toBe(200);
    expect(deposit.body!.receipt).toMatchObject({ kind: 'passeport', sha256: await sha256Hex(new TextDecoder().decode(PDF)) });
    // Rangé sous le réseau, sous une clé tirée au hasard : ni nom, ni numéro.
    const [key] = [...t.bucket.objects.keys()];
    expect(key).toMatch(new RegExp(`^coffre/${t.network.id}/00000000-0000-4000-8000-\\d{12}$`));
    expect(t.bucket.objects.get(key!)!.type).toBe('application/pdf');
    // L'agent relit ses preuves de dépôt, jamais la pièce.
    const receipts = await t.call(t.agent, 'GET', `/personnes/${t.buyerId}/coffre/recus`);
    expect(receipts.body!.data.map((r: { pieceId: string }) => r.pieceId)).toEqual([deposit.body!.receipt.pieceId]);
    expect((await t.call(t.agent, 'GET', `/coffre/${deposit.body!.receipt.pieceId}`)).status).toBe(403);
    // Un autre agent ne dépose rien pour le client d'Alex.
    expect((await t.call(t.sam, 'POST', path, undefined, { raw: PDF })).status).toBe(403);
    // Le responsable lit la liste et ouvre la pièce, en pièce jointe.
    const list = await t.call(t.compliance, 'GET', `/personnes/${t.buyerId}/coffre`);
    expect(list.status).toBe(200);
    const opened = await t.call(t.compliance, 'GET', `/coffre/${deposit.body!.receipt.pieceId}`);
    expect(opened.status).toBe(200);
    expect(opened.type).toBe('application/pdf');
    expect(opened.headers.get('content-disposition')).toBe('attachment; filename="piece.pdf"');
    expect(opened.headers.get('cache-control')).toBe('no-store');
    expect([...opened.bytes!]).toEqual([...PDF]);
    // RC51 : l'empreinte vérifiée part avec la pièce, celle des octets rendus.
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', opened.bytes!));
    expect(opened.headers.get('repr-digest')).toBe(`sha-256=:${Buffer.from(digest).toString('base64')}:`);
    // Rien de la pièce au journal.
    expect(JSON.stringify(await t.journal.all())).not.toContain(key);
  });

  it('[R90] RC51 : une pièce changée au stockage n’est jamais remise, une pièce absente non plus, et chacun le lit en mots', async () => {
    const t = await setup();
    const deposit = await t.call(t.agent, 'POST', `/personnes/${t.buyerId}/coffre?sorte=passeport&verifie=2027-03-01`, undefined, { raw: PDF });
    const pieceId = deposit.body!.receipt.pieceId as string;
    const [key] = [...t.bucket.objects.keys()];
    const opens = async () => (await t.journal.all()).filter((e) => e.type === 'coffre.ouvert').length;

    // Intacte : une seule ligne « ouvert » au journal, écrite après la vérification.
    const before = await opens();
    expect((await t.call(t.compliance, 'GET', `/coffre/${pieceId}`)).status).toBe(200);
    expect((await opens()) - before).toBe(1);

    // Un octet changé au stockage : refus en mots, rien de la pièce rendu, aucun « ouvert ».
    const changed = new Uint8Array(PDF);
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
    t.bucket.objects.set(key!, { bytes: changed, type: 'application/pdf' });
    const altered = await t.call(t.compliance, 'GET', `/coffre/${pieceId}`);
    expect(altered).toMatchObject({ status: 409, body: { ok: false, rule: 'R90', code: 'altered' } });
    expect((altered.body as { message?: string }).message).toMatch(/n’est pas remise/);
    expect(JSON.stringify(altered.body)).not.toContain('piece inventee');
    expect(altered.headers.get('repr-digest')).toBeNull();
    // Un octet de plus : altérée aussi.
    t.bucket.objects.set(key!, { bytes: new Uint8Array([...PDF, 0]), type: 'application/pdf' });
    expect(await t.call(t.compliance, 'GET', `/coffre/${pieceId}`)).toMatchObject({ status: 409, body: { code: 'altered' } });
    expect((await opens()) - before).toBe(1);
    expect((await t.journal.all()).filter((e) => e.type === 'coffre.altere')).toHaveLength(2);

    // Absente du stockage : 404 en mots.
    t.bucket.objects.delete(key!);
    const missing = await t.call(t.compliance, 'GET', `/coffre/${pieceId}`);
    expect(missing).toMatchObject({ status: 404, body: { ok: false, rule: 'R90', code: 'missing' } });
    expect((missing.body as { message?: string }).message).toMatch(/introuvable/);
    expect((await opens()) - before).toBe(1);

    // Agent, direction : refusés, le stockage jamais lu.
    t.bucket.objects.set(key!, { bytes: new Uint8Array(PDF), type: 'application/pdf' });
    let reads = 0;
    const get = t.bucket.get.bind(t.bucket);
    t.bucket.get = async (k: string) => {
      reads += 1;
      return get(k);
    };
    for (const v of [t.agent, t.direction]) expect((await t.call(v, 'GET', `/coffre/${pieceId}`)).status).toBe(403);
    expect(await t.call(t.compliance, 'GET', '/coffre/piece-inconnue')).toMatchObject({ status: 404 });
    expect(reads).toBe(0);
    // Et le responsable la relit, remise en état.
    expect((await t.call(t.compliance, 'GET', `/coffre/${pieceId}`)).status).toBe(200);
    expect(reads).toBe(1);
    // Rien de la clé au journal [R13].
    expect(JSON.stringify(await t.journal.all())).not.toContain(key);
  });

  it('[R90] une pièce d’un format inconnu, trop lourde, ou sans stockage du coffre est refusée sans rien ranger', async () => {
    const t = await setup();
    const path = `/personnes/${t.buyerId}/coffre?sorte=passeport&verifie=2027-03-01`;
    const count = async () => (await t.db.first<{ n: number }>('SELECT count(*) AS n FROM compliance_vault_pieces'))!.n;
    const before = await count();
    expect(await t.call(t.agent, 'POST', path, undefined, { raw: PDF, type: 'text/html' })).toMatchObject({ status: 400, body: { code: 'bad_content_type' } });
    expect(await t.call(t.agent, 'POST', path, undefined, { raw: new Uint8Array(10 * 1024 * 1024 + 1) })).toMatchObject({ status: 413, body: { code: 'too_large' } });
    expect(await t.call(t.agent, 'POST', path, undefined, { raw: PDF, vault: false })).toMatchObject({ status: 503, body: { code: 'vault_not_configured' } });
    expect(await t.call(t.compliance, 'GET', '/coffre/piece-1', undefined, { vault: false })).toMatchObject({ status: 503 });
    expect(await t.call(t.agent, 'POST', `/personnes/${t.buyerId}/coffre?sorte=carte_de_bibliotheque&verifie=2027-03-01`, undefined, { raw: PDF })).toMatchObject({ status: 404, body: { code: 'unknown_piece' } });
    expect(t.bucket.objects.size).toBe(0);
    expect(await count()).toBe(before);
  });

  it('[R90] une pièce envoyée sans longueur annoncée est lue par morceaux et arrêtée dès la taille admise dépassée', async () => {
    const t = await setup();
    const route = t.routes.find((r) => r.name === 'conformite.coffre_depot')!;
    const chunk = new Uint8Array(1024 * 1024);
    let pulled = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 30) controller.close();
        else controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request(`https://api.exemple.test/v1/conformite/personnes/${t.buyerId}/coffre?sorte=passeport&verifie=2027-03-01`, {
      method: 'POST',
      headers: { 'content-type': 'application/pdf' },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    expect(request.headers.get('content-length')).toBeNull();
    const response = await route.handle({ db: t.db, journal: t.journal, acces: t.acces, stop: t.stop, vault: t.vault, now: t.now }, t.agent, [t.buyerId], request);
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(15);
    expect(t.bucket.objects.size).toBe(0);
  });

  it('[R92] l’identification passe par sa route : une société sans bénéficiaire effectif est refusée', async () => {
    const t = await setup();
    expect(await t.call(t.agent, 'POST', `/personnes/${t.buyerId}/identification`, { entity: 'societe', beneficialOwners: [] })).toMatchObject({ status: 409, body: { rule: 'R92', code: 'beneficial_owners_missing' } });
    expect((await t.call(t.agent, 'POST', `/personnes/${t.buyerId}/identification`, { entity: 'personne' })).status).toBe(200);
    expect((await t.call(t.sam, 'POST', `/personnes/${t.buyerId}/identification`, { entity: 'personne' })).status).toBe(403);
    // Une clé de plus que celles admises : refusée, rien de rangé.
    expect((await t.call(t.agent, 'POST', `/personnes/${t.buyerId}/identification`, { entity: 'personne', note: 'x' })).status).toBe(400);
  });

  it('[R23] la fiche de risque : préparée par l’agent en réponses fermées, validée puis rejouée par le responsable', async () => {
    const t = await setup();
    const declarations = { politicallyExposed: false, cashPayment: false, legalEntity: false, remoteRelation: false };
    expect((await t.call(t.agent, 'POST', `/personnes/${t.buyerId}/risque`, { relation: 'offre', caseRef: `offer:${t.offerId}`, declarations: { ...declarations, origine: 'texte libre' } })).body).toMatchObject({ rule: 'R23' });
    const prepared = await t.call(t.agent, 'POST', `/personnes/${t.buyerId}/risque`, { relation: 'offre', caseRef: `offer:${t.offerId}`, declarations });
    expect([prepared.status, prepared.body]).toEqual([200, expect.anything()]);
    const sheetId = (prepared.body as unknown as { sheet: { sheetId: string } }).sheet.sheetId;
    // L10 : la fiche attend sa validation dans la liste du responsable, puis la quitte une fois validée [R91].
    const waiting = await t.call(t.compliance, 'GET', '/risque');
    expect([waiting.status, waiting.body?.data.map((s: { sheetId: string; status: string }) => [s.sheetId, s.status])]).toEqual([200, [[sheetId, 'non_validee']]]);
    expect((await t.call(t.compliance, 'POST', `/risque/${sheetId}/valider`, { validatorName: 'Responsable Test' })).status).toBe(200);
    expect((await t.call(t.compliance, 'GET', '/risque')).body?.data).toEqual([]);
    expect((await t.call(t.compliance, 'GET', `/risque/${sheetId}/rejouer`)).body).toMatchObject({ ok: true, same: true });
  });

  it('[R04] une opposition enregistrée par la route pose l’arrêt sur tous les canaux', async () => {
    const t = await setup();
    const recorded = await t.call(t.compliance, 'POST', '/demandes', { personId: t.buyerId, kind: 'opposition', channel: 'mail', receivedOn: '2027-03-01' });
    expect(recorded.status).toBe(200);
    expect(await t.db.first<{ n: number }>('SELECT count(*) AS n FROM exclusions WHERE person_id = ?', [t.buyerId])).toEqual({ n: 1 });
    expect((await t.call(t.compliance, 'GET', '/demandes')).body!.data).toHaveLength(1);
  });

  it('[R17] [R96] [R231] AU020 : l’effacement réel par sa route, fermé tant que le mode réel n’est pas écrit tel quel', async () => {
    const t = await setup();
    const recorded = await t.call(t.compliance, 'POST', '/demandes', { personId: t.buyerId, kind: 'effacement', channel: 'mail', receivedOn: '2027-03-01' });
    const id = recorded.body!.data.id as string;
    const parts = new Map<string, Uint8Array>();
    const store: ErasureLedgerStore = { put: async (k, b) => void parts.set(k, b), get: async (k) => parts.get(k) ?? null, list: async (p) => [...parts.keys()].filter((k) => k.startsWith(p)).sort() };
    const key = await copyKeyFromSecret(btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 3))));
    const removed: string[] = [];
    const ready = { ledger: { store, key }, objects: { remove: async (_s: string, k: string) => void removed.push(k) } };
    const person = () => t.db.first<{ first_name: string | null }>('SELECT first_name FROM persons WHERE id = ?', [t.buyerId]);
    const name = (await person())?.first_name ?? null;
    expect(name).not.toBeNull();
    // Le plan d'essai d'abord : sans lui, rien ne part [R96].
    expect((await t.call(t.compliance, 'POST', `/demandes/${id}/effacer`, {}, { erasure: { mode: 'reel', ...ready } })).body).toMatchObject({ ok: false, rule: 'R96', code: 'plan_not_prepared' });
    expect((await t.call(t.compliance, 'GET', `/demandes/${id}/effacement`)).status).toBe(200);
    // Sans configuration, ou un mode qui n'est pas `reel` tel quel : refusé, rien n'est effacé ni noté.
    for (const erasure of [undefined, null, { mode: 'REEL' as never, ...ready }, { mode: 'essai' as const, ...ready }]) {
      const r = await t.call(t.compliance, 'POST', `/demandes/${id}/effacer`, {}, { erasure });
      expect([r.status, r.body]).toEqual([409, { ok: false, rule: 'R17', code: 'trial_only' }]);
    }
    expect((await t.call(t.compliance, 'POST', `/demandes/${id}/effacer`, {}, { erasure: { mode: 'reel', ledger: null, objects: ready.objects } })).body).toMatchObject({ rule: 'R231', code: 'ledger_missing' });
    expect(parts.size).toBe(0);
    expect((await person())?.first_name).toBe(name);
    // Un corps inattendu est refusé avant tout.
    expect((await t.call(t.compliance, 'POST', `/demandes/${id}/effacer`, { personId: 'x' }, { erasure: { mode: 'reel', ...ready } })).status).toBe(400);
    // En mode réel : noté au registre, effacé, et la réponse dit `reel` avec le reçu et son empreinte, sans nom.
    const done = await t.call(t.compliance, 'POST', `/demandes/${id}/effacer`, {}, { erasure: { mode: 'reel', ...ready } });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ ok: true, mode: 'reel', data: { receipt: { requestId: id, mode: 'reel', records: 1 } } });
    expect(done.body!.data.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(done.body)).not.toContain(name!);
    expect(parts.size).toBeGreaterThan(0);
    expect((await person())?.first_name ?? null).toBeNull();
    expect((await t.journal.all()).at(-1)).toMatchObject({ type: 'rgpd.effacement', data: { rule: 'R17', mode: 'reel' } });
  });

  it('[R97] la fuite par les routes : déclarée, évaluée, accès coupés puis rétablis, notification notée', async () => {
    const t = await setup();
    const declared = await t.call(t.compliance, 'POST', '/fuites', { awareAt: t.now().toISOString() });
    expect(declared.status).toBe(200);
    const id = declared.body!.data.id as string;
    expect((await t.call(t.direction, 'POST', `/fuites/${id}/couper`, { scope: 'tous' })).status).toBe(200);
    expect((await t.call(t.compliance, 'POST', `/fuites/${id}/couper`, { scope: 'utilisateur' })).body).toMatchObject({ code: 'bad_scope' });
    expect((await t.call(t.agent, 'POST', `/fuites/${id}/couper`, { scope: 'tous' })).status).toBe(403);
    const evaluated = await t.call(t.compliance, 'POST', `/fuites/${id}/evaluer`, { risk: 'eleve', nature: ['confidentialite'], categories: ['identite', 'coordonnees'], scope: { kind: 'agent', agentId: t.alexId } });
    expect(evaluated.body!.data.due).toEqual({ cnil: true, personnes: true });
    const persons = await t.call(t.compliance, 'GET', `/fuites/${id}/personnes`);
    expect(persons.body!.data.personIds).toContain(t.buyerId);
    const breach = (await t.call(t.compliance, 'GET', '/fuites')).body!.data[0];
    expect((await t.call(t.compliance, 'POST', `/fuites/${id}/retablir`, { cutId: breach.cuts[0].id })).status).toBe(200);
    expect((await t.call(t.compliance, 'POST', `/fuites/${id}/notification`, { target: 'cnil', notifiedAt: t.now().toISOString() })).body!.data.notified.cnil).toMatchObject({ late: false });
  });
});

describeWithSqlite('L09 · coupure lue avant toute route du socle', () => {
  const KEYS = { alex: 'test-cle-l09-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa', direction: 'test-cle-l09-direction-bbbbbbbbbbbbbbbbbbbbbb', conformite: 'test-cle-l09-conformite-cccccccccccccccccccc' };
  type Who = keyof typeof KEYS;

  async function socle() {
    const t = await setup();
    const ids: Record<Who, { role: string; userId: string }> = { alex: { role: 'agent', userId: t.alexId }, direction: { role: 'direction', userId: t.direction.userId }, conformite: { role: 'compliance', userId: 'conformite-1' } };
    const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: t.network.id, ...ids[w] }))));
    const config: ApiConfig = { db: t.db, apiKeys, mode: 'essai', now: t.now, coffre: t.vault };
    const http = async (who: Who, method: string, path: string, body?: unknown) => {
      const headers: Record<string, string> = { authorization: `Bearer ${KEYS[who]}` };
      if (body !== undefined) headers['content-type'] = 'application/json';
      const r = await handleRequest(new Request(`https://aimmo-api.example.test/v1${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), config);
      return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; rule?: string; code?: string } };
    };
    return { ...t, http };
  }

  it('[R97] [R16] une coupure de tout le réseau ferme chaque route aux clés du secret, sauf au responsable ; rétablie, tout rouvre', async () => {
    const t = await socle();
    expect((await t.http('alex', 'GET', `/fiches/${t.buyerId}`)).status).toBe(200);
    const id = (await t.http('conformite', 'POST', '/conformite/fuites', { awareAt: t.now().toISOString() })).body.data.id as string;
    expect((await t.http('direction', 'POST', `/conformite/fuites/${id}/couper`, { scope: 'tous' })).status).toBe(200);
    const before = (await t.journal.all()).filter((e) => e.type === 'acces.refuse' && e.data.code === 'access_cut').length;
    expect(await t.http('alex', 'GET', `/fiches/${t.buyerId}`)).toMatchObject({ status: 403, body: { rule: 'R16', code: 'access_cut' } });
    expect(await t.http('direction', 'GET', '/pilotage/alertes')).toMatchObject({ status: 403, body: { code: 'access_cut' } });
    // Le responsable n'est jamais coupé : c'est lui qui traite la fuite.
    expect((await t.http('conformite', 'GET', '/conformite/fuites')).status).toBe(200);
    const after = (await t.journal.all()).filter((e) => e.type === 'acces.refuse' && e.data.code === 'access_cut');
    expect(after.length - before).toBe(2);
    expect(after.at(-1)!.data).toMatchObject({ rule: 'R16', kind: 'route.pilotage.alertes' });
    const cutId = (await t.http('conformite', 'GET', '/conformite/fuites')).body.data[0].cuts[0].id as string;
    expect((await t.http('conformite', 'POST', `/conformite/fuites/${id}/retablir`, { cutId })).status).toBe(200);
    expect((await t.http('alex', 'GET', `/fiches/${t.buyerId}`)).status).toBe(200);
  });

  it('[R97] une coupure d’une seule personne ne ferme que ses routes', async () => {
    const t = await socle();
    const id = (await t.http('conformite', 'POST', '/conformite/fuites', { awareAt: t.now().toISOString() })).body.data.id as string;
    expect((await t.http('conformite', 'POST', `/conformite/fuites/${id}/couper`, { scope: 'utilisateur', userId: t.alexId })).status).toBe(200);
    expect((await t.http('alex', 'GET', `/fiches/${t.buyerId}`)).body.code).toBe('access_cut');
    expect((await t.http('direction', 'GET', '/pilotage/alertes')).status).toBe(200);
  });
});

describeWithSqlite('L09 · passages de M12 au planificateur', () => {
  it('[R97] [R18] les passages tournent une fois par créneau : une alerte de fuite n’est rangée qu’une fois', async () => {
    const t = await setup();
    const declared = await t.call(t.compliance, 'POST', '/fuites', { awareAt: t.now().toISOString() });
    expect(declared.status).toBe(200);
    const jobs = conformiteJobs(t.db, t.journal, t.stop, { now: t.now });
    expect(jobs.map((j) => [j.name, j.hours.length])).toEqual([
      [CONFORMITE_HOURLY_JOB, 24],
      [CONFORMITE_DAILY_JOB, 1],
    ]);
    const planificateur = new Planificateur(t.db, t.journal, jobs, { now: t.now });
    const first = await planificateur.tick();
    expect(first.ran).toContain(CONFORMITE_HOURLY_JOB);
    const again = await planificateur.tick();
    expect(again.ran).toEqual([]);
    const alerts = await t.call(t.compliance, 'GET', '/fuites/alertes');
    expect(alerts.body!.data.map((a: { kind: string }) => a.kind)).toEqual(['connaissance']);
  });

  it('le planificateur du socle passe les tâches de M12 : les fuites chaque heure, les échéances à 6 h de Paris', async () => {
    const t = await setup();
    // 6 h 05 à Paris, en hiver (UTC + 1).
    t.setClock(new Date('2027-03-02T05:05:00.000Z'));
    const tick = await runScheduler({ db: t.db, mode: 'essai', now: t.now });
    expect(tick!.ran).toEqual(expect.arrayContaining([CONFORMITE_HOURLY_JOB, CONFORMITE_DAILY_JOB]));
    expect(tick!.failed).toEqual([]);
    t.setClock(new Date('2027-03-02T09:05:00.000Z'));
    const later = await runScheduler({ db: t.db, mode: 'essai', now: t.now });
    expect(later!.ran).toContain(CONFORMITE_HOURLY_JOB);
    expect(later!.ran).not.toContain(CONFORMITE_DAILY_JOB);
  });
});
