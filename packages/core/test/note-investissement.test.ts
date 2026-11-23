import { expect, it } from 'vitest';
import { Acces, FicheClient, SqlJournalStore, applyMigrations, createCaptation, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import {
  ANIL_CITATION,
  CalculInvestissement,
  Contraintes,
  FEW_OBSERVATIONS,
  LoyersMarche,
  HistoriqueProjet,
  NotesInvestissement,
  PROJECT_HISTORY_LIMIT,
  PROFESSIONAL_REFERRAL,
  ProfilInvestisseur,
  forbiddenPhrases,
  financingClaims,
  traceParagraph,
  type NoteFacts,
  type NoteWriter,
  computeYield,
  fallbackParagraphs,
  type YieldInputs,
} from '../src/investir/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const AT = '2027-09-14T08:00:00.000Z';
const src = (value: number, hypothesis = 'saisi par l’agent') => ({ value, source: 'x', asOf: '2027-09-01', hypothesis });

it('[R125] les promesses et les conseils fiscaux ou financiers personnalisés sont reconnus, accents et casse compris', () => {
  expect(forbiddenPhrases('Un rendement GARANTI, sans risque.')).toEqual(['garanti', 'sans risque']);
  expect(forbiddenPhrases('Idéal pour défiscaliser en LMNP.')).toEqual(['defiscaliser', 'lmnp']);
  expect(forbiddenPhrases('Vous devriez acheter vite, je vous conseille ce bien.')).toEqual(['vous devriez', 'je vous conseille']);
  expect(forbiddenPhrases('Une réduction d’impôt possible.')).toEqual(['reduction d impot']);
  expect(forbiddenPhrases('Texte proposé par une IA.')).toEqual(['ia']);
  expect(forbiddenPhrases('Le bien coûte 171 250 € au total.')).toEqual([]);
});

async function setup(options: { writer?: NoteWriter; energyClass?: string; rentalTarget?: 'none' | 'furnished' | null; csv?: string; financing?: boolean; worksHypothesis?: string } = {}) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = Date.parse(AT);
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const { chaine, store, fiche, attribution } = createCaptation(db, journal, { now, withQualification: true });
  const acces = new Acces(db, store, fiche, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  await attribution.addZone(network.id, alex.id, 'Talant');
  await chaine.receive(network.id, 'site_form', { submissionId: 'f-1', firstName: 'Inès', email: 'ines@example.test', message: 'Je souhaite investir dans un appartement à Talant.' });
  const project = (await db.first<{ id: string; person_id: string }>("SELECT id, person_id FROM projects WHERE kind = 'invest'"))!;
  await db.run('UPDATE persons SET agent_id = ? WHERE id = ?', [alex.id, project.person_id]);
  await db.run(
    "INSERT INTO properties (id, network_id, agent_id, reference, kind, status, price_eur, surface_m2, created_at, updated_at) VALUES ('p-1', ?, ?, 'REF-1', 'home', 'available', 150000, 45, ?, ?)",
    [network.id, alex.id, AT, AT],
  );
  if (options.energyClass) {
    await db.run("INSERT INTO property_sheets (id, property_id, network_id, version, data, created_by, created_at) VALUES ('s-1', 'p-1', ?, 1, ?, 'agent:a', ?)", [
      network.id,
      JSON.stringify({ energy: { energyClass: options.energyClass }, coownership: { isCoownership: false } }),
      AT,
    ]);
  }
  const as = (role: 'agent' | 'direction' | 'compliance', userId: string) => ({ role, userId, networkId: network.id });
  const profils = new ProfilInvestisseur(db, journal, { now });
  if (options.rentalTarget !== null) await profils.update(acces, as('agent', alex.id), project.id, { rentalTarget: options.rentalTarget ?? 'furnished' });
  const loyers = new LoyersMarche(db, journal, { now });
  await loyers.importAnil(as('direction', 'dir-1'), { kind: 'apartment', vintage: 2026, csv: options.csv ?? 'INSEE_C;loypredm2;lwr.IPm2;upr.IPm2;nbobs_com\n99001;12,35;10,10;15,01;120' });
  const calculs = new CalculInvestissement(db, journal, { now, loyers });
  const contraintes = new Contraintes(db, journal, { now });
  const notes = new NotesInvestissement(db, journal, calculs, contraintes, profils, { now, writerTimeoutMs: 50, ...(options.writer ? { writer: options.writer } : {}) });
  const calc = await calculs.compute(acces, as('agent', alex.id), {
    propertyId: 'p-1',
    projectId: project.id,
    marketRentQuery: { inseeCode: '99001', kind: 'apartment' },
    inputs: {
      acquisitionFeesRateBp: src(750, 'barème de l’ancien'),
      works: src(1_000_000, options.worksHypothesis ?? 'devis estimé'),
      nonRecoverableCharges: src(60_000, 'déclarées par le vendeur'), recoverableCharges: src(0),
      propertyTax: src(90_000, 'avis déclaré'),
      vacancyMonths: src(1, 'vacance réglée'),
      ...(options.financing ? { financing: src({ loanCents: 15_000_000, annualRateBp: 360, months: 300, insuranceMonthlyCents: 2_500 } as never, 'offre de prêt déclarée') } : {}),
    },
  });
  if (!calc.ok) throw new Error(calc.code);
  return { db, journal, acces, notes, calculs, contraintes, profils, network, alex, sam, project, as, calcId: calc.value.id };
}

/** Une IA de test qui rend le texte donné. */
const writerOf = (paragraphs: string[] | (() => Promise<never>)): NoteWriter => ({
  write: async (_facts: NoteFacts) => (typeof paragraphs === 'function' ? paragraphs() : { paragraphs }),
});

describeWithSqlite('Y05 · note d’investissement', () => {
  it('Jamais vu : chaque nombre de la note est relié à sa ligne du calcul, avec la preuve sous le paragraphe, et la fourchette est montrée', async () => {
    const t = await setup({ writer: writerOf(['Pour 171 250 € au total, ce bien de 45 m² se loue 555,75 € par mois au loyer de marché.']) });
    const r = await t.notes.draft(t.acces, t.as('agent', t.alex.id), { calculationId: t.calcId, projectId: t.project.id });
    if (!r.ok) throw new Error(r.code);
    expect(r.value.origin).toBe('ia');
    const p = r.value.note.paragraphs[0]!;
    expect(p.proofs.map((x) => [x.text, x.line, x.source])).toEqual([
      ['171 250', 'totalCost', 'calcul'],
      ['45', 'livingArea', 'bien:p-1'],
      ['555,75', 'monthlyRent', 'calcul'],
    ]);
    expect(r.value.text).toContain('  · 45 : Surface habitable, source bien:p-1, au 14/09/2027 (surface du bien)');
    // Le calcul fait à la main pour ce bien : 3,89 % brut (3,18 % à 4,73 %), 2,69 % net (2,04 % à 3,46 %).
    expect(r.value.text).toContain('Rendement brut : 3,89 % (de 3,18 % à 4,73 % selon le loyer de marché bas ou haut).');
    expect(r.value.text).toContain('Rendement net avant impôt : 2,69 % (de 2,04 % à 3,46 %).');
    expect(r.value.text).toContain('Sources et hypothèses :');
    expect(r.value.text).toContain(`Source : ${ANIL_CITATION}, millésime 2026`);
    expect(r.value.text).toContain(`${ANIL_CITATION}.`);
    expect(r.value.text).toContain(PROFESSIONAL_REFERRAL);
    expect(r.value.text).toMatch(/expert-comptable/);
    expect(r.value.text).toMatch(/courtier/);
    expect(r.value.status).toBe('a_valider');
  });

  it('[R126] [R125] un nombre absent du calcul, une promesse ou un conseil personnalisé : refusé, le secours prend le relais', async () => {
    for (const bad of [
      'Ce bien rapporte 7,77 % par an.',
      'Ce bien de 45 m² coûte 171 250 au total.',
      'Un rendement garanti de 3,89 % brut.',
      'Vous devriez acheter ce bien de 45 m².',
      'Idéal pour défiscaliser en Pinel.',
      // Un vrai chiffre du calcul, attribué à la mauvaise ligne : 3,89 % est le brut, 10 000 € les travaux.
      'Le rendement net avant impôt est de 3,89 %.',
      'Il rapporte 10 000 € de loyer annuel.',
      'Ce bien rapporte 3,89 % par an.',
    ]) {
      const t = await setup({ writer: writerOf([bad]) });
      const r = await t.notes.draft(t.acces, t.as('agent', t.alex.id), { calculationId: t.calcId, projectId: t.project.id });
      if (!r.ok) throw new Error(r.code);
      expect(r.value.origin, bad).toBe('secours');
      expect(r.value.text, bad).not.toContain(bad);
      expect(forbiddenPhrases(r.value.text), bad).toEqual([]);
      const events = (await t.journal.all()).filter((e) => e.type === 'investir.note.secours');
      expect(events, bad).toHaveLength(1);
      expect(JSON.stringify(events[0]!.data)).not.toContain(bad);
    }
    // Une IA en panne ou trop lente : le secours aussi.
    const down = await setup({ writer: writerOf(() => Promise.reject(new Error('panne'))) });
    const r = await down.notes.draft(down.acces, down.as('agent', down.alex.id), { calculationId: down.calcId, projectId: down.project.id });
    expect(r.ok && r.value.origin).toBe('secours');
    const slow = await setup({ writer: { write: () => new Promise((resolve) => setTimeout(() => resolve({ paragraphs: ['Texte.'] }), 500)) } });
    const s = await slow.notes.draft(slow.acces, slow.as('agent', slow.alex.id), { calculationId: slow.calcId, projectId: slow.project.id });
    expect(s.ok && s.value.origin).toBe('secours');
    // Dix bases montées l'une après l'autre : plus de 5 s sur une machine chargée.
  }, 30_000);

  it('la note de secours ne porte que des nombres du calcul, chacun avec sa preuve', async () => {
    const t = await setup();
    const r = await t.notes.draft(t.acces, t.as('agent', t.alex.id), { calculationId: t.calcId, projectId: t.project.id });
    if (!r.ok) throw new Error(r.code);
    expect(r.value.origin).toBe('secours');
    const calc = await t.calculs.get(t.network.id, t.calcId);
    if (calc?.result.status !== 'complet') throw new Error('incomplet');
    for (const p of [...r.value.note.paragraphs, ...r.value.note.figures]) {
      expect(traceParagraph(p.text, calc.result.lines).problems, p.text).toEqual([]);
      expect(p.proofs.length, p.text).toBeGreaterThan(0);
    }
    expect(r.value.note.paragraphs[0]!.text).toBe('Le bien coûte 171 250 € au total. Le prix est de 150 000 €, les frais d’acquisition de 11 250 € et les travaux estimés de 10 000 €.');
  });

  it('changer une hypothèse recalcule la note entière ; le calcul nouveau est rangé et rejouable', async () => {
    const t = await setup();
    const low = await t.notes.draft(t.acces, t.as('agent', t.alex.id), { calculationId: t.calcId, projectId: t.project.id, hypotheses: { rent: 'low', vacancyMonths: 2 } });
    if (!low.ok) throw new Error(low.code);
    // À la main : loyer 10,10 €/m² × 45 m² = 454,50 € par mois ; brut 454,50 × 12 / 171 250 = 3,18 % ;
    // net (454,50 × 10 − 600 − 900) / 171 250 = 3 045 / 171 250 = 1,78 %.
    expect(low.value.text).toContain('Rendement brut : 3,18 %');
    expect(low.value.text).toContain('Rendement net avant impôt : 1,78 %');
    expect(low.value.text).toContain('454,50 € par mois');
    expect(low.value.text).toContain('borne basse de l’intervalle retenue pour la note');
    expect(low.value.calculationId).not.toBe(t.calcId);
    expect(await t.calculs.replay(t.network.id, low.value.calculationId)).toMatchObject({ same: true });
    expect(await t.notes.draft(t.acces, t.as('agent', t.alex.id), { calculationId: t.calcId, projectId: t.project.id, hypotheses: { vacancyMonths: 13 } })).toMatchObject({
      ok: false,
      code: 'hypothese',
    });
  });

  it('[R122] la note dit « peu d’observations » quand le loyer de marché en a peu', async () => {
    const t = await setup({ csv: 'INSEE_C;loypredm2;lwr.IPm2;upr.IPm2;nbobs_com\n99001;12,35;10,10;15,01;12' });
    const r = await t.notes.draft(t.acces, t.as('agent', t.alex.id), { calculationId: t.calcId, projectId: t.project.id });
    expect(r.ok && r.value.text).toContain(FEW_OBSERVATIONS);
  });

  it('[R124] la note d’un bien classé G porte l’alerte en tête pour un investisseur qui veut louer ou ne l’a pas dit', async () => {
    for (const rentalTarget of ['furnished', null] as const) {
      const t = await setup({ energyClass: 'G', rentalTarget, writer: writerOf(['Ce bien de 45 m² coûte 171 250 € au total.']) });
      const r = await t.notes.draft(t.acces, t.as('agent', t.alex.id), { calculationId: t.calcId, projectId: t.project.id });
      if (!r.ok) throw new Error(r.code);
      expect(r.value.text.startsWith('Interdit à la location : classe énergie G'), String(rentalTarget)).toBe(true);
    }
    // Pour qui ne veut pas louer, la contrainte reste écrite, sans être en tête.
    const t = await setup({ energyClass: 'G', rentalTarget: 'none' });
    const r = await t.notes.draft(t.acces, t.as('agent', t.alex.id), { calculationId: t.calcId, projectId: t.project.id });
    if (!r.ok) throw new Error(r.code);
    expect(r.value.text.startsWith('Interdit')).toBe(false);
    expect(r.value.text).toContain('Interdit à la location : classe énergie G');
  });

  it('[R124] une alerte apparue après la rédaction refuse la validation', async () => {
    const t = await setup({ energyClass: 'C' });
    const r = await t.notes.draft(t.acces, t.as('agent', t.alex.id), { calculationId: t.calcId, projectId: t.project.id });
    if (!r.ok) throw new Error(r.code);
    await t.db.run("INSERT INTO property_sheets (id, property_id, network_id, version, data, created_by, created_at) VALUES ('s-2', 'p-1', ?, 2, ?, 'agent:a', ?)", [
      t.network.id,
      JSON.stringify({ energy: { energyClass: 'G' }, coownership: { isCoownership: false } }),
      AT,
    ]);
    const sha = (await t.db.first<{ text_sha256: string }>('SELECT text_sha256 FROM investment_notes'))!.text_sha256;
    expect(await t.notes.validate(t.acces, t.as('agent', t.alex.id), r.value.id, { textSha256: sha })).toEqual({ ok: false, rule: 'R124', code: 'alerte_absente' });
    expect(await t.notes.forClient(t.network.id, r.value.id)).toBeNull();
  });

  it('[R126] la note n’est montrée au client qu’après validation par l’agent de la fiche, et ne change plus', async () => {
    const t = await setup();
    const r = await t.notes.draft(t.acces, t.as('agent', t.alex.id), { calculationId: t.calcId, projectId: t.project.id });
    if (!r.ok) throw new Error(r.code);
    expect(await t.notes.forClient(t.network.id, r.value.id)).toBeNull();
    const sha = (await t.db.first<{ text_sha256: string }>('SELECT text_sha256 FROM investment_notes'))!.text_sha256;
    expect(await t.notes.validate(t.acces, t.as('agent', t.sam.id), r.value.id, { textSha256: sha })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.notes.validate(t.acces, t.as('direction', 'dir-1'), r.value.id, { textSha256: sha })).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.notes.validate(t.acces, t.as('agent', t.alex.id), r.value.id, { textSha256: '0'.repeat(64) })).toMatchObject({ ok: false, code: 'texte_change' });
    expect(await t.notes.forClient(t.network.id, r.value.id)).toBeNull();
    const ok = await t.notes.validate(t.acces, t.as('agent', t.alex.id), r.value.id, { textSha256: sha });
    expect(ok).toMatchObject({ ok: true, value: { status: 'validee', validatedBy: `agent:${t.alex.id}` } });
    expect(await t.notes.forClient(t.network.id, r.value.id)).toMatchObject({ text: r.value.text });
    await expect(t.db.run("UPDATE investment_notes SET text = 'autre' WHERE id = ?", [r.value.id])).rejects.toThrow(/ne change plus/);
    await expect(t.db.run('DELETE FROM investment_notes WHERE id = ?', [r.value.id])).rejects.toThrow(/rien ne s'efface/);
  });

  it('[R125] AU100 · la trésorerie après prêt reste une simulation d’essai de l’agent : elle n’entre jamais dans la note du client (H72)', async () => {
    const t = await setup({ financing: true, writer: writerOf(['Avec une mensualité de 759 € par mois, la trésorerie reste positive.']) });
    const calc = await t.db.first<{ result: string }>('SELECT result FROM investment_calculations WHERE id = ?', [t.calcId]);
    expect(calc!.result).toContain('monthlyCashflow');
    const r = await t.notes.draft(t.acces, t.as('agent', t.alex.id), { calculationId: t.calcId, projectId: t.project.id });
    if (!r.ok) throw new Error(r.code);
    // Le nombre du prêt n'a pas de ligne dans la note : le texte de l'IA est refusé, le secours prend le relais.
    expect(r.value.origin).not.toBe('ia');
    for (const word of ['Capital emprunté', 'Mensualité du prêt', 'Trésorerie', '759']) expect(r.value.text).not.toContain(word);
    // Sans chiffre non plus : un paragraphe qui parle du prêt ou de la trésorerie est refusé.
    const words = await setup({ financing: true, writer: writerOf(['La trésorerie après remboursement du prêt est positive, assurance comprise.']) });
    const w = await words.notes.draft(words.acces, words.as('agent', words.alex.id), { calculationId: words.calcId, projectId: words.project.id });
    if (!w.ok) throw new Error(w.code);
    expect(w.value.origin).not.toBe('ia');
    expect(w.value.text).not.toContain('trésorerie');
    expect(financingClaims('Un bien prêt à louer, au loyer de marché.')).toEqual([]);
    // Ni dans une hypothèse écrite par l'agent, reprise dans les sources : la note est refusée, rien n'est rangé.
    const hyp = await setup({ financing: true, worksHypothesis: 'La trésorerie après remboursement du prêt est positive, assurance comprise.' });
    expect(await hyp.notes.draft(hyp.acces, hyp.as('agent', hyp.alex.id), { calculationId: hyp.calcId, projectId: hyp.project.id })).toEqual({ ok: false, rule: 'R125', code: 'financement' });
    expect(await hyp.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM investment_notes')).toEqual({ n: 0 });
    expect(financingClaims('Votre mensualité de crédit')).toEqual(['mensualite', 'credit']);
  });

  it('[R16] un autre agent ne fait pas rédiger la note d’une fiche qui n’est pas la sienne', async () => {
    const t = await setup();
    expect(await t.notes.draft(t.acces, t.as('agent', t.sam.id), { calculationId: t.calcId, projectId: t.project.id })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.notes.draft(t.acces, t.as('compliance', 'c-1'), { calculationId: t.calcId, projectId: t.project.id })).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    expect(Number((await t.db.first<{ n: number }>('SELECT count(*) AS n FROM investment_notes'))!.n)).toBe(0);
  });

  it('[R125] [R126] une hypothèse écrite par l’agent passe les mêmes contrôles, et n’est jamais envoyée à l’IA', async () => {
    let seen: NoteFacts | null = null;
    const spy: NoteWriter = { write: async (facts) => ((seen = facts), { paragraphs: ['Ce bien de 45 m² coûte 171 250 € au total.'] }) };
    const t = await setup({ writer: spy });
    const make = async (hypothesis: string) => {
      const c = await t.calculs.compute(t.acces, t.as('agent', t.alex.id), {
        propertyId: 'p-1',
        projectId: t.project.id,
        marketRentQuery: { inseeCode: '99001', kind: 'apartment' },
        inputs: {
          acquisitionFeesRateBp: src(750, 'barème de l’ancien'),
          works: src(1_000_000, hypothesis),
          nonRecoverableCharges: src(60_000), recoverableCharges: src(0),
          propertyTax: src(90_000),
          vacancyMonths: src(1),
        },
      });
      if (!c.ok) throw new Error(c.code);
      return t.notes.draft(t.acces, t.as('agent', t.alex.id), { calculationId: c.value.id, projectId: t.project.id });
    };
    expect(await make('devis de M. Martin, rentabilité assurée')).toMatchObject({ ok: false, rule: 'R125', code: 'tournure_interdite' });
    expect(await make('avec 9 % de rendement en plus')).toMatchObject({ ok: false, rule: 'R126', code: 'hypothese' });
    const ok = await make('devis du couvreur de M. Martin');
    expect(ok.ok).toBe(true);
    expect(JSON.stringify(seen)).not.toContain('Martin');
    expect(JSON.stringify(seen)).not.toContain('saisi:agent');
  });

  it('[R126] une perte n’est jamais écrite comme un gain : le signe d’un nombre compte', () => {
    const net = { key: 'netYieldBp', value: -269, unit: 'bp' as const, source: 'calcul', asOf: AT, hypothesis: 'h' };
    expect(traceParagraph('Le rendement net avant impôt est de 2,69 %.', [net]).problems).toEqual([{ code: 'nombre_sans_source', value: '2,69' }]);
    expect(traceParagraph('Le rendement net avant impôt est de −2,69 %.', [net]).problems).toEqual([]);
    expect(traceParagraph('Le rendement net avant impôt est de -2,69 %.', [net]).problems).toEqual([]);
    const income = { key: 'netIncome', value: -123_400, unit: 'cents' as const, source: 'calcul', asOf: AT, hypothesis: 'h' };
    expect(traceParagraph('Le revenu net est de 1 234 € par an.', [income]).problems).toHaveLength(1);
    expect(traceParagraph('Le revenu net est de −1 234 € par an.', [income]).problems).toEqual([]);
  });

  it('[R124] une note validée n’est plus remise au client si une interdiction de louer apparaît après la validation', async () => {
    const t = await setup({ energyClass: 'C' });
    const r = await t.notes.draft(t.acces, t.as('agent', t.alex.id), { calculationId: t.calcId, projectId: t.project.id });
    if (!r.ok) throw new Error(r.code);
    const v = await t.notes.validate(t.acces, t.as('agent', t.alex.id), r.value.id, { textSha256: r.value.textSha256 });
    expect(v).toMatchObject({ ok: true });
    expect(await t.notes.forClient(t.network.id, r.value.id)).toMatchObject({ text: r.value.text });
    await t.db.run("INSERT INTO property_sheets (id, property_id, network_id, version, data, created_by, created_at) VALUES ('s-3', 'p-1', ?, 2, ?, 'agent:a', ?)", [
      t.network.id,
      JSON.stringify({ energy: { energyClass: 'G' }, coownership: { isCoownership: false } }),
      AT,
    ]);
    expect(await t.notes.forClient(t.network.id, r.value.id)).toBeNull();
    expect((await t.journal.all()).some((e) => e.type === 'investir.note.retenue')).toBe(true);
  });

  it('revenir au loyer central après une borne rend le loyer central de la base et son hypothèse', async () => {
    const t = await setup();
    const low = await t.notes.draft(t.acces, t.as('agent', t.alex.id), { calculationId: t.calcId, projectId: t.project.id, hypotheses: { rent: 'low' } });
    if (!low.ok) throw new Error(low.code);
    const back = await t.notes.draft(t.acces, t.as('agent', t.alex.id), { calculationId: low.value.calculationId, projectId: t.project.id, hypotheses: { rent: 'central' } });
    if (!back.ok) throw new Error(back.code);
    expect(back.value.text).toContain('Rendement brut : 3,89 %');
    expect(back.value.text).toContain('Loyer de marché au m² : 12,35 €/m²');
    expect(back.value.text).not.toContain('borne basse de l’intervalle retenue');
  });

  it('[R126] un montant mensuel n’est jamais prouvé par une ligne annuelle, ni l’inverse', async () => {
    const t = await setup();
    const calc = await t.calculs.get(t.network.id, t.calcId);
    if (calc?.result.status !== 'complet') throw new Error('incomplet');
    const lines = calc.result.lines;
    expect(traceParagraph('Le loyer mensuel est de 6 669 €.', lines).problems).toHaveLength(1);
    expect(traceParagraph('Le loyer est de 6 669 € par mois.', lines).problems).toHaveLength(1);
    expect(traceParagraph('Le loyer annuel est de 6 669 €.', lines).problems).toEqual([]);
    expect(traceParagraph('Le loyer annuel est de 555,75 €.', lines).problems).toHaveLength(1);
    expect(traceParagraph('Le loyer est de 555,75 € par mois.', lines).problems).toEqual([]);
    // Un montant dit toujours ce qu'il est : un apport n'est pas une ligne du calcul.
    expect(traceParagraph('Votre apport personnel est de 150 000 €.', lines).problems).toHaveLength(1);
    // Chaque montant garde son libellé : deux chiffres permutés sont refusés.
    expect(traceParagraph('Le prix est de 10 000 € et les travaux de 150 000 €.', lines).problems).toHaveLength(2);
    expect(traceParagraph('Le prix est de 150 000 € et les travaux de 10 000 €.', lines).problems).toEqual([]);
    expect(traceParagraph('150 000 € de prix, 10 000 € de travaux.', lines).problems).toEqual([]);
    expect(traceParagraph('10 000 € de prix, 150 000 € de travaux.', lines).problems).toHaveLength(2);
    expect(traceParagraph('Le prix est de 150 000 €.', lines).problems).toEqual([]);
    // Une borne n'est jamais présentée comme le chiffre central : seulement dans une fourchette « de X à Y ».
    expect(traceParagraph('Le rendement net avant impôt central est de 3,46 %.', lines).problems).toHaveLength(1);
    expect(traceParagraph('Le rendement net avant impôt est de 2,69 % (de 2,04 % à 3,46 % selon le loyer).', lines).problems).toEqual([]);
    expect(traceParagraph('Le rendement net avant impôt va de 3,46 % à 2,04 %.', lines).problems).toHaveLength(2);
    expect(traceParagraph('Au loyer de marché de 15,01 €/m², le bien se loue mieux.', lines).problems).toHaveLength(1);
  });

  it('[R16] une note ne se rédige pas depuis le calcul d’un bien qu’on ne voit pas', async () => {
    const t = await setup();
    // Un calcul d'Alex, sans projet, sur un bien qui sort du fichier commun.
    const c = await t.calculs.compute(t.acces, t.as('agent', t.alex.id), { propertyId: 'p-1', marketRentQuery: { inseeCode: '99001', kind: 'apartment' }, inputs: { acquisitionFeesRateBp: src(750), works: src(0), nonRecoverableCharges: src(0), recoverableCharges: src(0), propertyTax: src(0), vacancyMonths: src(1) } });
    if (!c.ok) throw new Error(c.code);
    await t.db.run("UPDATE properties SET status = 'draft' WHERE id = 'p-1'");
    const store = new FicheClient(t.db, {});
    const person = await store.createPerson({ networkId: t.network.id, agentId: t.sam.id, firstName: 'Noé' });
    const project = await store.createProject({ networkId: t.network.id, agentId: t.sam.id, personId: person.id, kind: 'invest' });
    expect(await t.notes.draft(t.acces, t.as('agent', t.sam.id), { calculationId: c.value.id, projectId: project.id })).toMatchObject({ ok: false, rule: 'R16' });
    expect(Number((await t.db.first<{ n: number }>('SELECT count(*) AS n FROM investment_notes'))!.n)).toBe(0);
  });

  it('une note de l’IA trop longue une fois rendue passe au secours, sans erreur', async () => {
    const long = Array.from({ length: 8 }, () => Array.from({ length: 40 }, () => 'Le prix est de 150 000 €.').join(' ').slice(0, 1400));
    const t = await setup({ writer: writerOf(long) });
    const r = await t.notes.draft(t.acces, t.as('agent', t.alex.id), { calculationId: t.calcId, projectId: t.project.id });
    if (!r.ok) throw new Error(r.code);
    expect(r.value.origin).toBe('secours');
    expect(r.value.text.length).toBeLessThanOrEqual(20_000);
    expect((await t.journal.all()).some((e) => e.type === 'investir.note.secours' && (e.data as { code: string }).code === 'longueur')).toBe(true);
  });
});

describeWithSqlite('Y14 · retrouver les calculs et les notes d’un projet', () => {
  async function history() {
    const t = await setup();
    const h = new HistoriqueProjet(t.db, t.journal);
    const agent = t.as('agent', t.alex.id);
    return { ...t, h, agent };
  }

  it('[R16] la liste ne rend que le projet, à l’agent de la fiche et à la direction ; les autres sont refusés, au journal', async () => {
    const t = await history();
    expect(await t.h.of(t.acces, t.agent, t.project.id)).toMatchObject({ ok: true, value: { more: false, hidden: 0, notes: [] } });
    expect(await t.h.of(t.acces, t.as('direction', 'dir-1'), t.project.id)).toMatchObject({ ok: true });
    expect(await t.h.of(t.acces, t.as('compliance', 'conf-1'), t.project.id)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.h.of(t.acces, t.as('agent', t.sam.id), t.project.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.h.of(t.acces, t.agent, 'projet-inconnu')).toEqual({ ok: false, rule: 'R16', code: 'unknown' });
    const journal = await t.journal.all();
    expect(journal.some((e) => e.type === 'investir.historique_lu')).toBe(true);
    expect(journal.some((e) => e.type === 'acces.refuse' && (e.data as { kind?: string }).kind === 'investment_history')).toBe(true);
  });

  it('[R17] les lignes disent ce qui a été rangé, sans rien recalculer ni écrire de calcul ou de note', async () => {
    const t = await history();
    const note = await t.notes.draft(t.acces, t.agent, { calculationId: t.calcId, projectId: t.project.id });
    if (!note.ok) throw new Error(note.code);
    const count = async () => (await t.db.first<{ n: number }>('SELECT (SELECT COUNT(*) FROM investment_calculations) + (SELECT COUNT(*) FROM investment_notes) AS n'))!.n;
    const before = await count();
    const r = await t.h.of(t.acces, t.agent, t.project.id);
    if (!r.ok) throw new Error(r.code);
    expect(await count()).toBe(before);
    const line = r.value.calculs.find((c) => c.id === t.calcId)!;
    expect(line).toMatchObject({ status: 'complet', reference: 'REF-1' });
    // Aucun rendement dans la liste : il ne se montre qu'avec les alertes du jour [R124].
    expect(JSON.stringify(line)).not.toMatch(/Yield|result/);
    expect(r.value.notes).toEqual([{ id: note.value.id, calculationId: note.value.calculationId, createdAt: note.value.createdAt, status: 'a_valider', validatedAt: null, reference: 'REF-1' }]);
    expect(JSON.stringify(r.value)).not.toContain(note.value.text.slice(0, 40));
  });

  it('[R16] [R10] une ligne dont le bien n’est plus visible sort, et le nombre sorti est dit', async () => {
    const t = await history();
    const note = await t.notes.draft(t.acces, t.agent, { calculationId: t.calcId, projectId: t.project.id });
    expect(note.ok).toBe(true);
    await t.db.run('UPDATE properties SET agent_id = ?, status = ? WHERE id = ?', [t.sam.id, 'draft', 'p-1']);
    const r = await t.h.of(t.acces, t.agent, t.project.id);
    if (!r.ok) throw new Error(r.code);
    expect(r.value.calculs).toEqual([]);
    expect(r.value.notes).toEqual([]);
    expect(r.value.hidden).toBeGreaterThanOrEqual(2);
  });

  it('[R10] au-delà de la limite, les plus récentes, et il est dit qu’il y en a d’autres', async () => {
    const t = await history();
    const inputs = { acquisitionFeesRateBp: src(750), works: src(0), nonRecoverableCharges: src(0), recoverableCharges: src(0), propertyTax: src(0), vacancyMonths: src(1) };
    let last = '';
    for (let i = 0; i < PROJECT_HISTORY_LIMIT; i++) {
      const c = await t.calculs.compute(t.acces, t.agent, { propertyId: 'p-1', projectId: t.project.id, marketRentQuery: { inseeCode: '99001', kind: 'apartment' }, inputs });
      if (!c.ok) throw new Error(c.code);
      last = c.value.id;
    }
    const r = await t.h.of(t.acces, t.agent, t.project.id);
    if (!r.ok) throw new Error(r.code);
    expect(r.value.calculs).toHaveLength(PROJECT_HISTORY_LIMIT);
    expect(r.value.calculs[0]!.id).toBe(last);
    expect(r.value.calculs.some((c) => c.id === t.calcId)).toBe(false);
    expect(r.value.more).toBe(true);
  });

  it('[R124] un calcul se relit avec les alertes du jour d’abord ; sa fiche n’a pas de classe énergie : l’alerte est dite ; refus hors des droits [R16]', async () => {
    const t = await setup({ rentalTarget: 'furnished' });
    const agent = t.as('agent', t.alex.id);
    const r = await t.notes.rereadCalculation(t.acces, agent, t.calcId);
    if (!r.ok) throw new Error(r.code);
    expect(r.value.calculation.id).toBe(t.calcId);
    expect(r.value.alertsFirst.length).toBeGreaterThan(0);
    expect(await t.notes.rereadCalculation(t.acces, t.as('agent', t.sam.id), t.calcId)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.notes.reread(t.acces, t.as('agent', t.sam.id), 'note-inconnue')).toMatchObject({ ok: false, rule: 'R16' });
  });

  it('[R124] une note validée se relit tant qu’elle tient ; une interdiction apparue depuis la retient, sans son texte, comme chez le client', async () => {
    const t = await setup({ energyClass: 'D' });
    const agent = t.as('agent', t.alex.id);
    const d = await t.notes.draft(t.acces, agent, { calculationId: t.calcId, projectId: t.project.id });
    if (!d.ok) throw new Error(d.code);
    const v = await t.notes.validate(t.acces, agent, d.value.id, { textSha256: d.value.textSha256 });
    if (!v.ok) throw new Error(v.code);
    expect(await t.notes.reread(t.acces, agent, d.value.id)).toMatchObject({ ok: true, value: { status: 'validee', held: false, alertsFirst: [], note: { text: d.value.text } } });
    expect(await t.notes.forClient(t.network.id, d.value.id)).not.toBeNull();
    await t.db.run("INSERT INTO property_sheets (id, property_id, network_id, version, data, created_by, created_at) VALUES ('s-2', 'p-1', ?, 2, ?, 'agent:a', ?)", [t.network.id, JSON.stringify({ energy: { energyClass: 'G' }, coownership: { isCoownership: false } }), AT]);
    const again = await t.notes.reread(t.acces, agent, d.value.id);
    if (!again.ok) throw new Error(again.code);
    expect(again.value).toMatchObject({ held: true, note: null, status: 'validee' });
    expect(again.value.alertsFirst.length).toBeGreaterThan(0);
    expect(JSON.stringify(again.value)).not.toContain(d.value.text.slice(0, 40));
    expect(await t.notes.forClient(t.network.id, d.value.id)).toBeNull();
  });
});

it('[R126] AU099 · une note qui change une hypothèse d’un calcul de version 1 range un calcul de version 1, complet', async () => {
  const t = await setup({ writer: writerOf(['Le bien coûte au total ce que dit le calcul.']) });
  const agent = t.as('agent', t.alex.id);
  const current = await t.calculs.get(t.network.id, t.calcId);
  if (!current) throw new Error('calcul absent');
  const { recoverableCharges: _gone, ...legacy } = current.inputs;
  const legacyInputs = legacy as unknown as YieldInputs;
  const id = await t.calculs.store(agent, { propertyId: current.propertyId, projectId: current.projectId, inputs: legacyInputs, result: computeYield(legacyInputs, AT, 1) });
  const stored = await t.calculs.get(t.network.id, id);
  expect(stored?.result).toMatchObject({ status: 'complet', formulaVersion: 1 });
  expect((await t.calculs.replay(t.network.id, id))?.same).toBe(true);
  const r = await t.notes.draft(t.acces, agent, { calculationId: id, projectId: t.project.id, hypotheses: { vacancyMonths: 2 } });
  if (!r.ok) throw new Error(r.code);
  const revised = await t.calculs.get(t.network.id, r.value.calculationId);
  expect(revised?.result).toMatchObject({ status: 'complet', formulaVersion: 1 });
});

it('[R126] AU099 · « hors charges » et « charges comprises » ne se relient qu’à leur loyer, la provision jamais à un loyer', () => {
  const at = '2027-09-01';
  const l = (key: string, value: number) => ({ key, value, unit: 'cents' as const, source: 'calcul', asOf: at, hypothesis: 'h' });
  const lines = [l('monthlyRentWithCharges', 80_000), l('recoverableCharges', 10_000), l('monthlyRent', 70_000), l('nonRecoverableCharges', 60_000)];
  expect(traceParagraph('Le loyer hors charges est de 800 € par mois.', lines).problems).toEqual([{ code: 'nombre_sans_source', value: '800' }]);
  expect(traceParagraph('Le loyer hors charges est de 700 € par mois.', lines)).toMatchObject({ problems: [], proofs: [{ line: 'monthlyRent' }] });
  expect(traceParagraph('Le loyer charges comprises est de 800 € par mois.', lines)).toMatchObject({ problems: [], proofs: [{ line: 'monthlyRentWithCharges' }] });
  expect(traceParagraph('Le loyer charges comprises est de 700 € par mois.', lines).problems).toHaveLength(1);
  expect(traceParagraph('La provision pour charges récupérables est de 100 € par mois.', lines)).toMatchObject({ problems: [], proofs: [{ line: 'recoverableCharges' }] });
  expect(traceParagraph('Le loyer est de 100 € par mois.', lines).problems).toHaveLength(1);
});

it('[R126] AU099 · la note de secours avec provision se prouve chiffre par chiffre', () => {
  const s = (value: number) => ({ value, source: 'x', asOf: '2027-09-01', hypothesis: 'h' });
  const r = computeYield({ price: s(15_000_000), acquisitionFeesRateBp: s(750), works: s(0), livingArea: s(4_000), marketRent: { value: { centralM2Cents: 2_000, lowerM2Cents: 1_800, upperM2Cents: 2_200 }, source: 'x', asOf: '2027-01-01', hypothesis: 'h' }, nonRecoverableCharges: s(60_000), recoverableCharges: s(10_000), propertyTax: s(90_000), vacancyMonths: s(1) }, AT);
  if (r.status !== 'complet') throw new Error('incomplet');
  for (const p of fallbackParagraphs({ lines: r.lines } as unknown as NoteFacts)) expect(traceParagraph(p, r.lines).problems).toEqual([]);
});
