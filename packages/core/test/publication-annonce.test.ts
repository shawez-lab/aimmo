import { expect, it } from 'vitest';
import {
  Acces,
  ControlesSignature,
  Diffusion,
  FicheClient,
  FicheUnique,
  Modeles,
  RegistreMandats,
  SignatureAvenant,
  SignaturePapier,
  SqlJournalStore,
  applyMigrations,
  fromSyncSqlite,
  type SqlDatabase,
  type Viewer,
} from '../src/index.ts';
import { Annonces, CHANNELS, FicheBien, MentionsAnnonce, Publication, type Channel, type ListingChannel, type ListingPayload } from '../src/annonces/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, bien, vendeur et mandat inventés.
const MANDATE = 'Mandat de test : {{mandant.nom}}, {{bien.prix}}, {{honoraires.montant}} {{honoraires.charge}}, {{mandat.duree_mois}}.\n\nNuméro : {{registre.numero}}.';
const AMENDMENT = 'Avenant de test au mandat n° {{mandat.numero}} : {{avenant.objet}}.\n\nMandant : {{mandant.nom}}. Signé le {{signature.date}}, {{signature.lieu}}.';
const SIGNED = new Date('2027-02-10T09:00:00.000Z'); // un mercredi, hors de l'agence : délai jusqu'au 24 février inclus
const DELAY_END = new Date('2027-02-24T23:00:00.000Z'); // 25 février, 0 h à Paris
const MIN = 60_000;

/** Un canal de test qui garde ce qu'il reçoit, et peut tomber en panne à la demande. */
class FakeChannel implements ListingChannel {
  received: ListingPayload[] = [];
  failNext = 0;
  constructor(readonly channel: Channel) {}
  async push(payload: ListingPayload): Promise<void> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('portail_indisponible');
    }
    this.received.push(payload);
  }
}

async function setup(options: { card?: boolean } = {}) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = new Date('2027-02-10T10:00:00.000Z');
  const now = () => clock;
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const acces = new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now });
  const modeles = new Modeles(db, acces, journal, { now });
  const controles = new ControlesSignature(db, acces, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const as = (role: string, userId: string): Viewer => ({ role, userId, networkId: network.id }) as Viewer;
  const agent = as('agent', alex.id);
  const direction = as('direction', 'direction-1');
  for (const [kind, body] of [['mandat_vente_simple', MANDATE], ['avenant_mandat', AMENDMENT]] as const) {
    const v = await modeles.createVersion(direction, kind, body);
    if (!v.ok) throw new Error(v.code);
    await modeles.validate(as('compliance', 'c-1'), v.template.id);
  }
  await controles.setFeeSchedule(direction, { maxRatePercent: 6, minEur: 0 });
  await new RegistreMandats(db, journal, { now }).configure(direction, { prefix: 'T-', firstNumber: 1, width: 3 });
  const p = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Léa', lastName: 'Exemple' });
  const b = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'REF-T-1', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 62, rooms: 3, priceEur: 200000 });
  const project = await store.createProject({ networkId: network.id, agentId: alex.id, personId: p.id, kind: 'sell' });
  await store.linkProjectProperty({ networkId: network.id, agentId: alex.id, projectId: project.id, propertyId: b.id, role: 'owned' });
  await controles.recordIdentity(agent, p.id, { piece: 'carte_identite', seenAt: SIGNED });
  await new FicheBien(db, acces, journal, { now }).save(agent, b.id, {
    characteristics: { bedrooms: 2, floor: 3, floorsTotal: 5, buildYear: 1965, heating: 'collectif', outdoor: ['balcon'], parkingSpaces: 1, elevator: true },
    energy: { energyClass: 'D', climateClass: 'C', annualCostMinEur: 1100, annualCostMaxEur: 1550, costReferenceYear: 2023, diagnosedOn: '2027-01-15' },
    coownership: { isCoownership: true, lots: 24, annualChargesEur: 1800, proceedings: false },
    risks: { inRiskZone: false },
  });
  if (options.card !== false) await new MentionsAnnonce(db, acces, journal, { now }).setCardNumber(direction, 'CPI 2101 2027 000 000 001');
  const d = await modeles.generate(agent, { kind: 'mandat_vente_simple', personId: p.id, propertyId: b.id, inputs: { 'honoraires.montant': 10000, 'honoraires.charge': 'acquereur', 'mandat.duree_mois': 12 } });
  if (!d.ok) throw new Error(d.code);
  const signed = await new SignaturePapier(db, acces, journal, { now }).register(agent, d.document.id, { signedAt: SIGNED, place: 'hors_agence', scanRef: 'scans/mandat.pdf', source: 'referral' });
  if (!signed.ok) throw new Error(signed.code);
  const annonces = new Annonces(db, acces, journal, { now });
  const draft = await annonces.propose(agent, b.id);
  if (!draft.ok) throw new Error(draft.code);
  const channels = CHANNELS.map((c) => new FakeChannel(c));
  const publication = new Publication(db, acces, journal, { now, channels });
  const amend = async (priceEur: number) => {
    const a = await modeles.generate(agent, { kind: 'avenant_mandat', personId: p.id, propertyId: b.id, mandateId: signed.value.mandateId, inputs: { 'avenant.prix': priceEur } });
    if (!a.ok) throw new Error(a.code);
    const r = await new SignatureAvenant(db, acces, journal, { now }).register(agent, a.document.id, { signedAt: clock, place: 'agence', scanRef: `scans/avenant-${priceEur}.pdf` });
    if (!r.ok) throw new Error(r.code);
  };
  return {
    db, journal, acces, annonces, publication, channels, agent, direction, sam: as('agent', sam.id), network, propertyId: b.id, draftId: draft.value.id, mandateId: signed.value.mandateId, amend,
    now, setClock: (at: Date) => (clock = at),
    /** Les passages du planificateur, toutes les 15 minutes, de `from` à `to` inclus ; rend l'heure du premier passage qui publie. */
    async runEvery15(from: Date, to: Date): Promise<Date | null> {
      let first: Date | null = null;
      for (let t = from.getTime(); t <= to.getTime(); t += 15 * MIN) {
        clock = new Date(t);
        const r = await publication.sync(network.id, b.id);
        if (first === null && r.created) first = clock;
      }
      return first;
    },
  };
}

const prices = (t: Awaited<ReturnType<typeof setup>>) => t.channels.map((c) => c.received.at(-1)?.priceEur ?? null);

describeWithSqlite('P04 · publication partout, au même prix, en mode essai', () => {
  it('[R42] [R47] rien ne part sans annonce validée ni pendant le délai de rétractation ; publié partout moins d’une heure après sa fin', async () => {
    const t = await setup();
    // Annonce validée pendant le délai : la porte de diffusion dit encore non.
    t.setClock(new Date('2027-02-12T10:00:00.000Z'));
    expect(await t.annonces.validate(t.agent, t.draftId)).toMatchObject({ ok: true });
    expect(await t.runEvery15(new Date('2027-02-24T20:00:00.000Z'), new Date('2027-02-24T22:45:00.000Z'))).toBeNull();
    expect(t.channels.every((c) => c.received.length === 0)).toBe(true);
    // Le passage qui suit la fin du délai publie sur chaque canal.
    const first = await t.runEvery15(DELAY_END, new Date(DELAY_END.getTime() + 60 * MIN));
    expect(first).not.toBeNull();
    expect(first!.getTime() - DELAY_END.getTime()).toBeLessThan(60 * MIN);
    expect(t.channels.map((c) => c.received.length)).toEqual([1, 1, 1, 1]);
    const st = await t.publication.status(t.agent, t.propertyId);
    expect(st.ok && st.value).toEqual({ version: 1, state: 'en_vente', priceEur: 210000, channels: { site: 'publiee', reseaux: 'publiee', google: 'publiee', portails: 'publiee' } });
  });

  it('[R47] sans validation de l’agent, rien n’est publié même hors délai', async () => {
    const t = await setup();
    t.setClock(new Date('2027-03-01T10:00:00.000Z'));
    expect(await t.publication.sync(t.network.id, t.propertyId)).toEqual({ version: null, state: null, created: false, pushed: [], failed: [] });
    expect(t.channels.every((c) => c.received.length === 0)).toBe(true);
  });

  it('[R44] même prix sur tous les canaux ; un avenant de prix est répercuté partout en moins de 15 minutes', async () => {
    const t = await setup();
    t.setClock(new Date('2027-02-12T10:00:00.000Z'));
    await t.annonces.validate(t.agent, t.draftId);
    await t.runEvery15(new Date('2027-03-01T08:00:00.000Z'), new Date('2027-03-01T08:00:00.000Z'));
    expect(prices(t)).toEqual([210000, 210000, 210000, 210000]);
    // L'avenant est signé à 8 h 07 ; le passage de 8 h 15 le répercute partout.
    t.setClock(new Date('2027-03-01T08:07:00.000Z'));
    await t.amend(190000);
    const signedAt = t.now();
    const at = await t.runEvery15(new Date('2027-03-01T08:15:00.000Z'), new Date('2027-03-01T09:00:00.000Z'));
    expect(at!.getTime() - signedAt.getTime()).toBeLessThanOrEqual(15 * MIN);
    expect(prices(t)).toEqual([200000, 200000, 200000, 200000]);
    expect(t.channels.every((c) => c.received.at(-1)!.mentions!.includes('hors honoraires'))).toBe(true);
    // Rien ne change : aucun nouvel envoi.
    expect(t.channels.map((c) => c.received.length)).toEqual([2, 2, 2, 2]);
  });

  it('un canal en panne est réessayé au passage suivant, sans doublon ; l’échec est au journal', async () => {
    const t = await setup();
    t.setClock(new Date('2027-02-12T10:00:00.000Z'));
    await t.annonces.validate(t.agent, t.draftId);
    t.channels[3]!.failNext = 1;
    t.setClock(new Date('2027-03-01T08:00:00.000Z'));
    expect(await t.publication.sync(t.network.id, t.propertyId)).toMatchObject({ version: 1, created: true, pushed: ['site', 'reseaux', 'google'], failed: ['portails'] });
    const st = await t.publication.status(t.agent, t.propertyId);
    expect(st.ok && st.value?.channels.portails).toBe('echec');
    t.setClock(new Date('2027-03-01T08:15:00.000Z'));
    expect(await t.publication.sync(t.network.id, t.propertyId)).toMatchObject({ version: 1, created: false, pushed: ['portails'], failed: [] });
    expect(await t.publication.sync(t.network.id, t.propertyId)).toMatchObject({ version: 1, created: false, pushed: [], failed: [] });
    expect(t.channels.map((c) => c.received.length)).toEqual([1, 1, 1, 1]);
    const failure = (await t.journal.bySubject(`property:${t.propertyId}`)).find((e) => e.type === 'annonce.envoi_echec');
    expect(failure?.data).toEqual({ channel: 'portails', seq: 1, code: 'portail_indisponible' });
  });

  it('[R42] un mandat rétracté, annulé ou échu retire l’annonce partout au passage suivant', async () => {
    // Rétractation pendant le délai, après un début anticipé demandé par écrit.
    const w = await setup();
    w.setClock(new Date('2027-02-12T10:00:00.000Z'));
    await w.annonces.validate(w.agent, w.draftId);
    const diffusion = new Diffusion(w.db, w.acces, w.journal, { now: w.now });
    await diffusion.recordEarlyStart(w.agent, w.mandateId, { proof: 'demande écrite du vendeur', receivedAt: new Date('2027-02-12T09:00:00.000Z') });
    expect(await w.publication.sync(w.network.id, w.propertyId)).toMatchObject({ version: 1, state: 'en_vente', created: true });
    w.setClock(new Date('2027-02-14T10:00:00.000Z'));
    await diffusion.recordWithdrawal(w.agent, w.mandateId, { proof: 'lettre de rétractation', receivedAt: new Date('2027-02-14T09:00:00.000Z') });
    expect(await w.publication.sync(w.network.id, w.propertyId)).toMatchObject({ version: 2, state: 'retiree', created: true });
    expect(w.channels.map((c) => c.received.at(-1)?.state)).toEqual(['retiree', 'retiree', 'retiree', 'retiree']);
    expect(w.channels.every((c) => c.received.at(-1)!.priceEur === null && c.received.at(-1)!.body === null)).toBe(true);
    expect(await w.publication.sync(w.network.id, w.propertyId)).toMatchObject({ version: 2, created: false, pushed: [] });
    // Annulé au registre.
    const c = await setup();
    c.setClock(new Date('2027-02-12T10:00:00.000Z'));
    await c.annonces.validate(c.agent, c.draftId);
    c.setClock(new Date('2027-03-01T10:00:00.000Z'));
    await c.publication.sync(c.network.id, c.propertyId);
    await new RegistreMandats(c.db, c.journal, { now: c.now }).cancel(c.direction, c.mandateId, 'termination');
    expect(await c.publication.sync(c.network.id, c.propertyId)).toMatchObject({ version: 2, state: 'retiree' });
    // Échu : 12 mois après la signature.
    const e = await setup();
    e.setClock(new Date('2027-02-12T10:00:00.000Z'));
    await e.annonces.validate(e.agent, e.draftId);
    e.setClock(new Date('2027-03-01T10:00:00.000Z'));
    await e.publication.sync(e.network.id, e.propertyId);
    e.setClock(new Date('2028-02-10T10:00:00.000Z'));
    expect(await e.publication.sync(e.network.id, e.propertyId)).toMatchObject({ version: 2, state: 'retiree' });
    const retired = (await e.journal.bySubject(`property:${e.propertyId}`)).find((x) => x.type === 'annonce.retiree');
    expect(retired?.data).toEqual({ rule: 'R42', seq: 2, state: 'retiree', reason: 'expired' });
  });

  it('[R43] sans liste de contrôle complète rien n’est publié, et une annonce en ligne est retirée au passage suivant', async () => {
    const t = await setup({ card: false });
    t.setClock(new Date('2027-03-01T10:00:00.000Z'));
    // Sans numéro de carte, l'annonce ne peut même pas être validée, et rien ne part.
    expect(await t.annonces.validate(t.agent, t.draftId)).toMatchObject({ ok: false, rule: 'R43', code: 'mentions_incomplete' });
    expect(await t.publication.sync(t.network.id, t.propertyId)).toEqual({ version: null, state: null, created: false, pushed: [], failed: [] });
    // Une annonce en ligne dont une mention vient à manquer est retirée partout.
    const u = await setup();
    u.setClock(new Date('2027-02-12T10:00:00.000Z'));
    await u.annonces.validate(u.agent, u.draftId);
    u.setClock(new Date('2027-03-01T10:00:00.000Z'));
    await u.publication.sync(u.network.id, u.propertyId);
    await u.db.run("UPDATE properties SET kind = 'commercial' WHERE id = ?", [u.propertyId]);
    expect(await u.publication.sync(u.network.id, u.propertyId)).toMatchObject({ version: 2, state: 'retiree', created: true });
    expect(u.channels.map((c) => c.received.at(-1)?.state)).toEqual(['retiree', 'retiree', 'retiree', 'retiree']);
    const retired = (await u.journal.bySubject(`property:${u.propertyId}`)).find((x) => x.type === 'annonce.retiree');
    expect(retired?.data).toEqual({ rule: 'R42', seq: 2, state: 'retiree', reason: 'mentions_incompletes' });
  });

  it('[R42] un bien en erreur n’arrête pas le passage des autres ; l’échec est au journal', async () => {
    const t = await setup();
    t.setClock(new Date('2027-02-12T10:00:00.000Z'));
    await t.annonces.validate(t.agent, t.draftId);
    t.setClock(new Date('2027-03-01T10:00:00.000Z'));
    const original = t.publication.sync.bind(t.publication);
    let calls = 0;
    t.publication.sync = async (networkId, propertyId) => {
      calls++;
      if (calls === 1) throw new Error('panne passagère');
      return original(networkId, propertyId);
    };
    // Un second bien inventé, avec un brouillon, pour que le passage en compte deux.
    await t.db.run("INSERT INTO properties (id, network_id, agent_id, reference, kind, status, created_at, updated_at) SELECT 'bien-2', network_id, agent_id, 'REF-T-2', 'home', 'draft', created_at, updated_at FROM properties WHERE id = ?", [t.propertyId]);
    await t.annonces.propose(t.agent, 'bien-2');
    const all = await t.publication.syncAll(t.network.id);
    expect(all).toHaveLength(2);
    expect(all.filter((x) => x.result === null)).toHaveLength(1);
    const failed = all.find((x) => x.result === null)!.propertyId;
    const entry = (await t.journal.bySubject(`property:${failed}`)).find((e) => e.type === 'annonce.passage_echec');
    expect(entry?.data).toEqual({ rule: 'R42', code: 'erreur' });
    expect(JSON.stringify(entry)).not.toContain('panne');
  });

  it('l’état du bien suit : sous offre, vendu, retiré de la vente', async () => {
    const t = await setup();
    t.setClock(new Date('2027-02-12T10:00:00.000Z'));
    await t.annonces.validate(t.agent, t.draftId);
    t.setClock(new Date('2027-03-01T10:00:00.000Z'));
    await t.publication.sync(t.network.id, t.propertyId);
    await t.db.run("UPDATE properties SET status = 'under_offer' WHERE id = ?", [t.propertyId]);
    expect(await t.publication.sync(t.network.id, t.propertyId)).toMatchObject({ version: 2, state: 'sous_offre' });
    await t.db.run("UPDATE properties SET status = 'sold' WHERE id = ?", [t.propertyId]);
    expect(await t.publication.sync(t.network.id, t.propertyId)).toMatchObject({ version: 3, state: 'vendu' });
    await t.db.run("UPDATE properties SET status = 'withdrawn' WHERE id = ?", [t.propertyId]);
    expect(await t.publication.sync(t.network.id, t.propertyId)).toMatchObject({ version: 4, state: 'retiree' });
    expect(t.channels[0]!.received.map((p) => p.state)).toEqual(['en_vente', 'sous_offre', 'vendu', 'retiree']);
  });

  it('ce que reçoivent les canaux ne porte ni adresse, ni nom, ni coordonnée ; rien ne s’efface', async () => {
    const t = await setup();
    t.setClock(new Date('2027-02-12T10:00:00.000Z'));
    await t.annonces.validate(t.agent, t.draftId);
    t.setClock(new Date('2027-03-01T10:00:00.000Z'));
    const all = await t.publication.syncAll(t.network.id);
    expect(all).toHaveLength(1);
    const p = t.channels[0]!.received[0]!;
    expect(Object.keys(p).sort()).toEqual(['body', 'mentions', 'priceEur', 'reference', 'state', 'title', 'version']);
    expect(JSON.stringify(p)).not.toMatch(/Léa|Exemple|rue /);
    await expect(t.db.run('DELETE FROM listing_versions')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run('UPDATE listing_pushes SET outcome = \'ok\'')).rejects.toThrow(/ne change plus/);
  });

  it('[R16] l’état de publication se lit selon les droits ; deux passages simultanés ne créent qu’une version', async () => {
    const t = await setup();
    t.setClock(new Date('2027-02-12T10:00:00.000Z'));
    await t.annonces.validate(t.agent, t.draftId);
    t.setClock(new Date('2027-03-01T10:00:00.000Z'));
    const [a, b] = await Promise.all([t.publication.sync(t.network.id, t.propertyId), t.publication.sync(t.network.id, t.propertyId)]);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    expect(t.channels.map((c) => c.received.length)).toEqual([1, 1, 1, 1]);
    expect(await t.publication.status(t.sam, t.propertyId)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.publication.status(t.direction, t.propertyId)).toMatchObject({ ok: true, value: { version: 1 } });
    expect(await t.publication.sync('autre-reseau', t.propertyId)).toEqual({ version: null, state: null, created: false, pushed: [], failed: [] });
  });
});

it('P04 · un canal inconnu ou en double est refusé à la construction', () => {
  const db = {} as SqlDatabase;
  expect(() => new Publication(db, {} as Acces, {} as never, { channels: [new FakeChannel('site'), new FakeChannel('site')] })).toThrow(/double/);
  expect(() => new Publication(db, {} as Acces, {} as never, { channels: [new FakeChannel('fax' as Channel)] })).toThrow(/inconnu/);
});
