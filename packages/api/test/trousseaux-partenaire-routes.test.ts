import { expect, it } from 'vitest';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { setupAnnonce } from '../../core/test/annonces-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// RC17 · La route de la remise d'une clé à un partenaire de l'annuaire. Réseaux, agents, partenaires, biens et clés
// d'API inventés. Le 12 février 2027, à 11 h à Paris.
const NOW = new Date('2027-02-12T10:00:00.000Z');
const HOUR = 3_600_000;
const IN_3H = new Date(NOW.getTime() + 3 * HOUR).toISOString();
const KEYS = {
  alex: 'test-cle-rc17-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  sam: 'test-cle-rc17-sam-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  direction: 'test-cle-rc17-direction-cccccccccccccccccccccc',
  conformite: 'test-cle-rc17-conformite-ddddddddddddddddddddd',
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
    return {
      status: r.status,
      body: (await r.json()) as { ok: boolean; data?: any; rule?: string; code?: string; mode?: string; keyId?: string; loanId?: string; dueAt?: string; responsibleAgentId?: string },
    };
  };
  const refusals = async () => (await t.journal.all()).filter((e) => e.type === 'acces.refuse');
  const register = async (label = 'Porte d’entrée et cave') => {
    const r = await http('alex', 'POST', `/trousseaux/biens/${t.propertyId}`, { label });
    expect(r.status, r.body.code).toBe(200);
    return r.body.keyId!;
  };
  let n = 0;
  /** Un partenaire de l'annuaire, avec ses justificatifs exigés valides jusqu'au `until`. */
  const partner = async (trade: string, businessName: string, opts: { networkId?: string; until?: string } = {}) => {
    n += 1;
    const id = `rc17-p${n}`;
    const net = opts.networkId ?? t.network.id;
    const at = new Date(NOW.getTime() - 60 * 24 * HOUR).toISOString();
    await t.db.run('INSERT INTO partners (id, network_id, trade, business_name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, net, trade, businessName, 'direction:d1', at]);
    const kinds = trade === 'geometre' ? ['assurance_rcp', 'inscription_ordre'] : ['assurance_rcp'];
    for (const kind of kinds)
      await t.db.run(
        "INSERT INTO partner_credentials (id, network_id, partner_id, kind, domain, version, number, valid_from, valid_until, proof_ref, verified_by, recorded_at) VALUES (?, ?, ?, ?, '', 1, 'N-1', '2026-01-01', ?, ?, 'direction:d1', ?)",
        [`${id}-${kind}`, net, id, kind, opts.until ?? '2027-12-31', `ref-${id}-${kind}`, at],
      );
    return id;
  };
  return { ...t, http, refusals, register, partner };
}

describeWithSqlite('RC17 · route de la remise d’une clé à un partenaire', () => {
  it('[R665] [R272] remis à un diagnostiqueur, l’agent qui remet le voit à rendre ; rendu à l’armoire, il ressort', async () => {
    const t = await setup();
    const keyId = await t.register();
    const diag = await t.partner('diagnostiqueur', 'Diag Bourgogne SARL');
    const r = await t.http('alex', 'POST', `/trousseaux/${keyId}/partenaire`, { partnerId: diag, purpose: 'diagnostic', dueAt: IN_3H });
    expect(r.status, r.body.code).toBe(200);
    expect(r.body).toMatchObject({ ok: true, mode: 'essai', dueAt: IN_3H, responsibleAgentId: t.alexId });
    expect(typeof r.body.loanId).toBe('string');
    const due = await t.http('alex', 'GET', '/trousseaux/a-rendre');
    expect(due.status).toBe(200);
    expect(due.body.data).toMatchObject([{ keyId, propertyId: t.propertyId, dueAt: IN_3H, overdue: false }]);
    // Au journal, le partenaire par son identifiant seul : jamais sa raison sociale [R13].
    const events = (await t.journal.all()).filter((e) => e.type === 'cle.remise_partenaire');
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).not.toContain('Diag Bourgogne');
    expect((await t.http('alex', 'POST', `/trousseaux/${keyId}/rendu`)).status).toBe(200);
    expect((await t.http('alex', 'GET', '/trousseaux/a-rendre')).body.data).toEqual([]);
    expect((await t.http('alex', 'POST', `/trousseaux/${keyId}/sortie`, { holderAgentId: t.sam.userId, purpose: 'photos', dueAt: IN_3H })).status).toBe(200);
  });

  it('[R665] la direction remet : l’agent du bien en répond, c’est lui qui le voit à rendre', async () => {
    const t = await setup();
    const keyId = await t.register();
    const photo = await t.partner('photographe', 'Studio Lumière');
    const r = await t.http('direction', 'POST', `/trousseaux/${keyId}/partenaire`, { partnerId: photo, purpose: 'photos', dueAt: IN_3H });
    expect(r.status, r.body.code).toBe(200);
    expect(r.body.responsibleAgentId).toBe(t.alexId);
    expect((await t.http('alex', 'GET', '/trousseaux/a-rendre')).body.data).toMatchObject([{ keyId }]);
  });

  it('[R271] chez un partenaire, il ne sort ni vers un agent ni vers un autre partenaire ; sorti vers un agent, il ne va pas chez un partenaire', async () => {
    const t = await setup();
    const keyId = await t.register();
    const diag = await t.partner('diagnostiqueur', 'Diag Bourgogne SARL');
    const artisan = await t.partner('artisan', 'Menuiserie du Lac');
    expect((await t.http('alex', 'POST', `/trousseaux/${keyId}/partenaire`, { partnerId: diag, purpose: 'diagnostic', dueAt: IN_3H })).status).toBe(200);
    const toPartner = await t.http('direction', 'POST', `/trousseaux/${keyId}/partenaire`, { partnerId: artisan, purpose: 'travaux', dueAt: IN_3H });
    expect(toPartner).toMatchObject({ status: 409, body: { ok: false, rule: 'R271', code: 'deja_sorti' } });
    const toAgent = await t.http('alex', 'POST', `/trousseaux/${keyId}/sortie`, { holderAgentId: t.sam.userId, purpose: 'photos', dueAt: IN_3H });
    expect(toAgent).toMatchObject({ status: 409, body: { ok: false, rule: 'R271', code: 'deja_sorti' } });
    const other = await t.register('Garage');
    expect((await t.http('alex', 'POST', `/trousseaux/${other}/sortie`, { holderAgentId: t.sam.userId, purpose: 'photos', dueAt: IN_3H })).status).toBe(200);
    expect((await t.http('alex', 'POST', `/trousseaux/${other}/partenaire`, { partnerId: artisan, purpose: 'travaux', dueAt: IN_3H })).body).toMatchObject({ rule: 'R271', code: 'deja_sorti' });
  });

  it('[R665] métier non admis, justificatif échu, raison ou heure hors liste : 409 ; partenaire inconnu ou d’un autre réseau : 404 ; rien ne sort', async () => {
    const t = await setup();
    const keyId = await t.register();
    const ok = await t.partner('diagnostiqueur', 'Diag Bourgogne SARL');
    const notaire = await t.partner('notaire', 'Étude des Ducs');
    const echu = await t.partner('photographe', 'Photo Passée', { until: '2027-01-31' });
    const elsewhere = await t.store.createNetwork('Autre réseau');
    const ailleurs = await t.partner('diagnostiqueur', 'Diag Ailleurs', { networkId: elsewhere.id });
    const cases: [unknown, string][] = [
      [{ partnerId: notaire, purpose: 'travaux', dueAt: IN_3H }, 'metier_non_admis'],
      [{ partnerId: echu, purpose: 'photos', dueAt: IN_3H }, 'justificatif_non_valable'],
      [{ partnerId: ailleurs, purpose: 'diagnostic', dueAt: IN_3H }, 'unknown_partner'],
      [{ partnerId: 'inconnu-1', purpose: 'diagnostic', dueAt: IN_3H }, 'unknown_partner'],
      [{ purpose: 'diagnostic', dueAt: IN_3H }, 'unknown_partner'],
      [{ partnerId: ok, purpose: 'visite', dueAt: IN_3H }, 'bad_purpose'],
      [{ partnerId: ok, purpose: 'diagnostic', dueAt: new Date(NOW.getTime() + 13 * HOUR).toISOString() }, 'bad_due'],
      [{ partnerId: ok, purpose: 'diagnostic', dueAt: new Date(NOW.getTime() - HOUR).toISOString() }, 'bad_due'],
      [{ partnerId: ok, purpose: 'diagnostic' }, 'bad_due'],
    ];
    // Un partenaire inconnu ici, d'un autre réseau compris, est un inconnu : 404, comme un trousseau inconnu.
    for (const [body, code] of cases) {
      const r = await t.http('alex', 'POST', `/trousseaux/${keyId}/partenaire`, body);
      expect(r, JSON.stringify(body)).toMatchObject({ status: code === 'unknown_partner' ? 404 : 409, body: { ok: false, rule: 'R665', code } });
    }
    expect((await t.http('alex', 'GET', `/trousseaux/biens/${t.propertyId}`)).body.data).toMatchObject([{ id: keyId, state: 'armoire' }]);
  });

  it('[R16] mauvais rôle ou agent d’un autre bien : 403 au journal, corps mal formé compris ; seul un appelant admis reçoit 400', async () => {
    const t = await setup();
    const keyId = await t.register();
    const diag = await t.partner('diagnostiqueur', 'Diag Bourgogne SARL');
    const body = { partnerId: diag, purpose: 'diagnostic', dueAt: IN_3H };
    const cases: [Who, unknown, string?][] = [
      ['conformite', body],
      ['conformite', undefined, 'pas du json'],
      ['sam', body],
      ['sam', undefined, 'x'.repeat(5_000)],
    ];
    for (const [who, b, raw] of cases) {
      const before = (await t.refusals()).length;
      const r = await t.http(who, 'POST', `/trousseaux/${keyId}/partenaire`, b, raw);
      expect(r.status, who).toBe(403);
      expect(r.body).toMatchObject({ ok: false, rule: 'R16' });
      expect((await t.refusals()).length, who).toBeGreaterThan(before);
    }
    expect((await t.http('conformite', 'POST', '/trousseaux/inconnu-1/partenaire', body)).status).toBe(403);
    for (const raw of ['pas du json', '[1]', 'x'.repeat(5_000)]) expect(await t.http('alex', 'POST', `/trousseaux/${keyId}/partenaire`, undefined, raw)).toMatchObject({ status: 400, body: { code: 'invalid_body' } });
    expect((await t.http('alex', 'POST', '/trousseaux/inconnu-1/partenaire', body)).status).toBe(404);
    expect((await t.http('alex', 'GET', `/trousseaux/biens/${t.propertyId}`)).body.data).toMatchObject([{ id: keyId, state: 'armoire' }]);
  });

  it('[R271] [R665] « perdu » noté par l’agent qui en répond : le trousseau est retiré, il ne ressort plus ; un autre agent ne peut pas le noter', async () => {
    const t = await setup();
    const keyId = await t.register();
    const artisan = await t.partner('artisan', 'Menuiserie du Lac');
    expect((await t.http('alex', 'POST', `/trousseaux/${keyId}/partenaire`, { partnerId: artisan, purpose: 'travaux', dueAt: IN_3H })).status).toBe(200);
    expect((await t.http('sam', 'POST', `/trousseaux/${keyId}/perdu`)).status).toBe(403);
    expect((await t.http('alex', 'POST', `/trousseaux/${keyId}/perdu`)).status).toBe(200);
    expect((await t.http('alex', 'GET', '/trousseaux/a-rendre')).body.data).toEqual([]);
    const cabinet = await t.http('alex', 'GET', `/trousseaux/biens/${t.propertyId}`);
    expect(cabinet.body.data).toMatchObject([{ id: keyId, state: 'retire', retirement: { reason: 'perdu' } }]);
    expect((await t.http('alex', 'POST', `/trousseaux/${keyId}/partenaire`, { partnerId: artisan, purpose: 'travaux', dueAt: IN_3H })).body).toMatchObject({ rule: 'R271', code: 'retire' });
  });
});
