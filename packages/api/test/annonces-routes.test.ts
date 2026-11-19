import { expect, it } from 'vitest';
import { appendEvent, type Viewer } from '@aimmo/core';
import { annonceRoutes, syncAnnonces, type AnnonceServices } from '../src/annonces.ts';
import { DELAY_END, MIN, setupAnnonce } from '../../core/test/annonces-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// Réseau, bien, vendeur et mandat inventés (jeu commun de M07).
async function setup() {
  const t = await setupAnnonce();
  const s: AnnonceServices = { db: t.db, journal: t.journal, acces: t.acces, now: t.now };
  const routes = annonceRoutes({ channels: t.channels });
  /** Comme `app.ts` : la route est choisie par l'adresse et la méthode, sous `/v1`. */
  const call = async (viewer: Viewer, method: 'GET' | 'POST', path: string, body?: unknown) => {
    const url = new URL(`https://api.exemple.test/v1${path}`);
    const route = routes.find((r) => r.method === method && r.pattern.test(url.pathname.slice(3)));
    if (!route) throw new Error(`route inconnue ${method} ${path}`);
    const params = (route.pattern.exec(url.pathname.slice(3)) ?? []).slice(1);
    const request = new Request(url, body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const response = await route.handle(s, viewer, params, request);
    return { status: response.status, body: (await response.json()) as { ok: boolean; data?: any; code?: string; rule?: string } };
  };
  return { ...t, s, call };
}

describeWithSqlite('P09 · routes de M07', () => {
  it('parcours complet par les routes : de la fin du délai de rétractation à la publication partout en moins d’une heure', async () => {
    const t = await setup();
    // L'agent lit la fiche, la liste de contrôle et propose l'annonce pendant le délai.
    t.setClock(new Date('2027-02-12T10:00:00.000Z'));
    expect((await t.call(t.agent, 'GET', `/annonces/${t.propertyId}/fiche`)).body).toMatchObject({ ok: true, data: { version: 1 } });
    const controle = await t.call(t.agent, 'GET', `/annonces/${t.propertyId}/controle`);
    expect(controle.body).toMatchObject({ ok: true, data: { complete: true, publishedPriceEur: 210000 } });
    const proposed = await t.call(t.agent, 'POST', `/annonces/${t.propertyId}/brouillon`);
    expect(proposed.body).toMatchObject({ ok: true, data: { origin: 'secours', seq: 2 }, aiRefused: null });
    // Le jeu de test a déjà proposé un premier brouillon : seul le dernier se valide.
    expect((await t.call(t.agent, 'POST', `/annonces/brouillons/${t.draftId}/validation`)).body).toMatchObject({ ok: false, rule: 'R47', code: 'not_latest_draft' });
    const validated = await t.call(t.agent, 'POST', `/annonces/brouillons/${proposed.body.data.id}/validation`);
    expect(validated.status).toBe(200);
    // Pendant le délai, un passage immédiat ne publie rien.
    expect((await t.call(t.agent, 'POST', `/annonces/${t.propertyId}/publication`)).body).toMatchObject({ ok: true, data: { version: null } });
    // Les passages toutes les 15 minutes : la publication part dans l'heure qui suit la fin du délai.
    let publishedAt: Date | null = null;
    for (let at = DELAY_END.getTime() - 30 * MIN; at <= DELAY_END.getTime() + 60 * MIN; at += 15 * MIN) {
      t.setClock(new Date(at));
      await syncAnnonces(t.s, t.network.id, { channels: t.channels });
      if (publishedAt === null && t.channels.every((c) => c.received.length > 0)) publishedAt = new Date(at);
    }
    expect(publishedAt).not.toBeNull();
    expect(publishedAt!.getTime() - DELAY_END.getTime()).toBeLessThan(60 * MIN);
    expect(publishedAt!.getTime()).toBeGreaterThanOrEqual(DELAY_END.getTime());
    const status = await t.call(t.agent, 'GET', `/annonces/${t.propertyId}/publication`);
    expect(status.body).toMatchObject({ ok: true, data: { version: 1, state: 'en_vente', priceEur: 210000, channels: { site: 'publiee', reseaux: 'publiee', google: 'publiee', portails: 'publiee' } } });
  });

  it('[R16] chaque route passe par les droits ; chaque refus rend 403 et écrit une ligne au journal', async () => {
    const t = await setup();
    const video = `biens/${t.propertyId}/0b6f1d2e-3333-4a2b-8c3d-000000000003.mp4`;
    const refusals = async () => (await t.journal.all()).filter((e) => e.type === 'acces.refuse').length;
    const cases: [string, 'GET' | 'POST', string, unknown?][] = [
      ['fiche', 'GET', `/annonces/${t.propertyId}/fiche`],
      ['fiche.enregistrer', 'POST', `/annonces/${t.propertyId}/fiche`, {}],
      ['controle', 'GET', `/annonces/${t.propertyId}/controle`],
      ['brouillon', 'GET', `/annonces/${t.propertyId}/brouillon`],
      ['brouillon.proposer', 'POST', `/annonces/${t.propertyId}/brouillon`],
      ['correction', 'POST', `/annonces/${t.propertyId}/correction`, { title: 'Appartement à Dijon', body: 'Au 3e étage.' }],
      ['validation', 'POST', `/annonces/brouillons/${t.draftId}/validation`],
      ['publication', 'GET', `/annonces/${t.propertyId}/publication`],
      ['publication.passage', 'POST', `/annonces/${t.propertyId}/publication`],
      ['semaine', 'GET', `/annonces/${t.propertyId}/semaine?lundi=2027-03-01`],
      ['video.controle', 'POST', `/annonces/${t.propertyId}/videos/controle`, { ref: video, subtitles: ['Visite.'], caption: 'Visite' }],
      ['plan_tournage', 'GET', `/annonces/${t.propertyId}/plan-de-tournage`],
    ];
    for (const [name, method, path, body] of cases) {
      const before = await refusals();
      const r = await t.call(t.sam, method, path, body);
      expect(r.status, name).toBe(403);
      expect(r.body, name).toMatchObject({ ok: false, rule: 'R16' });
      expect((await refusals()) - before, name).toBe(1);
    }
    // La conformité lit, mais ne valide pas ; un agent d'un autre réseau ne voit pas le brouillon.
    const compliance = { role: 'compliance', userId: 'c-1', networkId: t.network.id } as Viewer;
    expect((await t.call(compliance, 'POST', `/annonces/brouillons/${t.draftId}/validation`)).status).toBe(403);
    expect((await t.call(compliance, 'POST', `/annonces/${t.propertyId}/publication`)).status).toBe(403);
    const stranger = { role: 'agent', userId: 'agent-ailleurs', networkId: 'autre-reseau' } as Viewer;
    const before = await refusals();
    const r = await t.call(stranger, 'POST', `/annonces/brouillons/${t.draftId}/validation`);
    expect(r.status).toBe(404);
    expect((await refusals()) - before).toBe(1);
    expect((await t.journal.bySubject(`listing:${t.draftId}`)).filter((e) => e.type === 'acces.refuse')).toHaveLength(1);
    expect((await t.call(t.agent, 'GET', '/annonces/bien-inconnu/fiche')).status).toBe(404);
  });

  it('X19 · siVersion : rien n’est rangé si la fiche a changé depuis sa lecture ; sans lui, rien ne change', async () => {
    const t = await setup();
    const read = await t.call(t.agent, 'GET', `/annonces/${t.propertyId}/fiche`);
    const { sheet, version } = read.body.data;
    const next = await t.call(t.agent, 'POST', `/annonces/${t.propertyId}/fiche?siVersion=${version}`, sheet);
    expect(next.body).toMatchObject({ ok: true, data: { version: version + 1 } });
    const stale = await t.call(t.agent, 'POST', `/annonces/${t.propertyId}/fiche?siVersion=${version}`, { ...sheet, risks: { inRiskZone: true } });
    expect(stale.status).toBe(400);
    expect(stale.body).toMatchObject({ ok: false, code: 'stale' });
    expect((await t.call(t.agent, 'GET', `/annonces/${t.propertyId}/fiche`)).body.data.version).toBe(version + 1);
    expect((await t.call(t.agent, 'POST', `/annonces/${t.propertyId}/fiche?siVersion=abc`, sheet)).status).toBe(400);
    expect((await t.call(t.agent, 'POST', `/annonces/${t.propertyId}/fiche`, sheet)).body).toMatchObject({ ok: true, data: { version: version + 2 } });
  });

  it('les corps mal formés sont refusés ; une correction qui invente rend 409 avec la phrase en cause', async () => {
    const t = await setup();
    const url = `https://api.exemple.test/v1/annonces/${t.propertyId}/correction`;
    const route = annonceRoutes().find((r) => r.name === 'annonces.correction')!;
    const r1 = await route.handle(t.s, t.agent, [t.propertyId], new Request(url, { method: 'POST', body: 'pas du json' }));
    expect(r1.status).toBe(400);
    const r2 = await t.call(t.agent, 'POST', `/annonces/${t.propertyId}/correction`, { title: 'Appartement à Dijon', body: 'Avec piscine.' });
    expect(r2.status).toBe(409);
    expect(r2.body).toMatchObject({ ok: false, rule: 'R47', code: 'refused_text' });
    const r3 = await t.call(t.agent, 'POST', `/annonces/${t.propertyId}/fiche`, { energy: { energyClass: 'Z' } });
    expect(r3.status).toBe(400);
    expect(r3.body).toMatchObject({ ok: false, code: 'invalid', field: 'energy.energyClass' });
    const plan = await t.call(t.agent, 'GET', `/annonces/${t.propertyId}/plan-de-tournage`);
    expect(plan.body.data.shots.length).toBeGreaterThan(0);
    const video = await t.call(t.agent, 'POST', `/annonces/${t.propertyId}/videos/controle`, { ref: `biens/${t.propertyId}/0b6f1d2e-3333-4a2b-8c3d-000000000003.mp4`, subtitles: ['Au 12 rue des Essais.'], caption: 'Visite' });
    expect(video.status).toBe(409);
    expect(video.body).toMatchObject({ rule: 'R46', code: 'refused_text' });
  });

  it('SV11 · le passage de publication mène aussi les commerces : sans mandat, un commerce rendu disponible ici revient en brouillon, sans version d’annonce [R42]', async () => {
    const t = await setup();
    const id = '0b6f1d2e-5555-4a2b-8c3d-000000000077';
    const at = new Date().toISOString();
    await t.s.db.run("INSERT INTO properties (id, network_id, reference, kind, status, created_at, updated_at) VALUES (?, ?, 'CE-77', 'business', 'available', ?, ?)", [id, t.network.id, at, at]);
    await appendEvent(t.s.journal, { type: 'bien.disponible', actor: 'system:commerces', subject: `property:${id}`, data: { rule: 'R42' } }, t.s.now);
    await syncAnnonces(t.s, t.network.id, { channels: t.channels });
    expect(await t.s.db.first('SELECT status FROM properties WHERE id = ?', [id])).toEqual({ status: 'draft' });
    expect(await t.s.db.first('SELECT 1 FROM listing_versions WHERE property_id = ?', [id])).toBeNull();
  });
});

it('P09 · chaque route a un nom stable, sans identifiant, et une adresse unique par méthode', () => {
  const routes = annonceRoutes();
  const keys = routes.map((r) => `${r.method} ${r.pattern.source}`);
  expect(new Set(keys).size).toBe(keys.length);
  expect(routes.every((r) => /^annonces\.[a-z_.]+$/.test(r.name))).toBe(true);
});

describeWithSqlite('AU004 · routes des portails', () => {
  it('[R668] [R16] la direction règle un portail, l’agent le choisit ; le passage le diffuse ; le statut par portail se lit par la route', async () => {
    const t = await setupAnnonce();
    const s: AnnonceServices = { db: t.db, journal: t.journal, acces: t.acces, now: t.now };
    let n = 0;
    const received: string[] = [];
    const portals = [{ portal: 'seloger', mode: 'reel' as const, send: async (op: { key: string; action: string }) => (received.push(op.action), { receipt: `ACK-${++n}` }) }];
    const routes = annonceRoutes({ channels: t.channels, portals });
    const call = async (viewer: Viewer, method: 'GET' | 'POST', path: string, body?: unknown) => {
      const url = new URL(`https://api.exemple.test/v1${path}`);
      const route = routes.find((r) => r.method === method && r.pattern.test(url.pathname.slice(3)))!;
      const params = (route.pattern.exec(url.pathname.slice(3)) ?? []).slice(1);
      const request = new Request(url, body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const response = await route.handle(s, viewer, params, request);
      return { status: response.status, body: (await response.json()) as { ok: boolean; data?: any; code?: string; rule?: string } };
    };
    const reglage = { code: 'seloger', label: 'SeLoger', host: 'www.seloger.com', requiredFields: ['prix'], minPhotos: 0 };
    expect((await call(t.agent, 'POST', '/annonces-portails', reglage)).status).toBe(403);
    expect((await call(t.agent, 'GET', '/annonces-portails')).status).toBe(403);
    expect((await call(t.direction, 'POST', '/annonces-portails', reglage)).body).toMatchObject({ ok: true });
    expect((await call(t.direction, 'GET', '/annonces-portails')).body).toMatchObject({ ok: true, data: [{ code: 'seloger', active: true }] });
    expect((await call(t.sam, 'POST', `/annonces/${t.propertyId}/portails`, { portal: 'seloger', chosen: true })).status).toBe(403);
    expect((await call(t.agent, 'POST', `/annonces/${t.propertyId}/portails`, { portal: 'seloger', chosen: true })).body).toMatchObject({ ok: true });
    t.setClock(new Date('2027-02-12T10:00:00.000Z'));
    await t.annonces.validate(t.agent, t.draftId);
    t.setClock(new Date('2027-03-01T08:00:00.000Z'));
    await syncAnnonces(s, t.network.id, { channels: t.channels, portals });
    expect(received).toEqual(['publier']);
    const st = await call(t.agent, 'GET', `/annonces/${t.propertyId}/portails`);
    expect(st.body).toMatchObject({ ok: true, data: [{ portal: 'seloger', plan: 'a_diffuser', mode: 'reel', state: 'publiee', acknowledged: { seq: 1, action: 'publier', receipt: 'ACK-1' } }] });
    expect((await call(t.sam, 'GET', `/annonces/${t.propertyId}/portails`)).status).toBe(403);
    // Le passage immédiat de l'agent fait suivre les portails : un avenant y part tout de suite.
    t.setClock(new Date('2027-03-01T08:07:00.000Z'));
    await t.amend(190000);
    await call(t.agent, 'POST', `/annonces/${t.propertyId}/publication`);
    expect(received).toEqual(['publier', 'modifier']);
  });
});
