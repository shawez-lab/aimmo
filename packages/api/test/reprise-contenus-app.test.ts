import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { CLES_SCRIPT } from '../app/cles.ts';
import { LICENCES_SCRIPT } from '../app/licences.ts';
import { REPRISE_CONTENUS_SCRIPT } from '../app/reprise-contenus.ts';
import { AGENT_APP_FILES } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : clé de test, agence, licence, défis, pièces, empreintes, dates.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
type Answer = (body: any) => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const b64u = (bytes: number[]) => Buffer.from(bytes).toString('base64url');
const sha = (b: Uint8Array | Buffer) => createHash('sha256').update(b).digest('hex');
const b64 = (b: Uint8Array | Buffer) => Buffer.from(b).toString('base64');
const MINE = { id: 'lic-a', agencyName: 'Agence des Essais', department: '69', grantedAt: '2028-01-05T09:00:00.000Z', state: 'active', stateSince: '2028-01-09T09:00:00.000Z', tariffVersion: 2, monthlyCents: 49000, oldTariff: false, cardExpiresOn: '2030-06-30', cardExpired: false };
const CHALLENGE = { challengeId: 'c-1', challenge: b64u([1, 2, 3]), rpId: 'app.aimmo.test', expiresAt: '2028-02-01T09:05:00.000Z', credentialIds: [b64u([7, 7])] };
const DOCUMENT = { format: 'aimmo-reprise-agence/2', licenceId: 'lic-a', networkId: 'net-a', madeAt: '2028-02-01T09:00:00.000Z', tables: { biens: [] }, laissees: {}, masquees: {}, horsFichier: [], fichiers: [] };
const FP = 'f'.repeat(64);
const PHOTO = Buffer.from('photo inventée du salon');
const PLAN = Buffer.from('plan inventé');
const base = { table: 'diffusion_photo_subjects', colonne: 'media_ref', ligne: { id: 'x' }, sorte: 'fichier' };
const piece = (index: number, ref: string, statut: string, bytes?: Buffer, extra: Record<string, unknown> = {}) => ({
  ...base,
  index,
  ref,
  statut,
  sha256: bytes ? sha(bytes) : null,
  taille: bytes ? bytes.length : null,
  contenu: bytes ? b64(bytes) : null,
  ...extra,
});
const LOT0 = {
  fingerprint: FP,
  depuis: 0,
  pieces: [piece(0, 'media/biens/salon.jpg', 'remise', PHOTO), piece(1, 'media/biens/absente.jpg', 'absente'), piece(2, '(masquée)', 'masquee')],
  suite: 3,
  manifeste: 'a'.repeat(64),
};
const LOT3 = { fingerprint: FP, depuis: 3, pieces: [piece(3, 'pieces/plan.pdf', 'remise', PLAN), piece(4, 'pieces/video.mp4', 'trop_grosse')], suite: null, manifeste: 'b'.repeat(64) };
// Une grosse pièce inventée, coupée en trois tranches de 4 octets (la taille d'une tranche est celle dite par le serveur).
const BIG = Buffer.from('ABCDEFGHIJ');
const PARTS = [BIG.subarray(0, 4), BIG.subarray(4, 8), BIG.subarray(8)];
const EMPREINTE = { fingerprint: FP, ...base, index: 4, ref: 'pieces/video.mp4', statut: 'prete', taille: BIG.length, sha256: sha(BIG), trancheOctets: 4, tranches: PARTS.map((p, i) => ({ debut: i * 4, taille: p.length, sha256: sha(p) })), manifeste: 'c'.repeat(64) };
const tranche = (i: number, bytes: Buffer = PARTS[i]!) => ({ fingerprint: FP, index: 4, statut: 'remise', debut: i * 4, total: BIG.length, taille: bytes.length, sha256: sha(bytes), contenu: b64(bytes), suite: i < 2 ? (i + 1) * 4 : null });
const settle = async () => {
  for (let i = 0; i < 60; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const page = document as typeof document & { body: FakeElement };
  page.body = new FakeElement('body');
  const saved: { name: string; blob: Blob }[] = [];
  let lastBlob: Blob | null = null;
  const append = page.body.appendChild.bind(page.body);
  page.body.appendChild = (child: FakeElement) => {
    if (child.tagName === 'a') child.click = () => saved.push({ name: String((child as unknown as { download: string }).download), blob: lastBlob! });
    return append(child);
  };
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; body: any }[] = [];
  const table: Record<string, Answer> = {
    'GET /v1/moi': ok({ role: 'direction', firstName: null }),
    'GET /v1/licences': no(409, { ok: false, rule: 'R657', code: 'agence_licenciee' }),
    'GET /v1/licences/ma-licence': ok(MINE),
    'POST /v1/cles/preuve/debut': ok(CHALLENGE),
    'POST /v1/cles/preuve/fin': ok({ stepUpId: 'p-1', action: 'export_complet', subject: 'licence:lic-a', expiresAt: '2028-02-01T09:05:00.000Z' }),
    'POST /v1/export/agence': ok({ document: DOCUMENT, fingerprint: FP, rows: 12 }),
    'POST /v1/export/agence/contenus': async (b) => Response.json({ ok: true, mode: 'essai', data: b.depuis === 0 ? LOT0 : LOT3 }),
    'POST /v1/export/agence/contenus/piece': ok(EMPREINTE),
    'POST /v1/export/agence/contenus/tranche': async (b) => Response.json({ ok: true, mode: 'essai', data: tranche(b.debut / 4) }),
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
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
      calls.push({ method, url, body });
      const a = table[`${method} ${url}`];
      return a ? a(body) : Promise.reject(new TypeError('hors ligne'));
    },
    Intl,
    Date,
    btoa,
    atob,
    Blob,
    URL: { createObjectURL: (b: Blob) => ((lastBlob = b), 'blob:essai'), revokeObjectURL: () => undefined },
    crypto: globalThis.crypto,
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) }, credentials },
    PublicKeyCredential: function PublicKeyCredential() {},
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const body = () => els['licences-corps']!;
  const all = () => [...els.reseau!.all(), ...body().all()];
  const texts = () => body().all().map((e) => e.textContent).join(' | ');
  const find = (text: string) => body().all().find((e) => e.tagName === 'button' && e.textContent === text);
  const statusOf = () => body().all().find((e) => e.tagName === 'p' && e.attributes.role === 'status')?.textContent ?? '';
  const scripts = (src: string) => all().filter((e) => e.tagName === 'script' && e.attributes.src === src);
  const loaded = new Set<FakeElement>();
  let failContenus = false;
  const deliver = async () => {
    for (const [src, code] of [['/app/licences.js', LICENCES_SCRIPT], ['/app/cles.js', CLES_SCRIPT], ['/app/reprise-contenus.js', REPRISE_CONTENUS_SCRIPT]] as const) {
      for (const s of scripts(src)) {
        if (loaded.has(s)) continue;
        loaded.add(s);
        if (src === '/app/reprise-contenus.js' && failContenus) s.listeners.error!({});
        else {
          runInNewContext(code, context);
          s.listeners.load!({});
        }
        await settle();
      }
    }
  };
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
    await deliver();
    await settle();
  };
  const voir = async () => click(els['licences-voir']);
  const posts = () => calls.filter((c) => c.method === 'POST');
  const proofs = () => posts().filter((c) => c.url === '/v1/cles/preuve/fin').length;
  const failNext = () => (failContenus = true);
  const licencesState = () => els['licences-etat']!.textContent;
  /** L'écran ouvert, le fichier de reprise tiré, le contenu ouvert. */
  const open = async () => {
    await voir();
    await click(find('Tirer le fichier de mes données'));
    saved.length = 0;
    await click(find('Tirer le contenu de mes fichiers'));
  };
  return { els, calls, saved, body, texts, find, click, voir, posts, proofs, scripts, statusOf, open, failNext, licencesState };
}

describe('BR83 · le contenu des fichiers de l’agence sous licence tiré à l’écran (Jamais vu)', () => {
  it('[R201] un seul script servi à part, chargé au seul geste ; budgets tenus, sans innerHTML', async () => {
    expect(AGENT_APP_FILES['/app/reprise-contenus.js']).toContain('globalThis.AIMMO_REPRISE_CONTENUS');
    const t = await run();
    await t.voir();
    expect(t.scripts('/app/reprise-contenus.js')).toHaveLength(0);
    await t.click(t.find('Tirer le fichier de mes données'));
    expect(t.scripts('/app/reprise-contenus.js')).toHaveLength(0);
    await t.click(t.find('Tirer le contenu de mes fichiers'));
    expect(t.scripts('/app/reprise-contenus.js')).toHaveLength(1);
    // Un second appui ne recharge pas le script.
    await t.click(t.find('Tirer le contenu de mes fichiers'));
    expect(t.scripts('/app/reprise-contenus.js')).toHaveLength(1);
    expect(budgetProblems({ html: '', js: REPRISE_CONTENUS_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: '', js: LICENCES_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    expect(REPRISE_CONTENUS_SCRIPT).not.toContain('innerHTML');
    // Le script de l'application ne change pas : il ne connaît pas ce script.
    expect(JS).not.toContain('reprise-contenus');
  });

  it('sans fichier de reprise tiré dans la séance, rien ne part, et c’est dit en mots', async () => {
    const t = await run();
    await t.voir();
    await t.click(t.find('Tirer le contenu de mes fichiers'));
    expect(t.texts()).toContain('Tirez d’abord le fichier de vos données : le contenu se tire sur lui.');
    expect(t.posts()).toEqual([]);
    expect(t.find('Tirer le premier lot')).toBeUndefined();
  });

  it('[R601] [R666] [R663] une preuve par lot ; chaque pièce refaite ici, offerte seulement si elle concorde ; absente et masquée dites', async () => {
    const t = await run();
    await t.open();
    expect(t.texts()).toContain('Chaque pièce arrive avec son empreinte, refaite sur cet appareil avant d’être offerte.');
    const before = t.posts().length;
    await t.click(t.find('Tirer le premier lot'));
    const sent = t.posts().slice(before);
    expect(sent.map((c) => c.url)).toEqual(['/v1/cles/preuve/debut', '/v1/cles/preuve/fin', '/v1/export/agence/contenus']);
    expect(sent[0]!.body).toEqual({ action: 'export_complet', subject: 'licence:lic-a' });
    expect(sent[2]!.body).toEqual({ document: DOCUMENT, stepUpId: 'p-1', depuis: 0 });
    expect(t.texts()).toContain('diffusion_photo_subjects · media_ref · aimmo-0-salon.jpg : 24 o, empreinte refaite sur cet appareil : identique.');
    expect(t.texts()).toContain('aimmo-1-absente.jpg : absente.');
    expect(t.texts()).toContain('aimmo-2-_masqu_e_ : masquée dans le fichier : non lue.');
    // Ni « pas dans le stockage », ni « du coffre » : pourquoi elle manque n'est jamais dit [R663].
    expect(t.texts()).not.toMatch(/coffre|stockage ne l/);
    expect(t.statusOf()).toBe('Lot tiré : 3 pièces. Enregistrez-les avant le lot suivant, qui les remplace à l’écran.');
    expect(t.find('Enregistrer aimmo-1-absente.jpg')).toBeUndefined();
    await t.click(t.find('Enregistrer aimmo-0-salon.jpg'));
    expect(t.saved.map((s) => s.name)).toEqual(['aimmo-0-salon.jpg']);
    expect(Buffer.from(await t.saved[0]!.blob.arrayBuffer())).toEqual(PHOTO);
  });

  it('[R666] une pièce dont l’empreinte refaite ici n’est pas celle dite est altérée, jamais offerte', async () => {
    const bad = { ...LOT0, pieces: [{ ...piece(0, 'media/biens/salon.jpg', 'remise', PHOTO), contenu: b64(Buffer.from('autre chose')) }, { ...piece(1, 'media/x.jpg', 'remise', PLAN), taille: 99 }], suite: null };
    const t = await run({ 'POST /v1/export/agence/contenus': ok(bad) });
    await t.open();
    await t.click(t.find('Tirer le premier lot'));
    expect(t.texts()).toContain('aimmo-0-salon.jpg : altérée en route : son empreinte refaite ici n’est pas celle qu’AIMMO a dite. Non enregistrée.');
    expect(t.texts()).toContain('aimmo-1-x.jpg : altérée en route');
    expect(t.texts()).not.toContain('Enregistrer aimmo-');
    expect(t.statusOf()).toBe('Tous les fichiers sont passés : 0 vérifiées, 0 absentes, 0 masquées, 0 à tirer en tranches, 2 altérées. Enregistrez les pièces de ce lot, puis le reçu.');
  });

  it('la suite par sa place ; le lot suivant remplace le précédent ; la fin dite avec les comptes', async () => {
    const t = await run();
    await t.open();
    await t.click(t.find('Tirer le premier lot'));
    await t.click(t.find('Tirer le lot suivant'));
    expect(t.posts().filter((c) => c.url === '/v1/export/agence/contenus').map((c) => c.body.depuis)).toEqual([0, 3]);
    expect(t.texts()).not.toContain('aimmo-0-salon.jpg');
    expect(t.texts()).toContain('aimmo-3-plan.pdf : 13 o, empreinte refaite sur cet appareil : identique.');
    expect(t.statusOf()).toBe('Tous les fichiers sont passés : 2 vérifiées, 1 absentes, 1 masquées, 1 à tirer en tranches, 0 altérées. Enregistrez les pièces de ce lot, puis le reçu.');
    expect((t.find('Tirer le lot suivant') as unknown as { disabled: boolean }).disabled).toBe(true);
    const n = t.posts().length;
    await t.click(t.find('Tirer le lot suivant'));
    expect(t.posts().length).toBe(n);
  });

  it('[R667] une pièce trop grosse tirée tranche par tranche, une preuve et l’empreinte attendue par tranche, refaite entière ici', async () => {
    const t = await run();
    await t.open();
    await t.click(t.find('Tirer le premier lot'));
    await t.click(t.find('Tirer le lot suivant'));
    expect(t.texts()).toContain('aimmo-4-video.mp4 : trop grosse pour un lot : elle se tire tranche par tranche, une preuve par tranche.');
    const p0 = t.proofs();
    await t.click(t.find('Tirer en tranches aimmo-4-video.mp4'));
    expect(t.proofs() - p0).toBe(4);
    expect(t.posts().filter((c) => c.url === '/v1/export/agence/contenus/piece').map((c) => c.body)).toEqual([{ document: DOCUMENT, stepUpId: 'p-1', index: 4 }]);
    expect(t.posts().filter((c) => c.url === '/v1/export/agence/contenus/tranche').map((c) => [c.body.debut, c.body.attendue])).toEqual(PARTS.map((p, i) => [i * 4, sha(p)]));
    expect(t.texts()).toContain('aimmo-4-video.mp4 : 10 o, empreinte entière refaite sur cet appareil : identique.');
    expect(t.statusOf()).toBe('Pièce tirée en 3 tranches.');
    await t.click(t.find('Enregistrer aimmo-4-video.mp4'));
    expect(t.saved.map((s) => s.name)).toEqual(['aimmo-4-video.mp4']);
    expect(Buffer.from(await t.saved[0]!.blob.arrayBuffer())).toEqual(BIG);
  });

  it('[R667] une tranche altérée, absente ou d’une autre empreinte arrête tout : rien n’est enregistré', { timeout: 30_000 }, async () => {
    for (const answer of [
      async (b: any) => Response.json({ ok: true, data: b.debut === 4 ? { ...tranche(1), statut: 'alteree', contenu: null } : tranche(b.debut / 4) }),
      async (b: any) => Response.json({ ok: true, data: b.debut === 4 ? tranche(1, Buffer.from('ZZZZ')) : tranche(b.debut / 4) }),
      async (b: any) => Response.json({ ok: true, data: b.debut === 4 ? { ...tranche(1), statut: 'absente', contenu: null } : tranche(b.debut / 4) }),
    ]) {
      const t = await run({ 'POST /v1/export/agence/contenus': ok({ ...LOT3, depuis: 0 }), 'POST /v1/export/agence/contenus/tranche': answer });
      await t.open();
      await t.click(t.find('Tirer le premier lot'));
      await t.click(t.find('Tirer en tranches aimmo-4-video.mp4'));
      expect(t.statusOf()).toMatch(/^La tranche 2 .*tout s’arrête, rien n’est enregistré\.$/);
      expect(t.posts().filter((c) => c.url === '/v1/export/agence/contenus/tranche')).toHaveLength(2);
      expect(t.find('Enregistrer aimmo-4-video.mp4')).toBeUndefined();
      expect(t.saved).toEqual([]);
    }
    // Une pièce recomposée d'une autre empreinte entière : rien n'est enregistré.
    const w = await run({ 'POST /v1/export/agence/contenus': ok({ ...LOT3, depuis: 0 }), 'POST /v1/export/agence/contenus/piece': ok({ ...EMPREINTE, sha256: 'e'.repeat(64) }) });
    await w.open();
    await w.click(w.find('Tirer le premier lot'));
    await w.click(w.find('Tirer en tranches aimmo-4-video.mp4'));
    expect(w.statusOf()).toBe('La pièce recomposée n’a pas l’empreinte dite : rien n’est enregistré.');
    expect(w.find('Enregistrer aimmo-4-video.mp4')).toBeUndefined();
    // Une pièce dite absente à l'empreinte : dit en mots.
    const a = await run({ 'POST /v1/export/agence/contenus': ok({ ...LOT3, depuis: 0 }), 'POST /v1/export/agence/contenus/piece': ok({ ...EMPREINTE, statut: 'absente', taille: null, sha256: null, tranches: [] }) });
    await a.open();
    await a.click(a.find('Tirer le premier lot'));
    await a.click(a.find('Tirer en tranches aimmo-4-video.mp4'));
    expect(a.statusOf()).toBe('Cette pièce est absente : rien n’est enregistré.');
  });

  it('le reçu enregistré porte l’empreinte du fichier, les manifestes et chaque pièce, sans aucun contenu', { timeout: 30_000 }, async () => {
    const t = await run();
    await t.open();
    await t.click(t.find('Enregistrer le reçu'));
    expect(t.statusOf()).toBe('Tirez d’abord un lot.');
    expect(t.saved).toEqual([]);
    await t.click(t.find('Tirer le premier lot'));
    await t.click(t.find('Tirer le lot suivant'));
    await t.click(t.find('Enregistrer le reçu'));
    expect(t.saved).toHaveLength(1);
    expect(t.saved[0]!.name).toMatch(/^aimmo-reprise-recu-\d{4}-\d{2}-\d{2}\.json$/);
    const text = await t.saved[0]!.blob.text();
    const r = JSON.parse(text);
    expect(r).toMatchObject({ format: 'aimmo-reprise-recu/1', licenceId: 'lic-a', fichier: FP, complet: true, lots: [{ depuis: 0, manifeste: 'a'.repeat(64) }, { depuis: 3, manifeste: 'b'.repeat(64) }] });
    expect(r.pieces.map((p: any) => [p.index, p.statut, p.sha256])).toEqual([
      [0, 'verifiee', sha(PHOTO)],
      [1, 'absente', null],
      [2, 'masquee', null],
      [3, 'verifiee', sha(PLAN)],
      [4, 'en_tranches', null],
    ]);
    expect(text).not.toContain(b64(PHOTO));
    expect(text).not.toContain('contenu');
    expect(t.statusOf()).toBe('Reçu enregistré sur cet appareil : 5 pièces dites, sans aucun contenu.');
    // Une pièce tirée ensuite en tranches remplace sa ligne : chaque pièce dite une seule fois.
    await t.click(t.find('Tirer en tranches aimmo-4-video.mp4'));
    await t.click(t.find('Enregistrer le reçu'));
    const r2 = JSON.parse(await t.saved.at(-1)!.blob.text());
    expect(r2.pieces.map((p: any) => [p.index, p.statut])).toEqual([[0, 'verifiee'], [1, 'absente'], [2, 'masquee'], [3, 'verifiee'], [4, 'verifiee']]);
    expect(r2.pieces[4]).toMatchObject({ sha256: sha(BIG), taille: BIG.length });
    expect(r2.comptes).toEqual({ verifiee: 3, absente: 1, masquee: 1, en_tranches: 0 });
  });

  it('rouvert sur le même fichier, l’écran garde le lot, ses pièces à enregistrer et ses tranches à tirer', async () => {
    const t = await run();
    await t.open();
    await t.click(t.find('Tirer le premier lot'));
    await t.click(t.find('Tirer le lot suivant'));
    await t.click(t.find('Tirer le contenu de mes fichiers'));
    expect(t.find('Enregistrer aimmo-3-plan.pdf')).toBeDefined();
    expect(t.find('Tirer en tranches aimmo-4-video.mp4')).toBeDefined();
    expect(t.statusOf()).toMatch(/^Tous les fichiers sont passés/);
    expect(t.posts().filter((c) => c.url === '/v1/export/agence/contenus')).toHaveLength(2);
    // Un nouveau fichier de reprise recommence à zéro.
    await t.click(t.find('Tirer le fichier de mes données'));
    await t.click(t.find('Tirer le contenu de mes fichiers'));
    expect(t.find('Tirer le premier lot')).toBeDefined();
    expect(t.find('Enregistrer aimmo-3-plan.pdf')).toBeUndefined();
  });

  it('chaque refus et le stockage non branché dits en mots ; une réponse perdue dite incertaine ; le script absent dit', async () => {
    const cases: [Answer, string][] = [
      [no(503, { ok: false, rule: null, code: 'fichiers_non_branches' }), 'Le stockage des fichiers n’est pas encore branché : aucun contenu ne se tire pour le moment.'],
      [no(409, { ok: false, rule: 'R659', code: 'fichier_non_verifie' }), 'Ce fichier de reprise n’est plus celui qu’AIMMO vous a remis, ou il a changé : tirez-en un nouveau.'],
      [no(409, { ok: false, rule: 'R601', code: 'already_used' }), 'Cette preuve a déjà servi : recommencez.'],
      [no(502, { ok: false }), 'La réponse n’est pas arrivée : rien n’est sûr. Recommencez ce lot.'],
      [() => Promise.reject(new TypeError('coupé')), 'La réponse n’est pas arrivée : rien n’est sûr. Recommencez ce lot.'],
      [ok({ ...LOT0, depuis: 7 }), 'La réponse n’est pas arrivée : rien n’est sûr. Recommencez ce lot.'],
    ];
    for (const [answer, text] of cases) {
      const t = await run({ 'POST /v1/export/agence/contenus': answer });
      await t.open();
      await t.click(t.find('Tirer le premier lot'));
      expect(t.statusOf()).toBe(text);
      expect(t.texts()).not.toContain('Enregistrer aimmo-');
      // Le lot peut se redemander, à la même place.
      expect((t.find('Tirer le premier lot') as unknown as { disabled: boolean }).disabled).toBe(false);
    }
    let n = 0;
    const p = await run({
      'POST /v1/cles/preuve/fin': async () => (++n === 1 ? Response.json({ ok: true, data: { stepUpId: 'p-1', action: 'export_complet', subject: 'licence:lic-a', expiresAt: '2028-02-01T09:05:00.000Z' } }) : Response.json({ ok: false, rule: 'R601', code: 'expired' }, { status: 409 })),
    });
    await p.open();
    await p.click(p.find('Tirer le premier lot'));
    expect(p.posts().filter((c) => c.url === '/v1/export/agence/contenus')).toEqual([]);
    expect(p.statusOf()).not.toBe('');
    const s = await run();
    await s.voir();
    await s.click(s.find('Tirer le fichier de mes données'));
    s.failNext();
    await s.click(s.find('Tirer le contenu de mes fichiers'));
    expect(s.licencesState()).toBe('Pas de réseau. Réessayez dans un moment.');
    for (const c of ['second_factor_required', 'other_action', 'already_used', 'expired', 'device_revoked', 'cles_non_configurees', 'fichiers_non_branches', 'fichier_non_verifie', 'stockage_sans_plages', 'pas_de_licence', 'role']) expect(REPRISE_CONTENUS_SCRIPT).toContain(`"${c}":`);
  }, 30_000);
});
