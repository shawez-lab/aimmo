import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { ENGAGEMENTS_SCRIPT } from '../app/engagements.ts';
import {
  NEUF_DIRECTION_LOST,
  NEUF_DIRECTION_NO_TABLE,
  NEUF_DIRECTION_TABLE_MISSING,
  NEUF_DIRECTION_TABLE_NOTE,
  NEUF_DIRECTION_TABLE_REFUSALS,
  NEUF_DIRECTION_SCRIPT,
} from '../app/neuf-direction.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : clé, barèmes, promoteurs, agents, programmes, tables d'espérance.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const INJECTED = '<img src=x onerror="alert(1)">';
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const cut: Answer = () => Promise.reject(new TypeError('coupé'));

const S = (id: string, rateBp: number, source: string, validFrom: string) => ({ scaleId: id, rateBp, source, validFrom, setAt: '2027-02-01T10:00:00.000Z' });
const BOARD = {
  day: '2027-03-01',
  neuf: { current: S('s2', 260, 'Barème du neuf inventé', '2027-01-01'), upcoming: [S('s3', 280, 'Barème d’avril inventé', '2027-04-01')], replaced: [S('s1', 200, 'Barème de 2026 inventé', '2026-01-01')] },
  ancien: { current: null, upcoming: [], replaced: [] },
};
const AGENTS = [
  { agentId: 'ag1', firstName: 'Alex', lastName: 'Agent' },
  { agentId: 'ag2', firstName: 'Sam', lastName: 'Exemple' },
];
const PROGRAMS = [
  { programId: 'pg1', name: 'Les Jardins inventés', city: 'Dijon', postalCode: '21000', promoter: 'Promoteur Exemple', agentId: 'ag1', createdAt: '2027-02-01T10:00:00.000Z' },
  { programId: 'pg2', name: 'Le Clos inventé', city: 'Chenôve', postalCode: '21300', promoter: 'Autre Promoteur', agentId: 'ag9', createdAt: '2027-01-01T10:00:00.000Z' },
];
const ANNUAIRE = { proposable: [{ partnerId: 'pa1', businessName: 'Promoteur Exemple', trade: 'promoteur' }], unavailable: [{ partnerId: 'pa2', businessName: 'Promoteur en attente', trade: 'promoteur' }, { partnerId: 'pa3', businessName: 'Notaire glissé', trade: 'notaire' }] };

const T = (id: string, vintage: string, source: string, rowCount: number, inUse: boolean) => ({ tableId: id, vintage, source, rowCount, importedAt: '2027-02-01T10:00:00.000Z', inUse });
const TABLES = [T('t2', '2020-2022', 'Table inventée de 2020-2022, ensemble des deux sexes', 101, true), T('t1', '2019', 'Table inventée de 2019', 100, false)];

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};
const scriptsOf = (root: FakeElement, src: string) => [root, ...root.all()].filter((e) => e.tagName === 'script' && e.attributes.src === src);
const btn = (root: FakeElement, text: string) => root.all().find((e) => e.tagName === 'button' && e.textContent === text);

async function desk(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  (document as { body?: FakeElement }).body = new FakeElement('body');
  const calls: { method: string; url: string; body: Record<string, unknown> | null }[] = [];
  const table: Record<string, Answer> = {
    'GET /v1/gagner/engagements': ok([]),
    'GET /v1/neuf/baremes': ok(BOARD),
    'GET /v1/neuf/programmes': ok(PROGRAMS),
    'GET /v1/gagner/recommandations/agents': ok(AGENTS),
    'GET /v1/partenaires/annuaire?metier=promoteur&cp=21000': ok(ANNUAIRE),
    'POST /v1/neuf/baremes': ok({ id: 's9' }),
    'POST /v1/neuf/programmes': ok({ programId: 'pg9' }),
    'GET /v1/viager/tables': ok({ tables: TABLES }),
    'POST /v1/viager/tables': ok({ tableId: 't9' }),
    ...answers,
  };
  const ctx: Record<string, unknown> = {
    document,
    localStorage: { getItem: () => KEY, setItem: () => undefined, removeItem: () => undefined },
    fetch: (url: string, init: { method?: string; body?: string } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, body: typeof init.body === 'string' ? JSON.parse(init.body) : null });
      const a = table[`${method} ${url}`] ?? (method === 'GET' && url === '/v1/moi' ? ok({ role: 'direction', firstName: null }) : undefined);
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    Intl,
    Date,
    crypto: globalThis.crypto,
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(JS, ctx);
  listeners.DOMContentLoaded!();
  await settle();
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  await click(els['engagements-voir']);
  runInNewContext(ENGAGEMENTS_SCRIPT, ctx);
  scriptsOf(els.reseau!, '/app/engagements.js')[0]!.listeners.load!({});
  await settle();
  const part = () => els['engagements-corps']!.children.find((e) => e.tagName === 'section' && e.children[0]!.textContent === 'Programmes neufs')!;
  const input = (id: string) => part().all().find((e) => e.attributes.id === id)!;
  const set = (id: string, value: string) => {
    input(id).value = value;
  };
  const open = async () => {
    await click(btn(part(), 'Ouvrir les programmes neufs'));
    const s = scriptsOf(part(), '/app/neuf-direction.js');
    if (s.length === 1 && !ctx.loaded) {
      runInNewContext(NEUF_DIRECTION_SCRIPT, ctx);
      ctx.loaded = true;
      s[0]!.listeners.load!({});
      await settle();
    }
  };
  const posts = () => calls.filter((c) => c.method === 'POST');
  const statuses = () => part().all().filter((e) => e.attributes.role === 'status').map((e) => e.textContent);
  const choose = (csv: string, size = csv.length) => {
    (input('viager-table-fichier') as unknown as { files: unknown }).files = [{ size, text: () => Promise.resolve(csv) }];
  };
  const fill = (csv: string, vintage = '2024', source = 'Table inventée pour les tests, ensemble des deux sexes') => {
    choose(csv);
    set('viager-table-millesime', vintage);
    set('viager-table-source', source);
  };
  const block = () => part().all().find((e) => e.tagName === 'section' && e.children[0]?.textContent === 'Table d’espérance de vie du viager')!;
  return { block, choose, fill, calls, table, part, input, set, open, click, posts, statuses, button: (t: string) => btn(part(), t), text: () => part().textContent };
}

const CSV = 'Âge;Espérance de vie\n68;17,5\n75;12,8\n';

describe('BR80 · la table d’espérance de vie du viager, importée à l’écran de la direction (Jamais vu)', () => {
  it('[R201] dans le même script servi à part : budgets tenus, sans innerHTML, rien de l’application ne lit le viager', async () => {
    expect(budgetProblems({ html: '', js: NEUF_DIRECTION_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    expect(JS).not.toContain('/v1/viager');
    expect(AGENT_APP_SHELL).not.toContain('/v1/viager');
    expect(NEUF_DIRECTION_SCRIPT).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write|localStorage|eval\(/);
    const d = await desk();
    expect(d.calls.some((c) => c.url.startsWith('/v1/viager'))).toBe(false);
    await d.open();
    expect(d.calls.filter((c) => c.url === '/v1/viager/tables').map((c) => c.method)).toEqual(['GET']);
  });

  it('[R541] dit la table qui sert à chaque calcul ce jour, avec sa source et son millésime, les autres plus en service, et qu’une table ne change jamais', async () => {
    const d = await desk();
    await d.open();
    const text = d.block().textContent;
    expect(text).toContain('En service pour chaque calcul : millésime 2020-2022');
    expect(text).toContain('Source : Table inventée de 2020-2022, ensemble des deux sexes · importée le 01/02/2027 · 101 âges');
    expect(text).toContain('Plus en service : millésime 2019');
    expect(text).toContain(NEUF_DIRECTION_TABLE_NOTE);
    expect(text).not.toContain(NEUF_DIRECTION_NO_TABLE);
    // Aucune table : il est dit qu'aucun calcul n'a d'espérance.
    const e = await desk({ 'GET /v1/viager/tables': ok({ tables: [] }) });
    await e.open();
    expect(e.block().textContent).toContain(NEUF_DIRECTION_NO_TABLE);
    // Un texte reçu est posé en texte ; une table mal formée n'est pas dite.
    const f = await desk({ 'GET /v1/viager/tables': ok({ tables: [T('t3', '2024', INJECTED, 3, true), { ...T('t4', 'deux mille', 'Table au millésime faux', 3, false) }] }) });
    await f.open();
    expect(f.block().all().some((x) => x.tagName === 'img')).toBe(false);
    expect(f.block().textContent).toContain(INJECTED);
    expect(f.block().textContent).not.toContain('Table au millésime faux');
  });

  it('[R541] l’import part du seul fichier choisi, en lignes entières, millésime et source exigés avant l’appel', async () => {
    const d = await desk();
    await d.open();
    await d.click(d.button('Importer cette table'));
    expect(d.statuses()).toContain(NEUF_DIRECTION_TABLE_MISSING);
    d.fill(CSV, '24');
    await d.click(d.button('Importer cette table'));
    expect(d.statuses()).toContain(NEUF_DIRECTION_TABLE_MISSING);
    d.fill(CSV, '2024', 'abc');
    await d.click(d.button('Importer cette table'));
    expect(d.statuses()).toContain(NEUF_DIRECTION_TABLE_MISSING);
    expect(d.posts()).toEqual([]);

    d.fill('﻿age,esperance\r\n68,17.5\r\n\r\n75,12\r\n');
    await d.click(d.button('Importer cette table'));
    expect(d.posts()).toEqual([
      { method: 'POST', url: '/v1/viager/tables', body: { vintage: '2024', source: 'Table inventée pour les tests, ensemble des deux sexes', rows: [{ age: 68, expectancyTenths: 175 }, { age: 75, expectancyTenths: 120 }] } },
    ]);
    expect(d.statuses()).toContain('Table importée (2 âges) : elle sert désormais à chaque calcul.');
    // L'écran est relu après l'import.
    expect(d.calls.filter((c) => c.url === '/v1/viager/tables' && c.method === 'GET')).toHaveLength(2);
  });

  it('[R541] Jamais vu : une colonne de plus, un âge en double ou hors bornes, une espérance douteuse : rien ne part, la ligne fautive dite par son numéro', async () => {
    const cases: [string, string][] = [
      ['Âge;Sexe;Espérance\n68;F;17,5\n', 'Ligne 1 : une colonne de sexe.'],
      ['Âge;Hommes\n68;17,5\n', 'Ligne 1 : une colonne de sexe.'],
      ['68;17,5\n75;12,8;99\n', 'Ligne 2 : 3 colonnes.'],
      ['68;17,5\n68;17,4\n', 'Ligne 2 : l’âge 68 est déjà plus haut, à la ligne 1.'],
      ['age;esp\n68;17,5\n121;1\n', 'Ligne 3 : l’âge n’est pas lisible'],
      ['68;17,5\n-1;12\n', 'Ligne 2 : l’âge n’est pas lisible'],
      ['68;17,55\n', 'Ligne 1 : l’espérance de vie n’est pas lisible'],
      ['68;0\n', 'Ligne 1 : l’espérance de vie n’est pas lisible'],
      ['68;dix\n', 'Ligne 1 : l’espérance de vie n’est pas lisible'],
      // Séparées par des virgules, la décimale est un point : « 17,5 » fait trois colonnes.
      ['68,17,5\n', 'Ligne 1 : 3 colonnes.'],
      ['age;esp\n', 'Aucun âge lu dans ce fichier'],
      [Array.from({ length: 122 }, (_, i) => `${i % 121};10`).join('\n'), 'Ligne 122 : l’âge 0 est déjà plus haut'],
    ];
    for (const [csv, said] of cases) {
      const d = await desk();
      await d.open();
      d.fill(csv);
      await d.click(d.button('Importer cette table'));
      expect(d.posts(), csv).toEqual([]);
      const s = d.statuses().join(' | ');
      expect(s, csv).toContain(said);
      expect(s, csv).toContain('Rien n’est envoyé.');
    }
    // Un fichier trop lourd n'est pas même lu.
    const d = await desk();
    await d.open();
    d.fill(CSV);
    d.choose(CSV, 65 * 1024);
    await d.click(d.button('Importer cette table'));
    expect(d.posts()).toEqual([]);
    expect(d.statuses().join(' ')).toContain('dépasse 64 Ko');
  });

  it('[R16] un millésime déjà importé ou un refus du serveur dits en mots, jamais par leur code ; sans réponse, l’écran est relu', async () => {
    for (const code of Object.keys(NEUF_DIRECTION_TABLE_REFUSALS)) {
      const d = await desk({ 'POST /v1/viager/tables': no(code === 'role' ? 403 : 409, { ok: false, rule: 'R541', code }) });
      await d.open();
      d.fill(CSV);
      await d.click(d.button('Importer cette table'));
      expect(d.statuses(), code).toContain(NEUF_DIRECTION_TABLE_REFUSALS[code]);
      expect(d.text(), code).not.toMatch(/R541|R16|deja_importee|invalid_body|millesime/);
    }
    const d = await desk({ 'POST /v1/viager/tables': cut });
    await d.open();
    d.fill(CSV);
    await d.click(d.button('Importer cette table'));
    expect(d.statuses()).toContain(NEUF_DIRECTION_LOST);
    // Le refus de lire les tables dit en mots.
    const r = await desk({ 'GET /v1/viager/tables': no(403, { ok: false, rule: 'R16', code: 'role' }) });
    await r.open();
    expect(r.block().textContent).toContain(NEUF_DIRECTION_TABLE_REFUSALS.role);
  });
});
