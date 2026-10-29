import { expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, LETTER_CSS, LettresQuartier, Mandats, RegistreMandats, SqlJournalStore, applyMigrations, checkLetterText, distanceM, fromSyncSqlite, letterFallback, type Geocoder, type LetterDrafter, type SqlDatabase } from '../src/index.ts';
import { htmlProblems, screenCssProblems } from '../src/design/audit.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Un quartier inventé de Dijon : positions de test, aucune vraie personne.
const NOW = Date.parse('2027-10-12T08:00:00.000Z');
const CENTER = { lat: 47.322, lon: 5.0415 };
const PLACES: Record<string, { lat: number; lon: number; label?: string; score?: number; postalCode?: string; town?: string }> = {
  // La Base adresse nationale rend l'adresse la plus proche, sans le nom glissé, ou une commune approximative.
  '10 rue des Tilleuls Essai Jean Dupont 21000 Dijon': { lat: 47.3222, lon: 5.0415, label: '10 rue des Tilleuls Essai 21000 Dijon' },
  '10 rue des Tilleuls Essai 21000 Dupont': { lat: 47.3222, lon: 5.0415, label: '10 rue des Tilleuls Essai 21000 Dijon', town: 'Dijon' },
  '1 place Ailleurs, 21200 Beaune': { lat: 47.02, lon: 4.84, postalCode: '21200', town: 'Beaune' },
  '8 rue des Tilleuls Essai, 21000 Dijon flou': { lat: 47.322, lon: 5.0415, score: 0.3 },
  '8 rue des Tilleuls Essai, 21000 Dijon': CENTER,
  '10 rue des Tilleuls Essai 21000 Dijon': { lat: 47.3222, lon: 5.0415 },
  '3 avenue du Parc Essai 21000 Dijon': { lat: 47.3245, lon: 5.0415 },
  '15 bis place du Marché Essai 21000 Dijon': { lat: 47.3195, lon: 5.0415 },
  '40 rue Lointaine Essai 21000 Dijon': { lat: 47.335, lon: 5.0415 },
  '8 rue des Tilleuls Essai 21000 Dijon': CENTER,
};
const geocoder: Geocoder = {
  geocode: async (address) => {
    const p = PLACES[address];
    return p ? { label: p.label ?? address.replace(',', ''), lat: p.lat, lon: p.lon, postalCode: p.postalCode ?? '21000', inseeCode: '21231', town: p.town ?? 'Dijon', banId: null, score: p.score ?? 0.9 } : null;
  },
};

async function setup(options: { drafter?: LetterDrafter | null; geocoder?: Geocoder | null } = {}) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date(NOW);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const lettres = new LettresQuartier(db, journal, { now, geocoder: options.geocoder === undefined ? geocoder : options.geocoder, drafter: options.drafter ?? null });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Essai' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Essai' });
  const agent = (id = alex.id) => ({ role: 'agent' as const, userId: id, networkId: network.id });
  const owner = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Vendeur', lastName: 'Essai' });
  const property = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'T-1', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 90, rooms: 4, priceEur: 260000 });
  const signMandate = async () => {
    await store.addSource({ networkId: network.id, agentId: alex.id, personId: owner.id, channel: 'site', detail: null, occurredAt: new Date(NOW - 86_400_000) });
    const r = await new Mandats(db, fiche, journal, { now }).record(acces, agent(), { personId: owner.id, propertyId: property.id, signedAt: new Date(NOW) });
    if (!r.ok) throw new Error(r.code);
    return r.id;
  };
  const input = (over: Record<string, unknown> = {}) => ({
    propertyId: property.id,
    trigger: 'mandat',
    propertyAddress: '8 rue des Tilleuls Essai, 21000 Dijon',
    recipient: 'au_proprietaire',
    origin: 'saisie_agent',
    addresses: [
      { number: '10', street: 'rue des Tilleuls Essai', postcode: '21000', city: 'Dijon' },
      { number: '3', street: 'avenue du Parc Essai', postcode: '21000', city: 'Dijon' },
      { number: '15 bis', street: 'place du Marché Essai', postcode: '21000', city: 'Dijon' },
    ],
    ...over,
  });
  const refusals = async () => (await journal.all()).filter((e) => e.type === 'lettres_quartier.refusee').map((e) => e.data.code);
  return { db, journal, store, lettres, network, alex, sam, agent, property, signMandate, input, refusals, now };
}

describeWithSqlite('G06 · lettres de quartier, adressées sans nom', () => {
  it('[R140] [R201] après un mandat signé, une lettre par adresse saisie dans le rayon, « Au propriétaire », imprimable et contrôlée', async () => {
    const t = await setup();
    await t.signMandate();
    const r = await t.lettres.createCampaign(t.agent(), t.input());
    expect(r).toEqual({ ok: true, value: { campaignId: expect.any(String), letters: 3, textBy: 'secours' } });
    if (!r.ok) return;
    const list = await t.lettres.letters(t.agent(), r.value.campaignId);
    expect(list.ok && list.value.map((l) => [l.number, l.street, l.distanceM])).toEqual([
      ['10', 'rue des Tilleuls Essai', distanceM(CENTER, PLACES['10 rue des Tilleuls Essai 21000 Dijon']!)],
      ['3', 'avenue du Parc Essai', distanceM(CENTER, PLACES['3 avenue du Parc Essai 21000 Dijon']!)],
      ['15 bis', 'place du Marché Essai', distanceM(CENTER, PLACES['15 bis place du Marché Essai 21000 Dijon']!)],
    ]);
    const printed = await t.lettres.printable(t.agent(), r.value.campaignId);
    if (!printed.ok) throw new Error(printed.code);
    expect(printed.value.letters).toBe(3);
    expect(printed.value.html.match(/<article class="lettre">/g)).toHaveLength(3);
    expect(printed.value.html.match(/Au propriétaire<br>/g)).toHaveLength(3);
    expect(printed.value.html).toContain('Alex Essai<br>Agent immobilier, réseau AIMMO');
    // Le contrôle du système de design : accessibilité du document imprimé, feuille dans les jetons [R201].
    expect(htmlProblems(printed.value.html, { print: true })).toEqual([]);
    expect(screenCssProblems(LETTER_CSS)).toEqual([]);
    // Dépôt noté une fois.
    const first = list.ok ? list.value[0]!.letterId : '';
    const d = await t.lettres.deposited(t.agent(), first);
    expect(d).toMatchObject({ ok: true });
    expect(await t.lettres.deposited(t.agent(), first)).toEqual(d);
    await expect(t.db.run('DELETE FROM neighbourhood_letters')).rejects.toThrow(/rien ne s'efface/);
  });

  it('[R140] jamais un nom : une civilité ou un nom dans une adresse, un champ de plus ou un autre destinataire sont refusés', async () => {
    const t = await setup();
    await t.signMandate();
    const named = [
      { number: '10', street: 'rue des Tilleuls Essai', postcode: '21000', city: 'Dijon', name: 'Dupont' },
      { number: '10', street: 'M. Dupont rue des Tilleuls Essai', postcode: '21000', city: 'Dijon' },
      { number: '10', street: 'rue des Tilleuls Essai chez Mme Martin', postcode: '21000', city: 'Dijon' },
      { number: 'Famille Durand 10', street: 'rue des Tilleuls Essai', postcode: '21000', city: 'Dijon' },
      { number: '10', street: 'rue des Tilleuls Essai', postcode: '21000', city: 'Monsieur Dijon' },
    ];
    for (const a of named) expect(await t.lettres.createCampaign(t.agent(), t.input({ addresses: [a] })), JSON.stringify(a)).toMatchObject({ ok: false, rule: 'R140', index: 0 });
    expect(await t.lettres.createCampaign(t.agent(), t.input({ recipient: 'M. Dupont' }))).toEqual({ ok: false, rule: 'R140', code: 'bad_recipient' });
    expect(await t.lettres.createCampaign(t.agent(), t.input({ recipientName: 'Dupont' }))).toEqual({ ok: false, rule: 'R140', code: 'unknown_field' });
    // Un nom collé à la voie ou mis à la place de la commune ne correspond à aucune adresse de la Base adresse nationale.
    expect(await t.lettres.createCampaign(t.agent(), t.input({ addresses: [{ number: '10', street: 'rue des Tilleuls Essai Jean Dupont', postcode: '21000', city: 'Dijon' }] }))).toEqual({ ok: false, rule: 'R140', code: 'not_an_address', index: 0 });
    expect(await t.lettres.createCampaign(t.agent(), t.input({ addresses: [{ number: '10', street: 'rue des Tilleuls Essai', postcode: '21000', city: 'Dupont' }] }))).toEqual({ ok: false, rule: 'R140', code: 'not_an_address', index: 0 });
    // Le centre doit être le bien : même code postal et commune que sa fiche, et une position sûre.
    expect(await t.lettres.createCampaign(t.agent(), t.input({ propertyAddress: '1 place Ailleurs, 21200 Beaune' }))).toEqual({ ok: false, rule: 'R140', code: 'center_not_property' });
    expect(await t.lettres.createCampaign(t.agent(), t.input({ propertyAddress: '8 rue des Tilleuls Essai, 21000 Dijon flou' }))).toEqual({ ok: false, rule: null, code: 'property_address_unknown' });
    // Une adresse hors du rayon de 500 m est refusée, et la campagne entière avec elle.
    expect(await t.lettres.createCampaign(t.agent(), t.input({ addresses: [{ number: '40', street: 'rue Lointaine Essai', postcode: '21000', city: 'Dijon' }] }))).toEqual({ ok: false, rule: 'R140', code: 'out_of_radius', index: 0 });
    // Sans géocodage, le rayon ne peut pas être vérifié : refus.
    const blind = await setup({ geocoder: null });
    await blind.signMandate();
    expect(await blind.lettres.createCampaign(blind.agent(), blind.input())).toEqual({ ok: false, rule: 'R140', code: 'no_geocoder' });
    expect(await t.db.all('SELECT * FROM neighbourhood_campaigns')).toEqual([]);
    expect(JSON.stringify(await t.journal.all())).not.toMatch(/Dupont|Martin|Tilleuls/);
  });

  it('[R37] une adresse venue des ventes publiques ou d’une liste achetée est refusée', async () => {
    const t = await setup();
    await t.signMandate();
    for (const origin of ['dvf', 'ventes publiques', 'liste achetée', 'fichier acheté', 'valeurs foncières']) {
      expect(await t.lettres.createCampaign(t.agent(), t.input({ origin })), origin).toEqual({ ok: false, rule: 'R37', code: 'forbidden_source' });
    }
    expect(await t.lettres.createCampaign(t.agent(), t.input({ origin: 'import' }))).toEqual({ ok: false, rule: 'R140', code: 'bad_origin' });
    expect(await t.lettres.createCampaign(t.agent(), t.input({ origin: undefined }))).toEqual({ ok: false, rule: 'R140', code: 'bad_origin' });
  });

  it('[R140] sans mandat signé ni vente rapportée, aucune campagne ; une vente rapportée en ouvre une', async () => {
    const t = await setup();
    expect(await t.lettres.createCampaign(t.agent(), t.input())).toEqual({ ok: false, rule: 'R140', code: 'no_trigger' });
    expect(await t.lettres.createCampaign(t.agent(), t.input({ trigger: 'vente' }))).toEqual({ ok: false, rule: 'R140', code: 'no_trigger' });
    await t.db.exec('PRAGMA foreign_keys = OFF');
    await t.db.run("INSERT INTO sale_files (id, network_id, property_id, offer_id, buyer_person_id, amount_eur, opened_at, opened_by) VALUES ('f1', ?, ?, 'o1', 'b1', 250000, '2027-09-01T08:00:00.000Z', 'agent:test')", [t.network.id, t.property.id]);
    await t.db.run("INSERT INTO sale_file_closings (file_id, network_id, signed_on, proof_ref, aftersale, at, by) VALUES ('f1', ?, '2027-10-01', 'preuves/test.pdf', 'a_demarrer', '2027-10-01T08:00:00.000Z', 'agent:test')", [t.network.id]);
    await t.db.exec('PRAGMA foreign_keys = ON');
    expect(await t.lettres.createCampaign(t.agent(), t.input({ trigger: 'vente', recipient: 'aux_habitants' }))).toMatchObject({ ok: true, value: { letters: 3 } });
    expect(await t.lettres.createCampaign(t.agent(), t.input({ trigger: 'mandat' }))).toEqual({ ok: false, rule: 'R140', code: 'no_trigger' });
  });

  it('[R140] un mandat annulé au registre n’ouvre aucune campagne', async () => {
    const t = await setup();
    const id = await t.signMandate();
    const registre = new RegistreMandats(t.db, t.journal, { now: t.now });
    const dir = { role: 'direction' as const, userId: 'dir-1', networkId: t.network.id };
    expect(await registre.configure(dir, { prefix: 'T-', firstNumber: 1, width: 4 })).toEqual({ ok: true });
    expect(await registre.inscribe(t.agent(), id)).toMatchObject({ ok: true });
    expect(await registre.cancel(dir, id, 'error')).toMatchObject({ ok: true });
    expect(await t.lettres.createCampaign(t.agent(), t.input())).toEqual({ ok: false, rule: 'R140', code: 'no_trigger' });
  });

  it('[R46] l’adresse du bien n’apparaît jamais : ni rangée, ni dans le texte, ni comme destinataire', async () => {
    const seen: unknown[] = [];
    const t = await setup({
      drafter: {
        draft: async (input) => {
          seen.push(input);
          return 'La maison de la rue des Tilleuls Essai vient de nous être confiée. Je reste à votre disposition pour parler de votre projet.';
        },
      },
    });
    await t.signMandate();
    const r = await t.lettres.createCampaign(t.agent(), t.input());
    expect(r).toMatchObject({ ok: true, value: { textBy: 'secours' } });
    // L'IA ne reçoit ni adresse ni nom ; son texte qui cite la voie du bien est remplacé.
    expect(seen).toEqual([{ trigger: 'mandat', city: 'Dijon' }]);
    expect((await t.journal.all()).filter((e) => e.type === 'lettres_quartier.ia_refusee').map((e) => e.data.code)).toEqual(['property_street']);
    const campaign = (await t.db.first<Record<string, unknown>>('SELECT * FROM neighbourhood_campaigns'))!;
    expect(JSON.stringify(campaign)).not.toMatch(/Tilleuls|8 rue/);
    expect(campaign.text).toBe(letterFallback('mandat', 'Dijon'));
    expect(checkLetterText('Au numéro 8 de votre rue, une maison est en vente.', null)).toBe('figure');
    // Sans virgule dans l'adresse du bien, la voie est reconnue de même, même avec le numéro écrit en lettres.
    const spelled = await setup({ drafter: { draft: async () => 'La maison située huit rue des Tilleuls Essai à Dijon vient de nous être confiée. Je reste à votre disposition pour en parler.' } });
    await spelled.signMandate();
    expect(await spelled.lettres.createCampaign(spelled.agent(), spelled.input({ propertyAddress: '8 rue des Tilleuls Essai 21000 Dijon' }))).toMatchObject({ ok: true, value: { textBy: 'secours' } });
    expect(checkLetterText('La maison située huit rue des Tilleuls Essai à Dijon vient de nous être confiée.', 'rue des Tilleuls Essai')).toBe('property_street');
    // Le bien lui-même n'est jamais un destinataire.
    expect(await t.lettres.createCampaign(t.agent(), t.input({ addresses: [{ number: '8', street: 'rue des Tilleuls Essai', postcode: '21000', city: 'Dijon' }] }))).toEqual({ ok: false, rule: 'R46', code: 'property_itself', index: 0 });
  });

  it('[R16] seul l’agent qui suit le bien prépare, imprime et note ses lettres', async () => {
    const t = await setup();
    await t.signMandate();
    expect(await t.lettres.createCampaign(t.agent(t.sam.id), t.input())).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(await t.lettres.createCampaign({ role: 'direction', userId: 'dir-1', networkId: t.network.id }, t.input())).toEqual({ ok: false, rule: 'R16', code: 'role' });
    const r = await t.lettres.createCampaign(t.agent(), t.input());
    if (!r.ok) throw new Error(r.code);
    expect(await t.lettres.printable(t.agent(t.sam.id), r.value.campaignId)).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(await t.lettres.letters(t.agent(t.sam.id), r.value.campaignId)).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(await t.lettres.printable(t.agent(), 'inconnue')).toEqual({ ok: false, rule: 'R16', code: 'unknown' });
  });
});
