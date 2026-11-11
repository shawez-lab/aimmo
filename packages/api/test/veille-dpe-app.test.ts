import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { GAGNER_SCRIPT } from '../app/gagner.ts';
import { POSTCODE, VEILLE_DPE_REFUSALS, VEILLE_DPE_SCRIPT } from '../app/veille-dpe.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : communes, codes postaux, adresses, numéros de diagnostic, clé de test.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const INJECTED = '<img src=x onerror="alert(1)">';
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const file = (text: string): Answer => async () => new Response(text, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });

const point = (id: string, energyClass: string, commune: string, extra: Record<string, unknown> = {}) => ({
  diagnosisId: id,
  number: `2799E000000${id}`,
  kind: 'apartment',
  energyClass,
  ghgClass: 'E',
  surfaceM2: 41.6,
  diagnosedOn: '2027-10-08',
  receivedOn: '2027-10-11',
  address: { streetNumber: '4', street: 'rue des Essais', postcode: '99000', commune },
  position: null,
  rentBanFrom: energyClass === 'G' ? '2025-01-01' : energyClass === 'F' ? '2028-01-01' : null,
  letterId: null,
  ...extra,
});
const SECTORS = [
  { sectorId: 's1', commune: 'Commune Une', postcode: '99000', inZone: true },
  { sectorId: 's2', commune: 'Commune Deux', postcode: '99100', inZone: false },
];
const ALERTS = [{ sectorId: 's1', commune: 'Commune Une', postcode: '99000', day: '2027-10-12', items: [point('d1', 'G', 'Commune Une')] }];
const MAP = [
  point('d1', 'G', 'Commune Une'),
  point('d2', 'C', 'Commune Deux', { kind: 'house', ghgClass: null }),
  point('d3', 'F', 'Commune Une', { letterId: 'l9' }),
  point('d4', 'F', INJECTED, { address: { streetNumber: null, street: INJECTED, postcode: '99000', commune: INJECTED } }),
];
const LETTER = 'Au propriétaire,\nVotre logement est classé G : il ne peut plus être loué depuis le 01/01/2025.';

const BASE: Record<string, Answer> = {
  'GET /v1/moi': ok({ role: 'agent', firstName: 'Alex' }),
  'GET /v1/plan-du-jour': ok(null),
  'GET /v1/contacts-chauds': ok({ contacts: [] }),
  'GET /v1/rendez-vous/jour': ok({ appointments: [] }),
  'GET /v1/usage/matin': ok(null),
  'GET /v1/annonces': ok([]),
  'GET /v1/apres-vente/journee': ok({ remercier: [], recommandations: [], taches: [] }),
  'GET /v1/gagner/rendez-vous': ok([]),
  'GET /v1/gagner/recommandations/a-appeler': ok([]),
  'GET /v1/gagner/relances': ok([]),
  'GET /v1/gagner/lettres': ok({ campaigns: [], properties: [] }),
  'GET /v1/veille-dpe/secteurs': ok(SECTORS),
  'GET /v1/veille-dpe/alertes': ok(ALERTS),
  'GET /v1/veille-dpe/carte': ok(MAP),
  'GET /v1/veille-dpe/carte?classes=F,G': ok([MAP[0], MAP[2]]),
  'POST /v1/veille-dpe/secteurs': ok({ sectorId: 's3' }),
  'POST /v1/veille-dpe/secteurs/s1/fermeture': ok(null),
  'POST /v1/veille-dpe/diagnostics/d1/lettre': ok({ letterId: 'l1', body: LETTER, bannedFrom: '2025-01-01' }),
  'GET /v1/veille-dpe/lettres/l1': file('<!doctype html><title>Lettre</title>'),
  'GET /v1/veille-dpe/lettres/l9': file('<!doctype html><title>Lettre</title>'),
};
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const page = document as typeof document & { body: FakeElement };
  page.body = new FakeElement('body');
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; body: unknown; auth: string | undefined }[] = [];
  const table: Record<string, Answer> = { ...BASE, ...answers };
  const downloads: string[] = [];
  const context: Record<string, unknown> = {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, body: init.body === undefined ? undefined : JSON.parse(init.body), auth: init.headers?.authorization });
      const a = table[`${method} ${url}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    URL: { createObjectURL: () => 'blob:essai', revokeObjectURL: () => undefined },
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  const append = page.body.appendChild.bind(page.body);
  page.body.appendChild = (child: FakeElement) => {
    child.click = () => downloads.push(child.attributes.download ?? (child as unknown as { download: string }).download);
    return append(child);
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const body = () => els['gagner-corps']!;
  const buttons = (root: FakeElement, text: string) => root.all().filter((e) => e.tagName === 'button' && e.textContent === text);
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  const scripts = (src: string) => [...els.gagner!.all(), ...els['gagner-corps']!.all()].filter((e) => e.tagName === 'script' && e.attributes.src === src);
  els['gagner-ouvrir']!.listeners.click!({});
  await settle();
  runInNewContext(GAGNER_SCRIPT, context);
  scripts('/app/gagner.js')[0]!.listeners.load!({});
  await settle();
  const part = () => body().children.find((e) => e.tagName === 'section' && e.children[0]!.textContent === 'Veille des diagnostics énergétiques')!;
  const beforeOpen = scripts('/app/veille-dpe.js').length;
  const callsBefore = calls.length;
  const openVeille = async (load = true) => {
    await click(buttons(part(), 'Ouvrir la veille')[0]);
    const s = scripts('/app/veille-dpe.js');
    if (load) {
      runInNewContext(VEILLE_DPE_SCRIPT, context);
      s[s.length - 1]!.listeners.load!({});
      await settle();
    }
    return s;
  };
  const inputs = () => part().all().filter((e) => e.tagName === 'input');
  const mine = () => calls.slice(callsBefore);
  return { calls, mine, part, buttons, click, openVeille, inputs, downloads, beforeOpen, settle };
}

describe('BR36 · écran de la veille des diagnostics énergétiques', () => {
  it('[R201] le script est servi à part, chargé seulement au geste, et tient le budget d’une page ; l’application tient le sien', async () => {
    const t = await run();
    expect(t.beforeOpen).toBe(0);
    expect(t.mine().filter((c) => c.url.startsWith('/v1/veille-dpe'))).toEqual([]);
    expect(await t.openVeille()).toHaveLength(1);
    expect(AGENT_APP_FILES['/app/veille-dpe.js']).toBe(VEILLE_DPE_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/veille-dpe.js');
    expect(JS).not.toContain('/app/veille-dpe.js');
    const served = handleAgentApp(new Request('https://aimmo.example.test/app/veille-dpe.js'))!;
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(budgetProblems({ html: '', js: VEILLE_DPE_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: '', js: GAGNER_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
  });

  it('[R16] l’écran ne lit et n’écrit que par /v1/veille-dpe, la clé dans l’en-tête seul ; rien n’est gardé sur l’appareil', async () => {
    const t = await run();
    await t.openVeille();
    expect(t.mine().map((c) => `${c.method} ${c.url}`)).toEqual(['GET /v1/veille-dpe/secteurs', 'GET /v1/veille-dpe/alertes', 'GET /v1/veille-dpe/carte']);
    for (const c of t.mine()) {
      expect(c.auth).toBe(`Bearer ${KEY}`);
      expect(c.url).not.toContain(KEY);
    }
    const routes = [...VEILLE_DPE_SCRIPT.matchAll(/'(\/v1\/[^']*)'/g)].map((m) => m[1]!);
    expect(routes.every((r) => r.startsWith('/v1/veille-dpe/'))).toBe(true);
    expect(VEILLE_DPE_SCRIPT).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write|localStorage|sessionStorage|eval\(/);
  });

  it('[R288] [R289] les secteurs, l’alerte du jour et la carte regroupée par commune dans l’ordre reçu, sans aucun nom', async () => {
    const t = await run();
    await t.openVeille();
    const text = t.part().textContent;
    expect(text).toContain('Mes communes suivies (2)');
    expect(text).toContain('Commune Une (99000)');
    expect(text).toContain('Plus dans vos zones : plus d’alerte pour cette commune.');
    expect(text).toContain('Alerte du jour (1)');
    expect(text).toContain('Carte des 90 jours (4)');
    const heads = t.part().all().filter((e) => e.tagName === 'h5').map((e) => e.textContent);
    // L'alerte, puis la carte : Commune Une (d1, d3) puis Commune Deux, puis la commune reçue telle quelle.
    expect(heads).toEqual(['Suivre une commune de mes zones', 'Commune Une (1)', 'Commune Une (2)', 'Commune Deux (1)', `${INJECTED} (1)`]);
    expect(text).toContain('Classe G (climat E) · Appartement · 42 m²');
    expect(text).toContain('Classe C · Maison');
    expect(text).toContain('4 rue des Essais, 99000 Commune Une');
    expect(text).toContain('Diagnostic établi le 08/10/2027, publié le 11/10/2027.');
    expect(text).toContain('Ne peut plus être loué à partir du 01/01/2025.');
    expect(text).toContain('Ne peut plus être loué à partir du 01/01/2028.');
    // Aucune saisie ni aucun mot de propriétaire : seuls la commune et le code postal sont demandés [R288].
    expect(t.inputs().map((i) => i.attributes['aria-label'])).toEqual(['Commune', 'Code postal']);
    expect(text).not.toMatch(/propriétaire\s*:|Nom du|M\.|Mme/);
  });

  it('[R290] la lettre seulement pour un F ou un G sans lettre ; préparée, son texte est montré puis téléchargé, rien n’est envoyé', async () => {
    const t = await run();
    await t.openVeille();
    const prepare = t.buttons(t.part(), 'Préparer la lettre « Au propriétaire »');
    // d1 dans l'alerte et sur la carte, d4 (F) : jamais pour d2 (C), ni pour d3 qui a déjà sa lettre.
    expect(prepare).toHaveLength(3);
    expect(t.part().textContent).toContain('Lettre « Au propriétaire » déjà préparée dans le réseau : seul l’agent qui l’a préparée peut l’imprimer.');
    await t.click(t.buttons(t.part(), 'Télécharger la lettre à imprimer')[0]);
    expect(t.downloads).toEqual(['lettre-dpe-l9.html']);
    await t.click(prepare[0]);
    const posts = t.mine().filter((c) => c.method === 'POST');
    expect(posts).toEqual([{ method: 'POST', url: '/v1/veille-dpe/diagnostics/d1/lettre', body: {}, auth: `Bearer ${KEY}` }]);
    expect(t.part().textContent).toContain('Lettre préparée : à imprimer et déposer, rien n’est envoyé.');
    expect(t.part().all().find((e) => e.tagName === 'pre')!.textContent).toBe(LETTER);
    // Le bouton de la lettre préparée vient dans l'alerte, avant celui de la carte.
    await t.click(t.buttons(t.part(), 'Télécharger la lettre à imprimer')[0]);
    expect(t.downloads).toEqual(['lettre-dpe-l9.html', 'lettre-dpe-l1.html']);
    // Le même diagnostic sur la carte passe aussi au téléchargement : plus de bouton qui serait refusé.
    expect(t.buttons(t.part(), 'Préparer la lettre « Au propriétaire »')).toHaveLength(1);
    expect(t.buttons(t.part(), 'Télécharger la lettre à imprimer')).toHaveLength(3);
    await t.click(t.buttons(t.part(), 'Télécharger la lettre à imprimer')[1]);
    expect(t.downloads).toEqual(['lettre-dpe-l9.html', 'lettre-dpe-l1.html', 'lettre-dpe-l1.html']);
    expect(t.mine().filter((c) => c.method === 'POST')).toHaveLength(1);
    const l1 = t.mine().find((c) => c.url === '/v1/veille-dpe/lettres/l1')!;
    expect(l1.auth).toBe(`Bearer ${KEY}`);
    // Aucun envoi : le script n'a aucune route d'envoi, d'impression à distance ni de mail.
    expect(VEILLE_DPE_SCRIPT).not.toMatch(/envoyer|\/envoi|mailto:|sms:/i);
  });

  it('suivre une commune : saisie fausse refusée avant tout appel ; juste, envoyée puis relue', async () => {
    const t = await run();
    await t.openVeille();
    const [commune, postcode] = t.inputs();
    const before = t.calls.length;
    await t.click(t.buttons(t.part(), 'Suivre cette commune')[0]);
    expect(t.part().textContent).toContain(VEILLE_DPE_REFUSALS.bad_commune);
    commune!.value = 'Commune Trois';
    postcode!.value = '9900';
    await t.click(t.buttons(t.part(), 'Suivre cette commune')[0]);
    expect(t.part().textContent).toContain(VEILLE_DPE_REFUSALS.bad_postcode);
    expect(t.calls.length).toBe(before);
    for (const bad of ['9900', '990000', 'ab123', ' 99000x']) expect(POSTCODE.test(bad), bad).toBe(false);
    postcode!.value = ' 99200 ';
    await t.click(t.buttons(t.part(), 'Suivre cette commune')[0]);
    const after = t.calls.slice(before);
    expect(after[0]).toEqual({ method: 'POST', url: '/v1/veille-dpe/secteurs', body: { commune: 'Commune Trois', postcode: '99200' }, auth: `Bearer ${KEY}` });
    expect(after.slice(1).map((c) => c.url)).toEqual(['/v1/veille-dpe/secteurs', '/v1/veille-dpe/alertes', '/v1/veille-dpe/carte']);
    expect(t.part().textContent).toContain('Veille ouverte pour Commune Trois (99200) : l’alerte arrive chaque matin.');
  });

  it('arrêter un secteur, puis « Seulement F et G » demande le filtre au serveur', async () => {
    const t = await run();
    await t.openVeille();
    await t.click(t.buttons(t.part(), 'Arrêter la veille')[0]);
    expect(t.mine().find((c) => c.method === 'POST')).toEqual({ method: 'POST', url: '/v1/veille-dpe/secteurs/s1/fermeture', body: {}, auth: `Bearer ${KEY}` });
    expect(t.part().textContent).toContain('Veille arrêtée pour Commune Une : ce qui est déjà reçu reste.');
    await t.click(t.buttons(t.part(), 'Seulement F et G')[0]);
    expect(t.mine().map((c) => c.url)).toContain('/v1/veille-dpe/carte?classes=F,G');
    expect(t.part().textContent).toContain('Carte des 90 jours, F et G (2)');
    expect(t.buttons(t.part(), 'Toutes les classes')).toHaveLength(1);
  });

  it('l’écran ne montre jamais un code interne : chaque refus connu a ses mots, un code inconnu a une phrase sûre', async () => {
    for (const [code, words] of Object.entries(VEILLE_DPE_REFUSALS)) {
      if (code === 'agent_inactive') continue; // l'application oublie alors la clé, avant tout écran
      const t = await run({
        'POST /v1/veille-dpe/diagnostics/d1/lettre': no(code === 'role' ? 403 : 409, { ok: false, rule: 'R290', code }),
        'GET /v1/veille-dpe/carte': no(500, { ok: false, rule: null, code: 'panne_xyz' }),
      });
      await t.openVeille();
      await t.click(t.buttons(t.part(), 'Préparer la lettre « Au propriétaire »')[0]);
      const text = t.part().textContent;
      expect(text, code).toContain(words);
      expect(text).toContain('La carte est indisponible pour le moment.');
      expect(text).not.toContain('panne_xyz');
      expect(text).not.toMatch(new RegExp(`\\b${code}\\b`));
    }
  });

  it('une réponse perdue se dit « rien n’est sûr », et le bouton reste là ; sans réseau du tout, l’écran le dit', async () => {
    const t = await run({ 'POST /v1/veille-dpe/diagnostics/d1/lettre': () => Promise.reject(new TypeError('hors ligne')) });
    await t.openVeille();
    await t.click(t.buttons(t.part(), 'Préparer la lettre « Au propriétaire »')[0]);
    expect(t.part().textContent).toContain('La réponse n’est pas arrivée : rien n’est sûr. Relisez avant de recommencer.');
    expect(t.buttons(t.part(), 'Préparer la lettre « Au propriétaire »')).toHaveLength(3);
    const off = await run({ 'GET /v1/veille-dpe/secteurs': () => Promise.reject(new TypeError('x')), 'GET /v1/veille-dpe/alertes': () => Promise.reject(new TypeError('x')), 'GET /v1/veille-dpe/carte': () => Promise.reject(new TypeError('x')) });
    await off.openVeille();
    expect(off.part().textContent).toContain('Pas de réseau. Réessayez dans un moment.');
    const failed = await run();
    const s = await failed.openVeille(false);
    s[0]!.listeners.error!({});
    expect(failed.part().textContent).toContain('Pas de réseau. Réessayez dans un moment.');
  });

  it('tout texte reçu est posé en texte, jamais lu comme du HTML ; un identifiant mal formé n’a pas de bouton', async () => {
    const t = await run({ 'GET /v1/veille-dpe/carte': ok([point('../x', 'G', 'Commune Une'), point('d5', 'G', 'Commune Une', { letterId: 'l/../x' })]), 'GET /v1/veille-dpe/alertes': ok([]) });
    await t.openVeille();
    expect(t.part().all().some((e) => e.tagName === 'img')).toBe(false);
    // d5 : sa lettre au nom mal formé n'est pas téléchargeable ; seule la préparation est offerte, par son identifiant sûr.
    expect(t.buttons(t.part(), 'Préparer la lettre « Au propriétaire »')).toHaveLength(1);
    expect(t.buttons(t.part(), 'Télécharger la lettre à imprimer')).toHaveLength(0);
    const injected = await run();
    await injected.openVeille();
    expect(injected.part().textContent).toContain(INJECTED);
    expect(injected.part().all().some((e) => e.tagName === 'img')).toBe(false);
  });

  it('deux ouvertures de suite : seule la dernière lecture dessine, même quand la première répond après', async () => {
    let release: () => void = () => undefined;
    let first = true;
    const t = await run({
      'GET /v1/veille-dpe/carte': async () => {
        if (first) {
          first = false;
          await new Promise<void>((r) => (release = r));
          return Response.json({ ok: true, mode: 'essai', data: [] });
        }
        return Response.json({ ok: true, mode: 'essai', data: MAP });
      },
    });
    await t.openVeille();
    await t.click(t.buttons(t.part(), 'Ouvrir la veille')[0]);
    release();
    await t.settle();
    const text = t.part().textContent;
    expect(text.match(/Mes communes suivies/g)).toHaveLength(1);
    expect(text.match(/Carte des 90 jours/g)).toHaveLength(1);
    expect(text).toContain('Carte des 90 jours (4)');
  });
});
