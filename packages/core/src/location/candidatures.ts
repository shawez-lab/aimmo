/**
 * Candidatures limitées aux pièces de la liste officielle (M15, W04) [R104, R14, R15].
 *
 * Décret n° 2015-1437 du 5 novembre 2015 : le bailleur, ou l'agent qui le représente, ne peut demander au candidat
 * (annexe I) et à sa caution personne physique (annexe II) que les pièces de leur liste, une par catégorie pour l'identité et le domicile, une ou plusieurs pour
 * l'activité et les ressources. Toute autre pièce est refusée à l'enregistrement, nommée, écrite au journal [R104] :
 * relevé ou attestation de compte, photo, carte Vitale, dossier médical, extrait de casier, chèque de réservation,
 * contrat de mariage, jugement de divorce, attestation d'absence de crédit, autorisation de prélèvement, RIB…
 *
 * Décidé, lecture prudente :
 * - la pièce d'identité du candidat et de chaque garant personne ne vit qu'au coffre de la conformité (L01), déposée
 *   par l'agent : la candidature ne lit que l'état « identité vérifiée » ce jour-là [R15, R90] ;
 * - un lien DossierFacile vaut dossier complet, sans autre pièce : le dossier y a déjà été contrôlé [R104] ;
 * - un garant est une personne de la fiche client, ou la garantie Visale (son visa seul) ; la caution d'une personne
 *   morale n'est pas encore proposée ;
 * - la complétude est dite par une liste écrite, par le code, jamais par l'IA ; elle ne juge jamais la solvabilité, et
 *   aucune candidature n'a de note, de rang ni de score : l'ordre d'arrivée seul [R14].
 * Une pièce est sa référence de stockage et son empreinte, jamais son contenu. Rien ne s'efface [R17].
 */
import { FicheClient } from '../db/fiche-client.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { PieceDepositRow } from './depot.ts';
import type { LocationRefusal, MisesEnLocation, RentalFileStore } from './logement.ts';

export const PIECE_CATEGORIES = ['domicile', 'activite', 'ressources', 'garantie'] as const;
export type PieceCategory = (typeof PIECE_CATEGORIES)[number];

export type Holder = 'candidat' | 'caution';

/**
 * La liste officielle, sorte par sorte, hors identité (au coffre) : annexe I pour le candidat, annexe II pour la caution
 * personne physique. Rien d'autre n'est accepté, et chaque sorte seulement pour qui l'annexe la permet [R104].
 */
export const OFFICIAL_PIECES: Readonly<Record<string, { category: PieceCategory; label: string; holders: readonly Holder[] }>> = Object.freeze({
  // Domicile.
  quittances_loyer: { category: 'domicile', label: 'Trois dernières quittances de loyer', holders: ['candidat'] },
  attestation_precedent_bailleur: { category: 'domicile', label: 'Attestation du précédent bailleur', holders: ['candidat'] },
  attestation_hebergement: { category: 'domicile', label: 'Attestation d’hébergement', holders: ['candidat'] },
  attestation_election_domicile: { category: 'domicile', label: 'Attestation d’élection de domicile', holders: ['candidat'] },
  derniere_quittance: { category: 'domicile', label: 'Dernière quittance de loyer', holders: ['caution'] },
  facture_eau_energie: { category: 'domicile', label: 'Facture d’eau, de gaz ou d’électricité de moins de 3 mois', holders: ['caution'] },
  attestation_assurance_logement: { category: 'domicile', label: 'Attestation d’assurance du logement de moins de 3 mois', holders: ['caution'] },
  avis_taxe_fonciere: { category: 'domicile', label: 'Dernier avis de taxe foncière ou titre de propriété de la résidence principale', holders: ['candidat', 'caution'] },
  // Activité.
  contrat_travail: { category: 'activite', label: 'Contrat de travail ou de stage, ou attestation de l’employeur', holders: ['candidat', 'caution'] },
  extrait_k_kbis: { category: 'activite', label: 'Extrait K ou K bis de moins de 3 mois', holders: ['candidat', 'caution'] },
  inscription_repertoire_metiers: { category: 'activite', label: 'Extrait D1 du répertoire des métiers', holders: ['candidat', 'caution'] },
  certificat_insee: { category: 'activite', label: 'Certificat d’identification de l’INSEE', holders: ['candidat', 'caution'] },
  carte_professionnelle: { category: 'activite', label: 'Carte professionnelle (profession libérale)', holders: ['candidat', 'caution'] },
  piece_activite_autre: { category: 'activite', label: 'Pièce récente attestant de l’activité, pour les autres professionnels', holders: ['candidat', 'caution'] },
  certificat_scolarite: { category: 'activite', label: 'Carte d’étudiant ou certificat de scolarité', holders: ['candidat'] },
  // Ressources.
  avis_imposition: { category: 'ressources', label: 'Dernier ou avant-dernier avis d’imposition', holders: ['candidat', 'caution'] },
  titre_propriete_ressource: { category: 'ressources', label: 'Titre de propriété d’un bien immobilier ou dernier avis de taxe foncière', holders: ['candidat', 'caution'] },
  bulletins_salaire: { category: 'ressources', label: 'Trois derniers bulletins de salaire', holders: ['candidat', 'caution'] },
  indemnites_stage: { category: 'ressources', label: 'Justificatif de versement des indemnités de stage', holders: ['candidat', 'caution'] },
  bilans_comptables: { category: 'ressources', label: 'Deux derniers bilans ou attestation du comptable', holders: ['candidat', 'caution'] },
  pensions_prestations: { category: 'ressources', label: 'Justificatif de pensions, retraites, prestations sociales ou allocations', holders: ['candidat', 'caution'] },
  revenus_fonciers: { category: 'ressources', label: 'Justificatif de revenus fonciers, de rentes viagères ou de valeurs mobilières', holders: ['candidat', 'caution'] },
  simulation_aides_logement: { category: 'ressources', label: 'Attestation de simulation des aides au logement', holders: ['candidat'] },
  avis_bourse: { category: 'ressources', label: 'Avis d’attribution de bourse', holders: ['candidat'] },
  // Garantie Visale : son visa seul.
  visa_visale: { category: 'garantie', label: 'Visa de la garantie Visale', holders: [] },
});

/** Les pièces demandées à chacun, par catégorie : la liste écrite de la complétude [R104]. */
const REQUIRED: readonly Exclude<PieceCategory, 'garantie'>[] = ['domicile', 'activite', 'ressources'];

const DOSSIERFACILE = /^https:\/\/(?:locataire\.dossierfacile\.logement\.gouv\.fr|www\.dossierfacile\.fr|dossierfacile\.fr)\/(?:file|public-file|linkByMail)\/[A-Za-z0-9-]{8,80}$/;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const REF_FILE = new RegExp(`^${UUID}\\.(?:pdf|jpg|png)$`);
const SHA = /^[0-9a-f]{64}$/;

/** L'état « identité vérifiée » du coffre de la conformité (L01), sans sorte ni référence. */
export interface IdentityState {
  state(networkId: string, personId: string): Promise<{ identityVerifiedOn: string | null }>;
}

export interface Missing {
  /** `candidat`, ou l'identifiant du garant. */
  holder: string;
  what: Exclude<PieceCategory, 'garantie'> | 'identite' | 'visa_visale';
}

export interface ApplicationView {
  applicationId: string;
  listingId: string;
  personId: string;
  arrival: number;
  arrivedAt: string;
  dossierFacile: boolean;
  guarantors: { guarantorId: string; kind: 'personne' | 'visale'; personId: string | null }[];
  /** Les colocataires, en plus du candidat : chacun locataire du même bail, avec ses pièces (AU097). */
  cotenants: string[];
  /** Par titulaire, le jour où son identité a été vérifiée, sans la sorte de pièce ni rien d'elle [R15, R13]. */
  identityVerifiedOn: Record<string, string>;
  pieces: { holder: string; category: PieceCategory; sort: string; label: string }[];
  complete: boolean;
  missing: Missing[];
}

export type ApplicationRefusal = Omit<LocationRefusal, 'rule'> & { rule: LocationRefusal['rule'] | 'R104' | 'R15' };
export type ApplicationResult<T> = { ok: true; value: T } | ApplicationRefusal;

export interface AddableContact {
  personId: string;
  firstName: string | null;
  lastName: string | null;
}

const MAX_ADDABLE = 500;

/** Le titulaire des pièces d'un colocataire : `colocataire:` suivi de sa fiche (AU097). */
export const COTENANT_PREFIX = 'colocataire:';
export const cotenantHolder = (personId: string): string => `${COTENANT_PREFIX}${personId}`;
/** Les colocataires en cours d'une candidature, dans l'ordre de leur dernier ajout (AU097) : la dernière ligne de chacun dit s'il l'est. */
export async function cotenantsOfApplication(db: SqlDatabase, applicationId: string): Promise<string[]> {
  const rows = await db.all<{ person_id: string; action: 'ajout' | 'retrait'; seq: number }>(
    `SELECT c.person_id, c.action, c.seq FROM rental_cotenant_changes c
     WHERE c.application_id = ? AND c.seq = (SELECT MAX(x.seq) FROM rental_cotenant_changes x WHERE x.application_id = c.application_id AND x.person_id = c.person_id)
     ORDER BY c.seq`,
    [applicationId],
  );
  return rows.filter((r) => r.action === 'ajout').map((r) => r.person_id);
}

/** Au plus cinq colocataires en plus du candidat : un bail de six locataires au plus. */
export const MAX_COTENANTS = 5;

export interface CandidaturesOptions {
  now?: () => Date;
  newId?: () => string;
}

export interface ApplicationRow {
  id: string;
  listing_id: string;
  network_id: string;
  person_id: string;
  arrival: number;
  dossierfacile_url: string | null;
  arrived_at: string;
}

export class Candidatures {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly listings: MisesEnLocation,
    private readonly identity: IdentityState,
    private readonly files: RentalFileStore,
    private readonly journal: JournalStore,
    options: CandidaturesOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private get fiche(): FicheUnique {
    return new FicheUnique(this.db, new FicheClient(this.db));
  }

  private async personIn(networkId: string, personId: unknown): Promise<boolean> {
    return typeof personId === 'string' && !!(await this.db.first('SELECT 1 FROM persons WHERE id = ? AND network_id = ?', [personId, networkId]));
  }

  private async app(viewer: Viewer, applicationId: unknown, write: boolean): Promise<ApplicationRefusal | ApplicationRow> {
    const row =
      typeof applicationId === 'string'
        ? await this.db.first<ApplicationRow>('SELECT id, listing_id, network_id, person_id, arrival, dossierfacile_url, arrived_at FROM rental_applications WHERE id = ? AND network_id = ?', [applicationId, viewer.networkId])
        : null;
    const listing = await this.listings.listing(viewer, row?.listing_id ?? `application:${String(applicationId)}`, write);
    if ('ok' in listing) return listing;
    return row!;
  }

  /**
   * Le logement d'une candidature et la personne à qui sera la pièce, pour la déposer, sous les droits d'écriture de
   * celui qui dépose [R16]. Le titulaire est dit d'avance : sans lui, le fichier d'un garant irait sur la carte du
   * candidat. Un visa Visale n'a pas d'autre personne que le candidat.
   */
  async placeOf(viewer: Viewer, applicationId: unknown, holder: unknown): Promise<ApplicationResult<{ listingId: string; applicationId: string; holder: string; personId: string }>> {
    const app = await this.app(viewer, applicationId, true);
    if ('ok' in app) return app;
    if (app.dossierfacile_url) return { ok: false, rule: 'R104', code: 'dossierfacile' };
    const place = { listingId: app.listing_id, applicationId: app.id };
    if (holder === 'candidat') return { ok: true, value: { ...place, holder, personId: app.person_id } };
    // AU097 · un colocataire dépose ses propres pièces, sous son nom.
    const co = await this.cotenantOf(app.id, holder);
    if (co) return { ok: true, value: { ...place, holder: holder as string, personId: co } };
    const g = typeof holder === 'string' ? await this.db.first<{ person_id: string | null }>('SELECT person_id FROM rental_guarantors WHERE id = ? AND application_id = ?', [holder, app.id]) : null;
    if (!g) return { ok: false, rule: null, code: 'unknown_holder' };
    return { ok: true, value: { ...place, holder: holder as string, personId: g.person_id ?? app.person_id } };
  }

  /** La ligne d'un fichier déposé (W19) : l'accès et l'effacement la voient, qu'il soit joint ou non [R95, R97]. */
  async recordDeposit(row: PieceDepositRow): Promise<void> {
    await this.db.run('INSERT INTO rental_piece_deposits (id, application_id, holder, person_id, ref, sha256, size, deposited_by, deposited_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      row.id,
      row.applicationId,
      row.holder,
      row.personId,
      row.ref,
      row.sha256,
      row.size,
      row.depositedBy,
      this.now().toISOString(),
    ]);
  }

  /**
   * Les contacts qu'un agent peut ajouter comme candidats : ses fiches gardées, sans fiche réunie d'un autre agent [R16],
   * sans personne déjà candidate ici, même par une fiche réunie. Lus d'une seule requête, 500 au plus.
   */
  async addableContacts(viewer: Viewer, listingId: unknown): Promise<ApplicationResult<{ contacts: AddableContact[]; more: boolean }>> {
    const listing = await this.listings.listing(viewer, listingId, true);
    if ('ok' in listing) return listing;
    const agent = viewer.role === 'agent' ? viewer.userId : null;
    const rows = await this.db.all<{ id: string; first_name: string | null; last_name: string | null }>(
      // Toutes les fiches réunies, chaîne comprise, comme `membersOf` : l'écran ne propose que ce que le geste accepte.
      `WITH RECURSIVE family (root, member) AS (
         SELECT id, id FROM persons WHERE network_id = ? AND (? IS NULL OR agent_id = ?)
         UNION
         SELECT f.root, m.merged_id FROM family f JOIN person_merges m ON m.survivor_id = f.member AND m.undone_at IS NULL
       )
       SELECT p.id, p.first_name, p.last_name FROM persons p
       WHERE p.network_id = ? AND (? IS NULL OR p.agent_id = ?)
         AND NOT EXISTS (SELECT 1 FROM person_merges m WHERE m.merged_id = p.id AND m.undone_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM family f WHERE f.root = p.id AND f.member = ?)
         AND (? IS NULL OR NOT EXISTS (
           SELECT 1 FROM family f JOIN persons c ON c.id = f.member
           WHERE f.root = p.id AND c.agent_id IS NOT ?))
         AND NOT EXISTS (SELECT 1 FROM family f JOIN rental_applications a ON a.person_id = f.member WHERE f.root = p.id AND a.listing_id = ?)
       ORDER BY p.last_name, p.first_name, p.id LIMIT ?`,
      [listing.networkId, agent, agent, listing.networkId, agent, agent, listing.ownerPersonId, agent, agent, listing.id, MAX_ADDABLE + 1],
    );
    return {
      ok: true,
      value: {
        contacts: rows.slice(0, MAX_ADDABLE).map((r) => ({ personId: r.id, firstName: r.first_name, lastName: r.last_name })),
        more: rows.length > MAX_ADDABLE,
      },
    };
  }

  /** Range une candidature, à son rang d'arrivée ; un lien DossierFacile peut l'accompagner [R104]. */
  async apply(viewer: Viewer, listingId: unknown, input: { personId: unknown; dossierFacileUrl?: unknown }): Promise<ApplicationResult<{ applicationId: string; arrival: number }>> {
    const listing = await this.listings.listing(viewer, listingId, true);
    if ('ok' in listing) return listing;
    if (!(await this.personIn(listing.networkId, input.personId))) return { ok: false, rule: null, code: 'unknown_person' };
    // Une personne, une candidature : rangée sur la fiche gardée, quelle que soit la fiche réunie choisie [R105].
    const personId = await this.fiche.rootOf(input.personId as string);
    const members = await this.fiche.membersOf(personId);
    const marks = members.map(() => '?').join(', ');
    // Comme `addableContacts`, pour qui appelle la route sans passer par l'écran (W22) : `missing` et la date de
    // vérification de l'identité diraient autrement quelque chose du client d'un autre agent [R16].
    if (viewer.role === 'agent' && (await this.db.first(`SELECT 1 FROM persons WHERE id IN (${marks}) AND agent_id IS NOT ?`, [...members, viewer.userId]))) {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `rental:${listing.id}`, data: { rule: 'R16', role: String(viewer.role), kind: 'rental_applicant', code: 'not_assigned' } }, this.now);
      return { ok: false, rule: 'R16', code: 'not_assigned' };
    }
    if (members.includes(listing.ownerPersonId)) return { ok: false, rule: null, code: 'unknown_person' };
    if (await this.db.first(`SELECT 1 FROM rental_applications WHERE listing_id = ? AND person_id IN (${marks})`, [listing.id, ...members])) return { ok: false, rule: null, code: 'already_applied' };
    const url = input.dossierFacileUrl === undefined || input.dossierFacileUrl === null ? null : input.dossierFacileUrl;
    if (url !== null && (typeof url !== 'string' || !DOSSIERFACILE.test(url))) return { ok: false, rule: null, code: 'bad_dossierfacile' };
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = this.newId();
      try {
        await this.db.run(
          `INSERT INTO rental_applications (id, listing_id, network_id, person_id, arrival, dossierfacile_url, created_by, arrived_at)
           SELECT ?, ?, ?, ?, COALESCE(MAX(arrival), 0) + 1, ?, ?, ? FROM rental_applications WHERE listing_id = ?`,
          [id, listing.id, listing.networkId, personId, url, this.actor(viewer), this.now().toISOString(), listing.id],
        );
      } catch (error) {
        if (/person_id/.test(String(error))) return { ok: false, rule: null, code: 'already_applied' };
        if (/UNIQUE/i.test(String(error))) continue;
        throw error;
      }
      const row = (await this.db.first<{ arrival: number }>('SELECT arrival FROM rental_applications WHERE id = ?', [id]))!;
      await appendEvent(this.journal, { type: 'location.candidature', actor: this.actor(viewer), subject: `rental:${listing.id}`, data: { application: `rental_application:${id}`, arrival: Number(row.arrival), dossierFacile: url !== null } }, this.now);
      return { ok: true, value: { applicationId: id, arrival: Number(row.arrival) } };
    }
    return { ok: false, rule: null, code: 'busy' };
  }

  /** Les colocataires en cours d'une candidature (AU097). */
  async cotenantsOf(applicationId: string): Promise<string[]> {
    return cotenantsOfApplication(this.db, applicationId);
  }

  /** La personne d'un titulaire `colocataire:<id>` encore colocataire de la candidature, ou null. */
  private async cotenantOf(applicationId: string, holder: unknown): Promise<string | null> {
    if (typeof holder !== 'string' || !holder.startsWith(COTENANT_PREFIX)) return null;
    const personId = holder.slice(COTENANT_PREFIX.length);
    return (await this.cotenantsOf(applicationId)).includes(personId) ? personId : null;
  }

  /**
   * Ajoute ou retire un colocataire (AU097) : une personne de la fiche, avec les mêmes règles qu'un garant (ni le
   * candidat, ni un autre candidat, ni le bailleur, jamais le client d'un autre agent) [R16]. Il devient un locataire du
   * même bail : ses pièces, sa signature, son exemplaire. Rien ne s'efface : un retrait est une ligne de plus [R17].
   */
  async setCotenant(viewer: Viewer, applicationId: unknown, input: { personId: unknown; action: unknown }): Promise<ApplicationResult<{ cotenants: string[] }>> {
    const app = await this.app(viewer, applicationId, true);
    if ('ok' in app) return app;
    if (app.dossierfacile_url) return { ok: false, rule: 'R104', code: 'dossierfacile' };
    if (input.action !== 'ajout' && input.action !== 'retrait') return { ok: false, rule: null, code: 'bad_action' };
    const current = await this.cotenantsOf(app.id);
    if (input.action === 'ajout') {
      const refused = await this.guarantorRefusal(viewer, app, input.personId);
      if (refused) return refused;
      if (current.includes(input.personId as string)) return { ok: false, rule: null, code: 'already_added' };
      if (await this.db.first('SELECT 1 FROM rental_guarantors WHERE application_id = ? AND person_id = ?', [app.id, input.personId as string])) return { ok: false, rule: null, code: 'already_guarantor' };
      if (current.length >= MAX_COTENANTS) return { ok: false, rule: null, code: 'too_many' };
    } else if (typeof input.personId !== 'string' || !current.includes(input.personId)) return { ok: false, rule: null, code: 'unknown_person' };
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await this.db.run(
          `INSERT INTO rental_cotenant_changes (id, network_id, application_id, person_id, seq, action, changed_by, changed_at)
           SELECT ?, ?, ?, ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ? FROM rental_cotenant_changes WHERE application_id = ?`,
          [this.newId(), app.network_id, app.id, input.personId as string, input.action, this.actor(viewer), this.now().toISOString(), app.id],
        );
        break;
      } catch (error) {
        if (!/UNIQUE/i.test(String(error)) || attempt === 4) throw error;
      }
    }
    await appendEvent(this.journal, { type: 'location.colocataire', actor: this.actor(viewer), subject: `rental_application:${app.id}`, data: { action: input.action } }, this.now);
    return { ok: true, value: { cotenants: await this.cotenantsOf(app.id) } };
  }

  /** Ajoute un garant : une personne de la fiche, ou la garantie Visale. */
  async addGuarantor(viewer: Viewer, applicationId: unknown, input: { kind: unknown; personId?: unknown }): Promise<ApplicationResult<{ guarantorId: string }>> {
    const app = await this.app(viewer, applicationId, true);
    if ('ok' in app) return app;
    // Accepté tel quel : un dossier DossierFacile ne reçoit rien de plus [R104].
    if (app.dossierfacile_url) return { ok: false, rule: 'R104', code: 'dossierfacile' };
    if (input.kind !== 'personne' && input.kind !== 'visale') return { ok: false, rule: null, code: 'bad_kind' };
    const personId = input.kind === 'personne' ? input.personId : null;
    if (input.kind === 'personne') {
      const refused = await this.guarantorRefusal(viewer, app, personId);
      if (refused) return refused;
      // Un colocataire est locataire, jamais aussi son propre garant (AU097).
      if ((await this.cotenantsOf(app.id)).includes(personId as string)) return { ok: false, rule: null, code: 'already_cotenant' };
    }
    // Un seul garant Visale par dossier : l'unicité sur la personne ne le voit pas, sa personne étant vide.
    if (input.kind === 'visale' && (await this.db.first("SELECT 1 FROM rental_guarantors WHERE application_id = ? AND kind = 'visale'", [app.id]))) return { ok: false, rule: null, code: 'already_added' };
    const id = this.newId();
    try {
      await this.db.run('INSERT INTO rental_guarantors (id, application_id, kind, person_id, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?)', [id, app.id, input.kind, (personId as string | null) ?? null, this.actor(viewer), this.now().toISOString()]);
    } catch (error) {
      if (/UNIQUE/i.test(String(error))) return { ok: false, rule: null, code: 'already_added' };
      throw error;
    }
    await appendEvent(this.journal, { type: 'location.garant', actor: this.actor(viewer), subject: `rental_application:${app.id}`, data: { kind: input.kind } }, this.now);
    return { ok: true, value: { guarantorId: id } };
  }

  /**
   * Les règles des contacts à ajouter (`addableContacts`), pour qui appelle la route sans passer par l'écran : un garant
   * n'est ni une fiche réunie, ni le candidat ou un autre candidat de ce logement même par une fiche réunie, ni le
   * bailleur ; pour un agent, aucune de ses fiches n'est à un autre agent : `missing` dirait si son identité est vérifiée.
   */
  private async guarantorRefusal(viewer: Viewer, app: ApplicationRow, personId: unknown): Promise<ApplicationRefusal | null> {
    const unknown: ApplicationRefusal = { ok: false, rule: null, code: 'unknown_person' };
    if (!(await this.personIn(app.network_id, personId))) return unknown;
    const root = await this.fiche.rootOf(personId as string);
    const members = await this.fiche.membersOf(root);
    const marks = members.map(() => '?').join(', ');
    if (viewer.role === 'agent' && (await this.db.first(`SELECT 1 FROM persons WHERE id IN (${marks}) AND agent_id IS NOT ?`, [...members, viewer.userId]))) {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `rental_application:${app.id}`, data: { rule: 'R16', role: String(viewer.role), kind: 'rental_guarantor', code: 'not_assigned' } }, this.now);
      return { ok: false, rule: 'R16', code: 'not_assigned' };
    }
    // Après le contrôle des droits : le contact réuni d'un autre agent reste un refus écrit au journal [R16].
    if (root !== personId) return unknown;
    if (await this.db.first(`SELECT 1 FROM rental_listings WHERE id = ? AND owner_person_id IN (${marks})`, [app.listing_id, ...members])) return unknown;
    if (await this.db.first(`SELECT 1 FROM rental_applications WHERE listing_id = ? AND person_id IN (${marks})`, [app.listing_id, ...members])) return unknown;
    return null;
  }

  /**
   * Range une pièce de la liste officielle pour le candidat ou un garant ; toute autre sorte est refusée et écrite au
   * journal ; une pièce d'identité va au coffre, jamais ici [R104, R15].
   */
  async addPiece(viewer: Viewer, applicationId: unknown, input: { holder: unknown; sort: unknown; ref: unknown; sha256: unknown }): Promise<ApplicationResult<{ category: PieceCategory }>> {
    const app = await this.app(viewer, applicationId, true);
    if ('ok' in app) return app;
    const subject = `rental_application:${app.id}`;
    if (typeof input.sort !== 'string' || !/^[a-z_]{2,40}$/.test(input.sort)) return { ok: false, rule: null, code: 'bad_sort' };
    if (['carte_identite', 'passeport', 'permis_conduire', 'titre_sejour', 'piece_identite'].includes(input.sort)) {
      return { ok: false, rule: 'R15', code: 'identity_in_vault' };
    }
    const official = Object.prototype.hasOwnProperty.call(OFFICIAL_PIECES, input.sort) ? OFFICIAL_PIECES[input.sort]! : null;
    if (!official) {
      await appendEvent(this.journal, { type: 'location.piece_refusee', actor: this.actor(viewer), subject, data: { rule: 'R104', sort: input.sort } }, this.now);
      return { ok: false, rule: 'R104', code: 'not_allowed' };
    }
    // Après la liste officielle : une pièce interdite reste nommée au journal, même sur ce dossier [R104].
    if (app.dossierfacile_url) return { ok: false, rule: 'R104', code: 'dossierfacile' };
    let holderKind: 'candidat' | 'personne' | 'visale' = 'candidat';
    // Un colocataire est un candidat à part entière : les pièces de l'annexe I, à son nom (AU097).
    if (input.holder !== 'candidat' && !(await this.cotenantOf(app.id, input.holder))) {
      const g = typeof input.holder === 'string' ? await this.db.first<{ kind: 'personne' | 'visale' }>('SELECT kind FROM rental_guarantors WHERE id = ? AND application_id = ?', [input.holder, app.id]) : null;
      if (!g) return { ok: false, rule: null, code: 'unknown_holder' };
      holderKind = g.kind;
    }
    // Visale : son visa seul ; une personne n'a pas de visa Visale ; chaque sorte pour qui l'annexe la permet [R104].
    const allowed = holderKind === 'visale' ? official.category === 'garantie' : official.holders.includes(holderKind === 'candidat' ? 'candidat' : 'caution');
    if (!allowed) {
      await appendEvent(this.journal, { type: 'location.piece_refusee', actor: this.actor(viewer), subject, data: { rule: 'R104', sort: input.sort } }, this.now);
      return { ok: false, rule: 'R104', code: 'not_for_holder' };
    }
    const prefix = `location/${app.listing_id}/candidatures/${app.id}/`;
    if (typeof input.ref !== 'string' || !input.ref.startsWith(prefix) || !REF_FILE.test(input.ref.slice(prefix.length))) return { ok: false, rule: null, code: 'bad_ref' };
    if (typeof input.sha256 !== 'string' || !SHA.test(input.sha256)) return { ok: false, rule: null, code: 'bad_sha256' };
    if (await this.db.first('SELECT 1 FROM rental_application_pieces WHERE ref = ?', [input.ref])) return { ok: false, rule: null, code: 'ref_used' };
    // Déposé pour une personne, un fichier ne se range pas au nom d'une autre : la carte des accès le lui a attribué.
    const deposit = await this.db.first<{ holder: string; sha256: string }>('SELECT holder, sha256 FROM rental_piece_deposits WHERE ref = ? AND application_id = ?', [input.ref, app.id]);
    if (deposit && deposit.holder !== input.holder) return { ok: false, rule: null, code: 'holder_mismatch' };
    if (deposit && deposit.sha256 !== input.sha256) return { ok: false, rule: null, code: 'bad_sha256' };
    if (!(await this.files.has(input.ref))) return { ok: false, rule: null, code: 'not_stored' };
    try {
      await this.db.run('INSERT INTO rental_application_pieces (id, application_id, holder, category, sort, ref, sha256, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        this.newId(),
        app.id,
        input.holder as string,
        official.category,
        input.sort,
        input.ref,
        input.sha256,
        this.actor(viewer),
        this.now().toISOString(),
      ]);
    } catch (error) {
      // Un seul justificatif de domicile par personne [R104].
      if (/UNIQUE/i.test(String(error)) && official.category === 'domicile') return { ok: false, rule: 'R104', code: 'one_domicile' };
      if (/UNIQUE/i.test(String(error))) return { ok: false, rule: null, code: 'ref_used' };
      throw error;
    }
    await appendEvent(this.journal, { type: 'location.piece', actor: this.actor(viewer), subject, data: { rule: 'R104', category: official.category, sort: input.sort } }, this.now);
    return { ok: true, value: { category: official.category } };
  }

  /** La complétude par la liste écrite, sans écriture ; jamais un avis sur la solvabilité [R104, R14]. */
  async completeness(app: ApplicationRow): Promise<{ complete: boolean; missing: Missing[]; identityVerifiedOn: Record<string, string> }> {
    if (app.dossierfacile_url) return { complete: true, missing: [], identityVerifiedOn: {} };
    const pieces = await this.db.all<{ holder: string; category: PieceCategory; sort: string }>('SELECT holder, category, sort FROM rental_application_pieces WHERE application_id = ?', [app.id]);
    const guarantors = await this.db.all<{ id: string; kind: 'personne' | 'visale'; person_id: string | null }>('SELECT id, kind, person_id FROM rental_guarantors WHERE application_id = ? ORDER BY added_at, id', [app.id]);
    const missing: Missing[] = [];
    const identityVerifiedOn: Record<string, string> = {};
    const person = async (holder: string, personId: string) => {
      const verifiedOn = (await this.identity.state(app.network_id, personId)).identityVerifiedOn;
      if (verifiedOn) identityVerifiedOn[holder] = verifiedOn;
      else missing.push({ holder, what: 'identite' });
      for (const what of REQUIRED) if (!pieces.some((p) => p.holder === holder && p.category === what)) missing.push({ holder, what });
    };
    await person('candidat', app.person_id);
    for (const c of await this.cotenantsOf(app.id)) await person(cotenantHolder(c), c);
    for (const g of guarantors) {
      if (g.kind === 'personne') await person(g.id, g.person_id!);
      else if (!pieces.some((p) => p.holder === g.id && p.sort === 'visa_visale')) missing.push({ holder: g.id, what: 'visa_visale' });
    }
    return { complete: missing.length === 0, missing, identityVerifiedOn };
  }

  private async view(app: ApplicationRow): Promise<ApplicationView> {
    const guarantors = await this.db.all<{ id: string; kind: 'personne' | 'visale'; person_id: string | null }>('SELECT id, kind, person_id FROM rental_guarantors WHERE application_id = ? ORDER BY added_at, id', [app.id]);
    const pieces = await this.db.all<{ holder: string; category: PieceCategory; sort: string }>('SELECT holder, category, sort FROM rental_application_pieces WHERE application_id = ? ORDER BY added_at, id', [app.id]);
    const c = await this.completeness(app);
    return {
      applicationId: app.id,
      listingId: app.listing_id,
      personId: app.person_id,
      arrival: Number(app.arrival),
      arrivedAt: app.arrived_at,
      dossierFacile: app.dossierfacile_url !== null,
      guarantors: guarantors.map((g) => ({ guarantorId: g.id, kind: g.kind, personId: g.person_id })),
      cotenants: await this.cotenantsOf(app.id),
      pieces: pieces.map((p) => ({ holder: p.holder, category: p.category, sort: p.sort, label: OFFICIAL_PIECES[p.sort]?.label ?? p.sort })),
      complete: c.complete,
      missing: c.missing,
      identityVerifiedOn: c.identityVerifiedOn,
    };
  }

  /** Une candidature et sa complétude, pour l'agent ; la lecture est au journal avant d'être rendue [R16]. */
  async read(viewer: Viewer, applicationId: unknown): Promise<ApplicationResult<ApplicationView>> {
    const app = await this.app(viewer, applicationId, false);
    if ('ok' in app) return app;
    await appendEvent(this.journal, { type: 'location.lue', actor: this.actor(viewer), subject: `rental_application:${app.id}`, data: { rule: 'R16', what: 'application' } }, this.now);
    return { ok: true, value: await this.view(app) };
  }

  /** Les candidatures d'une mise en location, dans leur ordre d'arrivée et lui seul [R14]. */
  async list(viewer: Viewer, listingId: unknown): Promise<ApplicationResult<ApplicationView[]>> {
    const listing = await this.listings.listing(viewer, listingId, false);
    if ('ok' in listing) return listing;
    await appendEvent(this.journal, { type: 'location.lue', actor: this.actor(viewer), subject: `rental:${listing.id}`, data: { rule: 'R16', what: 'applications' } }, this.now);
    const rows = await this.db.all<ApplicationRow>('SELECT id, listing_id, network_id, person_id, arrival, dossierfacile_url, arrived_at FROM rental_applications WHERE listing_id = ? ORDER BY arrival', [listing.id]);
    const out: ApplicationView[] = [];
    for (const r of rows) out.push(await this.view(r));
    return { ok: true, value: out };
  }
}
