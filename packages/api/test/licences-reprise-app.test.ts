import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { CLES_SCRIPT } from '../app/cles.ts';
import { LICENCES_SCRIPT } from '../app/licences.ts';
import { AGENT_APP_FILES } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : clé de test, agence, licence, défis, empreintes, dates.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64url');
const MINE = { id: 'lic-a', agencyName: 'Agence des Essais', department: '69', grantedAt: '2028-01-05T09:00:00.000Z', state: 'suspendue', stateSince: '2028-01-09T09:00:00.000Z', tariffVersion: 2, monthlyCents: 49000, oldTariff: false, cardExpiresOn: '2030-06-30', cardExpired: false };
const CHALLENGE = { challengeId: 'c-1', challenge: b64([1, 2, 3]), rpId: 'app.aimmo.test', expiresAt: '2028-02-01T09:05:00.000Z', credentialIds: [b64([7, 7])] };
const DOCUMENT = { format: 'aimmo-reprise-agence/2', licenceId: 'lic-a', networkId: 'net-a', madeAt: '2028-02-01T09:00:00.000Z', tables: { biens: [] }, laissees: {}, masquees: {}, horsFichier: [], fichiers: [] };
const VERIFIED = { verified: true, fingerprint: 'f'.repeat(64), complete: true, missing: [], filesComplete: true, filesMissing: 0, filesExtra: 0 };
const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(answers: Record<string, Answer> = {}, opts: { clesFails?: boolean; noWebAuthn?: boolean; grantor?: boolean } = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const page = document as typeof document & { body: FakeElement };
  page.body = new FakeElement('body');
  const saved: { name: string; text: Promise<string> }[] = [];
  let lastBlob: Blob | null = null;
  const append = page.body.appendChild.bind(page.body);
  page.body.appendChild = (child: FakeElement) => {
    if (child.tagName === 'a') child.click = () => saved.push({ name: String((child as unknown as { download: string }).download), text: lastBlob!.text() });
    return append(child);
  };
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; body: any }[] = [];
  const table: Record<string, Answer> = {
    'GET /v1/moi': ok({ role: 'direction', firstName: null }),
    'GET /v1/licences': opts.grantor ? ok({ readAt: '2028-01-10T09:00:00.000Z', tariff: null, licences: [] }) : no(409, { ok: false, rule: 'R657', code: 'agence_licenciee' }),
    'GET /v1/licences/ma-licence': ok(MINE),
    'POST /v1/cles/preuve/debut': ok(CHALLENGE),
    'POST /v1/cles/preuve/fin': ok({ stepUpId: 'p-1', action: 'export_complet', subject: 'licence:lic-a', expiresAt: '2028-02-01T09:05:00.000Z' }),
    'POST /v1/export/agence': ok({ document: DOCUMENT, fingerprint: 'f'.repeat(64), rows: 12 }),
    'POST /v1/export/agence/verification': ok(VERIFIED),
    ...answers,
  };
  const credentials = {
    create: () => Promise.reject(new Error('non utilisé')),
    get: () => Promise.resolve({ rawId: new Uint8Array([7, 7]).buffer, response: { clientDataJSON: new Uint8Array([8]).buffer, authenticatorData: new Uint8Array([9]).buffer, signature: new Uint8Array([10]).buffer } }),
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
    Blob,
    URL: { createObjectURL: (b: Blob) => ((lastBlob = b), 'blob:essai'), revokeObjectURL: () => undefined },
    crypto: globalThis.crypto,
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) }, ...(opts.noWebAuthn ? {} : { credentials }) },
    ...(opts.noWebAuthn ? {} : { PublicKeyCredential: function PublicKeyCredential() {} }),
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const body = () => els['licences-corps']!;
  const state = () => els['licences-etat']!.textContent;
  const texts = () => body().all().map((e) => e.textContent).join(' | ');
  const find = (text: string) => body().all().find((e) => e.tagName === 'button' && e.textContent === text);
  const buttons = () => body().all().filter((e) => e.tagName === 'button').map((e) => e.textContent);
  const scriptOf = (src: string) => els.reseau!.children.find((e) => e.tagName === 'script' && e.attributes.src === src);
  const loaded = new Set<string>();
  /** Fait arriver les scripts servis à part que l'application a demandés (ou échouer celui des clés). */
  const deliver = async () => {
    for (const [src, code] of [['/app/licences.js', LICENCES_SCRIPT], ['/app/cles.js', CLES_SCRIPT]] as const) {
      const s = scriptOf(src);
      if (!s || loaded.has(src)) continue;
      loaded.add(src);
      if (src === '/app/cles.js' && opts.clesFails) s.listeners.error!({});
      else {
        runInNewContext(code, context);
        s.listeners.load!({});
      }
      await settle();
    }
  };
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
    await deliver();
  };
  const voir = async () => click(els['licences-voir']);
  const posts = () => calls.filter((c) => c.method === 'POST');
  return { els, calls, saved, body, state, texts, find, buttons, click, voir, posts, scriptOf };
}

describe('BR19 · l’agence sous licence reprend ses données depuis l’écran', () => {
  it('[R657] le geste n’apparaît que pour l’agence sous licence, quel que soit l’état de sa licence', async () => {
    const t = await run();
    await t.voir();
    expect(t.texts()).toContain('Reprendre mes données');
    expect(t.buttons()).toEqual(['Tirer le fichier de mes données', 'Vérifier le fichier tiré']);
    const g = await run({}, { grantor: true });
    await g.voir();
    expect(g.texts()).not.toContain('Reprendre mes données');
    expect(g.find('Tirer le fichier de mes données')).toBeUndefined();
  });

  it('[R601] [R658] la preuve est demandée pour export_complet et licence:<id> avant l’envoi ; le fichier reste sur l’appareil', async () => {
    const t = await run();
    await t.voir();
    // Le script des clés ne se charge qu'au geste.
    expect(t.scriptOf('/app/cles.js')).toBeUndefined();
    await t.click(t.find('Tirer le fichier de mes données'));
    expect(t.posts().map((c) => [c.url, c.body])).toEqual([
      ['/v1/cles/preuve/debut', { action: 'export_complet', subject: 'licence:lic-a' }],
      ['/v1/cles/preuve/fin', expect.objectContaining({ challengeId: 'c-1' })],
      ['/v1/export/agence', { stepUpId: 'p-1' }],
    ]);
    expect(t.saved.map((s) => s.name)).toEqual(['aimmo-reprise-2028-02-01.json']);
    expect(JSON.parse(await t.saved[0]!.text)).toEqual(DOCUMENT);
    expect(t.state()).toBe(`Fichier enregistré sur cet appareil : 12 lignes. Empreinte ${'f'.repeat(64)}. Vérifiez-le avant de vous en servir.`);
    // Le contenu du fichier n'est jamais posé à l'écran.
    expect(t.texts()).not.toContain('net-a');
  });

  it('[R659] la vérification est dite vraie, fausse, ou incomplète avec les tables manquantes', async () => {
    const t = await run();
    await t.voir();
    await t.click(t.find('Vérifier le fichier tiré'));
    expect(t.state()).toBe('Tirez d’abord le fichier de vos données.');
    expect(t.posts()).toEqual([]);
    await t.click(t.find('Tirer le fichier de mes données'));
    await t.click(t.find('Vérifier le fichier tiré'));
    expect(t.posts().at(-1)).toEqual({ method: 'POST', url: '/v1/export/agence/verification', body: { document: DOCUMENT } });
    expect(t.state()).toBe('Vrai et complet : c’est le fichier remis par AIMMO, il couvre chaque table et chaque fichier déposé d’aujourd’hui.');
    const f = await run({ 'POST /v1/export/agence/verification': ok({ ...VERIFIED, verified: false, fingerprint: null, complete: false }) });
    await f.voir();
    await f.click(f.find('Tirer le fichier de mes données'));
    await f.click(f.find('Vérifier le fichier tiré'));
    expect(f.state()).toBe('Faux : ce fichier n’est pas celui qu’AIMMO a remis, ou il a changé depuis.');
    const i = await run({ 'POST /v1/export/agence/verification': ok({ ...VERIFIED, complete: false, missing: ['mandats', 'visites'], filesComplete: false, filesMissing: 2, filesExtra: 1 }) });
    await i.voir();
    await i.click(i.find('Tirer le fichier de mes données'));
    await i.click(i.find('Vérifier le fichier tiré'));
    expect(i.state()).toBe('Vrai mais incomplet : c’est le fichier remis par AIMMO, mais il ne couvre pas ces tables d’aujourd’hui : mandats, visites. Et sa liste des fichiers déposés ne concorde pas : 2 non dit, 1 en trop.');
  });

  it('chaque refus dit en mots ; une réponse perdue est dite incertaine ; la preuve répond même hors ligne', async () => {
    const t = await run({ 'POST /v1/export/agence': no(409, { ok: false, rule: 'R601', code: 'expired' }) });
    await t.voir();
    await t.click(t.find('Tirer le fichier de mes données'));
    expect(t.state()).toBe('La preuve a expiré : elle ne vaut que cinq minutes. Recommencez.');
    expect(t.saved).toEqual([]);
    const u = await run({ 'POST /v1/export/agence': () => Promise.reject(new TypeError('coupé')) });
    await u.voir();
    await u.click(u.find('Tirer le fichier de mes données'));
    expect(u.state()).toBe('La réponse n’est pas arrivée : rien n’est sûr. Relisez l’écran avant de recommencer.');
    const v = await run({ 'POST /v1/export/agence': no(502, { ok: false }) });
    await v.voir();
    await v.click(v.find('Tirer le fichier de mes données'));
    expect(v.state()).toBe('La réponse n’est pas arrivée : rien n’est sûr. Relisez l’écran avant de recommencer.');
    // Le script des clés ne se charge pas : la preuve le dit, rien ne part.
    const w = await run({}, { clesFails: true });
    await w.voir();
    await w.click(w.find('Tirer le fichier de mes données'));
    expect(w.state()).toBe('La preuve n’a pas pu commencer : réessayez dans un moment.');
    expect(w.posts()).toEqual([]);
    // Un second appui pendant le chargement du script des clés ne lance rien de plus.
    const x = await run();
    await x.voir();
    const take = x.find('Tirer le fichier de mes données')!;
    take.listeners.click!({});
    take.listeners.click!({});
    await x.click(x.find('Vérifier le fichier tiré'));
    expect(x.posts().filter((c) => c.url === '/v1/export/agence')).toHaveLength(1);
    // Appareil sans clé d'accès, preuve refusée, clés fermées : dits en mots.
    const y = await run({}, { noWebAuthn: true });
    await y.voir();
    await y.click(y.find('Tirer le fichier de mes données'));
    expect(y.state()).toBe('Cet appareil ou ce navigateur ne sait pas tenir de clé d’accès : ouvrez AIMMO dans un navigateur à jour.');
    expect(y.posts()).toEqual([]);
    const z = await run({ 'POST /v1/cles/preuve/debut': no(503, { ok: false, rule: null, code: 'cles_non_configurees' }) });
    await z.voir();
    await z.click(z.find('Tirer le fichier de mes données'));
    expect(z.state()).toBe('Les clés d’accès ne sont pas encore ouvertes sur ce service.');
    expect(z.posts().map((c) => c.url)).toEqual(['/v1/cles/preuve/debut']);
    const q = await run({ 'POST /v1/export/agence/verification': () => Promise.reject(new TypeError('coupé')) });
    await q.voir();
    await q.click(q.find('Tirer le fichier de mes données'));
    await q.click(q.find('Vérifier le fichier tiré'));
    expect(q.state()).toBe('La vérification n’a pas abouti : rien n’est dit du fichier. Réessayez dans un moment.');
  });

  it('[R201] budget tenu, aucun innerHTML', () => {
    expect(budgetProblems({ html: '', js: LICENCES_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    expect(LICENCES_SCRIPT).not.toContain('innerHTML');
    for (const c of ['second_factor_required', 'other_action', 'already_used', 'expired', 'device_revoked', 'cles_non_configurees', 'pas_de_licence', 'conflit']) expect(LICENCES_SCRIPT).toContain(`"${c}":`);
  });
});
