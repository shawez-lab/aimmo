import type { IdentifierKind } from '../db/types.ts';

/**
 * Normalisation des identifiants, pour qu'une même personne ait toujours la même valeur rangée.
 * Rend null quand la valeur n'est pas un identifiant valable : on ne range pas ce qu'on ne comprend pas.
 */
export function normalizeIdentifier(kind: IdentifierKind, raw: string): string | null {
  switch (kind) {
    case 'email':
      return normalizeEmail(raw);
    case 'phone':
    case 'whatsapp':
      return normalizePhone(raw);
    case 'instagram':
      return normalizeInstagram(raw);
    case 'facebook':
      return normalizeFacebook(raw);
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Mail en minuscules, sans espaces ni « mailto: ». Les points et les « + » sont gardés : ce sont d'autres adresses. */
export function normalizeEmail(raw: string): string | null {
  const value = raw.trim().replace(/^mailto:/i, '').toLowerCase();
  return EMAIL.test(value) ? value : null;
}

/**
 * Téléphone au format international E.164 : `+33612345678`.
 * Sans indicatif, un numéro à 10 chiffres commençant par 0 est français. « 00 » vaut « + ».
 */
export function normalizePhone(raw: string): string | null {
  let value = raw.trim().replace(/\(0\)/g, '');
  if (/[^\d\s.+\-()/]/.test(value)) return null;
  value = value.replace(/[\s.\-()/]/g, '');
  if (value.startsWith('00')) value = `+${value.slice(2)}`;
  if (/^0[1-9]\d{8}$/.test(value)) value = `+33${value.slice(1)}`;
  if (/^33[1-9]\d{8}$/.test(value)) value = `+${value}`;
  if (value.startsWith('+330')) value = `+33${value.slice(4)}`;
  if (!/^\+[1-9]\d{7,14}$/.test(value)) return null;
  if (value.startsWith('+33') && value.length !== 12) return null;
  return value;
}

/** Compte Instagram : sans @, sans adresse du site, en minuscules. */
export function normalizeInstagram(raw: string): string | null {
  const value = profileFromUrl(raw.trim(), INSTAGRAM_URL, INSTAGRAM_ROUTES);
  if (value === null) return null;
  const name = value.replace(/^@/, '').toLowerCase();
  return /^[a-z0-9._]{1,30}$/.test(name) ? name : null;
}

/** Compte Facebook : numéro de profil, ou nom de page en minuscules, sans l'adresse du site. */
export function normalizeFacebook(raw: string): string | null {
  const trimmed = raw.trim();
  const byId = trimmed.match(/profile\.php\?(?:.*&)?id=(\d+)/i);
  if (byId?.[1]) return byId[1];
  // Adresse « /people/<nom>/<numéro> » : seul le numéro désigne la personne.
  const people = trimmed.match(/^(?:https?:\/\/)?(?:(?:www|m)\.)?(?:facebook|fb)\.com\/people\/[^/?#]+\/(\d+)/i);
  if (people?.[1]) return people[1];
  const value = profileFromUrl(trimmed, FACEBOOK_URL, FACEBOOK_ROUTES);
  if (value === null) return null;
  const name = value.replace(/^@/, '').toLowerCase();
  return /^[a-z0-9.]{1,50}$/.test(name) ? name : null;
}

const INSTAGRAM_URL = /^(https?:\/\/)?(www\.)?instagram\.com\//i;
const FACEBOOK_URL = /^(https?:\/\/)?((www|m)\.)?(facebook|fb)\.com\//i;
/** Premiers segments d'adresse qui ne sont pas un compte : publication, page technique… */
const INSTAGRAM_ROUTES = new Set(['p', 'reel', 'reels', 'stories', 'explore', 'tv', 'accounts', 'direct']);
const FACEBOOK_ROUTES = new Set([
  'people', 'profile.php', 'pages', 'groups', 'events', 'photo', 'photo.php', 'photos', 'watch', 'share',
  'story.php', 'permalink.php', 'posts', 'marketplace', 'messages', 'login', 'hashtag', 'reel', 'videos',
]);

/**
 * Rend le nom du compte d'une adresse de profil, null pour une adresse qui n'est pas un profil.
 * Une valeur sans adresse du site est rendue telle quelle.
 */
function profileFromUrl(value: string, prefix: RegExp, routes: ReadonlySet<string>): string | null {
  if (!prefix.test(value)) return value;
  const [first = ''] = value.replace(prefix, '').split(/[?#]/)[0]?.split('/') ?? [];
  return first === '' || routes.has(first.toLowerCase()) ? null : first;
}

/** Clé de rapprochement : un numéro WhatsApp et un numéro de téléphone identiques désignent la même personne. */
export function matchKey(kind: IdentifierKind, normalized: string): string {
  return `${kind === 'whatsapp' ? 'phone' : kind}:${normalized}`;
}
