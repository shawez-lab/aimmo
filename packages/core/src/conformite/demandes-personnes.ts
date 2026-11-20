/**
 * Demandes des personnes en moins d'un mois, avec preuve (M12, L07) [R04, R16, R17, R96].
 *
 * Le responsable de la conformité enregistre chaque demande (accès, rectification, effacement, opposition) avec sa
 * date de réception et son canal ; le code calcule l'échéance, un mois plus tard (RGPD, article 12.3), et le
 * planificateur alerte le responsable 7 jours avant, puis le jour même, une seule fois chacune, tant que la réponse
 * n'est pas donnée.
 *
 * - Accès : la réponse est assemblée par le code depuis chaque table du registre, en suivant la carte des demandes
 *   d'accès (`carte-acces.ts`), pour toutes les fiches réunies de la personne (S04) et rien d'une autre. Chaque table
 *   vient avec la finalité, la base légale, la durée et les destinataires de son traitement (article 15). La réponse a
 *   son empreinte ; la base ne garde que l'empreinte, jamais une copie.
 * - Rectification : la demande dit le jour où la direction a corrigé le nom « à la demande de la personne » sur l'une
 *   de ses fiches réunies, le jour de la réception ou après (SV10), et la réponse notée garde ces corrections dans son
 *   empreinte. La demande n'est pas close seule : une rectification peut porter sur autre chose qu'un nom (RC35).
 * - Opposition : l'arrêt est posé aussitôt sur tous les canaux, par la même voie qu'un « stop » reçu [R04].
 * - Effacement : la procédure de M12 garde ce que la loi oblige à garder (registre des mandats et documents signés,
 *   lutte contre le blanchiment, factures, journal). Tant que le responsable et l'avocat ne l'ont pas validée (H29),
 *   elle tourne en mode essai : elle dit ce qui serait effacé et ce qui serait gardé, et n'efface rien [R17].
 *
 * Rien n'est envoyé à la personne : la réponse est préparée pour le responsable, qui note quand il l'a donnée ; la date
 * et l'empreinte de la réponse font la preuve.
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase, SqlValue } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import type { FicheUnique } from '../fiche/fusion.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { accessOrder, CARTE_ACCES, EXCLUSION_LABELS, LCB_FT_TRAITEMENT, type AccessMapEntry, type ExclusionReason, type ViaLocator } from './carte-acces.ts';
import { addCalendarMonths } from './registre-relecture.ts';
import { LEGAL_BASIS_LABELS, type LegalBasis, type Traitement } from './registre.ts';
import { REGISTRE_TRAITEMENTS } from './registre-traitements.ts';

const TIME_ZONE = 'Europe/Paris';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CHUNK = 50;

export const PERSON_REQUEST_KINDS = ['acces', 'rectification', 'effacement', 'opposition'] as const;
export type PersonRequestKind = (typeof PERSON_REQUEST_KINDS)[number];
export const PERSON_REQUEST_CHANNELS = ['mail', 'courrier', 'telephone', 'sur_place', 'message', 'formulaire'] as const;
export type PersonRequestChannel = (typeof PERSON_REQUEST_CHANNELS)[number];

/** L'échéance tombe un mois après la réception ; le rappel part 7 jours avant. */
export const PERSON_REQUEST_MONTHS = 1;
export const PERSON_REQUEST_NOTICE_DAYS = 7;
/** Tant que H29 n'est pas fait, l'effacement ne tourne qu'en essai. */
export const ERASURE_MODE = 'essai' as const;

/** Ce qui remplace une valeur masquée : la donnée d'une autre personne, ou un secret de sécurité. */
export const MASKED = '(non communiqué)';

const validDay = (v: unknown): v is string => {
  if (typeof v !== 'string' || !DAY.test(v)) return false;
  const d = new Date(`${v}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
const addDays = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}

export async function sha256Of(value: unknown): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical(value)))));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export type Row = Record<string, SqlValue>;

export interface AccessSection {
  table: string;
  traitement: string;
  finalite: string;
  baseLegale: string;
  duree: string;
  destinataires: readonly string[];
  sousTraitants: readonly string[];
  rows: Row[];
}

export interface AccessResponse {
  /** Les fiches de la personne : la fiche gardée, puis les fiches qui y sont réunies. */
  personIds: string[];
  sections: AccessSection[];
  /** Ce que la réponse ne contient pas, et pourquoi : toujours la même liste, quelle que soit la personne. */
  notIncluded: { reason: ExclusionReason; text: string }[];
}

interface Found {
  row: Row;
  /** Les colonnes directes par lesquelles la ligne a été trouvée. */
  matched: Set<string>;
  /** Les marques (`tag`) des chemins qui l'ont trouvée : elles ne rendent pas la ligne exclusive. */
  tags: Set<string>;
  /** Trouvée par une ligne qui n'est qu'à la personne. */
  viaExclusive: boolean;
  /** Une référence à une autre personne y a été masquée. */
  foreign?: boolean;
}

export interface AccessDetail {
  response: AccessResponse;
  /** Par table, le nombre de lignes qui ne sont qu'à la personne : ni partagées avec une autre, ni en partie masquées. */
  exclusiveRows: Record<string, number>;
  /** Ces lignes mêmes, telles que la base les garde, pour l'effacement réel (AU020). Jamais rendues à la personne. */
  exclusiveData?: Record<string, Readonly<Record<string, SqlValue>>[]>;
}

/**
 * Assemble les lignes de la personne, table par table, en suivant la carte. Les lignes sont rendues dans un ordre
 * stable : la même base donne la même réponse, donc la même empreinte.
 */
/** Une ligne est-elle à plusieurs parties ? Toujours, si la table a des colonnes `shared` sans condition. */
async function sharedRow(db: SqlDatabase, entry: Extract<AccessMapEntry, { locate: unknown }>, row: Readonly<Record<string, SqlValue>>): Promise<boolean> {
  if ((entry.shared ?? []).length === 0) return false;
  if (!entry.sharedIf) return true;
  const value = row[entry.sharedIf.key];
  if (value === null || value === undefined) return false;
  return (await db.first(`SELECT 1 AS x FROM ${entry.sharedIf.from} WHERE ${entry.sharedIf.column} = ? LIMIT 1`, [value])) !== null;
}

export async function assembleAccess(
  db: SqlDatabase,
  personIds: readonly string[],
  options: { carte?: Readonly<Record<string, AccessMapEntry>>; registre?: readonly Traitement[] } = {},
): Promise<AccessResponse> {
  return (await assembleAccessDetail(db, personIds, options)).response;
}

/** La réponse d'accès, et ce qui n'est qu'à la personne, pour le plan d'effacement. */
export async function assembleAccessDetail(
  db: SqlDatabase,
  personIds: readonly string[],
  options: { carte?: Readonly<Record<string, AccessMapEntry>>; registre?: readonly Traitement[] } = {},
): Promise<AccessDetail> {
  const carte = options.carte ?? CARTE_ACCES;
  const registre = options.registre ?? REGISTRE_TRAITEMENTS;
  const ids = [...new Set(personIds)];
  const found = new Map<string, Map<string, Found>>();
  const json = new Map<string, Map<string, string>>();
  const exclusive = new Map<string, Set<string>>();
  // Les lignes à plusieurs parties de chaque table : leurs colonnes `shared` ne sont jamais montrées.
  const sharedKeys = new Map<string, Set<string>>();

  const select = async (table: string, column: string, values: readonly string[], where: Readonly<Record<string, string>>): Promise<Row[]> => {
    const rows: Row[] = [];
    const extra = Object.keys(where).sort();
    for (let i = 0; i < values.length; i += CHUNK) {
      const part = values.slice(i, i + CHUNK);
      const condition = extra.map((c) => ` AND "${c}" = ?`).join('');
      rows.push(...(await db.all<Row>(`SELECT * FROM "${table}" WHERE "${column}" IN (${placeholders(part.length)})${condition}`, [...part, ...extra.map((c) => where[c]!)])));
    }
    return rows;
  };

  // Un champ d'une colonne JSON, ou des débuts de colonnes : les lignes valables (JSON lisible) dont le champ vaut l'une
  // des valeurs. Le filtre exact est refait sur chaque ligne.
  const selectJson = async (table: string, l: ViaLocator, values: readonly string[]): Promise<Row[]> => {
    const rows: Row[] = [];
    const starts = Object.keys(l.startsWith ?? {}).sort();
    const where = Object.keys(l.where ?? {}).sort();
    const target = l.jsonPath ? `CASE WHEN json_valid("${l.column}") THEN CAST(json_extract("${l.column}", ?) AS TEXT) END` : `"${l.column}"`;
    for (let i = 0; i < values.length; i += CHUNK) {
      const part = values.slice(i, i + CHUNK);
      const condition = [...starts.map((c) => ` AND substr("${c}", 1, ?) = ?`), ...where.map((c) => ` AND "${c}" = ?`)].join('');
      rows.push(
        ...(await db.all<Row>(`SELECT * FROM "${table}" WHERE ${target} IN (${placeholders(part.length)})${condition}`, [
          ...(l.jsonPath ? [`$.${l.jsonPath}`] : []),
          ...part,
          ...starts.flatMap((c) => [l.startsWith![c]!.length, l.startsWith![c]!]),
          ...where.map((c) => l.where![c]!),
        ])),
      );
    }
    return rows;
  };

  for (const table of accessOrder(carte)) {
    const entry = carte[table]!;
    if ('excluded' in entry) continue;
    const rows = new Map<string, Found>();
    const add = (row: Row, column: string | null, viaExclusive = false, tag?: string): void => {
      const key = JSON.stringify(canonical(row));
      const known = rows.get(key) ?? { row, matched: new Set<string>(), tags: new Set<string>(), viaExclusive: false };
      if (column) known.matched.add(column);
      if (tag) known.tags.add(tag);
      if (viaExclusive) known.viaExclusive = true;
      rows.set(key, known);
    };
    for (const l of entry.locate) {
      if ('json' in l) {
        for (const id of ids) {
          const candidates = await db.all<Row>(`SELECT * FROM "${table}" WHERE "${l.json}" LIKE ?`, [`%${JSON.stringify(id)}%`]);
          for (const row of candidates) add(row, null);
        }
        continue;
      }
      if ('from' in l) {
        const parents = [...(found.get(l.from)?.entries() ?? [])].filter(([, p]) => !l.onlyMatchedBy || p.matched.has(l.onlyMatchedBy) || p.tags.has(l.onlyMatchedBy))
          .filter(([, p]) => Object.entries(l.parentWhere ?? {}).every(([c, v]) => p.row[c] === v))
          .filter(([, p]) => !l.notOnlyBy || p.matched.size > 0 || [...p.tags].some((x) => x !== l.notOnlyBy));
        const owned = exclusive.get(l.from) ?? new Set<string>();
        // Une ligne enfant vaut la clé d'une ligne trouvée, et ses autres colonnes liées valent celles de la même ligne.
        const pairs = Object.entries(l.alsoMatch ?? {}).sort();
        const tuple = (value: string, at: (c: string) => SqlValue | undefined, side: 0 | 1): string => JSON.stringify([value, ...pairs.map((p) => at(p[side]) ?? null)]);
        const parentExclusive = new Map<string, boolean>();
        for (const [key, p] of parents) {
          const v = p.row[l.key];
          if (v === null || v === undefined) continue;
          const t = tuple(`${l.prefix ?? ''}${v}`, (c) => {
            const here = pairs.find((pair) => pair[1] === c)?.[0];
            const start = here === undefined ? undefined : l.alsoMatchPrefix?.[here];
            return start === undefined || p.row[c] === null || p.row[c] === undefined ? p.row[c] : `${start}${p.row[c]}`;
          }, 1);
          parentExclusive.set(t, (parentExclusive.get(t) ?? false) || owned.has(key));
        }
        const values = [...new Set([...parentExclusive.keys()].map((t) => (JSON.parse(t) as string[])[0]!))].sort();
        const childValue = (row: Row): string => {
          if (!l.jsonPath) return String(row[l.column]);
          try {
            const v = (JSON.parse(String(row[l.column])) as Record<string, unknown>)[l.jsonPath];
            return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
          } catch {
            return '';
          }
        };
        const jsonField = (row: Row, field: string): unknown => {
          try {
            return (JSON.parse(String(row.data)) as Record<string, unknown>)[field];
          } catch {
            return undefined;
          }
        };
        const children = l.jsonPath || l.startsWith ? await selectJson(table, l, values) : await select(table, l.column, values, l.where ?? {});
        for (const row of children) {
          if (Object.entries(l.startsWith ?? {}).some(([c, start]) => !String(row[c] ?? '').startsWith(start))) continue;
          if (Object.entries(l.jsonNot ?? {}).some(([field, v]) => (typeof v === 'string' ? [v] : v).includes(jsonField(row, field) as string))) continue;
          if (Object.entries(l.jsonIs ?? {}).some(([field, v]) => jsonField(row, field) !== v)) continue;
          if (Object.entries(l.except ?? {}).some(([c, values]) => values.includes(String(row[c])))) continue;
          if (Object.entries(l.only ?? {}).some(([c, values]) => !values.includes(String(row[c])))) continue;
          const t = tuple(childValue(row), (c) => row[c], 0);
          if (parentExclusive.has(t)) add(row, null, parentExclusive.get(t)!, l.tag);
        }
        continue;
      }
      const values = ids.map((id) => `${l.prefix ?? ''}${id}`);
      for (const row of await select(table, l.column, values, l.where ?? {})) add(row, l.column);
    }
    // Un tableau JSON ne garde que les éléments de la personne ; une ligne sans aucun élément d'elle n'est pas à elle.
    for (const l of entry.locate) {
      if (!('json' in l)) continue;
      const kept = new Map<string, string>();
      for (const [key, f] of rows) {
        let items: unknown;
        try {
          items = JSON.parse(String(f.row[l.json]));
        } catch {
          items = null;
        }
        const mine = (Array.isArray(items) ? items : []).filter((item) => {
          if (!item || typeof item !== 'object') return false;
          const values = (field: string): unknown[] => {
            const v = (item as Record<string, unknown>)[field];
            return v === undefined ? [] : Array.isArray(v) ? v : [v];
          };
          // Un élément qui nomme aussi une autre fiche (fusion annulée depuis) n'est rendu à aucune des deux.
          if ((l.onlyMine ?? []).some((field) => values(field).some((x) => typeof x !== 'string' || !ids.includes(x)))) return false;
          return l.idFields.some((field) => {
            const v = (item as Record<string, unknown>)[field];
            return (typeof v === 'string' && ids.includes(v)) || (Array.isArray(v) && v.some((x) => typeof x === 'string' && ids.includes(x)));
          });
        });
        if (mine.length === 0) rows.delete(key);
        else kept.set(key, JSON.stringify(mine));
      }
      json.set(`${table}.${l.json}`, kept);
    }
    if (entry.skip) {
      const { column, prefixes, marked, markers } = entry.skip;
      for (const [key, f] of rows) {
        const prefixed = prefixes.some((p) => String(f.row[column] ?? '').startsWith(p));
        const text = marked ? String(f.row[marked] ?? '') : '';
        if (prefixed || (markers ?? []).some((m) => text.includes(JSON.stringify(m)))) rows.delete(key);
      }
    }
    // Les références à une autre fiche de personne, dans les colonnes désignées, sont masquées.
    if (entry.foreignPersons && rows.size > 0) {
      const candidates = new Set<string>();
      const strings = (value: unknown, at: (v: string) => void): void => {
        if (typeof value === 'string') at(value);
        else if (Array.isArray(value)) for (const v of value) strings(v, at);
        else if (value && typeof value === 'object') for (const v of Object.values(value)) strings(v, at);
      };
      const idOf = (v: string): string => (v.startsWith('person:') ? v.slice('person:'.length) : v);
      const parsed = new Map<string, unknown>();
      for (const [key, f] of rows) {
        for (const c of entry.foreignPersons) {
          const raw = f.row[c];
          if (typeof raw !== 'string') continue;
          let value: unknown = raw;
          try {
            value = JSON.parse(raw);
          } catch {
            value = raw;
          }
          parsed.set(`${key}\u0000${c}`, value);
          strings(value, (v) => {
            const id = idOf(v);
            if (id && !ids.includes(id)) candidates.add(id);
          });
        }
      }
      const known = new Set<string>();
      const list = [...candidates].sort();
      for (let i = 0; i < list.length; i += CHUNK) {
        const part = list.slice(i, i + CHUNK);
        for (const r of await db.all<{ id: string }>(`SELECT id FROM persons WHERE id IN (${placeholders(part.length)})`, part)) known.add(String(r.id));
      }
      if (known.size > 0) {
        const scrub = (value: unknown, hit: () => void): unknown => {
          if (typeof value === 'string') return known.has(idOf(value)) ? (hit(), MASKED) : value;
          if (Array.isArray(value)) return value.map((v) => scrub(v, hit));
          if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, hit)]));
          return value;
        };
        for (const [key, f] of rows) {
          for (const c of entry.foreignPersons) {
            if (!parsed.has(`${key}\u0000${c}`)) continue;
            let touched = false;
            const clean = scrub(parsed.get(`${key}\u0000${c}`), () => (touched = true));
            if (!touched) continue;
            f.row = { ...f.row, [c]: typeof f.row[c] === 'string' && typeof clean !== 'string' ? JSON.stringify(clean) : (clean as SqlValue) };
            f.foreign = true;
          }
        }
      }
    }
    // Une ligne n'est qu'à la personne si elle a été trouvée par elle, ou par une ligne qui n'est qu'à elle, et
    // qu'aucune de ses colonnes n'est celle d'une autre personne. Un tableau partagé (le plan d'un agent) ne l'est jamais,
    // ni un document à deux parties (colonnes `shared` : un bail, un état des lieux), ni ce qui en dépend.
    const mine = new Set<string>();
    const sharedTable = entry.locate.some((l) => 'json' in l);
    const partShared = new Set<string>();
    for (const [key, f] of rows) if (await sharedRow(db, entry, f.row)) partShared.add(key);
    sharedKeys.set(table, partShared);
    for (const [key, f] of rows) {
      const masked = Object.keys(entry.own ?? {}).some((c) => !f.matched.has(c));
      if (!sharedTable && !partShared.has(key) && !masked && !f.foreign && (f.matched.size > 0 || f.viaExclusive)) mine.add(key);
    }
    exclusive.set(table, mine);
    found.set(table, rows);
  }

  const sections: AccessSection[] = [];
  for (const t of registre) {
    for (const table of Object.keys(t.tables).sort()) {
      const entry = carte[table];
      const rows = found.get(table);
      if (!entry || 'excluded' in entry || !rows || rows.size === 0) continue;
      const shown: Row[] = [];
      for (const [key, f] of rows) {
        const row: Row = { ...f.row };
        for (const l of entry.locate) if ('json' in l) row[l.json] = json.get(`${table}.${l.json}`)?.get(key) ?? MASKED;
        // Les colonnes d'une autre personne : montrées seulement si la ligne a été trouvée par la colonne qui la désigne.
        for (const [column, owned] of Object.entries(entry.own ?? {})) {
          if (f.matched.has(column)) continue;
          for (const c of [column, ...owned]) row[c] = MASKED;
        }
        for (const c of [...(entry.secrets ?? []), ...(sharedKeys.get(table)?.has(key) ? (entry.shared ?? []) : [])]) row[c] = MASKED;
        shown.push(row);
      }
      shown.sort((a, b) => {
        const x = JSON.stringify(canonical(a));
        const y = JSON.stringify(canonical(b));
        return x < y ? -1 : x > y ? 1 : 0;
      });
      sections.push({
        table,
        traitement: t.id,
        finalite: t.finalite,
        baseLegale: LEGAL_BASIS_LABELS[t.baseLegale],
        duree: t.duree,
        destinataires: t.destinataires,
        sousTraitants: t.sousTraitants,
        rows: shown,
      });
    }
  }
  const notIncluded = (Object.keys(EXCLUSION_LABELS) as ExclusionReason[]).map((reason) => ({ reason, text: EXCLUSION_LABELS[reason] }));
  const exclusiveRows: Record<string, number> = {};
  const exclusiveData: Record<string, Readonly<Record<string, SqlValue>>[]> = {};
  for (const s of sections) {
    exclusiveRows[s.table] = exclusive.get(s.table)?.size ?? 0;
    exclusiveData[s.table] = [...(exclusive.get(s.table) ?? [])].map((key) => found.get(s.table)!.get(key)!.row);
  }
  return { response: { personIds: ids, sections, notIncluded }, exclusiveRows, exclusiveData };
}

export interface ErasurePlanLine {
  table: string;
  traitement: string;
  rows: number;
  /**
   * `garder` : la loi l'oblige, ou l'arrêt de la personne doit tenir ; `empreinte` : gardé sous sa seule empreinte ;
   * `effacer` : n'est qu'à la personne ; `examiner` : partagé avec une autre personne, pseudonymisé ou gardé sur
   * décision du responsable, jamais effacé d'office.
   */
  action: 'effacer' | 'garder' | 'empreinte' | 'examiner';
  why: string | null;
}

export interface ErasurePlan {
  mode: typeof ERASURE_MODE;
  personIds: string[];
  lines: ErasurePlanLine[];
  /** Ce qui est gardé sans être compté ici : la lutte contre le blanchiment, 5 ans. */
  alwaysKept: string[];
}

export const ERASURE_WHY = {
  obligation: LEGAL_BASIS_LABELS.obligation_legale,
  stop: 'L\'opposition et les exclusions restent, pour ne plus jamais écrire à la personne [R04].',
  identifiers: 'Identifiants gardés sous leur seule empreinte, pour reconnaître la personne et respecter son arrêt [R04].',
  shared: 'Ligne partagée avec une autre personne : pseudonymisée ou gardée, sur décision du responsable.',
  property: 'Description et diffusion du bien, en ajout seul : gardées avec le bien, sans nom ni adresse exacte [R19, R46], détachées de la personne dont le lien au bien part [R17].',
} as const;

/**
 * Les tables qui décrivent et diffusent un bien, en ajout seul (la base refuse de les effacer) : fiche, détails, liens,
 * brouillons, validations, versions et traductions de l'annonce, contrôles des vidéos, choix et retours des portails,
 * sujets des photos (AU020b), toutes du traitement des biens. Aucune ne porte le nom du vendeur ni l'adresse exacte [R19, R46] ; elles restent avec le
 * bien, et c'est le lien de la personne au bien (son projet) qui part. Le plan les dit gardées, avec leur raison, au
 * lieu de promettre un effacement que la base refuse.
 *
 * Pas ici, parce qu'elles portent l'adresse exacte : `sign_placements` (le panneau posé) et `pige_properties` (le bien
 * venu de la pige). Elles restent à effacer, la base le refuse, et l'effacement n'est pas dit complet (AU020d), comme pour les tables en
 * ajout seul d'autres traitements (commerces, départ d'un agent, assainissement).
 */
export const PROPERTY_DESCRIPTION: ReadonlySet<string> = new Set([
  'property_sheets',
  'property_details',
  'property_links',
  'listing_drafts',
  'listing_validations',
  'listing_versions',
  'listing_version_media_sheets',
  'listing_translations',
  'listing_translation_validations',
  'translation_reviewers',
  'video_text_checks',
  'agent_import_properties',
  'diffusion_portal_choices',
  'diffusion_portal_suspensions',
  'diffusion_portal_resumptions',
  'diffusion_portal_feedback',
  'diffusion_portal_checks',
  'diffusion_portal_texts',
  'diffusion_portal_text_validations',
  'diffusion_photo_subjects',
  'diffusion_photo_descriptions',
]);

/** Les tables en ajout seul du bien qui portent l'adresse exacte : jamais gardées d'office (AU020d). */
export const PROPERTY_ADDRESS_HELD: ReadonlySet<string> = new Set(['sign_placements', 'pige_properties']);

/**
 * Le plan d'effacement : chaque table de la réponse d'accès. Une obligation légale garde la table (registre des mandats
 * et documents signés, factures, journal) ; l'arrêt de la personne reste, ses identifiants sous empreinte ; une ligne
 * partagée avec une autre personne n'est jamais effacée d'office ; la lutte contre le blanchiment est toujours gardée.
 */
export function erasurePlan(detail: AccessDetail, registre: readonly Traitement[] = REGISTRE_TRAITEMENTS): ErasurePlan {
  const basisOf = new Map<string, LegalBasis>(registre.map((t) => [t.id, t.baseLegale]));
  const lines: ErasurePlanLine[] = [];
  for (const s of detail.response.sections) {
    const base = { table: s.table, traitement: s.traitement };
    if (basisOf.get(s.traitement) === 'obligation_legale') lines.push({ ...base, rows: s.rows.length, action: 'garder', why: ERASURE_WHY.obligation });
    else if (s.table === 'exclusions') lines.push({ ...base, rows: s.rows.length, action: 'garder', why: ERASURE_WHY.stop });
    else if (s.table === 'person_identifiers') lines.push({ ...base, rows: s.rows.length, action: 'empreinte', why: ERASURE_WHY.identifiers });
    else if (PROPERTY_DESCRIPTION.has(s.table)) lines.push({ ...base, rows: s.rows.length, action: 'garder', why: ERASURE_WHY.property });
    else {
      const own = Math.min(detail.exclusiveRows[s.table] ?? 0, s.rows.length);
      if (own > 0) lines.push({ ...base, rows: own, action: 'effacer', why: null });
      if (s.rows.length - own > 0) lines.push({ ...base, rows: s.rows.length - own, action: 'examiner', why: ERASURE_WHY.shared });
    }
  }
  return {
    mode: ERASURE_MODE,
    personIds: detail.response.personIds,
    lines,
    alwaysKept: [EXCLUSION_LABELS.lcb_ft, registre.find((t) => t.id === LCB_FT_TRAITEMENT)?.duree ?? ''].filter((x) => x !== ''),
  };
}

export interface PersonRequest {
  id: string;
  personId: string;
  kind: PersonRequestKind;
  channel: PersonRequestChannel;
  receivedOn: string;
  dueOn: string;
  /** Le jour du rappel au responsable, 7 jours avant l'échéance. */
  noticeOn: string;
  exclusionId: string | null;
  answeredOn: string | null;
  answerSha256: string | null;
  late: boolean | null;
  /** Rectification seulement : le jour (Paris) de la première correction du nom faite à la demande de la personne depuis la réception. */
  rectifiedOn: string | null;
}

export interface PersonRequestAlert {
  requestId: string;
  kind: 'rappel' | 'echeance';
  dueOn: string;
  text: string;
  createdAt: string;
}

export type PersonRequestRefusal = { ok: false; rule: 'R16' | 'R96' | null; code: string };
type Result<T> = { ok: true; value: T } | PersonRequestRefusal;

interface RequestRow {
  id: string;
  network_id: string;
  person_id: string;
  kind: PersonRequestKind;
  channel: PersonRequestChannel;
  received_on: string;
  due_on: string;
  exclusion_id: string | null;
  recorded_by: string;
  recorded_at: string;
}

/** Ce qu'il faut pour poser l'arrêt d'une opposition : la voie d'un « stop » reçu (`DecisionEnvoi.recordStopRequest`). */
export interface StopRecorder {
  recordStopRequest(input: { networkId: string; agentId?: string | null; personId: string; at: Date }): Promise<{ id: string }>;
}

export class DemandesPersonnes {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly carte: Readonly<Record<string, AccessMapEntry>>;
  private readonly registre: readonly Traitement[];

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly fiche: FicheUnique,
    private readonly stop: StopRecorder,
    options: { now?: () => Date; newId?: () => string; carte?: Readonly<Record<string, AccessMapEntry>>; registre?: readonly Traitement[] } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.carte = options.carte ?? CARTE_ACCES;
    this.registre = options.registre ?? REGISTRE_TRAITEMENTS;
  }

  private today(): string {
    return localTime(this.now(), TIME_ZONE).date;
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, code: string): Promise<PersonRequestRefusal> {
    await appendEvent(
      this.journal,
      { type: 'acces.refuse', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'demandes_personnes', code } },
      this.now,
    );
    return { ok: false, rule: 'R16', code };
  }

  private async requestOf(viewer: Viewer, requestId: string): Promise<RequestRow | null> {
    if (typeof requestId !== 'string') return null;
    return this.db.first<RequestRow>('SELECT * FROM person_requests WHERE id = ? AND network_id = ?', [requestId, viewer.networkId]);
  }

  /**
   * Les corrections du nom faites « à la demande de la personne » sur ses fiches réunies, le jour de la réception ou
   * après, de la plus ancienne à la plus récente : leur identifiant et leur jour, jamais un nom [R13].
   */
  private async rectifications(row: RequestRow): Promise<{ id: string; day: string }[]> {
    if (row.kind !== 'rectification') return [];
    const ids = await this.fiche.membersOf(row.person_id);
    if (ids.length === 0) return [];
    const rows = await this.db.all<{ id: string; created_at: string }>(
      `SELECT id, created_at FROM person_name_corrections WHERE network_id = ? AND reason = 'demande_de_la_personne' AND person_id IN (${ids.map(() => '?').join(', ')}) ORDER BY created_at, id`,
      [row.network_id, ...ids],
    );
    return rows
      .map((r) => ({ id: r.id, day: localTime(new Date(r.created_at), TIME_ZONE).date }))
      .filter((r) => r.day >= row.received_on);
  }

  private async view(row: RequestRow): Promise<PersonRequest> {
    const answer = await this.db.first<{ answered_on: string; answer_sha256: string; late: number }>(
      'SELECT answered_on, answer_sha256, late FROM person_request_answers WHERE request_id = ?',
      [row.id],
    );
    return {
      id: row.id,
      personId: row.person_id,
      kind: row.kind,
      channel: row.channel,
      receivedOn: row.received_on,
      dueOn: row.due_on,
      noticeOn: addDays(row.due_on, -PERSON_REQUEST_NOTICE_DAYS),
      exclusionId: row.exclusion_id,
      answeredOn: answer?.answered_on ?? null,
      answerSha256: answer?.answer_sha256 ?? null,
      late: answer ? answer.late === 1 : null,
      rectifiedOn: (await this.rectifications(row))[0]?.day ?? null,
    };
  }

  /**
   * Le responsable enregistre une demande reçue. L'échéance est calculée par le code. Une opposition pose aussitôt
   * l'arrêt sur tous les canaux [R04].
   */
  async record(
    viewer: Viewer,
    input: { personId: string; kind: PersonRequestKind; channel: PersonRequestChannel; receivedOn: string },
  ): Promise<Result<PersonRequest>> {
    if (viewer.role !== 'compliance') return this.refuse(viewer, 'role');
    if (!PERSON_REQUEST_KINDS.includes(input.kind)) return { ok: false, rule: null, code: 'bad_kind' };
    if (!PERSON_REQUEST_CHANNELS.includes(input.channel)) return { ok: false, rule: null, code: 'bad_channel' };
    if (!validDay(input.receivedOn)) return { ok: false, rule: null, code: 'bad_date' };
    if (input.receivedOn > this.today()) return { ok: false, rule: null, code: 'future_date' };
    const person = typeof input.personId === 'string'
      ? await this.db.first<{ id: string; agent_id: string | null }>('SELECT id, agent_id FROM persons WHERE id = ? AND network_id = ?', [input.personId, viewer.networkId])
      : null;
    if (!person) return { ok: false, rule: null, code: 'unknown_person' };
    const exclusion = input.kind === 'opposition'
      ? await this.stop.recordStopRequest({ networkId: viewer.networkId, agentId: person.agent_id, personId: person.id, at: this.now() })
      : null;
    const id = this.newId();
    const dueOn = addCalendarMonths(input.receivedOn, PERSON_REQUEST_MONTHS);
    await this.db.run(
      'INSERT INTO person_requests (id, network_id, person_id, kind, channel, received_on, due_on, exclusion_id, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, viewer.networkId, person.id, input.kind, input.channel, input.receivedOn, dueOn, exclusion?.id ?? null, this.actor(viewer), this.now().toISOString()],
    );
    await appendEvent(
      this.journal,
      { type: 'rgpd.demande', actor: this.actor(viewer), subject: `person_request:${id}`, data: { rule: 'R96', kind: input.kind, receivedOn: input.receivedOn, dueOn, stop: exclusion ? 'R04' : null } },
      this.now,
    );
    const row = await this.requestOf(viewer, id);
    return { ok: true, value: await this.view(row!) };
  }

  private async storeOutput(viewer: Viewer, row: RequestRow, kind: 'reponse_acces' | 'plan_effacement', mode: 'essai' | 'reel', sha: string): Promise<void> {
    await this.db.run(
      'INSERT INTO person_request_outputs (request_id, kind, mode, output_sha256, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      [row.id, kind, mode, sha, this.actor(viewer), this.now().toISOString()],
    );
  }

  /** La réponse d'accès, assemblée par le code depuis chaque table du registre, avec son empreinte. Rien n'est envoyé. */
  async prepareAccess(viewer: Viewer, requestId: string): Promise<Result<{ response: AccessResponse; sha256: string }>> {
    if (viewer.role !== 'compliance') return this.refuse(viewer, 'role');
    const row = await this.requestOf(viewer, requestId);
    if (!row) return { ok: false, rule: null, code: 'unknown' };
    if (row.kind !== 'acces') return { ok: false, rule: null, code: 'not_access' };
    const response = await assembleAccess(this.db, await this.fiche.membersOf(row.person_id), { carte: this.carte, registre: this.registre });
    const sha256 = await sha256Of(response);
    await this.storeOutput(viewer, row, 'reponse_acces', 'reel', sha256);
    await appendEvent(
      this.journal,
      { type: 'rgpd.reponse_acces_preparee', actor: this.actor(viewer), subject: `person_request:${row.id}`, data: { rule: 'R96', sha256, tables: response.sections.length } },
      this.now,
    );
    return { ok: true, value: { response, sha256 } };
  }

  /**
   * L'effacement par la procédure de M12, en mode essai tant que H29 n'est pas fait : le plan dit ce qui serait
   * effacé et ce qui serait gardé, et rien n'est effacé [R17].
   */
  async prepareErasure(viewer: Viewer, requestId: string): Promise<Result<{ plan: ErasurePlan; sha256: string }>> {
    if (viewer.role !== 'compliance') return this.refuse(viewer, 'role');
    const row = await this.requestOf(viewer, requestId);
    if (!row) return { ok: false, rule: null, code: 'unknown' };
    if (row.kind !== 'effacement') return { ok: false, rule: null, code: 'not_erasure' };
    const access = await assembleAccessDetail(this.db, await this.fiche.membersOf(row.person_id), { carte: this.carte, registre: this.registre });
    const plan = erasurePlan(access, this.registre);
    const sha256 = await sha256Of(plan);
    await this.storeOutput(viewer, row, 'plan_effacement', ERASURE_MODE, sha256);
    await appendEvent(
      this.journal,
      {
        type: 'rgpd.effacement_essai',
        actor: this.actor(viewer),
        subject: `person_request:${row.id}`,
        data: { rule: 'R17', mode: ERASURE_MODE, sha256, erased: 0, wouldErase: plan.lines.filter((l) => l.action === 'effacer').reduce((n, l) => n + l.rows, 0), kept: plan.lines.filter((l) => l.action !== 'effacer').reduce((n, l) => n + l.rows, 0) },
      },
      this.now,
    );
    return { ok: true, value: { plan, sha256 } };
  }

  /**
   * Le responsable note la réponse donnée, une seule fois : son jour et son empreinte font la preuve. Une réponse
   * d'accès ou d'effacement s'appuie sur ce que le code a préparé ; une réponse après l'échéance est notée en retard.
   */
  async answer(viewer: Viewer, requestId: string, input: { answeredOn: string }): Promise<Result<PersonRequest>> {
    if (viewer.role !== 'compliance') return this.refuse(viewer, 'role');
    const row = await this.requestOf(viewer, requestId);
    if (!row) return { ok: false, rule: null, code: 'unknown' };
    if (!validDay(input.answeredOn)) return { ok: false, rule: null, code: 'bad_date' };
    if (input.answeredOn > this.today()) return { ok: false, rule: null, code: 'future_date' };
    if (input.answeredOn < row.received_on) return { ok: false, rule: null, code: 'before_request' };
    if (await this.db.first('SELECT 1 FROM person_request_answers WHERE request_id = ?', [row.id])) return { ok: false, rule: null, code: 'already_answered' };
    let sha: string;
    if (row.kind === 'acces' || row.kind === 'effacement') {
      const output = await this.db.first<{ output_sha256: string }>(
        'SELECT output_sha256 FROM person_request_outputs WHERE request_id = ? ORDER BY created_at DESC, output_sha256 DESC LIMIT 1',
        [row.id],
      );
      if (!output) return { ok: false, rule: 'R96', code: 'not_prepared' };
      sha = output.output_sha256;
    } else if (row.kind === 'rectification') {
      // La preuve garde les corrections du nom faites à la demande de la personne, par leur seul identifiant.
      const corrections = (await this.rectifications(row)).filter((c) => c.day <= input.answeredOn).map((c) => c.id);
      sha = await sha256Of({ request: row.id, kind: row.kind, exclusion: row.exclusion_id, answeredOn: input.answeredOn, corrections });
    } else {
      sha = await sha256Of({ request: row.id, kind: row.kind, exclusion: row.exclusion_id, answeredOn: input.answeredOn });
    }
    const late = input.answeredOn > row.due_on;
    await this.db.run(
      'INSERT INTO person_request_answers (request_id, answer_sha256, answered_on, late, answered_by, answered_at) VALUES (?, ?, ?, ?, ?, ?)',
      [row.id, sha, input.answeredOn, late ? 1 : 0, this.actor(viewer), this.now().toISOString()],
    );
    await appendEvent(
      this.journal,
      { type: 'rgpd.reponse', actor: this.actor(viewer), subject: `person_request:${row.id}`, data: { rule: 'R96', kind: row.kind, sha256: sha, answeredOn: input.answeredOn, late } },
      this.now,
    );
    return { ok: true, value: await this.view(row) };
  }

  /** Les demandes du réseau, la plus proche de son échéance d'abord : le responsable de la conformité seul. */
  async list(viewer: Viewer): Promise<Result<PersonRequest[]>> {
    if (viewer.role !== 'compliance') return this.refuse(viewer, 'role');
    const rows = await this.db.all<RequestRow>('SELECT * FROM person_requests WHERE network_id = ? ORDER BY due_on, received_on, recorded_at, id', [viewer.networkId]);
    const out: PersonRequest[] = [];
    for (const r of rows) out.push(await this.view(r));
    return { ok: true, value: out };
  }

  /**
   * Le passage du jour : pour chaque demande sans réponse, le rappel part 7 jours avant l'échéance et l'alerte le jour
   * de l'échéance, une seule fois chacun, même si le planificateur repasse ou a manqué des jours. Rend le nombre
   * d'alertes levées.
   */
  async run(networkId: string): Promise<number> {
    const today = this.today();
    const rows = await this.db.all<RequestRow>(
      `SELECT r.* FROM person_requests r WHERE r.network_id = ? AND NOT EXISTS (SELECT 1 FROM person_request_answers a WHERE a.request_id = r.id) ORDER BY r.due_on, r.id`,
      [networkId],
    );
    let raised = 0;
    for (const r of rows) {
      const kinds: ('rappel' | 'echeance')[] = [];
      if (today >= addDays(r.due_on, -PERSON_REQUEST_NOTICE_DAYS)) kinds.push('rappel');
      if (today >= r.due_on) kinds.push('echeance');
      for (const kind of kinds) {
        const { changes } = await this.db.run('INSERT INTO person_request_alerts (request_id, kind, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [r.id, kind, this.now().toISOString()]);
        if (changes > 0) {
          raised += 1;
          await appendEvent(this.journal, { type: 'rgpd.alerte', actor: 'system:demandes_personnes', subject: `person_request:${r.id}`, data: { rule: 'R96', kind, dueOn: r.due_on } }, this.now);
        }
      }
    }
    return raised;
  }

  /** Les alertes du responsable, avec leur texte. */
  async alerts(viewer: Viewer): Promise<Result<PersonRequestAlert[]>> {
    if (viewer.role !== 'compliance') return this.refuse(viewer, 'role');
    const rows = await this.db.all<{ request_id: string; kind: 'rappel' | 'echeance'; created_at: string; due_on: string; request_kind: PersonRequestKind }>(
      `SELECT a.request_id, a.kind, a.created_at, r.due_on, r.kind AS request_kind FROM person_request_alerts a
       JOIN person_requests r ON r.id = a.request_id WHERE r.network_id = ? ORDER BY r.due_on, a.request_id, a.kind DESC`,
      [viewer.networkId],
    );
    const fr = (day: string): string => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;
    const label: Record<PersonRequestKind, string> = { acces: 'd\'accès', rectification: 'de rectification', effacement: 'd\'effacement', opposition: 'd\'opposition' };
    // Le jour de la correction du nom, relu une fois par demande de rectification.
    const rectified = new Map<string, string | null>();
    for (const r of rows) {
      if (r.request_kind !== 'rectification' || rectified.has(r.request_id)) continue;
      const request = await this.requestOf(viewer, r.request_id);
      rectified.set(r.request_id, request ? ((await this.rectifications(request))[0]?.day ?? null) : null);
    }
    return {
      ok: true,
      value: rows.map((r) => {
        const on = rectified.get(r.request_id) ?? null;
        const text = on
          ? r.kind === 'rappel'
            ? `Demande de rectification : nom corrigé le ${fr(on)}, la réponse à la personne reste à noter avant le ${fr(r.due_on)}.`
            : `Demande de rectification : nom corrigé le ${fr(on)}, l'échéance du ${fr(r.due_on)} est arrivée, la réponse n'est pas notée.`
          : r.kind === 'rappel'
            ? `Demande ${label[r.request_kind]} à traiter avant le ${fr(r.due_on)}.`
            : `Demande ${label[r.request_kind]} : l'échéance du ${fr(r.due_on)} est arrivée, la réponse n'est pas notée.`;
        return { requestId: r.request_id, kind: r.kind, dueOn: r.due_on, createdAt: r.created_at, text };
      }),
    };
  }
}
