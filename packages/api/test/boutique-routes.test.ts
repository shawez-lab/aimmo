import { expect, it } from 'vitest';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { PageBien } from '../../core/src/annonces/index.ts';
import { Referencement } from '../../core/src/attirer/referencement.ts';
import { euros } from '../../core/src/annonces/mentions.ts';
import { unsourcedFigures, visibleText } from '../../core/src/boutique/supports.ts';
import { setupAnnonce } from '../../core/test/annonces-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// Réseau, agents, biens, sites, tarifs et clés d'API inventés. Le 1er mars 2027, à 9 h à Paris.
const KEYS = {
  alex: 'test-cle-br22-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  sam: 'test-cle-br22-sam-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  direction: 'test-cle-br22-direction-cccccccccccccccccccccc',
  conformite: 'test-cle-br22-conformite-ddddddddddddddddddddd',
};
type Who = keyof typeof KEYS;
const TARIF = { support: 'flyer', quantity: 100, priceCents: 4900, printer: 'essai', source: 'Devis n° D-1 du 2027-02-01', validUntil: '2027-12-31' };

async function setup() {
  const t = await setupAnnonce();
  t.setClock(new Date('2027-02-12T10:00:00.000Z'));
  await t.annonces.validate(t.agent, t.draftId);
  t.setClock(new Date('2027-03-01T08:00:00.000Z'));
  await t.publication.sync(t.network.id, t.propertyId);
  expect(await new PageBien(t.db, t.acces, t.journal, { now: t.now }).setAgentCard(t.agent, t.alexId, { phone: '03 00 00 00 01', email: 'alex@exemple.test' })).toEqual({ ok: true });
  expect((await new Referencement(t.db, t.journal, { now: t.now }).setSite(t.direction, { kind: 'reseau', baseUrl: 'https://reseau.exemple.test', active: true })).ok).toBe(true);
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
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; rule?: string | null; code?: string; mode?: string; field?: string } };
  };
  const refusals = async () => (await t.journal.all()).filter((e) => e.type === 'acces.refuse');
  const count = async (table: string) => Number((await t.db.first<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))!.n);
  return { ...t, config, http, refusals, count };
}

/** Un corps qui ne se lit pas : s'il était lu avant le rôle, la route répondrait 400 au lieu de 403. */
function untouchable(url: string, init: RequestInit): Request {
  const r = new Request(url, init);
  Object.defineProperty(r, 'text', { value: () => Promise.reject(new Error('corps lu avant le contrôle du rôle')) });
  Object.defineProperty(r, 'json', { value: () => Promise.reject(new Error('corps lu avant le contrôle du rôle')) });
  return r;
}

describeWithSqlite('BR22 · routes de la boutique de l’agent', () => {
  it('[R16] chaque route refuse le mauvais rôle en 403, au journal, avant toute lecture du corps', async () => {
    const t = await setup();
    const cases: [Who, string, string][] = [
      ['alex', 'GET', '/boutique/tarifs'],
      ['alex', 'POST', '/boutique/tarifs'],
      ['conformite', 'POST', '/boutique/tarifs'],
      ['direction', 'POST', '/boutique/apercu'],
      ['conformite', 'POST', '/boutique/apercu'],
      ['direction', 'GET', '/boutique/commandes'],
      ['direction', 'POST', '/boutique/commandes'],
      ['conformite', 'POST', '/boutique/commandes'],
      ['direction', 'POST', '/boutique/commandes/commande-0001/validation'],
    ];
    for (const [who, method, path] of cases) {
      const before = (await t.refusals()).length;
      // Corps mal formé, puis corps qui ne doit même pas être lu : 403 les deux fois.
      const r = await t.http(who, method, path, undefined, method === 'POST' ? 'pas du json' : undefined);
      expect(r.status, `${who} ${method} ${path}`).toBe(403);
      expect(r.body).toMatchObject({ ok: false, rule: 'R16' });
      expect((await t.refusals()).length, `${who} ${method} ${path}`).toBeGreaterThan(before);
      if (method === 'POST') {
        const req = untouchable(`https://aimmo-api.example.test/v1${path}`, { method, headers: { authorization: `Bearer ${KEYS[who]}`, 'content-type': 'application/json' }, body: '{}' });
        const res = await handleRequest(req, t.config);
        expect(res.status, `${who} ${method} ${path} (corps)`).toBe(403);
      }
    }
    const boutique = (await t.refusals()).filter((e) => e.data.kind === 'boutique');
    expect(boutique.length).toBeGreaterThanOrEqual(cases.length);
    // Rien n'est rangé.
    expect(await t.count('shop_tariffs')).toBe(0);
    expect(await t.count('shop_orders')).toBe(0);
  });

  it('[R16] [R263] l’agent d’un autre bien ne tire aucun support de ce bien, et le refus va au journal', async () => {
    const t = await setup();
    const before = (await t.refusals()).length;
    const r = await t.http('sam', 'POST', '/boutique/apercu', { support: 'flyer', propertyId: t.propertyId });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ ok: false, rule: 'R16' });
    expect((await t.refusals()).length).toBe(before + 1);
    expect((await t.http('sam', 'POST', '/boutique/commandes', { requestId: 'commande-sam-01', support: 'flyer', propertyId: t.propertyId, quantity: 100 })).status).toBe(403);
    expect((await t.http('alex', 'POST', '/boutique/apercu', { support: 'flyer', propertyId: 'inconnu-1' })).status).toBe(404);
  });

  it('[R263] l’aperçu sort de l’annonce publiée : prix et mentions au caractère près, aucun chiffre inventé, code vers la page du bien', async () => {
    const t = await setup();
    const page = (await new PageBien(t.db, t.acces, t.journal).inputFor(t.network.id, t.propertyId))!;
    const r = await t.http('alex', 'POST', '/boutique/apercu', { support: 'flyer', propertyId: t.propertyId });
    expect(r.status, r.body.code).toBe(200);
    expect(r.body).toMatchObject({ ok: true, mode: 'essai', data: { support: 'flyer', url: `https://reseau.exemple.test/biens/${encodeURIComponent(t.propertyId)}` } });
    const text = visibleText(r.body.data.html);
    expect(text).toContain(euros(page.payload.priceEur!));
    expect(text).toContain(page.payload.mentions!);
    expect(r.body.data.keyword).toBe(`RÉF ${page.payload.reference}`);
    expect(unsourcedFigures(text, [page.payload.title!, page.payload.mentions!, euros(page.payload.priceEur!), page.payload.reference, '03 00 00 00 01', 'alex@exemple.test', 'Alex Agent', r.body.data.url])).toEqual([]);
    // Le panneau ne porte aucun prix.
    const panneau = await t.http('alex', 'POST', '/boutique/apercu', { support: 'panneau', propertyId: t.propertyId });
    expect(visibleText(panneau.body.data.html)).not.toContain(euros(page.payload.priceEur!));
    // Un prix envoyé par l'appelant n'est pas un champ prévu : rien n'est tiré d'une saisie.
    expect(await t.http('alex', 'POST', '/boutique/apercu', { support: 'flyer', propertyId: t.propertyId, priceEur: 1 })).toMatchObject({ status: 400, body: { code: 'unknown_field', field: 'priceEur' } });
  });

  it('[R263] sans page publiée ou pour un bien vendu, aucun support : 409 avec la règle', async () => {
    const t = await setup();
    await new Referencement(t.db, t.journal, { now: t.now }).setSite(t.direction, { kind: 'reseau', baseUrl: 'https://reseau.exemple.test', active: false });
    expect(await t.http('alex', 'POST', '/boutique/apercu', { support: 'flyer', propertyId: t.propertyId })).toMatchObject({ status: 409, body: { rule: 'R263', code: 'pas_de_page' } });
    await new Referencement(t.db, t.journal, { now: t.now }).setSite(t.direction, { kind: 'reseau', baseUrl: 'https://reseau.exemple.test', active: true });
    await t.db.run("UPDATE properties SET status = 'sold' WHERE id = ?", [t.propertyId]);
    await t.publication.sync(t.network.id, t.propertyId);
    const sold = await t.http('alex', 'POST', '/boutique/apercu', { support: 'flyer', propertyId: t.propertyId });
    expect(sold.status).toBe(409);
    expect(sold.body.rule).toBe('R263');
  });

  it('[R264] la direction règle un tarif et le lit ; le prix de la commande vient du tarif, jamais d’une saisie', async () => {
    const t = await setup();
    const prep = (requestId: string, extra: Record<string, unknown> = {}) => t.http('alex', 'POST', '/boutique/commandes', { requestId, support: 'flyer', propertyId: t.propertyId, quantity: 100, ...extra });
    expect(await prep('commande-0001')).toMatchObject({ status: 409, body: { rule: 'R264', code: 'pas_de_tarif' } });
    expect(await t.http('direction', 'POST', '/boutique/tarifs', { ...TARIF, priceCents: 0 })).toMatchObject({ status: 400, body: { code: 'bad_price' } });
    expect(await t.http('direction', 'POST', '/boutique/tarifs', { ...TARIF, note: 'x' })).toMatchObject({ status: 400, body: { code: 'unknown_field' } });
    const set = await t.http('direction', 'POST', '/boutique/tarifs', TARIF);
    expect(set.status, set.body.code).toBe(200);
    const list = await t.http('direction', 'GET', '/boutique/tarifs');
    expect(list.body.data).toMatchObject([{ id: set.body.data.tariffId, support: 'flyer', quantity: 100, priceCents: 4900, printer: 'essai', inForce: true }]);
    // Un nouveau tarif remplace l'ancien : seul le dernier est lu, et c'est lui qui fait foi.
    const later = await t.http('direction', 'POST', '/boutique/tarifs', { ...TARIF, priceCents: 5200, source: 'Devis n° D-2 du 2027-02-20' });
    const latest = (await t.http('direction', 'GET', '/boutique/tarifs')).body.data;
    expect(latest).toMatchObject([{ id: later.body.data.tariffId, priceCents: 5200 }]);
    expect(latest).toHaveLength(1);
    await t.http('direction', 'POST', '/boutique/tarifs', TARIF);
    // Un prix envoyé par l'agent : refusé, jamais pris.
    expect(await prep('commande-0002', { priceCents: 1 })).toMatchObject({ status: 400, body: { code: 'unknown_field', field: 'priceCents' } });
    const ok = await prep('commande-0003');
    expect(ok).toMatchObject({ status: 200, body: { ok: true, data: { orderId: 'commande-0003', priceCents: 4900 } } });
    // Un tarif chez un autre imprimeur : la commande ne part qu'à l'imprimeur d'essai, donc aucune.
    await t.http('direction', 'POST', '/boutique/tarifs', { ...TARIF, quantity: 250, printer: 'Imprimerie réelle' });
    expect(await prep('commande-0004', { quantity: 250 })).toMatchObject({ status: 409, body: { rule: 'R264', code: 'imprimeur_different' } });
  });

  it('[R265] préparer ne commande rien ; seule la validation de l’agent commande, une fois', async () => {
    const t = await setup();
    await t.http('direction', 'POST', '/boutique/tarifs', TARIF);
    const body = { requestId: 'commande-0010', support: 'flyer', propertyId: t.propertyId, quantity: 100 };
    const prepared = await t.http('alex', 'POST', '/boutique/commandes', body);
    expect(prepared.status, prepared.body.code).toBe(200);
    expect(await t.count('shop_order_sends')).toBe(0);
    expect(await t.count('shop_order_validations')).toBe(0);
    expect((await t.http('alex', 'GET', '/boutique/commandes')).body.data).toMatchObject([{ id: 'commande-0010', status: 'preparee', priceCents: 4900 }]);
    // Rejouée, la même demande rend la même commande ; une autre quantité sous la même clé est refusée.
    expect((await t.http('alex', 'POST', '/boutique/commandes', body)).body.data.orderId).toBe('commande-0010');
    expect(await t.http('alex', 'POST', '/boutique/commandes', { ...body, quantity: 250 })).toMatchObject({ status: 409, body: { rule: 'R265', code: 'demande_differente' } });
    expect(await t.count('shop_orders')).toBe(1);
    // Un autre agent ne valide pas la commande d'Alex.
    expect(await t.http('sam', 'POST', '/boutique/commandes/commande-0010/validation')).toMatchObject({ status: 403, body: { rule: 'R16' } });
    expect(await t.count('shop_order_sends')).toBe(0);
    const v = await t.http('alex', 'POST', '/boutique/commandes/commande-0010/validation');
    expect(v).toMatchObject({ status: 200, body: { ok: true, mode: 'essai', data: { printerRef: 'essai-commande-0010' } } });
    const again = await Promise.all([t.http('alex', 'POST', '/boutique/commandes/commande-0010/validation'), t.http('alex', 'POST', '/boutique/commandes/commande-0010/validation')]);
    for (const r of again) expect(r).toMatchObject({ status: 409, body: { rule: 'R265', code: 'deja_validee' } });
    expect(await t.count('shop_order_sends')).toBe(1);
    expect((await t.http('alex', 'GET', '/boutique/commandes')).body.data).toMatchObject([{ id: 'commande-0010', status: 'envoyee' }]);
    expect(await t.http('alex', 'POST', '/boutique/commandes/inconnue-01/validation')).toMatchObject({ status: 404 });
  });

  it('[R264] une commande dont le support a changé depuis sa préparation est périmée : rien ne part', async () => {
    const t = await setup();
    await t.http('direction', 'POST', '/boutique/tarifs', TARIF);
    await t.http('alex', 'POST', '/boutique/commandes', { requestId: 'commande-0020', support: 'flyer', propertyId: t.propertyId, quantity: 100 });
    await t.amend(190000);
    await t.publication.sync(t.network.id, t.propertyId);
    expect(await t.http('alex', 'POST', '/boutique/commandes/commande-0020/validation')).toMatchObject({ status: 409, body: { rule: 'R264', code: 'support_perime' } });
    expect(await t.count('shop_order_sends')).toBe(0);
  });

  it('un corps absent, pas en JSON ou trop gros est refusé en 400 au bon rôle', async () => {
    const t = await setup();
    for (const [who, path] of [['direction', '/boutique/tarifs'], ['alex', '/boutique/apercu'], ['alex', '/boutique/commandes']] as [Who, string][]) {
      expect((await t.http(who, 'POST', path, undefined, 'pas du json')).body.code, path).toBe('invalid_body');
      expect((await t.http(who, 'POST', path, undefined, '[1]')).status, path).toBe(400);
      expect((await t.http(who, 'POST', path, undefined, JSON.stringify({ support: 'x'.repeat(5_000) }))).status, path).toBe(400);
    }
  });
});
