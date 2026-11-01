import { expect, it } from 'vitest';
import type { SqlDatabase } from '@aimmo/core';
import { handleRequest, sha256Hex, type ApiConfig } from '../src/index.ts';
import { espaceBase, releveKeys } from '../src/app.ts';
import { ESPACE_PATH, SESSION_COOKIE } from '../src/espaces.ts';
import { setupDossier } from '../../core/test/dossiers-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// Tout est inventé : réseau, agents, vendeur, acquéreur, bien, clés et adresses.
const ORIGIN = 'https://aimmo-api.example.test';
const BASE = `${ORIGIN}${ESPACE_PATH}`;
const SECRET = 'cle-inventee-du-releve-pour-ec-sept-aaaa';
const KEYS = { alex: 'test-cle-ec07-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaa', sam: 'test-cle-ec07-sam-bbbbbbbbbbbbbbbbbbbbbbbbbbbb', conformite: 'test-cle-ec07-conf-ccccccccccccccccccccccccccc', direction: 'test-cle-ec07-dir-ddddddddddddddddddddddddddddd' };
type Who = keyof typeof KEYS;
const CONSENT = { consentProof: 'accord donné au rendez-vous, pour recevoir le lien de son espace' };

async function setup(espaces: ApiConfig['espaces'] | null = { baseUrl: BASE, releveKeys: `essai-a:${SECRET}` }) {
  const t = await setupDossier();
  await t.store.addIdentifier({ networkId: t.network.id, personId: t.personId, kind: 'email', value: 'lea.vendeuse@example.test' });
  await t.store.addIdentifier({ networkId: t.network.id, personId: t.buyerId, kind: 'email', value: 'acheteur.invente@example.test' });
  const samId = (await t.db.first<{ id: string }>("SELECT id FROM agents WHERE network_id = ? AND first_name = 'Sam'", [t.network.id]))!.id;
  const ids: Record<Who, { role: string; userId: string }> = { alex: { role: 'agent', userId: t.alexId }, sam: { role: 'agent', userId: samId }, conformite: { role: 'compliance', userId: 'conf-1' }, direction: { role: 'direction', userId: 'direction-1' } };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: t.network.id, ...ids[w] }))));
  const config = (patch: Partial<ApiConfig> = {}): ApiConfig => ({ db: t.db as SqlDatabase, apiKeys, mode: 'essai', now: t.now, ...(espaces ? { espaces: { networkId: t.network.id, ...espaces } } : {}), ...patch });
  const ouvrir = async (who: Who | null, personId: string, body: unknown = CONSENT, patch: Partial<ApiConfig> = {}) => {
    const r = await handleRequest(
      new Request(`${ORIGIN}/v1/espaces/personnes/${personId}/ouvrir`, { method: 'POST', headers: { ...(who ? { authorization: `Bearer ${KEYS[who]}` } : {}), 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      config(patch),
    );
    return { status: r.status, body: (await r.json()) as { ok: boolean; mode?: string; rule?: string; code?: string } };
  };
  const pub = async (method: string, path: string, init: { cookie?: string; form?: Record<string, string> } = {}, patch: Partial<ApiConfig> = {}) => {
    const headers: Record<string, string> = { ...(init.cookie ? { cookie: `${SESSION_COOKIE}=${init.cookie}` } : {}), ...(method === 'POST' ? { origin: ORIGIN } : {}) };
    let body: string | undefined;
    if (init.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(init.form).toString();
    }
    const r = await handleRequest(new Request(`${ORIGIN}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) }), config(patch));
    return { status: r.status, headers: r.headers, text: await r.text() };
  };
  const lastToken = async (personId: string): Promise<string> => {
    const rows = await t.db.all<{ body: string }>('SELECT m.body FROM messages m JOIN trial_outbox o ON o.message_id = m.id WHERE m.person_id = ? ORDER BY m.occurred_at DESC, m.rowid DESC', [personId]);
    const m = /espace\/([a-z]{40})/.exec(rows[0]?.body ?? '');
    if (!m) throw new Error('jeton');
    return m[1]!;
  };
  /** L'agent ouvre l'espace, le client ouvre son lien par le bouton : rend le cookie de séance. */
  const enter = async (personId: string, who: Who = 'alex'): Promise<string> => {
    expect((await ouvrir(who, personId)).body).toMatchObject({ ok: true, mode: 'essai' });
    const r = await pub('POST', `${ESPACE_PATH}${await lastToken(personId)}`);
    expect(r.status).toBe(303);
    return /=([a-z]{40});/.exec(r.headers.get('set-cookie') ?? '')![1]!;
  };
  const journalText = async () => JSON.stringify(await t.db.all('SELECT * FROM journal'));
  return { ...t, samId, config, ouvrir, pub, enter, journalText };
}

describeWithSqlite('EC07 · branchement des espaces dans le socle', () => {
  it('[R16] la route de l’agent répond sous son rôle : l’agent du client oui, un autre agent ou la conformité non, sans clé 401', async () => {
    const t = await setup();
    expect(await t.ouvrir(null, t.personId)).toMatchObject({ status: 401 });
    const conf = await t.ouvrir('conformite', t.personId);
    expect(conf).toEqual({ status: 403, body: { ok: false, rule: 'R16', code: 'role' } });
    const refused = (await t.db.all<{ data: string }>("SELECT data FROM journal WHERE type = 'acces.refuse'")).map((e) => JSON.parse(e.data) as { kind: string });
    expect(refused.map((e) => e.kind)).toContain('espaces.ouvrir');
    const sam = await t.ouvrir('sam', t.personId);
    expect(sam.body).toMatchObject({ ok: false, rule: 'R16' });
    expect([403, 404]).toContain(sam.status);
    expect(await t.db.all('SELECT id FROM client_space_links WHERE person_id = ?', [t.personId])).toHaveLength(0);
    expect(await t.ouvrir('alex', t.personId)).toMatchObject({ status: 200, body: { ok: true, mode: 'essai' } });
    expect(await t.ouvrir('direction', t.buyerId)).toMatchObject({ status: 200, body: { ok: true, mode: 'essai' } });
  });

  it('[R161] [R160] par le socle, le vendeur et l’acquéreur entrent par leur lien et voient chacun leur dossier, rien de l’autre côté', async () => {
    const t = await setup();
    const seller = await t.enter(t.personId);
    const buyer = await t.enter(t.buyerId);
    const sellerHome = await t.pub('GET', ESPACE_PATH, { cookie: seller });
    expect(sellerHome.status).toBe(200);
    expect(sellerHome.text).toContain('REF-T-1');
    expect(sellerHome.text).toContain('Offres');
    const buyerHome = await t.pub('GET', ESPACE_PATH, { cookie: buyer });
    expect(buyerHome.status).toBe(200);
    expect(buyerHome.text).toContain('Votre recherche');
    // Aucun nom, aucune adresse de l'autre partie, de part et d'autre.
    expect(sellerHome.text).not.toMatch(/Acheteur|acheteur\.invente/);
    expect(buyerHome.text).not.toMatch(/Léa|lea\.vendeuse/);
    // Sans séance, la demande de lien ; une séance fermée ne rouvre rien.
    expect((await t.pub('GET', ESPACE_PATH)).text).toContain('Recevoir mon lien');
    await t.pub('POST', `${ESPACE_PATH}sortie`, { cookie: seller });
    expect((await t.pub('GET', ESPACE_PATH, { cookie: seller })).text).not.toContain('REF-T-1');
    // Rien n'est parti hors de la boîte d'essai [R26].
    expect(await t.db.all("SELECT 1 FROM messages m WHERE m.body LIKE '%lien de votre espace%' AND m.id NOT IN (SELECT message_id FROM trial_outbox)")).toHaveLength(0);
  });

  it('[R165] une offre écrite depuis l’espace passe par le registre de M09 : refusée sans offre signée au stockage, rangée avec elle', async () => {
    const t = await setup();
    // Le bien publié, et l'alerte de M08 partie vers un nouvel acquéreur : le bien lui est proposé.
    expect(await t.annonces.validate(t.agent, t.draftId)).toMatchObject({ ok: true });
    expect(await t.publication.sync(t.network.id, t.propertyId)).toMatchObject({ created: true });
    const bruno = (await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Bruno', lastName: 'Exemple' })).id;
    await t.store.addIdentifier({ networkId: t.network.id, agentId: t.alexId, personId: bruno, kind: 'email', value: 'bruno.invente@example.test' });
    await t.store.createProject({ networkId: t.network.id, agentId: t.alexId, personId: bruno, kind: 'buy' });
    const at = t.now().toISOString();
    await t.db.run("INSERT INTO property_alerts (property_id, person_id, network_id, project_id, channel, status, rule, message_id, created_at, updated_at) VALUES (?, ?, ?, NULL, 'email', 'sent', NULL, NULL, ?, ?)", [t.propertyId, bruno, t.network.id, at, at]);
    const buyer = await t.enter(bruno);
    const signedRef = 'offres/0b6f1d2e-7777-4a2b-8c3d-000000000099.pdf';
    const offer = (patch: Partial<ApiConfig>) =>
      handleRequest(
        new Request(`${ORIGIN}${ESPACE_PATH}api/offre`, {
          method: 'POST',
          headers: { cookie: `${SESSION_COOKIE}=${buyer}`, origin: ORIGIN, 'x-aimmo-espace': '1', 'content-type': 'application/json' },
          body: JSON.stringify({ propertyId: t.propertyId, input: { amountEur: 199000, conditions: [], validUntil: '2027-03-20', downPaymentEur: 199000, loanEur: 0, signedRef } }),
        }),
        t.config(patch),
      ).then(async (r) => ({ status: r.status, body: (await r.json()) as { ok: boolean; rule?: string; code?: string } }));
    const before = await t.db.all('SELECT seq FROM offer_register');
    const refused = await offer({});
    expect(refused.body).toMatchObject({ ok: false, code: 'not_stored' });
    expect(await t.db.all('SELECT seq FROM offer_register')).toEqual(before);
    const stored = await offer({ pieces: { has: async (ref: string) => ref === signedRef } });
    expect(stored).toMatchObject({ status: 200, body: { ok: true, mode: 'essai' } });
    const row = await t.db.first<{ buyer_person_id: string; actor: string }>('SELECT buyer_person_id, actor FROM offer_register ORDER BY seq DESC LIMIT 1');
    expect(row).toEqual({ buyer_person_id: bruno, actor: 'direction:system:espace' });
  });

  it('[R164] avec sa clé, le relevé se télécharge et se vérifie par le socle ; un caractère changé, il est dit modifié ; la clé n’est jamais au journal', async () => {
    const t = await setup();
    const seller = await t.enter(t.personId);
    const releve = await t.pub('GET', `${ESPACE_PATH}releve`, { cookie: seller });
    expect(releve.status).toBe(200);
    expect(releve.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(releve.text).toContain('REF-T-1');
    const intact = await t.pub('POST', `${ESPACE_PATH}verifier`, { form: { releve: releve.text } });
    expect(intact.text).toContain('Ce relevé est intact');
    const changed = releve.text.replace('REF-T-1', 'REF-T-2');
    const modified = await t.pub('POST', `${ESPACE_PATH}verifier`, { form: { releve: changed } });
    expect(modified.text).toContain('a été modifié');
    expect(modified.text).not.toContain('REF-T');
    expect(await t.journalText()).not.toContain(SECRET);
    expect(releve.text).not.toContain(SECRET);
  });

  it('[R164] sans secret de signature, ou un secret mal formé, le relevé répond « indisponible » et l’espace reste lisible', async () => {
    for (const keys of [undefined, 'essai-a:trop-court', `Mauvais:${SECRET}`, `essai-a:${SECRET},essai-a:${SECRET}b`, SECRET]) {
      const t = await setup({ baseUrl: BASE, releveKeys: keys });
      const seller = await t.enter(t.personId);
      const home = await t.pub('GET', ESPACE_PATH, { cookie: seller });
      expect(home.status).toBe(200);
      expect(home.text).toContain('REF-T-1');
      expect(home.text).not.toContain('relevé prouvé');
      const releve = await t.pub('GET', `${ESPACE_PATH}releve`, { cookie: seller });
      expect(releve.status).toBe(503);
      expect(releve.text).toContain('Relevé indisponible');
    }
  });

  it('les clés du relevé se lisent avec leur rotation : la première signe, la suivante vérifie encore', async () => {
    expect(releveKeys(`neuve:${SECRET}b, ancienne:${SECRET}`)).toEqual([
      { id: 'neuve', secret: `${SECRET}b` },
      { id: 'ancienne', secret: SECRET },
    ]);
    expect(releveKeys('')).toEqual([]);
    expect(releveKeys(`neuve:${SECRET},`)).toEqual([]);
    // Un relevé signé par l'ancienne clé reste intact après la rotation.
    const t = await setup({ baseUrl: BASE, releveKeys: `ancienne:${SECRET}` });
    const seller = await t.enter(t.personId);
    const releve = await t.pub('GET', `${ESPACE_PATH}releve`, { cookie: seller });
    const after = await t.pub('POST', `${ESPACE_PATH}verifier`, { form: { releve: releve.text } }, { espaces: { networkId: t.network.id, baseUrl: BASE, releveKeys: `neuve:${SECRET}b,ancienne:${SECRET}` } });
    expect(after.text).toContain('Ce relevé est intact');
  });

  it('sans réseau ni adresse de l’espace, la page et la route de l’agent sont fermées, rien n’est rangé', async () => {
    const t = await setup(null);
    expect(await t.pub('GET', ESPACE_PATH)).toMatchObject({ status: 503 });
    expect(await t.pub('GET', '/espace')).toMatchObject({ status: 503 });
    expect(await t.ouvrir('alex', t.personId)).toMatchObject({ status: 503, body: { ok: false, code: 'espace_not_configured' } });
    for (const baseUrl of ['http://aimmo-api.example.test/espace/', 'https://aimmo-api.example.test/autre/', 'https://aimmo-api2.example.test/espace/', 'https://aimmo-api.example.test/espace']) {
      expect(espaceBase(baseUrl), baseUrl).toBeNull();
      expect(await t.ouvrir('alex', t.personId, CONSENT, { espaces: { networkId: t.network.id, baseUrl } })).toMatchObject({ status: 503 });
    }
    expect(espaceBase(BASE)).toBe(BASE);
    expect(await t.db.all('SELECT id FROM client_space_links')).toHaveLength(0);
  });

  it('hors mode essai, l’espace est fermé [R26]', async () => {
    const t = await setup();
    expect(await t.pub('GET', ESPACE_PATH, {}, { mode: 'reel' })).toMatchObject({ status: 503 });
    expect(await t.pub('GET', `${ESPACE_PATH}verifier`, {}, { mode: undefined })).toMatchObject({ status: 503 });
  });

  it('les autres routes du socle restent à leur place : une adresse voisine n’est pas l’espace', async () => {
    const t = await setup();
    expect(await t.pub('GET', '/espaces/')).toMatchObject({ status: 404 });
    expect((await t.pub('GET', `${ESPACE_PATH}inconnue`)).status).toBe(404);
  });
});
