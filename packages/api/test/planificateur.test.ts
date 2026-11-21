import { afterEach, expect, it, vi } from 'vitest';
import { Planificateur, SITE_JOBS_TRIAL, SqlJournalStore, applyMigrations, slotOf, verifyChain, type ScheduledJob, type SqlDatabase } from '@aimmo/core';
import { runScheduler } from '../src/index.ts';
import { fromD1 } from '../src/d1.ts';
import worker, { type Env } from '../src/worker.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';
import { fakeD1 } from './fake-d1.ts';

// Hiver (UTC+1) et été (UTC+2) : 18 h à Paris tombe à 17 h ou 16 h UTC.
const WINTER_18H = Date.parse('2026-11-10T17:05:00.000Z');
const SUMMER_18H = Date.parse('2026-07-07T16:05:00.000Z');
const WINTER_07H = Date.parse('2026-11-10T06:05:00.000Z');
// 25 octobre 2026 : l'heure de 2 h revient (0 h 30 et 1 h 30 UTC sont toutes deux 2 h 30 à Paris).
const BACK_2H30_FIRST = Date.parse('2026-10-25T00:30:00.000Z');
const BACK_2H30_AGAIN = Date.parse('2026-10-25T01:30:00.000Z');

async function world() {
  const d1 = fakeD1(openMemoryDatabase());
  const db: SqlDatabase = fromD1(d1);
  await applyMigrations(db, loadMigrations());
  let clock = WINTER_18H;
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const passages = async () => (await journal.all()).filter((e) => e.type === 'planificateur.passage');
  return {
    d1,
    db,
    journal,
    now,
    passages,
    setClock: (t: number) => {
      clock = t;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

it('le créneau est la date et l’heure de Paris, été comme hiver', () => {
  expect(slotOf(new Date(WINTER_18H))).toMatchObject({ slot: '2026-11-10T18', hour: 18, weekday: 2 });
  expect(slotOf(new Date(SUMMER_18H))).toMatchObject({ slot: '2026-07-07T18', hour: 18 });
  expect(slotOf(new Date(BACK_2H30_FIRST)).slot).toBe(slotOf(new Date(BACK_2H30_AGAIN)).slot);
});

it('un registre mal écrit est refusé', () => {
  const ok: ScheduledJob = { name: 'a', hours: [8], run: async () => {} };
  expect(() => new Planificateur({} as SqlDatabase, {} as SqlJournalStore, [ok, ok])).toThrow();
  expect(() => new Planificateur({} as SqlDatabase, {} as SqlJournalStore, [{ ...ok, hours: [24] }])).toThrow();
  expect(() => new Planificateur({} as SqlDatabase, {} as SqlJournalStore, [{ ...ok, hours: [] }])).toThrow();
  expect(() => new Planificateur({} as SqlDatabase, {} as SqlJournalStore, [{ ...ok, name: 'Avec espace' }])).toThrow();
  expect(() => new Planificateur({} as SqlDatabase, {} as SqlJournalStore, [{ ...ok, weekdays: [0] }])).toThrow();
  expect(() => new Planificateur({} as SqlDatabase, {} as SqlJournalStore, [{ ...ok, minute: 60 }])).toThrow();
});

describeWithSqlite('B02 · planificateur du socle', () => {
  it('chaque tâche passe à ses heures de Paris, une seule fois par créneau', async () => {
    const w = await world();
    const calls: string[] = [];
    const jobs: ScheduledJob[] = [
      { name: 'soir', hours: [18], run: async (r) => void calls.push(`soir@${r.slot}`) },
      { name: 'matin', hours: [7], run: async (r) => void calls.push(`matin@${r.slot}`) },
      { name: 'dimanche', hours: [18], weekdays: [7], run: async () => void calls.push('dimanche') },
    ];
    const p = new Planificateur(w.db, w.journal, jobs, { now: w.now });
    expect(await p.tick()).toEqual({ slot: '2026-11-10T18', ran: ['soir'], skipped: [], failed: [] });
    // Le déclencheur repasse dans la même heure : rien ne repart.
    w.setClock(WINTER_18H + 20 * 60_000);
    expect(await p.tick()).toEqual({ slot: '2026-11-10T18', ran: [], skipped: ['soir'], failed: [] });
    w.setClock(WINTER_07H);
    expect((await p.tick()).ran).toEqual(['matin']);
    w.setClock(SUMMER_18H);
    expect((await p.tick()).ran).toEqual(['soir']);
    expect(calls).toEqual(['soir@2026-11-10T18', 'matin@2026-11-10T07', 'soir@2026-07-07T18']);
  });

  it('l’heure qui revient au changement d’heure ne fait qu’un passage', async () => {
    const w = await world();
    let n = 0;
    const p = new Planificateur(w.db, w.journal, [{ name: 'nuit', hours: [2], run: async () => void n++ }], { now: w.now });
    w.setClock(BACK_2H30_FIRST);
    await p.tick();
    w.setClock(BACK_2H30_AGAIN);
    await p.tick();
    expect(n).toBe(1);
  });

  it('[R13] chaque passage est écrit au journal ; une erreur aussi, sans son message, et les autres tâches passent', async () => {
    const w = await world();
    const jobs: ScheduledJob[] = [
      {
        name: 'casse',
        hours: [18],
        run: async () => {
          throw new TypeError('lea.exemple@example.test introuvable');
        },
      },
      { name: 'suivante', hours: [18], run: async () => {} },
    ];
    const result = await new Planificateur(w.db, w.journal, jobs, { now: w.now }).tick();
    expect(result).toMatchObject({ ran: ['suivante'], failed: ['casse'] });
    const passages = await w.passages();
    expect(passages.map((e) => [e.data.job, e.data.outcome, e.data.error])).toEqual([
      ['casse', 'error', 'TypeError'],
      ['suivante', 'ok', null],
    ]);
    expect(JSON.stringify(await w.journal.all())).not.toContain('example.test');
    expect((await verifyChain(await w.journal.all())).ok).toBe(true);
    const rows = await w.db.all<{ job: string; outcome: string }>('SELECT job, outcome FROM scheduled_runs ORDER BY job');
    expect(rows).toEqual([
      { job: 'casse', outcome: 'error' },
      { job: 'suivante', outcome: 'ok' },
    ]);
    // Une tâche en erreur ne repart pas dans le même créneau : elle repassera au suivant.
    expect((await new Planificateur(w.db, w.journal, jobs, { now: w.now }).tick()).skipped).toEqual(['casse', 'suivante']);
  });

  it('les passages ne s’effacent jamais', async () => {
    const w = await world();
    await new Planificateur(w.db, w.journal, [{ name: 'a', hours: [18], run: async () => {} }], { now: w.now }).tick();
    await expect(w.db.run('DELETE FROM scheduled_runs')).rejects.toThrow();
  });

  it('[R26] en mode essai, les tâches du site notent leur passage et n’appellent rien', async () => {
    const w = await world();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(SITE_JOBS_TRIAL.map((j) => j.name)).toEqual(['site.rappels_visite', 'site.courriers_vendeur']);
    expect(await runScheduler({ db: w.db, mode: 'essai', now: w.now })).toMatchObject({ ran: ['reseau.passage', 'site.rappels_visite', 'site.courriers_vendeur', 'estimation.relance_vendeur', 'rdv.rappels', 'rdv.briefs', 'mandats.suivi_valeur', 'acquereurs.alertes', 'acquereurs.mises_en_vente', 'visites.comptes_rendus', 'visites.point_semaine', 'apres_vente.demandes_avis', 'apres_vente.remerciements', 'apres_vente.relances', 'pilotage.passage', 'facturation.rapprochement', 'facturation.relances_envoi', 'location.envois', 'conformite.fuites', 'partenaires.suivi', 'partenaires.envois', 'investir.alertes', 'securite.gel_avoirs', 'securite.reclamations', 'sequences.passage', 'automatismes.scenarios', 'automatismes.dates'] });
    w.setClock(WINTER_07H);
    expect((await runScheduler({ db: w.db, mode: 'essai', now: w.now }))?.ran).toEqual(['reseau.passage', 'rdv.briefs', 'pilotage.passage', 'sauvegarde.surveillance', 'sauvegarde.surveillance_restauration', 'facturation.rapprochement', 'conformite.fuites', 'securite.gel_avoirs', 'veille_dpe.passage', 'automatismes.scenarios', 'automatismes.dates']);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await w.passages()).map((e) => e.data.job)).toEqual(['reseau.passage', 'site.rappels_visite', 'site.courriers_vendeur', 'estimation.relance_vendeur', 'rdv.rappels', 'rdv.briefs', 'mandats.suivi_valeur', 'acquereurs.alertes', 'acquereurs.mises_en_vente', 'visites.comptes_rendus', 'visites.point_semaine', 'apres_vente.demandes_avis', 'apres_vente.remerciements', 'apres_vente.relances', 'pilotage.passage', 'facturation.rapprochement', 'facturation.relances_envoi', 'location.envois', 'conformite.fuites', 'partenaires.suivi', 'partenaires.envois', 'investir.alertes', 'securite.gel_avoirs', 'securite.reclamations', 'sequences.passage', 'automatismes.scenarios', 'automatismes.dates', 'reseau.passage', 'rdv.briefs', 'pilotage.passage', 'sauvegarde.surveillance', 'sauvegarde.surveillance_restauration', 'facturation.rapprochement', 'conformite.fuites', 'securite.gel_avoirs', 'veille_dpe.passage', 'automatismes.scenarios', 'automatismes.dates']);
  });

  it('G02 · le plan du jour passe au déclencheur de 7 h 30 de Paris, pas à celui de 7 h 07', async () => {
    const w = await world();
    w.setClock(WINTER_07H);
    expect((await runScheduler({ db: w.db, mode: 'essai', now: w.now }))?.ran).not.toContain('mandats.plan_du_jour');
    w.setClock(WINTER_07H + 25 * 60_000);
    expect((await runScheduler({ db: w.db, mode: 'essai', now: w.now }))?.ran).toEqual(['mandats.plan_du_jour', 'pilotage.rapport_matin']);
  });

  it('hors mode essai, rien ne passe', async () => {
    const w = await world();
    expect(await runScheduler({ db: w.db, mode: undefined, now: w.now })).toBeNull();
    expect(await runScheduler({ db: w.db, mode: 'reel', now: w.now })).toBeNull();
    expect(await w.passages()).toHaveLength(0);
  });

  it('le déclencheur du Worker lance le planificateur', async () => {
    const w = await world();
    vi.useFakeTimers({ now: WINTER_18H, toFake: ['Date'] });
    try {
      // Le déclencheur de 18 h à Paris (17 h UTC), appelé avec quelques minutes de retard (BR65).
      await worker.scheduled({ scheduledTime: Date.parse('2026-11-10T17:00:00.000Z') }, { DB: w.d1, MODE: 'essai', RDV_LINK_BASE: 'https://rdv.example.test/r/' } as Env);
    } finally {
      vi.useRealTimers();
    }
    expect((await w.passages()).map((e) => e.data.job)).toEqual(['reseau.passage', 'site.rappels_visite', 'site.courriers_vendeur', 'estimation.relance_vendeur', 'rdv.rappels', 'rdv.briefs', 'mandats.suivi_valeur', 'acquereurs.alertes', 'acquereurs.mises_en_vente', 'visites.comptes_rendus', 'visites.point_semaine', 'apres_vente.demandes_avis', 'apres_vente.remerciements', 'apres_vente.relances', 'pilotage.passage', 'facturation.rapprochement', 'facturation.relances_envoi', 'location.envois', 'conformite.fuites', 'partenaires.suivi', 'partenaires.envois', 'investir.alertes', 'securite.gel_avoirs', 'securite.reclamations', 'sequences.passage', 'automatismes.scenarios', 'automatismes.dates']);
  });

  it('aux quarts d’heure du déclencheur (BR65) : tâches horaires une fois par heure, plan du jour à 7 h 30, publication une fois par quart d’heure (P10)', async () => {
    const w = await world();
    // 7 h 00, 7 h 05, 7 h 15, 7 h 30 et 7 h 45 à Paris, en hiver.
    for (const minute of [0, 5, 15, 30, 45]) {
      vi.useFakeTimers({ now: Date.parse(`2026-11-10T06:${String(minute).padStart(2, '0')}:00.000Z`), toFake: ['Date'] });
      try {
        await worker.scheduled({}, { DB: w.d1, MODE: 'essai' } as Env);
      } finally {
        vi.useRealTimers();
      }
    }
    const runs = await w.db.all<{ job: string; slot: string; started_at: string }>('SELECT job, slot, started_at FROM scheduled_runs ORDER BY started_at, job');
    expect(runs.filter((r) => r.job === 'annonces.publication').map((r) => r.slot)).toEqual(['2026-11-10T06:00Z', '2026-11-10T06:15Z', '2026-11-10T06:30Z', '2026-11-10T06:45Z']);
    const hourly = runs.filter((r) => r.job !== 'annonces.publication');
    // Chaque tâche horaire passe une seule fois dans l'heure ; le plan du jour attend sa minute.
    expect(new Set(hourly.map((r) => r.job)).size).toBe(hourly.length);
    expect(hourly.every((r) => r.slot === '2026-11-10T07')).toBe(true);
    expect(hourly.find((r) => r.job === 'mandats.plan_du_jour')?.started_at).toBe('2026-11-10T06:30:00.000Z');
    expect(hourly.find((r) => r.job === 'pilotage.rapport_matin')?.started_at).toBe('2026-11-10T06:30:00.000Z');
    expect(hourly.filter((r) => r.job !== 'mandats.plan_du_jour' && r.job !== 'pilotage.rapport_matin').every((r) => r.started_at === '2026-11-10T06:00:00.000Z')).toBe(true);
    // Hors mode essai, le déclencheur ne publie rien.
    vi.useFakeTimers({ now: Date.parse('2026-11-10T07:00:00.000Z'), toFake: ['Date'] });
    try {
      await worker.scheduled({}, { DB: w.d1, MODE: 'reel' } as Env);
    } finally {
      vi.useRealTimers();
    }
    expect(await w.db.first("SELECT slot FROM scheduled_runs WHERE slot = '2026-11-10T07:00Z'")).toBeNull();
  });
});
