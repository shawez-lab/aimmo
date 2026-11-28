import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { JOURNEY, journeyWorld, type JourneyWorld } from '../../core/test/parcours-complet.ts';
import { captureOutcome, compareCaptures, type Mesure } from '../../../scripts/captures.mjs';
import { AGENT_APP_FILES } from '../src/agent-app.ts';
import { handleRequest, sha256Hex, type ApiConfig } from '../src/index.ts';
import { PARTNER_SPACE_FILES } from '../src/partenaires.ts';
import { screens } from './ecrans.ts';

/**
 * DS086 · Les captures rejouables. Chaque écran d'AIMMO est photographié dans Chromium, sur un téléphone et sur un
 * ordinateur, avec ses mesures : sa hauteur en écrans, ses boutons pleins, et s'il déborde. De quoi comparer avant et
 * après à chaque proposition (`node scripts/captures.mjs <dossier>`, puis `--comparer <avant> <après>`).
 *
 * Deux sources, toutes deux inventées :
 * - les pages et documents rendus par le code (`ecrans.ts`, la liste des contrôles du système de design) ;
 * - l'application, servie par la vraie API sur le parcours complet (`parcours-complet.ts`) : une base en mémoire, des
 *   clés de capture qui n'existent qu'ici, aucune donnée réelle, aucun réseau.
 *
 * Chromium n'est pas une dépendance du dépôt : les captures tournent là où Playwright et son navigateur sont installés.
 * Sans dossier demandé (`AIMMO_CAPTURES`), seul le plan est vérifié, plus une capture d'essai là où Chromium est là.
 * Avec un dossier demandé, l'absence de Chromium est un échec, dit avec sa raison : jamais un succès sans images.
 */
const KEYS = { agent: `capture-cle-agent-${'a'.repeat(32)}`, direction: `capture-cle-direction-${'b'.repeat(28)}`, conformite: `capture-cle-conformite-${'c'.repeat(26)}` } as const;
type Role = keyof typeof KEYS | 'aucun';
const VIEWS = { tel: { width: 390, height: 844 }, ordi: { width: 1440, height: 900 } } as const;
type View = Mesure['vue'];

/**
 * Les deux moments du parcours où les captures se prennent : à la visite (un vendeur, son bien sous mandat, son annonce,
 * un acquéreur, une visite), et après le compromis (une offre acceptée, un dossier de vente).
 */
type Moment = 'visite' | 'compromis_acte';

/** Ce que le plan sait du monde du parcours, lu par l'API comme le ferait l'écran. */
interface Known {
  seller: string;
  property: { id: string; reference: string; name: string; state: string };
  visit: string | null;
  file: string | null;
}

/**
 * Un écran : qui l'ouvre, sur quelle page, à quel moment du parcours, et comment on y arrive. `state` est l'état
 * d'historique que l'application sait rouvrir (AU117) : le même chemin que le bouton Retour du navigateur, sans dépendre
 * d'un bouton. `clicks` suit des gestes, dans l'ordre.
 */
interface AppShot {
  name: string;
  role: Role;
  page: '/app/' | '/app/reseau' | '/partenaire/';
  /** L'écran attendu à l'arrivée : la `section` montrée. */
  screen: string;
  at?: Moment;
  clicks?: readonly string[];
  state?: (k: Known) => { s: string; a: unknown[] | null; t: string } | null;
}

const tool = (name: string, s: string): AppShot => ({ name, role: 'agent', page: '/app/', screen: s, state: (k) => ({ s, a: [k.property.id, k.property.reference], t: 'accueil' }) });
const fromTools = (name: string, s: string): AppShot => ({ name, role: 'agent', page: '/app/', screen: s, clicks: ['#outils-ouvrir', `#${s}-ouvrir`] });
export const APP_SHOTS: readonly AppShot[] = [
  { name: 'application · connexion', role: 'aucun', page: '/app/', screen: 'connexion' },
  { name: 'application · journée', role: 'agent', page: '/app/', screen: 'accueil' },
  { name: 'application · clients', role: 'agent', page: '/app/', screen: 'clients', clicks: ['#clients-ouvrir'] },
  { name: 'application · biens', role: 'agent', page: '/app/', screen: 'mes-biens', clicks: ['#mes-biens-ouvrir'] },
  { name: 'application · outils', role: 'agent', page: '/app/', screen: 'outils', clicks: ['#outils-ouvrir'] },
  { name: 'application · chiffres', role: 'agent', page: '/app/', screen: 'chiffres', clicks: ['#chiffres-ouvrir'] },
  { name: 'application · fiche du client', role: 'agent', page: '/app/', screen: 'fiche', state: (k) => ({ s: 'fiche', a: [k.seller], t: 'accueil' }) },
  { name: 'application · un bien', role: 'agent', page: '/app/', screen: 'un-bien', state: (k) => ({ s: 'un-bien', a: [k.property.id, k.property.reference, k.property.name, k.property.state], t: 'accueil' }) },
  tool('application · mettre en vente', 'vente'),
  tool('application · mandat', 'mandat'),
  tool('application · offres', 'offres'),
  tool('application · avis de valeur', 'avis'),
  tool('application · studio', 'studio'),
  tool('application · acquéreurs du bien', 'bien'),
  { name: 'application · visite', role: 'agent', page: '/app/', screen: 'visite', state: (k) => (k.visit ? { s: 'visite', a: [k.visit], t: 'accueil' } : null) },
  { name: 'application · dossier de vente', role: 'agent', page: '/app/', screen: 'dossier', at: 'compromis_acte', state: (k) => (k.file ? { s: 'dossier', a: [k.file, k.property.reference], t: 'accueil' } : null) },
  { ...fromTools('application · ventes conclues', 'apres'), at: 'compromis_acte' },
  fromTools('application · gagner des mandats', 'gagner'),
  fromTools('application · locations', 'louer'),
  fromTools('application · commerces', 'commerces'),
  fromTools('application · investisseurs', 'investir'),
  fromTools('application · partenaires', 'partenaires'),
  fromTools('application · fiche Google', 'fiche-google'),
  fromTools('application · mon dossier', 'integration'),
  { name: 'application · le réseau', role: 'direction', page: '/app/reseau', screen: 'reseau' },
  // DS008 · chaque rubrique de la direction a sa capture : aucune ne se cache derrière la première.
  ...['chiffres', 'agents', 'reglages', 'technique'].map((r): AppShot => ({ name: `application · le réseau · ${r}`, role: 'direction', page: '/app/reseau', screen: 'reseau', clicks: [`#reseau-r-${r}`] })),
  { name: 'application · attirer', role: 'direction', page: '/app/reseau', screen: 'attirer', clicks: ['#reseau-r-reglages', '#attirer-ouvrir'] },
  { name: 'application · conformité', role: 'conformite', page: '/app/', screen: 'conformite' },
  // DS009 · chaque rubrique du responsable a sa capture.
  ...['registres', 'modeles'].map((r): AppShot => ({ name: `application · conformité · ${r}`, role: 'conformite', page: '/app/', screen: 'conformite', clicks: [`#conformite-r-${r}`] })),
  { name: 'espace partenaire · entrée', role: 'aucun', page: '/partenaire/', screen: 'entree' },
];

/**
 * Les écrans que le plan ne capture pas, chacun avec sa raison. Tout écran d'une page servie est dans le plan ou ici :
 * un écran ajouté sans capture fait échouer le test, et une raison devenue fausse aussi.
 */
export const NOT_CAPTURED: Readonly<Record<string, string>> = {
  'app:invitation': 'un lien d’invitation ne sert qu’une fois, pour une personne : le parcours n’en émet pas',
  'app:hors-ligne': 'l’écran demande une coupure de réseau et des visites gardées sur l’appareil',
  'partenaire:liste': 'le parcours n’a pas de partenaire : l’espace n’a rien à lister',
  'partenaire:detail': 'le parcours n’a pas de partenaire : l’espace n’a aucune recommandation à détailler',
};

/** Le nom d'un fichier : des lettres, des chiffres et des tirets. */
export const slug = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Le monde du parcours, avancé jusqu'au moment voulu, et l'API qui le sert sous les clés de capture. */
async function world(until: Moment = 'visite') {
  const w: JourneyWorld = await journeyWorld();
  for (const step of JOURNEY) {
    await step.run(w);
    if (step.id === until) break;
  }
  const apiKeys = JSON.stringify([
    { sha256: await sha256Hex(KEYS.agent), role: 'agent', userId: w.alexId, networkId: w.network.id },
    { sha256: await sha256Hex(KEYS.direction), role: 'direction', userId: 'direction-capture', networkId: w.network.id },
    { sha256: await sha256Hex(KEYS.conformite), role: 'compliance', userId: 'conformite-capture', networkId: w.network.id },
  ]);
  const config = { db: w.db, apiKeys, mode: 'essai', now: w.now, pieces: w.pieces as never, candidatureNetworkId: w.network.id } as ApiConfig;
  const serve = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array | null } = {}) =>
    handleRequest(new Request(`https://aimmo.example.test${path}`, { method: init.method ?? 'GET', ...(init.headers ? { headers: init.headers } : {}), ...(init.body ? { body: init.body } : {}) }), config);
  const read = async (path: string): Promise<any> => (await (await serve(path, { headers: { authorization: `Bearer ${KEYS.agent}` } })).json()) as unknown;
  const places = ((await read('/v1/annonces')).data ?? []) as { id: string; reference: string; state: string | null }[];
  const day = ((await read('/v1/rendez-vous/jour')).data ?? {}) as { appointments?: { id: string; kind: string }[] };
  // Après la vente, le bien quitte la liste des biens à vendre : le parcours garde sa référence.
  const p = places.find((x) => x.id === w.propertyId) ?? { id: w.propertyId!, reference: w.reference!, state: null };
  const known: Known = {
    seller: w.seller!,
    property: { id: p.id, reference: p.reference, name: `Bien ${p.reference}`, state: p.state ?? '' },
    visit: day.appointments?.find((a) => a.kind === 'visite')?.id ?? w.appointmentId ?? null,
    file: w.fileId ?? null,
  };
  return { w, serve, known };
}
/** Un monde par moment, fait une fois. */
const worlds = new Map<Moment, ReturnType<typeof world>>();
const worldAt = (at: Moment = 'visite') => worlds.get(at) ?? worlds.set(at, world(at)).get(at)!;

type Navigateur = { newPage(o?: object): Promise<any>; close(): Promise<void> };
/** Pourquoi Chromium n'a pas démarré, s'il n'a pas démarré : dit quand des captures étaient demandées. */
let launchError: string | null = null;
async function lancer(): Promise<Navigateur | null> {
  try {
    const { chromium } = createRequire(import.meta.url)('playwright') as { chromium: { launch(): Promise<Navigateur> } };
    return await chromium.launch();
  } catch (e) {
    launchError = (e as Error).message.split('\n')[0] ?? 'raison inconnue';
    return null;
  }
}
const navigateur = await lancer();
afterAll(async () => {
  await navigateur?.close();
});

/** Les mesures d'une page ouverte, prises dans la page. */
const measure = (page: any): Promise<{ ecrans: number; boutonsPleins: number; deborde: boolean }> =>
  page.evaluate(() => {
    const w = globalThis as any;
    const seen = (e: any) => e.getClientRects().length > 0 && w.getComputedStyle(e).visibility !== 'hidden';
    // Dans le contenu seulement : ni le lien d'évitement, ni la barre d'onglets ne sont des gestes de l'écran.
    const filled = [...w.document.querySelectorAll('main button, main a.appel')].filter((b: any) => seen(b) && !/(^| )(secondaire|second|retour|discret)( |$)/.test(b.className));
    return { ecrans: Math.round((w.document.documentElement.scrollHeight / w.innerHeight) * 10) / 10, boutonsPleins: filled.length, deborde: w.document.documentElement.scrollWidth > w.innerWidth };
  });

async function shoot(page: any, dir: string, nom: string, vue: View): Promise<Mesure> {
  const fichier = `${slug(nom)}-${vue}.jpg`;
  const m = await measure(page);
  await page.screenshot({ path: join(dir, fichier), fullPage: true, type: 'jpeg', quality: 80 });
  return { nom, vue, fichier, ...m };
}

/** Une page de l'application, servie par l'API du parcours : chaque demande du navigateur passe par `handleRequest`. */
async function appPage(serve: Awaited<ReturnType<typeof world>>['serve'], role: Role, vue: View) {
  const page = await navigateur!.newPage({ viewport: VIEWS[vue], locale: 'fr-FR', timezoneId: 'Europe/Paris', serviceWorkers: 'block' });
  page.setDefaultTimeout(10000);
  // Une clé de capture dans la mémoire de l'appareil, comme après une connexion ; celle de la direction ouvre sa page.
  if (role !== 'aucun') await page.addInitScript((key: string) => (globalThis as any).localStorage.setItem('aimmo.cle', key), KEYS[role]);
  await page.route('**/*', async (route: any) => {
    const request = route.request();
    const url = new URL(request.url());
    const file = AGENT_APP_FILES[url.pathname] ?? PARTNER_SPACE_FILES[url.pathname];
    if (request.method() === 'GET' && file !== undefined) {
      const type = url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : url.pathname.endsWith('.svg') ? 'image/svg+xml' : url.pathname.endsWith('.webmanifest') ? 'application/manifest+json' : 'text/html';
      return route.fulfill({ status: 200, contentType: `${type}; charset=utf-8`, body: file });
    }
    const r = await serve(url.pathname + url.search, { method: request.method(), headers: request.headers(), body: request.postDataBuffer() });
    const headers: Record<string, string> = {};
    r.headers.forEach((v, k) => (headers[k] = v));
    return route.fulfill({ status: r.status, headers, body: Buffer.from(await r.arrayBuffer()) });
  });
  return page;
}

async function openShot(page: any, shot: AppShot, known: Known): Promise<boolean> {
  await page.goto(`https://aimmo.example.test${shot.page}`);
  const home = shot.page === '/app/reseau' ? '#reseau' : shot.role === 'conformite' ? '#conformite' : '#accueil';
  if (shot.state) {
    const state = shot.state(known);
    if (!state) return false;
    await page.waitForSelector(`${home}:not([hidden])`);
    // Le chemin du bouton Retour du navigateur : l'application rouvre l'écran dit par l'état d'historique (AU117).
    await page.evaluate((s: unknown) => (globalThis as any).dispatchEvent(new (globalThis as any).PopStateEvent('popstate', { state: s })), state);
  }
  for (const selector of shot.clicks ?? []) {
    if (selector === shot.clicks![0]) await page.waitForSelector(`${home}:not([hidden])`);
    await page.click(selector);
  }
  await page.waitForSelector(`#${shot.screen}:not([hidden])`);
  // Les lectures de l'écran, et les scripts servis à part, ont le temps d'arriver.
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(400);
  return true;
}

/** Les écrans d'une page servie : ses `section` qui portent un nom. */
const sectionsOf = (html: string): string[] => [...html.matchAll(/<section id="([a-z-]+)"/g)].map((m) => m[1]!);

describe('DS086 · le plan des captures', () => {
  const pageOf = (shot: { page: string }): string => (AGENT_APP_FILES[shot.page] ?? PARTNER_SPACE_FILES[shot.page])!;

  it('chaque écran a un nom et un fichier à lui ; ses gestes existent dans la page servie', async () => {
    const rendered = await screens();
    const names = [...rendered.map((s) => s.name), ...APP_SHOTS.map((s) => s.name)];
    expect(new Set(names.map(slug)).size).toBe(names.length);
    for (const n of names) expect(slug(n), n).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    for (const shot of APP_SHOTS) {
      const html = pageOf(shot);
      expect(sectionsOf(html), shot.name).toContain(shot.screen);
      for (const selector of shot.clicks ?? []) expect(html, `${shot.name} ${selector}`).toContain(`id="${selector.slice(1)}"`);
    }
  });

  it('aucun écran oublié : chaque écran d’une page servie est capturé, ou écarté avec sa raison', async () => {
    const pages: Record<string, string> = { app: AGENT_APP_FILES['/app/']!, direction: AGENT_APP_FILES['/app/reseau']!, partenaire: PARTNER_SPACE_FILES['/partenaire/']! };
    const captured = (space: string) => new Set(APP_SHOTS.filter((s) => (space === 'partenaire' ? s.page === '/partenaire/' : s.page !== '/partenaire/')).map((s) => s.screen));
    const left: string[] = [];
    for (const [space, html] of Object.entries(pages)) {
      // La page de la direction est celle de l'agent, avec l'écran du réseau : ses écrans portent le même nom.
      const group = space === 'partenaire' ? 'partenaire' : 'app';
      for (const id of sectionsOf(html)) if (!captured(group).has(id) && !NOT_CAPTURED[`${group}:${id}`]) left.push(`${space}:${id}`);
    }
    expect(left).toEqual([]);
    // Une raison ne reste pas quand elle n'a plus d'objet : l'écran existe encore, et n'est pas capturé.
    for (const [key, reason] of Object.entries(NOT_CAPTURED)) {
      const [group, id] = key.split(':') as [string, string];
      expect(sectionsOf(group === 'partenaire' ? pages.partenaire! : pages.app!), key).toContain(id);
      expect(captured(group).has(id), key).toBe(false);
      expect(reason.length, key).toBeGreaterThan(20);
    }
    // Les pages et documents rendus par le code sont tous capturés, sauf les coquilles, que le plan ouvre avec leurs données.
    const shells = (await screens()).filter((s) => s.css || s.js).map((s) => s.name);
    expect(shells).toEqual(['application de l’agent', 'application, page de la direction', 'espace partenaire']);
  });

  it('le parcours inventé donne de quoi ouvrir chaque écran : un vendeur, son bien, une visite, puis un dossier de vente ; les clés de capture ouvrent l’API', async () => {
    const { known, serve } = await worldAt('visite');
    expect(known.seller).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(known.property.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(known.property.reference).not.toBe('');
    expect(known.visit).not.toBeNull();
    const later = (await worldAt('compromis_acte')).known;
    expect(later.file).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    for (const shot of APP_SHOTS) if (shot.state) expect(shot.state(shot.at === 'compromis_acte' ? later : known), shot.name).not.toBeNull();
    for (const [role, key] of Object.entries(KEYS)) {
      const r = await serve('/v1/moi', { headers: { authorization: `Bearer ${key}` } });
      expect(r.status, role).toBe(200);
    }
    // Sans clé, rien ne s'ouvre : les captures ne passent par aucune porte de côté.
    expect((await serve('/v1/moi')).status).toBe(401);
  });

  it('un dossier de captures sans ses mesures n’est jamais un succès : absent, vide ou d’avant, il est dit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aimmo-captures-'));
    const started = Date.now();
    expect(captureOutcome(dir, started)).toEqual({ ok: false, message: `Aucune capture n’a été faite : ${join(dir, 'captures.json')} est absent. Playwright et Chromium sont-ils installés ?` });
    writeFileSync(join(dir, 'captures.json'), '[]\n');
    expect(captureOutcome(dir, started).ok).toBe(false);
    expect(captureOutcome(dir, started).message).toContain('est vide');
    writeFileSync(join(dir, 'captures.json'), '{pas du json');
    expect(captureOutcome(dir, started).ok).toBe(false);
    const one: Mesure[] = [{ nom: 'application · journée', vue: 'tel', fichier: 'application-journee-tel.jpg', ecrans: 1.4, boutonsPleins: 1, deborde: false }];
    writeFileSync(join(dir, 'captures.json'), JSON.stringify(one));
    expect(captureOutcome(dir, started)).toEqual({ ok: true, message: `1 capture et ses mesures dans ${dir} (captures.json).` });
    // Un fichier resté d'une fois précédente ne compte pas pour cette fois-ci.
    expect(captureOutcome(dir, Date.now() + 60_000).ok).toBe(false);
    expect(captureOutcome(dir, Date.now() + 60_000).message).toContain('date d’avant');
  });

  it('comparer deux jeux de captures : ce qui a changé se dit en une ligne par écran, le reste se tait', () => {
    const before: Mesure[] = [
      { nom: 'application · fiche du client', vue: 'tel', fichier: 'a.jpg', ecrans: 5.8, boutonsPleins: 11, deborde: false },
      { nom: 'application · journée', vue: 'tel', fichier: 'b.jpg', ecrans: 2, boutonsPleins: 1, deborde: false },
      { nom: 'page du bien', vue: 'tel', fichier: 'c.jpg', ecrans: 3, boutonsPleins: 1, deborde: true },
      { nom: 'écran retiré', vue: 'tel', fichier: 'd.jpg', ecrans: 1, boutonsPleins: 0, deborde: false },
    ];
    const after: Mesure[] = [
      { nom: 'application · fiche du client', vue: 'tel', fichier: 'a.jpg', ecrans: 2.2, boutonsPleins: 1, deborde: false },
      { nom: 'application · journée', vue: 'tel', fichier: 'b.jpg', ecrans: 2, boutonsPleins: 1, deborde: false },
      { nom: 'page du bien', vue: 'tel', fichier: 'c.jpg', ecrans: 3, boutonsPleins: 1, deborde: false },
      { nom: 'application · clients', vue: 'tel', fichier: 'e.jpg', ecrans: 1, boutonsPleins: 0, deborde: false },
    ];
    expect(compareCaptures(before, after)).toEqual([
      'application · clients (tel) : nouvel écran, 1 écran, 0 bouton plein',
      'application · fiche du client (tel) : 5,8 → 2,2 écrans ; 11 → 1 bouton plein',
      'écran retiré (tel) : n’est plus capturé',
      'page du bien (tel) : ne déborde plus',
    ]);
    expect(compareCaptures(after, after)).toEqual([]);
  });
});

describe('DS086 · dans Chromium', () => {
  it.skipIf(navigateur === null)('une capture d’essai : la journée de l’agent, servie par l’API du parcours, sort en image avec ses mesures', async () => {
    const { serve, known } = await worldAt('visite');
    const dir = mkdtempSync(join(tmpdir(), 'aimmo-captures-'));
    const page = await appPage(serve, 'agent', 'tel');
    try {
      expect(await openShot(page, APP_SHOTS.find((s) => s.screen === 'accueil')!, known)).toBe(true);
      const m = await shoot(page, dir, 'application · journée', 'tel');
      expect(m.fichier).toBe('application-journee-tel.jpg');
      expect(statSync(join(dir, m.fichier)).size).toBeGreaterThan(10_000);
      expect(m.ecrans).toBeGreaterThanOrEqual(1);
      expect(m.deborde).toBe(false);
      // La journée du parcours est bien là : le rendez-vous de visite du jour, pas un écran vide.
      expect(await page.textContent('#accueil')).toContain('Visite');
    } finally {
      await page.close();
    }
  });

  const out = process.env.AIMMO_CAPTURES;
  // Demandé (`AIMMO_CAPTURES`), le jeu complet ne se saute jamais : sans Chromium, c'est un échec dit avec sa raison.
  it.skipIf(!out)(
    'toutes les captures : chaque écran, sur un téléphone et sur un ordinateur, avec ses mesures',
    async () => {
      if (!navigateur) throw new Error(`Les captures demandées ne sont pas faites : Chromium n’a pas démarré (${launchError ?? 'raison inconnue'}).`);
      const dir = out!;
      mkdirSync(dir, { recursive: true });
      const done: Mesure[] = [];
      const missed: string[] = [];
      // Les pages et documents rendus par le code.
      for (const s of await screens()) {
        if (s.css || s.js) continue; // les coquilles sont capturées plus bas, écran par écran, avec leurs données
        for (const vue of Object.keys(VIEWS) as View[]) {
          const page = await navigateur.newPage({ viewport: VIEWS[vue], locale: 'fr-FR', timezoneId: 'Europe/Paris' });
          try {
            await page.setContent(s.html, { waitUntil: 'load' });
            done.push(await shoot(page, dir, s.name, vue));
          } finally {
            await page.close();
          }
        }
      }
      // L'application et l'espace partenaire, écran par écran, sur le parcours.
      for (const shot of APP_SHOTS) {
        const { serve, known } = await worldAt(shot.at ?? 'visite');
        for (const vue of Object.keys(VIEWS) as View[]) {
          const page = await appPage(serve, shot.role, vue);
          try {
            if (await openShot(page, shot, known)) done.push(await shoot(page, dir, shot.name, vue));
            else missed.push(`${shot.name} (${vue})`);
          } catch (e) {
            missed.push(`${shot.name} (${vue}) : ${(e as Error).message.split('\n')[0]}`);
          } finally {
            await page.close();
          }
        }
      }
      done.sort((a, b) => a.nom.localeCompare(b.nom, 'fr') || a.vue.localeCompare(b.vue));
      writeFileSync(join(dir, 'captures.json'), `${JSON.stringify(done, null, 2)}\n`);
      // Un écran du plan qui ne s'ouvre pas fait échouer le jeu : il n'est jamais passé sous silence.
      expect(missed).toEqual([]);
      expect(JSON.parse(readFileSync(join(dir, 'captures.json'), 'utf8'))).toHaveLength(done.length);
      expect(done.length).toBe(2 * ((await screens()).filter((s) => !s.css && !s.js).length + APP_SHOTS.length));
    },
    900_000,
  );
});
