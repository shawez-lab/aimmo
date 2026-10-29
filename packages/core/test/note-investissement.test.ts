import { expect, it } from 'vitest';
import { Acces, FicheClient, SqlJournalStore, applyMigrations, createCaptation, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import {
  ANIL_CITATION,
  CalculInvestissement,
  Contraintes,
  FEW_OBSERVATIONS,
  LoyersMarche,
  NotesInvestissement,
  PROFESSIONAL_REFERRAL,
  ProfilInvestisseur,
  forbiddenPhrases,
  traceParagraph,
  type NoteFacts,
  type NoteWriter,
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

async function setup(options: { writer?: NoteWriter; energyClass?: string; rentalTarget?: 'none' | 'furnished' | null; csv?: string } = {}) {
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
      works: src(1_000_000, 'devis estimé'),
      nonRecoverableCharges: src(60_000, 'déclarées par le vendeur'),
      propertyTax: src(90_000, 'avis déclaré'),
      vacancyMonths: src(1, 'vacance réglée'),
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
  });

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
    expect(r.value.note.paragraphs[0]!.text).toBe('Le bien coûte 171 250 € au total : 150 000 € de prix, 11 250 € de frais d’acquisition et 10 000 € de travaux estimés.');
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
          nonRecoverableCharges: src(60_000),
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
  });

  it('[R16] une note ne se rédige pas depuis le calcul d’un bien qu’on ne voit pas', async () => {
    const t = await setup();
    // Un calcul d'Alex, sans projet, sur un bien qui sort du fichier commun.
    const c = await t.calculs.compute(t.acces, t.as('agent', t.alex.id), { propertyId: 'p-1', marketRentQuery: { inseeCode: '99001', kind: 'apartment' }, inputs: { acquisitionFeesRateBp: src(750), works: src(0), nonRecoverableCharges: src(0), propertyTax: src(0), vacancyMonths: src(1) } });
    if (!c.ok) throw new Error(c.code);
    await t.db.run("UPDATE properties SET status = 'draft' WHERE id = 'p-1'");
    const store = new FicheClient(t.db, {});
    const person = await store.createPerson({ networkId: t.network.id, agentId: t.sam.id, firstName: 'Noé' });
    const project = await store.createProject({ networkId: t.network.id, agentId: t.sam.id, personId: person.id, kind: 'invest' });
    expect(await t.notes.draft(t.acces, t.as('agent', t.sam.id), { calculationId: c.value.id, projectId: project.id })).toMatchObject({ ok: false, rule: 'R16' });
    expect(Number((await t.db.first<{ n: number }>('SELECT count(*) AS n FROM investment_notes'))!.n)).toBe(0);
  });
});
