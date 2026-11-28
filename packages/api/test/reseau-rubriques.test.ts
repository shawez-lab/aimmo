import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { afterAll, describe, expect, it } from 'vitest';
import { RESEAU_HTML, RESEAU_RUBRIQUES } from '../app/fichiers.ts';
import { FINANCES_SCRIPT } from '../app/finances.ts';
import { AGENT_APP_FILES } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : identifiants, chiffres, clé de test.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};

const ALERTS = [
  { key: 'budget_ia:2027-06', kind: 'budget_ia', data: { month: '2027-06', thresholdBp: 7000 }, createdAt: '2027-06-20T04:00:00.000Z' },
  { key: 'document:a1:assurance_rcp:2027-07-01', kind: 'document_agent', data: { agentId: 'a1', document: 'assurance_rcp', validUntil: '2027-07-01' }, createdAt: '2027-06-22T04:00:00.000Z' },
];
const PAYOUTS = [{ fileId: 'f1', receivedAt: '2027-06-18T09:00:00.000Z', payoutDueAt: '2027-06-21T09:00:00.000Z', alerts: [] }];
const DRAFTS = [
  { id: 'd1', fileId: 'f1', kind: 'honoraires', issuer: 'reseau', amountCents: 1200000, vatBp: 2000, createdAt: '2027-06-17T09:00:00.000Z' },
  { id: 'd2', fileId: 'f1', kind: 'reversement', issuer: 'agent:a2', amountCents: 600000, vatBp: 0, createdAt: '2027-06-17T09:00:00.000Z' },
];
const COUNTER = {
  startMonth: '2027-01',
  target: 10,
  requiredMonths: 6,
  currentMonth: '2027-01',
  months: [],
  currentRun: { length: 0, from: null, to: null },
  bestRun: { length: 0, from: null, to: null },
  condition: { met: false, metOn: null },
  registerSound: true,
};
const QUIET: Record<string, Answer> = {
  'GET /v1/moi': ok({ role: 'direction', firstName: null }),
  'GET /v1/pilotage/reseau': ok({}),
  'GET /v1/pilotage/alertes': ok([]),
  'GET /v1/alertes-agent/sans-agent': ok({ total: 0, more: false }),
  'GET /v1/pilotage/reversements': ok([]),
  'GET /v1/pilotage/factures/brouillons': ok([]),
};
const BUSY: Record<string, Answer> = {
  ...QUIET,
  'GET /v1/pilotage/alertes': ok(ALERTS),
  'GET /v1/alertes-agent/sans-agent': ok({ total: 3, more: false }),
  'GET /v1/pilotage/reversements': ok(PAYOUTS),
  'GET /v1/pilotage/factures/brouillons': ok(DRAFTS),
};
const REPORT: Record<string, Answer> = {
  'GET /v1/pilotage/rapport-matin': ok(null),
  'GET /v1/pilotage/preuve': ok(COUNTER),
  'GET /v1/pilotage/preuve/sceaux': ok({ months: [], seals: [], chainSound: true }),
  'GET /v1/pilotage/disponibilite': ok({ targetPercent: 99.9, connected: false, services: [] }),
};
const IDS = RESEAU_RUBRIQUES.map(([id]) => id);

/** L'écran de la direction, dans sa page, avec le script des finances servi comme par le réseau. */
async function run(answers: Record<string, Answer> = QUIET) {
  FakeElement.served = { ...FakeElement.served, '/app/finances.js': FINANCES_SCRIPT };
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const page = document as typeof document & { body: FakeElement };
  page.body = new FakeElement('body');
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: string[] = [];
  const table: Record<string, Answer> = { ...answers };
  runInNewContext(AGENT_APP_FILES['/app/app.js']!, {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string } = {}) => {
      const method = init.method ?? 'GET';
      calls.push(`${method} ${url.split('?')[0]}`);
      const a = table[`${method} ${url}`] ?? table[`${method} ${url.split('?')[0]}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    Intl,
    Date,
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  });
  listeners.DOMContentLoaded!();
  await settle();
  const open = async (id: string) => {
    els[`reseau-r-${id}`]!.listeners.click!({});
    await settle();
  };
  const shown = () => IDS.filter((id) => !els[`reseau-p-${id}`]!.hidden);
  const pressed = () => IDS.filter((id) => els[`reseau-r-${id}`]!.attributes['aria-pressed'] === 'true');
  const said = () => els['reseau-attend']!.textContent;
  const reads = (path: string) => calls.filter((c) => c === `GET ${path}`).length;
  return { els, calls, table, open, shown, pressed, said, reads };
}

/** Les blocs d'une rubrique, lus dans la page servie. */
function blocks(id: string): string[] {
  const from = RESEAU_HTML.indexOf(`<div id="reseau-p-${id}"`);
  const next = IDS[IDS.indexOf(id) + 1];
  const to = next ? RESEAU_HTML.indexOf(`<div id="reseau-p-${next}"`) : RESEAU_HTML.length;
  return [...RESEAU_HTML.slice(from, to).matchAll(/<section class="bloc"[^>]*>\s*<h3[^>]*>([^<]*)<\/h3>/g)].map((m) => m[1]!);
}

describe('DS008 · « Le réseau » en cinq rubriques', () => {
  it('cinq rubriques, une seule ouverte à l’arrivée ; chaque bloc vit dans une rubrique et une seule, huit au plus', () => {
    expect(RESEAU_RUBRIQUES.map(([, name]) => name)).toEqual(['Aujourd’hui', 'Chiffres', 'Agents', 'Réglages', 'Technique']);
    expect([...RESEAU_HTML.matchAll(/<button id="reseau-r-([a-z]+)" type="button" class="secondaire" aria-pressed="(true|false)">([^<]+)<\/button>/g)].map((m) => [m[1], m[2], m[3]])).toEqual(
      RESEAU_RUBRIQUES.map(([id, name], i) => [id, String(i === 0), name]),
    );
    expect([...RESEAU_HTML.matchAll(/<div id="reseau-p-([a-z]+)"( hidden)?>/g)].map((m) => [m[1], m[2] === undefined])).toEqual(IDS.map((id, i) => [id, i === 0]));
    // L'audit comptait 35 blocs empilés. Ils sont tous là, chacun une fois, huit au plus par rubrique.
    const all = IDS.flatMap(blocks);
    expect(all).toHaveLength(35);
    expect(new Set(all).size).toBe(35);
    expect((RESEAU_HTML.match(/<section class="bloc"/g) ?? []).length).toBe(35);
    for (const id of IDS) expect(blocks(id).length, id).toBeLessThanOrEqual(8);
    // Ce qui attend un geste aujourd'hui ouvre l'écran ; les sauvegardes et les preuves techniques sont ensemble.
    expect(blocks('jour')).toEqual(['Alertes', 'Reversements à faire', 'Factures à valider', 'Guides photo à valider', 'Rapport du matin', 'Les engagements manqués, à rappeler']);
    expect(blocks('chiffres')).toEqual(['Commissions', 'Factures émises', 'Export du jour', 'Mesure des sources', 'La preuve à Dijon', 'Le parcours, le mois passé', 'Nos engagements, le mois passé', 'Le temps gagné, la semaine passée']);
    expect(blocks('agents')).toEqual(['Candidatures', 'Engagements de service', 'Phases et régions', 'Licences du logiciel', 'Annuaire des partenaires', 'Prospection des partenaires']);
    expect(blocks('reglages')).toEqual(['Réglages du mandat', 'Modèles et clauses du mandat', 'Modèles de bail', 'Grille des commissions et alertes', 'Loyers de marché', 'Attirer', 'Bibliothèque sous licence']);
    expect(blocks('technique')).toEqual(['Bascule des automatisations du site', 'Reprise des contacts existants', 'La disponibilité, le mois passé', 'La copie de la base', 'La preuve de restauration, ce mois-ci', 'Le parcours complet, ce mois-ci', 'Mesure du classement', 'Clés de mes appareils']);
    // Le choix de la période ne règle que les chiffres : il vit avec eux.
    const chiffres = RESEAU_HTML.slice(RESEAU_HTML.indexOf('<div id="reseau-p-chiffres"'), RESEAU_HTML.indexOf('<div id="reseau-p-agents"'));
    for (const id of ['reseau-mois', 'reseau-precedent', 'reseau-annee', 'reseau-etat', 'reseau-corps']) expect(chiffres, id).toContain(`id="${id}"`);
  });

  it('la direction arrive sur « Aujourd’hui » ; un geste change de rubrique, sans rien demander de plus au socle', async () => {
    const t = await run();
    expect(t.shown()).toEqual(['jour']);
    expect(t.pressed()).toEqual(['jour']);
    const before = t.calls.length;
    for (const id of ['agents', 'reglages', 'jour']) {
      await t.open(id);
      expect(t.shown()).toEqual([id]);
      expect(t.pressed()).toEqual([id]);
    }
    expect(t.calls.length).toBe(before);
  });

  it('changer de période garde la rubrique ouverte ; une nouvelle entrée rouvre « Aujourd’hui »', async () => {
    const t = await run();
    await t.open('chiffres');
    t.els['reseau-annee']!.listeners.click!({});
    await settle();
    expect(t.shown()).toEqual(['chiffres']);
    expect(t.els['reseau-annee']!.attributes['aria-pressed']).toBe('true');
    // Se déconnecter puis rentrer : l'écran rouvre sur ce qui attend.
    t.els.sortir!.listeners.click!({});
    await settle();
    t.els.cle!.value = KEY;
    t.els['form-connexion']!.listeners.submit!({ preventDefault: () => undefined });
    await settle();
    expect(t.els.reseau!.hidden).toBe(false);
    expect(t.shown()).toEqual(['jour']);
  });

  it('Jamais vu · une phrase dit ce qui attend, dans un ordre fixe, au singulier comme au pluriel', async () => {
    const busy = await run(BUSY);
    expect(busy.said()).toBe('En attente : 2 alertes, 3 conversations sans agent, 1 reversement à faire, 2 factures à valider.');
    // Elle reste sous le titre, quelle que soit la rubrique ouverte.
    await busy.open('technique');
    expect(busy.said()).toBe('En attente : 2 alertes, 3 conversations sans agent, 1 reversement à faire, 2 factures à valider.');
    const one = await run({ ...QUIET, 'GET /v1/pilotage/alertes': ok(ALERTS.slice(0, 1)), 'GET /v1/alertes-agent/sans-agent': ok({ total: 50, more: true }) });
    expect(one.said()).toBe('En attente : 1 alerte, au moins 50 conversations sans agent.');
    expect((await run()).said()).toBe('Rien en attente.');
  });

  it('Jamais vu · la phrase ne dit jamais « rien » quand une lecture a manqué', async () => {
    for (const route of ['GET /v1/pilotage/alertes', 'GET /v1/alertes-agent/sans-agent', 'GET /v1/pilotage/reversements', 'GET /v1/pilotage/factures/brouillons']) {
      const quiet = { ...QUIET };
      delete quiet[route];
      expect((await run(quiet)).said(), route).toBe('Une partie n’a pas pu être relue.');
    }
    const busy = { ...BUSY };
    delete busy['GET /v1/pilotage/reversements'];
    expect((await run(busy)).said()).toBe('En attente : 2 alertes, 3 conversations sans agent, 2 factures à valider. Une partie n’a pas pu être relue.');
    // Les chiffres de la période ne comptent pas dans ce qui attend : leur panne se dit à sa place, pas ici.
    const figures = { ...QUIET };
    delete figures['GET /v1/pilotage/reseau'];
    const t = await run(figures);
    expect(t.said()).toBe('Rien en attente.');
    expect(t.els['reseau-etat']!.textContent).toBe('Pas de réseau. Réessayez dans un moment.');
  });

  it('une facture validée fait baisser la phrase ; se déconnecter l’efface', async () => {
    const t = await run({ ...QUIET, 'GET /v1/pilotage/factures/brouillons': ok(DRAFTS), 'POST /v1/pilotage/factures/brouillons/d1/valider': ok({ content: { label: 'F-2027-0001' } }), 'POST /v1/pilotage/factures/brouillons/d2/valider': ok({}) });
    expect(t.said()).toBe('En attente : 2 factures à valider.');
    const validate = async (at: number) => {
      const b = t.els['reseau-brouillons']!.children[at]!.all().find((e) => e.tagName === 'button')!;
      b.listeners.click!({});
      b.listeners.click!({});
      await settle();
    };
    await validate(0);
    expect(t.said()).toBe('En attente : 1 facture à valider.');
    await validate(1);
    expect(t.said()).toBe('Rien en attente.');
    t.els.sortir!.listeners.click!({});
    await settle();
    expect(t.said()).toBe('');
  });

  it('« Chiffres » et « Technique » relisent à leur ouverture ce qui se relit avec le rapport du matin, une seule fois ; « Aujourd’hui » attend le geste', async () => {
    const t = await run({ ...QUIET, ...REPORT });
    expect(t.reads('/v1/pilotage/rapport-matin')).toBe(0);
    expect(t.reads('/v1/pilotage/preuve')).toBe(0);
    await t.open('agents');
    await t.open('reglages');
    expect(t.reads('/v1/pilotage/rapport-matin')).toBe(0);
    await t.open('chiffres');
    expect(t.reads('/v1/pilotage/rapport-matin')).toBe(1);
    expect(t.reads('/v1/pilotage/preuve')).toBe(1);
    expect(t.els['preuve-corps']!.firstChild).not.toBeNull();
    // Déjà lus : ni « Technique » ni un retour sur « Chiffres » ne redemandent rien.
    await t.open('technique');
    await t.open('chiffres');
    await t.open('jour');
    expect(t.reads('/v1/pilotage/rapport-matin')).toBe(1);
    expect(t.reads('/v1/pilotage/disponibilite')).toBe(1);
  });

  it('une lecture manquée se dit dans la rubrique ouverte, et se refait en y revenant ; deux appuis ne font pas deux lectures', async () => {
    const t = await run({ ...QUIET, 'GET /v1/pilotage/rapport-matin': ok(null) });
    await t.open('technique');
    expect(t.els['disponibilite-etat']!.textContent).toBe('Pas de réseau. Réessayez dans un moment.');
    expect(t.reads('/v1/pilotage/disponibilite')).toBe(1);
    Object.assign(t.table, REPORT);
    await t.open('agents');
    await t.open('technique');
    expect(t.reads('/v1/pilotage/disponibilite')).toBe(2);
    expect(t.els['disponibilite-corps']!.firstChild).not.toBeNull();
    // Pendant qu'une lecture est en route, rouvrir la rubrique n'en lance pas une seconde.
    const slow = await run({ ...QUIET, ...REPORT, 'GET /v1/pilotage/preuve': () => new Promise<Response>(() => undefined) });
    slow.els['reseau-r-chiffres']!.listeners.click!({});
    slow.els['reseau-r-agents']!.listeners.click!({});
    slow.els['reseau-r-chiffres']!.listeners.click!({});
    await settle();
    expect(slow.reads('/v1/pilotage/preuve')).toBe(1);
    expect(slow.els['preuve-etat']!.textContent).toBe('Chargement…');
  });

  it('sans le script des finances, la panne se dit dans la rubrique ouverte, pas dans une autre', async () => {
    const t = await run({ ...QUIET, ...REPORT });
    FakeElement.served = Object.fromEntries(Object.entries(FakeElement.served).filter(([path]) => path !== '/app/finances.js'));
    await t.open('chiffres');
    const script = t.els.reseau!.children.find((e) => e.tagName === 'script' && e.attributes.src === '/app/finances.js')!;
    expect(t.els['preuve-etat']!.textContent).toBe('Chargement…');
    script.listeners.error!({});
    await settle();
    expect(t.els['preuve-etat']!.textContent).not.toBe('');
    expect(t.els['preuve-etat']!.textContent).not.toBe('Chargement…');
    expect(t.els['rapport-direction-etat']!.textContent).toBe('');
  });
});

/** Dans Chromium, là où Playwright et son navigateur sont installés : sinon l'essai se signale sauté. */
type Navigateur = { newPage(o?: object): Promise<any>; close(): Promise<void> };
async function lancer(): Promise<Navigateur | null> {
  try {
    const { chromium } = createRequire(import.meta.url)('playwright') as { chromium: { launch(): Promise<Navigateur> } };
    return await chromium.launch();
  } catch {
    return null;
  }
}
const navigateur = await lancer();
afterAll(async () => {
  await navigateur?.close();
});

describe('DS008 · dans Chromium', () => {
  it.skipIf(navigateur === null)('sur un téléphone, les cinq rubriques tiennent sur une ligne, à la taille du doigt ; une seule se voit, sans déborder', async () => {
    const answers: Record<string, Answer> = Object.fromEntries(Object.entries({ ...BUSY, ...REPORT }).map(([route, a]) => [route.replace(/^GET /, ''), a]));
    for (const width of [360, 390]) {
      const page = await navigateur!.newPage({ viewport: { width, height: 844 } });
      try {
        page.setDefaultTimeout(5000);
        await page.addInitScript((k: string) => {
          (globalThis as any).localStorage.setItem('aimmo.cle', k);
          (globalThis as any).localStorage.setItem('aimmo.reseau', '1');
        }, KEY);
        await page.route('**/*', async (route: any) => {
          const path = new URL(route.request().url()).pathname;
          const file = AGENT_APP_FILES[path];
          if (file !== undefined) return route.fulfill({ status: 200, contentType: path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path === '/app/' || path === '/app/reseau' ? 'text/html' : 'application/octet-stream', body: file });
          const answer = answers[path];
          if (!answer) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false}' });
          return route.fulfill({ status: 200, contentType: 'application/json', body: await (await answer()).text() });
        });
        await page.goto('https://aimmo.example.test/app/reseau');
        await page.waitForSelector('#reseau-alertes li');
        const measure = () =>
          page.evaluate(() => {
            const d = (globalThis as any).document;
            const seen = (e: any) => e.offsetParent !== null;
            const tabs = [...d.querySelectorAll('.rubriques button')].map((b: any) => b.getBoundingClientRect());
            return {
              screens: d.documentElement.scrollHeight / (globalThis as any).innerHeight,
              overflow: d.documentElement.scrollWidth > (globalThis as any).innerWidth,
              rows: new Set(tabs.map((r: any) => Math.round(r.top))).size,
              heights: tabs.map((r: any) => Math.round(r.height)),
              panels: [...d.querySelectorAll('[id^="reseau-p-"]')].filter(seen).map((p: any) => p.id),
              headings: [...d.querySelectorAll('#reseau h3')].filter(seen).map((h: any) => h.textContent),
              said: d.getElementById('reseau-attend').textContent,
            };
          });
        // L'audit comptait douze écrans d'un seul tenant. Avec huit choses en attente, l'arrivée en fait trois au plus, et les dit d'abord.
        const jour = await measure();
        expect(jour.rows, String(width)).toBe(1);
        for (const h of jour.heights) expect(h).toBeGreaterThanOrEqual(44);
        expect(jour.overflow).toBe(false);
        expect(jour.panels).toEqual(['reseau-p-jour']);
        expect(jour.screens).toBeLessThanOrEqual(3);
        expect(jour.said).toBe('En attente : 2 alertes, 3 conversations sans agent, 1 reversement à faire, 2 factures à valider.');
        expect(jour.headings.slice(0, 3)).toEqual(['Alertes', 'Reversements à faire', 'Factures à valider']);
        for (const id of ['chiffres', 'agents', 'reglages', 'technique']) {
          await page.click(`#reseau-r-${id}`);
          const part = await measure();
          expect(part.panels, id).toEqual([`reseau-p-${id}`]);
          expect(part.overflow, id).toBe(false);
          expect(part.headings, id).not.toContain('Alertes');
          expect(await page.getAttribute(`#reseau-r-${id}`, 'aria-pressed')).toBe('true');
          expect(await page.getAttribute('#reseau-r-jour', 'aria-pressed')).toBe('false');
          // Hors des chiffres, qui portent les comptes du mois, aucune rubrique ne dépasse quatre écrans.
          if (id !== 'chiffres') expect(part.screens, id).toBeLessThanOrEqual(4);
        }
        // Les rubriques se parcourent au clavier : ce sont des boutons, dans l'ordre de lecture.
        await page.focus('#reseau-r-jour');
        await page.keyboard.press('Enter');
        expect((await measure()).panels).toEqual(['reseau-p-jour']);
      } finally {
        await page.close();
      }
    }
  });
});
