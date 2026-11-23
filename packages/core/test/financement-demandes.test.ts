import { expect, it } from 'vitest';
import { Echeancier, FinancementDossier, criticalPath, hasLiveOffer, requestLabel, scheduleLines, type PathInput } from '../src/dossiers/index.ts';
import { PROOF, setupDossier } from './dossiers-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// AU083 · Deux banques sur le même dossier : leurs étapes ne se mélangent plus.
const at9 = (day: string) => new Date(`${day}T08:00:00.000Z`);
const facts = { hasLoanCondition: true, isCoownershipLot: true };
const allPieces = { lines: [], missing: [], unknown: [], identity: 'verifiee' as const };
const base = (financing: PathInput['financing'], today = '2027-04-10'): PathInput => ({
  today,
  schedule: scheduleLines({ compromis_signe: '2027-03-10', notification_acquereur: '2027-03-11', dia_recue: '2027-03-12', date_limite_pret: '2027-05-10', acte_prevu: '2027-06-10' }, facts),
  plannedActDay: '2027-06-10',
  pieces: allPieces,
  hasLoanCondition: true,
  financing,
});
const loan = (p: PathInput) => criticalPath('d', p).lines.find((l) => l.item === 'pret') ?? null;

it('[R14] la demande est un nom de banque ou de courtier, jamais un numéro de compte ou de dossier', () => {
  expect(requestLabel('  Banque  du Centre ')).toBe('Banque du Centre');
  expect(requestLabel('Crédit d’Ici & Co.')).toBe('Crédit d’Ici & Co.');
  for (const bad of ['', '   ', 'Dossier 12345', 'FR76 3000', 'x'.repeat(61), 'Banque <b>', 3, null]) expect(requestLabel(bad)).toBeNull();
});

it('le chemin critique : le refus d’une banque ne clôt pas la demande de l’autre', () => {
  // Avant AU083, un refus de la banque B après l'offre de la banque A disait « refus de prêt » pour tout le dossier.
  const mixed = base([
    { step: 'demande_deposee', day: '2027-03-12', demande: 'Banque A' },
    { step: 'demande_deposee', day: '2027-03-12', demande: 'Banque B' },
    { step: 'offre_pret_emise', day: '2027-04-05', demande: 'Banque A' },
    { step: 'refus', day: '2027-04-06', demande: 'banque b' },
  ]);
  expect(loan(mixed)).toEqual({ reason: 'reflexion_offre_pret', item: 'pret', who: 'acquereur', notBefore: '2027-04-16' });
  // Une acceptation de la banque A, après sa réflexion, lève la condition malgré le refus de B.
  expect(loan(base([...mixed.financing, { step: 'offre_pret_acceptee', day: '2027-04-17', demande: 'Banque A' }], '2027-04-18'))).toBeNull();
  // L'acceptation déclarée sur la banque B ne vaut pas pour l'offre de la banque A.
  expect(loan(base([...mixed.financing, { step: 'offre_pret_acceptee', day: '2027-04-17', demande: 'Banque B' }], '2027-04-18'))).toMatchObject({ reason: 'acceptation_offre_attendue' });
  // Un refus de B pendant que A étudie encore : une offre est attendue, pas un refus.
  expect(loan(base([{ step: 'demande_deposee', day: '2027-03-12', demande: 'Banque A' }, { step: 'refus', day: '2027-04-06', demande: 'Banque B' }]))).toMatchObject({ reason: 'offre_pret_attendue' });
  // Toutes les demandes refusées : le prêt est refusé.
  expect(loan(base([{ step: 'refus', day: '2027-04-05', demande: 'Banque A' }, { step: 'refus', day: '2027-04-06', demande: 'Banque B' }]))).toMatchObject({ reason: 'refus_de_pret', notBefore: null });
  // Sans demande dite, une seule suite, comme avant.
  expect(loan(base([{ step: 'offre_pret_emise', day: '2027-04-05' }, { step: 'refus', day: '2027-04-06' }]))).toMatchObject({ reason: 'refus_de_pret' });
});

it('une offre refusée ensuite dans sa demande n’est plus vivante ; l’offre d’une autre demande l’est', () => {
  expect(hasLiveOffer([{ step: 'offre_pret_emise', demande: 'A' }, { step: 'refus', demande: 'A' }])).toBe(false);
  expect(hasLiveOffer([{ step: 'offre_pret_emise', demande: 'A' }, { step: 'refus', demande: 'B' }])).toBe(true);
  expect(hasLiveOffer([{ step: 'offre_pret_emise' }, { step: 'refus' }])).toBe(false);
});

describeWithSqlite('AU083 · deux demandes de financement sur un dossier', () => {
  async function setup() {
    const t = await setupDossier('appartement');
    await t.startCompromis();
    t.setClock(at9('2027-03-10'));
    const e = new Echeancier(t.db, t.acces, t.journal, { now: t.now });
    await e.record(t.agent, t.fileId, { kind: 'compromis_signe', day: '2027-03-10', proofRef: PROOF });
    await e.record(t.agent, t.fileId, { kind: 'date_limite_pret', day: '2027-05-10', proofRef: PROOF });
    return { ...t, fin: new FinancementDossier(t.db, t.acces, t.journal, { now: t.now }) };
  }

  it('chaque étape garde sa demande ; une demande mal dite est refusée, rien n’est rangé', async () => {
    const t = await setup();
    await t.fin.declare(t.agent, t.fileId, { step: 'demande_deposee', day: '2027-03-10', declaredBy: 'courtier', demande: 'Banque A' });
    await t.fin.declare(t.agent, t.fileId, { step: 'demande_deposee', day: '2027-03-10', declaredBy: 'acquereur', demande: 'Banque B' });
    expect(await t.fin.declare(t.agent, t.fileId, { step: 'refus', day: '2027-03-10', declaredBy: 'acquereur', demande: 'Compte 12345678' })).toEqual({ ok: false, rule: null, code: 'bad_request' });
    const f = await t.fin.financing(t.agent, t.fileId);
    expect(f.ok && f.value.steps.map((s) => [s.step, s.demande])).toEqual([['demande_deposee', 'Banque A'], ['demande_deposee', 'Banque B']]);
  });

  it('le refus d’une offre ne laisse pas éteinte l’alerte de la date limite, l’offre d’une autre banque l’éteint', async () => {
    const t = await setup();
    t.setClock(at9('2027-04-20'));
    await t.fin.declare(t.agent, t.fileId, { step: 'offre_pret_emise', day: '2027-04-20', declaredBy: 'acquereur', demande: 'Banque A' });
    t.setClock(at9('2027-04-24'));
    await t.fin.declare(t.agent, t.fileId, { step: 'refus', day: '2027-04-24', declaredBy: 'acquereur', demande: 'Banque A' });
    // Avant AU083, l'offre de A, pourtant retirée, éteignait l'alerte : aucune n'était créée.
    t.setClock(at9('2027-04-25'));
    expect(await t.fin.run(t.network.id)).toBe(2);
    expect(await t.fin.alertsOf(t.agent)).toMatchObject({ ok: true, alerts: [{ kind: 'refus_declare' }, { kind: 'sans_offre_de_pret', day: '2027-05-10' }] });
    // Une offre de la banque B éteint l'alerte de la date limite ; le refus de A reste dit.
    await t.fin.declare(t.agent, t.fileId, { step: 'offre_pret_emise', day: '2027-04-25', declaredBy: 'courtier', demande: 'Banque B' });
    expect(await t.fin.alertsOf(t.agent)).toMatchObject({ ok: true, alerts: [{ kind: 'refus_declare' }] });
    // Puis B refuse aussi : l'alerte de la date limite revient, sans doublon.
    await t.fin.declare(t.agent, t.fileId, { step: 'refus', day: '2027-04-25', declaredBy: 'courtier', demande: 'Banque B' });
    expect(await t.fin.run(t.network.id)).toBe(1);
    const a = await t.fin.alertsOf(t.agent);
    expect(a.ok && a.alerts.map((x) => x.kind).sort()).toEqual(['refus_declare', 'refus_declare', 'sans_offre_de_pret']);
  });
});
