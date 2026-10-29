import { expect, it } from 'vitest';
import { ALERT_PURPOSE, Acces, ControlesSignature, FicheClient, FicheUnique, Modeles, RegistreMandats, SignaturePapier, SqlJournalStore, applyMigrations, fromSyncSqlite, investir, type SqlDatabase, type Viewer } from '@aimmo/core';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { INVESTOR_ALERTS_JOB, investorFeesRate, runScheduler } from '../src/planificateur.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';
import { identiteAuCoffre } from '../../core/test/identite-coffre.ts';

// Réseau, agent, investisseurs, biens et clés inventés. Le 14 septembre 2027 est un mardi ; été : Paris = UTC + 2.
const BASE = 'https://aimmo-api.example.test';
const UNSUB = 'https://aimmo-api.example.test/alertes/desinscription/';
const TUESDAY_10H = Date.parse('2027-09-14T08:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FEES = { value: 750, source: 'direction:d1', asOf: '2027-09-01', hypothesis: 'barème de l’ancien' };
const PROFILE = { sectors: ['99001'], budgetCents: 20_000_000, rentalTarget: 'furnished', targetGrossYieldBp: 350 };
const KEYS = { alex: 'test-cle-y08-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', direction: 'test-cle-y08-dir-bbbbbbbbbbbbbbbbbbbbbbbbbbbbb', conformite: 'test-cle-y08-conf-cccccccccccccccccccccccccccc' };
type Who = keyof typeof KEYS;

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = TUESDAY_10H;
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const acces = new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now });
  const network = (await store.createNetwork('Réseau test')).id;
  const alex = (await store.createAgent({ networkId: network, firstName: 'Alex', lastName: 'Agent' })).id;
  const direction = { role: 'direction' as const, userId: 'd1', networkId: network };
  const agent = { role: 'agent' as const, userId: alex, networkId: network };
  await new investir.LoyersMarche(db, journal, { now }).importAnil(direction, { kind: 'apartment', vintage: 2026, csv: 'INSEE_C;loypredm2;lwr.IPm2;upr.IPm2;nbobs_com\n99001;12,35;10,10;15,01;120' });
  const profils = new investir.ProfilInvestisseur(db, journal, { now });
  const alertes = new investir.AlertesInvestisseurs(db, journal, { now });
  // Le mandat signé en agence, sans délai de rétractation : le bien est diffusable (D05), comme dans la vie.
  const modeles = new Modeles(db, acces, journal, { now });
  const template = await modeles.createVersion(direction, 'mandat_vente_simple', 'Mandat de test : {{mandant.nom}}, {{honoraires.montant}} {{honoraires.charge}}, {{mandat.duree_mois}}.\n\nNuméro : {{registre.numero}}.');
  await modeles.validate({ role: 'compliance', userId: 'c-1', networkId: network } as Viewer, template.ok ? template.template.id : '');
  await new ControlesSignature(db, acces, journal, { now }).setFeeSchedule(direction, { maxRatePercent: 5, minEur: 0 });
  await new RegistreMandats(db, journal, { now }).configure(direction, { prefix: 'T-', firstNumber: 1, width: 3 });
  const mandate = async (propertyId: string, ref: string) => {
    const seller = (await store.createPerson({ networkId: network, agentId: alex, firstName: 'Léa', lastName: `Vendeuse${ref}` })).id;
    const project = (await store.createProject({ networkId: network, agentId: alex, personId: seller, kind: 'sell' })).id;
    await store.linkProjectProperty({ networkId: network, agentId: alex, projectId: project, propertyId, role: 'owned' });
    const signedAt = new Date(TUESDAY_10H - 30 * DAY);
    await identiteAuCoffre({ db, acces, journal, now }, agent, seller, { piece: 'carte_identite', seenAt: signedAt });
    const d = await modeles.generate(agent, { kind: 'mandat_vente_simple', personId: seller, propertyId, inputs: { 'honoraires.montant': 7500, 'honoraires.charge': 'vendeur', 'mandat.duree_mois': 12 } as never });
    if (!d.ok) throw new Error(d.code);
    const r = await new SignaturePapier(db, acces, journal, { now }).register(agent, d.document.id, { signedAt, place: 'agence', scanRef: `scans/test-${ref}.pdf`, source: 'referral' });
    if (!r.ok) throw new Error(r.code);
  };
  let n = 0;
  const investor = async (firstName: string, consent = true) => {
    n += 1;
    const person = (await store.createPerson({ networkId: network, agentId: alex, firstName })).id;
    await store.addIdentifier({ networkId: network, personId: person, kind: 'email', value: `investisseur${n}@example.test` });
    if (consent) await store.addConsent({ networkId: network, personId: person, purpose: ALERT_PURPOSE, channel: 'email', proof: 'formulaire de test', givenAt: new Date(TUESDAY_10H - 10 * DAY) });
    const project = (await store.createProject({ networkId: network, agentId: alex, personId: person, kind: 'invest' })).id;
    const r = await profils.update(acces, direction, project, PROFILE);
    if (!r.ok) throw new Error(r.code);
    return person;
  };
  const property = async (ref: string, energyClass = 'C') => {
    const p = (await store.createProperty({ networkId: network, agentId: alex, reference: ref, kind: 'home', city: 'Commune Une', priceEur: 150_000, surfaceM2: 45, rooms: 2, status: 'available' })).id;
    await db.run("INSERT INTO property_sheets (id, property_id, network_id, version, data, created_by, created_at) VALUES (?, ?, ?, 1, ?, 'agent:a', '2027-01-01')", [
      `s-${ref}`,
      p,
      network,
      JSON.stringify({ energy: { energyClass }, coownership: { isCoownership: false } }),
    ]);
    const r = await alertes.recordPropertyCommune(acces, agent, p, { inseeCode: '99001', rentKind: 'apartment' });
    if (!r.ok) throw new Error(r.code);
    await mandate(p, ref);
    return p;
  };
  const ids: Record<Who, { role: string; userId: string }> = { alex: { role: 'agent', userId: alex }, direction: { role: 'direction', userId: 'd1' }, conformite: { role: 'compliance', userId: 'conf-1' } };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: network, ...ids[w] }))));
  const config = (unsubscribe = true): ApiConfig => ({ db, apiKeys, mode: 'essai', now, investir: { feesRateBp: FEES }, ...(unsubscribe ? { alertUnsubscribeBase: UNSUB } : {}) });
  const call = async (who: Who, method: string, path: string, raw?: string, unsubscribe = true) => {
    const headers: Record<string, string> = { authorization: `Bearer ${KEYS[who]}` };
    if (raw !== undefined) headers['content-type'] = 'application/json';
    const r = await handleRequest(new Request(`${BASE}/v1${path}`, { method, headers, ...(raw === undefined ? {} : { body: raw }) }), config(unsubscribe));
    return { status: r.status, body: (await r.json()) as { ok: boolean; mode?: string; data?: any; rule?: string; code?: string } };
  };
  const tick = (unsubscribe = true) => runScheduler({ db, mode: 'essai', now, investorFeesRateBp: FEES, ...(unsubscribe ? { alertUnsubscribeBase: UNSUB } : {}) });
  const sent = (person?: string) =>
    db.all<{ person_id: string; body: string }>(`SELECT m.person_id, m.body FROM messages m JOIN trial_outbox o ON o.message_id = m.id ${person ? 'WHERE m.person_id = ?' : ''} ORDER BY m.occurred_at, m.id`, person ? [person] : []);
  return { db, journal, store, network, investor, property, call, tick, sent, setClock: (t: number) => (clock = t) };
}

describeWithSqlite('Y08 · M17 branché dans le socle', () => {
  it('[R16] [R26] les routes de M17 sont servies par le socle, le rôle contrôlé avant le corps, les alertes par le contrôle central', async () => {
    const t = await setup();
    const loyer = await t.call('alex', 'GET', '/investir/loyers?insee=99001');
    expect(loyer).toMatchObject({ status: 200, body: { ok: true, mode: 'essai' } });
    // La conformité n'importe pas les loyers : refusée avant la lecture d'un corps illisible, et le refus au journal.
    expect(await t.call('conformite', 'POST', '/investir/loyers', '{pas du json')).toMatchObject({ status: 403, body: { ok: false, rule: 'R16', code: 'role' } });
    expect((await t.journal.all()).some((e) => e.type === 'acces.refuse' && e.data['kind'] === 'investir.loyers.import')).toBe(true);
    expect(await t.call('alex', 'POST', '/investir/biens/b1/alertes')).toMatchObject({ status: 403, body: { rule: 'R16', code: 'role' } });
    expect((await t.call('alex', 'GET', '/investir-inconnu')).status).toBe(404);

    // La direction lance les alertes d'un bien : sans le lien de désinscription du réseau, rien ; avec lui, la boîte d'essai.
    const ines = await t.investor('Inès');
    const bien = await t.property('B1');
    expect(await t.call('direction', 'POST', `/investir/biens/${bien}/alertes`, undefined, false)).toMatchObject({ status: 200, body: { ok: true, data: [] } });
    expect(await t.sent()).toEqual([]);
    expect(await t.call('direction', 'POST', `/investir/biens/${bien}/alertes`)).toMatchObject({ status: 200, body: { ok: true, mode: 'essai', data: [{ personId: ines, status: 'sent' }] } });
    const box = await t.sent(ines);
    expect(box).toHaveLength(1);
    expect(box[0]!.body).toContain('Rendement brut estimé avant frais de gestion et impôts : 4,14 %');
    expect(box[0]!.body).toContain(`Ne plus recevoir ces alertes : ${UNSUB}`);
  });

  it('[R03] [R05] [R26] [R124] le planificateur passe les alertes une fois par créneau, chacune décidée par le contrôle central au moment de l’envoi', async () => {
    const t = await setup();
    const ines = await t.investor('Inès');
    const leo = await t.investor('Léo', false);
    const zoe = await t.investor('Zoé');
    const bien = await t.property('G1', 'G');
    // Zoé s'oppose après avoir donné son accord : le contrôle central le voit au moment de l'envoi [R04].
    await t.store.addExclusion({ networkId: t.network, personId: zoe, reason: 'stop', notedAt: new Date(TUESDAY_10H - HOUR) });

    const first = await t.tick();
    expect(first?.ran).toContain(INVESTOR_ALERTS_JOB);
    // Même créneau : le passage ne repart pas.
    const again = await t.tick();
    expect(again?.ran ?? []).not.toContain(INVESTOR_ALERTS_JOB);
    // Créneau suivant : le passage repart, mais jamais deux fois le même bien à la même personne [R05].
    t.setClock(TUESDAY_10H + HOUR);
    expect((await t.tick())?.ran).toContain(INVESTOR_ALERTS_JOB);

    const box = await t.sent();
    expect(box.map((m) => m.person_id)).toEqual([ines]);
    // Un bien classé G porte l'alerte en tête pour qui veut louer [R124].
    expect(box[0]!.body.split('\n\n')[2]).toMatch(/^Interdit à la location : classe énergie G/);
    expect(await t.sent(leo)).toEqual([]);
    expect(await t.sent(zoe)).toEqual([]);
    expect(bien).toBeTruthy();
    // Rien n'est parti dehors : chaque alerte notée en essai, non envoyée.
    const essais = (await t.journal.all()).filter((e) => e.type === 'investir.alerte.essai');
    expect(essais.length).toBeGreaterThan(0);
    expect(essais.every((e) => (e.data as { sent: boolean }).sent === false)).toBe(true);
  });

  it('[R49] sans lien de désinscription, ou un dimanche, aucune alerte ; le lien de l’alerte arrête les suivantes', async () => {
    const t = await setup();
    const ines = await t.investor('Inès');
    await t.property('B1');
    // Sans `ALERT_UNSUBSCRIBE_BASE`, rien n'est préparé.
    await t.tick(false);
    expect(await t.sent()).toEqual([]);
    // Le dimanche, le passage ne tourne pas.
    t.setClock(TUESDAY_10H + 5 * DAY);
    expect((await t.tick())?.ran ?? []).not.toContain(INVESTOR_ALERTS_JOB);
    expect(await t.sent()).toEqual([]);
    // Le mercredi, l'alerte part en essai, avec son lien.
    t.setClock(TUESDAY_10H + DAY);
    await t.tick();
    const body = (await t.sent(ines))[0]!.body;
    const link = /Ne plus recevoir ces alertes : (\S+)/.exec(body)![1]!;
    expect(link.startsWith(UNSUB)).toBe(true);
    // La page publique du lien retire l'accord : le bien suivant ne lui est pas proposé [R03, R49].
    const page = await handleRequest(new Request(link, { method: 'POST' }), { db: t.db, apiKeys: undefined, mode: 'essai', now: () => new Date(TUESDAY_10H + DAY + 60_000) });
    expect(page.status).toBe(200);
    await t.property('B2');
    t.setClock(TUESDAY_10H + DAY + HOUR);
    await t.tick();
    expect(await t.sent(ines)).toHaveLength(1);
  });

  it('le barème de la direction est lu de sa variable, et rien n’est inventé s’il est absent ou mal formé', () => {
    expect(investorFeesRate('750@2027-09-01')).toMatchObject({ value: 750, asOf: '2027-09-01', source: 'direction:INVESTIR_FRAIS_BAREME' });
    expect(investorFeesRate(' 0@2027-01-31 ')).toMatchObject({ value: 0 });
    for (const bad of [undefined, '', '750', '7,5@2027-09-01', '2001@2027-09-01', '750@2027-02-30', '-1@2027-09-01', '750@27-09-01']) expect(investorFeesRate(bad), String(bad)).toBeNull();
  });
});
