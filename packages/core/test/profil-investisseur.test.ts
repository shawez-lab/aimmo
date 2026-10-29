import { expect, it } from 'vitest';
import { Acces, SqlJournalStore, applyMigrations, createCaptation, fromSyncSqlite, verifyChain, type SqlDatabase } from '../src/index.ts';
import {
  PROFILE_COLUMNS,
  PROFILE_FIELDS,
  ProfilInvestisseur,
  SOLVENCY_TERMS,
  checkProfileChanges,
  isSolvencyTerm,
} from '../src/investir/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const TUESDAY_10H = Date.parse('2026-12-08T09:00:00.000Z');

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = TUESDAY_10H;
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const { chaine, store, fiche, attribution } = createCaptation(db, journal, { now, withQualification: true });
  const acces = new Acces(db, store, fiche, journal, { now });
  const profils = new ProfilInvestisseur(db, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  await attribution.addZone(network.id, alex.id, 'Talant');
  await attribution.addZone(network.id, sam.id, 'Dijon');
  let seq = 0;
  /** Un formulaire inventé, passé par toute la chaîne ; rend la qualification et son projet. */
  const contact = async (who: string, message: string) => {
    seq += 1;
    await chaine.receive(network.id, 'site_form', { submissionId: `f-${seq}`, firstName: who, email: `${who.toLowerCase()}@example.test`, message });
    return (await db.first<{ id: string; project_id: string | null; inbound_id: string }>(
      'SELECT id, project_id, inbound_id FROM qualifications ORDER BY rowid DESC LIMIT 1',
    ))!;
  };
  const invest = async (who = 'Inès') => {
    const q = await contact(who, 'Bonjour, je souhaite investir dans un appartement à Talant pour le louer, budget 150 000 €, d’ici 3 mois.');
    const p = await db.first<{ kind: string }>('SELECT kind FROM projects WHERE id = ?', [q.project_id]);
    expect(p?.kind).toBe('invest');
    return q;
  };
  const as = (role: 'agent' | 'direction' | 'compliance' | 'partner', userId: string) => ({ role, userId, networkId: network.id });
  const count = async (sql: string, params: (string | number | null)[] = []) => Number((await db.first<{ n: number }>(sql, params))!.n);
  return { db, journal, acces, profils, network, alex, sam, contact, invest, as, count };
}

it('[R123] un champ de revenus, d’emploi, de patrimoine, de crédit ou de solvabilité est refusé et nommé comme tel', () => {
  for (const key of ['income', 'monthlyIncome', 'revenus', 'salary', 'employer', 'employment', 'patrimoine', 'netWorth', 'savings', 'loanAmount', 'credit', 'creditScore', 'solvency', 'debtRatio', 'borrowing_capacity', 'bank']) {
    expect(checkProfileChanges({ [key]: 1 }), key).toEqual({ ok: false, rule: 'R123', code: 'solvabilite' });
  }
  // Même mêlé à des champs permis, le profil entier est refusé.
  expect(checkProfileChanges({ budgetCents: 15_000_000, income: 4000 })).toMatchObject({ ok: false, code: 'solvabilite' });
  for (const field of PROFILE_FIELDS) expect(isSolvencyTerm(field), field).toBe(false);
  expect(SOLVENCY_TERMS.length).toBeGreaterThan(20);
});

it('un champ inconnu ou une valeur hors liste est refusé, jamais ignoré', () => {
  expect(checkProfileChanges({ budgetCents: 15_000_000, color: 'bleu' })).toEqual({ ok: false, rule: 'R123', code: 'champ_inconnu' });
  expect(checkProfileChanges({ rentalTarget: 'saisonnier' })).toMatchObject({ ok: false, code: 'hors_liste', field: 'rentalTarget' });
  expect(checkProfileChanges({ deadline: 'demain' })).toMatchObject({ ok: false, code: 'hors_liste', field: 'deadline' });
  expect(checkProfileChanges({ sectors: ['21617', 'Talant'] })).toMatchObject({ ok: false, code: 'hors_liste', field: 'sectors' });
  expect(checkProfileChanges({ sectors: '21617' })).toMatchObject({ ok: false, code: 'valeur', field: 'sectors' });
  expect(checkProfileChanges({ budgetCents: 150_000.5 })).toMatchObject({ ok: false, code: 'valeur', field: 'budgetCents' });
  expect(checkProfileChanges({ budgetCents: '15000000' })).toMatchObject({ ok: false, code: 'valeur', field: 'budgetCents' });
  expect(checkProfileChanges({ targetGrossYieldBp: 10_001 })).toMatchObject({ ok: false, code: 'valeur', field: 'targetGrossYieldBp' });
  expect(checkProfileChanges({ declaredDownPaymentCents: -1 })).toMatchObject({ ok: false, code: 'valeur', field: 'declaredDownPaymentCents' });
  expect(checkProfileChanges({})).toMatchObject({ ok: false, code: 'valeur' });
  expect(checkProfileChanges(null)).toMatchObject({ ok: false, code: 'valeur' });
  expect(checkProfileChanges(['budgetCents'])).toMatchObject({ ok: false, code: 'valeur' });
  expect(
    checkProfileChanges({
      budgetCents: 15_000_000,
      declaredDownPaymentCents: 3_000_000,
      rentalTarget: 'furnished',
      sectors: ['21617', '21231', '21617', '2A004'],
      targetGrossYieldBp: 650,
      deadline: 'within_3_months',
    }),
  ).toEqual({
    ok: true,
    value: {
      budgetCents: 15_000_000,
      declaredDownPaymentCents: 3_000_000,
      rentalTarget: 'furnished',
      sectors: ['21617', '21231', '2A004'],
      targetGrossYieldBp: 650,
      deadline: 'within_3_months',
    },
  });
});

describeWithSqlite('Y01 · profil investisseur', () => {
  it('[R123] la table n’a aucune colonne de revenus, d’emploi, de patrimoine, de crédit ni de solvabilité', async () => {
    const t = await setup();
    const cols = (await t.db.all<{ name: string }>("SELECT name FROM pragma_table_info('investor_profiles')")).map((c) => c.name);
    expect(cols.sort()).toEqual([...PROFILE_COLUMNS].sort());
    for (const c of cols) expect(isSolvencyTerm(c), c).toBe(false);
  });

  it('la qualification remplit seulement ce que le message dit, avec sa source, une seule fois [R10]', async () => {
    const t = await setup();
    const q = await t.invest();
    await Promise.all([t.profils.fromQualification(q.id), t.profils.fromQualification(q.id)]);
    const p = await t.profils.current(q.project_id!);
    expect(p).not.toBeNull();
    expect(p!.version).toBe(1);
    expect(p!.profile).toEqual({
      budgetCents: 15_000_000,
      declaredDownPaymentCents: null,
      rentalTarget: null,
      sectors: [],
      targetGrossYieldBp: null,
      deadline: 'within_3_months',
    });
    expect(p!.sources).toEqual({ budgetCents: `qualification:${q.id}`, deadline: `qualification:${q.id}` });
    expect(await t.count('SELECT count(*) AS n FROM investor_profiles')).toBe(1);
  });

  it('une qualification d’acheteur ordinaire ne crée aucun profil investisseur', async () => {
    const t = await setup();
    const q = await t.contact('Hugo', 'Je cherche une maison à Talant, budget 300 000 €.');
    expect(await t.profils.fromQualification(q.id)).toBeNull();
    expect(await t.count('SELECT count(*) AS n FROM investor_profiles')).toBe(0);
  });

  it('[R17] une version ne change plus, la suivante la remplace ; chaque champ porte sa source', async () => {
    const t = await setup();
    const q = await t.invest();
    await t.profils.fromQualification(q.id);
    const alex = t.as('agent', t.alex.id);
    const r1 = await t.profils.update(t.acces, alex, q.project_id!, { rentalTarget: 'furnished', sectors: ['21617'] }, 'client_dit');
    expect(r1).toMatchObject({ ok: true, created: true });
    const r2 = await t.profils.update(t.acces, alex, q.project_id!, { budgetCents: 17_000_000, targetGrossYieldBp: 600 });
    expect(r2).toMatchObject({ ok: true, created: true });
    // Rien ne change : aucune version.
    expect(await t.profils.update(t.acces, alex, q.project_id!, { budgetCents: 17_000_000 })).toMatchObject({ ok: true, created: false });

    const read = await t.profils.read(t.acces, alex, q.project_id!);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.history.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(read.value.history[0]!.profile.budgetCents).toBe(15_000_000);
    expect(read.value.current!.profile).toMatchObject({ budgetCents: 17_000_000, rentalTarget: 'furnished', sectors: ['21617'], targetGrossYieldBp: 600, deadline: 'within_3_months' });
    expect(read.value.current!.sources).toEqual({
      budgetCents: `agent:${t.alex.id}`,
      rentalTarget: `client_dit:${t.alex.id}`,
      sectors: `client_dit:${t.alex.id}`,
      targetGrossYieldBp: `agent:${t.alex.id}`,
      deadline: `qualification:${q.id}`,
    });

    const first = read.value.history[0]!.id;
    await expect(t.db.run('UPDATE investor_profiles SET budget_cents = 1 WHERE id = ?', [first])).rejects.toThrow(/ne se réécrit pas/);
    await expect(t.db.run('DELETE FROM investor_profiles WHERE id = ?', [first])).rejects.toThrow(/rien ne s'efface/);

    // Une qualification rejouée plus tard ne remplace pas ce que l'agent a écrit.
    await t.profils.fromQualification(q.id);
    expect((await t.profils.current(q.project_id!))!.profile.budgetCents).toBe(17_000_000);
  });

  it('un champ de solvabilité ou inconnu est refusé au journal, sans la valeur, et rien n’est rangé [R123, R13]', async () => {
    const t = await setup();
    const q = await t.invest();
    const alex = t.as('agent', t.alex.id);
    expect(await t.profils.update(t.acces, alex, q.project_id!, { monthlyIncome: 3210, budgetCents: 15_000_000 })).toMatchObject({ ok: false, rule: 'R123', code: 'solvabilite' });
    expect(await t.profils.update(t.acces, alex, q.project_id!, { favouriteColour: 'vert' })).toMatchObject({ ok: false, code: 'champ_inconnu' });
    expect(await t.profils.update(t.acces, alex, q.project_id!, { budgetCents: 15_000_000 }, 'voisin')).toMatchObject({ ok: false, rule: 'R10', code: 'source' });
    expect(await t.count('SELECT count(*) AS n FROM investor_profiles')).toBe(0);
    const events = (await t.journal.all()).filter((e) => e.type === 'investir.profil.refuse');
    expect(events.map((e) => (e.data as { code: string }).code)).toEqual(['solvabilite', 'champ_inconnu', 'source']);
    for (const e of events) {
      const data = JSON.stringify(e.data);
      expect(data).not.toContain('3210');
      expect(data).not.toContain('vert');
      expect(data).not.toContain('15000000');
    }
  });

  it('[R16] un autre agent est refusé, au journal ; la conformité lit sans écrire ; un autre réseau ne voit rien', async () => {
    const t = await setup();
    const q = await t.invest();
    await t.profils.fromQualification(q.id);
    const sam = t.as('agent', t.sam.id);
    expect(await t.profils.read(t.acces, sam, q.project_id!)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.profils.update(t.acces, sam, q.project_id!, { budgetCents: 1_000_000 })).toMatchObject({ ok: false, rule: 'R16' });
    const refused = (await t.journal.all()).filter((e) => e.type === 'acces.refuse' && e.actor === `agent:${t.sam.id}`);
    expect(refused.length).toBeGreaterThanOrEqual(2);
    expect(refused.some((e) => JSON.stringify(e.data).includes('15000000'))).toBe(false);

    const compliance = t.as('compliance', 'conf-1');
    expect(await t.profils.update(t.acces, compliance, q.project_id!, { budgetCents: 1_000_000 })).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.profils.update(t.acces, t.as('partner', 'p-1'), q.project_id!, { budgetCents: 1_000_000 })).toMatchObject({ ok: false, rule: 'R16' });
    expect((await t.profils.current(q.project_id!))!.profile.budgetCents).toBe(15_000_000);

    expect(await t.profils.read(t.acces, { role: 'agent', userId: t.alex.id, networkId: 'autre-reseau' }, q.project_id!)).toMatchObject({ ok: false, rule: 'R16', code: 'unknown' });
    // La direction écrit, et l'agent de la fiche lit la nouvelle version.
    expect(await t.profils.update(t.acces, t.as('direction', 'dir-1'), q.project_id!, { rentalTarget: 'none' })).toMatchObject({ ok: true, created: true });
    const read = await t.profils.read(t.acces, t.as('agent', t.alex.id), q.project_id!);
    expect(read.ok && read.value.current!.sources.rentalTarget).toBe('direction:dir-1');
    expect((await verifyChain(await t.journal.all())).ok).toBe(true);
  });

  it('un projet qui n’est pas un investissement est refusé', async () => {
    const t = await setup();
    const q = await t.contact('Hugo', 'Je cherche une maison à Talant, budget 300 000 €.');
    expect(await t.profils.update(t.acces, t.as('agent', t.alex.id), q.project_id!, { budgetCents: 1_000_000 })).toMatchObject({ ok: false, rule: 'R16', code: 'unknown' });
  });
});
