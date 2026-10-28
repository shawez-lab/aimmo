import { describe, expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, verifyChain, type SqlDatabase } from '../src/index.ts';
import { Candidatures, checkRecruitingText } from '../src/reseau/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, agents et candidats inventés.
let clock = Date.parse('2027-07-01T08:00:00.000Z');

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const candidatures = new Candidatures(db, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const other = await store.createNetwork('Autre réseau');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const as = (role: 'agent' | 'direction' | 'compliance', userId = alex.id) => ({ role, userId, networkId: network.id });
  return { db, journal, store, candidatures, network, other, alex, as };
}

const OK = {
  firstName: 'Camille',
  lastName: 'Candidate',
  email: 'camille@example.test',
  phone: '06 11 22 33 44',
  town: 'Dijon',
  currentStatus: 'salarie_immobilier',
  experience: 'de_2_a_5_ans',
  question: 'Comment se passe la formation au départ ?',
  source: 'video',
  contactConsent: { given: true, proof: 'case cochée sur la page de candidature' },
};

describe('J01 · textes de recrutement', () => {
  const refused = [
    'Gagnez votre liberté avec AIMMO',
    'Revenus garantis dès le premier mois',
    'Jusqu’à 10 000 € de commissions',
    'Touchez 5 000 €/mois',
    'Devenez riche dans l’immobilier',
    'La liberté financière vous attend',
    'Nos agents gagnent en moyenne plus que les autres',
    'Un complément de revenu idéal',
    'Doublez vos revenus en un an',
    '60 000 € par an pour nos meilleurs agents',
    '3 000 euros nets dès le troisième mois',
    'Un chiffre d’affaires garanti',
    'Des gains à la hauteur de vos efforts',
    'Faites fortune avec nous',
    'Rejoignez les millionnaires de l’immobilier',
    'Visez 10k chaque mois',
    'Argent facile, sans effort',
    'Mille euros de prime de bienvenue',
    'Votre réussite assurée',
    'Revenus illimités pour les ambitieux',
    'Touchez 5000 par mois',
    'Jusqu’à 8 000 par mois',
    'Encaissez 100 000 par an',
    'Un revenu mensuel de 4000',
    'Vous toucherez 4000 net chaque mois',
    'Atteindre 8000 mensuels',
    'Des revenus à six chiffres',
  ];
  const allowed = [
    'Aucun pack mensuel : 0 € pour travailler avec le système',
    'Gagnez du temps sur l’administratif et signez plus de mandats',
    'Au moins 70 % de chaque commission pour l’agent dès sa première vente, selon la grille écrite',
    'Deux jours de formation à l’entrée, puis une séance en direct chaque semaine',
    'Un référent pendant vos 90 premiers jours',
    'L’essai de 30 jours est sans frais, et vous êtes libre de partir avec un mois de préavis',
    'Les résultats mesurés à Dijon sont publiés mois par mois',
    'Un gain de temps sur chaque dossier',
    'Vous restez libre de votre organisation et de vos horaires',
    'La grille de partage des commissions est la même pour tous',
    'L’académie vous aide à gagner des mandats et à gagner en autonomie',
    'Une séance en ligne chaque mois, une rencontre par région chaque trimestre',
    'Un préavis de 1 mois de préavis la première année, 14 heures de formation par an',
    '2 jours de formation chaque mois au début',
  ];

  it('[R80] 27 promesses de revenus refusées, 14 textes honnêtes acceptés', () => {
    for (const t of refused) expect(checkRecruitingText(t), t).toMatchObject({ ok: false, rule: 'R80' });
    for (const t of allowed) expect(checkRecruitingText(t), t).toEqual({ ok: true });
  });

  it('[R80] un montant écrit autrement est vu, avec la raison', () => {
    expect(checkRecruitingText('Commission moyenne : 4 500 €')).toEqual({ ok: false, rule: 'R80', reasons: ['amount'] });
    expect(checkRecruitingText('€ 2 500 dès le premier mandat')).toEqual({ ok: false, rule: 'R80', reasons: ['amount'] });
    expect(checkRecruitingText('GAGNEZ 2000 EUR')).toEqual({ ok: false, rule: 'R80', reasons: ['promise', 'amount'] });
  });
});

describeWithSqlite('J01 · candidature', () => {
  it('[R81] la table des candidatures n’a aucun champ de note, de score, de rang ni de priorité', async () => {
    const t = await setup();
    const cols = (await t.db.all<{ name: string }>("SELECT name FROM pragma_table_info('candidates')")).map((c) => c.name);
    expect(cols.length).toBeGreaterThan(10);
    for (const c of cols) expect(c).not.toMatch(/score|note|rank|rang|grade|rating|priorit|level|niveau|tri|sort|order/i);
    expect(await t.candidatures.apply(t.network.id, { ...OK, score: 4 })).toEqual({ ok: false, rule: 'R81', code: 'unknown_field' });
    expect(await t.candidatures.apply(t.network.id, { ...OK, rank: 1 })).toEqual({ ok: false, rule: 'R81', code: 'unknown_field' });
    expect(await t.db.all('SELECT id FROM candidates')).toEqual([]);
  });

  it('[R81] la direction lit les candidatures dans l’ordre d’arrivée, et rien d’autre ne les trie', async () => {
    const t = await setup();
    const names = ['Zoé', 'Adam', 'Marc', 'Inès'];
    for (const [i, firstName] of names.entries()) {
      expect(
        await t.candidatures.apply(t.network.id, { ...OK, firstName, email: `c${i}@example.test`, phone: undefined, experience: i % 2 ? 'aucune' : 'plus_de_5_ans' }),
      ).toEqual({ ok: true, value: { recorded: true } });
    }
    const list = await t.candidatures.list(t.as('direction'));
    expect(list.ok && list.value.map((c) => c.firstName)).toEqual(names);
    expect(list.ok && list.value[0]).toMatchObject({ town: 'Dijon', source: 'video', contactable: true, currentStatus: 'salarie_immobilier' });
    // Un agent, ou la conformité, ne lit pas les candidatures [R16].
    expect(await t.candidatures.list(t.as('agent'))).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.candidatures.list(t.as('compliance'))).toEqual({ ok: false, rule: 'R16', code: 'role' });
    // Un autre réseau ne voit rien.
    expect(await t.candidatures.list({ role: 'direction', userId: 'd', networkId: t.other.id })).toEqual({ ok: true, value: [] });
  });

  it('[R18] une même coordonnée ne fait qu’une candidature, avec la même réponse ; rien d’une coordonnée au journal [R13]', async () => {
    const t = await setup();
    expect(await t.candidatures.apply(t.network.id, OK)).toEqual({ ok: true, value: { recorded: true } });
    // Même mail écrit autrement, puis même téléphone avec un autre mail.
    expect(await t.candidatures.apply(t.network.id, { ...OK, email: ' CAMILLE@example.test ', phone: undefined })).toEqual({ ok: true, value: { recorded: true } });
    expect(await t.candidatures.apply(t.network.id, { ...OK, email: 'autre@example.test', phone: '+33 6 11 22 33 44' })).toEqual({ ok: true, value: { recorded: true } });
    expect(await t.db.all('SELECT email, phone FROM candidates')).toEqual([{ email: 'camille@example.test', phone: '+33611223344' }]);
    // Ailleurs, la même personne peut candidater à un autre réseau.
    expect(await t.candidatures.apply(t.other.id, OK)).toEqual({ ok: true, value: { recorded: true } });
    const entries = await t.journal.all();
    expect(entries.filter((e) => e.type === 'candidature.deja_rangee')).toHaveLength(2);
    expect(JSON.stringify(entries)).not.toMatch(/[cC]amille|Candidate|example\.test|33611|formation au départ|Dijon/);
    expect((await verifyChain(entries)).ok).toBe(true);
  });

  it('[R03] sans accord, la candidature est rangée mais ne peut pas être recontactée ; un accord sans preuve est refusé', async () => {
    const t = await setup();
    expect(await t.candidatures.apply(t.network.id, { ...OK, contactConsent: { given: false } })).toEqual({ ok: true, value: { recorded: true } });
    expect(await t.candidatures.apply(t.network.id, { ...OK, email: 'b@example.test', phone: undefined, contactConsent: { given: true, proof: ' ' } })).toEqual({ ok: false, rule: 'R03', code: 'bad_proof' });
    expect(await t.candidatures.apply(t.network.id, { ...OK, email: 'c@example.test', phone: undefined, contactConsent: { given: 'oui' } })).toEqual({ ok: false, rule: 'R03', code: 'bad_consent' });
    const list = await t.candidatures.list(t.as('direction'));
    expect(list.ok && list.value.map((c) => c.contactable)).toEqual([false]);
    const id = list.ok ? list.value[0]!.id : '';
    expect(await t.candidatures.contactable(t.network.id, id)).toBe(false);
    expect(await t.candidatures.contactable(t.other.id, id)).toBe(false);
  });

  it('les saisies invalides sont refusées sans rien ranger ; un parrain inconnu est ignoré ; rien ne s’efface ni ne change [R17]', async () => {
    const t = await setup();
    const n = t.network.id;
    expect(await t.candidatures.apply(n, { ...OK, email: undefined, phone: undefined })).toMatchObject({ ok: false, code: 'no_contact' });
    expect(await t.candidatures.apply(n, { ...OK, email: 'pas un mail' })).toMatchObject({ ok: false, code: 'bad_email' });
    expect(await t.candidatures.apply(n, { ...OK, phone: '12' })).toMatchObject({ ok: false, code: 'bad_phone' });
    expect(await t.candidatures.apply(n, { ...OK, firstName: '' })).toMatchObject({ ok: false, code: 'bad_first_name' });
    expect(await t.candidatures.apply(n, { ...OK, currentStatus: 'roi' })).toMatchObject({ ok: false, code: 'bad_status' });
    expect(await t.candidatures.apply(n, { ...OK, question: 'x'.repeat(1001) })).toMatchObject({ ok: false, code: 'bad_question' });
    expect(await t.candidatures.apply(n, [])).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(await t.candidatures.apply('inconnu', OK)).toEqual({ ok: false, rule: null, code: 'unknown_network' });
    expect(await t.db.all('SELECT id FROM candidates')).toEqual([]);

    await t.candidatures.apply(n, { ...OK, source: 'parrain', sponsorAgentId: t.alex.id });
    await t.candidatures.apply(n, { ...OK, email: 'd@example.test', phone: undefined, source: 'parrain', sponsorAgentId: 'personne' });
    expect(await t.db.all('SELECT sponsor_agent_id FROM candidates ORDER BY created_at')).toEqual([{ sponsor_agent_id: t.alex.id }, { sponsor_agent_id: null }]);
    await expect(t.db.run('DELETE FROM candidates')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run("UPDATE candidates SET town = 'Beaune'")).rejects.toThrow(/ne change plus/);
  });
});
