import { describe, expect, it } from 'vitest';
import { Acces, SqlJournalStore, applyMigrations, createCaptation, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { ConfidentialiteCommerce, DossierCommerce, EstimationCommerce, FicheCommerce, PresentationCommerce, loneHalfAt, type DossierStorage, type IdentityState } from '../src/commerces/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';
import { enClair } from './boite-essai.ts';

// RC48 : un texte déposé au dossier d'un commerce se relit toujours tel qu'il a été déposé.
const TUESDAY_10H = Date.parse('2027-09-07T08:00:00.000Z');
const NDA_BODY =
  'Engagement de confidentialité (modèle inventé pour les tests). Le signataire garde secrets les chiffres et documents du commerce qui lui sont communiqués, et ne les utilise que pour étudier sa reprise.';
const SHEET = {
  activity: 'restaurant',
  signName: 'La Table Inventée',
  fiscalYears: [{ year: 2026, revenueCents: 61_234_500, resultCents: 2_345_600, ebitdaCents: 5_432_100 }],
  leaseStart: '2020-01-01',
  leaseYears: 9,
  leaseAnnualRentCents: 2_400_000,
  employees: 6,
  equipment: ['piano de cuisson'],
};
const CONSENT = { consentProof: 'accord donné au rendez-vous du 7 septembre' };
const HALF = '\uD83C'; // la première moitié de « 🏠 », laissée seule
const OTHER_HALF = '\uDFE0'; // la seconde moitié, laissée seule

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
  const verified = new Map<string, string>();
  const identity: IdentityState = { state: async (_n, personId) => ({ identityVerifiedOn: verified.get(personId) ?? null }) };
  let code = '123456';
  const conf = new ConfidentialiteCommerce(db, journal, fiches, presentations, identity, { now, newCode: () => code });
  // Comme le stockage réel : le texte est écrit en UTF-8 et relu sans retirer la marque d'ordre.
  const files = new Map<string, Uint8Array>();
  const writes: string[] = [];
  const storage: DossierStorage = {
    read: async (ref) => {
      const b = files.get(ref);
      return b ? new TextDecoder('utf-8', { ignoreBOM: true }).decode(b) : null;
    },
    write: async (ref, content) => {
      writes.push(ref);
      files.set(ref, new TextEncoder().encode(content));
    },
  };
  let lastCode = '';
  let codes = 0;
  const dossier = new DossierCommerce(db, journal, fiches, conf, storage, { now, newCode: () => (lastCode = String(900_000 + (codes += 1))) });
  const network = await store.createNetwork('Réseau test');
  const alexAgent = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const alex = { role: 'agent' as const, userId: alexAgent.id, networkId: network.id };
  const direction = { role: 'direction' as const, userId: 'dir-1', networkId: network.id };
  await conf.recordTemplate(direction, NDA_BODY);
  const shop = await store.createProperty({ networkId: network.id, agentId: alexAgent.id, reference: 'CE-1', kind: 'business', status: 'available', city: 'Dijon', postalCode: '21000' });
  await fiches.update(acces, alex, shop.id, SHEET);
  const rows = async () => (await db.all('SELECT id FROM business_dossier_documents')).length;
  /** Un repreneur signé et vérifié, qui reçoit le lien et ouvre le dossier. */
  const reader = async (): Promise<string[]> => {
    const p = await store.createPerson({ networkId: network.id, agentId: alexAgent.id, firstName: 'RepreneurA', lastName: 'Inventé' });
    const email = 'repreneur.a.invente@example.test';
    await store.addIdentifier({ networkId: network.id, personId: p.id, kind: 'email', value: email });
    const r = await conf.requestAccess(acces, alex, shop.id, p.id);
    if (!r.ok || !r.value.ndaId) throw new Error('demande');
    verified.set(p.id, '2027-09-01');
    code = '200001';
    const s = await conf.startSignature(acces, alex, r.value.ndaId, CONSENT);
    if (!s.ok) throw new Error('ouverture');
    if (!(await conf.sign(acces, alex, s.value.sessionId, { code })).ok) throw new Error('signature');
    const sent = await dossier.send(acces, alex, shop.id, p.id, CONSENT);
    if (!sent.ok) throw new Error(`envoi ${JSON.stringify(sent)}`);
    const m = await enClair(db.all<{ id: string; body: string }>(`SELECT m.id, m.body FROM messages m JOIN trial_outbox t ON t.message_id = m.id WHERE m.person_id = ? AND m.body LIKE '%dossier confidentiel%'`, [p.id]));
    const token = /dossier\/([a-z]{40})/.exec(m[0]?.body ?? '')?.[1];
    if (!token) throw new Error('jeton');
    if (!(await dossier.requestCode(token, email)).ok) throw new Error('code');
    const opened = await dossier.open(token, email, lastCode);
    if (!opened.ok) throw new Error('ouverture du dossier');
    return opened.value.pages.map((page) => page.text);
  };
  return { acces, alex, direction, shop, dossier, files, writes, rows, reader };
}

describe('RC48 · la place d’une moitié de caractère seule', () => {
  it('dit la place du premier caractère fautif, comptée en caractères, et rien pour un texte bien écrit', () => {
    expect(loneHalfAt(`${HALF}Bail`)).toBe(1);
    expect(loneHalfAt(`Bail 🏠 du ${HALF}local`)).toBe(11);
    expect(loneHalfAt(`Bail${OTHER_HALF}`)).toBe(5);
    expect(loneHalfAt(`${OTHER_HALF}${HALF}`)).toBe(1);
    expect(loneHalfAt('Bail 🏠 inventé, été 2027, ﻿ au milieu')).toBeNull();
    expect(loneHalfAt('')).toBeNull();
  });
});

describeWithSqlite('RC48 · un texte déposé se relit tel qu’il a été déposé', () => {
  it('une moitié de caractère seule, au début, au milieu ou à la fin : refusé avec sa place, rien écrit nulle part', async () => {
    const t = await setup();
    for (const [content, at] of [
      [`${HALF}Bail inventé.`, 1],
      [`Bail inventé ${HALF} du local.`, 14],
      [`Bail inventé.${OTHER_HALF}`, 14],
    ] as const) {
      expect(await t.dossier.depositText(t.acces, t.alex, t.shop.id, { kind: 'bail', title: 'Bail', content })).toEqual({ ok: false, rule: null, code: 'content_malformed', at });
    }
    expect(t.writes).toEqual([]);
    expect(t.files.size).toBe(0);
    expect(await t.rows()).toBe(0);
    expect(await t.dossier.documents(t.acces, t.alex, t.shop.id)).toEqual({ ok: true, value: [] });
  });

  it('un titre fautif est refusé, au dépôt comme au rangement par référence, rien écrit', async () => {
    const t = await setup();
    expect(await t.dossier.depositText(t.acces, t.direction, t.shop.id, { kind: 'bail', title: `Bail ${HALF}`, content: 'Bail inventé.' })).toEqual({ ok: false, rule: null, code: 'title' });
    expect(t.writes).toEqual([]);
    const ok = await t.dossier.depositText(t.acces, t.alex, t.shop.id, { kind: 'bail', title: 'Bail', content: 'Bail inventé.' });
    expect(ok.ok).toBe(true);
    const ref = t.writes[0]!;
    expect(await t.dossier.addDocument(t.acces, t.alex, t.shop.id, { kind: 'bail', title: `${OTHER_HALF}Bail`, storageRef: ref })).toEqual({ ok: false, rule: null, code: 'title' });
    expect(await t.rows()).toBe(1);
  });

  it('émojis entiers, accents et marque d’ordre en tête : relus à l’identique, redéposés sans aucune écriture de plus', async () => {
    const t = await setup();
    const content = '﻿Bail inventé 🏠 du local, signé l’été 2027 ✍️. Loyer : 2 000 €.';
    const first = await t.dossier.depositText(t.acces, t.alex, t.shop.id, { kind: 'bail', title: 'Bail 🏠', content });
    expect(first).toMatchObject({ ok: true, value: { already: false, repaired: false } });
    expect(t.writes).toHaveLength(1);
    for (let i = 0; i < 3; i += 1) {
      expect(await t.dossier.depositText(t.acces, t.alex, t.shop.id, { kind: 'bail', title: 'Bail 🏠', content })).toMatchObject({ ok: true, value: { already: true, repaired: false } });
    }
    expect(t.writes).toHaveLength(1);
    expect(await t.rows()).toBe(1);
    const listed = await t.dossier.documents(t.acces, t.alex, t.shop.id);
    expect(listed).toMatchObject({ ok: true, value: [{ title: 'Bail 🏠', available: true }] });
  });

  it('le lecteur reçoit le texte déposé, sans aucun « � »', async () => {
    const t = await setup();
    expect((await t.dossier.depositText(t.acces, t.alex, t.shop.id, { kind: 'bail', title: 'Bail', content: 'Bail inventé 🏠 du local.' })).ok).toBe(true);
    expect((await t.dossier.depositText(t.acces, t.alex, t.shop.id, { kind: 'autre', title: 'Note', content: `Note ${HALF} coupée.` })).ok).toBe(false);
    const pages = (await t.reader()).join('\n');
    expect(pages).toContain('🏠');
    expect(pages).not.toContain('�');
    expect(pages).not.toContain('coupée');
  });
});
