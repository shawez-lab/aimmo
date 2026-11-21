/**
 * Le vrai client de la fiche Google (AU037), derrière l'interface `GbpClient` d'AT06.
 *
 * Il n'est fait que par le Worker, et seulement quand tout est rangé (H07) : le mode `reel` déclaré, l'identifiant du
 * client OAuth de Google, son secret et le jeton de rafraîchissement du compte qui gère les fiches (deux secrets).
 * Sinon la fiche reste d'essai [R26].
 *
 * - le jeton d'accès est tiré du jeton de rafraîchissement, gardé en mémoire jusqu'à une minute avant sa fin ;
 * - les avis : `GET mybusiness/v4/{fiche}/reviews` ; la réponse à un avis : `PUT …/reviews/{avis}/reply`, qui remplace
 *   la précédente (se refait sans risque) ; une publication : `POST …/localPosts` ; les informations :
 *   `PATCH mybusinessbusinessinformation/v1/locations/{lieu}` sur le nom, le téléphone et le site seuls ;
 * - chaque envoi réussi rend son accusé lu chez Google : la référence de ce qui est rangé (et le lien public d'une
 *   publication). Sans référence attendue dans la réponse, rien n'est dit « envoyé ».
 *
 * Chaque échec devient une `GbpError` au code fermé : `connexion` (jeton refusé ou retiré : reconnecter le compte),
 * `droits` (le compte ne gère pas cette fiche : la relier), `fiche_introuvable` (référence mal formée ou fiche
 * supprimée : la relier), `refuse_google` (texte ou lien refusé : corriger), `limite` (quota : réessayer plus tard),
 * `panne` (Google indisponible), `incertain` (la demande est partie et sa réponse s'est perdue). Ni le jeton, ni le
 * texte, ni la réponse de Google ne sortent d'ici : seul le code [R13].
 *
 * AIMMO n'écrit jamais d'avis [R64] : aucune adresse ici ne le permet.
 */
import { GbpError, type GbpAck, type GbpClient, type GbpInfo, type GbpReview } from './fiche-google.ts';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const V4 = 'https://mybusiness.googleapis.com/v4';
const INFO = 'https://mybusinessbusinessinformation.googleapis.com/v1';
/** Une fiche chez Google : `accounts/<compte>/locations/<lieu>`, en chiffres ; le compte manque dans l'ancien réglage. */
const LOCATION = /^(?:accounts\/([0-9]{1,30})\/)?locations\/([0-9]{1,30})$/;
const REVIEW_ID = /^[A-Za-z0-9_-]{1,200}$/;
const MAX_REVIEW_PAGES = 20;
const STARS: Readonly<Record<string, number>> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

export interface GoogleCredentials {
  clientId: string;
  /** Deux secrets du Worker, jamais écrits ailleurs. */
  clientSecret: string;
  refreshToken: string;
}

export interface GoogleBusinessConfig {
  credentials: GoogleCredentials;
  /** L'appel HTTP vers Google, donné par le Worker seul. */
  http: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}

type Json = Record<string, unknown>;

/** Le code fermé d'une réponse d'erreur de Google, sans jamais garder son message. */
export function googleError(status: number, body: unknown): GbpError {
  const err = body !== null && typeof body === 'object' ? ((body as Json).error as Json | string | undefined) : undefined;
  const reason = typeof err === 'string' ? err : typeof err?.status === 'string' ? err.status : '';
  if (status === 401 || reason === 'UNAUTHENTICATED' || reason === 'invalid_grant' || reason === 'invalid_client' || reason === 'unauthorized_client') return new GbpError('connexion');
  if (status === 429 || reason === 'RESOURCE_EXHAUSTED') return new GbpError('limite');
  if (status === 403 || reason === 'PERMISSION_DENIED') return new GbpError('droits');
  if (status === 404 || reason === 'NOT_FOUND') return new GbpError('fiche_introuvable');
  if (status === 400 || status === 409 || status === 422 || reason === 'INVALID_ARGUMENT' || reason === 'FAILED_PRECONDITION') return new GbpError('refuse_google');
  return new GbpError('panne');
}

/**
 * Le lieu d'une fiche, ou l'erreur qui demande de la relier : rien ne part vers une adresse mal formée. Les avis et les
 * publications ont besoin du compte (`withAccount`) ; les informations, du lieu seul.
 */
function parts(locationRef: string, withAccount = true): { account: string; location: string } {
  const m = LOCATION.exec(locationRef);
  if (!m || (withAccount && !m[1])) throw new GbpError('fiche_introuvable');
  return { account: m[1] ?? '', location: m[2]! };
}

export function googleBusinessClient(config: GoogleBusinessConfig): GbpClient {
  const { clientId, clientSecret, refreshToken } = config.credentials;
  if (clientId.trim() === '' || clientSecret.trim() === '' || refreshToken.trim() === '') throw new Error('Compte Google incomplet');
  const doFetch = config.http;
  const now = config.now ?? (() => new Date());
  const timeoutMs = config.timeoutMs ?? 15_000;
  let token: { value: string; until: number } | null = null;

  /**
   * Un appel, borné dans le temps. `sent` : la demande a pu arriver chez Google ; une réponse perdue après est
   * `incertain`. Avant (la connexion n'a pas pu s'ouvrir), c'est une panne.
   */
  async function call(url: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      let res: Response;
      try {
        res = await doFetch(url, { ...init, signal: ctrl.signal, redirect: 'error' });
      } catch {
        throw new GbpError('incertain');
      }
      // Le délai court jusqu'à la fin du corps : une réponse qui traîne est perdue, jamais attendue sans fin.
      let text: string;
      try {
        text = await res.text();
      } catch {
        throw new GbpError('incertain');
      }
      let body: unknown = null;
      try {
        body = text === '' ? null : JSON.parse(text);
      } catch {
        body = null;
      }
      return { status: res.status, body };
    } finally {
      clearTimeout(timer);
    }
  }

  async function accessToken(): Promise<string> {
    if (token && token.until > now().getTime()) return token.value;
    const form = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' });
    let r: { status: number; body: unknown };
    try {
      r = await call(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });
    } catch {
      // Le jeton ne publie rien : une réponse perdue ici est une simple panne.
      throw new GbpError('panne');
    }
    const b = (r.body ?? {}) as Json;
    if (r.status !== 200) throw googleError(r.status === 400 || r.status === 401 ? 401 : r.status, r.body);
    if (typeof b.access_token !== 'string' || b.access_token === '') throw new GbpError('connexion');
    const seconds = typeof b.expires_in === 'number' && b.expires_in > 0 ? b.expires_in : 3600;
    token = { value: b.access_token, until: now().getTime() + Math.max(0, seconds - 60) * 1000 };
    return token.value;
  }

  /** Un appel à l'API, avec le jeton ; un jeton refusé est oublié pour que le suivant soit tiré de nouveau. */
  async function api(method: string, url: string, body: unknown, replayable: boolean): Promise<Json> {
    const value = await accessToken();
    let r: { status: number; body: unknown };
    try {
      r = await call(url, {
        method,
        headers: { authorization: `Bearer ${value}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (replayable) throw new GbpError('panne');
      throw error;
    }
    if (r.status === 401) token = null;
    if (r.status >= 500 && !replayable) throw new GbpError('incertain');
    if (r.status < 200 || r.status >= 300) throw googleError(r.status, r.body);
    return r.body !== null && typeof r.body === 'object' ? (r.body as Json) : {};
  }

  return {
    async listReviews(locationRef: string): Promise<GbpReview[]> {
      const { account, location } = parts(locationRef);
      // Toutes les pages, 50 avis chacune, jusqu'à MAX_REVIEW_PAGES : au-delà, les plus anciens attendent.
      const list: Json[] = [];
      let pageToken: string | null = null;
      for (let page = 0; page < MAX_REVIEW_PAGES; page++) {
        const query = `pageSize=50${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
        const b = await api('GET', `${V4}/accounts/${account}/locations/${location}/reviews?${query}`, undefined, true);
        if (Array.isArray(b.reviews)) list.push(...(b.reviews as Json[]));
        pageToken = typeof b.nextPageToken === 'string' && b.nextPageToken !== '' && b.nextPageToken.length <= 500 ? b.nextPageToken : null;
        if (!pageToken) break;
      }
      const out: GbpReview[] = [];
      for (const r of list) {
        const rating = typeof r.starRating === 'string' ? STARS[r.starRating] : undefined;
        if (typeof r.name !== 'string' || !rating || typeof r.createTime !== 'string') continue;
        const reviewer = r.reviewer !== null && typeof r.reviewer === 'object' ? (r.reviewer as Json) : {};
        out.push({
          reviewRef: r.name,
          rating,
          comment: typeof r.comment === 'string' ? r.comment : null,
          authorName: typeof reviewer.displayName === 'string' ? reviewer.displayName : null,
          reviewedAt: r.createTime,
        });
      }
      return out;
    },

    async replyToReview(locationRef: string, reviewRef: string, text: string): Promise<GbpAck> {
      const { account, location } = parts(locationRef);
      const prefix = `accounts/${account}/locations/${location}/reviews/`;
      // Un avis d'une autre fiche n'est jamais répondu depuis celle-ci.
      if (!reviewRef.startsWith(prefix) || !REVIEW_ID.test(reviewRef.slice(prefix.length))) throw new GbpError('fiche_introuvable');
      const b = await api('PUT', `${V4}/${reviewRef}/reply`, { comment: text }, true);
      if (typeof b.updateTime !== 'string' || typeof b.comment !== 'string') throw new GbpError('accuse_absent');
      return { ref: `${reviewRef}/reply` };
    },

    async createPost(locationRef: string, post: { text: string; linkUri: string }): Promise<GbpAck> {
      const { account, location } = parts(locationRef);
      const b = await api(
        'POST',
        `${V4}/accounts/${account}/locations/${location}/localPosts`,
        { languageCode: 'fr', topicType: 'STANDARD', summary: post.text, callToAction: { actionType: 'LEARN_MORE', url: post.linkUri } },
        false,
      );
      const prefix = `accounts/${account}/locations/${location}/localPosts/`;
      // Sans la référence de la publication rangée, l'issue est inconnue : la publication n'est jamais refaite.
      if (typeof b.name !== 'string' || !b.name.startsWith(prefix) || !REVIEW_ID.test(b.name.slice(prefix.length))) throw new GbpError('incertain');
      return { ref: b.name, url: typeof b.searchUrl === 'string' ? b.searchUrl : null };
    },

    async updateInfo(locationRef: string, info: GbpInfo): Promise<GbpAck> {
      const { location } = parts(locationRef, false);
      const mask = ['title', ...(info.phone ? ['phoneNumbers.primaryPhone'] : []), 'websiteUri'].join(',');
      const b = await api(
        'PATCH',
        `${INFO}/locations/${location}?updateMask=${encodeURIComponent(mask)}`,
        { title: info.title, ...(info.phone ? { phoneNumbers: { primaryPhone: info.phone } } : {}), websiteUri: info.websiteUri },
        true,
      );
      if (b.name !== `locations/${location}`) throw new GbpError('accuse_absent');
      return { ref: b.name };
    },
  };
}
