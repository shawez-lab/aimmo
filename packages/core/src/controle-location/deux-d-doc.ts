/**
 * Lecture et vérification d'un code 2D-Doc (HX47) [R531].
 *
 * Un 2D-Doc est le code carré imprimé par l'émetteur d'un document (ici l'administration fiscale sur l'avis d'impôt) :
 * un en-tête, les données du document, puis la signature de l'émetteur. Le téléphone de l'agent lit le code et en
 * rend le texte ; le code d'AIMMO vérifie la signature contre le certificat de l'émetteur, tiré de la liste de
 * confiance publiée par l'ANTS (port `TrustList`).
 *
 * Décidé, lecture prudente :
 * - une signature qui ne correspond pas aux données est un écart : le code a été changé après sa signature ;
 * - un certificat que la liste ne connaît pas, une liste injoignable, un code illisible ou un dictionnaire qui ne
 *   reconnaît pas un champ rendent « non vérifiable », jamais « écart » : l'absence de preuve n'est pas une preuve ;
 * - le dictionnaire des champs de l'avis d'impôt est un dictionnaire de travail, à confirmer sur la spécification de
 *   l'ANTS : s'il se trompe, la lecture échoue (non vérifiable), la signature, elle, reste vérifiée ;
 * - les valeurs lues ne sortent jamais de ce fichier vers la base ni le journal : seul le constat est rangé [R534].
 */

const GS = '\u001d';
const RS = '\u001e';
const US = '\u001f';

export interface TwoDDocHeader {
  version: number;
  caId: string;
  certId: string;
  docType: string;
}

export interface TwoDDocParsed {
  header: TwoDDocHeader;
  /** Ce qui est signé : l'en-tête et les données, jusqu'au séparateur de la signature. */
  signed: string;
  /** La signature, décodée de sa base 32. */
  signature: Uint8Array;
  /** Les données : identifiant de champ → valeur. `null` quand un champ n'est pas au dictionnaire. */
  fields: Record<string, string> | null;
}

/** Un champ du dictionnaire : longueur fixe, ou variable entre deux bornes (terminé par GS, RS ou la fin). */
interface FieldSpec {
  name: string;
  fixed?: number;
  min?: number;
  max?: number;
  /** La forme de la valeur : un séparateur perdu à la lecture colle deux champs, qui n'ont plus cette forme. */
  pattern?: RegExp;
}

/**
 * Dictionnaire de travail des champs de l'avis d'impôt sur le revenu (à confirmer sur la spécification de l'ANTS ;
 * un champ inconnu rend la lecture non vérifiable, jamais un écart).
 */
export const TAX_NOTICE_FIELDS: Readonly<Record<string, FieldSpec>> = Object.freeze({
  '41': { name: 'revenu_fiscal', min: 1, max: 12, pattern: /^\d+$/ },
  '43': { name: 'parts', min: 1, max: 5, pattern: /^\d{1,2}(\.\d{1,2})?$/ },
  '44': { name: 'reference_avis', fixed: 13, pattern: /^[0-9A-Z]{13}$/ },
  '45': { name: 'annee_revenus', fixed: 4, pattern: /^\d{4}$/ },
  '46': { name: 'declarant_1', min: 1, max: 38, pattern: /^[^\u001d-\u001f]+$/ },
  '47': { name: 'numero_fiscal_1', fixed: 13, pattern: /^\d{13}$/ },
  '48': { name: 'declarant_2', min: 1, max: 38, pattern: /^[^\u001d-\u001f]+$/ },
  '49': { name: 'numero_fiscal_2', fixed: 13, pattern: /^\d{13}$/ },
  '4A': { name: 'date_recouvrement', fixed: 8, pattern: /^\d{8}$/ },
});

/** Sortes de document de l'avis d'impôt sur le revenu admises (dictionnaire de travail, comme les champs). */
export const TAX_NOTICE_DOC_TYPES: readonly string[] = Object.freeze(['28']);

const HEADER_LENGTH: Readonly<Record<number, number>> = { 1: 22, 2: 22, 3: 24, 4: 26 };
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(text: string): Uint8Array | null {
  const clean = text.replace(/=+$/, '');
  if (!/^[A-Z2-7]*$/.test(clean)) return null;
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function parseFields(message: string, dictionary: Readonly<Record<string, FieldSpec>>): Record<string, string> | null {
  const fields: Record<string, string> = {};
  let i = 0;
  while (i < message.length) {
    const id = message.slice(i, i + 2);
    const spec = Object.prototype.hasOwnProperty.call(dictionary, id) ? dictionary[id] : undefined;
    if (!spec || id.length < 2 || Object.prototype.hasOwnProperty.call(fields, spec.name)) return null;
    i += 2;
    let value: string;
    if (spec.fixed !== undefined) {
      value = message.slice(i, i + spec.fixed);
      if (value.length !== spec.fixed || /[\u001d\u001e]/.test(value)) return null;
      i += spec.fixed;
      // Un séparateur est toléré après un champ de longueur fixe.
      if (message[i] === GS) i += 1;
    } else {
      let end = i;
      while (end < message.length && message[end] !== GS && message[end] !== RS) end += 1;
      value = message.slice(i, end);
      if (value.length < (spec.min ?? 0) || value.length > (spec.max ?? Infinity)) return null;
      i = end < message.length ? end + 1 : end;
    }
    if (spec.pattern && !spec.pattern.test(value)) return null;
    fields[spec.name] = value;
  }
  return fields;
}

/** Lit le texte d'un 2D-Doc ; `null` s'il n'en a pas la forme. Les champs sont `null` si le dictionnaire ne suffit pas. */
export function parseTwoDDoc(raw: unknown, dictionary: Readonly<Record<string, FieldSpec>> = TAX_NOTICE_FIELDS): TwoDDocParsed | null {
  if (typeof raw !== 'string' || raw.length > 2000 || !raw.startsWith('DC')) return null;
  const version = Number.parseInt(raw.slice(2, 4), 10);
  const headerLength = HEADER_LENGTH[version];
  if (!/^\d\d$/.test(raw.slice(2, 4)) || headerLength === undefined || raw.length < headerLength) return null;
  const header = raw.slice(0, headerLength);
  if (!/^DC\d\d[A-Z0-9]{4}[A-Z0-9]{4}[0-9A-F]{4}[0-9A-F]{4}[A-Z0-9]{2}/.test(header)) return null;
  const cut = raw.indexOf(US, headerLength);
  if (cut < 0 || raw.indexOf(US, cut + 1) >= 0) return null;
  const signature = base32Decode(raw.slice(cut + 1));
  if (!signature || signature.length === 0) return null;
  return {
    header: { version, caId: header.slice(4, 8), certId: header.slice(8, 12), docType: header.slice(20, 22) },
    signed: raw.slice(0, cut),
    signature,
    fields: parseFields(raw.slice(headerLength, cut), dictionary),
  };
}

/** La clé publique d'un certificat d'émetteur, au format JWK (courbe elliptique). */
export interface EcPublicJwk {
  kty: string;
  crv?: string;
  x?: string;
  y?: string;
}

/** Le certificat d'un émetteur, tel que la liste de confiance de l'ANTS le publie. */
export type TrustAnswer =
  | { status: 'known'; publicKey: EcPublicJwk; revoked: boolean }
  | { status: 'unknown' }
  | { status: 'unavailable' };

/** La liste de confiance des émetteurs de 2D-Doc (ANTS). Le vrai branchement est à faire ; les tests en ont une fausse. */
export interface TrustList {
  certificate(caId: string, certId: string): Promise<TrustAnswer>;
}

export type SignatureOutcome = 'valid' | 'invalid' | 'unknown_certificate' | 'revoked_certificate' | 'unavailable' | 'unreadable';

/** Vérifie la signature d'un 2D-Doc lu ; ne lève jamais. */
export async function verifyTwoDDoc(parsed: TwoDDocParsed, trust: TrustList): Promise<SignatureOutcome> {
  let answer: TrustAnswer;
  try {
    answer = await trust.certificate(parsed.header.caId, parsed.header.certId);
  } catch {
    return 'unavailable';
  }
  if (answer.status === 'unknown') return 'unknown_certificate';
  if (answer.status === 'unavailable') return 'unavailable';
  if (answer.revoked) return 'revoked_certificate';
  const curve = answer.publicKey.crv;
  const hash = curve === 'P-256' ? 'SHA-256' : curve === 'P-384' ? 'SHA-384' : curve === 'P-521' ? 'SHA-512' : null;
  const size = curve === 'P-256' ? 64 : curve === 'P-384' ? 96 : 132;
  if (hash === null || answer.publicKey.kty !== 'EC') return 'unavailable';
  // Une signature d'une autre longueur que celle de la courbe : un code mal lu, pas une preuve.
  if (parsed.signature.length !== size) return 'unreadable';
  try {
    // Les types du DOM ne sont pas chargés ici : la clé est passée telle quelle, au format JWK.
    const key = await crypto.subtle.importKey('jwk', answer.publicKey as never, { name: 'ECDSA', namedCurve: curve! }, false, ['verify']);
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash }, key, parsed.signature, new TextEncoder().encode(parsed.signed));
    return ok ? 'valid' : 'invalid';
  } catch {
    return 'unavailable';
  }
}
