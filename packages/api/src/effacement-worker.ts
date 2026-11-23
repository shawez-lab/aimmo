/**
 * SV05 · L'effacement réel branché au Worker, en essai tant que H29 et H50 ne sont pas faits.
 *
 * Décision de Shawez (2026-11-23) : ce qui attend l'avocat se construit et se teste en essai, activé plus tard. Ici, le
 * Worker sait monter tout ce qu'il faut à l'effacement réel d'AU020, mais ne le monte que si la direction a tout rangé :
 *
 * - `ERASURE_MODE` écrit `reel` tel quel ; toute autre valeur, ou rien, garde l'essai : rien n'est effacé, rien n'est lu
 *   des secrets, aucun appel ne part ;
 * - le registre des effacements vit dans le compartiment des copies (`aimmo-copies`), par l'API S3 de R2, avec la même
 *   clé limitée et la même clé de chiffrement que la copie de chaque nuit (`CLOUDFLARE_ACCOUNT_ID`,
 *   `COPIES_R2_ACCESS_KEY_ID`, `COPIES_R2_SECRET_ACCESS_KEY`, `COPY_KEY`). Un réglage manque ou la clé est mal formée :
 *   pas de registre, et la route refuse avant d'effacer (`ledger_missing`) [R231] ;
 * - le Worker ne touche dans ce compartiment qu'au préfixe `effacements/` : il ne lit, n'écrit ni ne liste jamais les
 *   copies elles-mêmes ;
 * - les fichiers sont retirés de leurs compartiments liés (`MEDIA`, `PIECES`, `COMMERCES`, `COFFRE`). Un compartiment
 *   absent ou qui ne sait pas retirer lève : le fichier reste noté à retirer, l'effacement est dit incomplet, jamais fait, et le refaire finira [R17].
 *
 * Un effacement non noté au registre n'est jamais dit fait [R231] : `EffacementReel` note avant d'effacer, et refuse
 * (`ledger_unwritable`) si la note échoue.
 */
import { copyKeyFromSecret, conformite, type CopyKey, type ErasureLedgerStore, type ObjectStorage } from '@aimmo/core';
import { r2CopyStore } from '../outils/r2-copies.ts';
import type { ConformiteServices } from './conformite.ts';

/** Le compartiment des copies, le même que celui de la copie de chaque nuit (SV02). */
export const ERASURE_LEDGER_BUCKET = 'aimmo-copies';
/** Le seul préfixe que le Worker touche dans ce compartiment. */
export const ERASURE_LEDGER_PREFIX = 'effacements/';

/** Un compartiment R2 lié qui sait retirer un objet. */
export interface R2Deletable {
  delete(key: string): Promise<unknown>;
}

export interface ErasureEnv {
  ERASURE_MODE?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  COPIES_R2_ACCESS_KEY_ID?: string;
  COPIES_R2_SECRET_ACCESS_KEY?: string;
  COPY_KEY?: string;
  MEDIA?: unknown;
  PIECES?: unknown;
  COMMERCES?: unknown;
  COFFRE?: unknown;
}

export type WorkerErasure = NonNullable<ConformiteServices['erasure']>;

/** Le registre, et rien d'autre : une clé hors de `effacements/` est refusée avant tout appel. */
export function ledgerOnly(store: ErasureLedgerStore): ErasureLedgerStore {
  const inside = (key: string): string => {
    if (typeof key !== 'string' || !key.startsWith(ERASURE_LEDGER_PREFIX) || key.includes('..')) throw new Error('Registre des effacements : hors de son préfixe.');
    return key;
  };
  return {
    put: async (key, bytes) => store.put(inside(key), bytes),
    get: async (key) => store.get(inside(key)),
    list: async (prefix) => {
      const keys = await store.list(inside(prefix));
      if (keys.some((k) => !k.startsWith(ERASURE_LEDGER_PREFIX))) throw new Error('Registre des effacements : liste hors de son préfixe.');
      return keys;
    },
  };
}

const deletable = (bucket: unknown): R2Deletable | null =>
  bucket !== null && typeof bucket === 'object' && typeof (bucket as { delete?: unknown }).delete === 'function' ? (bucket as R2Deletable) : null;

/** Retirer un fichier de son compartiment lié ; un compartiment absent ou sans retrait lève, sans citer la clé. */
export function r2ObjectEraser(env: Pick<ErasureEnv, ObjectStorage>): conformite.ObjectEraser {
  return {
    async remove(storage, key) {
      const bucket = deletable(env[storage]);
      if (!bucket) throw new Error(`Compartiment ${storage} absent : le fichier n'est pas retiré.`);
      await bucket.delete(key);
    },
  };
}

const filled = (value: string | undefined): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

/** La clé des copies, ou `null` si elle manque ou est mal formée : jamais d'erreur qui la cite. */
async function copyKeyOf(secret: string | undefined): Promise<CopyKey | null> {
  const value = filled(secret);
  if (!value) return null;
  try {
    return await copyKeyFromSecret(value);
  } catch {
    return null;
  }
}

/**
 * Ce que l'effacement réel reçoit du Worker. En essai (le cas tant que H29 n'est pas fait) : ni registre ni stockage,
 * et aucun secret n'est lu.
 */
export async function erasureOf(env: ErasureEnv, http: typeof fetch = fetch): Promise<WorkerErasure> {
  const mode = conformite.erasureModeOf(env.ERASURE_MODE);
  if (mode !== 'reel') return { mode, ledger: null, objects: null };
  const accountId = filled(env.CLOUDFLARE_ACCOUNT_ID);
  const accessKeyId = filled(env.COPIES_R2_ACCESS_KEY_ID);
  const secretAccessKey = filled(env.COPIES_R2_SECRET_ACCESS_KEY);
  const key = await copyKeyOf(env.COPY_KEY);
  const ledger =
    accountId && accessKeyId && secretAccessKey && key
      ? { store: ledgerOnly(r2CopyStore({ accountId, bucket: ERASURE_LEDGER_BUCKET, accessKeyId, secretAccessKey, fetch: http })), key }
      : null;
  return { mode, ledger, objects: r2ObjectEraser(env as Pick<ErasureEnv, ObjectStorage>) };
}
