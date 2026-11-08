import { expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { AmenagementsVirtuels, FiligranePhotos, checkStagingChanges, describeStagingChange, galleryProblems, orderGallery } from '../src/medias/index.ts';
import { CertificatsPhotos } from '../src/studio/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const AT = Date.parse('2027-11-03T08:00:00.000Z');
const ref = (p: string, n: number) => `biens/${p}/0000000${n}-0000-4000-8000-000000000000.jpg`;
const orig = (p: string, n: number) => `biens/${p}/originaux/0000000${n}-0000-4000-8000-00000000000a.jpg`;
const sha = (c: string) => c.repeat(64);
const CHANGES = [{ kind: 'meubler', style: 'scandinave' }, { kind: 'sols', material: 'beton_cire' }, { kind: 'transformer_objet', object: 'cheminee' }];

it('[R492] ce qui a changé se dit en liste fermée, une fois chaque sorte, avec son option', () => {
  expect(checkStagingChanges(CHANGES)).toEqual({ ok: true, value: CHANGES });
  expect(checkStagingChanges([{ kind: 'desencombrer' }])).toEqual({ ok: true, value: [{ kind: 'desencombrer' }] });
  expect(checkStagingChanges([])).toMatchObject({ ok: false, code: 'changements_invalides' });
  expect(checkStagingChanges([{ kind: 'agrandir_piece' }])).toMatchObject({ ok: false, code: 'changement_hors_liste' });
  expect(checkStagingChanges([{ kind: 'changer_vue' }])).toMatchObject({ ok: false, code: 'changement_hors_liste' });
  expect(checkStagingChanges([{ kind: 'meubler', style: 'baroque' }])).toMatchObject({ ok: false, code: 'option_hors_liste' });
  expect(checkStagingChanges([{ kind: 'transformer_objet', object: 'fenetre' }])).toMatchObject({ ok: false, code: 'option_hors_liste' });
  expect(checkStagingChanges([{ kind: 'meubler' }])).toMatchObject({ ok: false, code: 'changements_invalides' });
  expect(checkStagingChanges([{ kind: 'desencombrer', zone: 'x' }])).toMatchObject({ ok: false, code: 'changements_invalides' });
  expect(checkStagingChanges([{ kind: 'murs', finish: 'peinture' }, { kind: 'murs', finish: 'enduit' }])).toMatchObject({ ok: false, code: 'changement_en_double', index: 1 });
  expect(describeStagingChange({ kind: 'meubler', style: 'scandinave' })).toBe('Pièce meublée virtuellement, style scandinave : ce mobilier n’est pas dans le bien');
  expect(describeStagingChange({ kind: 'sols', material: 'beton_cire' })).toBe('Sols montrés en béton ciré : travaux simulés, non faits');
  expect(describeStagingChange({ kind: 'transformer_objet', object: 'meubles_de_cuisine' })).toBe('Meubles de cuisine transformés virtuellement : travaux simulés, non faits');
});

it('[R493] une image aménagée part juste après sa jumelle réelle, jamais en couverture ni seule', () => {
  const real = (r: string) => ({ ref: r, overlay: null });
  const staged = (r: string) => ({ ref: r, overlay: 'Aménagement virtuel' as const });
  const twins = new Map([['s1', 'r2'], ['s2', 'r2'], ['s3', 'absente']]);
  const out = orderGallery([staged('s1'), real('r1'), staged('s3'), real('r2'), staged('s2'), staged('s4')], twins);
  expect(out.photos.map((p) => p.ref)).toEqual(['r1', 'r2', 's1', 's2']);
  expect(out.removed).toEqual([{ ref: 's3', code: 'sans_jumelle' }, { ref: 's4', code: 'sans_declaration' }]);
  expect(galleryProblems(out.photos, twins)).toEqual([]);
  // Un ordre fautif est dit : couverture aménagée, jumelle éloignée ou absente, aucune déclaration.
  expect(galleryProblems([staged('s1'), real('r2')], twins)).toEqual([{ ref: 's1', code: 'couverture_amenagee' }, { ref: 's1', code: 'jumelle_absente_ou_eloignee' }]);
  expect(galleryProblems([real('r2'), real('r1'), staged('s1')], twins)).toEqual([{ ref: 's1', code: 'jumelle_absente_ou_eloignee' }]);
  expect(galleryProblems([real('r1'), staged('s4')], twins)).toEqual([{ ref: 's4', code: 'sans_declaration' }]);
  // Seulement des images aménagées : rien ne part.
  expect(orderGallery([staged('s1'), staged('s2')], twins).photos).toEqual([]);
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
  const certs = new CertificatsPhotos(db, acces, journal, { has: async (r: string) => stored.has(r) }, { now, newToken: () => (++t).toString(16).padStart(32, 'e') });
  const amenagements = new AmenagementsVirtuels(db, acces, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alexandrine', lastName: 'Fictive' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Samuel', lastName: 'Inventé' });
  const p = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'AMV-41', kind: 'home', city: 'Villebrune', priceEur: 190_000, surfaceM2: 64, rooms: 3, status: 'available' });
  // Photo 1 : le séjour réel ; photo 2 : le même cliché aménagé ; photo 3 : la chambre réelle ; photo 4 : une autre
  // image aménagée, d'un autre cliché.
  const media = [
    { ref: ref(p.id, 2), kind: 'photo', edit: 'amenagement_virtuel' },
    { ref: ref(p.id, 1), kind: 'photo', edit: 'lumiere_cadrage' },
    { ref: ref(p.id, 3), kind: 'photo', edit: 'lumiere_cadrage' },
    { ref: ref(p.id, 4), kind: 'photo', edit: 'amenagement_virtuel' },
  ];
  await db.run("INSERT INTO property_sheets (id, property_id, network_id, version, data, created_by, created_at) VALUES ('s-1', ?, ?, 1, ?, 'agent:a', '2027-10-01')", [
    p.id,
    network.id,
    JSON.stringify({ characteristics: { bedrooms: 1, outdoor: [], parkingSpaces: 0 }, energy: null, coownership: null, risks: null, media }),
  ]);
  for (let n = 1; n <= 4; n += 1) stored.add(ref(p.id, n)).add(orig(p.id, n));
  const as = (role: 'agent' | 'direction' | 'assistant', userId: string) => ({ role, userId, networkId: network.id }) as never;
  const alexV = as('agent', alex.id);
  // Le séjour : le même original (photo 1), corrigé d'un côté, aménagé de l'autre.
  const real = await certs.record(alexV, p.id, { resultRef: ref(p.id, 1), resultSha256: sha('b'), originalRef: orig(p.id, 1), originalSha256: sha('a'), operations: [{ op: 'exposition', ev: 0.4 }], processedOn: 'appareil' });
  const staged = await certs.record(alexV, p.id, { resultRef: ref(p.id, 2), resultSha256: sha('c'), originalRef: orig(p.id, 2), originalSha256: sha('a'), operations: [], processedOn: 'appareil' });
  const room = await certs.record(alexV, p.id, { resultRef: ref(p.id, 3), resultSha256: sha('e'), originalRef: orig(p.id, 3), originalSha256: sha('d'), operations: [{ op: 'contraste', amount: 5 }], processedOn: 'appareil' });
  const other = await certs.record(alexV, p.id, { resultRef: ref(p.id, 4), resultSha256: sha('f'), originalRef: orig(p.id, 4), originalSha256: sha('9'), operations: [], processedOn: 'appareil' });
  if (!real.ok || !staged.ok || !room.ok || !other.ok) throw new Error('certificats');
  const filigrane = new FiligranePhotos(db, acces, journal, certs, { now });
  return { db, certs, amenagements, filigrane, network, alex, sam, p, as, alexV, staged: staged.value, other: other.value };
}

describeWithSqlite('HX41 · aménagement virtuel des pièces', () => {
  it('[R48] [R492] [R493] Jamais vu : l’image aménagée part avec sa mention, juste après la photo réelle du même cliché, et son certificat dit ce qui a changé', async () => {
    const t = await setup();
    // Sans déclaration : aucune image aménagée ne part, la couverture est une photo réelle.
    expect((await t.certs.publishable(t.p.id)).map((x) => x.ref)).toEqual([ref(t.p.id, 1), ref(t.p.id, 3)]);
    const d = await t.amenagements.declare(t.alexV, t.p.id, { stagedRef: ref(t.p.id, 2), realRef: ref(t.p.id, 1), changes: CHANGES });
    expect(d).toEqual({
      ok: true,
      value: {
        stagedRef: ref(t.p.id, 2),
        realRef: ref(t.p.id, 1),
        changes: [
          { kind: 'meubler', label: 'Pièce meublée', detail: 'Pièce meublée virtuellement, style scandinave : ce mobilier n’est pas dans le bien' },
          { kind: 'sols', label: 'Sols refaits', detail: 'Sols montrés en béton ciré : travaux simulés, non faits' },
          { kind: 'transformer_objet', label: 'Objet transformé', detail: 'Cheminée transformée virtuellement : travaux simulés, non faits' },
        ],
      },
    });
    // L'image aménagée part, avec sa mention, juste après sa jumelle ; la fiche la mettait en tête.
    const pub = await t.certs.publishable(t.p.id);
    expect(pub.map((x) => [x.ref, x.overlay])).toEqual([
      [ref(t.p.id, 1), null],
      [ref(t.p.id, 2), 'Aménagement virtuel'],
      [ref(t.p.id, 3), null],
    ]);
    expect(galleryProblems(pub, await t.amenagements.twins(t.p.id))).toEqual([]);
    // Le certificat public dit ce qui a changé, ligne par ligne, et que la photo réelle est publiée à côté.
    const cert = await t.certs.certificate(t.staged.token);
    expect(cert?.mention).toBe('Aménagement virtuel');
    expect(cert?.stagingChanges?.map((c) => c.detail)).toEqual(d.ok ? d.value.changes.map((c) => c.detail) : []);
    expect(cert?.statement).toContain('Ce qui a changé : pièce meublée virtuellement, style scandinave : ce mobilier n’est pas dans le bien ; sols montrés en béton ciré');
    expect(cert?.statement).toContain('La photo réelle du même cliché est publiée juste avant elle.');
    // Une déclaration ne change plus ; la même est relue.
    expect(await t.amenagements.declare(t.alexV, t.p.id, { stagedRef: ref(t.p.id, 2), realRef: ref(t.p.id, 1), changes: CHANGES })).toEqual(d);
    expect(await t.amenagements.declare(t.alexV, t.p.id, { stagedRef: ref(t.p.id, 2), realRef: ref(t.p.id, 1), changes: [{ kind: 'desencombrer' }] })).toEqual({ ok: false, rule: 'R10', code: 'deja_declaree' });
    await expect(t.db.run('DELETE FROM virtual_stagings')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run("UPDATE virtual_stagings SET changes = '[]'")).rejects.toThrow(/rien ne se réécrit/);
  });

  it('[R493] une image transformée ne peut pas être la seule photo d’une pièce : la jumelle doit être réelle et du même cliché', async () => {
    const t = await setup();
    // Une autre pièce (autre original) : refusé.
    expect(await t.amenagements.declare(t.alexV, t.p.id, { stagedRef: ref(t.p.id, 2), realRef: ref(t.p.id, 3), changes: CHANGES })).toEqual({ ok: false, rule: 'R493', code: 'pas_le_meme_cliche' });
    // Une autre image aménagée comme « jumelle » : refusé.
    expect(await t.amenagements.declare(t.alexV, t.p.id, { stagedRef: ref(t.p.id, 2), realRef: ref(t.p.id, 4), changes: CHANGES })).toEqual({ ok: false, rule: 'R493', code: 'jumelle_non_reelle' });
    // Une photo réelle déclarée comme aménagée : elle ne porte pas la mention, refusé [R48].
    expect(await t.amenagements.declare(t.alexV, t.p.id, { stagedRef: ref(t.p.id, 3), realRef: ref(t.p.id, 1), changes: CHANGES })).toEqual({ ok: false, rule: 'R48', code: 'sans_mention' });
    expect(await t.amenagements.declare(t.alexV, t.p.id, { stagedRef: ref(t.p.id, 2), realRef: ref(t.p.id, 2), changes: CHANGES })).toEqual({ ok: false, rule: 'R10', code: 'photo_inconnue' });
    expect(await t.amenagements.declare(t.alexV, t.p.id, { stagedRef: ref(t.p.id, 2), realRef: ref(t.p.id, 1), changes: [{ kind: 'changer_vue' }] })).toEqual({ ok: false, rule: 'R492', code: 'changement_hors_liste' });
    expect(await t.db.all('SELECT id FROM virtual_stagings')).toEqual([]);
    // Ni l'image 2 ni l'image 4 ne partent.
    expect((await t.certs.publishable(t.p.id)).map((x) => x.ref)).toEqual([ref(t.p.id, 1), ref(t.p.id, 3)]);
  });

  it('[R493] la jumelle retirée de la fiche, l’image aménagée ne part plus ; [R16] seuls l’agent du bien et la direction déclarent', async () => {
    const t = await setup();
    expect(await t.amenagements.declare(t.as('agent', t.sam.id), t.p.id, { stagedRef: ref(t.p.id, 2), realRef: ref(t.p.id, 1), changes: CHANGES })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.amenagements.declare(t.as('assistant', 'as-1'), t.p.id, { stagedRef: ref(t.p.id, 2), realRef: ref(t.p.id, 1), changes: CHANGES })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.amenagements.declare(t.as('direction', 'dir-1'), t.p.id, { stagedRef: ref(t.p.id, 2), realRef: ref(t.p.id, 1), changes: CHANGES })).toMatchObject({ ok: true });
    expect((await t.certs.publishable(t.p.id)).map((x) => x.ref)).toEqual([ref(t.p.id, 1), ref(t.p.id, 2), ref(t.p.id, 3)]);
    // La fiche suivante n'a plus la photo réelle : l'image aménagée ne part plus seule.
    await t.db.run("INSERT INTO property_sheets (id, property_id, network_id, version, data, created_by, created_at) VALUES ('s-2', ?, ?, 2, ?, 'agent:a', '2027-10-02')", [
      t.p.id,
      t.network.id,
      JSON.stringify({ characteristics: { bedrooms: 1, outdoor: [], parkingSpaces: 0 }, energy: null, coownership: null, risks: null, media: [{ ref: ref(t.p.id, 2), kind: 'photo', edit: 'amenagement_virtuel' }, { ref: ref(t.p.id, 3), kind: 'photo', edit: 'lumiere_cadrage' }] }),
    ]);
    expect((await t.certs.publishable(t.p.id)).map((x) => x.ref)).toEqual([ref(t.p.id, 3)]);
    expect(await t.certs.checkPublishable(t.p.id, ref(t.p.id, 2))).toEqual({ ok: false, rule: 'R130', code: 'sans_certificat' });
  });

  it('[R493] une image aménagée ne s’exporte jamais seule : sa jumelle réelle sort dans le même geste, avant elle', async () => {
    const t = await setup();
    const size = { width: 4032, height: 3024 };
    // Sans jumelle déclarée : pas d'export.
    expect(await t.filigrane.exportPhoto(t.alexV, t.p.id, { ref: ref(t.p.id, 2), ...size })).toEqual({ ok: false, rule: 'R130', code: 'sans_certificat' });
    await t.amenagements.declare(t.alexV, t.p.id, { stagedRef: ref(t.p.id, 2), realRef: ref(t.p.id, 1), changes: CHANGES });
    const e = await t.filigrane.exportPhoto(t.alexV, t.p.id, { ref: ref(t.p.id, 2), ...size });
    expect(e.ok).toBe(true);
    if (!e.ok) return;
    expect(e.value).toMatchObject({ ref: ref(t.p.id, 2), mentions: ['Aménagement virtuel'], twinExport: { ref: ref(t.p.id, 1), mentions: [] } });
    // Les deux exports sont rangés, la jumelle d'abord, chacun avec son filigrane.
    const rows = await t.db.all<{ result_ref: string; watermark_text: string }>('SELECT result_ref, watermark_text FROM photo_exports ORDER BY rowid');
    expect(rows.map((r) => r.result_ref)).toEqual([ref(t.p.id, 1), ref(t.p.id, 2)]);
    expect(rows.every((r) => r.watermark_text.startsWith('Alexandrine Fictive · AIMMO · '))).toBe(true);
    // Une photo réelle s'exporte seule.
    expect(await t.filigrane.exportPhoto(t.alexV, t.p.id, { ref: ref(t.p.id, 3), ...size })).toMatchObject({ ok: true, value: { twinExport: null } });
  });
});
