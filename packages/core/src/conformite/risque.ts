/**
 * Fiche de risque de chaque client, validée par le responsable (M12, L02) [R14, R17, R23, R91].
 *
 * À l'entrée en relation (mandat pour un vendeur, offre pour un acquéreur), l'agent de la fiche ou le responsable
 * prépare la fiche de risque : une grille écrite et datée, en code, la calcule à partir de trois sortes de sources,
 * chacune citée sur son critère :
 * - « déclaré » : quatre réponses fermées, oui ou non, données par le client (personne politiquement exposée, paiement
 *   comptant, société, relation sans rencontre) ; tout autre champ est refusé, rien de sensible n'entre [R23] ;
 * - « document » : l'état « identité vérifiée » du coffre (L01), jamais une pièce ;
 * - « base » : le montant de l'offre lu au registre des offres.
 * Aucune IA, aucun hasard : les mêmes sources et la même grille donnent toujours la même fiche, à la même empreinte.
 *
 * La fiche ne vaut rien tant que le responsable (rôle `compliance`) ne l'a pas validée, avec son nom et sa date, ou
 * corrigée avec sa raison ; elle le dit. Elle ne trie aucun client, n'en refuse aucun et ne bloque rien : aucune liste
 * par niveau, aucun contrôle ne la lit [R14, R91]. Rien ne s'efface ni ne change [R17].
 *
 * Jamais vu : chaque fiche se rejoue. Le responsable vérifie d'un geste qu'elle sort exactement de la grille datée et
 * des sources figées au jour de sa préparation : même calcul, même empreinte, sinon l'écart est dit.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { CoffreConformite } from './coffre.ts';

const TIME_ZONE = 'Europe/Paris';

export type RiskLevel = 'faible' | 'moyen' | 'eleve';
export type RiskSource = 'declare' | 'document' | 'base';
export type RiskRelation = 'mandat' | 'offre';

export const RISK_LEVELS: readonly RiskLevel[] = ['faible', 'moyen', 'eleve'];
const RANK: Record<RiskLevel, number> = { faible: 0, moyen: 1, eleve: 2 };

/** Les déclarations admises, fermées : rien d'autre n'entre dans une fiche de risque [R23]. */
export const RISK_DECLARATIONS = ['politicallyExposed', 'cashPayment', 'legalEntity', 'remoteRelation'] as const;
export type RiskDeclarationKey = (typeof RISK_DECLARATIONS)[number];
export type RiskDeclarations = Record<RiskDeclarationKey, boolean>;

/**
 * La grille d'essai, écrite et datée, en attendant la grille validée par l'avocat (H29). Une nouvelle grille prend une
 * nouvelle version : les fiches déjà préparées gardent la leur et se rejouent avec elle.
 */
export const RISK_GRID_TRIAL = {
  version: 'essai-2026-10-28',
  datedOn: '2026-10-28',
  trial: true,
  /** Montant d'offre à partir duquel le critère du montant passe à « moyen », en euros. */
  offerAmountThresholdEur: 1_000_000,
} as const;
export type RiskGrid = typeof RISK_GRID_TRIAL;
const GRIDS: Record<string, RiskGrid> = { [RISK_GRID_TRIAL.version]: RISK_GRID_TRIAL };

export interface RiskCriterion {
  key: string;
  label: string;
  source: RiskSource;
  /** Ce que la source a dit, en clair, sans donnée personnelle. */
  observed: string;
  level: RiskLevel;
}

/** Les sources figées au jour de la préparation : tout ce dont le calcul a besoin pour se rejouer. */
export interface RiskInputs {
  declarations: RiskDeclarations;
  identityVerifiedOn: string | null;
  offerAmountEur: number | null;
}

export interface RiskSheet {
  sheetId: string;
  personId: string;
  relation: RiskRelation;
  caseRef: string | null;
  gridVersion: string;
  gridDatedOn: string;
  trialGrid: boolean;
  criteria: RiskCriterion[];
  /** Le niveau calculé par la grille, avant toute validation. */
  computedLevel: RiskLevel;
  fingerprint: string;
  preparedBy: string;
  preparedAt: string;
  validation: RiskValidation | null;
  /** « non_validee » : la fiche ne vaut rien. */
  status: 'non_validee' | 'validee';
  notice: string;
}

export interface RiskValidation {
  decision: 'validee' | 'corrigee';
  level: RiskLevel;
  reason: string | null;
  validatorName: string;
  validatedOn: string;
}

export type RiskRefusal = { ok: false; rule: 'R16' | 'R23' | 'R91' | null; code: string };

export const NOT_VALIDATED_NOTICE = 'Fiche de risque non validée : elle ne vaut rien tant que le responsable de la conformité ne l’a pas validée.';
export const ADVISORY_NOTICE = 'La fiche de risque ne trie aucun client et ne refuse rien : la décision reste au responsable de la conformité.';

const fmtEur = (n: number): string => `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} €`;
const yesNo = (b: boolean): string => (b ? 'oui' : 'non');

/** Le calcul de la grille : pur, sans IA, sans horloge, sans hasard. */
export function computeRisk(grid: RiskGrid, relation: RiskRelation, inputs: RiskInputs): { criteria: RiskCriterion[]; level: RiskLevel } {
  const d = inputs.declarations;
  const criteria: RiskCriterion[] = [
    { key: 'personne_politiquement_exposee', label: 'Personne politiquement exposée', source: 'declare', observed: yesNo(d.politicallyExposed), level: d.politicallyExposed ? 'eleve' : 'faible' },
    { key: 'paiement_comptant', label: 'Paiement comptant', source: 'declare', observed: yesNo(d.cashPayment), level: d.cashPayment ? 'eleve' : 'faible' },
    { key: 'societe', label: 'Client société (bénéficiaires effectifs à identifier)', source: 'declare', observed: yesNo(d.legalEntity), level: d.legalEntity ? 'moyen' : 'faible' },
    { key: 'relation_a_distance', label: 'Relation sans rencontre', source: 'declare', observed: yesNo(d.remoteRelation), level: d.remoteRelation ? 'moyen' : 'faible' },
    {
      key: 'identite_verifiee',
      label: 'Identité vérifiée au coffre',
      source: 'document',
      observed: inputs.identityVerifiedOn ? `vérifiée le ${inputs.identityVerifiedOn}` : 'aucune pièce valide',
      level: inputs.identityVerifiedOn ? 'faible' : 'moyen',
    },
  ];
  if (relation === 'offre') {
    const amount = inputs.offerAmountEur;
    criteria.push({
      key: 'montant_offre',
      label: `Montant de l’offre (seuil ${fmtEur(grid.offerAmountThresholdEur)})`,
      source: 'base',
      observed: amount === null ? 'offre absente du registre' : fmtEur(amount),
      level: amount === null || amount >= grid.offerAmountThresholdEur ? 'moyen' : 'faible',
    });
  }
  const level = criteria.reduce<RiskLevel>((max, c) => (RANK[c.level] > RANK[max] ? c.level : max), 'faible');
  return { criteria, level };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** L'empreinte d'une fiche : la grille, la relation, le dossier, les sources figées et le calcul. */
async function fingerprintOf(gridVersion: string, relation: RiskRelation, caseRef: string | null, inputs: RiskInputs, criteria: RiskCriterion[], level: RiskLevel): Promise<string> {
  const declarations = Object.fromEntries(RISK_DECLARATIONS.map((k) => [k, inputs.declarations[k]]));
  return sha256Hex(JSON.stringify([gridVersion, relation, caseRef, declarations, inputs.identityVerifiedOn, inputs.offerAmountEur, criteria.map((c) => [c.key, c.source, c.observed, c.level]), level]));
}

interface SheetRow {
  id: string;
  network_id: string;
  person_id: string;
  relation: RiskRelation;
  case_ref: string | null;
  grid_version: string;
  inputs: string;
  criteria: string;
  level: RiskLevel;
  fingerprint: string;
  prepared_by: string;
  prepared_at: string;
}
interface ValidationRow {
  sheet_id: string;
  decision: 'validee' | 'corrigee';
  level: RiskLevel;
  reason: string | null;
  validator_name: string;
  validated_on: string;
}

const OFFER_REF = /^offer:[A-Za-z0-9-]{8,64}$/;
const MANDATE_REF = /^mandate:[A-Za-z0-9-]{8,64}$/;

export interface FicheRisqueOptions {
  now?: () => Date;
  newId?: () => string;
}

export class FicheRisque {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly coffre: CoffreConformite,
    private readonly journal: JournalStore,
    options: FicheRisqueOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, subject: string, code: string): Promise<RiskRefusal> {
    await appendEvent(
      this.journal,
      { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R91', role: String(viewer.role), kind: 'risk_sheet', code } },
      this.now,
    );
    return { ok: false, rule: 'R91', code };
  }

  /** L'agent de la fiche (vue complète) ou le responsable, sinon refus au journal. */
  private async readable(viewer: Viewer, personId: string) {
    if (viewer.role !== 'agent' && viewer.role !== 'compliance') return { refusal: await this.refuse(viewer, `person:${personId}`, 'role') };
    const read = await this.acces.readFiche(viewer, personId);
    if (!read.ok) return { refusal: { ok: false, rule: 'R16', code: read.code } as RiskRefusal };
    if (read.view !== 'full') return { refusal: await this.refuse(viewer, `person:${personId}`, 'not_assigned') };
    return { fiche: read.value };
  }

  /**
   * Prépare la fiche de risque à l'entrée en relation. Les déclarations sont les quatre réponses fermées, toutes
   * requises ; un champ de plus est refusé [R23]. Pour une offre, `caseRef` = `offer:<id>` d'une offre du client au
   * registre ; pour un mandat, `mandate:<id>` facultatif.
   */
  async prepare(
    viewer: Viewer,
    personId: string,
    input: { relation: unknown; caseRef?: unknown; declarations: unknown },
  ): Promise<{ ok: true; sheet: RiskSheet } | RiskRefusal> {
    if (input.relation !== 'mandat' && input.relation !== 'offre') return { ok: false, rule: null, code: 'bad_relation' };
    const relation: RiskRelation = input.relation;
    const caseRef = input.caseRef === undefined || input.caseRef === null ? null : input.caseRef;
    if (caseRef !== null && (typeof caseRef !== 'string' || !(relation === 'offre' ? OFFER_REF : MANDATE_REF).test(caseRef))) return { ok: false, rule: null, code: 'bad_case' };
    if (relation === 'offre' && caseRef === null) return { ok: false, rule: null, code: 'bad_case' };
    const raw = input.declarations;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, rule: null, code: 'missing_declaration' };
    if (Object.keys(raw).some((k) => !(RISK_DECLARATIONS as readonly string[]).includes(k))) return { ok: false, rule: 'R23', code: 'unknown_field' };
    const rec = raw as Record<string, unknown>;
    if (RISK_DECLARATIONS.some((k) => typeof rec[k] !== 'boolean')) return { ok: false, rule: null, code: 'missing_declaration' };
    const declarations = Object.fromEntries(RISK_DECLARATIONS.map((k) => [k, rec[k] as boolean])) as RiskDeclarations;

    const r = await this.readable(viewer, personId);
    if ('refusal' in r) return r.refusal!;
    const fiche = r.fiche!;
    const memberIds = fiche.members.map((m) => m.id);

    if (relation === 'mandat' && caseRef !== null) {
      // Le mandat cité doit être celui de ce client, dans ce réseau.
      const mandate = await this.db.first<{ person_id: string; network_id: string }>('SELECT person_id, network_id FROM mandates WHERE id = ?', [(caseRef as string).slice('mandate:'.length)]);
      if (!mandate || mandate.network_id !== viewer.networkId || !memberIds.includes(mandate.person_id)) return { ok: false, rule: null, code: 'unknown_case' };
    }
    let offerAmountEur: number | null = null;
    if (relation === 'offre') {
      const offer = await this.db.first<{ amount_eur: number; buyer_person_id: string; network_id: string }>(
        'SELECT amount_eur, buyer_person_id, network_id FROM offer_register WHERE id = ?',
        [(caseRef as string).slice('offer:'.length)],
      );
      // Une offre d'un autre client ou d'un autre réseau ne compte pas : le critère dit « absente du registre ».
      if (offer && offer.network_id === viewer.networkId && memberIds.includes(offer.buyer_person_id)) offerAmountEur = offer.amount_eur;
    }
    const today = localTime(this.now(), TIME_ZONE).date;
    const { identityVerifiedOn } = await this.coffre.state(viewer.networkId, fiche.person.id, today);
    const inputs: RiskInputs = { declarations, identityVerifiedOn, offerAmountEur };
    const grid = RISK_GRID_TRIAL;
    const { criteria, level } = computeRisk(grid, relation, inputs);
    const fingerprint = await fingerprintOf(grid.version, relation, caseRef as string | null, inputs, criteria, level);

    const id = this.newId();
    const at = this.now().toISOString();
    await this.db.run(
      'INSERT INTO risk_sheets (id, network_id, person_id, relation, case_ref, grid_version, inputs, criteria, level, fingerprint, prepared_by, prepared_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, viewer.networkId, fiche.person.id, relation, caseRef, grid.version, JSON.stringify(inputs), JSON.stringify(criteria), level, fingerprint, this.actor(viewer), at],
    );
    await appendEvent(
      this.journal,
      { type: 'risque.prepare', actor: this.actor(viewer), subject: `person:${fiche.person.id}`, data: { rule: 'R91', sheet: `risk_sheet:${id}`, grid: grid.version, level } },
      this.now,
    );
    const row = (await this.db.first<SheetRow>('SELECT * FROM risk_sheets WHERE id = ?', [id]))!;
    return { ok: true, sheet: this.toSheet(row, null) };
  }

  /**
   * Le responsable valide la fiche telle quelle, ou la corrige : un autre niveau et sa raison. Une seule validation
   * par fiche ; son nom et sa date restent.
   */
  async validate(
    viewer: Viewer,
    sheetId: string,
    input: { validatorName: unknown; level?: unknown; reason?: unknown },
  ): Promise<{ ok: true; sheet: RiskSheet } | RiskRefusal> {
    if (viewer.role !== 'compliance') return this.refuse(viewer, `risk_sheet:${sheetId}`, 'role');
    const row = await this.db.first<SheetRow>('SELECT * FROM risk_sheets WHERE id = ?', [sheetId]);
    if (!row || row.network_id !== viewer.networkId) return this.refuse(viewer, `risk_sheet:${sheetId}`, 'unknown');
    if (typeof input.validatorName !== 'string' || input.validatorName.trim() === '' || input.validatorName.length > 120) return { ok: false, rule: null, code: 'missing_name' };
    const level = input.level === undefined || input.level === null ? row.level : input.level;
    if (typeof level !== 'string' || !(RISK_LEVELS as readonly string[]).includes(level)) return { ok: false, rule: null, code: 'bad_level' };
    const reason = typeof input.reason === 'string' && input.reason.trim() !== '' ? input.reason.trim() : null;
    if (input.reason !== undefined && input.reason !== null && (typeof input.reason !== 'string' || input.reason.length > 1000)) return { ok: false, rule: null, code: 'bad_reason' };
    const decision = level === row.level ? 'validee' : 'corrigee';
    if (decision === 'corrigee' && reason === null) return { ok: false, rule: null, code: 'missing_reason' };
    if (await this.db.first('SELECT sheet_id FROM risk_validations WHERE sheet_id = ?', [row.id])) return { ok: false, rule: null, code: 'already_validated' };
    const at = this.now().toISOString();
    const validatedOn = localTime(this.now(), TIME_ZONE).date;
    try {
      await this.db.run(
        'INSERT INTO risk_validations (id, network_id, sheet_id, decision, level, reason, validator_name, validated_by, validated_on, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [this.newId(), viewer.networkId, row.id, decision, level, reason, input.validatorName.trim(), this.actor(viewer), validatedOn, at],
      );
    } catch (error) {
      // Deux validations en même temps : une seule passe.
      if (await this.db.first('SELECT sheet_id FROM risk_validations WHERE sheet_id = ?', [row.id])) return { ok: false, rule: null, code: 'already_validated' };
      throw error;
    }
    await appendEvent(
      this.journal,
      { type: 'risque.validee', actor: this.actor(viewer), subject: `person:${row.person_id}`, data: { rule: 'R91', sheet: `risk_sheet:${row.id}`, decision, computed: row.level, level } },
      this.now,
    );
    return { ok: true, sheet: this.toSheet(row, await this.validationOf(row.id)) };
  }

  /** Les fiches de risque d'un client, de la plus ancienne à la plus récente, pour l'agent de la fiche ou le responsable. */
  async list(viewer: Viewer, personId: string): Promise<{ ok: true; value: RiskSheet[] } | RiskRefusal> {
    const r = await this.readable(viewer, personId);
    if ('refusal' in r) return r.refusal!;
    const ids = r.fiche!.members.map((m) => m.id);
    const rows = await this.db.all<SheetRow>(
      `SELECT * FROM risk_sheets WHERE network_id = ? AND person_id IN (${ids.map(() => '?').join(', ')}) ORDER BY prepared_at, id`,
      [viewer.networkId, ...ids],
    );
    const out: RiskSheet[] = [];
    for (const row of rows) out.push(this.toSheet(row, await this.validationOf(row.id)));
    return { ok: true, value: out };
  }

  /**
   * Jamais vu : rejoue la fiche avec sa grille datée et ses sources figées. `same` dit si le calcul et l'empreinte
   * sont identiques ; sinon, les critères qui diffèrent. Pour le responsable seul.
   */
  async replay(viewer: Viewer, sheetId: string): Promise<{ ok: true; same: boolean; fingerprint: string; differences: string[] } | RiskRefusal> {
    if (viewer.role !== 'compliance') return this.refuse(viewer, `risk_sheet:${sheetId}`, 'role');
    const row = await this.db.first<SheetRow>('SELECT * FROM risk_sheets WHERE id = ?', [sheetId]);
    if (!row || row.network_id !== viewer.networkId) return this.refuse(viewer, `risk_sheet:${sheetId}`, 'unknown');
    const grid = GRIDS[row.grid_version];
    if (!grid) return { ok: true, same: false, fingerprint: row.fingerprint, differences: ['grille inconnue'] };
    const inputs = JSON.parse(row.inputs) as RiskInputs;
    const stored = JSON.parse(row.criteria) as RiskCriterion[];
    const { criteria, level } = computeRisk(grid, row.relation, inputs);
    const fingerprint = await fingerprintOf(grid.version, row.relation, row.case_ref, inputs, criteria, level);
    const differences: string[] = [];
    for (const c of criteria) {
      const s = stored.find((x) => x.key === c.key);
      if (!s || s.level !== c.level || s.observed !== c.observed || s.source !== c.source) differences.push(c.key);
    }
    for (const s of stored) if (!criteria.some((c) => c.key === s.key)) differences.push(s.key);
    if (level !== row.level) differences.push('niveau');
    const same = fingerprint === row.fingerprint && differences.length === 0;
    await appendEvent(
      this.journal,
      { type: 'risque.rejouee', actor: this.actor(viewer), subject: `person:${row.person_id}`, data: { rule: 'R91', sheet: `risk_sheet:${row.id}`, same } },
      this.now,
    );
    return { ok: true, same, fingerprint, differences };
  }

  private async validationOf(sheetId: string): Promise<RiskValidation | null> {
    const v = await this.db.first<ValidationRow>('SELECT * FROM risk_validations WHERE sheet_id = ?', [sheetId]);
    return v ? { decision: v.decision, level: v.level, reason: v.reason, validatorName: v.validator_name, validatedOn: v.validated_on } : null;
  }

  private toSheet(row: SheetRow, validation: RiskValidation | null): RiskSheet {
    const grid = GRIDS[row.grid_version];
    return {
      sheetId: row.id,
      personId: row.person_id,
      relation: row.relation,
      caseRef: row.case_ref,
      gridVersion: row.grid_version,
      gridDatedOn: grid?.datedOn ?? '',
      trialGrid: grid?.trial ?? false,
      criteria: JSON.parse(row.criteria) as RiskCriterion[],
      computedLevel: row.level,
      fingerprint: row.fingerprint,
      preparedBy: row.prepared_by,
      preparedAt: row.prepared_at,
      validation,
      status: validation ? 'validee' : 'non_validee',
      notice: validation ? ADVISORY_NOTICE : `${NOT_VALIDATED_NOTICE} ${ADVISORY_NOTICE}`,
    };
  }
}
