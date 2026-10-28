import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { Annuaire, CLOSED_ACCESS_DAYS, EspacePartenaire, MiseEnRelation, PARTNER_FIELDS, PARTNER_TRADES, type ConsentProofStore } from '../src/partenaires/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, agent, client, bien et partenaires inventés.
let clock = Date.parse('2027-07-12T08:00:00.000Z');
const DAY = 86_400_000;
let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

class FakeStore implements ConsentProofStore {
  readonly refs = new Set<string>();
  put(prefix: string): string {
    const ref = `${prefix}/${uuid()}.pdf`;
    this.refs.add(ref);
    return ref;
  }
  async has(ref: string): Promise<boolean> {
    return this.refs.has(ref);
  }
}

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const files = new FakeStore();
  const annuaire = new Annuaire(db, files, journal, { now, newId: uuid });
  const relations = new MiseEnRelation(db, annuaire, files, journal, { now, newId: uuid, newSeed: () => 1 });
  const space = new EspacePartenaire(db, annuaire, relations, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const other = await store.createNetwork('Autre réseau');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Essai' });
  const person = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Camille', lastName: 'Exemple' });
  await store.addIdentifier({ networkId: network.id, personId: person.id, kind: 'email', value: 'camille@example.test' });
  const project = await store.createProject({ networkId: network.id, agentId: alex.id, personId: person.id, kind: 'sell', budgetMinEur: 180000, budgetMaxEur: 210000, note: 'Note privée de l’agent', criteria: { calme: true } });
  const property = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'T-1', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 82, rooms: 4, priceEur: 230000 });
  await store.linkProjectProperty({ networkId: network.id, agentId: alex.id, projectId: project.id, propertyId: property.id, role: 'owned' });
  const dir = { role: 'direction' as const, userId: 'dir-1', networkId: network.id };
  const agent = { role: 'agent' as const, userId: alex.id, networkId: network.id };
  const day = (d = 0): string => new Date(clock + d * DAY).toISOString().slice(0, 10);
  const partner = async (trade: string, name: string, until = 300): Promise<string> => {
    const r = await annuaire.addPartner(dir, { trade, businessName: name, postcodes: ['21000'] });
    if (!r.ok) throw new Error(r.code);
    const id = r.value.partnerId;
    const kinds = { courtier: ['immatriculation_orias'], geometre: ['inscription_ordre'], avocat: ['inscription_ordre'], expert_comptable: ['inscription_ordre'], gestionnaire: ['carte_g'] }[trade] ?? [];
    for (const kind of ['assurance_rcp', ...kinds]) await annuaire.addCredential(dir, id, { kind, number: 'N-1', validFrom: day(-30), validUntil: day(until), proofRef: files.put(`partenaires/${id}`) });
    if (trade === 'diagnostiqueur') await annuaire.addCredential(dir, id, { kind: 'certification_diagnostic', domain: 'amiante', number: 'C-1', validFrom: day(-30), validUntil: day(until), proofRef: files.put(`partenaires/${id}`) });
    return id;
  };
  /** Une mise en relation proposée, acceptée par le client et confiée au partenaire. */
  const entrusted = async (partnerId: string, trade: string, confide = true): Promise<string> => {
    const r = await relations.propose(agent, { projectId: project.id, trade, domain: trade === 'diagnostiqueur' ? 'amiante' : undefined, propertyId: property.id });
    if (!r.ok) throw new Error(r.code);
    const id = r.value.referralId;
    const c = await relations.recordConsent(agent, id, { partnerId, consentAt: new Date(clock - 500).toISOString(), channel: 'ecrit', proofRef: files.put(`relations/${id}`) });
    if (!c.ok) throw new Error(c.code);
    if (confide) await relations.entrust(agent, id);
    return id;
  };
  const as = (partnerId: string, networkId = network.id) => ({ role: 'partner' as const, userId: partnerId, networkId });
  return { db, journal, store, relations, space, network, other, agent, dir, partner, entrusted, as };
}

describeWithSqlite('U04 · espace partenaire', () => {
  it('[R77] chaque métier reçoit exactement les champs de son dossier utile, ni plus ni moins', async () => {
    const t = await setup();
    for (const { trade } of PARTNER_TRADES) {
      const id = await t.partner(trade, `Partenaire ${trade}`);
      const ref = await t.entrusted(id, trade);
      const r = await t.space.read(t.as(id), ref);
      expect(r.ok, trade).toBe(true);
      if (!r.ok) continue;
      expect(Object.keys(r.value.file).sort(), trade).toEqual([...PARTNER_FIELDS[trade]].sort());
      const text = JSON.stringify(r.value);
      for (const secret of ['Note privée', 'calme', 'camille@example.test']) expect(text, trade).not.toContain(secret);
      if (!PARTNER_FIELDS[trade].includes('clientLastName')) expect(text, trade).not.toContain('Exemple');
    }
  });

  it('[R77] un diagnostiqueur reçoit le bien et le domaine, un courtier le projet et le nom, un notaire le prix et les parties', async () => {
    const t = await setup();
    const d = await t.partner('diagnostiqueur', 'Diag A');
    const c = await t.partner('courtier', 'Courtage B');
    const nt = await t.partner('notaire', 'Étude C');
    const rd = await t.space.read(t.as(d), await t.entrusted(d, 'diagnostiqueur'));
    expect(rd.ok && rd.value.file).toEqual({ domain: 'amiante', postcode: '21000', city: 'Dijon', propertyKind: 'home', surfaceM2: 82, rooms: 4 });
    const rc = await t.space.read(t.as(c), await t.entrusted(c, 'courtier'));
    expect(rc.ok && rc.value.file).toEqual({ clientFirstName: 'Camille', clientLastName: 'Exemple', projectKind: 'sell', budgetMinEur: 180000, budgetMaxEur: 210000, deadline: null, postcode: '21000' });
    const rn = await t.space.read(t.as(nt), await t.entrusted(nt, 'notaire'));
    expect(rn.ok && rn.value.file).toMatchObject({ priceEur: 230000, clientFirstName: 'Camille', clientLastName: 'Exemple', saleAmountEur: null });
  });

  it('[R77] [R16] un partenaire ne lit jamais une mise en relation qui ne lui est pas confiée', async () => {
    const t = await setup();
    const a = await t.partner('artisan', 'Artisan A');
    const b = await t.partner('artisan', 'Artisan B');
    const ref = await t.entrusted(a, 'artisan');
    expect(await t.space.read(t.as(b), ref)).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(await t.space.read(t.as(a, t.other.id), ref)).toEqual({ ok: false, rule: 'R16', code: 'unknown' });
    expect(await t.space.read(t.agent, ref)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.space.read(t.as(a), 'inconnu')).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    const lb = await t.space.list(t.as(b));
    expect(lb.ok && lb.value).toEqual([]);
    const la = await t.space.list(t.as(a));
    expect(la.ok && la.value).toEqual([{ referralId: ref, trade: 'artisan', state: 'confiee' }]);
  });

  it('[R77] l’accord du client ne suffit pas : rien n’est lisible avant que la mise en relation soit confiée', async () => {
    const t = await setup();
    const a = await t.partner('photographe', 'Studio A');
    const ref = await t.entrusted(a, 'photographe', false);
    expect(await t.space.read(t.as(a), ref)).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    const l = await t.space.list(t.as(a));
    expect(l.ok && l.value).toEqual([]);
  });

  it('[R77] une mise en relation close reste lisible 30 jours, puis plus jamais', async () => {
    const t = await setup();
    const a = await t.partner('geometre', 'Géomètre A', 900);
    const ref = await t.entrusted(a, 'geometre');
    expect(await t.space.progress(t.as(a), ref, 'en_cours')).toEqual({ ok: true, value: 'en_cours' });
    expect(await t.space.progress(t.as(a), ref, 'terminee')).toEqual({ ok: true, value: 'terminee' });
    expect(CLOSED_ACCESS_DAYS).toBe(30);
    clock += 29 * DAY;
    expect((await t.space.read(t.as(a), ref)).ok).toBe(true);
    clock += 2 * DAY;
    expect(await t.space.read(t.as(a), ref)).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(await t.space.progress(t.as(a), ref, 'en_cours')).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
  });

  it('[R73] un partenaire dont un justificatif est échu est refusé', async () => {
    const t = await setup();
    const a = await t.partner('demenageur', 'Déménageur A', 3);
    const ref = await t.entrusted(a, 'demenageur');
    expect((await t.space.read(t.as(a), ref)).ok).toBe(true);
    clock += 5 * DAY;
    expect(await t.space.read(t.as(a), ref)).toEqual({ ok: false, rule: 'R73', code: 'credentials' });
    expect(await t.space.list(t.as(a))).toEqual({ ok: false, rule: 'R73', code: 'credentials' });
  });

  it('[R13] chaque lecture et chaque refus au journal, sans nom ni donnée du dossier', async () => {
    const t = await setup();
    const c = await t.partner('courtier', 'Courtage Unique');
    const ref = await t.entrusted(c, 'courtier');
    await t.space.read(t.as(c), ref);
    await t.space.read(t.as(c), 'autre');
    const rows = await t.db.all<{ type: string; data: string }>("SELECT type, data FROM journal WHERE type IN ('espace_partenaire.lu', 'acces.refuse') ORDER BY seq");
    expect(rows.map((r) => r.type)).toEqual(['espace_partenaire.lu', 'acces.refuse']);
    expect(JSON.parse(rows[0]!.data)).toMatchObject({ rule: 'R77', fields: [...PARTNER_FIELDS.courtier].sort() });
    const all = JSON.stringify(await t.db.all('SELECT * FROM journal'));
    for (const secret of ['Camille', 'Exemple', '180000', 'Courtage Unique']) expect(all).not.toContain(secret);
  });

  it('le partenaire avance seulement dans l’ordre des étapes', async () => {
    const t = await setup();
    const a = await t.partner('artisan', 'Artisan A');
    const ref = await t.entrusted(a, 'artisan');
    expect(await t.space.progress(t.as(a), ref, 'confiee')).toMatchObject({ code: 'bad_state' });
    expect(await t.space.progress(t.as(a), ref, 'terminee')).toEqual({ ok: true, value: 'terminee' });
    expect(await t.space.progress(t.as(a), ref, 'en_cours')).toMatchObject({ code: 'bad_state' });
    const r = await t.relations.get(t.agent, ref);
    expect(r.ok && r.value.state).toBe('terminee');
  });
});
