import { describe, expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, RendezVous, SqlJournalStore, Visites, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { euros } from '../src/annonces/mentions.ts';
import { BUDGETS, budgetProblems, htmlProblems } from '../src/design/audit.ts';
import { dossierProblems, publishedVersionOf, renderDossier, VisiteDistance } from '../src/medias/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, agents, vendeurs, visiteurs et biens inventés.
const MONDAY_9H = Date.parse('2026-12-07T08:00:00.000Z');
const HOUR = 3_600_000;
const WEEK = { weekly: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: '09:00', to: '19:00' })) };
const TEMPLATE = 'Bon de visite : {{visiteur.nom}} visite {{bien.reference}} le {{visite.date}}.';
const MENTIONS = `Prix : ${euros(250_000)} honoraires inclus, à la charge de l'acquéreur, soit 4,5 % TTC du prix hors honoraires.\nClasse énergie D, classe climat C.`;
const BODY = 'Maison familiale lumineuse, quatre pièces, jardin au calme.';

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
  const blocked = new Set<string>();
  const diffusion = { canDiffuse: async (_n: string, id: string) => (blocked.has(id) ? { allowed: false, reason: 'mandate_expired' } : { allowed: true, reason: 'allowed' }) };
  const visites = new Visites(db, journal, acces, { diffusion, rendezVous: rdv, now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const as = (role: 'agent' | 'direction', userId: string) => ({ role, userId, networkId: network.id });
  await rdv.setAvailability(as('agent', alex.id), WEEK);
  await visites.createSlipTemplate(as('direction', 'd1'), TEMPLATE);
  const seller = await store.createPerson({ networkId: network.id, agentId: sam.id, firstName: 'Victor', lastName: 'Vendeur' });
  await store.addIdentifier({ networkId: network.id, personId: seller.id, kind: 'email', value: 'victor@example.test' });
  const sellerProject = await store.createProject({ networkId: network.id, agentId: sam.id, personId: seller.id, kind: 'sell', note: 'Vendeur pressé, divorce en cours' });
  const p = await store.createProperty({ networkId: network.id, agentId: sam.id, reference: 'B1', kind: 'home', city: 'Talant', priceEur: 250_000, surfaceM2: 90, rooms: 4, status: 'available' });
  const signed = new Date(MONDAY_9H - 20 * 24 * HOUR).toISOString();
  await db.run("INSERT INTO mandates (id, network_id, agent_id, person_id, project_id, property_id, signed_at, source_kind, recorded_by, created_at) VALUES ('m1', ?, ?, ?, ?, ?, ?, 'site', 'test', ?)", [
    network.id,
    sam.id,
    seller.id,
    sellerProject.id,
    p.id,
    signed,
    signed,
  ]);
  await db.run(
    "INSERT INTO mandate_register (network_id, seq, kind, mandate_id, number_value, number, agent_id, property_id, signed_at, at, actor, prev_hash, hash) VALUES (?, 1, 'inscription', 'm1', 4701, 'MAND-4701', ?, ?, ?, ?, 'test', 'p', 'h-m1')",
    [network.id, sam.id, p.id, signed, signed],
  );
  let versions = 0;
  /** Publie une nouvelle version de l'annonce du bien. */
  const publish = async (o: { body?: string; state?: 'en_vente' | 'sous_offre' | 'retiree'; price?: number } = {}) => {
    versions += 1;
    const draft = `d${versions}`;
    const body = o.body ?? BODY;
    await db.run("INSERT INTO listing_drafts (id, property_id, network_id, seq, title, body, origin, trace, created_by, created_at) VALUES (?, ?, ?, ?, 'Maison de 4 pièces à Talant', ?, 'agent', '[]', 'test', ?)", [
      draft,
      p.id,
      network.id,
      versions,
      body,
      now().toISOString(),
    ]);
    const state = o.state ?? 'en_vente';
    const payload =
      state === 'retiree'
        ? '{}'
        : JSON.stringify({ reference: 'B1', version: versions, state, title: 'Maison de 4 pièces à Talant', body, mentions: MENTIONS, priceEur: o.price ?? 250_000, media: [{ ref: `biens/${p.id}/photos/sejour.jpg`, kind: 'photo', overlay: null }] });
    await db.run('INSERT INTO listing_versions (id, property_id, network_id, seq, state, draft_id, price_eur, payload, payload_hash, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      `v${versions}`,
      p.id,
      network.id,
      versions,
      state,
      state === 'retiree' ? null : draft,
      state === 'retiree' ? null : (o.price ?? 250_000),
      payload,
      `h${versions}`,
      'test',
      now().toISOString(),
    ]);
  };
  await publish();
  let n = 0;
  let tokens = 0;
  const issued: string[] = [];
  let codes = 0;
  const dist = new VisiteDistance(db, acces, journal, visites, {
    diffusion,
    now,
    newToken: () => {
      tokens += 1;
      const t = tokens.toString(16).padStart(64, 'a');
      issued.push(t);
      return t;
    },
    newCode: () => String(123456 + codes++),
  });
  /** Un visiteur inventé d'Alex, avec son mail, et sa visite du bien demain. */
  const visit = async (firstName = 'Inès', lastName = 'Durand') => {
    n += 1;
    const buyer = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName, lastName });
    await store.addIdentifier({ networkId: network.id, personId: buyer.id, kind: 'email', value: `visiteur${n}@example.test` });
    const project = await store.createProject({ networkId: network.id, agentId: alex.id, personId: buyer.id, kind: 'buy', note: 'Budget serré, banque réticente' });
    const r = await visites.schedule(as('agent', alex.id), { propertyId: p.id, projectId: project.id, start: new Date(MONDAY_9H + 24 * HOUR + n * 90 * 60_000) });
    if (!r.ok) throw new Error(r.code);
    return { id: r.visit.appointment.id, start: Date.parse(r.visit.appointment.start_at), end: Date.parse(r.visit.appointment.end_at), buyer, project };
  };
  const outbox = (personId: string) => db.all<{ body: string }>('SELECT m.body FROM messages m JOIN trial_outbox t ON t.message_id = m.id WHERE m.person_id = ? ORDER BY m.occurred_at, m.created_at', [personId]);
  let offers = 0;
  const offer = async (buyerId: string) => {
    offers += 1;
    const seq = (await db.first<{ n: number }>('SELECT COUNT(*) AS n FROM offer_register WHERE property_id = ?', [p.id]))!.n + 1;
    return db.run(
      `INSERT INTO offer_register (id, network_id, property_id, seq, buyer_person_id, amount_eur, conditions, valid_until, down_payment_eur, loan_eur, signed_ref, received_at, agent_id, at, actor, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, 240000, '[]', '2026-12-31', 40000, 200000, 'offres/o.pdf', ?, ?, ?, 'test', 'p', ?)`,
      [`o${offers}`, network.id, p.id, seq, buyerId, now().toISOString(), alex.id, now().toISOString(), `ho${offers}`],
    );
  };
  return { db, journal, dist, store, fiche, network, alex, sam, as, visit, publish, outbox, offer, issued, blocked, property: p, seller, setClock: (t: number) => (clock = t) };
}

describe('HX44 · le dossier du bien, rendu par le code', () => {
  const row = { id: 'v1', state: 'en_vente', payload: JSON.stringify({ title: 'Maison', body: BODY, mentions: MENTIONS, priceEur: 250_000, media: [{ ref: 'biens/x/photos/a.jpg', kind: 'photo', overlay: null }] }), payload_hash: 'h', created_at: '2026-12-01T10:00:00.000Z' };

  it('[R502] seule une version publiée complète, en vente ou sous offre, fait un dossier', () => {
    expect(publishedVersionOf(row, 'B1')).toMatchObject({ versionId: 'v1', reference: 'B1', priceEur: 250_000, photos: [{ ref: 'biens/x/photos/a.jpg', overlay: null }] });
    expect(publishedVersionOf({ ...row, state: 'retiree' }, 'B1')).toBeNull();
    expect(publishedVersionOf({ ...row, state: 'vendu' }, 'B1')).toBeNull();
    expect(publishedVersionOf({ ...row, payload: '{"title":"Maison"}' }, 'B1')).toBeNull();
    expect(publishedVersionOf({ ...row, payload: 'pas du json' }, 'B1')).toBeNull();
  });

  it('[R502] [R201] la page suit le système de design, sans rien venu d’ailleurs', () => {
    const html = renderDossier(publishedVersionOf(row, 'B1')!);
    expect(htmlProblems(html)).toEqual([]);
    expect(budgetProblems({ html }, BUDGETS.page)).toEqual([]);
    expect(html).toContain(BODY);
    expect(html).toContain('honoraires inclus');
  });

  it('[R502] la relecture trouve un nom, une note ou un chiffre qui ne vient pas de l’annonce', () => {
    const v = publishedVersionOf(row, 'B1')!;
    const html = renderDossier(v);
    expect(dossierProblems(html, v, [{ names: ['Victor', 'Vendeur'], values: ['victor@example.test'] }])).toEqual([]);
    const leaky = publishedVersionOf({ ...row, payload: JSON.stringify({ ...JSON.parse(row.payload), body: `${BODY} Contact : M. Vendeur.` }) }, 'B1')!;
    expect(dossierProblems(renderDossier(leaky), leaky, [{ names: ['Vendeur'], values: [] }])).toEqual(['vendeur']);
    // Un chiffre glissé dans la page sans venir de l'annonce : des honoraires de 11 250 €.
    expect(dossierProblems(html.replace('</main>', '<p>Honoraires 11 250 €</p></main>'), v, [])).toEqual(['chiffre:11250']);
  });
});

describeWithSqlite('HX44 · dossier envoyé avant la visite', () => {
  it('[R502] aucun nom de vendeur, honoraire, numéro de mandat ni note interne dans le dossier envoyé', async () => {
    const t = await setup();
    // Les honoraires du dossier et la note de la visite existent dans la base.
    const v = await t.visit();
    await t.db.run("INSERT INTO visit_field_notes (id, network_id, appointment_id, agent_id, body, written_at, received_at) VALUES ('n1', ?, ?, ?, 'Le visiteur hésite avec un autre bien', ?, ?)", [
      t.network.id,
      v.id,
      t.alex.id,
      new Date(MONDAY_9H).toISOString(),
      new Date(MONDAY_9H).toISOString(),
    ]);
    const sent = await t.dist.sendDossier(t.as('agent', t.alex.id), v.id, { consentProof: 'accord donné à la réservation' });
    expect(sent).toMatchObject({ ok: true, value: { versionId: 'v1' } });
    const opened = await t.dist.openDossier(t.issued[0]);
    expect(opened.ok).toBe(true);
    const html = opened.ok ? opened.html : '';
    for (const secret of ['Victor', 'Vendeur', 'victor@example.test', 'MAND-4701', '4701', 'divorce', 'Budget serré', 'hésite', 'Sam Agent', '11 250', '11250']) expect(html).not.toContain(secret);
    expect(html).toContain(BODY);
    expect(html).toContain('annonce publiée le 07/12/2026');
  });

  it('[R502] un texte publié qui trahit le vendeur ou une note : rien ne part', async () => {
    const t = await setup();
    await t.publish({ body: `${BODY} Monsieur Vendeur part vite.` });
    const v = await t.visit();
    expect(await t.dist.sendDossier(t.as('agent', t.alex.id), v.id, { consentProof: 'accord' })).toEqual({ ok: false, rule: 'R502', code: 'confidential' });
    await t.publish({ body: `${BODY} Divorce en cours.` });
    // Un mot de la note seul ne suffit pas à la trahir : la note entière, si.
    await t.publish({ body: `${BODY} Vendeur pressé, divorce en cours` });
    expect(await t.dist.sendDossier(t.as('agent', t.alex.id), v.id, { consentProof: 'accord' })).toEqual({ ok: false, rule: 'R502', code: 'confidential' });
    expect(await t.outbox(v.buyer.id)).toEqual([]);
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM visit_dossiers')).toEqual({ n: 0 });
  });

  it('[R503] l’envoi passe par le contrôle central : en essai, rien ne part ; sans accord, rien', async () => {
    const t = await setup();
    const v = await t.visit();
    expect(await t.dist.sendDossier(t.as('agent', t.alex.id), v.id)).toEqual({ ok: false, rule: 'R03', code: 'no_consent' });
    const sent = await t.dist.sendDossier(t.as('agent', t.alex.id), v.id, { consentProof: 'accord donné à la réservation' });
    expect(sent.ok).toBe(true);
    // Le message est rangé par le contrôle central dans la boîte d'essai, et l'envoi est à son journal.
    const box = await t.outbox(v.buyer.id);
    expect(box).toHaveLength(1);
    expect(box[0]!.body).toContain('Bonjour Inès');
    expect(box[0]!.body).toContain(t.issued[0]);
    expect(box[0]!.body).not.toContain('Vendeur');
    const row = await t.db.first<{ status: string; message_id: string }>('SELECT status, message_id FROM visit_dossiers');
    expect(row?.status).toBe('envoye');
    expect(await t.db.first('SELECT id FROM messages WHERE id = ?', [row!.message_id])).not.toBeNull();
    // La nuit, le contrôle central refuse : le dossier est noté refusé, rien ne part.
    const w = await t.visit('Jean', 'Martin');
    t.setClock(Date.parse('2026-12-07T22:30:00.000Z'));
    const night = await t.dist.sendDossier(t.as('agent', t.alex.id), w.id, { consentProof: 'accord' });
    expect(night).toMatchObject({ ok: false, code: 'send_refused' });
    expect(await t.outbox(w.buyer.id)).toEqual([]);
    expect(await t.db.first<{ status: string }>('SELECT status FROM visit_dossiers WHERE appointment_id = ?', [w.id])).toEqual({ status: 'refuse' });
  });

  it('[R502] avant la visite seulement, bien diffusable et publié, par qui suit le visiteur', async () => {
    const t = await setup();
    const v = await t.visit();
    expect(await t.dist.sendDossier(t.as('agent', t.sam.id), v.id, { consentProof: 'accord' })).toMatchObject({ ok: false, rule: 'R16' });
    t.blocked.add(t.property.id);
    expect(await t.dist.sendDossier(t.as('agent', t.alex.id), v.id, { consentProof: 'accord' })).toEqual({ ok: false, rule: 'R42', code: 'not_diffusable' });
    t.blocked.clear();
    t.setClock(v.start + 60_000);
    expect(await t.dist.sendDossier(t.as('agent', t.alex.id), v.id, { consentProof: 'accord' })).toEqual({ ok: false, rule: 'R502', code: 'visit_started' });
    t.setClock(MONDAY_9H);
    await t.publish({ state: 'retiree' });
    expect(await t.dist.sendDossier(t.as('agent', t.alex.id), v.id, { consentProof: 'accord' })).toEqual({ ok: false, rule: 'R502', code: 'not_published' });
  });

  it('[R502] le lien ne montre plus rien quand une autre version est publiée, le bien retiré, ou le lien expiré', async () => {
    const t = await setup();
    const v = await t.visit();
    expect((await t.dist.sendDossier(t.as('agent', t.alex.id), v.id, { consentProof: 'accord' })).ok).toBe(true);
    const token = t.issued[0]!;
    expect((await t.dist.openDossier(token)).ok).toBe(true);
    expect(await t.dist.openDossier('0'.repeat(64))).toEqual({ ok: false, rule: null, code: 'unknown' });
    expect(await t.dist.openDossier('pas un jeton')).toEqual({ ok: false, rule: null, code: 'unknown' });
    t.blocked.add(t.property.id);
    expect(await t.dist.openDossier(token)).toEqual({ ok: false, rule: 'R42', code: 'not_diffusable' });
    t.blocked.clear();
    await t.publish({ price: 245_000 });
    expect(await t.dist.openDossier(token)).toEqual({ ok: false, rule: 'R502', code: 'outdated' });
    // Un nouvel envoi prend la version du jour.
    const again = await t.dist.sendDossier(t.as('agent', t.alex.id), v.id, { consentProof: 'accord' });
    expect(again).toMatchObject({ ok: true, value: { versionId: 'v2' } });
    const fresh = await t.dist.openDossier(t.issued[1]);
    expect(fresh.ok && fresh.html.includes(euros(245_000))).toBe(true);
    t.setClock(v.end + 8 * 24 * HOUR);
    expect(await t.dist.openDossier(t.issued[1])).toEqual({ ok: false, rule: null, code: 'expired' });
  });

  it('[R17] un dossier envoyé ne change plus et ne s’efface pas', async () => {
    const t = await setup();
    const v = await t.visit();
    await t.dist.sendDossier(t.as('agent', t.alex.id), v.id, { consentProof: 'accord' });
    await expect(t.db.run("UPDATE visit_dossiers SET content = 'autre'")).rejects.toThrow(/ne change plus/);
    await expect(t.db.run("UPDATE visit_dossiers SET status = 'refuse'")).rejects.toThrow(/ne change plus/);
    await expect(t.db.run('DELETE FROM visit_dossiers')).rejects.toThrow(/rien ne s'efface/);
  });
});

describeWithSqlite('HX44 · visite à distance et bon signé en ligne', () => {
  const remote = async (t: Awaited<ReturnType<typeof setup>>, v: { id: string; start: number; end: number }) => {
    t.setClock(v.start);
    expect((await t.dist.startRemote(t.as('agent', t.alex.id), v.id)).ok).toBe(true);
    t.setClock(v.start + 20 * 60_000);
    return t.dist.endRemote(t.as('agent', t.alex.id), v.id, { consentProof: 'accord donné en début d’appel' });
  };

  it('[R505] un bon de visite à distance est signé avant toute offre, gardé par la base', async () => {
    const t = await setup();
    const v = await t.visit();
    const ended = await remote(t, v);
    expect(ended).toMatchObject({ ok: true, value: { signature: { ok: true } } });
    await expect(t.offer(v.buyer.id)).rejects.toThrow(/bon de la visite à distance non signé/);
    expect(await t.dist.bonDistanceManquant(t.network.id, t.property.id, v.buyer.id)).toEqual({ missing: true, appointmentId: v.id });
    // Un autre acquéreur, qui n'a pas visité à distance, n'est pas gêné.
    const other = await t.store.createPerson({ networkId: t.network.id, agentId: t.alex.id, firstName: 'Paul', lastName: 'Autre' });
    await expect(t.offer(other.id)).resolves.toBeDefined();
    const token = t.issued.at(-1)!;
    expect(await t.dist.signSlip(token, { code: '123456' })).toMatchObject({ ok: true, value: { method: 'code', mode: 'essai', realSignature: false } });
    expect(await t.dist.bonDistanceManquant(t.network.id, t.property.id, v.buyer.id)).toEqual({ missing: false });
    await expect(t.offer(v.buyer.id)).resolves.toBeDefined();
  });

  it('[R505] une fiche réunie ne passe pas à côté du bon manquant', async () => {
    const t = await setup();
    const v = await t.visit();
    await remote(t, v);
    const twin = await t.store.createPerson({ networkId: t.network.id, agentId: t.alex.id, firstName: 'Inès', lastName: 'Durand' });
    await t.db.run("INSERT INTO person_merges (id, network_id, agent_id, survivor_id, merged_id, reason, merged_at, created_at) VALUES ('pm1', ?, ?, ?, ?, 'doublon', ?, ?)", [
      t.network.id,
      t.alex.id,
      twin.id,
      v.buyer.id,
      new Date(MONDAY_9H).toISOString(),
      new Date(MONDAY_9H).toISOString(),
    ]);
    await expect(t.offer(twin.id)).rejects.toThrow(/bon de la visite à distance non signé/);
    expect(await t.dist.bonDistanceManquant(t.network.id, t.property.id, twin.id)).toEqual({ missing: true, appointmentId: v.id });
  });

  it('[R504] le lien et le code partent juste après, par le contrôle central, chacun dans son message', async () => {
    const t = await setup();
    const v = await t.visit();
    await remote(t, v);
    const box = await t.outbox(v.buyer.id);
    expect(box).toHaveLength(2);
    expect(box[0]!.body).toContain(t.issued.at(-1));
    expect(box[0]!.body).not.toContain('123456');
    expect(box[1]!.body).toContain('123456');
    expect(box[1]!.body).not.toContain(t.issued.at(-1));
    const read = await t.dist.readSlip(t.issued.at(-1));
    expect(read).toMatchObject({ ok: true });
    expect(read.ok && read.content).toContain('B1');
    // Aucun code ni jeton en clair dans la base.
    const s = await t.db.first<Record<string, unknown>>('SELECT * FROM remote_slip_signatures');
    expect(JSON.stringify(s)).not.toContain('123456');
    expect(JSON.stringify(s)).not.toContain(t.issued.at(-1));
  });

  it('[R504] le code ne sert qu’une fois, expire, et cinq essais faux bloquent', async () => {
    const t = await setup();
    const v = await t.visit();
    await remote(t, v);
    const token = t.issued.at(-1)!;
    for (let i = 1; i < 5; i++) expect(await t.dist.signSlip(token, { code: '000000' })).toEqual({ ok: false, rule: null, code: 'wrong_code' });
    expect(await t.dist.signSlip(token, { code: '000000' })).toEqual({ ok: false, rule: null, code: 'blocked' });
    expect(await t.dist.signSlip(token, { code: '123456' })).toEqual({ ok: false, rule: null, code: 'blocked' });
    // L'agent rouvre la signature : un nouveau lien, l'ancien ne vaut plus rien.
    const again = await t.dist.startSignature(t.as('agent', t.alex.id), v.id);
    expect(again).toMatchObject({ ok: true });
    expect(await t.dist.signSlip(token, { code: '123456' })).toEqual({ ok: false, rule: null, code: 'blocked' });
    const fresh = t.issued.at(-1)!;
    t.setClock(v.start + 20 * 60_000 + 11 * 60_000);
    expect(await t.dist.signSlip(fresh, { code: '123456' })).toEqual({ ok: false, rule: null, code: 'expired' });
    t.setClock(v.start + 20 * 60_000 + 60_000);
    const third = await t.dist.startSignature(t.as('agent', t.alex.id), v.id);
    expect(third.ok).toBe(true);
    expect(await t.dist.signSlip(fresh, { code: '123456' })).toEqual({ ok: false, rule: null, code: 'unknown' });
    const last = t.issued.at(-1)!;
    expect(await t.dist.signSlip(last, { code: '123458', drawing: 'M0 0 L10 10' })).toMatchObject({ ok: true, value: { method: 'code_et_trace' } });
    expect(await t.dist.signSlip(last, { code: '123456' })).toEqual({ ok: false, rule: null, code: 'already_signed' });
    expect(await t.dist.startSignature(t.as('agent', t.alex.id), v.id)).toEqual({ ok: false, rule: null, code: 'already_signed' });
    await expect(t.db.run("UPDATE remote_slip_signatures SET status = 'ouverte' WHERE status = 'signee'")).rejects.toThrow(/ne change plus/);
  });

  it('[R504] une visite à distance se fait à son heure, par qui suit le visiteur, et seul son bon se signe en ligne', async () => {
    const t = await setup();
    const v = await t.visit();
    t.setClock(v.start - 31 * 60_000);
    expect(await t.dist.startRemote(t.as('agent', t.alex.id), v.id)).toEqual({ ok: false, rule: null, code: 'outside_slot' });
    t.setClock(v.start - 30 * 60_000);
    expect(await t.dist.startRemote(t.as('agent', t.sam.id), v.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.dist.startSignature(t.as('agent', t.alex.id), v.id)).toEqual({ ok: false, rule: 'R504', code: 'not_remote' });
    expect(await t.dist.endRemote(t.as('agent', t.alex.id), v.id)).toEqual({ ok: false, rule: null, code: 'not_started' });
    expect((await t.dist.startRemote(t.as('agent', t.alex.id), v.id)).ok).toBe(true);
    expect(await t.dist.startRemote(t.as('agent', t.alex.id), v.id)).toEqual({ ok: false, rule: null, code: 'already_started' });
    // Commencée, la visite bloque déjà les offres, même si la liaison coupe avant la fin.
    await expect(t.offer(v.buyer.id)).rejects.toThrow(/non signé/);
    expect(await t.dist.startSignature(t.as('agent', t.alex.id), v.id)).toEqual({ ok: false, rule: 'R504', code: 'not_ended' });
    const ended = await t.dist.endRemote(t.as('agent', t.alex.id), v.id);
    // Sans accord du visiteur pour recevoir le lien et le code, la signature attend la preuve de l'agent.
    expect(ended).toMatchObject({ ok: true, value: { signature: { ok: false, rule: 'R03', code: 'no_consent' } } });
    expect(await t.dist.endRemote(t.as('agent', t.alex.id), v.id)).toEqual({ ok: false, rule: null, code: 'already_ended' });
    expect((await t.dist.startSignature(t.as('agent', t.alex.id), v.id, { consentProof: 'accord' })).ok).toBe(true);
    await expect(t.db.run('DELETE FROM remote_visits')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run("UPDATE remote_visits SET ended_at = '2030-01-01T00:00:00.000Z'")).rejects.toThrow(/ne change plus/);
  });
});

