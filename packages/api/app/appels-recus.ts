/**
 * BR61 · Les appels reçus, relus dans la fiche (HX21). Le bloc « Appels reçus » se charge au geste, dans son script servi
 * à part (`/app/appels-recus.js`) [R201] : rien n'est lu avant. Il dit chaque appel rangé : quand, combien de temps, ce
 * qui a été compris avec la phrase dite par l'appelant qui le porte [R243], la demande d'arrêt [R04], et ce que l'agent
 * doit faire quand rien n'a pu être résumé. Tout texte reçu est posé en texte ; un champ mal formé n'est pas dit. Chaque
 * refus est dit en mots [R16]. Aucun envoi d'ici.
 */
import { MAX_SEGMENT_TEXT, STOP_SPAN } from '../../core/src/voix/appels.ts';
import { CATEGORY_LABELS } from './classement.ts';

/** Les longueurs que le cœur admet : un passage, et une demande d'arrêt faite de plusieurs passages qui se suivent. */
export const APPELS_RECUS_QUOTE_MAX = MAX_SEGMENT_TEXT;
export const APPELS_RECUS_STOP_MAX = STOP_SPAN * MAX_SEGMENT_TEXT + STOP_SPAN - 1;

export const APPELS_RECUS_LABELS = Object.freeze({
  city: 'Commune',
  priceEur: 'Prix évoqué',
  budgetMinEur: 'Budget à partir de',
  budgetMaxEur: 'Budget jusqu’à',
  deadline: 'Délai',
  financing: 'Financement',
  criterion: 'Critère',
});
export const APPELS_RECUS_DEADLINES = Object.freeze({ now: 'tout de suite', within_3_months: 'dans les 3 mois', within_6_months: 'dans les 6 mois', within_1_year: 'dans l’année', later: 'plus tard' });
export const APPELS_RECUS_FINANCINGS = Object.freeze({ cash: 'comptant', loan_approved: 'prêt accordé', loan_in_progress: 'prêt en cours', loan_needed: 'prêt à demander' });
export const APPELS_RECUS_STATES = Object.freeze({
  sans_enregistrement: 'Pas enregistré : l’appelant n’a pas donné son accord. Rappelez-le pour connaître sa demande.',
  indisponible: 'Le service de transcription n’a pas répondu : rien n’est résumé. Rappelez la personne.',
  echec: 'La transcription a échoué : rien n’est résumé. Rappelez la personne.',
  vide: 'Rien d’audible dans l’enregistrement : rien n’est résumé. Rappelez la personne.',
  incertaine: 'La transcription n’est pas assez sûre : rien n’est résumé. Rappelez la personne.',
});

/** BR63 · le passage de main de l'assistant vocal (HX22), dit en mots. */
export const APPELS_RECUS_TOPICS = Object.freeze({
  prix: 'le prix',
  surface: 'la surface',
  pieces: 'le nombre de pièces',
  chambres: 'les chambres',
  etage: 'l’étage',
  energie: 'le diagnostic énergétique',
  charges: 'les charges',
  exterieur: 'l’extérieur',
  stationnement: 'le stationnement',
  annee: 'l’année de construction',
  chauffage: 'le chauffage',
  commune: 'la commune',
  autre: 'une question que la fiche du bien ne couvre pas',
});
export const APPELS_RECUS_KINDS = Object.freeze({ visite: 'une visite', estimation: 'une estimation', appel: 'un rendez-vous téléphonique' });
export const APPELS_RECUS_RDV_STATES = Object.freeze({
  prevu: 'toujours prévu.',
  decale: 'décalé depuis : ',
  annule: 'annulé depuis.',
  tenu: 'tenu.',
  absent: 'la personne n’est pas venue.',
  introuvable: 'introuvable dans l’agenda : vérifiez-le.',
});

/** Le bloc de la fiche n'est plus posé dans l'application : la fiche servie à part (`/app/fiche.js`) le demande au chargeur commun (DS010). */
/** Le script servi à part. Il ne lit que la route des appels reçus de cette fiche [R16]. */
export const APPELS_RECUS_SCRIPT = `'use strict';
globalThis.AIMMO_APPELS_RECUS = function (t) {
  var el = t.el, clear = t.clear, send = t.send, button = t.button;
  var LABELS = ${JSON.stringify(APPELS_RECUS_LABELS)}, DEADLINES = ${JSON.stringify(APPELS_RECUS_DEADLINES)};
  var FINANCINGS = ${JSON.stringify(APPELS_RECUS_FINANCINGS)}, STATES = ${JSON.stringify(APPELS_RECUS_STATES)}, CATS = ${JSON.stringify(CATEGORY_LABELS)};
  var QUOTE = ${APPELS_RECUS_QUOTE_MAX}, STOP = ${APPELS_RECUS_STOP_MAX};
  var TOPICS = ${JSON.stringify(APPELS_RECUS_TOPICS)}, KINDS = ${JSON.stringify(APPELS_RECUS_KINDS)}, RDV = ${JSON.stringify(APPELS_RECUS_RDV_STATES)};
  var turn = 0;
  function own(map, k) { return typeof k === 'string' && Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; }
  function text(v, max) { return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null; }
  function count(n) { return typeof n === 'number' && isFinite(n) && n >= 0 ? Math.floor(n) : null; }
  function euros(n) { return String(n).replace(/\\B(?=(\\d{3})+(?!\\d))/g, '\\u00a0') + '\\u00a0€'; }
  function length(s) { var m = Math.floor(s / 60), r = s % 60; return m ? m + ' min' + (r ? ' ' + r + ' s' : '') : r + ' s'; }
  function clock(s) { return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }
  function value(key, v) {
    if (key === 'deadline') return own(DEADLINES, v);
    if (key === 'financing') return own(FINANCINGS, v);
    if (key === 'city' || key === 'criterion') return text(v, 80);
    var n = count(v);
    return n === null ? null : euros(n);
  }
  function when(v) { return text(v, 40) && !isNaN(Date.parse(v)) ? 'le ' + t.date(v) + ' à ' + t.hour(v) : null; }
  function assistant(box, a) {
    box.appendChild(el('p', 'Pris par votre assistant vocal, pendant que vous ne pouviez pas répondre.', 'doux'));
    var ref = text(a.propertyReference, 64);
    if (ref) box.appendChild(el('p', 'Bien de l’appel : ' + ref + '.'));
    var r = a.appointment, kind = r && own(KINDS, r.kind), at = r && when(r.start), st = r && own(RDV, r.state);
    if (kind && at && st) {
      var now = r.state === 'decale' ? when(r.current) : '';
      if (now !== null) box.appendChild(el('p', 'Rendez-vous réservé par l’assistant : ' + kind + ' ' + at + ', ' + st + (r.state === 'decale' ? now + '.' : ''), r.state === 'prevu' || r.state === 'decale' || r.state === 'tenu' ? null : 'alerte'));
    }
    var topics = (Array.isArray(a.unanswered) ? a.unanswered : []).map(function (k) { return own(TOPICS, k); }).filter(function (x, i, all) { return x && all.indexOf(x) === i; });
    if (topics.length) box.appendChild(el('p', 'À reprendre avec l’appelant, la fiche du bien n’y répondait pas : ' + topics.join(', ') + '.', 'alerte'));
  }
  function call(c) {
    var box = el('article', null, 'bloc');
    var at = text(c.startedAt, 40) && !isNaN(Date.parse(c.startedAt)) ? 'Appel du ' + t.date(c.startedAt) + ' à ' + t.hour(c.startedAt) : 'Appel reçu';
    var d = count(c.durationS);
    box.appendChild(el('h4', at + (d !== null ? ', ' + length(d) : '')));
    if (c.assistant && typeof c.assistant === 'object') assistant(box, c.assistant);
    if (c.ambiguous === true) box.appendChild(el('p', 'Ce numéro est sur plusieurs fiches : vérifiez que l’appel est bien de cette personne.', 'alerte'));
    var stop = c.stop && text(c.stop.quote, STOP);
    if (stop) box.appendChild(el('p', 'Demande d’arrêt dite par l’appelant : « ' + stop + ' ». L’arrêt de tous les envois est rangé.', 'alerte'));
    if (c.status === 'traite') {
      var cat = own(CATS, c.category);
      if (cat) box.appendChild(el('p', 'Demande comprise : ' + cat + '.'));
      var shown = 0;
      (Array.isArray(c.summary) ? c.summary : []).forEach(function (l) {
        var label = l && own(LABELS, l.key), v = label && value(l.key, l.value), q = l && text(l.quote, QUOTE);
        if (!v || !q) return;
        var p = el('p', label + ' : ' + v);
        p.appendChild(el('span', ' — dit : « ' + q + ' »', 'doux'));
        box.appendChild(p);
        shown += 1;
      });
      if (!shown) box.appendChild(el('p', 'Rien de précis n’a été compris : lisez la transcription.', 'doux'));
    } else {
      box.appendChild(el('p', own(STATES, c.status === 'impossible' ? c.failure : c.status) || 'Rien n’est résumé : rappelez la personne.', 'alerte'));
    }
    if (c.hasRecording === true) box.appendChild(el('p', 'L’enregistrement est gardé.', 'doux'));
    if (c.originKind !== 'inconnue' && text(c.originKind, 40)) box.appendChild(el('p', 'Appel venu d’un bouton d’appel du site.', 'doux'));
    var lines = (Array.isArray(c.transcript) ? c.transcript : []).filter(function (s) { return s && (s.speaker === 'appelant' || s.speaker === 'agent') && text(s.text, QUOTE) && count(s.startS) !== null; });
    if (lines.length) {
      var shownT = el('div');
      var b = button('Lire la transcription', function () {
        if (shownT.children && shownT.children.length) { clear(shownT); b.textContent = 'Lire la transcription'; return; }
        lines.forEach(function (s) { shownT.appendChild(el('p', (s.speaker === 'appelant' ? 'Appelant' : 'Agent') + ' (' + clock(count(s.startS)) + ') : ' + s.text, s.speaker === 'agent' ? 'doux' : null)); });
        b.textContent = 'Fermer la transcription';
      });
      b.className = 'secondaire';
      box.appendChild(b);
      box.appendChild(shownT);
    }
    return box;
  }
  return function (personId, corps, said) {
    var mine = t.session(), at = ++turn;
    clear(corps);
    said.textContent = 'Lecture des appels…';
    return send('/v1/fiches/' + encodeURIComponent(personId) + '/appels-recus', 'GET').then(function (x) {
      if (x.gone || mine !== t.session() || at !== turn) return false;
      if (x.offline) { said.textContent = 'Pas de réseau. Réessayez dans un moment.'; return false; }
      if (!x.ok || !Array.isArray(x.body.data)) {
        said.textContent = (x.body && text(x.body.message, 300)) || 'Les appels reçus ne se lisent pas pour le moment.';
        return false;
      }
      x.body.data.forEach(function (c) { if (c && typeof c === 'object') corps.appendChild(call(c)); });
      said.textContent = corps.children.length ? '' : 'Aucun appel reçu pour cette personne.';
      return true;
    });
  };
};
`;
