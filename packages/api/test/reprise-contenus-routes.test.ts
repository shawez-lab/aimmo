import { expect, it } from 'vitest';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '@aimmo/core';
import { PortesPhases, type PhaseConditionReading } from '../../core/src/conditions-phases/index.ts';
import type { Challenge } from '../../core/src/securite/index.ts';
import { FakeAuthenticator, ORIGIN, RP } from '../../core/test/appareil-simule.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';
import { LOT_ROUTE_OCTETS, base64Of } from '../src/cles.ts';
import { R2FichiersPlages, plagesBucket, type R2PlagesBucket } from '../src/reprise-fichiers.ts';
import { fichiersReprise } from '../src/worker.ts';
import { TRANCHE_OCTETS, pieceRecomposee, type EmpreintePiece } from '../../core/src/licences/index.ts';

// Réseaux, agences, SIREN, cartes, utilisateurs, appareils simulés et clés inventés.
const START = '2028-01-10T09:00:00.000Z';

/** Un compartiment R2 en mémoire : `head` dit la taille, `get` lit une plage ; chaque lecture est notée. */
class FakeBucket implements R2PlagesBucket {
  readonly objects = new Map<string, Uint8Array>();
  readonly reads: string[] = [];
  broken = false;
  async head(key: string) {
    if (this.broken) throw new Error('panne');
    const o = this.objects.get(key);
    return o ? { size: o.byteLength } : null;
  }
  async get(key: string, options?: { range?: { offset: number; length: number } }) {
    if (this.broken) throw new Error('panne');
    this.reads.push(key);
    const o = this.objects.get(key);
    if (!o) return null;
    const part = options?.range ? o.slice(options.range.offset, options.range.offset + options.range.length) : o.slice();
    return { arrayBuffer: async () => part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength) as ArrayBuffer };
  }
}
const bytes = (n: number, seed: number): Uint8Array => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 0xff;
  return b;
};
const fromBase64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('');

const KEYS = {
  direction: 'test-cle-br17-direction-aaaaaaaaaaaaaaaaaaaaaa',
  agent: 'test-cle-br17-agent-bbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  agence: 'test-cle-br17-agence-licence-dddddddddddddddddd',
  agenceAgent: 'test-cle-br17-agence-agent-eeeeeeeeeeeeeeeeeee',
  autre: 'test-cle-br17-agence-autre-fffffffffffffffffffff',
};
type Who = keyof typeof KEYS;
type Body = { ok: boolean; data?: any; rule?: string | null; code?: string };
const AGENCE = { agencyName: 'Agence du Lac (essai)', siren: '123456782', cardNumber: 'CPI 7501 2027 000 000 001', cardExpiresOn: '2030-06-30', department: '75' };
const AUTRE = { agencyName: 'Cabinet des Prés (essai)', siren: '732829320', cardNumber: 'CPI 6901 2027 000 000 002', cardExpiresOn: '2030-06-30', department: '69' };
const met = (): PhaseConditionReading => ({ met: true, reasons: [], evidence: { essai: 1 } });

async function setup(withFiles = true) {
  const raw = openMemoryDatabase();
  const db: SqlDatabase = fromSyncSqlite(raw);
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date(START);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const network = await store.createNetwork('Réseau test');
  const agentId = (await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Essai' })).id;
  const direction = { role: 'direction', userId: 'direction-1', networkId: network.id } as Viewer;
  const portes = new PortesPhases(db, journal, { now, sources: { 1: async () => met(), 2: async () => met(), 3: async () => met(), 4: async () => met() } });
  for (const phase of [2, 3, 4, 5]) {
    const r = await portes.open(direction, { phase });
    if (!r.ok) throw new Error(r.code);
  }
  const base = [
    { sha256: await sha256Hex(KEYS.direction), expiresOn: "2099-12-31", networkId: network.id, role: 'direction', userId: 'direction-1' },
    { sha256: await sha256Hex(KEYS.agent), expiresOn: "2099-12-31", networkId: network.id, role: 'agent', userId: agentId },
  ];
  const media = new FakeBucket();
  const pieces = new FakeBucket();
  const config: ApiConfig = { db, apiKeys: JSON.stringify(base), mode: 'essai', now, cles: { rpId: RP, origins: [ORIGIN] }, fichiersReprise: withFiles ? new R2FichiersPlages([media, pieces]) : null };
  const http = async (who: Who, method: string, path: string, body?: unknown, rawBody?: string): Promise<{ status: number; body: Body }> => {
    const headers: Record<string, string> = { authorization: `Bearer ${KEYS[who]}` };
    if (body !== undefined || rawBody !== undefined) headers['content-type'] = 'application/json';
    const payload = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
    const r = await handleRequest(new Request(`https://aimmo-api.example.test/v1${path}`, { method, headers, ...(payload === undefined ? {} : { body: payload }) }), config);
    return { status: r.status, body: (await r.json()) as Body };
  };
  expect((await http('direction', 'POST', '/licences/tarif', { monthlyCents: 29_900, reason: 'Tarif d’essai' })).status).toBe(200);
  const lac = (await http('direction', 'POST', '/licences/licence', AGENCE)).body.data as { id: string; licenseeNetworkId: string };
  const pres = (await http('direction', 'POST', '/licences/licence', AUTRE)).body.data as { id: string; licenseeNetworkId: string };
  // Dans chaque agence, une fiche à elle ; rien d'une autre ne doit sortir.
  const lacAgent = (await store.createAgent({ networkId: lac.licenseeNetworkId, firstName: 'Lou', lastName: 'Lac' })).id;
  await store.createAgent({ networkId: pres.licenseeNetworkId, firstName: 'Pia', lastName: 'Prés' });
  config.apiKeys = JSON.stringify([
    ...base,
    { sha256: await sha256Hex(KEYS.agence), expiresOn: "2099-12-31", networkId: lac.licenseeNetworkId, role: 'direction', userId: 'direction-lac' },
    { sha256: await sha256Hex(KEYS.agenceAgent), expiresOn: "2099-12-31", networkId: lac.licenseeNetworkId, role: 'agent', userId: lacAgent },
    { sha256: await sha256Hex(KEYS.autre), expiresOn: "2099-12-31", networkId: pres.licenseeNetworkId, role: 'direction', userId: 'direction-pres' },
  ]);
  const enroll = async (who: Who, seed: number) => {
    const device = await FakeAuthenticator.create(seed);
    const c = await http(who, 'POST', '/cles/enregistrement/debut');
    if (c.status !== 200) throw new Error(`début ${c.body.code}`);
    const done = await http(who, 'POST', '/cles/enregistrement/fin', await device.register(c.body.data as Challenge));
    if (done.status !== 200) throw new Error(`fin ${done.body.code}`);
    return device;
  };
  const stepUp = async (who: Who, device: FakeAuthenticator, action: string, subject: string) => {
    const c = await http(who, 'POST', '/cles/preuve/debut', { action, subject });
    if (c.status !== 200) throw new Error(`preuve ${c.body.code}`);
    const p = await http(who, 'POST', '/cles/preuve/fin', await device.sign(c.body.data as Challenge));
    if (p.status !== 200) throw new Error(`preuve ${p.body.code}`);
    return p.body.data.stepUpId as string;
  };
  const events = async (type: string) => (await journal.all()).filter((e) => e.type === type);
  const count = async (table: string) => Number((await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))?.n ?? 0);
  // Les pièces de l'agence : une note, une vidéo plus grosse qu'un lot de la route, une référence dans deux
  // compartiments, une clé du coffre ; et une note d'une autre agence. Tout est inventé.
  const at = START;
  const note = (net: string, id: string, ref: string) =>
    db.run("INSERT INTO voice_notes (id, network_id, channel, external_id, status, media_ref, mime, transcript, created_at) VALUES (?, ?, 'whatsapp', ?, 'transcrite', ?, 'audio/ogg', 'Bonjour, essai.', ?)", [id, net, `ext-${id}`, ref, at]);
  await note(lac.licenseeNetworkId, 'note-lac-1', 'stock/lac/note-1.ogg');
  await note(lac.licenseeNetworkId, 'note-lac-2', 'stock/lac/visite.mp4');
  await note(lac.licenseeNetworkId, 'note-lac-3', 'stock/lac/double.ogg');
  await note(lac.licenseeNetworkId, 'note-lac-4', 'coffre/lac/piece-1');
  await note(pres.licenseeNetworkId, 'note-pres-1', 'stock/pres/note-1.ogg');
  const video = bytes(LOT_ROUTE_OCTETS + 1_000, 7);
  media.objects.set('stock/lac/note-1.ogg', bytes(1_200, 1));
  pieces.objects.set('stock/lac/visite.mp4', video);
  media.objects.set('stock/lac/double.ogg', bytes(50, 2));
  pieces.objects.set('stock/lac/double.ogg', bytes(50, 3));
  media.objects.set('coffre/lac/piece-1', bytes(10, 4));
  media.objects.set('stock/pres/note-1.ogg', bytes(40, 5));
  let device: FakeAuthenticator | null = null;
  const proof = async () => {
    device ??= await enroll('agence', 11);
    return stepUp('agence', device, 'export_complet', `licence:${lac.id}`);
  };
  const reprise = async () => {
    const made = await http('agence', 'POST', '/export/agence', { stepUpId: await proof() });
    if (made.status !== 200) throw new Error(`reprise ${made.body.code}`);
    return made.body.data.document as { fichiers: { ref: string }[]; tables: Record<string, Record<string, unknown>[]> };
  };
  const indexOf = (doc: { fichiers: { ref: string }[] }, ref: string) => doc.fichiers.findIndex((f) => f.ref === ref);
  return { db, network, lac, pres, lacAgent, http, enroll, stepUp, events, count, media, pieces, video, proof, reprise, indexOf, journal };
}


describeWithSqlite('BR82 · routes du contenu des fichiers de la reprise, en lots et en tranches, depuis R2', () => {
  const PATHS = ['/export/agence/contenus', '/export/agence/contenus/piece', '/export/agence/contenus/tranche'];

  it('[R16] un autre rôle est refusé en 403 avant le corps, refus au journal, rien de lu', async () => {
    const t = await setup();
    for (const who of ['agent', 'agenceAgent'] as Who[]) {
      for (const path of PATHS) {
        const before = (await t.events('acces.refuse')).length;
        const r = await t.http(who, 'POST', path, undefined, 'pas un objet');
        expect(r, `${who} ${path}`).toMatchObject({ status: 403, body: { rule: 'R16', code: 'role' } });
        expect((await t.events('acces.refuse')).length).toBe(before + 1);
      }
    }
    expect(t.media.reads.concat(t.pieces.reads)).toEqual([]);
  });

  it('[R601] [R659] sans preuve rien n’est lu ; un fichier changé ou d’une autre agence ne l’ouvre jamais', async () => {
    const t = await setup();
    const doc = await t.reprise();
    expect(await t.http('agence', 'POST', '/export/agence/contenus', { document: doc })).toMatchObject({ status: 409, body: { rule: 'R601' } });
    const i = t.indexOf(doc, 'stock/lac/note-1.ogg');
    expect(await t.http('agence', 'POST', '/export/agence/contenus/piece', { document: doc, index: i })).toMatchObject({ status: 409, body: { rule: 'R601' } });
    expect(await t.http('agence', 'POST', '/export/agence/contenus/tranche', { document: doc, index: i, debut: 0 })).toMatchObject({ status: 409, body: { rule: 'R601' } });
    // Une référence d'une autre agence glissée dans le fichier : refusé, rien de lu, même avec une preuve.
    const slipped = JSON.parse(JSON.stringify(doc)) as typeof doc;
    slipped.fichiers[i] = { ...slipped.fichiers[i]!, ref: 'stock/pres/note-1.ogg' };
    for (const path of PATHS) {
      const r = await t.http('agence', 'POST', path, { document: slipped, stepUpId: await t.proof(), ...(path.endsWith('contenus') ? {} : { index: i }), ...(path.endsWith('tranche') ? { debut: 0 } : {}) });
      expect(r, path).toMatchObject({ status: 409, body: { rule: 'R659', code: 'fichier_non_verifie' } });
    }
    expect(await t.http('autre', 'POST', '/export/agence/contenus', { document: doc })).toMatchObject({ status: 409, body: { rule: 'R659' } });
    expect(t.media.reads.concat(t.pieces.reads)).toEqual([]);
    expect(await t.events('licences.reprise.contenus')).toHaveLength(0);
  });

  it('[R666] [R663] un lot rend les octets en base64 avec leur empreinte, 8 Mo au plus ; deux compartiments ou le coffre : absente', async () => {
    const t = await setup();
    const doc = await t.reprise();
    expect(doc.fichiers.map((f) => f.ref).sort()).toEqual(['coffre/lac/piece-1', 'stock/lac/double.ogg', 'stock/lac/note-1.ogg', 'stock/lac/visite.mp4']);
    const r = await t.http('agence', 'POST', '/export/agence/contenus', { document: doc, stepUpId: await t.proof() });
    expect(r).toMatchObject({ status: 200, body: { ok: true, mode: 'essai', data: { depuis: 0, suite: null } } });
    const lot = r.body.data as { pieces: { ref: string; statut: string; sha256: string | null; taille: number | null; contenu: string | null }[]; manifeste: string; fingerprint: string };
    const by = (ref: string) => lot.pieces.find((p) => p.ref === ref)!;
    const note = by('stock/lac/note-1.ogg');
    expect(note).toMatchObject({ statut: 'remise', taille: 1_200 });
    const got = fromBase64(note.contenu!);
    expect(got).toEqual(t.media.objects.get('stock/lac/note-1.ogg'));
    expect(note.sha256).toBe(await hex(got));
    // Plus grosse qu'un lot de la route : dite par sa taille, jamais lue entière.
    expect(by('stock/lac/visite.mp4')).toMatchObject({ statut: 'trop_grosse', taille: t.video.byteLength, contenu: null });
    expect(t.pieces.reads).not.toContain('stock/lac/visite.mp4');
    // Une référence que deux compartiments ont : laquelle est la pièce de l'agence ne se devine pas.
    expect(by('stock/lac/double.ogg')).toMatchObject({ statut: 'absente', contenu: null });
    expect(by('coffre/lac/piece-1')).toMatchObject({ statut: 'absente', contenu: null });
    expect(t.media.reads.concat(t.pieces.reads)).toEqual(['stock/lac/note-1.ogg']);
    // La suite par sa place : depuis la fin, un lot vide ; hors de la liste, refusé.
    expect((await t.http('agence', 'POST', '/export/agence/contenus', { document: doc, stepUpId: await t.proof(), depuis: doc.fichiers.length })).body.data).toMatchObject({ pieces: [], suite: null });
    expect(await t.http('agence', 'POST', '/export/agence/contenus', { document: doc, stepUpId: await t.proof(), depuis: doc.fichiers.length + 1 })).toMatchObject({ status: 409, body: { rule: 'R659', code: 'bad_input' } });
    // Au journal : les empreintes et des comptes, jamais une référence ni un contenu [R13].
    const logged = await t.events('licences.reprise.contenus');
    expect(logged[0]!.data).toMatchObject({ manifeste: lot.manifeste, fingerprint: lot.fingerprint, remises: 1, tropGrosses: 1, absentes: 2 });
    const text = JSON.stringify(await t.journal.all());
    for (const secret of ['stock/lac', 'coffre/lac', note.contenu!.slice(0, 24)]) expect(text).not.toContain(secret);
  });

  it('[R667] une pièce plus grosse qu’un lot : son empreinte, puis chaque tranche, recomposée égale ; une tranche altérée n’est jamais rendue', async () => {
    const t = await setup();
    const doc = await t.reprise();
    const i = t.indexOf(doc, 'stock/lac/visite.mp4');
    const e = await t.http('agence', 'POST', '/export/agence/contenus/piece', { document: doc, stepUpId: await t.proof(), index: i });
    expect(e).toMatchObject({ status: 200, body: { data: { statut: 'prete', taille: t.video.byteLength, sha256: await hex(t.video), trancheOctets: TRANCHE_OCTETS } } });
    const empreinte = e.body.data as EmpreintePiece;
    expect(empreinte.tranches.map((x) => x.debut)).toEqual([0, TRANCHE_OCTETS]);
    const parts: Uint8Array[] = [];
    let debut: number | null = 0;
    while (debut !== null) {
      const attendue = empreinte.tranches.find((x) => x.debut === debut)!.sha256;
      const r = await t.http('agence', 'POST', '/export/agence/contenus/tranche', { document: doc, stepUpId: await t.proof(), index: i, debut, attendue });
      expect(r).toMatchObject({ status: 200, body: { data: { statut: 'remise', sha256: attendue } } });
      parts.push(fromBase64(r.body.data.contenu as string));
      debut = r.body.data.suite as number | null;
    }
    expect(await pieceRecomposee(empreinte, parts)).toBe(true);
    // Un octet changé au stockage après l'empreinte : la tranche est « altérée », rien n'est rendu.
    { const v = t.pieces.objects.get('stock/lac/visite.mp4')!; v[TRANCHE_OCTETS + 3] = v[TRANCHE_OCTETS + 3]! ^ 0xff; }
    const altered = await t.http('agence', 'POST', '/export/agence/contenus/tranche', { document: doc, stepUpId: await t.proof(), index: i, debut: TRANCHE_OCTETS, attendue: empreinte.tranches[1]!.sha256 });
    expect(altered).toMatchObject({ status: 200, body: { data: { statut: 'alteree', contenu: null } } });
    // Une place qui n'est pas au bord d'une tranche, une empreinte mal formée : refusées.
    expect(await t.http('agence', 'POST', '/export/agence/contenus/tranche', { document: doc, stepUpId: await t.proof(), index: i, debut: 5 })).toMatchObject({ status: 409, body: { rule: 'R659', code: 'bad_input' } });
    expect(await t.http('agence', 'POST', '/export/agence/contenus/tranche', { document: doc, stepUpId: await t.proof(), index: i, debut: 0, attendue: 'abc' })).toMatchObject({ status: 409, body: { rule: 'R659', code: 'bad_input' } });
    // La référence dans deux compartiments : absente, jamais lue.
    const d = t.indexOf(doc, 'stock/lac/double.ogg');
    expect((await t.http('agence', 'POST', '/export/agence/contenus/piece', { document: doc, stepUpId: await t.proof(), index: d })).body.data).toMatchObject({ statut: 'absente', tranches: [] });
    expect(t.media.reads.concat(t.pieces.reads)).not.toContain('stock/lac/double.ogg');
    const text = JSON.stringify(await t.journal.all());
    expect(text).not.toContain('stock/lac');
  });

  it('sans compartiment de fichiers : 503, rien de lu ; champ non prévu : 400', async () => {
    const t = await setup(false);
    const doc = await t.reprise();
    for (const path of PATHS) {
      expect(await t.http('agence', 'POST', path, { document: doc, stepUpId: 'x' }), path).toMatchObject({ status: 503, body: { code: 'fichiers_non_branches' } });
    }
    const u = await setup();
    for (const path of PATHS) expect(await u.http('agence', 'POST', path, { document: {}, encore: 1 }), path).toMatchObject({ status: 400, body: { code: 'unknown_field' } });
  });

  it('[R663] le stockage R2 : une référence lue dans le seul compartiment qui l’a, par plage, jamais dans deux ; le Worker ne donne pas le coffre', async () => {
    const a = new FakeBucket();
    const b = new FakeBucket();
    a.objects.set('x', bytes(20, 1));
    b.objects.set('y', bytes(30, 2));
    a.objects.set('z', bytes(5, 3));
    b.objects.set('z', bytes(5, 3));
    const s = new R2FichiersPlages([a, null, b]);
    expect(await s.taille('x')).toBe(20);
    expect(await s.taille('y')).toBe(30);
    expect(await s.taille('z')).toBeNull();
    expect(await s.taille('absent')).toBeNull();
    expect(await s.lirePlage('y', 10, 5)).toEqual(bytes(30, 2).slice(10, 15));
    expect(await s.lirePlage('y', 0, 0)).toEqual(new Uint8Array());
    expect(await s.read('x')).toEqual(bytes(20, 1));
    expect(await s.read('z')).toBeNull();
    expect(a.reads.concat(b.reads)).not.toContain('z');
    // Une panne remonte : le cœur la dit « absente ».
    b.broken = true;
    await expect(s.taille('x')).rejects.toThrow();
    // Un compartiment sans `head` ou sans `get` n'est pas lu.
    expect(plagesBucket({ get: async () => null })).toBeNull();
    expect(plagesBucket(undefined)).toBeNull();
    // Le Worker donne les médias, les pièces et les commerces ; jamais le coffre, qui n'est pas lu.
    const coffre = new FakeBucket();
    coffre.objects.set('x', bytes(1, 9));
    const fromEnv = fichiersReprise({ MEDIA: a as never, PIECES: undefined, COMMERCES: undefined, COFFRE: coffre } as never)!;
    expect(await fromEnv.taille('x')).toBe(20);
    expect(fichiersReprise({} as never)).toBeNull();
    expect(base64Of(new Uint8Array([0, 255, 1]))).toBe('AP8B');
  });
});
