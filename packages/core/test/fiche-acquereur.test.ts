import { expect, it } from 'vitest';
import {
  Acces,
  FicheAcquereur,
  SqlJournalStore,
  applyMigrations,
  checkSearchChanges,
  createCaptation,
  fromSyncSqlite,
  verifyChain,
  type SqlDatabase,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const TUESDAY_10H = Date.parse('2026-12-08T09:00:00.000Z');

async function setup(withQualification = true) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = TUESDAY_10H;
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const { chaine, store, fiche, attribution, qualification } = createCaptation(db, journal, { now, withQualification });
  const acces = new Acces(db, store, fiche, journal, { now });
  const acquereurs = new FicheAcquereur(db, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  await attribution.addZone(network.id, alex.id, 'Talant');
  await attribution.addZone(network.id, sam.id, 'Dijon');
  let seq = 0;
  /** Un formulaire inventé, passé par toute la chaîne ; rend le projet d'achat ouvert. */
  const contact = async (who: string, message: string, email = `${who.toLowerCase()}@example.test`) => {
    seq += 1;
    await chaine.receive(network.id, 'site_form', { submissionId: `f-${seq}`, firstName: who, email, message });
    const q = await db.first<{ id: string; project_id: string | null; inbound_id: string }>(
      'SELECT id, project_id, inbound_id FROM qualifications ORDER BY rowid DESC LIMIT 1',
    );
    return q!;
  };
  const as = (role: 'agent' | 'direction' | 'compliance' | 'partner', userId: string) => ({ role, userId, networkId: network.id });
  return { db, journal, acces, acquereurs, qualification, network, alex, sam, contact, as };
}

describeWithSqlite('T01 · fiche acquéreur', () => {
  it('la qualification remplit la fiche avec ce que le message dit, et seulement cela, chaque champ avec sa source [R10]', async () => {
    const t = await setup();
    const q = await t.contact('Inès', 'Bonjour, je cherche une maison avec jardin à Talant, 4 pièces, budget maximum 320 000 €, prêt accordé, rapidement.');
    expect(q.project_id).not.toBeNull();
    const fiche = await t.acquereurs.current(q.project_id!);
    expect(fiche).not.toBeNull();
    expect(fiche!.version).toBe(1);
    expect(fiche!.search.propertyKinds).toEqual(['house']);
    expect(fiche!.search.communes).toEqual(['Talant']);
    expect(fiche!.search.features).toContain('garden');
    // Rien que le message ne dit : ni surface, ni chambres.
    expect(fiche!.search.surfaceMinM2).toBeNull();
    expect(fiche!.search.bedroomsMin).toBeNull();
    const filled = Object.entries(fiche!.search).filter(([, v]) => v !== null && v !== false && !(Array.isArray(v) && v.length === 0)).map(([k]) => k);
    expect(Object.keys(fiche!.sources).sort()).toEqual(filled.sort());
    for (const source of Object.values(fiche!.sources)) expect(source).toBe(`message:${q.inbound_id}`);
    expect(fiche!.origin).toBe(`qualification:${q.id}`);
  });

  it('une qualification ne sert qu’une fois, même rejouée [R18]', async () => {
    const t = await setup();
    const q = await t.contact('Léo', 'Je cherche un appartement à Talant avec balcon.');
    await t.acquereurs.fromQualification(q.id);
    await Promise.all([t.acquereurs.fromQualification(q.id), t.acquereurs.fromQualification(q.id)]);
    const n = await t.db.first<{ n: number }>('SELECT count(*) AS n FROM buyer_searches WHERE project_id = ?', [q.project_id]);
    expect(Number(n!.n)).toBe(1);
  });

  it('une qualification de vendeur ne crée aucune fiche acquéreur', async () => {
    const t = await setup();
    const q = await t.contact('Hugo', 'Je souhaite vendre ma maison à Talant.');
    expect(await t.acquereurs.fromQualification(q.id)).toBeNull();
    const n = await t.db.first<{ n: number }>('SELECT count(*) AS n FROM buyer_searches');
    expect(Number(n!.n)).toBe(0);
  });

  it('une modification de l’agent crée une version, l’ancienne reste lisible ; rien ne se réécrit ni ne s’efface [R17]', async () => {
    const t = await setup();
    const q = await t.contact('Inès', 'Je cherche une maison à Talant, budget 300 000 €.');
    const r = await t.acquereurs.update(t.acces, t.as('agent', t.alex.id), q.project_id!, { surfaceMinM2: 90, communes: ['Talant', 'Dijon'] });
    expect(r).toMatchObject({ ok: true, created: true });
    const read = await t.acquereurs.read(t.acces, t.as('agent', t.alex.id), q.project_id!);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.history.map((v) => v.version)).toEqual([1, 2]);
    expect(read.value.history[0]!.search.surfaceMinM2).toBeNull();
    expect(read.value.history[0]!.search.communes).toEqual(['Talant']);
    expect(read.value.current!.search).toMatchObject({ surfaceMinM2: 90, communes: ['Talant', 'Dijon'] });
    expect(read.value.current!.sources.surfaceMinM2).toBe(`agent:${t.alex.id}`);
    // La même modification une seconde fois ne crée rien.
    expect(await t.acquereurs.update(t.acces, t.as('agent', t.alex.id), q.project_id!, { surfaceMinM2: 90 })).toMatchObject({ ok: true, created: false });
    await expect(t.db.run('UPDATE buyer_searches SET budget_max_eur = 1')).rejects.toThrow();
    await expect(t.db.run('DELETE FROM buyer_searches')).rejects.toThrow();
  });

  it('deux modifications simultanées ne prennent jamais le même numéro de version', async () => {
    const t = await setup();
    const q = await t.contact('Inès', 'Je cherche une maison à Talant.');
    const agent = t.as('agent', t.alex.id);
    await Promise.all([
      t.acquereurs.update(t.acces, agent, q.project_id!, { roomsMin: 3 }),
      t.acquereurs.update(t.acces, agent, q.project_id!, { surfaceMinM2: 80 }),
    ]);
    const cur = await t.acquereurs.current(q.project_id!);
    expect(cur!.version).toBe(3);
    expect(cur!.search).toMatchObject({ roomsMin: 3, surfaceMinM2: 80 });
  });

  it('un champ écrit par l’agent n’est plus changé par un message ; un message suivant complète le reste', async () => {
    const t = await setup();
    const q1 = await t.contact('Inès', 'Je cherche une maison à Talant, budget 300 000 €.');
    await t.acquereurs.update(t.acces, t.as('agent', t.alex.id), q1.project_id!, { budgetMaxEur: 280_000 });
    const q2 = await t.contact('Inès', 'Je cherche toujours une maison à Talant, budget maximum 350 000 €, avec garage.');
    expect(q2.project_id).toBe(q1.project_id);
    const cur = await t.acquereurs.current(q1.project_id!);
    expect(cur!.search.budgetMaxEur).toBe(280_000);
    expect(cur!.search.features).toContain('garage');
    expect(cur!.sources.features).toBe(`message:${q2.inbound_id}`);
  });

  it('quand l’agent vide un critère, un message suivant ne le remet pas', async () => {
    const t = await setup();
    const q1 = await t.contact('Inès', 'Je cherche une maison à Talant, budget maximum 320 000 €.');
    await t.acquereurs.update(t.acces, t.as('agent', t.alex.id), q1.project_id!, { communes: null, budgetMaxEur: null });
    await t.contact('Inès', 'Je cherche toujours une maison à Talant, budget maximum 330 000 €, avec garage.');
    const cur = await t.acquereurs.current(q1.project_id!);
    expect(cur!.search.communes).toEqual([]);
    expect(cur!.search.budgetMaxEur).toBeNull();
    expect(cur!.search.features).toContain('garage');
  });

  it('un message plus ancien, traité après un plus récent, ne remplace pas ce que le récent a dit', async () => {
    const t = await setup(false);
    await t.contact('Inès', 'Je cherche une maison à Talant, budget maximum 200 000 €.');
    await t.contact('Inès', 'Je cherche une maison à Talant, budget maximum 300 000 €, avec garage.');
    const [ia, ib] = await t.db.all<{ id: string }>('SELECT id FROM inbound_messages ORDER BY received_at');
    const a = (await t.qualification.qualify(ia!.id))!;
    const b = (await t.qualification.qualify(ib!.id))!;
    expect(b.project_id).toBe(a.project_id);
    await t.acquereurs.fromQualification(b.id);
    await t.acquereurs.fromQualification(a.id);
    const cur = await t.acquereurs.current(a.project_id!);
    expect(cur!.search.budgetMaxEur).toBe(300_000);
    expect(cur!.sources.budgetMaxEur).toBe(`message:${b.inbound_id}`);
  });

  it('aucun champ hors liste, aucun critère discriminant : refusé [R50], au journal sans la valeur [R13]', async () => {
    const t = await setup();
    const q = await t.contact('Inès', 'Je cherche une maison à Talant.');
    const agent = t.as('agent', t.alex.id);
    const cases: [unknown, string, string | undefined][] = [
      [{ religion: 'catholique' }, 'discriminant', undefined],
      [{ situationDeFamille: 'couple' }, 'discriminant', undefined],
      [{ features: ['garden', 'sans enfants'] }, 'discriminant', 'features'],
      [{ features: ['proche de la mosquée', 'handicap'] }, 'discriminant', 'features'],
      [{ nationalite: 'française' }, 'discriminant', undefined],
      [{ note: 'très sympathique' }, 'champ_inconnu', undefined],
      [{ features: ['piscine chauffée'] }, 'hors_liste', 'features'],
      [{ communes: ['Paris'] }, 'hors_liste', 'communes'],
      [{ propertyKinds: ['château'] }, 'hors_liste', 'propertyKinds'],
      [{ financing: 'riche' }, 'hors_liste', 'financing'],
      [{ budgetMaxEur: -5 }, 'valeur', 'budgetMaxEur'],
      [{ surfaceMinM2: 12.5 }, 'valeur', 'surfaceMinM2'],
    ];
    for (const [input, code, field] of cases) {
      const r = await t.acquereurs.update(t.acces, agent, q.project_id!, input);
      expect(r, JSON.stringify(input)).toMatchObject({ ok: false, rule: 'R50', code });
      if (!r.ok) expect(r.field).toBe(field);
    }
    expect((await t.acquereurs.current(q.project_id!))!.version).toBe(1);
    const refused = (await t.journal.all()).filter((e) => e.type === 'acquereur.refuse');
    expect(refused).toHaveLength(cases.length);
    const text = JSON.stringify(refused);
    for (const word of ['catholique', 'couple', 'enfants', 'mosquée', 'française', 'sympathique', 'Paris', 'château', 'riche', 'Inès']) {
      expect(text).not.toContain(word);
    }
    expect((await verifyChain(await t.journal.all())).ok).toBe(true);
  });

  it('le contrôle est pur et normalise les communes de la liste fermée', () => {
    expect(checkSearchChanges({ communes: ['fontaine les dijon', 'Talant', 'talant'] })).toEqual({
      ok: true,
      value: { communes: ['Fontaine-lès-Dijon', 'Talant'] },
    });
    expect(checkSearchChanges({ urgency: 'now', bedroomsMin: 2, features: null })).toEqual({
      ok: true,
      value: { urgency: 'now', bedroomsMin: 2, features: [] },
    });
    // Une commune du réglage dont le nom contient un mot de la liste reste permise.
    expect(checkSearchChanges({ communes: ['Sainte-Marie-sur-Ouche'] }, ['Sainte-Marie-sur-Ouche'])).toMatchObject({ ok: true });
    expect(checkSearchChanges('maison')).toMatchObject({ ok: false, rule: 'R50', code: 'valeur' });
  });

  it('lecture et écriture sous R16 : un autre agent et un partenaire refusés, au journal ; la conformité lit sans écrire', async () => {
    const t = await setup();
    const q = await t.contact('Inès', 'Je cherche une maison à Talant.');
    expect(await t.acquereurs.read(t.acces, t.as('agent', t.sam.id), q.project_id!)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.acquereurs.update(t.acces, t.as('agent', t.sam.id), q.project_id!, { roomsMin: 2 })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.acquereurs.read(t.acces, t.as('partner', 'p1'), q.project_id!)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.acquereurs.read(t.acces, t.as('compliance', 'c1'), q.project_id!)).toMatchObject({ ok: true });
    expect(await t.acquereurs.update(t.acces, t.as('compliance', 'c1'), q.project_id!, { roomsMin: 2 })).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.acquereurs.update(t.acces, t.as('direction', 'd1'), q.project_id!, { roomsMin: 2 })).toMatchObject({ ok: true, created: true });
    // Un projet d'un autre réseau ou inconnu : refusé.
    expect(await t.acquereurs.read(t.acces, { role: 'direction', userId: 'd1', networkId: 'autre' }, q.project_id!)).toMatchObject({ ok: false, code: 'unknown' });
    const refusals = (await t.journal.all()).filter((e) => e.type === 'acces.refuse');
    expect(refusals.length).toBeGreaterThanOrEqual(5);
    // Aucune valeur de la recherche au journal [R13].
    const fiche = (await t.journal.all()).filter((e) => e.type === 'acquereur.fiche');
    expect(fiche.length).toBe(2);
    expect(JSON.stringify(fiche)).not.toMatch(/Talant|house|maison|Inès/);
  });
});
