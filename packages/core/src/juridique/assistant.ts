/**
 * L'assistant juridique de l'agent (HX03) : l'agent pose une question juridique ou réglementaire, l'assistant répond.
 *
 * « Jamais vu » : chaque réponse cite son texte de loi, son article et sa date, et dit si la version citée a été
 * vérifiée et quand. Quand aucun texte de la bibliothèque ne couvre la question, ou quand elle porte sur un litige,
 * l'assistant répond « je ne sais pas, voyez votre avocat » au lieu d'inventer [R250, R253]. Les assistants des
 * logiciels d'agence répondent de mémoire, sans dire d'où vient la réponse.
 *
 * Le code, pas l'IA, choisit les textes : l'IA ne reçoit que la question sans nom ni coordonnée [R15] et les textes
 * retenus, et ne peut que les reformuler. Un paragraphe de l'IA sans texte cité, qui cite un texte qu'elle n'a pas
 * reçu, qui écrit un nombre absent de ses textes ou qui promet est refusé, et la réponse du code prend le relais :
 * le résumé des textes eux-mêmes [R251]. L'avertissement et la liste des sources sont toujours écrits par le code
 * [R252]. Le journal ne garde ni la question ni la réponse, seulement l'issue et les textes cités [R13].
 */
import { withoutContactDetails } from '../captation/premiere-reponse.ts';
import { plain } from '../envoi/texte.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { withoutNames } from '../qualification/regles.ts';
import { DEFAULT_LEGAL_LIBRARY, type LegalSource } from './bibliotheque.ts';

/** Au-delà, la version citée est dite « à revérifier » : réglage, en jours. */
export const LEGAL_CHECK_MAX_AGE_DAYS = 365;
/** Les textes retenus au plus pour une question. */
export const MAX_SOURCES = 3;
/** La longueur permise d'une question et d'un paragraphe de réponse. */
export const MAX_QUESTION_LENGTH = 2_000;
export const MAX_PARAGRAPH_LENGTH = 800;

/** Le renvoi écrit par le code dans chaque réponse [R252]. */
export const LAWYER_NOTICE =
  'Information générale tirée des textes cités, pas une consultation juridique : pour un dossier précis, voyez votre avocat.';
/** La réponse quand rien ne couvre la question [R250]. */
export const DONT_KNOW =
  'Je ne sais pas : aucun texte de ma bibliothèque ne couvre cette question. Je préfère ne pas inventer : voyez votre avocat.';
/** La réponse à une question sur un litige [R253]. */
export const DISPUTE =
  'Cette question porte sur un litige : je n’y réponds pas. Voyez votre avocat, avec les pièces du dossier.';
/** La réponse à une question trop longue pour être contrôlée entière. */
export const TOO_LONG = 'Question trop longue : posez-la en moins de 2 000 caractères, sans pièces jointes ni copie de mails.';
export const UNCHECKED = 'Version jamais vérifiée sur Légifrance : à vérifier avant de vous en servir.';
export const STALE = 'Version vérifiée il y a plus d’un an : à revérifier sur Légifrance avant de vous en servir.';
export const NOT_VALIDATED = 'Texte pas encore relu par l’avocat du réseau.';
/**
 * AU090 · des textes couvrent la question, mais aucun n'est à la fois vérifié sur Légifrance depuis moins d'un an et
 * relu par l'avocat du réseau : aucune réponse n'en est tirée, seules leurs références sont données.
 */
export const TO_CHECK =
  'Les textes qui couvrent votre question n’ont pas été vérifiés récemment ni relus par l’avocat du réseau : je ne m’en sers pas pour vous répondre. Voici leurs références, pour en parler à votre avocat.';

/** AU090 · un texte peut fonder une réponse : vérifié depuis moins d'un an, et relu par l'avocat du réseau. */
export function usableSource(s: LegalSource, now: Date): boolean {
  return citationOf(s, now).warnings.length === 0;
}

/** Ce que l'IA reçoit : la question sans nom ni coordonnée, et les seuls textes retenus par le code. */
export interface LegalFacts {
  question: string;
  sources: { id: string; title: string; article: string; origin: string; textDate: string; wording: string; wordingDate: string; summary: string }[];
}

/** Ce que l'IA rend : des paragraphes qui citent chacun leurs textes, ou l'aveu qu'elle ne sait pas. */
export type LegalDraft = { kind: 'answer'; paragraphs: { text: string; sources: string[] }[] } | { kind: 'unknown' };

/** L'IA qui reformule. Absente, en panne ou refusée par le contrôle : la réponse du code. */
export interface LegalWriter {
  write(facts: LegalFacts): Promise<unknown>;
}

export interface Citation {
  id: string;
  title: string;
  article: string;
  /** Le texte qui a créé l'article, et sa date. */
  origin: string;
  textDate: string;
  /** Le texte qui a donné au résumé sa teneur actuelle, et sa date : celle que la réponse cite d'abord. */
  wording: string;
  wordingDate: string;
  url: string | null;
  checkedOn: string | null;
  validatedBy: string | null;
  /** Ce que la réponse doit dire de la version citée, vide quand elle est vérifiée, récente et relue. */
  warnings: string[];
}

export interface LegalParagraph {
  text: string;
  sources: string[];
}

export type LegalAnswer =
  | {
      status: 'reponse';
      paragraphs: LegalParagraph[];
      citations: Citation[];
      notice: string;
      /** Qui a écrit les paragraphes : l'IA, ou le code à partir des textes. */
      writtenBy: 'ia' | 'textes';
    }
  | { status: 'je_ne_sais_pas' | 'litige'; text: string; citations: []; notice: string }
  /** AU090 · des textes couvrent la question, mais aucun n'est à jour et relu : leurs références seules, aucune réponse. */
  | { status: 'a_verifier'; text: string; citations: Citation[]; notice: string };

export type DraftProblem =
  | 'format'
  | 'vide'
  | 'trop_long'
  | 'sans_source'
  | 'source_non_fournie'
  | 'nombre_sans_source'
  | 'tournure_interdite';

export interface AskOptions {
  writer?: LegalWriter;
  library?: readonly LegalSource[];
  /** Les noms connus à retirer de la question avant l'IA [R15]. */
  knownNames?: readonly string[];
  journal?: JournalStore;
  /** L'agent qui pose la question, par son identifiant interne. */
  actor?: string;
  now?: () => Date;
}

const words = (text: string): string => ` ${plain(text).replace(/[^a-z0-9-]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
const has = (w: string, term: string): boolean => w.includes(` ${words(term).trim()} `);

/** Les termes d'un litige, formes fléchies comprises (« tribunaux », « poursuivi », « assigné », « plainte déposée »). */
const DISPUTE_WORDS = new RegExp(
  `(?:^| )(?:${[
    'litiges?',
    'litigieu\\w*',
    'proces',
    'tribunal',
    'tribunaux',
    'assign\\w*',
    'plaintes?',
    'poursui\\w*',
    'contentieu\\w*',
    'condamn\\w*',
    'prud hom\\w*',
    'prudhom\\w*',
    'mediat\\w*',
    'justice',
    'juges?',
    'jugements?',
    'huissiers?',
    'commissaires? de justice',
    'mise en demeure',
    'mis en demeure',
    'mettre en demeure',
    'avocat adverse',
    'dommages et interets',
    'dommages interets',
    'attaqu\\w*',
    'recours',
    'conflit\\w*',
  ].join('|')})(?= |$)`,
);

/** La question porte-t-elle sur un litige ? Toujours renvoyée à l'avocat [R253]. */
export function isDispute(question: string): boolean {
  return DISPUTE_WORDS.test(words(question).trim());
}

/** Les textes qui couvrent la question : ceux dont chaque groupe de termes y trouve un mot, les plus précis d'abord. */
export function coveringSources(question: string, library: readonly LegalSource[] = DEFAULT_LEGAL_LIBRARY): LegalSource[] {
  const w = words(question);
  const scored: { s: LegalSource; hits: number; i: number }[] = [];
  library.forEach((s, i) => {
    if (s.match.length === 0) return;
    if (s.exclude.some((t) => has(w, t))) return;
    let hits = 0;
    for (const group of s.match) {
      const n = group.filter((t) => has(w, t)).length;
      if (n === 0) return;
      hits += n;
    }
    scored.push({ s, hits, i });
  });
  return scored
    .sort((a, b) => b.hits - a.hits || a.i - b.i)
    .slice(0, MAX_SOURCES)
    .map((x) => x.s);
}

const MONTHS = 'janvier|fevrier|février|mars|avril|mai|juin|juillet|aout|août|septembre|octobre|novembre|decembre|décembre';
const BORN = /\bn[ée]e?s?\s+(?:le|en|à|a)\s+[^,;.?!\n]*/giu;
const DATE_DIGITS = /\b\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?\b/g;
const DATE_WORDS = new RegExp(`(?:\\b\\d{1,2}(?:er)?\\s+)?(?<![\\p{L}])(?:${MONTHS})(?![\\p{L}])(?:\\s+(?:dernier|prochain|\\d{4}))?`, 'giu');
const YEAR_ALONE = /(?<!\d)(?:19|20)\d{2}(?!\d)/g;
/** Les mots outils et le vocabulaire d'une question d'agent, que l'IA peut lire : liste fermée [R15]. */
const QUESTION_WORDS = new Set(
  (
    'le la les l un une des de du d au aux a à et ou en dans pour par sur sous avec sans ni ne n pas plus moins tres ' +
    'je j me m moi mon ma mes tu te ton ta tes il elle ils elles on nous vous leur leurs son sa ses se s lui eux y ' +
    'ce cet cette ces c ca cela ceci qui que qu quoi quel quelle quels quelles lequel laquelle dont ou quand comment ' +
    'combien pourquoi est sont etre ete etait a ai as ont avoir avait peut peuvent pouvez puis-je puis doit doivent ' +
    'dois devez faut faire fait font fais veut veulent voudrait souhaite si alors donc mais car apres avant pendant ' +
    'depuis jusqu jusque entre fin debut jour jours mois an ans annee annees semaine semaines delai delais date ' +
    'client clients cliente vendeur vendeurs vendeuse acquereur acquereurs acheteur acheteurs proprietaire locataire ' +
    'agent agence notaire avocat banque mandat mandats bien biens maison appartement immeuble lot terrain parking cave ' +
    'garage vente vendre vendu achat acheter achete signer signe signee signes signature contrat acte offre prix ' +
    'honoraires commission frais somme sommes payer paye toucher verser obligatoire obligation obliger droit droits ' +
    'loi lois code article texte regle regles legal legale legalement possible permis interdit valable nul nulle ' +
    'oui non bien encore deja toujours jamais aussi meme autre autres premier premiere dernier derniere nouveau nouvelle ' +
    'monsieur madame m mme mr me mlle selon carrez hoguet alur elan macron sru climat dpe ddt sci tva'
  ).split(' '),
);
const WORD = /[\p{L}]+/gu;
/** Les seules marques entre crochets posées par les filtres : un autre mot entre crochets est un mot comme un autre. */
const REDACTION_MARKERS = new Set(['nom', 'mail', 'adresse', 'téléphone', 'date', 'compte']);

/** Les mots qu'une bibliothèque emploie : ceux-là aussi passent à l'IA. */
function libraryWords(library: readonly LegalSource[]): Set<string> {
  const out = new Set<string>();
  for (const s of library) {
    const text = [s.title, s.article, s.summary, ...s.match.flat(), ...s.exclude].join(' ');
    for (const m of plain(text).matchAll(/[a-z]+/g)) out.add(m[0]);
  }
  return out;
}

/**
 * La question telle que l'IA la reçoit [R15] : sans coordonnée, sans nom connu, sans date (une date de naissance ou de
 * signature ne sert pas à dire le droit), et réduite à une liste fermée de mots : les mots outils, le vocabulaire d'une
 * question d'agent et les mots de la bibliothèque. Tout autre mot, nom de personne compris, quelle que soit sa casse ou sa
 * place, devient « … ».
 */
export function scrubQuestion(question: string, library: readonly LegalSource[] = DEFAULT_LEGAL_LIBRARY, knownNames: readonly string[] = []): string {
  const out = withoutContactDetails(withoutNames(question, knownNames)).replace(BORN, '[date]').replace(DATE_DIGITS, '[date]').replace(DATE_WORDS, '[date]').replace(YEAR_ALONE, '[date]');
  const allowed = libraryWords(library);
  let result = '';
  let last = 0;
  for (const m of out.matchAll(WORD)) {
    const k = plain(m[0]);
    const inBrackets = out[m.index! - 1] === '[' && out[m.index! + m[0].length] === ']' && REDACTION_MARKERS.has(m[0]);
    if (inBrackets || QUESTION_WORDS.has(k) || allowed.has(k)) continue;
    result += out.slice(last, m.index!) + '…';
    last = m.index! + m[0].length;
  }
  return (result + out.slice(last)).replace(/…(?:[\s'’-]*…)+/g, '…');
}

const DAY = 86_400_000;

/** Ce que la réponse doit dire de la version d'un texte [R252]. */
export function citationOf(s: LegalSource, now: Date): Citation {
  const warnings: string[] = [];
  const checked = s.checkedOn === null ? Number.NaN : Date.parse(`${s.checkedOn}T00:00:00.000Z`);
  // Une date mal écrite ou à venir ne prouve aucune vérification (AU090).
  if (Number.isNaN(checked) || !/^\d{4}-\d{2}-\d{2}$/.test(s.checkedOn ?? '') || checked > now.getTime()) warnings.push(UNCHECKED);
  else if (now.getTime() - checked > LEGAL_CHECK_MAX_AGE_DAYS * DAY) warnings.push(STALE);
  if (s.validatedBy === null || s.validatedBy.trim() === '') warnings.push(NOT_VALIDATED);
  return {
    id: s.id,
    title: s.title,
    article: s.article,
    origin: s.origin,
    textDate: s.textDate,
    wording: s.wording,
    wordingDate: s.wordingDate,
    url: s.url,
    checkedOn: s.checkedOn,
    validatedBy: s.validatedBy,
    warnings,
  };
}

const NUMBER_WORDS: Record<string, number> = {
  un: 1,
  une: 1,
  deux: 2,
  trois: 3,
  quatre: 4,
  cinq: 5,
  six: 6,
  sept: 7,
  huit: 8,
  neuf: 9,
  dix: 10,
  onze: 11,
  douze: 12,
  treize: 13,
  quatorze: 14,
  quinze: 15,
  seize: 16,
  vingt: 20,
  trente: 30,
  quarante: 40,
  cinquante: 50,
  soixante: 60,
  cent: 100,
  mille: 1000,
};
const NUM = `(\\d+(?:[ \\u00a0\\u202f.]\\d{3})*(?:,\\d+)?|${Object.keys(NUMBER_WORDS).join('|')})`;
const UNITS: [RegExp, string][] = [
  [/^(?:%|pour ?cent)$/, 'pct'],
  [/^jours?$/, 'jour'],
  [/^mois$/, 'mois'],
  [/^(?:ans?|annees?)$/, 'an'],
  [/^semaines?$/, 'semaine'],
  [/^heures?$/, 'heure'],
  [/^(?:m2|m²|metres? carres?)$/, 'm2'],
  [/^(?:euros?|€)$/, 'eur'],
  [/^(?:vingtiemes?)$/, 'vingtieme'],
  [/^(?:dixiemes?)$/, 'dixieme'],
  [/^(?:centiemes?)$/, 'centieme'],
  [/^(?:quarts?)$/, 'quart'],
  [/^tiers$/, 'tiers'],
  [/^moities?$/, 'moitie'],
];
const UNIT = '(%|pour ?cent|jours?|mois|annees?|ans?|semaines?|heures?|m2|m²|metres? carres?|euros?|€|vingtiemes?|dixiemes?|centiemes?|quarts?|tiers|moities?)';
const QUANTITY = new RegExp(`(?<![a-z0-9])${NUM}\\s*${UNIT}(?![a-z0-9])`, 'g');
const BARE = new RegExp(`(?<![a-z0-9])${NUM}(?![a-z0-9])`, 'g');

function valueOf(token: string): number {
  return NUMBER_WORDS[token] ?? Number(token.replace(/[   .]/g, '').replace(',', '.'));
}

/**
 * Les nombres qu'un texte écrit, en chiffres ou en lettres : avec leur unité (« 10 jours » → `10|jour`, « d'un an » →
 * `1|an`, « un vingtième » → `1|vingtieme`), et seuls (« article 6 » → `6`, sans « un » ni « une »).
 */
export function quantitiesIn(text: string): { withUnit: Set<string>; bare: Set<string> } {
  const p = plain(text).replace(/ | /g, ' ');
  const withUnit = new Set<string>();
  const taken: [number, number][] = [];
  for (const m of p.matchAll(QUANTITY)) {
    const unit = UNITS.find(([re]) => re.test(m[2]!))![1];
    withUnit.add(`${valueOf(m[1]!)}|${unit}`);
    taken.push([m.index!, m.index! + m[0].length]);
  }
  const bare = new Set<string>();
  for (const m of p.matchAll(BARE)) {
    const i = m.index!;
    if (m[1] === 'un' || m[1] === 'une' || taken.some(([a, b]) => i >= a && i < b)) continue;
    bare.add(String(valueOf(m[1]!)));
  }
  return { withUnit, bare };
}

/**
 * Les mots qui disent une quantité sans chiffre (« un million », « le double », « une dizaine ») : un seul absent du
 * résumé des textes cités, et le paragraphe est refusé [R251].
 */
const QUANTITY_WORDS = /^(?:millions?|milliards?|milliers?|centaines?|dizaines?|douzaines?|quinzaines?|vingtaines?|trentaines?|double|doubles|triple|triples|quadruple|moities?|moitie|tiers|quarts?|demi|demie|cents|mille|vingts|zero|aucun|nul)$/;

/** Les mots de quantité sans chiffre qu'un texte emploie. */
function quantityWordsIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of plain(text).matchAll(/[a-z]+/g)) if (QUANTITY_WORDS.test(m[0])) out.add(m[0].replace(/s$/, ''));
  return out;
}

/** Les promesses et tournures qu'un assistant juridique n'écrit jamais. */
export const FORBIDDEN_LEGAL_PHRASES: readonly string[] = [
  'je vous garantis',
  'je garantis',
  'garanti',
  'garantie',
  'sans risque',
  'aucun risque',
  'a coup sur',
  'certainement',
  'sans aucun doute',
  'aucun juge',
  'jamais condamne',
  'pas besoin d avocat',
  'inutile de consulter',
  'inutile d appeler',
];

const REFERENCE = new RegExp(
  `\\b(?:articles?\\s+|art\\.?\\s*)?l\\.?\\s?\\d+(?:-\\d+)+\\b|\\b(?:articles?|art\\.?)\\s+\\d+(?:-\\d+)*\\b|\\bn°\\s*\\d+-\\d+\\b|\\b\\d{1,2}(?:er)?\\s+(?:${MONTHS})\\s+\\d{4}\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b`,
  'giu',
);
/**
 * Une année seule ne vaut référence que dans « la loi (n° …) de 2015 », « depuis 2015 » ou « en 2015 », suivie d'une
 * fin de phrase ou d'un signe de ponctuation : jamais ailleurs, et jamais suivie d'un mot (une unité, connue ou non).
 */
const YEAR = /\b((?:loi|ordonnance|decret|décret)(?:\s+n°\s*\d+-\d+)?\s+(?:de|du)|depuis|en)\s+((?:1[6-9]|20)\d{2})(?=[\s  ]*(?:[.;:!?,)\]]|$))/giu;
const refKey = (t: string): string => plain(t).replace(/^(?:articles?|art\.?)\s*/, '').replace(/\s+/g, ' ').replace(/^l\.?\s?/, 'l').trim();

/** Les références entières d'un texte : son article, ses numéros et ses dates complètes ; ses années, à part. */
function referencesOf(s: LegalFacts['sources'][number]): { refs: string[]; years: string[] } {
  const refs: string[] = [];
  for (const t of [s.title, s.article, s.origin, s.wording, s.textDate, s.wordingDate]) for (const m of t.matchAll(REFERENCE)) refs.push(refKey(m[0]));
  // Les années des seules dates du texte, jamais celles qu'on lirait dans un numéro de loi (« 2000-1208 »).
  return { refs, years: [s.textDate.slice(0, 4), s.wordingDate.slice(0, 4)] };
}

/** Le texte sans les références qui appartiennent aux textes cités ; une autre référence reste, et ses nombres comptent. */
function withoutReferences(text: string, refs: readonly string[], years: readonly string[]): string {
  return text
    .replace(REFERENCE, (m) => (refs.includes(refKey(m)) ? ' ' : m))
    .replace(YEAR, (m, intro: string, year: string) => (years.includes(year) ? `${intro} ` : m));
}

/** Contrôle un brouillon de l'IA : chaque paragraphe cite des textes reçus et n'écrit que leurs nombres [R251]. */
export function checkDraft(draft: unknown, facts: LegalFacts): { ok: true; draft: LegalDraft } | { ok: false; problems: DraftProblem[] } {
  if (typeof draft !== 'object' || draft === null) return { ok: false, problems: ['format'] };
  const d = draft as { kind?: unknown; paragraphs?: unknown };
  if (d.kind === 'unknown') return { ok: true, draft: { kind: 'unknown' } };
  if (d.kind !== 'answer' || !Array.isArray(d.paragraphs)) return { ok: false, problems: ['format'] };
  if (d.paragraphs.length === 0) return { ok: false, problems: ['vide'] };
  const given = new Map(facts.sources.map((s) => [s.id, s]));
  const problems = new Set<DraftProblem>();
  const paragraphs: LegalParagraph[] = [];
  for (const raw of d.paragraphs as unknown[]) {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as { text?: unknown; sources?: unknown };
    if (typeof r.text !== 'string' || !Array.isArray(r.sources) || !r.sources.every((x) => typeof x === 'string')) {
      problems.add('format');
      continue;
    }
    const text = r.text.trim();
    const ids = [...new Set(r.sources as string[])];
    if (text === '') problems.add('vide');
    if (text.length > MAX_PARAGRAPH_LENGTH) problems.add('trop_long');
    if (ids.length === 0) problems.add('sans_source');
    if (ids.some((id) => !given.has(id))) problems.add('source_non_fournie');
    // Un nombre ne vient que du résumé d'un texte cité ; seules ses références entières (article, numéro du texte, date
    // complète, année) peuvent s'y ajouter, et elles sont ôtées avant le contrôle.
    const withUnit = new Set<string>();
    const bare = new Set<string>();
    const refs: string[] = [];
    const years: string[] = [];
    for (const id of ids) {
      const s = given.get(id);
      if (!s) continue;
      const fromSummary = quantitiesIn(s.summary);
      for (const q of fromSummary.withUnit) withUnit.add(q);
      for (const n of fromSummary.bare) bare.add(n);
      const r = referencesOf(s);
      refs.push(...r.refs);
      years.push(...r.years);
    }
    const said = quantitiesIn(withoutReferences(text, refs, years));
    const summaryWords = new Set(ids.flatMap((id) => [...quantityWordsIn(given.get(id)?.summary ?? '')]));
    if ([...quantityWordsIn(text)].some((w) => !summaryWords.has(w))) problems.add('nombre_sans_source');
    if ([...said.withUnit].some((q) => !withUnit.has(q)) || [...said.bare].some((n) => !bare.has(n))) problems.add('nombre_sans_source');
    const w = words(text);
    if (FORBIDDEN_LEGAL_PHRASES.some((f) => has(w, f))) problems.add('tournure_interdite');
    paragraphs.push({ text, sources: ids });
  }
  if (problems.size > 0) return { ok: false, problems: [...problems] };
  return { ok: true, draft: { kind: 'answer', paragraphs } };
}

/** La réponse écrite par le code : chaque texte retenu, par son résumé, cité. */
function fromTexts(sources: readonly LegalSource[]): LegalParagraph[] {
  return sources.map((s) => ({ text: `${s.title}, ${s.article} : ${s.summary}`, sources: [s.id] }));
}

type Outcome = 'ia' | 'textes' | 'ia_refusee' | 'ia_en_panne' | 'ia_ne_sait_pas' | 'aucun_texte' | 'litige' | 'question_invalide' | 'textes_non_verifies';

/**
 * Répond à une question juridique de l'agent. Ne lève jamais d'erreur pour une IA absente, en panne ou hors format :
 * la réponse vient alors des textes eux-mêmes.
 */
export async function askLegal(question: string, options: AskOptions = {}): Promise<LegalAnswer> {
  const library = options.library ?? DEFAULT_LEGAL_LIBRARY;
  const now = options.now ?? (() => new Date());
  // Rien n'est coupé : une question trop longue est refusée entière, pour qu'aucun terme ne se perde avant le contrôle.
  const q = typeof question === 'string' ? question.normalize('NFC').trim() : '';

  const finish = async (answer: LegalAnswer, outcome: Outcome, problems: DraftProblem[] = []): Promise<LegalAnswer> => {
    if (options.journal) {
      await appendEvent(
        options.journal,
        {
          type: 'juridique.question',
          actor: options.actor ?? 'system:juridique',
          subject: 'juridique',
          data: {
            rule: outcome === 'litige' ? 'R253' : outcome === 'textes_non_verifies' ? 'R252' : outcome === 'aucun_texte' || outcome === 'ia_ne_sait_pas' ? 'R250' : 'R251',
            outcome,
            sources: answer.citations.map((c) => c.id),
            problems,
          },
        },
        now,
      );
    }
    return answer;
  };
  const refuse = (status: 'je_ne_sais_pas' | 'litige'): LegalAnswer => ({
    status,
    text: status === 'litige' ? DISPUTE : DONT_KNOW,
    citations: [],
    notice: LAWYER_NOTICE,
  });

  if (q === '') return finish(refuse('je_ne_sais_pas'), 'question_invalide');
  if (isDispute(q)) return finish(refuse('litige'), 'litige');
  if (q.length > MAX_QUESTION_LENGTH) return finish({ status: 'je_ne_sais_pas', text: TOO_LONG, citations: [], notice: LAWYER_NOTICE }, 'question_invalide');
  const covering = coveringSources(q, library);
  if (covering.length === 0) return finish(refuse('je_ne_sais_pas'), 'aucun_texte');

  const at = now();
  // AU090 · seuls les textes vérifiés depuis moins d'un an et relus par l'avocat fondent une réponse ; sinon leurs
  // références, sans rien en tirer.
  const sources = covering.filter((s) => usableSource(s, at));
  if (sources.length === 0) return finish({ status: 'a_verifier', text: TO_CHECK, citations: covering.map((s) => citationOf(s, at)), notice: LAWYER_NOTICE }, 'textes_non_verifies');
  const citationsFor = (ids: readonly string[]): Citation[] =>
    sources.filter((s) => ids.includes(s.id)).map((s) => citationOf(s, at));
  const byTexts = (outcome: Outcome, problems: DraftProblem[] = []): Promise<LegalAnswer> =>
    finish(
      { status: 'reponse', paragraphs: fromTexts(sources), citations: citationsFor(sources.map((s) => s.id)), notice: LAWYER_NOTICE, writtenBy: 'textes' },
      outcome,
      problems,
    );

  if (!options.writer) return byTexts('textes');
  const facts: LegalFacts = {
    question: scrubQuestion(q, library, options.knownNames ?? []),
    sources: sources.map((s) => ({ id: s.id, title: s.title, article: s.article, origin: s.origin, textDate: s.textDate, wording: s.wording, wordingDate: s.wordingDate, summary: s.summary })),
  };
  let raw: unknown;
  try {
    raw = await options.writer.write(structuredClone(facts));
  } catch {
    return byTexts('ia_en_panne');
  }
  const checked = checkDraft(raw, facts);
  if (!checked.ok) return byTexts('ia_refusee', checked.problems);
  if (checked.draft.kind === 'unknown') return finish(refuse('je_ne_sais_pas'), 'ia_ne_sait_pas');
  const cited = [...new Set(checked.draft.paragraphs.flatMap((p) => p.sources))];
  return finish(
    { status: 'reponse', paragraphs: checked.draft.paragraphs, citations: citationsFor(cited), notice: LAWYER_NOTICE, writtenBy: 'ia' },
    'ia',
  );
}
