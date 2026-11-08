/**
 * Les contrôles d'une pièce de candidature, par le code seul (HX47) [R530, R531, R532, R533].
 *
 * Le résultat est un constat ligne par ligne : chaque contrôle dit « conforme », « écart » ou « non vérifiable », avec
 * un texte fixe qui ne cite aucune valeur lue. Jamais de note, de total, de rang ni d'avis sur la personne [R14, R530].
 * Un écart se voit avec le candidat : le texte ne demande jamais qu'une autre version de la même pièce, de la liste
 * officielle [R104].
 */
import { parseTwoDDoc, TAX_NOTICE_DOC_TYPES, verifyTwoDDoc, type TrustList } from './deux-d-doc.ts';
import { checkEmployer, type CompanyRegistry } from './entreprise.ts';

export type Outcome = 'conforme' | 'ecart' | 'non_verifiable';

export const CONTROLS = [
  'code_2d_doc',
  'code_2d_doc_sorte',
  'avis_reference',
  'avis_revenu_fiscal',
  'avis_annee',
  'avis_parts',
  'avis_recent',
  'employeur_siret',
  'employeur_registre',
  'bulletins_mois',
  'bulletin_net_paye',
  'bulletin_prelevement',
  'bulletin_cumul',
] as const;
export type Control = (typeof CONTROLS)[number];

export interface Finding {
  control: Control;
  outcome: Outcome;
  /** Le mois du bulletin concerné, pour les contrôles d'un bulletin. */
  month?: string;
  /** Le rang du bulletin dans ce que l'agent a lu (1 pour le premier) : deux employeurs ont deux bulletins le même mois. */
  slip?: number;
}

const ASK = ' À voir avec le candidat : lui demander l’original de cette même pièce.';

/** Les textes fixes, contrôle par contrôle : aucun chiffre lu, aucun nom, aucune conclusion sur la personne. */
export const FINDING_TEXTS: Readonly<Record<Control, Readonly<Record<Outcome, string>>>> = Object.freeze({
  code_2d_doc: {
    conforme: 'Le code 2D-Doc correspond à sa signature : il a été émis tel quel par l’administration.',
    ecart: `Le code 2D-Doc ne correspond pas à sa signature : ses données ont changé après leur émission.${ASK}`,
    non_verifiable: 'Le code 2D-Doc n’a pas pu être vérifié : code absent ou illisible, émetteur inconnu de la liste de confiance, ou liste injoignable.',
  },
  code_2d_doc_sorte: {
    conforme: 'Le code 2D-Doc est celui d’un avis d’impôt sur le revenu.',
    ecart: `Le code 2D-Doc signé n’est pas celui d’un avis d’impôt sur le revenu.${ASK}`,
    non_verifiable: 'La sorte du document n’a pas pu être lue dans un code vérifié.',
  },
  avis_reference: {
    conforme: 'La référence de l’avis imprimée est celle du code signé.',
    ecart: `La référence de l’avis imprimée n’est pas celle du code signé.${ASK}`,
    non_verifiable: 'La référence de l’avis n’a pas pu être comparée au code signé.',
  },
  avis_revenu_fiscal: {
    conforme: 'Le revenu fiscal de référence imprimé est celui du code signé.',
    ecart: `Le revenu fiscal de référence imprimé n’est pas celui du code signé.${ASK}`,
    non_verifiable: 'Le revenu fiscal de référence n’a pas pu être comparé au code signé.',
  },
  avis_annee: {
    conforme: 'L’année des revenus imprimée est celle du code signé.',
    ecart: `L’année des revenus imprimée n’est pas celle du code signé.${ASK}`,
    non_verifiable: 'L’année des revenus n’a pas pu être comparée au code signé.',
  },
  avis_parts: {
    conforme: 'Le nombre de parts imprimé est celui du code signé.',
    ecart: `Le nombre de parts imprimé n’est pas celui du code signé.${ASK}`,
    non_verifiable: 'Le nombre de parts n’a pas pu être comparé au code signé.',
  },
  avis_recent: {
    conforme: 'L’avis est le dernier ou l’avant-dernier, comme la liste officielle le demande.',
    ecart: 'L’avis est plus ancien que l’avant-dernier : la liste officielle demande le dernier ou l’avant-dernier avis d’imposition.',
    non_verifiable: 'L’année de l’avis n’a pas pu être lue.',
  },
  employeur_siret: {
    conforme: 'Le numéro SIRET de l’employeur a une clé juste.',
    ecart: `Le numéro SIRET de l’employeur a une clé fausse : il ne peut pas exister.${ASK}`,
    non_verifiable: 'Aucun numéro SIRET d’employeur n’a été lu sur la pièce.',
  },
  employeur_registre: {
    conforme: 'L’établissement de l’employeur existe au répertoire Sirene et était ouvert à la date de la pièce.',
    ecart: `L’établissement de l’employeur est inconnu du répertoire Sirene, ou y est fermé avant la date de la pièce.${ASK}`,
    non_verifiable: 'Le répertoire Sirene n’a pas pu être interrogé.',
  },
  bulletins_mois: {
    conforme: 'Les trois bulletins couvrent trois mois qui se suivent.',
    ecart: 'Les bulletins ne couvrent pas trois mois différents qui se suivent : la liste officielle demande les trois derniers.',
    non_verifiable: 'Les mois des bulletins n’ont pas tous été lus.',
  },
  bulletin_net_paye: {
    conforme: 'Le net payé est égal au net avant impôt moins l’impôt prélevé à la source.',
    ecart: `Le net payé n’est pas égal au net avant impôt moins l’impôt prélevé à la source.${ASK}`,
    non_verifiable: 'Le net payé n’a pas pu être recalculé : un montant manque.',
  },
  bulletin_prelevement: {
    conforme: 'L’impôt prélevé à la source est égal au net imposable multiplié par le taux affiché.',
    ecart: `L’impôt prélevé à la source n’est pas égal au net imposable multiplié par le taux affiché.${ASK}`,
    non_verifiable: 'Le prélèvement à la source n’a pas pu être recalculé : un montant ou le taux manque.',
  },
  bulletin_cumul: {
    conforme: 'Le cumul brut de l’année est égal au cumul du mois précédent plus le brut du mois.',
    ecart: `Le cumul brut de l’année n’est pas égal au cumul du mois précédent plus le brut du mois.${ASK}`,
    non_verifiable: 'Le cumul brut n’a pas pu être recalculé : le mois précédent n’est pas fourni ou un montant manque.',
  },
});

export const findingText = (f: Finding): string => FINDING_TEXTS[f.control][f.outcome];

const isCents = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 100_000_000;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

// ——— Avis d'impôt ———

export interface TaxNoticeRead {
  /** Le texte du code 2D-Doc, tel que le téléphone l'a lu ; absent si la pièce n'en a pas. */
  twoDDoc?: unknown;
  /** Ce que l'agent lit imprimé sur l'avis. */
  printed?: { reference?: unknown; fiscalIncome?: unknown; incomeYear?: unknown; parts?: unknown };
}

const normRef = (v: unknown): string | null => (typeof v === 'string' && v.length <= 40 ? v.replace(/\s+/g, '').toUpperCase() || null : null);
const normInt = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? v : null;
  if (typeof v !== 'string' || v.length > 20) return null;
  const d = v.replace(/[\s  .]/g, '');
  return /^\d{1,12}$/.test(d) ? Number(d) : null;
};
const normParts = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 && v <= 99 ? Math.round(v * 100) : null;
  if (typeof v !== 'string' || v.length > 8) return null;
  const d = v.trim().replace(',', '.');
  return /^\d{1,2}(\.\d{1,2})?$/.test(d) && Number(d) > 0 ? Math.round(Number(d) * 100) : null;
};
const normYear = (v: unknown): number | null => {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
  return /^(19|20)\d\d$/.test(s) ? Number(s) : null;
};

/** Compare une valeur imprimée à celle du code signé : conforme, écart, ou non vérifiable si l'une manque. */
function compare<T>(printed: T | null, code: T | null): Outcome {
  if (printed === null || code === null) return 'non_verifiable';
  return printed === code ? 'conforme' : 'ecart';
}

/** Jour (mois-jour) où tous les avis d'impôt de l'été sont réputés reçus : un réglage. */
export const NOTICES_SENT_BY = '10-01';

export async function checkTaxNotice(read: TaxNoticeRead, trust: TrustList, today: string): Promise<Finding[]> {
  const parsed = read.twoDDoc === undefined || read.twoDDoc === null ? null : parseTwoDDoc(read.twoDDoc);
  const signature = parsed ? await verifyTwoDDoc(parsed, trust) : 'unreadable';
  const findings: Finding[] = [];
  // Une signature fausse n'est un écart que sur un code qui se lit en entier : un code abîmé à la lecture (séparateur
  // perdu par le lecteur du téléphone) ne se découpe pas, et ne prouve rien [R531].
  const forged = signature === 'invalid' && parsed !== null && parsed.fields !== null;
  findings.push({ control: 'code_2d_doc', outcome: signature === 'valid' ? 'conforme' : forged ? 'ecart' : 'non_verifiable' });
  const trusted = signature === 'valid' && parsed !== null;
  const rightSort = trusted && TAX_NOTICE_DOC_TYPES.includes(parsed.header.docType);
  findings.push({ control: 'code_2d_doc_sorte', outcome: !trusted ? 'non_verifiable' : rightSort ? 'conforme' : 'ecart' });
  // Les valeurs du code ne valent que signées, et seulement si c'est bien un avis d'impôt.
  const code = rightSort ? parsed.fields : null;
  const p = read.printed ?? {};
  findings.push({ control: 'avis_reference', outcome: compare(normRef(p.reference), code ? normRef(code.reference_avis) : null) });
  findings.push({ control: 'avis_revenu_fiscal', outcome: compare(normInt(p.fiscalIncome), code ? normInt(code.revenu_fiscal) : null) });
  findings.push({ control: 'avis_annee', outcome: compare(normYear(p.incomeYear), code ? normYear(code.annee_revenus) : null) });
  findings.push({ control: 'avis_parts', outcome: compare(normParts(p.parts), code ? normParts(code.parts) : null) });
  // L'année vaut celle du code signé s'il y en a une, sinon celle imprimée. Le dernier ou l'avant-dernier avis : les avis
  // de l'été portent sur les revenus de l'année d'avant. Jusqu'à la fin de leur envoi (réglage : le 1er octobre, en
  // lecture prudente pour le candidat), l'avis des revenus de l'année moins 3 est encore l'avant-dernier ; après, non.
  const year = (code ? normYear(code.annee_revenus) : null) ?? normYear(p.incomeYear);
  const current = Number(today.slice(0, 4));
  const oldest = today.slice(5) < NOTICES_SENT_BY ? current - 3 : current - 2;
  findings.push({ control: 'avis_recent', outcome: year === null ? 'non_verifiable' : year >= oldest && year < current ? 'conforme' : 'ecart' });
  return findings;
}

// ——— Employeur ———

export async function checkEmployerFindings(registry: CompanyRegistry, siret: unknown, onDate: string | null, month?: string, slip?: number): Promise<Finding[]> {
  const until = month ? `${nextMonth(month)}-01` : undefined;
  const at = { ...(month ? { month } : {}), ...(slip ? { slip } : {}) };
  if (siret === undefined || siret === null || siret === '') {
    return [
      { control: 'employeur_siret', outcome: 'non_verifiable', ...at },
      { control: 'employeur_registre', outcome: 'non_verifiable', ...at },
    ];
  }
  const r = await checkEmployer(registry, siret, onDate, until);
  if (r === 'bad_key') {
    return [
      { control: 'employeur_siret', outcome: 'ecart', ...at },
      { control: 'employeur_registre', outcome: 'non_verifiable', ...at },
    ];
  }
  return [
    { control: 'employeur_siret', outcome: 'conforme', ...at },
    { control: 'employeur_registre', outcome: r === 'open' ? 'conforme' : r === 'unavailable' ? 'non_verifiable' : 'ecart', ...at },
  ];
}

// ——— Bulletins de salaire ———

export interface PayslipRead {
  month?: unknown;
  grossCents?: unknown;
  netBeforeTaxCents?: unknown;
  taxWithheldCents?: unknown;
  netPaidCents?: unknown;
  taxableNetCents?: unknown;
  /** Le taux du prélèvement à la source affiché, en pour cent (7,5 % → 7.5). */
  ratePercent?: unknown;
  cumulativeGrossCents?: unknown;
  siret?: unknown;
}

const TOLERANCE = 1;
const close = (a: number, b: number): boolean => Math.abs(a - b) <= TOLERANCE;

function nextMonth(m: string): string {
  const y = Number(m.slice(0, 4));
  const mo = Number(m.slice(5, 7));
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
}

/** Les trois derniers bulletins, contrôlés un par un, puis ensemble ; l'ordre des lignes est celui des mois. */
export async function checkPayslips(slips: readonly PayslipRead[], registry: CompanyRegistry): Promise<Finding[]> {
  const findings: Finding[] = [];
  const months = slips.map((s) => (typeof s.month === 'string' && MONTH.test(s.month) ? s.month : null));
  const sirets = slips.map((s) => (typeof s.siret === 'string' && s.siret.replace(/\s+/g, '') !== '' ? s.siret.replace(/\s+/g, '') : null));
  const all = months.every((m): m is string => m !== null);
  // Trois mois différents qui se suivent ; un candidat à deux employeurs a deux bulletins le même mois, jamais deux
  // bulletins du même employeur le même mois.
  const distinct = all ? [...new Set(months as string[])].sort() : [];
  const pairs = new Set(slips.map((_, i) => `${sirets[i] ?? '?'}|${months[i]}`));
  const consecutive = all && distinct.length === 3 && pairs.size === slips.length && nextMonth(distinct[0]!) === distinct[1] && nextMonth(distinct[1]!) === distinct[2];
  findings.push({ control: 'bulletins_mois', outcome: !all || slips.length === 0 ? 'non_verifiable' : consecutive ? 'conforme' : 'ecart' });
  const ordered = slips
    .map((s, i) => ({ s, m: months[i], siret: sirets[i] ?? null, slip: i + 1 }))
    .filter((x): x is { s: PayslipRead; m: string; siret: string | null; slip: number } => x.m !== null)
    .sort((a, b) => (a.m < b.m ? -1 : a.m > b.m ? 1 : (a.siret ?? '') < (b.siret ?? '') ? -1 : 1));
  // Le cumul se suit employeur par employeur : seul un bulletin du même SIRET, le mois d'avant, sert de point de départ.
  const bySiretMonth = new Map(ordered.filter((x) => x.siret !== null).map((x) => [`${x.siret}|${x.m}`, x.s]));
  const firstMonth = new Map<string, { m: string; slip: number }>();
  for (const { s, m, siret, slip } of ordered) {
    const net = s.netBeforeTaxCents;
    const tax = s.taxWithheldCents;
    const paid = s.netPaidCents;
    findings.push({ control: 'bulletin_net_paye', month: m, slip, outcome: isCents(net) && isCents(tax) && isCents(paid) ? (close(paid, net - tax) ? 'conforme' : 'ecart') : 'non_verifiable' });
    const rate = s.ratePercent;
    const taxable = s.taxableNetCents;
    const rateOk = typeof rate === 'number' && Number.isFinite(rate) && rate >= 0 && rate <= 100;
    findings.push({
      control: 'bulletin_prelevement',
      month: m,
      slip,
      outcome: rateOk && isCents(taxable) && isCents(tax) ? (close(tax, Math.round((taxable * Math.round(rate * 100)) / 10_000)) ? 'conforme' : 'ecart') : 'non_verifiable',
    });
    // Le cumul de janvier est le brut du mois ; sinon, le cumul du même employeur le mois d'avant plus le brut du mois.
    const gross = s.grossCents;
    const cumul = s.cumulativeGrossCents;
    const january = m.endsWith('-01');
    const previous = january || siret === null ? null : bySiretMonth.get(`${siret}|${m.slice(0, 4)}-${String(Number(m.slice(5, 7)) - 1).padStart(2, '0')}`);
    const expected = !isCents(gross) ? null : january ? gross : previous && isCents(previous.cumulativeGrossCents) ? previous.cumulativeGrossCents + gross : null;
    findings.push({ control: 'bulletin_cumul', month: m, slip, outcome: expected !== null && isCents(cumul) ? (close(cumul, expected) ? 'conforme' : 'ecart') : 'non_verifiable' });
    if (siret !== null && !firstMonth.has(siret)) firstMonth.set(siret, { m, slip });
  }
  if (firstMonth.size === 0) findings.push(...(await checkEmployerFindings(registry, null, null)));
  // Chaque employeur, une fois, à la date de son premier bulletin.
  for (const [siret, { m, slip }] of firstMonth) findings.push(...(await checkEmployerFindings(registry, siret, `${m}-01`, m, slip)));
  return findings;
}
