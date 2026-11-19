/**
 * Les guides photo à valider, sur l'écran du réseau (X23) : l'écran du Studio dit « prêt pour la validation de la
 * direction », et la direction n'ouvre jamais le Studio. Script servi à part (`/app/guides-photo.js`), chargé au premier
 * geste [R201]. Le serveur décide de ce qui est prêt [R10] ; valider deux fois ne range qu'une validation, et rien ne
 * s'efface [R17]. Réservé à la direction [R16]. Tout texte reçu est posé en texte, rien ne reste une fois quitté.
 */

export const GUIDES_PHOTO_ENTRY_HTML = `<section class="bloc" aria-labelledby="titre-guides-photo">
<h3 id="titre-guides-photo">Guides photo à valider</h3>
<p class="doux">Les biens dont toutes les vues obligatoires ont leur photo.</p>
<button id="guides-photo-voir" type="button" class="secondaire">Voir les guides à valider</button>
<p id="guides-photo-etat" class="etat" role="status"></p>
<div id="guides-photo-corps"></div>
</section>
`;

/** Le chargeur posé dans le script de l'application : l'écran est servi à part, chargé une fois, jamais gardé. */
export const GUIDES_PHOTO_JS = `
  /* ---------- Les guides photo à valider, sur l'écran du réseau (X23), chargés au premier geste [R16, R17, R201]. ---------- */
  function wipeGuidesPhoto() {
    clear($('guides-photo-corps'));
    $('guides-photo-etat').textContent = '';
  }
  function withGuidesPhoto(act) {
    return withTool('guides-photo', 'AIMMO_GUIDES_PHOTO', 'guides-photo-etat', 'reseau', act, function () { return { $: $, el: el, clear: clear, send: send, button: button, session: function () { return session; } }; });
  }
`;

/** Le script servi à part. Il ne lit que la liste des guides à valider et ne pose que leur validation [R16]. */
export const GUIDES_PHOTO_SCRIPT = `'use strict';
globalThis.AIMMO_GUIDES_PHOTO = function (t) {
  var $ = t.$, el = t.el, clear = t.clear, send = t.send, button = t.button;
  var OFFLINE = 'Pas de réseau. Réessayez dans un moment.';
  var DENIED = 'Réservé à la direction.';
  var LOST = 'La réponse n’est pas arrivée : rien n’est sûr. Relisez la liste : un guide validé n’y est plus, et le valider de nouveau ne range rien de plus.';
  var turn = 0, busy = false;
  function state(text) { $('guides-photo-etat').textContent = text; }
  function show(message, after) {
    var at = ++turn, mine = t.session();
    if (!message) state('Chargement…');
    return send('/v1/studio/guides-a-valider' + (after ? '?apres=' + encodeURIComponent(after) : ''), 'GET').then(function (res) {
      if (res.gone || at !== turn || mine !== t.session()) return false;
      var d = res.ok && res.body.data;
      if (!d || !Array.isArray(d.items)) {
        clear($('guides-photo-corps'));
        state((message ? message + ' ' : '') + (res.offline ? OFFLINE : res.status === 403 ? DENIED : 'Indisponible pour le moment.'));
        return false;
      }
      var corps = $('guides-photo-corps');
      clear(corps);
      if (!d.items.length) corps.appendChild(el('p', d.next ? 'Aucun guide à valider parmi ces biens.' : 'Aucun guide à valider.', 'doux'));
      var ul = el('ul', null, 'liste');
      d.items.forEach(function (g) {
        var li = el('li');
        li.appendChild(el('strong', g.reference + (g.city ? ' · ' + g.city : '')));
        li.appendChild(el('p', g.views.length + ' photo(s) retenue(s) : ' + g.views.join(', ') + '.', 'doux'));
        li.appendChild(button('Valider ce guide', function () { validate(g.propertyId); }));
        ul.appendChild(li);
      });
      if (d.items.length) corps.appendChild(ul);
      if (d.next) corps.appendChild(button('Voir les biens suivants', function () { show('', d.next); }));
      state(message || '');
      return true;
    });
  }
  function validate(id) {
    if (busy) return Promise.resolve(false);
    busy = true;
    state('Envoi…');
    return send('/v1/studio/biens/' + encodeURIComponent(id) + '/guide/validation', 'POST').then(function (x) {
      busy = false;
      if (x.gone) return false;
      if (x.offline || !x.body || x.status >= 500) { state(LOST); return false; }
      if (x.ok) return show('Guide validé.');
      if (x.status === 403) { state(DENIED); return false; }
      return show(x.body.code === 'pas_pret' ? 'Ce guide n’est plus prêt : une vue a changé. Rien n’est validé.' : 'Ce guide n’est pas validé.');
    });
  }
  return { show: show };
};
`;
