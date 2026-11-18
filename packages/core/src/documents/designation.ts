/**
 * La désignation du bien et le domicile du mandant, en champs (M06, AU002) [R40, R16, R13, R19].
 *
 * Un mandat de vente dit où est le bien, ce qu'il est au cadastre et où demeure chaque mandant. Ces faits sont saisis
 * une fois, en champs vérifiés, et le mandat généré les reprend depuis la base : jamais un texte libre recopié, jamais
 * une valeur inventée. Chaque saisie ajoute une ligne, la plus récente vaut ; rien ne s'efface.
 * - Le bien : son adresse (voie, code postal, commune) et ses parcelles (préfixe, section, numéro). L'agent du bien ou la
 *   direction, qui voient le bien en entier.
 * - Le mandant : son domicile (voie, code postal, commune, pays s'il n'est pas en France). Qui voit sa fiche en entier.
 * Au journal : des identifiants et des nombres, jamais une adresse ni une parcelle [R13]. Aucun message à un client ne
 * reprend ces champs [R19] : ils ne servent qu'aux documents signés par le mandant.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

export interface PostalAddress {
  street: string;
  postalCode: string;
  city: string;
  /** Pour un domicile hors de France seulement. */
  country?: string | null;
}

export interface CadastralParcel {
  /** Le préfixe de la commune absorbée, trois chiffres, s'il y en a un. */
  prefix: string | null;
  section: string;
  number: string;
}

export interface PropertyDesignation {
  address: PostalAddress;
  parcels: CadastralParcel[];
  setAt: string;
}

/** Les champs de désignation qu'un mandat de vente doit porter, remplis, pour être « complet » [R40]. */
export const MANDATE_DESIGNATION_FIELDS = ['bien.adresse', 'bien.cadastre', 'mandant.domicile'] as const;
/** Au plus vingt parcelles pour un bien. */
export const MAX_PARCELS = 20;

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem = { ok: false; rule: null; code: 'bad_address' | 'bad_parcels' };

// Ni caractère de commande ni balise : le texte entre tel quel dans un document, échappé.
const CLEAN = /^[^\u0000-\u001f\u007f<>{}]+$/u;
const text = (raw: unknown, min: number, max: number): string | null => {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().replace(/\s+/g, ' ');
  return v.length >= min && v.length <= max && CLEAN.test(v) ? v : null;
};

/**
 * Une adresse saisie, vérifiée ; null si un champ manque ou est mal formé. En France, le code postal a cinq chiffres ;
 * `abroad` admet un domicile à l'étranger, avec son pays.
 */
export function readAddress(raw: unknown, options: { abroad?: boolean } = {}): PostalAddress | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const allowed = options.abroad ? ['street', 'postalCode', 'city', 'country'] : ['street', 'postalCode', 'city'];
  if (Object.keys(r).some((k) => !allowed.includes(k))) return null;
  const street = text(r.street, 3, 200);
  const city = text(r.city, 1, 100);
  const country = r.country === undefined || r.country === null ? null : text(r.country, 2, 60);
  if (r.country !== undefined && r.country !== null && country === null) return null;
  const france = country === null || /^france$/i.test(country);
  const postalCode = typeof r.postalCode === 'string' ? r.postalCode.trim() : null;
  if (!street || !city || !postalCode) return null;
  if (france ? !/^\d{5}$/.test(postalCode) : !/^[A-Za-z0-9 -]{2,12}$/.test(postalCode)) return null;
  return { street, postalCode, city, ...(options.abroad ? { country: france ? null : country } : {}) };
}

/** Les parcelles saisies, vérifiées : une à vingt, chacune une seule fois ; null sinon. */
export function readParcels(raw: unknown): CadastralParcel[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_PARCELS) return null;
  const out: CadastralParcel[] = [];
  const seen = new Set<string>();
  for (const p of raw) {
    if (p === null || typeof p !== 'object' || Array.isArray(p)) return null;
    const r = p as Record<string, unknown>;
    if (Object.keys(r).some((k) => !['prefix', 'section', 'number'].includes(k))) return null;
    const prefix = r.prefix === undefined || r.prefix === null || r.prefix === '' ? null : r.prefix;
    if (prefix !== null && (typeof prefix !== 'string' || !/^\d{3}$/.test(prefix))) return null;
    // La section : une ou deux lettres (ou un chiffre puis une lettre) ; le numéro : un à quatre chiffres.
    const section = typeof r.section === 'string' ? r.section.trim().toUpperCase() : '';
    const number = typeof r.number === 'string' ? r.number.trim().replace(/^0+(?=\d)/, '') : typeof r.number === 'number' && Number.isInteger(r.number) ? String(r.number) : '';
    if (!/^(?:[A-Z]{1,2}|0[A-Z])$/.test(section) || !/^\d{1,4}$/.test(number) || number === '0') return null;
    const key = `${prefix ?? ''}|${section}|${number}`;
    if (seen.has(key)) return null;
    seen.add(key);
    out.push({ prefix: prefix as string | null, section, number });
  }
  return out;
}

export const formatAddress = (a: PostalAddress): string => `${a.street}, ${a.postalCode} ${a.city}${a.country ? `, ${a.country}` : ''}`;
export const formatParcels = (parcels: readonly CadastralParcel[]): string =>
  parcels.map((p) => `${p.prefix ? `préfixe ${p.prefix}, ` : ''}section ${p.section} n° ${p.number}`).join(' ; ');

/** La désignation la plus récente d'un bien, ou null. Sans contrôle des droits : à l'appelant de les avoir vérifiés. */
export async function latestDesignation(db: SqlDatabase, networkId: string, propertyId: string): Promise<PropertyDesignation | null> {
  const row = await db.first<{ street: string; postal_code: string; city: string; parcels: string; set_at: string }>(
    'SELECT street, postal_code, city, parcels, set_at FROM property_designations WHERE network_id = ? AND property_id = ? ORDER BY set_at DESC, rowid DESC LIMIT 1',
    [networkId, propertyId],
  );
  if (!row) return null;
  let parcels: CadastralParcel[] | null = null;
  try {
    parcels = readParcels(JSON.parse(row.parcels));
  } catch {
    parcels = null;
  }
  return parcels ? { address: { street: row.street, postalCode: row.postal_code, city: row.city }, parcels, setAt: row.set_at } : null;
}

/**
 * Le domicile le plus récent d'un mandant, cherché sur toutes les fiches réunies en la sienne, ou null. Sans contrôle des
 * droits : à l'appelant d'avoir lu la fiche en entier.
 */
export async function latestDomicile(db: SqlDatabase, networkId: string, personIds: readonly string[]): Promise<PostalAddress | null> {
  if (personIds.length === 0) return null;
  const row = await db.first<{ street: string; postal_code: string; city: string; country: string | null }>(
    `SELECT street, postal_code, city, country FROM person_domiciles WHERE network_id = ? AND person_id IN (${personIds.map(() => '?').join(', ')})
     ORDER BY set_at DESC, rowid DESC LIMIT 1`,
    [networkId, ...personIds],
  );
  return row ? { street: row.street, postalCode: row.postal_code, city: row.city, country: row.country } : null;
}

export class Designations {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, kind: string, code: string, subject: string): Promise<Refusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind, code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  /** L'adresse et les parcelles d'un bien : son agent ou la direction, qui le voient en entier [R16]. */
  async setProperty(viewer: Viewer, propertyId: string, input: { address: unknown; parcels: unknown }): Promise<{ ok: true; value: PropertyDesignation } | Refusal | Problem> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refuse(viewer, 'designation', 'role', `property:${propertyId}`);
    const seen = await this.acces.readProperty(viewer, propertyId);
    if (!seen.ok) return seen;
    if (seen.view !== 'full') return this.refuse(viewer, 'designation', 'not_assigned', `property:${propertyId}`);
    const address = readAddress(input.address);
    if (!address) return { ok: false, rule: null, code: 'bad_address' };
    const parcels = readParcels(input.parcels);
    if (!parcels) return { ok: false, rule: null, code: 'bad_parcels' };
    const at = this.now().toISOString();
    await this.db.run(
      'INSERT INTO property_designations (id, network_id, property_id, street, postal_code, city, parcels, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [this.newId(), viewer.networkId, propertyId, address.street, address.postalCode, address.city, JSON.stringify(parcels), this.actor(viewer), at],
    );
    await appendEvent(this.journal, { type: 'bien.designation', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { parcels: parcels.length } }, this.now);
    return { ok: true, value: { address, parcels, setAt: at } };
  }

  /** Le domicile d'un mandant : son agent ou la direction, qui voient la fiche en entier [R16]. */
  async setDomicile(viewer: Viewer, personId: string, input: unknown): Promise<{ ok: true; value: PostalAddress } | Refusal | Problem> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refuse(viewer, 'domicile', 'role', `person:${personId}`);
    const read = await this.acces.readFiche(viewer, personId);
    if (!read.ok) return read;
    if (read.view !== 'full') return this.refuse(viewer, 'domicile', 'not_assigned', `person:${personId}`);
    const address = readAddress(input, { abroad: true });
    if (!address) return { ok: false, rule: null, code: 'bad_address' };
    const at = this.now().toISOString();
    await this.db.run(
      'INSERT INTO person_domiciles (id, network_id, person_id, street, postal_code, city, country, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [this.newId(), viewer.networkId, read.value.person.id, address.street, address.postalCode, address.city, address.country ?? null, this.actor(viewer), at],
    );
    await appendEvent(this.journal, { type: 'fiche.domicile', actor: this.actor(viewer), subject: `person:${read.value.person.id}`, data: {} }, this.now);
    return { ok: true, value: address };
  }
}
