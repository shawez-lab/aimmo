import { expect, it } from 'vitest';
import { fundSignals } from '../src/dossiers/index.ts';
import type { FundSignal } from '../src/dossiers/index.ts';
import { expectLinear } from './lineaire.ts';

// RC66 : les détours d'écriture et de langue de la fraude au faux RIB. Textes inventés.

it('[R62] un faux RIB écrit lettre par lettre alerte quand même', () => {
  const cases: [string, FundSignal][] = [
    ['Merci de nous transmettre votre R.I.B avant vendredi', 'coordonnees_bancaires'],
    ['Voici notre R I B mis à jour', 'coordonnees_bancaires'],
    ['Notre r-i-b a changé', 'coordonnees_bancaires'],
    ['Notre r.i.b a changé', 'coordonnees_bancaires'],
    ['Notre r i b a changé', 'coordonnees_bancaires'],
    ['Il y a r i b joint', 'coordonnees_bancaires'],
    ['à i b a n', 'coordonnees_bancaires'],
    ['Utilisez ce I.B.A.N.', 'coordonnees_bancaires'],
    ['Faites le v i r e m e n t ce soir', 'virement'],
    ['Le s.é.q.u.e.s.t.r.e est sur ce compte', 'sequestre'],
  ];
  for (const [t, s] of cases) expect([t, fundSignals(t)]).toEqual([t, expect.arrayContaining([s])]);
});

it('[R62] la banque changée, la domiciliation et les références bancaires alertent', () => {
  const cases: [string, FundSignal][] = [
    ['Notre domiciliation bancaire a changé', 'coordonnees_bancaires'],
    ['Nous avons changé de banque, utilisez les nouvelles références bancaires', 'coordonnees_bancaires'],
    ['L’étude change de banque à compter de lundi', 'coordonnees_bancaires'],
    ['Nous changeons de banque', 'coordonnees_bancaires'],
    ['Voici nos informations bancaires', 'coordonnees_bancaires'],
    ['Les détails bancaires sont joints', 'coordonnees_bancaires'],
    ['Coordonnées du compte mises à jour', 'coordonnees_bancaires'],
    ['Merci d’utiliser notre nouvelle banque', 'coordonnees_bancaires'],
  ];
  for (const [t, s] of cases) expect([t, fundSignals(t)]).toEqual([t, expect.arrayContaining([s])]);
});

it('[R62] le dépôt chiffré, le transfert et l’envoi de la somme alertent', () => {
  const cases: [string, FundSignal][] = [
    ['Le dépôt de 10 % doit être fait aujourd’hui', 'acompte'],
    ['Un dépôt de 15 000 € est attendu', 'acompte'],
    ['Faites le transfert aujourd’hui svp', 'virement'],
    ['Le transfert doit partir avant midi', 'virement'],
    ['Merci d’envoyer l’argent ce soir', 'virement'],
    ['Envoyez la somme au plus vite', 'virement'],
    ['Merci d’envoyer le montant demandé', 'virement'],
  ];
  for (const [t, s] of cases) expect([t, fundSignals(t)]).toEqual([t, expect.arrayContaining([s])]);
});

it('[R62] le chèque et les moyens de paiement de détour alertent', () => {
  for (const t of [
    'Les frais de notaire sont à envoyer par chèque',
    'Vous pouvez régler par Wero',
    'Un envoi par PayPal suffira',
    'Faites-le par Lydia',
    'Passez par Western Union',
    'Un mandat cash à l’agence',
    'Achetez des cartes cadeaux pour le montant',
    'Le paiement en bitcoin est accepté',
    'Nous acceptons la cryptomonnaie',
    'Merci de procéder au règlement',
  ]) expect([t, fundSignals(t)]).toEqual([t, expect.arrayContaining(['paiement'])]);
});

it('[R62] l’anglais des escrocs alerte', () => {
  const cases: [string, FundSignal][] = [
    ['Please wire the deposit to our new bank account', 'virement'],
    ['Please wire the deposit to our new bank account', 'acompte'],
    ['Please wire the deposit to our new bank account', 'coordonnees_bancaires'],
    ['Our bank details have changed', 'coordonnees_bancaires'],
    ['Send the funds to this account number', 'coordonnees_bancaires'],
    ['Sort code and routing number attached', 'coordonnees_bancaires'],
    ['Make the transfer today', 'virement'],
    ['The payment is due today, please pay now', 'paiement'],
  ];
  for (const [t, s] of cases) expect([t, fundSignals(t)]).toEqual([t, expect.arrayContaining([s])]);
});

it('[R62] aucune fausse alerte sur les phrases d’usage de la vente', () => {
  for (const t of [
    'Le transfert de propriété a lieu le jour de l’acte',
    'Le transfert des risques suit la signature',
    'Le transfert du bail est prévu',
    'Le dépôt du dossier en mairie est fait',
    'Le dépôt des pièces au coffre est fini',
    'Le règlement de copropriété est joint',
    'Le fonds de commerce n’est pas concerné',
    'La banque a donné son accord de prêt',
    'La visite est confirmée pour samedi, à bientôt',
    'Je passe à l’agence à 14 h',
    'Il y a un a b c d du diagnostic à relire',
    'Le payeur des charges est le syndic',
    'Le wifi de la maison marche bien',
  ]) expect([t, fundSignals(t)]).toEqual([t, []]);
});

// Un mail de 40 000 caractères, fait de lettres espacées, ne fait pas s'emballer la lecture. La mesure compare la
// machine à elle-même (`lineaire.ts`) : une machine lente ou chargée ne fait pas tomber l'essai, un emballement si.
it('[R62] une longue suite de lettres espacées se lit vite', () => {
  expectLinear((n) => `${'a '.repeat(n / 4)}b1 ${'x.'.repeat(n / 4)}`, fundSignals);
});
