/**
 * Vérification d'une clé d'accès WebAuthn (HX56) [R600, R601]. Des fonctions pures, sans base.
 *
 * Décidé, lecture prudente :
 * - ES256 seulement (P-256, SHA-256, COSE -7), la courbe que proposent tous les téléphones et ordinateurs ;
 * - présence et vérification de l'utilisateur exigées à chaque geste (drapeaux UP et UV) : l'empreinte, le visage ou
 *   le code de l'appareil, jamais un simple contact ;
 * - origine exacte parmi celles réglées, identifiant du site exact, défi exact, type exact (`webauthn.create` à
 *   l'enregistrement, `webauthn.get` ensuite) ;
 * - la clé publique arrive au format SPKI, tel que le rend `AuthenticatorAttestationResponse.getPublicKey()` du
 *   navigateur ; l'identifiant de la clé doit être celui que porte la donnée de l'authentificateur.
 */

export const ES256 = -7;
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export type WebAuthnCode =
  | 'bad_input'
  | 'bad_client_data'
  | 'wrong_type'
  | 'wrong_challenge'
  | 'wrong_origin'
  | 'wrong_rp'
  | 'no_user_presence'
  | 'no_user_verification'
  | 'wrong_credential'
  | 'bad_key'
  | 'bad_signature';

export type WebAuthnResult<T> = { ok: true; value: T } | { ok: false; code: WebAuthnCode };

const B64URL = /^[A-Za-z0-9_-]+$/;

export function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** `null` pour tout texte qui n'est pas du base64url sans remplissage, ou trop long. */
export function fromBase64Url(text: unknown, maxBytes = 4096): Uint8Array | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > Math.ceil((maxBytes * 4) / 3) || !B64URL.test(text)) return null;
  if (text.length % 4 === 1) return null;
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  let bin: string;
  try {
    bin = atob(padded);
  } catch {
    return null;
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  // Un seul texte pour une même suite d'octets : pas de bits de fin ignorés.
  if (toBase64Url(out) !== text) return null;
  return out;
}

export async function sha256(bytes: Uint8Array | string): Promise<Uint8Array> {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource));
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export interface AuthenticatorData {
  rpIdHash: Uint8Array;
  flags: number;
  signCount: number;
  /** L'identifiant de la clé, seulement quand la donnée porte la clé attestée (enregistrement). */
  credentialId: Uint8Array | null;
}

export function parseAuthenticatorData(bytes: Uint8Array): AuthenticatorData | null {
  if (bytes.length < 37) return null;
  const flags = bytes[32]!;
  const signCount = ((bytes[33]! << 24) >>> 0) + (bytes[34]! << 16) + (bytes[35]! << 8) + bytes[36]!;
  let credentialId: Uint8Array | null = null;
  if (flags & FLAG_AT) {
    // AAGUID (16 octets), longueur de l'identifiant (2 octets), identifiant, puis la clé COSE.
    if (bytes.length < 37 + 18) return null;
    const len = (bytes[53]! << 8) + bytes[54]!;
    if (len === 0 || len > 1023 || bytes.length < 55 + len + 1) return null;
    credentialId = bytes.slice(55, 55 + len);
  }
  return { rpIdHash: bytes.slice(0, 32), flags, signCount, credentialId };
}

interface ClientData {
  type: string;
  challenge: string;
  origin: string;
}

export function parseClientData(bytes: Uint8Array): ClientData | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.type !== 'string' || typeof o.challenge !== 'string' || typeof o.origin !== 'string') return null;
  // Une page d'un autre site qui encadre la nôtre ne vaut pas.
  if (o.crossOrigin !== undefined && o.crossOrigin !== false) return null;
  return { type: o.type, challenge: o.challenge, origin: o.origin };
}

/** Une signature ECDSA au format DER (celui de WebAuthn) vers les 64 octets r‖s de WebCrypto. `null` si mal formée. */
export function derToRaw(der: Uint8Array): Uint8Array | null {
  if (der.length < 8 || der.length > 72 || der[0] !== 0x30 || der[1] !== der.length - 2) return null;
  const out = new Uint8Array(64);
  let at = 2;
  for (let part = 0; part < 2; part += 1) {
    if (der[at] !== 0x02) return null;
    const len = der[at + 1]!;
    if (len === 0 || len > 33 || at + 2 + len > der.length) return null;
    let value = der.slice(at + 2, at + 2 + len);
    // Pas de zéro de tête inutile, pas de nombre négatif.
    if (value[0]! & 0x80) return null;
    if (value.length > 1 && value[0] === 0 && !(value[1]! & 0x80)) return null;
    if (value[0] === 0) value = value.slice(1);
    if (value.length > 32) return null;
    out.set(value, part * 32 + (32 - value.length));
    at += 2 + len;
  }
  return at === der.length ? out : null;
}

export async function importEs256(spki: Uint8Array): Promise<CryptoKey | null> {
  try {
    return await crypto.subtle.importKey('spki', spki as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  } catch {
    return null;
  }
}

export interface Expected {
  type: 'webauthn.create' | 'webauthn.get';
  challenge: string;
  origins: readonly string[];
  rpId: string;
}

async function checkCommon(clientDataJSON: Uint8Array, authData: Uint8Array, expected: Expected): Promise<WebAuthnResult<AuthenticatorData>> {
  const client = parseClientData(clientDataJSON);
  if (client === null) return { ok: false, code: 'bad_client_data' };
  if (client.type !== expected.type) return { ok: false, code: 'wrong_type' };
  if (!equalBytes(new TextEncoder().encode(client.challenge), new TextEncoder().encode(expected.challenge))) return { ok: false, code: 'wrong_challenge' };
  if (!expected.origins.includes(client.origin)) return { ok: false, code: 'wrong_origin' };
  const data = parseAuthenticatorData(authData);
  if (data === null) return { ok: false, code: 'bad_input' };
  if (!equalBytes(data.rpIdHash, await sha256(expected.rpId))) return { ok: false, code: 'wrong_rp' };
  if (!(data.flags & FLAG_UP)) return { ok: false, code: 'no_user_presence' };
  if (!(data.flags & FLAG_UV)) return { ok: false, code: 'no_user_verification' };
  return { ok: true, value: data };
}

export interface RegistrationInput {
  credentialId: Uint8Array;
  publicKey: Uint8Array;
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
}

/** L'enregistrement d'une clé : le défi, l'origine, le site, l'empreinte ou le visage, et une clé ES256 lisible. */
export async function verifyRegistration(input: RegistrationInput, expected: Expected): Promise<WebAuthnResult<{ signCount: number }>> {
  const common = await checkCommon(input.clientDataJSON, input.authenticatorData, expected);
  if (!common.ok) return common;
  if (common.value.credentialId === null || !equalBytes(common.value.credentialId, input.credentialId)) return { ok: false, code: 'wrong_credential' };
  if ((await importEs256(input.publicKey)) === null) return { ok: false, code: 'bad_key' };
  return { ok: true, value: { signCount: common.value.signCount } };
}

export interface AssertionInput {
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
  signature: Uint8Array;
}

/** Une signature de l'appareil sur la donnée de l'authentificateur suivie de l'empreinte de la donnée du client. */
export async function verifyAssertion(input: AssertionInput, publicKey: Uint8Array, expected: Expected): Promise<WebAuthnResult<{ signCount: number }>> {
  const common = await checkCommon(input.clientDataJSON, input.authenticatorData, expected);
  if (!common.ok) return common;
  const key = await importEs256(publicKey);
  if (key === null) return { ok: false, code: 'bad_key' };
  const raw = derToRaw(input.signature);
  if (raw === null) return { ok: false, code: 'bad_signature' };
  const clientHash = await sha256(input.clientDataJSON);
  const signed = new Uint8Array(input.authenticatorData.length + clientHash.length);
  signed.set(input.authenticatorData, 0);
  signed.set(clientHash, input.authenticatorData.length);
  const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, raw as BufferSource, signed as BufferSource);
  if (!valid) return { ok: false, code: 'bad_signature' };
  return { ok: true, value: { signCount: common.value.signCount } };
}
