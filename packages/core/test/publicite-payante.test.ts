import { expect, it } from 'vitest';
import { FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { FORBIDDEN_TARGETING, LAUNCH_ANSWER_MINUTES, PublicitePayante, readTargeting, trialAdPlatform, type AdPlatform } from '../src/marketing/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, agents, personnes, communes et montants inventés.
const START = Date.parse('2027-10-11T08:00:00.000Z');
const TARGET = { communes: ['21231', '21166'], rayonKm: 20 };
const BUDGET = { dailyBudgetCents: 2_000, totalBudgetCents: 30_000, maxCostPerContactCents: 1_500 };

async function setup(platforms?: { google_ads: AdPlatform; meta: AdPlatform }, options: { launchTimeoutMs?: number } = {}) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = START;
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const google = trialAdPlatform();
  const meta = trialAdPlatform();
  const pub = new PublicitePayante(db, journal, platforms ?? { google_ads: google, meta }, { now, ...options });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alexandrine', lastName: 'Fictive' });
  const dir = { role: 'direction' as const, userId: 'dir-1', networkId: network.id };
  const agent = { role: 'agent' as const, userId: alex.id, networkId: network.id };
  let n = 0;
  const person = async (who: string) => (await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: who, lastName: 'Essai' })).id;
  /** Un mandat et, s'il le faut, l'acte du bien (lignes inventées, rangées sans le parcours de M06 et M10). */
  const mandate = async (personId: string, signedAt: string, sold = false) => {
    await db.exec('PRAGMA foreign_keys = OFF');
    const property = `bien-${++n}`;
    await db.run("INSERT INTO mandates (id, network_id, agent_id, person_id, property_id, signed_at, source_kind, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 'portal', 'agent:test', ?)", [`m-${n}`, network.id, alex.id, personId, property, signedAt, signedAt]);
    if (sold) {
      await db.run('INSERT INTO sale_files (id, network_id, property_id, offer_id, buyer_person_id, amount_eur, opened_at, opened_by) VALUES (?, ?, ?, ?, ?, 200000, ?, ?)', [`d-${n}`, network.id, property, `o-${n}`, 'acquereur-x', signedAt, 'agent:test']);
      await db.run("INSERT INTO sale_file_closings (file_id, network_id, signed_on, proof_ref, aftersale, at, by) VALUES (?, ?, '2027-12-01', 'preuves/test.pdf', 'a_demarrer', '2027-12-01T08:00:00.000Z', 'agent:test')", [`d-${n}`, network.id]);
    }
    await db.exec('PRAGMA foreign_keys = ON');
  };
  const events = async (type: string) => (await db.all<{ data: string }>('SELECT data FROM journal WHERE type = ?', [type])).map((r) => JSON.parse(r.data) as Record<string, unknown>);
  /** Une campagne créée, validée et lancée par la direction. */
  const running = async (budget = BUDGET) => {
    const c = await pub.create(dir, { platform: 'google_ads', name: 'Vendeurs Dijon', targeting: TARGET });
    if (!c.ok) throw new Error(c.code);
    const a = await pub.approve(dir, c.value.id, budget);
    if (!a.ok) throw new Error(a.code);
    const s = await pub.start(dir, c.value.id);
    if (!s.ok) throw new Error(s.code);
    return c.value;
  };
  const advance = (ms: number) => {
    clock += ms;
  };
  return { db, journal, store, fiche, pub, google, meta, network, alex, dir, agent, person, mandate, events, running, advance };
}

describeWithSqlite('HX54 · publicité payante mesurée au mandat', () => {
  it('[R587] aucune dépense sans validation de la direction : un agent propose, seule la direction valide et lance', async () => {
    const t = await setup();
    const c = await t.pub.create(t.agent, { platform: 'meta', name: 'Acquéreurs Talant', targeting: TARGET });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    // Sans validation, rien ne part.
    expect(await t.pub.start(t.dir, c.value.id)).toMatchObject({ ok: false, rule: 'R587', code: 'sans_validation' });
    // L'agent ne valide ni ne lance.
    expect(await t.pub.approve(t.agent, c.value.id, BUDGET)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.pub.start(t.agent, c.value.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.pub.approve(t.dir, c.value.id, { ...BUDGET, totalBudgetCents: 100 })).toMatchObject({ ok: false, rule: 'R587', code: 'bad_budget' });
    expect(t.meta.started).toEqual([]);
    const a = await t.pub.approve(t.dir, c.value.id, BUDGET);
    expect(a).toMatchObject({ ok: true, value: { version: 1 } });
    expect(await t.pub.start(t.dir, c.value.id)).toMatchObject({ ok: true });
    // La plateforme ne reçoit que le code, la zone et les budgets validés.
    expect(t.meta.started).toEqual([{ code: c.value.code, communes: ['21166', '21231'], radiusKm: 20, dailyBudgetCents: 2_000, totalBudgetCents: 30_000 }]);
    // Rejoué : la base refuse un second lancement.
    expect(await t.pub.start(t.dir, c.value.id)).toMatchObject({ ok: false, rule: 'R587', code: 'deja_lancee_ou_arretee' });
    expect(t.meta.started).toHaveLength(1);
    expect(t.google.started).toEqual([]);
    // Une validation ne se remplace pas pendant qu'elle dépense.
    expect(await t.pub.approve(t.dir, c.value.id, BUDGET)).toMatchObject({ ok: false, rule: 'R587', code: 'en_cours' });
  });

  it('[R587] la base refuse tout lancement sans validation de la direction, remplacée ou déjà arrêtée', async () => {
    const t = await setup();
    const c = await t.pub.create(t.dir, { platform: 'google_ads', name: 'Vendeurs Dijon', targeting: TARGET });
    if (!c.ok) throw new Error(c.code);
    const insertStart = (approvalId: string, by = 'direction:dir-1') =>
      t.db.run("INSERT INTO ad_campaign_starts (approval_id, campaign_id, mode, started_by, started_at) VALUES (?, ?, 'essai', ?, 'x')", [approvalId, c.value.id, by]);
    await expect(insertStart('inconnue')).rejects.toThrow();
    // Une validation qui n'est pas de la direction est refusée par la base.
    await expect(t.db.run("INSERT INTO ad_campaign_approvals (id, campaign_id, version, daily_budget_cents, total_budget_cents, max_cost_per_contact_cents, approved_by, approved_at) VALUES ('a0', ?, 1, 10, 10, 10, 'agent:x', 'x')", [c.value.id])).rejects.toThrow();
    const v1 = await t.pub.approve(t.dir, c.value.id, BUDGET);
    const v2 = await t.pub.approve(t.dir, c.value.id, BUDGET);
    if (!v1.ok || !v2.ok) throw new Error('validation');
    await expect(insertStart(v1.value.approvalId)).rejects.toThrow(/dernière validation/);
    await expect(insertStart(v2.value.approvalId, 'agent:x')).rejects.toThrow();
    // Le mode réel n'existe pas.
    await expect(t.db.run("INSERT INTO ad_campaign_starts (approval_id, campaign_id, mode, started_by, started_at) VALUES (?, ?, 'reel', 'direction:dir-1', 'x')", [v2.value.approvalId, c.value.id])).rejects.toThrow();
    expect(await t.pub.start(t.dir, c.value.id)).toMatchObject({ ok: true });
    expect(await t.pub.stop(t.dir, c.value.id)).toMatchObject({ ok: true });
    // Arrêtée, elle ne repart jamais sans une validation nouvelle.
    expect(await t.pub.start(t.dir, c.value.id)).toMatchObject({ ok: false, rule: 'R587' });
    await expect(t.db.run('DELETE FROM ad_campaign_stops')).rejects.toThrow(/efface/);
    await expect(t.db.run("UPDATE ad_campaign_stops SET reason = 'seuil'")).rejects.toThrow();
    // AU038 : une plateforme réelle sans plafond réglé (H63) est refusée dès la construction ; un mode inconnu aussi.
    const real = { ...trialAdPlatform(), mode: 'reel' } as unknown as AdPlatform;
    await expect(setup({ google_ads: real, meta: trialAdPlatform() })).rejects.toThrow(/plafond/);
    const odd = { ...trialAdPlatform(), mode: 'autre' } as unknown as AdPlatform;
    await expect(setup({ google_ads: odd, meta: trialAdPlatform() })).rejects.toThrow(/mode inconnu/);
  });

  it('[R587] une dépense sur une campagne jamais lancée n’est pas rangée, elle est signalée', async () => {
    const t = await setup();
    const c = await t.pub.create(t.dir, { platform: 'google_ads', name: 'Vendeurs Dijon', targeting: TARGET });
    if (!c.ok) throw new Error(c.code);
    expect(await t.pub.recordSpend(t.network.id, c.value.id, '2027-10-11', 500)).toMatchObject({ ok: false, rule: 'R587', code: 'depense_sans_lancement' });
    expect(await t.db.all('SELECT * FROM ad_campaign_spend')).toEqual([]);
    expect(await t.events('publicite.refus')).toEqual([expect.objectContaining({ rule: 'R587', code: 'depense_sans_lancement' })]);
  });

  it('[R588] arrêt automatique au seuil de coût par contact, une fois, pause redemandée jusqu’à confirmation', async () => {
    const t = await setup();
    const c = await t.running();
    const ana = await t.person('Ana');
    const ben = await t.person('Ben');
    // 14 € sans contact : sous le seuil de 15 €.
    expect(await t.pub.recordSpend(t.network.id, c.id, '2027-10-11', 1_400)).toMatchObject({ ok: true, value: { stopped: false } });
    expect(await t.pub.recordContact(t.network.id, c.code, ana)).toMatchObject({ ok: true, value: { counted: true } });
    expect(await t.pub.recordContact(t.network.id, c.code, ana)).toMatchObject({ ok: true, value: { counted: false } });
    expect(await t.pub.recordContact(t.network.id, c.code, ben)).toMatchObject({ ok: true, value: { counted: true } });
    // 30 € pour 2 contacts : 15 € par contact, au seuil, pas au-delà.
    expect(await t.pub.recordSpend(t.network.id, c.id, '2027-10-12', 1_600)).toMatchObject({ ok: true, value: { stopped: false } });
    // Correction de la plateforme : la dernière version du jour fait foi, 30,01 € pour 2 contacts.
    expect(await t.pub.recordSpend(t.network.id, c.id, '2027-10-12', 1_601)).toMatchObject({ ok: true, value: { stopped: true } });
    expect(t.google.paused).toEqual([c.code]);
    const [stop] = await t.db.all<{ reason: string; spend_cents: number; contacts: number; paused_at: string | null; stopped_by: string }>('SELECT reason, spend_cents, contacts, paused_at, stopped_by FROM ad_campaign_stops');
    expect(stop).toMatchObject({ reason: 'seuil', spend_cents: 3_001, contacts: 2, stopped_by: 'system:publicite' });
    expect(stop?.paused_at).not.toBeNull();
    // Rejoué : pas un second arrêt.
    expect(await t.pub.runChecks(t.network.id)).toEqual({ stopped: 0 });
    expect(t.google.paused).toHaveLength(1);
    // Relancer est une décision de la direction : une validation nouvelle, au seuil relevé.
    expect(await t.pub.start(t.dir, c.id)).toMatchObject({ ok: false, rule: 'R587' });
    const v2 = await t.pub.approve(t.dir, c.id, { ...BUDGET, maxCostPerContactCents: 1_400 });
    expect(v2.ok).toBe(true);
    // Toujours au-delà du nouveau seuil avec ce qui est déjà dépensé : rien ne repart.
    expect(await t.pub.start(t.dir, c.id)).toMatchObject({ ok: false, rule: 'R588', code: 'seuil' });
    expect(t.google.started).toHaveLength(1);
  });

  it('[R588] sans aucun contact, l’arrêt vient dès que la dépense passe le seuil ; au budget total aussi', async () => {
    const t = await setup();
    const c = await t.running();
    expect(await t.pub.recordSpend(t.network.id, c.id, '2027-10-11', 1_501)).toMatchObject({ ok: true, value: { stopped: true } });
    const t2 = await setup();
    const c2 = await t2.running({ dailyBudgetCents: 1_000, totalBudgetCents: 2_000, maxCostPerContactCents: 5_000 });
    expect(await t2.pub.recordContact(t2.network.id, c2.code, await t2.person('Cleo'))).toMatchObject({ ok: true });
    expect(await t2.pub.recordSpend(t2.network.id, c2.id, '2027-10-11', 1_000)).toMatchObject({ ok: true, value: { stopped: false } });
    expect(await t2.pub.recordSpend(t2.network.id, c2.id, '2027-10-12', 1_000)).toMatchObject({ ok: true, value: { stopped: true } });
    expect(await t2.db.first('SELECT reason FROM ad_campaign_stops')).toEqual({ reason: 'budget' });
  });

  it('[R588] une pause en panne est redemandée au passage suivant ; le journal ne porte aucune personne', async () => {
    let down = true;
    const paused: string[] = [];
    const flaky: AdPlatform = { mode: 'essai', start: async () => {}, pause: async (code) => { if (down) throw new Error('panne'); paused.push(code); } };
    const t = await setup({ google_ads: flaky, meta: trialAdPlatform() });
    const c = await t.running();
    await t.pub.recordContact(t.network.id, c.code, await t.person('Dora'));
    expect(await t.pub.recordSpend(t.network.id, c.id, '2027-10-11', 9_000)).toMatchObject({ ok: true, value: { stopped: true } });
    expect(await t.db.first('SELECT paused_at FROM ad_campaign_stops')).toEqual({ paused_at: null });
    expect(await t.events('publicite.pause_echec')).toHaveLength(1);
    down = false;
    await t.pub.runChecks(t.network.id);
    expect(paused).toEqual([c.code]);
    expect((await t.db.first<{ paused_at: string | null }>('SELECT paused_at FROM ad_campaign_stops'))?.paused_at).not.toBeNull();
    const all = JSON.stringify(await t.db.all("SELECT type, actor, subject, data FROM journal WHERE type LIKE 'publicite.%'"));
    expect(all).not.toMatch(/Dora|Essai|person:/);
  });

  it('[R588] chaque campagne est jugée sur les mandats et les ventes qu’elle rapporte, lus dans la base', async () => {
    const t = await setup();
    const c = await t.running({ ...BUDGET, maxCostPerContactCents: 10_000 });
    const ana = await t.person('Ana');
    const ben = await t.person('Ben');
    const eve = await t.person('Eve');
    // Un mandat d'Eve signé avant la campagne ne compte pas.
    await t.mandate(eve, '2027-01-05T09:00:00.000Z');
    await t.pub.recordContact(t.network.id, c.code, ana);
    await t.pub.recordContact(t.network.id, c.code, ben);
    await t.pub.recordContact(t.network.id, c.code, eve);
    await t.mandate(ana, '2027-10-20T09:00:00.000Z', true);
    await t.mandate(ben, '2027-10-21T09:00:00.000Z');
    await t.pub.recordSpend(t.network.id, c.id, '2027-10-11', 6_000);
    // Une autre campagne, jamais validée.
    await t.pub.create(t.agent, { platform: 'meta', name: 'Acquéreurs Talant', targeting: { communes: ['21617'] } });
    expect(await t.pub.report(t.agent)).toMatchObject({ ok: false, rule: 'R16' });
    const r = await t.pub.report(t.dir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value[0]).toMatchObject({ state: 'en_cours', spendCents: 6_000, contacts: 3, mandates: 2, sales: 1, costPerContactCents: 2_000, costPerMandateCents: 3_000, costPerSaleCents: 6_000, maxCostPerContactCents: 10_000 });
    expect(r.value[1]).toMatchObject({ state: 'a_valider', spendCents: 0, contacts: 0, mandates: 0, costPerContactCents: null, costPerMandateCents: null });
  });

  it('[R587] la base refuse une validation nouvelle pendant qu’une autre dépense ; arrêtée, elle est contrôlée seule', async () => {
    const t = await setup();
    const c = await t.running();
    // Comme une validation arrivée en même temps qu'un lancement : la base la refuse.
    await expect(
      t.db.run("INSERT INTO ad_campaign_approvals (id, campaign_id, version, daily_budget_cents, total_budget_cents, max_cost_per_contact_cents, approved_by, approved_at) VALUES ('v2', ?, 2, 10, 10, 10, 'direction:dir-1', 'x')", [c.id]),
    ).rejects.toThrow(/en cours/);
    // Une dépense qui monte après l'arrêt est rangée telle que lue, et signalée.
    expect(await t.pub.stop(t.dir, c.id)).toMatchObject({ ok: true });
    expect(await t.pub.recordSpend(t.network.id, c.id, '2027-10-13', 300)).toMatchObject({ ok: true, value: { stopped: false } });
    expect(await t.events('publicite.refus')).toEqual([expect.objectContaining({ rule: 'R587', code: 'depense_hors_validation' })]);
    expect(await t.pub.recordSpend(t.network.id, c.id, '2027-10-13', 300)).toMatchObject({ ok: true });
    expect(await t.events('publicite.refus')).toHaveLength(1);
  });

  it('[R588] deux lectures de dépense du même jour en même temps : aucune n’est perdue, le seuil est tenu', async () => {
    const t = await setup();
    const c = await t.running();
    await Promise.all([t.pub.recordSpend(t.network.id, c.id, '2027-10-11', 1_400), t.pub.recordSpend(t.network.id, c.id, '2027-10-11', 1_600)]);
    expect(await t.db.all('SELECT amount_cents FROM ad_campaign_spend ORDER BY version')).toHaveLength(2);
    // La dernière lecture fait foi ; si c'est 16 €, la campagne est arrêtée, sinon elle l'est à la prochaine lecture.
    await t.pub.recordSpend(t.network.id, c.id, '2027-10-11', 1_600);
    expect(await t.db.first('SELECT reason FROM ad_campaign_stops')).toEqual({ reason: 'seuil' });
  });

  it('[R588] arrêtée pendant que la plateforme lance : la pause est redemandée après le lancement', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const log: string[] = [];
    const slow: AdPlatform = { mode: 'essai', start: async () => { await gate; log.push('start'); }, pause: async () => { log.push('pause'); } };
    const t = await setup({ google_ads: slow, meta: trialAdPlatform() });
    const c = await t.pub.create(t.dir, { platform: 'google_ads', name: 'Vendeurs Dijon', targeting: TARGET });
    if (!c.ok) throw new Error(c.code);
    await t.pub.approve(t.dir, c.value.id, BUDGET);
    const starting = t.pub.start(t.dir, c.value.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(await t.pub.stop(t.dir, c.value.id)).toMatchObject({ ok: true });
    release();
    expect(await starting).toMatchObject({ ok: false, rule: 'R588', code: 'arretee_au_lancement' });
    expect(log).toEqual(['pause', 'start', 'pause']);
  });

  it('[R587] tant que la plateforme n’a pas répondu au lancement, aucune validation ni aucun lancement nouveau', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const slow: AdPlatform = { mode: 'essai', start: async () => { await gate; }, pause: async () => {} };
    const t = await setup({ google_ads: slow, meta: trialAdPlatform() });
    const c = await t.pub.create(t.dir, { platform: 'google_ads', name: 'Vendeurs Dijon', targeting: TARGET });
    if (!c.ok) throw new Error(c.code);
    await t.pub.approve(t.dir, c.value.id, BUDGET);
    const starting = t.pub.start(t.dir, c.value.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(await t.pub.stop(t.dir, c.value.id)).toMatchObject({ ok: true });
    expect(await t.pub.approve(t.dir, c.value.id, BUDGET)).toMatchObject({ ok: false, rule: 'R587', code: 'lancement_en_cours' });
    release();
    await starting;
    expect(await t.pub.approve(t.dir, c.value.id, BUDGET)).toMatchObject({ ok: true, value: { version: 2 } });
  });

  it('[R588] une vente signée avant l’arrivée du contact, même rangée après, ne compte pas', async () => {
    const t = await setup();
    const c = await t.running({ ...BUDGET, maxCostPerContactCents: 10_000 });
    const ana = await t.person('Ana');
    await t.pub.recordContact(t.network.id, c.code, ana);
    await t.db.exec('PRAGMA foreign_keys = OFF');
    await t.db.run("INSERT INTO sale_files (id, network_id, property_id, offer_id, buyer_person_id, amount_eur, opened_at, opened_by) VALUES ('d-x', ?, 'bien-x', 'o-x', ?, 200000, '2027-09-01T08:00:00.000Z', 'agent:test')", [t.network.id, ana]);
    await t.db.run("INSERT INTO sale_file_closings (file_id, network_id, signed_on, proof_ref, aftersale, at, by) VALUES ('d-x', ?, '2027-10-01', 'preuves/test.pdf', 'a_demarrer', '2027-12-01T08:00:00.000Z', 'agent:test')", [t.network.id]);
    await t.db.exec('PRAGMA foreign_keys = ON');
    const r = await t.pub.report(t.dir);
    expect(r.ok && r.value[0]).toMatchObject({ sales: 0 });
  });

  it('[R588] une pause pas encore confirmée bloque toute validation et tout lancement nouveaux', async () => {
    let down = true;
    const paused: string[] = [];
    const flaky: AdPlatform = { mode: 'essai', start: async () => {}, pause: async (code) => { if (down) throw new Error('panne'); paused.push(code); } };
    const t = await setup({ google_ads: flaky, meta: trialAdPlatform() });
    const c = await t.running();
    expect(await t.pub.stop(t.dir, c.id)).toMatchObject({ ok: true });
    expect(await t.pub.approve(t.dir, c.id, BUDGET)).toMatchObject({ ok: false, rule: 'R588', code: 'pause_en_attente' });
    down = false;
    await t.pub.runChecks(t.network.id);
    expect(await t.pub.approve(t.dir, c.id, BUDGET)).toMatchObject({ ok: true, value: { version: 2 } });
    expect(await t.pub.start(t.dir, c.id)).toMatchObject({ ok: true });
    // Le passage suivant ne remet plus en pause la campagne relancée.
    await t.pub.runChecks(t.network.id);
    expect(paused).toEqual([c.code]);
  });

  it('[R588] deux contacts réunis après coup ne comptent qu’une fois, au seuil comme au compte rendu', async () => {
    const t = await setup();
    const c = await t.running();
    const ana = await t.person('Ana');
    const ana2 = await t.person('Ana');
    await t.pub.recordContact(t.network.id, c.code, ana);
    await t.pub.recordContact(t.network.id, c.code, ana2);
    expect(await t.pub.recordSpend(t.network.id, c.id, '2027-10-11', 2_000)).toMatchObject({ ok: true, value: { stopped: false } });
    await t.fiche.merge({ survivorId: ana, mergedId: ana2, reason: 'même personne, test' });
    // 20 € pour un seul contact : au-delà du seuil de 15 €.
    expect(await t.pub.runChecks(t.network.id)).toEqual({ stopped: 1 });
    const r = await t.pub.report(t.dir);
    expect(r.ok && r.value[0]).toMatchObject({ contacts: 1, state: 'arretee', stopReason: 'seuil' });
  });

  it('[R588] fiches réunies : un contact compté une fois, le mandat de la fiche réunie rapporté à la campagne', async () => {
    const t = await setup();
    const c = await t.running({ ...BUDGET, maxCostPerContactCents: 10_000 });
    const ana = await t.person('Ana');
    const ana2 = await t.person('Ana');
    await t.pub.recordContact(t.network.id, c.code, ana);
    await t.fiche.merge({ survivorId: ana, mergedId: ana2, reason: 'même personne, test' });
    expect(await t.pub.recordContact(t.network.id, c.code, ana2)).toMatchObject({ ok: true, value: { counted: false } });
    await t.mandate(ana2, '2027-10-20T09:00:00.000Z');
    const r = await t.pub.report(t.dir);
    expect(r.ok && r.value[0]).toMatchObject({ contacts: 1, mandates: 1 });
  });

  it('[R589] aucun ciblage par un critère interdit pour le logement : communes et rayon seuls', async () => {
    const t = await setup();
    for (const key of ['age', 'sexe', 'Nationalité', 'religion', 'langue', 'situation_famille', 'handicap', 'revenus', 'interets', 'codePostal', 'lookalike']) {
      const r = await t.pub.create(t.dir, { platform: 'meta', name: 'Essai interdit', targeting: { ...TARGET, [key]: 'x' } });
      expect(r).toMatchObject({ ok: false, rule: 'R589', code: 'critere_interdit' });
    }
    expect(await t.pub.create(t.dir, { platform: 'meta', name: 'Essai inconnu', targeting: { ...TARGET, autre: 1 } })).toMatchObject({ ok: false, rule: 'R589', code: 'critere_inconnu' });
    expect(readTargeting({ communes: ['21231'], rayonKm: 5 })).toMatchObject({ ok: false, code: 'rayon' });
    expect(readTargeting({ communes: ['21231', '21231'] })).toMatchObject({ ok: false, code: 'communes' });
    expect(readTargeting({ communes: ['75 Paris'] })).toMatchObject({ ok: false, code: 'communes' });
    expect(readTargeting({ communes: [] })).toMatchObject({ ok: false, code: 'communes' });
    expect(readTargeting(['21231'])).toMatchObject({ ok: false, code: 'ciblage_invalide' });
    expect(readTargeting({ communes: ['2A004', '21231'] })).toEqual({ ok: true, value: { communes: ['21231', '2A004'], radiusKm: null } });
    expect(FORBIDDEN_TARGETING).toContain('age');
    expect(await t.db.all('SELECT * FROM ad_campaigns')).toEqual([]);
    // Le refus nomme le critère de la liste fermée, jamais une valeur.
    const refus = await t.events('publicite.refus');
    expect(refus[0]).toMatchObject({ rule: 'R589', code: 'critere_interdit', criterion: 'age' });
    expect(JSON.stringify(refus)).not.toContain('"x"');
    // La base ne range ni rayon trop petit ni zone vide.
    await expect(t.db.run("INSERT INTO ad_campaigns (id, network_id, platform, name, code, communes, radius_km, created_by, created_at) VALUES ('c', ?, 'meta', 'Nom', 'ABCDEFGHIJKL', '[\"21231\"]', 5, 'direction:d', 'x')", [t.network.id])).rejects.toThrow();
    await expect(t.db.run("INSERT INTO ad_campaigns (id, network_id, platform, name, code, communes, radius_km, created_by, created_at) VALUES ('c', ?, 'meta', 'Nom', 'ABCDEFGHIJKL', '[]', NULL, 'direction:d', 'x')", [t.network.id])).rejects.toThrow();
  });
});

describeWithSqlite('RC30 · un lancement de publicité resté sans réponse ne bloque plus la campagne', () => {
  /** Une plateforme dont le lancement ne répond jamais (Worker arrêté pendant l'appel), puis répond si on la libère. */
  const lostPlatform = () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let down = false;
    const log: string[] = [];
    let first = true;
    const p: AdPlatform = {
      mode: 'essai',
      start: async () => {
        log.push('start');
        if (first) {
          first = false;
          await gate;
        }
      },
      pause: async () => {
        if (down) {
          log.push('pause_echec');
          throw new Error('panne');
        }
        log.push('pause');
      },
    };
    return { p, log, release: () => release(), setDown: (v: boolean) => (down = v) };
  };
  const lostLaunch = async (lost: ReturnType<typeof lostPlatform>, options: { launchTimeoutMs?: number } = {}) => {
    const t = await setup({ google_ads: lost.p, meta: trialAdPlatform() }, options);
    const c = await t.pub.create(t.dir, { platform: 'google_ads', name: 'Vendeurs Dijon', targeting: TARGET });
    if (!c.ok) throw new Error(c.code);
    await t.pub.approve(t.dir, c.value.id, BUDGET);
    const starting = t.pub.start(t.dir, c.value.id);
    await new Promise((r) => setTimeout(r, 20));
    return { t, c: c.value, starting };
  };

  it('[R587] [R588] sans réponse depuis 15 minutes : soldé en échec, arrêté, pause demandée, puis relance possible', async () => {
    const lost = lostPlatform();
    const { t, c } = await lostLaunch(lost);
    expect(await t.pub.approve(t.dir, c.id, BUDGET)).toMatchObject({ ok: false, rule: 'R587' });
    t.advance(LAUNCH_ANSWER_MINUTES * 60_000);
    await t.pub.runChecks(t.network.id);
    expect(lost.log).toEqual(['start', 'pause']);
    const r = await t.pub.report(t.dir);
    expect(r.ok && r.value[0]).toMatchObject({ state: 'arretee', stopReason: 'echec_lancement' });
    expect(await t.db.first('SELECT outcome FROM ad_campaign_launches')).toEqual({ outcome: 'echec' });
    expect(await t.events('publicite.lancement_sans_reponse')).toEqual([{ rule: 'R587', minutes: 15 }]);
    expect(await t.events('publicite.arretee')).toEqual([{ rule: 'R588', reason: 'echec_lancement', spendCents: 0, contacts: 0 }]);
    // Au journal, aucune personne ni aucun code [R13].
    const raw = await t.db.all<{ actor: string; data: string }>("SELECT actor, data FROM journal WHERE type LIKE 'publicite.%'");
    for (const e of raw) expect(e.data).not.toContain(c.code);
    // Rien ne se solde deux fois.
    await t.pub.runChecks(t.network.id);
    expect(lost.log).toEqual(['start', 'pause']);
    // Une validation nouvelle, puis un lancement nouveau, sont possibles [R587].
    expect(await t.pub.approve(t.dir, c.id, BUDGET)).toMatchObject({ ok: true, value: { version: 2 } });
    expect(await t.pub.start(t.dir, c.id)).toMatchObject({ ok: true });
    expect(lost.log).toEqual(['start', 'pause', 'start']);
  });

  it('[R587] moins de 15 minutes sans réponse : rien ne change, le lancement reste en cours', async () => {
    const lost = lostPlatform();
    const { t, c, starting } = await lostLaunch(lost);
    t.advance(LAUNCH_ANSWER_MINUTES * 60_000 - 60_000);
    await t.pub.runChecks(t.network.id);
    expect(lost.log).toEqual(['start']);
    expect(await t.db.first('SELECT count(*) AS n FROM ad_campaign_launches')).toEqual({ n: 0 });
    expect(await t.pub.approve(t.dir, c.id, BUDGET)).toMatchObject({ ok: false, rule: 'R587' });
    lost.release();
    expect(await starting).toMatchObject({ ok: true });
    const r = await t.pub.report(t.dir);
    expect(r.ok && r.value[0]).toMatchObject({ state: 'en_cours' });
  });

  it('[R588] pause refusée par la plateforme : redemandée à chaque passage, rien ne se relance avant sa confirmation', async () => {
    const lost = lostPlatform();
    const { t, c } = await lostLaunch(lost);
    lost.setDown(true);
    t.advance(LAUNCH_ANSWER_MINUTES * 60_000);
    await t.pub.runChecks(t.network.id);
    expect(lost.log).toEqual(['start', 'pause_echec']);
    expect(await t.pub.approve(t.dir, c.id, BUDGET)).toMatchObject({ ok: false, rule: 'R588', code: 'pause_en_attente' });
    await t.pub.runChecks(t.network.id);
    expect(lost.log).toEqual(['start', 'pause_echec', 'pause_echec']);
    lost.setDown(false);
    await t.pub.runChecks(t.network.id);
    expect(lost.log).toEqual(['start', 'pause_echec', 'pause_echec', 'pause']);
    expect(await t.pub.approve(t.dir, c.id, BUDGET)).toMatchObject({ ok: true, value: { version: 2 } });
    expect(await t.pub.start(t.dir, c.id)).toMatchObject({ ok: true });
  });

  it('[R588] arrêtée par la direction pendant le lancement perdu : soldée, la pause est redemandée', async () => {
    const lost = lostPlatform();
    const { t, c } = await lostLaunch(lost);
    expect(await t.pub.stop(t.dir, c.id)).toMatchObject({ ok: true });
    expect(lost.log).toEqual(['start', 'pause']);
    t.advance(LAUNCH_ANSWER_MINUTES * 60_000);
    await t.pub.runChecks(t.network.id);
    // La plateforme a pu lancer après la première pause : elle est redemandée une fois.
    expect(lost.log).toEqual(['start', 'pause', 'pause']);
    const r = await t.pub.report(t.dir);
    expect(r.ok && r.value[0]).toMatchObject({ state: 'arretee', stopReason: 'direction' });
    expect(await t.pub.approve(t.dir, c.id, BUDGET)).toMatchObject({ ok: true, value: { version: 2 } });
  });

  it('[R588] une réponse d’origine arrivée après le solde ne relance rien, la pause est redemandée', async () => {
    const lost = lostPlatform();
    const { t, starting } = await lostLaunch(lost);
    t.advance(LAUNCH_ANSWER_MINUTES * 60_000);
    await t.pub.runChecks(t.network.id);
    lost.release();
    expect(await starting).toMatchObject({ ok: false, rule: 'R588', code: 'reponse_tardive' });
    expect(lost.log).toEqual(['start', 'pause', 'pause']);
    expect(await t.db.first('SELECT outcome FROM ad_campaign_launches')).toEqual({ outcome: 'echec' });
    expect(await t.events('publicite.lancee')).toEqual([]);
    expect(await t.events('publicite.reponse_tardive')).toEqual([{ rule: 'R588', stopped: 0 }]);
    const r = await t.pub.report(t.dir);
    expect(r.ok && r.value[0]).toMatchObject({ state: 'arretee', stopReason: 'echec_lancement' });
  });

  it('[R588] une réponse tardive après une relance : la validation relancée est arrêtée, sa pause tenue jusqu’à confirmation', async () => {
    const lost = lostPlatform();
    const { t, c, starting } = await lostLaunch(lost);
    t.advance(LAUNCH_ANSWER_MINUTES * 60_000);
    await t.pub.runChecks(t.network.id);
    expect(await t.pub.approve(t.dir, c.id, BUDGET)).toMatchObject({ ok: true, value: { version: 2 } });
    expect(await t.pub.start(t.dir, c.id)).toMatchObject({ ok: true });
    // L'ancienne réponse arrive, la pause échoue : elle reste à confirmer, rien ne repart avant.
    lost.setDown(true);
    lost.release();
    expect(await starting).toMatchObject({ ok: false, rule: 'R588', code: 'reponse_tardive' });
    expect(await t.events('publicite.reponse_tardive')).toEqual([{ rule: 'R588', stopped: 1 }]);
    const r = await t.pub.report(t.dir);
    expect(r.ok && r.value[0]).toMatchObject({ state: 'arretee', stopReason: 'echec_lancement' });
    expect(await t.pub.approve(t.dir, c.id, BUDGET)).toMatchObject({ ok: false, rule: 'R588', code: 'pause_en_attente' });
    lost.setDown(false);
    await t.pub.runChecks(t.network.id);
    expect(lost.log.at(-1)).toBe('pause');
    expect(await t.pub.approve(t.dir, c.id, BUDGET)).toMatchObject({ ok: true, value: { version: 3 } });
  });

  it('[R587] une plateforme muette au-delà du délai de lancement : arrêtée, pause demandée, rien ne repart avant le solde', async () => {
    const lost = lostPlatform();
    const { t, c, starting } = await lostLaunch(lost, { launchTimeoutMs: 50 });
    expect(await starting).toMatchObject({ ok: false, rule: 'R587', code: 'echec_lancement' });
    expect(lost.log).toEqual(['start', 'pause']);
    // La réponse reste à venir : ni validation ni lancement nouveaux avant elle ou avant le solde.
    expect(await t.db.first('SELECT count(*) AS n FROM ad_campaign_launches')).toEqual({ n: 0 });
    expect(await t.pub.approve(t.dir, c.id, BUDGET)).toMatchObject({ ok: false, rule: 'R587', code: 'lancement_en_cours' });
    const r = await t.pub.report(t.dir);
    expect(r.ok && r.value[0]).toMatchObject({ state: 'arretee', stopReason: 'echec_lancement' });
    t.advance(LAUNCH_ANSWER_MINUTES * 60_000);
    await t.pub.runChecks(t.network.id);
    // Au solde, la pause est redemandée : la plateforme a pu lancer après la première.
    expect(lost.log).toEqual(['start', 'pause', 'pause']);
    expect(await t.db.first('SELECT outcome FROM ad_campaign_launches')).toEqual({ outcome: 'echec' });
    expect(await t.pub.approve(t.dir, c.id, BUDGET)).toMatchObject({ ok: true, value: { version: 2 } });
    // Le délai reste sous celui du solde.
    expect(() => new PublicitePayante(t.db, t.journal, { google_ads: trialAdPlatform(), meta: trialAdPlatform() }, { launchTimeoutMs: LAUNCH_ANSWER_MINUTES * 60_000 })).toThrow();
  });

  it('[R588] un lancement réussi après le délai : la réponse est rangée, la pause redemandée jusqu’à confirmation', async () => {
    const lost = lostPlatform();
    const { t, c, starting } = await lostLaunch(lost, { launchTimeoutMs: 50 });
    expect(await starting).toMatchObject({ ok: false, rule: 'R587', code: 'echec_lancement' });
    lost.setDown(true);
    lost.release();
    await new Promise((r) => setTimeout(r, 50));
    expect(lost.log).toEqual(['start', 'pause', 'pause_echec']);
    expect(await t.db.first('SELECT outcome FROM ad_campaign_launches')).toEqual({ outcome: 'lancee' });
    expect(await t.pub.approve(t.dir, c.id, BUDGET)).toMatchObject({ ok: false, rule: 'R588', code: 'pause_en_attente' });
    lost.setDown(false);
    await t.pub.runChecks(t.network.id);
    expect(lost.log).toEqual(['start', 'pause', 'pause_echec', 'pause']);
    expect(await t.pub.approve(t.dir, c.id, BUDGET)).toMatchObject({ ok: true, value: { version: 2 } });
  });

  it('[R588] une coupure au moment de la réponse tardive : la pause est redemandée au solde', async () => {
    const lost = lostPlatform();
    const { t, c, starting } = await lostLaunch(lost, { launchTimeoutMs: 50 });
    expect(await starting).toMatchObject({ ok: false, rule: 'R587', code: 'echec_lancement' });
    const run = t.db.run.bind(t.db);
    let cut = true;
    t.db.run = (async (sql: string, params?: unknown[]) => {
      if (cut && sql.startsWith('INSERT INTO ad_campaign_repauses')) {
        cut = false;
        throw new Error('coupure');
      }
      return run(sql, params as never);
    }) as typeof t.db.run;
    lost.release();
    await new Promise((r) => setTimeout(r, 50));
    expect(lost.log).toEqual(['start', 'pause']);
    expect(await t.pub.approve(t.dir, c.id, BUDGET)).toMatchObject({ ok: false, rule: 'R587', code: 'lancement_en_cours' });
    t.advance(LAUNCH_ANSWER_MINUTES * 60_000);
    await t.pub.runChecks(t.network.id);
    expect(lost.log).toEqual(['start', 'pause', 'pause']);
    expect(await t.pub.approve(t.dir, c.id, BUDGET)).toMatchObject({ ok: true, value: { version: 2 } });
  });

  it('[R588] un solde coupé avant de ranger l’échec reprend au passage suivant, la pause reste demandée', async () => {
    const lost = lostPlatform();
    const { t, c } = await lostLaunch(lost);
    // Coupure : la réponse « échec » ne s'écrit pas au premier essai, et la plateforme ne confirme pas la pause.
    const run = t.db.run.bind(t.db);
    let cut = true;
    t.db.run = (async (sql: string, params?: unknown[]) => {
      if (cut && sql.startsWith('INSERT INTO ad_campaign_launches')) {
        cut = false;
        throw new Error('coupure');
      }
      return run(sql, params as never);
    }) as typeof t.db.run;
    lost.setDown(true);
    t.advance(LAUNCH_ANSWER_MINUTES * 60_000);
    await expect(t.pub.runChecks(t.network.id)).rejects.toThrow('coupure');
    // L'arrêt est rangé, la campagne ne dépense plus sans pause demandée, rien ne se relance.
    expect(await t.db.first('SELECT reason, paused_at FROM ad_campaign_stops')).toEqual({ reason: 'echec_lancement', paused_at: null });
    expect(await t.pub.approve(t.dir, c.id, BUDGET)).toMatchObject({ ok: false });
    lost.setDown(false);
    await t.pub.runChecks(t.network.id);
    expect(await t.db.first('SELECT outcome FROM ad_campaign_launches')).toEqual({ outcome: 'echec' });
    expect(await t.db.first('SELECT count(*) AS n FROM ad_campaign_stops WHERE paused_at IS NULL')).toEqual({ n: 0 });
    expect(await t.db.first('SELECT count(*) AS n FROM ad_campaign_repauses WHERE paused_at IS NULL')).toEqual({ n: 0 });
    expect(await t.events('publicite.lancement_sans_reponse')).toHaveLength(1);
    expect(lost.log.filter((x) => x === 'pause').length).toBeGreaterThan(0);
    expect(await t.pub.approve(t.dir, c.id, BUDGET)).toMatchObject({ ok: true, value: { version: 2 } });
    expect(await t.pub.start(t.dir, c.id)).toMatchObject({ ok: true });
  });

  it('[R588] une dépense lue passe aussi le contrôle : le lancement perdu y est soldé', async () => {
    const lost = lostPlatform();
    const { t, c } = await lostLaunch(lost);
    t.advance(LAUNCH_ANSWER_MINUTES * 60_000);
    expect(await t.pub.recordSpend(t.network.id, c.id, '2027-10-11', 0)).toMatchObject({ ok: true });
    expect(lost.log).toEqual(['start', 'pause']);
    const r = await t.pub.report(t.dir);
    expect(r.ok && r.value[0]).toMatchObject({ state: 'arretee', stopReason: 'echec_lancement' });
  });
});
