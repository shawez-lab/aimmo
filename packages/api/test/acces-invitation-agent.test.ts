import { expect, it } from 'vitest';
import { FicheClient } from '@aimmo/core';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { exchangeInvitation, invitedKeys, inviteAgent } from '../src/acces.ts';
import type { SqlDatabase } from '@aimmo/core';
import type { Challenge } from '../../core/src/securite/index.ts';
import { FakeAuthenticator, ORIGIN, RP } from '../../core/test/appareil-simule.ts';
import { setupAnnonce } from '../../core/test/annonces-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// AU023 · Réseaux, agents, appareils simulés et clés inventés.
const DIRECTION_KEY = 'test-cle-au023-direction-dddddddddddddddddddddd';
const ALEX_SECRET_KEY = 'test-cle-au023-alex-secret-aaaaaaaaaaaaaaaaaaaa';
type Body = { ok: boolean; data?: any; rule?: string | null; code?: string; error?: { code: string } };

async function setup() {
  const t = await setupAnnonce();
  const store = new FicheClient(t.db);
  const other = await store.createNetwork('Autre réseau');
  const stranger = await store.createAgent({ networkId: other.id, firstName: 'Lou', lastName: 'Ailleurs' });
  const apiKeys = JSON.stringify([
    { sha256: await sha256Hex(DIRECTION_KEY), role: 'direction', userId: t.direction.userId, networkId: t.network.id },
    { sha256: await sha256Hex(ALEX_SECRET_KEY), role: 'agent', userId: t.alexId, networkId: t.network.id },
  ]);
  const config: ApiConfig = { db: t.db, apiKeys, mode: 'essai', now: t.now, cles: { rpId: RP, origins: [ORIGIN] } };
  const call = async (method: string, path: string, init: { bearer?: string; body?: unknown } = {}): Promise<{ status: number; body: Body }> => {
    const headers: Record<string, string> = {};
    if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    const r = await handleRequest(new Request(`https://aimmo-api.example.test/v1${path}`, { method, headers, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) }), config);
    return { status: r.status, body: (await r.json()) as Body };
  };
  const enroll = async (bearer: string, seed: number) => {
    const device = await FakeAuthenticator.create(seed);
    const c = await call('POST', '/cles/enregistrement/debut', { bearer });
    const done = await call('POST', '/cles/enregistrement/fin', { bearer, body: await device.register(c.body.data as Challenge) });
    if (done.status !== 200) throw new Error(`enregistrement ${done.body.code}`);
    return { device, id: done.body.data.id as string, status: done.body.data.status as string };
  };
  const prove = async (bearer: string, device: FakeAuthenticator, action: string, subject: string) => {
    const c = await call('POST', '/cles/preuve/debut', { bearer, body: { action, subject } });
    const p = await call('POST', '/cles/preuve/fin', { bearer, body: await device.sign(c.body.data as Challenge) });
    return p.body.data.stepUpId as string;
  };
  const directionDevice = (await enroll(DIRECTION_KEY, 9)).device;
  /** La direction invite un agent, sur la preuve de sa clé pour cet agent. */
  const invite = async (userId: string, retirerAnciens: boolean) => {
    const stepUpId = await prove(DIRECTION_KEY, directionDevice, 'modifier_droits', `agent:${userId}`);
    return call('POST', '/cles/invitations', { bearer: DIRECTION_KEY, body: { userId, stepUpId, retirerAnciens } });
  };
  /** L'agent ouvre le lien et appuie sur « Entrer sur ce téléphone » : l'application reçoit sa clé, il ne la voit pas. */
  const open = async (lien: string) => {
    const jeton = lien.split('#invitation=')[1];
    const r = await call('POST', '/acces/invitation', { body: { jeton } });
    return { status: r.status, key: r.body.data?.cles?.[0]?.cle as string | undefined, code: r.body.error?.code };
  };
  /** La connexion par la clé de l'appareil, avec l'identité que l'appareil a retenue. */
  const login = async (who: { networkId: string; role: string; userId: string }, device: FakeAuthenticator) => {
    const c = await call('POST', '/cles/connexion/debut', { body: who });
    if (c.status !== 200) return c;
    return call('POST', '/cles/connexion/fin', { body: { ...(await device.sign(c.body.data as Challenge)) } });
  };
  return { ...t, other, stranger, call, enroll, prove, directionDevice, invite, open, login };
}

describeWithSqlite('AU023 · une invitation nominative mène à une connexion par clé d’appareil', () => {
  it('[R600] constat : sans lien de la direction, aucun agent ne démarre sans qu’on lui remette une clé personnelle', async () => {
    const t = await setup();
    // Avant AU023, aucune route ne préparait le lien d'un agent : seul le travail GitHub de Z02 le faisait, pour Shawez.
    expect((await t.call('GET', '/cles/invitations/agents', { bearer: DIRECTION_KEY })).status).toBe(200);
    expect((await t.invite(t.alexId, false)).status).toBe(200);
  });

  it('[R600] [R601] [R13] lien nominatif → application ouverte → clé de l’appareil → connexion par l’appareil, sans secret tapé', async () => {
    const t = await setup();
    const agents = await t.call('GET', '/cles/invitations/agents', { bearer: DIRECTION_KEY });
    expect(agents.body.data).toEqual([
      { id: t.alexId, name: 'Alex Agent' },
      { id: t.sam.userId, name: 'Sam Agent' },
    ]);
    const made = await t.invite(t.sam.userId, false);
    expect(made).toMatchObject({ status: 200, body: { ok: true, data: { keysRevoked: 0, devicesRevoked: 0 } } });
    const lien = made.body.data.lien as string;
    expect(lien).toMatch(/^\/app\/#invitation=[A-Za-z0-9_-]{43}$/);
    expect(made.body.data.expiresAt).toBe(new Date(t.now().getTime() + 24 * 3600 * 1000).toISOString());
    const jeton = lien.split('=')[1]!;
    // Le jeton n'est ni en base (seulement son empreinte) ni au journal [R13].
    expect(JSON.stringify(await t.db.all('SELECT * FROM access_invitations'))).not.toContain(jeton);
    expect(JSON.stringify(await t.db.all('SELECT * FROM access_invitations'))).toContain(await sha256Hex(jeton));
    const events = await t.journal.all();
    expect(JSON.stringify(events)).not.toContain(jeton);
    expect(events.find((e) => e.type === 'acces.invitation_creee')).toMatchObject({ actor: `direction:${t.direction.userId}`, subject: `agent:${t.sam.userId}` });

    const opened = await t.open(lien);
    expect(opened.status).toBe(200);
    // Le lien ne sert qu'une fois.
    expect((await t.open(lien)).code).toBe('invitation_used');
    const appKey = opened.key!;
    expect((await t.call('GET', '/moi', { bearer: appKey })).body).toMatchObject({ ok: true, data: { role: 'agent', firstName: 'Sam' } });
    // L'appareil retient qui il sert, rien de secret, puis range sa clé : la première sert tout de suite.
    const who = (await t.call('GET', '/cles/identite', { bearer: appKey })).body.data;
    expect(who).toEqual({ networkId: t.network.id, role: 'agent', userId: t.sam.userId });
    const { device, status } = await t.enroll(appKey, 21);
    expect(status).toBe('actif');
    // Le lendemain, la séance de l'appareil suffit : ni clé, ni lien.
    const session = await t.login(who, device);
    expect(session.status).toBe(200);
    expect((await t.call('GET', '/moi', { bearer: session.body.data.token })).body).toMatchObject({ ok: true, data: { firstName: 'Sam' } });
  });

  it('[R601] [R16] sans preuve de la clé de la direction, pour un autre agent, un agent parti ou d’un autre réseau : rien n’est préparé', async () => {
    const t = await setup();
    const before = Number((await t.db.first<{ n: number }>('SELECT count(*) AS n FROM access_invitations'))?.n);
    expect(await t.call('POST', '/cles/invitations', { bearer: DIRECTION_KEY, body: { userId: t.alexId, retirerAnciens: false } })).toMatchObject({ status: 409, body: { rule: 'R601', code: 'second_factor_required' } });
    const forSam = await t.prove(DIRECTION_KEY, t.directionDevice, 'modifier_droits', `agent:${t.sam.userId}`);
    expect((await t.call('POST', '/cles/invitations', { bearer: DIRECTION_KEY, body: { userId: t.alexId, stepUpId: forSam, retirerAnciens: false } })).body.rule).toBe('R601');
    expect(await t.invite(t.stranger.id, false)).toMatchObject({ status: 404, body: { rule: 'R16', code: 'unknown' } });
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.sam.userId]);
    expect((await t.invite(t.sam.userId, false)).status).toBe(404);
    // Un agent ne s'invite pas lui-même, ni ne lit la liste.
    expect((await t.call('POST', '/cles/invitations', { bearer: ALEX_SECRET_KEY, body: { userId: t.alexId, retirerAnciens: false } })).status).toBe(403);
    expect((await t.call('GET', '/cles/invitations/agents', { bearer: ALEX_SECRET_KEY })).status).toBe(403);
    expect((await t.call('POST', '/cles/invitations', { bearer: DIRECTION_KEY, body: { userId: t.alexId, retirerAnciens: 'oui' } })).body.code).toBe('bad_input');
    expect((await t.call('POST', '/cles/invitations', { bearer: DIRECTION_KEY, body: { userId: t.alexId, retirerAnciens: false, role: 'direction' } })).body.code).toBe('unknown_field');
    expect(Number((await t.db.first<{ n: number }>('SELECT count(*) AS n FROM access_invitations'))?.n)).toBe(before);
  });

  it('[R600] appareil perdu : le nouveau lien coupe les anciens accès de l’agent ; la clé neuve attend l’accord de la direction', async () => {
    const t = await setup();
    // Premier téléphone de Sam : son lien, sa clé d'application, la clé de l'appareil.
    const first = await t.open((await t.invite(t.sam.userId, false)).body.data.lien);
    const lost = await t.enroll(first.key!, 31);
    const who = { networkId: t.network.id, role: 'agent', userId: t.sam.userId };
    // Un second lien préparé mais pas encore ouvert.
    const unused = (await t.invite(t.sam.userId, false)).body.data.lien as string;
    // Sans « appareil perdu », l'ancien accès reste.
    expect((await t.call('GET', '/moi', { bearer: first.key! })).status).toBe(200);

    const recovery = await t.invite(t.sam.userId, true);
    expect(recovery).toMatchObject({ status: 200, body: { data: { keysRevoked: 1, linksVoided: 1, devicesRevoked: 1 } } });
    // Le téléphone perdu n'ouvre plus rien : ni sa clé d'application, ni sa clé d'appareil, ni le lien resté de côté.
    expect((await t.call('GET', '/moi', { bearer: first.key! })).status).toBe(401);
    expect((await t.login(who, lost.device)).status).toBe(403);
    expect((await t.open(unused)).code).toBe('invitation_used');
    // Les autres agents et la clé du secret d'Alex ne bougent pas.
    expect((await t.call('GET', '/moi', { bearer: ALEX_SECRET_KEY })).status).toBe(200);

    // Le téléphone neuf : le nouveau lien, puis la clé de l'appareil, en attente jusqu'à l'accord de la direction.
    const fresh = await t.open(recovery.body.data.lien);
    const next = await t.enroll(fresh.key!, 32);
    expect(next.status).toBe('en_attente');
    expect((await t.login(who, next.device)).status).toBe(403);
    const ok = await t.prove(DIRECTION_KEY, t.directionDevice, 'approuver_appareil', `device:${next.id}`);
    expect((await t.call('POST', `/cles/appareils/${next.id}/accord`, { bearer: DIRECTION_KEY, body: { stepUpId: ok } })).status).toBe(200);
    expect((await t.login(who, next.device)).status).toBe(200);
    // Les clés retirées restent, datées : rien n'est effacé.
    expect(await t.db.all("SELECT status FROM security_devices WHERE user_id = ? ORDER BY created_at, id", [t.sam.userId])).toEqual(expect.arrayContaining([{ status: 'retire' }, { status: 'actif' }]));
    const event = (await t.journal.all()).filter((e) => e.type === 'acces.invitation_creee').at(-1);
    expect(event?.data).toMatchObject({ retirerAnciens: true, keysRevoked: 1, linksVoided: 1, devicesRevoked: 1 });
  });

  it('[R600] appareil perdu : un ancien lien ouvert pendant le recours n’échappe jamais au retrait', async () => {
    for (const moment of ['après la lecture des liens', 'avant le retrait des clés']) {
      const t = await setup();
      const old = ((await t.invite(t.sam.userId, false)).body.data.lien as string).split('=')[1]!;
      let fired = false;
      // Le téléphone perdu ouvre son lien au pire moment du recours.
      const db = new Proxy(t.db, {
        get(target, prop) {
          const real = (target as unknown as Record<string | symbol, unknown>)[prop];
          if (typeof real !== 'function') return real;
          return async (sql: string, params?: unknown[]) => {
            const hit = moment === 'avant le retrait des clés' ? /^UPDATE access_keys SET revoked_at/.test(sql) : /^SELECT id, grants FROM access_invitations/.test(sql);
            if (hit && !fired) {
              fired = true;
              if (moment === 'avant le retrait des clés') await exchangeInvitation(t.db, old, t.now());
              else {
                const r = await (real as (...a: unknown[]) => Promise<unknown>).call(target, sql, params);
                await exchangeInvitation(t.db, old, t.now());
                return r;
              }
            }
            return (real as (...a: unknown[]) => Promise<unknown>).call(target, sql, params);
          };
        },
      }) as SqlDatabase;
      const v = { networkId: t.network.id, role: 'direction', userId: t.direction.userId };
      const done = await inviteAgent(db, t.journal, v, { userId: t.sam.userId, stepUpId: 'p', retirerAnciens: true }, async () => ({ ok: true }), async () => true, t.now());
      expect(done.ok).toBe(true);
      expect(fired).toBe(true);
      expect((await invitedKeys(t.db)).filter((k) => k.userId === t.sam.userId)).toEqual([]);
    }
  });
});
