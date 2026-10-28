import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { Acces, ControlesSignature, FicheClient, FicheUnique, Modeles, SqlJournalStore, applyMigrations, conformite, fromSyncSqlite, type SqlDatabase, type Viewer } from '../src/index.ts';
import { DossiersVente } from '../src/offres/index.ts';
import { setupDossier } from './dossiers-jeu.ts';
import { identiteAuCoffre } from './identite-coffre.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Personnes, sociétés et pièces inventées pour les tests.
const NOW = new Date('2027-03-10T10:00:00.000Z');
const BODY = 'Mandat de test : {{mandant.nom}}, {{bien.reference}}, {{bien.prix}}, honoraires {{honoraires.montant}} {{honoraires.charge}}, {{mandat.duree_mois}}.\n\n!! Clause de test mise en évidence.\n\nNuméro : {{registre.numero}}.';
const INPUTS = { 'honoraires.montant': 10000, 'honoraires.charge': 'vendeur', 'mandat.duree_mois': 12 };

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = NOW;
  const now = () => clock;
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const modeles = new Modeles(db, acces, journal, { now });
  const controles = new ControlesSignature(db, acces, journal, { now });
  const identification = new conformite.Identification(db, acces, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const as = (role: string, userId: string): Viewer => ({ role, userId, networkId: network.id }) as Viewer;
  const agent = as('agent', alex.id);
  const direction = as('direction', 'direction-1');
  const compliance = as('compliance', 'conformite-1');
  const v = await modeles.createVersion(direction, 'mandat_vente_exclusif', BODY);
  if (!v.ok) throw new Error(v.code);
  await modeles.validate(compliance, v.template.id);
  await controles.setFeeSchedule(direction, { maxRatePercent: 5, minEur: 3000 });
  let n = 0;
  /** Un vendeur (personne ou société), son bien et un mandat généré. */
  const seller = async (firstName = 'Léa') => {
    const p = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName, lastName: 'Exemple' });
    const b = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: `REF-L03-${++n}`, kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 60, rooms: 3, priceEur: 200000 });
    const project = await store.createProject({ networkId: network.id, agentId: alex.id, personId: p.id, kind: 'sell' });
    await store.linkProjectProperty({ networkId: network.id, agentId: alex.id, projectId: project.id, propertyId: b.id, role: 'owned' });
    const d = await modeles.generate(agent, { kind: 'mandat_vente_exclusif', personId: p.id, propertyId: b.id, inputs: INPUTS as never });
    if (!d.ok) throw new Error(d.code);
    return { personId: p.id, documentId: d.document.id };
  };
  const person = async (firstName: string) => (await store.createPerson({ networkId: network.id, agentId: alex.id, firstName, lastName: 'Associé' })).id;
  const deposit = (personId: string, input: { piece: string; seenAt: Date; validUntil?: string | null }, viewer = agent) => identiteAuCoffre({ db, acces, journal, now }, viewer, personId, input);
  const identityLine = async (documentId: string) => {
    const c = await controles.check(agent, documentId);
    if (!c.ok) throw new Error(c.code);
    return { passed: c.value.passed, code: c.value.lines.find((l) => l.check === 'identite')!.code };
  };
  return {
    db, journal, store, fiche, acces, controles, identification, network, agent, sam: as('agent', sam.id), direction, compliance, partner: as('partner', 'partenaire-1'),
    seller, person, deposit, identityLine, setClock: (d: Date) => { clock = d; },
  };
}

describeWithSqlite('L03 · identification et bénéficiaire effectif, étape bloquante', () => {
  it('[R92] un mandat sans pièce vérifiée au coffre est refusé, même avec la case « pièce vue » de D03 ; avec la pièce, il passe', async () => {
    const t = await setup();
    const s = await t.seller();
    expect(await t.identityLine(s.documentId)).toEqual({ passed: false, code: 'identity_missing' });
    // L'ancienne case cochée ne suffit plus.
    expect((await t.controles.recordIdentity(t.agent, s.personId, { piece: 'carte_identite', seenAt: NOW })).ok).toBe(true);
    expect(await t.identityLine(s.documentId)).toEqual({ passed: false, code: 'identity_missing' });
    await t.deposit(s.personId, { piece: 'carte_identite', seenAt: new Date('2027-03-09T10:00:00.000Z'), validUntil: '2031-01-01' });
    expect(await t.identityLine(s.documentId)).toEqual({ passed: true, code: 'identity_verified' });
  });

  it('[R92] une pièce échue ce jour-là bloque comme une pièce absente ; une pièce remplacée par une pièce valide passe', async () => {
    const t = await setup();
    const s = await t.seller();
    const old = await t.deposit(s.personId, { piece: 'passeport', seenAt: new Date('2027-01-05T10:00:00.000Z'), validUntil: '2027-03-09' });
    expect(old.ok).toBe(true);
    expect(await t.identityLine(s.documentId)).toEqual({ passed: false, code: 'identity_expired' });
    // Valide jusqu'à aujourd'hui inclus : elle passe encore.
    const s2 = await t.seller('Noé');
    await t.deposit(s2.personId, { piece: 'passeport', seenAt: new Date('2027-01-05T10:00:00.000Z'), validUntil: '2027-03-10' });
    expect(await t.identityLine(s2.documentId)).toEqual({ passed: true, code: 'identity_verified' });
    // Vérifiée il y a plus d'un an : plus d'identité vérifiée.
    const s3 = await t.seller('Inès');
    await t.deposit(s3.personId, { piece: 'carte_identite', seenAt: new Date('2026-03-01T10:00:00.000Z') });
    expect(await t.identityLine(s3.documentId)).toEqual({ passed: false, code: 'identity_missing' });
    // Une pièce valide remplacée par une pièce échue ne compte plus : la nouvelle seule fait foi.
    const s4 = await t.seller('Jade');
    const coffre = new conformite.CoffreConformite(t.db, t.acces, { put: async () => `coffre-test/${crypto.randomUUID()}` }, t.journal, { now: () => NOW });
    const first = await coffre.deposit(t.agent, s4.personId, { kind: 'carte_identite', content: new Uint8Array([1]), contentType: 'application/pdf', verifiedOn: '2027-03-01', validUntil: '2030-01-01' });
    if (!first.ok) throw new Error(first.code);
    expect(await t.identityLine(s4.documentId)).toEqual({ passed: true, code: 'identity_verified' });
    await coffre.deposit(t.agent, s4.personId, { kind: 'carte_identite', content: new Uint8Array([2]), contentType: 'application/pdf', verifiedOn: '2027-03-02', validUntil: '2027-03-05', replaces: first.receipt.pieceId });
    expect(await t.identityLine(s4.documentId)).toEqual({ passed: false, code: 'identity_expired' });
  });

  it('[R92] [R58] aucun compromis sans pièce valide de l’acquéreur au coffre ; une pièce échue bloque, puis une pièce valide le laisse passer', async () => {
    const t = await setupDossier();
    const dossiers = new DossiersVente(t.db, t.acces, t.journal, { now: t.now });
    const ctx = { db: t.db, acces: t.acces, journal: t.journal, now: t.now };
    expect(await dossiers.startCompromis(t.agent, t.fileId)).toEqual({ ok: false, rule: 'R58', code: 'identity_missing' });
    await identiteAuCoffre(ctx, t.agent, t.buyerId, { piece: 'passeport', seenAt: new Date('2027-02-01T10:00:00.000Z'), validUntil: '2027-02-28' });
    expect(await dossiers.startCompromis(t.agent, t.fileId)).toEqual({ ok: false, rule: 'R58', code: 'identity_expired' });
    const blocked = await t.journal.bySubject(`sale_file:${t.fileId}`);
    expect(blocked.map((e) => e.data)).toEqual([{ rule: 'R58', code: 'identity_missing' }, { rule: 'R58', code: 'identity_expired' }]);
    await identiteAuCoffre(ctx, t.agent, t.buyerId, { piece: 'carte_identite', seenAt: new Date('2027-03-01T10:00:00.000Z'), validUntil: '2032-01-01' });
    expect(await dossiers.startCompromis(t.agent, t.fileId)).toMatchObject({ ok: true, value: { steps: [{ step: 'compromis_en_preparation' }] } });
  });

  it('[R92] une société : refusée sans bénéficiaire effectif, sans Kbis, ou tant qu’un bénéficiaire effectif n’est pas identifié', async () => {
    const t = await setup();
    const company = await t.seller('SCI Exemple');
    const anna = await t.person('Anna');
    const bruno = await t.person('Bruno');
    expect(await t.identification.declare(t.agent, company.personId, { entity: 'societe', beneficialOwners: [] })).toEqual({ ok: false, rule: 'R92', code: 'beneficial_owners_missing' });
    expect(await t.identification.declare(t.agent, company.personId, { entity: 'societe' })).toEqual({ ok: false, rule: 'R92', code: 'beneficial_owners_missing' });
    expect(await t.identification.declare(t.agent, company.personId, { entity: 'societe', beneficialOwners: [{ personId: anna, sharePercent: 24 }] })).toEqual({ ok: false, rule: 'R92', code: 'share_below_threshold' });
    expect(await t.identification.declare(t.agent, company.personId, { entity: 'societe', beneficialOwners: [{ personId: company.personId, sharePercent: 50 }] })).toMatchObject({ ok: false, code: 'owner_is_company' });
    expect(await t.identification.declare(t.agent, company.personId, { entity: 'societe', beneficialOwners: [{ personId: anna, sharePercent: 30 }, { personId: anna, sharePercent: 30 }] })).toMatchObject({ ok: false, code: 'duplicate_owner' });
    expect(await t.identification.declare(t.agent, company.personId, { entity: 'societe', beneficialOwners: [{ personId: anna, sharePercent: 60 }, { personId: bruno, sharePercent: 50 }] })).toMatchObject({ ok: false, code: 'shares_above_100' });
    expect(await t.identification.declare(t.agent, company.personId, { entity: 'personne', beneficialOwners: [{ personId: anna, sharePercent: 60 }] })).toMatchObject({ ok: false, code: 'owners_for_person' });
    expect(await t.identification.declare(t.agent, company.personId, { entity: 'association' })).toMatchObject({ ok: false, code: 'bad_entity' });

    expect(await t.identification.declare(t.agent, company.personId, { entity: 'societe', beneficialOwners: [{ personId: anna, sharePercent: 60 }, { personId: bruno, sharePercent: 40 }] })).toMatchObject({ ok: true });
    expect(await t.identityLine(company.documentId)).toEqual({ passed: false, code: 'kbis_missing' });
    await t.deposit(company.personId, { piece: 'extrait_kbis', seenAt: new Date('2027-03-01T10:00:00.000Z') });
    expect(await t.identityLine(company.documentId)).toEqual({ passed: false, code: 'beneficial_owner_unidentified' });
    await t.deposit(anna, { piece: 'carte_identite', seenAt: new Date('2027-03-02T10:00:00.000Z') });
    expect(await t.identityLine(company.documentId)).toEqual({ passed: false, code: 'beneficial_owner_unidentified' });
    // Une pièce d'identité au nom de la société ne remplace pas celle d'un bénéficiaire effectif.
    await t.deposit(company.personId, { piece: 'passeport', seenAt: new Date('2027-03-02T10:00:00.000Z') });
    expect(await t.identityLine(company.documentId)).toEqual({ passed: false, code: 'beneficial_owner_unidentified' });
    await t.deposit(bruno, { piece: 'passeport', seenAt: new Date('2027-03-03T10:00:00.000Z'), validUntil: '2027-06-30' });
    expect(await t.identityLine(company.documentId)).toEqual({ passed: true, code: 'identity_verified' });
    // La plus ancienne date qui fonde l'identification est rendue.
    expect(await t.identification.status(t.network.id, company.personId, NOW)).toEqual({ ok: true, entity: 'societe', verifiedOn: '2027-03-01' });
    // Le passeport de Bruno échu : la société est de nouveau bloquée.
    t.setClock(new Date('2027-07-01T10:00:00.000Z'));
    expect(await t.identityLine(company.documentId)).toEqual({ passed: false, code: 'beneficial_owner_unidentified' });
  });

  it('[R92] la dernière déclaration compte ; une société jamais déclarée reste une personne sans pièce, donc bloquée', async () => {
    const t = await setup();
    const company = await t.seller('SARL Exemple');
    await t.deposit(company.personId, { piece: 'extrait_kbis', seenAt: new Date('2027-03-01T10:00:00.000Z') });
    expect(await t.identityLine(company.documentId)).toEqual({ passed: false, code: 'identity_missing' });
    const anna = await t.person('Anna');
    await t.deposit(anna, { piece: 'carte_identite', seenAt: new Date('2027-03-01T10:00:00.000Z') });
    await t.identification.declare(t.agent, company.personId, { entity: 'societe', beneficialOwners: [{ personId: anna, sharePercent: 100 }] });
    expect(await t.identityLine(company.documentId)).toEqual({ passed: true, code: 'identity_verified' });
    // Redéclarée personne physique : sa propre pièce redevient exigée.
    t.setClock(new Date('2027-03-10T11:00:00.000Z'));
    await t.identification.declare(t.agent, company.personId, { entity: 'personne' });
    expect(await t.identityLine(company.documentId)).toEqual({ passed: false, code: 'identity_missing' });
  });

  it('[R16] [R17] [R13] seuls l’agent de la fiche et le responsable déclarent ; rien ne s’efface ; le journal ne porte que des codes', async () => {
    const t = await setup();
    const company = await t.seller('SCI Exemple');
    const anna = await t.person('Anna');
    const owners = [{ personId: anna, sharePercent: 100 }];
    for (const viewer of [t.direction, t.partner, t.sam]) {
      expect(await t.identification.declare(viewer, company.personId, { entity: 'societe', beneficialOwners: owners })).toMatchObject({ ok: false, rule: 'R16' });
    }
    // Un bénéficiaire effectif hors de portée de l'agent : refusé.
    const foreign = (await t.store.createPerson({ networkId: t.network.id, agentId: t.sam.userId, firstName: 'Zoé', lastName: 'Ailleurs' })).id;
    expect(await t.identification.declare(t.agent, company.personId, { entity: 'societe', beneficialOwners: [{ personId: foreign, sharePercent: 50 }] })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.identification.declare(t.compliance, company.personId, { entity: 'societe', beneficialOwners: owners })).toMatchObject({ ok: true });
    await expect(t.db.run('DELETE FROM client_identifications')).rejects.toThrow();
    await expect(t.db.run('DELETE FROM beneficial_owners')).rejects.toThrow();
    await expect(t.db.run('UPDATE beneficial_owners SET share_percent = 30')).rejects.toThrow();
    await expect(t.db.run("UPDATE client_identifications SET entity = 'personne'")).rejects.toThrow();
    const text = JSON.stringify(await t.journal.all());
    expect(text).toContain('identification.declaree');
    for (const word of ['SCI', 'Anna', 'Exemple', 'Associé', 'Zoé']) expect(text).not.toContain(word);
  });

  it('[R92] [R91] les contrôles de D03 et d’O07 lisent le coffre, jamais la case « pièce vue » ni la fiche de risque', () => {
    for (const file of ['../src/documents/controles.ts', '../src/offres/controles-offre.ts', '../src/offres/dossier-vente.ts', '../src/conformite/identification.ts']) {
      const code = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
      expect(code).not.toMatch(/FROM identity_checks/);
      expect(code).not.toMatch(/risk_sheets|risk_validations/);
    }
  });
});
