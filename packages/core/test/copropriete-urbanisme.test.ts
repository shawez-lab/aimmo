import { expect, it } from 'vitest';
import { CoproprieteUrbanisme, PUBLIC_SOURCES, TOPICS, normalize, renderSummary, type ProposedSentence, type PublicData, type SourceDocument } from '../src/documents/copropriete-urbanisme.ts';
import { setupDossier } from './dossiers-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Documents inventés : un procès-verbal d'assemblée de trois pages, une fiche synthétique, un règlement d'urbanisme.
const PV: SourceDocument = {
  kind: 'pv_assemblee',
  ref: 'dossiers/test/pv-2027-01-15.pdf',
  meetingDay: '2027-01-15',
  pages: [
    "Procès-verbal de l'assemblée générale ordinaire de la résidence Les Tilleuls de l'Exemple.\nQuorum atteint : 6 120 / 10 000 tantièmes.",
    "Résolution n° 7 : l'assemblée décide le ravalement de la façade sur rue pour un montant de 48 000,00 € TTC.\nAppel de fonds exigible le 1er septembre 2027. Adoptée à la majorité de l'article 25.\nRésolution n° 8 : réfection de la toiture-ter-\nrasse, budget de 12 500 €, travaux à réaliser avant le 30/04/2027.",
    "Résolution n° 9 : étude d'un remplacement de l'ascenseur, devis à présenter à la prochaine assemblée.\nAucune procédure judiciaire n'est en cours contre le syndicat.",
  ],
};
const FICHE: SourceDocument = { kind: 'fiche_synthetique', ref: 'dossiers/test/fiche.pdf', pages: ['Fiche synthétique. Montant du fonds de travaux au 31/12/2026 : 9 400 €. Charges courantes du budget prévisionnel : 21 000 € par an.'] };
const PLU: SourceDocument = { kind: 'plu_reglement', ref: 'dossiers/test/plu-ua.pdf', pages: ['Zone UA', "Article UA 2 : les constructions nouvelles respectent l'alignement sur rue. Servitude de protection des monuments historiques sur tout le secteur."] };

const S = (o: Partial<ProposedSentence> & Pick<ProposedSentence, 'topic' | 'text' | 'document' | 'page' | 'quote'>): ProposedSentence => o;

function sentences(): ProposedSentence[] {
  return [
    S({ topic: 'travaux_votes', text: 'Le ravalement de la façade sur rue est voté', document: 0, page: 2, quote: 'ravalement de la façade sur rue pour un montant de 48 000,00 € TTC. Appel de fonds exigible le 1er septembre 2027', works: { amountEur: 48000, dueOn: '2027-09-01' } }),
    S({ topic: 'travaux_votes', text: 'La réfection de la toiture-terrasse est votée', document: 0, page: 2, quote: 'réfection de la toiture-terrasse, budget de 12 500 €, travaux à réaliser avant le 30/04/2027', works: { amountEur: 12500, dueOn: '2027-04-30' } }),
    S({ topic: 'travaux_a_l_etude', text: "Le remplacement de l'ascenseur est à l'étude", document: 0, page: 3, quote: "étude d'un remplacement de l'ascenseur" }),
    S({ topic: 'procedures', text: 'Aucune procédure judiciaire en cours contre le syndicat', document: 0, page: 3, quote: "Aucune procédure judiciaire n’est en cours contre le syndicat" }),
    S({ topic: 'fonds_travaux', text: 'Le fonds de travaux est de 9 400 € au 31 décembre 2026', document: 1, page: 1, quote: 'Montant du fonds de travaux au 31/12/2026 : 9 400 €' }),
    S({ topic: 'zone', text: 'Le bien est en zone UA', document: 2, page: 1, quote: 'Zone UA' + ' ' }), // trop court : écarté
    S({ topic: 'servitudes', text: 'Le secteur est protégé au titre des monuments historiques', document: 2, page: 2, quote: 'Servitude de protection des monuments historiques' }),
  ];
}

function publicData(o: { registryAt?: string; registryDate?: string; urbanismSource?: string; registryDown?: boolean } = {}): PublicData {
  return {
    registry: o.registryDown
      ? { ok: false, source: PUBLIC_SOURCES.registry, collectedAt: '2027-03-01T08:00:00.000Z', reason: 'panne' }
      : { ok: true, source: PUBLIC_SOURCES.registry, collectedAt: o.registryAt ?? '2027-03-01T08:00:00.000Z', dataDate: o.registryDate ?? '2026-11-30', value: { immatriculation: 'AA0000000', lots: 24, syndicType: 'professionnel', syndicName: 'Syndic Exemple SAS', constructionPeriod: '1949 à 1960' } },
    urbanism: { ok: true, source: o.urbanismSource ?? PUBLIC_SOURCES.urbanism, collectedAt: '2027-02-27T23:30:00.000Z', dataDate: '2019-12-16', value: { documentType: 'PLUi', zone: 'UA', label: 'Zone urbaine centrale' } },
  };
}

async function setup() {
  const t = await setupDossier('appartement');
  const copro = new CoproprieteUrbanisme(t.db, t.acces, t.journal, { now: t.now });
  return { ...t, copro };
}

describeWithSqlite('HX35 · copropriété et urbanisme résumés', () => {
  it('[R448] aucune phrase du résumé sans sa page : l’extrait doit se lire sur la page citée, sinon la phrase est écartée', async () => {
    const t = await setup();
    const bad: ProposedSentence[] = [
      S({ topic: 'charges', text: 'Les charges sont de 21 000 € par an', document: 1, page: 1, quote: 'Charges courantes du budget prévisionnel : 21 000 € par an' }),
      // Une phrase inventée : son extrait n'est pas sur la page citée.
      S({ topic: 'impayes', text: 'Des impayés importants sont signalés', document: 0, page: 1, quote: 'impayés importants de charges' }),
      // Le bon extrait, sur la mauvaise page.
      S({ topic: 'procedures', text: 'Aucune procédure', document: 0, page: 2, quote: "Aucune procédure judiciaire n'est en cours" }),
      S({ topic: 'syndic', text: 'Page hors du document', document: 1, page: 2, quote: 'Fiche synthétique. Montant' }),
      S({ topic: 'syndic', text: 'Document inconnu', document: 9, page: 1, quote: 'Fiche synthétique. Montant' }),
      S({ topic: 'charges', text: 'Les charges sont élevées. Le syndic est cher', document: 1, page: 1, quote: 'Charges courantes du budget prévisionnel' }),
      // Un montant ou une échéance qui ne se lisent pas dans l'extrait.
      S({ topic: 'travaux_votes', text: 'Ravalement voté', document: 0, page: 2, quote: 'ravalement de la façade sur rue pour un montant de 48 000,00 €', works: { amountEur: 84000 } }),
      S({ topic: 'travaux_votes', text: 'Ravalement voté', document: 0, page: 2, quote: 'ravalement de la façade sur rue pour un montant de 48 000,00 €', works: { dueOn: '2027-09-01' } }),
      // Un sujet d'urbanisme cité dans un document de copropriété.
      S({ topic: 'servitudes', text: 'Servitude', document: 0, page: 1, quote: 'résidence Les Tilleuls' }),
    ];
    const r = await t.copro.prepare(t.agent, t.fileId, { documents: [PV, FICHE, PLU], sentences: [...sentences(), ...bad], publicData: publicData() });
    if (!r.ok) throw new Error(r.code);
    expect(r.value.rejected).toEqual([
      { index: 5, reason: 'extrait_trop_court' },
      { index: 8, reason: 'extrait_absent_de_la_page' },
      { index: 9, reason: 'extrait_absent_de_la_page' },
      { index: 10, reason: 'page_inexistante' },
      { index: 11, reason: 'document_inconnu' },
      { index: 12, reason: 'plusieurs_phrases' },
      { index: 13, reason: 'montant_absent_de_l_extrait' },
      { index: 14, reason: 'echeance_absente_de_l_extrait' },
      { index: 15, reason: 'document_hors_sujet' },
    ]);
    // Chaque phrase gardée renvoie à son document et à une page où son extrait se lit.
    const docs = [PV, FICHE, PLU];
    const kept = r.value.topics.flatMap((l) => (l.found ? l.sentences : []));
    expect(kept).toHaveLength(7);
    for (const s of kept) {
      const doc = docs.find((d) => d.ref === s.cite.documentRef)!;
      expect(s.cite.page).toBeGreaterThanOrEqual(1);
      expect(normalize(doc.pages[s.cite.page - 1]!)).toContain(normalize(s.cite.quote));
    }
    // Apostrophe courbe, coupure de mot en fin de ligne et séparateur de milliers sont lus comme le document.
    expect(kept.find((s) => s.topic === 'procedures')?.cite.page).toBe(3);
    expect(kept.find((s) => s.text.includes('toiture'))?.works).toEqual({ amountEur: 12500, dueOn: '2027-04-30' });
    // Le rendu : chaque phrase finit par son document et sa page, ou dit « non trouvé ».
    const lines = renderSummary(r.value);
    for (const l of lines) expect(l).toMatch(/\(.+, p\. \d+\)\.$|: non trouvé|\(.+, donnée du \d{2}\/\d{2}\/\d{4}, lue le \d{2}\/\d{2}\/\d{4}\)\.$/);
    expect(lines).toContain('Le ravalement de la façade sur rue est voté (procès-verbal du 15/01/2027, p. 2).');
    // Le journal ne porte ni phrase, ni extrait, ni montant, ni zone.
    const events = JSON.stringify(await t.db.all("SELECT data FROM journal WHERE type LIKE 'dossier.copropriete%'"));
    for (const s of ['ravalement', 'Tilleuls', '48000', 'UA', 'Syndic Exemple', 'AA0000000']) expect(events).not.toContain(s);
  });

  it('[R449] les données publiques citent leur source, le jour de leur collecte et la date de la donnée ; une autre source ou une date future est refusée', async () => {
    const t = await setup();
    const r = await t.copro.prepare(t.agent, t.fileId, { documents: [PV, PLU], sentences: [], publicData: publicData() });
    if (!r.ok) throw new Error(r.code);
    expect(r.value.registry).toEqual({ found: true, source: PUBLIC_SOURCES.registry, collectedOn: '2027-03-01', dataDate: '2026-11-30', value: { immatriculation: 'AA0000000', lots: 24, syndicType: 'professionnel', syndicName: 'Syndic Exemple SAS', constructionPeriod: '1949 à 1960' } });
    // 23 h 30 en temps universel le 27 février : le 28 à Paris.
    expect(r.value.urbanism).toEqual({ found: true, source: PUBLIC_SOURCES.urbanism, collectedOn: '2027-02-28', dataDate: '2019-12-16', value: { documentType: 'PLUi', zone: 'UA', label: 'Zone urbaine centrale' } });
    expect(renderSummary(r.value)).toContain("Plan d'urbanisme : PLUi, zone UA (Zone urbaine centrale) (Géoportail de l'urbanisme (IGN), donnée du 16/12/2019, lue le 28/02/2027).");
    // Un syndic bénévole peut être une personne : son nom n'est pas repris.
    const pd = publicData();
    const benevole = { ...pd, registry: { ...pd.registry, value: { immatriculation: 'AA0000001', lots: 6, syndicType: 'benevole', syndicName: 'Camille Exemple', constructionPeriod: null } } } as PublicData;
    const b = await t.copro.prepare(t.agent, t.fileId, { documents: [PV], sentences: [], publicData: benevole });
    if (!b.ok) throw new Error(b.code);
    expect(b.value.registry).toMatchObject({ found: true, value: { syndicType: 'benevole', syndicName: null } });
    expect(JSON.stringify(b.value)).not.toContain('Camille');
    // Une autre source, une collecte dans le futur, une donnée datée après sa collecte : refusées.
    expect(await t.copro.prepare(t.agent, t.fileId, { documents: [PV], sentences: [], publicData: publicData({ urbanismSource: 'Un site quelconque' }) })).toEqual({ ok: false, rule: null, code: 'bad_public_data' });
    expect(await t.copro.prepare(t.agent, t.fileId, { documents: [PV], sentences: [], publicData: publicData({ registryAt: '2027-03-05T08:00:00.000Z' }) })).toEqual({ ok: false, rule: null, code: 'bad_public_data' });
    expect(await t.copro.prepare(t.agent, t.fileId, { documents: [PV], sentences: [], publicData: publicData({ registryDate: '2027-03-02' }) })).toEqual({ ok: false, rule: null, code: 'bad_public_data' });
    // Un procès-verbal sans jour d'assemblée n'est pas recevable.
    expect(await t.copro.prepare(t.agent, t.fileId, { documents: [{ kind: PV.kind, ref: PV.ref, pages: PV.pages }], sentences: [] })).toEqual({ ok: false, rule: null, code: 'bad_documents' });
  });

  it('[R450] le résumé dit « non trouvé » plutôt que d’inventer : rubrique sans phrase vérifiée, document absent, source en panne', async () => {
    const t = await setup();
    const r = await t.copro.prepare(t.agent, t.fileId, { documents: [PV], sentences: [sentences()[0]!, S({ topic: 'impayes', text: 'Des impayés sont signalés', document: 0, page: 1, quote: 'impayés de charges des copropriétaires' })], publicData: { registry: publicData({ registryDown: true }).registry! } });
    if (!r.ok) throw new Error(r.code);
    expect(r.value.topics.map((l) => l.topic)).toEqual([...TOPICS]);
    expect(r.value.topics.find((l) => l.topic === 'impayes')).toEqual({ topic: 'impayes', found: false, text: 'non trouvé', reason: 'absent_des_documents' });
    // Pas de règlement d'urbanisme au dossier : la zone n'est pas devinée.
    expect(r.value.topics.find((l) => l.topic === 'zone')).toEqual({ topic: 'zone', found: false, text: 'non trouvé', reason: 'aucun_document' });
    expect(r.value.registry).toEqual({ found: false, text: 'non trouvé', source: PUBLIC_SOURCES.registry, collectedOn: '2027-03-01', reason: 'panne' });
    expect(r.value.urbanism).toEqual({ found: false, text: 'non trouvé', source: PUBLIC_SOURCES.urbanism, collectedOn: null, reason: 'non_collecte' });
    const lines = renderSummary(r.value);
    expect(lines).toContain('impayes : non trouvé');
    expect(lines).toContain('Registre des copropriétés : non trouvé (Registre national des copropriétés (ANAH)).');
    expect(lines.join('\n')).not.toMatch(/impayés sont signalés/);
  });

  it('[R451] jamais vu : les travaux votés à venir sont signalés à l’acquéreur avec l’assemblée, la page, le montant et l’échéance lus au procès-verbal', async () => {
    const t = await setup();
    const extra = S({ topic: 'travaux_votes', text: 'Le changement des boîtes aux lettres est voté', document: 0, page: 3, quote: "Aucune procédure judiciaire n'est en cours" }); // extrait réel mais sans échéance
    const r = await t.copro.prepare(t.agent, t.fileId, { documents: [PV, FICHE, PLU], sentences: [...sentences(), extra], publicData: publicData() });
    if (!r.ok) throw new Error(r.code);
    // Au 1er mars 2027 : les trois travaux votés sont à venir, celui sans échéance lisible compris.
    expect(r.value.worksToNotify.map((w) => [w.votedOn, w.amountEur, w.dueOn, w.dueStatus, w.cite.page])).toEqual([
      ['2027-01-15', 48000, '2027-09-01', 'a_venir', 2],
      ['2027-01-15', 12500, '2027-04-30', 'a_venir', 2],
      ['2027-01-15', null, null, 'echeance_non_trouvee', 3],
    ]);
    // Les travaux à l'étude ne sont pas des travaux votés.
    expect(r.value.worksToNotify.some((w) => w.text.includes('ascenseur'))).toBe(false);
    // Lu le 15 mai 2027 : la toiture, échue le 30 avril, n'est plus à venir.
    t.setClock(new Date('2027-05-15T08:00:00.000Z'));
    const n = await t.copro.buyerNotice(t.agent, t.fileId);
    if (!n.ok) throw new Error(n.code);
    expect(n.value.lines).toEqual([
      'Travaux votés en assemblée du 15/01/2027 : Le ravalement de la façade sur rue est voté, 48 000 €, échéance le 01/09/2027 (procès-verbal, p. 2).',
      'Travaux votés en assemblée du 15/01/2027 : Le changement des boîtes aux lettres est voté, échéance non trouvée (procès-verbal, p. 3).',
    ]);
    const rows = await t.db.all<{ data: string }>("SELECT data FROM journal WHERE type = 'dossier.travaux_votes_signales'");
    expect(rows.map((x) => Object.keys(JSON.parse(x.data)).sort())).toEqual([['summary', 'works']]);
    expect(JSON.parse(rows[0]!.data).works).toBe(2);
  });

  it('[R452] chaque résumé est une nouvelle version ; rien ne s’efface ni ne se réécrit ; seul l’agent du bien prépare', async () => {
    const t = await setup();
    const a = await t.copro.prepare(t.agent, t.fileId, { documents: [PV], sentences: [], publicData: publicData() });
    const b = await t.copro.prepare(t.agent, t.fileId, { documents: [PV, FICHE], sentences: sentences().slice(4, 5), publicData: publicData() });
    if (!a.ok || !b.ok) throw new Error('prepare');
    expect([a.value.version, b.value.version]).toEqual([1, 2]);
    expect(b.value.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(b.value.documents[1]).toMatchObject({ ref: FICHE.ref, kind: 'fiche_synthetique', pages: 1 });
    const latest = await t.copro.latest(t.agent, t.fileId);
    expect(latest.ok && latest.value.id).toBe(b.value.id);
    // Le texte des pages n'est pas gardé : seuls l'empreinte, le nombre de pages et les extraits cités.
    const stored = JSON.stringify(await t.db.all('SELECT content FROM coownership_summaries'));
    expect(stored).not.toContain('Quorum atteint');
    await expect(t.db.run('DELETE FROM coownership_summaries WHERE id = ?', [a.value.id])).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run("UPDATE coownership_summaries SET content = '{}' WHERE id = ?", [a.value.id])).rejects.toThrow(/rien ne se réécrit/);
    // Un autre agent ne prépare pas le résumé du dossier.
    const other = { ...t.agent, userId: 'autre-agent' };
    const refused = await t.copro.prepare(other, t.fileId, { documents: [PV], sentences: [] });
    expect(refused.ok).toBe(false);
  });
});
