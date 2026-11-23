import { describe, expect, it } from 'vitest';
import {
  Acces,
  ComptesRendus,
  FicheClient,
  FicheUnique,
  NouveauBien,
  RendezVous,
  SELLER_UPDATE_PURPOSE,
  SqlJournalStore,
  Visites,
  applyMigrations,
  dictee,
  fromSyncSqlite,
  verifyChain,
  type ReportWriter,
  type SqlDatabase,
  type Viewer,
  type VisitReport,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const { readDictation, splitSentences, Dictee } = dictee;

// Tout est inventé. Jeudi 3 décembre 2026, 10 h à Paris.
const THURSDAY_10H = Date.parse('2026-12-03T09:00:00.000Z');
const NOW = new Date(THURSDAY_10H);
const HOUR = 3_600_000;
const WEEK = { weekly: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: '09:00', to: '19:00' })) };
const key = (n: number) => `7d1c2b3a-1111-4a2b-8c3d-${String(n).padStart(12, '0')}`;

const SELLER_DICTATION = [
  'Je sors de chez Madame Claire Exemple, elle veut vendre sa maison.',
  'Son numéro est le 06 12 34 56 78 et son mail claire.exemple@example.test.',
  'La maison fait 120 m², 5 pièces, au 21240 Talant.',
  'Prix demandé 320 000 euros.',
  "Rendez-vous d'estimation mardi à 10 h.",
].join(' ');

const value = (d: dictee.DictationDraft, target: dictee.DictationTarget, k: dictee.DictatedKey) => dictee.fieldOf(d, target, k)?.value;

describe('HX06 · lecture de la dictée', () => {
  it('[R260] chaque champ vient d’une phrase, avec le passage exact qui le porte', () => {
    const d = readDictation(SELLER_DICTATION, { now: NOW });
    expect(d.sentences).toHaveLength(5);
    expect(d.fields.map((f) => [f.target, f.key, f.value, f.sentence, f.quote])).toEqual([
      ['contact', 'firstName', 'Claire', 0, 'Madame Claire Exemple'],
      ['contact', 'lastName', 'Exemple', 0, 'Madame Claire Exemple'],
      ['contact', 'phone', '+33612345678', 1, '06 12 34 56 78'],
      ['contact', 'email', 'claire.exemple@example.test', 1, 'claire.exemple@example.test'],
      ['contact', 'project', 'sell', 0, 'vendre'],
      ['bien', 'kind', 'home', 0, 'maison'],
      ['bien', 'postalCode', '21240', 2, '21240'],
      ['bien', 'city', 'Talant', 2, 'Talant'],
      ['bien', 'surfaceM2', 120, 2, '120 m²'],
      ['bien', 'rooms', 5, 2, '5 pièces'],
      ['bien', 'priceEur', 320000, 3, '320 000 euros'],
      ['rendezvous', 'appointmentKind', 'estimation', 4, 'estimation'],
      ['rendezvous', 'start', '2026-12-08T09:00:00.000Z', 4, 'mardi à 10 h'],
    ]);
    for (const f of d.fields) expect(d.sentences[f.sentence], `${f.target}.${f.key}`).toContain(f.quote);
    expect(d.conflicts).toEqual([]);
  });

  it('[R260] un nombre en lettres qui ne se lit pas d’une seule façon, une surface à virgule ou un prix hors de son contexte ne sont pas lus', () => {
    // RC01 : « quatre-vingts mètres carrés » se lit ; « deux trois pièces » et « cent vingt virgule cinq » non.
    const d = readDictation('Il vend un appartement de deux trois pièces, cent vingt virgule cinq mètres carrés, pour trois cent mille euros. Il fait 85,5 m². Les travaux sont à 20 000 euros.', { now: NOW });
    expect(value(d, 'bien', 'kind')).toBe('home');
    expect(value(d, 'bien', 'rooms')).toBeUndefined();
    expect(value(d, 'bien', 'surfaceM2')).toBeUndefined();
    expect(value(d, 'bien', 'priceEur')).toBeUndefined();
    expect(value(readDictation('Il vend un appartement de quatre-vingts mètres carrés.', { now: NOW }), 'bien', 'surfaceM2')).toBe(80);
    // Un budget, des honoraires ou une estimation ne sont pas le prix demandé.
    for (const s of ['Il vend sa maison, son budget est de 300 000 euros.', 'Il vend sa maison, honoraires de 10 000 euros.', 'Il vend sa maison, je l’estime à 280 000 euros.']) {
      expect(value(readDictation(s, { now: NOW }), 'bien', 'priceEur'), s).toBeUndefined();
    }
  });

  it('[R260] une surface ou un nombre de pièces groupés en milliers ne sont jamais lus à moitié', () => {
    const d = readDictation('Madame Zoé Exemple vend sa maison de 1 200 m² au 21240 Talant.', { now: NOW });
    expect(value(d, 'bien', 'surfaceM2')).toBeUndefined();
    expect(value(d, 'bien', 'postalCode')).toBe('21240');
    expect(value(readDictation('Il vend une maison de 1 12 pièces.', { now: NOW }), 'bien', 'rooms')).toBeUndefined();
  });

  it('[R260] un champ dit deux fois avec deux valeurs n’est pas proposé : l’agent tranchera', () => {
    const d = readDictation('Elle vend sa maison de 100 m² à Dijon. Prix demandé 250 000 euros. Non, prix demandé 260 000 euros.', { now: NOW });
    expect(value(d, 'bien', 'priceEur')).toBeUndefined();
    expect(d.conflicts).toContainEqual({ target: 'bien', key: 'priceEur' });
    expect(value(d, 'bien', 'surfaceM2')).toBe(100);
  });

  it('[R260] aucun bien pour un acquéreur, aucun bien sans sa sorte dite', () => {
    const buyer = readDictation('Monsieur Paul Essai cherche à acheter une maison de 90 m² à Dijon.', { now: NOW });
    expect(value(buyer, 'contact', 'project')).toBe('buy');
    expect(buyer.fields.filter((f) => f.target === 'bien')).toEqual([]);
    const vague = readDictation('Elle vend, 90 m² à Dijon, prix demandé 200 000 euros.', { now: NOW });
    expect(vague.fields.filter((f) => f.target === 'bien')).toEqual([]);
  });

  it('[R260] le rendez-vous : sa sorte, son jour et son heure, dans la même phrase', () => {
    const at = (s: string) => value(readDictation(s, { now: NOW }), 'rendezvous', 'start');
    expect(at('On se rappelle demain à 14 h 30.')).toBe('2026-12-04T13:30:00.000Z');
    expect(at('Visite le 12 janvier à 9 h.')).toBe('2027-01-12T08:00:00.000Z');
    expect(at('Visite le 15 décembre à midi.')).toBe('2026-12-15T11:00:00.000Z');
    // « jeudi » dit un jeudi : le prochain, jamais aujourd'hui.
    expect(at('Signature jeudi à 11h.')).toBe('2026-12-10T10:00:00.000Z');
    // Un jour sans heure, une heure sans jour, deux heures : rien n'est lu.
    expect(at('Visite mardi.')).toBeUndefined();
    expect(at('La visite de 14 h s’est bien passée.')).toBeUndefined();
    expect(at('Visite mardi à 10 h ou à 11 h.')).toBeUndefined();
    expect(at('Il a 14 habitants dans sa rue, visite mardi à 10 h.')).toBe('2026-12-08T09:00:00.000Z');
    // Une heure dite en partie n'est pas lue.
    expect(at('Estimation mardi à 14 h 5.')).toBeUndefined();
    expect(at('Estimation mardi à 14 heures et demie.')).toBeUndefined();
    expect(at('Estimation mardi à midi et quart.')).toBeUndefined();
    expect(at('Estimation mardi à 10 h moins le quart.')).toBeUndefined();
    expect(at('Estimation mardi à 14 h 05.')).toBe('2026-12-08T13:05:00.000Z');
    // Un 31 février n'existe pas.
    expect(at('Visite le 31 février à 10 h.')).toBeUndefined();
  });

  it('[R260] un nom à particule n’est jamais coupé en prénom et nom', () => {
    const names = (text: string) => {
      const d = readDictation(text, { now: NOW });
      return [value(d, 'contact', 'firstName'), value(d, 'contact', 'lastName')];
    };
    expect(names('Je sors de chez Monsieur Le Gall, il vend sa maison.')).toEqual([undefined, 'Le Gall']);
    expect(names('Madame De Souza vend.')).toEqual([undefined, 'De Souza']);
    expect(names('Il s’appelle Jean Van Damme.')).toEqual(['Jean', 'Van Damme']);
    expect(names('Madame Claire Exemple vend.')).toEqual(['Claire', 'Exemple']);
    // Une particule en minuscule après le prénom : rien n'est coupé.
    expect(names('Monsieur Jean de Souza veut vendre sa maison.')).toEqual([undefined, undefined]);
    expect(names('Madame Anne d’Exemple vend.')).toEqual([undefined, undefined]);
    // Trois mots sans particule : le partage n'est pas sûr.
    expect(names('Il s’appelle Jean Pierre Martin.')).toEqual([undefined, undefined]);
  });

  it('[R260] seul un montant qui suit « prix », « vend » ou « demande » est le prix demandé', () => {
    const price = (text: string) => value(readDictation(text, { now: NOW }), 'bien', 'priceEur');
    expect(price('Il vend sa maison, il demande une remise de 5 000 euros.')).toBeUndefined();
    expect(price('Il vend sa maison car il a payé 180 000 euros en 2015.')).toBeUndefined();
    expect(price('Il vend sa maison de 90 m², la toiture a coûté 15 000 euros.')).toBeUndefined();
    expect(price('Elle veut vendre sa maison 300 000 euros.')).toBe(300000);
    expect(price('Il vend sa maison, prix affiché 250 k€.')).toBe(250000);
  });

  it('la coupure en phrases ne coupe ni un mail, ni « M. », ni un numéro à points', () => {
    expect(splitSentences('M. Exemple a appelé. Son mail est m.exemple@example.test, son numéro 06.12.34.56.78. Voilà')).toEqual([
      'M. Exemple a appelé.',
      'Son mail est m.exemple@example.test, son numéro 06.12.34.56.78.',
      'Voilà',
    ]);
    const d = readDictation('M. Exemple vend sa maison. Comme Paul le disait, rien.', { now: NOW });
    expect(value(d, 'contact', 'lastName')).toBe('Exemple');
    expect(value(d, 'contact', 'firstName')).toBeUndefined();
  });
});

async function setup(writer?: ReportWriter) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = THURSDAY_10H;
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const rdv = new RendezVous(db, journal, { now });
  const visites = new Visites(db, journal, acces, { diffusion: { canDiffuse: async () => ({ allowed: true, reason: 'allowed' }) }, rendezVous: rdv, now });
  const comptes = new ComptesRendus(db, journal, visites, { now, ...(writer ? { writer } : {}) });
  const biens = new NouveauBien(db, acces, journal, { now });
  const voix = new Dictee(db, journal, { acces, store, fiche, biens, rendezVous: rdv, visites, comptes }, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const as = (role: 'agent' | 'direction', userId: string): Viewer => ({ role, userId, networkId: network.id }) as Viewer;
  await rdv.setAvailability(as('agent', alex.id), WEEK);
  await rdv.setAvailability(as('agent', sam.id), WEEK);
  const counts = async () => {
    const n = async (t: string) => (await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`))!.n;
    return { persons: await n('persons'), identifiers: await n('person_identifiers'), properties: await n('properties'), projects: await n('projects'), appointments: await n('appointments'), reports: await n('visit_reports') };
  };
  return { now, db, journal, store, fiche, rdv, visites, comptes, voix, network, alex: as('agent', alex.id), sam: as('agent', sam.id), direction: as('direction', 'd-1'), alexId: alex.id, samId: sam.id, as, counts, setClock: (t: number) => (clock = t) };
}

const KEEP_ALL = {
  contact: ['firstName', 'lastName', 'phone', 'email', 'project'],
  bien: ['kind', 'postalCode', 'city', 'surfaceM2', 'rooms', 'priceEur'],
  rendezvous: ['appointmentKind', 'start'],
};

describeWithSqlite('HX06 · création à la voix', () => {
  it('[R261] lire la dictée ne range rien : ni fiche, ni bien, ni rendez-vous, ni journal', async () => {
    const t = await setup();
    const before = await t.counts();
    const entries = (await t.journal.all()).length;
    const r = await t.voix.prepare(t.alex, { dictation: SELLER_DICTATION });
    expect(r).toMatchObject({ ok: true, report: null });
    expect(await t.counts()).toEqual(before);
    expect((await t.journal.all()).length).toBe(entries);
  });

  it('[R261] validée d’un geste : la fiche, ses coordonnées, le bien et le rendez-vous, sans aucun message au contact', async () => {
    const t = await setup();
    const r = await t.voix.validate(t.alex, { readAt: t.now().toISOString(), requestId: key(1), dictation: SELLER_DICTATION, keep: KEEP_ALL });
    expect(r).toMatchObject({ ok: true, contact: 'created', personId: key(1), propertyId: key(1), report: null });
    if (!r.ok) return;
    expect(await t.db.first('SELECT first_name, last_name, agent_id FROM persons WHERE id = ?', [key(1)])).toEqual({ first_name: 'Claire', last_name: 'Exemple', agent_id: t.alexId });
    expect((await t.db.all<{ kind: string; value: string }>('SELECT kind, value FROM person_identifiers WHERE person_id = ? ORDER BY kind', [key(1)])).map((i) => [i.kind, i.value])).toEqual([
      ['email', 'claire.exemple@example.test'],
      ['phone', '+33612345678'],
    ]);
    expect(await t.db.first('SELECT kind, postal_code, city, surface_m2, rooms, price_eur, status, agent_id FROM properties WHERE id = ?', [key(1)])).toEqual({
      kind: 'home', postal_code: '21240', city: 'Talant', surface_m2: 120, rooms: 5, price_eur: 320000, status: 'draft', agent_id: t.alexId,
    });
    expect(await t.db.all('SELECT kind, person_id FROM projects')).toEqual([{ kind: 'sell', person_id: key(1) }]);
    expect(await t.db.first('SELECT kind, start_at, person_id, property_id, source, confirmation_channel FROM appointments WHERE id = ?', [r.appointmentId])).toEqual({
      kind: 'estimation', start_at: '2026-12-08T09:00:00.000Z', person_id: key(1), property_id: key(1), source: 'agent', confirmation_channel: null,
    });
    // Aucun message, aucun accord déduit de la dictée.
    expect((await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM messages'))!.n).toBe(0);
    expect((await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM consents'))!.n).toBe(0);
    // Le journal ne porte que des noms de champs et des identifiants [R13].
    // Empreintes et identifiants tirés au hasard retirés d'abord : « 0612 » peut y tomber par chance.
    const all = JSON.stringify(await t.journal.all()).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32,}/g, '');
    for (const secret of ['Claire', 'Exemple', '0612', '+33612345678', 'example.test', 'Talant', '320000', '320 000', 'Madame']) expect(all, secret).not.toContain(secret);
    expect((await t.journal.all()).filter((e) => e.type === 'dictee.validee')).toHaveLength(1);
    expect((await verifyChain(await t.journal.all())).ok).toBe(true);
  });

  it('[R260] [R261] RC01 : les nombres dits en lettres sont relus à la validation et rangés comme en chiffres', async () => {
    const t = await setup();
    const words = [
      'Je sors de chez Madame Claire Exemple, elle veut vendre sa maison.',
      'Son numéro est le 06 12 34 56 78.',
      'La maison fait cent vingt mètres carrés, un cinq pièces, au 21240 Talant.',
      'Prix demandé trois cent vingt mille euros.',
      "Rendez-vous d'estimation mardi à dix heures.",
    ].join(' ');
    const read = await t.voix.prepare(t.alex, { dictation: words });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.draft.fields.filter((f) => f.target === 'bien' && typeof f.value === 'number').map((f) => [f.key, f.value, f.quote])).toEqual([
      ['surfaceM2', 120, 'cent vingt mètres carrés'],
      ['rooms', 5, 'cinq pièces'],
      ['priceEur', 320000, 'trois cent vingt mille euros'],
    ]);
    const r = await t.voix.validate(t.alex, { readAt: read.readAt, requestId: key(1), dictation: words, keep: { contact: ['firstName', 'lastName', 'phone', 'project'], bien: KEEP_ALL.bien, rendezvous: KEEP_ALL.rendezvous } });
    expect(r).toMatchObject({ ok: true, propertyId: key(1) });
    if (!r.ok) return;
    expect(await t.db.first('SELECT surface_m2, rooms, price_eur FROM properties WHERE id = ?', [key(1)])).toEqual({ surface_m2: 120, rooms: 5, price_eur: 320000 });
    expect(await t.db.first('SELECT kind, start_at FROM appointments WHERE id = ?', [r.appointmentId])).toEqual({ kind: 'estimation', start_at: '2026-12-08T09:00:00.000Z' });
    // Une autre dictée, qui ne dit pas ces nombres, ne les fait pas garder.
    const other = await t.voix.validate(t.alex, { readAt: t.now().toISOString(), requestId: key(2), dictation: 'Madame Zoé Exemple vend sa maison de deux trois pièces au 21240 Talant.', keep: { bien: ['rooms'] } });
    expect(other).toMatchObject({ ok: false, rule: 'R260', code: 'not_dictated', keys: ['bien.rooms'] });
  });

  it('[R261] la même demande rejouée ne crée rien de plus', async () => {
    const t = await setup();
    const a = await t.voix.validate(t.alex, { readAt: t.now().toISOString(), requestId: key(1), dictation: SELLER_DICTATION, keep: KEEP_ALL });
    const after = await t.counts();
    const b = await t.voix.validate(t.alex, { readAt: t.now().toISOString(), requestId: key(1), dictation: SELLER_DICTATION, keep: KEEP_ALL });
    expect(b).toMatchObject({ ok: true, personId: key(1), propertyId: key(1) });
    if (a.ok && b.ok) expect(b.appointmentId).toBe(a.appointmentId);
    expect(await t.counts()).toEqual(after);
  });

  it('[R260] un champ que la dictée ne porte pas est refusé, et rien n’est rangé', async () => {
    const t = await setup();
    const before = await t.counts();
    const dictation = 'Madame Claire Exemple vend sa maison de 120 m² au 21240 Talant.';
    expect(await t.voix.validate(t.alex, { readAt: t.now().toISOString(), requestId: key(1), dictation, keep: { contact: ['firstName'], bien: ['kind', 'postalCode', 'city', 'surfaceM2', 'priceEur'] } })).toEqual({
      ok: false, rule: 'R260', code: 'not_dictated', keys: ['bien.priceEur'],
    });
    expect(await t.voix.validate(t.alex, { readAt: t.now().toISOString(), requestId: key(1), dictation, keep: { contact: ['firstName', 'birthday'] } })).toMatchObject({ ok: false, rule: 'R260', keys: ['contact.birthday'] });
    // Un compte rendu qui porte un chiffre que la dictée ne dit pas.
    expect(await t.voix.validate(t.alex, { readAt: t.now().toISOString(), requestId: key(1), dictation, keep: {}, report: { opinion: 'Offre à 300 000 euros.', strengths: [], reservations: [], interest: 'fort', readyToOffer: false } })).toMatchObject({ ok: false, code: 'report_without_visit' });
    expect(await t.counts()).toEqual(before);
  });

  it('[R260] un bien incomplet, sans propriétaire ou d’un acquéreur n’est pas créé, et rien d’autre non plus', async () => {
    const t = await setup();
    const before = await t.counts();
    expect(await t.voix.validate(t.alex, { readAt: t.now().toISOString(), requestId: key(1), dictation: 'Madame Claire Exemple vend sa maison à Talant.', keep: { contact: ['lastName'], bien: ['kind', 'city'] } })).toEqual({
      ok: false, rule: null, code: 'incomplete_property', keys: ['bien.postalCode', 'bien.surfaceM2'],
    });
    expect(await t.voix.validate(t.alex, { readAt: t.now().toISOString(), requestId: key(1), dictation: SELLER_DICTATION, keep: { bien: KEEP_ALL.bien } })).toMatchObject({ ok: false, code: 'property_without_owner' });
    expect(await t.counts()).toEqual(before);
  });

  it('[R261] seul l’agent qui dicte valide : la direction ne crée rien en son nom', async () => {
    const t = await setup();
    expect(await t.voix.prepare(t.direction, { dictation: SELLER_DICTATION })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.voix.validate(t.direction, { readAt: t.now().toISOString(), requestId: key(1), dictation: SELLER_DICTATION, keep: KEEP_ALL })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect((await t.counts()).persons).toBe(0);
    // Une demande déjà prise par un autre agent n'est pas la sienne.
    await t.voix.validate(t.sam, { readAt: t.now().toISOString(), requestId: key(1), dictation: 'Madame Claire Exemple.', keep: { contact: ['lastName', 'firstName'] } });
    expect(await t.voix.validate(t.alex, { readAt: t.now().toISOString(), requestId: key(1), dictation: 'Madame Claire Exemple.', keep: { contact: ['lastName'] } })).toEqual({ ok: false, rule: null, code: 'bad_request' });
  });

  it('[R262] un numéro déjà dans une fiche de l’agent : le contact la rejoint, ses noms restent', async () => {
    const t = await setup();
    const known = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Clara', lastName: 'Exemple' });
    await t.store.addIdentifier({ networkId: t.network.id, personId: known.id, kind: 'phone', value: '+33612345678' });
    const r = await t.voix.validate(t.alex, { readAt: t.now().toISOString(), requestId: key(1), dictation: SELLER_DICTATION, keep: KEEP_ALL });
    expect(r).toMatchObject({ ok: true, contact: 'matched', personId: known.id });
    expect(await t.db.first('SELECT first_name FROM persons WHERE id = ?', [known.id])).toEqual({ first_name: 'Clara' });
    expect((await t.counts()).persons).toBe(1);
    // Le mail dicté rejoint sa fiche.
    expect((await t.db.all('SELECT kind FROM person_identifiers WHERE person_id = ? ORDER BY kind', [known.id])).length).toBe(2);
  });

  it('[R262] deux fiches portent le numéro et le mail, ou la fiche est à un autre agent : rien n’est fait', async () => {
    const t = await setup();
    const a = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'A' });
    const b = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'B' });
    await t.store.addIdentifier({ networkId: t.network.id, personId: a.id, kind: 'phone', value: '+33612345678' });
    await t.store.addIdentifier({ networkId: t.network.id, personId: b.id, kind: 'email', value: 'claire.exemple@example.test' });
    const before = await t.counts();
    expect(await t.voix.validate(t.alex, { readAt: t.now().toISOString(), requestId: key(1), dictation: SELLER_DICTATION, keep: KEEP_ALL })).toEqual({ ok: false, rule: 'R262', code: 'ambiguous_contact' });
    expect(await t.counts()).toEqual(before);

    const other = await t.store.createPerson({ networkId: t.network.id, agentId: t.samId, firstName: 'C' });
    await t.store.addIdentifier({ networkId: t.network.id, personId: other.id, kind: 'phone', value: '+33698765432' });
    const mid = await t.counts();
    expect(await t.voix.validate(t.alex, { readAt: t.now().toISOString(), requestId: key(2), dictation: 'Madame Claire Essai vend, son numéro 06 98 76 54 32.', keep: { contact: ['firstName', 'phone'] } })).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(await t.counts()).toEqual(mid);
  });

  it('[R261] un créneau pris : la fiche retrouvée ne reçoit rien non plus', async () => {
    const t = await setup();
    const known = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Clara' });
    await t.store.addIdentifier({ networkId: t.network.id, personId: known.id, kind: 'phone', value: '+33612345678' });
    const someone = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Déjà' });
    await t.rdv.book({ networkId: t.network.id, agentId: t.alexId, personId: someone.id, kind: 'visite', start: new Date('2026-12-08T09:00:00.000Z'), source: 'agent' });
    const before = await t.counts();
    expect(await t.voix.validate(t.alex, { readAt: t.now().toISOString(), requestId: key(1), dictation: SELLER_DICTATION, keep: KEEP_ALL })).toMatchObject({ ok: false, code: 'slot_not_free' });
    expect(await t.counts()).toEqual(before);
  });

  it('[R260] la dictée est relue à l’instant de la lecture : « demain » ne glisse pas d’un jour', async () => {
    const t = await setup();
    const dictation = 'Monsieur Paul Essai veut vendre. Rendez-vous d’estimation demain à 10 h.';
    // Lue à 23 h 59, validée à 0 h 01 : le rendez-vous reste celui montré.
    t.setClock(Date.parse('2026-12-03T22:59:00.000Z'));
    const p = await t.voix.prepare(t.alex, { dictation });
    if (!p.ok) throw new Error(p.code);
    expect(dictee.fieldOf(p.draft, 'rendezvous', 'start')?.value).toBe('2026-12-04T09:00:00.000Z');
    t.setClock(Date.parse('2026-12-03T23:01:00.000Z'));
    const r = await t.voix.validate(t.alex, { readAt: p.readAt, requestId: key(1), dictation, keep: { contact: ['firstName', 'lastName', 'project'], rendezvous: ['appointmentKind', 'start'] } });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(await t.db.first('SELECT start_at FROM appointments WHERE id = ?', [r.appointmentId])).toEqual({ start_at: '2026-12-04T09:00:00.000Z' });
    // Une lecture absente, à venir ou trop ancienne se refait.
    for (const readAt of ['', '2026-12-04T00:00:00.000Z', '2026-12-03T10:00:00.000Z']) {
      expect(await t.voix.validate(t.alex, { readAt, requestId: key(2), dictation, keep: { contact: ['firstName'] } }), readAt).toEqual({ ok: false, rule: null, code: 'stale_reading' });
    }
  });

  it('[R261] un créneau pris : rien n’est créé, ni fiche, ni bien', async () => {
    const t = await setup();
    const someone = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Déjà' });
    const taken = await t.rdv.book({ networkId: t.network.id, agentId: t.alexId, personId: someone.id, kind: 'visite', start: new Date('2026-12-08T09:00:00.000Z'), source: 'agent' });
    expect(taken.ok).toBe(true);
    const before = await t.counts();
    expect(await t.voix.validate(t.alex, { readAt: t.now().toISOString(), requestId: key(1), dictation: SELLER_DICTATION, keep: KEEP_ALL })).toEqual({ ok: false, rule: 'R32', code: 'slot_not_free' });
    expect(await t.counts()).toEqual(before);
    // Sans le rendez-vous, le reste se crée.
    expect(await t.voix.validate(t.alex, { readAt: t.now().toISOString(), requestId: key(1), dictation: SELLER_DICTATION, keep: { contact: KEEP_ALL.contact, bien: KEEP_ALL.bien } })).toMatchObject({ ok: true, appointmentId: null });
  });
});

const GOOD: VisitReport = { opinion: 'Le visiteur a aimé la lumière du séjour.', strengths: ['séjour lumineux', 'jardin'], reservations: ['cuisine à refaire'], interest: 'fort', readyToOffer: false };

async function withVisit(writer?: ReportWriter) {
  const t = await setup(writer);
  await t.visites.createSlipTemplate(t.direction, 'Bon de visite : {{visiteur.nom}} visite {{bien.reference}} le {{visite.date}}.');
  const seller = await t.store.createPerson({ networkId: t.network.id, agentId: t.samId, firstName: 'Victor', lastName: 'Vendeur' });
  await t.store.addIdentifier({ networkId: t.network.id, personId: seller.id, kind: 'email', value: 'victor@example.test' });
  await t.store.addConsent({ networkId: t.network.id, personId: seller.id, purpose: SELLER_UPDATE_PURPOSE, channel: 'email', proof: 'mandat', givenAt: new Date(THURSDAY_10H - 10 * 24 * HOUR) });
  const property = await t.store.createProperty({ networkId: t.network.id, agentId: t.samId, reference: 'B1', kind: 'home', city: 'Talant', priceEur: 250_000, surfaceM2: 90, rooms: 4, status: 'available' });
  await t.db.run(
    "INSERT INTO mandates (id, network_id, agent_id, person_id, property_id, signed_at, source_kind, recorded_by, created_at) VALUES ('m1', ?, ?, ?, ?, ?, 'site', 'test', ?)",
    [t.network.id, t.samId, seller.id, property.id, new Date(THURSDAY_10H - 20 * 24 * HOUR).toISOString(), NOW.toISOString()],
  );
  await t.db.run(
    "INSERT INTO mandate_register (network_id, seq, kind, mandate_id, number_value, number, agent_id, property_id, signed_at, at, actor, prev_hash, hash) VALUES (?, 1, 'inscription', 'm1', 1, 'T-1', ?, ?, ?, ?, 'test', 'p', 'h-m1')",
    [t.network.id, t.samId, property.id, new Date(THURSDAY_10H - 20 * 24 * HOUR).toISOString(), NOW.toISOString()],
  );
  const buyer = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Inès', lastName: 'Durand' });
  await t.store.addIdentifier({ networkId: t.network.id, personId: buyer.id, kind: 'email', value: 'ines@example.test' });
  const project = await t.store.createProject({ networkId: t.network.id, agentId: t.alexId, personId: buyer.id, kind: 'buy' });
  const v = await t.visites.schedule(t.alex, { propertyId: property.id, projectId: project.id, start: new Date(THURSDAY_10H + 24 * HOUR) });
  if (!v.ok) throw new Error(v.code);
  t.setClock(Date.parse(v.visit.appointment.end_at) + 10 * 60_000);
  const toSeller = () => t.db.all<{ body: string }>('SELECT m.body FROM messages m JOIN trial_outbox o ON o.message_id = m.id WHERE m.person_id = ?', [seller.id]);
  return { ...t, visitId: v.visit.appointment.id, buyer, seller, toSeller };
}

const AFTER_VISIT = 'Elle a aimé la lumière du séjour et le jardin, la cuisine est à refaire, intérêt fort. Contre-visite samedi à 10 h.';

describeWithSqlite('HX06 · en sortant d’une visite : la fiche, l’avis de visite et la relance du vendeur, d’un geste', () => {
  it('[R261] la lecture montre le compte rendu sans le ranger ; la validation l’envoie au vendeur et réserve la contre-visite', async () => {
    const t = await withVisit({ write: async () => GOOD });
    const before = await t.counts();
    const p = await t.voix.prepare(t.alex, { dictation: AFTER_VISIT, appointmentId: t.visitId });
    expect(p).toMatchObject({ ok: true, report: GOOD });
    if (!p.ok) return;
    expect(p.draft.fields.map((f) => `${f.target}.${f.key}`)).toEqual(['rendezvous.appointmentKind', 'rendezvous.start']);
    expect(await t.counts()).toEqual(before);
    expect(await t.toSeller()).toEqual([]);

    const r = await t.voix.validate(t.alex, { readAt: t.now().toISOString(), requestId: key(9), dictation: AFTER_VISIT, appointmentId: t.visitId, keep: { rendezvous: ['appointmentKind', 'start'] }, report: p.report });
    expect(r).toMatchObject({ ok: true, personId: t.buyer.id, contact: null, report: { delivery: 'sent', rule: null } });
    if (!r.ok) return;
    const sent = await t.toSeller();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain('Bonjour Victor, voici le compte rendu de la visite de votre bien');
    expect(sent[0]!.body).not.toMatch(/Inès|Durand|ines@/);
    expect(await t.db.first('SELECT kind, start_at, person_id, confirmation_channel FROM appointments WHERE id = ?', [r.appointmentId])).toEqual({
      kind: 'visite', start_at: '2026-12-05T09:00:00.000Z', person_id: t.buyer.id, confirmation_channel: null,
    });
    // La relance de l'acquéreur, une seule (T06).
    expect(await t.db.all("SELECT kind FROM visit_tasks WHERE appointment_id = ?", [t.visitId])).toEqual([{ kind: 'relance_acquereur' }]);
    // La contre-visite est une vraie visite : même bien, même projet, son bon de visite.
    expect(await t.db.first('SELECT property_id, project_id FROM visits WHERE appointment_id = ?', [r.appointmentId])).toEqual(
      await t.db.first('SELECT property_id, project_id FROM visits WHERE appointment_id = ?', [t.visitId]),
    );
    expect(await t.visites.accessVisit(t.alex, r.appointmentId!)).toMatchObject({ ok: true });
    // Rejouée : rien ne part deux fois.
    expect(await t.voix.validate(t.alex, { readAt: t.now().toISOString(), requestId: key(9), dictation: AFTER_VISIT, appointmentId: t.visitId, keep: { rendezvous: ['appointmentKind', 'start'] }, report: p.report })).toMatchObject({ ok: true, appointmentId: r.appointmentId });
    expect(await t.toSeller()).toHaveLength(1);
  });

  it('[R261] une visite d’un autre bien à l’heure de la contre-visite n’est pas prise pour elle : le créneau est refusé', async () => {
    const t = await withVisit({ write: async () => GOOD });
    const b2 = await t.store.createProperty({ networkId: t.network.id, agentId: t.samId, reference: 'B2', kind: 'home', city: 'Talant', priceEur: 200_000, surfaceM2: 70, rooms: 3, status: 'available' });
    const project = (await t.db.first<{ project_id: string }>('SELECT project_id FROM visits WHERE appointment_id = ?', [t.visitId]))!.project_id;
    const other = await t.visites.schedule(t.alex, { propertyId: b2.id, projectId: project, start: new Date('2026-12-05T09:00:00.000Z') });
    expect(other.ok).toBe(true);
    const before = await t.counts();
    expect(await t.voix.validate(t.alex, { readAt: t.now().toISOString(), requestId: key(9), dictation: AFTER_VISIT, appointmentId: t.visitId, keep: { rendezvous: ['appointmentKind', 'start'] }, report: GOOD })).toMatchObject({ ok: false, code: 'slot_not_free' });
    expect(await t.counts()).toEqual(before);
    expect(await t.toSeller()).toEqual([]);
  });

  it('[R260] un compte rendu qui porte un chiffre ou une offre que la dictée ne dit pas est refusé, rien ne part', async () => {
    const t = await withVisit();
    const before = await t.counts();
    expect(await t.voix.validate(t.alex, { readAt: t.now().toISOString(), requestId: key(9), dictation: AFTER_VISIT, appointmentId: t.visitId, keep: {}, report: { ...GOOD, opinion: 'Prête à offrir 240 000 euros.' } })).toMatchObject({ ok: false, rule: 'R260', code: 'report_invented_figure' });
    expect(await t.voix.validate(t.alex, { readAt: t.now().toISOString(), requestId: key(9), dictation: AFTER_VISIT, appointmentId: t.visitId, keep: {}, report: { ...GOOD, readyToOffer: true } })).toMatchObject({ ok: false, rule: 'R260', code: 'report_invented_offer' });
    expect(await t.counts()).toEqual(before);
    expect(await t.toSeller()).toEqual([]);
  });

  it('[R15] le compte rendu ne reçoit ni le nom ni les coordonnées d’un contact dicté, ni ne les range', async () => {
    const briefs: string[] = [];
    const t = await withVisit({ write: async (b) => (briefs.push(b.dictation), GOOD) });
    const dictation = `${AFTER_VISIT} Monsieur Jean de Testeur veut vendre sa maison, son numéro 06 11 22 33 44. Madame Zoé Testeur aussi.`;
    const p = await t.voix.prepare(t.alex, { dictation, appointmentId: t.visitId });
    expect(p).toMatchObject({ ok: true, report: GOOD });
    expect(briefs).toHaveLength(1);
    expect(briefs[0]).not.toMatch(/Jean|Testeur|Zoé|06 11/);
    expect(briefs[0]).toContain('cuisine est à refaire');
    if (!p.ok) return;
    expect(await t.voix.validate(t.alex, { readAt: p.readAt, requestId: key(9), dictation, appointmentId: t.visitId, keep: {}, report: GOOD })).toMatchObject({ ok: true });
    const kept = await t.db.first<{ dictation: string }>('SELECT dictation FROM visit_reports WHERE appointment_id = ?', [t.visitId]);
    expect(kept!.dictation).not.toMatch(/Jean|Testeur|Zoé|06 11/);
  });

  it('[R52] un compte rendu qui nomme l’acquéreur est refusé avant toute écriture', async () => {
    const t = await withVisit();
    const dictation = `${AFTER_VISIT} Madame Zoé Testeur veut vendre, son numéro 06 11 22 33 44.`;
    const before = await t.counts();
    expect(await t.voix.validate(t.alex, { readAt: t.now().toISOString(), requestId: key(9), dictation, appointmentId: t.visitId, keep: { contact: ['firstName', 'lastName', 'phone', 'project'], rendezvous: ['appointmentKind', 'start'] }, report: { ...GOOD, opinion: 'Inès a aimé la lumière du séjour.' } })).toEqual({
      ok: false, rule: 'R52', code: 'report_buyer_named',
    });
    expect(await t.counts()).toEqual(before);
    expect(await t.toSeller()).toEqual([]);
  });

  it('une visite dictée hors d’une contre-visite se prend à l’écran des visites : rien n’est créé', async () => {
    const t = await setup();
    const before = await t.counts();
    expect(await t.voix.validate(t.alex, { readAt: t.now().toISOString(), requestId: key(1), dictation: 'Monsieur Paul Essai veut visiter, visite mardi à 10 h.', keep: { contact: ['firstName', 'lastName'], rendezvous: ['appointmentKind', 'start'] } })).toEqual({
      ok: false, rule: null, code: 'visit_needs_listing',
    });
    expect(await t.counts()).toEqual(before);
  });

  it('[R16] la visite d’un autre agent ne se lit ni ne se valide', async () => {
    const t = await withVisit({ write: async () => GOOD });
    expect(await t.voix.prepare(t.sam, { dictation: AFTER_VISIT, appointmentId: t.visitId })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.voix.validate(t.sam, { readAt: t.now().toISOString(), requestId: key(9), dictation: AFTER_VISIT, appointmentId: t.visitId, keep: {}, report: GOOD })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.toSeller()).toEqual([]);
  });
});

/**
 * RC22 : une autre réservation prend le créneau juste après sa vérification, avant la réservation de la dictée. La
 * course est jouée par une prise de rendez-vous glissée dans la première lecture des créneaux libres.
 */
function racing(t: Awaited<ReturnType<typeof setup>>, start: string, kind: 'estimation' | 'visite' = 'estimation') {
  let raced = false;
  let competing: string | null = null;
  const rendezVous = {
    freeSlotsFor: async (...args: Parameters<RendezVous['freeSlotsFor']>) => {
      const free = await t.rdv.freeSlotsFor(...args);
      if (!raced) {
        raced = true;
        const someone = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Autre' });
        const other = await t.rdv.book({ networkId: t.network.id, agentId: t.alexId, personId: someone.id, kind, start: new Date(start), source: 'agent' });
        if (!other.ok) throw new Error(other.code);
        competing = other.appointment.id;
      }
      return free;
    },
    book: (...args: Parameters<RendezVous['book']>) => t.rdv.book(...args),
  } as unknown as RendezVous;
  const voix = new Dictee(t.db, t.journal, { acces: new Acces(t.db, t.store, t.fiche, t.journal, { now: t.now }), store: t.store, fiche: t.fiche, biens: new NouveauBien(t.db, new Acces(t.db, t.store, t.fiche, t.journal, { now: t.now }), t.journal, { now: t.now }), rendezVous, visites: t.visites, comptes: t.comptes }, { now: t.now });
  return { voix, competing: () => competing };
}

/** AU053 : l'agenda relié de l'agent répond à la n-ième lecture, puis tombe (`AgendaUnavailableError` de l'API). */
function agendaFalling(t: Awaited<ReturnType<typeof setup>>, okReads: number) {
  let reads = 0;
  const rendezVous = new RendezVous(t.db, t.journal, {
    now: t.now,
    agenda: {
      busy: async () => {
        if (++reads > okReads) throw Object.assign(new Error('agenda injoignable'), { name: 'AgendaUnavailableError' });
        return [];
      },
    },
  });
  return new Dictee(t.db, t.journal, { acces: new Acces(t.db, t.store, t.fiche, t.journal, { now: t.now }), store: t.store, fiche: t.fiche, biens: new NouveauBien(t.db, new Acces(t.db, t.store, t.fiche, t.journal, { now: t.now }), t.journal, { now: t.now }), rendezVous, visites: t.visites, comptes: t.comptes }, { now: t.now });
}

describeWithSqlite('AU053 · l’agenda relié tombe pendant la dictée', () => {
  it('[R702] [R261] tombé entre la vérification et la réservation : le refus nomme la fiche et le bien rangés, rien n’est réservé', async () => {
    const t = await setup();
    const r = await agendaFalling(t, 1).validate(t.alex, { readAt: t.now().toISOString(), requestId: key(1), dictation: SELLER_DICTATION, keep: KEEP_ALL });
    expect(r).toMatchObject({ ok: false, rule: 'R702', code: 'agenda_indisponible', kept: { personId: key(1), contact: 'created', propertyId: key(1) } });
    expect(await t.db.all("SELECT id FROM appointments WHERE status = 'booked'")).toHaveLength(0);
  });

  it('[R702] tombé dès la vérification : refusé avant d’écrire', async () => {
    const t = await setup();
    const r = await agendaFalling(t, 0).validate(t.alex, { readAt: t.now().toISOString(), requestId: key(2), dictation: SELLER_DICTATION, keep: KEEP_ALL });
    expect(r).toMatchObject({ ok: false, rule: 'R702', code: 'agenda_indisponible' });
    expect(await t.db.all("SELECT id FROM appointments WHERE status = 'booked'")).toHaveLength(0);
  });
});

describeWithSqlite('RC22 · un créneau pris pendant la validation : le refus dit ce qui est rangé', () => {
  const TUESDAY_10H = '2026-12-08T09:00:00.000Z';

  it('[R261] [R32] le refus nomme la fiche et le bien rangés et propose jusqu’à trois créneaux libres, jamais passés', async () => {
    const t = await setup();
    const race = racing(t, TUESDAY_10H);
    const r = await race.voix.validate(t.alex, { readAt: t.now().toISOString(), requestId: key(1), dictation: SELLER_DICTATION, keep: KEEP_ALL });
    expect(r).toMatchObject({ ok: false, rule: 'R32', code: 'slot_taken_meanwhile', kept: { personId: key(1), contact: 'created', propertyId: key(1) } });
    if (r.ok) return;
    expect(r.freeSlots!.length).toBeGreaterThan(0);
    expect(r.freeSlots!.length).toBeLessThanOrEqual(3);
    // Chacun libre, de la même sorte, à venir, jamais celui qui vient d'être pris.
    const free = (await t.rdv.freeSlotsFor(t.alexId, 'estimation', new Date(Date.parse(TUESDAY_10H) - 86_400_000), new Date(Date.parse(TUESDAY_10H) + 86_400_000))).map((s) => s.start.toISOString());
    for (const s of r.freeSlots!) {
      expect(free).toContain(s);
      expect(Date.parse(s)).toBeGreaterThan(t.now().getTime());
    }
    expect(r.freeSlots).not.toContain(TUESDAY_10H);
    expect([...r.freeSlots!].sort()).toEqual(r.freeSlots);
  });

  it('[R261] rien n’est doublé : une fiche, un bien, aucun rendez-vous pour la dictée ; au journal des identifiants seulement [R13]', async () => {
    const t = await setup();
    const race = racing(t, TUESDAY_10H);
    await race.voix.validate(t.alex, { readAt: t.now().toISOString(), requestId: key(1), dictation: SELLER_DICTATION, keep: KEEP_ALL });
    expect(await t.db.all('SELECT id FROM properties')).toEqual([{ id: key(1) }]);
    expect(await t.db.all('SELECT id FROM appointments WHERE person_id = ?', [key(1)])).toEqual([]);
    expect(await t.db.all('SELECT id FROM appointments')).toEqual([{ id: race.competing() }]);
    const events = (await t.journal.all()).filter((e) => e.type === 'dictee.creneau_pris');
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({ rule: 'R261', request: key(1), refusal: 'taken', contact: 'created', person: key(1), property: key(1) });
    expect((await t.journal.all()).filter((e) => e.type === 'dictee.validee')).toEqual([]);
    const all = JSON.stringify(await t.journal.all()).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32,}/g, '');
    for (const secret of ['Claire', 'Exemple', '+33612345678', 'example.test', 'Talant', '320000']) expect(all, secret).not.toContain(secret);
    expect((await verifyChain(await t.journal.all())).ok).toBe(true);
  });

  it('[R261] rejouée, créneau encore pris : refusée avant toute écriture, en nommant ce qui est rangé ; sans le rendez-vous : la même fiche et le même bien', async () => {
    const t = await setup();
    const race = racing(t, TUESDAY_10H);
    await race.voix.validate(t.alex, { readAt: t.now().toISOString(), requestId: key(1), dictation: SELLER_DICTATION, keep: KEEP_ALL });
    const after = await t.counts();
    const entries = (await t.journal.all()).length;
    expect(await t.voix.validate(t.alex, { readAt: t.now().toISOString(), requestId: key(1), dictation: SELLER_DICTATION, keep: KEEP_ALL })).toEqual({
      ok: false, rule: 'R32', code: 'slot_not_free', kept: { personId: key(1), contact: 'created', propertyId: key(1) },
    });
    expect(await t.counts()).toEqual(after);
    expect((await t.journal.all()).length).toBe(entries);
    // Sans le rendez-vous : rien de plus, les mêmes identifiants.
    const again = await t.voix.validate(t.alex, { readAt: t.now().toISOString(), requestId: key(1), dictation: SELLER_DICTATION, keep: { contact: KEEP_ALL.contact, bien: KEEP_ALL.bien } });
    expect(again).toMatchObject({ ok: true, personId: key(1), contact: 'created', propertyId: key(1), appointmentId: null });
    expect(await t.counts()).toEqual(after);
  });

  it('[R261] rejouée quand le créneau s’est libéré : le rendez-vous est pris une seule fois', async () => {
    const t = await setup();
    const race = racing(t, TUESDAY_10H);
    await race.voix.validate(t.alex, { readAt: t.now().toISOString(), requestId: key(1), dictation: SELLER_DICTATION, keep: KEEP_ALL });
    expect((await t.rdv.cancelAsAgent(t.alex, race.competing()!)).ok).toBe(true);
    const a = await t.voix.validate(t.alex, { readAt: t.now().toISOString(), requestId: key(1), dictation: SELLER_DICTATION, keep: KEEP_ALL });
    expect(a).toMatchObject({ ok: true, personId: key(1), propertyId: key(1) });
    const b = await t.voix.validate(t.alex, { readAt: t.now().toISOString(), requestId: key(1), dictation: SELLER_DICTATION, keep: KEEP_ALL });
    if (a.ok && b.ok) expect(b.appointmentId).toBe(a.appointmentId);
    expect(await t.db.all("SELECT start_at FROM appointments WHERE person_id = ? AND status = 'booked'", [key(1)])).toEqual([{ start_at: TUESDAY_10H }]);
    expect((await t.counts()).properties).toBe(1);
    expect((await t.counts()).persons).toBe(2);
  });

  it('[R262] une fiche retrouvée par son numéro : le refus la nomme « retrouvée »', async () => {
    const t = await setup();
    const known = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Clara' });
    await t.store.addIdentifier({ networkId: t.network.id, personId: known.id, kind: 'phone', value: '+33612345678' });
    const race = racing(t, TUESDAY_10H);
    expect(await race.voix.validate(t.alex, { readAt: t.now().toISOString(), requestId: key(1), dictation: SELLER_DICTATION, keep: KEEP_ALL })).toMatchObject({
      ok: false, code: 'slot_taken_meanwhile', kept: { personId: known.id, contact: 'matched', propertyId: key(1) },
    });
  });

  it('[R261] une contre-visite prise entre-temps : même refus, rien n’est rangé ni validé, rien ne part au vendeur', async () => {
    const t = await withVisit({ write: async () => GOOD });
    const race = racing(t, '2026-12-05T09:00:00.000Z', 'visite');
    const entries = (await t.journal.all()).length;
    const r = await race.voix.validate(t.alex, { readAt: t.now().toISOString(), requestId: key(9), dictation: AFTER_VISIT, appointmentId: t.visitId, keep: { rendezvous: ['appointmentKind', 'start'] }, report: GOOD });
    expect(r).toMatchObject({ ok: false, rule: 'R32', code: 'slot_taken_meanwhile' });
    if (r.ok) return;
    expect(r.kept).toBeUndefined();
    expect(r.freeSlots).not.toContain('2026-12-05T09:00:00.000Z');
    expect(await t.db.first('SELECT status FROM visit_reports WHERE appointment_id = ?', [t.visitId])).toBeNull();
    expect(await t.toSeller()).toEqual([]);
    expect((await t.journal.all()).filter((e) => e.type.startsWith('dictee.'))).toEqual([]);
    expect((await t.journal.all()).length).toBeGreaterThanOrEqual(entries);
  });
});
