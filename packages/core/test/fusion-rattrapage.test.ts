import { expect, it } from 'vitest';
import {
  Acces,
  AppelsFiche,
  DecisionEnvoi,
  FicheAgent,
  FicheClient,
  FicheUnique,
  SqlJournalStore,
  UNDO_MERGE_CATCH_UP,
  applyMigrations,
  fromSyncSqlite,
  type SqlDatabase,
  type Viewer,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// RC57 · Une exclusion ou une note d'appel rangée juste après une fusion défaite suit aussi l'autre fiche.
// Tout est inventé. Le 8 juin 2027 est un mardi, 10 h à Paris : dans les heures d'envoi et d'appel [R01, R203].
const START = Date.parse('2027-06-08T08:00:00.000Z');
const DAY = 86_400_000;
const MINUTE = 60_000;

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = START;
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const unique = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, unique, journal, { now });
  const appels = new AppelsFiche(db, acces, journal, { now });
  const fiche = new FicheAgent(db, acces, { now });
  const decision = new DecisionEnvoi(db, store, unique, { now });
  const network = await store.createNetwork('Réseau test');
  const agent = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Essai' });
  const alex: Viewer = { role: 'agent', userId: agent.id, networkId: network.id };
  const given = new Date(START - 10 * DAY);
  const person = async (n: number) => {
    const p = await store.createPerson({ networkId: network.id, agentId: agent.id, firstName: 'Léa', lastName: 'Inventée' });
    await store.addIdentifier({ networkId: network.id, personId: p.id, kind: 'phone', value: `06 00 00 00 0${n}` });
    await store.addIdentifier({ networkId: network.id, personId: p.id, kind: 'email', value: `lea${n}@example.test` });
    await store.addConsent({ networkId: network.id, personId: p.id, purpose: 'prospecting', channel: 'phone', proof: 'accord de test', givenAt: given });
    await store.addConsent({ networkId: network.id, personId: p.id, purpose: 'suivi_vente', channel: 'email', proof: 'accord de test', givenAt: given });
    return p.id;
  };
  const a = await person(1);
  const b = await person(2);
  const trace = { journal, actor: 'direction:test' };
  const canSend = (id: string) => decision.decide(id, { channel: 'email', kind: 'follow_up', purpose: 'suivi_vente', at: new Date(clock) });
  const refusal = async (id: string) => {
    const r = await fiche.read(alex, id);
    if (!r.ok) throw new Error(r.code);
    return r.value.callRefusal;
  };
  const count = async (table: 'exclusions' | 'call_notes') => (await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))?.n;
  /** Réunies, puis séparées une minute plus tard : rend la fusion et l'instant où elle est défaite. */
  const mergeAndUndo = async (survivor = a, merged = b) => {
    // Les accords de test sont plus anciens que la réunion : défaire la fusion ne les ferme pas [R03].
    clock += MINUTE;
    const merge = await unique.merge({ survivorId: survivor, mergedId: merged, reason: 'même personne, test' });
    clock += MINUTE;
    const undoneAt = Date.parse(await unique.undoMerge(merge.id, trace));
    return { merge, undoneAt };
  };
  /** Une demande qui avait lu les fiches réunies range son geste après le lot, daté de son propre instant. */
  const lateExclusion = async (personId: string, at: number, reason: 'stop' | 'refused' = 'stop') => {
    const back = clock;
    clock = at;
    const e = await store.addExclusion({ networkId: network.id, personId, reason, notedAt: new Date(at) });
    clock = back;
    return e;
  };
  const lateRefusal = async (personId: string, at: number) => {
    const back = clock;
    clock = at;
    const r = await appels.note(alex, personId, { outcome: 'refused' });
    clock = back;
    if (!r.ok) throw new Error(r.code);
    return r.value;
  };
  return {
    db, store, unique, journal, trace, a, b, canSend, refusal, count, mergeAndUndo, lateExclusion, lateRefusal, person,
    advance: (ms: number) => (clock += ms),
    nowMs: () => clock,
  };
}

describeWithSqlite('RC57 · rattrapage d’une fusion défaite', () => {
  it('[R04] [R02] un arrêt rangé après le lot, daté d’avant la fusion défaite : recopié, plus aucun envoi sur l’autre fiche', async () => {
    const t = await setup();
    const { merge, undoneAt } = await t.mergeAndUndo();
    const late = await t.lateExclusion(t.a, undoneAt - 1000);
    t.advance(MINUTE);
    expect((await t.canSend(t.b)).allowed).toBe(true);

    const done = await t.unique.catchUpUndoneMerge(merge.id, t.trace);
    expect(done.exclusions).toHaveLength(1);
    expect(done.calls).toEqual([]);
    for (const id of [t.a, t.b]) {
      const d = await t.canSend(id);
      expect(d.allowed).toBe(false);
      expect(d.rule).toBe('R04');
    }
    const [copy] = await t.store.listExclusions(t.b);
    expect(copy).toMatchObject({ id: done.exclusions[0], reason: 'stop', noted_at: late.noted_at, created_at: late.created_at, lifted_at: null, undone_merge_id: merge.id });
  });

  it('[R02] un refus d’envoi rangé sur la fiche séparée remonte aussi vers la fiche gardée', async () => {
    const t = await setup();
    const { merge, undoneAt } = await t.mergeAndUndo();
    await t.lateExclusion(t.b, undoneAt - 1000, 'refused');
    t.advance(MINUTE);
    await t.unique.catchUpUndoneMerge(merge.id, t.trace);
    expect((await t.canSend(t.a)).rule).toBe('R02');
  });

  it('[R204] un refus d’appel noté après le lot ferme l’appel des deux côtés, avec la même heure', async () => {
    const t = await setup();
    const { merge, undoneAt } = await t.mergeAndUndo();
    const note = await t.lateRefusal(t.a, undoneAt - 1000);
    t.advance(MINUTE);
    expect(await t.refusal(t.b)).toBeNull();

    const done = await t.unique.catchUpUndoneMerge(merge.id, t.trace);
    expect(done.calls).toHaveLength(1);
    expect(await t.refusal(t.a)).toBe('refused_recently');
    expect(await t.refusal(t.b)).toBe('refused_recently');
    const copy = await t.db.first<{ person_id: string; noted_at: string; outcome: string }>('SELECT * FROM call_notes WHERE id = ?', [done.calls[0]!]);
    expect(copy).toMatchObject({ person_id: t.b, noted_at: note.notedAt, outcome: 'refused' });
  });

  it('[R04] [R204] rangé dans les 2 minutes après la fusion défaite : vaut aussi pour l’autre, plus prudent', async () => {
    const t = await setup();
    const { merge, undoneAt } = await t.mergeAndUndo();
    await t.lateExclusion(t.a, undoneAt + UNDO_MERGE_CATCH_UP.graceMs);
    await t.lateRefusal(t.a, undoneAt + UNDO_MERGE_CATCH_UP.graceMs - 1000);
    t.advance(5 * MINUTE);
    const done = await t.unique.catchUpUndoneMerge(merge.id, t.trace);
    expect(done.exclusions).toHaveLength(1);
    expect(done.calls).toHaveLength(1);
    expect((await t.canSend(t.b)).allowed).toBe(false);
  });

  it('[R04] [R204] rangé plus de 2 minutes après : la fiche de l’autre personne ne bouge pas', async () => {
    const t = await setup();
    const { merge, undoneAt } = await t.mergeAndUndo();
    await t.lateExclusion(t.a, undoneAt + UNDO_MERGE_CATCH_UP.graceMs + 1);
    await t.lateRefusal(t.a, undoneAt + UNDO_MERGE_CATCH_UP.graceMs + 1000);
    t.advance(5 * MINUTE);
    expect(await t.unique.catchUpUndoneMerge(merge.id, t.trace)).toEqual({ merge: merge.id, exclusions: [], calls: [] });
    expect(await t.store.listExclusions(t.b)).toEqual([]);
    expect((await t.canSend(t.b)).allowed).toBe(true);
    expect(await t.refusal(t.b)).toBeNull();
    expect((await t.canSend(t.a)).allowed).toBe(false);
  });

  it('[R04] une exclusion d’avant la réunion ne suit pas l’autre fiche', async () => {
    const t = await setup();
    await t.lateExclusion(t.a, t.nowMs() - DAY);
    t.advance(MINUTE);
    const { merge } = await t.mergeAndUndo();
    t.advance(MINUTE);
    await t.unique.catchUpUndoneMerge(merge.id, t.trace);
    expect(await t.store.listExclusions(t.b)).toEqual([]);
  });

  it('[R17] rappelé, rien n’est doublé ni effacé ; une ligne au journal, avec les identifiants seulement', async () => {
    const t = await setup();
    const { merge, undoneAt } = await t.mergeAndUndo();
    await t.lateExclusion(t.a, undoneAt - 1000);
    await t.lateRefusal(t.a, undoneAt - 1000);
    t.advance(MINUTE);
    const first = await t.unique.catchUpUndoneMerge(merge.id, t.trace);
    expect(await t.count('exclusions')).toBe(2);
    expect(await t.count('call_notes')).toBe(2);
    expect(await t.unique.catchUpUndoneMerge(merge.id, t.trace)).toEqual({ merge: merge.id, exclusions: [], calls: [] });
    await t.unique.undoMerge(merge.id, t.trace);
    expect(await t.count('exclusions')).toBe(2);
    expect(await t.count('call_notes')).toBe(2);

    const lines = (await t.journal.bySubject(`person:${t.a}`)).filter((e) => e.type === 'fiche.fusion_defaite_rattrapee');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.data).toEqual({ rule: 'R04', merge: merge.id, exclusions: first.exclusions, calls: first.calls });
    expect(lines[0]!.actor).toBe('direction:test');
    expect(JSON.stringify(lines[0])).not.toMatch(/Léa|Inventée|06 00|example\.test|accord de test/);
  });

  it('[R02] [R17] une levée faite après la fusion défaite, sur l’une ou l’autre fiche, n’est jamais défaite par un nouveau rattrapage', async () => {
    const t = await setup();
    const { merge, undoneAt } = await t.mergeAndUndo();
    const original = await t.lateExclusion(t.a, undoneAt - 1000, 'refused');
    t.advance(MINUTE);
    const [copyId] = (await t.unique.catchUpUndoneMerge(merge.id, t.trace)).exclusions;
    t.advance(5 * MINUTE);
    await t.store.liftExclusion(original.id, new Date(t.nowMs()));
    await t.unique.catchUpUndoneMerge(merge.id, t.trace);
    const open = async (id: string) => (await t.store.listExclusions(id)).filter((e) => e.lifted_at === null).length;
    expect(await open(t.a)).toBe(0);
    expect(await open(t.b)).toBe(1);
    await t.store.liftExclusion(copyId!, new Date(t.nowMs()));
    await t.unique.catchUpUndoneMerge(merge.id, t.trace);
    expect(await open(t.b)).toBe(0);
    expect(await t.count('exclusions')).toBe(2);
  });

  it('[R17] une coupure du journal après la copie : le rattrapage suivant écrit la ligne manquante, une seule fois', async () => {
    const t = await setup();
    const { merge, undoneAt } = await t.mergeAndUndo();
    await t.lateExclusion(t.a, undoneAt - 1000);
    t.advance(MINUTE);
    const cut = new SqlJournalStore(t.db);
    cut.append = async () => {
      throw new Error('coupure');
    };
    await expect(t.unique.catchUpUndoneMerge(merge.id, { journal: cut, actor: 'direction:test' })).rejects.toThrow('coupure');
    expect(await t.count('exclusions')).toBe(2);

    const retry = await t.unique.catchUpUndoneMerge(merge.id, t.trace);
    expect(retry.exclusions).toHaveLength(1);
    expect(await t.unique.catchUpUndoneMerge(merge.id, t.trace)).toEqual({ merge: merge.id, exclusions: [], calls: [] });
    const lines = (await t.journal.bySubject(`person:${t.a}`)).filter((e) => e.type === 'fiche.fusion_defaite_rattrapee');
    expect(lines.map((e) => e.data.exclusions)).toEqual([retry.exclusions]);
    expect(await t.count('exclusions')).toBe(2);
  });

  it('[R17] une fusion pas défaite : rien ne change', async () => {
    const t = await setup();
    t.advance(MINUTE);
    const merge = await t.unique.merge({ survivorId: t.a, mergedId: t.b, reason: 'même personne, test' });
    await t.lateExclusion(t.a, t.nowMs());
    t.advance(MINUTE);
    expect(await t.unique.catchUpUndoneMerge(merge.id, t.trace)).toEqual({ merge: merge.id, exclusions: [], calls: [] });
    expect(await t.count('exclusions')).toBe(1);
    await expect(t.unique.catchUpUndoneMerge('fusion-inconnue', t.trace)).rejects.toThrow('Fusion inconnue');
  });

  it('[R04] fiches réunies en chaîne : le rattrapage retrouve les mêmes couples que le lot', async () => {
    const t = await setup();
    const c = await t.person(3);
    t.advance(MINUTE);
    const inner = await t.unique.merge({ survivorId: t.b, mergedId: c, reason: 'même personne, test' });
    t.advance(MINUTE);
    const { merge, undoneAt } = await t.mergeAndUndo(t.a, t.b);
    await t.lateExclusion(t.a, undoneAt - 1000);
    t.advance(MINUTE);
    await t.unique.catchUpUndoneMerge(merge.id, t.trace);
    // B et C restent réunies : la copie va à B, et C la lit par elle.
    for (const id of [t.b, c]) expect((await t.canSend(id)).rule).toBe('R04');
    expect(await t.unique.membersOf(c)).toEqual([t.b, c]);
    expect(inner.undone_at).toBeNull();
  });

  it('[R04] le passage ne relit que les fusions défaites depuis 10 minutes', async () => {
    const t = await setup();
    const old = await t.mergeAndUndo();
    await t.lateExclusion(t.a, old.undoneAt - 1000);
    t.advance(UNDO_MERGE_CATCH_UP.windowMs + MINUTE);
    const c = await t.person(3);
    const d = await t.person(4);
    const recent = await t.mergeAndUndo(c, d);
    await t.lateExclusion(c, recent.undoneAt - 1000);
    t.advance(MINUTE);

    const caught = await t.unique.catchUpUndoneMerges(t.trace);
    expect(caught.map((x) => x.merge)).toEqual([recent.merge.id]);
    expect((await t.canSend(d)).rule).toBe('R04');
    expect(await t.store.listExclusions(t.b)).toEqual([]);
    expect(await t.unique.catchUpUndoneMerges(t.trace)).toEqual([]);
  });
});
