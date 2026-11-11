/**
 * Les communes à pourvoir sur l'écran du réseau (BR38) : la direction choisit un mois fini de Paris, lit commune par
 * commune les clients allés à la direction faute d'agent et le nombre d'agents qui la couvrent aujourd'hui, ce qui est
 * « à ouvrir » et « à fermer », et ouvre ou ferme une commune au recrutement avec sa raison, en un geste, par les
 * routes de BR37 (`/v1/recrutement/communes`) [R626, R627].
 * Script servi à part (`/app/communes.js`), chargé au premier geste depuis la partie « Phases et régions » [R201]. Les
 * communes sont montrées dans l'ordre reçu du serveur : rien n'est trié ni calculé ici. Aucun nom de personne ni
 * d'agent n'est demandé ni montré, aucun agent n'est classé [R14]. Chaque refus se dit en mots, jamais par un code ;
 * une réponse perdue se dit incertaine. Tout texte reçu est posé en texte.
 */

export const COMMUNES_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  role: 'Seule la direction lit et décide les communes à pourvoir.',
  invalid_body: 'La demande n’a pas pu être lue. Rechargez l’écran.',
  unknown_field: 'La demande n’a pas pu être lue. Rechargez l’écran.',
  bad_shape: 'La demande n’a pas pu être lue. Rechargez l’écran.',
  bad_month: 'Choisissez un mois dans la liste.',
  month_not_finished: 'Ce mois n’est pas fini : seuls les mois finis se lisent.',
  commune_inconnue: 'Cette commune n’est pas dans la liste de l’attribution : relisez le mois.',
  bad_open: 'La demande n’a pas pu être lue. Rechargez l’écran.',
  bad_reason: 'La raison : de 3 à 200 caractères.',
  deja_ouverte: 'Cette commune est déjà ouverte au recrutement : relisez le mois.',
  deja_fermee: 'Cette commune est déjà fermée au recrutement : relisez le mois.',
  conflit: 'Une autre décision sur cette commune vient de passer : relisez le mois, puis recommencez.',
});

/** Une écriture sans réponse, ou coupée par une panne du serveur, a pu passer : l'écran ne dit ni fait ni pas fait. */
export const COMMUNES_LOST = 'La réponse n’est pas arrivée : rien n’est sûr. Relisez le mois avant de recommencer.';

/** Le script servi à part (`/app/communes.js`). Il ne lit et n'écrit que `/v1/recrutement/communes` [R16]. */
export const COMMUNES_SCRIPT = `'use strict';
globalThis.AIMMO_COMMUNES = function (t) {
  var el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field, date = t.date;
  var REFUSALS = ${JSON.stringify(COMMUNES_REFUSALS)};
  var LOST = ${JSON.stringify(COMMUNES_LOST)};
  var OFFLINE = 'Pas de réseau. Réessayez dans un moment.';
  var MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  var MONTH = new RegExp('^[0-9]{4}-(0[1-9]|1[0-2])$');
  var root = null, out = null, status = null, picker = null, reading = 0, busy = false, shown = null;
  function say(text) { if (status) status.textContent = text; }
  function why(res, fallback) {
    if (res.offline) return OFFLINE;
    var b = res.body || {};
    return REFUSALS[b.code] || fallback;
  }
  function label(m) { return MONTH.test(m) ? MONTHS[Number(m.slice(5)) - 1] + ' ' + m.slice(0, 4) : ''; }
  /* Les douze derniers mois finis de Paris ; le serveur refait le contrôle et refuse un mois en cours. */
  function finished() {
    var today = '';
    try { today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }); } catch (e) { today = new Date().toISOString(); }
    var y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7)), list = [];
    for (var i = 0; i < 12; i++) {
      m -= 1;
      if (m === 0) { m = 12; y -= 1; }
      list.push(y + '-' + (m < 10 ? '0' : '') + m);
    }
    return list;
  }
  function count(n, one, many) { return n + ' ' + (n > 1 ? many : one); }
  function whole(n) { return typeof n === 'number' && isFinite(n) && n >= 0 && Math.floor(n) === n; }
  function render(v) {
    clear(out);
    if (!v || !Array.isArray(v.communes)) { say('Les communes ne se lisent pas pour le moment.'); return; }
    var name = label(String(v.month));
    out.appendChild(el('h4', (/^[aeiou]/.test(name) ? 'Mois d’' : 'Mois de ') + name));
    var toOpen = v.communes.filter(function (c) { return c && c.toOpen === true; }).length;
    var toClose = v.communes.filter(function (c) { return c && c.toClose === true; }).length;
    out.appendChild(el('p', (toOpen ? count(toOpen, 'commune à ouvrir', 'communes à ouvrir') : 'Aucune commune à ouvrir') + ' ; ' + (toClose ? count(toClose, 'commune à fermer', 'communes à fermer') : 'aucune à fermer') + '.', 'compte'));
    if (whole(v.withoutCommune) && v.withoutCommune > 0) out.appendChild(el('p', count(v.withoutCommune, 'client allé', 'clients allés') + ' à la direction sans commune connue, ou hors de la liste : comptés à part, jamais rangés dans une commune.', 'doux'));
    var ul = el('ul', null, 'liste');
    v.communes.forEach(function (c, i) {
      if (!c || typeof c.commune !== 'string' || !whole(c.clientsWaiting) || !whole(c.agentsNow)) return;
      var li = el('li');
      li.appendChild(el('strong', c.commune));
      li.appendChild(el('p', (c.clientsWaiting ? count(c.clientsWaiting, 'client allé', 'clients allés') + ' à la direction faute d’agent ce mois-là' : 'Aucun client allé à la direction faute d’agent ce mois-là') + ' ; ' + (c.agentsNow ? count(c.agentsNow, 'agent la couvre', 'agents la couvrent') + ' aujourd’hui.' : 'aucun agent ne la couvre aujourd’hui.')));
      var since = c.open === true && c.openSince ? date(c.openSince) : '';
      li.appendChild(el('p', c.open === true ? 'Ouverte au recrutement' + (since ? ' depuis le ' + since : '') + '.' : 'Fermée au recrutement.', 'doux'));
      if (c.toOpen === true) li.appendChild(el('p', 'À ouvrir : des clients ont attendu, aucun agent ne la couvre et elle n’est pas ouverte.', 'alerte'));
      if (c.toClose === true) li.appendChild(el('p', 'À fermer : un agent la couvre désormais, si vous le décidez.', 'alerte'));
      var open = c.open !== true;
      var d = el('details');
      d.appendChild(el('summary', open ? 'Ouvrir au recrutement' : 'Fermer au recrutement'));
      var reason = field(d, 'commune-raison-' + i, 'La raison, de 3 à 200 caractères', 'textarea');
      reason.setAttribute('maxlength', '200');
      d.appendChild(button((open ? 'Ouvrir ' : 'Fermer ') + c.commune + ' au recrutement', function () {
        var text = String(reason.value || '').trim().replace(/\\s+/g, ' ');
        if (text.length < 3 || text.length > 200) { say(REFUSALS.bad_reason); return; }
        decide(c.commune, open, text);
      }));
      li.appendChild(d);
      ul.appendChild(li);
    });
    out.appendChild(ul);
    if (!ul.firstChild) out.appendChild(el('p', 'Aucune commune dans la liste.', 'doux'));
  }
  /* Seule la dernière lecture dessine : une réponse arrivée après une autre lecture, ou après la sortie, ne montre rien. */
  function read(m, message) {
    if (!MONTH.test(String(m))) { say(REFUSALS.bad_month); return Promise.resolve(false); }
    var turn = ++reading, mine = t.session();
    clear(out);
    say('Chargement…');
    return send('/v1/recrutement/communes?mois=' + encodeURIComponent(m), 'GET').then(function (res) {
      if (res.gone || turn !== reading || mine !== t.session()) return false;
      if (!res.ok || !res.body || !res.body.data) { say((message ? message + ' ' : '') + why(res, 'Les communes ne se lisent pas pour le moment.')); return false; }
      shown = m;
      render(res.body.data);
      say(message || '');
      return true;
    });
  }
  /* Une seule décision à la fois ; après une réponse sûre, le mois est relu. */
  function decide(commune, open, reason) {
    if (busy) return Promise.resolve(false);
    busy = true;
    var mine = t.session();
    say('Envoi…');
    return send('/v1/recrutement/communes/decision', 'POST', { commune: commune, open: open, reason: reason }).then(function (x) {
      busy = false;
      if (x.gone || mine !== t.session()) return false;
      if (x.offline || !x.body || x.status >= 500) { say(LOST); return false; }
      if (!x.ok) { say(why(x, 'La décision n’est pas rangée.')); return false; }
      return read(shown, commune + (open ? ' ouverte' : ' fermée') + ' au recrutement : la décision est rangée, la page de candidature le dit sans aucun chiffre.');
    }, function () { busy = false; say(LOST); return false; });
  }
  function show(inner) {
    if (root !== inner) {
      root = inner;
      clear(inner);
      var months = finished();
      picker = field(inner, 'communes-mois', 'Le mois fini à lire', 'select');
      months.forEach(function (m) { var o = el('option', label(m)); o.setAttribute('value', m); picker.appendChild(o); });
      picker.value = months[0];
      inner.appendChild(button('Lire ce mois', function () { read(picker.value); }));
      status = el('p', null, 'etat');
      status.setAttribute('role', 'status');
      inner.appendChild(status);
      out = el('div');
      inner.appendChild(out);
    }
    return read(picker.value);
  }
  return { show: show };
};
`;
