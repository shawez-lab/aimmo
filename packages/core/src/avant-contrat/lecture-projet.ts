/**
 * Le projet du notaire prélu, chaque terme retrouvé sur sa page (RC39) [R511, R15, R12, R13, R16].
 *
 * L'agent du bien demande une prélecture du projet de compromis reçu du notaire. Un lecteur (l'IA, derrière une
 * interface) reçoit seulement des extraits du texte des pages : les lignes qui parlent de prix, de conditions
 * suspensives, de prêt, de dépôt de garantie ou de date de l'acte. Une ligne qui porte un IBAN, un BIC, un RIB, une pièce
 * d'identité ou une naissance n'est jamais envoyée ; les mails et les téléphones sont masqués [R15].
 *
 * « Jamais vu » : ce que le lecteur rend n'est pas cru. Chaque montant, date, durée et condition n'est proposé que si le
 * code le retrouve sur la page que le lecteur cite, dans le texte entier de cette page ; le destinataire du dépôt
 * n'est jamais proposé : l'agent le lit lui-même [R512]. Tout le reste est dit « à lire vous-même ». Une valeur
 * inventée par l'IA ne peut donc jamais entrer dans la comparaison de R511.
 *
 * La prélecture ne range rien : seul `AvantContrat.recordDraft`, avec ce que l'agent confirme, range le projet [R511].
 * Lecteur absent, en panne, trop lent ou réponse illisible : un formulaire vide, tout à lire, jamais une erreur [R12].
 * Au journal : la source et les noms des termes, aucun montant ni date [R13].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { actorOf, gateSaleFile, type FileRefusal, type FileUnknown } from '../dossiers/acces-dossier.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { CONDITION_KINDS, LOAN_TYPES, MAX_RATE_BP, type ConditionKind, type LoanType } from '../offres/registre-offres.ts';
import { PROOF_REF } from '../offres/transmission.ts';

/** Ce que reçoit le lecteur : des extraits de pages, jamais une page entière. */
export interface DraftExcerpt {
  page: number;
  lines: string[];
}

/** Le lecteur du projet (l'IA). Ce qu'il rend n'est jamais cru tel quel ; `null` s'il n'a rien pu lire. */
export interface DraftReader {
  read(excerpts: DraftExcerpt[]): Promise<unknown>;
}

type Paged<T> = { value: T; page: number };

/** La prélecture : chaque terme retrouvé sur sa page, à confirmer par l'agent avant `recordDraft`. */
export interface DraftProposal {
  priceEur: Paged<number> | null;
  conditions: { kind: ConditionKind; page: number; amountEur?: number; durationMonths?: number; maxRateBp?: number; loanType?: LoanType }[];
  loanDeadline: Paged<string> | null;
  deedBy: Paged<string> | null;
  /** Le montant seul : le destinataire est toujours à lire par l'agent [R512]. */
  deposit: { eur: number; page: number; holder: null } | null;
}

export interface DraftPreReading {
  source: 'ia' | 'manuel';
  proposal: DraftProposal;
  /** Les termes que l'agent doit lire lui-même : non rendus par le lecteur, ou pas retrouvés sur leur page. */
  toRead: string[];
}

type Problem = { ok: false; rule: null; code: 'bad_document' | 'bad_pages' | 'not_stored' | 'closed' };

export const MAX_PAGES = 200;
const MAX_PAGE_CHARS = 20_000;
const MAX_LINE_CHARS = 300;
const MAX_LINES_PER_PAGE = 40;
const DEFAULT_TIMEOUT_MS = 20_000;

/** Les lignes utiles à la comparaison de R511. */
const USEFUL = /\bprix\b|condition|suspensi|\bpr[eê]ts?\b|emprunt|financement|d[ée]p[oô]t de garantie|s[ée]questre|acompte|immobilisation|acte authentique|r[ée]it[ée]ration|signature de l.acte|date limite|au plus tard|permis de construire|certificat d.urbanisme|vente d.un (?:autre )?bien|vente pr[ée]alable/i;
/** Une ligne qui porte de quoi identifier une personne ou un compte ne part jamais au lecteur [R15]. */
const NEVER_SENT = /\biban\b|\bbic\b|\brib\b|\bswift\b|\bFR\d{2}(?:[  ]?[0-9A-Z]{4}){2,}|passeport|carte (?:nationale )?d.identit[ée]|titre de s[ée]jour|permis de conduire|\bn[ée]e?s? (?:le|à|a)\b|date de naissance|lieu de naissance|s[ée]curit[ée] sociale|num[ée]ro fiscal/i;
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu;
/**
 * Une suite de chiffres coupée d'espaces, de points, de barres, de tirets ou de parenthèses, de 9 chiffres ou plus, ou
 * précédée d'un « + » : un téléphone (« +33 (0)6 11 22 33 44 », « 06/11/22/33/44 ») ou un numéro de personne ou de
 * compte, jamais un montant ni une date du projet. Masquée en entier [R15].
 */
const LONG_NUMBER = /\+\s?\(?\d[\d\s.\/()-]*\d|\(?\d[\d\s.\/()-]*\d\)?/g;
const digitCount = (s: string): number => s.replace(/\D/g, '').length;

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const MONTHS_WORDS = MONTHS.join(' ');

const normalize = (s: string): string => s.replace(/[   ]/g, ' ');

/**
 * Les seuls mots qui passent au lecteur : le vocabulaire des termes comparés par R511. Tout autre mot (nom, prénom,
 * rue, commune, nom d'étude) devient « … » : aucune personne ni adresse ne sort, même dans une ligne utile [R15].
 */
const ALLOWED_WORDS = new Set(
  (
    'prix vente vend vendu consentie consenti moyennant payable payé payée comptant euros euro eur ' +
    'condition conditions suspensive suspensives suspensif obtention obtenir prêt prêts pret prets emprunt emprunts financement montant maximum minimum ' +
    'durée taux nominal annuel hors assurance assurances amortissable in fine relais zéro zero ptz an ans mois jour jours ' +
    'dépôt depot garantie séquestre sequestre acompte indemnité immobilisation somme versée versé verse versera verser remise remis remettra mains ' +
    'notaire notaires notarial office maître agence agent immobilier mandataire vendeur vendeurs cédant acquéreur acquéreurs acquereur ' +
    'acte authentique signature réitération reitération réitérée réitérer date limite plus tard tard avant après au aux à le la les l de du des d ' +
    'un une sur en par pour entre et ou soit qui que dont sera seront devra devront aura auront est sont lieu ' +
    'permis construire certificat urbanisme autre bien biens préalable prealable er ' +
    // La négation passe toujours : « n'est pas soumise à », « sans recours à », « renonce à » changent tout.
    'ne n pas sans aucun aucune non ni jamais renonce renoncent renonçant renonciation exclu exclue exclus soumis soumise sous déclare déclarent recours ' +
    MONTHS_WORDS
  ).split(' '),
);

/** Une ligne utile, réduite au vocabulaire des termes, aux nombres et à la ponctuation [R15]. */
function skeleton(line: string): string {
  return line
    .replace(EMAIL, ' … ')
    .replace(LONG_NUMBER, (n) => (n.trimStart().startsWith('+') || digitCount(n) >= 9 ? ' … ' : n))
    .replace(/\p{L}+/gu, (w) => (ALLOWED_WORDS.has(w.toLowerCase()) ? w : '…'))
    .replace(/…(?:[\s'’.,-]*…)+/g, '…')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Les extraits envoyés au lecteur : lignes utiles, sans ce qui ne doit pas sortir, réduites au vocabulaire des termes [R15]. */
export function excerptsOf(pages: string[]): DraftExcerpt[] {
  const out: DraftExcerpt[] = [];
  pages.forEach((text, i) => {
    const lines = normalize(text)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && USEFUL.test(l) && !NEVER_SENT.test(l))
      .map((l) => skeleton(l).slice(0, MAX_LINE_CHARS))
      .slice(0, MAX_LINES_PER_PAGE);
    if (lines.length > 0) out.push({ page: i + 1, lines });
  });
  return out;
}

const SEP = '[ .  ]?';

/** Un montant entier en euros, écrit avec ou sans séparateur de milliers, jamais pris dans un nombre plus long. */
export function amountOn(text: string, n: number): boolean {
  const groups = String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',').split(',');
  const re = new RegExp(`(?<!\\d[ .,\u00a0\u202f]?)${groups.join(SEP)}(?:,00)?(?!\\d|[.,]\\d|[ .\u00a0\u202f]\\d{3}(?!\\d))`);
  return re.test(normalize(text));
}

/** Une date `AAAA-MM-JJ`, écrite 30/04/2027, 30.04.2027, 30-04-2027 ou « 30 avril 2027 » (« 1er » pour le premier). */
export function dayOn(text: string, day: string): boolean {
  const [y, m, d] = [day.slice(0, 4), Number(day.slice(5, 7)), Number(day.slice(8, 10))];
  const dd = `0?${d}`;
  const mm = `0?${m}`;
  const month = MONTHS[m - 1]!.replace('é', '[ée]').replace('û', '[uû]');
  const dayWord = d === 1 ? '(?:1er|1|01)' : dd;
  const re = new RegExp(`(?<!\\d)(?:${dd}[/.-]${mm}[/.-]${y}|${dayWord} ${month} ${y})(?!\\d)`, 'i');
  return re.test(normalize(text));
}

/** Une durée en mois, écrite en mois, ou en années quand elle tombe juste. */
export function monthsOn(text: string, n: number): boolean {
  const t = normalize(text);
  if (new RegExp(`(?<![\\d.,])${n} ?mois\\b`, 'i').test(t)) return true;
  return n % 12 === 0 && new RegExp(`(?<![\\d.,])${n / 12} ?ans?\\b`, 'i').test(t);
}

/**
 * Un taux en centièmes de point, écrit « 3,85 % », « 3.85% », « 3,850 % » ou « 4 % » quand il tombe juste, jamais pris
 * dans un nombre plus long (AU079).
 */
export function rateOn(text: string, bp: number): boolean {
  const units = Math.floor(bp / 100);
  const cents = bp % 100;
  const decimals = cents === 0 ? '(?:[.,]0{1,3})?' : cents % 10 === 0 ? `[.,]${cents / 10}0{0,2}` : `[.,]${String(cents).padStart(2, '0')}0?`;
  return new RegExp(`(?<![\\d.,])${units}${decimals} ?%`).test(normalize(text));
}

/** Les mots qui nomment chaque type de prêt sur la page. */
const LOAN_TYPE_WORDS: Record<LoanType, RegExp> = {
  amortissable: /\bamortissable\b/i,
  in_fine: /\bin fine\b/i,
  relais: /\bpr[eê]t relais\b|\brelais\b/i,
  ptz: /taux z[ée]ro|\bptz\b/i,
};

const CONDITION_WORDS: Record<ConditionKind, RegExp | null> = {
  pret: /\bpr[eê]ts?\b|emprunt|financement/i,
  vente_autre_bien: /vente d.un (?:autre )?bien|vente pr[ée]alable/i,
  permis_construire: /permis de construire/i,
  certificat_urbanisme: /certificat d.urbanisme/i,
  // Une autre condition se lit dans l'offre signée : jamais proposée par la prélecture.
  autre: null,
};

/** Une ligne qui nie ou écarte ce qu'elle nomme. */
const NEGATION = /\bne\b|\bn['’]|\bpas\b|\bsans\b|\baucune?\b|\bnon\b|\bni\b|\bjamais\b|renon[cç]|\bexclu/i;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const validDay = (v: unknown): v is string => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

const EMPTY: DraftProposal = { priceEur: null, conditions: [], loanDeadline: null, deedBy: null, deposit: null };
export const ALL_TERMS = ['prix', 'conditions', 'date_limite_pret', 'acte_prevu', 'depot_garantie.montant', 'depot_garantie.detenteur'] as const;

/**
 * Ne garde de ce que rend le lecteur que ce que le code retrouve sur la page citée ; tout le reste est à lire.
 * Les pages sont le texte entier fourni par l'appelant, la première a le numéro 1.
 */
export function verifyReading(pages: string[], raw: unknown): { proposal: DraftProposal; toRead: string[] } {
  const r = isRecord(raw) ? raw : {};
  const toRead = new Set<string>();
  const pageOf = (v: unknown): string | null => (isInt(v, 1, pages.length) ? pages[v - 1]! : null);

  let priceEur: DraftProposal['priceEur'] = null;
  const p = r.priceEur;
  if (isRecord(p) && isInt(p.value, 1, 1_000_000_000) && pageOf(p.page) !== null && amountOn(pageOf(p.page)!, p.value)) priceEur = { value: p.value, page: p.page as number };
  else toRead.add('prix');

  const conditions: DraftProposal['conditions'] = [];
  const rawConditions = Array.isArray(r.conditions) ? r.conditions.slice(0, CONDITION_KINDS.length * 2) : [];
  if (!Array.isArray(r.conditions)) toRead.add('conditions');
  for (const c of rawConditions) {
    if (!isRecord(c) || !(CONDITION_KINDS as readonly unknown[]).includes(c.kind)) {
      toRead.add('conditions');
      continue;
    }
    const kind = c.kind as ConditionKind;
    const text = pageOf(c.page);
    const words = CONDITION_WORDS[kind];
    // Une condition se lit sur une ligne qui la nomme sans la nier ; niée partout sur la page, elle est à lire.
    const stated = text !== null && words !== null && normalize(text).split(/\r?\n/).some((l) => words.test(l) && !NEGATION.test(l));
    if (!stated || conditions.some((x) => x.kind === kind)) {
      toRead.add('conditions');
      continue;
    }
    if (kind === 'pret') {
      // Un prêt sans son montant et sa durée retrouvés n'est pas proposé : la comparaison les exige.
      if (!isInt(c.amountEur, 1, 1_000_000_000) || !isInt(c.durationMonths, 1, 600) || !amountOn(text, c.amountEur) || !monthsOn(text, c.durationMonths)) {
        toRead.add('conditions');
        continue;
      }
      // Le taux maximal et le type, quand le lecteur les rend, doivent eux aussi se retrouver sur la page (AU079).
      const rateOk = c.maxRateBp === undefined || (isInt(c.maxRateBp, 1, MAX_RATE_BP) && rateOn(text, c.maxRateBp));
      const typeOk = c.loanType === undefined || ((LOAN_TYPES as readonly unknown[]).includes(c.loanType) && LOAN_TYPE_WORDS[c.loanType as LoanType].test(normalize(text)));
      if (!rateOk || !typeOk) {
        toRead.add('conditions');
        continue;
      }
      conditions.push({
        kind, page: c.page as number, amountEur: c.amountEur, durationMonths: c.durationMonths,
        ...(c.maxRateBp !== undefined ? { maxRateBp: c.maxRateBp as number } : {}),
        ...(c.loanType !== undefined ? { loanType: c.loanType as LoanType } : {}),
      });
    } else conditions.push({ kind, page: c.page as number });
  }

  const pagedDay = (v: unknown, name: string): Paged<string> | null => {
    if (isRecord(v) && validDay(v.value) && pageOf(v.page) !== null && dayOn(pageOf(v.page)!, v.value)) return { value: v.value, page: v.page as number };
    toRead.add(name);
    return null;
  };
  const loanDeadline = pagedDay(r.loanDeadline, 'date_limite_pret');
  const deedBy = pagedDay(r.deedBy, 'acte_prevu');

  let deposit: DraftProposal['deposit'] = null;
  const d = r.deposit;
  const depositText = isRecord(d) ? pageOf(d.page) : null;
  if (isRecord(d) && depositText !== null && isInt(d.eur, 0, 1_000_000_000) && amountOn(depositText, d.eur)) {
    // Le destinataire n'est jamais proposé : qui garde la somme décide de R512 (un tiers, une négation, une remise
    // ultérieure le changent), l'agent le lit lui-même dans le projet.
    toRead.add('depot_garantie.detenteur');
    deposit = { eur: d.eur, page: d.page as number, holder: null };
  } else {
    toRead.add('depot_garantie.montant');
    toRead.add('depot_garantie.detenteur');
  }

  // Une condition dont les mots sont dans le projet, mais que le lecteur ne rend pas : son absence n'est pas vérifiée.
  const whole = normalize(pages.join('\n'));
  for (const kind of CONDITION_KINDS) {
    const words = CONDITION_WORDS[kind];
    if (words && words.test(whole) && !conditions.some((c) => c.kind === kind)) toRead.add('conditions');
  }

  return { proposal: { priceEur, conditions, loanDeadline, deedBy, deposit }, toRead: ALL_TERMS.filter((t) => toRead.has(t)) };
}

export class LectureProjet {
  private readonly now: () => Date;
  private readonly timeoutMs: number;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    private readonly storage: { has(ref: string): Promise<boolean> },
    /** Le lecteur, ou `null` quand aucune IA n'est branchée : la prélecture rend alors un formulaire vide [R12]. */
    private readonly reader: DraftReader | null,
    options: { now?: () => Date; timeoutMs?: number } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Prélit le projet : rien n'est rangé, l'agent confirme puis range par `AvantContrat.recordDraft` [R511]. */
  async preRead(viewer: Viewer, fileId: string, input: { documentRef: unknown; pages: unknown }): Promise<{ ok: true; value: DraftPreReading } | FileRefusal | FileUnknown | Problem> {
    const g = await gateSaleFile({ db: this.db, acces: this.acces, journal: this.journal, now: this.now }, viewer, fileId, true, 'pre_contract');
    if (!g.ok) return g;
    if (await this.db.first('SELECT 1 FROM sale_file_closings WHERE file_id = ?', [fileId])) return { ok: false, rule: null, code: 'closed' };
    const ref = input.documentRef;
    if (typeof ref !== 'string' || !PROOF_REF.test(ref)) return { ok: false, rule: null, code: 'bad_document' };
    const pages = input.pages;
    if (!Array.isArray(pages) || pages.length === 0 || pages.length > MAX_PAGES || !pages.every((p) => typeof p === 'string' && p.length <= MAX_PAGE_CHARS)) return { ok: false, rule: null, code: 'bad_pages' };
    if (!(await this.storage.has(ref))) return { ok: false, rule: null, code: 'not_stored' };

    let raw: unknown = null;
    let source: DraftPreReading['source'] = 'manuel';
    const excerpts = excerptsOf(pages as string[]);
    if (this.reader && excerpts.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        raw = await Promise.race([
          this.reader.read(excerpts),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), this.timeoutMs);
          }),
        ]);
        if (isRecord(raw)) source = 'ia';
      } catch {
        raw = null;
      } finally {
        clearTimeout(timer);
      }
    }
    const value: DraftPreReading = source === 'ia' ? { source, ...verifyReading(pages as string[], raw) } : { source, proposal: { ...EMPTY, conditions: [] }, toRead: [...ALL_TERMS] };
    const proposed = [
      value.proposal.priceEur && 'prix',
      ...value.proposal.conditions.map((c) => `condition.${c.kind}`),
      value.proposal.loanDeadline && 'date_limite_pret',
      value.proposal.deedBy && 'acte_prevu',
      value.proposal.deposit && 'depot_garantie.montant',
    ].filter((x): x is string => typeof x === 'string');
    // Au journal : la source et les noms des termes, aucun montant ni date [R13].
    await appendEvent(this.journal, { type: 'avant_contrat.prelecture', actor: actorOf(viewer), subject: `sale_file:${fileId}`, data: { rule: 'R511', source: value.source, proposed, toRead: value.toRead } }, this.now);
    return { ok: true, value };
  }
}
