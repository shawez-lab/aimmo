/**
 * Le compartiment des copies (`aimmo-copies`), par l'API S3 de R2 (SV02) : une clé limitée à ce seul compartiment, et non
 * le jeton de déploiement. Signature AWS v4 écrite ici : aucune dépendance pour quelques lignes.
 * Voir https://developers.cloudflare.com/r2/api/s3/
 *
 * Lecture prudente : un morceau ne se réécrit pas (`If-None-Match: *`). Après une panne (5xx, réseau), l'envoi est refait
 * deux fois ; s'il trouve alors la place prise, seul un contenu identique vaut succès. Aucune erreur ne cite une clé.
 */
import type { CopyStore, ObjectSource, StoredObject } from '@aimmo/core';

export interface R2CopiesConfig {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  fetch?: typeof fetch;
  now?: () => Date;
  wait?: (ms: number) => Promise<void>;
}

export class CopyStoreError extends Error {
  override readonly name = 'CopyStoreError';
}

const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (data: Uint8Array<ArrayBuffer>): Promise<string> => hex(await crypto.subtle.digest('SHA-256', data));
const hmac = async (key: ArrayBuffer | Uint8Array<ArrayBuffer>, text: string): Promise<ArrayBuffer> =>
  crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), encoder.encode(text));

export interface SignInput {
  method: string;
  host: string;
  path: string;
  /** La requête, déjà en forme canonique (clés triées, encodées) ; vide par défaut. */
  query?: string;
  /** Les en-têtes à signer, hors `host` et `x-amz-date`, en minuscules. */
  headers: Record<string, string>;
  bodySha256: string;
  amzDate: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** L'en-tête `Authorization` de la signature v4. */
export async function signV4(input: SignInput): Promise<string> {
  const all: Record<string, string> = { ...input.headers, host: input.host, 'x-amz-date': input.amzDate };
  const names = Object.keys(all).sort();
  const canonicalHeaders = names.map((n) => `${n}:${all[n]!.trim()}\n`).join('');
  const signed = names.join(';');
  const canonical = [input.method, input.path, input.query ?? '', canonicalHeaders, signed, input.bodySha256].join('\n');
  const day = input.amzDate.slice(0, 8);
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', input.amzDate, scope, await sha256(encoder.encode(canonical))].join('\n');
  let key = await hmac(encoder.encode(`AWS4${input.secretAccessKey}`), day);
  for (const part of [input.region, 's3', 'aws4_request']) key = await hmac(key, part);
  return `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${hex(await hmac(key, toSign))}`;
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

export function r2CopyStore(config: R2CopiesConfig): CopyStore {
  const http = config.fetch ?? fetch;
  const now = config.now ?? (() => new Date());
  const wait = config.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const host = `${config.accountId}.r2.cloudflarestorage.com`;

  const call = async (method: 'GET' | 'PUT', key: string, body?: Uint8Array<ArrayBuffer>, extra: Record<string, string> = {}): Promise<Response> => {
    const path = `/${config.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
    const bodySha256 = await sha256(body ?? new Uint8Array());
    const amzDate = now().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const headers = { ...extra, 'x-amz-content-sha256': bodySha256 };
    const authorization = await signV4({ method, host, path, headers, bodySha256, amzDate, region: 'auto', accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey });
    return http(`https://${host}${path}`, { method, headers: { ...headers, 'x-amz-date': amzDate, authorization }, ...(body ? { body } : {}) });
  };

  const get = async (key: string): Promise<Uint8Array | null> => {
    let response: Response;
    try {
      response = await call('GET', key);
    } catch {
      throw new CopyStoreError('Stockage des copies injoignable.');
    }
    if (response.status === 404) return null;
    if (!response.ok) throw new CopyStoreError(`Stockage des copies : lecture refusée (${response.status}).`);
    return new Uint8Array(await response.arrayBuffer());
  };

  return {
    get,
    async put(key, bytes) {
      const body = Uint8Array.from(bytes);
      for (let attempt = 0; ; attempt += 1) {
        let status = 0;
        try {
          status = (await call('PUT', key, body, { 'if-none-match': '*' })).status;
        } catch {
          status = 0;
        }
        if (status >= 200 && status < 300) return;
        if (status === 412) {
          // Déjà là : seul le retour d'un envoi dont la réponse s'est perdue est admis.
          const seen = attempt > 0 ? await get(key) : null;
          if (seen && sameBytes(seen, body)) return;
          throw new CopyStoreError('Stockage des copies : cette place est déjà prise.');
        }
        if ((status !== 0 && status < 500) || attempt >= 2) throw new CopyStoreError(`Stockage des copies : envoi refusé (${status}).`);
        await wait(500 * 2 ** attempt);
      }
    },
  };
}

/** L'encodage des chemins et des requêtes de la signature v4 (RFC 3986) : `encodeURIComponent` laisse passer !'()*. */
export const uriEncode = (text: string): string => encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescapeXml = (text: string): string =>
  text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_, e: string) =>
    e.startsWith('#x') ? String.fromCodePoint(parseInt(e.slice(2), 16)) : e.startsWith('#') ? String.fromCodePoint(Number(e.slice(1))) : XML_ENTITIES[e]!,
  );

/** Une page de `ListObjectsV2` : les clés, et le jeton de la suivante si la liste est coupée. */
export function parseListPage(xml: string): { keys: string[]; next: string | null } {
  const keys = [...xml.matchAll(/<Contents>[\s\S]*?<Key>([\s\S]*?)<\/Key>[\s\S]*?<\/Contents>/g)].map((m) => unescapeXml(m[1]!));
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/.test(xml);
  const token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
  if (truncated && !token) throw new CopyStoreError('Stockage des objets : liste coupée sans suite.');
  return { keys, next: truncated ? unescapeXml(token!) : null };
}

export interface R2SourceConfig {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Les compartiments des objets sont en Europe (HX56) : leur adresse S3 le dit. */
  jurisdiction?: 'eu';
  fetch?: typeof fetch;
  now?: () => Date;
}

/**
 * Un compartiment d'objets lu par l'API S3 de R2 (AU019b), avec une clé en lecture seule : il liste toutes ses clés,
 * page après page, et lit un objet avec son type. Une erreur ne cite ni clé ni contenu.
 */
export function r2ObjectSource(config: R2SourceConfig): ObjectSource {
  const http = config.fetch ?? fetch;
  const now = config.now ?? (() => new Date());
  const host = `${config.accountId}${config.jurisdiction === 'eu' ? '.eu' : ''}.r2.cloudflarestorage.com`;
  const emptySha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  const call = async (path: string, params: Record<string, string> = {}): Promise<Response> => {
    const query = Object.keys(params)
      .sort()
      .map((k) => `${uriEncode(k)}=${uriEncode(params[k]!)}`)
      .join('&');
    const amzDate = now().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const headers = { 'x-amz-content-sha256': emptySha };
    const authorization = await signV4({ method: 'GET', host, path, query, headers, bodySha256: emptySha, amzDate, region: 'auto', accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey });
    try {
      return await http(`https://${host}${path}${query ? `?${query}` : ''}`, { method: 'GET', headers: { ...headers, 'x-amz-date': amzDate, authorization } });
    } catch {
      throw new CopyStoreError('Stockage des objets injoignable.');
    }
  };

  return {
    async list() {
      const keys: string[] = [];
      let token: string | null = null;
      for (let page = 0; ; page += 1) {
        if (page > 100_000) throw new CopyStoreError('Stockage des objets : liste sans fin.');
        const params: Record<string, string> = { 'list-type': '2', 'max-keys': '1000' };
        if (token) params['continuation-token'] = token;
        const response = await call(`/${config.bucket}`, params);
        if (!response.ok) throw new CopyStoreError(`Stockage des objets : liste refusée (${response.status}).`);
        const { keys: found, next } = parseListPage(await response.text());
        keys.push(...found);
        if (!next) return keys;
        token = next;
      }
    },
    async get(key): Promise<StoredObject | null> {
      const response = await call(`/${config.bucket}/${key.split('/').map(uriEncode).join('/')}`);
      if (response.status === 404) return null;
      if (!response.ok) throw new CopyStoreError(`Stockage des objets : lecture refusée (${response.status}).`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const type = response.headers.get('content-type');
      return type ? { bytes, contentType: type } : { bytes };
    },
  };
}
