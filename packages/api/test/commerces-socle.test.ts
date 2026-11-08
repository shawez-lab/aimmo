import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '@aimmo/core';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { runScheduler } from '../src/planificateur.ts';
import { dossierLinkBase } from '../src/worker.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';
import { enClair } from '../../core/test/boite-essai.ts';

// Réseau, agent, commerce, repreneur et clés inventés. Le 7 septembre 2027 est un mardi ; été : Paris = UTC + 2.
const BASE = 'https://aimmo-api.example.test';
const KEYS = {
  alex: 'test-cle-ce10-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaa',
  direction: 'test-cle-ce10-dir-bbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  conformite: 'test-cle-ce10-conf-cccccccccccccccccccccccccc',
};
type Who = keyof typeof KEYS;
const NDA =
  'Engagement de confidentialité (modèle inventé pour les tests). Le signataire garde secrets les chiffres et documents du commerce qui lui sont communiqués, et ne les utilise que pour étudier sa reprise.';
const proof = (n: number): string => `preuves/00000000-0000-4000-8000-${String(n).padStart(12, '0')}.pdf`;

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = Date.parse('2027-09-07T08:00:00.000Z');
  const now = (): Date => new Date((clock += 1_000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const network = (await store.createNetwork('Réseau test')).id;
  const alex = (await store.createAgent({ networkId: network, firstName: 'Alex', lastName: 'Agent' })).id;
  const shop = (await store.createProperty({ networkId: network, agentId: alex, reference: 'CE-1', kind: 'business', status: 'available', city: 'Dijon', postalCode: '21000', surfaceM2: 90 })).id;
  const buyer = (await store.createPerson({ networkId: network, agentId: alex, firstName: 'Camille', lastName: 'Exemple' })).id;
  await store.addIdentifier({ networkId: network, personId: buyer, kind: 'email', value: 'camille.exemple@example.test' });
  const ids: Record<Who, { role: string; userId: string }> = { alex: { role: 'agent', userId: alex }, direction: { role: 'direction', userId: 'dir-1' }, conformite: { role: 'compliance', userId: 'conf-1' } };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: network, ...ids[w] }))));
  const config = (withLink: boolean): ApiConfig => ({ db, apiKeys, mode: 'essai', now, commerces: withLink ? { baseUrl: 'https://app.example.test/dossier/' } : {} });
  const call = async (who: Who, method: string, path: string, body?: unknown, withLink = true) => {
    const headers: Record<string, string> = { authorization: `Bearer ${KEYS[who]}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await handleRequest(new Request(`${BASE}/v1${path}`, { method, headers, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) }), config(withLink));
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; rule?: string; code?: string; codes?: string[] } };
  };
  const anonymous = async (method: string, path: string, body?: unknown) => {
    const r = await handleRequest(
      new Request(`${BASE}/v1${path}`, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }),
      config(true),
    );
    return { status: r.status, body: (await r.json()) as { ok: boolean; code?: string } };
  };
  return { db, journal, network, alex, shop, buyer, call, anonymous, now, setTime: (iso: string) => (clock = Date.parse(iso)) };
}

describeWithSqlite('CE10 · M16 branché dans le socle', () => {
  it('[R16] [R110] [R113] les routes de M16 sont servies par le Worker, le rôle contrôlé avant le corps ; aucun dossier sans la porte', async () => {
    const t = await setup();
    expect((await t.call('direction', 'POST', '/commerces/baremes', { activity: 'restaurant', method: 'revenue_pct', low: 5_000, high: 8_000, source: 'Barème inventé', sourceDate: '2027-01-15' })).status).toBe(200);
    expect((await t.call('direction', 'POST', '/commerces/engagements/modeles', { body: NDA })).status).toBe(200);
    const sheet = { activity: 'restaurant', signName: 'Le Comptoir Inventé', fiscalYears: [{ year: 2026, revenueCents: 50_000_000, resultCents: 2_000_000 }], leaseAnnualRentCents: 1_800_000 };
    expect((await t.call('alex', 'POST', `/commerces/${t.shop}/fiche`, sheet)).status).toBe(200);
    const e = await t.call('alex', 'POST', `/commerces/${t.shop}/estimations`, { method: 'revenue_pct' });
    expect((await t.call('alex', 'POST', `/commerces/estimations/${e.body.data.id}/validation`)).status).toBe(200);
    const p = await t.call('alex', 'POST', `/commerces/${t.shop}/presentations`);
    expect((await t.call('alex', 'POST', `/commerces/presentations/${p.body.data.id}/validation`)).status).toBe(200);
    const pub = await t.call('alex', 'GET', `/commerces/${t.shop}/public`);
    expect(pub).toMatchObject({ status: 200, body: { data: { publicView: { activity: 'restaurant' } } } });
    expect(JSON.stringify(pub.body)).not.toMatch(/Comptoir|500 000|1800000|18 000/);
    // La conformité lit, n'écrit pas : refusée avant la lecture du corps, le refus au journal [R16].
    expect(await t.call('conformite', 'POST', `/commerces/${t.shop}/fiche`, 'pas du json')).toMatchObject({ status: 403, body: { rule: 'R16', code: 'role' } });
    expect((await t.journal.all()).some((x) => x.type === 'acces.refuse' && x.data['kind'] === 'commerces.fiche.modifiee')).toBe(true);
    // La demande d'accès, puis l'envoi : la pièce d'identité n'est pas vérifiée au coffre, l'engagement pas signé.
    expect((await t.call('alex', 'POST', `/commerces/${t.shop}/demandes`, { personId: t.buyer })).status).toBe(200);
    const send = await t.call('alex', 'POST', `/commerces/${t.shop}/dossiers`, { personId: t.buyer, consentProof: 'accord au rendez-vous' });
    expect(send).toMatchObject({ status: 409, body: { rule: 'R113', code: 'door_closed' } });
    expect(send.body.codes).toEqual(['engagement_non_signe', 'identite_non_verifiee']);
    // Sans début de lien configuré, aucun dossier ne part.
    expect(await t.call('alex', 'POST', `/commerces/${t.shop}/dossiers`, { personId: t.buyer, consentProof: 'accord' }, false)).toMatchObject({ status: 503, body: { code: 'dossier_link_not_configured' } });
    expect(await t.db.all('SELECT 1 FROM trial_outbox o JOIN messages m ON m.id = o.message_id WHERE m.body LIKE ?', ['%dossier confidentiel%'])).toHaveLength(0);
    // Un second repreneur, à la pièce vérifiée au coffre réel : il signe, le dossier part par le contrôle central en
    // essai, et le lecteur sans clé reçoit son code dans la boîte d'essai, puis ouvre [R26, R113, R114].
    const store = new FicheClient(t.db, { now: t.now });
    const ready = (await store.createPerson({ networkId: t.network, agentId: t.alex, firstName: 'Dominique', lastName: 'Exemple' })).id;
    await store.addIdentifier({ networkId: t.network, personId: ready, kind: 'email', value: 'dominique.exemple@example.test' });
    await t.db.run(
      `INSERT INTO compliance_vault_pieces (id, network_id, person_id, kind, storage_ref, sha256, content_type, size_bytes, verified_on, deposited_by, deposited_at)
       VALUES ('piece-1', ?, ?, 'carte_identite', 'coffre/piece-1.pdf', ?, 'application/pdf', 1000, '2027-09-01', ?, '2027-09-01T08:00:00.000Z')`,
      [t.network, ready, 'c'.repeat(64), `agent:${t.alex}`],
    );
    const lastCode = async (like: string): Promise<string> => {
      const [row] = await enClair(t.db.all<{ id: string; body: string }>('SELECT m.id, m.body FROM messages m JOIN trial_outbox o ON o.message_id = m.id WHERE m.person_id = ? AND m.body LIKE ? ORDER BY m.rowid DESC LIMIT 1', [ready, like]));
      return /(\d{6})/.exec(row?.body ?? '')?.[1] ?? '';
    };
    const nda = (await t.call('alex', 'POST', `/commerces/${t.shop}/demandes`, { personId: ready })).body.data.ndaId as string;
    const session = (await t.call('alex', 'POST', `/commerces/engagements/${nda}/signature`, { consentProof: 'accord au rendez-vous' })).body.data.sessionId as string;
    expect((await t.call('alex', 'POST', `/commerces/signatures/${session}`, { code: await lastCode('%engagement de confidentialité%') })).status).toBe(200);
    expect((await t.call('alex', 'POST', `/commerces/${t.shop}/dossiers`, { personId: ready, consentProof: 'accord au rendez-vous' })).status).toBe(200);
    const [link] = await enClair(t.db.all<{ id: string; body: string }>('SELECT m.id, m.body FROM messages m JOIN trial_outbox o ON o.message_id = m.id WHERE m.person_id = ? AND m.body LIKE ?', [ready, '%dossier confidentiel du commerce%']));
    const token = /dossier\/([a-z]{40})/.exec(link?.body ?? '')?.[1] ?? '';
    expect(link?.body).toContain('https://app.example.test/dossier/');
    expect((await t.anonymous('POST', `/dossier/${token}/code`, { email: 'dominique.exemple@example.test' })).status).toBe(200);
    const opened = await t.anonymous('POST', `/dossier/${token}`, { email: 'dominique.exemple@example.test', code: await lastCode('%code pour ouvrir%') });
    expect(opened.status).toBe(200);
    // Tout est passé par la boîte d'essai, rien n'est parti réellement.
    expect(await t.db.all('SELECT 1 FROM messages m WHERE m.person_id = ? AND m.id NOT IN (SELECT message_id FROM trial_outbox)', [ready])).toHaveLength(0);
  });

  it('[R114] les routes du lecteur sont servies sans clé ; un jeton inconnu est refusé et journalisé', async () => {
    const t = await setup();
    const token = 'abcdefghijklmnopqrstuvwxyzabcdefghijklmn';
    expect(await t.anonymous('POST', `/dossier/${token}/code`, { email: 'x@example.test' })).toMatchObject({ status: 404, body: { code: 'inconnu' } });
    expect(await t.anonymous('POST', `/dossier/${token}`, { email: 'x@example.test', code: '123456' })).toMatchObject({ status: 404, body: { code: 'inconnu' } });
    expect((await t.anonymous('GET', `/dossier/${token}`)).status).toBe(405);
    expect((await t.journal.all()).filter((x) => x.type === 'commerces.dossier.refuse')).toHaveLength(2);
    // Toute autre route de M16 demande une clé.
    expect((await t.anonymous('GET', `/commerces/${t.shop}/public`)).status).toBe(401);
  });

  it('[R116] [R118] la tâche quotidienne de la cession passe une fois par créneau, rien n’est envoyé', async () => {
    const t = await setup();
    expect((await t.call('direction', 'POST', '/commerces/perimetres', { postalCode: '21000', city: 'Dijon', inPerimeter: false, source: 'Liste inventée', sourceDate: '2026-06-30' })).status).toBe(200);
    await t.call('alex', 'POST', `/commerces/${t.shop}/fiche`, { activity: 'restaurant', employees: 3 });
    const file = (await t.call('alex', 'POST', `/commerces/${t.shop}/cession`)).body.data.fileId as string;
    // 3 salariés, cession prévue le 15 octobre : informer au plus tard le 15 août (dimanche), avancé au vendredi 13.
    await t.call('alex', 'POST', `/commerces/cessions/${file}/dates`, { kind: 'cession_prevue', day: '2027-10-15', proofRef: proof(1) });
    await t.call('alex', 'POST', `/commerces/cessions/${file}/acquereur`, { personId: t.buyer, legalPerson: false });
    const before = (await t.journal.all()).length;
    // 6 h à Paris : le créneau de la tâche quotidienne ; deux passages dans la même heure, une seule fois.
    t.setTime('2027-09-08T04:00:00.000Z');
    const first = await runScheduler({ db: t.db, mode: 'essai', now: t.now });
    const second = await runScheduler({ db: t.db, mode: 'essai', now: t.now });
    expect(first?.ran).toContain('commerces.cession_quotidienne');
    expect(second?.ran ?? []).not.toContain('commerces.cession_quotidienne');
    const tasks = await t.call('alex', 'GET', '/commerces/taches-cession');
    expect(tasks.body.data.map((x: { step: string; due: string | null }) => [x.step, x.due])).toEqual([
      ['sequestre', null],
      ['information_salaries', '2027-08-13'],
    ]);
    expect((await t.journal.all()).slice(before).filter((x) => x.type === 'commerces.cession.tache')).toHaveLength(2);
    // L'alerte de vigilance a été levée quand l'acquéreur a été rangé : une seule, lue par la conformité seule.
    const alerts = await t.call('conformite', 'GET', '/commerces/vigilance');
    expect(alerts.body.data).toHaveLength(1);
    expect((await t.call('alex', 'GET', '/commerces/vigilance')).status).toBe(403);
    expect(await t.db.all('SELECT 1 FROM trial_outbox')).toHaveLength(0);
  });
});

it('le début des liens du dossier : en https, sans chiffre, fini par une barre', () => {
  expect(dossierLinkBase('https://app.aimmo.fr/dossier/')).toBe('https://app.aimmo.fr/dossier/');
  for (const bad of [undefined, '', 'http://app.aimmo.fr/dossier/', 'https://app.aimmo.fr/dossier', 'https://app2.aimmo.fr/dossier/', 'https://app.aimmo.fr/d0ssier/']) expect(dossierLinkBase(bad), String(bad)).toBeNull();
});
