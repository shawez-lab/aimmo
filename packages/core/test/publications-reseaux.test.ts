import { describe, expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, SqlJournalStore, annonces, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { EVENT_HEADLINES, Publications, trialSocialChannel, type CertifiedPhoto, type SocialChannel, type SocialPayload, type SocialWriter } from '../src/studio/index.ts';
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

it('[R26] [R134] un canal réel est refusé : seul le mode essai est en service', () => {
  const real = { channel: 'instagram', mode: 'reel', post: async () => {} } as unknown as SocialChannel;
  expect(() => new Publications({} as SqlDatabase, {} as never, {} as never, { facts: {} as never, certs: {} as never, diffusion: {} as never, mentions: {} as never, consents: {} as never, channels: [real] })).toThrow(/mode essai/);
});

// Les mentions telles que M07 les calcule, inventées.
const MENTIONS = 'Prix : 230 000 € honoraires inclus, dont 4,55 % TTC à la charge de l’acquéreur.\nClasse énergie C, classe climat C.\nCarte professionnelle n° CPI 0000 0000 000 000 000.';

const photo = (p: string, n: number) => `biens/${p}/0000000${n}-0000-4000-8000-000000000000.jpg`;
const consent = (p: string, n: number) => `biens/${p}/accords/0000000${n}-0000-4000-8000-0000000000cc.pdf`;

async function setup(opts: { writer?: SocialWriter | null; failing?: string[]; origin?: NonNullable<ConstructorParameters<typeof Publications>[3]['origin']>; postRef?: string } = {}) {
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
    { ref: photo(p.id, 1), overlay: null, certificateToken: 'a'.repeat(32), certificatePath: `/certificat-photo/${'a'.repeat(32)}` },
    { ref: photo(p.id, 2), overlay: 'Aménagement virtuel', certificateToken: 'b'.repeat(32), certificatePath: `/certificat-photo/${'b'.repeat(32)}` },
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
      channels,
      ...(opts.origin ? { origin: opts.origin } : {}),
    },
    { now, writer: opts.writer === undefined ? null : opts.writer, timeoutMs: 50 },
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
    const r = await t.pubs.prepare(t.alexV, t.p.id, { event: 'visite', visuals: [photo(t.p.id, 2)] });
    expect(r).toMatchObject({ ok: true, value: { event: 'visite', origin: 'ia', validated: null, sends: [] } });
    if (!r.ok) return;
    expect(r.value.text.startsWith('Visites en cours pour ce bien.\n\n')).toBe(true);
    expect(r.value.visuals).toEqual([{ ref: photo(t.p.id, 2), overlay: 'Aménagement virtuel', certificatePath: `/certificat-photo/${'b'.repeat(32)}`, check: null }]);
    // Au journal : l'événement et l'origine, jamais le texte.
    const ev = await t.db.all<{ data: string }>("SELECT data FROM journal WHERE type = 'studio.publication.preparee'");
    expect(JSON.parse(ev[0]!.data)).toEqual({ post: r.value.id, event: 'visite', origin: 'ia', visuals: 1 });
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
    t.state.certified = t.state.certified.slice(0, 1);
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
});
