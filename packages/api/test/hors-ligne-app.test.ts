import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, RendezVous, SqlJournalStore, Visites, applyMigrations, fromSyncSqlite, horsLigne, type SqlDatabase, type Viewer } from '@aimmo/core';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { HORS_LIGNE_DB, HORS_LIGNE_SCRIPT } from '../app/hors-ligne.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL } from '../src/agent-app.ts';
import { BATCH_LIMIT, MAX_SAISIES_BODY_BYTES, horsLigneRoutes } from '../src/hors-ligne.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// AU018 · Tout est inventé : réseau, agents, vendeuse, acquéreuse, bien, clé, images.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const APP = AGENT_APP_FILES['/app/app.js']!;
const OFFLINE = AGENT_APP_FILES['/app/hors-ligne.js']!;
// Lundi 7 décembre 2026, 9 h à Paris.
const MONDAY_9H = Date.parse('2026-12-07T08:00:00.000Z');
const HOUR = 3_600_000;
const MIN = 60_000;
const WEEK = { weekly: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: '09:00', to: '19:00' })) };

type Luma = horsLigne.Luma;
const W = 64;
const scene = (f: (v: number) => number = (v) => v): Luma => {
  const luma = new Uint8Array(W * W);
  for (let y = 0; y < W; y++)
    for (let x = 0; x < W; x++) {
      const v = 128 + 70 * Math.sign(Math.sin(x * 0.7) * Math.sin(y * 0.7)) + (x - 32) * 1.5;
      luma[y * W + x] = Math.max(0, Math.min(255, Math.round(f(v))));
    }
  return { width: W, height: W, luma };
};
const blur = (img: Luma): Luma => {
  const out = new Uint8Array(W * W);
  for (let y = 0; y < W; y++)
    for (let x = 0; x < W; x++) {
      let s = 0;
      let n = 0;
      for (let dy = -4; dy <= 4; dy++)
        for (let dx = -4; dx <= 4; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= W) continue;
          s += img.luma[yy * W + xx]!;
          n++;
        }
      out[y * W + x] = Math.round(s / n);
    }
  return { width: W, height: W, luma: out };
};
const dark = scene((v) => v * 0.25);
const bright = scene((v) => v * 2.2);

/** Un IndexedDB inventé, gardé hors de l'application : il survit quand on la ferme et la rouvre. */
function fakeIndexedDb(data: Map<string, unknown>) {
  const store = {
    get: (k: string) => ({ result: data.has(k) ? structuredClone(data.get(k)) : undefined }),
    put: (v: unknown, k: string) => void data.set(k, structuredClone(v)),
    delete: (k: string) => void data.delete(k),
  };
  const db = {
    createObjectStore: () => store,
    transaction: () => {
      const t: Record<string, any> = { objectStore: () => store };
      setTimeout(() => t.oncomplete?.(), 0);
      return t;
    },
  };
  return {
    open: () => {
      const req: Record<string, any> = { result: db };
      setTimeout(() => {
        req.onupgradeneeded?.();
        req.onsuccess?.();
      }, 0);
      return req;
    },
  };
}

/** L'appareil photo inventé : un « fichier » porte son image ; la toile la rend en couleurs, point pour point. */
const camera = {
  createImageBitmap: async (file: { luma: Luma }) => ({ width: file.luma.width, height: file.luma.height, src: file.luma, close: () => undefined }),
  OffscreenCanvas: class {
    constructor(
      public width: number,
      public height: number,
    ) {}
    getContext() {
      let src: Luma | null = null;
      return {
        drawImage: (b: { src: Luma }) => void (src = b.src),
        getImageData: (_x: number, _y: number, w: number, h: number) => {
          const data = new Uint8ClampedArray(w * h * 4);
          for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++) {
              const v = src!.luma[Math.floor((y * src!.height) / h) * src!.width + Math.floor((x * src!.width) / w)]!;
              data.set([v, v, v, 255], (y * w + x) * 4);
            }
          return { data };
        },
      };
    }
  },
};

const settle = async () => {
  for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0));
};

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = MONDAY_9H;
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const rdv = new RendezVous(db, journal, { now });
  const visites = new Visites(db, journal, acces, { diffusion: { canDiffuse: async () => ({ allowed: true, reason: 'allowed' }) }, rendezVous: rdv, now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Bienveillant' });
  const agent: Viewer = { role: 'agent', userId: alex.id, networkId: network.id };
  const direction: Viewer = { role: 'direction', userId: 'd1', networkId: network.id };
  await rdv.setAvailability(agent, WEEK);
  await visites.createSlipTemplate(direction, 'Bon de visite : {{visiteur.nom}} visite {{bien.reference}} le {{visite.date}}.');
  const seller = await store.createPerson({ networkId: network.id, agentId: sam.id, firstName: 'Victorine', lastName: 'Vendeuse' });
  await store.addIdentifier({ networkId: network.id, personId: seller.id, kind: 'email', value: 'victorine.vendeuse@example.test' });
  const property = await store.createProperty({ networkId: network.id, agentId: sam.id, reference: 'B1', kind: 'land', city: 'Talant', priceEur: 90_000, surfaceM2: 800, rooms: 0, status: 'available' });
  const buyer = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Inès', lastName: 'Durandal' });
  await store.addIdentifier({ networkId: network.id, personId: buyer.id, kind: 'phone', value: '06 12 34 56 78' });
  const project = await store.createProject({ networkId: network.id, agentId: alex.id, personId: buyer.id, kind: 'buy' });
  const r = await visites.schedule(agent, { propertyId: property.id, projectId: project.id, start: new Date(MONDAY_9H + 24 * HOUR + 90 * MIN) });
  if (!r.ok) throw new Error(r.code);
  const visitId = r.visit.appointment.id;
  const visitStart = Date.parse(r.visit.appointment.start_at);
  const s = { db, journal, now };
  const call = async (viewer: Viewer, method: 'GET' | 'POST', url: string, body?: string, headers: Record<string, string> = {}) => {
    const path = new URL(url, 'https://api.example.test').pathname.replace(/^\/v1/, '');
    const route = horsLigneRoutes().find((x) => x.method === method && x.pattern.test(path));
    if (!route) throw new Error(`route absente : ${method} ${path}`);
    const params = (route.pattern.exec(path) ?? []).slice(1);
    const init: RequestInit = { method, headers: { 'content-type': 'application/json', ...headers } };
    if (body !== undefined) init.body = body;
    return route.handle(s, viewer, params, new Request(`https://api.example.test${url}`, init));
  };
  const count = async (t: string) => (await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`))!.n;
  return { db, journal, agent, direction, visitId, visitStart, call, count, setClock: (t: number) => (clock = t), clock: () => clock };
}
type World = Awaited<ReturnType<typeof setup>>;

/**
 * Le téléphone : l'application et la visite sans réseau, chargées comme la page les charge. `network` décide si le
 * réseau répond ; `loseAnswer` fait perdre la réponse d'un envoi après que le serveur l'a reçu.
 */
async function phone(w: World, idb: Map<string, unknown>, net: { network: boolean; loseAnswer?: boolean }) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const winListeners: Record<string, () => void> = {};
  const calls: string[] = [];
  let uuids = 0;
  const NowDate = class extends Date {
    constructor(...a: unknown[]) {
      if (a.length) super(...(a as [string]));
      else super(w.clock());
    }
    static override now() {
      return w.clock();
    }
  };
  const stub = (data: unknown) => Response.json({ ok: true, mode: 'essai', data });
  const ctx: Record<string, unknown> = {
    document,
    Intl,
    Date: NowDate,
    JSON,
    Uint8Array,
    btoa,
    indexedDB: fakeIndexedDb(idb),
    ...camera,
    crypto: { randomUUID: () => `7d1c2b3a-2222-4a2b-8c3d-${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}${String(++uuids).padStart(6, '0')}` },
    setTimeout: (f: () => void, ms: number) => (ms === 0 ? setTimeout(f, 0) : 0),
    localStorage: { getItem: () => KEY, setItem: () => undefined, removeItem: () => undefined },
    addEventListener: (n: string, f: () => void) => (winListeners[n] = f),
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
    fetch: async (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
      const method = (init.method ?? 'GET') as 'GET' | 'POST';
      calls.push(`${method} ${url}`);
      if (!net.network) throw new TypeError('hors ligne');
      expect(init.headers?.authorization).toBe(`Bearer ${KEY}`);
      if (url.startsWith('/v1/hors-ligne/')) {
        const r = await w.call(w.agent, method, url, init.body);
        if (net.loseAnswer && method === 'POST') throw new TypeError('réponse perdue');
        return r;
      }
      if (url === '/v1/moi') return stub({ role: 'agent', firstName: 'Alex' });
      if (url === '/v1/rendez-vous/jour') return stub({ day: '2026-12-08', appointments: [] });
      if (url === '/v1/contacts-chauds') return stub({ contacts: [] });
      return stub(null);
    },
  };
  runInNewContext(OFFLINE, ctx);
  runInNewContext(APP, ctx);
  listeners.DOMContentLoaded!();
  await settle();
  const root = () => els['hors-ligne']!;
  const find = (tag: string, text?: string | RegExp) =>
    root().all().find((e) => e.tagName === tag && (text === undefined || (typeof text === 'string' ? e.textContent === text : text.test(e.textContent))));
  const click = async (b: FakeElement | undefined) => {
    if (!b) throw new Error('bouton absent');
    b.listeners.click!({});
    await settle();
  };
  const H = ctx.AimmoHorsLigne as { pending: () => Promise<unknown[]>; refused: () => Promise<unknown[]>; readPack: () => Promise<unknown> };
  return { els, ctx, calls, root, find, click, H, online: async () => (winListeners.online?.(), await settle()) };
}

describeWithSqlite('AU018 · la visite sans réseau, de la préparation à l’envoi', () => {
  it('[R276] [R277] [R278] préparée avec du réseau, la visite s’ouvre en mode avion ; notes et photos survivent à la fermeture et partent une seule fois', async () => {
    const w = await setup();
    const idb = new Map<string, unknown>();
    // Mardi, 8 h : l'agent ouvre l'application avec du réseau. Le paquet du jour se prépare seul.
    w.setClock(w.visitStart - 2 * HOUR);
    const online = await phone(w, idb, { network: true });
    expect(online.els.accueil!.hidden).toBe(false);
    expect(online.calls).toContain('GET /v1/hors-ligne/paquet');
    expect(online.els.accueil!.all().some((e) => e.textContent === 'Mes visites sans réseau')).toBe(true);
    const pack = idb.get(HORS_LIGNE_DB.paquet) as horsLigne.OfflinePack;
    expect(pack.appointments.map((a) => a.appointmentId)).toEqual([w.visitId]);
    // Rien d'un client sur le téléphone [R278].
    expect(JSON.stringify([...idb.values()])).not.toMatch(/Inès|Durandal|Victorine|Vendeuse|06 12|example\.test/);

    // Dans le terrain, sans réseau : l'application se rouvre sur la visite préparée, pas sur « Pas de réseau ».
    w.setClock(w.visitStart + 10 * MIN);
    const field = await phone(w, idb, { network: false });
    expect(field.els.connexion!.hidden).toBe(true);
    expect(field.els.erreur!.hidden).toBe(true);
    expect(field.root().hidden).toBe(false);
    expect(field.find('h3')!.textContent).toMatch(/^Visite à 10:30 · B1, Talant$/);
    expect(field.find('p', /^Avant de repartir, il manque : Vue d’ensemble, Accès, Limites/)).toBeDefined();
    // Une note.
    field.find('textarea')!.value = '  Terrain en pente douce, accès par le chemin communal.  ';
    await field.click(field.find('button', 'Garder la note'));
    // Une photo floue est refusée sur place, avec la consigne ; rien n'est gardé.
    const inputs = () => field.root().all().filter((e) => e.tagName === 'input' && e.attributes.type === 'file');
    const shoot = async (one: Luma, two: Luma) => {
      const [a, b] = inputs();
      (a as unknown as { files: unknown[] }).files = [{ luma: one }];
      a!.listeners.change!({});
      (b as unknown as { files: unknown[] }).files = [{ luma: two }];
      b!.listeners.change!({});
      await settle();
    };
    expect(inputs()[0]!.attributes).toMatchObject({ accept: 'image/*', capture: 'environment' });
    await shoot(blur(dark), blur(bright));
    expect(field.find('p', /^Photo refusée\. Floue/)).toBeDefined();
    // Une seule lumière : pas une photo HDR.
    await shoot(scene(), scene());
    expect(field.find('p', /^Photo refusée\. Une seule lumière/)).toBeDefined();
    expect(await field.H.pending()).toHaveLength(1);
    // Deux prises de lumières différentes : la photo de la vue d'ensemble est gardée.
    await shoot(dark, bright);
    // L'accès dit sans objet.
    await field.click(field.root().all().filter((e) => e.tagName === 'button' && e.textContent === 'Accès refusé')[0]);
    expect(field.find('strong', 'Vue d’ensemble : faite')).toBeDefined();
    expect(field.find('strong', 'Accès : sans objet')).toBeDefined();
    expect(field.find('p', 'Avant de repartir, il manque : Limites.')).toBeDefined();
    expect(field.find('p', /^3 saisies attendent le réseau/)).toBeDefined();
    expect(await w.count('offline_ops')).toBe(0);

    // L'application est fermée puis rouverte, toujours sans réseau : rien n'est perdu.
    const again = await phone(w, idb, { network: false });
    expect(await again.H.pending()).toHaveLength(3);
    expect(again.find('strong', 'Vue d’ensemble : faite')).toBeDefined();

    // Le réseau revient, mais la réponse du premier envoi se perd : le serveur a tout reçu, le téléphone garde tout.
    w.setClock(w.visitStart + 40 * MIN);
    const lost = { network: true, loseAnswer: true };
    const back = await phone(w, idb, lost);
    expect(await back.H.pending()).toHaveLength(3);
    expect(await w.count('offline_ops')).toBe(3);
    // Le renvoi : reconnu, sans aucun doublon, et la boîte se vide.
    lost.loseAnswer = false;
    await back.online();
    expect(await back.H.pending()).toEqual([]);
    expect(await back.H.refused()).toEqual([]);
    expect(await w.count('offline_ops')).toBe(3);
    expect(await w.count('visit_field_notes')).toBe(1);
    expect(await w.count('visit_photos')).toBe(1);
    expect(await w.count('visit_shot_skips')).toBe(1);
    expect((await w.db.first<{ body: string }>('SELECT body FROM visit_field_notes'))!.body).toBe('Terrain en pente douce, accès par le chemin communal.');
    expect(back.find('p', /^Tout est envoyé/)).toBeDefined();
    // Le serveur dit la même chose que le téléphone avant de repartir.
    const dep = await w.call(w.agent, 'GET', `/v1/hors-ligne/depart/${w.visitId}`);
    expect(((await dep.json()) as { data: { check: { canLeave: boolean; missing: string[] } } }).data.check).toMatchObject({ canLeave: false, missing: ['limites'] });
  });

  it('[R278] passé minuit, le paquet est effacé du téléphone : sans réseau, l’application dit « Pas de réseau »', async () => {
    const w = await setup();
    const idb = new Map<string, unknown>();
    w.setClock(w.visitStart - 2 * HOUR);
    await phone(w, idb, { network: true });
    expect(idb.has(HORS_LIGNE_DB.paquet)).toBe(true);
    w.setClock(w.visitStart + 24 * HOUR);
    const next = await phone(w, idb, { network: false });
    expect(idb.has(HORS_LIGNE_DB.paquet)).toBe(false);
    expect(next.root().hidden).toBe(true);
    expect(next.els.erreur!.textContent).toMatch(/Pas de réseau/);
  });

  it('[R16] seul l’agent prépare et envoie : un autre rôle est refusé avant la lecture du corps, et le refus est au journal', async () => {
    const w = await setup();
    w.setClock(w.visitStart - HOUR);
    for (const [method, url] of [['GET', '/v1/hors-ligne/paquet'], ['POST', '/v1/hors-ligne/saisies'], ['GET', `/v1/hors-ligne/depart/${w.visitId}`]] as const) {
      const r = await w.call({ ...w.direction, role: 'compliance' } as Viewer, method, url, method === 'POST' ? '{pas du json' : undefined);
      expect(r.status, url).toBe(403);
      expect(await r.json()).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    }
    const refus = (await w.journal.all()).filter((e) => e.type === 'acces.refuse');
    expect(refus.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(refus)).not.toMatch(/pas du json/);
  });

  it('[R278] [R276] le paquet ne dit rien d’un client ; un envoi trop lourd, mal formé ou d’un champ inconnu est refusé sans rien écrire', async () => {
    const w = await setup();
    w.setClock(w.visitStart - HOUR);
    const p = await w.call(w.agent, 'GET', '/v1/hors-ligne/paquet');
    expect(p.status).toBe(200);
    const text = await p.text();
    expect(text).not.toMatch(/Inès|Durandal|Victorine|Vendeuse|06 12|example\.test/);
    expect(JSON.parse(text).data.batchLimit).toBe(BATCH_LIMIT);
    expect((await w.call(w.agent, 'GET', '/v1/hors-ligne/paquet?jour=demain')).status).toBe(400);
    const heavy = JSON.stringify({ deviceId: 'appareil-1', ops: [], pad: 'x'.repeat(MAX_SAISIES_BODY_BYTES) });
    expect((await w.call(w.agent, 'POST', '/v1/hors-ligne/saisies', heavy)).status).toBe(413);
    expect((await w.call(w.agent, 'POST', '/v1/hors-ligne/saisies', '{pas du json')).status).toBe(400);
    expect(await (await w.call(w.agent, 'POST', '/v1/hors-ligne/saisies', JSON.stringify({ deviceId: 'appareil-1', ops: [], autre: 1 }))).json()).toMatchObject({ code: 'unexpected_field' });
    expect((await w.call(w.agent, 'POST', '/v1/hors-ligne/saisies', JSON.stringify({ deviceId: 'x', ops: [] }))).status).toBe(400);
    expect(await w.count('offline_ops')).toBe(0);
  });
});

describe('AU018 · la visite sans réseau dans la coquille', () => {
  it('[R277] le téléphone juge la photo exactement comme le serveur', () => {
    const ctx: Record<string, unknown> = { btoa, Uint8Array, JSON };
    runInNewContext(HORS_LIGNE_SCRIPT, ctx);
    const photo = (ctx.AimmoHorsLigne as { photo: { hdr: (l: Luma[]) => any; judge: (l: Luma) => any; encode: (l: Luma) => unknown } }).photo;
    for (const list of [[dark, bright], [blur(dark), blur(bright)], [scene(), scene()], [dark], [scene((v) => v * 0.3), scene((v) => v * 0.6)]]) {
      const server = horsLigne.hdrPhoto(list);
      const local = photo.hdr(list);
      expect(local.ok, String(list.length)).toBe(server.ok);
      if (server.ok) expect(local.verdict.figures).toEqual(server.verdict.figures);
      else expect(local.code).toBe(server.code === 'photo_refusee' ? server.verdict!.problems[0] : server.code);
    }
    for (const img of [dark, bright, scene(), blur(scene())]) expect(photo.judge(img)).toEqual(horsLigne.judgePhoto(img));
    expect(photo.encode(dark)).toEqual(horsLigne.encodeLuma(dark));
  });

  it('la visite sans réseau est gardée avec la coquille, servie sans rien d’extérieur ; le budget de l’application tient', () => {
    expect(AGENT_APP_SHELL).toContain('/app/hors-ligne.js');
    expect(HTML).toContain('<script src="/app/hors-ligne.js" defer></script>');
    expect(HTML.indexOf('/app/hors-ligne.js')).toBeLessThan(HTML.indexOf('/app/app.js'));
    expect(OFFLINE).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|localStorage|https?:\/\//);
    expect(OFFLINE).not.toMatch(/caches\./);
    expect(budgetProblems({ html: '', js: OFFLINE }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: APP }, BUDGETS.application)).toEqual([]);
  });
});
