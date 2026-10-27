import { expect, it } from 'vitest';
import {
  Acces,
  Qualification,
  ReconnaissanceBien,
  SqlJournalStore,
  applyMigrations,
  createCaptation,
  fromSyncSqlite,
  verifyChain,
  type QualifyBrief,
  type Qualifier,
  type SqlDatabase,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const TUESDAY_10H = new Date('2026-12-08T09:00:00.000Z');

async function setup(qualifier?: Qualifier) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => TUESDAY_10H;
  const journal = new SqlJournalStore(db);
  const { chaine, store, fiche, reception } = createCaptation(db, journal, { now, withQualification: false });
  const biens = new ReconnaissanceBien(db);
  const qualification = new Qualification(db, store, fiche, reception, biens, journal, { now, ...(qualifier ? { qualifier } : {}) });
  const network = await store.createNetwork('Réseau test');
  const agent = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const other = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Autre' });
  const home = await store.createProperty({ networkId: network.id, agentId: agent.id, reference: 'MAISON-Q', kind: 'home', city: 'Talant', priceEur: 320000, status: 'available' });
  let seq = 0;
  /** Un formulaire du site inventé ; rend l'identifiant du message reçu. */
  const form = async (message: string, extra: Record<string, unknown> = {}): Promise<string> => {
    seq += 1;
    await chaine.receive(network.id, 'site_form', { submissionId: `f-${seq}`, firstName: 'Zoé', email: 'zoe@example.test', message, ...extra });
    const row = await db.first<{ id: string }>('SELECT id FROM inbound_messages ORDER BY rowid DESC LIMIT 1');
    return row!.id;
  };
  const acces = new Acces(db, store, fiche, journal, { now });
  return { db, journal, qualification, form, store, network, agent, other, home, acces };
}

describeWithSqlite('Q01 · qualification d’un message rattaché', () => {
  it('range catégorie et champs, ouvre le projet de la fiche, et le complète sans rien écraser', async () => {
    const t = await setup();
    const first = await t.form('Je cherche une maison avec jardin à Talant, budget 320 000 €.', { propertyRef: 'MAISON-Q' });
    const q = await t.qualification.qualify(first);
    expect(q).toMatchObject({ category: 'buyer', city: 'Talant', budget_max_eur: 320000, source: 'rules', property_id: t.home.id });
    const projects = await t.db.all<{ id: string; kind: string; budget_max_eur: number; criteria: string }>('SELECT * FROM projects');
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ kind: 'buy', budget_max_eur: 320000 });
    expect(JSON.parse(projects[0]!.criteria)).toEqual({ criteria: ['house', 'garden'], city: 'Talant' });
    expect(await t.db.all('SELECT role FROM project_properties')).toEqual([{ role: 'interested' }]);

    // Même personne, nouveau message : le projet est complété, jamais remplacé.
    const second = await t.form('Je cherche toujours, entre 300 000 et 350 000 €, j’ai l’accord de principe de la banque.');
    const q2 = await t.qualification.qualify(second);
    expect(q2).toMatchObject({ category: 'buyer', project_id: projects[0]!.id, financing: 'loan_approved' });
    const after = await t.db.all<{ budget_min_eur: number; budget_max_eur: number }>('SELECT * FROM projects');
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ budget_min_eur: 300000, budget_max_eur: 320000 });
  });

  it('les critères nouveaux complètent ceux du projet, sans rien retirer', async () => {
    const t = await setup();
    await t.qualification.qualify(await t.form('Je cherche une maison.'));
    await t.qualification.qualify(await t.form('Je cherche une maison à Talant avec jardin.'));
    const projects = await t.db.all<{ criteria: string }>('SELECT criteria FROM projects');
    expect(projects).toHaveLength(1);
    expect(JSON.parse(projects[0]!.criteria)).toEqual({ criteria: ['house', 'garden'], city: 'Talant' });
  });

  it('deux messages qualifiés en même temps ne s’effacent pas leurs critères', async () => {
    const t = await setup();
    const a = await t.form('Je cherche une maison avec jardin à Talant.');
    const b = await t.form('Je cherche une maison avec garage.');
    await Promise.all([t.qualification.qualify(a), t.qualification.qualify(b)]);
    const [project] = await t.db.all<{ criteria: string }>('SELECT criteria FROM projects');
    const merged = JSON.parse(project!.criteria) as { criteria: string[]; city: string };
    expect(merged.city).toBe('Talant');
    expect([...merged.criteria].sort()).toEqual(['garage', 'garden', 'house']);
  });

  it('deux messages de la même personne qualifiés en même temps n’ouvrent qu’un projet', async () => {
    const t = await setup();
    const a = await t.form('Je souhaite vendre ma maison à Daix.');
    const b = await t.form('Je veux vendre rapidement, prix souhaité 250 000 €.');
    const [qa, qb] = await Promise.all([t.qualification.qualify(a), t.qualification.qualify(b)]);
    expect(await t.db.all('SELECT kind FROM projects')).toEqual([{ kind: 'sell' }]);
    expect(qa!.project_id).toBe(qb!.project_id);
  });

  it('[R24] chaque qualification a sa note par barème fixe, rangée une fois avec sa raison', async () => {
    const t = await setup();
    const id = await t.form('Je souhaite vendre ma maison à Daix rapidement.');
    const q = (await t.qualification.qualify(id))!;
    await t.qualification.qualify(id);
    const scores = await t.db.all<{ qualification_id: string; score: number; temperature: string; reason: string }>('SELECT * FROM contact_scores');
    expect(scores).toEqual([
      expect.objectContaining({ qualification_id: q.id, score: 70, temperature: 'hot', reason: 'Vendeur, délai immédiat, commune donnée : 70, chaud.' }),
    ]);
  });

  it('[R14] un candidat à une location est qualifié, sans aucune note', async () => {
    const t = await setup();
    const q = (await t.qualification.qualify(await t.form('Je cherche une location à Dijon, un T2, au plus vite.')))!;
    expect(q).toMatchObject({ category: 'buyer', route: 'M15' });
    expect(await t.qualification.scoreOf(q)).toBeNull();
    expect(await t.db.all('SELECT * FROM contact_scores')).toEqual([]);
  });

  it('[R18] un message n’est qualifié qu’une fois, même deux fois en même temps', async () => {
    const t = await setup();
    const id = await t.form('Je souhaite vendre ma maison à Daix.');
    const [a, b] = await Promise.all([t.qualification.qualify(id), t.qualification.qualify(id)]);
    expect(a!.id).toBe(b!.id);
    expect(await t.db.all('SELECT id FROM qualifications')).toHaveLength(1);
    expect(await t.db.all('SELECT kind FROM projects')).toEqual([{ kind: 'sell' }]);
  });

  it('un partenaire, une curiosité ou un indésirable n’ouvrent aucun projet ; une location et un commerce sont marqués pour M15 et M16', async () => {
    const t = await setup();
    expect(await t.qualification.qualify(await t.form('Je suis courtier et je vous propose un partenariat.'))).toMatchObject({ category: 'partner', project_id: null });
    expect(await t.qualification.qualify(await t.form('Vous êtes ouverts le samedi ?'))).toMatchObject({ category: 'curious', project_id: null });
    expect(await t.qualification.qualify(await t.form('Je souhaite mettre en location mon appartement.'))).toMatchObject({ category: 'rent_out', route: 'M15' });
    expect(await t.qualification.qualify(await t.form('Nous souhaitons céder notre fonds de commerce.'))).toMatchObject({ category: 'professional', route: 'M16' });
    const kinds = (await t.db.all<{ kind: string }>('SELECT kind FROM projects ORDER BY kind')).map((p) => p.kind);
    expect(kinds).toEqual(['rent_out', 'sell_business']);
  });

  it('[R15] l’IA ne reçoit que le texte reçu, sans coordonnée ; sa sortie conforme est gardée', async () => {
    const briefs: QualifyBrief[] = [];
    const qualifier: Qualifier = {
      async qualify(brief) {
        briefs.push(brief);
        return { category: 'seller', route: null, city: 'Dijon', budgetMinEur: null, budgetMaxEur: null, priceEur: null, deadline: 'now', financing: null, criteria: ['apartment'] };
      },
    };
    const t = await setup(qualifier);
    const id = await t.form('Bonjour, je suis Zoé Exemple. Je vends mon appartement à Dijon, rappelez-moi au 06 12 34 56 78 ou zoe@example.test, 3 rue des Essais.\nCordialement,\nZ. Exemple, Société Inventée');
    expect(await t.qualification.qualify(id)).toMatchObject({ category: 'seller', source: 'ai', deadline: 'now' });
    expect(briefs).toHaveLength(1);
    expect(Object.keys(briefs[0]!).sort()).toEqual(['channel', 'communes', 'propertyRecognized', 'text']);
    expect(briefs[0]!.text).not.toMatch(/06 12|example\.test|rue des Essais|Zoé|Exemple|Inventée/);
    expect(briefs[0]!.text).toContain('Je vends mon appartement à Dijon');
  });

  it('[R23] [R24] une sortie de l’IA hors des champs prévus ou qui prête un financement est refusée : les règles fixes la remplacent, au journal sans texte', async () => {
    const outputs: unknown[] = [
      { category: 'buyer', route: null, city: null, budgetMinEur: null, budgetMaxEur: null, priceEur: null, deadline: null, financing: null, criteria: [], situation: 'famille nombreuse' },
      { category: 'buyer', route: null, city: null, budgetMinEur: null, budgetMaxEur: null, priceEur: null, deadline: null, financing: 'loan_approved', criteria: [] },
    ];
    const qualifier: Qualifier = { qualify: async () => outputs.shift() };
    const t = await setup(qualifier);
    const a = await t.qualification.qualify(await t.form('Je cherche une maison à Talant pour toute la famille.'));
    expect(a).toMatchObject({ category: 'buyer', source: 'rules', financing: null });
    const b = await t.qualification.qualify(await t.form('Nous cherchons un appartement à Dijon, budget 200 000 €.'));
    expect(b).toMatchObject({ source: 'rules', financing: null });
    const entries = await t.journal.all();
    const refused = entries.filter((e) => e.type === 'qualification.ia_refusee').map((e) => (e.data as { rule: string }).rule);
    expect(refused).toEqual(['R23', 'R24']);
    expect(JSON.stringify(entries.filter((e) => e.type.startsWith('qualification')))).not.toMatch(/famille|Talant|Dijon|200 000|example/);
    expect((await verifyChain(entries)).ok).toBe(true);
  });

  it('l’IA en panne ou trop lente : règles fixes, jamais de qualification manquante', async () => {
    const t = await setup({ qualify: async () => Promise.reject(new Error('panne')) });
    expect(await t.qualification.qualify(await t.form('Je souhaite une estimation de ma maison.'))).toMatchObject({ category: 'valuation', source: 'rules' });
  });

  it('la correction de l’agent est gardée et rejoint les cas de test ; un autre agent ne peut pas corriger', async () => {
    const t = await setup();
    const id = await t.form('Bonjour, une question sur le quartier.');
    const q = (await t.qualification.qualify(id))!;
    expect(q.category).toBe('curious');
    // La fiche n'a pas encore d'agent : seule la direction la voit en entier.
    const stranger = { role: 'agent' as const, userId: t.other.id, networkId: t.network.id };
    expect(await t.qualification.correct(t.acces, stranger, q.id, 'buyer', null)).toBe(false);
    const direction = { role: 'direction' as const, userId: 'dir-1', networkId: t.network.id };
    expect(await t.qualification.correct(t.acces, direction, q.id, 'buyer', null)).toBe(true);
    expect(await t.qualification.correctedCases(t.network.id)).toEqual([{ inboundId: id, category: 'buyer', route: null }]);
    // La qualification d'origine reste telle quelle [R17].
    expect(await t.qualification.get(id)).toMatchObject({ category: 'curious' });
  });
});
