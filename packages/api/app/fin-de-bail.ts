/**
 * La fin de bail connue, notée depuis la fiche (G15) : une raison datée de relance d'ancien contact, jamais un envoi
 * [R143]. Script servi à part (`/app/fin-de-bail.js`), chargé au premier geste [R201]. Les dates notées se relisent ; la
 * dernière fait foi et l'ancienne reste rangée, ce qui corrige une erreur de saisie sans rien effacer [R17]. Réservé à
 * l'agent de la fiche [R16]. Tout texte reçu est posé en texte.
 *
 * BR58 : le même bloc, « Dates connues », range aussi l'anniversaire ou la fête que la personne a donné, avec d'où vient
 * la date (HX25) : saisie contrôlée avant l'appel, le serveur refait tout [R404, R405] ; chaque refus est dit en mots, une
 * réponse perdue est dite incertaine [R16]. Aucun message ne part d'ici.
 *
 * BR59 : le bloc relit, au geste qui l'ouvre et après chaque date rangée, la date retenue de chaque sorte, d'où elle
 * vient et combien elle en remplace [R404, R17] ; un champ reçu mal formé n'est pas dit, tout texte reçu est posé en texte.
 */
import { CLIENT_DATE_KINDS } from '../../core/src/automatismes/dates-clients.ts';
import { DATE_REFUSALS } from '../src/scenarios.ts';

export const CLIENT_DATE_LABELS: Readonly<Record<(typeof CLIENT_DATE_KINDS)[number], string>> = Object.freeze({ anniversaire: 'Anniversaire', fete: 'Fête' });
export const CLIENT_DATE_LOST = 'La réponse n’est pas arrivée : rien n’est sûr. Rangez de nouveau la date si besoin : la dernière compte.';

/** Le bloc de la fiche n'est plus posé dans l'application : la fiche servie à part (`/app/fiche.js`) le demande au chargeur commun (DS010). */
/** Le script servi à part. Il ne lit et n'écrit que les routes de la fin de bail et des dates de cette fiche [R16]. */
export const FIN_DE_BAIL_SCRIPT = `'use strict';
globalThis.AIMMO_FIN_DE_BAIL = function (t) {
  var el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field;
  var OFFLINE = 'Pas de réseau. Réessayez dans un moment.';
  var LOST = 'La réponse n’est pas arrivée : rien n’est sûr. Rouvrez ce bloc et relisez la date retenue avant de recommencer.';
  var turn = 0;
  var KINDS = ${JSON.stringify(CLIENT_DATE_LABELS)}, KIND_KEYS = ${JSON.stringify(CLIENT_DATE_KINDS)}, DATE_REFUSALS = ${JSON.stringify(DATE_REFUSALS)};
  var DATE_LOST = ${JSON.stringify(CLIENT_DATE_LOST)};
  var MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  var DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  function own(map, k) { return typeof k === 'string' && Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; }
  function choices(box, id, label, list) {
    var f = field(box, id, label, 'select');
    list.forEach(function (o) { var n = el('option', o[1]); n.value = o[0]; f.appendChild(n); });
    f.value = '';
    return f;
  }
  /* BR58 · l'anniversaire ou la fête donné par la personne, avec d'où vient la date [R404]. Le serveur refait tout. */
  function dates(personId, corps) {
    var box = el('section', null, 'bloc');
    box.appendChild(el('h4', 'Anniversaire ou fête'));
    box.appendChild(el('p', 'Seulement une date que la personne vous a donnée, jamais devinée ni lue sur une pièce d’identité. Une correction se range comme une nouvelle date : la dernière compte. Rien ne part sans son accord pour les messages de date.', 'doux'));
    var known = el('div', null, 'dates-retenues');
    box.appendChild(known);
    var kind = choices(box, 'date-client-sorte', 'Sorte de date', [['', 'Choisir']].concat(KIND_KEYS.map(function (k) { return [k, KINDS[k]]; })));
    var month = choices(box, 'date-client-mois', 'Mois', [['', 'Choisir']].concat(MONTHS.map(function (m, i) { return [String(i + 1), m]; })));
    var day = field(box, 'date-client-jour', 'Jour du mois');
    day.setAttribute('inputmode', 'numeric');
    var proof = field(box, 'date-client-source', 'D’où vient la date (ce que la personne a dit, et quand)');
    proof.setAttribute('maxlength', '200');
    var state = el('p', null, 'etat');
    state.setAttribute('role', 'status');
    /* BR59 · les dates retenues, relues au geste qui ouvre ce bloc, puis après chaque date rangée [R404, R201]. */
    var reading = 0;
    function reread() {
      var mine = t.session(), at = ++reading;
      clear(known);
      known.appendChild(el('p', 'Lecture des dates rangées…', 'doux'));
      return send('/v1/dates-clients?personId=' + encodeURIComponent(personId), 'GET').then(function (x) {
        if (x.gone || mine !== t.session() || at !== reading) return false;
        clear(known);
        if (!x.ok || !x.body || !Array.isArray(x.body.data)) {
          known.appendChild(el('p', x.offline ? OFFLINE : x.status === 403 ? 'Dates rangées : réservées à l’agent de cette fiche.' : 'Les dates rangées ne se lisent pas pour le moment.', 'doux'));
          return false;
        }
        var shown = 0;
        x.body.data.forEach(function (d) {
          if (!d || !own(KINDS, d.kind) || !(d.month >= 1 && d.month <= 12) || !(d.day >= 1 && d.day <= DAYS[d.month - 1]) || Math.floor(d.day) !== d.day || Math.floor(d.month) !== d.month) return;
          var line = KINDS[d.kind] + ' retenu' + (d.kind === 'fete' ? 'e' : '') + ' : le ' + d.day + ' ' + MONTHS[d.month - 1] + '.';
          if (typeof d.proof === 'string' && d.proof && d.proof.length <= 200) line += ' D’où vient la date : ' + d.proof;
          var r = typeof d.replaced === 'number' && d.replaced >= 1 ? Math.floor(d.replaced) : 0;
          if (r) line += ' (remplace ' + r + (r > 1 ? ' dates plus anciennes, gardées)' : ' date plus ancienne, gardée)');
          known.appendChild(el('p', line));
          shown += 1;
        });
        if (!shown) known.appendChild(el('p', 'Aucune date rangée pour cette personne.', 'doux'));
        return true;
      });
    }
    var sending = false;
    var go = button('Ranger cette date', function () {
      if (sending) return;
      if (!own(KINDS, kind.value)) { state.textContent = DATE_REFUSALS.bad_kind; return; }
      var m = Number(month.value), d = String(day.value || '').trim();
      if (!(m >= 1 && m <= 12) || !/^[0-9]{1,2}$/.test(d) || Number(d) < 1 || Number(d) > DAYS[m - 1]) { state.textContent = DATE_REFUSALS.bad_date; return; }
      var p = String(proof.value || '').trim();
      if (!p || p.length > 200) { state.textContent = DATE_REFUSALS.no_proof; return; }
      var mine = t.session(), k = kind.value;
      sending = true;
      go.disabled = true;
      state.textContent = 'Envoi…';
      return send('/v1/dates-clients', 'POST', { personId: personId, kind: k, month: m, day: Number(d), proof: p }).then(function (x) {
        if (x.gone || mine !== t.session()) return false;
        sending = false;
        go.disabled = false;
        if (x.offline || !x.body || x.status >= 500) { state.textContent = DATE_LOST; return false; }
        if (!x.ok) {
          var b = x.body;
          state.textContent = own(DATE_REFUSALS, b.code) || (typeof b.message === 'string' && b.message && b.message.length < 300 ? b.message : 'La date n’est pas rangée.');
          return false;
        }
        state.textContent = 'Date rangée : ' + KINDS[k].toLowerCase() + ' le ' + Number(d) + ' ' + MONTHS[m - 1] + '. La dernière date rangée compte.';
        reread();
        return true;
      });
    });
    box.appendChild(go);
    box.appendChild(state);
    corps.appendChild(box);
    reread();
  }
  function open(personId, corps, said, message) {
    var path = '/v1/gagner/fiches/' + encodeURIComponent(personId) + '/fin-de-bail';
    var mine = t.session();
    var at = ++turn;
    clear(corps);
    said.textContent = 'Chargement…';
    return send(path, 'GET').then(function (res) {
      if (res.gone || mine !== t.session() || at !== turn) return false;
      if (!res.ok || !Array.isArray(res.body.data)) { said.textContent = (message ? message + ' ' : '') + (res.offline ? OFFLINE : res.status === 403 ? 'Réservé à l’agent de cette fiche.' : 'Indisponible pour le moment.'); dates(personId, corps); return false; }
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
      dates(personId, corps);
      said.textContent = message || '';
      return true;
    });
  }
  return { open: open };
};
`;
