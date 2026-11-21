import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { htmlProblems } from '../../core/src/design/audit.ts';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { checkOperations } from '../../core/src/studio/certificats.ts';
import { STUDIO_SCRIPT } from '../app/studio.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : biens, photos, références de stockage, clé de test.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const INJECTED = '<img src=x onerror="alert(1)">';
const R1 = 'biens/b1/00000001-0000-4000-8000-000000000000.jpg';
const R2 = 'biens/b1/00000002-0000-4000-8000-000000000000.jpg';
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });

const POST_VIEW = {
  id: 'post1',
  propertyId: 'b1',
  event: 'nouveau_bien',
  text: `Nouveau bien à découvrir.\n\nAppartement de 3 pièces. ${INJECTED}\n\nPrix : 230 000 €, honoraires à la charge du vendeur.`,
  origin: 'secours',
  visuals: [{ ref: R2, overlay: 'Aménagement virtuel', certificatePath: `/certificat-photo/${'b'.repeat(32)}`, check: null }],
  validated: null,
  sends: [],
  createdAt: '2027-10-14T08:00:00.000Z',
};
const STUDIO: Record<string, Answer> = {
  'GET /v1/studio/biens/b1': ok({
    propertyId: 'b1',
    photos: [
      { ref: R1, edit: 'aucune', certificatePath: null, overlay: null },
      { ref: R2, edit: 'amenagement_virtuel', certificatePath: `/certificat-photo/${'b'.repeat(32)}`, overlay: 'Aménagement virtuel' },
    ],
    posts: [{ id: 'post1', event: 'nouveau_bien', validated: false, createdAt: '2027-10-14T08:00:00.000Z' }],
  }),
  'GET /v1/studio/biens/b1/guide': ok({
    propertyId: 'b1',
    views: [
      { key: 'entree', kind: 'entree', label: 'Entrée', place: 'Dos à la porte d’entrée.', height: 'Environ 1,20 m.', light: 'Lampes allumées.', mandatory: true, mediaRef: null },
      { key: 'vue', kind: 'vue', label: `Vue ${INJECTED}`, place: 'Depuis la fenêtre.', height: 'Yeux.', light: 'Temps clair.', mandatory: false, mediaRef: R1 },
    ],
    missing: ['entree'],
    ready: false,
    validated: null,
    doNotForget: ['Aucune personne dans le cadre.'],
    shotsSha256: 'a'.repeat(64),
  }),
  'GET /v1/studio/biens/b1/montage': ok({
    clips: [
      { order: 1, kind: 'accroche', shot: 'Séjour en entier', source: 'rooms', seconds: 4, subtitle: '3 pièces' },
      { order: 2, kind: 'fin_marque', shot: 'Fin à la marque', source: 'marque', seconds: 3, subtitle: null },
    ],
    totalSeconds: 7,
    gestures: 4,
    estimatedMinutes: 2,
    neverFilm: ['Aucune plaque de rue lisible.'],
  }),
  'GET /v1/studio/biens/b1/plan': ok({
    propertyId: 'b1',
    version: 1,
    rooms: [{ kind: 'sejour', xCm: 0, yCm: 0, widthCm: 500, depthCm: 400, label: 'Séjour', inside: true, areaCm2: 200_000, area: '20,00 m²' }],
    insideCm2: 200_000,
    annexCm2: 0,
    inside: '20,00 m²',
    annex: '0,00 m²',
    gapWithSheet: { sheetM2: 45, percent: 55.6, warn: true },
    mention: 'Plan indicatif, non contractuel',
    svg: '<svg></svg>',
    createdAt: '2027-10-14T08:00:00.000Z',
  }),
  'GET /v1/studio/publications/post1': ok(POST_VIEW),
};
const BASE: Record<string, Answer> = {
  'GET /v1/moi': ok({ role: 'agent', firstName: 'Alex' }),
  'GET /v1/plan-du-jour': ok(null),
  'GET /v1/contacts-chauds': ok({ contacts: [] }),
  'GET /v1/rendez-vous/jour': ok({ appointments: [] }),
  'GET /v1/usage/matin': ok(null),
  'GET /v1/annonces': ok([{ id: 'b1', reference: 'ST-1', city: 'Dijon', state: null }]),
  'GET /v1/apres-vente/journee': ok({ remercier: [], recommandations: [], taches: [] }),
  ...STUDIO,
};
const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};

async function run(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; body?: string; auth: string | undefined; type?: string | undefined; sha?: string | undefined; raw?: unknown }[] = [];
  const table: Record<string, Answer> = { ...BASE, ...answers };
  // La toile du téléphone, inventée : elle compte ce qu'on y dessine et rend une image corrigée.
  const drawn: { rotate: number[]; images: number } = { rotate: [], images: 0 };
  const createElement = (tag: string) => {
    const e = document.createElement(tag) as FakeElement & Record<string, unknown>;
    if (tag === 'canvas') {
      e.getContext = () => ({
        save() {},
        restore() {},
        translate() {},
        rotate: (r: number) => drawn.rotate.push(r),
        drawImage: () => (drawn.images += 1),
        getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(Math.max(1, w * h) * 4).fill(100) }),
        putImageData() {},
      });
      e.toBlob = (cb: (b: unknown) => void) => cb({ arrayBuffer: async () => new Uint8Array([9, 9, 9]).buffer });
    }
    return e;
  };
  const context: Record<string, unknown> = {
    document: { ...document, createElement },
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, ...(init.body === undefined ? {} : { body: init.body, raw: init.body }), auth: init.headers?.authorization, type: init.headers?.['content-type'], sha: init.headers?.['x-aimmo-sha256'] });
      const a = table[`${method} ${url}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
    crypto: globalThis.crypto,
    createImageBitmap: async () => ({ width: 40, height: 30 }),
    URL: { createObjectURL: (x: { arrayBuffer: unknown; name?: string }) => (x.name ? 'blob:aimmo/file' : 'blob:aimmo/blob'), revokeObjectURL: () => {} },
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const body = () => els['studio-corps']!;
  const state = () => els['studio-etat']!.textContent;
  const byText = (text: string, nth = 0) => body().all().filter((e) => e.tagName === 'button' && e.textContent === text)[nth];
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  const input = (label: string) => {
    const l = body().all().find((e) => e.tagName === 'label' && e.textContent === label);
    if (!l) throw new Error(`libellé absent : ${label}`);
    return body().all().find((e) => e.attributes.id === l.attributes.for)! as FakeElement & Record<string, unknown>;
  };
  const scripts = () => els.studio!.children.filter((e) => e.tagName === 'script');
  let screen: Record<string, (...a: unknown[]) => unknown> | null = null;
  const loadScript = async () => {
    const s = scripts();
    expect(s.map((e) => e.attributes.src)).toEqual(['/app/studio.js']);
    // On garde l'écran fabriqué pour essayer ses calculs, tels que le téléphone les fait.
    runInNewContext(STUDIO_SCRIPT + `\n;(function(){ var make = globalThis.AIMMO_STUDIO; globalThis.AIMMO_STUDIO = function (t) { var s = make(t); globalThis.__studio = s; return s; }; })();`, context);
    s[0]!.listeners.load!({});
    await settle();
    screen = context.__studio as typeof screen;
  };
  const openB1 = async () => {
    const studio = els.biens!.all().find((e) => e.tagName === 'button' && e.textContent === 'Studio');
    if (!studio) throw new Error('bouton Studio absent');
    studio.listeners.click!({});
    await settle();
    await loadScript();
  };
  return { els, calls, table, byText, click, input, body, state, openB1, scripts, drawn, screen: () => screen! };
}

const screenCalls = <T extends { url: string }>(calls: T[]): T[] => calls.filter((c) => !/^\/v1\/(moi|plan-du-jour|alertes-agent|contacts-chauds|rendez-vous|usage|annonces$|offres\/a-tenir|apres-vente)/.test(c.url));

const hex = async (bytes: number[]) => Buffer.from(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))).toString('hex');
const ORIGINAL_REF = 'biens/b1/originaux/00000009-0000-4000-8000-000000000000.jpg';
const PHOTO_REF = 'biens/b1/00000010-0000-4000-8000-000000000000.jpg';
const VIDEO_REF = 'biens/b1/00000011-0000-4000-8000-000000000000.mp4';

describe('X12 · dépôt des fichiers finis depuis l’écran « Studio »', () => {
  const prepared = async (t: Awaited<ReturnType<typeof run>>, type: string, correct: boolean) => {
    await t.openB1();
    await t.click(t.byText('Photo'));
    const pick = t.input('Prendre ou choisir une photo');
    pick.files = [{ name: 'IMG 1.jpg', type, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }];
    pick.listeners.change!({});
    await new Promise((r) => setTimeout(r, 20));
    if (correct) t.input('Contraste (sur 100)').value = '12';
    await t.click(t.byText('Préparer la photo corrigée'));
    await new Promise((r) => setTimeout(r, 20));
  };

  it('[R130] l’original puis la photo corrigée partent tels quels, avec l’empreinte du téléphone, puis le certificat est rangé', async () => {
    const t = await run();
    const original = await hex([1, 2, 3]);
    const corrected = await hex([9, 9, 9]);
    t.table['POST /v1/studio/biens/b1/fichiers/original'] = ok({ kind: 'original', ref: ORIGINAL_REF, sha256: original, size: 3, sheetVersion: null });
    t.table['POST /v1/studio/biens/b1/fichiers/photo?retouche=lumiere_cadrage'] = ok({ kind: 'photo', ref: PHOTO_REF, sha256: corrected, size: 3, sheetVersion: 2 });
    t.table['POST /v1/studio/biens/b1/photos'] = ok({});
    await prepared(t, 'image/jpeg', true);
    const before = t.calls.length;
    await t.click(t.byText('Ranger la photo, son original et son certificat'));
    await new Promise((r) => setTimeout(r, 20));
    expect(t.state()).toBe('Photo rangée dans la fiche, avec son original et son certificat.');
    const sent = t.calls.slice(before).filter((c) => c.method === 'POST');
    expect(sent.map((c) => c.url)).toEqual(['/v1/studio/biens/b1/fichiers/original', '/v1/studio/biens/b1/fichiers/photo?retouche=lumiere_cadrage', '/v1/studio/biens/b1/photos']);
    // Les fichiers partent tels quels : le fichier choisi, puis l'image préparée par la toile, chacun avec son empreinte.
    expect(sent[0]).toMatchObject({ type: 'image/jpeg', sha: original, auth: `Bearer ${KEY}` });
    expect((sent[0]!.raw as { name: string }).name).toBe('IMG 1.jpg');
    expect(sent[1]).toMatchObject({ type: 'image/jpeg', sha: corrected, auth: `Bearer ${KEY}` });
    expect(Buffer.from(await (sent[1]!.raw as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer()).toString('hex')).toBe('090909');
    expect(JSON.parse(sent[2]!.body!)).toEqual({ resultRef: PHOTO_REF, resultSha256: corrected, originalRef: ORIGINAL_REF, originalSha256: original, operations: [{ op: 'contraste', amount: 12 }], processedOn: 'appareil' });
    for (const c of sent) expect(c.url).not.toContain(KEY);
  });

  it('[R130] sans correction, l’original est aussi la photo publiée ; un refus arrête tout, sans certificat', async () => {
    const t = await run();
    const original = await hex([1, 2, 3]);
    t.table['POST /v1/studio/biens/b1/fichiers/original'] = ok({ kind: 'original', ref: ORIGINAL_REF, sha256: original, size: 3, sheetVersion: null });
    t.table['POST /v1/studio/biens/b1/fichiers/photo?retouche=aucune'] = no(409, { ok: false, rule: 'R130', code: 'empreinte_differente' });
    await prepared(t, 'image/png', false);
    const before = t.calls.length;
    await t.click(t.byText('Ranger la photo, son original et son certificat'));
    await new Promise((r) => setTimeout(r, 20));
    expect(t.state()).toBe('Le fichier reçu n’est pas celui préparé sur ce téléphone : rien n’est rangé. Réessayez.');
    const sent = t.calls.slice(before);
    expect(sent.map((c) => c.url)).toEqual(['/v1/studio/biens/b1/fichiers/original', '/v1/studio/biens/b1/fichiers/photo?retouche=aucune']);
    expect(sent[1]).toMatchObject({ type: 'image/png', sha: original });
    expect((sent[1]!.raw as { name: string }).name).toBe('IMG 1.jpg');
  });

  it('X12 · un type que la fiche n’admet pas est dit sur le téléphone, sans rien envoyer', async () => {
    const t = await run();
    await prepared(t, 'image/heic', false);
    const before = t.calls.length;
    await t.click(t.byText('Ranger la photo, son original et son certificat'));
    expect(t.state()).toBe('Sans correction, la photo doit être en JPEG, PNG ou WebP : appliquez une correction ou choisissez une autre photo.');
    expect(t.calls.length).toBe(before);
  });

  it('[R130] la vidéo montée est rangée, puis son montage et ses textes', async () => {
    const t = await run();
    const sha = await hex([5, 5, 5]);
    t.table['POST /v1/studio/biens/b1/fichiers/video'] = ok({ kind: 'video', ref: VIDEO_REF, sha256: sha, size: 3, sheetVersion: 3 });
    t.table['POST /v1/studio/biens/b1/montage'] = ok({});
    await t.openB1();
    await t.click(t.byText('Montage'));
    await t.click(t.byText('Ranger la vidéo dans la fiche'));
    expect(t.state()).toBe('Choisissez d’abord la vidéo montée.');
    const pick = t.input('Vidéo montée (MP4)');
    expect(pick.attributes).toMatchObject({ type: 'file', accept: 'video/mp4' });
    expect(t.input('Durée (secondes)').value).toBe('7');
    pick.files = [{ name: 'montage.mp4', type: 'video/mp4', arrayBuffer: async () => new Uint8Array([5, 5, 5]).buffer }];
    t.input('Légende').value = 'Appartement lumineux.';
    const before = t.calls.length;
    await t.click(t.byText('Ranger la vidéo dans la fiche'));
    await new Promise((r) => setTimeout(r, 20));
    expect(t.state()).toBe('Vidéo rangée dans la fiche, avec son montage.');
    const sent = t.calls.slice(before).filter((c) => c.method === 'POST');
    expect(sent.map((c) => c.url)).toEqual(['/v1/studio/biens/b1/fichiers/video', '/v1/studio/biens/b1/montage']);
    expect(sent[0]).toMatchObject({ type: 'video/mp4', sha });
    expect(JSON.parse(sent[1]!.body!)).toEqual({ videoRef: VIDEO_REF, videoSha256: sha, durationSeconds: 7, subtitles: ['3 pièces'], caption: 'Appartement lumineux.', musicId: null, processedOn: 'appareil' });
  });
});

describe('X11 · écran « Studio » de l’application', () => {
  it('[R16] l’écran ne lit et n’écrit que par les routes /v1/studio, la clé dans l’en-tête seul', async () => {
    const t = await run();
    t.table['POST /v1/studio/biens/b1/guide/vues'] = ok({});
    t.table['POST /v1/studio/biens/b1/plan'] = ok({});
    t.table['POST /v1/studio/biens/b1/publications'] = ok({ ...POST_VIEW });
    await t.openB1();
    expect(t.els.studio!.hidden).toBe(false);
    expect(t.els['studio-titre']!.textContent).toBe('Studio · ST-1');
    await t.click(t.byText('Retenir cette photo'));
    expect(t.state()).toBe('Photo retenue pour Entrée.');
    const shot = t.calls.find((c) => c.method === 'POST' && c.url === '/v1/studio/biens/b1/guide/vues')!;
    // Une image d'aménagement virtuel ne remplit jamais une vue : seule la vraie photo est proposée.
    expect(JSON.parse(shot.body!)).toEqual({ viewKey: 'entree', mediaRef: R1 });
    await t.click(t.byText('Montage'));
    await t.click(t.byText('Plan'));
    await t.click(t.byText('Publications'));
    t.input('Photo 2 · Aménagement virtuel (avec certificat)').checked = true;
    await t.click(t.byText('Préparer la publication'));
    expect(t.state()).toBe('Publication préparée : contrôlez chaque visuel, puis validez.');
    const screen = screenCalls(t.calls);
    expect(screen.length).toBeGreaterThan(8);
    for (const c of screen) {
      expect(c.url.startsWith('/v1/studio'), c.url).toBe(true);
      expect(c.auth).toBe(`Bearer ${KEY}`);
      expect(c.url).not.toContain(KEY);
    }
    const routes = [...STUDIO_SCRIPT.matchAll(/'(\/v1\/[^']*)'/g)].map((m) => m[1]!);
    expect(routes.length).toBeGreaterThan(1);
    for (const r of routes) expect(r.startsWith('/v1/studio'), r).toBe(true);
  });

  it('[R130] la photo est corrigée sur le téléphone : rien n’est envoyé, corrections d’ensemble de la liste fermée', async () => {
    const t = await run();
    await t.openB1();
    await t.click(t.byText('Photo'));
    const before = t.calls.length;
    const pick = t.input('Prendre ou choisir une photo');
    expect(pick.attributes).toMatchObject({ type: 'file', accept: 'image/*', capture: 'environment' });
    pick.files = [{ name: 'IMG 1.jpg', arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }];
    pick.listeners.change!({});
    await new Promise((r) => setTimeout(r, 20));
    t.input('Exposition (IL)').value = '0.5';
    t.input('Verticales redressées (°)').value = '-1.5';
    t.input('Recadrage (% gardés)').value = '80';
    await t.click(t.byText('Voir les corrections'));
    await t.click(t.byText('Préparer la photo corrigée'));
    await new Promise((r) => setTimeout(r, 20));
    const text = t.body().textContent;
    expect(text).toContain('Exposition : +0,5 IL, sur toute l’image');
    expect(text).toContain('Verticales redressées : -1,5°, sur toute l’image');
    expect(text).toContain('Recadrage : 80 % de la largeur et de la hauteur gardés');
    // L'empreinte de l'original, calculée sur le téléphone (SHA-256 des octets 1, 2, 3).
    expect(text).toContain('Empreinte de l’original : 039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81');
    expect(text).toContain('Rien n’a quitté ce téléphone.');
    // L'original et la photo corrigée, chacun avec son lien ; l'empreinte dite est celle du fichier corrigé (9, 9, 9).
    const links = t.body().all().filter((e) => e.tagName === 'a');
    expect(links.map((l) => [l.textContent, l.attributes.download])).toEqual([
      ['Enregistrer l’original sur ce téléphone', 'original-IMG_1.jpg'],
      ['Enregistrer la photo corrigée sur ce téléphone', 'corrigee-IMG_1.jpg'],
    ]);
    expect(links[0]!.attributes.href).toBe('blob:aimmo/file');
    expect(links[1]!.attributes.href).toBe('blob:aimmo/blob');
    const corrected = Buffer.from(await crypto.subtle.digest('SHA-256', new Uint8Array([9, 9, 9]))).toString('hex');
    expect(text).toContain('Empreinte de la photo corrigée : ' + corrected);
    // Sans correction : seul l'original est proposé, aucune copie réencodée annoncée comme l'original.
    for (const k of ['Exposition (IL)', 'Verticales redressées (°)']) t.input(k).value = k.startsWith('Exp') ? '0' : '0';
    t.input('Recadrage (% gardés)').value = '100';
    await t.click(t.byText('Préparer la photo corrigée'));
    await new Promise((r) => setTimeout(r, 20));
    const plain = t.body().all().filter((e) => e.tagName === 'a');
    expect(plain.map((l) => l.attributes.download)).toEqual(['original-IMG_1.jpg']);
    expect(t.body().textContent).not.toContain('Empreinte de la photo corrigée');
    expect(t.body().textContent).toContain('Aucune correction : la photo publiée sera l’original, tel quel.');
    expect(t.drawn.images).toBeGreaterThan(1);
    expect(t.drawn.rotate[t.drawn.rotate.length - 1]).toBeCloseTo((-1.5 * Math.PI) / 180);
    // Aucune demande au serveur pendant toute la correction.
    expect(t.calls.length).toBe(before);
    // Le script n'a aucun autre moyen d'envoyer : ni fetch direct, ni formulaire, ni balise d'envoi.
    expect(STUDIO_SCRIPT).not.toMatch(/fetch\(|XMLHttpRequest|FormData|sendBeacon|WebSocket|EventSource/);
  });

  it('[R130] chaque jeu de réglages donne des corrections que le contrôle de X02 admet, et chaque pixel reçoit le même calcul', async () => {
    const t = await run();
    await t.openB1();
    const s = t.screen();
    const all = { exposition: '3', balance_des_blancs: '2000', contraste: '-100', verticales: '15', nettete: '100', recadrage: '60' };
    for (const values of [all, { exposition: '-3', recadrage: '100' }, {}, { exposition: 'x', contraste: '999' }]) {
      const ops = s.operations!(values) as unknown[];
      expect(checkOperations(JSON.parse(JSON.stringify(ops))), JSON.stringify(values)).toMatchObject({ ok: true });
    }
    expect(s.operations!({})).toEqual([]);
    expect((s.operations!(all) as { op: string }[]).map((o) => o.op)).toEqual(['exposition', 'balance_des_blancs', 'contraste', 'verticales', 'nettete', 'recadrage']);
    // Le même pixel, où qu'il soit dans l'image, donne le même résultat : aucune zone n'est traitée à part.
    const d = new Uint8ClampedArray([10, 20, 30, 255, 200, 100, 50, 255, 10, 20, 30, 255]);
    s.pixels!(d, [{ op: 'exposition', ev: 1 }, { op: 'contraste', amount: 20 }]);
    expect([...d.slice(0, 3)]).toEqual([...d.slice(8, 11)]);
    expect(d[0]).not.toBe(10);
  });

  it('[R135] le plan montre les surfaces et la mention telles que le code les rend ; les cotes saisies partent seules', async () => {
    const t = await run();
    t.table['POST /v1/studio/biens/b1/plan'] = no(409, { ok: false, rule: 'R10', code: 'chevauchement', index: 1 });
    await t.openB1();
    await t.click(t.byText('Plan'));
    const text = t.body().textContent;
    expect(text).toContain('Plan indicatif, non contractuel');
    expect(text).toContain('Séjour · 20,00 m²');
    expect(text).toContain('Écart de 55,6 % avec la surface de la fiche (45 m²) : vérifiez les cotes.');
    t.input('Pièce').value = 'chambre';
    t.input('Distance au bord gauche (cm)').value = '100';
    t.input('Distance au bord haut (cm)').value = '0';
    t.input('Largeur (cm)').value = '300';
    t.input('Profondeur (cm)').value = '300';
    await t.click(t.byText('Ajouter la pièce'));
    expect(t.state()).toBe('Deux pièces se chevauchent : vérifiez leurs positions.');
    const sent = t.calls.find((c) => c.method === 'POST' && c.url === '/v1/studio/biens/b1/plan')!;
    expect(JSON.parse(sent.body!)).toEqual({
      rooms: [
        { kind: 'sejour', xCm: 0, yCm: 0, widthCm: 500, depthCm: 400 },
        { kind: 'chambre', xCm: 100, yCm: 0, widthCm: 300, depthCm: 300 },
      ],
    });
  });

  it('[R132] [R134] une publication : chaque visuel contrôlé par l’agent, rien ne part avant sa validation, en mode essai', async () => {
    const t = await run();
    await t.openB1();
    await t.click(t.byText('Publications'));
    expect(t.body().textContent).toContain('Rien ne part sans votre validation. Avant l’envoi, chaque réseau dit s’il publie pour de vrai ou en essai.');
    // Une photo sans certificat n'est pas proposée.
    expect(t.body().all().filter((e) => e.tagName === 'label' && e.textContent.includes('avec certificat'))).toHaveLength(1);
    await t.click(t.byText('Ouvrir'));
    // Pas validée : aucun envoi possible.
    expect(t.byText('Envoyer en mode essai')).toBeUndefined();
    expect(t.body().textContent).toContain(INJECTED);
    expect(t.body().all().some((e) => e.tagName === 'img')).toBe(false);
    t.table['POST /v1/studio/publications/post1/visuels'] = no(409, { ok: false, rule: 'R132', code: 'amenagement_sans_mention' });
    t.input('Une personne se reconnaît').checked = true;
    t.input('Référence de l’accord rangé, si une personne se reconnaît').value = 'biens/b1/accords/00000001-0000-4000-8000-0000000000cc.pdf';
    await t.click(t.byText('Contrôler ce visuel'));
    expect(t.state()).toBe('Refusé : la mention « Aménagement virtuel » doit se voir sur l’image.');
    const check = t.calls.find((c) => c.url === '/v1/studio/publications/post1/visuels')!;
    expect(JSON.parse(check.body!)).toEqual({ ref: R2, addressVisible: false, personVisible: true, consentRef: 'biens/b1/accords/00000001-0000-4000-8000-0000000000cc.pdf', stagingLabelVisible: false });
    // Validée : l'envoi, en essai, vers les réseaux choisis.
    t.table['GET /v1/studio/publications/post1'] = ok({ ...POST_VIEW, visuals: [{ ...POST_VIEW.visuals[0], check: 'admis' }], validated: { by: 'agent:a1', at: '2027-10-14T09:00:00.000Z' } });
    t.table['POST /v1/studio/publications/post1/envoi'] = ok({});
    await t.click(t.byText('Retour aux publications'));
    await t.click(t.byText('Ouvrir'));
    expect(t.body().textContent).toContain('Validée le 14/10/2027.');
    await t.click(t.byText('Envoyer en mode essai'));
    expect(t.state()).toBe('Choisissez au moins un réseau.');
    t.input('Instagram').checked = true;
    t.input('Compte').value = 'reseau';
    await t.click(t.byText('Envoyer en mode essai'));
    const sent = t.calls.filter((c) => c.url === '/v1/studio/publications/post1/envoi');
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!.body!)).toEqual({ targets: [{ channel: 'instagram', account: 'reseau' }] });
  });

  it('[R134] AU036 · un réseau mis en service est dit « publication réelle » ; rien ne part sans la case cochée ; lien et action affichés', async () => {
    const t = await run();
    await t.openB1();
    await t.click(t.byText('Publications'));
    t.table['GET /v1/studio/publications/post1'] = ok({
      ...POST_VIEW,
      visuals: [{ ...POST_VIEW.visuals[0], check: 'admis' }],
      validated: { by: 'agent:a1', at: '2027-10-14T09:00:00.000Z' },
      modes: { instagram: 'reel', facebook: 'reel', linkedin: 'essai' },
      sends: [
        { channel: 'facebook', account: 'reseau', mode: 'reel', outcome: 'envoye', url: 'https://www.facebook.com/p/1', code: null, action: null },
        { channel: 'instagram', account: 'reseau', mode: 'reel', outcome: 'echec', url: null, code: 'jeton_expire', action: 'reconnecter' },
        { channel: 'linkedin', account: 'reseau', mode: 'reel', outcome: 'envoye', url: 'javascript:alert(1)', code: null, action: null },
      ],
    });
    t.table['POST /v1/studio/publications/post1/envoi'] = ok({});
    await t.click(t.byText('Ouvrir'));
    expect(t.byText('Envoyer en mode essai')).toBeUndefined();
    const text = t.body().textContent;
    expect(text).toContain('publient pour de vrai');
    expect(text).toContain('Facebook · compte du réseau : publiée');
    expect(text).toContain('Instagram · compte du réseau : en échec, reconnectez le compte chez le réseau');
    // Seul un lien https de Facebook ou d'Instagram devient un lien.
    const links = t.body().all().filter((e) => e.tagName === 'a');
    expect(links.map((a) => a.attributes.href)).toEqual(['https://www.facebook.com/p/1']);
    t.input('Instagram (publication réelle)').checked = true;
    t.input('Compte').value = 'reseau';
    await t.click(t.byText('Publier'));
    expect(t.state()).toBe('Publication réelle sur Instagram : cochez la case qui le confirme.');
    expect(t.calls.filter((c) => c.url === '/v1/studio/publications/post1/envoi')).toHaveLength(0);
    t.input('Je publie pour de vrai sur les réseaux marqués « publication réelle »').checked = true;
    await t.click(t.byText('Publier'));
    expect(t.calls.filter((c) => c.url === '/v1/studio/publications/post1/envoi')).toHaveLength(1);
  });

  describe('AT20 · liens à coller', () => {
    it('[R201] le script du Studio tient dans son budget, sans rien d’extérieur', () => {
      expect(budgetProblems({ html: '', js: STUDIO_SCRIPT }, BUDGETS.page)).toEqual([]);
    });

    const LINK = 'https://reseau.exemple.test/biens/b1?o=abcdefghijkl';
    const LINKS = { online: true, videos: [{ id: 'v1', durationSeconds: 45, recordedAt: '2027-10-14T09:00:00.000Z', link: LINK }], posts: [{ id: 'post1', event: 'visite', createdAt: '2027-10-14T09:00:00.000Z', link: `${LINK}x` }] };
    const montage = async (answer: Answer) => {
      const t = await run({ 'GET /v1/studio/biens/b1/liens': answer });
      await t.openB1();
      await t.click(t.byText('Montage'));
      return t;
    };

    it('[R156] la vidéo montre son lien, et il se copie ; sans presse-papiers, on le dit', async () => {
      const t = await montage(ok(LINKS));
      expect(t.body().textContent).toContain('Vidéo de 45 s, le 14/10/2027');
      expect(t.body().textContent).toContain(LINK);
      expect(t.body().textContent).not.toContain('v1');
      await t.click(t.byText('Copier le lien'));
      expect(t.state()).toBe('Copiez le lien à la main.');
    });

    it('la publication validée montre aussi le sien, pas celui de la vidéo', async () => {
      const t = await run({ 'GET /v1/studio/biens/b1/liens': ok(LINKS) });
      await t.openB1();
      await t.click(t.byText('Publications'));
      expect(t.body().textContent).toContain(`${LINK}x`);
      expect(t.body().textContent).not.toContain('Vidéo de 45 s');
    });

    it('un bien sans page le dit ; une panne ne casse pas l’écran ; sans rien à coller, aucun bloc', async () => {
      const t = await montage(ok({ online: false, videos: [], posts: [] }));
      expect(t.body().textContent).toContain('Ce bien n’a pas de page en ligne : pas de lien pour le moment.');
      const u = await montage(no(409, { ok: false, rule: 'R10', code: 'origine_indisponible' }));
      expect(u.body().textContent).toContain('Liens indisponibles pour le moment.');
      expect(u.body().textContent).toContain('Montage depuis le modèle');
      expect(u.body().textContent).not.toContain('origine_indisponible');
      const v = await montage(ok({ online: true, videos: [], posts: [] }));
      expect(v.body().textContent).not.toContain('Liens à coller');
    });
  });

  it('[R16] un bien hors des droits : rien n’est montré', async () => {
    const t = await run({ 'GET /v1/studio/biens/b1': no(403, { ok: false, rule: 'R16', code: 'not_assigned' }) });
    await t.openB1();
    expect(t.state()).toBe('Ce bien n’est pas dans vos droits.');
    expect(t.body().textContent).not.toContain('Guide de prise de vue');
  });

  it('une réponse arrivée après un autre choix est ignorée', async () => {
    const t = await run();
    await t.openB1();
    let release: () => void = () => {};
    const late = STUDIO['GET /v1/studio/biens/b1/guide']!;
    t.table['GET /v1/studio/biens/b1/guide'] = () => new Promise<void>((r) => (release = r)).then(late);
    await t.click(t.byText('Guide'));
    await t.click(t.byText('Plan'));
    expect(t.body().textContent).toContain('Plan indicatif, non contractuel');
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(t.body().textContent).not.toContain('Guide de prise de vue');
    expect(t.body().textContent).toContain('Plan indicatif, non contractuel');
  });

  it('[R201] l’écran est chargé à la demande, une seule fois, jamais gardé sur l’appareil ; la page reste accessible', async () => {
    const t = await run();
    expect(t.scripts()).toHaveLength(0);
    expect(JS).not.toContain('Guide de prise de vue');
    expect(AGENT_APP_SHELL).not.toContain('/app/studio.js');
    const r = handleAgentApp(new Request('https://aimmo.example.test/app/studio.js'))!;
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(STUDIO_SCRIPT);
    await t.openB1();
    expect(t.body().textContent).toContain('Guide de prise de vue');
    expect(t.body().textContent).toContain('Où : Dos à la porte d’entrée.');
    await t.click(t.els['studio-retour']);
    expect(t.els.accueil!.hidden).toBe(false);
    expect(t.body().textContent).toBe('');
    const again = t.els.biens!.all().find((e) => e.tagName === 'button' && e.textContent === 'Studio')!;
    again.listeners.click!({});
    await new Promise((r) => setTimeout(r, 20));
    expect(t.scripts()).toHaveLength(1);
    expect(htmlProblems(HTML)).toEqual([]);
    expect(HTML).toContain('id="studio"');
  });
});
