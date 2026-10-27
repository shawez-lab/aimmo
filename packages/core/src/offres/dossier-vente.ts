/**
 * Offre acceptée : dossier de vente, bloqué sans identité vérifiée (M09, O07) [R57, R58].
 *
 * Une acceptation rapportée avec sa preuve (de l'offre, ou de la dernière proposition après des contre-offres) ouvre un
 * dossier de vente minimal : bien, offre, acquéreur, montant convenu. M10 le complétera. Un seul dossier ouvert par bien,
 * donc une seule offre acceptée à la fois. Le bien passe « sous offre », ce que la publication (M07) montre partout au
 * passage suivant. Le dossier ne passe « compromis en préparation » que si l'identité de l'acquéreur est vérifiée, selon
 * la règle de D03 ; sinon il reste bloqué et la raison est rendue [R58].
 *
 * Décidé, lecture prudente : l'ouverture n'est pas automatique ; l'agent du bien l'ouvre après avoir rapporté
 * l'acceptation. Un bien vendu, loué ou retiré n'ouvre pas de dossier.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { ContreOffres } from './contre-offres.ts';
import { ControlesOffre } from './controles-offre.ts';
import { TransmissionOffres } from './transmission.ts';

export interface SaleFile {
  id: string;
  propertyId: string;
  offerId: string;
  amountEur: number;
  openedAt: string;
  steps: { step: 'compromis_en_preparation'; at: string }[];
}

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem =
  | { ok: false; rule: null; code: 'unknown_offer' | 'unknown_property' | 'unknown_file' | 'not_accepted' | 'already_open' | 'not_on_sale' | 'already_started' | string }
  | { ok: false; rule: 'R58'; code: 'identity_missing' };

export class DossiersVente {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly transmission: TransmissionOffres;
  private readonly contre: ContreOffres;
  private readonly controles: ControlesOffre;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.transmission = new TransmissionOffres(db, acces, journal, { now: this.now });
    this.contre = new ContreOffres(db, acces, journal, { now: this.now });
    this.controles = new ControlesOffre(db, acces, journal, { now: this.now });
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async read(id: string): Promise<SaleFile | null> {
    const f = await this.db.first<{ id: string; property_id: string; offer_id: string; amount_eur: number; opened_at: string }>('SELECT id, property_id, offer_id, amount_eur, opened_at FROM sale_files WHERE id = ?', [id]);
    if (!f) return null;
    const steps = await this.db.all<{ step: 'compromis_en_preparation'; at: string }>('SELECT step, at FROM sale_file_steps WHERE file_id = ? ORDER BY at', [id]);
    return { id: f.id, propertyId: f.property_id, offerId: f.offer_id, amountEur: Number(f.amount_eur), openedAt: f.opened_at, steps };
  }

  /** L'agent du bien ouvre le dossier d'une offre acceptée avec preuve ; un seul dossier ouvert par bien [R57]. */
  async open(viewer: Viewer, offerId: string): Promise<{ ok: true; value: SaleFile } | Refusal | Problem> {
    const found = await this.transmission.offerFor(viewer, offerId, true);
    if (!found.ok) return found as Refusal | Problem;
    const offer = found.offer;
    const answer = await this.db.first<{ outcome: string }>('SELECT outcome FROM offer_responses WHERE offer_id = ?', [offerId]);
    let amount: number | null = null;
    if (answer?.outcome === 'acceptee') amount = offer.amountEur;
    else if (answer?.outcome === 'contre_offre') amount = (await this.contre.accepted(offerId))?.amountEur ?? null;
    if (amount === null) return { ok: false, rule: null, code: 'not_accepted' };
    const property = await this.db.first<{ status: string }>('SELECT status FROM properties WHERE id = ?', [offer.propertyId]);
    if (!property || ['sold', 'rented', 'withdrawn'].includes(property.status)) return { ok: false, rule: null, code: 'not_on_sale' };
    const id = this.newId();
    try {
      await this.db.run(
        'INSERT INTO sale_files (id, network_id, property_id, offer_id, buyer_person_id, amount_eur, opened_at, opened_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [id, found.networkId, offer.propertyId, offerId, offer.buyerPersonId, amount, this.now().toISOString(), this.actor(viewer)],
      );
    } catch (error) {
      if (/UNIQUE/i.test(String(error))) return { ok: false, rule: null, code: 'already_open' };
      throw error;
    }
    // Le bien passe « sous offre » : la publication le montre ainsi au passage suivant (M07).
    await this.db.run("UPDATE properties SET status = 'under_offer', updated_at = ? WHERE id = ? AND status IN ('draft', 'available')", [this.now().toISOString(), offer.propertyId]);
    await appendEvent(this.journal, { type: 'dossier.ouvert', actor: this.actor(viewer), subject: `property:${offer.propertyId}`, data: { rule: 'R57', offer: `offer:${offerId}` } }, this.now);
    return { ok: true, value: (await this.read(id))! };
  }

  /** Le passage à « compromis en préparation » : refusé tant que l'identité de l'acquéreur n'est pas vérifiée [R58]. */
  async startCompromis(viewer: Viewer, fileId: string): Promise<{ ok: true; value: SaleFile } | Refusal | Problem> {
    const f = await this.db.first<{ offer_id: string; network_id: string; buyer_person_id: string }>('SELECT offer_id, network_id, buyer_person_id FROM sale_files WHERE id = ?', [fileId]);
    if (!f || f.network_id !== viewer.networkId) {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `sale_file:${fileId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'sale_file', code: 'unknown' } }, this.now);
      return { ok: false, rule: null, code: 'unknown_file' };
    }
    const found = await this.transmission.offerFor(viewer, f.offer_id, true);
    if (!found.ok) return found as Refusal | Problem;
    // L'identité est une donnée de l'acquéreur : il faut voir sa fiche en entier, lecture écrite au journal [R16].
    const buyer = await this.acces.readFiche(viewer, f.buyer_person_id);
    if (!buyer.ok) return buyer as Refusal;
    if (buyer.view !== 'full') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `person:${f.buyer_person_id}`, data: { rule: 'R16', role: String(viewer.role), kind: 'sale_file', code: 'not_assigned' } }, this.now);
      return { ok: false, rule: 'R16', code: 'not_assigned' };
    }
    const seen = await this.controles.identitySeenAt(viewer.networkId, f.buyer_person_id, this.now());
    if (seen === null) {
      await appendEvent(this.journal, { type: 'dossier.bloque', actor: this.actor(viewer), subject: `sale_file:${fileId}`, data: { rule: 'R58', code: 'identity_missing' } }, this.now);
      return { ok: false, rule: 'R58', code: 'identity_missing' };
    }
    const { changes } = await this.db.run("INSERT INTO sale_file_steps (file_id, step, at, by) VALUES (?, 'compromis_en_preparation', ?, ?) ON CONFLICT DO NOTHING", [fileId, this.now().toISOString(), this.actor(viewer)]);
    if (changes !== 1) return { ok: false, rule: null, code: 'already_started' };
    await appendEvent(this.journal, { type: 'dossier.compromis_en_preparation', actor: this.actor(viewer), subject: `sale_file:${fileId}`, data: { rule: 'R58' } }, this.now);
    return { ok: true, value: (await this.read(fileId))! };
  }
}
