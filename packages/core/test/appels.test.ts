import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { FicheUnique } from '../src/fiche/fusion.ts';
import { qualifyByRules } from '../src/qualification/regles.ts';
import { Appels, citeFields, type CallRecording, type CallSegment, type CallTranscriber, type IncomingCall } from '../src/voix/appels.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const T0 = Date.parse('2026-12-08T09:00:00.000Z');
const at = (s: number): Date => new Date(T0 + s * 1000);

/** Une conversation inventée : l'agent annonce, l'appelant accepte puis parle de son projet. */
const SEGMENTS: CallSegment[] = [
  { speaker: 'agent', startS: 0, endS: 6, text: 'Bonjour, cet appel est enregistré pour mieux vous suivre, vous êtes d’accord ?' },
  { speaker: 'appelant', startS: 6, endS: 8, text: 'Oui, d’accord.' },
  { speaker: 'appelant', startS: 9, endS: 20, text: 'Je souhaite vendre ma maison à Talant.' },
  { speaker: 'agent', startS: 21, endS: 24, text: 'Vous avez un prix en tête ? À Chenôve on voit 300 000 €.' },
  { speaker: 'appelant', startS: 25, endS: 33, text: 'Je pensais à 280 000 €, et je voudrais vendre dans 3 mois.' },
];

function fakeTranscriber(answer: (r: CallRecording) => unknown): CallTranscriber & { calls: CallRecording[] } {
  const calls: CallRecording[] = [];
  return {
    calls,
    async transcribe(r) {
      calls.push(r);
      return answer(r);
    },
  };
}
const ok = (segments: CallSegment[] = SEGMENTS) => fakeTranscriber(() => ({ segments, language: 'fr', confidence: 0.9 }));

function call(over: Partial<IncomingCall> = {}): IncomingCall {
  return {
    provider: 'essai',
    callId: 'APPEL-1',
    from: '06 00 00 03 01',
    startedAt: at(0),
    endedAt: at(40),
    announcedAt: at(3),
    consentAt: at(7),
    recordingRef: 'REC-1',
    originCode: null,
    ...over,
  };
}

async function setup(transcriber: CallTranscriber | null, options: ConstructorParameters<typeof Appels>[5] = {}) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => at(60);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const network = await store.createNetwork('Réseau test');
  const appels = new Appels(db, journal, store, fiche, transcriber, { now, ...options });
  return { db, journal, store, fiche, network, appels };
}

const count = async (db: SqlDatabase, sql: string, params: string[] = []): Promise<number> =>
  ((await db.all<{ n: number }>(sql, params))[0]?.n as number) ?? 0;

describeWithSqlite('HX21 · appels entrants résumés et rangés dans la fiche', () => {
  it('[R242] sans annonce ni accord rangés, rien n’est enregistré ni transcrit', async () => {
    const cases: Partial<IncomingCall>[] = [
      { announcedAt: null },
      { consentAt: null },
      { announcedAt: null, consentAt: null },
      // L'accord avant l'annonce, ou en dehors de l'appel, ne vaut pas.
      { announcedAt: at(8), consentAt: at(7) },
      { consentAt: at(41) },
      { announcedAt: at(-5) },
    ];
    for (const [i, over] of cases.entries()) {
      const tr = ok();
      const t = await setup(tr);
      const r = await t.appels.receive(t.network.id, call({ callId: `A${i}`, ...over }));
      expect(r).toMatchObject({ ok: true, status: 'sans_enregistrement', already: false });
      expect(tr.calls).toHaveLength(0);
      const row = (await t.db.all<Record<string, unknown>>('SELECT * FROM calls'))[0]!;
      expect(row).toMatchObject({ recording_ref: null, transcript: null, fields: null, consent_given_at: null });
      const view = await t.appels.get(t.network.id, row.id as string);
      expect(view).toMatchObject({ needsAgent: true, summary: [], transcript: [], recordingRef: null });
    }
  });

  it('[R242] la base refuse un appel traité sans accord rangé', async () => {
    const t = await setup(ok());
    const person = await t.store.createPerson({ networkId: t.network.id });
    await expect(
      t.db.run(
        `INSERT INTO calls (id, network_id, provider, call_id, status, person_id, recording_ref, transcript, fields, created_at)
         VALUES ('x', ?, 'essai', 'X', 'traite', ?, 'REC', '[]', '[]', ?)`,
        [t.network.id, person.id, at(0).toISOString()],
      ),
    ).rejects.toThrow();
  });

  it('[R242] avec l’accord, le transcripteur ne reçoit que la référence de l’enregistrement', async () => {
    const tr = ok();
    const t = await setup(tr);
    const r = await t.appels.receive(t.network.id, call());
    expect(r).toMatchObject({ ok: true, status: 'traite' });
    expect(tr.calls).toEqual([{ provider: 'essai', recordingRef: 'REC-1' }]);
  });

  it('[R243] chaque champ rempli renvoie à un passage dit par l’appelant', async () => {
    const t = await setup(ok());
    const r = await t.appels.receive(t.network.id, call());
    if (!r.ok) throw new Error('refusé');
    const view = (await t.appels.get(t.network.id, r.callId))!;
    expect(view.category).toBe('seller');
    expect(view.summary).toEqual([
      { key: 'city', value: 'Talant', quote: 'Je souhaite vendre ma maison à Talant.', atS: 9 },
      { key: 'priceEur', value: 280000, quote: 'Je pensais à 280 000 €, et je voudrais vendre dans 3 mois.', atS: 25 },
      { key: 'deadline', value: 'within_3_months', quote: 'Je pensais à 280 000 €, et je voudrais vendre dans 3 mois.', atS: 25 },
      { key: 'criterion', value: 'house', quote: 'Je souhaite vendre ma maison à Talant.', atS: 9 },
    ]);
    // Ce que l'agent a dit (Chenôve, 300 000 €) n'est jamais pris pour ce que veut l'appelant.
    expect(JSON.stringify(view.summary)).not.toMatch(/Chenôve|300000/);
    for (const line of view.summary) expect(view.transcript.some((s) => s.speaker === 'appelant' && s.text === line.quote)).toBe(true);
  });

  it('[R243] un champ qu’aucun passage ne porte à lui seul n’est pas rangé, même proposé par l’IA', async () => {
    const segments: CallSegment[] = [{ speaker: 'appelant', startS: 0, endS: 5, text: 'Je cherche une maison à Talant.' }];
    // L'IA ajoute un budget que personne n'a dit : le contrôle de Q01 le refuse, et le passage ne le porte pas.
    const qualifier = { qualify: async () => ({ category: 'buyer', route: null, city: 'Talant', budgetMinEur: null, budgetMaxEur: 250000, priceEur: null, deadline: null, financing: null, criteria: [] }) };
    const t = await setup(ok(segments), { qualifier });
    const r = await t.appels.receive(t.network.id, call());
    if (!r.ok) throw new Error('refusé');
    const view = (await t.appels.get(t.network.id, r.callId))!;
    expect(view.summary.map((s) => [s.key, s.value])).toEqual([
      ['city', 'Talant'],
      ['criterion', 'house'],
    ]);
    // Un champ que seule la réunion de deux passages donnerait n'a pas de source : il est écarté.
    const q = { ...qualifyByRules('Talant'), city: 'Dijon', priceEur: 123456 };
    expect(citeFields(q, segments, ['Talant', 'Dijon'])).toEqual([]);
  });

  it('[R243] un apport du même montant n’est jamais la source d’un budget', async () => {
    const segments: CallSegment[] = [
      { speaker: 'appelant', startS: 0, endS: 4, text: 'Mon apport est de 300 000 €.' },
      { speaker: 'appelant', startS: 5, endS: 9, text: 'Je cherche une maison avec un budget de 300 000 €.' },
    ];
    const t = await setup(ok(segments));
    const r = await t.appels.receive(t.network.id, call());
    if (!r.ok) throw new Error('refusé');
    const budget = (await t.appels.get(t.network.id, r.callId))!.summary.find((l) => l.key === 'budgetMaxEur');
    expect(budget).toEqual({ key: 'budgetMaxEur', value: 300000, quote: 'Je cherche une maison avec un budget de 300 000 €.', atS: 5 });
    // Seul, l'apport ne porte aucun budget : sans autre passage, le budget n'est pas rangé.
    expect(citeFields({ ...qualifyByRules('x'), budgetMaxEur: 300000 }, [segments[0]!], ['Talant']).some((f) => f.key === 'budgetMaxEur')).toBe(false);
  });

  it('[R243] la qualification de l’appel est celle de Q01 sur les mêmes mots écrits', async () => {
    const t = await setup(ok());
    const r = await t.appels.receive(t.network.id, call());
    if (!r.ok) throw new Error('refusé');
    const view = (await t.appels.get(t.network.id, r.callId))!;
    const written = qualifyByRules(SEGMENTS.filter((s) => s.speaker === 'appelant').map((s) => s.text).join('\n'));
    expect(view.category).toBe(written.category);
    expect(view.route).toBe(written.route);
  });

  it('[R244] l’appel est rattaché à la fiche qui porte ce numéro, sans en créer une seconde', async () => {
    const t = await setup(ok());
    const nina = await t.store.createPerson({ networkId: t.network.id, firstName: 'Nina' });
    await t.fiche.addIdentifier({ networkId: t.network.id, personId: nina.id, kind: 'whatsapp', value: '+33600000301' });
    const r = await t.appels.receive(t.network.id, call());
    expect(r).toMatchObject({ ok: true, personId: nina.id });
    expect(await count(t.db, 'SELECT count(*) AS n FROM persons')).toBe(1);
    expect((await t.appels.forPerson(t.network.id, nina.id)).map((c) => c.id)).toEqual([r.ok ? r.callId : '']);
  });

  it('[R244] un numéro inconnu crée une seule fiche, retrouvée au deuxième appel', async () => {
    const t = await setup(ok());
    const a = await t.appels.receive(t.network.id, call({ callId: 'C1' }));
    const b = await t.appels.receive(t.network.id, call({ callId: 'C2', from: '+33 6 00 00 03 01' }));
    expect(a.ok && b.ok && a.personId === b.personId).toBe(true);
    expect(await count(t.db, 'SELECT count(*) AS n FROM persons')).toBe(1);
    expect(await count(t.db, "SELECT count(*) AS n FROM person_identifiers WHERE kind = 'phone'")).toBe(1);
    const row = await t.db.all<{ attach: string }>('SELECT attach FROM calls ORDER BY call_id');
    expect(row.map((x) => x.attach)).toEqual(['created', 'matched']);
  });

  it('[R244] deux appels simultanés d’un numéro inconnu finissent sur une seule fiche gardée', async () => {
    const t = await setup(ok());
    const [a, b] = await Promise.all([t.appels.receive(t.network.id, call({ callId: 'S1' })), t.appels.receive(t.network.id, call({ callId: 'S2' }))]);
    if (!a.ok || !b.ok) throw new Error('refusé');
    expect(await t.fiche.rootOf(a.personId!)).toBe(await t.fiche.rootOf(b.personId!));
    const kept = await count(t.db, 'SELECT count(*) AS n FROM persons WHERE id NOT IN (SELECT merged_id FROM person_merges WHERE undone_at IS NULL)');
    expect(kept).toBe(1);
    expect(await t.appels.forPerson(t.network.id, a.personId!)).toHaveLength(2);
  });

  it('[R244] [R18] le même appel livré deux fois n’est rangé, transcrit et journalisé qu’une fois', async () => {
    const tr = ok();
    const t = await setup(tr);
    const [a, b] = await Promise.all([t.appels.receive(t.network.id, call()), t.appels.receive(t.network.id, call())]);
    const again = await t.appels.receive(t.network.id, call());
    expect(tr.calls).toHaveLength(1);
    expect(await count(t.db, 'SELECT count(*) AS n FROM calls')).toBe(1);
    expect(await count(t.db, 'SELECT count(*) AS n FROM persons')).toBe(1);
    expect([a, b, again].filter((r) => r.ok && r.already)).toHaveLength(2);
  });

  it('[R244] fiches réunies : l’appel se voit sur la fiche gardée ; deux fiches distinctes : la plus ancienne, à vérifier', async () => {
    const t = await setup(ok());
    const old = await t.store.createPerson({ networkId: t.network.id });
    await t.fiche.addIdentifier({ networkId: t.network.id, personId: old.id, kind: 'phone', value: '0600000301' });
    // Créée une minute plus tard : la plus ancienne est sans ambiguïté `old`.
    const twin = await new FicheClient(t.db, { now: () => at(120) }).createPerson({ networkId: t.network.id });
    await t.fiche.addIdentifier({ networkId: t.network.id, personId: twin.id, kind: 'phone', value: '0600000301' });
    const r = await t.appels.receive(t.network.id, call());
    expect(r).toMatchObject({ personId: old.id });
    const [view] = await t.appels.forPerson(t.network.id, old.id);
    expect(view).toMatchObject({ ambiguous: true });
    await t.fiche.merge({ survivorId: twin.id, mergedId: old.id, reason: 'même numéro' });
    expect((await t.appels.forPerson(t.network.id, twin.id)).map((c) => c.id)).toEqual([view!.id]);
  });

  it('[R244] un numéro masqué ne crée aucune fiche et ne garde rien de ce qui a été dit', async () => {
    const tr = ok();
    const t = await setup(tr);
    const r = await t.appels.receive(t.network.id, call({ from: null }));
    expect(r).toMatchObject({ ok: true, status: 'masque', personId: null });
    expect(tr.calls).toHaveLength(0);
    expect(await count(t.db, 'SELECT count(*) AS n FROM persons')).toBe(0);
    const row = (await t.db.all<Record<string, unknown>>('SELECT * FROM calls'))[0]!;
    expect(row).toMatchObject({ recording_ref: null, transcript: null, consent_given_at: null, person_id: null });
  });

  it('une transcription impossible passe la main à l’agent, l’enregistrement accepté reste à écouter', async () => {
    const cases: [CallTranscriber | null, string][] = [
      [null, 'indisponible'],
      [fakeTranscriber(() => Promise.reject(new Error('panne'))), 'echec'],
      [fakeTranscriber(() => ({ segments: [{ speaker: 'agent', startS: 0, endS: 2, text: 'Allô ?' }], confidence: 0.9 })), 'vide'],
      [fakeTranscriber(() => ({ segments: SEGMENTS, confidence: 0.3 })), 'incertaine'],
      [fakeTranscriber(() => ({ segments: [{ speaker: 'appelant', startS: 0, endS: 999, text: 'x' }], confidence: 0.9 })), 'echec'],
      [fakeTranscriber(() => new Promise(() => {})), 'indisponible'],
    ];
    for (const [tr, failure] of cases) {
      const t = await setup(tr, { timeoutMs: 20 });
      const r = await t.appels.receive(t.network.id, call());
      expect(r).toMatchObject({ ok: true, status: 'impossible' });
      const view = (await t.appels.get(t.network.id, r.ok ? r.callId : ''))!;
      expect(view).toMatchObject({ failure, needsAgent: true, recordingRef: 'REC-1', summary: [], category: null });
    }
  });

  it('[R245] la provenance vient du code du bouton d’appel marqué, sinon elle est inconnue', async () => {
    const t = await setup(ok());
    await t.db.run("INSERT INTO public_contents (id, network_id, kind, ref, created_at) VALUES ('abcdefgh2345', ?, 'prix', 'dijon', ?)", [t.network.id, at(0).toISOString()]);
    const marked = await t.appels.receive(t.network.id, call({ callId: 'M1', originCode: 'abcdefgh2345' }));
    const unknown = await t.appels.receive(t.network.id, call({ callId: 'M2', originCode: 'zzzzzzzzzzzz' }));
    const none = await t.appels.receive(t.network.id, call({ callId: 'M3' }));
    const other = await t.store.createNetwork('Autre réseau');
    const foreign = await t.appels.receive(other.id, call({ callId: 'M4', originCode: 'abcdefgh2345' }));
    const origin = async (r: typeof marked, net = t.network.id) => (await t.appels.get(net, r.ok ? r.callId : ''))!.origin;
    expect(await origin(marked)).toEqual({ contentId: 'abcdefgh2345', kind: 'prix' });
    expect(await origin(unknown)).toEqual({ contentId: null, kind: 'inconnue' });
    expect(await origin(none)).toEqual({ contentId: null, kind: 'inconnue' });
    expect(await origin(foreign, other.id)).toEqual({ contentId: null, kind: 'inconnue' });
  });

  it('[R13] [R15] ni texte, ni numéro, ni enregistrement au journal ; un IBAN dicté est masqué', async () => {
    const segments: CallSegment[] = [{ speaker: 'appelant', startS: 0, endS: 5, text: 'Mon IBAN est FR76 3000 6000 0112 3456 7890 189, je vends à Talant.' }];
    const t = await setup(ok(segments));
    const r = await t.appels.receive(t.network.id, call());
    const journal = JSON.stringify(await t.journal.all());
    expect(journal).not.toMatch(/0600000301|600000301|REC-1|Talant|IBAN/);
    const stored = (await t.db.all<{ transcript: string }>('SELECT transcript FROM calls'))[0]!.transcript;
    expect(stored).not.toMatch(/3000 6000 0112/);
    expect(r.ok).toBe(true);
  });

  it('[R15] l’IA ne reçoit ni le nom que l’appelant se donne, ni celui de sa fiche, ni son numéro', async () => {
    const segments: CallSegment[] = [
      { speaker: 'appelant', startS: 0, endS: 4, text: 'Bonjour, je m’appelle Nina Exemple, mon numéro est le 06 00 00 03 01.' },
      { speaker: 'appelant', startS: 5, endS: 9, text: 'Je cherche une maison à Talant.' },
    ];
    const seen: string[] = [];
    const qualifier = { qualify: async (b: { text: string }) => (seen.push(b.text), { category: 'buyer', route: null, city: 'Talant', budgetMinEur: null, budgetMaxEur: null, priceEur: null, deadline: null, financing: null, criteria: [] }) };
    const t = await setup(ok(segments), { qualifier });
    const known = await t.store.createPerson({ networkId: t.network.id, firstName: 'Zoé', lastName: 'Fictive' });
    await t.fiche.addIdentifier({ networkId: t.network.id, personId: known.id, kind: 'phone', value: '0600000301' });
    await t.appels.receive(t.network.id, call({ callId: 'N1' }));
    await t.appels.receive(t.network.id, call({ callId: 'N2' }));
    expect(seen).toHaveLength(2);
    for (const text of seen) expect(text).not.toMatch(/Nina|Exemple|Zoé|Fictive|06 00|0600/);
    expect(seen[0]).toMatch(/Talant/);
  });

  it('[R244] un journal en panne après le rangement : la livraison suivante ajoute l’événement, une seule fois, sans retranscrire', async () => {
    const tr = ok();
    const t = await setup(tr);
    let fail = true;
    const journal = {
      ...t.journal,
      append: async (e: Parameters<typeof t.journal.append>[0]) => {
        if (fail) throw new Error('journal en panne');
        return t.journal.append(e);
      },
      last: () => t.journal.last(),
      all: () => t.journal.all(),
      bySubject: (s: string) => t.journal.bySubject(s),
      byPeriod: (a: string, b: string) => t.journal.byPeriod(a, b),
    };
    const appels = new Appels(t.db, journal, t.store, t.fiche, tr, { now: () => at(60) });
    await expect(appels.receive(t.network.id, call())).rejects.toThrow();
    fail = false;
    expect(await appels.receive(t.network.id, call())).toMatchObject({ ok: true, already: true, status: 'traite' });
    await appels.receive(t.network.id, call());
    expect(tr.calls).toHaveLength(1);
    expect((await t.journal.all()).filter((e) => e.type === 'voix.appel_recu')).toHaveLength(1);
    // Deux relivraisons simultanées après une panne du journal n'ajoutent qu'un événement.
    fail = true;
    await expect(appels.receive(t.network.id, call({ callId: 'P2' }))).rejects.toThrow();
    fail = false;
    await Promise.all([appels.receive(t.network.id, call({ callId: 'P2' })), appels.receive(t.network.id, call({ callId: 'P2' }))]);
    await appels.receive(t.network.id, call({ callId: 'P2' }));
    expect(tr.calls).toHaveLength(2);
    expect((await t.journal.all()).filter((e) => e.type === 'voix.appel_recu')).toHaveLength(2);
  });

  it('un appel mal formé est refusé sans rien ranger', async () => {
    const t = await setup(ok());
    for (const bad of [null, {}, call({ provider: 'Essai !' }), call({ callId: '' }), call({ endedAt: at(-1) }), call({ endedAt: at(5 * 3600) })]) {
      expect(await t.appels.receive(t.network.id, bad)).toEqual({ ok: false, code: 'bad_call' });
    }
    expect(await count(t.db, 'SELECT count(*) AS n FROM calls')).toBe(0);
  });
});
