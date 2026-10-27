import { expect, it } from 'vitest';
import { Acces, ControlesSignature, FicheClient, FicheUnique, Modeles, RegistreMandats, SignaturePapier, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Modèle, registre et personnes inventés pour les tests.
const BODY = 'Mandat de test : {{mandant.nom}}, {{bien.reference}}, honoraires {{honoraires.montant}} {{honoraires.charge}}, {{mandat.duree_mois}}.\n\n!! Clause de test mise en évidence.\n\nNuméro au registre : {{registre.numero}}. Signé le {{signature.date}}, {{signature.lieu}}.';
const NOW = new Date('2027-02-10T10:00:00.000Z');
const INPUTS = { 'honoraires.montant': 10000, 'honoraires.charge': 'vendeur', 'mandat.duree_mois': 12 } as const;
const PAPER = { signedAt: new Date('2027-02-10T09:00:00.000Z'), place: 'hors_agence' as const, scanRef: 'scans/2027/02/test-1.pdf', source: 'referral' };

async function setup() {
  const raw = openMemoryDatabase();
  const db: SqlDatabase = fromSyncSqlite(raw);
  await applyMigrations(db, loadMigrations());
  const now = () => NOW;
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const acces = new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now });
  const modeles = new Modeles(db, acces, journal, { now });
  const controles = new ControlesSignature(db, acces, journal, { now });
  const registre = new RegistreMandats(db, journal, { now });
  const papier = new SignaturePapier(db, acces, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const as = (role: string, userId: string): Viewer => ({ role, userId, networkId: network.id }) as Viewer;
  const agent = as('agent', alex.id);
  const direction = as('direction', 'direction-1');
  const v = await modeles.createVersion(direction, 'mandat_vente_exclusif', BODY);
  if (!v.ok) throw new Error(v.code);
  await modeles.validate(as('compliance', 'c-1'), v.template.id);
  await controles.setFeeSchedule(direction, { maxRatePercent: 5, minEur: 3000 });
  await registre.configure(direction, { prefix: 'T-', firstNumber: 101, width: 4 });
  let n = 0;
  const mandateDoc = async (identity = true) => {
    n += 1;
    const p = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Léa', lastName: `Exemple${n}` });
    const b = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: `REF-T-${n}`, kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 60, rooms: 3, priceEur: 200000 });
    const project = await store.createProject({ networkId: network.id, agentId: alex.id, personId: p.id, kind: 'sell' });
    await store.linkProjectProperty({ networkId: network.id, agentId: alex.id, projectId: project.id, propertyId: b.id, role: 'owned' });
    if (identity) await controles.recordIdentity(agent, p.id, { piece: 'carte_identite', seenAt: NOW });
    const d = await modeles.generate(agent, { kind: 'mandat_vente_exclusif', personId: p.id, propertyId: b.id, inputs: INPUTS });
    if (!d.ok) throw new Error(d.code);
    return { documentId: d.document.id, content: d.document.content, personId: p.id };
  };
  return { raw, db, journal, store, acces, modeles, registre, papier, network, alex, sam, as, agent, direction, mandateDoc };
}

describeWithSqlite('D04 · mandat signé sur papier, numéroté au registre', () => {
  it('[R39] le mandat contrôlé reçoit son numéro, et le numéro figure sur l’exemplaire du mandant', async () => {
    const t = await setup();
    const d = await t.mandateDoc();
    const r = await t.papier.register(t.agent, d.documentId, PAPER);
    expect(r).toMatchObject({ ok: true, value: { documentId: d.documentId, number: 'T-0101', place: 'hors_agence', signedAt: PAPER.signedAt.toISOString() } });
    const copy = await t.papier.copy(t.agent, d.documentId);
    expect(copy.ok && copy.number).toBe('T-0101');
    // L'exemplaire est le document généré, au caractère près, avec le numéro, la date et le lieu de signature.
    const expected = d.content
      .replace('<span class="a-signer">[numéro au registre à la signature]</span>', '<span class="signe">T-0101</span>')
      .replace('<span class="a-signer">[date de signature à la signature]</span>', '<span class="signe">10/02/2027</span>')
      .replace('<span class="a-signer">[lieu de signature à la signature]</span>', '<span class="signe">hors de l’agence</span>');
    expect(copy.ok && copy.content).toBe(expected);
    expect(copy.ok && copy.content).toContain('Numéro au registre : <span class="signe">T-0101</span>');
    // Le mandat est signé avec sa source, inscrit, et le registre est intègre.
    const mandate = await t.db.first<{ source_kind: string }>('SELECT source_kind FROM mandates WHERE id = ?', [r.ok ? r.value.mandateId : '']);
    expect(mandate?.source_kind).toBe('referral');
    expect(await t.registre.check(t.network.id)).toEqual({ ok: true, lines: 1 });
  });

  it('[R41, R39] un mandat qui échoue aux contrôles n’est pas numéroté, ni rangé', async () => {
    const t = await setup();
    const d = await t.mandateDoc(false);
    const r = await t.papier.register(t.agent, d.documentId, PAPER);
    expect(r).toMatchObject({ ok: false, rule: 'R41', code: 'checks_failed' });
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM mandates')).toEqual({ n: 0 });
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM mandate_register')).toEqual({ n: 0 });
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM signed_documents')).toEqual({ n: 0 });
  });

  it('[R39] un même document ne reçoit jamais deux numéros, même redemandé ou demandé deux fois à la fois', async () => {
    const t = await setup();
    const d = await t.mandateDoc();
    const [a, b] = await Promise.all([t.papier.register(t.agent, d.documentId, PAPER), t.papier.register(t.agent, d.documentId, PAPER)]);
    const numbers = [a, b].filter((r) => r.ok).map((r) => (r.ok ? r.value.number : ''));
    expect(new Set(numbers).size).toBeLessThanOrEqual(1);
    expect(await t.papier.register(t.agent, d.documentId, PAPER)).toEqual({ ok: false, rule: null, code: 'already_signed' });
    expect(await t.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM mandate_register WHERE kind = 'inscription'`)).toEqual({ n: 1 });
    const other = await t.mandateDoc();
    const r = await t.papier.register(t.agent, other.documentId, PAPER);
    expect(r.ok && r.value.number).toBe('T-0102');
  });

  it('[R39] une coupure après le mandat reprend là où elle s’était arrêtée, sans second mandat ni second numéro', async () => {
    const t = await setup();
    const d = await t.mandateDoc();
    let cut = true;
    const flaky: SqlDatabase = {
      ...t.db,
      run: async (sql, params) => {
        if (cut && sql.startsWith('UPDATE signed_documents SET number')) {
          cut = false;
          throw new Error('coupure');
        }
        return t.db.run(sql, params);
      },
    };
    await expect(new SignaturePapier(flaky, t.acces, t.journal, { now: () => NOW }).register(t.agent, d.documentId, PAPER)).rejects.toThrow(/coupure/);
    const r = await t.papier.register(t.agent, d.documentId, { ...PAPER, place: 'agence' });
    // La reprise garde le lieu de la première demande.
    expect(r).toMatchObject({ ok: true, value: { number: 'T-0101', place: 'hors_agence' } });
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM mandates')).toEqual({ n: 1 });
    await expect(t.db.run('UPDATE signed_documents SET number = ? WHERE document_id = ?', ['T-9999', d.documentId])).rejects.toThrow(/signature figée/);
    await expect(t.db.run('DELETE FROM signed_documents')).rejects.toThrow(/signature gardée/);
  });

  it('[R16] signature et exemplaire refusés à un autre agent ; saisies mal formées refusées ; un mandat de vente sans champ de numéro est refusé', async () => {
    const t = await setup();
    const d = await t.mandateDoc();
    expect(await t.papier.register(t.as('agent', t.sam.id), d.documentId, PAPER)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.papier.register(t.as('compliance', 'c-1'), d.documentId, PAPER)).toMatchObject({ ok: false, rule: 'R16' });
    for (const bad of [{ ...PAPER, place: 'cafe' }, { ...PAPER, scanRef: '../secret' }, { ...PAPER, scanRef: '' }, { ...PAPER, signedAt: new Date('2027-03-01T00:00:00Z') }]) {
      expect((await t.papier.register(t.agent, d.documentId, bad as never)).ok).toBe(false);
    }
    await t.papier.register(t.agent, d.documentId, PAPER);
    expect(await t.papier.copy(t.as('agent', t.sam.id), d.documentId)).toMatchObject({ ok: false, rule: 'R16' });
    expect((await t.papier.copy(t.direction, d.documentId)).ok).toBe(true);
    expect(await t.modeles.createVersion(t.direction, 'mandat_vente_simple', 'Mandat sans numéro : {{mandant.nom}}.')).toEqual({ ok: false, rule: 'R40', code: 'no_number_field' });
    expect(JSON.stringify(await t.journal.all())).not.toMatch(/Léa|Exemple/);
  });
});
