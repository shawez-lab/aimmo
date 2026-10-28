import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { Annuaire, MiseEnRelation, Remunerations, type ConsentProofStore } from '../src/partenaires/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, agent, client, partenaires et montants inventés.
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

async function setup(brokerStatusValidated = false) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const files = new FakeStore();
  const annuaire = new Annuaire(db, files, journal, { now, newId: uuid });
  const relations = new MiseEnRelation(db, annuaire, files, journal, { now, newId: uuid, newSeed: () => 3 });
  const fees = new Remunerations(db, relations, journal, { now, newId: uuid, settings: { brokerStatusValidated } });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Essai' });
  const bea = await store.createAgent({ networkId: network.id, firstName: 'Béa', lastName: 'Essai' });
  const person = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Client', lastName: 'Inventé' });
  const project = await store.createProject({ networkId: network.id, agentId: alex.id, personId: person.id, kind: 'sell' });
  const dir = { role: 'direction' as const, userId: 'dir-1', networkId: network.id };
  const agent = { role: 'agent' as const, userId: alex.id, networkId: network.id };
  const day = (d = 0): string => new Date(clock + d * DAY).toISOString().slice(0, 10);
  const partner = async (trade: string, name: string, domain?: string): Promise<string> => {
    const r = await annuaire.addPartner(dir, { trade, businessName: name, postcodes: ['21000'] });
    if (!r.ok) throw new Error(r.code);
    const id = r.value.partnerId;
    const kinds = trade === 'courtier' ? ['assurance_rcp', 'immatriculation_orias'] : ['assurance_rcp'];
    for (const kind of kinds) await annuaire.addCredential(dir, id, { kind, number: 'N-1', validFrom: day(-30), validUntil: day(300), proofRef: files.put(`partenaires/${id}`) });
    if (domain) await annuaire.addCredential(dir, id, { kind: 'certification_diagnostic', domain, number: 'C-1', validFrom: day(-30), validUntil: day(300), proofRef: files.put(`partenaires/${id}`) });
    return id;
  };
  const propose = async (trade: string, domain?: string) => {
    const r = await relations.propose(agent, { projectId: project.id, trade, domain, postcode: '21000' });
    if (!r.ok) throw new Error(r.code);
    return r.value;
  };
  const consent = (referralId: string, partnerId: string) => ({ partnerId, consentAt: new Date(clock - 500).toISOString(), channel: 'ecrit', proofRef: files.put(`relations/${referralId}`) });
  return { db, journal, relations, fees, network, alex, bea, dir, agent, partner, propose, consent };
}

describeWithSqlite('U03 · rémunérations des partenaires', () => {
  it('[R76] toute rémunération venant d’un diagnostiqueur est refusée, sous toute forme, et le refus est au journal', async () => {
    const t = await setup(true);
    const d = await t.partner('diagnostiqueur', 'Diag Amiante', 'amiante');
    const r = await t.propose('diagnostiqueur', 'amiante');
    for (const kind of ['commission', 'remise', 'cadeau', 'prestation', 'autre']) {
      expect(await t.fees.declare(t.agent, r.referralId, { partnerId: d, kind, amountCents: 5000, payer: 'partenaire', payee: 'agent' })).toEqual({ ok: false, rule: 'R76', code: 'diagnostician_fee' });
    }
    expect(await t.db.all('SELECT id FROM partner_referral_fees')).toHaveLength(0);
    expect((await t.db.all("SELECT seq FROM journal WHERE type = 'remuneration.refusee'")).length).toBe(5);
  });

  it('[R76] un courtier ou une banque ne rémunère rien tant que le statut n’est pas validé par l’avocat', async () => {
    const t = await setup(false);
    const c = await t.partner('courtier', 'Courtage des Ducs');
    const r = await t.propose('courtier');
    expect(await t.fees.declare(t.agent, r.referralId, { partnerId: c, kind: 'commission', rateBp: 50, payer: 'partenaire', payee: 'reseau' })).toEqual({ ok: false, rule: 'R76', code: 'broker_status' });
    const a = await t.partner('artisan', 'Artisan Banque');
    const r2 = await t.propose('artisan');
    expect(await t.fees.declare(t.agent, r2.referralId, { partnerId: a, kind: 'commission', amountCents: 1000, payer: 'banque', payee: 'reseau' })).toEqual({ ok: false, rule: 'R76', code: 'broker_status' });
    // Le statut validé : la déclaration passe.
    const v = await setup(true);
    const c2 = await v.partner('courtier', 'Courtage Validé');
    const r3 = await v.propose('courtier');
    const ok = await v.fees.declare(v.agent, r3.referralId, { partnerId: c2, kind: 'commission', rateBp: 50, payer: 'partenaire', payee: 'reseau' });
    expect(ok.ok && ok.value).toHaveLength(1);
  });

  it('[R76] une rémunération déclarée est montrée au client avant son accord ; sans texte montré, l’accord est refusé', async () => {
    const t = await setup();
    const a = await t.partner('artisan', 'Menuiserie Nord');
    const b = await t.partner('artisan', 'Menuiserie Sud');
    const r = await t.propose('artisan');
    const d = await t.fees.declare(t.agent, r.referralId, { partnerId: a, kind: 'commission', amountCents: 15000, payer: 'partenaire', payee: 'reseau' });
    expect(d.ok).toBe(true);
    expect(await t.relations.recordConsent(t.agent, r.referralId, t.consent(r.referralId, b))).toEqual({ ok: false, rule: 'R76', code: 'fees_not_disclosed' });
    const shown = await t.fees.disclose(t.agent, r.referralId);
    expect(shown.ok).toBe(true);
    if (!shown.ok) return;
    expect(shown.value.text).toContain('Menuiserie Nord : si vous le choisissez, il verse au réseau une commission de 150,00 €.');
    expect(shown.value.text).toContain('Menuiserie Sud : aucune rémunération, ni au réseau ni à votre agent.');
    expect(shown.value.text).not.toMatch(/\bIA\b|intelligence artificielle|assistant/i);
    expect(shown.value.textSha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await t.relations.recordConsent(t.agent, r.referralId, t.consent(r.referralId, b))).ok).toBe(true);
  });

  it('[R76] une rémunération ajoutée après le texte montré exige de le montrer de nouveau', async () => {
    const t = await setup();
    const a = await t.partner('photographe', 'Studio Clair');
    const r = await t.propose('photographe');
    await t.fees.declare(t.agent, r.referralId, { partnerId: a, kind: 'remise', rateBp: 1000, payer: 'partenaire', payee: 'agent' });
    await t.fees.disclose(t.agent, r.referralId);
    await t.fees.declare(t.agent, r.referralId, { partnerId: a, kind: 'cadeau', amountCents: 2000, payer: 'partenaire', payee: 'agent' });
    expect(await t.relations.recordConsent(t.agent, r.referralId, t.consent(r.referralId, a))).toMatchObject({ rule: 'R76', code: 'fees_not_disclosed' });
    const again = await t.fees.disclose(t.agent, r.referralId);
    expect(again.ok && again.value.text).toContain('Studio Clair : si vous le choisissez, il verse à votre agent une remise de 10 % du montant de sa prestation ; il verse à votre agent un cadeau de 20,00 €.');
    expect((await t.relations.recordConsent(t.agent, r.referralId, t.consent(r.referralId, a))).ok).toBe(true);
  });

  it('[R76] après l’accord du client, plus aucune rémunération ne s’ajoute : il faut un nouvel accord', async () => {
    const t = await setup();
    const a = await t.partner('demenageur', 'Déménagements Express');
    const r = await t.propose('demenageur');
    expect((await t.relations.recordConsent(t.agent, r.referralId, t.consent(r.referralId, a))).ok).toBe(true);
    expect(await t.fees.declare(t.agent, r.referralId, { partnerId: a, kind: 'commission', amountCents: 1000, payer: 'partenaire', payee: 'reseau' })).toEqual({ ok: false, rule: 'R76', code: 'new_consent_required' });
    expect(await t.fees.disclose(t.agent, r.referralId)).toMatchObject({ code: 'bad_state' });
  });

  it('[R76] sans aucune rémunération, le texte le dit, et l’accord n’attend rien', async () => {
    const t = await setup();
    await t.partner('notaire', 'Étude A');
    const b = await t.partner('notaire', 'Étude B');
    const r = await t.propose('notaire');
    const s = await t.fees.disclose(t.agent, r.referralId);
    expect(s.ok && s.value.text.split('\n')[0]).toBe('Aucun des professionnels proposés ne rémunère le réseau ni votre agent.');
    expect((await t.relations.recordConsent(t.agent, r.referralId, t.consent(r.referralId, b))).ok).toBe(true);
  });

  it('[R75] [R16] seul un partenaire montré, et seuls l’agent du projet ou la direction ; entrées mal formées refusées', async () => {
    const t = await setup();
    const a = await t.partner('artisan', 'Artisan A');
    const r = await t.propose('artisan');
    const other = await t.partner('artisan', 'Artisan Hors Tirage');
    const bea = { role: 'agent' as const, userId: t.bea.id, networkId: t.network.id };
    const base = { partnerId: a, kind: 'commission', amountCents: 1000, payer: 'partenaire', payee: 'reseau' };
    expect(await t.fees.declare(t.agent, r.referralId, { ...base, partnerId: other })).toMatchObject({ rule: 'R75', code: 'not_shown' });
    expect(await t.fees.declare(bea, r.referralId, base)).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(await t.fees.declare(t.agent, r.referralId, { ...base, amountCents: 0 })).toMatchObject({ code: 'bad_amount' });
    expect(await t.fees.declare(t.agent, r.referralId, { ...base, rateBp: 10 })).toMatchObject({ code: 'bad_amount' });
    expect(await t.fees.declare(t.agent, r.referralId, { ...base, amountCents: undefined })).toMatchObject({ code: 'bad_amount' });
    expect(await t.fees.declare(t.agent, r.referralId, { ...base, kind: 'pot-de-vin' })).toMatchObject({ code: 'bad_kind' });
    expect(await t.fees.declare(t.agent, r.referralId, { ...base, payee: 'client' })).toMatchObject({ code: 'bad_payee' });
    expect((await t.fees.declare(t.dir, r.referralId, base)).ok).toBe(true);
  });

  it('[R17] [R13] une rémunération déclarée ne change ni ne s’efface ; le journal ne porte aucun nom ni montant', async () => {
    const t = await setup();
    const a = await t.partner('artisan', 'Plomberie Unique');
    const r = await t.propose('artisan');
    await t.fees.declare(t.agent, r.referralId, { partnerId: a, kind: 'commission', amountCents: 98765, payer: 'partenaire', payee: 'reseau' });
    await t.fees.disclose(t.agent, r.referralId);
    await expect(t.db.run('DELETE FROM partner_referral_fees')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run('UPDATE partner_referral_fees SET amount_cents = 1')).rejects.toThrow(/ne change plus/);
    await expect(t.db.run('DELETE FROM partner_referral_disclosures')).rejects.toThrow(/rien ne s'efface/);
    const all = JSON.stringify(await t.db.all('SELECT * FROM journal'));
    expect(all).not.toContain('Plomberie');
    expect(all).not.toContain('98765');
    expect(all).not.toContain('987,65');
  });
});
