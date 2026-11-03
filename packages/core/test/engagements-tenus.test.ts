import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '../src/index.ts';
import { EngagementsTenus, SERVICE_PROMISES, type ServicePromiseCode } from '../src/pilotage/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Tout est inventé : réseau, messages, visites, offres, encaissements. Clés étrangères coupées par le test.
const T = (s: string) => `2027-06-${s}.000Z`;

async function setup(nowIso = '2027-07-20T10:00:00.000Z') {
  const raw = openMemoryDatabase();
  const db: SqlDatabase = fromSyncSqlite(raw);
  await applyMigrations(db, loadMigrations());
  raw.exec('PRAGMA foreign_keys = OFF');
  let clock = new Date(nowIso);
  const now = (): Date => clock;
  const journal = new SqlJournalStore(db);
  const network = await new FicheClient(db, { now }).createNetwork('Réseau test');
  const net = network.id;
  const as = (role: string, userId = 'u1'): Viewer => ({ role, userId, networkId: net }) as Viewer;
  const ind = new EngagementsTenus(db, journal, { now });
  let n = 0;
  const id = () => `x${(n += 1)}`;
  const inbound = async (receivedAt: string, opts: { conv?: string | null; kind?: string; person?: string; network?: string } = {}) => {
    const i = id();
    await db.run("INSERT INTO inbound_messages (id, network_id, dedup_key, channel, kind, conversation_ref, status, person_id, received_at, created_at) VALUES (?, ?, ?, 'email', ?, ?, ?, ?, ?, ?)", [i, opts.network ?? net, i, opts.kind ?? 'email', opts.conv ?? null, opts.kind === 'unreadable' ? 'unreadable' : 'processed', opts.person ?? null, receivedAt, receivedAt]);
    return i;
  };
  const claim = (inboundId: string, outcome: string, at: string) => db.run('INSERT INTO first_reply_claims (claim_key, inbound_id, claim_id, outcome, created_at) VALUES (?, ?, ?, ?, ?)', [id(), inboundId, id(), outcome, at]);
  /** Un message sorti : `box` le laisse en boîte d'essai, `failed` en panne. */
  const out = async (person: string | null, at: string, opts: { author?: string; box?: boolean | undefined; failed?: boolean | undefined } = {}) => {
    const m = id();
    await db.run("INSERT INTO messages (id, network_id, person_id, channel, direction, author_kind, body, occurred_at, created_at) VALUES (?, ?, ?, 'email', 'out', ?, 'texte', ?, ?)", [m, net, person ?? 'personne', opts.author ?? 'ai', at, at]);
    if (opts.box) await db.run("INSERT INTO trial_outbox (message_id, channel, created_at) VALUES (?, 'email', ?)", [m, at]);
    if (opts.failed) await db.run("INSERT INTO send_log (id, network_id, person_id, message_id, channel, kind, outcome, reason, occurred_at, created_at) VALUES (?, ?, ?, ?, 'email', 'k', 'failed', 'panne', ?, ?)", [id(), net, person ?? 'personne', m, at, at]);
    return m;
  };
  const appointment = async (kind: string, status: string, endAt: string, propertyId: string | null = null) => {
    const i = id();
    await db.run("INSERT INTO appointments (id, network_id, agent_id, person_id, property_id, kind, start_at, end_at, status, token_hash, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'agent', ?, ?)", [i, net, 'a1', 'p1', propertyId, kind, new Date(Date.parse(endAt) - 3_600_000).toISOString(), endAt, status, i, endAt, endAt]);
    return i;
  };
  const read = async (month = '2027-06') => {
    const r = await ind.ofMonth(as('direction'), month);
    if (!r.ok) throw new Error(r.code);
    return r.value;
  };
  const line = async (code: ServicePromiseCode, month?: string) => (await read(month)).lines.find((l) => l.code === code)!;
  return { db, net, as, ind, id, inbound, claim, out, appointment, read, line, journal, setClock: (iso: string) => { clock = new Date(iso); } };
}

describeWithSqlite('IN07 · engagements de service tenus', () => {
  it('[R216] la liste du cahier, dans son ordre, et un mois vide dit vide : jamais zéro, jamais 100 %', async () => {
    const t = await setup();
    const r = await t.read();
    expect(r.lines.map((l) => l.code)).toEqual(SERVICE_PROMISES.map((p) => p.code));
    expect(r.lines).toHaveLength(9);
    for (const l of r.lines) expect(l.kept).toEqual({ numerator: 0, denominator: 0, bp: null });
    expect(r.overall.bp).toBeNull();
  });

  it('[R216] réponse en une minute : 60 s tenu, 61 s manqué, sans réponse manqué, le premier message de la conversation seul', async () => {
    const t = await setup();
    const answered = async (person: string, received: string, replied: string, conv: string | null = null) => {
      await t.claim(await t.inbound(received, { conv, person }), 'sent', received);
      await t.out(person, replied);
    };
    await answered('p1', T('10T10:00:00'), T('10T10:01:00'), 'c1');
    await t.inbound(T('10T10:05:00'), { conv: 'c1', person: 'p1' }); // la suite de la conversation : pas un cas
    await answered('p2', T('11T10:00:00'), T('11T10:01:01'));
    await t.inbound(T('12T10:00:00'), { person: 'p3' });
    await t.inbound(T('12T11:00:00'), { kind: 'unreadable', person: 'p4' });
    const l = await t.line('reponse_minute');
    expect(l.kept).toEqual({ numerator: 1, denominator: 3, bp: 3333 });
    expect(l.missedDays).toEqual(['2027-06-11', '2027-06-12']);
  });

  it('[R216] une réponse restée en boîte d’essai n’est pas tenue : à part, jamais 100 % ; en retard, manquée ; en panne, manquée', async () => {
    const t = await setup();
    await t.claim(await t.inbound(T('10T10:00:00'), { person: 'p1' }), 'sent', T('10T10:00:00'));
    await t.out('p1', T('10T10:00:10'), { box: true });
    await t.claim(await t.inbound(T('11T10:00:00'), { person: 'p2' }), 'sent', T('11T10:00:00'));
    await t.out('p2', T('11T10:05:00'), { box: true });
    await t.claim(await t.inbound(T('12T10:00:00'), { person: 'p3' }), 'sent', T('12T10:00:00'));
    await t.out('p3', T('12T10:00:10'), { failed: true });
    const r = await t.read();
    const l = r.lines.find((x) => x.code === 'reponse_minute')!;
    expect(l.inTrial).toBe(1);
    expect(l.kept).toEqual({ numerator: 0, denominator: 2, bp: 0 });
    expect(r.overall.numerator).toBe(0);
  });

  it('[R216] seule une réponse de l’agent ou la réponse partie de ce message comptent : une réservation seule, ou une alerte, non', async () => {
    const t = await setup();
    await t.inbound(T('10T10:00:00'), { person: 'p1' });
    await t.out('p1', T('10T10:00:30'), { author: 'agent' });
    await t.claim(await t.inbound(T('11T10:00:00'), { person: 'p2' }), 'sent', T('11T10:00:01')); // réservation sans message
    await t.inbound(T('13T10:00:00'), { person: 'p3' });
    await t.out('p3', T('13T10:00:30'), { author: 'system' }); // une alerte
    const l = await t.line('reponse_minute');
    expect(l.kept).toEqual({ numerator: 1, denominator: 3, bp: 3333 });
    expect(l.setAside).toBe(0);
  });

  it('[R216] [R02] [R21] se taire est la règle : exclu, silence au rattachement, agent déjà en contact sont à part ; tout autre refus est manqué', async () => {
    const t = await setup();
    // Exclusion active ; levée avant le message, elle ne vaut plus.
    const exclude = (person: string, noted: string, lifted: string | null) => t.db.run("INSERT INTO exclusions (id, network_id, person_id, reason, noted_at, lifted_at, created_at) VALUES (?, ?, ?, 'stop', ?, ?, ?)", [t.id(), t.net, person, noted, lifted, noted]);
    await exclude('p1', T('01T10:00:00'), null);
    await t.claim(await t.inbound(T('10T10:00:00'), { person: 'p1' }), 'refused', T('10T10:00:01'));
    await exclude('p2', T('01T10:00:00'), T('05T10:00:00'));
    await t.claim(await t.inbound(T('11T10:00:00'), { person: 'p2' }), 'refused', T('11T10:00:01'));
    const silenced = await t.inbound(T('12T10:00:00'), { person: 'p3' });
    await t.db.run("INSERT INTO attach_log (id, network_id, inbound_id, person_id, outcome, silenced, reason, occurred_at, created_at) VALUES (?, ?, ?, 'p3', 'matched', 1, 'r', ?, ?)", [t.id(), t.net, silenced, T('12T10:00:00'), T('12T10:00:00')]);
    await t.out('p4', T('09T10:00:00'), { author: 'agent' });
    await t.inbound(T('13T10:00:00'), { person: 'p4' });
    await t.claim(await t.inbound(T('14T10:00:00'), { person: 'p5' }), 'refused', T('14T10:00:01')); // aucun texte ne passe
    const l = await t.line('reponse_minute');
    expect(l.setAside).toBe(3);
    expect(l.kept).toEqual({ numerator: 0, denominator: 2, bp: 0 });
    expect(l.missedDays).toEqual(['2027-06-11', '2027-06-14']);
  });

  it('[R216] rappel d’un contact chaud : le jour de Paris, minuit à Paris et non en temps universel', async () => {
    const t = await setup();
    const task = (created: string, done: string | null) => t.db.run("INSERT INTO callback_tasks (id, network_id, person_id, qualification_id, dedup_key, reason, due_at, created_at, done_at) VALUES (?, ?, 'p', 'q', ?, 'r', ?, ?, ?)", [t.id(), t.net, t.id(), created, created, done]);
    await task(T('10T09:00:00'), T('10T21:30:00')); // 23 h 30 à Paris : le même jour
    await task(T('11T09:00:00'), T('11T22:30:00')); // 0 h 30 à Paris le 12 : manqué
    await task(T('12T09:00:00'), null);
    const l = await t.line('rappel_chaud');
    expect(l.kept).toEqual({ numerator: 1, denominator: 3, bp: 3333 });
    expect(l.missedDays).toEqual(['2027-06-11', '2027-06-12']);
  });

  it('[R216] [R25] rappel : deux fiches réunies font un cas, et le rappel fait sur l’une vaut ; une personne exclue ce jour-là est à part', async () => {
    const t = await setup();
    const task = (person: string, created: string, done: string | null) => t.db.run("INSERT INTO callback_tasks (id, network_id, person_id, qualification_id, dedup_key, reason, due_at, created_at, done_at) VALUES (?, ?, ?, 'q', ?, 'r', ?, ?, ?)", [t.id(), t.net, person, t.id(), created, created, done]);
    await t.db.run("INSERT INTO person_merges (id, network_id, survivor_id, merged_id, reason, merged_at, created_at) VALUES ('f1', ?, 'p1', 'p2', 'r', ?, ?)", [t.net, T('10T09:30:00'), T('10T09:30:00')]);
    await t.db.run("INSERT INTO person_merges (id, network_id, survivor_id, merged_id, reason, merged_at, undone_at, created_at) VALUES ('f2', ?, 'p5', 'p6', 'r', ?, ?, ?)", [t.net, T('10T09:30:00'), T('10T09:40:00'), T('10T09:30:00')]);
    await task('p1', T('10T09:00:00'), T('10T10:00:00'));
    await task('p2', T('10T09:10:00'), null);
    await task('p5', T('11T09:00:00'), T('11T10:00:00')); // fusion défaite : deux cas
    await task('p6', T('11T09:10:00'), null);
    await task('p7', T('12T09:00:00'), null);
    await t.db.run("INSERT INTO exclusions (id, network_id, person_id, reason, noted_at, created_at) VALUES ('x', ?, 'p7', 'stop', ?, ?)", [t.net, T('12T14:00:00'), T('12T14:00:00')]);
    const l = await t.line('rappel_chaud');
    expect(l.kept).toEqual({ numerator: 2, denominator: 3, bp: 6667 });
    expect(l.setAside).toBe(1);
  });

  it('[R216] avis de valeur : 48 h après la visite, un envoi d’avant la visite ne vaut pas, une visite annulée ne compte pas', async () => {
    const t = await setup();
    const report = async (propertyId: string, sentAt: string) => {
      const i = t.id();
      await t.db.run("INSERT INTO valuation_reports (id, network_id, property_id, status, computed, computed_low, computed_high, text, text_by, created_at, updated_at, validated_by, validated_at) VALUES (?, ?, ?, 'validated', '{}', 1, 2, 't', 'agent', ?, ?, 'a', ?)", [i, t.net, propertyId, sentAt, sentAt, sentAt]);
      await t.db.run("INSERT INTO valuation_deliveries (report_id, network_id, person_id, channel, sent_at, noted_by) VALUES (?, ?, 'p', 'email', ?, 'a')", [i, t.net, sentAt]);
    };
    await t.appointment('estimation', 'honored', T('10T10:00:00'), 'b1');
    await report('b1', T('12T10:00:00'));
    await t.appointment('estimation', 'booked', T('11T10:00:00'), 'b2');
    await report('b2', T('13T10:00:01'));
    await t.appointment('estimation', 'honored', T('14T10:00:00'), 'b3');
    await report('b3', T('01T10:00:00'));
    await t.appointment('estimation', 'cancelled', T('15T10:00:00'), 'b4');
    await t.appointment('estimation', 'honored', T('16T10:00:00'), null);
    const l = await t.line('avis_48h');
    expect(l.kept).toEqual({ numerator: 1, denominator: 3, bp: 3333 });
    expect(l.missedDays).toEqual(['2027-06-11', '2027-06-14']);
    expect(l.setAside).toBe(1);
  });

  it('[R216] compte rendu : parti au vendeur sous 24 h ; brouillon, refusé, en retard ou absent sont manqués ; en essai à part', async () => {
    const t = await setup();
    const report = async (appointmentId: string, status: string, delivery: string | null, messageId: string | null) => {
      await t.db.run("INSERT INTO visit_reports (appointment_id, network_id, dictation, status, validated_by, validated_at, delivery_status, message_id, created_by, created_at, updated_at) VALUES (?, ?, 'd', ?, 'a', ?, ?, ?, 'a', ?, ?)", [appointmentId, t.net, status, status === 'valide' ? T('01T00:00:00') : null, delivery, messageId, T('01T00:00:00'), T('01T00:00:00')]);
    };
    await report(await t.appointment('visite', 'honored', T('10T10:00:00')), 'valide', 'sent', await t.out('v', T('11T10:00:00')));
    await report(await t.appointment('visite', 'booked', T('11T10:00:00')), 'valide', 'sent', await t.out('v', T('12T10:00:01')));
    await report(await t.appointment('visite', 'honored', T('12T10:00:00')), 'brouillon', null, null);
    await report(await t.appointment('visite', 'honored', T('13T10:00:00')), 'valide', 'refused', null);
    await t.appointment('visite', 'honored', T('14T10:00:00'));
    await t.appointment('visite', 'cancelled', T('15T10:00:00'));
    await report(await t.appointment('visite', 'honored', T('16T10:00:00')), 'valide', 'sent', await t.out('v', T('16T11:00:00'), { box: true }));
    const l = await t.line('compte_rendu_24h');
    expect(l.kept).toEqual({ numerator: 1, denominator: 5, bp: 2000 });
    expect(l.inTrial).toBe(1);
  });

  it('[R216] point : dû le lundi qui suit sa semaine ; préparé et parti un mardi manqué ; mandat signé après ce lundi à part ; ce lundi fait le mois', async () => {
    const t = await setup();
    const point = async (mandate: string, week: string, status: string, delivery: string | null, messageId: string | null, signed = '2027-01-01T10:00:00.000Z') => {
      await t.db.run("INSERT OR IGNORE INTO mandates (id, network_id, agent_id, person_id, signed_at, source_kind, recorded_by, created_at) VALUES (?, ?, 'a', 'p', ?, 'referral', 'x', ?)", [mandate, t.net, signed, signed]);
      await t.db.run("INSERT INTO weekly_points (mandate_id, week, network_id, property_id, person_id, agent_id, figures, status, delivery_status, message_id, created_at, updated_at) VALUES (?, ?, ?, 'b', 'p', 'a', '{}', ?, ?, ?, ?, ?)", [mandate, week, t.net, status, delivery, messageId, T('01T00:00:00'), T('01T00:00:00')]);
    };
    await point('m1', '2027-05-31', 'valide', 'sent', await t.out('v', T('07T15:00:00'))); // lundi 7 juin
    await point('m1', '2027-06-07', 'valide', 'sent', await t.out('v', T('15T08:00:00'))); // dû le 14, parti le 15
    await point('m1', '2027-06-14', 'prepare', null, null); // dû le 21
    await point('m2', '2027-06-14', 'valide', 'sent', await t.out('v', T('22T08:00:00')), T('22T07:00:00')); // signé après le 21
    await point('m1', '2027-06-21', 'valide', 'sent', await t.out('v', T('28T08:00:00'), { box: true })); // dû le 28, en essai
    await point('m1', '2027-05-24', 'valide', 'sent', await t.out('v', '2027-05-31T08:00:00.000Z')); // dû le 31 mai : un autre mois
    await point('m1', '2027-06-28', 'prepare', null, null); // dû le 5 juillet : un autre mois
    const l = await t.line('point_lundi');
    expect(l.kept).toEqual({ numerator: 1, denominator: 3, bp: 3333 });
    expect(l.missedDays).toEqual(['2027-06-14', '2027-06-21']);
    expect(l.setAside).toBe(1);
    expect(l.inTrial).toBe(1);
    expect(l.blindSpot).toMatch(/jamais préparé/);
  });

  it('[R216] offre : transmise le jour de Paris où elle est reçue ; jamais transmise, manquée', async () => {
    const t = await setup();
    const offer = async (received: string, sent: string | null) => {
      const i = t.id();
      await t.db.run("INSERT INTO offer_register (id, network_id, property_id, seq, buyer_person_id, amount_eur, conditions, valid_until, down_payment_eur, loan_eur, signed_ref, received_at, agent_id, at, actor, prev_hash, hash) VALUES (?, ?, ?, 1, 'p', 100, '[]', '2027-12-31', 0, 0, 'r', ?, 'a', ?, 'a', 'x', ?)", [i, t.net, t.id(), received, received, t.id()]);
      if (sent) await t.db.run("INSERT INTO offer_transmissions (offer_id, network_id, via, at, by) VALUES (?, ?, 'telephone', ?, 'a')", [i, t.net, sent]);
    };
    await offer(T('10T08:00:00'), T('10T20:00:00'));
    await offer(T('11T08:00:00'), T('12T08:00:00'));
    await offer(T('12T08:00:00'), null);
    await offer(T('14T08:00:00'), null);
    const boxed = (await t.db.first<{ id: string }>("SELECT id FROM offer_register WHERE received_at = ?", [T('14T08:00:00')]))!.id;
    await t.db.run("INSERT INTO offer_transmissions (offer_id, network_id, via, message_id, at, by) VALUES (?, ?, 'message', ?, ?, 'a')", [boxed, t.net, await t.out('v', T('14T09:00:00'), { box: true }), T('14T09:00:00')]);
    const l = await t.line('offre_jour_meme');
    expect(l.kept).toEqual({ numerator: 1, denominator: 3, bp: 3333 });
    expect(l.inTrial).toBe(1);
  });

  it('[R216] client transmis : dans la minute du message reçu ; déjà suivi, sans agent ou réattribué : pas une transmission', async () => {
    const t = await setup();
    const attribute = async (received: string, created: string, agentId: string | null, reason = 'zone', replaces: string | null = null) => {
      const inboundId = await t.inbound(received);
      const q = t.id();
      await t.db.run("INSERT INTO qualifications (id, network_id, inbound_id, person_id, category, source, created_at) VALUES (?, ?, ?, 'p', 'seller', 'ai', ?)", [q, t.net, inboundId, created]);
      await t.db.run('INSERT INTO attributions (id, network_id, person_id, qualification_id, agent_id, reason, callback_hours, replaces_id, created_at) VALUES (?, ?, ?, ?, ?, ?, 2, ?, ?)', [t.id(), t.net, 'p', q, agentId, reason, replaces, created]);
    };
    await attribute(T('10T10:00:00'), T('10T10:01:00'), 'a1');
    await attribute(T('11T10:00:00'), T('11T10:01:01'), 'a1');
    await attribute(T('12T10:00:00'), T('12T10:00:01'), null, 'no_zone');
    await attribute(T('13T10:00:00'), T('13T10:00:01'), 'a1', 'already_followed');
    await t.db.run("INSERT INTO attributions (id, network_id, person_id, qualification_id, agent_id, reason, callback_hours, replaces_id, created_at) VALUES ('old', ?, 'p', NULL, 'a1', 'zone', 2, NULL, ?)", [t.net, T('01T10:00:00')]);
    await t.db.run("INSERT INTO attributions (id, network_id, person_id, qualification_id, agent_id, reason, callback_hours, replaces_id, created_at) VALUES ('new', ?, 'p', NULL, 'a2', 'reassigned', 2, 'old', ?)", [t.net, T('02T10:00:00')]);
    const l = await t.line('client_transmis');
    expect(l.kept).toEqual({ numerator: 1, denominator: 2, bp: 5000 });
    expect(l.setAside).toBe(3);
    expect(l.missedDays).toEqual(['2027-06-11']);
  });

  it('[R216] [R70] commission : à l’échéance tenu, après manqué, non versée manquée ; le délai qui court est en attente', async () => {
    const t = await setup('2027-07-01T10:00:00.000Z');
    const receipt = async (received: string, due: string, paid: string | null) => {
      const f = t.id();
      await t.db.run("INSERT INTO commission_receipts (file_id, network_id, received_at, proof_ref, payout_due_at, recorded_by, created_at) VALUES (?, ?, ?, 'r', ?, 'd', ?)", [f, t.net, received, due, received]);
      if (paid) await t.db.run("INSERT INTO commission_payouts (file_id, network_id, paid_at, proof_ref, recorded_by, created_at) VALUES (?, ?, ?, 'r', 'd', ?)", [f, t.net, paid, paid]);
      return f;
    };
    await receipt(T('10T10:00:00'), T('11T10:00:00'), T('11T10:00:00'));
    await receipt(T('11T10:00:00'), T('14T10:00:00'), T('14T10:00:01'));
    await receipt(T('15T10:00:00'), T('16T10:00:00'), null);
    await receipt(T('30T20:00:00'), '2027-07-01T20:00:00.000Z', null);
    const cancelled = await receipt(T('20T10:00:00'), T('21T10:00:00'), null);
    await t.db.run("INSERT INTO invoices (id, network_id, issuer, year, number, kind, file_id, corrects_invoice_id, content, amount_cents, issued_on, validated_by, created_at) VALUES ('av', ?, 'réseau', 2027, 1, 'avoir', ?, 'corrigee', ?, 0, '2027-06-20', 'd', ?)", [t.net, cancelled, JSON.stringify({ reason: 'vente_annulee' }), T('20T12:00:00')]);
    const l = await t.line('commission_24h');
    expect(l.kept).toEqual({ numerator: 1, denominator: 3, bp: 3333 });
    expect(l.pending).toBe(1);
    expect(l.setAside).toBe(1);
    t.setClock('2027-07-02T10:00:00.000Z');
    const after = await t.line('commission_24h');
    expect(after.pending).toBe(0);
    expect(after.kept.denominator).toBe(4);
  });

  // Le 10 juin 2027 est un jeudi, le 12 un samedi, le 13 un dimanche ; Paris est à UTC+2.
  const onSale = (t: Awaited<ReturnType<typeof setup>>, property: string, at: string) =>
    t.db.run('INSERT INTO property_on_sale (property_id, network_id, mandate_id, on_sale_at, noted_at) VALUES (?, ?, ?, ?, ?)', [property, t.net, 'm', at, at]);
  const asked = (t: Awaited<ReturnType<typeof setup>>, person: string, at = T('01T08:00:00')) =>
    t.db.run("INSERT INTO consents (id, network_id, person_id, purpose, channel, proof, given_at, created_at) VALUES (?, ?, ?, 'alertes_biens', 'email', 'preuve', ?, ?)", [t.id(), t.net, person, at, at]);
  const alert = async (t: Awaited<ReturnType<typeof setup>>, property: string, person: string, opts: { sentAt?: string; box?: boolean; failed?: boolean; status?: string; rule?: string; project?: string; consent?: boolean } = {}) => {
    if (opts.consent !== false) await asked(t, person);
    const message = opts.sentAt ? await t.out(person, opts.sentAt, { box: opts.box, failed: opts.failed }) : null;
    const at = opts.sentAt ?? T('01T00:00:00');
    await t.db.run('INSERT INTO property_alerts (property_id, person_id, network_id, project_id, status, rule, message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [property, person, t.net, opts.project ?? null, opts.status ?? (opts.sentAt ? 'sent' : 'waiting'), opts.rule ?? null, message, at, at]);
  };

  it('[R222] un bien sans date reste non mesuré : la ligne le dit, n’entre pas au total, jamais un zéro', async () => {
    const t = await setup();
    await t.db.run("INSERT INTO property_alerts (property_id, person_id, network_id, status, created_at, updated_at) VALUES ('b', 'p', ?, 'sent', ?, ?)", [t.net, T('10T10:00:00'), T('10T10:00:00')]);
    const r = await t.read();
    const l = r.lines.find((x) => x.code === 'alerte_heure')!;
    expect(l.measurable).toBe(false);
    expect(l.kept.bp).toBeNull();
    expect(l.setAside).toBe(1);
    expect(r.overall.denominator).toBe(0);
  });

  it('[R222] un bien sans date, à côté d’un bien daté, est dit à part, sans entrer au calcul', async () => {
    const t = await setup();
    await onSale(t, 'b1', T('10T10:00:00'));
    await alert(t, 'b1', 'p1', { sentAt: T('10T10:30:00') });
    await t.db.run("INSERT INTO property_alerts (property_id, person_id, network_id, status, created_at, updated_at) VALUES ('b2', 'p2', ?, 'sent', ?, ?)", [t.net, T('10T10:00:00'), T('10T10:00:00')]);
    const l = await t.line('alerte_heure');
    expect(l.measurable).toBe(true);
    expect(l.kept).toEqual({ numerator: 1, denominator: 1, bp: 10000 });
    expect(l.setAside).toBe(1);
  });

  it('[R216] alerte dans l’heure, à la seconde près : 60 min 00 s tenu, 60 min 01 s manqué', async () => {
    const t = await setup();
    await onSale(t, 'b1', T('10T10:00:00')); // 12 h à Paris
    await alert(t, 'b1', 'p1', { sentAt: T('10T11:00:00') });
    await alert(t, 'b1', 'p2', { sentAt: T('10T11:00:01') });
    const l = await t.line('alerte_heure');
    expect(l.kept).toEqual({ numerator: 1, denominator: 2, bp: 5000 });
    expect(l.missedDays).toEqual(['2027-06-10']);
  });

  it('[R216] un bien sorti la nuit : l’heure part de 8 h, 9 h 00 tenu, 9 h 00 min 01 s manqué', async () => {
    const t = await setup();
    await onSale(t, 'b1', T('10T00:30:00')); // 2 h 30 à Paris
    await alert(t, 'b1', 'p1', { sentAt: T('10T07:00:00') }); // 9 h à Paris
    await alert(t, 'b1', 'p2', { sentAt: T('10T07:00:01') });
    expect((await t.line('alerte_heure')).kept).toEqual({ numerator: 1, denominator: 2, bp: 5000 });
  });

  it('[R216] un bien sorti le dimanche : l’heure part du lundi 8 h', async () => {
    const t = await setup();
    await onSale(t, 'b1', T('13T09:00:00')); // dimanche 11 h à Paris
    await alert(t, 'b1', 'p1', { sentAt: T('14T07:00:00') }); // lundi 9 h
    await alert(t, 'b1', 'p2', { sentAt: T('14T07:00:01') });
    expect((await t.line('alerte_heure')).kept).toEqual({ numerator: 1, denominator: 2, bp: 5000 });
  });

  it('[R216] un bien sorti le samedi à 19 h 30 : sa demi-heure du soir, puis celle du lundi matin', async () => {
    const t = await setup();
    await onSale(t, 'b1', T('12T17:30:00'));
    await alert(t, 'b1', 'p1', { sentAt: T('14T06:30:00') }); // lundi 8 h 30
    await alert(t, 'b1', 'p2', { sentAt: T('14T06:30:01') });
    expect((await t.line('alerte_heure')).kept).toEqual({ numerator: 1, denominator: 2, bp: 5000 });
  });

  it('[R216] une alerte en boîte d’essai se dit à part, en panne elle est manquée, un délai qui court n’est ni l’un ni l’autre', async () => {
    const t = await setup();
    await onSale(t, 'b1', T('10T10:00:00'));
    await alert(t, 'b1', 'p1', { sentAt: T('10T10:10:00'), box: true });
    await alert(t, 'b1', 'p2', { sentAt: T('10T10:10:00'), failed: true, status: 'failed' });
    await alert(t, 'b1', 'p3', { sentAt: T('10T10:10:00'), failed: true });
    const l = await t.line('alerte_heure');
    expect(l.inTrial).toBe(1);
    expect(l.kept).toEqual({ numerator: 0, denominator: 2, bp: 0 });

    const u = await setup('2027-07-01T06:30:00.000Z');
    await onSale(u, 'b1', T('30T20:00:00')); // le 30 juin à 22 h à Paris, le 1er juillet à 8 h 30 : l'heure court jusqu'à 9 h
    await alert(u, 'b1', 'p1', { status: 'waiting', rule: 'R01' });
    const w = await u.line('alerte_heure');
    expect(w.pending).toBe(1);
    expect(w.kept.denominator).toBe(0);
    u.setClock('2027-07-01T07:00:01.000Z');
    expect((await u.line('alerte_heure')).kept.denominator).toBe(1);
  });

  it('[R216] à part : la loi, l’accord, le doublon, le bien retiré ; un autre refus reste manqué', async () => {
    const t = await setup();
    await onSale(t, 'b1', T('10T10:00:00'));
    for (const [i, rule] of ['R02', 'R03', 'R04', 'R05', 'R42'].entries()) await alert(t, 'b1', `p${i}`, { status: 'refused', rule });
    await alert(t, 'b1', 'p9', { status: 'refused', rule: 'R07' });
    const l = await t.line('alerte_heure');
    expect(l.setAside).toBe(5);
    expect(l.kept).toEqual({ numerator: 0, denominator: 1, bp: 0 });
  });

  it('[R216] à part si la personne n’a demandé ou changé sa recherche qu’après la mise en vente ; arrivée à temps, elle compte', async () => {
    const t = await setup();
    await onSale(t, 'b1', T('10T10:00:00'));
    await asked(t, 'p1', T('11T10:00:00'));
    await alert(t, 'b1', 'p1', { sentAt: T('11T12:00:00'), consent: false }); // accord donné après
    await t.db.run("INSERT INTO buyer_searches (id, network_id, project_id, person_id, version, origin, created_at) VALUES ('s1', ?, 'prj', 'p2', 1, 'agent:x', ?)", [t.net, T('11T09:00:00')]);
    await alert(t, 'b1', 'p2', { sentAt: T('11T12:00:00'), project: 'prj' }); // recherche changée après
    await asked(t, 'p3', T('11T10:30:00'));
    await alert(t, 'b1', 'p3', { sentAt: T('10T10:20:00'), consent: false }); // à temps : l'accord tardif n'y change rien
    const l = await t.line('alerte_heure');
    expect(l.setAside).toBe(2);
    expect(l.kept).toEqual({ numerator: 1, denominator: 1, bp: 10000 });
  });

  it('[R216] un accord périmé par une exclusion levée, ou une personne exclue à la mise en vente : à part, comme à l’envoi', async () => {
    const t = await setup();
    const excluded = (id: string, person: string, noted: string, lifted: string, channel: string | null = null) =>
      t.db.run("INSERT INTO exclusions (id, network_id, person_id, reason, channel, noted_at, lifted_at, created_at) VALUES (?, ?, ?, 'stop', ?, ?, ?, ?)", [id, t.net, person, channel, noted, lifted, noted]);
    await onSale(t, 'b1', T('10T10:00:00'));
    await excluded('x-a', 'p1', T('02T08:00:00'), T('03T08:00:00'));
    await alert(t, 'b1', 'p1', { sentAt: T('20T10:00:00') });
    await excluded('x-b', 'p2', T('09T08:00:00'), T('15T08:00:00'));
    await alert(t, 'b1', 'p2', { sentAt: T('20T10:00:00') });
    // Exclue sur un autre canal seulement : l'accord par mail valait, le retard compte.
    await excluded('x-c', 'p3', T('09T08:00:00'), T('09T09:00:00'), 'sms');
    await t.db.run("INSERT INTO exclusions (id, network_id, person_id, reason, channel, noted_at, created_at) VALUES ('x-d', ?, 'p4', 'stop', 'email', ?, ?)", [t.net, T('09T08:00:00'), T('09T08:00:00')]);
    await alert(t, 'b1', 'p4', { sentAt: T('20T10:00:00') });
    await alert(t, 'b1', 'p3', { sentAt: T('20T10:00:00') });
    const l = await t.line('alerte_heure');
    expect(l.setAside).toBe(3);
    expect(l.kept).toEqual({ numerator: 0, denominator: 1, bp: 0 });
  });

  it('[R216] l’accord d’une fiche réunie vaut pour la fiche gardée', async () => {
    const t = await setup();
    await onSale(t, 'b1', T('10T10:00:00'));
    await asked(t, 'ancienne');
    await t.db.run("INSERT INTO person_merges (id, network_id, survivor_id, merged_id, reason, merged_at, created_at) VALUES ('f', ?, 'p1', 'ancienne', 'doublon', ?, ?)", [t.net, T('01T00:00:00'), T('01T00:00:00')]);
    await alert(t, 'b1', 'p1', { sentAt: T('10T12:00:00'), consent: false });
    expect((await t.line('alerte_heure')).kept).toEqual({ numerator: 0, denominator: 1, bp: 0 });
  });

  it('[R216] le total additionne les cas jugés ; les autres mois et les autres réseaux n’y sont pas', async () => {
    const t = await setup();
    await t.claim(await t.inbound(T('10T10:00:00'), { person: 'p1' }), 'sent', T('10T10:00:10'));
    await t.out('p1', T('10T10:00:10'));
    await t.inbound(T('11T10:00:00'));
    await t.inbound('2027-05-31T21:59:59.000Z'); // le 31 mai à Paris
    await t.inbound('2027-06-30T22:00:00.000Z'); // le 1er juillet à Paris
    await t.db.run("INSERT INTO offer_register (id, network_id, property_id, seq, buyer_person_id, amount_eur, conditions, valid_until, down_payment_eur, loan_eur, signed_ref, received_at, agent_id, at, actor, prev_hash, hash) VALUES ('o', ?, 'b', 1, 'p', 100, '[]', '2027-12-31', 0, 0, 'r', ?, 'a', ?, 'a', 'x', 'h')", [t.net, T('10T08:00:00'), T('10T08:00:00')]);
    await t.db.run("INSERT INTO offer_transmissions (offer_id, network_id, via, at, by) VALUES ('o', ?, 'telephone', ?, 'a')", [t.net, T('10T09:00:00')]);
    await t.db.run("INSERT INTO networks (id, name, created_at) VALUES ('autre', 'Autre', ?)", [T('01T00:00:00')]);
    await t.inbound(T('12T10:00:00'), { network: 'autre' });
    const r = await t.read();
    expect(r.overall).toEqual({ numerator: 2, denominator: 3, bp: 6667 });
  });

  it('[R14] aucun identifiant, aucun agent, aucun nom dans la réponse', async () => {
    const t = await setup();
    await t.appointment('visite', 'honored', T('10T10:00:00'));
    const text = JSON.stringify(await t.read());
    expect(text).not.toMatch(/"a1"|"p1"|agentId|agent_id|personId/);
  });

  it('[R16] la direction seule, chaque refus au journal ; un mois en cours ou mal écrit est refusé', async () => {
    const t = await setup();
    for (const role of ['agent', 'compliance', 'assistant']) expect(await t.ind.ofMonth(t.as(role), '2027-06')).toEqual({ ok: false, rule: 'R16', code: 'role' });
    const refused = await t.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM journal WHERE type = 'acces.refuse'");
    expect(Number(refused?.n)).toBe(3);
    expect(await t.ind.ofMonth(t.as('direction'), '2027-07')).toEqual({ ok: false, rule: 'R216', code: 'month_not_finished' });
    expect(await t.ind.ofMonth(t.as('direction'), '2027-08')).toEqual({ ok: false, rule: 'R216', code: 'month_not_finished' });
    expect(await t.ind.ofMonth(t.as('direction'), '2027-13')).toEqual({ ok: false, rule: null, code: 'bad_month' });
    expect(await t.ind.ofMonth(t.as('direction'), null)).toEqual({ ok: false, rule: null, code: 'bad_month' });
  });
});
