import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { Annuaire, EspacePartenaire, MiseEnRelation, PIECE_CREDENTIALS, PIECE_RULES, PiecesPartenaires, type ConsentProofStore } from '../src/partenaires/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// U06 · Jamais vu : une pièce jugée contre les justificatifs du jour où elle a été faite. Tout est inventé.
let clock = Date.parse('2027-07-12T08:00:00.000Z');
const DAY = 86_400_000;
let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const SHA = 'b'.repeat(64);

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

type Period = [from: number, until: number];

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
  const pieces = new PiecesPartenaires(db, space, relations, annuaire, files, journal, { now, newId: uuid });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Essai' });
  const seller = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Vendeur', lastName: 'Inventé' });
  const project = await store.createProject({ networkId: network.id, agentId: alex.id, personId: seller.id, kind: 'sell' });
  const property = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'T-1', kind: 'home', postalCode: '21000' });
  await store.linkProjectProperty({ networkId: network.id, agentId: alex.id, projectId: project.id, propertyId: property.id, role: 'owned' });
  const dir = { role: 'direction' as const, userId: 'dir-1', networkId: network.id };
  const agent = { role: 'agent' as const, userId: alex.id, networkId: network.id };
  const day = (d = 0): string => new Date(clock + d * DAY).toISOString().slice(0, 10);
  const cred = async (partnerId: string, kind: string, [from, until]: Period, domain?: string) => {
    const r = await annuaire.addCredential(dir, partnerId, { kind, domain, number: 'N-1', validFrom: day(from), validUntil: day(until), proofRef: files.put(`partenaires/${partnerId}`) });
    if (!r.ok) throw new Error(`${kind} : ${r.code}`);
  };
  /** Un partenaire et ses justificatifs, puis une demande confiée avec l'accord du client. */
  const request = async (trade: string, creds: [kind: string, period: Period, domain?: string][], domain?: string) => {
    const r0 = await annuaire.addPartner(dir, { trade, businessName: `Partenaire ${trade}`, postcodes: ['21000'] });
    if (!r0.ok) throw new Error(r0.code);
    const partnerId = r0.value.partnerId;
    for (const [kind, period, d] of creds) await cred(partnerId, kind, period, d);
    const r = await relations.propose(agent, { projectId: project.id, trade, domain, propertyId: property.id });
    if (!r.ok) throw new Error(r.code);
    const id = r.value.referralId;
    const c = await relations.recordConsent(agent, id, { partnerId, consentAt: new Date(clock - 500).toISOString(), channel: 'ecrit', proofRef: files.put(`relations/${id}`) });
    if (!c.ok) throw new Error(c.code);
    await relations.entrust(agent, id);
    const deposit = (sort: string, issuedDay: number) =>
      pieces.deposit({ role: 'partner', userId: partnerId, networkId: network.id }, id, { sort, ref: files.put(`partenaires/${partnerId}/relations/${id}`), sha256: SHA, issuedOn: day(issuedDay) });
    return { partnerId, referralId: id, deposit };
  };
  return { db, pieces, property, project, request };
}

const INSURED: [string, Period] = ['assurance_rcp', [-900, 300]];

describeWithSqlite('U06 · pièce contrôlée contre le justificatif du jour où elle a été faite (Jamais vu)', () => {
  it('[R73] [R78] un diagnostic fait quand la certification de son domaine était échue n’entre dans aucun dossier, raison dite', async () => {
    const t = await setup();
    // Certifié amiante jusqu'à J-100, puis de nouveau à partir de J-50 : il est proposable aujourd'hui.
    const d = await t.request('diagnostiqueur', [INSURED, ['certification_diagnostic', [-700, -100], 'amiante'], ['certification_diagnostic', [-50, 600], 'amiante']], 'amiante');
    const r = await d.deposit('amiante', -80);
    expect(r).toMatchObject({ ok: true, value: { destination: 'agent_queue', targetId: t.project.id, piece: null, reason: 'certification_not_valid_on_date' } });
    expect(await t.db.all("SELECT id FROM partner_documents WHERE destination IN ('property', 'sale_file')")).toHaveLength(0);
    const ev = await t.db.first<{ data: string }>("SELECT data FROM journal WHERE type = 'piece_partenaire.rangee' ORDER BY seq DESC LIMIT 1");
    expect(JSON.parse(ev!.data)).toMatchObject({ destination: 'agent_queue', reason: 'certification_not_valid_on_date' });
  });

  it('[R73] [R78] un diagnostic fait pendant la validité, puis déposé après l’échéance de cette certification, est accepté', async () => {
    const t = await setup();
    const d = await t.request('diagnostiqueur', [INSURED, ['certification_diagnostic', [-700, -10], 'dpe'], ['certification_diagnostic', [-9, 600], 'dpe']], 'dpe');
    expect(await d.deposit('dpe', -20)).toMatchObject({ ok: true, value: { destination: 'property', targetId: t.property.id, piece: 'dpe', reason: 'rule' } });
  });

  it('[R73] un diagnostic fait avant que le diagnostiqueur ne soit certifié pour ce domaine est refusé au rangement', async () => {
    const t = await setup();
    const d = await t.request('diagnostiqueur', [INSURED, ['certification_diagnostic', [-30, 600], 'plomb']], 'plomb');
    expect(await d.deposit('plomb', -60)).toMatchObject({ value: { destination: 'agent_queue', reason: 'certification_not_valid_on_date' } });
    expect(await d.deposit('plomb', -5)).toMatchObject({ value: { destination: 'property', reason: 'rule' } });
  });

  it('[R73] une pièce faite un jour sans assurance valide va à la file, quel que soit le métier', async () => {
    const t = await setup();
    const a = await t.request('artisan', [['assurance_rcp', [-900, -200]], ['assurance_rcp', [-100, 300]]]);
    expect(await a.deposit('devis', -150)).toMatchObject({ value: { destination: 'agent_queue', reason: 'insurance_not_valid_on_date' } });
    expect(await a.deposit('devis', -50)).toMatchObject({ value: { destination: 'referral', reason: 'rule' } });
  });

  it('[R73] un bornage d’un géomètre non inscrit à l’ordre ce jour-là va à la file', async () => {
    const t = await setup();
    const g = await t.request('geometre', [INSURED, ['inscription_ordre', [-20, 600]]]);
    expect(await g.deposit('bornage', -40)).toMatchObject({ value: { destination: 'agent_queue', reason: 'credential_not_valid_on_date' } });
    expect(await g.deposit('bornage', -10)).toMatchObject({ value: { destination: 'property', piece: 'bornage', reason: 'rule' } });
  });

  it('[R73] une version corrigée qui raccourcit la certification l’emporte pour juger la pièce', async () => {
    const t = await setup();
    // Saisie d'abord jusqu'à J+600, corrigée ensuite : elle finissait à J-40 ; renouvelée à partir de J-30.
    const d = await t.request(
      'diagnostiqueur',
      [INSURED, ['certification_diagnostic', [-700, 600], 'gaz'], ['certification_diagnostic', [-700, -40], 'gaz'], ['certification_diagnostic', [-30, 600], 'gaz']],
      'gaz',
    );
    expect(await d.deposit('gaz', -35)).toMatchObject({ value: { destination: 'agent_queue', reason: 'certification_not_valid_on_date' } });
    expect(await d.deposit('gaz', -45)).toMatchObject({ value: { destination: 'property', reason: 'rule' } });
  });

  it('la décision est rejouable à l’identique et chaque sorte contrôlée a sa règle de rangement', async () => {
    const t = await setup();
    const d = await t.request('diagnostiqueur', [INSURED, ['certification_diagnostic', [-700, -100], 'electricite'], ['certification_diagnostic', [-50, 600], 'electricite']], 'electricite');
    const first = await d.deposit('electricite', -80);
    const again = await d.deposit('electricite', -80);
    expect(first.ok && again.ok && [first.value.destination, first.value.reason]).toEqual(again.ok && [again.value.destination, again.value.reason]);
    for (const [sort, need] of Object.entries(PIECE_CREDENTIALS)) {
      expect(PIECE_RULES[sort], sort).toBeDefined();
      expect(need.trades.every((tr) => PIECE_RULES[sort]!.trades.includes(tr)), sort).toBe(true);
    }
  });
});
