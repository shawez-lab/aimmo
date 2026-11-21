import { expect, it } from 'vitest';
import { FicheClient } from '@aimmo/core';
import { handleRequest, OPEN_WITHOUT_AGENT_FILE, type ApiConfig } from '../src/app.ts';
import { mcpRoutes } from '../src/mcp.ts';
import { sha256Hex } from '../src/index.ts';
import type { Challenge } from '../../core/src/securite/index.ts';
import { FakeAuthenticator, ORIGIN, RP } from '../../core/test/appareil-simule.ts';
import { setupAnnonce } from '../../core/test/annonces-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// Réseaux, agents, fiches, biens, adresses et clés inventés.
const KEYS = {
  alex: 'test-cle-br08-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  sam: 'test-cle-br08-sam-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  direction: 'test-cle-br08-direction-cccccccccccccccccccccc',
  conformite: 'test-cle-br08-conformite-ddddddddddddddddddddd',
  partenaire: 'test-cle-br08-partenaire-eeeeeeeeeeeeeeeeeeeee',
  // Les clés de portée « mcp », que chaque agent confie à son assistant.
  alexMcp: 'test-cle-br08-alex-mcp-gggggggggggggggggggggggg',
  samMcp: 'test-cle-br08-sam-mcp-hhhhhhhhhhhhhhhhhhhhhhhhh',
};
type Who = keyof typeof KEYS;
type Body = Record<string, any>;

async function setup(limits?: ApiConfig['mcpPublicLimits']) {
  const t = await setupAnnonce();
  const other = (await new FicheClient(t.db).createNetwork('Autre réseau')).id;
  const ids: Record<Who, { role: string; userId: string; networkId: string; scope?: 'mcp' }> = {
    alex: { role: 'agent', userId: t.alexId, networkId: t.network.id },
    sam: { role: 'agent', userId: t.sam.userId, networkId: t.network.id },
    direction: { role: 'direction', userId: t.direction.userId, networkId: t.network.id },
    conformite: { role: 'compliance', userId: 'conformite-1', networkId: t.network.id },
    partenaire: { role: 'partner', userId: 'partenaire-1', networkId: t.network.id },
    alexMcp: { role: 'agent', userId: t.alexId, networkId: t.network.id, scope: 'mcp' },
    samMcp: { role: 'agent', userId: t.sam.userId, networkId: t.network.id, scope: 'mcp' },
  };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), expiresOn: "2099-12-31", ...ids[w] }))));
  const config: ApiConfig = { db: t.db, apiKeys, mode: 'essai', now: t.now, cles: { rpId: RP, origins: [ORIGIN] }, ...(limits ? { mcpPublicLimits: limits } : {}) };
  const send = async (path: string, init: { who?: Who; token?: string; method?: string; body?: unknown; raw?: string; ip?: string } = {}): Promise<{ status: number; body: Body | null }> => {
    const headers: Record<string, string> = {};
    if (init.who) headers.authorization = `Bearer ${KEYS[init.who]}`;
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    if (init.ip) headers['cf-connecting-ip'] = init.ip;
    const payload = init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
    if (payload !== undefined) headers['content-type'] = 'application/json';
    const r = await handleRequest(new Request(`https://aimmo-api.example.test/v1${path}`, { method: init.method ?? 'POST', headers, ...(payload === undefined ? {} : { body: payload }) }), config);
    const text = await r.text();
    return { status: r.status, body: text === '' ? null : (JSON.parse(text) as Body) };
  };
  let n = 0;
  /** L'assistant de l'agent parle au serveur par la clé « mcp » de cet agent. */
  const mcpOf = (who: Who): Who => (who === 'alex' ? 'alexMcp' : who === 'sam' ? 'samMcp' : who);
  const rpc = (who: Who, method: string, params?: unknown) => send('/mcp', { who: mcpOf(who), body: { jsonrpc: '2.0', id: ++n, method, ...(params === undefined ? {} : { params }) } });
  const tool = async (who: Who, name: string, args: Record<string, unknown> = {}) => (await rpc(who, 'tools/call', { name, arguments: args })).body?.result as { isError: boolean; structuredContent: Body };
  const lines = async (type: string) => (await t.journal.all()).filter((e) => e.type === type);
  /** La séance de l'application : la clé de cet appareil, enregistrée puis signée (BR06). */
  const appSession = async (who: Who, seed: number): Promise<string> => {
    const device = await FakeAuthenticator.create(seed);
    const c = await send('/cles/enregistrement/debut', { who });
    await send('/cles/enregistrement/fin', { who, body: await device.register(c.body?.data as Challenge) });
    const d = await send('/cles/connexion/debut', { body: { networkId: ids[who].networkId, role: ids[who].role, userId: ids[who].userId } });
    const f = await send('/cles/connexion/fin', { body: await device.sign(d.body?.data as Challenge) });
    if (f.status !== 200) throw new Error(`séance ${f.body?.code}`);
    return f.body?.data.token as string;
  };
  const count = async (table: string) => Number((await t.db.first<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))?.n);
  return { ...t, other, send, rpc, tool, lines, appSession, count };
}

describeWithSqlite('BR08 · adresse du serveur MCP', () => {
  it('[R16] [R590] la direction, la conformité et les partenaires n’ont aucun outil : refusés avant le corps, au journal', async () => {
    const t = await setup();
    for (const who of ['direction', 'conformite', 'partenaire'] as const) {
      for (const [method, path, body] of [
        ['POST', '/mcp', 'pas du json'],
        ['GET', '/mcp/brouillons', undefined],
        ['POST', '/mcp/brouillons/d-1/decision', { decision: 'valide' }],
      ] as const) {
        const before = (await t.lines('acces.refuse')).length;
        const r = await t.send(path, { who, method, ...(body === undefined ? {} : { raw: typeof body === 'string' ? body : JSON.stringify(body) }) });
        // Sur le serveur, la clé n'est pas de portée « mcp » ; ailleurs, le rôle n'est pas celui de l'agent.
        expect([who, path, r.status, r.body]).toEqual([who, path, 403, path === '/mcp' ? { ok: false, rule: 'R590', code: 'cle_mcp_requise' } : { ok: false, rule: 'R16', code: 'role' }]);
        expect((await t.lines('acces.refuse')).length).toBe(before + 1);
      }
    }
    // Sans clé : 401 ; aucun appel n'atteint le serveur.
    expect((await t.send('/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'ping' } })).status).toBe(401);
    expect(await t.lines('mcp.appel')).toEqual([]);
  });

  it('[R590] [R591] la clé confiée à l’assistant n’ouvre que le serveur MCP, et le serveur n’accepte qu’elle', async () => {
    const t = await setup();
    // La clé ordinaire de l'agent n'ouvre pas le serveur MCP.
    expect(await t.send('/mcp', { who: 'alex', body: { jsonrpc: '2.0', id: 1, method: 'ping' } })).toMatchObject({ status: 403, body: { rule: 'R590', code: 'cle_mcp_requise' } });
    // La clé « mcp » n'ouvre rien d'autre : ni fiche, ni clé d'appareil (donc aucune séance), ni brouillon, ni export.
    for (const [method, path, body] of [
      ['GET', '/moi', undefined],
      ['GET', `/fiches/${t.personId}`, undefined],
      ['POST', '/cles/enregistrement/debut', undefined],
      ['GET', '/mcp/brouillons', undefined],
      ['POST', '/mcp/brouillons/d-1/decision', { decision: 'valide' }],
      ['POST', '/export/agent', { stepUpId: 's' }],
    ] as const) {
      const before = (await t.lines('acces.refuse')).length;
      const r = await t.send(path, { who: 'alexMcp', method, ...(body === undefined ? {} : { body }) });
      expect([path, r.status, r.body]).toEqual([path, 403, { ok: false, rule: 'R590', code: 'cle_mcp_hors_mcp' }]);
      expect((await t.lines('acces.refuse')).length).toBe(before + 1);
    }
    expect(await t.count('security_challenges')).toBe(0);
    expect((await t.rpc('alex', 'ping')).status).toBe(200);
  });

  it('[R590] la portée « mcp » ne se lit que pour un agent ; une portée inconnue ferme l’API', async () => {
    const { parseApiKeys } = await import('../src/auth.ts');
    const base = { sha256: 'a'.repeat(64), userId: 'u-1', networkId: 'n-1' };
    expect(parseApiKeys(JSON.stringify([{ ...base, role: 'agent', scope: 'mcp' }]))).toEqual([{ ...base, role: 'agent', scope: 'mcp' }]);
    expect(parseApiKeys(JSON.stringify([{ ...base, role: 'direction', scope: 'mcp' }]))).toBeNull();
    expect(parseApiKeys(JSON.stringify([{ ...base, role: 'agent', scope: 'tout' }]))).toBeNull();
    expect(parseApiKeys(JSON.stringify([{ ...base, role: 'agent' }]))).toEqual([{ ...base, role: 'agent' }]);
  });

  it('[R590] l’agent parle au serveur par sa clé : chaque appel au journal avant la donnée ; notification sans réponse', async () => {
    const t = await setup();
    const init = await t.rpc('alex', 'initialize', {});
    expect(init).toMatchObject({ status: 200, body: { jsonrpc: '2.0', result: { serverInfo: { name: 'aimmo' } } } });
    const tools = await t.rpc('alex', 'tools/list');
    expect((tools.body?.result.tools as { name: string }[]).map((x) => x.name)).toContain('brouillon_prix');
    const mine = await t.tool('alex', 'mes_biens');
    expect(mine.isError).toBe(false);
    expect((mine.structuredContent.biens as { bien: string }[]).map((b) => b.bien)).toEqual([t.propertyId]);
    expect(await t.lines('mcp.appel')).toHaveLength(1);
    // Un bien d'un autre agent n'est pas lu, et le refus est au journal.
    const other = await t.tool('sam', 'lire_bien', { bien: t.propertyId });
    expect(other.isError).toBe(true);
    expect((await t.lines('mcp.refus')).length).toBeGreaterThan(0);
    // Un argument hors du schéma est refusé.
    expect((await t.tool('alex', 'lire_bien', { bien: t.propertyId, adresse: true })).isError).toBe(true);
    // Notification : 202, corps vide. Corps illisible : erreur JSON-RPC.
    expect(await t.send('/mcp', { who: 'alexMcp', body: { jsonrpc: '2.0', method: 'notifications/initialized' } })).toEqual({ status: 202, body: null });
    const refusals = (await t.lines('mcp.refus')).length;
    expect(await t.send('/mcp', { who: 'alexMcp', raw: '{pas du json' })).toMatchObject({ status: 400, body: { error: { code: -32700 } } });
    // Le refus d'un corps illisible est au journal, sans le corps.
    expect((await t.lines('mcp.refus')).length).toBe(refusals + 1);
    expect(JSON.stringify(await t.lines('mcp.refus'))).not.toContain('pas du json');
    expect((await t.send('/mcp', { who: 'alexMcp', method: 'GET' })).status).toBe(405);
  });

  it('[R590] [R591] aucune donnée de client vers l’assistant ; un brouillon se décide dans l’application, par son agent seul', async () => {
    const t = await setup();
    const note = await t.tool('alex', 'brouillon_note', { fiche: t.personId, texte: 'Rappeler après les vacances pour la visite.' });
    expect(note).toMatchObject({ isError: false, structuredContent: { statut: 'a_valider', a_valider_dans: 'application' } });
    const draftId = note.structuredContent.brouillon as string;
    const listed = await t.rpc('alex', 'tools/call', { name: 'mes_brouillons', arguments: {} });
    const lire = await t.rpc('alex', 'tools/call', { name: 'lire_bien', arguments: { bien: t.propertyId } });
    for (const res of [listed, lire]) {
      const text = JSON.stringify(res.body);
      expect(text).not.toMatch(/Léa|Exemple|@|Rappeler/);
    }
    // Aucun outil ne décide : seule la route de l'application, par l'agent du brouillon.
    expect((await t.rpc('alex', 'tools/call', { name: 'valider_brouillon', arguments: { brouillon: draftId } })).body?.error).toMatchObject({ code: -32602 });
    // La clé d'API, que l'agent a pu confier à son assistant, ne lit ni ne décide aucun brouillon : au journal.
    const before = (await t.lines('acces.refuse')).length;
    expect(await t.send(`/mcp/brouillons/${draftId}/decision`, { who: 'alex', body: { decision: 'valide' } })).toMatchObject({ status: 403, body: { rule: 'R591', code: 'application_requise' } });
    expect(await t.send('/mcp/brouillons', { who: 'alex', method: 'GET' })).toMatchObject({ status: 403, body: { code: 'application_requise' } });
    expect((await t.lines('acces.refuse')).length).toBe(before + 2);
    // Depuis l'application, par la clé de son appareil : l'agent du brouillon seul décide, une fois.
    const alexApp = await t.appSession('alex', 21);
    const samApp = await t.appSession('sam', 22);
    expect(await t.send(`/mcp/brouillons/${draftId}/decision`, { token: samApp, body: { decision: 'valide' } })).toMatchObject({ status: 403, body: { rule: 'R16' } });
    expect(await t.send(`/mcp/brouillons/${draftId}/decision`, { token: alexApp, body: { decision: 'peut-etre' } })).toMatchObject({ status: 409, body: { rule: 'R591', code: 'bad_input' } });
    expect(await t.send(`/mcp/brouillons/${draftId}/decision`, { token: alexApp, body: { decision: 'valide', texte: 'x' } })).toMatchObject({ status: 400, body: { code: 'unknown_field' } });
    expect(await t.send(`/mcp/brouillons/${draftId}/decision`, { token: alexApp, body: { decision: 'valide' } })).toMatchObject({ status: 200, body: { ok: true } });
    expect((await t.send(`/mcp/brouillons/${draftId}/decision`, { token: alexApp, body: { decision: 'refuse' } })).status).toBe(409);
    const own = await t.send('/mcp/brouillons', { token: alexApp, method: 'GET' });
    expect(own).toMatchObject({ status: 200 });
    expect((own.body?.data as { id: string; status: string }[]).find((d) => d.id === draftId)?.status).toBe('valide');
    // La séance de l'application n'ouvre pas le serveur MCP : seule la clé « mcp » le fait.
    expect(await t.send('/mcp', { token: alexApp, body: { jsonrpc: '2.0', id: 99, method: 'ping' } })).toMatchObject({ status: 403, body: { code: 'cle_mcp_requise' } });
  });

  it('[R16] [R82] les droits sont revérifiés à chaque appel : un agent parti n’a plus rien, dès l’appel suivant ; aucune route MCP sans dossier complet', async () => {
    const t = await setup();
    expect((await t.tool('alex', 'mes_biens')).isError).toBe(false);
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.alexId]);
    const r = await t.rpc('alex', 'tools/call', { name: 'mes_biens', arguments: {} });
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).not.toContain(t.propertyId);
    for (const route of mcpRoutes()) expect(OPEN_WITHOUT_AGENT_FILE.has(route.name), route.name).toBe(false);
  });

  it('[R592] sans clé, le seul outil public, sans adresse, agent ni donnée personnelle ; limité en débit', async () => {
    const t = await setup({ perIp: 3, perNetwork: 5 });
    const pub = (body: unknown, ip?: string) => t.send(`/mcp/public/${t.network.id}`, { body, ...(ip ? { ip } : {}) });
    expect((await t.send('/mcp/public/reseau-inconnu', { body: { jsonrpc: '2.0', id: 1, method: 'ping' } })).status).toBe(404);
    const tools = await pub({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, '192.0.2.1');
    expect((tools.body?.result.tools as { name: string }[]).map((x) => x.name)).toEqual(['biens_diffusables']);
    const agentTool = await pub({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'mes_biens', arguments: {} } }, '192.0.2.1');
    expect(agentTool.body?.error).toMatchObject({ code: -32602 });
    const listings = await pub({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'biens_diffusables', arguments: {} } }, '192.0.2.1');
    expect(listings.status).toBe(200);
    const text = JSON.stringify(listings.body);
    expect(text).not.toContain(t.alexId);
    expect(text).not.toMatch(/Léa|Exemple|adresse|address|agent/i);
    // La même adresse : trois demandes, puis 429 ; le réseau entier : cinq.
    expect((await pub({ jsonrpc: '2.0', id: 4, method: 'ping' }, '192.0.2.1')).status).toBe(429);
    expect((await pub({ jsonrpc: '2.0', id: 5, method: 'ping' }, '198.51.100.2')).status).toBe(200);
    expect((await pub({ jsonrpc: '2.0', id: 6, method: 'ping' })).status).toBe(200);
    expect((await pub({ jsonrpc: '2.0', id: 7, method: 'ping' })).status).toBe(429);
    // Le réseau d'un autre ne lit que ses propres biens : aucun ici.
    const empty = await t.send(`/mcp/public/${t.other}`, { body: { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'biens_diffusables', arguments: {} } } });
    expect(empty.body?.result.structuredContent.biens).toEqual([]);
    expect(JSON.stringify(await t.db.all('SELECT scope FROM assistant_calls'))).not.toContain('192.0.2.1');
  });
});
