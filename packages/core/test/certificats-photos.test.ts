import { expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { CertificatsPhotos, checkOperations, describeOperation } from '../src/studio/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const AT = Date.parse('2027-10-06T08:00:00.000Z');
const ref = (p: string, n: number) => `biens/${p}/0000000${n}-0000-4000-8000-000000000000.jpg`;
const orig = (p: string, n: number) => `biens/${p}/originaux/0000000${n}-0000-4000-8000-00000000000a.jpg`;
const sha = (c: string) => c.repeat(64);
const GOOD_OPS = [
  { op: 'exposition', ev: 0.7 },
  { op: 'balance_des_blancs', kelvin: 5200 },
  { op: 'contraste', amount: 12 },
  { op: 'verticales', degrees: -2.5 },
  { op: 'nettete', amount: 30 },
  { op: 'recadrage', x: 0.05, y: 0.1, width: 0.9, height: 0.8 },
];

it('[R130] seules les corrections d’ensemble de la liste fermée passent, une fois chacune, réglages bornés', () => {
  expect(checkOperations(GOOD_OPS)).toMatchObject({ ok: true });
  expect(checkOperations([])).toEqual({ ok: true, value: [] });
  // Retouches locales : par la sorte d'opération ou par une zone.
  for (const op of ['effacement', 'tampon_de_duplication', 'clonage', 'inpainting', 'suppression_objet', 'remplacement_ciel', 'lissage_peau']) {
    expect(checkOperations([{ op }]), op).toMatchObject({ ok: false, code: 'retouche_locale', index: 0 });
  }
  expect(checkOperations([{ op: 'exposition', ev: 1, zone: [0, 0, 10, 10] }])).toMatchObject({ ok: false, code: 'retouche_locale' });
  expect(checkOperations([{ op: 'contraste', amount: 10, masque: 'ref' }])).toMatchObject({ ok: false, code: 'retouche_locale' });
  expect(checkOperations([{ op: 'nettete', amount: 10, pinceau: 3 }])).toMatchObject({ ok: false, code: 'retouche_locale' });
  // Hors de la liste.
  expect(checkOperations([{ op: 'saturation', amount: 10 }])).toMatchObject({ ok: false, code: 'operation_hors_liste' });
  expect(checkOperations([{ op: 'filtre', name: 'vintage' }])).toMatchObject({ ok: false, code: 'operation_hors_liste' });
  // Réglages hors bornes, manquants ou en trop ; deux fois la même.
  expect(checkOperations([{ op: 'exposition', ev: 4 }])).toMatchObject({ ok: false, code: 'reglage_invalide' });
  expect(checkOperations([{ op: 'contraste', amount: 10.5 }])).toMatchObject({ ok: false, code: 'reglage_invalide' });
  expect(checkOperations([{ op: 'exposition' }])).toMatchObject({ ok: false, code: 'reglage_invalide' });
  expect(checkOperations([{ op: 'exposition', ev: 1, gamma: 2 }])).toMatchObject({ ok: false, code: 'reglage_invalide' });
  expect(checkOperations([{ op: 'exposition', ev: Number.NaN }])).toMatchObject({ ok: false, code: 'reglage_invalide' });
  expect(checkOperations([{ op: 'exposition', ev: 1 }, { op: 'exposition', ev: 1 }])).toMatchObject({ ok: false, code: 'operation_en_double', index: 1 });
  // Un recadrage qui sortirait un défaut du cadre : moins de 60 % gardés, ou hors de l'image.
  expect(checkOperations([{ op: 'recadrage', x: 0, y: 0, width: 0.5, height: 1 }])).toMatchObject({ ok: false, code: 'reglage_invalide' });
  expect(checkOperations([{ op: 'recadrage', x: 0.3, y: 0, width: 0.8, height: 1 }])).toMatchObject({ ok: false, code: 'reglage_invalide' });
  expect(checkOperations('exposition')).toMatchObject({ ok: false, code: 'operations_invalides' });
  expect(checkOperations([...GOOD_OPS, { op: 'exposition', ev: 1 }])).toMatchObject({ ok: false, code: 'operations_invalides' });
  expect(describeOperation({ op: 'exposition', ev: 0.7 })).toBe('Exposition : +0,7 IL, sur toute l’image');
  expect(describeOperation({ op: 'verticales', degrees: -2.5 })).toBe('Verticales redressées : −2,5°');
  expect(describeOperation({ op: 'recadrage', x: 0, y: 0, width: 0.9, height: 0.8 })).toBe('Recadrage : 90 % de la largeur et 80 % de la hauteur gardés');
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
  // Le stockage des photos, inventé : seules les références rangées existent ; `down` simule une panne.
  const stored = new Set<string>();
  const storage = { down: false, has: async (r: string) => { if (storage.down) throw new Error('panne'); return stored.has(r); } };
  const certs = new CertificatsPhotos(db, acces, journal, storage, { now, newToken: () => (++t).toString(16).padStart(32, 'c') });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alexandrine', lastName: 'Fictive' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Samuel', lastName: 'Inventé' });
  const p = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'CERT-77', kind: 'home', city: 'Villebrune', priceEur: 210_000, surfaceM2: 72, rooms: 3, status: 'available' });
  const media = [
    { ref: ref(p.id, 1), kind: 'photo', edit: 'lumiere_cadrage' },
    { ref: ref(p.id, 2), kind: 'photo', edit: 'aucune' },
    { ref: ref(p.id, 3), kind: 'photo', edit: 'amenagement_virtuel' },
    { ref: ref(p.id, 4), kind: 'photo', edit: 'lumiere_cadrage' },
  ];
  const sheet = (v: number, m: unknown[]) =>
    db.run("INSERT INTO property_sheets (id, property_id, network_id, version, data, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'agent:a', '2027-10-01')", [
      `s-${v}`,
      p.id,
      network.id,
      v,
      JSON.stringify({ characteristics: { bedrooms: 1, outdoor: [], parkingSpaces: 0 }, energy: null, coownership: null, risks: null, media: m }),
    ]);
  await sheet(1, media);
  for (let n = 1; n <= 4; n += 1) stored.add(ref(p.id, n)).add(orig(p.id, n));
  const as = (role: 'agent' | 'direction' | 'compliance' | 'assistant', userId: string) => ({ role, userId, networkId: network.id }) as never;
  const input = (n: number, over: Record<string, unknown> = {}) => ({
    resultRef: ref(p.id, n),
    resultSha256: sha('b'),
    originalRef: orig(p.id, n),
    originalSha256: sha('a'),
    operations: GOOD_OPS,
    processedOn: 'appareil',
    ...over,
  });
  return { db, journal, certs, network, alex, sam, p, media, sheet, as, input, stored, storage };
}

describeWithSqlite('X02 · photos corrigées honnêtement, avec leur certificat', () => {
  it('[R130] Jamais vu : la photo corrigée reçoit un certificat lisible, qui dit les corrections et que l’original est gardé', async () => {
    const t = await setup();
    const r = await t.certs.record(t.as('agent', t.alex.id), t.p.id, t.input(1));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ originalKept: true, localEdits: 'aucune', virtualStaging: false, mention: null, resultSha256: sha('b'), originalSha256: sha('a'), issuedOn: '2027-10-06' });
    expect(r.value.corrections.map((c) => c.detail.replace(/[\u00a0\u202f]/g, ' '))).toEqual([
      'Exposition : +0,7 IL, sur toute l’image',
      'Balance des blancs : 5 200 K, sur toute l’image',
      'Contraste : +12 sur 100, sur toute l’image',
      'Verticales redressées : −2,5°',
      'Netteté : 30 sur 100, sur toute l’image',
      'Recadrage : 90 % de la largeur et 80 % de la hauteur gardés',
    ]);
    expect(r.value.statement).toMatch(/Aucune retouche locale/);
    expect(r.value.statement).toMatch(/L’original est gardé/);
    expect(r.value.statement).not.toMatch(/\bIA\b|intelligence/i);
    // Le lien ouvre le même certificat, pour n'importe qui.
    expect(r.value.path).toBe(`/certificat-photo/${r.value.token}`);
    expect(await t.certs.certificate(r.value.token)).toEqual(r.value);
    expect(await t.certs.certificate('0'.repeat(32))).toBeNull();
    expect(await t.certs.certificate('../x')).toBeNull();
    // Au journal : les sortes de corrections, rien d'autre.
    const ev = await t.db.all<{ type: string; data: string }>("SELECT type, data FROM journal WHERE type = 'studio.photo.certifiee'");
    expect(ev).toHaveLength(1);
    expect(JSON.parse(ev[0]!.data)).toEqual({ operations: GOOD_OPS.map((o) => o.op), retouches: [] });
  });

  it('[R46] [R13] le certificat ne porte ni adresse, ni bien, ni agent, ni nom', async () => {
    const t = await setup();
    const r = await t.certs.record(t.as('agent', t.alex.id), t.p.id, t.input(1));
    if (!r.ok) throw new Error(r.code);
    const text = JSON.stringify(await t.certs.certificate(r.value.token));
    for (const s of [t.p.id, t.network.id, t.alex.id, 'Villebrune', 'CERT-77', 'Alexandrine', 'Fictive', 'biens/', 'originaux', 'agent:']) expect(text, s).not.toContain(s);
    expect(r.value.token).not.toContain(t.p.id.slice(0, 8));
  });

  it('[R130] une retouche locale ou une opération hors liste est refusée, au journal, et la photo ne peut pas être publiée', async () => {
    const t = await setup();
    const alex = t.as('agent', t.alex.id);
    expect(await t.certs.record(alex, t.p.id, t.input(1, { operations: [{ op: 'effacement', zone: [1, 2, 3, 4] }] }))).toEqual({ ok: false, rule: 'R130', code: 'retouche_locale' });
    expect(await t.certs.record(alex, t.p.id, t.input(1, { operations: [{ op: 'saturation', amount: 20 }] }))).toEqual({ ok: false, rule: 'R130', code: 'operation_hors_liste' });
    expect(await t.certs.record(alex, t.p.id, t.input(1, { processedOn: 'serveur' }))).toEqual({ ok: false, rule: 'R130', code: 'traitement_hors_appareil' });
    expect(await t.certs.checkPublishable(t.p.id, ref(t.p.id, 1))).toEqual({ ok: false, rule: 'R130', code: 'sans_certificat' });
    expect(await t.certs.publishable(t.p.id)).toEqual([]);
    const ev = await t.db.all<{ data: string }>("SELECT data FROM journal WHERE type = 'studio.photo.refuse'");
    expect(ev.map((e) => JSON.parse(e.data))).toEqual([
      { rule: 'R130', code: 'retouche_locale' },
      { rule: 'R130', code: 'operation_hors_liste' },
      { rule: 'R130', code: 'traitement_hors_appareil' },
    ]);
  });

  it('[R130] une photo sans original rangé ne se publie pas', async () => {
    const t = await setup();
    const alex = t.as('agent', t.alex.id);
    for (const over of [
      { originalRef: null },
      { originalRef: ref(t.p.id, 1) },
      { originalRef: `biens/autre-bien/originaux/00000001-0000-4000-8000-00000000000a.jpg` },
      { originalRef: `biens/${t.p.id}/originaux/../00000001.jpg` },
      { originalSha256: 'abc' },
      { originalSha256: undefined },
    ]) {
      expect(await t.certs.record(alex, t.p.id, t.input(1, over)), JSON.stringify(over)).toEqual({ ok: false, rule: 'R130', code: 'sans_original' });
    }
    expect(await t.certs.checkPublishable(t.p.id, ref(t.p.id, 1))).toMatchObject({ ok: false, code: 'sans_certificat' });
    // Avec son original rangé : elle part, avec son certificat.
    const ok = await t.certs.record(alex, t.p.id, t.input(1));
    if (!ok.ok) throw new Error(ok.code);
    expect(await t.certs.checkPublishable(t.p.id, ref(t.p.id, 1))).toEqual({
      ok: true,
      value: { ref: ref(t.p.id, 1), overlay: null, retouchMention: null, retouches: [], certificateToken: ok.value.token, certificatePath: ok.value.path },
    });
    // Une photo qui n'est pas dans la fiche n'est jamais publiable.
    expect(await t.certs.checkPublishable(t.p.id, ref(t.p.id, 9))).toEqual({ ok: false, rule: 'R10', code: 'photo_inconnue' });
  });

  it('[R130] un original absent du stockage ne se certifie pas ; un stockage en panne ferme tout', async () => {
    const t = await setup();
    const alex = t.as('agent', t.alex.id);
    t.stored.delete(orig(t.p.id, 1));
    expect(await t.certs.record(alex, t.p.id, t.input(1))).toEqual({ ok: false, rule: 'R130', code: 'original_absent' });
    t.stored.delete(ref(t.p.id, 4));
    expect(await t.certs.record(alex, t.p.id, t.input(4))).toEqual({ ok: false, rule: 'R10', code: 'photo_absente' });
    t.storage.down = true;
    expect(await t.certs.record(alex, t.p.id, t.input(3, { operations: [] }))).toEqual({ ok: false, rule: 'R130', code: 'stockage_indisponible' });
    t.storage.down = false;
    const ok = await t.certs.record(alex, t.p.id, t.input(3, { operations: [] }));
    expect(ok.ok).toBe(true);
    // La photo 3, aménagée sans jumelle déclarée, ne part pas seule non plus (HX41) [R493].
    expect((await t.certs.publishable(t.p.id)).map((p) => p.ref)).toEqual([]);
    // L'original disparaît du stockage, ou le stockage tombe : la photo ne part plus.
    t.storage.down = true;
    expect(await t.certs.publishable(t.p.id)).toEqual([]);
    expect(await t.certs.checkPublishable(t.p.id, ref(t.p.id, 3))).toEqual({ ok: false, rule: 'R130', code: 'sans_certificat' });
    t.storage.down = false;
    t.stored.delete(orig(t.p.id, 3));
    expect(await t.certs.publishable(t.p.id)).toEqual([]);
    const ev = await t.db.all<{ data: string }>("SELECT data FROM journal WHERE type = 'studio.photo.stockage_indisponible'");
    expect(ev.length).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(ev[0]!.data)).toEqual({ rule: 'R130', error: 'Error' });
  });

  it('[R10] une fiche aux médias illisibles est dite au journal, jamais prise pour une fiche vide', async () => {
    const t = await setup();
    await t.db.run("INSERT INTO property_sheets (id, property_id, network_id, version, data, created_by, created_at) VALUES ('s-9', ?, ?, 9, ?, 'agent:a', '2027-10-02')", [t.p.id, t.network.id, JSON.stringify({ media: 'x' })]);
    expect(await t.certs.record(t.as('agent', t.alex.id), t.p.id, t.input(1))).toEqual({ ok: false, rule: 'R10', code: 'fiche_illisible' });
    expect(await t.certs.publishable(t.p.id)).toEqual([]);
    const ev = await t.db.all<{ data: string }>("SELECT data FROM journal WHERE type = 'studio.photo.fiche_illisible'");
    expect(ev.map((e) => JSON.parse(e.data))).toEqual([{ rule: 'R10', version: 9 }, { rule: 'R10', version: 9 }]);
  });

  it('[R48] un aménagement virtuel garde sa mention, sur le certificat comme à la publication', async () => {
    const t = await setup();
    const r = await t.certs.record(t.as('agent', t.alex.id), t.p.id, t.input(3, { operations: [{ op: 'exposition', ev: 0.3 }] }));
    if (!r.ok) throw new Error(r.code);
    expect(r.value).toMatchObject({ virtualStaging: true, mention: 'Aménagement virtuel', localEdits: 'amenagement_virtuel' });
    expect(r.value.statement).toMatch(/^Aménagement virtuel : cette image n’est pas une photo telle quelle\. Le mobilier ou les travaux montrés sont simulés/);
    expect(r.value.statement).toMatch(/Autres corrections, d’ensemble : exposition\./);
    // Le certificat d'une image aménagée ne dit jamais « que des corrections d'ensemble » ni « rien ajouté ».
    expect(r.value.statement).not.toMatch(/que des corrections d’ensemble|ajouté par endroit|Aucune retouche locale/);
    // Sans sa photo réelle jumelle déclarée (HX41), l'image aménagée ne part pas seule [R493].
    expect(await t.certs.publishable(t.p.id)).toEqual([]);
    // La fiche ne dit plus « aménagement virtuel » : la mention reste sur le certificat, par prudence.
    await t.sheet(2, t.media.map((m) => ({ ...m, edit: m.edit === 'amenagement_virtuel' ? 'lumiere_cadrage' : m.edit })));
    expect((await t.certs.certificate(r.value.token))!.mention).toBe('Aménagement virtuel');
  });

  it('[R48] [R130] une photo aménagée sans autre correction se certifie ; une photo certifiée sans aménagement que la fiche dit aménagée ne part plus', async () => {
    const t = await setup();
    const alex = t.as('agent', t.alex.id);
    // L'image aménagée diffère forcément de l'original : même empreinte refusée, empreinte différente admise.
    expect(await t.certs.record(alex, t.p.id, t.input(3, { operations: [], resultSha256: sha('a') }))).toEqual({ ok: false, rule: 'R10', code: 'empreinte_incoherente' });
    const staged = await t.certs.record(alex, t.p.id, t.input(3, { operations: [] }));
    expect(staged).toMatchObject({ ok: true, value: { corrections: [], localEdits: 'amenagement_virtuel', statement: expect.stringMatching(/Aucune autre correction\./) } });
    // La photo 1, certifiée sans aménagement, passe en aménagement virtuel dans la fiche : elle ne part plus.
    const plain = await t.certs.record(alex, t.p.id, t.input(1));
    if (!plain.ok) throw new Error(plain.code);
    expect(await t.certs.checkPublishable(t.p.id, ref(t.p.id, 1))).toMatchObject({ ok: true });
    await t.sheet(2, t.media.map((m, i) => (i === 0 ? { ...m, edit: 'amenagement_virtuel' } : m)));
    expect(await t.certs.checkPublishable(t.p.id, ref(t.p.id, 1))).toEqual({ ok: false, rule: 'R130', code: 'sans_certificat' });
    // La photo 3, aménagée sans jumelle déclarée, ne part pas seule non plus (HX41) [R493].
    expect((await t.certs.publishable(t.p.id)).map((p) => p.ref)).toEqual([]);
  });

  it('[R10] les empreintes et la fiche doivent dire la même chose que la description', async () => {
    const t = await setup();
    const alex = t.as('agent', t.alex.id);
    // Aucune correction : le résultat est l'original, à l'octet près ; des corrections : il en diffère.
    expect(await t.certs.record(alex, t.p.id, t.input(4, { operations: [] }))).toEqual({ ok: false, rule: 'R10', code: 'empreinte_incoherente' });
    expect(await t.certs.record(alex, t.p.id, t.input(4, { resultSha256: sha('a') }))).toEqual({ ok: false, rule: 'R10', code: 'empreinte_incoherente' });
    expect(await t.certs.record(alex, t.p.id, t.input(4, { resultSha256: 'B'.repeat(64) }))).toEqual({ ok: false, rule: 'R10', code: 'empreinte_invalide' });
    // La fiche dit « aucune retouche » : des corrections la contrediraient.
    expect(await t.certs.record(alex, t.p.id, t.input(2))).toEqual({ ok: false, rule: 'R10', code: 'fiche_dit_aucune' });
    const raw = await t.certs.record(alex, t.p.id, t.input(2, { operations: [], resultSha256: sha('a') }));
    expect(raw).toMatchObject({ ok: true, value: { corrections: [], statement: expect.stringMatching(/^Cette photo n’a reçu aucune correction\./) } });
    // Une référence qui n'est pas une photo de la fiche.
    expect(await t.certs.record(alex, t.p.id, t.input(9))).toEqual({ ok: false, rule: 'R10', code: 'photo_inconnue' });
  });

  it('[R17] un certificat rangé ne change plus : le même geste le relit, un autre est refusé', async () => {
    const t = await setup();
    const alex = t.as('agent', t.alex.id);
    const a = await t.certs.record(alex, t.p.id, t.input(1));
    const b = await t.certs.record(alex, t.p.id, t.input(1));
    expect(b).toEqual(a);
    expect(await t.certs.record(alex, t.p.id, t.input(1, { operations: [{ op: 'contraste', amount: 40 }] }))).toEqual({ ok: false, rule: 'R10', code: 'deja_certifiee' });
    expect(await t.certs.record(alex, t.p.id, t.input(1, { resultSha256: sha('c') }))).toEqual({ ok: false, rule: 'R10', code: 'deja_certifiee' });
    expect(await t.db.all('SELECT id FROM photo_certificates')).toHaveLength(1);
    await expect(t.db.run('DELETE FROM photo_certificates')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run("UPDATE photo_certificates SET operations = '[]'")).rejects.toThrow(/ne change plus/);
    await expect(
      t.db.run(
        "INSERT INTO photo_certificates (id, token, property_id, network_id, result_ref, result_sha256, original_ref, original_sha256, operations, virtual_staging, processed_on, recorded_by, recorded_at) VALUES ('x', ?, ?, ?, 'r', ?, 'o', ?, '[]', 0, 'serveur', 'a', 'b')",
        ['d'.repeat(32), t.p.id, t.network.id, sha('b'), sha('a')],
      ),
    ).rejects.toThrow();
  });

  it('[R16] seuls l’agent du bien et la direction rangent une description ; les autres sont refusés au journal', async () => {
    const t = await setup();
    expect(await t.certs.record(t.as('agent', t.sam.id), t.p.id, t.input(1))).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.certs.record(t.as('compliance', 'c1'), t.p.id, t.input(1))).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.certs.record(t.as('assistant', 'x1'), t.p.id, t.input(1))).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.certs.record(t.as('direction', 'd1'), t.p.id, t.input(1))).toMatchObject({ ok: true });
    const refused = await t.db.all<{ data: string }>("SELECT data FROM journal WHERE type = 'acces.refuse'");
    expect(refused.length).toBeGreaterThanOrEqual(3);
    expect(await t.db.all('SELECT id FROM photo_certificates')).toHaveLength(1);
  });
});
