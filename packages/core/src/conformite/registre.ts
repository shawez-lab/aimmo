/**
 * Registre des traitements vérifié contre la base (M12, L06) [R95].
 *
 * Le registre des traitements (RGPD, article 30) est écrit dans le dépôt, dans `registre-traitements.ts` : chaque
 * traitement avec sa finalité, sa base légale (article 6), ses données, sa durée, ses destinataires et ses
 * sous-traitants (article 28), et les tables de la base qu'il remplit. Ce fichier-ci lit les migrations et compare.
 *
 * Jamais vu : la comparaison est une vérification automatique. Une migration qui ajoute une table, ou une colonne qui
 * porte une donnée personnelle, sans l'inscrire au registre fait échouer les tests, donc les vérifications GitHub :
 * le registre ne peut plus dériver de la base.
 *
 * Une colonne porte une donnée personnelle quand son nom désigne une personne (client, agent, candidat, bénéficiaire),
 * ses coordonnées, un texte libre, une preuve ou l'auteur d'un geste. Chaque table de donnée personnelle est inscrite à
 * un seul traitement, avec la liste exacte de ses colonnes personnelles ; une table sans aucune donnée personnelle est
 * inscrite à part, avec sa raison, et la vérification refuse qu'elle en gagne une sans passer au registre.
 */
export type LegalBasis = 'contrat' | 'mesures_precontractuelles' | 'obligation_legale' | 'interet_legitime' | 'consentement';

export const LEGAL_BASIS_LABELS: Record<LegalBasis, string> = {
  contrat: 'Exécution du contrat (article 6.1.b)',
  mesures_precontractuelles: 'Mesures précontractuelles à la demande de la personne (article 6.1.b)',
  obligation_legale: 'Obligation légale (article 6.1.c)',
  interet_legitime: 'Intérêt légitime (article 6.1.f)',
  consentement: 'Consentement (article 6.1.a)',
};

export interface Traitement {
  id: string;
  /** Pourquoi ces données sont traitées. */
  finalite: string;
  baseLegale: LegalBasis;
  /** Les catégories de personnes et de données. */
  personnes: readonly string[];
  donnees: readonly string[];
  /** Combien de temps, et à partir de quand. */
  duree: string;
  destinataires: readonly string[];
  sousTraitants: readonly string[];
  /** Chaque table du traitement et la liste exacte de ses colonnes personnelles. */
  tables: Readonly<Record<string, readonly string[]>>;
}

export interface Migration {
  id: string;
  sql: string;
}

/** Les tables et leurs colonnes, dans l'ordre des migrations. */
export type Schema = Map<string, { migration: string; columns: string[] }>;

const NOT_COLUMN = /^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT)$/i;

function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (const ch of body) {
    if (ch === "'") quoted = !quoted;
    if (!quoted && ch === '(') depth++;
    if (!quoted && ch === ')') depth--;
    if (!quoted && ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else current += ch;
  }
  parts.push(current);
  return parts;
}

/**
 * Retire les commentaires (en ligne et en bloc) et vide les textes entre apostrophes : ni un commentaire ni un texte ne
 * peut cacher ou imiter une instruction.
 */
function stripComments(sql: string): string {
  let out = '';
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 1;
      out += ' ';
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      for (; j < sql.length; j++) {
        if (sql[j] === "'" && sql[j + 1] === "'") j++;
        else if (sql[j] === "'") break;
      }
      i = j;
      out += "''";
      continue;
    }
    out += ch;
  }
  return out;
}

const NAME = '["`\\[]?([A-Za-z_][A-Za-z_0-9]*)["`\\]]?';
const QUALIFIED = `(?:["\`\\[]?[A-Za-z_][A-Za-z_0-9]*["\`\\]]?\\.)?${NAME}`;
// Toute instruction qui crée ou modifie une table, quelle que soit sa forme : chacune doit être lue.
const ANY_TABLE_STATEMENT = /\b(?:CREATE|ALTER|DROP)(?:\s+[A-Za-z_]+)*?\s+TABLE\b/gi;

/**
 * Lit chaque `CREATE TABLE` (temporaire ou virtuelle, avec ou sans schéma) et chaque `ALTER TABLE` des migrations, dans
 * l'ordre : colonne ajoutée, renommée ou retirée, table renommée, retirée ou recréée. Une forme que la lecture ne comprend pas arrête la
 * vérification au lieu de passer en silence.
 */
export function readSchema(migrations: readonly Migration[]): Schema {
  const schema: Schema = new Map();
  for (const migration of [...migrations].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const sql = stripComments(migration.sql);
    // Un nom entre guillemets, accents graves ou crochets doit être un nom simple : sinon la lecture n'en verrait
    // qu'une partie.
    for (const q of sql.matchAll(/"[^"]*"|`[^`]*`|\[[^\]]*\]/g)) {
      if (!/^.[A-Za-z_][A-Za-z_0-9]*.$/.test(q[0])) throw new Error(`migration ${migration.id} : nom ${q[0]}, forme que le registre ne sait pas lire`);
    }
    const statements = new RegExp(`\\b(CREATE\\s+(?:TEMP(?:ORARY)?\\s+)?(?:VIRTUAL\\s+)?TABLE|ALTER\\s+TABLE|DROP\\s+TABLE)\\s+(?:IF\\s+(?:NOT\\s+)?EXISTS\\s+)?${QUALIFIED}`, 'gi');
    const read = new Set([...sql.matchAll(statements)].map((m) => m.index));
    for (const m of sql.matchAll(ANY_TABLE_STATEMENT)) {
      if (!read.has(m.index)) {
        const near = sql.slice(m.index, m.index + 80).replace(/\s+/g, ' ');
        throw new Error(`migration ${migration.id} : « ${near} », forme que le registre ne sait pas lire`);
      }
    }
    for (const m of sql.matchAll(statements)) {
      const table = m[2]!.toLowerCase();
      const rest = sql.slice(m.index! + m[0].length);
      const fail = (what: string): never => {
        throw new Error(`migration ${migration.id} : ${what} (table ${table}), forme que le registre ne sait pas lire`);
      };
      // Une table retirée puis recréée est relue avec ses nouvelles colonnes.
      if (/^DROP/i.test(m[1]!)) {
        schema.delete(table);
        continue;
      }
      if (/^CREATE/i.test(m[1]!)) {
        if (/^\s*USING\b/i.test(rest)) fail('table virtuelle');
        if (!/^\s*\(/.test(rest)) fail('table créée sans liste de colonnes');
        const open = rest.indexOf('(');
        let depth = 0;
        let end = -1;
        let quoted = false;
        for (let i = open; i < rest.length; i++) {
          const ch = rest[i]!;
          if (ch === "'") quoted = !quoted;
          if (quoted) continue;
          if (ch === '(') depth++;
          if (ch === ')' && --depth === 0) {
            end = i;
            break;
          }
        }
        if (end < 0) fail('table mal fermée');
        const columns = splitTopLevel(rest.slice(open + 1, end))
          .map((part) => part.trim().split(/\s+/)[0]?.replace(/["`\[\]]/g, '').toLowerCase() ?? '')
          .filter((name) => name !== '' && !NOT_COLUMN.test(name));
        if (!schema.has(table)) schema.set(table, { migration: migration.id, columns });
        continue;
      }
      const entry = schema.get(table) ?? fail('modification d\'une table inconnue');
      const add = new RegExp(`^\\s+ADD\\s+(?:COLUMN\\s+)?${NAME}`, 'i').exec(rest);
      const renameTable = new RegExp(`^\\s+RENAME\\s+TO\\s+${QUALIFIED}`, 'i').exec(rest);
      const renameColumn = new RegExp(`^\\s+RENAME\\s+(?:COLUMN\\s+)?${NAME}\\s+TO\\s+${NAME}`, 'i').exec(rest);
      const drop = new RegExp(`^\\s+DROP\\s+(?:COLUMN\\s+)?${NAME}`, 'i').exec(rest);
      if (renameTable) {
        schema.delete(table);
        schema.set(renameTable[1]!.toLowerCase(), entry);
      } else if (renameColumn) {
        const from = renameColumn[1]!.toLowerCase();
        const i = entry.columns.indexOf(from);
        if (i < 0) fail(`colonne ${from} inconnue`);
        entry.columns[i] = renameColumn[2]!.toLowerCase();
      } else if (add) {
        const column = add[1]!.toLowerCase();
        if (!entry.columns.includes(column)) entry.columns.push(column);
      } else if (drop) {
        entry.columns = entry.columns.filter((c) => c !== drop[1]!.toLowerCase());
      } else fail('modification');
    }
  }
  return schema;
}

// Une personne désignée par son identifiant, ou l'auteur d'un geste (`*_by`).
const PERSON_WORDS = new Set([
  'person', 'persons', 'agent', 'candidate', 'referrer', 'referred', 'survivor', 'merged', 'owner', 'beneficiary', 'referent',
  'sponsor', 'cover', 'successor', 'interviewer', 'recipient', 'reader', 'visitor', 'buyer', 'importing', 'actor', 'by',
  'sender', 'validator', 'decider', 'recorder', 'held', 'issuer',
]);
// Ses coordonnées, un texte libre, une preuve, un contenu, ce qu'elle cherche ou dépense.
const DATA_WORDS = new Set([
  'name', 'email', 'phone', 'town', 'city', 'commune', 'communes', 'postal', 'address', 'body', 'text', 'content', 'comment',
  'dictation', 'note', 'question', 'experience', 'payload', 'identifiers', 'proof', 'scan', 'storage', 'value', 'criteria',
  'detail', 'reason', 'report', 'subject', 'conversation', 'draft', 'figures', 'inputs', 'data', 'items', 'removed', 'facts',
  'trace', 'replies', 'situation', 'url', 'sha256', 'drawing', 'conditions', 'lines', 'signals', 'zone', 'topic', 'score',
  'temperature', 'financing', 'budget', 'amount', 'fee', 'card', 'copy', 'ai', 'fallback', 'birth', 'born', 'age', 'iban',
  'bic', 'mobile', 'firstname', 'lastname', 'surname', 'nickname', 'nationality', 'ip', 'latitude', 'longitude', 'lat', 'lng', 'geo',
  'location', 'photo', 'picture', 'avatar', 'income', 'salary', 'revenue', 'gender', 'sex', 'health', 'religion', 'signature',
  'passport', 'nir', 'ssn', 'tax', 'account', 'login', 'password', 'device', 'useragent', 'cookie', 'family', 'children',
  'spouse', 'marital', 'employer', 'profession', 'street', 'postcode', 'zip', 'zipcode',
]);
// Des noms entiers qui désignent une pièce signée, un message publié ou l'adresse d'un destinataire.
const PERSONAL_COLUMNS = new Set(['signed_ref', 'post_ref', 'external_id', 'confirmation_to']);

/** Le nom de la colonne désigne-t-il une donnée personnelle ? */
export function isPersonalColumn(column: string): boolean {
  const words = column.toLowerCase().split('_');
  if (column === 'id' || column === 'network_id') return false;
  if (PERSONAL_COLUMNS.has(column.toLowerCase())) return true;
  return words.some((word) => PERSON_WORDS.has(word) || DATA_WORDS.has(word));
}

export type RegistryGap =
  | { kind: 'table_absente'; table: string; migration: string; columns: string[] }
  | { kind: 'colonne_absente'; table: string; traitement: string; column: string }
  | { kind: 'colonne_inconnue'; table: string; traitement: string; column: string }
  | { kind: 'table_inconnue'; table: string; where: string }
  | { kind: 'table_en_double'; table: string; where: string[] }
  | { kind: 'technique_avec_donnee'; table: string; columns: string[] }
  | { kind: 'colonne_non_classee'; table: string; column: string }
  | { kind: 'colonne_mal_classee'; table: string; column: string }
  | { kind: 'traitement_incomplet'; traitement: string; field: string };

/** Compare le registre aux migrations : une liste vide veut dire que le registre dit toute la base, et rien de plus. */
export function checkRegistry(
  schema: Schema,
  registre: readonly Traitement[],
  sansDonnee: Readonly<Record<string, string>>,
  colonnesSansDonnee: Readonly<Record<string, readonly string[]>>,
): RegistryGap[] {
  const gaps: RegistryGap[] = [];
  const where = new Map<string, string[]>();
  const ids = new Set<string>();
  for (const t of registre) {
    if (ids.has(t.id)) gaps.push({ kind: 'traitement_incomplet', traitement: t.id, field: 'id en double' });
    ids.add(t.id);
    for (const field of ['finalite', 'baseLegale', 'duree'] as const) {
      if (typeof t[field] !== 'string' || t[field].trim() === '') gaps.push({ kind: 'traitement_incomplet', traitement: t.id, field });
    }
    if (!(t.baseLegale in LEGAL_BASIS_LABELS)) gaps.push({ kind: 'traitement_incomplet', traitement: t.id, field: 'baseLegale' });
    for (const field of ['personnes', 'donnees', 'destinataires'] as const) {
      if (t[field].length === 0) gaps.push({ kind: 'traitement_incomplet', traitement: t.id, field });
    }
    if (Object.keys(t.tables).length === 0) gaps.push({ kind: 'traitement_incomplet', traitement: t.id, field: 'tables' });
    for (const table of Object.keys(t.tables)) where.set(table, [...(where.get(table) ?? []), t.id]);
  }
  for (const table of Object.keys(sansDonnee)) {
    where.set(table, [...(where.get(table) ?? []), 'sans donnée personnelle']);
    if (sansDonnee[table]!.trim() === '') gaps.push({ kind: 'traitement_incomplet', traitement: 'sans donnée personnelle', field: table });
  }
  for (const [table, places] of where) {
    if (places.length > 1) gaps.push({ kind: 'table_en_double', table, where: places });
    if (!schema.has(table)) gaps.push({ kind: 'table_inconnue', table, where: places[0]! });
  }
  for (const [table, { migration, columns }] of schema) {
    const personal = columns.filter(isPersonalColumn);
    const places = where.get(table);
    if (!places) {
      gaps.push({ kind: 'table_absente', table, migration, columns: personal });
      continue;
    }
    const others = colonnesSansDonnee[table] ?? [];
    // Une colonne dite sans donnée personnelle dont le nom en désigne une est mal classée.
    for (const column of others) if (isPersonalColumn(column)) gaps.push({ kind: 'colonne_mal_classee', table, column });
    for (const column of others) if (!columns.includes(column)) gaps.push({ kind: 'colonne_inconnue', table, traitement: places[0]!, column });
    if (places[0] === 'sans donnée personnelle') {
      if (personal.length > 0) gaps.push({ kind: 'technique_avec_donnee', table, columns: personal });
      for (const column of columns) if (!isPersonalColumn(column) && !others.includes(column)) gaps.push({ kind: 'colonne_non_classee', table, column });
      continue;
    }
    const t = registre.find((r) => r.id === places[0])!;
    const declared = t.tables[table]!;
    for (const column of personal) if (!declared.includes(column)) gaps.push({ kind: 'colonne_absente', table, traitement: t.id, column });
    for (const column of declared) if (!columns.includes(column)) gaps.push({ kind: 'colonne_inconnue', table, traitement: t.id, column });
    // Toute colonne est classée : personnelle au traitement, ou sans donnée personnelle. Une colonne nouvelle au nom
    // anodin ne passe donc pas sans qu'on l'ait regardée.
    for (const column of columns) {
      if (!isPersonalColumn(column) && !declared.includes(column) && !others.includes(column)) gaps.push({ kind: 'colonne_non_classee', table, column });
    }
  }
  for (const table of Object.keys(colonnesSansDonnee)) if (!where.has(table)) gaps.push({ kind: 'table_inconnue', table, where: 'colonnes sans donnée personnelle' });
  return gaps;
}

/** Une phrase par écart, pour le message d'échec de la vérification. */
export function describeGap(gap: RegistryGap): string {
  switch (gap.kind) {
    case 'table_absente':
      return `la table ${gap.table} (migration ${gap.migration}) n'est pas au registre des traitements${gap.columns.length ? ` : colonnes personnelles ${gap.columns.join(', ')}` : ''}`;
    case 'colonne_absente':
      return `la colonne ${gap.table}.${gap.column} porte une donnée personnelle et n'est pas au registre (traitement ${gap.traitement})`;
    case 'colonne_inconnue':
      return `le registre cite ${gap.table}.${gap.column}, absente des migrations (traitement ${gap.traitement})`;
    case 'table_inconnue':
      return `le registre cite la table ${gap.table}, absente des migrations (${gap.where})`;
    case 'table_en_double':
      return `la table ${gap.table} est inscrite plusieurs fois : ${gap.where.join(', ')}`;
    case 'technique_avec_donnee':
      return `la table ${gap.table} est dite sans donnée personnelle mais porte ${gap.columns.join(', ')}`;
    case 'colonne_non_classee':
      return `la colonne ${gap.table}.${gap.column} n'est classée nulle part : à inscrire au registre, comme donnée personnelle de son traitement ou comme colonne sans donnée personnelle`;
    case 'colonne_mal_classee':
      return `la colonne ${gap.table}.${gap.column} est dite sans donnée personnelle, mais son nom en désigne une`;
    case 'traitement_incomplet':
      return `le traitement ${gap.traitement} n'a pas de ${gap.field} valable`;
  }
}

/** L'empreinte du registre relu : elle change dès qu'une ligne du registre change. */
export async function registryFingerprint(
  registre: readonly Traitement[],
  sansDonnee: Readonly<Record<string, string>>,
  colonnesSansDonnee: Readonly<Record<string, readonly string[]>>,
): Promise<string> {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
    }
    return value;
  };
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical({ registre, sansDonnee, colonnesSansDonnee })))));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
