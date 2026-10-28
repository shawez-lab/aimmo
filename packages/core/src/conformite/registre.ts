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

/** Retire les commentaires `--` et les textes entre apostrophes qui pourraient contenir des mots-clés. */
function stripComments(sql: string): string {
  let out = '';
  let quoted = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (!quoted && ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (ch === "'") quoted = !quoted;
    out += ch;
  }
  return out;
}

/** Lit chaque `CREATE TABLE` et chaque `ALTER TABLE … ADD COLUMN` des migrations, dans l'ordre. */
export function readSchema(migrations: readonly Migration[]): Schema {
  const schema: Schema = new Map();
  for (const migration of [...migrations].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const sql = stripComments(migration.sql);
    const statements = /\b(CREATE\s+(?:VIRTUAL\s+)?TABLE|ALTER\s+TABLE)\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([A-Za-z_][A-Za-z_0-9]*)["`]?/gi;
    for (const m of sql.matchAll(statements)) {
      const table = m[2]!.toLowerCase();
      const rest = sql.slice(m.index! + m[0].length);
      if (/^CREATE/i.test(m[1]!)) {
        const open = rest.indexOf('(');
        if (open < 0) continue;
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
        if (end < 0) throw new Error(`migration ${migration.id} : table ${table} mal fermée`);
        const columns = splitTopLevel(rest.slice(open + 1, end))
          .map((part) => part.trim().split(/\s+/)[0]?.replace(/["`]/g, '').toLowerCase() ?? '')
          .filter((name) => name !== '' && !NOT_COLUMN.test(name));
        if (!schema.has(table)) schema.set(table, { migration: migration.id, columns });
      } else {
        const add = /^\s+ADD\s+(?:COLUMN\s+)?["`]?([A-Za-z_][A-Za-z_0-9]*)/i.exec(rest);
        const entry = schema.get(table);
        if (add && entry && !entry.columns.includes(add[1]!.toLowerCase())) entry.columns.push(add[1]!.toLowerCase());
        const rename = /^\s+RENAME\s+TO\s+["`]?([A-Za-z_][A-Za-z_0-9]*)/i.exec(rest);
        if (rename && entry) {
          schema.delete(table);
          schema.set(rename[1]!.toLowerCase(), entry);
        }
      }
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
  'temperature', 'financing', 'budget', 'amount', 'fee', 'card', 'copy', 'ai', 'fallback',
]);
// Des noms entiers qui désignent une pièce signée ou un message publié.
const PERSONAL_COLUMNS = new Set(['signed_ref', 'post_ref', 'external_id']);

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
  | { kind: 'traitement_incomplet'; traitement: string; field: string };

/** Compare le registre aux migrations : une liste vide veut dire que le registre dit toute la base, et rien de plus. */
export function checkRegistry(
  schema: Schema,
  registre: readonly Traitement[],
  sansDonnee: Readonly<Record<string, string>>,
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
    if (places[0] === 'sans donnée personnelle') {
      if (personal.length > 0) gaps.push({ kind: 'technique_avec_donnee', table, columns: personal });
      continue;
    }
    const t = registre.find((r) => r.id === places[0])!;
    const declared = t.tables[table]!;
    for (const column of personal) if (!declared.includes(column)) gaps.push({ kind: 'colonne_absente', table, traitement: t.id, column });
    for (const column of declared) if (!columns.includes(column)) gaps.push({ kind: 'colonne_inconnue', table, traitement: t.id, column });
  }
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
    case 'traitement_incomplet':
      return `le traitement ${gap.traitement} n'a pas de ${gap.field} valable`;
  }
}

/** L'empreinte du registre relu : elle change dès qu'une ligne du registre change. */
export async function registryFingerprint(registre: readonly Traitement[], sansDonnee: Readonly<Record<string, string>>): Promise<string> {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
    }
    return value;
  };
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical({ registre, sansDonnee })))));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
