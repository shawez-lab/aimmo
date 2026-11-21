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
const KEY_B = 'b'.repeat(40);
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

/**
 * Un IndexedDB inventé, gardé hors de l'application : il survit quand on la ferme et la rouvre. Comme le vrai, ses
 * transactions d'écriture passent l'une après l'autre, même venues de deux onglets ; une requête répond plus tard, et la
 * transaction ne finit qu'une fois ses requêtes servies, celles faites dans une réponse comprises.
 */
const locks = new WeakMap<Map<string, unknown>, Promise<void>>();
function fakeIndexedDb(data: Map<string, unknown>) {
  const db = {
    createObjectStore: () => ({}),
    transaction: () => {
      const t: Record<string, any> = {};
      const waiting: (() => void)[] = [];
      let active = false;
      let pending = 0;
      let release: () => void = () => undefined;
      const finish = () => {
        if (pending === 0) setTimeout(() => (t.oncomplete?.(), release()), 0);
      };
      const request = (run: () => unknown) => {
        const r: Record<string, any> = {};
        pending++;
        const go = () => {
          r.result = run();
          setTimeout(() => {
            r.onsuccess?.();
            pending--;
            finish();
          }, 0);
        };
        if (active) go();
        else waiting.push(go);
        return r;
      };
      t.objectStore = () => ({
        get: (k: string) => request(() => (data.has(k) ? structuredClone(data.get(k)) : undefined)),
        put: (v: unknown, k: string) => request(() => void data.set(k, structuredClone(v))),
        delete: (k: string) => request(() => void data.delete(k)),
      });
      const before = locks.get(data) ?? Promise.resolve();
      locks.set(
        data,
        before.then(
          () =>
            new Promise<void>((done) => {
              release = done;
              setTimeout(() => {
                active = true;
                waiting.splice(0).forEach((go) => go());
                finish();
              }, 0);
            }),
        ),
      );
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

const packOf = (idb: Map<string, unknown>): horsLigne.OfflinePack | null => {
  const k = [...idb.keys()].find((x) => x.startsWith(`${HORS_LIGNE_DB.paquet}:`));
  return k ? (idb.get(k) as horsLigne.OfflinePack) : null;
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
  const bea = await store.createAgent({ networkId: network.id, firstName: 'Béa', lastName: 'Agente' });
  const agentB: Viewer = { role: 'agent', userId: bea.id, networkId: network.id };
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
  return { db, journal, agent, agentB, direction, visitId, visitStart, call, count, setClock: (t: number) => (clock = t), clock: () => clock };
}
type World = Awaited<ReturnType<typeof setup>>;

/**
 * Le téléphone : l'application et la visite sans réseau, chargées comme la page les charge. `network` décide si le
 * réseau répond ; `loseAnswer` fait perdre la réponse d'un envoi après que le serveur l'a reçu.
 */
async function phone(w: World, idb: Map<string, unknown>, net: { network: boolean; loseAnswer?: boolean; hold?: Promise<void>; decode?: Promise<void>; dropPack?: boolean }, who: { key: string; viewer?: Viewer } = { key: KEY }) {
  const viewer = who.viewer ?? w.agent;
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const winListeners: Record<string, () => void> = {};
  const calls: string[] = [];
  const bodies: unknown[] = [];
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
    createImageBitmap: async (file: { luma: Luma }) => (net.decode && (await net.decode), camera.createImageBitmap(file)),
    TextEncoder,
    TextDecoder,
    atob,
    crypto: { subtle: crypto.subtle, getRandomValues: (a: Uint8Array) => crypto.getRandomValues(a), randomUUID: () => `7d1c2b3a-2222-4a2b-8c3d-${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}${String(++uuids).padStart(6, '0')}` },
    setTimeout: (f: () => void, ms: number) => (ms === 0 ? setTimeout(f, 0) : 0),
    localStorage: { getItem: () => who.key, setItem: () => undefined, removeItem: () => undefined },
    addEventListener: (n: string, f: () => void) => (winListeners[n] = f),
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
    fetch: async (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
      const method = (init.method ?? 'GET') as 'GET' | 'POST';
      // Seuls les appels qui atteignent le réseau sont comptés.
      if (!net.network) throw new TypeError('hors ligne');
      calls.push(`${method} ${url}`);
      bodies.push(init.body);
      expect(init.headers?.authorization).toBe(`Bearer ${who.key}`);
      if (url.startsWith('/v1/hors-ligne/')) {
        if (net.dropPack) throw new TypeError('hors ligne');
        if (method === 'POST' && net.hold) await net.hold;
        const r = await w.call(viewer, method, url, init.body);
        if (net.loseAnswer && method === 'POST') throw new TypeError('réponse perdue');
        return r;
      }
      if (url === '/v1/moi') return stub({ role: 'agent', firstName: 'Alex' });
      if (url === '/v1/rendez-vous/jour') return stub({ day: '2026-12-08', appointments: [] });
      if (url === '/v1/contacts-chauds') return stub({ contacts: [] });
      return stub(null);
    },
  };
  runInNewContext(APP, ctx);
  // La page ne charge pas la visite sans réseau : l'application la demande quand elle sert, et l'appareil la sert.
  const loads: string[] = [];
  const settle = async () => {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 0));
      for (const e of els['hors-ligne']!.all()) {
        if (e.tagName !== 'script' || e.attributes['data-lu']) continue;
        e.setAttribute('data-lu', '1');
        loads.push(e.attributes.src!);
        if (!ctx.AimmoHorsLigne) runInNewContext(OFFLINE, ctx);
        e.listeners.load!({});
      }
    }
  };
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
  const H = (ctx.AimmoHorsLigne ?? { pending: async () => [], refused: async () => [] }) as { pending: (o?: string) => Promise<unknown[]>; refused: () => Promise<unknown[]> };
  return { els, ctx, calls, bodies, loads, root, find, click, H, online: async () => (winListeners.online?.(), await settle()) };
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
    expect(online.loads).toEqual(['/app/hors-ligne.js']);
    expect(online.els.accueil!.all().some((e) => e.textContent === 'Mes visites sans réseau')).toBe(true);
    const pack = packOf(idb)!;
    expect(pack.appointments.map((a) => a.appointmentId)).toEqual([w.visitId]);
    // Rien d'un client sur le téléphone [R278].
    expect(JSON.stringify([...idb.values()])).not.toMatch(/Inès|Durandal|Victorine|Vendeuse|06 12|example\.test/);

    // Dans le terrain, sans réseau : l'application se rouvre sur la visite préparée, pas sur « Pas de réseau ».
    w.setClock(w.visitStart + 10 * MIN);
    const field = await phone(w, idb, { network: false });
    expect(field.els.connexion!.hidden).toBe(true);
    expect(field.els.erreur!.hidden).toBe(true);
    expect(field.root().hidden).toBe(false);
    expect(field.find('h3', /^Visite/)!.textContent).toMatch(/^Visite à 10:30 · B1, Talant$/);
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
    // Une note en cours d'écriture quand le réseau revient : l'envoi ne l'efface pas.
    await back.click(back.els.accueil!.all().find((e) => e.textContent === 'Mes visites sans réseau'));
    expect(back.root().hidden).toBe(false);
    back.find('textarea')!.value = 'Note pas encore gardée';
    await back.online();
    expect(back.find('textarea')!.value).toBe('Note pas encore gardée');
    expect(await back.H.pending()).toEqual([]);
    expect(await back.H.refused()).toEqual([]);
    expect(await w.count('offline_ops')).toBe(3);
    expect(await w.count('visit_field_notes')).toBe(1);
    expect(await w.count('visit_photos')).toBe(1);
    expect(await w.count('visit_shot_skips')).toBe(1);
    expect((await w.db.first<{ body: string }>('SELECT body FROM visit_field_notes'))!.body).toBe('Terrain en pente douce, accès par le chemin communal.');
    expect(back.find('p', /^Tout est envoyé/)).toBeDefined();
    // Reçues, la photo et la pièce sans objet restent faites sur le téléphone, même rouvert sans réseau.
    expect(back.find('strong', 'Vue d’ensemble : faite')).toBeDefined();
    const after = await phone(w, idb, { network: false });
    expect(after.find('strong', 'Vue d’ensemble : faite')).toBeDefined();
    expect(after.find('strong', 'Accès : sans objet')).toBeDefined();
    // Le serveur dit la même chose que le téléphone avant de repartir.
    const dep = await w.call(w.agent, 'GET', `/v1/hors-ligne/depart/${w.visitId}`);
    expect(((await dep.json()) as { data: { check: { canLeave: boolean; missing: string[] } } }).data.check).toMatchObject({ canLeave: false, missing: ['limites'] });
  });

  it('[R16] [R276] deux agents sur le même téléphone ne se mélangent pas ; une autre clé sans réseau ne voit rien ; après la sortie, rien ne part', async () => {
    const w = await setup();
    const idb = new Map<string, unknown>();
    w.setClock(w.visitStart - 2 * HOUR);
    await phone(w, idb, { network: true });
    // Alex, sans réseau, garde une note, puis se déconnecte ; le réseau revient sur la même page.
    w.setClock(w.visitStart + 10 * MIN);
    const net = { network: false };
    const a = await phone(w, idb, net);
    a.find('textarea')!.value = 'Note d’Alex.';
    await a.click(a.find('button', 'Garder la note'));
    expect(await a.H.pending()).toHaveLength(1);
    a.els.sortir!.listeners.click!({});
    await settle();
    net.network = true;
    await a.online();
    expect(a.calls.filter((c) => c.startsWith('POST'))).toEqual([]);
    // Une autre clé tapée sans réseau n'ouvre pas la journée d'Alex.
    const stranger = await phone(w, idb, { network: false }, { key: KEY_B, viewer: w.agentB });
    expect(stranger.root().hidden).toBe(true);
    expect(stranger.els.erreur!.textContent).toMatch(/Pas de réseau/);
    // Béa se connecte avec du réseau sur le même téléphone : la note d'Alex ne part pas sous sa clé, et reste à Alex.
    const b = await phone(w, idb, { network: true }, { key: KEY_B, viewer: w.agentB });
    expect(b.calls).toContain('GET /v1/hors-ligne/paquet');
    expect(b.calls.filter((c) => c.startsWith('POST'))).toEqual([]);
    expect(await w.count('offline_ops')).toBe(0);
    // Alex revient avec du réseau : sa note part, une fois.
    const back = await phone(w, idb, { network: true });
    expect(await back.H.pending()).toEqual([]);
    expect(await w.count('visit_field_notes')).toBe(1);
    expect(await w.count('offline_ops')).toBe(1);
    // Ni la clé ni son empreinte en clair d'un agent : seules des empreintes servent de noms.
    expect(JSON.stringify([...idb.entries()])).not.toContain(KEY);
  });

  it('[R276] deux onglets ouverts sur la même boîte n’effacent jamais la saisie de l’autre', async () => {
    const w = await setup();
    const idb = new Map<string, unknown>();
    w.setClock(w.visitStart - 2 * HOUR);
    await phone(w, idb, { network: true });
    w.setClock(w.visitStart + 10 * MIN);
    const one = await phone(w, idb, { network: false });
    const two = await phone(w, idb, { network: false });
    one.find('textarea')!.value = 'Note du premier onglet.';
    two.find('textarea')!.value = 'Note du second onglet.';
    // Les deux gestes en même temps, sans attendre l'un l'autre.
    one.find('button', 'Garder la note')!.listeners.click!({});
    two.find('button', 'Garder la note')!.listeners.click!({});
    await settle();
    expect(((await one.H.pending()) as { payload: { text: string } }[]).map((o) => o.payload.text).sort()).toEqual(['Note du premier onglet.', 'Note du second onglet.']);
    expect(((await two.H.pending()) as { seq: number }[]).map((o) => o.seq).sort()).toEqual([1, 2]);
  });

  it('[R16] une sortie en plein envoi arrête les lots suivants : rien ne part plus avec la clé oubliée', async () => {
    const w = await setup();
    const idb = new Map<string, unknown>();
    w.setClock(w.visitStart - 2 * HOUR);
    await phone(w, idb, { network: true });
    w.setClock(w.visitStart + 10 * MIN);
    let open: () => void = () => undefined;
    const net: { network: boolean; hold?: Promise<void> } = { network: false };
    const t = await phone(w, idb, net);
    for (let i = 1; i <= BATCH_LIMIT + 1; i++) {
      t.find('textarea')!.value = `Note ${i}.`;
      await t.click(t.find('button', 'Garder la note'));
    }
    expect(await t.H.pending()).toHaveLength(BATCH_LIMIT + 1);
    net.network = true;
    net.hold = new Promise<void>((r) => (open = r));
    await t.online();
    t.els.sortir!.listeners.click!({});
    open();
    await settle();
    expect(t.calls.filter((c) => c.startsWith('POST'))).toHaveLength(1);
    expect(await w.count('visit_field_notes')).toBe(BATCH_LIMIT);
    // La dernière note reste dans la boîte d'Alex, pour son prochain retour.
    const again = await phone(w, idb, { network: false });
    expect(await again.H.pending()).toHaveLength(1);
  });

  it('[R16] [R276] une photo encore en contrôle quand l’agent se déconnecte va dans sa boîte à lui', async () => {
    const w = await setup();
    const idb = new Map<string, unknown>();
    w.setClock(w.visitStart - 2 * HOUR);
    await phone(w, idb, { network: true });
    w.setClock(w.visitStart + 10 * MIN);
    let open: () => void = () => undefined;
    const net: { network: boolean; decode?: Promise<void> } = { network: false, decode: new Promise<void>((r) => (open = r)) };
    const t = await phone(w, idb, net);
    const [a, b] = t.root().all().filter((e) => e.tagName === 'input' && e.attributes.type === 'file');
    (a as unknown as { files: unknown[] }).files = [{ luma: dark }];
    a!.listeners.change!({});
    (b as unknown as { files: unknown[] }).files = [{ luma: bright }];
    b!.listeners.change!({});
    await settle();
    t.els.sortir!.listeners.click!({});
    await settle();
    // Béa se connecte avec du réseau sur le même téléphone pendant que la photo d'Alex est contrôlée.
    await phone(w, idb, { network: true }, { key: KEY_B, viewer: w.agentB });
    open();
    await settle();
    const alex = await phone(w, idb, { network: false });
    expect(((await alex.H.pending()) as { kind: string }[]).map((o) => o.kind)).toEqual(['visite.photo']);
    expect(await w.count('offline_ops')).toBe(0);
  });

  it('[R276] la journée s’ouvre mais le paquet ne vient pas : la boîte déjà gardée part quand même au retour du réseau', async () => {
    const w = await setup();
    const idb = new Map<string, unknown>();
    w.setClock(w.visitStart - 2 * HOUR);
    await phone(w, idb, { network: true });
    w.setClock(w.visitStart + 10 * MIN);
    const field = await phone(w, idb, { network: false });
    field.find('textarea')!.value = 'Note gardée.';
    await field.click(field.find('button', 'Garder la note'));
    // La journée répond, puis le réseau tombe juste avant le paquet.
    const net = { network: true, dropPack: true };
    const t = await phone(w, idb, net);
    expect(t.els.accueil!.hidden).toBe(false);
    expect(await w.count('visit_field_notes')).toBe(0);
    net.dropPack = false;
    await t.online();
    expect(await w.count('visit_field_notes')).toBe(1);
    expect(await t.H.pending()).toEqual([]);
  });

  it('[R276] une note gardée avec du réseau part aussitôt, sans attendre un autre retour du réseau', async () => {
    const w = await setup();
    const idb = new Map<string, unknown>();
    w.setClock(w.visitStart - 2 * HOUR);
    const t = await phone(w, idb, { network: true });
    await t.click(t.els.accueil!.all().find((e) => e.textContent === 'Mes visites sans réseau'));
    w.setClock(w.visitStart + 10 * MIN);
    t.find('textarea')!.value = 'Note gardée avec du réseau.';
    await t.click(t.find('button', 'Garder la note'));
    expect(await w.count('visit_field_notes')).toBe(1);
    expect(await t.H.pending()).toEqual([]);
    expect(t.find('p', /^Tout est envoyé/)).toBeDefined();
  });

  it('[R16] l’écran demandé par un agent qui se déconnecte aussitôt n’est jamais dessiné', async () => {
    const w = await setup();
    const idb = new Map<string, unknown>();
    w.setClock(w.visitStart - 2 * HOUR);
    const t = await phone(w, idb, { network: true });
    const open = t.els.accueil!.all().find((e) => e.textContent === 'Mes visites sans réseau')!;
    // Le geste, puis la sortie avant que les lectures répondent.
    open.listeners.click!({});
    t.els.sortir!.listeners.click!({});
    await settle();
    expect(t.root().hidden).toBe(true);
    expect(t.root().all().some((e) => e.tagName === 'h3')).toBe(false);
    expect(t.els.connexion!.hidden).toBe(false);
  });

  it('[R278] passé minuit, le paquet est effacé du téléphone : sans réseau, l’application dit « Pas de réseau »', async () => {
    const w = await setup();
    const idb = new Map<string, unknown>();
    w.setClock(w.visitStart - 2 * HOUR);
    await phone(w, idb, { network: true });
    expect(packOf(idb)).not.toBeNull();
    w.setClock(w.visitStart + 24 * HOUR);
    const next = await phone(w, idb, { network: false });
    expect(packOf(idb)).toBeNull();
    expect(next.root().hidden).toBe(true);
    expect(next.els.erreur!.textContent).toMatch(/Pas de réseau/);
  });

  it('[R276] une saisie gardée la veille part seule au retour du réseau, même quand le paquet a expiré', async () => {
    const w = await setup();
    const idb = new Map<string, unknown>();
    w.setClock(w.visitStart - 2 * HOUR);
    await phone(w, idb, { network: true });
    w.setClock(w.visitStart + 10 * MIN);
    const field = await phone(w, idb, { network: false });
    field.find('textarea')!.value = 'Note de la veille.';
    await field.click(field.find('button', 'Garder la note'));
    // Le lendemain matin, rouverte sans réseau : le paquet est effacé, l'écran dit « Pas de réseau ».
    w.setClock(w.visitStart + 22 * HOUR);
    const net = { network: false };
    const next = await phone(w, idb, net);
    expect(packOf(idb)).toBeNull();
    expect(next.els.erreur!.textContent).toMatch(/Pas de réseau/);
    // Le réseau revient : la note part, une fois.
    net.network = true;
    await next.online();
    expect(await w.count('visit_field_notes')).toBe(1);
    expect(next.calls.filter((c) => c.startsWith('POST'))).toHaveLength(1);
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
    // Sans longueur annoncée, un flux trop long est coupé à la limite, pas lu en entier.
    let pulled = 0;
    const chunk = new TextEncoder().encode('x'.repeat(64 * 1024));
    const stream = new ReadableStream<Uint8Array>({ pull: (c) => (pulled++, pulled > 200 ? c.close() : c.enqueue(chunk)) });
    const route = horsLigneRoutes().find((r) => r.name === 'hors_ligne.saisies')!;
    const streamed = await route.handle({ db: w.db, journal: w.journal, now: () => new Date(w.clock()) }, w.agent, [], new Request('https://api.example.test/v1/hors-ligne/saisies', { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit));
    expect(streamed.status).toBe(413);
    expect(pulled).toBeLessThan(40);
    expect(await (await w.call(w.agent, 'POST', '/v1/hors-ligne/saisies', JSON.stringify({ deviceId: 'appareil-1', ops: [], autre: 1 }))).json()).toMatchObject({ code: 'unexpected_field' });
    expect((await w.call(w.agent, 'POST', '/v1/hors-ligne/saisies', JSON.stringify({ deviceId: 'x', ops: [] }))).status).toBe(400);
    expect(await w.count('offline_ops')).toBe(0);
  });
});

/** Attendre, en temps réel, que la clé tirée du code soit prête : PBKDF2 prend du temps. */
const until = async (ok: () => unknown, what: string) => {
  for (let i = 0; i < 600; i++) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`jamais vu : ${what}`);
};
const privOf = (idb: Map<string, unknown>) => [...idb.keys()].find((k) => k.startsWith(`${HORS_LIGNE_DB.prive}:`));

describeWithSqlite('AU104 · le mode privé de la visite, sur le téléphone', () => {
  const designate = async (w: World) => {
    const p = (await w.db.first<{ id: string; network_id: string }>("SELECT id, network_id FROM properties WHERE reference = 'B1'"))!;
    await w.db.run(
      'INSERT INTO property_designations (id, network_id, property_id, version, street, postal_code, city, parcels, set_by, set_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)',
      ['des-test-1', p.network_id, p.id, '12 rue des Vignes', '21240', 'Talant', '[{"prefix":null,"section":"AB","number":"12"}]', 'agent:test', new Date(MONDAY_9H).toISOString()],
    );
  };
  const end = async (w: World) => Date.parse((await w.db.first<{ end_at: string }>('SELECT end_at FROM appointments WHERE id = ?', [w.visitId]))!.end_at);
  type Phone = Awaited<ReturnType<typeof phone>>;
  const openDay = async (p: Phone) => p.click(p.els.accueil!.all().find((e) => e.textContent === 'Mes visites sans réseau'));
  const typeCode = (p: Phone, label: RegExp, code: string) => {
    const f = p.root().all().find((e) => e.tagName === 'input' && label.test(e.attributes['aria-label'] ?? ''));
    if (!f) throw new Error(`champ du code absent : ${JSON.stringify(p.root().all().filter((e) => e.tagName === 'input').map((e) => e.attributes))}`);
    expect(f.attributes).toMatchObject({ type: 'password', inputmode: 'numeric', autocomplete: 'off' });
    f.value = code;
  };
  const address = (p: Phone) => p.root().all().find((e) => e.tagName === 'p' && e.textContent === '12 rue des Vignes, 21240 Talant');
  const callLink = (p: Phone) => p.root().all().find((e) => e.tagName === 'a' && /^Appeler /.test(e.textContent));
  const KEEP = /^Choisissez un code/;
  const OPEN = /^Code des adresses/;

  it('[R676] gardés sous un code, l’adresse et le numéro s’ouvrent en zone blanche ; chiffrés sur le téléphone, refermés seuls, effacés après la visite', async () => {
    const w = await setup();
    await designate(w);
    const idb = new Map<string, unknown>();
    w.setClock(w.visitStart - 2 * HOUR);
    const home = await phone(w, idb, { network: true });
    await openDay(home);
    // Le constat d'avant : sans le mode privé, ni l'entrée ni le contact.
    expect(address(home)).toBeUndefined();
    expect(callLink(home)).toBeUndefined();
    // Un code trop court est refusé sur place, sans rien demander au serveur.
    typeCode(home, KEEP, '1234');
    await home.click(home.find('button', 'Garder pour aujourd’hui'));
    expect(home.find('p', 'Un code de 6 à 12 chiffres.')).toBeDefined();
    expect(home.calls).not.toContain('POST /v1/hors-ligne/prive');
    typeCode(home, KEEP, '482913');
    await home.click(home.find('button', 'Garder pour aujourd’hui'));
    await until(() => address(home), 'adresse');
    expect(home.find('p', '1 visite gardée, ouvertes.')).toBeDefined();
    expect(callLink(home)!.textContent).toBe('Appeler Inès Durandal · +33612345678');
    expect(callLink(home)!.attributes.href).toBe('tel:+33612345678');
    // Le code ne part jamais : la demande n'a aucun corps. Sur le téléphone, rien en clair.
    const i = home.calls.indexOf('POST /v1/hors-ligne/prive');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(home.bodies[i]).toBeUndefined();
    const stored = JSON.stringify([...idb.entries()]);
    for (const secret of ['Vignes', 'Durandal', 'Inès', '33612', '0612', '482913']) expect(stored).not.toContain(secret);
    expect(privOf(idb)).toBeDefined();
    await home.click(home.find('button', 'Verrouiller'));
    expect(address(home)).toBeUndefined();

    // Dans la cour, sans réseau : fermé ; un code faux compte, le bon ouvre.
    w.setClock(w.visitStart - 5 * MIN);
    const field = await phone(w, idb, { network: false });
    expect(address(field)).toBeUndefined();
    typeCode(field, OPEN, '000000');
    await field.click(field.find('button', 'Ouvrir'));
    await until(() => field.find('p', /^Code faux/), 'code faux');
    expect(field.find('p', 'Code faux. Encore 4 essais avant l’effacement.')).toBeDefined();
    typeCode(field, OPEN, '482913');
    await field.click(field.find('button', 'Ouvrir'));
    await until(() => address(field), 'adresse sans réseau');
    expect(callLink(field)).toBeDefined();
    // Cinq minutes sans geste : refermé.
    const o = privOf(idb)!.slice(HORS_LIGNE_DB.prive.length + 1);
    const api = field.ctx.AimmoHorsLigne as { prive: { visites: (o: string) => Promise<unknown[] | null> } };
    expect(await api.prive.visites(o)).toHaveLength(1);
    w.setClock(w.clock() + 6 * MIN);
    expect(await api.prive.visites(o)).toBeNull();

    // Deux heures après la fin de la visite : effacé du téléphone dès l'ouverture, sans même le code.
    w.setClock((await end(w)) + 2 * HOUR + MIN);
    const late = await phone(w, idb, { network: false });
    expect(late.root().hidden).toBe(false);
    expect(late.find('button', 'Ouvrir')).toBeUndefined();
    expect(late.find('button', 'Garder pour aujourd’hui')).toBeDefined();
    expect(privOf(idb)).toBeUndefined();
  });

  it('[R676] cinq codes faux, la sortie, une visite annulée, une clé refusée ou minuit effacent le mode privé du téléphone', async () => {
    const w = await setup();
    await designate(w);
    const idb = new Map<string, unknown>();
    w.setClock(w.visitStart - 2 * HOUR);
    const keep = async () => {
      const p = await phone(w, idb, { network: true });
      await openDay(p);
      typeCode(p, KEEP, '482913');
      await p.click(p.find('button', 'Garder pour aujourd’hui'));
      await until(() => privOf(idb) && address(p), 'gardé');
      return p;
    };
    // Cinq codes faux.
    await keep();
    const thief = await phone(w, idb, { network: false });
    for (let n = 1; n <= 5; n++) {
      typeCode(thief, OPEN, `11111${n}`);
      await thief.click(thief.find('button', 'Ouvrir'));
      const said = n < 4 ? `Code faux. Encore ${5 - n} essais avant l’effacement.` : n === 4 ? 'Code faux. Dernier essai avant l’effacement.' : 'Cinq codes faux : adresses et numéros sont effacés du téléphone.';
      await until(() => thief.find('p', said), `essai ${n}`);
    }
    expect(privOf(idb)).toBeUndefined();
    // La sortie.
    const out = await keep();
    out.els.sortir!.listeners.click!({});
    await until(() => !privOf(idb), 'effacé à la sortie');
    // La visite annulée : la préparation suivante, avec du réseau, efface tout.
    await keep();
    await w.db.run("UPDATE appointments SET status = 'cancelled' WHERE id = ?", [w.visitId]);
    await phone(w, idb, { network: true });
    await until(() => !privOf(idb), 'effacé après annulation');
    // Minuit : même sans ouvrir, la lecture efface ce qui a passé sa fin.
    await w.db.run("UPDATE appointments SET status = 'booked' WHERE id = ?", [w.visitId]);
    // La clé refusée par le serveur (appareil retiré, agent parti) : effacé à la préparation suivante.
    await keep();
    await phone(w, idb, { network: true }, { key: KEY, viewer: { ...w.agent, role: 'compliance' } as Viewer });
    await until(() => !privOf(idb), 'effacé avec la clé refusée');
    await keep();
    w.setClock(Date.parse('2026-12-08T23:00:00.000Z'));
    await phone(w, idb, { network: false });
    await until(() => !privOf(idb), 'effacé à minuit');
  });

  it('[R676] [R16] seul l’agent obtient le mode privé ; un autre rôle est refusé et le refus est au journal', async () => {
    const w = await setup();
    w.setClock(w.visitStart - HOUR);
    const r = await w.call({ ...w.direction, role: 'compliance' } as Viewer, 'POST', '/v1/hors-ligne/prive');
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    const ok = await w.call(w.agent, 'POST', '/v1/hors-ligne/prive');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    const body = (await ok.json()) as { data: { pack: { visits: { contact: { phone: string } }[] } } };
    expect(body.data.pack.visits[0]?.contact.phone).toBe('+33612345678');
    expect(JSON.stringify(body)).not.toContain('example.test');
  });
});

describe('AU018 · la visite sans réseau dans la coquille', () => {
  it('[R276] sans IndexedDB, rien n’est dit gardé : la saisie est refusée avec un message clair', async () => {
    const shown: string[] = [];
    const ctx: Record<string, unknown> = { JSON, Uint8Array, btoa, crypto: { randomUUID: () => 'appareil-0001', subtle: crypto.subtle }, TextEncoder };
    runInNewContext(HORS_LIGNE_SCRIPT, ctx);
    const H = ctx.AimmoHorsLigne as { add: (o: string, k: string, a: string, p: unknown) => Promise<unknown> };
    await H.add('a'.repeat(32), 'visite.note', 'rdv-00000001', { text: 'Note' }).then(
      () => shown.push('gardée'),
      (e: Error) => shown.push(e.message),
    );
    expect(shown).toEqual([expect.stringMatching(/^Cet appareil ne peut rien garder sans réseau/)]);
  });

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
    // Pas chargée avec la page : elle n'entre pas dans le premier chargement de l'application [R201].
    expect(HTML).not.toContain('hors-ligne.js');
    expect(OFFLINE).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|localStorage|https?:\/\//);
    expect(OFFLINE).not.toMatch(/caches\./);
    expect(budgetProblems({ html: '', js: OFFLINE }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: APP }, BUDGETS.application)).toEqual([]);
  });
});
