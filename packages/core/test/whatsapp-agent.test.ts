import { expect, it } from 'vitest';
import {
  ALERT_PURPOSE,
  Acces,
  Alertes,
  AlerteWhatsApp,
  FicheAcquereur,
  FicheClient,
  FicheUnique,
  SqlJournalStore,
  applyMigrations,
  decideSend,
  fromSyncSqlite,
  verifyChain,
  DEFAULT_SEND_SETTINGS,
  type BuyerSearch,
  type DiffusionGate,
  type SqlDatabase,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const TUESDAY_10H = Date.parse('2026-12-08T09:00:00.000Z');
const SUNDAY_23H = Date.parse('2026-12-06T22:00:00.000Z');
const DAY = 86_400_000;
const BASE = 'https://aimmo.example.test/alertes/desinscription/';
const TALANT: Partial<BuyerSearch> = { propertyKinds: ['house'], communes: ['Talant'], budgetMaxEur: 300_000 };

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = TUESDAY_10H;
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const acquereurs = new FicheAcquereur(db, journal, { now });
  const blocked = new Set<string>();
  const diffusion: DiffusionGate = { canDiffuse: async (_n, id) => (blocked.has(id) ? { allowed: false, reason: 'withdrawn' } : { allowed: true, reason: 'allowed' }) };
  const whatsapp = new AlerteWhatsApp(db, journal, acces, { diffusion, unsubscribeBase: BASE, now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const direction = { role: 'direction' as const, userId: 'd1', networkId: network.id };
  const buyer = async (firstName: string, search: Partial<BuyerSearch> = TALANT, consent = true) => {
    const person = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName });
    await store.addIdentifier({ networkId: network.id, personId: person.id, kind: 'phone', value: '+33 6 00 00 00 01' });
    await store.addIdentifier({ networkId: network.id, personId: person.id, kind: 'email', value: 'ines@example.test' });
    if (consent) await store.addConsent({ networkId: network.id, personId: person.id, purpose: ALERT_PURPOSE, channel: 'whatsapp', proof: 'test', givenAt: new Date(TUESDAY_10H - 10 * DAY) });
    const project = await store.createProject({ networkId: network.id, agentId: alex.id, personId: person.id, kind: 'buy' });
    const r = await acquereurs.update(acces, direction, project.id, search);
    if (!r.ok) throw new Error(r.code);
    return { person, project };
  };
  const property = (ref = 'B1') =>
    store.createProperty({ networkId: network.id, agentId: alex.id, reference: ref, kind: 'home', dwelling: 'house', city: 'Talant', priceEur: 280_000, surfaceM2: 95, rooms: 4, status: 'available' });
  const as = (role: 'agent' | 'direction' | 'compliance', userId: string) => ({ role, userId, networkId: network.id });
  const messages = (personId: string) => db.all<{ id: string; author_kind: string; channel: string; body: string }>("SELECT id, author_kind, channel, body FROM messages WHERE person_id = ? AND direction = 'out'", [personId]);
  return { db, store, journal, whatsapp, network, alex, sam, buyer, property, as, blocked, messages, diffusion, setClock: (t: number) => (clock = t) };
}

describeWithSqlite('T09 · alerte WhatsApp en un geste, par le téléphone de l’agent', () => {
  it('le lien est préparé après le contrôle central, pré-rempli, avec la désinscription ; le message est écrit par l’agent, sans mention d’assistant', async () => {
    const t = await setup();
    const b = await t.buyer('Inès');
    const p = await t.property();
    const r = await t.whatsapp.prepare(t.as('agent', t.alex.id), p.id, b.project.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.link).toMatch(/^https:\/\/wa\.me\/33600000001\?text=/);
    const text = decodeURIComponent(r.link.split('?text=')[1]!);
    expect(text).toContain('Bonjour Inès, un bien correspond à votre recherche');
    expect(text).toContain('Dites-moi si vous souhaitez le visiter.');
    expect(text).toMatch(/Ne plus recevoir ces alertes : https:\/\/aimmo\.example\.test\/alertes\/desinscription\/[a-z]{32}$/);
    expect(text).not.toMatch(/assistant/i);
    const msgs = await t.messages(b.person.id);
    expect(msgs).toEqual([expect.objectContaining({ id: r.messageId, author_kind: 'agent', channel: 'whatsapp' })]);
    // Rien ne part du serveur : la boîte d'essai reste vide, et ni le lien ni le numéro ne vont au journal [R13].
    expect(await t.db.all('SELECT * FROM trial_outbox')).toEqual([]);
    const entries = await t.journal.all();
    expect(JSON.stringify(entries)).not.toMatch(/wa\.me|33600000001|Inès/);
    expect((await verifyChain(entries)).ok).toBe(true);
  });

  it('aucun lien sans accord en cours pour les alertes sur WhatsApp [R49] ; sans lien de désinscription réglé, rien', async () => {
    const t = await setup();
    const b = await t.buyer('Inès', TALANT, false);
    await t.store.addConsent({ networkId: t.network.id, personId: b.person.id, purpose: ALERT_PURPOSE, channel: 'email', proof: 'test', givenAt: new Date(TUESDAY_10H - DAY) });
    const p = await t.property();
    expect(await t.whatsapp.prepare(t.as('agent', t.alex.id), p.id, b.project.id)).toMatchObject({ ok: false, rule: 'R03' });
    const c = await t.buyer('Léo');
    const sans = new AlerteWhatsApp(t.db, t.journal, new Acces(t.db, t.store, new FicheUnique(t.db, t.store), t.journal), { diffusion: t.diffusion });
    expect(await sans.prepare(t.as('agent', t.alex.id), p.id, c.project.id)).toMatchObject({ ok: false, rule: 'R49', code: 'no_unsubscribe_link' });
    expect(await t.messages(b.person.id)).toEqual([]);
  });

  it('jamais un bien déjà proposé, ni deux liens du même bien, même demandés en même temps [R05]', async () => {
    const t = await setup();
    const b = await t.buyer('Inès');
    const p = await t.property();
    const [x, y] = await Promise.all([
      t.whatsapp.prepare(t.as('agent', t.alex.id), p.id, b.project.id),
      t.whatsapp.prepare(t.as('agent', t.alex.id), p.id, b.project.id),
    ]);
    expect([x.ok, y.ok].sort()).toEqual([false, true]);
    expect(await t.whatsapp.prepare(t.as('agent', t.alex.id), p.id, b.project.id)).toMatchObject({ ok: false, rule: 'R05' });
    // Une alerte automatique du même bien ne part plus ensuite, par aucun canal.
    await t.store.addConsent({ networkId: t.network.id, personId: b.person.id, purpose: ALERT_PURPOSE, channel: 'email', proof: 'test', givenAt: new Date(TUESDAY_10H - DAY) });
    const alertes = new Alertes(t.db, t.journal, { diffusion: t.diffusion, unsubscribeBase: BASE, now: () => new Date(TUESDAY_10H) });
    expect(await alertes.forProperty(t.network.id, p.id)).toMatchObject([{ status: 'refused', rule: 'R05' }]);
    expect(await t.messages(b.person.id)).toHaveLength(1);
  });

  it('arrêt, exclusions et horaires [R01, R02, R04] ; la fenêtre de Meta ne vaut pas pour l’agent', async () => {
    const t = await setup();
    const stop = await t.buyer('Arrêt');
    await t.store.addExclusion({ networkId: t.network.id, personId: stop.person.id, reason: 'stop', notedAt: new Date(TUESDAY_10H - DAY) });
    const ex = await t.buyer('Exclu');
    await t.store.addExclusion({ networkId: t.network.id, personId: ex.person.id, reason: 'network_list', notedAt: new Date(TUESDAY_10H - DAY) });
    const b = await t.buyer('Inès');
    const p = await t.property();
    expect(await t.whatsapp.prepare(t.as('agent', t.alex.id), p.id, stop.project.id)).toMatchObject({ ok: false, rule: 'R04' });
    expect(await t.whatsapp.prepare(t.as('agent', t.alex.id), p.id, ex.project.id)).toMatchObject({ ok: false, rule: 'R02' });
    t.setClock(SUNDAY_23H);
    expect(await t.whatsapp.prepare(t.as('agent', t.alex.id), p.id, b.project.id)).toMatchObject({ ok: false, rule: 'R01' });
    t.setClock(TUESDAY_10H);
    // Aucun message reçu de la personne sur WhatsApp : la fenêtre de Meta est fermée, l'agent peut écrire quand même.
    expect(await t.whatsapp.prepare(t.as('agent', t.alex.id), p.id, b.project.id)).toMatchObject({ ok: true });
    // Pour un envoi automatique, la fenêtre reste exigée [R22].
    const auto = decideSend(
      { channel: 'whatsapp', kind: 'alert', purpose: ALERT_PURPOSE, at: new Date(TUESDAY_10H) },
      { exclusions: [], consents: [{ purpose: ALERT_PURPOSE, channel: 'whatsapp', given_at: new Date(TUESDAY_10H - DAY).toISOString(), withdrawn_at: null }], messages: [], relations: [], sentToday: { review_request: 0, partner: 0 } },
      DEFAULT_SEND_SETTINGS,
    );
    expect(auto).toMatchObject({ allowed: false, rule: 'R22' });
  });

  it('seuls l’agent du client et la direction [R16] ; un bien non diffusable ou qui ne correspond pas : rien [R42, R51]', async () => {
    const t = await setup();
    const b = await t.buyer('Inès');
    const p = await t.property();
    expect(await t.whatsapp.prepare(t.as('agent', t.sam.id), p.id, b.project.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.whatsapp.prepare(t.as('compliance', 'c1'), p.id, b.project.id)).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    t.blocked.add(p.id);
    expect(await t.whatsapp.prepare(t.as('agent', t.alex.id), p.id, b.project.id)).toMatchObject({ ok: false, rule: 'R42' });
    t.blocked.delete(p.id);
    const far = await t.buyer('Loin', { communes: ['Dijon'] });
    expect(await t.whatsapp.prepare(t.as('agent', t.alex.id), p.id, far.project.id)).toMatchObject({ ok: false, rule: 'R51', code: 'not_matching' });
    // La direction prépare au nom de l'agent qui suit la personne.
    const r = await t.whatsapp.prepare(t.as('direction', 'd1'), p.id, b.project.id);
    expect(r.ok).toBe(true);
    const row = await t.db.first<{ agent_id: string }>('SELECT agent_id FROM agent_whatsapp_alerts');
    expect(row!.agent_id).toBe(t.alex.id);
  });

  it('chaque refus avant le contrôle central va au journal, sans donnée ; un projet clos ou une recherche trop ancienne : rien', async () => {
    const t = await setup();
    const b = await t.buyer('Inès');
    const p = await t.property();
    t.blocked.add(p.id);
    await t.whatsapp.prepare(t.as('agent', t.alex.id), p.id, b.project.id);
    t.blocked.delete(p.id);
    await t.db.run("UPDATE projects SET stage = 'bought' WHERE id = ?", [b.project.id]);
    expect(await t.whatsapp.prepare(t.as('agent', t.alex.id), p.id, b.project.id)).toMatchObject({ ok: false, rule: 'R51', code: 'inactive' });
    const old = await t.buyer('Ancienne');
    t.setClock(TUESDAY_10H + 181 * DAY);
    expect(await t.whatsapp.prepare(t.as('agent', t.alex.id), p.id, old.project.id)).toMatchObject({ ok: false, rule: 'R51', code: 'inactive' });
    // AU074 · la même recherche, dite toujours d'actualité il y a dix jours, compte de nouveau.
    await t.db.run('INSERT INTO buyer_search_confirmations (project_id, network_id, confirmed_at, confirmed_by) VALUES (?, ?, ?, ?)', [
      old.project.id, t.as('agent', t.alex.id).networkId, new Date(TUESDAY_10H + 171 * DAY).toISOString(), `agent:${t.alex.id}`,
    ]);
    expect((await t.whatsapp.prepare(t.as('agent', t.alex.id), p.id, old.project.id)).ok).toBe(true);
    const refused = (await t.journal.all()).filter((e) => e.type === 'alerte.whatsapp.refusee');
    expect(refused.map((e) => e.data.rule)).toEqual(['R42', 'R51', 'R51']);
    expect(JSON.stringify(refused)).not.toMatch(/Inès|Ancienne|33600000001/);
    expect(await t.messages(b.person.id)).toEqual([]);
  });

  it('la confirmation de l’agent s’enregistre une seule fois, même demandée deux fois [R18] ; un autre agent ne confirme pas [R16]', async () => {
    const t = await setup();
    const b = await t.buyer('Inès');
    const p = await t.property();
    const r = await t.whatsapp.prepare(t.as('agent', t.alex.id), p.id, b.project.id);
    if (!r.ok) throw new Error('refus');
    expect(await t.whatsapp.confirm(t.as('agent', t.sam.id), r.messageId)).toMatchObject({ ok: false, rule: 'R16' });
    const first = await t.whatsapp.confirm(t.as('agent', t.alex.id), r.messageId);
    const second = await t.whatsapp.confirm(t.as('agent', t.alex.id), r.messageId);
    expect(first).toMatchObject({ ok: true });
    expect(second).toEqual(first);
    const confirmed = (await t.journal.all()).filter((e) => e.type === 'alerte.whatsapp.confirmee');
    expect(confirmed).toHaveLength(1);
    expect(await t.whatsapp.confirm(t.as('agent', t.alex.id), 'inconnu')).toMatchObject({ ok: false, code: 'unknown' });
  });
});
