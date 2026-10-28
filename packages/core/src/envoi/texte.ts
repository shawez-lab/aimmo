/**
 * Contrôle du texte d'un message, avant tout envoi. Fonctions pures : elles ne lisent ni n'écrivent rien.
 *   R06  aucun texte destiné à un client ne parle de l'IA, hors la mention légale ajoutée par le contrôle ;
 *   R07  « agent immobilier », jamais « mandataire » ; « offert », jamais « gratuit » ;
 *   R08  tutoiement sur Instagram, vouvoiement avec le prénom ailleurs, pas de « Salut » à chaque message,
 *        ni parenthèses ni formules administratives ;
 *   R09  jamais d'adresse exacte ; dans un contenu public, jamais le nom d'un client ;
 *   R10  chaque chiffre vient des données fournies ;
 *   R19  jamais le nom du vendeur d'un bien dans un message à un client ;
 *   R62  aucun texte à un client ne porte de coordonnée bancaire ni ne demande de payer ;
 *   question : pas plus de questions que permis, quand l'appelant le dit ;
 *   longueur, par canal.
 */
import type { OutboundChannelName } from '../db/types.ts';

export type TextRule = 'R06' | 'R07' | 'R08' | 'R09' | 'R10' | 'R19' | 'R62' | 'question' | 'length';

export interface TextProblem {
  rule: TextRule;
  /** Raison en français, sans citer le texte : elle va au journal [R13]. */
  reason: string;
}

export interface TextContext {
  /** `client` : un message à une personne. `public` : une page, une annonce, une publication. */
  audience: 'client' | 'public';
  /** Canal du message ; absent pour un contenu public. */
  channel?: OutboundChannelName;
  /** Premier message de la conversation : le prénom y est attendu, le « Salut » y est permis. */
  firstOfConversation?: boolean;
  /** Prénom de la personne, s'il est connu. */
  firstName?: string | null;
  /** Chiffres permis : ceux de la base ou d'une source publique citée [R10]. */
  figures?: readonly (string | number)[];
  /** Noms des clients, interdits dans un contenu public [R09]. */
  clientNames?: readonly string[];
  /** Noms et prénoms des vendeurs du bien cité, interdits dans un message à un client [R19]. */
  sellerNames?: readonly string[];
  /** Nombre de questions permis ; absent : pas de limite. */
  maxQuestions?: number;
}

export interface TextSettings {
  /** Longueur maximale par canal, en caractères, mention comprise. */
  maxLength: Readonly<Record<OutboundChannelName, number>> & { public: number };
  /** Formules administratives refusées [R08], en minuscules sans accents. */
  administrativePhrases: readonly string[];
}

export const DEFAULT_TEXT_SETTINGS: TextSettings = Object.freeze({
  maxLength: Object.freeze({ sms: 480, whatsapp: 1000, instagram: 1000, facebook: 1000, phone: 1000, site: 1000, email: 4000, public: 8000 }),
  administrativePhrases: Object.freeze([
    'veuillez agreer',
    'je vous prie',
    'nous vous prions',
    'salutations distinguees',
    'accusons reception',
    'accuse reception',
    'suite a votre demande',
    'dans l\'attente de votre retour',
    'n\'hesitez pas a revenir vers',
    'en vous remerciant par avance',
    'par la presente',
    'ci-joint',
    'ci-dessous',
  ]),
});

/** Minuscules, sans accents, apostrophes droites. */
export function plain(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’`]/g, "'");
}

// « ai » en minuscules est le verbe avoir : seul « AI » en capitales vaut l'abréviation anglaise.
const AI_WORDS = [/\bia\b/i, /\bi\.a\b/i, /\bAI\b/, /\bA\.I\b/, /intelligence artificielle/i, /\bassistant/i, /\bchat ?bot/i, /\brobot/i, /\bGPT/i, /\bautomatiquement\b/i];
const FORBIDDEN_WORDS: [RegExp, string][] = [
  [/\bmandataires?\b/, '« agent immobilier », jamais « mandataire »'],
  [/\bgratuite?s?\b|\bgratuitement\b/, '« offert », jamais « gratuit »'],
];
const FORMAL = /\b(?:vous|votre|vos)\b/;
const INFORMAL = /\b(?:tu|te|toi|ton|ta|tes)\b|\bt'/;
const ADDRESS =
  /\b\d{1,4}\s?(?:bis|ter)?,?\s+(?:rue|avenue|av\.?|boulevard|bd|place|chemin|allee|impasse|route|quai|cours|square|passage|faubourg|rond-point|residence|lotissement)\b/;

/** Les nombres d'un texte, sans séparateurs : « 250 000 € » → 250000, « 82,5 m² » → 82.5. */
export function numbersIn(text: string): string[] {
  const found = text.replace(/[  ]/g, ' ').match(/\d+(?:[ .]\d{3})*(?:,\d+)?/g) ?? [];
  return found.map((n) => n.replace(/[ .]/g, '').replace(',', '.').replace(/^0+(?=\d)/, ''));
}

/** Ce que le texte enfreint ; une liste vide si tout va bien. */
export function checkText(text: string, context: TextContext, settings: TextSettings = DEFAULT_TEXT_SETTINGS): TextProblem[] {
  const problems: TextProblem[] = [];
  const p = plain(text);
  if (text.trim() === '') problems.push({ rule: 'length', reason: 'Texte vide.' });
  const max = context.audience === 'public' ? settings.maxLength.public : settings.maxLength[context.channel ?? 'email'];
  if (text.length > max) problems.push({ rule: 'length', reason: `Texte trop long pour ce canal : ${max} caractères au plus.` });

  if (context.audience === 'client' && AI_WORDS.some((w) => w.test(text))) {
    problems.push({ rule: 'R06', reason: 'Le texte parle de l’IA : seule la mention légale du premier message le fait.' });
  }
  for (const [word, reason] of FORBIDDEN_WORDS) if (word.test(p)) problems.push({ rule: 'R07', reason });

  if (context.audience === 'client') {
    if (context.channel === 'instagram') {
      if (FORMAL.test(p)) problems.push({ rule: 'R08', reason: 'Sur Instagram, on tutoie.' });
    } else if (INFORMAL.test(p)) {
      problems.push({ rule: 'R08', reason: 'Hors d’Instagram, on vouvoie.' });
    }
    if (!context.firstOfConversation && /\bsalut\b/.test(p)) {
      problems.push({ rule: 'R08', reason: 'Pas de « Salut » à chaque message.' });
    }
    const name = context.firstName?.trim();
    if (context.firstOfConversation && context.channel !== 'instagram' && name && !p.includes(plain(name))) {
      problems.push({ rule: 'R08', reason: 'Le premier message s’adresse à la personne par son prénom.' });
    }
  }
  if (context.audience === 'client' && bankDetailsIn(text)) {
    problems.push({ rule: 'R62', reason: 'AIMMO ne donne jamais de coordonnée bancaire.' });
  }
  if (/[()]/.test(text)) problems.push({ rule: 'R08', reason: 'Pas de parenthèses.' });
  if (settings.administrativePhrases.some((phrase) => p.includes(phrase))) {
    problems.push({ rule: 'R08', reason: 'Pas de formule administrative.' });
  }

  if (ADDRESS.test(p)) problems.push({ rule: 'R09', reason: 'Jamais d’adresse exacte.' });
  const mentions = (names: readonly string[] | undefined): boolean =>
    (names ?? [])
      .map((n) => plain(n).trim())
      .filter((n) => n.length > 1)
      .some((n) => new RegExp(`(^|[^a-z])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z])`).test(p));
  if (context.audience === 'public' && mentions(context.clientNames)) {
    problems.push({ rule: 'R09', reason: 'Jamais le nom d’un client dans un contenu public.' });
  }
  if (context.audience === 'client' && mentions(context.sellerNames)) {
    problems.push({ rule: 'R19', reason: 'Jamais le nom du vendeur dans un message à un client.' });
  }
  if (context.maxQuestions !== undefined && (text.match(/\?/g) ?? []).length > context.maxQuestions) {
    problems.push({ rule: 'question', reason: `Pas plus de ${context.maxQuestions} question dans ce message.` });
  }

  const allowed = new Set(
    (context.figures ?? []).flatMap((f) => (typeof f === 'number' || /^\d+(?:\.\d+)?$/.test(f) ? [String(Number(f))] : numbersIn(f))),
  );
  if (numbersIn(text).some((n) => !allowed.has(n))) {
    problems.push({ rule: 'R10', reason: 'Un chiffre du texte ne vient pas des données fournies.' });
  }
  return problems;
}

/**
 * Un IBAN, tel qu'on l'écrit : deux lettres, deux chiffres, puis des groupes de lettres et de chiffres séparés ou non
 * par des espaces, des retours à la ligne, des points ou des tirets ; chaque groupe porte au moins un chiffre, pour ne
 * jamais avaler les mots qui suivent. 14 à 34 caractères utiles.
 */
const IBAN_SOURCE = String.raw`\b[a-z]{2}\d{2}(?:[\s.\-]{0,3}(?=[a-z0-9]*\d)[a-z0-9]{1,11}){1,10}\b`;
/** Un RIB français écrit seul : banque 5 chiffres, guichet 5, compte 11, clé 2. */
const RIB_SOURCE = String.raw`\b\d{5}[\s.\-]{0,3}\d{5}[\s.\-]{0,3}[a-z0-9]{11}[\s.\-]{0,3}\d{2}\b`;
const usefulLength = (m: string): number => m.replace(/[\s.\-]/g, '').length;
export const IBAN = { test: (text: string): boolean => bankNumbers(text).length > 0 };
/** Ce qui remplace un IBAN ou un RIB dans un message reçu rangé : le bouclier (N05) le lit comme un IBAN [R15]. */
export const IBAN_MASK = '[IBAN masqué]';

function bankNumbers(text: string): string[] {
  const found = [...text.matchAll(new RegExp(IBAN_SOURCE, 'gi'))].map((m) => m[0]).filter((m) => usefulLength(m) >= 14 && usefulLength(m) <= 34);
  return [...found, ...[...text.matchAll(new RegExp(RIB_SOURCE, 'gi'))].map((m) => m[0])];
}

/** Le texte, chaque IBAN ou RIB remplacé en entier par `IBAN_MASK`, avant de le ranger [R15]. Le reste ne change pas. */
export function maskIban(text: string): string {
  const masked = text.replace(new RegExp(IBAN_SOURCE, 'gi'), (m) => (usefulLength(m) >= 14 && usefulLength(m) <= 34 ? IBAN_MASK : m));
  return masked.replace(new RegExp(RIB_SOURCE, 'gi'), IBAN_MASK);
}

/**
 * Ce que tout texte à un client refuse [R62] : un IBAN, un RIB, ou les mots RIB, BIC, SWIFT ou IBAN. Les tournures
 * qui demandent de payer sont refusées par `fundsInOutgoing` dans les textes écrits par le code de M10 seulement : dans
 * une dictée, « il faut régler la question du parking » ne demande rien.
 */
export function bankDetailsIn(text: string): boolean {
  return IBAN.test(text) || text.includes(IBAN_MASK) || /\b(?:rib|bic|swift|iban)\b/.test(plain(text));
}

const OUTGOING_FUNDS: RegExp[] = [
  /\b(?:rib|bic|swift|iban)\b/,
  /\b(?:nos|nouvelles|voici les|voici nos|ci-joint nos|ci-joint les) coordonnees bancaires\b/,
  /\b(?:sur le compte|a l'ordre de)\b/,
  /\b(?:veuillez|merci de|vous pouvez|pensez a|il vous faut|vous devez|il faut|je vous prie de|nous vous prions de)\s+(?:bien vouloir\s+)?(?:nous\s+)?(?:virer|verser|regler|payer|transferer|effectuer)\b/,
  // L'impératif direct : « payez », « versez », « virez », « réglez », « effectuez le virement ».
  /\b(?:payez|versez|virez|reglez|transferez|effectuez)\b/,
  /\b(?:le|un|votre) (?:virement|versement|paiement) (?:de|du|des|sur|a|avant)\b/,
];

/** Un texte d'AIMMO qui donne des coordonnées bancaires ou demande un paiement : jamais [R62]. */
export function fundsInOutgoing(text: string): boolean {
  if (bankDetailsIn(text)) return true;
  const p = plain(text);
  return OUTGOING_FUNDS.some((re) => re.test(p));
}
