import { afterEach, expect, it, vi } from 'vitest';
import { AnciensContacts, FicheClient, OLD_CONTACT_PURPOSE, SqlJournalStore, applyMigrations, checkOldContactText, fromSyncSqlite, oldContactFallback, type OldContactDrafter, type SqlDatabase } from '../src/index.ts';
import { mergeWithDouble } from './doublon.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Un mardi d'octobre, 10 h à Paris. Réseau, agents, anciens contacts, biens et ventes inventés.
const TUE_10H = Date.parse('2027-10-12T08:00:00.000Z');
const DAY = 86_400_000;

afterEach(() => vi.restoreAllMocks());

async function setup(drafter: OldContactDrafter | null = null) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = TUE_10H;
  const now = (): Date => new Date(clock);
  let n = 0;
  const newId = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const anciens = new AnciensContacts(db, journal, { now, newId, drafter });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const agent = (id = alex.id) => ({ role: 'agent' as const, userId: id, networkId: network.id });
  /** Un ancien contact d'Alex, avec son mail et, par défaut, son accord de relance donné il y a un an. */
  const contact = async (who: string, consentAgoDays: number | null = 365, channel: 'email' | 'phone' = 'email') => {
    const p = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: who });
    await store.addIdentifier({ networkId: network.id, personId: p.id, kind: 'email', value: `${who.toLowerCase()}@example.test` });
    const c = consentAgoDays === null ? null : await store.addConsent({ networkId: network.id, personId: p.id, purpose: OLD_CONTACT_PURPOSE, channel, proof: 'case cochée (test)', givenAt: new Date(TUE_10H - consentAgoDays * DAY) });
    return { id: p.id, consentId: c?.id ?? null };
  };
  /** L'achat d'un bien par cette personne, acte signé ce jour-là (lignes inventées, rangées sans le parcours de M10). */
  const bought = async (personId: string, signedOn: string) => {
    await db.exec('PRAGMA foreign_keys = OFF');
    const file = newId();
    await db.run('INSERT INTO sale_files (id, network_id, property_id, offer_id, buyer_person_id, amount_eur, opened_at, opened_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [file, network.id, newId(), newId(), personId, 200000, `${signedOn}T08:00:00.000Z`, 'agent:test']);
    await db.run("INSERT INTO sale_file_closings (file_id, network_id, signed_on, proof_ref, aftersale, at, by) VALUES (?, ?, ?, ?, 'a_demarrer', ?, ?)", [file, network.id, signedOn, 'preuves/test.pdf', `${signedOn}T08:00:00.000Z`, 'agent:test']);
    await db.exec('PRAGMA foreign_keys = ON');
    return file;
  };
  /** Un avis de valeur validé il y a `agoDays` jours, sur un bien que la personne possède. */
  const valued = async (personId: string, agoDays: number) => {
    const project = await store.createProject({ networkId: network.id, agentId: alex.id, personId, kind: 'sell' });
    const property = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: `B-${newId().slice(-4)}`, kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 80, rooms: 4, priceEur: 250000 });
    await store.linkProjectProperty({ networkId: network.id, agentId: alex.id, projectId: project.id, propertyId: property.id, role: 'owned' });
    const at = new Date(TUE_10H - agoDays * DAY).toISOString();
    await db.run(
      `INSERT INTO valuation_reports (id, network_id, property_id, agent_id, status, computed, computed_low, computed_high, text, text_by, created_at, updated_at, validated_by, validated_at)
       VALUES (?, ?, ?, ?, 'validated', '{}', 200000, 220000, 'Avis de test', 'fallback', ?, ?, ?, ?)`,
      [newId(), network.id, property.id, alex.id, at, at, `agent:${alex.id}`, at],
    );
  };
  const followups = () => db.all<{ person_id: string; reason: string; status: string; rule: string | null; draft_by: string }>('SELECT person_id, reason, status, rule, draft_by FROM old_contact_followups ORDER BY created_at, id');
  const outbox = () => db.all<{ body: string }>('SELECT m.body FROM trial_outbox o JOIN messages m ON m.id = o.message_id');
  return { db, journal, store, anciens, network, alex, sam, agent, contact, bought, valued, followups, outbox, setClock: (t: number) => (clock = t) };
}

describeWithSqlite('G09 · anciens contacts relancés quand la loi le permet', () => {
  it('[R35] [R143] chaque mois, les relançables au bon moment, dans l’ordre des règles écrites, chacun avec sa raison', async () => {
    const seen: unknown[] = [];
    const drafter: OldContactDrafter = {
      draft: async (input) => {
        seen.push(input);
        return 'je pensais à vous et à votre projet. Je reste à votre écoute si vous le souhaitez.';
      },
    };
    const t = await setup(drafter);
    const ines = await t.contact('Inès');
    await t.valued(ines.id, 400);
    const bruno = await t.contact('Bruno');
    await t.bought(bruno.id, '2025-10-20');
    const lise = await t.contact('Lise');
    expect(await t.anciens.noteLeaseEnd(t.agent(), lise.id, '2027-12-01')).toMatchObject({ ok: true });
    // Sans moment, pas de relance : un avis de valeur récent, une fin de bail trop lointaine, un achat d'un autre mois.
    const noe = await t.contact('Noé');
    await t.valued(noe.id, 100);
    await t.anciens.noteLeaseEnd(t.agent(), noe.id, '2028-06-01');
    await t.bought(noe.id, '2025-03-02');
    // Bruno a acheté avec l'agence : il n'est relancé que par les relances après la vente, avec leur règle [R65].
    expect(await t.anciens.prepareMonth(t.network.id)).toBe(2);
    const list = await t.anciens.toValidate(t.agent());
    expect(list.ok && list.value.map((i) => [i.firstName, i.reason, i.reasonLabel, i.reasonDay, i.draftBy])).toEqual([
      ['Lise', 'fin_de_bail', 'Fin de bail prochaine', '2027-12-01', 'ia'],
      ['Inès', 'estimation_ancienne', 'Avis de valeur de plus d’un an', '2026-09-07', 'ia'],
    ]);
    expect(list.ok && list.value[0]!.draft).toBe('Bonjour Lise, je pensais à vous et à votre projet. Je reste à votre écoute si vous le souhaitez.');
    // L'IA ne reçoit que la raison, jamais la personne, et ne décide pas de l'ordre [R35, R13].
    expect(seen).toHaveLength(2);
    expect(seen).toEqual(expect.arrayContaining([{ reason: 'fin_de_bail' }, { reason: 'estimation_ancienne' }]));
    expect(seen.every((s) => Object.keys(s as object).join() === 'reason')).toBe(true);
    // Le même passage relancé ne prépare rien de plus.
    expect(await t.anciens.prepareMonth(t.network.id)).toBe(0);
    expect(JSON.stringify(await t.journal.all())).not.toMatch(/Lise|Inès|example\.test/);
  });

  it('[R143] [R03] [R02] [R04] [R65] [R97] jamais sans base légale : sans accord, exclu, arrêté, opposé après la vente, prospect de plus de 3 ans', async () => {
    const t = await setup();
    const cases = {
      sansAccord: await t.contact('Sans', null),
      accordTelephone: await t.contact('Tel', 365, 'phone'),
      exclu: await t.contact('Exclu'),
      arrete: await t.contact('Arret'),
      oppose: await t.contact('Oppose'),
      ancien: await t.contact('Ancien', 3 * 365 + 40),
      retire: await t.contact('Retire'),
      bon: await t.contact('Bon'),
    };
    for (const c of Object.values(cases)) await t.valued(c.id, 400);
    await t.store.addExclusion({ networkId: t.network.id, personId: cases.exclu.id, reason: 'network_list', notedAt: new Date(TUE_10H - DAY) });
    await t.store.addExclusion({ networkId: t.network.id, personId: cases.arrete.id, reason: 'stop', notedAt: new Date(TUE_10H - DAY) });
    await t.store.withdrawConsent(cases.retire.consentId!, new Date(TUE_10H - DAY));
    const file = await t.bought(cases.oppose.id, '2024-04-03');
    await t.db.run("INSERT INTO after_sale_choices (id, network_id, file_id, person_id, choice, proof, recorded_by, recorded_at) VALUES ('c1', ?, ?, ?, 'non', 'dit à l’acte (test)', 'agent:test', ?)", [t.network.id, file, cases.oppose.id, '2024-04-03T09:00:00.000Z']);
    // L'avis de valeur d'« Ancien » est vieux, son accord aussi : aucun contact venu de lui depuis plus de 3 ans.
    await t.db.run('UPDATE projects SET created_at = ? WHERE person_id = ?', [new Date(TUE_10H - (3 * 365 + 40) * DAY).toISOString(), cases.ancien.id]);
    await t.db.run('UPDATE persons SET created_at = ? WHERE id = ?', [new Date(TUE_10H - (3 * 365 + 40) * DAY).toISOString(), cases.ancien.id]);
    expect(await t.anciens.prepareMonth(t.network.id)).toBe(1);
    expect((await t.followups()).map((f) => f.person_id)).toEqual([cases.bon.id]);
  });

  it('[R143] [R05] une relance par période réglée au plus, relances après la vente comprises', async () => {
    const t = await setup();
    const ines = await t.contact('Inès');
    await t.valued(ines.id, 400);
    const ugo = await t.contact('Ugo');
    await t.valued(ugo.id, 400);
    // Ugo a reçu une relance après la vente il y a deux mois.
    await t.db.exec('PRAGMA foreign_keys = OFF');
    await t.db.run("INSERT INTO after_sale_reminders (file_id, person_id, year, network_id, agent_id, due_day, status, rule, message_id, updated_at) VALUES ('f1', ?, 1, ?, ?, '2027-08-10', 'sent', NULL, NULL, ?)", [ugo.id, t.network.id, t.alex.id, new Date(TUE_10H - 60 * DAY).toISOString()]);
    await t.db.exec('PRAGMA foreign_keys = ON');
    expect(await t.anciens.prepareMonth(t.network.id)).toBe(1);
    expect(await t.anciens.toValidate(t.agent())).toMatchObject({ ok: true, value: [expect.objectContaining({ personId: ines.id })] });
    // Le mois suivant, et jusqu'à 182 jours : rien de nouveau.
    t.setClock(TUE_10H + 35 * DAY);
    expect(await t.anciens.prepareMonth(t.network.id)).toBe(0);
    t.setClock(TUE_10H + 181 * DAY);
    expect(await t.anciens.prepareMonth(t.network.id)).toBe(1);
    expect((await t.followups()).map((f) => f.person_id)).toEqual([ines.id, ugo.id]);
    t.setClock(TUE_10H + 183 * DAY);
    expect(await t.anciens.prepareMonth(t.network.id)).toBe(1);
    expect((await t.followups()).map((f) => f.person_id)).toEqual([ines.id, ugo.id, ines.id]);
  });

  it('[R26] [R143] validée par l’agent, la relance passe par le contrôle central en mode essai : rien ne part ; la base est relue à l’envoi', async () => {
    const t = await setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const ines = await t.contact('Inès');
    await t.valued(ines.id, 400);
    const ugo = await t.contact('Ugo');
    await t.valued(ugo.id, 400);
    await t.anciens.prepareMonth(t.network.id);
    const list = await t.anciens.toValidate(t.agent());
    if (!list.ok) throw new Error(list.code);
    const a = list.value.find((i) => i.firstName === 'Inès');
    const b = list.value.find((i) => i.firstName === 'Ugo');
    expect(await t.anciens.validate(t.agent(), a!.followupId, { text: 'Bonjour Inès, je peux mettre à jour votre avis de valeur quand vous voulez.' })).toEqual({ ok: true, value: { status: 'essai', rule: null, delivered: false } });
    expect((await t.outbox()).map((m) => m.body)).toEqual([expect.stringContaining('Bonjour Inès, je peux mettre à jour votre avis de valeur quand vous voulez.')]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await t.anciens.validate(t.agent(), a!.followupId)).toEqual({ ok: false, rule: null, code: 'already_decided' });
    // L'accord d'Ugo est retiré entre la liste et la validation : rien n'est envoyé, la relance est close.
    await t.store.withdrawConsent((await t.db.first<{ id: string }>('SELECT id FROM consents WHERE person_id = ?', [ugo.id]))!.id, new Date(TUE_10H - 1000));
    expect(await t.anciens.validate(t.agent(), b!.followupId)).toEqual({ ok: false, rule: 'R143', code: 'no_basis_R03' });
    expect(await t.outbox()).toHaveLength(1);
    expect((await t.followups()).map((f) => [f.person_id, f.status, f.rule]).sort()).toEqual([[ines.id, 'essai', null], [ugo.id, 'sans_base', 'R03']].sort());
    const entries = (await t.journal.all()).filter((e) => e.type === 'anciens_contacts.essai');
    expect(entries.map((e) => e.data)).toEqual([{ mode: 'essai', sent: false, followup: a!.followupId, status: 'essai', rule: null }]);
  });

  it('[R143] [R05] une relance non validée expire avec son mois ; une relance après la vente partie entre-temps l’arrête', async () => {
    const t = await setup();
    const ines = await t.contact('Inès');
    await t.valued(ines.id, 400);
    const ugo = await t.contact('Ugo');
    await t.valued(ugo.id, 400);
    await t.anciens.prepareMonth(t.network.id);
    const list = await t.anciens.toValidate(t.agent());
    if (!list.ok) throw new Error(list.code);
    const a = list.value.find((i) => i.firstName === 'Inès')!;
    const b = list.value.find((i) => i.firstName === 'Ugo')!;
    // Le lendemain, Ugo reçoit sa relance après la vente : la relance d'ancien contact ne part plus.
    await t.db.exec('PRAGMA foreign_keys = OFF');
    await t.db.run("INSERT INTO after_sale_reminders (file_id, person_id, year, network_id, agent_id, due_day, status, rule, message_id, updated_at) VALUES ('f1', ?, 1, ?, ?, '2027-10-13', 'sent', NULL, NULL, ?)", [ugo.id, t.network.id, t.alex.id, new Date(TUE_10H + DAY).toISOString()]);
    await t.db.exec('PRAGMA foreign_keys = ON');
    t.setClock(TUE_10H + 2 * DAY);
    expect(await t.anciens.validate(t.agent(), b.followupId)).toEqual({ ok: false, rule: 'R143', code: 'period' });
    // Six mois plus tard, la relance d'Inès jamais validée a expiré : elle ne peut plus partir, une nouvelle est préparée.
    t.setClock(TUE_10H + 183 * DAY);
    expect(await t.anciens.prepareMonth(t.network.id)).toBe(2);
    expect(await t.anciens.validate(t.agent(), a.followupId)).toEqual({ ok: false, rule: null, code: 'already_decided' });
    expect(await t.outbox()).toEqual([]);
    expect((await t.followups()).map((f) => `${f.person_id} ${f.status}`).sort()).toEqual([`${ines.id} expiree`, `${ines.id} a_valider`, `${ugo.id} expiree`, `${ugo.id} a_valider`].sort());
    // La lecture de la liste est au journal, sans donnée [R16, R13].
    expect((await t.journal.all()).filter((e) => e.type === 'anciens_contacts.liste_lue').map((e) => e.data)).toEqual([{ rule: 'R16', count: 2 }]);
  });

  it('[R08] [R12] [R05] la salutation de l’IA prend le prénom ; un texte de l’IA refusé au contrôle central laisse partir celui du code ; deux validations n’en font qu’une', async () => {
    const t = await setup({ draft: async () => 'Bonjour, tu peux me rappeler quand tu veux pour ton projet.' });
    const ines = await t.contact('Inès');
    await t.valued(ines.id, 400);
    const ugo = await t.contact('Ugo');
    await t.valued(ugo.id, 400);
    await t.anciens.prepareMonth(t.network.id);
    const list = await t.anciens.toValidate(t.agent());
    if (!list.ok) throw new Error(list.code);
    const a = list.value.find((i) => i.firstName === 'Inès')!;
    const b = list.value.find((i) => i.firstName === 'Ugo')!;
    expect(a.draft).toBe('Bonjour Inès, tu peux me rappeler quand tu veux pour ton projet.');
    // Le contrôle central refuse le tutoiement [R08] : le texte du code part à sa place, en mode essai.
    expect(await t.anciens.validate(t.agent(), a.followupId)).toEqual({ ok: true, value: { status: 'essai', rule: null, delivered: false } });
    expect((await t.outbox()).map((m) => m.body)).toEqual([expect.stringContaining(oldContactFallback('estimation_ancienne', 'Inès'))]);
    // Deux validations en même temps : une seule passe, l'autre est refusée sans rien changer.
    const both = await Promise.all([t.anciens.validate(t.agent(), b.followupId), t.anciens.validate(t.agent(), b.followupId)]);
    expect(both.filter((x) => x.ok)).toHaveLength(1);
    expect(both.filter((x) => !x.ok)).toEqual([{ ok: false, rule: null, code: 'already_decided' }]);
    expect(await t.outbox()).toHaveLength(2);
    const rows = await t.db.all<{ status: string; message_id: string | null }>("SELECT status, message_id FROM old_contact_followups WHERE person_id = ?", [ugo.id]);
    expect(rows).toEqual([{ status: 'essai', message_id: expect.any(String) }]);
  });

  it('[R65] un client d’une vente faite avec l’agence n’est jamais relancé ici : seules les relances après la vente le font', async () => {
    const t = await setup();
    const bruno = await t.contact('Bruno');
    await t.valued(bruno.id, 400);
    await t.bought(bruno.id, '2024-03-02');
    expect(await t.anciens.prepareMonth(t.network.id)).toBe(0);
    expect(await t.followups()).toEqual([]);
  });

  it('[R01] validée la nuit, la relance reste à valider et part au créneau suivant', async () => {
    const t = await setup();
    const ines = await t.contact('Inès');
    await t.valued(ines.id, 400);
    await t.anciens.prepareMonth(t.network.id);
    const list = await t.anciens.toValidate(t.agent());
    if (!list.ok) throw new Error(list.code);
    const id = list.value[0]!.followupId;
    t.setClock(Date.parse('2027-10-12T20:30:00.000Z'));
    expect(await t.anciens.validate(t.agent(), id)).toEqual({ ok: true, value: { status: 'attente', rule: 'R01', delivered: false } });
    expect((await t.followups()).map((f) => f.status)).toEqual(['a_valider']);
    t.setClock(Date.parse('2027-10-13T08:00:00.000Z'));
    expect(await t.anciens.validate(t.agent(), id)).toEqual({ ok: true, value: { status: 'essai', rule: null, delivered: false } });
    expect(await t.outbox()).toHaveLength(1);
  });

  it('[R02] [R04] une personne exclue ou arrêtée après la préparation sort de la liste, et sa relance est close', async () => {
    const t = await setup();
    const ines = await t.contact('Inès');
    await t.valued(ines.id, 400);
    await t.anciens.prepareMonth(t.network.id);
    await t.store.addExclusion({ networkId: t.network.id, personId: ines.id, reason: 'stop', notedAt: new Date(TUE_10H - 1000) });
    expect(await t.anciens.toValidate(t.agent())).toEqual({ ok: true, value: [] });
    expect((await t.followups()).map((f) => [f.status, f.rule])).toEqual([['sans_base', 'R02']]);
  });

  it('[R10] [R66] un texte de l’IA qui invente un chiffre, parle de récompense ou de l’IA est remplacé par le texte du code ; une panne aussi', async () => {
    for (const bad of ['votre bien vaut 10 % de plus', 'un cadeau vous attend', 'notre IA a pensé à vous', 'votre mandataire reste là']) {
      const t = await setup({ draft: async () => bad });
      const ines = await t.contact('Inès');
      await t.valued(ines.id, 400);
      await t.anciens.prepareMonth(t.network.id);
      const list = await t.anciens.toValidate(t.agent());
      expect(list.ok && list.value.map((i) => [i.draftBy, i.draft]), bad).toEqual([['secours', oldContactFallback('estimation_ancienne', 'Inès')]]);
      // Le refus est au journal, avec son code, jamais le texte [R12, R13].
      const refusals = (await t.journal.all()).filter((e) => e.type === 'anciens_contacts.ia_refusee');
      expect(refusals.map((e) => e.data.reason)).toEqual(['estimation_ancienne']);
      expect(JSON.stringify(refusals)).not.toContain(bad);
    }
    const t = await setup({
      draft: async () => {
        throw new Error('panne');
      },
    });
    const ines = await t.contact('Inès');
    await t.valued(ines.id, 400);
    expect(await t.anciens.prepareMonth(t.network.id)).toBe(1);
    expect((await t.followups()).map((f) => f.draft_by)).toEqual(['secours']);
    expect((await t.journal.all()).filter((e) => e.type === 'anciens_contacts.ia_en_panne')).toHaveLength(1);
    // Une IA qui ne répond jamais : le délai écoulé, le texte du code, et le passage continue.
    const stuck = await setup({ draft: () => new Promise<string>(() => undefined) });
    const slow = new AnciensContacts(stuck.db, stuck.journal, { now: () => new Date(TUE_10H), drafter: { draft: () => new Promise<string>(() => undefined) }, draftTimeoutMs: 20 });
    for (const who of ['Ana', 'Ben']) await stuck.valued((await stuck.contact(who)).id, 400);
    expect(await slow.prepareMonth(stuck.network.id)).toBe(2);
    expect((await stuck.followups()).map((f) => f.draft_by)).toEqual(['secours', 'secours']);
    expect((await stuck.journal.all()).filter((e) => e.type === 'anciens_contacts.ia_en_panne').map((e) => e.data.error)).toEqual(['TimeoutError', 'TimeoutError']);
    // Les textes de secours passent leurs propres contrôles.
    for (const reason of ['fin_de_bail', 'estimation_ancienne'] as const) expect(checkOldContactText(oldContactFallback(reason, null))).toBeNull();
    // Le texte de l'agent est contrôlé de même.
    const list = await t.anciens.toValidate(t.agent());
    if (!list.ok) throw new Error(list.code);
    expect(await t.anciens.validate(t.agent(), list.value[0]!.followupId, { text: 'Votre bien vaut 300 000 euros aujourd’hui.' })).toEqual({ ok: false, rule: null, code: 'text_figure' });
  });

  it('[R17] [R143] la dernière fin de bail notée fait foi : une erreur de saisie se corrige, l’ancienne reste rangée', async () => {
    const t = await setup();
    const lise = await t.contact('Lise');
    await t.anciens.noteLeaseEnd(t.agent(), lise.id, '2027-12-01');
    await t.anciens.noteLeaseEnd(t.agent(), lise.id, '2028-06-01');
    expect(await t.anciens.prepareMonth(t.network.id)).toBe(0);
    const noted = await t.anciens.leaseEnds(t.agent(), lise.id);
    expect(noted.ok && noted.value.map((d) => d.onDay)).toEqual(['2028-06-01', '2027-12-01']);
    await t.anciens.noteLeaseEnd(t.agent(), lise.id, '2027-12-02');
    expect(await t.anciens.prepareMonth(t.network.id)).toBe(1);
    const list = await t.anciens.toValidate(t.agent());
    expect(list.ok && list.value.map((i) => i.reasonDay)).toEqual(['2027-12-02']);
  });

  it('[R16] seul l’agent qui suit la fiche note un moment, lit et valide ses relances', async () => {
    const t = await setup();
    const ines = await t.contact('Inès');
    await t.valued(ines.id, 400);
    await t.anciens.prepareMonth(t.network.id);
    const dir = { role: 'direction' as const, userId: 'dir-1', networkId: t.network.id };
    expect(await t.anciens.toValidate(dir)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.anciens.toValidate(t.agent(t.sam.id))).toEqual({ ok: true, value: [] });
    expect(await t.anciens.noteLeaseEnd(t.agent(t.sam.id), ines.id, '2027-12-01')).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(await t.anciens.noteLeaseEnd(t.agent(), ines.id, '1er décembre')).toEqual({ ok: false, rule: null, code: 'bad_day' });
    const id = (await t.db.first<{ id: string }>('SELECT id FROM old_contact_followups'))!.id;
    expect(await t.anciens.validate(t.agent(t.sam.id), id)).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(await t.anciens.validate(dir, id)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    await expect(t.db.run('DELETE FROM old_contact_followups')).rejects.toThrow(/rien ne s'efface/);
    // Un agent parti ne lit ni ne valide plus rien [R86].
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.alex.id]);
    expect(await t.anciens.toValidate(t.agent())).toEqual({ ok: false, rule: 'R16', code: 'agent_inactive' });
    expect(await t.anciens.validate(t.agent(), id)).toEqual({ ok: false, rule: 'R16', code: 'agent_inactive' });
    expect(await t.anciens.noteLeaseEnd(t.agent(), ines.id, '2027-12-01')).toEqual({ ok: false, rule: 'R16', code: 'agent_inactive' });
  });

  it('[R08] AC10 : sur une fiche réunie, brouillon, liste et envoi portent le prénom de la fiche gardée', async () => {
    const t = await setup();
    const ines = await t.contact('Inès');
    await t.valued(ines.id, 400);
    const expected = await mergeWithDouble(t.db, t.store, ines.id, 'Inna');
    expect(await t.anciens.prepareMonth(t.network.id)).toBe(1);
    const list = await t.anciens.toValidate(t.agent());
    const item = list.ok ? list.value[0]! : null;
    expect(item?.firstName).toBe(expected);
    expect(item?.draft).toContain(`Bonjour ${expected}`);
    expect(await t.anciens.validate(t.agent(), item!.followupId)).toMatchObject({ ok: true });
    const [message] = await t.outbox();
    expect(message!.body).toContain(`Bonjour ${expected}`);
  });
});
