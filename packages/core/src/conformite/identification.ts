/**
 * Identification et bénéficiaire effectif, étape bloquante (M12, L03) [R16, R17, R58, R92].
 *
 * Aucun mandat signé sans l'identité vérifiée et valide du vendeur, aucun compromis sans celle de l'acquéreur : les
 * contrôles avant signature (D03) et le dossier de vente (O07) lisent ici l'état du coffre (L01), plus une case cochée.
 * Une pièce compte si elle a été déposée au coffre avant l'instant du contrôle, vérifiée depuis au plus la durée du
 * réglage (un an par défaut), valide ce jour-là (Paris) et pas remplacée. Une pièce échue bloque comme une pièce absente.
 *
 * Une société : l'agent la déclare avec ses bénéficiaires effectifs, chacun une fiche du réseau à 25 % ou plus. Elle ne
 * passe que si son extrait Kbis est au coffre, vérifié et valide, et si chaque bénéficiaire effectif a sa propre pièce
 * d'identité vérifiée et valide. Une société déclarée sans bénéficiaire effectif est refusée.
 *
 * Décidé, lecture prudente :
 * - sans déclaration, le client est une personne physique : une société jamais déclarée ne passe donc pas, faute de
 *   pièce d'identité à son nom ;
 * - la fiche de risque (L02) ne sert jamais à savoir si un client est une société : aucun contrôle ne la lit [R91] ;
 * - le cas d'une société dont personne n'atteint 25 % (représentant légal retenu à défaut) attend la procédure validée
 *   par l'avocat (H29) : elle ne se déclare pas ici et reste bloquée ;
 * - l'ancienne identité « pièce vue » de D03 (`identity_checks`) reste écrite pour l'historique, mais ne suffit plus ;
 * - les déclarations ne s'effacent ni ne changent : la dernière compte [R17] ; le journal ne porte que des codes [R13].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { EtatCoffre } from './coffre.ts';
import { IDENTITY_PIECES } from './pieces-identite.ts';

/** Le seuil légal du bénéficiaire effectif, en pour cent du capital ou des droits de vote. */
export const BENEFICIAL_OWNER_THRESHOLD_PERCENT = 25;
/** Durée de validité d'une vérification par défaut, en jours (celle de D03). */
export const DEFAULT_IDENTIFICATION_DAYS = 365;

export type IdentificationCode =
  | 'identity_missing'
  | 'identity_expired'
  | 'kbis_missing'
  | 'kbis_expired'
  | 'beneficial_owners_missing'
  | 'beneficial_owner_unidentified';

export type IdentificationStatus =
  | { ok: true; entity: 'personne' | 'societe'; verifiedOn: string }
  | { ok: false; entity: 'personne' | 'societe'; code: IdentificationCode };

export interface BeneficialOwnerInput {
  personId: string;
  sharePercent: number;
}

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem = { ok: false; rule: null | 'R92'; code: string };

export class Identification {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly etat: EtatCoffre;
  private readonly unique: FicheUnique;
  private readonly maxAgeDays: number;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces | null,
    private readonly journal: JournalStore | null,
    options: { now?: () => Date; newId?: () => string; maxAgeDays?: number } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.maxAgeDays = options.maxAgeDays ?? DEFAULT_IDENTIFICATION_DAYS;
    this.etat = new EtatCoffre(db, { now: this.now });
    this.unique = new FicheUnique(db, new FicheClient(db, { now: this.now }), { now: this.now });
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, personId: string, code: string): Promise<Refusal> {
    if (this.journal) {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `person:${personId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'identification', code } }, this.now);
    }
    return { ok: false, rule: 'R16', code };
  }

  /**
   * Déclare le client personne physique ou société, avec ses bénéficiaires effectifs. L'agent de la fiche ou le
   * responsable, qui voient en entier la fiche du client et celle de chaque bénéficiaire effectif [R16].
   */
  async declare(
    viewer: Viewer,
    personId: string,
    input: { entity: unknown; beneficialOwners?: unknown },
  ): Promise<{ ok: true; id: string } | Refusal | Problem> {
    if (!this.acces || !this.journal) throw new Error('déclaration sans accès ni journal');
    if (viewer.role !== 'agent' && viewer.role !== 'compliance') return this.refuse(viewer, personId, 'role');
    if (input.entity !== 'personne' && input.entity !== 'societe') return { ok: false, rule: null, code: 'bad_entity' };
    const raw = input.beneficialOwners ?? [];
    if (!Array.isArray(raw)) return { ok: false, rule: null, code: 'bad_owner' };
    if (input.entity === 'personne' && raw.length > 0) return { ok: false, rule: null, code: 'owners_for_person' };
    if (input.entity === 'societe' && raw.length === 0) return { ok: false, rule: 'R92', code: 'beneficial_owners_missing' };

    const read = await this.acces.readFiche(viewer, personId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.view !== 'full') return this.refuse(viewer, personId, 'not_assigned');
    const company = read.value.person.id;
    const companyRoot = await this.unique.rootOf(company);

    const owners: { personId: string; sharePercent: number }[] = [];
    const roots = new Set<string>();
    let total = 0;
    for (const o of raw as unknown[]) {
      if (typeof o !== 'object' || o === null) return { ok: false, rule: null, code: 'bad_owner' };
      const { personId: ownerId, sharePercent } = o as Record<string, unknown>;
      if (typeof ownerId !== 'string' || !Number.isInteger(sharePercent)) return { ok: false, rule: null, code: 'bad_owner' };
      const share = sharePercent as number;
      if (share < BENEFICIAL_OWNER_THRESHOLD_PERCENT || share > 100) return { ok: false, rule: 'R92', code: 'share_below_threshold' };
      const owner = await this.acces.readFiche(viewer, ownerId);
      if (!owner.ok) return { ok: false, rule: 'R16', code: owner.code };
      if (owner.view !== 'full') return this.refuse(viewer, ownerId, 'not_assigned');
      const root = await this.unique.rootOf(owner.value.person.id);
      if (root === companyRoot) return { ok: false, rule: null, code: 'owner_is_company' };
      if (roots.has(root)) return { ok: false, rule: null, code: 'duplicate_owner' };
      roots.add(root);
      total += share;
      owners.push({ personId: owner.value.person.id, sharePercent: share });
    }
    if (total > 100) return { ok: false, rule: null, code: 'shares_above_100' };

    const id = this.newId();
    await this.db.run('INSERT INTO client_identifications (id, network_id, person_id, entity, declared_by, declared_at) VALUES (?, ?, ?, ?, ?, ?)', [
      id, viewer.networkId, company, input.entity, this.actor(viewer), this.now().toISOString(),
    ]);
    for (const o of owners) {
      await this.db.run('INSERT INTO beneficial_owners (declaration_id, network_id, owner_person_id, share_percent) VALUES (?, ?, ?, ?)', [id, viewer.networkId, o.personId, o.sharePercent]);
    }
    await appendEvent(
      this.journal,
      { type: 'identification.declaree', actor: this.actor(viewer), subject: `person:${company}`, data: { rule: 'R92', entity: input.entity, owners: owners.map((o) => `person:${o.personId}`) } },
      this.now,
    );
    return { ok: true, id };
  }

  /** La dernière déclaration valable à l'instant `at`, toutes fiches réunies du client. */
  private async declaration(networkId: string, personId: string, at: Date): Promise<{ id: string; entity: 'personne' | 'societe' } | null> {
    const ids = await this.unique.membersOf(personId);
    return this.db.first<{ id: string; entity: 'personne' | 'societe' }>(
      `SELECT id, entity FROM client_identifications WHERE network_id = ? AND person_id IN (${ids.map(() => '?').join(', ')}) AND declared_at <= ? ORDER BY declared_at DESC, rowid DESC LIMIT 1`,
      [networkId, ...ids, at.toISOString()],
    );
  }

  private async personIdentity(networkId: string, personId: string, at: Date): Promise<{ ok: true; verifiedOn: string } | { ok: false; code: 'identity_missing' | 'identity_expired' }> {
    const s = await this.etat.pieceStatus(networkId, personId, IDENTITY_PIECES, at, this.maxAgeDays);
    if (s.verifiedOn) return { ok: true, verifiedOn: s.verifiedOn };
    return { ok: false, code: s.expired ? 'identity_expired' : 'identity_missing' };
  }

  /**
   * L'état d'identification d'un client à l'instant `at` : vérifié (avec la plus ancienne des dates qui le fondent), ou
   * la raison du blocage, en un code [R92]. Lecture seule ; les droits sont ceux de l'appelant.
   */
  async status(networkId: string, personId: string, at: Date = this.now()): Promise<IdentificationStatus> {
    const declared = await this.declaration(networkId, personId, at);
    if (!declared || declared.entity === 'personne') {
      const r = await this.personIdentity(networkId, personId, at);
      return r.ok ? { ok: true, entity: 'personne', verifiedOn: r.verifiedOn } : { ok: false, entity: 'personne', code: r.code };
    }
    const kbis = await this.etat.pieceStatus(networkId, personId, ['extrait_kbis'], at, this.maxAgeDays);
    if (!kbis.verifiedOn) return { ok: false, entity: 'societe', code: kbis.expired ? 'kbis_expired' : 'kbis_missing' };
    const owners = await this.db.all<{ owner_person_id: string; share_percent: number }>('SELECT owner_person_id, share_percent FROM beneficial_owners WHERE declaration_id = ? ORDER BY owner_person_id', [declared.id]);
    const counted = owners.filter((o) => Number(o.share_percent) >= BENEFICIAL_OWNER_THRESHOLD_PERCENT);
    if (counted.length === 0) return { ok: false, entity: 'societe', code: 'beneficial_owners_missing' };
    let oldest = kbis.verifiedOn;
    for (const o of counted) {
      const r = await this.personIdentity(networkId, o.owner_person_id, at);
      if (!r.ok) return { ok: false, entity: 'societe', code: 'beneficial_owner_unidentified' };
      if (r.verifiedOn < oldest) oldest = r.verifiedOn;
    }
    return { ok: true, entity: 'societe', verifiedOn: oldest };
  }
}
