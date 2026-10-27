import { expect, it } from 'vitest';
import { Echeancier, FINANCING_STEPS, FinancementDossier } from '../src/dossiers/index.ts';
import { PROOF, setupDossier } from './dossiers-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';
import { readFileSync } from 'node:fs';
import { migrationsDir } from './migrations.ts';

const at9 = (day: string) => new Date(`${day}T08:00:00.000Z`);

it('[R14] le financement suivi ne porte ni note, ni score, ni montant : une liste fermée d’étapes déclarées', () => {
  // Le schéma, sans ses commentaires : aucune colonne ni valeur de note.
  const sql = readFileSync(`${migrationsDir}0304_financement_dossier.sql`, 'utf8').replace(/--.*$/gm, '').toLowerCase();
  expect(sql).not.toMatch(/score|note |rating|solvab|amount|montant|rate|taux|revenu|income/);
  expect(FINANCING_STEPS).toEqual(['demande_deposee', 'accord_principe', 'offre_pret_emise', 'offre_pret_acceptee', 'refus']);
});

describeWithSqlite('N04 · suivi du financement déclaré', () => {
  async function setup(offerPatch: Record<string, unknown> = {}) {
    const t = await setupDossier('appartement', offerPatch);
    await t.startCompromis();
    t.setClock(at9('2027-03-10'));
    const e = new Echeancier(t.db, t.acces, t.journal, { now: t.now });
    await e.record(t.agent, t.fileId, { kind: 'compromis_signe', day: '2027-03-10', proofRef: PROOF });
    await e.record(t.agent, t.fileId, { kind: 'date_limite_pret', day: '2027-05-10', proofRef: PROOF });
    return { ...t, e, fin: new FinancementDossier(t.db, t.acces, t.journal, { now: t.now }) };
  }

  it('[R14] seules les étapes de la liste, déclarées par l’acquéreur ou son courtier, sont rangées ; tout champ en plus est refusé', async () => {
    const t = await setup();
    const ok = await t.fin.declare(t.agent, t.fileId, { step: 'demande_deposee', day: '2027-03-10', declaredBy: 'courtier' });
    expect(ok).toEqual({ ok: true, value: { fileId: t.fileId, hasLoanCondition: true, steps: [{ step: 'demande_deposee', day: '2027-03-10', declaredBy: 'courtier', recordedAt: t.now().toISOString() }] } });
    for (const extra of [{ score: 3 }, { amountEur: 150000 }, { solvable: true }, { note: 'bon dossier' }]) {
      expect(await t.fin.declare(t.agent, t.fileId, { step: 'accord_principe', day: '2027-03-10', declaredBy: 'acquereur', ...extra })).toEqual({ ok: false, rule: null, code: 'bad_input' });
    }
    expect(await t.fin.declare(t.agent, t.fileId, { step: 'dossier_solide', day: '2027-03-10', declaredBy: 'acquereur' })).toEqual({ ok: false, rule: null, code: 'unknown_step' });
    expect(await t.fin.declare(t.agent, t.fileId, { step: 'accord_principe', day: '2027-03-10', declaredBy: 'banque' })).toEqual({ ok: false, rule: null, code: 'bad_input' });
    expect(await t.fin.declare(t.agent, t.fileId, { step: 'accord_principe', day: '2027-02-30', declaredBy: 'acquereur' })).toEqual({ ok: false, rule: null, code: 'bad_day' });
    expect(await t.fin.declare(t.agent, t.fileId, { step: 'accord_principe', day: '2027-03-11', declaredBy: 'acquereur' })).toEqual({ ok: false, rule: null, code: 'future_day' });
    // Ce qui est rendu : des faits déclarés, aucune clé de note.
    const f = await t.fin.financing(t.agent, t.fileId);
    expect(JSON.stringify(f)).not.toMatch(/score|note|solvab|rang|rank/i);
    await expect(t.db.run('DELETE FROM sale_file_financing')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run("UPDATE sale_file_financing SET step = 'refus'")).rejects.toThrow(/rien ne change/);
  });

  it('l’alerte part une fois avant la date limite sans offre de prêt, et s’éteint quand l’offre est déclarée', async () => {
    const t = await setup();
    // 26 avril : 14 jours avant le 10 mai, mais rien avant le 25.
    t.setClock(at9('2027-04-24'));
    expect(await t.fin.run(t.network.id)).toBe(0);
    t.setClock(at9('2027-04-25'));
    expect(await t.fin.run(t.network.id)).toBe(1);
    expect(await t.fin.run(t.network.id)).toBe(0);
    t.setClock(at9('2027-04-26'));
    expect(await t.fin.run(t.network.id)).toBe(0);
    expect(await t.fin.alertsOf(t.agent)).toMatchObject({ ok: true, alerts: [{ kind: 'sans_offre_de_pret', day: '2027-05-10' }] });
    await t.fin.declare(t.agent, t.fileId, { step: 'offre_pret_emise', day: '2027-04-26', declaredBy: 'acquereur' });
    expect(await t.fin.alertsOf(t.agent)).toEqual({ ok: true, alerts: [] });
    t.setClock(at9('2027-04-27'));
    expect(await t.fin.run(t.network.id)).toBe(0);
  });

  it('un refus déclaré alerte l’agent aussitôt, une fois ; une date limite déplacée donne sa propre alerte', async () => {
    const t = await setup();
    t.setClock(at9('2027-03-20'));
    await t.fin.declare(t.agent, t.fileId, { step: 'refus', day: '2027-03-19', declaredBy: 'courtier' });
    expect(await t.fin.run(t.network.id)).toBe(1);
    expect(await t.fin.run(t.network.id)).toBe(0);
    expect(await t.fin.alertsOf(t.agent)).toMatchObject({ ok: true, alerts: [{ kind: 'refus_declare', day: '2027-03-19' }] });
    t.setClock(at9('2027-04-28'));
    expect(await t.fin.run(t.network.id)).toBe(1);
    // La date limite est prorogée par avenant : l'ancienne alerte ne compte plus, une nouvelle viendra à son heure.
    await t.e.record(t.agent, t.fileId, { kind: 'date_limite_pret', day: '2027-06-10', proofRef: PROOF });
    const a = await t.fin.alertsOf(t.agent);
    expect(a.ok && a.alerts.map((x) => x.kind)).toEqual(['refus_declare']);
    t.setClock(at9('2027-05-26'));
    expect(await t.fin.run(t.network.id)).toBe(1);
  });

  it('sans condition de prêt dans l’offre, rien ne se range ni n’alerte', async () => {
    // Une offre comptant, sans condition de prêt.
    const t = await setup({ conditions: [], loanEur: 0, downPaymentEur: 205000 });
    expect(await t.fin.declare(t.agent, t.fileId, { step: 'demande_deposee', day: '2027-03-10', declaredBy: 'acquereur' })).toEqual({ ok: false, rule: null, code: 'no_loan_condition' });
    t.setClock(at9('2027-05-01'));
    expect(await t.fin.run(t.network.id)).toBe(0);
  });

  it('[R16] seul l’agent du dossier range ; direction et conformité lisent ; les alertes à l’agent du bien seul', async () => {
    const t = await setup();
    const compliance = { role: 'compliance' as const, networkId: t.network.id, userId: 'c-1' };
    for (const v of [t.direction, compliance]) {
      expect(await t.fin.declare(v, t.fileId, { step: 'demande_deposee', day: '2027-03-10', declaredBy: 'acquereur' })).toEqual({ ok: false, rule: 'R16', code: 'role' });
      expect(await t.fin.financing(v, t.fileId)).toMatchObject({ ok: true });
    }
    expect(await t.fin.financing(t.sam, t.fileId)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.fin.alertsOf(t.direction)).toEqual({ ok: false, rule: 'R16', code: 'not_agent' });
    t.setClock(at9('2027-05-01'));
    await t.fin.run(t.network.id);
    expect(await t.fin.alertsOf(t.sam)).toEqual({ ok: true, alerts: [] });
    await t.db.run('UPDATE properties SET agent_id = ? WHERE id = ?', [t.sam.userId, t.propertyId]);
    expect(await t.fin.alertsOf(t.agent)).toEqual({ ok: true, alerts: [] });
    expect(await t.fin.run(t.network.id)).toBe(1);
    expect(await t.fin.alertsOf(t.sam)).toMatchObject({ ok: true, alerts: [{ kind: 'sans_offre_de_pret' }] });
  });
});
