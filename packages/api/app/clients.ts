/**
 * L'écran « Clients » de l'application de l'agent (DS003), en morceaux posés dans `fichiers.ts` : son onglet, sa
 * section de page, son chargeur, et son script servi à part (`/app/clients.js`), chargé à la première ouverture pour
 * tenir le budget de l'application [R201].
 *
 * La liste est celle de `GET /v1/fiches` : pour un agent, ses clients seulement, chaque lecture écrite au journal
 * [R16]. L'écran ne décide rien : il range par dernier échange, le plus récent d'abord, et cherche par nom dans ce
 * qu'il a reçu. Il ne garde rien sur l'appareil ; la liste s'efface quand on quitte l'onglet, et avec la session.
 * Tout texte reçu est posé avec `textContent`.
 */

/** L'onglet, entre la journée et les outils. */
export const CLIENTS_TAB_HTML = `<button id="clients-ouvrir" type="button" class="discret"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.200-5.500 6.500-5.500s5.900 1.900 6.500 5.500M16 4.800a3.500 3.500 0 0 1 0 6.400M18.500 14.900c1.700.9 2.700 2.600 3 5.100"/></svg>Clients</button>
`;

export const CLIENTS_HTML = `<section id="clients" hidden>
<h2 id="clients-titre">Mes clients</h2>
<p id="clients-etat" class="etat" role="status"></p>
<div id="clients-corps"></div>
</section>
`;

/** Le chargeur posé dans le script de l'application : l'écran est servi à part, chargé une fois, jamais gardé. */
export const CLIENTS_JS = `
  /* ---------- DS003 · « Clients » : la liste des clients de l'agent, chargée au premier geste [R16, R201]. ---------- */
  function wipeClients(all) {
    if (toolCache.clients) toolCache.clients.wipe(all);
    clear($('clients-corps'));
    $('clients-etat').textContent = '';
  }
  function openClients() {
    if (!currentKey) return Promise.resolve(false);
    show('clients');
    return withTool('clients', 'AIMMO_CLIENTS', 'clients-etat', 'clients', function (c) { return c.open(); }, function () { return { $: $, el: el, clear: clear, send: send, button: button, down: down, date: date, openFiche: openFiche, session: function () { return session; } }; });
  }
`;

/** Le script servi à part (`/app/clients.js`). Il ne lit que `GET /v1/fiches` [R16], et ne garde rien. */
export const CLIENTS_SCRIPT = `'use strict';
globalThis.AIMMO_CLIENTS = function (t) {
  var $ = t.$, el = t.el, clear = t.clear;
  var ID = /^[A-Za-z0-9-]{1,64}$/, STEP = 50;
  var all = [], shown = STEP, query = '', list = null, count = null;
  /* Chercher sans tenir compte des accents ni des capitales : « elodie » trouve « Élodie ». */
  function plain(s) { return String(s || '').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase(); }
  function nameOf(p) { return ((p.first_name || '') + ' ' + (p.last_name || '')).trim() || 'Sans nom'; }
  function row(p) {
    var b = list.appendChild(el('li')).appendChild(t.button('', function () { t.openFiche(p.id); }));
    b.className = 'secondaire rangee';
    var text = b.appendChild(el('span'));
    text.appendChild(el('strong', nameOf(p)));
    var day = p.last_contact_at ? t.date(p.last_contact_at) : '';
    text.appendChild(el('span', day ? 'Dernier échange le ' + day : 'Aucun échange noté', 'doux'));
  }
  function draw() {
    var q = plain(query).trim();
    var found = q ? all.filter(function (p) { return plain(nameOf(p)).indexOf(q) !== -1; }) : all;
    clear(list);
    found.slice(0, shown).forEach(row);
    if (found.length > shown) {
      var rest = found.length - shown;
      var more = list.appendChild(el('li')).appendChild(t.button('Voir la suite : ' + rest + (rest > 1 ? ' autres' : ' autre'), function () { shown += STEP; draw(); }));
      more.className = 'secondaire';
    }
    count.textContent = !all.length ? 'Aucun client pour le moment.' : !found.length ? 'Aucun client à ce nom.' : q ? found.length + ' sur ' + all.length : all.length + (all.length > 1 ? ' clients' : ' client');
  }
  function build() {
    var body = $('clients-corps');
    clear(body);
    var label = body.appendChild(el('label', 'Chercher par nom'));
    label.setAttribute('for', 'clients-chercher');
    var input = body.appendChild(el('input'));
    input.setAttribute('id', 'clients-chercher');
    input.setAttribute('type', 'search');
    input.setAttribute('autocomplete', 'off');
    input.value = query;
    input.addEventListener('input', function () { query = input.value; shown = STEP; draw(); });
    count = body.appendChild(el('p', '', 'doux'));
    count.setAttribute('role', 'status');
    list = body.appendChild(el('ul', null, 'liste'));
    list.setAttribute('id', 'clients-liste');
  }
  function open() {
    var mine = t.session();
    $('clients-etat').textContent = 'Chargement…';
    return t.send('/v1/fiches', 'GET').then(function (res) {
      if (res.gone || mine !== t.session()) return false;
      if (!res.ok || !Array.isArray(res.body.data)) { clear($('clients-corps')); t.down($('clients-etat'), res.offline); return false; }
      $('clients-etat').textContent = '';
      /* Le dernier échange d'abord ; sans échange, par nom. */
      all = res.body.data.filter(function (p) { return p && typeof p.id === 'string' && ID.test(p.id); }).sort(function (a, b) {
        var x = a.last_contact_at || '', y = b.last_contact_at || '';
        return x === y ? nameOf(a).localeCompare(nameOf(b), 'fr') : x < y ? 1 : -1;
      });
      shown = STEP;
      build();
      draw();
      return true;
    });
  }
  /* Quitter l'onglet efface la liste ; la recherche en cours revient avec l'onglet, sauf à la fin de la session. */
  function wipe(everything) { all = []; list = count = null; if (everything) query = ''; }
  return { open: open, wipe: wipe };
};
`;
