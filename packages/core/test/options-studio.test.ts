import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { Annuaire, MiseEnRelation, type ConsentProofStore, type PartnerProofStore } from '../src/partenaires/index.ts';
import { MEASURE_SIZE, OPTION_TRADE, OptionsStudio, STUDIO_OPTIONS } from '../src/studio/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, agents, clients, partenaires et preuves inventés.
let clock = Date.parse('2027-10-12T08:00:00.000Z');
const DAY = 86_400_000;
let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

class FakeStore implements PartnerProofStore, ConsentProofStore {
  readonly refs = new Set<string>();
  put(prefix: string): string {
    const ref = `${prefix}/${uuid()}.pdf`;
    this.refs.add(ref);
    return ref;
  }
  async has(ref: string): Promise<boolean> {
    return this.refs.has(ref);
  }
}

it('chaque option du Studio est rendue par un métier existant de M18 : rien de neuf', () => {
  expect(Object.keys(STUDIO_OPTIONS)).toEqual(['photographe', 'drone', 'visite_virtuelle', 'amenagement_virtuel']);
  expect(new Set(Object.values(OPTION_TRADE))).toEqual(new Set(['photographe']));
  expect(MEASURE_SIZE).toBe(20);
});

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const files = new FakeStore();
  const annuaire = new Annuaire(db, files, journal, { now, newId: uuid });
  const relations = new MiseEnRelation(db, annuaire, files, journal, { now, newId: uuid, newSeed: () => 7 });
  const options = new OptionsStudio(db, journal, relations, { now, newId: uuid });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Essai' });
  const bea = await store.createAgent({ networkId: network.id, firstName: 'Béa', lastName: 'Essai' });
  const person = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Client', lastName: 'Inventé' });
  const project = await store.createProject({ networkId: network.id, agentId: alex.id, personId: person.id, kind: 'sell' });
  const property = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'T-1', kind: 'home', postalCode: '21000' });
  await store.linkProjectProperty({ networkId: network.id, agentId: alex.id, projectId: project.id, propertyId: property.id, role: 'owned' });
  const dir = { role: 'direction' as const, userId: 'dir-1', networkId: network.id };
  const agent = { role: 'agent' as const, userId: alex.id, networkId: network.id };
  const day = (d = 0): string => new Date(clock + d * DAY).toISOString().slice(0, 10);
  const photographer = async (name: string): Promise<string> => {
    const r = await annuaire.addPartner(dir, { trade: 'photographe', businessName: name, postcodes: ['21000'] });
    if (!r.ok) throw new Error(r.code);
    await annuaire.addCredential(dir, r.value.partnerId, { kind: 'assurance_rcp', number: 'N-1', validFrom: day(-30), validUntil: day(300), proofRef: files.put(`partenaires/${r.value.partnerId}`) });
    return r.value.partnerId;
  };
  return { db, files, relations, options, network, alex, bea, project, property, dir, agent, photographer };
}

describeWithSqlite('X08 · options payantes et mesure des visuels', () => {
  it('[R74] [R75] une option passe par la mise en relation de M18 : partenaires tirés au sort, rien de confié sans l’accord du client', async () => {
    const t = await setup();
    await t.photographer('Studio A');
    await t.photographer('Studio B');
    const r = await t.options.requestOption(t.agent, { projectId: t.project.id, propertyId: t.property.id, option: 'drone' });
    expect(r).toMatchObject({ ok: true, value: { option: 'drone', referral: { trade: 'photographe', state: 'proposee', propertyId: t.property.id } } });
    if (!r.ok) return;
    expect(r.value.referral.shown.length).toBe(2);
    // Sans l'accord du client, rien n'est confié : c'est la règle de M18 qui tient.
    expect(await t.relations.entrust(t.agent, r.value.referral.referralId)).toMatchObject({ ok: false, rule: 'R74' });
    const consent = await t.relations.recordConsent(t.agent, r.value.referral.referralId, {
      partnerId: r.value.referral.shown[0]!.partnerId,
      consentAt: new Date(clock - 500).toISOString(),
      channel: 'oral',
      proofRef: t.files.put(`relations/${r.value.referral.referralId}`),
    });
    expect(consent.ok).toBe(true);
    expect(await t.relations.entrust(t.agent, r.value.referral.referralId)).toMatchObject({ ok: true, value: { state: 'confiee' } });
    expect(await t.db.all('SELECT option FROM studio_option_requests')).toEqual([{ option: 'drone' }]);
    await expect(t.db.run('DELETE FROM studio_option_requests')).rejects.toThrow(/rien ne s'efface/);
  });

  it('[R16] [R73] une option inconnue, un autre agent, ou aucun photographe proposable : refusé, rien de rangé', async () => {
    const t = await setup();
    expect(await t.options.requestOption(t.agent, { projectId: t.project.id, propertyId: t.property.id, option: 'helicoptere' })).toEqual({ ok: false, rule: 'R10', code: 'option_inconnue' });
    expect(await t.options.requestOption(t.agent, { projectId: t.project.id, propertyId: t.property.id, option: 'photographe' })).toMatchObject({ ok: false, rule: 'R73', code: 'no_partner' });
    await t.photographer('Studio A');
    expect(await t.options.requestOption({ ...t.agent, userId: t.bea.id }, { projectId: t.project.id, propertyId: t.property.id, option: 'photographe' })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.options.requestOption(t.agent, { projectId: t.project.id, propertyId: 'autre-bien', option: 'photographe' })).toMatchObject({ ok: false, code: 'bad_property' });
    expect(await t.db.all('SELECT id FROM studio_option_requests')).toEqual([]);
  });

  it('[R132] la mesure compte les 20 derniers visuels publiés et dit chacun sans adresse visible, ou le nomme', async () => {
    const t = await setup();
    const prop = t.property.id;
    let k = 0;
    // Une publication envoyée, avec ses visuels et leurs listes de contrôle ; inventée directement en base.
    const post = async (visuals: { ref: string; check: 'ok' | 'adresse' | 'refuse' | null }[], sent: boolean) => {
      const id = `post-${++k}`;
      const at = new Date(Date.parse('2027-10-01T08:00:00Z') + k * 60_000).toISOString();
      await t.db.run("INSERT INTO social_posts (id, property_id, network_id, event, text, origin, visuals, created_by, created_at) VALUES (?, ?, ?, 'nouveau_bien', 'Nouveau bien à découvrir.', 'secours', ?, 'agent:a', ?)", [
        id,
        prop,
        t.network.id,
        JSON.stringify(visuals.map((v) => ({ ref: v.ref, overlay: null, certificatePath: '/certificat-photo/x' }))),
        at,
      ]);
      for (const v of visuals) {
        if (v.check === null) continue;
        await t.db.run("INSERT INTO social_visual_checks (id, post_id, media_ref, address_visible, person_visible, consent_ref, staging_label_visible, outcome, checked_by, checked_at) VALUES (?, ?, ?, ?, 0, NULL, NULL, ?, 'agent:a', ?)", [
          `${id}-${v.ref}`,
          id,
          v.ref,
          v.check === 'adresse' ? 1 : 0,
          v.check === 'ok' ? 'admis' : 'refuse',
          at,
        ]);
      }
      await t.db.run("INSERT INTO social_post_attempts (id, post_id, channel, account, attempt, mode, claimed_by, claimed_at) VALUES (?, ?, 'instagram', 'agent', 0, 'essai', 'agent:a', ?)", [`${id}-a`, id, at]);
      if (sent) await t.db.run("INSERT INTO social_post_sends (attempt_id, outcome, done_at) VALUES (?, 'envoye', ?)", [`${id}-a`, at]);
    };
    expect(await t.options.measureVisuals(t.agent)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    // Neuf publications de deux visuels sains : 18, pas encore 20.
    for (let i = 0; i < 9; i += 1) await post([{ ref: `v${i}a`, check: 'ok' }, { ref: `v${i}b`, check: 'ok' }], true);
    const partial = await t.options.measureVisuals(t.dir);
    expect(partial).toMatchObject({ ok: true, value: { counted: 18, complete: false, passed: false, named: [] } });
    // Une publication jamais partie ne compte pas.
    await post([{ ref: 'jamais', check: 'adresse' }], false);
    // Deux visuels de plus : 20, tous sains.
    await post([{ ref: 'w1', check: 'ok' }, { ref: 'w2', check: 'ok' }], true);
    const full = await t.options.measureVisuals(t.dir);
    expect(full).toMatchObject({ ok: true, value: { counted: 20, complete: true, passed: true, named: [] } });
    if (!full.ok) return;
    expect(full.value.lines.every((l) => l.verdict === 'sans_adresse_visible')).toBe(true);
    expect(full.value.lines.map((l) => l.mediaRef)).not.toContain('jamais');
    // Les derniers publiés passent devant ; un visuel sans liste, ou à l'adresse visible, est nommé.
    await post([{ ref: 'x1', check: null }, { ref: 'x2', check: 'adresse' }, { ref: 'x3', check: 'refuse' }], true);
    const last = await t.options.measureVisuals(t.dir);
    expect(last).toMatchObject({ ok: true, value: { counted: 20, complete: true, passed: false } });
    if (!last.ok) return;
    expect(last.value.named.map((l) => [l.mediaRef, l.verdict])).toEqual([
      ['x1', 'liste_absente'],
      ['x2', 'adresse_visible'],
      ['x3', 'liste_refusee'],
    ]);
    expect(last.value.lines.slice(0, 5).map((l) => l.mediaRef)).toEqual(['x1', 'x2', 'x3', 'w1', 'w2']);
  });
});
