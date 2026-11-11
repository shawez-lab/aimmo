/**
 * L'écran de la tournée de prospection du jour et de la carte des opportunités (BR35), servi à part
 * (`/app/tournee.js`) et chargé seulement quand l'agent ouvre la partie « Ma tournée de prospection » de l'écran
 * « Gagner des mandats » : l'application tient ainsi son budget de poids [R201].
 *
 * Il ne lit que par `GET /v1/tournee` et `GET /v1/tournee/carte`, avec le seul paramètre `date` [R16] ; il n'écrit
 * rien, ne réserve rien et ne calcule rien : il montre ce que le code a décidé, dans l'ordre reçu [R298]. Les
 * rendez-vous déjà pris sont dits fixes ; ce qui ne tient pas dans la journée est dit avec sa raison, en mots. Ce qui
 * est hors des zones de l'agent n'est qu'un nombre, jamais une adresse [R297]. La carte n'a pas de fond venu d'ailleurs :
 * les opportunités sont regroupées par commune, dans l'ordre reçu. Le lien de la vue des rues n'est posé que s'il a
 * exactement la forme attendue (la seule position), ouvert dans un nouvel onglet sans référent [R299]. Un refus se dit
 * en mots, jamais par son code. Tout texte reçu est posé avec `textContent` ; rien n'est gardé sur l'appareil.
 */

const KINDS: Readonly<Record<string, string>> = { panneau: 'Panneau à récupérer', lettres: 'Lettres à déposer', diagnostic: 'Porte-à-porte après un diagnostic' };
const APPOINTMENTS: Readonly<Record<string, string>> = { estimation: 'Estimation', visite: 'Visite', signature: 'Signature', appel: 'Appel' };
const LEFT: Readonly<Record<string, string>> = {
  lieu_inconnu: 'lieu inconnu : l’adresse n’a pas été reconnue',
  pas_de_place: 'pas de place dans vos disponibilités ce jour-là',
};
/** Les raisons d'un refus, dites à l'agent : jamais un code interne. */
export const TOURNEE_REFUSALS: Readonly<Record<string, string>> = {
  role: 'La tournée de prospection est celle de l’agent : ce n’est pas dans vos droits.',
  agent_inactive: 'Votre accès d’agent n’est pas actif.',
  bad_date: 'Ce jour n’a pas pu être lu : choisissez-le dans le calendrier.',
  unknown_field: 'La demande n’a pas pu être lue.',
};
/** La seule forme admise du lien de la vue des rues : la position, rien d'autre [R299]. */
export const STREET_VIEW = /^https:\/\/www\.google\.com\/maps\/@\?api=1&map_action=pano&viewpoint=-?\d{1,2}\.\d{1,6},-?\d{1,3}\.\d{1,6}$/;

export const TOURNEE_SCRIPT = `'use strict';
globalThis.AIMMO_TOURNEE = function (t) {
  var el = t.el, clear = t.clear, send = t.send, button = t.button, hour = t.hour;
  var KINDS = ${JSON.stringify(KINDS)};
  var APPOINTMENTS = ${JSON.stringify(APPOINTMENTS)};
  var LEFT = ${JSON.stringify(LEFT)};
  var REFUSALS = ${JSON.stringify(TOURNEE_REFUSALS)};
  var STREET = ${STREET_VIEW.toString()};
  var DAY = /^\\d{4}-\\d{2}-\\d{2}$/;
  var root = null, load = 0;
  function said(res, fallback) {
    if (res.offline) return 'Pas de réseau pour cette partie.';
    var b = res.body || {};
    return REFUSALS[b.code] || fallback;
  }
  function day(s) { var p = typeof s === 'string' && DAY.test(s) ? s.split('-') : null; return p ? p[2] + '/' + p[1] + '/' + p[0] : ''; }
  function texts(a) { return Array.isArray(a) ? a.filter(function (x) { return typeof x === 'string'; }) : []; }
  function n(x) { return typeof x === 'number' && isFinite(x) && x >= 0 ? Math.round(x) : 0; }
  /** Le lien de la vue des rues, seulement à la forme attendue ; sinon la position est dite inconnue [R299]. */
  function street(box, link) {
    if (typeof link !== 'string' || !STREET.test(link)) { box.appendChild(el('p', 'Position inconnue : pas de vue des rues.', 'doux')); return; }
    var a = el('a', 'Voir la rue');
    a.setAttribute('href', link);
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
    a.setAttribute('referrerpolicy', 'no-referrer');
    box.appendChild(a);
  }
  function addresses(box, list) {
    var a = texts(list);
    if (!a.length) return;
    var ul = el('ul');
    a.forEach(function (x) { ul.appendChild(el('li', x)); });
    box.appendChild(ul);
  }
  function outside(box, count) {
    var c = n(count);
    if (c) box.appendChild(el('p', c + ' opportunité(s) hors de vos zones : comptée(s), jamais montrée(s).', 'doux'));
  }
  function stop(s) {
    var li = el('li');
    var when = hour(s.start) + (hour(s.end) ? ' – ' + hour(s.end) : '');
    if (s.kind === 'rendez-vous') {
      li.appendChild(el('strong', when + ' · ' + (APPOINTMENTS[s.appointmentKind] || 'Rendez-vous') + ' (fixe)'));
      if (typeof s.town === 'string' && s.town) li.appendChild(el('p', s.town));
      li.appendChild(el('p', 'Rendez-vous déjà pris : il ne bouge pas.', 'doux'));
      return li;
    }
    li.appendChild(el('strong', when + ' · ' + (KINDS[s.kind] || 'Arrêt') + (typeof s.town === 'string' && s.town ? ' · ' + s.town : '')));
    if (n(s.travelMinutes)) li.appendChild(el('p', n(s.travelMinutes) + ' min de route depuis l’arrêt d’avant.', 'doux'));
    if (typeof s.detail === 'string') li.appendChild(el('p', s.detail));
    addresses(li, s.addresses);
    street(li, s.streetView);
    return li;
  }
  function tour(res) {
    var box = el('section', null, 'bloc');
    var v = res.ok && res.body.data;
    if (!v) { box.appendChild(el('h4', 'Ma tournée')); box.appendChild(el('p', said(res, 'La tournée est indisponible pour le moment.'), 'etat')); return box; }
    box.appendChild(el('h4', 'Ma tournée du ' + day(v.date)));
    box.appendChild(el('p', 'Une proposition : rien n’est réservé ni envoyé. Chaque arrêt tient dans vos disponibilités, route comprise.', 'doux'));
    if (v.agendaRelie !== true) box.appendChild(el('p', 'Votre agenda personnel n’est pas encore relié : seuls vos rendez-vous AIMMO sont comptés.', 'doux'));
    var stops = Array.isArray(v.stops) ? v.stops : [];
    if (!stops.length) box.appendChild(el('p', 'Aucun arrêt ce jour-là.', 'doux'));
    else {
      var ol = el('ol', null, 'liste');
      stops.forEach(function (s) { if (s && typeof s === 'object') ol.appendChild(stop(s)); });
      box.appendChild(ol);
      box.appendChild(el('p', n(v.travelMinutes) + ' min de route estimées sur la journée.'));
    }
    var left = Array.isArray(v.left) ? v.left : [];
    if (left.length) {
      box.appendChild(el('h4', 'Pas dans la tournée (' + left.length + ')'));
      var ul = el('ul', null, 'liste');
      left.forEach(function (l) { ul.appendChild(el('li', (KINDS[l && l.kind] || 'Arrêt') + ' : ' + (LEFT[l && l.reason] || 'pas placé ce jour-là') + '.')); });
      box.appendChild(ul);
    }
    outside(box, v.outsideZone);
    return box;
  }
  /** La carte : les opportunités regroupées par commune, dans l'ordre reçu, sans fond venu d'ailleurs. */
  function map(res) {
    var box = el('section', null, 'bloc');
    var v = res.ok && res.body.data;
    var ops = v && Array.isArray(v.opportunities) ? v.opportunities : null;
    if (!ops) { box.appendChild(el('h4', 'Ma carte des opportunités')); box.appendChild(el('p', said(res, 'La carte est indisponible pour le moment.'), 'etat')); return box; }
    box.appendChild(el('h4', 'Ma carte des opportunités (' + ops.length + ')'));
    if (!ops.length) box.appendChild(el('p', 'Aucune opportunité dans vos zones pour le moment.', 'doux'));
    var towns = [], by = {};
    ops.forEach(function (o) {
      if (!o || typeof o !== 'object') return;
      var town = typeof o.town === 'string' && o.town ? o.town : 'Commune inconnue';
      if (!Object.prototype.hasOwnProperty.call(by, town)) { by[town] = []; towns.push(town); }
      by[town].push(o);
    });
    towns.forEach(function (town) {
      box.appendChild(el('h5', town + ' (' + by[town].length + ')'));
      var ul = el('ul', null, 'liste');
      by[town].forEach(function (o) {
        var li = el('li');
        li.appendChild(el('strong', (KINDS[o.kind] || 'Opportunité') + (n(o.minutes) ? ' · ' + n(o.minutes) + ' min sur place' : '')));
        if (typeof o.detail === 'string') li.appendChild(el('p', o.detail));
        addresses(li, o.addresses);
        street(li, o.streetView);
        ul.appendChild(li);
      });
      box.appendChild(ul);
    });
    outside(box, v.outsideZone);
    return box;
  }
  function open(chosen) {
    if (!root) return Promise.resolve(false);
    var box = root, mine = ++load;
    clear(box);
    var q = chosen ? '?date=' + chosen : '';
    var form = el('p');
    var label = el('label', 'Jour de la tournée ');
    var input = el('input');
    input.setAttribute('type', 'date');
    input.setAttribute('aria-label', 'Jour de la tournée');
    if (chosen) input.value = chosen;
    label.appendChild(input);
    form.appendChild(label);
    var note = el('p', 'Chargement…', 'etat');
    note.setAttribute('role', 'status');
    form.appendChild(button('Voir ce jour', function () {
      var d = typeof input.value === 'string' ? input.value : '';
      if (!DAY.test(d)) { note.textContent = 'Choisissez un jour dans le calendrier.'; return; }
      open(d);
    }));
    box.appendChild(form);
    box.appendChild(note);
    return Promise.all([send('/v1/tournee' + q, 'GET'), send('/v1/tournee/carte' + q, 'GET')]).then(function (all) {
      // Seule la dernière lecture dessine : une réponse plus ancienne, arrivée après, est oubliée.
      if (box !== root || mine !== load || all.some(function (r) { return r.gone; })) return false;
      if (all.every(function (r) { return r.offline; })) { note.textContent = 'Pas de réseau. Réessayez dans un moment.'; return false; }
      note.textContent = '';
      box.appendChild(tour(all[0]));
      box.appendChild(map(all[1]));
      return true;
    });
  }
  return { show: function (box) { root = box; return open(''); } };
};
`;
