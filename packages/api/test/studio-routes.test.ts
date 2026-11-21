import { expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '@aimmo/core';
import { studioCertificate, studioRoutes, type StudioServices } from '../src/studio.ts';
import { liveSocialChannels, mediaBase } from '../src/reseaux-reels.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Réseau, agents, biens, photos et empreintes inventés.
const uuid = (n: number, tail = '000000000000') => `${String(n).padStart(8, '0')}-0000-4000-8000-${tail}`;
const VIEWS = ['entree', 'sejour', 'cuisine', 'chambre_1', 'salle_d_eau'] as const;

async function setup(opts: { realDiffusion?: boolean } = {}) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = Date.parse('2027-10-14T08:00:00.000Z');
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const stored = new Set<string>();
  const s: StudioServices = {
    db,
    journal,
    now,
    files: { has: async (r: string) => stored.has(r) },
    ...(opts.realDiffusion ? {} : { diffusion: { canDiffuse: async () => ({ allowed: true }) }, mentions: { checklist: async () => ({ complete: true, text: 'Prix : 150 000 €, honoraires à la charge du vendeur.\nCarte professionnelle n° CPI 0000.', publishedPriceEur: 150_000 }) } }),
  };
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alexandrine', lastName: 'Fictive' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Samuel', lastName: 'Inventé' });
  const agent: Viewer = { role: 'agent', userId: alex.id, networkId: network.id };
  const direction: Viewer = { role: 'direction', userId: 'dir-1', networkId: network.id };
  const routes = studioRoutes();
  const call = async (viewer: Viewer, method: 'GET' | 'POST', path: string, body?: unknown, raw?: string) => {
    const bare = path.split('?')[0]!;
    const route = routes.find((r) => r.method === method && r.pattern.test(bare));
    if (!route) throw new Error(`route inconnue ${method} ${path}`);
    const params = (route.pattern.exec(bare) ?? []).slice(1);
    const init: RequestInit =
      raw !== undefined ? { method, headers: { 'content-type': 'application/json' }, body: raw } : body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
    const response = await route.handle(s, viewer, params, new Request(`https://api.exemple.test/v1${path}`, init));
    const type = response.headers.get('content-type') ?? '';
    return { status: response.status, type, body: type.startsWith('application/json') ? ((await response.json()) as { ok: boolean; data?: any; code?: string; rule?: string }) : null, text: type.startsWith('text/html') ? await response.text() : null };
  };
  /** Un bien de deux pièces, sa fiche avec une photo par vue du guide ; photos et originaux rangés dans le stockage. */
  const property = async (i: number) => {
    const p = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: `STU-${i}`, kind: 'home', city: 'Villebrune', priceEur: 150_000 + i * 1000, surfaceM2: 45 + i, rooms: 2, status: 'available' });
    const photos = VIEWS.map((_, k) => `biens/${p.id}/${uuid(i * 10 + k)}.jpg`);
    for (const [k, ref] of photos.entries()) stored.add(ref).add(`biens/${p.id}/originaux/${uuid(i * 10 + k, '00000000000a')}.jpg`);
    const sheet = { characteristics: { bedrooms: 1, floor: null, floorsTotal: null, buildYear: null, heating: null, outdoor: [], landM2: null, parkingSpaces: 0, elevator: null }, energy: null, coownership: null, risks: null, media: photos.map((ref) => ({ ref, kind: 'photo', edit: 'lumiere_cadrage' })) };
    await db.run("INSERT INTO property_sheets (id, property_id, network_id, version, data, created_by, created_at) VALUES (?, ?, ?, 1, ?, 'agent:a', '2027-10-01')", [`s-${i}`, p.id, network.id, JSON.stringify(sheet)]);
    return { id: p.id, photos, original: (k: number) => `biens/${p.id}/originaux/${uuid(i * 10 + k, '00000000000a')}.jpg` };
  };
  return { db, journal, s, network, alex, sam, agent, direction, call, property };
}

describeWithSqlite('X09 · routes de M19', () => {
  it('X23 · la liste des guides à valider lit son curseur dans l’adresse', async () => {
    const t = await setup();
    expect((await t.call(t.direction, 'GET', '/studio/guides-a-valider')).body).toMatchObject({ ok: true, data: { items: [], next: null } });
    expect((await t.call(t.direction, 'GET', '/studio/guides-a-valider?apres=illisible')).body).toMatchObject({ ok: false, code: 'bad_cursor' });
    expect((await t.call(t.agent, 'GET', '/studio/guides-a-valider')).status).toBe(403);
  });

  it('[R134] [R130] dix biens tests, du guide à la publication en essai, par les seules routes', async () => {
    const t = await setup();
    for (let i = 1; i <= 10; i += 1) {
      const b = await t.property(i);
      // Le guide : chaque vue obligatoire reçoit sa photo, puis la direction valide.
      const g = await t.call(t.agent, 'GET', `/studio/biens/${b.id}/guide`);
      expect(g.body!.data.missing, `bien ${i}`).toEqual([...VIEWS]);
      for (const [k, view] of VIEWS.entries()) expect((await t.call(t.agent, 'POST', `/studio/biens/${b.id}/guide/vues`, { viewKey: view, mediaRef: b.photos[k] })).status).toBe(200);
      expect((await t.call(t.direction, 'POST', `/studio/biens/${b.id}/guide/validation`)).body).toMatchObject({ ok: true, data: { ready: true, validated: { by: 'direction:dir-1' } } });
      // Deux photos corrigées sur l'appareil : leur description et leur certificat.
      for (const k of [0, 1]) {
        const cert = await t.call(t.agent, 'POST', `/studio/biens/${b.id}/photos`, {
          resultRef: b.photos[k],
          resultSha256: 'b'.repeat(63) + String(k),
          originalRef: b.original(k),
          originalSha256: 'a'.repeat(64),
          operations: [{ op: 'exposition', ev: 0.5 }, { op: 'verticales', degrees: -1 }],
          processedOn: 'appareil',
        });
        expect(cert.status, `bien ${i} photo ${k}`).toBe(200);
        // Le certificat public ne dit rien du bien.
        const pub = await studioCertificate(t.s, cert.body!.data.token);
        const text = await pub.text();
        expect(pub.status).toBe(200);
        expect(text).not.toContain(b.id);
        expect(text).not.toMatch(/Villebrune|STU-|Alexandrine|biens\//);
      }
      // La publication : préparée, chaque visuel contrôlé, validée par l'agent, envoyée en essai.
      const prep = await t.call(t.agent, 'POST', `/studio/biens/${b.id}/publications`, { event: 'nouveau_bien', visuals: [b.photos[0], b.photos[1]] });
      expect(prep.body, `bien ${i}`).toMatchObject({ ok: true, mode: 'essai', data: { origin: 'secours' } });
      const postId = prep.body!.data.id as string;
      expect((await t.call(t.agent, 'POST', `/studio/publications/${postId}/envoi`, { targets: [{ channel: 'instagram', account: 'agent' }] })).body).toMatchObject({ rule: 'R134', code: 'non_validee' });
      for (const k of [0, 1]) expect((await t.call(t.agent, 'POST', `/studio/publications/${postId}/visuels`, { ref: b.photos[k], addressVisible: false, personVisible: false })).status).toBe(200);
      expect((await t.call(t.agent, 'POST', `/studio/publications/${postId}/validation`)).status).toBe(200);
      const sent = await t.call(t.agent, 'POST', `/studio/publications/${postId}/envoi`, { targets: [{ channel: 'instagram', account: 'agent' }, { channel: 'facebook', account: 'reseau' }] });
      expect(sent.body, `bien ${i}`).toMatchObject({ ok: true, mode: 'essai', data: { sends: [{ outcome: 'envoye' }, { outcome: 'envoye' }] } });
    }
    expect(await t.db.all("SELECT COUNT(*) AS n FROM social_post_attempts WHERE mode = 'essai'")).toEqual([{ n: 20 }]);
    expect(await t.db.all("SELECT COUNT(*) AS n FROM social_post_attempts WHERE mode <> 'essai'")).toEqual([{ n: 0 }]);
    // AT18 : chaque publication envoyée est un contenu de la mesure de l'origine, par la vraie route.
    expect(await t.db.all("SELECT COUNT(*) AS n FROM public_contents WHERE kind = 'publication'")).toEqual([{ n: 10 }]);
    // AT20 : sans page en ligne, la vraie route le dit ; le bien publié sur un site, elle rend un vrai lien, marqué de son seul contenu [R156].
    const row = (await t.db.first<{ id: string; property_id: string; network_id: string }>('SELECT id, property_id, network_id FROM social_posts LIMIT 1'))!;
    const links = `/studio/biens/${row.property_id}/liens`;
    expect((await t.call(t.direction, 'GET', links)).body).toMatchObject({ ok: true, data: { online: false, videos: [], posts: [] } });
    await t.db.exec('PRAGMA foreign_keys = OFF');
    await t.db.run("INSERT INTO listing_versions (id, property_id, network_id, seq, state, draft_id, price_eur, payload, payload_hash, reason, created_at) VALUES ('lv-at20', ?, ?, 1000, 'en_vente', 'd-at20', 250000, ?, 'h', 'test', '2027-10-11T09:00:00.000Z')", [
      row.property_id,
      row.network_id,
      JSON.stringify({ reference: 'REF-AT20', state: 'en_vente', title: 'Maison inventée', body: 'Texte', mentions: 'Classe énergie D, classe climat C.', priceEur: 250000, media: [] }),
    ]);
    await t.db.run("INSERT INTO public_sites (id, network_id, kind, agent_id, base_url, active, set_by, set_at) VALUES ('site-at20', ?, 'reseau', NULL, 'https://reseau.exemple.test', 1, 'x', '2027-10-11T09:00:00.000Z')", [row.network_id]);
    await t.db.exec('PRAGMA foreign_keys = ON');
    const read = (await t.call(t.direction, 'GET', links)).body as { data: { online: boolean; posts: { id: string; link: string }[] } };
    expect(read.data.online).toBe(true);
    expect(read.data.posts.map((p) => p.id)).toEqual([row.id]);
    const link = new URL(read.data.posts[0]!.link);
    expect(link.origin).toBe('https://reseau.exemple.test');
    expect([...link.searchParams.keys()]).toEqual(['o']);
    const code = (await t.db.first<{ id: string }>("SELECT id FROM public_contents WHERE kind = 'publication' AND ref = ?", [row.id]))!.id;
    expect(link.searchParams.get('o')).toBe(code);
    expect(await t.db.all('SELECT COUNT(*) AS n FROM photo_guide_validations')).toEqual([{ n: 10 }]);
    expect(await t.db.all('SELECT COUNT(*) AS n FROM photo_certificates')).toEqual([{ n: 20 }]);
    // La mesure des visuels : 20 publiés, tous sans adresse visible.
    expect((await t.call(t.direction, 'GET', '/studio/mesure-visuels')).body).toMatchObject({ ok: true, data: { counted: 20, complete: true, passed: true } });
  });

  it('[R16] chaque route refuse tout rôle non admis avant de lire le corps, et l’écrit au journal', async () => {
    const t = await setup();
    const b = await t.property(1);
    const partner: Viewer = { role: 'partner', userId: 'p-1', networkId: t.network.id };
    const compliance: Viewer = { role: 'compliance', userId: 'c-1', networkId: t.network.id };
    const refusals = async () => (await t.journal.all()).filter((e) => e.type === 'acces.refuse').length;
    const paths: Record<string, string> = {
      'studio.atelier': `/studio/biens/${b.id}`,
      'studio.liens': `/studio/biens/${b.id}/liens`,
      'studio.guide': `/studio/biens/${b.id}/guide`,
      'studio.guides_a_valider': '/studio/guides-a-valider',
      'studio.guide.vue': `/studio/biens/${b.id}/guide/vues`,
      'studio.guide.validation': `/studio/biens/${b.id}/guide/validation`,
      'studio.photo': `/studio/biens/${b.id}/photos`,
      'studio.depot': `/studio/biens/${b.id}/fichiers/photo`,
      'studio.montage.modele': `/studio/biens/${b.id}/montage`,
      'studio.montage': `/studio/biens/${b.id}/montage`,
      'studio.plan': `/studio/biens/${b.id}/plan`,
      'studio.plan.saisie': `/studio/biens/${b.id}/plan`,
      'studio.publication': `/studio/biens/${b.id}/publications`,
      'studio.publication.lire': '/studio/publications/x1',
      'studio.publication.visuel': '/studio/publications/x1/visuels',
      'studio.publication.validation': '/studio/publications/x1/validation',
      'studio.publication.envoi': '/studio/publications/x1/envoi',
      'studio.support': `/studio/biens/${b.id}/supports/flyer`,
      'studio.carte': `/studio/agents/${t.alex.id}/carte`,
      'studio.bibliotheque.choix': '/studio/bibliotheque/musique',
      'studio.bibliotheque': '/studio/bibliotheque',
      'studio.bibliotheque.ajout': '/studio/bibliotheque',
      'studio.bibliotheque.preuve': '/studio/bibliotheque/preuves',
      'studio.bibliotheque.retrait': '/studio/bibliotheque/x1/retrait',
      'studio.option': '/studio/options',
      'studio.mesure': '/studio/mesure-visuels',
    };
    const routes = studioRoutes();
    expect(routes.map((r) => r.name).sort()).toEqual(Object.keys(paths).sort());
    for (const route of routes) {
      const path = paths[route.name]!;
      expect(route.pattern.test(path), route.name).toBe(true);
      for (const v of [partner, compliance, t.agent, t.direction].filter((x) => !route.roles.includes(x.role))) {
        const before = await refusals();
        // Un corps illisible : le refus de rôle passe avant, sans le lire.
        const r = await t.call(v, route.method, path, undefined, route.method === 'POST' ? '{pas du json' : undefined);
        expect(r.status, `${route.name} ${v.role}`).toBe(403);
        expect(r.body, `${route.name} ${v.role}`).toMatchObject({ rule: 'R16', code: 'role' });
        expect((await refusals()) - before, `${route.name} ${v.role}`).toBe(1);
      }
    }
    // Les rôles admis : jamais le partenaire, jamais la conformité sur le Studio.
    expect(routes.every((r) => !r.roles.includes('partner') && !r.roles.includes('compliance'))).toBe(true);
    // Un autre agent sur le bien d'Alex : refusé par la couche métier, au journal aussi.
    const sam: Viewer = { role: 'agent', userId: t.sam.id, networkId: t.network.id };
    expect((await t.call(sam, 'GET', `/studio/biens/${b.id}/guide`)).status).toBe(403);
    // Un corps illisible pour un rôle admis : 400.
    expect((await t.call(t.agent, 'POST', `/studio/biens/${b.id}/plan`, undefined, '{pas du json')).body).toMatchObject({ code: 'invalid_body' });
  });

  it('[R133] [R13] la preuve d’une licence : déposée par la direction, reprise par l’entrée, jamais publiée, et le journal sans référence', async () => {
    const t = await setup();
    const kept: { key: string; type: string }[] = [];
    const has = t.s.files.has;
    const s: StudioServices = {
      ...t.s,
      uploads: { put: async (key, _bytes, type) => void kept.push({ key, type }) },
      files: { has: async (r) => kept.some((k) => k.key === r) || has(r) },
    };
    const route = studioRoutes().find((r) => r.name === 'studio.bibliotheque.preuve')!;
    const post = (body: Uint8Array<ArrayBuffer>, type: string, services: StudioServices = s, viewer: Viewer = t.direction) =>
      route.handle(services, viewer, [], new Request('https://api.exemple.test/v1/studio/bibliotheque/preuves', { method: 'POST', headers: { 'content-type': type }, body }));
    const pdf = new TextEncoder().encode('%PDF-1.7 licence inventée');
    const ok = await post(pdf, 'application/pdf');
    expect(ok.status).toBe(200);
    const { proofRef } = ((await ok.json()) as { data: { proofRef: string } }).data;
    expect(proofRef).toMatch(/^bibliotheque\/preuves\/[0-9a-f-]{36}\.pdf$/);
    expect(kept).toEqual([{ key: proofRef, type: 'application/pdf' }]);
    // La référence rendue est celle que la bibliothèque accepte : aucune entrée ne pouvait être rangée sans cette route.
    const { Bibliotheque } = await import('../../core/src/studio/bibliotheque.ts');
    const added = await new Bibliotheque(t.db, t.journal, s.files, { now: t.s.now }).add(t.direction, { kind: 'musique', title: 'Air inventé', source: 'achat_unitaire', licence: 'licence_achetee', validUntil: null, proofRef });
    expect(added.ok).toBe(true);
    // Ce qui n'est pas une preuve ne se range pas.
    expect((await post(pdf, 'text/html')).status).toBe(415);
    expect((await post(new TextEncoder().encode('<html>'), 'application/pdf')).status).toBe(415);
    expect((await post(new Uint8Array(10 * 1024 * 1024 + 1).fill(0x25), 'application/pdf')).status).toBe(413);
    const closed = await post(pdf, 'application/pdf', t.s);
    expect(closed.status).toBe(503);
    expect(await closed.json()).toMatchObject({ code: 'storage_unavailable' });
    expect(kept).toHaveLength(1);
    // Un agent ne dépose rien, et rien n'est lu.
    expect((await post(pdf, 'application/pdf', s, t.agent)).status).toBe(403);
    expect(kept).toHaveLength(1);
    const events = (await t.journal.all()).filter((e) => e.type === 'studio.bibliotheque.preuve_deposee');
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).not.toContain(proofRef);
  });

  it('[R73] une option pour un bien sans code postal prend le code dit par l’agent', async () => {
    const t = await setup();
    const b = await t.property(1);
    const store = new FicheClient(t.db, { now: t.s.now });
    const person = await store.createPerson({ networkId: t.network.id, agentId: t.alex.id, firstName: 'Client', lastName: 'Inventé' });
    const project = await store.createProject({ networkId: t.network.id, agentId: t.alex.id, personId: person.id, kind: 'sell' });
    await store.linkProjectProperty({ networkId: t.network.id, agentId: t.alex.id, projectId: project.id, propertyId: b.id, role: 'owned' });
    const ask = { projectId: project.id, propertyId: b.id, option: 'drone' };
    expect((await t.call(t.agent, 'POST', '/studio/options', ask)).body).toMatchObject({ code: 'bad_postcode' });
    // Le code arrive jusqu'au tirage : ici, aucun photographe dans cette zone.
    expect((await t.call(t.agent, 'POST', '/studio/options', { ...ask, postcode: '21000' })).body).toMatchObject({ rule: 'R73', code: 'no_partner' });
  });

  it('[R42] sans mandat en cours, la porte de D05 refuse la publication ; les supports partent en HTML', async () => {
    const t = await setup({ realDiffusion: true });
    const b = await t.property(1);
    await t.call(t.agent, 'POST', `/studio/biens/${b.id}/photos`, { resultRef: b.photos[0], resultSha256: 'c'.repeat(64), originalRef: b.original(0), originalSha256: 'd'.repeat(64), operations: [{ op: 'contraste', amount: 10 }], processedOn: 'appareil' });
    const prep = await t.call(t.agent, 'POST', `/studio/biens/${b.id}/publications`, { event: 'nouveau_bien', visuals: [b.photos[0]] });
    expect(prep.status).toBe(409);
    expect(prep.body).toMatchObject({ rule: 'R42', code: 'bien_non_diffusable' });
    // Pas encore publié : pas de support ; la carte de visite, elle, s'imprime.
    expect((await t.call(t.agent, 'GET', `/studio/biens/${b.id}/supports/flyer`)).body).toMatchObject({ code: 'pas_publie' });
    const card = await t.call(t.agent, 'GET', `/studio/agents/${t.alex.id}/carte`);
    expect(card.type).toMatch(/^text\/html/);
    expect(card.text).toContain('Agent immobilier');
    // Un plan saisi et relu par les routes.
    const plan = await t.call(t.agent, 'POST', `/studio/biens/${b.id}/plan`, { rooms: [{ kind: 'sejour', xCm: 0, yCm: 0, widthCm: 500, depthCm: 400 }] });
    expect(plan.body).toMatchObject({ ok: true, data: { inside: '20,00 m²', mention: 'Plan indicatif, non contractuel' } });
    // Un certificat inconnu : 404, sans rien dire.
    expect((await studioCertificate(t.s, 'f'.repeat(32))).status).toBe(404);
  });

  it('[R16] X11 · l’atelier du bien : photos de la fiche, certificat de chacune, publications ; un autre agent ne lit rien', async () => {
    const t = await setup();
    const b = await t.property(1);
    await t.call(t.agent, 'POST', `/studio/biens/${b.id}/photos`, { resultRef: b.photos[0], resultSha256: 'c'.repeat(64), originalRef: b.original(0), originalSha256: 'd'.repeat(64), operations: [{ op: 'contraste', amount: 10 }], processedOn: 'appareil' });
    const prep = await t.call(t.agent, 'POST', `/studio/biens/${b.id}/publications`, { event: 'nouveau_bien', visuals: [b.photos[0]] });
    expect(prep.status).toBe(200);
    const a = await t.call(t.agent, 'GET', `/studio/biens/${b.id}`);
    expect(a.status).toBe(200);
    expect(a.body!.data.photos).toHaveLength(5);
    expect(a.body!.data.photos[0]).toMatchObject({ ref: b.photos[0], certificatePath: expect.stringMatching(/^\/certificat-photo\/[0-9a-f]{32}$/) });
    expect(a.body!.data.photos[1]).toMatchObject({ ref: b.photos[1], certificatePath: null });
    expect(a.body!.data.posts).toEqual([{ id: prep.body!.data.id, event: 'nouveau_bien', validated: false, createdAt: expect.any(String) }]);
    const sam: Viewer = { role: 'agent', userId: t.sam.id, networkId: t.network.id };
    expect((await t.call(sam, 'GET', `/studio/biens/${b.id}`)).status).toBe(403);
    expect((await t.call({ role: 'compliance', userId: 'c1', networkId: t.network.id } as Viewer, 'GET', `/studio/biens/${b.id}`)).status).toBe(403);
  });
});

it('X09 · chaque route a un nom stable et une adresse unique par méthode', () => {
  const routes = studioRoutes();
  const keys = routes.map((r) => `${r.method} ${r.pattern.source}`);
  expect(new Set(keys).size).toBe(keys.length);
  expect(routes.every((r) => /^studio(\.[a-z_]+)*$/.test(r.name))).toBe(true);
});

describeWithSqlite('AU036 · la vraie route d’envoi avec les réseaux mis en service', () => {
  it('[R134] Facebook et Instagram du réseau partent pour de vrai, avec leur lien ; les autres réseaux restent d’essai', async () => {
    const t = await setup();
    const calls: string[] = [];
    let n = 0;
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if ((init?.method ?? 'GET') === 'HEAD') return new Response(null, { status: 200, headers: { 'content-type': 'image/jpeg' } });
      calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
      if ((init?.method ?? 'GET') === 'GET') return Response.json({ permalink_url: 'https://www.facebook.com/p/1', permalink: 'https://www.instagram.com/p/2' });
      return Response.json({ id: String(100 + ++n) });
    }) as typeof fetch;
    const social = liveSocialChannels({ RESEAUX_MODE: 'reel', META_PAGE_ID: '111', META_IG_USER_ID: '222', META_PAGE_TOKEN: 'jeton-invente', RESEAUX_MEDIA_BASE: 'https://reseau.exemple.test/medias/' }, fakeFetch)!;
    t.s.channels = social.channels;
    t.s.live = social.live;
    const b = await t.property(1);
    for (const [k, view] of VIEWS.entries()) expect((await t.call(t.agent, 'POST', `/studio/biens/${b.id}/guide/vues`, { viewKey: view, mediaRef: b.photos[k] })).status).toBe(200);
    expect((await t.call(t.direction, 'POST', `/studio/biens/${b.id}/guide/validation`)).status).toBe(200);
    for (const k of [0, 1]) {
      const cert = await t.call(t.agent, 'POST', `/studio/biens/${b.id}/photos`, { resultRef: b.photos[k], resultSha256: 'b'.repeat(63) + String(k), originalRef: b.original(k), originalSha256: 'a'.repeat(64), operations: [{ op: 'exposition', ev: 0.5 }], processedOn: 'appareil' });
      expect(cert.status, `photo ${k}`).toBe(200);
    }
    const prep = await t.call(t.agent, 'POST', `/studio/biens/${b.id}/publications`, { event: 'nouveau_bien', visuals: [b.photos[0], b.photos[1]] });
    expect(prep.status).toBe(200);
    const postId = prep.body!.data.id as string;
    for (const k of [0, 1]) expect((await t.call(t.agent, 'POST', `/studio/publications/${postId}/visuels`, { ref: b.photos[k], addressVisible: false, personVisible: false })).status).toBe(200);
    expect((await t.call(t.agent, 'POST', `/studio/publications/${postId}/validation`)).status).toBe(200);
    const sent = await t.call(t.agent, 'POST', `/studio/publications/${postId}/envoi`, {
      targets: [
        { channel: 'facebook', account: 'reseau' },
        { channel: 'instagram', account: 'reseau' },
        { channel: 'linkedin', account: 'agent' },
      ],
    });
    expect(sent.body?.data.sends).toEqual([
      { channel: 'facebook', account: 'reseau', mode: 'reel', outcome: 'envoye', url: 'https://www.facebook.com/p/1', code: null, action: null },
      { channel: 'instagram', account: 'reseau', mode: 'reel', outcome: 'envoye', url: 'https://www.instagram.com/p/2', code: null, action: null },
      { channel: 'linkedin', account: 'agent', mode: 'essai', outcome: 'envoye', url: null, code: null, action: null },
    ]);
    expect(calls.filter((c) => c.startsWith('POST')).length).toBe(7);
    expect(calls.every((c) => c.includes('/v21.0/'))).toBe(true);
  });
});

it('[R26] [R134] sans chaque pièce rangée et bien formée, rien de réel : tous les réseaux restent d’essai', () => {
  const full = { RESEAUX_MODE: 'reel', META_PAGE_ID: '111', META_IG_USER_ID: '222', META_PAGE_TOKEN: 'jeton-invente', RESEAUX_MEDIA_BASE: 'https://reseau.exemple.test/medias/' };
  const on = liveSocialChannels(full)!;
  expect(on.live).toBe(true);
  expect(on.channels.map((c) => [c.channel, c.mode])).toEqual([
    ['facebook', 'reel'],
    ['instagram', 'reel'],
    ['linkedin', 'essai'],
    ['google', 'essai'],
    ['tiktok', 'essai'],
    ['youtube', 'essai'],
  ]);
  for (const off of [
    { ...full, RESEAUX_MODE: undefined },
    { ...full, RESEAUX_MODE: 'essai' },
    { ...full, META_PAGE_ID: undefined },
    { ...full, META_PAGE_ID: 'ma-page' },
    { ...full, META_IG_USER_ID: '' },
    { ...full, META_PAGE_TOKEN: '  ' },
    { ...full, RESEAUX_MEDIA_BASE: 'http://reseau.exemple.test/medias/' },
    { ...full, RESEAUX_MEDIA_BASE: 'https://reseau.exemple.test/photos/' },
    { ...full, RESEAUX_MEDIA_BASE: 'https://moi:secret@reseau.exemple.test/medias/' },
    { ...full, RESEAUX_MEDIA_BASE: 'pas une adresse' },
  ]) expect(liveSocialChannels(off), JSON.stringify(off)).toBeNull();
  expect(mediaBase('https://reseau.exemple.test/medias/?x=1')).toBeNull();
});
