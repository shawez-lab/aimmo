/**
 * Les vrais canaux Facebook et Instagram de la publication (AU036), derrière l'interface `SocialChannel` de X05.
 *
 * Ils ne sont faits que par le Worker, et seulement quand tout est rangé : le mode `reel` déclaré, la page du réseau,
 * son compte Instagram, son jeton (un secret) et l'adresse publique des photos. Sinon les canaux restent d'essai
 * [R26, R134]. La classe `Publications` ne les admet qu'avec sa mise en service explicite (`live`).
 *
 * Une publication réelle :
 * - Facebook : chaque photo rangée sans être publiée, puis un seul message sur la page qui les porte, avec le lien
 *   marqué vers la page du bien à la fin ;
 * - Instagram : un conteneur par photo (un carrousel au-delà d'une), puis sa publication ; le lien n'y est pas
 *   cliquable, il n'est pas ajouté ;
 * - puis le lien public de la publication est relu chez le réseau : c'est lui que l'agent voit, pas une adresse
 *   devinée. Une relecture qui échoue laisse la publication faite, sans lien.
 *
 * Une image aménagée porte sa mention sur l'image même (R132, liste de contrôle) ; la légende le redit en plus.
 *
 * Chaque échec devient une erreur `SocialSendError` avec un code fermé et ce que l'agent peut faire : réessayer
 * (réseau indisponible, limite atteinte), reconnecter (jeton expiré, droits retirés), relier (compte de l'agent pas
 * encore relié), corriger (contenu ou visuel refusé, qui ne repart jamais tel quel), vérifier (la réponse de l'appel
 * qui publie s'est perdue : la publication a pu être faite, elle n'est jamais refaite). Ni le jeton, ni le texte, ni la
 * réponse du réseau ne sortent d'ici : seul le code [R13].
 *
 * Retirer (R42) : `DELETE` sur la publication, chez Facebook comme chez Instagram ; seul un succès explicite la tient
 * pour retirée.
 */
import { SocialSendError, type SocialChannel, type SocialPayload } from './publications.ts';

export const META_GRAPH_VERSION = 'v21.0';
const GRAPH = `https://graph.facebook.com/${META_GRAPH_VERSION}`;
const ID = /^[0-9]{1,32}$/;

/** Le compte du réseau chez Meta : la page Facebook, le compte Instagram professionnel relié, et le jeton de la page. */
export interface MetaAccount {
  pageId: string;
  igUserId: string;
  /** Un secret du Worker, jamais écrit ailleurs. */
  token: string;
}

export interface MetaChannelsConfig {
  /** Le compte du réseau. Les comptes des agents ne sont pas encore reliés : leurs envois disent « relier ». */
  network: MetaAccount;
  /** L'adresse publique d'une photo certifiée, en https, lue par Meta pour la publier. */
  mediaUrl(ref: string): string | null;
  /** L'appel HTTP vers l'API Graph et vers les photos, donné par le Worker seul. */
  http: typeof fetch;
  timeoutMs?: number;
}

type Json = Record<string, unknown>;

/** Le code fermé et l'action d'une erreur de l'API Graph, sans jamais garder son message. */
export function metaError(status: number, body: unknown): SocialSendError {
  const err = body !== null && typeof body === 'object' ? ((body as Json).error as Json | undefined) : undefined;
  const code = typeof err?.code === 'number' ? err.code : null;
  if (code === 190 || code === 102) return new SocialSendError('jeton_expire', 'reconnecter');
  if (code === 10 || (code !== null && code >= 200 && code <= 299)) return new SocialSendError('droits_manquants', 'reconnecter');
  if (code === 4 || code === 17 || code === 32 || code === 613 || code === 9 || status === 429) return new SocialSendError('limite_atteinte', 'reessayer');
  if (code === 368 || code === 100 || code === 324 || code === 36003 || code === 9004) return new SocialSendError('contenu_refuse', 'corriger');
  if (status >= 500 || code === 1 || code === 2) return new SocialSendError('reseau_indisponible', 'reessayer');
  return new SocialSendError('erreur_reseau', 'reessayer');
}

/** La légende : le texte validé, la mention des images aménagées, et le lien quand le réseau le rend cliquable. */
export function caption(payload: SocialPayload, withLink: boolean): string {
  const staged = payload.visuals.flatMap((v, i) => (v.overlay ? [i + 1] : []));
  const parts = [payload.text];
  if (staged.length > 0) parts.push(`${staged.length === 1 ? 'Image' : 'Images'} n° ${staged.join(', ')} : aménagement virtuel.`);
  if (withLink && payload.link) parts.push(payload.link);
  return parts.join('\n\n');
}

export function metaSocialChannels(config: MetaChannelsConfig): SocialChannel[] {
  const { network } = config;
  if (!ID.test(network.pageId) || !ID.test(network.igUserId) || network.token.trim() === '') throw new Error('Compte Meta incomplet');
  const doFetch = config.http;
  const timeoutMs = config.timeoutMs ?? 15_000;

  /**
   * Un appel à l'API Graph. `final` : l'appel qui publie. Sa réponse perdue (réseau coupé, délai dépassé, panne du
   * réseau, réponse illisible) ne dit pas si la publication est faite : l'issue est inconnue, à vérifier, jamais refaite.
   * Seul un refus clair de Meta (une erreur 4xx avec son code) dit qu'elle ne l'est pas.
   */
  /** L'appel brut : le statut et le corps lu, ou null si le réseau n'a pas répondu. */
  const raw = async (method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, string>): Promise<{ res: Response; data: unknown } | null> => {
    const body = new URLSearchParams({ ...params, access_token: network.token });
    let res: Response;
    try {
      res = await doFetch(method === 'POST' ? `${GRAPH}/${path}` : `${GRAPH}/${path}?${body.toString()}`, {
        method,
        ...(method === 'POST' ? { body, headers: { 'content-type': 'application/x-www-form-urlencoded' } } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return null;
    }
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { res, data };
  };
  const call = async (method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, string>, final = false): Promise<Json> => {
    const lost = (): SocialSendError => (final ? new SocialSendError('issue_inconnue', 'verifier', true) : new SocialSendError('reseau_indisponible', 'reessayer'));
    const got = await raw(method, path, params);
    if (!got) throw lost();
    const { res, data } = got;
    const refused = data !== null && typeof data === 'object' && typeof ((data as Json).error as Json | undefined)?.code === 'number';
    if (final && !refused && (!res.ok || data === null || typeof data !== 'object')) throw lost();
    if (final && refused && res.status >= 500) throw lost();
    if (!res.ok || data === null || typeof data !== 'object' || (data as Json).error) throw metaError(res.status, data);
    return data as Json;
  };
  const idOf = (data: Json, final = false): string => {
    const id = data.id ?? data.post_id;
    if (typeof id !== 'string' || !/^[0-9_]{1,64}$/.test(id)) throw final ? new SocialSendError('reponse_illisible', 'verifier', true) : new SocialSendError('reponse_illisible', 'reessayer');
    return id;
  };
  /**
   * Retirer une publication [R42]. Elle n'est tenue pour retirée que sur un succès explicite du réseau. Tout le reste,
   * même une publication que le réseau dit introuvable (le même code couvre des droits perdus), reste dû et se
   * réessaie ; l'écart se voit au journal.
   */
  const remove = async (postRef: string, account: SocialPayload['account']): Promise<void> => {
    if (account !== 'reseau') throw new SocialSendError('compte_non_relie', 'relier');
    if (!/^[0-9_]{1,64}$/.test(postRef)) throw new SocialSendError('reference_illisible', 'verifier');
    let done: Json;
    try {
      done = await call('DELETE', postRef, {});
    } catch (error) {
      throw error instanceof SocialSendError ? new SocialSendError(error.code, error.action === 'corriger' ? 'reessayer' : error.action) : new SocialSendError('erreur_reseau', 'reessayer');
    }
    if (done.success !== true) throw new SocialSendError('retrait_non_confirme', 'reessayer');
  };
  /**
   * Chaque photo doit se lire à son adresse publique avant d'envoyer quoi que ce soit : une photo que le site ne sert
   * pas encore (bien pas encore publié sur le site, photo hors de sa version publiée) attend, à réessayer.
   */
  const reachable = async (images: readonly string[]): Promise<void> => {
    for (const url of images) {
      let ok = false;
      try {
        const res = await doFetch(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) });
        ok = res.ok && /^image\//.test(res.headers.get('content-type') ?? 'image/jpeg');
      } catch {
        ok = false;
      }
      if (!ok) throw new SocialSendError('visuel_non_servi', 'reessayer');
    }
  };
  /** Le lien public relu chez le réseau, en https chez Facebook ou Instagram seulement ; sinon null. */
  const permalink = async (id: string, field: 'permalink_url' | 'permalink'): Promise<string | null> => {
    try {
      const url = (await call('GET', id, { fields: field }))[field];
      if (typeof url !== 'string') return null;
      const u = new URL(url);
      return u.protocol === 'https:' && /(^|\.)(facebook|instagram)\.com$/.test(u.hostname) ? u.toString() : null;
    } catch {
      return null;
    }
  };
  const urls = (payload: SocialPayload): string[] => {
    if (payload.visuals.length === 0) throw new SocialSendError('sans_visuel', 'corriger');
    return payload.visuals.map((v) => {
      const u = config.mediaUrl(v.ref);
      if (!u || !u.startsWith('https://')) throw new SocialSendError('visuel_sans_adresse', 'corriger');
      return u;
    });
  };
  const networkOnly = (payload: SocialPayload): void => {
    if (payload.account !== 'reseau') throw new SocialSendError('compte_non_relie', 'relier');
  };

  const facebook: SocialChannel = {
    channel: 'facebook',
    mode: 'reel',
    post: async (payload) => {
      networkOnly(payload);
      const photos: string[] = [];
      const images = urls(payload);
      await reachable(images);
      for (const url of images) photos.push(idOf(await call('POST', `${network.pageId}/photos`, { url, published: 'false' })));
      const params: Record<string, string> = { message: caption(payload, true) };
      photos.forEach((id, i) => (params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id })));
      const postRef = idOf(await call('POST', `${network.pageId}/feed`, params, true), true);
      return { postRef, url: await permalink(postRef, 'permalink_url') };
    },
    remove,
  };

  const instagram: SocialChannel = {
    channel: 'instagram',
    mode: 'reel',
    post: async (payload) => {
      networkOnly(payload);
      const images = urls(payload);
      await reachable(images);
      const text = caption(payload, false);
      let container: string;
      if (images.length === 1) {
        container = idOf(await call('POST', `${network.igUserId}/media`, { image_url: images[0]!, caption: text }));
      } else {
        const children: string[] = [];
        for (const image_url of images) children.push(idOf(await call('POST', `${network.igUserId}/media`, { image_url, is_carousel_item: 'true' })));
        container = idOf(await call('POST', `${network.igUserId}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption: text }));
      }
      const postRef = idOf(await call('POST', `${network.igUserId}/media_publish`, { creation_id: container }, true), true);
      return { postRef, url: await permalink(postRef, 'permalink') };
    },
    remove,
  };

  return [facebook, instagram];
}
