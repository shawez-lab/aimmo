import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, createCaptation, fromSyncSqlite, type SqlDatabase } from '@aimmo/core';
import type { EstimatedKind, Sale, SalesCoverage, SalesSource } from '../../core/src/estimation/fourchette.ts';
import { OrigineContacts, PrixRegroupes, type LatLon } from '../../core/src/attirer/index.ts';
import { handleRequest, sha256Hex } from '../src/index.ts';
import { PRICES_JOB, pricesJob, runScheduler } from '../src/planificateur.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Réseau, personnes, sites, clés et ventes inventés.
const BASE = 'https://aimmo-api.example.test';
const SITE = 'https://site-reseau.example.test';
const KEY_FORM = 'test-cle-at10-form-aaaaaaaaaaaaaaaaaaaaaaaaaaa';
const KEY_CHAT = 'test-cle-at10-chat-bbbbbbbbbbbbbbbbbbbbbbbbbbb';
// Un mardi de novembre, 10 h à Paris.
const TUESDAY_10H = Date.parse('2026-11-10T09:00:00.000Z');
const DAY = 86_400_000;

async function world() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const network = (await new FicheClient(db).createNetwork('Réseau test')).id;
  let clock = TUESDAY_10H;
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const intakeKeys = JSON.stringify([
    { sha256: await sha256Hex(KEY_FORM), networkId: network, source: 'site_form' },
    { sha256: await sha256Hex(KEY_CHAT), networkId: network, source: 'site_chat' },
  ]);
  const origine = new OrigineContacts(db, journal, { now });
  const call = (path: string, body: unknown, key: string, database: SqlDatabase = db): Promise<Response> =>
    handleRequest(new Request(`${BASE}${path}`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }), {
      db: database,
      apiKeys: undefined,
      intakeKeys,
      mode: 'essai',
      now,
    });
  const origins = () => db.all<{ inbound_id: string; content_id: string | null; content_kind: string; method: string }>('SELECT inbound_id, content_id, content_kind, method FROM contact_origins ORDER BY recorded_at');
  return {
    db,
    network,
    journal,
    origine,
    call,
    origins,
    now,
    setClock: (t: number) => {
      clock = t;
    },
  };
}

let seq = 0;
function form(extra: Record<string, unknown> = {}) {
  seq += 1;
  return {
    submissionId: `envoi-at10-${seq}`,
    firstName: 'Alix',
    email: `formulaire.at10.${seq}@example.test`,
    message: 'Je souhaite être rappelé.',
    submittedAt: new Date(TUESDAY_10H).toISOString(),
    ...extra,
  };
}

/** Toutes les valeurs texte de toutes les tables, pour vérifier qu'une adresse n'est rangée nulle part. */
async function everyText(db: SqlDatabase): Promise<string> {
  const tables = await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'");
  const parts: string[] = [];
  for (const t of tables) for (const row of await db.all<Record<string, unknown>>(`SELECT * FROM "${t.name}"`)) parts.push(JSON.stringify(row));
  return parts.join('\n');
}

describeWithSqlite('AT10 · origine du contact dans la chaîne de captation', () => {
  it('[R156] un formulaire venu d’un contenu marqué garde son origine ; le lien lui-même n’est rangé nulle part', async () => {
    const t = await world();
    const content = await t.origine.contentFor(t.network, 'simulateur', 'simulateur');
    if (!content.ok) throw new Error(content.code);
    const link = `${SITE}/simulateur?o=${content.contentId}&utm_source=suivi-essai-xyz`;
    const res = await t.call('/v1/captation/formulaire', form({ link, landingPage: `${SITE}/simulateur?fbclid=navigateur-essai-123` }), KEY_FORM);
    expect(res.status).toBe(200);
    const rows = await t.origins();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ content_id: content.contentId, content_kind: 'simulateur', method: 'lien' });
    // Ni l'adresse, ni un paramètre de suivi, ni l'identifiant du navigateur ne sont gardés, dans aucune table [R156].
    const all = await everyText(t.db);
    expect(all).not.toContain('site-reseau.example.test');
    expect(all).not.toContain('suivi-essai-xyz');
    expect(all).not.toContain('navigateur-essai-123');
    expect((await t.journal.all()).filter((e) => e.type === 'attirer.origine').map((e) => e.data)).toEqual([{ rule: 'R156', kind: 'simulateur', method: 'lien' }]);
  });

  it('[R156] sans lien ni page, ou avec un code inconnu, l’origine est « inconnue », jamais devinée', async () => {
    const t = await world();
    await t.call('/v1/captation/formulaire', form(), KEY_FORM);
    await t.call('/v1/captation/formulaire', form({ link: `${SITE}/simulateur?o=abcdefghijkl` }), KEY_FORM);
    await t.call('/v1/captation/formulaire', form({ link: 'pas une adresse', landingPage: 42 }), KEY_FORM);
    const rows = await t.origins();
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r).toMatchObject({ content_id: null, content_kind: 'inconnue', method: 'inconnue' });
  });

  it('[R156] [R18] le même formulaire reçu deux fois : une seule origine, la première lecture compte', async () => {
    const t = await world();
    const a = await t.origine.contentFor(t.network, 'simulateur', 'simulateur');
    const b = await t.origine.contentFor(t.network, 'portail', 'portail-essai');
    if (!a.ok || !b.ok) throw new Error('contenu');
    const body = form({ link: `${SITE}/simulateur?o=${a.contentId}` });
    await t.call('/v1/captation/formulaire', body, KEY_FORM);
    await t.call('/v1/captation/formulaire', { ...body, link: `${SITE}/simulateur?o=${b.contentId}` }, KEY_FORM);
    const rows = await t.origins();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content_id).toBe(a.contentId);
  });

  it('[R156] un message de l’assistant du site venu d’un contenu marqué garde son origine', async () => {
    const t = await world();
    const content = await t.origine.contentFor(t.network, 'simulateur', 'simulateur');
    if (!content.ok) throw new Error(content.code);
    const visitorId = 'visiteur-at10-essai-0001';
    const opened = await t.call('/v1/assistant/sessions', { visitorId }, KEY_CHAT);
    expect(opened.status).toBe(201);
    const { sessionId } = (await opened.json()) as { sessionId: string };
    const sent = await t.call(`/v1/assistant/sessions/${sessionId}/messages`, { visitorId, messageId: 'm-1', text: 'Bonjour, je cherche un appartement.', link: `${SITE}/simulateur?o=${content.contentId}` }, KEY_CHAT);
    expect(sent.status).toBe(200);
    expect(await t.origins()).toEqual([expect.objectContaining({ content_id: content.contentId, content_kind: 'simulateur', method: 'lien' })]);
    expect(await everyText(t.db)).not.toContain('site-reseau.example.test');
  });

  it('[R156] sur 100 contacts inventés venus de contenus marqués, la mesure du mois depuis la base dépasse 95 %', async () => {
    const t = await world();
    const content = await t.origine.contentFor(t.network, 'simulateur', 'simulateur');
    if (!content.ok) throw new Error(content.code);
    for (let i = 0; i < 100; i++) {
      // 97 contacts arrivent par un lien marqué, 3 sans rien.
      const res = await t.call('/v1/captation/formulaire', form(i < 97 ? { link: `${SITE}/simulateur?o=${content.contentId}` } : {}), KEY_FORM);
      expect(res.status).toBe(200);
    }
    const m = await t.origine.measure({ role: 'direction', userId: 'dir-1', networkId: t.network }, '2026-11');
    if (!m.ok) throw new Error(m.code);
    expect(m.measure).toMatchObject({ contacts: 100, withOrigin: 97, percent: 97, meetsTarget: true });
  });

  it('[R156] [R01] une panne de l’origine ne retarde ni n’empêche la réponse ; elle va au journal, sans adresse', async () => {
    const t = await world();
    // Une base où ranger une origine échoue : tout le reste marche.
    const broken: SqlDatabase = {
      ...t.db,
      first: t.db.first.bind(t.db),
      all: t.db.all.bind(t.db),
      run: async (sql: string, params?: unknown[]) => {
        if (sql.includes('INTO contact_origins')) throw new TypeError('panne inventée');
        return t.db.run(sql, params as never);
      },
    } as SqlDatabase;
    const content = await t.origine.contentFor(t.network, 'simulateur', 'simulateur');
    if (!content.ok) throw new Error(content.code);
    const res = await t.call('/v1/captation/formulaire', form({ link: `${SITE}/simulateur?o=${content.contentId}` }), KEY_FORM, broken);
    expect(res.status).toBe(200);
    expect(await t.db.first<{ n: number }>('SELECT count(*) AS n FROM trial_outbox')).toEqual({ n: 1 });
    expect(await t.origins()).toHaveLength(0);
    const errors = (await t.journal.all()).filter((e) => e.type === 'attirer.origine_erreur');
    expect(errors.map((e) => e.data)).toEqual([{ rule: 'R156', error: 'TypeError' }]);
    expect(JSON.stringify(errors)).not.toContain('site-reseau');
    // Le même formulaire reçu de nouveau, base réparée : l'origine est rangée, une fois.
    await t.call('/v1/captation/formulaire', { ...form(), submissionId: `envoi-at10-${seq}`, link: `${SITE}/simulateur?o=${content.contentId}` }, KEY_FORM);
    expect(await t.origins()).toEqual([expect.objectContaining({ content_id: content.contentId })]);
  });

  it('[R156] un commentaire sous une publication connue, rangé par la chaîne, prend son origine sans signal de page', async () => {
    const t = await world();
    const content = await t.origine.contentFor(t.network, 'publication', 'publication-essai-1');
    if (!content.ok) throw new Error(content.code);
    expect(await t.origine.linkPost(t.network, content.contentId, 'instagram', 'post-essai-1')).toEqual({ ok: true });
    const { chaine } = createCaptation(t.db, t.journal, { now: t.now, withQualification: false });
    const results = await chaine.receive(t.network, 'instagram', {
      object: 'instagram',
      entry: [{ id: 'compte-reseau', time: 1, changes: [{ field: 'comments', value: { id: 'commentaire-1', text: 'Encore disponible ?', from: { id: 'abonne-1', username: 'abonne_essai' }, media: { id: 'post-essai-1' } } }] }],
    });
    expect(results).toHaveLength(1);
    expect(await t.origins()).toEqual([expect.objectContaining({ content_id: content.contentId, content_kind: 'publication', method: 'publication' })]);
  });
});

/** Une source DVF inventée : ventes données à la main, publication changeable. */
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
let saleSeq = 0;
function sale(pricePerM2: number, month: string): Sale {
  saleSeq++;
  return { id: `t:${saleSeq}`, kind: 'apartment', lat: 47.05 + (saleSeq % 50) / 10000, lon: 5.05, surface: 40 + (saleSeq % 30), pricePerM2, month };
}

describeWithSqlite('AT10 · pages de prix recalculées à chaque publication DVF', () => {
  it('[R150] [R151] sur horloge simulée : une version à 5 h pour une nouvelle publication, aucune de plus pour la même, la précédente reste lisible', async () => {
    const t = await world();
    const first = Array.from({ length: 7 }, (_, i) => sale(2000 + i * 100, '2026-03'));
    const source = new FakeSales({ department: '99', lastSale: '2026-06-30', years: [2025, 2026], source: 'DVF, jeu inventé' }, first);
    const direction = { role: 'direction' as const, userId: 'dir-1', networkId: t.network };
    const zone = await new PrixRegroupes(t.db, t.journal, source, { now: t.now }).defineZone(direction, { level: 'commune', slug: 'commune-test', name: 'Commune Test', inseeCode: '99001', ring: COMMUNE, ringSource: 'Contour inventé' });
    expect(zone.ok).toBe(true);
    const versions = () => t.db.all<{ dvf_last_sale: string }>("SELECT dvf_last_sale FROM price_versions WHERE status = 'complet' ORDER BY completed_at");
    // 10 h : la tâche ne passe pas.
    await runScheduler({ db: t.db, mode: 'essai', now: t.now, soldSales: source });
    expect(await versions()).toEqual([]);
    // Le lendemain, 5 h de Paris : la première version.
    t.setClock(TUESDAY_10H + DAY - 5 * 3_600_000);
    const tick = await runScheduler({ db: t.db, mode: 'essai', now: t.now, soldSales: source });
    expect(tick?.ran).toContain(PRICES_JOB);
    expect(await versions()).toEqual([{ dvf_last_sale: '2026-06-30' }]);
    // Le jour suivant, même publication : rien de nouveau.
    t.setClock(TUESDAY_10H + 2 * DAY - 5 * 3_600_000);
    await runScheduler({ db: t.db, mode: 'essai', now: t.now, soldSales: source });
    expect(await versions()).toHaveLength(1);
    // La publication d'octobre arrive : nouvelle version au passage de 5 h, la précédente reste lisible.
    source.cov = { department: '99', lastSale: '2026-09-30', years: [2025, 2026], source: 'DVF, jeu inventé' };
    source.list = [...first, ...Array.from({ length: 3 }, (_, i) => sale(2400 + i * 50, '2026-08'))];
    t.setClock(TUESDAY_10H + 3 * DAY - 5 * 3_600_000);
    await runScheduler({ db: t.db, mode: 'essai', now: t.now, soldSales: source });
    expect(await versions()).toEqual([{ dvf_last_sale: '2026-06-30' }, { dvf_last_sale: '2026-09-30' }]);
    const prix = new PrixRegroupes(t.db, t.journal, source, { now: t.now });
    const all = await prix.versions(t.network);
    expect(all).toHaveLength(2);
    for (const v of all) expect(await prix.communePrices(t.network, 'commune-test', v.id)).not.toBeNull();
  });

  it('sans ventes publiques branchées, la tâche n’existe pas ; un réseau en panne n’empêche pas les autres', async () => {
    const t = await world();
    t.setClock(TUESDAY_10H + DAY - 5 * 3_600_000);
    const tick = await runScheduler({ db: t.db, mode: 'essai', now: t.now });
    expect(tick?.ran ?? []).not.toContain(PRICES_JOB);
    expect(tick?.skipped ?? []).not.toContain(PRICES_JOB);
    // Deux réseaux avec des zones : le premier lit une source qui tombe, le second a sa version.
    const other = (await new FicheClient(t.db).createNetwork('Réseau test 2')).id;
    const good = new FakeSales({ department: '99', lastSale: '2026-06-30', years: [2026], source: 'DVF, jeu inventé' }, Array.from({ length: 6 }, (_, i) => sale(2000 + i * 10, '2026-03')));
    for (const id of [t.network, other]) {
      await new PrixRegroupes(t.db, t.journal, good, { now: t.now }).defineZone({ role: 'direction', userId: 'dir-1', networkId: id }, { level: 'commune', slug: 'commune-test', name: 'Commune Test', inseeCode: '99001', ring: COMMUNE, ringSource: 'Contour inventé' });
    }
    const flaky: SalesSource = {
      coverage: () => good.coverage(),
      within: async (kind) => {
        if (failNext) {
          failNext = false;
          throw new Error('source en panne');
        }
        return good.within(kind);
      },
    };
    let failNext = true;
    const job = pricesJob(t.db, t.journal, flaky, { now: t.now });
    await expect(job.run({ slot: 'essai' } as never)).rejects.toThrow('source en panne');
    const done = await t.db.all<{ network_id: string }>("SELECT network_id FROM price_versions WHERE status = 'complet'");
    expect(done.map((d) => d.network_id)).toEqual([[t.network, other].sort()[1]]);
  });
});
