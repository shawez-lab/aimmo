/**
 * Contrôle du texte d'un message, avant tout envoi. Fonctions pures : elles ne lisent ni n'écrivent rien.
 *   R06  aucun texte destiné à un client ne parle de l'IA, hors la mention légale ajoutée par le contrôle ;
 *   R07  « agent immobilier », jamais « mandataire » ; « offert », jamais « gratuit » ;
 *   R08  tutoiement sur Instagram, vouvoiement avec le prénom ailleurs, pas de « Salut » à chaque message,
 *        ni parenthèses ni formules administratives ;
 *   R09  jamais d'adresse exacte ; dans un contenu public, jamais le nom d'un client ;
 *   R10  chaque chiffre vient des données fournies ;
 *   R19  jamais le nom du vendeur d'un bien dans un message à un client ;
 *   question : pas plus de questions que permis, quand l'appelant le dit ;
 *   longueur, par canal.
 */
import type { OutboundChannelName } from '../db/types.ts';

export type TextRule = 'R06' | 'R07' | 'R08' | 'R09' | 'R10' | 'R19' | 'question' | 'length';

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
