/**
 * Les gestes d'appel de la fiche (AC12) [R204, R201], servis à part (`/app/appels.js`) et chargés à l'ouverture d'une
 * fiche où ils servent : l'application tient ainsi son budget de poids. L'écran ne décide rien : le serveur fixe l'heure et
 * la base de la note. Après un geste, la fiche est relue : le bouton suit les notes. Noter reste possible bouton fermé : un
 * fait se note, il n'ouvre rien. Un double geste ne part qu'une fois, et le serveur rend « déjà noté » pour un second.
 */
export const APPELS_SCRIPT = `'use strict';
globalThis.AIMMO_APPELS = function (t) {
  var $ = t.$, el = t.el, send = t.send, cState = t.cState, accordButton = t.accordButton, accordFailed = t.accordFailed, openFiche = t.openFiche;
  return function (box, personId) {
    var form = el('div', null, 'decision gestes');
    var state = cState();
    var path = '/v1/fiches/' + encodeURIComponent(personId) + '/appels';
    function gesture(text, outcome, done) {
      form.appendChild(accordButton(text, function () {
        state.textContent = 'Enregistrement…';
        return send(path, 'POST', { outcome: outcome }).then(function (res) {
          if (res.gone) return false;
          if (!res.ok) return accordFailed(res, personId, state, 'Rien n’est noté : réessayez.');
          if (res.body.data && res.body.data.already) { state.textContent = 'Déjà noté à l’instant.'; return false; }
          return openFiche(personId).then(function (read) {
            if (read) $('fiche-etat').textContent = done;
            return read;
          });
        });
      }));
    }
    gesture('J’ai appelé', 'called', 'Appel noté.');
    gesture('La personne a refusé', 'refused', 'Refus noté.');
    form.appendChild(el('p', 'Un refus compte aussi comme un appel. S’il s’agit de ne plus jamais être contactée, ce n’est pas un refus : prévenez la direction.', 'doux'));
    form.appendChild(state);
    box.appendChild(form);
  };
};
`;
