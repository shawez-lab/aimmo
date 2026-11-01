/**
 * Les lecteurs SQL de l'espace du propriétaire et du bailleur (EC09) [R161, R162, R163, R31, R14, R13].
 *
 * Décidé, lecture prudente :
 * - l'espace ne refait aucun module : la complétude d'une candidature est celle de W03 (`Candidatures.completeness`,
 *   avec l'état « identité vérifiée » du coffre), les loyers et charges ceux du logement (W01) à la version que le bail
 *   a prise, la fourchette de la commune celle de l'estimation en ligne (E05), comme le suivi de valeur (G04) ;
 * - un bien est au propriétaire si c'est lui qui l'a pris en dernier : par un mandat inscrit, ni annulé ni rétracté,
 *   par une mise en location à son nom, ou par l'acte qui le lui a vendu ; sa période commence au premier de ces faits
 *   de sa dernière suite. Un vendeur dont l'acte est passé n'est plus propriétaire du bien, l'acquéreur le devient ; un
 *   ancien bailleur ne voit rien de la location du suivant [R161]. Un seul propriétaire par bien pour l'espace : deux
 *   personnes de fiches distinctes (un couple) ne le partagent pas, le dernier fait l'emporte ; l'oubli d'un bien est
 *   préféré à une fuite, et l'agent peut réunir les fiches ;
 * - le bail n'est dit signé que par une signature réelle : tant que la signature en ligne du bail reste d'essai
 *   (`REAL_LEASE_SIGNATURE`), sa date, son loyer et ses charges sont « non communiqués » ; un bail ou un état des lieux
 *   d'essai, ou incomplet, n'est jamais montré [R163] ;
 * - la valeur suivie n'est lue que si le suivi est inscrit, que son accord est en cours, et pour le seul logement du
 *   propriétaire dans la commune suivie [R03, R31] ; c'est la
 *   fourchette au m² de la commune, datée des dernières ventes publiées, avec la source ; jamais un prix du bien ;
 * - chaque candidat et chaque garant personne est rattaché, avec ce qui l'identifie, pour la retenue [R161] ;
 * - les pièces sont rendues par leur sorte, sans référence ni empreinte ; l'espace ne garde que celles de la liste
 *   officielle [R162].
 */
import type { SqlDatabase } from '../db/sql.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { CommuneRanges } from '../mandats/suivi-valeur.ts';
import { VALUE_TRACKING_PURPOSE } from '../mandats/suivi-valeur.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import type { JournalStore } from '../journal/types.ts';
import { Candidatures, type ApplicationRow, type IdentityState } from '../location/candidatures.ts';
import { REAL_LEASE_SIGNATURE } from '../location/signature-bail.ts';
import { DOCUMENT_TITLES, LIVE_MANDATES, placeholders, sourcePerson } from './lecture.ts';
import type { OwnerApplication, OwnerDocument, OwnerInspection, OwnerLease, OwnerProperty, OwnerRental, OwnerValue, SourcesProprietaire } from './proprietaire.ts';
import type { SourcePerson } from './vendeur.ts';

/** La période d'un propriétaire sur un bien, et ses mises en location dans cette période. */
export interface OwnerWindow {
  propertyId: string;
  since: string;
  listingIds: string[];
}

interface OwnershipEvent {
  property_id: string;
  person_id: string;
  at: string;
  kind: 'mandat' | 'location' | 'acte';
  ref: string;
}

/** Ce qui fait d'une personne le propriétaire d'un bien, dans l'ordre des dates. */
const OWNERSHIP_EVENTS = `
  SELECT property_id, person_id, signed_at AS at, 'mandat' AS kind, id AS ref FROM (${LIVE_MANDATES})
  UNION ALL
  SELECT property_id, owner_person_id AS person_id, created_at AS at, 'location' AS kind, id AS ref FROM rental_listings WHERE network_id = ?
  UNION ALL
  SELECT f.property_id, f.buyer_person_id AS person_id, c.at AS at, 'acte' AS kind, f.id AS ref
  FROM sale_file_closings c JOIN sale_files f ON f.id = c.file_id WHERE f.network_id = ?`;

/**
 * Les biens dont la personne est propriétaire aujourd'hui : elle est la dernière à les avoir pris. Un acte rangé passe
 * le bien du vendeur à l'acquéreur à son heure [R161].
 */
export async function ownerWindows(db: SqlDatabase, fiche: FicheUnique, networkId: string, personId: string): Promise<OwnerWindow[]> {
  const members = new Set(await fiche.membersOf(personId));
  const q = placeholders(members.size);
  const touched = await db.all<{ property_id: string }>(`SELECT DISTINCT property_id FROM (${OWNERSHIP_EVENTS}) WHERE person_id IN (${q})`, [networkId, networkId, networkId, ...members]);
  const out: OwnerWindow[] = [];
  for (const { property_id } of touched) {
    const events = await db.all<OwnershipEvent>(`SELECT * FROM (${OWNERSHIP_EVENTS}) WHERE property_id = ? ORDER BY at, kind, ref`, [networkId, networkId, networkId, property_id]);
    // Le vendeur d'un acte cesse d'être propriétaire à l'acte, même si c'est lui qui a signé le dernier mandat.
    const run: OwnershipEvent[] = [];
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (!members.has(e.person_id)) break;
      run.unshift(e);
    }
    if (run.length === 0) continue;
    out.push({ propertyId: property_id, since: run[0]!.at, listingIds: run.filter((e) => e.kind === 'location').map((e) => e.ref) });
  }
  return out.sort((a, b) => a.since.localeCompare(b.since) || a.propertyId.localeCompare(b.propertyId));
}

/** L'état d'une mise en location, dit au propriétaire, avec sa date. */
const RENTAL_STATES = {
  ouverte: 'candidatures en cours',
  presentee: 'dossiers présentés',
  choisie: 'candidat choisi',
  bail: 'bail signé',
  cles: 'clés remises',
} as const;

const euros = (cents: number | null | undefined): number | null => (typeof cents === 'number' && Number.isFinite(cents) ? cents / 100 : null);

export interface SqlSourcesProprietaireOptions {
  now?: () => Date;
  /** La fourchette de la commune, comme pour le suivi de valeur (G04) ; sans elle, aucune valeur n'est montrée. */
  ranges?: CommuneRanges | null;
  /** Vrai quand la signature en ligne du bail est réelle (W12) ; d'essai tant que H08 et H24 ne sont pas faits. */
  realLeaseSignature?: boolean;
}

export class SqlSourcesProprietaire implements SourcesProprietaire {
  private readonly now: () => Date;
  private readonly fiche: FicheUnique;
  private readonly candidatures: Candidatures;
  private readonly ranges: CommuneRanges | null;
  private readonly realSignature: boolean;

  constructor(
    private readonly db: SqlDatabase,
    identity: IdentityState,
    journal: JournalStore,
    options: SqlSourcesProprietaireOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.fiche = new FicheUnique(db, new FicheClient(db, { now: this.now }), { now: this.now });
    // Seule la complétude est lue : elle n'écrit rien et ne touche ni aux mises en location ni au stockage.
    const unused = new Proxy({}, { get: () => () => Promise.reject(new Error('espace : lecture seule')) });
    this.candidatures = new Candidatures(db, unused as never, identity, unused as never, journal, { now: this.now });
    this.ranges = options.ranges ?? null;
    this.realSignature = options.realLeaseSignature ?? REAL_LEASE_SIGNATURE;
  }

  private async window(networkId: string, propertyId: string, personId: string): Promise<OwnerWindow | null> {
    return (await ownerWindows(this.db, this.fiche, networkId, personId)).find((w) => w.propertyId === propertyId) ?? null;
  }

  async ownerPropertiesOf(networkId: string, personId: string): Promise<readonly OwnerProperty[]> {
    const out: OwnerProperty[] = [];
    for (const w of await ownerWindows(this.db, this.fiche, networkId, personId)) {
      const p = await this.db.first<{ id: string; reference: string; city: string | null }>('SELECT id, reference, city FROM properties WHERE id = ? AND network_id = ?', [w.propertyId, networkId]);
      if (p) out.push({ propertyId: p.id, reference: p.reference, city: p.city ?? 'non communiquée' });
    }
    return out;
  }

  async rentalsOf(networkId: string, propertyId: string, personId: string): Promise<readonly OwnerRental[]> {
    const w = await this.window(networkId, propertyId, personId);
    if (!w || w.listingIds.length === 0) return [];
    const rows = await this.db.all<{ id: string; created_at: string }>(
      `SELECT id, created_at FROM rental_listings WHERE network_id = ? AND property_id = ? AND id IN (${placeholders(w.listingIds.length)}) ORDER BY created_at, id`,
      [networkId, propertyId, ...w.listingIds],
    );
    const out: OwnerRental[] = [];
    for (const r of rows) {
      const state = await this.rentalState(networkId, r.id, r.created_at);
      out.push({ rentalId: r.id, propertyId, openedAt: r.created_at, state: state.label, stateAt: state.at });
    }
    return out;
  }

  /** L'état le plus avancé de la mise en location, d'après ce que M15 a rangé ; un bail d'essai ne compte pas. */
  private async rentalState(networkId: string, listingId: string, openedAt: string): Promise<{ label: string; at: string }> {
    const handover = await this.db.first<{ handed_on: string; lease_id: string }>('SELECT handed_on, lease_id FROM rental_handovers WHERE listing_id = ? AND network_id = ?', [listingId, networkId]);
    if (handover && (await this.signedLease(networkId, handover.lease_id))) return { label: RENTAL_STATES.cles, at: handover.handed_on };
    const lease = await this.leaseOf(networkId, listingId);
    if (lease?.signedAt) return { label: RENTAL_STATES.bail, at: lease.signedAt };
    const choice = await this.db.first<{ decided_at: string }>('SELECT decided_at FROM rental_choices WHERE listing_id = ?', [listingId]);
    if (choice) return { label: RENTAL_STATES.choisie, at: choice.decided_at };
    const shown = await this.db.first<{ created_at: string }>('SELECT created_at FROM rental_presentations WHERE listing_id = ? AND network_id = ? ORDER BY version DESC LIMIT 1', [listingId, networkId]);
    if (shown) return { label: RENTAL_STATES.presentee, at: shown.created_at };
    return { label: RENTAL_STATES.ouverte, at: openedAt };
  }

  async applicationsOf(networkId: string, rentalId: string): Promise<readonly OwnerApplication[]> {
    const apps = await this.db.all<ApplicationRow>(
      'SELECT id, listing_id, network_id, person_id, arrival, dossierfacile_url, arrived_at FROM rental_applications WHERE listing_id = ? AND network_id = ? ORDER BY arrival, id',
      [rentalId, networkId],
    );
    const out: OwnerApplication[] = [];
    for (const a of apps) {
      const guarantors = await this.db.all<{ id: string; kind: string; person_id: string | null }>('SELECT id, kind, person_id FROM rental_guarantors WHERE application_id = ? ORDER BY added_at, id', [a.id]);
      const pieces = await this.db.all<{ holder: string; sort: string }>('SELECT holder, sort FROM rental_application_pieces WHERE application_id = ? ORDER BY added_at, id', [a.id]);
      const persons: SourcePerson[] = [await sourcePerson(this.db, this.fiche, a.person_id)];
      for (const g of guarantors) if (g.person_id) persons.push(await sourcePerson(this.db, this.fiche, g.person_id));
      out.push({
        id: a.id,
        receivedAt: a.arrived_at,
        complete: (await this.candidatures.completeness(a)).complete,
        pieces: pieces.map((p) => ({ holder: p.holder === 'candidat' ? 'candidat' : 'caution', kind: p.sort })),
        guarantors: guarantors.length,
        persons,
      });
    }
    return out;
  }

  /** Vrai si les deux parties ont signé ce bail, par une signature réelle ; rend la date de la dernière. */
  private async signedLease(networkId: string, leaseId: string): Promise<string | null> {
    if (!this.realSignature) return null;
    const rows = await this.db.all<{ party: string; signed_at: string }>("SELECT party, signed_at FROM rental_lease_signatures WHERE lease_id = ? AND network_id = ? AND status = 'signee'", [leaseId, networkId]);
    const parties = new Set(rows.map((r) => r.party));
    if (!parties.has('bailleur') || !parties.has('locataire')) return null;
    return rows.map((r) => r.signed_at).sort().at(-1) ?? null;
  }

  async leaseOf(networkId: string, rentalId: string): Promise<OwnerLease | null> {
    const lease = await this.db.first<{ id: string; mode: string; status: string; facts_version: number }>(
      'SELECT id, mode, status, facts_version FROM rental_leases WHERE listing_id = ? AND network_id = ? ORDER BY version DESC LIMIT 1',
      [rentalId, networkId],
    );
    // Un bail d'essai ou incomplet n'est pas un bail : rien n'en est montré [R163].
    if (!lease || lease.mode !== 'reel' || lease.status !== 'complet') return null;
    const facts = await this.db.first<{ rent_cents: number; charges_cents: number; lease_start: string }>('SELECT rent_cents, charges_cents, lease_start FROM rental_facts WHERE listing_id = ? AND version = ?', [rentalId, lease.facts_version]);
    return { signedAt: await this.signedLease(networkId, lease.id), startsOn: facts?.lease_start ?? null, rentEur: euros(facts?.rent_cents), chargesEur: euros(facts?.charges_cents) };
  }

  async inspectionsOf(networkId: string, rentalId: string): Promise<readonly OwnerInspection[]> {
    const inv = await this.db.first<{ id: string; mode: string; status: string; lease_id: string }>(
      'SELECT id, mode, status, lease_id FROM rental_inventories WHERE listing_id = ? AND network_id = ? ORDER BY version DESC LIMIT 1',
      [rentalId, networkId],
    );
    if (!inv || inv.mode !== 'reel' || inv.status !== 'complet') return [];
    const rows = await this.db.all<{ party: string; signed_at: string }>('SELECT party, signed_at FROM rental_inventory_signatures WHERE inventory_id = ?', [inv.id]);
    const parties = new Set(rows.map((r) => r.party));
    const signedAt = parties.has('bailleur') && parties.has('locataire') ? (rows.map((r) => r.signed_at).sort().at(-1) ?? null) : null;
    // M15 ne range aujourd'hui que l'état des lieux d'entrée.
    return [{ kind: 'entree', signedAt }];
  }

  async valueOf(networkId: string, personId: string, propertyId: string): Promise<OwnerValue | null> {
    if (!this.ranges) return null;
    const windows = await ownerWindows(this.db, this.fiche, networkId, personId);
    if (!windows.some((w) => w.propertyId === propertyId)) return null;
    const members = await this.fiche.membersOf(personId);
    const q = placeholders(members.length);
    const tracking = await this.db.first<{ postal_code: string; town: string; kind: 'apartment' | 'house'; channel: string }>(
      `SELECT postal_code, town, kind, channel FROM value_tracking WHERE network_id = ? AND person_id IN (${q}) ORDER BY created_at LIMIT 1`,
      [networkId, ...members],
    );
    if (!tracking) return null;
    // Le suivi ne porte pas le bien : il n'est rattaché qu'au seul logement du propriétaire dans la commune suivie.
    // Un autre bien, ou deux logements dans la même commune, et rien n'est montré : jamais la fourchette d'un autre type
    // de bien présentée comme la sienne [R163, R31].
    const owned = await this.db.all<{ id: string }>(
      `SELECT id FROM properties WHERE network_id = ? AND kind = 'home' AND postal_code = ? AND lower(city) = lower(?) AND id IN (${placeholders(windows.length)})`,
      [networkId, tracking.postal_code, tracking.town, ...windows.map((w) => w.propertyId)],
    );
    if (owned.length !== 1 || owned[0]!.id !== propertyId) return null;
    const at = this.now().toISOString();
    const consent = await this.db.first<{ n: number }>(
      `SELECT count(*) AS n FROM consents WHERE person_id IN (${q}) AND purpose = ? AND channel = ? AND given_at <= ? AND (withdrawn_at IS NULL OR withdrawn_at > ?)`,
      [...members, VALUE_TRACKING_PURPOSE, tracking.channel, at, at],
    );
    // Sans accord en cours, le suivi n'est plus actif : rien n'est montré [R03].
    if (Number(consent?.n ?? 0) === 0) return null;
    const range = await this.ranges.forTown(tracking.postal_code, tracking.town, tracking.kind);
    if (!range.ok) return null;
    return { tracking: true, city: range.value.town, lowEur: range.value.perM2.low, highEur: range.value.perM2.high, computedAt: range.value.data.lastSale, sources: [range.value.data.source] };
  }

  async documentsOf(networkId: string, personId: string, propertyId: string): Promise<readonly OwnerDocument[]> {
    const w = await this.window(networkId, propertyId, personId);
    if (!w) return [];
    const members = await this.fiche.membersOf(personId);
    const q = placeholders(members.length);
    const out: OwnerDocument[] = [];
    const docs = await this.db.all<{ id: string; kind: string; created_at: string }>(
      `SELECT id, kind, created_at FROM documents WHERE network_id = ? AND property_id = ? AND mode = 'reel' AND status = 'complet' AND person_id IN (${q}) ORDER BY created_at, id`,
      [networkId, propertyId, ...members],
    );
    for (const d of docs) out.push({ id: d.id, propertyId, title: DOCUMENT_TITLES[d.kind] ?? 'Document', kind: d.kind, addedAt: d.created_at });
    for (const listingId of w.listingIds) {
      const lease = await this.db.first<{ id: string }>("SELECT id FROM rental_leases WHERE listing_id = ? AND network_id = ? AND mode = 'reel' AND status = 'complet' ORDER BY version DESC LIMIT 1", [listingId, networkId]);
      const copy = lease ? await this.db.first<{ created_at: string }>('SELECT created_at FROM rental_lease_copies WHERE lease_id = ?', [lease.id]) : null;
      if (lease && copy && (await this.signedLease(networkId, lease.id))) out.push({ id: lease.id, propertyId, title: 'Bail signé', kind: 'bail', addedAt: copy.created_at });
      const inv = await this.db.first<{ id: string }>("SELECT id FROM rental_inventories WHERE listing_id = ? AND network_id = ? AND mode = 'reel' AND status = 'complet' ORDER BY version DESC LIMIT 1", [listingId, networkId]);
      const invCopy = inv ? await this.db.first<{ prepared_at: string }>("SELECT prepared_at FROM rental_inventory_copies WHERE inventory_id = ? AND party = 'bailleur'", [inv.id]) : null;
      if (inv && invCopy) out.push({ id: inv.id, propertyId, title: 'État des lieux d’entrée', kind: 'etat_des_lieux', addedAt: invCopy.prepared_at });
    }
    const booklet = await this.db.first<{ file_id: string; created_at: string }>(
      `SELECT b.file_id, b.created_at FROM owner_booklets b JOIN sale_files f ON f.id = b.file_id WHERE b.network_id = ? AND f.property_id = ? AND b.person_id IN (${q}) ORDER BY b.created_at LIMIT 1`,
      [networkId, propertyId, ...members],
    );
    if (booklet) out.push({ id: `carnet:${booklet.file_id}`, propertyId, title: 'Carnet du propriétaire', kind: 'carnet', addedAt: booklet.created_at });
    return out.sort((a, b) => a.addedAt.localeCompare(b.addedAt) || a.id.localeCompare(b.id));
  }
}
