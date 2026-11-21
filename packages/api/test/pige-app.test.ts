import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { GAGNER_SCRIPT } from '../app/gagner.ts';
import { PIGE_ALERTS, PIGE_REFUSALS, PIGE_SCRIPT } from '../app/pige.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : annonces, communes, adresses, chiffres, clé de test.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const INJECTED = '<img src=x onerror="alert(1)">';
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });

const AD = (o: Record<string, unknown>) => ({
  source: 'Site Essai',
  kind: 'apartment',
  commune: 'Commune Une',
  postalCode: '99000',
  surfaceM2: 64,
  rooms: 3,
  priceEur: 187000,
  publishedAt: '2027-10-08T09:00:00.000Z',
  sites: 1,
  draft: null,
  ...o,
});
const QUEUE = [
  // Des chiffres impossibles à retrouver par un calcul : l'écran montre ceux du serveur, tels quels.
  AD({ adId: 'a1', sites: 2, market: { adPerM2: 2922, medianPerM2: 2711, gapPct: 8, sales: 41, source: 'DVF, publication d’octobre 2027', dvfLastSale: '2027-06' } }),
  AD({ adId: 'a2', kind: 'house', commune: INJECTED, rooms: null, market: { unpriced: true, reason: 'marche_non_chiffre' }, draft: { id: 'd2', body: `Bonjour, votre annonce à Commune Deux. ${INJECTED}`, handed: false } }),
  AD({ adId: 'a3', market: { unpriced: true, reason: 'marche_non_chiffre' }, draft: { id: 'd3', body: 'Déjà remis.', handed: true } }),
];
const REPORT = {
  rows: [
    { level: 'forte', properties: 3, mandates: 1 },
    { level: 'moyenne', properties: 2, mandates: 0 },
    { level: 'faible', properties: 0, mandates: 0 },
    { level: 'sans_adresse', properties: 4, mandates: 2 },
  ],
  properties: 9,
  mandates: 3,
  rate: 3 / 9,
};
const PROPOSAL = {
  proposalId: 'pr1',
  adId: 'a1',
  candidates: [
    {
      diagnosisNumber: '2721E0000001A',
      streetNumber: '12',
      street: 'rue des Essais',
      postcode: '99000',
      commune: 'Commune Une',
      confidence: 83,
      level: 'forte',
      points: [
        { criterion: 'surface', points: 40, fact: 'Surface de 64 m² dans l’annonce et au diagnostic.', source: 'ADEME, diagnostics de performance énergétique', date: '2025-03-14' },
        { criterion: 'cadastre', points: 0, fact: INJECTED, source: 'Cadastre', date: '2027-10-01' },
      ],
    },
  ],
  missing: [{ source: 'Cadastre', reason: 'cadastre non branché' }],
};

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
  'GET /v1/pige': ok(QUEUE),
  'GET /v1/pige/rapport': ok(REPORT),
  'GET /v1/pige/etat': ok({ configured: true, missing: [], lastCollectedAt: '2027-10-09T05:00:00.000Z', lastRun: { at: '2027-10-09T05:00:00.000Z', outcome: 'ok', reason: null, received: 4, added: 1 }, alert: null }),
  'POST /v1/pige/annonces/a1/message': ok({ draftId: 'd1', body: 'Bonjour', sent: false }),
  'POST /v1/pige/messages/d2/validation': ok({ body: 'Bonjour, texte remis à coller.', channel: 'annonce', sent: false, toPaste: true }),
  'POST /v1/pige/annonces/a1/adresses': ok(PROPOSAL),
  'POST /v1/pige/annonces/a1/bien': ok({ propertyId: 'b9', reference: 'P-77', source: 'pige' }),
  'POST /v1/pige/annonces/a2/opposition': ok(null),
};
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(answers: Record<string, Answer> = {}, clipboard?: { writeText: (s: string) => Promise<void> }) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; body: unknown; auth: string | undefined }[] = [];
  const table: Record<string, Answer> = { ...BASE, ...answers };
  const context: Record<string, unknown> = {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, body: init.body === undefined ? undefined : JSON.parse(init.body), auth: init.headers?.authorization });
      const a = table[`${method} ${url}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    navigator: { serviceWorker: { register: () => Promise.resolve({}) }, ...(clipboard ? { clipboard } : {}) },
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
  // L'écran « Gagner des mandats », puis la partie de la pige : chaque script est exécuté comme le ferait le navigateur.
  els['gagner-ouvrir']!.listeners.click!({});
  await settle();
  runInNewContext(GAGNER_SCRIPT, context);
  scripts('/app/gagner.js')[0]!.listeners.load!({});
  await settle();
  const pigePart = () => body().children.find((e) => e.tagName === 'section' && e.children[0]!.textContent === 'Annonces de particuliers')!;
  const beforeOpen = scripts('/app/pige.js').length;
  const callsBefore = calls.length;
  const openPige = async (load = true) => {
    await click(buttons(pigePart(), 'Ouvrir la pige')[0]);
    const s = scripts('/app/pige.js');
    if (load) {
      runInNewContext(PIGE_SCRIPT, context);
      s[s.length - 1]!.listeners.load!({});
      await settle();
    }
    return s;
  };
  const items = () => pigePart().all().filter((e) => e.tagName === 'ul' && e.className === 'liste').slice(-1)[0]?.children ?? [];
  const posts = () => calls.filter((c) => c.method === 'POST');
  return { els, calls, body, buttons, click, pigePart, openPige, items, posts, beforeOpen, callsBefore, settle };
}

describe('BR33 · écran de la pige des annonces de particuliers', () => {
  it('[R201] le script est servi à part, chargé seulement au geste, et tient le budget d’une page ; l’application tient le sien', async () => {
    const t = await run();
    expect(t.beforeOpen).toBe(0);
    expect(t.calls.slice(t.callsBefore).filter((c) => c.url.startsWith('/v1/pige'))).toEqual([]);
    const s = await t.openPige();
    expect(s).toHaveLength(1);
    expect(t.items()).toHaveLength(3);
    expect(AGENT_APP_FILES['/app/pige.js']).toBe(PIGE_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/pige.js');
    expect(JS).not.toContain('/app/pige.js');
    const served = handleAgentApp(new Request('https://aimmo.example.test/app/pige.js'))!;
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(budgetProblems({ html: '', js: PIGE_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: '', js: GAGNER_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
  });

  it('[R16] l’écran ne lit et n’écrit que par /v1/pige, la clé dans l’en-tête seul', async () => {
    const t = await run();
    await t.openPige();
    const [a1] = t.items();
    await t.click(t.buttons(a1!, 'Adresses probables')[0]);
    await t.click(t.buttons(a1!, 'Créer la fiche sans adresse')[0]);
    const mine = t.calls.slice(t.callsBefore);
    expect(mine.length).toBeGreaterThanOrEqual(5);
    for (const c of mine) {
      expect(c.url.startsWith('/v1/pige'), c.url).toBe(true);
      expect(c.auth).toBe(`Bearer ${KEY}`);
      expect(c.url).not.toContain(KEY);
    }
    const routes = [...PIGE_SCRIPT.matchAll(/'(\/v1\/[^']*)'/g)].map((m) => m[1]!);
    expect(routes.length).toBeGreaterThanOrEqual(7);
    for (const r of routes) expect(r.startsWith('/v1/pige'), r).toBe(true);
    expect(PIGE_SCRIPT).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write|localStorage|eval\(/);
  });

  it('[R274] l’écart au marché porte sa source et sa dernière vente, sinon « marché non chiffré » ; [R296] ce que la pige rapporte, par niveau', async () => {
    const t = await run();
    await t.openPige();
    const [a1, a2] = t.items();
    expect(a1!.textContent).toContain('Appartement · Commune Une (99000) · 64 m² · 3 pièce(s) · 187 000 €');
    expect(a1!.textContent).toContain('Vue sur Site Essai et 1 autre(s) site(s)');
    expect(a1!.textContent).toContain('2 922 €/m², 8 % au-dessus du marché (médiane 2 711 €/m² sur 41 ventes ; source : DVF, publication d’octobre 2027, dernière vente 2027-06).');
    expect(a2!.textContent).toContain('Marché non chiffré : aucune case publiée des prix regroupés pour cette commune.');
    expect(a2!.textContent).not.toContain('€/m²');
    const text = t.pigePart().textContent;
    expect(text).toContain('9 fiche(s) créée(s), 3 mandat(s) signé(s) ensuite.');
    expect(text).toContain('confiance forte : 3 fiche(s), 1 mandat(s)');
    expect(text).toContain('sans adresse : 4 fiche(s), 2 mandat(s)');
    expect(text).toContain('Ma file (3)');
    expect(text).not.toMatch(/marche_non_chiffre|sans_adresse/);
  });

  it('[R275] aucun envoi : le message validé est montré à copier, seul le canal de la messagerie de l’annonce est proposé', async () => {
    const copied: string[] = [];
    const t = await run({}, { writeText: async (s) => void copied.push(s) });
    await t.openPige();
    const [a1, a2, a3] = t.items();
    // Pas encore de message : il se prépare, puis la file est relue.
    await t.click(t.buttons(a1!, 'Préparer le premier message')[0]);
    expect(t.posts()[0]).toMatchObject({ url: '/v1/pige/annonces/a1/message', body: undefined });
    expect(t.calls.filter((c) => c.url === '/v1/pige').length).toBe(2);
    expect(t.pigePart().textContent).toContain('Premier message préparé : relisez-le avant de le valider.');
    // Un message préparé : relu, puis remis à coller.
    const again = t.items()[1]!;
    expect(again.textContent).toContain(`Bonjour, votre annonce à Commune Deux. ${INJECTED}`);
    await t.click(t.buttons(again, 'Je l’ai relu : le copier pour la messagerie de l’annonce')[0]);
    expect(t.posts()[1]).toEqual({ method: 'POST', url: '/v1/pige/messages/d2/validation', body: { channel: 'annonce' }, auth: `Bearer ${KEY}` });
    const area = again.all().find((e) => e.tagName === 'textarea')!;
    expect(area.value).toBe('Bonjour, texte remis à coller.');
    expect(area.attributes.readonly).toBe('readonly');
    expect(again.textContent).toContain('Collez-le vous-même dans la messagerie de l’annonce : rien n’est parti d’AIMMO.');
    await t.click(t.buttons(again, 'Copier le texte')[0]);
    expect(copied).toEqual(['Bonjour, texte remis à coller.']);
    expect(again.textContent).toContain('Texte copié.');
    // Déjà remis : plus aucun bouton de message.
    expect(a3!.textContent).toContain('Premier message déjà remis');
    expect(t.buttons(a3!, 'Préparer le premier message')).toHaveLength(0);
    // Le script ne propose aucun autre canal.
    const channels = [...PIGE_SCRIPT.matchAll(/channel:\s*'([^']*)'/g)].map((m) => m[1]);
    expect(channels).toEqual(['annonce']);
    expect(PIGE_SCRIPT).not.toMatch(/'(sms|email|whatsapp|phone)'/);
    expect(a2).toBeDefined();
  });

  it('sans presse-papiers, l’écran demande de sélectionner le texte à la main', async () => {
    const t = await run();
    await t.openPige();
    const a2 = t.items()[1]!;
    await t.click(t.buttons(a2, 'Je l’ai relu : le copier pour la messagerie de l’annonce')[0]);
    await t.click(t.buttons(a2, 'Copier le texte')[0]);
    expect(a2.textContent).toContain('Copie impossible : sélectionnez le texte à la main.');
  });

  it('[R294] [R295] chaque adresse dit sa confiance, son niveau et ses points sourcés ; la fiche se crée avec ou sans adresse, puis la file est relue', async () => {
    const t = await run();
    await t.openPige();
    const a1 = t.items()[0]!;
    await t.click(t.buttons(a1, 'Adresses probables')[0]);
    expect(t.posts()[0]).toMatchObject({ url: '/v1/pige/annonces/a1/adresses', body: undefined });
    const text = a1.textContent;
    expect(text).toContain('12 rue des Essais, 99000 Commune Une');
    expect(text).toContain('Confiance 83 sur 100, confiance forte.');
    expect(text).toContain('Surface de 64 m² dans l’annonce et au diagnostic. (40 points ; source : ADEME, diagnostics de performance énergétique, ');
    expect(text).toContain(`${INJECTED} (0 points ; source : Cadastre, `);
    expect(text).toContain('Sans réponse : Cadastre (cadastre non branché).');
    expect(text).not.toMatch(/criterion|diagnosisNumber/);
    expect(a1.all().some((e) => e.tagName === 'img')).toBe(false);
    await t.click(t.buttons(a1, 'Créer la fiche avec cette adresse')[0]);
    expect(t.posts()[1]).toMatchObject({ url: '/v1/pige/annonces/a1/bien', body: { proposalId: 'pr1', diagnosisNumber: '2721E0000001A' } });
    expect(t.pigePart().textContent).toContain('Fiche créée : bien P-77, source « pige ».');
    expect(t.calls.filter((c) => c.url === '/v1/pige').length).toBe(2);
    const fresh = t.items()[0]!;
    await t.click(t.buttons(fresh, 'Adresses probables')[0]);
    await t.click(t.buttons(fresh, 'Créer la fiche sans adresse')[0]);
    expect(t.posts()[3]).toMatchObject({ url: '/v1/pige/annonces/a1/bien', body: {} });
  });

  it('[R04] « Le particulier a dit non » ferme le bien et relit la file', async () => {
    const t = await run();
    await t.openPige();
    await t.click(t.buttons(t.items()[1]!, 'Le particulier a dit non')[0]);
    expect(t.posts()[0]).toMatchObject({ url: '/v1/pige/annonces/a2/opposition' });
    expect(t.pigePart().textContent).toContain('Bien fermé : plus aucun message, sur aucun site.');
  });

  it('l’écran ne montre jamais un code interne : chaque refus connu a ses mots, un code inconnu a une phrase sûre', async () => {
    for (const [code, words] of Object.entries(PIGE_REFUSALS)) {
      expect(words.length, code).toBeGreaterThan(10);
      expect(words).not.toMatch(/[a-z]+_[a-z]+/);
    }
    const t = await run({
      'POST /v1/pige/annonces/a1/message': no(409, { ok: false, rule: 'R273', code: 'pas_agence' }),
      'POST /v1/pige/annonces/a1/adresses': no(409, { ok: false, rule: 'R999', code: 'code_inconnu_xyz' }),
      'POST /v1/pige/messages/d2/validation': no(409, { ok: false, rule: 'R01', code: 'hors_heures' }),
    });
    await t.openPige();
    const [a1, a2] = t.items();
    await t.click(t.buttons(a1!, 'Préparer le premier message')[0]);
    expect(a1!.textContent).toContain('Le particulier ne veut pas d’agence : aucun message, jamais.');
    await t.click(t.buttons(a1!, 'Adresses probables')[0]);
    expect(a1!.textContent).toContain('Les adresses probables ne sont pas disponibles.');
    await t.click(t.buttons(a2!, 'Je l’ai relu : le copier pour la messagerie de l’annonce')[0]);
    expect(a2!.textContent).toContain('Hors des heures d’envoi : le message pourra être remis demain matin.');
    expect(a2!.all().some((e) => e.tagName === 'textarea')).toBe(false);
    expect(t.pigePart().textContent).not.toMatch(/pas_agence|code_inconnu|hors_heures|R273|R999|R01/);
    // La file refusée, et une réponse perdue : dites en mots.
    const refused = await run({ 'GET /v1/pige': no(403, { ok: false, rule: 'R16', code: 'role' }) });
    await refused.openPige();
    expect(refused.pigePart().textContent).toContain('Ce n’est pas dans vos droits.');
    const lost = await run({ 'POST /v1/pige/annonces/a2/opposition': async () => Promise.reject(new TypeError('hors ligne')) });
    await lost.openPige();
    const b = lost.items()[1]!;
    await lost.click(lost.buttons(b, 'Le particulier a dit non')[0]);
    expect(b.textContent).toContain('La réponse n’est pas arrivée : rien n’est sûr.');
  });

  it('le script de la pige ne charge pas : l’écran le dit, et le bouton reste utilisable', async () => {
    const t = await run();
    const s = await t.openPige(false);
    s[0]!.listeners.error!({});
    expect(t.pigePart().textContent).toContain('Pas de réseau. Réessayez dans un moment.');
    expect((t.buttons(t.pigePart(), 'Ouvrir la pige')[0] as unknown as { disabled?: boolean }).disabled).toBeFalsy();
  });

  it('deux ouvertures de suite : seule la dernière lecture dessine, même quand la première répond après', async () => {
    let release: () => void = () => undefined;
    let first = true;
    const t = await run({
      'GET /v1/pige': async () => {
        if (first) {
          first = false;
          await new Promise<void>((r) => (release = r));
          return Response.json({ ok: true, mode: 'essai', data: [QUEUE[0]] });
        }
        return Response.json({ ok: true, mode: 'essai', data: QUEUE });
      },
    });
    await t.openPige();
    await t.click(t.buttons(t.pigePart(), 'Ouvrir la pige')[0]);
    release();
    await t.settle();
    const text = t.pigePart().textContent;
    expect(text.match(/Ma file \(/g)).toHaveLength(1);
    expect(text.match(/Ce que la pige vous a rapporté/g)).toHaveLength(1);
    expect(text).toContain('Ma file (3)');
  });

  it('[R671] la date de la dernière relève est dite en tête ; une panne est dite en mots, jamais par son code', async () => {
    let t = await run();
    await t.openPige();
    let text = t.pigePart().textContent;
    expect(text).toMatch(/Annonces relevées le /);
    expect(text).not.toContain(PIGE_ALERTS.panne);
    t = await run({ 'GET /v1/pige/etat': ok({ configured: true, missing: [], lastCollectedAt: '2027-10-08T05:00:00.000Z', lastRun: { outcome: 'panne', reason: 'acces_refuse' }, alert: 'panne' }) });
    await t.openPige();
    text = t.pigePart().textContent;
    expect(text).toContain(PIGE_ALERTS.panne);
    expect(text).not.toContain('acces_refuse');
    const alert = t.pigePart().all().find((e) => e.attributes.role === 'alert');
    expect(alert?.textContent).toBe(PIGE_ALERTS.panne);
    t = await run({ 'GET /v1/pige/etat': ok({ configured: false, missing: [], lastCollectedAt: null, lastRun: null, alert: 'non_reglee' }) });
    await t.openPige();
    text = t.pigePart().textContent;
    expect(text).toContain('Annonces jamais relevées.');
    expect(text).toContain(PIGE_ALERTS.non_reglee);
    // Sans réponse de l'état, la file reste lisible.
    t = await run({ 'GET /v1/pige/etat': no(500, { ok: false, code: 'erreur' }) });
    await t.openPige();
    expect(t.items()).toHaveLength(3);
  });
});
