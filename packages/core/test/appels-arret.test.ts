import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { FicheUnique } from '../src/fiche/fusion.ts';
import { Appels, stopSegment, type CallSegment, type CallTranscriber, type IncomingCall } from '../src/voix/appels.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const T0 = Date.parse('2026-12-08T09:00:00.000Z');
const at = (s: number): Date => new Date(T0 + s * 1000);

/** Une conversation inventée : l'appelant accepte l'enregistrement, parle de son projet, puis demande l'arrêt. */
const STOP_SAID: CallSegment[] = [
  { speaker: 'agent', startS: 0, endS: 6, text: 'Bonjour, cet appel est enregistré pour mieux vous suivre, vous êtes d’accord ?' },
  { speaker: 'appelant', startS: 6, endS: 8, text: 'Oui, d’accord.' },
  { speaker: 'appelant', startS: 9, endS: 20, text: 'J’ai vendu ma maison à Talant le mois dernier.' },
  { speaker: 'appelant', startS: 21, endS: 27, text: 'Alors ne m’appelez plus, s’il vous plaît.' },
  { speaker: 'agent', startS: 28, endS: 30, text: 'Entendu, bonne journée.' },
];

const NO_STOP: CallSegment[] = [
  { speaker: 'appelant', startS: 6, endS: 8, text: 'Oui, d’accord.' },
  { speaker: 'appelant', startS: 9, endS: 20, text: 'Je souhaite vendre ma maison à Talant, rappelez-moi demain.' },
];

function transcriber(segments: CallSegment[]): CallTranscriber & { count: number } {
  const t = {
    count: 0,
    async transcribe() {
      t.count += 1;
      return { segments, language: 'fr', confidence: 0.9 };
    },
  };
  return t;
}

function call(over: Partial<IncomingCall> = {}): IncomingCall {
  return {
    provider: 'essai',
    callId: 'APPEL-ARRET',
    from: '06 00 00 07 07',
    startedAt: at(0),
    endedAt: at(40),
    announcedAt: at(3),
    consentAt: at(7),
    recordingRef: 'REC-ARRET',
    originCode: null,
    ...over,
  };
}

async function setup(tr: CallTranscriber | null) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = at(60);
  const now = (): Date => clock;
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const network = await store.createNetwork('Réseau test');
  const appels = new Appels(db, journal, store, fiche, tr, { now, timeoutMs: 1000, aiTimeoutMs: 1000 });
  const stops = () => db.all<{ person_id: string; reason: string; channel: string | null; noted_at: string; lifted_at: string | null }>(
    "SELECT person_id, reason, channel, noted_at, lifted_at FROM exclusions WHERE reason = 'stop' ORDER BY noted_at",
  );
  return { db, journal, store, fiche, network, appels, stops, setClock: (d: Date) => (clock = d) };
}

describeWithSqlite('RC20 · une demande d’arrêt dite au téléphone arrête tous les envois', () => {
  it('[R04] un arrêt dit par l’appelant range l’exclusion « stop » sur tous les canaux, à l’heure du passage', async () => {
    const t = await setup(transcriber(STOP_SAID));
    const r = await t.appels.receive(t.network.id, call());
    expect(r).toMatchObject({ ok: true, status: 'traite', already: false });
    if (!r.ok || !r.personId) throw new Error('refusé');
    expect(await t.stops()).toEqual([{ person_id: r.personId, reason: 'stop', channel: null, noted_at: at(21).toISOString(), lifted_at: null }]);
    // La fiche le voit comme un arrêt écrit : l'exclusion vaut pour tous les canaux.
    const view = await t.fiche.view(r.personId);
    expect(view.exclusions.filter((e) => e.reason === 'stop' && e.lifted_at === null && e.channel === null)).toHaveLength(1);
  });

  it('[R04] le même arrêt dit par l’agent, ou une phrase sans arrêt, ne range rien', async () => {
    const byAgent: CallSegment[] = [
      { speaker: 'appelant', startS: 6, endS: 8, text: 'Oui, d’accord.' },
      { speaker: 'agent', startS: 9, endS: 14, text: 'Vous ne voulez plus être appelé ? Je note : ne m’appelez plus.' },
      { speaker: 'appelant', startS: 15, endS: 20, text: 'Si, si, rappelez-moi la semaine prochaine.' },
    ];
    for (const [i, segments] of [byAgent, NO_STOP].entries()) {
      const t = await setup(transcriber(segments));
      const r = await t.appels.receive(t.network.id, call({ callId: `SANS-${i}` }));
      expect(r).toMatchObject({ ok: true, status: 'traite' });
      expect(await t.stops()).toEqual([]);
      expect(stopSegment(segments)).toBeNull();
    }
  });

  it('[R04] un arrêt coupé en plusieurs passages de l’appelant qui se suivent est lu ensemble, à l’heure de son début', async () => {
    const split: CallSegment[] = [
      { speaker: 'appelant', startS: 6, endS: 8, text: 'Oui, d’accord.' },
      { speaker: 'appelant', startS: 9, endS: 12, text: 'Ne m’appelez' },
      { speaker: 'appelant', startS: 12, endS: 14, text: 'plus,' },
      { speaker: 'appelant', startS: 14, endS: 16, text: 's’il vous plaît.' },
    ];
    expect(stopSegment(split)).toEqual({ text: 'Ne m’appelez plus,', startS: 9 });
    const t = await setup(transcriber(split));
    const r = await t.appels.receive(t.network.id, call({ callId: 'COUPE' }));
    if (!r.ok) throw new Error('refusé');
    expect((await t.stops()).map((e) => e.noted_at)).toEqual([at(9).toISOString()]);
    expect((await t.appels.get(t.network.id, r.callId))?.stop).toEqual({ quote: 'Ne m’appelez plus,', atS: 9 });
    // Les paroles de l'agent ne sont jamais collées à celles de l'appelant.
    const withAgent: CallSegment[] = [
      { speaker: 'agent', startS: 0, endS: 3, text: 'Je note : ne m’appelez' },
      { speaker: 'appelant', startS: 3, endS: 5, text: 'plus tard, oui.' },
    ];
    expect(stopSegment(withAgent)).toBeNull();
  });

  it('[R242] sans accord à l’enregistrement, rien n’est lu ni rangé', async () => {
    const tr = transcriber(STOP_SAID);
    const t = await setup(tr);
    const r = await t.appels.receive(t.network.id, call({ consentAt: null }));
    expect(r).toMatchObject({ ok: true, status: 'sans_enregistrement' });
    expect(tr.count).toBe(0);
    expect(await t.stops()).toEqual([]);
  });

  it('[R18] l’appel livré deux fois ne double pas l’exclusion ; un arrêt déjà en cours n’est pas doublé', async () => {
    const tr = transcriber(STOP_SAID);
    const t = await setup(tr);
    const first = await t.appels.receive(t.network.id, call());
    await t.appels.receive(t.network.id, call());
    expect(tr.count).toBe(1);
    expect(await t.stops()).toHaveLength(1);
    // Un second appel où l'arrêt est redit : l'arrêt en cours, plus ancien, reste le seul.
    await t.appels.receive(t.network.id, call({ callId: 'APPEL-ARRET-2', startedAt: at(100), endedAt: at(140), announcedAt: at(101), consentAt: at(102) }));
    const stops = await t.stops();
    expect(stops).toHaveLength(1);
    expect(stops[0]!.person_id).toBe(first.ok ? first.personId : null);
  });

  it('[R04] [R18] une coupure entre l’arrêt rangé et l’appel fini : la livraison suivante reprend l’appel sans doubler l’arrêt', async () => {
    const tr = transcriber(STOP_SAID);
    const t = await setup(tr);
    let fail = true;
    const run = t.db.run.bind(t.db);
    t.db.run = async (sql, params) => {
      if (fail && /^\s*UPDATE calls SET/.test(sql)) throw new Error('coupure');
      return run(sql, params);
    };
    await expect(t.appels.receive(t.network.id, call())).rejects.toThrow('coupure');
    expect(await t.stops()).toHaveLength(1);
    fail = false;
    // La réservation de l'appel est périmée : une nouvelle livraison le reprend et le finit.
    t.setClock(at(600));
    expect(await t.appels.receive(t.network.id, call())).toMatchObject({ ok: true, status: 'traite', already: false });
    expect(tr.count).toBe(2);
    expect(await t.stops()).toHaveLength(1);
  });

  it('[R04] [R13] la vue de l’appel montre le passage ; le journal ne dit que « arrêt demandé », sans texte', async () => {
    const t = await setup(transcriber(STOP_SAID));
    const r = await t.appels.receive(t.network.id, call());
    if (!r.ok) throw new Error('refusé');
    const view = await t.appels.get(t.network.id, r.callId);
    expect(view?.stop).toEqual({ quote: 'Alors ne m’appelez plus, s’il vous plaît.', atS: 21 });
    const events = (await t.journal.all()).filter((e) => e.type === 'voix.appel_recu');
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({ stop: true });
    expect(JSON.stringify(events[0])).not.toMatch(/appelez|Talant|06 00|0600/);
    // Sans arrêt dit : la vue et le journal le disent aussi.
    const t2 = await setup(transcriber(NO_STOP));
    const r2 = await t2.appels.receive(t2.network.id, call());
    if (!r2.ok) throw new Error('refusé');
    expect((await t2.appels.get(t2.network.id, r2.callId))?.stop).toBeNull();
    expect((await t2.journal.all()).find((e) => e.type === 'voix.appel_recu')!.data).toMatchObject({ stop: false });
  });
});
