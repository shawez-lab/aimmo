/**
 * Ouvrir l'espace d'un client depuis sa fiche (EC12), servi à part (`/app/espace-agent.js`), chargé au premier geste
 * [R201]. L'agent écrit comment la personne a donné son accord [R03] ; le serveur contrôle et prépare le lien, en essai
 * [R26]. Aucun lien ni jeton ne vient à l'écran [R160]. Une réponse perdue ne se rejoue pas : chaque appel fait un nouveau
 * lien.
 */
const REFUSALS = {
  bad_consent: 'Écrivez comment la personne a donné son accord : 300 caractères au plus.',
  no_file: 'Cette personne n’est partie à aucun dossier : elle n’a pas d’espace à ouvrir.',
  not_assigned: 'Ce client est suivi par un autre agent.',
  role: 'Ce geste n’est pas dans vos droits.',
  plafond: 'Trop de liens demandés aujourd’hui pour cette personne : réessayez demain.',
  send_refused: 'Le contrôle central a refusé ce mail : vérifiez l’adresse de la fiche et son accord. Rien n’est parti.',
};

export const ESPACE_AGENT_SCRIPT = `'use strict';
globalThis.AIMMO_ESPACE_AGENT = function (t) {
  var el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field;
  var REFUSALS = ${JSON.stringify(REFUSALS)};
  function form(box, personId, say) {
    clear(box);
    say('');
    box.appendChild(el('p', 'La personne reçoit un lien personnel par mail, jamais montré ici. Seulement si elle l’a accepté elle-même.', 'doux'));
    var proof = field(box, t.seq() + '-espace-preuve', 'Comment elle a accepté d’avoir son espace', 'textarea');
    box.appendChild(button('Préparer le lien de son espace', function () {
      var text = String(proof.value || '').trim();
      if (!text || text.length > 300) { say(REFUSALS.bad_consent); return Promise.resolve(false); }
      say('Envoi…');
      return send('/v1/espaces/personnes/' + encodeURIComponent(personId) + '/ouvrir', 'POST', { consentProof: text }).then(function (res) {
        if (res.gone) return false;
        if (res.ok) {
          clear(box);
          box.appendChild(el('p', 'Lien préparé en mode essai : rien n’est parti pour de vrai.', 'fait'));
          say('');
          return true;
        }
        if (res.offline || !res.body || res.status >= 500) {
          clear(box);
          say('Réponse perdue : le lien est peut-être préparé. Rouvrez la fiche avant de recommencer.');
          return false;
        }
        say(REFUSALS[res.body.code] || (res.status === 403 ? REFUSALS.role : 'Le lien n’est pas préparé.'));
        return false;
      });
    }));
  }
  return { form: form };
};
`.replace(/^[ \t]*(?:\/\/.*|\/\*.*\*\/)[ \t]*\n/gm, '');
