/**
 * Le dessin des étapes du jour des séquences de prospection dans le plan du jour (BR32) [R300, R301, R302, R201], servi
 * à part (`/app/sequences-jour.js`) et chargé seulement quand il y en a : l'application tient ainsi son budget de poids.
 * Tout texte reçu est posé avec `textContent`. L'écran ne décide rien : le socle relit chaque étape à la lecture du plan.
 * Un mail ou un SMS part seul par le contrôle central : aucun bouton. Une étape non proposée dit sa raison, jamais son
 * code. « Fait », « Appelé » et « A refusé » notent l'étape, puis le plan est relu.
 */
const CHANNELS: Readonly<Record<string, string>> = { email: 'mail', sms: 'SMS', phone: 'appel', letter: 'courrier', door: 'passage à la porte' };
const REASONS: Readonly<Record<string, string>> = {
  opposition_unchecked: 'Appel de prospection : la liste d’opposition au démarchage n’est pas encore vérifiable, il n’est pas proposé.',
  no_consent: 'Pas d’accord pour l’appel.',
  no_phone: 'Aucun numéro sur la fiche.',
  excluded: 'La personne ne veut plus être contactée.',
  refused_request: 'La personne a refusé les appels.',
  refused_recently: 'La personne a refusé un appel récemment.',
  too_many_calls: 'Trop d’appels récents.',
  outside_hours: 'Hors des heures d’appel permises : l’étape revient au prochain créneau.',
};

export const SEQUENCES_JOUR_SCRIPT = `'use strict';
globalThis.AIMMO_SEQUENCES = function (t) {
  var el = t.el, button = t.button, send = t.send, ficheButton = t.ficheButton, hour = t.hour;
  var CHANNELS = ${JSON.stringify(CHANNELS)};
  var REASONS = ${JSON.stringify(REASONS)};
  var ID = /^[A-Za-z0-9_-]{1,64}$/;
  var TEL = /^tel:[+]?[0-9]{6,15}$/;
  function mark(step, text, body, li) {
    var b = button(text, function () {
      if (b.disabled || !ID.test(step.stepId)) return;
      b.disabled = true;
      send('/v1/sequences/etapes/' + step.stepId + '/fait', 'POST', body).then(function (res) {
        if (res.gone) return;
        b.disabled = false;
        if (res.offline) { li.appendChild(el('p', 'Pas de réseau. Réessayez dans un moment.', 'alerte')); return; }
        if (!res.ok) { li.appendChild(el('p', 'L’étape n’a pas pu être notée : relisez le plan.', 'alerte')); return; }
        t.reload();
      });
    });
    return b;
  }
  function row(step) {
    var li = el('li');
    li.appendChild(el('strong', 'Séquence · ' + (CHANNELS[step.channel] || 'étape') + ' · ' + (step.firstName || 'Prénom inconnu')));
    if (step.action === 'auto') {
      li.appendChild(el('p', 'Part seul par le contrôle central des envois, au prochain passage.', 'doux'));
    } else if (!step.proposed) {
      li.appendChild(el('p', REASONS[step.reason] || 'Pas proposée maintenant.', 'doux'));
    } else if (step.action === 'call') {
      if (typeof step.call === 'string' && TEL.test(step.call)) {
        var a = el('a', 'Appeler');
        a.setAttribute('href', step.call);
        li.appendChild(a);
      }
      if (step.callClosesAt) li.appendChild(el('p', 'Appel permis jusqu’à ' + hour(step.callClosesAt) + '.', 'doux'));
      li.appendChild(mark(step, 'Appelé', { callOutcome: 'called' }, li));
      li.appendChild(mark(step, 'A refusé', { callOutcome: 'refused' }, li));
    } else {
      li.appendChild(mark(step, 'Fait', undefined, li));
    }
    if (typeof step.personId === 'string' && ID.test(step.personId)) li.appendChild(ficheButton(step.personId));
    return li;
  }
  return function (list, steps) {
    steps.forEach(function (step) { list.appendChild(row(step)); });
  };
};
`;
