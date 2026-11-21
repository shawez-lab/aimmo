/**
 * Les installations intérieures d'électricité et de gaz d'un logement (AU084, M10) [R10, R13, R16, R17, R60].
 *
 * Les diagnostics électricité et gaz visent une installation intérieure de plus de 15 ans (art. L134-6 et L134-7 du
 * CCH, repris à l'art. L271-4) : c'est l'âge de l'installation, ou de sa dernière rénovation complète, qui compte, pas
 * celui du bâtiment ; sans installation de gaz, pas de diagnostic gaz. La fiche du bien ne connaît que l'année de
 * construction : la liste des pièces demandait donc les deux diagnostics à tout logement ancien, même rénové ou sans gaz.
 *
 * Ici, l'agent du bien ou la direction déclarent pour chaque installation sa présence et son année (pose ou dernière
 * rénovation complète), chaque saisie avec sa preuve rangée et son genre ; une correction s'ajoute en nouvelle version,
 * la plus récente vaut, rien ne se réécrit ni ne s'efface [R17]. La liste des pièces en déduit la demande exacte.
 *
 * Décidé, lecture prudente :
 * - une installation déclarée récente ne retire le diagnostic que sur un certificat de conformité (Consuel, Qualigaz)
 *   ou une facture des travaux : la parole seule ne prouve pas un âge ; l'absence de gaz, elle, se prouve aussi par
 *   une déclaration signée du vendeur, qui l'engage (c'est aussi l'attestation que le notaire reçoit) ;
 * - seule l'année est connue : 15 ans pile comptent, comme pour le bâtiment ;
 * - une installation déclarée présente sans année, ou rien de déclaré, laisse l'âge du bâtiment en tenir lieu, comme
 *   avant : une pièce de trop plutôt qu'un acte retardé ; une année antérieure à la construction est refusée ;
 * - le journal dit l'installation et sa présence, jamais la preuve ni l'année [R13].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { PropertySheet } from '../annonces/fiche-bien.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { PROOF_REF } from '../offres/transmission.ts';

const TIME_ZONE = 'Europe/Paris';

export const INSTALLATIONS = ['electricite', 'gaz'] as const;
export type Installation = (typeof INSTALLATIONS)[number];

/** Le genre de la preuve : un certificat de conformité, une facture des travaux, une déclaration signée du vendeur. */
export const INSTALLATION_PROOFS = ['certificat_conformite', 'facture_travaux', 'declaration_vendeur'] as const;
export type InstallationProof = (typeof INSTALLATION_PROOFS)[number];

/** Les preuves qui établissent l'âge d'une installation : jamais la seule parole du vendeur. */
export const AGE_PROOFS: readonly InstallationProof[] = ['certificat_conformite', 'facture_travaux'];

/** L'âge d'une installation à partir duquel son diagnostic est demandé. */
export const INSTALLATION_DIAGNOSTIC_YEARS = 15;

/** Ce qui est déclaré d'une installation : sa présence, son année (pose ou dernière rénovation complète), sa preuve. */
export interface InstallationFact {
  present: boolean;
  /** L'année de pose ou de la dernière rénovation complète, ou null si elle n'est pas connue. */
  since: number | null;
  proof: InstallationProof;
  version: number;
}

export type InstallationFacts = Readonly<Partial<Record<Installation, InstallationFact>>>;
export const NO_INSTALLATIONS: InstallationFacts = {};

/**
 * Ce que la déclaration décide pour une installation, l'année donnée : `absente` (aucun diagnostic), `recente` (moins de
 * 15 ans, prouvée : aucun diagnostic), `ancienne` (15 ans ou plus : diagnostic), ou `non_tranche` (rien de déclaré, ou une
 * déclaration qui ne prouve pas l'âge) : l'âge du bâtiment en tient lieu. Fonction pure.
 */
export function installationVerdict(fact: InstallationFact | undefined, year: number): 'absente' | 'recente' | 'ancienne' | 'non_tranche' {
  if (!fact) return 'non_tranche';
  if (!fact.present) return 'absente';
  // Sans année, ou une rénovation postérieure à l'année jugée (un acte rapporté après coup) : elle ne dit rien de
  // l'installation au jour de la vente (relecture de Codex).
  if (fact.since === null || fact.since > year) return 'non_tranche';
  if (year - fact.since >= INSTALLATION_DIAGNOSTIC_YEARS) return 'ancienne';
  return AGE_PROOFS.includes(fact.proof) ? 'recente' : 'non_tranche';
}

/** Ce qu'une déclaration a fait de la demande, pour que l'agent voie pourquoi un diagnostic est demandé ou non. */
export interface InstallationReading {
  installation: Installation;
  /** `non_declaree` : rien de déclaré, l'âge du bâtiment en tient lieu. */
  verdict: 'absente' | 'recente' | 'ancienne' | 'non_tranche' | 'non_declaree';
  since: number | null;
  proof: InstallationProof | null;
}

type Refusal = { ok: false; rule: 'R16'; code: string };
export type InstallationProblem = {
  ok: false;
  rule: null;
  code: 'unknown_property' | 'not_housing' | 'bad_installation' | 'bad_presence' | 'bad_year' | 'before_build' | 'bad_proof_kind' | 'absence_with_year' | 'bad_proof' | 'not_stored' | 'busy';
};

/** Les logements : seuls eux portent les diagnostics électricité et gaz. */
const HOUSING = ['home', 'building'];

export class InstallationsBien {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly proofs: { has(ref: string): Promise<boolean> } | null;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string; /** Une preuve qui n'est pas rangée est refusée [R10]. */ proofs?: { has(ref: string): Promise<boolean> } } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.proofs = options.proofs ?? null;
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, propertyId: string, code: string): Promise<Refusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { rule: 'R16', code, resource: 'property_installations' } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  /**
   * L'agent du bien ou la direction, qui le voient en entier, déclarent une installation : présente ou non, son année,
   * le genre et la référence de sa preuve. Une nouvelle saisie s'ajoute en version, la plus récente vaut [R17].
   */
  async record(
    viewer: Viewer,
    propertyId: string,
    input: { installation: unknown; present: unknown; since?: unknown; proof: unknown; proofRef: unknown },
  ): Promise<{ ok: true; value: InstallationFact & { installation: Installation } } | Refusal | InstallationProblem> {
    const p = await this.acces.readProperty(viewer, propertyId);
    if (!p.ok) return p.code === 'unknown' ? { ok: false, rule: null, code: 'unknown_property' } : (p as Refusal);
    if (p.view !== 'full') return this.refuse(viewer, propertyId, 'not_assigned');
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refuse(viewer, propertyId, 'role');
    const kind = await this.db.first<{ kind: string; network_id: string }>('SELECT kind, network_id FROM properties WHERE id = ?', [propertyId]);
    if (!kind || !HOUSING.includes(kind.kind)) return { ok: false, rule: null, code: 'not_housing' };
    if (typeof input.installation !== 'string' || !(INSTALLATIONS as readonly string[]).includes(input.installation)) return { ok: false, rule: null, code: 'bad_installation' };
    const installation = input.installation as Installation;
    if (typeof input.present !== 'boolean') return { ok: false, rule: null, code: 'bad_presence' };
    const since = input.since ?? null;
    const thisYear = Number(localTime(this.now(), TIME_ZONE).date.slice(0, 4));
    if (since !== null && (typeof since !== 'number' || !Number.isInteger(since) || since < 1880 || since > thisYear)) return { ok: false, rule: null, code: 'bad_year' };
    // Une installation absente n'a pas d'âge.
    if (!input.present && since !== null) return { ok: false, rule: null, code: 'absence_with_year' };
    if (typeof input.proof !== 'string' || !(INSTALLATION_PROOFS as readonly string[]).includes(input.proof)) return { ok: false, rule: null, code: 'bad_proof_kind' };
    if (typeof input.proofRef !== 'string' || !PROOF_REF.test(input.proofRef)) return { ok: false, rule: null, code: 'bad_proof' };
    // Une installation n'est pas plus ancienne que le bâtiment qui la porte : une saisie fautive ne retire rien.
    if (since !== null) {
      const sheet = await this.db.first<{ data: string }>('SELECT data FROM property_sheets WHERE property_id = ? ORDER BY version DESC LIMIT 1', [propertyId]);
      const built = sheet ? ((JSON.parse(sheet.data) as PropertySheet).characteristics?.buildYear ?? null) : null;
      if (built !== null && since < built) return { ok: false, rule: null, code: 'before_build' };
    }
    if (this.proofs && !(await this.proofs.has(input.proofRef))) return { ok: false, rule: null, code: 'not_stored' };
    const last = await this.db.first<{ v: number | null }>('SELECT MAX(version) AS v FROM property_installations WHERE property_id = ? AND installation = ?', [propertyId, installation]);
    const version = Number(last?.v ?? 0) + 1;
    try {
      await this.db.run(
        `INSERT INTO property_installations (id, network_id, property_id, installation, version, present, since_year, proof_kind, proof_ref, set_by, set_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [this.newId(), kind.network_id, propertyId, installation, version, input.present ? 1 : 0, since, input.proof, input.proofRef, this.actor(viewer), this.now().toISOString()],
      );
    } catch (error) {
      if (/UNIQUE/i.test(String(error))) return { ok: false, rule: null, code: 'busy' };
      throw error;
    }
    await appendEvent(this.journal, { type: 'obligations.installation_rangee', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { rule: 'R60', installation, present: input.present, version } }, this.now);
    return { ok: true, value: { installation, present: input.present, since: since as number | null, proof: input.proof as InstallationProof, version } };
  }
}

/** Les dernières déclarations des installations d'un bien. Sans contrôle des droits : à l'appelant de les avoir vérifiés. */
export async function installationFactsOf(db: SqlDatabase, networkId: string, propertyId: string): Promise<InstallationFacts> {
  const rows = await db.all<{ installation: Installation; version: number; present: number; since_year: number | null; proof_kind: InstallationProof }>(
    `SELECT installation, version, present, since_year, proof_kind FROM property_installations i WHERE property_id = ? AND network_id = ?
     AND version = (SELECT MAX(version) FROM property_installations j WHERE j.property_id = i.property_id AND j.installation = i.installation)`,
    [propertyId, networkId],
  );
  const facts: Partial<Record<Installation, InstallationFact>> = {};
  for (const r of rows) facts[r.installation] = { present: Number(r.present) === 1, since: r.since_year === null ? null : Number(r.since_year), proof: r.proof_kind, version: Number(r.version) };
  return facts;
}
