import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { CLES_SCRIPT } from '../app/cles.ts';
import { AGENT_APP_FILES } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// AU023 · Tout est inventé : clés de test, séance, appareils, défis, identifiants, dates.
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const KEY = 'k'.repeat(40);
const TOKEN = 's'.repeat(43);
const WHO = { networkId: 'n-1', role: 'agent', userId: 'agent-2' };
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64url');
const CHALLENGE = { challengeId: 'c-1', challenge: b64([1, 2, 3]), rpId: 'app.aimmo.test', expiresAt: '2027-03-10T09:05:00.000Z', credentialIds: [b64([7, 7, 7])] };
const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(answers: Record<string, Answer>, stored: Record<string, string>) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const storage = new Map<string, string>(Object.entries(stored));
  const calls: { method: string; url: string; body: unknown; auth: string | null }[] = [];
  const asked: unknown[] = [];
  const table: Record<string, Answer> = {
    'POST /v1/cles/connexion/debut': ok(CHALLENGE),
    'POST /v1/cles/connexion/fin': ok({ token: TOKEN, expiresAt: '2027-03-10T21:00:00.000Z', viewer: WHO, deviceId: 'd-1' }),
    [`GET /v1/moi`]: ok({ role: 'agent', firstName: 'Sam' }),
    ...answers,
  };
  const context: Record<string, unknown> = {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, body: typeof init.body === 'string' ? JSON.parse(init.body) : null, auth: init.headers?.authorization ?? null });
      const a = table[`${method} ${url}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    Intl,
    Date,
    btoa,
    atob,
    crypto: globalThis.crypto,
    location: { origin: 'https://app.aimmo.test', hash: '' },
    setTimeout: () => 0,
    navigator: {
      serviceWorker: { register: () => Promise.resolve({}) },
      credentials: {
        create: () => Promise.reject(new Error('pas ici')),
        get: (o: unknown) => {
          asked.push(o);
          return Promise.resolve({ rawId: new Uint8Array([7, 7, 7]).buffer, response: { clientDataJSON: new Uint8Array([8]).buffer, authenticatorData: new Uint8Array([9]).buffer, signature: new Uint8Array([10]).buffer } });
        },
      },
    },
    PublicKeyCredential: function PublicKeyCredential() {},
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const scripts = () => els.reseau!.children.filter((e) => e.tagName === 'script' && e.attributes.src === '/app/cles.js');
  /** Le navigateur charge `/app/cles.js` : le script tourne, puis son chargement est annoncé. */
  const load = async () => {
    const s = scripts();
    if (s.length !== 1 || context.loaded) return;
    runInNewContext(CLES_SCRIPT, context);
    context.loaded = true;
    s[0]!.listeners.load!({});
    await settle();
  };
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  return { els, calls, storage, asked, scripts, load, click, context };
}

describe('AU023 · l’écran de connexion passe par la clé de l’appareil, sans clé à taper', () => {
  it('[R600] constat : l’écran de connexion ne demandait qu’une clé personnelle ; il dit maintenant le lien d’accès, la clé tapée n’est plus qu’un secours', async () => {
    const t = await run({}, {});
    const section = HTML.slice(HTML.indexOf('<section id="connexion"'), HTML.indexOf('<section id="invitation"'));
    expect(section).not.toContain('Saisissez votre clé personnelle');
    expect(section).toContain('demandez à la direction votre lien d’accès');
    // Le champ de la clé est replié sous « J’ai une clé personnelle ».
    expect(section.indexOf('<details><summary>J’ai une clé personnelle</summary>')).toBeLessThan(section.indexOf('id="cle"'));
    expect(t.els.connexion!.hidden).toBe(false);
    // Sans clé d'appareil retenue, aucun bouton qui ne mènerait nulle part.
    expect(t.els['entrer-appareil']!.hidden).toBe(true);
    expect(t.calls).toEqual([]);
  });

  it('[R600] [R201] un appui sur « Entrer avec la clé de cet appareil » : défi, empreinte, séance ; rien à taper, aucune clé envoyée', async () => {
    const t = await run({}, { 'aimmo.appareil': JSON.stringify(WHO) });
    expect(t.els['entrer-appareil']!.hidden).toBe(false);
    // Le script des clés n'est chargé qu'au geste.
    expect(t.scripts()).toHaveLength(0);
    await t.click(t.els['entrer-appareil']);
    await t.load();
    expect(t.calls.slice(0, 2)).toEqual([
      { method: 'POST', url: '/v1/cles/connexion/debut', body: WHO, auth: null },
      { method: 'POST', url: '/v1/cles/connexion/fin', body: { challengeId: 'c-1', credentialId: b64([7, 7, 7]), clientDataJSON: b64([8]), authenticatorData: b64([9]), signature: b64([10]) }, auth: null },
    ]);
    const ask = (t.asked[0] as { publicKey: { userVerification: string; rpId: string; allowCredentials: { id: Uint8Array }[] } }).publicKey;
    expect(ask.userVerification).toBe('required');
    expect(ask.allowCredentials.map((c) => [...c.id])).toEqual([[7, 7, 7]]);
    // La séance ouvre la journée, comme une clé.
    expect(t.calls[2]).toMatchObject({ method: 'GET', url: '/v1/moi', auth: `Bearer ${TOKEN}` });
    expect(t.storage.get('aimmo.cle')).toBe(TOKEN);
    expect(t.els.accueil!.hidden).toBe(false);
    expect(t.els.bonjour!.textContent).toBe('Bonjour Sam');
  });

  it('[R600] une clé retirée, en attente ou absente : dit en mots, avec le recours du lien ; rien n’est gardé', async () => {
    const t = await run({ 'POST /v1/cles/connexion/debut': no(403, { ok: false, rule: 'R600', code: 'connexion_refusee' }) }, { 'aimmo.appareil': JSON.stringify(WHO) });
    await t.click(t.els['entrer-appareil']);
    await t.load();
    expect(t.els.erreur!.hidden).toBe(false);
    expect(t.els.erreur!.textContent).toBe('Cette clé n’ouvre pas AIMMO : retirée, en attente de l’accord de la direction, ou absente de cet appareil. Demandez votre lien d’accès à la direction.');
    expect(t.storage.get('aimmo.cle')).toBeUndefined();
    expect(t.els.connexion!.hidden).toBe(false);
    // Une identité abîmée ne part pas.
    const u = await run({}, { 'aimmo.appareil': '{"networkId":"n 1","role":"pirate","userId":"x"}' });
    await u.click(u.els['entrer-appareil']);
    await u.load();
    expect(u.calls).toEqual([]);
  });

  it('[R600] le script des clés ne se charge pas (sans réseau) : dit en mots, on peut réessayer', async () => {
    const t = await run({}, { 'aimmo.appareil': JSON.stringify(WHO) });
    await t.click(t.els['entrer-appareil']);
    t.scripts()[0]!.listeners.error!({});
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    expect(t.els.erreur!.hidden).toBe(false);
    expect(t.els.erreur!.textContent).toBe('Pas de réseau. Réessayez dans un moment.');
    expect(t.storage.get('aimmo.cle')).toBeUndefined();
  });

  it('[R600] l’appareil retient qui il sert dès qu’une clé active est rangée : réseau, rôle, identifiant, rien de secret', async () => {
    const t = await run(
      {
        'GET /v1/cles/mes-appareils': ok([{ id: 'd-1', userRole: 'agent', userId: 'agent-2', label: 'Téléphone pro', status: 'actif', createdAt: '2027-03-01T09:00:00.000Z', approvedAt: null, revokedAt: null }]),
        'GET /v1/cles/identite': ok(WHO),
      },
      { 'aimmo.cle': KEY },
    );
    await t.click(t.els['cles-accueil-voir']);
    await t.load();
    expect(JSON.parse(t.storage.get('aimmo.appareil')!)).toEqual(WHO);
    expect(t.storage.get('aimmo.appareil')).not.toContain(KEY);
    // Une clé encore en attente de l'accord compte aussi : acceptée plus tard, elle connecte sans rouvrir la liste.
    const p = await run(
      {
        'GET /v1/cles/mes-appareils': ok([{ id: 'd-5', userRole: 'agent', userId: 'agent-2', label: 'Neuf', status: 'en_attente', createdAt: '2027-03-01T09:00:00.000Z', approvedAt: null, revokedAt: null }]),
        'GET /v1/cles/identite': ok(WHO),
      },
      { 'aimmo.cle': KEY },
    );
    await p.click(p.els['cles-accueil-voir']);
    await p.load();
    expect(JSON.parse(p.storage.get('aimmo.appareil')!)).toEqual(WHO);
    // La sortie efface la clé, garde l'identité : le bouton de l'appareil reste proposé.
    await t.click(t.els.sortir);
    expect(t.storage.get('aimmo.cle')).toBeUndefined();
    expect(t.els['entrer-appareil']!.hidden).toBe(false);
  });
});

describe('AU023 · la direction prépare le lien nominatif d’un agent, sur la preuve de sa clé', () => {
  const direction = (extra: Record<string, Answer> = {}) =>
    run(
      {
        'GET /v1/moi': ok({ role: 'direction', firstName: null }),
        'GET /v1/cles/mes-appareils': ok([]),
        'GET /v1/cles/appareils': ok([]),
        'GET /v1/cles/invitations/agents': ok([{ id: 'agent-2', name: 'Sam Imaginaire' }, { id: 'pas un id', name: 'Pirate' }]),
        'POST /v1/cles/preuve/debut': ok(CHALLENGE),
        'POST /v1/cles/preuve/fin': ok({ stepUpId: 'p-1', action: 'modifier_droits', subject: 'agent:agent-2', expiresAt: '2027-03-10T09:05:00.000Z' }),
        'POST /v1/cles/invitations': ok({ lien: `/app/#invitation=${'j'.repeat(43)}`, expiresAt: '2027-03-11T09:00:00.000Z', keysRevoked: 1, linksVoided: 0, devicesRevoked: 1 }),
        ...extra,
      },
      { 'aimmo.cle': KEY },
    );
  const open = async (t: Awaited<ReturnType<typeof run>>) => {
    await t.click(t.els['cles-reseau-voir']);
    await t.load();
    const body = t.els['cles-reseau-corps']!;
    const find = (text: string) => body.all().find((e) => e.tagName === 'button' && e.textContent === text);
    await t.click(find('Choisir l’agent'));
    return { body, find, lost: body.all().find((e) => e.attributes.id === 'cles-perdu')! };
  };

  it('[R601] [R13] le lien se prépare sur la preuve de la clé pour cet agent seul, puis se montre une fois, à remettre de vive voix', async () => {
    const t = await direction();
    const { body, find } = await open(t);
    expect(find('Lien pour Pirate')).toBeUndefined();
    await t.click(find('Lien pour Sam Imaginaire'));
    const posts = t.calls.filter((c) => c.method === 'POST').map((c) => [c.url, c.body]);
    expect(posts[0]).toEqual(['/v1/cles/preuve/debut', { action: 'modifier_droits', subject: 'agent:agent-2' }]);
    expect(posts[2]).toEqual(['/v1/cles/invitations', { userId: 'agent-2', stepUpId: 'p-1', retirerAnciens: false }]);
    const text = body.all().map((e) => e.textContent).join(' | ');
    expect(text).toContain(`https://app.aimmo.test/app/#invitation=${'j'.repeat(43)}`);
    expect(text).toContain('Lien prêt pour Sam Imaginaire, valable une fois, jusqu’au 11/03/2027.');
    expect(text).not.toContain('Anciens accès coupés');
    expect(text).not.toContain('agent-2');
  });

  it('[R600] téléphone perdu : la case coupe les anciens accès, et l’écran dit ce qui a été coupé et ce qui reste à faire', async () => {
    const t = await direction();
    const { body, find, lost } = await open(t);
    lost.checked = true;
    await t.click(find('Lien pour Sam Imaginaire'));
    expect(t.calls.find((c) => c.url === '/v1/cles/invitations')!.body).toEqual({ userId: 'agent-2', stepUpId: 'p-1', retirerAnciens: true });
    const text = body.all().map((e) => e.textContent).join(' | ');
    expect(text).toContain('Anciens accès coupés : 1 lien ou clé d’application, 1 clé d’appareil. Sa clé neuve attendra votre accord ici.');
  });

  it('[R601] sans clé de la direction, ou agent parti : dit en mots, aucun lien montré', async () => {
    const t = await direction({ 'POST /v1/cles/preuve/debut': no(409, { ok: false, rule: 'R601', code: 'no_device' }) });
    const { body, find } = await open(t);
    await t.click(find('Lien pour Sam Imaginaire'));
    let text = body.all().map((e) => e.textContent).join(' | ');
    expect(text).toContain('Aucune clé active sur vos appareils : rangez d’abord la clé de cet appareil.');
    expect(text).not.toContain('#invitation=');
    expect(t.calls.some((c) => c.url === '/v1/cles/invitations')).toBe(false);
    const u = await direction({ 'POST /v1/cles/invitations': no(404, { ok: false, rule: 'R16', code: 'unknown' }) });
    const v = await open(u);
    await u.click(v.find('Lien pour Sam Imaginaire'));
    text = v.body.all().map((e) => e.textContent).join(' | ');
    expect(text).toContain('Cet agent n’est plus actif dans votre réseau.');
  });
});
