import { expect, it } from 'vitest';
import {
  GeographieReseau,
  Qualification,
  ReconnaissanceBien,
  SqlJournalStore,
  applyMigrations,
  createCaptation,
  fromSyncSqlite,
  isInseeCode,
  type DiffusionGate,
  type SqlDatabase,
} from '../src/index.ts';
import { Acces } from '../src/acces/acces.ts';
import { FicheAcquereur } from '../src/acquereurs/fiche-acquereur.ts';
import { Rapprochement } from '../src/acquereurs/rapprochement.ts';
import { RechercheLangage } from '../src/recherche/langage-courant.ts';
import { DEFAULT_COMMUNES } from '../src/qualification/regles.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Jeu inventé : un réseau ouvert à Lyon, un autre resté sur la liste du pilote. Les codes INSEE sont ceux de l'exemple.
const TUESDAY_10H = new Date('2026-12-08T09:00:00.000Z');
const LYON = { inseeCode: '69123', name: 'Lyon' };
const VILLEURBANNE = { inseeCode: '69266', name: 'Villeurbanne' };

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => TUESDAY_10H;
  const journal = new SqlJournalStore(db);
  const { chaine, store, reception, fiche } = createCaptation(db, journal, { now, withQualification: false });
  const qualification = new Qualification(db, store, fiche, reception, new ReconnaissanceBien(db), journal, { now });
  const geographie = new GeographieReseau(db, journal, { now });
  const lyon = await store.createNetwork('Réseau de Lyon');
  const pilote = await store.createNetwork('Réseau pilote');
  const direction = { role: 'direction' as const, userId: 'dir-1', networkId: lyon.id };
  let seq = 0;
  const form = async (networkId: string, message: string): Promise<string> => {
    seq += 1;
    await chaine.receive(networkId, 'site_form', { submissionId: `g-${seq}`, firstName: 'Zoé', email: `zoe${seq}@example.test`, message });
    const row = await db.first<{ id: string }>('SELECT id FROM inbound_messages ORDER BY rowid DESC LIMIT 1');
    return row!.id;
  };
  const diffusion: DiffusionGate = { canDiffuse: async () => ({ allowed: true, reason: 'allowed' }) };
  const rapprochement = new Rapprochement(db, fiche, diffusion, journal, { now });
  const recherche = new RechercheLangage(db, rapprochement, diffusion, journal, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const acquereurs = new FicheAcquereur(db, journal, { now });
  return { db, journal, qualification, geographie, lyon, pilote, direction, form, recherche, store, acces, acquereurs };
}

const inscribe = (t: Awaited<ReturnType<typeof setup>>, c: { inseeCode: string; name: string }) =>
  t.geographie.decide(t.direction, { ...c, listed: true, reason: 'Ouverture du secteur' });

describeWithSqlite('AU039 · les communes viennent du paramétrage géographique du réseau', () => {
  it('le constat de l’audit : « Lyon » est reconnu dès que la direction l’inscrit, sans toucher au code [R679]', async () => {
    const t = await setup();
    // Avant : rien d'inscrit, la liste du pilote ; Lyon ressort inconnu.
    const before = await t.qualification.qualify(await t.form(t.lyon.id, 'Je cherche un appartement à Lyon, budget 300 000 €.'));
    expect(before?.city).toBeNull();
    expect(await inscribe(t, LYON)).toMatchObject({ ok: true, value: { inseeCode: '69123', name: 'Lyon', version: 1, listed: true } });
    const after = await t.qualification.qualify(await t.form(t.lyon.id, 'Je cherche un appartement à Lyon, budget 300 000 €.'));
    expect(after?.city).toBe('Lyon');
    expect(await t.geographie.inseeOf(t.lyon.id, 'lyon')).toBe('69123');
  });

  it('dès sa première commune inscrite, seule la liste du réseau compte ; un autre réseau garde la sienne [R679]', async () => {
    const t = await setup();
    await inscribe(t, LYON);
    const dijonALyon = await t.qualification.qualify(await t.form(t.lyon.id, 'Je vends ma maison à Dijon.'));
    expect(dijonALyon?.city).toBeNull();
    const dijonAuPilote = await t.qualification.qualify(await t.form(t.pilote.id, 'Je vends ma maison à Dijon.'));
    expect(dijonAuPilote?.city).toBe('Dijon');
    expect(await t.geographie.geography(t.pilote.id)).toMatchObject({ source: 'defaut' });
    expect((await t.geographie.geography(t.pilote.id)).communes).toHaveLength(DEFAULT_COMMUNES.length);
    expect(await t.geographie.geography(t.lyon.id)).toEqual({ source: 'reseau', communes: [{ name: 'Lyon', inseeCode: '69123' }] });
  });

  it('la recherche en langage courant lit les communes du réseau [R679]', async () => {
    const t = await setup();
    await inscribe(t, LYON);
    await inscribe(t, VILLEURBANNE);
    const search = await t.recherche.build(t.lyon.id, 'Appartement à Villeurbanne, budget 250 000 €');
    expect(search.criteria.filter((c) => c.field === 'communes').map((c) => c.value)).toEqual(['Villeurbanne']);
    const pilote = await t.recherche.build(t.pilote.id, 'Appartement à Villeurbanne, budget 250 000 €');
    expect(pilote.criteria.filter((c) => c.field === 'communes')).toEqual([]);
  });

  it('une commune retirée n’est plus reconnue ; le retrait garde le nom et s’ajoute en version [R679] [R17]', async () => {
    const t = await setup();
    await inscribe(t, LYON);
    await inscribe(t, VILLEURBANNE);
    expect(await t.geographie.decide(t.direction, { inseeCode: '69266', listed: false, reason: 'Secteur fermé' })).toMatchObject({
      ok: true,
      value: { name: 'Villeurbanne', version: 2, listed: false },
    });
    expect(await t.geographie.names(t.lyon.id)).toEqual(['Lyon']);
    const q = await t.qualification.qualify(await t.form(t.lyon.id, 'Je cherche une maison à Villeurbanne.'));
    expect(q?.city).toBeNull();
    // Rouvrir s'ajoute aussi.
    expect(await inscribe(t, VILLEURBANNE)).toMatchObject({ ok: true, value: { version: 3 } });
  });

  it('la direction seule inscrit ou retire, le refus est au journal [R16]', async () => {
    const t = await setup();
    const agent = { role: 'agent' as const, userId: 'a-1', networkId: t.lyon.id };
    expect(await t.geographie.decide(agent, { ...LYON, listed: true, reason: 'Ouverture' })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    const events = await t.db.all<{ type: string; data: string }>("SELECT type, data FROM journal WHERE type = 'acces.refuse'");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.data)).toMatchObject({ rule: 'R16', kind: 'network_commune' });
    expect(await t.geographie.names(t.lyon.id)).toEqual([...DEFAULT_COMMUNES].sort((a, b) => a.localeCompare(b, 'fr')));
  });

  it('un code INSEE mal formé, un nom vide ou déjà pris, un état inchangé sont refusés [R679]', async () => {
    const t = await setup();
    expect(isInseeCode('69123')).toBe(true);
    expect(isInseeCode('2A004')).toBe(true);
    expect(isInseeCode('6912')).toBe(false);
    expect(isInseeCode('Lyon!')).toBe(false);
    const d = (input: Record<string, unknown>) => t.geographie.decide(t.direction, input);
    expect(await d({ inseeCode: '6912', name: 'Lyon', listed: true, reason: 'Ouverture' })).toMatchObject({ ok: false, code: 'bad_insee' });
    expect(await d({ inseeCode: '69123', name: '  ', listed: true, reason: 'Ouverture' })).toMatchObject({ ok: false, code: 'bad_name' });
    expect(await d({ inseeCode: '69123', name: 'Lyon', listed: true, reason: 'x' })).toMatchObject({ ok: false, code: 'bad_reason' });
    expect(await d({ inseeCode: '69123', name: 'Lyon', listed: true, reason: 'Ouverture', extra: 1 })).toMatchObject({ ok: false, code: 'unknown_field' });
    expect(await d({ inseeCode: '69123', listed: false, reason: 'Fermeture' })).toMatchObject({ ok: false, rule: 'R679', code: 'deja_retiree' });
    await inscribe(t, LYON);
    expect(await inscribe(t, LYON)).toMatchObject({ ok: false, rule: 'R679', code: 'deja_inscrite' });
    expect(await d({ inseeCode: '69381', name: 'lyon', listed: true, reason: 'Ouverture' })).toMatchObject({ ok: false, rule: 'R679', code: 'nom_deja_pris' });
    const refused = await t.db.all("SELECT 1 FROM journal WHERE type = 'geographie.refuse'");
    expect(refused.length).toBe(7);
  });

  it('la base refuse de changer ou d’effacer une version, et une version hors suite [R679] [R17]', async () => {
    const t = await setup();
    await inscribe(t, LYON);
    await expect(t.db.run("UPDATE network_communes SET commune = 'Autre'")).rejects.toThrow(/ne change plus/);
    await expect(t.db.run('DELETE FROM network_communes')).rejects.toThrow(/rien ne s'efface/);
    await expect(
      t.db.run(
        "INSERT INTO network_communes (network_id, insee_code, version, commune, commune_key, is_listed, reason, decided_by, decided_at) VALUES (?, '69123', 3, 'Lyon', 'lyon', 1, 'Saut', 'direction:x', ?)",
        [t.lyon.id, TUESDAY_10H.toISOString()],
      ),
    ).rejects.toThrow(/hors suite/);
    await expect(
      t.db.run(
        "INSERT INTO network_communes (network_id, insee_code, version, commune, commune_key, is_listed, reason, decided_by, decided_at) VALUES (?, '69266', 1, 'Villeurbanne', 'villeurbanne', 1, 'Ouverture', 'agent:x', ?)",
        [t.lyon.id, TUESDAY_10H.toISOString()],
      ),
    ).rejects.toThrow();
    const inscribed = await t.db.all("SELECT 1 FROM journal WHERE type = 'geographie.commune'");
    expect(inscribed).toHaveLength(1);
  });
  it('deux inscriptions du même nom en même temps : une seule passe, la base refuse l’autre [R679]', async () => {
    const t = await setup();
    const [a, b] = await Promise.all([
      t.geographie.decide(t.direction, { inseeCode: '69123', name: 'Lyon', listed: true, reason: 'Ouverture' }),
      t.geographie.decide(t.direction, { inseeCode: '69381', name: 'LYON', listed: true, reason: 'Ouverture' }),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a, b].find((r) => !r.ok)).toMatchObject({ rule: 'R679', code: 'nom_deja_pris' });
    expect(await t.geographie.names(t.lyon.id)).toHaveLength(1);
    await expect(
      t.db.run(
        "INSERT INTO network_communes (network_id, insee_code, version, commune, commune_key, is_listed, reason, decided_by, decided_at) VALUES (?, '69382', 1, 'Lyon', 'lyon', 1, 'Direct', 'direction:x', ?)",
        [t.lyon.id, TUESDAY_10H.toISOString()],
      ),
    ).rejects.toThrow(/nom déjà inscrit/);
  });

  it('la fiche acquéreur range une commune du réseau, celle que la recherche a lue [R679]', async () => {
    const t = await setup();
    await inscribe(t, LYON);
    const agent = await t.store.createAgent({ networkId: t.lyon.id, firstName: 'Alex', lastName: 'Agent' });
    const person = await t.store.createPerson({ networkId: t.lyon.id, agentId: agent.id, firstName: 'Camille' });
    const project = await t.store.createProject({ networkId: t.lyon.id, agentId: agent.id, personId: person.id, kind: 'buy' });
    const viewer = { role: 'agent' as const, userId: agent.id, networkId: t.lyon.id };
    const r = await t.acquereurs.update(t.acces, viewer, project.id, { communes: ['Lyon'] });
    expect(r).toMatchObject({ ok: true });
    expect((await t.acquereurs.current(project.id))?.search.communes).toEqual(['Lyon']);
    const dijon = await t.acquereurs.update(t.acces, viewer, project.id, { communes: ['Dijon'] });
    expect(dijon.ok).toBe(false);
  });
});
