import { expect, it } from 'vitest';
import { Acces, SqlJournalStore, applyMigrations, createCaptation, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import {
  ConfidentialiteCommerce,
  DossierCommerce,
  EstimationCommerce,
  FicheCommerce,
  PresentationCommerce,
  hiddenMark,
  readMarks,
  visibleRef,
  type DossierStorage,
  type IdentityState,
} from '../src/commerces/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

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
  equipment: ['piano de cuisson', 'chambre froide'],
};
const BILAN = 'Bilan inventé de l’exercice 2026. Total du bilan : 812 300 €. Capitaux propres : 210 000 €. Dettes fournisseurs : 64 500 €. Trésorerie : 38 900 €.';
const OPEN_CODE = '987654';
const CONSENT = { consentProof: 'accord donné au rendez-vous du 7 septembre' };

async function setup(options: { maxOpens?: number } = {}) {
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
  const files = new Map<string, string>([['r2://essai/bilan-2026.txt', BILAN]]);
  const storage: DossierStorage = { read: async (ref) => files.get(ref) ?? null };
  const dossier = new DossierCommerce(db, journal, fiches, conf, storage, { now, newCode: () => OPEN_CODE, ...(options.maxOpens ? { maxOpens: options.maxOpens } : {}) });
  const network = await store.createNetwork('Réseau test');
  const alexAgent = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const samAgent = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const as = (role: 'agent' | 'direction' | 'compliance' | 'partner', userId: string) => ({ role, userId, networkId: network.id });
  const alex = as('agent', alexAgent.id);
  const direction = as('direction', 'dir-1');
  await conf.recordTemplate(direction, NDA_BODY);
  const shop = await store.createProperty({ networkId: network.id, agentId: alexAgent.id, reference: 'CE-1', kind: 'business', status: 'available', city: 'Dijon', postalCode: '21000' });
  await fiches.update(acces, alex, shop.id, SHEET);
  await dossier.addDocument(acces, alex, shop.id, { kind: 'bilan', title: 'Bilan 2026', storageRef: 'r2://essai/bilan-2026.txt' });
  let n = 0;
  /** Un repreneur, avec son adresse mail ; signé et vérifié si demandé. */
  const buyer = async (ready: boolean) => {
    const letter = 'ABCDEFGHIJ'[(n += 1)]!;
    const p = await store.createPerson({ networkId: network.id, agentId: alexAgent.id, firstName: `Repreneur${letter}`, lastName: 'Inventé' });
    const email = `repreneur.${letter.toLowerCase()}.invente@example.test`;
    await store.addIdentifier({ networkId: network.id, personId: p.id, kind: 'email', value: email });
    const r = await conf.requestAccess(acces, alex, shop.id, p.id);
    if (!r.ok || !r.value.ndaId) throw new Error('demande');
    if (ready) {
      verified.set(p.id, '2027-09-01');
      code = String(200_000 + n);
      const s = await conf.startSignature(acces, alex, r.value.ndaId, CONSENT);
      if (!s.ok) throw new Error('ouverture');
      const signed = await conf.sign(acces, alex, s.value.sessionId, { code });
      if (!signed.ok) throw new Error('signature');
    }
    return { id: p.id, email, ndaId: r.value.ndaId };
  };
  /** Le jeton du dernier lien rangé dans la boîte d'essai pour cette personne. */
  const tokenFor = async (personId: string): Promise<string> => {
    const rows = await db.all<{ body: string }>(
      `SELECT m.body FROM messages m JOIN trial_outbox t ON t.message_id = m.id WHERE m.person_id = ? AND m.body LIKE '%dossier confidentiel%' ORDER BY m.occurred_at DESC, m.rowid DESC`,
      [personId],
    );
    const m = /dossier\/([a-z]{40})/.exec(rows[0]?.body ?? '');
    if (!m) throw new Error('jeton');
    return m[1]!;
  };
  /** Le lecteur demande son code, le reçoit dans la boîte d'essai, et ouvre. */
  const openAs = async (token: string, email: string) => {
    await dossier.requestCode(token, email);
    return dossier.open(token, email, OPEN_CODE);
  };
  return { openAs, db, journal, acces, conf, dossier, alex, sam: as('agent', samAgent.id), direction, compliance: as('compliance', 'conf-1'), shop, buyer, tokenFor, advance: (ms: number) => (clock += ms), files };
}

describeWithSqlite('CE05 · dossier protégé d’un commerce', () => {
  it('[R114] [R26] chaque ouverture est journalisée avec son lecteur, une fois par ouverture ; le lien part en essai seulement', async () => {
    const t = await setup();
    const b = await t.buyer(true);
    const sent = await t.dossier.send(t.acces, t.alex, t.shop.id, b.id, CONSENT);
    expect(sent).toMatchObject({ ok: true, value: { mode: 'essai', maxOpens: 5 } });
    // Le jeton n'est rangé qu'en empreinte ; le message n'est que dans la boîte d'essai.
    const token = await t.tokenFor(b.id);
    expect(JSON.stringify(await t.db.all('SELECT * FROM business_dossier_links'))).not.toContain(token);
    expect(await t.db.all("SELECT 1 FROM messages m WHERE m.body LIKE '%dossier confidentiel%' AND m.id NOT IN (SELECT message_id FROM trial_outbox)")).toHaveLength(0);
    for (let i = 0; i < 3; i += 1) {
      const r = await t.openAs(token, b.email.toUpperCase());
      expect(r, `ouverture ${i}`).toMatchObject({ ok: true });
      if (r.ok) {
        expect(r.value.pages.map((p) => p.title)).toEqual(['Fiche du commerce', 'Bilan 2026']);
        expect(r.value.pages[0]!.text).toContain('La Table Inventée');
        expect(r.value.pages[1]!.text).toContain('812 300 €');
        for (const p of r.value.pages) expect(p.text).toContain('copie personnelle de RepreneurB Inventé');
      }
    }
    // Le code d'ouverture part aussi en essai seulement, à la personne du lien ; il n'est rangé qu'en empreinte.
    expect(await t.db.all("SELECT 1 FROM messages m JOIN trial_outbox t ON t.message_id = m.id WHERE m.person_id = ? AND m.body LIKE '%code pour ouvrir%'", [b.id])).toHaveLength(3);
    expect(JSON.stringify(await t.db.all('SELECT * FROM business_dossier_open_codes'))).not.toContain(OPEN_CODE);
    const log = await t.dossier.accesses(t.acces, t.alex, t.shop.id);
    expect(log.ok && log.value.map((a) => [a.outcome, a.personId])).toEqual([
      ['ouvert', b.id],
      ['ouvert', b.id],
      ['ouvert', b.id],
    ]);
    const events = (await t.journal.all()).filter((e) => e.type === 'commerces.dossier.ouvert');
    expect(events).toHaveLength(3);
    // Au journal, ni nom, ni mail, ni chiffre du dossier [R13].
    const text = JSON.stringify(await t.journal.all());
    for (const s of ['RepreneurB', 'example.test', 'Table Inventée', '812 300']) expect(text, s).not.toContain(s);
  });

  it('[R114] [R113] un lien expiré, révoqué, épuisé, ouvert par un autre lecteur ou dont l’engagement est révoqué est refusé et journalisé', async () => {
    const t = await setup({ maxOpens: 2 });
    const cases: { name: string; act: (b: { id: string; email: string; ndaId: string }, token: string) => Promise<unknown>; code: string }[] = [
      { name: 'autre lecteur', act: (_b, token) => t.dossier.open(token, 'quelquun.dautre@example.test', OPEN_CODE), code: 'autre_lecteur' },
      { name: 'sans adresse', act: (_b, token) => t.dossier.open(token, undefined, OPEN_CODE), code: 'autre_lecteur' },
      // Connaître l'adresse ne suffit pas : sans le code reçu à cette adresse, c'est un autre lecteur.
      { name: 'bonne adresse sans code', act: (b, token) => t.dossier.open(token, b.email, OPEN_CODE), code: 'autre_lecteur' },
      {
        name: 'code déjà servi',
        act: async (b, token) => {
          await t.openAs(token, b.email);
          return t.dossier.open(token, b.email, OPEN_CODE);
        },
        code: 'autre_lecteur',
      },
      {
        name: 'épuisé',
        act: async (b, token) => {
          await t.openAs(token, b.email);
          await t.openAs(token, b.email);
          return t.openAs(token, b.email);
        },
        code: 'epuise',
      },
      {
        name: 'révoqué',
        act: async (b, token) => {
          const link = await t.db.first<{ id: string }>('SELECT id FROM business_dossier_links WHERE person_id = ?', [b.id]);
          await t.dossier.revokeLink(t.acces, t.alex, link!.id);
          return t.dossier.open(token, b.email, OPEN_CODE);
        },
        code: 'revoque',
      },
      {
        name: 'engagement révoqué après l’envoi',
        act: async (b, token) => {
          await t.conf.revoke(t.acces, t.alex, b.ndaId, 'manquement');
          return t.openAs(token, b.email);
        },
        code: 'porte_fermee',
      },
      {
        name: 'expiré',
        act: async (b, token) => {
          t.advance(8 * 86_400_000);
          return t.dossier.open(token, b.email, OPEN_CODE);
        },
        code: 'expire',
      },
    ];
    for (const c of cases) {
      const b = await t.buyer(true);
      expect(await t.dossier.send(t.acces, t.alex, t.shop.id, b.id, CONSENT), c.name).toMatchObject({ ok: true });
      const r = await c.act(b, await t.tokenFor(b.id));
      expect(r, c.name).toMatchObject({ ok: false, code: c.code });
      const rows = await t.db.all<{ outcome: string; person_id: string }>("SELECT outcome, person_id FROM business_dossier_accesses WHERE person_id = ? AND outcome <> 'ouvert'", [b.id]);
      expect(rows, c.name).toEqual([{ outcome: c.code, person_id: b.id }]);
    }
    const refusals = (await t.journal.all()).filter((e) => e.type === 'commerces.dossier.refuse').map((e) => (e.data as { code: string }).code);
    expect(refusals).toEqual(cases.map((c) => c.code));
    // Un jeton inconnu : refusé et journalisé, sans lecteur connu.
    expect(await t.dossier.open('a'.repeat(40), 'x@example.test', OPEN_CODE)).toMatchObject({ ok: false, code: 'inconnu' });
    expect((await t.journal.all()).filter((e) => e.type === 'commerces.dossier.refuse')).toHaveLength(cases.length + 1);
  });

  it('[R113] aucun dossier ne part sans la porte de CE04 ; rien n’est rangé ni envoyé', async () => {
    const t = await setup();
    const unsigned = await t.buyer(false);
    expect(await t.dossier.send(t.acces, t.alex, t.shop.id, unsigned.id, CONSENT)).toMatchObject({ ok: false, rule: 'R113', code: 'door_closed' });
    expect(await t.db.all('SELECT 1 FROM business_dossier_links')).toHaveLength(0);
    expect(await t.db.all("SELECT 1 FROM messages WHERE body LIKE '%dossier confidentiel%'")).toHaveLength(0);
    // Un autre agent ne l'envoie pas, même à un repreneur prêt [R16].
    const ready = await t.buyer(true);
    expect(await t.dossier.send(t.acces, t.sam, t.shop.id, ready.id, CONSENT)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.dossier.trace(t.acces, t.sam, t.shop.id, 'texte')).toMatchObject({ ok: false, rule: 'R16' });
  });

  it('[R114] Jamais vu : deux lecteurs reçoivent deux copies aux marques différentes ; le traçage retrouve le bon lecteur sur 20 copies tests', async () => {
    const t = await setup({ maxOpens: 10 });
    const readers = [await t.buyer(true), await t.buyer(true)];
    const copies: { text: string; accessId: string; personId: string }[] = [];
    for (const r of readers) {
      await t.dossier.send(t.acces, t.alex, t.shop.id, r.id, CONSENT);
      const token = await t.tokenFor(r.id);
      for (let i = 0; i < 5; i += 1) {
        const o = await t.openAs(token, r.email);
        if (!o.ok) throw new Error('ouverture');
        copies.push({ text: o.value.pages.map((p) => p.text).join('\n\n'), accessId: o.value.accessId, personId: r.id });
      }
    }
    expect(new Set(copies.map((c) => readMarks(c.text)?.mark)).size).toBe(10);
    // Vingt copies tests : chaque ouverture, recopiée sans mise en forme, et un extrait.
    const strip = (s: string) => s.replace(/[​-‍⁠-⁤]/g, '');
    // Une partie des invisibles seulement retirée, un extrait de liste sans ponctuation, tout retiré.
    const listLines = (s: string) => s.split('\n').filter((l) => l.startsWith('Matériel') || l.startsWith('Salariés')).join('\n').replace(/[.]/g, '');
    const kinds = [
      (s: string) => s.split('\n\n')[3]!,
      (s: string) => strip(s).replace(/\s+/g, ' '),
      (s: string) => s.replace(/\u200b/g, ''),
      (s: string) => s.replace(/[\u2063\u2064]/g, ''),
      listLines,
    ];
    const variants = copies.flatMap((c, i) => [
      { ...c, leaked: c.text.replace(/\s+/g, ' ') },
      { ...c, leaked: kinds[i % kinds.length]!(c.text) },
    ]);
    expect(variants).toHaveLength(20);
    for (const v of variants) {
      const r = await t.dossier.trace(t.acces, t.alex, t.shop.id, v.leaked);
      expect(r, v.leaked.slice(0, 60)).toMatchObject({ ok: true, value: { accessId: v.accessId, personId: v.personId } });
    }
    // Un texte sans marque : rien n'est inventé.
    expect(await t.dossier.trace(t.acces, t.alex, t.shop.id, strip(copies[0]!.text).replace(/Réf\. de copie : \S+/g, ''))).toEqual({ ok: true, value: null });
  });

  it('la marque cachée et la référence visible se relisent exactement', () => {
    for (const mark of ['000000000000', 'ffffffffffff', '0123456789ab', 'a1b2c3d4e5f6']) {
      expect(readMarks(`Texte.${hiddenMark(mark)} Suite.`)).toEqual({ mark, via: 'marque' });
      expect(readMarks(`Réf. de copie : ${visibleRef(mark)}.`)).toEqual({ mark, via: 'reference' });
    }
    expect(visibleRef('a1b2c3d4e5f6')).toMatch(/^[A-Za-z]{5}-[A-Za-z]{5}$/);
  });

  it('[R17] un document changé depuis qu’il a été rangé n’est pas servi ; rien ne s’efface', async () => {
    const t = await setup();
    const b = await t.buyer(true);
    await t.dossier.send(t.acces, t.alex, t.shop.id, b.id, CONSENT);
    t.files.set('r2://essai/bilan-2026.txt', `${BILAN} Ligne ajoutée.`);
    const o = await t.openAs(await t.tokenFor(b.id), b.email);
    expect(o.ok && o.value.pages[1]!.text).toContain('Document indisponible');
    expect(o.ok && o.value.pages[1]!.text).not.toContain('Ligne ajoutée');
    await expect(t.db.run('DELETE FROM business_dossier_accesses')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run("UPDATE business_dossier_accesses SET outcome = 'expire'")).rejects.toThrow(/ne se réécrit pas/);
  });
});

it('aucun nombre réglé hors des bornes', () => {
  expect(() => new DossierCommerce({} as SqlDatabase, {} as never, {} as never, {} as never, { read: async () => null }, { maxOpens: 0 })).toThrow();
  expect(() => new DossierCommerce({} as SqlDatabase, {} as never, {} as never, {} as never, { read: async () => null }, { linkDays: 31 })).toThrow();
});
