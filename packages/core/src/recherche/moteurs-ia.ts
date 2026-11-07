/**
 * Visibilité dans les moteurs d'IA (HX30) [R429, R430, R431].
 *
 * Trois pièces, sans aucun fichier du socle :
 *
 * 1. Les pages de réponses factuelles d'une commune : des questions de liste fermée (prix au mètre carré, délai de
 *    vente, biens en vente, honoraires), chacune répondue par une phrase fixe tirée d'un seul fait sourcé et daté. Le
 *    code relit chaque réponse rendue : un nombre qui ne vient ni de la valeur ni de la date de la source citée fait
 *    écarter la réponse [R429]. La page porte aussi ses données structurées (FAQPage) avec la citation de chaque source,
 *    pour que ChatGPT, Perplexity ou Google reprennent le chiffre avec sa source.
 * 2. Le fichier de présentation pour les robots d'IA (`/llms.txt`) : le nom du réseau, une phrase sans chiffre, et la
 *    liste des pages publiques de liste fermée, sans chiffre hors la référence d'un bien ; jamais une page privée, une
 *    adresse mail ni un numéro [R429, R431].
 * 3. Le moteur d'IA par lequel un contact est arrivé, lu sur la page d'où il vient ou sur le paramètre `utm_source` que
 *    ces moteurs ajoutent à leurs liens, en liste fermée ; deux moteurs différents, c'est un doute : rien n'est rangé.
 *    Seuls le moteur et la façon de le lire sont gardés [R430, R156]. La mesure du mois, comptée comme celle de AT05,
 *    dit combien de contacts sont venus d'un moteur d'IA, et lequel [R16].
 *
 * Le branchement au Worker (routes `/reponses/…` et `/llms.txt`, lecture de la page d'où vient le contact à la
 * captation) est une tâche de la voie 1 : `app.ts` ne change pas ici.
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { parisDayStart } from '../pilotage/tableau-agent.ts';
import { checkSource, publicUrl, type DataSource, type RejectionReason } from './autour-du-bien.ts';

// ————————————————————————————————————————————— 1. Réponses factuelles

export const FACT_KINDS = ['prix_m2', 'delai_vente', 'biens_en_vente', 'honoraires'] as const;
export type FactKind = (typeof FACT_KINDS)[number];
export const FACT_PROPERTY_KINDS = ['appartement', 'maison'] as const;
export type FactPropertyKind = (typeof FACT_PROPERTY_KINDS)[number];

/** Un fait chiffré, avec sa source nommée, son adresse https et sa date de relevé. */
export interface SourcedFact {
  id: string;
  kind: FactKind;
  /** Pour le prix au mètre carré et le délai de vente seulement. */
  propertyKind?: FactPropertyKind;
  value: number;
  source: DataSource;
}

export type FactRejection = RejectionReason | 'sorte' | 'valeur' | 'doublon' | 'chiffre_sans_source';

export interface Citation {
  name: string;
  url: string;
  date: string;
}

export interface AnswerShown {
  factId: string;
  question: string;
  answer: string;
  citation: Citation;
}

export interface AnswerPage {
  path: string;
  title: string;
  commune: string;
  answers: AnswerShown[];
  /** Les données structurées FAQPage, avec la citation de chaque réponse. */
  jsonLd: string;
  html: string;
}

export type AnswerPageResult =
  | { ok: true; page: AnswerPage; excluded: { factId: string; reason: FactRejection }[] }
  | { ok: false; code: 'bad_commune' | 'bad_intro' | 'aucune_reponse'; excluded: { factId: string; reason: FactRejection }[] };

const COMMUNE = /^\p{Lu}[\p{L}' -]{0,59}$/u;
const KIND_LABELS: Record<FactPropertyKind, { one: string; un: string }> = {
  appartement: { one: 'appartement', un: "d'un appartement" },
  maison: { one: 'maison', un: "d'une maison" },
};
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

/** Ce qu'une valeur doit être, selon sa sorte : jamais un chiffre absurde. */
function validValue(kind: FactKind, value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  switch (kind) {
    case 'prix_m2':
      return Number.isInteger(value) && value >= 100 && value <= 50_000;
    case 'delai_vente':
      return Number.isInteger(value) && value >= 1 && value <= 1000;
    case 'biens_en_vente':
      return Number.isInteger(value) && value >= 0 && value <= 100_000;
    case 'honoraires':
      return value > 0 && value <= 20 && Math.abs(Math.round(value * 100) - value * 100) < 1e-9;
  }
}

/** Un nombre écrit à la française : espace fine insécable pour les milliers, virgule décimale. */
export function frenchNumber(value: number): string {
  const [int, dec] = String(value).split('.');
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f');
  return dec ? `${grouped},${dec}` : grouped;
}

/** Une date `AAAA-MM-JJ` écrite en toutes lettres, sans zéro devant le jour. */
export function frenchDate(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return `${d === 1 ? '1er' : d} ${MONTHS[m! - 1]} ${y}`;
}

const NUMBER_TOKEN = /\d+(?:[\u00a0\u202f ]\d{3})*(?:,\d+)?/g;

/** Les nombres d'un texte, espaces de milliers ôtés. */
export function numbersIn(text: string): string[] {
  return (text.match(NUMBER_TOKEN) ?? []).map((t) => t.replace(/[\u00a0\u202f ]/g, ''));
}

/** Vrai si chaque nombre du texte vient d'une des sources permises : la valeur citée ou la date de sa source [R429]. */
export function everyNumberSourced(text: string, allowed: readonly string[]): boolean {
  const ok = new Set(allowed.flatMap((a) => numbersIn(a)));
  return numbersIn(text).every((n) => ok.has(n));
}

function question(fact: SourcedFact, commune: string): string {
  const k = fact.propertyKind ? KIND_LABELS[fact.propertyKind] : null;
  switch (fact.kind) {
    case 'prix_m2':
      return `Quel est le prix au mètre carré ${k!.un} à ${commune} ?`;
    case 'delai_vente':
      return `En combien de temps se vend ${k!.one === 'maison' ? 'une maison' : 'un appartement'} à ${commune} ?`;
    case 'biens_en_vente':
      return `Combien de biens le réseau a-t-il en vente à ${commune} ?`;
    case 'honoraires':
      return `Quels sont les honoraires du réseau pour une vente à ${commune} ?`;
  }
}

function answerText(fact: SourcedFact, commune: string): string {
  const v = frenchNumber(fact.value);
  const k = fact.propertyKind ? KIND_LABELS[fact.propertyKind] : null;
  const src = `d'après ${fact.source.name.trim()}, relevé du ${frenchDate(fact.source.date)}`;
  switch (fact.kind) {
    case 'prix_m2':
      return `Le prix médian ${k!.un} à ${commune} est de ${v} € le mètre carré, ${src}.`;
    case 'delai_vente':
      return `${k!.one === 'maison' ? 'Une maison' : 'Un appartement'} à ${commune} se vend en ${v} jours en médiane, ${src}.`;
    case 'biens_en_vente':
      return `Le réseau a ${v} ${fact.value > 1 ? 'biens' : 'bien'} en vente à ${commune}, ${src}.`;
    case 'honoraires':
      return `Les honoraires du réseau sont de ${v} % du prix de vente, ${src}.`;
  }
}

function slug(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z]+/g, '-')
    .replace(/^-|-$/g, '');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Du JSON qui ne peut jamais fermer la balise `<script>` qui le porte. */
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

/**
 * La page de réponses factuelles d'une commune. Un fait sans source sûre, sans date valable, d'une sorte inconnue,
 * d'une valeur absurde, ou en double contradictoire pour la même question est écarté et dit ; une réponse dont un
 * nombre ne vient pas de sa source est écartée ; une phrase d'introduction ne porte aucun chiffre [R429].
 */
export function answerPage(communeInput: unknown, facts: readonly SourcedFact[], now: number, intro?: unknown): AnswerPageResult {
  const excluded: { factId: string; reason: FactRejection }[] = [];
  if (typeof communeInput !== 'string' || !COMMUNE.test(communeInput.trim())) return { ok: false, code: 'bad_commune', excluded };
  const commune = communeInput.trim();
  let introText: string | null = null;
  if (intro !== undefined) {
    if (typeof intro !== 'string' || intro.trim() === '' || intro.length > 400 || !everyNumberSourced(intro, [])) return { ok: false, code: 'bad_intro', excluded };
    introText = intro.trim();
  }
  // Un fait par question : le plus récent ; deux faits du même jour qui disent autre chose, c'est un doute.
  const byQuestion = new Map<string, SourcedFact[]>();
  for (const f of facts) {
    const id = typeof f?.id === 'string' ? f.id : '';
    if (!(FACT_KINDS as readonly string[]).includes(f?.kind)) {
      excluded.push({ factId: id, reason: 'sorte' });
      continue;
    }
    const needsKind = f.kind === 'prix_m2' || f.kind === 'delai_vente';
    if (needsKind ? !(FACT_PROPERTY_KINDS as readonly string[]).includes(f.propertyKind as string) : f.propertyKind !== undefined) {
      excluded.push({ factId: id, reason: 'sorte' });
      continue;
    }
    if (!validValue(f.kind, f.value)) {
      excluded.push({ factId: id, reason: 'valeur' });
      continue;
    }
    const bad = checkSource(f.source, now) ?? (publicUrl(f.source.url) === null ? 'source' : null);
    if (bad) {
      excluded.push({ factId: id, reason: bad });
      continue;
    }
    const key = `${f.kind}:${f.propertyKind ?? ''}`;
    byQuestion.set(key, [...(byQuestion.get(key) ?? []), f]);
  }
  const answers: AnswerShown[] = [];
  const order = (k: string) => FACT_KINDS.indexOf(k.split(':')[0] as FactKind) * 10 + FACT_PROPERTY_KINDS.indexOf(k.split(':')[1] as FactPropertyKind);
  for (const key of [...byQuestion.keys()].sort((a, b) => order(a) - order(b))) {
    const group = byQuestion.get(key)!.slice().sort((a, b) => b.source.date.localeCompare(a.source.date));
    const latest = group[0]!;
    const sameDay = group.filter((f) => f.source.date === latest.source.date);
    if (sameDay.some((f) => f.value !== latest.value)) {
      for (const f of sameDay) excluded.push({ factId: f.id, reason: 'doublon' });
      continue;
    }
    for (const f of group.slice(1)) excluded.push({ factId: f.id, reason: 'doublon' });
    const q = question(latest, commune);
    const a = answerText(latest, commune);
    const cited = [frenchNumber(latest.value), frenchDate(latest.source.date)];
    // La relecture : tout nombre de la question et de la réponse vient du fait cité, et le nom de la source n'en ajoute pas.
    if (!everyNumberSourced(q, []) || !everyNumberSourced(a, cited) || numbersIn(latest.source.name).length > 0) {
      excluded.push({ factId: latest.id, reason: 'chiffre_sans_source' });
      continue;
    }
    answers.push({ factId: latest.id, question: q, answer: a, citation: { name: latest.source.name.trim(), url: publicUrl(latest.source.url)!, date: latest.source.date } });
  }
  if (answers.length === 0) return { ok: false, code: 'aucune_reponse', excluded };
  const title = `Immobilier à ${commune} : les réponses, chiffres sourcés`;
  const jsonLd = safeJson({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    name: title,
    mainEntity: answers.map((x) => ({
      '@type': 'Question',
      name: x.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: x.answer,
        citation: { '@type': 'CreativeWork', name: x.citation.name, url: x.citation.url, datePublished: x.citation.date },
      },
    })),
  });
  const html = [
    `<article class="reponses" lang="fr">`,
    `<h1>${escapeHtml(title)}</h1>`,
    introText ? `<p class="reponses-intro">${escapeHtml(introText)}</p>` : '',
    ...answers.map(
      (x) =>
        `<section class="reponse"><h2>${escapeHtml(x.question)}</h2><p>${escapeHtml(x.answer)}</p>` +
        `<p class="reponse-source">Source : <a href="${escapeHtml(x.citation.url)}" rel="nofollow noopener">${escapeHtml(x.citation.name)}</a>, ` +
        `<time datetime="${x.citation.date}">${escapeHtml(frenchDate(x.citation.date))}</time></p></section>`,
    ),
    `<script type="application/ld+json">${jsonLd}</script>`,
    `</article>`,
  ]
    .filter((l) => l !== '')
    .join('\n');
  return { ok: true, page: { path: `/reponses/${slug(commune)}`, title, commune, answers, jsonLd, html }, excluded };
}

// ————————————————————————————————————————————— 2. Fichier pour les robots d'IA

export const LLMS_ENTRY_KINDS = ['reponses', 'prix', 'quartier', 'bien', 'simulateur'] as const;
export type LlmsEntryKind = (typeof LLMS_ENTRY_KINDS)[number];

export interface LlmsEntry {
  kind: LlmsEntryKind;
  path: string;
  title: string;
}

export type LlmsRejection = 'sorte' | 'chemin' | 'titre' | 'chiffre' | 'donnee_personnelle';

export type LlmsResult =
  | { ok: true; text: string; excluded: { path: string; reason: LlmsRejection }[] }
  | { ok: false; code: 'bad_site' | 'bad_name' | 'bad_summary' };

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SECTION_TITLES: Record<LlmsEntryKind, string> = {
  reponses: 'Réponses sourcées',
  prix: 'Prix de l\'immobilier',
  quartier: 'Quartiers',
  bien: 'Biens en vente',
  simulateur: 'Outils',
};

/** Le chemin d'une page publique de liste fermée ; rien d'autre n'entre dans le fichier [R431]. */
export function llmsPathFits(kind: LlmsEntryKind, path: string): boolean {
  const parts = path.split('/').slice(1);
  if (!path.startsWith('/') || parts.some((p) => p === '')) return false;
  switch (kind) {
    case 'reponses':
      return parts.length === 2 && parts[0] === 'reponses' && SLUG.test(parts[1]!);
    case 'prix':
      return (parts.length === 2 || parts.length === 3) && parts[0] === 'prix' && parts.slice(1).every((p) => SLUG.test(p));
    case 'quartier':
      return parts.length === 3 && parts[0] === 'quartiers' && SLUG.test(parts[1]!) && SLUG.test(parts[2]!);
    case 'bien':
      return parts.length === 2 && parts[0] === 'biens' && ID.test(parts[1]!);
    case 'simulateur':
      return parts.length === 1 && parts[0] === 'simulateur';
  }
}

/** Une référence de bien du réseau, telle qu'elle est publiée. */
const PROPERTY_REF = /\b[A-Z]{2,}(?:-[A-Z0-9]+)+\b/g;
const MAIL = /[^\s@]+@[^\s@]+/;
const PHONE = /(?:\+|\b0)\d(?:[\s.-]?\d){7,}/;

/** Vrai si le texte porte une adresse mail ou un numéro de téléphone. */
export function looksPersonal(text: string): boolean {
  return MAIL.test(text) || PHONE.test(text);
}

function cleanLine(text: unknown, max: number): string | null {
  if (typeof text !== 'string') return null;
  const t = text.replace(/\s+/g, ' ').trim();
  if (t === '' || t.length > max || /[[\]()<>`#*_\\]/.test(t)) return null;
  return t;
}

/**
 * Le fichier `/llms.txt` d'un site en service du réseau : son nom, une phrase sans chiffre ni donnée personnelle, et ses
 * pages publiques de liste fermée, groupées par sorte. Une page d'une autre sorte, d'un chemin hors liste, au titre vide
 * ou qui porte une adresse mail ou un numéro est écartée et dite [R431].
 */
export function llmsTxt(site: { name: unknown; baseUrl: unknown; summary: unknown }, entries: readonly LlmsEntry[]): LlmsResult {
  const base = publicUrl(site.baseUrl);
  if (!base || new URL(base).pathname !== '/') return { ok: false, code: 'bad_site' };
  const origin = new URL(base).origin;
  const name = cleanLine(site.name, 80);
  if (!name || looksPersonal(name) || numbersIn(name).length > 0) return { ok: false, code: 'bad_name' };
  const summary = cleanLine(site.summary, 300);
  if (!summary || looksPersonal(summary) || numbersIn(summary).length > 0) return { ok: false, code: 'bad_summary' };
  const excluded: { path: string; reason: LlmsRejection }[] = [];
  const groups = new Map<LlmsEntryKind, string[]>();
  const seen = new Set<string>();
  for (const e of entries) {
    const path = typeof e?.path === 'string' ? e.path : '';
    if (!(LLMS_ENTRY_KINDS as readonly string[]).includes(e?.kind)) {
      excluded.push({ path, reason: 'sorte' });
      continue;
    }
    if (!llmsPathFits(e.kind, path)) {
      excluded.push({ path, reason: 'chemin' });
      continue;
    }
    if (typeof e.title === 'string' && looksPersonal(e.title)) {
      excluded.push({ path, reason: 'donnee_personnelle' });
      continue;
    }
    const title = cleanLine(e.title, 120);
    if (!title) {
      excluded.push({ path, reason: 'titre' });
      continue;
    }
    // Aucun chiffre dans un titre, hors la référence d'un bien (« REF-1 »), qui n'est pas un chiffre publié [R429].
    if (numbersIn(e.kind === 'bien' ? title.replace(PROPERTY_REF, '') : title).length > 0) {
      excluded.push({ path, reason: 'chiffre' });
      continue;
    }
    if (seen.has(path)) continue;
    seen.add(path);
    groups.set(e.kind, [...(groups.get(e.kind) ?? []), `- [${title}](${origin}${path})`]);
  }
  const lines = [`# ${name}`, '', `> ${summary}`, '', 'Chaque chiffre de ces pages cite sa source et sa date de relevé.'];
  for (const kind of LLMS_ENTRY_KINDS) {
    const g = groups.get(kind);
    if (g) lines.push('', `## ${SECTION_TITLES[kind]}`, '', ...g);
  }
  return { ok: true, text: `${lines.join('\n')}\n`, excluded };
}

// ————————————————————————————————————————————— 3. Contacts venus d'un moteur d'IA

export const AI_ENGINES = ['chatgpt', 'perplexity', 'gemini', 'copilot', 'claude', 'mistral', 'deepseek'] as const;
export type AiEngine = (typeof AI_ENGINES)[number];
export const AI_ENGINE_LABELS: Record<AiEngine, string> = {
  chatgpt: 'ChatGPT',
  perplexity: 'Perplexity',
  gemini: 'Gemini',
  copilot: 'Copilot',
  claude: 'Claude',
  mistral: 'Le Chat de Mistral',
  deepseek: 'DeepSeek',
};
export type AiEngineMethod = 'referent' | 'utm';

/** Les adresses exactes des moteurs ; jamais une fin d'adresse, qu'un autre site pourrait imiter. */
const ENGINE_HOSTS: Readonly<Record<string, AiEngine>> = Object.freeze({
  'chatgpt.com': 'chatgpt',
  'chat.openai.com': 'chatgpt',
  'perplexity.ai': 'perplexity',
  'www.perplexity.ai': 'perplexity',
  'gemini.google.com': 'gemini',
  'copilot.microsoft.com': 'copilot',
  'claude.ai': 'claude',
  'chat.mistral.ai': 'mistral',
  'chat.deepseek.com': 'deepseek',
});
/** Les valeurs de `utm_source` que ces moteurs mettent à leurs liens. */
const ENGINE_UTM: Readonly<Record<string, AiEngine>> = Object.freeze({
  'chatgpt.com': 'chatgpt',
  chatgpt: 'chatgpt',
  openai: 'chatgpt',
  'perplexity.ai': 'perplexity',
  perplexity: 'perplexity',
  'gemini.google.com': 'gemini',
  gemini: 'gemini',
  'copilot.microsoft.com': 'copilot',
  copilot: 'copilot',
  'claude.ai': 'claude',
  claude: 'claude',
  'chat.mistral.ai': 'mistral',
  mistral: 'mistral',
  'chat.deepseek.com': 'deepseek',
  deepseek: 'deepseek',
});

/** Ce que la page de captation transmet : le lien d'arrivée, la page d'arrivée et la page d'où vient la personne. */
export interface AiEngineSignals {
  link?: unknown;
  landingPage?: unknown;
  referrer?: unknown;
}

/** Le moteur d'une liste, seulement s'il y est écrit : jamais une propriété héritée (`constructor`, `__proto__`) [R430]. */
function ownEngine(map: Readonly<Record<string, AiEngine>>, key: string): AiEngine | null {
  if (!Object.hasOwn(map, key)) return null;
  const engine = map[key];
  return typeof engine === 'string' && (AI_ENGINES as readonly string[]).includes(engine) ? engine : null;
}

function httpsUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2000) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '' ? url : null;
  } catch {
    return null;
  }
}

/**
 * Le moteur d'IA d'où vient un contact, lu en liste fermée : l'adresse exacte de la page d'où il vient, ou un seul
 * `utm_source` connu sur le lien ou la page d'arrivée. Deux moteurs différents, ou deux `utm_source`, c'est un doute :
 * rien n'est deviné [R430]. Google, Bing et les autres moteurs de recherche ne sont pas des moteurs d'IA ici : leur
 * réponse générée ne se distingue pas de leurs liens.
 */
export function aiEngineOf(signals: AiEngineSignals): { engine: AiEngine; method: AiEngineMethod } | null {
  const found: { engine: AiEngine; method: AiEngineMethod }[] = [];
  const ref = httpsUrl(signals.referrer);
  if (ref) {
    const engine = ownEngine(ENGINE_HOSTS, ref.hostname.toLowerCase());
    if (engine) found.push({ engine, method: 'referent' });
  }
  for (const value of [signals.link, signals.landingPage]) {
    const url = httpsUrl(value);
    if (!url) continue;
    const sources = url.searchParams.getAll('utm_source');
    if (sources.length > 1) return null;
    if (sources.length === 0) continue;
    const engine = ownEngine(ENGINE_UTM, sources[0]!.trim().toLowerCase());
    if (engine) found.push({ engine, method: 'utm' });
  }
  if (found.length === 0) return null;
  if (found.some((f) => f.engine !== found[0]!.engine)) return null;
  return found[0]!;
}

export type AiRecordResult =
  | { ok: true; engine: AiEngine | null; already: boolean }
  | { ok: false; code: 'unknown_inbound' };

export interface AiEngineMeasure {
  month: string;
  /** Contacts du mois, comptés comme dans la mesure de AT05 : une conversation, le mois de son premier message. */
  contacts: number;
  /** Contacts venus d'un moteur d'IA. */
  fromAi: number;
  /** La part, en dixièmes de pour cent arrondis vers le bas. */
  percent: number;
  byEngine: { engine: AiEngine; label: string; contacts: number }[];
}

export type AiMeasureResult = { ok: true; measure: AiEngineMeasure } | { ok: false; rule: 'R16' | null; code: string };

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

function monthStart(year: number, month: number): string {
  const y = month > 12 ? year + 1 : year;
  const m = month > 12 ? 1 : month;
  return parisDayStart(`${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-01`).toISOString();
}

export interface MoteursIaOptions {
  now?: () => Date;
  newId?: () => string;
}

export class MoteursIa {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: MoteursIaOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /**
   * Range le moteur d'IA d'un message reçu, une seule fois : la première lecture compte. Sans moteur lu, rien n'est
   * rangé. Seuls le moteur et la façon de le lire sont gardés [R430, R156].
   */
  async record(networkId: string, inboundId: string, signals: AiEngineSignals = {}): Promise<AiRecordResult> {
    const row = await this.db.first<{ id: string }>('SELECT id FROM inbound_messages WHERE id = ? AND network_id = ?', [inboundId, networkId]);
    if (!row) return { ok: false, code: 'unknown_inbound' };
    const existing = await this.stored(inboundId);
    if (existing) return { ok: true, engine: existing, already: true };
    const found = aiEngineOf(signals);
    if (!found) return { ok: true, engine: null, already: false };
    const inserted = await this.db.run('INSERT OR IGNORE INTO contact_ai_engines (id, network_id, inbound_id, engine, method, recorded_at) VALUES (?, ?, ?, ?, ?, ?)', [
      this.newId(),
      networkId,
      inboundId,
      found.engine,
      found.method,
      this.now().toISOString(),
    ]);
    const kept = (await this.stored(inboundId))!;
    const already = inserted.changes === 0;
    if (!already) {
      await appendEvent(this.journal, { type: 'recherche.moteur_ia', actor: 'system', subject: `inbound:${inboundId}`, data: { rule: 'R430', engine: found.engine, method: found.method } }, this.now);
    }
    return { ok: true, engine: kept, already };
  }

  /** Le moteur rangé d'un message reçu, s'il y en a un. */
  async stored(inboundId: string): Promise<AiEngine | null> {
    return (await this.db.first<{ engine: AiEngine }>('SELECT engine FROM contact_ai_engines WHERE inbound_id = ?', [inboundId]))?.engine ?? null;
  }

  /**
   * La mesure d'un mois (`AAAA-MM`, heure de Paris) : les contacts comptés comme dans AT05, et ceux venus d'un moteur
   * d'IA, classés par le premier message de la conversation qui en a un. Réservée à la direction [R16].
   */
  async measure(viewer: Viewer, month: unknown): Promise<AiMeasureResult> {
    if (viewer.role !== 'direction') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: null, data: { rule: 'R16', kind: 'moteurs_ia_mesure', code: 'role' } }, this.now);
      return { ok: false, rule: 'R16', code: 'role' };
    }
    const m = typeof month === 'string' ? MONTH.exec(month) : null;
    if (!m) return { ok: false, rule: null, code: 'bad_month' };
    const from = monthStart(Number(m[1]), Number(m[2]));
    const to = monthStart(Number(m[1]), Number(m[2]) + 1);
    const rows = await this.db.all<{ first_at: string; known: string | null }>(
      `SELECT min(m.received_at) AS first_at,
              min(CASE WHEN e.engine IS NOT NULL THEN m.received_at || '|' || m.id || '|' || e.engine END) AS known
         FROM inbound_messages m LEFT JOIN contact_ai_engines e ON e.inbound_id = m.id AND e.network_id = m.network_id
        WHERE m.network_id = ? AND m.status <> 'unreadable' AND m.kind <> 'unreadable'
        GROUP BY m.channel, coalesce(m.conversation_ref, m.kind || ':' || m.external_id, m.id)
       HAVING min(m.received_at) >= ? AND min(m.received_at) < ?`,
      [viewer.networkId, from, to],
    );
    const counts = new Map<AiEngine, number>();
    for (const r of rows) {
      if (!r.known) continue;
      const engine = r.known.slice(r.known.lastIndexOf('|') + 1) as AiEngine;
      counts.set(engine, (counts.get(engine) ?? 0) + 1);
    }
    const fromAi = [...counts.values()].reduce((a, b) => a + b, 0);
    const byEngine = [...counts]
      .map(([engine, contacts]) => ({ engine, label: AI_ENGINE_LABELS[engine], contacts }))
      .sort((a, b) => b.contacts - a.contacts || a.engine.localeCompare(b.engine));
    return {
      ok: true,
      measure: { month: month as string, contacts: rows.length, fromAi, percent: rows.length === 0 ? 0 : Math.floor((fromAi * 1000) / rows.length) / 10, byEngine },
    };
  }
}
