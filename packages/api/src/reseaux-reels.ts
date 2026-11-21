/**
 * La mise en service des vrais réseaux de la publication (AU036), lue dans les réglages du Worker.
 *
 * Les canaux Facebook et Instagram ne sont faits que si tout est rangé : `RESEAUX_MODE` vaut `reel`, la page
 * (`META_PAGE_ID`), le compte Instagram (`META_IG_USER_ID`), le jeton de la page (`META_PAGE_TOKEN`, un secret) et
 * l'adresse publique des photos (`RESEAUX_MEDIA_BASE`, en https, terminée par `/medias/`). Il manque une seule pièce,
 * ou l'une est mal formée : rien de réel, tous les réseaux restent d'essai [R26, R134]. Les autres réseaux (LinkedIn,
 * Google, TikTok, YouTube) restent d'essai tant qu'ils n'ont pas leur propre canal.
 */
import { metaSocialChannels, SOCIAL_CHANNELS, trialSocialChannel, type SocialChannel } from '../../core/src/studio/index.ts';

export interface SocialEnv {
  RESEAUX_MODE?: string | undefined;
  META_PAGE_ID?: string | undefined;
  META_IG_USER_ID?: string | undefined;
  META_PAGE_TOKEN?: string | undefined;
  RESEAUX_MEDIA_BASE?: string | undefined;
}

/** L'adresse publique d'une photo : la base vérifiée, puis chaque segment de la référence encodé. */
export function mediaBase(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && u.username === '' && u.password === '' && u.search === '' && u.hash === '' && u.pathname.endsWith('/medias/') ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Les canaux de la publication et leur mise en service ; null quand rien de réel n'est rangé. */
export function liveSocialChannels(env: SocialEnv, doFetch: typeof fetch = fetch.bind(globalThis)): { channels: SocialChannel[]; live: true } | null {
  if (env.RESEAUX_MODE !== 'reel') return null;
  const base = mediaBase(env.RESEAUX_MEDIA_BASE);
  const pageId = env.META_PAGE_ID?.trim() ?? '';
  const igUserId = env.META_IG_USER_ID?.trim() ?? '';
  const token = env.META_PAGE_TOKEN?.trim() ?? '';
  if (!base || !/^[0-9]{1,32}$/.test(pageId) || !/^[0-9]{1,32}$/.test(igUserId) || token === '') return null;
  const meta = metaSocialChannels({
    network: { pageId, igUserId, token },
    mediaUrl: (ref) => (/^[A-Za-z0-9/_.-]{1,300}$/.test(ref) && !ref.split('/').some((s) => s === '' || s === '.' || s === '..') ? base + ref.split('/').map(encodeURIComponent).join('/') : null),
    fetch: doFetch,
  });
  const real = new Set(meta.map((c) => c.channel));
  return { channels: [...meta, ...SOCIAL_CHANNELS.filter((c) => !real.has(c)).map((c) => trialSocialChannel(c))], live: true };
}
