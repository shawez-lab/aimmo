import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { AUTOMATION_TRIGGERS } from '../../core/src/automatismes/scenarios.ts';
import { ENGAGEMENTS_SCRIPT } from '../app/engagements.ts';
import { SCENARIOS_LOST, SCENARIOS_OFFLINE, SCENARIOS_SCRIPT, SCENARIO_PROJECT_LABELS, SCENARIO_TRIGGER_LABELS } from '../app/scenarios.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { DATE_REFUSALS, SCENARIO_REFUSALS } from '../src/scenarios.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : clé de test, scénarios, textes, dates.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const INJECTED = '<img src=x onerror="alert(1)">';
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const cut: Answer = () => Promise.reject(new TypeError('coupé'));

const DEF = { name: 'Merci après la visite', trigger: 'visite_faite', projectKind: null, waitHours: 24, message: { channel: 'sms', text: 'Bonjour {prenom}, merci pour la visite.' }, task: null };
const SIM = { simulationId: 'sim1', at: '2027-03-10T08:00:00.000Z', from: '2027-02-08T08:00:00.000Z', to: '2027-03-10T08:00:00.000Z', messages: 12, persons: 11, tasks: 0, refused: { R05: 2 }, sameDayTwice: 0, canSwitchOn: true };
const scenario = (extra: Record<string, unknown> = {}) => ({ scenarioId: 'sc1', version: 2, definition: DEF, composedAt: '2027-03-09T08:00:00.000Z', litVersion: null, litSince: null, lastSimulation: SIM, ...extra });

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const page = document as typeof document & { body: FakeElement };
  page.body = new FakeElement('body');
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; body: unknown; auth: string | undefined }[] = [];
  const table: Record<string, Answer> = {
    'GET /v1/moi': ok({ role: 'direction', firstName: null }),
    'GET /v1/gagner/engagements': ok([]),
    'GET /v1/scenarios': ok([scenario()]),
    ...answers,
  };
  const context: Record<string, unknown> = {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, body: typeof init.body === 'string' ? JSON.parse(init.body) : null, auth: init.headers?.authorization });
      const a = table[`${method} ${url}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    Intl,
    Date,
    crypto: globalThis.crypto,
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const corps = () => els['engagements-corps']!;
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  const scriptsOf = (root: FakeElement, src: string) => [root, ...root.all()].filter((e) => e.tagName === 'script' && e.attributes.src === src);
  await click(els['engagements-voir']);
  runInNewContext(ENGAGEMENTS_SCRIPT, context);
  scriptsOf(els.reseau!, '/app/engagements.js')[0]!.listeners.load!({});
  await settle();
  const part = () => corps().children.find((e) => e.tagName === 'section' && e.children[0]!.textContent === 'Scénarios automatiques')!;
  const button = (text: string) => part().all().find((e) => e.tagName === 'button' && e.textContent === text);
  const buttons = () => part().all().filter((e) => e.tagName === 'button').map((e) => e.textContent);
  const status = () => part().all().find((e) => e.attributes.role === 'status')?.textContent ?? '';
  const texts = () => part().textContent;
  const input = (id: string) => part().all().find((e) => e.attributes.id === id)!;
  const callsBefore = calls.length;
  const open = async (load = true) => {
    await click(button('Ouvrir les scénarios'));
    const s = scriptsOf(part(), '/app/scenarios.js');
    if (load && s.length === 1 && !context.loaded) {
      runInNewContext(SCENARIOS_SCRIPT, context);
      context.loaded = true;
      s[0]!.listeners.load!({});
      await settle();
    }
  };
  const posts = () => calls.filter((c) => c.method === 'POST');
  /** Remplit le formulaire « Composer un scénario ». */
  const fill = (v: Record<string, string>) => {
    for (const [k, value] of Object.entries(v)) {
      const f = input(`scenario-nouveau-${k}`);
      f.value = value;
      f.listeners.change?.({});
    }
  };
  return { els, calls, table, context, part, button, buttons, status, texts, input, click, open, posts, fill, scriptsOf, callsBefore };
}

describe('BR57 · l’écran « Scénarios » de la direction', () => {
  it('[R201] servi à part, chargé au seul geste depuis « Engagements de service », jamais gardé ; le budget tient, sans innerHTML', async () => {
    expect(AGENT_APP_FILES['/app/scenarios.js']).toBe(SCENARIOS_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/scenarios.js');
    const served = handleAgentApp(new Request('https://x.test/app/scenarios.js'))!;
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toContain('text/javascript');
    expect(budgetProblems({ html: '', js: SCENARIOS_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: '', js: ENGAGEMENTS_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    // L'application ne change pas : ni la route, ni le script.
    expect(JS).not.toContain('/v1/scenarios');
    expect(JS).not.toContain('/app/scenarios.js');
    expect(SCENARIOS_SCRIPT).not.toContain('innerHTML');
    const t = await run();
    expect(t.part()).toBeDefined();
    expect(t.scriptsOf(t.part(), '/app/scenarios.js')).toHaveLength(0);
    expect(t.calls.some((c) => c.url.startsWith('/v1/scenarios'))).toBe(false);
    await t.open();
    expect(t.texts()).toContain('Merci après la visite');
    // Un second geste ne recharge pas le script : il relit la liste.
    await t.open(false);
    expect(t.scriptsOf(t.part(), '/app/scenarios.js')).toHaveLength(1);
    expect(t.calls.filter((c) => c.url === '/v1/scenarios')).toHaveLength(2);
    // La clé ne part que dans l'en-tête ; l'écran ne lit et n'écrit que /v1/scenarios.
    expect(t.calls.slice(t.callsBefore).every((c) => c.url.startsWith('/v1/scenarios') && c.auth === `Bearer ${KEY}`)).toBe(true);
  });

  it('sans réseau au chargement du script, ou script sans écran : c’est dit, et le bouton revient', async () => {
    const t = await run();
    await t.open(false);
    t.scriptsOf(t.part(), '/app/scenarios.js')[0]!.listeners.error!({});
    await settle();
    expect(t.texts()).toContain('Pas de réseau. Réessayez dans un moment.');
    expect((t.button('Ouvrir les scénarios') as unknown as { disabled: boolean }).disabled).toBe(false);
    const u = await run();
    await u.open(false);
    u.scriptsOf(u.part(), '/app/scenarios.js')[0]!.listeners.load!({});
    await settle();
    expect(u.texts()).toContain('Indisponible pour le moment. Réessayez dans un moment.');
  });

  it('[R403] les quatre déclencheurs proposés ; le type de projet seulement pour un nouveau projet', async () => {
    const t = await run({ 'GET /v1/scenarios': ok([]) });
    await t.open();
    expect(t.texts()).toContain('Aucun scénario');
    const trigger = t.input('scenario-nouveau-declencheur');
    const options = trigger.children.map((o) => o.attributes.value ?? (o as unknown as { value: string }).value).filter((v) => v);
    expect(options).toEqual([...AUTOMATION_TRIGGERS]);
    const labels = trigger.children.map((o) => o.textContent);
    expect(labels).toContain('Après chaque visite faite');
    expect(labels).toContain('Après chaque mandat signé');
    for (const k of AUTOMATION_TRIGGERS) expect(labels).toContain(SCENARIO_TRIGGER_LABELS[k]);
    // Sans déclencheur, ou un autre que « nouveau projet » : aucun type de projet proposé.
    expect(t.part().all().some((e) => e.attributes.id === 'scenario-nouveau-type')).toBe(false);
    t.fill({ declencheur: 'visite_faite' });
    expect(t.part().all().some((e) => e.attributes.id === 'scenario-nouveau-type')).toBe(false);
    t.fill({ declencheur: 'nouveau_projet' });
    const kind = t.input('scenario-nouveau-type');
    expect(kind.children.map((o) => o.textContent)).toEqual(['Tous les types de projet', ...Object.values(SCENARIO_PROJECT_LABELS)]);
    kind.value = 'sell';
    // Revenu à « mandat signé », le type choisi ne part pas.
    t.fill({ declencheur: 'mandat_signe', nom: 'Bienvenue au vendeur', attente: '48', canal: 'email', texte: 'Bonjour {prenom}, bienvenue.' });
    expect(t.part().all().some((e) => e.attributes.id === 'scenario-nouveau-type')).toBe(false);
    t.table['POST /v1/scenarios'] = ok({ scenarioId: 'sc9', version: 1 });
    await t.click(t.button('Ranger ce scénario'));
    expect(t.posts()).toHaveLength(1);
    expect(t.posts()[0]!.body).toEqual({ name: 'Bienvenue au vendeur', trigger: 'mandat_signe', projectKind: null, waitHours: 48, message: { channel: 'email', text: 'Bonjour {prenom}, bienvenue.' }, task: null });
    expect(t.status()).toContain('Version rangée');
    // Un nouveau projet de vente, avec une tâche et sans message.
    t.fill({ declencheur: 'nouveau_projet', nom: 'Appel du vendeur', attente: '0', canal: '', texte: '', tache: 'Appeler le vendeur', delai: '2' });
    t.input('scenario-nouveau-type').value = 'sell';
    await t.click(t.button('Ranger ce scénario'));
    expect(t.posts()[1]!.body).toEqual({ name: 'Appel du vendeur', trigger: 'nouveau_projet', projectKind: 'sell', waitHours: 0, message: null, task: { title: 'Appeler le vendeur', dueInDays: 2 } });
  });

  it('une saisie illisible ne part pas, et dit pourquoi en mots ; le serveur refait tout', async () => {
    const t = await run({ 'GET /v1/scenarios': ok([]) });
    await t.open();
    const press = () => t.click(t.button('Ranger ce scénario'));
    await press();
    expect(t.status()).toBe(SCENARIO_REFUSALS['bad_name']);
    t.fill({ nom: 'Relance' });
    await press();
    expect(t.status()).toBe(SCENARIO_REFUSALS['bad_trigger']);
    t.fill({ declencheur: 'nouveau_contact', attente: 'deux' });
    await press();
    expect(t.status()).toBe(SCENARIO_REFUSALS['bad_wait']);
    t.fill({ attente: '99999' });
    await press();
    expect(t.status()).toBe(SCENARIO_REFUSALS['bad_wait']);
    t.fill({ attente: '2' });
    await press();
    expect(t.status()).toBe(SCENARIO_REFUSALS['empty_scenario']);
    t.fill({ canal: 'sms', texte: 'Bonjour, merci.' });
    await press();
    expect(t.status()).toBe(SCENARIO_REFUSALS['first_name_slot']);
    t.fill({ canal: '', texte: '', tache: 'Rappeler', delai: '45' });
    await press();
    expect(t.status()).toBe(SCENARIO_REFUSALS['bad_task_due']);
    expect(t.posts()).toHaveLength(0);
  });

  it('[R400] « Allumer » seulement sur un essai de la version affichée, valable selon le serveur ; l’essai dit ses chiffres sans rien envoyer', async () => {
    // Pas d'essai : on essaie d'abord, aucun bouton « Allumer ».
    const t = await run({ 'GET /v1/scenarios': ok([scenario({ lastSimulation: null })]) });
    await t.open();
    expect(t.texts()).toContain('Pas encore essayée');
    expect(t.buttons().some((b) => b.startsWith('Allumer'))).toBe(false);
    // L'essai : la liste relue porte l'essai de la version affichée, et « Allumer » paraît.
    t.table['POST /v1/scenarios/sc1/essai'] = ok({ ...SIM, scenarioId: 'sc1', version: 2, sameDayAsDate: 0 });
    t.table['GET /v1/scenarios'] = ok([scenario()]);
    await t.click(t.button('Essayer sur le mois passé'));
    expect(t.posts().map((c) => c.url)).toEqual(['/v1/scenarios/sc1/essai']);
    expect(t.status()).toContain('Essai fait : 12 messages et 0 tâche sur le mois passé, rien n’est parti.');
    expect(t.texts()).toContain('12 messages auraient été envoyés, à 11 personnes, et 0 tâche créée. Rien n’est parti.');
    expect(t.texts()).toContain('2 messages auraient été refusés par le contrôle des envois, règle R05.');
    t.table['POST /v1/scenarios/sc1/allumer'] = ok({ version: 2 });
    t.table['GET /v1/scenarios'] = ok([scenario({ litVersion: 2, litSince: '2027-03-10T09:00:00.000Z' })]);
    await t.click(t.button('Allumer la version 2'));
    expect(t.posts().map((c) => c.url)).toEqual(['/v1/scenarios/sc1/essai', '/v1/scenarios/sc1/allumer']);
    expect(t.status()).toContain('Scénario allumé');
    expect(t.buttons().some((b) => b.startsWith('Allumer'))).toBe(false);
    // Un essai que le serveur ne dit plus valable (trop ancien, double du même jour) : pas de bouton.
    for (const sim of [{ ...SIM, canSwitchOn: false }, { ...SIM, canSwitchOn: false, sameDayTwice: 3 }, { ...SIM, canSwitchOn: 'true' }]) {
      const u = await run({ 'GET /v1/scenarios': ok([scenario({ lastSimulation: sim })]) });
      await u.open();
      expect(u.buttons().some((b) => b.startsWith('Allumer'))).toBe(false);
      expect(u.texts()).toContain('Cet essai ne permet pas d’allumer');
    }
    const v = await run({ 'GET /v1/scenarios': ok([scenario({ lastSimulation: { ...SIM, canSwitchOn: false, sameDayTwice: 3 } })]) });
    await v.open();
    expect(v.texts()).toContain('3 messages seraient tombés le même jour qu’un autre message automatique à la même personne');
    // Allumé en version 1, la version 2 affichée sans essai : pas d'« Allumer », l'écran dit l'écart.
    const w = await run({ 'GET /v1/scenarios': ok([scenario({ litVersion: 1, litSince: '2027-03-01T09:00:00.000Z', lastSimulation: null })]) });
    await w.open();
    expect(w.texts()).toContain('Allumé en version 1');
    expect(w.texts()).toContain('la version 2 affichée n’est pas allumée');
    expect(w.buttons().some((b) => b.startsWith('Allumer'))).toBe(false);
  });

  it('[R401] éteindre demande deux appuis, puis dit les passages annulés', async () => {
    const t = await run({ 'GET /v1/scenarios': ok([scenario({ litVersion: 2, litSince: '2027-03-10T09:00:00.000Z' })]), 'POST /v1/scenarios/sc1/eteindre': ok({ cancelled: 3 }) });
    await t.open();
    await t.click(t.button('Éteindre'));
    expect(t.posts()).toHaveLength(0);
    await t.click(t.button('Confirmer : éteindre et annuler ses passages en attente'));
    expect(t.posts().map((c) => c.url)).toEqual(['/v1/scenarios/sc1/eteindre']);
    expect(t.status()).toContain('3 passages en attente annulés, rien n’est effacé.');
  });

  it('[R16] chaque refus dit en mots, jamais son code ; un code inconnu a un texte de secours', async () => {
    const t = await run({ 'GET /v1/scenarios': no(403, { ok: false, rule: 'R16', code: 'not_direction' }) });
    await t.open();
    expect(t.status()).toBe(SCENARIO_REFUSALS['not_direction']);
    for (const [code, words] of Object.entries(SCENARIO_REFUSALS)) {
      const u = await run({ 'POST /v1/scenarios/sc1/allumer': no(409, { ok: false, rule: 'R400', code }) });
      await u.open();
      await u.click(u.button('Allumer la version 2'));
      expect(u.status()).toBe(words);
      expect(u.status()).not.toContain(code);
    }
    // Un contrôle du texte : les mots du serveur ; un code inconnu sans mots : le texte de secours.
    const v = await run({ 'POST /v1/scenarios/sc1': no(409, { ok: false, rule: 'R07', code: 'text_R07', message: 'On écrit « offert », jamais « gratuit ».' }) });
    await v.open();
    const details = v.part().all().find((e) => e.tagName === 'details' && e.children[0]!.textContent === 'Composer une nouvelle version')!;
    await v.click(details.all().find((e) => e.tagName === 'button' && e.textContent === 'Ranger cette version'));
    expect(v.posts()[0]!.body).toEqual(DEF);
    expect(v.status()).toBe('On écrit « offert », jamais « gratuit ».');
    const w = await run({ 'POST /v1/scenarios/sc1/essai': no(400, { ok: false, rule: null, code: 'inconnu_xyz' }) });
    await w.open();
    await w.click(w.button('Refaire l’essai sur le mois passé'));
    expect(w.status()).toBe('L’essai n’a pas pu se faire.');
  });

  it('une réponse perdue ou une panne du serveur est dite incertaine, jamais faite ni pas faite', async () => {
    for (const answer of [cut, no(502, { ok: false, code: 'internal' })]) {
      const t = await run({ 'POST /v1/scenarios/sc1/allumer': answer, 'POST /v1/scenarios/sc1/essai': answer });
      await t.open();
      await t.click(t.button('Allumer la version 2'));
      expect(t.status()).toBe(SCENARIOS_LOST);
      await t.click(t.button('Refaire l’essai sur le mois passé'));
      expect(t.status()).toBe(SCENARIOS_LOST);
    }
    const u = await run({ 'GET /v1/scenarios': cut });
    await u.open();
    expect(u.status()).toBe('Pas de réseau. Réessayez dans un moment.');
  });

  it('tout texte reçu est posé en texte ; une seule écriture à la fois', async () => {
    const evil = { ...DEF, name: INJECTED, message: { channel: 'whatsapp', text: `Bonjour {prenom} ${INJECTED}` }, task: { title: INJECTED, dueInDays: 1 } };
    let release: () => void = () => undefined;
    const slow: Answer = () => new Promise<Response>((r) => (release = () => r(Response.json({ ok: true, mode: 'essai', data: { ...SIM, version: 2 } }))));
    const t = await run({ 'GET /v1/scenarios': ok([scenario({ definition: evil })]), 'POST /v1/scenarios/sc1/essai': slow });
    await t.open();
    const strong = t.part().all().find((e) => e.tagName === 'strong')!;
    expect(strong.textContent).toBe(INJECTED);
    expect(strong.children).toEqual([]);
    expect(t.part().all().some((e) => e.tagName === 'img')).toBe(false);
    expect(t.texts()).toContain(`Bonjour {prenom} ${INJECTED}`);
    expect(t.texts()).toContain(`Tâche pour l’agent : ${INJECTED}, sous 1 jour.`);
    await t.click(t.button('Refaire l’essai sur le mois passé'));
    await t.click(t.button('Refaire l’essai sur le mois passé'));
    await t.click(t.button('Allumer la version 2'));
    expect(t.posts()).toHaveLength(1);
    release();
    await settle();
    expect(t.status()).toContain('Essai fait');
  });

  it('en sortant, rien ne reste', async () => {
    const t = await run();
    await t.open();
    expect(t.texts()).toContain('Merci après la visite');
    t.els.sortir!.listeners.click!({});
    await settle();
    expect(t.els['engagements-corps']!.children).toEqual([]);
  });
});

describe('BR58 · les textes des messages de date, chez la direction', () => {
  const TEXTS = '/v1/dates-clients/textes';
  const setUp = async (answers: Record<string, Answer> = {}) => {
    const t = await run(answers);
    await t.open();
    const set = (v: Record<string, string>) => {
      for (const [k, value] of Object.entries(v)) t.input(`date-textes-${k}`).value = value;
    };
    const press = () => t.click(t.button('Ranger ces textes'));
    return { ...t, set, press };
  };

  it('[R405] saisie contrôlée avant l’appel : sorte, canal, un à cinq textes, le prénom une fois ; rien ne part sinon', async () => {
    const t = await setUp();
    await t.press();
    expect(t.status()).toBe(DATE_REFUSALS['bad_kind']);
    t.set({ sorte: 'anniversaire' });
    await t.press();
    expect(t.status()).toBe(SCENARIO_REFUSALS['bad_channel']);
    t.set({ canal: 'sms' });
    await t.press();
    expect(t.status()).toBe(DATE_REFUSALS['bad_texts']);
    t.set({ '1': 'Bon anniversaire !' });
    await t.press();
    expect(t.status()).toBe(SCENARIO_REFUSALS['first_name_slot']);
    t.set({ '1': 'Bon anniversaire {prenom} !', '3': 'Belle journée {prenom}, {prenom} !' });
    await t.press();
    expect(t.status()).toBe(SCENARIO_REFUSALS['first_name_slot']);
    expect(t.posts()).toHaveLength(0);
    // Cinq champs, pas un de plus ; les champs vides ne partent pas.
    expect(t.part().all().filter((e) => e.tagName === 'textarea' && /^date-textes-\d$/.test(e.attributes.id ?? ''))).toHaveLength(5);
    t.table[`POST ${TEXTS}`] = ok({ seq: 1 });
    t.set({ '3': 'Belle journée {prenom} !' });
    await t.press();
    expect(t.posts().map((c) => [c.url, c.body])).toEqual([[TEXTS, { kind: 'anniversaire', channel: 'sms', texts: ['Bon anniversaire {prenom} !', 'Belle journée {prenom} !'] }]]);
    expect(t.status()).toBe('2 textes rangés pour anniversaire par SMS.');
    // Un choix changé pendant l'envoi ne change pas ce qui est dit rangé.
    let release: () => void = () => undefined;
    t.table[`POST ${TEXTS}`] = () => new Promise<Response>((r) => (release = () => r(Response.json({ ok: true, mode: 'essai', data: { seq: 2 } }))));
    t.set({ sorte: 'fete', canal: 'email' });
    await t.press();
    t.set({ sorte: '', canal: 'whatsapp' });
    release();
    await settle();
    expect(t.posts()[1]!.body).toMatchObject({ kind: 'fete', channel: 'email' });
    expect(t.status()).toBe('2 textes rangés pour fête par Mail.');
  });

  it('[R16] droits et contrôles du serveur dits en mots ; une réponse perdue est dite incertaine', async () => {
    const t = await setUp({ [`POST ${TEXTS}`]: no(403, { ok: false, rule: 'R16', code: 'not_direction', message: DATE_REFUSALS['not_direction'] }) });
    t.set({ sorte: 'fete', canal: 'email', '1': 'Bonne fête {prenom} !' });
    await t.press();
    expect(t.status()).toBe(DATE_REFUSALS['not_direction']);
    const u = await setUp({ [`POST ${TEXTS}`]: no(409, { ok: false, rule: 'R10', code: 'text_R10', message: 'Un texte fixe ne porte aucun chiffre : ni prix, ni surface, ni date, ni remise.' }) });
    u.set({ sorte: 'fete', canal: 'email', '1': 'Bonne fête {prenom}, -10 % offert !' });
    await u.press();
    expect(u.status()).toBe('Un texte fixe ne porte aucun chiffre : ni prix, ni surface, ni date, ni remise.');
    expect(u.status()).not.toContain('text_R10');
    for (const answer of [cut, no(500, { ok: false, code: 'internal' })]) {
      const v = await setUp({ [`POST ${TEXTS}`]: answer });
      v.set({ sorte: 'fete', canal: 'whatsapp', '1': 'Bonne fête {prenom} !' });
      await v.press();
      expect(v.status()).toBe(SCENARIOS_LOST);
    }
  });
});


describe('BR59 · les textes en service, relus par la direction', () => {
  const TEXTS = '/v1/dates-clients/textes';
  const shown = (t: Awaited<ReturnType<typeof run>>) => t.part().all().find((e) => e.className === 'textes-en-service')!;
  const reads = (t: Awaited<ReturnType<typeof run>>) => t.calls.filter((c) => c.method === 'GET' && c.url === TEXTS);

  it('[R201] rien n’est lu avant le geste ; le budget tient', async () => {
    const t = await run({ [`GET ${TEXTS}`]: ok([]) });
    await t.open();
    expect(reads(t)).toHaveLength(0);
    expect(shown(t).children).toHaveLength(0);
    await t.click(t.button('Relire les textes en service'));
    expect(reads(t)).toHaveLength(1);
    expect(shown(t).textContent).toBe('Aucun texte en service : aucun message de date ne peut partir.');
    expect(budgetProblems({ html: '', js: SCENARIOS_SCRIPT }, BUDGETS.page)).toEqual([]);
  });

  it('[R405] chaque sorte et canal dit avec ses textes, posés en texte ; un champ mal formé n’est pas dit', async () => {
    const t = await run({
      [`GET ${TEXTS}`]: ok([
        { kind: 'anniversaire', channel: 'email', texts: ['Joyeux anniversaire {prenom} !', INJECTED], seq: 2, writtenAt: '2027-03-09T08:00:00.000Z' },
        { kind: 'fete', channel: 'sms', texts: ['Bonne fête {prenom} !'], seq: 1, writtenAt: '2027-03-09T08:00:00.000Z' },
        { kind: 'noel', channel: 'sms', texts: ['Joyeux Noël {prenom}'], seq: 1 },
        { kind: 'fete', channel: 'courrier', texts: ['Bonne fête {prenom}'], seq: 1 },
        { kind: 'fete', channel: 'email', texts: 'pas une liste', seq: 1 },
        null,
      ]),
    });
    await t.open();
    await t.click(t.button('Relire les textes en service'));
    const box = shown(t);
    expect(box.all().filter((e) => e.tagName === 'h5').map((e) => e.textContent)).toEqual(['Anniversaire par Mail : 2 textes en service', 'Fête par SMS : 1 texte en service']);
    expect(box.all().filter((e) => e.tagName === 'li').map((e) => e.textContent)).toEqual(['Joyeux anniversaire {prenom} !', INJECTED, 'Bonne fête {prenom} !']);
    expect(box.all().some((e) => e.tagName === 'img')).toBe(false);
    expect(SCENARIOS_SCRIPT).not.toContain('innerHTML');
  });

  it('[R16] relus après chaque écriture ; un refus ou une coupure dits en mots', async () => {
    const t = await run({ [`POST ${TEXTS}`]: ok({ seq: 1 }), [`GET ${TEXTS}`]: ok([{ kind: 'fete', channel: 'email', texts: ['Bonne fête {prenom} !'], seq: 1 }]) });
    await t.open();
    for (const [k, v] of Object.entries({ sorte: 'fete', canal: 'email', '1': 'Bonne fête {prenom} !' })) t.input(`date-textes-${k}`).value = v;
    await t.click(t.button('Ranger ces textes'));
    expect(reads(t)).toHaveLength(1);
    expect(shown(t).textContent).toContain('Fête par Mail : 1 texte en service');
    for (const [answer, words] of [
      [no(403, { ok: false, rule: 'R16', code: 'not_direction' }), 'Les textes en service ne se lisent pas pour le moment.'],
      [cut, SCENARIOS_OFFLINE],
    ] as const) {
      const u = await run({ [`GET ${TEXTS}`]: answer });
      await u.open();
      await u.click(u.button('Relire les textes en service'));
      expect(shown(u).textContent).toBe(words);
    }
  });
});
