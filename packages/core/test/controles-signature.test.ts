import { expect, it } from 'vitest';
import { Acces, ControlesSignature, FicheClient, FicheUnique, Modeles, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';
import { identiteAuCoffre } from './identite-coffre.ts';
import { designerTout } from './designation-jeu.ts';

// Modèle, barème et personnes inventés pour les tests.
const BODY = 'Mandat de test : {{mandant.nom}}, {{bien.reference}}, {{bien.prix}}, honoraires {{honoraires.montant}} {{honoraires.charge}}, {{mandat.duree_mois}}.\n\n!! Clause de test mise en évidence.\n\nNuméro : {{registre.numero}} · {{bien.adresse}} · {{bien.cadastre}} · {{mandant.domicile}}.';
const NOW = new Date('2027-02-10T10:00:00.000Z');
const INPUTS = { 'honoraires.montant': 10000, 'honoraires.charge': 'vendeur', 'mandat.duree_mois': 12 } as const;

async function setup(validate = true) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = () => NOW;
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const modeles = new Modeles(db, acces, journal, { now });
  const controles = new ControlesSignature(db, acces, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const as = (role: string, userId: string): Viewer => ({ role, userId, networkId: network.id }) as Viewer;
  const agent = as('agent', alex.id);
  const direction = as('direction', 'direction-1');
  const conformite = as('compliance', 'conformite-1');
  const v = await modeles.createVersion(direction, 'mandat_vente_exclusif', BODY);
  if (!v.ok) throw new Error(v.code);
  if (validate) await modeles.validate(conformite, v.template.id);
  expect(await controles.setFeeSchedule(direction, { maxRatePercent: 5, minEur: 3000 })).toEqual({ ok: true });
  /** Un vendeur, son bien (dont il est propriétaire), et un mandat généré. */
  let n = 0;
  const seller = async (options: { owner?: boolean; price?: number; inputs?: Record<string, unknown> } = {}) => {
    const p = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Léa', lastName: 'Exemple' });
    const b = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: `REF-T-${++n}`, kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 60, rooms: 3, priceEur: options.price ?? 200000 });
    const project = await store.createProject({ networkId: network.id, agentId: alex.id, personId: p.id, kind: 'sell' });
    if (options.owner !== false) await store.linkProjectProperty({ networkId: network.id, agentId: alex.id, projectId: project.id, propertyId: b.id, role: 'owned' });
    await designerTout(db);
    const d = await modeles.generate(agent, { kind: 'mandat_vente_exclusif', personId: p.id, propertyId: b.id, inputs: (options.inputs ?? INPUTS) as never });
    if (!d.ok) throw new Error(d.code);
    return { personId: p.id, propertyId: b.id, documentId: d.document.id, projectId: project.id };
  };
  /** La pièce d'identité déposée au coffre : la seule identité que lit le contrôle depuis L03 [R92]. */
  const identite = (viewer: Viewer, personId: string, input: { piece: string; seenAt: Date; validUntil?: string | null }) => identiteAuCoffre({ db, acces, journal, now }, viewer, personId, input);
  return { db, journal, store, controles, network, alex, sam, as, agent, direction, conformite, seller, identite };
}

const failed = (r: Awaited<ReturnType<ControlesSignature['check']>>) => (r.ok ? r.value.lines.filter((l) => !l.ok).map((l) => l.code) : [r.code]);

describeWithSqlite('D03 · contrôles avant signature', () => {
  it('[R41] un document complet, au barème, au bon mandant identifié passe ; le résultat est gardé et rendu ligne par ligne', async () => {
    const t = await setup();
    const s = await t.seller();
    expect(await t.identite(t.agent, s.personId, { piece: 'carte_identite', seenAt: new Date('2027-02-01T10:00:00Z') })).toMatchObject({ ok: true });
    const r = await t.controles.check(t.agent, s.documentId);
    expect(r).toEqual({
      ok: true,
      value: {
        documentId: s.documentId,
        passed: true,
        checkedAt: NOW.toISOString(),
        lines: [
          { check: 'champs', ok: true, code: 'complete' },
          { check: 'modele', ok: true, code: 'validated_template' },
          { check: 'honoraires', ok: true, code: 'fee_in_schedule' },
          { check: 'mandants', ok: true, code: 'mandants_match' },
          { check: 'identite', ok: true, code: 'identity_verified' },
        ],
      },
    });
    expect(await t.controles.last(s.documentId)).toMatchObject({ passed: true });
  });

  it('[R41] aucun mandat ne passe sans identification du vendeur, ou avec une identification de plus d’un an', async () => {
    const t = await setup();
    const s = await t.seller();
    expect(failed(await t.controles.check(t.agent, s.documentId))).toEqual(['identity_missing']);
    await t.controles.recordIdentity(t.agent, s.personId, { piece: 'passeport', seenAt: new Date('2026-01-01T10:00:00Z') });
    expect(failed(await t.controles.check(t.agent, s.documentId))).toEqual(['identity_missing']);
    await t.identite(t.agent, s.personId, { piece: 'passeport', seenAt: new Date('2026-01-01T10:00:00Z') });
    expect(failed(await t.controles.check(t.agent, s.documentId))).toEqual(['identity_missing']);
    expect(await t.controles.recordIdentity(t.agent, s.personId, { piece: 'titre_inconnu', seenAt: NOW })).toEqual({ ok: false, rule: null, code: 'bad_piece' });
    expect(await t.controles.recordIdentity(t.agent, s.personId, { piece: 'passeport', seenAt: new Date('2027-03-01T00:00:00Z') })).toEqual({ ok: false, rule: null, code: 'bad_date' });
  });

  it('[R41] incomplet, modèle d’essai, hors barème, payeur inconnu, mandant différent du propriétaire : refusé', async () => {
    const t = await setup();
    const id = async (s: { personId: string }) => t.identite(t.agent, s.personId, { piece: 'carte_identite', seenAt: NOW });
    const incomplete = await t.seller({ inputs: { 'honoraires.montant': 10000, 'honoraires.charge': 'vendeur' } });
    await id(incomplete);
    expect(failed(await t.controles.check(t.agent, incomplete.documentId))).toEqual(['missing_fields']);
    const above = await t.seller({ inputs: { ...INPUTS, 'honoraires.montant': 10001 } });
    await id(above);
    expect(failed(await t.controles.check(t.agent, above.documentId))).toEqual(['fee_above_schedule']);
    const below = await t.seller({ inputs: { ...INPUTS, 'honoraires.montant': 2999 } });
    await id(below);
    expect(failed(await t.controles.check(t.agent, below.documentId))).toEqual(['fee_below_minimum']);
    const noPayer = await t.seller({ inputs: { 'honoraires.montant': 10000, 'mandat.duree_mois': 12 } });
    await id(noPayer);
    expect(failed(await t.controles.check(t.agent, noPayer.documentId))).toEqual(['missing_fields', 'fee_payer_unknown']);
    const notOwner = await t.seller({ owner: false });
    await id(notOwner);
    expect(failed(await t.controles.check(t.agent, notOwner.documentId))).toEqual(['owners_unknown']);
    // Un autre propriétaire en plus : le modèle ne nomme qu'un mandant.
    const both = await t.seller();
    await id(both);
    const other = await t.store.createPerson({ networkId: t.network.id, agentId: t.alex.id, firstName: 'Noé', lastName: 'Autre' });
    const project = await t.store.createProject({ networkId: t.network.id, agentId: t.alex.id, personId: other.id, kind: 'sell' });
    await t.store.linkProjectProperty({ networkId: t.network.id, agentId: t.alex.id, projectId: project.id, propertyId: both.propertyId, role: 'owned' });
    expect(failed(await t.controles.check(t.agent, both.documentId))).toEqual(['mandants_differ']);

    const trial = await setup(false);
    const s = await trial.seller();
    await trial.identite(trial.agent, s.personId, { piece: 'carte_identite', seenAt: NOW });
    expect(failed(await trial.controles.check(trial.agent, s.documentId))).toEqual(['trial_template']);
  });

  it('[R41] AU058 · un barème à tranches ou à forfaits : le contrôle retrouve le plafond de la tranche du prix', async () => {
    const t = await setup();
    const dir = { role: 'direction', userId: 'd', networkId: t.network.id } as Viewer;
    // Jusqu'à 100 000 € : un forfait de 8 000 € ; jusqu'à 250 000 € : 4 % ; au-delà : 3 %.
    const tiers = [{ upToEur: 100_000, flatEur: 8_000 }, { upToEur: 250_000, ratePercent: 4 }, { upToEur: null, ratePercent: 3 }];
    expect(await t.controles.setFeeSchedule(dir, { maxRatePercent: 10, minEur: 3000, tiers })).toEqual({ ok: true });
    expect(await t.controles.readFeeSchedule(dir)).toMatchObject({ ok: true, value: { maxRatePercent: 10, minEur: 3000, tiers } });
    const at = async (price: number, fee: number) => {
      const s = await t.seller({ price, inputs: { ...INPUTS, 'honoraires.montant': fee } });
      await t.identite(t.agent, s.personId, { piece: 'carte_identite', seenAt: NOW });
      return failed(await t.controles.check(t.agent, s.documentId));
    };
    expect(await at(90_000, 8_000)).toEqual([]);
    expect(await at(90_000, 8_001)).toEqual(['fee_above_schedule']);
    expect(await at(200_000, 8_000)).toEqual([]);
    expect(await at(200_000, 8_001)).toEqual(['fee_above_schedule']);
    expect(await at(300_000, 9_000)).toEqual([]);
    expect(await at(300_000, 9_001)).toEqual(['fee_above_schedule']);
    // Des tranches mal faites sont refusées, rien n'est rangé.
    for (const bad of [
      [{ upToEur: 200_000, ratePercent: 4 }, { upToEur: 100_000, ratePercent: 3 }],
      [{ upToEur: null, ratePercent: 4 }, { upToEur: 100_000, ratePercent: 3 }],
      [{ upToEur: 100_000, ratePercent: 4, flatEur: 5000 }],
      [{ upToEur: 100_000 }],
      [{ upToEur: 100_000, ratePercent: 4.555 }],
    ]) {
      expect(await t.controles.setFeeSchedule(dir, { maxRatePercent: 10, minEur: 0, tiers: bad })).toEqual({ ok: false, rule: null, code: 'bad_tiers' });
    }
  });

  it('[R41] sans barème réglé, rien ne passe ; seule la direction règle le barème, en ajout seul', async () => {
    const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
    await applyMigrations(db, loadMigrations());
    const journal = new SqlJournalStore(db);
    const store = new FicheClient(db);
    const acces = new Acces(db, store, new FicheUnique(db, store), journal);
    const controles = new ControlesSignature(db, acces, journal);
    const network = await store.createNetwork('Réseau test');
    expect(await controles.setFeeSchedule({ role: 'agent', userId: 'x', networkId: network.id } as Viewer, { maxRatePercent: 5, minEur: 0 })).toMatchObject({ ok: false, rule: 'R16' });
    for (const bad of [{ maxRatePercent: 0, minEur: 0 }, { maxRatePercent: 101, minEur: 0 }, { maxRatePercent: 5.555, minEur: 0 }, { maxRatePercent: 5, minEur: -1 }]) {
      expect(await controles.setFeeSchedule({ role: 'direction', userId: 'd', networkId: network.id } as Viewer, bad)).toEqual({ ok: false, rule: null, code: 'bad_schedule' });
    }
    const t = await setup();
    const s = await t.seller();
    await t.identite(t.agent, s.personId, { piece: 'carte_identite', seenAt: NOW });
    await expect(t.db.run('DELETE FROM fee_schedules')).rejects.toThrow(/ajout seul/);
    // Un barème plus strict réglé ensuite est en vigueur.
    await t.controles.setFeeSchedule(t.direction, { maxRatePercent: 4, minEur: 3000 });
    expect(failed(await t.controles.check(t.agent, s.documentId))).toEqual(['fee_above_schedule']);
  });

  it('[R16, R13, R15] contrôle refusé à un autre agent ; l’identité ne garde ni numéro ni copie ; le journal ne porte que des codes', async () => {
    const t = await setup();
    const s = await t.seller();
    expect(await t.controles.check(t.as('agent', t.sam.id), s.documentId)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.controles.recordIdentity(t.as('agent', t.sam.id), s.personId, { piece: 'carte_identite', seenAt: NOW })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.controles.recordIdentity(t.direction, s.personId, { piece: 'carte_identite', seenAt: NOW })).toMatchObject({ ok: false, rule: 'R16' });
    expect((await t.controles.recordIdentity(t.conformite, s.personId, { piece: 'carte_identite', seenAt: NOW })).ok).toBe(true);
    expect((await t.identite(t.conformite, s.personId, { piece: 'carte_identite', seenAt: NOW })).ok).toBe(true);
    const columns = await t.db.all<{ name: string }>(`SELECT name FROM pragma_table_info('identity_checks')`);
    expect(columns.map((c) => c.name).sort()).toEqual(['checked_by', 'created_at', 'id', 'network_id', 'person_id', 'piece', 'seen_at']);
    for (const viewer of [t.agent, t.direction, t.conformite]) expect((await t.controles.check(viewer, s.documentId)).ok).toBe(true);
    const text = JSON.stringify(await t.journal.all());
    expect(text).not.toMatch(/Léa|Exemple/);
    expect((await t.journal.all()).filter((e) => e.type === 'document.controle').map((e) => (e.data as { rule: string }).rule)).toEqual(['R41', 'R41', 'R41']);
  });
});
