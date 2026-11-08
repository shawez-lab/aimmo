import { expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { photoCaption } from '../src/diffusion/textes.ts';
import { FiligranePhotos, watermarkName, watermarkSvg } from '../src/medias/index.ts';
import { CertificatsPhotos, checkLocalEdits, checkOperations, RETOUCH_MENTION } from '../src/studio/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const AT = Date.parse('2027-11-02T08:00:00.000Z');
const ref = (p: string, n: number) => `biens/${p}/0000000${n}-0000-4000-8000-000000000000.jpg`;
const orig = (p: string, n: number) => `biens/${p}/originaux/0000000${n}-0000-4000-8000-00000000000a.jpg`;
const sha = (c: string) => c.repeat(64);
const OPS = [{ op: 'exposition', ev: 0.5 }];
const RETOUCHES = [{ kind: 'ciel' }, { kind: 'reflets' }, { kind: 'objet_retire', object: 'poubelle_mobile' }];

it('[R490] seules les retouches locales de la liste fermée passent : ciel, reflets, objet mobile retiré ; jamais un défaut', () => {
  expect(checkLocalEdits(RETOUCHES)).toEqual({ ok: true, value: RETOUCHES });
  expect(checkLocalEdits(undefined)).toEqual({ ok: true, value: [] });
  expect(checkLocalEdits([])).toEqual({ ok: true, value: [] });
  // Un défaut ou ce qui tient au bien et à sa vue ne se retire jamais.
  for (const object of ['fissure', 'tache', 'humidite', 'pylone', 'antenne', 'vis_a_vis', 'cable_electrique', 'voiture']) {
    expect(checkLocalEdits([{ kind: 'objet_retire', object }]), object).toMatchObject({ ok: false, code: 'objet_hors_liste', index: 0 });
  }
  // Toute autre retouche locale reste refusée.
  for (const kind of ['effacement', 'lissage_peau', 'agrandir_piece', 'changer_vue', 'meubler']) {
    expect(checkLocalEdits([{ kind }]), kind).toMatchObject({ ok: false, code: 'retouche_hors_liste' });
  }
  expect(checkLocalEdits([{ kind: 'ciel' }, { kind: 'ciel' }])).toMatchObject({ ok: false, code: 'retouche_en_double', index: 1 });
  expect(checkLocalEdits([{ kind: 'objet_retire', object: 'linge' }, { kind: 'objet_retire', object: 'linge' }])).toMatchObject({ ok: false, code: 'retouche_en_double' });
  expect(checkLocalEdits([{ kind: 'objet_retire', object: 'linge' }, { kind: 'objet_retire', object: 'jouet' }])).toMatchObject({ ok: true });
  expect(checkLocalEdits([{ kind: 'ciel', zone: [0, 0, 1, 1] }])).toMatchObject({ ok: false, code: 'retouches_invalides' });
  expect(checkLocalEdits([{ kind: 'objet_retire' }])).toMatchObject({ ok: false, code: 'retouches_invalides' });
  expect(checkLocalEdits('ciel')).toMatchObject({ ok: false, code: 'retouches_invalides' });
  // Les corrections d'ensemble restent fermées aux retouches locales : elles passent par leur déclaration à part.
  expect(checkOperations([{ op: 'remplacement_ciel' }])).toMatchObject({ ok: false, code: 'retouche_locale' });
});

it('[R490] la légende d’une photo dit chaque retouche déclarée', () => {
  const facts = {} as never;
  const caption = photoCaption({ index: 2, total: 5, subject: null, facts, edit: 'lumiere_cadrage', overlay: null, retouches: ['ciel', 'objet_retire', 'objet_retire'] });
  expect(caption).toBe('Photo 2 sur 5 du bien. Lumière et cadrage retouchés. Photo retouchée : ciel remplacé, objet retiré.');
  expect(photoCaption({ index: 1, total: 1, subject: null, facts, edit: 'lumiere_cadrage', overlay: null })).toBe('Photo 1 sur 1 du bien. Lumière et cadrage retouchés.');
});

it('[R491] le calque du filigrane porte le texte, en bas à droite, sans rien au centre', () => {
  const svg = watermarkSvg('Alexandrine Fictive · AIMMO · abcdefgh2345', 4000, 3000);
  expect(svg).toContain('>Alexandrine Fictive · AIMMO · abcdefgh2345</text>');
  expect(svg).toContain('viewBox="0 0 4000 3000"');
  const y = Number(/<rect x="\d+" y="(\d+)"/.exec(svg)?.[1]);
  expect(y).toBeGreaterThan(3000 * 0.75);
  expect(watermarkSvg('<a> & "b"', 400, 400)).not.toMatch(/<a>|& /);
  expect(watermarkName(' Jean-Luc ', 'D’Arc <x>')).toBe('Jean-Luc D’Arc x');
  expect(watermarkName('', '')).toBeNull();
});

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = AT;
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const acces = new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now });
  let t = 0;
  const stored = new Set<string>();
  const storage = { has: async (r: string) => stored.has(r) };
  const certs = new CertificatsPhotos(db, acces, journal, storage, { now, newToken: () => (++t).toString(16).padStart(32, 'd') });
  let c = 0;
  const codes = ['abcdefgh2345', 'bcdefgh23456', 'cdefgh234567'];
  const { OrigineContacts } = await import('../src/attirer/origine-contacts.ts');
  const origine = new OrigineContacts(db, journal, { now, newCode: () => codes[c++ % codes.length]! });
  const filigrane = new FiligranePhotos(db, acces, journal, certs, { now, origine });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alexandrine', lastName: 'Fictive' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Samuel', lastName: 'Inventé' });
  const p = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'RET-40', kind: 'home', city: 'Villebrune', priceEur: 210_000, surfaceM2: 72, rooms: 3, status: 'available' });
  const media = [
    { ref: ref(p.id, 1), kind: 'photo', edit: 'lumiere_cadrage' },
    { ref: ref(p.id, 2), kind: 'photo', edit: 'aucune' },
    { ref: ref(p.id, 3), kind: 'photo', edit: 'amenagement_virtuel' },
    { ref: ref(p.id, 4), kind: 'photo', edit: 'lumiere_cadrage' },
  ];
  await db.run("INSERT INTO property_sheets (id, property_id, network_id, version, data, created_by, created_at) VALUES ('s-1', ?, ?, 1, ?, 'agent:a', '2027-10-01')", [
    p.id,
    network.id,
    JSON.stringify({ characteristics: { bedrooms: 1, outdoor: [], parkingSpaces: 0 }, energy: null, coownership: null, risks: null, media }),
  ]);
  for (let n = 1; n <= 4; n += 1) stored.add(ref(p.id, n)).add(orig(p.id, n));
  const as = (role: 'agent' | 'direction' | 'assistant', userId: string) => ({ role, userId, networkId: network.id }) as never;
  const input = (n: number, over: Record<string, unknown> = {}) => ({
    resultRef: ref(p.id, n),
    resultSha256: sha('b'),
    originalRef: orig(p.id, n),
    originalSha256: sha('a'),
    operations: OPS,
    processedOn: 'appareil',
    ...over,
  });
  return { db, journal, certs, filigrane, store, network, alex, sam, p, as, input };
}

describeWithSqlite('HX40 · retouches déclarées et filigrane', () => {
  it('[R490] une retouche locale sans la mention « Photo retouchée » est refusée, et rien n’est rangé', async () => {
    const t = await setup();
    const alex = t.as('agent', t.alex.id);
    expect(await t.certs.record(alex, t.p.id, t.input(1, { localEdits: RETOUCHES }))).toEqual({ ok: false, rule: 'R130', code: 'retouche_sans_mention' });
    expect(await t.certs.record(alex, t.p.id, t.input(1, { localEdits: RETOUCHES, mentionOnImage: 'Photo améliorée' }))).toEqual({ ok: false, rule: 'R130', code: 'retouche_sans_mention' });
    expect(await t.certs.record(alex, t.p.id, t.input(1, { localEdits: [{ kind: 'objet_retire', object: 'fissure' }], mentionOnImage: RETOUCH_MENTION }))).toEqual({ ok: false, rule: 'R130', code: 'objet_hors_liste' });
    // Une mention sans retouche, une retouche sur une photo que la fiche dit brute, une image identique à l'original : refusés.
    expect(await t.certs.record(alex, t.p.id, t.input(1, { mentionOnImage: RETOUCH_MENTION }))).toEqual({ ok: false, rule: 'R10', code: 'mention_sans_retouche' });
    expect(await t.certs.record(alex, t.p.id, t.input(2, { operations: [], localEdits: [{ kind: 'ciel' }], mentionOnImage: RETOUCH_MENTION }))).toEqual({ ok: false, rule: 'R10', code: 'fiche_dit_aucune' });
    expect(await t.certs.record(alex, t.p.id, t.input(1, { operations: [], localEdits: [{ kind: 'ciel' }], mentionOnImage: RETOUCH_MENTION, resultSha256: sha('a') }))).toEqual({ ok: false, rule: 'R10', code: 'empreinte_incoherente' });
    expect(await t.db.all('SELECT id FROM photo_certificates')).toEqual([]);
    const refus = await t.db.all<{ data: string }>("SELECT data FROM journal WHERE type = 'studio.photo.refuse'");
    expect(refus.map((r) => JSON.parse(r.data).code)).toContain('retouche_sans_mention');
  });

  it('[R490] le certificat liste chaque retouche, dit la mention, et la photo part avec elle', async () => {
    const t = await setup();
    const alex = t.as('agent', t.alex.id);
    const r = await t.certs.record(alex, t.p.id, t.input(1, { localEdits: RETOUCHES, mentionOnImage: RETOUCH_MENTION }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ localEdits: 'retouches_declarees', retouchMention: 'Photo retouchée', virtualStaging: false, mention: null, originalKept: true });
    expect(r.value.retouches).toEqual([
      { kind: 'ciel', label: 'Ciel remplacé', detail: 'Ciel remplacé : seul le ciel a changé, le reste de l’image est tel qu’il a été pris' },
      { kind: 'reflets', label: 'Reflets atténués', detail: 'Reflets atténués sur les vitres ou les miroirs' },
      { kind: 'objet_retire', label: 'Objet retiré', detail: 'Objet retiré : une poubelle mobile, qui ne fait pas partie du bien' },
    ]);
    expect(r.value.statement).toContain('Retouches locales déclarées : ciel remplacé, reflets atténués, objet retiré (une poubelle mobile).');
    expect(r.value.statement).toContain('Aucun défaut du bien n’a été effacé ni caché.');
    expect(r.value.statement).not.toMatch(/Aucune retouche locale/);
    expect(await t.certs.certificate(r.value.token)).toEqual(r.value);
    // La même description rangée deux fois : le même certificat ; d'autres retouches sur la même photo : refusé [R17].
    expect(await t.certs.record(alex, t.p.id, t.input(1, { localEdits: RETOUCHES, mentionOnImage: RETOUCH_MENTION }))).toEqual(r);
    expect(await t.certs.record(alex, t.p.id, t.input(1, { localEdits: [{ kind: 'ciel' }], mentionOnImage: RETOUCH_MENTION }))).toEqual({ ok: false, rule: 'R10', code: 'deja_certifiee' });
    // Un aménagement virtuel retouché garde ses deux mentions.
    const v = await t.certs.record(alex, t.p.id, t.input(3, { operations: [], localEdits: [{ kind: 'reflets' }], mentionOnImage: RETOUCH_MENTION }));
    expect(v).toMatchObject({ ok: true, value: { localEdits: 'amenagement_virtuel', mention: 'Aménagement virtuel', retouchMention: 'Photo retouchée' } });
    // Une photo corrigée sans retouche locale reste dite comme avant.
    const plain = await t.certs.record(alex, t.p.id, t.input(4));
    expect(plain).toMatchObject({ ok: true, value: { localEdits: 'aucune', retouches: [], retouchMention: null } });
    const pub = await t.certs.publishable(t.p.id);
    expect(pub.map((x) => [x.ref, x.overlay, x.retouchMention, x.retouches])).toEqual([
      [ref(t.p.id, 1), null, 'Photo retouchée', ['ciel', 'reflets', 'objet_retire']],
      [ref(t.p.id, 3), 'Aménagement virtuel', 'Photo retouchée', ['reflets']],
      [ref(t.p.id, 4), null, null, []],
    ]);
    const ev = await t.db.all<{ data: string }>("SELECT data FROM journal WHERE type = 'studio.photo.certifiee'");
    expect(JSON.parse(ev[0]!.data)).toEqual({ operations: ['exposition'], retouches: ['ciel', 'reflets', 'objet_retire'] });
  });

  it('[R491] Jamais vu : chaque photo exportée porte le filigrane de l’agent et le code de contenu du bien', async () => {
    const t = await setup();
    const alex = t.as('agent', t.alex.id);
    await t.certs.record(alex, t.p.id, t.input(1, { localEdits: RETOUCHES, mentionOnImage: RETOUCH_MENTION }));
    await t.certs.record(alex, t.p.id, t.input(4));
    const a = await t.filigrane.exportPhoto(alex, t.p.id, { ref: ref(t.p.id, 1), width: 4032, height: 3024 });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.value).toMatchObject({ watermarkText: 'Alexandrine Fictive · AIMMO · abcdefgh2345', contentCode: 'abcdefgh2345', mentions: ['Photo retouchée'], link: null, width: 4032, height: 3024 });
    expect(a.value.svg).toContain('Alexandrine Fictive · AIMMO · abcdefgh2345');
    expect(a.value.certificatePath).toMatch(/^\/certificat-photo\/[0-9a-f]{32}$/);
    // Le code est celui du bien, toujours le même : une photo reprise ramène au bien et à son agent (AT05).
    const b = await t.filigrane.exportPhoto(t.as('direction', 'dir-1'), t.p.id, { ref: ref(t.p.id, 4), width: 1080, height: 1350 });
    expect(b).toMatchObject({ ok: true, value: { contentCode: 'abcdefgh2345', mentions: [] } });
    expect(await t.db.all("SELECT kind, ref FROM public_contents WHERE id = 'abcdefgh2345'")).toEqual([{ kind: 'bien', ref: t.p.id }]);
    // Chaque export rangé porte son filigrane : nom de l'agent et code ; ni ville, ni référence du bien [R46].
    const rows = await t.db.all<{ watermark_text: string; content_code: string }>('SELECT watermark_text, content_code FROM photo_exports');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.watermark_text).toBe(`Alexandrine Fictive · AIMMO · ${row.content_code}`);
      expect(row.watermark_text).not.toMatch(/Villebrune|RET-40/);
    }
    expect(a.value.svg).not.toMatch(/Villebrune|RET-40/);
    expect(await t.filigrane.exportsOf(t.p.id, ref(t.p.id, 1))).toEqual([{ watermarkText: 'Alexandrine Fictive · AIMMO · abcdefgh2345', contentCode: 'abcdefgh2345', certificateToken: a.value.certificatePath.split('/').pop() }]);
    // Rien ne s'efface ni ne se réécrit.
    await expect(t.db.run('DELETE FROM photo_exports')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run("UPDATE photo_exports SET watermark_text = 'x · AIMMO · y'")).rejects.toThrow(/rien ne se réécrit/);
  });

  it('[R491] une photo sans certificat, un bien sans agent, des dimensions impossibles ou un autre rôle : pas d’export', async () => {
    const t = await setup();
    const alex = t.as('agent', t.alex.id);
    expect(await t.filigrane.exportPhoto(alex, t.p.id, { ref: ref(t.p.id, 1), width: 4032, height: 3024 })).toEqual({ ok: false, rule: 'R130', code: 'sans_certificat' });
    expect(await t.filigrane.exportPhoto(alex, t.p.id, { ref: 'biens/x/y.jpg', width: 4032, height: 3024 })).toEqual({ ok: false, rule: 'R10', code: 'photo_inconnue' });
    await t.certs.record(alex, t.p.id, t.input(1));
    expect(await t.filigrane.exportPhoto(alex, t.p.id, { ref: ref(t.p.id, 1), width: 50, height: 3024 })).toEqual({ ok: false, rule: 'R10', code: 'dimensions_invalides' });
    expect(await t.filigrane.exportPhoto(alex, t.p.id, { ref: ref(t.p.id, 1), width: 4032.5, height: 3024 })).toEqual({ ok: false, rule: 'R10', code: 'dimensions_invalides' });
    expect(await t.filigrane.exportPhoto(t.as('assistant', 'as-1'), t.p.id, { ref: ref(t.p.id, 1), width: 4032, height: 3024 })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.filigrane.exportPhoto(t.as('agent', t.sam.id), t.p.id, { ref: ref(t.p.id, 1), width: 4032, height: 3024 })).toMatchObject({ ok: false, rule: 'R16' });
    // Un bien sans agent : le filigrane n'aurait personne à qui ramener.
    await t.db.run('UPDATE properties SET agent_id = NULL WHERE id = ?', [t.p.id]);
    expect(await t.filigrane.exportPhoto(t.as('direction', 'dir-1'), t.p.id, { ref: ref(t.p.id, 1), width: 4032, height: 3024 })).toEqual({ ok: false, rule: 'R491', code: 'sans_agent' });
    expect(await t.db.all('SELECT id FROM photo_exports')).toEqual([]);
  });
});
