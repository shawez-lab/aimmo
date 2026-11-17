import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { CLAUSES, CLAUSE_CODES } from '../../core/src/mandat-questionnaire/questionnaire.ts';
import { MANDAT_MODELES_SCRIPT } from '../app/mandat-modeles.ts';
import { AGENT_APP_FILES, handleAgentApp } from '../src/agent-app.ts';
import { fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : clé, clauses, versions, textes.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const INJECTED = '<img src=x onerror="alert(1)">';
const MODELS = 'GET /v1/modeles';
const READ = 'GET /v1/questionnaire-mandat/clauses';
const POST = 'POST /v1/questionnaire-mandat/clauses';
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};
const v = (version: number, status: 'essai' | 'valide', body = `Clause ${version} ${INJECTED}`, code = 'exclusivite', ownText = false) => ({ id: `c${code.length}v${version}`, code, title: 'ignoré', version, body, hash: 'h', createdAt: '2027-07-01T08:00:00.000Z', status, validatedAt: status === 'valide' ? '2027-07-02T08:00:00.000Z' : null, ownText });

async function run(role: 'direction' | 'compliance', answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; body?: string }[] = [];
  const table: Record<string, Answer> = { 'GET /v1/moi': ok({ role, firstName: null }), [MODELS]: ok([]), ...answers };
  const context: Record<string, unknown> = {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, x: string) => storage.set(k, x), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: string } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, ...(init.body === undefined ? {} : { body: init.body }) });
      const a = table[`${method} ${url}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    Intl,
    setTimeout: () => 0,
    crypto: globalThis.crypto,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const p = role === 'direction' ? 'mandat-modeles' : 'mandat-modeles-c';
  const body = () => els[`${p}-corps`]!;
  const say = () => els[`${p}-etat`]!.textContent;
  const byText = (text: string) => body().all().find((e) => e.tagName === 'button' && e.textContent === text);
  const click = async (b: { listeners: Record<string, (e: unknown) => void> } | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  const scripts = () => els.reseau!.children.filter((e) => e.tagName === 'script' && e.attributes.src === '/app/mandat-modeles.js');
  const open = async () => {
    await click(els[`${p}-ouvrir`]);
    const s = scripts()[0];
    if (s && !s.attributes['data-lu']) {
      s.attributes['data-lu'] = 'oui';
      runInNewContext(MANDAT_MODELES_SCRIPT, context);
      s.listeners.load!({});
      await settle();
    }
  };
  const area = (i = 0) => body().all().filter((e) => e.tagName === 'textarea')[i];
  const store = (i = 0) => body().all().filter((e) => e.tagName === 'button' && e.textContent === 'Ranger ce texte de clause')[i];
  const clauseArea = (code: string) => body().all().find((e) => e.tagName === 'textarea' && e.attributes.id === `mandat-clause-${code}`);
  const said = () => body().all().find((e) => e.tagName === 'p' && e.attributes.role === 'status')?.textContent;
  const posts = () => calls.filter((c) => c.method === 'POST');
  return { els, calls, table, body, say, said, byText, click, open, area, clauseArea, store, posts, scripts };
}

const role403 = no(403, { ok: false, rule: 'R16', code: 'role' });

describe('BR118 · textes des clauses du mandat par questionnaire à l’écran', () => {
  it('[R201] dans le script déjà servi à part : rien dans l’application, rien lu avant le geste, budgets tenus', async () => {
    const t = await run('direction', { [READ]: ok([]) });
    expect(JS).not.toContain('/v1/questionnaire-mandat/clauses');
    expect(MANDAT_MODELES_SCRIPT).toContain('/v1/questionnaire-mandat/clauses');
    expect(t.calls.some((c) => c.url.includes('/questionnaire-mandat'))).toBe(false);
    expect(budgetProblems({ html: '', js: MANDAT_MODELES_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    await t.open();
    expect(t.scripts()).toHaveLength(1);
    expect(t.calls.filter((c) => c.url === '/v1/questionnaire-mandat/clauses')).toHaveLength(1);
  });

  it('[R440] chaque clause dit la réponse qui la fait entrer et son texte de loi ; sans texte, elle ne passe jamais pour validée', async () => {
    const t = await run('direction', { [READ]: ok([]) });
    await t.open();
    const text = t.body().textContent;
    for (const code of CLAUSE_CODES) {
      expect(text).toContain(CLAUSES[code].title);
      expect(text).toContain(CLAUSES[code].basis);
    }
    expect(text).toContain('Entre au mandat quand : Où le mandat est-il signé ? → hors de l’agence (domicile du vendeur) ; ou Où le mandat est-il signé ? → à distance.');
    expect(text).toContain('Mise en évidence dans le mandat.');
    expect(text.split('Pas encore de texte : un mandat qui appelle cette clause ne peut pas être signé.')).toHaveLength(CLAUSE_CODES.length + 1);
    expect(text).not.toContain('validée le');
  });

  it('[R442] en vigueur comme au serveur : la dernière validée, sinon la dernière d’essai ; la dernière rangée est dite à part', async () => {
    const t = await run('direction', { [READ]: ok([v(3, 'essai', 'Trois'), v(2, 'valide', 'Deux'), v(1, 'valide', 'Un'), v(1, 'essai', 'Seule', 'bien_loue')]) });
    await t.open();
    const text = t.body().textContent;
    expect(text).toContain('En vigueur. Version 2, validée le 02/07/2027.');
    expect(text).toContain('Dernière version rangée, pas en vigueur tant qu’elle n’est pas validée. Version 3, texte d’essai');
    expect(text).toContain('Une version plus ancienne est gardée.');
    expect(text).toContain('En vigueur. Version 1, texte d’essai, pas validé : le mandat qui l’appelle reste un document d’essai.');
    expect(t.clauseArea('exclusivite')!.value).toBe('Trois');
    expect(t.clauseArea('bien_loue')!.value).toBe('Seule');
    expect(t.clauseArea('copropriete')!.value).toBe('');
  });

  it('[R443] la direction range une nouvelle version, l’ancienne reste ; vide ou inchangé : rien ne part', async () => {
    const t = await run('direction', { [READ]: ok([v(1, 'valide', 'Ancien')]), [POST]: ok({ id: 'c11v2', version: 2 }) });
    await t.open();
    const area = t.clauseArea('exclusivite')!;
    const button = t.store(CLAUSE_CODES.indexOf('exclusivite'));
    area.value = '   ';
    await t.click(button);
    expect(t.said()).toBe('Le texte est vide : rien n’est rangé.');
    area.value = ' Ancien ';
    await t.click(button);
    expect(t.said()).toBe('Le texte n’a pas changé : aucune version ajoutée.');
    expect(t.posts()).toHaveLength(0);
    t.table[READ] = ok([v(2, 'essai', 'Nouveau'), v(1, 'valide', 'Ancien')]);
    area.value = ' Nouveau ';
    await t.click(button);
    expect(t.posts()).toEqual([{ method: 'POST', url: '/v1/questionnaire-mandat/clauses', body: JSON.stringify({ code: 'exclusivite', body: 'Nouveau' }) }]);
    expect(t.said()).toBe('Clause « Exclusivité » : version 2 rangée, texte d’essai. L’ancienne version reste.');
    expect(t.body().textContent).toContain('En vigueur. Version 1, validée le 02/07/2027.');
    expect(t.body().textContent).toContain('Version 2, texte d’essai');
  });

  it('[R40] les refus du serveur sont dits en français, rien n’est relu', async () => {
    for (const [code, said] of [
      ['field_in_clause', 'Une clause ne se remplit pas : retirez les doubles accolades. Rien n’est rangé.'],
      ['body_too_long', 'Le texte dépasse 5 000 caractères : rien n’est rangé.'],
      ['autre_chose', 'Le texte n’est pas rangé.'],
    ] as const) {
      const t = await run('direction', { [READ]: ok([]), [POST]: no(400, { ok: false, rule: null, code }) });
      await t.open();
      t.clauseArea('copropriete')!.value = 'Lot {{lot}}';
      await t.click(t.store(CLAUSE_CODES.indexOf('copropriete')));
      expect(t.said()).toBe(said);
      expect(t.clauseArea('copropriete')!.value).toBe('Lot {{lot}}');
    }
  });

  it('[R16] la direction n’a aucun bouton de validation ; un refus de droits est dit en clair', async () => {
    const t = await run('direction', { [READ]: ok([v(1, 'essai')]), [POST]: role403 });
    await t.open();
    expect(t.body().all().some((e) => e.tagName === 'button' && /^Valider/.test(e.textContent ?? ''))).toBe(false);
    t.clauseArea('exclusivite')!.value = 'Autre';
    await t.click(t.store(CLAUSE_CODES.indexOf('exclusivite')));
    expect(t.said()).toBe('Ce geste n’est pas dans vos droits.');
    const denied = await run('direction', { [READ]: role403 });
    await denied.open();
    expect(denied.said()).toBe('Ce geste n’est pas dans vos droits.');
    expect(denied.store()).toBeUndefined();
  });

  it('[R442] la conformité valide en deux appuis la seule dernière version d’essai, sans formulaire', async () => {
    const t = await run('compliance', { [READ]: ok([v(2, 'essai', 'Deux'), v(1, 'essai', 'Un')]), 'POST /v1/questionnaire-mandat/clauses/c11v2/validation': ok(null) });
    await t.open();
    expect(t.body().all().some((e) => e.tagName === 'textarea')).toBe(false);
    expect(t.store()).toBeUndefined();
    expect(t.byText('Valider la version 1')).toBeUndefined();
    await t.click(t.byText('Valider la version 2'));
    expect(t.posts()).toHaveLength(0);
    expect(t.said()).toBe('Appuyez encore pour valider la version 2 de la clause « Exclusivité ».');
    t.table[READ] = ok([v(2, 'valide', 'Deux'), v(1, 'essai', 'Un')]);
    await t.click(t.byText('Confirmer : texte relu par l’avocat'));
    expect(t.posts()).toEqual([{ method: 'POST', url: '/v1/questionnaire-mandat/clauses/c11v2/validation', body: '{}' }]);
    expect(t.said()).toBe('Clause « Exclusivité » : version 2 validée.');
    expect(t.body().all().some((e) => e.tagName === 'button' && /^(Valider|Confirmer)/.test(e.textContent ?? ''))).toBe(false);
    expect(t.body().textContent).toContain('En vigueur. Version 2, validée le 02/07/2027.');
  });

  it('[R442] jamais un texte qu’elle a écrit : aucun bouton, et le refus du serveur est dit', async () => {
    const t = await run('compliance', { [READ]: ok([v(1, 'essai', 'Le mien', 'exclusivite', true)]) });
    await t.open();
    expect(t.byText('Valider la version 1')).toBeUndefined();
    expect(t.body().textContent).toContain('Vous avez écrit la version 1 : une autre personne de la conformité la valide.');
    const late = await run('compliance', { [READ]: ok([v(1, 'essai')]), 'POST /v1/questionnaire-mandat/clauses/c11v1/validation': no(403, { ok: false, rule: 'R16', code: 'own_clause' }) });
    await late.open();
    await late.click(late.byText('Valider la version 1'));
    await late.click(late.byText('Confirmer : texte relu par l’avocat'));
    expect(late.said()).toBe('Vous avez écrit ce texte : une autre personne de la conformité le valide.');
  });

  it('une version validée entre-temps ou disparue fait relire, sans bouton périmé', async () => {
    for (const [status, code, said] of [[409, 'already_validated', 'Ce texte est déjà validé.'], [404, 'unknown_clause', 'Ce texte n’existe plus : clauses relues.']] as const) {
      const t = await run('compliance', { [READ]: ok([v(1, 'essai')]), 'POST /v1/questionnaire-mandat/clauses/c11v1/validation': no(status, { ok: false, rule: 'R442', code }) });
      await t.open();
      await t.click(t.byText('Valider la version 1'));
      t.table[READ] = ok([v(1, 'valide')]);
      await t.click(t.byText('Confirmer : texte relu par l’avocat'));
      expect(t.said()).toBe(said);
      expect(t.byText('Confirmer : texte relu par l’avocat')).toBeUndefined();
    }
  });

  it('une réponse perdue est dite telle, sans refaire le geste ; hors réseau au chargement aussi', async () => {
    const t = await run('direction', { [READ]: ok([v(1, 'essai')]), [POST]: no(500, { ok: false, code: 'internal' }) });
    await t.open();
    t.clauseArea('exclusivite')!.value = 'Autre';
    await t.click(t.store(CLAUSE_CODES.indexOf('exclusivite')));
    expect(t.said()).toBe('Réponse perdue : ce geste est peut-être rangé. Relisez avant de recommencer.');
    expect(t.store()).toBeUndefined();
    expect(t.posts()).toHaveLength(1);
    await t.click(t.byText('Relire les clauses'));
    expect(t.store()).toBeDefined();
    const off = await run('direction', { [READ]: () => Promise.reject(new TypeError('hors ligne')) });
    await off.open();
    expect(off.said()).toBe('Pas de réseau. Réessayez dans un moment.');
  });

  it('une liste illisible ou une panne ne se lit jamais comme « pas encore de texte »', async () => {
    for (const answer of [ok({ pas: 'une liste' }), ok([{ code: 'exclusivite' }]), no(500, { ok: false, code: 'internal' })]) {
      const t = await run('direction', { [READ]: answer });
      await t.open();
      expect(t.said()).toBe('Les clauses ne se lisent pas pour le moment.');
      expect(t.body().textContent).not.toContain('Pas encore de texte');
      expect(t.store()).toBeUndefined();
    }
  });

  it('les clauses se lisent même quand les modèles ne se lisent pas, chacune avec son état', async () => {
    const t = await run('direction', { [MODELS]: no(500, { ok: false, code: 'internal' }), [READ]: ok([]) });
    await t.open();
    expect(t.say()).toBe('Les modèles ne se lisent pas pour le moment.');
    expect(t.said()).toBe('');
    expect(t.store(0)).toBeDefined();
  });

  it('[R13] tout texte reste du texte ; l’adresse ne porte qu’un identifiant ; rien ne reste après la sortie', async () => {
    const t = await run('compliance', { [READ]: ok([v(1, 'essai', `Texte lu ${INJECTED}`)]) });
    await t.open();
    expect(t.body().all().some((e) => e.tagName === 'img')).toBe(false);
    expect(t.body().textContent).toContain(INJECTED);
    const bad = await run('compliance', { [READ]: ok([{ ...v(1, 'essai'), id: '../x?y' }]) });
    await bad.open();
    expect(bad.byText('Valider la version 1')).toBeUndefined();
    await t.click(t.els.sortir);
    expect(t.body().textContent).not.toContain('Texte lu');
  });

  it('[R17] quitter pendant l’envoi : rien ne reste, rien ne se range deux fois', async () => {
    let answer: (r: Response) => void = () => undefined;
    const t = await run('direction', { [READ]: ok([v(1, 'essai')]), [POST]: () => new Promise<Response>((r) => { answer = r; }) });
    await t.open();
    t.clauseArea('exclusivite')!.value = 'Autre';
    await t.click(t.store(CLAUSE_CODES.indexOf('exclusivite')));
    expect(t.said()).toBe('Envoi…');
    await t.click(t.store(CLAUSE_CODES.indexOf('exclusivite')));
    expect(t.posts()).toHaveLength(1);
    await t.click(t.els['reseau-precedent']);
    answer(Response.json({ ok: true, mode: 'essai', data: { version: 2 } }));
    await settle();
    expect(t.area()).toBeUndefined();
    expect(t.body().textContent).toBe('');
  });
});
