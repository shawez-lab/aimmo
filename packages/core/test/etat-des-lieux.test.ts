import { describe, expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import {
  BauxLocation,
  Candidatures,
  ChoixProprietaire,
  EtatsDesLieux,
  HonorairesLocation,
  MisesEnLocation,
  checkFormatted,
  fallbackFormatted,
  type RentalFacts,
} from '../src/location/index.ts';
import { sha256 } from '../src/documents/modeles.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';
import { signRentalMandate } from './mandat-location-jeu.ts';

// Réseau, agents, propriétaire, candidats, logement et adresse inventés. Le 12 juillet 2027 est un lundi.
let clock = Date.parse('2027-07-12T08:00:00.000Z');
let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const SHA = 'a'.repeat(64);
const FACTS: RentalFacts = {
  furnished: false,
  rentCents: 65_000,
  chargesCents: 5_000,
  livingAreaHundredths: 4_250,
  energyClass: 'D',
  finalEnergyKwh: 210,
  buildYear: 1985,
  electricityOver15: false,
  mainRoomHundredths: 1_800,
  ceilingHeightCm: 250,
  localRules: { reference: 'Règlement sanitaire départemental, art. 40', checkedOn: '2027-01-04', compliant: true },
  firstLetting: true,
  gas: 'aucune',
  leaseStart: '2027-09-01',
  chargesMode: 'provision',
};
const INPUT = { address: '12 allée des Essais', ownerAddress: '3 chemin des Exemples, Ailleurs-Essai', habitat: 'collectif', landlord: 'physique', equipment: 'Cuisine équipée, cave', professionalCard: 'CPI 2101 2027 000 000 001' };
const FEES = { tenantCents: 34_000, tenantInventoryCents: 12_750, landlordCents: 34_000, landlordInventoryCents: 12_750, depositCents: 65_000 };
const BODY = [
  'Bail de {{bail.type}} entre {{bailleur.nom}}, domicilié {{bailleur.domicile}}, bailleur, et {{locataire.nom}}, locataire.',
  'Mandataire : {{reseau.nom}}, représenté par {{agent.nom}}, carte professionnelle {{mandataire.carte}}.',
  'Désignation : {{logement.habitat}}, {{logement.pieces}} pièces principales ; équipements : {{logement.equipements}}.',
  'Logement : {{logement.adresse}}, {{logement.commune}}, surface habitable {{logement.surface_habitable}}, classe énergie {{logement.classe_energie}}.',
  'Prise d’effet le {{bail.debut}}, pour {{bail.duree}}.',
  'Loyer : {{loyer.hors_charges}} ; charges : {{charges.montant}}, en {{charges.mode}} ; dépôt de garantie : {{depot.montant}}.',
  'Honoraires du locataire : {{honoraires.locataire}}, dont état des lieux {{honoraires.etat_des_lieux}} ; du bailleur : {{honoraires.bailleur}}.',
  'Annexes : {{annexes.liste}}.',
  'Fait le {{signature.date}} à {{signature.lieu}}.',
].join('\n\n');

async function setup() {
  clock = Date.parse('2027-07-12T08:00:00.000Z');
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date((clock += 60_000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const refs = new Set<string>();
  const files = { has: async (r: string) => refs.has(r) };
  const put = (prefix: string) => {
    const r = `${prefix}/${uuid()}.pdf`;
    refs.add(r);
    return r;
  };
  const listings = new MisesEnLocation(db, files, journal, { now, newId: uuid });
  const fees = new HonorairesLocation(db, listings, journal, { now });
  const identity = { state: async () => ({ identityVerifiedOn: '2027-07-10' }) };
  const apps = new Candidatures(db, listings, identity, files, journal, { now, newId: uuid });
  const choix = new ChoixProprietaire(db, listings, apps, files, journal, { now, newId: uuid });
  const acces = new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now });
  const baux = new BauxLocation(db, listings, fees, choix, files, acces, journal, { now, newId: uuid });
  const formatter = { reply: null as null | ((d: string) => string), calls: [] as { room: string; dictation: string }[], hook: null as null | (() => Promise<void>) };
  const ai = {
    format: async (x: { room: string; dictation: string }) => {
      formatter.calls.push(x);
      if (formatter.hook) await formatter.hook();
      if (!formatter.reply) throw new Error('indisponible');
      return formatter.reply(x.dictation);
    },
  };
  const edl = new EtatsDesLieux(db, listings, baux, choix, files, acces, ai, journal, { now, newId: uuid });
  const network = await store.createNetwork('Réseau Essai');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Essai' });
  const bea = await store.createAgent({ networkId: network.id, firstName: 'Béa', lastName: 'Essai' });
  const owner = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Bailleur', lastName: 'Inventé' });
  const home = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'L-1', kind: 'home', postalCode: '21000', city: 'Villeneuve-Essai', rooms: 2 });
  // AU014 : la location se fait sous un mandat de location signé et inscrit.
  await signRentalMandate(db, { networkId: network.id, agentId: alex.id, personId: owner.id, propertyId: home.id });
  const agent = { role: 'agent' as const, userId: alex.id, networkId: network.id };
  const other = { role: 'agent' as const, userId: bea.id, networkId: network.id };
  const dir = { role: 'direction' as const, userId: 'dir-1', networkId: network.id };
  const compliance = { role: 'compliance' as const, userId: 'conf-1', networkId: network.id };
  /** Le logement louable, son barème, deux candidats complets présentés ; le choix rangé si demandé. */
  const ready = async (facts: Partial<RentalFacts> = {}, choose = true) => {
    const c = await listings.create(agent, { propertyId: home.id, ownerPersonId: owner.id });
    const id = c.ok ? c.value.listingId : '';
    expect((await listings.recordFacts(agent, id, { ...FACTS, ...facts })).ok).toBe(true);
    for (const kind of ['dpe', 'erp', 'surface_habitable']) expect((await listings.addAnnex(agent, id, { kind, ref: put(`location/${id}`), diagnosedOn: '2027-07-01' })).ok).toBe(true);
    await listings.check(agent, id);
    await fees.setCommune(agent, id, '21999');
    expect((await fees.record(agent, id, FEES)).ok).toBe(true);
    const ids: string[] = [];
    for (const i of [1, 2]) {
      const pid = (await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: `Candidat${i}`, lastName: 'Inventé' })).id;
      const a = await apps.apply(agent, id, { personId: pid });
      const aid = a.ok ? a.value.applicationId : '';
      for (const sort of ['quittances_loyer', 'contrat_travail', 'bulletins_salaire']) await apps.addPiece(agent, aid, { holder: 'candidat', sort, ref: put(`location/${id}/candidatures/${aid}`), sha256: SHA });
      ids.push(aid);
    }
    const p = await choix.present(agent, id);
    if (choose) {
      const r = await choix.recordChoice(agent, id, { presentationId: p.ok ? p.value.presentationId : '', applicationId: ids[1]!, decidedAt: new Date(clock).toISOString(), channel: 'ecrit', proofRef: put(`location/${id}/choix`) });
      expect(r.ok).toBe(true);
    }
    return id;
  };
  const template = async (kind = 'bail_vide', body = BODY) => {
    const r = await baux.createTemplate(dir, kind, body);
    if (!r.ok) throw new Error(r.code);
    return r.value;
  };
  const inp = (id: string) => ({ ...INPUT, noticeRef: put(`location/${id}/bail`) });
  const photo = (id: string) => {
    const r = `location/${id}/etat-des-lieux/${uuid()}.jpg`;
    refs.add(r);
    return r;
  };
  /** Le logement louable, choisi, avec son bail d'essai complet. */
  const leased = async (facts: Partial<RentalFacts> = {}) => {
    await template(facts.furnished ? 'bail_meuble' : 'bail_vide');
    const id = await ready(facts);
    const l = await baux.generate(agent, id, inp(id));
    expect(l).toMatchObject({ ok: true, value: { status: 'complet', mode: 'essai' } });
    return id;
  };
  return { db, journal, listings, fees, baux, edl, formatter, agent, other, dir, compliance, ready, template, inp, put, photo, leased, owner, bea };
}

const DICTE = 'mur côté fenêtre avec deux trous de cheville, sol rayé près de la porte, pas de trace d’humidité';
const ROOMS = (photo?: string) => [
  { name: 'Séjour', elements: [{ name: 'Murs', state: 'bon' }, { name: 'Sol', state: 'usage' }], dictation: DICTE, photos: photo ? [photo] : [] },
  { name: 'Salle d’eau', elements: [{ name: 'Lavabo', state: 'neuf' }] },
];
const FULL = {
  address: '12 allée des Essais',
  ownerAddress: '3 chemin des Exemples, Ailleurs-Essai',
  meters: [{ kind: 'electricite', index: '012345', number: 'PDL-0000' }, { kind: 'eau_froide', index: '321,5' }],
  keys: [{ kind: 'Clé de la porte d’entrée', count: 2 }, { kind: 'Badge de l’immeuble', count: 1 }],
};
const DRAW = 'data:image/png;base64,AAAAexemple';

describe('W07 · mise en forme du dicté', () => {
  it('[R106] la mise en forme fidèle passe ; tout élément, état, chiffre ou négation ajouté est refusé', () => {
    expect(checkFormatted(DICTE, 'Mur côté fenêtre : deux trous de cheville. Sol rayé près de la porte. Pas de trace d’humidité.')).toEqual({ ok: true });
    expect(checkFormatted(DICTE, 'Mur côté fenêtre : 2 trous de cheville ; sol rayé près de la porte ; pas de trace d’humidité.')).toEqual({ ok: true });
    // Un pluriel changé, un accent ôté, une couleur ou un constat hors des listes échangé ou omis : fidélité non établie.
    expect(checkFormatted(DICTE, 'Murs côté fenêtres : 2 trous de chevilles ; sols rayés près des portes ; pas de traces d’humidité.')).toMatchObject({ ok: false, problems: ['words_changed'] });
    expect(checkFormatted('mur blanc sol noir', 'Mur noir, sol blanc.')).toMatchObject({ ok: false, problems: ['words_changed'] });
    expect(checkFormatted('mur avec impact', 'Mur.')).toMatchObject({ ok: false, problems: ['words_changed'] });
    expect(checkFormatted('tache sous la fenêtre', 'Tache sur la fenêtre.')).toMatchObject({ ok: false, problems: expect.arrayContaining(['words_changed']) });
    expect(checkFormatted('un trou dans le mur', 'Trous dans le mur.')).toMatchObject({ ok: false, problems: expect.arrayContaining(['words_changed']) });
    expect(checkFormatted(DICTE, 'Mur côté fenêtre avec deux trous, sol rayé, plafond fissuré. Pas d’humidité.')).toMatchObject({ ok: false, problems: expect.arrayContaining(['element_added', 'state_added', 'order_changed']) });
    expect(checkFormatted(DICTE, 'Mur côté fenêtre avec trois trous de cheville, sol rayé près de la porte, pas d’humidité.')).toMatchObject({ ok: false, problems: expect.arrayContaining(['number_added']) });
    expect(checkFormatted(DICTE, 'Mur côté fenêtre avec deux trous de cheville, sol rayé près de la porte, trace d’humidité.')).toMatchObject({ ok: false, problems: expect.arrayContaining(['negation_changed']) });
    expect(checkFormatted('sol propre', 'Sol propre, en bon état.')).toMatchObject({ ok: false, problems: expect.arrayContaining(['word_added', 'state_added']) });
    expect(checkFormatted('sol propre', 'Sol propre (mis en forme par l’IA).')).toMatchObject({ ok: false, problems: expect.arrayContaining(['mentions_ai']) });
    expect(checkFormatted('sol propre', '<b>Sol propre</b>')).toMatchObject({ ok: false, problems: expect.arrayContaining(['markup']) });
    expect(checkFormatted('sol propre', '')).toMatchObject({ ok: false, problems: expect.arrayContaining(['empty']) });
    expect(checkFormatted('sol propre', 'Sol propre. '.repeat(60))).toMatchObject({ ok: false, problems: expect.arrayContaining(['too_long']) });
  });

  it('[R106] la mise en forme n’ajoute aucun mot, n’ôte rien, n’échange rien et ne déplace aucune négation', () => {
    const d = 'mur taché, sol rayé';
    expect(checkFormatted(d, 'Mur taché ; sol rayé.')).toEqual({ ok: true });
    expect(checkFormatted(d, 'Mur taché, sol rayé ; le locataire accepte une retenue sur le dépôt de garantie.')).toMatchObject({ ok: false, problems: ['word_added', 'words_changed'] });
    expect(checkFormatted(d, 'Mur rayé, sol taché.')).toMatchObject({ ok: false, problems: ['words_changed', 'order_changed'] });
    expect(checkFormatted(d, 'Mur taché.')).toMatchObject({ ok: false, problems: ['words_changed', 'order_changed'] });
    expect(checkFormatted('pas de fuite, mur taché', 'Fuite au mur, pas de tache.')).toMatchObject({ ok: false, problems: expect.arrayContaining(['order_changed', 'words_changed']) });
    expect(checkFormatted(d, 'Mur taché, sol rayé.\nLocataire : Jean Martin.')).toMatchObject({ ok: false, problems: expect.arrayContaining(['markup', 'word_added']) });
    expect(checkFormatted(d, 'Mur taché, sol rayé, vu par le mandataire.')).toMatchObject({ ok: false, problems: ['word_added', 'words_changed'] });
    expect(checkFormatted('compteur à 321,5', 'Compteur à 321,5.')).toEqual({ ok: true });
  });

  it('[R106] le secours est le dicté lui-même, propre', () => {
    expect(fallbackFormatted('  sol   rayé près de la porte ')).toBe('Sol rayé près de la porte.');
    expect(fallbackFormatted('éclat sur le lavabo !')).toBe('Éclat sur le lavabo !');
    expect(fallbackFormatted('   ')).toBe('');
  });
});

describeWithSqlite('W07 · état des lieux d’entrée', () => {
  it('[R106] sans bail en vigueur, pas d’état des lieux ; l’IA fidèle est gardée, sinon le secours, et le texte refusé ne va pas au journal', async () => {
    const t = await setup();
    await t.template();
    const bare = await t.ready();
    expect(await t.edl.record(t.agent, bare, { ...FULL, rooms: ROOMS() })).toEqual({ ok: false, rule: 'R106', code: 'no_current_lease' });
    const id = await t.leased();
    t.formatter.reply = (d) => `${d.charAt(0).toUpperCase()}${d.slice(1)}.`;
    const ok = await t.edl.record(t.agent, id, { ...FULL, rooms: ROOMS() });
    expect(ok).toMatchObject({ ok: true, value: { version: 1, status: 'complet', missing: [], mode: 'essai' } });
    expect(ok.ok && ok.value.rooms.map((r) => r.origin)).toEqual(['ia', null]);
    expect(t.formatter.calls).toEqual([{ room: 'Séjour', dictation: DICTE }]);
    t.formatter.reply = () => 'Mur côté fenêtre avec deux trous de cheville, sol rayé, plafond taché MOTINVENTE. Pas d’humidité.';
    const fixed = await t.edl.record(t.agent, id, { ...FULL, rooms: ROOMS() });
    expect(fixed.ok && fixed.value.rooms[0]).toMatchObject({ origin: 'secours', text: `${DICTE.charAt(0).toUpperCase()}${DICTE.slice(1)}.` });
    expect(fixed.ok && fixed.value.content).not.toContain('plafond');
    t.formatter.reply = null;
    const down = await t.edl.record(t.agent, id, { ...FULL, rooms: ROOMS() });
    expect(down.ok && down.value.rooms[0]!.origin).toBe('secours');
    const log = JSON.stringify(await t.db.all('SELECT * FROM journal'));
    expect(log).toContain('location.etat_des_lieux_ia_refusee');
    expect(log).toContain('element_added');
    expect(log).not.toContain('MOTINVENTE');
    expect(log).not.toContain('cheville');
    // Le document ne parle jamais de l'IA [R06], et reprend chaque donnée saisie.
    const c = ok.ok ? ok.value.content : '';
    expect(c).not.toMatch(/\bIA\b|intelligence artificielle/i);
    for (const s of ['DOCUMENT D’ESSAI', 'Bailleur Inventé', 'Candidat2 Inventé', '12 allée des Essais', 'Villeneuve-Essai', 'Murs : bon état', 'Sol : état d’usage', 'Lavabo : neuf', 'Électricité, compteur PDL-0000 : 012345', 'Eau froide : 321,5', 'Clé de la porte d’entrée : 2', 'Badge de l’immeuble : 1'])
      expect(c).toContain(s);
  });

  it('[R106] une pièce sans élément, ou sans compteur ni clés, laisse l’état des lieux incomplet, et il ne se signe pas', async () => {
    const t = await setup();
    const id = await t.leased();
    const r = await t.edl.record(t.agent, id, { address: FULL.address, rooms: [{ name: 'Cuisine', elements: [] }] });
    expect(r).toMatchObject({ ok: true, value: { status: 'incomplet', missing: ['bailleur.domicile', 'piece.1', 'compteurs', 'cles'] } });
    expect(r.ok && r.value.content).toContain('[à compléter : éléments et leur état]');
    expect(await t.edl.sign(t.agent, r.ok ? r.value.inventoryId : '', { party: 'bailleur', contentSha256: r.ok ? r.value.contentSha256 : '', drawing: DRAW })).toEqual({ ok: false, rule: 'R106', code: 'incomplete' });
    const none = await t.edl.record(t.agent, id, FULL);
    expect(none.ok && none.value.missing).toEqual(['pieces']);
    // Le prénom seul ne nomme pas une partie.
    await t.db.run('UPDATE persons SET last_name = NULL WHERE id = ?', [t.owner.id]);
    const half = await t.edl.record(t.agent, id, { ...FULL, rooms: ROOMS() });
    expect(half.ok && half.value.missing).toEqual(['bailleur.nom']);
    expect(half.ok && half.value.content).toContain('[à compléter : nom du bailleur]');
    await t.db.run("UPDATE persons SET last_name = 'Inventé' WHERE id = ?", [t.owner.id]);
    // Sans commune sur la fiche du bien, l'état des lieux reste incomplet et ne se signe pas [R40].
    await t.db.run("UPDATE properties SET city = NULL");
    const nocity = await t.edl.record(t.agent, id, { ...FULL, rooms: ROOMS() });
    expect(nocity).toMatchObject({ ok: true, value: { status: 'incomplet', missing: ['logement.commune'] } });
    expect(nocity.ok && nocity.value.content).toContain('[à compléter : commune du logement]');
    const s2 = nocity.ok ? nocity.value : null;
    expect(await t.edl.sign(t.agent, s2!.inventoryId, { party: 'bailleur', contentSha256: s2!.contentSha256, drawing: DRAW })).toEqual({ ok: false, rule: 'R106', code: 'incomplete' });
  });

  it('[R106] un meublé exige l’inventaire du mobilier', async () => {
    const t = await setup();
    const id = await t.leased({ furnished: true });
    const r = await t.edl.record(t.agent, id, { ...FULL, rooms: ROOMS() });
    expect(r.ok && r.value.missing).toEqual(['mobilier']);
    const f = await t.edl.record(t.agent, id, { ...FULL, rooms: ROOMS(), furniture: [{ item: 'Table', count: 1, state: 'bon' }, { item: 'Chaise', count: 4, state: 'usage' }] });
    expect(f).toMatchObject({ ok: true, value: { status: 'complet' } });
    expect(f.ok && f.value.content).toContain('Chaise (4) : état d’usage');
  });

  it('[R106] clos seulement avec les deux signatures ; chaque partie reçoit le même exemplaire, de même empreinte', async () => {
    const t = await setup();
    const id = await t.leased();
    const r = await t.edl.record(t.agent, id, { ...FULL, rooms: ROOMS(t.photo(id)) });
    if (!r.ok) throw new Error(r.code);
    const { inventoryId, contentSha256 } = r.value;
    expect(r.value.content).toContain('Photos jointes : 1');
    // Les photos sont désignées dans le document signé : d'autres photos font une autre empreinte.
    expect(r.value.content).toContain(`- Photo : ${r.value.rooms[0]!.photos![0]}`);
    expect(await t.edl.sign(t.agent, inventoryId, { party: 'bailleur', contentSha256: 'b'.repeat(64), drawing: DRAW })).toEqual({ ok: false, rule: 'R106', code: 'document_changed' });
    expect(await t.edl.sign(t.agent, inventoryId, { party: 'voisin', contentSha256, drawing: DRAW })).toEqual({ ok: false, rule: null, code: 'bad_party' });
    expect(await t.edl.sign(t.agent, inventoryId, { party: 'bailleur', contentSha256, drawing: '' })).toEqual({ ok: false, rule: null, code: 'bad_drawing' });
    expect(await t.edl.sign(t.agent, inventoryId, { party: 'bailleur', contentSha256, drawing: DRAW })).toEqual({ ok: true, value: { party: 'bailleur', closed: false } });
    expect(await t.edl.sign(t.agent, inventoryId, { party: 'bailleur', contentSha256, drawing: DRAW })).toEqual({ ok: false, rule: 'R106', code: 'already_signed' });
    expect(await t.edl.copy(t.agent, inventoryId, 'bailleur')).toEqual({ ok: false, rule: 'R106', code: 'not_closed' });
    expect(await t.edl.closedInventory(t.agent.networkId, id)).toBeNull();
    expect(await t.edl.sign(t.agent, inventoryId, { party: 'locataire', contentSha256, drawing: DRAW + 'B' })).toEqual({ ok: true, value: { party: 'locataire', closed: true } });
    const a = await t.edl.copy(t.agent, inventoryId, 'bailleur');
    const b = await t.edl.copy(t.agent, inventoryId, 'locataire');
    // W25 : l'exemplaire porte l'identité des deux parties : un bailleur suivi par un autre agent le ferme, refus au journal [R16].
    const chosen = await t.db.first<{ person_id: string }>('SELECT a.person_id FROM rental_choices c JOIN rental_applications a ON a.id = c.application_id WHERE a.listing_id = ?', [id]);
    for (const personId of [t.owner.id, chosen!.person_id]) {
      const was = await t.db.first<{ agent_id: string }>('SELECT agent_id FROM persons WHERE id = ?', [personId]);
      await t.db.run('UPDATE persons SET agent_id = ? WHERE id = ?', [t.bea.id, personId]);
      const before = (await t.journal.all()).filter((e) => e.type === 'acces.refuse').length;
      expect(await t.edl.copy(t.agent, inventoryId, 'bailleur')).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
      expect((await t.journal.all()).filter((e) => e.type === 'acces.refuse').length).toBeGreaterThan(before);
      await t.db.run('UPDATE persons SET agent_id = ? WHERE id = ?', [was!.agent_id, personId]);
    }
    expect(a).toEqual(b);
    expect(a).toEqual({ ok: true, value: { content: r.value.content, contentSha256, photos: r.value.rooms[0]!.photos } });
    expect(await sha256(r.value.content)).toBe(contentSha256);
    expect(await t.edl.closedInventory(t.agent.networkId, id)).toMatchObject({ inventoryId, contentSha256, mode: 'essai' });
    // Le tracé n'est jamais gardé : son empreinte seule.
    const sigs = await t.db.all<{ party: string; drawing_sha256: string }>('SELECT party, drawing_sha256 FROM rental_inventory_signatures ORDER BY party');
    expect(sigs).toEqual([{ party: 'bailleur', drawing_sha256: await sha256(DRAW) }, { party: 'locataire', drawing_sha256: await sha256(DRAW + 'B') }]);
    expect(JSON.stringify(await t.db.all('SELECT * FROM rental_inventory_signatures'))).not.toContain('base64');
    // Clos : plus de nouvelle version, plus de signature.
    expect(await t.edl.record(t.agent, id, { ...FULL, rooms: ROOMS() })).toEqual({ ok: false, rule: 'R106', code: 'closed' });
    expect(await t.edl.sign(t.agent, inventoryId, { party: 'locataire', contentSha256, drawing: DRAW })).toEqual({ ok: false, rule: 'R106', code: 'closed' });
  });

  it('[R17] [R106] une correction avant la clôture est une nouvelle version, qui demande de nouvelles signatures ; rien ne s’efface', async () => {
    const t = await setup();
    const id = await t.leased();
    const v1 = await t.edl.record(t.agent, id, { ...FULL, rooms: ROOMS() });
    if (!v1.ok) throw new Error(v1.code);
    expect((await t.edl.sign(t.agent, v1.value.inventoryId, { party: 'bailleur', contentSha256: v1.value.contentSha256, drawing: DRAW })).ok).toBe(true);
    const v2 = await t.edl.record(t.agent, id, { ...FULL, rooms: [...ROOMS(), { name: 'Chambre', elements: [{ name: 'Parquet', state: 'bon' }] }] });
    if (!v2.ok) throw new Error(v2.code);
    expect(v2.value.version).toBe(2);
    expect(await t.edl.sign(t.agent, v1.value.inventoryId, { party: 'locataire', contentSha256: v1.value.contentSha256, drawing: DRAW })).toEqual({ ok: false, rule: 'R106', code: 'not_latest' });
    expect(await t.edl.sign(t.agent, v2.value.inventoryId, { party: 'locataire', contentSha256: v2.value.contentSha256, drawing: DRAW })).toEqual({ ok: true, value: { party: 'locataire', closed: false } });
    expect(await t.edl.sign(t.agent, v2.value.inventoryId, { party: 'bailleur', contentSha256: v2.value.contentSha256, drawing: DRAW })).toEqual({ ok: true, value: { party: 'bailleur', closed: true } });
    await expect(t.db.run('DELETE FROM rental_inventories')).rejects.toThrow(/rien ne s/);
    await expect(t.db.run("UPDATE rental_inventories SET content = 'x'")).rejects.toThrow(/ne change plus/);
    await expect(t.db.run('DELETE FROM rental_inventory_signatures')).rejects.toThrow(/rien ne s/);
    await expect(t.db.run("UPDATE rental_inventory_copies SET content_sha256 = ?", ['c'.repeat(64)])).rejects.toThrow(/ne change plus/);
    expect((await t.db.all('SELECT id FROM rental_inventories')).length).toBe(2);
  });

  it('[R106] une correction en cours de mise en forme ne remplace jamais un état des lieux clos entre-temps', async () => {
    const t = await setup();
    const id = await t.leased();
    const v1 = await t.edl.record(t.agent, id, { ...FULL, rooms: ROOMS() });
    if (!v1.ok) throw new Error(v1.code);
    await t.edl.sign(t.agent, v1.value.inventoryId, { party: 'bailleur', contentSha256: v1.value.contentSha256, drawing: DRAW });
    t.formatter.reply = (d) => d;
    t.formatter.hook = async () => {
      t.formatter.hook = null;
      expect(await t.edl.sign(t.agent, v1.value.inventoryId, { party: 'locataire', contentSha256: v1.value.contentSha256, drawing: DRAW })).toEqual({ ok: true, value: { party: 'locataire', closed: true } });
    };
    expect(await t.edl.record(t.agent, id, { ...FULL, rooms: ROOMS() })).toEqual({ ok: false, rule: 'R106', code: 'closed' });
    expect(await t.edl.closedInventory(t.agent.networkId, id)).toMatchObject({ inventoryId: v1.value.inventoryId });
    expect((await t.db.all('SELECT id FROM rental_inventories')).length).toBe(1);
  });

  it('[R106] les deux exemplaires sont rangés ensemble ou pas du tout ; une clôture interrompue se reprend', async () => {
    const t = await setup();
    const id = await t.leased();
    const r = await t.edl.record(t.agent, id, { ...FULL, rooms: ROOMS() });
    if (!r.ok) throw new Error(r.code);
    const { inventoryId, contentSha256 } = r.value;
    await t.edl.sign(t.agent, inventoryId, { party: 'bailleur', contentSha256, drawing: DRAW });
    const run = t.db.run.bind(t.db);
    t.db.run = async (sql, params) => {
      if (/INSERT INTO rental_inventory_copies/.test(sql)) throw new Error('coupure');
      return run(sql, params);
    };
    await expect(t.edl.sign(t.agent, inventoryId, { party: 'locataire', contentSha256, drawing: DRAW })).rejects.toThrow('coupure');
    t.db.run = run;
    expect((await t.db.all('SELECT id FROM rental_inventory_copies')).length).toBe(0);
    expect(await t.edl.closedInventory(t.agent.networkId, id)).toBeNull();
    expect(await t.edl.sign(t.agent, inventoryId, { party: 'locataire', contentSha256, drawing: DRAW })).toEqual({ ok: true, value: { party: 'locataire', closed: true } });
    expect((await t.db.all<{ party: string }>('SELECT party FROM rental_inventory_copies ORDER BY party')).map((c) => c.party)).toEqual(['bailleur', 'locataire']);
    expect((await t.edl.copy(t.agent, inventoryId, 'locataire')).ok).toBe(true);
  });

  it('[R106] un bail remplacé après l’état des lieux empêche de le signer', async () => {
    const t = await setup();
    const id = await t.leased();
    const r = await t.edl.record(t.agent, id, { ...FULL, rooms: ROOMS() });
    if (!r.ok) throw new Error(r.code);
    expect((await t.baux.generate(t.agent, id, t.inp(id))).ok).toBe(true);
    expect(await t.edl.sign(t.agent, r.value.inventoryId, { party: 'bailleur', contentSha256: r.value.contentSha256, drawing: DRAW })).toEqual({ ok: false, rule: 'R106', code: 'lease_changed' });
  });

  it('[R16] seul l’agent du logement ou la direction fait l’état des lieux ; une photo doit être rangée ; une saisie hors forme est refusée', async () => {
    const t = await setup();
    const id = await t.leased();
    expect(await t.edl.record(t.other, id, { ...FULL, rooms: ROOMS() })).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    const r = await t.edl.record(t.dir, id, { ...FULL, rooms: ROOMS() });
    expect(r.ok).toBe(true);
    expect(await t.edl.copy(t.other, r.ok ? r.value.inventoryId : '', 'bailleur')).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(await t.edl.sign(t.other, r.ok ? r.value.inventoryId : '', { party: 'bailleur', contentSha256: r.ok ? r.value.contentSha256 : '', drawing: DRAW })).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(await t.edl.record(t.agent, id, { ...FULL, rooms: ROOMS(`location/${id}/etat-des-lieux/00000000-0000-4000-8000-999999999999.jpg`) })).toEqual({ ok: false, rule: null, code: 'photo_not_stored' });
    expect(await t.edl.record(t.agent, id, { ...FULL, rooms: ROOMS('ailleurs/photo.jpg') })).toEqual({ ok: false, rule: null, code: 'bad_rooms' });
    expect(await t.edl.record(t.agent, id, { ...FULL, rooms: [{ name: 'Séjour', elements: [{ name: 'Sol', state: 'superbe' }] }] })).toEqual({ ok: false, rule: null, code: 'bad_rooms' });
    expect(await t.edl.record(t.agent, id, { ...FULL, rooms: ROOMS(), meters: [{ kind: 'eau', index: '1' }] })).toEqual({ ok: false, rule: null, code: 'bad_meters' });
    expect(await t.edl.record(t.agent, id, { ...FULL, rooms: ROOMS(), keys: [{ kind: 'Clé', count: 0 }] })).toEqual({ ok: false, rule: null, code: 'bad_keys' });
    expect(await t.edl.record(t.agent, id, { ...FULL, rooms: [{ name: 'Séjour', elements: [], dictation: '<script>' }] })).toEqual({ ok: false, rule: null, code: 'bad_rooms' });
    // Un bailleur suivi par un autre agent : son nom ne sort pas.
    await t.db.run('UPDATE persons SET agent_id = ? WHERE id = ?', [t.bea.id, t.owner.id]);
    const x = await t.edl.record(t.agent, id, { ...FULL, rooms: ROOMS() });
    expect(x).toMatchObject({ ok: false, rule: 'R16' });
    expect(JSON.stringify(x)).not.toContain('Bailleur');
  });
});
