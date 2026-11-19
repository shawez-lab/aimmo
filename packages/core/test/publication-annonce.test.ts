import { expect, it } from 'vitest';
import { Diffusion, RegistreMandats, type Acces, type SqlDatabase } from '../src/index.ts';
import { Publication, type Channel } from '../src/annonces/index.ts';
import { DELAY_END, FakeChannel, MIN, setupAnnonce as setup } from './annonces-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

const prices = (t: Awaited<ReturnType<typeof setup>>) => t.channels.map((c) => c.received.at(-1)?.priceEur ?? null);

describeWithSqlite('P04 · publication partout, au même prix, en mode essai', () => {
  it('[R42] [R47] rien ne part sans annonce validée ni pendant le délai de rétractation ; publié partout moins d’une heure après sa fin', async () => {
    const t = await setup();
    // Annonce validée pendant le délai : la porte de diffusion dit encore non.
    t.setClock(new Date('2027-02-12T10:00:00.000Z'));
    expect(await t.annonces.validate(t.agent, t.draftId)).toMatchObject({ ok: true });
    expect(await t.runEvery15(new Date('2027-02-24T20:00:00.000Z'), new Date('2027-02-24T22:45:00.000Z'))).toBeNull();
    expect(t.channels.every((c) => c.received.length === 0)).toBe(true);
    // Le passage qui suit la fin du délai publie sur chaque canal.
    const first = await t.runEvery15(DELAY_END, new Date(DELAY_END.getTime() + 60 * MIN));
    expect(first).not.toBeNull();
    expect(first!.getTime() - DELAY_END.getTime()).toBeLessThan(60 * MIN);
    expect(t.channels.map((c) => c.received.length)).toEqual([1, 1, 1, 1]);
    const st = await t.publication.status(t.agent, t.propertyId);
    expect(st.ok && st.value).toEqual({ version: 1, state: 'en_vente', priceEur: 210000, channels: { site: 'publiee', reseaux: 'publiee', google: 'publiee', portails: 'publiee' } });
  });

  it('[R47] sans validation de l’agent, rien n’est publié même hors délai', async () => {
    const t = await setup();
    t.setClock(new Date('2027-03-01T10:00:00.000Z'));
    expect(await t.publication.sync(t.network.id, t.propertyId)).toEqual({ version: null, state: null, created: false, pushed: [], failed: [] });
    expect(t.channels.every((c) => c.received.length === 0)).toBe(true);
  });

  it('[R44] même prix sur tous les canaux ; un avenant de prix est répercuté partout en moins de 15 minutes', async () => {
    const t = await setup();
    t.setClock(new Date('2027-02-12T10:00:00.000Z'));
    await t.annonces.validate(t.agent, t.draftId);
    await t.runEvery15(new Date('2027-03-01T08:00:00.000Z'), new Date('2027-03-01T08:00:00.000Z'));
    expect(prices(t)).toEqual([210000, 210000, 210000, 210000]);
    // L'avenant est signé à 8 h 07 ; le passage de 8 h 15 le répercute partout.
    t.setClock(new Date('2027-03-01T08:07:00.000Z'));
    await t.amend(190000);
    const signedAt = t.now();
    const at = await t.runEvery15(new Date('2027-03-01T08:15:00.000Z'), new Date('2027-03-01T09:00:00.000Z'));
    expect(at!.getTime() - signedAt.getTime()).toBeLessThanOrEqual(15 * MIN);
    expect(prices(t)).toEqual([200000, 200000, 200000, 200000]);
    expect(t.channels.every((c) => c.received.at(-1)!.mentions!.includes('hors honoraires'))).toBe(true);
    // Rien ne change : aucun nouvel envoi.
    expect(t.channels.map((c) => c.received.length)).toEqual([2, 2, 2, 2]);
  });

  it('un canal en panne est réessayé au passage suivant, sans doublon ; l’échec est au journal', async () => {
    const t = await setup();
    t.setClock(new Date('2027-02-12T10:00:00.000Z'));
    await t.annonces.validate(t.agent, t.draftId);
    t.channels[3]!.failNext = 1;
    t.setClock(new Date('2027-03-01T08:00:00.000Z'));
    expect(await t.publication.sync(t.network.id, t.propertyId)).toMatchObject({ version: 1, created: true, pushed: ['site', 'reseaux', 'google'], failed: ['portails'] });
    const st = await t.publication.status(t.agent, t.propertyId);
    expect(st.ok && st.value?.channels.portails).toBe('echec');
    t.setClock(new Date('2027-03-01T08:15:00.000Z'));
    expect(await t.publication.sync(t.network.id, t.propertyId)).toMatchObject({ version: 1, created: false, pushed: ['portails'], failed: [] });
    expect(await t.publication.sync(t.network.id, t.propertyId)).toMatchObject({ version: 1, created: false, pushed: [], failed: [] });
    expect(t.channels.map((c) => c.received.length)).toEqual([1, 1, 1, 1]);
    const failure = (await t.journal.bySubject(`property:${t.propertyId}`)).find((e) => e.type === 'annonce.envoi_echec');
    expect(failure?.data).toEqual({ channel: 'portails', seq: 1, code: 'portail_indisponible' });
  });

  it('[R42] un mandat rétracté, annulé ou échu retire l’annonce partout au passage suivant', async () => {
    // Rétractation pendant le délai, après un début anticipé demandé par écrit.
    const w = await setup();
    w.setClock(new Date('2027-02-12T10:00:00.000Z'));
    await w.annonces.validate(w.agent, w.draftId);
    const diffusion = new Diffusion(w.db, w.acces, w.journal, { now: w.now });
    await diffusion.recordEarlyStart(w.agent, w.mandateId, { proof: 'demande écrite du vendeur', receivedAt: new Date('2027-02-12T09:00:00.000Z') });
    expect(await w.publication.sync(w.network.id, w.propertyId)).toMatchObject({ version: 1, state: 'en_vente', created: true });
    w.setClock(new Date('2027-02-14T10:00:00.000Z'));
    await diffusion.recordWithdrawal(w.agent, w.mandateId, { proof: 'lettre de rétractation', receivedAt: new Date('2027-02-14T09:00:00.000Z') });
    expect(await w.publication.sync(w.network.id, w.propertyId)).toMatchObject({ version: 2, state: 'retiree', created: true });
    expect(w.channels.map((c) => c.received.at(-1)?.state)).toEqual(['retiree', 'retiree', 'retiree', 'retiree']);
    expect(w.channels.every((c) => c.received.at(-1)!.priceEur === null && c.received.at(-1)!.body === null)).toBe(true);
    expect(await w.publication.sync(w.network.id, w.propertyId)).toMatchObject({ version: 2, created: false, pushed: [] });
    // Annulé au registre.
    const c = await setup();
    c.setClock(new Date('2027-02-12T10:00:00.000Z'));
    await c.annonces.validate(c.agent, c.draftId);
    c.setClock(new Date('2027-03-01T10:00:00.000Z'));
    await c.publication.sync(c.network.id, c.propertyId);
    await new RegistreMandats(c.db, c.journal, { now: c.now }).cancel(c.direction, c.mandateId, 'termination');
    expect(await c.publication.sync(c.network.id, c.propertyId)).toMatchObject({ version: 2, state: 'retiree' });
    // Échu : 12 mois après la signature.
    const e = await setup();
    e.setClock(new Date('2027-02-12T10:00:00.000Z'));
    await e.annonces.validate(e.agent, e.draftId);
    e.setClock(new Date('2027-03-01T10:00:00.000Z'));
    await e.publication.sync(e.network.id, e.propertyId);
    e.setClock(new Date('2028-02-10T10:00:00.000Z'));
    expect(await e.publication.sync(e.network.id, e.propertyId)).toMatchObject({ version: 2, state: 'retiree' });
    const retired = (await e.journal.bySubject(`property:${e.propertyId}`)).find((x) => x.type === 'annonce.retiree');
    expect(retired?.data).toEqual({ rule: 'R42', seq: 2, state: 'retiree', reason: 'expired' });
  });

  it('[R43] sans liste de contrôle complète rien n’est publié, et une annonce en ligne est retirée au passage suivant', async () => {
    const t = await setup({ card: false });
    t.setClock(new Date('2027-03-01T10:00:00.000Z'));
    // Sans numéro de carte, l'annonce ne peut même pas être validée, et rien ne part.
    expect(await t.annonces.validate(t.agent, t.draftId)).toMatchObject({ ok: false, rule: 'R43', code: 'mentions_incomplete' });
    expect(await t.publication.sync(t.network.id, t.propertyId)).toEqual({ version: null, state: null, created: false, pushed: [], failed: [] });
    // Une annonce en ligne dont une mention vient à manquer est retirée partout.
    const u = await setup();
    u.setClock(new Date('2027-02-12T10:00:00.000Z'));
    await u.annonces.validate(u.agent, u.draftId);
    u.setClock(new Date('2027-03-01T10:00:00.000Z'));
    await u.publication.sync(u.network.id, u.propertyId);
    await u.db.run("UPDATE properties SET kind = 'commercial' WHERE id = ?", [u.propertyId]);
    expect(await u.publication.sync(u.network.id, u.propertyId)).toMatchObject({ version: 2, state: 'retiree', created: true });
    expect(u.channels.map((c) => c.received.at(-1)?.state)).toEqual(['retiree', 'retiree', 'retiree', 'retiree']);
    const retired = (await u.journal.bySubject(`property:${u.propertyId}`)).find((x) => x.type === 'annonce.retiree');
    expect(retired?.data).toEqual({ rule: 'R42', seq: 2, state: 'retiree', reason: 'mentions_incompletes' });
  });

  it('[R45] AU005 : un diagnostic de 2019 ne se valide ni ne se publie', async () => {
    const t = await setup({ diagnosedOn: '2019-06-12' });
    t.setClock(new Date('2027-03-01T10:00:00.000Z'));
    const v = await t.annonces.validate(t.agent, t.draftId);
    expect(v).toMatchObject({ ok: false, rule: 'R43', code: 'mentions_incomplete' });
    expect(!v.ok && 'missing' in v && v.missing).toEqual([{ id: 'energie', status: 'manquante', reason: 'diagnostic_perime' }]);
    expect(await t.publication.sync(t.network.id, t.propertyId)).toEqual({ version: null, state: null, created: false, pushed: [], failed: [] });
    expect(t.channels.every((c) => c.received.length === 0)).toBe(true);
  });

  it('[R42] un bien en erreur n’arrête pas le passage des autres ; l’échec est au journal', async () => {
    const t = await setup();
    t.setClock(new Date('2027-02-12T10:00:00.000Z'));
    await t.annonces.validate(t.agent, t.draftId);
    t.setClock(new Date('2027-03-01T10:00:00.000Z'));
    const original = t.publication.sync.bind(t.publication);
    let calls = 0;
    t.publication.sync = async (networkId, propertyId) => {
      calls++;
      if (calls === 1) throw new Error('panne passagère');
      return original(networkId, propertyId);
    };
    // Un second bien inventé, avec un brouillon, pour que le passage en compte deux.
    await t.db.run("INSERT INTO properties (id, network_id, agent_id, reference, kind, status, created_at, updated_at) SELECT 'bien-2', network_id, agent_id, 'REF-T-2', 'home', 'draft', created_at, updated_at FROM properties WHERE id = ?", [t.propertyId]);
    await t.annonces.propose(t.agent, 'bien-2');
    const all = await t.publication.syncAll(t.network.id);
    expect(all).toHaveLength(2);
    expect(all.filter((x) => x.result === null)).toHaveLength(1);
    const failed = all.find((x) => x.result === null)!.propertyId;
    const entry = (await t.journal.bySubject(`property:${failed}`)).find((e) => e.type === 'annonce.passage_echec');
    expect(entry?.data).toEqual({ rule: 'R42', code: 'erreur' });
    expect(JSON.stringify(entry)).not.toContain('panne');
  });

  it('l’état du bien suit : sous offre, vendu, retiré de la vente', async () => {
    const t = await setup();
    t.setClock(new Date('2027-02-12T10:00:00.000Z'));
    await t.annonces.validate(t.agent, t.draftId);
    t.setClock(new Date('2027-03-01T10:00:00.000Z'));
    await t.publication.sync(t.network.id, t.propertyId);
    await t.db.run("UPDATE properties SET status = 'under_offer' WHERE id = ?", [t.propertyId]);
    expect(await t.publication.sync(t.network.id, t.propertyId)).toMatchObject({ version: 2, state: 'sous_offre' });
    await t.db.run("UPDATE properties SET status = 'sold' WHERE id = ?", [t.propertyId]);
    expect(await t.publication.sync(t.network.id, t.propertyId)).toMatchObject({ version: 3, state: 'vendu' });
    await t.db.run("UPDATE properties SET status = 'withdrawn' WHERE id = ?", [t.propertyId]);
    expect(await t.publication.sync(t.network.id, t.propertyId)).toMatchObject({ version: 4, state: 'retiree' });
    expect(t.channels[0]!.received.map((p) => p.state)).toEqual(['en_vente', 'sous_offre', 'vendu', 'retiree']);
  });

  it('ce que reçoivent les canaux ne porte ni adresse, ni nom, ni coordonnée ; rien ne s’efface', async () => {
    const t = await setup();
    t.setClock(new Date('2027-02-12T10:00:00.000Z'));
    await t.annonces.validate(t.agent, t.draftId);
    t.setClock(new Date('2027-03-01T10:00:00.000Z'));
    const all = await t.publication.syncAll(t.network.id);
    expect(all).toHaveLength(1);
    const p = t.channels[0]!.received[0]!;
    expect(Object.keys(p).sort()).toEqual(['body', 'media', 'mentions', 'priceEur', 'reference', 'state', 'title', 'version']);
    expect(JSON.stringify(p)).not.toMatch(/Léa|Exemple|rue /);
    await expect(t.db.run('DELETE FROM listing_versions')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run('UPDATE listing_pushes SET outcome = \'ok\'')).rejects.toThrow(/ne change plus/);
  });

  it('[R16] l’état de publication se lit selon les droits ; deux passages simultanés ne créent qu’une version', async () => {
    const t = await setup();
    t.setClock(new Date('2027-02-12T10:00:00.000Z'));
    await t.annonces.validate(t.agent, t.draftId);
    t.setClock(new Date('2027-03-01T10:00:00.000Z'));
    const [a, b] = await Promise.all([t.publication.sync(t.network.id, t.propertyId), t.publication.sync(t.network.id, t.propertyId)]);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    expect(t.channels.map((c) => c.received.length)).toEqual([1, 1, 1, 1]);
    expect(await t.publication.status(t.sam, t.propertyId)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.publication.status(t.direction, t.propertyId)).toMatchObject({ ok: true, value: { version: 1 } });
    expect(await t.publication.sync('autre-reseau', t.propertyId)).toEqual({ version: null, state: null, created: false, pushed: [], failed: [] });
  });
});

it('P04 · un canal inconnu ou en double est refusé à la construction', () => {
  const db = {} as SqlDatabase;
  expect(() => new Publication(db, {} as Acces, {} as never, { channels: [new FakeChannel('site'), new FakeChannel('site')] })).toThrow(/double/);
  expect(() => new Publication(db, {} as Acces, {} as never, { channels: [new FakeChannel('fax' as Channel)] })).toThrow(/inconnu/);
});

describeWithSqlite('P04 · un passage à la fois par bien', () => {
  it('[R42] un envoi ancien encore en cours ne passe jamais après un retrait : le second passage attend son tour', async () => {
    const t = await setup();
    t.setClock(new Date('2027-02-12T10:00:00.000Z'));
    await t.annonces.validate(t.agent, t.draftId);
    t.setClock(new Date('2027-03-01T10:00:00.000Z'));
    let release: () => void = () => {};
    t.channels[0]!.gate = new Promise<void>((r) => (release = r));
    // On attend que l'envoi soit vraiment en route, sans délai fixe : sûr même sur une machine lente.
    let reached: () => void = () => {};
    const inFlight = new Promise<void>((r) => (reached = r));
    const push = t.channels[0]!.push.bind(t.channels[0]!);
    t.channels[0]!.push = async (payload) => {
      reached();
      return push(payload);
    };
    const first = t.publication.sync(t.network.id, t.propertyId);
    await inFlight;
    // Pendant que la version 1 est en route, le mandat est annulé ; un second passage ne fait rien tant que le premier tient le bien.
    await new RegistreMandats(t.db, t.journal, { now: t.now }).cancel(t.direction, t.mandateId, 'termination');
    expect(await t.publication.sync(t.network.id, t.propertyId)).toMatchObject({ busy: true, created: false, pushed: [] });
    t.channels[0]!.gate = null;
    release();
    expect(await first).toMatchObject({ version: 1, state: 'en_vente' });
    // Le passage suivant retire l'annonce partout : la dernière chose reçue par chaque canal est le retrait.
    expect(await t.publication.sync(t.network.id, t.propertyId)).toMatchObject({ version: 2, state: 'retiree', created: true });
    expect(t.channels.map((c) => c.received.at(-1)?.state)).toEqual(['retiree', 'retiree', 'retiree', 'retiree']);
  });

  it('un bail échu est repris : un passage tombé en route ne bloque pas le bien pour toujours', async () => {
    const t = await setup();
    t.setClock(new Date('2027-02-12T10:00:00.000Z'));
    await t.annonces.validate(t.agent, t.draftId);
    t.setClock(new Date('2027-03-01T10:00:00.000Z'));
    await t.db.run("INSERT INTO listing_sync_leases (property_id, token, expires_at) VALUES (?, 'ancien', ?)", [t.propertyId, '2027-03-01T10:04:00.000Z']);
    expect(await t.publication.sync(t.network.id, t.propertyId)).toMatchObject({ busy: true });
    t.setClock(new Date('2027-03-01T10:05:00.000Z'));
    expect(await t.publication.sync(t.network.id, t.propertyId)).toMatchObject({ version: 1, created: true, pushed: ['site', 'reseaux', 'google', 'portails'] });
  });

  it('[R42] un passage dont le bail a échu avant d’écrire ne peut plus écrire de version périmée', async () => {
    const t = await setup();
    t.setClock(new Date('2027-02-12T10:00:00.000Z'));
    await t.annonces.validate(t.agent, t.draftId);
    t.setClock(new Date('2027-03-01T10:00:00.000Z'));
    expect(await t.publication.sync(t.network.id, t.propertyId)).toMatchObject({ version: 1, created: true });
    // Un avenant de prix ; le premier passage calcule la version 2 puis s'arrête juste avant de l'écrire.
    await t.amend(190000);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let pause = true;
    let reached: () => void = () => {};
    const paused = new Promise<void>((r) => (reached = r));
    const slowDb = {
      ...t.db,
      run: async (sql: string, params?: readonly (string | number | null)[]) => {
        if (pause && sql.includes('INSERT INTO listing_versions')) {
          pause = false;
          reached();
          await gate;
        }
        return t.db.run(sql, params);
      },
    };
    const slow = new Publication(slowDb, t.acces, t.journal, { now: t.now, channels: t.channels });
    const first = slow.sync(t.network.id, t.propertyId);
    await paused;
    // Six minutes plus tard, le bail a échu ; le mandat est annulé ; un autre passage retire l'annonce.
    t.setClock(new Date('2027-03-01T10:06:00.000Z'));
    await new RegistreMandats(t.db, t.journal, { now: t.now }).cancel(t.direction, t.mandateId, 'termination');
    expect(await t.publication.sync(t.network.id, t.propertyId)).toMatchObject({ version: 2, state: 'retiree', created: true });
    release();
    expect(await first).toMatchObject({ created: false });
    expect(await t.publication.sync(t.network.id, t.propertyId)).toMatchObject({ version: 2, state: 'retiree', created: false });
    expect(t.channels.map((c) => c.received.at(-1)?.state)).toEqual(['retiree', 'retiree', 'retiree', 'retiree']);
    const versions = await t.db.all<{ seq: number; state: string }>('SELECT seq, state FROM listing_versions WHERE property_id = ? ORDER BY seq', [t.propertyId]);
    expect(versions.map((v) => `${v.seq}:${v.state}`)).toEqual(['1:en_vente', '2:retiree']);
  });
});
