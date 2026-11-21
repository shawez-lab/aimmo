import { expect, it } from 'vitest';
import { FicheClient } from '@aimmo/core';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import type { Challenge } from '../../core/src/securite/index.ts';
import { FakeAuthenticator, ORIGIN, RP } from '../../core/test/appareil-simule.ts';
import { setupAnnonce } from '../../core/test/annonces-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// Réseaux, agents, appareils simulés, adresses et clés inventés.
const KEYS = {
  alex: 'test-cle-br06-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  direction: 'test-cle-br06-direction-cccccccccccccccccccccc',
};
type Who = keyof typeof KEYS;
type Body = { ok: boolean; data?: any; rule?: string | null; code?: string };

async function setup(options: { site?: ApiConfig['cles']; apiKeys?: boolean; limits?: ApiConfig['clesLimits'] } = {}) {
  const t = await setupAnnonce();
  const other = (await new FicheClient(t.db).createNetwork('Autre réseau')).id;
  const ids: Record<Who, { role: string; userId: string; networkId: string }> = {
    alex: { role: 'agent', userId: t.alexId, networkId: t.network.id },
    direction: { role: 'direction', userId: t.direction.userId, networkId: t.network.id },
  };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), expiresOn: "2099-12-31", ...ids[w] }))));
  const config: ApiConfig = {
    db: t.db,
    apiKeys: options.apiKeys === false ? undefined : apiKeys,
    mode: 'essai',
    now: t.now,
    cles: options.site === undefined ? { rpId: RP, origins: [ORIGIN] } : options.site,
    ...(options.limits ? { clesLimits: options.limits } : {}),
  };
  const call = async (method: string, path: string, init: { bearer?: string; body?: unknown; ip?: string } = {}): Promise<{ status: number; body: Body }> => {
    const headers: Record<string, string> = {};
    if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
    if (init.ip) headers['cf-connecting-ip'] = init.ip;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    const r = await handleRequest(new Request(`https://aimmo-api.example.test/v1${path}`, { method, headers, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) }), config);
    return { status: r.status, body: (await r.json()) as Body };
  };
  const http = (who: Who, method: string, path: string, body?: unknown) => call(method, path, { bearer: KEYS[who], body });
  /** La clé d'un appareil simulé, enregistrée par les routes de BR05. */
  const enroll = async (who: Who, seed: number) => {
    const device = await FakeAuthenticator.create(seed);
    const c = await http(who, 'POST', '/cles/enregistrement/debut');
    const done = await http(who, 'POST', '/cles/enregistrement/fin', await device.register(c.body.data as Challenge));
    if (done.status !== 200) throw new Error(`enregistrement ${done.body.code}`);
    return { device, id: done.body.data.id as string };
  };
  const begin = (who: Who, ip?: string) => call('POST', '/cles/connexion/debut', { body: { networkId: ids[who].networkId, role: ids[who].role, userId: ids[who].userId }, ...(ip ? { ip } : {}) });
  /** Une connexion entière : défi, signature de l'appareil, jeton de séance. */
  const login = async (who: Who, device: FakeAuthenticator) => {
    const c = await begin(who);
    if (c.status !== 200) throw new Error(`début ${c.body.code}`);
    return call('POST', '/cles/connexion/fin', { body: { ...(await device.sign(c.body.data as Challenge)) } });
  };
  const count = async (table: string) => Number((await t.db.first<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))?.n);
  return { ...t, other, ids, call, http, enroll, begin, login, count };
}

describeWithSqlite('BR06 · connexion par une clé d’appareil dans le socle', () => {
  it('[R600] une connexion rend une séance, acceptée par l’API comme une clé, relue à chaque demande', async () => {
    const t = await setup();
    const { device } = await t.enroll('direction', 7);
    const done = await t.login('direction', device);
    expect(done).toMatchObject({ status: 200, body: { ok: true, data: { viewer: { role: 'direction', userId: t.direction.userId, networkId: t.network.id } } } });
    const token = done.body.data.token as string;
    // Seule l'empreinte du jeton est rangée.
    const stored = JSON.stringify(await t.db.all('SELECT * FROM security_sessions'));
    expect(stored).not.toContain(token);
    const listed = await t.call('GET', '/cles/appareils', { bearer: token });
    expect(listed).toMatchObject({ status: 200, body: { ok: true } });
    expect(listed.body.data).toHaveLength(1);
    // Un jeton inventé ou abîmé est refusé comme une clé inconnue.
    expect((await t.call('GET', '/cles/appareils', { bearer: `${token.slice(0, -2)}AA` })).status).toBe(401);
    expect((await t.call('GET', '/cles/appareils', { bearer: 'pas-un-jeton' })).status).toBe(401);
  });

  it('[R600] une séance d’une clé retirée est refusée à la demande suivante', async () => {
    const t = await setup();
    const { device, id } = await t.enroll('alex', 3);
    const token = (await t.login('alex', device)).body.data.token as string;
    expect((await t.call('POST', '/cles/enregistrement/debut', { bearer: token })).status).toBe(200);
    expect(await t.call('POST', `/cles/appareils/${id}/retrait`, { bearer: token })).toMatchObject({ status: 200, body: { data: { status: 'retire' } } });
    expect(await t.call('POST', '/cles/enregistrement/debut', { bearer: token })).toMatchObject({ status: 401, body: { code: 'unauthorized' } });
    // Sans clé active, plus aucune connexion : la même réponse que tout autre refus.
    expect(await t.begin('alex')).toMatchObject({ status: 403, body: { rule: 'R600', code: 'connexion_refusee' } });
  });

  it('[R82] [R600] une séance d’un agent parti est refusée à la demande suivante, et il ne se connecte plus', async () => {
    const t = await setup();
    const { device } = await t.enroll('alex', 4);
    const token = (await t.login('alex', device)).body.data.token as string;
    expect((await t.call('POST', '/cles/enregistrement/debut', { bearer: token })).status).toBe(200);
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.alexId]);
    expect((await t.call('POST', '/cles/enregistrement/debut', { bearer: token })).status).toBe(401);
    expect((await t.begin('alex')).status).toBe(403);
  });

  it('[R600] un défi ne sert qu’une fois, même raté ; une signature d’un autre appareil ne connecte pas', async () => {
    const t = await setup();
    const { device } = await t.enroll('alex', 5);
    const c = await t.begin('alex');
    const signed = await device.sign(c.body.data as Challenge);
    const first = await t.call('POST', '/cles/connexion/fin', { body: { ...signed } });
    expect(first.status).toBe(200);
    const again = await t.call('POST', '/cles/connexion/fin', { body: { ...(await device.sign(c.body.data as Challenge)) } });
    expect(again).toMatchObject({ status: 403, body: { rule: 'R600', code: 'connexion_refusee' } });
    // Un autre appareil signe un défi neuf : refusé, et ce défi est usé, même la bonne signature ne passe plus.
    const c2 = await t.begin('alex');
    const stranger = await FakeAuthenticator.create(5);
    expect((await t.call('POST', '/cles/connexion/fin', { body: { ...(await stranger.sign(c2.body.data as Challenge)) } })).status).toBe(403);
    expect((await t.call('POST', '/cles/connexion/fin', { body: { ...(await device.sign(c2.body.data as Challenge)) } })).status).toBe(403);
    expect(await t.count('security_sessions')).toBe(1);
    // La raison de chaque refus est au journal, jamais dans la réponse.
    const codes = (await t.journal.all()).filter((e) => e.type === 'securite.refus').map((e) => (e.data as { code: string }).code);
    expect(codes).toEqual(expect.arrayContaining(['challenge_used']));
  });

  it('[R600] le réseau de la séance est celui du défi, lu dans la base : un réseau annoncé par l’appelant est refusé comme champ de trop', async () => {
    const t = await setup();
    const { device } = await t.enroll('alex', 6);
    const c = await t.begin('alex');
    const signed = await device.sign(c.body.data as Challenge);
    expect(await t.call('POST', '/cles/connexion/fin', { body: { networkId: t.other, ...signed } })).toMatchObject({ status: 400, body: { code: 'unknown_field' } });
    expect(await t.count('security_sessions')).toBe(0);
    expect(await t.call('POST', '/cles/connexion/fin', { body: signed })).toMatchObject({ status: 200, body: { data: { viewer: { networkId: t.network.id } } } });
  });

  it('[R600] tout refus a la même réponse : réseau, rôle ou utilisateur inconnu, champ de trop, corps illisible', async () => {
    const t = await setup();
    const refused = { status: 403, body: { ok: false, rule: 'R600', code: 'connexion_refusee' } };
    expect(await t.call('POST', '/cles/connexion/debut', { body: { networkId: 'reseau-inconnu', role: 'agent', userId: t.alexId } })).toMatchObject(refused);
    expect(await t.call('POST', '/cles/connexion/debut', { body: { networkId: t.network.id, role: 'partner', userId: 'p-1' } })).toMatchObject(refused);
    expect(await t.call('POST', '/cles/connexion/debut', { body: { networkId: t.network.id, role: 'agent', userId: 'agent-inconnu' } })).toMatchObject(refused);
    expect(await t.call('POST', '/cles/connexion/debut', { body: { networkId: t.network.id, role: 'agent', userId: t.alexId } })).toMatchObject(refused);
    expect(await t.call('POST', '/cles/connexion/fin', { body: { challengeId: 'inconnu' } })).toMatchObject(refused);
    expect(await t.call('POST', '/cles/connexion/fin', { body: { challengeId: 42 } })).toMatchObject(refused);
    expect(await t.call('POST', '/cles/connexion/debut', { body: { networkId: t.network.id, role: 'agent', userId: t.alexId, admin: true } })).toMatchObject({ status: 400, body: { code: 'unknown_field' } });
    expect(await t.call('POST', '/cles/connexion/fin', { body: 'pas un objet' })).toMatchObject({ status: 400, body: { code: 'invalid_body' } });
    expect(await t.call('GET', '/cles/connexion/debut')).toMatchObject({ status: 405 });
    expect(await t.count('security_sessions')).toBe(0);
    // Chaque refus est au journal, avec sa raison, jamais l'identifiant demandé.
    const codes = (await t.journal.all()).filter((e) => e.type === 'securite.refus').map((e) => (e.data as { code: string }).code);
    // Ce qui concerne quelqu'un est au journal ; un réseau ou un défi inconnus ne concernent personne et n'écrivent rien.
    expect(codes).toEqual(['bad_input', 'agent_inactive', 'no_device']);
    expect(JSON.stringify(await t.journal.all())).not.toContain('reseau-inconnu');
    // Au-delà de la limite d'une adresse : 429, et plus aucune ligne au journal.
    const flood = await setup({ limits: { perIp: 2, perNetwork: 100 } });
    const before = (await flood.journal.all()).length;
    for (let i = 0; i < 6; i += 1) await flood.call('POST', '/cles/connexion/debut', { body: { networkId: flood.network.id, role: 'partner', userId: 'p-1' }, ip: '192.0.2.9' });
    for (let i = 0; i < 6; i += 1) await flood.call('POST', '/cles/connexion/fin', { body: { challengeId: 'x' }, ip: '192.0.2.9' });
    expect((await flood.journal.all()).length).toBe(before + 2);
  });

  it('[R600] la connexion est limitée en débit, par adresse puis par réseau, chaque heure ; ni une adresse pleine ni des utilisateurs inventés ne bloquent les autres', async () => {
    const t = await setup({ limits: { perIp: 3, perNetwork: 4 } });
    const { device } = await t.enroll('alex', 8);
    await t.enroll('direction', 9);
    // Une même adresse : trois demandes, puis plus rien, pour personne.
    for (let i = 0; i < 3; i += 1) expect((await t.begin('alex', '203.0.113.7')).status).toBe(200);
    for (let i = 0; i < 5; i += 1) expect(await t.begin('direction', '203.0.113.7')).toMatchObject({ status: 429, body: { code: 'too_many_requests' } });
    // Des utilisateurs inventés ne prennent aucune place du réseau.
    for (let i = 0; i < 10; i += 1) expect((await t.call('POST', '/cles/connexion/debut', { body: { networkId: t.network.id, role: 'agent', userId: `invente-${i}` } })).status).toBe(403);
    // D'une autre adresse, Alex se connecte.
    const c = await t.begin('alex', '198.51.100.4');
    expect(c.status).toBe(200);
    expect((await t.call('POST', '/cles/connexion/fin', { body: await device.sign(c.body.data as Challenge), ip: '198.51.100.4' })).status).toBe(200);
    // Quatre défis émis : le réseau est plein ; une heure plus tard, tout se rouvre.
    expect(await t.begin('direction')).toMatchObject({ status: 429 });
    // Plein, le réseau ne range plus aucun défi.
    const challenges = await t.count('security_challenges');
    for (let i = 0; i < 3; i += 1) expect((await t.begin('alex')).status).toBe(429);
    expect(await t.count('security_challenges')).toBe(challenges);
    t.setClock(new Date(t.now().getTime() + 3_600_000));
    expect((await t.begin('alex', '203.0.113.7')).status).toBe(200);
    // L'adresse n'est jamais rangée en clair.
    expect(JSON.stringify(await t.db.all('SELECT scope FROM assistant_calls'))).not.toContain('203.0.113.7');
  });

  it('[R600] [R82] une clé d’API reste acceptée telle qu’aujourd’hui, avec ou sans site WebAuthn réglé', async () => {
    for (const site of [{ rpId: RP, origins: [ORIGIN] }, null]) {
      const t = await setup({ site });
      expect((await t.http('direction', 'GET', '/sante')).status).toBe(200);
      expect((await t.http('alex', 'POST', '/cles/enregistrement/debut')).status).toBe(site ? 200 : 503);
      expect((await t.call('POST', '/cles/enregistrement/debut', { bearer: 'test-cle-br06-inconnue-zzzzzzzzzzzzzzzzzzzzzz' })).status).toBe(401);
    }
  });

  it('[R600] sans site WebAuthn réglé, la connexion est fermée ; sans aucune clé ni site, l’API reste fermée', async () => {
    const closed = await setup({ site: null });
    expect(await closed.call('POST', '/cles/connexion/debut', { body: { networkId: closed.network.id, role: 'agent', userId: closed.alexId } })).toMatchObject({ status: 503, body: { code: 'cles_non_configurees' } });
    expect(await closed.count('assistant_calls')).toBe(0);
    const none = await setup({ site: null, apiKeys: false });
    expect(await none.call('GET', '/cles/appareils', { bearer: KEYS.direction })).toMatchObject({ status: 503, body: { code: 'keys_not_configured' } });
    // Sans clé d'API mais avec un site réglé : seule une séance ouvre, une clé inconnue est refusée.
    const sessionsOnly = await setup({ apiKeys: false });
    expect(await sessionsOnly.call('GET', '/cles/appareils', { bearer: KEYS.direction })).toMatchObject({ status: 401 });
  });
});
