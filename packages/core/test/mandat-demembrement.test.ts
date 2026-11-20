import { expect, it } from 'vitest';
import {
  Acces,
  ControlesSignature,
  FakeChannel,
  FicheClient,
  FicheUnique,
  Modeles,
  RegistreMandats,
  SignatureEnLigne,
  SignaturePapier,
  SqlJournalStore,
  applyMigrations,
  conformite,
  fromSyncSqlite,
  documentRights,
  type SqlDatabase,
  type Viewer,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';
import { identiteAuCoffre } from './identite-coffre.ts';
import { designerTout } from './designation-jeu.ts';
import { enClair } from './boite-essai.ts';

// AU060 · Le bien démembré : usufruitier et nus-propriétaires. Modèle, barème, personnes et scans inventés.
const BODY = 'Mandat de test : {{mandant.nom}}, {{bien.reference}}, honoraires {{honoraires.montant}} {{honoraires.charge}}, {{mandat.duree_mois}}.\n\nNuméro : {{registre.numero}} · {{bien.adresse}} · {{bien.cadastre}} · {{mandant.domicile}}.';
const T0 = Date.parse('2027-02-10T10:00:00.000Z'); // mercredi, 11 h à Paris
const INPUTS = { 'honoraires.montant': 9000, 'honoraires.charge': 'vendeur', 'mandat.duree_mois': 12 } as const;
const CONSENT = { consentProof: 'accord donné au rendez-vous (test)' };

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = () => new Date(T0);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const unique = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, unique, journal, { now });
  const modeles = new Modeles(db, acces, journal, { now });
  const controles = new ControlesSignature(db, acces, journal, { now });
  const online = new SignatureEnLigne(db, acces, journal, { now });
  const papier = new SignaturePapier(db, acces, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const agent: Viewer = { role: 'agent', userId: alex.id, networkId: network.id };
  const samViewer: Viewer = { role: 'agent', userId: sam.id, networkId: network.id };
  const direction: Viewer = { role: 'direction', userId: 'direction-1', networkId: network.id };
  const v = await modeles.createVersion(direction, 'mandat_vente_simple', BODY);
  if (!v.ok) throw new Error(v.code);
  await modeles.validate({ role: 'compliance', userId: 'c-1', networkId: network.id }, v.template.id);
  await controles.setFeeSchedule(direction, { maxRatePercent: 5, minEur: 0 });
  await new RegistreMandats(db, journal, { now }).configure(direction, { prefix: 'T-', firstNumber: 1, width: 3 });
  const property = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'REF-T-1', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 90, rooms: 4, priceEur: 250000 });
  /** Un propriétaire du bien, avec sa propre fiche et son propre mail. */
  const owner = async (firstName: string, lastName: string, agentId = alex.id, owns = true) => {
    const p = await store.createPerson({ networkId: network.id, agentId, firstName, lastName });
    await store.addIdentifier({ networkId: network.id, personId: p.id, kind: 'email', value: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@example.test` });
    if (owns) {
      const project = await store.createProject({ networkId: network.id, agentId, personId: p.id, kind: 'sell' });
      await store.linkProjectProperty({ networkId: network.id, agentId, projectId: project.id, propertyId: property.id, role: 'owned' });
    }
    return p.id;
  };
  const identify = (personId: string) => identiteAuCoffre({ db, acces, journal, now }, agent, personId, { piece: 'carte_identite', seenAt: new Date(T0) });
  const generate = async (personId: string, extra: { coMandantIds?: string[]; proxies?: unknown[]; rights?: unknown[] } = {}) => {
    await designerTout(db);
    return modeles.generate(agent, { kind: 'mandat_vente_simple', personId, propertyId: property.id, inputs: INPUTS as never, ...(extra as object) });
  };
  /** Les codes rangés dans la boîte d'essai, avec la fiche à qui chacun part. */
  const codes = async (): Promise<{ personId: string; code: string }[]> =>
    (
      await enClair(
        db.all<{ id: string; body: string; person_id: string }>(
          `SELECT m.id, m.body, m.person_id FROM messages m JOIN trial_outbox t ON t.message_id = m.id WHERE m.body LIKE '%code de signature%' ORDER BY m.occurred_at, m.created_at`,
        ),
      )
    ).map((r) => ({ personId: r.person_id, code: /(\d{6})/.exec(r.body)![1]! }));
  return { db, journal, acces, now, store, unique, modeles, controles, online, papier, network, alex, sam, agent, samViewer, direction, property, owner, identify, generate, codes };
}

const failed = (r: Awaited<ReturnType<ControlesSignature['check']>>) => (r.ok ? r.value.lines.filter((l) => !l.ok).map((l) => l.code) : [r.code]);
const REF = (propertyId: string, n = 1) => `mandats/${propertyId}/0000000${n}-0000-4000-8000-000000000000.pdf`;

describeWithSqlite('AU060 · le bien démembré', () => {
  it('[R41] usufruitier et nus-propriétaires signent ensemble, chacun nommé avec son droit et son justificatif', async () => {
    const t = await setup();
    const mere = await t.owner('Léa', 'Exemple');
    const fils = await t.owner('Noé', 'Exemple');
    const fille = await t.owner('Ivy', 'Exemple');
    const rights = [
      { personId: mere, right: 'usufruit', proofRef: REF(t.property.id, 1) },
      { personId: fils, right: 'nue_propriete', proofRef: REF(t.property.id, 2) },
      { personId: fille, right: 'nue_propriete', proofRef: REF(t.property.id, 2) },
    ];
    const d = await t.generate(mere, { coMandantIds: [fils, fille], rights });
    if (!d.ok) throw new Error(d.code);
    expect(d.document.status).toBe('complet');
    expect(d.document.content).toContain('Léa Exemple, titulaire de l’usufruit');
    expect(d.document.content).toContain('Noé Exemple, titulaire de la nue-propriété');
    expect(d.document.content).toContain('Ivy Exemple, titulaire de la nue-propriété');
    expect((await documentRights(t.db, d.document.id)).map((r) => r.right).sort()).toEqual(['nue_propriete', 'nue_propriete', 'usufruit']);
    // Le contrôle : sans stockage, rien ne passe ; un justificatif absent, non ; présents, oui.
    for (const id of [mere, fils, fille]) await t.identify(id);
    expect(failed(await t.controles.check(t.agent, d.document.id))).toEqual(['depot_ferme']);
    const stored = new Set([REF(t.property.id, 1)]);
    const withScans = new ControlesSignature(t.db, t.acces, t.journal, { now: t.now, scans: { has: async (r) => stored.has(r) } });
    expect(failed(await withScans.check(t.agent, d.document.id))).toEqual(['proof_absent']);
    stored.add(REF(t.property.id, 2));
    const ok = await withScans.check(t.agent, d.document.id);
    expect(ok.ok && ok.value.lines.find((l) => l.check === 'droits')).toEqual({ check: 'droits', ok: true, code: 'dismembered_checked' });
    await expect(t.db.run('DELETE FROM document_mandant_rights')).rejects.toThrow();
  });

  it('[R41] un usufruit sans nue-propriété, ou l’inverse, ne se vend pas ; un droit démembré sans justificatif non plus', async () => {
    const t = await setup();
    const mere = await t.owner('Léa', 'Exemple');
    const fils = await t.owner('Noé', 'Exemple');
    // Avant : rien ne distinguait l'usufruitier ; la clé était refusée.
    expect(await t.generate(mere, { rights: [{ personId: mere, right: 'usufruit', proofRef: REF(t.property.id) }] })).toEqual({ ok: false, rule: null, code: 'dismembered_incomplete' });
    expect(await t.generate(mere, { coMandantIds: [fils], rights: [{ personId: mere, right: 'pleine_propriete' }, { personId: fils, right: 'nue_propriete', proofRef: REF(t.property.id) }] })).toEqual({ ok: false, rule: null, code: 'dismembered_incomplete' });
    const bad = { ok: false, rule: null, code: 'bad_rights' };
    expect(await t.generate(mere, { coMandantIds: [fils], rights: [{ personId: mere, right: 'usufruit' }, { personId: fils, right: 'nue_propriete', proofRef: REF(t.property.id) }] })).toEqual(bad);
    expect(await t.generate(mere, { coMandantIds: [fils], rights: [{ personId: mere, right: 'usufruit', proofRef: REF(t.property.id) }] })).toEqual(bad);
    expect(await t.generate(mere, { coMandantIds: [fils], rights: [{ personId: mere, right: 'usufruit', proofRef: 'ailleurs.pdf' }, { personId: fils, right: 'nue_propriete', proofRef: REF(t.property.id) }] })).toEqual(bad);
    expect(await t.generate(mere, { coMandantIds: [fils], rights: [{ personId: mere, right: 'habitation', proofRef: REF(t.property.id) }, { personId: fils, right: 'nue_propriete', proofRef: REF(t.property.id) }] })).toEqual(bad);
    // La pleine propriété seule se dit sans justificatif.
    const plain = await t.generate(mere, { coMandantIds: [fils], rights: [{ personId: mere, right: 'pleine_propriete' }, { personId: fils, right: 'pleine_propriete' }] });
    expect(plain.ok && plain.document.content).toContain('Léa Exemple, titulaire de la pleine propriété');
    expect(await t.db.all("SELECT right_kind FROM document_mandant_rights WHERE right_kind <> 'pleine_propriete'")).toEqual([]);
  });
});
