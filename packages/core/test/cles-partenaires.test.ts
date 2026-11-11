import { expect, it } from 'vitest';
import { Cles } from '../src/cles/cles.ts';
import type { ClientViewer } from '../src/espaces/entree.ts';
import { Acces, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, verifyChain, type SqlDatabase } from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// RC15 · Une clé remise à un partenaire de l'annuaire, sans agent. Réseaux, agents, vendeur, partenaires et bien inventés.
const MONDAY_9H = Date.parse('2026-12-07T08:00:00.000Z');
const HOUR = 3_600_000;
const iso = (t: number): string => new Date(t).toISOString();

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = MONDAY_9H;
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const cles = new Cles(db, acces, fiche, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const elsewhere = await store.createNetwork('Autre réseau');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Bienveillant' });
  const as = (role: 'agent' | 'direction' | 'compliance', userId: string) => ({ role, userId, networkId: network.id });
  const agentAlex = as('agent', alex.id);
  const agentSam = as('agent', sam.id);
  const direction = as('direction', 'd1');
  const seller = await store.createPerson({ networkId: network.id, agentId: sam.id, firstName: 'Victor', lastName: 'Vendeur' });
  const property = await store.createProperty({ networkId: network.id, agentId: sam.id, reference: 'B1', kind: 'home', city: 'Talant', priceEur: 250_000, surfaceM2: 90, rooms: 4, status: 'available' });
  const signedAt = iso(MONDAY_9H - 20 * 24 * HOUR);
  await db.run("INSERT INTO mandates (id, network_id, agent_id, person_id, property_id, signed_at, source_kind, recorded_by, created_at) VALUES ('m1', ?, ?, ?, ?, ?, 'site', 'test', ?)", [network.id, sam.id, seller.id, property.id, signedAt, iso(MONDAY_9H)]);
  await db.run(
    "INSERT INTO mandate_register (network_id, seq, kind, mandate_id, number_value, number, agent_id, property_id, signed_at, at, actor, prev_hash, hash) VALUES (?, 1, 'inscription', 'm1', 1, 'T-1', ?, ?, ?, ?, 'test', 'p', 'h-m1')",
    [network.id, sam.id, property.id, signedAt, iso(MONDAY_9H)],
  );
  let n = 0;
  /** Un partenaire de l'annuaire, avec ses justificatifs exigés valides du `from` au `until` (jours). */
  const partner = async (trade: string, businessName: string, opts: { networkId?: string; from?: string; until?: string; credentials?: boolean } = {}) => {
    n += 1;
    const id = `p${n}`;
    const net = opts.networkId ?? network.id;
    await db.run('INSERT INTO partners (id, network_id, trade, business_name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, net, trade, businessName, 'direction:d1', iso(MONDAY_9H - 60 * 24 * HOUR)]);
    if (opts.credentials !== false) {
      const kinds = trade === 'geometre' ? ['assurance_rcp', 'inscription_ordre'] : ['assurance_rcp'];
      for (const kind of kinds)
        await db.run(
          "INSERT INTO partner_credentials (id, network_id, partner_id, kind, domain, version, number, valid_from, valid_until, proof_ref, verified_by, recorded_at) VALUES (?, ?, ?, ?, '', 1, 'N-1', ?, ?, ?, 'direction:d1', ?)",
          [`${id}-${kind}`, net, id, kind, opts.from ?? '2026-01-01', opts.until ?? '2027-12-31', `ref-${id}-${kind}`, iso(MONDAY_9H - 60 * 24 * HOUR)],
        );
    }
    return id;
  };
  const register = async (label = 'Porte d’entrée et cave') => {
    const r = await cles.register(agentSam, property.id, label);
    if (!r.ok) throw new Error(r.code);
    return r;
  };
  const sellerViewer: ClientViewer = { kind: 'client', networkId: network.id, personId: seller.id, sessionId: 's1', sides: ['vendeur'] };
  return { db, journal, cles, store, network, elsewhere, alex, sam, agentAlex, agentSam, direction, as, property, seller, sellerViewer, partner, register, setClock: (t: number) => (clock = t) };
}

describeWithSqlite('RC15 · une clé remise à un partenaire de l’annuaire', () => {
  it('[R271] chez un partenaire, le trousseau n’est chez personne d’autre : refusé par le code et par la base', async () => {
    const t = await setup();
    const key = await t.register();
    const diag = await t.partner('diagnostiqueur', 'Diag Bourgogne SARL');
    const photo = await t.partner('photographe', 'Studio Lumière');
    const out = await t.cles.handToPartner(t.agentSam, key.keyId, { partnerId: diag, purpose: 'diagnostic', dueAt: iso(MONDAY_9H + 3 * HOUR) });
    expect(out).toEqual({ ok: true, loanId: expect.any(String), dueAt: iso(MONDAY_9H + 3 * HOUR), responsibleAgentId: t.sam.id });
    const cab = await t.cles.cabinet(t.agentSam, t.property.id);
    expect(cab.ok && cab.value[0]).toMatchObject({
      state: 'sorti',
      holder: null,
      partner: { partnerId: diag, trade: 'diagnostiqueur', tradeLabel: 'Diagnostiqueur certifié', businessName: 'Diag Bourgogne SARL', responsible: { agentId: t.sam.id, name: 'Sam B.' }, purpose: 'diagnostic', dueAt: iso(MONDAY_9H + 3 * HOUR) },
    });
    // Ni un agent, ni un autre partenaire tant qu'il n'est pas revenu.
    expect(await t.cles.handOut(t.agentSam, key.keyId, { holderAgentId: t.alex.id, purpose: 'photos', dueAt: iso(MONDAY_9H + 2 * HOUR) })).toEqual({ ok: false, rule: 'R271', code: 'deja_sorti' });
    expect(await t.cles.handToPartner(t.agentSam, key.keyId, { partnerId: photo, purpose: 'photos', dueAt: iso(MONDAY_9H + 2 * HOUR) })).toEqual({ ok: false, rule: 'R271', code: 'deja_sorti' });
    expect(await t.cles.retire(t.agentSam, key.keyId, 'rendu_au_proprietaire')).toEqual({ ok: false, rule: 'R271', code: 'encore_sorti' });
    // La base refuse aussi, des deux côtés.
    await expect(
      t.db.run("INSERT INTO property_key_loans (id, key_id, network_id, holder_agent_id, purpose, due_at, handed_by, out_at) VALUES ('x1', ?, ?, ?, 'photos', ?, 't', ?)", [key.keyId, t.network.id, t.alex.id, iso(MONDAY_9H + HOUR), iso(MONDAY_9H)]),
    ).rejects.toThrow(/partenaire/);
    await expect(
      t.db.run("INSERT INTO property_key_partner_loans (id, key_id, network_id, partner_id, responsible_agent_id, purpose, due_at, handed_by, out_at) VALUES ('x2', ?, ?, ?, ?, 'photos', ?, 't', ?)", [key.keyId, t.network.id, photo, t.sam.id, iso(MONDAY_9H + HOUR), iso(MONDAY_9H)]),
    ).rejects.toThrow(/déjà sorti/);
    await expect(t.db.run("INSERT INTO property_key_retirements (key_id, reason, retired_by, retired_at) VALUES (?, 'rendu_au_proprietaire', 't', 'n')", [key.keyId])).rejects.toThrow(/partenaire/);
    // Revenu, il ressort normalement.
    expect(await t.cles.giveBack(t.agentSam, key.keyId)).toEqual({ ok: true });
    expect(await t.cles.giveBack(t.agentSam, key.keyId)).toEqual({ ok: false, rule: 'R271', code: 'pas_sorti' });
    expect((await t.cles.handOut(t.agentSam, key.keyId, { holderAgentId: t.alex.id, purpose: 'photos', dueAt: iso(MONDAY_9H + 2 * HOUR) })).ok).toBe(true);
    // Sorti chez un agent : la base refuse une remise à un partenaire.
    await expect(
      t.db.run("INSERT INTO property_key_partner_loans (id, key_id, network_id, partner_id, responsible_agent_id, purpose, due_at, handed_by, out_at) VALUES ('x3', ?, ?, ?, ?, 'photos', ?, 't', ?)", [key.keyId, t.network.id, photo, t.sam.id, iso(MONDAY_9H + HOUR), iso(MONDAY_9H)]),
    ).rejects.toThrow(/déjà sorti/);
  });

  it('[R271] demandées en même temps, une sortie à un agent et une remise à un partenaire n’en font qu’une', async () => {
    const t = await setup();
    const key = await t.register();
    const photo = await t.partner('photographe', 'Studio Lumière');
    const both = await Promise.all([
      t.cles.handOut(t.agentSam, key.keyId, { holderAgentId: t.alex.id, purpose: 'photos', dueAt: iso(MONDAY_9H + 2 * HOUR) }),
      t.cles.handToPartner(t.agentSam, key.keyId, { partnerId: photo, purpose: 'photos', dueAt: iso(MONDAY_9H + 2 * HOUR) }),
    ]);
    expect(both.filter((r) => r.ok).length).toBe(1);
    expect(both.find((r) => !r.ok)).toEqual({ ok: false, rule: 'R271', code: 'deja_sorti' });
  });

  it('[R665] métier hors liste, partenaire d’un autre réseau, sans justificatif valable ou raison de visite : refusés', async () => {
    const t = await setup();
    const key = await t.register();
    const due = iso(MONDAY_9H + 2 * HOUR);
    const notaire = await t.partner('notaire', 'Étude des Ducs');
    const ailleurs = await t.partner('diagnostiqueur', 'Diag Ailleurs', { networkId: t.elsewhere.id });
    const sansPiece = await t.partner('artisan', 'Menuiserie Sans Pièce', { credentials: false });
    const echu = await t.partner('artisan', 'Plomberie Échue', { until: '2026-12-06' });
    const aVenir = await t.partner('photographe', 'Photo Demain', { from: '2026-12-08' });
    const geo = await t.partner('geometre', 'Géomètres Associés');
    await t.db.run("INSERT INTO partner_credentials (id, network_id, partner_id, kind, domain, version, number, valid_from, valid_until, proof_ref, verified_by, recorded_at) VALUES ('g2', ?, ?, 'inscription_ordre', '', 2, 'N-2', '2026-01-01', '2026-12-01', 'ref-g2', 'direction:d1', ?)", [t.network.id, geo, iso(MONDAY_9H)]);
    const ok = await t.partner('artisan', 'Menuiserie du Lac');
    expect(await t.cles.handToPartner(t.agentSam, key.keyId, { partnerId: notaire, purpose: 'travaux', dueAt: due })).toEqual({ ok: false, rule: 'R665', code: 'metier_non_admis' });
    expect(await t.cles.handToPartner(t.agentSam, key.keyId, { partnerId: ailleurs, purpose: 'diagnostic', dueAt: due })).toEqual({ ok: false, rule: 'R665', code: 'unknown_partner' });
    expect(await t.cles.handToPartner(t.agentSam, key.keyId, { partnerId: 'inconnu', purpose: 'diagnostic', dueAt: due })).toEqual({ ok: false, rule: 'R665', code: 'unknown_partner' });
    expect(await t.cles.handToPartner(t.agentSam, key.keyId, { partnerId: 42, purpose: 'diagnostic', dueAt: due })).toEqual({ ok: false, rule: 'R665', code: 'unknown_partner' });
    for (const p of [sansPiece, echu, aVenir, geo]) expect(await t.cles.handToPartner(t.agentSam, key.keyId, { partnerId: p, purpose: 'travaux', dueAt: due })).toEqual({ ok: false, rule: 'R665', code: 'justificatif_non_valable' });
    for (const purpose of ['visite', 'estimation', 'promenade', null]) expect(await t.cles.handToPartner(t.agentSam, key.keyId, { partnerId: ok, purpose, dueAt: due })).toEqual({ ok: false, rule: 'R665', code: 'bad_purpose' });
    // La base refuse un métier hors liste, une raison de visite, un partenaire d'un autre réseau.
    const insert = (id: string, partnerId: string, purpose: string) =>
      t.db.run('INSERT INTO property_key_partner_loans (id, key_id, network_id, partner_id, responsible_agent_id, purpose, due_at, handed_by, out_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, key.keyId, t.network.id, partnerId, t.sam.id, purpose, due, 't', iso(MONDAY_9H)]);
    await expect(insert('y1', notaire, 'travaux')).rejects.toThrow();
    await expect(insert('y2', ok, 'visite')).rejects.toThrow();
    await expect(insert('y3', ailleurs, 'diagnostic')).rejects.toThrow();
    const rows = await t.db.first<{ n: number }>('SELECT count(*) AS n FROM property_key_partner_loans');
    expect(Number(rows!.n)).toBe(0);
    expect((await t.cles.handToPartner(t.agentSam, key.keyId, { partnerId: ok, purpose: 'travaux', dueAt: due })).ok).toBe(true);
  });

  it('[R272] à rendre au plus tard 12 h après ; l’agent qui a remis reçoit le rappel, en retard une fois l’heure passée', async () => {
    const t = await setup();
    const key = await t.register();
    const spare = await t.register('Garage');
    const diag = await t.partner('diagnostiqueur', 'Diag Bourgogne SARL');
    for (const dueAt of [iso(MONDAY_9H + 12 * HOUR + 1), iso(MONDAY_9H), iso(MONDAY_9H - HOUR), 'demain', undefined])
      expect(await t.cles.handToPartner(t.agentSam, key.keyId, { partnerId: diag, purpose: 'diagnostic', dueAt })).toEqual({ ok: false, rule: 'R665', code: 'bad_due' });
    expect((await t.cles.handToPartner(t.agentSam, key.keyId, { partnerId: diag, purpose: 'diagnostic', dueAt: iso(MONDAY_9H + 12 * HOUR) })).ok).toBe(true);
    // La direction remet le second : l'agent du bien en répond.
    const byDirection = await t.cles.handToPartner(t.direction, spare.keyId, { partnerId: diag, purpose: 'diagnostic', dueAt: iso(MONDAY_9H + 2 * HOUR) });
    expect(byDirection).toMatchObject({ ok: true, responsibleAgentId: t.sam.id });
    const before = await t.cles.reminders(t.agentSam);
    expect(before.ok && before.value.map((r) => [r.number, r.dueAt, r.overdue])).toEqual([[2, iso(MONDAY_9H + 2 * HOUR), false], [1, iso(MONDAY_9H + 12 * HOUR), false]]);
    expect(before.ok && before.value[1]!.text).toBe('Faire revenir le trousseau n° 1 (Porte d’entrée et cave) du bien B1, remis à Diag Bourgogne SARL (diagnostiqueur certifié) : après « diagnostics ».');
    // Alex n'a rien remis : aucun rappel.
    expect(await t.cles.reminders(t.agentAlex)).toEqual({ ok: true, value: [] });
    t.setClock(MONDAY_9H + 2 * HOUR);
    const late = await t.cles.reminders(t.agentSam);
    expect(late.ok && late.value.map((r) => r.overdue)).toEqual([true, false]);
    await t.cles.giveBack(t.agentSam, spare.keyId);
    const after = await t.cles.reminders(t.agentSam);
    expect(after.ok && after.value.map((r) => r.number)).toEqual([1]);
  });

  it('[R16] seuls l’agent du bien ou la direction remettent ; le retour, l’agent qui en répond ou la direction ; refus au journal', async () => {
    const t = await setup();
    const key = await t.register();
    const diag = await t.partner('diagnostiqueur', 'Diag Bourgogne SARL');
    const input = { partnerId: diag, purpose: 'diagnostic', dueAt: iso(MONDAY_9H + 3 * HOUR) };
    expect(await t.cles.handToPartner(t.agentAlex, key.keyId, input)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.cles.handToPartner(t.as('compliance', 'c1'), key.keyId, input)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect((await t.cles.handToPartner(t.agentSam, key.keyId, input)).ok).toBe(true);
    // Alex n'en répond pas : il ne note pas le retour, ni rendu ni perdu.
    expect(await t.cles.giveBack(t.agentAlex, key.keyId)).toEqual({ ok: false, rule: 'R16', code: 'pas_responsable' });
    expect(await t.cles.giveBack(t.agentAlex, key.keyId, 'perdu')).toEqual({ ok: false, rule: 'R16', code: 'pas_responsable' });
    expect(await t.cles.giveBack(t.as('compliance', 'c1'), key.keyId)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    const refused = await t.db.all<{ data: string }>("SELECT data FROM journal WHERE type = 'acces.refuse'");
    expect(refused.map((r) => JSON.parse(r.data).code)).toEqual(expect.arrayContaining(['pas_son_bien', 'role', 'pas_responsable']));
    // La direction note le retour.
    expect(await t.cles.giveBack(t.direction, key.keyId)).toEqual({ ok: true });
    // Un agent qui a quitté le réseau ne note plus rien.
    expect((await t.cles.handToPartner(t.agentSam, key.keyId, input)).ok).toBe(true);
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.sam.id]);
    expect(await t.cles.giveBack(t.agentSam, key.keyId)).toEqual({ ok: false, rule: 'R16', code: 'agent_inactive' });
    expect(await t.cles.giveBack(t.agentSam, key.keyId, 'perdu')).toEqual({ ok: false, rule: 'R16', code: 'agent_inactive' });
  });

  it('[R665] la direction ne remet pas un trousseau sans agent du bien en activité pour en répondre', async () => {
    const t = await setup();
    const key = await t.register();
    const diag = await t.partner('diagnostiqueur', 'Diag Bourgogne SARL');
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.sam.id]);
    expect(await t.cles.handToPartner(t.direction, key.keyId, { partnerId: diag, purpose: 'diagnostic', dueAt: iso(MONDAY_9H + HOUR) })).toEqual({ ok: false, rule: 'R665', code: 'sans_agent_responsable' });
  });

  it('[R13] Jamais vu : le vendeur voit quel professionnel est entré chez lui, pour quoi et quand, jamais un nom de personne', async () => {
    const t = await setup();
    const key = await t.register();
    const photo = await t.partner('photographe', 'Studio Lumière');
    await t.cles.handToPartner(t.agentSam, key.keyId, { partnerId: photo, purpose: 'photos', dueAt: iso(MONDAY_9H + 3 * HOUR) });
    t.setClock(MONDAY_9H + 2 * HOUR);
    await t.cles.giveBack(t.agentSam, key.keyId);
    const seen = await t.cles.forSeller(t.sellerViewer, t.property.id);
    expect(seen).toEqual({
      ok: true,
      value: [
        {
          number: 1,
          label: 'Porte d’entrée et cave',
          agent: 'Sam B.',
          purpose: 'Photos du bien',
          takenAt: iso(MONDAY_9H),
          appointment: null,
          returnedAt: iso(MONDAY_9H + 2 * HOUR),
          lost: false,
          partner: { trade: 'Photographe', businessName: 'Studio Lumière' },
        },
      ],
    });
    // Aucun identifiant de partenaire, aucun classement ni note.
    const text = JSON.stringify(seen);
    for (const word of [photo, 'note', 'rang', 'score', 'avis']) expect(text).not.toContain(word);
  });

  it('[R17] tout mouvement va au journal, sans nom ; rien ne change ni ne s’efface ; perdu, il ne sort plus', async () => {
    const t = await setup();
    const key = await t.register();
    const artisan = await t.partner('artisan', 'Menuiserie du Lac');
    await t.cles.handToPartner(t.agentSam, key.keyId, { partnerId: artisan, purpose: 'travaux', dueAt: iso(MONDAY_9H + 3 * HOUR) });
    t.setClock(MONDAY_9H + HOUR);
    await t.cles.giveBack(t.agentSam, key.keyId, 'rendu');
    // Ressorti dans la même milliseconde que son retour : l'historique garde l'ordre vrai.
    await t.cles.handToPartner(t.agentSam, key.keyId, { partnerId: artisan, purpose: 'travaux', dueAt: iso(MONDAY_9H + 4 * HOUR) });
    expect(await t.cles.retire(t.agentSam, key.keyId, 'perdu')).toEqual({ ok: true });
    expect(await t.cles.handToPartner(t.agentSam, key.keyId, { partnerId: artisan, purpose: 'travaux', dueAt: iso(MONDAY_9H + 4 * HOUR) })).toEqual({ ok: false, rule: 'R271', code: 'retire' });
    const rows = await t.journal.all();
    expect(rows.filter((r) => r.subject === `key:${key.keyId}`).map((r) => r.type)).toEqual(['cle.rangee', 'cle.remise_partenaire', 'cle.rendue', 'cle.remise_partenaire', 'cle.perdue']);
    const text = JSON.stringify(rows);
    for (const name of ['Menuiserie', 'Sam', 'Bienveillant', 'Victor']) expect(text).not.toContain(name);
    expect((await verifyChain(rows)).ok).toBe(true);
    const h = await t.cles.history(t.agentSam, key.keyId);
    expect(h.ok && h.value.map((m) => [m.holder.name, m.purpose, m.returned?.outcome, m.partner?.businessName])).toEqual([
      ['Sam B.', 'travaux', 'rendu', 'Menuiserie du Lac'],
      ['Sam B.', 'travaux', 'perdu', 'Menuiserie du Lac'],
    ]);
    for (const table of ['property_key_partner_loans', 'property_key_partner_returns']) {
      const column = table.endsWith('loans') ? 'handed_by' : 'recorded_by';
      await expect(t.db.run(`UPDATE ${table} SET ${column} = ${column}`)).rejects.toThrow(/rien ne change/);
      await expect(t.db.run(`DELETE FROM ${table}`)).rejects.toThrow(/rien ne s'efface/);
    }
  });
});
