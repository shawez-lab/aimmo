/**
 * Lecture du fichier public du registre national des gels, tel que la DG Trésor le publie en JSON (RC49, reste de
 * HX57) [R603, R605, R13].
 *
 * `ControleGels.importRegistry` attend un registre déjà lu : identifiant, nature et noms de chaque entrée. Cette
 * fonction pure fabrique ce registre depuis le fichier publié, sans réseau ni base : le téléchargement se branche à
 * part (voie 1), et le responsable importe ensuite le résultat tel quel.
 *
 * Forme lue : `{ Publications: { DatePublication, PublicationDetail: [ { IdRegistre, Nature, Nom, RegistreDetail:
 * [ { TypeChamp, Valeur: [ … ] } ] } ] } }`. Seuls `PRENOM` (`Valeur[].Prenom`) et `ALIAS` (`Valeur[].Alias`) donnent
 * des noms ; les autres champs (dates de naissance, adresses, motifs…) ne sont pas lus.
 *
 * Décidé, lecture prudente :
 * - un fichier qu'on ne sait pas lire entièrement est refusé entier, avec sa raison et l'identifiant de l'entrée
 *   fautive, jamais un nom [R13] : oublier une entrée sans le dire laisserait passer une personne gelée ;
 * - « Personne physique » et « Personne morale » deviennent des entrées ; un navire n'est jamais une partie d'un dossier,
 *   il est compté à part, jamais oublié en silence ; toute autre nature fait refuser le fichier ;
 * - chaque entrée garde son nom complet « Nom Prénoms » (tous les prénoms, dans l'ordre publié) et chacun de ses
 *   alias ; un alias dans une autre écriture (cyrillique, arabe…) est laissé, comme `importRegistry` le fait ; une entrée
 *   sans aucun nom comparable, un nom trop long ou plus de `FREEZE_MAX_NAMES` noms font refuser le fichier ;
 * - une date publiée sans décalage horaire est à l'heure de Paris ;
 * - le format est celui de la documentation de la DG Trésor ; il n'a pas été relu sur le fichier du jour.
 */
import { FREEZE_MAX_NAME_LENGTH, FREEZE_MAX_NAMES, nameTokens, type FreezeNature, type FreezeRegistryEntry } from './gel-avoirs.ts';

export type DgTresorRefusalCode = 'bad_file' | 'bad_date' | 'bad_entry_id' | 'duplicate_entry' | 'unknown_nature' | 'bad_names' | 'no_entries' | 'too_many_names';

export type DgTresorRead =
  | { ok: true; value: { publishedAt: string; entries: FreezeRegistryEntry[]; vessels: number } }
  | { ok: false; code: DgTresorRefusalCode; entryId: string | null };

const NATURES: Record<string, FreezeNature | 'navire'> = {
  'personne physique': 'personne_physique',
  'personne morale': 'personne_morale',
  navire: 'navire',
};

const ENTRY_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * La date publiée. Sans décalage horaire écrit, elle est à l'heure de Paris : lue comme UTC, une publication du matin
 * paraîtrait venir du futur et serait refusée par `importRegistry`.
 */
function publishedAtOf(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(v.trim());
  if (!m) return null;
  if (m[7] !== undefined) {
    const t = Date.parse(v.trim());
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  const [y, mo, d, h, mi, se] = [m[1], m[2], m[3], m[4] ?? '00', m[5] ?? '00', m[6] ?? '00'].map(Number) as [number, number, number, number, number, number];
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, se);
  const check = new Date(asUtc);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59 || se > 59) return null;
  // Le décalage de Paris à cet instant (une heure l'hiver, deux l'été), relu une fois autour du changement d'heure.
  const offsetAt = (t: number): number => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Paris', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - t;
  };
  const first = asUtc - offsetAt(asUtc);
  return new Date(asUtc - offsetAt(first)).toISOString();
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Le texte nettoyé d'un champ, ou null s'il est vide ou n'est pas un texte. */
function text(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  return t.length > 0 ? t : null;
}

/** La nature publiée, sans casse, accents ni espaces de trop. */
function natureOf(v: unknown): FreezeNature | 'navire' | null {
  if (typeof v !== 'string') return null;
  const key = v.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\s_]+/g, ' ').trim().toLowerCase();
  return NATURES[key] ?? null;
}

/** L'identifiant publié : un nombre entier positif ou un texte court sans espace. */
function entryIdOf(v: unknown): string | null {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v > 0 ? String(v) : null;
  if (typeof v === 'string' && ENTRY_ID.test(v.trim())) return v.trim();
  return null;
}

/** Les valeurs d'un champ `TypeChamp` donné, lues sous `key`. `null` : le champ a une forme inattendue. */
function valuesOf(details: readonly unknown[], type: string, key: string): string[] | null {
  const out: string[] = [];
  for (const d of details) {
    if (!isObject(d)) return null;
    if (typeof d.TypeChamp !== 'string') return null;
    if (d.TypeChamp.trim().toUpperCase() !== type) continue;
    if (!Array.isArray(d.Valeur)) return null;
    for (const v of d.Valeur) {
      if (!isObject(v)) return null;
      // Un champ présent mais vide (alias publié sans texte) ne donne rien ; un champ d'une autre sorte est refusé.
      if (v[key] === undefined || v[key] === null) continue;
      if (typeof v[key] !== 'string') return null;
      const t = text(v[key]);
      if (t !== null) out.push(t);
    }
  }
  return out;
}

/** Lit le fichier JSON publié (déjà décodé) en un registre prêt pour `ControleGels.importRegistry`. */
export function lireRegistreDgTresor(file: unknown): DgTresorRead {
  const refuse = (code: DgTresorRefusalCode, entryId: string | null = null): DgTresorRead => ({ ok: false, code, entryId });
  if (!isObject(file) || !isObject(file.Publications)) return refuse('bad_file');
  const pub = file.Publications;
  const publishedAt = publishedAtOf(pub.DatePublication);
  if (publishedAt === null) return refuse('bad_date');
  if (!Array.isArray(pub.PublicationDetail)) return refuse('bad_file');
  const entries: FreezeRegistryEntry[] = [];
  const seen = new Set<string>();
  let vessels = 0;
  for (const raw of pub.PublicationDetail as unknown[]) {
    if (!isObject(raw)) return refuse('bad_file');
    const entryId = entryIdOf(raw.IdRegistre);
    if (entryId === null) return refuse('bad_entry_id');
    if (seen.has(entryId)) return refuse('duplicate_entry', entryId);
    seen.add(entryId);
    const nature = natureOf(raw.Nature);
    if (nature === null) return refuse('unknown_nature', entryId);
    if (raw.RegistreDetail !== undefined && raw.RegistreDetail !== null && !Array.isArray(raw.RegistreDetail)) return refuse('bad_file', entryId);
    const details = (raw.RegistreDetail ?? []) as unknown[];
    if (nature === 'navire') {
      vessels += 1;
      continue;
    }
    const prenoms = valuesOf(details, 'PRENOM', 'Prenom');
    const aliases = valuesOf(details, 'ALIAS', 'Alias');
    if (prenoms === null || aliases === null) return refuse('bad_file', entryId);
    if (raw.Nom !== undefined && raw.Nom !== null && typeof raw.Nom !== 'string') return refuse('bad_names', entryId);
    const nom = text(raw.Nom);
    const names: string[] = [];
    if (nom !== null) names.push([nom, ...prenoms].join(' '));
    names.push(...aliases);
    if (names.some((n) => n.length > FREEZE_MAX_NAME_LENGTH)) return refuse('bad_names', entryId);
    // Un alias dans une autre écriture ne donne aucun mot comparable : laissé, comme `importRegistry` le fait.
    const usable = [...new Set(names)].filter((n) => nameTokens(n).length > 0);
    if (usable.length === 0) return refuse('bad_names', entryId);
    if (usable.length > FREEZE_MAX_NAMES) return refuse('too_many_names', entryId);
    entries.push({ entryId, nature, names: usable });
  }
  if (entries.length === 0) return refuse('no_entries');
  return { ok: true, value: { publishedAt, entries, vessels } };
}
