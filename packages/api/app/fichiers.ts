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
<section class="bloc" aria-labelledby="titre-plan">
<h3 id="titre-plan">Mon plan du jour</h3>
<p id="plan-etat" class="etat"></p>
<ol id="plan" class="liste"></ol>
</section>
<section class="bloc" aria-labelledby="titre-chauds">
<h3 id="titre-chauds">Contacts chauds à rappeler</h3>
<p id="chauds-etat" class="etat"></p>
<ul id="chauds" class="liste"></ul>
</section>
<section class="bloc" aria-labelledby="titre-rdv">
<h3 id="titre-rdv">Rendez-vous du jour</h3>
<p id="rdv-etat" class="etat"></p>
<ul id="rdv" class="liste"></ul>
</section>
</section>
<section id="fiche" hidden>
<button id="retour" type="button">Retour à ma journée</button>
<h2 id="fiche-nom"></h2>
<p id="fiche-etat" class="etat" role="status"></p>
<div id="fiche-corps"></div>
</section>
<p id="attente">Chargement…</p>
<p id="note" role="status" hidden></p>
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
.bloc { margin-top: 24px; }
h3 { margin: 0 0 8px; font-size: 1.05rem; }
.liste { list-style: none; margin: 0; padding: 0; }
.liste > li { padding: 12px 0; border-top: 1px solid var(--doux); overflow-wrap: anywhere; }
.liste p { margin: 4px 0 0; }
.doux, .etat { color: var(--doux); font-size: 0.9rem; }
.retard { color: #b3261e; }
.alerte { padding: 12px; border: 2px solid #b3261e; border-radius: 8px; }
.appel { display: inline-flex; align-items: center; min-height: 44px; margin-top: 12px; padding: 8px 16px; border-radius: 8px; background: var(--accent); color: var(--fond); text-decoration: none; }
.liste button, #fiche-corps button { margin-top: 8px; }
details { margin-top: 8px; }
summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; color: var(--accent); }
h4 { margin: 12px 0 4px; font-size: 0.95rem; }
.brief ul { margin: 0; padding-left: 18px; }
a { color: var(--accent); }
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
  function el(tag, text, cls) {
    var n = document.createElement(tag);
    if (text !== undefined && text !== null) n.textContent = String(text);
    if (cls) n.className = cls;
    return n;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function hour(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    try { return d.toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; }
  }
  var KINDS = { estimation: 'Estimation', visite: 'Visite', signature: 'Signature', appel: 'Appel' };
  var STATUS = { honored: 'honoré', absent: 'client absent' };
  var SECTIONS = { client: 'Le client', histoire: 'Son histoire', bien: 'Le bien', ventes: 'Ventes du quartier', questions: 'Questions à prévoir', documents: 'Documents à apporter', itineraire: 'Itinéraire' };
  var MISSING = { not_ready: 'Le brief sera prêt une heure avant le rendez-vous.', no_access: 'Fiche suivie par un autre agent : ni brief ni détail.', changed: 'La fiche a changé depuis le brief : il n’est pas montré.', property: 'Le bien n’est plus dans vos droits : le brief n’est pas montré.' };
  // Le seul lien extérieur admis : l'itinéraire du brief, vers l'application de navigation.
  var ROUTE = /^https:\\/\\/www\\.google\\.com\\/maps\\/dir\\/\\?api=1&destination=[A-Za-z0-9%._~!*'()-]+$/;
  // Le plan est rendu dans l'ordre reçu du socle, jamais retrié ici [R35].
  function renderPlan(list, data) {
    if (!data) return 'Le plan du jour sera prêt à 7 h 30.';
    var items = Array.isArray(data.items) ? data.items : [];
    items.forEach(function (item) {
      var li = el('li');
      li.appendChild(el('strong', String(item.rank) + '. ' + (item.firstName || 'Prénom inconnu')));
      li.appendChild(el('p', item.reason));
      li.appendChild(el('p', 'Place : ' + item.order, 'doux'));
      li.appendChild(ficheButton(item.personId));
      list.appendChild(li);
    });
    if (data.hiddenSinceFrozen > 0) list.appendChild(el('li', String(data.hiddenSinceFrozen) + ' ligne(s) retirée(s) depuis 7 h 30.', 'doux'));
    return items.length === 0 && !(data.hiddenSinceFrozen > 0) ? 'Rien au plan aujourd’hui.' : null;
  }
  function renderHot(list, data) {
    var contacts = data && Array.isArray(data.contacts) ? data.contacts : [];
    contacts.forEach(function (c) {
      var li = el('li');
      li.appendChild(el('strong', c.firstName || 'Prénom inconnu'));
      li.appendChild(el('p', c.reason));
      li.appendChild(el('p', (c.overdue ? 'En retard : à rappeler depuis ' : 'À rappeler avant ') + hour(c.dueAt), c.overdue ? 'retard' : 'doux'));
      li.appendChild(ficheButton(c.personId));
      list.appendChild(li);
    });
    return contacts.length === 0 ? 'Aucun contact chaud à rappeler.' : null;
  }
  function renderBrief(brief) {
    var box = el('details', null, 'brief');
    box.appendChild(el('summary', 'Brief du rendez-vous'));
    var items = Array.isArray(brief.items) ? brief.items : [];
    var current = null;
    var ul = null;
    items.forEach(function (item) {
      if (item.section !== current) {
        current = item.section;
        box.appendChild(el('h4', SECTIONS[current] || 'Autre'));
        ul = el('ul');
        box.appendChild(ul);
      }
      var li = el('li');
      if (item.value === null || item.value === undefined) {
        li.appendChild(el('span', item.label + ' : manque, ' + item.missing, 'doux'));
      } else if (item.section === 'itineraire' && typeof item.value === 'string' && ROUTE.test(item.value)) {
        var a = el('a', 'Ouvrir l’itinéraire');
        a.setAttribute('href', item.value);
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
        li.appendChild(a);
      } else {
        li.appendChild(el('span', item.label + ' : ' + item.value));
        if (item.source) li.appendChild(el('span', ' (' + item.source + ')', 'doux'));
      }
      ul.appendChild(li);
    });
    return box;
  }
  function renderAppointments(list, data) {
    var appointments = data && Array.isArray(data.appointments) ? data.appointments : [];
    appointments.forEach(function (a) {
      var li = el('li');
      var head = hour(a.start) + ' à ' + hour(a.end) + ' · ' + (KINDS[a.kind] || 'Rendez-vous') + (a.firstName ? ' · ' + a.firstName : '');
      li.appendChild(el('strong', head));
      if (STATUS[a.status]) li.appendChild(el('p', 'Rendez-vous ' + STATUS[a.status] + '.', 'doux'));
      if (a.brief) li.appendChild(renderBrief(a.brief));
      else li.appendChild(el('p', MISSING[a.briefMissing] || MISSING.not_ready, 'doux'));
      list.appendChild(li);
    });
    return appointments.length === 0 ? 'Aucun rendez-vous aujourd’hui.' : null;
  }
  var currentKey = null;
  var ID = /^[A-Za-z0-9_-]{1,64}$/;
  var TEL = /^tel:[+]?[0-9]{6,15}$/;
  var PROJECTS = { sell: 'Vendre', buy: 'Acheter', rent_out: 'Mettre en location', rent: 'Louer', invest: 'Investir', sell_business: 'Céder une entreprise', buy_business: 'Reprendre une entreprise', valuation: 'Faire estimer' };
  var STAGES = { new: 'nouveau', recue: 'demande reçue', appele: 'appelé' };
  var CHANNELS = { email: 'mail', phone: 'téléphone', sms: 'SMS', instagram: 'Instagram', facebook: 'Facebook', whatsapp: 'WhatsApp', site: 'site', gohighlevel: 'reprise de GoHighLevel', manychat: 'reprise de ManyChat', exclusion_list: 'liste d’exclusion' };
  // Les codes internes ne s'affichent jamais : un code inconnu prend un libellé général.
  function stage(code) { return STAGES[code] || 'en cours'; }
  function channel(code) { return CHANNELS[code] || 'autre canal'; }
  var PURPOSES = { valuation_follow_up: 'suivi de l’avis de valeur', value_tracking: 'suivi de la valeur du bien', prospecting: 'prospection', appointment: 'rendez-vous' };
  var EXCLUSIONS = { network_list: 'sur la liste d’exclusion', stop: 'a demandé l’arrêt', refused: 'a dit non', sold: 'a déjà vendu', followed_elsewhere: 'suivi par quelqu’un d’autre' };
  function date(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    try { return d.toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' }); } catch (e) { return ''; }
  }
  function ficheButton(personId) {
    var b = el('button', 'Voir la fiche');
    b.setAttribute('type', 'button');
    b.addEventListener('click', function () { openFiche(personId); });
    return b;
  }
  function block(title, rows) {
    var box = el('section', null, 'bloc');
    box.appendChild(el('h3', title));
    var ul = el('ul', null, 'liste');
    rows.forEach(function (r) { ul.appendChild(r); });
    if (rows.length === 0) box.appendChild(el('p', 'Rien pour le moment.', 'etat'));
    box.appendChild(ul);
    return box;
  }
  function line(text, note) {
    var li = el('li', text);
    if (note) li.appendChild(el('p', note, 'doux'));
    return li;
  }
  function renderFiche(f, personId) {
    var body = $('fiche-corps');
    clear(body);
    $('fiche-nom').textContent = [f.firstName, f.lastName].filter(function (x) { return x; }).join(' ') || 'Nom inconnu';
    var contact = f.contact || { allowed: false, reasons: [] };
    // Personne exclue ou qui a demandé l'arrêt : signalée, sans bouton d'appel [R02, R04].
    if (!contact.allowed) {
      var reasons = (contact.reasons || []).map(function (r) { return EXCLUSIONS[r] || 'autre raison'; }).join(', ');
      body.appendChild(el('p', 'Ne plus contacter : ' + (reasons || 'exclusion active') + '.', 'alerte'));
    } else if (typeof f.call === 'string' && TEL.test(f.call)) {
      var a = el('a', 'Appeler', 'appel');
      a.setAttribute('href', f.call);
      body.appendChild(a);
    } else {
      body.appendChild(el('p', 'Aucun numéro sur la fiche.', 'doux'));
    }
    var callbacks = (f.callbacks || []).map(function (c) {
      var li = line(c.reason, c.doneAt ? 'Fait le ' + date(c.doneAt) : 'À rappeler avant le ' + date(c.dueAt) + ' à ' + hour(c.dueAt));
      if (!c.doneAt && ID.test(c.taskId)) {
        var b = el('button', 'Rappel fait');
        b.setAttribute('type', 'button');
        b.addEventListener('click', function () { callbackDone(c.taskId, personId); });
        li.appendChild(b);
      }
      return li;
    });
    body.appendChild(block('Rappels', callbacks));
    body.appendChild(block('Projets', (f.projects || []).map(function (p) {
      var budget = p.budgetMaxEur ? ', budget jusqu’à ' + p.budgetMaxEur + ' €' : '';
      return line((PROJECTS[p.kind] || 'Autre projet') + ' (étape : ' + stage(p.stage) + ')' + budget, p.deadline ? 'Échéance le ' + date(p.deadline) : null);
    })));
    body.appendChild(block('Origines', (f.sources || []).map(function (s) { return line(channel(s.channel) + (s.detail ? ' (' + s.detail + ')' : ''), 'Le ' + date(s.occurredAt)); })));
    body.appendChild(block('Accords', (f.consents || []).map(function (c) {
      return line((PURPOSES[c.purpose] || 'autre accord') + ' par ' + channel(c.channel), c.withdrawnAt ? 'Retiré le ' + date(c.withdrawnAt) : 'Donné le ' + date(c.givenAt));
    })));
    body.appendChild(block('Derniers messages', (f.messages || []).map(function (m) {
      return line(m.body, (m.direction === 'in' ? 'Reçu' : 'Envoyé') + ' par ' + channel(m.channel) + ', le ' + date(m.occurredAt) + ' à ' + hour(m.occurredAt));
    })));
  }
  // La réponse d'une demande de fiche : clé refusée, fiche hors des droits, panne, ou la fiche.
  function ficheAnswer(r) {
    if (r.status === 401) return { refused: true };
    return r.json().then(function (body) {
      if (r.status === 403 && body && body.code === 'agent_inactive') return { refused: true };
      if (r.status === 403 || r.status === 404) return { denied: true };
      if (!r.ok || !body || body.ok !== true) return { failed: true };
      return { body: body };
    }, function () { return { failed: true }; });
  }
  function openFiche(personId) {
    if (!currentKey || typeof personId !== 'string' || !ID.test(personId)) return Promise.resolve(false);
    var mine = session;
    var key = currentKey;
    wipeFiche();
    $('fiche-etat').textContent = 'Chargement…';
    show('fiche');
    return api('/v1/fiches/' + encodeURIComponent(personId) + '/resume', key).then(ficheAnswer).then(function (res) {
      if (mine !== session) return false;
      if (res.refused) { forgetKey(); refuse('Clé refusée. Vérifiez-la ou demandez-en une nouvelle.'); return false; }
      if (res.denied) { $('fiche-etat').textContent = 'Cette fiche n’est pas dans vos droits.'; return false; }
      if (res.failed) { $('fiche-etat').textContent = 'Indisponible pour le moment. Réessayez plus tard.'; return false; }
      $('fiche-etat').textContent = '';
      renderFiche(res.body.data, personId);
      return true;
    }, function () {
      if (mine !== session) return false;
      $('fiche-etat').textContent = 'Indisponible pour le moment. Réessayez plus tard.';
      return false;
    });
  }
  // « Rappel fait » : rien n'est envoyé ; la fiche est relue pour montrer la ligne gardée.
  function callbackDone(taskId, personId) {
    if (!currentKey || !ID.test(taskId)) return Promise.resolve(false);
    var mine = session;
    var key = currentKey;
    return api('/v1/rappels/' + encodeURIComponent(taskId) + '/fait', key, 'POST').then(function (r) {
      if (mine !== session) return false;
      if (r.status === 401) { forgetKey(); refuse('Clé refusée. Vérifiez-la ou demandez-en une nouvelle.'); return false; }
      if (!r.ok) { $('fiche-etat').textContent = 'Le rappel n’a pas pu être marqué fait.'; return false; }
      return openFiche(personId);
    }, function () {
      if (mine !== session) return false;
      $('fiche-etat').textContent = 'Pas de réseau : le rappel n’est pas marqué fait.';
      return false;
    });
  }
  // Chaque entrée, sortie ou refus ouvre une nouvelle session : une réponse d'une session finie n'est jamais montrée.
  var session = 0;
  function part(id, request, render, mine) {
    var list = $(id);
    var state = $(id + '-etat');
    clear(list);
    state.textContent = 'Chargement…';
    return request.then(function (r) {
      if (r.status === 401 || r.status === 403) return { refused: true };
      if (!r.ok) return { failed: true };
      return r.json().then(function (body) { return { body: body }; });
    }).then(function (res) {
      if (mine !== session) return true;
      if (res.refused) return false;
      if (res.failed || !res.body || res.body.ok !== true) { state.textContent = 'Indisponible pour le moment. Réessayez plus tard.'; return true; }
      var empty = render(list, res.body.data);
      state.textContent = empty || '';
      return true;
    }, function () {
      if (mine !== session) return true;
      clear(list);
      state.textContent = 'Indisponible pour le moment. Réessayez plus tard.';
      return true;
    });
  }
  function day(key, mine) {
    return Promise.all([
      part('plan', api('/v1/plan-du-jour', key), renderPlan, mine),
      part('chauds', api('/v1/contacts-chauds', key), renderHot, mine),
      part('rdv', api('/v1/rendez-vous/jour', key), renderAppointments, mine),
    ]).then(function (done) {
      if (mine !== session) return;
      // Une clé refusée en cours de route : rien n'est gardé à l'écran ni sur l'appareil.
      if (done.indexOf(false) !== -1) { wipe(); forgetKey(); refuse('Clé refusée. Vérifiez-la ou demandez-en une nouvelle.'); }
    });
  }
  function wipe() {
    ['plan', 'chauds', 'rdv'].forEach(function (id) { clear($(id)); $(id + '-etat').textContent = ''; });
    wipeFiche();
  }
  function wipeFiche() {
    clear($('fiche-corps'));
    $('fiche-nom').textContent = '';
    $('fiche-etat').textContent = '';
  }
  function show(id) {
    ['connexion', 'accueil', 'attente', 'fiche'].forEach(function (s) { $(s).hidden = s !== id; });
    $('sortir').hidden = id !== 'accueil' && id !== 'fiche';
  }
  function api(path, key, method) {
    return fetch(path, { method: method || 'GET', headers: { authorization: 'Bearer ' + key }, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
  }
  function refuse(message) {
    session += 1;
    currentKey = null;
    wipe();
    $('bonjour').textContent = '';
    $('erreur').textContent = message;
    $('erreur').hidden = false;
    show('connexion');
    return false;
  }
  function enter(key) {
    session += 1;
    var mine = session;
    wipe();
    show('attente');
    return api('/v1/moi', key).then(function (r) {
      // Clé refusée : elle est effacée de l'appareil. Une panne ou une erreur du serveur ne l'efface pas.
      if (r.status === 401 || r.status === 403) return { refused: true };
      if (!r.ok) return { refused: false };
      return r.json().then(function (body) { return { body: body }; });
    }).then(function (res) {
      // Une réponse d'une session finie (sortie, autre clé) ne touche plus à rien.
      if (mine !== session) return false;
      var me = res.body && res.body.data;
      if (res.refused || (res.body && (!me || me.role !== 'agent'))) {
        forgetKey();
        return refuse('Clé refusée. Vérifiez-la ou demandez-en une nouvelle.');
      }
      if (!res.body) return refuse('Le service ne répond pas. Réessayez dans un moment.');
      $('bonjour').textContent = me.firstName ? 'Bonjour ' + me.firstName : 'Bonjour';
      $('erreur').hidden = true;
      currentKey = key;
      show('accueil');
      return day(key, mine).then(function () { return true; });
    }, function () {
      if (mine !== session) return false;
      return refuse('Pas de réseau. Réessayez dans un moment.');
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
    $('retour').addEventListener('click', function () {
      if (!currentKey) return;
      session += 1;
      wipeFiche();
      show('accueil');
      day(currentKey, session);
    });
    $('sortir').addEventListener('click', function () {
      session += 1;
      currentKey = null;
      forgetKey();
      $('bonjour').textContent = '';
      wipe();
      show('connexion');
    });
    var key = readKey();
    if (key) enter(key); else show('connexion');
    var offline = 'Cet appareil ne garde pas l’application : elle ne s’ouvrira qu’avec du réseau.';
    function warn() { $('note').textContent = offline; $('note').hidden = false; }
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).catch(warn); else warn();
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

