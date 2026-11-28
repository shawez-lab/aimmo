import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { CLES_SCRIPT } from '../app/cles.ts';
import { CONFORMITE_SCRIPT } from '../app/conformite.ts';
import { DOSSIER_LCB_SCRIPT } from '../app/dossier-lcb.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// BR114. Tout est inventé : clé de test, licence, réseau, défis, empreintes, dates, lignes du dossier.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64url');
const SECRET = 'Signalement-essai-confidentiel';
const CHALLENGE = { challengeId: 'c-1', challenge: b64([1, 2, 3]), rpId: 'app.aimmo.test', expiresAt: '2028-02-01T09:05:00.000Z', credentialIds: [b64([7, 7])] };
const DOCUMENT = {
  format: 'aimmo-dossier-lcb-agence/1',
  licenceId: 'lic-lac',
  networkId: 'net-lac',
  madeAt: '2028-02-01T09:00:00.000Z',
  tables: { suspicion_reports: [{ id: 's-1', note: SECRET }] },
  horsFichier: [],
  pieces: [{ ref: 'coffre-essai/1', sha256: 'e'.repeat(64) }],
};
const FP = 'a'.repeat(64);
const VERIFIED = { verified: true, fingerprint: FP, complete: true, missing: [], piecesComplete: true };
const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(answers: Record<string, Answer> = {}, opts: { role?: string; noWebAuthn?: boolean } = {}) {
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
    'GET /v1/moi': ok({ role: opts.role ?? 'compliance', firstName: null }),
    'GET /v1/conformite/risque': ok([]),
    'GET /v1/export/agence/lcb': ok({ licenceId: 'lic-lac' }),
    'POST /v1/cles/preuve/debut': ok(CHALLENGE),
    'POST /v1/cles/preuve/fin': ok({ stepUpId: 'p-1', action: 'export_complet', subject: 'licence_lcb:lic-lac', expiresAt: '2028-02-01T09:05:00.000Z' }),
    'POST /v1/export/agence/lcb': ok({ document: DOCUMENT, fingerprint: FP }),
    'POST /v1/export/agence/lcb/verification': ok(VERIFIED),
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
    JSON,
    URL: { createObjectURL: (b: Blob) => ((lastBlob = b), 'blob:essai'), revokeObjectURL: () => undefined },
    crypto: globalThis.crypto,
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) }, ...(opts.noWebAuthn ? {} : { credentials }) },
    ...(opts.noWebAuthn ? {} : { PublicKeyCredential: function PublicKeyCredential() {} }),
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  // DS009 : le dossier vit dans la rubrique des registres.
  const all = () => [...els.conformite!.all(), ...els['conformite-corps']!.all(), ...els['conformite-registres']!.all(), ...els.reseau!.all()];
  const scriptOf = (src: string) => all().find((e) => e.tagName === 'script' && e.attributes.src === src);
  const loaded = new Set<string>();
  /** Fait arriver les scripts servis à part que l'application a demandés, comme le navigateur. */
  const deliver = async () => {
    for (const [src, code] of [['/app/conformite.js', CONFORMITE_SCRIPT], ['/app/dossier-lcb.js', DOSSIER_LCB_SCRIPT], ['/app/cles.js', CLES_SCRIPT]] as const) {
      const s = scriptOf(src);
      if (!s || loaded.has(src)) continue;
      loaded.add(src);
      runInNewContext(code, context);
      s.listeners.load!({});
      await settle();
    }
  };
  await deliver();
  const section = () => els['conformite-registres']!.all().find((e) => e.tagName === 'section' && e.children[0]?.textContent === 'Dossier anti-blanchiment de l’agence');
  const texts = () => section()!.all().map((e) => e.textContent).join(' | ');
  const pageText = () => [...els.conformite!.all(), ...els['conformite-corps']!.all(), ...els['conformite-registres']!.all(), ...page.body.all()].map((e) => e.textContent).join(' | ');
  const state = () => section()!.all().find((e) => e.className === 'etat')!.textContent;
  const find = (text: string) => section()?.all().find((e) => e.tagName === 'button' && e.textContent === text);
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
    await deliver();
    await settle();
  };
  const open = async () => click(find('Ouvrir le dossier anti-blanchiment'));
  const picker = () => section()!.all().find((e) => e.tagName === 'input' && e.attributes.type === 'file')!;
  const pick = async (text: string | null, size?: number) => {
    const input = picker() as FakeElement & { files?: unknown; value?: string };
    input.files = text === null ? [] : [{ size: size ?? text.length, text: () => Promise.resolve(text) }];
    input.listeners.change!({});
    await settle();
  };
  const posts = () => calls.filter((c) => c.method === 'POST');
  return { els, calls, saved, section, texts, pageText, state, find, click, open, pick, posts, scriptOf };
}

describe('BR114 · le dossier anti-blanchiment à l’écran du responsable de la conformité de l’agence sous licence', () => {
  it('[R16] [R201] l’entrée n’apparaît qu’au rôle compliance ; le script se charge au geste, rien n’est lu avant', async () => {
    const t = await run();
    expect(t.section()).toBeDefined();
    expect(t.scriptOf('/app/dossier-lcb.js')).toBeUndefined();
    expect(t.calls.some((c) => c.url.startsWith('/v1/export'))).toBe(false);
    await t.open();
    expect(t.scriptOf('/app/dossier-lcb.js')).toBeDefined();
    expect(t.find('Tirer le dossier anti-blanchiment')).toBeDefined();
    expect(t.find('Vérifier le dossier tiré')).toBeDefined();
    // L'ouverture ne lit rien : la licence est lue au tirage seul.
    expect(t.calls.some((c) => c.url.startsWith('/v1/export'))).toBe(false);
    for (const role of ['direction', 'agent']) {
      const o = await run({}, { role });
      expect(o.scriptOf('/app/conformite.js'), role).toBeUndefined();
      expect(o.section(), role).toBeUndefined();
    }
    // Ni l'application ni l'écran de la direction ne portent le code du dossier.
    expect(JS).not.toContain('AIMMO_DOSSIER_LCB');
    expect(JS).not.toContain('/v1/export/agence/lcb');
  });

  it('[R601] [R662] la preuve est demandée pour export_complet et licence_lcb:<id> avant l’appel ; le dossier est enregistré en fichier, jamais écrit dans la page [R663]', async () => {
    const t = await run();
    await t.open();
    await t.click(t.find('Tirer le dossier anti-blanchiment'));
    expect(t.calls.filter((c) => c.url.startsWith('/v1/export') || c.url.startsWith('/v1/cles')).map((c) => [c.method, c.url, c.body])).toEqual([
      ['GET', '/v1/export/agence/lcb', null],
      ['POST', '/v1/cles/preuve/debut', { action: 'export_complet', subject: 'licence_lcb:lic-lac' }],
      ['POST', '/v1/cles/preuve/fin', expect.objectContaining({ challengeId: 'c-1' })],
      ['POST', '/v1/export/agence/lcb', { stepUpId: 'p-1' }],
    ]);
    expect(t.saved.map((s) => s.name)).toEqual(['aimmo-dossier-lcb-2028-02-01.json']);
    expect(JSON.parse(await t.saved[0]!.text)).toEqual(DOCUMENT);
    expect(t.state()).toBe(`Dossier enregistré sur cet appareil. Empreinte ${FP}. Vérifiez-le avant de vous en servir.`);
    for (const leak of [SECRET, 'net-lac', 'coffre-essai/1', 'suspicion_reports']) expect(t.pageText()).not.toContain(leak);
  });

  it('[R664] la vérification dit vrai, faux, incomplet ou pièces manquantes, en phrases simples', async () => {
    const t = await run();
    await t.open();
    await t.click(t.find('Vérifier le dossier tiré'));
    expect(t.state()).toBe('Tirez d’abord le dossier, ou choisissez un dossier enregistré.');
    expect(t.posts()).toEqual([]);
    await t.click(t.find('Tirer le dossier anti-blanchiment'));
    await t.click(t.find('Vérifier le dossier tiré'));
    expect(t.posts().at(-1)).toEqual({ method: 'POST', url: '/v1/export/agence/lcb/verification', body: { document: DOCUMENT } });
    expect(t.state()).toBe('Vrai et complet : c’est le dossier remis par AIMMO, il couvre chaque table du traitement d’aujourd’hui et chaque pièce.');
    const cases: [unknown, string][] = [
      [{ ...VERIFIED, verified: false, fingerprint: null, complete: false, piecesComplete: false }, 'Faux : ce dossier n’est pas celui qu’AIMMO a remis, ou il a changé depuis.'],
      [{ ...VERIFIED, complete: false, missing: ['risk_sheets', 'vigilance_alerts'] }, 'Vrai mais incomplet : c’est le dossier remis par AIMMO, mais il ne couvre pas ces tables d’aujourd’hui : risk_sheets, vigilance_alerts.'],
      [{ ...VERIFIED, piecesComplete: false }, 'Vrai mais incomplet : c’est le dossier remis par AIMMO, mais sa liste des pièces ne concorde pas avec ses lignes : des pièces y manquent ou sont en trop.'],
    ];
    for (const [answer, said] of cases) {
      const v = await run({ 'POST /v1/export/agence/lcb/verification': ok(answer) });
      await v.open();
      await v.click(v.find('Tirer le dossier anti-blanchiment'));
      await v.click(v.find('Vérifier le dossier tiré'));
      expect(v.state()).toBe(said);
    }
  });

  it('[R664] un dossier choisi sur l’appareil se vérifie sans être montré ; illisible ou trop gros, rien ne part', async () => {
    const t = await run();
    await t.open();
    await t.pick(JSON.stringify(DOCUMENT));
    expect(t.posts()).toEqual([{ method: 'POST', url: '/v1/export/agence/lcb/verification', body: { document: DOCUMENT } }]);
    expect(t.state()).toBe('Vrai et complet : c’est le dossier remis par AIMMO, il couvre chaque table du traitement d’aujourd’hui et chaque pièce.');
    expect(t.pageText()).not.toContain(SECRET);
    const u = await run();
    await u.open();
    await u.pick('pas du JSON');
    expect(u.state()).toBe('Ce fichier n’est pas un dossier AIMMO : rien n’est vérifié.');
    await u.pick('[1, 2]');
    expect(u.state()).toBe('Ce fichier n’est pas un dossier AIMMO : rien n’est vérifié.');
    await u.pick('{}', 5_000_000);
    expect(u.state()).toBe('Ce dossier est trop gros pour être vérifié ici.');
    await u.pick(null);
    expect(u.posts()).toEqual([]);
  });

  it('[R662] [R601] un refus pas_de_licence ou de la preuve se dit en mots, sans rien ranger ni enregistrer', async () => {
    const r = await run({ 'GET /v1/export/agence/lcb': no(409, { ok: false, rule: 'R662', code: 'pas_de_licence' }) });
    await r.open();
    await r.click(r.find('Tirer le dossier anti-blanchiment'));
    expect(r.state()).toBe('Votre réseau n’est pas une agence sous licence : il garde son dossier chez lui, rien n’est à reprendre ici.');
    expect(r.posts()).toEqual([]);
    expect(r.saved).toEqual([]);
    for (const [code, said] of [
      ['expired', 'La preuve a expiré : elle ne vaut que cinq minutes. Recommencez.'],
      ['already_used', 'Cette preuve a déjà servi : recommencez.'],
      ['second_factor_required', 'Il faut la preuve de la clé de cet appareil pour tirer le dossier.'],
      ['pas_de_licence', 'Votre réseau n’est pas une agence sous licence : il garde son dossier chez lui, rien n’est à reprendre ici.'],
    ] as const) {
      const t = await run({ 'POST /v1/export/agence/lcb': no(409, { ok: false, rule: code === 'pas_de_licence' ? 'R662' : 'R601', code }) });
      await t.open();
      await t.click(t.find('Tirer le dossier anti-blanchiment'));
      expect(t.state(), code).toBe(said);
      expect(t.saved, code).toEqual([]);
      // Rien n'est gardé : la vérification n'a rien à vérifier.
      await t.click(t.find('Vérifier le dossier tiré'));
      expect(t.state(), code).toBe('Tirez d’abord le dossier, ou choisissez un dossier enregistré.');
    }
    const u = await run({ 'POST /v1/export/agence/lcb': () => Promise.reject(new TypeError('coupé')) });
    await u.open();
    await u.click(u.find('Tirer le dossier anti-blanchiment'));
    expect(u.state()).toBe('La réponse n’est pas arrivée : rien n’est sûr. Recommencez dans un moment.');
    const w = await run({}, { noWebAuthn: true });
    await w.open();
    await w.click(w.find('Tirer le dossier anti-blanchiment'));
    expect(w.state()).toBe('Cet appareil ou ce navigateur ne sait pas tenir de clé d’accès : ouvrez AIMMO dans un navigateur à jour.');
    expect(w.posts()).toEqual([]);
    const q = await run({ 'POST /v1/export/agence/lcb/verification': no(502, { ok: false }) });
    await q.open();
    await q.pick(JSON.stringify(DOCUMENT));
    expect(q.state()).toBe('La vérification n’a pas abouti : rien n’est dit du dossier. Réessayez dans un moment.');
  });

  it('[R201] budget tenu : servi à part, hors de la coquille, sans innerHTML, quatre routes seules', () => {
    const r = handleAgentApp(new Request('https://aimmo.example.test/app/dossier-lcb.js'))!;
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('javascript');
    expect(AGENT_APP_SHELL).not.toContain('/app/dossier-lcb.js');
    expect(CONFORMITE_SCRIPT).toContain("'/app/dossier-lcb.js'");
    expect(DOSSIER_LCB_SCRIPT).not.toMatch(/\bfetch\(|innerHTML|insertAdjacentHTML|document\.write|localStorage|sessionStorage|indexedDB/);
    const routes = [...DOSSIER_LCB_SCRIPT.matchAll(/'(\/v1\/[^']*)'/g)].map((m) => m[1]!);
    expect(new Set(routes)).toEqual(new Set(['/v1/export/agence/lcb', '/v1/export/agence/lcb/verification']));
    expect(budgetProblems({ html: '', js: DOSSIER_LCB_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: '', js: CONFORMITE_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
  });
});
