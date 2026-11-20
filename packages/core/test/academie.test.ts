import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { FormationQuiz } from '../src/formation/index.ts';
import { ACADEMY_SETTINGS, Academie, addYears, hours } from '../src/reseau/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, agents et vidéos inventés. Horloge simulée, en heure de Paris à 10 h.
const DAY = 86_400_000;
let clock = Date.parse('2027-01-04T09:00:00.000Z');
const at = (day: string): void => {
  clock = Date.parse(`${day}T09:00:00.000Z`);
};
const today = (): string => new Date(clock).toISOString().slice(0, 10);
let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const academie = new Academie(db, journal, { now, newId: uuid });
  const quiz = new FormationQuiz(db, journal, { now, newId: uuid, random: () => 0.5 });
  const network = await store.createNetwork('Réseau test');
  const dir = { role: 'direction' as const, userId: 'dir-1', networkId: network.id };
  const newAgent = async (first: string) => (await store.createAgent({ networkId: network.id, firstName: first, lastName: 'Test' })).id;
  const as = (agentId: string) => ({ role: 'agent' as const, userId: agentId, networkId: network.id });
  let pos = 0;
  const module = async (minutes: number, topic: 'general' | 'deontologie' | 'non_discrimination' = 'general', mandatory = true) => {
    const r = await academie.addModule(dir, { title: `Module ${pos + 1}`, track: 'entree', position: ++pos, videoId: `vid${String(pos).padStart(8, '0')}`, durationMinutes: minutes, topic, mandatory });
    if (!r.ok) throw new Error(r.code);
    // Trois questions inventées par module ; la bonne réponse est toujours le choix 1.
    for (let q = 1; q <= 3; q += 1) {
      const added = await quiz.addQuestion(dir, { moduleId: r.moduleId, prompt: `Question inventée ${q} du module ${pos} ?`, choices: ['Faux', 'Vrai'], correctIndex: 1 });
      if (!added.ok) throw new Error(added.code);
    }
    return r.moduleId;
  };
  /** L'agent passe le quiz du module sans faute : une attestation le justifie (AU027). */
  const prove = async (agentId: string, moduleId: string, answer = 1) => {
    const started = await quiz.start(as(agentId), { moduleId });
    if (!started.ok) throw new Error(started.code);
    const r = await quiz.submit(as(agentId), started.attemptId, started.questions.map(() => answer));
    if (!r.ok) throw new Error(r.code);
    return r.attestation;
  };
  /** « J'ai fini », puis le quiz réussi. */
  const finish = async (agentId: string, moduleId: string) => {
    await academie.complete(as(agentId), moduleId);
    await prove(agentId, moduleId);
  };
  return { db, journal, academie, quiz, network, dir, newAgent, as, module, prove, finish };
}

describeWithSqlite('académie et heures de formation obligatoire', () => {
  it('[R85] [R10] le compteur ne compte que des modules justifiés et des présences rangées', async () => {
    at('2027-01-04');
    const w = await setup();
    const a = await w.newAgent('Ana');
    const m1 = await w.module(90);
    await w.module(120); // jamais fait : ne compte pas
    const optional = await w.module(60, 'general', false);
    expect((await w.academie.complete(w.as(a), m1)).ok).toBe(true);
    expect(await w.academie.complete(w.as(a), m1)).toEqual({ ok: true, already: true });
    await w.academie.complete(w.as(a), optional);
    await w.prove(a, m1);
    await w.prove(a, optional);
    const past = await w.academie.addSession(w.dir, { kind: 'salle', title: 'Séance de Dijon', heldOn: '2027-01-02', durationMinutes: 180, topic: 'deontologie' });
    const unrecorded = await w.academie.addSession(w.dir, { kind: 'mensuelle', title: 'Séance du mois', heldOn: '2027-01-03', durationMinutes: 120 });
    const future = await w.academie.addSession(w.dir, { kind: 'direct', title: 'Direct à venir', heldOn: '2027-02-01', durationMinutes: 60 });
    if (!past.ok || !unrecorded.ok || !future.ok) throw new Error('séance');
    expect(await w.academie.recordAttendance(w.dir, past.sessionId, { agentId: a, recorderName: '' })).toEqual({ ok: false, rule: null, code: 'recorder_required' });
    expect(await w.academie.recordAttendance(w.dir, future.sessionId, { agentId: a, recorderName: 'Shawez' })).toEqual({ ok: false, rule: null, code: 'session_not_held' });
    expect((await w.academie.recordAttendance(w.dir, past.sessionId, { agentId: a, recorderName: 'Shawez' })).ok).toBe(true);
    expect(await w.academie.recordAttendance(w.as(a), unrecorded.sessionId, { agentId: a, recorderName: 'Moi' })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    const c = await w.academie.counter(w.as(a), a);
    if (!c.ok) throw new Error('compteur');
    // La séance du 2 janvier est avant l'entrée de l'agent (4 janvier) : elle ne compte pas dans sa première année.
    expect(c.value.startedOn).toBe('2027-01-04');
    expect(c.value.obligations.map((o) => [o.obligation, o.from, o.until, o.doneMinutes, o.missingMinutes])).toEqual([
      ['annuelle', '2027-01-04', '2028-01-03', 90, 750],
      ['triennale', '2027-01-04', '2030-01-03', 90, 2430],
      ['deontologie', '2027-01-04', '2030-01-03', 0, 120],
      ['non_discrimination', '2027-01-04', '2030-01-03', 0, 120],
    ]);
  });

  it('[R85] déontologie et non-discrimination comptées à part, dans la période de 3 ans', async () => {
    at('2027-01-04');
    const w = await setup();
    const a = await w.newAgent('Bob');
    const deonto = await w.module(120, 'deontologie');
    const nd = await w.module(60, 'non_discrimination');
    at('2028-03-01');
    await w.finish(a, deonto);
    await w.finish(a, nd);
    const c = await w.academie.counter(w.dir, a);
    if (!c.ok) throw new Error('compteur');
    const by = Object.fromEntries(c.value.obligations.map((o) => [o.obligation, o]));
    expect(by.annuelle).toMatchObject({ from: '2028-01-04', until: '2029-01-03', doneMinutes: 180 });
    expect(by.triennale).toMatchObject({ doneMinutes: 180, missingMinutes: 2340 });
    expect(by.deontologie).toMatchObject({ doneMinutes: 120, missingMinutes: 0 });
    expect(by.non_discrimination).toMatchObject({ doneMinutes: 60, missingMinutes: 60 });
  });

  it('[R85] sur 10 agents à horloge simulée, chaque manque est signalé 90 puis 30 jours avant l\'échéance, une seule fois', async () => {
    at('2027-01-04');
    const w = await setup();
    const big = [await w.module(420), await w.module(420)];
    const deonto = await w.module(120, 'deontologie');
    const nd = await w.module(120, 'non_discrimination');
    const agents: string[] = [];
    for (let i = 0; i < 10; i += 1) agents.push(await w.newAgent(`Agent${i}`));
    // Les agents pairs font leurs 14 h de l'année ; les autres non.
    for (const [i, a] of agents.entries()) if (i % 2 === 0) for (const m of big) await w.finish(a, m);
    const seen: { agentId: string; obligation: string; daysBefore: number; day: string; text: string }[] = [];
    // Un passage par jour pendant toute la première année.
    for (let day = Date.parse('2027-01-04T09:00:00.000Z'); day <= Date.parse('2028-01-10T09:00:00.000Z'); day += DAY) {
      clock = day;
      for (const alert of await w.academie.dueAlerts(w.network.id)) seen.push({ ...alert, day: today() });
    }
    const annual = seen.filter((s) => s.obligation === 'annuelle');
    // 5 agents en manque, 2 paliers chacun, ni plus ni moins.
    expect(annual).toHaveLength(10);
    for (const [i, a] of agents.entries()) {
      const mine = annual.filter((s) => s.agentId === a);
      if (i % 2 === 0) expect(mine).toEqual([]);
      else expect(mine.map((s) => [s.daysBefore, s.day])).toEqual([[90, '2027-10-05'], [30, '2027-12-04']]);
    }
    expect(annual[0]!.text).toBe('Il vous reste 14 h de formation pour l\'année à faire avant le 03/01/2028, à votre rythme.');
    // Pas d'alerte de 3 ans pendant la première année : l'échéance est en 2030.
    expect(seen.filter((s) => s.obligation !== 'annuelle')).toEqual([]);
    // Fin de la période de 3 ans : chaque manque de déontologie et de non-discrimination signalé aussi.
    for (const a of agents.slice(0, 3)) {
      await w.finish(a, deonto);
      await w.finish(a, nd);
    }
    const late: typeof seen = [];
    for (let day = Date.parse('2029-09-01T09:00:00.000Z'); day <= Date.parse('2030-01-03T09:00:00.000Z'); day += DAY) {
      clock = day;
      for (const alert of await w.academie.dueAlerts(w.network.id)) late.push({ ...alert, day: today() });
    }
    const deontoAlerts = late.filter((s) => s.obligation === 'deontologie');
    expect(deontoAlerts).toHaveLength(14);
    expect(new Set(deontoAlerts.map((s) => s.agentId))).toEqual(new Set(agents.slice(3)));
    expect(late.filter((s) => s.obligation === 'non_discrimination')).toHaveLength(14);
    expect(late.filter((s) => s.obligation === 'triennale')).toHaveLength(20);
    expect(deontoAlerts.find((s) => s.daysBefore === 90)!.day).toBe('2029-10-05');
  });

  it('[R85] un agent arrivé en retard d\'un palier reçoit seulement le plus proche, et rien n\'est prévenu une fois l\'obligation remplie', async () => {
    at('2027-01-04');
    const w = await setup();
    const a = await w.newAgent('Cid');
    const big = [await w.module(420), await w.module(420)];
    at('2027-12-20');
    const alerts = await w.academie.dueAlerts(w.network.id);
    expect(alerts.filter((x) => x.obligation === 'annuelle').map((x) => x.daysBefore)).toEqual([30]);
    expect(await w.academie.dueAlerts(w.network.id)).toEqual([]);
    // L'année suivante, il fait ses heures avant les paliers : aucune alerte annuelle.
    at('2028-02-01');
    for (const m of big) await w.finish(a, m);
    const next: string[] = [];
    for (let day = Date.parse('2028-02-01T09:00:00.000Z'); day <= Date.parse('2029-01-03T09:00:00.000Z'); day += DAY) {
      clock = day;
      next.push(...(await w.academie.dueAlerts(w.network.id)).filter((x) => x.obligation === 'annuelle').map((x) => x.until));
    }
    expect(next).toEqual([]);
  });

  it('[R85] [R10] AU027 un clic « J\'ai fini » seul ne crédite aucune heure : déclarée à part, comptée seulement avec une attestation', async () => {
    at('2027-01-04');
    const w = await setup();
    const a = await w.newAgent('Gil');
    const b = await w.newAgent('Hal');
    const deonto = await w.module(120, 'deontologie');
    const general = await w.module(60);
    const line = async (who: string, obligation: string) => {
      const c = await w.academie.counter(w.dir, who);
      if (!c.ok) throw new Error('compteur');
      const o = c.value.obligations.find((x) => x.obligation === obligation)!;
      return [o.doneMinutes, o.declaredMinutes, o.missingMinutes];
    };
    // Le constat : un clic suffisait à créditer toute la durée de la vidéo. Il ne crédite plus rien.
    at('2027-02-01');
    expect(await w.academie.complete(w.as(a), deonto)).toEqual({ ok: true, already: false });
    expect(await line(a, 'deontologie')).toEqual([0, 120, 120]);
    expect(await line(a, 'annuelle')).toEqual([0, 120, 840]);
    // Un quiz raté ne justifie rien.
    expect(await w.prove(a, deonto, 0)).toBeNull();
    expect(await line(a, 'deontologie')).toEqual([0, 120, 120]);
    // L'attestation d'un autre agent ne justifie rien pour lui.
    await w.finish(b, deonto);
    expect(await line(b, 'deontologie')).toEqual([120, 0, 0]);
    expect(await line(a, 'deontologie')).toEqual([0, 120, 120]);
    // Le quiz réussi, rangé avec son empreinte, justifie le module : compté au jour de l'attestation.
    at('2027-02-03');
    const attestation = await w.prove(a, deonto);
    expect(attestation?.document.issuedOn).toBe('2027-02-03');
    expect(await line(a, 'deontologie')).toEqual([120, 0, 0]);
    // Un second quiz réussi ne compte pas le module deux fois.
    await w.prove(a, deonto);
    expect(await line(a, 'annuelle')).toEqual([120, 0, 720]);
    // Un module non fait n'a pas d'attestation (le quiz exige le module fait) ; fait ensuite, il reste déclaré sans quiz.
    expect(await w.prove(a, general)).toBeNull();
    await w.academie.complete(w.as(a), general);
    expect(await line(a, 'annuelle')).toEqual([120, 60, 720]);
    // L'attestation d'un parcours justifie chacun de ses modules faits.
    const started = await w.quiz.start(w.as(a), { track: 'entree' });
    if (!started.ok) throw new Error(started.code);
    const r = await w.quiz.submit(w.as(a), started.attemptId, started.questions.map(() => 1));
    expect(r.ok && r.attestation !== null).toBe(true);
    expect(await line(a, 'annuelle')).toEqual([180, 0, 660]);
    // Les alertes ne lisent que les heures justifiées : un agent qui a seulement cliqué est prévenu.
    const c = await w.newAgent('Ivy');
    await w.academie.complete(w.as(c), deonto);
    // Entrée le 3 février 2027 : la période de 3 ans finit le 2 février 2030, le palier de 90 jours tombe le 4 novembre 2029.
    at('2029-11-04');
    const alerts = (await w.academie.dueAlerts(w.network.id)).filter((x) => x.agentId === c && x.obligation === 'deontologie');
    expect(alerts.map((x) => [x.daysBefore, x.missingMinutes])).toEqual([[90, 120]]);
  });

  it('[R85] [R10] AU028 la période de référence et les attestations d\'avant l\'arrivée sont reprises, sans remise à zéro', async () => {
    at('2027-01-04');
    const w = await setup();
    const a = await w.newAgent('Jo');
    const line = async (obligation: string) => {
      const c = await w.academie.counter(w.as(a), a);
      if (!c.ok) throw new Error('compteur');
      const o = c.value.obligations.find((x) => x.obligation === obligation)!;
      return { startedOn: c.value.startedOn, arrivedOn: c.value.arrivedOn, source: c.value.periodSource, from: o.from, until: o.until, done: o.doneMinutes, missing: o.missingMinutes };
    };
    // Le constat : sans reprise, la période de 3 ans repart de l'arrivée, comme si l'agent n'avait jamais été formé.
    expect(await line('triennale')).toEqual({ startedOn: '2027-01-04', arrivedOn: '2027-01-04', source: 'arrivee', from: '2027-01-04', until: '2030-01-03', done: 0, missing: 2520 });
    // La direction reprend son cycle d'avant (commencé le 1er septembre 2025) et deux attestations, pièce et nom à l'appui.
    expect(await w.academie.setPriorPeriod(w.dir, a, { cycleStart: '2025-09-01', proofRef: 'pieces/attestation-cycle-inventee.pdf', recorderName: 'Shawez' })).toEqual({ ok: true });
    expect((await w.academie.addPriorTraining(w.dir, a, { heldOn: '2026-03-10', durationMinutes: 600, proofRef: 'pieces/formation-inventee-1.pdf', recorderName: 'Shawez' })).ok).toBe(true);
    expect((await w.academie.addPriorTraining(w.dir, a, { heldOn: '2026-11-02', durationMinutes: 120, topic: 'deontologie', proofRef: 'pieces/formation-inventee-2.pdf', recorderName: 'Shawez' })).ok).toBe(true);
    // Les périodes continuent le cycle d'avant : rien n'est remis à zéro, les heures d'avant comptent.
    expect(await line('triennale')).toEqual({ startedOn: '2025-09-01', arrivedOn: '2027-01-04', source: 'cycle_anterieur', from: '2025-09-01', until: '2028-08-31', done: 720, missing: 1800 });
    expect(await line('deontologie')).toMatchObject({ done: 120, missing: 0 });
    expect(await line('annuelle')).toMatchObject({ from: '2026-09-01', until: '2027-08-31', done: 120, missing: 720 });
    // Une heure faite à l'académie s'ajoute au même cycle.
    const m = await w.module(60);
    await w.finish(a, m);
    expect(await line('triennale')).toMatchObject({ done: 780, missing: 1740 });
    // Une correction est une nouvelle ligne : la dernière période rangée l'emporte, rien ne s'efface ni ne change.
    expect((await w.academie.setPriorPeriod(w.dir, a, { cycleStart: '2025-10-01', proofRef: 'pieces/attestation-cycle-corrigee.pdf', recorderName: 'Shawez' })).ok).toBe(true);
    expect(await line('triennale')).toMatchObject({ from: '2025-10-01', until: '2028-09-30', done: 780 });
    expect(Number((await w.db.first<{ n: number }>('SELECT count(*) AS n FROM academy_prior_entries'))?.n)).toBe(4);
    await expect(w.db.run('DELETE FROM academy_prior_entries')).rejects.toThrow();
    await expect(w.db.run("UPDATE academy_prior_entries SET day = '2020-01-01'")).rejects.toThrow();
    // Les alertes lisent la même période : l'échéance du cycle repris, pas celle de l'arrivée.
    at('2028-07-02');
    const alerts = (await w.academie.dueAlerts(w.network.id)).filter((x) => x.agentId === a && x.obligation === 'triennale');
    expect(alerts.map((x) => [x.until, x.daysBefore])).toEqual([['2028-09-30', 90]]);
  });

  it('[R85] [R16] AU028 la reprise du cycle d\'avant : direction seule, pièce et nom exigés, jamais après l\'arrivée ; au journal, des identifiants', async () => {
    at('2027-01-04');
    const w = await setup();
    const a = await w.newAgent('Kim');
    const ok = { cycleStart: '2025-09-01', proofRef: 'pieces/inventee.pdf', recorderName: 'Shawez' };
    expect(await w.academie.setPriorPeriod(w.as(a), a, ok)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await w.academie.addPriorTraining(w.as(a), a, { heldOn: '2026-01-01', durationMinutes: 60, proofRef: 'p', recorderName: 'Moi' })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await w.academie.setPriorPeriod({ role: 'direction', userId: 'x', networkId: 'ailleurs' }, a, ok)).toEqual({ ok: false, rule: null, code: 'unknown_agent' });
    expect(await w.academie.setPriorPeriod(w.dir, a, { ...ok, proofRef: ' ' })).toEqual({ ok: false, rule: null, code: 'proof_required' });
    expect(await w.academie.setPriorPeriod(w.dir, a, { ...ok, recorderName: '' })).toEqual({ ok: false, rule: null, code: 'recorder_required' });
    expect(await w.academie.setPriorPeriod(w.dir, a, { ...ok, cycleStart: '2025-02-30' })).toEqual({ ok: false, rule: null, code: 'invalid_day' });
    expect(await w.academie.setPriorPeriod(w.dir, a, { ...ok, cycleStart: '2027-01-05' })).toEqual({ ok: false, rule: null, code: 'not_before_arrival' });
    expect(await w.academie.addPriorTraining(w.dir, a, { heldOn: '2027-02-01', durationMinutes: 60, proofRef: 'p', recorderName: 'Shawez' })).toEqual({ ok: false, rule: null, code: 'not_before_arrival' });
    expect(await w.academie.addPriorTraining(w.dir, a, { heldOn: '2026-02-01', durationMinutes: 0, proofRef: 'p', recorderName: 'Shawez' })).toEqual({ ok: false, rule: null, code: 'invalid_duration' });
    expect(await w.academie.addPriorTraining(w.dir, a, { heldOn: '2026-02-01', durationMinutes: 60, topic: 'cuisine', proofRef: 'p', recorderName: 'Shawez' })).toEqual({ ok: false, rule: null, code: 'invalid_topic' });
    expect(Number((await w.db.first<{ n: number }>('SELECT count(*) AS n FROM academy_prior_entries'))?.n)).toBe(0);
    expect((await w.academie.setPriorPeriod(w.dir, a, ok)).ok).toBe(true);
    const journal = JSON.stringify(await w.journal.all());
    expect(journal).toContain('academie.periode_reprise');
    expect(journal).not.toMatch(/Shawez|inventee\.pdf|Kim/);
  });

  it('[R14] [R85] l\'académie ne note pas l\'agent et n\'impose aucun horaire', async () => {
    const w = await setup();
    const tables = ['academy_modules', 'academy_completions', 'academy_sessions', 'academy_attendance', 'academy_alerts'];
    for (const table of tables) {
      const cols = (await w.db.all<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`)).map((c) => c.name);
      expect(cols.some((c) => /score|note|grade|rank|rang|level|niveau|deadline|due|limite|horaire|time_slot/.test(c))).toBe(false);
    }
    // Un module ne prend ni date limite ni horaire : un champ en trop n'est pas rangé.
    const r = await w.academie.addModule(w.dir, { title: 'Prise de mandat', track: 'vente', position: 1, videoId: 'abcdefghijk', durationMinutes: 12, deadline: '2027-02-01' } as never);
    expect(r.ok).toBe(true);
    expect(JSON.stringify(await w.db.all('SELECT * FROM academy_modules'))).not.toContain('2027-02-01');
    // Le texte d'alerte ne presse pas l'agent d'un horaire.
    expect(hours(90)).toBe('1 h 30');
    expect(hours(45)).toBe('45 min');
  });

  it('[R16] seuls l\'agent lui-même et la direction lisent le compteur ; chaque refus est au journal', async () => {
    const w = await setup();
    const a = await w.newAgent('Dan');
    const b = await w.newAgent('Eve');
    expect((await w.academie.counter(w.as(a), a)).ok).toBe(true);
    expect((await w.academie.counter(w.dir, a)).ok).toBe(true);
    expect(await w.academie.counter(w.as(b), a)).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(await w.academie.counter({ role: 'compliance', userId: 'c', networkId: w.network.id }, a)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await w.academie.counter({ role: 'partner', userId: 'p', networkId: w.network.id }, a)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect((await w.academie.counter({ role: 'direction', userId: 'x', networkId: 'ailleurs' }, a)).ok).toBe(false);
    expect(await w.academie.addModule(w.as(a), { title: 'Module', track: 'entree', position: 1, videoId: 'abcdefghijk', durationMinutes: 10 })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await w.academie.complete(w.dir, 'x')).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await w.academie.tracks({ role: 'partner', userId: 'p', networkId: w.network.id })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    const refused = (await w.journal.all()).filter((e) => e.type === 'acces.refuse');
    expect(refused).toHaveLength(7);
    expect(JSON.stringify(await w.journal.all())).not.toMatch(/Dan|Eve/);
  });

  it('parcours : l\'entrée d\'abord, puis chaque spécialité, dans l\'ordre ; un module mal décrit est refusé', async () => {
    const w = await setup();
    await w.academie.addModule(w.dir, { title: 'Estimer', track: 'vente', position: 2, videoId: 'bbbbbbbbbbb', durationMinutes: 15 });
    await w.academie.addModule(w.dir, { title: 'Bienvenue', track: 'entree', position: 1, videoId: 'aaaaaaaaaaa', durationMinutes: 8 });
    await w.academie.addModule(w.dir, { title: 'Prendre un mandat', track: 'vente', position: 1, videoId: 'ccccccccccc', durationMinutes: 20, scriptRef: 'scripts/mandat.md' });
    const t = await w.academie.tracks(w.as(await w.newAgent('Fay')));
    if (!t.ok) throw new Error('parcours');
    expect(t.value.map((x) => [x.track, x.modules.map((m) => m.title)])).toEqual([
      ['entree', ['Bienvenue']],
      ['vente', ['Prendre un mandat', 'Estimer']],
    ]);
    expect(await w.academie.addModule(w.dir, { title: 'Doublon', track: 'vente', position: 1, videoId: 'ddddddddddd', durationMinutes: 5 })).toEqual({ ok: false, rule: null, code: 'position_taken' });
    expect(await w.academie.addModule(w.dir, { title: 'Vidéo', track: 'vente', position: 3, videoId: 'https://youtu.be/x', durationMinutes: 5 })).toEqual({ ok: false, rule: null, code: 'invalid_video' });
    expect(await w.academie.addModule(w.dir, { title: 'Durée', track: 'vente', position: 3, videoId: 'eeeeeeeeeee', durationMinutes: 0 })).toEqual({ ok: false, rule: null, code: 'invalid_duration' });
    expect(await w.academie.addModule(w.dir, { title: 'Parcours', track: 'cuisine', position: 3, videoId: 'eeeeeeeeeee', durationMinutes: 5 })).toEqual({ ok: false, rule: null, code: 'invalid_track' });
    expect(await w.academie.addSession(w.dir, { kind: 'salle', title: 'Séance', heldOn: '2027-02-30', durationMinutes: 60 })).toEqual({ ok: false, rule: null, code: 'invalid_day' });
  });
});

it('années ajoutées, 29 février compris', () => {
  expect(addYears('2027-01-04', 1)).toBe('2028-01-04');
  expect(addYears('2028-02-29', 1)).toBe('2029-02-28');
  expect(addYears('2028-02-29', 4)).toBe('2032-02-29');
  expect(ACADEMY_SETTINGS).toMatchObject({ annualMinutes: 840, triennialMinutes: 2520, deontologyMinutes: 120, nonDiscriminationMinutes: 120 });
});
