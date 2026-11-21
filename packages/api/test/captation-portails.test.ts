import { expect, it } from 'vitest';
import { FicheClient, PORTAL_DOMAINS, SqlJournalStore, applyMigrations, fromSyncSqlite, readPortalBody, type SqlDatabase } from '@aimmo/core';
import { handleEmail, handleRequest, sha256Hex, type ApiConfig, type InboundEmail } from '../src/index.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// AU032 : la captation par mail, portail par portail. Tout est inventé : portails simulés, clients, adresses, clés.
const ORIGIN = 'https://aimmo-api.example.test';
const KEYS = { direction: 'test-cle-au032-dir-dddddddddddddddddddddddddd', alex: 'test-cle-au032-alex-aaaaaaaaaaaaaaaaaaaaaaaaa' };
const T0 = Date.parse('2026-12-08T09:00:00.000Z');

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
function message(bytes: Uint8Array): InboundEmail {
  return {
    raw: new ReadableStream({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    }),
    rawSize: bytes.length,
    async forward() {},
  };
}

const PORTALS = Object.entries(PORTAL_DOMAINS);
let seq = 0;
// Prénoms sans chiffre : un chiffre de la réponse doit venir des données [R10].
const NAMES = ['Alix', 'Basile', 'Céleste', 'Dorian', 'Elsa', 'Fabien', 'Gaëlle', 'Hugo', 'Inès', 'Jules'];

/** Une demande de portail comme les portails l'écrivent : expéditeur du portail, coordonnées dans le corps. */
function portalLead(domain: string, i: number, opts: { replyTo?: string; ref?: string | null; withCoords?: boolean; email?: string } = {}): Uint8Array {
  seq += 1;
  const withCoords = opts.withCoords ?? true;
  const ref = opts.ref === undefined ? `DEM-${i}-${domain.length}` : opts.ref;
  return enc(
    [
      `From: Demandes <noreply@mail.${domain}>`,
      ...(opts.replyTo ? [`Reply-To: ${opts.replyTo}`] : []),
      'To: Agence <agence@example.test>',
      `Subject: Nouvelle demande pour votre annonce`,
      `Date: ${new Date(T0).toUTCString()}`,
      `Message-ID: <lead-${seq}@mail.${domain}>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Vous avez reçu une nouvelle demande de contact.',
      ...(withCoords ? [`Nom et prénom : ${NAMES[i % NAMES.length]} Essai`, `E-mail : ${opts.email ?? `client${i}@example.test`}`, `Téléphone : 06 00 00 ${String(10 + i).padStart(2, '0')} 00`] : []),
      ...(ref ? [`Référence de la demande : ${ref}`] : []),
      'Message : Bonjour, ce bien est-il toujours disponible ?',
    ].join('\r\n'),
  );
}

async function world() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const store = new FicheClient(db);
  const network = await store.createNetwork('Réseau test');
  let clock = T0;
  const now = (): Date => new Date(clock);
  const mail = { networkId: network.id, forwardTo: 'boite-agent@example.test', ownAddresses: 'assistant@example.test' };
  const mailConfig = { db, mode: 'essai', ...mail, now };
  const agent = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const ids = { direction: { role: 'direction', userId: 'direction-1' }, alex: { role: 'agent', userId: agent.id } };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as (keyof typeof KEYS)[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: network.id, ...ids[w] }))));
  const api = (config: Partial<ApiConfig> = {}) => async (who: keyof typeof KEYS) => {
    const r = await handleRequest(new Request(`${ORIGIN}/v1/captation/mail`, { headers: { authorization: `Bearer ${KEYS[who]}` } }), { db, apiKeys, mode: 'essai', now, mail, ...config });
    return { status: r.status, body: (await r.json()) as { ok: boolean; rule?: string; code?: string; data?: { configured: boolean; missing: string[]; sources: { source: string; status: string; lastReceivedAt: string | null; last30Days: number }[] } } };
  };
  const persons = async () => (await db.all<{ n: number }>('SELECT count(*) AS n FROM persons p WHERE NOT EXISTS (SELECT 1 FROM person_merges m WHERE m.merged_id = p.id AND m.undone_at IS NULL)'))[0]!.n;
  const identifiers = async () => db.all<{ kind: string; value: string }>('SELECT kind, value FROM person_identifiers ORDER BY kind, value');
  const outbox = async () => (await db.all('SELECT * FROM trial_outbox')).length;
  const alerts = async () => db.all<{ reason: string }>('SELECT reason FROM agent_alerts');
  return { db, network, mailConfig, api, persons, identifiers, outbox, alerts, journal: new SqlJournalStore(db), tick: (ms: number) => (clock += ms) };
}

describeWithSqlite('AU032 · captation par mail, portail par portail', () => {
  it('lit les coordonnées écrites dans le corps d’un mail de portail, jamais un texte libre', () => {
    expect(readPortalBody('Nom et prénom : Ana Essai\nE-mail : ana@example.test\nTél. : 06 11 22 33 44\nRéférence de la demande : AB-1234\nMessage : écrivez à autre@example.test')).toEqual({
      email: 'ana@example.test',
      phone: '06 11 22 33 44',
      name: 'Ana Essai',
      leadRef: 'AB-1234',
    });
    // Les lignes du message du client, ou d'un mail cité, ne sont jamais lues comme ses coordonnées.
    expect(readPortalBody('Nom : Essai\nMessage : voici les coordonnées de mon notaire\nE-mail : notaire@example.test\nTéléphone : 03 80 00 00 00')).toEqual({
      email: null,
      phone: null,
      name: 'Essai',
      leadRef: null,
    });
    expect(readPortalBody('Le 2 déc. 2026, Ana a écrit :\nE-mail : ancien@example.test')).toMatchObject({ email: null });
    expect(readPortalBody('> E-mail : cite@example.test')).toMatchObject({ email: null });
    expect(readPortalBody('Prénom : Ana\nNom : Essai')).toMatchObject({ name: 'Ana Essai', email: null });
    expect(readPortalBody('Bonjour, mon mail est ana@example.test et mon numéro le 0611223344')).toEqual({ email: null, phone: null, name: null, leadRef: null });
  });

  it('[R669] [R18] la demande de chaque portail, coordonnées dans le corps, crée une seule fiche et sa réponse prête, même relivrée', async () => {
    const w = await world();
    for (const [i, [domain, portal]] of PORTALS.entries()) {
      const [first] = await handleEmail(message(portalLead(domain, i)), w.mailConfig);
      expect(first, portal).toMatchObject({ status: 'replied' });
      // Le portail relivre la même demande sous un autre identifiant de mail : rien de plus.
      w.tick(60_000);
      const [again] = await handleEmail(message(portalLead(domain, i)), w.mailConfig);
      expect(again, portal).toMatchObject({ status: 'duplicate' });
    }
    expect(await w.persons()).toBe(PORTALS.length);
    expect(await w.outbox()).toBe(PORTALS.length);
    const found = await w.identifiers();
    for (const [i] of PORTALS.entries()) {
      expect(found).toContainEqual({ kind: 'email', value: `client${i}@example.test` });
      expect(found.some((f) => f.kind === 'phone' && f.value.endsWith(`600000${String(10 + i).padStart(2, '0')}00`.slice(-8)))).toBe(true);
    }
    // Jamais une adresse d'un portail ni de nos boîtes dans une fiche.
    expect(found.some((f) => PORTALS.some(([d]) => f.value.includes(d)))).toBe(false);
  });

  it('[R669] le même client par deux portails rejoint la même fiche', async () => {
    const w = await world();
    await handleEmail(message(portalLead('seloger.com', 1, { email: 'meme@example.test' })), w.mailConfig);
    await handleEmail(message(portalLead('leboncoin.fr', 1, { email: 'Meme@Example.test' })), w.mailConfig);
    expect(await w.persons()).toBe(1);
  });

  it('[R669] une relivraison sans référence de demande est reconnue au même identifiant de mail ; une adresse relais du portail n’est jamais celle du client', async () => {
    const w = await world();
    const bytes = portalLead('leboncoin.fr', 3, { ref: null, replyTo: 'Relais <abc123@messagerie.leboncoin.fr>' });
    expect((await handleEmail(message(bytes), w.mailConfig))[0]).toMatchObject({ status: 'replied' });
    expect((await handleEmail(message(bytes), w.mailConfig))[0]).toMatchObject({ status: 'duplicate' });
    expect(await w.persons()).toBe(1);
    expect((await w.identifiers()).map((f) => f.value)).not.toContain('abc123@messagerie.leboncoin.fr');
  });

  it('[R669] [R18] un mail déjà rangé sous son identifiant de mail reste un doublon quand il revient avec sa référence de demande, puis sous un autre identifiant', async () => {
    const w = await world();
    const before = new TextDecoder().decode(portalLead('pap.fr', 6, { ref: null }));
    const withRef = before.replace('Message : ', 'Référence de la demande : PAP-0006\r\nMessage : ');
    expect((await handleEmail(message(enc(before)), w.mailConfig))[0]).toMatchObject({ status: 'replied' });
    expect((await handleEmail(message(enc(withRef)), w.mailConfig))[0]).toMatchObject({ status: 'duplicate' });
    // Puis le portail relivre la même demande sous un nouvel identifiant de mail : toujours un doublon.
    const resent = withRef.replace(/Message-ID: <[^>]+>/, 'Message-ID: <relivre-6@mail.pap.fr>');
    expect((await handleEmail(message(enc(resent)), w.mailConfig))[0]).toMatchObject({ status: 'duplicate' });
    expect(await w.outbox()).toBe(1);
    expect(await w.persons()).toBe(1);
  });

  it('[R669] [R12] une demande de portail sans coordonnée lisible n’est jamais un silence : l’agent est alerté, rien ne part', async () => {
    const w = await world();
    const [r] = await handleEmail(message(portalLead('bienici.com', 4, { withCoords: false })), w.mailConfig);
    expect(r).toMatchObject({ status: 'not_sent' });
    expect(await w.outbox()).toBe(0);
    expect(await w.alerts()).toEqual([{ reason: 'needs_reply' }]);
  });

  it('[R669] [R16] la direction lit ce qui manque et chaque portail « non vérifié » jusqu’à son premier vrai mail ; un agent est refusé', async () => {
    const w = await world();
    expect(await w.api()('alex')).toMatchObject({ status: 403, body: { rule: 'R16', code: 'role' } });
    const missing = await w.api({ mail: { networkId: undefined, forwardTo: undefined, ownAddresses: undefined } })('direction');
    expect(missing.body.data).toMatchObject({ configured: false, missing: ['MAIL_NETWORK_ID', 'MAIL_FORWARD_TO', 'MAIL_OWN_ADDRESSES'] });
    const before = await w.api()('direction');
    expect(before.body.data?.configured).toBe(true);
    expect(before.body.data?.sources.map((s) => s.status)).toEqual(before.body.data?.sources.map(() => 'non_verifiee'));
    expect(before.body.data?.sources.map((s) => s.source)).toEqual(['direct', ...new Set(Object.values(PORTAL_DOMAINS))]);
    await handleEmail(message(portalLead('seloger.com', 5)), w.mailConfig);
    const after = await w.api()('direction');
    const seloger = after.body.data?.sources.find((s) => s.source === 'seloger');
    expect(seloger).toEqual({ source: 'seloger', status: 'verifiee', lastReceivedAt: new Date(T0).toISOString(), last30Days: 1 });
    expect(after.body.data?.sources.filter((s) => s.status === 'verifiee')).toHaveLength(1);
    // Ni adresse ni fiche dans la réponse [R13].
    expect(JSON.stringify(after.body)).not.toMatch(/@/);
  });
});
