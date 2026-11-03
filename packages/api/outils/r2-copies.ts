/**
 * Le compartiment des copies (`aimmo-copies`), par l'API S3 de R2 (SV02) : une clé limitée à ce seul compartiment, et non
 * le jeton de déploiement. Signature AWS v4 écrite ici : aucune dépendance pour quelques lignes.
 * Voir https://developers.cloudflare.com/r2/api/s3/
 *
 * Lecture prudente : un morceau ne se réécrit pas (`If-None-Match: *`). Après une panne (5xx, réseau), l'envoi est refait
 * deux fois ; s'il trouve alors la place prise, seul un contenu identique vaut succès. Aucune erreur ne cite une clé.
 */
import type { CopyStore } from '@aimmo/core';

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
  const canonical = [input.method, input.path, '', canonicalHeaders, signed, input.bodySha256].join('\n');
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
