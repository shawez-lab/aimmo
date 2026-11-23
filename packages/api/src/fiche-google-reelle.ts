/**
 * La mise en service de la vraie fiche Google (AU037), lue dans les réglages du Worker.
 *
 * Le vrai client n'est fait que si tout est rangé (H07) : `GBP_MODE` vaut `reel`, l'identifiant du client OAuth de
 * Google (`GBP_CLIENT_ID`), son secret (`GBP_CLIENT_SECRET`) et le jeton de rafraîchissement du compte qui gère les
 * fiches (`GBP_REFRESH_TOKEN`), deux secrets. Il manque une seule pièce, ou l'une est mal formée : rien de réel, la
 * fiche Google reste d'essai [R26]. Le reste de M01 (pages, IndexNow) n'en change pas.
 */
import { googleBusinessClient, type GoogleBusinessConfig } from '../../core/src/attirer/fiche-google-reel.ts';
import type { GbpClient } from '../../core/src/attirer/fiche-google.ts';

export interface GbpEnv {
  GBP_MODE?: string | undefined;
  GBP_CLIENT_ID?: string | undefined;
  GBP_CLIENT_SECRET?: string | undefined;
  GBP_REFRESH_TOKEN?: string | undefined;
}

/** Le vrai client de la fiche Google, ou `null` tant que la mise en service n'est pas complète. */
export function gbpFromEnv(env: GbpEnv, http: GoogleBusinessConfig['http']): GbpClient | null {
  if (env.GBP_MODE !== 'reel') return null;
  const clientId = env.GBP_CLIENT_ID?.trim() ?? '';
  const clientSecret = env.GBP_CLIENT_SECRET?.trim() ?? '';
  const refreshToken = env.GBP_REFRESH_TOKEN?.trim() ?? '';
  // L'identifiant d'un client OAuth de Google finit toujours ainsi ; un secret ou un jeton vide ne sert à rien.
  if (!/^[A-Za-z0-9-]{1,100}\.apps\.googleusercontent\.com$/.test(clientId) || clientSecret === '' || refreshToken === '') return null;
  return googleBusinessClient({ credentials: { clientId, clientSecret, refreshToken }, http });
}
