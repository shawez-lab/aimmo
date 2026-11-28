import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { AGENT_APP_FILES } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : projets, clients, partenaires, clé de test.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const INJECTED = '<img src=x onerror="alert(1)">';
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });

// L'ordre du tirage, volontairement à rebours de l'alphabet : l'écran ne doit jamais le retrier.
const SHOWN = [
  { partnerId: 'pz', trade: 'notaire', businessName: 'Zoé Notaires' },
  { partnerId: 'pm', trade: 'notaire', businessName: `Maître ${INJECTED}` },
  { partnerId: 'pa', trade: 'notaire', businessName: 'Arnaud Notaires' },
];
const referral = (over: Record<string, unknown> = {}) => ({
  referralId: 'r1',
  projectId: 'pr1',
  propertyId: 'b1',
  trade: 'notaire',
  domain: null,
  postcode: '21000',
  seed: 42,
  shown: SHOWN,
  state: 'proposee',
  chosenPartnerId: null,
  consent: null,
  createdAt: '2027-07-12T08:00:00.000Z',
  steps: 0,
  ...over,
});
const PROJECTS = [
  { projectId: 'pr1', kind: 'sell', stage: 'new', firstName: 'Léa', properties: [{ propertyId: 'b1', reference: 'REF-T-1', postcode: '21000', city: 'Dijon' }], referrals: [referral()] },
  { projectId: 'pr2', kind: 'buy', stage: 'new', firstName: INJECTED, properties: [], referrals: [] },
];
const BASE: Record<string, Answer> = {
  'GET /v1/moi': ok({ role: 'agent', firstName: 'Alex' }),
  'GET /v1/plan-du-jour': ok(null),
  'GET /v1/contacts-chauds': ok({ contacts: [] }),
  'GET /v1/rendez-vous/jour': ok({ appointments: [] }),
  'GET /v1/usage/matin': ok(null),
  'GET /v1/annonces': ok([]),
  'GET /v1/apres-vente/journee': ok({ remercier: [], recommandations: [], taches: [] }),
  'GET /v1/partenaires/projets': ok({ projects: PROJECTS, page: 0, more: false }),
};
const settle = async () => {
  for (let i = 0; i < 16; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; body?: string; auth: string | undefined }[] = [];
  const table: Record<string, Answer> = { ...BASE, ...answers };
  runInNewContext(JS, {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, ...(init.body === undefined ? {} : { body: init.body }), auth: init.headers?.authorization });
      const a = table[`${method} ${url}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  });
  listeners.DOMContentLoaded!();
  await settle();
  const byText = (root: FakeElement, text: string) => root.all().find((e) => e.tagName === 'button' && e.textContent === text);
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  const byId = (id: string) => els['partenaires-corps']!.all().find((e) => e.attributes.id === id);
  const open = async () => {
    await click(els['partenaires-ouvrir']);
    calls.length = 0;
  };
  return { els, calls, table, byText, click, byId, open, storage };
}

describe('U11 · écran « Partenaires » de l’application', () => {
  it('[R75] [R14] les partenaires dans l’ordre du tirage reçu, sans note ni tri ; tout texte reste du texte', async () => {
    const t = await run();
    await t.open();
    expect(t.els.partenaires!.hidden).toBe(false);
    expect(t.els.accueil!.hidden).toBe(true);
    const body = t.els['partenaires-corps']!;
    const draw = body.all().find((e) => e.tagName === 'ol')!;
    expect(draw.children.map((li) => li.textContent)).toEqual(['Zoé Notaires', `Maître ${INJECTED}`, 'Arnaud Notaires']);
    const text = body.textContent;
    expect(text).toContain('Vendre · Léa');
    expect(text).toContain(`Acheter · ${INJECTED}`);
    expect(text).toContain('Bien REF-T-1, Dijon');
    expect(text).toContain('Proposée au client : à lui de choisir');
    expect(text).not.toMatch(/\bnote\b|étoile|\/ ?5|classement|meilleur/i);
    // Aucun élément créé à partir du texte reçu : l'image piégée reste une chaîne.
    expect(body.all().some((e) => e.tagName === 'img')).toBe(false);
    expect(t.els['partenaires-etat']!.textContent).toBe('');
  });

  it('[R74] [R75] une option du Studio demandée pour un bien du projet passe par sa route ; sans bien, pas d’option', async () => {
    const t = await run();
    await t.open();
    const body = t.els['partenaires-corps']!;
    const options = body.all().filter((e) => e.tagName === 'select' && e.attributes.id?.startsWith('option-'));
    // Un seul des deux projets a un bien.
    expect(options).toHaveLength(1);
    options[0]!.value = 'drone';
    t.table['POST /v1/studio/options'] = ok({ option: 'drone', referral: referral({ referralId: 'r9' }) });
    await t.click(t.byText(body, 'Demander cette option et proposer au client'));
    expect(t.calls.find((c) => c.method === 'POST')).toEqual({ method: 'POST', url: '/v1/studio/options', body: JSON.stringify({ projectId: 'pr1', propertyId: 'b1', option: 'drone' }), auth: `Bearer ${KEY}` });
    expect(t.els['partenaires-etat']!.textContent).toBe('Tirage fait : montrez au client les photographes proposés, dans cet ordre.');
    t.table['POST /v1/studio/options'] = no(409, { ok: false, rule: 'R73', code: 'no_partner' });
    await t.click(t.byText(t.els['partenaires-corps']!, 'Demander cette option et proposer au client'));
    expect(t.els['partenaires-etat']!.textContent).not.toContain('Tirage fait');
  });

  it('[R10] une option sans réponse n’est dite ni faite ni refusée, et un double appui ne tire pas deux fois', async () => {
    const text = 'La réponse n’est pas arrivée : rien n’est sûr. Rouvrez les projets avant de recommencer.';
    for (const answer of [async () => { throw new TypeError('coupure'); }, no(500, { ok: false, code: 'panne' }), async () => new Response('pas du json', { status: 200 })] as Answer[]) {
      const t = await run({ 'POST /v1/studio/options': answer });
      await t.open();
      await t.click(t.byText(t.els['partenaires-corps']!, 'Demander cette option et proposer au client'));
      expect(t.els['partenaires-etat']!.textContent).toBe(text);
    }
    let release: (r: Response) => void = () => undefined;
    const t = await run({ 'POST /v1/studio/options': () => new Promise((r) => { release = r; }) });
    await t.open();
    const b = t.byText(t.els['partenaires-corps']!, 'Demander cette option et proposer au client');
    await t.click(b);
    await t.click(b);
    expect(t.calls.filter((c) => c.url === '/v1/studio/options')).toHaveLength(1);
    release(Response.json({ ok: false, rule: 'R73', code: 'no_partner' }, { status: 409 }));
    await new Promise((r) => setTimeout(r, 5));
    // La réponse arrivée, le geste se refait.
    await t.click(b);
    expect(t.calls.filter((c) => c.url === '/v1/studio/options')).toHaveLength(2);
  });

  it('[R10] [R74] le tirage : réponse perdue dite telle, sans relire ; double appui, un seul tirage', async () => {
    const text = 'La réponse n’est pas arrivée : rien n’est sûr. Rouvrez les projets avant de recommencer.';
    const label = 'Tirer au sort et proposer au client';
    for (const answer of [async () => { throw new TypeError('coupure'); }, no(500, { ok: false, code: 'panne' }), async () => new Response('pas du json', { status: 200 })] as Answer[]) {
      const t = await run({ 'POST /v1/partenaires/relations': answer });
      await t.open();
      const reads = t.calls.filter((c) => c.url === '/v1/partenaires/projets').length;
      await t.click(t.byText(t.els['partenaires-corps']!, label));
      expect(t.els['partenaires-etat']!.textContent).toBe(text);
      expect(t.calls.filter((c) => c.url === '/v1/partenaires/projets')).toHaveLength(reads);
    }
    let release: (r: Response) => void = () => undefined;
    const t = await run({ 'POST /v1/partenaires/relations': () => new Promise((r) => { release = r; }) });
    await t.open();
    const b = t.byText(t.els['partenaires-corps']!, label);
    await t.click(b);
    await t.click(b);
    expect(t.calls.filter((c) => c.url === '/v1/partenaires/relations')).toHaveLength(1);
    release(Response.json({ ok: false, rule: 'R73', code: 'no_partner' }, { status: 409 }));
    await new Promise((r) => setTimeout(r, 5));
    await t.click(b);
    expect(t.calls.filter((c) => c.url === '/v1/partenaires/relations')).toHaveLength(2);
  });

  it('le verrou d’un geste vaut pour sa session : une réponse qui tarde ne bloque pas la connexion suivante', async () => {
    const t = await run({ 'POST /v1/partenaires/relations': () => new Promise(() => undefined) });
    await t.open();
    await t.click(t.byText(t.els['partenaires-corps']!, 'Tirer au sort et proposer au client'));
    expect(t.calls.filter((c) => c.url === '/v1/partenaires/relations')).toHaveLength(1);
    await t.click(t.els['partenaires-retour']);
    await t.click(t.els['partenaires-ouvrir']);
    await new Promise((r) => setTimeout(r, 5));
    await t.click(t.byText(t.els['partenaires-corps']!, 'Tirer au sort et proposer au client'));
    expect(t.calls.filter((c) => c.url === '/v1/partenaires/relations')).toHaveLength(2);
  });

  it('[R10] l’accord : réponse perdue dite telle, à chacune de ses deux écritures ; double appui, une seule preuve', async () => {
    const text = 'La réponse n’est pas arrivée : rien n’est sûr. Rouvrez les projets avant de recommencer.';
    const proof = 'POST /v1/partenaires/relations/r1/preuve-accord';
    const agreed = 'POST /v1/partenaires/relations/r1/accord';
    const stored = ok({ proofRef: 'relations/r1/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.txt', sha256: 'e'.repeat(64), at: '2027-07-12T08:05:00.000Z', channel: 'sms' });
    const ready = async (answers: Record<string, Answer>) => {
      const t = await run(answers);
      await t.open();
      t.table['GET /v1/partenaires/relations/r1/remunerations'] = ok({ text: 'Aucun des professionnels proposés ne rémunère le réseau ni votre agent.', fees: [], textSha256: 'x' });
      const body = t.els['partenaires-corps']!;
      await t.click(t.byText(body, 'Montrer au client le texte des rémunérations'));
      body.all().find((e) => e.attributes.type === 'radio')!.checked = true;
      body.all().find((e) => e.tagName === 'textarea')!.value = 'Choisi au téléphone ce matin, après lecture du texte.';
      return { t, go: () => t.click(t.byText(body, 'Enregistrer son accord')) };
    };
    const coupure: Answer = async () => { throw new TypeError('coupure'); };
    const a = await ready({ [proof]: coupure });
    await a.go();
    expect(a.t.els['partenaires-etat']!.textContent).toBe(text);
    const b = await ready({ [proof]: no(500, { ok: false, code: 'panne' }) });
    await b.go();
    expect(b.t.els['partenaires-etat']!.textContent).toBe(text);
    const c = await ready({ [proof]: stored, [agreed]: coupure });
    await c.go();
    expect(c.t.els['partenaires-etat']!.textContent).toBe(text);
    // Un stockage fermé est un refus sûr, dit tel quel.
    const closed = await ready({ [proof]: no(503, { ok: false, code: 'storage_unavailable' }) });
    await closed.go();
    expect(closed.t.els['partenaires-etat']!.textContent).toBe('Le rangement des preuves n’est pas encore ouvert : rien n’est enregistré.');
    // Une demande qui a déjà changé : c'est dit, et l'écran est relu.
    const changed = await ready({ [proof]: no(409, { ok: false, code: 'bad_state' }) });
    const reads = changed.t.calls.filter((x) => x.url === '/v1/partenaires/projets').length;
    await changed.go();
    expect(changed.t.calls.filter((x) => x.url === '/v1/partenaires/projets')).toHaveLength(reads + 1);
    // Un autre geste en cours : l'accord ne part pas du tout, aucune preuve n'est écrite, c'est dit, et la note reste.
    const busy = await ready({ 'POST /v1/partenaires/relations': () => new Promise(() => undefined), [proof]: stored });
    await busy.t.click(busy.t.byText(busy.t.els['partenaires-corps']!, 'Tirer au sort et proposer au client'));
    await busy.go();
    expect(busy.t.calls.filter((x) => x.url.endsWith('/preuve-accord'))).toEqual([]);
    expect(busy.t.els['partenaires-etat']!.textContent).toBe('Un autre geste est en cours : attendez sa réponse, puis recommencez.');
    expect(busy.t.els['partenaires-corps']!.all().find((e) => e.tagName === 'textarea')!.value).toContain('Choisi au téléphone');
    // Un accord en cours bloque aussi le tirage, jusqu'à la seconde écriture comprise.
    let hold: (r: Response) => void = () => undefined;
    const second = await ready({ [proof]: stored, [agreed]: () => new Promise((r) => { hold = r; }), 'POST /v1/partenaires/relations': ok(referral({ referralId: 'r2' })) });
    await second.go();
    await second.t.click(second.t.byText(second.t.els['partenaires-corps']!, 'Tirer au sort et proposer au client'));
    expect(second.t.calls.filter((x) => x.url === '/v1/partenaires/relations')).toEqual([]);
    hold(Response.json({ ok: false, code: 'bad_note' }, { status: 400 }));
    await new Promise((r) => setTimeout(r, 5));
    await second.t.click(second.t.byText(second.t.els['partenaires-corps']!, 'Tirer au sort et proposer au client'));
    expect(second.t.calls.filter((x) => x.url === '/v1/partenaires/relations')).toHaveLength(1);
    let release: (r: Response) => void = () => undefined;
    const d = await ready({ [proof]: () => new Promise((r) => { release = r; }) });
    await d.go();
    await d.go();
    expect(d.t.calls.filter((x) => x.url.endsWith('/preuve-accord'))).toHaveLength(1);
    release(Response.json({ ok: false, code: 'bad_note' }, { status: 400 }));
    await new Promise((r) => setTimeout(r, 5));
    await d.go();
    expect(d.t.calls.filter((x) => x.url.endsWith('/preuve-accord'))).toHaveLength(2);
  });

  it('une option pour un bien sans code postal part avec le code saisi', async () => {
    const t = await run();
    await t.open();
    const body = t.els['partenaires-corps']!;
    body.all().filter((e) => e.attributes.id?.startsWith('cp-'))[0]!.value = ' 21240 ';
    t.table['POST /v1/studio/options'] = no(409, { ok: false, rule: 'R73', code: 'no_partner' });
    await t.click(t.byText(body, 'Demander cette option et proposer au client'));
    expect(JSON.parse(String(t.calls.find((c) => c.url === '/v1/studio/options')!.body))).toMatchObject({ propertyId: 'b1', postcode: '21240' });
  });

  it('[R16] l’écran ne lit et n’écrit que par les routes /v1/partenaires, la clé dans l’en-tête seul', async () => {
    const t = await run();
    await t.open();
    t.table['GET /v1/partenaires/relations/r1/remunerations'] = ok({ text: 'Aucun des professionnels proposés ne rémunère le réseau ni votre agent.', fees: [], textSha256: 'x' });
    await t.click(t.byText(t.els['partenaires-corps']!, 'Montrer au client le texte des rémunérations'));
    await t.click(t.byText(t.els['partenaires-corps']!, 'Tirer au sort et proposer au client'));
    await t.click(t.els['partenaires-ouvrir']);
    expect(t.calls.length).toBeGreaterThan(2);
    for (const c of t.calls) {
      expect(c.url.startsWith('/v1/partenaires/'), c.url).toBe(true);
      expect(c.auth).toBe(`Bearer ${KEY}`);
      expect(c.url).not.toContain(KEY);
    }
    // Les routes de l'écran sont toutes des routes de M18 sous R16 ; elles vivent dans son script, servi à part (DS068).
    const routes = [...AGENT_APP_FILES['/app/partenaires.js']!.matchAll(/'(\/v1\/partenaires[^']*)'/g)].map((m) => m[1]);
    expect(routes.length).toBeGreaterThan(2);
    expect(JS).not.toContain('/v1/partenaires/');
  });

  it('[R76] [R74] le texte des rémunérations est montré, puis l’accord noté devient une preuve que l’accord reprend', async () => {
    const t = await run();
    await t.open();
    const body = t.els['partenaires-corps']!;
    t.table['GET /v1/partenaires/relations/r1/remunerations'] = ok({ text: `Zoé Notaires : aucune rémunération. ${INJECTED}`, fees: [], textSha256: 'x' });
    await t.click(t.byText(body, 'Montrer au client le texte des rémunérations'));
    expect(body.textContent).toContain(`Zoé Notaires : aucune rémunération. ${INJECTED}`);
    // Sans choix coché, rien ne part.
    await t.click(t.byText(body, 'Enregistrer son accord'));
    expect(t.els['partenaires-etat']!.textContent).toBe('Cochez le professionnel choisi par le client.');
    const radios = body.all().filter((e) => e.tagName === 'input' && e.attributes.type === 'radio');
    expect(radios.map((r) => r.value)).toEqual(['pz', 'pm', 'pa']);
    radios[2]!.checked = true;
    // Note trop courte : dit, rien ne part.
    const note = body.all().find((e) => e.tagName === 'textarea')!;
    note.value = 'oui';
    const before = t.calls.length;
    await t.click(t.byText(body, 'Enregistrer son accord'));
    expect(t.calls.length).toBe(before);
    expect(t.els['partenaires-etat']!.textContent).toBe('Notez ce que le client a dit, en 10 à 1 000 caractères.');
    note.value = '  Choisi au téléphone ce matin, après lecture du texte.  ';
    const select = body.all().find((e) => e.tagName === 'select' && e.attributes.id?.startsWith('canal-'))!;
    select.value = 'sms';
    t.table['POST /v1/partenaires/relations/r1/preuve-accord'] = ok({ proofRef: 'relations/r1/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.txt', sha256: 'e'.repeat(64), at: '2027-07-12T08:05:00.000Z', channel: 'sms' });
    t.table['POST /v1/partenaires/relations/r1/accord'] = ok(referral({ state: 'accord_client', chosenPartnerId: 'pa' }));
    t.table['GET /v1/partenaires/projets'] = ok({ projects: [{ ...PROJECTS[0], referrals: [referral({ state: 'accord_client', chosenPartnerId: 'pa', consent: { at: '2027-07-12T08:05:00.000Z', channel: 'sms' } })] }], page: 0, more: false });
    await t.click(t.byText(body, 'Enregistrer son accord'));
    const posts = t.calls.filter((c) => c.method === 'POST');
    expect(posts[0]).toMatchObject({ url: '/v1/partenaires/relations/r1/preuve-accord', body: JSON.stringify({ channel: 'sms', note: 'Choisi au téléphone ce matin, après lecture du texte.' }) });
    // L'accord reprend la preuve rangée et l'heure du serveur, jamais l'heure du téléphone.
    expect(posts[1]).toMatchObject({
      url: '/v1/partenaires/relations/r1/accord',
      body: JSON.stringify({ partnerId: 'pa', consentAt: '2027-07-12T08:05:00.000Z', channel: 'sms', proofRef: 'relations/r1/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.txt' }),
    });
    expect(t.els['partenaires-etat']!.textContent).toBe('Accord du client enregistré.');
    expect(t.els['partenaires-corps']!.textContent).toContain('Arnaud Notaires · choisi par le client');
    expect(t.els['partenaires-corps']!.textContent).toContain('Accord du client par SMS, le ');
    expect(t.byText(t.els['partenaires-corps']!, 'Confier la demande à Arnaud Notaires')).toBeDefined();
  });

  it('[R76] un refus est dit en clair, sans code interne', async () => {
    const t = await run();
    await t.open();
    const body = t.els['partenaires-corps']!;
    body.all().filter((e) => e.tagName === 'input' && e.attributes.type === 'radio')[0]!.checked = true;
    body.all().find((e) => e.tagName === 'textarea')!.value = 'Choisi de vive voix au bureau.';
    t.table['POST /v1/partenaires/relations/r1/preuve-accord'] = ok({ proofRef: 'relations/r1/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.txt', sha256: 'e'.repeat(64), at: '2027-07-12T08:05:00.000Z', channel: 'oral' });
    t.table['POST /v1/partenaires/relations/r1/accord'] = no(409, { ok: false, rule: 'R76', code: 'fees_not_disclosed' });
    await t.click(t.byText(body, 'Enregistrer son accord'));
    expect(t.els['partenaires-etat']!.textContent).toBe('Montrez d’abord au client le texte des rémunérations, puis notez son accord.');
    expect(t.els['partenaires-etat']!.textContent).not.toMatch(/R76|fees_/);
  });

  it('proposer : métier, diagnostic, bien ou code postal ; le tirage revient dans l’écran relu', async () => {
    const t = await run();
    await t.open();
    const body = t.els['partenaires-corps']!;
    const trades = body.all().filter((e) => e.tagName === 'select' && e.attributes.id?.startsWith('metier-'));
    expect(trades).toHaveLength(2);
    trades[0]!.value = 'diagnostiqueur';
    body.all().find((e) => e.tagName === 'select' && e.attributes.id?.startsWith('domaine-'))!.value = 'amiante';
    t.table['POST /v1/partenaires/relations'] = ok(referral({ referralId: 'r2' }));
    const buttons = body.all().filter((e) => e.tagName === 'button' && e.textContent === 'Tirer au sort et proposer au client');
    await t.click(buttons[0]);
    expect(t.calls.find((c) => c.method === 'POST')).toEqual({ method: 'POST', url: '/v1/partenaires/relations', body: JSON.stringify({ projectId: 'pr1', trade: 'diagnostiqueur', domain: 'amiante', propertyId: 'b1' }), auth: `Bearer ${KEY}` });
    expect(t.calls.at(-1)).toMatchObject({ method: 'GET', url: '/v1/partenaires/projets' });
    expect(t.els['partenaires-etat']!.textContent).toBe('Tirage fait : montrez au client les professionnels proposés, dans cet ordre.');
    // Sans bien : le code postal ; aucun professionnel dans la zone, dit en clair [R73].
    t.calls.length = 0;
    const cps = t.els['partenaires-corps']!.all().filter((e) => e.attributes.id?.startsWith('cp-'));
    expect(cps).toHaveLength(2);
    // Un bien sans code postal : le code saisi part avec le bien.
    cps[0]!.value = '21000';
    t.table['POST /v1/partenaires/relations'] = ok(referral({ referralId: 'r3' }));
    await t.click(t.els['partenaires-corps']!.all().filter((e) => e.tagName === 'button' && e.textContent === 'Tirer au sort et proposer au client')[0]);
    expect(t.calls[0]).toMatchObject({ body: JSON.stringify({ projectId: 'pr1', trade: 'notaire', propertyId: 'b1', postcode: '21000' }) });
    t.calls.length = 0;
    const cp = t.els['partenaires-corps']!.all().filter((e) => e.attributes.id?.startsWith('cp-'))[1]!;
    cp.value = ' 21240 ';
    t.table['POST /v1/partenaires/relations'] = no(409, { ok: false, rule: 'R73', code: 'no_partner' });
    const again = t.els['partenaires-corps']!.all().filter((e) => e.tagName === 'button' && e.textContent === 'Tirer au sort et proposer au client');
    await t.click(again[1]);
    expect(t.calls[0]).toMatchObject({ body: JSON.stringify({ projectId: 'pr2', trade: 'notaire', postcode: '21240' }) });
    expect(t.els['partenaires-etat']!.textContent).toBe('Aucun professionnel de ce métier n’est disponible dans cette zone aujourd’hui.');
  });

  it('suivre une demande confiée : délai, relance en essai, pièces rangées ; terminer ; abandonner en deux gestes', async () => {
    const t = await run({
      'GET /v1/partenaires/projets': ok({ projects: [{ ...PROJECTS[0], referrals: [referral({ state: 'confiee', chosenPartnerId: 'pz' })] }], page: 0, more: false }),
      'GET /v1/partenaires/relations/r1/suivi': ok({ measure: { referralId: 'r1', state: 'confiee', entrustedAt: '2027-07-12T08:00:00.000Z', firstResponseAt: null, delayMinutes: 3000, answered: false }, followUps: [{ kind: 'relance', recipient: 'partner:pz', text: 'x', dueAt: '2027-07-14T08:00:00.000Z', preparedAt: '2027-07-14T08:00:00.000Z' }] }),
      'GET /v1/partenaires/relations/r1/pieces': ok([{ documentId: 'd1', sort: 'titre_propriete', version: 2, destination: 'sale_file', targetId: 's1', piece: null, reason: 'rule' }]),
      'GET /v1/partenaires/relations/r1/resume': ok({ summary: { headline: `Pas encore de réponse ${INJECTED}`, points: ['Confiée le 12 juillet.'] }, source: 'secours' }),
    });
    await t.open();
    const body = t.els['partenaires-corps']!;
    await t.click(t.byText(body, 'Voir ses réponses et ses pièces'));
    const text = body.textContent;
    expect(text).toContain('Sans réponse depuis 2 j.');
    expect(text).toContain('Relance préparée pour le ');
    expect(text).toContain('mode essai, rien ne part');
    expect(text).toContain('Titre de propriété, version 2');
    expect(text).toContain('rangée dans le dossier de vente');
    expect(text).toContain(`Pas encore de réponse ${INJECTED}`);
    expect(text).not.toMatch(/\bIA\b|intelligence artificielle|secours/);
    t.table['POST /v1/partenaires/relations/r1/cloture'] = ok(referral({ state: 'abandonnee' }));
    const drop = t.byText(body, 'Abandonner la demande')!;
    await t.click(drop);
    expect(t.calls.some((c) => c.method === 'POST')).toBe(false);
    expect(drop.textContent).toBe('Confirmer l’abandon');
    await t.click(drop);
    expect(t.calls.find((c) => c.method === 'POST')).toMatchObject({ url: '/v1/partenaires/relations/r1/cloture', body: JSON.stringify({ outcome: 'abandonnee' }) });
    expect(t.els['partenaires-etat']!.textContent).toBe('Demande abandonnée.');
  });

  it('accessible : chaque champ a son libellé, chaque choix son groupe nommé ; refus, panne et retour', async () => {
    const t = await run();
    await t.open();
    const body = t.els['partenaires-corps']!;
    const labels = new Set(body.all().filter((e) => e.tagName === 'label').map((l) => l.attributes.for));
    for (const f of body.all().filter((e) => ['input', 'select', 'textarea'].includes(e.tagName))) expect(labels.has(f.attributes.id), f.attributes.id).toBe(true);
    const fieldset = body.all().find((e) => e.tagName === 'fieldset')!;
    expect(fieldset.children[0]!.tagName).toBe('legend');
    expect(HTML).toMatch(/<p id="partenaires-etat" class="etat" role="status">/);
    await t.click(t.els['partenaires-retour']);
    expect(t.els.accueil!.hidden).toBe(false);
    expect(t.els['partenaires-corps']!.children).toHaveLength(0);
    const denied = await run({ 'GET /v1/partenaires/projets': no(403, { ok: false, rule: 'R16', code: 'role' }) });
    await denied.click(denied.els['partenaires-ouvrir']);
    expect(denied.els['partenaires-etat']!.textContent).toBe('Ces demandes ne sont pas dans vos droits.');
    expect(denied.els['partenaires-corps']!.children).toHaveLength(0);
    const offline = await run({ 'GET /v1/partenaires/projets': () => Promise.reject(new TypeError('hors ligne')) });
    await offline.click(offline.els['partenaires-ouvrir']);
    expect(offline.els['partenaires-etat']!.textContent).toBe('Pas de réseau. Réessayez dans un moment.');
    expect(offline.storage.get('aimmo.cle')).toBe(KEY);
    const gone = await run({ 'GET /v1/partenaires/projets': no(401, { ok: false }) });
    await gone.click(gone.els['partenaires-ouvrir']);
    expect(gone.storage.get('aimmo.cle')).toBeUndefined();
    expect(gone.els.connexion!.hidden).toBe(false);
    const empty = await run({ 'GET /v1/partenaires/projets': ok({ projects: [], page: 0, more: false }) });
    await empty.click(empty.els['partenaires-ouvrir']);
    expect(empty.els['partenaires-corps']!.textContent).toBe('Aucun projet suivi pour le moment.');
  });

  it('par pages : les projets au-delà de la première page restent atteignables, dans leur ordre', async () => {
    const t = await run({
      'GET /v1/partenaires/projets': ok({ projects: [PROJECTS[0]], page: 0, more: true }),
      'GET /v1/partenaires/projets?page=1': ok({ projects: [PROJECTS[1]], page: 1, more: false }),
    });
    await t.open();
    await t.click(t.byText(t.els['partenaires-corps']!, 'Projets suivants'));
    expect(t.calls.at(-1)).toMatchObject({ method: 'GET', url: '/v1/partenaires/projets?page=1' });
    expect(t.els['partenaires-corps']!.textContent).toContain(`Acheter · ${INJECTED}`);
    expect(t.byText(t.els['partenaires-corps']!, 'Projets suivants')).toBeUndefined();
    await t.click(t.byText(t.els['partenaires-corps']!, 'Projets précédents'));
    expect(t.calls.at(-1)).toMatchObject({ method: 'GET', url: '/v1/partenaires/projets' });
  });

  it('des pièces illisibles ne sont jamais dites absentes', async () => {
    const t = await run({
      'GET /v1/partenaires/projets': ok({ projects: [{ ...PROJECTS[0], referrals: [referral({ state: 'confiee', chosenPartnerId: 'pz' })] }], page: 0, more: false }),
      'GET /v1/partenaires/relations/r1/suivi': ok({ measure: { answered: true, delayMinutes: 90, entrustedAt: '2027-07-12T08:00:00.000Z' }, followUps: [] }),
      'GET /v1/partenaires/relations/r1/pieces': no(500, { ok: false }),
      'GET /v1/partenaires/relations/r1/resume': no(500, { ok: false }),
    });
    await t.open();
    await t.click(t.byText(t.els['partenaires-corps']!, 'Voir ses réponses et ses pièces'));
    const text = t.els['partenaires-corps']!.textContent;
    expect(text).toContain('Première réponse en 2 h.');
    expect(text).toContain('Pièces indisponibles pour le moment');
    expect(text).not.toContain('Aucune pièce déposée');
  });

  it('une demande terminée garde son suivi lisible, sans geste pour la clore de nouveau', async () => {
    const t = await run({ 'GET /v1/partenaires/projets': ok({ projects: [{ ...PROJECTS[0], referrals: [referral({ state: 'terminee', chosenPartnerId: 'pz' })] }], page: 0, more: false }) });
    await t.open();
    const body = t.els['partenaires-corps']!;
    expect(t.byText(body, 'Voir ses réponses et ses pièces')).toBeDefined();
    expect(t.byText(body, 'Marquer la demande terminée')).toBeUndefined();
    expect(t.byText(body, 'Abandonner la demande')).toBeUndefined();
  });
});
