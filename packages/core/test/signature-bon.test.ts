import { expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, RendezVous, SignatureBon, SqlJournalStore, Visites, applyMigrations, fromSyncSqlite, renderSlipCopy, type SqlDatabase } from '../src/index.ts';
import { BUDGETS, budgetProblems, htmlProblems } from '../src/design/audit.ts';
import { MASKED_SECRET } from '../src/envoi/controle.ts';
import { enClair, tablesContenant } from './boite-essai.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// AU075 · Le bon de visite signé sans papier. Réseau, agents, vendeur, visiteurs et biens inventés.
const MONDAY_9H = Date.parse('2026-12-07T08:00:00.000Z');
const HOUR = 3_600_000;
const WEEK = { weekly: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: '09:00', to: '19:00' })) };
const TEMPLATE = 'Bon de visite : {{visiteur.nom}} visite {{bien.reference}} le {{visite.date}}.';

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = MONDAY_9H;
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const rdv = new RendezVous(db, journal, { now });
  const diffusion = { canDiffuse: async () => ({ allowed: true, reason: 'allowed' }) };
  const visites = new Visites(db, journal, acces, { diffusion, rendezVous: rdv, now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const as = (role: 'agent' | 'direction', userId: string) => ({ role, userId, networkId: network.id });
  await rdv.setAvailability(as('agent', alex.id), WEEK);
  await visites.createSlipTemplate(as('direction', 'd1'), TEMPLATE);
  const seller = await store.createPerson({ networkId: network.id, agentId: sam.id, firstName: 'Victor', lastName: 'Vendeur' });
  const p = await store.createProperty({ networkId: network.id, agentId: sam.id, reference: 'B1', kind: 'home', city: 'Talant', priceEur: 250_000, surfaceM2: 90, rooms: 4, status: 'available' });
  const issued: string[] = [];
  let tokens = 0;
  let codes = 0;
  const options = {
    now,
    signUrl: (t: string) => `https://aimmo.example.test/visite/signer/${t}`,
    copyUrl: (t: string) => `https://aimmo.example.test/visite/exemplaire/${t}`,
    newToken: () => {
      tokens += 1;
      const t = tokens.toString(16).padStart(64, 'b');
      issued.push(t);
      return t;
    },
    newCode: () => String(234567 + codes++),
  };
  const signature = new SignatureBon(db, journal, visites, options);
  /** La même signature, sans page publique servie : ni lien de signature à distance, ni lien d'exemplaire. */
  const { signUrl: _s, copyUrl: _c, ...unserved } = options;
  const withoutPages = new SignatureBon(db, journal, visites, unserved);
  let n = 0;
  /** Un visiteur inventé d'Alex, avec son téléphone et son mail, et sa visite du bien demain. */
  const visit = async (o: { phone?: boolean; email?: boolean } = {}) => {
    n += 1;
    const buyer = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Inès', lastName: `Durand${n}` });
    if (o.phone !== false) await store.addIdentifier({ networkId: network.id, personId: buyer.id, kind: 'phone', value: `+33 6 00 00 00 ${String(10 + n)}` });
    if (o.email !== false) await store.addIdentifier({ networkId: network.id, personId: buyer.id, kind: 'email', value: `visiteur${n}@example.test` });
    const project = await store.createProject({ networkId: network.id, agentId: alex.id, personId: buyer.id, kind: 'buy' });
    const r = await visites.schedule(as('agent', alex.id), { propertyId: p.id, projectId: project.id, start: new Date(MONDAY_9H + 24 * HOUR + n * 90 * 60_000) });
    if (!r.ok) throw new Error(r.code);
    return { id: r.visit.appointment.id, start: Date.parse(r.visit.appointment.start_at), end: Date.parse(r.visit.appointment.end_at), buyer };
  };
  const outbox = (personId: string) => enClair(db.all<{ id: string; body: string; channel: string }>('SELECT m.id, m.body, m.channel FROM messages m JOIN trial_outbox t ON t.message_id = m.id WHERE m.person_id = ? ORDER BY m.occurred_at, m.created_at', [personId]));
  const copyToken = (body: string) => /exemplaire\/([0-9a-f]{64})/.exec(body)?.[1] ?? '';
  return { db, journal, visites, signature, withoutPages, options, store, network, alex, sam, seller, as, visit, outbox, issued, copyToken, property: p, setClock: (t: number) => (clock = t) };
}

const ACCORD = 'Accord du visiteur pour recevoir le code et l’exemplaire de son bon, recueilli à la visite.';

describeWithSqlite('AU075 · le bon de visite signé sans papier', () => {
  it('[R506] constat reproduit puis réglé : sur place, le visiteur signe sur le téléphone de l’agent, sans papier ni scan', async () => {
    const t = await setup();
    const v = await t.visit();
    const alex = t.as('agent', t.alex.id);
    t.setClock(v.start - 10 * 60_000);
    // Avant AU075, la seule façon de ranger un bon signé : une date et la référence d'un scan.
    const opened = await t.signature.open(alex, v.id, { place: 'sur_place', consentProof: ACCORD });
    expect(opened).toMatchObject({ ok: true, value: { place: 'sur_place', channel: 'sms', mode: 'essai' } });
    // Le code part au téléphone du visiteur, par SMS, par le contrôle central ; rangé masqué [R26, HX61].
    const box = await t.outbox(v.buyer.id);
    expect(box).toHaveLength(1);
    expect(box[0]).toMatchObject({ channel: 'sms' });
    expect(box[0]!.body).toContain('234567');
    expect((await t.db.first<{ body: string }>('SELECT body FROM messages WHERE id = ?', [box[0]!.id]))!.body).toContain(MASKED_SECRET.code);
    expect(await tablesContenant(t.db, '234567')).toEqual([]);
    // L'agent montre le bon à lire, puis le visiteur tape son code et trace sa signature.
    const read = await t.signature.readOnSite(alex, v.id);
    expect(read.ok && read.value.content).toContain('Durand1 visite B1');
    const signed = await t.signature.signOnSite(alex, v.id, { code: '234567', drawing: 'M0 0 L10 10' });
    expect(signed).toMatchObject({ ok: true, value: { copy: 'remis', proof: { place: 'sur_place', method: 'code_et_trace', channel: 'sms', mode: 'essai', realSignature: false } } });
    // Le bon est rangé signé, sans scan, par le visiteur en ligne.
    const slip = await t.visites.slipOf(alex, v.id);
    expect(slip.ok && slip.slip.signedAt).toBe(new Date(v.start - 10 * 60_000).toISOString());
    expect(await t.db.first('SELECT scan_ref, signed_by FROM visit_slips WHERE appointment_id = ?', [v.id])).toEqual({ scan_ref: null, signed_by: 'visiteur:en_ligne' });
    expect(await t.signature.state(alex, v.id)).toMatchObject({ ok: true, value: { status: 'signee', place: 'sur_place', copy: 'remis' } });
    // L'exemplaire s'affiche aussitôt sur l'écran de l'agent : le bon rangé et sa preuve.
    const shown = await t.signature.copyOnSite(alex, v.id);
    expect(shown.ok && shown.value.content).toContain('Durand1 visite B1');
    expect(shown.ok && shown.value.proof.method).toBe('code_et_trace');
    expect(await t.signature.copyOnSite(t.as('agent', t.sam.id), v.id)).toMatchObject({ ok: false, rule: 'R16' });
  });

  it('[R506] sans page publique servie : pas de signature à distance, et la preuve part sans lien inutilisable', async () => {
    const t = await setup();
    const v = await t.visit();
    const alex = t.as('agent', t.alex.id);
    t.setClock(v.end + HOUR);
    expect(await t.withoutPages.open(alex, v.id, { place: 'distance', consentProof: ACCORD })).toEqual({ ok: false, rule: null, code: 'distance_not_served' });
    expect(await t.outbox(v.buyer.id)).toEqual([]);
    expect((await t.withoutPages.open(alex, v.id, { place: 'sur_place', consentProof: ACCORD })).ok).toBe(true);
    const done = await t.withoutPages.signOnSite(alex, v.id, { code: '234567' });
    expect(done).toMatchObject({ ok: true, value: { copy: 'remis', copyLink: false } });
    const slip = await t.db.first<{ content_hash: string }>('SELECT content_hash FROM visit_slips WHERE appointment_id = ?', [v.id]);
    const box = await t.outbox(v.buyer.id);
    expect(box.at(-1)!.body).toContain(`Empreinte du bon signé : ${slip!.content_hash}`);
    expect(box.at(-1)!.body).toContain('montré sur l’écran de votre agent');
    expect(box.at(-1)!.body).not.toMatch(/https?:/);
  });

  it('[R506] une signature remplacée entre la lecture et le rangement : rien n’est rangé, ni le bon ni la signature', async () => {
    const t = await setup();
    const v = await t.visit();
    const alex = t.as('agent', t.alex.id);
    t.setClock(v.start);
    await t.signature.open(alex, v.id, { place: 'sur_place', consentProof: ACCORD });
    // Une autre requête remplace la signature juste avant le lot qui range le bon.
    const racing = Object.assign(Object.create(Object.getPrototypeOf(t.db)), t.db, {
      batch: async (statements: Parameters<NonNullable<SqlDatabase['batch']>>[0]) => {
        await t.db.run(`UPDATE visit_slip_signatures SET status = 'remplacee' WHERE appointment_id = ? AND status = 'ouverte'`, [v.id]);
        return t.db.batch!(statements);
      },
    }) as SqlDatabase;
    const raced = new SignatureBon(racing, t.journal, t.visites, t.options);
    expect(await raced.signOnSite(alex, v.id, { code: '234567' })).toEqual({ ok: false, rule: null, code: 'not_open' });
    expect(await t.db.first('SELECT signed_at, signed_by FROM visit_slips WHERE appointment_id = ?', [v.id])).toEqual({ signed_at: null, signed_by: null });
    expect(await t.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM visit_slip_signatures WHERE appointment_id = ? AND status = 'signee'`, [v.id])).toEqual({ n: 0 });
    // Une nouvelle ouverture signe normalement.
    await t.signature.open(alex, v.id, { place: 'sur_place' });
    expect((await t.signature.signOnSite(alex, v.id, { code: '234568' })).ok).toBe(true);
  });

  it('[R506] le visiteur reçoit son exemplaire : le bon tel qu’il l’a signé, avec sa preuve, sans adresse ni vendeur', async () => {
    const t = await setup();
    const v = await t.visit();
    const alex = t.as('agent', t.alex.id);
    t.setClock(v.start);
    await t.signature.open(alex, v.id, { place: 'sur_place', consentProof: ACCORD });
    const done = await t.signature.signOnSite(alex, v.id, { code: '234567' });
    expect(done.ok).toBe(true);
    const box = await t.outbox(v.buyer.id);
    expect(box).toHaveLength(2);
    expect(box[1]!.body).toContain('Elle permet de vérifier votre exemplaire');
    // Le lien de l'exemplaire est rangé masqué ; le visiteur, qui l'a reçu, l'ouvre.
    const token = t.copyToken(box[1]!.body);
    expect(token).toHaveLength(64);
    expect(await tablesContenant(t.db, token)).toEqual([]);
    const copy = await t.signature.copy(token);
    expect(copy.ok).toBe(true);
    const html = copy.ok ? copy.html : '';
    const slip = await t.db.first<{ content: string; content_hash: string }>('SELECT content, content_hash FROM visit_slips WHERE appointment_id = ?', [v.id]);
    expect(html).toContain('Durand1 visite B1');
    expect(html).toContain(slip!.content_hash);
    expect(html).toContain('Signature d’essai');
    expect(html).toContain('heure de Paris');
    for (const secret of ['Victor', 'Vendeur', 'Sam']) expect(html).not.toContain(secret);
    expect(htmlProblems(html)).toEqual([]);
    expect(budgetProblems({ html }, BUDGETS.page)).toEqual([]);
    // Un lien inconnu, mal formé, ou trop vieux : rien.
    expect(await t.signature.copy('0'.repeat(64))).toEqual({ ok: false, rule: null, code: 'unknown' });
    expect(await t.signature.copy('pas un jeton')).toEqual({ ok: false, rule: null, code: 'unknown' });
    t.setClock(v.start + 366 * 24 * HOUR);
    expect(await t.signature.copy(token)).toEqual({ ok: false, rule: null, code: 'expired' });
  });

  it('[R506] à distance : un lien et un code, chacun dans son message ; le visiteur lit et signe seul', async () => {
    const t = await setup();
    const v = await t.visit();
    const w = await t.visit();
    const alex = t.as('agent', t.alex.id);
    // Avant l'heure de la visite, pas de signature à distance.
    t.setClock(v.start - 60_000);
    expect(await t.signature.open(alex, v.id, { place: 'distance', consentProof: ACCORD })).toEqual({ ok: false, rule: null, code: 'outside_window' });
    t.setClock(v.end + 3 * HOUR);
    const opened = await t.signature.open(alex, v.id, { place: 'distance', consentProof: ACCORD });
    expect(opened).toMatchObject({ ok: true, value: { place: 'distance', channel: 'email' } });
    const box = await t.outbox(v.buyer.id);
    expect(box).toHaveLength(2);
    expect(box[0]!.body).toContain(t.issued[0]);
    expect(box[1]!.body).toContain('234567');
    expect(box[1]!.body).not.toContain(t.issued[0]);
    // Le lien seul ne signe pas : il faut le code.
    const read = await t.signature.readByLink(t.issued[0]);
    expect(read.ok && read.content).toContain('visite B1');
    expect(await t.signature.signByLink(t.issued[0], { code: '000000' })).toEqual({ ok: false, rule: null, code: 'wrong_code' });
    const done = await t.signature.signByLink(t.issued[0], { code: '234567' });
    expect(done).toMatchObject({ ok: true, value: { copy: 'remis', proof: { place: 'distance', method: 'code', channel: 'email' } } });
    // Le lien ne sert plus ; le code non plus.
    expect(await t.signature.readByLink(t.issued[0])).toEqual({ ok: false, rule: null, code: 'already_signed' });
    expect(await t.signature.signByLink(t.issued[0], { code: '234567' })).toEqual({ ok: false, rule: null, code: 'already_signed' });
    // Au-delà de 7 jours après la visite, plus d'ouverture à distance.
    t.setClock(w.end + 8 * 24 * HOUR);
    expect(await t.signature.open(alex, w.id, { place: 'distance', consentProof: ACCORD })).toEqual({ ok: false, rule: null, code: 'outside_window' });
  });

  it('[R506] le code expire, ne sert qu’une fois, et cinq essais faux bloquent ; une nouvelle ouverture remplace l’ancienne', async () => {
    const t = await setup();
    const v = await t.visit();
    const alex = t.as('agent', t.alex.id);
    t.setClock(v.start);
    await t.signature.open(alex, v.id, { place: 'sur_place', consentProof: ACCORD });
    t.setClock(v.start + 11 * 60_000);
    expect(await t.signature.signOnSite(alex, v.id, { code: '234567' })).toEqual({ ok: false, rule: null, code: 'expired' });
    // Une nouvelle ouverture : un nouveau code, l'ancien ne vaut plus rien.
    await t.signature.open(alex, v.id, { place: 'sur_place' });
    expect(await t.signature.signOnSite(alex, v.id, { code: '234567' })).toEqual({ ok: false, rule: null, code: 'wrong_code' });
    for (let i = 0; i < 3; i += 1) expect(await t.signature.signOnSite(alex, v.id, { code: '111111' })).toEqual({ ok: false, rule: null, code: 'wrong_code' });
    expect(await t.signature.signOnSite(alex, v.id, { code: '111111' })).toEqual({ ok: false, rule: null, code: 'blocked' });
    // Bloquée : même le bon code ne signe plus.
    expect(await t.signature.signOnSite(alex, v.id, { code: '234568' })).toEqual({ ok: false, rule: null, code: 'blocked' });
    expect(await t.signature.state(alex, v.id)).toMatchObject({ ok: true, value: { status: 'bloquee' } });
    const slip = await t.visites.slipOf(alex, v.id);
    expect(slip.ok && slip.slip.signedAt).toBeNull();
    // Le tracé est borné ; un code mal formé est un code faux.
    await t.signature.open(alex, v.id, { place: 'sur_place' });
    expect(await t.signature.signOnSite(alex, v.id, { code: '234569', drawing: '' })).toEqual({ ok: false, rule: null, code: 'bad_drawing' });
    expect(await t.signature.signOnSite(alex, v.id, { code: 234569 })).toEqual({ ok: false, rule: null, code: 'wrong_code' });
    expect((await t.signature.signOnSite(alex, v.id, { code: '234569' })).ok).toBe(true);
  });

  it('[R40] [R506] papier et en ligne : le premier qui signe ferme l’autre ; un bon incomplet ne s’ouvre pas', async () => {
    const t = await setup();
    const alex = t.as('agent', t.alex.id);
    const v = await t.visit();
    const w = await t.visit();
    t.setClock(v.start);
    await t.signature.open(alex, v.id, { place: 'sur_place', consentProof: ACCORD });
    // Le papier signé pendant que la signature en ligne est ouverte : celle-ci ne signe plus.
    expect((await t.visites.recordPaperSignature(alex, v.id, { signedAt: new Date(v.start), scanRef: 'bons/scan-1.pdf' })).ok).toBe(true);
    expect(await t.signature.signOnSite(alex, v.id, { code: '234567' })).toEqual({ ok: false, rule: null, code: 'already_signed' });
    expect(await t.signature.open(alex, v.id, { place: 'sur_place' })).toEqual({ ok: false, rule: null, code: 'already_signed' });
    // Signé en ligne d'abord : le papier ne range plus rien.
    t.setClock(w.start);
    await t.signature.open(alex, w.id, { place: 'sur_place', consentProof: ACCORD });
    expect((await t.signature.signOnSite(alex, w.id, { code: '234568' })).ok).toBe(true);
    const paper = await t.visites.recordPaperSignature(alex, w.id, { signedAt: new Date(w.start), scanRef: 'bons/scan-2.pdf' });
    expect(paper).toEqual({ ok: false, rule: null, code: 'signed_online' });
    expect(await t.db.first('SELECT scan_ref FROM visit_slips WHERE appointment_id = ?', [w.id])).toEqual({ scan_ref: null });
    // Un bon incomplet : la base elle-même refuse d'en ouvrir la signature.
    const slip = await t.db.first<{ id: string; network_id: string }>('SELECT id, network_id FROM visit_slips WHERE appointment_id = ?', [w.id]);
    await expect(
      t.db.run(
        `INSERT INTO visit_slip_signatures (id, network_id, appointment_id, slip_id, slip_hash, place, channel, code_hash, code_expires_at, link_expires_at, status, created_by, created_at)
         VALUES ('x', ?, ?, ?, ?, 'sur_place', 'sms', ?, '2026-12-08', '2026-12-08', 'ouverte', 'test', '2026-12-08')`,
        [slip!.network_id, w.id, slip!.id, 'a'.repeat(64), 'c'.repeat(64)],
      ),
    ).rejects.toThrow(/visite sur place seulement/);
    // Une signature close ne change plus, sauf l'issue de l'exemplaire, notée une fois.
    await expect(t.db.run(`UPDATE visit_slip_signatures SET status = 'remplacee' WHERE appointment_id = ? AND status = 'signee'`, [w.id])).rejects.toThrow(/ne change plus/);
    await expect(t.db.run(`UPDATE visit_slip_signatures SET copy_status = 'refuse' WHERE appointment_id = ? AND status = 'signee'`, [w.id])).rejects.toThrow(/ne change plus/);
    await expect(t.db.run(`DELETE FROM visit_slip_signatures`)).rejects.toThrow(/rien ne s'efface/);
  });

  it('[R03] [R16] l’accord du visiteur sur le canal, un téléphone ou un mail, l’agent qui le suit, une visite sur place', async () => {
    const t = await setup();
    const alex = t.as('agent', t.alex.id);
    const v = await t.visit({ phone: false });
    const w = await t.visit();
    t.setClock(v.start);
    expect(await t.signature.open(alex, v.id, { place: 'sur_place', consentProof: ACCORD })).toEqual({ ok: false, rule: null, code: 'no_phone' });
    expect(await t.signature.open(alex, v.id, { place: 'sur_place', channel: 'email' })).toEqual({ ok: false, rule: 'R03', code: 'no_consent' });
    expect(await t.signature.open(alex, v.id, { place: 'ailleurs', consentProof: ACCORD })).toEqual({ ok: false, rule: null, code: 'bad_place' });
    expect(await t.signature.open(alex, v.id, { place: 'sur_place', channel: 'whatsapp', consentProof: ACCORD })).toEqual({ ok: false, rule: null, code: 'bad_channel' });
    // Un autre agent, qui ne suit pas le visiteur : refusé, au journal.
    expect(await t.signature.open(t.as('agent', t.sam.id), v.id, { place: 'sur_place', channel: 'email', consentProof: ACCORD })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.signature.signOnSite(t.as('agent', t.sam.id), v.id, { code: '234567' })).toMatchObject({ ok: false, rule: 'R16' });
    // Un accord retiré ne se redonne pas par la parole de l'agent.
    expect((await t.signature.open(alex, v.id, { place: 'sur_place', channel: 'email', consentProof: ACCORD })).ok).toBe(true);
    await t.db.run('UPDATE consents SET withdrawn_at = ? WHERE person_id = ? AND purpose = ?', [new Date(v.start).toISOString(), v.buyer.id, 'signature_bon_visite']);
    expect(await t.signature.open(alex, v.id, { place: 'sur_place', channel: 'email', consentProof: ACCORD })).toEqual({ ok: false, rule: 'R03', code: 'consent_withdrawn' });
    // Trop tôt sur place.
    t.setClock(w.start - 31 * 60_000);
    expect(await t.signature.open(alex, w.id, { place: 'sur_place', consentProof: ACCORD })).toEqual({ ok: false, rule: null, code: 'outside_window' });
    // Une visite faite à distance garde sa propre signature (HX44).
    t.setClock(w.start);
    await t.db.run('INSERT INTO remote_visits (appointment_id, network_id, property_id, person_id, started_by, started_at) VALUES (?, ?, ?, ?, ?, ?)', [w.id, t.network.id, t.property.id, w.buyer.id, 'test', new Date(w.start).toISOString()]);
    expect(await t.signature.open(alex, w.id, { place: 'sur_place', consentProof: ACCORD })).toEqual({ ok: false, rule: 'R504', code: 'remote_visit' });
  });

  it('[R26] la nuit, le contrôle central refuse : rien ne part, aucun code ne pourra servir', async () => {
    const t = await setup();
    const alex = t.as('agent', t.alex.id);
    const v = await t.visit();
    t.setClock(v.end + 12 * HOUR);
    const night = await t.signature.open(alex, v.id, { place: 'distance', consentProof: ACCORD });
    expect(night).toMatchObject({ ok: false, code: 'send_refused' });
    expect(await t.outbox(v.buyer.id)).toEqual([]);
    expect(await t.signature.state(alex, v.id)).toMatchObject({ ok: true, value: { status: 'aucune' } });
  });
});

it('[R506] l’exemplaire est rendu par le code, sans rien venu d’ailleurs', () => {
  const html = renderSlipCopy('Bon <b>de</b> visite', {
    appointmentId: 'a',
    slipId: 's',
    slipHash: 'f'.repeat(64),
    signedAt: '2026-12-08T09:30:00.000Z',
    place: 'distance',
    method: 'code_et_trace',
    channel: 'email',
    drawingHash: 'e'.repeat(64),
    mode: 'essai',
    realSignature: false,
  });
  expect(html).toContain('Bon &lt;b&gt;de&lt;/b&gt; visite');
  expect(html).toContain('08/12/2026 10:30');
  expect(html).toContain('e'.repeat(64));
  expect(htmlProblems(html)).toEqual([]);
});
