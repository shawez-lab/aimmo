/**
 * L'application de l'agent, première version (A01) : une page web installable servie par le Worker lui-même, sans
 * construction ni dépendance. Elle ne lit que par l'API, sous les droits de l'agent [R16]. Le téléphone ne garde que
 * la coquille de l'application ; aucune réponse de l'API n'est mise en cache, aucune donnée de client n'y reste.
 * La clé personnelle de l'agent est saisie une fois, gardée sur son appareil, envoyée seulement dans l'en-tête
 * `Authorization`, jamais dans une adresse ni au journal [R13].
 */

import { ALERTES_SCRIPT } from '../app/alertes.ts';
import { APPELS_SCRIPT } from '../app/appels.ts';
import { CLASSEMENT_SCRIPT } from '../app/classement.ts';
import { AVIS_SCRIPT } from '../app/avis.ts';
import { OFFRES_SCRIPT } from '../app/offres.ts';
import { DOSSIER_SCRIPT } from '../app/dossier.ts';
import { MANDAT_SCRIPT } from '../app/mandat.ts';
import { COMMERCES_SCRIPT } from '../app/commerces.ts';
import { COMMERCES_ENGAGEMENTS_SCRIPT } from '../app/commerces-engagements.ts';
import { COMMERCES_REPRENEURS_SCRIPT } from '../app/commerces-repreneurs.ts';
import { LOUER_SCRIPT } from '../app/louer.ts';
import { REPRISE_SCRIPT } from '../app/reprise.ts';
import { CONFORMITE_SCRIPT } from '../app/conformite.ts';
import { INVESTIR_SCRIPT } from '../app/investir.ts';
import { STUDIO_SCRIPT } from '../app/studio.ts';
import { GAGNER_SCRIPT } from '../app/gagner.ts';
import { ATTIRER_SCRIPT } from '../app/attirer.ts';
import { BASCULE_SCRIPT } from '../app/bascule.ts';
import { REGLAGES_MANDAT_SCRIPT } from '../app/reglages-mandat.ts';
import { FINANCES_SCRIPT } from '../app/finances.ts';
import { FICHE_GOOGLE_SCRIPT } from '../app/fiche-google.ts';
import { INTEGRATION_SCRIPT } from '../app/integration.ts';
import { APP_CSS, APP_JS, ICON_SVG, INDEX_HTML, MANIFEST, swJs } from '../app/fichiers.ts';

export const AGENT_APP_PATH = '/app';
/** Version de la coquille : changer ce nom remplace le cache de l'appareil. */
export const AGENT_APP_CACHE = 'aimmo-app-v1';
/** Les seuls fichiers que l'appareil garde : la coquille, rien d'autre. */
export const AGENT_APP_SHELL: readonly string[] = Object.freeze(['/app/', '/app/app.css', '/app/app.js', '/app/manifest.webmanifest', '/app/icon.svg']);

/** Politique de contenu : rien d'extérieur, aucun script en ligne, aucun appel hors de ce Worker. */
export const AGENT_APP_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const SW_JS = swJs(AGENT_APP_CACHE, AGENT_APP_SHELL);

/**
 * Le script servi sans ses lignes de commentaire (J14) : une ligne qui n'est qu'un commentaire, de ligne ou de bloc,
 * ne change rien à ce que le script fait ; la retirer garde l'application dans son budget [R201]. Rien d'autre n'est
 * touché : ni chaîne, ni code, ni commentaire en bout de ligne.
 */
export function stripCommentLines(js: string): string {
  return js
    .split('\n')
    .filter((line) => !/^\s*\/\/.*$/.test(line) && !/^\s*\/\*.*\*\/\s*$/.test(line))
    .join('\n');
}

const FILES: Readonly<Record<string, { body: string; type: string }>> = Object.freeze({
  '/app/': { body: INDEX_HTML, type: 'text/html; charset=utf-8' },
  '/app/app.css': { body: APP_CSS, type: 'text/css; charset=utf-8' },
  '/app/app.js': { body: stripCommentLines(APP_JS), type: 'text/javascript; charset=utf-8' },
  // Les alertes de l'agent (C09c), chargées seulement s'il en a, jamais gardées sur l'appareil [R201].
  '/app/alertes.js': { body: ALERTES_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // Les gestes d'appel de la fiche (AC12), chargés à l'ouverture d'une fiche où ils servent [R201].
  '/app/appels.js': { body: APPELS_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // Le classement de la fiche et sa correction (Q08), chargés à l'ouverture d'une fiche classée [R201].
  '/app/classement.js': { body: CLASSEMENT_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // Le dépôt des fichiers de la reprise (I05), chargé au premier geste de la direction [R201].
  '/app/reprise.js': { body: REPRISE_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // L'écran du responsable de la conformité (L10), chargé à la demande pour sa seule clé, jamais gardé sur l'appareil.
  '/app/conformite.js': { body: CONFORMITE_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // L'écran « Investir » (Y09), chargé à sa première ouverture pour garder le budget de l'application.
  '/app/investir.js': { body: INVESTIR_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // L'écran « Commerces » (CE11), chargé à la demande quand l'agent l'ouvre, jamais gardé sur l'appareil [R201].
  '/app/commerces.js': { body: COMMERCES_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // Les demandes et l'engagement de confidentialité (CE14), chargés au premier geste [R201].
  '/app/commerces-engagements.js': { body: COMMERCES_ENGAGEMENTS_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // Les repreneurs et le rapprochement (CE15), de même.
  '/app/commerces-repreneurs.js': { body: COMMERCES_REPRENEURS_SCRIPT, type: 'text/javascript; charset=utf-8' },
  '/app/louer.js': { body: LOUER_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // L'écran « Studio » (X11), chargé à sa première ouverture, jamais gardé sur l'appareil [R201].
  // L'écran « Avis de valeur » (E10), chargé à sa première ouverture, jamais gardé sur l'appareil [R201].
  '/app/avis.js': { body: AVIS_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // L'écran « Offres » (O10), chargé à sa première ouverture, jamais gardé sur l'appareil [R201].
  '/app/offres.js': { body: OFFRES_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // L'écran « Dossier de vente » (N12), chargé à sa première ouverture, jamais gardé sur l'appareil [R201].
  '/app/dossier.js': { body: DOSSIER_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // L'écran « Mandat » (D12), de même.
  '/app/mandat.js': { body: MANDAT_SCRIPT, type: 'text/javascript; charset=utf-8' },
  '/app/studio.js': { body: STUDIO_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // L'écran « Gagner des mandats » (G13), chargé à sa première ouverture, jamais gardé sur l'appareil [R201].
  '/app/gagner.js': { body: GAGNER_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // L'écran « Attirer » de la direction (AT12), chargé à sa première ouverture, jamais gardé sur l'appareil [R201].
  '/app/attirer.js': { body: ATTIRER_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // La bascule sur l'écran du réseau (B05), chargée au premier geste, jamais gardée sur l'appareil [R201].
  '/app/bascule.js': { body: BASCULE_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // Les réglages du mandat pour la direction (D13), chargés au premier geste, jamais gardés sur l'appareil [R201].
  '/app/reglages-mandat.js': { body: REGLAGES_MANDAT_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // Les finances (K10), chargées au premier geste, jamais gardées sur l'appareil [R201].
  '/app/finances.js': { body: FINANCES_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // L'écran « Fiche Google » (AT14), chargé à sa première ouverture, jamais gardé sur l'appareil [R201].
  '/app/fiche-google.js': { body: FICHE_GOOGLE_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // Les écrans de M14, « Mon intégration », « Académie » et « Candidatures » (J14), chargés à leur première ouverture [R201].
  '/app/integration.js': { body: INTEGRATION_SCRIPT, type: 'text/javascript; charset=utf-8' },
  '/app/sw.js': { body: SW_JS, type: 'text/javascript; charset=utf-8' },
  '/app/manifest.webmanifest': { body: MANIFEST, type: 'application/manifest+json; charset=utf-8' },
  '/app/icon.svg': { body: ICON_SVG, type: 'image/svg+xml' },
});

/** Les fichiers de l'application, pour les tests. */
export const AGENT_APP_FILES: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(Object.entries(FILES).map(([k, v]) => [k, v.body])));

/** Sert un fichier de l'application, ou null si l'adresse n'est pas à elle. */
export function handleAgentApp(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.pathname !== AGENT_APP_PATH && !url.pathname.startsWith(`${AGENT_APP_PATH}/`)) return null;
  const headers: Record<string, string> = {
    'content-security-policy': AGENT_APP_CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'cross-origin-opener-policy': 'same-origin',
  };
  if (url.pathname === AGENT_APP_PATH) return new Response(null, { status: 308, headers: { ...headers, location: '/app/' } });
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Méthode non admise.', { status: 405, headers: { ...headers, 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' } });
  }
  const file = FILES[url.pathname];
  if (!file) return new Response('Page inconnue.', { status: 404, headers: { ...headers, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  return new Response(request.method === 'HEAD' ? null : file.body, {
    status: 200,
    headers: {
      ...headers,
      'content-type': file.type,
      // La coquille se revalide à chaque ouverture ; le service worker se cherche toujours à nouveau.
      'cache-control': 'no-cache',
      ...(url.pathname === '/app/sw.js' ? { 'service-worker-allowed': '/app/' } : {}),
    },
  });
}
