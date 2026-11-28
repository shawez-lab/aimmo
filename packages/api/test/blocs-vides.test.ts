import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { RESEAU_HTML } from '../app/fichiers.ts';
import { AGENT_APP_FILES } from '../src/agent-app.ts';

// Tout est inventé : alertes, demandes, dates, clé de test.
const KEY = 'k'.repeat(40);
const CSS = AGENT_APP_FILES['/app/app.css']!;
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });

const DIRECTION: Record<string, Answer> = {
  '/v1/moi': ok({ role: 'direction', firstName: null }),
  '/v1/pilotage/reseau': ok({}),
  '/v1/pilotage/alertes': ok([]),
  '/v1/alertes-agent/sans-agent': ok({ total: 0, more: false }),
  '/v1/pilotage/reversements': ok([]),
  '/v1/pilotage/factures/brouillons': ok([]),
};
const ALERTS = [
  { key: 'budget_ia:2027-06', kind: 'budget_ia', data: { month: '2027-06', thresholdBp: 7000 }, createdAt: '2027-06-20T04:00:00.000Z' },
  { key: 'document:a1:assurance_rcp:2027-07-01', kind: 'document_agent', data: { agentId: 'a1', document: 'assurance_rcp', validUntil: '2027-07-01' }, createdAt: '2027-06-22T04:00:00.000Z' },
];
const COMPLIANCE: Record<string, Answer> = {
  '/v1/moi': ok({ role: 'compliance', firstName: null }),
  '/v1/conformite/risque': ok([]),
  '/v1/conformite/vigilance': ok([]),
  '/v1/commerces/vigilance': ok([]),
  '/v1/conformite/signalements': ok([]),
  '/v1/conformite/demandes': ok([]),
  '/v1/conformite/demandes/alertes': ok([]),
  '/v1/conformite/prospects': ok([]),
  '/v1/conformite/fuites': ok([]),
  '/v1/conformite/fuites/alertes': ok([]),
  '/v1/conformite/registre': ok({ lastReviewOn: '2026-10-28', initial: true, dueOn: '2027-01-28', noticeOn: '2027-01-13', registryHash: 'r'.repeat(64), changedSinceReview: false }),
  '/v1/conformite/registre/alertes': ok([]),
};
const REQUEST = { id: 'd1', personId: 'personne-test-g7h8i9', kind: 'acces', channel: 'mail', receivedOn: '2026-10-20', dueOn: '2026-11-20', noticeOn: '2026-11-13', exclusionId: null, answeredOn: null, answerSha256: null, late: null };

describe('DS060 · un bloc vide se réduit à une ligne, chez la direction et le responsable de la conformité', () => {
  it('[R201] la règle de la journée sert aussi « Aujourd’hui » et « À décider » ; rien de la journée n’est caché', () => {
    const hosts = ':is(#accueil, #reseau-p-jour, #conformite-corps) > .bloc:has(> .liste:empty)';
    for (const rule of [' { display: flex;', ' > h3 { margin: 0;', ' > .etat { margin: 0; }', ' > .decision { flex: 1 0 100%; }', ' + .bloc { margin-top: 0; }']) expect(CSS, rule).toContain(hosts + rule);
    // La phrase qui explique une liste ne sert qu'avec la liste : elle se tait quand la liste est vide, sauf sur la journée, où rien ne se cache.
    expect(CSS).toContain(':is(#reseau-p-jour, #conformite-corps) > .bloc:has(> .liste:empty) > .doux { display: none; }');
    expect(CSS).not.toMatch(/#accueil[^{]*\{[^}]*display: none/);
    // Les trois listes d'« Aujourd'hui » sont écrites vides dans la page, sans blanc : la règle vaut dès l'ouverture.
    const jour = RESEAU_HTML.slice(RESEAU_HTML.indexOf('<div id="reseau-p-jour"'), RESEAU_HTML.indexOf('<div id="reseau-p-chiffres"'));
    expect(jour.match(/<ul id="reseau-[a-z]+" class="liste"><\/ul>/g)).toEqual(['<ul id="reseau-alertes" class="liste"></ul>', '<ul id="reseau-reversements" class="liste"></ul>', '<ul id="reseau-brouillons" class="liste"></ul>']);
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

/** Ouvre l'application sur un téléphone, avec des réponses inventées ; rend la page prête à mesurer. */
async function open(path: '/app/' | '/app/reseau', answers: Record<string, Answer>, ready: string) {
  const page = await navigateur!.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(5000);
  await page.addInitScript((k: string) => {
    (globalThis as any).localStorage.setItem('aimmo.cle', k);
    (globalThis as any).localStorage.setItem('aimmo.reseau', '1');
  }, KEY);
  await page.route('**/*', async (route: any) => {
    const at = new URL(route.request().url()).pathname;
    const file = AGENT_APP_FILES[at];
    if (file !== undefined) return route.fulfill({ status: 200, contentType: at.endsWith('.js') ? 'text/javascript' : at.endsWith('.css') ? 'text/css' : at === '/app/' || at === '/app/reseau' ? 'text/html' : 'application/octet-stream', body: file });
    const answer = answers[at];
    if (!answer) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false}' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: await (await answer()).text() });
  });
  await page.goto(`https://aimmo.example.test${path}`);
  await page.waitForSelector(ready);
  return page;
}
/** Chaque bloc visible d'un hôte : son titre, sa hauteur, et si son titre et son état sont sur la même ligne. */
const blocks = (page: any, host: string) =>
  page.evaluate((id: string) => {
    const d = (globalThis as any).document;
    return [...d.querySelectorAll(`#${id} > .bloc`)].map((b: any) => {
      const h = b.querySelector('h3').getBoundingClientRect();
      const state = [...b.querySelectorAll(':scope > .etat')].find((e: any) => e.textContent);
      const s = state ? (state as any).getBoundingClientRect() : null;
      return { title: b.querySelector('h3').textContent, height: Math.round(b.getBoundingClientRect().height), oneLine: s !== null && Math.abs(s.top - h.top) < 6 && s.left > h.right, intro: [...b.querySelectorAll(':scope > .doux')].some((e: any) => e.checkVisibility()) };
    });
  }, host);

describe('DS060 · dans Chromium', () => {
  it.skipIf(navigateur === null)('chez la direction, rien n’attend : trois blocs d’une ligne ; une alerte arrive : son bloc reprend sa place', async () => {
    const calm = await open('/app/reseau', DIRECTION, '#reseau-alertes-etat:not(:empty)');
    try {
      await calm.waitForFunction(() => (globalThis as any).document.getElementById('reseau-attend').textContent === 'Rien en attente.');
      const lines = (await blocks(calm, 'reseau-p-jour')).slice(0, 3);
      expect(lines.map((b: any) => b.title)).toEqual(['Alertes', 'Reversements à faire', 'Factures à valider']);
      for (const b of lines) {
        expect(b.oneLine, b.title).toBe(true);
        expect(b.height, b.title).toBeLessThanOrEqual(56);
        expect(b.intro, b.title).toBe(false);
      }
      // L'arrivée tient alors en un écran et demi au plus, au lieu de 1,7.
      expect(await calm.evaluate(() => (globalThis as any).document.documentElement.scrollHeight / (globalThis as any).innerHeight)).toBeLessThanOrEqual(1.5);
    } finally {
      await calm.close();
    }
    const busy = await open('/app/reseau', { ...DIRECTION, '/v1/pilotage/alertes': ok(ALERTS) }, '#reseau-alertes li');
    try {
      const [alerts, payouts] = await blocks(busy, 'reseau-p-jour');
      expect(alerts.oneLine).toBe(false);
      expect(alerts.height).toBeGreaterThan(120);
      expect(payouts.oneLine).toBe(true);
    } finally {
      await busy.close();
    }
  });

  it.skipIf(navigateur === null)('chez le responsable de la conformité, rien à décider : chaque bloc dit son état sur sa ligne, et garde son geste dessous ; une demande arrive : son bloc reprend sa place', async () => {
    const calm = await open('/app/', COMPLIANCE, '#conformite-rubriques:not([hidden])');
    try {
      const all = await blocks(calm, 'conformite-corps');
      expect(all.map((b: any) => b.title)).toEqual(['Alertes', 'Fiches de risque à valider', 'Vigilance renforcée', 'Vigilance des cessions de fonds', 'Signalements', 'Demandes des personnes', 'Prospects arrivés à 3 ans', 'Fuites et coupures']);
      for (const b of all) expect(b.intro, b.title).toBe(false);
      // Un bloc sans geste fait une ligne, ou deux quand son titre et son état ne tiennent pas côte à côte.
      for (const b of all.filter((x: any) => !['Demandes des personnes', 'Fuites et coupures'].includes(x.title))) expect(b.height, b.title).toBeLessThanOrEqual(80);
      // Enregistrer une demande et déclarer une fuite restent à portée, sous la ligne de leur bloc.
      expect(await calm.isVisible('#conformite-corps summary:has-text("Enregistrer une demande reçue")')).toBe(true);
      expect(await calm.isVisible('#conformite-corps button:has-text("Déclarer une fuite connue maintenant")')).toBe(true);
      expect(await calm.evaluate(() => (globalThis as any).document.documentElement.scrollHeight / (globalThis as any).innerHeight)).toBeLessThanOrEqual(2);
    } finally {
      await calm.close();
    }
    const asked = await open('/app/', { ...COMPLIANCE, '/v1/conformite/demandes': ok([REQUEST]) }, '#conformite-rubriques:not([hidden])');
    try {
      const requests = (await blocks(asked, 'conformite-corps')).find((b: any) => b.title === 'Demandes des personnes');
      expect(requests.intro).toBe(true);
      expect(requests.height).toBeGreaterThan(160);
    } finally {
      await asked.close();
    }
  });
});
