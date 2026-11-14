/**
 * Les documents de la copropriété prélus, chaque phrase retrouvée sur sa ligne (RC42) [R448, R450, R15, R12, R13, R16].
 *
 * Le résumé de HX35 est fait de phrases proposées puis vérifiées par le code. Jusqu'ici, seul l'agent les proposait, en
 * recopiant chaque extrait. Désormais il peut demander une prélecture : un lecteur (l'IA, derrière une interface)
 * reçoit seulement les lignes qui parlent d'une rubrique du résumé, chacune avec son numéro, réduites à un vocabulaire
 * fermé de la copropriété et de l'urbanisme. Tout autre mot devient « … », un mot à capitale au milieu d'une phrase
 * aussi (un nom propre) ; une ligne qui porte un IBAN, une pièce d'identité ou une naissance n'est jamais envoyée ; les
 * mails et les longs numéros sont masqués [R15]. Un procès-verbal nomme les copropriétaires : aucun nom ne sort.
 *
 * « Jamais vu » : ce que rend le lecteur n'est pas cru. Il ne cite pas, il désigne une ligne ; l'extrait est la ligne
 * même du document, et seulement si aucun de ses mots n'a été masqué : un nom ne peut donc jamais entrer dans un
 * extrait. La phrase proposée ne porte que des mots de ce vocabulaire ou de sa ligne, puis `checkSentence` la juge
 * comme une phrase de l'agent [R448]. Un montant ou une échéance de travaux qui ne se lisent pas dans la ligne sont
 * retirés, la phrase reste. Chaque rubrique sans phrase retenue est dite « à lire » [R450].
 *
 * La prélecture ne range rien : l'agent relit les phrases et prépare le résumé par `CoproprieteUrbanisme.prepare`.
 * Lecteur absent, en panne, trop lent ou réponse illisible : aucune phrase, tout à lire, jamais une erreur [R12].
 * Seul l'agent du dossier prélit [R16]. Au journal : la source, des rubriques et des nombres, jamais une phrase, une
 * ligne ni un montant [R13].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { actorOf, gateSaleFile, type FileRefusal, type FileUnknown } from '../dossiers/acces-dossier.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { COOWNERSHIP_TOPICS, DOCUMENT_KINDS, TOPICS, checkSentence, normalize, type DocumentKind, type ProposedSentence, type SourceDocument, type Topic } from './copropriete-urbanisme.ts';

/** Une ligne envoyée au lecteur : son numéro dans la page, et son texte réduit au vocabulaire [R15]. */
export interface CoproExcerptLine {
  line: number;
  text: string;
}

/** Ce que reçoit le lecteur : des lignes de pages, jamais une page entière. */
export interface CoproExcerpt {
  document: number;
  kind: DocumentKind;
  page: number;
  lines: CoproExcerptLine[];
}

/**
 * Le lecteur (l'IA). Il rend `{ sentences: [{ topic, text, document, page, line, works? }] }` ; rien n'en est cru tel
 * quel.
 */
export interface CoproReader {
  read(excerpts: CoproExcerpt[]): Promise<unknown>;
}

export interface CoproPreReading {
  source: 'ia' | 'manuel';
  /** Des phrases prêtes pour `prepare`, chacune avec la ligne entière du document pour extrait. */
  sentences: ProposedSentence[];
  /** Les rubriques sans phrase retenue alors qu'un document de leur domaine est fourni : à lire par l'agent [R450]. */
  toRead: Topic[];
  /** Le nombre de phrases rendues par le lecteur et écartées. */
  dropped: number;
}

type Problem = { ok: false; rule: null; code: 'bad_documents' };

const TIME_ZONE = 'Europe/Paris';
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_DOCS = 30;
const MAX_PAGES = 400;
const MAX_PAGE_CHARS = 100_000;
const MAX_LINE_CHARS = 300;
const MAX_QUOTE_CHARS = 600;
const MAX_LINES_PER_PAGE = 40;
const MAX_LINES = 600;
const MAX_READER_SENTENCES = 100;

const COOWNERSHIP_DOCS: readonly DocumentKind[] = ['pv_assemblee', 'reglement_copropriete', 'fiche_synthetique', 'carnet_entretien', 'appels_de_fonds'];

/** Les lignes qui parlent d'une rubrique du résumé. */
const USEFUL =
  /travaux|ravalement|toiture|fa[çc]ade|ascenseur|r[ée]fection|r[ée]novation|isolation|[ée]tanch[ée]it[ée]|chaudi[èe]re|chauffage|remplacement|mise aux normes|devis|[ée]tude|proc[ée]dure|contentieux|tribunal|assignation|litige|expertise|impay[ée]|arri[ée]r[ée]|d[ée]biteur|recouvrement|charges|budget|appel de fonds|appels de fonds|fonds de travaux|syndic|zone|servitude|pr[ée]emption|alignement|secteur|monument|emplacement r[ée]serv[ée]|\bvot[ée]|adopt[ée]|approuv[ée]|d[ée]cide/i;
/** Une ligne qui porte de quoi identifier une personne ou un compte ne part jamais au lecteur [R15]. */
const NEVER_SENT = /\biban\b|\bbic\b|\brib\b|\bswift\b|\bFR\d{2}(?:[  ]?[0-9A-Z]{4}){2,}|passeport|carte (?:nationale )?d.identit[ée]|titre de s[ée]jour|permis de conduire|\bn[ée]e?s? (?:le|à|a)\b|date de naissance|lieu de naissance|s[ée]curit[ée] sociale|num[ée]ro fiscal/i;
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu;
/** Un téléphone, un numéro de compte ou de personne : 9 chiffres ou plus coupés de séparateurs, ou précédé de « + ». */
const LONG_NUMBER = /\+\s?\(?\d[\d\s.\/()-]*\d|\(?\d[\d\s.\/()-]*\d\)?/g;
const digitCount = (s: string): number => s.replace(/\D/g, '').length;

const MONTHS = 'janvier février fevrier mars avril mai juin juillet août aout septembre octobre novembre décembre decembre er';

/**
 * Les seuls mots qui passent au lecteur, en minuscules. Aucune civilité (« M », « Mme », « Monsieur », « Madame »,
 * « Maître »), aucun prénom : un mot hors de cette liste devient « … » [R15].
 */
export const COPRO_WORDS: ReadonlySet<string> = new Set(
  (
    // Mots outils.
    'a à au aux le la les l de du des d un une en dans sur sous par pour avec sans entre et ou ni ne n pas plus moins ' +
    'qui que qu dont où ce cet cette ces son sa ses leur leurs il ils elle elles on se s y est sont été être sera seront ' +
    'serait a ont avait aura auront doit doivent devra devront peut peuvent fait faite faits faites lors après avant depuis ' +
    'pendant jusqu jusqu’ au-delà soit tout tous toute toutes chaque aucun aucune non oui également encore déjà ' +
    'premier première deuxième second seconde dernier dernière prochain prochaine même autre autres selon suite afin ' +
    // L'assemblée et ses décisions.
    'assemblée assemblee générale generale ordinaire extraordinaire résolution resolution résolutions procès-verbal procès verbal ' +
    'décide decide décidé décidée décident vote vote votée votés votées voté voter adopte adoptée adopté adoptés adoptées adopter ' +
    'approuve approuvé approuvée approuvés approuvées approuver rejeté rejetée rejetés rejetées refusé refusée majorité ' +
    'article articles unanimité quorum tantièmes copropriétaires copropriétaire copropriété copropriete syndicat conseil ' +
    'syndical syndic professionnel bénévole coopératif mandat contrat désigné désignée nommé nommée renouvelé renouvelée ' +
    'mission durée an ans mois jour jours date échéance exigible exigibles appel appels fonds fonds versement versements ' +
    'trimestre trimestriel trimestriels semestre annuel annuelle annuels exercice clos comptes budget prévisionnel ' +
    'charges charge courantes courant générales spéciales quote-part quote part lot lots montant total somme sommes ' +
    'euros euro eur ttc ht tva cotisation cotisations réserve réserves ' +
    // Les travaux.
    'travaux ravalement façade façades rue cour toiture toiture-terrasse terrasse couverture réfection rénovation ' +
    'isolation thermique étanchéité ascenseur ascenseurs chaudière chauffage collectif collective eau chaude canalisations ' +
    'colonnes colonne montante plomberie électricité électrique mise normes norme sécurité incendie portes porte fenêtres ' +
    'menuiseries boîtes lettres entrée hall escalier escaliers cage parties communes commune caves parking parkings ' +
    'interphone digicode peinture remplacement réparation réparations entretien diagnostic technique global plan ' +
    'pluriannuel audit énergétique devis étude études entreprise entreprises maître œuvre architecte bureau ' +
    'réaliser réalisé réalisés réalisée réalisées réalisation commencer commencés commencé engagés engagé terminés ' +
    'terminé achevés prévus prévu prévue prévues présenter présentés présenté nécessaire nécessaires urgents urgent ' +
    'importants important ' +
    // Procédures et impayés.
    'procédure procédures judiciaire judiciaires contentieux tribunal assignation litige litiges expertise instance ' +
    'cours en-cours contre engagée engagées impayé impayés impayées arriéré arriérés débiteur débiteurs recouvrement ' +
    'créance créances dette dettes ' +
    // L'urbanisme.
    'zone zones urbaine urbaines naturelle agricole secteur secteurs plu plui rnu carte servitude servitudes utilité ' +
    'publique protection monuments monument historiques historique périmètre droit préemption urbain renforcé ' +
    'alignement emplacement réservé constructions construction nouvelles nouvelle hauteur maximale règlement ' +
    'document documents fiche synthétique carnet centrale central centre ville bien biens immeuble résidence bâtiment ' +
    'classé classée situé située ' +
    MONTHS
  ).split(/\s+/),
);

/** Des sigles admis en capitales. */
const ACRONYMS = new Set(['ttc', 'ht', 'tva', 'plu', 'plui', 'rnu', 'eur', 'dpe']);
/** Un code de zone d'urbanisme (« UA », « 1AUb », « Nh »), seulement juste après « zone », « secteur » ou « article ». */
const ZONE_CODE = /^(?:AU|U|N|A)[A-Z]?[a-z]?$/;
const ZONE_BEFORE = /(?:zones?|secteurs?|article)\s+\d?$/i;

/**
 * Un mot qui passe : de la liste, écrit en minuscules, avec une capitale en tête de phrase seulement, en capitales
 * s'il est un sigle ; un code de zone après « zone ». Tout autre mot, un nom propre au milieu d'une phrase compris,
 * est masqué [R15].
 */
function wordPasses(word: string, before: string): boolean {
  const lower = word.toLowerCase();
  if (ZONE_CODE.test(word) && ZONE_BEFORE.test(before)) return true;
  if (word.length > 1 && word === word.toUpperCase() && ACRONYMS.has(lower)) return true;
  if (!COPRO_WORDS.has(lower)) return false;
  if (word === lower) return true;
  // Une capitale (ou un titre en capitales, « TRAVAUX ») en tête de phrase seulement : début de ligne, après un point
  // ou un numéro (« 3) Travaux »). Après un deux-points (« Vote contre : Porte »), une virgule ou au milieu d'une
  // phrase, c'est peut-être un nom : masqué.
  const head = word.slice(1) === lower.slice(1) || word === word.toUpperCase();
  const tail = before.replace(/[\s\d°()«»"'’-]+$/u, '');
  return head && (tail === '' || /[.!?]$/.test(tail));
}

/** Une ligne réduite au vocabulaire, et si elle a dû être masquée [R15]. */
export function skeletonOf(line: string): { text: string; masked: boolean } {
  let masked = false;
  let t = line.replace(EMAIL, () => {
    masked = true;
    return ' … ';
  });
  t = t.replace(LONG_NUMBER, (n) => {
    if (n.trimStart().startsWith('+') || digitCount(n) >= 9) {
      masked = true;
      return ' … ';
    }
    return n;
  });
  t = t.replace(/\p{L}+/gu, (w, offset: number, all: string) => {
    if (wordPasses(w, all.slice(0, offset))) return w;
    masked = true;
    return '…';
  });
  return { text: t.replace(/…(?:[\s'’.,-]*…)+/g, '…').replace(/\s+/g, ' ').trim(), masked };
}

/** Les lignes d'une page, la première a le numéro 1. */
const linesOf = (page: string): string[] => page.split(/\r?\n/);

/** Les lignes envoyées au lecteur : utiles, sans ce qui ne doit pas sortir, réduites au vocabulaire [R15]. */
export function coproExcerptsOf(docs: readonly SourceDocument[]): CoproExcerpt[] {
  const out: CoproExcerpt[] = [];
  let total = 0;
  docs.forEach((doc, d) => {
    doc.pages.forEach((page, p) => {
      const lines: CoproExcerptLine[] = [];
      linesOf(page).forEach((raw, i) => {
        const l = raw.trim();
        if (lines.length >= MAX_LINES_PER_PAGE || total + lines.length >= MAX_LINES) return;
        if (l.length === 0 || !USEFUL.test(l) || NEVER_SENT.test(l)) return;
        const text = skeletonOf(l).text.slice(0, MAX_LINE_CHARS);
        if (/\p{L}{2,}|\d/u.test(text.replace(/…/g, ''))) lines.push({ line: i + 1, text });
      });
      if (lines.length > 0) {
        out.push({ document: d, kind: doc.kind, page: p + 1, lines });
        total += lines.length;
      }
    });
  });
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/** La ligne citée, si elle peut servir d'extrait : envoyable, rien de masqué, pas trop longue. */
function quotableLine(docs: readonly SourceDocument[], document: unknown, page: unknown, line: unknown): string | null {
  if (!isInt(document, 0, docs.length - 1)) return null;
  const doc = docs[document]!;
  if (!isInt(page, 1, doc.pages.length)) return null;
  const lines = linesOf(doc.pages[page - 1]!);
  if (!isInt(line, 1, lines.length)) return null;
  const l = lines[line - 1]!.trim();
  if (l.length === 0 || l.length > MAX_QUOTE_CHARS || NEVER_SENT.test(l) || skeletonOf(l).masked) return null;
  return l;
}

/** Chaque mot de la phrase est du vocabulaire ou de sa ligne : aucun nom ni mot inventé n'entre dans le résumé [R15]. */
function wordsAllowed(text: string, quote: string): boolean {
  const inQuote = new Set(quote.match(/\p{L}+/gu) ?? []);
  return (text.match(/\p{L}+/gu) ?? []).every((w) => {
    const lower = w.toLowerCase();
    return COPRO_WORDS.has(lower) || ACRONYMS.has(lower) || (ZONE_CODE.test(w) && inQuote.has(w));
  });
}

/**
 * Ne garde de ce que rend le lecteur que les phrases dont la ligne citée sert d'extrait et que `checkSentence` accepte ;
 * un montant ou une échéance de travaux absents de la ligne sont retirés, la phrase reste [R448].
 */
export function verifyCoproReading(docs: readonly SourceDocument[], raw: unknown): { sentences: ProposedSentence[]; dropped: number } {
  const given = isRecord(raw) && Array.isArray(raw.sentences) ? raw.sentences : [];
  const normalizedPages = docs.map((d) => d.pages.map(normalize));
  const sentences: ProposedSentence[] = [];
  const seen = new Set<string>();
  let dropped = Math.max(0, given.length - MAX_READER_SENTENCES);
  for (const s of given.slice(0, MAX_READER_SENTENCES)) {
    const quote = isRecord(s) ? quotableLine(docs, s.document, s.page, s.line) : null;
    const key = isRecord(s) ? `${String(s.topic)}|${String(s.document)}|${String(s.page)}|${String(s.line)}` : '';
    if (!isRecord(s) || quote === null || typeof s.text !== 'string' || !wordsAllowed(s.text, quote) || seen.has(key)) {
      dropped += 1;
      continue;
    }
    const base = { topic: s.topic as Topic, text: s.text, document: s.document as number, page: s.page as number, quote };
    const w = isRecord(s.works) ? s.works : null;
    const works: { amountEur?: number; dueOn?: string } = {};
    if (w && w.amountEur !== undefined) works.amountEur = w.amountEur as number;
    if (w && w.dueOn !== undefined) works.dueOn = w.dueOn as string;
    // Du plus complet au plus simple : un montant ou une échéance qui ne se lisent pas dans la ligne sont retirés.
    const tries: ProposedSentence[] = [];
    if (w) {
      tries.push({ ...base, works: { ...works } });
      if (works.amountEur !== undefined) tries.push({ ...base, works: { ...(works.dueOn === undefined ? {} : { dueOn: works.dueOn }) } });
      if (works.dueOn !== undefined) tries.push({ ...base, works: { ...(works.amountEur === undefined ? {} : { amountEur: works.amountEur }) } });
      tries.push({ ...base, works: {} });
    }
    tries.push(base);
    const kept = tries.find((p) => checkSentence(p, docs, normalizedPages).ok);
    if (!kept) {
      dropped += 1;
      continue;
    }
    seen.add(key);
    sentences.push(kept);
  }
  return { sentences, dropped };
}

/** Les rubriques à lire : un document de leur domaine est fourni, et aucune phrase n'y est retenue [R450]. */
function topicsToRead(docs: readonly SourceDocument[], sentences: readonly ProposedSentence[]): Topic[] {
  const hasCo = docs.some((d) => COOWNERSHIP_DOCS.includes(d.kind));
  const hasUrba = docs.some((d) => !COOWNERSHIP_DOCS.includes(d.kind));
  return TOPICS.filter((t) => ((COOWNERSHIP_TOPICS as readonly string[]).includes(t) ? hasCo : hasUrba) && !sentences.some((s) => s.topic === t));
}

export class LectureCopropriete {
  private readonly now: () => Date;
  private readonly timeoutMs: number;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    /** Le lecteur, ou `null` quand aucune IA n'est branchée : tout est alors à lire [R12]. */
    private readonly reader: CoproReader | null,
    options: { now?: () => Date; timeoutMs?: number } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Les documents fournis, ou null s'ils sont mal formés (mêmes exigences que `prepare`). */
  private checkDocuments(docs: unknown): SourceDocument[] | null {
    if (!Array.isArray(docs) || docs.length < 1 || docs.length > MAX_DOCS) return null;
    const today = localTime(this.now(), TIME_ZONE).date;
    for (const d of docs as SourceDocument[]) {
      if (!isRecord(d) || !(DOCUMENT_KINDS as readonly string[]).includes(d.kind) || typeof d.ref !== 'string' || d.ref.trim().length === 0 || d.ref.length > 300) return null;
      if (!Array.isArray(d.pages) || d.pages.length < 1 || d.pages.length > MAX_PAGES || !d.pages.every((p) => typeof p === 'string' && p.length <= MAX_PAGE_CHARS)) return null;
      const day = d.meetingDay;
      const validDay = typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) && new Date(`${day}T12:00:00Z`).toISOString().slice(0, 10) === day;
      if (d.kind === 'pv_assemblee' ? !validDay || day > today : day !== undefined) return null;
    }
    return docs as SourceDocument[];
  }

  /** Prélit les documents : rien n'est rangé, l'agent relit puis prépare le résumé par `prepare` [R448, R452]. */
  async preRead(viewer: Viewer, fileId: string, input: { documents: unknown }): Promise<{ ok: true; value: CoproPreReading } | FileRefusal | FileUnknown | Problem> {
    const g = await gateSaleFile({ db: this.db, acces: this.acces, journal: this.journal, now: this.now }, viewer, fileId, true, 'coownership_summary');
    if (!g.ok) return g;
    const docs = this.checkDocuments(isRecord(input) ? input.documents : undefined);
    if (!docs) return { ok: false, rule: null, code: 'bad_documents' };

    const excerpts = coproExcerptsOf(docs);
    let raw: unknown = null;
    let source: CoproPreReading['source'] = 'manuel';
    if (this.reader && excerpts.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        raw = await Promise.race([
          this.reader.read(excerpts),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), this.timeoutMs);
          }),
        ]);
        if (isRecord(raw) && Array.isArray(raw.sentences)) source = 'ia';
      } catch {
        raw = null;
      } finally {
        clearTimeout(timer);
      }
    }
    const { sentences, dropped } = source === 'ia' ? verifyCoproReading(docs, raw) : { sentences: [], dropped: 0 };
    const value: CoproPreReading = { source, sentences, toRead: topicsToRead(docs, sentences), dropped };
    // Au journal : la source, des rubriques et des nombres, jamais une phrase, une ligne ni un montant [R13].
    const proposed = TOPICS.filter((t) => sentences.some((s) => s.topic === t));
    await appendEvent(
      this.journal,
      { type: 'dossier.copropriete_prelue', actor: actorOf(viewer), subject: `sale_file:${fileId}`, data: { rule: 'R448', source, documents: docs.length, lines: excerpts.reduce((n, e) => n + e.lines.length, 0), proposed, sentences: sentences.length, dropped, toRead: value.toRead } },
      this.now,
    );
    return { ok: true, value };
  }
}

