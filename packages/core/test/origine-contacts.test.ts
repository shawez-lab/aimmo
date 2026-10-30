import { expect, it } from 'vitest';
import { SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { OrigineContacts, Referencement, contentOfPath, taggedLink } from '../src/attirer/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseaux, agents, biens, sites, messages et contenus inventés.
const direction = { role: 'direction' as const, userId: 'dir-1', networkId: 'net-1' };
const NET = 'https://reseau.exemple.test';
const CAMILLE = 'https://camille.exemple.test';

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const journal = new SqlJournalStore(db);
  let clock = Date.parse('2026-10-29T08:00:00.000Z');
  const now = (): Date => new Date((clock += 1000));
  let n = 0;
  const newId = (): string => `id-${++n}`;
  let c = 0;
  const newCode = (): string => `code${[...String(++c)].map((d) => 'abcdefghij'[Number(d)]).join('').padStart(8, 'a')}`;
  await db.run("INSERT INTO networks (id, name, created_at) VALUES ('net-1', 'Réseau test', '2026-01-01T00:00:00.000Z')");
  await db.run("INSERT INTO networks (id, name, created_at) VALUES ('net-2', 'Autre réseau', '2026-01-01T00:00:00.000Z')");
  await db.run("INSERT INTO agents (id, network_id, first_name, last_name, zone, created_at, updated_at) VALUES ('ag-1', 'net-1', 'Camille', 'Exemple', 'Dijon centre', 'x', 'x')");
  await db.run("INSERT INTO agents (id, network_id, first_name, last_name, zone, created_at, updated_at) VALUES ('ag-9', 'net-2', 'Autre', 'Agent', 'Ailleurs', 'x', 'x')");
  await db.run(
    "INSERT INTO properties (id, network_id, agent_id, reference, kind, postal_code, city, created_at, updated_at) VALUES ('bien-1', 'net-1', 'ag-1', 'REF-1', 'home', '99000', 'Ville inventée', 'x', 'x')",
  );
  await db.run(
    "INSERT INTO properties (id, network_id, agent_id, reference, kind, postal_code, city, created_at, updated_at) VALUES ('bien-9', 'net-2', 'ag-9', 'REF-9', 'home', '99000', 'Ville inventée', 'x', 'x')",
  );
  const ref = new Referencement(db, journal, { now, newId });
  expect(await ref.setSite(direction, { kind: 'reseau', baseUrl: NET, active: true })).toMatchObject({ ok: true });
  expect(await ref.setSite(direction, { kind: 'agent', agentId: 'ag-1', baseUrl: CAMILLE, active: true })).toMatchObject({ ok: true });
  const origine = new OrigineContacts(db, journal, { now, newId, newCode });
  let m = 0;
  const inbound = async (o: { channel?: string; kind?: string; conv?: string | null; postRef?: string | null; portal?: string | null; at?: string; status?: string; network?: string } = {}) => {
    const id = `in-${++m}`;
    await db.run(
      `INSERT INTO inbound_messages (id, network_id, dedup_key, channel, kind, external_id, conversation_ref, sender_name, body, post_ref, portal, status, received_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Personne Inventée', 'Bonjour', ?, ?, ?, ?, ?)`,
      [
        id,
        o.network ?? 'net-1',
        `k-${id}`,
        o.channel ?? 'site',
        o.kind ?? 'form',
        `ext-${id}`,
        o.conv === undefined ? null : o.conv,
        o.postRef ?? null,
        o.portal ?? null,
        o.status ?? 'received',
        o.at ?? '2026-10-15T10:00:00.000Z',
        'x',
      ],
    );
    return id;
  };
  return { db, journal, origine, inbound };
}

it('lit le contenu visé par un chemin public, en liste fermée', () => {
  expect(contentOfPath('/biens/bien-1')).toEqual({ kind: 'bien', ref: 'bien-1' });
  expect(contentOfPath('/agents/ag-1/')).toEqual({ kind: 'agent', ref: 'ag-1' });
  expect(contentOfPath('/prix/dijon')).toEqual({ kind: 'prix', ref: 'dijon' });
  expect(contentOfPath('/prix/dijon/montchapet')).toEqual({ kind: 'prix', ref: 'dijon/montchapet' });
  expect(contentOfPath('/quartiers/dijon/montchapet')).toEqual({ kind: 'quartier', ref: 'dijon/montchapet' });
  expect(contentOfPath('/simulateur')).toEqual({ kind: 'simulateur', ref: 'simulateur' });
  for (const p of ['/', '/biens', '/biens/a/b', '/contact', '/prix/Dijon', '/biens/%E0', '/biens/a%20b', '/quartiers/dijon']) expect(contentOfPath(p)).toBeNull();
});

it('ajoute le code porteur à un lien https, et rien à une autre adresse', () => {
  expect(taggedLink(`${NET}/biens/bien-1?x=1`, 'abcdefgh2345')).toBe(`${NET}/biens/bien-1?x=1&o=abcdefgh2345`);
  expect(taggedLink('http://reseau.exemple.test/biens/bien-1', 'abcdefgh2345')).toBeNull();
  expect(taggedLink(`${NET}/biens/bien-1`, 'pas-un-code')).toBeNull();
});

describeWithSqlite('origine des contacts', () => {
  it('donne à chaque contenu un identifiant stable, du réseau seulement', async () => {
    const { origine } = await setup();
    const a = await origine.contentFor('net-1', 'bien', 'bien-1');
    expect(a.ok).toBe(true);
    expect(await origine.contentFor('net-1', 'bien', 'bien-1')).toEqual(a);
    expect(await origine.contentFor('net-1', 'bien', 'bien-9')).toEqual({ ok: false, code: 'unknown_ref' });
    expect(await origine.contentFor('net-1', 'agent', 'ag-9')).toEqual({ ok: false, code: 'unknown_ref' });
    expect(await origine.contentFor('net-1', 'cookie', 'x')).toEqual({ ok: false, code: 'bad_kind' });
    expect(await origine.contentFor('net-1', 'prix', 'Dijon Centre')).toEqual({ ok: false, code: 'bad_ref' });
    expect(await origine.contentFor('net-1', 'simulateur', 'autre')).toEqual({ ok: false, code: 'bad_ref' });
    const b = await origine.contentFor('net-2', 'bien', 'bien-9');
    expect(b.ok && a.ok && b.contentId !== a.contentId).toBe(true);
  });

  it('[R156] lit le code porteur connu du réseau, et range « inconnue » un code inconnu ou d’un autre réseau', async () => {
    const { origine, inbound } = await setup();
    const video = await origine.contentFor('net-1', 'video', 'studio-pub-1');
    const other = await origine.contentFor('net-2', 'video', 'studio-pub-9');
    if (!video.ok || !other.ok) throw new Error('contenu');
    const i1 = await inbound();
    expect(await origine.record('net-1', i1, { link: `https://ailleurs.exemple.test/?o=${video.contentId}` })).toEqual({
      ok: true,
      origin: { contentId: video.contentId, kind: 'video', method: 'lien' },
      already: false,
    });
    const i2 = await inbound();
    expect((await origine.record('net-1', i2, { link: `${NET}/?o=zzzzzzzzzzzz` })).ok && (await origine.stored(i2))).toEqual({ contentId: null, kind: 'inconnue', method: 'inconnue' });
    const i3 = await inbound();
    await origine.record('net-1', i3, { link: `${NET}/?o=${other.contentId}` });
    expect(await origine.stored(i3)).toEqual({ contentId: null, kind: 'inconnue', method: 'inconnue' });
    // Deux codes dans le même lien : un doute, rien n'est choisi.
    const i4 = await inbound();
    await origine.record('net-1', i4, { link: `${NET}/?o=${video.contentId}&o=${video.contentId}` });
    expect(await origine.stored(i4)).toMatchObject({ kind: 'inconnue' });
    // Rien de transmis : inconnue, jamais devinée.
    const i5 = await inbound();
    expect(await origine.record('net-1', i5)).toMatchObject({ ok: true, origin: { kind: 'inconnue', method: 'inconnue', contentId: null } });
    expect(await origine.record('net-1', 'in-absent', {})).toEqual({ ok: false, code: 'unknown_inbound' });
    expect(await origine.record('net-2', i1, {})).toEqual({ ok: false, code: 'unknown_inbound' });
  });

  it('[R156] lit la page de départ seulement sur un site en service du réseau', async () => {
    const { origine, inbound } = await setup();
    const i1 = await inbound();
    expect(await origine.record('net-1', i1, { landingPage: `${CAMILLE}/biens/bien-1` })).toMatchObject({ origin: { kind: 'bien', method: 'page' } });
    const i2 = await inbound();
    expect(await origine.record('net-1', i2, { landingPage: `${NET}/prix/dijon/montchapet` })).toMatchObject({ origin: { kind: 'prix', method: 'page' } });
    const bien = await origine.contentFor('net-1', 'bien', 'bien-1');
    expect(bien.ok && (await origine.stored(i1))?.contentId === bien.contentId).toBe(true);
    for (const page of [`https://imitation.exemple.test/biens/bien-1`, `${NET}/biens/bien-9`, `${NET}/contact`, 'http://reseau.exemple.test/biens/bien-1', 'pas une adresse', 42]) {
      const id = await inbound();
      await origine.record('net-1', id, { landingPage: page });
      expect(await origine.stored(id)).toEqual({ contentId: null, kind: 'inconnue', method: 'inconnue' });
    }
    // Le code porteur passe avant la page de départ.
    const pub = await origine.contentFor('net-1', 'publication', 'studio-pub-2');
    if (!pub.ok) throw new Error('contenu');
    const i3 = await inbound();
    expect(await origine.record('net-1', i3, { landingPage: `${NET}/biens/bien-1?o=${pub.contentId}` })).toMatchObject({ origin: { kind: 'publication', method: 'lien' } });
  });

  it('[R156] reconnaît une publication commentée et un portail, sans rien inventer', async () => {
    const { origine, inbound } = await setup();
    const pub = await origine.contentFor('net-1', 'publication', 'studio-pub-3');
    const bien = await origine.contentFor('net-1', 'bien', 'bien-1');
    if (!pub.ok || !bien.ok) throw new Error('contenu');
    expect(await origine.linkPost('net-1', pub.contentId, 'instagram', 'ig-post-77')).toEqual({ ok: true });
    expect(await origine.linkPost('net-1', bien.contentId, 'instagram', 'ig-post-78')).toEqual({ ok: false, code: 'not_a_post' });
    expect(await origine.linkPost('net-1', pub.contentId, 'tiktok', 'x')).toEqual({ ok: false, code: 'bad_channel' });
    const other = await origine.contentFor('net-1', 'video', 'studio-vid-1');
    if (!other.ok) throw new Error('contenu');
    expect(await origine.linkPost('net-1', other.contentId, 'instagram', 'ig-post-77')).toEqual({ ok: false, code: 'post_taken' });
    const i1 = await inbound({ channel: 'instagram', kind: 'comment', postRef: 'ig-post-77' });
    expect(await origine.record('net-1', i1)).toMatchObject({ origin: { contentId: pub.contentId, kind: 'publication', method: 'publication' } });
    const i2 = await inbound({ channel: 'facebook', kind: 'comment', postRef: 'ig-post-77' });
    expect(await origine.record('net-1', i2)).toMatchObject({ origin: { kind: 'inconnue' } });
    const i3 = await inbound({ channel: 'email', kind: 'portal_email', portal: 'seloger' });
    expect(await origine.record('net-1', i3)).toMatchObject({ origin: { kind: 'portail', method: 'portail' } });
    const i4 = await inbound({ channel: 'email', kind: 'email', portal: null });
    expect(await origine.record('net-1', i4)).toMatchObject({ origin: { kind: 'inconnue' } });
  });

  it('[R156] ne garde ni adresse de page, ni paramètre de suivi, ni identifiant de navigateur, ni donnée personnelle', async () => {
    const { db, origine, inbound } = await setup();
    const id = await inbound();
    const secrets = ['gclid=GCLID123', 'fbclid=FBCLID456', '_ga=GA1.2.999', 'email=personne%40exemple.test', 'tel=0600000000', 'utm_source=lettre'];
    await origine.record('net-1', id, { link: `${NET}/biens/bien-1?${secrets.join('&')}`, landingPage: `${CAMILLE}/biens/bien-1?${secrets.join('&')}`, cookie: 'sid=abc' } as never);
    const row = await db.first<Record<string, unknown>>('SELECT * FROM contact_origins WHERE inbound_id = ?', [id]);
    expect(Object.keys(row!).sort()).toEqual(['content_id', 'content_kind', 'id', 'inbound_id', 'method', 'network_id', 'recorded_at']);
    expect(row).toMatchObject({ content_kind: 'bien', method: 'page' });
    const everything = JSON.stringify([
      await db.all('SELECT * FROM contact_origins'),
      await db.all('SELECT * FROM public_contents'),
      await db.all('SELECT * FROM public_content_posts'),
      await db.all("SELECT * FROM journal"),
    ]);
    for (const s of ['GCLID', 'FBCLID', 'GA1', 'personne', '0600', 'utm', 'lettre', 'sid', 'https://', 'Inventée']) expect(everything).not.toContain(s);
  });

  it('range l’origine une seule fois : la première lecture compte, rien ne s’efface ni ne se réécrit', async () => {
    const { db, origine, inbound } = await setup();
    const id = await inbound();
    const first = await origine.record('net-1', id, { landingPage: `${NET}/simulateur` });
    expect(first).toMatchObject({ already: false, origin: { kind: 'simulateur' } });
    expect(await origine.record('net-1', id, { landingPage: `${NET}/biens/bien-1` })).toMatchObject({ already: true, origin: { kind: 'simulateur' } });
    await expect(db.run('DELETE FROM contact_origins')).rejects.toThrow();
    await expect(db.run("UPDATE contact_origins SET content_kind = 'bien'")).rejects.toThrow();
    await expect(db.run('DELETE FROM public_contents')).rejects.toThrow();
    await expect(db.run("UPDATE public_contents SET ref = 'x'")).rejects.toThrow();
  });

  it('[R16] réserve la mesure à la direction', async () => {
    const { origine } = await setup();
    expect(await origine.measure({ role: 'agent', userId: 'ag-1', networkId: 'net-1' }, '2026-10')).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await origine.measure(direction, '2026-13')).toEqual({ ok: false, rule: null, code: 'bad_month' });
  });

  it('mesure sur 100 contacts inventés venus de contenus marqués la bonne part, depuis la base', async () => {
    const { db, origine, inbound } = await setup();
    const codes: Record<string, string> = {};
    for (const [kind, ref] of [
      ['video', 'studio-vid-2'],
      ['publication', 'studio-pub-4'],
    ] as const) {
      const r = await origine.contentFor('net-1', kind, ref);
      if (!r.ok) throw new Error('contenu');
      codes[ref] = r.contentId;
    }
    const pub = codes['studio-pub-4']!;
    await origine.linkPost('net-1', pub, 'facebook', 'fb-post-1');
    // 100 contacts d'octobre : 40 par la page du bien, 25 par la vidéo (lien porteur), 20 par la page de prix,
    // 11 commentaires de la publication, 4 sans rien de lisible.
    const plan: [number, () => Promise<string>, Record<string, unknown>][] = [
      [40, () => inbound(), { landingPage: `${CAMILLE}/biens/bien-1` }],
      [25, () => inbound(), { link: `${NET}/?o=${codes['studio-vid-2']}` }],
      [20, () => inbound(), { landingPage: `${NET}/prix/dijon` }],
      [11, () => inbound({ channel: 'facebook', kind: 'comment', postRef: 'fb-post-1' }), {}],
      [4, () => inbound(), { landingPage: 'https://inconnu.exemple.test/' }],
    ];
    for (const [count, make, signals] of plan) for (let i = 0; i < count; i += 1) await origine.record('net-1', await make(), signals);
    // Ce qui ne compte pas : une suite de conversation, un message illisible, un contact de septembre, d'un autre réseau.
    await inbound({ conv: 'fil-1', at: '2026-10-02T10:00:00.000Z' });
    await inbound({ conv: 'fil-1', at: '2026-10-03T10:00:00.000Z' });
    await origine.record('net-1', 'in-101', {});
    await origine.record('net-1', 'in-102', { landingPage: `${NET}/simulateur` });
    await inbound({ status: 'unreadable', kind: 'unreadable' });
    await inbound({ at: '2026-09-30T21:59:00.000Z' });
    await inbound({ network: 'net-2' });
    // Le 30 septembre à 22 h 30 UTC, il est 0 h 30 le 1er octobre à Paris : ce contact est d'octobre.
    const late = await inbound({ at: '2026-09-30T22:30:00.000Z' });
    await origine.record('net-1', late, { landingPage: `${NET}/simulateur` });

    const r = await origine.measure(direction, '2026-10');
    if (!r.ok) throw new Error('mesure');
    // Compte fait à la main : 100 + le fil (classé par son second message) + le contact de minuit = 102, dont 4 sans.
    expect(r.measure).toMatchObject({ month: '2026-10', contacts: 102, withOrigin: 98, percent: 96.0, targetPercent: 95, meetsTarget: true });
    expect(r.measure.withOrigin / r.measure.contacts).toBeGreaterThanOrEqual(0.95);
    expect(r.measure.byKind).toEqual([
      { kind: 'bien', contacts: 40 },
      { kind: 'video', contacts: 25 },
      { kind: 'prix', contacts: 20 },
      { kind: 'publication', contacts: 11 },
      { kind: 'inconnue', contacts: 4 },
      { kind: 'simulateur', contacts: 2 },
    ]);
    expect(r.measure.byContent[0]).toMatchObject({ kind: 'bien', ref: 'bien-1', contacts: 40 });
    // Le même compte, refait directement dans la base.
    const direct = await db.first<{ n: number }>("SELECT count(*) AS n FROM contact_origins o JOIN inbound_messages m ON m.id = o.inbound_id WHERE m.network_id = 'net-1' AND o.content_id IS NOT NULL AND m.received_at >= '2026-09-30T22:00:00.000Z'");
    expect(Number(direct!.n)).toBe(98);
    const sept = await origine.measure(direction, '2026-09');
    expect(sept.ok && sept.measure).toMatchObject({ contacts: 1, withOrigin: 0, percent: 0, meetsTarget: false });
    const empty = await origine.measure(direction, '2026-11');
    expect(empty.ok && empty.measure).toMatchObject({ contacts: 0, percent: 0, meetsTarget: false, byKind: [], byContent: [] });
  });
});
