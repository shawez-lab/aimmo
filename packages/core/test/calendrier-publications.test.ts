import { expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, SqlJournalStore, annonces, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { CalendrierPublications, parisInstant, type PublicationGate } from '../src/marketing/index.ts';
import { Publications, trialSocialChannel, type CertifiedPhoto, type SocialPayload } from '../src/studio/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

type Facts = Parameters<typeof annonces.fallbackListing>[0];
const FACTS: Facts = {
  kind: 'home',
  city: 'Villebrune',
  postalCode: null,
  surfaceM2: 72,
  rooms: 3,
  bedrooms: 2,
  floor: null,
  floorsTotal: null,
  buildYear: null,
  heating: null,
  outdoor: ['balcon'],
  landM2: null,
  parkingSpaces: null,
  elevator: null,
  energyClass: 'C',
  climateClass: 'C',
};
// Mentions inventées, telles que M07 les calcule.
const MENTIONS = 'Prix : 230 000 € honoraires inclus, dont 4,55 % TTC à la charge de l’acquéreur.\nClasse énergie C, classe climat C.\nCarte professionnelle n° CPI 0000 0000 000 000 000.';
const photo = (p: string) => `biens/${p}/00000001-0000-4000-8000-000000000000.jpg`;

/** Dimanche 10 octobre 2027, 8 h à Paris : le calendrier réglé vaut à partir du lundi 11. */
const START = '2027-10-10T06:00:00.000Z';

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = Date.parse(START);
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const acces = new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alexandrine', lastName: 'Fictive' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Samuel', lastName: 'Inventé' });
  const state = { closed: new Set<string>(), offline: new Set<string>(), linksDown: false, onPublish: null as (() => void) | null };
  const links = {
    studioLink: async (_n: string, _k: 'publication', ref: string, propertyId: string) => {
      if (state.linksDown) throw new Error('panne');
      return { contentId: `c-${ref}`, link: state.offline.has(propertyId) ? null : `https://exemple.test/biens/${propertyId}?o=c-${ref}` };
    },
    linkPost: async () => ({ ok: true }),
  };
  const received: (SocialPayload & { channel: string })[] = [];
  const channels = (['instagram', 'facebook', 'linkedin'] as const).map((c) => ({
    ...trialSocialChannel(c),
    post: async (payload: SocialPayload) => {
      received.push({ ...payload, channel: c });
    },
  }));
  const diffusion = { canDiffuse: async (_n: string, propertyId: string) => ({ allowed: !state.closed.has(propertyId) }) };
  const pubs = new Publications(
    db,
    acces,
    journal,
    {
      facts: { factsFor: async () => ({ facts: structuredClone(FACTS) }) },
      certs: { publishable: async (id: string): Promise<CertifiedPhoto[]> => [{ ref: photo(id), overlay: null, retouchMention: null, retouches: [], certificateToken: 'a'.repeat(32), certificatePath: `/certificat-photo/${'a'.repeat(32)}` }] },
      diffusion,
      mentions: { checklist: async () => ({ complete: true, text: MENTIONS, publishedPriceEur: 230_000 }) },
      consents: { has: async () => true },
      channels,
      origin: links,
    },
    { now, writer: null },
  );
  const calls: { postId: string; targets: unknown }[] = [];
  const gate: PublicationGate = {
    publish: async (viewer, postId, targets, options) => {
      calls.push({ postId, targets });
      state.onPublish?.();
      return pubs.publish(viewer, postId, targets, options);
    },
  };
  const cal = new CalendrierPublications(db, journal, { gate, diffusion, links }, { now });
  const as = (userId: string) => ({ role: 'agent', userId, networkId: network.id }) as never;
  const alexV = as(alex.id);
  let n = 0;
  /** Un bien d'Alexandrine et ses publications prêtes (préparées, visuel contrôlé, validées). */
  const property = async (posts = 1, agentId = alex.id) => {
    const p = await store.createProperty({ networkId: network.id, agentId, reference: `CAL-${++n}`, kind: 'home', city: 'Villebrune', priceEur: 230_000, surfaceM2: 72, rooms: 3, status: 'available' });
    const v = as(agentId);
    for (let i = 0; i < posts; i++) {
      const prep = await pubs.prepare(v, p.id, { event: 'nouveau_bien', visuals: [photo(p.id)] });
      if (!prep.ok) throw new Error(prep.code);
      await pubs.checkVisual(v, prep.value.id, { ref: photo(p.id), addressVisible: false, personVisible: false });
      const ok = await pubs.validate(v, prep.value.id);
      if (!ok.ok) throw new Error(ok.code);
    }
    return p.id;
  };
  const setClock = (iso: string) => (clock = Date.parse(iso));
  return { db, journal, pubs, cal, network, alex, sam, alexV, as, property, state, received, calls, setClock };
}

describeWithSqlite('HX52 · calendrier de publication', () => {
  it('[R581] les réglages : 0 à 3 par réseau, pas plus que d’heures, valables à partir du lendemain', async () => {
    const t = await setup();
    expect(await t.cal.setRules(t.alexV, { perDay: { instagram: 2 }, hours: ['18:00', '09:00'] })).toEqual({ ok: false, rule: 'R581', code: 'heures_invalides' });
    expect(await t.cal.setRules(t.alexV, { perDay: { instagram: 2 }, hours: ['09:00'] })).toEqual({ ok: false, rule: 'R581', code: 'nombres_invalides' });
    expect(await t.cal.setRules(t.alexV, { perDay: { myspace: 1 }, hours: ['09:00'] })).toEqual({ ok: false, rule: 'R581', code: 'reseau_inconnu' });
    expect(await t.cal.setRules(t.alexV, { perDay: { instagram: 1.5 }, hours: ['09:00', '12:00'] })).toEqual({ ok: false, rule: 'R581', code: 'nombres_invalides' });
    expect(await t.cal.setRules(t.alexV, { perDay: { instagram: 4 }, hours: ['08:00', '09:00', '10:00', '11:00'] })).toEqual({ ok: false, rule: 'R581', code: 'heures_invalides' });
    expect(await t.cal.setRules({ role: 'direction', userId: t.alex.id, networkId: t.network.id } as never, { perDay: { instagram: 1 }, hours: ['09:00'] })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    const r = await t.cal.setRules(t.alexV, { perDay: { instagram: 2, facebook: 1 }, hours: ['09:00', '18:00'] });
    expect(r).toEqual({ ok: true, value: { version: 1, perDay: { instagram: 2, facebook: 1, linkedin: 0, google: 0, tiktok: 0, youtube: 0 }, hours: ['09:00', '18:00'], effectiveDay: '2027-10-11' } });
    // Rien ne vaut le jour même : aujourd'hui n'a pas de calendrier.
    expect(await t.cal.rules(t.alexV)).toMatchObject({ ok: true, value: { today: null, next: { version: 1 } } });
    await t.property(2);
    expect(await t.cal.planWeek(t.alexV, '2027-10-10')).toMatchObject({ ok: true });
    expect((await t.cal.slots(t.alexV, '2027-10-10', '2027-10-10')).ok && (await t.cal.slots(t.alexV, '2027-10-10', '2027-10-10'))).toEqual({ ok: true, value: [] });
    // La base refuse aussi un nombre au-delà des heures, et ne laisse rien changer ni s'effacer.
    await expect(t.db.run("INSERT INTO social_calendar_rules (id, network_id, agent_id, version, instagram, facebook, linkedin, google, tiktok, youtube, hours, effective_day, created_at) VALUES ('x', ?, ?, 9, 2, 0, 0, 0, 0, 0, '[\"09:00\"]', '2027-10-11', 'x')", [t.network.id, t.alex.id])).rejects.toThrow();
    await expect(t.db.run('UPDATE social_calendar_rules SET instagram = 3')).rejects.toThrow(/ne change plus/);
    await expect(t.db.run('DELETE FROM social_calendar_rules')).rejects.toThrow(/efface/);
  });

  it('[R581] le nombre réglé par réseau et par jour est tenu, rejoué, en même temps, et par la base', async () => {
    const t = await setup();
    for (let i = 0; i < 7; i++) await t.property(2);
    await t.cal.setRules(t.alexV, { perDay: { instagram: 2, facebook: 1 }, hours: ['09:00', '18:00'] });
    const a = await t.cal.planWeek(t.alexV, '2027-10-11');
    await Promise.all([t.cal.planWeek(t.alexV, '2027-10-11'), t.cal.planWeek(t.alexV, '2027-10-11')]);
    const b = await t.cal.slots(t.alexV, '2027-10-11', '2027-10-17');
    if (!a.ok || !b.ok) throw new Error('planification');
    expect(b.value).toEqual(a.value);
    for (let d = 11; d <= 17; d++) {
      const day = `2027-10-${d}`;
      expect(b.value.filter((s) => s.day === day && s.channel === 'instagram')).toHaveLength(2);
      expect(b.value.filter((s) => s.day === day && s.channel === 'facebook')).toHaveLength(1);
      expect(b.value.filter((s) => s.day === day && s.channel === 'linkedin')).toHaveLength(0);
    }
    // Les heures de Paris, heure d'été comprise.
    const first = b.value.find((s) => s.day === '2027-10-11' && s.channel === 'instagram' && s.rank === 1)!;
    expect(first.dueAt).toBe('2027-10-11T16:00:00.000Z');
    // Un rang de trop, glissé à la main, est refusé par la base.
    const rules = (await t.db.first<{ id: string }>('SELECT id FROM social_calendar_rules'))!.id;
    const post = (await t.db.first<{ id: string; property_id: string }>('SELECT id, property_id FROM social_posts'))!;
    await expect(
      t.db.run("INSERT INTO social_calendar_slots (id, network_id, agent_id, rules_id, day, channel, rank, post_id, property_id, due_at, booked_at) VALUES ('y', ?, ?, ?, '2027-10-11', 'facebook', 1, ?, ?, 'x', 'x')", [t.network.id, t.alex.id, rules, post.id, post.property_id]),
    ).rejects.toThrow(/nombre réglé/);
    await expect(
      t.db.run("INSERT INTO social_calendar_slots (id, network_id, agent_id, rules_id, day, channel, rank, post_id, property_id, due_at, booked_at) VALUES ('y', ?, ?, ?, '2027-10-10', 'instagram', 0, ?, ?, 'x', 'x')", [t.network.id, t.alex.id, rules, post.id, post.property_id]),
    ).rejects.toThrow(/nombre réglé/);
    await expect(t.db.run('DELETE FROM social_calendar_slots')).rejects.toThrow(/efface/);
    await expect(t.db.run("UPDATE social_calendar_slots SET channel = 'linkedin'")).rejects.toThrow(/ne change plus/);
  });

  it('[R580] aucun bien repris tant qu’un bien prêt n’est jamais sorti ; le plus récent des jamais sortis d’abord', async () => {
    const t = await setup();
    const a = await t.property(3);
    const b = await t.property(3);
    const c = await t.property(3);
    await t.cal.setRules(t.alexV, { perDay: { instagram: 1 }, hours: ['09:00'] });
    const w = await t.cal.planWeek(t.alexV, '2027-10-11');
    if (!w.ok) throw new Error(w.code);
    // Un bien nouveau chaque jour, du plus récent au plus ancien, puis la rotation reprend dans le même ordre.
    expect(w.value.map((s) => s.propertyId)).toEqual([c, b, a, c, b, a, c]);
    // Jamais la même publication deux fois sur un réseau.
    expect(new Set(w.value.map((s) => s.postId)).size).toBe(7);
    // Un bien qui devient prêt passe avant toute reprise : il n'est jamais sorti.
    const d = await t.property(2);
    const next = await t.cal.planWeek(t.alexV, '2027-10-18');
    if (!next.ok) throw new Error(next.code);
    expect(next.value[0]!.propertyId).toBe(d);
    // La règle, vérifiée sur tout le calendrier : un bien n'est repris que si chaque autre bien prêt est sorti autant.
    const all = [...w.value, ...next.value];
    for (let i = 0; i < all.length; i++) {
      const before = all.slice(0, i);
      const count = (p: string) => before.filter((s) => s.propertyId === p).length;
      const ready = before.length >= 7 ? [a, b, c, d] : [a, b, c];
      expect(count(all[i]!.propertyId)).toBe(Math.min(...ready.map(count)));
    }
  });

  it('[R580] une publication partie à la main compte comme une sortie ; un bien d’un autre agent ou non diffusable n’entre pas', async () => {
    const t = await setup();
    const a = await t.property(2);
    const b = await t.property(2);
    const other = await t.property(2, t.sam.id);
    const closed = await t.property(2);
    t.state.closed.add(closed);
    const offline = await t.property(2);
    t.state.offline.add(offline);
    // B est déjà sorti à la main sur Instagram.
    const bPost = (await t.db.first<{ id: string }>('SELECT id FROM social_posts WHERE property_id = ? ORDER BY id LIMIT 1', [b]))!.id;
    expect(await t.pubs.publish(t.alexV, bPost, [{ channel: 'instagram', account: 'agent' }])).toMatchObject({ ok: true });
    await t.cal.setRules(t.alexV, { perDay: { instagram: 1 }, hours: ['09:00'] });
    const w = await t.cal.planWeek(t.alexV, '2027-10-11');
    if (!w.ok) throw new Error(w.code);
    expect(w.value.map((s) => s.propertyId).slice(0, 3)).toEqual([a, b, a]);
    expect(w.value.some((s) => [other, closed, offline].includes(s.propertyId))).toBe(false);
    // La publication déjà partie n'est jamais reprise.
    expect(w.value.some((s) => s.postId === bPost)).toBe(false);
  });

  it('[R582] chaque créneau passe une fois, par le seul chemin de publication, en essai, avec son lien marqué', async () => {
    const t = await setup();
    const a = await t.property(1);
    await t.cal.setRules(t.alexV, { perDay: { instagram: 1, facebook: 1 }, hours: ['09:00'] });
    const w = await t.cal.planWeek(t.alexV, '2027-10-11');
    if (!w.ok) throw new Error(w.code);
    expect(w.value).toHaveLength(2);
    // Avant l'heure, rien ne passe.
    t.setClock('2027-10-11T06:59:00.000Z');
    expect(await t.cal.runDue(t.network.id)).toEqual({ passed: 0 });
    t.setClock('2027-10-11T07:01:00.000Z');
    const runs = await Promise.all([t.cal.runDue(t.network.id), t.cal.runDue(t.network.id)]);
    expect(runs[0]!.passed + runs[1]!.passed).toBe(2);
    expect(await t.cal.runDue(t.network.id)).toEqual({ passed: 0 });
    // Le calendrier ne parle à aucun réseau : il a demandé la publication à X05, qui l'a remise au canal d'essai.
    expect(t.calls.map((c) => c.targets)).toEqual(expect.arrayContaining([[{ channel: 'instagram', account: 'agent' }], [{ channel: 'facebook', account: 'agent' }]]));
    expect(t.calls).toHaveLength(2);
    expect(t.received.map((r) => r.channel).sort()).toEqual(['facebook', 'instagram']);
    for (const r of t.received) expect(r.link).toBe(`https://exemple.test/biens/${a}?o=c-${r.postId}`);
    const s = await t.cal.slots(t.alexV, '2027-10-11', '2027-10-11');
    expect(s.ok && s.value.map((x) => x.outcome)).toEqual(['envoye', 'envoye']);
    // Au journal : issues et règles, jamais le texte ni le lien.
    const ev = await t.db.all<{ data: string }>("SELECT data FROM journal WHERE type LIKE 'marketing.calendrier.%'");
    for (const e of ev) expect(e.data).not.toMatch(/Nouveau bien|https?:|€/);
    await expect(t.db.run('DELETE FROM social_calendar_outcomes')).rejects.toThrow(/efface/);
  });

  it('[R582] sans lien marqué, porte fermée, agent parti ou créneau manqué : rien ne part', async () => {
    const t = await setup();
    const a = await t.property(4);
    await t.cal.setRules(t.alexV, { perDay: { instagram: 1 }, hours: ['09:00'] });
    await t.cal.planWeek(t.alexV, '2027-10-11');
    // Lundi : la page du bien n'est plus en ligne au moment de passer.
    t.state.offline.add(a);
    t.setClock('2027-10-11T07:01:00.000Z');
    await t.cal.runDue(t.network.id);
    t.state.offline.delete(a);
    // Mardi : la porte de diffusion s'est fermée ; X05 refuse, le calendrier le range.
    t.state.closed.add(a);
    t.setClock('2027-10-12T07:01:00.000Z');
    await t.cal.runDue(t.network.id);
    t.state.closed.delete(a);
    // Mercredi : personne n'a fait passer le créneau à temps ; jeudi midi, il est manqué et ne part jamais.
    t.setClock('2027-10-14T10:00:00.000Z');
    await t.cal.runDue(t.network.id);
    const s = await t.cal.slots(t.alexV, '2027-10-11', '2027-10-14');
    expect(s.ok && s.value.map((x) => x.outcome)).toEqual(['refuse', 'refuse', 'manque', 'manque']);
    const outcomes = await t.db.all<{ rule: string; code: string }>('SELECT rule, code FROM social_calendar_outcomes ORDER BY done_at');
    expect(outcomes).toEqual([{ rule: 'R582', code: 'sans_lien' }, { rule: 'R42', code: 'bien_non_diffusable' }]);
    expect(t.received).toEqual([]);
    // L'agent parti : rien ne part, et il ne règle plus rien.
    const t2 = await setup();
    await t2.property(1);
    await t2.cal.setRules(t2.alexV, { perDay: { instagram: 1 }, hours: ['09:00'] });
    await t2.cal.planWeek(t2.alexV, '2027-10-11');
    await t2.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t2.alex.id]);
    t2.setClock('2027-10-11T07:01:00.000Z');
    await t2.cal.runDue(t2.network.id);
    expect(await t2.db.all('SELECT rule, code FROM social_calendar_outcomes')).toEqual([{ rule: 'R86', code: 'agent_parti' }]);
    expect(t2.received).toEqual([]);
    expect(await t2.cal.setRules(t2.alexV, { perDay: { instagram: 1 }, hours: ['09:00'] })).toEqual({ ok: false, rule: 'R86', code: 'agent_parti' });
  });

  it('[R581] une nouvelle version vaut le lendemain : les créneaux réservés sous l’ancienne ne passent plus', async () => {
    const t = await setup();
    await t.property(5);
    await t.property(5);
    await t.cal.setRules(t.alexV, { perDay: { instagram: 1 }, hours: ['09:00'] });
    await t.cal.planWeek(t.alexV, '2027-10-11');
    // Lundi 8 h : Alexandrine passe à zéro sur Instagram et deux sur Facebook, à partir de mardi.
    t.setClock('2027-10-11T06:00:00.000Z');
    expect(await t.cal.setRules(t.alexV, { perDay: { facebook: 2 }, hours: ['10:00', '19:00'] })).toMatchObject({ ok: true, value: { version: 2, effectiveDay: '2027-10-12' } });
    const w = await t.cal.planWeek(t.alexV, '2027-10-11');
    if (!w.ok) throw new Error(w.code);
    expect(w.value.filter((s) => s.day === '2027-10-11').map((s) => s.channel)).toEqual(['instagram']);
    for (const s of w.value.filter((x) => x.day > '2027-10-11')) expect(s.channel).toBe('facebook');
    expect(w.value.filter((s) => s.day === '2027-10-12')).toHaveLength(2);
    // Mardi 9 h 01 : l'ancien créneau Instagram de mardi ne passe pas.
    t.setClock('2027-10-12T07:01:00.000Z');
    expect(await t.cal.runDue(t.network.id)).toEqual({ passed: 0 });
    t.setClock('2027-10-12T08:01:00.000Z');
    expect(await t.cal.runDue(t.network.id)).toEqual({ passed: 1 });
    expect(t.received.map((r) => r.channel)).toEqual(['facebook']);
  });

  it('[R580] planifier un jour lointain d’abord ne fait reprendre aucun bien : les jours se réservent toujours dans l’ordre', async () => {
    const t = await setup();
    const p1 = await t.property(1);
    const p2 = await t.property(2);
    await t.cal.setRules(t.alexV, { perDay: { instagram: 1 }, hours: ['09:00'] });
    const far = await t.cal.planWeek(t.alexV, '2027-10-18');
    const near = await t.cal.planWeek(t.alexV, '2027-10-11');
    if (!far.ok || !near.ok) throw new Error('planification');
    // Trois publications prêtes pour deux biens : P2, P1, P2, puis plus rien.
    expect(near.value.map((s) => s.propertyId)).toEqual([p2, p1, p2]);
    expect(far.value).toEqual([]);
  });

  it('[R582] le chemin de publication exige lui-même le lien marqué quand le calendrier le demande', async () => {
    const t = await setup();
    const a = await t.property(1);
    const post = (await t.db.first<{ id: string }>('SELECT id FROM social_posts WHERE property_id = ?', [a]))!.id;
    t.state.offline.add(a);
    expect(await t.pubs.publish(t.alexV, post, [{ channel: 'instagram', account: 'agent' }], { requireLink: true })).toEqual({ ok: false, rule: 'R156', code: 'sans_lien' });
    t.state.linksDown = true;
    t.state.offline.delete(a);
    expect(await t.pubs.publish(t.alexV, post, [{ channel: 'instagram', account: 'agent' }], { requireLink: true })).toEqual({ ok: false, rule: 'R156', code: 'sans_lien' });
    expect(t.received).toEqual([]);
  });

  it('[R582] l’heure est relue à chaque créneau : un passage lent ne fait partir aucun créneau devenu manqué', async () => {
    const t = await setup();
    await t.property(1);
    await t.cal.setRules(t.alexV, { perDay: { instagram: 1, facebook: 1 }, hours: ['09:00'] });
    await t.cal.planWeek(t.alexV, '2027-10-11');
    t.setClock('2027-10-11T08:59:00.000Z');
    // Le premier envoi dure : quand il finit, l'autre créneau a passé ses deux heures.
    t.state.onPublish = () => {
      t.setClock('2027-10-11T09:05:00.000Z');
    };
    expect(await t.cal.runDue(t.network.id)).toEqual({ passed: 1 });
    expect(t.received).toHaveLength(1);
    const s = await t.cal.slots(t.alexV, '2027-10-11', '2027-10-11');
    expect(s.ok && s.value.map((x) => x.outcome).sort()).toEqual(['envoye', 'manque']);
  });

  it('[R580] après une reprise du bien, seules les sorties du nouvel agent comptent ; une panne du lien est écrite au journal', async () => {
    const t = await setup();
    const a = await t.property(2);
    const b = await t.property(2);
    const samV = t.as(t.sam.id);
    const moved = await t.property(2, t.sam.id);
    // Samuel a déjà publié le bien sur Instagram, puis le bien passe à Alexandrine.
    const post = (await t.db.first<{ id: string }>('SELECT id FROM social_posts WHERE property_id = ? ORDER BY id LIMIT 1', [moved]))!.id;
    expect(await t.pubs.publish(samV, post, [{ channel: 'instagram', account: 'agent' }])).toMatchObject({ ok: true });
    await t.db.run('UPDATE properties SET agent_id = ? WHERE id = ?', [t.alex.id, moved]);
    // Alexandrine a publié A elle-même.
    const aPost = (await t.db.first<{ id: string }>('SELECT id FROM social_posts WHERE property_id = ? ORDER BY id LIMIT 1', [a]))!.id;
    expect(await t.pubs.publish(t.alexV, aPost, [{ channel: 'instagram', account: 'agent' }])).toMatchObject({ ok: true });
    await t.cal.setRules(t.alexV, { perDay: { instagram: 1 }, hours: ['09:00'] });
    const w = await t.cal.planWeek(t.alexV, '2027-10-11');
    if (!w.ok) throw new Error(w.code);
    // Le bien repris n'est jamais sorti chez elle : il passe avec B avant toute reprise de A.
    expect(w.value.slice(0, 2).map((s) => s.propertyId).sort()).toEqual([b, moved].sort());
    const t2 = await setup();
    await t2.property(1);
    await t2.cal.setRules(t2.alexV, { perDay: { instagram: 1 }, hours: ['09:00'] });
    t2.state.linksDown = true;
    expect(await t2.cal.planWeek(t2.alexV, '2027-10-11')).toEqual({ ok: true, value: [] });
    const ev = await t2.db.all<{ data: string }>("SELECT data FROM journal WHERE type = 'marketing.calendrier.lien_indisponible'");
    expect(ev.length).toBeGreaterThan(0);
    expect(JSON.parse(ev[0]!.data)).toEqual({ channel: 'instagram', rule: 'R582', error: 'Error' });
  });

  it('les heures de Paris, en hiver comme en été', () => {
    expect(parisInstant('2027-01-15', '09:00').toISOString()).toBe('2027-01-15T08:00:00.000Z');
    expect(parisInstant('2027-07-15', '09:00').toISOString()).toBe('2027-07-15T07:00:00.000Z');
    expect(parisInstant('2027-10-31', '09:00').toISOString()).toBe('2027-10-31T08:00:00.000Z');
  });
});

it('[R582] le calendrier ne reçoit aucun réseau : seul le chemin de publication de X05 lui est donné', async () => {
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/marketing/calendrier.ts', import.meta.url), 'utf8'));
  expect(src).not.toMatch(/\.post\(|SocialChannel\b|trialSocialChannel/);
  expect(src).toMatch(/gate\.publish\(/);
});
