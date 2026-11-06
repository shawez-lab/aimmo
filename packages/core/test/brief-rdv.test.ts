import { expect, it } from 'vitest';
import {
  APPOINTMENT_PURPOSE,
  BRIEF_HOURS,
  BRIEF_SECTIONS,
  BriefsRendezVous,
  FicheClient,
  RendezVous,
  SqlJournalStore,
  appointmentBriefJob,
  applyMigrations,
  fromSyncSqlite,
  parisInstant,
  type Availability,
  type Brief,
  type Viewer,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Novembre 2026 : Paris est à UTC+1 ; le lundi 9 novembre. Tout est inventé.
const at = (date: string, hhmm: string): Date => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return parisInstant(date, h * 60 + m)!;
};
const NOW = at('2026-11-09', '08:00');
const LONG_AGO = new Date('2026-01-01T00:00:00.000Z');
const WEEK: Availability = {
  weekly: [1, 2, 3, 4, 5].flatMap((weekday) => [
    { weekday, from: '08:00', to: '12:00' },
    { weekday, from: '14:00', to: '19:00' },
  ]),
};
const fr = (n: number) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 }).format(n);
const KNOWN_SOURCES = [
  'fiche client',
  'origine du contact (fiche client)',
  'projet du client (fiche client)',
  'qualification du contact',
  'messages de la conversation',
  'rendez-vous de la base',
  'fiche du bien',
  'détails du bien',
  'réglage du réseau',
  'donnée absente de la base',
  'type du rendez-vous',
  'commune du bien (fiche du bien)',
];

async function world() {
  let clock = NOW;
  const now = () => clock;
  const setClock = (d: Date) => {
    clock = d;
  };
  const db = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const store = new FicheClient(db);
  const net = await store.createNetwork('Réseau test');
  const paul = await store.createAgent({ networkId: net.id, firstName: 'Paul', lastName: 'Essai' });
  const lise = await store.createAgent({ networkId: net.id, firstName: 'Lise', lastName: 'Essai' });
  const lea = await store.createPerson({ networkId: net.id, agentId: paul.id, firstName: 'Léa', lastName: 'Exemple' });
  await store.addConsent({ networkId: net.id, personId: lea.id, purpose: APPOINTMENT_PURPOSE, channel: 'email', proof: 'formulaire test', givenAt: LONG_AGO });
  const journal = new SqlJournalStore(db);
  const rdv = new RendezVous(db, journal, { now });
  const asPaul: Viewer = { role: 'agent', userId: paul.id, networkId: net.id };
  const asLise: Viewer = { role: 'agent', userId: lise.id, networkId: net.id };
  expect(await rdv.setAvailability(asPaul, WEEK)).toEqual({ ok: true });
  const briefs = new BriefsRendezVous(db, journal, { now });
  const book = async (start: Date, over: Partial<Parameters<RendezVous['book']>[0]> = {}) => {
    const r = await rdv.book({ networkId: net.id, agentId: paul.id, personId: lea.id, kind: 'estimation', start, source: 'agent', ...over });
    if (!r.ok) throw new Error(`réservation refusée : ${r.code}`);
    return r.appointment;
  };
  const runAt = (d: Date) => {
    setClock(d);
    return briefs.run();
  };
  const read = async (id: string): Promise<Brief> => {
    const r = await briefs.read(asPaul, id);
    if (!r.ok) throw new Error(`brief illisible : ${r.code}`);
    return r.brief;
  };
  return { db, store, net, paul, lise, lea, journal, rdv, briefs, asPaul, asLise, book, runAt, read, setClock };
}

/** Le client et le bien au complet, avec des données inventées. */
async function fullData(w: Awaited<ReturnType<typeof world>>) {
  const { store, net, paul, lea, db } = w;
  await store.addSource({ networkId: net.id, agentId: paul.id, personId: lea.id, channel: 'instagram', detail: 'publication test', occurredAt: new Date('2026-09-01T10:00:00Z') });
  const project = await store.createProject({ networkId: net.id, agentId: paul.id, personId: lea.id, kind: 'sell', budgetMinEur: 250000, budgetMaxEur: 280000 });
  const property = await store.createProperty({ networkId: net.id, agentId: paul.id, reference: 'REF-TEST-1', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 72, rooms: 3, priceEur: 265000 });
  await store.linkProjectProperty({ networkId: net.id, agentId: paul.id, projectId: project.id, propertyId: property.id, role: 'owned' });
  await db.run("INSERT INTO property_details (property_id, network_id, neighborhood, highlight, updated_at) VALUES (?, ?, 'Quartier Test', 'Balcon plein sud', ?)", [property.id, net.id, NOW.toISOString()]);
  await store.recordMessage({ networkId: net.id, personId: lea.id, channel: 'email', conversationId: 'c1', direction: 'in', authorKind: 'person', body: 'Bonjour, je voudrais faire estimer mon appartement.', occurredAt: new Date('2026-09-02T09:00:00Z') });
  await store.recordMessage({ networkId: net.id, personId: lea.id, channel: 'email', conversationId: 'c1', direction: 'out', authorKind: 'agent', body: 'Avec plaisir.', occurredAt: new Date('2026-09-02T10:00:00Z') });
  await db.run(
    `INSERT INTO inbound_messages (id, network_id, dedup_key, channel, kind, body, status, person_id, received_at, created_at) VALUES ('in-1', ?, 'k1', 'email', 'email', 'x', 'processed', ?, ?, ?)`,
    [net.id, lea.id, NOW.toISOString(), NOW.toISOString()],
  );
  await db.run(
    `INSERT INTO qualifications (id, network_id, inbound_id, person_id, category, deadline, financing, criteria, source, created_at) VALUES ('q-1', ?, 'in-1', ?, 'seller', 'within_3_months', NULL, '[]', 'rules', ?)`,
    [net.id, lea.id, '2026-09-02T11:00:00.000Z'],
  );
  await db.run(`INSERT INTO contact_scores (qualification_id, network_id, person_id, score, temperature, reason, created_at) VALUES ('q-1', ?, ?, 82, 'hot', 'test', ?)`, [
    net.id,
    lea.id,
    NOW.toISOString(),
  ]);
  const computed = {
    medianPerM2: 3100,
    cited: [
      { month: '2026-03', surface: 65, pricePerM2: 3100, distance: 250 },
      { month: '2026-01', surface: 80, pricePerM2: 2950, distance: 400 },
    ],
    data: { source: 'DVF, ventes publiées (licence ouverte)', lastSale: '2026-06-30' },
  };
  await db.run(
    `INSERT INTO valuation_reports (id, network_id, property_id, agent_id, status, computed, computed_low, computed_high, text, text_by, created_at, updated_at)
     VALUES ('avis-1', ?, ?, ?, 'draft', ?, 200000, 230000, 'texte', 'fallback', ?, ?)`,
    [net.id, property.id, paul.id, JSON.stringify(computed), '2026-10-01T10:00:00.000Z', '2026-10-01T10:00:00.000Z'],
  );
  return { property };
}

const value = (b: Brief, label: string) => b.items.filter((i) => i.label === label).map((i) => i.value);
const missing = (b: Brief) => b.items.filter((i) => i.value === null).map((i) => (i.value === null ? `${i.section}:${i.label}` : ''));

describeWithSqlite('V05 · brief du rendez-vous', () => {
  it('[R34] chaque élément du brief vient de la base ou d’un réglage, avec sa source citée', async () => {
    const w = await world();
    const { property } = await fullData(w);
    const a = await w.book(at('2026-11-10', '10:00'), { propertyId: property.id });
    expect(await w.runAt(at('2026-11-10', '08:07'))).toEqual([a.id]);
    const b = await w.read(a.id);
    for (const item of b.items) {
      if (item.value !== null) {
        expect(item.source, item.label).not.toBe('');
        expect(KNOWN_SOURCES.includes(item.source) || item.source.startsWith('avis de valeur du '), item.source).toBe(true);
      } else {
        expect(item.missing, item.label).not.toBe('');
      }
    }
    expect(new Set(b.items.map((i) => i.section))).toEqual(new Set(BRIEF_SECTIONS));
    expect(value(b, 'Nom')).toEqual(['Léa Exemple']);
    expect(value(b, 'Origine')).toEqual(['instagram (publication test), le 01/09/2026']);
    expect(value(b, 'Projet')).toEqual([`vendre (étape : new), budget de ${fr(250000)} € à ${fr(280000)} €`]);
    expect(value(b, 'Qualification')).toEqual(['vendeur, délai sous 3 mois, note 82 sur 100, chaud (le 02/09/2026)']);
    expect(value(b, 'Échanges')).toEqual(['2 message(s), dont 1 reçu(s) ; dernier le 02/09/2026']);
    expect(value(b, 'Dernier message reçu')).toEqual(['« Bonjour, je voudrais faire estimer mon appartement. » (email, le 02/09/2026)']);
    expect(value(b, 'Référence')).toEqual(['REF-TEST-1']);
    expect(value(b, 'Surface')).toEqual(['72 m²']);
    expect(value(b, 'Quartier')).toEqual(['Quartier Test']);
    expect(value(b, 'Vente')).toEqual([`2026-03 · 65 m² · ${fr(3100)} € le m² · à 250 m`, `2026-01 · 80 m² · ${fr(2950)} € le m² · à 400 m`]);
    const sale = b.items.find((i) => i.label === 'Vente')!;
    expect(sale.value !== null && sale.source).toBe('avis de valeur du 01/10/2026 (brouillon), DVF, ventes publiées (licence ouverte)');
    expect(value(b, 'Itinéraire vers la commune')).toEqual(['https://www.google.com/maps/dir/?api=1&destination=21000%20Dijon%2C%20France']);
    // Ce qui manque est dit : l'adresse exacte n'est pas gardée dans la base.
    expect(missing(b)).toEqual(['histoire:Rendez-vous précédents', 'itineraire:Adresse exacte']);
    expect(value(b, 'Document')).toContain('Étude des ventes du quartier');
  });

  it('SV13 · un nom corrigé après la préparation : l’agent lit le nouveau, et le brief rangé ne change pas [R17]', async () => {
    const w = await world();
    const { property } = await fullData(w);
    const a = await w.book(at('2026-11-10', '10:00'), { propertyId: property.id });
    await w.runAt(at('2026-11-10', '08:07'));
    const person = await w.db.first<{ person_id: string }>('SELECT person_id FROM appointments WHERE id = ?', [a.id]);
    await w.db.run("UPDATE persons SET last_name = 'Exemplaire' WHERE id = ?", [person!.person_id]);
    expect(value(await w.read(a.id), 'Nom')).toEqual(['Léa Exemplaire']);
    expect((await w.db.first<{ content: string }>('SELECT content FROM appointment_briefs WHERE appointment_id = ?', [a.id]))!.content).toContain('Léa Exemple"');
  });

  it('[R34] ce qui manque est dit, rien n’est inventé', async () => {
    const w = await world();
    const marc = await w.store.createPerson({ networkId: w.net.id, agentId: w.paul.id, firstName: null as never });
    const a = await w.book(at('2026-11-10', '10:00'), { personId: marc.id, kind: 'visite' });
    await w.runAt(at('2026-11-10', '08:07'));
    const b = await w.read(a.id);
    expect(missing(b)).toEqual([
      'client:Nom',
      'client:Origine',
      'client:Projet',
      'client:Qualification',
      'histoire:Échanges',
      'histoire:Rendez-vous précédents',
      'bien:Bien',
      'ventes:Ventes du quartier',
      'itineraire:Itinéraire vers la commune',
      'itineraire:Adresse exacte',
    ]);
    // Les seules valeurs sont la date de la fiche, des questions et des documents de réglage.
    const values = b.items.filter((i) => i.value !== null);
    expect(values.every((i) => i.value !== null && ['fiche client', 'réglage du réseau', 'donnée absente de la base'].includes(i.source))).toBe(true);
    expect(value(b, 'Question')).toContain('Quel est le délai du projet ?');
    // Un appel n'a pas d'itinéraire, et le dit.
    const c = await w.book(at('2026-11-10', '15:00'), { personId: marc.id, kind: 'appel' });
    await w.runAt(at('2026-11-10', '13:07'));
    expect(value(await w.read(c.id), 'Itinéraire')).toEqual(['sans objet : rendez-vous par téléphone']);
  });

  it('10 briefs tests prêts une heure avant, une seule fois chacun', async () => {
    const w = await world();
    const starts = [
      at('2026-11-10', '08:00'),
      at('2026-11-10', '09:35'),
      at('2026-11-10', '11:05'),
      at('2026-11-10', '14:00'),
      at('2026-11-10', '15:40'),
      at('2026-11-10', '17:10'),
      at('2026-11-10', '18:00'),
      at('2026-11-11', '08:05'),
      at('2026-11-11', '10:00'),
      at('2026-11-11', '14:55'),
    ];
    const ids: string[] = [];
    for (const s of starts) ids.push((await w.book(s, { kind: 'appel' })).id);
    // Le déclencheur passe à la 7e minute de chaque heure.
    for (let t = at('2026-11-09', '10:07').getTime(); t < at('2026-11-11', '16:00').getTime(); t += 3_600_000) await w.runAt(new Date(t));
    const rows = await w.db.all<{ appointment_id: string; prepared_at: string }>('SELECT appointment_id, prepared_at FROM appointment_briefs');
    expect(rows.map((r) => r.appointment_id).sort()).toEqual([...ids].sort());
    for (const [i, id] of ids.entries()) {
      const prepared = new Date(rows.find((r) => r.appointment_id === id)!.prepared_at);
      expect(prepared.getTime(), id).toBeLessThanOrEqual(starts[i]!.getTime() - 3_600_000);
      expect(prepared.getTime(), id).toBeGreaterThan(starts[i]!.getTime() - 3 * 3_600_000);
    }
    const events = await w.db.all("SELECT * FROM journal WHERE type = 'rdv.brief.pret'");
    expect(events).toHaveLength(10);
    expect(BRIEF_HOURS).toHaveLength(24);
    expect(appointmentBriefJob(w.db, w.journal).weekdays).toBeUndefined();
  });

  it('le brief n’est lu que par l’agent du rendez-vous', async () => {
    const w = await world();
    const a = await w.book(at('2026-11-10', '10:00'));
    expect(await w.briefs.read(w.asPaul, a.id)).toEqual({ ok: false, code: 'not_ready' });
    await w.runAt(at('2026-11-10', '08:07'));
    expect((await w.briefs.read(w.asPaul, a.id)).ok).toBe(true);
    expect(await w.briefs.read(w.asLise, a.id)).toEqual({ ok: false, code: 'not_agent' });
    expect(await w.briefs.read({ role: 'direction', userId: 'dir-1', networkId: w.net.id }, a.id)).toEqual({ ok: false, code: 'not_agent' });
    expect(await w.briefs.read({ role: 'agent', userId: w.paul.id, networkId: 'autre-reseau' }, a.id)).toEqual({ ok: false, code: 'unknown' });
    expect(await w.briefs.read(w.asPaul, 'inconnu')).toEqual({ ok: false, code: 'unknown' });
  });

  it('rien pour un rendez-vous annulé ; un brief ne change plus et ne s’efface pas', async () => {
    const w = await world();
    const a = await w.book(at('2026-11-10', '10:00'));
    const c = await w.book(at('2026-11-10', '15:00'));
    expect(await w.rdv.cancelAsAgent(w.asPaul, c.id)).toMatchObject({ ok: true });
    expect(await w.runAt(at('2026-11-10', '08:07'))).toEqual([a.id]);
    expect(await w.runAt(at('2026-11-10', '13:07'))).toEqual([]);
    await expect(w.db.run("UPDATE appointment_briefs SET content = '{}'")).rejects.toThrow();
    await expect(w.db.run('DELETE FROM appointment_briefs')).rejects.toThrow();
  });

  it('[R16] un rendez-vous n’ouvre pas la fiche d’un client ni le bien suivis par un autre agent', async () => {
    const w = await world();
    const { property } = await fullData(w);
    // Lise a un rendez-vous avec la cliente de Paul, pour le bien de Paul (en préparation, hors du fichier commun).
    await w.rdv.setAvailability(w.asLise, { weekly: [{ weekday: 2, from: '08:00', to: '12:00' }] });
    const a = await w.book(at('2026-11-10', '10:00'), { agentId: w.lise.id, propertyId: property.id });
    await w.runAt(at('2026-11-10', '08:07'));
    const r = await w.briefs.read(w.asLise, a.id);
    if (!r.ok) throw new Error(r.code);
    const text = JSON.stringify(r.brief);
    for (const secret of ['Léa', 'Exemple', 'estimer mon appartement', 'REF-TEST-1', 'instagram', 'Quartier Test', '3100']) expect(text, secret).not.toContain(secret);
    expect(missing(r.brief)).toEqual(expect.arrayContaining(['client:Client', 'histoire:Histoire', 'bien:Bien']));
  });

  it('[R13] le journal ne porte ni nom, ni texte de message, ni contenu du brief', async () => {
    const w = await world();
    const { property } = await fullData(w);
    await w.book(at('2026-11-10', '10:00'), { propertyId: property.id });
    await w.runAt(at('2026-11-10', '08:07'));
    const dump = JSON.stringify(await w.db.all("SELECT * FROM journal WHERE type LIKE 'rdv.brief%'"));
    for (const secret of ['Léa', 'Exemple', 'estimer mon appartement', 'REF-TEST-1', 'Dijon', 'Quartier Test']) expect(dump, secret).not.toContain(secret);
    expect(dump).toContain('rdv.brief.pret');
  });
});
