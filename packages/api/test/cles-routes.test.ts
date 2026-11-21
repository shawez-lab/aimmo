import { expect, it } from 'vitest';
import { FicheClient } from '@aimmo/core';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { readClesConfig } from '../src/cles.ts';
import { sha256Hex } from '../src/index.ts';
import type { Challenge } from '../../core/src/securite/index.ts';
import { FakeAuthenticator, ORIGIN, RP } from '../../core/test/appareil-simule.ts';
import { setupAnnonce } from '../../core/test/annonces-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// Réseaux, agents, appareils simulés et clés inventés.
const KEYS = {
  alex: 'test-cle-br05-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  sam: 'test-cle-br05-sam-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  direction: 'test-cle-br05-direction-cccccccccccccccccccccc',
  conformite: 'test-cle-br05-conformite-ddddddddddddddddddddd',
  partenaire: 'test-cle-br05-partenaire-eeeeeeeeeeeeeeeeeeeee',
  autre: 'test-cle-br05-autre-reseau-fffffffffffffffffffff',
};
type Who = keyof typeof KEYS;
type Body = { ok: boolean; data?: any; rule?: string; code?: string };

async function setup(site: ApiConfig['cles'] = { rpId: RP, origins: [ORIGIN] }) {
  const t = await setupAnnonce();
  const other = (await new FicheClient(t.db).createNetwork('Autre réseau')).id;
  const ids: Record<Who, { role: string; userId: string; networkId: string }> = {
    alex: { role: 'agent', userId: t.alexId, networkId: t.network.id },
    sam: { role: 'agent', userId: t.sam.userId, networkId: t.network.id },
    direction: { role: 'direction', userId: t.direction.userId, networkId: t.network.id },
    conformite: { role: 'compliance', userId: 'conformite-1', networkId: t.network.id },
    partenaire: { role: 'partner', userId: 'partenaire-1', networkId: t.network.id },
    autre: { role: 'direction', userId: 'dir-9', networkId: other },
  };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), expiresOn: "2099-12-31", ...ids[w] }))));
  const config: ApiConfig = { db: t.db, apiKeys, mode: 'essai', now: t.now, cles: site };
  const http = async (who: Who, method: string, path: string, body?: unknown): Promise<{ status: number; body: Body }> => {
    const headers: Record<string, string> = { authorization: `Bearer ${KEYS[who]}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await handleRequest(new Request(`https://aimmo-api.example.test/v1${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), config);
    return { status: r.status, body: (await r.json()) as Body };
  };
  /** La clé d'un appareil simulé, enregistrée par les routes. */
  const enroll = async (who: Who, seed: number, stepUpId?: string) => {
    const device = await FakeAuthenticator.create(seed);
    const c = await http(who, 'POST', '/cles/enregistrement/debut');
    if (c.status !== 200) throw new Error(`début ${c.body.code}`);
    const done = await http(who, 'POST', '/cles/enregistrement/fin', { ...(await device.register(c.body.data as Challenge)), ...(stepUpId ? { stepUpId } : {}) });
    return { device, done };
  };
  /** Une preuve d'action sensible, faite par les routes. */
  const stepUp = async (who: Who, device: FakeAuthenticator, action: string, subject: string) => {
    const c = await http(who, 'POST', '/cles/preuve/debut', { action, subject });
    if (c.status !== 200) throw new Error(`preuve ${c.body.code}`);
    const p = await http(who, 'POST', '/cles/preuve/fin', await device.sign(c.body.data as Challenge));
    if (p.status !== 200) throw new Error(`preuve ${p.body.code}`);
    return p.body.data.stepUpId as string;
  };
  const refusals = async () => (await t.journal.all()).filter((e) => e.type === 'acces.refuse');
  const count = async (table: string) => Number((await t.db.first<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))?.n);
  return { ...t, other, http, enroll, stepUp, refusals, count };
}

it('[R600] le site WebAuthn se lit des variables du Worker, sans jamais deviner : absent ou refusé, les clés sont fermées', () => {
  expect(readClesConfig(RP, `${ORIGIN}, ${ORIGIN.replace('app.', 'www.app.')}`)).toEqual({ rpId: RP, origins: [ORIGIN, 'https://www.app.aimmo.test'] });
  expect(readClesConfig(undefined, ORIGIN)).toBeNull();
  expect(readClesConfig(RP, undefined)).toBeNull();
  expect(readClesConfig(RP, 'http://app.aimmo.test')).toBeNull();
  expect(readClesConfig(RP, 'https://ailleurs.test')).toBeNull();
  expect(readClesConfig(RP, ' , ')).toBeNull();
});

describeWithSqlite('BR05 · routes des clés d’appareil, du second facteur et de l’export de l’agent', () => {
  it('[R16] chaque route refuse le mauvais rôle, avant le corps : 403 et refus au journal, rien rangé', async () => {
    const t = await setup();
    const routes: [Who[], string, string, unknown?][] = [
      [['partenaire'], 'POST', '/cles/enregistrement/debut'],
      [['partenaire'], 'POST', '/cles/enregistrement/fin', { challengeId: 'x' }],
      [['partenaire', 'alex', 'conformite'], 'GET', '/cles/appareils'],
      [['partenaire'], 'GET', '/cles/mes-appareils'],
      [['partenaire', 'alex', 'conformite'], 'POST', '/cles/appareils/d-1/accord', { stepUpId: 's-1' }],
      [['partenaire'], 'POST', '/cles/appareils/d-1/retrait'],
      [['partenaire'], 'POST', '/cles/preuve/debut', { action: 'export_complet', subject: 'agent:a' }],
      [['partenaire'], 'POST', '/cles/preuve/fin', { challengeId: 'x' }],
      // Le corps n'est jamais lu avant le rôle : même illisible, le refus est écrit.
      [['partenaire', 'direction', 'conformite'], 'POST', '/export/agent', 'pas un objet'],
      [['partenaire'], 'POST', '/export/agent/verification', { document: {} }],
    ];
    for (const [whos, method, path, body] of routes) {
      for (const who of whos) {
        const before = (await t.refusals()).length;
        const r = await t.http(who, method, path, body);
        expect(r.status, `${who} ${method} ${path}`).toBe(403);
        expect(r.body).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
        expect((await t.refusals()).length, `${who} ${method} ${path}`).toBe(before + 1);
      }
    }
    for (const table of ['security_devices', 'security_challenges', 'security_step_ups', 'agent_exports']) expect(await t.count(table), table).toBe(0);
  });

  it('[R600] sans site WebAuthn réglé, les routes sont fermées : 503, rien n’est rangé ; le rôle est contrôlé d’abord', async () => {
    const t = await setup(null);
    expect(await t.http('alex', 'POST', '/cles/enregistrement/debut')).toMatchObject({ status: 503, body: { code: 'cles_non_configurees' } });
    expect(await t.http('alex', 'POST', '/export/agent', { stepUpId: 'x' })).toMatchObject({ status: 503 });
    expect((await t.http('partenaire', 'POST', '/cles/enregistrement/debut')).status).toBe(403);
    expect(await t.count('security_challenges')).toBe(0);
  });

  it('[R600] une clé par appareil : la première active, la suivante attend la direction, qui l’accepte sur la preuve de sa propre clé', async () => {
    const t = await setup();
    const first = await t.enroll('alex', 1);
    expect(first.done).toMatchObject({ status: 200, body: { data: { status: 'actif', userRole: 'agent', userId: t.alexId } } });
    // La même clé ne se range pas deux fois ; un champ de plus est refusé sans rien ranger.
    const again = await t.http('alex', 'POST', '/cles/enregistrement/debut');
    expect(await t.http('alex', 'POST', '/cles/enregistrement/fin', { ...(await first.device.register(again.body.data as Challenge)) })).toMatchObject({ status: 409, body: { rule: 'R600', code: 'already_registered' } });
    expect(await t.http('alex', 'POST', '/cles/enregistrement/fin', { challengeId: 'x', role: 'direction' })).toMatchObject({ status: 400, body: { code: 'unknown_field' } });
    const second = await t.enroll('alex', 2);
    expect(second.done.body.data).toMatchObject({ status: 'en_attente' });
    // La direction voit les clés de son réseau, sans clé publique ni identifiant de clé.
    const list = await t.http('direction', 'GET', '/cles/appareils');
    expect(list.body.data).toHaveLength(2);
    expect(JSON.stringify(list.body.data)).not.toMatch(/publicKey|credential/i);
    // L'accord sans preuve est refusé ; la direction enregistre sa clé et prouve l'accord de cette clé-là.
    const pending = second.done.body.data.id as string;
    expect(await t.http('direction', 'POST', `/cles/appareils/${pending}/accord`, {})).toMatchObject({ status: 409, body: { rule: 'R601', code: 'second_factor_required' } });
    const dir = await t.enroll('direction', 9);
    expect(dir.done.body.data).toMatchObject({ status: 'actif' });
    const wrong = await t.stepUp('direction', dir.device, 'approuver_appareil', 'device:autre');
    expect(await t.http('direction', 'POST', `/cles/appareils/${pending}/accord`, { stepUpId: wrong })).toMatchObject({ status: 409, body: { rule: 'R601', code: 'other_action' } });
    const proof = await t.stepUp('direction', dir.device, 'approuver_appareil', `device:${pending}`);
    expect(await t.http('direction', 'POST', `/cles/appareils/${pending}/accord`, { stepUpId: proof })).toMatchObject({ status: 200, body: { data: { status: 'actif' } } });
    // Une direction d'un autre réseau ne touche à rien.
    expect(await t.http('autre', 'POST', `/cles/appareils/${pending}/retrait`)).toMatchObject({ status: 403, body: { rule: 'R16' } });
    // Retirer d'un geste : chacun les siennes, jamais celles d'un autre agent ; la direction toute clé du réseau.
    expect(await t.http('sam', 'POST', `/cles/appareils/${pending}/retrait`)).toMatchObject({ status: 403, body: { rule: 'R16' } });
    expect(await t.http('alex', 'POST', `/cles/appareils/${pending}/retrait`)).toMatchObject({ status: 200, body: { data: { status: 'retire' } } });
    expect(await t.http('alex', 'POST', `/cles/appareils/${pending}/retrait`)).toMatchObject({ status: 409, body: { rule: 'R600', code: 'already_revoked' } });
    expect(await t.http('direction', 'POST', `/cles/appareils/${first.done.body.data.id}/retrait`)).toMatchObject({ status: 200 });
  });

  it('[R600] chacun lit ses propres clés par `/cles/mes-appareils` (BR18), sans clé publique ni celles des autres', async () => {
    const t = await setup();
    await t.enroll('alex', 1);
    await t.enroll('alex', 2);
    await t.enroll('sam', 3);
    const mine = await t.http('alex', 'GET', '/cles/mes-appareils');
    expect(mine.status).toBe(200);
    expect(mine.body.data.map((d: { status: string }) => d.status).sort()).toEqual(['actif', 'en_attente']);
    expect(mine.body.data.every((d: { userId: string }) => d.userId === t.alexId)).toBe(true);
    expect(JSON.stringify(mine.body.data)).not.toMatch(/publicKey|credential/i);
    expect(await t.http('conformite', 'GET', '/cles/mes-appareils')).toMatchObject({ status: 200, body: { data: [] } });
    await expect((await setup(null)).http('alex', 'GET', '/cles/mes-appareils')).resolves.toMatchObject({ status: 503 });
  });

  it('[R82] [R600] [R561] un agent au dossier incomplet garde ses clés et son export : enregistrer, prouver, retirer, exporter', async () => {
    const t = await setup();
    // Une entrée par M14 sans pièce rangée (candidature inventée, hors du parcours) : le dossier est incomplet.
    await t.db.exec('PRAGMA foreign_keys = OFF');
    await t.db.run("INSERT INTO agent_onboardings (agent_id, network_id, candidate_id, created_by, created_at) VALUES (?, ?, 'cand-1', 'direction:dir-1', '2027-01-01')", [t.alexId, t.network.id]);
    await t.db.exec('PRAGMA foreign_keys = ON');
    // Le dossier incomplet ferme bien le reste : aucune fiche client.
    expect(await t.http('alex', 'GET', '/marketing/calendrier/reglages')).toMatchObject({ status: 403, body: { rule: 'R82', code: 'agent_file_incomplete' } });
    const { device, done } = await t.enroll('alex', 5);
    expect(done).toMatchObject({ status: 200, body: { data: { status: 'actif' } } });
    const proof = await t.stepUp('alex', device, 'export_complet', `agent:${t.alexId}`);
    const made = await t.http('alex', 'POST', '/export/agent', { stepUpId: proof });
    expect(made.status).toBe(200);
    expect((await t.http('alex', 'POST', '/export/agent/verification', { document: made.body.data.document })).body.data).toMatchObject({ verified: true });
    // Le téléphone perdu : la clé se retire d'un geste.
    expect(await t.http('alex', 'POST', `/cles/appareils/${done.body.data.id}/retrait`)).toMatchObject({ status: 200, body: { data: { status: 'retire' } } });
  });

  it('[R601] [R561] l’export de l’agent ne sort que sur sa preuve « export_complet », une fois ; l’empreinte seule est rangée et se vérifie', async () => {
    const t = await setup();
    const { device } = await t.enroll('alex', 3);
    expect(await t.http('alex', 'POST', '/export/agent', {})).toMatchObject({ status: 409, body: { rule: 'R601', code: 'second_factor_required' } });
    // Une preuve faite pour une autre action, ou pour un autre objet, ne sert pas.
    const other = await t.stepUp('alex', device, 'effacement', `agent:${t.alexId}`);
    expect(await t.http('alex', 'POST', '/export/agent', { stepUpId: other })).toMatchObject({ status: 409, body: { rule: 'R601', code: 'other_action' } });
    expect(await t.http('alex', 'POST', '/cles/preuve/debut', { action: 'tout_faire', subject: `agent:${t.alexId}` })).toMatchObject({ status: 409, body: { rule: 'R601', code: 'bad_input' } });
    // La preuve de Sam ne sert pas à Alex.
    const samKey = await t.enroll('sam', 4);
    const samProof = await t.stepUp('sam', samKey.device, 'export_complet', `agent:${t.sam.userId}`);
    expect(await t.http('alex', 'POST', '/export/agent', { stepUpId: samProof })).toMatchObject({ status: 409, body: { rule: 'R601' } });
    expect(await t.count('agent_exports')).toBe(0);
    const proof = await t.stepUp('alex', device, 'export_complet', `agent:${t.alexId}`);
    const made = await t.http('alex', 'POST', '/export/agent', { stepUpId: proof });
    expect(made).toMatchObject({ status: 200, body: { ok: true } });
    const { document, fingerprint } = made.body.data as { document: { agentId: string; networkId: string; tables: Record<string, unknown[]> }; fingerprint: string };
    expect(document).toMatchObject({ agentId: t.alexId, networkId: t.network.id });
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // Ses données seules : aucun identifiant de Sam dans le fichier.
    expect(JSON.stringify(document)).not.toContain(t.sam.userId);
    // La même preuve ne sert pas deux fois.
    expect(await t.http('alex', 'POST', '/export/agent', { stepUpId: proof })).toMatchObject({ status: 409, body: { rule: 'R601', code: 'already_used' } });
    // AIMMO range l'empreinte, jamais le contenu.
    expect(await t.db.all('SELECT agent_id, fingerprint FROM agent_exports')).toEqual([{ agent_id: t.alexId, fingerprint }]);
    expect(JSON.stringify(await t.journal.all())).not.toContain('REF-T-1');
    // La vérification : le fichier tel quel passe, un octet changé non, un fichier d'un autre réseau n'est même pas lu.
    expect(await t.http('direction', 'POST', '/export/agent/verification', { document })).toMatchObject({ status: 200, body: { data: { verified: true, fingerprint } } });
    const changed = structuredClone(document);
    (changed.tables.properties as { price_eur: number }[])[0]!.price_eur += 1;
    expect((await t.http('alex', 'POST', '/export/agent/verification', { document: changed })).body.data).toMatchObject({ verified: false });
    expect((await t.http('autre', 'POST', '/export/agent/verification', { document })).body.data).toEqual({ verified: false, fingerprint: null });
  });
});
