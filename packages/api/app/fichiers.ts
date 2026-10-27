/**
 * Les fichiers de l'application de l'agent (A01), tels que le navigateur de l'agent les reçoit. Ce code tourne sur le
 * téléphone de l'agent, pas dans le Worker : il n'appelle que l'API de la même adresse (politique de contenu
 * `connect-src 'self'`), jamais une adresse extérieure. Le Worker les sert tels quels (`src/agent-app.ts`).
 */
export const INDEX_HTML = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#1f3a5f">
<meta name="referrer" content="no-referrer">
<title>AIMMO</title>
<link rel="manifest" href="/app/manifest.webmanifest">
<link rel="icon" href="/app/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/app/app.css">
<script src="/app/app.js" defer></script>
</head>
<body>
<header><h1>AIMMO</h1><button id="sortir" type="button" hidden>Se déconnecter</button></header>
<main>
<section id="connexion" hidden>
<h2>Connexion</h2>
<p>Saisissez votre clé personnelle. Elle reste sur cet appareil.</p>
<form id="form-connexion" autocomplete="off">
<label for="cle">Clé personnelle</label>
<input id="cle" name="cle" type="password" minlength="32" required autocomplete="off" spellcheck="false">
<button type="submit">Entrer</button>
</form>
<p id="erreur" role="alert" hidden></p>
</section>
<section id="accueil" hidden>
<h2 id="bonjour"></h2>
<p id="journee">Votre journée s’affichera ici.</p>
</section>
<p id="attente">Chargement…</p>
</main>
</body>
</html>
`;

export const APP_CSS = `:root { color-scheme: light dark; --fond: #ffffff; --texte: #14202e; --accent: #1f3a5f; --doux: #5b6b7d; }
@media (prefers-color-scheme: dark) { :root { --fond: #10161d; --texte: #e8eef4; --accent: #8fb3dd; --doux: #9aa8b6; } }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; background: var(--fond); color: var(--texte); }
header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--doux); }
h1 { margin: 0; font-size: 1.25rem; color: var(--accent); }
main { padding: 16px; max-width: 40rem; margin: 0 auto; }
label { display: block; margin-bottom: 4px; }
input { width: 100%; padding: 12px; font-size: 1rem; border: 1px solid var(--doux); border-radius: 8px; background: transparent; color: inherit; }
button { margin-top: 12px; min-height: 44px; padding: 8px 16px; font-size: 1rem; border: 0; border-radius: 8px; background: var(--accent); color: var(--fond); }
header button { margin: 0; }
#erreur { color: #b3261e; }
`;

/**
 * Le script de la page. Tout texte venu de l'API est posé avec `textContent`, jamais comme du code. La clé ne passe
 * que dans l'en-tête `Authorization`.
 */
export const APP_JS = `'use strict';
(function () {
  var KEY = 'aimmo.cle';
  var $ = function (id) { return document.getElementById(id); };
  function readKey() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function writeKey(v) { try { localStorage.setItem(KEY, v); return true; } catch (e) { return false; } }
  function forgetKey() { try { localStorage.removeItem(KEY); } catch (e) { /* rien à effacer */ } }
  function show(id) {
    ['connexion', 'accueil', 'attente'].forEach(function (s) { $(s).hidden = s !== id; });
    $('sortir').hidden = id !== 'accueil';
  }
  function api(path, key) {
    return fetch(path, { headers: { authorization: 'Bearer ' + key }, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
  }
  function enter(key) {
    show('attente');
    return api('/v1/moi', key).then(function (r) {
      if (!r.ok) throw new Error('refus');
      return r.json();
    }).then(function (body) {
      var me = body && body.data;
      if (!me || me.role !== 'agent') throw new Error('role');
      $('bonjour').textContent = me.firstName ? 'Bonjour ' + me.firstName : 'Bonjour';
      show('accueil');
      return true;
    }).catch(function () {
      forgetKey();
      $('erreur').textContent = 'Clé refusée. Vérifiez-la ou demandez-en une nouvelle.';
      $('erreur').hidden = false;
      show('connexion');
      return false;
    });
  }
  document.addEventListener('DOMContentLoaded', function () {
    $('form-connexion').addEventListener('submit', function (event) {
      event.preventDefault();
      var key = $('cle').value.trim();
      $('cle').value = '';
      if (key.length < 32) { $('erreur').textContent = 'Une clé compte au moins 32 caractères.'; $('erreur').hidden = false; return; }
      $('erreur').hidden = true;
      if (writeKey(key)) enter(key); else { $('erreur').textContent = 'Cet appareil ne peut pas garder la clé.'; $('erreur').hidden = false; }
    });
    $('sortir').addEventListener('click', function () {
      forgetKey();
      $('bonjour').textContent = '';
      show('connexion');
    });
    var key = readKey();
    if (key) enter(key); else show('connexion');
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).catch(function () { /* sans cache, l'application marche quand même */ });
  });
})();
`;

/**
 * Le service worker : il garde la coquille pour un démarrage rapide, et laisse tout le reste au réseau, sans jamais
 * le mettre en cache. Une réponse de l'API n'est jamais gardée sur l'appareil.
 */
export const swJs = (cache: string, shell: readonly string[]): string => `'use strict';
var CACHE = ${JSON.stringify(cache)};
var SHELL = ${JSON.stringify(shell)};
self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE).then(function (cache) { return cache.addAll(SHELL); }));
});
self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (names) {
    return Promise.all(names.filter(function (n) { return n !== CACHE; }).map(function (n) { return caches.delete(n); }));
  }));
});
self.addEventListener('fetch', function (event) {
  var url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || SHELL.indexOf(url.pathname) === -1) return;
  event.respondWith(fetch(event.request).catch(function () { return caches.match(url.pathname); }));
});
`;

export const MANIFEST = JSON.stringify({
  name: 'AIMMO',
  short_name: 'AIMMO',
  lang: 'fr',
  start_url: '/app/',
  scope: '/app/',
  display: 'standalone',
  background_color: '#ffffff',
  theme_color: '#1f3a5f',
  icons: [{ src: '/app/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
});

export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1f3a5f"/><path d="M14 32 32 16l18 16v18H38V38H26v12H14z" fill="#ffffff"/></svg>`;

