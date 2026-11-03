/**
 * « À tenir sur mes ventes », à l'accueil de l'agent (W26) [R16, R59, R61, R62, R201]. Le bloc et son chargeur vont dans
 * `fichiers.ts` ; le dessin est servi à part (`/app/a-tenir.js`), chargé seulement s'il y a quelque chose à dire.
 *
 * L'écran ne lit que `GET /v1/offres/a-tenir` et ne décide rien : le serveur dit ce qui compte, l'écran le nomme. Tout
 * texte reçu est posé avec `textContent`. Une lecture manquée se dit : elle ne se lit jamais « rien à tenir » [R10].
 */
import { DEADLINES } from './dossier.ts';

const SIDES: Readonly<Record<string, string>> = { vendeur: 'du vendeur', acquereur: 'de l’acquéreur' };
// Le bouclier n'envoie aujourd'hui qu'en mode essai : rien n'arrive au client, l'écran ne laisse jamais croire le contraire.
const REMINDERS: Readonly<Record<string, string>> = {
  fait: 'Rappel écrit au client : rangé en mode essai, rien n’est parti. Prévenez-le vous-même.',
  attente: 'Rappel écrit au client : pas encore parti. Prévenez-le vous-même.',
  a_prevenir: 'Rappel écrit au client : il ne peut pas partir. Prévenez-le vous-même.',
};
const FINANCING: Readonly<Record<string, string>> = {
  sans_offre_de_pret: 'Aucune offre de prêt déclarée : date limite le ',
  refus_declare: 'Refus de prêt déclaré le ',
};

export const A_TENIR_HOME_HTML = `<section class="bloc" aria-labelledby="titre-a-tenir">
<h3 id="titre-a-tenir">À tenir sur mes ventes</h3>
<p id="a-tenir-etat" class="etat"></p>
<ul id="a-tenir" class="liste"></ul>
</section>
`;

/** Le chargeur, dans l'application : le dessin n'arrive que s'il a quelque chose à montrer. */
export const A_TENIR_JS = `
  var tenirDraw = null;
  function renderTenir(list, d) {
    if (!d || !Array.isArray(d.fonds) || !Array.isArray(d.financement) || !Array.isArray(d.echeances)) return 'Indisponible pour le moment. Réessayez plus tard.';
    if (!d.fonds.length && !d.financement.length && !d.echeances.length) return 'Rien à tenir pour le moment.';
    if (tenirDraw) return tenirDraw(list, d);
    var mine = session;
    var s = el('script');
    s.setAttribute('src', '/app/a-tenir.js');
    s.addEventListener('load', function () {
      var make = globalThis.AIMMO_A_TENIR;
      if (typeof make !== 'function') { if (mine === session) $('a-tenir-etat').textContent = 'Indisponible pour le moment. Réessayez plus tard.'; return; }
      tenirDraw = make({ el: el, button: button, clear: clear, date: date, ID: ID, openOffres: openOffres, openDossier: openDossier });
      if (mine === session) $('a-tenir-etat').textContent = tenirDraw(list, d);
    });
    s.addEventListener('error', function () { if (mine === session) $('a-tenir-etat').textContent = 'Pas de réseau. Réessayez dans un moment.'; });
    $('accueil').appendChild(s);
    return 'Chargement…';
  }
`;

export const A_TENIR_SCRIPT = `'use strict';
globalThis.AIMMO_A_TENIR = function (t) {
  var el = t.el, button = t.button, clear = t.clear, date = t.date, ID = t.ID;
  var SIDES = ${JSON.stringify(SIDES)}, REMINDERS = ${JSON.stringify(REMINDERS)};
  var FINANCING = ${JSON.stringify(FINANCING)}, DEADLINES = ${JSON.stringify(DEADLINES)};
  function day(d) { return date(String(d) + 'T12:00:00Z'); }
  function ref(l) { return 'Bien ' + String(l.reference || ''); }
  function toFile(li, l) {
    if (ID.test(l.fileId)) li.appendChild(secondary('Voir le dossier', ref(l), function () { return t.openDossier(l.fileId, l.reference); }));
  }
  function secondary(text, of, run) {
    var b = button(text, run);
    b.className = 'secondaire';
    b.setAttribute('aria-label', text + ' : ' + of);
    return b;
  }
  function fund(ul, l) {
    var li = el('li', null, 'alerte');
    li.appendChild(el('strong', ref(l) + ' : un message ' + (SIDES[l.side] || 'd’une partie') + ' parle d’argent'));
    li.appendChild(el('p', (l.messages > 1 ? l.messages + ' messages, le dernier le ' : 'Reçu le ') + date(l.lastAt) + '.'));
    var said = Array.isArray(l.subjects) ? l.subjects : [];
    if (said.length) li.appendChild(el('p', 'Sujets repérés : ' + said.join(', ') + '.', 'doux'));
    li.appendChild(el('p', 'Aucune coordonnée bancaire ne se confirme par message : vérifiez auprès du notaire, à un numéro que vous connaissez déjà.'));
    li.appendChild(el('p', REMINDERS[l.reminder] || REMINDERS.a_prevenir));
    toFile(li, l);
    ul.appendChild(li);
  }
  function financing(ul, l) {
    var li = el('li');
    li.appendChild(el('strong', ref(l)));
    li.appendChild(el('p', (FINANCING[l.kind] || 'Financement à regarder : ') + day(l.day) + '.'));
    toFile(li, l);
    ul.appendChild(li);
  }
  function deadline(ul, l) {
    var li = el('li');
    li.appendChild(el('strong', ref(l)));
    if (l.source === 'offre') {
      li.appendChild(el('p', (l.proposal ? 'Proposition sans réponse' : 'Offre sans réponse') + ' : dernier jour le ' + day(l.day) + '.'));
      if (ID.test(l.propertyId)) li.appendChild(secondary('Voir les offres', ref(l), function () { return t.openOffres(l.propertyId, l.reference); }));
    } else {
      var name = DEADLINES[l.deadline] || 'Échéance';
      li.appendChild(el('p', l.kind === 'a_saisir' || !l.day ? name + ' : date à saisir.' : name + ' : le ' + day(l.day) + '.'));
      toFile(li, l);
    }
    ul.appendChild(li);
  }
  return function (ul, d) {
    clear(ul);
    d.fonds.forEach(function (l) { fund(ul, l); });
    d.financement.forEach(function (l) { financing(ul, l); });
    d.echeances.forEach(function (l) { deadline(ul, l); });
    return '';
  };
};
`;
