import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, verifyChain, type SqlDatabase, type Viewer } from '../src/index.ts';
import { Candidatures, ContenusRecrutement, checkContentUrl } from '../src/reseau/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, agents, candidats, vidéos et épisodes inventés.
const DAY = 86_400_000;
const START = Date.parse('2027-09-01T08:00:00.000Z');

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = START;
  const now = (): Date => new Date((clock += 1000));
  const advance = (days: number) => {
    clock += days * DAY;
  };
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  let codes = 0;
  const contenus = new ContenusRecrutement(db, journal, { now, newCode: () => `code${String(++codes).padStart(8, '0')}` });
  const candidatures = new Candidatures(db, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const other = await store.createNetwork('Autre réseau');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const as = (role: string, userId = 'dir-1', networkId = network.id): Viewer => ({ role, userId, networkId }) as Viewer;
  const dir = as('direction');
  let n = 0;
  /** Une candidature déposée sur la page, avec ou sans code. */
  const apply = async (extra: Record<string, unknown> = {}, networkId = network.id) => {
    n += 1;
    return candidatures.apply(networkId, { firstName: `Candidat${n}`, email: `candidat${n}@example.test`, currentStatus: 'autre_metier', experience: 'aucune', source: 'page', ...extra });
  };
  const candidateId = async (email: string) => (await db.first<{ id: string }>('SELECT id FROM candidates WHERE email = ?', [email]))!.id;
  /** Le parcours de M14, en lignes inventées : entretien tenu, décision, entrée, départ, mandat. */
  let seq = 0;
  let registerSeq = 0;
  const path = {
    interviewHeld: async (cid: string) => {
      const id = `i-${++seq}`;
      await db.run("INSERT INTO candidate_interviews (id, network_id, candidate_id, scheduled_at, interviewer, created_by, created_at) VALUES (?, ?, ?, '2027-09-02T08:00:00.000Z', 'Direction', 'direction:dir-1', '2027-09-01T09:00:00.000Z')", [id, network.id, cid]);
      await db.run("INSERT INTO candidate_interview_outcomes (interview_id, network_id, held_by_name, marked_by, marked_at) VALUES (?, ?, 'Dominique Direction', 'direction:dir-1', '2027-09-02T09:00:00.000Z')", [id, network.id]);
      return id;
    },
    decide: async (cid: string, decision: 'oui' | 'non' | 'a_revoir', interviewId: string | null, at: string) => {
      await db.run("INSERT INTO candidate_decisions (id, network_id, candidate_id, decision, reason, decided_by, decider_name, interview_id, decided_at) VALUES (?, ?, ?, ?, 'raison écrite', 'direction:dir-1', 'Dominique Direction', ?, ?)", [`d-${++seq}`, network.id, cid, decision, interviewId, at]);
    },
    enter: async (cid: string, enteredAt: string) => {
      const agent = await store.createAgent({ networkId: network.id, firstName: 'Nouvel', lastName: `Agent${++seq}` });
      await db.exec('PRAGMA foreign_keys = OFF');
      await db.run("INSERT INTO agent_onboardings (agent_id, network_id, candidate_id, created_by, created_at) VALUES (?, ?, ?, 'direction:dir-1', ?)", [agent.id, network.id, cid, enteredAt]);
      await db.exec('PRAGMA foreign_keys = ON');
      return agent.id;
    },
    /** Un départ ; passé, l'agent est marqué parti, comme le fait `depart.ts` le jour du départ. */
    leave: async (agentId: string, leavesOn: string, gone = true) => {
      if (gone) await db.run("UPDATE agents SET status = 'left' WHERE id = ?", [agentId]);
      await db.run("INSERT INTO agent_departures (id, network_id, agent_id, notice_given_on, leaves_on, reason, notice_months, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'demission_agent', 1, 'direction:dir-1', '2027-01-01T00:00:00.000Z')", [`dep-${++seq}`, network.id, agentId, leavesOn, leavesOn]);
    },
    mandate: async (agentId: string, signedAt: string) => {
      const id = `m-${++seq}`;
      const rank = ++registerSeq;
      await db.exec('PRAGMA foreign_keys = OFF');
      await db.run("INSERT INTO mandates (id, network_id, agent_id, person_id, signed_at, source_kind, recorded_by, created_at) VALUES (?, ?, ?, 'p', ?, 'referral', 'x', ?)", [id, network.id, agentId, signedAt, signedAt]);
      await db.run("INSERT INTO mandate_register (network_id, seq, kind, mandate_id, number_value, number, agent_id, signed_at, at, actor, prev_hash, hash) VALUES (?, ?, 'inscription', ?, ?, ?, ?, ?, ?, 'x', 'p', ?)", [network.id, rank, id, rank, `T-${rank}`, agentId, signedAt, signedAt, `h-${id}`]);
      await db.exec('PRAGMA foreign_keys = ON');
    },
  };
  const events = async (type: string) => (await db.all<{ data: string; subject: string }>('SELECT data, subject FROM journal WHERE type = ?', [type])).map((r) => ({ subject: r.subject, ...(JSON.parse(r.data) as Record<string, unknown>) }));
  const video = async (title = 'Une journée d’agent à Dijon', extra: Record<string, unknown> = {}) => {
    const r = await contenus.create(dir, { kind: 'video', title, url: 'https://www.youtube.com/watch?v=essai123', publishedOn: '2027-08-20', ...extra });
    if (!r.ok) throw new Error(r.code);
    return r.value;
  };
  const episode = async (title = 'Épisode 12 : quitter une agence') => {
    const r = await contenus.create(dir, { kind: 'podcast', title, url: 'https://podcast.example.test/episodes/12', publishedOn: '2027-08-25' });
    if (!r.ok) throw new Error(r.code);
    return r.value;
  };
  return { db, journal, store, contenus, candidatures, network, other, alex, as, dir, apply, candidateId, path, events, video, episode, advance };
}

describeWithSqlite('HX64 · vidéos et épisodes du podcast, mesurés jusqu’à l’agent resté', () => {
  it('[R620] [R80] un titre ou une description qui promet un revenu est refusé, rien n’est rangé', async () => {
    const t = await setup();
    const promise = await t.contenus.create(t.dir, { kind: 'video', title: 'Gagnez 5 000 € par mois', url: 'https://youtu.be/essai', publishedOn: '2027-08-20' });
    expect(promise).toMatchObject({ ok: false, rule: 'R80', code: 'promesse', field: 'title' });
    const desc = await t.contenus.create(t.dir, { kind: 'podcast', title: 'Épisode 3', url: 'https://podcast.example.test/3', publishedOn: '2027-08-20', description: 'Des revenus garantis dès le premier mois.' });
    expect(desc).toMatchObject({ ok: false, rule: 'R80', code: 'promesse', field: 'description', reasons: ['promise'] });
    expect((await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM recruiting_contents'))!.n).toBe(0);
    expect(await t.events('recrutement.contenu_refuse')).toHaveLength(2);
    // « Gagner du temps » reste permis, comme en J01.
    const ok = await t.contenus.create(t.dir, { kind: 'video', title: 'Gagner du temps sur les visites', url: 'https://www.youtube.com/watch?v=abc', publishedOn: '2027-08-20', description: 'Comment le réseau organise la semaine.' });
    expect(ok).toMatchObject({ ok: true, value: { kind: 'video', link: '/rejoindre?c=code00000001', withdrawnAt: null } });
  });

  it('[R620] lien https seulement, YouTube pour une vidéo ; champs en liste fermée ; date réelle', async () => {
    expect(checkContentUrl('video', 'https://www.youtube.com/watch?v=x1')).toBe('https://www.youtube.com/watch?v=x1');
    expect(checkContentUrl('video', 'https://youtu.be/x1')).not.toBeNull();
    expect(checkContentUrl('video', 'https://vimeo.com/123456')).toBeNull();
    expect(checkContentUrl('video', 'http://www.youtube.com/watch?v=x1')).toBeNull();
    expect(checkContentUrl('podcast', 'https://user:pass@podcast.example.test/1')).toBeNull();
    expect(checkContentUrl('podcast', 'https://127.0.0.1/1')).toBeNull();
    expect(checkContentUrl('podcast', 'https://localhost/episode')).toBeNull();
    expect(checkContentUrl('podcast', 'javascript:alert(1)')).toBeNull();
    expect(checkContentUrl('podcast', 'https://podcast.example.test/episodes/1')).not.toBeNull();
    const t = await setup();
    expect(await t.contenus.create(t.dir, { kind: 'video', title: 'Essai', url: 'https://vimeo.com/123456', publishedOn: '2027-08-20' })).toMatchObject({ ok: false, rule: 'R620', code: 'bad_url' });
    expect(await t.contenus.create(t.dir, { kind: 'video', title: 'Essai', url: 'https://youtu.be/x', publishedOn: '2027-02-30' })).toMatchObject({ ok: false, code: 'bad_published_on' });
    expect(await t.contenus.create(t.dir, { kind: 'live', title: 'Essai', url: 'https://youtu.be/x', publishedOn: '2027-08-20' })).toMatchObject({ ok: false, code: 'bad_kind' });
    expect(await t.contenus.create(t.dir, { kind: 'video', title: 'Essai', url: 'https://youtu.be/x', publishedOn: '2027-08-20', score: 3 })).toMatchObject({ ok: false, code: 'unknown_field' });
  });

  it('[R620] [R16] seule la direction range, retire et lit ; retiré une fois, jamais effacé ; la base refuse le reste', async () => {
    const t = await setup();
    for (const role of ['agent', 'compliance', 'partenaire']) {
      const v = t.as(role, t.alex.id);
      expect(await t.contenus.create(v, { kind: 'video', title: 'Essai', url: 'https://youtu.be/x', publishedOn: '2027-08-20' })).toMatchObject({ ok: false, rule: 'R16' });
      expect(await t.contenus.report(v)).toMatchObject({ ok: false, rule: 'R16' });
    }
    expect((await t.events('acces.refuse')).length).toBe(6);
    const v = await t.video();
    expect(await t.contenus.withdraw(t.as('agent', t.alex.id), v.id)).toMatchObject({ ok: false, rule: 'R16' });
    // Un contenu d'un autre réseau n'est pas trouvé.
    expect(await t.contenus.withdraw(t.as('direction', 'dir-2', t.other.id), v.id)).toMatchObject({ ok: false, code: 'not_found' });
    expect(await t.contenus.withdraw(t.dir, v.id)).toMatchObject({ ok: true });
    expect(await t.contenus.withdraw(t.dir, v.id)).toMatchObject({ ok: false, rule: 'R620', code: 'deja_retire' });
    // La base : ni effacement, ni changement, ni auteur autre que la direction.
    await expect(t.db.run('DELETE FROM recruiting_contents WHERE id = ?', [v.id])).rejects.toThrow();
    await expect(t.db.run("UPDATE recruiting_contents SET title = 'Autre' WHERE id = ?", [v.id])).rejects.toThrow();
    await expect(t.db.run('DELETE FROM recruiting_content_withdrawals WHERE content_id = ?', [v.id])).rejects.toThrow();
    await expect(
      t.db.run("INSERT INTO recruiting_contents (id, network_id, kind, title, url, published_on, code, created_by, created_at) VALUES ('x', ?, 'video', 'Essai', 'https://youtu.be/x', '2027-08-20', 'abcdefghjkmn', 'agent:a', 'x')", [t.network.id]),
    ).rejects.toThrow();
    // Retiré, il reste au compte rendu et disparaît de la page publique.
    const r = await t.contenus.report(t.dir);
    if (!r.ok) throw new Error(r.code);
    expect(r.value.map((l) => l.content.withdrawnAt)).toEqual([expect.any(String)]);
    expect(await t.contenus.listPublic(t.network.id)).toEqual([]);
  });

  it('[R621] [R18] une candidature avec le code d’un contenu actif lui est rattachée, sa source devient la sorte du contenu', async () => {
    const t = await setup();
    const ep = await t.episode();
    const a = await t.apply({ email: 'avec.code@example.test', source: 'page', contentCode: ep.code });
    const b = await t.apply({ email: 'sans.code@example.test', source: 'video' });
    // La même réponse au candidat, avec ou sans code.
    expect(a).toEqual(b);
    expect(a).toEqual({ ok: true, value: { recorded: true } });
    const ca = await t.candidateId('avec.code@example.test');
    expect(await t.db.first('SELECT source FROM candidates WHERE id = ?', [ca])).toEqual({ source: 'podcast' });
    expect(await t.db.all('SELECT candidate_id, content_id FROM candidate_content_origins')).toEqual([{ candidate_id: ca, content_id: ep.id }]);
    // Au journal, le contenu d'origine, jamais un nom ni une coordonnée.
    const logged = await t.events('candidature.rangee');
    expect(logged[0]).toMatchObject({ source: 'podcast', contentId: ep.id });
    expect(JSON.stringify(logged)).not.toMatch(/example\.test|Candidat/);
    // Une candidature déjà rangée pour la même coordonnée : même réponse, rien de rattaché de plus.
    const v = await t.video();
    expect(await t.apply({ email: 'sans.code@example.test', source: 'video', contentCode: v.code })).toEqual(b);
    expect((await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM candidate_content_origins'))!.n).toBe(1);
    // Une origine ne change ni ne s'efface.
    await expect(t.db.run('UPDATE candidate_content_origins SET content_id = ?', [v.id])).rejects.toThrow();
    await expect(t.db.run('DELETE FROM candidate_content_origins')).rejects.toThrow();
    expect((await verifyChain(await t.journal.all())).ok).toBe(true);
  });

  it('[R621] un code inconnu, retiré ou d’un autre réseau est ignoré sans le dire ; la base refuse un rattachement faux', async () => {
    const t = await setup();
    const v = await t.video();
    const w = await t.video('Le premier mois dans le réseau');
    await t.contenus.withdraw(t.dir, w.id);
    const ok = await t.apply({ email: 'reference@example.test' });
    expect(await t.apply({ email: 'inconnu@example.test', contentCode: 'zzzzzzzzzzzz' })).toEqual(ok);
    expect(await t.apply({ email: 'retire@example.test', contentCode: w.code })).toEqual(ok);
    expect(await t.apply({ email: 'autre.reseau@example.test', contentCode: v.code }, t.other.id)).toEqual(ok);
    // Un code abîmé (trop long, pas une chaîne) est ignoré aussi : la candidature est rangée.
    expect(await t.apply({ email: 'trop.long@example.test', contentCode: 'x'.repeat(41) })).toEqual(ok);
    expect(await t.apply({ email: 'nombre@example.test', contentCode: 12345 })).toEqual(ok);
    expect((await t.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM candidates WHERE email IN ('trop.long@example.test', 'nombre@example.test')"))!.n).toBe(2);
    expect((await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM candidate_content_origins'))!.n).toBe(0);
    // La source cochée reste celle du candidat quand le code ne sert pas.
    expect(await t.db.first('SELECT source FROM candidates WHERE id = ?', [await t.candidateId('retire@example.test')])).toEqual({ source: 'page' });
    // La base : pas de contenu retiré, pas d'autre source, pas d'autre réseau.
    const insert = (cid: string, contentId: string, net = t.network.id) =>
      t.db.run("INSERT INTO candidate_content_origins (candidate_id, network_id, content_id, at) VALUES (?, ?, ?, 'x')", [cid, net, contentId]);
    await expect(insert(await t.candidateId('retire@example.test'), w.id)).rejects.toThrow();
    await expect(insert(await t.candidateId('inconnu@example.test'), v.id)).rejects.toThrow();
    await t.apply({ email: 'bonne.source@example.test', source: 'video' });
    await expect(insert(await t.candidateId('autre.reseau@example.test'), v.id, t.other.id)).rejects.toThrow();
    expect(await insert(await t.candidateId('bonne.source@example.test'), v.id)).toEqual({ changes: 1 });
  });

  it('[R622] [R81] [R16] le chemin de chaque contenu, de la candidature à l’agent resté et au premier mandat, sans nom', async () => {
    const t = await setup();
    const v = await t.video();
    const ep = await t.episode();
    // Cinq candidats par la vidéo, deux par l'épisode, un sans code.
    for (let i = 1; i <= 5; i++) await t.apply({ email: `v${i}@example.test`, contentCode: v.code });
    for (let i = 1; i <= 2; i++) await t.apply({ email: `p${i}@example.test`, contentCode: ep.code });
    await t.apply({ email: 'sans@example.test', source: 'video' });
    const [v1, v2, v3, v4, v5] = await Promise.all([1, 2, 3, 4, 5].map((i) => t.candidateId(`v${i}@example.test`)));
    const p1 = await t.candidateId('p1@example.test');
    const sans = await t.candidateId('sans@example.test');
    // Entretiens tenus : v1, v2, v3, v4 (deux fois pour v1), p1, et le candidat sans code.
    const i1 = await t.path.interviewHeld(v1!);
    await t.path.interviewHeld(v1!);
    const i2 = await t.path.interviewHeld(v2!);
    const i3 = await t.path.interviewHeld(v3!);
    const i4 = await t.path.interviewHeld(v4!);
    const ip = await t.path.interviewHeld(p1);
    await t.path.interviewHeld(sans);
    // Un entretien fixé mais pas tenu ne compte pas.
    await t.db.run("INSERT INTO candidate_interviews (id, network_id, candidate_id, scheduled_at, interviewer, created_by, created_at) VALUES ('pas-tenu', ?, ?, '2027-09-03T08:00:00.000Z', 'Direction', 'direction:dir-1', 'x')", [t.network.id, v5!]);
    // Décisions : la dernière compte. v4 : « oui » puis « non ».
    await t.path.decide(v1!, 'oui', i1, '2027-09-03T08:00:00.000Z');
    await t.path.decide(v2!, 'a_revoir', null, '2027-09-03T08:00:00.000Z');
    await t.path.decide(v2!, 'oui', i2, '2027-09-04T08:00:00.000Z');
    await t.path.decide(v3!, 'oui', i3, '2027-09-03T08:00:00.000Z');
    await t.path.decide(v4!, 'oui', i4, '2027-09-03T08:00:00.000Z');
    await t.path.decide(v4!, 'non', null, '2027-09-05T08:00:00.000Z');
    await t.path.decide(p1, 'oui', ip, '2027-09-03T08:00:00.000Z');
    // Entrées : v1 et v2 il y a plus de 90 jours (au jour de lecture), v3 il y a 30 jours, p1 il y a plus de 90 jours.
    // Lecture le 2028-01-15 environ.
    t.advance(136);
    const a1 = await t.path.enter(v1!, '2027-09-10T08:00:00.000Z');
    const a2 = await t.path.enter(v2!, '2027-09-12T08:00:00.000Z');
    const a3 = await t.path.enter(v3!, '2027-12-16T08:00:00.000Z');
    const ap = await t.path.enter(p1, '2027-09-10T08:00:00.000Z');
    // a2 part au 60e jour ; ap part au 120e jour (il était encore là au 90e) ; le départ annulé de a1 ne compte pas.
    await t.path.leave(a2, '2027-11-11');
    await t.path.leave(ap, '2028-01-08');
    await t.db.run(
      "INSERT INTO agent_departures (id, network_id, agent_id, notice_given_on, leaves_on, reason, notice_months, created_by, created_at, cancelled_at, cancelled_by) VALUES ('annule', ?, ?, '2027-09-20', '2027-10-20', 'demission_agent', 1, 'direction:dir-1', 'x', '2027-09-25T08:00:00.000Z', 'direction:dir-1')",
      [t.network.id, a1],
    );
    // Mandats : a1 au 20e jour (compte), a3 au 10e jour (compte), ap au 100e jour (hors des 90 jours).
    await t.path.mandate(a1, '2027-09-30T08:00:00.000Z');
    await t.path.mandate(a3, '2027-12-26T08:00:00.000Z');
    await t.path.mandate(ap, '2027-12-19T08:00:00.000Z');
    // Un mandat non inscrit au registre ne compte pas.
    await t.db.exec('PRAGMA foreign_keys = OFF');
    await t.db.run("INSERT INTO mandates (id, network_id, agent_id, person_id, signed_at, source_kind, recorded_by, created_at) VALUES ('non-inscrit', ?, ?, 'p', '2027-09-20T08:00:00.000Z', 'referral', 'x', 'x')", [t.network.id, a2]);
    await t.db.exec('PRAGMA foreign_keys = ON');

    const r = await t.contenus.report(t.dir);
    if (!r.ok) throw new Error(r.code);
    expect(r.value.map((l) => [l.content.kind, l.funnel])).toEqual([
      ['video', { candidatures: 5, interviewsHeld: 4, accepted: 3, entered: 3, enteredAtLeast90DaysAgo: 2, stayed90Days: 1, signedMandateWithin90Days: 2 }],
      ['podcast', { candidatures: 2, interviewsHeld: 1, accepted: 1, entered: 1, enteredAtLeast90DaysAgo: 1, stayed90Days: 1, signedMandateWithin90Days: 0 }],
    ]);
    // Aucun nom, aucune coordonnée, aucun identifiant de candidat ni d'agent dans le compte rendu.
    const json = JSON.stringify(r.value);
    expect(json).not.toMatch(/@example\.test|Candidat|Nouvel|Agent\d/);
    for (const id of [v1, v2, v3, v4, v5, p1, a1, a2, a3, ap]) expect(json).not.toContain(id!);
    // La lecture est écrite au journal.
    expect(await t.events('recrutement.contenus_lus')).toEqual([{ subject: `network:${t.network.id}`, rule: 'R16', count: 2 }]);
    // Un autre réseau ne voit rien de celui-ci.
    const o = await t.contenus.report(t.as('direction', 'dir-2', t.other.id));
    expect(o).toEqual({ ok: true, value: [] });
  });

  it('[R622] la dernière décision est celle rangée en dernier, même à la même milliseconde, comme dans l’entretien', async () => {
    const t = await setup();
    const v = await t.video();
    await t.apply({ email: 'meme.instant@example.test', contentCode: v.code });
    const cid = await t.candidateId('meme.instant@example.test');
    const i = await t.path.interviewHeld(cid);
    const at = '2027-09-03T08:00:00.000Z';
    // L'identifiant du « oui » est plus grand que celui du « non » rangé après lui : seul l'ordre de rangement compte.
    await t.db.run("INSERT INTO candidate_decisions (id, network_id, candidate_id, decision, reason, decided_by, decider_name, interview_id, decided_at) VALUES ('zzz', ?, ?, 'oui', 'raison écrite', 'direction:dir-1', 'Dominique Direction', ?, ?)", [t.network.id, cid, i, at]);
    await t.db.run("INSERT INTO candidate_decisions (id, network_id, candidate_id, decision, reason, decided_by, decider_name, interview_id, decided_at) VALUES ('aaa', ?, ?, 'non', 'raison écrite', 'direction:dir-1', 'Dominique Direction', NULL, ?)", [t.network.id, cid, at]);
    const r = await t.contenus.report(t.dir);
    if (!r.ok) throw new Error(r.code);
    expect(r.value[0]!.funnel).toMatchObject({ interviewsHeld: 1, accepted: 0 });
  });

  it('[R622] une entrée datée après la lecture et un mandat signé après la lecture ne comptent pas encore', async () => {
    const t = await setup();
    const v = await t.video();
    await t.apply({ email: 'futur@example.test', contentCode: v.code });
    const cid = await t.candidateId('futur@example.test');
    const agent = await t.path.enter(cid, '2030-01-01T08:00:00.000Z');
    await t.path.mandate(agent, '2030-01-05T08:00:00.000Z');
    const r = await t.contenus.report(t.dir);
    if (!r.ok) throw new Error(r.code);
    expect(r.value[0]!.funnel).toMatchObject({ candidatures: 1, entered: 0, signedMandateWithin90Days: 0 });
  });

  it('la page de recrutement ne montre que les contenus actifs, sans code ni auteur, les plus récents d’abord', async () => {
    const t = await setup();
    await t.video();
    await t.episode();
    const list = await t.contenus.listPublic(t.network.id);
    expect(list.map((c) => c.kind)).toEqual(['podcast', 'video']);
    expect(JSON.stringify(list)).not.toMatch(/code0|direction:/);
    expect(await t.contenus.listPublic(t.other.id)).toEqual([]);
  });
});
