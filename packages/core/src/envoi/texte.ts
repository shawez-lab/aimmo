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
import { hiddenIbanSpans, seenMapped, unmaskedText } from './iban-detours.ts';
import { wordReadings } from './mots-detours.ts';

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
const STREET =
  /\b\d{1,4}\s?(?:bis|ter)?,?\s+(rue|avenue|av\.?|boulevard|bd|place|chemin|allee|impasse|route|quai|cours|square|passage|faubourg|rond-point|residence|lotissement)\b/gi;
// « 1 place de stationnement », « 1 place couverte », « il reste 1 place libre » : pas une adresse (BR68).
// Lu sur le texte tel qu'écrit, en minuscules seulement : une vraie place se nomme avec une capitale
// (« place Couverte », « place Double », « place Darcy ») ou un article (« place de la Libération »,
// « place aux Herbes ») ; « au » et « en » n'écartent que « au sous-sol » et ses pareils.
const PARKING_SPACE =
  /^(?:\s*(?:[.,;:!?)]|$)|\s+(?:de\s+|d')?(?:stationnement|parking|garage|velo|moto|voiture|box)\b|\s+(?:couverte|privative|privee|exterieure|interieure|souterraine|attitree|numerotee|nominative|double|libre|disponible|pour|dans|et|ou|(?:en|au)\s+(?:sous-sol|exterieur|interieur|rez-de-chaussee))(?![\p{L}\p{N}-]))/u;

/** Une adresse exacte dans le texte [R09] : un numéro suivi d'une voie, sauf une place de stationnement. */
function hasAddress(text: string): boolean {
  const t = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’`]/g, "'").replace(/[\u00a0\u202f]/g, ' ');
  for (const m of t.matchAll(STREET)) {
    if (m[1]!.toLowerCase() !== 'place' || !PARKING_SPACE.test(t.slice(m.index + m[0].length))) return true;
  }
  return false;
}

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
  if (context.audience === 'client' && (bankDetailsIn(text) || paymentRequestIn(text))) {
    problems.push({ rule: 'R62', reason: 'AIMMO ne demande jamais de paiement et ne donne jamais de coordonnée bancaire.' });
  }
  if (/[()]/.test(text)) problems.push({ rule: 'R08', reason: 'Pas de parenthèses.' });
  if (settings.administrativePhrases.some((phrase) => p.includes(phrase))) {
    problems.push({ rule: 'R08', reason: 'Pas de formule administrative.' });
  }

  if (hasAddress(text)) problems.push({ rule: 'R09', reason: 'Jamais d’adresse exacte.' });
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

  // Une suite de chiffres fournie en texte (référence, empreinte) se compare chiffre pour chiffre, sans passer par un
  // nombre : au-delà de seize chiffres, un nombre l'arrondirait et le texte qui la cite serait refusé à tort (AU118).
  const allowed = new Set(
    (context.figures ?? []).flatMap((f) =>
      typeof f === 'string' && /^\d+$/.test(f) ? [f.replace(/^0+(?=\d)/, '')] : typeof f === 'number' || /^\d+\.\d+$/.test(f) ? [String(Number(f))] : numbersIn(f),
    ),
  );
  if (numbersIn(text).some((n) => !allowed.has(n))) {
    problems.push({ rule: 'R10', reason: 'Un chiffre du texte ne vient pas des données fournies.' });
  }
  return problems;
}

/**
 * Un IBAN, tel qu'on l'écrit : deux lettres, deux chiffres, puis des groupes de lettres et de chiffres séparés ou non
 * par des espaces, des retours à la ligne, des points ou des tirets (trois au plus d'affilée) ; 14 à 34 caractères
 * utiles, dont au moins 10 chiffres. Il est cherché par un parcours linéaire, jamais par une expression qui pourrait
 * s'emballer sur un texte reçu de l'extérieur. Parmi les fins possibles, la plus longue dont la clé (modulo 97) est
 * juste l'emporte ; à défaut, la plus longue dont le dernier groupe porte un chiffre et dont seuls les deux premiers
 * groupes peuvent être sans chiffre (code de banque) : les mots qui suivent ne sont jamais avalés.
 */
const isAlnum = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9]/.test(c);
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';
const isLetter = (c: string | undefined): boolean => c !== undefined && /[A-Za-z]/.test(c);
const isSep = (c: string | undefined): boolean => c !== undefined && /[\s.\-]/.test(c);

function mod97(chars: string): boolean {
  const s = (chars.slice(4) + chars.slice(0, 4)).toUpperCase();
  let r = 0;
  for (const ch of s) {
    const v = isDigit(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of v) r = (r * 10 + Number(d)) % 97;
  }
  return r === 1;
}

/** Les plages `[début, fin[` des IBAN du texte. */
function ibanSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  let i = 0;
  while (i < text.length - 3) {
    if (isAlnum(text[i - 1]) || !isLetter(text[i]) || !isLetter(text[i + 1]) || !isDigit(text[i + 2]) || !isDigit(text[i + 3])) {
      i += 1;
      continue;
    }
    let chars = text.slice(i, i + 4);
    let digits = 2;
    let j = i + 4;
    let group = 0;
    let groupHasDigit = true;
    let lettersOnlyLate = false;
    let best: number | null = null;
    let fallback: number | null = null;
    while (j <= text.length && chars.length <= 34) {
      // Une fin de groupe : la place d'une fin possible.
      if (!isAlnum(text[j])) {
        if (group > 0 && !groupHasDigit && group > 2) lettersOnlyLate = true;
        const ok = chars.length >= 14 && digits >= 10;
        if (ok && mod97(chars)) best = j;
        if (ok && groupHasDigit && !lettersOnlyLate) fallback = j;
        let k = j;
        while (k < text.length && k - j < 3 && isSep(text[k])) k += 1;
        if (k === j && j < text.length && !isSep(text[j])) break;
        if (!isAlnum(text[k])) break;
        j = k;
        group += 1;
        groupHasDigit = false;
        continue;
      }
      chars += text[j];
      if (isDigit(text[j])) {
        digits += 1;
        groupHasDigit = true;
      }
      j += 1;
    }
    const end = best ?? fallback;
    if (end !== null) {
      spans.push([i, end]);
      i = end;
    } else {
      i += 1;
    }
  }
  return spans;
}

/** Un RIB français écrit seul : banque 5 chiffres, guichet 5, compte 11, clé 2 ; longueurs fixes, sans emballement. */
const RIB = /\b\d{5}[\s.\-]{0,3}\d{5}[\s.\-]{0,3}[A-Za-z0-9]{11}[\s.\-]{0,3}\d{2}\b/g;
export const IBAN = { test: (text: string): boolean => maskIban(text) !== text };
/** Ce qui remplace un IBAN ou un RIB dans un message reçu rangé : le bouclier (N05) le lit comme un IBAN [R15]. */
export const IBAN_MASK = '[IBAN masqué]';

/** Un identifiant tiré au hasard (UUID), qui n'est jamais un IBAN : il est mis à part avant toute recherche. */
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

function maskPart(part: string): string {
  // BR106 : toutes les plages sont cherchées sur le texte d'origine, puis réunies, avant de rien remplacer : un IBAN
  // mêlant chiffres ordinaires et chiffres dictés ou pleine chasse est masqué en entier, jamais son début seul [R15].
  const spans: [number, number][] = [...ibanSpans(part)];
  for (const m of part.matchAll(RIB)) spans.push([m.index, m.index + m[0].length]);
  spans.push(...hiddenIbanSpans(part));
  // BR107 : un IBAN ou un RIB écrit d'un bloc mais coupé d'invisibles ou de sosies est cherché dans le texte tel que
  // l'œil le voit, puis rendu à sa plage d'origine [R15].
  const seen = seenMapped(part);
  if (seen.text !== part) {
    const back = (a: number, b: number): [number, number] => [seen.start[a]!, seen.end[b - 1]!];
    for (const [a, b] of ibanSpans(seen.text)) spans.push(back(a, b));
    for (const m of seen.text.matchAll(RIB)) spans.push(back(m.index, m.index + m[0].length));
  }
  spans.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let out = '';
  let at = 0;
  let open: [number, number] | null = null;
  for (const [a, b] of spans) {
    if (open !== null && a < open[1]) {
      open[1] = Math.max(open[1], b);
      continue;
    }
    if (open !== null) {
      out += part.slice(at, open[0]) + IBAN_MASK;
      at = open[1];
    }
    open = [a, b];
  }
  if (open !== null) {
    out += part.slice(at, open[0]) + IBAN_MASK;
    at = open[1];
  }
  return out + part.slice(at);
}

/**
 * Le texte, chaque IBAN ou RIB remplacé en entier par `IBAN_MASK`, avant de le ranger [R15], épelé, dicté en mots ou
 * déguisé par des sosies compris (BR106). Le reste ne change pas.
 */
export function maskIban(text: string): string {
  const uuids = text.match(UUID) ?? [];
  return text
    .split(UUID)
    .map(maskPart)
    .reduce((acc, part, i) => acc + (i > 0 ? uuids[i - 1]! : '') + part, '');
}

/**
 * Une demande de payer, dans tout texte à un client [R62] : un verbe de paiement suivi, à quelques mots, de ce qui se
 * paie (somme, montant, acompte, frais, solde, dépôt, honoraires, une somme en euros), ou « effectuer le virement ».
 * « Il faut régler la question du parking » ou « effectuer des travaux » ne demandent rien.
 */
const PAYMENT_REQUEST: RegExp[] = [
  /\b(?:payer|payez|verser|versez|virer|virez|regler|reglez|transferer|transferez|acquitter|acquittez)\b(?:\s+\S+){0,4}?\s+(?:la somme|le montant|un montant|l'acompte|un acompte|les frais|des frais|vos frais|le solde|le depot|un depot|les honoraires|vos honoraires|\d[\d\s.,]*(?:€|euros?\b))/,
  /\b(?:effectuer|faire|effectuez|faites)\s+(?:le|un|votre|ce)\s+(?:virement|versement|paiement)\b/,
];

/**
 * BR107 : le texte sans accents ni majuscules, et aussi tel que l'œil le voit quand il diffère (« RΙΒ », « vir\u200bement »,
 * « 𝐈𝐁𝐀𝐍 ») : une règle d'argent lit les deux [R62]. BR109 : et ses lectures épelées ou sans le leet (« R.I.B »,
 * « R1B », « R 1 B », « P@yez »), voir `mots-detours.ts`.
 */
function readings(text: string): string[] {
  const seen = unmaskedText(text);
  const base = seen === text ? [plain(text)] : [plain(text), plain(seen)];
  // BR109 : aussi les mots épelés, le leet et le leet épelé, lus sur le texte démasqué comme le bouclier les lit.
  return [...new Set([...base, ...wordReadings(plain(seen))])];
}

export function paymentRequestIn(text: string): boolean {
  return readings(text).some((p) => PAYMENT_REQUEST.some((re) => re.test(p)));
}

export function bankDetailsIn(text: string): boolean {
  return IBAN.test(text) || text.includes(IBAN_MASK) || readings(text).some((p) => /\b(?:rib|bic|swift|iban)\b/.test(p));
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
  // Comme `bankDetailsIn` puis les règles de sortie, les lectures faites une seule fois (BR109).
  if (IBAN.test(text) || text.includes(IBAN_MASK)) return true;
  return readings(text).some((p) => OUTGOING_FUNDS.some((re) => re.test(p)));
}
