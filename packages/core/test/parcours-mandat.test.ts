import { performance } from 'node:perf_hooks';
import { expect, it } from 'vitest';
import {
  Acces,
  ChronologieMandat,
  ControlesSignature,
  FicheClient,
  FicheUnique,
  MANDATE_TARGET_SECONDS,
  Modeles,
  RegistreMandats,
  SignaturePapier,
  SqlJournalStore,
  applyMigrations,
  fromSyncSqlite,
  type SqlDatabase,
  type Viewer,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Parcours de test, de l'avis de valeur validé au mandat numéroté, sur une horloge simulée. Tout est inventé.
const BODY = 'Mandat de test : {{mandant.nom}}, {{bien.reference}}, {{bien.prix}}, honoraires {{honoraires.montant}} {{honoraires.charge}}, {{mandat.duree_mois}}.\n\n!! Clause de test.\n\nNuméro : {{registre.numero}}, le {{signature.date}}, {{signature.lieu}}.';
const T0 = Date.parse('2027-02-10T09:00:00.000Z');
const MIN = 60_000;

async function parcours(minutes: { generate: number; check: number; sign: number }) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = T0 - 60 * MIN;
  const now = () => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const acces = new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now });
  const modeles = new Modeles(db, acces, journal, { now });
  const controles = new ControlesSignature(db, acces, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const agent: Viewer = { role: 'agent', userId: alex.id, networkId: network.id };
  const direction: Viewer = { role: 'direction', userId: 'direction-1', networkId: network.id };
  // Le réseau est prêt : modèle validé, barème, registre.
  const v = await modeles.createVersion(direction, 'mandat_vente_exclusif', BODY);
  await modeles.validate({ role: 'compliance', userId: 'c-1', networkId: network.id }, v.ok ? v.template.id : '');
  await controles.setFeeSchedule(direction, { maxRatePercent: 5, minEur: 0 });
  await new RegistreMandats(db, journal, { now }).configure(direction, { prefix: 'T-', firstNumber: 1, width: 3 });
  // Le vendeur, son bien, son identité vue au rendez-vous d'estimation.
  const p = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Léa', lastName: 'Exemple' });
  const b = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'REF-T-1', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 60, rooms: 3, priceEur: 200000 });
  const project = await store.createProject({ networkId: network.id, agentId: alex.id, personId: p.id, kind: 'sell' });
  await store.linkProjectProperty({ networkId: network.id, agentId: alex.id, projectId: project.id, propertyId: b.id, role: 'owned' });
  // T0 : l'avis de valeur est validé par l'agent (E04), posé ici directement.
  clock = T0;
  await db.run(
    `INSERT INTO valuation_reports (id, network_id, property_id, agent_id, status, computed, computed_low, computed_high, text, text_by, created_at, updated_at, validated_by, validated_at)
     VALUES ('avis-1', ?, ?, ?, 'validated', '{}', 190000, 210000, 'texte de test', 'fallback', ?, ?, ?, ?)`,
    [network.id, b.id, alex.id, new Date(T0 - 5 * MIN).toISOString(), new Date(T0).toISOString(), `agent:${alex.id}`, new Date(T0).toISOString()],
  );
  await controles.recordIdentity(agent, p.id, { piece: 'carte_identite', seenAt: new Date(T0) });

  const timings: Record<string, number> = {};
  const step = async <T>(name: string, at: number, run: () => Promise<T>): Promise<T> => {
    clock = T0 + at * MIN;
    const start = performance.now();
    const result = await run();
    timings[name] = performance.now() - start;
    return result;
  };
  const doc = await step('generation', minutes.generate, () => modeles.generate(agent, { kind: 'mandat_vente_exclusif', personId: p.id, propertyId: b.id, inputs: { 'honoraires.montant': 9000, 'honoraires.charge': 'vendeur', 'mandat.duree_mois': 12 } }));
  if (!doc.ok) throw new Error(doc.code);
  const check = await step('controle', minutes.check, () => controles.check(agent, doc.document.id));
  expect(check.ok && check.value.passed).toBe(true);
  const signed = await step('signature', minutes.sign, () =>
    new SignaturePapier(db, acces, journal, { now }).register(agent, doc.document.id, { signedAt: new Date(T0 + (minutes.sign - 1) * MIN), place: 'agence', scanRef: 'scans/test.pdf', source: 'online_valuation' }),
  );
  if (!signed.ok) throw new Error(signed.code);
  const timeline = await new ChronologieMandat(db, journal, { now }).read(direction, signed.value.mandateId);
  return { timeline, timings, number: signed.value.number, db, journal, network, agent, mandateId: signed.value.mandateId };
}

describeWithSqlite('D09 · mandat signé en moins de 10 minutes à partir de l’estimation', () => {
  it('le parcours de test passe, chaque étape est mesurée, le total est sous la cible', async () => {
    const r = await parcours({ generate: 2, check: 5, sign: 8 });
    expect(r.number).toBe('T-001');
    expect(r.timeline).toEqual({
      ok: true,
      value: expect.objectContaining({
        valuationValidatedAt: new Date(T0).toISOString(),
        steps: { valuationToDocument: 120, documentToCheck: 180, checkToNumbered: 180 },
        totalSeconds: 480,
        underTarget: true,
      }),
    });
    // Le temps passé par le système lui-même, à chaque étape : bien moins d'une seconde.
    for (const [name, ms] of Object.entries(r.timings)) expect(ms, name).toBeLessThan(1000);
    console.info(`Parcours de test : ${Object.entries(r.timings).map(([k, ms]) => `${k} ${ms.toFixed(1)} ms`).join(', ')} ; total simulé ${r.timeline.ok ? r.timeline.value.totalSeconds : '?'} s sur ${MANDATE_TARGET_SECONDS} s.`);
  });

  it('au-delà de 10 minutes, la chronologie le dit ; seules la direction et la conformité la lisent [R16, R13]', async () => {
    const r = await parcours({ generate: 3, check: 7, sign: 12 });
    expect(r.timeline.ok && [r.timeline.value.totalSeconds, r.timeline.value.underTarget]).toEqual([720, false]);
    const chrono = new ChronologieMandat(r.db, r.journal);
    expect(await chrono.read(r.agent, r.mandateId)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await chrono.read({ role: 'compliance', userId: 'c-1', networkId: r.network.id }, r.mandateId)).toMatchObject({ ok: true });
    expect(await chrono.read({ role: 'direction', userId: 'd', networkId: 'autre' }, r.mandateId)).toEqual({ ok: false, rule: null, code: 'unknown_mandate' });
    expect(JSON.stringify(await r.journal.all())).not.toMatch(/Léa|Exemple/);
  });

  it('exactement 10 minutes n’est pas « moins de 10 minutes »', async () => {
    const r = await parcours({ generate: 2, check: 5, sign: 10 });
    expect(r.timeline.ok && [r.timeline.value.totalSeconds, r.timeline.value.underTarget]).toEqual([600, false]);
  });
});
