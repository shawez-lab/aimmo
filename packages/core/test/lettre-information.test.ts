import { expect, it } from 'vitest';
import {
  ALERT_PURPOSE,
  Acces,
  FicheAcquereur,
  FicheClient,
  FicheUnique,
  SqlJournalStore,
  applyMigrations,
  fromSyncSqlite,
  type BuyerSearch,
  type DiffusionGate,
  type SqlDatabase,
} from '../src/index.ts';
import { PrixRegroupes, type LatLon } from '../src/attirer/index.ts';
import type { EstimatedKind, Sale, SalesCoverage, SalesSource } from '../src/estimation/fourchette.ts';
import { VALUE_TRACKING_PURPOSE } from '../src/mandats/suivi-valeur.ts';
import { LETTER_MAX_LENGTH, LETTER_PURPOSE, LettreInformation, euroAmounts, fitLetter, letterText, pricesFromBase, type LetterContent } from '../src/marketing/index.ts';
import type { PublicCell } from '../src/attirer/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Un mardi à 10 h, heure de Paris.
const TUESDAY_10H = Date.parse('2026-12-08T09:00:00.000Z');
const DAY = 86_400_000;
const BASE = 'https://aimmo.example.test/lettre/desinscription/';

/** Une source DVF inventée. */
class FakeSales implements SalesSource {
  constructor(public cov: SalesCoverage | null, public list: Sale[]) {}
  async coverage() {
    return this.cov;
  }
  async within(kind: EstimatedKind) {
    return this.list.filter((s) => s.kind === kind);
  }
}
const COMMUNE: LatLon[] = [[47.0, 5.0], [47.0, 5.1], [47.1, 5.1], [47.1, 5.0]];
const WEST: LatLon[] = [[47.0, 5.0], [47.0, 5.05], [47.1, 5.05], [47.1, 5.0]];
const EAST: LatLon[] = [[47.0, 5.05], [47.0, 5.1], [47.1, 5.1], [47.1, 5.05]];
let seq = 0;
function sale(kind: EstimatedKind, lon: number, pricePerM2: number): Sale {
  seq++;
  return { id: `t:${seq}`, kind, lat: 47.05 + (seq % 50) / 10000, lon, surface: 40 + (seq % 30), pricePerM2, month: '2026-03' };
}

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = TUESDAY_10H;
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const acquereurs = new FicheAcquereur(db, journal, { now });
  const blocked = new Set<string>();
  const diffusion: DiffusionGate = {
    canDiffuse: async (_n, id) => (blocked.has(id) ? { allowed: false, reason: 'withdrawal_period' } : { allowed: true, reason: 'allowed' }),
  };
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const direction = { role: 'direction' as const, userId: 'd1', networkId: network.id };

  // Les prix de AT01, calculés dans la base pour une commune inventée et ses deux quartiers.
  const sales = [
    ...[2000, 2100, 2200, 2300, 2400, 2500, 2600].map((p) => sale('house', 5.02, p)),
    ...[3000, 3100, 3200, 3300, 3400, 3500].map((p) => sale('house', 5.08, p)),
  ];
  const prix = new PrixRegroupes(db, journal, new FakeSales({ department: '21', lastSale: '2026-06-30', years: [2024, 2025, 2026], source: 'DVF, jeu inventé' }, sales), { now });
  const c = await prix.defineZone(direction, { level: 'commune', slug: 'talant', name: 'Talant', inseeCode: '21617', ring: COMMUNE, ringSource: 'Contour inventé' });
  if (!c.ok) throw new Error(c.code);
  await prix.defineZone(direction, { level: 'quartier', parentId: c.id, slug: 'ouest', name: 'Ouest', ring: WEST, ringSource: 'Contour inventé' });
  await prix.defineZone(direction, { level: 'quartier', parentId: c.id, slug: 'est', name: 'Est', ring: EAST, ringSource: 'Contour inventé' });
  expect(await prix.recompute(network.id)).toMatchObject({ ran: true });

  const lettre = new LettreInformation(db, journal, { now, diffusion, unsubscribeBase: BASE });
  let n = 0;
  /** Une personne inventée, avec son mail, sa recherche et, s'il le faut, son accord pour la lettre. */
  const person = async (firstName: string, opts: { letter?: boolean; search?: Partial<BuyerSearch> } = {}) => {
    n += 1;
    const p = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName });
    await store.addIdentifier({ networkId: network.id, personId: p.id, kind: 'email', value: `personne${n}@example.test` });
    if (opts.letter !== false) await store.addConsent({ networkId: network.id, personId: p.id, purpose: LETTER_PURPOSE, channel: 'email', proof: 'formulaire de test', givenAt: new Date(TUESDAY_10H - 10 * DAY) });
    if (opts.search) {
      const project = await store.createProject({ networkId: network.id, agentId: alex.id, personId: p.id, kind: 'buy' });
      const r = await acquereurs.update(acces, direction, project.id, opts.search);
      if (!r.ok) throw new Error(r.code);
    }
    return p;
  };
  const property = (ref: string, p: { city: string; price: number; surface: number; rooms: number }) =>
    store.createProperty({ networkId: network.id, agentId: alex.id, reference: ref, kind: 'home', city: p.city, priceEur: p.price, surfaceM2: p.surface, rooms: p.rooms, status: 'available' });
  const sent = (personId?: string) =>
    db.all<{ id: string; body: string; channel: string; person_id: string }>(
      `SELECT m.id, m.body, m.channel, m.person_id FROM messages m JOIN trial_outbox t ON t.message_id = m.id ${personId ? 'WHERE m.person_id = ?' : ''} ORDER BY m.occurred_at`,
      personId ? [personId] : [],
    );
  const edition = async () => {
    const e = await lettre.createEdition(direction, 'Lettre de décembre');
    if (!e.ok) throw new Error(e.code);
    return e.id;
  };
  return { db, store, journal, lettre, prix, network, alex, direction, person, property, sent, edition, blocked, diffusion, now, setClock: (t: number) => (clock = t) };
}

const SEARCH = { propertyKinds: ['house' as const], communes: ['Talant'], budgetMaxEur: 300_000 };
const MAISON = { city: 'Talant', price: 280_000, surface: 95, rooms: 4 };

describeWithSqlite('HX53 · lettre d’information et magazine des biens, en mode essai', () => {
  it('[R583] aucune lettre sans accord rangé et en cours pour la lettre : ni accord, ni accord d’une autre finalité, ni accord retiré', async () => {
    const t = await setup();
    await t.property('B1', MAISON);
    const yes = await t.person('Inès', { search: SEARCH });
    const none = await t.person('Léo', { letter: false, search: SEARCH });
    const other = await t.person('Noé', { letter: false, search: SEARCH });
    await t.store.addConsent({ networkId: t.network.id, personId: other.id, purpose: ALERT_PURPOSE, channel: 'email', proof: 'test', givenAt: new Date(TUESDAY_10H - DAY) });
    const gone = await t.person('Zoé', { search: SEARCH });
    for (const c of await t.store.listConsents(gone.id)) await t.store.withdrawConsent(c.id, new Date(TUESDAY_10H - DAY));
    const id = await t.edition();
    const outcomes = await t.lettre.sendEdition(id);
    expect(outcomes).toEqual([{ personId: yes.id, status: 'sent', rule: null }]);
    // Envoyée de force à une personne sans accord : rien n'est même préparé.
    for (const p of [none, other, gone]) expect(await t.lettre.sendOne(t.network.id, id, p.id)).toEqual({ personId: p.id, status: 'no_consent', rule: 'R583' });
    const messages = await t.sent();
    expect(messages.map((m) => m.person_id)).toEqual([yes.id]);
    expect(messages[0]!.channel).toBe('email');
    expect(await t.db.all('SELECT person_id FROM newsletter_letters')).toEqual([{ person_id: yes.id }]);
  });

  it('[R583] [R05] une lettre par édition et par personne, même rejouée ou demandée deux fois en même temps', async () => {
    const t = await setup();
    await t.property('B1', MAISON);
    const p = await t.person('Inès', { search: SEARCH });
    const id = await t.edition();
    await Promise.all([t.lettre.sendEdition(id), t.lettre.sendEdition(id)]);
    expect(await t.lettre.sendOne(t.network.id, id, p.id)).toEqual({ personId: p.id, status: 'done', rule: null });
    expect(await t.sent()).toHaveLength(1);
    // Une nouvelle édition repart, sans le bien déjà envoyé : jamais deux fois le même bien à la même personne.
    await t.lettre.sendEdition(await t.edition());
    const both = await t.sent();
    expect(both).toHaveLength(2);
    expect(both[0]!.body).toContain('280 000 €');
    expect(both[1]!.body).not.toContain('280 000 €');
    expect(both[1]!.body).toContain('Talant, maison : 2 600 €/m²');
  });

  it('[R05] un bien déjà parti en alerte à la personne n’entre pas dans sa lettre', async () => {
    const t = await setup();
    const b1 = await t.property('B1', MAISON);
    const b2 = await t.property('B2', { ...MAISON, price: 260_000 });
    const p = await t.person('Inès', { search: SEARCH });
    const id = await t.edition();
    await t.lettre.sendOne(t.network.id, id, p.id);
    const first = (await t.sent(p.id))[0]!.body;
    expect(first).toContain('280 000 €');
    expect(first).toContain('260 000 €');
    const subjects = await t.db.all<{ subject: string }>('SELECT subject FROM message_subjects WHERE person_id = ? ORDER BY subject', [p.id]);
    expect(subjects.map((x) => x.subject)).toEqual([`bien:${b1.id}`, `bien:${b2.id}`, `lettre:${id}`].sort());
    const b3 = await t.property('B3', { ...MAISON, price: 250_000 });
    const content = await t.lettre.contentFor(t.network.id, p.id);
    expect(content.properties.map((x) => x.id)).toEqual([b3.id]);
  });

  it('[R584] chaque lettre finit par son lien de désinscription, qui retire l’accord de la lettre seul', async () => {
    const t = await setup();
    await t.property('B1', MAISON);
    const a = await t.person('Inès', { search: SEARCH });
    await t.store.addConsent({ networkId: t.network.id, personId: a.id, purpose: ALERT_PURPOSE, channel: 'email', proof: 'test', givenAt: new Date(TUESDAY_10H - DAY) });
    await t.store.addConsent({ networkId: t.network.id, personId: a.id, purpose: VALUE_TRACKING_PURPOSE, channel: 'email', proof: 'test', givenAt: new Date(TUESDAY_10H - DAY) });
    const b = await t.person('Léo', { search: SEARCH });
    await t.lettre.sendEdition(await t.edition());
    const messages = await t.sent();
    expect(messages).toHaveLength(2);
    for (const m of messages) expect(m.body).toMatch(/\n\nNe plus recevoir cette lettre : https:\/\/aimmo\.example\.test\/lettre\/desinscription\/[a-z]{32}$/);
    const token = /\/([a-z]{32})$/.exec(messages.find((m) => m.person_id === a.id)!.body)![1]!;
    expect(await t.lettre.unsubscribe(token)).toBe(true);
    expect(await t.lettre.unsubscribe(token)).toBe(true);
    expect(await t.lettre.unsubscribe('inconnu')).toBe(false);
    const consents = await t.store.listConsents(a.id);
    expect(consents.filter((c) => c.purpose === LETTER_PURPOSE).every((c) => c.withdrawn_at !== null)).toBe(true);
    // L'accord des alertes et celui du suivi de valeur restent.
    expect(consents.filter((c) => c.purpose === ALERT_PURPOSE).every((c) => c.withdrawn_at === null)).toBe(true);
    expect(consents.filter((c) => c.purpose === VALUE_TRACKING_PURPOSE)).toHaveLength(1);
    expect(consents.filter((c) => c.purpose === VALUE_TRACKING_PURPOSE).every((c) => c.withdrawn_at === null)).toBe(true);
    // Le jeton n'est rangé que par son empreinte.
    expect(await t.db.first('SELECT 1 FROM newsletter_unsubscribe_tokens WHERE token_hash = ?', [token])).toBeFalsy();
    const outcomes = await t.lettre.sendEdition(await t.edition());
    expect(outcomes).toEqual([{ personId: b.id, status: 'sent', rule: null }]);
  });

  it('[R583] fiches réunies : l’accord rangé sur une fiche vaut pour la fiche réunie, une seule lettre, à la fiche gardée', async () => {
    const t = await setup();
    await t.property('B1', MAISON);
    const kept = await t.person('Inès', { letter: false, search: SEARCH });
    const merged = await t.person('Inès', { search: SEARCH });
    const fiche = new FicheUnique(t.db, t.store, { now: t.now });
    await fiche.merge({ survivorId: kept.id, mergedId: merged.id, reason: 'même personne, test' });
    const id = await t.edition();
    expect(await t.lettre.sendEdition(id)).toEqual([{ personId: kept.id, status: 'sent', rule: null }]);
    expect(await t.lettre.sendOne(t.network.id, id, merged.id)).toEqual({ personId: kept.id, status: 'done', rule: null });
    expect(await t.sent()).toHaveLength(1);
  });

  it('[R585] un prix changé dans la base avant l’envoi retient la lettre, qui repart ensuite avec le nouveau prix', async () => {
    const t = await setup();
    const b1 = await t.property('B1', MAISON);
    const p = await t.person('Inès', { search: SEARCH });
    let change = true;
    class Changeante extends LettreInformation {
      override async contentFor(networkId: string, personId: string): Promise<LetterContent> {
        const c = await super.contentFor(networkId, personId);
        if (change) await t.db.run('UPDATE properties SET price_eur = 275000 WHERE id = ?', [b1.id]);
        change = false;
        return c;
      }
    }
    const lettre = new Changeante(t.db, t.journal, { now: t.now, diffusion: t.diffusion, unsubscribeBase: BASE });
    const id = await t.edition();
    expect(await lettre.sendOne(t.network.id, id, p.id)).toEqual({ personId: p.id, status: 'waiting', rule: 'R585' });
    expect(await t.sent()).toHaveLength(0);
    expect(await lettre.sendOne(t.network.id, id, p.id)).toEqual({ personId: p.id, status: 'sent', rule: null });
    const body = (await t.sent(p.id))[0]!.body;
    expect(body).toContain('275 000 €');
    expect(body).not.toContain('280 000 €');
  });

  it('[R585] une lettre se tient dans la longueur d’un mail : les quartiers partent d’abord, la commune et le suivi restent', () => {
    const cell = (name: string, level: 'commune' | 'quartier', median: number): PublicCell => ({
      zone: { slug: name.toLowerCase(), name, level },
      kind: 'house',
      status: 'publiee',
      sales: 12,
      median,
      q1: median - 200,
      q3: median + 200,
      source: 'DVF, jeu inventé',
      dvfLastSale: '2026-06-30',
      period: { from: '2024-07', to: '2026-06' },
    });
    const quarters = Array.from({ length: 30 }, (_, i) => cell(`Quartier ${String.fromCharCode(65 + (i % 26))}${i >= 26 ? 'x' : ''}`, 'quartier', 2000 + i * 10));
    const content: LetterContent = {
      firstName: 'Inès',
      properties: Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, kind: 'home', city: 'Talant', priceEur: 200_000 + i * 1000, surfaceM2: 90, rooms: 4 })),
      valueTracking: { town: 'Talant', kind: 'house', cell: cell('Talant', 'commune', 2600) },
      prices: [{ commune: 'Talant', cells: [cell('Talant', 'commune', 2600), ...quarters] }, { commune: 'Dijon', cells: [cell('Dijon', 'commune', 2900), ...quarters] }],
    };
    expect(letterText(content).length).toBeGreaterThan(LETTER_MAX_LENGTH);
    const fitted = fitLetter(content);
    const text = letterText(fitted);
    expect(text.length).toBeLessThanOrEqual(LETTER_MAX_LENGTH - 160);
    expect(fitted.valueTracking).not.toBeNull();
    expect(fitted.properties).toHaveLength(5);
    expect(fitted.prices[0]!.cells[0]!.zone.level).toBe('commune');
    expect(pricesFromBase(text, fitted)).toBe(true);
  });

  it('[R584] sans lien de désinscription réglé, aucune lettre ne part', async () => {
    const t = await setup();
    await t.property('B1', MAISON);
    await t.person('Inès', { search: SEARCH });
    const id = await t.edition();
    const sans = new LettreInformation(t.db, t.journal, { now: t.now, diffusion: t.diffusion, unsubscribeBase: null });
    expect(await sans.sendEdition(id)).toEqual([]);
    expect(await t.sent()).toHaveLength(0);
    expect(() => new LettreInformation(t.db, t.journal, { unsubscribeBase: 'http://x.test/' })).toThrow();
  });

  it('[R585] Jamais vu : la lettre est faite pour sa personne, ses biens, son suivi de valeur et les prix de sa commune, chaque prix lu dans la base', async () => {
    const t = await setup();
    const b1 = await t.property('B1', MAISON);
    await t.property('B2', { ...MAISON, price: 420_000 }); // hors budget
    await t.property('B3', { ...MAISON, city: 'Ailleurs', price: 200_000 }); // hors commune
    const inès = await t.person('Inès', { search: SEARCH });
    const owner = await t.person('Paul');
    await t.db.run(
      "INSERT INTO value_tracking (id, network_id, agent_id, person_id, postal_code, town, kind, channel, created_by, created_at) VALUES ('vt1', ?, ?, ?, '21240', 'Talant', 'house', 'email', 'test', ?)",
      [t.network.id, t.alex.id, owner.id, new Date(TUESDAY_10H - DAY).toISOString()],
    );
    await t.store.addConsent({ networkId: t.network.id, personId: owner.id, purpose: VALUE_TRACKING_PURPOSE, channel: 'email', proof: 'test', givenAt: new Date(TUESDAY_10H - DAY) });

    const forInès = await t.lettre.contentFor(t.network.id, inès.id);
    expect(forInès.properties.map((p) => p.id)).toEqual([b1.id]);
    expect(forInès.valueTracking).toBeNull();
    const forPaul = await t.lettre.contentFor(t.network.id, owner.id);
    expect(forPaul.properties).toEqual([]);
    expect(forPaul.valueTracking).toMatchObject({ kind: 'house', cell: { zone: { level: 'commune' }, median: 2600 } });

    await t.lettre.sendEdition(await t.edition());
    const ines = (await t.sent(inès.id))[0]!.body;
    expect(ines).toContain('Bonjour Inès,');
    expect(ines).toContain('280 000 €');
    expect(ines).not.toContain('420 000 €');
    expect(ines).not.toContain('200 000 €');
    // Les cases publiées de la commune et de ses deux quartiers, avec leur source et leur date [R151].
    expect(ines).toContain('Talant, maison : 2 600 €/m² au milieu');
    expect(ines).toContain('Ouest, maison : 2 300 €/m²');
    expect(ines).toContain('Est, maison : 3 250 €/m²');
    expect(ines).toContain('Source : DVF, jeu inventé, ventes jusqu’au 2026-06-30.');
    const paul = (await t.sent(owner.id))[0]!.body;
    expect(paul).toContain('Le suivi de valeur que vous avez demandé');
    expect(paul).toContain('pas le prix de votre bien');
    expect(paul).not.toContain('280 000 €');
    // Chaque montant du texte est un prix de la base.
    const allowed = new Set([280_000, 2600, 2250, 3250, 2300, 2100, 2500, 3100, 3400]);
    for (const body of [ines, paul]) {
      const { amounts, unreadable } = euroAmounts(body);
      expect(unreadable).toBe(false);
      expect(amounts.length).toBeGreaterThan(0);
      for (const a of amounts) expect(allowed.has(a)).toBe(true);
    }
  });

  it('[R585] le suivi de valeur n’entre que s’il est demandé avec un accord en cours ; une personne sans rien de la base ne reçoit rien', async () => {
    const t = await setup();
    const owner = await t.person('Paul');
    await t.db.run(
      "INSERT INTO value_tracking (id, network_id, agent_id, person_id, postal_code, town, kind, channel, created_by, created_at) VALUES ('vt1', ?, ?, ?, '21240', 'Talant', 'house', 'email', 'test', ?)",
      [t.network.id, t.alex.id, owner.id, new Date(TUESDAY_10H - DAY).toISOString()],
    );
    expect((await t.lettre.contentFor(t.network.id, owner.id)).valueTracking).toBeNull();
    const id = await t.edition();
    expect(await t.lettre.sendOne(t.network.id, id, owner.id)).toEqual({ personId: owner.id, status: 'empty', rule: null });
    expect(await t.sent()).toHaveLength(0);
  });

  it('[R585] aucun prix qui ne vienne de la base : un montant inconnu ou écrit autrement est refusé', () => {
    const content = { properties: [{ id: 'p', kind: 'home', city: 'X', priceEur: 280_000, surfaceM2: 95, rooms: 4 }], valueTracking: null, prices: [] };
    const text = letterText({ firstName: 'Inès', ...content });
    expect(pricesFromBase(text, content)).toBe(true);
    expect(pricesFromBase(`${text}\n\nUne affaire à 250 000 € !`, content)).toBe(false);
    expect(pricesFromBase(`${text}\n\nOu 250k.`, content)).toBe(false);
    expect(pricesFromBase(`${text}\n\nOu 250000 euros.`, content)).toBe(false);
    expect(euroAmounts('2 600 €/m² et 280 000 € et 12 €').amounts).toEqual([2600, 280_000, 12]);
  });

  it('[R585] [R42] un bien qui n’est plus diffusable n’entre pas dans la lettre, ni dans le magazine', async () => {
    const t = await setup();
    const b1 = await t.property('B1', MAISON);
    const b2 = await t.property('B2', { ...MAISON, price: 250_000 });
    const p = await t.person('Inès', { search: SEARCH });
    t.blocked.add(b2.id);
    expect((await t.lettre.contentFor(t.network.id, p.id)).properties.map((x) => x.id)).toEqual([b1.id]);
    const m = await t.lettre.magazine(t.direction, 'Le magazine de décembre');
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.properties).toBe(1);
    expect(m.html).toContain('280 000 €');
    expect(m.html).not.toContain('250 000 €');
  });

  it('[R585] Jamais vu : le magazine imprimable sort de la même base, mêmes biens et mêmes prix, sans donnée personnelle', async () => {
    const t = await setup();
    await t.property('B1', MAISON);
    const p = await t.person('Inès', { search: SEARCH });
    const m = await t.lettre.magazine({ role: 'agent', userId: t.alex.id, networkId: t.network.id }, 'Le magazine de décembre');
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.html).toMatch(/^<!doctype html>/);
    expect(m.html).toContain('@page{size:A4');
    expect(m.html).toContain('<h1>Le magazine de décembre</h1>');
    expect(m.html).toContain('280 000 €');
    expect(m.html).toContain('Talant, maison : 2 600 €/m² au milieu');
    expect(m.html).not.toContain('Inès');
    expect(m.html).not.toContain('example.test');
    // Les mêmes prix que la lettre de la personne.
    const content = await t.lettre.contentFor(t.network.id, p.id);
    const fromLetter = euroAmounts(letterText(content)).amounts.sort();
    const fromMagazine = euroAmounts(m.html.replace(/<[^>]+>/g, '\n')).amounts.sort();
    expect(fromMagazine).toEqual(fromLetter);
    // Le titre est échappé ; sans chiffre ; un client ne tire pas le magazine.
    const x = await t.lettre.magazine(t.direction, '<b>Lettre</b>');
    expect(x.ok && x.html.includes('&lt;b&gt;')).toBe(true);
    expect(await t.lettre.magazine(t.direction, 'Lettre 12')).toEqual({ ok: false, rule: 'R585', code: 'titre' });
    expect(await t.lettre.magazine({ role: 'client' as never, userId: 'c', networkId: t.network.id }, 'Le magazine')).toEqual({ ok: false, rule: 'R16', code: 'role' });
  });

  it('[R586] seule la direction ouvre une édition ; le journal porte l’issue et sa règle, jamais le texte ni le mail', async () => {
    const t = await setup();
    await t.property('B1', MAISON);
    await t.person('Inès', { search: SEARCH });
    expect(await t.lettre.createEdition({ role: 'agent', userId: t.alex.id, networkId: t.network.id }, 'Lettre de décembre')).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.lettre.createEdition(t.direction, 'L')).toEqual({ ok: false, rule: 'R586', code: 'titre' });
    const id = await t.edition();
    await t.lettre.sendEdition(id);
    const events = await t.db.all<{ type: string; data: string }>("SELECT type, data FROM journal WHERE type LIKE 'lettre.%'");
    expect(events.map((e) => e.type)).toEqual(['lettre.edition', 'lettre.essai']);
    for (const e of events) {
      expect(e.data).not.toContain('Inès');
      expect(e.data).not.toContain('example.test');
      expect(e.data).not.toContain('280');
    }
    await expect(t.db.run('DELETE FROM newsletter_letters')).rejects.toThrow();
    await expect(t.db.run("UPDATE newsletter_letters SET status = 'pending'")).rejects.toThrow();
    await expect(t.db.run('DELETE FROM newsletter_editions')).rejects.toThrow();
  });
});
