/**
 * « Mes clés à rendre » sur l'accueil de l'agent (BR50), par les routes de l'armoire des clés (BR21, RC17) :
 * `GET /v1/trousseaux/a-rendre`, `POST /v1/trousseaux/<id>/rendu`, `POST /v1/trousseaux/<id>/perdu` [R272, R271, R665].
 *
 * Rien n'est lu au chargement de l'accueil : la liste n'arrive qu'au geste. Chaque trousseau dit le texte du serveur,
 * l'heure de son retour, et « en retard » une fois l'heure passée, dans l'ordre du serveur ; l'écran ne trie ni ne
 * calcule rien. Deux gestes : « Rendu à l'agence » et « Perdu ». Un trousseau perdu ne sort plus de l'armoire [R271] :
 * « Perdu » ne part qu'au second appui, et tout autre geste annule la demande. Un seul envoi à la fois ; après un retour
 * noté, la liste est relue ; une écriture sans réponse est dite incertaine. Chaque refus se dit en mots, jamais par un
 * code. Script servi à part (`/app/cles-a-rendre.js`), chargé au premier geste [R201]. Tout texte reçu est posé en texte.
 */

export const CLES_A_RENDRE_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  role: 'Les clés à rendre se lisent dans les outils d’un agent : la direction tient l’armoire depuis la fiche du bien.',
  pas_son_bien: 'Le retour de ce trousseau se note par l’agent du bien ou la direction : rapportez-le à l’agence, ils le noteront.',
  pas_responsable: 'Ce trousseau n’est plus sous votre responsabilité : la direction note son retour.',
  network: 'Ce bien n’est pas dans votre réseau.',
  pas_sorti: 'Ce trousseau est déjà revenu ou déjà noté perdu : la liste est relue.',
  unknown_key: 'Ce trousseau ne se trouve plus : la liste est relue.',
  unknown: 'Ce trousseau ne se trouve plus : la liste est relue.',
});

/** Une écriture partie sans réponse : le retour a pu être noté, la liste le dira. */
export const CLES_A_RENDRE_UNSURE = 'La réponse n’est pas arrivée : le retour a peut-être été noté. Relisez la liste avant de recommencer.';

/** Une lecture coupée par un changement d'écran : la liste se rouvre. */
export const CLES_A_RENDRE_CUT = 'Vous avez changé d’écran avant la réponse : rouvrez la liste.';

/** Le second appui demandé avant « Perdu » : un trousseau perdu ne sort plus [R271]. */
export const CLES_A_RENDRE_CONFIRM = 'Un trousseau perdu ne sort plus jamais de l’armoire. Appuyez sur « Confirmer : perdu » pour le noter.';

export const CLES_A_RENDRE_HOME_HTML = `<button id="cles-rendre-ouvrir" type="button" class="secondaire rangee">Mes clés à rendre</button>
<p id="cles-rendre-etat" class="etat" role="status"></p>
<div id="cles-rendre-corps"></div>
`;

/** Le chargeur, dans l'application : le script n'arrive qu'au premier geste, jamais gardé sur l'appareil. */
export const CLES_A_RENDRE_JS = `
  /* ---------- HX10 : « Mes clés à rendre » (BR50), chargé au premier geste [R201, R272]. ---------- */
  var keysScreen = null, keysLoading = false, CLES_CUT = ${JSON.stringify(CLES_A_RENDRE_CUT)};
  function wipeClesARendre() {
    if (keysScreen) keysScreen.wipe();
    clear($('cles-rendre-corps'));
    $('cles-rendre-etat').textContent = '';
  }
  function openClesARendre() {
    if (!currentKey) return Promise.resolve(false);
    if (keysScreen) return keysScreen.show();
    if (keysLoading) return Promise.resolve(false);
    keysLoading = true;
    var mine = session;
    $('cles-rendre-etat').textContent = 'Chargement…';
    return new Promise(function (resolve) {
      var s = el('script');
      s.setAttribute('src', '/app/cles-a-rendre.js');
      s.addEventListener('load', function () {
        keysLoading = false;
        var make = globalThis.AIMMO_CLES_A_RENDRE;
        try { delete globalThis.AIMMO_CLES_A_RENDRE; } catch (e) { /* rien */ }
        if (typeof make === 'function') keysScreen = make({ $: $, el: el, clear: clear, send: send, button: button, date: date, hour: hour, session: function () { return session; } });
        /* Coupé par un changement d'écran : jamais « Chargement… » laissé à l'accueil ; la sortie a déjà tout effacé. */
        if (mine !== session) { if (currentKey) $('cles-rendre-etat').textContent = CLES_CUT; resolve(false); return; }
        if (!keysScreen) { $('cles-rendre-etat').textContent = 'Indisponible pour le moment. Réessayez dans un moment.'; resolve(false); return; }
        resolve(keysScreen.show());
      });
      s.addEventListener('error', function () {
        keysLoading = false;
        if (currentKey) $('cles-rendre-etat').textContent = mine === session ? 'Pas de réseau. Réessayez dans un moment.' : CLES_CUT;
        resolve(false);
      });
      $('accueil').appendChild(s);
    });
  }
`;

/** Le script servi à part (`/app/cles-a-rendre.js`). Il ne lit que `/v1/trousseaux/a-rendre` et n'écrit que `rendu` et `perdu` [R16]. */
export const CLES_A_RENDRE_SCRIPT = `'use strict';
globalThis.AIMMO_CLES_A_RENDRE = function (t) {
  var $ = t.$, el = t.el, clear = t.clear, send = t.send, button = t.button, date = t.date, hour = t.hour;
  var REFUSALS = ${JSON.stringify(CLES_A_RENDRE_REFUSALS)};
  var UNSURE = ${JSON.stringify(CLES_A_RENDRE_UNSURE)};
  var CONFIRM = ${JSON.stringify(CLES_A_RENDRE_CONFIRM)};
  var OFFLINE = 'Pas de réseau. Réessayez dans un moment.';
  var ID = /^[A-Za-z0-9_-]{1,64}$/;
  var reading = 0, writing = false, writes = 0, armed = null, armedIn = -1;
  var CUT = ${JSON.stringify(CLES_A_RENDRE_CUT)};
  /* Tout clic ailleurs que sur « Confirmer : perdu », dans tout l'écran, annule la demande : il est vu avant le geste. */
  document.addEventListener('click', function (e) { if (armed && (!e || e.target !== armed)) disarm(); }, true);
  function say(m) { $('cles-rendre-etat').textContent = m; }
  function text(v) { return typeof v === 'string' ? v : ''; }
  function when(iso) { var d = date(iso), h = hour(iso); return d ? d + (h ? ' à ' + h : '') : ''; }
  function number(r) { return typeof r.number === 'number' && isFinite(r.number) ? 'n° ' + r.number : 'sans numéro'; }
  /* Tout autre geste annule un « Perdu » demandé et pas confirmé. */
  function disarm() { if (armed) { armed.textContent = 'Perdu'; armed = null; } }
  function row(r) {
    var li = el('li');
    li.appendChild(el('p', text(r.text) || 'Trousseau ' + number(r) + ' à rendre.'));
    var due = when(r.dueAt);
    if (r.overdue === true) li.appendChild(el('p', due ? 'En retard : à rendre depuis le ' + due + '.' : 'En retard.', 'alerte'));
    else li.appendChild(el('p', due ? 'À rendre au plus tard le ' + due + '.' : 'Heure du retour non dite.', 'doux'));
    if (!ID.test(text(r.keyId))) return li;
    var lost = button('Perdu', function () {
      /* Une demande faite avant un changement d'écran ne vaut plus : il faut la refaire. */
      if (armed !== lost || armedIn !== t.session()) { disarm(); armed = lost; armedIn = t.session(); lost.textContent = 'Confirmer : perdu'; say(CONFIRM); return; }
      armed = null;
      write(r, 'perdu');
    });
    var back = button('Rendu à l’agence', function () { disarm(); write(r, 'rendu'); });
    back.className = 'secondaire';
    lost.className = 'secondaire';
    li.appendChild(back);
    li.appendChild(lost);
    return li;
  }
  function render(list) {
    var out = $('cles-rendre-corps');
    clear(out);
    if (!list.length) { say('Aucune clé à rendre : vous n’avez aucun trousseau dehors.'); return; }
    var late = list.filter(function (r) { return r && r.overdue === true; }).length;
    var ul = el('ul', null, 'liste');
    list.forEach(function (r) { if (r && typeof r === 'object') ul.appendChild(row(r)); });
    out.appendChild(ul);
    say(list.length + (list.length > 1 ? ' trousseaux à rendre' : ' trousseau à rendre') + (late ? ', dont ' + late + ' en retard.' : '.'));
  }
  /* Seule la dernière lecture dessine ; une réponse arrivée après la sortie de l'écran ne montre rien. */
  function show(said) {
    if (writing) return Promise.resolve(false);
    disarm();
    var turn = ++reading;
    clear($('cles-rendre-corps'));
    say('Chargement…');
    return send('/v1/trousseaux/a-rendre', 'GET').then(function (res) {
      if (turn !== reading) return false;
      /* Coupée par un changement d'écran : jamais « Chargement… » ni une liste d'avant laissés à l'accueil. */
      if (res.gone) { clear($('cles-rendre-corps')); say(CUT); return false; }
      if (res.offline || !res.body || res.status >= 500) { say(OFFLINE); return false; }
      if (!res.ok || !Array.isArray(res.body.data)) { say(REFUSALS[(res.body || {}).code] || 'Les clés à rendre ne se lisent pas pour le moment.'); return false; }
      render(res.body.data);
      if (said) say(said + ' ' + $('cles-rendre-etat').textContent);
      return true;
    }, function () { if (turn === reading) say(OFFLINE); return false; });
  }
  /* Un seul envoi à la fois : un second geste pendant l'envoi ne part pas. */
  function write(r, outcome) {
    if (writing) return Promise.resolve(false);
    writing = true;
    /* Une réponse d'avant la sortie ne libère jamais l'envoi d'après. */
    var gen = writes;
    var turn = ++reading;
    say('Envoi…');
    return send('/v1/trousseaux/' + encodeURIComponent(r.keyId) + '/' + outcome, 'POST').then(function (res) {
      if (gen !== writes) return false;
      writing = false;
      if (turn !== reading) return false;
      /* Sans réponse, ou coupée par un changement d'écran : le retour a pu être noté, les gestes d'avant sont retirés. */
      if (res.gone || res.offline || !res.body || res.status >= 500) { clear($('cles-rendre-corps')); say(UNSURE); return false; }
      if (!res.ok) {
        var code = (res.body || {}).code;
        var said = REFUSALS[code] || 'Le retour n’a pas pu être noté. Réessayez dans un moment.';
        if (code === 'pas_sorti' || /^unknown/.test(String(code))) return show(said);
        say(said);
        return false;
      }
      return show(outcome === 'perdu' ? 'Trousseau ' + number(r) + ' noté perdu : il ne sortira plus.' : 'Trousseau ' + number(r) + ' noté rendu à l’agence.');
    }, function () { if (gen !== writes) return false; writing = false; if (turn === reading) { clear($('cles-rendre-corps')); say(UNSURE); } return false; });
  }
  function wipe() { reading += 1; writes += 1; writing = false; armed = null; clear($('cles-rendre-corps')); say(''); }
  return { show: function () { return show(''); }, wipe: wipe };
};
`;
