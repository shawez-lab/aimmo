import { describe, expect, it } from 'vitest';
import { CoproprieteUrbanisme, PUBLIC_SOURCES, type SourceDocument } from '../src/documents/copropriete-urbanisme.ts';
import { LectureCopropriete, coproExcerptsOf, skeletonOf, verifyCoproReading, type CoproExcerpt, type CoproReader } from '../src/documents/index.ts';
import { setupDossier } from './dossiers-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Documents inventés : noms, téléphone, mail et compte sont faux.
const PV: SourceDocument = {
  kind: 'pv_assemblee',
  ref: 'dossiers/test/pv-2027-01-15.pdf',
  meetingDay: '2027-01-15',
  pages: [
    [
      "Procès-verbal de l'assemblée générale ordinaire du 15 janvier 2027.",
      'Étaient présents : M. Paul Exemple (lot 4), Mme Jeanne Essai (lot 7), joignable au 06 11 22 33 44, jeanne@exemple.test.',
      'M. Paul Exemple est débiteur de 3 200 € de charges impayées.',
    ].join('\n'),
    [
      "Résolution n° 7 : l'assemblée décide le ravalement de la façade sur rue pour un montant de 48 000 € TTC, exigible le 1er septembre 2027.",
      'Résolution n° 8 adoptée : réfection de la toiture-terrasse, budget de 12 500 €.',
      'Vote contre : Mme Jeanne Essai.',
      "Résolution n° 9 : étude du remplacement de l'ascenseur, devis à présenter à la prochaine assemblée.",
      "Aucune procédure judiciaire n'est en cours contre le syndicat.",
      'Travaux de peinture par Porte, devis de 2 000 €.',
    ].join('\n'),
  ],
};
const APPELS: SourceDocument = {
  kind: 'appels_de_fonds',
  ref: 'dossiers/test/appels.pdf',
  pages: ['Appel de fonds du budget prévisionnel : 1 750 € par trimestre.\nVirement des charges sur le compte IBAN FR76 3000 6000 0112 3456 7890 189.\nM. Paul Exemple, né le 2 février 1970, doit des charges.'],
};
const FICHE: SourceDocument = { kind: 'fiche_synthetique', ref: 'dossiers/test/fiche.pdf', pages: ['Fiche synthétique.\nMontant du fonds de travaux au 31/12/2026 : 9 400 €.'] };
const PLU: SourceDocument = { kind: 'plu_reglement', ref: 'dossiers/test/plu.pdf', pages: ['Zone UA : zone urbaine centrale.\nServitude de protection des monuments historiques sur tout le secteur.'] };
const DOCS = [PV, APPELS, FICHE, PLU];

/** Ce qu'un lecteur exact rendrait des documents ci-dessus. */
const EXACT = {
  sentences: [
    { topic: 'travaux_votes', text: 'Le ravalement de la façade sur rue est voté', document: 0, page: 2, line: 1, works: { amountEur: 48000, dueOn: '2027-09-01' } },
    { topic: 'travaux_votes', text: 'La réfection de la toiture-terrasse est votée', document: 0, page: 2, line: 2, works: { amountEur: 12500 } },
    { topic: 'travaux_a_l_etude', text: "Le remplacement de l'ascenseur est à l'étude", document: 0, page: 2, line: 4 },
    { topic: 'procedures', text: 'Aucune procédure judiciaire en cours contre le syndicat', document: 0, page: 2, line: 5 },
    { topic: 'charges', text: 'Les charges du budget prévisionnel sont de 1 750 € par trimestre', document: 1, page: 1, line: 1 },
    { topic: 'fonds_travaux', text: 'Le fonds de travaux est de 9 400 € au 31 décembre 2026', document: 2, page: 1, line: 2 },
    { topic: 'zone', text: 'Le bien est en zone urbaine UA', document: 3, page: 1, line: 1 },
    { topic: 'servitudes', text: 'Servitude de protection des monuments historiques', document: 3, page: 1, line: 2 },
  ],
};

class FakeReader implements CoproReader {
  seen: CoproExcerpt[][] = [];
  constructor(private readonly answer: (excerpts: CoproExcerpt[]) => Promise<unknown>) {}
  read(excerpts: CoproExcerpt[]): Promise<unknown> {
    this.seen.push(excerpts);
    return this.answer(excerpts);
  }
}

async function setup(reader: CoproReader | null, o: { timeoutMs?: number } = {}) {
  const t = await setupDossier('appartement');
  const lc = new LectureCopropriete(t.db, t.acces, t.journal, reader, { now: t.now, ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }) });
  const copro = new CoproprieteUrbanisme(t.db, t.acces, t.journal, { now: t.now });
  return { ...t, lc, copro };
}

describe('RC42 · ce qui part au lecteur', () => {
  it('[R15] aucun nom, aucune civilité, aucun mail ni téléphone ; une ligne à IBAN ou à naissance jamais envoyée', () => {
    const sent = JSON.stringify(coproExcerptsOf(DOCS));
    for (const leak of ['Paul', 'Exemple', 'Jeanne', 'Essai', 'Porte', 'exemple.test', '06 11', '22 33 44', 'IBAN', 'FR76', '1970', 'Mme', 'M.']) expect(sent).not.toContain(leak);
    expect(sent).not.toMatch(/\bM\b/);
    // Ce qui sert passe : la décision, son montant et son échéance.
    expect(sent).toContain("l'assemblée décide le ravalement de la façade sur rue pour un montant de 48 000 € TTC, exigible le 1er septembre 2027.");
    // La ligne de l'impayé part, le nom masqué.
    expect(sent).toContain('… est débiteur de 3 200 € de charges impayées.');
  });

  it('[R15] un mot de la liste écrit avec une capitale au milieu d’une phrase est un nom : masqué', () => {
    expect(skeletonOf('Travaux de peinture par Porte, devis de 2 000 €.')).toEqual({ text: 'Travaux de peinture par …, devis de 2 000 €.', masked: true });
    expect(skeletonOf('Remplacement de la porte du hall.')).toEqual({ text: 'Remplacement de la porte du hall.', masked: false });
    expect(skeletonOf('TRAVAUX : réfection de la toiture.').masked).toBe(false);
    expect(skeletonOf('Travaux votés : DUPONT contre.').masked).toBe(true);
    expect(skeletonOf('Zone 1AUb du plan.').masked).toBe(false);
    expect(skeletonOf('Vote de Ana.').masked).toBe(true);
    expect(skeletonOf('Vote contre : Porte.').masked).toBe(true);
    expect(skeletonOf('Résolution n° 7 : Travaux votés.').masked).toBe(true);
    expect(skeletonOf('Résolution n° 7. Travaux votés.').masked).toBe(false);
  });
});

describe('RC42 · ce que rend le lecteur', () => {
  it('[R448] chaque phrase garde la ligne entière du document pour extrait', () => {
    const r = verifyCoproReading(DOCS, EXACT);
    expect(r.dropped).toBe(0);
    expect(r.sentences).toHaveLength(8);
    expect(r.sentences[0]).toEqual({
      topic: 'travaux_votes',
      text: 'Le ravalement de la façade sur rue est voté',
      document: 0,
      page: 2,
      quote: "Résolution n° 7 : l'assemblée décide le ravalement de la façade sur rue pour un montant de 48 000 € TTC, exigible le 1er septembre 2027.",
      works: { amountEur: 48000, dueOn: '2027-09-01' },
    });
  });

  it('[R448, R15] ligne masquée, mot hors vocabulaire, ligne ou page inexistante, rubrique inconnue ou hors sujet, doublon : écartés', () => {
    const bad = [
      // La ligne porte un nom : elle ne peut pas servir d'extrait.
      { topic: 'impayes', text: 'Des charges impayées de 3 200 €', document: 0, page: 1, line: 3 },
      { topic: 'travaux_votes', text: 'Des travaux de peinture sont votés', document: 0, page: 2, line: 6 },
      { topic: 'procedures', text: 'Vote contre', document: 0, page: 2, line: 3 },
      // Un nom inventé dans la phrase.
      { topic: 'procedures', text: 'Aucune procédure judiciaire contre Mme Essai', document: 0, page: 2, line: 5 },
      { topic: 'procedures', text: 'Aucune procédure judiciaire chez Dupont', document: 0, page: 2, line: 5 },
      // Une ligne, une page, un document qui n'existent pas.
      { topic: 'procedures', text: 'Aucune procédure judiciaire', document: 0, page: 2, line: 40 },
      { topic: 'procedures', text: 'Aucune procédure judiciaire', document: 0, page: 9, line: 1 },
      { topic: 'procedures', text: 'Aucune procédure judiciaire', document: 7, page: 1, line: 1 },
      // Une rubrique inconnue, une rubrique d'urbanisme sur un procès-verbal.
      { topic: 'loyers', text: 'Aucune procédure judiciaire', document: 0, page: 2, line: 5 },
      { topic: 'servitudes', text: 'Aucune procédure judiciaire', document: 0, page: 2, line: 5 },
      // La ligne à IBAN, et une phrase sans rapport avec sa ligne.
      { topic: 'charges', text: 'Virement des charges', document: 1, page: 1, line: 2 },
      { topic: 'travaux_votes', text: 'Le remplacement des fenêtres est voté', document: 0, page: 2, line: 5 },
      'n’importe quoi',
      null,
    ];
    const r = verifyCoproReading(DOCS, { sentences: [...EXACT.sentences, EXACT.sentences[0], ...bad] });
    expect(r.sentences).toHaveLength(8);
    expect(r.dropped).toBe(bad.length + 1);
    expect(JSON.stringify(r.sentences)).not.toMatch(/Essai|Exemple|Porte|Dupont|IBAN/);
  });

  it('[R448] un montant ou une échéance qui ne se lisent pas dans la ligne sont retirés, la phrase reste', () => {
    const r = verifyCoproReading(DOCS, {
      sentences: [
        { topic: 'travaux_votes', text: 'Le ravalement de la façade sur rue est voté', document: 0, page: 2, line: 1, works: { amountEur: 84000, dueOn: '2027-09-01' } },
        { topic: 'travaux_votes', text: 'La réfection de la toiture-terrasse est votée', document: 0, page: 2, line: 2, works: { amountEur: 12500, dueOn: '2027-04-30' } },
        { topic: 'travaux_a_l_etude', text: "Le remplacement de l'ascenseur est à l'étude", document: 0, page: 2, line: 4, works: { amountEur: 'beaucoup' } },
      ],
    });
    expect(r.sentences.map((s) => s.works)).toEqual([{ dueOn: '2027-09-01' }, { amountEur: 12500 }, {}]);
    expect(r.dropped).toBe(0);
  });
});

describeWithSqlite('RC42 · prélecture des documents de la copropriété', () => {
  it('[R448, R450] les phrases proposées passent `prepare` telles quelles ; chaque rubrique sans phrase est à lire', async () => {
    const reader = new FakeReader(async () => EXACT);
    const t = await setup(reader);
    const r = await t.lc.preRead(t.agent, t.fileId, { documents: DOCS });
    if (!r.ok) throw new Error(r.code);
    expect(r.value.source).toBe('ia');
    expect(r.value.toRead).toEqual(['impayes', 'syndic', 'droit_de_preemption']);
    expect(reader.seen).toHaveLength(1);
    // Rien n'est rangé par la prélecture.
    expect(await t.db.all('SELECT id FROM coownership_summaries')).toEqual([]);
    const s = await t.copro.prepare(t.agent, t.fileId, { documents: DOCS, sentences: r.value.sentences, publicData: { urbanism: { ok: false, source: PUBLIC_SOURCES.urbanism, collectedAt: '2027-03-01T08:00:00.000Z', reason: 'panne' } } });
    if (!s.ok) throw new Error(s.code);
    expect(s.value.rejected).toEqual([]);
    expect(s.value.worksToNotify.map((w) => [w.amountEur, w.dueOn])).toEqual([
      [48000, '2027-09-01'],
      [12500, null],
    ]);
  });

  it('[R12] lecteur absent, en panne, trop lent ou illisible : aucune phrase, tout à lire, jamais une erreur', async () => {
    const all = ['travaux_votes', 'travaux_a_l_etude', 'procedures', 'impayes', 'charges', 'fonds_travaux', 'syndic'];
    const readers: (CoproReader | null)[] = [
      null,
      new FakeReader(async () => {
        throw new Error('panne');
      }),
      new FakeReader(() => new Promise(() => {})),
      new FakeReader(async () => 'du texte libre'),
      new FakeReader(async () => ({ phrases: [] })),
    ];
    for (const reader of readers) {
      const t = await setup(reader, { timeoutMs: 20 });
      const r = await t.lc.preRead(t.agent, t.fileId, { documents: [PV] });
      expect(r).toEqual({ ok: true, value: { source: 'manuel', sentences: [], toRead: all, dropped: 0 } });
    }
  });

  it('[R16] seul l’agent du dossier prélit ; direction et un autre agent refusés, le lecteur jamais appelé', async () => {
    const reader = new FakeReader(async () => EXACT);
    const t = await setup(reader);
    for (const v of [t.direction, t.sam]) expect(await t.lc.preRead(v, t.fileId, { documents: DOCS })).toMatchObject({ ok: false, rule: 'R16' });
    expect(reader.seen).toHaveLength(0);
    const refused = (await t.journal.bySubject(`sale_file:${t.fileId}`)).filter((e) => e.type === 'acces.refuse');
    expect(refused.length).toBeGreaterThanOrEqual(2);
  });

  it('[R448] documents mal formés refusés avant tout appel au lecteur', async () => {
    const reader = new FakeReader(async () => EXACT);
    const t = await setup(reader);
    for (const documents of [[], 'pv', [{ ...PV, kind: 'bail' }], [{ ...PV, meetingDay: undefined }], [{ ...PV, meetingDay: '2030-01-01' }], [{ ...FICHE, meetingDay: '2027-01-15' }], [{ ...PV, pages: [] }]]) {
      expect(await t.lc.preRead(t.agent, t.fileId, { documents })).toEqual({ ok: false, rule: null, code: 'bad_documents' });
    }
    expect(reader.seen).toHaveLength(0);
  });

  it('[R13] au journal : la source, des rubriques et des nombres, aucune phrase, ligne ni montant', async () => {
    const t = await setup(new FakeReader(async () => EXACT));
    await t.lc.preRead(t.agent, t.fileId, { documents: DOCS });
    const ev = (await t.journal.bySubject(`sale_file:${t.fileId}`)).filter((e) => e.type === 'dossier.copropriete_prelue').at(-1)!;
    expect(ev.data).toMatchObject({ rule: 'R448', source: 'ia', documents: 4, sentences: 8, dropped: 0, toRead: ['impayes', 'syndic', 'droit_de_preemption'] });
    expect(JSON.stringify(ev.data)).not.toMatch(/48 ?000|12 ?500|9 ?400|2027|ravalement|ascenseur|Essai|Exemple/);
  });
});
