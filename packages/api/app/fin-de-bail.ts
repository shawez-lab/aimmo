/**
 * La fin de bail connue, notée depuis la fiche (G15) : une raison datée de relance d'ancien contact, jamais un envoi
 * [R143]. Script servi à part (`/app/fin-de-bail.js`), chargé au premier geste [R201]. Les dates notées se relisent ; la
 * dernière fait foi et l'ancienne reste rangée, ce qui corrige une erreur de saisie sans rien effacer [R17]. Réservé à
 * l'agent de la fiche [R16]. Tout texte reçu est posé en texte.
 */

/** Le bloc de la fiche et son chargeur, posés dans le script de l'application. */
export const FIN_DE_BAIL_JS = `
  /* ---------- La fin de bail notée sur la fiche (G15), chargée au premier geste [R16, R143, R201]. ---------- */
  var finDeBailTools = null, finDeBailLoading = false;
  function finDeBailBlock(personId) {
    var box = el('section', null, 'bloc');
    var said = el('p', null, 'etat fin-bail');
    said.setAttribute('role', 'status');
    var corps = el('div');
    var open = button('Fin de bail connue', function () {
      if (finDeBailTools) { finDeBailTools.open(personId, corps, said); return; }
      if (finDeBailLoading) return;
      finDeBailLoading = true;
      var mine = session;
      said.textContent = 'Chargement…';
      var s = document.createElement('script');
      s.setAttribute('src', '/app/fin-de-bail.js');
      s.addEventListener('load', function () {
        finDeBailLoading = false;
        var make = globalThis.AIMMO_FIN_DE_BAIL;
        try { delete globalThis.AIMMO_FIN_DE_BAIL; } catch (e) { /* rien */ }
        if (mine !== session) return;
        if (typeof make !== 'function') { said.textContent = 'Indisponible pour le moment. Réessayez dans un moment.'; return; }
        finDeBailTools = make({ el: el, clear: clear, send: send, button: button, field: field, session: function () { return session; } });
        finDeBailTools.open(personId, corps, said);
      });
      s.addEventListener('error', function () {
        finDeBailLoading = false;
        if (mine === session) said.textContent = 'Pas de réseau. Réessayez dans un moment.';
      });
      $('fiche').appendChild(s);
    });
    open.className = 'secondaire';
    box.appendChild(open);
    box.appendChild(said);
    box.appendChild(corps);
    return box;
  }
`;

/** Le script servi à part. Il ne lit et n'écrit que la route de la fin de bail de cette fiche [R16]. */
export const FIN_DE_BAIL_SCRIPT = `'use strict';
globalThis.AIMMO_FIN_DE_BAIL = function (t) {
  var el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field;
  var OFFLINE = 'Pas de réseau. Réessayez dans un moment.';
  var LOST = 'La réponse n’est pas arrivée : rien n’est sûr. Rouvrez ce bloc et relisez la date retenue avant de recommencer.';
  var turn = 0;
  function open(personId, corps, said, message) {
    var path = '/v1/gagner/fiches/' + encodeURIComponent(personId) + '/fin-de-bail';
    var mine = t.session();
    var at = ++turn;
    clear(corps);
    said.textContent = 'Chargement…';
    return send(path, 'GET').then(function (res) {
      if (res.gone || mine !== t.session() || at !== turn) return false;
      if (!res.ok || !Array.isArray(res.body.data)) { said.textContent = (message ? message + ' ' : '') + (res.offline ? OFFLINE : res.status === 403 ? 'Réservé à l’agent de cette fiche.' : 'Indisponible pour le moment.'); return false; }
      res.body.data.forEach(function (d, i) { corps.appendChild(el('p', (i === 0 ? 'Date retenue : ' : 'Remplacée : ') + d.onDay, i === 0 ? null : 'doux')); });
      var day = field(corps, 'fin-bail-jour', 'Date de fin du bail');
      day.setAttribute('type', 'date');
      corps.appendChild(el('p', 'Une erreur se corrige par une nouvelle date : la dernière fait foi. Rien ne part : une relance éventuelle vous sera proposée à relire.', 'doux'));
      corps.appendChild(button('Noter cette date', function () {
        if (!day.value) { said.textContent = 'Choisissez la date.'; return; }
        said.textContent = 'Envoi…';
        send(path, 'POST', { onDay: day.value }).then(function (x) {
          if (x.gone) return;
          if (x.offline || !x.body || x.status >= 500) { said.textContent = LOST; return; }
          if (!x.ok) { said.textContent = x.status === 403 ? 'Réservé à l’agent de cette fiche.' : 'Cette date n’est pas lisible.'; return; }
          open(personId, corps, said, 'Date notée.');
        });
      }));
      said.textContent = message || '';
      return true;
    });
  }
  return { open: open };
};
`;
