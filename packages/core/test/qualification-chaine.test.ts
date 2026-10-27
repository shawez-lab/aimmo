import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SqlJournalStore,
  applyMigrations,
  createCaptation,
  fromSyncSqlite,
  measure,
  parseMeasureCases,
  qualifyByRules,
  type SqlDatabase,
} from '../src/index.ts';
import { QUALIFICATION_CASES } from './fixtures/qualification-cas.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const TUESDAY_10H = Date.parse('2026-12-08T09:00:00.000Z');
const SUNDAY_23H = Date.parse('2026-12-06T22:00:00.000Z');
const MINUTE = 60_000;

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = TUESDAY_10H;
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const captation = createCaptation(db, journal, { now });
  const network = await captation.store.createNetwork('Réseau test');
  const alex = await captation.store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  await captation.attribution.addZone(network.id, alex.id, 'Talant');
  return { db, journal, captation, network, alex, setClock: (t: number) => (clock = t) };
}

const count = async (db: SqlDatabase, table: string): Promise<number> => (await db.all(`SELECT * FROM ${table}`)).length;

describeWithSqlite('Q05 · qualification dans la chaîne de captation', () => {
  it('chaque nouveau contact a fiche, qualification, note, agent et, s’il est chaud, sa tâche en moins d’une minute, de jour comme de nuit', async () => {
    const t = await setup();
    for (const [i, at] of [TUESDAY_10H, SUNDAY_23H].entries()) {
      t.setClock(at);
      const [result] = await t.captation.chaine.receive(t.network.id, 'site_form', {
        submissionId: `f-${i}`,
        email: `client${i}@example.test`,
        message: 'Je souhaite vendre ma maison à Talant rapidement.',
      });
      expect(result).toMatchObject({ status: 'replied' });
      expect(result!.elapsedMs).toBeLessThan(MINUTE);
    }
    expect(await count(t.db, 'qualifications')).toBe(2);
    expect(await count(t.db, 'contact_scores')).toBe(2);
    const attributions = await t.db.all<{ agent_id: string }>('SELECT agent_id FROM attributions');
    expect(attributions.map((a) => a.agent_id)).toEqual([t.alex.id, t.alex.id]);
    const tasks = await t.db.all<{ created_at: string }>('SELECT created_at FROM callback_tasks ORDER BY created_at');
    expect(tasks).toHaveLength(2);
    const list = await t.captation.rappels.hotList(t.captation.acces, { role: 'agent', userId: t.alex.id, networkId: t.network.id });
    expect(list.ok && list.value.contacts).toHaveLength(2);
  });

  it('[R18] le même message reçu deux fois n’est qualifié et attribué qu’une fois', async () => {
    const t = await setup();
    const form = { submissionId: 'f-1', email: 'client@example.test', message: 'Je souhaite vendre ma maison à Talant rapidement.' };
    await t.captation.chaine.receive(t.network.id, 'site_form', form);
    await t.captation.chaine.receive(t.network.id, 'site_form', form);
    expect(await count(t.db, 'qualifications')).toBe(1);
    expect(await count(t.db, 'attributions')).toBe(1);
    expect(await count(t.db, 'callback_tasks')).toBe(1);
  });

  it('[R25] une personne exclue n’est ni qualifiée, ni attribuée, ni dans une tâche', async () => {
    const t = await setup();
    await t.captation.chaine.receive(t.network.id, 'site_form', { submissionId: 'f-1', email: 'client@example.test', message: 'Stop, ne m’écrivez plus.' });
    await t.captation.chaine.receive(t.network.id, 'site_form', { submissionId: 'f-2', email: 'client@example.test', message: 'Je souhaite vendre ma maison à Talant rapidement.' });
    expect(await count(t.db, 'attributions')).toBe(0);
    expect(await count(t.db, 'callback_tasks')).toBe(0);
  });

  it('[R13] une qualification en panne ne retarde ni n’empêche la réponse : au journal sans texte, reprise au nouvel envoi', async () => {
    const t = await setup();
    const real = t.captation.qualification.qualify.bind(t.captation.qualification);
    t.captation.qualification.qualify = async () => {
      throw new TypeError('panne');
    };
    const form = { submissionId: 'f-1', email: 'client@example.test', message: 'Je souhaite vendre ma maison à Talant rapidement.' };
    const [first] = await t.captation.chaine.receive(t.network.id, 'site_form', form);
    expect(first).toMatchObject({ status: 'replied' });
    expect(await count(t.db, 'qualifications')).toBe(0);
    const errors = (await t.journal.all()).filter((e) => e.type === 'qualification.erreur');
    expect(errors).toHaveLength(1);
    expect(JSON.stringify(errors)).not.toMatch(/Talant|example|vendre/);
    t.captation.qualification.qualify = real;
    await t.captation.chaine.receive(t.network.id, 'site_form', form);
    expect(await count(t.db, 'qualifications')).toBe(1);
    expect(await count(t.db, 'callback_tasks')).toBe(1);
  });
});

describe('Q05 · banc de mesure', () => {
  it('rend le taux d’accord et les écarts par numéro, sans texte', async () => {
    const result = await measure(QUALIFICATION_CASES, async (text) => qualifyByRules(text));
    expect(result.total).toBe(50);
    expect(JSON.stringify(result.gaps)).not.toMatch(/[a-z]{12,}/);
    const wrong = await measure([{ text: 'Je souhaite vendre ma maison.', category: 'buyer' }], async (text) => qualifyByRules(text));
    expect(wrong).toEqual({ total: 1, agreed: 0, rate: 0, gaps: [{ case: 1, expected: 'buyer', got: 'seller', gotRoute: null }] });
  });

  it('lit le format de docs/MESURE.md, et refuse une ligne illisible sans la recopier', () => {
    const cases = parseMeasureCases('texte;catégorie;suite\n"Je vends ma maison; vite";Vendeur;\nJe cherche une location;acquéreur;M15\n');
    expect(cases).toEqual([
      { text: 'Je vends ma maison; vite', category: 'seller', route: null },
      { text: 'Je cherche une location', category: 'buyer', route: 'M15' },
    ]);
    expect(() => parseMeasureCases('texte;catégorie\nUn texte secret;inconnue\n')).toThrow(/^Ligne 2 illisible/);
    try {
      parseMeasureCases('texte;catégorie\nUn texte secret;inconnue\n');
    } catch (error) {
      expect(String(error)).not.toContain('secret');
    }
  });
});

// La mesure réelle (H18) : `AIMMO_CAS=/chemin/hors/du/depot/cas.csv npx vitest run packages/core/test/qualification-chaine.test.ts`.
describe.runIf(process.env.AIMMO_CAS)('Q05 · mesure sur cas réels anonymisés', () => {
  it('90 % des cas classés comme Shawez l’aurait fait', async () => {
    const cases = parseMeasureCases(readFileSync(process.env.AIMMO_CAS!, 'utf8'));
    const result = await measure(cases, async (text) => qualifyByRules(text));
    console.log(`Mesure : ${result.agreed} sur ${result.total}, ${Math.round(result.rate * 100)} %. Écarts : ${JSON.stringify(result.gaps)}`);
    expect(result.total).toBeGreaterThanOrEqual(50);
    expect(result.rate).toBeGreaterThanOrEqual(0.9);
  });
});
