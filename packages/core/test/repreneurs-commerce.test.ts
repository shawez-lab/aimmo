import { expect, it } from 'vitest';
import { Acces, SqlJournalStore, applyMigrations, createCaptation, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { EstimationCommerce, FicheCommerce, PresentationCommerce, RepreneursCommerce, checkBuyerChanges } from '../src/commerces/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const TUESDAY_10H = Date.parse('2027-09-07T08:00:00.000Z');

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = TUESDAY_10H;
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const { store, fiche } = createCaptation(db, journal, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const fiches = new FicheCommerce(db, journal, { now });
  const estimations = new EstimationCommerce(db, journal, fiches, { now });
  const presentations = new PresentationCommerce(db, journal, fiches, estimations, { now });
  const repreneurs = new RepreneursCommerce(db, journal, fiches, estimations, presentations, { now });
  const network = await store.createNetwork('Réseau test');
  const alexAgent = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const samAgent = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const as = (role: 'agent' | 'direction' | 'compliance' | 'partner', userId: string) => ({ role, userId, networkId: network.id });
  const alex = as('agent', alexAgent.id);
  const sam = as('agent', samAgent.id);
  const direction = as('direction', 'dir-1');
  await estimations.recordScale(direction, { activity: 'restaurant', method: 'revenue_pct', low: 5_000, high: 8_000, source: 'Barème inventé pour les tests', sourceDate: '2027-01-15' });
  await estimations.recordScale(direction, { activity: 'boulangerie_patisserie', method: 'revenue_pct', low: 6_000, high: 9_000, source: 'Barème inventé pour les tests', sourceDate: '2027-01-15' });
  let seq = 0;
  /** Un commerce de Sam, présenté et publiable si demandé. */
  const shop = async (activity: string, postalCode: string, revenueCents: number, published = true) => {
    const p = await store.createProperty({ networkId: network.id, agentId: samAgent.id, reference: `CE-${(seq += 1)}`, kind: 'business', status: 'available', city: postalCode === '21000' ? 'Dijon' : 'Beaune', postalCode });
    await fiches.update(acces, sam, p.id, { activity, signName: `Enseigne Inventée ${seq}`, fiscalYears: [{ year: 2026, revenueCents, resultCents: 1_000_000 }] });
    const e = await estimations.estimate(acces, sam, p.id, 'revenue_pct');
    if (!e.ok || e.status !== 'ok') throw new Error('estimation');
    await estimations.validate(acces, sam, e.value.id);
    const d = await presentations.propose(acces, sam, p.id);
    if (!d.ok) throw new Error('présentation');
    if (published) await presentations.validate(acces, sam, d.value.id);
    return p;
  };
  /** Un repreneur suivi par Alex, avec son projet `buy_business`. */
  const buyer = async (first: string) => {
    const person = await store.createPerson({ networkId: network.id, agentId: alexAgent.id, firstName: first, lastName: 'Inventé' });
    return store.createProject({ networkId: network.id, agentId: alexAgent.id, personId: person.id, kind: 'buy_business' });
  };
  return { db, journal, acces, repreneurs, alex, sam, direction, compliance: as('compliance', 'conf-1'), shop, buyer, store, network, alexAgent };
}

describeWithSqlite('CE06 · repreneurs, sans évaluation de solvabilité', () => {
  it('[R115] [R14] aucun champ de revenus, de patrimoine, de crédit ni de solvabilité, ni dans la table ni dans l’entrée', async () => {
    const t = await setup();
    const cols = await t.db.all<{ name: string }>("SELECT name FROM pragma_table_info('business_buyer_profiles')");
    expect(cols.length).toBeGreaterThan(5);
    for (const c of cols) expect(c.name).not.toMatch(/revenu|income|salair|salary|patrimoine|wealth|asset|credit|score|solvab|dette|debt|rating|risque|risk|note|grade|rang/i);
    for (const field of ['income', 'revenus', 'patrimoine', 'creditScore', 'solvabilite', 'note', 'risque', 'dettes']) {
      expect(checkBuyerChanges({ [field]: 1 }), field).toEqual({ ok: false, rule: 'R115', code: 'champ_inconnu', field });
    }
    const project = await t.buyer('Camille');
    expect(await t.repreneurs.update(t.acces, t.alex, project.id, { budgetMaxEur: 300_000, revenusMensuels: 4_200 })).toMatchObject({ ok: false, rule: 'R115', code: 'champ_inconnu' });
    // Rien n'est rangé d'une entrée refusée ; au journal, ni la valeur ni le nom du champ inconnu [R13].
    expect(await t.db.all('SELECT 1 FROM business_buyer_profiles')).toHaveLength(0);
    const text = JSON.stringify(await t.journal.all());
    expect(text).not.toContain('revenusMensuels');
    expect(text).not.toContain('4200');
  });

  it('[R10] [R17] chaque champ porte sa source ; rien n’est inventé ; chaque version reste', async () => {
    const t = await setup();
    const project = await t.buyer('Camille');
    const v1 = await t.repreneurs.update(t.acces, t.alex, project.id, { activities: ['restaurant'], postalCodes: ['21000'], declaredContributionEur: 80_000, declaredFinancing: 'pret_et_apport' });
    expect(v1).toMatchObject({
      ok: true,
      value: {
        version: 1,
        profile: { activities: ['restaurant'], kinds: [], postalCodes: ['21000'], budgetMaxEur: null, experience: null, declaredContributionEur: 80_000, declaredFinancing: 'pret_et_apport' },
        sources: { activities: `agent:${t.alex.userId}`, postalCodes: `agent:${t.alex.userId}`, declaredContributionEur: `agent:${t.alex.userId}`, declaredFinancing: `agent:${t.alex.userId}` },
      },
    });
    const v2 = await t.repreneurs.update(t.acces, t.direction, project.id, { experience: 'reconversion', declaredContributionEur: null });
    expect(v2).toMatchObject({ ok: true, value: { version: 2, profile: { experience: 'reconversion', declaredContributionEur: null }, sources: { experience: 'direction:dir-1' } } });
    if (v2.ok) expect(v2.value!.sources).not.toHaveProperty('declaredContributionEur');
    // La même entrée ne crée pas de version.
    expect(await t.repreneurs.update(t.acces, t.alex, project.id, { experience: 'reconversion' })).toMatchObject({ ok: true, value: { version: 2 } });
    const read = await t.repreneurs.read(t.acces, t.alex, project.id);
    expect(read.ok && read.value.history.map((h) => h.version)).toEqual([1, 2]);
    expect(checkBuyerChanges({ activities: ['casino'] })).toMatchObject({ ok: false, code: 'hors_liste' });
    expect(checkBuyerChanges({ kinds: ['house'] })).toMatchObject({ ok: false, code: 'hors_liste' });
    expect(checkBuyerChanges({ postalCodes: ['Dijon'] })).toMatchObject({ ok: false, code: 'valeur' });
    expect(checkBuyerChanges({ budgetMaxEur: -1 })).toMatchObject({ ok: false, code: 'valeur' });
    await expect(t.db.run('UPDATE business_buyer_profiles SET budget_max_eur = 1')).rejects.toThrow(/ne se réécrit pas/);
    await expect(t.db.run('DELETE FROM business_buyer_profiles')).rejects.toThrow(/rien ne s'efface/);
  });

  it('[R14] le rapprochement ne range que des biens publiés, par des règles écrites, sans jamais lire ni noter la personne', async () => {
    const t = await setup();
    // Fourchettes basses : 60 % de 50 000 € = 30 000 € ; 50 % de 40 000 € = 20 000 € ; 50 % de 90 000 € = 45 000 €.
    const bakery = await t.shop('boulangerie_patisserie', '21000', 5_000_000);
    const cheap = await t.shop('restaurant', '21000', 4_000_000);
    const dear = await t.shop('restaurant', '21000', 9_000_000);
    await t.shop('restaurant', '21200', 4_000_000);
    await t.shop('restaurant', '21000', 3_000_000, false);
    const a = await t.buyer('Camille');
    const b = await t.buyer('Dominique');
    const criteria = { activities: ['restaurant', 'boulangerie_patisserie'], postalCodes: ['21000'], budgetMaxEur: 40_000 };
    await t.repreneurs.update(t.acces, t.alex, a.id, { ...criteria, experience: 'gerant_du_metier', declaredContributionEur: 300_000, declaredFinancing: 'apport_seul' });
    await t.repreneurs.update(t.acces, t.alex, b.id, { ...criteria, experience: 'aucune', declaredContributionEur: 0, declaredFinancing: 'a_definir' });
    const ma = await t.repreneurs.match(t.acces, t.alex, a.id);
    const mb = await t.repreneurs.match(t.acces, t.alex, b.id);
    // Hors secteur, hors budget, non publié : écartés ; le reste par fourchette basse croissante.
    expect(ma.ok && ma.value.map((m) => [m.propertyId, m.priceLowEuros])).toEqual([
      [cheap.id, 20_000],
      [bakery.id, 30_000],
    ]);
    expect(ma.ok && ma.value.map((m) => m.propertyId)).not.toContain(dear.id);
    // Deux repreneurs que tout sépare sauf leur recherche reçoivent exactement la même liste.
    expect(mb).toEqual(ma);
    // Aucun nom d'enseigne ni chiffre confidentiel dans le résultat [R110].
    expect(JSON.stringify(ma)).not.toMatch(/Enseigne Inventée|5000000|4000000/);
    // Sans profil, rien n'est inventé.
    expect(await t.repreneurs.match(t.acces, t.alex, (await t.buyer('Eden')).id)).toEqual({ ok: true, value: [] });
  });

  it('[R16] un autre agent est refusé ; la conformité lit sans écrire ; un projet d’une autre sorte est refusé', async () => {
    const t = await setup();
    const project = await t.buyer('Camille');
    await t.repreneurs.update(t.acces, t.alex, project.id, { budgetMaxEur: 100_000 });
    expect(await t.repreneurs.read(t.acces, t.sam, project.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.repreneurs.update(t.acces, t.sam, project.id, { budgetMaxEur: 1 })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.repreneurs.match(t.acces, t.sam, project.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.repreneurs.read(t.acces, t.compliance, project.id)).toMatchObject({ ok: true });
    expect(await t.repreneurs.update(t.acces, t.compliance, project.id, { budgetMaxEur: 1 })).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    expect(JSON.stringify(await t.journal.all())).toContain('business_buyer');
    const person = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexAgent.id, firstName: 'Lou', lastName: 'Inventé' });
    const home = await t.store.createProject({ networkId: t.network.id, agentId: t.alexAgent.id, personId: person.id, kind: 'buy' });
    expect(await t.repreneurs.update(t.acces, t.alex, home.id, { budgetMaxEur: 1 })).toMatchObject({ ok: false, code: 'projet' });
  });
});

it('[R14] le rapprochement ne lit ni l’apport, ni le financement, ni l’expérience', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/commerces/repreneurs.ts', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('async match('), source.indexOf('private async gate('));
  expect(body).not.toMatch(/declaredContribution|declaredFinancing|experience/);
});
