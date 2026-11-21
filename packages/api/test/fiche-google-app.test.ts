import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { ATTIRER_SCRIPT } from '../app/attirer.ts';
import { FICHE_GOOGLE_SCRIPT } from '../app/fiche-google.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { attirerRoutes } from '../src/attirer.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : agents, avis, textes, clé de test.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const INJECTED = '<img src=x onerror="alert(1)">';
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });

const LOCATION = { locationRef: 'locations/42', title: 'Camille Essai, agent immobilier', websiteUri: 'https://camille.exemple.test' };
const draft = (over: Record<string, unknown> = {}) => ({ draftId: 'd1', body: 'Merci pour votre avis.\nCamille, votre agent immobilier', linkUri: null, origin: 'ia', validatedAt: null, state: 'a_valider', ...over });
const review = (over: Record<string, unknown> = {}) => ({ reviewId: 'r1', rating: 4, comment: `Très bon suivi ${INJECTED}`, reviewedAt: '2026-10-28T10:00:00.000Z', draft: null, ...over });
const screenData = (over: Record<string, unknown> = {}) => ({ agentId: 'ag-1', agentFirstName: 'Camille', connected: true, mode: 'essai', canConfigure: false, location: LOCATION, reviewsTotal: 1, reviewsWaiting: 1, reviews: [review()], publications: [], ...over });

let clock = 0;
class Clock extends Date {
  static override now(): number {
    return clock;
  }
}
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(answers: Record<string, Answer> = {}, role: 'agent' | 'direction' = 'agent') {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const page = document as typeof document & { body: FakeElement };
  page.body = new FakeElement('body');
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; body?: string; auth: string | undefined }[] = [];
  const table: Record<string, Answer> = { 'GET /v1/moi': ok({ role, firstName: 'Camille' }), 'GET /v1/attirer/google/moi': ok(screenData()), ...answers };
  const context: Record<string, unknown> = {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, ...(init.body === undefined ? {} : { body: init.body }), auth: init.headers?.authorization });
      const a = table[`${method} ${url}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    Intl,
    Date: Clock,
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const body = () => els['fiche-google-corps']!;
  const state = () => els['fiche-google-etat']!.textContent;
  const buttons = (text: string) => body().all().filter((e) => e.tagName === 'button' && e.textContent === text);
  const allButtons = () => body().all().filter((e) => e.tagName === 'button').map((e) => e.textContent);
  const texts = () => body().all().map((e) => e.textContent).join(' | ');
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  const input = (label: string) => {
    const l = body().all().find((e) => e.tagName === 'label' && e.textContent === label);
    if (!l) throw new Error(`libellé absent : ${label}`);
    return body().all().find((e) => e.attributes.id === l.attributes.for)!;
  };
  const posts = () => calls.filter((c) => c.method === 'POST');
  const load = async () => {
    const s = els['fiche-google']!.children.filter((e) => e.tagName === 'script');
    if (s.length === 1 && !body().children.length) {
      runInNewContext(FICHE_GOOGLE_SCRIPT, context);
      s[0]!.listeners.load!({});
      await settle();
    }
  };
  const ouvrir = async () => {
    await click(els['fiche-google-ouvrir']);
    await load();
  };
  return { els, calls, context, table, click, body, buttons, allButtons, texts, input, state, posts, ouvrir, load, storage };
}

describe('AT14 · écran « Fiche Google »', () => {
  it('[R16] l’écran ne lit et n’écrit que par /v1/attirer/google, la clé dans l’en-tête seul, et chaque adresse existe pour l’agent', async () => {
    const t = await run({ 'POST /v1/attirer/google/avis/r1/brouillon': ok(draft()), 'GET /v1/attirer/google/moi': ok(screenData({ reviews: [review()] })) });
    const before = t.calls.length;
    await t.ouvrir();
    expect(t.calls[before]).toMatchObject({ method: 'GET', url: '/v1/attirer/google/moi' });
    await t.click(t.buttons('Préparer une réponse')[0]);
    t.table['GET /v1/attirer/google/moi'] = ok(screenData({ reviews: [review({ draft: draft() })] }));
    await t.click(t.buttons('Préparer la prochaine publication')[0]);
    const mine = t.calls.slice(before);
    expect(mine.length).toBeGreaterThan(2);
    const routes = attirerRoutes();
    for (const c of mine) {
      expect(c.url.startsWith('/v1/attirer/google/')).toBe(true);
      expect(c.url).not.toContain(KEY);
      expect(c.auth).toBe(`Bearer ${KEY}`);
      const route = routes.find((r) => r.method === c.method && r.pattern.test(c.url.replace('/v1', '')));
      expect(route, c.url).toBeDefined();
      expect(route!.roles).toContain('agent');
    }
  });

  it('sans Google branché (H07), l’écran le dit sans erreur, et ne propose pas de lire les avis', async () => {
    const t = await run({ 'GET /v1/attirer/google/moi': ok(screenData({ connected: false, reviews: [], reviewsTotal: 0, reviewsWaiting: 0, location: null })) });
    await t.ouvrir();
    expect(t.texts()).toContain('Google n’est pas encore branché');
    expect(t.texts()).toContain('Aucun avis lu pour le moment.');
    expect(t.texts()).toContain('la direction doit la régler');
    expect(t.state()).toBe('');
    expect(t.buttons('Lire les nouveaux avis')).toEqual([]);
    expect(t.buttons('Préparer la prochaine publication')).toEqual([]);
    expect(t.posts()).toEqual([]);
  });

  it('Google branché : lire les avis dit combien sont nouveaux', async () => {
    const t = await run({ 'POST /v1/attirer/google/agents/ag-1/lecture': ok({ added: 2 }) });
    await t.ouvrir();
    await t.click(t.buttons('Lire les nouveaux avis')[0]);
    expect(t.state()).toBe('2 nouvel(s) avis lu(s).');
    t.table['POST /v1/attirer/google/agents/ag-1/lecture'] = ok({ added: 0 });
    await t.click(t.buttons('Lire les nouveaux avis')[0]);
    expect(t.state()).toBe('Aucun nouvel avis.');
    t.table['POST /v1/attirer/google/agents/ag-1/lecture'] = no(400, { ok: false, rule: null, code: 'echec' });
    await t.click(t.buttons('Lire les nouveaux avis')[0]);
    expect(t.state()).toContain('Google n’a pas répondu');
  });

  it('[R154] le texte exact est montré ligne par ligne, et la validation porte sur ce texte', async () => {
    const shown = draft({ draftId: 'd7' });
    const t = await run({ 'GET /v1/attirer/google/moi': ok(screenData({ reviews: [review({ draft: shown })] })), 'POST /v1/attirer/google/textes/d7/valider': ok(draft({ draftId: 'd7', validatedAt: 'x' })) });
    await t.ouvrir();
    const lines = t.body().all().filter((e) => e.tagName === 'p').map((e) => e.textContent);
    for (const line of shown.body.split('\n')) expect(lines).toContain(line);
    // Le champ de correction porte le même texte, sans rien perdre.
    expect(t.input('Votre réponse').value).toBe(shown.body);
    expect(t.buttons('Noter l’envoi, sans rien faire partir')).toEqual([]);
    t.table['GET /v1/attirer/google/moi'] = ok(screenData({ reviews: [review({ draft: { ...shown, validatedAt: '2026-10-29T08:00:00.000Z', state: 'a_envoyer' } })] }));
    await t.click(t.buttons('Je l’ai relu : valider')[0]);
    expect(t.posts().map((c) => c.url)).toEqual(['/v1/attirer/google/textes/d7/valider']);
    expect(t.state()).toBe('Texte validé.');
    expect(t.buttons('Je l’ai relu : valider')).toEqual([]);
    expect(t.buttons('Noter l’envoi, sans rien faire partir')).toHaveLength(1);
  });

  it('[R154] corriger envoie le texte tel qu’il est écrit ; un refus dit pourquoi en français et garde ce qui est écrit', async () => {
    const t = await run({
      'GET /v1/attirer/google/moi': ok(screenData({ reviews: [review({ draft: draft() })] })),
      'POST /v1/attirer/google/avis/r1/reponse': no(409, { ok: false, rule: 'R154', code: 'texte_refuse', problems: ['nom', 'montant'] }),
    });
    await t.ouvrir();
    t.input('Votre réponse').value = 'Merci Gaspard, 250 000 euros.';
    await t.click(t.buttons('Enregistrer ce texte')[0]);
    expect(JSON.parse(t.posts()[0]!.body!)).toEqual({ body: 'Merci Gaspard, 250 000 euros.' });
    expect(t.state()).toContain('un nom de personne, un montant ou un grand nombre');
    expect(t.state()).not.toContain('nom,');
    expect(t.input('Votre réponse').value).toBe('Merci Gaspard, 250 000 euros.');
    // Accepté : le nouveau texte est à relire.
    t.table['POST /v1/attirer/google/avis/r1/reponse'] = ok(draft({ draftId: 'd2', body: 'Merci.' }));
    t.table['GET /v1/attirer/google/moi'] = ok(screenData({ reviews: [review({ draft: draft({ draftId: 'd2', body: 'Merci.', origin: 'agent' }) })] }));
    t.input('Votre réponse').value = 'Merci.';
    await t.click(t.buttons('Enregistrer ce texte')[0]);
    expect(t.state()).toBe('Texte enregistré : relisez-le, puis validez.');
    expect(t.texts()).toContain('Écrit à la main');
    expect(t.buttons('Je l’ai relu : valider')).toHaveLength(1);
  });

  it('un avis sans réponse se prépare ou s’écrit à la main', async () => {
    const t = await run({ 'POST /v1/attirer/google/avis/r1/brouillon': no(409, { ok: false, rule: 'R154', code: 'texte_refuse', problems: ['nom'] }) });
    await t.ouvrir();
    expect(t.input('Votre réponse').value).toBe('');
    await t.click(t.buttons('Préparer une réponse')[0]);
    expect(t.state()).toContain('un nom de personne');
    expect(t.buttons('Enregistrer ce texte')).toHaveLength(1);
  });

  it('[R26] en essai, le geste dit que rien ne part, et le dit encore une fois noté', async () => {
    const x = draft({ validatedAt: '2026-10-29T08:00:00.000Z', state: 'a_envoyer' });
    const t = await run({ 'GET /v1/attirer/google/moi': ok(screenData({ reviews: [review({ draft: x })] })), 'POST /v1/attirer/google/textes/d1/publier': ok({ mode: 'essai' }) });
    await t.ouvrir();
    expect(t.texts()).toContain('En essai, rien ne part vers Google, même validé');
    expect(t.buttons('Envoyer sur Google')).toEqual([]);
    t.table['GET /v1/attirer/google/moi'] = ok(screenData({ reviewsWaiting: 0, reviews: [review({ draft: { ...x, state: 'note_essai' } })] }));
    await t.click(t.buttons('Noter l’envoi, sans rien faire partir')[0]);
    expect(t.state()).toBe('Envoi noté : en essai, rien n’est parti.');
    expect(t.texts()).toContain('En essai, rien n’est parti : l’envoi est seulement noté.');
    expect(t.allButtons().filter((b) => /valider|Noter|Envoyer|Enregistrer ce texte/.test(b))).toEqual([]);
  });

  it('en réel, le geste dit « Envoyer », et un échec se réessaie', async () => {
    const x = draft({ validatedAt: '2026-10-29T08:00:00.000Z', state: 'a_envoyer' });
    const t = await run({ 'GET /v1/attirer/google/moi': ok(screenData({ mode: 'reel', reviews: [review({ draft: x })] })), 'POST /v1/attirer/google/textes/d1/publier': no(400, { ok: false, rule: null, code: 'echec' }) });
    await t.ouvrir();
    expect(t.texts()).not.toContain('En essai');
    await t.click(t.buttons('Envoyer sur Google')[0]);
    expect(t.state()).toContain('Google n’a pas répondu');
    t.table['GET /v1/attirer/google/moi'] = ok(screenData({ mode: 'reel', reviews: [review({ draft: { ...x, state: 'echec' } })] }));
    t.table['POST /v1/attirer/google/textes/d1/publier'] = ok({ mode: 'reel' });
    await t.click(t.buttons('Envoyer sur Google')[0]);
    expect(t.state()).toBe('Parti sur Google.');
    expect(t.buttons('Réessayer l’envoi sur Google')).toHaveLength(1);
  });

  it.each([
    ['note_essai', 'En essai, rien n’est parti'],
    ['envoye', 'Parti sur Google.'],
    ['envoi_en_cours', 'Envoi en cours'],
    ['envoi_coupe', 'La direction regarde la fiche Google'],
    ['bien_retire', 'ne peut plus partir'],
    ['texte_a_revoir', 'changez le titre de l’annonce'],
  ])('l’état %s ne permet aucun geste à l’agent sur le texte', async (stateName, said) => {
    const t = await run({ 'GET /v1/attirer/google/moi': ok(screenData({ reviews: [], publications: [draft({ state: stateName, origin: 'code', linkUri: 'https://camille.exemple.test/biens/b1' })] })) });
    await t.ouvrir();
    expect(t.texts()).toContain(said);
    expect(t.allButtons().filter((b) => b !== 'Lire les nouveaux avis' && b !== 'Préparer la prochaine publication')).toEqual([]);
  });

  it('une publication : texte, lien, validation, jamais de correction à la main ; rien à préparer est dit', async () => {
    const t = await run({
      'GET /v1/attirer/google/moi': ok(screenData({ reviews: [], publications: [draft({ draftId: 'p1', origin: 'code', linkUri: 'https://camille.exemple.test/biens/b1' })] })),
      'POST /v1/attirer/google/agents/ag-1/publication': ok(null),
    });
    await t.ouvrir();
    expect(t.texts()).toContain('Lien : https://camille.exemple.test/biens/b1');
    expect(t.texts()).toContain('Écrit depuis l’annonce');
    expect(t.buttons('Je l’ai relu : valider')).toHaveLength(1);
    expect(t.buttons('Enregistrer ce texte')).toEqual([]);
    await t.click(t.buttons('Préparer la prochaine publication')[0]);
    expect(t.state()).toContain('Rien à préparer');
    t.table['POST /v1/attirer/google/agents/ag-1/publication'] = ok(draft());
    await t.click(t.buttons('Préparer la prochaine publication')[0]);
    expect(t.state()).toBe('Publication préparée : relisez-la, puis validez.');
  });

  it('chaque refus du métier est dit en français, jamais un code ; ce qui est périmé est relu', async () => {
    const codes = ['role', 'agent_inconnu', 'agent_parti', 'inconnu', 'non_valide', 'texte_change', 'deja_valide', 'deja_parti', 'bien_retire', 'deja_publie', 'trop_tot', 'sans_fiche', 'invalide', 'occupe', 'echec', 'sans_service'];
    for (const code of codes) {
      const t = await run({ 'GET /v1/attirer/google/moi': ok(screenData({ reviews: [review({ draft: draft() })] })), 'POST /v1/attirer/google/textes/d1/valider': no(409, { ok: false, rule: 'R154', code }) });
      await t.ouvrir();
      const reads = t.calls.filter((c) => c.url === '/v1/attirer/google/moi').length;
      await t.click(t.buttons('Je l’ai relu : valider')[0]);
      expect(t.state(), code).not.toBe('');
      expect(t.state(), code).not.toContain(code);
      expect(t.state(), code).not.toBe('Le texte n’est pas validé.');
      const again = t.calls.filter((c) => c.url === '/v1/attirer/google/moi').length;
      const stale = ['texte_change', 'deja_valide', 'deja_parti', 'bien_retire', 'inconnu', 'non_valide'].includes(code);
      expect(again, code).toBe(stale ? reads + 1 : reads);
    }
    // Un code inconnu : le texte de secours du geste.
    const t = await run({ 'GET /v1/attirer/google/moi': ok(screenData({ reviews: [review({ draft: draft() })] })), 'POST /v1/attirer/google/textes/d1/valider': no(500, { ok: false, code: 'autre' }) });
    await t.ouvrir();
    await t.click(t.buttons('Je l’ai relu : valider')[0]);
    expect(t.state()).toBe('Le texte n’est pas validé.');
  });

  it('hors réseau : rien n’est dit enregistré ; un refus à l’ouverture est dit sans plantage', async () => {
    const t = await run();
    await t.ouvrir();
    await t.click(t.buttons('Préparer une réponse')[0]);
    expect(t.state()).toBe('La réponse n’est pas arrivée : rien n’est sûr. Relisez avant de recommencer.');
    const u = await run({ 'GET /v1/attirer/google/moi': no(403, { ok: false, rule: 'R16', code: 'agent_parti' }) });
    await u.ouvrir();
    expect(u.state()).toBe('Cet agent n’est plus en activité.');
    expect(u.storage.get('aimmo.cle')).toBe(KEY);
    const w = await run({ 'GET /v1/attirer/google/moi': async () => Promise.reject(new TypeError('hors ligne')) });
    await w.ouvrir();
    expect(w.state()).toBe('Pas de réseau. Réessayez dans un moment.');
  });

  it('deux appuis rapides ne font qu’un geste', async () => {
    const t = await run({ 'GET /v1/attirer/google/moi': ok(screenData({ reviews: [review({ draft: draft() })] })), 'POST /v1/attirer/google/textes/d1/valider': ok(draft()) });
    await t.ouvrir();
    const b = t.buttons('Je l’ai relu : valider')[0]!;
    b.listeners.click!({});
    b.listeners.click!({});
    await settle();
    expect(t.posts()).toHaveLength(1);
  });

  it('tout texte reçu est posé comme du texte, jamais comme du code de page', async () => {
    const t = await run();
    await t.ouvrir();
    expect(t.texts()).toContain(INJECTED);
    expect(t.body().all().some((e) => e.tagName === 'img')).toBe(false);
    expect(FICHE_GOOGLE_SCRIPT).not.toContain('innerHTML');
  });

  it('le retour ramène l’agent à sa journée, et sortir efface ce que l’écran montrait', async () => {
    const t = await run();
    await t.ouvrir();
    expect(t.els['fiche-google-titre']!.textContent).toBe('Ma fiche Google');
    t.els['fiche-google-retour']!.listeners.click!({});
    await settle();
    expect(t.body().children).toEqual([]);
    expect(t.els['fiche-google']!.hidden).toBe(true);
    expect(t.els.accueil!.hidden).toBe(false);
    expect(t.els['fiche-google-titre']!.textContent).toBe('Fiche Google');
    await t.click(t.els['fiche-google-ouvrir']);
    expect(t.body().children.length).toBeGreaterThan(0);
    t.els.sortir!.listeners.click!({});
    await settle();
    expect(t.body().children).toEqual([]);
    expect(t.texts()).not.toContain('Très bon suivi');
  });

  describe('la direction, depuis l’écran « Attirer »', () => {
    const AGENTS = { holder: 'Société Exemple', cardNumber: 'CPI 9999', agents: [{ agentId: 'ag-1', name: 'Camille Essai', rsacNumber: '123456789', rsacRegistry: 'Dijon', missing: null, site: null }] };
    async function direction(answers: Record<string, Answer> = {}) {
      const t = await run({
        'GET /v1/reseau/mois': ok({}),
        'GET /v1/attirer/agents': ok(AGENTS),
        'GET /v1/attirer/google/agents/ag-1': ok(screenData({ canConfigure: true })),
        ...answers,
      }, 'direction');
      await t.click(t.els['attirer-ouvrir']);
      const s = t.els.attirer!.children.filter((e) => e.tagName === 'script');
      runInNewContext(ATTIRER_SCRIPT, t.context);
      s[0]!.listeners.load!({});
      await settle();
      const open = t.els['attirer-corps']!.all().find((e) => e.tagName === 'button' && e.textContent === 'Fiche Google de cet agent');
      await t.click(open);
      await t.load();
      return t;
    }

    it('[R16] elle ouvre la fiche d’un agent sans identifiant à saisir, et revient à « Attirer »', async () => {
      const t = await direction();
      expect(t.calls.some((c) => c.url === '/v1/attirer/google/agents/ag-1')).toBe(true);
      expect(t.calls.some((c) => c.url === '/v1/attirer/google/moi')).toBe(false);
      expect(t.els['fiche-google-titre']!.textContent).toBe('Fiche Google de Camille');
      expect(t.els['fiche-google']!.hidden).toBe(false);
      t.els['fiche-google-retour']!.listeners.click!({});
      await settle();
      expect(t.els.attirer!.hidden).toBe(false);
      expect(t.els['fiche-google']!.hidden).toBe(true);
      expect(t.body().children).toEqual([]);
    });

    it('elle règle la fiche ; un refus est dit en français', async () => {
      const t = await direction({ 'POST /v1/attirer/google/agents/ag-1/fiche': no(400, { ok: false, rule: null, code: 'invalide' }) });
      expect(t.input('Référence de la fiche chez Google (accounts/…/locations/…)').value).toBe('locations/42');
      t.input('Nom affiché sur la fiche').value = 'Camille Essai';
      t.input('Référence de la fiche chez Google (accounts/…/locations/…)').value = 'locations/43';
      await t.click(t.buttons('Enregistrer la fiche')[0]);
      expect(JSON.parse(t.posts()[0]!.body!)).toEqual({ title: 'Camille Essai', locationRef: 'locations/43', websiteUri: LOCATION.websiteUri });
      expect(t.state()).toContain('une référence accounts/…/locations/…');
      t.table['POST /v1/attirer/google/agents/ag-1/fiche'] = ok(null);
      await t.click(t.buttons('Enregistrer la fiche')[0]);
      expect(t.state()).toBe('Fiche enregistrée.');
      // Après l'écriture, c'est la fiche de cet agent qui est relue, pas celle de la clé.
      expect(t.calls.filter((c) => c.url === '/v1/attirer/google/agents/ag-1').length).toBeGreaterThan(1);
      expect(t.calls.some((c) => c.url === '/v1/attirer/google/moi')).toBe(false);
    });

    it('un envoi coupé se clôt en deux appuis espacés, après avertissement', async () => {
      const t = await direction({
        'GET /v1/attirer/google/agents/ag-1': ok(screenData({ canConfigure: true, reviews: [review({ draft: draft({ state: 'envoi_coupe', validatedAt: 'x' }) })] })),
        'POST /v1/attirer/google/textes/d1/liberer': ok(null),
      });
      const b = t.buttons('Clore cet envoi coupé')[0];
      await t.click(b);
      expect(t.state()).toContain('si le texte y est, ne le renvoyez pas');
      await t.click(b);
      expect(t.posts()).toEqual([]);
      clock += 2000;
      await t.click(b);
      expect(t.posts().map((c) => c.url)).toEqual(['/v1/attirer/google/textes/d1/liberer']);
      expect(t.state()).toBe('Envoi clos : le texte peut repartir.');
    });
  });

  it('[R201] l’écran est servi à part, jamais gardé sur l’appareil, et tient son budget', async () => {
    expect(AGENT_APP_FILES['/app/fiche-google.js']).toBe(FICHE_GOOGLE_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/fiche-google.js');
    const res = handleAgentApp(new Request('https://x.test/app/fiche-google.js'));
    expect(res?.status).toBe(200);
    expect(budgetProblems({ html: '', js: FICHE_GOOGLE_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, js: JS }, BUDGETS.application)).toEqual([]);
  });
});
