/**
 * Le dossier figé (M12, L05) [R94] : son périmètre (mandats, offres, dossiers de vente et toutes leurs parties, fiches
 * réunies et bénéficiaires effectifs compris) et sa copie ligne par ligne, par empreinte. Partagé par le signalement au
 * responsable (L05) et le contrôle du gel des avoirs (HX57) ; ce fichier ne lit aucune de leurs tables.
 */
import type { SqlDatabase, SqlValue } from '../db/sql.ts';
import type { FicheUnique } from '../fiche/fusion.ts';

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
};

/** La copie figée : pour chaque table du dossier, chaque ligne par sa clé et son empreinte. */
export type CaseSnapshot = Record<string, { key: string; sha256: string }[]>;

export interface FrozenCheck {
  intact: boolean;
  /** Les lignes changées ou disparues depuis la copie, par table et par clé. */
  changed: { table: string; key: string }[];
  missing: { table: string; key: string }[];
  /** Les lignes ajoutées depuis, qui ne changent pas la copie figée. */
  added: { table: string; key: string }[];
}

/** Ce que couvre un dossier : ses mandats, ses offres, ses dossiers de vente et toutes ses parties. */
export interface CaseScope {
  mandates: string[];
  offers: string[];
  saleFiles: string[];
  persons: string[];
  caseRefs: string[];
}

/** Une partie du dossier : la requête rend chaque ligne, sa clé est la colonne `k`. */
interface Part {
  table: string;
  over: keyof CaseScope;
  sql: (marks: string) => string;
}

const PARTS: Part[] = [
  { table: 'mandates', over: 'mandates', sql: (q) => `SELECT id AS k, * FROM mandates WHERE id IN (${q})` },
  { table: 'mandate_register', over: 'mandates', sql: (q) => `SELECT seq AS k, * FROM mandate_register WHERE mandate_id IN (${q})` },
  { table: 'documents', over: 'mandates', sql: (q) => `SELECT id AS k, * FROM documents WHERE mandate_id IN (${q}) OR id IN (SELECT document_id FROM signed_documents WHERE mandate_id IN (${q}))` },
  { table: 'signed_documents', over: 'mandates', sql: (q) => `SELECT document_id AS k, * FROM signed_documents WHERE mandate_id IN (${q})` },
  { table: 'signed_amendments', over: 'mandates', sql: (q) => `SELECT document_id AS k, * FROM signed_amendments WHERE mandate_id IN (${q})` },
  { table: 'mandate_withdrawals', over: 'mandates', sql: (q) => `SELECT mandate_id AS k, * FROM mandate_withdrawals WHERE mandate_id IN (${q})` },
  { table: 'mandate_early_starts', over: 'mandates', sql: (q) => `SELECT mandate_id AS k, * FROM mandate_early_starts WHERE mandate_id IN (${q})` },
  { table: 'offer_register', over: 'offers', sql: (q) => `SELECT id AS k, * FROM offer_register WHERE id IN (${q})` },
  { table: 'offer_checks', over: 'offers', sql: (q) => `SELECT id AS k, * FROM offer_checks WHERE offer_id IN (${q})` },
  { table: 'offer_transmissions', over: 'offers', sql: (q) => `SELECT offer_id || ':' || at AS k, * FROM offer_transmissions WHERE offer_id IN (${q})` },
  { table: 'offer_responses', over: 'offers', sql: (q) => `SELECT offer_id AS k, * FROM offer_responses WHERE offer_id IN (${q})` },
  { table: 'offer_proposals', over: 'offers', sql: (q) => `SELECT id AS k, * FROM offer_proposals WHERE offer_id IN (${q})` },
  { table: 'sale_files', over: 'saleFiles', sql: (q) => `SELECT id AS k, * FROM sale_files WHERE id IN (${q})` },
  { table: 'sale_file_steps', over: 'saleFiles', sql: (q) => `SELECT file_id || ':' || step || ':' || at AS k, * FROM sale_file_steps WHERE file_id IN (${q})` },
  { table: 'sale_file_pieces', over: 'saleFiles', sql: (q) => `SELECT id AS k, * FROM sale_file_pieces WHERE file_id IN (${q})` },
  { table: 'sale_file_dates', over: 'saleFiles', sql: (q) => `SELECT file_id || ':' || kind || ':' || version AS k, * FROM sale_file_dates WHERE file_id IN (${q})` },
  { table: 'sale_file_conditions', over: 'saleFiles', sql: (q) => `SELECT file_id || ':' || kind || ':' || version AS k, * FROM sale_file_conditions WHERE file_id IN (${q})` },
  { table: 'sale_file_buyer_notices', over: 'saleFiles', sql: (q) => `SELECT file_id || ':' || person_id || ':' || version AS k, * FROM sale_file_buyer_notices WHERE file_id IN (${q})` },
  { table: 'sale_file_financing', over: 'saleFiles', sql: (q) => `SELECT file_id || ':' || seq AS k, * FROM sale_file_financing WHERE file_id IN (${q})` },
  { table: 'sale_file_closings', over: 'saleFiles', sql: (q) => `SELECT file_id AS k, * FROM sale_file_closings WHERE file_id IN (${q})` },
  { table: 'sale_file_stops', over: 'saleFiles', sql: (q) => `SELECT file_id AS k, * FROM sale_file_stops WHERE file_id IN (${q})` },
  // La conformité de chaque partie : coffre, identification, bénéficiaires effectifs, risque, vigilance.
  { table: 'compliance_vault_pieces', over: 'persons', sql: (q) => `SELECT id AS k, * FROM compliance_vault_pieces WHERE person_id IN (${q})` },
  { table: 'identity_checks', over: 'persons', sql: (q) => `SELECT id AS k, * FROM identity_checks WHERE person_id IN (${q})` },
  { table: 'client_identifications', over: 'persons', sql: (q) => `SELECT id AS k, * FROM client_identifications WHERE person_id IN (${q})` },
  {
    table: 'beneficial_owners',
    over: 'persons',
    sql: (q) => `SELECT declaration_id || ':' || owner_person_id AS k, * FROM beneficial_owners WHERE declaration_id IN (SELECT id FROM client_identifications WHERE person_id IN (${q}))`,
  },
  { table: 'risk_sheets', over: 'persons', sql: (q) => `SELECT id AS k, * FROM risk_sheets WHERE person_id IN (${q})` },
  { table: 'risk_validations', over: 'persons', sql: (q) => `SELECT id AS k, * FROM risk_validations WHERE sheet_id IN (SELECT id FROM risk_sheets WHERE person_id IN (${q}))` },
  { table: 'vigilance_alerts', over: 'persons', sql: (q) => `SELECT id AS k, * FROM vigilance_alerts WHERE person_id IN (${q})` },
  { table: 'vigilance_decisions', over: 'persons', sql: (q) => `SELECT id AS k, * FROM vigilance_decisions WHERE alert_id IN (SELECT id FROM vigilance_alerts WHERE person_id IN (${q}))` },
];

/** D1 refuse plus de 100 valeurs liées par requête : les listes sont lues par lots. */
const D1_MAX_PARAMS = 100;
const chunks = <T>(values: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
};

export const unique = (values: (string | null | undefined)[]): string[] => [...new Set(values.filter((v): v is string => typeof v === 'string'))].sort();

/**
 * Le dossier et toutes ses parties : l'acquéreur, et le vendeur de chaque mandat du bien ; pour un mandat, les offres du
 * bien et leurs acquéreurs ; pour une offre, ses dossiers de vente, avec `withSale` (RC36 : le signalement fige la vente
 * qui en découle ; le gel des avoirs contrôle chaque offre et chaque dossier de vente comme un dossier à part). `null` s'il
 * est inconnu.
 */
export async function caseScopeOf(
  db: SqlDatabase,
  fiches: FicheUnique,
  networkId: string,
  kind: 'mandate' | 'offer' | 'sale_file',
  id: string,
  options: { withSale?: boolean } = {},
): Promise<{ personId: string; scope: CaseScope } | null> {
  const scope: CaseScope = { mandates: [], offers: [], saleFiles: [], persons: [], caseRefs: [] };
  let personId: string;
  if (kind === 'mandate') {
    const row = await db.first<{ network_id: string; person_id: string; property_id: string | null }>('SELECT network_id, person_id, property_id FROM mandates WHERE id = ?', [id]);
    if (!row || row.network_id !== networkId) return null;
    personId = row.person_id;
    scope.mandates = [id];
    // La vente qui en découle (RC36) : les offres reçues sur le même bien, leurs dossiers de vente et leurs acquéreurs.
    if (options.withSale && row.property_id) {
      const offers = await db.all<{ id: string; buyer_person_id: string; co_buyers: string | null }>('SELECT id, buyer_person_id, co_buyers FROM offer_register WHERE network_id = ? AND property_id = ?', [networkId, row.property_id]);
      scope.offers = unique(offers.map((o) => o.id));
      // Chaque acquéreur, coacquéreurs compris (AU009).
      scope.persons = unique(offers.flatMap((o) => [o.buyer_person_id, ...(JSON.parse(o.co_buyers ?? '[]') as string[])]));
    }
  } else {
    let offerId = id;
    if (kind === 'sale_file') {
      const file = await db.first<{ network_id: string; offer_id: string }>('SELECT network_id, offer_id FROM sale_files WHERE id = ?', [id]);
      if (!file || file.network_id !== networkId) return null;
      scope.saleFiles = [id];
      offerId = file.offer_id;
    }
    const offer = await db.first<{ network_id: string; buyer_person_id: string; property_id: string; co_buyers: string | null }>('SELECT network_id, buyer_person_id, property_id, co_buyers FROM offer_register WHERE id = ?', [offerId]);
    if (!offer || offer.network_id !== networkId) return null;
    personId = offer.buyer_person_id;
    scope.offers = [offerId];
    const mandates = await db.all<{ id: string; person_id: string }>('SELECT id, person_id FROM mandates WHERE network_id = ? AND property_id = ?', [networkId, offer.property_id]);
    scope.mandates = unique(mandates.map((m) => m.id));
    // Les mandants, et les coacquéreurs de l'offre, chacun partie du dossier (AU009).
    scope.persons = unique([...mandates.map((m) => m.person_id), ...(JSON.parse(offer.co_buyers ?? '[]') as string[])]);
  }
  // Les dossiers de vente ouverts depuis chaque offre du périmètre (RC36) : une offre signalée fige aussi sa vente.
  if (options.withSale && scope.offers.length > 0) {
    const files: string[] = [];
    for (const part of chunks(scope.offers, D1_MAX_PARAMS - 1)) {
      const rows = await db.all<{ id: string }>(`SELECT id FROM sale_files WHERE network_id = ? AND offer_id IN (${part.map(() => '?').join(', ')})`, [networkId, ...part]);
      files.push(...rows.map((f) => f.id));
    }
    scope.saleFiles = unique([...scope.saleFiles, ...files]);
  }
  // Chaque partie avec ses fiches réunies (S04), puis les bénéficiaires effectifs d'une société, avec les leurs : leur
  // identité fait partie de l'identification du client.
  let persons = unique([personId, ...scope.persons]);
  for (let round = 0; round < 10; round++) {
    const members: string[] = [];
    for (const p of persons) members.push(...(await fiches.membersOf(p)));
    const owners: { owner_person_id: string }[] = [];
    for (const part of chunks(unique(members), D1_MAX_PARAMS)) {
      owners.push(...(await db.all<{ owner_person_id: string }>(
        `SELECT owner_person_id FROM beneficial_owners WHERE declaration_id IN (SELECT id FROM client_identifications WHERE person_id IN (${part.map(() => '?').join(', ')}))`,
        part,
      )));
    }
    const next = unique([...persons, ...members, ...owners.map((o) => o.owner_person_id)]);
    if (next.length === persons.length) break;
    persons = next;
  }
  scope.persons = persons;
  scope.caseRefs = unique([...scope.mandates.map((m) => `mandate:${m}`), ...scope.offers.map((o) => `offer:${o}`), ...scope.saleFiles.map((f) => `sale_file:${f}`)]);
  return { personId, scope };
}

/** La copie du dossier, ligne par ligne, par empreinte. */
export async function caseSnapshotOf(db: SqlDatabase, scope: CaseScope): Promise<CaseSnapshot> {
  const snapshot: CaseSnapshot = {};
  for (const part of PARTS) {
    const ids = scope[part.over];
    const lines: { key: string; sha256: string }[] = [];
    // Combien de fois la requête lie la liste (une partie la lie deux fois), pour tenir sous la limite de D1.
    const repeats = (part.sql('?').match(/\?/g) ?? []).length;
    const seen = new Set<string>();
    for (const batch of chunks(ids, Math.floor(D1_MAX_PARAMS / repeats))) {
      const sql = part.sql(batch.map(() => '?').join(', '));
      const params: SqlValue[] = [];
      for (let i = 0; i < repeats; i++) params.push(...batch);
      for (const row of await db.all<Record<string, unknown> & { k: unknown }>(sql, params)) {
        const { k, ...rest } = row;
        // Une ligne liée à deux lots (une pièce de deux mandats) n'est comptée qu'une fois.
        if (seen.has(String(k))) continue;
        seen.add(String(k));
        lines.push({ key: String(k), sha256: await sha256Hex(JSON.stringify(canonical(rest))) });
      }
    }
    lines.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
    snapshot[part.table] = lines;
  }
  return snapshot;
}

/** Compare la copie figée à celle d'aujourd'hui, refaite sur le même périmètre. */
export function compareSnapshots(then: CaseSnapshot, nowSnap: CaseSnapshot): FrozenCheck {
  const out: FrozenCheck = { intact: true, changed: [], missing: [], added: [] };
  for (const table of Object.keys(then)) {
    const current = new Map((nowSnap[table] ?? []).map((l) => [l.key, l.sha256]));
    for (const line of then[table]!) {
      const sha = current.get(line.key);
      if (sha === undefined) out.missing.push({ table, key: line.key });
      else if (sha !== line.sha256) out.changed.push({ table, key: line.key });
    }
    const before = new Set(then[table]!.map((l) => l.key));
    for (const line of nowSnap[table] ?? []) if (!before.has(line.key)) out.added.push({ table, key: line.key });
  }
  out.intact = out.changed.length === 0 && out.missing.length === 0;
  return out;
}
