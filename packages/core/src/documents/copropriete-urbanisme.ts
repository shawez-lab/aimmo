/**
 * La copropriété et l'urbanisme résumés pour le dossier de vente (HX35, M06 et M10).
 *
 * Le résumé est fait de phrases proposées (par l'IA ou par l'agent) et vérifiées par le code : chaque phrase renvoie à
 * un document du dossier et à une page de ce document, et porte l'extrait exact qui la fonde ; l'extrait doit se lire
 * sur cette page, sinon la phrase est écartée avec sa raison [R448]. Un montant ou une date d'échéance de travaux doit
 * lui aussi se lire dans l'extrait : on ne recopie pas un chiffre qui n'est pas dans le document.
 *
 * Les données publiques — la fiche du registre national des copropriétés et la zone du plan local d'urbanisme lue au
 * Géoportail de l'urbanisme — ne sont prises que de ces deux sources, chacune avec le jour de sa collecte et la date de
 * la donnée elle-même ; une donnée d'une autre source, ou datée du futur, est refusée [R449].
 *
 * Chaque rubrique sans phrase vérifiée, et chaque donnée publique absente, dit « non trouvé » avec sa raison : le
 * résumé ne comble jamais un vide [R450].
 *
 * Jamais vu : les travaux votés en assemblée et encore à venir sont tirés du résumé et signalés à l'acquéreur, chacun
 * avec l'assemblée qui les a votés, la page du procès-verbal et, s'ils se lisent dans l'extrait, le montant et
 * l'échéance [R451].
 *
 * Tout s'ajoute, rien ne se réécrit [R452]. Le journal ne porte que des identifiants et des nombres, jamais une phrase,
 * un extrait, un montant ni une zone [R13].
 *
 * Décidé, lecture prudente :
 * - une phrase dit une seule chose : un texte qui enchaîne plusieurs phrases est écarté, pour que chacune ait sa page ;
 * - l'extrait se compare au texte de la page sans tenir compte des majuscules, des espaces, des apostrophes courbes ni
 *   des coupures de mot en fin de ligne ; il fait au moins 12 caractères, pour ne pas « trouver » un mot isolé ;
 * - un syndic bénévole ou coopératif peut être une personne : son nom n'est jamais repris, seul son type l'est ;
 * - des travaux votés sans échéance lisible sont signalés quand même, « échéance non trouvée » : mieux vaut le dire ;
 * - des travaux dont l'échéance est passée au jour du résumé ne sont plus « à venir » ;
 * - le texte des pages n'est pas gardé : seuls l'empreinte de chaque document, son nombre de pages et les extraits cités.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { actorOf, gateSaleFile, type FileRefusal, type FileUnknown } from '../dossiers/acces-dossier.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { sha256 } from './modeles.ts';

const TIME_ZONE = 'Europe/Paris';

/** Les deux sources publiques admises [R449]. */
export const PUBLIC_SOURCES = {
  registry: 'Registre national des copropriétés (ANAH)',
  urbanism: "Géoportail de l'urbanisme (IGN)",
} as const;

export const DOCUMENT_KINDS = ['pv_assemblee', 'reglement_copropriete', 'fiche_synthetique', 'carnet_entretien', 'appels_de_fonds', 'plu_reglement'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

const COOWNERSHIP_DOCS: readonly DocumentKind[] = ['pv_assemblee', 'reglement_copropriete', 'fiche_synthetique', 'carnet_entretien', 'appels_de_fonds'];
const URBANISM_DOCS: readonly DocumentKind[] = ['plu_reglement'];

export const COOWNERSHIP_TOPICS = ['travaux_votes', 'travaux_a_l_etude', 'procedures', 'impayes', 'charges', 'fonds_travaux', 'syndic'] as const;
export const URBANISM_TOPICS = ['zone', 'servitudes', 'droit_de_preemption'] as const;
export const TOPICS = [...COOWNERSHIP_TOPICS, ...URBANISM_TOPICS] as const;
export type Topic = (typeof TOPICS)[number];

/** Un document du dossier, avec le texte de chacune de ses pages (lu par l'extraction, jamais gardé). */
export interface SourceDocument {
  kind: DocumentKind;
  /** La référence du fichier déposé au dossier. */
  ref: string;
  /** Le texte de chaque page, dans l'ordre : la page 1 est `pages[0]`. */
  pages: string[];
  /** Le jour de l'assemblée, pour un procès-verbal. */
  meetingDay?: string;
}

/** Une phrase proposée pour le résumé : elle nomme son document, sa page et l'extrait qui la fonde. */
export interface ProposedSentence {
  topic: Topic;
  text: string;
  /** L'indice du document dans la liste fournie. */
  document: number;
  page: number;
  quote: string;
  /** Pour des travaux votés : leur montant en euros et leur échéance, s'ils se lisent dans l'extrait. */
  works?: { amountEur?: number; dueOn?: string };
}

export interface Citation {
  documentRef: string;
  kind: DocumentKind;
  page: number;
  quote: string;
  meetingDay: string | null;
}

export interface SummarySentence {
  topic: Topic;
  text: string;
  cite: Citation;
  works?: { amountEur: number | null; dueOn: string | null };
}

export type RejectReason = 'sujet_inconnu' | 'texte_vide' | 'plusieurs_phrases' | 'document_inconnu' | 'document_hors_sujet' | 'page_inexistante' | 'extrait_trop_court' | 'extrait_absent_de_la_page' | 'montant_absent_de_l_extrait' | 'echeance_absente_de_l_extrait' | 'travaux_mal_formes' | 'phrase_sans_rapport_avec_l_extrait' | 'vote_absent_de_l_extrait';

/** Une rubrique du résumé : ses phrases vérifiées, ou « non trouvé » avec sa raison [R450]. */
export type TopicLine =
  | { topic: Topic; found: true; sentences: SummarySentence[] }
  | { topic: Topic; found: false; text: 'non trouvé'; reason: 'aucun_document' | 'absent_des_documents' };

/** Une donnée publique : avec sa source, le jour de sa collecte et la date de la donnée, ou « non trouvé » [R449]. */
export type PublicLine<T> =
  | { found: true; value: T; source: string; collectedOn: string; dataDate: string }
  | { found: false; text: 'non trouvé'; source: string; collectedOn: string | null; reason: 'introuvable' | 'panne' | 'non_collecte' };

export interface RegistryValue {
  immatriculation: string;
  lots: number;
  syndicType: 'professionnel' | 'benevole' | 'cooperatif' | 'non_connu';
  /** Seulement pour un syndic professionnel : une société, jamais une personne. */
  syndicName: string | null;
  constructionPeriod: string | null;
}

export interface UrbanismValue {
  documentType: 'PLU' | 'PLUi' | 'carte_communale' | 'RNU';
  zone: string;
  label: string;
}

/** Ce que la collecte rapporte d'une source publique. */
export type PublicFact<T> =
  | { ok: true; source: string; collectedAt: string; dataDate: string; value: T }
  | { ok: false; source: string; collectedAt: string; reason: 'introuvable' | 'panne' };

export interface PublicData {
  registry?: PublicFact<RegistryValue>;
  urbanism?: PublicFact<UrbanismValue>;
}

/** Des travaux votés à venir, à signaler à l'acquéreur [R451]. */
export interface WorksNotice {
  text: string;
  votedOn: string;
  amountEur: number | null;
  dueOn: string | null;
  dueStatus: 'a_venir' | 'echeance_non_trouvee';
  cite: Citation;
}

export interface CoownershipSummary {
  id: string;
  fileId: string;
  version: number;
  documents: { ref: string; kind: DocumentKind; pages: number; hash: string; meetingDay: string | null }[];
  topics: TopicLine[];
  registry: PublicLine<RegistryValue>;
  urbanism: PublicLine<UrbanismValue>;
  worksToNotify: WorksNotice[];
  rejected: { index: number; reason: RejectReason }[];
  hash: string;
  preparedAt: string;
}

export type SummaryProblem = { ok: false; rule: null; code: 'bad_documents' | 'bad_public_data' | 'too_many' | 'no_summary' | 'busy' };
type Res<T> = { ok: true; value: T } | FileRefusal | FileUnknown | SummaryProblem;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const isStr = (v: unknown, max = 300): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const isDay = (v: unknown): v is string => typeof v === 'string' && DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const MIN_QUOTE = 12;
const MAX_DOCS = 30;
const MAX_PAGES = 400;
const MAX_SENTENCES = 200;

/** Le texte ramené à une forme comparable : minuscules, espaces simples, apostrophes droites, mots recollés. */
export function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/­/g, '')
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/[“”«»]/g, '"')
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/(\p{L})-\s*\n\s*(\p{L})/gu, '$1$2')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Le texte, séparateurs de milliers retirés : « 48 000,00 » devient « 48000,00 ». */
function joinThousands(text: string): string {
  return normalize(text).replace(/(\d)[\s.\u202f\u00a0](?=\d{3}(?!\d))/g, '$1');
}

/** Les nombres entiers d'un texte, séparateurs de milliers retirés : « 48 000,00 € » donne 48000 et 0. */
function numbersOf(text: string): number[] {
  return (joinThousands(text).match(/\d+/g) ?? []).map(Number);
}

/** Les montants en euros d'un texte : un nombre suivi de « € », « euros » ou « EUR », jamais un numéro de résolution. */
function amountsOf(text: string): number[] {
  return [...joinThousands(text).matchAll(/(?<![\d,.])(\d+)(?:[,.]\d{1,2})?\s*(?:€|euros?(?![\p{L}])|eur(?![\p{L}]))/gu)].map((m) => Number(m[1]));
}

const strip = (t: string) => t.normalize('NFD').replace(/\p{M}/gu, '');
/** Des mots trop généraux pour montrer qu'une phrase dit ce que dit son extrait. */
const GENERIC = new Set(['travaux', 'assemblee', 'generale', 'copropriete', 'coproprietaires', 'syndicat', 'resolution', 'adopte', 'adoptee', 'adoptes', 'adoptees', 'votes', 'votee', 'votees', 'prevus', 'prevue', 'montant', 'budget', 'depuis', 'pendant', 'avant', 'apres', 'selon', 'janvier', 'fevrier', 'avril', 'juillet', 'septembre', 'octobre', 'novembre', 'decembre']);

/**
 * La phrase dit ce que dit son extrait : chacun de ses nombres s'y lit, et au moins un de ses mots porteurs (cinq
 * lettres et plus, hors mots généraux) s'y retrouve, au pluriel ou au féminin près.
 */
function sentenceMatchesQuote(text: string, quote: string): boolean {
  const inQuote = new Set(numbersOf(quote));
  if (!numbersOf(text).every((n) => inQuote.has(n))) return false;
  const q = strip(normalize(quote));
  const words = (strip(normalize(text)).match(/\p{L}{5,}/gu) ?? []).filter((w) => !GENERIC.has(w));
  if (words.length === 0) return false;
  return words.some((w) => q.includes(w.slice(0, Math.max(5, w.length - 2))));
}

/** Un vote se lit dans l'extrait de travaux votés. */
const VOTE = /\b(?:vot|adopt|approuv|decid)/;

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

/** Les façons d'écrire un jour dans un procès-verbal : 01/03/2027, 1/3/2027, 1er mars 2027, 1 mars 2027. */
function dayMentions(day: string): string[] {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const dd = String(d).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  const month = MONTHS[m - 1]!;
  const out = [`${dd}/${mm}/${y}`, `${d}/${m}/${y}`, `${dd}.${mm}.${y}`, `${d} ${month} ${y}`, `${dd} ${month} ${y}`];
  if (d === 1) out.push(`1er ${month} ${y}`);
  return out.map(normalize);
}

/** Une phrase seule : pas de fin de phrase suivie d'une autre phrase. */
function isOneSentence(text: string): boolean {
  return !/[.!?;]\s+\S/.test(text.trim());
}

/** Vérifie une phrase proposée contre les documents ; rend la phrase gardée ou la raison de l'écarter [R448]. */
export function checkSentence(p: ProposedSentence, docs: readonly SourceDocument[], normalizedPages: readonly string[][]): { ok: true; value: SummarySentence } | { ok: false; reason: RejectReason } {
  if (!p || typeof p !== 'object' || !(TOPICS as readonly string[]).includes(p.topic)) return { ok: false, reason: 'sujet_inconnu' };
  if (!isStr(p.text, 400)) return { ok: false, reason: 'texte_vide' };
  if (!isOneSentence(p.text)) return { ok: false, reason: 'plusieurs_phrases' };
  if (!Number.isInteger(p.document) || p.document < 0 || p.document >= docs.length) return { ok: false, reason: 'document_inconnu' };
  const doc = docs[p.document]!;
  const allowed = (COOWNERSHIP_TOPICS as readonly string[]).includes(p.topic) ? COOWNERSHIP_DOCS : URBANISM_DOCS;
  if (!allowed.includes(doc.kind)) return { ok: false, reason: 'document_hors_sujet' };
  if (!Number.isInteger(p.page) || p.page < 1 || p.page > doc.pages.length) return { ok: false, reason: 'page_inexistante' };
  if (typeof p.quote !== 'string' || p.quote.length > 600) return { ok: false, reason: 'extrait_trop_court' };
  const quote = normalize(p.quote);
  if (quote.length < MIN_QUOTE) return { ok: false, reason: 'extrait_trop_court' };
  const page = normalizedPages[p.document]![p.page - 1]!;
  if (!page.includes(quote)) return { ok: false, reason: 'extrait_absent_de_la_page' };
  if (!sentenceMatchesQuote(p.text, p.quote)) return { ok: false, reason: 'phrase_sans_rapport_avec_l_extrait' };
  if (p.topic === 'travaux_votes' && !VOTE.test(strip(quote))) return { ok: false, reason: 'vote_absent_de_l_extrait' };
  const cite: Citation = { documentRef: doc.ref, kind: doc.kind, page: p.page, quote: p.quote.trim(), meetingDay: doc.meetingDay ?? null };
  if (p.works === undefined) return { ok: true, value: { topic: p.topic, text: p.text.trim(), cite } };
  // Des travaux : seulement votés ou à l'étude, montant et échéance lus dans l'extrait.
  if (typeof p.works !== 'object' || p.works === null || (p.topic !== 'travaux_votes' && p.topic !== 'travaux_a_l_etude')) return { ok: false, reason: 'travaux_mal_formes' };
  const { amountEur, dueOn } = p.works;
  if (amountEur !== undefined && (!Number.isInteger(amountEur) || amountEur <= 0 || amountEur > 1e9)) return { ok: false, reason: 'travaux_mal_formes' };
  if (dueOn !== undefined && !isDay(dueOn)) return { ok: false, reason: 'travaux_mal_formes' };
  if (amountEur !== undefined && !amountsOf(p.quote).includes(amountEur)) return { ok: false, reason: 'montant_absent_de_l_extrait' };
  if (dueOn !== undefined && !dayMentions(dueOn).some((m) => new RegExp(`(?<![\\d])${m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\d])`).test(quote))) return { ok: false, reason: 'echeance_absente_de_l_extrait' };
  return { ok: true, value: { topic: p.topic, text: p.text.trim(), cite, works: { amountEur: amountEur ?? null, dueOn: dueOn ?? null } } };
}

/** Les lignes d'un résumé, prêtes à lire : chaque phrase finit par son document et sa page [R448, R450]. */
export function renderSummary(s: Pick<CoownershipSummary, 'topics' | 'registry' | 'urbanism'>): string[] {
  const label: Record<DocumentKind, string> = {
    pv_assemblee: 'procès-verbal',
    reglement_copropriete: 'règlement de copropriété',
    fiche_synthetique: 'fiche synthétique',
    carnet_entretien: "carnet d'entretien",
    appels_de_fonds: 'appels de fonds',
    plu_reglement: "règlement d'urbanisme",
  };
  const frDay = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
  const lines: string[] = [];
  for (const t of s.topics) {
    if (!t.found) {
      lines.push(`${t.topic} : non trouvé`);
      continue;
    }
    for (const x of t.sentences) {
      const doc = x.cite.meetingDay ? `${label[x.cite.kind]} du ${frDay(x.cite.meetingDay)}` : label[x.cite.kind];
      lines.push(`${x.text.replace(/[.!?]$/, '')} (${doc}, p. ${x.cite.page}).`);
    }
  }
  const pub = (name: string, l: PublicLine<unknown>, show: (v: never) => string) =>
    l.found ? `${name} : ${show(l.value as never)} (${l.source}, donnée du ${frDay(l.dataDate)}, lue le ${frDay(l.collectedOn)}).` : `${name} : non trouvé (${l.source}).`;
  lines.push(pub('Registre des copropriétés', s.registry, (v: RegistryValue) => `${v.immatriculation}, ${v.lots} lots, syndic ${v.syndicType === 'professionnel' && v.syndicName ? v.syndicName : v.syndicType.replace('_', ' ')}`));
  lines.push(pub("Plan d'urbanisme", s.urbanism, (v: UrbanismValue) => `${v.documentType}, zone ${v.zone} (${v.label})`));
  return lines;
}

interface SummaryRow {
  id: string;
  file_id: string;
  version: number;
  content: string;
  hash: string;
  prepared_at: string;
}

export class CoproprieteUrbanisme {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  private gate(viewer: Viewer, fileId: string, write: boolean) {
    return gateSaleFile({ db: this.db, acces: this.acces, journal: this.journal, now: this.now }, viewer, fileId, write, 'coownership_summary');
  }

  private today(): string {
    return localTime(this.now(), TIME_ZONE).date;
  }

  /** Le jour à Paris d'une heure de collecte, ou null si elle est mal formée ou dans le futur. */
  private dayOf(collectedAt: unknown): string | null {
    if (typeof collectedAt !== 'string' || !ISO.test(collectedAt)) return null;
    const t = Date.parse(collectedAt);
    if (Number.isNaN(t) || t > this.now().getTime()) return null;
    return localTime(new Date(t), TIME_ZONE).date;
  }

  /** Une donnée publique, prise seulement de sa source et datée ; null si elle n'est pas recevable [R449]. */
  publicLine<T>(fact: PublicFact<T> | undefined, source: string, read: (v: T) => T | null): PublicLine<T> | null {
    if (fact === undefined) return { found: false, text: 'non trouvé', source, collectedOn: null, reason: 'non_collecte' };
    if (!fact || typeof fact !== 'object' || fact.source !== source) return null;
    const collectedOn = this.dayOf(fact.collectedAt);
    if (collectedOn === null) return null;
    if (!fact.ok) return fact.reason === 'introuvable' || fact.reason === 'panne' ? { found: false, text: 'non trouvé', source, collectedOn, reason: fact.reason } : null;
    // La date de la donnée : un jour réel, au plus tard celui de la collecte.
    if (!isDay(fact.dataDate) || fact.dataDate > collectedOn) return null;
    const value = read(fact.value);
    return value === null ? null : { found: true, value, source, collectedOn, dataDate: fact.dataDate };
  }

  private registryLine(f: PublicFact<RegistryValue> | undefined) {
    return this.publicLine(f, PUBLIC_SOURCES.registry, (v) => {
      if (!v || typeof v !== 'object' || !isStr(v.immatriculation, 20) || !Number.isInteger(v.lots) || v.lots < 1 || v.lots > 100000) return null;
      if (!['professionnel', 'benevole', 'cooperatif', 'non_connu'].includes(v.syndicType)) return null;
      if (v.constructionPeriod !== null && v.constructionPeriod !== undefined && !isStr(v.constructionPeriod, 40)) return null;
      // Le nom d'un syndic non professionnel peut être celui d'une personne : il n'est pas repris [R16].
      const syndicName = v.syndicType === 'professionnel' && isStr(v.syndicName, 120) ? v.syndicName.trim() : null;
      return { immatriculation: v.immatriculation.trim(), lots: v.lots, syndicType: v.syndicType, syndicName, constructionPeriod: v.constructionPeriod ?? null };
    });
  }

  private urbanismLine(f: PublicFact<UrbanismValue> | undefined) {
    return this.publicLine(f, PUBLIC_SOURCES.urbanism, (v) =>
      v && typeof v === 'object' && ['PLU', 'PLUi', 'carte_communale', 'RNU'].includes(v.documentType) && isStr(v.zone, 20) && isStr(v.label, 200) ? { documentType: v.documentType, zone: v.zone.trim(), label: v.label.trim() } : null,
    );
  }

  /** Les documents fournis, ou null s'ils sont mal formés. */
  private checkDocuments(docs: unknown): SourceDocument[] | null {
    if (!Array.isArray(docs) || docs.length > MAX_DOCS) return null;
    for (const d of docs as SourceDocument[]) {
      if (!d || typeof d !== 'object' || !(DOCUMENT_KINDS as readonly string[]).includes(d.kind) || !isStr(d.ref, 300)) return null;
      if (!Array.isArray(d.pages) || d.pages.length < 1 || d.pages.length > MAX_PAGES || !d.pages.every((p) => typeof p === 'string' && p.length <= 100_000)) return null;
      // Un procès-verbal sans le jour de son assemblée ne dit pas quand les travaux ont été votés.
      if (d.kind === 'pv_assemblee' ? !isDay(d.meetingDay) || d.meetingDay > this.today() : d.meetingDay !== undefined) return null;
    }
    return docs as SourceDocument[];
  }

  /**
   * L'agent du bien prépare le résumé : chaque phrase proposée est vérifiée contre sa page, les données publiques
   * contre leur source et leur date, et chaque vide est dit « non trouvé » [R448 à R452].
   */
  async prepare(viewer: Viewer, fileId: string, input: { documents: SourceDocument[]; sentences: ProposedSentence[]; publicData?: PublicData }): Promise<Res<CoownershipSummary>> {
    const g = await this.gate(viewer, fileId, true);
    if (!g.ok) return g;
    const docs = this.checkDocuments(input?.documents);
    if (!docs) return { ok: false, rule: null, code: 'bad_documents' };
    if (!Array.isArray(input.sentences) || input.sentences.length > MAX_SENTENCES) return { ok: false, rule: null, code: 'too_many' };
    const registry = this.registryLine(input.publicData?.registry);
    const urbanism = this.urbanismLine(input.publicData?.urbanism);
    if (!registry || !urbanism) return { ok: false, rule: null, code: 'bad_public_data' };

    const normalizedPages = docs.map((d) => d.pages.map(normalize));
    const kept: SummarySentence[] = [];
    const rejected: { index: number; reason: RejectReason }[] = [];
    input.sentences.forEach((p, index) => {
      const r = checkSentence(p, docs, normalizedPages);
      if (r.ok) kept.push(r.value);
      else rejected.push({ index, reason: r.reason });
    });

    const hasCoDocs = docs.some((d) => COOWNERSHIP_DOCS.includes(d.kind));
    const hasUrbaDocs = docs.some((d) => URBANISM_DOCS.includes(d.kind));
    const topics: TopicLine[] = TOPICS.map((topic) => {
      const sentences = kept.filter((s) => s.topic === topic);
      if (sentences.length > 0) return { topic, found: true, sentences };
      const anyDoc = (COOWNERSHIP_TOPICS as readonly string[]).includes(topic) ? hasCoDocs : hasUrbaDocs;
      return { topic, found: false, text: 'non trouvé', reason: anyDoc ? 'absent_des_documents' : 'aucun_document' };
    });

    // Les travaux votés encore à venir, à signaler à l'acquéreur [R451].
    const today = this.today();
    const worksToNotify: WorksNotice[] = kept
      .filter((s) => s.topic === 'travaux_votes' && s.cite.kind === 'pv_assemblee' && s.cite.meetingDay !== null)
      .filter((s) => s.works?.dueOn == null || s.works.dueOn >= today)
      .map((s) => ({
        text: s.text,
        votedOn: s.cite.meetingDay as string,
        amountEur: s.works?.amountEur ?? null,
        dueOn: s.works?.dueOn ?? null,
        dueStatus: s.works?.dueOn ? 'a_venir' : 'echeance_non_trouvee',
        cite: s.cite,
      }));

    const documents = await Promise.all(docs.map(async (d) => ({ ref: d.ref, kind: d.kind, pages: d.pages.length, hash: await sha256(JSON.stringify(d.pages)), meetingDay: d.meetingDay ?? null })));
    const body = { documents, topics, registry, urbanism, worksToNotify, rejected };
    const content = JSON.stringify(body);
    const hash = await sha256(content);
    const last = await this.latestRow(fileId);
    const version = last ? Number(last.version) + 1 : 1;
    const id = this.newId();
    const preparedAt = this.now().toISOString();
    try {
      await this.db.run('INSERT INTO coownership_summaries (id, network_id, file_id, version, content, hash, prepared_by, prepared_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, g.file.network_id, fileId, version, content, hash, actorOf(viewer), preparedAt]);
    } catch (error) {
      // Deux préparations au même instant : la seconde trouve sa version prise. Toute autre erreur remonte.
      if (/UNIQUE/i.test(String(error))) return { ok: false, rule: null, code: 'busy' };
      throw error;
    }
    await appendEvent(
      this.journal,
      { type: 'dossier.copropriete_resumee', actor: actorOf(viewer), subject: `sale_file:${fileId}`, data: { summary: id, version, documents: docs.length, kept: kept.length, rejected: rejected.length, notFound: topics.filter((t) => !t.found).length, works: worksToNotify.length } },
      this.now,
    );
    return { ok: true, value: { id, fileId, version, ...body, hash, preparedAt } };
  }

  private async latestRow(fileId: string): Promise<SummaryRow | null> {
    return this.db.first<SummaryRow>('SELECT id, file_id, version, content, hash, prepared_at FROM coownership_summaries WHERE file_id = ? ORDER BY version DESC LIMIT 1', [fileId]);
  }

  /** Le dernier résumé, lu par qui voit le dossier en entier [R16]. */
  async latest(viewer: Viewer, fileId: string): Promise<Res<CoownershipSummary>> {
    const g = await this.gate(viewer, fileId, false);
    if (!g.ok) return g;
    const row = await this.latestRow(fileId);
    if (!row) return { ok: false, rule: null, code: 'no_summary' };
    const body = JSON.parse(row.content) as Omit<CoownershipSummary, 'id' | 'fileId' | 'version' | 'hash' | 'preparedAt'>;
    return { ok: true, value: { id: row.id, fileId: row.file_id, version: Number(row.version), ...body, hash: row.hash, preparedAt: row.prepared_at } };
  }

  /**
   * Ce qui se dit à l'acquéreur des travaux votés à venir, depuis le dernier résumé : chaque ligne nomme l'assemblée et
   * la page du procès-verbal, et l'échéance se rejuge au jour de la lecture [R451]. Aucun nom de copropriétaire.
   */
  async buyerNotice(viewer: Viewer, fileId: string): Promise<Res<{ summaryId: string; lines: string[]; works: WorksNotice[] }>> {
    const r = await this.latest(viewer, fileId);
    if (!r.ok) return r;
    const today = this.today();
    const works = r.value.worksToNotify.filter((w) => w.dueOn === null || w.dueOn >= today);
    const fr = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
    const eur = (n: number) => `${new Intl.NumberFormat('fr-FR').format(n).replace(/ | /g, ' ')} €`;
    const lines = works.map(
      (w) =>
        `Travaux votés en assemblée du ${fr(w.votedOn)} : « ${w.cite.quote} »` +
        `${w.amountEur !== null ? `, ${eur(w.amountEur)}` : ''}` +
        `${w.dueOn !== null ? `, échéance le ${fr(w.dueOn)}` : ', échéance non trouvée'} (procès-verbal, p. ${w.cite.page}).`,
    );
    await appendEvent(this.journal, { type: 'dossier.travaux_votes_signales', actor: actorOf(viewer), subject: `sale_file:${fileId}`, data: { summary: r.value.id, works: works.length } }, this.now);
    return { ok: true, value: { summaryId: r.value.id, lines, works } };
  }
}
