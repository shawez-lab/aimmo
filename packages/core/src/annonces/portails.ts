/**
 * Export au format des portails, en mode essai (M07, P07) [R43, R44, R46].
 *
 * Le flux d'un portail est rempli depuis la dernière version publiée de chaque bien (P04), jamais depuis un brouillon :
 * il porte donc le même prix et les mêmes mentions que les autres canaux. Un bien retiré ou vendu sort du flux au
 * passage suivant. Le flux ne porte ni adresse, ni nom, ni coordonnée du vendeur : la version publiée n'en a pas.
 *
 * Chaque portail a son format derrière une interface ; seul le format d'essai, décrit dans `docs/PORTAILS.md`, existe
 * tant que les comptes et accords de flux (H10) ne sont pas là. Pendant la preuve à Dijon, les portails sont servis par
 * le logiciel de l'agence. Le flux est déterministe : une même version donne le même flux, au caractère près.
 */
import type { SqlDatabase } from '../db/sql.ts';
import type { ListingDpe, ListingPayload } from './publication.ts';

export interface PortalFormat {
  readonly name: string;
  readonly contentType: string;
  render(listings: readonly ListingPayload[]): string;
}

const xml = (s: string): string =>
  s
    // Seuls les caractères permis en XML 1.0 passent.
    .replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/**
 * AU064 · le diagnostic repris tel quel, pour les portails français et étrangers : numéro ADEME, valeurs et classes,
 * jour du diagnostic ; seuls les attributs connus ; rien sans numéro ni valeurs.
 */
export function dpeXml(d: ListingDpe | undefined): string {
  if (!d) return '';
  return `<dpe${d.ademeNumber ? ` numero="${xml(d.ademeNumber)}"` : ''}${d.primaryEnergyKwhM2 !== null ? ` energie_primaire="${d.primaryEnergyKwhM2}"` : ''}${d.ghgKgM2 !== null ? ` ges="${d.ghgKgM2}"` : ''} classe_energie="${xml(d.energyClass)}" classe_climat="${xml(d.climateClass)}" date="${xml(d.diagnosedOn)}"/>`;
}

/** AU063 · les surfaces que les portails reçoivent, chacune nommée, en m² au centième, avec sa source quand elle est dite. */
export function surfacesXml(list: ListingPayload['surfaces']): string {
  if (!list || list.length === 0) return '';
  return `<surfaces>${list.map((x) => `<surface type="${xml(x.kind)}" m2="${x.m2}"${x.source ? ` source="${xml(x.source)}"` : ''}/>`).join('')}</surfaces>`;
}

/** Le format d'essai AIMMO, décrit dans `docs/PORTAILS.md`. */
export const TRIAL_FORMAT: PortalFormat = {
  name: 'aimmo-essai-1',
  contentType: 'application/xml; charset=utf-8',
  render(listings) {
    const items = listings.map((l) => {
      const media = l.media
        .map((m) => `<media type="${xml(m.kind)}" ref="${xml(m.ref)}"${m.overlay ? ` mention="${xml(m.overlay)}"` : ''}/>`)
        .join('');
      return (
        `<annonce reference="${xml(l.reference)}" version="${l.version}" etat="${xml(l.state)}">` +
        `<prix devise="EUR">${l.priceEur ?? ''}</prix>` +
        `<titre>${xml(l.title ?? '')}</titre>` +
        `<texte>${xml(l.body ?? '')}</texte>` +
        `<mentions>${xml(l.mentions ?? '')}</mentions>` +
        dpeXml(l.dpe) +
        surfacesXml(l.surfaces) +
        `<medias>${media}</medias>` +
        `</annonce>`
      );
    });
    return `<?xml version="1.0" encoding="UTF-8"?>\n<flux format="aimmo-essai-1">${items.join('')}</flux>\n`;
  },
};

/** États montrés aux portails : un bien vendu ou retiré sort du flux. */
const ON_PORTALS = new Set(['en_vente', 'sous_offre']);

export class ExportPortails {
  constructor(private readonly db: SqlDatabase) {}

  /** Les annonces du flux : la dernière version publiée de chaque bien du réseau, encore en vente ou sous offre. */
  async listings(networkId: string): Promise<ListingPayload[]> {
    const rows = await this.db.all<{ seq: number; payload: string }>(
      `SELECT v.seq, v.payload FROM listing_versions v
       WHERE v.network_id = ? AND v.seq = (SELECT MAX(seq) FROM listing_versions w WHERE w.property_id = v.property_id)`,
      [networkId],
    );
    return rows
      .map((r) => ({ ...(JSON.parse(r.payload) as Omit<ListingPayload, 'version'>), version: Number(r.seq) }))
      .filter((l) => ON_PORTALS.has(l.state) && l.priceEur !== null && l.mentions !== null)
      .sort((a, b) => (a.reference < b.reference ? -1 : a.reference > b.reference ? 1 : 0));
  }

  async feed(networkId: string, format: PortalFormat = TRIAL_FORMAT): Promise<{ contentType: string; body: string }> {
    return { contentType: format.contentType, body: format.render(await this.listings(networkId)) };
  }
}
