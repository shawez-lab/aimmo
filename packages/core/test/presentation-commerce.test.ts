import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { Acces, SqlJournalStore, applyMigrations, createCaptation, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import {
  ACTIVITIES,
  EstimationCommerce,
  FicheCommerce,
  PRESENTATION_FACT_KEYS,
  PresentationCommerce,
  checkPresentation,
  confidentialMarks,
  fallbackPresentation,
  type PresentationFacts,
  type PresentationWriter,
} from '../src/commerces/index.ts';
import { EMPTY_SHEET, type BusinessSheet } from '../src/commerces/fiche.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const TUESDAY_10H = Date.parse('2027-09-07T08:00:00.000Z');

/** Une boulangerie inventée : tout ce qui est confidentiel, et la fourchette qui en sortira. */
const SHEET = {
  activity: 'boulangerie_patisserie',
  signName: 'Le Fournil de Gaspard',
  fiscalYears: [
    { year: 2026, revenueCents: 43_987_600, resultCents: 4_112_300 },
    { year: 2025, revenueCents: 41_234_500, resultCents: 3_876_100 },
    { year: 2024, revenueCents: 39_456_700, resultCents: -1_234_500 },
  ],
  leaseStart: '2019-04-01',
  leaseYears: 9,
  leaseAnnualRentCents: 1_872_000,
  employees: 4,
  equipment: ['four à sole', 'pétrin spirale'],
  licenses: ['agrement_sanitaire'],
};
// Moyenne 41 559 600 centimes ; × 60 % = 24 935 760 → 249 358 € ; × 90 % = 37 403 640 → 374 036 €.
const LOW = 249_358;
const HIGH = 374_036;

const FACTS: PresentationFacts = {
  kind: 'business',
  activity: 'boulangerie_patisserie',
  city: 'Dijon',
  postalCode: '21000',
  surfaceM2: 85,
  priceLowEuros: LOW,
  priceHighEuros: HIGH,
};
const MARKS = confidentialMarks({ ...EMPTY_SHEET, ...(SHEET as unknown as Partial<BusinessSheet>) });

class FakeWriter implements PresentationWriter {
  calls: unknown[] = [];
  constructor(private readonly reply: (f: PresentationFacts) => { title: string; body: string } | Promise<never>) {}
  async write(facts: PresentationFacts) {
    this.calls.push(facts);
    return this.reply(facts);
  }
}

const GOOD_AI = (f: PresentationFacts) => ({
  title: `Boulangerie-pâtisserie à reprendre à ${f.city}`,
  body: `Belle affaire de boulangerie-pâtisserie au cœur de ${f.city}, dans un quartier passant. Surface de ${f.surfaceM2} m². Prix entre 249 358 € et 374 036 €. Votre agent immobilier vous en dit plus après un engagement de confidentialité.`,
});

async function setup(writer?: PresentationWriter, timeoutMs?: number) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = TUESDAY_10H;
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const { store, fiche } = createCaptation(db, journal, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const fiches = new FicheCommerce(db, journal, { now });
  const estimations = new EstimationCommerce(db, journal, fiches, { now });
  const presentations = new PresentationCommerce(db, journal, fiches, estimations, { now, ...(writer ? { writer } : {}), ...(timeoutMs ? { timeoutMs } : {}) });
  const network = await store.createNetwork('Réseau test');
  const alexAgent = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const samAgent = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const as = (role: 'agent' | 'direction' | 'compliance' | 'partner', userId: string) => ({ role, userId, networkId: network.id });
  const alex = as('agent', alexAgent.id);
  const sam = as('agent', samAgent.id);
  const direction = as('direction', 'dir-1');
  let seq = 0;
  const property = async (kind: 'business' | 'business_walls' | 'commercial' | 'home' = 'business') =>
    store.createProperty({ networkId: network.id, agentId: alexAgent.id, reference: `CE-${(seq += 1)}`, kind, status: 'available', city: 'Dijon', postalCode: '21000', surfaceM2: 85 });
  /** Un commerce prêt : fiche remplie, barème rangé, estimation validée. */
  const ready = async () => {
    const p = await property();
    await fiches.update(acces, alex, p.id, SHEET);
    await estimations.recordScale(direction, { activity: 'boulangerie_patisserie', method: 'revenue_pct', low: 6_000, high: 9_000, source: 'Barème inventé pour les tests, édition 2027', sourceDate: '2027-01-15' });
    const e = await estimations.estimate(acces, alex, p.id, 'revenue_pct');
    if (!e.ok || e.status !== 'ok') throw new Error('estimation');
    await estimations.validate(acces, alex, e.value.id);
    return p;
  };
  return { db, journal, acces, fiches, estimations, presentations, alex, sam, direction, compliance: as('compliance', 'conf-1'), property, ready };
}

describeWithSqlite('CE03 · présentation anonyme d’un commerce', () => {
  it('[R112] [R110] l’IA ne reçoit que les champs publics et la fourchette validée ; son texte contrôlé est gardé', async () => {
    const writer = new FakeWriter(GOOD_AI);
    const t = await setup(writer);
    const p = await t.ready();
    const r = await t.presentations.propose(t.acces, t.alex, p.id);
    expect(r).toMatchObject({ ok: true, aiRefused: null, value: { origin: 'ia', seq: 1, validated: null } });
    expect(writer.calls).toHaveLength(1);
    const input = writer.calls[0] as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual([...PRESENTATION_FACT_KEYS].sort());
    expect(input).toEqual(FACTS);
    const sent = JSON.stringify(input);
    for (const secret of ['Fournil', 'Gaspard', '439876', '43987600', '18720', '1872000', 'four', 'pétrin', '2019', 'agrement']) expect(sent, secret).not.toContain(secret);
  });

  it('[R110] [R09] un texte qui cite un chiffre d’exercice, le loyer, l’enseigne, la rue ou un autre champ confidentiel est refusé', () => {
    const cases: [string, string][] = [
      ['Chiffre de 439 876 € sur le dernier exercice.', 'chiffre_confidentiel'],
      ['Un chiffre d’affaires solide.', 'champ_confidentiel'],
      ['Loyer modéré de 1 560 € par mois.', 'chiffre_confidentiel'],
      ['Loyer modéré.', 'champ_confidentiel'],
      ['Bail récent, cession libre.', 'champ_confidentiel'],
      ['Le Fournil de Gaspard est à reprendre.', 'enseigne'],
      ['Chez Gaspard depuis toujours.', 'enseigne'],
      ['Situé 12 rue des Essais.', 'adresse'],
      ['Sur la place du Marché-Inventé.', 'adresse'],
      ['Équipe de 4 personnes.', 'chiffre_confidentiel'],
      ['Quatre personnes en boutique.', 'nombre_hors_vue_publique'],
      ['Four à sole de qualité.', 'champ_confidentiel'],
      ['Fours à sole et pétrins spirales disponibles.', 'champ_confidentiel'],
      ['Four et pétrin disponibles.', 'champ_confidentiel'],
      ['Les Fournils de la ville.', 'enseigne'],
      ['Résultat en hausse de 12 %.', 'nombre_hors_vue_publique'],
      ['Prix 250 k€.', 'nombre_hors_vue_publique'],
      ['Affaire tenue depuis 2019.', 'chiffre_confidentiel'],
      ['Licence et terrasse.', 'champ_confidentiel'],
      // Des chiffres d'autres écritures ne contournent pas le contrôle.
      ['Belle affaire, ４３９ ８７６ € par an.', 'chiffre_confidentiel'],
      ['Belle affaire, ٤٣٩٨٧٦ € par an.', 'nombre_hors_vue_publique'],
      ['Belle affaire, ⁴ personnes.', 'chiffre_confidentiel'],
      ['Affaire exploitée par ³ personnes.', 'nombre_hors_vue_publique'],
      ['Affaire exploitée par ² personnes.', 'nombre_hors_vue_publique'],
      // Un nombre public n'a de source que pour son champ.
      ['Prix de 85 €.', 'nombre_hors_vue_publique'],
      ['Surface de 249358 m².', 'nombre_hors_vue_publique'],
      ['Surface de 21000 m2.', 'nombre_hors_vue_publique'],
      ['Code 249 358.', 'nombre_hors_vue_publique'],
      ['Prix de -249358 €.', 'nombre_hors_vue_publique'],
      ['Surface de −85 m².', 'nombre_hors_vue_publique'],
    ];
    for (const [text, code] of cases) {
      const r = checkPresentation('Boulangerie à Dijon', text, FACTS, MARKS);
      expect(r.ok, text).toBe(false);
      expect(r.sentences.flatMap((s) => s.problems.map((p) => p.code)), text).toContain(code);
    }
    // Une enseigne courte et distinctive est reconnue, seule ou dans son nom complet.
    for (const signName of ['AX', 'Au QG']) {
      expect(checkPresentation('Boulangerie à Dijon', `${signName} est à reprendre.`, FACTS, { ...MARKS, signName }).sentences.flatMap((x) => x.problems.map((p) => p.code)), signName).toContain('enseigne');
    }
    // Rangés au pluriel, lus au singulier : toujours confidentiels.
    const plural = { ...MARKS, signName: 'Les Fournils', equipment: ['fours à sole', 'pétrins spirales'] };
    for (const [text, code] of [['Four à sole et pétrin spirale disponibles.', 'champ_confidentiel'], ['Le Fournil est à reprendre.', 'enseigne']] as const) {
      expect(checkPresentation('Boulangerie à Dijon', text, FACTS, plural).sentences.flatMap((x) => x.problems.map((p) => p.code)), text).toContain(code);
    }
    // Un article du matériel, même court, est confidentiel.
    expect(checkPresentation('Boulangerie à Dijon', 'TV disponible.', FACTS, { ...MARKS, equipment: ['TV'] }).ok).toBe(false);
    // Une enseigne faite des seuls mots courants ne rend pas l'activité indicible ; le secours passe.
    const generic = { ...MARKS, signName: 'Boulangerie' };
    const fb = fallbackPresentation(FACTS);
    expect(checkPresentation(fb.title, fb.body, FACTS, generic).ok).toBe(true);
    // Le titre est contrôlé comme le texte.
    expect(checkPresentation('Le Fournil de Gaspard', 'Boulangerie à Dijon.', FACTS, MARKS).ok).toBe(false);
    // Les nombres publics passent, écrits avec ou sans espaces.
    expect(checkPresentation('Boulangerie à Dijon', 'Dijon (21000). 85 m². 85 m2, 85 mètres carrés. Entre 249358 € et 374 036 euros.', FACTS, MARKS).ok).toBe(true);
    // Une fourchette écrite avec un tiret n'est pas un montant négatif.
    for (const range of ['Prix : 249 358 € – 374 036 €.', 'Prix : 249 358 - 374 036 €.', 'Prix : 249 358 €-374 036 €.']) expect(checkPresentation('Boulangerie à Dijon', range, FACTS, MARKS).ok, range).toBe(true);
  });

  it('[R07] « agent immobilier », jamais « mandataire » ; ni « gratuit » ni mention de l’IA', () => {
    for (const text of ['Contactez votre mandataire.', 'Estimation gratuite.', 'Texte rédigé par une IA.']) {
      expect(checkPresentation('Boulangerie à Dijon', text, FACTS, MARKS).sentences.flatMap((s) => s.problems.map((p) => p.code)), text).toContain('mot_interdit');
    }
    expect(fallbackPresentation(FACTS).body).toContain('agent immobilier');
    expect(fallbackPresentation(FACTS).body).not.toMatch(/mandataire/i);
  });

  it('[R12] [R110] le texte de secours, fait des seuls faits publics, passe toujours le contrôle', () => {
    for (const kind of ['business', 'business_walls', 'commercial'] as const) {
      for (const activity of ACTIVITIES) {
        for (const extra of [{}, { city: null, postalCode: null, surfaceM2: null }, { surfaceM2: 120.5, priceLowEuros: 1_000_000, priceHighEuros: 1_250_000 },
          // Des communes dont le nom porte un nombre : le nom de la commune est public, il n'est pas un nombre.
          { city: 'Six-Fours-les-Plages', postalCode: '83140' }, { city: 'Neuf-Brisach', postalCode: '68600' }, { city: 'Saint-Paul-Trois-Châteaux', postalCode: '26130' },
          { city: 'Lyon 3e Arrondissement', postalCode: '69003' }]) {
          const f = { ...FACTS, kind, activity, ...extra };
          const fb = fallbackPresentation(f);
          const r = checkPresentation(fb.title, fb.body, f, MARKS);
          expect(r.ok, `${kind} ${activity} ${JSON.stringify(r.sentences.filter((s) => s.problems.length))}`).toBe(true);
          expect(fb.body).toContain('engagement de confidentialité');
        }
      }
    }
  });

  it('[R12] [R110] [R13] l’IA absente, en panne, trop lente ou refusée : le secours est rendu ; au journal, des codes seulement', async () => {
    const leaky = new FakeWriter(() => ({ title: 'Le Fournil de Gaspard', body: 'Chiffre d’affaires de 439 876 €. Situé 12 rue des Essais.' }));
    const writers: (PresentationWriter | undefined)[] = [
      undefined,
      new FakeWriter(() => Promise.reject(new Error('panne'))),
      { write: () => new Promise(() => undefined) },
      new FakeWriter(() => ({ title: '', body: '' })),
      leaky,
    ];
    for (const w of writers) {
      const t = await setup(w, 20);
      const p = await t.ready();
      const r = await t.presentations.propose(t.acces, t.alex, p.id);
      expect(r).toMatchObject({ ok: true, value: { origin: 'secours' } });
      if (r.ok) expect(r.value).toMatchObject(fallbackPresentation(FACTS));
      if (w === leaky && r.ok) {
        expect(r.aiRefused?.flatMap((s) => s.problems.map((x) => x.code))).toEqual(expect.arrayContaining(['enseigne', 'chiffre_confidentiel', 'adresse']));
        // Sans les identifiants et les empreintes tirés au hasard : l'un d'eux peut contenir ces chiffres par hasard.
        const text = JSON.stringify(await t.journal.all()).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{64}/g, '');
        for (const s of ['Fournil', 'Gaspard', '439 876', '439876', 'Essais']) expect(text, s).not.toContain(s);
        expect(text).toContain('commerces.presentation.ia_refusee');
      }
      // Le texte refusé n'est rangé nulle part.
      const rows = await t.db.all<{ body: string }>('SELECT body FROM business_presentations');
      expect(rows.map((x) => x.body).join(' ')).not.toContain('Gaspard');
    }
  });

  it('[R10] sans activité ou sans estimation validée, ce qui manque, jamais un texte ; un bien qui n’est pas un commerce est refusé', async () => {
    const writer = new FakeWriter(GOOD_AI);
    const t = await setup(writer);
    const p = await t.property();
    expect(await t.presentations.propose(t.acces, t.alex, p.id)).toEqual({ ok: false, rule: 'R10', code: 'incomplet', missing: ['fiche', 'activite', 'estimation_validee'] });
    await t.fiches.update(t.acces, t.alex, p.id, SHEET);
    await t.estimations.recordScale(t.direction, { activity: 'boulangerie_patisserie', method: 'revenue_pct', low: 6_000, high: 9_000, source: 'Barème inventé pour les tests', sourceDate: '2027-01-15' });
    await t.estimations.estimate(t.acces, t.alex, p.id, 'revenue_pct');
    // Estimée mais pas validée : toujours incomplet.
    expect(await t.presentations.propose(t.acces, t.alex, p.id)).toEqual({ ok: false, rule: 'R10', code: 'incomplet', missing: ['estimation_validee'] });
    expect(writer.calls).toHaveLength(0);
    const home = await t.property('home');
    expect(await t.presentations.propose(t.acces, t.alex, home.id)).toMatchObject({ ok: false, code: 'sorte' });
  });

  it('[R16] [R110] seul l’agent du bien valide le dernier brouillon ; rien n’est publiable sans sa validation', async () => {
    const t = await setup(new FakeWriter(GOOD_AI));
    const p = await t.ready();
    const net = (await t.db.first<{ network_id: string }>('SELECT network_id FROM properties WHERE id = ?', [p.id]))!.network_id;
    // Un autre agent ne propose ni ne lit ; refus au journal.
    expect(await t.presentations.propose(t.acces, t.sam, p.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.presentations.read(t.acces, t.sam, p.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(JSON.stringify(await t.journal.all())).toContain('business_presentation');
    // La direction propose, mais ne valide pas.
    const first = await t.presentations.propose(t.acces, t.direction, p.id);
    if (!first.ok) throw new Error('proposition');
    expect(await t.presentations.validate(t.acces, t.direction, first.value.id)).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.presentations.validate(t.acces, t.compliance, first.value.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.presentations.publishable(net, p.id)).toBeNull();
    // L'agent corrige : un texte confidentiel est refusé, un texte propre devient le dernier brouillon.
    expect(await t.presentations.correct(t.acces, t.alex, p.id, { title: 'Boulangerie à Dijon', body: 'Loyer de 1 560 € par mois.' })).toMatchObject({ ok: false, rule: 'R110', code: 'refused_text' });
    const second = await t.presentations.correct(t.acces, t.alex, p.id, { title: 'Boulangerie à Dijon', body: 'Belle affaire à reprendre. Prix entre 249 358 € et 374 036 €.' });
    expect(second).toMatchObject({ ok: true, value: { origin: 'agent', seq: 2 } });
    if (!second.ok) throw new Error('correction');
    expect(await t.presentations.validate(t.acces, t.alex, first.value.id)).toMatchObject({ ok: false, code: 'not_latest' });
    expect(await t.presentations.validate(t.acces, t.alex, second.value.id)).toMatchObject({ ok: true, value: { validated: { by: `agent:${t.alex.userId}` } } });
    expect(await t.presentations.validate(t.acces, t.alex, second.value.id)).toMatchObject({ ok: false, code: 'already_validated' });
    expect(await t.presentations.publishable(net, p.id)).toMatchObject({ id: second.value.id, body: 'Belle affaire à reprendre. Prix entre 249 358 € et 374 036 €.' });
    expect(await t.presentations.publishable('autre-reseau', p.id)).toBeNull();
    // La conformité lit.
    expect(await t.presentations.read(t.acces, t.compliance, p.id)).toMatchObject({ ok: true, value: { id: second.value.id } });
    // La fiche change : plus rien de publiable tant qu'une nouvelle estimation et une nouvelle validation n'ont pas eu lieu.
    await t.fiches.update(t.acces, t.alex, p.id, { employees: 5 });
    expect(await t.presentations.publishable(net, p.id)).toBeNull();
    expect(await t.presentations.propose(t.acces, t.alex, p.id)).toMatchObject({ ok: false, rule: 'R10', missing: ['estimation_validee'] });
  });

  it('[R110] un brouillon fait sur une ancienne estimation ne se valide plus', async () => {
    const t = await setup();
    const p = await t.ready();
    const draft = await t.presentations.propose(t.acces, t.alex, p.id);
    if (!draft.ok) throw new Error('proposition');
    await t.fiches.update(t.acces, t.alex, p.id, { employees: 5 });
    const e = await t.estimations.estimate(t.acces, t.alex, p.id, 'revenue_pct');
    if (!e.ok || e.status !== 'ok') throw new Error('estimation');
    await t.estimations.validate(t.acces, t.alex, e.value.id);
    expect(await t.presentations.validate(t.acces, t.alex, draft.value.id)).toMatchObject({ ok: false, rule: 'R110', code: 'stale' });
  });

  it('[R17] une présentation et sa validation ne se réécrivent ni ne s’effacent', async () => {
    const t = await setup();
    const p = await t.ready();
    const d = await t.presentations.propose(t.acces, t.alex, p.id);
    if (!d.ok) throw new Error('proposition');
    await t.presentations.validate(t.acces, t.alex, d.value.id);
    await expect(t.db.run('UPDATE business_presentations SET body = ?', ['x'])).rejects.toThrow(/ne se réécrit pas/);
    await expect(t.db.run('DELETE FROM business_presentations')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run('DELETE FROM business_presentation_validations')).rejects.toThrow(/rien ne s'efface/);
  });
});

it('[R112] le module ne passe à l’IA que `PresentationFacts`, construit depuis la vue publique et la fourchette', () => {
  const source = readFileSync(new URL('../src/commerces/presentation.ts', import.meta.url), 'utf8');
  const calls = [...source.matchAll(/this\.writer\.write\(([^)]*)\)/g)].map((m) => m[1]);
  expect(calls).toEqual(['structuredClone(facts']);
  expect(source).toMatch(/private async askWriter\(facts: PresentationFacts\)/);
});
