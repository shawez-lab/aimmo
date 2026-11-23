/**
 * Bail et annexes depuis les modèles (M15, W06) [R101, R102, R105].
 *
 * Les modèles du bail, vide ou meublé, suivent la règle de M06 (D02) : un texte daté et versionné, ses champs
 * `{{nom.du.champ}}` pris dans un catalogue fermé, né « essai », validé par la conformité seule (H08), jamais par le code.
 * Un modèle doit porter les champs que la loi et les règles exigent : loyer, charges et leur mode, dépôt de garantie,
 * honoraires du locataire, surface habitable, début et durée du bail, liste des annexes. L'IA ne rédige rien [R40].
 *
 * Un bail ne se fait que pour le candidat choisi par le propriétaire (W05) [R105], pour un logement que le contrôle de
 * W01 dit louable au début du bail, annexes obligatoires présentes et valides [R100, R101], sous le barème en vigueur de
 * W02 [R102]. Chaque champ vient de la base, ou d'une saisie de l'agent pour les seuls champs prévus (adresse du
 * logement) ; un champ qui manque rend le bail « incomplet », jamais un texte inventé. Un modèle d'essai ne fait qu'un
 * bail d'essai, marqué comme tel. Le bail garde la version et l'empreinte du modèle et son contenu, figé ; une
 * correction est une nouvelle version [R17].
 *
 * La durée vient de la qualité du bailleur et de la sorte de location, dites par l'agent (AU096 ; loi de 1989, art. 10 et
 * 25-7) : logement vide, 3 ans pour un bailleur personne physique, 6 ans pour une personne morale ; meublé, 1 an. Le bail
 * meublé étudiant (9 mois) et le bail mobilité demandent chacun leur propre modèle validé et leurs mentions : tant
 * qu'AIMMO n'a pas ces modèles, ils sont refusés avant toute saisie, jamais faits avec un modèle qui n'est pas le leur ; la signature en ligne du bail par D08 est une tâche à part (W12), en mode essai tant que H08 et H24 ne sont
 * pas faits.
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { escapeHtml, renderDocument, sha256, templateFields, type FieldSource } from '../documents/modeles.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { euros } from './annonce-location.ts';
import type { ChoixProprietaire } from './choix.ts';
import type { HonorairesLocation } from './honoraires.ts';
import { ANNEX_KINDS, dayInFrench, rentCeilingCents, requiredAnnexes, type LocationRefusal, type MisesEnLocation, type RentalFacts } from './logement.ts';
import { cotenantsOfApplication } from './candidatures.ts';

export const LEASE_KINDS = ['bail_vide', 'bail_meuble', 'bail_meuble_etudiant', 'bail_mobilite'] as const;
export type LeaseKind = (typeof LEASE_KINDS)[number];
/**
 * AU096b · Où se range un modèle : sa sorte en base et sa variante. Le meublé étudiant et le bail mobilité sont des
 * modèles meublés de leur variante ; ni l'un ni l'autre ne prend jamais le modèle du meublé ordinaire.
 */
const STORED: Readonly<Record<LeaseKind, { kind: 'bail_vide' | 'bail_meuble'; variant: 'standard' | 'etudiant' | 'mobilite' }>> = {
  bail_vide: { kind: 'bail_vide', variant: 'standard' },
  bail_meuble: { kind: 'bail_meuble', variant: 'standard' },
  bail_meuble_etudiant: { kind: 'bail_meuble', variant: 'etudiant' },
  bail_mobilite: { kind: 'bail_meuble', variant: 'mobilite' },
};
/** Les motifs qui ouvrent un bail mobilité (loi du 23 novembre 2018, article 25-12 de la loi de 1989). */
export const MOBILITY_REASONS = {
  formation_professionnelle: 'formation professionnelle',
  etudes_superieures: 'études supérieures',
  apprentissage: 'contrat d’apprentissage',
  stage: 'stage',
  service_civique: 'engagement volontaire dans le cadre d’un service civique',
  mutation: 'mutation professionnelle',
  mission_temporaire: 'mission temporaire dans le cadre de son activité professionnelle',
} as const;
const LEASE_TITLES: Record<LeaseKind, string> = {
  bail_vide: 'Bail de location vide',
  bail_meuble: 'Bail de location meublée',
  bail_meuble_etudiant: 'Bail de location meublée consenti à un étudiant',
  bail_mobilite: 'Bail mobilité',
};

export const LEASE_FIELDS: Readonly<Record<string, { source: FieldSource; label: string }>> = Object.freeze({
  'bailleur.nom': { source: 'base', label: 'nom du bailleur' },
  'bailleur.domicile': { source: 'saisie', label: 'domicile du bailleur' },
  'agent.nom': { source: 'base', label: 'nom de l’agent immobilier' },
  'mandataire.carte': { source: 'saisie', label: 'carte professionnelle de l’agent immobilier' },
  'logement.pieces': { source: 'base', label: 'nombre de pièces principales' },
  'logement.habitat': { source: 'saisie', label: 'type d’habitat' },
  'logement.equipements': { source: 'saisie', label: 'équipements du logement' },
  'locataire.nom': { source: 'base', label: 'nom du locataire' },
  'logement.adresse': { source: 'saisie', label: 'adresse du logement' },
  'logement.commune': { source: 'base', label: 'commune du logement' },
  'logement.surface_habitable': { source: 'base', label: 'surface habitable' },
  'logement.classe_energie': { source: 'base', label: 'classe énergie' },
  'bail.type': { source: 'base', label: 'type de location' },
  'bail.debut': { source: 'base', label: 'date de prise d’effet' },
  'bail.duree': { source: 'base', label: 'durée du bail' },
  'loyer.hors_charges': { source: 'base', label: 'loyer hors charges' },
  // Dans une commune à loyer encadré, le modèle doit porter ce champ : sans lui, le bail reste à compléter (AU015).
  'loyer.encadrement': { source: 'base', label: 'loyer de référence, loyer de référence majoré et complément de loyer' },
  'charges.montant': { source: 'base', label: 'montant des charges' },
  'charges.mode': { source: 'base', label: 'mode de règlement des charges' },
  'depot.montant': { source: 'base', label: 'dépôt de garantie' },
  // AU096b : le motif de mobilité du locataire, dans la liste de la loi ; un bail mobilité le porte toujours.
  'bail.motif_mobilite': { source: 'saisie', label: 'motif de mobilité du locataire' },
  'honoraires.locataire': { source: 'base', label: 'honoraires à la charge du locataire, état des lieux compris' },
  'honoraires.etat_des_lieux': { source: 'base', label: 'honoraires d’état des lieux à la charge du locataire' },
  'honoraires.bailleur': { source: 'base', label: 'honoraires à la charge du bailleur' },
  'annexes.liste': { source: 'base', label: 'liste des annexes' },
  'reseau.nom': { source: 'base', label: 'nom du réseau' },
  'document.date': { source: 'base', label: 'date du document' },
  'signature.date': { source: 'signature', label: 'date de signature' },
  'signature.lieu': { source: 'signature', label: 'lieu de signature' },
});

/**
 * Ce que le bail dit de l'encadrement des loyers (AU015) : hors commune encadrée, « sans objet » ; dans une commune
 * encadrée, les loyers de référence lus dans l'arrêté, le plafond, le loyer de base et le complément ; null s'il manque.
 */
export function rentControlText(controlled: boolean, facts: RentalFacts): string | null {
  if (!controlled) return 'sans objet : la commune n’est pas soumise à l’encadrement des loyers';
  const rc = facts.rentControl ?? null;
  if (rc === null) return null;
  const complement = rc.complementCents > 0 ? ` ; complément de loyer ${euros(rc.complementCents)} € par mois, justifié par : ${rc.complementReason ?? ''}` : '';
  return `loyer de référence ${euros(rc.referenceCentsPerM2)} € par m² et par mois, loyer de référence majoré ${euros(rc.majoredCentsPerM2)} € par m² et par mois (${euros(rentCeilingCents(rc, facts.livingAreaHundredths))} € par mois pour ce logement), arrêté ${rc.decree} ; loyer de base ${euros(facts.rentCents - rc.complementCents)} € par mois${complement}`;
}

/** Les champs qu'un modèle de bail doit porter : sans eux, il est refusé [R101, R102]. */
export const REQUIRED_LEASE_FIELDS: readonly string[] = [
  'bailleur.nom', 'locataire.nom', 'logement.adresse', 'logement.surface_habitable', 'bail.debut', 'bail.duree', 'loyer.hors_charges', 'charges.montant',
  'charges.mode', 'depot.montant', 'honoraires.locataire', 'honoraires.etat_des_lieux', 'annexes.liste', 'bailleur.domicile', 'reseau.nom', 'agent.nom',
  'mandataire.carte', 'logement.pieces', 'logement.habitat', 'logement.equipements',
];

const PLACEHOLDER = /\{\{\s*([a-z_.]+)\s*\}\}/g;
const MAX_BODY = 50_000;
const ADDRESS = /^[\p{L}\p{N} ,.'’-]{5,160}$/u;
const CARD = /^CPI [0-9A-Z ]{6,30}$/;
const EQUIPMENT = /^[\p{L}\p{N} ,.'’()-]{3,400}$/u;
export const HABITATS = { collectif: 'immeuble collectif', individuel: 'habitat individuel' } as const;
export const LANDLORDS = { physique: 'personne physique', morale: 'personne morale' } as const;
export const LEASE_VARIANTS = ['standard', 'etudiant', 'mobilite'] as const;
export type LeaseVariant = (typeof LEASE_VARIANTS)[number];

/** La durée écrite au bail, par la loi seule ; `null` quand la combinaison n'existe pas. */
export function leaseDuration(furnished: boolean, landlord: keyof typeof LANDLORDS, variant: LeaseVariant): string | null {
  if (variant === 'mobilite') return null;
  if (!furnished) return variant === 'standard' ? (landlord === 'morale' ? 'six ans' : 'trois ans') : null;
  return variant === 'etudiant' ? 'neuf mois' : 'un an';
}

export interface LeaseTemplate {
  id: string;
  kind: LeaseKind;
  version: number;
  status: 'essai' | 'valide';
  fields: string[];
  hash: string;
}

/** Une version de modèle, telle que la lit l'écran de la direction et de la conformité (W17). */
export interface LeaseTemplateView {
  id: string;
  version: number;
  status: 'essai' | 'valide';
  body: string;
  createdAt: string;
  validatedAt: string | null;
}

/** Pour une sorte de bail : le modèle que le prochain bail prendrait, et la dernière version rangée. */
export interface LeaseTemplateKind {
  kind: LeaseKind;
  current: LeaseTemplateView | null;
  latest: LeaseTemplateView | null;
}

export interface Lease {
  leaseId: string;
  listingId: string;
  version: number;
  mode: 'essai' | 'reel';
  status: 'complet' | 'incomplet';
  missing: string[];
  annexes: string[];
  content: string;
  contentSha256: string;
}

export type LeaseRefusal = Omit<LocationRefusal, 'rule'> & { rule: LocationRefusal['rule'] | 'R105' | 'R40' };
export type LeaseResult<T> = { ok: true; value: T } | LeaseRefusal;

/**
 * Les annexes du bail, par leur nom : les diagnostics exigés par W01 et la notice d'information, joints au bail par leur
 * référence ; l'état des lieux d'entrée et, pour un meublé, l'inventaire, établis à la remise des clés (W07).
 */
export function leaseAnnexes(required: readonly string[], furnished: boolean): string[] {
  const out = required.map((k) => ANNEX_KINDS.find((a) => a.kind === k)?.label ?? k);
  out.push('Notice d’information relative aux droits et obligations des locataires et des bailleurs');
  out.push(furnished ? 'État des lieux d’entrée et inventaire détaillé du mobilier, établis à la remise des clés' : 'État des lieux d’entrée, établi à la remise des clés');
  return out;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const NOTICE_FILE = new RegExp(`^${UUID}\\.pdf$`);

/** La version de la liste des colocataires d'une candidature : le nombre de changements, 0 sans colocataire (AU097). */
export async function cotenantRevision(db: SqlDatabase, applicationId: string): Promise<number> {
  return Number((await db.first<{ n: number | null }>('SELECT MAX(seq) AS n FROM rental_cotenant_changes WHERE application_id = ?', [applicationId]))?.n ?? 0);
}

/** Les colocataires nommés dans une version du bail, dans leur ordre (AU097). */
export async function leaseCotenants(db: SqlDatabase, leaseId: string): Promise<string[]> {
  return (await db.all<{ person_id: string }>('SELECT person_id FROM rental_lease_cotenants WHERE lease_id = ? ORDER BY position', [leaseId])).map((r) => r.person_id);
}

/** La lecture d'une fiche sous les droits du lecteur (`Acces.readFiche`), écrite au journal avant d'être rendue [R16]. */
export interface PersonReader {
  readFiche(
    viewer: Viewer,
    personId: string,
  ): Promise<{ ok: true; view: 'full' | 'shared'; value: { person: { first_name: string | null; last_name: string | null } } } | { ok: false; rule: 'R16'; code: string }>;
}

/** Le stockage des pièces du bail : seule l'existence d'une référence est lue. */
export interface LeaseFileStore {
  has(ref: string): Promise<boolean>;
}

export interface BailOptions {
  now?: () => Date;
  newId?: () => string;
}

interface TemplateRow {
  id: string;
  kind: LeaseKind;
  version: number;
  status: 'essai' | 'valide';
  body: string;
  fields: string;
  hash: string;
}

export class BauxLocation {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly listings: MisesEnLocation,
    private readonly fees: HonorairesLocation,
    private readonly choices: ChoixProprietaire,
    private readonly files: LeaseFileStore,
    private readonly persons: PersonReader,
    private readonly journal: JournalStore,
    options: BailOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, subject: string | null, code: string): Promise<LeaseRefusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind: 'lease_template', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  /** Une nouvelle version d'un modèle de bail, à l'état « essai » : la direction seule [R40]. */
  async createTemplate(viewer: Viewer, kind: unknown, body: unknown): Promise<LeaseResult<LeaseTemplate>> {
    if (viewer.role !== 'direction') return this.refuse(viewer, null, 'role');
    if (typeof kind !== 'string' || !(LEASE_KINDS as readonly string[]).includes(kind)) return { ok: false, rule: null, code: 'unknown_kind' };
    if (typeof body !== 'string' || body.trim() === '') return { ok: false, rule: null, code: 'empty_body' };
    if (body.length > MAX_BODY) return { ok: false, rule: null, code: 'body_too_long' };
    const fields = templateFields(body);
    if (fields.some((f) => !Object.prototype.hasOwnProperty.call(LEASE_FIELDS, f))) return { ok: false, rule: 'R40', code: 'unknown_field' };
    if (/\{\{|\}\}/.test(body.replace(PLACEHOLDER, ''))) return { ok: false, rule: 'R40', code: 'unknown_field' };
    // Un bail mobilité dit le motif du locataire (AU096b) ; un autre modèle ne le porte pas.
    const required = kind === 'bail_mobilite' ? [...REQUIRED_LEASE_FIELDS, 'bail.motif_mobilite'] : REQUIRED_LEASE_FIELDS;
    if (kind !== 'bail_mobilite' && fields.includes('bail.motif_mobilite')) return { ok: false, rule: 'R40', code: 'unknown_field' };
    const absent = required.filter((f) => !fields.includes(f));
    if (absent.length > 0) return { ok: false, rule: 'R40', code: 'missing_required_field', field: absent[0]! };
    const hash = await sha256(JSON.stringify([kind, body, fields]));
    for (let attempt = 0; attempt < 5; attempt++) {
      // Les versions se comptent par sorte rangée : un meublé, étudiant ou mobilité, partage la suite des meublés.
      const place = STORED[kind as LeaseKind];
      const last = await this.db.first<{ v: number | null }>('SELECT MAX(version) AS v FROM rental_lease_templates WHERE network_id = ? AND kind = ?', [viewer.networkId, place.kind]);
      const version = Number(last?.v ?? 0) + 1;
      const id = this.newId();
      const { changes } = await this.db.run(
        `INSERT INTO rental_lease_templates (id, network_id, kind, version, status, body, fields, hash, created_by, created_at, variant) VALUES (?, ?, ?, ?, 'essai', ?, ?, ?, ?, ?, ?)
         ON CONFLICT (network_id, kind, version) DO NOTHING`,
        [id, viewer.networkId, place.kind, version, body, JSON.stringify(fields), hash, this.actor(viewer), this.now().toISOString(), place.variant],
      );
      if (changes !== 1) continue;
      await appendEvent(this.journal, { type: 'location.modele_bail', actor: this.actor(viewer), subject: `lease_template:${id}`, data: { kind, version } }, this.now);
      return { ok: true, value: { id, kind: kind as LeaseKind, version, status: 'essai', fields, hash } };
    }
    return { ok: false, rule: null, code: 'busy' };
  }

  /** Le modèle passe « validé » : la conformité seule, qui note qui l'a validé (H08). Le code ne valide jamais seul. */
  async validateTemplate(viewer: Viewer, templateId: unknown): Promise<LeaseResult<true>> {
    if (viewer.role !== 'compliance') return this.refuse(viewer, `lease_template:${String(templateId)}`, 'role');
    const row = typeof templateId === 'string' ? await this.db.first<{ status: string }>('SELECT status FROM rental_lease_templates WHERE id = ? AND network_id = ?', [templateId, viewer.networkId]) : null;
    if (!row) return { ok: false, rule: null, code: 'unknown_template' };
    if (row.status !== 'essai') return { ok: false, rule: null, code: 'not_essai' };
    await this.db.run("UPDATE rental_lease_templates SET status = 'valide', validated_by = ?, validated_at = ? WHERE id = ? AND status = 'essai'", [this.actor(viewer), this.now().toISOString(), templateId as string]);
    await appendEvent(this.journal, { type: 'location.modele_bail_valide', actor: this.actor(viewer), subject: `lease_template:${String(templateId)}`, data: {} }, this.now);
    return { ok: true, value: true };
  }

  /**
   * Les modèles de bail, pour l'écran (W17) : la direction les range, la conformité les valide, personne d'autre ne les
   * lit [R16]. `current` suit le même choix que le bail : le dernier validé, sinon la dernière version, d'essai.
   */
  async templates(viewer: Viewer): Promise<LeaseResult<{ canStore: boolean; canValidate: boolean; kinds: LeaseTemplateKind[] }>> {
    if (viewer.role !== 'direction' && viewer.role !== 'compliance') return this.refuse(viewer, null, 'role');
    const kinds: LeaseTemplateKind[] = [];
    const read = async (kind: LeaseKind, order: string): Promise<LeaseTemplateView | null> => {
      const r = await this.db.first<{ id: string; version: number; status: 'essai' | 'valide'; body: string; created_at: string; validated_at: string | null }>(
        `SELECT id, version, status, body, created_at, validated_at FROM rental_lease_templates WHERE network_id = ? AND kind = ? AND variant = ? ORDER BY ${order} LIMIT 1`,
        [viewer.networkId, STORED[kind].kind, STORED[kind].variant],
      );
      return r ? { id: r.id, version: Number(r.version), status: r.status, body: r.body, createdAt: r.created_at, validatedAt: r.validated_at } : null;
    };
    for (const kind of LEASE_KINDS) kinds.push({ kind, current: await read(kind, "status = 'valide' DESC, version DESC"), latest: await read(kind, 'version DESC') });
    return { ok: true, value: { canStore: viewer.role === 'direction', canValidate: viewer.role === 'compliance', kinds } };
  }

  /**
   * Fait le bail depuis la dernière version du modèle de son type, pour le candidat choisi, sur les derniers faits et le
   * barème en vigueur [R105, R101, R102].
   */
  async generate(
    viewer: Viewer,
    listingId: unknown,
    input: { address?: unknown; ownerAddress?: unknown; habitat?: unknown; equipment?: unknown; professionalCard?: unknown; noticeRef?: unknown; landlord?: unknown; variant?: unknown; mobilityMonths?: unknown; mobilityReason?: unknown } = {},
  ): Promise<LeaseResult<Lease>> {
    const listing = await this.listings.listing(viewer, listingId, true);
    if ('ok' in listing) return listing;
    const chosen = await this.choices.chosen(listing.networkId, listing.id);
    if (!chosen) return { ok: false, rule: 'R105', code: 'no_choice' };
    // AU097 · un colocataire ajouté depuis le choix doit avoir ses pièces avant que le bail se fasse [R104].
    if (!(await this.choices.chosenComplete(listing.networkId, listing.id))) return { ok: false, rule: 'R105', code: 'dossier_incomplet' };
    if (!(await this.listings.advertisable(listing.networkId, listing.id))) return { ok: false, rule: 'R101', code: 'not_rentable' };
    const fees = await this.fees.current(listing.networkId, listing.id);
    if (!fees) return { ok: false, rule: 'R102', code: 'no_fees' };
    const facts = (await this.listings.currentFacts(listing.id))!;
    if (!facts.chargesMode) return { ok: false, rule: null, code: 'missing_charges_mode' };
    const today = localTime(this.now(), 'Europe/Paris').date;
    // Un bail ne prend pas effet dans le passé : de nouveaux faits, avec une nouvelle date, sont à ranger [R100].
    if (facts.leaseStart < today) return { ok: false, rule: null, code: 'lease_start_passed' };
    const text = (v: unknown, re: RegExp, code: string): string | null | LeaseRefusal => {
      if (v === undefined || v === null) return null;
      return typeof v === 'string' && re.test(v.trim()) ? v.trim() : { ok: false, rule: null, code };
    };
    const address = text(input.address, ADDRESS, 'bad_address');
    const ownerAddress = text(input.ownerAddress, ADDRESS, 'bad_owner_address');
    const equipment = text(input.equipment, EQUIPMENT, 'bad_equipment');
    const card = text(input.professionalCard, CARD, 'bad_card');
    for (const v of [address, ownerAddress, equipment, card]) if (v !== null && typeof v === 'object') return v;
    // La notice d'information est jointe par sa référence ; sans elle, le bail reste incomplet [R101].
    let noticeRef: string | null = null;
    if (input.noticeRef !== undefined && input.noticeRef !== null) {
      const prefix = `location/${listing.id}/bail/`;
      if (typeof input.noticeRef !== 'string' || !input.noticeRef.startsWith(prefix) || !NOTICE_FILE.test(input.noticeRef.slice(prefix.length))) return { ok: false, rule: null, code: 'bad_notice_ref' };
      if (!(await this.files.has(input.noticeRef))) return { ok: false, rule: null, code: 'not_stored' };
      noticeRef = input.noticeRef;
    }
    const habitat = input.habitat === undefined || input.habitat === null ? null : input.habitat;
    if (habitat !== null && (typeof habitat !== 'string' || !Object.prototype.hasOwnProperty.call(HABITATS, habitat))) return { ok: false, rule: null, code: 'bad_habitat' };
    // La qualité du bailleur est dite, jamais supposée : elle fait la durée du bail vide (AU096).
    const landlord = input.landlord;
    if (typeof landlord !== 'string' || !Object.prototype.hasOwnProperty.call(LANDLORDS, landlord)) return { ok: false, rule: null, code: 'missing_landlord' };
    const variant = input.variant === undefined || input.variant === null ? 'standard' : input.variant;
    if (typeof variant !== 'string' || !(LEASE_VARIANTS as readonly string[]).includes(variant)) return { ok: false, rule: null, code: 'bad_variant' };
    // AU096b · le meublé étudiant (neuf mois) et le bail mobilité (un à dix mois, non renouvelable, un motif de la loi,
    // sans dépôt de garantie) sont meublés ; chacun se fait sur son propre modèle, jamais sur celui du meublé ordinaire.
    if (variant !== 'standard' && !facts.furnished) return { ok: false, rule: null, code: 'bad_variant' };
    let mobility: { months: number; reason: string } | null = null;
    if (variant === 'mobilite') {
      const months = input.mobilityMonths;
      if (typeof months !== 'number' || !Number.isInteger(months) || months < 1 || months > 10) return { ok: false, rule: null, code: 'bad_mobility_months' };
      const reason = input.mobilityReason;
      if (typeof reason !== 'string' || !Object.prototype.hasOwnProperty.call(MOBILITY_REASONS, reason)) return { ok: false, rule: null, code: 'bad_mobility_reason' };
      if (fees.depositCents > 0) return { ok: false, rule: 'R102', code: 'depot_interdit_mobilite' };
      // Article 25-18 de la loi de 1989 : les charges d’un bail mobilité sont forfaitaires.
      if (facts.chargesMode !== 'forfait') return { ok: false, rule: 'R102', code: 'charges_forfait_mobilite' };
      mobility = { months, reason: MOBILITY_REASONS[reason as keyof typeof MOBILITY_REASONS] };
    } else if (input.mobilityMonths !== undefined || input.mobilityReason !== undefined) return { ok: false, rule: null, code: 'bad_variant' };
    const duration = mobility ? `${mobility.months} mois, non renouvelable ni reconductible` : leaseDuration(facts.furnished, landlord as keyof typeof LANDLORDS, variant as LeaseVariant);
    if (duration === null) return { ok: false, rule: null, code: 'bad_variant' };
    const kind: LeaseKind = variant === 'etudiant' ? 'bail_meuble_etudiant' : variant === 'mobilite' ? 'bail_mobilite' : facts.furnished ? 'bail_meuble' : 'bail_vide';
    // Le modèle en vigueur : la dernière version validée ; à défaut, la dernière d'essai, qui ne fait qu'un bail d'essai.
    const template = await this.db.first<TemplateRow>(
      "SELECT id, kind, version, status, body, fields, hash FROM rental_lease_templates WHERE network_id = ? AND kind = ? AND variant = ? ORDER BY status = 'valide' DESC, version DESC LIMIT 1",
      [listing.networkId, STORED[kind].kind, STORED[kind].variant],
    );
    if (!template) return { ok: false, rule: null, code: 'no_template' };
    const fullName = (p: { first_name: string | null; last_name: string | null } | null) => {
      // Prénom et nom exigés tous les deux : une identité à moitié laisse le champ à compléter [R40].
      const first = p?.first_name?.trim() ?? '';
      const last = p?.last_name?.trim() ?? '';
      return first === '' || last === '' ? null : `${first} ${last}`;
    };
    // Les noms du bailleur et du locataire passent par la lecture des fiches sous droits : refus s'ils ne sont pas lisibles
    // en entier par celui qui fait le bail [R16].
    // AU097 · en colocation, chaque colocataire est un locataire du même bail, nommé après le candidat choisi. La
    // version de la liste est lue d'abord : une liste changée pendant ce temps rend ce bail caduc, jamais l'inverse.
    const revision = await cotenantRevision(this.db, chosen.applicationId);
    const cotenants = await cotenantsOfApplication(this.db, chosen.applicationId);
    const names: (string | null)[] = [];
    for (const personId of [listing.ownerPersonId, chosen.personId, ...cotenants]) {
      const read = await this.persons.readFiche(viewer, personId);
      if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
      if (read.view !== 'full') return this.refuse(viewer, `person:${personId}`, 'not_assigned');
      names.push(fullName(read.value.person));
    }
    const [owner, ...tenantNames] = names as [string | null, ...(string | null)[]];
    // Un nom manquant laisse le champ à compléter : jamais un bail qui oublie un colocataire [R40].
    const tenant = tenantNames.some((n) => n === null) ? null : tenantNames.length === 1 ? tenantNames[0]! : `${tenantNames.slice(0, -1).join(', ')} et ${tenantNames.at(-1)}, colocataires`;
    const p = await this.db.first<{ city: string | null; rooms: number | null; agent_id: string | null }>('SELECT city, rooms, agent_id FROM properties WHERE id = ?', [listing.propertyId]);
    const agentRow = p?.agent_id ? await this.db.first<{ first_name: string | null; last_name: string | null }>('SELECT first_name, last_name FROM agents WHERE id = ?', [p.agent_id]) : null;
    const network = await this.db.first<{ name: string }>('SELECT name FROM networks WHERE id = ?', [listing.networkId]);
    const annexes = leaseAnnexes(requiredAnnexes(facts), facts.furnished);
    const controlled = await this.listings.rentControlledFor({ id: listing.id, network_id: listing.networkId }, facts.leaseStart);
    const values: Record<string, string | null> = {
      'bailleur.nom': owner,
      'bailleur.domicile': ownerAddress as string | null,
      'agent.nom': fullName(agentRow),
      'mandataire.carte': card as string | null,
      'logement.pieces': p?.rooms === null || p?.rooms === undefined ? null : String(p.rooms),
      'logement.habitat': habitat === null ? null : HABITATS[habitat as keyof typeof HABITATS],
      'logement.equipements': equipment as string | null,
      'locataire.nom': tenant,
      'logement.adresse': address as string | null,
      'logement.commune': p?.city ?? null,
      'logement.surface_habitable': `${euros(facts.livingAreaHundredths)} m²`,
      'logement.classe_energie': facts.energyClass,
      'bail.type': facts.furnished ? 'location meublée' : 'location vide',
      'bail.debut': dayInFrench(facts.leaseStart),
      'bail.duree': duration,
      'loyer.hors_charges': `${euros(facts.rentCents)} € par mois`,
      'loyer.encadrement': rentControlText(controlled, facts),
      'charges.montant': `${euros(facts.chargesCents)} € par mois`,
      'charges.mode': facts.chargesMode === 'forfait' ? 'forfait' : 'provision, avec régularisation annuelle',
      'depot.montant': mobility ? 'aucun : un bail mobilité n’a pas de dépôt de garantie' : `${euros(fees.depositCents)} €`,
      'bail.motif_mobilite': mobility ? mobility.reason : null,
      'honoraires.locataire': `${euros(fees.tenantCents + fees.tenantInventoryCents)} € TTC`,
      'honoraires.etat_des_lieux': `${euros(fees.tenantInventoryCents)} € TTC`,
      'honoraires.bailleur': `${euros(fees.landlordCents + fees.landlordInventoryCents)} € TTC`,
      'annexes.liste': annexes.join(' ; '),
      'reseau.nom': network?.name ?? null,
      'document.date': dayInFrench(today),
    };
    const fields = JSON.parse(template.fields) as string[];
    const missing = fields.filter((f) => LEASE_FIELDS[f]!.source !== 'signature' && (values[f] === null || values[f] === undefined));
    // Un modèle sans la place de l'encadrement ne fait pas un bail complet dans une commune où il s'applique (AU015).
    if (controlled && !fields.includes('loyer.encadrement')) missing.push('loyer.encadrement');
    // Les annexes jointes : chaque diagnostic exigé par sa référence (W01 les a dits présents et valides), et la notice.
    const attached = (await this.listings.annexRefs(listing.id)).filter((a) => requiredAnnexes(facts).includes(a.kind));
    if (noticeRef === null) missing.push('annexe.notice_information');
    const annexRefs = [...attached, ...(noticeRef ? [{ kind: 'notice_information', ref: noticeRef }] : [])];
    const trial = template.status !== 'valide';
    const title = LEASE_TITLES[kind];
    const content = renderDocument(template.body, values, { title, trial, fields: LEASE_FIELDS });
    const contentSha = await sha256(content);
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = this.newId();
      try {
        await this.db.run(
          `INSERT INTO rental_leases (id, listing_id, network_id, version, application_id, template_id, template_version, template_hash, facts_version, fees_version, mode, status, missing, annexes, content, content_sha256, created_by, created_at)
           SELECT ?, ?, ?, COALESCE(MAX(version), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM rental_leases WHERE listing_id = ?`,
          [
            id,
            listing.id,
            listing.networkId,
            chosen.applicationId,
            template.id,
            Number(template.version),
            template.hash,
            facts.version,
            fees.version,
            trial ? 'essai' : 'reel',
            missing.length === 0 ? 'complet' : 'incomplet',
            JSON.stringify(missing),
            JSON.stringify(annexRefs),
            content,
            contentSha,
            this.actor(viewer),
            this.now().toISOString(),
            listing.id,
          ],
        );
      } catch (error) {
        if (/UNIQUE/i.test(String(error))) continue;
        throw error;
      }
      const version = Number((await this.db.first<{ version: number }>('SELECT version FROM rental_leases WHERE id = ?', [id]))!.version);
      for (const [i, personId] of cotenants.entries()) await this.db.run('INSERT INTO rental_lease_cotenants (lease_id, person_id, position) VALUES (?, ?, ?)', [id, personId, i + 1]);
      await this.db.run('INSERT INTO rental_lease_cotenant_revisions (lease_id, revision) VALUES (?, ?)', [id, revision]);
      await appendEvent(
        this.journal,
        { type: 'location.bail', actor: this.actor(viewer), subject: `rental:${listing.id}`, data: { version, mode: trial ? 'essai' : 'reel', status: missing.length === 0 ? 'complet' : 'incomplet', missing } },
        this.now,
      );
      return { ok: true, value: { leaseId: id, listingId: listing.id, version, mode: trial ? 'essai' : 'reel', status: missing.length === 0 ? 'complet' : 'incomplet', missing, annexes, content, contentSha256: contentSha } };
    }
    return { ok: false, rule: null, code: 'busy' };
  }

  /**
   * Le bail en vigueur, s'il vaut encore : dernière version, même candidat choisi, mêmes faits et même barème, logement
   * encore louable. Pour la signature (W12) et l'état des lieux (W07) [R101, R102, R105].
   */
  async current(networkId: string, listingId: string): Promise<{ leaseId: string; contentSha256: string; mode: 'essai' | 'reel'; complete: boolean } | null> {
    const r = await this.db.first<{ id: string; application_id: string; facts_version: number; fees_version: number; mode: 'essai' | 'reel'; status: string; annexes: string; content: string; content_sha256: string }>(
      'SELECT id, application_id, facts_version, fees_version, mode, status, annexes, content, content_sha256 FROM rental_leases WHERE listing_id = ? AND network_id = ? ORDER BY version DESC LIMIT 1',
      [listingId, networkId],
    );
    if (!r) return null;
    const chosen = await this.choices.chosen(networkId, listingId);
    const facts = await this.listings.currentFacts(listingId);
    const fees = await this.fees.current(networkId, listingId);
    if (!chosen || chosen.applicationId !== r.application_id || facts?.version !== Number(r.facts_version) || fees?.version !== Number(r.fees_version)) return null;
    // Un colocataire ajouté ou retiré depuis, même revenu ensuite : il en faut un nouveau bail (AU097). Un bail d'avant
    // la colocation compte pour la version 0.
    const made = await this.db.first<{ revision: number }>('SELECT revision FROM rental_lease_cotenant_revisions WHERE lease_id = ?', [r.id]);
    if (Number(made?.revision ?? 0) !== (await cotenantRevision(this.db, chosen.applicationId))) return null;
    if (JSON.stringify(await leaseCotenants(this.db, r.id)) !== JSON.stringify(await cotenantsOfApplication(this.db, chosen.applicationId))) return null;
    // Le dossier choisi doit être encore complet, colocataires compris [R104].
    if (!(await this.choices.chosenComplete(networkId, listingId))) return null;
    if (!(await this.listings.advertisable(networkId, listingId))) return null;
    if ((await sha256(r.content)) !== r.content_sha256) return null;
    // Les diagnostics joints au bail doivent être ceux qui valent aujourd'hui : une annexe remplacée depuis demande un
    // nouveau bail, qui joint la nouvelle [R101].
    const joined = (JSON.parse(r.annexes) as { kind: string; ref: string }[]).filter((a) => a.kind !== 'notice_information');
    const valid = (await this.listings.annexRefs(listingId)).filter((a) => requiredAnnexes(facts!).includes(a.kind));
    const key = (list: readonly { kind: string; ref: string }[]) => JSON.stringify([...list].map((a) => `${a.kind}:${a.ref}`).sort());
    if (key(joined) !== key(valid)) return null;
    // Une commune devenue encadrée depuis le bail : le bail qui ne dit pas l'encadrement de ce jour n'est plus celui
    // qui se signe, il en faut un nouveau (AU015).
    if (await this.listings.rentControlledFor({ id: listingId, network_id: networkId }, facts!.leaseStart)) {
      const said = rentControlText(true, facts!);
      if (said === null || !r.content.includes(escapeHtml(said))) return null;
    }
    return { leaseId: r.id, contentSha256: r.content_sha256, mode: r.mode, complete: r.status === 'complet' };
  }
}
