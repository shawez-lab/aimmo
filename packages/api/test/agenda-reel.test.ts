import { expect, it } from 'vitest';
import { FicheClient, RendezVous, SqlJournalStore, applyMigrations, parisInstant, type FetchFn, type SqlDatabase, type Viewer } from '@aimmo/core';
import { handleRequest, sha256Hex } from '../src/index.ts';
import { agendasFromEnv, parseAgendaConnections, runAgendaPass, type AgendaEnv } from '../src/agenda-reel.ts';
import { agendasOf } from '../src/worker.ts';
import { fromD1 } from '../src/d1.ts';
import { SERVERS, type FakeServer } from '../../core/test/agenda-serveurs.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';
import { fakeD1 } from './fake-d1.ts';

// AU053 · les agendas de Google, Outlook et Apple branchés au Worker. Novembre 2026 : Paris est à UTC+1.
// Réseau, agents, clients, clés, jetons et mots de passe inventés.
const at = (date: string, hhmm: string): Date => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return parisInstant(date, h * 60 + m)!;
};
const NOW = at('2026-11-09', '08:00');
const KEY = 'test-cle-au053-reservation-kkkkkkkkkkkkkkkkkkkk';
const AGENT_KEY = 'test-cle-au053-agent-paul-aaaaaaaaaaaaaaaaaaaa';
const BASE = 'https://aimmo-api.example.workers.dev/v1';
const VISITOR = 'visiteur-essai-au053-000001';
const GOOGLE_ID = '123-abc.apps.googleusercontent.com';
const MS_ID = '00000000-0000-4000-8000-000000000001';
const CLIENT_SECRET = 'secret-client-essai-au053-0000';
const REFRESH = 'rafraichissement-essai-au053-0123456789';
const ACCESS = 'acces-essai-au053-0123456789';
const APPLE_PASSWORD = 'abcd-efgh-ijkl-mnop';
const APPLE_CAL = 'https://caldav.example.test/1234/calendars/home/';

const fetchOf = (server: FakeServer): FetchFn => (server as unknown as { fetch: FetchFn }).fetch;

/** Le vrai réseau, vu par les faux serveurs : l'échange de jeton OAuth, puis les adresses réelles des services. */
function network(server: FakeServer) {
  const tokenCalls: string[] = [];
  const fetch: FetchFn = async (url, init = {}) => {
    if (url === 'https://oauth2.googleapis.com/token' || url.startsWith('https://login.microsoftonline.com/')) {
      tokenCalls.push(`${url} ${init.body ?? ''}`);
      return new Response(JSON.stringify({ access_token: ACCESS, expires_in: 3600 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return fetchOf(server)(url.replace('https://www.googleapis.com/', 'https://google.example.test/').replace('https://graph.microsoft.com/', 'https://graph.example.test/'), init);
  };
  return { fetch, tokenCalls };
}

function envFor(server: FakeServer, agentId: string): AgendaEnv {
  if (server.name.startsWith('Google'))
    return { AGENDA_MODE: 'reel', AGENDA_GOOGLE_CLIENT_ID: GOOGLE_ID, AGENDA_GOOGLE_CLIENT_SECRET: CLIENT_SECRET, AGENDA_JETONS: JSON.stringify({ [agentId]: { google: REFRESH } }) };
  if (server.name.startsWith('Outlook'))
    return { AGENDA_MODE: 'reel', AGENDA_MICROSOFT_CLIENT_ID: MS_ID, AGENDA_MICROSOFT_CLIENT_SECRET: CLIENT_SECRET, AGENDA_JETONS: JSON.stringify({ [agentId]: { outlook: REFRESH } }) };
  return { AGENDA_MODE: 'reel', AGENDA_JETONS: JSON.stringify({ [agentId]: { apple: { utilisateur: 'paul.essai@example.test', motDePasse: APPLE_PASSWORD, calendrier: APPLE_CAL } } }) };
}

async function world(server: FakeServer, options: { wired?: boolean } = {}) {
  const db: SqlDatabase = fromD1(fakeD1(openMemoryDatabase()));
  await applyMigrations(db, loadMigrations());
  const store = new FicheClient(db);
  const net = await store.createNetwork('Réseau test');
  const paul = await store.createAgent({ networkId: net.id, firstName: 'Paul', lastName: 'Essai' });
  const nina = await store.createAgent({ networkId: net.id, firstName: 'Nina', lastName: 'Essai' });
  const ines = await store.createPerson({ networkId: net.id, agentId: paul.id, firstName: 'Inès', lastName: 'Durand' });
  const journal = new SqlJournalStore(db);
  const now = () => NOW;
  const rdv = new RendezVous(db, journal, { now });
  const week = { weekly: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, from: '09:00', to: '12:00' })) };
  for (const agent of [paul, nina]) await rdv.setAvailability({ role: 'agent', userId: agent.id, networkId: net.id } as Viewer, week);
  const net_ = network(server);
  const agendas = options.wired === false ? null : agendasFromEnv(envFor(server, paul.id), net_.fetch, { now });
  const intakeKeys = JSON.stringify([{ sha256: await sha256Hex(KEY), networkId: net.id, source: 'site_booking' }]);
  const apiKeys = JSON.stringify([{ sha256: await sha256Hex(AGENT_KEY), role: 'agent', userId: paul.id, networkId: net.id }]);
  const config = { db, mode: 'essai', apiKeys, intakeKeys, now, agendas };
  const call = async (path: string, body: unknown, key = KEY) => {
    const res = await handleRequest(new Request(`${BASE}${path}`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }), config as never);
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const slots = async (agentId = paul.id, from = '2026-11-10') =>
    ((await call('/rendez-vous/creneaux', { visitorId: VISITOR, agentId, kind: 'estimation', from, days: 1 })).body.slots as { start: string }[]).map((s) => s.start);
  const book = (start: Date, agentId = paul.id) =>
    call('/rendez-vous/reservation', {
      visitorId: VISITOR,
      agentId,
      kind: 'estimation',
      start: start.toISOString(),
      source: 'site',
      firstName: 'Léa',
      email: 'lea.exemple@example.test',
      consentProof: 'case cochée « J’accepte d’être contacté pour ce rendez-vous », formulaire de réservation',
    });
  const pass = () => runAgendaPass({ db, journal, now, agendas });
  const ours = () => server.live().filter((e) => e.key?.startsWith('aimmo:') && !e.cancelled);
  const booked = () => db.all<{ id: string; start_at: string; status: string }>("SELECT id, start_at, status FROM appointments WHERE status = 'booked' ORDER BY start_at");
  const journalText = async () => JSON.stringify(await journal.all());
  return { db, journal, paul, nina, ines, agendas, call, slots, book, pass, ours, booked, journalText, tokenCalls: net_.tokenCalls };
}

it('[R702] aucun agenda relié sans mise en service complète, et une entrée douteuse n’est jamais devinée', () => {
  const f: FetchFn = async () => new Response(null, { status: 500 });
  const google: AgendaEnv = { AGENDA_MODE: 'reel', AGENDA_GOOGLE_CLIENT_ID: GOOGLE_ID, AGENDA_GOOGLE_CLIENT_SECRET: CLIENT_SECRET, AGENDA_JETONS: JSON.stringify({ 'agent-1': { google: REFRESH } }) };
  expect(agendasFromEnv(google, f)?.of('agent-1')).toBe('google');
  expect(agendasFromEnv(google, f)?.of('agent-2')).toBeNull();
  for (const broken of [{ AGENDA_MODE: undefined }, { AGENDA_MODE: 'essai' }, { AGENDA_GOOGLE_CLIENT_ID: 'pas-un-client' }, { AGENDA_GOOGLE_CLIENT_SECRET: ' ' }, { AGENDA_JETONS: undefined }, { AGENDA_JETONS: 'pas du JSON' }])
    expect(agendasFromEnv({ ...google, ...broken }, f)).toBeNull();
  // Outlook demande tout son client, annuaire compris.
  const ms: AgendaEnv = { AGENDA_MODE: 'reel', AGENDA_MICROSOFT_CLIENT_ID: MS_ID, AGENDA_MICROSOFT_CLIENT_SECRET: CLIENT_SECRET, AGENDA_JETONS: JSON.stringify({ 'agent-1': { outlook: REFRESH } }) };
  expect(agendasFromEnv(ms, f)?.of('agent-1')).toBe('outlook');
  expect(agendasFromEnv({ ...ms, AGENDA_MICROSOFT_TENANT: 'a/b' }, f)).toBeNull();
  // Apple : une adresse https sans identifiants, terminée par « / », et un mot de passe d'application.
  const apple = (calendrier: string, motDePasse = APPLE_PASSWORD) => parseAgendaConnections(JSON.stringify({ 'agent-1': { apple: { utilisateur: 'agent@example.test', motDePasse, calendrier } } })).size;
  expect(apple(APPLE_CAL)).toBe(1);
  for (const bad of ['http://caldav.example.test/cal/', 'https://u:p@caldav.example.test/cal/', 'https://caldav.example.test/cal', 'https://caldav.example.test/cal/?x=1']) expect(apple(bad), bad).toBe(0);
  expect(apple(APPLE_CAL, 'court')).toBe(0);
  // Deux agendas pour un agent, un identifiant mal formé, un jeton trop court : écartés.
  const many = parseAgendaConnections(JSON.stringify({ 'agent-1': { google: REFRESH, outlook: REFRESH }, 'agent 2': { google: REFRESH }, 'agent-3': { google: 'court' }, 'agent-4': { google: REFRESH } }));
  expect([...many.keys()]).toEqual(['agent-4']);
  // Le Worker : sans `AGENDA_MODE`, aucun agenda n'est lu.
  expect(agendasOf({} as never)).toBeNull();
  expect(agendasOf({ ...google } as never)?.agents()).toEqual(['agent-1']);
});

for (const make of SERVERS) {
  const name = make().name;
  describeWithSqlite(`AU053 · l'agenda ${name} branché au Worker`, () => {
    it('[R33] [R702] un événement privé occupé de l’agent bloque réellement les créneaux et la réservation', async () => {
      // Le constat de l'audit : sans le branchement, l'événement privé de 9 h est ignoré et 9 h est proposé.
      const before = make();
      before.agentAdd(at('2026-11-10', '09:00'), at('2026-11-10', '10:00'));
      const unwired = await world(before, { wired: false });
      expect(await unwired.slots()).toContain(at('2026-11-10', '09:00').toISOString());
      expect(before.requests).toHaveLength(0);

      const server = make();
      server.agentAdd(at('2026-11-10', '09:00'), at('2026-11-10', '10:00'));
      const w = await world(server);
      const slots = await w.slots();
      expect(slots.length).toBeGreaterThan(0);
      expect(slots).not.toContain(at('2026-11-10', '09:00').toISOString());
      const refused = await w.book(at('2026-11-10', '09:00'));
      // En ligne, l'heure n'est plus un créneau libre : refusée comme telle, rien n'est dit de l'agenda.
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ ok: false, code: 'not_free' });
      expect(await w.booked()).toHaveLength(0);
      // L'agent, pour son client, est refusé de même.
      const asAgent = await w.call('/rendez-vous', { personId: w.ines.id, kind: 'appel', start: at('2026-11-10', '09:30').toISOString() }, AGENT_KEY);
      expect(asAgent.body).toMatchObject({ ok: false, rule: 'R33' });
      // Un événement « disponible » ne bloque rien [R236].
      const free = make();
      free.agentAdd(at('2026-11-10', '09:00'), at('2026-11-10', '10:00'), { free: true });
      expect(await (await world(free)).slots()).toContain(at('2026-11-10', '09:00').toISOString());
    });

    it('[R236] [R702] un rendez-vous réservé est écrit une fois ; déplacé dans l’agenda, il revient sur AIMMO sans doublon', async () => {
      const server = make();
      const w = await world(server);
      const first = (await w.slots())[0]!;
      const ok = await w.book(new Date(first));
      expect(ok.status).toBe(200);
      expect(await w.pass()).toBe('fait');
      expect(await w.pass()).toBe('fait');
      expect(w.ours()).toHaveLength(1);
      expect(w.ours()[0]!.start.toISOString()).toBe(first);
      // L'agent déplace l'événement au lendemain 10 h : le rendez-vous suit, l'agenda garde un seul événement.
      server.agentMove(w.ours()[0]!.id, at('2026-11-11', '10:00'), at('2026-11-11', '11:00'));
      expect(await w.pass()).toBe('fait');
      expect(await w.pass()).toBe('fait');
      expect((await w.booked()).map((a) => a.start_at)).toEqual([at('2026-11-11', '10:00').toISOString()]);
      expect(w.ours()).toHaveLength(1);
      expect(w.ours()[0]!.start.toISOString()).toBe(at('2026-11-11', '10:00').toISOString());
      // L'ancienne heure est libre de nouveau, la nouvelle ne l'est plus.
      expect(await w.slots(w.paul.id, '2026-11-11')).not.toContain(at('2026-11-11', '10:00').toISOString());
      // Les appels portent l'autorisation de l'agent ; ni nom, ni adresse, ni jeton dans ce qui part ou au journal.
      const auth = name.startsWith('Apple') ? `Basic ${btoa(`paul.essai@example.test:${APPLE_PASSWORD}`)}` : `Bearer ${ACCESS}`;
      expect(server.requests.every((r) => r.auth === auth)).toBe(true);
      if (!name.startsWith('Apple')) expect(w.tokenCalls.length).toBeGreaterThan(0);
      const sent = server.requests.map((r) => r.url + r.body).join('\n');
      for (const secret of ['Léa', 'lea.exemple', REFRESH, CLIENT_SECRET]) expect(sent, secret).not.toContain(secret);
      const text = await w.journalText();
      for (const secret of [REFRESH, CLIENT_SECRET, ACCESS, APPLE_PASSWORD]) expect(text, secret).not.toContain(secret);
    });

    it('[R13] [R702] un agenda injoignable ferme la réservation sans rien réserver ; le passage note la panne et reprend', async () => {
      const server = make();
      const w = await world(server);
      server.failNext = 503;
      const slots = await w.call('/rendez-vous/creneaux', { visitorId: VISITOR, agentId: w.paul.id, kind: 'estimation', from: '2026-11-10', days: 1 });
      expect(slots.status).toBe(503);
      expect(slots.body).toMatchObject({ ok: false, code: 'agenda_indisponible', rule: 'R702' });
      server.failNext = 503;
      expect((await w.book(at('2026-11-10', '10:30'))).body).toMatchObject({ ok: false, code: 'agenda_indisponible' });
      expect(await w.booked()).toHaveLength(0);
      // Réservé, puis l'agenda tombe au passage : la réservation reste, l'écriture est reprise ensuite.
      expect((await w.book(at('2026-11-10', '10:30'))).status).toBe(200);
      server.failNext = 503;
      expect(await w.pass()).toBe('panne');
      expect(await w.booked()).toHaveLength(1);
      expect(await w.pass()).toBe('fait');
      expect(w.ours()).toHaveLength(1);
      const text = await w.journalText();
      expect(text).toContain('rdv.agenda.panne');
      for (const secret of [REFRESH, CLIENT_SECRET, ACCESS, APPLE_PASSWORD]) expect(text, secret).not.toContain(secret);
    });

    it('[R702] un agent sans agenda relié n’est jamais appelé chez le fournisseur', async () => {
      const server = make();
      const w = await world(server);
      const slots = await w.slots(w.nina.id);
      expect((await w.book(new Date(slots[0]!), w.nina.id)).status).toBe(200);
      expect(server.requests).toHaveLength(0);
      // Au passage, seul l'agenda de Paul est lu ; le rendez-vous de Nina n'est écrit nulle part.
      expect(await w.pass()).toBe('fait');
      expect(server.requests.filter((r) => r.method !== 'GET' && r.method !== 'REPORT' && !(r.method === 'POST' && r.url.includes('calendarView')))).toHaveLength(0);
      expect(w.ours()).toHaveLength(0);
      expect(w.agendas?.agents()).toEqual([w.paul.id]);
    });
  });
}
