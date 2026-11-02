/**
 * Le dessin des alertes de l'agent (C09c) [R12, R16, R17, R201], servi à part (`/app/alertes.js`) et chargé seulement
 * quand il y en a : l'application tient ainsi son budget de poids. Tout texte reçu est posé avec `textContent`. L'écran
 * ne décide rien : le serveur dit ce que l'agent voit. Marquer vue envoie la date lue, et relit la liste quand le serveur
 * refuse (la fiche a pu changer de main) ou que l'alerte a été rouverte ; sans réseau, l'alerte reste et le bouton revient.
 */
const REASONS: Readonly<Record<string, string>> = {
  exchanges: 'Assez d’échanges avec l’assistant : la conversation est à vous.',
  needs_reply: 'Aucune réponse n’a pu partir : à vous de reprendre.',
};
const CHANNELS: Readonly<Record<string, string>> = { email: 'Mail', whatsapp: 'WhatsApp', instagram: 'Instagram', facebook: 'Facebook', site: 'Site' };

export const ALERTES_SCRIPT = `'use strict';
globalThis.AIMMO_ALERTES = function (t) {
  var $ = t.$, el = t.el, clear = t.clear, send = t.send, button = t.button, date = t.date, ficheButton = t.ficheButton;
  var REASONS = ${JSON.stringify(REASONS)};
  var CHANNELS = ${JSON.stringify(CHANNELS)};
  function state(text) { $('reprendre-etat').textContent = text; }
  var MORE = 'D’autres alertes apparaîtront quand celles-ci seront vues.';
  function row(list, a, more) {
    var li = el('li');
    li.appendChild(el('strong', a.firstName || 'Prénom inconnu'));
    li.appendChild(el('p', REASONS[a.reason] || 'À regarder.'));
    li.appendChild(el('p', [CHANNELS[a.channel], date(a.createdAt)].filter(Boolean).join(' · '), 'doux'));
    if (a.contactClosed) li.appendChild(el('p', 'Contact fermé : lisez la fiche avant tout geste.', 'retard'));
    li.appendChild(ficheButton(a.personId));
    var seen = button('Marquer vue', function () {
      if (seen.disabled) return;
      seen.disabled = true;
      send('/v1/alertes-agent/' + encodeURIComponent(a.id) + '/vue', 'POST', { createdAt: a.createdAt }).then(function (res) {
        if (res.gone) return;
        if (res.status === 403 || (res.ok && res.body.data && res.body.data.changed)) { t.reload(); return; }
        if (res.ok) {
          list.removeChild(li);
          if (!list.firstChild && more) { t.reload(); return; }
          state(list.firstChild ? (more ? MORE : '') : 'Rien à reprendre.');
          return;
        }
        seen.disabled = false;
        state(res.offline ? 'Pas de réseau : l’alerte reste à reprendre.' : 'Indisponible pour le moment. Réessayez plus tard.');
      });
    });
    seen.className = 'secondaire';
    seen.setAttribute('aria-label', 'Marquer vue : ' + (a.firstName || 'prénom inconnu'));
    li.appendChild(seen);
    list.appendChild(li);
  }
  return function (list, data) {
    clear(list);
    data.alerts.forEach(function (a) { row(list, a, data.more); });
    return data.more ? MORE : '';
  };
};
`;
