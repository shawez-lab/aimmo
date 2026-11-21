import { expect, it } from 'vitest';
import type { PropertySheet } from '../src/annonces/index.ts';
import { InstallationsBien, expectedPieces, installationVerdict, type InstallationFacts } from '../src/dossiers/index.ts';
import { PROOF, setupDossier } from './dossiers-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

const sheet = (buildYear: number | null, heating: PropertySheet['characteristics']['heating'] = 'individuel_gaz'): PropertySheet => ({
  characteristics: { bedrooms: 3, floor: null, floorsTotal: 2, buildYear, heating, outdoor: [], landM2: 400, parkingSpaces: null, elevator: false },
  energy: null,
  coownership: { isCoownership: false },
  risks: null,
  media: [],
});

const diag = (facts: InstallationFacts, buildYear: number | null = 1965) =>
  expectedPieces('home', sheet(buildYear), 2027, undefined, facts)!.pieces.filter((p) => p.piece === 'electricite' || p.piece === 'gaz').map((p) => `${p.piece}:${p.reason}`);

it('[R60] AU084 · le constat : une maison de 1965 rénovée en 2018, sans gaz, ne demande plus ni électricité ni gaz', () => {
  // Avant AU084, l'âge du bâtiment seul décidait : les deux diagnostics étaient demandés.
  expect(diag({})).toEqual(['electricite:installation_plus_15_ans', 'gaz:chauffage_gaz']);
  const renovated: InstallationFacts = {
    electricite: { present: true, since: 2018, proof: 'certificat_conformite', version: 1 },
    gaz: { present: false, since: null, proof: 'declaration_vendeur', version: 1 },
  };
  expect(diag(renovated)).toEqual([]);
  expect(expectedPieces('home', sheet(1965), 2027, undefined, renovated)!.installations).toEqual([
    { installation: 'electricite', verdict: 'recente', since: 2018, proof: 'certificat_conformite' },
    { installation: 'gaz', verdict: 'absente', since: null, proof: 'declaration_vendeur' },
  ]);
});

it('[R60] AU084 · l’âge de chaque installation décide, prouvé par un certificat ou une facture, jamais par la parole seule', () => {
  // Une maison de 1965 au gaz posé en 2010 : 17 ans, le gaz est demandé, sur la déclaration ; l'électricité, faute de mieux, sur le bâtiment.
  expect(diag({ gaz: { present: true, since: 2010, proof: 'facture_travaux', version: 1 } })).toEqual(['electricite:installation_plus_15_ans', 'gaz:installation_declaree_plus_15_ans']);
  // 15 ans pile comptent ; 14 ans, non.
  expect(diag({ electricite: { present: true, since: 2012, proof: 'facture_travaux', version: 1 } })).toContain('electricite:installation_declaree_plus_15_ans');
  expect(diag({ electricite: { present: true, since: 2013, proof: 'facture_travaux', version: 1 } })).toEqual(['gaz:chauffage_gaz']);
  // Une année récente sur la seule parole du vendeur ne retire rien : l'âge du bâtiment en tient lieu.
  expect(diag({ electricite: { present: true, since: 2020, proof: 'declaration_vendeur', version: 1 } })).toContain('electricite:installation_plus_15_ans');
  expect(installationVerdict({ present: true, since: 2020, proof: 'declaration_vendeur', version: 1 }, 2027)).toBe('non_tranche');
  // Le gaz déclaré présent sans année, dans un logement ancien : demandé, et la raison le dit.
  expect(diag({ gaz: { present: true, since: null, proof: 'declaration_vendeur', version: 1 } }, 1965)).toContain('gaz:installation_gaz_declaree');
  // Bâtiment inconnu, électricité rénovée prouvée : rien ; gaz absent : rien. L'année inconnue n'invente plus de pièce.
  expect(diag({ electricite: { present: true, since: 2019, proof: 'certificat_conformite', version: 1 }, gaz: { present: false, since: null, proof: 'declaration_vendeur', version: 1 } }, null)).toEqual([]);
  // Sans déclaration, rien ne change pour un local commercial ni pour la lecture prudente.
  expect(diag({}, null)).toEqual(['electricite:annee_construction_inconnue', 'gaz:chauffage_gaz']);
  expect(expectedPieces('commercial', sheet(1930), 2027)!.installations).toEqual([]);
  expect(expectedPieces('home', sheet(1965), 2027)!.installations.map((r) => r.verdict)).toEqual(['non_declaree', 'non_declaree']);
});

describeWithSqlite('AU084 · installations du bien, déclarées avec preuve', () => {
  const setup = async () => {
    const t = await setupDossier('maison');
    t.storage.refs.add(PROOF);
    const inst = new InstallationsBien(t.db, t.acces, t.journal, { now: t.now, proofs: t.storage });
    return { ...t, inst };
  };

  it('[R60] [R17] la déclaration prouvée fixe la demande exacte ; une correction s’ajoute, la plus récente vaut, rien ne s’efface', async () => {
    const t = await setup();
    const before = await t.pieces.status(t.agent, t.fileId);
    expect(before.ok && before.value.missing).toEqual(expect.arrayContaining(['electricite', 'gaz']));
    // La maison du jeu est de 2008 : en 2027, 19 ans ; son tableau électrique refait en 2016, sans gaz.
    expect(await t.inst.record(t.agent, t.propertyId, { installation: 'electricite', present: true, since: 2016, proof: 'certificat_conformite', proofRef: PROOF })).toEqual({
      ok: true,
      value: { installation: 'electricite', present: true, since: 2016, proof: 'certificat_conformite', version: 1 },
    });
    expect((await t.inst.record(t.agent, t.propertyId, { installation: 'gaz', present: false, proof: 'declaration_vendeur', proofRef: PROOF })).ok).toBe(true);
    const after = await t.pieces.status(t.agent, t.fileId);
    if (!after.ok) throw new Error('statut');
    expect(after.value.lines.map((l) => l.piece)).not.toEqual(expect.arrayContaining(['electricite']));
    expect(after.value.lines.some((l) => l.piece === 'gaz' || l.piece === 'electricite')).toBe(false);
    expect(after.value.installations.map((r) => `${r.installation}:${r.verdict}`)).toEqual(['electricite:recente', 'gaz:absente']);
    // Une pièce devenue inutile n'est plus attendue : la ranger est refusée.
    expect(await t.pieces.add(t.agent, t.fileId, { piece: 'gaz', ref: t.upload(), issuedOn: '2027-02-20' })).toMatchObject({ ok: false, code: 'not_expected' });
    // Le diagnostiqueur trouve une chaudière au gaz posée avec la maison : la direction corrige, le gaz revient.
    expect(await t.inst.record(t.direction, t.propertyId, { installation: 'gaz', present: true, since: 2008, proof: 'facture_travaux', proofRef: PROOF })).toMatchObject({ ok: true, value: { version: 2 } });
    const corrected = await t.pieces.status(t.agent, t.fileId);
    expect(corrected.ok && corrected.value.lines.find((l) => l.piece === 'gaz')?.reason).toBe('installation_declaree_plus_15_ans');
    const rows = await t.db.all<{ version: number; present: number }>("SELECT version, present FROM property_installations WHERE installation = 'gaz' ORDER BY version");
    expect(rows.map((r) => [Number(r.version), Number(r.present)])).toEqual([[1, 0], [2, 1]]);
    await expect(t.db.run('UPDATE property_installations SET present = 1')).rejects.toThrow(/ne change plus/);
    await expect(t.db.run('DELETE FROM property_installations')).rejects.toThrow(/rien ne s'efface/);
  });

  it('[R16] seuls l’agent du bien et la direction déclarent ; chaque refus au journal, rien de rangé', async () => {
    const t = await setup();
    const input = { installation: 'gaz', present: false, proof: 'declaration_vendeur', proofRef: PROOF };
    expect(await t.inst.record(t.sam, t.propertyId, input)).toMatchObject({ ok: false, rule: 'R16' });
    const compliance = { role: 'compliance' as const, networkId: t.network.id, userId: 'conformite-1' };
    expect(await t.inst.record(compliance, t.propertyId, input)).toMatchObject({ ok: false });
    expect(await t.inst.record(t.agent, 'bien-inconnu', input)).toMatchObject({ ok: false });
    const refused = (await t.journal.bySubject(`property:${t.propertyId}`)).filter((e) => e.type === 'acces.refuse');
    expect(refused.length).toBeGreaterThanOrEqual(2);
    expect(await t.db.first('SELECT 1 FROM property_installations')).toBeNull();
  });

  it('[R10] une saisie fautive est refusée sans rien ranger : installation, présence, année, preuve', async () => {
    const t = await setup();
    const ok = { installation: 'electricite', present: true, since: 2016, proof: 'certificat_conformite', proofRef: PROOF };
    expect(await t.inst.record(t.agent, t.propertyId, { ...ok, installation: 'eau' })).toMatchObject({ code: 'bad_installation' });
    expect(await t.inst.record(t.agent, t.propertyId, { ...ok, present: 'oui' })).toMatchObject({ code: 'bad_presence' });
    for (const since of [2028, 1700, '2016', 2016.5]) expect(await t.inst.record(t.agent, t.propertyId, { ...ok, since })).toMatchObject({ code: 'bad_year' });
    // Plus ancienne que la maison (2008) : impossible, rien n'est retiré.
    expect(await t.inst.record(t.agent, t.propertyId, { ...ok, since: 2001 })).toMatchObject({ code: 'before_build' });
    expect(await t.inst.record(t.agent, t.propertyId, { ...ok, present: false })).toMatchObject({ code: 'absence_with_year' });
    expect(await t.inst.record(t.agent, t.propertyId, { ...ok, proof: 'photo' })).toMatchObject({ code: 'bad_proof_kind' });
    expect(await t.inst.record(t.agent, t.propertyId, { ...ok, proofRef: 'mon-fichier.pdf' })).toMatchObject({ code: 'bad_proof' });
    expect(await t.inst.record(t.agent, t.propertyId, { ...ok, proofRef: 'preuves/0b6f1d2e-9999-4a2b-8c3d-000000000777.pdf' })).toMatchObject({ code: 'not_stored' });
    expect(await t.db.first('SELECT 1 FROM property_installations')).toBeNull();
  });

  it('un terrain n’a pas d’installation à déclarer', async () => {
    const t = await setupDossier('terrain');
    t.storage.refs.add(PROOF);
    const inst = new InstallationsBien(t.db, t.acces, t.journal, { now: t.now, proofs: t.storage });
    expect(await inst.record(t.agent, t.propertyId, { installation: 'gaz', present: false, proof: 'declaration_vendeur', proofRef: PROOF })).toMatchObject({ code: 'not_housing' });
  });

  it('[R13] au journal : l’installation et sa présence, jamais la preuve ni l’année', async () => {
    const t = await setup();
    await t.inst.record(t.agent, t.propertyId, { installation: 'electricite', present: true, since: 2016, proof: 'certificat_conformite', proofRef: PROOF });
    const events = (await t.journal.bySubject(`property:${t.propertyId}`)).filter((e) => e.type === 'obligations.installation_rangee');
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({ rule: 'R60', installation: 'electricite', present: true, version: 1 });
    expect(JSON.stringify(events)).not.toMatch(/preuves\/|2016/);
  });
});
