import { describe, expect, it } from 'vitest';
import { SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import {
  PagesQuartier,
  fallbackNeighbourhood,
  renderNeighbourhoodPage,
  traceNeighbourhood,
  type NeighbourhoodData,
  type NeighbourhoodWriter,
  type PublishedNeighbourhood,
} from '../src/attirer/quartier.ts';
import type { CommunePrices, PublicCell } from '../src/attirer/prix-versions.ts';
import { BUDGETS, budgetProblems, htmlProblems } from '../src/design/audit.ts';
import { DESIGN_CSS } from '../src/design/systeme.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Tout est inventé : réseau, commune, quartier, chiffres, données, clients.
const direction = { role: 'direction' as const, userId: 'dir-1', networkId: 'net-1' };
const agent = { role: 'agent' as const, userId: 'ag-1', networkId: 'net-1' };

const commune = { slug: 'villetest', name: 'Villetest', level: 'commune' as const };
const quartier = { slug: 'les-tilleuls', name: 'Les Tilleuls', level: 'quartier' as const };
const cell = (zone: PublicCell['zone'], kind: PublicCell['kind'], sales: number, median: number, q1: number, q3: number): PublicCell => ({
  zone,
  kind,
  status: 'publiee',
  sales,
  median,
  q1,
  q3,
  source: 'DVF, jeu inventé',
  dvfLastSale: '2026-06-30',
  period: { from: '2024-07-01', to: '2026-06-30' },
});

const DATA: NeighbourhoodData = {
  zone: { slug: 'les-tilleuls', name: 'Les Tilleuls', communeSlug: 'villetest', communeName: 'Villetest' },
  cells: [cell(commune, 'apartment', 40, 2600, 2250, 3250), cell(quartier, 'apartment', 9, 2450, 2200, 2700)],
  listings: 3,
  facts: [
    { key: 'tram', kind: 'transport', label: 'Ligne T9 du tramway inventé', value: null, unit: null, source: 'Réseau de transport inventé', sourceDate: '2026-09-01' },
    { key: 'ecoles', kind: 'ecole', label: 'Écoles élémentaires du quartier', value: 3, unit: 'nombre', source: 'Annuaire inventé des écoles', sourceDate: '2026-09-15' },
    { key: 'pop', kind: 'population', label: 'Population du quartier', value: 8200, unit: 'habitants', source: 'Recensement inventé', sourceDate: '2025-01-01' },
  ],
};
const CLIENTS = { firstNames: new Set(['hortense']), lastNames: new Set(['quenouillard']) };
const problemsOf = (title: string, body: string, data = DATA) => traceNeighbourhood(title, body, data, CLIENTS).sentences.flatMap((s) => s.problems.map((p) => p.code));

describe('le contrôle des textes de quartier [R155]', () => {
  it('[R155] un texte fait des seules données passe, chaque phrase reliée à ses sources', () => {
    const t = traceNeighbourhood(
      'Le quartier des Tilleuls',
      'Aux Tilleuls, le prix médian des appartements est de 2 450 € le mètre carré, sur 9 ventes. À Villetest, celui des appartements est de 2 600 €. La Ligne T9 du tramway inventé dessert le quartier. Le quartier compte 3 écoles et 8 200 habitants, selon le Recensement inventé de 2025.',
      { ...DATA, zone: { ...DATA.zone, name: 'Tilleuls' } },
      CLIENTS,
    );
    expect(t.sentences.flatMap((s) => s.problems)).toEqual([]);
    expect(t.ok).toBe(true);
    const prix = t.sentences[1]!;
    expect(prix.sources.map((s) => s.ref)).toEqual(expect.arrayContaining(['prix:quartier:les-tilleuls:apartment:mediane', 'prix:quartier:les-tilleuls:apartment:ventes']));
    expect(t.sentences[3]!.sources.map((s) => s.ref)).toContain('fait:tram');
    expect(t.sentences[4]!.sources.map((s) => s.ref)).toEqual(expect.arrayContaining(['fait:ecoles', 'fait:pop']));
  });

  it('[R155] un nombre absent des données refuse le texte', () => {
    for (const body of [
      'Le prix médian est de 2 480 € le mètre carré.', // pas un chiffre de la case
      'Le quartier compte 12 ventes.', // pas le nombre de ventes
      'Le quartier compte 4 écoles.', // pas la valeur de la donnée
      'Le quartier compte quatre écoles.', // en lettres
      'Les prix ont pris 5 % en un an.', // tendance sans donnée
      'Le quartier est né en 1962.', // année sans source
      'Le tramway passe toutes les 7 minutes.', // durée sans donnée
      'Neuf biens sur dix trouvent preneur.', // proportion inventée
      'Une vingtaine de commerces.',
    ]) {
      expect(problemsOf('Les Tilleuls', body), body).toContain('nombre_sans_source');
    }
  });

  it('[R155] un nombre doit être celui que son unité désigne : 9 ventes, pas 9 €', () => {
    expect(problemsOf('Les Tilleuls', 'Un prix de 9 € le mètre carré.')).toContain('nombre_sans_source');
    expect(problemsOf('Les Tilleuls', 'Il y a 2450 ventes.')).toContain('nombre_sans_source');
    expect(problemsOf('Les Tilleuls', '3 biens sont en vente à Villetest.')).toEqual([]);
  });

  it('[R155] un fait absent des données refuse le texte : équipement, lieu, jugement', () => {
    const noFacts = { ...DATA, facts: [] };
    expect(problemsOf('Les Tilleuls', 'Le quartier est desservi par le tramway.', noFacts)).toContain('fait_sans_source');
    expect(problemsOf('Les Tilleuls', 'Un marché se tient chaque semaine.')).toContain('fait_sans_source');
    expect(problemsOf('Les Tilleuls', 'Le quartier borde le parc.')).toContain('fait_sans_source');
    expect(problemsOf('Les Tilleuls', 'Le quartier jouxte Montmirail et ses vignes.')).toContain('fait_sans_source');
    for (const body of ['Un quartier calme et recherché.', 'Les prix sont en hausse.', 'Un secteur sûr, idéal pour investir.', 'Tout est à proximité.']) {
      expect(problemsOf('Les Tilleuls', body), body).toContain('jugement');
    }
  });

  it('[R155] relecture forte : jugements sous toutes leurs formes, lieux sans donnée, phrases sans aucune donnée', () => {
    for (const body of [
      'Les prix des appartements grimpent aux Tilleuls.',
      'Un quartier idéal, en plein essor, très attractif.',
      'La tranquillité du quartier séduit.',
      'Le quartier a une vie nocturne bruyante et des problèmes de délinquance.',
      'Le quartier compte un million de visiteurs.',
    ]) {
      expect(problemsOf('Les Tilleuls', body), body).not.toEqual([]);
    }
    expect(problemsOf('Les Tilleuls', 'Un aéroport, une église et une mairie sont dans le quartier.')).toContain('fait_sans_source');
    expect(problemsOf('Les Tilleuls', 'Il fait bon vivre ici.')).toContain('fait_sans_source');
    // Un titre ne dit que le lieu et le sujet.
    expect(problemsOf('Les Tilleuls, quartier en pleine mutation', 'Le prix médian des appartements aux Tilleuls est de 2 450 €.')).not.toEqual([]);
    expect(problemsOf('Le quartier Les Tilleuls', 'Le prix médian des appartements aux Tilleuls est de 2 450 €.')).toEqual([]);
  });

  it('[R155] relecture forte : une année seulement avec sa source, un prix seulement pour sa case, un nombre pour son équipement', () => {
    expect(problemsOf('Les Tilleuls', 'La rénovation complète du quartier s’achève en 2026.')).not.toEqual([]);
    expect(problemsOf('Les Tilleuls', 'Le chantier de la Ligne T9 du tramway inventé finit en 2026.')).toContain('nombre_sans_source');
    expect(problemsOf('Les Tilleuls', 'Aux Tilleuls, les appartements vendus de 2024 à 2026 : 9 ventes.')).toEqual([]);
    expect(problemsOf('Les Tilleuls', 'Les maisons se vendent 2 450 € le mètre carré aux Tilleuls.')).toContain('nombre_sans_source');
    expect(problemsOf('Les Tilleuls', 'À Villetest, les appartements se vendent 2 450 € le mètre carré.')).toContain('nombre_sans_source');
    expect(problemsOf('Les Tilleuls', 'Le loyer moyen des appartements de Villetest est de 2 600 € par mois.')).toContain('fait_sans_source');
    expect(problemsOf('Les Tilleuls', 'Le quartier compte 9 écoles.')).toContain('nombre_sans_source');
    expect(problemsOf('Les Tilleuls', 'Le quartier compte 3 médecins.', { ...DATA, facts: [...DATA.facts, { key: 'med', kind: 'sante', label: 'Cabinet médical inventé', value: null, unit: null, source: 'Annuaire santé inventé', sourceDate: '2026-01-01' }] })).toContain('nombre_sans_source');
    expect(problemsOf('Les Tilleuls', 'Lidl ouvre près de la Ligne T9 du tramway inventé.')).toContain('fait_sans_source');
    expect(problemsOf('Les Tilleuls', 'Chenôve borde Les Tilleuls, avec ses 3 écoles.')).toContain('fait_sans_source');
  });

  it('[R46] aucune adresse exacte ni nom de client', () => {
    expect(problemsOf('Les Tilleuls', 'Un bien vendu au 12 rue des Essais.')).toContain('adresse');
    expect(problemsOf('Les Tilleuls', 'Les Tilleuls longent l’avenue Inventée.')).toContain('adresse');
    expect(problemsOf('Les Tilleuls', 'La famille quenouillard y habite.')).toEqual(expect.arrayContaining(['nom_client']));
    expect(problemsOf('Les Tilleuls', 'Merci à Hortense pour sa vente.')).toEqual(expect.arrayContaining(['nom_client']));
  });

  it('[R46] aucun critère discriminant ; [R07] vocabulaire du réseau', () => {
    expect(problemsOf('Les Tilleuls', 'Un quartier pour les familles.')).toContain('critere_discriminant');
    expect(problemsOf('Les Tilleuls', 'Votre mandataire vous attend.')).toContain('mot_interdit');
    expect(problemsOf('Les Tilleuls', 'Une estimation gratuite.')).toContain('mot_interdit');
    expect(problemsOf('Les Tilleuls', 'Texte écrit par une intelligence artificielle.')).toContain('mot_interdit');
  });

  it('[R155] le texte de secours passe toujours le contrôle, quelles que soient les données', () => {
    const cases: NeighbourhoodData[] = [DATA, { ...DATA, cells: [] }, { ...DATA, facts: [] }, { ...DATA, cells: [], facts: [], listings: 0 }, { ...DATA, listings: 1 }];
    for (const data of cases) {
      for (const [kind, topic] of [['page', 'quartier'], ['article', 'prix'], ['article', 'equipements']] as const) {
        const fb = fallbackNeighbourhood(kind, topic, data);
        // Sans aucune donnée pour ce sujet, il n'y a pas de texte : le service refuse (« sans_donnees »).
        if (fb.body === '') continue;
        const t = traceNeighbourhood(fb.title, fb.body, data, CLIENTS);
        expect(t.sentences.flatMap((s) => s.problems), `${topic} ${fb.body}`).toEqual([]);
      }
    }
  });
});

/* ---------- Le service, sur une base ---------- */

const prices = (cells: PublicCell[]): CommunePrices => ({ versionId: 'v1', computedAt: '2026-10-01T00:00:00.000Z', cells, held: [] });

async function setup(options: { writer?: NeighbourhoodWriter } = {}) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const journal = new SqlJournalStore(db);
  let clock = Date.parse('2026-10-30T08:00:00.000Z');
  const now = (): Date => new Date((clock += 1000));
  await db.run("INSERT INTO networks (id, name, created_at) VALUES ('net-1', 'Réseau test', 'x')");
  await db.run("INSERT INTO networks (id, name, created_at) VALUES ('net-2', 'Autre réseau', 'x')");
  await db.run("INSERT INTO agents (id, network_id, first_name, last_name, created_at, updated_at) VALUES ('ag-1', 'net-1', 'Camille', 'Exemple', 'x', 'x')");
  await db.run("INSERT INTO persons (id, network_id, agent_id, first_name, last_name, created_at, updated_at) VALUES ('p-1', 'net-1', 'ag-1', 'Hortense', 'Quenouillard', 'x', 'x')");
  const ring = JSON.stringify([[47.3, 5.0], [47.3, 5.1], [47.4, 5.1]]);
  await db.run("INSERT INTO price_zones (id, network_id, level, parent_id, slug, label, insee_code, ring_json, ring_source, recorded_by, recorded_at) VALUES ('z-c', 'net-1', 'commune', NULL, 'villetest', 'Villetest', '99999', ?, 'Contour inventé', 'direction:dir-1', 'x')", [ring]);
  await db.run("INSERT INTO price_zones (id, network_id, level, parent_id, slug, label, insee_code, ring_json, ring_source, recorded_by, recorded_at) VALUES ('z-q', 'net-1', 'quartier', 'z-c', 'les-tilleuls', 'Les Tilleuls', NULL, ?, 'Contour inventé', 'direction:dir-1', 'x')", [ring]);
  const state = { cells: [cell(commune, 'apartment', 40, 2600, 2250, 3250), cell(quartier, 'apartment', 9, 2450, 2200, 2700)], listings: [{ city: 'Villetest' }, { city: 'VILLETEST' }, { city: 'Autreville' }] };
  const pages = new PagesQuartier(db, journal, {
    now,
    writer: options.writer,
    timeoutMs: 50,
    prices: { communePrices: async (n, slug) => (n === 'net-1' && slug === 'villetest' ? prices(state.cells) : null) },
    listings: { published: async () => state.listings },
  });
  return { db, journal, pages, state };
}

const TRAM = { key: 'tram', kind: 'transport', label: 'Ligne T9 du tramway inventé', source: 'Réseau de transport inventé', sourceDate: '2026-09-01' };

describeWithSqlite('les pages de quartier, rédigées, validées, servies [R155]', () => {
  it('[R16] seule la direction range une donnée, propose, écrit et valide un texte', async () => {
    const s = await setup();
    expect(await s.pages.recordFact(agent, 'z-q', TRAM)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await s.pages.draft(agent, 'z-q', 'page')).toMatchObject({ ok: false, rule: 'R16' });
    expect(await s.pages.write(agent, 'z-q', 'page', 'quartier', 'Les Tilleuls', 'Texte.')).toMatchObject({ ok: false, rule: 'R16' });
    const d = await s.pages.draft(direction, 'z-q', 'page');
    if (!d.ok) throw new Error(d.code);
    expect(await s.pages.validate(agent, d.value.draftId)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await s.pages.draft({ ...direction, networkId: 'net-2' }, 'z-q', 'page')).toMatchObject({ ok: false, code: 'zone_inconnue' });
  });

  it('une donnée publique porte sa source et sa date ; adresse, nom de client, date future refusés ; une donnée retirée sort des textes', async () => {
    const s = await setup();
    expect(await s.pages.recordFact(direction, 'z-q', TRAM)).toEqual({ ok: true });
    for (const bad of [
      { ...TRAM, source: '' },
      { ...TRAM, sourceDate: '2026-13-01' },
      { ...TRAM, sourceDate: '2027-01-01' },
      { ...TRAM, kind: 'inconnu' },
      { ...TRAM, label: 'Arrêt au 4 rue des Essais' },
      { ...TRAM, label: 'Chez Quenouillard' },
      { ...TRAM, value: 3 }, // une valeur sans unité
      { ...TRAM, value: 3, unit: 'litres' },
      { ...TRAM, key: 'Clé avec espaces' },
    ]) {
      expect(await s.pages.recordFact(direction, 'z-q', bad), JSON.stringify(bad)).toMatchObject({ ok: false, code: 'invalide' });
    }
    const zone = (await s.db.first<{ id: string; slug: string; name: string; commune_slug: string; commune_name: string }>(
      "SELECT z.id, z.slug, z.label AS name, c.slug AS commune_slug, c.label AS commune_name FROM price_zones z JOIN price_zones c ON c.id = z.parent_id WHERE z.id = 'z-q'",
    ))!;
    expect((await s.pages.data('net-1', zone)).facts.map((f) => f.key)).toEqual(['tram']);
    expect(await s.pages.recordFact(direction, 'z-q', { ...TRAM, retired: true })).toEqual({ ok: true });
    expect((await s.pages.data('net-1', zone)).facts).toEqual([]);
    // Rien ne s'efface : les deux lignes restent.
    expect((await s.db.first<{ n: number }>('SELECT count(*) AS n FROM neighbourhood_facts'))!.n).toBe(2);
    await expect(s.db.run('DELETE FROM neighbourhood_facts')).rejects.toThrow(/rien ne s'efface/);
  });

  it('les biens publiés sont comptés à la commune, sans regarder la casse', async () => {
    const s = await setup();
    // Aucune donnée pour ce sujet : aucun texte, plutôt qu'un texte vide de faits.
    expect(await s.pages.draft(direction, 'z-q', 'article', 'equipements')).toEqual({ ok: false, rule: 'R155', code: 'sans_donnees' });
    const d = await s.pages.draft(direction, 'z-q', 'article', 'prix');
    if (!d.ok) throw new Error(d.code);
    expect(d.value.body).toContain('2 biens sont en vente avec le réseau à Villetest');
  });

  it('[R155] le texte de l’IA, s’il passe le contrôle ; l’IA ne reçoit que les données, aucun nom de client', async () => {
    const seen: unknown[] = [];
    const writer: NeighbourhoodWriter = {
      async write(input) {
        seen.push(input);
        return { title: 'Le quartier Les Tilleuls', body: 'Aux Tilleuls, le prix médian des appartements est de 2 450 € le mètre carré, sur 9 ventes.' };
      },
    };
    const s = await setup({ writer });
    const d = await s.pages.draft(direction, 'z-q', 'page');
    if (!d.ok) throw new Error(d.code);
    expect(d.value.origin).toBe('ia');
    expect(d.aiRefused).toBe(false);
    expect(JSON.stringify(seen)).not.toMatch(/Hortense|Quenouillard|Camille|Exemple/);
  });

  it('[R155] un texte de l’IA qui invente est remplacé par le secours, jamais gardé ; panne et délai aussi', async () => {
    const liar: NeighbourhoodWriter = { write: async () => ({ title: 'Les Tilleuls', body: 'Un quartier calme, avec 4 écoles et un marché.' }) };
    const s = await setup({ writer: liar });
    const d = await s.pages.draft(direction, 'z-q', 'page');
    if (!d.ok) throw new Error(d.code);
    expect(d.value.origin).toBe('secours');
    expect(d.aiRefused).toBe(true);
    expect((await s.db.all<{ body: string }>('SELECT body FROM neighbourhood_drafts')).map((r) => r.body).join(' ')).not.toMatch(/calme|marché/);
    for (const writer of [{ write: async () => Promise.reject(new Error('panne inventée')) }, { write: () => new Promise<never>(() => {}) }] as NeighbourhoodWriter[]) {
      const t = await setup({ writer });
      const r = await t.pages.draft(direction, 'z-q', 'page');
      expect(r).toMatchObject({ ok: true, value: { origin: 'secours' } });
    }
  });

  it('[R155] un texte écrit par la direction qui invente est refusé, avec ses problèmes', async () => {
    const s = await setup();
    const r = await s.pages.write(direction, 'z-q', 'article', 'prix', 'Les prix aux Tilleuls', 'Le prix médian est de 2 900 € le mètre carré.');
    expect(r).toMatchObject({ ok: false, rule: 'R155', code: 'texte_refuse' });
    expect(await s.pages.write(direction, 'z-q', 'article', 'inconnu', 'Titre', 'Texte.')).toMatchObject({ ok: false, code: 'invalide' });
    expect(await s.pages.write(direction, 'z-q', 'article', 'prix', 'Les prix aux Tilleuls', 'Le prix médian des appartements aux Tilleuls est de 2 450 € le mètre carré.')).toMatchObject({ ok: true, value: { origin: 'redaction' } });
  });

  it('[R155] aucune publication sans validation nommée ; validée, la page est servie avec ses sources', async () => {
    const s = await setup();
    await s.pages.recordFact(direction, 'z-q', TRAM);
    const d = await s.pages.draft(direction, 'z-q', 'page');
    if (!d.ok) throw new Error(d.code);
    expect(await s.pages.published('net-1', 'villetest', 'les-tilleuls')).toBeNull();
    const v = await s.pages.validate(direction, d.value.draftId);
    expect(v).toMatchObject({ ok: true, value: { validatedBy: 'direction:dir-1' } });
    expect(await s.pages.validate(direction, d.value.draftId)).toMatchObject({ ok: false, code: 'deja_valide' });
    const p = await s.pages.published('net-1', 'villetest', 'les-tilleuls');
    expect(p).not.toBeNull();
    expect(p!.title).toBe(d.value.title);
    expect(p!.sources.map((x) => x.source)).toEqual(expect.arrayContaining(['DVF, jeu inventé', 'Réseau de transport inventé']));
    // Un autre réseau, un autre sujet : rien.
    expect(await s.pages.published('net-2', 'villetest', 'les-tilleuls')).toBeNull();
    expect(await s.pages.published('net-1', 'villetest', 'les-tilleuls', 'prix')).toBeNull();
    // [R13] Le journal dit ce qui s'est passé, jamais le texte ni les chiffres.
    const ev = await s.db.all<{ type: string; data: string }>("SELECT type, data FROM journal WHERE type LIKE 'attirer.quartier.%'");
    expect(ev.map((e) => e.type)).toEqual(['attirer.quartier.donnee', 'attirer.quartier.texte', 'attirer.quartier.valide']);
    for (const e of ev) expect(e.data).not.toMatch(/2\s?450|Tilleuls|tramway/);
  });

  it('[R155] une validation refusée si les données ont changé depuis le texte', async () => {
    const s = await setup();
    const d = await s.pages.draft(direction, 'z-q', 'page');
    if (!d.ok) throw new Error(d.code);
    s.state.cells = [cell(commune, 'apartment', 41, 2610, 2250, 3250), cell(quartier, 'apartment', 10, 2470, 2200, 2700)];
    expect(await s.pages.validate(direction, d.value.draftId)).toMatchObject({ ok: false, rule: 'R155', code: 'donnees_changees' });
  });

  it('[R155] la page n’est plus servie quand un de ses chiffres change, et revient avec un nouveau texte validé', async () => {
    const s = await setup();
    const d = await s.pages.draft(direction, 'z-q', 'page');
    if (!d.ok) throw new Error(d.code);
    await s.pages.validate(direction, d.value.draftId);
    expect(await s.pages.published('net-1', 'villetest', 'les-tilleuls')).not.toBeNull();
    // Nouvelle publication DVF : la médiane du quartier change.
    s.state.cells = [cell(commune, 'apartment', 40, 2600, 2250, 3250), cell(quartier, 'apartment', 9, 2480, 2200, 2700)];
    expect(await s.pages.published('net-1', 'villetest', 'les-tilleuls')).toBeNull();
    const d2 = await s.pages.draft(direction, 'z-q', 'page');
    if (!d2.ok) throw new Error(d2.code);
    await s.pages.validate(direction, d2.value.draftId);
    expect((await s.pages.published('net-1', 'villetest', 'les-tilleuls'))!.body.replace(/\s/g, ' ')).toContain('2 480');
  });

  it('[R155] un texte validé puis réécrit en base n’est jamais servi', async () => {
    const s = await setup();
    const d = await s.pages.draft(direction, 'z-q', 'page');
    if (!d.ok) throw new Error(d.code);
    await s.pages.validate(direction, d.value.draftId);
    await expect(s.db.run("UPDATE neighbourhood_drafts SET body = 'autre'")).rejects.toThrow(/rien ne se réécrit/);
    await expect(s.db.run('DELETE FROM neighbourhood_validations')).rejects.toThrow(/rien ne s'efface/);
  });
});

describe('la page publique du quartier [R201]', () => {
  const page: PublishedNeighbourhood = {
    draftId: 'd1',
    kind: 'page',
    topic: 'quartier',
    title: 'Le quartier Les Tilleuls, à Villetest',
    body: 'Pour les appartements de Les Tilleuls, le prix médian est de 2 450 € le mètre carré.\n\nLigne T9 du tramway inventé.',
    zone: DATA.zone,
    sources: [
      { ref: 'prix', source: 'DVF, jeu inventé', date: '2026-06-30' },
      { ref: 'fait:tram', source: 'Réseau de transport inventé', date: '2026-09-01' },
    ],
    validatedAt: '2026-10-30T08:00:00.000Z',
  };
  const opts = { siteUrl: 'https://reseau.exemple.test', estimateHref: '/estimer' };

  it('[R201] la page passe le contrôle du système de design et tient dans 14 Ko compressés', () => {
    for (const p of [page, { ...page, kind: 'article' as const, topic: 'prix' as const }]) {
      const r = renderNeighbourhoodPage(p, opts);
      if (!r.ok) throw new Error(r.code);
      expect(htmlProblems(r.html)).toEqual([]);
      expect(budgetProblems({ html: r.html }, BUDGETS.page)).toEqual([]);
      expect(/<style>([\s\S]*?)<\/style>/.exec(r.html)![1]!.startsWith(DESIGN_CSS)).toBe(true);
    }
  });

  it('[R155] chaque source est montrée avec sa date ; [R07] « agent immobilier », jamais « mandataire »', () => {
    const r = renderNeighbourhoodPage(page, opts);
    if (!r.ok) throw new Error(r.code);
    expect(r.html).toContain('DVF, jeu inventé, au 30 juin 2026');
    expect(r.html).toContain('Réseau de transport inventé, au 1er septembre 2026');
    expect(r.html).toContain('agent immobilier');
    expect(r.html).not.toMatch(/mandataire|gratuit/i);
    expect(r.html).toContain('"url":"https://reseau.exemple.test/quartiers/villetest/les-tilleuls"');
  });

  it('une adresse de site ou un lien douteux refuse la page', () => {
    expect(renderNeighbourhoodPage(page, { ...opts, siteUrl: 'http://x' })).toEqual({ ok: false, code: 'adresse_invalide' });
    expect(renderNeighbourhoodPage(page, { ...opts, estimateHref: 'javascript:alert(1)' })).toEqual({ ok: false, code: 'adresse_invalide' });
  });
});
