import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { MANDAT_MODELES_SCRIPT } from '../app/mandat-modeles.ts';
import { AGENT_APP_FILES, handleAgentApp } from '../src/agent-app.ts';
import { fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : clé, modèles, versions.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const INJECTED = '<img src=x onerror="alert(1)">';
const READ = 'GET /v1/modeles';
const POST = 'POST /v1/modeles';
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};
const v = (version: number, status: 'essai' | 'valide', body = `Texte ${version} ${INJECTED}`, kind = 'mandat_vente_simple') => ({ id: `m${version}`, kind, version, status, body, fields: [], hash: 'h', createdAt: '2027-07-01T08:00:00.000Z', validatedBy: null, validatedAt: status === 'valide' ? '2027-07-02T08:00:00.000Z' : null });

async function run(role: 'direction' | 'compliance', answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; body?: string }[] = [];
  const table: Record<string, Answer> = { 'GET /v1/moi': ok({ role, firstName: null }), ...answers };
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
  const store = (i = 0) => body().all().filter((e) => e.tagName === 'button' && e.textContent === 'Ranger une nouvelle version')[i];
  const posts = () => calls.filter((c) => c.method === 'POST');
  return { els, calls, table, body, say, byText, click, open, area, store, posts, scripts };
}

describe('D18 · modèles de mandat et d’avenant à l’écran', () => {
  it('[R201] servi à part, rien n’est lu avant le geste, budget tenu, application comprise', async () => {
    const t = await run('direction', { [READ]: ok([]) });
    expect(t.scripts()).toHaveLength(0);
    expect(t.calls.some((c) => c.url.includes('/v1/modeles'))).toBe(false);
    expect(budgetProblems({ html: '', js: MANDAT_MODELES_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    expect(JS).not.toContain('/v1/modeles');
    const served = handleAgentApp(new Request('https://aimmo.example.test/app/mandat-modeles.js'))!;
    expect(served.headers.get('content-type')).toContain('text/javascript');
    expect(await served.text()).toBe(MANDAT_MODELES_SCRIPT);
    await t.open();
    await t.open();
    expect(t.scripts()).toHaveLength(1);
    const text = t.body().textContent;
    expect(text).toContain('Mandat de vente simple');
    expect(text).toContain('Mandat de vente exclusif');
    expect(text).toContain('Avenant au mandat');
    expect(text).toContain('Aucun modèle : aucun document de cette sorte ne peut se préparer.');
    expect(text).toContain('{{registre.numero}} : numéro au registre');
  });

  it('[R40] un modèle sans sa place pour le numéro est refusé et dit en français, selon sa sorte', async () => {
    const refuse = no(400, { ok: false, rule: 'R40', code: 'no_number_field' });
    const t = await run('direction', { [READ]: ok([]), [POST]: refuse });
    await t.open();
    t.area(0)!.value = 'Mandat sans numéro';
    await t.click(t.store(0));
    expect(t.posts()[0]).toMatchObject({ url: '/v1/modeles', body: JSON.stringify({ kind: 'mandat_vente_simple', body: 'Mandat sans numéro' }) });
    expect(t.say()).toBe('Il manque le champ {{registre.numero}}, la place du numéro au registre : rien n’est rangé.');
    t.area(2)!.value = 'Avenant sans numéro';
    await t.click(t.store(2));
    expect(t.posts()[1]!.body).toBe(JSON.stringify({ kind: 'avenant_mandat', body: 'Avenant sans numéro' }));
    expect(t.say()).toBe('Il manque le champ {{mandat.numero}}, la place du numéro du mandat modifié : rien n’est rangé.');
  });

  it.each([
    ['unknown_field', 'Le modèle porte un champ entre accolades que le mandat ne connaît pas : rien n’est rangé.'],
    ['no_designation_field', 'Il manque la désignation : {{bien.adresse}}, {{bien.cadastre}} et {{mandant.domicile}} ont chacun leur place dans un mandat de vente. Rien n’est rangé.'],
    ['no_evidence', 'Un mandat exclusif met sa clause d’exclusivité en évidence : commencez son paragraphe par « !! » suivi d’une espace. Rien n’est rangé.'],
    ['body_too_long', 'Le modèle est trop long : rien n’est rangé.'],
    ['invalid_body', 'Le modèle est trop long ou illisible : rien n’est rangé.'],
    ['autre_chose', 'Le modèle n’est pas rangé.'],
  ])('[R40] le refus %s est dit en français, sans code', async (code, said) => {
    const t = await run('direction', { [READ]: ok([]), [POST]: no(400, { ok: false, rule: 'R40', code }) });
    await t.open();
    t.area(1)!.value = 'Un texte';
    await t.click(t.store(1));
    expect(t.say()).toBe(said);
    expect(t.area(1)!.value).toBe('Un texte');
  });

  it('[R17] la direction ajoute une version : l’ancienne reste, le document garde le dernier validé', async () => {
    const t = await run('direction', { [READ]: ok([v(1, 'valide', 'Ancien texte')]), [POST]: ok({ id: 'm2', version: 2, status: 'essai' }) });
    await t.open();
    expect(t.body().textContent).toContain('En vigueur. Version 1, validée le 02/07/2027.');
    expect(t.area(0)!.value).toBe('Ancien texte');
    await t.click(t.store(0));
    expect(t.say()).toBe('Le texte n’a pas changé : aucune version ajoutée.');
    expect(t.posts()).toHaveLength(0);
    t.area(0)!.value = 'Nouveau texte';
    t.table[READ] = ok([v(1, 'valide', 'Ancien texte'), v(2, 'essai', 'Nouveau texte')]);
    await t.click(t.store(0));
    expect(t.say()).toBe('Version 2 rangée, modèle d’essai. L’ancienne version reste.');
    const text = t.body().textContent;
    expect(text).toContain('En vigueur. Version 1, validée');
    expect(text).toContain('Ancien texte');
    expect(text).toContain('Dernière version rangée, pas en vigueur tant qu’elle n’est pas validée. Version 2, modèle d’essai');
    expect(t.area(0)!.value).toBe('Nouveau texte');
  });

  it('[R40] en vigueur comme au serveur : la dernière validée, sinon la dernière d’essai ; les plus anciennes sont dites gardées', async () => {
    const t = await run('direction', { [READ]: ok([v(3, 'essai', 'Trois'), v(1, 'valide', 'Un'), v(2, 'valide', 'Deux'), v(9, 'essai', 'Avenant', 'avenant_mandat'), v(8, 'essai', 'Avenant ancien', 'avenant_mandat')]) });
    await t.open();
    const text = t.body().textContent;
    expect(text).toContain('En vigueur. Version 2, validée');
    expect(text).toContain('Dernière version rangée, pas en vigueur tant qu’elle n’est pas validée. Version 3');
    expect(text).toContain('Une version plus ancienne est gardée.');
    expect(text).toContain('En vigueur. Version 9, modèle d’essai, pas validé : le document qu’il fait reste un document d’essai.');
    expect(text).not.toContain('Avenant ancien');
  });

  it('[R40] chaque sorte dit ses places et ses seuls champs ; une version que l’agent ne pourrait pas utiliser est signalée, sans bloquer', async () => {
    const full = { ...v(1, 'essai', 'Mandat complet'), fields: ['registre.numero', 'honoraires.montant', 'honoraires.charge', 'mandat.duree_mois', 'bien.adresse', 'bien.cadastre', 'mandant.domicile'] };
    const bare = { ...v(2, 'essai', 'Avenant nu', 'avenant_mandat'), fields: ['mandat.numero'] };
    const byObject = { ...v(3, 'essai', 'Avenant objet', 'avenant_mandat'), fields: ['mandat.numero', 'avenant.objet'] };
    const direction = await run('direction', { [READ]: ok([full, bare]) });
    await direction.open();
    const text = direction.body().textContent;
    expect(text).toContain('Places obligatoires : {{registre.numero}}, {{honoraires.montant}}, {{honoraires.charge}}, {{mandat.duree_mois}}, et la désignation : {{bien.adresse}}, {{bien.cadastre}} et {{mandant.domicile}}.');
    expect(text).toContain('Places obligatoires : {{mandat.numero}}, et {{avenant.objet}} ou bien {{avenant.prix}} avec {{avenant.duree_mois}}.');
    expect(text).not.toContain('Version 1 : il manque des places');
    expect(text).toContain('Version 2 : il manque des places, l’agent ne pourra pas préparer de document avec elle.');
    const blocks = direction.body().all().filter((e) => e.tagName === 'div' && e.className === 'vente');
    expect(blocks[0]!.textContent).not.toContain('{{avenant.prix}} :');
    expect(blocks[0]!.textContent).toContain('{{honoraires.montant}} :');
    expect(blocks[2]!.textContent).toContain('{{avenant.prix}} :');
    expect(blocks[2]!.textContent).not.toContain('{{honoraires.montant}} :');
    // La conformité le lit aussi avant de valider ; le geste reste offert : le serveur seul décide.
    const conformite = await run('compliance', { [READ]: ok([bare]) });
    await conformite.open();
    expect(conformite.body().textContent).toContain('Version 2 : il manque des places');
    expect(conformite.byText('Valider la version 2')).toBeDefined();
    const works = await run('compliance', { [READ]: ok([byObject]) });
    await works.open();
    expect(works.body().textContent).not.toContain('il manque des places');
  });

  it('tout texte reste du texte, jamais une balise', async () => {
    const t = await run('direction', { [READ]: ok([v(1, 'essai')]) });
    await t.open();
    expect(t.body().textContent).toContain(INJECTED);
    expect(t.body().all().some((e) => e.tagName === 'img')).toBe(false);
  });

  it('[R16] la direction n’a aucun bouton de validation ; un refus de droits est dit en clair', async () => {
    const t = await run('direction', { [READ]: ok([v(1, 'essai')]), [POST]: no(403, { ok: false, rule: 'R16', code: 'role' }) });
    await t.open();
    expect(t.body().all().some((e) => e.tagName === 'button' && /^Valider/.test(e.textContent ?? ''))).toBe(false);
    t.area(0)!.value = 'Autre texte';
    await t.click(t.store(0));
    expect(t.say()).toBe('Ce geste n’est pas dans vos droits.');
    const denied = await run('direction', { [READ]: no(403, { ok: false, rule: 'R16', code: 'role' }) });
    await denied.open();
    expect(denied.say()).toBe('Ce geste n’est pas dans vos droits.');
  });

  it('[R16] la conformité valide en deux appuis, sans formulaire ; ce qui est validé n’offre plus le geste', async () => {
    const t = await run('compliance', { [READ]: ok([v(1, 'essai')]), 'POST /v1/modeles/m1/validation': ok({ id: 'm1' }) });
    await t.open();
    expect(t.area()).toBeUndefined();
    expect(t.store()).toBeUndefined();
    await t.click(t.byText('Valider la version 1'));
    expect(t.posts()).toHaveLength(0);
    expect(t.say()).toBe('Appuyez encore pour valider la version 1.');
    t.table[READ] = ok([v(1, 'valide')]);
    await t.click(t.byText('Confirmer : texte relu par l’avocat'));
    expect(t.posts()).toHaveLength(1);
    expect(t.say()).toBe('Version 1 validée.');
    expect(t.byText('Valider la version 1')).toBeUndefined();
    expect(t.body().textContent).toContain('Version 1, validée le 02/07/2027.');
  });

  it('[R16] seule la dernière version d’essai s’offre à la validation ; un refus de droits est dit', async () => {
    const t = await run('compliance', { [READ]: ok([v(1, 'essai'), v(2, 'essai')]), 'POST /v1/modeles/m2/validation': no(403, { ok: false, rule: 'R16', code: 'role' }) });
    await t.open();
    expect(t.byText('Valider la version 1')).toBeUndefined();
    await t.click(t.byText('Valider la version 2'));
    await t.click(t.byText('Confirmer : texte relu par l’avocat'));
    expect(t.say()).toBe('Ce geste n’est pas dans vos droits.');
  });

  it('une version validée entre-temps ou disparue fait relire, sans bouton périmé', async () => {
    const t = await run('compliance', { [READ]: ok([v(1, 'essai')]), 'POST /v1/modeles/m1/validation': no(409, { ok: false, code: 'not_essai' }) });
    await t.open();
    await t.click(t.byText('Valider la version 1'));
    t.table[READ] = ok([v(1, 'valide')]);
    await t.click(t.byText('Confirmer : texte relu par l’avocat'));
    expect(t.say()).toBe('Cette version est déjà validée.');
    expect(t.byText('Confirmer : texte relu par l’avocat')).toBeUndefined();
  });

  it('une réponse perdue est dite telle, sans refaire le geste ; hors réseau au chargement aussi', async () => {
    const t = await run('direction', { [READ]: ok([v(1, 'essai')]) });
    await t.open();
    t.area(0)!.value = 'Autre texte';
    await t.click(t.store(0));
    expect(t.say()).toBe('Réponse perdue : ce geste est peut-être rangé. Relisez avant de recommencer.');
    expect(t.store(0)).toBeUndefined();
    expect(t.posts()).toHaveLength(1);
    await t.click(t.byText('Relire les modèles de mandat'));
    expect(t.store(0)).toBeDefined();
    const panne = await run('direction', { [READ]: ok([]), [POST]: no(500, { ok: false, code: 'internal' }) });
    await panne.open();
    panne.area(0)!.value = 'Un texte';
    await panne.click(panne.store(0));
    expect(panne.say()).toBe('Réponse perdue : ce geste est peut-être rangé. Relisez avant de recommencer.');
    const off = await run('direction');
    await off.open();
    expect(off.say()).toBe('Pas de réseau. Réessayez dans un moment.');
  });

  it('une liste illisible ou une panne ne se lit jamais comme « aucun modèle »', async () => {
    for (const answer of [ok({ pas: 'une liste' }), ok([{ kind: 'mandat_vente_simple' }]), no(500, { ok: false, code: 'internal' })]) {
      const t = await run('direction', { [READ]: answer });
      await t.open();
      expect(t.say()).toBe('Les modèles ne se lisent pas pour le moment.');
      expect(t.body().textContent).not.toContain('Aucun modèle');
      expect(t.store()).toBeUndefined();
    }
  });

  it('une réponse rangée sans son numéro de version reste dite, sans rester sur « Envoi… »', async () => {
    const t = await run('direction', { [READ]: ok([]), [POST]: ok(null) });
    await t.open();
    t.area(0)!.value = 'Un texte';
    await t.click(t.store(0));
    expect(t.say()).toBe('Version rangée, modèle d’essai.');
  });

  it('deux appuis sans attente : une seule lecture s’affiche, la dernière', async () => {
    const t = await run('direction', { [READ]: ok([]) });
    await t.open();
    t.els['mandat-modeles-ouvrir']!.listeners.click!({});
    t.els['mandat-modeles-ouvrir']!.listeners.click!({});
    await settle();
    expect(t.body().all().filter((e) => e.tagName === 'h4' && e.textContent === 'Avenant au mandat')).toHaveLength(1);
  });

  it('[R17] quitter pendant l’envoi ne laisse ni « Envoi… » ni formulaire : rien ne se range deux fois', async () => {
    let answer: (r: Response) => void = () => undefined;
    const t = await run('direction', { [READ]: ok([v(1, 'essai')]), [POST]: () => new Promise<Response>((r) => { answer = r; }) });
    await t.open();
    t.area(0)!.value = 'Autre texte';
    await t.click(t.store(0));
    expect(t.say()).toBe('Envoi…');
    await t.click(t.store(0));
    expect(t.posts()).toHaveLength(1);
    await t.click(t.els['reseau-precedent']);
    answer(Response.json({ ok: true, mode: 'essai', data: { version: 2 } }));
    await settle();
    expect(t.say()).toBe('');
    expect(t.area()).toBeUndefined();
  });

  it('[R16] après la sortie, les textes lus ne restent pas à l’écran', async () => {
    const t = await run('direction', { [READ]: ok([v(1, 'essai', 'Texte lu')]) });
    await t.open();
    expect(t.body().textContent).toContain('Texte lu');
    await t.click(t.els.sortir);
    expect(t.body().textContent).not.toContain('Texte lu');
  });
});
