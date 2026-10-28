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
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
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
  pieces: { holder: string; category: PieceCategory; sort: string; label: string }[];
  complete: boolean;
  missing: Missing[];
}

export type ApplicationRefusal = Omit<LocationRefusal, 'rule'> & { rule: LocationRefusal['rule'] | 'R104' | 'R15' };
export type ApplicationResult<T> = { ok: true; value: T } | ApplicationRefusal;

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

  /** Range une candidature, à son rang d'arrivée ; un lien DossierFacile peut l'accompagner [R104]. */
  async apply(viewer: Viewer, listingId: unknown, input: { personId: unknown; dossierFacileUrl?: unknown }): Promise<ApplicationResult<{ applicationId: string; arrival: number }>> {
    const listing = await this.listings.listing(viewer, listingId, true);
    if ('ok' in listing) return listing;
    if (!(await this.personIn(listing.networkId, input.personId))) return { ok: false, rule: null, code: 'unknown_person' };
    const url = input.dossierFacileUrl === undefined || input.dossierFacileUrl === null ? null : input.dossierFacileUrl;
    if (url !== null && (typeof url !== 'string' || !DOSSIERFACILE.test(url))) return { ok: false, rule: null, code: 'bad_dossierfacile' };
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = this.newId();
      try {
        await this.db.run(
          `INSERT INTO rental_applications (id, listing_id, network_id, person_id, arrival, dossierfacile_url, created_by, arrived_at)
           SELECT ?, ?, ?, ?, COALESCE(MAX(arrival), 0) + 1, ?, ?, ? FROM rental_applications WHERE listing_id = ?`,
          [id, listing.id, listing.networkId, input.personId as string, url, this.actor(viewer), this.now().toISOString(), listing.id],
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

  /** Ajoute un garant : une personne de la fiche, ou la garantie Visale. */
  async addGuarantor(viewer: Viewer, applicationId: unknown, input: { kind: unknown; personId?: unknown }): Promise<ApplicationResult<{ guarantorId: string }>> {
    const app = await this.app(viewer, applicationId, true);
    if ('ok' in app) return app;
    if (input.kind !== 'personne' && input.kind !== 'visale') return { ok: false, rule: null, code: 'bad_kind' };
    const personId = input.kind === 'personne' ? input.personId : null;
    if (input.kind === 'personne' && (!(await this.personIn(app.network_id, personId)) || personId === app.person_id)) return { ok: false, rule: null, code: 'unknown_person' };
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
    let holderKind: 'candidat' | 'personne' | 'visale' = 'candidat';
    if (input.holder !== 'candidat') {
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
  async completeness(app: ApplicationRow): Promise<{ complete: boolean; missing: Missing[] }> {
    if (app.dossierfacile_url) return { complete: true, missing: [] };
    const pieces = await this.db.all<{ holder: string; category: PieceCategory; sort: string }>('SELECT holder, category, sort FROM rental_application_pieces WHERE application_id = ?', [app.id]);
    const guarantors = await this.db.all<{ id: string; kind: 'personne' | 'visale'; person_id: string | null }>('SELECT id, kind, person_id FROM rental_guarantors WHERE application_id = ? ORDER BY added_at, id', [app.id]);
    const missing: Missing[] = [];
    const person = async (holder: string, personId: string) => {
      if (!(await this.identity.state(app.network_id, personId)).identityVerifiedOn) missing.push({ holder, what: 'identite' });
      for (const what of REQUIRED) if (!pieces.some((p) => p.holder === holder && p.category === what)) missing.push({ holder, what });
    };
    await person('candidat', app.person_id);
    for (const g of guarantors) {
      if (g.kind === 'personne') await person(g.id, g.person_id!);
      else if (!pieces.some((p) => p.holder === g.id && p.sort === 'visa_visale')) missing.push({ holder: g.id, what: 'visa_visale' });
    }
    return { complete: missing.length === 0, missing };
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
      pieces: pieces.map((p) => ({ holder: p.holder, category: p.category, sort: p.sort, label: OFFICIAL_PIECES[p.sort]?.label ?? p.sort })),
      complete: c.complete,
      missing: c.missing,
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
