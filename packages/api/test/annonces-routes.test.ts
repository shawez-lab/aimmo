import { expect, it } from 'vitest';
import type { Viewer } from '@aimmo/core';
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

  it('[R16] chaque route passe par les droits ; un refus rend 403 et va au journal', async () => {
    const t = await setup();
    for (const [method, path] of [
      ['GET', `/annonces/${t.propertyId}/fiche`],
      ['GET', `/annonces/${t.propertyId}/controle`],
      ['GET', `/annonces/${t.propertyId}/brouillon`],
      ['POST', `/annonces/${t.propertyId}/brouillon`],
      ['GET', `/annonces/${t.propertyId}/publication`],
      ['POST', `/annonces/${t.propertyId}/publication`],
      ['GET', `/annonces/${t.propertyId}/semaine?lundi=2027-03-01`],
    ] as const) {
      const r = await t.call(t.sam, method, path);
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.body).toMatchObject({ ok: false, rule: 'R16' });
    }
    const compliance = { role: 'compliance', userId: 'c-1', networkId: t.network.id } as Viewer;
    expect((await t.call(compliance, 'POST', `/annonces/${t.propertyId}/publication`)).status).toBe(403);
    expect((await t.call(t.agent, 'GET', '/annonces/bien-inconnu/fiche')).status).toBe(404);
    const refusals = (await t.journal.bySubject(`property:${t.propertyId}`)).filter((e) => e.type === 'acces.refuse');
    expect(refusals.length).toBeGreaterThanOrEqual(8);
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
});

it('P09 · chaque route a un nom stable, sans identifiant, et une adresse unique par méthode', () => {
  const routes = annonceRoutes();
  const keys = routes.map((r) => `${r.method} ${r.pattern.source}`);
  expect(new Set(keys).size).toBe(keys.length);
  expect(routes.every((r) => /^annonces\.[a-z_.]+$/.test(r.name))).toBe(true);
});
