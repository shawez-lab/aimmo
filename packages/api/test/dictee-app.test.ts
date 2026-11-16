import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { DICTEE_DONE, DICTEE_FAILED, DICTEE_LABEL, DICTEE_OFFLINE, DICTEE_REFUSALS, DICTEE_SCRIPT } from '../app/dictee.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : clé, agent, dictée, fiche, bien.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const INJECTED = '<img src=x onerror="alert(1)">';
const LABEL = DICTEE_LABEL;
const READ_AT = '2026-12-03T09:00:00.000Z';
const DICTATION = 'Je sors de chez Madame Claire Exemple, elle veut vendre sa maison. La maison fait 120 m² au 21240 Talant.';
type Answer = (body: Record<string, unknown> | null) => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const cut: Answer = () => Promise.reject(new TypeError('coupé'));

const DRAFT = {
  sentences: ['Je sors de chez Madame Claire Exemple, elle veut vendre sa maison.', 'La maison fait 120 m² au 21240 Talant.'],
  fields: [
    { target: 'contact', key: 'firstName', value: 'Claire', sentence: 0, quote: 'Claire' },
    { target: 'contact', key: 'lastName', value: 'Exemple', sentence: 0, quote: 'Exemple' },
    { target: 'contact', key: 'project', value: 'sell', sentence: 0, quote: 'vendre' },
    { target: 'bien', key: 'kind', value: 'home', sentence: 0, quote: 'maison' },
    { target: 'bien', key: 'surfaceM2', value: 120, sentence: 1, quote: '120 m²' },
    { target: 'bien', key: 'postalCode', value: '21240', sentence: 1, quote: '21240' },
    { target: 'bien', key: 'city', value: 'Talant', sentence: 1, quote: 'Talant' },
  ],
  conflicts: [{ target: 'bien', key: 'rooms' }],
};

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};
const scriptsOf = (root: FakeElement, src: string) => [root, ...root.all()].filter((e) => e.tagName === 'script' && e.attributes.src === src);

async function desk(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  (document as { body?: FakeElement }).body = new FakeElement('body');
  const calls: { method: string; url: string; body: Record<string, unknown> | null }[] = [];
  const table: Record<string, Answer> = {
    'GET /v1/moi': ok({ role: 'agent', firstName: 'Alex' }),
    'GET /v1/plan-du-jour': ok(null),
    'GET /v1/contacts-chauds': ok({ contacts: [] }),
    'GET /v1/rendez-vous/jour': ok({ appointments: [] }),
    'GET /v1/usage/matin': ok(null),
    'GET /v1/annonces': ok([]),
    'POST /v1/dictee/lecture': ok({ draft: DRAFT, readAt: READ_AT, report: null }),
    'POST /v1/dictee/validation': ok({ personId: 'p1', contact: 'created', propertyId: 'b1', appointmentId: null, report: null }),
    ...answers,
  };
  let uuids = 0;
  const ctx: Record<string, unknown> = {
    document,
    localStorage: { getItem: () => KEY, setItem: () => undefined, removeItem: () => undefined },
    fetch: (url: string, init: { method?: string; body?: string } = {}) => {
      const method = init.method ?? 'GET';
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
      calls.push({ method, url, body });
      const a = table[`${method} ${url}`] ?? table[`${method} ${url.split('?')[0]}`];
      return a ? a(body) : Promise.reject(new TypeError('hors ligne'));
    },
    Intl,
    Date,
    crypto: { randomUUID: () => `7d1c2b3a-1111-4a2b-8c3d-${String(++uuids).padStart(12, '0')}` },
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
  const part = () => els['dictee-accueil']!.children[0]!;
  const btn = (text: string) => part().all().find((e) => e.tagName === 'button' && e.textContent === text);
  const open = async () => {
    await click(part().children[0]);
    const s = scriptsOf(els.fiche!, '/app/dictee.js');
    if (s.length === 1 && !ctx.loaded) {
      runInNewContext(DICTEE_SCRIPT, ctx);
      ctx.loaded = true;
      s[0]!.listeners.load!({});
      await settle();
    }
  };
  const area = () => part().all().find((e) => e.tagName === 'textarea')!;
  const dictate = async (text = DICTATION) => {
    area().value = text;
    await click(btn('Lire la dictée'));
  };
  const posts = () => calls.filter((c) => c.method === 'POST');
  const boxes = () => part().all().filter((e) => e.tagName === 'input' && e.attributes.type === 'checkbox');
  const answer = () => part().all().find((e) => e.attributes.role === 'status' && e !== part().children[1])?.textContent ?? '';
  return { els, ctx, calls, table, part, btn, open, click, dictate, area, posts, boxes, answer, settle, text: () => part().textContent };
}

describe('BR101 · la création à la voix à l’écran de l’agent', () => {
  it('[R201] un script servi à part, chargé au seul geste depuis « Ma journée » ; budgets tenus ; seules les routes de la dictée', async () => {
    expect(AGENT_APP_FILES['/app/dictee.js']).toBe(DICTEE_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/dictee.js');
    const res = handleAgentApp(new Request('https://x.test/app/dictee.js'))!;
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/javascript');
    expect(budgetProblems({ html: '', js: DICTEE_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    expect(JS).not.toContain('/v1/dictee');
    expect(DICTEE_SCRIPT).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write|localStorage|sessionStorage|eval\(|fetch\(/);
    for (const path of DICTEE_SCRIPT.match(/"\/v1\/[^"]*"/g) ?? []) expect(['"/v1/dictee/lecture"', '"/v1/dictee/validation"']).toContain(path);
    expect(DICTEE_SCRIPT).toContain('globalThis.AIMMO_DICTEE =');
    const d = await desk();
    expect(d.part().children[0]!.textContent).toBe(LABEL);
    expect(scriptsOf(d.els.fiche!, '/app/dictee.js')).toHaveLength(0);
    expect(d.calls.some((c) => c.url.startsWith('/v1/dictee'))).toBe(false);
    await d.open();
    expect(scriptsOf(d.els.fiche!, '/app/dictee.js')).toHaveLength(1);
    // Ouvrir ne lit rien : seule la lecture de la dictée appelle le socle.
    expect(d.calls.some((c) => c.url.startsWith('/v1/dictee'))).toBe(false);
    expect(d.part().all().some((e) => e.tagName === 'label' && e.attributes.for === d.area().attributes.id)).toBe(true);
  });

  it('[R260] chaque champ proposé est montré, coché, avec la phrase qui le porte ; un champ dit deux fois est dit, jamais proposé (Jamais vu)', async () => {
    const d = await desk();
    await d.open();
    await d.dictate();
    expect(d.posts()[0]).toEqual({ method: 'POST', url: '/v1/dictee/lecture', body: { dictation: DICTATION } });
    const text = d.text();
    expect(text).toContain('Le contact');
    expect(text).toContain('Prénom : Claire');
    expect(text).toContain('Projet : vendre');
    expect(text).toContain('Le bien');
    expect(text).toContain('Surface : 120 m²');
    expect(text).toContain('Dit : « 120 m² », dans « La maison fait 120 m² au 21240 Talant. »');
    expect(text).toContain('Dit deux fois avec deux valeurs, donc non proposé : Pièces');
    expect(d.boxes()).toHaveLength(7);
    expect(d.boxes().every((b) => b.checked)).toBe(true);
  });

  it('[R261] seuls les champs cochés partent à la validation, avec un identifiant tiré une fois par dictée', async () => {
    const d = await desk();
    await d.open();
    await d.dictate();
    // L'agent décoche la surface : le bien n'est plus complet, mais c'est au socle de le dire.
    d.boxes().find((b) => b.attributes.id!.endsWith('-bien-surfaceM2'))!.checked = false;
    await d.click(d.btn('Valider ce qui est coché'));
    const v = d.posts().find((p) => p.url === '/v1/dictee/validation')!;
    expect(v.body).toEqual({
      requestId: '7d1c2b3a-1111-4a2b-8c3d-000000000001',
      dictation: DICTATION,
      readAt: READ_AT,
      keep: { contact: ['firstName', 'lastName', 'project'], bien: ['kind', 'postalCode', 'city'] },
    });
    expect(d.answer()).toBe('Rangé : la fiche du contact, créée, le bien, en brouillon. Aucun message n’est parti au contact.');
    expect(d.area().value).toBe('');
  });

  it('[R261] relue sans changement, la dictée garde son identifiant ; changée, elle en tire un autre', async () => {
    const d = await desk({ 'POST /v1/dictee/validation': no(409, { ok: false, rule: 'R32', code: 'slot_not_free' }) });
    await d.open();
    await d.dictate();
    await d.click(d.btn('Valider ce qui est coché'));
    await d.dictate();
    await d.click(d.btn('Valider ce qui est coché'));
    await d.dictate(DICTATION + ' Rien d’autre.');
    await d.click(d.btn('Valider ce qui est coché'));
    const ids = d.posts().filter((p) => p.url === '/v1/dictee/validation').map((p) => p.body!.requestId);
    expect(ids).toEqual(['7d1c2b3a-1111-4a2b-8c3d-000000000001', '7d1c2b3a-1111-4a2b-8c3d-000000000001', '7d1c2b3a-1111-4a2b-8c3d-000000000002']);
  });

  it('[R32] créneau pris pendant la validation : ce qui est rangé et les créneaux libres sont dits (Jamais vu)', async () => {
    const d = await desk({
      'POST /v1/dictee/validation': no(409, {
        ok: false, rule: 'R32', code: 'slot_taken_meanwhile',
        kept: { personId: 'p1', contact: 'created', propertyId: 'b1' },
        freeSlots: ['2026-12-08T10:00:00.000Z', INJECTED],
      }),
    });
    await d.open();
    await d.dictate();
    await d.click(d.btn('Valider ce qui est coché'));
    expect(d.answer()).toBe(DICTEE_REFUSALS.slot_taken_meanwhile);
    const text = d.text();
    expect(text).toContain('Déjà rangé, sans rien doubler : la fiche du contact, créée et le bien. Le rendez-vous n’est pas pris : fixez une autre heure avec le contact, puis dictez son numéro ou son mail avec le nouveau rendez-vous, sans le bien ; le rendez-vous rejoindra sa fiche.');
    expect(text).toContain('Créneaux libres les plus proches :');
    expect(text).toContain('à 11:00');
    expect(text).not.toContain(INJECTED);
  });

  it('refus dits en mots, jamais un code ; un refus inconnu a sa phrase', async () => {
    const d = await desk({ 'POST /v1/dictee/validation': no(409, { ok: false, rule: 'R260', code: 'not_dictated', keys: ['bien.rooms', 'contact.phone'] }) });
    await d.open();
    await d.dictate();
    await d.click(d.btn('Valider ce qui est coché'));
    expect(d.answer()).toBe(`${DICTEE_REFUSALS.not_dictated} (Pièces, Téléphone)`);
    const odd = await desk({ 'POST /v1/dictee/lecture': no(409, { ok: false, rule: null, code: INJECTED }) });
    await odd.open();
    await odd.dictate();
    expect(odd.answer()).toBe(DICTEE_FAILED);
    expect(odd.text()).not.toContain(INJECTED);
    const role = await desk({ 'POST /v1/dictee/lecture': no(403, { ok: false, rule: 'R16', code: 'role' }) });
    await role.open();
    await role.dictate();
    expect(role.answer()).toBe(DICTEE_REFUSALS.role);
  });

  it('réseau coupé : dit, et la dictée reste à l’écran ; un second geste sur le bloc ne la perd pas', async () => {
    const d = await desk({ 'POST /v1/dictee/lecture': cut });
    await d.open();
    await d.dictate();
    expect(d.answer()).toBe(DICTEE_OFFLINE);
    expect(d.area().value).toBe(DICTATION);
    await d.click(d.part().children[0]);
    expect(d.area().value).toBe(DICTATION);
    d.table['POST /v1/dictee/lecture'] = ok({ draft: DRAFT, readAt: READ_AT, report: null });
    d.table['POST /v1/dictee/validation'] = cut;
    await d.dictate();
    await d.click(d.btn('Valider ce qui est coché'));
    expect(d.answer()).toBe(DICTEE_OFFLINE);
    expect(d.area().value).toBe(DICTATION);
  });

  it('[R261] un geste à la fois : une lecture en cours n’en laisse partir aucune autre, et la validation porte la dictée lue avec son identifiant', async () => {
    let release: () => void = () => undefined;
    const held: Answer = () => new Promise((r) => { release = () => r(Response.json({ ok: true, mode: 'essai', data: { draft: DRAFT, readAt: READ_AT, report: null } })); });
    const d = await desk({ 'POST /v1/dictee/lecture': held });
    await d.open();
    await d.dictate('Dictée A : Madame Claire Exemple vend sa maison.');
    // La dictée B est lue avant la réponse de A : rien ne part, l'écran le dit.
    await d.dictate('Dictée B : Monsieur Paul Fictif vend son terrain.');
    expect(d.answer()).toBe('Une demande est en cours : attendez sa réponse.');
    expect(d.posts().filter((p) => p.url === '/v1/dictee/lecture')).toHaveLength(1);
    release();
    await d.settle();
    await d.click(d.btn('Valider ce qui est coché'));
    const v = d.posts().find((p) => p.url === '/v1/dictee/validation')!;
    expect(v.body).toMatchObject({ requestId: '7d1c2b3a-1111-4a2b-8c3d-000000000001', dictation: 'Dictée A : Madame Claire Exemple vend sa maison.' });
  });

  it('une validation qui répond après une nouvelle dictée ne l’efface pas', async () => {
    let release: () => void = () => undefined;
    const held: Answer = () => new Promise((r) => { release = () => r(Response.json({ ok: true, mode: 'essai', data: { personId: 'p1', contact: 'created', propertyId: null, appointmentId: null, report: null } })); });
    const d = await desk({ 'POST /v1/dictee/validation': held });
    await d.open();
    await d.dictate();
    await d.click(d.btn('Valider ce qui est coché'));
    // Pendant la validation : une seconde validation ne part pas, la nouvelle dictée attend.
    await d.click(d.btn('Valider ce qui est coché'));
    expect(d.posts().filter((p) => p.url === '/v1/dictee/validation')).toHaveLength(1);
    d.area().value = 'Une autre dictée, commencée pendant la validation.';
    await d.dictate(d.area().value);
    expect(d.posts().filter((p) => p.url === '/v1/dictee/lecture')).toHaveLength(1);
    release();
    await d.settle();
    expect(d.answer()).toBe('Rangé : la fiche du contact, créée. Aucun message n’est parti au contact.');
    expect(d.area().value).toBe('Une autre dictée, commencée pendant la validation.');
    // Lue maintenant, elle a son propre identifiant.
    d.table['POST /v1/dictee/validation'] = ok({ personId: 'p2', contact: 'created', propertyId: null, appointmentId: null, report: null });
    await d.dictate(d.area().value);
    await d.click(d.btn('Valider ce qui est coché'));
    expect(d.posts().filter((p) => p.url === '/v1/dictee/validation').map((p) => p.body!.requestId)).toEqual(['7d1c2b3a-1111-4a2b-8c3d-000000000001', '7d1c2b3a-1111-4a2b-8c3d-000000000002']);
  });

  it('tout texte reçu est posé en texte ; une dictée vide n’appelle pas le socle', async () => {
    const d = await desk({ 'POST /v1/dictee/lecture': ok({ draft: { sentences: [INJECTED], fields: [{ target: 'contact', key: 'firstName', value: INJECTED, sentence: 0, quote: INJECTED }, { target: 'bien', key: 'kind', value: 'chateau', sentence: 0, quote: 'x' }], conflicts: [] }, readAt: READ_AT, report: null }) });
    await d.open();
    await d.dictate('   ');
    expect(d.posts()).toHaveLength(0);
    await d.dictate();
    const label = d.part().all().find((e) => e.tagName === 'label' && e.textContent.startsWith('Prénom'))!;
    expect(label.textContent).toBe(`Prénom : ${INJECTED}`);
    expect(label.children).toHaveLength(0);
    // Une valeur hors des listes fermées n'est pas proposée.
    expect(d.boxes()).toHaveLength(1);
    expect(DICTEE_DONE).toContain('Aucun message');
  });
});

describe('BR101 · le bouton du bloc', () => {
  it('le bouton de « Ma journée » porte le libellé du module, dans le script de l’application', () => {
    expect(JS).toContain(`lazyBlock('${DICTEE_LABEL}', '/app/dictee.js', 'AIMMO_DICTEE', '')`);
  });
});
