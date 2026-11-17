/**
 * Le mandat par questionnaire (HX33, M06).
 *
 * L'agent répond à des questions d'une liste fermée ; chaque réponse retient, ou non, des clauses d'une liste fermée du
 * code. Chaque clause retenue garde la question, la réponse qui l'a déclenchée et le texte de loi sur lequel elle
 * repose, et le mandat le montre au vendeur à côté de la clause [R440]. Le texte d'une clause est écrit par la
 * direction, versionné, et ne sert à un vrai mandat qu'une fois validé par la conformité (H08) ; le modèle du mandat
 * aussi (D02). Sinon le mandat préparé reste d'essai [R442]. L'IA ne rédige rien.
 *
 * Le mandat est prérempli depuis la base par la génération de D02 (mandant, bien, prix, agent), et son prix est
 * comparé à la fourchette du dernier avis de valeur validé du bien (E09) : un écart au-delà du réglage, ou l'absence
 * d'avis validé, est signalé, et le mandat n'est pas prêt à signer tant que l'agent du bien n'a pas dit l'avoir
 * montré au vendeur [R441]. Tout s'ajoute, rien ne se réécrit [R443]. Le journal ne porte que des identifiants, des
 * codes et des drapeaux, jamais un prix ni un texte [R13].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { escapeHtml, sha256, type DocumentKind, type Modeles } from '../documents/modeles.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

/** Les questions, chacune avec ses réponses permises, dans l'ordre où l'agent les pose. */
export const QUESTIONS = Object.freeze({
  exclusivite: { label: 'Le vendeur confie-t-il la vente à AIMMO seul ?', answers: { oui: 'oui, en exclusivité', non: 'non, mandat simple' } },
  lieu_signature: { label: 'Où le mandat est-il signé ?', answers: { agence: 'à l’agence', hors_agence: 'hors de l’agence (domicile du vendeur)', distance: 'à distance' } },
  vendeurs: { label: 'Combien de personnes vendent le bien ?', answers: { une: 'une seule personne', plusieurs: 'plusieurs personnes (couple, indivision)' } },
  occupation: { label: 'Le bien est-il loué ?', answers: { libre: 'non, il est libre', loue: 'oui, un locataire l’occupe' } },
  copropriete: { label: 'Le bien est-il un lot de copropriété ?', answers: { oui: 'oui', non: 'non' } },
  honoraires: { label: 'Qui paie les honoraires ?', answers: { vendeur: 'le vendeur', acquereur: 'l’acquéreur' } },
} as const);
export type QuestionCode = keyof typeof QUESTIONS;
export type Answers = { [Q in QuestionCode]: keyof (typeof QUESTIONS)[Q]['answers'] };
export const QUESTION_CODES = Object.keys(QUESTIONS) as QuestionCode[];

/**
 * Les clauses, chacune déclenchée par une ou plusieurs réponses, avec le texte sur lequel elle repose. Les références
 * sont celles de la loi ; le texte de la clause, lui, est écrit par la direction et validé par la conformité.
 */
export const CLAUSES = Object.freeze({
  exclusivite: { title: 'Exclusivité', when: [['exclusivite', 'oui']], basis: 'Décret n° 72-678 du 20 juillet 1972, article 78', evidence: true },
  retractation: { title: 'Droit de rétractation de 14 jours', when: [['lieu_signature', 'hors_agence'], ['lieu_signature', 'distance']], basis: 'Code de la consommation, articles L221-18 et L221-5', evidence: true },
  tous_vendeurs: { title: 'Accord de tous les vendeurs', when: [['vendeurs', 'plusieurs']], basis: 'Code civil, article 815-3', evidence: false },
  bien_loue: { title: 'Bien vendu occupé', when: [['occupation', 'loue']], basis: 'Loi n° 89-462 du 6 juillet 1989, article 15', evidence: false },
  copropriete: { title: 'Lot de copropriété', when: [['copropriete', 'oui']], basis: 'Loi n° 65-557 du 10 juillet 1965, article 46', evidence: false },
  honoraires_acquereur: { title: 'Honoraires à la charge de l’acquéreur', when: [['honoraires', 'acquereur']], basis: 'Arrêté du 10 janvier 2017 relatif à l’information des consommateurs par les professionnels intervenant dans une transaction immobilière', evidence: false },
} as const satisfies Record<string, { title: string; when: readonly (readonly [QuestionCode, string])[]; basis: string; evidence: boolean }>);
export type ClauseCode = keyof typeof CLAUSES;
export const CLAUSE_CODES = Object.keys(CLAUSES) as ClauseCode[];

/** L'écart toléré par défaut, tant que la direction n'a rien réglé : 5 % hors de la fourchette. */
export const DEFAULT_MAX_GAP_BPS = 500;
const MAX_CLAUSE_BODY = 5000;

export type PriceCheck = 'dans_fourchette' | 'ecart' | 'sans_avis' | 'sans_prix';

/** Une clause retenue : ce qui l'a déclenchée et sur quoi elle repose [R440]. */
export interface RetainedClause {
  code: ClauseCode;
  title: string;
  question: QuestionCode;
  answer: string;
  basis: string;
  /** null quand aucun texte n'est encore écrit pour ce code. */
  clauseId: string | null;
  version: number | null;
  hash: string | null;
  status: 'valide' | 'essai' | 'manquante';
}

export interface PreparedMandate {
  id: string;
  documentId: string;
  kind: DocumentKind;
  mode: 'essai' | 'reel';
  /** Ce qui manque : champs du modèle (`champ:<nom>`) et clauses sans texte (`clause:<code>`). */
  missing: string[];
  clauses: RetainedClause[];
  price: { priceEur: number | null; low: number | null; high: number | null; gapBps: number | null; maxGapBps: number; check: PriceCheck; valuationId: string | null };
  content: string;
  contentHash: string;
  createdAt: string;
}

export type Blocker = 'essai' | 'manque' | 'ecart_prix' | 'sans_avis' | 'sans_prix';

/** Un mandat préparé, rouvert depuis son bien : sans le texte du document, avec le geste et le contrôle [R441]. */
export interface ReopenedMandate extends Omit<PreparedMandate, 'content'> {
  gapAcknowledged: boolean;
  ready: boolean;
  blockers: Blocker[];
}

export interface PrepareRequest {
  personId: string;
  propertyId: string;
  answers: unknown;
  /** Les saisies de D02 : montant des honoraires et durée. La charge vient de la réponse « honoraires ». */
  inputs?: { 'honoraires.montant'?: unknown; 'mandat.duree_mois'?: unknown };
}

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem = { ok: false; rule: 'R440' | 'R441' | 'R442' | 'R40' | null; code: string };

/** Les réponses, vérifiées : chaque question a une réponse de sa liste, rien d'autre ; null sinon. */
export function readAnswers(raw: unknown): Answers | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length !== QUESTION_CODES.length) return null;
  const out: Record<string, string> = {};
  for (const [q, a] of entries) {
    if (!Object.hasOwn(QUESTIONS, q) || typeof a !== 'string' || !Object.hasOwn(QUESTIONS[q as QuestionCode].answers, a)) return null;
    out[q] = a;
  }
  return out as Answers;
}

/** Les clauses que des réponses retiennent, chacune avec la première réponse qui la déclenche [R440]. */
export function clausesFor(answers: Answers): { code: ClauseCode; question: QuestionCode; answer: string }[] {
  const out: { code: ClauseCode; question: QuestionCode; answer: string }[] = [];
  for (const code of CLAUSE_CODES) {
    const hit = CLAUSES[code].when.find(([q, a]) => answers[q] === a);
    if (hit) out.push({ code, question: hit[0], answer: hit[1] });
  }
  return out;
}

/**
 * L'écart du prix à la fourchette, en points de base de la borne dépassée, arrondi au point au-dessus : 0 dans la
 * fourchette. Calcul entier, sans virgule flottante.
 */
export function priceGapBps(price: number, low: number, high: number): number {
  if (price > high) return Math.ceil(((price - high) * 10_000) / high);
  if (price < low) return Math.ceil(((low - price) * 10_000) / low);
  return 0;
}

const euros = (n: number): string => `${new Intl.NumberFormat('fr-FR').format(n)} €`;
const percent = (bps: number): string => `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 }).format(bps / 100)} %`;

/**
 * La partie du mandat faite par le questionnaire : chaque clause, puis, en petit, la question, la réponse et le texte
 * de loi qui la fondent [R440]. Une clause sans texte est montrée « à écrire », jamais inventée.
 */
export function renderClauses(clauses: readonly (RetainedClause & { body: string | null })[]): string {
  if (clauses.length === 0) return '';
  const items = clauses.map((c) => {
    const q = QUESTIONS[c.question];
    const version = c.version === null || c.hash === null ? 'Texte de la clause : pas encore écrit.' : `Texte de la clause : version ${c.version}, empreinte ${escapeHtml(c.hash)}.`;
    const why = `<p class="pourquoi">Retenue par la réponse « ${escapeHtml((q.answers as Record<string, string>)[c.answer]!)} » à la question « ${escapeHtml(q.label)} ». Texte : ${escapeHtml(c.basis)}. ${version}</p>`;
    const body = c.body === null ? `<span class="manque">[à écrire : clause « ${escapeHtml(c.title)} »]</span>` : escapeHtml(c.body).replace(/\r\n?|\n/g, '<br>');
    return `<p${CLAUSES[c.code].evidence ? ' class="evidence"' : ''}><strong>${escapeHtml(c.title)}.</strong> ${body}</p>\n${why}`;
  });
  return `<section class="clauses">\n<p class="titre-clauses"><strong>Clauses retenues par le questionnaire</strong></p>\n${items.join('\n')}\n</section>`;
}

/** Le relevé du prix, écrit dans le mandat avant la signature, avec la date de l'avis [R441]. */
export function renderPriceCheck(p: PreparedMandate['price'], valuationDate: string | null): string {
  const date = valuationDate ? `${valuationDate.slice(8, 10)}/${valuationDate.slice(5, 7)}/${valuationDate.slice(0, 4)}` : null;
  let text: string;
  if (p.check === 'sans_prix') text = 'Le bien n’a pas encore de prix : il n’a pas pu être comparé à l’avis de valeur.';
  else if (p.check === 'sans_avis') text = 'Aucun avis de valeur validé pour ce bien : le prix n’a pas pu être comparé.';
  else {
    const range = `entre ${euros(p.low!)} et ${euros(p.high!)}`;
    const head = `Avis de valeur validé le ${date} : ${range}. Prix du mandat : ${euros(p.priceEur!)}.`;
    text = p.gapBps === 0 ? `${head} Le prix est dans la fourchette.` : `${head} Écart de ${percent(p.gapBps!)} ${p.priceEur! > p.high! ? 'au-dessus' : 'au-dessous'} de la fourchette (toléré : ${percent(p.maxGapBps)}).`;
  }
  const flagged = p.check !== 'dans_fourchette';
  return `<section class="prix">\n<p${flagged ? ' class="evidence"' : ''}>${escapeHtml(text)}</p>\n</section>`;
}

/** Une version du texte d'une clause, telle que la direction et la conformité la lisent. */
export interface ClauseVersion {
  id: string;
  code: ClauseCode;
  title: string;
  version: number;
  body: string;
  hash: string;
  createdAt: string;
  status: 'essai' | 'valide';
  validatedAt: string | null;
  ownText: boolean;
}

interface ClauseRow {
  id: string;
  code: string;
  version: number;
  body: string;
  hash: string;
  validated_by: string | null;
}

interface QuestionnaireRow {
  id: string;
  network_id: string;
  agent_id: string;
  person_id: string;
  property_id: string;
  document_id: string;
  valuation_id: string | null;
  answers: string;
  clauses: string;
  price_eur: number | null;
  range_low: number | null;
  range_high: number | null;
  gap_bps: number | null;
  max_gap_bps: number;
  price_check: PriceCheck;
  mode: 'essai' | 'reel';
  missing: string;
  content: string;
  content_hash: string;
  created_at: string;
}

export class MandatQuestionnaire {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly modeles: Modeles,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, code: string, subject: string | null = null): Promise<Refusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind: 'mandat_questionnaire', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  /** Une nouvelle version du texte d'une clause, « essai » : la direction seule. Aucun champ, aucune accolade. */
  async writeClause(viewer: Viewer, code: string, body: string): Promise<{ ok: true; id: string; version: number } | Refusal | Problem> {
    if (viewer.role !== 'direction') return this.refuse(viewer, 'role');
    if (!Object.hasOwn(CLAUSES, code)) return { ok: false, rule: 'R440', code: 'unknown_clause' };
    if (typeof body !== 'string' || body.trim() === '') return { ok: false, rule: null, code: 'empty_body' };
    if (body.length > MAX_CLAUSE_BODY) return { ok: false, rule: null, code: 'body_too_long' };
    // Un texte de clause ne se remplit pas : un champ y serait recopié tel quel.
    if (/\{\{|\}\}/.test(body)) return { ok: false, rule: 'R40', code: 'field_in_clause' };
    const text = body.trim();
    const hash = await sha256(JSON.stringify([code, text]));
    for (let attempt = 0; attempt < 5; attempt++) {
      const last = await this.db.first<{ v: number | null }>('SELECT MAX(version) AS v FROM mandate_clause_versions WHERE network_id = ? AND code = ?', [viewer.networkId, code]);
      const version = Number(last?.v ?? 0) + 1;
      const id = this.newId();
      const { changes } = await this.db.run(
        `INSERT INTO mandate_clause_versions (id, network_id, code, version, body, hash, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (network_id, code, version) DO NOTHING`,
        [id, viewer.networkId, code, version, text, hash, this.actor(viewer), this.now().toISOString()],
      );
      if (changes !== 1) continue;
      await appendEvent(this.journal, { type: 'mandat_clause.version', actor: this.actor(viewer), subject: `clause:${id}`, data: { code, version } }, this.now);
      return { ok: true, id, version };
    }
    throw new Error('clause_version_busy');
  }

  /**
   * Les versions des textes des clauses du réseau, les plus récentes d'abord, chacune dite « essai » ou « validée » :
   * la direction qui les écrit et la conformité qui les valide, seules [R16, R442]. Sans elle, la conformité ne peut
   * pas trouver ce qu'elle valide. Rien n'est réécrit : chaque version reste lisible [R443].
   */
  async clauseVersions(viewer: Viewer): Promise<{ ok: true; versions: ClauseVersion[] } | Refusal> {
    if (viewer.role !== 'direction' && viewer.role !== 'compliance') return this.refuse(viewer, 'role');
    const rows = await this.db.all<{ id: string; code: string; version: number; body: string; hash: string; created_by: string; created_at: string; validated_at: string | null }>(
      `SELECT c.id, c.code, c.version, c.body, c.hash, c.created_by, c.created_at, v.validated_at FROM mandate_clause_versions c
       LEFT JOIN mandate_clause_validations v ON v.clause_id = c.id WHERE c.network_id = ? ORDER BY c.code ASC, c.version DESC`,
      [viewer.networkId],
    );
    const versions = rows
      .filter((r) => Object.hasOwn(CLAUSES, r.code))
      .map((r) => ({
        id: r.id,
        code: r.code as ClauseCode,
        title: CLAUSES[r.code as ClauseCode].title,
        version: Number(r.version),
        body: r.body,
        hash: r.hash,
        createdAt: r.created_at,
        status: (r.validated_at === null ? 'essai' : 'valide') as 'essai' | 'valide',
        validatedAt: r.validated_at,
        // La conformité ne valide jamais ce qu'elle a écrit, sous quelque rôle que ce soit [R442].
        ownText: r.created_by.slice(r.created_by.indexOf(':') + 1) === viewer.userId,
      }));
    return { ok: true, versions };
  }

  /** La conformité seule valide une version, une fois, et jamais une version qu'elle aurait écrite [R442]. */
  async validateClause(viewer: Viewer, clauseId: string): Promise<{ ok: true } | Refusal | Problem> {
    if (viewer.role !== 'compliance') return this.refuse(viewer, 'role', `clause:${clauseId}`);
    const row = await this.db.first<{ id: string; code: string; version: number; created_by: string }>('SELECT id, code, version, created_by FROM mandate_clause_versions WHERE id = ? AND network_id = ?', [clauseId, viewer.networkId]);
    if (!row) return { ok: false, rule: null, code: 'unknown_clause' };
    // La personne, quel que soit le rôle sous lequel elle a écrit : `<rôle>:<identifiant>` [R442].
    if (row.created_by.slice(row.created_by.indexOf(':') + 1) === viewer.userId) return this.refuse(viewer, 'own_clause', `clause:${clauseId}`);
    const { changes } = await this.db.run('INSERT INTO mandate_clause_validations (clause_id, validated_by, validated_at) VALUES (?, ?, ?) ON CONFLICT (clause_id) DO NOTHING', [clauseId, this.actor(viewer), this.now().toISOString()]);
    if (changes !== 1) return { ok: false, rule: 'R442', code: 'already_validated' };
    await appendEvent(this.journal, { type: 'mandat_clause.valide', actor: this.actor(viewer), subject: `clause:${clauseId}`, data: { code: row.code, version: Number(row.version) } }, this.now);
    return { ok: true };
  }

  /** L'écart toléré, en points de base : la direction seule ; chaque réglage s'ajoute [R441]. */
  async setMaxGap(viewer: Viewer, maxGapBps: number): Promise<{ ok: true } | Refusal | Problem> {
    if (viewer.role !== 'direction') return this.refuse(viewer, 'role');
    if (!Number.isInteger(maxGapBps) || maxGapBps < 0 || maxGapBps > 5000) return { ok: false, rule: 'R441', code: 'bad_setting' };
    await this.db.run('INSERT INTO mandate_price_gap_settings (id, network_id, max_gap_bps, set_by, set_at) VALUES (?, ?, ?, ?, ?)', [this.newId(), viewer.networkId, maxGapBps, this.actor(viewer), this.now().toISOString()]);
    await appendEvent(this.journal, { type: 'mandat_questionnaire.reglage', actor: this.actor(viewer), subject: null, data: { maxGapBps } }, this.now);
    return { ok: true };
  }

  private async maxGap(networkId: string): Promise<number> {
    const row = await this.db.first<{ max_gap_bps: number }>('SELECT max_gap_bps FROM mandate_price_gap_settings WHERE network_id = ? ORDER BY set_at DESC, rowid DESC LIMIT 1', [networkId]);
    return row ? Number(row.max_gap_bps) : DEFAULT_MAX_GAP_BPS;
  }

  /**
   * Le texte en vigueur d'une clause : la dernière version validée ; tant qu'aucune ne l'est, la dernière version
   * d'essai, qui ne donne qu'un mandat d'essai. Une version d'essai plus récente ne remplace jamais une validée.
   */
  private async clauseInForce(networkId: string, code: string): Promise<ClauseRow | null> {
    const base = 'SELECT c.id, c.code, c.version, c.body, c.hash, v.validated_by FROM mandate_clause_versions c LEFT JOIN mandate_clause_validations v ON v.clause_id = c.id WHERE c.network_id = ? AND c.code = ?';
    return (await this.db.first<ClauseRow>(`${base} AND v.clause_id IS NOT NULL ORDER BY c.version DESC LIMIT 1`, [networkId, code])) ?? (await this.db.first<ClauseRow>(`${base} ORDER BY c.version DESC LIMIT 1`, [networkId, code]));
  }

  /** Prépare le mandat : le modèle de D02 rempli depuis la base, les clauses du questionnaire, le relevé du prix. */
  async prepare(viewer: Viewer, request: PrepareRequest): Promise<{ ok: true; mandate: PreparedMandate } | Refusal | Problem> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refuse(viewer, 'role');
    const answers = readAnswers(request.answers);
    if (!answers) return { ok: false, rule: 'R440', code: 'bad_answers' };
    const rawInputs = request.inputs ?? {};
    if (typeof rawInputs !== 'object' || rawInputs === null || Object.keys(rawInputs).some((k) => k !== 'honoraires.montant' && k !== 'mandat.duree_mois')) return { ok: false, rule: null, code: 'bad_input' };
    const kind: DocumentKind = answers.exclusivite === 'oui' ? 'mandat_vente_exclusif' : 'mandat_vente_simple';

    // Les clauses retenues, chacune avec sa réponse, son texte de loi et la version de son texte [R440].
    const clauses: (RetainedClause & { body: string | null })[] = [];
    for (const hit of clausesFor(answers)) {
      const row = await this.clauseInForce(viewer.networkId, hit.code);
      clauses.push({
        ...hit,
        title: CLAUSES[hit.code].title,
        basis: CLAUSES[hit.code].basis,
        clauseId: row?.id ?? null,
        version: row ? Number(row.version) : null,
        hash: row?.hash ?? null,
        status: row === null ? 'manquante' : row.validated_by === null ? 'essai' : 'valide',
        body: row?.body ?? null,
      });
    }
    const maxGapBps = await this.maxGap(viewer.networkId);

    // Les droits, le préremplissage et le modèle sont ceux de D02 : la génération lit la fiche et le bien sous droits
    // [R16]. Les clauses et le relevé du prix entrent dans le document même : c'est lui qui passe les contrôles et se
    // signe, et une clause d'essai ou sans texte le rend d'essai ou incomplet [R442].
    let price: PreparedMandate['price'] | null = null;
    const generated = await this.modeles.generate(
      viewer,
      { kind, personId: request.personId, propertyId: request.propertyId, inputs: { ...rawInputs, 'honoraires.charge': answers.honoraires } },
      async ({ priceEur }) => {
        // Le prix lu dans la base, comparé au dernier avis validé du bien, à sa fourchette telle que l'agent l'a validée [R441].
        const valuation = await this.db.first<{ id: string; low: number; high: number; validated_at: string }>(
          `SELECT id, COALESCE(agent_low, computed_low) AS low, COALESCE(agent_high, computed_high) AS high, validated_at FROM valuation_reports
           WHERE network_id = ? AND property_id = ? AND status = 'validated' ORDER BY validated_at DESC, rowid DESC LIMIT 1`,
          [viewer.networkId, request.propertyId],
        );
        if (priceEur === null) price = { priceEur: null, low: null, high: null, gapBps: null, maxGapBps, check: 'sans_prix', valuationId: null };
        else if (!valuation) price = { priceEur, low: null, high: null, gapBps: null, maxGapBps, check: 'sans_avis', valuationId: null };
        else {
          const low = Number(valuation.low);
          const high = Number(valuation.high);
          const gapBps = priceGapBps(priceEur, low, high);
          price = { priceEur, low, high, gapBps, maxGapBps, check: gapBps > maxGapBps ? 'ecart' : 'dans_fourchette', valuationId: valuation.id };
        }
        const html = [renderClauses(clauses), renderPriceCheck(price, valuation?.validated_at ?? null)].filter((x) => x !== '').join('\n');
        return {
          html,
          // Le style du questionnaire s'ajoute à la feuille du document, dans les jetons du système de design [R201].
          css: '.pourquoi{font-size:.85em;color:var(--doux);margin-top:-.4em;overflow-wrap:anywhere}.titre-clauses{margin-top:1.4em}',
          missing: clauses.filter((c) => c.status === 'manquante').map((c) => `clause:${c.code}`),
          trial: clauses.some((c) => c.status !== 'valide'),
        };
      },
    );
    if (!generated.ok) return generated;
    const doc = generated.document;
    const meta = (await this.db.first<{ agent_id: string; person_id: string; property_id: string }>('SELECT agent_id, person_id, property_id FROM documents WHERE id = ?', [doc.id]))!;
    const finalPrice = price as PreparedMandate['price'] | null;
    if (!finalPrice) throw new Error('questionnaire_annex_not_called');
    const missing = doc.missing.map((f) => (f.startsWith('clause:') ? f : `champ:${f}`));
    const mode = doc.mode;
    const content = doc.content;
    const contentHash = doc.contentHash;
    const id = this.newId();
    const at = this.now().toISOString();
    const stored = clauses.map(({ body: _body, ...c }) => c);
    await this.db.run(
      `INSERT INTO mandate_questionnaires (id, network_id, agent_id, person_id, property_id, document_id, valuation_id, answers, clauses, price_eur, range_low, range_high, gap_bps, max_gap_bps, price_check, mode, missing, content, content_hash, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, viewer.networkId, meta.agent_id, meta.person_id, meta.property_id, doc.id, finalPrice.valuationId, JSON.stringify(answers), JSON.stringify(stored), finalPrice.priceEur, finalPrice.low, finalPrice.high, finalPrice.gapBps, maxGapBps, finalPrice.check, mode, JSON.stringify(missing), content, contentHash, this.actor(viewer), at],
    );
    await appendEvent(
      this.journal,
      { type: 'mandat_questionnaire.prepare', actor: this.actor(viewer), subject: `person:${meta.person_id}`, data: { questionnaire: id, document: doc.id, mode, check: finalPrice.check, clauses: stored.length, missing: missing.length } },
      this.now,
    );
    return { ok: true, mandate: { id, documentId: doc.id, kind, mode, missing, clauses: stored, price: finalPrice, content, contentHash, createdAt: at } };
  }

  /** L'agent du bien dit avoir montré l'écart de prix au vendeur ; une seule fois [R441]. */
  async acknowledgeGap(viewer: Viewer, questionnaireId: string): Promise<{ ok: true } | Refusal | Problem> {
    const row = await this.db.first<QuestionnaireRow>('SELECT * FROM mandate_questionnaires WHERE id = ?', [questionnaireId]);
    if (!row || row.network_id !== viewer.networkId) return this.refuse(viewer, 'unknown', `mandat_questionnaire:${questionnaireId}`);
    if (!(await this.isPropertyAgent(viewer, row.property_id))) return this.refuse(viewer, 'not_property_agent', `mandat_questionnaire:${questionnaireId}`);
    if (row.price_check === 'dans_fourchette') return { ok: false, rule: 'R441', code: 'nothing_to_acknowledge' };
    const { changes } = await this.db.run('INSERT INTO mandate_questionnaire_gap_acks (questionnaire_id, by_agent, at) VALUES (?, ?, ?) ON CONFLICT (questionnaire_id) DO NOTHING', [questionnaireId, viewer.userId, this.now().toISOString()]);
    if (changes !== 1) return { ok: false, rule: 'R441', code: 'already_acknowledged' };
    await appendEvent(this.journal, { type: 'mandat_questionnaire.ecart_montre', actor: this.actor(viewer), subject: `mandat_questionnaire:${questionnaireId}`, data: { check: row.price_check } }, this.now);
    return { ok: true };
  }

  /**
   * Ce qui empêche encore de signer un vrai mandat : un mandat d'essai, ce qui manque, un écart pas encore montré.
   * Lu par l'agent du bien, la direction et la conformité [R16].
   */
  async beforeSignature(viewer: Viewer, questionnaireId: string): Promise<{ ok: true; ready: boolean; blockers: ('essai' | 'manque' | 'ecart_prix' | 'sans_avis' | 'sans_prix')[] } | Refusal> {
    const row = await this.db.first<QuestionnaireRow>('SELECT * FROM mandate_questionnaires WHERE id = ?', [questionnaireId]);
    if (!row || row.network_id !== viewer.networkId) return this.refuse(viewer, 'unknown', `mandat_questionnaire:${questionnaireId}`);
    if (viewer.role !== 'direction' && viewer.role !== 'compliance' && !(await this.isPropertyAgent(viewer, row.property_id))) return this.refuse(viewer, 'not_property_agent', `mandat_questionnaire:${questionnaireId}`);
    const blockers: ('essai' | 'manque' | 'ecart_prix' | 'sans_avis' | 'sans_prix')[] = [];
    if (row.mode !== 'reel') blockers.push('essai');
    if ((JSON.parse(row.missing) as string[]).length > 0) blockers.push('manque');
    if (row.price_check !== 'dans_fourchette') {
      const ack = await this.db.first('SELECT questionnaire_id FROM mandate_questionnaire_gap_acks WHERE questionnaire_id = ?', [questionnaireId]);
      if (!ack) blockers.push(row.price_check === 'ecart' ? 'ecart_prix' : row.price_check);
    }
    return { ok: true, ready: blockers.length === 0, blockers };
  }

  /**
   * Les mandats préparés par questionnaire pour un bien, les plus récents d'abord (50 au plus), pour les rouvrir et
   * montrer l'écart plus tard : clauses avec leur réponse et leur texte de loi [R440], relevé du prix, geste déjà fait
   * ou non, et ce qui empêche encore de signer [R441]. Lus par l'agent du bien, la direction et la conformité [R16] ;
   * le texte du document n'est pas rendu ici : il reste avec les documents du bien. Rien n'est réécrit [R443].
   */
  async forProperty(viewer: Viewer, propertyId: string): Promise<{ ok: true; mandates: ReopenedMandate[] } | Refusal> {
    const property = await this.db.first<{ agent_id: string | null }>('SELECT agent_id FROM properties WHERE id = ? AND network_id = ?', [propertyId, viewer.networkId]);
    if (!property) return this.refuse(viewer, 'unknown', `property:${propertyId}`);
    if (viewer.role !== 'direction' && viewer.role !== 'compliance' && !(viewer.role === 'agent' && property.agent_id === viewer.userId)) return this.refuse(viewer, 'not_property_agent', `property:${propertyId}`);
    const rows = await this.db.all<QuestionnaireRow & { ack_at: string | null }>(
      `SELECT q.*, a.at AS ack_at FROM mandate_questionnaires q LEFT JOIN mandate_questionnaire_gap_acks a ON a.questionnaire_id = q.id
       WHERE q.network_id = ? AND q.property_id = ? ORDER BY q.created_at DESC, q.id DESC LIMIT 50`,
      [viewer.networkId, propertyId],
    );
    const mandates = rows.map((row): ReopenedMandate => {
      const missing = JSON.parse(row.missing) as string[];
      const blockers: Blocker[] = [];
      if (row.mode !== 'reel') blockers.push('essai');
      if (missing.length > 0) blockers.push('manque');
      if (row.price_check !== 'dans_fourchette' && row.ack_at === null) blockers.push(row.price_check === 'ecart' ? 'ecart_prix' : row.price_check);
      return {
        id: row.id,
        documentId: row.document_id,
        kind: ((JSON.parse(row.answers) as Answers).exclusivite === 'oui' ? 'mandat_vente_exclusif' : 'mandat_vente_simple') as DocumentKind,
        mode: row.mode,
        missing,
        clauses: JSON.parse(row.clauses) as RetainedClause[],
        price: { priceEur: row.price_eur, low: row.range_low, high: row.range_high, gapBps: row.gap_bps, maxGapBps: Number(row.max_gap_bps), check: row.price_check, valuationId: row.valuation_id },
        contentHash: row.content_hash,
        createdAt: row.created_at,
        gapAcknowledged: row.ack_at !== null,
        ready: blockers.length === 0,
        blockers,
      };
    });
    return { ok: true, mandates };
  }

  private async isPropertyAgent(viewer: Viewer, propertyId: string): Promise<boolean> {
    if (viewer.role !== 'agent') return false;
    const p = await this.db.first<{ agent_id: string | null }>('SELECT agent_id FROM properties WHERE id = ? AND network_id = ?', [propertyId, viewer.networkId]);
    return p?.agent_id === viewer.userId;
  }
}
