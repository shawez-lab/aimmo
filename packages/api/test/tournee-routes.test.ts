import { expect, it } from 'vitest';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { parisInstant, withinAvailability, type Availability } from '../../core/src/rendezvous/creneaux.ts';
import { FicheClient, RendezVous, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../../core/src/index.ts';
import type { Geocoder } from '../../core/src/estimation/collecte.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Le mardi 10 novembre 2026, 7 h à Paris. Réseau, agents, adresses, positions et clés d'API inventés.
const DAY = '2026-11-10';
const at = (date: string, hhmm: string): Date => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return parisInstant(date, h * 60 + m)!;
};
const NOW = at(DAY, '07:00');
const WEEK: Availability = {
  weekly: [1, 2, 3, 4, 5].flatMap((weekday) => [
    { weekday, from: '09:00', to: '12:00' },
    { weekday, from: '14:00', to: '18:00' },
  ]),
};
const KEYS = {
  paul: 'test-cle-br28-paul-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  direction: 'test-cle-br28-direction-cccccccccccccccccccccc',
  conformite: 'test-cle-br28-conformite-ddddddddddddddddddddd',
};
type Who = keyof typeof KEYS;

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = () => NOW;
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const net = await store.createNetwork('Réseau test');
  const paul = await store.createAgent({ networkId: net.id, firstName: 'Paul', lastName: 'Essai' });
  await db.run("INSERT INTO agent_zones (id, network_id, agent_id, commune, created_at, ended_at) VALUES (?, ?, ?, 'Talant', '2026-01-01T00:00:00.000Z', NULL)", [crypto.randomUUID(), net.id, paul.id]);
  const asPaul = { role: 'agent' as const, userId: paul.id, networkId: net.id };
  expect(await new RendezVous(db, journal, { now }).setAvailability(asPaul, WEEK)).toEqual({ ok: true });
  const client = await store.createPerson({ networkId: net.id, agentId: paul.id, firstName: 'Léa', lastName: 'Cliente' });
  const p1 = await store.createProperty({ networkId: net.id, agentId: paul.id, reference: 'T1', kind: 'home', postalCode: '21240', city: 'Talant' });
  const p2 = await store.createProperty({ networkId: net.id, agentId: paul.id, reference: 'D1', kind: 'home', postalCode: '21000', city: 'Dijon' });
  const iso = NOW.toISOString();
  // Une visite déjà prise, 10 h à 10 h 45.
  await db.run(
    "INSERT INTO appointments (id, network_id, agent_id, person_id, property_id, kind, start_at, end_at, status, token_hash, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'visite', ?, ?, 'booked', ?, 'agent', ?, ?)",
    [crypto.randomUUID(), net.id, paul.id, client.id, p1.id, at(DAY, '10:00').toISOString(), at(DAY, '10:45').toISOString(), crypto.randomUUID(), iso, iso],
  );
  // Deux panneaux à récupérer : l'un à Talant, l'autre à Dijon, hors de la zone de Paul.
  const sign = async (number: number, propertyId: string, streetNumber: string, street: string, postcode: string, city: string) => {
    const signId = crypto.randomUUID();
    const placementId = crypto.randomUUID();
    await db.run("INSERT INTO signs (id, network_id, number, size, created_by, created_at) VALUES (?, ?, ?, 'grand', 'direction:d1', ?)", [signId, net.id, number, iso]);
    await db.run(
      "INSERT INTO sign_placements (id, network_id, sign_id, property_id, agent_id, mandate_id, street_number, street, postcode, city, placed_by, placed_at) VALUES (?, ?, ?, ?, ?, 'm1', ?, ?, ?, ?, 'agent:x', ?)",
      [placementId, net.id, signId, propertyId, paul.id, streetNumber, street, postcode, city, iso],
    );
    await db.run("INSERT INTO sign_pickup_tasks (placement_id, network_id, agent_id, reason, detail, due_day, created_at) VALUES (?, ?, ?, 'vendu', NULL, '2026-11-09', ?)", [placementId, net.id, paul.id, iso]);
  };
  await sign(12, p1.id, '3', 'Rue des Essais', '21240', 'Talant');
  await sign(13, p2.id, '8', 'Rue Hors Zone', '21000', 'Dijon');
  const geocoded: string[] = [];
  const geocoder: Geocoder = {
    geocode: async (address) => {
      geocoded.push(address);
      return address.startsWith('3 Rue des Essais 21240')
        ? { label: '3 Rue des Essais 21240 Talant', lat: 47.3401234, lon: 5.0049876, postalCode: '21240', inseeCode: '21617', town: 'Talant', banId: 'b1', score: 0.95 }
        : null;
    },
  };
  const ids: Record<Who, { role: string; userId: string }> = {
    paul: { role: 'agent', userId: paul.id },
    direction: { role: 'direction', userId: 'direction-1' },
    conformite: { role: 'compliance', userId: 'conformite-1' },
  };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: net.id, ...ids[w] }))));
  const config: ApiConfig = { db, apiKeys, mode: 'essai', now, estimation: { geocoder, sales: {} as never } };
  const http = async (who: Who, path: string) => {
    const r = await handleRequest(new Request(`https://aimmo-api.example.test/v1${path}`, { method: 'GET', headers: { authorization: `Bearer ${KEYS[who]}` } }), config);
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; rule?: string | null; code?: string; mode?: string; field?: string } };
  };
  const refusals = async () => (await journal.all()).filter((e) => e.type === 'acces.refuse' && e.data.kind === 'tournee_prospection');
  return { http, refusals, geocoded };
}

describeWithSqlite('BR28 · routes de la carte des opportunités et de la tournée', () => {
  it('[R16] [R297] la direction et tout autre rôle sont refusés en 403, au journal, sans rien lire', async () => {
    const t = await setup();
    for (const who of ['direction', 'conformite'] as const) {
      for (const path of ['/tournee', '/tournee/carte', `/tournee?date=${DAY}`]) {
        const r = await t.http(who, path);
        expect(r.status, `${who} ${path}`).toBe(403);
        expect(r.body).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
      }
    }
    expect((await t.refusals()).length).toBe(6);
    expect(t.geocoded).toEqual([]);
  });

  it('[R297] [R299] la carte ne montre que la zone de l’agent, compte le reste ; la vue des rues ne porte que la position', async () => {
    const t = await setup();
    const r = await t.http('paul', '/tournee/carte');
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe('essai');
    expect(r.body.data.agendaRelie).toBe(false);
    expect(r.body.data.outsideZone).toBe(1);
    expect(r.body.data.opportunities).toHaveLength(1);
    const o = r.body.data.opportunities[0];
    expect(o).toMatchObject({ kind: 'panneau', town: 'Talant', addresses: ['3 Rue des Essais, 21240 Talant'] });
    expect(o.streetView).toBe('https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=47.34012,5.00499');
    expect(JSON.stringify(r.body)).not.toMatch(/Hors Zone|Dijon|Léa|Cliente|key=/);
    // Le panneau hors zone n'est jamais géocodé.
    expect(t.geocoded.some((a) => a.includes('Hors Zone'))).toBe(false);
  });

  it('[R298] la tournée du jour tient dans les disponibilités de l’agent, autour de sa visite, sans date le jour de Paris', async () => {
    const t = await setup();
    const a = await t.http('paul', `/tournee?date=${DAY}`);
    const b = await t.http('paul', '/tournee');
    expect(a.status).toBe(200);
    expect(b.body.data).toEqual(a.body.data);
    const tour = a.body.data;
    expect(tour.date).toBe(DAY);
    expect(tour.agendaRelie).toBe(false);
    expect(tour.outsideZone).toBe(1);
    const kinds = tour.stops.map((s: { kind: string }) => s.kind);
    expect(kinds).toContain('rendez-vous');
    expect(kinds).toContain('panneau');
    for (const s of tour.stops as { kind: string; start: string; end: string }[]) {
      const start = new Date(s.start);
      const end = new Date(s.end);
      expect(withinAvailability({ start, end }, WEEK), `${s.kind} ${s.start}`).toBe(true);
    }
    // Aucun arrêt de prospection ne chevauche la visite.
    const visit = tour.stops.find((s: { kind: string }) => s.kind === 'rendez-vous');
    for (const s of tour.stops.filter((x: { kind: string }) => x.kind !== 'rendez-vous') as { start: string; end: string }[]) {
      expect(new Date(s.end) <= new Date(visit.start) || new Date(s.start) >= new Date(visit.end)).toBe(true);
    }
  });

  it('[R298] une date mal formée est refusée en 409 ; un paramètre non prévu ou répété en 400', async () => {
    const t = await setup();
    expect((await t.http('paul', '/tournee?date=2026-02-30')).body).toMatchObject({ ok: false, rule: 'R298', code: 'bad_date' });
    expect((await t.http('paul', '/tournee/carte?date=demain')).status).toBe(409);
    expect((await t.http('paul', '/tournee?agent=autre')).body).toMatchObject({ code: 'unknown_field', field: 'agent' });
    expect((await t.http('paul', `/tournee?date=${DAY}&date=2026-11-11`)).body).toMatchObject({ code: 'unknown_field', field: 'date' });
    expect(t.geocoded).toEqual([]);
  });
});
