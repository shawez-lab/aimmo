import { expect, it } from 'vitest';
import { DEFAULT_SLOT_SETTINGS, conflictOf, parisInstant, withinAvailability, type Availability, type BookedInterval } from '../src/rendezvous/creneaux.ts';
import { roadEstimate, type Place } from '../src/rendezvous/trajets.ts';
import { TourneeProspection, streetViewLink, type Tour, type TourStop } from '../src/tournee-prospection/tournee.ts';
import { FicheClient, RendezVous, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '../src/index.ts';
import type { Geocoder } from '../src/estimation/collecte.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Novembre 2026, Paris à UTC+1 ; le mardi 10 novembre. Réseau, agents, adresses et positions inventés.
const at = (date: string, hhmm: string): Date => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return parisInstant(date, h * 60 + m)!;
};
const DAY = '2026-11-10';
const NOW = at(DAY, '07:00');
const WEEK: Availability = {
  weekly: [1, 2, 3, 4, 5].flatMap((weekday) => [
    { weekday, from: '09:00', to: '12:00' },
    { weekday, from: '14:00', to: '18:00' },
  ]),
};
const MIN = 60_000;
const VISIT_PLACE: Place = { lat: 47.336, lon: 5.01 };
const SIGN_PLACE: Place = { lat: 47.3401234, lon: 5.0049876 };
const CENTER: Place = { lat: 47.335, lon: 5.005 };
const DPE_PLACE: Place = { lat: 47.338, lon: 5.0 };

describeWithSqlite('HX19 · carte des opportunités et tournée de prospection', () => {
  async function world(options: { availability?: Availability; busy?: { start: Date; end: Date }[] } = {}) {
    const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
    await applyMigrations(db, loadMigrations());
    const now = () => NOW;
    const journal = new SqlJournalStore(db);
    const store = new FicheClient(db, { now });
    const net = await store.createNetwork('Réseau test');
    const paul = await store.createAgent({ networkId: net.id, firstName: 'Paul', lastName: 'Essai' });
    const zoe = await store.createAgent({ networkId: net.id, firstName: 'Zoé', lastName: 'Exemple' });
    const zone = (agentId: string, commune: string) =>
      db.run("INSERT INTO agent_zones (id, network_id, agent_id, commune, created_at, ended_at) VALUES (?, ?, ?, ?, '2026-01-01T00:00:00.000Z', NULL)", [crypto.randomUUID(), net.id, agentId, commune]);
    await zone(paul.id, 'Talant');
    await zone(paul.id, 'Fontaine-lès-Dijon');
    await zone(zoe.id, 'Dijon');
    const asPaul: Viewer = { role: 'agent', userId: paul.id, networkId: net.id };
    const asZoe: Viewer = { role: 'agent', userId: zoe.id, networkId: net.id };
    const rdv = new RendezVous(db, journal, { now });
    expect(await rdv.setAvailability(asPaul, options.availability ?? WEEK)).toEqual({ ok: true });

    const client = await store.createPerson({ networkId: net.id, agentId: paul.id, firstName: 'Léa', lastName: 'Cliente' });
    const p1 = await store.createProperty({ networkId: net.id, agentId: paul.id, reference: 'T1', kind: 'home', postalCode: '21240', city: 'Talant' });
    const p2 = await store.createProperty({ networkId: net.id, agentId: paul.id, reference: 'D1', kind: 'home', postalCode: '21000', city: 'Dijon' });
    const iso = NOW.toISOString();

    // Un rendez-vous de visite déjà pris, 10 h à 10 h 45, à Talant.
    const appointment = (start: Date, end: Date, kind = 'visite', propertyId: string | null = p1.id) =>
      db.run(
        "INSERT INTO appointments (id, network_id, agent_id, person_id, property_id, kind, start_at, end_at, status, token_hash, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'booked', ?, 'agent', ?, ?)",
        [crypto.randomUUID(), net.id, paul.id, client.id, propertyId, kind, start.toISOString(), end.toISOString(), crypto.randomUUID(), iso, iso],
      );
    await appointment(at(DAY, '10:00'), at(DAY, '10:45'));

    // Deux panneaux à récupérer : l'un à Talant, l'autre à Dijon, hors des zones de Paul.
    const sign = async (number: number, propertyId: string, streetNumber: string, street: string, postcode: string, city: string, dueDay = '2026-11-09') => {
      const signId = crypto.randomUUID();
      const placementId = crypto.randomUUID();
      await db.run("INSERT INTO signs (id, network_id, number, size, created_by, created_at) VALUES (?, ?, ?, 'grand', 'direction:d1', ?)", [signId, net.id, number, iso]);
      await db.run(
        "INSERT INTO sign_placements (id, network_id, sign_id, property_id, agent_id, mandate_id, street_number, street, postcode, city, placed_by, placed_at) VALUES (?, ?, ?, ?, ?, 'm1', ?, ?, ?, ?, 'agent:x', ?)",
        [placementId, net.id, signId, propertyId, paul.id, streetNumber, street, postcode, city, iso],
      );
      await db.run("INSERT INTO sign_pickup_tasks (placement_id, network_id, agent_id, reason, detail, due_day, created_at) VALUES (?, ?, ?, 'vendu', NULL, ?, ?)", [placementId, net.id, paul.id, dueDay, iso]);
      return placementId;
    };
    const signTalant = await sign(12, p1.id, '3', 'Rue des Essais', '21240', 'Talant');
    await sign(13, p2.id, '8', 'Rue Hors Zone', '21000', 'Dijon');
    await sign(14, p1.id, '5', 'Rue Plus Tard', '21240', 'Talant', '2026-11-20');

    // Une campagne de lettres : trois à Talant, une à Dijon.
    const campaignId = crypto.randomUUID();
    await db.run(
      "INSERT INTO neighbourhood_campaigns (id, network_id, agent_id, property_id, trigger, recipient, radius_m, center_lat, center_lon, text, text_by, created_at) VALUES (?, ?, ?, ?, 'mandat', 'aux_habitants', 500, ?, ?, 'Un texte de lettre inventé pour le test.', 'secours', ?)",
      [campaignId, net.id, paul.id, p1.id, CENTER.lat, CENTER.lon, iso],
    );
    const letters: [string, string, string, string][] = [
      ['1', 'Allée des Tests', '21240', 'Talant'],
      ['2', 'Allée des Tests', '21240', 'Talant'],
      ['4', 'Allée des Tests', '21240', 'Talant'],
      ['9', 'Rue de la Frontière', '21000', 'Dijon'],
    ];
    for (const [i, [n, street, pc, city]] of letters.entries()) {
      await db.run(
        'INSERT INTO neighbourhood_letters (id, campaign_id, network_id, street_number, street, postcode, city, distance_m, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 100, ?, ?)',
        [crypto.randomUUID(), campaignId, net.id, n, street, pc, city, i + 1, iso],
      );
    }

    // La veille : un secteur à Talant, un diagnostic G placé, un sans position ; un secteur de Dijon chez Zoé.
    const sectorId = crypto.randomUUID();
    await db.run("INSERT INTO dpe_watch_sectors (id, network_id, agent_id, commune, commune_slug, postcode, created_by, created_at) VALUES (?, ?, ?, 'Talant', 'talant', '21240', 'agent:x', ?)", [sectorId, net.id, paul.id, iso]);
    const diagnosis = async (number: string, street: string, place: Place | null, alertedOn = '2026-11-09') => {
      const id = crypto.randomUUID();
      await db.run(
        "INSERT INTO dpe_diagnoses (id, network_id, number, kind, energy_class, ghg_class, surface_m2, diagnosed_on, received_on, street_number, street, postcode, commune, commune_slug, lat, lon, first_seen_at) VALUES (?, ?, ?, 'house', 'G', 'F', 80, '2026-11-02', '2026-11-03', '6', ?, '21240', 'Talant', 'talant', ?, ?, ?)",
        [id, net.id, number, street, place?.lat ?? null, place?.lon ?? null, iso],
      );
      await db.run('INSERT INTO dpe_alert_items (sector_id, diagnosis_id, network_id, alerted_on, created_at) VALUES (?, ?, ?, ?, ?)', [sectorId, id, net.id, alertedOn, iso]);
      return id;
    };
    const dpeId = await diagnosis('2621E0000001T', 'Chemin du Diagnostic', DPE_PLACE);
    const dpeUnknown = await diagnosis('2621E0000002T', 'Impasse Sans Point', null);
    await diagnosis('2621E0000003T', 'Rue Trop Ancienne', DPE_PLACE, '2026-10-01');

    const geocoded: string[] = [];
    const geocoder: Geocoder = {
      geocode: async (address) => {
        geocoded.push(address);
        if (address.startsWith('3 Rue des Essais 21240'))
          return { label: '3 Rue des Essais 21240 Talant', lat: SIGN_PLACE.lat, lon: SIGN_PLACE.lon, postalCode: '21240', inseeCode: '21617', town: 'Talant', banId: 'b1', score: 0.95 };
        return null;
      },
    };
    const places = { placeOf: async (id: string) => (id === p1.id ? VISIT_PLACE : null) };
    const busy = options.busy ?? [];
    const tournee = new TourneeProspection(db, journal, { now, geocoder, places, agenda: { busy: async () => busy } });
    return { db, journal, net, paul, zoe, asPaul, asZoe, tournee, appointment, signTalant, campaignId, dpeId, dpeUnknown, geocoded, rdv };
  }

  const prospectStops = (tour: Tour) => tour.stops.filter((s): s is Extract<TourStop, { opportunityId: string }> => s.kind !== 'rendez-vous');

  it('[R298] Jamais vu : une seule tournée mêle la visite du jour, le panneau, les lettres et le diagnostic, calée dans le temps libre', async () => {
    const w = await world();
    const tour = await w.tournee.plan(w.asPaul, DAY);
    expect(tour.ok).toBe(true);
    if (!tour.ok) return;
    expect(new Set(tour.stops.map((s) => s.kind))).toEqual(new Set(['rendez-vous', 'panneau', 'lettres', 'diagnostic']));
    expect(tour.stops.find((s) => s.kind === 'rendez-vous')).toMatchObject({ appointmentKind: 'visite', town: 'Talant', start: at(DAY, '10:00') });
    expect(tour.left).toEqual([{ opportunityId: `diagnostic:${w.dpeUnknown}`, kind: 'diagnostic', reason: 'lieu_inconnu' }]);
    // Les lettres : trois, trois fois deux minutes.
    const lots = prospectStops(tour).find((s) => s.kind === 'lettres')!;
    expect(lots.end.getTime() - lots.start.getTime()).toBe(6 * MIN);
    expect(lots.addresses).toHaveLength(3);
    // Les arrêts sont dans l'ordre, au plus tôt : le premier commence à l'ouverture de la plage, 9 h.
    const starts = tour.stops.map((s) => s.start.getTime());
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(prospectStops(tour)[0]!.start).toEqual(at(DAY, '09:00'));
  });

  it('[R298] chaque arrêt tient dans les disponibilités, hors des rendez-vous trajet compris, et laisse la route estimée entre voisins', async () => {
    const w = await world();
    const tour = await w.tournee.plan(w.asPaul, DAY);
    if (!tour.ok) throw new Error('tournée refusée');
    const booked: BookedInterval[] = [{ kind: 'visite', start: at(DAY, '10:00'), end: at(DAY, '10:45') }];
    const placeOf = (s: TourStop): Place =>
      s.kind === 'rendez-vous' ? VISIT_PLACE : s.kind === 'panneau' ? SIGN_PLACE : s.kind === 'lettres' ? CENTER : DPE_PLACE;
    for (const s of prospectStops(tour)) {
      expect(withinAvailability(s, WEEK)).toBe(true);
      expect(conflictOf({ kind: 'visite', start: s.start, end: s.end }, booked, [], DEFAULT_SLOT_SETTINGS)).toBeNull();
    }
    for (let i = 1; i < tour.stops.length; i++) {
      const prev = tour.stops[i - 1]!;
      const next = tour.stops[i]!;
      let needed = roadEstimate(placeOf(prev), placeOf(next));
      if (prev.kind === 'rendez-vous' || next.kind === 'rendez-vous') needed = Math.max(needed, DEFAULT_SLOT_SETTINGS.travelMinutes);
      expect(next.start.getTime() - prev.end.getTime()).toBeGreaterThanOrEqual(needed * MIN);
      if (next.kind !== 'rendez-vous') expect(next.travelMinutes).toBe(needed);
    }
  });

  it('[R298] ce qui ne tient pas est dit « pas de place » ; un jour fermé ne place rien ; un événement occupé est évité ; rien n’est réservé', async () => {
    const tight = await world({ availability: { ...WEEK, exceptions: [{ date: DAY, ranges: [{ from: '08:00', to: '08:15' }] }] } });
    // Au plus tôt fini d'abord : les lettres (6 min) ; le reste n'a plus la route pour tenir avant 8 h 15.
    const one = await tight.tournee.plan(tight.asPaul, DAY);
    if (!one.ok) throw new Error('tournée refusée');
    expect(prospectStops(one)).toHaveLength(1);
    expect(prospectStops(one)[0]).toMatchObject({ kind: 'lettres', start: at(DAY, '08:00'), end: at(DAY, '08:06') });
    expect(one.left.filter((l) => l.reason === 'pas_de_place').map((l) => l.kind).sort()).toEqual(['diagnostic', 'panneau']);

    const closed = await world({ availability: { ...WEEK, exceptions: [{ date: DAY, ranges: [] }] } });
    const none = await closed.tournee.plan(closed.asPaul, DAY);
    if (!none.ok) throw new Error('tournée refusée');
    expect(prospectStops(none)).toEqual([]);
    expect(none.left.filter((l) => l.reason === 'pas_de_place')).toHaveLength(3);

    // Un événement occupé de 9 h à 9 h 30 : rien avant 10 h (trajet de 30 min autour de lui), et la visite de 10 h.
    const busy = await world({ busy: [{ start: at(DAY, '09:00'), end: at(DAY, '09:30') }] });
    const after = await busy.tournee.plan(busy.asPaul, DAY);
    if (!after.ok) throw new Error('tournée refusée');
    for (const s of prospectStops(after)) {
      expect(s.end.getTime() + 30 * MIN <= at(DAY, '09:00').getTime() || s.start.getTime() >= at(DAY, '09:30').getTime() + 30 * MIN).toBe(true);
    }
    const count = await busy.db.first<{ n: number }>("SELECT count(*) AS n FROM appointments WHERE status = 'booked'");
    expect(count?.n).toBe(1);
    // Rien d'envoyé : aucune décision d'envoi rangée.
    const sends = await busy.db.first<{ n: number }>('SELECT count(*) AS n FROM send_log');
    expect(sends?.n).toBe(0);
  });

  it('[R298] la tournée ne commence pas avant maintenant, et refuse une date non valable', async () => {
    const w = await world();
    const late = new TourneeProspection(w.db, w.journal, { now: () => at(DAY, '15:02') });
    const tour = await late.plan(w.asPaul, DAY);
    if (!tour.ok) throw new Error('tournée refusée');
    for (const s of prospectStops(tour)) expect(s.start.getTime()).toBeGreaterThanOrEqual(at(DAY, '15:05').getTime());
    expect(await w.tournee.plan(w.asPaul, '2026-02-31')).toEqual({ ok: false, rule: 'R298', code: 'bad_date' });
    expect(await w.tournee.map(w.asPaul, 'demain')).toEqual({ ok: false, rule: 'R298', code: 'bad_date' });
  });

  it('[R298] depuis l’agence, la route vers le premier arrêt se compte depuis maintenant, jamais avant', async () => {
    const w = await world();
    // L'agence à une heure et plus de route : à 9 h, rien ne peut commencer avant 9 h plus ce trajet.
    const base: Place = { lat: 47.9, lon: 5.0 };
    // Sans la visite de 10 h, le premier arrêt ne peut partir que de l'agence.
    await w.db.run("UPDATE appointments SET status = 'cancelled', cancelled_at = ?", [NOW.toISOString()]);
    const late = new TourneeProspection(w.db, w.journal, { now: () => at(DAY, '09:00') });
    const tour = await late.plan(w.asPaul, DAY, base);
    if (!tour.ok) throw new Error('tournée refusée');
    const placeOf = (s: TourStop): Place => (s.kind === 'panneau' ? SIGN_PLACE : s.kind === 'lettres' ? CENTER : DPE_PLACE);
    const first = prospectStops(tour)[0]!;
    expect(tour.stops.some((x) => x.kind === 'rendez-vous')).toBe(false);
    expect(first.travelMinutes).toBe(roadEstimate(base, placeOf(first)));
    const needed = roadEstimate(base, placeOf(first));
    expect(needed).toBeGreaterThan(60);
    // Sans cette règle, le premier arrêt tomberait à 9 h avec plus d'une heure de route à faire avant.
    expect(first.start.getTime()).toBeGreaterThanOrEqual(at(DAY, '09:00').getTime() + needed * MIN);
  });

  it('[R298] la route se fait dans le temps libre : jamais pendant un événement occupé', async () => {
    // Maintenant 9 h, occupé de 9 h à 11 h, aucune visite, agence à plus d'une heure : rien n'arrive avant 11 h plus la route.
    const w = await world({ busy: [{ start: at(DAY, '09:00'), end: at(DAY, '11:00') }] });
    await w.db.run("UPDATE appointments SET status = 'cancelled', cancelled_at = ?", [NOW.toISOString()]);
    const base: Place = { lat: 47.9, lon: 5.0 };
    const late = new TourneeProspection(w.db, w.journal, { now: () => at(DAY, '09:00'), agenda: { busy: async () => [{ start: at(DAY, '09:00'), end: at(DAY, '11:00') }] } });
    const tour = await late.plan(w.asPaul, DAY, base);
    if (!tour.ok) throw new Error('tournée refusée');
    const placeOf = (s: TourStop): Place => (s.kind === 'panneau' ? SIGN_PLACE : s.kind === 'lettres' ? CENTER : DPE_PLACE);
    const first = prospectStops(tour)[0]!;
    expect(first.start.getTime()).toBeGreaterThanOrEqual(at(DAY, '11:00').getTime() + roadEstimate(base, placeOf(first)) * MIN);
    // Et la route vers une visite fixe ne traverse pas un événement occupé.
    const v = await world({ busy: [{ start: at(DAY, '09:20'), end: at(DAY, '09:25') }] });
    const t2 = await v.tournee.plan(v.asPaul, DAY);
    if (!t2.ok) throw new Error('tournée refusée');
    for (const s of prospectStops(t2)) {
      const visit = at(DAY, '10:00').getTime();
      if (s.end.getTime() <= visit) expect(s.end.getTime() >= at(DAY, '09:25').getTime() || s.end.getTime() + 30 * MIN <= at(DAY, '09:20').getTime()).toBe(true);
    }
  });

  it('[R298] le total de route compte chaque trajet de la journée, jusqu’au rendez-vous fixe compris', async () => {
    const w = await world({ availability: { ...WEEK, exceptions: [{ date: DAY, ranges: [{ from: '08:00', to: '08:15' }, { from: '09:00', to: '12:00' }] }] } });
    const tour = await w.tournee.plan(w.asPaul, DAY);
    if (!tour.ok) throw new Error('tournée refusée');
    const placeOf = (s: TourStop): Place =>
      s.kind === 'rendez-vous' ? VISIT_PLACE : s.kind === 'panneau' ? SIGN_PLACE : s.kind === 'lettres' ? CENTER : DPE_PLACE;
    let expected = 0;
    for (let i = 1; i < tour.stops.length; i++) expected += roadEstimate(placeOf(tour.stops[i - 1]!), placeOf(tour.stops[i]!));
    expect(tour.stops.some((s) => s.kind === 'rendez-vous')).toBe(true);
    expect(tour.travelMinutes).toBe(expected);
  });

  it('[R297] aucune adresse hors des zones de l’agent : comptée, jamais montrée ; une zone fermée retire ses opportunités', async () => {
    const w = await world();
    const map = await w.tournee.map(w.asPaul, DAY);
    if (!map.ok) throw new Error('carte refusée');
    expect(map.outsideZone).toBe(2);
    const shown = JSON.stringify(map);
    expect(shown).not.toMatch(/Dijon|Hors Zone|Frontière|21000/);
    expect(map.opportunities.every((o) => o.town === 'Talant')).toBe(true);
    // Le panneau dû plus tard et le diagnostic trop ancien n'y sont pas.
    expect(shown).not.toMatch(/Plus Tard|Trop Ancienne/);
    expect(map.opportunities.map((o) => o.id).sort()).toEqual([`diagnostic:${w.dpeId}`, `diagnostic:${w.dpeUnknown}`, `lettres:${w.campaignId}`, `panneau:${w.signTalant}`].sort());
    const tour = await w.tournee.plan(w.asPaul, DAY);
    expect(JSON.stringify(tour)).not.toMatch(/Dijon|Hors Zone|Frontière|21000/);
    // Un panneau hors zone n'est même pas envoyé au géocodage.
    expect(w.geocoded.some((a) => a.includes('Hors Zone'))).toBe(false);

    await w.db.run("UPDATE agent_zones SET ended_at = '2026-11-01T00:00:00.000Z' WHERE agent_id = ? AND commune = 'Talant'", [w.paul.id]);
    const after = await w.tournee.map(w.asPaul, DAY);
    if (!after.ok) throw new Error('carte refusée');
    expect(after.opportunities).toEqual([]);
    expect(JSON.stringify(after)).not.toMatch(/Talant|Essais|Allée/);
  });

  it('[R297] chaque agent n’a que ses opportunités ; la direction et un autre rôle sont refusés, au journal', async () => {
    const w = await world();
    const zoe = await w.tournee.map(w.asZoe, DAY);
    expect(zoe).toEqual({ ok: true, opportunities: [], outsideZone: 0 });
    expect(await w.tournee.map({ role: 'direction', userId: 'd1', networkId: w.net.id }, DAY)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await w.tournee.plan({ role: 'agent', userId: w.paul.id, networkId: 'autre' }, DAY)).toEqual({ ok: false, rule: 'R16', code: 'agent_inactive' });
    const refused = await w.db.all<{ data: string }>("SELECT data FROM journal WHERE type = 'acces.refuse'");
    expect(refused.map((r) => JSON.parse(r.data).kind)).toEqual(['tournee_prospection', 'tournee_prospection']);
  });

  it('[R13] le journal de la tournée ne porte que des comptes, jamais une adresse ni une commune', async () => {
    const w = await world();
    await w.tournee.plan(w.asPaul, DAY);
    const dump = JSON.stringify(await w.db.all('SELECT * FROM journal'));
    expect(dump).toContain('prospection.tournee_proposee');
    expect(dump).not.toMatch(/Talant|Essais|Allée|Diagnostic|21240/);
  });

  it('[R299] le lien vers la vue des rues ne porte que la position arrondie : ni clé, ni adresse, ni nom, ni référence', async () => {
    const link = streetViewLink(SIGN_PLACE)!;
    const url = new URL(link);
    expect(url.protocol).toBe('https:');
    expect(url.host).toBe('www.google.com');
    expect([...url.searchParams.keys()].sort()).toEqual(['api', 'map_action', 'viewpoint']);
    expect(url.searchParams.get('viewpoint')).toBe('47.34012,5.00499');
    expect(link).not.toMatch(/key|token|sig|client/i);
    expect(streetViewLink(null)).toBeNull();
    expect(streetViewLink({ lat: 120, lon: 5 })).toBeNull();
    expect(streetViewLink({ lat: Number.NaN, lon: 5 })).toBeNull();

    const w = await world();
    const map = await w.tournee.map(w.asPaul, DAY);
    if (!map.ok) throw new Error('carte refusée');
    for (const o of map.opportunities) {
      if (!o.streetView) {
        expect(o.place).toBeNull();
        continue;
      }
      const u = new URL(o.streetView);
      expect([...u.searchParams.keys()].sort()).toEqual(['api', 'map_action', 'viewpoint']);
      // Rien de l'adresse, de la commune, de la fiche ni du client dans le lien.
      expect(o.streetView).not.toMatch(/Talant|Essais|Allée|Diagnostic|Léa|Cliente|T1|21240/);
    }
  });
});
