import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { Accompagnement, addWorkingMinutes, workingMinutesBetween } from '../src/reseau/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Un mardi, le 13 juillet 2027 ; le 14 est férié. Agents et clients inventés.
let clock = Date.parse('2027-07-13T08:00:00.000Z');
const at = (iso: string): void => {
  clock = Date.parse(iso);
};

async function setup() {
  clock = Date.parse('2027-07-13T08:00:00.000Z');
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const a = new Accompagnement(db, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const agent = async (n: string) => (await store.createAgent({ networkId: network.id, firstName: n, lastName: 'Test' })).id;
  const [nina, paul, lea] = [await agent('Nina'), await agent('Paul'), await agent('Léa')];
  const client = await store.createPerson({ networkId: network.id, agentId: paul, firstName: 'Client' });
  await store.createProject({ networkId: network.id, agentId: paul, personId: client.id, kind: 'sell' });
  const as = (id: string) => ({ role: 'agent' as const, userId: id, networkId: network.id });
  const dir = { role: 'direction' as const, userId: 'dir', networkId: network.id };
  return { db, journal, a, network, nina, paul, lea, client, as, dir };
}

it('heures ouvrées : jours ouvrés de 9 h à 18 h, jours fériés et changements d\'heure compris', () => {
  // Mardi 17 h à Paris, 2 h : 1 h le mardi, le 14 juillet est férié, puis 1 h le jeudi.
  expect(addWorkingMinutes(new Date('2027-07-13T15:00:00.000Z'), 120).toISOString()).toBe('2027-07-15T08:00:00.000Z');
  // 48 h ouvrées depuis mardi 17 h.
  expect(addWorkingMinutes(new Date('2027-07-13T15:00:00.000Z'), 48 * 60).toISOString()).toBe('2027-07-22T09:00:00.000Z');
  // Vendredi 17 h en hiver, 2 h : le lundi de Pâques est férié, donc mardi 10 h, à l'heure d'été.
  expect(addWorkingMinutes(new Date('2027-03-26T16:00:00.000Z'), 120).toISOString()).toBe('2027-03-30T08:00:00.000Z');
  // Vendredi 17 h en été, 2 h : la Toussaint tombe le lundi, donc mardi 10 h, à l'heure d'hiver.
  expect(addWorkingMinutes(new Date('2027-10-29T15:00:00.000Z'), 120).toISOString()).toBe('2027-11-02T09:00:00.000Z');
  // Samedi soir : rien ne court avant lundi 9 h.
  expect(addWorkingMinutes(new Date('2027-07-17T19:00:00.000Z'), 30).toISOString()).toBe('2027-07-19T07:30:00.000Z');
  expect(workingMinutesBetween(new Date('2027-07-13T15:00:00.000Z'), new Date('2027-07-15T08:00:00.000Z'))).toBe(120);
  expect(workingMinutesBetween(new Date('2027-07-15T08:00:00.000Z'), new Date('2027-07-13T15:00:00.000Z'))).toBe(0);
});

describeWithSqlite('référent, binôme d\'absence et assistance', () => {
  it('le référent est attribué par la direction pour 90 jours, puis n\'est plus en cours', async () => {
    const w = await setup();
    expect(await w.a.assignReferent(w.as(w.paul), w.nina, w.paul)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await w.a.assignReferent(w.dir, w.nina, w.nina)).toEqual({ ok: false, rule: null, code: 'invalid_referent' });
    expect(await w.a.assignReferent(w.dir, w.nina, w.paul)).toEqual({ ok: true, until: '2027-10-10' });
    expect(await w.a.referentOf(w.network.id, w.nina, new Date('2027-10-10T10:00:00.000Z'))).toEqual({ referentId: w.paul, until: '2027-10-10' });
    expect(await w.a.referentOf(w.network.id, w.nina, new Date('2027-10-11T10:00:00.000Z'))).toBeNull();
  });

  it('[R17] le partage est écrit avant l\'absence et ne change plus ; une absence sans partage écrit est refusée', async () => {
    const w = await setup();
    expect(await w.a.declareAbsence(w.as(w.paul), w.paul, { from: '2027-07-19', until: '2027-07-23', coverAgentId: w.lea })).toEqual({ ok: false, rule: 'R17', code: 'no_share_written' });
    const pair = await w.a.writePair(w.dir, { agentA: w.paul, agentB: w.lea, coverSharePct: 30 });
    if (!pair.ok) throw new Error(pair.code);
    expect(await w.a.writePair(w.as(w.paul), { agentA: w.paul, agentB: w.lea, coverSharePct: 90 })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    clock += 60_000;
    const absence = await w.a.declareAbsence(w.as(w.paul), w.paul, { from: '2027-07-19', until: '2027-07-23', coverAgentId: w.lea });
    expect(absence).toMatchObject({ ok: true, coverSharePct: 30 });
    // Un nouveau partage écrit pendant l'absence ne change pas celui de l'absence déjà déclarée.
    await w.a.writePair(w.dir, { agentA: w.lea, agentB: w.paul, coverSharePct: 60 });
    at('2027-07-20T08:00:00.000Z');
    expect((await w.a.coversAt(w.network.id, w.lea, w.paul))?.coverSharePct).toBe(30);
    await expect(w.db.run('UPDATE agent_pairs SET cover_share_pct = 99')).rejects.toThrow(/ne change plus/);
    await expect(w.db.run('UPDATE agent_absences SET until_day = ?', ['2027-12-31'])).rejects.toThrow(/ne change plus/);
    expect(await w.a.declareAbsence(w.as(w.paul), w.paul, { from: '2027-07-01', until: '2027-07-02', coverAgentId: w.lea })).toEqual({ ok: false, rule: null, code: 'past_absence' });
  });

  it('[R16] le binôme lit les dossiers de l\'absent pendant l\'absence déclarée, et plus rien après', async () => {
    const w = await setup();
    await w.a.writePair(w.dir, { agentA: w.paul, agentB: w.lea, coverSharePct: 30 });
    clock += 60_000;
    await w.a.declareAbsence(w.dir, w.paul, { from: '2027-07-19', until: '2027-07-23', coverAgentId: w.lea });
    // Avant.
    at('2027-07-18T20:00:00.000Z');
    expect(await w.a.coverFiles(w.as(w.lea), w.paul)).toEqual({ ok: false, rule: 'R16', code: 'not_covering' });
    // Pendant : du premier au dernier jour, heure de Paris.
    for (const iso of ['2027-07-18T22:30:00.000Z', '2027-07-21T12:00:00.000Z', '2027-07-23T21:30:00.000Z']) {
      at(iso);
      const r = await w.a.coverFiles(w.as(w.lea), w.paul);
      expect(r.ok && r.value.personIds).toEqual([w.client.id]);
      expect(r.ok && r.value.projectIds).toHaveLength(1);
    }
    // Après : plus rien.
    at('2027-07-23T22:30:00.000Z');
    expect(await w.a.coverFiles(w.as(w.lea), w.paul)).toEqual({ ok: false, rule: 'R16', code: 'not_covering' });
    // Un agent hors du binôme, jamais.
    at('2027-07-21T12:00:00.000Z');
    expect(await w.a.coverFiles(w.as(w.nina), w.paul)).toEqual({ ok: false, rule: 'R16', code: 'not_covering' });
    // Un binôme parti ne lit plus rien, même pendant l'absence.
    await w.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [w.lea]);
    expect(await w.a.coverFiles(w.as(w.lea), w.paul)).toEqual({ ok: false, rule: 'R16', code: 'not_covering' });
    const refusals = (await w.journal.all()).filter((e) => e.type === 'acces.refuse');
    expect(refusals).toHaveLength(4);
  });

  it('les délais d\'assistance sont calculés en heures ouvrées ; la direction est prévenue avant et après, une fois', async () => {
    const w = await setup();
    at('2027-07-13T15:00:00.000Z');
    const human = await w.a.ask(w.as(w.nina), { level: 'humain', topic: 'mandat', body: 'Comment remplir la durée d’un mandat exclusif ?' });
    const lawyer = await w.a.ask(w.as(w.nina), { level: 'avocat', topic: 'compromis', body: 'Une clause suspensive peut-elle viser un permis de construire ?' });
    if (!human.ok || !lawyer.ok) throw new Error('demande');
    expect(human.dueAt).toBe('2027-07-15T08:00:00.000Z');
    expect(lawyer.dueAt).toBe('2027-07-22T09:00:00.000Z');
    expect(await w.a.dueAlerts(w.network.id)).toEqual([]);
    // Jeudi 9 h 30 à Paris : il reste 30 minutes ouvrées pour l'humain.
    at('2027-07-15T07:30:00.000Z');
    const before = await w.a.dueAlerts(w.network.id);
    expect(before.map((x) => [x.level, x.kind])).toEqual([['humain', 'avant_echeance']]);
    expect(before[0]!.text).toBe("Une demande d'assistance attend un humain du réseau avant le 15/07 à 10 h 00.");
    expect(await w.a.dueAlerts(w.network.id)).toEqual([]);
    at('2027-07-15T08:00:00.000Z');
    expect((await w.a.dueAlerts(w.network.id)).map((x) => x.kind)).toEqual(['echeance_depassee']);
    expect(await w.a.dueAlerts(w.network.id)).toEqual([]);
    expect(await w.a.answer(w.dir, human.requestId)).toEqual({ ok: true, late: true });
    expect(await w.a.answer(w.dir, human.requestId)).toEqual({ ok: false, rule: null, code: 'already_answered' });
    // L'avocat : prévenu 4 h ouvrées avant (jeudi 22 à 11 h, donc mercredi 21 à 16 h), puis plus rien une fois répondu.
    at('2027-07-21T13:59:00.000Z');
    expect(await w.a.dueAlerts(w.network.id)).toEqual([]);
    at('2027-07-21T14:00:00.000Z');
    expect((await w.a.dueAlerts(w.network.id)).map((x) => [x.level, x.kind])).toEqual([['avocat', 'avant_echeance']]);
    expect(await w.a.answer(w.dir, lawyer.requestId)).toEqual({ ok: true, late: false });
    at('2027-07-23T14:00:00.000Z');
    expect(await w.a.dueAlerts(w.network.id)).toEqual([]);
  });

  it('[R15] aucune donnée de client dans une demande d\'assistance, d\'abord pour l\'avocat', async () => {
    const w = await setup();
    for (const body of ['Le vendeur joignable au 06 10 00 00 01 refuse de signer.', 'Voir la fiche person:abc, son mail est client@example.org', 'Son RIB FR76 3000 1007 9412 3456 7890 185 est-il bon ?']) {
      expect(await w.a.ask(w.as(w.nina), { level: 'avocat', topic: 'conformite', body })).toEqual({ ok: false, rule: 'R15', code: 'client_data' });
    }
    expect(await w.db.first('SELECT id FROM assistance_requests')).toBeNull();
    expect(JSON.stringify(await w.journal.all())).not.toMatch(/06 10|example|FR76/);
    expect(await w.a.ask(w.dir, { level: 'humain', topic: 'outil', body: 'Une question' })).toEqual({ ok: false, rule: 'R16', code: 'role' });
  });
});
