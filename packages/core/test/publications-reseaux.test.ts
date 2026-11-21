import { describe, expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, SqlJournalStore, annonces, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { EVENT_HEADLINES, Publications, SocialSendError, caption, metaError, metaSocialChannels, trialSocialChannel, type CertifiedPhoto, type SocialChannel, type SocialPayload, type SocialWriter } from '../src/studio/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const { fallbackListing, publicTextProblems } = annonces;
type Facts = Parameters<typeof fallbackListing>[0];

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

it('les accroches des événements passent le contrôle des textes publics', () => {
  for (const h of Object.values(EVENT_HEADLINES)) expect(publicTextProblems(h), h).toEqual([]);
});

it('[R26] [R134] un canal réel est refusé sans la mise en service explicite (AU036) ; un mode inconnu toujours', () => {
  const real: SocialChannel = { channel: 'instagram', mode: 'reel', post: async () => ({ postRef: '1' }), remove: async () => {} };
  const deps = { facts: {} as never, certs: {} as never, diffusion: {} as never, mentions: {} as never, consents: {} as never };
  expect(() => new Publications({} as SqlDatabase, {} as never, {} as never, { ...deps, channels: [real] })).toThrow(/mode essai/);
  expect(() => new Publications({} as SqlDatabase, {} as never, {} as never, { ...deps, channels: [real] }, { live: false })).toThrow(/mode essai/);
  expect(() => new Publications({} as SqlDatabase, {} as never, {} as never, { ...deps, channels: [real] }, { live: true })).not.toThrow();
  // [R42] Ce qui part pour de vrai doit savoir se retirer.
  expect(() => new Publications({} as SqlDatabase, {} as never, {} as never, { ...deps, channels: [{ channel: 'instagram', mode: 'reel', post: async () => ({ postRef: '1' }) }] }, { live: true })).toThrow(/retirer/);
  const odd = { channel: 'instagram', mode: 'direct', post: async () => {} } as unknown as SocialChannel;
  expect(() => new Publications({} as SqlDatabase, {} as never, {} as never, { ...deps, channels: [odd] }, { live: true })).toThrow(/Mode inconnu/);
});

// Les mentions telles que M07 les calcule, inventées.
const MENTIONS = 'Prix : 230 000 € honoraires inclus, dont 4,55 % TTC à la charge de l’acquéreur.\nClasse énergie C, classe climat C.\nCarte professionnelle n° CPI 0000 0000 000 000 000.';

const photo = (p: string, n: number) => `biens/${p}/0000000${n}-0000-4000-8000-000000000000.jpg`;
const consent = (p: string, n: number) => `biens/${p}/accords/0000000${n}-0000-4000-8000-0000000000cc.pdf`;

async function setup(opts: { writer?: SocialWriter | null; failing?: string[]; origin?: NonNullable<ConstructorParameters<typeof Publications>[3]['origin']>; postRef?: string; live?: (propertyId: string) => SocialChannel[] } = {}) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = Date.parse('2027-10-10T08:00:00.000Z');
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const acces = new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alexandrine', lastName: 'Fictive' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Samuel', lastName: 'Inventé' });
  const p = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'PUB-5', kind: 'home', city: 'Villebrune', priceEur: 230_000, surfaceM2: 72, rooms: 3, status: 'available' });
  const certified: CertifiedPhoto[] = [
    { ref: photo(p.id, 1), overlay: null, retouchMention: null, retouches: [], certificateToken: 'a'.repeat(32), certificatePath: `/certificat-photo/${'a'.repeat(32)}` },
    { ref: photo(p.id, 2), overlay: 'Aménagement virtuel', retouchMention: null, retouches: [], certificateToken: 'b'.repeat(32), certificatePath: `/certificat-photo/${'b'.repeat(32)}`, twin: photo(p.id, 1) },
  ];
  const state = { diffusable: true, certified, consents: new Set([consent(p.id, 1)]), consentsDown: false, facts: structuredClone(FACTS), mentions: { complete: true, text: MENTIONS, publishedPriceEur: 230_000 } as { complete: boolean; text: string; publishedPriceEur: number | null } };
  const received: (SocialPayload & { channel: string })[] = [];
  const failing = new Set(opts.failing ?? []);
  const channels = (['instagram', 'facebook', 'linkedin'] as const).map((c) => ({
    ...trialSocialChannel(c),
    post: async (payload: SocialPayload) => {
      if (failing.has(c)) throw new Error('panne');
      received.push({ ...payload, channel: c });
      return opts.postRef ? { postRef: opts.postRef } : undefined;
    },
  }));
  const pubs = new Publications(
    db,
    acces,
    journal,
    {
      facts: { factsFor: async (id: string) => (id === p.id ? { facts: structuredClone(state.facts) } : null) },
      certs: { publishable: async () => state.certified },
      diffusion: { canDiffuse: async () => ({ allowed: state.diffusable }) },
      mentions: { checklist: async () => state.mentions },
      consents: {
        has: async (r: string) => {
          if (state.consentsDown) throw new Error('panne');
          return state.consents.has(r);
        },
      },
      channels: opts.live ? [...channels.filter((c) => !opts.live!(p.id).some((l) => l.channel === c.channel)), ...opts.live(p.id)] : channels,
      ...(opts.origin ? { origin: opts.origin } : {}),
    },
    { now, writer: opts.writer === undefined ? null : opts.writer, timeoutMs: 50, ...(opts.live ? { live: true } : {}) },
  );
  const as = (role: 'agent' | 'direction' | 'compliance', userId: string) => ({ role, userId, networkId: network.id }) as never;
  const alexV = as('agent', alex.id);
  /** Une publication prête : préparée, ses deux visuels contrôlés, validée. */
  const ready = async () => {
    const prep = await pubs.prepare(alexV, p.id, { event: 'nouveau_bien', visuals: [photo(p.id, 1), photo(p.id, 2)] });
    if (!prep.ok) throw new Error(prep.code);
    await pubs.checkVisual(alexV, prep.value.id, { ref: photo(p.id, 1), addressVisible: false, personVisible: false });
    await pubs.checkVisual(alexV, prep.value.id, { ref: photo(p.id, 2), addressVisible: false, personVisible: false, stagingLabelVisible: true });
    const v = await pubs.validate(alexV, prep.value.id);
    if (!v.ok) throw new Error(v.code);
    return prep.value.id;
  };
  return { db, journal, pubs, network, alex, sam, p, state, received, as, alexV, ready, failing, setClock: (iso: string) => (clock = Date.parse(iso)) };
}

describeWithSqlite('X05 · publications prêtes pour chaque événement', () => {
  it('une publication préparée : accroche de l’événement, corps de l’IA contrôlé, photos certifiées avec leur mention', async () => {
    const writer: SocialWriter = { write: async ({ facts }) => ({ body: fallbackListing(facts).body }) };
    const t = await setup({ writer });
    // Une image aménagée seule, ou avant sa photo réelle jumelle, ne part pas (HX41) [R493].
    expect(await t.pubs.prepare(t.alexV, t.p.id, { event: 'visite', visuals: [photo(t.p.id, 2)] })).toEqual({ ok: false, rule: 'R493', code: 'amenagement_sans_jumelle' });
    expect(await t.pubs.prepare(t.alexV, t.p.id, { event: 'visite', visuals: [photo(t.p.id, 2), photo(t.p.id, 1)] })).toEqual({ ok: false, rule: 'R493', code: 'amenagement_sans_jumelle' });
    const r = await t.pubs.prepare(t.alexV, t.p.id, { event: 'visite', visuals: [photo(t.p.id, 1), photo(t.p.id, 2)] });
    expect(r).toMatchObject({ ok: true, value: { event: 'visite', origin: 'ia', validated: null, sends: [] } });
    if (!r.ok) return;
    expect(r.value.text.startsWith('Visites en cours pour ce bien.\n\n')).toBe(true);
    expect(r.value.visuals).toEqual([
      { ref: photo(t.p.id, 1), overlay: null, certificatePath: `/certificat-photo/${'a'.repeat(32)}`, check: null },
      { ref: photo(t.p.id, 2), overlay: 'Aménagement virtuel', certificatePath: `/certificat-photo/${'b'.repeat(32)}`, check: null },
    ]);
    // Au journal : l'événement et l'origine, jamais le texte.
    const ev = await t.db.all<{ data: string }>("SELECT data FROM journal WHERE type = 'studio.publication.preparee'");
    expect(JSON.parse(ev[0]!.data)).toEqual({ post: r.value.id, event: 'visite', origin: 'ia', visuals: 2 });
  });

  it('[R46] [R47] un texte de l’IA qui situe le bien, invente un nombre, ou une IA en panne ou lente : texte de secours', async () => {
    for (const writer of [
      { write: async () => ({ body: 'Logement au 12 rue des Essais, très lumineux et calme.' }) },
      { write: async () => ({ body: 'Logement de 95 m² avec balcon, à visiter vite.' }) },
      { write: async () => ({ body: 'Idéal pour un couple sans enfants, au calme.' }) },
      { write: async () => ({ body: 'Logement de 72 m² proposé par votre mandataire, visite gratuite.' }) },
      { write: async () => { throw new Error('panne'); } },
      { write: () => new Promise<{ body: string }>((resolve) => setTimeout(() => resolve({ body: 'trop tard, trop tard' }), 500)) },
    ] as SocialWriter[]) {
      const t = await setup({ writer });
      const r = await t.pubs.prepare(t.alexV, t.p.id, { event: 'nouveau_bien', visuals: [photo(t.p.id, 1)] });
      expect(r).toMatchObject({ ok: true, value: { origin: 'secours' } });
      if (!r.ok) return;
      expect(r.value.text).toBe(`Nouveau bien à découvrir.\n\n${fallbackListing(FACTS).body}\n\n${MENTIONS}`);
      expect(r.value.text).not.toMatch(/rue des Essais|95 m²|enfants|mandataire|gratuit/);
    }
  });

  it('[R130] [R42] seulement des photos certifiées, d’un bien encore diffusable', async () => {
    const t = await setup();
    expect(await t.pubs.prepare(t.alexV, t.p.id, { event: 'nouveau_bien', visuals: [photo(t.p.id, 3)] })).toEqual({ ok: false, rule: 'R130', code: 'visuel_sans_certificat' });
    expect(await t.pubs.prepare(t.alexV, t.p.id, { event: 'nouveau_bien', visuals: [] })).toEqual({ ok: false, rule: 'R10', code: 'visuels_invalides' });
    expect(await t.pubs.prepare(t.alexV, t.p.id, { event: 'soldes', visuals: [photo(t.p.id, 1)] })).toEqual({ ok: false, rule: 'R10', code: 'evenement_inconnu' });
    // [R10] On n'annonce ni une offre ni une vente que les données ne disent pas.
    expect(await t.pubs.prepare(t.alexV, t.p.id, { event: 'offre', visuals: [photo(t.p.id, 1)] })).toEqual({ ok: false, rule: 'R10', code: 'evenement_sans_fondement' });
    expect(await t.pubs.prepare(t.alexV, t.p.id, { event: 'vente', visuals: [photo(t.p.id, 1)] })).toEqual({ ok: false, rule: 'R10', code: 'evenement_sans_fondement' });
    await t.db.run("UPDATE properties SET status = 'under_offer' WHERE id = ?", [t.p.id]);
    expect(await t.pubs.prepare(t.alexV, t.p.id, { event: 'offre', visuals: [photo(t.p.id, 1)] })).toMatchObject({ ok: true, value: { text: expect.stringMatching(/^Une offre a été reçue pour ce bien\./) } });
    expect(await t.pubs.prepare(t.alexV, t.p.id, { event: 'nouveau_bien', visuals: [photo(t.p.id, 1)] })).toEqual({ ok: false, rule: 'R10', code: 'evenement_sans_fondement' });
    await t.db.run("UPDATE properties SET status = 'available' WHERE id = ?", [t.p.id]);
    t.state.diffusable = false;
    expect(await t.pubs.prepare(t.alexV, t.p.id, { event: 'nouveau_bien', visuals: [photo(t.p.id, 1)] })).toEqual({ ok: false, rule: 'R42', code: 'bien_non_diffusable' });
    expect(await t.db.all('SELECT id FROM social_posts')).toHaveLength(1);
  });

  it('[R132] un visuel avec une adresse lisible, ou une personne reconnaissable sans accord rangé, est refusé ; l’aménagement virtuel exige sa mention', async () => {
    const t = await setup();
    const prep = await t.pubs.prepare(t.alexV, t.p.id, { event: 'nouveau_bien', visuals: [photo(t.p.id, 1), photo(t.p.id, 2)] });
    if (!prep.ok) throw new Error(prep.code);
    const id = prep.value.id;
    expect(await t.pubs.checkVisual(t.alexV, id, { ref: photo(t.p.id, 1), addressVisible: 'non', personVisible: false })).toEqual({ ok: false, rule: 'R132', code: 'liste_incomplete' });
    expect(await t.pubs.checkVisual(t.alexV, id, { ref: photo(t.p.id, 2), addressVisible: false, personVisible: false })).toEqual({ ok: false, rule: 'R132', code: 'amenagement_sans_mention' });
    // Refusé une fois : ce visuel ne part pas avec cette publication, la validation est refusée.
    expect(await t.pubs.checkVisual(t.alexV, id, { ref: photo(t.p.id, 2), addressVisible: false, personVisible: false, stagingLabelVisible: true })).toEqual({ ok: false, rule: 'R10', code: 'deja_controle' });
    expect(await t.pubs.checkVisual(t.alexV, id, { ref: photo(t.p.id, 1), addressVisible: false, personVisible: true })).toEqual({ ok: false, rule: 'R132', code: 'personne_sans_accord' });
    expect(await t.pubs.validate(t.alexV, id)).toEqual({ ok: false, rule: 'R132', code: 'visuel_non_controle' });
    // Une autre publication : adresse visible refusée ; accord inconnu du stockage refusé ; accord rangé admis.
    for (const [over, code] of [
      [{ addressVisible: true, personVisible: false }, 'adresse_visible'],
      [{ addressVisible: false, personVisible: true, consentRef: consent(t.p.id, 9) }, 'personne_sans_accord'],
      [{ addressVisible: false, personVisible: true, consentRef: `biens/autre/accords/00000001-0000-4000-8000-0000000000cc.pdf` }, 'personne_sans_accord'],
    ] as const) {
      const p2 = await t.pubs.prepare(t.alexV, t.p.id, { event: 'nouveau_bien', visuals: [photo(t.p.id, 1)] });
      if (!p2.ok) throw new Error(p2.code);
      expect(await t.pubs.checkVisual(t.alexV, p2.value.id, { ref: photo(t.p.id, 1), ...over }), code).toEqual({ ok: false, rule: 'R132', code });
    }
    const p3 = await t.pubs.prepare(t.alexV, t.p.id, { event: 'nouveau_bien', visuals: [photo(t.p.id, 1)] });
    if (!p3.ok) throw new Error(p3.code);
    expect(await t.pubs.checkVisual(t.alexV, p3.value.id, { ref: photo(t.p.id, 1), addressVisible: false, personVisible: true, consentRef: consent(t.p.id, 1) })).toMatchObject({ ok: true, value: { visuals: [{ check: 'admis' }] } });
    expect(await t.pubs.validate(t.alexV, p3.value.id)).toMatchObject({ ok: true });
  });

  it('[R134] rien ne part sans la validation de l’agent du bien ; ensuite, en un geste, vers chaque compte, en mode essai', async () => {
    const t = await setup();
    const prep = await t.pubs.prepare(t.alexV, t.p.id, { event: 'visite', visuals: [photo(t.p.id, 1)] });
    if (!prep.ok) throw new Error(prep.code);
    const targets = [
      { channel: 'instagram', account: 'agent' },
      { channel: 'facebook', account: 'reseau' },
    ];
    expect(await t.pubs.publish(t.alexV, prep.value.id, targets)).toEqual({ ok: false, rule: 'R134', code: 'non_validee' });
    expect(t.received).toEqual([]);
    // La direction ne valide pas à la place de l'agent du bien ; un autre agent non plus.
    expect(await t.pubs.validate(t.as('direction', 'd1'), prep.value.id)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.pubs.validate(t.as('agent', t.sam.id), prep.value.id)).toMatchObject({ ok: false, rule: 'R16' });
    await t.pubs.checkVisual(t.alexV, prep.value.id, { ref: photo(t.p.id, 1), addressVisible: false, personVisible: false });
    expect(await t.pubs.validate(t.alexV, prep.value.id)).toMatchObject({ ok: true, value: { validated: { by: `agent:${t.alex.id}` } } });
    const sent = await t.pubs.publish(t.alexV, prep.value.id, targets);
    expect(sent).toMatchObject({ ok: true, value: { sends: [{ channel: 'facebook', account: 'reseau', outcome: 'envoye' }, { channel: 'instagram', account: 'agent', outcome: 'envoye' }] } });
    expect(t.received.map((r) => [r.channel, r.account])).toEqual([
      ['instagram', 'agent'],
      ['facebook', 'reseau'],
    ]);
    expect(t.received[0]!.visuals).toEqual([{ ref: photo(t.p.id, 1), overlay: null, certificatePath: `/certificat-photo/${'a'.repeat(32)}` }]);
    // Le même geste refait n'envoie rien deux fois.
    await t.pubs.publish(t.alexV, prep.value.id, targets);
    expect(t.received).toHaveLength(2);
    expect(await t.db.all("SELECT mode FROM social_post_attempts WHERE mode <> 'essai'")).toEqual([]);
    // Un réseau qui n'est pas branché, même en essai : refusé.
    expect(await t.pubs.publish(t.alexV, prep.value.id, [{ channel: 'tiktok', account: 'agent' }])).toEqual({ ok: false, rule: 'R26', code: 'canal_hors_service' });
    await expect(t.db.run("INSERT INTO social_post_attempts (id, post_id, channel, account, attempt, mode, claimed_by, claimed_at) VALUES ('x', ?, 'linkedin', 'agent', 0, 'reel', 'a', 'b')", [prep.value.id])).rejects.toThrow();
  });

  it('[R42] [R130] juste avant l’envoi, la porte de diffusion et les certificats sont relus', async () => {
    const t = await setup();
    const id = await t.ready();
    t.state.diffusable = false;
    expect(await t.pubs.publish(t.alexV, id, [{ channel: 'instagram', account: 'agent' }])).toEqual({ ok: false, rule: 'R42', code: 'bien_non_diffusable' });
    t.state.diffusable = true;
    // [R10] Le bien est passé sous offre depuis : « nouveau bien » ne part plus.
    await t.db.run("UPDATE properties SET status = 'under_offer' WHERE id = ?", [t.p.id]);
    expect(await t.pubs.publish(t.alexV, id, [{ channel: 'instagram', account: 'agent' }])).toEqual({ ok: false, rule: 'R10', code: 'evenement_sans_fondement' });
    await t.db.run("UPDATE properties SET status = 'available' WHERE id = ?", [t.p.id]);
    // [R493] La déclaration de la jumelle n'est plus là : l'image aménagée ne part plus, même certifiée.
    const before = t.state.certified;
    t.state.certified = before.map(({ twin: _twin, ...c }) => c);
    expect(await t.pubs.publish(t.alexV, id, [{ channel: 'instagram', account: 'agent' }])).toEqual({ ok: false, rule: 'R493', code: 'amenagement_sans_jumelle' });
    t.state.certified = before.slice(0, 1);
    expect(await t.pubs.publish(t.alexV, id, [{ channel: 'instagram', account: 'agent' }])).toEqual({ ok: false, rule: 'R130', code: 'visuel_sans_certificat' });
    expect(t.received).toEqual([]);
  });

  it('[R47] une fiche corrigée après la préparation : le texte rangé ne part plus, ni à la validation ni à l’envoi', async () => {
    const t = await setup();
    const id = await t.ready();
    expect((await t.pubs.read(t.alexV, id)).ok && JSON.stringify(await t.pubs.read(t.alexV, id))).toContain('72');
    // La surface est corrigée après la validation : le texte qui dit 72 m² ne part pas.
    t.state.facts = { ...t.state.facts, surfaceM2: 60 };
    expect(await t.pubs.publish(t.alexV, id, [{ channel: 'instagram', account: 'agent' }])).toEqual({ ok: false, rule: 'R47', code: 'texte_perime' });
    expect(t.received).toEqual([]);
    // Une publication préparée avant la correction ne se valide plus non plus ; une nouvelle, préparée après, part.
    t.state.facts = { ...t.state.facts, surfaceM2: 72 };
    const prep = await t.pubs.prepare(t.alexV, t.p.id, { event: 'nouveau_bien', visuals: [photo(t.p.id, 1)] });
    if (!prep.ok) throw new Error(prep.code);
    await t.pubs.checkVisual(t.alexV, prep.value.id, { ref: photo(t.p.id, 1), addressVisible: false, personVisible: false });
    t.state.facts = { ...t.state.facts, surfaceM2: 60 };
    expect(await t.pubs.validate(t.alexV, prep.value.id)).toEqual({ ok: false, rule: 'R47', code: 'texte_perime' });
    const fresh = await t.pubs.prepare(t.alexV, t.p.id, { event: 'nouveau_bien', visuals: [photo(t.p.id, 1)] });
    if (!fresh.ok) throw new Error(fresh.code);
    expect(fresh.value.text).toContain('60');
    await t.pubs.checkVisual(t.alexV, fresh.value.id, { ref: photo(t.p.id, 1), addressVisible: false, personVisible: false });
    expect((await t.pubs.validate(t.alexV, fresh.value.id)).ok).toBe(true);
    expect((await t.pubs.publish(t.alexV, fresh.value.id, [{ channel: 'instagram', account: 'agent' }])).ok).toBe(true);
    expect(t.received.map((r) => r.postId)).toEqual([fresh.value.id]);
  });

  it('[R43] une annonce sur un réseau porte toutes les mentions obligatoires du moment ; une seule manque, rien ne part', async () => {
    const t = await setup();
    const id = await t.ready();
    const post = await t.pubs.read(t.alexV, id);
    expect(post.ok && post.value.text.endsWith(`\n\n${MENTIONS}`)).toBe(true);
    // Une mention change (le mandat a un avenant) : le texte rangé ne part plus.
    t.state.mentions = { ...t.state.mentions, text: MENTIONS.replace('230 000', '225 000') };
    expect(await t.pubs.publish(t.alexV, id, [{ channel: 'instagram', account: 'agent' }])).toEqual({ ok: false, rule: 'R43', code: 'mentions_perimees' });
    // Une mention manque : ni préparation, ni envoi.
    t.state.mentions = { complete: false, text: '', publishedPriceEur: null };
    expect(await t.pubs.publish(t.alexV, id, [{ channel: 'instagram', account: 'agent' }])).toEqual({ ok: false, rule: 'R43', code: 'mentions_incompletes' });
    expect(await t.pubs.prepare(t.alexV, t.p.id, { event: 'nouveau_bien', visuals: [photo(t.p.id, 1)] })).toEqual({ ok: false, rule: 'R43', code: 'mentions_incompletes' });
    expect(t.received).toEqual([]);
    // Les mentions revenues telles qu'à la préparation : la publication part, mentions comprises.
    t.state.mentions = { complete: true, text: MENTIONS, publishedPriceEur: 230_000 };
    expect((await t.pubs.publish(t.alexV, id, [{ channel: 'instagram', account: 'agent' }])).ok).toBe(true);
    expect(t.received[0]!.text.endsWith(MENTIONS)).toBe(true);
    // Une vente conclue n'annonce plus rien à vendre : elle ne porte pas de mentions.
    await t.db.run("UPDATE properties SET status = 'sold' WHERE id = ?", [t.p.id]);
    const sold = await t.pubs.prepare(t.alexV, t.p.id, { event: 'vente', visuals: [photo(t.p.id, 1)] });
    expect(sold.ok && sold.value.text.includes('Carte professionnelle')).toBe(false);
  });

  it('[R132] l’accord d’une personne reconnaissable est relu à l’envoi : absent ou stockage en panne, rien ne part', async () => {
    const t = await setup();
    const prep = await t.pubs.prepare(t.alexV, t.p.id, { event: 'nouveau_bien', visuals: [photo(t.p.id, 1)] });
    if (!prep.ok) throw new Error(prep.code);
    expect((await t.pubs.checkVisual(t.alexV, prep.value.id, { ref: photo(t.p.id, 1), addressVisible: false, personVisible: true, consentRef: consent(t.p.id, 1) })).ok).toBe(true);
    expect((await t.pubs.validate(t.alexV, prep.value.id)).ok).toBe(true);
    t.state.consents.delete(consent(t.p.id, 1));
    expect(await t.pubs.publish(t.alexV, prep.value.id, [{ channel: 'instagram', account: 'agent' }])).toEqual({ ok: false, rule: 'R132', code: 'accord_absent' });
    t.state.consents.add(consent(t.p.id, 1));
    t.state.consentsDown = true;
    expect(await t.pubs.publish(t.alexV, prep.value.id, [{ channel: 'instagram', account: 'agent' }])).toEqual({ ok: false, rule: 'R132', code: 'stockage_indisponible' });
    expect(t.received).toEqual([]);
    t.state.consentsDown = false;
    expect((await t.pubs.publish(t.alexV, prep.value.id, [{ channel: 'instagram', account: 'agent' }])).ok).toBe(true);
  });

  it('[R86] une publication préparée ou validée par un agent parti ne part pas, même par son successeur', async () => {
    const t = await setup();
    const id = await t.ready();
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.alex.id]);
    await t.db.run('UPDATE properties SET agent_id = ? WHERE id = ?', [t.sam.id, t.p.id]);
    const samV = t.as('agent', t.sam.id);
    expect(await t.pubs.publish(samV, id, [{ channel: 'instagram', account: 'agent' }])).toEqual({ ok: false, rule: 'R86', code: 'auteur_parti' });
    expect(t.received).toEqual([]);
    // Le successeur prépare et valide la sienne : elle part.
    const prep = await t.pubs.prepare(samV, t.p.id, { event: 'nouveau_bien', visuals: [photo(t.p.id, 1)] });
    if (!prep.ok) throw new Error(prep.code);
    await t.pubs.checkVisual(samV, prep.value.id, { ref: photo(t.p.id, 1), addressVisible: false, personVisible: false });
    expect((await t.pubs.validate(samV, prep.value.id)).ok).toBe(true);
    expect((await t.pubs.publish(samV, prep.value.id, [{ channel: 'instagram', account: 'agent' }])).ok).toBe(true);
  });

  it('un réseau en panne n’empêche pas les autres ; son envoi se retente au geste suivant, une fois réussi il ne se refait plus', async () => {
    const t = await setup({ failing: ['instagram'] });
    const id = await t.ready();
    const targets = [
      { channel: 'instagram', account: 'agent' },
      { channel: 'linkedin', account: 'agent' },
    ];
    expect(await t.pubs.publish(t.alexV, id, targets)).toMatchObject({ ok: true, value: { sends: [{ channel: 'instagram', outcome: 'echec' }, { channel: 'linkedin', outcome: 'envoye' }] } });
    t.failing.clear();
    expect(await t.pubs.publish(t.alexV, id, targets)).toMatchObject({ ok: true, value: { sends: [{ channel: 'instagram', outcome: 'envoye' }, { channel: 'linkedin', outcome: 'envoye' }] } });
    expect(t.received.map((r) => r.channel)).toEqual(['linkedin', 'instagram']);
    const ev = await t.db.all<{ data: string }>("SELECT data FROM journal WHERE type = 'studio.publication.envoi'");
    expect(ev.map((e) => JSON.parse(e.data)).map((d) => [d.channel, d.outcome, d.mode])).toEqual([
      ['instagram', 'echec', 'essai'],
      ['linkedin', 'envoye', 'essai'],
      ['instagram', 'envoye', 'essai'],
    ]);
  });

  describe('AT18 · le lien marqué et la référence du réseau', () => {
    const targets = [{ channel: 'instagram', account: 'agent' }];
    it('[R156] la publication part avec le lien de son contenu ; la référence rendue par le réseau la relie, une seule fois', async () => {
      const links: unknown[][] = [];
      const seen: unknown[][] = [];
      const t = await setup({
        postRef: 'post-ext-1',
        origin: {
          studioLink: async (...a) => (seen.push(a), { contentId: 'codecontenu1', link: 'https://reseau.exemple.test/biens/x?o=codecontenu1' }),
          linkPost: async (...a) => (links.push(a), { ok: true }),
        },
      });
      const id = await t.ready();
      expect((await t.pubs.publish(t.alexV, id, targets)).ok).toBe(true);
      expect(t.received[0]!.link).toBe('https://reseau.exemple.test/biens/x?o=codecontenu1');
      expect(seen).toEqual([[t.network.id, 'publication', id, t.p.id]]);
      expect(links).toEqual([[t.network.id, 'codecontenu1', 'instagram', 'post-ext-1']]);
      // Un réseau d'où rien ne remonte n'est pas une panne ; un envoi réussi ne se refait pas, donc rien ne se relie deux fois.
      await t.pubs.publish(t.alexV, id, targets);
      expect(links).toHaveLength(1);
      expect((await t.journal.all()).some((e) => e.type === 'studio.publication.origine_indisponible')).toBe(false);
    });

    it('un bien sans page en ligne : pas de lien, l’envoi part quand même', async () => {
      const t = await setup({ origin: { studioLink: async () => ({ contentId: 'codecontenu1', link: null }), linkPost: async () => ({ ok: true }) } });
      const r = await t.pubs.publish(t.alexV, await t.ready(), targets);
      expect(r.ok).toBe(true);
      expect(t.received[0]!.link).toBeNull();
    });

    it('[R13] une panne de l’origine n’empêche aucun envoi ; elle est au journal, sans donnée', async () => {
      const t = await setup({ postRef: 'post-ext-2', origin: { studioLink: async () => { throw new TypeError('panne 06 00 00 00 00'); }, linkPost: async () => ({ ok: true }) } });
      const r = await t.pubs.publish(t.alexV, await t.ready(), targets);
      expect(r.ok && r.value.sends).toMatchObject([{ channel: 'instagram', outcome: 'envoye' }]);
      expect(t.received[0]!.link).toBeNull();
      const down = (await t.journal.all()).filter((e) => e.type === 'studio.publication.origine_indisponible');
      expect(down.map((e) => e.data)).toEqual([{ rule: 'R156', step: 'lien', error: 'TypeError' }]);
      const u = await setup({ postRef: 'post-ext-3', origin: { studioLink: async () => ({ contentId: 'codecontenu1', link: null }), linkPost: async () => { throw new Error('panne'); } } });
      const v = await u.pubs.publish(u.alexV, await u.ready(), targets);
      expect(v.ok && v.value.sends).toMatchObject([{ outcome: 'envoye' }]);
      expect((await u.journal.all()).filter((e) => e.type === 'studio.publication.origine_indisponible').map((e) => e.data)).toEqual([{ rule: 'R156', step: 'liaison', error: 'Error' }]);
    });

    it('[R13] la liaison en panne et le journal aussi : l’envoi reste noté, la cible suivante est servie, rien ne repart', async () => {
      const box: { t?: Awaited<ReturnType<typeof setup>> } = {};
      const t = await setup({
        postRef: 'post-ext-6',
        origin: {
          studioLink: async () => ({ contentId: 'codecontenu1', link: null }),
          linkPost: async () => {
            // Le raté survient juste après l'envoi noté : la note de panne échoue, le reste du journal revient ensuite.
            const j = box.t!.journal as unknown as { append: unknown };
            const real = j.append;
            j.append = async () => {
              j.append = real;
              throw new Error('journal');
            };
            throw new Error('panne');
          },
        },
      });
      box.t = t;
      const id = await t.ready();
      const both = [{ channel: 'instagram', account: 'agent' }, { channel: 'facebook', account: 'agent' }];
      const r = await t.pubs.publish(t.alexV, id, both);
      expect(r.ok && r.value.sends.map((x) => [x.channel, x.outcome]).sort()).toEqual([['facebook', 'envoye'], ['instagram', 'envoye']]);
      expect(t.received.map((x) => x.channel)).toEqual(['instagram', 'facebook']);
      await t.pubs.publish(t.alexV, id, both);
      expect(t.received).toHaveLength(2);
      expect(await t.db.all('SELECT COUNT(*) AS n FROM social_post_sends')).toEqual([{ n: 2 }]);
    });

    it('un réseau d’où aucun commentaire ne remonte n’est pas une panne ; une référence déjà prise est notée', async () => {
      const t = await setup({ postRef: 'post-ext-4', origin: { studioLink: async () => ({ contentId: 'codecontenu1', link: null }), linkPost: async () => ({ ok: false, code: 'bad_channel' }) } });
      await t.pubs.publish(t.alexV, await t.ready(), [{ channel: 'linkedin', account: 'agent' }]);
      expect((await t.journal.all()).some((e) => e.type === 'studio.publication.origine_indisponible')).toBe(false);
      const u = await setup({ postRef: 'post-ext-5', origin: { studioLink: async () => ({ contentId: 'codecontenu1', link: null }), linkPost: async () => ({ ok: false, code: 'post_taken' }) } });
      await u.pubs.publish(u.alexV, await u.ready(), targets);
      expect((await u.journal.all()).filter((e) => e.type === 'studio.publication.origine_indisponible').map((e) => e.data)).toEqual([{ rule: 'R156', step: 'post_taken', error: 'inconnue' }]);
    });
  });

  it('[R16] [R17] seuls l’agent du bien et la direction préparent ; rien ne s’efface', async () => {
    const t = await setup();
    expect(await t.pubs.prepare(t.as('agent', t.sam.id), t.p.id, { event: 'nouveau_bien', visuals: [photo(t.p.id, 1)] })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.pubs.prepare(t.as('compliance', 'c1'), t.p.id, { event: 'nouveau_bien', visuals: [photo(t.p.id, 1)] })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    const d = await t.pubs.prepare(t.as('direction', 'd1'), t.p.id, { event: 'nouveau_bien', visuals: [photo(t.p.id, 1)] });
    expect(d).toMatchObject({ ok: true, value: { event: 'nouveau_bien' } });
    if (!d.ok) return;
    expect(await t.pubs.read(t.as('agent', t.sam.id), d.value.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.pubs.read(t.alexV, d.value.id)).toMatchObject({ ok: true });
    await expect(t.db.run('DELETE FROM social_posts')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run("UPDATE social_posts SET text = 'autre texte public'")).rejects.toThrow(/ne change plus/);
  });
  it('[R110] un commerce ne passe jamais par les publications du studio, pour aucun événement (RC07)', async () => {
    const t = await setup();
    const events = { available: ['nouveau_bien', 'visite'], under_offer: ['visite', 'offre'], sold: ['vente'] } as const;
    for (const kind of ['business', 'business_walls', 'commercial'] as const) {
      for (const [status, list] of Object.entries(events)) {
        await t.db.run('UPDATE properties SET kind = ?, status = ? WHERE id = ?', [kind, status, t.p.id]);
        for (const event of list) {
          for (const viewer of [t.alexV, t.as('direction', t.sam.id)]) {
            expect(await t.pubs.prepare(viewer, t.p.id, { event, visuals: [photo(t.p.id, 1)] }), `${kind} ${event}`).toEqual({ ok: false, rule: 'R110', code: 'commerce_discret' });
          }
        }
      }
    }
    expect(await t.db.all('SELECT id FROM social_posts')).toEqual([]);
    const refus = await t.db.all<{ data: string }>("SELECT data FROM journal WHERE type = 'studio.publication.refuse'");
    expect(refus.length).toBe(30);
    for (const r of refus) expect(JSON.parse(r.data)).toEqual({ rule: 'R110', code: 'commerce_discret' });
    // Un logement garde son parcours.
    await t.db.run("UPDATE properties SET kind = 'home', status = 'available' WHERE id = ?", [t.p.id]);
    expect(await t.pubs.prepare(t.alexV, t.p.id, { event: 'nouveau_bien', visuals: [photo(t.p.id, 1)] })).toMatchObject({ ok: true });
  });

  it('[R110] une publication rangée pour un bien devenu commerce n’est ni validée ni envoyée (RC07)', async () => {
    const t = await setup();
    const prep = await t.pubs.prepare(t.alexV, t.p.id, { event: 'nouveau_bien', visuals: [photo(t.p.id, 1)] });
    if (!prep.ok) throw new Error(prep.code);
    await t.pubs.checkVisual(t.alexV, prep.value.id, { ref: photo(t.p.id, 1), addressVisible: false, personVisible: false });
    const validated = await t.ready();
    await t.db.run("UPDATE properties SET kind = 'business' WHERE id = ?", [t.p.id]);
    expect(await t.pubs.validate(t.alexV, prep.value.id)).toEqual({ ok: false, rule: 'R110', code: 'commerce_discret' });
    expect(await t.pubs.publish(t.alexV, validated, [{ channel: 'instagram', account: 'agent' }])).toEqual({ ok: false, rule: 'R110', code: 'commerce_discret' });
    expect(t.received).toEqual([]);
    expect(await t.db.all('SELECT post_id FROM social_post_attempts')).toEqual([]);
    const after = await t.pubs.read(t.alexV, prep.value.id);
    expect(after).toMatchObject({ ok: true, value: { validated: null } });
  });
});

// AU036 : les vrais réseaux. L'API Graph est simulée ; le jeton est inventé.
const TOKEN = 'jeton-invente-' + 'x'.repeat(24);
const ACCOUNT = { pageId: '111', igUserId: '222', token: TOKEN };

/** Une API Graph simulée : chaque appel est noté ; `fail` rend une erreur de Meta pour un chemin donné. */
function fakeGraph(opts: { fail?: Record<string, { status: number; code: number | null }>; noPermalink?: boolean; down?: string[]; unserved?: string[]; deleteFail?: { status: number; code: number }; absent?: boolean } = {}) {
  const calls: { method: string; path: string; params: Record<string, string> }[] = [];
  let n = 0;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    // Les photos, lues à leur adresse publique avant l'envoi : servies, sauf celles que `unserved` retient.
    if (url.hostname !== 'graph.facebook.com') return new Response(null, { status: opts.unserved?.some((u) => url.pathname.endsWith(u)) ? 404 : 200, headers: { 'content-type': 'image/jpeg' } });
    const params = Object.fromEntries(method !== 'POST' ? url.searchParams : new URLSearchParams(String(init?.body ?? '')));
    const path = url.pathname.replace(/^\/v[0-9.]+\//, '');
    calls.push({ method, path, params });
    if (opts.down?.some((d) => path.endsWith(d))) throw new TypeError('réseau coupé');
    const failing = Object.entries(opts.fail ?? {}).find(([k]) => path.endsWith(k));
    if (failing) return new Response(failing[1].code === null ? 'panne' : JSON.stringify({ error: { message: 'texte du réseau à ne jamais garder', code: failing[1].code } }), { status: failing[1].status });
    if (method === 'DELETE') return opts.deleteFail ? new Response(JSON.stringify({ error: { code: opts.deleteFail.code } }), { status: opts.deleteFail.status }) : Response.json({ success: true });
    if (method === 'GET' && params.fields === 'id') return opts.absent ? new Response(JSON.stringify({ error: { code: 100, error_subcode: 33 } }), { status: 400 }) : Response.json({ id: path });
    if (method === 'GET') {
      if (opts.noPermalink) return new Response('{}', { status: 500 });
      const field = params.fields!;
      const host = field === 'permalink' ? 'www.instagram.com' : 'www.facebook.com';
      return Response.json({ [field]: `https://${host}/p/${path}` });
    }
    if (path.endsWith('/feed')) return Response.json({ id: `111_${++n}` });
    return Response.json({ id: String(9000 + ++n) });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

const mediaUrl = (ref: string) => `https://reseau.exemple.test/medias/${ref}`;

describeWithSqlite('AU036 · une publication validée part vraiment sur les comptes choisis', () => {
  const both = [
    { channel: 'facebook', account: 'reseau', mode: 'reel' },
    { channel: 'instagram', account: 'reseau', mode: 'reel' },
  ];

  it('[R134] le constat : validée et envoyée, la publication est faite chez Facebook et Instagram, avec son vrai lien', async () => {
    const g = fakeGraph();
    const links: unknown[][] = [];
    const t = await setup({
      live: () => metaSocialChannels({ network: ACCOUNT, mediaUrl, http: g.fetch }),
      origin: { studioLink: async () => ({ contentId: 'codecontenu1', link: 'https://reseau.exemple.test/biens/x?o=codecontenu1' }), linkPost: async (...a) => (links.push(a), { ok: true }) },
    });
    const id = await t.ready();
    const r = await t.pubs.publish(t.alexV, id, both);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sends).toEqual([
      { channel: 'facebook', account: 'reseau', mode: 'reel', outcome: 'envoye', url: 'https://www.facebook.com/p/111_3', code: null, action: null },
      { channel: 'instagram', account: 'reseau', mode: 'reel', outcome: 'envoye', url: 'https://www.instagram.com/p/9007', code: null, action: null },
    ]);
    // Facebook : deux photos rangées sans être publiées, puis un message qui les porte, le lien marqué à la fin.
    const fb = g.calls.filter((c) => c.method === 'POST' && c.path.startsWith('111'));
    expect(fb.map((c) => [c.method, c.path])).toEqual([
      ['POST', '111/photos'],
      ['POST', '111/photos'],
      ['POST', '111/feed'],
    ]);
    expect(fb[0]!.params).toMatchObject({ url: mediaUrl(photo(t.p.id, 1)), published: 'false' });
    expect(fb[2]!.params['attached_media[0]']).toBe(JSON.stringify({ media_fbid: '9001' }));
    expect(fb[2]!.params['attached_media[1]']).toBe(JSON.stringify({ media_fbid: '9002' }));
    expect(fb[2]!.params.message!.endsWith('\n\nImage n° 2 : aménagement virtuel.\n\nhttps://reseau.exemple.test/biens/x?o=codecontenu1')).toBe(true);
    expect(fb[2]!.params.message!.startsWith('Nouveau bien à découvrir.')).toBe(true);
    // Instagram : un carrousel de deux photos, puis sa publication ; le lien, qui n'y serait pas cliquable, n'y est pas.
    const ig = g.calls.filter((c) => c.method === 'POST' && c.path.startsWith('222'));
    expect(ig.map((c) => c.path)).toEqual(['222/media', '222/media', '222/media', '222/media_publish']);
    expect(ig[0]!.params).toMatchObject({ is_carousel_item: 'true', image_url: mediaUrl(photo(t.p.id, 1)) });
    expect(ig[2]!.params).toMatchObject({ media_type: 'CAROUSEL', children: '9004,9005' });
    expect(ig[2]!.params.caption).not.toMatch(/https?:/);
    expect(ig[3]!.params.creation_id).toBe('9006');
    // Le lien public est relu chez le réseau, pas deviné.
    expect(g.calls.filter((c) => c.method === 'GET').map((c) => [c.path, c.params.fields])).toEqual([
      ['111_3', 'permalink_url'],
      ['9007', 'permalink'],
    ]);
    // La référence de chaque réseau relie la publication à son contenu (AT18).
    expect(links.map((l) => l[2])).toEqual(['facebook', 'instagram']);
    // Une fois faite, elle ne se refait jamais.
    const before = g.calls.length;
    expect(await t.pubs.publish(t.alexV, id, both)).toMatchObject({ ok: true, value: { sends: [{ outcome: 'envoye' }, { outcome: 'envoye' }] } });
    expect(g.calls.length).toBe(before);
  });

  it('[R134] une vraie publication exige sa confirmation par cible ; un mode qui a changé depuis l’écran refuse tout', async () => {
    const g = fakeGraph();
    const t = await setup({ live: () => metaSocialChannels({ network: ACCOUNT, mediaUrl, http: g.fetch }) });
    const id = await t.ready();
    expect(await t.pubs.publish(t.alexV, id, [{ channel: 'facebook', account: 'reseau' }])).toEqual({ ok: false, rule: 'R134', code: 'reel_non_confirme' });
    expect(await t.pubs.publish(t.alexV, id, [{ channel: 'facebook', account: 'reseau', mode: 'essai' }])).toEqual({ ok: false, rule: 'R134', code: 'mode_change' });
    // Un réseau d'essai annoncé réel : l'écran n'est plus à jour, rien ne part, même pas la cible réelle.
    expect(await t.pubs.publish(t.alexV, id, [{ channel: 'facebook', account: 'reseau', mode: 'reel' }, { channel: 'linkedin', account: 'agent', mode: 'reel' }])).toEqual({ ok: false, rule: 'R134', code: 'mode_change' });
    expect(await t.pubs.publish(t.alexV, id, [{ channel: 'facebook', account: 'reseau', mode: 'direct' }])).toEqual({ ok: false, rule: 'R10', code: 'cibles_invalides' });
    expect(g.calls).toEqual([]);
    expect(await t.pubs.publish(t.alexV, id, [{ channel: 'facebook', account: 'reseau', mode: 'reel' }, { channel: 'linkedin', account: 'agent', mode: 'essai' }])).toMatchObject({ ok: true, value: { sends: [{ channel: 'facebook', mode: 'reel', outcome: 'envoye' }, { channel: 'linkedin', mode: 'essai', outcome: 'envoye' }] } });
  });

  it('[R13] ni le jeton, ni le texte, ni la réponse du réseau au journal ou en base ; le mode réel est dit', async () => {
    const g = fakeGraph({ fail: { '222/media': { status: 400, code: 100 } } });
    const t = await setup({ live: () => metaSocialChannels({ network: ACCOUNT, mediaUrl, http: g.fetch }) });
    const id = await t.ready();
    await t.pubs.publish(t.alexV, id, both);
    const ev = await t.db.all<{ data: string }>("SELECT data FROM journal WHERE type = 'studio.publication.envoi'");
    expect(ev.map((e) => JSON.parse(e.data))).toEqual([
      { post: id, channel: 'facebook', account: 'reseau', mode: 'reel', outcome: 'envoye', rule: 'R134' },
      { post: id, channel: 'instagram', account: 'reseau', mode: 'reel', outcome: 'echec', code: 'contenu_refuse', action: 'corriger', rule: 'R134' },
    ]);
    const dump = JSON.stringify([await t.db.all('SELECT * FROM journal'), await t.db.all('SELECT * FROM social_live_sends'), await t.db.all('SELECT * FROM social_live_attempts')]);
    expect(dump).not.toContain(TOKEN);
    expect(dump).not.toContain('texte du réseau');
    expect(dump).not.toContain('Nouveau bien à découvrir');
    // Le jeton ne part que vers l'API Graph de Meta.
    expect(g.calls.every((c) => c.params.access_token === TOKEN)).toBe(true);
  });

  it('[R134] un échec dit ce que l’agent peut faire ; réessayer ou reconnecter repart au geste suivant, corriger jamais', async () => {
    const fail: Record<string, { status: number; code: number }> = { '111/photos': { status: 400, code: 190 }, '222/media': { status: 400, code: 100 } };
    const g = fakeGraph({ fail });
    const t = await setup({ live: () => metaSocialChannels({ network: ACCOUNT, mediaUrl, http: g.fetch }) });
    const id = await t.ready();
    expect(await t.pubs.publish(t.alexV, id, both)).toMatchObject({
      ok: true,
      value: {
        sends: [
          { channel: 'facebook', mode: 'reel', outcome: 'echec', url: null, code: 'jeton_expire', action: 'reconnecter' },
          { channel: 'instagram', mode: 'reel', outcome: 'echec', url: null, code: 'contenu_refuse', action: 'corriger' },
        ],
      },
    });
    // Le jeton est reconnecté chez Meta ; le contenu refusé ne repart pas tel quel.
    delete fail['111/photos'];
    delete fail['222/media'];
    const before = g.calls.filter((c) => c.path.startsWith('222')).length;
    expect(await t.pubs.publish(t.alexV, id, both)).toMatchObject({
      ok: true,
      value: { sends: [{ channel: 'facebook', outcome: 'envoye', code: null, action: null }, { channel: 'instagram', outcome: 'echec', code: 'contenu_refuse', action: 'corriger' }] },
    });
    expect(g.calls.filter((c) => c.path.startsWith('222')).length).toBe(before);
  });

  it('[R134] une panne du réseau ou une limite atteinte se réessaie ; un compte d’agent pas encore relié le dit, sans appel', async () => {
    const fail: Record<string, { status: number; code: number }> = { '111/photos': { status: 503, code: 2 }, '222/media': { status: 400, code: 4 } };
    const g = fakeGraph({ fail });
    const t = await setup({ live: () => metaSocialChannels({ network: ACCOUNT, mediaUrl, http: g.fetch }) });
    const id = await t.ready();
    const r = await t.pubs.publish(t.alexV, id, [...both, { channel: 'facebook', account: 'agent', mode: 'reel' }]);
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    expect(r.value.sends.map((x) => [x.channel, x.account, x.outcome, x.code, x.action])).toEqual([
      ['facebook', 'agent', 'echec', 'compte_non_relie', 'relier'],
      ['facebook', 'reseau', 'echec', 'reseau_indisponible', 'reessayer'],
      ['instagram', 'reseau', 'echec', 'limite_atteinte', 'reessayer'],
    ]);
    expect(g.calls.some((c) => c.params.message !== undefined)).toBe(false);
    delete fail['111/photos'];
    delete fail['222/media'];
    const again = await t.pubs.publish(t.alexV, id, both);
    expect(again.ok && again.value.sends.map((x) => [x.channel, x.account, x.outcome])).toEqual([
      ['facebook', 'agent', 'echec'],
      ['facebook', 'reseau', 'envoye'],
      ['instagram', 'reseau', 'envoye'],
    ]);
  });

  it('une photo sans adresse publique n’est pas envoyée ; un lien qui ne se relit pas laisse la publication faite, sans lien', async () => {
    const g = fakeGraph({ noPermalink: true });
    const t = await setup({ live: () => metaSocialChannels({ network: ACCOUNT, mediaUrl: (ref) => (ref.endsWith('2-0000-4000-8000-000000000000.jpg') ? null : mediaUrl(ref)), http: g.fetch }) });
    const id = await t.ready();
    expect(await t.pubs.publish(t.alexV, id, [{ channel: 'facebook', account: 'reseau', mode: 'reel' }])).toMatchObject({ ok: true, value: { sends: [{ outcome: 'echec', code: 'visuel_sans_adresse', action: 'corriger' }] } });
    expect(g.calls).toEqual([]);
    const t2 = await setup({ live: () => metaSocialChannels({ network: ACCOUNT, mediaUrl, http: g.fetch }) });
    const id2 = await t2.ready();
    expect(await t2.pubs.publish(t2.alexV, id2, [{ channel: 'facebook', account: 'reseau', mode: 'reel' }])).toMatchObject({ ok: true, value: { sends: [{ outcome: 'envoye', url: null, code: null }] } });
    // Une photo que le site ne sert pas encore : rien n'est envoyé à Meta, à réessayer quand elle sera servie.
    const g3 = fakeGraph({ unserved: ['2-0000-4000-8000-000000000000.jpg'] });
    const t3 = await setup({ live: () => metaSocialChannels({ network: ACCOUNT, mediaUrl, http: g3.fetch }) });
    const id3 = await t3.ready();
    expect(await t3.pubs.publish(t3.alexV, id3, both)).toMatchObject({ ok: true, value: { sends: [{ outcome: 'echec', code: 'visuel_non_servi', action: 'reessayer' }, { outcome: 'echec', code: 'visuel_non_servi', action: 'reessayer' }] } });
    expect(g3.calls).toEqual([]);
  });

  it('[R134] un envoi réel sans issue rangée n’est jamais doublé : en cours, puis à vérifier ; sans référence, à vérifier aussi', async () => {
    let calls = 0;
    let hang = true;
    const t = await setup({
      live: () => [
        { channel: 'facebook', mode: 'reel', post: async () => (calls++, hang ? new Promise<never>(() => {}) : { postRef: '1' }), remove: async () => {} },
        { channel: 'instagram', mode: 'reel', post: async () => (calls++, undefined), remove: async () => {} },
      ],
    });
    const id = await t.ready();
    const first = t.pubs.publish(t.alexV, id, [{ channel: 'facebook', account: 'reseau', mode: 'reel' }]);
    await new Promise((r) => setTimeout(r, 50));
    hang = false;
    expect(await t.pubs.publish(t.alexV, id, [{ channel: 'facebook', account: 'reseau', mode: 'reel' }])).toMatchObject({ ok: true, value: { sends: [{ outcome: 'en_cours' }] } });
    t.setClock('2027-10-10T09:00:00.000Z');
    expect(await t.pubs.publish(t.alexV, id, [{ channel: 'facebook', account: 'reseau', mode: 'reel' }])).toMatchObject({ ok: true, value: { sends: [{ outcome: 'a_verifier' }] } });
    expect(calls).toBe(1);
    void first;
    // Un canal réel accepté sans référence lisible a pu publier : à vérifier, jamais refait.
    expect(await t.pubs.publish(t.alexV, id, [{ channel: 'instagram', account: 'reseau', mode: 'reel' }])).toMatchObject({ ok: true, value: { sends: [{ outcome: 'a_verifier' }, { channel: 'instagram', outcome: 'a_verifier', code: 'reponse_illisible', action: 'verifier' }] } });
    expect(await t.pubs.publish(t.alexV, id, [{ channel: 'instagram', account: 'reseau', mode: 'reel' }])).toMatchObject({ ok: true });
    expect(calls).toBe(2);
  });

  it('[R26] un essai réussi avant la mise en service n’empêche pas la vraie publication de la même cible', async () => {
    const g = fakeGraph();
    const t = await setup();
    const id = await t.ready();
    await t.db.run("UPDATE properties SET status = 'available' WHERE id = ?", [t.p.id]);
    const trial = await t.pubs.publish(t.alexV, id, [{ channel: 'instagram', account: 'agent' }]);
    expect(trial).toMatchObject({ ok: true, value: { sends: [{ channel: 'instagram', mode: 'essai', outcome: 'envoye' }] } });
    // Même base, nouvelle classe mise en service : la cible du réseau part pour de vrai.
    const live = new Publications(t.db, (t.pubs as unknown as { acces: never }).acces, t.journal, { ...(t.pubs as unknown as { deps: ConstructorParameters<typeof Publications>[3] }).deps, channels: metaSocialChannels({ network: ACCOUNT, mediaUrl, http: g.fetch }) }, { live: true });
    const r = await live.publish(t.alexV, id, [{ channel: 'instagram', account: 'reseau', mode: 'reel' }, { channel: 'instagram', account: 'agent', mode: 'reel' }]);
    expect(r.ok && r.value.sends.map((x) => [x.account, x.mode, x.outcome, x.code])).toEqual([
      ['agent', 'reel', 'echec', 'compte_non_relie'],
      ['reseau', 'reel', 'envoye', null],
    ]);
  });
  it('[R134] la réponse perdue de l’appel qui publie : à vérifier, jamais refaite ; une panne avant lui se réessaie', async () => {
    const g = fakeGraph({ down: ['111/feed'], fail: { media_publish: { status: 502, code: null } } });
    const t = await setup({ live: () => metaSocialChannels({ network: ACCOUNT, mediaUrl, http: g.fetch }) });
    const id = await t.ready();
    expect(await t.pubs.publish(t.alexV, id, both)).toMatchObject({
      ok: true,
      value: {
        sends: [
          { channel: 'facebook', outcome: 'a_verifier', code: 'issue_inconnue', action: 'verifier', url: null },
          { channel: 'instagram', outcome: 'a_verifier', code: 'issue_inconnue', action: 'verifier', url: null },
        ],
      },
    });
    const before = g.calls.length;
    expect(await t.pubs.publish(t.alexV, id, both)).toMatchObject({ ok: true, value: { sends: [{ outcome: 'a_verifier' }, { outcome: 'a_verifier' }] } });
    expect(g.calls.length).toBe(before);
    // Un refus clair de Meta à l'appel qui publie dit que rien n'est fait : réessayable.
    const g2 = fakeGraph({ fail: { '111/feed': { status: 400, code: 4 } } });
    const t2 = await setup({ live: () => metaSocialChannels({ network: ACCOUNT, mediaUrl, http: g2.fetch }) });
    const id2 = await t2.ready();
    expect(await t2.pubs.publish(t2.alexV, id2, [both[0]])).toMatchObject({ ok: true, value: { sends: [{ outcome: 'echec', code: 'limite_atteinte', action: 'reessayer' }] } });
  });

  it('[R42] le bien ne peut plus être diffusé : chaque vraie publication est retirée chez le réseau, une fois ; une panne reste due', async () => {
    const g = fakeGraph();
    const t = await setup({ live: () => metaSocialChannels({ network: ACCOUNT, mediaUrl, http: g.fetch }) });
    const id = await t.ready();
    await t.pubs.publish(t.alexV, id, both);
    // Porte ouverte : rien n'est retiré.
    expect(await t.pubs.withdrawLive(t.network.id, t.p.id)).toEqual({ removed: [], failed: [], toVerify: [] });
    expect(g.calls.some((c) => c.method === 'DELETE')).toBe(false);
    t.state.diffusable = false;
    // Facebook en panne au premier retrait : il reste dû et le passage planifié le reprend.
    const flaky = fakeGraph({ fail: { '111_3': { status: 503, code: 2 } } });
    const pubs2 = new Publications(t.db, (t.pubs as unknown as { acces: never }).acces, t.journal, { ...(t.pubs as unknown as { deps: ConstructorParameters<typeof Publications>[3] }).deps, channels: metaSocialChannels({ network: ACCOUNT, mediaUrl, http: flaky.fetch }) }, { live: true });
    expect(await pubs2.withdrawLive(t.network.id, t.p.id, 'agent:x')).toEqual({ removed: [{ channel: 'instagram', account: 'reseau' }], failed: [{ channel: 'facebook', account: 'reseau', code: 'reseau_indisponible' }], toVerify: [] });
    expect(flaky.calls.filter((c) => c.method === 'DELETE').map((c) => [c.path, c.params.access_token === TOKEN])).toEqual([
      ['111_3', true],
      ['9007', true],
    ]);
    expect(await t.pubs.withdrawAllLive(t.network.id)).toEqual([{ propertyId: t.p.id, result: { removed: [{ channel: 'facebook', account: 'reseau' }], failed: [], toVerify: [] } }]);
    expect(await t.pubs.withdrawAllLive(t.network.id)).toEqual([]);
    const view = await t.pubs.read(t.alexV, id);
    expect(view.ok && view.value.sends.map((x) => [x.channel, x.outcome, x.url])).toEqual([
      ['facebook', 'retiree', null],
      ['instagram', 'retiree', null],
    ]);
    // Au journal : l'issue et la règle, jamais le jeton ni la référence.
    const ev = await t.db.all<{ data: string }>("SELECT data FROM journal WHERE type = 'studio.publication.retrait'");
    expect(ev.map((e) => JSON.parse(e.data)).map((d) => [d.channel, d.outcome, d.rule])).toEqual([
      ['facebook', 'echec', 'R42'],
      ['instagram', 'retiree', 'R42'],
      ['facebook', 'retiree', 'R42'],
    ]);
    expect(JSON.stringify(ev)).not.toMatch(/111_3|9007|jeton/);
  });

  it('[R42] seul un succès explicite retire ; un refus ou une publication dite introuvable reste due ; une issue inconnue est à vérifier', async () => {
    {
      // Un refus de retrait (368, blocage temporaire) alors que la publication existe encore : rien n'est tenu pour retiré.
      const g = fakeGraph();
      const t = await setup({ live: () => metaSocialChannels({ network: ACCOUNT, mediaUrl, http: g.fetch }) });
      const id = await t.ready();
      await t.pubs.publish(t.alexV, id, [both[0]]);
      t.state.diffusable = false;
      const blocked = fakeGraph({ deleteFail: { status: 400, code: 368 } });
      const pubs2 = new Publications(t.db, (t.pubs as unknown as { acces: never }).acces, t.journal, { ...(t.pubs as unknown as { deps: ConstructorParameters<typeof Publications>[3] }).deps, channels: metaSocialChannels({ network: ACCOUNT, mediaUrl, http: blocked.fetch }) }, { live: true });
      expect(await pubs2.withdrawLive(t.network.id, t.p.id)).toEqual({ removed: [], failed: [{ channel: 'facebook', account: 'reseau', code: 'contenu_refuse' }], toVerify: [] });
      expect(await pubs2.withdrawAllLive(t.network.id)).toHaveLength(1);
    }
    const g = fakeGraph({ down: ['media_publish'] });
    const t = await setup({ live: () => metaSocialChannels({ network: ACCOUNT, mediaUrl, http: g.fetch }) });
    const id = await t.ready();
    await t.pubs.publish(t.alexV, id, both);
    t.state.diffusable = false;
    const gone = fakeGraph({ deleteFail: { status: 400, code: 100 }, absent: true });
    const pubs2 = new Publications(t.db, (t.pubs as unknown as { acces: never }).acces, t.journal, { ...(t.pubs as unknown as { deps: ConstructorParameters<typeof Publications>[3] }).deps, channels: metaSocialChannels({ network: ACCOUNT, mediaUrl, http: gone.fetch }) }, { live: true });
    // « Introuvable » couvre aussi des droits perdus : rien n'est tenu pour retiré sans un succès explicite.
    expect(await pubs2.withdrawLive(t.network.id, t.p.id)).toEqual({ removed: [], failed: [{ channel: 'facebook', account: 'reseau', code: 'contenu_refuse' }], toVerify: [{ channel: 'instagram', account: 'reseau' }] });
  });
});

describe('AU036 · les codes de Meta et la légende', () => {
  it('chaque erreur de l’API Graph devient un code fermé et une action', () => {
    const cases: [number, number | null, string, string][] = [
      [400, 190, 'jeton_expire', 'reconnecter'],
      [403, 10, 'droits_manquants', 'reconnecter'],
      [403, 200, 'droits_manquants', 'reconnecter'],
      [400, 4, 'limite_atteinte', 'reessayer'],
      [429, null, 'limite_atteinte', 'reessayer'],
      [400, 368, 'contenu_refuse', 'corriger'],
      [400, 100, 'contenu_refuse', 'corriger'],
      [500, 2, 'reseau_indisponible', 'reessayer'],
      [502, null, 'reseau_indisponible', 'reessayer'],
      [400, 12345, 'erreur_reseau', 'reessayer'],
    ];
    for (const [status, code, want, action] of cases) {
      const e = metaError(status, code === null ? 'pas du json' : { error: { code, message: 'secret' } });
      expect(e).toBeInstanceOf(SocialSendError);
      expect([e.code, e.action, e.message]).toEqual([want, action, want]);
    }
  });

  it('la légende redit les images aménagées ; le lien seulement là où il est cliquable', () => {
    const payload: SocialPayload = {
      postId: 'p',
      account: 'reseau',
      text: 'Nouveau bien à découvrir.',
      visuals: [
        { ref: 'a', overlay: null, certificatePath: '/c/a' },
        { ref: 'b', overlay: 'Aménagement virtuel', certificatePath: '/c/b' },
        { ref: 'c', overlay: 'Aménagement virtuel', certificatePath: '/c/c' },
      ],
      link: 'https://reseau.exemple.test/biens/x',
    };
    expect(caption(payload, true)).toBe('Nouveau bien à découvrir.\n\nImages n° 2, 3 : aménagement virtuel.\n\nhttps://reseau.exemple.test/biens/x');
    expect(caption({ ...payload, visuals: [payload.visuals[0]!] }, false)).toBe('Nouveau bien à découvrir.');
  });

  it('un compte Meta incomplet ne fait aucun canal ; un réseau injoignable se réessaie', async () => {
    expect(() => metaSocialChannels({ network: { ...ACCOUNT, token: ' ' }, mediaUrl, http: fetch })).toThrow(/incomplet/);
    expect(() => metaSocialChannels({ network: { ...ACCOUNT, pageId: 'page' }, mediaUrl, http: fetch })).toThrow(/incomplet/);
    const [fb] = metaSocialChannels({ network: ACCOUNT, mediaUrl, http: (async (input: string | URL | Request) => { if (new URL(String(input)).hostname !== 'graph.facebook.com') return new Response(null, { status: 200, headers: { 'content-type': 'image/jpeg' } }); throw new TypeError('réseau'); }) as typeof fetch });
    await expect(fb!.post({ postId: 'p', account: 'reseau', text: 't', visuals: [{ ref: 'a', overlay: null, certificatePath: '/c' }], link: null })).rejects.toMatchObject({ code: 'reseau_indisponible', action: 'reessayer' });
  });
});
