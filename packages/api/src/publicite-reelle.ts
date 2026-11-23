/**
 * La mise en service de la vraie publicité payante (AU038), lue dans les réglages du Worker.
 *
 * Rien de réel tant que tout n'est pas rangé (H63) : `ADS_MODE` vaut `reel`, le plafond du budget total d'une
 * validation (`ADS_PLAFOND_CENTS`, de 1 € à 10 000 €), la page d'arrivée en https (`ADS_LANDING_URL`) et les lieux de
 * chaque commune chez chaque plateforme (`ADS_LIEUX`, en JSON : `{"21231": {"google": "…", "meta": "…"}}`). Ensuite,
 * chaque plateforme passe en réel seule, quand ses propres réglages sont complets et bien formés :
 *
 * - Google Ads : `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CUSTOMER_ID` (dix chiffres), `GOOGLE_ADS_LOGIN_CUSTOMER_ID`
 *   (facultatif), `GOOGLE_ADS_MOTS`, `GOOGLE_ADS_TITRES`, `GOOGLE_ADS_TEXTES` (listes séparées par `|`), et en secrets
 *   `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN`, `GOOGLE_ADS_DEVELOPER_TOKEN` ;
 * - Meta : `META_ADS_ACCOUNT_ID`, `META_PAGE_ID`, `META_ADS_TEXTE`, et en secret `META_ADS_TOKEN`.
 *
 * Une pièce manque ou est mal formée : cette plateforme reste d'essai, l'autre n'en change pas [R587].
 */
import type { JournalStore, SqlDatabase } from '@aimmo/core';
import { googleAdsPlatform, metaAdsPlatform, PublicitePayante, trialAdPlatform, type AdPlatform, type AdPlatformName, type GoogleAdsConfig } from '../../core/src/marketing/index.ts';

export interface AdsEnv {
  ADS_MODE?: string | undefined;
  ADS_PLAFOND_CENTS?: string | undefined;
  ADS_LANDING_URL?: string | undefined;
  ADS_LIEUX?: string | undefined;
  GOOGLE_ADS_CLIENT_ID?: string | undefined;
  GOOGLE_ADS_CLIENT_SECRET?: string | undefined;
  GOOGLE_ADS_REFRESH_TOKEN?: string | undefined;
  GOOGLE_ADS_DEVELOPER_TOKEN?: string | undefined;
  GOOGLE_ADS_CUSTOMER_ID?: string | undefined;
  GOOGLE_ADS_LOGIN_CUSTOMER_ID?: string | undefined;
  GOOGLE_ADS_MOTS?: string | undefined;
  GOOGLE_ADS_TITRES?: string | undefined;
  GOOGLE_ADS_TEXTES?: string | undefined;
  META_ADS_TOKEN?: string | undefined;
  META_ADS_ACCOUNT_ID?: string | undefined;
  META_PAGE_ID?: string | undefined;
  META_ADS_TEXTE?: string | undefined;
}

/** Les plateformes données à la publicité, et le plafond quand l'une est réelle. */
export interface AdsSettings {
  platforms: Readonly<Record<AdPlatformName, AdPlatform>>;
  realCapCents: number | undefined;
}

export const MAX_REAL_CAP_CENTS = 1_000_000;
const INSEE = /^(\d{5}|2[AB]\d{3})$/;
const DIGITS = /^[0-9]{1,30}$/;

const list = (v: string | undefined): string[] => (v ?? '').split('|').map((x) => x.trim()).filter((x) => x.length > 0);

/** Les lieux de chaque commune, par plateforme ; un JSON mal formé ne donne rien. */
function readPlaces(raw: string | undefined): { google: Record<string, string>; meta: Record<string, string> } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? '');
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const google: Record<string, string> = {};
  const meta: Record<string, string> = {};
  for (const [insee, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!INSEE.test(insee) || v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    const p = v as Record<string, unknown>;
    if (typeof p.google === 'string' && DIGITS.test(p.google)) google[insee] = p.google;
    if (typeof p.meta === 'string' && DIGITS.test(p.meta)) meta[insee] = p.meta;
  }
  return { google, meta };
}

/** Les plateformes de la publicité : réelles une à une quand tout est rangé (H63), d'essai sinon. */
export function adsFromEnv(env: AdsEnv, http: GoogleAdsConfig['http']): AdsSettings {
  const trial = (): AdsSettings => ({ platforms: { google_ads: trialAdPlatform(), meta: trialAdPlatform() }, realCapCents: undefined });
  if (env.ADS_MODE !== 'reel') return trial();
  const cap = /^[0-9]{1,9}$/.test(env.ADS_PLAFOND_CENTS ?? '') ? Number(env.ADS_PLAFOND_CENTS) : NaN;
  if (!(cap >= 100 && cap <= MAX_REAL_CAP_CENTS)) return trial();
  const landingUrl = env.ADS_LANDING_URL?.trim() ?? '';
  const places = readPlaces(env.ADS_LIEUX);
  if (!places || landingUrl === '') return trial();
  let google: AdPlatform = trialAdPlatform();
  let meta: AdPlatform = trialAdPlatform();
  try {
    google = googleAdsPlatform({
      http,
      landingUrl,
      places: places.google,
      clientId: env.GOOGLE_ADS_CLIENT_ID?.trim() ?? '',
      clientSecret: env.GOOGLE_ADS_CLIENT_SECRET?.trim() ?? '',
      refreshToken: env.GOOGLE_ADS_REFRESH_TOKEN?.trim() ?? '',
      developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN?.trim() ?? '',
      customerId: (env.GOOGLE_ADS_CUSTOMER_ID ?? '').replace(/-/g, '').trim(),
      loginCustomerId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ? env.GOOGLE_ADS_LOGIN_CUSTOMER_ID.replace(/-/g, '').trim() : null,
      keywords: list(env.GOOGLE_ADS_MOTS),
      headlines: list(env.GOOGLE_ADS_TITRES),
      descriptions: list(env.GOOGLE_ADS_TEXTES),
    });
    // L'identifiant d'un client OAuth de Google finit toujours ainsi.
    if (!/^[A-Za-z0-9-]{1,100}\.apps\.googleusercontent\.com$/.test(env.GOOGLE_ADS_CLIENT_ID?.trim() ?? '')) google = trialAdPlatform();
  } catch {
    google = trialAdPlatform();
  }
  try {
    meta = metaAdsPlatform({
      http,
      landingUrl,
      places: places.meta,
      accessToken: env.META_ADS_TOKEN?.trim() ?? '',
      adAccountId: (env.META_ADS_ACCOUNT_ID ?? '').replace(/^act_/, '').trim(),
      pageId: env.META_PAGE_ID?.trim() ?? '',
      message: env.META_ADS_TEXTE ?? '',
    });
  } catch {
    meta = trialAdPlatform();
  }
  const real = google.mode === 'reel' || meta.mode === 'reel';
  return { platforms: { google_ads: google, meta }, realCapCents: real ? cap : undefined };
}

/**
 * Le passage de la publicité, à chaque quart d'heure : pour chaque réseau qui a des campagnes, les demandes arrivées
 * par leur lien rapprochées des fiches, la dépense des derniers jours lue chez la plateforme, puis le contrôle du seuil
 * et du budget [R588]. Un réseau en panne n'empêche pas les autres ; la première erreur remonte.
 */
export async function runAdsPass(db: SqlDatabase, journal: JournalStore, now: () => Date, ads: AdsSettings): Promise<void> {
  const pub = new PublicitePayante(db, journal, ads.platforms, { now, ...(ads.realCapCents ? { realCapCents: ads.realCapCents } : {}) });
  const networks = await db.all<{ network_id: string }>('SELECT DISTINCT network_id FROM ad_campaigns ORDER BY network_id');
  let failure: unknown = null;
  for (const n of networks) {
    try {
      await pub.matchArrivals(n.network_id);
      await pub.syncSpend(n.network_id);
      await pub.runChecks(n.network_id);
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== null) throw failure;
}
