/**
 * L'application de l'agent, première version (A01) : une page web installable servie par le Worker lui-même, sans
 * construction ni dépendance. Elle ne lit que par l'API, sous les droits de l'agent [R16]. Le téléphone ne garde que
 * la coquille de l'application ; aucune réponse de l'API n'est mise en cache, aucune donnée de client n'y reste.
 * La clé personnelle de l'agent est saisie une fois, gardée sur son appareil, envoyée seulement dans l'en-tête
 * `Authorization`, jamais dans une adresse ni au journal [R13].
 */

import { COMMERCES_SCRIPT } from '../app/commerces.ts';
import { CONFORMITE_SCRIPT } from '../app/conformite.ts';
import { INVESTIR_SCRIPT } from '../app/investir.ts';
import { STUDIO_SCRIPT } from '../app/studio.ts';
import { GAGNER_SCRIPT } from '../app/gagner.ts';
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

const FILES: Readonly<Record<string, { body: string; type: string }>> = Object.freeze({
  '/app/': { body: INDEX_HTML, type: 'text/html; charset=utf-8' },
  '/app/app.css': { body: APP_CSS, type: 'text/css; charset=utf-8' },
  '/app/app.js': { body: APP_JS, type: 'text/javascript; charset=utf-8' },
  // L'écran du responsable de la conformité (L10), chargé à la demande pour sa seule clé, jamais gardé sur l'appareil.
  '/app/conformite.js': { body: CONFORMITE_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // L'écran « Investir » (Y09), chargé à sa première ouverture pour garder le budget de l'application.
  '/app/investir.js': { body: INVESTIR_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // L'écran « Commerces » (CE11), chargé à la demande quand l'agent l'ouvre, jamais gardé sur l'appareil [R201].
  '/app/commerces.js': { body: COMMERCES_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // L'écran « Studio » (X11), chargé à sa première ouverture, jamais gardé sur l'appareil [R201].
  '/app/studio.js': { body: STUDIO_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // L'écran « Gagner des mandats » (G13), chargé à sa première ouverture, jamais gardé sur l'appareil [R201].
  '/app/gagner.js': { body: GAGNER_SCRIPT, type: 'text/javascript; charset=utf-8' },
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
