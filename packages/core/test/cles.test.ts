import { expect, it } from 'vitest';
import { Cles, cleanLabel } from '../src/cles/cles.ts';
import type { ClientViewer } from '../src/espaces/entree.ts';
import { Acces, FicheClient, FicheUnique, RendezVous, SqlJournalStore, Visites, applyMigrations, fromSyncSqlite, verifyChain, type SqlDatabase } from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, agents, vendeur, acquéreurs et bien inventés.
const MONDAY_9H = Date.parse('2026-12-07T08:00:00.000Z');
const HOUR = 3_600_000;
const MIN = 60_000;
const WEEK = { weekly: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: '09:00', to: '19:00' })) };

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = MONDAY_9H;
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const rdv = new RendezVous(db, journal, { now });
  const visites = new Visites(db, journal, acces, { diffusion: { canDiffuse: async () => ({ allowed: true, reason: 'allowed' }) }, rendezVous: rdv, now });
  const cles = new Cles(db, acces, fiche, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Bienveillant' });
  const as = (role: 'agent' | 'direction', userId: string) => ({ role, userId, networkId: network.id });
  const agentAlex = as('agent', alex.id);
  const agentSam = as('agent', sam.id);
  const direction = as('direction', 'd1');
  await rdv.setAvailability(agentAlex, WEEK);
  await rdv.setAvailability(agentSam, WEEK);
  await visites.createSlipTemplate(direction, 'Bon de visite : {{visiteur.nom}} visite {{bien.reference}} le {{visite.date}}.');
  // Le vendeur, suivi par Sam, avec son mandat inscrit au registre.
  const seller = await store.createPerson({ networkId: network.id, agentId: sam.id, firstName: 'Victor', lastName: 'Vendeur' });
  const property = await store.createProperty({ networkId: network.id, agentId: sam.id, reference: 'B1', kind: 'home', city: 'Talant', priceEur: 250_000, surfaceM2: 90, rooms: 4, status: 'available' });
  const other = await store.createProperty({ networkId: network.id, agentId: sam.id, reference: 'B2', kind: 'home', city: 'Talant', priceEur: 180_000, surfaceM2: 70, rooms: 3, status: 'available' });
  const signedAt = new Date(MONDAY_9H - 20 * 24 * HOUR).toISOString();
  await db.run("INSERT INTO mandates (id, network_id, agent_id, person_id, property_id, signed_at, source_kind, recorded_by, created_at) VALUES ('m1', ?, ?, ?, ?, ?, 'site', 'test', ?)", [network.id, sam.id, seller.id, property.id, signedAt, new Date(MONDAY_9H).toISOString()]);
  await db.run(
    "INSERT INTO mandate_register (network_id, seq, kind, mandate_id, number_value, number, agent_id, property_id, signed_at, at, actor, prev_hash, hash) VALUES (?, 1, 'inscription', 'm1', 1, 'T-1', ?, ?, ?, ?, 'test', 'p', 'h-m1')",
    [network.id, sam.id, property.id, signedAt, new Date(MONDAY_9H).toISOString()],
  );
  let n = 0;
  /** Une visite d'un acquéreur inventé, tenue par `agent`, le lendemain ou plus tard. */
  const visit = async (agent = alex, propertyId = property.id) => {
    n += 1;
    const buyer = await store.createPerson({ networkId: network.id, agentId: agent.id, firstName: 'Inès', lastName: 'Durand' });
    const project = await store.createProject({ networkId: network.id, agentId: agent.id, personId: buyer.id, kind: 'buy' });
    const r = await visites.schedule(as('agent', agent.id), { propertyId, projectId: project.id, start: new Date(MONDAY_9H + 24 * HOUR + n * 90 * MIN) });
    if (!r.ok) throw new Error(r.code);
    return { id: r.visit.appointment.id, start: Date.parse(r.visit.appointment.start_at), end: Date.parse(r.visit.appointment.end_at), buyerId: buyer.id };
  };
  const register = async (label = 'Porte d’entrée et cave', viewer = agentSam, propertyId = property.id) => {
    const r = await cles.register(viewer, propertyId, label);
    if (!r.ok) throw new Error(r.code);
    return r;
  };
  const sellerViewer: ClientViewer = { kind: 'client', networkId: network.id, personId: seller.id, sessionId: 's1', sides: ['vendeur'] };
  return { db, journal, cles, store, network, alex, sam, agentAlex, agentSam, direction, property, other, seller, sellerViewer, visit, register, setClock: (t: number) => (clock = t) };
}

it('[R270] le libellé d’un trousseau dit ce qu’il ouvre, jamais une adresse ni un code', () => {
  expect(cleanLabel('  Porte d’entrée   et cave ')).toBe('Porte d’entrée et cave');
  expect(cleanLabel('Garage')).toBe('Garage');
  for (const bad of ['12 rue des Tilleuls', 'Code 4521B', 'Digicode', 'Badge et alarme', 'Bâtiment C', 'Porte\ncave', 'x', 'a'.repeat(81), 42, null]) expect(cleanLabel(bad)).toBeNull();
});

describeWithSqlite('HX10 · les clés des biens', () => {
  it('[R270] chaque trousseau a son numéro, donné par le code, unique dans le réseau ; seul celui qui tient l’armoire du bien le range', async () => {
    const t = await setup();
    const a = await t.register();
    const b = await t.register('Garage', t.direction);
    const c = await t.register('Porte d’entrée', t.agentSam, t.other.id);
    expect([a.number, b.number, c.number]).toEqual([1, 2, 3]);
    // Alex n'est pas l'agent du bien : il ne range rien dans l'armoire de Sam.
    expect(await t.cles.register(t.agentAlex, t.property.id, 'Cave')).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.cles.register(t.agentSam, t.property.id, '3 rue du Test')).toEqual({ ok: false, rule: 'R270', code: 'bad_label' });
    // La base refuse un numéro déjà pris, et rien ne change ni ne s'efface.
    await expect(t.db.run("INSERT INTO property_keys (id, network_id, property_id, number, label, created_by, created_at) VALUES ('x', ?, ?, 1, 'Cave', 't', 'n')", [t.network.id, t.property.id])).rejects.toThrow();
    await expect(t.db.run('UPDATE property_keys SET label = ?', ['Autre'])).rejects.toThrow();
    await expect(t.db.run('DELETE FROM property_keys')).rejects.toThrow();
    const view = await t.cles.cabinet(t.agentSam, t.property.id);
    expect(view.ok && view.value.map((k) => [k.number, k.state])).toEqual([[1, 'armoire'], [2, 'armoire']]);
  });

  it('[R271] une clé ne peut être chez deux personnes à la fois, même demandée deux fois en même temps', async () => {
    const t = await setup();
    const key = await t.register();
    const v = await t.visit();
    const out = await t.cles.handOut(t.agentSam, key.keyId, { holderAgentId: t.alex.id, purpose: 'visite', appointmentId: v.id });
    expect(out).toEqual({ ok: true, loanId: expect.any(String), dueAt: new Date(v.end).toISOString() });
    expect(await t.cles.handOut(t.agentSam, key.keyId, { holderAgentId: t.sam.id, purpose: 'photos', dueAt: new Date(MONDAY_9H + 2 * HOUR).toISOString() })).toEqual({ ok: false, rule: 'R271', code: 'deja_sorti' });
    // La base aussi refuse une seconde sortie, et une sortie ne change ni ne s'efface.
    await expect(
      t.db.run("INSERT INTO property_key_loans (id, key_id, network_id, holder_agent_id, purpose, due_at, handed_by, out_at) VALUES ('l2', ?, ?, ?, 'photos', '2026-12-07T12:00:00.000Z', 't', '2026-12-07T09:00:00.000Z')", [key.keyId, t.network.id, t.sam.id]),
    ).rejects.toThrow();
    await expect(t.db.run('UPDATE property_key_loans SET holder_agent_id = ?', [t.sam.id])).rejects.toThrow();
    await expect(t.db.run('DELETE FROM property_key_loans')).rejects.toThrow();
    const cab = await t.cles.cabinet(t.agentSam, t.property.id);
    expect(cab.ok && cab.value[0]!.holder).toMatchObject({ agentId: t.alex.id, name: 'Alex A.', purpose: 'visite', appointmentId: v.id, since: new Date(MONDAY_9H).toISOString() });
    // Rendue, elle peut ressortir ; deux sorties demandées ensemble n'en font qu'une.
    expect(await t.cles.giveBack(t.agentSam, key.keyId)).toEqual({ ok: true });
    expect(await t.cles.giveBack(t.agentSam, key.keyId)).toEqual({ ok: false, rule: 'R271', code: 'pas_sorti' });
    const due = new Date(MONDAY_9H + 3 * HOUR).toISOString();
    const both = await Promise.all([
      t.cles.handOut(t.agentSam, key.keyId, { holderAgentId: t.sam.id, purpose: 'photos', dueAt: due }),
      t.cles.handOut(t.direction, key.keyId, { holderAgentId: t.alex.id, purpose: 'diagnostic', dueAt: due }),
    ]);
    expect(both.filter((r) => r.ok).length).toBe(1);
    expect(both.find((r) => !r.ok)).toEqual({ ok: false, rule: 'R271', code: 'deja_sorti' });
  });

  it('[R271] on sait qui l’a, depuis quand et pour quelle visite : le rendez-vous est du bien et de celui qui prend la clé', async () => {
    const t = await setup();
    const key = await t.register();
    const v = await t.visit();
    const elsewhere = await t.visit(t.alex, t.other.id);
    expect(await t.cles.handOut(t.agentSam, key.keyId, { holderAgentId: t.alex.id, purpose: 'visite', appointmentId: elsewhere.id })).toEqual({ ok: false, rule: 'R271', code: 'bad_appointment' });
    expect(await t.cles.handOut(t.agentSam, key.keyId, { holderAgentId: t.sam.id, purpose: 'visite', appointmentId: v.id })).toEqual({ ok: false, rule: 'R271', code: 'pas_son_rendez_vous' });
    expect(await t.cles.handOut(t.agentSam, key.keyId, { holderAgentId: t.alex.id, purpose: 'visite' })).toEqual({ ok: false, rule: 'R271', code: 'sans_rendez_vous' });
    expect(await t.cles.handOut(t.agentSam, key.keyId, { holderAgentId: t.alex.id, purpose: 'estimation', appointmentId: v.id })).toEqual({ ok: false, rule: 'R271', code: 'bad_appointment' });
    expect(await t.cles.handOut(t.agentSam, key.keyId, { holderAgentId: t.alex.id, purpose: 'promenade', appointmentId: v.id })).toEqual({ ok: false, rule: 'R271', code: 'bad_purpose' });
    expect(await t.cles.handOut(t.agentSam, key.keyId, { holderAgentId: 'inconnu', purpose: 'visite', appointmentId: v.id })).toEqual({ ok: false, rule: 'R271', code: 'bad_holder' });
    // Sans rendez-vous : l'heure du retour est dite, dans les 12 heures.
    expect(await t.cles.handOut(t.agentSam, key.keyId, { holderAgentId: t.sam.id, purpose: 'photos' })).toEqual({ ok: false, rule: 'R271', code: 'bad_due' });
    expect(await t.cles.handOut(t.agentSam, key.keyId, { holderAgentId: t.sam.id, purpose: 'photos', dueAt: new Date(MONDAY_9H + 13 * HOUR).toISOString() })).toEqual({ ok: false, rule: 'R271', code: 'bad_due' });
    // Alex tient la visite, pas l'armoire : il ne sort pas la clé lui-même.
    expect(await t.cles.handOut(t.agentAlex, key.keyId, { holderAgentId: t.alex.id, purpose: 'visite', appointmentId: v.id })).toMatchObject({ ok: false, rule: 'R16' });
    // Un rendez-vous annulé ne fait plus sortir la clé ; un agent parti ne la prend pas.
    await t.db.run("UPDATE appointments SET status = 'cancelled', cancelled_at = ? WHERE id = ?", [new Date(MONDAY_9H).toISOString(), v.id]);
    expect(await t.cles.handOut(t.agentSam, key.keyId, { holderAgentId: t.alex.id, purpose: 'visite', appointmentId: v.id })).toEqual({ ok: false, rule: 'R271', code: 'rendez_vous_passe' });
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.alex.id]);
    expect(await t.cles.handOut(t.agentSam, key.keyId, { holderAgentId: t.alex.id, purpose: 'photos', dueAt: new Date(MONDAY_9H + HOUR).toISOString() })).toEqual({ ok: false, rule: 'R271', code: 'bad_holder' });
  });

  it('[R271] tout mouvement est au journal, sans un nom', async () => {
    const t = await setup();
    const key = await t.register();
    const v = await t.visit();
    await t.cles.handOut(t.agentSam, key.keyId, { holderAgentId: t.alex.id, purpose: 'visite', appointmentId: v.id });
    await t.cles.giveBack(t.agentSam, key.keyId);
    // Deux sorties dans la même milliseconde gardent leur ordre dans l'histoire.
    await t.cles.handOut(t.agentSam, key.keyId, { holderAgentId: t.alex.id, purpose: 'photos', dueAt: new Date(MONDAY_9H + HOUR).toISOString() });
    // Celui qui l'avait peut dire qu'il l'a perdue, pas qu'il l'a rendue : c'est l'armoire qui le note.
    expect(await t.cles.giveBack(t.agentAlex, key.keyId, 'rendu')).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.cles.giveBack(t.agentAlex, key.keyId, 'perdu')).toEqual({ ok: true });
    const spare = await t.register('Double de la porte');
    expect(await t.cles.retire(t.agentSam, spare.keyId, 'rendu_au_proprietaire')).toEqual({ ok: true });
    const rows = await t.db.all<{ type: string; subject: string; data: string }>("SELECT type, subject, data FROM journal WHERE type LIKE 'cle.%' ORDER BY rowid");
    expect(rows.filter((r) => r.subject === `key:${key.keyId}`).map((r) => r.type)).toEqual(['cle.rangee', 'cle.sortie', 'cle.rendue', 'cle.sortie', 'cle.perdue']);
    expect(rows.filter((r) => r.subject === `key:${spare.keyId}`).map((r) => r.type)).toEqual(['cle.rangee', 'cle.retiree']);
    const all = JSON.stringify(await t.db.all('SELECT actor, subject, data FROM journal'));
    for (const name of ['Alex', 'Sam', 'Victor', 'Inès', 'Durand', 'Porte']) expect(all).not.toContain(name);
    expect((await verifyChain(await t.journal.all())).ok).toBe(true);
    // L'histoire du trousseau : chaque sortie, qui, depuis quand, et son retour.
    const h = await t.cles.history(t.direction, key.keyId);
    expect(h.ok && h.value.map((m) => [m.holder.name, m.purpose, m.returned?.outcome])).toEqual([['Alex A.', 'visite', 'rendu'], ['Alex A.', 'photos', 'perdu']]);
  });

  it('[R271] une perte dite après un retour noté ne retire pas le trousseau rendu', async () => {
    const t = await setup();
    const key = await t.register();
    await t.cles.handOut(t.agentSam, key.keyId, { holderAgentId: t.alex.id, purpose: 'photos', dueAt: new Date(MONDAY_9H + HOUR).toISOString() });
    const both = await Promise.all([t.cles.giveBack(t.agentSam, key.keyId, 'rendu'), t.cles.giveBack(t.agentAlex, key.keyId, 'perdu')]);
    expect(both.filter((r) => r.ok).length).toBe(1);
    const retired = await t.db.first<{ n: number }>('SELECT count(*) AS n FROM property_key_retirements');
    const lost = await t.db.first<{ n: number }>("SELECT count(*) AS n FROM property_key_returns WHERE outcome = 'perdu'");
    // Retiré seulement si c'est la perte qui a été notée, et toujours au journal.
    expect(Number(retired!.n)).toBe(Number(lost!.n));
    const events = await t.db.all<{ type: string }>("SELECT type FROM journal WHERE subject = ? AND type IN ('cle.rendue', 'cle.perdue')", [`key:${key.keyId}`]);
    expect(events.length).toBe(1);
  });

  it('[R271] perdu, le trousseau ne sort plus ; rendu au propriétaire seulement depuis l’armoire', async () => {
    const t = await setup();
    const key = await t.register();
    await t.cles.handOut(t.agentSam, key.keyId, { holderAgentId: t.sam.id, purpose: 'diagnostic', dueAt: new Date(MONDAY_9H + HOUR).toISOString() });
    expect(await t.cles.retire(t.agentSam, key.keyId, 'rendu_au_proprietaire')).toEqual({ ok: false, rule: 'R271', code: 'encore_sorti' });
    await expect(t.db.run("INSERT INTO property_key_retirements (key_id, reason, retired_by, retired_at) VALUES (?, 'rendu_au_proprietaire', 't', 'n')", [key.keyId])).rejects.toThrow();
    expect(await t.cles.retire(t.agentSam, key.keyId, 'perdu')).toEqual({ ok: true });
    expect(await t.cles.handOut(t.agentSam, key.keyId, { holderAgentId: t.sam.id, purpose: 'photos', dueAt: new Date(MONDAY_9H + HOUR).toISOString() })).toEqual({ ok: false, rule: 'R271', code: 'retire' });
    const cab = await t.cles.cabinet(t.agentSam, t.property.id);
    expect(cab.ok && cab.value[0]).toMatchObject({ state: 'retire', holder: null, retirement: { reason: 'perdu' } });
  });

  it('[R272] Jamais vu : l’agenda rappelle de rendre la clé à la fin de la visite, et tout de suite si elle est annulée', async () => {
    const t = await setup();
    const key = await t.register();
    const spare = await t.register('Garage');
    const v = await t.visit();
    const w = await t.visit();
    await t.cles.handOut(t.agentSam, key.keyId, { holderAgentId: t.alex.id, purpose: 'visite', appointmentId: v.id });
    await t.cles.handOut(t.agentSam, spare.keyId, { holderAgentId: t.alex.id, purpose: 'visite', appointmentId: w.id });
    const before = await t.cles.reminders(t.agentAlex);
    expect(before.ok && before.value.map((r) => [r.number, r.dueAt, r.overdue])).toEqual([[1, new Date(v.end).toISOString(), false], [2, new Date(w.end).toISOString(), false]]);
    expect(before.ok && before.value[0]!.text).toBe('Rendre le trousseau n° 1 (Porte d’entrée et cave) du bien B1 à l’agence : après la visite.');
    // Sam n'a aucune clé dehors : rien à rendre.
    expect(await t.cles.reminders(t.agentSam)).toEqual({ ok: true, value: [] });
    expect(await t.cles.reminders(t.direction)).toMatchObject({ ok: false, rule: 'R16' });
    // La seconde visite est annulée : sa clé est à rendre tout de suite.
    const cancelAt = new Date(MONDAY_9H + 2 * HOUR).toISOString();
    t.setClock(MONDAY_9H + 2 * HOUR);
    await t.db.run("UPDATE appointments SET status = 'cancelled', cancelled_at = ? WHERE id = ?", [cancelAt, w.id]);
    const cancelled = await t.cles.reminders(t.agentAlex);
    expect(cancelled.ok && cancelled.value.map((r) => [r.number, r.dueAt, r.overdue])).toEqual([[2, cancelAt, true], [1, new Date(v.end).toISOString(), false]]);
    expect(cancelled.ok && cancelled.value[0]!.text).toContain('le rendez-vous est annulé');
    // La visite finie, le rappel passe en retard ; rendue, il disparaît.
    t.setClock(v.end + 5 * MIN);
    const late = await t.cles.reminders(t.agentAlex);
    expect(late.ok && late.value.every((r) => r.overdue)).toBe(true);
    await t.cles.giveBack(t.agentSam, key.keyId);
    await t.cles.giveBack(t.agentSam, spare.keyId);
    expect(await t.cles.reminders(t.agentAlex)).toEqual({ ok: true, value: [] });
  });

  it('[R272] Jamais vu : le vendeur voit qui est entré chez lui et quand, jamais le nom d’un visiteur', async () => {
    const t = await setup();
    const key = await t.register();
    const v = await t.visit();
    await t.cles.handOut(t.agentSam, key.keyId, { holderAgentId: t.alex.id, purpose: 'visite', appointmentId: v.id });
    await t.db.run("UPDATE appointments SET status = 'honored' WHERE id = ?", [v.id]);
    t.setClock(v.end + 20 * MIN);
    await t.cles.giveBack(t.agentSam, key.keyId);
    await t.cles.handOut(t.agentSam, key.keyId, { holderAgentId: t.sam.id, purpose: 'photos', dueAt: new Date(v.end + 2 * HOUR).toISOString() });
    const seen = await t.cles.forSeller(t.sellerViewer, t.property.id);
    expect(seen).toEqual({
      ok: true,
      value: [
        { number: 1, label: 'Porte d’entrée et cave', agent: 'Sam B.', purpose: 'Photos du bien', takenAt: new Date(v.end + 20 * MIN).toISOString(), appointment: null, returnedAt: null, lost: false },
        {
          number: 1,
          label: 'Porte d’entrée et cave',
          agent: 'Alex A.',
          purpose: 'Visite',
          takenAt: new Date(MONDAY_9H).toISOString(),
          appointment: { start: new Date(v.start).toISOString(), end: new Date(v.end).toISOString(), state: 'fait' },
          returnedAt: new Date(v.end + 20 * MIN).toISOString(),
          lost: false,
        },
      ],
    });
    for (const name of ['Inès', 'Durand', v.buyerId]) expect(JSON.stringify(seen)).not.toContain(name);
    // Un bien qui n'est pas le sien, ou un client sans côté vendeur : refusé comme s'il n'existait pas.
    expect(await t.cles.forSeller(t.sellerViewer, t.other.id)).toEqual({ ok: false, rule: 'R161', code: 'unknown' });
    expect(await t.cles.forSeller({ ...t.sellerViewer, personId: v.buyerId }, t.property.id)).toEqual({ ok: false, rule: 'R161', code: 'unknown' });
    expect(await t.cles.forSeller({ ...t.sellerViewer, sides: ['acquereur'] }, t.property.id)).toEqual({ ok: false, rule: 'R161', code: 'side' });
    // Rien de ce qui précède son mandat : une sortie d'avant n'est pas montrée.
    await t.db.run("INSERT INTO property_key_returns (loan_id, outcome, recorded_by, returned_at) SELECT id, 'rendu', 't', ? FROM property_key_loans WHERE purpose = 'photos'", [new Date(v.end + HOUR).toISOString()]);
    await t.db.run("INSERT INTO property_key_loans (id, key_id, network_id, holder_agent_id, purpose, due_at, handed_by, out_at) VALUES ('old', ?, ?, ?, 'photos', ?, 't', ?)", [key.keyId, t.network.id, t.sam.id, new Date(MONDAY_9H - 29 * 24 * HOUR).toISOString(), new Date(MONDAY_9H - 30 * 24 * HOUR).toISOString()]);
    const again = await t.cles.forSeller(t.sellerViewer, t.property.id);
    expect(again.ok && again.value.length).toBe(2);
  });
});
