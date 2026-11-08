import { expect, it } from 'vitest';
import { AvisVerifies, GENESIS_HASH, fileCommitment, reviewHash, reviewTextProblem, summarize, verifyChain, type PublicReview } from '../src/avis/index.ts';
import { FicheClient } from '../src/db/fiche-client.ts';
import { FicheUnique } from '../src/fiche/fusion.ts';
import { setupAnnonce } from './annonces-jeu.ts';
import { FakeDossiersClos } from './apres-vente-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

const BASE = 'https://aimmo.example.test/avis/';
const GOOD = 'Un suivi attentif du début à la fin, je recommande sans hésiter.';
const BAD = 'Très déçu : peu de nouvelles pendant trois mois, beaucoup de retard.';

it('[R523] le texte refuse coordonnées, liens, adresses et noms des clients, quelle que soit la note', () => {
  const names = ['Ana', 'Durand-Exemple'];
  expect(reviewTextProblem(GOOD, names)).toBeNull();
  expect(reviewTextProblem('trop court', names)).toBe('length');
  expect(reviewTextProblem(`${GOOD} écrivez-moi à ana.d@example.test`, names)).toBe('email');
  expect(reviewTextProblem(`${GOOD} appelez le 06 12 34 56 78`, names)).toBe('phone');
  expect(reviewTextProblem(`${GOOD} appelez le +33 6 12 34 56 78`, names)).toBe('phone');
  expect(reviewTextProblem(`${GOOD} voir https://exemple.test/page`, names)).toBe('link');
  expect(reviewTextProblem(`${GOOD} pour notre maison du 12 rue des Lilas`, names)).toBe('address');
  for (const street of ['12 passage des Lilas', '4 lotissement les Prés', '7 bis faubourg Raines', '3 hameau du Val', '9 clos des Vignes'])
    expect(reviewTextProblem(`${GOOD} Pour notre logement au ${street}.`, names)).toBe('address');
  expect(reviewTextProblem(`${GOOD} Signé : Madame DURAND`, names)).toBe('name');
  expect(reviewTextProblem(`${GOOD} Ána`, names)).toBe('name');
  // Les noms dans toutes les écritures, et les numéros internationaux.
  expect(reviewTextProblem(`${GOOD} Signé : 王 明.`, ['王', '明'])).toBe('name');
  expect(reviewTextProblem(`${GOOD} Signé : 王明.`, ['王明'])).toBe('name');
  expect(reviewTextProblem(`${GOOD} Merci, Дмитрий.`, ['Дмитрий'])).toBe('name');
  expect(reviewTextProblem(`${GOOD} Appelez +262 692 12 34 56.`, [])).toBe('phone');
  expect(reviewTextProblem(`${GOOD} Appelez +44 20 7946 0958.`, [])).toBe('phone');
  expect(reviewTextProblem(`${GOOD} Appelez 0044 20 7946 0958.`, [])).toBe('phone');
  expect(reviewTextProblem(`${GOOD} Vente conclue en 2027, +5 % sur l’estimation.`, [])).toBeNull();
  // Un nom fait de mots courts se cherche entier ; un mot court d'un nom plus long ne bloque pas tout.
  expect(reviewTextProblem(`${GOOD} Signé : Li Ng.`, ['Li', 'Ng'])).toBe('name');
  expect(reviewTextProblem(`${GOOD} Merci, LI.`, ['Li'])).toBe('name');
  expect(reviewTextProblem(`${GOOD} Le suivi était parfait.`, ['Le Gall'])).toBeNull();
  expect(reviewTextProblem(`${GOOD} Merci M. Le Gall.`, ['Le Gall'])).toBe('name');
  // Un mot qui contient un nom sans l'être passe.
  expect(reviewTextProblem(`${GOOD} Banane.`, names)).toBeNull();
});

it('[R521] le résumé compte tous les avis, les mauvais comme les bons', () => {
  expect(summarize([{ score: 5 }, { score: 1 }, { score: 2 }])).toEqual({ count: 3, average: 2.7, byScore: { 1: 1, 2: 1, 3: 0, 4: 0, 5: 1 } });
  expect(summarize([])).toEqual({ count: 0, average: null, byScore: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } });
});

describeWithSqlite('HX46 · avis clients vérifiables, publiés partout', () => {

  async function setup() {
    const t = await setupAnnonce();
    const dossiers = new FakeDossiersClos();
    const avis = new AvisVerifies(t.db, t.journal, dossiers, { now: t.now, base: BASE });
    const client = async (firstName: string, lastName = 'Exemple') => {

      return (await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName, lastName })).id;
    };
    const close = (fileId: string, closedOn: string, clients: { personId: string; side: 'vendeur' | 'acquereur' }[]) =>
      dossiers.sales.push({ fileId, agentId: t.alexId, closedOn, city: 'Dijon', reference: `REF-${fileId}`, clients });
    const tokenOf = (link: string) => link.slice(BASE.length);
    const invite = async (fileId: string, personId: string) => {
      const r = await avis.invite(t.agent, fileId, personId);
      if (!r.ok) throw new Error(r.code);
      return tokenOf(r.link);
    };
    t.setClock(new Date('2027-03-10T09:00:00.000Z'));
    return { ...t, dossiers, avis, client, close, invite };
  }

  it('[R520] un avis sans dossier clos est refusé : pas d’invitation, et la base refuse un avis rangé sans elle', async () => {
    const t = await setup();
    const a = await t.client('Ana');
    // Dossier non clos : aucune invitation.
    expect(await t.avis.invite(t.agent, 'f-ouvert', a)).toEqual({ ok: false, rule: 'R520', code: 'not_closed' });
    // Une personne qui n'est pas cliente du dossier clos : aucune invitation.
    const b = await t.client('Bea');
    t.close('f1', '2027-03-08', [{ personId: a, side: 'vendeur' }]);
    expect(await t.avis.invite(t.agent, 'f1', b)).toEqual({ ok: false, rule: 'R520', code: 'not_client' });
    // Rangé à la main, sans invitation consommée, la base le refuse.
    await expect(
      t.db.run(
        'INSERT INTO verified_reviews (code, network_id, agent_id, seq, file_id, person_id, side, score, text, published_on, file_salt, file_commitment, text_hash, prev_hash, hash, published_at) VALUES (?, ?, ?, 1, ?, ?, ?, 5, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['abcdefghjkmn', t.network.id, t.alexId, 'f-ouvert', a, 'vendeur', GOOD, '2027-03-10', 'a'.repeat(64), 'b'.repeat(64), 'd'.repeat(64), GENESIS_HASH, 'c'.repeat(64), '2027-03-10T09:00:00.000Z'],
      ),
    ).rejects.toThrow(/R520/);
    // Un dossier dont l'acte disparaît (ou change de jour) entre l'invitation et l'avis : refusé.
    const token = await t.invite('f1', a);
    t.dossiers.sales.length = 0;
    expect(await t.avis.submit(token, { score: 5, text: GOOD })).toEqual({ ok: false, rule: 'R520', code: 'not_closed' });
    t.close('f1', '2027-03-09', [{ personId: a, side: 'vendeur' }]);
    expect(await t.avis.submit(token, { score: 5, text: GOOD })).toEqual({ ok: false, rule: 'R520', code: 'not_closed' });
    const list = await t.avis.publicList(t.network.id, t.alexId);
    expect(list.reviews).toEqual([]);
    expect(await t.db.all('SELECT * FROM verified_review_invites WHERE used_at IS NOT NULL')).toEqual([]);
  });

  it('[R16] seuls l’agent du dossier et la direction invitent ; seule la conformité ouvre la preuve', async () => {
    const t = await setup();
    const a = await t.client('Ana');
    t.close('f1', '2027-03-08', [{ personId: a, side: 'vendeur' }]);
    expect(await t.avis.invite(t.sam, 'f1', a)).toMatchObject({ ok: false, rule: 'R16', code: 'not_own' });
    expect(await t.avis.invite({ ...t.agent, role: 'compliance' } as never, 'f1', a)).toMatchObject({ ok: false, rule: 'R16' });
    const d = await t.avis.invite(t.direction, 'f1', a);
    expect(d.ok).toBe(true);
    const r = await t.avis.submit(d.ok ? d.link.slice(BASE.length) : '', { score: 4, text: GOOD });
    if (!r.ok) throw new Error(r.code);
    expect(await t.avis.auditProof(t.direction, r.code)).toMatchObject({ ok: false, rule: 'R16' });
    const refus = (await t.journal.bySubject(`avis_verifie:${r.code}`)).filter((e) => e.type === 'acces.refuse');
    expect(refus).toHaveLength(1);
  });

  it('[R521] tous les avis sont publiés dans l’ordre d’arrivée, jamais triés ni masqués selon la note ; rien ne s’efface ni ne change', async () => {
    const t = await setup();
    const a = await t.client('Ana');
    const b = await t.client('Bea');
    const c = await t.client('Cyl');
    t.close('f1', '2027-03-08', [
      { personId: a, side: 'vendeur' },
      { personId: b, side: 'acquereur' },
    ]);
    t.close('f2', '2027-03-09', [{ personId: c, side: 'vendeur' }]);
    const scores: [string, string, number, string][] = [
      ['f1', a, 5, GOOD],
      ['f1', b, 1, BAD],
      ['f2', c, 3, 'Correct dans l’ensemble, mais quelques lenteurs au moment du compromis.'],
    ];
    const codes: string[] = [];
    for (const [file, person, score, text] of scores) {
      t.setClock(new Date(t.now().getTime() + 3_600_000));
      const r = await t.avis.submit(await t.invite(file, person), { score, text });
      if (!r.ok) throw new Error(r.code);
      codes.push(r.code);
    }
    const list = await t.avis.publicList(t.network.id, t.alexId);
    // L'ordre est celui d'arrivée, pas celui de la note ; la note 1 est là.
    expect(list.reviews.map((r) => r.score)).toEqual([5, 1, 3]);
    expect(list.reviews.map((r) => r.code)).toEqual(codes);
    expect(list.summary).toEqual({ count: 3, average: 3, byScore: { 1: 1, 2: 0, 3: 1, 4: 0, 5: 1 } });
    expect(await verifyChain(list.reviews, list.head)).toEqual({ ok: true, count: 3 });
    // Le dernier avis, ou tous, retirés : la chaîne qui reste est valable, mais la tête attendue le montre.
    expect(await verifyChain(list.reviews.slice(0, 2), list.head)).toMatchObject({ ok: false, reason: 'head' });
    expect(await verifyChain([], list.head)).toMatchObject({ ok: false, reason: 'head' });
    // Ni effacer, ni changer, ni cacher : la base refuse.
    await expect(t.db.run('DELETE FROM verified_reviews WHERE score = 1')).rejects.toThrow();
    await expect(t.db.run('UPDATE verified_reviews SET score = 5 WHERE score = 1')).rejects.toThrow();
    const columns = await t.db.all<{ name: string }>("SELECT name FROM pragma_table_info('verified_reviews')");
    expect(columns.map((c) => c.name).filter((x) => /hid|mask|visib|cach|publish(?!ed)|status/i.test(x))).toEqual([]);
    // Une liste publiée dont on retire le mauvais avis, ou qu'on réordonne par note, ne se vérifie plus.
    const withoutBad = list.reviews.filter((r) => r.score !== 1);
    expect(await verifyChain(withoutBad, list.head)).toMatchObject({ ok: false });
    const renumbered = withoutBad.map((r, i) => ({ ...r, seq: i + 1 }));
    expect(await verifyChain(renumbered, list.head)).toMatchObject({ ok: false });
    // Réordonnée par la note en gardant les numéros, la liste ne se vérifie plus non plus.
    const byScore = [...list.reviews].sort((x, y) => y.score - x.score);
    expect(await verifyChain(byScore, list.head)).toMatchObject({ ok: false });
    const edited = list.reviews.map((r) => (r.score === 1 ? { ...r, score: 4 } : r));
    expect(await verifyChain(edited, list.head)).toEqual({ ok: false, seq: 2, reason: 'hash' });
    // Un avis rangé à la main hors de la chaîne est refusé par la base : numéro qui saute, ou empreinte du précédent fausse.
    const d = await t.client('Dan');
    t.close('f3', '2027-03-09', [{ personId: d, side: 'acquereur' }]);
    await t.invite('f3', d);
    await t.db.run('UPDATE verified_review_invites SET used_at = ? WHERE file_id = ?', ['2027-03-10T12:00:00.000Z', 'f3']);
    const forge = (seq: number, prev: string) =>
      t.db.run(
        'INSERT INTO verified_reviews (code, network_id, agent_id, seq, file_id, person_id, side, score, text, published_on, file_salt, file_commitment, text_hash, prev_hash, hash, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, 5, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['abcdefghjkmn', t.network.id, t.alexId, seq, 'f3', d, 'acquereur', GOOD, '2027-03-10', 'a'.repeat(64), 'b'.repeat(64), 'd'.repeat(64), prev, 'c'.repeat(64), '2027-03-10T12:00:00.000Z'],
      );
    await expect(forge(5, list.reviews[2]!.hash)).rejects.toThrow(/R521/);
    await expect(forge(4, list.reviews[1]!.hash)).rejects.toThrow(/R521/);
    await expect(forge(4, 'e'.repeat(64))).rejects.toThrow(/R521/);
    // La couverture publique montre les clients des dossiers clos, les invités et les avis : un tri se verrait.
    expect((await t.avis.publicList(t.network.id, t.alexId)).coverage).toEqual({ clients: 4, invited: 4, reviews: 3 });
  });

  it('[R522] la vérification publique ne révèle aucune donnée personnelle, et le contrôleur retrouve le dossier par le sel', async () => {
    const t = await setup();
    const a = await t.client('Ana', 'Durand');
    t.close('f-secret-1', '2027-03-08', [{ personId: a, side: 'vendeur' }]);
    const r = await t.avis.submit(await t.invite('f-secret-1', a), { score: 2, text: BAD });
    if (!r.ok) throw new Error(r.code);
    // L'auteur vérifie lui-même, avec son reçu, que l'engagement public désigne son dossier clos.
    expect(r.receipt).toMatchObject({ fileId: 'f-secret-1', closedOn: '2027-03-08' });
    const v = await t.avis.verify(r.code);
    expect(v).toMatchObject({ found: true, valid: true, head: { count: 1 }, review: { code: r.code, score: 2, side: 'vendeur', text: BAD, seq: 1, prevHash: GENESIS_HASH } });
    const list = await t.avis.publicList(t.network.id, t.alexId);
    const shown = JSON.stringify([v, list]);
    for (const secret of [a, 'f-secret-1', 'Ana', 'Durand', 'Dijon', 'REF-', '2027-03-08', t.personId, t.propertyId, '@']) expect(shown).not.toContain(secret);
    expect(Object.keys(v.found ? v.review : {}).sort()).toEqual(['agentId', 'code', 'fileCommitment', 'hash', 'prevHash', 'publishedOn', 'score', 'seq', 'side', 'text']);
    // N'importe qui recalcule l'empreinte depuis ce qui est publié.
    if (!v.found) throw new Error('absent');
    const { hash, ...rest } = v.review;
    expect(await reviewHash(rest)).toBe(hash);
    // Le contrôleur, avec la preuve remise par la conformité, retrouve l'engagement public.
    const proof = await t.avis.auditProof({ role: 'compliance', userId: 'c-1', networkId: t.network.id } as never, r.code);
    if (!proof.ok) throw new Error(proof.code);
    expect(proof.value).toMatchObject({ fileId: 'f-secret-1', closedOn: '2027-03-08' });
    expect(await fileCommitment(proof.value.fileId, proof.value.closedOn, proof.value.salt)).toBe(v.review.fileCommitment);
    expect(await fileCommitment(r.receipt.fileId, r.receipt.closedOn, r.receipt.salt)).toBe(v.review.fileCommitment);
    expect(await fileCommitment('f-autre', '2027-03-08', proof.value.salt)).not.toBe(v.review.fileCommitment);
    // Un code inconnu ou mal formé ne rend rien.
    expect(await t.avis.verify('zzzzzzzzzzzz')).toEqual({ found: false });
    expect(await t.avis.verify("x' OR 1=1")).toEqual({ found: false });
    // Le jour de publication est celui de Paris : à 0 h 30 à Paris, c'est déjà le lendemain.
    const late = await t.client('Eve');
    t.close('f-nuit', '2027-03-08', [{ personId: late, side: 'acquereur' }]);
    const tok = await t.invite('f-nuit', late);
    t.setClock(new Date('2027-03-10T23:30:00.000Z'));
    const night = await t.avis.submit(tok, { score: 4, text: GOOD });
    if (!night.ok) throw new Error(night.code);
    expect((await t.avis.verify(night.code)).found && (await t.avis.verify(night.code))).toMatchObject({ review: { publishedOn: '2027-03-11' } });
    // Au journal : ni le texte, ni la personne, ni le jeton.
    const events = JSON.stringify(await t.journal.bySubject(`agent:${t.alexId}`));
    expect(events).toContain('avis.publie');
    expect(events).not.toContain(a);
    expect(events).not.toContain('déçu');
  });

  it('[R523] un texte refusé ne consomme pas l’invitation ; une seule réponse par client et par dossier ; l’invitation expire', async () => {
    const t = await setup();
    const a = await t.client('Ana', 'Durand');
    const b = await t.client('Bea');
    t.close('f1', '2027-03-08', [
      { personId: a, side: 'vendeur' },
      { personId: b, side: 'acquereur' },
    ]);
    const token = await t.invite('f1', a);
    expect(await t.avis.submit(token, { score: 5, text: `${GOOD} Merci, Ana Durand` })).toEqual({ ok: false, rule: 'R523', code: 'name' });
    // Le nom de l'autre côté du dossier aussi.
    expect(await t.avis.submit(token, { score: 5, text: `${GOOD} Bonne chance à Bea` })).toEqual({ ok: false, rule: 'R523', code: 'name' });
    for (const score of [0, 6, 2.5]) expect(await t.avis.submit(token, { score, text: GOOD })).toMatchObject({ ok: false, code: 'invalid_score' });
    expect((await t.avis.submit(token, { score: 5, text: GOOD })).ok).toBe(true);
    expect(await t.avis.submit(token, { score: 1, text: BAD })).toMatchObject({ ok: false, code: 'used' });
    expect(await t.avis.invite(t.agent, 'f1', a)).toMatchObject({ ok: false, code: 'already_reviewed' });
    // Expiré au bout de 60 jours.
    const late = await t.invite('f1', b);
    t.setClock(new Date(t.now().getTime() + 60 * 86_400_000));
    expect(await t.avis.submit(late, { score: 3, text: GOOD })).toMatchObject({ ok: false, code: 'expired' });
    expect(await t.avis.submit('pas un jeton', { score: 3, text: GOOD })).toMatchObject({ ok: false, code: 'unknown' });
  });

  it('[R520] une fiche réunie du client reçoit l’invitation au nom du client du dossier, une seule fois', async () => {
    const t = await setup();
    const a = await t.client('Ana');
    const a2 = await t.client('Ana');
    const unique = new FicheUnique(t.db, new FicheClient(t.db, { now: t.now }), { now: t.now });
    await unique.merge({ survivorId: a, mergedId: a2, reason: 'même personne' });
    t.close('f1', '2027-03-08', [{ personId: a, side: 'vendeur' }]);
    const r = await t.avis.submit(await t.invite('f1', a2), { score: 4, text: GOOD });
    expect(r.ok).toBe(true);
    expect(await t.avis.invite(t.agent, 'f1', a)).toMatchObject({ ok: false, code: 'already_reviewed' });
  });
});

it('[R522] une chaîne vide ou intacte se vérifie', async () => {
  expect(await verifyChain([], { count: 0, hash: GENESIS_HASH })).toEqual({ ok: true, count: 0 });
  const first: Omit<PublicReview, 'hash'> = { code: 'abcdefghjkmn', agentId: 'ag', seq: 1, side: 'acquereur', score: 1, text: BAD, publishedOn: '2027-01-01', fileCommitment: 'f'.repeat(64), prevHash: GENESIS_HASH };
  const r1 = { ...first, hash: await reviewHash(first) };
  expect(await verifyChain([r1], { count: 1, hash: r1.hash })).toEqual({ ok: true, count: 1 });
  expect(await verifyChain([{ ...r1, text: GOOD }], { count: 1, hash: r1.hash })).toEqual({ ok: false, seq: 1, reason: 'hash' });
});
