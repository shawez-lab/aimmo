/**
 * « Mes actualités » sur l'accueil de l'agent (BR49) : le fil des actualités utiles (HX09) et celles « Déjà vues », par
 * les routes de BR20 et BR47 (`/v1/actualites`, `/v1/actualites/deja-vues`) [R269, R16].
 *
 * Le fil ne se lit qu'au geste de l'agent, jamais au chargement de l'accueil : une actualité rendue par le fil est
 * marquée vue pour toujours, elle ne doit l'être que quand l'agent la demande. Une réponse perdue après la réservation se
 * dit, et renvoie vers « Déjà vues », où rien n'est jamais perdu [R269]. Chaque actualité montre sa source (nom, date,
 * lien https seulement), ce qu'elle change pour l'agent, et les dossiers à lui qu'elle touche, chacun avec sa raison lue
 * dans la base ; l'écran ne trie, ne filtre ni ne calcule rien : l'ordre est celui du serveur.
 * Script servi à part (`/app/actualites.js`), chargé au premier geste [R201]. Chaque refus se dit en mots, jamais par un
 * code. Tout texte reçu est posé en texte, jamais en HTML.
 */

export const ACTUALITES_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  role: 'Les actualités se lisent dans les outils d’un agent : la direction les range depuis l’écran du réseau.',
});

/** Le fil a pu réserver des actualités sans que la réponse arrive : elles ne sont jamais perdues, elles sont dans « Déjà vues ». */
export const ACTUALITES_LOST = 'La réponse n’est pas arrivée : si des actualités vous ont été montrées, elles se relisent dans « Déjà vues ».';

/** Un changement d'écran a coupé la lecture du fil : elle ne reste jamais « Chargement… », elle renvoie vers « Déjà vues ». */
export const ACTUALITES_CUT = 'La lecture a été interrompue par un changement d’écran : les actualités qui vous ont été montrées se relisent dans « Déjà vues ».';

export const ACTUALITES_HOME_HTML = `<button id="actualites-ouvrir" type="button" class="secondaire rangee">Mes actualités</button>
<button id="actualites-vues" type="button" class="secondaire rangee" aria-label="Actualités déjà vues">Déjà vues</button>
<p id="actualites-etat" class="etat" role="status"></p>
<div id="actualites-corps"></div>
`;

/** Le chargeur, dans l'application : le script n'arrive qu'au premier geste, jamais gardé sur l'appareil. */
export const ACTUALITES_JS = `
  /* ---------- HX09 : « Mes actualités » (BR49), chargé au premier geste [R201, R269]. ---------- */
  var newsScreen = null, newsLoading = false;
  function wipeActualites() {
    if (newsScreen) newsScreen.wipe();
    clear($('actualites-corps'));
    $('actualites-etat').textContent = '';
  }
  function openActualites(kind) {
    if (!currentKey) return Promise.resolve(false);
    if (newsScreen) return newsScreen.show(kind);
    if (newsLoading) return Promise.resolve(false);
    newsLoading = true;
    var mine = session;
    $('actualites-etat').textContent = 'Chargement…';
    return new Promise(function (resolve) {
      var s = el('script');
      s.setAttribute('src', '/app/actualites.js');
      s.addEventListener('load', function () {
        newsLoading = false;
        var make = globalThis.AIMMO_ACTUALITES;
        if (typeof make !== 'function') { if (mine === session) $('actualites-etat').textContent = 'Indisponible pour le moment. Réessayez dans un moment.'; resolve(false); return; }
        newsScreen = make({ $: $, el: el, clear: clear, send: send, date: date, session: function () { return session; } });
        if (mine !== session) { resolve(false); return; }
        resolve(newsScreen.show(kind));
      });
      s.addEventListener('error', function () {
        newsLoading = false;
        if (mine === session) $('actualites-etat').textContent = 'Pas de réseau. Réessayez dans un moment.';
        resolve(false);
      });
      $('accueil').appendChild(s);
    });
  }
`;

/** Le script servi à part (`/app/actualites.js`). Il ne lit que `/v1/actualites` et `/v1/actualites/deja-vues` [R16]. */
export const ACTUALITES_SCRIPT = `'use strict';
globalThis.AIMMO_ACTUALITES = function (t) {
  var $ = t.$, el = t.el, clear = t.clear, send = t.send, date = t.date;
  var REFUSALS = ${JSON.stringify(ACTUALITES_REFUSALS)};
  var LOST = ${JSON.stringify(ACTUALITES_LOST)};
  var CUT = ${JSON.stringify(ACTUALITES_CUT)};
  var OFFLINE = 'Pas de réseau. Réessayez dans un moment.';
  var TOPICS = { juridique: 'Juridique', marche: 'Marché' };
  var DAY = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
  var HTTPS = /^https:\\/\\/[^\\s]+$/;
  var reading = 0;
  function say(text) { $('actualites-etat').textContent = text; }
  function day(d) { return DAY.test(String(d)) ? date(String(d) + 'T12:00:00Z') : ''; }
  function text(v) { return typeof v === 'string' ? v : ''; }
  function count(n, one, many) { return n + ' ' + (n > 1 ? many : one); }
  /* Une cible sans aucun critère : l'actualité va à tout le réseau. */
  function targeted(target) {
    if (!target || typeof target !== 'object') return false;
    return Object.keys(target).some(function (k) { var v = target[k]; return Array.isArray(v) ? v.length > 0 : v === true; });
  }
  function item(n, seen) {
    var li = el('li');
    li.appendChild(el('strong', text(n.title)));
    var published = day(n.publishedOn);
    li.appendChild(el('p', (TOPICS[n.topic] || 'Actualité') + (published ? ' · rangée le ' + published : '') + (seen && day(n.shownOn) ? ' · montrée le ' + day(n.shownOn) : ''), 'doux'));
    if (text(n.impact)) li.appendChild(el('p', 'Ce que ça change pour vous : ' + text(n.impact)));
    var src = n.source && typeof n.source === 'object' ? n.source : {};
    var from = 'Source : ' + (text(src.name) || 'non dite') + (day(src.date) ? ', du ' + day(src.date) : '');
    if (HTTPS.test(text(src.url))) {
      var p = el('p');
      var a = el('a', from);
      a.setAttribute('href', src.url);
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
      p.appendChild(a);
      li.appendChild(p);
    } else li.appendChild(el('p', from + ' (lien non sûr, non montré)', 'doux'));
    var concerned = Array.isArray(n.concerned) ? n.concerned.filter(function (c) { return c && typeof c.reference === 'string'; }) : [];
    if (concerned.length) {
      li.appendChild(el('p', 'Touche ' + concerned.length + ' de vos dossiers :', 'alerte'));
      var ul = el('ul');
      concerned.forEach(function (c) { ul.appendChild(el('li', 'Bien ' + c.reference + (text(c.why) ? ' : ' + text(c.why) : ''))); });
      li.appendChild(ul);
    } else li.appendChild(el('p', targeted(n.target) ? 'Ne touche plus aucun de vos dossiers aujourd’hui.' : 'Pour tout le réseau.', 'doux'));
    return li;
  }
  function render(list, seen) {
    var out = $('actualites-corps');
    clear(out);
    var ul = el('ul', null, 'liste');
    list.forEach(function (n) { if (n && typeof n.id === 'string') ul.appendChild(item(n, seen)); });
    out.appendChild(el('h4', seen ? 'Déjà vues' : 'Nouvelles'));
    if (!list.length) {
      say(seen ? 'Aucune actualité déjà vue encore en vigueur (60 jours après sa parution, une actualité n’est plus montrée).' : 'Rien de nouveau. Celles déjà montrées se relisent dans « Déjà vues ».');
      return;
    }
    out.appendChild(ul);
    say(seen ? count(list.length, 'actualité déjà vue', 'actualités déjà vues') + ', les plus récemment montrées d’abord.' : count(list.length, 'nouvelle actualité', 'nouvelles actualités') + ' : elles ne reviendront plus ici, elles se relisent dans « Déjà vues ».');
  }
  /* Seule la dernière lecture dessine ; une réponse arrivée après la sortie ne montre rien. Pendant qu'un fil est
     demandé, aucun autre geste ne part : le fil marque vu ce qu'il rend, une seconde demande ou une autre lecture
     ferait jeter une réponse dont les actualités ne reviendraient jamais au fil [R269]. */
  var feeding = null;
  function show(kind) {
    if (feeding && feeding.session === t.session()) return feeding.promise;
    var seen = kind === 'vues';
    var turn = ++reading, mine = t.session();
    clear($('actualites-corps'));
    say('Chargement…');
    var p = read(seen, turn, mine);
    if (seen) return p;
    var mark = { session: mine, promise: null };
    feeding = mark;
    mark.promise = p.then(function (done) { if (feeding === mark) feeding = null; return done; });
    return mark.promise;
  }
  function read(seen, turn, mine) {
    return send(seen ? '/v1/actualites/deja-vues' : '/v1/actualites', 'GET').then(function (res) {
      if (turn !== reading) return false;
      /* Coupée par un changement d'écran : le fil a pu marquer vu ce qu'il rendait, la lecture le redit [R269]. */
      if (res.gone || mine !== t.session()) { say(seen ? '' : CUT); return false; }
      if (res.offline || !res.body || res.status >= 500) { say(seen ? OFFLINE : LOST); return false; }
      if (!res.ok || !Array.isArray(res.body.data)) {
        var b = res.body || {};
        say(REFUSALS[b.code] || (seen ? 'Les actualités déjà vues ne se lisent pas pour le moment.' : LOST));
        return false;
      }
      render(res.body.data, seen);
      return true;
    }, function () { if (turn === reading) say(seen ? OFFLINE : LOST); return false; });
  }
  function wipe() { reading += 1; feeding = null; clear($('actualites-corps')); say(''); }
  return { show: show, wipe: wipe };
};
`;
