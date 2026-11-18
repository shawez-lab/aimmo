import { describe, expect, it } from 'vitest';
import { Acces, ControlesSignature, FicheClient, FicheUnique, Modeles, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '../src/index.ts';
import { CLAUSES, CLAUSE_CODES, clausesFor, DEFAULT_MAX_GAP_BPS, MandatQuestionnaire, priceGapBps, QUESTIONS, readAnswers, type Answers } from '../src/mandat-questionnaire/questionnaire.ts';
import { htmlProblems } from '../src/design/audit.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';
import { designerTout } from './designation-jeu.ts';

// Modèles et clauses de test, inventés : ce ne sont pas des textes juridiques. Réseau, agents et clients inventés.
const SIMPLE = ['MANDAT DE VENTE SIMPLE (MODÈLE DE TEST)', 'Entre {{mandant.nom}} et {{reseau.nom}}, représenté par {{agent.nom}}.', 'Bien {{bien.reference}}, {{bien.commune}}, au prix de {{bien.prix}}.', 'Honoraires : {{honoraires.montant}}, {{honoraires.charge}}. Durée : {{mandat.duree_mois}}.', 'Numéro au registre : {{registre.numero}} · {{bien.adresse}} · {{bien.cadastre}} · {{mandant.domicile}}. Fait le {{document.date}}.'].join('\n\n');
const EXCLUSIF = SIMPLE.replace('SIMPLE', 'EXCLUSIF') + '\n\n!! Clause d’exclusivité du modèle de test.';
const NOW = new Date('2027-04-12T09:00:00.000Z');
const BASE: Answers = { exclusivite: 'non', lieu_signature: 'agence', vendeurs: 'une', occupation: 'libre', copropriete: 'non', honoraires: 'vendeur' };
const INPUTS = { 'honoraires.montant': 9000, 'mandat.duree_mois': 3 };

async function setup(o: { price?: number | null } = {}) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = () => NOW;
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const modeles = new Modeles(db, acces, journal, { now });
  const mq = new MandatQuestionnaire(db, acces, modeles, journal, { now });
  const controles = new ControlesSignature(db, acces, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const as = (role: string, userId: string): Viewer => ({ role, userId, networkId: network.id }) as Viewer;
  const direction = as('direction', 'direction-1');
  const conformite = as('compliance', 'conformite-1');
  const agent = as('agent', alex.id);
  const person = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Prénom', lastName: 'Inventé' });
  const property = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'REF-Q-1', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 80, rooms: 4, priceEur: o.price === undefined ? 330000 : o.price });
  const templates = async (validate: boolean) => {
    for (const [kind, body] of [['mandat_vente_simple', SIMPLE], ['mandat_vente_exclusif', EXCLUSIF]] as const) {
      const v = await modeles.createVersion(direction, kind, body);
      if (!v.ok) throw new Error(v.code);
      if (validate) expect((await modeles.validate(conformite, v.template.id)).ok).toBe(true);
    }
  };
  const clauses = async (validate: boolean, codes = CLAUSE_CODES) => {
    const ids: Record<string, string> = {};
    for (const code of codes) {
      const w = await mq.writeClause(direction, code, `Texte de test de la clause ${code}.`);
      if (!w.ok) throw new Error(w.code);
      ids[code] = w.id;
      if (validate) expect((await mq.validateClause(conformite, w.id)).ok).toBe(true);
    }
    return ids;
  };
  let v = 0;
  const valuation = async (low: number, high: number, opts: { validated?: boolean; agentLow?: number; agentHigh?: number; at?: string } = {}) => {
    const id = `val-${++v}`;
    const validated = opts.validated ?? true;
    const at = opts.at ?? `2027-04-0${v}T10:00:00.000Z`;
    await db.run(
      `INSERT INTO valuation_reports (id, network_id, property_id, agent_id, status, computed, computed_low, computed_high, agent_low, agent_high, text, text_by, created_at, updated_at, validated_by, validated_at)
       VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, 'Avis de test', 'fallback', ?, ?, ?, ?)`,
      [id, network.id, property.id, alex.id, validated ? 'validated' : 'draft', low, high, opts.agentLow ?? null, opts.agentHigh ?? null, at, at, validated ? `agent:${alex.id}` : null, validated ? at : null],
    );
    return id;
  };
  const prepare = async (answers: Answers = BASE, viewer: Viewer = agent) => (await designerTout(db), mq.prepare(viewer, { personId: person.id, propertyId: property.id, answers, inputs: INPUTS }));
  const line = async (documentId: string, check: string) => {
    const c = await controles.check(direction, documentId);
    if (!c.ok) throw new Error(c.code);
    return c.value.lines.find((l) => l.check === check);
  };
  return { db, journal, mq, modeles, controles, line, network, alex, sam, as, direction, conformite, agent, person, property, templates, clauses, valuation, prepare };
}

describe('HX33 · questionnaire', () => {
  it('[R440] chaque question a une réponse de sa liste, ni plus ni moins', () => {
    expect(readAnswers(BASE)).toEqual(BASE);
    expect(readAnswers({ ...BASE, exclusivite: 'peut-être' })).toBeNull();
    const { copropriete: _c, ...short } = BASE;
    expect(readAnswers(short)).toBeNull();
    expect(readAnswers({ ...BASE, autre: 'oui' })).toBeNull();
    expect(readAnswers({ ...BASE, toString: 'oui' })).toBeNull();
    expect(readAnswers(null)).toBeNull();
    expect(readAnswers([])).toBeNull();
  });

  it('[R440] chaque clause retenue renvoie à la réponse qui la déclenche et à son texte de loi ; sans réponse, aucune clause', () => {
    expect(clausesFor(BASE)).toEqual([]);
    const all: Answers = { exclusivite: 'oui', lieu_signature: 'distance', vendeurs: 'plusieurs', occupation: 'loue', copropriete: 'oui', honoraires: 'acquereur' };
    const hits = clausesFor(all);
    expect(hits.map((h) => h.code)).toEqual(CLAUSE_CODES);
    for (const h of hits) {
      expect(all[h.question]).toBe(h.answer);
      expect(CLAUSES[h.code].when.some(([q, a]) => q === h.question && a === h.answer)).toBe(true);
      expect(CLAUSES[h.code].basis.length).toBeGreaterThan(10);
    }
    expect(clausesFor({ ...BASE, lieu_signature: 'hors_agence' })).toEqual([{ code: 'retractation', question: 'lieu_signature', answer: 'hors_agence' }]);
    // Toute réponse qui déclenche une clause est une réponse permise de sa question.
    for (const code of CLAUSE_CODES) for (const [q, a] of CLAUSES[code].when) expect(Object.keys(QUESTIONS[q].answers)).toContain(a);
  });

  it('[R441] écart en points de base de la borne dépassée, entier, arrondi au-dessus', () => {
    expect(priceGapBps(300000, 280000, 310000)).toBe(0);
    expect(priceGapBps(310000, 280000, 310000)).toBe(0);
    expect(priceGapBps(325500, 280000, 310000)).toBe(500);
    expect(priceGapBps(325501, 280000, 310000)).toBe(501);
    expect(priceGapBps(266000, 280000, 310000)).toBe(500);
    expect(priceGapBps(265999, 280000, 310000)).toBe(501);
    expect(DEFAULT_MAX_GAP_BPS).toBe(500);
  });
});

describeWithSqlite('HX33 · mandat par questionnaire', () => {
  it('[R440] chaque clause du mandat dit, à côté d’elle, la réponse qui l’a déclenchée et son texte ; le reste vient de la base', async () => {
    const t = await setup();
    await t.templates(true);
    await t.clauses(true);
    await t.valuation(300000, 340000);
    const r = await t.prepare({ ...BASE, exclusivite: 'oui', lieu_signature: 'hors_agence', copropriete: 'oui' });
    if (!r.ok) throw new Error(r.code);
    expect(r.mandate.kind).toBe('mandat_vente_exclusif');
    expect(r.mandate.clauses.map((c) => c.code)).toEqual(['exclusivite', 'retractation', 'copropriete']);
    for (const c of r.mandate.clauses) {
      expect(c.status).toBe('valide');
      expect(c.version).toBe(1);
      expect(c.hash).toMatch(/^[0-9a-f]{64}$/);
      const q = QUESTIONS[c.question];
      const said = (q.answers as Record<string, string>)[c.answer]!;
      expect(r.mandate.content).toContain(`Texte de test de la clause ${c.code}.`);
      expect(r.mandate.content).toContain(`Retenue par la réponse « ${said} » à la question « ${q.label} ». Texte : ${CLAUSES[c.code].basis}. Texte de la clause : version 1, empreinte ${c.hash}.`);
    }
    // Les clauses non déclenchées n'y sont pas.
    expect(r.mandate.content).not.toContain('clause tous_vendeurs');
    expect(r.mandate.content).not.toContain('clause bien_loue');
    // Prérempli depuis la base : mandant, bien, prix, agent ; la charge des honoraires vient de la réponse.
    expect(r.mandate.content).toContain('Entre Prénom Inventé et Réseau test, représenté par Alex Agent.');
    expect(r.mandate.content).toContain('Bien REF-Q-1, 21000 Dijon, au prix de 330');
    expect(r.mandate.content).toContain('à la charge du vendeur');
    expect(r.mandate.content).toContain('<p class="evidence"><strong>Exclusivité.</strong>');
    expect(htmlProblems(r.mandate.content)).toEqual([]);
    // Rangé tel quel, avec ses réponses et ses clauses ; le journal ne porte ni prix ni texte [R13].
    const row = await t.db.first<{ answers: string; clauses: string; content_hash: string }>('SELECT answers, clauses, content_hash FROM mandate_questionnaires WHERE id = ?', [r.mandate.id]);
    expect(JSON.parse(row!.answers)).toMatchObject({ exclusivite: 'oui', lieu_signature: 'hors_agence' });
    expect(JSON.parse(row!.clauses)).toEqual(r.mandate.clauses);
    expect(row!.content_hash).toBe(r.mandate.contentHash);
    const events = JSON.stringify(await t.db.all('SELECT * FROM journal'));
    expect(events).not.toMatch(/330[\s\u202f]?000/);
    expect(events).not.toContain('Texte de test');
    expect(events).not.toContain('Inventé');
  });

  it('[R440] la charge des honoraires suit la réponse, et « acquéreur » retient sa clause', async () => {
    const t = await setup();
    await t.templates(true);
    await t.clauses(true);
    await t.valuation(300000, 340000);
    const r = await t.prepare({ ...BASE, honoraires: 'acquereur' });
    if (!r.ok) throw new Error(r.code);
    expect(r.mandate.content).toContain('à la charge de l’acquéreur');
    expect(r.mandate.clauses.map((c) => c.code)).toEqual(['honoraires_acquereur']);
  });

  it('[R440] des réponses hors liste ou une saisie inconnue ne préparent rien', async () => {
    const t = await setup();
    await t.templates(true);
    expect(await t.mq.prepare(t.agent, { personId: t.person.id, propertyId: t.property.id, answers: { ...BASE, vendeurs: 'trois' } })).toMatchObject({ ok: false, code: 'bad_answers' });
    expect(await t.mq.prepare(t.agent, { personId: t.person.id, propertyId: t.property.id, answers: BASE, inputs: { 'honoraires.charge': 'vendeur' } as never })).toMatchObject({ ok: false, code: 'bad_input' });
    expect(await t.db.first('SELECT COUNT(*) AS n FROM mandate_questionnaires')).toEqual({ n: 0 });
  });

  it('[R441] un prix au-delà de l’écart toléré est signalé, et le mandat n’est pas prêt tant que l’agent ne l’a pas montré', async () => {
    const t = await setup({ price: 360000 });
    await t.templates(true);
    await t.valuation(280000, 310000);
    const r = await t.prepare();
    if (!r.ok) throw new Error(r.code);
    expect(r.mandate.mode).toBe('reel');
    expect(r.mandate.price).toMatchObject({ priceEur: 360000, low: 280000, high: 310000, gapBps: 1613, maxGapBps: 500, check: 'ecart' });
    expect(r.mandate.content).toContain('<p class="evidence">Avis de valeur validé le 01/04/2027 : entre 280');
    expect(r.mandate.content).toContain('Écart de 16,13');
    expect(r.mandate.content).toContain('au-dessus de la fourchette (toléré : 5');
    expect(await t.mq.beforeSignature(t.agent, r.mandate.id)).toEqual({ ok: true, ready: false, blockers: ['ecart_prix'] });
    // Ni un autre agent ni la direction ne disent l'avoir montré à la place de l'agent du bien [R16].
    expect(await t.mq.acknowledgeGap(t.as('agent', t.sam.id), r.mandate.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.mq.acknowledgeGap(t.direction, r.mandate.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.mq.beforeSignature(t.as('agent', t.sam.id), r.mandate.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.mq.acknowledgeGap(t.agent, r.mandate.id)).toEqual({ ok: true });
    expect(await t.mq.acknowledgeGap(t.agent, r.mandate.id)).toMatchObject({ ok: false, code: 'already_acknowledged' });
    expect(await t.mq.beforeSignature(t.agent, r.mandate.id)).toEqual({ ok: true, ready: true, blockers: [] });
    expect(await t.mq.beforeSignature(t.direction, r.mandate.id)).toEqual({ ok: true, ready: true, blockers: [] });
  });

  it('[R441] dans l’écart toléré : rien à signaler ; la fourchette lue est celle que l’agent a validée, du dernier avis validé', async () => {
    const t = await setup({ price: 330000 });
    await t.templates(true);
    // Un brouillon plus récent ne compte pas ; la fourchette ajustée par l'agent remplace le calcul.
    await t.valuation(200000, 220000, { at: '2027-03-01T10:00:00.000Z' });
    await t.valuation(250000, 260000, { agentLow: 300000, agentHigh: 320000, at: '2027-04-01T10:00:00.000Z' });
    await t.valuation(100000, 110000, { validated: false, at: '2027-04-10T10:00:00.000Z' });
    const r = await t.prepare();
    if (!r.ok) throw new Error(r.code);
    expect(r.mandate.price).toMatchObject({ low: 300000, high: 320000, gapBps: 313, check: 'dans_fourchette', valuationId: 'val-2' });
    expect(r.mandate.content).not.toContain('class="evidence">Avis');
    expect(await t.mq.beforeSignature(t.agent, r.mandate.id)).toEqual({ ok: true, ready: true, blockers: [] });
    expect(await t.mq.acknowledgeGap(t.agent, r.mandate.id)).toMatchObject({ ok: false, code: 'nothing_to_acknowledge' });
  });

  it('[R441] le réglage de la direction compte, le dernier gagne ; personne d’autre ne le change', async () => {
    const t = await setup({ price: 330000 });
    await t.templates(true);
    await t.valuation(280000, 310000);
    expect(await t.mq.setMaxGap(t.agent, 2000)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.mq.setMaxGap(t.direction, 5001)).toMatchObject({ ok: false, code: 'bad_setting' });
    expect(await t.mq.setMaxGap(t.direction, 1000)).toEqual({ ok: true });
    let r = await t.prepare();
    if (!r.ok) throw new Error(r.code);
    expect(r.mandate.price).toMatchObject({ gapBps: 646, maxGapBps: 1000, check: 'dans_fourchette' });
    expect(await t.mq.setMaxGap(t.direction, 600)).toEqual({ ok: true });
    r = await t.prepare();
    if (!r.ok) throw new Error(r.code);
    expect(r.mandate.price).toMatchObject({ gapBps: 646, maxGapBps: 600, check: 'ecart' });
  });

  it('[R441] sans avis validé ou sans prix : c’est dit, et l’agent doit l’avoir montré avant de signer', async () => {
    const t = await setup();
    await t.templates(true);
    await t.valuation(280000, 310000, { validated: false });
    const r = await t.prepare();
    if (!r.ok) throw new Error(r.code);
    expect(r.mandate.price).toMatchObject({ check: 'sans_avis', low: null, gapBps: null, valuationId: null });
    expect(r.mandate.content).toContain('Aucun avis de valeur validé pour ce bien');
    expect(await t.mq.beforeSignature(t.agent, r.mandate.id)).toEqual({ ok: true, ready: false, blockers: ['sans_avis'] });
    expect(await t.mq.acknowledgeGap(t.agent, r.mandate.id)).toEqual({ ok: true });
    expect(await t.mq.beforeSignature(t.agent, r.mandate.id)).toEqual({ ok: true, ready: true, blockers: [] });

    const u = await setup({ price: null });
    await u.templates(true);
    await u.valuation(280000, 310000);
    const s = await u.prepare();
    if (!s.ok) throw new Error(s.code);
    expect(s.mandate.price).toMatchObject({ check: 'sans_prix', priceEur: null, valuationId: null });
    expect(s.mandate.missing).toContain('champ:bien.prix');
    expect(await u.mq.beforeSignature(u.agent, s.mandate.id)).toEqual({ ok: true, ready: false, blockers: ['manque', 'sans_prix'] });
  });

  it('[R442] seul un modèle et des clauses validés par la conformité donnent un vrai mandat', async () => {
    const t = await setup();
    await t.valuation(300000, 340000);
    const answers: Answers = { ...BASE, vendeurs: 'plusieurs' };
    // Modèle d'essai : mandat d'essai, même avec des clauses validées.
    await t.templates(false);
    await t.clauses(true);
    let r = await t.prepare(answers);
    if (!r.ok) throw new Error(r.code);
    expect(r.mandate.mode).toBe('essai');
    expect(r.mandate.content).toContain('DOCUMENT D’ESSAI');
    expect(await t.mq.beforeSignature(t.agent, r.mandate.id)).toMatchObject({ ready: false, blockers: ['essai'] });

    // Modèle validé, clause d'essai : le mandat entier est d'essai, bandeau compris.
    const u = await setup();
    await u.valuation(300000, 340000);
    await u.templates(true);
    const ids = await u.clauses(false, ['tous_vendeurs']);
    r = await u.prepare(answers);
    if (!r.ok) throw new Error(r.code);
    expect(r.mandate.mode).toBe('essai');
    expect(r.mandate.clauses[0]).toMatchObject({ code: 'tous_vendeurs', status: 'essai' });
    expect(r.mandate.content.match(/DOCUMENT D’ESSAI/g)).toHaveLength(1);

    // Ni la direction ni un agent ne valident ; la conformité valide une fois, et jamais ce qu'elle a écrit.
    expect(await u.mq.validateClause(u.direction, ids.tous_vendeurs!)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await u.mq.validateClause(u.agent, ids.tous_vendeurs!)).toMatchObject({ ok: false, rule: 'R16' });
    // La même personne, passée à la conformité, ne valide pas ce qu'elle a écrit comme direction.
    expect(await u.mq.validateClause(u.as('compliance', 'direction-1'), ids.tous_vendeurs!)).toMatchObject({ ok: false, rule: 'R16', code: 'own_clause' });
    expect(await u.mq.validateClause(u.conformite, ids.tous_vendeurs!)).toEqual({ ok: true });
    expect(await u.mq.validateClause(u.conformite, ids.tous_vendeurs!)).toMatchObject({ ok: false, code: 'already_validated' });
    r = await u.prepare(answers);
    if (!r.ok) throw new Error(r.code);
    expect(r.mandate.mode).toBe('reel');
    expect(r.mandate.content).not.toContain('DOCUMENT D’ESSAI');

    // Une nouvelle version d'essai ne remplace pas la version validée.
    const w = await u.mq.writeClause(u.direction, 'tous_vendeurs', 'Nouveau texte de test, pas encore relu.');
    expect(w).toMatchObject({ ok: true, version: 2 });
    r = await u.prepare(answers);
    if (!r.ok) throw new Error(r.code);
    expect(r.mandate).toMatchObject({ mode: 'reel', clauses: [{ code: 'tous_vendeurs', version: 1, status: 'valide' }] });
    expect(r.mandate.content).not.toContain('Nouveau texte de test');
  });

  it('[R442] une clause retenue sans texte écrit : montrée « à écrire », jamais inventée, et le mandat reste d’essai', async () => {
    const t = await setup();
    await t.templates(true);
    await t.valuation(300000, 340000);
    const r = await t.prepare({ ...BASE, occupation: 'loue' });
    if (!r.ok) throw new Error(r.code);
    expect(r.mandate).toMatchObject({ mode: 'essai', missing: ['clause:bien_loue'], clauses: [{ code: 'bien_loue', status: 'manquante', clauseId: null }] });
    expect(r.mandate.content).toContain('[à écrire : clause « Bien vendu occupé »]');
    expect(r.mandate.content).toContain('Texte de la clause : pas encore écrit.');
    expect(await t.mq.beforeSignature(t.agent, r.mandate.id)).toMatchObject({ ready: false, blockers: ['essai', 'manque'] });
  });

  it('[R442] l’écriture d’une clause : la direction seule, code de la liste, aucun champ', async () => {
    const t = await setup();
    expect(await t.mq.writeClause(t.agent, 'exclusivite', 'Texte')).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.mq.writeClause(t.direction, 'inventee', 'Texte')).toMatchObject({ ok: false, code: 'unknown_clause' });
    expect(await t.mq.writeClause(t.direction, 'exclusivite', 'Le prix de {{bien.prix}}')).toMatchObject({ ok: false, code: 'field_in_clause' });
    expect(await t.mq.writeClause(t.direction, 'exclusivite', '  ')).toMatchObject({ ok: false, code: 'empty_body' });
    expect(await t.mq.writeClause(t.direction, 'exclusivite', 'x'.repeat(5001))).toMatchObject({ ok: false, code: 'body_too_long' });
  });

  it('[R16] seul l’agent qui suit le client prépare son mandat ; un client inconnu, un autre réseau : rien', async () => {
    const t = await setup();
    await t.templates(true);
    expect(await t.prepare(BASE, t.as('agent', t.sam.id))).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.prepare(BASE, t.conformite)).toMatchObject({ ok: false, rule: 'R16' });
    const r = await t.prepare();
    if (!r.ok) throw new Error(r.code);
    const other = { role: 'direction', userId: 'd-2', networkId: 'autre-reseau' } as Viewer;
    expect(await t.mq.beforeSignature(other, r.mandate.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.mq.acknowledgeGap(other, r.mandate.id)).toMatchObject({ ok: false, rule: 'R16' });
  });

  it('[R442] ce qui passe les contrôles avant signature est le mandat du questionnaire : clauses dedans, essai refusé', async () => {
    const t = await setup();
    await t.templates(true);
    await t.valuation(300000, 340000);
    const ids = await t.clauses(false, ['retractation']);
    let r = await t.prepare({ ...BASE, lieu_signature: 'distance' });
    if (!r.ok) throw new Error(r.code);
    const doc = await t.db.first<{ mode: string; status: string; content: string; content_hash: string }>('SELECT mode, status, content, content_hash FROM documents WHERE id = ?', [r.mandate.documentId]);
    expect(doc).toMatchObject({ mode: 'essai', content: r.mandate.content, content_hash: r.mandate.contentHash });
    expect(doc!.content).toContain('Texte de test de la clause retractation.');
    expect(await t.line(r.mandate.documentId, 'modele')).toMatchObject({ ok: false, code: 'trial_template' });
    // Sans texte : le document lui-même est incomplet.
    r = await t.prepare({ ...BASE, occupation: 'loue' });
    if (!r.ok) throw new Error(r.code);
    expect(await t.db.first('SELECT mode, status FROM documents WHERE id = ?', [r.mandate.documentId])).toEqual({ mode: 'essai', status: 'incomplet' });
    expect(await t.line(r.mandate.documentId, 'champs')).toMatchObject({ ok: false });
    // Clause validée : le document est réel.
    await t.mq.validateClause(t.conformite, ids.retractation!);
    r = await t.prepare({ ...BASE, lieu_signature: 'distance' });
    if (!r.ok) throw new Error(r.code);
    expect(await t.line(r.mandate.documentId, 'modele')).toMatchObject({ ok: true });
    expect(await t.line(r.mandate.documentId, 'questionnaire')).toMatchObject({ ok: true, code: 'price_checked' });
  });

  it('[R441] les contrôles avant signature refusent un écart de prix que l’agent n’a pas montré', async () => {
    const t = await setup({ price: 360000 });
    await t.templates(true);
    await t.valuation(280000, 310000);
    const r = await t.prepare();
    if (!r.ok) throw new Error(r.code);
    expect(await t.line(r.mandate.documentId, 'questionnaire')).toMatchObject({ ok: false, code: 'price_ecart_not_shown' });
    expect(await t.mq.acknowledgeGap(t.agent, r.mandate.id)).toEqual({ ok: true });
    expect(await t.line(r.mandate.documentId, 'questionnaire')).toMatchObject({ ok: true, code: 'price_checked' });
    // Un document fait sans questionnaire n'a pas cette ligne.
    await designerTout(t.db);
    const plain = await t.modeles.generate(t.agent, { kind: 'mandat_vente_simple', personId: t.person.id, propertyId: t.property.id, inputs: { ...INPUTS, 'honoraires.charge': 'vendeur' } });
    if (!plain.ok) throw new Error(plain.code);
    expect(await t.line(plain.document.id, 'questionnaire')).toBeUndefined();
  });

  it('[R443] rien ne s’efface ni ne se réécrit', async () => {
    const t = await setup();
    await t.templates(true);
    const ids = await t.clauses(true, ['exclusivite']);
    const r = await t.prepare({ ...BASE, exclusivite: 'oui' });
    if (!r.ok) throw new Error(r.code);
    expect(await t.mq.acknowledgeGap(t.agent, r.mandate.id)).toEqual({ ok: true });
    await t.mq.setMaxGap(t.direction, 700);
    const attempts: [string, string[]][] = [
      ['UPDATE mandate_questionnaires SET price_eur = 1 WHERE id = ?', [r.mandate.id]],
      ['DELETE FROM mandate_questionnaires WHERE id = ?', [r.mandate.id]],
      ['UPDATE mandate_clause_versions SET body = ? WHERE id = ?', ['autre', ids.exclusivite!]],
      ['DELETE FROM mandate_clause_versions WHERE id = ?', [ids.exclusivite!]],
      ['DELETE FROM mandate_clause_validations WHERE clause_id = ?', [ids.exclusivite!]],
      ['UPDATE mandate_clause_validations SET validated_by = ? WHERE clause_id = ?', ['x', ids.exclusivite!]],
      ['UPDATE mandate_price_gap_settings SET max_gap_bps = 0', []],
      ['DELETE FROM mandate_price_gap_settings', []],
      ['UPDATE mandate_questionnaire_gap_acks SET by_agent = ?', ['x']],
      ['DELETE FROM mandate_questionnaire_gap_acks', []],
    ];
    for (const [sql, params] of attempts) await expect(t.db.run(sql, params)).rejects.toThrow(/rien ne/);
  });
});
