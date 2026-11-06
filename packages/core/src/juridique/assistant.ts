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
export const UNCHECKED = 'Version jamais vérifiée sur Légifrance : à vérifier avant de vous en servir.';
export const STALE = 'Version vérifiée il y a plus d’un an : à revérifier sur Légifrance avant de vous en servir.';
export const NOT_VALIDATED = 'Texte pas encore relu par l’avocat du réseau.';

/** Ce que l'IA reçoit : la question sans nom ni coordonnée, et les seuls textes retenus par le code. */
export interface LegalFacts {
  question: string;
  sources: { id: string; title: string; article: string; origin: string; textDate: string; summary: string }[];
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
  | { status: 'je_ne_sais_pas' | 'litige'; text: string; citations: []; notice: string };

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

const DISPUTE_TERMS = [
  'litige',
  'proces',
  'tribunal',
  'assigner',
  'assignation',
  'plainte',
  'porter plainte',
  'poursuivre',
  'poursuites',
  'avocat adverse',
  'mise en demeure',
  'contentieux',
  'attaquer en justice',
  'en justice',
  'condamne',
  'condamnation',
  'prud hommes',
  'mediateur',
];

/** La question porte-t-elle sur un litige ? Toujours renvoyée à l'avocat [R253]. */
export function isDispute(question: string): boolean {
  const w = words(question);
  return DISPUTE_TERMS.some((t) => has(w, t));
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
const DATE_DIGITS = /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/g;
const DATE_WORDS = new RegExp(`\\b\\d{1,2}(?:er)?\\s+(?:${MONTHS})(?:\\s+\\d{4})?\\b`, 'giu');
/** Les mots à majuscule qui ne sont jamais un nom de personne dans une question juridique. */
const KEPT_CAPITALIZED = new Set(['carrez', 'hoguet', 'alur', 'elan', 'macron', 'pinel', 'boutin', 'sru', 'legifrance', 'code', 'loi', 'article', 'cour', 'cassation', 'conseil', 'etat', 'france', 'europe', 'notaire', 'mandat', 'compromis']);
const WORD = /[\p{L}][\p{L}'’-]*/gu;

/**
 * La question telle que l'IA la reçoit [R15] : sans coordonnée, sans nom connu, sans date (une date de naissance ou de
 * signature ne sert pas à dire le droit), et sans aucun mot à majuscule qui pourrait être un nom : hors début de phrase,
 * tout mot à majuscule qui n'est ni un sigle ni un terme juridique connu devient « [nom] » ; en début de phrase aussi,
 * dès qu'il est suivi d'un autre mot ainsi retiré (« Jean Martin »).
 */
export function scrubQuestion(question: string, knownNames: readonly string[] = []): string {
  const out = withoutContactDetails(withoutNames(question, knownNames)).replace(BORN, '[date]').replace(DATE_DIGITS, '[date]').replace(DATE_WORDS, '[date]');
  const tokens = [...out.matchAll(WORD)].map((m) => ({ text: m[0], at: m.index! }));
  const isName = (t: string): boolean => {
    if (!/^\p{Lu}/u.test(t)) return false;
    if (t === t.toUpperCase() && t.replace(/[^\p{L}]/gu, '').length <= 6) return false; // sigle : DPE, SCI, M, MME
    return !KEPT_CAPITALIZED.has(plain(t).replace(/['’-].*$/, ''));
  };
  const atStart = (at: number): boolean => /(?:^|[.!?:\n]\s*|["«(]\s*)$/u.test(out.slice(0, at));
  const remove = new Set<number>();
  tokens.forEach((t, i) => {
    if (!isName(t.text)) return;
    if (!atStart(t.at)) {
      remove.add(i);
      const prev = tokens[i - 1];
      if (prev && isName(prev.text) && atStart(prev.at)) remove.add(i - 1);
    }
  });
  let result = '';
  let last = 0;
  tokens.forEach((t, i) => {
    if (!remove.has(i)) return;
    result += out.slice(last, t.at) + '[nom]';
    last = t.at + t.text.length;
  });
  return result + out.slice(last);
}

const DAY = 86_400_000;

/** Ce que la réponse doit dire de la version d'un texte [R252]. */
export function citationOf(s: LegalSource, now: Date): Citation {
  const warnings: string[] = [];
  const checked = s.checkedOn === null ? Number.NaN : Date.parse(`${s.checkedOn}T00:00:00.000Z`);
  if (Number.isNaN(checked)) warnings.push(UNCHECKED);
  else if (now.getTime() - checked > LEGAL_CHECK_MAX_AGE_DAYS * DAY) warnings.push(STALE);
  if (s.validatedBy === null || s.validatedBy.trim() === '') warnings.push(NOT_VALIDATED);
  return {
    id: s.id,
    title: s.title,
    article: s.article,
    origin: s.origin,
    textDate: s.textDate,
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
    // Un nombre avec son unité ne vient que du résumé d'un texte cité ; un nombre seul, du résumé ou de la référence.
    const withUnit = new Set<string>();
    const bare = new Set<string>();
    for (const id of ids) {
      const s = given.get(id);
      if (!s) continue;
      const fromSummary = quantitiesIn(s.summary);
      for (const q of fromSummary.withUnit) withUnit.add(q);
      for (const n of fromSummary.bare) bare.add(n);
      for (const n of quantitiesIn(`${s.title} ${s.article} ${s.origin} ${s.textDate.replace(/-/g, ' ')}`).bare) bare.add(n);
    }
    const said = quantitiesIn(text);
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

type Outcome = 'ia' | 'textes' | 'ia_refusee' | 'ia_en_panne' | 'ia_ne_sait_pas' | 'aucun_texte' | 'litige' | 'question_invalide';

/**
 * Répond à une question juridique de l'agent. Ne lève jamais d'erreur pour une IA absente, en panne ou hors format :
 * la réponse vient alors des textes eux-mêmes.
 */
export async function askLegal(question: string, options: AskOptions = {}): Promise<LegalAnswer> {
  const library = options.library ?? DEFAULT_LEGAL_LIBRARY;
  const now = options.now ?? (() => new Date());
  const q = typeof question === 'string' ? question.normalize('NFC').trim().slice(0, MAX_QUESTION_LENGTH) : '';

  const finish = async (answer: LegalAnswer, outcome: Outcome, problems: DraftProblem[] = []): Promise<LegalAnswer> => {
    if (options.journal) {
      await appendEvent(
        options.journal,
        {
          type: 'juridique.question',
          actor: options.actor ?? 'system:juridique',
          subject: 'juridique',
          data: {
            rule: outcome === 'litige' ? 'R253' : outcome === 'aucun_texte' || outcome === 'ia_ne_sait_pas' ? 'R250' : 'R251',
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
  const sources = coveringSources(q, library);
  if (sources.length === 0) return finish(refuse('je_ne_sais_pas'), 'aucun_texte');

  const at = now();
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
    question: scrubQuestion(q, options.knownNames ?? []),
    sources: sources.map((s) => ({ id: s.id, title: s.title, article: s.article, origin: s.origin, textDate: s.textDate, summary: s.summary })),
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
