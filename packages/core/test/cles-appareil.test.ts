import { describe, expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '../src/index.ts';
import { ExportAgent } from '../src/rapports/index.ts';
import { ClesAppareil, SENSITIVE_ACTIONS, type Challenge } from '../src/securite/index.ts';
import { derToRaw, fromBase64Url, sha256, toBase64Url, verifyAssertion } from '../src/securite/webauthn.ts';
import { FakeAuthenticator, ORIGIN, RP } from './appareil-simule.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Jeu de test inventé : un réseau, des agents, une direction, des appareils simulés.

it('[R600] base64url : un seul texte pour une suite d’octets, rien d’autre n’est lu', () => {
  const bytes = new Uint8Array([0, 1, 250, 251, 252]);
  expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
  expect(fromBase64Url('a+b/')).toBeNull();
  expect(fromBase64Url('AB==')).toBeNull();
  expect(fromBase64Url('AA')).toEqual(new Uint8Array([0]));
  expect(fromBase64Url('AB')).toBeNull(); // bits de fin non nuls
  expect(fromBase64Url('')).toBeNull();
  expect(fromBase64Url(42)).toBeNull();
});

it('[R600] une signature DER mal formée est refusée', () => {
  expect(derToRaw(new Uint8Array([0x30, 6, 0x02, 1, 1, 0x02, 1, 1]))).toEqual(new Uint8Array([...new Array(31).fill(0), 1, ...new Array(31).fill(0), 1]));
  expect(derToRaw(new Uint8Array([0x30, 6, 0x02, 1, 0x81, 0x02, 1, 1]))).toBeNull(); // négatif
  expect(derToRaw(new Uint8Array([0x30, 7, 0x02, 2, 0, 1, 0x02, 1, 1]))).toBeNull(); // zéro inutile
  expect(derToRaw(new Uint8Array([0x30, 6, 0x02, 1, 1, 0x02, 1, 1, 0]))).toBeNull(); // octet en trop
});

it('[R601] la liste des actions sensibles est fermée', () => {
  expect(SENSITIVE_ACTIONS).toEqual(['ajouter_appareil', 'approuver_appareil', 'export_complet', 'effacement', 'modifier_droits', 'modifier_rib', 'creer_cle_api']);
});

it('[R600] une origine en clair ou hors du site est refusée au réglage', () => {
  const db = {} as SqlDatabase;
  const journal = new SqlJournalStore(db);
  expect(() => new ClesAppareil(db, journal, { rpId: RP, origins: ['http://app.aimmo.test'] })).toThrow();
  expect(() => new ClesAppareil(db, journal, { rpId: RP, origins: ['https://ailleurs.test'] })).toThrow();
  expect(() => new ClesAppareil(db, journal, { rpId: RP, origins: [] })).toThrow();
  expect(() => new ClesAppareil(db, journal, { rpId: RP, origins: ['https://app.aimmo.test/'] })).toThrow();
});

describeWithSqlite('HX56 · clé d’accès par appareil et second facteur', () => {
  async function setup() {
    const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
    await applyMigrations(db, loadMigrations());
    let clock = new Date('2027-03-10T10:00:00.000Z');
    const now = () => clock;
    const advance = (ms: number) => (clock = new Date(clock.getTime() + ms));
    const journal = new SqlJournalStore(db);
    const store = new FicheClient(db, { now });
    const network = await store.createNetwork('Réseau test');
    const other = await store.createNetwork('Autre réseau');
    const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
    const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
    const cles = new ClesAppareil(db, journal, { rpId: RP, origins: [ORIGIN], now });
    const agent: Viewer = { role: 'agent', networkId: network.id, userId: alex.id };
    const agentSam: Viewer = { role: 'agent', networkId: network.id, userId: sam.id };
    const direction: Viewer = { role: 'direction', networkId: network.id, userId: 'dir-1' };
    const otherDirection: Viewer = { role: 'direction', networkId: other.id, userId: 'dir-2' };

    async function enroll(viewer: Viewer, seed: number, stepUpId?: string) {
      const device = await FakeAuthenticator.create(seed);
      const c = await cles.beginRegistration(viewer);
      if (!c.ok) throw new Error(c.code);
      const done = await cles.finishRegistration(viewer, { ...(await device.register(c.value)), ...(stepUpId ? { stepUpId } : {}) });
      if (!done.ok) throw new Error(done.code);
      return { device, record: done.value };
    }
    async function login(viewer: Viewer, device: FakeAuthenticator) {
      const c = await cles.beginLogin(viewer.networkId, viewer.role, viewer.userId);
      if (!c.ok) return c;
      return cles.finishLogin(await device.sign(c.value));
    }
    async function stepUp(viewer: Viewer, device: FakeAuthenticator, action: string, subject: string) {
      const c = await cles.beginStepUp(viewer, action, subject);
      if (!c.ok) throw new Error(c.code);
      const p = await cles.finishStepUp(viewer, await device.sign(c.value));
      if (!p.ok) throw new Error(p.code);
      return p.value.stepUpId;
    }
    return { db, cles, journal, agent, agentSam, direction, otherDirection, enroll, login, stepUp, advance, alex };
  }

  it('[R600] une clé par appareil : la première est active, l’appareil se connecte, la séance dit qui il est', async () => {
    const { cles, agent, enroll, login } = await setup();
    const { device, record } = await enroll(agent, 1);
    expect(record.status).toBe('actif');
    const session = await login(agent, device);
    expect(session.ok).toBe(true);
    if (!session.ok) return;
    expect(await cles.authenticate(session.value.token)).toEqual({ viewer: agent, deviceId: record.id });
    expect(await cles.authenticate('jeton-inconnu')).toBeNull();
  });

  it('[R600] un appareil retiré par la direction ne se connecte plus, et sa séance ouverte cesse à l’instant', async () => {
    const { cles, agent, direction, enroll, login } = await setup();
    const { device, record } = await enroll(agent, 1);
    const session = await login(agent, device);
    if (!session.ok) throw new Error(session.code);
    const revoked = await cles.revokeDevice(direction, record.id);
    expect(revoked.ok && revoked.value.status).toBe('retire');
    expect(await cles.authenticate(session.value.token)).toBeNull();
    expect(await login(agent, device)).toMatchObject({ ok: false, rule: 'R600', code: 'no_device' });
    // Même avec un défi pris avant le retrait.
    const second = await enroll(agent, 2).catch(() => null);
    expect(second?.record.status).toBe('en_attente');
  });

  it('[R600] un défi pris avant le retrait ne sert plus après', async () => {
    const { cles, agent, direction, enroll } = await setup();
    const { device, record } = await enroll(agent, 1);
    const c = await cles.beginLogin(agent.networkId, 'agent', agent.userId);
    if (!c.ok) throw new Error(c.code);
    await cles.revokeDevice(direction, record.id);
    expect(await cles.finishLogin(await device.sign(c.value))).toMatchObject({ ok: false, code: 'device_revoked' });
  });

  it('[R600] la direction d’un autre réseau ne retire rien, un agent ne retire que ses clés, une clé retirée le reste', async () => {
    const { cles, db, agent, agentSam, otherDirection, enroll } = await setup();
    const { record } = await enroll(agent, 1);
    expect(await cles.revokeDevice(otherDirection, record.id)).toMatchObject({ ok: false, code: 'other_network' });
    expect(await cles.revokeDevice(agentSam, record.id)).toMatchObject({ ok: false, code: 'role' });
    expect((await cles.revokeDevice(agent, record.id)).ok).toBe(true);
    expect(await cles.revokeDevice(agent, record.id)).toMatchObject({ ok: false, code: 'already_revoked' });
    await expect(db.run("UPDATE security_devices SET status = 'actif', revoked_at = NULL, revoked_by = NULL WHERE id = ?", [record.id])).rejects.toThrow();
    await expect(db.run('DELETE FROM security_devices WHERE id = ?', [record.id])).rejects.toThrow();
  });

  it('[R600] une clé suivante attend la direction, qui l’accepte par la preuve de sa propre clé', async () => {
    const { cles, agent, direction, enroll, login, stepUp } = await setup();
    await enroll(agent, 1);
    const { device: second, record } = await enroll(agent, 2);
    expect(record.status).toBe('en_attente');
    expect(await login(agent, second)).toMatchObject({ ok: false });
    expect(await cles.approveDevice(direction, record.id, undefined)).toMatchObject({ ok: false, rule: 'R601', code: 'second_factor_required' });
    const dir = await enroll(direction, 9);
    const proof = await stepUp(direction, dir.device, 'approuver_appareil', `device:${record.id}`);
    const approved = await cles.approveDevice(direction, record.id, proof);
    expect(approved.ok && approved.value.status).toBe('actif');
    expect((await login(agent, second)).ok).toBe(true);
    const list = await cles.listDevices(direction);
    expect(list.ok && list.value.map((d) => d.status).sort()).toEqual(['actif', 'actif', 'actif']);
    expect(JSON.stringify(list)).not.toMatch(/publicKey|public_key|credential/);
    expect(await cles.listDevices(agent)).toMatchObject({ ok: false, code: 'role' });
  });

  it('[R600] une clé suivante est active d’emblée avec la preuve « ajouter un appareil » d’une clé active', async () => {
    const { agent, enroll, stepUp } = await setup();
    const first = await enroll(agent, 1);
    const proof = await stepUp(agent, first.device, 'ajouter_appareil', `user:${agent.userId}`);
    const { record } = await enroll(agent, 2, proof);
    expect(record.status).toBe('actif');
  });

  it('[R600] l’empreinte ou le visage est exigé, l’origine, le site, le défi et le type exacts', async () => {
    const { cles, agent, enroll } = await setup();
    const { device } = await enroll(agent, 1);
    const cases: [Parameters<FakeAuthenticator['sign']>[1], string][] = [
      [{ flags: 0x01 }, 'no_user_verification'],
      [{ flags: 0x04 }, 'no_user_presence'],
      [{ origin: 'https://faux.test' }, 'wrong_origin'],
      [{ rpId: 'faux.test' }, 'wrong_rp'],
      [{ challenge: 'AAAA' }, 'wrong_challenge'],
      [{ type: 'webauthn.create' }, 'wrong_type'],
    ];
    for (const [over, code] of cases) {
      const c = await cles.beginLogin(agent.networkId, 'agent', agent.userId);
      if (!c.ok) throw new Error(c.code);
      expect(await cles.finishLogin(await device.sign(c.value, over))).toMatchObject({ ok: false, code });
    }
    // Une clé enregistrée sans vérification de l’utilisateur ne l’est pas.
    const weak = await FakeAuthenticator.create(3, 0x01);
    const c = await cles.beginRegistration(agent);
    if (!c.ok) throw new Error(c.code);
    expect(await cles.finishRegistration(agent, await weak.register(c.value))).toMatchObject({ ok: false, code: 'no_user_verification' });
  });

  it('[R600] une signature d’une autre clé, un défi rejoué ou échu, un compteur qui ne monte pas sont refusés', async () => {
    const { cles, agent, enroll, advance } = await setup();
    const { device } = await enroll(agent, 1);
    const impostor = await FakeAuthenticator.create(1); // même identifiant, autre clé privée
    let c = await cles.beginLogin(agent.networkId, 'agent', agent.userId);
    if (!c.ok) throw new Error(c.code);
    expect(await cles.finishLogin(await impostor.sign(c.value))).toMatchObject({ ok: false, code: 'bad_signature' });
    // Le défi raté est usé : on ne réessaie pas.
    expect(await cles.finishLogin(await device.sign(c.value))).toMatchObject({ ok: false, code: 'challenge_used' });
    c = await cles.beginLogin(agent.networkId, 'agent', agent.userId);
    if (!c.ok) throw new Error(c.code);
    const signed = await device.sign(c.value);
    expect((await cles.finishLogin(signed)).ok).toBe(true);
    expect(await cles.finishLogin(signed)).toMatchObject({ ok: false, code: 'challenge_used' });
    c = await cles.beginLogin(agent.networkId, 'agent', agent.userId);
    if (!c.ok) throw new Error(c.code);
    advance(5 * 60_000);
    expect(await cles.finishLogin(await device.sign(c.value))).toMatchObject({ ok: false, code: 'challenge_expired' });
    c = await cles.beginLogin(agent.networkId, 'agent', agent.userId);
    if (!c.ok) throw new Error(c.code);
    device.count = 1; // une copie de la clé, en retard sur l’original
    expect(await cles.finishLogin(await device.sign(c.value, { keepCount: true }))).toMatchObject({ ok: false, code: 'clone_suspect' });
  });

  it('[R600] une séance expire après 12 heures ; un agent parti ne se connecte plus et sa séance cesse', async () => {
    const { cles, db, agent, enroll, login, advance, alex } = await setup();
    const { device } = await enroll(agent, 1);
    const s1 = await login(agent, device);
    if (!s1.ok) throw new Error(s1.code);
    advance(12 * 3_600_000);
    expect(await cles.authenticate(s1.value.token)).toBeNull();
    const s2 = await login(agent, device);
    if (!s2.ok) throw new Error(s2.code);
    await db.run("UPDATE agents SET status = 'left' WHERE id = ?", [alex.id]);
    expect(await cles.authenticate(s2.value.token)).toBeNull();
    expect(await cles.beginLogin(agent.networkId, 'agent', agent.userId)).toMatchObject({ ok: false, code: 'agent_inactive' });
  });

  it('[R600] seule l’empreinte du jeton de séance est rangée', async () => {
    const { db, agent, enroll, login } = await setup();
    const { device } = await enroll(agent, 1);
    const s = await login(agent, device);
    if (!s.ok) throw new Error(s.code);
    const rows = await db.all<Record<string, unknown>>('SELECT * FROM security_sessions');
    expect(JSON.stringify(rows)).not.toContain(s.value.token);
  });

  it('[R601] une action sensible exige un second facteur, pour cette action et cet objet, une fois, dans les cinq minutes', async () => {
    const { cles, agent, agentSam, enroll, stepUp, advance } = await setup();
    const { device } = await enroll(agent, 1);
    const subject = `user:${agent.userId}`;
    expect(await cles.requireSecondFactor(agent, 'export_complet', subject, undefined)).toMatchObject({ ok: false, rule: 'R601', code: 'second_factor_required' });
    const proof = await stepUp(agent, device, 'export_complet', subject);
    expect(await cles.requireSecondFactor(agent, 'effacement', subject, proof)).toMatchObject({ ok: false, code: 'other_action' });
    expect(await cles.requireSecondFactor(agent, 'export_complet', 'user:autre', proof)).toMatchObject({ ok: false, code: 'other_action' });
    expect(await cles.requireSecondFactor(agentSam, 'export_complet', subject, proof)).toMatchObject({ ok: false, code: 'second_factor_required' });
    expect((await cles.requireSecondFactor(agent, 'export_complet', subject, proof)).ok).toBe(true);
    expect(await cles.requireSecondFactor(agent, 'export_complet', subject, proof)).toMatchObject({ ok: false, code: 'already_used' });
    const late = await stepUp(agent, device, 'export_complet', subject);
    advance(5 * 60_000);
    expect(await cles.requireSecondFactor(agent, 'export_complet', subject, late)).toMatchObject({ ok: false, code: 'expired' });
  });

  it('[R601] l’export complet de l’agent exige le second facteur, fait pour lui seul', async () => {
    const { cles, db, journal, agent, enroll, stepUp } = await setup();
    const exports = new ExportAgent(db, journal, cles);
    const { device } = await enroll(agent, 1);
    expect(await exports.make(agent)).toMatchObject({ ok: false, rule: 'R601', code: 'second_factor_required' });
    const wrong = await stepUp(agent, device, 'effacement', `agent:${agent.userId}`);
    expect(await exports.make(agent, wrong)).toMatchObject({ ok: false, rule: 'R601', code: 'other_action' });
    const proof = await stepUp(agent, device, 'export_complet', `agent:${agent.userId}`);
    expect((await exports.make(agent, proof)).ok).toBe(true);
    expect(await exports.make(agent, proof)).toMatchObject({ ok: false, rule: 'R601', code: 'already_used' });
    expect(await db.first<{ n: number }>('SELECT count(*) AS n FROM agent_exports')).toEqual({ n: 1 });
  });

  it('[R601] une clé retirée pendant l’usage de sa preuve : la preuve ne passe pas', async () => {
    const { db, journal, agent, direction, enroll, stepUp } = await setup();
    const { device, record } = await enroll(agent, 1);
    const proof = await stepUp(agent, device, 'export_complet', `agent:${agent.userId}`);
    let cles2: ClesAppareil;
    const hooked = {
      ...journal,
      all: () => journal.all(),
      last: () => journal.last(),
      bySubject: (s: string) => journal.bySubject(s),
      byPeriod: (a: string, b: string) => journal.byPeriod(a, b),
      append: async (e: Parameters<typeof journal.append>[0]) => {
        await journal.append(e);
        if (e.type === 'securite.second_facteur.utilise') await cles2.revokeDevice(direction, record.id);
      },
    };
    cles2 = new ClesAppareil(db, hooked, { rpId: RP, origins: [ORIGIN], now: () => new Date('2027-03-10T10:00:00.000Z') });
    expect(await cles2.requireSecondFactor(agent, 'export_complet', `agent:${agent.userId}`, proof)).toMatchObject({ ok: false, code: 'device_revoked' });
    expect(await db.first('SELECT used_at FROM security_step_ups WHERE id = ?', [proof])).toEqual({ used_at: null });
  });

  it('[R601] une preuve qui échoit pendant son usage ne passe pas', async () => {
    const { db, journal, agent, enroll, stepUp } = await setup();
    const { device } = await enroll(agent, 1);
    const proof = await stepUp(agent, device, 'export_complet', `agent:${agent.userId}`);
    let clock = new Date('2027-03-10T10:04:59.000Z');
    const hooked = {
      all: () => journal.all(),
      last: () => journal.last(),
      bySubject: (s: string) => journal.bySubject(s),
      byPeriod: (a: string, b: string) => journal.byPeriod(a, b),
      append: async (e: Parameters<typeof journal.append>[0]) => {
        await journal.append(e);
        if (e.type === 'securite.second_facteur.utilise') clock = new Date('2027-03-10T10:05:01.000Z');
      },
    };
    const cles2 = new ClesAppareil(db, hooked, { rpId: RP, origins: [ORIGIN], now: () => clock });
    expect(await cles2.requireSecondFactor(agent, 'export_complet', `agent:${agent.userId}`, proof)).toMatchObject({ ok: false, code: 'expired' });
    expect(await db.first('SELECT used_at FROM security_step_ups WHERE id = ?', [proof])).toEqual({ used_at: null });
  });

  it('[R600] deux enregistrements simultanés ne font pas deux premières clés', async () => {
    const { cles, db, agent } = await setup();
    const a = await FakeAuthenticator.create(1);
    const b = await FakeAuthenticator.create(2);
    const ca = await cles.beginRegistration(agent);
    const cb = await cles.beginRegistration(agent);
    if (!ca.ok || !cb.ok) throw new Error('défi');
    const [ra, rb] = await Promise.all([cles.finishRegistration(agent, await a.register(ca.value)), cles.finishRegistration(agent, await b.register(cb.value))]);
    expect([ra.ok && ra.value.status, rb.ok && rb.value.status].sort()).toEqual(['actif', 'en_attente']);
    await expect(
      db.run(
        "INSERT INTO security_devices (id, network_id, user_role, user_id, credential_id, public_key, alg, sign_count, label, status, created_at, approved_at, approved_by) SELECT 'x', network_id, user_role, user_id, 'c9', 'k', -7, 0, 'Tel', 'actif', 't', 't', 'premiere_cle' FROM security_devices LIMIT 1",
      ),
    ).rejects.toThrow();
  });

  it('[R601] une preuve faite par une clé retirée depuis ne vaut plus ; un défi de connexion ne sert pas de preuve', async () => {
    const { cles, agent, direction, enroll, stepUp } = await setup();
    const { device, record } = await enroll(agent, 1);
    const subject = `user:${agent.userId}`;
    const proof = await stepUp(agent, device, 'modifier_rib', subject);
    await cles.revokeDevice(direction, record.id);
    expect(await cles.requireSecondFactor(agent, 'modifier_rib', subject, proof)).toMatchObject({ ok: false, code: 'device_revoked' });
    expect(await cles.beginStepUp(agent, 'modifier_rib', subject)).toMatchObject({ ok: false, code: 'no_device' });
    expect(await cles.beginStepUp(agent, 'tout_faire', subject)).toMatchObject({ ok: false, code: 'bad_input' });
  });

  it('[R601] un défi de connexion ne vaut pas preuve, et l’inverse', async () => {
    const { cles, agent, enroll } = await setup();
    const { device } = await enroll(agent, 1);
    const login = await cles.beginLogin(agent.networkId, 'agent', agent.userId);
    if (!login.ok) throw new Error(login.code);
    expect(await cles.finishStepUp(agent, await device.sign(login.value))).toMatchObject({ ok: false, code: 'unknown_challenge' });
    const step = await cles.beginStepUp(agent, 'effacement', 'person:p1');
    if (!step.ok) throw new Error(step.code);
    expect(await cles.finishLogin(await device.sign(step.value))).toMatchObject({ ok: false, code: 'unknown_challenge' });
  });

  it('[R13] le journal note chaque geste, sans clé ni jeton ni nom d’appareil', async () => {
    const { journal, agent, direction, enroll, login, cles } = await setup();
    const { device, record } = await enroll(agent, 1);
    const s = await login(agent, device);
    if (!s.ok) throw new Error(s.code);
    await cles.revokeDevice(direction, record.id);
    const entries = await journal.all();
    const types = entries.map((e) => e.type);
    expect(types).toContain('securite.cle.rangee');
    expect(types).toContain('securite.connexion');
    expect(types).toContain('securite.cle.retiree');
    const text = JSON.stringify(entries);
    expect(text).not.toContain(s.value.token);
    expect(text).not.toContain(toBase64Url(device.credentialId));
    expect(text).not.toContain('Téléphone');
  });

  it('[R600] la base refuse une clé née retirée, un compteur qui descend et une clé publique changée', async () => {
    const { db, agent, enroll } = await setup();
    const { record } = await enroll(agent, 1);
    await expect(db.run('UPDATE security_devices SET sign_count = sign_count - 1 WHERE id = ?', [record.id])).rejects.toThrow();
    await db.run('UPDATE security_devices SET sign_count = 5 WHERE id = ?', [record.id]);
    await expect(db.run('UPDATE security_devices SET sign_count = 4 WHERE id = ?', [record.id])).rejects.toThrow();
    await expect(db.run("UPDATE security_devices SET public_key = 'AAAA' WHERE id = ?", [record.id])).rejects.toThrow();
    await expect(
      db.run(
        "INSERT INTO security_devices (id, network_id, user_role, user_id, credential_id, public_key, alg, sign_count, label, status, created_at, revoked_at, revoked_by) SELECT 'x', network_id, 'agent', 'u', 'c2', 'k', -7, 0, 'Tel', 'retire', 't', 't', 'd' FROM security_devices LIMIT 1",
      ),
    ).rejects.toThrow();
    await expect(db.run('DELETE FROM security_challenges')).rejects.toThrow();
  });
});

it('[R600] vérifie une vraie signature WebAuthn ES256, et rien d’autre', async () => {
  const device = await FakeAuthenticator.create(4);
  const c: Challenge = { challengeId: 'c', challenge: 'Q0hBTExFTkdF', rpId: RP, expiresAt: '', credentialIds: [] };
  const a = await device.sign(c);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', device.keys.publicKey));
  const expected = { type: 'webauthn.get' as const, challenge: c.challenge, origins: [ORIGIN], rpId: RP };
  const input = { clientDataJSON: fromBase64Url(a.clientDataJSON)!, authenticatorData: fromBase64Url(a.authenticatorData)!, signature: fromBase64Url(a.signature)! };
  expect(await verifyAssertion(input, spki, expected)).toEqual({ ok: true, value: { signCount: 1 } });
  const tampered = new Uint8Array(input.authenticatorData);
  tampered[36] = 9;
  expect(await verifyAssertion({ ...input, authenticatorData: tampered }, spki, expected)).toMatchObject({ ok: false, code: 'bad_signature' });
  expect(await verifyAssertion(input, new Uint8Array([1, 2, 3]), expected)).toMatchObject({ ok: false, code: 'bad_key' });
});
