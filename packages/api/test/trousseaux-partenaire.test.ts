import { expect, it } from 'vitest';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { setupAnnonce } from '../../core/test/annonces-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// Réseau, agents, bien, partenaires, trousseaux et clés d'API inventés. Le 12 février 2027, à 11 h à Paris.
const NOW = new Date('2027-02-12T10:00:00.000Z');
const IN_2H = new Date(NOW.getTime() + 2 * 3_600_000).toISOString();
const KEYS = {
  alex: 'test-cle-br46-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  sam: 'test-cle-br46-sam-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  direction: 'test-cle-br46-direction-cccccccccccccccccccccc',
  conformite: 'test-cle-br46-conformite-ddddddddddddddddddddd',
};
type Who = keyof typeof KEYS;

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
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; rule?: string; code?: string; loanId?: string; dueAt?: string; responsibleAgentId?: string } };
  };
  const refusals = async () => (await t.journal.all()).filter((e) => e.type === 'acces.refuse');
  const register = async (label = 'Porte d’entrée et cave') => {
    const r = await http('alex', 'POST', `/trousseaux/biens/${t.propertyId}`, { label });
    expect(r.status, r.body.code).toBe(200);
    return (r.body as unknown as { keyId: string }).keyId;
  };
  let n = 0;
  /** Un partenaire de l'annuaire, avec son assurance valide. */
  const partner = async (trade: string, businessName: string, credentials = true) => {
    n += 1;
    const id = `br46-p${n}`;
    await t.db.run('INSERT INTO partners (id, network_id, trade, business_name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, t.network.id, trade, businessName, 'direction:d1', '2026-12-01T09:00:00.000Z']);
    if (credentials)
      await t.db.run(
        "INSERT INTO partner_credentials (id, network_id, partner_id, kind, domain, version, number, valid_from, valid_until, proof_ref, verified_by, recorded_at) VALUES (?, ?, ?, 'assurance_rcp', '', 1, 'N-1', '2026-01-01', '2027-12-31', ?, 'direction:d1', '2026-12-01T09:00:00.000Z')",
        [`${id}-rcp`, t.network.id, id, `ref-${id}`],
      );
    return id;
  };
  return { ...t, http, refusals, register, partner };
}

describeWithSqlite('BR46 · la remise d’un trousseau à un partenaire, par la route', () => {
  it('[R665] [R271] [R272] l’agent du bien remet à un photographe : chez lui, plus rien ne sort, l’agent le voit à rendre, puis le note rendu', async () => {
    const t = await setup();
    const keyId = await t.register();
    const photo = await t.partner('photographe', 'Studio Lumière');
    const r = await t.http('alex', 'POST', `/trousseaux/${keyId}/remise-partenaire`, { partnerId: photo, purpose: 'photos', dueAt: IN_2H });
    expect(r.status, r.body.code).toBe(200);
    expect(r.body).toMatchObject({ ok: true, dueAt: IN_2H, responsibleAgentId: t.alexId });
    // Jamais chez deux personnes : ni une sortie à un agent, ni une seconde remise [R271].
    expect((await t.http('direction', 'POST', `/trousseaux/${keyId}/sortie`, { holderAgentId: t.sam.userId, purpose: 'photos', dueAt: IN_2H })).body).toMatchObject({ rule: 'R271', code: 'deja_sorti' });
    const again = await t.http('direction', 'POST', `/trousseaux/${keyId}/remise-partenaire`, { partnerId: photo, purpose: 'photos', dueAt: IN_2H });
    expect(again).toMatchObject({ status: 409, body: { rule: 'R271', code: 'deja_sorti' } });
    // L'agent qui a remis le voit à rendre [R272].
    const due = await t.http('alex', 'GET', '/trousseaux/a-rendre');
    expect(due.body.data).toMatchObject([{ keyId, dueAt: IN_2H, overdue: false }]);
    expect((await t.http('sam', 'GET', '/trousseaux/a-rendre')).body.data).toEqual([]);
    // Sam n'en répond pas : il ne note pas le retour [R16].
    expect((await t.http('sam', 'POST', `/trousseaux/${keyId}/rendu`)).status).toBe(403);
    expect((await t.http('alex', 'POST', `/trousseaux/${keyId}/rendu`)).status).toBe(200);
    expect((await t.http('alex', 'GET', '/trousseaux/a-rendre')).body.data).toEqual([]);
    expect((await t.http('alex', 'GET', `/trousseaux/biens/${t.propertyId}`)).body.data).toMatchObject([{ id: keyId, state: 'armoire' }]);
    const journal = await t.journal.all();
    expect(journal.some((e) => e.type === 'cle.remise_partenaire' && e.subject === `key:${keyId}`)).toBe(true);
    expect(JSON.stringify(journal.filter((e) => e.type.startsWith('cle.')))).not.toContain('Studio Lumière');
  });

  it('[R665] métier hors liste, sans justificatif, raison de visite, plus de 12 heures, partenaire inconnu : refusés, rien ne sort', async () => {
    const t = await setup();
    const keyId = await t.register();
    const notaire = await t.partner('notaire', 'Étude des Ducs');
    const sansPiece = await t.partner('artisan', 'Menuiserie Sans Pièce', false);
    const ok = await t.partner('artisan', 'Menuiserie du Lac');
    const send = (body: unknown) => t.http('alex', 'POST', `/trousseaux/${keyId}/remise-partenaire`, body);
    expect(await send({ partnerId: notaire, purpose: 'travaux', dueAt: IN_2H })).toMatchObject({ status: 409, body: { rule: 'R665', code: 'metier_non_admis' } });
    expect(await send({ partnerId: sansPiece, purpose: 'travaux', dueAt: IN_2H })).toMatchObject({ status: 409, body: { rule: 'R665', code: 'justificatif_non_valable' } });
    expect(await send({ partnerId: ok, purpose: 'visite', dueAt: IN_2H })).toMatchObject({ status: 409, body: { rule: 'R665', code: 'bad_purpose' } });
    expect(await send({ partnerId: ok, purpose: 'travaux', dueAt: new Date(NOW.getTime() + 13 * 3_600_000).toISOString() })).toMatchObject({ status: 409, body: { rule: 'R665', code: 'bad_due' } });
    expect(await send({ partnerId: 'inconnu-1', purpose: 'travaux', dueAt: IN_2H })).toMatchObject({ status: 404, body: { rule: 'R665', code: 'unknown_partner' } });
    expect(await send({ partnerId: ok, purpose: 'travaux', dueAt: IN_2H, note: 'x' })).toMatchObject({ status: 400, body: { code: 'champ_inconnu' } });
    expect(await t.http('alex', 'POST', `/trousseaux/${keyId}/remise-partenaire`, undefined, 'pas du json')).toMatchObject({ status: 400, body: { code: 'invalid_body' } });
    expect((await t.http('alex', 'GET', `/trousseaux/biens/${t.propertyId}`)).body.data).toMatchObject([{ id: keyId, state: 'armoire' }]);
  });

  it('[R16] un autre agent ou la conformité sont refusés en 403, au journal, même avec un champ en trop ou un corps mal formé ; un trousseau inconnu en 404', async () => {
    const t = await setup();
    const keyId = await t.register();
    const photo = await t.partner('photographe', 'Studio Lumière');
    const body = { partnerId: photo, purpose: 'photos', dueAt: IN_2H };
    const cases: [Who, unknown, string?][] = [
      ['sam', body],
      ['sam', { ...body, note: 'x' }],
      ['sam', undefined, 'pas du json'],
      ['conformite', body],
      ['conformite', { ...body, note: 'x' }],
      ['conformite', undefined, 'pas du json'],
    ];
    for (const [who, b, raw] of cases) {
      const before = (await t.refusals()).length;
      const r = await t.http(who, 'POST', `/trousseaux/${keyId}/remise-partenaire`, b, raw);
      expect(r.status, who).toBe(403);
      expect(r.body).toMatchObject({ ok: false, rule: 'R16' });
      expect((await t.refusals()).length).toBeGreaterThan(before);
    }
    expect((await t.http('alex', 'POST', '/trousseaux/inconnu-1/remise-partenaire', body)).status).toBe(404);
    // La direction remet aussi : l'agent du bien en répond.
    const d = await t.http('direction', 'POST', `/trousseaux/${keyId}/remise-partenaire`, body);
    expect(d).toMatchObject({ status: 200, body: { responsibleAgentId: t.alexId } });
  });
});
