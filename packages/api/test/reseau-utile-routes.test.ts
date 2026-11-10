import { expect, it } from 'vitest';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { setupAnnonce } from '../../core/test/annonces-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// Réseau, agents, fournisseurs, remises, actualités et clés inventés. Le 12 février 2027 à Paris : le mandat du bien
// d'Alex est inscrit au registre, l'annonce pas encore en vente.
const NOW = new Date('2027-02-12T10:00:00.000Z');
const KEYS = {
  alex: 'test-cle-br20-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  sam: 'test-cle-br20-sam-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  direction: 'test-cle-br20-direction-cccccccccccccccccccccc',
  conformite: 'test-cle-br20-conformite-ddddddddddddddddddddd',
};
type Who = keyof typeof KEYS;
const REMISE = {
  category: 'home_staging',
  supplier: 'Mise en scène Exemple',
  beneficiary: 'agent',
  title: '15 % sur la mise en valeur',
  terms: 'Sur présentation de la carte du réseau.',
  source: 'Contrat n° C-7 du 2027-01-05',
  moment: 'mandat',
  validFrom: '2027-01-01',
  validUntil: '2027-06-30',
};
let k = 0;
const actualite = () => ({
  topic: 'juridique',
  title: 'Nouvelle règle de test',
  impact: 'Prévenez vos vendeurs concernés avant la mise en vente.',
  sourceName: 'Journal officiel de test',
  sourceUrl: `https://exemple.test/textes/br20-${++k}`,
  sourceDate: '2027-02-01',
});

async function setup() {
  const t = await setupAnnonce();
  t.setClock(NOW);
  const ids: Record<Who, { role: string; userId: string }> = {
    alex: { role: 'agent', userId: t.alexId },
    sam: { role: 'agent', userId: t.sam.userId },
    direction: { role: 'direction', userId: t.direction.userId },
    conformite: { role: 'compliance', userId: 'conformite-1' },
  };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: t.network.id, ...ids[w] }))));
  const config: ApiConfig = { db: t.db, apiKeys, mode: 'essai', now: t.now };
  const http = async (who: Who, method: string, path: string, body?: unknown, raw?: string) => {
    const headers: Record<string, string> = { authorization: `Bearer ${KEYS[who]}` };
    if (body !== undefined || raw !== undefined) headers['content-type'] = 'application/json';
    const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const r = await handleRequest(new Request(`https://aimmo-api.example.test/v1${path}`, { method, headers, ...(payload === undefined ? {} : { body: payload }) }), config);
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; rule?: string; code?: string; mode?: string; discountId?: string; newsId?: string } };
  };
  const refusals = async () => (await t.journal.all()).filter((e) => e.type === 'acces.refuse');
  return { ...t, http, refusals };
}

describeWithSqlite('BR20 · routes des remises et des actualités', () => {
  it('[R16] chaque route refuse le mauvais rôle, en 403, avec le refus au journal', async () => {
    const t = await setup();
    const remise = await t.http('direction', 'POST', '/remises', REMISE);
    expect(remise.status).toBe(200);
    const discountId = remise.body.discountId!;
    const news = await t.http('direction', 'POST', '/actualites', actualite());
    expect(news.status).toBe(200);
    const newsId = news.body.newsId!;
    const cases: [Who, string, string, unknown?][] = [
      ['conformite', 'GET', '/remises'],
      ['alex', 'POST', '/remises', REMISE],
      ['alex', 'POST', `/remises/${discountId}/retrait`, { reason: 'Contrat fini.' }],
      ['direction', 'GET', `/remises/biens/${t.propertyId}`],
      // L'agent d'un autre bien ne lit pas ses remises, et n'en écarte aucune.
      ['sam', 'GET', `/remises/biens/${t.propertyId}`],
      ['sam', 'POST', `/remises/${discountId}/biens/${t.propertyId}/ecarter`],
      ['direction', 'GET', '/actualites'],
      ['alex', 'GET', '/actualites/catalogue'],
      ['alex', 'POST', '/actualites', actualite()],
      ['sam', 'POST', `/actualites/${newsId}/retrait`, { reason: 'Source retirée.' }],
    ];
    // Le mauvais rôle est refusé au journal avant toute lecture du corps, même absent ou mal formé.
    for (const path of ['/remises', `/remises/${discountId}/retrait`, '/actualites', `/actualites/${newsId}/retrait`]) {
      const before = (await t.refusals()).length;
      for (const raw of [undefined, 'pas du json', 'x'.repeat(9_000)]) {
        const r = await t.http('alex', 'POST', path, undefined, raw);
        expect(r.status, `alex POST ${path}`).toBe(403);
        expect(r.body).toMatchObject({ ok: false, rule: 'R16' });
      }
      expect((await t.refusals()).length - before, path).toBe(3);
    }
    for (const [who, method, path, body] of cases) {
      const before = (await t.refusals()).length;
      const r = await t.http(who, method, path, body);
      expect(r.status, `${who} ${method} ${path}`).toBe(403);
      expect(r.body).toMatchObject({ ok: false, rule: 'R16' });
      expect((await t.refusals()).length, `${who} ${method} ${path}`).toBeGreaterThan(before);
    }
  });

  it('[R266] une remise sans source ni date de fin est refusée ; échue, elle quitte le catalogue le lendemain', async () => {
    const t = await setup();
    const noSource = await t.http('direction', 'POST', '/remises', { ...REMISE, source: ' ' });
    expect(noSource.status).toBe(409);
    expect(noSource.body).toMatchObject({ ok: false, rule: 'R266', code: 'sans_source' });
    const noEnd = await t.http('direction', 'POST', '/remises', { ...REMISE, validUntil: undefined });
    expect(noEnd.status).toBe(409);
    expect(noEnd.body).toMatchObject({ ok: false, rule: 'R266' });
    const today = await t.http('direction', 'POST', '/remises', { ...REMISE, supplier: 'Fin du jour Exemple', validUntil: '2027-02-12' });
    expect(today.status).toBe(200);
    const id = today.body.discountId!;
    const seen = await t.http('alex', 'GET', '/remises');
    expect(seen).toMatchObject({ status: 200, body: { ok: true, mode: 'essai' } });
    expect(seen.body.data.map((d: { id: string }) => d.id)).toContain(id);
    // Le lendemain à Paris, personne n'a rien fait : elle n'est plus là.
    t.setClock(new Date('2027-02-12T23:30:00.000Z'));
    const next = await t.http('alex', 'GET', '/remises');
    expect(next.body.data.map((d: { id: string }) => d.id)).not.toContain(id);
  });

  it('[R267] la remise du bon moment arrive à l’agent du bien ; écartée, elle n’y revient plus ; un retrait la fait disparaître', async () => {
    const t = await setup();
    const id = (await t.http('direction', 'POST', '/remises', REMISE)).body.discountId!;
    const later = (await t.http('direction', 'POST', '/remises', { ...REMISE, supplier: 'Plus tard Exemple', moment: 'compromis' })).body.discountId!;
    const r = await t.http('alex', 'GET', `/remises/biens/${t.propertyId}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ propertyId: t.propertyId, moment: 'mandat' });
    const offered = r.body.data.forAgent.map((d: { id: string }) => d.id);
    expect(offered).toContain(id);
    expect(offered).not.toContain(later);
    expect(r.body.data.forAgent.find((d: { id: string }) => d.id === id).why).toMatch(/Mandat inscrit/);
    expect((await t.http('alex', 'POST', `/remises/${id}/biens/${t.propertyId}/ecarter`)).status).toBe(200);
    const after = await t.http('alex', 'GET', `/remises/biens/${t.propertyId}`);
    expect(after.body.data.forAgent.map((d: { id: string }) => d.id)).not.toContain(id);
    expect((await t.http('alex', 'GET', '/remises/biens/inconnu-1')).status).toBe(404);
    expect((await t.http('alex', 'POST', `/remises/inconnue-1/biens/${t.propertyId}/ecarter`)).status).toBe(404);
    // Retrait par la direction : plus au catalogue, et le même retrait ne se refait pas.
    expect((await t.http('direction', 'POST', `/remises/${later}/retrait`, { reason: 'Contrat fini.' })).status).toBe(200);
    expect((await t.http('alex', 'GET', '/remises')).body.data.map((d: { id: string }) => d.id)).not.toContain(later);
  });

  it('[R268] [R269] une actualité sans adresse https est refusée ; dans le fil, elle n’est montrée qu’une fois', async () => {
    const t = await setup();
    const http = await t.http('direction', 'POST', '/actualites', { ...actualite(), sourceUrl: 'http://exemple.test/textes/1' });
    expect(http.status).toBe(409);
    expect(http.body).toMatchObject({ ok: false, rule: 'R268' });
    const body = actualite();
    const ok = await t.http('direction', 'POST', '/actualites', body);
    expect(ok.status).toBe(200);
    const id = ok.body.newsId!;
    // La même source, suivi en plus, n'est rangée qu'une fois.
    const twice = await t.http('direction', 'POST', '/actualites', { ...body, sourceUrl: `${body.sourceUrl}?utm_source=lettre` });
    expect(twice.status).toBe(409);
    expect(twice.body).toMatchObject({ ok: false, rule: 'R269' });
    const first = await t.http('alex', 'GET', '/actualites');
    expect(first.status).toBe(200);
    const item = first.body.data.find((n: { id: string }) => n.id === id);
    expect(item).toMatchObject({ impact: body.impact, source: { name: body.sourceName, url: body.sourceUrl, date: body.sourceDate } });
    const second = await t.http('alex', 'GET', '/actualites');
    expect(second.body.data.map((n: { id: string }) => n.id)).not.toContain(id);
    // La direction la voit au catalogue, la retire ; un second retrait est refusé.
    const cat = await t.http('direction', 'GET', '/actualites/catalogue');
    expect(cat.body.data.find((n: { id: string }) => n.id === id)).toMatchObject({ withdrawn: false });
    expect((await t.http('direction', 'POST', `/actualites/${id}/retrait`, { reason: 'Source retirée.' })).status).toBe(200);
    expect((await t.http('direction', 'POST', `/actualites/${id}/retrait`, { reason: 'Source retirée.' })).status).toBe(400);
    expect((await t.http('direction', 'POST', '/actualites/inconnue-1/retrait', { reason: 'x x x' })).status).toBe(404);
  });

  it('un corps absent, pas en JSON ou trop gros est refusé en 400, sans rien ranger', async () => {
    const t = await setup();
    const bad = [
      await t.http('direction', 'POST', '/remises', undefined, 'pas du json'),
      await t.http('direction', 'POST', '/remises', undefined, '[1,2]'),
      await t.http('direction', 'POST', '/actualites', { ...actualite(), impact: 'x'.repeat(9_000) }),
      await t.http('direction', 'POST', '/actualites/abc/retrait'),
    ];
    for (const r of bad) expect(r).toMatchObject({ status: 400, body: { ok: false, code: 'invalid_body' } });
    expect((await t.http('direction', 'GET', '/remises')).body.data).toEqual([]);
    expect((await t.http('direction', 'GET', '/actualites/catalogue')).body.data).toEqual([]);
  });
});
