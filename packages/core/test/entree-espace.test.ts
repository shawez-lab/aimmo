import { expect, it, vi } from 'vitest';
import { Acces, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, createCaptation, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { CLIENT_SPACE_PURPOSE, EntreeEspace, LINK_REQUEST_ANSWER, type ClientSide } from '../src/espaces/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';
import { enClair, tablesContenant } from './boite-essai.ts';

// Un mardi à 10 h, heure de Paris : dans les heures d'envoi [R01].
const TUESDAY_10H = Date.parse('2027-06-08T08:00:00.000Z');
const DAY = 86_400_000;
const CONSENT = { consentProof: 'accord donné au rendez-vous du 8 juin, pour recevoir le lien de son espace' };

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = TUESDAY_10H;
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const { store, fiche } = createCaptation(db, journal, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const sides = new Map<string, ClientSide[]>();
  const entree = new EntreeEspace(db, journal, { sidesOf: async (_n, personId) => sides.get(personId) ?? [] }, { now });
  const network = await store.createNetwork('Réseau test');
  const alexAgent = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const samAgent = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const as = (role: 'agent' | 'direction' | 'compliance' | 'partner', userId: string) => ({ role, userId, networkId: network.id });
  let n = 0;
  /** Un client inventé d'Alex, avec son adresse, partie à un dossier si demandé. */
  const client = async (side: ClientSide | null = 'vendeur') => {
    const letter = 'ABCDEFGHIJKLMN'[(n += 1)]!;
    const p = await store.createPerson({ networkId: network.id, agentId: alexAgent.id, firstName: `Client${letter}`, lastName: 'Inventé' });
    const email = `client.${letter.toLowerCase()}.invente@example.test`;
    await store.addIdentifier({ networkId: network.id, personId: p.id, kind: 'email', value: email });
    if (side) sides.set(p.id, [side]);
    return { id: p.id, email };
  };
  /** Les jetons rangés dans la boîte d'essai pour cette personne, du plus récent au plus ancien. */
  const tokens = async (personId: string): Promise<string[]> => {
    const rows = await enClair(
      db.all<{ id: string; body: string }>(
        `SELECT m.id, m.body FROM messages m JOIN trial_outbox t ON t.message_id = m.id WHERE m.person_id = ? AND m.body LIKE '%lien de votre espace%' ORDER BY m.occurred_at DESC, m.rowid DESC`,
        [personId],
      ),
    );
    return rows.map((r) => /espace\/([a-z]{40})/.exec(r.body)?.[1] ?? '').filter((t) => t !== '');
  };
  return {
    db,
    journal,
    store,
    fiche,
    acces,
    entree,
    sides,
    network,
    client,
    tokens,
    alex: as('agent', alexAgent.id),
    sam: as('agent', samAgent.id),
    samAgent,
    direction: as('direction', 'dir-1'),
    compliance: as('compliance', 'conf-1'),
    advance: (ms: number) => (clock += ms),
  };
}

describeWithSqlite('EC01 · entrée du client dans son espace', () => {
  it('[R160] [R26] l’agent ouvre l’espace : un lien en essai, rangé en empreinte, qui donne une séance une seule fois', async () => {
    const t = await setup();
    const c = await t.client();
    const invited = await t.entree.invite(t.acces, t.alex, c.id, CONSENT);
    expect(invited).toMatchObject({ ok: true, value: { mode: 'essai' } });
    // L'accord est rangé avec sa preuve [R03].
    expect(await t.db.all('SELECT proof FROM consents WHERE person_id = ? AND purpose = ?', [c.id, CLIENT_SPACE_PURPOSE])).toEqual([{ proof: CONSENT.consentProof }]);
    const [token] = await t.tokens(c.id);
    expect(token).toMatch(/^[a-z]{40}$/);
    // Ni les messages, ni la boîte d'essai, ni le journal, ni aucune table ne gardent le jeton du lien [HX61].
    expect(await tablesContenant(t.db, token!)).toEqual([]);
    // Rien ne part hors de la boîte d'essai ; le jeton n'est rangé nulle part en clair.
    expect(await t.db.all("SELECT 1 FROM messages m WHERE m.body LIKE '%lien de votre espace%' AND m.id NOT IN (SELECT message_id FROM trial_outbox)")).toHaveLength(0);
    expect(JSON.stringify(await t.db.all('SELECT * FROM client_space_links'))).not.toContain(token);
    const opened = await t.entree.open(token);
    expect(opened).toMatchObject({ ok: true, value: { sides: ['vendeur'] } });
    if (!opened.ok) return;
    expect(JSON.stringify(await t.db.all('SELECT * FROM client_space_sessions'))).not.toContain(opened.value.sessionToken);
    expect(await t.entree.session(opened.value.sessionToken)).toMatchObject({ kind: 'client', personId: c.id, networkId: t.network.id, sides: ['vendeur'] });
    // Le lien ne sert qu'une fois.
    expect(await t.entree.open(token)).toEqual({ ok: false, rule: 'R160', code: 'deja_ouvert' });
  });

  it('[R160] [R18] deux ouvertures en même temps n’en font qu’une', async () => {
    const t = await setup();
    const c = await t.client();
    await t.entree.invite(t.acces, t.alex, c.id, CONSENT);
    const [token] = await t.tokens(c.id);
    const results = await Promise.all([t.entree.open(token), t.entree.open(token), t.entree.open(token)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => !r.ok && r.code)).toEqual(['deja_ouvert', 'deja_ouvert']);
    expect(await t.db.all('SELECT id FROM client_space_sessions')).toHaveLength(1);
  });

  it('[R160] un lien expiré ou inconnu est refusé ; la séance expire à 12 heures et se ferme', async () => {
    const t = await setup();
    const c = await t.client();
    await t.entree.invite(t.acces, t.alex, c.id, CONSENT);
    const [late] = await t.tokens(c.id);
    t.advance(31 * 60_000);
    expect(await t.entree.open(late)).toEqual({ ok: false, rule: 'R160', code: 'expire' });
    expect(await t.entree.open('a'.repeat(40))).toEqual({ ok: false, rule: 'R160', code: 'inconnu' });
    expect(await t.entree.open('pas un jeton')).toEqual({ ok: false, rule: 'R160', code: 'inconnu' });
    expect(await t.entree.open(undefined)).toEqual({ ok: false, rule: 'R160', code: 'inconnu' });

    await t.entree.requestLink(t.network.id, c.email);
    const [fresh] = await t.tokens(c.id);
    const opened = await t.entree.open(fresh);
    if (!opened.ok) throw new Error('ouverture');
    t.advance(11 * 3_600_000);
    expect(await t.entree.session(opened.value.sessionToken)).not.toBeNull();
    t.advance(1 * 3_600_000);
    expect(await t.entree.session(opened.value.sessionToken)).toBeNull();

    t.advance(12 * 3_600_000); // le lendemain, dans les heures d'envoi [R01]
    await t.entree.requestLink(t.network.id, c.email);
    const [third] = await t.tokens(c.id);
    const again = await t.entree.open(third);
    if (!again.ok) throw new Error('ouverture');
    await t.entree.close(again.value.sessionToken);
    await t.entree.close(again.value.sessionToken);
    expect(await t.entree.session(again.value.sessionToken)).toBeNull();
    expect(await t.db.all('SELECT session_id FROM client_space_session_closures')).toHaveLength(1);
  });

  it('[R160] une demande de lien répond pareil, adresse connue ou non, sans espace ou au plafond de 3 par 24 heures', async () => {
    const t = await setup();
    const open = await t.client();
    await t.entree.invite(t.acces, t.alex, open.id, CONSENT);
    const noSpace = await t.client();
    const noFile = await t.client();
    await t.entree.invite(t.acces, t.alex, noFile.id, CONSENT);
    t.sides.set(noFile.id, []);
    const answers = [
      await t.entree.requestLink(t.network.id, 'inconnu.invente@example.test'),
      await t.entree.requestLink(t.network.id, noSpace.email),
      await t.entree.requestLink(t.network.id, noFile.email),
      await t.entree.requestLink(t.network.id, 'pas une adresse'),
      await t.entree.requestLink(t.network.id, 42),
      await t.entree.requestLink(t.network.id, open.email.toUpperCase()),
      await t.entree.requestLink(t.network.id, open.email),
      await t.entree.requestLink(t.network.id, open.email),
    ];
    for (const a of answers) expect(a).toEqual(LINK_REQUEST_ANSWER);
    // Une invitation et deux demandes : 3 liens ; la quatrième demande ne range ni n'envoie rien.
    expect(await t.tokens(open.id)).toHaveLength(3);
    expect(await t.db.all('SELECT id FROM client_space_links WHERE person_id = ?', [open.id])).toHaveLength(3);
    expect(await t.tokens(noSpace.id)).toHaveLength(0);
    expect(await t.tokens(noFile.id)).toHaveLength(1);
    // Le motif ne va qu'au journal, en code.
    const statuses = (await t.journal.all()).filter((e) => e.type === 'espaces.demande').map((e) => (e.data as { status: string }).status);
    expect(statuses).toEqual(['inconnu', 'sans_accord', 'sans_dossier', 'inconnu', 'illisible', 'envoye', 'envoye', 'plafond']);
    // Le lendemain, la demande repart.
    t.advance(DAY);
    await t.entree.requestLink(t.network.id, open.email);
    expect(await t.tokens(open.id)).toHaveLength(4);
  });

  it('[R03] [R160] sans accord ni dossier, rien ne part ; l’accord retiré, liens et séances ne valent plus', async () => {
    const t = await setup();
    const c = await t.client();
    expect(await t.entree.invite(t.acces, t.alex, c.id, {})).toEqual({ ok: false, rule: 'R03', code: 'bad_consent' });
    expect(await t.entree.invite(t.acces, t.alex, c.id, { consentProof: '   ' })).toEqual({ ok: false, rule: 'R03', code: 'bad_consent' });
    const lone = await t.client(null);
    expect(await t.entree.invite(t.acces, t.alex, lone.id, CONSENT)).toEqual({ ok: false, rule: 'R161', code: 'no_file' });
    expect(await t.db.all('SELECT id FROM consents WHERE person_id = ?', [lone.id])).toHaveLength(0);
    expect(await t.tokens(c.id)).toHaveLength(0);

    await t.entree.invite(t.acces, t.alex, c.id, CONSENT);
    await t.entree.requestLink(t.network.id, c.email);
    const [unused, first] = await t.tokens(c.id);
    const opened = await t.entree.open(first);
    if (!opened.ok) throw new Error('ouverture');
    const consent = await t.db.first<{ id: string }>('SELECT id FROM consents WHERE person_id = ? AND purpose = ?', [c.id, CLIENT_SPACE_PURPOSE]);
    await t.store.withdrawConsent(consent!.id, new Date(TUESDAY_10H + 60_000));
    expect(await t.entree.session(opened.value.sessionToken)).toBeNull();
    expect(await t.entree.open(unused)).toEqual({ ok: false, rule: 'R160', code: 'sans_accord' });
    expect(await t.entree.requestLink(t.network.id, c.email)).toEqual(LINK_REQUEST_ANSWER);
    expect(await t.tokens(c.id)).toHaveLength(2);
  });

  it('[R160] [EC13] au-delà de 3 liens préparés par l’agent en 24 heures, rien n’est préparé, le refus est dit et écrit au journal', async () => {
    const t = await setup();
    const c = await t.client();
    for (let i = 0; i < 3; i++) expect((await t.entree.invite(t.acces, t.alex, c.id, CONSENT)).ok).toBe(true);
    const refused = await t.entree.invite(t.acces, t.alex, c.id, CONSENT);
    expect(refused).toEqual({ ok: false, rule: 'R160', code: 'plafond' });
    // La réponse ne porte ni lien ni jeton, et rien de plus n'est rangé ni parti.
    expect(JSON.stringify(refused)).not.toMatch(/[a-z]{40}/);
    expect(await t.db.all('SELECT id FROM client_space_links WHERE person_id = ?', [c.id])).toHaveLength(3);
    expect(await t.tokens(c.id)).toHaveLength(3);
    const events = (await t.journal.all()).filter((e) => e.type === 'espaces.invitation');
    expect(events.map((e) => (e.data as { status: string }).status)).toEqual(['envoye', 'envoye', 'envoye', 'plafond']);
    const last = events.at(-1)!;
    expect(last.subject).toBe(`person:${c.id}`);
    expect(last.actor).toBe(`agent:${t.alex.userId}`);
    // Le journal ne porte ni adresse ni jeton [R13].
    expect(JSON.stringify(last)).not.toContain(c.email);
    expect(JSON.stringify(last)).not.toMatch(/[a-z]{40}/);
    // La direction n'a pas de passe-droit : le plafond est celui de la personne, pas celui de l'agent.
    expect(await t.entree.invite(t.acces, t.direction, c.id, CONSENT)).toEqual({ ok: false, rule: 'R160', code: 'plafond' });
    // Passé 24 heures, un nouveau lien peut être préparé.
    t.advance(DAY);
    expect((await t.entree.invite(t.acces, t.alex, c.id, CONSENT)).ok).toBe(true);
  });

  it('[R160] [EC13] le plafond est le même pour les liens préparés et les liens demandés, par personne', async () => {
    const t = await setup();
    const c = await t.client();
    const other = await t.client();
    await t.entree.invite(t.acces, t.alex, c.id, CONSENT);
    await t.entree.requestLink(t.network.id, c.email);
    await t.entree.requestLink(t.network.id, c.email);
    expect(await t.entree.invite(t.acces, t.alex, c.id, CONSENT)).toEqual({ ok: false, rule: 'R160', code: 'plafond' });
    // Une autre personne a son propre compte.
    expect((await t.entree.invite(t.acces, t.alex, other.id, CONSENT)).ok).toBe(true);
    // Dans l'autre sens : les liens préparés comptent pour la demande du client.
    await t.entree.invite(t.acces, t.alex, other.id, CONSENT);
    await t.entree.invite(t.acces, t.alex, other.id, CONSENT);
    await t.entree.requestLink(t.network.id, other.email);
    expect(await t.db.all('SELECT id FROM client_space_links WHERE person_id = ?', [other.id])).toHaveLength(3);
  });

  it('[R160] [EC13] le compte des liens préparés suit les fiches réunies', async () => {
    const t = await setup();
    const a = await t.client();
    const b = await t.client();
    await t.entree.invite(t.acces, t.alex, a.id, CONSENT);
    await t.entree.invite(t.acces, t.alex, a.id, CONSENT);
    await t.entree.invite(t.acces, t.alex, b.id, CONSENT);
    await t.fiche.merge({ survivorId: b.id, mergedId: a.id, reason: 'même personne' });
    expect(await t.entree.invite(t.acces, t.alex, b.id, CONSENT)).toEqual({ ok: false, rule: 'R160', code: 'plafond' });
    // Viser la fiche réunie mène au même compte, sans lien de plus.
    expect(await t.entree.invite(t.acces, t.alex, a.id, CONSENT)).toEqual({ ok: false, rule: 'R160', code: 'plafond' });
    const members = await t.db.all('SELECT id FROM client_space_links WHERE person_id IN (?, ?)', [a.id, b.id]);
    expect(members).toHaveLength(3);
  });

  it('[R160] [R03] [EC13] au plafond, la preuve d’un nouvel accord n’est pas rangée', async () => {
    const t = await setup();
    const c = await t.client();
    for (let i = 0; i < 3; i++) await t.entree.invite(t.acces, t.alex, c.id, CONSENT);
    // L'accord est retiré : sans le plafond, la preuve donnée à ce geste rangerait un nouvel accord.
    const row = await t.db.first<{ id: string }>('SELECT id FROM consents WHERE person_id = ? AND purpose = ?', [c.id, CLIENT_SPACE_PURPOSE]);
    await t.store.withdrawConsent(row!.id, new Date(TUESDAY_10H + 60_000));
    t.advance(120_000);
    const before = await t.db.all('SELECT id FROM consents WHERE person_id = ? AND purpose = ?', [c.id, CLIENT_SPACE_PURPOSE]);
    expect(await t.entree.invite(t.acces, t.alex, c.id, CONSENT)).toEqual({ ok: false, rule: 'R160', code: 'plafond' });
    expect(await t.db.all('SELECT id FROM consents WHERE person_id = ? AND purpose = ?', [c.id, CLIENT_SPACE_PURPOSE])).toHaveLength(before.length);
  });

  it('[R160] [EC13] la garde est dans l’écriture du lien : un premier regard dépassé ne franchit pas le plafond', async () => {
    const t = await setup();
    const c = await t.client();
    for (let i = 0; i < 3; i++) await t.entree.invite(t.acces, t.alex, c.id, CONSENT);
    // Comme un geste parti en même temps : son premier regard a vu de la place, les autres ont écrit depuis.
    vi.spyOn(t.entree as unknown as { atCap: () => Promise<boolean> }, 'atCap').mockResolvedValue(false);
    expect(await t.entree.invite(t.acces, t.alex, c.id, CONSENT)).toEqual({ ok: false, rule: 'R160', code: 'plafond' });
    expect(await t.db.all('SELECT id FROM client_space_links WHERE person_id = ?', [c.id])).toHaveLength(3);
    expect(await t.tokens(c.id)).toHaveLength(3);
    const statuses = (await t.journal.all()).filter((e) => e.type === 'espaces.invitation').map((e) => (e.data as { status: string }).status);
    expect(statuses.at(-1)).toBe('plafond');
  });

  it('[R160] [R01] [EC13] un lien refusé par le contrôle central, jamais remis, ne compte pas au plafond', async () => {
    const t = await setup();
    const c = await t.client();
    // Mardi 22 h, heure de Paris : hors des heures d'envoi, trois essais, rien ne part.
    t.advance(12 * 3_600_000);
    for (let i = 0; i < 3; i++) expect(await t.entree.invite(t.acces, t.alex, c.id, CONSENT)).toMatchObject({ ok: false, code: 'send_refused' });
    expect(await t.tokens(c.id)).toHaveLength(0);
    // Le lendemain à 10 h, dans la même journée glissante : le geste passe, et la demande du client aussi.
    t.advance(12 * 3_600_000);
    expect((await t.entree.invite(t.acces, t.alex, c.id, CONSENT)).ok).toBe(true);
    await t.entree.requestLink(t.network.id, c.email);
    await t.entree.requestLink(t.network.id, c.email);
    expect(await t.tokens(c.id)).toHaveLength(3);
    // Le plafond reste celui des liens remis.
    expect(await t.entree.invite(t.acces, t.alex, c.id, CONSENT)).toEqual({ ok: false, rule: 'R160', code: 'plafond' });
  });

  it('[R160] [EC13] des ouvertures en même temps ne dépassent pas le plafond', async () => {
    const t = await setup();
    const c = await t.client();
    const results = await Promise.all(Array.from({ length: 6 }, () => t.entree.invite(t.acces, t.alex, c.id, CONSENT)));
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(results.filter((r) => !r.ok)).toEqual(Array(3).fill({ ok: false, rule: 'R160', code: 'plafond' }));
    expect(await t.db.all('SELECT id FROM client_space_links WHERE person_id = ?', [c.id])).toHaveLength(3);
  });

  it('[R160] des demandes en même temps ne dépassent pas le plafond de 3 liens', async () => {
    const t = await setup();
    const c = await t.client();
    await t.entree.invite(t.acces, t.alex, c.id, CONSENT);
    const answers = await Promise.all(Array.from({ length: 6 }, () => t.entree.requestLink(t.network.id, c.email)));
    for (const a of answers) expect(a).toEqual(LINK_REQUEST_ANSWER);
    expect(await t.db.all('SELECT id FROM client_space_links WHERE person_id = ?', [c.id])).toHaveLength(3);
    expect(await t.tokens(c.id)).toHaveLength(3);
  });

  it('[R160] [R03] après une fusion, l’accord et les liens d’une fiche réunie valent pour la fiche gardée', async () => {
    const t = await setup();
    const a = await t.client();
    await t.entree.invite(t.acces, t.alex, a.id, CONSENT);
    const [before] = await t.tokens(a.id);
    const opened = await t.entree.open(before);
    if (!opened.ok) throw new Error('ouverture');
    await t.entree.requestLink(t.network.id, a.email);
    const [pending] = await t.tokens(a.id);
    // A est réunie dans B, gardée ; B porte le dossier.
    const b = await t.store.createPerson({ networkId: t.network.id, agentId: t.alex.userId, firstName: 'ClientGardé', lastName: 'Inventé' });
    t.sides.set(b.id, ['vendeur']);
    t.sides.set(a.id, []);
    await t.fiche.merge({ survivorId: b.id, mergedId: a.id, reason: 'même mail' });
    // La séance ouverte avant la fusion lit la fiche gardée.
    expect(await t.entree.session(opened.value.sessionToken)).toMatchObject({ personId: b.id, sides: ['vendeur'] });
    // Un lien donné avant la fusion ouvre la fiche gardée.
    const late = await t.entree.open(pending);
    expect(late).toMatchObject({ ok: true, value: { sides: ['vendeur'] } });
    if (late.ok) expect(await t.entree.session(late.value.sessionToken)).toMatchObject({ personId: b.id });
    // L'adresse mène à B : l'accord rangé sur A vaut, un lien part, et le plafond compte aussi les liens de A.
    await t.entree.requestLink(t.network.id, a.email);
    expect(await t.db.all('SELECT id FROM client_space_links WHERE person_id = ?', [b.id])).toHaveLength(1);
    await t.entree.requestLink(t.network.id, a.email);
    expect(await t.db.all('SELECT id FROM client_space_links WHERE person_id = ?', [b.id])).toHaveLength(1);
    const statuses = (await t.journal.all()).filter((e) => e.type === 'espaces.demande').map((e) => (e.data as { status: string }).status);
    expect(statuses).toEqual(['envoye', 'envoye', 'plafond']);
  });

  it('[R160] une personne qui n’a plus aucun dossier perd sa séance', async () => {
    const t = await setup();
    const c = await t.client('acquereur');
    await t.entree.invite(t.acces, t.alex, c.id, CONSENT);
    const opened = await t.entree.open((await t.tokens(c.id))[0]);
    if (!opened.ok) throw new Error('ouverture');
    expect(await t.entree.session(opened.value.sessionToken)).toMatchObject({ sides: ['acquereur'] });
    t.sides.set(c.id, []);
    expect(await t.entree.session(opened.value.sessionToken)).toBeNull();
  });

  it('[R02] [R04] [R01] un client exclu ne reçoit rien, la nuit non plus : le lien rangé est révoqué', async () => {
    const t = await setup();
    const c = await t.client();
    await t.store.addExclusion({ networkId: t.network.id, agentId: t.alex.userId, personId: c.id, reason: 'stop', notedAt: new Date(TUESDAY_10H - DAY) });
    const refused = await t.entree.invite(t.acces, t.alex, c.id, CONSENT);
    expect(refused).toMatchObject({ ok: false, code: 'send_refused' });
    expect(await t.tokens(c.id)).toHaveLength(0);
    expect(await t.db.all("SELECT code FROM client_space_link_revocations")).toEqual([{ code: 'non_remis' }]);

    const night = await t.client();
    await t.entree.invite(t.acces, t.alex, night.id, CONSENT);
    t.advance(12 * 3_600_000); // 22 h, heure de Paris
    await t.entree.requestLink(t.network.id, night.email);
    expect(await t.tokens(night.id)).toHaveLength(1);
    const statuses = (await t.journal.all()).filter((e) => e.type === 'espaces.demande').map((e) => (e.data as { status: string }).status);
    expect(statuses).toEqual(['refuse']);
  });

  it('[R16] seul l’agent du client ou la direction ouvre son espace', async () => {
    const t = await setup();
    const c = await t.client();
    expect(await t.entree.invite(t.acces, t.sam, c.id, CONSENT)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.entree.invite(t.acces, t.compliance, c.id, CONSENT)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.entree.invite(t.acces, { role: 'partner', userId: 'p-1', networkId: t.network.id }, c.id, CONSENT)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    const other = await t.store.createNetwork('Autre réseau');
    expect(await t.entree.invite(t.acces, { role: 'direction', userId: 'dir-2', networkId: other.id }, c.id, CONSENT)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.tokens(c.id)).toHaveLength(0);
    expect(await t.entree.invite(t.acces, t.direction, c.id, CONSENT)).toMatchObject({ ok: true });
  });

  it('[R13] le journal ne porte ni adresse, ni prénom, ni jeton', async () => {
    const t = await setup();
    const c = await t.client();
    await t.entree.invite(t.acces, t.alex, c.id, CONSENT);
    await t.entree.requestLink(t.network.id, c.email);
    await t.entree.requestLink(t.network.id, 'inconnu.invente@example.test');
    const all = await t.tokens(c.id);
    const opened = await t.entree.open(all[0]);
    await t.entree.open(all[0]);
    if (opened.ok) await t.entree.close(opened.value.sessionToken);
    const text = JSON.stringify((await t.journal.all()).filter((e) => e.type.startsWith('espaces.')));
    expect(text).toContain('espaces.ouverture');
    for (const secret of [c.email, 'inconnu.invente', 'ClientB', CONSENT.consentProof, ...all, opened.ok ? opened.value.sessionToken : 'x']) {
      expect(text).not.toContain(secret);
    }
  });

  it('[R160] [R17] liens, ouvertures et séances ne s’effacent ni ne se réécrivent', async () => {
    const t = await setup();
    const c = await t.client();
    await t.entree.invite(t.acces, t.alex, c.id, CONSENT);
    await t.entree.open((await t.tokens(c.id))[0]);
    for (const table of ['client_space_links', 'client_space_link_uses', 'client_space_sessions']) {
      await expect(t.db.run(`DELETE FROM ${table}`)).rejects.toThrow(/rien ne s'efface/);
    }
    await expect(t.db.run("UPDATE client_space_links SET expires_at = '2099-01-01T00:00:00.000Z'")).rejects.toThrow(/ne change plus/);
    await expect(t.db.run("UPDATE client_space_sessions SET expires_at = '2099-01-01T00:00:00.000Z'")).rejects.toThrow(/ne change plus/);
  });

  it('refuse une adresse d’espace qui n’est pas en https, porte un chiffre ou ne finit pas par « / »', async () => {
    const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
    const journal = new SqlJournalStore(db);
    const parties = { sidesOf: async () => [] };
    for (const baseUrl of ['http://app.aimmo.fr/espace/', 'https://app.aimmo.fr/espace', 'https://app2.aimmo.fr/espace/', 'https://app.aimmo.fr/espace/?a=b/']) {
      expect(() => new EntreeEspace(db, journal, parties, { baseUrl })).toThrow();
    }
    expect(() => new EntreeEspace(db, journal, parties, { settings: { linkMinutes: 0 } })).toThrow();
    expect(() => new EntreeEspace(db, journal, parties, { settings: { linksPerDay: 50 } })).toThrow();
  });

  it('[R03] un accord redonné est rangé quand la ligne ouverte est plus ancienne qu’un retrait (AC07), et un accord qui compte n’est pas doublé', async () => {
    const t = await setup();
    const c = await t.client();
    // Un retrait sur la fiche, un accord plus ancien resté ouvert sur son doublon, puis la fusion.
    const twin = await t.store.createPerson({ networkId: t.network.id, firstName: 'Doublon' });
    await t.store.addConsent({ networkId: t.network.id, personId: twin.id, purpose: CLIENT_SPACE_PURPOSE, channel: 'email', proof: 'preuve inventée', givenAt: new Date('2020-01-02T00:00:00.000Z') });
    const old = await t.store.addConsent({ networkId: t.network.id, personId: c.id, purpose: CLIENT_SPACE_PURPOSE, channel: 'email', proof: 'preuve inventée', givenAt: new Date('2020-01-01T00:00:00.000Z') });
    await t.store.withdrawConsent(old.id, new Date('2020-02-01T00:00:00.000Z'));
    const unique = new FicheUnique(t.db, new FicheClient(t.db));
    await unique.merge({ survivorId: c.id, mergedId: twin.id, reason: 'identifiant commun' });
    expect(await unique.hasConsentInForce(c.id, CLIENT_SPACE_PURPOSE, 'email')).toBe(false);
    const lines = () => t.db.all<{ id: string }>('SELECT id FROM consents WHERE person_id = ? AND purpose = ?', [c.id, CLIENT_SPACE_PURPOSE]);
    expect((await t.entree.invite(t.acces, t.alex, c.id, CONSENT)).ok).toBe(true);
    expect(await lines()).toHaveLength(2);
    await t.entree.invite(t.acces, t.alex, c.id, CONSENT);
    expect(await lines()).toHaveLength(2);
    expect(await unique.hasConsentInForce(c.id, CLIENT_SPACE_PURPOSE, 'email')).toBe(true);
  });
});

describeWithSqlite('RC61 · où en est le plafond des liens, dit à l’agent', () => {
  it('[R160] sous le plafond : le compte et aucune heure d’attente', async () => {
    const t = await setup();
    const c = await t.client();
    const empty = await t.entree.linkAllowance(t.acces, t.alex, c.id);
    expect(empty).toMatchObject({ ok: true, value: { limit: 3, counted: 0, requested: 0, prepared: 0, opened: 0, nextAt: null, requestsUnopened: false } });
    await t.entree.invite(t.acces, t.alex, c.id, CONSENT);
    await t.entree.requestLink(t.network.id, c.email);
    const r = await t.entree.linkAllowance(t.acces, t.alex, c.id);
    expect(r).toMatchObject({ ok: true, value: { counted: 2, requested: 1, prepared: 1, opened: 0, nextAt: null, requestsUnopened: false } });
  });

  it('[R160] au plafond : l’heure où le plus ancien lien sort des 24 heures, et un lien préparé à cette heure passe', async () => {
    const t = await setup();
    const c = await t.client();
    for (let i = 0; i < 3; i++) {
      expect((await t.entree.invite(t.acces, t.alex, c.id, CONSENT)).ok).toBe(true);
      t.advance(3_600_000);
    }
    const oldest = (await t.db.first<{ created_at: string }>('SELECT created_at FROM client_space_links WHERE person_id = ? ORDER BY created_at LIMIT 1', [c.id]))!;
    const r = await t.entree.linkAllowance(t.acces, t.direction, c.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ counted: 3, prepared: 3, requested: 0, requestsUnopened: false });
    expect(r.value.nextAt).toBe(new Date(Date.parse(oldest.created_at) + DAY).toISOString());
    // Avant cette heure, le refus ; à cette heure, le lien passe.
    expect(await t.entree.invite(t.acces, t.alex, c.id, CONSENT)).toEqual({ ok: false, rule: 'R160', code: 'plafond' });
    const wait = Date.parse(r.value.nextAt!) - Date.parse(r.value.checkedAt);
    t.advance(wait);
    expect((await t.entree.invite(t.acces, t.alex, c.id, CONSENT)).ok).toBe(true);
    const after = await t.entree.linkAllowance(t.acces, t.alex, c.id);
    expect(after).toMatchObject({ ok: true, value: { counted: 3 } });
  });

  it('[R160] au plafond par des demandes du site jamais ouvertes : dit ; une ouverte : non', async () => {
    const t = await setup();
    const c = await t.client();
    await t.entree.invite(t.acces, t.alex, c.id, CONSENT);
    t.advance(DAY);
    for (let i = 0; i < 3; i++) await t.entree.requestLink(t.network.id, c.email);
    const r = await t.entree.linkAllowance(t.acces, t.alex, c.id);
    expect(r).toMatchObject({ ok: true, value: { counted: 3, requested: 3, prepared: 0, opened: 0, requestsUnopened: true } });
    // Le client ouvre l'un d'eux : ce n'est plus le signe d'un autre que lui.
    const [token] = await t.tokens(c.id);
    expect((await t.entree.open(token)).ok).toBe(true);
    expect(await t.entree.linkAllowance(t.acces, t.alex, c.id)).toMatchObject({ ok: true, value: { opened: 1, requestsUnopened: false } });
  });

  it('[R160] un lien préparé parmi les demandes : le plafond n’est pas pris par le site seul', async () => {
    const t = await setup();
    const c = await t.client();
    await t.entree.invite(t.acces, t.alex, c.id, CONSENT);
    await t.entree.requestLink(t.network.id, c.email);
    await t.entree.requestLink(t.network.id, c.email);
    expect(await t.entree.linkAllowance(t.acces, t.alex, c.id)).toMatchObject({ ok: true, value: { counted: 3, requested: 2, prepared: 1, requestsUnopened: false } });
  });

  it('[R160] fiches réunies comptées, lien non remis par le contrôle central non compté', async () => {
    const t = await setup();
    const a = await t.client();
    const b = await t.client();
    // Mardi 22 h, heure de Paris : rien ne part, rien ne compte.
    t.advance(12 * 3_600_000);
    expect(await t.entree.invite(t.acces, t.alex, a.id, CONSENT)).toMatchObject({ ok: false, code: 'send_refused' });
    t.advance(12 * 3_600_000);
    await t.entree.invite(t.acces, t.alex, a.id, CONSENT);
    await t.entree.invite(t.acces, t.alex, b.id, CONSENT);
    await t.fiche.merge({ survivorId: b.id, mergedId: a.id, reason: 'même personne' });
    expect(await t.entree.linkAllowance(t.acces, t.alex, b.id)).toMatchObject({ ok: true, value: { counted: 2, nextAt: null } });
    expect(await t.entree.linkAllowance(t.acces, t.alex, a.id)).toMatchObject({ ok: true, value: { counted: 2 } });
  });

  it('[R16] un autre agent, un partenaire ou la conformité ne lisent rien', async () => {
    const t = await setup();
    const c = await t.client();
    await t.entree.invite(t.acces, t.alex, c.id, CONSENT);
    const sam = await t.entree.linkAllowance(t.acces, t.sam, c.id);
    expect(sam).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.entree.linkAllowance(t.acces, { role: 'partner', userId: 'p-1', networkId: t.network.id }, c.id)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.entree.linkAllowance(t.acces, t.compliance, c.id)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.entree.linkAllowance(t.acces, t.alex, '')).toMatchObject({ ok: false });
  });

  it('[R13] ni adresse ni jeton dans la réponse, rien au journal que la lecture de la fiche', async () => {
    const t = await setup();
    const c = await t.client();
    for (let i = 0; i < 3; i++) await t.entree.requestLink(t.network.id, c.email);
    await t.entree.invite(t.acces, t.alex, c.id, CONSENT);
    const before = (await t.journal.all()).length;
    const r = await t.entree.linkAllowance(t.acces, t.alex, c.id);
    expect(r.ok).toBe(true);
    const text = JSON.stringify(r);
    expect(text).not.toContain(c.email);
    expect(text).not.toMatch(/[a-z]{40}/);
    for (const token of await t.tokens(c.id)) expect(text).not.toContain(token);
    expect(Object.keys(r.ok ? r.value : {}).sort()).toEqual(['checkedAt', 'counted', 'limit', 'nextAt', 'opened', 'prepared', 'requested', 'requestsUnopened']);
    // Seule la lecture de la fiche, comme pour tout geste sous les droits [R16] : rien sur les liens.
    expect((await t.journal.all()).slice(before).map((e) => e.type)).toEqual(['fiche.lue']);
  });
});
