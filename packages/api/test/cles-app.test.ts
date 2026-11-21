import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { CLES_SCRIPT } from '../app/cles.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : clé de test, appareils, défis, identifiants, dates.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64url');
const PUBLIC_KEY = [48, 89, 48, 19, 6, 7, 42, 134, 72, 206, 61, 2, 1];
const device = (extra: Record<string, unknown>) => ({ id: 'd-1', userRole: 'agent', userId: 'agent-1', label: 'Téléphone pro', status: 'actif', createdAt: '2027-03-01T09:00:00.000Z', approvedAt: '2027-03-01T09:00:00.000Z', revokedAt: null, ...extra });
const MINE = [device({}), device({ id: 'd-2', label: 'Tablette', status: 'retire', revokedAt: '2027-03-05T09:00:00.000Z' }), device({ id: 'd-3', label: 'Ordinateur', status: 'etat_jamais_vu' })];
const CHALLENGE = { challengeId: 'c-1', challenge: b64([1, 2, 3, 4, 5, 6]), rpId: 'app.aimmo.test', expiresAt: '2027-03-10T09:05:00.000Z', credentialIds: [b64([7, 7, 7])] };
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

interface Device {
  create?: (o: unknown) => Promise<unknown>;
  get?: (o: unknown) => Promise<unknown>;
  noWebAuthn?: boolean;
}

async function run(answers: Record<string, Answer> = {}, role = 'agent', dev: Device = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const page = document as typeof document & { body: FakeElement };
  page.body = new FakeElement('body');
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; body: unknown }[] = [];
  const asked: { create: any[]; get: any[] } = { create: [], get: [] };
  const table: Record<string, Answer> = {
    'GET /v1/moi': ok({ role, firstName: 'Alex' }),
    'GET /v1/cles/mes-appareils': ok(MINE),
    'GET /v1/cles/appareils': ok([...MINE, device({ id: 'd-9', userRole: 'agent', userId: 'agent-2', ownerName: 'Sam Imaginaire', label: 'Téléphone de Sam', status: 'en_attente', approvedAt: null }), device({ id: 'd-7', userRole: 'agent', userId: 'agent-3', ownerName: null, label: 'Téléphone de Lou', status: 'en_attente', approvedAt: null }), device({ id: 'd-8', userRole: 'compliance', userId: 'conf-1', label: 'Poste conformité' })]),
    'POST /v1/cles/enregistrement/debut': ok(CHALLENGE),
    'POST /v1/cles/enregistrement/fin': ok(device({ id: 'd-4', label: 'Mon téléphone', status: 'en_attente', approvedAt: null })),
    'POST /v1/cles/preuve/debut': ok(CHALLENGE),
    'POST /v1/cles/preuve/fin': ok({ stepUpId: 'p-1', action: 'approuver_appareil', subject: 'device:d-9', expiresAt: '2027-03-10T09:05:00.000Z' }),
    'POST /v1/cles/appareils/d-9/accord': ok(device({ id: 'd-9', status: 'actif' })),
    'POST /v1/cles/appareils/d-1/retrait': ok(device({ status: 'retire' })),
    ...answers,
  };
  const credentials = {
    create: (o: unknown) => {
      asked.create.push(o);
      return dev.create
        ? dev.create(o)
        : Promise.resolve({
            rawId: new Uint8Array([4, 4, 4]).buffer,
            response: { clientDataJSON: new Uint8Array([5, 5]).buffer, getPublicKey: () => new Uint8Array(PUBLIC_KEY).buffer, getPublicKeyAlgorithm: () => -7, getAuthenticatorData: () => new Uint8Array([6, 6]).buffer },
          });
    },
    get: (o: unknown) => {
      asked.get.push(o);
      return dev.get ? dev.get(o) : Promise.resolve({ rawId: new Uint8Array([7, 7, 7]).buffer, response: { clientDataJSON: new Uint8Array([8]).buffer, authenticatorData: new Uint8Array([9]).buffer, signature: new Uint8Array([10, 11]).buffer } });
    },
  };
  const context: Record<string, unknown> = {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: string } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, body: typeof init.body === 'string' ? JSON.parse(init.body) : null });
      const a = table[`${method} ${url}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    Intl,
    Date,
    btoa,
    atob,
    crypto: globalThis.crypto,
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) }, ...(dev.noWebAuthn ? {} : { credentials }) },
    ...(dev.noWebAuthn ? {} : { PublicKeyCredential: function PublicKeyCredential() {} }),
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const place = role === 'agent' ? 'accueil' : role === 'direction' ? 'reseau' : 'conformite';
  const body = () => els[`cles-${place}-corps`]!;
  const state = () => els[`cles-${place}-etat`]!.textContent;
  const texts = () => body().all().map((e) => e.textContent).join(' | ');
  const find = (text: string) => body().all().find((e) => e.tagName === 'button' && e.textContent === text);
  const buttons = () => body().all().filter((e) => e.tagName === 'button').map((e) => e.textContent);
  const input = (id: string) => body().all().find((e) => e.attributes.id === id)!;
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  const scripts = () => els.reseau!.children.filter((e) => e.tagName === 'script' && e.attributes.src === '/app/cles.js');
  let tools: { show: (p: string, m: string) => Promise<boolean>; prove: (a: string, s: string) => Promise<{ ok: boolean; stepUpId?: string; text: string }> } | null = null;
  const voir = async () => {
    await click(els[`cles-${place}-voir`]);
    const s = scripts();
    if (s.length === 1 && !context.loaded) {
      runInNewContext(CLES_SCRIPT, context);
      const make = context.AIMMO_CLES as (t: unknown) => typeof tools;
      context.AIMMO_CLES = (t: unknown) => (tools = make(t));
      context.loaded = true;
      s[0]!.listeners.load!({});
      await settle();
    }
  };
  const prove = async (action: string, subject: string) => {
    if (!tools) await voir();
    const p = tools!.prove(action, subject);
    await settle();
    return p;
  };
  const posts = () => calls.filter((c) => c.method === 'POST');
  return { els, calls, table, asked, body, state, texts, find, buttons, input, click, voir, prove, posts, scripts, storage };
}

describe('BR18 · la clé de cet appareil et la preuve d’une action, à l’écran', () => {
  it('[R201] [R600] le script ne se charge qu’au premier geste ; chacun lit ses clés, chaque état dit en mots, jamais un code', async () => {
    const t = await run();
    expect(t.scripts()).toHaveLength(0);
    expect(t.calls.some((c) => c.url.startsWith('/v1/cles'))).toBe(false);
    await t.voir();
    const x = t.texts();
    expect(x).toContain('Mes clés');
    expect(x).toContain('Téléphone pro');
    expect(x).toContain('Active · rangée le 01/03/2027.');
    expect(x).toContain('Retirée : elle ne se connecte plus · rangée le 01/03/2027, retirée le 05/03/2027.');
    expect(x).toContain('État que cet écran ne sait pas encore dire · rangée le 01/03/2027.');
    for (const code of ['actif', 'retire', 'etat_jamais_vu', 'd-1', 'agent-1']) expect(x).not.toContain(code);
    // L'agent ne lit que les siennes : jamais la liste du réseau.
    expect(t.calls.some((c) => c.url === '/v1/cles/appareils')).toBe(false);
    expect(x).not.toContain('Les clés du réseau');
    // Une clé retirée n'a plus de geste.
    expect(t.buttons().filter((b) => b.includes('Tablette'))).toEqual([]);
    expect(t.state()).toBe('');
  });

  it('[R600] AU108 · l’identité de l’appareil se retient avant de ranger sa clé : la clé d’application cesse aussitôt après', async () => {
    const who = { networkId: 'n-1', role: 'agent', userId: 'agent-1' };
    const t = await run({ 'GET /v1/cles/mes-appareils': ok([]), 'GET /v1/cles/identite': ok(who) });
    await t.voir();
    t.input('cles-accueil-nom').value = 'Mon téléphone';
    await t.click(t.find('Ranger la clé de cet appareil'));
    await settle();
    const order = t.calls.map((c) => `${c.method} ${c.url}`);
    expect(order.indexOf('GET /v1/cles/identite')).toBeLessThan(order.indexOf('POST /v1/cles/enregistrement/fin'));
    expect(JSON.parse(t.storage.get('aimmo.appareil')!)).toEqual(who);
    expect(t.storage.get('aimmo.appareil')).not.toContain(KEY);
  });

  it('[R600] la clé de cet appareil se range par navigator.credentials.create sur le défi du serveur ; la clé publique n’est jamais montrée', async () => {
    const t = await run();
    await t.voir();
    await t.click(t.find('Ranger la clé de cet appareil'));
    expect(t.state()).toBe('Le nom de l’appareil : de 1 à 40 lettres, chiffres, espaces, tirets ou apostrophes.');
    expect(t.posts()).toEqual([]);
    t.input('cles-accueil-nom').value = '  Mon   téléphone ';
    await t.click(t.find('Ranger la clé de cet appareil'));
    const ask = t.asked.create[0].publicKey;
    expect([...ask.challenge]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ask.rp).toEqual({ id: 'app.aimmo.test', name: 'AIMMO' });
    expect(ask.pubKeyCredParams).toEqual([{ type: 'public-key', alg: -7 }]);
    expect(ask.authenticatorSelection.userVerification).toBe('required');
    expect(ask.excludeCredentials.map((c: { id: Uint8Array }) => [...c.id])).toEqual([[7, 7, 7]]);
    expect(t.posts()).toEqual([
      { method: 'POST', url: '/v1/cles/enregistrement/debut', body: null },
      { method: 'POST', url: '/v1/cles/enregistrement/fin', body: { challengeId: 'c-1', credentialId: b64([4, 4, 4]), publicKey: b64(PUBLIC_KEY), clientDataJSON: b64([5, 5]), authenticatorData: b64([6, 6]), label: 'Mon téléphone' } },
    ]);
    expect(t.state()).toBe('Clé de cet appareil rangée : elle attend l’accord de la direction avant de servir.');
    // La clé publique part au serveur, jamais à l'écran.
    expect(t.texts()).not.toContain(b64(PUBLIC_KEY));
    expect(JSON.stringify(t.els)).not.toContain(b64(PUBLIC_KEY));
  });

  it('[R601] une preuve se demande pour une action et un objet, seulement ceux-là', async () => {
    const t = await run({}, 'direction');
    const p = await t.prove('approuver_appareil', 'device:d-9');
    expect(p).toEqual({ ok: true, stepUpId: 'p-1', text: '' });
    expect(t.posts().map((c) => [c.url, c.body])).toEqual([
      ['/v1/cles/preuve/debut', { action: 'approuver_appareil', subject: 'device:d-9' }],
      ['/v1/cles/preuve/fin', { challengeId: 'c-1', credentialId: b64([7, 7, 7]), clientDataJSON: b64([8]), authenticatorData: b64([9]), signature: b64([10, 11]) }],
    ]);
    const ask = t.asked.get[0].publicKey;
    expect(ask.rpId).toBe('app.aimmo.test');
    expect(ask.userVerification).toBe('required');
    expect(ask.allowCredentials.map((c: { id: Uint8Array }) => [...c.id])).toEqual([[7, 7, 7]]);
    // Une preuve rendue pour un autre objet ne sert pas ici.
    const other = await t.prove('approuver_appareil', 'device:d-7');
    expect(other).toMatchObject({ ok: false, text: 'La preuve faite porte sur un autre geste : recommencez.' });
    // Une action hors liste ou un objet illisible ne partent pas.
    const before = t.posts().length;
    expect(await t.prove('tout_faire', 'device:d-9')).toMatchObject({ ok: false });
    expect(await t.prove('export_complet', 'licence de tout')).toMatchObject({ ok: false });
    expect(t.posts()).toHaveLength(before);
  });

  it('appareil sans WebAuthn, refus de la personne, clés fermées (503) : dits en mots, rien ne part', async () => {
    const t = await run({}, 'agent', { noWebAuthn: true });
    await t.voir();
    expect(t.texts()).toContain('Cet appareil ou ce navigateur ne sait pas tenir de clé d’accès : ouvrez AIMMO dans un navigateur à jour.');
    expect(t.find('Ranger la clé de cet appareil')).toBeUndefined();
    expect(await t.prove('export_complet', 'agent:agent-1')).toMatchObject({ ok: false, text: 'Cet appareil ou ce navigateur ne sait pas tenir de clé d’accès : ouvrez AIMMO dans un navigateur à jour.' });
    expect(t.posts()).toEqual([]);
    const u = await run({}, 'agent', { create: () => Promise.reject(Object.assign(new Error('non'), { name: 'NotAllowedError' })), get: () => Promise.reject(Object.assign(new Error('non'), { name: 'NotAllowedError' })) });
    await u.voir();
    u.input('cles-accueil-nom').value = 'Mon téléphone';
    await u.click(u.find('Ranger la clé de cet appareil'));
    expect(u.state()).toBe('Rien n’est fait : la demande a été refusée sur l’appareil, ou son délai est passé.');
    expect(u.posts().map((c) => c.url)).toEqual(['/v1/cles/enregistrement/debut']);
    expect(await u.prove('export_complet', 'agent:agent-1')).toMatchObject({ ok: false, text: 'Rien n’est fait : la demande a été refusée sur l’appareil, ou son délai est passé.' });
    expect(u.posts().map((c) => c.url)).not.toContain('/v1/cles/preuve/fin');
    const v = await run({ 'GET /v1/cles/mes-appareils': no(503, { ok: false, rule: null, code: 'cles_non_configurees' }) });
    await v.voir();
    expect(v.state()).toBe('Les clés d’accès ne sont pas encore ouvertes sur ce service.');
    const w = await run({ 'POST /v1/cles/preuve/debut': no(503, { ok: false, rule: null, code: 'cles_non_configurees' }) });
    expect(await w.prove('export_complet', 'agent:agent-1')).toMatchObject({ ok: false, text: 'Les clés d’accès ne sont pas encore ouvertes sur ce service.' });
    const y = await run({ 'POST /v1/cles/preuve/debut': no(409, { ok: false, rule: 'R601', code: 'no_device' }) });
    expect(await y.prove('export_complet', 'agent:agent-1')).toMatchObject({ ok: false, text: 'Aucune clé active sur vos appareils : rangez d’abord la clé de cet appareil.' });
  });

  it('[R600] retirer une clé se fait en deux appuis', async () => {
    const t = await run();
    await t.voir();
    await t.click(t.find('Retirer « Téléphone pro »'));
    expect(t.posts()).toEqual([]);
    await t.click(t.find('Confirmer : « Téléphone pro » ne se connectera plus'));
    expect(t.posts()).toEqual([{ method: 'POST', url: '/v1/cles/appareils/d-1/retrait', body: null }]);
    expect(t.state()).toBe('Clé « Téléphone pro » retirée : elle ne se connecte plus.');
  });

  it('[R600] [R601] la direction lit les clés du réseau et accepte une clé en attente sur la preuve de la sienne', async () => {
    const t = await run({}, 'direction');
    await t.voir();
    const x = t.texts();
    expect(x).toContain('Les clés du réseau');
    expect(x).toContain('Téléphone de Sam');
    expect(x).toContain('En attente de l’accord de la direction · rangée le 01/03/2027.');
    expect(x).toContain('Conformité');
    // Le titulaire réel, tiré de la base, est dit avant le geste ; un titulaire illisible est signalé.
    expect(x).toContain('Agent · Sam Imaginaire');
    expect(x).toContain('Le titulaire de cette clé ne se lit pas : ne l’acceptez pas sans savoir à qui elle est.');
    expect(x).toContain('Avant d’accepter une clé, appelez la personne nommée : elle vous dit le nom qu’elle a donné à l’appareil.');
    for (const code of ['en_attente', 'compliance', 'agent-2', 'agent-3', 'd-9']) expect(x).not.toContain(code);
    // Ses propres clés ne reviennent pas dans la liste du réseau.
    expect(t.body().all().filter((e) => e.tagName === 'strong' && e.textContent === 'Téléphone pro')).toHaveLength(1);
    await t.click(t.find('Accepter « Téléphone de Sam »'));
    expect(t.posts().map((c) => [c.url, c.body])).toEqual([
      ['/v1/cles/preuve/debut', { action: 'approuver_appareil', subject: 'device:d-9' }],
      ['/v1/cles/preuve/fin', expect.objectContaining({ challengeId: 'c-1' })],
      ['/v1/cles/appareils/d-9/accord', { stepUpId: 'p-1' }],
    ]);
    expect(t.state()).toBe('Clé « Téléphone de Sam » acceptée : elle est active.');
    // La direction accepte aussi sa propre clé en attente, sur la preuve d'une clé active ; l'agent, jamais.
    const own = await run({ 'GET /v1/cles/mes-appareils': ok([device({ userRole: 'direction', userId: 'dir-1' }), device({ id: 'd-5', userRole: 'direction', userId: 'dir-1', label: 'Ordinateur du bureau', status: 'en_attente', approvedAt: null })]), 'POST /v1/cles/preuve/fin': ok({ stepUpId: 'p-5', action: 'approuver_appareil', subject: 'device:d-5', expiresAt: '2027-03-10T09:05:00.000Z' }), 'POST /v1/cles/appareils/d-5/accord': ok(device({ id: 'd-5', status: 'actif' })) }, 'direction');
    await own.voir();
    await own.click(own.find('Accepter « Ordinateur du bureau »'));
    expect(own.posts().map((c) => c.url)).toEqual(['/v1/cles/preuve/debut', '/v1/cles/preuve/fin', '/v1/cles/appareils/d-5/accord']);
    expect(own.state()).toBe('Clé « Ordinateur du bureau » acceptée : elle est active.');
    const agent = await run({ 'GET /v1/cles/mes-appareils': ok([device({ id: 'd-5', label: 'Ordinateur du bureau', status: 'en_attente', approvedAt: null })]) });
    await agent.voir();
    expect(agent.buttons().filter((b) => b.startsWith('Accepter'))).toEqual([]);
    // Une preuve refusée : rien n'est accepté.
    const u = await run({ 'POST /v1/cles/preuve/fin': no(409, { ok: false, rule: 'R601', code: 'bad_signature' }) }, 'direction');
    await u.voir();
    await u.click(u.find('Accepter « Téléphone de Sam »'));
    expect(u.state()).toBe('La signature de l’appareil est fausse : rien n’est fait.');
    expect(u.posts().map((c) => c.url)).not.toContain('/v1/cles/appareils/d-9/accord');
  });

  it('une réponse perdue est dite incertaine', async () => {
    const t = await run({ 'POST /v1/cles/enregistrement/fin': () => Promise.reject(new TypeError('coupé')) });
    await t.voir();
    t.input('cles-accueil-nom').value = 'Mon téléphone';
    await t.click(t.find('Ranger la clé de cet appareil'));
    expect(t.state()).toBe('La réponse n’est pas arrivée : rien n’est sûr. Relisez l’écran avant de recommencer.');
    const u = await run({ 'POST /v1/cles/appareils/d-1/retrait': no(502, { ok: false }) });
    await u.voir();
    await u.click(u.find('Retirer « Téléphone pro »'));
    await u.click(u.find('Confirmer : « Téléphone pro » ne se connectera plus'));
    expect(u.state()).toBe('La réponse n’est pas arrivée : rien n’est sûr. Relisez l’écran avant de recommencer.');
    const v = await run({ 'POST /v1/cles/appareils/d-9/accord': () => Promise.reject(new TypeError('coupé')) }, 'direction');
    await v.voir();
    await v.click(v.find('Accepter « Téléphone de Sam »'));
    expect(v.state()).toBe('La réponse n’est pas arrivée : rien n’est sûr. Relisez l’écran avant de recommencer.');
    const w = await run({ 'POST /v1/cles/preuve/fin': () => Promise.reject(new TypeError('coupé')) });
    expect(await w.prove('export_complet', 'agent:agent-1')).toMatchObject({ ok: false, text: 'La réponse n’est pas arrivée : rien n’est sûr. Relisez l’écran avant de recommencer.' });
  });

  it('le bloc est sur les trois écrans ; chaque refus de la couche des clés a son libellé ; servi à part, budget tenu, aucun innerHTML [R201]', async () => {
    for (const p of ['accueil', 'reseau', 'conformite']) expect(pageIds(HTML)).toContain(`cles-${p}-voir`);
    const c = await run({}, 'compliance');
    await c.voir();
    expect(c.texts()).toContain('Téléphone pro');
    const sources = [readFileSync(new URL('../../core/src/securite/cles-appareil.ts', import.meta.url), 'utf8'), readFileSync(new URL('../../core/src/securite/webauthn.ts', import.meta.url), 'utf8')].join('\n');
    const codes = new Set([
      ...[...sources.matchAll(/refused\(viewer, (?:rule|'R\d+'), '([a-z_]+)'/g)].map((m) => m[1]!),
      ...[...sources.matchAll(/code: '([a-z_]+)'/g)].map((m) => m[1]!),
      ...[.../export type WebAuthnCode =([^;]+);/.exec(sources)![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!),
    ]);
    expect(codes.size).toBeGreaterThanOrEqual(28);
    for (const code of codes) expect(CLES_SCRIPT, code).toContain(`"${code}":`);
    for (const code of ['cles_non_configurees', 'invalid_body', 'unknown_field']) expect(CLES_SCRIPT).toContain(`"${code}":`);
    expect(AGENT_APP_FILES['/app/cles.js']).toBe(CLES_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/cles.js');
    expect(handleAgentApp(new Request('https://x.test/app/cles.js'))?.status).toBe(200);
    expect(budgetProblems({ html: '', js: CLES_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    expect(CLES_SCRIPT).not.toContain('innerHTML');
    // Le chemin des autres blocs rend toujours une réponse lisible (testé de bout en bout par BR19).
    expect(JS).toContain('function proveAction(action, subject)');
  });
});
