/**
 * Avant-contrat préparé, et projet du notaire comparé à l'offre (HX45) [R510, R511, R512, R513].
 *
 * Le compromis est rédigé par le notaire ; AIMMO lui transmet un dossier complet (M10). L'agent du bien prépare donc,
 * une fois l'identité de l'acquéreur vérifiée [R58], la note des conditions convenues pour le notaire : le prix est
 * celui du dossier (offre ou dernière proposition acceptée), les conditions suspensives celles de l'offre acceptée,
 * reprises telles quelles ; l'agent n'y ajoute que ce que l'offre ne porte pas : le dépôt de garantie prévu, la date
 * limite du prêt quand l'offre a une condition de prêt, la date prévue de l'acte [R510].
 *
 * Quand le projet du notaire arrive, l'agent le range (référence du stockage) avec ce qu'il y lit, chaque terme avec sa
 * page. Le code le compare à la note, terme par terme, dans un ordre fixe, et signale chaque différence avec la page du
 * projet ; elles sont rangées une fois avec le projet [R511]. « Jamais vu » : rien ne passe de l'offre acceptée au
 * compromis sans que l'agent voie, ligne par ligne, ce qui a bougé.
 *
 * Le dépôt de garantie est suivi comme reçu par le notaire, jamais par AIMMO ni par l'agent : la base refuse tout autre
 * destinataire, un projet qui le confie à un autre est une différence bloquante, et aucun texte n'appelle un versement
 * [R512, R62]. Les dates du projet (date limite du prêt, acte prévu) remplissent l'échéancier de N02 dès que le compromis
 * est signé, avec le projet pour preuve, sans rien ressaisir [R513].
 *
 * Décidé, lecture prudente : aucun envoi dans cette tâche (la note se lit et s'imprime ; son envoi au notaire passera par
 * le contrôle central quand les routes viendront) ; le projet le plus récent est celui qui fait foi pour l'échéancier ;
 * une date de l'échéancier déjà égale n'ajoute pas de version ; le dépôt prévu va de 0 au prix convenu.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import { runBatch, type SqlDatabase } from '../db/sql.ts';
import { actorOf, gateSaleFile, openFile, type FileRefusal, type FileUnknown } from '../dossiers/acces-dossier.ts';
import { Echeancier, orderProblem, type DateKind } from '../dossiers/echeancier.ts';
import { fundsInOutgoing } from '../envoi/texte.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { CONDITION_KINDS, LOAN_TYPE_LABEL, parseLoan, rateText, type ConditionKind, type LoanCondition, type OfferCondition } from '../offres/registre-offres.ts';
import { PROOF_REF } from '../offres/transmission.ts';

const TIME_ZONE = 'Europe/Paris';
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Qui reçoit le dépôt de garantie selon le projet. Seul le notaire est accepté par AIMMO [R512]. */
export const DEPOSIT_HOLDERS = ['notaire', 'agence', 'vendeur', 'autre'] as const;
export type DepositHolder = (typeof DEPOSIT_HOLDERS)[number];

/** Les conditions convenues, telles que la note les donne au notaire. */
export interface BriefTerms {
  priceEur: number;
  conditions: OfferCondition[];
  depositEur: number;
  loanDeadline: string | null;
  deedBy: string;
}

export interface Brief {
  id: string;
  fileId: string;
  version: number;
  terms: BriefTerms;
  hash: string;
  text: string;
  preparedAt: string;
}

type Paged<T> = { value: T; page: number };

/** Ce que l'agent lit dans le projet du notaire, chaque terme avec sa page. */
export interface DraftTerms {
  priceEur: Paged<number>;
  conditions: (OfferCondition & { page: number })[];
  loanDeadline: Paged<string> | null;
  deedBy: Paged<string> | null;
  deposit: { eur: number; holder: DepositHolder; page: number } | null;
}

export interface Draft {
  id: string;
  fileId: string;
  version: number;
  documentRef: string;
  briefId: string;
  terms: DraftTerms;
  recordedAt: string;
}

export interface Difference {
  field: string;
  /** Ce que porte la note (offre acceptée et dates prévues), ou null s'il n'y a rien. */
  expected: string | null;
  /** Ce que porte le projet, ou null s'il n'y a rien. */
  found: string | null;
  page: number | null;
  /** Le dépôt confié à un autre que le notaire : les dates du projet ne passent pas dans l'échéancier tant qu'il n'est pas corrigé. */
  blocking: boolean;
}

export type DatesReport = Partial<Record<'date_limite_pret' | 'acte_prevu', 'ecrite' | 'deja_la' | string>>;

type Blocked = { ok: false; rule: 'R512'; code: 'blocking_difference' };
type Problem = Blocked | { ok: false; rule: null; code: string } | { ok: false; rule: 'R58'; code: 'compromis_not_started' } | { ok: false; rule: 'R512'; code: 'notary_only' } | { ok: false; rule: 'R513'; code: 'compromis_not_signed' };

const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const validDay = (v: unknown): v is string => {
  if (typeof v !== 'string' || !DAY.test(v)) return false;
  const d = new Date(`${v}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
const onlyKeys = (o: Record<string, unknown>, keys: string[]): boolean => Object.keys(o).every((k) => keys.includes(k));
const isPage = (v: unknown): v is number => isInt(v, 1, 999);

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const euros = (n: number): string => `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} €`;
const frDay = (d: string): string => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

const CONDITION_LABEL: Record<ConditionKind, string> = {
  pret: 'obtention du prêt',
  vente_autre_bien: "vente d'un autre bien",
  permis_construire: 'obtention du permis de construire',
  certificat_urbanisme: "certificat d'urbanisme",
  autre: "autre condition, écrite dans l'offre signée",
};

/** Un prêt en mots : type quand il est déclaré, montant, durée, et taux maximal hors assurance quand il est déclaré (AU079). */
const loanText = (c: LoanCondition): string =>
  `${CONDITION_LABEL.pret}${c.loanType ? ` ${LOAN_TYPE_LABEL[c.loanType]}` : ''} de ${euros(c.amountEur)} sur ${c.durationMonths} mois` +
  (c.maxRateBp !== undefined ? `, au taux nominal hors assurance de ${rateText(c.maxRateBp)} au plus` : '');
const conditionText = (c: OfferCondition): string => (c.kind === 'pret' ? loanText(c) : CONDITION_LABEL[c.kind]);

/** Le texte de la note au notaire, écrit par le code, sans nom ni coordonnée, et sans aucun appel à verser [R62]. */
export function briefText(t: BriefTerms): string {
  const lines = [
    "Conditions convenues pour l'avant-contrat, à rédiger par le notaire.",
    `Prix convenu : ${euros(t.priceEur)}.`,
    t.conditions.length ? `Conditions suspensives de l'offre acceptée : ${t.conditions.map(conditionText).join(' ; ')}.` : "Conditions suspensives de l'offre acceptée : aucune.",
  ];
  if (t.loanDeadline) lines.push(`Date limite d'obtention du prêt prévue : ${frDay(t.loanDeadline)}.`);
  lines.push(`Signature de l'acte prévue au plus tard le ${frDay(t.deedBy)}.`);
  lines.push(t.depositEur > 0 ? `Dépôt de garantie prévu : ${euros(t.depositEur)}, reçu par le notaire.` : 'Dépôt de garantie prévu : aucun.');
  lines.push("AIMMO et l'agent immobilier ne reçoivent jamais de fonds : tout l'argent de la vente passe par le notaire.");
  return lines.join('\n');
}

const LABELS: Record<string, string> = {
  prix: 'Prix',
  date_limite_pret: "Date limite d'obtention du prêt",
  acte_prevu: "Date de l'acte",
  'depot_garantie.montant': 'Dépôt de garantie',
  'depot_garantie.detenteur': 'Dépôt de garantie reçu par',
};

/** Le texte d'une différence, pour l'agent, écrit par le code. */
export function differenceText(d: Difference): string {
  const condition = /^condition\.([a-z_]+)(?:\.(amountEur|durationMonths|maxRateBp|loanType))?$/.exec(d.field);
  const part: Record<string, string> = { amountEur: ', montant', durationMonths: ', durée', maxRateBp: ', taux maximal hors assurance', loanType: ', type de prêt' };
  const label = condition
    ? `Condition suspensive « ${CONDITION_LABEL[condition[1] as ConditionKind] ?? condition[1]} »${condition[2] ? part[condition[2]] : ''}`
    : (LABELS[d.field] ?? d.field);
  const where = d.page ? ` (page ${d.page})` : '';
  return `${label} : ${d.expected ?? 'rien'} dans l'offre acceptée et le dossier, ${d.found ?? 'rien'} dans le projet du notaire${where}.${d.blocking ? " À faire corriger : le dépôt de garantie est reçu par le notaire, jamais par l'agence ni par le vendeur." : ''}`;
}

/** Les différences entre la note et le projet, dans un ordre fixe : mêmes entrées, mêmes différences [R511]. */
export function compareDraft(brief: BriefTerms, draft: DraftTerms): Difference[] {
  const out: Difference[] = [];
  const push = (field: string, expected: string | null, found: string | null, page: number | null, blocking = false) => out.push({ field, expected, found, page, blocking });
  if (draft.priceEur.value !== brief.priceEur) push('prix', euros(brief.priceEur), euros(draft.priceEur.value), draft.priceEur.page);
  for (const kind of CONDITION_KINDS) {
    const b = brief.conditions.find((c) => c.kind === kind);
    const d = draft.conditions.find((c) => c.kind === kind);
    if (b && !d) push(`condition.${kind}`, b.kind === 'pret' ? conditionText(b) : 'prévue', null, null);
    else if (!b && d) push(`condition.${kind}`, null, d.kind === 'pret' ? conditionText(d) : 'ajoutée', d.page);
    else if (b && d && b.kind === 'pret' && d.kind === 'pret') {
      if (b.amountEur !== d.amountEur) push('condition.pret.amountEur', euros(b.amountEur), euros(d.amountEur), d.page);
      if (b.durationMonths !== d.durationMonths) push('condition.pret.durationMonths', `${b.durationMonths} mois`, `${d.durationMonths} mois`, d.page);
      // Le taux maximal et le type : déclarés d'un côté seulement, ou différents, c'est une différence (AU079).
      if (b.maxRateBp !== d.maxRateBp) push('condition.pret.maxRateBp', b.maxRateBp !== undefined ? rateText(b.maxRateBp) : null, d.maxRateBp !== undefined ? rateText(d.maxRateBp) : null, d.page);
      if (b.loanType !== d.loanType) push('condition.pret.loanType', b.loanType ? LOAN_TYPE_LABEL[b.loanType] : null, d.loanType ? LOAN_TYPE_LABEL[d.loanType] : null, d.page);
    }
  }
  const dateDiff = (field: string, expected: string | null, found: Paged<string> | null) => {
    if ((expected ?? null) !== (found?.value ?? null)) push(field, expected ? frDay(expected) : null, found ? frDay(found.value) : null, found?.page ?? null);
  };
  dateDiff('date_limite_pret', brief.loanDeadline, draft.loanDeadline);
  dateDiff('acte_prevu', brief.deedBy, draft.deedBy);
  const found = draft.deposit;
  if ((found?.eur ?? 0) !== brief.depositEur) push('depot_garantie.montant', brief.depositEur > 0 ? euros(brief.depositEur) : null, found && found.eur > 0 ? euros(found.eur) : null, found?.page ?? null);
  if (found && found.eur > 0 && found.holder !== 'notaire') push('depot_garantie.detenteur', 'le notaire', found.holder === 'agence' ? "l'agence" : found.holder === 'vendeur' ? 'le vendeur' : 'un autre que le notaire', found.page, true);
  return out;
}

function parseCondition(v: unknown, paged: boolean): OfferCondition | (OfferCondition & { page: number }) | null {
  if (!isRecord(v) || !(CONDITION_KINDS as readonly unknown[]).includes(v.kind)) return null;
  const extra = paged ? ['page'] : [];
  if (paged && !isPage(v.page)) return null;
  const page = paged ? { page: v.page as number } : {};
  if (v.kind === 'pret') {
    const loan = parseLoan(v, extra);
    return loan.ok ? { ...loan.value, ...page } : null;
  }
  if (!onlyKeys(v, ['kind', ...extra])) return null;
  return { kind: v.kind, ...page } as OfferCondition;
}

/** Lit les termes du projet saisis par l'agent ; rend le champ fautif. */
export function parseDraftTerms(input: Record<string, unknown>): { ok: true; value: DraftTerms } | { ok: false; field: string } {
  const p = input.priceEur;
  if (!isRecord(p) || !onlyKeys(p, ['value', 'page']) || !isInt(p.value, 1, 1_000_000_000) || !isPage(p.page)) return { ok: false, field: 'priceEur' };
  if (!Array.isArray(input.conditions) || input.conditions.length > CONDITION_KINDS.length) return { ok: false, field: 'conditions' };
  const conditions: (OfferCondition & { page: number })[] = [];
  for (const [i, c] of input.conditions.entries()) {
    const parsed = parseCondition(c, true) as (OfferCondition & { page: number }) | null;
    if (!parsed || conditions.some((x) => x.kind === parsed.kind)) return { ok: false, field: `conditions.${i}` };
    conditions.push(parsed);
  }
  const pagedDay = (v: unknown): Paged<string> | null | undefined => {
    if (v === null) return null;
    if (!isRecord(v) || !onlyKeys(v, ['value', 'page']) || !validDay(v.value) || !isPage(v.page)) return undefined;
    return { value: v.value, page: v.page };
  };
  const loanDeadline = pagedDay(input.loanDeadline);
  if (loanDeadline === undefined) return { ok: false, field: 'loanDeadline' };
  const deedBy = pagedDay(input.deedBy);
  if (deedBy === undefined) return { ok: false, field: 'deedBy' };
  let deposit: DraftTerms['deposit'] = null;
  if (input.deposit !== null) {
    const d = input.deposit;
    if (!isRecord(d) || !onlyKeys(d, ['eur', 'holder', 'page']) || !isInt(d.eur, 0, 1_000_000_000) || !(DEPOSIT_HOLDERS as readonly unknown[]).includes(d.holder) || !isPage(d.page)) return { ok: false, field: 'deposit' };
    deposit = { eur: d.eur, holder: d.holder as DepositHolder, page: d.page };
  }
  return { ok: true, value: { priceEur: { value: p.value, page: p.page }, conditions, loanDeadline, deedBy, deposit } };
}

interface BriefRow { id: string; file_id: string; version: number; terms: string; hash: string; prepared_at: string }
interface DraftRow { id: string; file_id: string; version: number; document_ref: string; brief_id: string; terms: string; recorded_at: string }

const toBrief = (r: BriefRow): Brief => {
  const terms = JSON.parse(r.terms) as BriefTerms;
  return { id: r.id, fileId: r.file_id, version: Number(r.version), terms, hash: r.hash, text: briefText(terms), preparedAt: r.prepared_at };
};
const toDraft = (r: DraftRow): Draft => ({ id: r.id, fileId: r.file_id, version: Number(r.version), documentRef: r.document_ref, briefId: r.brief_id, terms: JSON.parse(r.terms) as DraftTerms, recordedAt: r.recorded_at });

export class AvantContrat {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly echeancier: Echeancier;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    /** Le stockage des pièces : un projet ou une attestation qui n'y est pas rangé est refusé. */
    private readonly storage: { has(ref: string): Promise<boolean> },
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.echeancier = new Echeancier(db, acces, journal, { now: this.now, proofs: storage });
  }

  private gate(viewer: Viewer, fileId: string, write: boolean) {
    return gateSaleFile({ db: this.db, acces: this.acces, journal: this.journal, now: this.now }, viewer, fileId, write, 'pre_contract');
  }

  private today(): string {
    return localTime(this.now(), TIME_ZONE).date;
  }

  private async lastBrief(fileId: string): Promise<Brief | null> {
    const r = await this.db.first<BriefRow>('SELECT id, file_id, version, terms, hash, prepared_at FROM pre_contract_briefs WHERE file_id = ? ORDER BY version DESC LIMIT 1', [fileId]);
    return r ? toBrief(r) : null;
  }

  private async lastDraft(fileId: string): Promise<Draft | null> {
    const r = await this.db.first<DraftRow>('SELECT id, file_id, version, document_ref, brief_id, terms, recorded_at FROM notary_drafts WHERE file_id = ? ORDER BY version DESC LIMIT 1', [fileId]);
    return r ? toDraft(r) : null;
  }

  private async differencesOf(draftId: string): Promise<Difference[]> {
    const rows = await this.db.all<{ field: string; expected: string | null; found: string | null; page: number | null; blocking: number }>(
      'SELECT field, expected, found, page, blocking FROM notary_draft_differences WHERE draft_id = ? ORDER BY seq',
      [draftId],
    );
    return rows.map((r) => ({ field: r.field, expected: r.expected, found: r.found, page: r.page === null ? null : Number(r.page), blocking: Number(r.blocking) === 1 }));
  }

  private async started(fileId: string): Promise<boolean> {
    return (await this.db.first("SELECT 1 FROM sale_file_steps WHERE file_id = ? AND step = 'compromis_en_preparation'", [fileId])) !== null;
  }

  /**
   * L'agent du bien prépare la note au notaire. Le prix vient du dossier, les conditions de l'offre acceptée, sans
   * changement possible [R510] ; une note aux mêmes termes que la dernière la rend, sans nouvelle version.
   */
  async prepare(viewer: Viewer, fileId: string, input: { depositEur: unknown; loanDeadline: unknown; deedBy: unknown }): Promise<{ ok: true; value: Brief } | FileRefusal | FileUnknown | Problem> {
    const g = await this.gate(viewer, fileId, true);
    if (!g.ok) return g;
    if (await this.db.first('SELECT 1 FROM sale_file_closings WHERE file_id = ?', [fileId])) return { ok: false, rule: null, code: 'closed' };
    if (!(await this.started(fileId))) {
      await appendEvent(this.journal, { type: 'dossier.bloque', actor: actorOf(viewer), subject: `sale_file:${fileId}`, data: { rule: 'R58', code: 'compromis_not_started' } }, this.now);
      return { ok: false, rule: 'R58', code: 'compromis_not_started' };
    }
    const file = await this.db.first<{ amount_eur: number; conditions: string }>(
      'SELECT f.amount_eur, o.conditions FROM sale_files f JOIN offer_register o ON o.id = f.offer_id WHERE f.id = ?',
      [fileId],
    );
    if (!file) return { ok: false, rule: null, code: 'unknown_offer' };
    const priceEur = Number(file.amount_eur);
    const conditions = JSON.parse(file.conditions) as OfferCondition[];
    const hasLoan = conditions.some((c) => c.kind === 'pret');
    if (!isInt(input.depositEur, 0, priceEur)) return { ok: false, rule: null, code: 'bad_deposit' };
    if (hasLoan ? !validDay(input.loanDeadline) : input.loanDeadline !== null) return { ok: false, rule: null, code: 'bad_loan_deadline' };
    if (!validDay(input.deedBy)) return { ok: false, rule: null, code: 'bad_deed_day' };
    const today = this.today();
    const loanDeadline = hasLoan ? (input.loanDeadline as string) : null;
    if (input.deedBy <= today || (loanDeadline !== null && (loanDeadline <= today || loanDeadline >= input.deedBy))) return { ok: false, rule: null, code: 'bad_order' };
    const terms: BriefTerms = { priceEur, conditions, depositEur: input.depositEur, loanDeadline, deedBy: input.deedBy };
    const text = briefText(terms);
    // Écrit par le code, le texte ne peut appeler aucun versement ; vérifié quand même, à chaque note [R62].
    if (fundsInOutgoing(text)) throw new Error('Note au notaire : texte refusé par le contrôle des fonds.');
    const hash = await sha256(JSON.stringify(terms));
    const last = await this.lastBrief(fileId);
    if (last && last.hash === hash) return { ok: true, value: last };
    const version = (last?.version ?? 0) + 1;
    const id = this.newId();
    try {
      await this.db.run(
        'INSERT INTO pre_contract_briefs (id, network_id, file_id, version, terms, hash, prepared_by, prepared_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [id, g.file.network_id, fileId, version, JSON.stringify(terms), hash, actorOf(viewer), this.now().toISOString()],
      );
    } catch (error) {
      if (/UNIQUE/i.test(String(error))) return { ok: false, rule: null, code: 'busy' };
      throw error;
    }
    await appendEvent(this.journal, { type: 'avant_contrat.note', actor: actorOf(viewer), subject: `sale_file:${fileId}`, data: { rule: 'R510', version } }, this.now);
    return { ok: true, value: (await this.lastBrief(fileId))! };
  }

  /**
   * L'agent du bien range le projet du notaire et ce qu'il y lit, terme par terme avec la page. Le code le compare à la
   * dernière note et range chaque différence [R511]. Si le compromis est déjà signé, les dates du projet passent aussitôt
   * dans l'échéancier [R513].
   */
  async recordDraft(viewer: Viewer, fileId: string, input: Record<string, unknown>): Promise<{ ok: true; value: { draft: Draft; differences: Difference[]; dates: DatesReport | null } } | FileRefusal | FileUnknown | Problem> {
    const g = await this.gate(viewer, fileId, true);
    if (!g.ok) return g;
    if (await this.db.first('SELECT 1 FROM sale_file_closings WHERE file_id = ?', [fileId])) return { ok: false, rule: null, code: 'closed' };
    const brief = await this.lastBrief(fileId);
    if (!brief) return { ok: false, rule: null, code: 'no_brief' };
    const ref = input.documentRef;
    if (typeof ref !== 'string' || !PROOF_REF.test(ref)) return { ok: false, rule: null, code: 'bad_document' };
    const parsed = parseDraftTerms(input);
    if (!parsed.ok) return { ok: false, rule: null, code: `bad_${parsed.field}` };
    if (!(await this.storage.has(ref))) return { ok: false, rule: null, code: 'not_stored' };
    const last = await this.lastDraft(fileId);
    // Le même projet, lu de la même façon, contre la même note : rien de neuf.
    if (last && last.documentRef === ref && last.briefId === brief.id && JSON.stringify(last.terms) === JSON.stringify(parsed.value)) {
      return { ok: true, value: { draft: last, differences: await this.differencesOf(last.id), dates: null } };
    }
    const differences = compareDraft(brief.terms, parsed.value);
    const version = (last?.version ?? 0) + 1;
    const id = this.newId();
    const at = this.now().toISOString();
    try {
      await runBatch(this.db, [
        {
          sql: 'INSERT INTO notary_drafts (id, network_id, file_id, version, document_ref, terms, brief_id, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          params: [id, g.file.network_id, fileId, version, ref, JSON.stringify(parsed.value), brief.id, actorOf(viewer), at],
        },
        ...differences.map((d, i) => ({
          sql: 'INSERT INTO notary_draft_differences (draft_id, network_id, file_id, seq, field, expected, found, page, blocking) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          params: [id, g.file.network_id, fileId, i + 1, d.field, d.expected, d.found, d.page, d.blocking ? 1 : 0],
        })),
      ]);
    } catch (error) {
      if (/UNIQUE/i.test(String(error))) return { ok: false, rule: null, code: 'busy' };
      throw error;
    }
    // Au journal : la version et les seuls noms des termes qui diffèrent, aucun montant [R13].
    await appendEvent(this.journal, { type: 'avant_contrat.projet', actor: actorOf(viewer), subject: `sale_file:${fileId}`, data: { rule: 'R511', version, differences: differences.map((d) => d.field), blocking: differences.some((d) => d.blocking) } }, this.now);
    const draft = (await this.lastDraft(fileId))!;
    const signed = await this.db.first("SELECT 1 FROM sale_file_dates WHERE file_id = ? AND kind = 'compromis_signe'", [fileId]);
    const filled = signed ? await this.fill(viewer, draft) : null;
    return { ok: true, value: { draft, differences, dates: filled && 'report' in filled ? filled.report : null } };
  }

  /**
   * Les différences du dernier projet avec la dernière note : celles rangées avec le projet s'il a été comparé à cette
   * note, sinon recalculées contre la note plus récente, pour ne jamais montrer une comparaison dépassée [R511].
   */
  private async current(fileId: string): Promise<{ brief: Brief | null; draft: Draft | null; differences: Difference[]; stale: boolean }> {
    const brief = await this.lastBrief(fileId);
    const draft = await this.lastDraft(fileId);
    if (!draft || !brief) return { brief, draft, differences: [], stale: false };
    if (draft.briefId === brief.id) return { brief, draft, differences: await this.differencesOf(draft.id), stale: false };
    return { brief, draft, differences: compareDraft(brief.terms, draft.terms), stale: true };
  }

  /** Les dates d'un projet qui confie le dépôt à un autre que le notaire ne passent pas : à faire corriger d'abord [R512]. */
  private async blocked(viewer: Viewer | null, fileId: string): Promise<boolean> {
    const c = await this.current(fileId);
    if (!c.differences.some((d) => d.blocking)) return false;
    await appendEvent(this.journal, { type: 'avant_contrat.dates_bloquees', actor: viewer ? actorOf(viewer) : 'system:avant-contrat', subject: `sale_file:${fileId}`, data: { rule: 'R512', code: 'blocking_difference' } }, this.now);
    return true;
  }

  private async fill(viewer: Viewer, draft: Draft): Promise<{ report: DatesReport } | Blocked> {
    if (await this.blocked(viewer, draft.fileId)) return { ok: false, rule: 'R512', code: 'blocking_difference' };
    const report: DatesReport = {};
    const current = await this.echeancier.schedule(viewer, draft.fileId);
    const dates = current.ok ? current.value.dates : {};
    const pairs: ['date_limite_pret' | 'acte_prevu', Paged<string> | null][] = [
      ['date_limite_pret', draft.terms.loanDeadline],
      ['acte_prevu', draft.terms.deedBy],
    ];
    for (const [kind, value] of pairs) {
      if (!value) continue;
      if (dates[kind as DateKind]?.day === value.value) {
        report[kind] = 'deja_la';
        continue;
      }
      const r = await this.echeancier.record(viewer, draft.fileId, { kind, day: value.value, proofRef: draft.documentRef });
      report[kind] = r.ok ? 'ecrite' : r.code;
    }
    await appendEvent(this.journal, { type: 'avant_contrat.dates', actor: actorOf(viewer), subject: `sale_file:${draft.fileId}`, data: { rule: 'R513', version: draft.version, report } }, this.now);
    return { report };
  }

  /**
   * Le passage du système : pour chaque dossier ouvert dont le compromis est signé, les dates du dernier projet passent
   * dans l'échéancier, avec le projet pour preuve, sans que l'agent ressaisisse rien, même si la signature a été saisie
   * après le projet [R513]. Mêmes contrôles que N02 : ordre des dates, preuve rangée, dossier ni clos ni arrêté ; un
   * projet bloquant ne passe pas [R512]. Rend le nombre de dates écrites.
   */
  async run(networkId: string): Promise<number> {
    const files = await this.db.all<{ id: string }>(
      `SELECT f.id FROM sale_files f WHERE f.network_id = ?
       AND EXISTS (SELECT 1 FROM sale_file_dates d WHERE d.file_id = f.id AND d.kind = 'compromis_signe')
       AND EXISTS (SELECT 1 FROM notary_drafts n WHERE n.file_id = f.id)
       AND NOT EXISTS (SELECT 1 FROM sale_file_closings c WHERE c.file_id = f.id) AND ${openFile('f')} ORDER BY f.opened_at, f.id`,
      [networkId],
    );
    let written = 0;
    for (const f of files) {
      const draft = (await this.lastDraft(f.id))!;
      if (await this.blocked(null, f.id)) continue;
      if (!(await this.storage.has(draft.documentRef))) continue;
      const rows = await this.db.all<{ kind: DateKind; day: string; version: number }>(
        `SELECT kind, day, version FROM sale_file_dates d WHERE file_id = ?
         AND version = (SELECT MAX(version) FROM sale_file_dates e WHERE e.file_id = d.file_id AND e.kind = d.kind)`,
        [f.id],
      );
      const dates = Object.fromEntries(rows.map((r) => [r.kind, { day: r.day, version: Number(r.version) }])) as Partial<Record<DateKind, { day: string; version: number }>>;
      const report: DatesReport = {};
      for (const [kind, value] of [['date_limite_pret', draft.terms.loanDeadline], ['acte_prevu', draft.terms.deedBy]] as const) {
        if (!value || dates[kind]?.day === value.value) continue;
        const proposed = Object.fromEntries(Object.entries(dates).map(([k, v]) => [k, v!.day])) as Partial<Record<DateKind, string>>;
        proposed[kind] = value.value;
        const problem = orderProblem(proposed);
        if (problem) {
          report[kind] = problem;
          continue;
        }
        try {
          await this.db.run(
            'INSERT INTO sale_file_dates (file_id, network_id, kind, version, day, proof_ref, at, by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [f.id, networkId, kind, (dates[kind]?.version ?? 0) + 1, value.value, draft.documentRef, this.now().toISOString(), 'system:avant-contrat'],
          );
        } catch (error) {
          if (/UNIQUE/i.test(String(error))) continue;
          throw error;
        }
        dates[kind] = { day: value.value, version: (dates[kind]?.version ?? 0) + 1 };
        report[kind] = 'ecrite';
        written += 1;
      }
      if (Object.keys(report).length) await appendEvent(this.journal, { type: 'avant_contrat.dates', actor: 'system:avant-contrat', subject: `sale_file:${f.id}`, data: { rule: 'R513', version: draft.version, report } }, this.now);
    }
    return written;
  }

  /** Après la signature du compromis, l'agent reporte d'un geste les dates du dernier projet dans l'échéancier [R513]. */
  async reportDates(viewer: Viewer, fileId: string): Promise<{ ok: true; value: DatesReport } | FileRefusal | FileUnknown | Problem> {
    const g = await this.gate(viewer, fileId, true);
    if (!g.ok) return g;
    const draft = await this.lastDraft(fileId);
    if (!draft) return { ok: false, rule: null, code: 'no_draft' };
    if (!(await this.db.first("SELECT 1 FROM sale_file_dates WHERE file_id = ? AND kind = 'compromis_signe'", [fileId]))) return { ok: false, rule: 'R513', code: 'compromis_not_signed' };
    const filled = await this.fill(viewer, draft);
    return 'report' in filled ? { ok: true, value: filled.report } : filled;
  }

  /** Le dépôt de garantie, reçu par le notaire et par personne d'autre, avec l'attestation du notaire [R512]. */
  async recordDeposit(viewer: Viewer, fileId: string, input: { amountEur: unknown; receivedBy: unknown; receivedOn: unknown; proofRef: unknown }): Promise<{ ok: true; value: DepositStatus } | FileRefusal | FileUnknown | Problem> {
    const g = await this.gate(viewer, fileId, true);
    if (!g.ok) return g;
    if (input.receivedBy !== 'notaire') {
      await appendEvent(this.journal, { type: 'avant_contrat.depot_refuse', actor: actorOf(viewer), subject: `sale_file:${fileId}`, data: { rule: 'R512', code: 'notary_only' } }, this.now);
      return { ok: false, rule: 'R512', code: 'notary_only' };
    }
    if (!isInt(input.amountEur, 1, 1_000_000_000)) return { ok: false, rule: null, code: 'bad_amount' };
    if (!validDay(input.receivedOn) || input.receivedOn > this.today()) return { ok: false, rule: null, code: 'bad_day' };
    if (typeof input.proofRef !== 'string' || !PROOF_REF.test(input.proofRef)) return { ok: false, rule: null, code: 'bad_proof' };
    if (!(await this.storage.has(input.proofRef))) return { ok: false, rule: null, code: 'not_stored' };
    const last = await this.db.first<{ version: number; amount_eur: number; received_on: string; proof_ref: string }>('SELECT version, amount_eur, received_on, proof_ref FROM pre_contract_deposits WHERE file_id = ? ORDER BY version DESC LIMIT 1', [fileId]);
    if (!(last && Number(last.amount_eur) === input.amountEur && last.received_on === input.receivedOn && last.proof_ref === input.proofRef)) {
      try {
        await this.db.run(
          "INSERT INTO pre_contract_deposits (file_id, network_id, version, amount_eur, received_by, received_on, proof_ref, recorded_by, recorded_at) VALUES (?, ?, ?, ?, 'notaire', ?, ?, ?, ?)",
          [fileId, g.file.network_id, (last ? Number(last.version) : 0) + 1, input.amountEur, input.receivedOn, input.proofRef, actorOf(viewer), this.now().toISOString()],
        );
      } catch (error) {
        if (/UNIQUE|PRIMARY/i.test(String(error))) return { ok: false, rule: null, code: 'busy' };
        throw error;
      }
      await appendEvent(this.journal, { type: 'avant_contrat.depot', actor: actorOf(viewer), subject: `sale_file:${fileId}`, data: { rule: 'R512' } }, this.now);
    }
    return { ok: true, value: await this.depositOf(fileId) };
  }

  private async depositOf(fileId: string): Promise<DepositStatus> {
    const draft = await this.lastDraft(fileId);
    const brief = await this.lastBrief(fileId);
    const expectedEur = draft ? (draft.terms.deposit?.eur ?? 0) : (brief?.terms.depositEur ?? null);
    const r = await this.db.first<{ amount_eur: number; received_on: string }>('SELECT amount_eur, received_on FROM pre_contract_deposits WHERE file_id = ? ORDER BY version DESC LIMIT 1', [fileId]);
    const receivedEur = r ? Number(r.amount_eur) : null;
    const status = receivedEur === null ? (expectedEur ? 'attendu' : 'sans_objet') : expectedEur !== null && receivedEur !== expectedEur ? 'ecart' : 'recu';
    return { expectedEur, receivedEur, receivedBy: 'notaire', receivedOn: r?.received_on ?? null, status };
  }

  /** L'état de l'avant-contrat : note, dernier projet et ses différences, dépôt. Agent du bien, direction, conformité [R16]. */
  async state(viewer: Viewer, fileId: string): Promise<{ ok: true; value: PreContractState } | FileRefusal | FileUnknown> {
    const g = await this.gate(viewer, fileId, false);
    if (!g.ok) return g;
    const { brief, draft, differences, stale } = await this.current(fileId);
    return { ok: true, value: { brief, draft, differences, texts: differences.map(differenceText), comparedToEarlierBrief: stale, blocked: differences.some((d) => d.blocking), deposit: await this.depositOf(fileId) } };
  }
}

export interface DepositStatus {
  /** Le dépôt du dernier projet, ou à défaut celui de la note ; null sans note. */
  expectedEur: number | null;
  receivedEur: number | null;
  receivedBy: 'notaire';
  receivedOn: string | null;
  status: 'attendu' | 'recu' | 'ecart' | 'sans_objet';
}

export interface PreContractState {
  brief: Brief | null;
  draft: Draft | null;
  differences: Difference[];
  texts: string[];
  /** Le dernier projet avait été rangé contre une note plus ancienne : ses différences sont recalculées contre la dernière. */
  comparedToEarlierBrief: boolean;
  /** Une différence bloquante : les dates du projet ne passent pas dans l'échéancier tant qu'il n'est pas corrigé [R512]. */
  blocked: boolean;
  deposit: DepositStatus;
}
