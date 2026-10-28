import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, verifyChain, type SqlDatabase } from '../src/index.ts';
import { Annuaire, MAX_SHOWN, MiseEnRelation, drawOrder, type ConsentProofStore, type PartnerProofStore } from '../src/partenaires/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, agents, clients, partenaires et preuves inventés.
let clock = Date.parse('2027-07-12T08:00:00.000Z');
const DAY = 86_400_000;
let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

class FakeStore implements PartnerProofStore, ConsentProofStore {
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

async function setup(seeds: number[] = [7]) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const files = new FakeStore();
  const annuaire = new Annuaire(db, files, journal, { now, newId: uuid });
  let s = 0;
  const relations = new MiseEnRelation(db, annuaire, files, journal, { now, newId: uuid, newSeed: () => seeds[s++ % seeds.length]! });
  const network = await store.createNetwork('Réseau test');
  const other = await store.createNetwork('Autre réseau');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Essai' });
  const bea = await store.createAgent({ networkId: network.id, firstName: 'Béa', lastName: 'Essai' });
  const person = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Client', lastName: 'Inventé' });
  const project = await store.createProject({ networkId: network.id, agentId: alex.id, personId: person.id, kind: 'sell' });
  const property = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'T-1', kind: 'home', postalCode: '21000' });
  await store.linkProjectProperty({ networkId: network.id, agentId: alex.id, projectId: project.id, propertyId: property.id, role: 'owned' });
  const dir = { role: 'direction' as const, userId: 'dir-1', networkId: network.id };
  const agent = { role: 'agent' as const, userId: alex.id, networkId: network.id };
  const day = (d = 0): string => new Date(clock + d * DAY).toISOString().slice(0, 10);
  const partner = async (trade: string, name: string, opts: { until?: number; postcodes?: string[]; domain?: string } = {}): Promise<string> => {
    const r = await annuaire.addPartner(dir, { trade, businessName: name, postcodes: opts.postcodes ?? ['21000'] });
    if (!r.ok) throw new Error(r.code);
    const id = r.value.partnerId;
    const kinds = trade === 'courtier' ? ['assurance_rcp', 'immatriculation_orias'] : ['assurance_rcp'];
    for (const kind of kinds) await annuaire.addCredential(dir, id, { kind, number: 'N-1', validFrom: day(-30), validUntil: day(opts.until ?? 300), proofRef: files.put(`partenaires/${id}`) });
    if (opts.domain) await annuaire.addCredential(dir, id, { kind: 'certification_diagnostic', domain: opts.domain, number: 'C-1', validFrom: day(-30), validUntil: day(300), proofRef: files.put(`partenaires/${id}`) });
    return id;
  };
  const consent = (referralId: string, partnerId: string, extra: Record<string, unknown> = {}) => ({
    partnerId,
    consentAt: new Date(clock - 500).toISOString(),
    channel: 'oral',
    proofRef: files.put(`relations/${referralId}`),
    ...extra,
  });
  return { db, journal, store, files, annuaire, relations, network, other, alex, bea, person, project, property, dir, agent, day, partner, consent };
}

describeWithSqlite('U02 · mise en relation', () => {
  it('[R75] au moins 2 partenaires montrés quand la zone en compte plusieurs, au plus 3, dans un ordre tiré au sort et rejouable', async () => {
    const t = await setup([12345]);
    const ids: string[] = [];
    for (const name of ['Étude A', 'Étude B', 'Étude C', 'Étude D', 'Étude E']) ids.push(await t.partner('notaire', name));
    await t.partner('notaire', 'Étude échue', { until: -1 });
    const r = await t.relations.propose(t.agent, { projectId: t.project.id, trade: 'notaire', propertyId: t.property.id });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(MAX_SHOWN).toBe(3);
    expect(r.value.shown).toHaveLength(3);
    expect(r.value).toMatchObject({ state: 'proposee', chosenPartnerId: null, postcode: '21000', seed: 12345 });
    // Rejouable : la graine redonne exactement le même ordre, tiré parmi les seuls proposables.
    expect(r.value.shown.map((p) => p.partnerId)).toEqual(drawOrder(12345, ids).slice(0, 3));
    expect(r.value.shown.every((p) => ids.includes(p.partnerId))).toBe(true);
    expect(JSON.stringify(r.value)).not.toMatch(/score|note|rank|rating|avis/i);
    // Deux partenaires seulement : les deux sont montrés.
    const t2 = await setup();
    await t2.partner('artisan', 'Artisan 1');
    await t2.partner('artisan', 'Artisan 2');
    const r2 = await t2.relations.propose(t2.agent, { projectId: t2.project.id, trade: 'artisan', postcode: '21000' });
    expect(r2.ok && r2.value.shown).toHaveLength(2);
  });

  it('[R75] le tirage ne dépend que de la graine, jamais de l’ordre de rangement, et chaque partenaire peut sortir premier', () => {
    const ids = ['p-a', 'p-b', 'p-c', 'p-d'];
    expect(drawOrder(99, ids)).toEqual(drawOrder(99, [...ids].reverse()));
    const firsts = new Set<string>();
    for (let seed = 0; seed < 200; seed++) firsts.add(drawOrder(seed, ids)[0]!);
    expect([...firsts].sort()).toEqual(ids);
    expect(drawOrder(5, ['seul'])).toEqual(['seul']);
  });

  it('[R74] rien n’est confié sans l’accord du client, rangé avec sa date, son canal et sa preuve', async () => {
    const t = await setup();
    const a = await t.partner('notaire', 'Étude A');
    const r = await t.relations.propose(t.agent, { projectId: t.project.id, trade: 'notaire', postcode: '21000' });
    if (!r.ok) throw new Error(r.code);
    const id = r.value.referralId;
    expect(await t.relations.entrust(t.agent, id)).toEqual({ ok: false, rule: 'R74', code: 'no_consent' });
    expect(await t.relations.recordConsent(t.agent, id, t.consent(id, a, { proofRef: undefined }))).toMatchObject({ rule: 'R74', code: 'bad_proof' });
    expect(await t.relations.recordConsent(t.agent, id, t.consent(id, a, { proofRef: `relations/${id}/${uuid()}.pdf` }))).toMatchObject({ rule: 'R74', code: 'not_stored' });
    expect(await t.relations.recordConsent(t.agent, id, t.consent(id, a, { channel: 'pigeon' }))).toMatchObject({ rule: 'R74', code: 'bad_channel' });
    expect(await t.relations.recordConsent(t.agent, id, t.consent(id, a, { consentAt: new Date(clock + DAY).toISOString() }))).toMatchObject({ rule: 'R74', code: 'bad_consent_date' });
    expect(await t.relations.recordConsent(t.agent, id, t.consent(id, a, { consentAt: new Date(clock - 10 * DAY).toISOString() }))).toMatchObject({ rule: 'R74', code: 'bad_consent_date' });
    expect(await t.db.all('SELECT * FROM partner_referral_steps')).toHaveLength(0);
    const c = await t.relations.recordConsent(t.agent, id, t.consent(id, a));
    expect(c.ok && c.value).toMatchObject({ state: 'accord_client', chosenPartnerId: a, consent: { channel: 'oral' } });
    const e = await t.relations.entrust(t.agent, id);
    expect(e.ok && e.value.state).toBe('confiee');
    expect(await t.relations.entrusted(t.network.id, id)).toEqual({ partnerId: a, state: 'confiee' });
  });

  it('[R75] le client choisit parmi les partenaires montrés ; personne d’autre ne peut être choisi, et rien ne choisit seul', async () => {
    const t = await setup([1]);
    for (const name of ['A', 'B', 'C', 'D']) await t.partner('artisan', `Artisan ${name}`);
    const r = await t.relations.propose(t.agent, { projectId: t.project.id, trade: 'artisan', postcode: '21000' });
    if (!r.ok) throw new Error(r.code);
    const shown = r.value.shown.map((p) => p.partnerId);
    const hidden = (await t.db.all<{ id: string }>('SELECT id FROM partners')).map((p) => p.id).find((id) => !shown.includes(id))!;
    expect(r.value.chosenPartnerId).toBeNull();
    expect(await t.relations.recordConsent(t.agent, r.value.referralId, t.consent(r.value.referralId, hidden))).toEqual({ ok: false, rule: 'R75', code: 'not_shown' });
    // Le client prend le dernier montré : c'est lui qui est retenu, pas le premier du tirage.
    const c = await t.relations.recordConsent(t.agent, r.value.referralId, t.consent(r.value.referralId, shown.at(-1)!));
    expect(c.ok && c.value.chosenPartnerId).toBe(shown.at(-1));
    // Un deuxième accord sur la même mise en relation est refusé.
    expect(await t.relations.recordConsent(t.agent, r.value.referralId, t.consent(r.value.referralId, shown[0]!))).toMatchObject({ code: 'bad_state' });
  });

  it('[R73] aucun partenaire proposable : pas de mise en relation ; un partenaire devenu indisponible ne peut plus être confié', async () => {
    const t = await setup();
    expect(await t.relations.propose(t.agent, { projectId: t.project.id, trade: 'geometre', postcode: '21000' })).toEqual({ ok: false, rule: 'R73', code: 'no_partner' });
    const a = await t.partner('demenageur', 'Déménageur Bref', { until: 3 });
    const r = await t.relations.propose(t.agent, { projectId: t.project.id, trade: 'demenageur', postcode: '21000' });
    if (!r.ok) throw new Error(r.code);
    const id = r.value.referralId;
    expect((await t.relations.recordConsent(t.agent, id, t.consent(id, a))).ok).toBe(true);
    clock += 5 * DAY;
    expect(await t.relations.entrust(t.agent, id)).toEqual({ ok: false, rule: 'R73', code: 'partner_unavailable' });
  });

  it('[R73] un diagnostiqueur n’est montré que pour le domaine demandé, et la zone vient du bien du projet', async () => {
    const t = await setup();
    const amiante = await t.partner('diagnostiqueur', 'Diag Amiante', { domain: 'amiante' });
    await t.partner('diagnostiqueur', 'Diag Plomb', { domain: 'plomb' });
    await t.partner('diagnostiqueur', 'Diag Beaune', { domain: 'amiante', postcodes: ['21200'] });
    const r = await t.relations.propose(t.agent, { projectId: t.project.id, trade: 'diagnostiqueur', domain: 'amiante', propertyId: t.property.id, postcode: '21200' });
    expect(r.ok && r.value.shown.map((p) => p.partnerId)).toEqual([amiante]);
    expect(await t.relations.propose(t.agent, { projectId: t.project.id, trade: 'diagnostiqueur', postcode: '21000' })).toMatchObject({ code: 'domain_required' });
  });

  it('[R16] seuls l’agent du projet et la direction agissent ; un bien d’un autre projet est refusé', async () => {
    const t = await setup();
    const a = await t.partner('notaire', 'Étude A');
    const bea = { role: 'agent' as const, userId: t.bea.id, networkId: t.network.id };
    const partner = { role: 'partner' as const, userId: a, networkId: t.network.id };
    const compliance = { role: 'compliance' as const, userId: 'c-1', networkId: t.network.id };
    const stranger = { role: 'direction' as const, userId: 'd-x', networkId: t.other.id };
    const input = { projectId: t.project.id, trade: 'notaire', postcode: '21000' };
    expect(await t.relations.propose(bea, input)).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(await t.relations.propose(partner, input)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.relations.propose(compliance, input)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.relations.propose(stranger, input)).toEqual({ ok: false, rule: 'R16', code: 'unknown' });
    const r = await t.relations.propose(t.dir, input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(await t.relations.get(bea, r.value.referralId)).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    const otherProperty = await t.store.createProperty({ networkId: t.network.id, agentId: t.bea.id, reference: 'T-2', kind: 'home', postalCode: '21000' });
    expect(await t.relations.propose(t.agent, { ...input, propertyId: otherProperty.id })).toEqual({ ok: false, rule: null, code: 'bad_property' });
    expect((await t.db.all("SELECT seq FROM journal WHERE type = 'acces.refuse'")).length).toBe(5);
  });

  it('[R13] chaque étape au journal, sans nom ; [R17] rien ne s’efface, une mise en relation abandonnée reste', async () => {
    const t = await setup();
    const a = await t.partner('photographe', 'Studio Nommé');
    const r = await t.relations.propose(t.agent, { projectId: t.project.id, trade: 'photographe', postcode: '21000' });
    if (!r.ok) throw new Error(r.code);
    const id = r.value.referralId;
    await t.relations.recordConsent(t.agent, id, t.consent(id, a));
    await t.relations.entrust(t.agent, id);
    expect(await t.relations.close(t.agent, id, 'abandonnee')).toMatchObject({ ok: true, value: { state: 'abandonnee' } });
    expect(await t.relations.close(t.agent, id, 'terminee')).toMatchObject({ code: 'bad_state' });
    const types = (await t.db.all<{ type: string }>("SELECT type FROM journal WHERE type LIKE 'mise_en_relation.%' ORDER BY seq")).map((e) => e.type);
    expect(types).toEqual(['mise_en_relation.proposee', 'mise_en_relation.accord_client', 'mise_en_relation.confiee', 'mise_en_relation.abandonnee']);
    const all = JSON.stringify(await t.db.all('SELECT * FROM journal'));
    expect(all).not.toContain('Studio');
    expect(all).not.toContain('Inventé');
    expect((await verifyChain(await t.journal.all())).ok).toBe(true);
    await expect(t.db.run('DELETE FROM partner_referrals')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run('DELETE FROM partner_referral_steps')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run('UPDATE partner_referral_options SET position = 9')).rejects.toThrow(/ne change plus/);
    expect(await t.relations.entrusted(t.network.id, id)).toEqual({ partnerId: a, state: 'abandonnee' });
  });

  it('une preuve d’accord ne sert qu’une fois', async () => {
    const t = await setup();
    const a = await t.partner('notaire', 'Étude A');
    const r1 = await t.relations.propose(t.agent, { projectId: t.project.id, trade: 'notaire', postcode: '21000' });
    if (!r1.ok) throw new Error(r1.code);
    const c = t.consent(r1.value.referralId, a);
    expect((await t.relations.recordConsent(t.agent, r1.value.referralId, c)).ok).toBe(true);
    const r2 = await t.relations.propose(t.agent, { projectId: t.project.id, trade: 'notaire', postcode: '21000' });
    if (!r2.ok) throw new Error(r2.code);
    // La preuve d'une autre mise en relation n'a pas le bon préfixe.
    expect(await t.relations.recordConsent(t.agent, r2.value.referralId, { ...c, consentAt: new Date(clock - 100).toISOString() })).toMatchObject({ code: 'bad_proof' });
  });
});
