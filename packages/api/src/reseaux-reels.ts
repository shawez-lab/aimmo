/**
 * La mise en service des vrais réseaux de la publication (AU036), lue dans les réglages du Worker.
 *
 * Les canaux Facebook et Instagram ne sont faits que si tout est rangé : `RESEAUX_MODE` vaut `reel`, la page
 * (`META_PAGE_ID`), le compte Instagram (`META_IG_USER_ID`), le jeton de la page (`META_PAGE_TOKEN`, un secret) et
 * l'adresse publique des photos (`RESEAUX_MEDIA_BASE`, en https, terminée par `/medias/`). Il manque une seule pièce,
 * ou l'une est mal formée : rien de réel, tous les réseaux restent d'essai [R26, R134]. Les autres réseaux (LinkedIn,
 * Google, TikTok, YouTube) restent d'essai tant qu'ils n'ont pas leur propre canal.
 */
import { appendEvent, type JournalStore, type SqlDatabase } from '@aimmo/core';
import { metaSocialChannels, SOCIAL_CHANNELS, trialSocialChannel, type LiveWithdrawal, type MetaChannelsConfig, type SocialChannel } from '../../core/src/studio/index.ts';
import { studioCore } from './studio.ts';

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
export function liveSocialChannels(env: SocialEnv, http: MetaChannelsConfig['http']): { channels: SocialChannel[]; live: true } | null {
  if (env.RESEAUX_MODE !== 'reel') return null;
  const base = mediaBase(env.RESEAUX_MEDIA_BASE);
  const pageId = env.META_PAGE_ID?.trim() ?? '';
  const igUserId = env.META_IG_USER_ID?.trim() ?? '';
  const token = env.META_PAGE_TOKEN?.trim() ?? '';
  if (!base || !/^[0-9]{1,32}$/.test(pageId) || !/^[0-9]{1,32}$/.test(igUserId) || token === '') return null;
  const meta = metaSocialChannels({
    network: { pageId, igUserId, token },
    mediaUrl: (ref) => (/^[A-Za-z0-9/_.-]{1,300}$/.test(ref) && !ref.split('/').some((s) => s === '' || s === '.' || s === '..') ? base + ref.split('/').map(encodeURIComponent).join('/') : null),
    http,
  });
  const real = new Set(meta.map((c) => c.channel));
  return { channels: [...meta, ...SOCIAL_CHANNELS.filter((c) => !real.has(c)).map((c) => trialSocialChannel(c))], live: true };
}

/** Le stockage des fichiers n'est pas lu par les retraits : aucune pièce n'est demandée. */
const NO_FILES = { has: async (): Promise<boolean> => false };

const publicationsOf = (db: SqlDatabase, journal: JournalStore, now: () => Date, social: { channels: readonly SocialChannel[]; live: true }) =>
  studioCore({ db, journal, now, files: NO_FILES, channels: social.channels, live: social.live }).publications;

/**
 * Le retrait immédiat des vraies publications d'un bien, à la rétractation ou à l'annulation de son mandat [R42]. Une
 * panne n'empêche pas la réponse du geste : elle est écrite au journal et le passage planifié reprend.
 */
export async function withdrawLiveNow(db: SqlDatabase, journal: JournalStore, now: () => Date, social: { channels: readonly SocialChannel[]; live: true }, networkId: string, propertyId: string, actor: string): Promise<LiveWithdrawal | { error: 'retrait_reporte' }> {
  try {
    return await publicationsOf(db, journal, now, social).withdrawLive(networkId, propertyId, actor);
  } catch {
    await appendEvent(journal, { type: 'studio.publication.retrait_echec', actor, subject: `property:${propertyId}`, data: { rule: 'R42', code: 'erreur' } }, now);
    return { error: 'retrait_reporte' };
  }
}

/** Le passage planifié des retraits : chaque réseau qui a une vraie publication pas encore retirée [R42]. */
export async function runLiveWithdrawals(db: SqlDatabase, journal: JournalStore, now: () => Date, social: { channels: readonly SocialChannel[]; live: true }): Promise<number> {
  const networks = await db.all<{ network_id: string }>(
    `SELECT DISTINCT p.network_id FROM social_posts p JOIN social_live_attempts a ON a.post_id = p.id JOIN social_live_sends s ON s.attempt_id = a.id
     WHERE s.outcome = 'envoye' AND NOT EXISTS (SELECT 1 FROM social_live_removals r WHERE r.attempt_id = a.id AND r.outcome = 'retire') ORDER BY p.network_id`,
  );
  const publications = publicationsOf(db, journal, now, social);
  let removed = 0;
  for (const n of networks) for (const r of await publications.withdrawAllLive(n.network_id)) removed += r.result?.removed.length ?? 0;
  return removed;
}
