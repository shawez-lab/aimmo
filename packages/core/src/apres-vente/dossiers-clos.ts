/**
 * Les dossiers clos et les biens vendus, lus dans la base de M10 (N06) pour l'après-vente (M11, F07).
 *
 * `SqlDossiersClos` rapporte les dossiers dont l'acte est signé (`sale_file_closings`) : le jour de l'acte, l'agent à
 * qui la commission est due, la commune et la référence d'agence du bien, jamais son adresse [R19], et les clients du
 * dossier : le vendeur du mandat en vigueur au compromis, puis l'acquéreur du dossier.
 *
 * `SqlBiensVendus` rapporte ce que le carnet du propriétaire (F06) peut dire du bien vendu : type, surface, code
 * postal, diagnostic énergétique de la dernière fiche du bien rangée au plus tard le jour de la clôture ; jamais une
 * adresse ni une position [R09]. Décidé, lecture prudente : un logement est un appartement s'il est un lot de
 * copropriété, une maison s'il ne l'est pas ; si la fiche ne le dit pas, le type est inconnu et le carnet ne se fait
 * pas, plutôt que d'en deviner un [R10]. AIMMO ne range pas la position du bien : avec un géocodeur (la Base adresse
 * nationale), la position est celle du centre de la commune, cherchée par son code postal et son nom, jamais par une
 * adresse ; sans géocodeur ou sans réponse, elle reste inconnue et la valeur est « non communiquée ».
 */
import type { SqlDatabase } from '../db/sql.ts';
import type { Geocoder } from '../estimation/collecte.ts';
import type { EnergyClass } from '../estimation/fourchette.ts';
import type { BiensVendus, SoldPropertyFacts } from './carnet.ts';
import type { ClosedSale, ClosedSaleClient, DossiersClos } from './demandes-avis.ts';

interface ClosedRow {
  file_id: string;
  signed_on: string;
  agent_id: string | null;
  city: string | null;
  reference: string;
  buyer_person_id: string;
  seller_person_id: string | null;
}

const CLOSED_SQL = `SELECT c.file_id, c.signed_on, COALESCE(k.agent_id, p.agent_id) AS agent_id, p.city, p.reference, f.buyer_person_id, v.person_id AS seller_person_id
  FROM sale_file_closings c
  JOIN sale_files f ON f.id = c.file_id
  JOIN properties p ON p.id = f.property_id
  LEFT JOIN sale_commissions k ON k.file_id = c.file_id
  LEFT JOIN sale_file_sellers v ON v.file_id = c.file_id`;

function toSale(r: ClosedRow): ClosedSale | null {
  if (!r.agent_id) return null;
  const clients: ClosedSaleClient[] = [];
  if (r.seller_person_id) clients.push({ personId: r.seller_person_id, side: 'vendeur' });
  if (r.buyer_person_id !== r.seller_person_id) clients.push({ personId: r.buyer_person_id, side: 'acquereur' });
  return { fileId: r.file_id, agentId: r.agent_id, closedOn: r.signed_on, city: r.city, reference: r.reference, clients };
}

export class SqlDossiersClos implements DossiersClos {
  constructor(private readonly db: SqlDatabase) {}

  async closedBetween(networkId: string, fromDay: string, toDay: string): Promise<readonly ClosedSale[]> {
    const rows = await this.db.all<ClosedRow>(`${CLOSED_SQL} WHERE c.network_id = ? AND c.signed_on >= ? AND c.signed_on <= ? ORDER BY c.signed_on, c.file_id`, [networkId, fromDay, toDay]);
    return rows.map(toSale).filter((s): s is ClosedSale => s !== null);
  }

  async byId(networkId: string, fileId: string): Promise<ClosedSale | null> {
    const row = await this.db.first<ClosedRow>(`${CLOSED_SQL} WHERE c.network_id = ? AND c.file_id = ?`, [networkId, fileId]);
    return row ? toSale(row) : null;
  }
}

const ENERGY: readonly string[] = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];

export class SqlBiensVendus implements BiensVendus {
  private readonly geocoder: Geocoder | null;

  constructor(
    private readonly db: SqlDatabase,
    options: { geocoder?: Geocoder | null } = {},
  ) {
    this.geocoder = options.geocoder ?? null;
  }

  /** Le centre de la commune, jamais une adresse [R09] ; `null` sans géocodeur, sans commune ou en cas de panne. */
  private async centre(postalCode: string | null, city: string | null): Promise<{ lat: number; lon: number } | null> {
    if (!this.geocoder || !postalCode || !city) return null;
    try {
      const g = await this.geocoder.geocode(`${postalCode} ${city}`);
      return g && g.postalCode === postalCode ? { lat: g.lat, lon: g.lon } : null;
    } catch {
      return null;
    }
  }

  async factsOf(networkId: string, fileId: string): Promise<SoldPropertyFacts | null> {
    const p = await this.db.first<{ property_id: string; kind: string; surface_m2: number | null; postal_code: string | null; city: string | null; closed_at: string }>(
      `SELECT f.property_id, p.kind, p.surface_m2, p.postal_code, p.city, c.at AS closed_at
       FROM sale_file_closings c JOIN sale_files f ON f.id = c.file_id JOIN properties p ON p.id = f.property_id
       WHERE c.network_id = ? AND c.file_id = ?`,
      [networkId, fileId],
    );
    if (!p) return null;
    const sheet = await this.db.first<{ data: string }>('SELECT data FROM property_sheets WHERE property_id = ? AND created_at <= ? ORDER BY version DESC LIMIT 1', [p.property_id, p.closed_at]);
    let data: { coownership?: { isCoownership?: unknown } | null; energy?: { energyClass?: unknown; diagnosedOn?: unknown } | null } = {};
    try {
      data = sheet ? (JSON.parse(sheet.data) as typeof data) : {};
    } catch {
      data = {};
    }
    let kind: SoldPropertyFacts['kind'];
    if (p.kind === 'home') {
      const co = data.coownership?.isCoownership;
      if (co === true) kind = 'apartment';
      else if (co === false) kind = 'house';
      else return null;
    } else {
      kind = p.kind as SoldPropertyFacts['kind'];
    }
    const e = data.energy;
    const energy =
      e && typeof e.energyClass === 'string' && ENERGY.includes(e.energyClass) && typeof e.diagnosedOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.diagnosedOn)
        ? { energyClass: e.energyClass as EnergyClass, diagnosedOn: e.diagnosedOn }
        : null;
    const at = await this.centre(p.postal_code, p.city);
    return { kind, surface: p.surface_m2, lat: at?.lat ?? null, lon: at?.lon ?? null, postalCode: p.postal_code, energy };
  }
}
