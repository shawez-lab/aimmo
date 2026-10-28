import { expect, it } from 'vitest';
import { ActeVente, Echeancier } from '../src/dossiers/index.ts';
import { Commissions, MORNING_REPORT_JOB, RapportMatin, morningReportJob, reportPeriod } from '../src/pilotage/index.ts';
import { PROOF, setupDossier } from './dossiers-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Tout est inventé : agents, vente, montants.
const ACT_PROOF = 'preuves/0b6f1d2e-7777-4a2b-8c3d-000000000001.pdf';
const at9 = (day: string) => new Date(`${day}T08:00:00.000Z`);

it('la période du rapport : du jour ouvré précédent à la veille, week-ends et jours fériés compris', () => {
  expect(reportPeriod('2027-06-15')).toEqual({ from: '2027-06-14', to: '2027-06-14' }); // mardi
  expect(reportPeriod('2027-06-14')).toEqual({ from: '2027-06-11', to: '2027-06-13' }); // lundi
  expect(reportPeriod('2027-05-07')).toEqual({ from: '2027-05-05', to: '2027-05-06' }); // vendredi après l'Ascension
  expect(reportPeriod('2027-03-30')).toEqual({ from: '2027-03-26', to: '2027-03-29' }); // mardi après le lundi de Pâques
});

it('le passage est réglé à 7 h 30, du lundi au vendredi', () => {
  const job = morningReportJob({} as never, {} as never);
  expect([job.name, job.hours, job.minute, job.weekdays]).toEqual([MORNING_REPORT_JOB, [7], 30, [1, 2, 3, 4, 5]]);
});

async function setup() {
  const t = await setupDossier('appartement');
  const echeancier = new Echeancier(t.db, t.acces, t.journal, { now: t.now });
  const commissions = (options: ConstructorParameters<typeof Commissions>[3] = {}) => new Commissions(t.db, t.acces, t.journal, { now: t.now, ...options });
  const compromis = async () => {
    await t.startCompromis();
    t.setClock(at9('2027-03-11'));
    for (const [kind, day] of [['compromis_signe', '2027-03-10'], ['notification_acquereur', '2027-03-11'], ['dia_recue', '2027-03-11'], ['date_limite_pret', '2027-05-10'], ['etat_date_attendu', '2027-05-20'], ['acte_prevu', '2027-06-10']] as const) {
      const r = await echeancier.record(t.agent, t.fileId, { kind, day, proofRef: PROOF });
      if (!r.ok) throw new Error(r.code);
    }
  };
  const acte = async () => {
    const status = await t.pieces.status(t.agent, t.fileId);
    if (!status.ok) throw new Error(status.code);
    for (const piece of status.value.missing) {
      const r = await t.pieces.add(t.agent, t.fileId, { piece, ref: t.upload(), issuedOn: '2027-03-11' });
      if (!r.ok) throw new Error(r.code);
    }
    t.setClock(at9('2027-06-11'));
    const r = await new ActeVente(t.db, t.acces, t.journal, t.storage, { now: t.now }).record(t.agent, t.fileId, { signedOn: '2027-06-10', proofRef: ACT_PROOF });
    if (!r.ok) throw new Error(r.code);
  };
  return { ...t, commissions, compromis, acte };
}



describeWithSqlite('K06 · rapport du matin', () => {
  async function world() {
    const t = await setup();
    const c = t.commissions();
    await c.setGrid(t.direction, { validFrom: '2027-03-01', defaultRateBp: 7000 });
    await t.compromis();
    await c.sync(t.network.id);
    await t.acte();
    await c.sync(t.network.id);
    return { ...t, rapport: new RapportMatin(t.db, t.journal, { now: t.now }) };
  }

  it('[R18, R69] un rapport par lecteur et par jour ouvré, une seule fois ; ses chiffres sont ceux du tableau de bord', async () => {
    const t = await world();
    // Vendredi 11 juin 2027, 7 h 30 à Paris : la veille, l'acte du 10 juin.
    t.setClock(new Date('2027-06-11T05:30:00.000Z'));
    expect(await t.rapport.run(t.network.id)).toBe(3); // la direction, Alex, Sam
    expect(await t.rapport.run(t.network.id)).toBe(0);
    const alex = await t.rapport.read(t.agent);
    expect(alex.ok && alex.value).toMatchObject({ day: '2027-06-11', period: { from: '2027-06-10', to: '2027-06-10' } });
    expect(alex.ok && alex.value!.text.split('\n')).toEqual(['Hier : 0 contact, 0 rendez-vous tenu, 0 mandat signé, 1 vente.', '0 contact chaud à rappeler.', 'Honoraires à venir : 7 000,00 €.']);
    const direction = await t.rapport.read(t.direction);
    expect(direction.ok && direction.value!.text).toMatch(/^Hier : 0 contact, 0 rendez-vous tenu, 0 mandat signé, 1 vente\./);
    // Sam n'a que ses chiffres : ni la vente ni les honoraires d'Alex [R68].
    const sam = await t.rapport.read(t.sam);
    expect(sam.ok && sam.value!.text).not.toMatch(/1 vente|Honoraires/);
    expect(sam.ok && sam.value!.text).toMatch(/0 vente\./);
  });

  it('aucun rapport le week-end ni un jour férié ; le lundi couvre vendredi, samedi et dimanche', async () => {
    const t = await world();
    t.setClock(new Date('2027-06-12T05:30:00.000Z')); // samedi
    expect(await t.rapport.run(t.network.id)).toBe(0);
    t.setClock(new Date('2027-07-14T05:30:00.000Z')); // 14 juillet
    expect(await t.rapport.run(t.network.id)).toBe(0);
    t.setClock(new Date('2027-06-14T05:30:00.000Z')); // lundi
    expect(await t.rapport.run(t.network.id)).toBe(3);
    const alex = await t.rapport.read(t.agent);
    expect(alex.ok && alex.value!.text).toMatch(/^Du 11\/06 au 13\/06 : /);
  });

  it('[R16] la conformité ne lit aucun rapport ; un jour sans rapport rend « rien »', async () => {
    const t = await world();
    expect(await t.rapport.read({ role: 'compliance', networkId: t.network.id, userId: 'c-1' })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.rapport.read(t.agent, '2027-01-04')).toEqual({ ok: true, value: null });
  });
});
