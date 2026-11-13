import { expect, it } from 'vitest';
import { Cles } from '../src/cles/cles.ts';
import { Acces, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, verifyChain, type SqlDatabase } from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// BR52 · Qui peut recevoir un trousseau, lu pour l'écran de la sortie. Réseaux, agents, vendeur, partenaires et bien inventés.
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
  return { db, journal, cles, store, network, elsewhere, alex, sam, agentAlex, agentSam, direction, as, property, seller, partner, register, setClock: (t: number) => (clock = t) };
}


let a = 0;
async function appointment(t: Awaited<ReturnType<typeof setup>>, agentId: string, kind: string, start: number, opts: { status?: string; propertyId?: string } = {}) {
  a += 1;
  const id = `rdv${a}`;
  await t.db.run(
    "INSERT INTO appointments (id, network_id, agent_id, person_id, property_id, kind, start_at, end_at, status, token_hash, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'agent', ?, ?)",
    [id, t.network.id, agentId, t.seller.id, opts.propertyId ?? t.property.id, kind, iso(start), iso(start + HOUR), opts.status ?? 'booked', `h-${id}`, iso(MONDAY_9H), iso(MONDAY_9H)],
  );
  return id;
}

describeWithSqlite('BR52 · qui peut recevoir un trousseau', () => {
  it('[R271] agents en activité, rendez-vous prévus et à venir du bien pour une visite ou une estimation, du plus proche au plus lointain', async () => {
    const t = await setup();
    const key = await t.register();
    const gone = await t.store.createAgent({ networkId: t.network.id, firstName: 'Paul', lastName: 'Parti' });
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [gone.id]);
    await t.store.createAgent({ networkId: t.elsewhere.id, firstName: 'Zoé', lastName: 'Ailleurs' });
    const later = await appointment(t, t.alex.id, 'estimation', MONDAY_9H + 26 * HOUR);
    const soon = await appointment(t, t.alex.id, 'visite', MONDAY_9H + 2 * HOUR);
    await appointment(t, t.alex.id, 'visite', MONDAY_9H - 3 * HOUR); // passé
    await appointment(t, t.alex.id, 'visite', MONDAY_9H + 4 * HOUR, { status: 'cancelled' });
    await appointment(t, t.alex.id, 'signature', MONDAY_9H + 5 * HOUR);
    await appointment(t, gone.id, 'visite', MONDAY_9H + 6 * HOUR); // agent parti
    const other = await t.store.createProperty({ networkId: t.network.id, agentId: t.sam.id, reference: 'B2', kind: 'home', city: 'Dijon', priceEur: 200_000, surfaceM2: 70, rooms: 3, status: 'available' });
    await appointment(t, t.alex.id, 'visite', MONDAY_9H + 7 * HOUR, { propertyId: other.id });
    const r = await t.cles.choices(t.agentSam, key.keyId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.agents).toEqual([
      { agentId: t.alex.id, name: 'Alex A.' },
      { agentId: t.sam.id, name: 'Sam B.' },
    ]);
    expect(r.value.appointments).toEqual([
      { appointmentId: soon, kind: 'visite', startAt: iso(MONDAY_9H + 2 * HOUR), endAt: iso(MONDAY_9H + 3 * HOUR), agentId: t.alex.id, name: 'Alex A.' },
      { appointmentId: later, kind: 'estimation', startAt: iso(MONDAY_9H + 26 * HOUR), endAt: iso(MONDAY_9H + 27 * HOUR), agentId: t.alex.id, name: 'Alex A.' },
    ]);
    // Chaque rendez-vous proposé fait vraiment sortir la clé.
    expect((await t.cles.handOut(t.agentSam, key.keyId, { holderAgentId: t.alex.id, purpose: 'visite', appointmentId: soon })).ok).toBe(true);
  });

  it('[R271] tous les rendez-vous à venir sont proposés, sans plafond', async () => {
    const t = await setup();
    const key = await t.register();
    for (let i = 0; i < 25; i++) await appointment(t, t.alex.id, 'visite', MONDAY_9H + (i + 1) * HOUR);
    const last = await appointment(t, t.alex.id, 'estimation', MONDAY_9H + 30 * HOUR);
    const r = await t.cles.choices(t.agentSam, key.keyId);
    expect(r.ok && r.value.appointments).toHaveLength(26);
    expect(r.ok && r.value.appointments.at(-1)!.appointmentId).toBe(last);
  });

  it('[R665] seuls les partenaires du réseau au métier qui entre seul et aux justificatifs valides ce jour-là, sans nom de personne', async () => {
    const t = await setup();
    const key = await t.register();
    const diag = await t.partner('diagnostiqueur', 'Diag Bourgogne SARL');
    const photo = await t.partner('photographe', 'Studio Lumière');
    await t.partner('notaire', 'Étude des Ducs');
    await t.partner('artisan', 'Plomberie échue', { until: '2026-11-30' });
    await t.partner('artisan', 'Sans papiers', { credentials: false });
    await t.partner('photographe', 'Autre réseau photo', { networkId: t.elsewhere.id });
    const r = await t.cles.choices(t.direction, key.keyId);
    expect(r.ok && r.value.partners).toEqual([
      { partnerId: diag, trade: 'diagnostiqueur', tradeLabel: 'Diagnostiqueur certifié', businessName: 'Diag Bourgogne SARL' },
      { partnerId: photo, trade: 'photographe', tradeLabel: expect.any(String), businessName: 'Studio Lumière' },
    ]);
    for (const p of r.ok ? r.value.partners : []) expect(Object.keys(p).sort()).toEqual(['businessName', 'partnerId', 'trade', 'tradeLabel']);
    expect((await t.cles.handToPartner(t.direction, key.keyId, { partnerId: photo, purpose: 'photos', dueAt: iso(MONDAY_9H + 2 * HOUR) })).ok).toBe(true);
  });

  it('[R271] rien n’est proposé pour un trousseau sorti, perdu ou rendu au propriétaire', async () => {
    const t = await setup();
    const key = await t.register();
    expect((await t.cles.handOut(t.agentSam, key.keyId, { holderAgentId: t.alex.id, purpose: 'photos', dueAt: iso(MONDAY_9H + 2 * HOUR) })).ok).toBe(true);
    expect(await t.cles.choices(t.agentSam, key.keyId)).toEqual({ ok: false, rule: 'R271', code: 'deja_sorti' });
    expect(await t.cles.giveBack(t.agentSam, key.keyId)).toEqual({ ok: true });
    expect((await t.cles.choices(t.agentSam, key.keyId)).ok).toBe(true);
    expect((await t.cles.retire(t.agentSam, key.keyId, 'rendu_au_proprietaire')).ok).toBe(true);
    expect(await t.cles.choices(t.agentSam, key.keyId)).toEqual({ ok: false, rule: 'R271', code: 'deja_retire' });
    expect(await t.cles.choices(t.agentSam, 'inconnu')).toEqual({ ok: false, rule: null, code: 'unknown_key' });
  });

  it('[R16] mêmes droits que la sortie : un autre agent, la conformité ou un autre réseau sont refusés au journal', async () => {
    const t = await setup();
    const key = await t.register();
    expect(await t.cles.choices(t.agentAlex, key.keyId)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.cles.choices(t.as('compliance', 'c1'), key.keyId)).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.cles.choices({ role: 'direction', userId: 'd2', networkId: t.elsewhere.id }, key.keyId)).toEqual({ ok: false, rule: null, code: 'unknown_key' });
    const refusals = await t.db.all<{ data: string }>("SELECT data FROM journal WHERE type = 'acces.refuse'");
    expect(refusals.length).toBeGreaterThanOrEqual(2);
    const ok = await t.cles.choices(t.direction, key.keyId);
    expect(ok.ok).toBe(true);
    const read = await t.db.all<{ data: string }>("SELECT data FROM journal WHERE type = 'cle.choix_lus'");
    expect(read).toHaveLength(1);
    expect(read[0]!.data).not.toMatch(/Alex|Sam|Agent|Bienveillant/);
  });
});
