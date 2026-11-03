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
  return { db, net, as, ind, id, inbound, claim, appointment, read, line, journal, setClock: (iso: string) => { clock = new Date(iso); } };
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
    await t.claim(await t.inbound(T('10T10:00:00'), { conv: 'c1' }), 'sent', T('10T10:01:00'));
    await t.inbound(T('10T10:05:00'), { conv: 'c1' }); // la suite de la conversation : pas un cas
    await t.claim(await t.inbound(T('11T10:00:00')), 'sent', T('11T10:01:01'));
    await t.inbound(T('12T10:00:00'));
    await t.inbound(T('12T11:00:00'), { kind: 'unreadable' });
    const l = await t.line('reponse_minute');
    expect(l.kept).toEqual({ numerator: 1, denominator: 3, bp: 3333 });
    expect(l.missedDays).toEqual(['2027-06-11', '2027-06-12']);
  });

  it('[R216] une réponse de l’agent dans la minute compte, un envoi du système non ; une réponse refusée sans autre réponse est à part et se voit', async () => {
    const t = await setup();
    await t.inbound(T('10T10:00:00'), { person: 'p7' });
    await t.db.run("INSERT INTO messages (id, network_id, person_id, channel, direction, author_kind, body, occurred_at, created_at) VALUES ('m1', ?, 'p7', 'email', 'out', 'agent', 'texte', ?, ?)", [t.net, T('10T10:00:30'), T('10T10:00:30')]);
    await t.claim(await t.inbound(T('11T10:00:00')), 'refused', T('11T10:00:01'));
    // Un envoi du système dans la minute (une alerte, par exemple) n'est pas une réponse.
    await t.inbound(T('13T10:00:00'), { person: 'p8' });
    await t.db.run("INSERT INTO messages (id, network_id, person_id, channel, direction, author_kind, body, occurred_at, created_at) VALUES ('m2', ?, 'p8', 'email', 'out', 'system', 'texte', ?, ?)", [t.net, T('13T10:00:30'), T('13T10:00:30')]);
    const l = await t.line('reponse_minute');
    expect(l.kept).toEqual({ numerator: 1, denominator: 2, bp: 5000 });
    expect(l.setAside).toBe(1);
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

  it('[R216] compte rendu : validé sous 24 h ; un brouillon, une visite sans compte rendu ou en retard sont manqués', async () => {
    const t = await setup();
    const report = (appointmentId: string, status: string, validatedAt: string | null) => t.db.run("INSERT INTO visit_reports (appointment_id, network_id, dictation, status, validated_by, validated_at, created_by, created_at, updated_at) VALUES (?, ?, 'd', ?, 'a', ?, 'a', ?, ?)", [appointmentId, t.net, status, validatedAt, T('01T00:00:00'), T('01T00:00:00')]);
    await report(await t.appointment('visite', 'honored', T('10T10:00:00')), 'valide', T('11T10:00:00'));
    await report(await t.appointment('visite', 'booked', T('11T10:00:00')), 'valide', T('12T10:00:01'));
    await report(await t.appointment('visite', 'honored', T('12T10:00:00')), 'brouillon', null);
    await t.appointment('visite', 'honored', T('13T10:00:00'));
    await t.appointment('visite', 'cancelled', T('14T10:00:00'));
    expect((await t.line('compte_rendu_24h')).kept).toEqual({ numerator: 1, denominator: 4, bp: 2500 });
  });

  it('[R216] point du lundi : validé le jour même, le mardi est manqué, préparé sans validation aussi', async () => {
    const t = await setup();
    const point = (week: string, created: string, status: string, validated: string | null) => t.db.run("INSERT INTO weekly_points (mandate_id, week, network_id, property_id, person_id, agent_id, figures, status, validated_by, validated_at, created_at, updated_at) VALUES ('m', ?, ?, 'b', 'p', 'a', '{}', ?, 'a', ?, ?, ?)", [week, t.net, status, validated, created, created]);
    await point('2027-06-07', T('07T06:00:00'), 'valide', T('07T15:00:00'));
    await point('2027-06-14', T('14T06:00:00'), 'valide', T('15T08:00:00'));
    await point('2027-06-21', T('21T06:00:00'), 'prepare', null);
    expect((await t.line('point_lundi')).kept).toEqual({ numerator: 1, denominator: 3, bp: 3333 });
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
    expect((await t.line('offre_jour_meme')).kept).toEqual({ numerator: 1, denominator: 3, bp: 3333 });
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
    };
    await receipt(T('10T10:00:00'), T('11T10:00:00'), T('11T10:00:00'));
    await receipt(T('11T10:00:00'), T('14T10:00:00'), T('14T10:00:01'));
    await receipt(T('15T10:00:00'), T('16T10:00:00'), null);
    await receipt(T('30T20:00:00'), '2027-07-01T20:00:00.000Z', null);
    const l = await t.line('commission_24h');
    expect(l.kept).toEqual({ numerator: 1, denominator: 3, bp: 3333 });
    expect(l.pending).toBe(1);
    t.setClock('2027-07-02T10:00:00.000Z');
    const after = await t.line('commission_24h');
    expect(after.pending).toBe(0);
    expect(after.kept.denominator).toBe(4);
  });

  it('[R216] l’alerte aux acquéreurs n’est pas mesurable : la ligne le dit, n’entre pas au total, même avec des alertes rangées', async () => {
    const t = await setup();
    await t.db.run("INSERT INTO property_alerts (property_id, person_id, network_id, status, created_at, updated_at) VALUES ('b', 'p', ?, 'sent', ?, ?)", [t.net, T('10T10:00:00'), T('10T10:00:00')]);
    const r = await t.read();
    const l = r.lines.find((x) => x.code === 'alerte_heure')!;
    expect(l.measurable).toBe(false);
    expect(l.kept.bp).toBeNull();
    expect(r.overall.denominator).toBe(0);
  });

  it('[R216] le total additionne les cas jugés ; les autres mois et les autres réseaux n’y sont pas', async () => {
    const t = await setup();
    await t.claim(await t.inbound(T('10T10:00:00')), 'sent', T('10T10:00:10'));
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
