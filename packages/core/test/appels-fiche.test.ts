import { expect, it } from 'vitest';
import { Acces, AccordsFiche, AppelsFiche, CALL_FREQUENCY, FicheAgent, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Un mardi, 11 h à Paris. Personnes et numéros inventés.
const START = Date.parse('2027-06-08T09:00:00.000Z');
const DAY = 86_400_000;
/** Le mardi à la même heure, quel que soit le nombre de semaines : dans les heures d'appel [R203]. */
const weeks = (n: number) => START + n * 7 * DAY;

async function setup(consents: { prospecting?: boolean; request?: boolean } = { prospecting: true }) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = START;
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const unique = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, unique, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alexAgent = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Essai' });
  const samAgent = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Essai' });
  const alex: Viewer = { role: 'agent', userId: alexAgent.id, networkId: network.id };
  const sam: Viewer = { role: 'agent', userId: samAgent.id, networkId: network.id };
  const person = await store.createPerson({ networkId: network.id, agentId: alexAgent.id, firstName: 'Léa', lastName: 'Inventée' });
  await store.addIdentifier({ networkId: network.id, personId: person.id, kind: 'phone', value: '06 00 00 00 01' });
  const given = new Date(START - 10 * DAY);
  if (consents.prospecting) await store.addConsent({ networkId: network.id, personId: person.id, purpose: 'prospecting', channel: 'phone', proof: 'accord de test', givenAt: given });
  if (consents.request) await store.addConsent({ networkId: network.id, personId: person.id, purpose: 'rappel_demande', channel: 'phone', proof: 'demande de test', givenAt: given });
  const appels = new AppelsFiche(db, acces, journal, { now });
  const fiche = new FicheAgent(db, acces, { now });
  const accords = new AccordsFiche(store, acces, journal, { now, db });
  const state = async (id = person.id) => {
    const r = await fiche.read(alex, id);
    if (!r.ok) throw new Error(r.code);
    return { call: r.value.call, refusal: r.value.callRefusal, reopens: r.value.callReopensAt };
  };
  const calls = async (n: number) => {
    for (let i = 0; i < n; i++) {
      expect(await appels.note(alex, person.id, { outcome: 'called' })).toMatchObject({ ok: true, value: { already: false } });
      clock += 2 * 60_000;
    }
  };
  return { db, store, unique, journal, network, alex, sam, alexAgent, person, appels, fiche, accords, state, calls, setClock: (t: number) => (clock = t), now };
}

describeWithSqlite('AC09 · fréquence des appels de prospection', () => {
  it('[R204] le plafond d’appels ferme le bouton et l’écran sait quand il rouvre ; il rouvre à cette heure-là', async () => {
    const t = await setup();
    expect(CALL_FREQUENCY).toEqual({ maxCalls: 4, windowDays: 30, refusalDays: 60 });
    await t.calls(3);
    expect(await t.state()).toMatchObject({ refusal: null, reopens: null, call: expect.stringContaining('tel:') });
    await t.calls(1);
    const closed = await t.state();
    expect(closed).toMatchObject({ refusal: 'too_many_calls', call: null });
    expect(Date.parse(closed.reopens!)).toBe(START + 30 * DAY);
    t.setClock(START + 30 * DAY - 60_000);
    expect((await t.state()).refusal).toBe('too_many_calls');
    // Le mardi d'après, le premier appel est sorti de la période.
    t.setClock(weeks(5));
    expect(await t.state()).toMatchObject({ refusal: null, reopens: null });
  });

  it('[R204] un refus ferme 60 jours, un appel de plus n’y change rien, puis la prospection acceptée reprend', async () => {
    const t = await setup();
    expect(await t.appels.note(t.alex, t.person.id, { outcome: 'refused' })).toMatchObject({ ok: true });
    const closed = await t.state();
    expect(closed).toMatchObject({ refusal: 'refused_recently', call: null });
    expect(Date.parse(closed.reopens!)).toBe(START + 60 * DAY);
    t.setClock(weeks(8));
    expect((await t.state()).refusal).toBe('refused_recently');
    t.setClock(weeks(9));
    expect((await t.state()).refusal).toBeNull();
  });

  it('[R204] [R203] la fermeture la plus longue est celle qu’on annonce, et les heures passent après', async () => {
    const t = await setup();
    await t.calls(4);
    t.setClock(START + DAY);
    await t.appels.note(t.alex, t.person.id, { outcome: 'refused' });
    expect(Date.parse((await t.state()).reopens!)).toBe(START + 61 * DAY);
    // Un dimanche sans plafond ni refus : ce sont les heures qui ferment.
    const other = await setup();
    other.setClock(START + 5 * DAY);
    expect((await other.state()).refusal).toBe('outside_hours');
  });

  it('[R204] un appel sur demande de la personne ne compte pas, à toute heure', async () => {
    const t = await setup({ request: true });
    await t.calls(6);
    expect(await t.state()).toMatchObject({ refusal: null });
    const rows = await t.db.all<{ basis: string }>('SELECT basis FROM call_notes');
    expect(rows.map((r) => r.basis)).toEqual(Array(6).fill('request'));
  });

  it('[R204] [R03] une demande plus ancienne que le refus ne vaut plus ; une demande donnée après rouvre l’appel', async () => {
    const t = await setup({ request: true });
    await t.appels.note(t.alex, t.person.id, { outcome: 'refused' });
    expect((await t.state()).refusal).toBe('no_consent');
    // Soixante jours plus tard, l'ancienne demande ne revient pas d'elle-même.
    t.setClock(weeks(10));
    expect((await t.state()).refusal).toBe('no_consent');
    // Datée d'avant le refus, elle est refusée ; datée d'aujourd'hui, elle compte, sans être prise pour celle déjà rangée.
    const proof = 'La personne a rappelé pour être rappelée.';
    expect(await t.accords.record(t.alex, t.person.id, { purpose: 'rappel_demande', channel: 'phone', proof, givenOn: '2027-06-01' })).toEqual({ ok: false, rule: 'R204', code: 'given_before_refusal' });
    expect(await t.accords.record(t.alex, t.person.id, { purpose: 'rappel_demande', channel: 'phone', proof, givenOn: '2027-08-17' })).toMatchObject({ ok: true, value: { already: false } });
    expect(await t.state()).toMatchObject({ refusal: null, call: expect.stringContaining('tel:') });
  });

  it('[R204] les fiches réunies comptent ensemble, et par n’importe quelle fiche', async () => {
    const t = await setup();
    const double = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexAgent.id, firstName: 'Léa' });
    await t.calls(2);
    await t.unique.merge({ survivorId: double.id, mergedId: t.person.id, reason: 'même personne, test' });
    await t.calls(2);
    expect((await t.state(double.id)).refusal).toBe('too_many_calls');
    expect((await t.state(t.person.id)).refusal).toBe('too_many_calls');
  });

  it('[R17] [R13] [R16] un double geste fait une note, rien n’est effacé, le journal ne porte rien de personnel, un autre agent est refusé', async () => {
    const t = await setup();
    const first = await t.appels.note(t.alex, t.person.id, { outcome: 'called' });
    const again = await t.appels.note(t.alex, t.person.id, { outcome: 'called' });
    expect(again).toEqual({ ok: true, value: { noteId: first.ok ? first.value.noteId : '', notedAt: first.ok ? first.value.notedAt : '', already: true } });
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM call_notes')).toEqual({ n: 1 });
    expect(await t.appels.note(t.alex, t.person.id, { outcome: 'autre' })).toEqual({ ok: false, rule: 'R204', code: 'bad_outcome' });
    expect(await t.appels.note(t.sam, t.person.id, { outcome: 'called' })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.appels.note({ role: 'compliance', userId: 'c', networkId: t.network.id }, t.person.id, { outcome: 'called' })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM call_notes')).toEqual({ n: 1 });
    expect(JSON.stringify(await t.journal.all())).not.toMatch(/Léa|Inventée|06 00|\+33/);
  });
});

describeWithSqlite('AC12 · une fusion défaite garde les notes d’appel des deux côtés', () => {
  const trace = (t: Awaited<ReturnType<typeof setup>>) => ({ journal: t.journal, actor: 'direction:test' });
  const later = (t: Awaited<ReturnType<typeof setup>>) => t.setClock(t.now().getTime() + 60_000);
  /** Un doublon joignable, avec le même accord : seule la note peut fermer son bouton. */
  const doublon = async (t: Awaited<ReturnType<typeof setup>>) => {
    const d = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexAgent.id, firstName: 'Léa' });
    await t.store.addIdentifier({ networkId: t.network.id, personId: d.id, kind: 'phone', value: '06 00 00 00 09' });
    await t.store.addConsent({ networkId: t.network.id, personId: d.id, purpose: 'prospecting', channel: 'phone', proof: 'accord de test', givenAt: new Date(START - 10 * DAY) });
    later(t);
    return d;
  };

  it('[R204] [R17] refus noté, fusion défaite : le bouton reste fermé sur les deux fiches, jusqu’à la même heure ; rien n’est effacé', async () => {
    const t = await setup();
    const d = await doublon(t);
    const merge = await t.unique.merge({ survivorId: t.person.id, mergedId: d.id, reason: 'même personne, test' });
    await t.appels.note(t.alex, t.person.id, { outcome: 'refused' });
    const before = await t.db.all<{ noted_at: string }>('SELECT * FROM call_notes');
    await t.unique.undoMerge(merge.id, trace(t));
    const one = await t.state(t.person.id);
    expect(one).toMatchObject({ call: null, refusal: 'refused_recently' });
    expect(await t.state(d.id)).toEqual(one);
    const rows = await t.db.all<{ person_id: string; undone_merge_id: string | null }>('SELECT * FROM call_notes ORDER BY undone_merge_id IS NULL DESC');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.person_id).sort()).toEqual([t.person.id, d.id].sort());
    expect(rows[0]).toMatchObject(before[0]!);
    expect(rows[1]).toMatchObject({ person_id: d.id, outcome: 'refused', basis: 'prospecting', noted_at: before[0]!.noted_at, undone_merge_id: merge.id });
  });

  it('[R204] [R13] le plafond compte des deux côtés, avec l’heure de chaque appel ; le journal ne porte que des identifiants', async () => {
    const t = await setup();
    const d = await doublon(t);
    const merge = await t.unique.merge({ survivorId: t.person.id, mergedId: d.id, reason: 'même personne, test' });
    await t.calls(CALL_FREQUENCY.maxCalls);
    await t.unique.undoMerge(merge.id, trace(t));
    const one = await t.state(t.person.id);
    expect(one.refusal).toBe('too_many_calls');
    expect(await t.state(d.id)).toEqual(one);
    const line = (await t.journal.bySubject(`person:${t.person.id}`)).find((e) => e.type === 'fiche.fusion_defaite')!;
    expect((line.data as { calls: string[] }).calls).toHaveLength(CALL_FREQUENCY.maxCalls);
    expect(JSON.stringify(line)).not.toMatch(/Léa|06 00|\+33/);
  });

  it('[R204] une note d’avant la réunion reste sur sa fiche ; défaire deux fois ne double rien', async () => {
    const t = await setup();
    const d = await doublon(t);
    await t.appels.note(t.alex, t.person.id, { outcome: 'refused' });
    later(t);
    const merge = await t.unique.merge({ survivorId: t.person.id, mergedId: d.id, reason: 'même personne, test' });
    await t.unique.undoMerge(merge.id, trace(t));
    await t.unique.undoMerge(merge.id, trace(t));
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM call_notes')).toEqual({ n: 1 });
    expect((await t.state(t.person.id)).refusal).toBe('refused_recently');
    expect((await t.state(d.id)).refusal).toBeNull();
  });

  it('[R204] séparées puis réunies de nouveau : une note et sa copie comptent pour un seul appel, et ne sont pas recopiées deux fois', async () => {
    const t = await setup();
    const d = await doublon(t);
    const first = await t.unique.merge({ survivorId: t.person.id, mergedId: d.id, reason: 'même personne, test' });
    await t.calls(CALL_FREQUENCY.maxCalls - 1);
    await t.unique.undoMerge(first.id, trace(t));
    expect((await t.state(t.person.id)).refusal).toBeNull();
    later(t);
    const second = await t.unique.merge({ survivorId: t.person.id, mergedId: d.id, reason: 'de nouveau, test' });
    expect((await t.state(t.person.id)).refusal).toBeNull();
    await t.unique.undoMerge(second.id, trace(t));
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM call_notes')).toEqual({ n: 2 * (CALL_FREQUENCY.maxCalls - 1) });
    expect((await t.state(d.id)).refusal).toBeNull();
  });
});
