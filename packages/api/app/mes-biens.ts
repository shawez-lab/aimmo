/**
 * L'écran « Biens » de l'application de l'agent (DS004), en morceaux posés dans `fichiers.ts` : son onglet, sa section
 * de page, son chargeur, et son script servi à part (`/app/mes-biens.js`), chargé à la première ouverture pour tenir le
 * budget de l'application [R201].
 *
 * La liste est celle de `GET /v1/annonces` : pour un agent, ses biens seulement, ceux qui ne sont ni vendus, ni loués,
 * ni retirés [R16]. L'écran ne décide rien : il nomme chaque bien par ce qu'il est (DS023), cherche dans ce qu'il a
 * reçu, par genre, commune ou référence, et filtre par état de l'annonce. Une ligne ouvre l'écran du bien (DS013),
 * dont le « Retour » ramène à la liste. Il ne garde rien sur l'appareil ; la liste s'efface quand on quitte l'onglet,
 * et avec la session. Tout texte reçu est posé avec `textContent`.
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
  var all = [], shown = STEP, query = '', only = '', list = null, count = null;
  /* Chercher sans tenir compte des accents ni des capitales : « fontaine » trouve « Fontaine-lès-Dijon ». */
  function plain(s) { return String(s || '').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase(); }
  /* L'état qui sert au filtre : celui de l'annonce, ou « aucune » tant qu'elle n'est pas publiée. */
  function stateOf(b) { return b.state ? String(b.state) : 'aucune'; }
  function stateName(s) {
    var said = s === 'aucune' ? 'pas encore publiée' : t.states[s] || 'publiée';
    return said.charAt(0).toUpperCase() + said.slice(1);
  }
  function row(b) {
    var r = list.appendChild(el('li')).appendChild(t.button('', function () { t.openPlace(b.id, b.reference, t.name(b), b.state || '', true); }));
    r.className = 'secondaire rangee';
    var text = r.appendChild(el('span'));
    text.appendChild(el('strong', t.name(b)));
    text.appendChild(el('span', t.state(b.reference, b.state), 'doux'));
  }
  function draw() {
    var q = plain(query).trim();
    var found = all.filter(function (b) { return (!only || stateOf(b) === only) && (!q || plain(t.name(b) + ' ' + b.reference).indexOf(q) !== -1); });
    clear(list);
    found.slice(0, shown).forEach(row);
    if (found.length > shown) {
      var rest = found.length - shown;
      var more = list.appendChild(el('li')).appendChild(t.button('Voir la suite : ' + rest + (rest > 1 ? ' autres' : ' autre'), function () { shown += STEP; draw(); }));
      more.className = 'secondaire';
    }
    count.textContent = !all.length ? 'Aucun bien pour le moment.' : !found.length ? 'Aucun bien ne correspond.' : found.length < all.length ? found.length + ' sur ' + all.length : all.length + (all.length > 1 ? ' biens' : ' bien');
  }
  function build() {
    var body = $('mes-biens-corps');
    clear(body);
    var label = body.appendChild(el('label', 'Chercher par genre, commune ou référence'));
    label.setAttribute('for', 'mes-biens-chercher');
    var input = body.appendChild(el('input'));
    input.setAttribute('id', 'mes-biens-chercher');
    input.setAttribute('type', 'search');
    input.setAttribute('autocomplete', 'off');
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
  function wipe(everything) { all = []; list = count = null; if (everything) { query = ''; only = ''; } }
  return { open: open, wipe: wipe };
};
`;
