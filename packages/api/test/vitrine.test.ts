import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { annonces, verifyChain } from '@aimmo/core';
import { handleRequest } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { quarterSlot, runListingSync, type MediaStore } from '../src/vitrine.ts';
import { DELAY_END, MIN, setupAnnonce } from '../../core/test/annonces-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// Réseau, bien, vendeur, photos et clés inventés.
const BASE = 'https://aimmo-api.example.test';
const KEYS = { alex: 'test-cle-p10-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa', sam: 'test-cle-p10-sam-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', compliance: 'test-cle-p10-conformite-cccccccccccccccccccccc' };
type Who = keyof typeof KEYS;

async function setup() {
  const t = await setupAnnonce();
  const ids: Record<Who, { role: string; userId: string }> = { alex: { role: 'agent', userId: t.alexId }, sam: { role: 'agent', userId: t.sam.userId }, compliance: { role: 'compliance', userId: 'c-1' } };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: t.network.id, ...ids[w] }))));
  const stored = new Map<string, string>();
  const media: MediaStore = { get: async (key) => (stored.has(key) ? { body: stored.get(key)! } : null) };
  const fetchAs = async (who: Who | null, method: string, path: string) => {
    const headers: Record<string, string> = who ? { authorization: `Bearer ${KEYS[who]}` } : {};
    return handleRequest(new Request(`${BASE}${path}`, { method, headers }), { db: t.db, apiKeys, mode: 'essai', media, now: t.now });
  };
  const publish = async () => {
    const v = await t.annonces.validate(t.agent, t.draftId);
    if (!v.ok) throw new Error(v.code);
    t.setClock(new Date(DELAY_END.getTime() + 5 * MIN));
    await runListingSync(t.db, t.now);
  };
  return { ...t, fetchAs, stored, media, publish };
}

describeWithSqlite('P10 · branchement de M07 dans le socle', () => {
  it('[R16] les routes de M07 répondent derrière la clé d’API, sous les droits ; la liste des biens est celle de l’agent', async () => {
    const t = await setup();
    expect((await t.fetchAs(null, 'GET', `/v1/annonces/${t.propertyId}/controle`)).status).toBe(401);
    const check = await t.fetchAs('alex', 'GET', `/v1/annonces/${t.propertyId}/controle`);
    expect(check.status).toBe(200);
    expect(await check.json()).toMatchObject({ ok: true, data: { complete: true, publishedPriceEur: 210000 } });
    expect(await (await t.fetchAs('alex', 'GET', '/v1/annonces')).json()).toMatchObject({ ok: true, data: [{ id: t.propertyId, reference: 'REF-T-1', city: 'Dijon', state: null }] });
    // DS023 · de quoi nommer le bien : son genre, ses pièces, maison ou appartement ; la fiche, plus récente, l'emporte (AU070).
    expect(await (await t.fetchAs('alex', 'GET', '/v1/annonces')).json()).toMatchObject({ data: [{ kind: 'home', rooms: 3, dwelling: 'house' }] });
    const sheet = await t.db.first<{ data: string; version: number }>('SELECT data, version FROM property_sheets WHERE property_id = ? ORDER BY version DESC LIMIT 1', [t.propertyId]);
    const said = JSON.parse(sheet!.data) as { characteristics: Record<string, unknown> };
    said.characteristics.dwelling = 'apartment';
    await t.db.run('INSERT INTO property_sheets (id, property_id, network_id, version, data, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', ['fiche-ds023', t.propertyId, t.network.id, sheet!.version + 1, JSON.stringify(said), 'essai', '2027-01-01T00:00:00.000Z']);
    expect(await (await t.fetchAs('alex', 'GET', '/v1/annonces')).json()).toMatchObject({ data: [{ kind: 'home', rooms: 3, dwelling: 'apartment' }] });
    // Un terrain n'est ni l'un ni l'autre, quoi qu'on ait rangé.
    await t.db.run("UPDATE properties SET kind = 'land' WHERE id = ?", [t.propertyId]);
    expect(await (await t.fetchAs('alex', 'GET', '/v1/annonces')).json()).toMatchObject({ data: [{ kind: 'land', dwelling: null }] });
    await t.db.run("UPDATE properties SET kind = 'home' WHERE id = ?", [t.propertyId]);
    expect((await (await t.fetchAs('sam', 'GET', '/v1/annonces')).json()) as unknown).toMatchObject({ ok: true, data: [] });
    const before = (await t.journal.all()).filter((e) => e.type === 'acces.refuse').length;
    expect((await t.fetchAs('compliance', 'GET', '/v1/annonces')).status).toBe(403);
    expect((await t.fetchAs('sam', 'POST', `/v1/annonces/brouillons/${t.draftId}/validation`)).status).toBe(403);
    expect((await t.journal.all()).filter((e) => e.type === 'acces.refuse').length - before).toBe(2);
    // Un agent parti ne voit plus ses biens.
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.alexId]);
    expect((await t.fetchAs('alex', 'GET', '/v1/annonces')).status).toBe(403);
  });

  it('le passage tourne toutes les 15 minutes, une seule fois par créneau, et publie dans l’heure qui suit la fin du délai', async () => {
    const t = await setup();
    await t.annonces.validate(t.agent, t.draftId);
    t.setClock(new Date(DELAY_END.getTime() - 10 * MIN));
    expect(await runListingSync(t.db, t.now)).toMatchObject({ ran: true });
    // Deux déclencheurs dans le même quart d'heure n'en font qu'un.
    t.setClock(new Date(DELAY_END.getTime() - 9 * MIN));
    expect(await runListingSync(t.db, t.now)).toMatchObject({ ran: false });
    expect(await t.db.first('SELECT COUNT(*) AS n FROM listing_versions')).toEqual({ n: 0 });
    let published: Date | null = null;
    for (let at = DELAY_END.getTime(); at <= DELAY_END.getTime() + 60 * MIN && !published; at += 15 * MIN) {
      t.setClock(new Date(at));
      await runListingSync(t.db, t.now);
      if (((await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM listing_versions'))!.n as number) > 0) published = new Date(at);
    }
    expect(published).not.toBeNull();
    expect(published!.getTime() - DELAY_END.getTime()).toBeLessThan(60 * MIN);
    const runs = await t.db.all<{ slot: string }>("SELECT slot FROM scheduled_runs WHERE job = 'annonces.publication' ORDER BY slot");
    expect(new Set(runs.map((r) => r.slot)).size).toBe(runs.length);
    expect(quarterSlot(new Date('2027-02-24T23:14:59.000Z'))).toBe('2027-02-24T23:00Z');
    expect(quarterSlot(new Date('2027-02-24T23:15:00.000Z'))).toBe('2027-02-24T23:15Z');
    // L'heure qui revient au changement d'heure d'automne garde ses propres créneaux.
    expect(quarterSlot(new Date('2027-10-31T00:00:00.000Z'))).not.toBe(quarterSlot(new Date('2027-10-31T01:00:00.000Z')));
    // Le Worker n'a qu'un déclencheur, chaque minute ; la publication ne passe qu'aux quarts d'heure (BR65).
    expect(readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8')).toMatch(/^crons = \["\* \* \* \* \*"\]$/m);
  });

  it('[R46] la page publique ne montre qu’une version publiée, sans adresse ni nom du vendeur ; la fiche imprimable aussi ; jamais indexée', async () => {
    const t = await setup();
    // Validée mais pas encore publiée : rien.
    await t.annonces.validate(t.agent, t.draftId);
    expect((await t.fetchAs(null, 'GET', `/biens/${t.propertyId}`)).status).toBe(404);
    t.setClock(new Date(DELAY_END.getTime() + 5 * MIN));
    await runListingSync(t.db, t.now);
    const page = await t.fetchAs(null, 'GET', `/biens/${t.propertyId}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await page.text();
    expect(html).toContain('Dijon');
    expect(html).not.toMatch(/Léa|Exemple|scans\//);
    expect(html).not.toMatch(/<script/);
    const print = await t.fetchAs(null, 'GET', `/biens/${t.propertyId}/fiche`);
    expect(print.status).toBe(200);
    expect((await t.fetchAs(null, 'GET', '/biens/bien-inconnu')).status).toBe(404);
    expect((await t.fetchAs(null, 'POST', `/biens/${t.propertyId}`)).status).toBe(405);
    expect((await verifyChain(await t.journal.all())).ok).toBe(true);
  });

  it('[R46, R48] une photo n’est servie que si la version publiée la porte ; rien sans stockage', async () => {
    const t = await setup();
    const photo = `biens/${t.propertyId}/0b6f1d2e-1111-4a2b-8c3d-000000000001.jpg`;
    const stranger = `biens/${t.propertyId}/0b6f1d2e-9999-4a2b-8c3d-000000000009.jpg`;
    t.stored.set(photo, 'photo-1');
    t.stored.set(stranger, 'photo-cachee');
    expect((await t.fetchAs(null, 'GET', `/medias/${photo}`)).status).toBe(404);
    await t.publish();
    const served = await t.fetchAs(null, 'GET', `/medias/${photo}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/jpeg');
    expect(await served.text()).toBe('photo-1');
    expect((await t.fetchAs(null, 'GET', `/medias/${stranger}`)).status).toBe(404);
    expect((await t.fetchAs(null, 'GET', '/medias/biens/x/../../secret.jpg')).status).toBe(404);
    const without = await handleRequest(new Request(`${BASE}/medias/${photo}`), { db: t.db, apiKeys: undefined, mode: 'essai', now: t.now });
    expect(without.status).toBe(404);
    // Hors mode essai, la vitrine est fermée comme le reste.
    expect((await handleRequest(new Request(`${BASE}/biens/${t.propertyId}`), { db: t.db, apiKeys: undefined, mode: 'reel', now: t.now })).status).toBe(503);
  });

  it('une panne d’un réseau n’empêche pas les autres de publier ; elle va au journal et le créneau est en erreur', async () => {
    const t = await setup();
    await t.annonces.validate(t.agent, t.draftId);
    await t.db.run("INSERT INTO networks (id, name, created_at) VALUES ('0-reseau-en-panne', 'Réseau en panne', '2027-01-01T00:00:00.000Z')");
    const real = annonces.Publication.prototype.syncAll;
    const spy = vi.spyOn(annonces.Publication.prototype, 'syncAll').mockImplementation(async function (this: InstanceType<typeof annonces.Publication>, networkId: string) {
      if (networkId === '0-reseau-en-panne') throw new TypeError('panne');
      return real.call(this, networkId);
    });
    try {
      t.setClock(new Date(DELAY_END.getTime() + 5 * MIN));
      expect(await runListingSync(t.db, t.now)).toMatchObject({ ran: true, properties: 1 });
    } finally {
      spy.mockRestore();
    }
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM listing_versions')).toEqual({ n: 1 });
    expect(await t.db.all("SELECT outcome FROM scheduled_runs WHERE job = 'annonces.publication'")).toEqual([{ outcome: 'error' }]);
    expect((await t.journal.all()).filter((e) => e.type === 'api.erreur' && e.data.route === 'annonces.publication')).toHaveLength(1);
  });
});
