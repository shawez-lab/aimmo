import { describe, expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { AtelierStudio, type AtelierOrigin, type CertifiedPhoto } from '../src/studio/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Tout est inventé : réseau, agents, bien, références de stockage.
const ref = (p: string, n: number) => `biens/${p}/0000000${n}-0000-4000-8000-000000000000.jpg`;

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = Date.parse('2027-10-10T08:00:00.000Z');
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const acces = new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const p = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'AT-1', kind: 'home', city: 'X', priceEur: 200_000, surfaceM2: 70, rooms: 3, status: 'available' });
  const media = [
    { ref: ref(p.id, 1), kind: 'photo', edit: 'aucune' },
    { ref: ref(p.id, 2), kind: 'photo', edit: 'amenagement_virtuel' },
    { ref: `biens/${p.id}/00000009-0000-4000-8000-000000000000.mp4`, kind: 'video', edit: 'aucune' },
  ];
  await db.run("INSERT INTO property_sheets (id, property_id, network_id, version, data, created_by, created_at) VALUES ('s-1', ?, ?, 1, ?, 'agent:a', '2027-10-01')", [p.id, network.id, JSON.stringify({ media })]);
  const certified: CertifiedPhoto[] = [{ ref: ref(p.id, 2), overlay: 'Aménagement virtuel', certificateToken: 'b'.repeat(32), certificatePath: `/certificat-photo/${'b'.repeat(32)}` }];
  const atelier = new AtelierStudio(db, acces, journal, { publishable: async () => certified }, { now });
  const post = async (id: string, at: string, validated: boolean) => {
    await db.run("INSERT INTO social_posts (id, property_id, network_id, event, text, origin, visuals, created_by, created_at) VALUES (?, ?, ?, 'nouveau_bien', 'Texte de la publication.', 'secours', '[]', 'agent:a', ?)", [id, p.id, network.id, at]);
    if (validated) await db.run("INSERT INTO social_post_validations (post_id, validated_by, validated_at) VALUES (?, 'agent:a', ?)", [id, at]);
  };
  const as = (role: 'agent' | 'direction' | 'compliance', userId: string) => ({ role, userId, networkId: network.id }) as never;
  return { db, acces, journal, atelier, p, alex, sam, network, post, as };
}

describeWithSqlite('X11 · atelier d’un bien dans le Studio', () => {
  it('les photos de la fiche, leur certificat quand elles en ont un, les publications les plus récentes d’abord', async () => {
    const t = await setup();
    await t.post('post-1', '2027-10-01T08:00:00.000Z', true);
    await t.post('post-2', '2027-10-02T08:00:00.000Z', false);
    const r = await t.atelier.read(t.as('agent', t.alex.id), t.p.id);
    expect(r).toEqual({
      ok: true,
      value: {
        propertyId: t.p.id,
        photos: [
          { ref: ref(t.p.id, 1), edit: 'aucune', certificatePath: null, overlay: null },
          { ref: ref(t.p.id, 2), edit: 'amenagement_virtuel', certificatePath: `/certificat-photo/${'b'.repeat(32)}`, overlay: 'Aménagement virtuel' },
        ],
        posts: [
          { id: 'post-2', event: 'nouveau_bien', validated: false, createdAt: '2027-10-02T08:00:00.000Z' },
          { id: 'post-1', event: 'nouveau_bien', validated: true, createdAt: '2027-10-01T08:00:00.000Z' },
        ],
      },
    });
  });

  it('[R16] un autre agent ou la conformité ne lisent rien, et le refus est écrit au journal', async () => {
    const t = await setup();
    const sam = await t.atelier.read(t.as('agent', t.sam.id), t.p.id);
    expect(sam).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.atelier.read(t.as('compliance', 'c1'), t.p.id)).toMatchObject({ ok: false, rule: 'R16' });
    const refused = await t.db.all<{ data: string }>("SELECT data FROM journal WHERE type = 'acces.refuse'");
    expect(refused.map((r) => JSON.parse(r.data).kind)).toContain('studio_atelier');
    expect(refused.map((r) => JSON.parse(r.data).code)).toContain('role');
    // La direction du réseau voit le bien en entier.
    expect(await t.atelier.read(t.as('direction', 'd1'), t.p.id)).toMatchObject({ ok: true });
  });

  it('[R10] une fiche sans liste de médias lisible ferme l’atelier', async () => {
    const t = await setup();
    await t.db.run("INSERT INTO property_sheets (id, property_id, network_id, version, data, created_by, created_at) VALUES ('s-2', ?, ?, 2, ?, 'agent:a', '2027-10-02')", [t.p.id, t.network.id, JSON.stringify({ media: 'x' })]);
    expect(await t.atelier.read(t.as('agent', t.alex.id), t.p.id)).toEqual({ ok: false, rule: 'R10', code: 'fiche_illisible' });
  });

  describe('AT20 · les liens marqués de ce que l’agent poste', () => {
    const CLIP = '33333333-3333-4333-8333-333333333333';
    const withOrigin = async (origin: AtelierOrigin) => {
      const t = await setup();
      const atelier = new AtelierStudio(t.db, t.acces, t.journal, { publishable: async () => [] }, { now: () => new Date('2027-10-15T08:00:00.000Z'), origin });
      await t.db.run("INSERT INTO video_montages (id, property_id, network_id, video_ref, video_sha256, template_sha256, clips_count, duration_s, processed_on, recorded_by, recorded_at) VALUES (?, ?, ?, 'v.mp4', ?, ?, 3, 45, 'appareil', 'x', '2027-10-14T08:00:00.000Z')", [CLIP, t.p.id, t.network.id, 'a'.repeat(64), 'b'.repeat(64)]);
      return { ...t, atelier };
    };
    const fake: AtelierOrigin = { studioLink: async (_n, _k, ref) => ({ contentId: 'code', link: `https://reseau.exemple.test/biens/x?o=${ref.slice(0, 4)}` }) };

    it('[R16] [R156] l’agent du bien lit le lien de ses vidéos et de ses seules publications validées ; personne d’autre', async () => {
      const t = await withOrigin(fake);
      const alex = t.as('agent', t.alex.id);
      const r = await t.atelier.links(alex, t.p.id);
      if (!r.ok) throw new Error(r.code);
      expect(r.value.online).toBe(true);
      expect(r.value.videos).toEqual([{ id: CLIP, durationSeconds: 45, recordedAt: '2027-10-14T08:00:00.000Z', link: 'https://reseau.exemple.test/biens/x?o=3333' }]);
      // Une publication non validée n'a pas de lien ; validée, elle en a un.
      expect(r.value.posts).toEqual([]);
      const POST = '44444444-4444-4444-8444-444444444444';
      await t.post('55555555-5555-4555-8555-555555555555', '2027-10-14T08:00:00.000Z', false);
      await t.post(POST, '2027-10-14T09:00:00.000Z', true);
      const v = await t.atelier.links(alex, t.p.id);
      expect(v.ok && v.value.posts.map((p) => p.id)).toEqual([POST]);
      expect(await t.atelier.links(t.as('agent', t.sam.id), t.p.id)).toMatchObject({ ok: false, rule: 'R16' });
      expect(await t.atelier.links(t.as('compliance', 'c1'), t.p.id)).toMatchObject({ ok: false, rule: 'R16' });
    });

    it('un bien sans page en ligne le dit, sans lien ; sans origine branchée non plus', async () => {
      const t = await withOrigin({ studioLink: async () => ({ contentId: 'code', link: null }) });
      expect(await t.atelier.links(t.as('agent', t.alex.id), t.p.id)).toEqual({ ok: true, value: { online: false, videos: [], posts: [] } });
      const u = await setup();
      expect(await u.atelier.links(u.as('agent', u.alex.id), u.p.id)).toEqual({ ok: true, value: { online: false, videos: [], posts: [] } });
    });

    it('[R13] une panne de l’origine est dite et notée, sans donnée', async () => {
      const t = await withOrigin({ studioLink: async () => { throw new TypeError('panne 06 00 00 00 00'); } });
      expect(await t.atelier.links(t.as('agent', t.alex.id), t.p.id)).toEqual({ ok: false, rule: 'R10', code: 'origine_indisponible' });
      expect((await t.journal.all()).filter((e) => e.type === 'studio.liens.origine_indisponible').map((e) => e.data)).toEqual([{ rule: 'R156', error: 'TypeError' }]);
    });
  });
});
