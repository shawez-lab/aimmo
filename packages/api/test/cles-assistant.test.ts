import { expect, it } from 'vitest';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import type { Challenge } from '../../core/src/securite/index.ts';
import { FakeAuthenticator, ORIGIN, RP } from '../../core/test/appareil-simule.ts';
import { setupAnnonce } from '../../core/test/annonces-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// Réseau, agents, appareils simulés et clés inventés.
const KEYS = {
  alex: 'test-cle-br09-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  sam: 'test-cle-br09-sam-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  direction: 'test-cle-br09-direction-cccccccccccccccccccccc',
  partenaire: 'test-cle-br09-partenaire-eeeeeeeeeeeeeeeeeeeee',
};
type Who = keyof typeof KEYS;
type Body = Record<string, any>;

async function setup() {
  const t = await setupAnnonce();
  const ids: Record<Who, { role: string; userId: string; networkId: string }> = {
    alex: { role: 'agent', userId: t.alexId, networkId: t.network.id },
    sam: { role: 'agent', userId: t.sam.userId, networkId: t.network.id },
    direction: { role: 'direction', userId: t.direction.userId, networkId: t.network.id },
    partenaire: { role: 'partner', userId: 'partenaire-1', networkId: t.network.id },
  };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), expiresOn: "2099-12-31", ...ids[w] }))));
  const config: ApiConfig = { db: t.db, apiKeys, mode: 'essai', now: t.now, cles: { rpId: RP, origins: [ORIGIN] } };
  /** `bearer` : une clé de `KEYS`, ou un jeton (séance, clé d'assistant). */
  const send = async (path: string, init: { who?: Who; bearer?: string; method?: string; body?: unknown } = {}): Promise<{ status: number; body: Body | null }> => {
    const headers: Record<string, string> = {};
    if (init.who) headers.authorization = `Bearer ${KEYS[init.who]}`;
    if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    const r = await handleRequest(
      new Request(`https://aimmo-api.example.test/v1${path}`, { method: init.method ?? 'POST', headers, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) }),
      config,
    );
    const text = await r.text();
    return { status: r.status, body: text === '' ? null : (JSON.parse(text) as Body) };
  };
  /** La clé d'un appareil, enregistrée, puis la séance de l'application qu'elle ouvre (BR06). */
  const app = async (who: Who, seed: number) => {
    const device = await FakeAuthenticator.create(seed);
    const c = await send('/cles/enregistrement/debut', { who });
    await send('/cles/enregistrement/fin', { who, body: await device.register(c.body?.data as Challenge) });
    const d = await send('/cles/connexion/debut', { body: { networkId: ids[who].networkId, role: ids[who].role, userId: ids[who].userId } });
    const f = await send('/cles/connexion/fin', { body: await device.sign(d.body?.data as Challenge) });
    if (f.status !== 200) throw new Error(`séance ${f.body?.code}`);
    return { device, token: f.body?.data.token as string };
  };
  /** Une preuve d'action sensible faite par la clé de l'appareil. */
  const proof = async (token: string, device: FakeAuthenticator, action: string, subject: string) => {
    const c = await send('/cles/preuve/debut', { bearer: token, body: { action, subject } });
    if (c.status !== 200) throw new Error(`preuve ${c.body?.code}`);
    const p = await send('/cles/preuve/fin', { bearer: token, body: await device.sign(c.body?.data as Challenge) });
    if (p.status !== 200) throw new Error(`preuve ${p.body?.code}`);
    return p.body?.data.stepUpId as string;
  };
  /** Crée la clé de l'assistant d'Alex depuis l'application, preuve comprise. */
  const create = async (s: { device: FakeAuthenticator; token: string }, label = 'ChatGPT') =>
    send('/cles/assistant', { bearer: s.token, body: { stepUpId: await proof(s.token, s.device, 'creer_cle_api', `cle_assistant:${t.alexId}`), label } });
  let n = 0;
  const ping = (key: string) => send('/mcp', { bearer: key, body: { jsonrpc: '2.0', id: ++n, method: 'ping' } });
  const lines = async (type: string) => (await t.journal.all()).filter((e) => e.type === type);
  return { ...t, send, app, proof, create, ping, lines };
}

describeWithSqlite('BR09 · l’agent crée et retire lui-même la clé de son assistant', () => {
  it('[R601] création seulement par la séance d’une clé d’appareil, sur une preuve faite pour « cle_assistant » de lui-même', async () => {
    const t = await setup();
    const alex = await t.app('alex', 1);
    // Par sa clé d'API (qu'un assistant peut tenir) : refusé avant le corps, au journal, rien de rangé.
    const before = (await t.lines('acces.refuse')).length;
    expect(await t.send('/cles/assistant', { who: 'alex', body: { stepUpId: 'x', label: 'ChatGPT' } })).toMatchObject({ status: 403, body: { rule: 'R601', code: 'application_requise' } });
    expect((await t.lines('acces.refuse')).length).toBe(before + 1);
    // Par la séance, sans preuve, ou avec la preuve d'une autre action ou d'un autre objet : refusé.
    expect(await t.send('/cles/assistant', { bearer: alex.token, body: { label: 'ChatGPT' } })).toMatchObject({ status: 409, body: { rule: 'R601', code: 'second_factor_required' } });
    const export_ = await t.proof(alex.token, alex.device, 'export_complet', `agent:${t.alexId}`);
    expect(await t.send('/cles/assistant', { bearer: alex.token, body: { stepUpId: export_, label: 'ChatGPT' } })).toMatchObject({ status: 409, body: { rule: 'R601', code: 'other_action' } });
    const forSam = await t.proof(alex.token, alex.device, 'creer_cle_api', `cle_assistant:${t.sam.userId}`);
    expect(await t.send('/cles/assistant', { bearer: alex.token, body: { stepUpId: forSam, label: 'ChatGPT' } })).toMatchObject({ status: 409, body: { rule: 'R601', code: 'other_action' } });
    expect(Number((await t.db.first<{ n: number }>('SELECT count(*) AS n FROM assistant_keys'))?.n)).toBe(0);
    // Avec la bonne preuve : la clé est rendue une fois ; la preuve ne sert pas deux fois.
    const stepUpId = await t.proof(alex.token, alex.device, 'creer_cle_api', `cle_assistant:${t.alexId}`);
    const made = await t.send('/cles/assistant', { bearer: alex.token, body: { stepUpId, label: 'ChatGPT' } });
    expect(made).toMatchObject({ status: 200, body: { ok: true, data: { label: 'ChatGPT', revokedAt: null } } });
    expect(String(made.body?.data.cle).length).toBeGreaterThanOrEqual(32);
    expect(await t.send('/cles/assistant', { bearer: alex.token, body: { stepUpId, label: 'Claude' } })).toMatchObject({ status: 409, body: { rule: 'R601', code: 'already_used' } });
    // Un champ non prévu, un nom vide : refusés, rien rangé.
    expect(await t.send('/cles/assistant', { bearer: alex.token, body: { stepUpId: 'x', label: 'A', portee: 'tout' } })).toMatchObject({ status: 400, body: { code: 'unknown_field' } });
    expect((await t.create(alex, '  ')).status).toBe(400);
  });

  it('[R590] la clé créée n’ouvre que POST /v1/mcp, et elle y parle pour son agent', async () => {
    const t = await setup();
    const alex = await t.app('alex', 2);
    const key = (await t.create(alex)).body?.data.cle as string;
    expect(await t.ping(key)).toMatchObject({ status: 200, body: { jsonrpc: '2.0', result: {} } });
    const mine = await t.send('/mcp', { bearer: key, body: { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'mes_biens', arguments: {} } } });
    expect((mine.body?.result.structuredContent.biens as { bien: string }[]).map((b) => b.bien)).toEqual([t.propertyId]);
    for (const [method, path, body] of [
      ['GET', '/moi', undefined],
      ['GET', `/fiches/${t.personId}`, undefined],
      ['GET', '/cles/assistant', undefined],
      ['POST', '/cles/assistant', { stepUpId: 'x', label: 'Autre' }],
      ['POST', '/cles/enregistrement/debut', undefined],
      ['GET', '/mcp/brouillons', undefined],
      ['POST', '/export/agent', { stepUpId: 's' }],
    ] as const) {
      const r = await t.send(path, { bearer: key, method, ...(body === undefined ? {} : { body }) });
      expect([path, r.status, r.body]).toEqual([path, 403, { ok: false, rule: 'R590', code: 'cle_mcp_hors_mcp' }]);
    }
    expect(Number((await t.db.first<{ n: number }>('SELECT count(*) AS n FROM assistant_keys'))?.n)).toBe(1);
  });

  it('[R600] retirée d’un geste, elle est refusée à l’appel suivant ; un autre agent ne la voit ni ne la retire ; la direction le peut', async () => {
    const t = await setup();
    const alex = await t.app('alex', 3);
    const first = (await t.create(alex, 'ChatGPT')).body?.data as Body;
    const second = (await t.create(alex, 'Claude')).body?.data as Body;
    expect((await t.ping(first.cle)).status).toBe(200);
    // Sam ne la voit pas et ne la retire pas : 404, comme si elle n'existait pas.
    expect(await t.send(`/cles/assistant/${first.id}/retrait`, { who: 'sam' })).toMatchObject({ status: 404, body: { code: 'unknown' } });
    expect((await t.send('/cles/assistant', { who: 'sam', method: 'GET' })).body?.data).toEqual([]);
    expect((await t.ping(first.cle)).status).toBe(200);
    // Alex la retire d'un geste, sans preuve, même par sa clé d'API.
    expect(await t.send(`/cles/assistant/${first.id}/retrait`, { who: 'alex' })).toMatchObject({ status: 200, body: { data: { id: first.id } } });
    expect(await t.ping(first.cle)).toMatchObject({ status: 401 });
    expect((await t.ping(second.cle)).status).toBe(200);
    // La direction retire celle de tout agent de son réseau ; un partenaire, aucune.
    expect(await t.send(`/cles/assistant/${second.id}/retrait`, { who: 'partenaire' })).toMatchObject({ status: 403, body: { rule: 'R16' } });
    expect(await t.send(`/cles/assistant/${second.id}/retrait`, { who: 'direction' })).toMatchObject({ status: 200 });
    expect(await t.ping(second.cle)).toMatchObject({ status: 401 });
    // La liste de l'agent garde les deux, retirées et datées, sans empreinte ni clé.
    const list = (await t.send('/cles/assistant', { who: 'alex', method: 'GET' })).body?.data as Body[];
    expect(list.map((k) => [k.label, k.revokedAt !== null]).sort()).toEqual([
      ['ChatGPT', true],
      ['Claude', true],
    ]);
    expect(Object.keys(list[0]!).sort()).toEqual(['createdAt', 'id', 'label', 'revokedAt']);
    // Une clé retirée ne revient jamais, et rien ne s'efface [R17].
    await expect(t.db.run('UPDATE assistant_keys SET revoked_at = NULL WHERE id = ?', [first.id])).rejects.toThrow();
    await expect(t.db.run('DELETE FROM assistant_keys WHERE id = ?', [first.id])).rejects.toThrow();
  });

  it('[R13] seule l’empreinte est rangée : ni la clé, ni son empreinte au journal', async () => {
    const t = await setup();
    const alex = await t.app('alex', 4);
    const key = (await t.create(alex)).body?.data.cle as string;
    const hash = await sha256Hex(key);
    const rows = await t.db.all<Record<string, unknown>>('SELECT * FROM assistant_keys');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sha256).toBe(hash);
    const stored = JSON.stringify(rows);
    expect(stored).not.toContain(key);
    const journal = JSON.stringify(await t.journal.all());
    expect(journal).not.toContain(key);
    expect(journal).not.toContain(hash);
    expect(await t.lines('cles.assistant.creee')).toHaveLength(1);
  });

  it('[R82] un agent parti n’en a plus aucune : sa clé n’est plus reconnue, et il n’en crée plus', async () => {
    const t = await setup();
    const alex = await t.app('alex', 5);
    const key = (await t.create(alex)).body?.data.cle as string;
    expect((await t.ping(key)).status).toBe(200);
    // Un départ programmé, statut encore « actif » : la clé sert jusqu'à la veille, plus le jour du départ, dès minuit à Paris.
    const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(d);
    const today = day(t.now());
    const tomorrow = day(new Date(t.now().getTime() + 86_400_000));
    await t.db.run(
      "INSERT INTO agent_departures (id, network_id, agent_id, notice_given_on, leaves_on, reason, notice_months, created_by, created_at) VALUES ('dep-1', ?, ?, ?, ?, 'demission_agent', 1, 'direction:x', ?)",
      [t.network.id, t.alexId, today, tomorrow, t.now().toISOString()],
    );
    expect((await t.ping(key)).status).toBe(200);
    // Le lendemain, à minuit cinq à Paris : la clé n'est plus reconnue, sans que personne ne l'ait retirée.
    t.setClock(new Date(`${tomorrow}T00:05:00+01:00`));
    expect(await t.ping(key)).toMatchObject({ status: 401 });
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.alexId]);
    expect(await t.ping(key)).toMatchObject({ status: 401 });
    expect((await t.send('/cles/assistant', { bearer: alex.token, body: { stepUpId: 'x', label: 'Claude' } })).status).toBe(401);
  });

  it('trois clés actives au plus par agent ; la limite est lue avant d’user la preuve', async () => {
    const t = await setup();
    const alex = await t.app('alex', 6);
    for (const label of ['Un', 'Deux', 'Trois']) expect((await t.create(alex, label)).status).toBe(200);
    const stepUpId = await t.proof(alex.token, alex.device, 'creer_cle_api', `cle_assistant:${t.alexId}`);
    expect(await t.send('/cles/assistant', { bearer: alex.token, body: { stepUpId, label: 'Quatre' } })).toMatchObject({ status: 409, body: { code: 'limite_atteinte' } });
    const first = ((await t.send('/cles/assistant', { who: 'alex', method: 'GET' })).body?.data as Body[])[0]!;
    await t.send(`/cles/assistant/${first.id}/retrait`, { who: 'alex' });
    // La preuve n'a pas été usée par le refus : elle sert encore.
    expect((await t.send('/cles/assistant', { bearer: alex.token, body: { stepUpId, label: 'Quatre' } })).status).toBe(200);
  });

  it('[R16] sans site WebAuthn, les routes de la clé de l’assistant sont fermées', async () => {
    const t = await setup();
    const config: ApiConfig = { db: t.db, apiKeys: JSON.stringify([{ sha256: await sha256Hex(KEYS.alex), expiresOn: "2099-12-31", role: 'agent', userId: t.alexId, networkId: t.network.id }]), mode: 'essai', now: t.now };
    const r = await handleRequest(new Request('https://aimmo-api.example.test/v1/cles/assistant', { headers: { authorization: `Bearer ${KEYS.alex}` } }), config);
    expect(r.status).toBe(503);
  });
});
