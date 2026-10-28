/**
 * Contrôle des textes de recrutement (M14, J01) [R80].
 *
 * Aucun texte de recrutement, de parrainage ou de réponse à un candidat ne promet un revenu, un gain ni un montant par
 * mois ou par an. Lecture prudente : une liste fermée de tournures, et tout montant en euros autre que zéro, sont
 * refusés ; un pourcentage seul (la part de l'agent dans une grille écrite) n'est pas une promesse de revenu.
 * Une décision pure, sans base ni IA : le même texte reçoit toujours la même réponse.
 */

export type RecruitingCheck = { ok: true } | { ok: false; rule: 'R80'; reasons: RecruitingReason[] };
export type RecruitingReason = 'promise' | 'amount';

/** Sans accents, en minuscules, apostrophes et espaces unifiés. */
const plain = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('fr')
    .replace(/[’‘`´]/g, "'")
    .replace(/[\u00a0\u202f\u2009]/g, ' ');

/**
 * Les tournures qui promettent un revenu ou un gain. « Gagner » est refusé sous toutes ses formes, sauf « gagner du
 * temps » : un texte de recrutement ne parle pas de ce que l'agent gagnera.
 */
const PROMISES: readonly RegExp[] = [
  /\bgagn\w*\b(?!\s+(?:du|de|en)\s+temps)/,
  /\bgains?\b(?!\s+de\s+temps)/,
  /\brevenus?\s+(?:garanti|assure|illimite|passif|confortable|eleve|important|record|stable|regulier|complementaire|fixe)s?\b/,
  /\b(?:salaire|remuneration|commissions?|chiffre d'affaires)\s+(?:garanti|assure|illimite|minimum|record)e?s?\b/,
  /\bcomplement\s+de\s+revenus?\b/,
  /\b(?:double[rz]?|triple[rz]?|multipliez|multiplier|augmente[rz]?|boostez|explosez)\s+(?:vos|ton|tes|votre|ses|son|les|leurs?)\s+(?:revenus?|gains?|salaires?|commissions?|remunerations?)\b/,
  /\bdevene?z?\s+riches?\b/,
  /\b(?:liberte|independance|securite)\s+financiere\b/,
  /\bfortune\b/,
  /\bmillionnaires?\b/,
  /\bargent\s+facile\b/,
  /\brevenus?\s+de\s+\d/,
  /\bjusqu'(?:a|au)\s+\d[\d\s.,]*\s*(?:k\b|k?€|euros?\b|eur\b)/,
  /\b(?:sans\s+effort|riche\s+rapidement|vivre\s+de\s+vos\s+rentes)\b/,
  /\b(?:rentabilite|reussite)\s+(?:assuree|garantie)\b/,
];

/** Un montant en euros, écrit en chiffres : « 5 000 € », « 3000 euros », « 60 k€ », « 10k », « € 2 500 ». */
const AMOUNTS: readonly RegExp[] = [/(\d[\d\s.,]*)\s*(?:k\s*€|k\s*euros?\b|k\b|€|euros?\b|eur\b)/g, /€\s*(\d[\d\s.,]*)/g];
/** Un montant écrit en lettres, suivi d'euros : « mille euros », « dix mille euros ». */
const WORD_AMOUNT = /\b(?:un|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|vingt|trente|quarante|cinquante|cent|cents|mille|million|millions)\s+(?:\w+\s+){0,3}?euros?\b/;

const nonZero = (digits: string): boolean => /[1-9]/.test(digits);

export function checkRecruitingText(text: string): RecruitingCheck {
  const t = plain(text);
  const reasons: RecruitingReason[] = [];
  if (PROMISES.some((re) => re.test(t))) reasons.push('promise');
  let amount = WORD_AMOUNT.test(t);
  for (const re of AMOUNTS) {
    for (const m of t.matchAll(re)) if (nonZero(m[1] ?? '')) amount = true;
  }
  if (amount) reasons.push('amount');
  return reasons.length === 0 ? { ok: true } : { ok: false, rule: 'R80', reasons };
}

export function promisesIncome(text: string): boolean {
  return !checkRecruitingText(text).ok;
}
