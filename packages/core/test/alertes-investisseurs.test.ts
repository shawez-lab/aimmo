import { expect, it } from 'vitest';
import { ALERT_PURPOSE, Acces, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, type DiffusionGate, type SqlDatabase } from '../src/index.ts';
import { AlertesInvestisseurs, LoyersMarche, PROFESSIONAL_REFERRAL, ProfilInvestisseur, forbiddenPhrases, matches, type InvestorProfileVersion } from '../src/investir/index.ts';
import { mergeWithDouble } from './doublon.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Un mardi à 10 h, heure de Paris.
const TUESDAY_10H = Date.parse('2027-09-14T08:00:00.000Z');
const DAY = 86_400_000;
const BASE = 'https://aimmo.example.test/alertes/desinscription/';
const FEES = { value: 750, source: 'direction:d1', asOf: '2027-09-01', hypothesis: 'barème de l’ancien' };

async function setup(options: { fees?: boolean } = {}) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = TUESDAY_10H;
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const blocked = new Set<string>();
  const diffusion: DiffusionGate = { canDiffuse: async (_n, id) => (blocked.has(id) ? { allowed: false, reason: 'withdrawal_period' } : { allowed: true, reason: 'allowed' }) };
  const alertes = new AlertesInvestisseurs(db, journal, { now, diffusion, unsubscribeBase: BASE, ...(options.fees === false ? {} : { feesRateBp: FEES }) });
  const profils = new ProfilInvestisseur(db, journal, { now });
  const loyers = new LoyersMarche(db, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const direction = { role: 'direction' as const, userId: 'd1', networkId: network.id };
  await loyers.importAnil(direction, { kind: 'apartment', vintage: 2026, csv: 'INSEE_C;loypredm2;lwr.IPm2;upr.IPm2;nbobs_com\n99001;12,35;10,10;15,01;120' });
  let n = 0;
  /** Un investisseur inventé, avec son profil et, s'il le faut, son accord pour les alertes. */
  const investor = async (firstName: string, profile: Record<string, unknown>, consent: boolean = true) => {
    n += 1;
    const person = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName });
    await store.addIdentifier({ networkId: network.id, personId: person.id, kind: 'email', value: `investisseur${n}@example.test` });
    if (consent) await store.addConsent({ networkId: network.id, personId: person.id, purpose: ALERT_PURPOSE, channel: 'email', proof: 'formulaire de test', givenAt: new Date(TUESDAY_10H - 10 * DAY) });
    const project = await store.createProject({ networkId: network.id, agentId: alex.id, personId: person.id, kind: 'invest' });
    const r = await profils.update(acces, direction, project.id, profile);
    if (!r.ok) throw new Error(r.code);
    return { person, project };
  };
  const property = async (ref: string, energyClass: string | null = 'C', insee = '99001') => {
    const p = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: ref, kind: 'home', city: 'Commune Une', priceEur: 150_000, surfaceM2: 45, rooms: 2, status: 'available' });
    if (energyClass) {
      await db.run("INSERT INTO property_sheets (id, property_id, network_id, version, data, created_by, created_at) VALUES (?, ?, ?, 1, ?, 'agent:a', '2027-01-01')", [
        `s-${ref}`,
        p.id,
        network.id,
        JSON.stringify({ energy: { energyClass }, coownership: { isCoownership: false } }),
      ]);
    }
    const r = await alertes.recordPropertyCommune(acces, { role: 'agent', userId: alex.id, networkId: network.id }, p.id, { inseeCode: insee, rentKind: 'apartment' });
    if (!r.ok) throw new Error(r.code);
    return p;
  };
  const sent = (personId?: string) =>
    db.all<{ id: string; body: string; person_id: string }>(
      `SELECT m.id, m.body, m.person_id FROM messages m JOIN trial_outbox t ON t.message_id = m.id ${personId ? 'WHERE m.person_id = ?' : ''} ORDER BY m.occurred_at`,
      personId ? [personId] : [],
    );
  return { db, store, journal, acces, alertes, profils, network, alex, direction, investor, property, sent, blocked, setClock: (t: number) => (clock = t) };
}

const PROFILE = { sectors: ['99001'], budgetCents: 20_000_000, rentalTarget: 'furnished', targetGrossYieldBp: 350 };

describeWithSqlite('Y06 · alertes aux investisseurs, en mode essai', () => {
  it('[R03] [R26] une alerte seulement à l’investisseur qui l’a demandée, avec le calcul, rangée dans la boîte d’essai', async () => {
    const t = await setup();
    const yes = await t.investor('Inès', PROFILE);
    const no = await t.investor('Léo', PROFILE, false);
    const prop = await t.property('B1');
    const out = await t.alertes.forProperty(t.network.id, prop.id);
    expect(out.find((o) => o.personId === yes.person.id)).toMatchObject({ status: 'sent' });
    expect(out.find((o) => o.personId === no.person.id)).toMatchObject({ status: 'no_consent', rule: 'R03' });
    const msgs = await t.sent();
    expect(msgs).toHaveLength(1);
    const body = msgs[0]!.body;
    // Le calcul fait à la main, sans travaux : coût 150 000 + 11 250 = 161 250 € ; loyer 12,35 × 45 = 555,75 € par mois,
    // 6 669 € par an → 6 669 / 161 250 = 4,14 % ; bas 10,10 €/m² → 5 454 / 161 250 = 3,38 % ; haut 15,01 €/m² → 8 105,40 / 161 250 = 5,03 %.
    expect(body).toContain('Rendement brut estimé avant frais de gestion et impôts : 4,14 %, de 3,38 % à 5,03 %');
    expect(body).toContain('Estimations ANIL, à partir des données du Groupe SeLoger et de leboncoin, millésime 2026');
    expect(body).toContain(PROFESSIONAL_REFERRAL);
    expect(body).toContain(`Ne plus recevoir ces alertes : ${BASE}`);
    // La mention légale de l'assistant, ajoutée par le contrôle central en tête [R06], mise à part : aucune tournure interdite.
    expect(body.split('\n\n')[0]).toMatch(/^Réponse immédiate de l’assistant/);
    expect(forbiddenPhrases(body.split('\n\n').slice(1).join('\n\n'))).toEqual([]);
    // Rien ne part dehors : la boîte d'essai seulement.
    expect((await t.journal.all()).filter((e) => e.type === 'investir.alerte.essai').every((e) => (e.data as { sent: boolean }).sent === false)).toBe(true);
  });

  it('[R05] jamais deux fois le même bien à la même personne, même relancé ou passé deux fois en même temps', async () => {
    const t = await setup();
    const i = await t.investor('Inès', PROFILE);
    const prop = await t.property('B1');
    await Promise.all([t.alertes.forProperty(t.network.id, prop.id), t.alertes.forProperty(t.network.id, prop.id)]);
    await t.alertes.run();
    expect(await t.sent(i.person.id)).toHaveLength(1);
  });

  it('[R124] un bien classé G porte l’alerte en tête pour qui veut louer, et reste signalé pour qui ne veut pas', async () => {
    const t = await setup();
    const renter = await t.investor('Inès', PROFILE);
    const owner = await t.investor('Noé', { ...PROFILE, rentalTarget: 'none' });
    const prop = await t.property('G1', 'G');
    await t.alertes.forProperty(t.network.id, prop.id);
    const r = (await t.sent(renter.person.id))[0]!.body;
    expect(r.split('\n\n')[2]).toBe('Interdit à la location : classe énergie G, interdite à la location depuis le 01/01/2025.');
    const o = (await t.sent(owner.person.id))[0]!.body;
    expect(o.split('\n\n')[2]).not.toMatch(/^Interdit/);
    expect(o).toContain('Interdit à la location : classe énergie G');
    // Classe inconnue : à vérifier en tête.
    const t2 = await setup();
    const x = await t2.investor('Inès', PROFILE);
    const unknown = await t2.property('U1', null);
    await t2.alertes.forProperty(t2.network.id, unknown.id);
    expect((await t2.sent(x.person.id))[0]!.body.split('\n\n')[2]).toBe('Classe énergie inconnue : à vérifier avant toute proposition de location.');
  });

  it('[R124] une classe passée à G entre la préparation et l’envoi ne part pas sans l’alerte', async () => {
    const t = await setup();
    const i = await t.investor('Inès', PROFILE);
    const prop = await t.property('C1', 'C');
    // Le contrôle central relit la condition juste avant d'enregistrer : la fiche change entre-temps.
    const original = t.db.run.bind(t.db);
    let swapped = false;
    t.db.run = async (sql, params) => {
      if (!swapped && /INSERT INTO investor_alerts/.test(sql)) {
        swapped = true;
        const r = await original(sql, params);
        await original("INSERT INTO property_sheets (id, property_id, network_id, version, data, created_by, created_at) VALUES ('s-C1-2', ?, ?, 2, ?, 'agent:a', '2027-09-14')", [
          prop.id,
          t.network.id,
          JSON.stringify({ energy: { energyClass: 'G' }, coownership: { isCoownership: false } }),
        ]);
        return r;
      }
      return original(sql, params);
    };
    const out = await t.alertes.forProperty(t.network.id, prop.id);
    expect(out[0]).toMatchObject({ status: 'refused', rule: 'R124' });
    expect(await t.sent(i.person.id)).toHaveLength(0);
  });

  it('secteur, budget, location visée et rendement attendu : un critère manquant ou non rempli ne laisse rien partir', async () => {
    const t = await setup();
    const far = await t.investor('A', { ...PROFILE, sectors: ['99002'] });
    const poor = await t.investor('B', { ...PROFILE, budgetCents: 14_000_000 });
    const greedy = await t.investor('C', { ...PROFILE, targetGrossYieldBp: 415 });
    const vague = await t.investor('D', { budgetCents: 20_000_000 });
    const ok = await t.investor('E', { ...PROFILE, targetGrossYieldBp: 414 });
    const prop = await t.property('B1');
    await t.alertes.forProperty(t.network.id, prop.id);
    for (const p of [far, poor, greedy, vague]) expect(await t.sent(p.person.id)).toHaveLength(0);
    expect(await t.sent(ok.person.id)).toHaveLength(1);
    // Sans barème réglé, aucun rendement : un investisseur qui attend un rendement ne reçoit rien.
    const t2 = await setup({ fees: false });
    const i = await t2.investor('Inès', PROFILE);
    const plain = await t2.investor('Noé', { ...PROFILE, targetGrossYieldBp: null });
    const p2 = await t2.property('B1');
    await t2.alertes.forProperty(t2.network.id, p2.id);
    expect(await t2.sent(i.person.id)).toHaveLength(0);
    const body = (await t2.sent(plain.person.id))[0]!.body;
    expect(body).not.toMatch(/Rendement/);
  });

  it('un bien sans commune rangée, ou qui ne peut plus être diffusé, ne part pas', async () => {
    const t = await setup();
    const i = await t.investor('Inès', PROFILE);
    const bare = await t.store.createProperty({ networkId: t.network.id, agentId: t.alex.id, reference: 'N1', kind: 'home', city: 'Commune Une', priceEur: 150_000, surfaceM2: 45, rooms: 2, status: 'available' });
    expect(await t.alertes.forProperty(t.network.id, bare.id)).toEqual([]);
    const prop = await t.property('B1');
    t.blocked.add(prop.id);
    expect(await t.alertes.forProperty(t.network.id, prop.id)).toEqual([]);
    expect(await t.sent(i.person.id)).toHaveLength(0);
  });

  it('[R16] seul l’agent du bien ou la direction range sa commune, une seule fois', async () => {
    const t = await setup();
    const sam = await t.store.createAgent({ networkId: t.network.id, firstName: 'Sam', lastName: 'Agent' });
    const p = await t.store.createProperty({ networkId: t.network.id, agentId: t.alex.id, reference: 'N1', kind: 'home', city: 'X', priceEur: 1, surfaceM2: 10, rooms: 1, status: 'available' });
    expect(await t.alertes.recordPropertyCommune(t.acces, { role: 'agent', userId: sam.id, networkId: t.network.id }, p.id, { inseeCode: '99001', rentKind: 'apartment' })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.alertes.recordPropertyCommune(t.acces, t.direction, p.id, { inseeCode: 'Talant', rentKind: 'apartment' })).toMatchObject({ ok: false, code: 'insee' });
    expect(await t.alertes.recordPropertyCommune(t.acces, t.direction, p.id, { inseeCode: '99001', rentKind: 'apartment' })).toEqual({ ok: true });
    expect(await t.alertes.recordPropertyCommune(t.acces, t.direction, p.id, { inseeCode: '99002', rentKind: 'house' })).toMatchObject({ ok: false, code: 'deja_rangee' });
    await expect(t.db.run('UPDATE property_communes SET insee_code = ?', ['99002'])).rejects.toThrow(/ne change plus/);
  });

  it('[R08] AC10 : sur une fiche réunie, l’alerte salue par le prénom de la fiche gardée', async () => {
    const t = await setup();
    const ines = await t.investor('Inès', PROFILE);
    const expected = await mergeWithDouble(t.db, t.store, ines.person.id, 'Inna');
    const prop = await t.property('B1');
    const out = await t.alertes.forProperty(t.network.id, prop.id);
    expect(out).toEqual([expect.objectContaining({ status: 'sent' })]);
    const all = await t.sent();
    expect(all).toHaveLength(1);
    expect(all[0]!.body).toContain(`Bonjour ${expected}`);
  });
});

it('le profil correspond seulement quand tout est dit et rempli', () => {
  const v = (p: Partial<InvestorProfileVersion['profile']>): InvestorProfileVersion => ({
    id: 'v',
    projectId: 'p',
    personId: 'x',
    version: 1,
    profile: { budgetCents: 20_000_000, declaredDownPaymentCents: null, rentalTarget: 'furnished', sectors: ['99001'], targetGrossYieldBp: null, deadline: null, ...p },
    sources: {},
    origin: 'agent:a',
    createdAt: '2027-01-01',
  });
  const prop = { insee_code: '99001', price_eur: 150_000 };
  expect(matches(v({}), prop, null)).toBe(true);
  expect(matches(v({ sectors: [] }), prop, null)).toBe(false);
  expect(matches(v({ budgetCents: null }), prop, null)).toBe(false);
  expect(matches(v({ budgetCents: 15_000_000 }), prop, null)).toBe(true);
  expect(matches(v({ budgetCents: 14_999_999 }), prop, null)).toBe(false);
  expect(matches(v({ targetGrossYieldBp: 300 }), prop, null)).toBe(false);
  expect(matches(v({ targetGrossYieldBp: 300 }), prop, { grossBp: 300, lowBp: 250, highBp: 350, rentCitation: 's', fewObservations: false })).toBe(true);
});
