/**
 * L'écran « Gérer mon site » de l'agent (BR42), servi à part (`/app/site.js`) et chargé seulement quand l'agent ouvre
 * la partie « Mon site » de l'écran « Gagner des mandats » : l'application tient ainsi son budget de poids [R201].
 *
 * Il ne lit que par `GET /v1/site/statistiques` et `GET /v1/site/prochaine-page`, avec le seul paramètre `jours`
 * [R16] ; il n'écrit rien et ne calcule rien : l'ordre des pages et chaque chiffre sont ceux du serveur, et chaque
 * compteur est la longueur de la liste d'identifiants reçue, pour qu'il se vérifie message par message [R286]. La
 * prochaine page à écrire est dite par la phrase et les chiffres du code [R287] ; quand rien n'est proposé, sa raison
 * est dite en mots. Aucun nom n'est montré : le serveur n'en rend pas. Un refus se dit en mots, jamais par son code.
 * Tout texte reçu est posé avec `textContent` ; rien n'est gardé sur l'appareil.
 */

/** Les sortes de pages publiques, dites à l'agent. */
const KINDS: Readonly<Record<string, string>> = {
  bien: 'Page d’un bien',
  prix: 'Page des prix',
  agent: 'Ma page d’agent',
  video: 'Vidéo',
  publication: 'Publication',
  quartier: 'Page de quartier',
  simulateur: 'Simulateur',
  portail: 'Portail',
};
/** Les périodes proposées, en jours (de 7 à 365 côté serveur). */
export const SITE_PERIODS: readonly number[] = [30, 90, 365];
/** Pourquoi rien n'est proposé, dit en mots [R287]. */
const NO_PAGE: Readonly<Record<string, string>> = {
  aucun_vendeur_mesure: 'Aucune page n’a encore amené de vendeur sur la période : rien à proposer pour le moment.',
  toutes_les_communes_ont_leur_page: 'Toutes les communes de vos zones ont déjà leur page : rien à écrire de plus.',
};
/** Les raisons d'un refus, dites à l'agent : jamais un code interne. */
export const SITE_REFUSALS: Readonly<Record<string, string>> = {
  role: 'Les statistiques du site ne sont pas dans vos droits.',
  agent_inactive: 'Votre accès d’agent n’est pas actif.',
  bad_period: 'Cette période n’a pas pu être lue : choisissez-la dans la liste.',
  unknown_field: 'La demande n’a pas pu être lue.',
};

export const SITE_SCRIPT = `'use strict';
globalThis.AIMMO_SITE = function (t) {
  var el = t.el, clear = t.clear, send = t.send, button = t.button;
  var KINDS = ${JSON.stringify(KINDS)};
  var PERIODS = ${JSON.stringify(SITE_PERIODS)};
  var NO_PAGE = ${JSON.stringify(NO_PAGE)};
  var REFUSALS = ${JSON.stringify(SITE_REFUSALS)};
  var DAY = /^\\d{4}-\\d{2}-\\d{2}$/;
  var root = null, load = 0, days = 90;
  function said(res, fallback) {
    if (res.offline) return 'Pas de réseau pour cette partie.';
    var b = res.body || {};
    return REFUSALS[b.code] || fallback;
  }
  function day(s) { var p = typeof s === 'string' && DAY.test(s) ? s.split('-') : null; return p ? p[2] + '/' + p[1] + '/' + p[0] : ''; }
  function ids(a) { return Array.isArray(a) ? a.filter(function (x) { return typeof x === 'string'; }) : []; }
  function n(x) { return typeof x === 'number' && isFinite(x) && x >= 0 ? Math.round(x) : 0; }
  function plural(c, one, many) { return c + ' ' + (c > 1 ? many : one); }
  /** Une liste d'identifiants de messages, repliée : le chiffre se vérifie [R286]. */
  function proof(box, label, list) {
    if (!list.length) return;
    var d = el('details');
    d.appendChild(el('summary', label + ' : les messages'));
    var ul = el('ul');
    list.forEach(function (x) { ul.appendChild(el('li', x)); });
    d.appendChild(ul);
    box.appendChild(d);
  }
  /** La prochaine page à écrire : la phrase et les chiffres du code, jamais refaits ici [R287]. */
  function next(res) {
    var box = el('section', null, 'bloc');
    box.appendChild(el('h4', 'La prochaine page à écrire'));
    var v = res.ok && res.body.data;
    if (!v || typeof v !== 'object') { box.appendChild(el('p', said(res, 'La proposition est indisponible pour le moment.'), 'etat')); return box; }
    var s = v.suggestion;
    if (!s || typeof s !== 'object') { box.appendChild(el('p', NO_PAGE[v.reason] || 'Rien à proposer pour le moment.', 'doux')); return box; }
    if (typeof s.text === 'string') box.appendChild(el('p', s.text));
    var f = s.figures && typeof s.figures === 'object' ? s.figures : {};
    var ul = el('ul', null, 'liste');
    ul.appendChild(el('li', 'Ces pages ont amené ' + plural(n(f.kindVendeurs), 'vendeur', 'vendeurs') + ' pour ' + plural(n(f.kindViews), 'vue', 'vues') + '.'));
    ul.appendChild(el('li', 'Vendeurs déjà arrivés par le site dans cette commune : ' + n(f.communeVendeurs) + '.'));
    if (typeof s.path === 'string' && s.path) ul.appendChild(el('li', 'Adresse de la page : ' + s.path));
    box.appendChild(ul);
    box.appendChild(el('p', 'Une proposition tirée de vos chiffres par une règle écrite : rien n’est publié tant que vous ne l’écrivez pas.', 'doux'));
    return box;
  }
  function page(p) {
    var li = el('li');
    var ref = typeof p.ref === 'string' && p.ref ? ' · ' + p.ref : '';
    li.appendChild(el('strong', (KINDS[p.kind] || 'Page') + ref));
    var demandes = ids(p.demandes), vendeurs = ids(p.vendeurs), mandats = ids(p.mandats);
    li.appendChild(el('p', plural(n(p.views), 'vue', 'vues') + ' · ' + plural(demandes.length, 'demande', 'demandes') + ' · ' + plural(vendeurs.length, 'vendeur', 'vendeurs') + ' · ' + plural(mandats.length, 'mandat', 'mandats')));
    var rate = typeof p.vendeursPour1000Vues === 'number' && isFinite(p.vendeursPour1000Vues) ? n(p.vendeursPour1000Vues) : null;
    li.appendChild(el('p', rate === null ? 'Aucune vue comptée : pas de taux.' : rate + ' vendeur(s) pour 1 000 vues.', 'doux'));
    proof(li, 'Demandes', demandes);
    proof(li, 'Vendeurs', vendeurs);
    proof(li, 'Mandats', mandats);
    return li;
  }
  function pages(res) {
    var box = el('section', null, 'bloc');
    var v = res.ok && res.body.data;
    var list = v && Array.isArray(v.pages) ? v.pages : null;
    if (!list) { box.appendChild(el('h4', 'Mes pages')); box.appendChild(el('p', said(res, 'Les statistiques sont indisponibles pour le moment.'), 'etat')); return box; }
    box.appendChild(el('h4', 'Mes pages (' + list.length + ')'));
    if (day(v.firstDay) && day(v.lastDay)) box.appendChild(el('p', 'Du ' + day(v.firstDay) + ' au ' + day(v.lastDay) + ', jours de Paris.', 'doux'));
    box.appendChild(el('p', 'Une vue est comptée sans rien garder du visiteur ; les robots ne comptent pas.', 'doux'));
    if (!list.length) { box.appendChild(el('p', 'Aucune page vue ni demande sur la période.', 'doux')); return box; }
    var ol = el('ol', null, 'liste');
    list.forEach(function (p) { if (p && typeof p === 'object') ol.appendChild(page(p)); });
    box.appendChild(ol);
    return box;
  }
  function open(chosen) {
    if (!root) return Promise.resolve(false);
    var box = root, mine = ++load;
    days = chosen;
    clear(box);
    var bar = el('p');
    bar.appendChild(el('span', 'Période : '));
    PERIODS.forEach(function (d) {
      var b = button(d + ' jours', function () { open(d); });
      if (d === chosen) b.setAttribute('aria-pressed', 'true');
      else b.setAttribute('aria-pressed', 'false');
      bar.appendChild(b);
    });
    box.appendChild(bar);
    var note = el('p', 'Chargement…', 'etat');
    note.setAttribute('role', 'status');
    box.appendChild(note);
    var q = '?jours=' + chosen;
    return Promise.all([send('/v1/site/prochaine-page' + q, 'GET'), send('/v1/site/statistiques' + q, 'GET')]).then(function (all) {
      // Seule la dernière lecture dessine : une réponse plus ancienne, arrivée après, est oubliée.
      if (box !== root || mine !== load || all.some(function (r) { return r.gone; })) return false;
      if (all.every(function (r) { return r.offline; })) { note.textContent = 'Pas de réseau. Réessayez dans un moment.'; return false; }
      note.textContent = '';
      box.appendChild(next(all[0]));
      box.appendChild(pages(all[1]));
      return true;
    });
  }
  return { show: function (box) { root = box; return open(days); } };
};
`;
