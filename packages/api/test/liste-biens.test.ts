import { expect, it } from 'vitest';
import { FicheClient } from '@aimmo/core';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { runListingSync } from '../src/vitrine.ts';
import { DELAY_END, MIN, setupAnnonce } from '../../core/test/annonces-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// Réseau, agents, bien, sites et clés inventés.
const API = 'https://aimmo-api.example.test';
const NET = 'https://reseau-rs01.example.test';
const ALEX_SITE = 'https://alex-rs01.example.test';
const SAM_SITE = 'https://sam-rs01.example.test';
const OTHER = 'https://autre-rs01.example.test';
const KEYS = { direction: 'test-cle-rs01-dir-cccccccccccccccccccccccccccccc', autre: 'test-cle-rs01-autre-ddddddddddddddddddddddddddd' };

async function setup() {
  const t = await setupAnnonce();
  const other = (await new FicheClient(t.db).createNetwork('Autre réseau')).id;
  const apiKeys = JSON.stringify([
    { sha256: await sha256Hex(KEYS.direction), role: 'direction', userId: 'dir-1', networkId: t.network.id },
    { sha256: await sha256Hex(KEYS.autre), role: 'direction', userId: 'dir-9', networkId: other },
  ]);
  const stored = new Map<string, string>();
  const config: ApiConfig = { db: t.db, apiKeys, mode: 'essai', now: t.now, media: { get: async (key) => (stored.has(key) ? { body: stored.get(key)! } : null) } };
  const site = async (who: keyof typeof KEYS, body: unknown) => {
    const res = await handleRequest(new Request(`${API}/v1/attirer/sites`, { method: 'POST', headers: { authorization: `Bearer ${KEYS[who]}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }), config);
    expect(res.status).toBe(200);
  };
  await site('direction', { kind: 'reseau', baseUrl: NET, active: true });
  await site('direction', { kind: 'agent', agentId: t.alexId, baseUrl: ALEX_SITE, active: true });
  await site('direction', { kind: 'agent', agentId: t.sam.userId, baseUrl: SAM_SITE, active: true });
  await site('autre', { kind: 'reseau', baseUrl: OTHER, active: true });
  const page = (url: string, method = 'GET') => handleRequest(new Request(url, { method }), config);
  const publish = async () => {
    const v = await t.annonces.validate(t.agent, t.draftId);
    if (!v.ok) throw new Error(v.code);
    t.setClock(new Date(DELAY_END.getTime() + 5 * MIN));
    await runListingSync(t.db, t.now);
  };
  /** Une version de plus, sur le modèle de la dernière : une version publiée ne change jamais. */
  const newVersion = async (change: (payload: Record<string, unknown>) => Record<string, unknown>) => {
    const last = (await t.db.first<Record<string, unknown>>('SELECT * FROM listing_versions ORDER BY seq DESC LIMIT 1'))!;
    const row: Record<string, unknown> = { ...last, id: `version-${String(last.seq)}-suite`, seq: Number(last.seq) + 1, payload: JSON.stringify(change(JSON.parse(String(last.payload)) as Record<string, unknown>)) };
    const columns = Object.keys(row);
    await t.db.run(`INSERT INTO listing_versions (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, columns.map((c) => row[c]) as never[]);
  };
  return { ...t, page, publish, stored, newVersion };
}

describeWithSqlite('RS01 · la liste des biens, par le socle', () => {
  it('[R153] [R16] le réseau et l’agent du bien le montrent ; un autre agent, un autre réseau, l’adresse de l’API non', async () => {
    const t = await setup();
    await t.publish();
    const lien = `/biens/${t.propertyId}`;
    for (const host of [NET, ALEX_SITE]) {
      const res = await t.page(`${host}/biens`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(lien);
    }
    const sam = await t.page(`${SAM_SITE}/biens`);
    expect(sam.status).toBe(200);
    const html = await sam.text();
    expect(html).not.toContain(lien);
    expect(html).toContain('Aucun bien en vente en ce moment.');
    expect(await (await t.page(`${OTHER}/biens`)).text()).not.toContain(lien);
    expect((await t.page(`${API}/biens`)).status).toBe(404);
  });

  it('[R220] un mandat échu retire le bien de la liste et sa page, sans aucun passage de publication, sans toucher à la version', async () => {
    const t = await setup();
    await t.publish();
    const lien = `/biens/${t.propertyId}`;
    expect((await t.page(`${NET}${lien}`)).status).toBe(200);
    expect((await t.page(`${NET}${lien}/fiche`)).status).toBe(200);
    const versions = await t.db.all('SELECT * FROM listing_versions');
    t.setClock(new Date('2031-01-01T10:00:00.000Z'));
    const res = await t.page(`${NET}/biens`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain(lien);
    expect(html).toContain('Mandats vérifiés le 1 janvier 2031 à 11 h 00');
    expect((await t.page(`${NET}${lien}`)).status).toBe(404);
    expect((await t.page(`${NET}${lien}/fiche`)).status).toBe(404);
    // Rien n'est écrit ni effacé par une lecture [R17].
    expect(await t.db.all('SELECT * FROM listing_versions')).toEqual(versions);
  });

  it('une page courte en cache, une lecture sans corps pour HEAD, rien d’indexé en essai, seulement GET et HEAD', async () => {
    const t = await setup();
    await t.publish();
    const res = await t.page(`${NET}/biens`);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    const head = await t.page(`${NET}/biens`, 'HEAD');
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect((await t.page(`${NET}/biens`, 'POST')).status).toBe(405);
  });

  it('une page ou une commune inconnue, un paramètre inattendu : 404', async () => {
    const t = await setup();
    await t.publish();
    for (const query of ['page=2', 'commune=nulle-part', 'page=x', 'autre=1']) {
      expect((await t.page(`${NET}/biens?${query}`)).status, query).toBe(404);
    }
  });

  it('[R46] la page ne porte ni l’adresse du bien, ni le vendeur, ni le code postal, ni aucune référence interne', async () => {
    const t = await setup();
    // Une adresse et un vendeur inventés, glissés dans la version publiée : seuls les champs de la carte en sortent.
    const secret = '12 impasse des Tuiles Inventées';
    await t.publish();
    await t.newVersion((payload) => ({ ...payload, address: secret, sellerName: 'Léa Exemple', postalCode: '21000' }));
    const html = await (await t.page(`${NET}/biens`)).text();
    expect(html).toContain('Dijon');
    expect(html).not.toContain(secret);
    expect(html).not.toMatch(/Léa|Exemple|scans\/|21000|REF-T-1/);
  });

  it('[R44] [R48] le prix, les mentions et la mention d’aménagement virtuel viennent de la version publiée, par le vrai passage', async () => {
    const t = await setup();
    await t.publish();
    const version = await t.db.first<{ payload: string }>('SELECT payload FROM listing_versions ORDER BY seq DESC LIMIT 1');
    const payload = JSON.parse(version!.payload) as { priceEur: number; mentions: string; media: { kind: string; ref: string; overlay: string | null }[] };
    const texte = (html: string) => html.replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, '&');
    const before = texte(await (await t.page(`${NET}/biens`)).text());
    expect(before).toContain(`/medias/${payload.media[0]!.ref}`);
    expect(before).toContain(texte(payload.mentions.replace(/'/g, "'")));
    expect(before).toMatch(new RegExp(String(payload.priceEur).replace(/\B(?=(\d{3})+$)/g, '.')));
    expect(before).not.toContain('class="virtuel"');
    // La première photo est celle d'un aménagement virtuel : la vraie mention rangée par la publication est montrée.
    const virtual = payload.media.find((m) => m.overlay)!;
    expect(virtual.overlay).toBeTruthy();
    await t.newVersion(() => ({ ...payload, media: [virtual, ...payload.media.filter((m) => m !== virtual)] }));
    const after = await (await t.page(`${NET}/biens`)).text();
    expect(after).toContain(`<span class="virtuel">${virtual.overlay}</span>`);
    expect(after).toContain(`/medias/${virtual.ref}`);
  });

  it('[R220] vendu dans le socle : la liste, la page et la photo le retirent avant le passage ; le passage fait, sa page « vendu » revient', async () => {
    const t = await setup();
    await t.publish();
    const lien = `/biens/${t.propertyId}`;
    const version = await t.db.first<{ payload: string }>('SELECT payload FROM listing_versions ORDER BY seq DESC LIMIT 1');
    const photo = (JSON.parse(version!.payload) as { media: { ref: string }[] }).media[0]!.ref;
    t.stored.set(photo, 'photo-1');
    const page = await t.page(`${NET}${lien}`);
    expect(page.headers.get('cache-control')).toBe('public, max-age=60');
    const image = await t.page(`${NET}/medias/${photo}`);
    expect(image.status).toBe(200);
    expect(image.headers.get('cache-control')).toBe('public, max-age=60');
    await t.db.run("UPDATE properties SET status = 'sold' WHERE id = ?", [t.propertyId]);
    expect(await (await t.page(`${NET}/biens`)).text()).not.toContain(lien);
    expect((await t.page(`${NET}${lien}`)).status).toBe(404);
    expect((await t.page(`${NET}${lien}/fiche`)).status).toBe(404);
    expect((await t.page(`${NET}/medias/${photo}`)).status).toBe(404);
    t.setClock(new Date(DELAY_END.getTime() + 25 * MIN));
    await runListingSync(t.db, t.now);
    const sold = await t.page(`${NET}${lien}`);
    expect(sold.status).toBe(200);
    expect(sold.headers.get('cache-control')).toBe('public, max-age=300');
    expect(await (await t.page(`${NET}/biens`)).text()).not.toContain(lien);
  });

  it('[R220] un mandat échu retire aussi la photo', async () => {
    const t = await setup();
    await t.publish();
    const version = await t.db.first<{ payload: string }>('SELECT payload FROM listing_versions ORDER BY seq DESC LIMIT 1');
    const photo = (JSON.parse(version!.payload) as { media: { ref: string }[] }).media[0]!.ref;
    t.stored.set(photo, 'photo-1');
    t.setClock(new Date('2031-01-01T10:00:00.000Z'));
    expect((await t.page(`${NET}/medias/${photo}`)).status).toBe(404);
  });
});
