/**
 * Le dessin des alertes de l'agent (C09c) [R12, R16, R17, R201], servi à part (`/app/alertes.js`) et chargé seulement
 * quand il y en a : l'application tient ainsi son budget de poids. Tout texte reçu est posé avec `textContent`. L'écran
 * ne décide rien : le serveur dit ce que l'agent voit. Marquer vue relit la liste quand le serveur refuse, puisque la
 * fiche a pu changer de main ; sans réseau, l'alerte reste et le bouton revient.
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
  function row(list, a) {
    var li = el('li');
    li.appendChild(el('strong', a.firstName || 'Prénom inconnu'));
    li.appendChild(el('p', REASONS[a.reason] || 'À regarder.'));
    li.appendChild(el('p', [CHANNELS[a.channel], date(a.createdAt)].filter(Boolean).join(' · '), 'doux'));
    if (a.contactClosed) li.appendChild(el('p', 'Contact fermé : lisez la fiche avant tout geste.', 'retard'));
    li.appendChild(ficheButton(a.personId));
    var seen = button('Marquer vue', function () {
      if (seen.disabled) return;
      seen.disabled = true;
      send('/v1/alertes-agent/' + encodeURIComponent(a.id) + '/vue', 'POST').then(function (res) {
        if (res.gone) return;
        if (res.ok) {
          list.removeChild(li);
          state(list.firstChild ? '' : 'Rien à reprendre.');
          return;
        }
        if (res.status === 403) { t.reload(); return; }
        seen.disabled = false;
        state(res.offline ? 'Pas de réseau : l’alerte reste à reprendre.' : 'Indisponible pour le moment. Réessayez plus tard.');
      });
    });
    seen.className = 'secondaire';
    li.appendChild(seen);
    list.appendChild(li);
  }
  return function (list, data) {
    clear(list);
    data.alerts.forEach(function (a) { row(list, a); });
    state(data.more ? 'D’autres alertes apparaîtront quand celles-ci seront vues.' : '');
  };
};
`;
