import { expect, it } from 'vitest';
import {
  Acces,
  ControlesSignature,
  Diffusion,
  EcheancesMandats,
  FicheClient,
  FicheUnique,
  Modeles,
  RegistreMandats,
  SignatureAvenant,
  SignaturePapier,
  SqlJournalStore,
  applyMigrations,
  fromSyncSqlite,
  mandateTerms,
  type SqlDatabase,
  type Viewer,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';
import { identiteAuCoffre } from './identite-coffre.ts';

// Modèles, registre et personnes inventés.
const MANDATE = 'Mandat de test : {{mandant.nom}}, {{bien.prix}}, {{honoraires.montant}} {{honoraires.charge}}, {{mandat.duree_mois}}.\n\nNuméro : {{registre.numero}}.';
const AMENDMENT = 'Avenant de test au mandat n° {{mandat.numero}} : {{avenant.objet}}.\n\nMandant : {{mandant.nom}}. Signé le {{signature.date}}, {{signature.lieu}}.';
const SIGNED = new Date('2027-02-10T09:00:00.000Z');
const LATER = new Date('2027-03-01T09:00:00.000Z');

async function setup() {
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
  await controles.setFeeSchedule(direction, { maxRatePercent: 5, minEur: 0 });
  await new RegistreMandats(db, journal, { now }).configure(direction, { prefix: 'T-', firstNumber: 1, width: 3 });
  const p = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Léa', lastName: 'Exemple' });
  const b = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'REF-T-1', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 60, rooms: 3, priceEur: 200000 });
  const project = await store.createProject({ networkId: network.id, agentId: alex.id, personId: p.id, kind: 'sell' });
  await store.linkProjectProperty({ networkId: network.id, agentId: alex.id, projectId: project.id, propertyId: b.id, role: 'owned' });
  await identiteAuCoffre({ db, acces, journal, now }, agent, p.id, { piece: 'carte_identite', seenAt: SIGNED });
  const d = await modeles.generate(agent, { kind: 'mandat_vente_simple', personId: p.id, propertyId: b.id, inputs: { 'honoraires.montant': 9000, 'honoraires.charge': 'vendeur', 'mandat.duree_mois': 12 } });
  if (!d.ok) throw new Error(d.code);
  const signed = await new SignaturePapier(db, acces, journal, { now }).register(agent, d.document.id, { signedAt: SIGNED, place: 'agence', scanRef: 'scans/mandat.pdf', source: 'referral' });
  if (!signed.ok) throw new Error(signed.code);
  clock = new Date('2027-03-01T10:00:00.000Z');
  const amendment = (inputs: Record<string, unknown>, mandateId: string | undefined = signed.value.mandateId) =>
    modeles.generate(agent, { kind: 'avenant_mandat', personId: p.id, propertyId: b.id, inputs: inputs as never, ...(mandateId === undefined ? {} : { mandateId }) });
  const avenants = new SignatureAvenant(db, acces, journal, { now });
  return { db, journal, acces, modeles, network, agent, direction, as, sam, mandateId: signed.value.mandateId, personId: p.id, propertyId: b.id, amendment, avenants, now: (d: Date) => (clock = d) };
}

describeWithSqlite('D07 · avenant au mandat', () => {
  it('l’avenant porte la référence et le numéro du mandat ; le prix ne change qu’une fois l’avenant signé', async () => {
    const t = await setup();
    const a = await t.amendment({ 'avenant.prix': 190000 });
    if (!a.ok) throw new Error(a.code);
    expect(a.document.status).toBe('complet');
    expect(a.document.content).toContain('Avenant de test au mandat n° T-001 : prix de vente porté à');
    expect((await mandateTerms(t.db, t.mandateId))?.priceEur).toBe(200000);
    const r = await t.avenants.register(t.agent, a.document.id, { signedAt: LATER, place: 'agence', scanRef: 'scans/avenant-1.pdf' });
    expect(r).toMatchObject({ ok: true, value: { mandateId: t.mandateId } });
    const terms = await t.avenants.terms(t.agent, t.mandateId);
    expect(terms.ok && terms.value).toMatchObject({ priceEur: 190000, durationMonths: 12, amendments: [{ documentId: a.document.id, priceEur: 190000, durationMonths: null }] });
    expect(await t.avenants.register(t.agent, a.document.id, { signedAt: LATER, place: 'agence', scanRef: 'scans/avenant-1.pdf' })).toEqual({ ok: false, rule: null, code: 'already_signed' });
  });

  it('[R41] mêmes contrôles : honoraires au barème du nouveau prix, objet connu, mandat en vigueur', async () => {
    const t = await setup();
    const low = await t.amendment({ 'avenant.prix': 150000 });
    if (!low.ok) throw new Error(low.code);
    const r = await t.avenants.register(t.agent, low.document.id, { signedAt: LATER, place: 'agence', scanRef: 'scans/a.pdf' });
    expect(r.ok === false && 'check' in r && r.check.lines.filter((l) => !l.ok).map((l) => l.code)).toEqual(['fee_above_schedule']);
    const empty = await t.amendment({});
    if (!empty.ok) throw new Error(empty.code);
    expect(empty.document.missing).toEqual(['avenant.objet']);
    // Un mandat rétracté ou annulé ne reçoit plus d'avenant.
    await new RegistreMandats(t.db, t.journal).cancel(t.direction, t.mandateId, 'termination');
    expect(await t.amendment({ 'avenant.prix': 190000 })).toEqual({ ok: false, rule: null, code: 'bad_mandate' });
  });

  it('une nouvelle durée signée prolonge la diffusion et déplace l’échéance', async () => {
    const t = await setup();
    const a = await t.amendment({ 'avenant.duree_mois': 24 });
    if (!a.ok) throw new Error(a.code);
    const diffusion = new Diffusion(t.db, t.acces, t.journal);
    const at = new Date('2028-03-01T10:00:00.000Z');
    expect(await diffusion.canDiffuse(t.network.id, t.propertyId, at)).toMatchObject({ allowed: false, reason: 'expired' });
    expect((await t.avenants.register(t.agent, a.document.id, { signedAt: LATER, place: 'agence', scanRef: 'scans/a.pdf' })).ok).toBe(true);
    expect(await diffusion.canDiffuse(t.network.id, t.propertyId, at)).toMatchObject({ allowed: true });
    const echeances = new EcheancesMandats(t.db, t.journal, { now: () => new Date('2029-01-15T10:00:00.000Z') });
    expect(await echeances.run()).toBe(1);
    const list = await echeances.list(t.agent);
    expect(list.ok && list.tasks.map((k) => [k.kind, k.dueDay])).toEqual([['fin_mandat', '2029-02-10']]);
  });

  it('[R16, R17] un avenant sans mandat, ou d’un autre mandat que le sien, est refusé ; rien ne s’efface ; autre agent refusé', async () => {
    const t = await setup();
    expect(await t.modeles.generate(t.agent, { kind: 'avenant_mandat', personId: t.personId, propertyId: t.propertyId, inputs: { 'avenant.prix': 190000 } })).toEqual({ ok: false, rule: null, code: 'bad_mandate' });
    expect(await t.amendment({ 'avenant.prix': 190000 }, 'inconnu')).toEqual({ ok: false, rule: null, code: 'bad_mandate' });
    expect(await t.modeles.generate(t.agent, { kind: 'mandat_vente_simple', personId: t.personId, propertyId: t.propertyId, mandateId: t.mandateId })).toEqual({ ok: false, rule: null, code: 'bad_mandate' });
    const a = await t.amendment({ 'avenant.prix': 190000 });
    if (!a.ok) throw new Error(a.code);
    expect(await t.avenants.register(t.as('agent', t.sam.id), a.document.id, { signedAt: LATER, place: 'agence', scanRef: 'scans/a.pdf' })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.avenants.register(t.agent, a.document.id, { signedAt: new Date('2027-02-01T09:00:00Z'), place: 'agence', scanRef: 'scans/a.pdf' })).toEqual({ ok: false, rule: null, code: 'before_mandate' });
    await t.avenants.register(t.agent, a.document.id, { signedAt: LATER, place: 'agence', scanRef: 'scans/a.pdf' });
    await expect(t.db.run('DELETE FROM signed_amendments')).rejects.toThrow(/gardé/);
    await expect(t.db.run('UPDATE signed_amendments SET copy_content = ?', ['x'])).rejects.toThrow(/figé/);
    expect(await t.avenants.terms(t.as('agent', t.sam.id), t.mandateId)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.modeles.createVersion(t.direction, 'avenant_mandat', 'Avenant sans numéro : {{avenant.objet}}.')).toEqual({ ok: false, rule: 'R40', code: 'no_number_field' });
    expect(JSON.stringify(await t.journal.all())).not.toMatch(/Léa|Exemple/);
  });

  it('[R42] un mandat échu ne se prolonge pas par un avenant, même préparé avant l’échéance', async () => {
    const t = await setup();
    const a = await t.amendment({ 'avenant.duree_mois': 24 });
    if (!a.ok) throw new Error(a.code);
    t.now(new Date('2028-03-01T10:00:00.000Z'));
    await identiteAuCoffre({ db: t.db, acces: t.acces, journal: t.journal, now: () => new Date('2028-03-01T10:00:00.000Z') }, t.agent, t.personId, { piece: 'carte_identite', seenAt: new Date('2028-02-20T10:00:00.000Z') });
    const r = await t.avenants.register(t.agent, a.document.id, { signedAt: new Date('2028-03-01T09:00:00.000Z'), place: 'agence', scanRef: 'scans/a.pdf' });
    expect(r.ok === false && 'check' in r && r.check.lines.filter((l) => !l.ok).map((l) => l.code)).toEqual(['mandate_expired']);
    expect(await t.amendment({ 'avenant.duree_mois': 24 })).toEqual({ ok: false, rule: null, code: 'bad_mandate' });
  });

  it('[R40] une saisie que le modèle n’écrit pas est refusée : les conditions en vigueur sont celles du document signé', async () => {
    const t = await setup();
    const v = await t.modeles.createVersion(t.direction, 'avenant_mandat', 'Avenant de test au mandat n° {{mandat.numero}} : durée portée à {{avenant.duree_mois}}.');
    if (!v.ok) throw new Error(v.code);
    await t.modeles.validate(t.as('compliance', 'c-1'), v.template.id);
    expect(await t.amendment({ 'avenant.duree_mois': 24, 'avenant.prix': 190000 })).toEqual({ ok: false, rule: 'R40', code: 'bad_input' });
    expect((await t.amendment({ 'avenant.duree_mois': 24 })).ok).toBe(true);
    expect(await t.modeles.generate(t.agent, { kind: 'mandat_vente_simple', personId: t.personId, propertyId: t.propertyId, inputs: { 'avenant.prix': 1 } })).toEqual({ ok: false, rule: 'R40', code: 'bad_input' });
  });

  it('une échéance déplacée par un avenant signé n’est plus montrée, mais reste gardée', async () => {
    const t = await setup();
    const early = new EcheancesMandats(t.db, t.journal, { now: () => new Date('2028-01-15T10:00:00.000Z') });
    expect(await early.run()).toBe(1);
    const a = await t.amendment({ 'avenant.duree_mois': 24 });
    if (!a.ok) throw new Error(a.code);
    expect((await t.avenants.register(t.agent, a.document.id, { signedAt: LATER, place: 'agence', scanRef: 'scans/a.pdf' })).ok).toBe(true);
    expect(await early.list(t.agent)).toEqual({ ok: true, tasks: [] });
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM mandate_tasks')).toEqual({ n: 1 });
  });

  it('[R42] un avenant n’accepte pas les saisies du mandat ; son exemplaire signé se lit comme celui du mandat', async () => {
    const t = await setup();
    expect(await t.amendment({ 'mandat.duree_mois': 1 })).toEqual({ ok: false, rule: 'R40', code: 'bad_input' });
    expect(await t.amendment({ 'avenant.prix': 190000, 'honoraires.montant': 1 })).toEqual({ ok: false, rule: 'R40', code: 'bad_input' });
    const a = await t.amendment({ 'avenant.prix': 190000 });
    if (!a.ok) throw new Error(a.code);
    await t.avenants.register(t.agent, a.document.id, { signedAt: LATER, place: 'agence', scanRef: 'scans/a.pdf' });
    const copy = await new SignaturePapier(t.db, t.acces, t.journal).copy(t.agent, a.document.id);
    expect(copy.ok && copy.number).toBe('T-001');
    expect(copy.ok && copy.content).toContain('<span class="signe">01/03/2027</span>');
    expect(await new SignaturePapier(t.db, t.acces, t.journal).copy(t.as('agent', t.sam.id), a.document.id)).toMatchObject({ ok: false, rule: 'R16' });
  });
});
