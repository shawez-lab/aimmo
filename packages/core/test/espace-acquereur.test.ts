import { expect, it } from 'vitest';
import { MemoryJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { CHAMPS_BIEN_PROPOSE, EspaceAcquereur, NON_COMMUNIQUE, type ClientViewer, type GestesAcquereur, type GesteResult, type ProposedProperty, type SourcesAcquereur } from '../src/espaces/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const NOW = new Date('2027-06-08T08:00:00.000Z');
// Vendeurs inventés.
const VENDEUSE = { personId: 'p-vendeuse', firstName: 'Héloïse', lastName: 'Vendinventée', emails: ['heloise.vendinventee@example.test'], phones: ['0655443322'] };

function proposed(id: string, over: Partial<ProposedProperty> = {}): ProposedProperty {
  return { propertyId: id, reference: `B-${id}`, city: 'Dijon', kind: 'appartement', surfaceM2: 64, rooms: 3, priceEur: 210_000, energyClass: 'C', publishedAt: '2027-05-20T08:00:00.000Z', proposedAt: '2027-06-01T08:00:00.000Z', diffusable: true, sellers: [VENDEUSE], ...over };
}

async function setup(over: Partial<{ proposed: ProposedProperty[]; investor: boolean; hypotheses: string[] }> = {}) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  await db.run("INSERT INTO networks (id, name, created_at) VALUES ('n1', 'Réseau test', '2027-01-01T00:00:00.000Z')");
  await db.run("INSERT INTO persons (id, network_id, created_at, updated_at) VALUES ('p-acq', 'n1', '2027-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z')");
  const journal = new MemoryJournalStore();
  const calls: string[] = [];
  const sources: SourcesAcquereur = {
    proposedOf: async (_n, personId) => (personId === 'p-acq' ? (over.proposed ?? [proposed('b1'), proposed('b2', { diffusable: false }), proposed('b3', { priceEur: null, publishedAt: '2027-05-25T08:00:00.000Z' })]) : []),
    visitsOf: async () => [{ id: 'v1', propertyId: 'b1', at: '2027-06-10T09:00:00.000Z', state: 'prevue' }],
    offersOf: async () => [{ id: 'o1', propertyId: 'b1', receivedAt: '2027-06-06T11:00:00.000Z', amountEur: 205_000, state: 'transmise au vendeur', stateAt: '2027-06-06T11:05:00.000Z' }],
    filesOf: async (_n, personId) => (personId === 'p-acq' ? [{ fileId: 'f1', propertyId: 'b1', pieces: [{ kind: 'offre de prêt', state: 'manquante', at: '2027-06-07T08:00:00.000Z' }], loan: { state: 'demandé', at: '2027-06-07T08:00:00.000Z' }, deed: { date: '2027-09-15', holds: ['offre de prêt'], computedAt: '2027-06-08T06:00:00.000Z' } }] : []),
    investorOf: async (_n, _p, propertyId) => ({ propertyId, grossYieldBp: 512, netYieldBp: 398, hypotheses: over.hypotheses ?? ['loyer de marché de la commune, Carte des loyers 2026', 'vacance d’un mois par an'], constraints: ['classe énergie C : location permise'], computedAt: '2027-06-02T08:00:00.000Z' }),
    tenantApplicationsOf: async () => [{ rentalId: 'r1', reference: 'L-9', city: 'Dijon', receivedAt: '2027-06-03T08:00:00.000Z', complete: true, state: 'présenté au propriétaire', stateAt: '2027-06-04T08:00:00.000Z' }],
    alertsRequested: async () => false,
  };
  const answer: GesteResult = { ok: true, value: { id: 'x' } };
  const gestes: GestesAcquereur = {
    bookVisit: async (c, propertyId) => (calls.push(`visite:${c.personId}:${propertyId}`), answer),
    writeOffer: async (c, propertyId) => (calls.push(`offre:${c.personId}:${propertyId}`), { ok: false, rule: 'R55', code: 'sans_financement' }),
    addFinancingPiece: async (c, fileId) => (calls.push(`piece:${c.personId}:${fileId}`), answer),
    requestAlerts: async (c) => (calls.push(`alertes:${c.personId}`), answer),
  };
  let n = 0;
  const espace = new EspaceAcquereur(db, sources, gestes, journal, { now: () => NOW, newId: () => `id-${(n += 1)}` });
  return { db, journal, calls, espace };
}

const viewer = (sides: ClientViewer['sides'] = ['acquereur'], personId = 'p-acq'): ClientViewer => ({ kind: 'client', networkId: 'n1', personId, sessionId: 's-1', sides });

describeWithSqlite('EC04 · espace de l’acquéreur', () => {
  it('[R161] [R42] seuls les biens proposés encore diffusables, par les seuls champs de l’annonce, rien du vendeur', async () => {
    const t = await setup();
    const r = await t.espace.vue(viewer());
    if (!r.ok) throw new Error('vue');
    expect(r.value.properties.map((p) => p.reference)).toEqual(['B-b1', 'B-b3']);
    expect(Object.keys(r.value.properties[0]!).sort()).toEqual([...CHAMPS_BIEN_PROPOSE].sort());
    expect(r.value.properties[1]!.price).toEqual({ value: null, label: NON_COMMUNIQUE });
    expect(r.value.properties[0]!.price).toEqual({ value: 210_000, source: 'annonce publiée', at: '2027-05-20T08:00:00.000Z' });
    const text = JSON.stringify(r.value);
    for (const secret of ['Héloïse', 'Vendinventée', 'example.test', '0655', 'p-vendeuse', 'sellers', 'B-b2']) expect(text).not.toContain(secret);
    // Sa visite, son offre, son dossier jusqu'à l'acte, chacun avec sa source.
    expect(r.value.visits[0]!.at).toEqual({ value: '2027-06-10T09:00:00.000Z', source: 'agenda du bien', at: '2027-06-10T09:00:00.000Z' });
    expect(r.value.offers[0]!.amount.value).toBe(205_000);
    expect(r.value.files[0]!.deedDate).toEqual({ value: '2027-09-15', source: 'échéancier du dossier', at: '2027-06-08T06:00:00.000Z' });
    expect(r.value.files[0]!.pieces).toEqual([{ kind: 'offre de prêt', state: { value: 'manquante', source: 'dossier de vente', at: '2027-06-07T08:00:00.000Z' } }]);
    // Un acquéreur seul ne voit pas les chiffres d'investisseur ni de candidature.
    expect(r.value.properties[0]!.investor).toBeNull();
    expect(r.value.rentals).toEqual([]);
  });

  it('[R161] un texte qui cite le vendeur est retenu', async () => {
    const t = await setup({ proposed: [proposed('b1', { kind: 'maison de Mme Vendinventée' })] });
    const r = await t.espace.vue(viewer());
    expect(r.ok && JSON.stringify(r.value)).not.toMatch(/Vendinvent/);
  });

  it('[R49] un favori ne déclenche aucun envoi ; seul un bien proposé peut l’être ; il se retire sans rien effacer', async () => {
    const t = await setup();
    expect(await t.espace.addFavorite(viewer(), 'b1')).toEqual({ ok: true, value: { favorite: true } });
    expect(await t.espace.addFavorite(viewer(), 'b1')).toEqual({ ok: true, value: { favorite: true } });
    expect(await t.espace.addFavorite(viewer(), 'b2')).toEqual({ ok: false, rule: 'R161', code: 'not_proposed' });
    expect(await t.espace.addFavorite(viewer(), 'b-inconnu')).toEqual({ ok: false, rule: 'R161', code: 'not_proposed' });
    expect(t.calls).toEqual([]);
    expect(await t.db.all('SELECT 1 FROM messages')).toHaveLength(0);
    const r = await t.espace.vue(viewer());
    expect(r.ok && r.value.properties.map((p) => [p.reference, p.favorite])).toEqual([['B-b1', true], ['B-b3', false]]);
    await t.espace.removeFavorite(viewer(), 'b1');
    const after = await t.espace.vue(viewer());
    expect(after.ok && after.value.properties[0]!.favorite).toBe(false);
    expect(await t.db.all('SELECT id FROM client_space_favorites')).toHaveLength(1);
    await expect(t.db.run('DELETE FROM client_space_favorites')).rejects.toThrow(/rien ne s'efface/);
  });

  it('[R165] [R49] [R03] chaque geste passe par le module qui le tient, sa réponse rendue telle quelle', async () => {
    const t = await setup();
    expect(await t.espace.bookVisit(viewer(), 'b1', { slot: '2027-06-12T09:00' })).toEqual({ ok: true, value: { id: 'x' } });
    expect(await t.espace.writeOffer(viewer(), 'b1', { amountEur: 200_000 })).toEqual({ ok: false, rule: 'R55', code: 'sans_financement' });
    expect(await t.espace.addFinancingPiece(viewer(), 'f1', { kind: 'offre de prêt' })).toEqual({ ok: true, value: { id: 'x' } });
    expect(await t.espace.requestAlerts(viewer(), { consentProof: 'demandé depuis l’espace' })).toEqual({ ok: true, value: { id: 'x' } });
    expect(t.calls).toEqual(['visite:p-acq:b1', 'offre:p-acq:b1', 'piece:p-acq:f1', 'alertes:p-acq']);
    // Un bien non proposé, non diffusable, ou le dossier d'un autre : le module n'est même pas appelé.
    expect(await t.espace.bookVisit(viewer(), 'b2', {})).toEqual({ ok: false, rule: 'R165', code: 'not_proposed' });
    expect(await t.espace.writeOffer(viewer(), 'b-inconnu', {})).toEqual({ ok: false, rule: 'R165', code: 'not_proposed' });
    expect(await t.espace.addFinancingPiece(viewer(), 'f-autre', {})).toEqual({ ok: false, rule: 'R161', code: 'not_party' });
    expect(await t.espace.writeOffer(viewer(['candidat_locataire']), 'b1', {})).toEqual({ ok: false, rule: 'R161', code: 'side' });
    expect(await t.espace.bookVisit(viewer(['vendeur']), 'b1', {})).toEqual({ ok: false, rule: 'R161', code: 'side' });
    expect(t.calls).toHaveLength(4);
    // Le journal porte le geste et la réponse du module, en codes [R13].
    const gestes = (await t.journal.all()).filter((e) => e.type === 'espaces.geste').map((e) => e.data);
    expect(gestes[1]).toEqual({ rule: 'R165', side: 'acquereur', kind: 'offre', property: 'b1', status: 'refuse', moduleRule: 'R55', moduleCode: 'sans_financement' });
    expect(JSON.stringify(gestes)).not.toContain('demandé depuis');
  });

  it('[R163] l’investisseur voit le rendement avec ses hypothèses ; une tournure de promesse est retenue', async () => {
    const t = await setup({ hypotheses: ['loyer de marché de la commune', 'rendement garanti sur 10 ans', 'sans risque'] });
    const r = await t.espace.vue(viewer(['investisseur']));
    if (!r.ok) throw new Error('vue');
    const inv = r.value.properties[0]!.investor!;
    expect(inv.grossYield).toEqual({ value: 512, source: 'calcul de rendement', at: '2027-06-02T08:00:00.000Z' });
    expect(inv.hypotheses).toEqual(['loyer de marché de la commune', NON_COMMUNIQUE, NON_COMMUNIQUE]);
    expect(inv.constraints).toEqual(['classe énergie C : location permise']);
  });

  it('le candidat locataire voit sa candidature et son état, sans rang', async () => {
    const t = await setup();
    const r = await t.espace.vue(viewer(['candidat_locataire']));
    if (!r.ok) throw new Error('vue');
    expect(r.value.rentals).toEqual([
      {
        reference: 'L-9',
        city: 'Dijon',
        receivedAt: { value: '2027-06-03T08:00:00.000Z', source: 'dossier de candidature', at: '2027-06-03T08:00:00.000Z' },
        complete: { value: true, source: 'dossier de candidature', at: '2027-06-03T08:00:00.000Z' },
        state: { value: 'présenté au propriétaire', source: 'dossier de candidature', at: '2027-06-04T08:00:00.000Z' },
      },
    ]);
    expect(await t.espace.vue(viewer(['vendeur']))).toEqual({ ok: false, rule: 'R161', code: 'side' });
  });
});
