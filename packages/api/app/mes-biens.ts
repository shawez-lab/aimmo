import { OREILLE_JS } from './oreille.ts';

/**
 * L'écran « Biens » de l'application de l'agent (DS004), en morceaux posés dans `fichiers.ts` : son onglet, sa section
 * de page, son chargeur, et son script servi à part (`/app/mes-biens.js`), chargé à la première ouverture pour tenir le
 * budget de l'application [R201].
 *
 * La liste est celle de `GET /v1/annonces` : pour un agent, ses biens seulement, ceux qui ne sont ni vendus, ni loués,
 * ni retirés [R16]. L'écran ne décide rien : il nomme chaque bien par ce qu'il est (DS023), cherche dans ce qu'il a
 * reçu, et filtre par état de l'annonce. Une ligne ouvre l'écran du bien (DS013), dont le « Retour » ramène à la
 * liste. Il ne garde rien sur l'appareil ; la liste s'efface quand on quitte l'onglet, et avec la session. Tout texte
 * reçu est posé avec `textContent`.
 *
 * Jamais vu · chercher comme on parle. L'agent tape, ou dicte, « t4 fontaine sous offre » : la recherche comprend le
 * genre (maison, appart, terrain, immeuble, local, murs, fonds), les pièces (t3, f3, 3p, 3 pièces, studio), l'état de
 * l'annonce (en vente, sous offre, pas publiée, publiée, vendu, retirée), et prend le reste pour la commune ou la
 * référence, la commune même « à l'oreille » (`oreille.ts`). Elle écrit ce qu'elle a compris, sous le champ. Rien n'est
 * deviné ni envoyé : des mots fixes, lus dans l'ordre, dans la liste déjà reçue.
 */

/** L'onglet, entre les clients et les outils. */
export const MES_BIENS_TAB_HTML = `<button id="mes-biens-ouvrir" type="button" class="discret"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11.500 12 4l9 7.500M5.500 9.500V20h13V9.500M10 20v-6h4v6"/></svg>Biens</button>
`;

export const MES_BIENS_HTML = `<section id="mes-biens" hidden>
<h2 id="mes-biens-titre">Mes biens</h2>
<p id="mes-biens-etat" class="etat" role="status"></p>
<div id="mes-biens-corps"></div>
</section>
`;

/** Le chargeur posé dans le script de l'application : l'écran est servi à part, chargé une fois, jamais gardé. */
export const MES_BIENS_JS = `
  /* ---------- DS004 · « Biens » : la liste des biens de l'agent, chargée au premier geste [R16, R201]. ---------- */
  function wipeMesBiens(all) {
    if (toolCache['mes-biens']) toolCache['mes-biens'].wipe(all);
    clear($('mes-biens-corps'));
    $('mes-biens-etat').textContent = '';
  }
  function openMesBiens() {
    if (!currentKey) return Promise.resolve(false);
    show('mes-biens');
    return withTool('mes-biens', 'AIMMO_MES_BIENS', 'mes-biens-etat', 'mes-biens', function (c) { return c.open(); }, function () { return { $: $, el: el, clear: clear, send: send, button: button, down: down, name: placeName, state: placeState, states: LISTING_STATES, openPlace: openPlace, session: function () { return session; } }; });
  }
`;

/** Le script servi à part (`/app/mes-biens.js`). Il ne lit que `GET /v1/annonces` [R16], et ne garde rien. */
export const MES_BIENS_SCRIPT = `'use strict';
globalThis.AIMMO_MES_BIENS = function (t) {
  var $ = t.$, el = t.el, clear = t.clear;
  var ID = /^[A-Za-z0-9_-]{1,64}$/, STEP = 50;
  var all = [], shown = STEP, query = '', only = '', list = null, count = null, understood = null;
  /* Chercher sans tenir compte des accents ni des capitales : « fontaine » trouve « Fontaine-lès-Dijon ». */
  function plain(s) { return String(s || '').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase(); }
${OREILLE_JS}
  /* L'état qui sert au filtre : celui de l'annonce, ou « aucune » tant qu'elle n'est pas publiée. */
  function stateOf(b) { return b.state ? String(b.state) : 'aucune'; }
  function stateName(s) {
    var said = s === 'aucune' ? 'pas encore publiée' : t.states[s] || 'publiée';
    return said.charAt(0).toUpperCase() + said.slice(1);
  }
  /*
   * Jamais vu · chercher comme on parle : « t4 fontaine sous offre ». Des mots fixes, lus dans cet ordre ; ce qui
   * reste est pris pour la commune ou la référence. « said » garde ce qui a été compris, pour l'écrire sous le champ.
   */
  var KINDS = { land: 'terrain', building: 'immeuble', commercial: 'local commercial', business_walls: 'murs commerciaux', business: 'fonds de commerce' };
  var SKIP = /^(?:a|au|aux|de|du|des|d|le|la|les|l|un|une|en|et|ou|avec|sur|dans|pour|bien|biens|annonce|annonces|piece|pieces)$/;
  function understand(typed) {
    var q = ' ' + plain(typed).replace(/[^a-z0-9-]+/g, ' ').trim() + ' ', want = { words: [], said: [] };
    function take(re, act) {
      var m = re.exec(q);
      if (!m) return;
      q = q.replace(m[0], ' ');
      act(m);
    }
    function state(code, said) { return function () { want.state = code; want.said.push(said); }; }
    take(/ (?:pas encore|pas|non) publiee?s? | a publier | sans annonce /, state('aucune', 'pas encore publiée'));
    take(/ sous offre /, state('sous_offre', 'annonce sous offre'));
    take(/ en vente /, state('en_vente', 'annonce en vente'));
    take(/ vendue?s? /, state('vendu', 'vendu'));
    take(/ retiree?s? (?:de la vente )?/, state('retiree', 'retiré de la vente'));
    take(/ publiee?s? | en ligne /, state('publiee', 'annonce publiée'));
    function rooms(n) { want.rooms = n; want.said.push(n + (n > 1 ? ' pièces' : ' pièce')); }
    take(/ studios? /, function () { rooms(1); });
    take(/ [tf] ?([1-9]) /, function (m) { rooms(Number(m[1])); });
    take(/ ([1-9]) ?(?:p|pieces?|pcs?) /, function (m) { rooms(Number(m[1])); });
    take(/ maisons? /, function () { want.dwelling = 'house'; want.said.push('maison'); });
    take(/ app(?:artement|art|t)s? /, function () { want.dwelling = 'apartment'; want.said.push('appartement'); });
    function kind(code) { return function () { want.kind = code; want.said.push(KINDS[code]); }; }
    take(/ terrains? /, kind('land'));
    take(/ immeubles? /, kind('building'));
    take(/ loca(?:l|ux)(?: commerci(?:al|aux))? | commerces? /, kind('commercial'));
    take(/ murs(?: commerciaux)? /, kind('business_walls'));
    take(/ fonds(?: de commerce)? /, kind('business'));
    q.split(' ').forEach(function (w) { if (w && !SKIP.test(w)) want.words.push(w); });
    /* Pour le dire : chaque mot restant tel qu'il a été tapé, avec ses accents. */
    var raw = String(typed).toLowerCase().split(/[^0-9a-zà-ÿœ-]+/);
    want.typed = want.words.map(function (w) {
      for (var i = 0; i < raw.length; i++) if (plain(raw[i]) === w) return raw[i];
      return w;
    });
    return want;
  }
  function fits(b, want) {
    if (want.state === 'aucune' ? b.state : want.state === 'publiee' ? !b.state : want.state && b.state !== want.state) return false;
    if (want.rooms && !(b.kind === 'home' && b.rooms === want.rooms)) return false;
    if (want.dwelling && !(b.kind === 'home' && b.dwelling === want.dwelling)) return false;
    if (want.kind && b.kind !== want.kind) return false;
    /* Le reste : dans le nom du bien ou sa référence, ou la commune telle qu'elle s'entend. */
    var where = plain(t.name(b) + ' ' + b.reference), key = sound(b.city || '');
    return want.words.every(function (w) { return where.indexOf(w) !== -1 || heardIn(key, w); });
  }
  function row(b) {
    var r = list.appendChild(el('li')).appendChild(t.button('', function () { t.openPlace(b.id, b.reference, t.name(b), b.state || '', true); }));
    r.className = 'secondaire rangee';
    var text = r.appendChild(el('span'));
    text.appendChild(el('strong', t.name(b)));
    text.appendChild(el('span', t.state(b.reference, b.state), 'doux'));
  }
  function draw() {
    var want = understand(query);
    var found = all.filter(function (b) { return (!only || stateOf(b) === only) && fits(b, want); });
    clear(list);
    found.slice(0, shown).forEach(row);
    if (found.length > shown) {
      var rest = found.length - shown;
      var more = list.appendChild(el('li')).appendChild(t.button('Voir la suite : ' + rest + (rest > 1 ? ' autres' : ' autre'), function () { shown += STEP; draw(); }));
      more.className = 'secondaire';
    }
    count.textContent = !all.length ? 'Aucun bien pour le moment.' : !found.length ? 'Aucun bien ne correspond.' : found.length < all.length ? found.length + ' sur ' + all.length : all.length + (all.length > 1 ? ' biens' : ' bien');
    /* Ce que la recherche a compris, quand elle a reconnu un genre, des pièces ou un état : l'agent voit ce qui a filtré. */
    understood.textContent = want.said.length ? 'Compris : ' + want.said.concat(want.typed.map(function (w) { return '« ' + w + ' »'; })).join(', ') + '.' : '';
  }
  function build() {
    var body = $('mes-biens-corps');
    clear(body);
    var label = body.appendChild(el('label', 'Chercher comme on parle'));
    label.setAttribute('for', 'mes-biens-chercher');
    var input = body.appendChild(el('input'));
    input.setAttribute('id', 'mes-biens-chercher');
    input.setAttribute('type', 'search');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('placeholder', 't3 dijon sous offre');
    input.value = query;
    input.addEventListener('input', function () { query = input.value; shown = STEP; draw(); });
    /* Le filtre ne propose que les états que la liste contient ; un état choisi qui n'y est plus revient à « Tous ». */
    var states = [];
    all.forEach(function (b) { if (states.indexOf(stateOf(b)) < 0) states.push(stateOf(b)); });
    if (states.indexOf(only) < 0) only = '';
    if (states.length > 1) {
      var pickLabel = body.appendChild(el('label', 'État de l’annonce'));
      pickLabel.setAttribute('for', 'mes-biens-filtre');
      var pick = body.appendChild(el('select'));
      pick.setAttribute('id', 'mes-biens-filtre');
      [''].concat(states).forEach(function (s) {
        var o = pick.appendChild(el('option', s ? stateName(s) : 'Tous'));
        o.setAttribute('value', s);
      });
      pick.value = only;
      pick.addEventListener('change', function () { only = pick.value; shown = STEP; draw(); });
    }
    understood = body.appendChild(el('p', '', 'doux'));
    count = body.appendChild(el('p', '', 'doux'));
    count.setAttribute('role', 'status');
    list = body.appendChild(el('ul', null, 'liste'));
    list.setAttribute('id', 'mes-biens-liste');
  }
  function open() {
    var mine = t.session();
    $('mes-biens-etat').textContent = 'Chargement…';
    return t.send('/v1/annonces', 'GET').then(function (res) {
      if (res.gone || mine !== t.session()) return false;
      if (!res.ok || !Array.isArray(res.body.data)) { clear($('mes-biens-corps')); t.down($('mes-biens-etat'), res.offline); return false; }
      $('mes-biens-etat').textContent = '';
      all = res.body.data.filter(function (b) { return b && typeof b.id === 'string' && ID.test(b.id); });
      shown = STEP;
      build();
      draw();
      return true;
    });
  }
  /* Quitter l'onglet efface la liste ; la recherche et le filtre reviennent avec l'onglet, sauf à la fin de la session. */
  function wipe(everything) { all = []; list = count = understood = null; if (everything) { query = ''; only = ''; } }
  return { open: open, wipe: wipe };
};
`;
