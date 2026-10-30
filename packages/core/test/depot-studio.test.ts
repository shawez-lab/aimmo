import { expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '../src/index.ts';
import { FicheBien } from '../src/annonces/index.ts';
import { DEPOSIT_MAX_BYTES, DepotsStudio, matchesSignature, type DepositInput } from '../src/studio/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, agents, biens et fichiers inventés : les octets ne sont que des en-têtes de type suivis de remplissage.
const TODAY = new Date('2027-10-14T08:00:00.000Z');
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 7, 7, 7, 7]);
const JPEG_2 = Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0, 16, 0x45, 0x78, 0x69, 0x66, 0, 0, 9, 9, 9, 9]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3, 4]);
const ascii = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
const WEBP = ascii('RIFF\x10\0\0\0WEBPVP8 ');
const MP4 = ascii('\0\0\0\x18ftypisom\0\0\x02\0');
const HEIC = ascii('\0\0\0\x18ftypheic\0\0\0\0');
const DNG = ascii('II*\0\x08\0\0\0abcdefgh');
const HTML = ascii('<html><script>alert(1)</script></html>');
const UUID = /^biens\/[A-Za-z0-9_-]+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/;

async function sha(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((x) => x.toString(16).padStart(2, '0')).join('');
}

const SHEET = {
  characteristics: { bedrooms: 1, floor: null, floorsTotal: null, buildYear: null, heating: null, outdoor: [], landM2: null, parkingSpaces: 0, elevator: null },
  energy: { energyClass: 'C', climateClass: 'C', annualCostMinEur: 800, annualCostMaxEur: 1100, costReferenceYear: 2025, diagnosedOn: '2027-09-01' },
  coownership: { isCoownership: false },
  risks: { inRiskZone: false },
  media: [] as { ref: string; kind: string; edit: string }[],
};

async function setup(opts: { failPut?: boolean } = {}) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = TODAY.getTime();
  const now = () => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const acces = new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alexandrine', lastName: 'Fictive' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Samuel', lastName: 'Inventé' });
  const as = (role: string, userId: string): Viewer => ({ role, userId, networkId: network.id }) as Viewer;
  const agent = as('agent', alex.id);
  const fiches = new FicheBien(db, acces, journal, { now });
  const property = async (withSheet = true, media: { ref: string; kind: string; edit: string }[] = []) => {
    const p = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: `DEP-${Math.random().toString(36).slice(2, 8)}`, kind: 'home', city: 'Villebrune', priceEur: 150_000, surfaceM2: 45, rooms: 2, status: 'available' });
    if (withSheet) {
      const saved = await fiches.save(agent, p.id, { ...SHEET, media: media.map((m) => ({ ...m, ref: m.ref.replace('PID', p.id) })) });
      if (!saved.ok) throw new Error(saved.code);
    }
    return p.id;
  };
  const kept = new Map<string, { bytes: Uint8Array; type: string }>();
  const depots = new DepotsStudio(db, acces, journal, {
    put: async (key, bytes, type) => {
      if (opts.failPut) throw new Error('panne');
      kept.set(key, { bytes, type });
    },
  }, { now });
  let reads = 0;
  const input = async (kind: string, bytes: Uint8Array, extra: Partial<DepositInput> = {}): Promise<DepositInput> => ({
    kind,
    edit: kind === 'photo' ? 'lumiere_cadrage' : undefined,
    contentType: kind === 'video' ? 'video/mp4' : 'image/jpeg',
    sha256: await sha(bytes),
    declaredSize: bytes.length,
    read: async (max) => (reads++, bytes.length > max ? null : bytes),
    ...extra,
  });
  const sheet = async (pid: string) => {
    const r = await fiches.read(agent, pid);
    return r.ok ? r.value : null;
  };
  const events = async (type: string) => (await journal.all()).filter((e) => e.type === type);
  return { db, depots, kept, input, sheet, events, property, fiches, agent, sam: as('agent', sam.id), direction: as('direction', 'd-1'), partner: as('partner', 'p-1'), compliance: as('compliance', 'c-1'), reads: () => reads };
}

it('X12 · les premiers octets disent le type, sans rien décoder', () => {
  expect(matchesSignature('image/jpeg', JPEG)).toBe(true);
  expect(matchesSignature('image/png', PNG)).toBe(true);
  expect(matchesSignature('image/webp', WEBP)).toBe(true);
  expect(matchesSignature('video/mp4', MP4)).toBe(true);
  expect(matchesSignature('image/heic', HEIC)).toBe(true);
  expect(matchesSignature('image/x-adobe-dng', DNG)).toBe(true);
  // Une page, un type croisé ou un fichier trop court ne passent pas.
  expect(matchesSignature('image/jpeg', HTML)).toBe(false);
  expect(matchesSignature('image/png', JPEG)).toBe(false);
  expect(matchesSignature('video/mp4', HEIC)).toBe(false);
  expect(matchesSignature('image/heic', MP4)).toBe(false);
  expect(matchesSignature('image/jpeg', JPEG.subarray(0, 5))).toBe(false);
  expect(matchesSignature('text/html', HTML)).toBe(false);
});

describeWithSqlite('X12 · dépôt des fichiers finis du Studio', () => {
  it('[R130] la photo corrigée est rangée à l’octet près, puis ajoutée à la fiche par une nouvelle version', async () => {
    const t = await setup();
    const pid = await t.property();
    const r = await t.depots.deposit(t.agent, pid, await t.input('photo', JPEG));
    expect(r).toMatchObject({ ok: true, value: { propertyId: pid, kind: 'photo', sha256: await sha(JPEG), size: JPEG.length, sheetVersion: 2 } });
    if (!r.ok) return;
    expect(r.value.ref).toMatch(UUID);
    expect(r.value.ref.startsWith(`biens/${pid}/`)).toBe(true);
    // Les octets rangés sont les octets reçus : rien n'est transformé.
    const kept = t.kept.get(r.value.ref)!;
    expect(kept.type).toBe('image/jpeg');
    expect([...kept.bytes]).toEqual([...JPEG]);
    expect(await sha(kept.bytes)).toBe(await sha(JPEG));
    const s = await t.sheet(pid);
    expect(s?.version).toBe(2);
    expect(s?.sheet.media).toEqual([{ ref: r.value.ref, kind: 'photo', edit: 'lumiere_cadrage' }]);
    // Au journal : la sorte, la taille, la référence ; jamais le contenu [R13].
    const [e] = await t.events('studio.depot');
    expect(e?.data).toEqual({ rule: 'R130', kind: 'photo', ref: r.value.ref, size: JPEG.length, sha256: await sha(JPEG) });
    expect(JSON.stringify(await t.events('studio.depot'))).not.toContain('Alexandrine');
  });

  it('[R130] une empreinte différente de celle dite par l’appareil : rien n’est rangé, la fiche ne bouge pas', async () => {
    const t = await setup();
    const pid = await t.property();
    for (const kind of ['photo', 'original'] as const) {
      const r = await t.depots.deposit(t.agent, pid, await t.input(kind, JPEG, { sha256: await sha(JPEG_2) }));
      expect(r).toEqual({ ok: false, rule: 'R130', code: 'empreinte_differente' });
    }
    expect(await t.depots.deposit(t.agent, pid, await t.input('photo', JPEG, { sha256: 'ABC' }))).toEqual({ ok: false, rule: 'R130', code: 'empreinte_absente' });
    expect(await t.depots.deposit(t.agent, pid, await t.input('photo', JPEG, { sha256: null }))).toEqual({ ok: false, rule: 'R130', code: 'empreinte_absente' });
    expect(t.kept.size).toBe(0);
    expect((await t.sheet(pid))?.version).toBe(1);
    expect((await t.events('studio.depot.refuse')).map((e) => e.data)).toContainEqual({ rule: 'R130', code: 'empreinte_differente' });
  });

  it('[R130] un original est rangé à part, sous originaux/, et n’entre jamais dans la fiche', async () => {
    const t = await setup();
    const pid = await t.property();
    for (const [type, bytes, ext] of [['image/jpeg', JPEG, 'jpg'], ['image/heic', HEIC, 'heic'], ['image/x-adobe-dng', DNG, 'dng'], ['image/png', PNG, 'png']] as const) {
      const r = await t.depots.deposit(t.agent, pid, await t.input('original', bytes, { contentType: type }));
      expect(r).toMatchObject({ ok: true, value: { kind: 'original', sheetVersion: null } });
      if (r.ok) expect(r.value.ref).toMatch(new RegExp(`^biens/${pid}/originaux/[0-9a-f-]{36}\\.${ext}$`));
    }
    expect(t.kept.size).toBe(4);
    const s = await t.sheet(pid);
    expect(s?.version).toBe(1);
    expect(s?.sheet.media).toEqual([]);
    // Un original se dépose même sans fiche : il n'y entre pas.
    const bare = await t.property(false);
    expect((await t.depots.deposit(t.agent, bare, await t.input('original', JPEG))).ok).toBe(true);
  });

  it('[R16] rôle et portée vérifiés avant de lire un seul octet, et le refus au journal', async () => {
    const t = await setup();
    const pid = await t.property();
    for (const v of [t.sam, t.partner, t.compliance]) {
      const r = await t.depots.deposit(v, pid, await t.input('photo', JPEG));
      expect(r, v.role).toMatchObject({ ok: false, rule: 'R16' });
    }
    expect(t.reads()).toBe(0);
    expect(t.kept.size).toBe(0);
    expect((await t.events('acces.refuse')).filter((e) => (e.data as { kind?: string }).kind === 'studio_depot').length).toBeGreaterThanOrEqual(2);
    expect(await t.depots.deposit(t.agent, 'bien-inconnu', await t.input('photo', JPEG))).toEqual({ ok: false, rule: null, code: 'unknown_property' });
    // La direction du réseau dépose aussi.
    expect((await t.depots.deposit(t.direction, pid, await t.input('photo', PNG, { contentType: 'image/png' }))).ok).toBe(true);
  });

  it('X12 · taille et type bornés ; une sorte, une retouche ou un fichier inattendus sont refusés sans rien ranger', async () => {
    const t = await setup();
    const pid = await t.property();
    const cases: [Partial<DepositInput> & { kind?: string }, Uint8Array, string][] = [
      [{ kind: 'document' }, JPEG, 'sorte_inconnue'],
      [{ edit: undefined }, JPEG, 'retouche_inconnue'],
      [{ edit: 'pinceau' }, JPEG, 'retouche_inconnue'],
      [{ contentType: 'image/heic' }, HEIC, 'type_refuse'], // un HEIC n'est pas une photo de la fiche
      [{ contentType: 'text/html' }, HTML, 'type_refuse'],
      [{ contentType: null }, JPEG, 'type_refuse'],
      [{}, HTML, 'type_refuse'], // annoncé JPEG, c'est une page
      [{ contentType: 'image/png' }, JPEG, 'type_refuse'],
      [{}, new Uint8Array(0), 'fichier_vide'],
      [{ declaredSize: DEPOSIT_MAX_BYTES.photo + 1 }, JPEG, 'trop_lourd'],
      [{ declaredSize: Number.NaN }, JPEG, 'trop_lourd'],
      [{ read: async () => null }, JPEG, 'trop_lourd'], // le corps dépasse, même sans taille annoncée
    ];
    for (const [extra, bytes, code] of cases) {
      const { kind, ...rest } = extra;
      const r = await t.depots.deposit(t.agent, pid, await t.input(kind ?? 'photo', bytes, rest));
      expect(r, code).toMatchObject({ ok: false, code });
    }
    // Une taille annoncée trop grande est refusée avant toute lecture.
    const before = t.reads();
    await t.depots.deposit(t.agent, pid, await t.input('video', MP4, { declaredSize: DEPOSIT_MAX_BYTES.video + 1 }));
    expect(t.reads()).toBe(before);
    // Une vidéo ne porte pas de retouche de photo ; un HEIC n'est pas une vidéo.
    expect(await t.depots.deposit(t.agent, pid, await t.input('video', MP4, { edit: 'lumiere_cadrage' }))).toMatchObject({ code: 'retouche_inconnue' });
    expect(await t.depots.deposit(t.agent, pid, await t.input('video', HEIC))).toMatchObject({ code: 'type_refuse' });
    expect(t.kept.size).toBe(0);
    expect((await t.sheet(pid))?.version).toBe(1);
    // Les bornes : une photo de téléphone, un original brut, une vidéo courte.
    expect(DEPOSIT_MAX_BYTES).toEqual({ photo: 20 * 1024 * 1024, original: 60 * 1024 * 1024, video: 95 * 1024 * 1024 });
  });

  it('X12 · la vidéo montée entre dans la fiche ; sans fiche, une photo n’est pas rangée', async () => {
    const t = await setup();
    const pid = await t.property();
    const v = await t.depots.deposit(t.agent, pid, await t.input('video', MP4));
    expect(v).toMatchObject({ ok: true, value: { kind: 'video', sheetVersion: 2 } });
    if (v.ok) {
      expect(v.value.ref).toMatch(new RegExp(`^biens/${pid}/[0-9a-f-]{36}\\.mp4$`));
      expect((await t.sheet(pid))?.sheet.media).toEqual([{ ref: v.value.ref, kind: 'video', edit: 'aucune' }]);
    }
    const bare = await t.property(false);
    expect(await t.depots.deposit(t.agent, bare, await t.input('photo', JPEG))).toEqual({ ok: false, rule: 'R10', code: 'fiche_absente' });
    expect(t.kept.size).toBe(1);
  });

  it('X12 · une fiche pleine refuse le fichier avant de le ranger', async () => {
    const t = await setup();
    const full = Array.from({ length: 80 }, (_, i) => ({ ref: `biens/PID/${String(i).padStart(8, '0')}-0000-4000-8000-000000000000.jpg`, kind: 'photo', edit: 'aucune' }));
    const pid = await t.property(true, full);
    expect(await t.depots.deposit(t.agent, pid, await t.input('photo', JPEG))).toEqual({ ok: false, rule: 'R10', code: 'fiche_pleine' });
    expect(t.kept.size).toBe(0);
  });

  it('[R130] un stockage en panne : rien n’entre dans la fiche, la panne est au journal', async () => {
    const t = await setup({ failPut: true });
    const pid = await t.property();
    expect(await t.depots.deposit(t.agent, pid, await t.input('photo', JPEG))).toEqual({ ok: false, rule: 'R130', code: 'stockage_indisponible' });
    expect((await t.sheet(pid))?.version).toBe(1);
    expect((await t.events('studio.depot.refuse')).map((e) => e.data)).toContainEqual({ rule: 'R130', code: 'stockage_indisponible' });
  });

  it('[R17] deux dépôts en même temps : les deux photos sont dans la fiche, aucune version n’en perd une', async () => {
    const t = await setup();
    const pid = await t.property();
    const [a, b] = await Promise.all([t.depots.deposit(t.agent, pid, await t.input('photo', JPEG)), t.depots.deposit(t.agent, pid, await t.input('photo', JPEG_2))]);
    expect(a.ok && b.ok).toBe(true);
    const s = await t.sheet(pid);
    expect(s?.version).toBe(3);
    expect(s?.sheet.media.map((m) => m.ref).sort()).toEqual([a.ok ? a.value.ref : '', b.ok ? b.value.ref : ''].sort());
    // Une écriture sur une version dépassée est refusée sans rien ranger.
    expect(await t.fiches.save(t.agent, pid, { ...SHEET, media: [] }, { ifVersion: 2 })).toEqual({ ok: false, rule: null, code: 'stale' });
    expect((await t.sheet(pid))?.version).toBe(3);
    expect((await t.fiches.save(t.agent, pid, { ...SHEET, media: s!.sheet.media }, { ifVersion: 3 })).ok).toBe(true);
  });
});
