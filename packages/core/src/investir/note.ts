/**
 * La note d'investissement (M17, Y05), rédigée par l'IA derrière une interface, avec un secours écrit par le code, à
 * partir du seul calcul (Y03) et de ses contraintes (Y04) [R126].
 *
 * « Jamais vu » : chaque nombre de la note est relié à une ligne du calcul (valeur, source, date, hypothèse), et la note
 * rend, sous chaque paragraphe, la preuve de ses chiffres. Changer une hypothèse (vacance, travaux, loyer bas, central
 * ou haut de l'intervalle) recalcule tout et réécrit la note entière ; la fourchette basse et haute du rendement est
 * toujours montrée à côté du chiffre central. Aucun réseau, logiciel ni outil d'IA grand public ne rend une note
 * d'investissement dont chaque chiffre porte sa preuve.
 *
 * Le code, pas l'IA, écrit ce qui doit y être : l'alerte d'un bien interdit à la location en tête [R124], les chiffres
 * et leur fourchette, la liste des sources et des hypothèses, la mention exacte de l'ANIL et « peu d'observations »
 * quand c'est le cas [R122], et le renvoi à un expert-comptable et à un courtier [R125]. Un paragraphe de l'IA qui porte
 * un nombre absent du calcul, une promesse, un conseil fiscal ou financier personnalisé ou un mot interdit est refusé,
 * et le secours prend le relais. La note n'est montrée au client qu'après validation par l'agent de la fiche [R126].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import { FORBIDDEN_TERMS } from '../annonces/annonce-sourcee.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { plain } from '../envoi/texte.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { StoredCalculation } from './calcul.ts';
import { FINANCING_KEYS, computeYield, type CalculInvestissement, type Sourced, type YieldInputs, type YieldLine, type YieldResult } from './calcul.ts';
import { energyAlertGate, type ConstraintSet, type Contraintes } from './contraintes.ts';
import { ANIL_CITATION } from './loyers.ts';
import type { ProfilInvestisseur } from './profil.ts';

/** La longueur permise d'une note rendue, celle de la base. */
export const MAX_NOTE_LENGTH = 20_000;

/** Le renvoi aux professionnels habilités, écrit par le code dans chaque note [R125]. */
export const PROFESSIONAL_REFERRAL =
  'Ces chiffres ne sont ni un conseil fiscal ni un conseil financier : pour la fiscalité, consultez un expert-comptable ; pour le financement, un courtier en crédit immobilier.';

/** La mention de faible fiabilité du loyer de marché [R122]. */
export const FEW_OBSERVATIONS = 'Peu d’observations : le loyer de marché de cette commune est moins sûr.';

/**
 * Les tournures refusées dans un texte d'investissement : promesses et conseils fiscaux ou financiers personnalisés,
 * liste fermée et volontairement large [R125].
 */
export const FORBIDDEN_INVEST_PHRASES: readonly string[] = [
  'garanti',
  'garantie',
  'garantis',
  'garanties',
  'sans risque',
  'aucun risque',
  'zero risque',
  'assure',
  'assuree',
  'assures',
  'certain',
  'certaine',
  'certitude',
  'sur et certain',
  'placement sur',
  'valeur sure',
  'defiscalisation',
  'defiscaliser',
  'defiscalise',
  'reduction d impot',
  'reductions d impot',
  'avantage fiscal',
  'avantages fiscaux',
  'optimisation fiscale',
  'optimiser vos impots',
  'niche fiscale',
  'credit d impot',
  'pinel',
  'denormandie',
  'lmnp',
  'lmp',
  'deficit foncier',
  'micro foncier',
  'micro bic',
  'vous devriez',
  'vous devez acheter',
  'il faut acheter',
  'achetez',
  'n hesitez pas a acheter',
  'je vous conseille',
  'nous vous conseillons',
  'nous vous recommandons',
  'je vous recommande',
  'a ne pas manquer',
  'affaire en or',
  'enrichir',
  'enrichissement',
  'rentabilite assuree',
  'revenu assure',
  'revenus assures',
  'plus value assuree',
  'votre taux d endettement',
  'votre capacite d emprunt',
  'empruntez',
];

const key = (text: string): string => ` ${plain(text).replace(/[^a-z0-9]+/g, ' ').trim()} `;
const PHRASE_KEYS = FORBIDDEN_INVEST_PHRASES.map((p) => key(p));
const WORD_KEYS = FORBIDDEN_TERMS.map((p) => key(p));

/**
 * AU100 · le financement reste une simulation d'essai de l'agent (H72) : un paragraphe de la note qui en parle, avec ou
 * sans chiffre, est refusé [R125]. Le renvoi au courtier, texte fixe hors des paragraphes, n'est pas lu ici.
 */
const FINANCING_CLAIMS = [' tresorerie ', ' mensualite', ' emprunt', ' credit', ' rembourse', ' cash flow ', ' cashflow', ' autofinanc', ' du pret ', ' un pret ', ' le pret ', ' votre pret ', ' de pret ', ' pret immobilier ', ' prets immobiliers ', ' financement '];
export function financingClaims(text: string): string[] {
  const k = key(text);
  return FINANCING_CLAIMS.filter((w) => k.includes(w)).map((w) => w.trim());
}

/** Les tournures interdites que porte un texte, dans l'ordre de la liste. */
export function forbiddenPhrases(text: string): string[] {
  const k = key(text);
  return [
    ...FORBIDDEN_INVEST_PHRASES.filter((_, i) => k.includes(PHRASE_KEYS[i]!)),
    ...FORBIDDEN_TERMS.filter((_, i) => k.includes(WORD_KEYS[i]!)),
  ];
}

/** Les lignes que la note peut porter : jamais le financement, simulation d'essai gardée pour l'agent (AU100, H72). */
const forNote = (lines: readonly YieldLine[]): YieldLine[] => lines.filter((l) => !FINANCING_KEYS.includes(l.key));

/** Ce que l'IA reçoit : les lignes du calcul et les textes des contraintes, rien sur la personne. */
export interface NoteFacts {
  lines: YieldLine[];
  grossYieldBp: { low: number; central: number; high: number };
  netYieldBp: { low: number; central: number; high: number };
  constraints: string[];
}

/** L'IA qui rédige. Absente, en panne ou refusée par le contrôle : la note de secours du code. */
export interface NoteWriter {
  write(facts: NoteFacts): Promise<{ paragraphs: string[] }>;
}

/** La preuve d'un nombre : la ligne du calcul d'où il vient. */
export interface NumberProof {
  text: string;
  line: string;
  value: number;
  unit: YieldLine['unit'];
  source: string;
  asOf: string;
  hypothesis: string;
}

export interface NoteParagraph {
  text: string;
  proofs: NumberProof[];
}

export type ParagraphProblem = { code: 'nombre_sans_source'; value: string } | { code: 'tournure_interdite'; value: string };

export interface InvestmentNote {
  /** Les alertes à lire avant tout, dans l'ordre [R124]. */
  alerts: string[];
  paragraphs: NoteParagraph[];
  /** Les chiffres clés et leur fourchette, écrits par le code. */
  figures: NoteParagraph[];
  /** Chaque chiffre donné au calcul, avec sa source, sa date et son hypothèse [R126]. */
  sources: { line: string; text: string }[];
  /** Les mentions obligatoires : ANIL, peu d'observations, contraintes. */
  mentions: string[];
  referral: string;
  /** Ce qui a servi à lire les contraintes, pour les relire à chaque remise au client [R124]. */
  context?: { inseeCode: string | null; energyClass: string | null; finalEnergyKwh: number | null };
}

const NUMBER = /(?:[-−]\s?)?(?:\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:,\d+)?|\d+(?:,\d+)?)/g;

/** Un nombre écrit en français, en centièmes (« 3,89 » → 389, « 150 000 » → 15 000 000) ; plus de deux décimales : null. */
function hundredths(text: string): number | null {
  const t = text.replace(/[\s\u00a0\u202f]/g, '');
  const neg = /^[-−]/.test(t);
  const [whole, frac = ''] = t.replace(/^[-−]/, '').split(',');
  if (frac.length > 2) return null;
  const v = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return neg ? -v : v;
}

/** Les valeurs, en centièmes, sous lesquelles une ligne du calcul peut être écrite dans un texte. */
function writtenValues(line: YieldLine): number[] {
  switch (line.unit) {
    case 'cents':
    case 'cents_per_m2':
      // En euros au centime, ou arrondi à l'euro ; le signe compte : une perte n'est jamais écrite comme un gain.
      return [line.value, Math.sign(line.value) * Math.round(Math.abs(line.value) / 100) * 100];
    case 'bp':
      // En pourcentage à deux décimales, ou à une décimale, signe compris.
      return [line.value, Math.sign(line.value) * Math.round(Math.abs(line.value) / 10) * 10];
    case 'm2_hundredths':
      return [line.value, Math.round(line.value / 100) * 100];
    case 'months':
      return [line.value * 100];
  }
}

/** Le membre de phrase qui porte un nombre : coupé aux fins de phrase, points-virgules et virgules suivies d'un espace. */
function clauseAround(text: string, start: number, length: number): { text: string; offset: number } {
  // Coupé aussi aux « et », « ou », « mais », « puis » : chaque montant garde son propre libellé.
  const cut = /[.;!?](?=\s|$)|,(?=\s)|\n|\s(?:et|ou|mais|puis)\s/g;
  let from = 0;
  let to = text.length;
  for (const c of text.matchAll(cut)) {
    const i = c.index ?? 0;
    if (i + c[0].length <= start) from = i + c[0].length;
    else if (i >= start + length) {
      to = i;
      break;
    }
  }
  return { text: text.slice(from, to), offset: from };
}
const LINE_WORDS: { re: RegExp; keys: string[] }[] = [
  // Les tournures précises d'abord : à égale distance, la première l'emporte. « Hors charges » n'est jamais le loyer
  // charges comprises, ni l'inverse ; la provision n'est jamais un loyer (AU099).
  { re: /\bcharges comprises\b/, keys: ['monthlyRentWithCharges'] },
  { re: /\bhors charges\b/, keys: ['monthlyRent', 'annualRent', 'collectedRent'] },
  { re: /\bcharges non recuperables\b/, keys: ['nonRecoverableCharges'] },
  { re: /\b(?:provision|charges recuperables)\b/, keys: ['recoverableCharges'] },
  { re: /\bbruts?\b/, keys: ['grossYieldBp', 'grossYieldBpLow', 'grossYieldBpHigh'] },
  { re: /\bnets?\b/, keys: ['netYieldBp', 'netYieldBpLow', 'netYieldBpHigh', 'netIncome'] },
  { re: /\bfrais\b/, keys: ['acquisitionFees', 'acquisitionFeesRateBp'] },
  { re: /\bprix\b/, keys: ['price'] },
  { re: /\btravaux\b/, keys: ['works'] },
  { re: /\b(?:total|cout|coute|coutera)\b/, keys: ['totalCost'] },
  { re: /\b(?:loyers?|loue|louer|location)\b/, keys: ['monthlyRent', 'annualRent', 'collectedRent', 'marketRentM2', 'marketRentM2Low', 'marketRentM2High'] },
  { re: /\bpercus?\b/, keys: ['collectedRent'] },
  { re: /\bcharges\b/, keys: ['nonRecoverableCharges'] },
  { re: /\btresorerie\b/, keys: ['monthlyCashflow', 'monthlyCashflowLow', 'monthlyCashflowHigh'] },
  { re: /\b(?:mensualites?|remboursements?)\b/, keys: ['loanPayment'] },
  { re: /\b(?:emprunte|empruntes|emprunt|pret|credit|capital)\b/, keys: ['loanCents', 'loanMonths'] },
  { re: /\btaux\b/, keys: ['loanRateBp'] },
  { re: /\bassurance\b/, keys: ['loanInsurance'] },
  { re: /\b(?:taxe|fonciere)\b/, keys: ['propertyTax'] },
  { re: /\brevenus?\b/, keys: ['netIncome'] },
  { re: /\b(?:surface|m2|m²)\b/, keys: ['livingArea'] },
  { re: /\bvacance\b/, keys: ['vacancyMonths'] },
];

/**
 * La place d'un nombre dans une fourchette écrite « de X <unité> à Y <unité> » : `low` pour X, `high` pour Y ; ailleurs
 * `null`, et le nombre ne peut être qu'un chiffre central.
 */
function boundAt(text: string, start: number, length: number): 'low' | 'high' | null {
  const before = plain(text.slice(Math.max(0, start - 40), start));
  const after = plain(text.slice(start + length, start + length + 40));
  const unit = '\\s?(?:%|€\\s?\\/\\s?m²|€\\/m2|€)';
  if (/\bde\s$/.test(before) && new RegExp(`^${unit}\\s+a\\s+(?:[-−]\\s?)?\\d`).test(after)) return 'low';
  if (/\sa\s$/.test(before) && new RegExp(`\\bde\\s+(?:[-−]\\s?)?[\\d\\s,]+${unit}\\s+a\\s$`).test(before)) return 'high';
  return null;
}
const isLow = (key: string): boolean => key.endsWith('Low');
const isHigh = (key: string): boolean => key.endsWith('High');
function boundOk(key: string, bound: 'low' | 'high' | null): boolean {
  if (bound === 'low') return isLow(key);
  if (bound === 'high') return isHigh(key);
  return !isLow(key) && !isHigh(key);
}

/** Les montants d'une ligne du calcul qui valent par mois, et ceux qui valent par an. */
const MONTHLY: readonly string[] = ['monthlyRent', 'monthlyRentWithCharges', 'recoverableCharges', 'loanPayment', 'loanInsurance', 'monthlyCashflow', 'monthlyCashflowLow', 'monthlyCashflowHigh'];
const YEARLY: readonly string[] = ['annualRent', 'collectedRent', 'netIncome', 'nonRecoverableCharges', 'propertyTax'];

/** La période que dit un membre de phrase : « par mois », « mensuel » ; « par an », « annuel » ; sinon `null`. */
function periodOf(clause: string): 'mois' | 'an' | null {
  const p = plain(clause);
  const month = /\b(?:mensuels?|mensuelles?|par mois|chaque mois|\/\s?mois)\b/.test(p);
  const year = /\b(?:annuels?|annuelles?|par an|chaque annee|sur l.annee|\/\s?an)\b/.test(p);
  if (month && year) return null;
  return month ? 'mois' : year ? 'an' : null;
}

/** Les lignes que nomme un membre de phrase ; aucun mot reconnu : `null`. */
function linesNamedBy(clause: string, start: number, length: number, lines: readonly YieldLine[], units: readonly YieldLine['unit'][]): Set<string> | null {
  const p = plain(clause);
  // Le mot le plus proche du nombre, parmi ceux qui nomment une ligne de son unité : « le prix est de 10 000 € » dit le prix.
  const fits = (keys: readonly string[]): boolean => lines.some((l) => keys.includes(l.key) && units.includes(l.unit));
  let best: { d: number; keys: string[] } | null = null;
  for (const w of LINE_WORDS) {
    if (!fits(w.keys)) continue;
    for (const m of p.matchAll(new RegExp(w.re.source, 'g'))) {
      const a = m.index ?? 0;
      const b = a + m[0].length;
      const d = b <= start ? start - b : a >= start + length ? a - (start + length) : 0;
      if (best === null || d < best.d) best = { d, keys: w.keys };
    }
  }
  if (best === null) return null;
  // Une surface, une vacance et un loyer au m² se reconnaissent à leur unité même au milieu d'autres mots.
  return new Set([...best.keys, 'livingArea', 'vacancyMonths', 'marketRentM2', 'marketRentM2Low', 'marketRentM2High']);
}

/** Les sortes de lignes qu'un nombre peut être, d'après l'unité qui le suit. */
function unitsAfter(after: string): YieldLine['unit'][] {
  const u = after.replace(/^[ \u00a0\u202f]+/, '');
  if (/^€\s*(?:\/|par)\s*m(?:²|2)/u.test(u)) return ['cents_per_m2'];
  if (/^(?:€|euros?\b)/u.test(u)) return ['cents'];
  if (/^(?:%|pour ?cent\b)/u.test(u)) return ['bp'];
  if (/^(?:m²|m2\b|mètres? carrés?)/u.test(u)) return ['m2_hundredths'];
  if (/^mois\b/u.test(u)) return ['months'];
  return [];
}

/** Relie chaque nombre d'un paragraphe à une ligne du calcul ; un nombre sans ligne, ou une tournure interdite, est un problème. */
export function traceParagraph(text: string, lines: readonly YieldLine[]): { proofs: NumberProof[]; problems: ParagraphProblem[] } {
  const proofs: NumberProof[] = [];
  const problems: ParagraphProblem[] = [];
  for (const m of text.matchAll(NUMBER)) {
    const h = hundredths(m[0]);
    // L'unité écrite après le nombre dit quelle sorte de ligne il peut être : « % » un rendement ou un taux, « € » un
    // montant, « €/m² » un loyer au m², « m² » une surface, « mois » une vacance. Sans unité, aucune source.
    const after = text.slice((m.index ?? 0) + m[0].length);
    const units = unitsAfter(after);
    // Les mots du membre de phrase disent de quelle ligne il s'agit : « net » n'est jamais le rendement brut, « loyer »
    // jamais les travaux. Un rendement sans « brut » ni « net » n'a pas de source.
    const around = clauseAround(text, m.index ?? 0, m[0].length);
    const clause = around.text;
    const allowed = linesNamedBy(clause, (m.index ?? 0) - around.offset, m[0].length, lines, units);
    const period = periodOf(clause);
    const bound = boundAt(text, m.index ?? 0, m[0].length);
    const line =
      h === null
        ? undefined
        : lines.find(
            (l) =>
              units.includes(l.unit) &&
              writtenValues(l).includes(h) &&
              // Un montant ou un rendement dit toujours ce qu'il est ; une surface, un loyer au m² ou une vacance se
              // reconnaissent à leur unité.
              (allowed === null ? l.unit === 'm2_hundredths' || l.unit === 'cents_per_m2' || l.unit === 'months' : allowed.has(l.key)) &&
              (period === null || !(period === 'mois' ? YEARLY : MONTHLY).includes(l.key)) &&
              // Une borne basse ou haute n'est prouvée que dans une fourchette « de X à Y » ; ailleurs, le chiffre central.
              boundOk(l.key, bound),
          );
    if (!line) problems.push({ code: 'nombre_sans_source', value: m[0] });
    else proofs.push({ text: m[0], line: line.key, value: line.value, unit: line.unit, source: line.source, asOf: line.asOf, hypothesis: line.hypothesis });
  }
  for (const p of forbiddenPhrases(text)) problems.push({ code: 'tournure_interdite', value: p });
  for (const p of financingClaims(text)) problems.push({ code: 'tournure_interdite', value: p });
  return { proofs, problems };
}

const euros = (cents: number): string => {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const c = abs % 100;
  return `${neg ? '−' : ''}${whole}${c === 0 ? '' : `,${String(c).padStart(2, '0')}`} €`;
};
const percent = (bp: number): string => {
  const neg = bp < 0;
  const abs = Math.abs(bp);
  return `${neg ? '−' : ''}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')} %`;
};
const m2 = (h: number): string => `${Math.floor(h / 100)}${h % 100 === 0 ? '' : `,${String(h % 100).padStart(2, '0')}`} m²`;
const day = (iso: string): string => {
  const [y, mo, d] = iso.slice(0, 10).split('-');
  return `${d}/${mo}/${y}`;
};

/** Une ligne du calcul écrite pour un lecteur. */
export function formatLine(line: YieldLine): string {
  switch (line.unit) {
    case 'cents':
      return euros(line.value);
    case 'cents_per_m2':
      return `${euros(line.value)}/m²`;
    case 'bp':
      return percent(line.value);
    case 'm2_hundredths':
      return m2(line.value);
    case 'months':
      return `${line.value} mois`;
  }
}

export const LINE_LABELS: Record<string, string> = {
  price: 'Prix d’achat',
  acquisitionFeesRateBp: 'Taux des frais d’acquisition',
  acquisitionFees: 'Frais d’acquisition',
  works: 'Travaux estimés',
  totalCost: 'Coût total',
  livingArea: 'Surface habitable',
  marketRentM2: 'Loyer de marché au m²',
  marketRentM2Low: 'Loyer de marché au m², bas',
  marketRentM2High: 'Loyer de marché au m², haut',
  monthlyRent: 'Loyer mensuel',
  monthlyRentWithCharges: 'Loyer mensuel charges comprises',
  loanCents: 'Capital emprunté',
  loanRateBp: 'Taux du prêt',
  loanMonths: 'Durée du prêt',
  loanInsurance: 'Assurance du prêt par mois',
  loanPayment: 'Mensualité du prêt',
  monthlyCashflow: 'Trésorerie mensuelle avant impôt',
  monthlyCashflowLow: 'Trésorerie mensuelle, basse',
  monthlyCashflowHigh: 'Trésorerie mensuelle, haute',
  recoverableCharges: 'Provision pour charges récupérables par mois',
  annualRent: 'Loyer annuel',
  vacancyMonths: 'Vacance',
  collectedRent: 'Loyer perçu sur l’année',
  nonRecoverableCharges: 'Charges non récupérables par an',
  propertyTax: 'Taxe foncière par an',
  netIncome: 'Revenu net avant impôt',
  grossYieldBp: 'Rendement brut',
  netYieldBp: 'Rendement net avant impôt',
  grossYieldBpLow: 'Rendement brut, bas',
  grossYieldBpHigh: 'Rendement brut, haut',
  netYieldBpLow: 'Rendement net avant impôt, bas',
  netYieldBpHigh: 'Rendement net avant impôt, haut',
};

const lineOf = (lines: readonly YieldLine[], k: string): YieldLine => {
  const l = lines.find((x) => x.key === k);
  if (!l) throw new Error(`note : ligne ${k} absente du calcul`);
  return l;
};

/** La note de secours, écrite par le code à partir du calcul seul. */
export function fallbackParagraphs(facts: NoteFacts): string[] {
  const l = (k: string) => formatLine(lineOf(facts.lines, k));
  return [
    `Le bien coûte ${l('totalCost')} au total. Le prix est de ${l('price')}, les frais d’acquisition de ${l('acquisitionFees')} et les travaux estimés de ${l('works')}.`,
    facts.lines.some((x) => x.key === 'monthlyRentWithCharges')
      ? `Pour ${l('livingArea')}, le loyer de marché de ${l('marketRentM2')} donne ${l('monthlyRentWithCharges')} par mois charges comprises ; sans la provision de ${l('recoverableCharges')} pour charges récupérables, reversées et non gagnées, le loyer est de ${l('monthlyRent')} par mois, soit un loyer de ${l('annualRent')} par an. Avec ${l('vacancyMonths')} de vacance par an, ${l('nonRecoverableCharges')} de charges non récupérables et ${l('propertyTax')} de taxe foncière, le revenu net avant impôt est de ${l('netIncome')} par an.`
      : `Pour ${l('livingArea')}, le loyer de marché de ${l('marketRentM2')} donne ${l('monthlyRent')} par mois, soit un loyer de ${l('annualRent')} par an. Avec ${l('vacancyMonths')} de vacance par an, ${l('nonRecoverableCharges')} de charges non récupérables et ${l('propertyTax')} de taxe foncière, le revenu net avant impôt est de ${l('netIncome')} par an.`,
  ];
}

/** Les chiffres clés, toujours avec leur fourchette, écrits par le code. */
function figures(facts: NoteFacts): NoteParagraph[] {
  const lines = facts.lines;
  const g = `Rendement brut : ${formatLine(lineOf(lines, 'grossYieldBp'))} (de ${formatLine(lineOf(lines, 'grossYieldBpLow'))} à ${formatLine(lineOf(lines, 'grossYieldBpHigh'))} selon le loyer de marché bas ou haut).`;
  const n = `Rendement net avant impôt : ${formatLine(lineOf(lines, 'netYieldBp'))} (de ${formatLine(lineOf(lines, 'netYieldBpLow'))} à ${formatLine(lineOf(lines, 'netYieldBpHigh'))}).`;
  return [g, n].map((text) => ({ text, proofs: traceParagraph(text, lines).proofs }));
}

/**
 * La note entière, à partir des paragraphes de l'IA (ou du secours) et du calcul : alertes en tête, paragraphes avec
 * leurs preuves, chiffres et fourchette, sources et hypothèses, mentions et renvoi.
 */
export function buildNote(paragraphs: readonly string[], facts: NoteFacts, constraints: ConstraintSet): InvestmentNote {
  const traced = paragraphs.map((text) => ({ text, ...traceParagraph(text, facts.lines) }));
  const given = facts.lines.filter((l) => l.source !== 'calcul');
  const rent = facts.lines.find((l) => l.key === 'marketRentM2');
  const mentions: string[] = [];
  if (rent && rent.source.startsWith(ANIL_CITATION)) mentions.push(ANIL_CITATION + '.');
  if (rent && /peu d.observations/i.test(rent.hypothesis)) mentions.push(FEW_OBSERVATIONS);
  for (const c of constraints.constraints) if (!constraints.alertsFirst.includes(c.text)) mentions.push(c.text);
  return {
    alerts: [...constraints.alertsFirst],
    paragraphs: traced.map(({ text, proofs }) => ({ text, proofs })),
    figures: figures(facts),
    sources: given.map((l) => ({
      line: l.key,
      text: `${LINE_LABELS[l.key] ?? l.key} : ${formatLine(l)}. Source : ${l.source}, au ${day(l.asOf)}. Hypothèse : ${l.hypothesis}.`,
    })),
    mentions,
    referral: PROFESSIONAL_REFERRAL,
  };
}

/** Le texte que le client lira, alertes en tête, la preuve de chaque chiffre sous son paragraphe. */
export function renderNote(note: InvestmentNote): string {
  const proof = (p: NoteParagraph): string =>
    p.proofs.length === 0 ? '' : `\n${p.proofs.map((x) => `  · ${x.text} : ${LINE_LABELS[x.line] ?? x.line}, source ${x.source}, au ${day(x.asOf)} (${x.hypothesis})`).join('\n')}`;
  return [
    ...note.alerts,
    ...note.paragraphs.map((p) => p.text + proof(p)),
    ...note.figures.map((p) => p.text + proof(p)),
    'Sources et hypothèses :',
    ...note.sources.map((s) => `- ${s.text}`),
    ...note.mentions,
    note.referral,
  ].join('\n\n');
}

export type NoteCheck = { ok: true } | { ok: false; rule: 'R124' | 'R125' | 'R126' | 'R122'; code: string };

/** Une ligne dont l'hypothèse est un texte écrit par une personne, pas par le code. */
const isWrittenByHand = (l: YieldLine): boolean => l.source.startsWith('saisi:') || l.source.startsWith('hypothese:');

/**
 * Ce que l'IA reçoit : les lignes du calcul, sans les textes écrits à la main (ils peuvent porter un nom), et les
 * textes des contraintes écrits par le code.
 */
export function factsForWriter(facts: NoteFacts): NoteFacts {
  return { ...facts, lines: facts.lines.map((l) => (isWrittenByHand(l) ? { ...l, source: 'saisi par l’agent', hypothesis: 'saisi par l’agent' } : l)) };
}

/** Le contrôle de la note entière avant de la ranger, puis avant de la montrer [R122, R124, R125, R126]. */
export function checkNote(note: InvestmentNote, text: string, facts: NoteFacts, constraints: ConstraintSet): NoteCheck {
  const gate = energyAlertGate(constraints, text);
  if (!gate.ok) return { ok: false, rule: 'R124', code: gate.code };
  for (const p of [...note.paragraphs, ...note.figures]) {
    const { problems } = traceParagraph(p.text, facts.lines);
    const bad = problems.find((x) => x.code === 'tournure_interdite');
    if (bad) return { ok: false, rule: 'R125', code: 'tournure_interdite' };
    if (problems.length > 0) return { ok: false, rule: 'R126', code: 'nombre_sans_source' };
  }
  if (note.sources.length === 0 || note.sources.some((s) => !/Source : .+Hypothèse : .+/.test(s.text))) return { ok: false, rule: 'R126', code: 'sans_sources' };
  // Tout le texte, alertes, sources, hypothèses et mentions compris, passe la liste des tournures interdites.
  if (forbiddenPhrases(text).length > 0) return { ok: false, rule: 'R125', code: 'tournure_interdite' };
  // Une hypothèse écrite par l'agent ne porte que des nombres du calcul.
  for (const l of facts.lines) {
    if (!isWrittenByHand(l)) continue;
    if (traceParagraph(l.hypothesis, facts.lines).problems.some((x) => x.code === 'nombre_sans_source')) return { ok: false, rule: 'R126', code: 'hypothese' };
  }
  if (!text.includes(PROFESSIONAL_REFERRAL)) return { ok: false, rule: 'R125', code: 'sans_renvoi' };
  const rent = facts.lines.find((l) => l.key === 'marketRentM2');
  if (rent?.source.startsWith(ANIL_CITATION) && !text.includes(ANIL_CITATION)) return { ok: false, rule: 'R122', code: 'sans_mention_anil' };
  if (rent && /peu d.observations/i.test(rent.hypothesis) && !text.includes(FEW_OBSERVATIONS)) return { ok: false, rule: 'R122', code: 'sans_peu_observations' };
  return { ok: true };
}

/** Les hypothèses qu'on peut changer pour recalculer la note entière. */
export interface NoteHypotheses {
  vacancyMonths?: number;
  worksCents?: number;
  /** Le loyer de marché retenu : bas, central ou haut de l'intervalle. */
  rent?: 'low' | 'central' | 'high';
}

/** Les entrées du calcul avec les hypothèses changées ; chaque changement dit son auteur et son hypothèse. */
export function withHypotheses(inputs: YieldInputs, h: NoteHypotheses, actor: string, today: string): YieldInputs | null {
  const out: YieldInputs = { ...inputs };
  const said = (value: number, hypothesis: string): Sourced<number> => ({ value, source: `hypothese:${actor}`, asOf: today, hypothesis });
  if (h.vacancyMonths !== undefined) {
    if (!Number.isInteger(h.vacancyMonths) || h.vacancyMonths < 0 || h.vacancyMonths > 12) return null;
    out.vacancyMonths = said(h.vacancyMonths, `vacance de ${h.vacancyMonths} mois par an, choisie pour la note`);
  }
  if (h.worksCents !== undefined) {
    if (!Number.isSafeInteger(h.worksCents) || h.worksCents < 0 || h.worksCents > 100_000_000_000) return null;
    out.works = said(h.worksCents, 'travaux choisis pour la note');
  }
  if (h.rent !== undefined && h.rent !== 'central' && h.rent !== 'low' && h.rent !== 'high') return null;
  if (h.rent !== undefined) {
    const r = inputs.marketRent;
    if (!r) return null;
    // Le loyer central de la base et son hypothèse restent rangés à part : « central » les rend, même après une borne.
    const central = r.value.originalCentralM2Cents ?? r.value.centralM2Cents;
    const hypothesis = r.value.originalHypothesis ?? r.hypothesis;
    if (h.rent === 'central') {
      out.marketRent = { value: { centralM2Cents: central, lowerM2Cents: r.value.lowerM2Cents, upperM2Cents: r.value.upperM2Cents }, source: r.source, asOf: r.asOf, hypothesis };
    } else {
      const v = h.rent === 'low' ? r.value.lowerM2Cents : r.value.upperM2Cents;
      out.marketRent = {
        value: { centralM2Cents: v, lowerM2Cents: r.value.lowerM2Cents, upperM2Cents: r.value.upperM2Cents, originalCentralM2Cents: central, originalHypothesis: hypothesis },
        source: r.source,
        asOf: r.asOf,
        hypothesis: `${h.rent === 'low' ? 'borne basse' : 'borne haute'} de l’intervalle retenue pour la note${/peu d.observations/i.test(hypothesis) ? ', peu d’observations' : ''}`,
      };
    }
  }
  return out;
}

export interface StoredNote {
  id: string;
  calculationId: string;
  projectId: string;
  origin: 'ia' | 'secours';
  note: InvestmentNote;
  text: string;
  /** L'empreinte du texte, que l'agent renvoie pour valider exactement ce qu'il a lu. */
  textSha256: string;
  status: 'a_valider' | 'validee';
  createdBy: string;
  createdAt: string;
  validatedBy: string | null;
  validatedAt: string | null;
}

interface NoteRow {
  id: string;
  network_id: string;
  calculation_id: string;
  project_id: string;
  origin: 'ia' | 'secours';
  note: string;
  text: string;
  text_sha256: string;
  status: 'a_valider' | 'validee';
  created_by: string;
  created_at: string;
  validated_by: string | null;
  validated_at: string | null;
}

const toStored = (r: NoteRow): StoredNote => ({
  id: r.id,
  calculationId: r.calculation_id,
  projectId: r.project_id,
  origin: r.origin,
  note: JSON.parse(r.note) as InvestmentNote,
  text: r.text,
  textSha256: r.text_sha256,
  status: r.status,
  createdBy: r.created_by,
  createdAt: r.created_at,
  validatedBy: r.validated_by,
  validatedAt: r.validated_at,
});

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export type NoteResult = { ok: true; value: StoredNote } | { ok: false; rule: 'R16' | 'R120' | 'R122' | 'R124' | 'R125' | 'R126'; code: string };

export interface NotesInvestissementOptions {
  writer?: NoteWriter;
  /** Au-delà, l'IA est tenue pour absente et le secours prend le relais. */
  writerTimeoutMs?: number;
  now?: () => Date;
  newId?: () => string;
}

export class NotesInvestissement {
  private readonly writer: NoteWriter | undefined;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly calculs: CalculInvestissement,
    private readonly contraintes: Contraintes,
    private readonly profils: ProfilInvestisseur,
    options: NotesInvestissementOptions = {},
  ) {
    this.writer = options.writer;
    this.timeoutMs = options.writerTimeoutMs ?? 20_000;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /**
   * L'agent de la fiche fait rédiger la note d'un calcul complet pour un projet d'investissement, avec des
   * hypothèses changées s'il le veut : tout est recalculé, la note entière réécrite. Rangée « à valider ».
   */
  async draft(
    acces: Acces,
    viewer: Viewer,
    input: { calculationId: string; projectId: string; hypotheses?: NoteHypotheses; inseeCode?: string | null; energy?: { energyClass?: unknown; finalEnergyKwh?: unknown } },
  ): Promise<NoteResult> {
    const actor = `${String(viewer.role)}:${viewer.userId}`;
    const access = await this.fiche(acces, viewer, input.projectId);
    if (!access.ok) return access;
    const calc = await this.calculs.get(viewer.networkId, input.calculationId);
    if (!calc) return this.refused(viewer, input.projectId, 'unknown');
    if (calc.projectId !== null && calc.projectId !== input.projectId) return this.refused(viewer, input.projectId, 'unknown');
    // Le bien du calcul sous R16, comme au calcul : le sien ou le fichier commun ; un calcul sans bien ni projet, à son auteur.
    if (calc.propertyId !== null) {
      const seen = await acces.readProperty(viewer, calc.propertyId);
      if (!seen.ok) return { ok: false, rule: 'R16', code: seen.code };
    } else if (calc.projectId === null && viewer.role !== 'direction' && calc.createdBy !== actor) return this.refused(viewer, input.projectId, 'not_assigned');
    const today = this.now().toISOString().slice(0, 10);
    const inputs = input.hypotheses ? withHypotheses(calc.inputs, input.hypotheses, actor, today) : calc.inputs;
    if (!inputs) return { ok: false, rule: 'R120', code: 'hypothese' };
    const result: YieldResult = input.hypotheses ? computeYield(inputs, this.now().toISOString(), calc.result.formulaVersion) : calc.result;
    if (result.status !== 'complet') return { ok: false, rule: 'R120', code: 'incomplet' };
    const constraints = await this.constraintsFor(viewer.networkId, calc.propertyId, input.projectId, input.inseeCode ?? null, input.energy);
    const facts: NoteFacts = {
      lines: forNote(result.lines),
      grossYieldBp: result.grossYieldBp,
      netYieldBp: result.netYieldBp,
      constraints: constraints.constraints.map((c) => c.text),
    };

    let origin: 'ia' | 'secours' = 'secours';
    let paragraphs = fallbackParagraphs(facts);
    let refusal: string | null = null;
    if (this.writer) {
      try {
        const written = await this.withTimeout(this.writer.write(factsForWriter(facts)));
        const ps = Array.isArray(written?.paragraphs) ? written.paragraphs.filter((p): p is string => typeof p === 'string' && p.trim() !== '') : [];
        if (ps.length === 0 || ps.length > 8 || ps.some((p) => p.length > 1500)) refusal = 'forme';
        else {
          const problems = ps.flatMap((p) => traceParagraph(p, facts.lines).problems);
          if (problems.length > 0) refusal = problems[0]!.code;
          else {
            paragraphs = ps.map((p) => p.trim());
            origin = 'ia';
          }
        }
      } catch {
        refusal = 'panne';
      }
      if (refusal) {
        await appendEvent(
          this.journal,
          { type: 'investir.note.secours', actor, subject: `project:${input.projectId}`, data: { calculation: calc.id, code: refusal } },
          this.now,
        );
      }
    }
    const context = {
      inseeCode: input.inseeCode ?? null,
      energyClass: typeof input.energy?.energyClass === 'string' ? input.energy.energyClass : null,
      finalEnergyKwh: typeof input.energy?.finalEnergyKwh === 'number' ? input.energy.finalEnergyKwh : null,
    };
    let note: InvestmentNote = { ...buildNote(paragraphs, facts, constraints), context };
    let text = renderNote(note);
    // Une note rendue trop longue pour être rangée : le secours prend le relais, jamais une erreur.
    if (origin === 'ia' && text.length > MAX_NOTE_LENGTH) {
      await appendEvent(this.journal, { type: 'investir.note.secours', actor, subject: `project:${input.projectId}`, data: { calculation: calc.id, code: 'longueur' } }, this.now);
      origin = 'secours';
      note = { ...buildNote(fallbackParagraphs(facts), facts, constraints), context };
      text = renderNote(note);
    }
    const check = checkNote(note, text, facts, constraints);
    if (!check.ok) {
      await appendEvent(this.journal, { type: 'investir.note.refuse', actor, subject: `project:${input.projectId}`, data: { rule: check.rule, code: check.code } }, this.now);
      return check;
    }
    // Le calcul de la note, s'il a changé d'hypothèses, est rangé comme tout calcul : rejouable.
    let calculationId = calc.id;
    if (input.hypotheses) {
      const again = await this.calculs.store(viewer, { propertyId: calc.propertyId, projectId: input.projectId, inputs, result });
      calculationId = again;
    }
    const id = this.newId();
    const createdAt = this.now().toISOString();
    const textSha256 = await sha256Hex(text);
    await this.db.run(
      `INSERT INTO investment_notes (id, network_id, calculation_id, project_id, origin, note, text, text_sha256, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'a_valider', ?, ?)`,
      [id, viewer.networkId, calculationId, input.projectId, origin, JSON.stringify(note), text, textSha256, actor, createdAt],
    );
    await appendEvent(this.journal, { type: 'investir.note', actor, subject: `project:${input.projectId}`, data: { note: id, calculation: calculationId, origin } }, this.now);
    return {
      ok: true,
      value: { id, calculationId, projectId: input.projectId, origin, note, text, textSha256, status: 'a_valider', createdBy: actor, createdAt, validatedBy: null, validatedAt: null },
    };
  }

  /**
   * L'agent de la fiche, et lui seul, valide la note après l'avoir relue. Les contraintes sont recalculées à ce moment :
   * une alerte apparue depuis la rédaction (fiche du bien changée) refuse la validation [R124, R126].
   */
  async validate(
    acces: Acces,
    viewer: Viewer,
    noteId: string,
    input: { textSha256: string; inseeCode?: string | null; energy?: { energyClass?: unknown; finalEnergyKwh?: unknown } },
  ): Promise<NoteResult> {
    const row = await this.db.first<NoteRow>('SELECT * FROM investment_notes WHERE id = ? AND network_id = ?', [noteId, viewer.networkId]);
    if (!row) return this.refused(viewer, noteId, 'unknown');
    if (viewer.role !== 'agent') return this.refused(viewer, row.project_id, 'role');
    const access = await this.fiche(acces, viewer, row.project_id);
    if (!access.ok) return access;
    const seen = await this.propertySeen(acces, viewer, row.calculation_id);
    if (!seen.ok) return seen;
    if (row.status === 'validee') return { ok: true, value: toStored(row) };
    // L'agent valide ce qu'il a lu : le texte exact, par son empreinte.
    if (input.textSha256 !== row.text_sha256) return { ok: false, rule: 'R126', code: 'texte_change' };
    const calc = await this.calculs.get(viewer.networkId, row.calculation_id);
    if (!calc || calc.result.status !== 'complet') return { ok: false, rule: 'R126', code: 'calcul' };
    const constraints = await this.constraintsFor(viewer.networkId, calc.propertyId, row.project_id, input.inseeCode ?? null, input.energy);
    const note = JSON.parse(row.note) as InvestmentNote;
    const facts: NoteFacts = { lines: forNote(calc.result.lines), grossYieldBp: calc.result.grossYieldBp, netYieldBp: calc.result.netYieldBp, constraints: [] };
    const check = checkNote(note, row.text, facts, constraints);
    if (!check.ok) {
      await appendEvent(this.journal, { type: 'investir.note.refuse', actor: `agent:${viewer.userId}`, subject: `project:${row.project_id}`, data: { rule: check.rule, code: check.code, note: noteId } }, this.now);
      return check;
    }
    const at = this.now().toISOString();
    await this.db.run("UPDATE investment_notes SET status = 'validee', validated_by = ?, validated_at = ? WHERE id = ? AND status = 'a_valider'", [
      `agent:${viewer.userId}`,
      at,
      noteId,
    ]);
    await appendEvent(this.journal, { type: 'investir.note.validee', actor: `agent:${viewer.userId}`, subject: `project:${row.project_id}`, data: { note: noteId } }, this.now);
    const after = await this.db.first<NoteRow>('SELECT * FROM investment_notes WHERE id = ?', [noteId]);
    return { ok: true, value: toStored(after!) };
  }

  /** Une note et son état, pour l'agent de la fiche ou la direction [R16]. */
  async read(acces: Acces, viewer: Viewer, noteId: string): Promise<NoteResult> {
    const row = await this.db.first<NoteRow>('SELECT * FROM investment_notes WHERE id = ? AND network_id = ?', [noteId, viewer.networkId]);
    if (!row) return this.refused(viewer, noteId, 'unknown');
    const access = await this.fiche(acces, viewer, row.project_id);
    if (!access.ok) return access;
    // Le bien du calcul se recontrôle aussi : un bien sorti du fichier commun ne se relit plus par sa note [R16].
    const seen = await this.propertySeen(acces, viewer, row.calculation_id);
    if (!seen.ok) return seen;
    return { ok: true, value: toStored(row) };
  }

  private async propertySeen(acces: Acces, viewer: Viewer, calculationId: string): Promise<{ ok: true } | NoteResult> {
    const calc = await this.calculs.get(viewer.networkId, calculationId);
    if (calc?.propertyId) {
      const read = await acces.readProperty(viewer, calc.propertyId);
      if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    }
    return { ok: true };
  }

  /**
   * Ce que le client peut lire : seulement une note validée par l'agent [R126], et seulement si ses alertes tiennent
   * encore : contraintes et profil relus à chaque remise, une interdiction de louer apparue depuis retient la note [R124].
   */
  async forClient(networkId: string, noteId: string): Promise<{ text: string; validatedAt: string } | null> {
    const row = await this.db.first<NoteRow>("SELECT * FROM investment_notes WHERE id = ? AND network_id = ? AND status = 'validee'", [noteId, networkId]);
    if (!row || !row.validated_at) return null;
    const calc = await this.calculs.get(networkId, row.calculation_id);
    const note = JSON.parse(row.note) as InvestmentNote;
    const ctx = note.context ?? { inseeCode: null, energyClass: null, finalEnergyKwh: null };
    const held = async (code: string): Promise<null> => {
      await appendEvent(this.journal, { type: 'investir.note.retenue', actor: 'system:investir', subject: `project:${row.project_id}`, data: { rule: 'R124', code, note: noteId } }, this.now);
      return null;
    };
    if (!calc || calc.result.status !== 'complet') return held('calcul');
    const constraints = await this.constraintsFor(networkId, calc.propertyId, row.project_id, ctx.inseeCode, { energyClass: ctx.energyClass, finalEnergyKwh: ctx.finalEnergyKwh });
    const facts: NoteFacts = { lines: forNote(calc.result.lines), grossYieldBp: calc.result.grossYieldBp, netYieldBp: calc.result.netYieldBp, constraints: [] };
    const check = checkNote(note, row.text, facts, constraints);
    if (!check.ok) return held(check.code);
    return { text: row.text, validatedAt: row.validated_at };
  }

  /**
   * Relire une note depuis l'écran de l'agent (Y14) [R16, R124] : les alertes d'aujourd'hui viennent d'abord, et une note
   * validée dont les contraintes ne tiennent plus est dite retenue, sans son texte, comme à la remise au client.
   */
  async reread(acces: Acces, viewer: Viewer, noteId: string): Promise<{ ok: true; value: { note: StoredNote | null; status: 'a_valider' | 'validee'; createdAt: string; validatedAt: string | null; held: boolean; alertsFirst: string[] } } | Exclude<NoteResult, { ok: true }>> {
    const read = await this.read(acces, viewer, noteId);
    if (!read.ok) return read;
    const n = read.value;
    const calc = await this.calculs.get(viewer.networkId, n.calculationId);
    const ctx = n.note.context ?? { inseeCode: null, energyClass: null, finalEnergyKwh: null };
    const constraints = await this.constraintsFor(viewer.networkId, calc?.propertyId ?? null, n.projectId, ctx.inseeCode, { energyClass: ctx.energyClass, finalEnergyKwh: ctx.finalEnergyKwh });
    let held = false;
    if (n.status === 'validee') {
      if (!calc || calc.result.status !== 'complet') held = true;
      else held = !checkNote(n.note, n.text, { lines: forNote(calc.result.lines), grossYieldBp: calc.result.grossYieldBp, netYieldBp: calc.result.netYieldBp, constraints: [] }, constraints).ok;
    }
    return { ok: true, value: { note: held ? null : n, status: n.status, createdAt: n.createdAt, validatedAt: n.validatedAt, held, alertsFirst: constraints.alertsFirst } };
  }

  /**
   * Relire un calcul rangé d'un projet (Y14) [R16, R124] : ses chiffres n'arrivent jamais sans les alertes d'aujourd'hui.
   * Si les contraintes ne se lisent pas, l'erreur remonte et aucun chiffre ne part. La classe énergie dite à l'écran le
   * jour du calcul n'est pas rangée : sans fiche, elle ressort inconnue, avec son alerte.
   */
  async rereadCalculation(acces: Acces, viewer: Viewer, calculationId: string): Promise<{ ok: true; value: { calculation: StoredCalculation; alertsFirst: string[] } } | { ok: false; rule: 'R16' | 'R120' | 'R122'; code: string }> {
    const read = await this.calculs.read(acces, viewer, calculationId);
    if (!read.ok) return read;
    const calc = read.value;
    // Hors d'un projet, aucun profil ne dit la location visée : cette relecture n'en parle pas.
    if (calc.projectId === null) return { ok: false, rule: 'R16', code: 'not_assigned' };
    const commune = calc.propertyId === null ? null : await this.db.first<{ insee_code: string }>('SELECT insee_code FROM property_communes WHERE property_id = ?', [calc.propertyId]);
    const constraints = await this.constraintsFor(viewer.networkId, calc.propertyId, calc.projectId, commune?.insee_code ?? null, undefined);
    return { ok: true, value: { calculation: calc, alertsFirst: constraints.alertsFirst } };
  }

  /** Les contraintes du bien, avec la location visée du dernier profil de l'investisseur ; inconnue : il veut louer. */
  private async constraintsFor(
    networkId: string,
    propertyId: string | null,
    projectId: string,
    inseeCode: string | null,
    energy: { energyClass?: unknown; finalEnergyKwh?: unknown } | undefined,
  ): Promise<ConstraintSet> {
    const profile = await this.profils.current(projectId);
    const cls = energy?.energyClass;
    const kwh = energy?.finalEnergyKwh;
    return this.contraintes.forProperty({
      networkId,
      propertyId,
      inseeCode,
      energyClass: typeof cls === 'string' && ['A', 'B', 'C', 'D', 'E', 'F', 'G'].includes(cls) ? (cls as 'A') : null,
      finalEnergyKwh: typeof kwh === 'number' ? kwh : null,
      energySource: 'dit par l’agent',
      rentalTarget: profile?.profile.rentalTarget ?? null,
    });
  }

  private async fiche(acces: Acces, viewer: Viewer, projectId: string): Promise<{ ok: true } | NoteResult> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refused(viewer, projectId, 'role');
    const project = await this.db.first<{ person_id: string }>("SELECT person_id FROM projects WHERE id = ? AND network_id = ? AND kind = 'invest'", [projectId, viewer.networkId]);
    if (!project) return this.refused(viewer, projectId, 'unknown');
    const read = await acces.readFiche(viewer, project.person_id);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.view !== 'full') return this.refused(viewer, projectId, 'not_assigned');
    return { ok: true };
  }

  private async withTimeout<T>(p: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([p, new Promise<T>((_, reject) => (timer = setTimeout(() => reject(new Error('délai')), this.timeoutMs)))]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async refused(viewer: Viewer, projectId: string, code: string): Promise<NoteResult> {
    await appendEvent(
      this.journal,
      { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `project:${projectId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'investment_note', code } },
      this.now,
    );
    return { ok: false, rule: 'R16', code };
  }
}
