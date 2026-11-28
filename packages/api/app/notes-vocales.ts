/**
 * BR62 · Les notes vocales, relues dans la fiche (HX23). Le bloc « Notes vocales » se charge au geste, dans son script
 * servi à part (`/app/notes-vocales.js`) [R201] : rien n'est lu avant. Il dit chaque note vocale transcrite : quand, sur
 * quel canal, le texte marqué comme une transcription automatique [R240], la langue parlée et la sûreté de la
 * transcription. L'audio reste chez le canal : la fiche dit seulement qu'il est gardé [R15]. Tout texte reçu est posé en
 * texte ; un champ mal formé n'est pas dit. Chaque refus est dit en mots [R16]. Aucun envoi d'ici.
 */

import { MAX_TEXT } from '../../core/src/voix/notes-vocales.ts';

/** La longueur que le cœur admet pour un texte transcrit. */
export const NOTES_VOCALES_TEXT_MAX = MAX_TEXT;

export const NOTES_VOCALES_CHANNELS = Object.freeze({ whatsapp: 'WhatsApp', instagram: 'Instagram', facebook: 'Messenger' });

/** Les langues dites en mots ; une autre langue reconnue est dite par son code. */
export const NOTES_VOCALES_LANGUAGES = Object.freeze({
  fr: 'français',
  en: 'anglais',
  ar: 'arabe',
  es: 'espagnol',
  pt: 'portugais',
  it: 'italien',
  de: 'allemand',
  nl: 'néerlandais',
  tr: 'turc',
  zh: 'chinois',
  ru: 'russe',
  pl: 'polonais',
  ro: 'roumain',
});

/** Le bloc de la fiche n'est plus posé dans l'application : la fiche servie à part (`/app/fiche.js`) le demande au chargeur commun (DS010). */
/** Le script servi à part. Il ne lit que la route des notes vocales de cette fiche [R16]. */
export const NOTES_VOCALES_SCRIPT = `'use strict';
globalThis.AIMMO_NOTES_VOCALES = function (t) {
  var el = t.el, clear = t.clear, send = t.send;
  var CHANNELS = ${JSON.stringify(NOTES_VOCALES_CHANNELS)}, LANGUAGES = ${JSON.stringify(NOTES_VOCALES_LANGUAGES)};
  var MAX = ${NOTES_VOCALES_TEXT_MAX};
  var turn = 0;
  function own(map, k) { return typeof k === 'string' && Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; }
  function text(v, max) { return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null; }
  function language(code) {
    if (typeof code !== 'string' || !/^[a-z]{2,3}$/.test(code)) return null;
    return own(LANGUAGES, code) || 'langue « ' + code + ' »';
  }
  function sure(c) { return typeof c === 'number' && isFinite(c) && c >= 0 && c <= 1 ? Math.floor(c * 100) : null; }
  function note(n) {
    var said = text(n.transcript, MAX), canal = own(CHANNELS, n.channel);
    if (!said || !canal) return null;
    var box = el('article', null, 'bloc');
    var when = text(n.receivedAt, 40) && !isNaN(Date.parse(n.receivedAt)) ? ', le ' + t.date(n.receivedAt) + ' à ' + t.hour(n.receivedAt) : '';
    box.appendChild(el('h4', 'Note vocale reçue par ' + canal + when));
    box.appendChild(el('p', '« ' + said + ' »'));
    var lang = language(n.language), pct = sure(n.confidence);
    var how = 'Transcription automatique, pas les mots écrits par la personne'
      + (lang ? ' ; parlé en ' + lang : '')
      + (pct !== null ? ' ; sûre à ' + pct + '\\u00a0%' : '') + '.';
    box.appendChild(el('p', how, 'doux'));
    if (n.hasAudio === true) box.appendChild(el('p', 'L’audio d’origine reste chez ' + canal + '.', 'doux'));
    return box;
  }
  return function (personId, corps, said) {
    var mine = t.session(), at = ++turn;
    clear(corps);
    said.textContent = 'Lecture des notes vocales…';
    return send('/v1/fiches/' + encodeURIComponent(personId) + '/notes-vocales', 'GET').then(function (x) {
      if (x.gone || mine !== t.session() || at !== turn) return false;
      if (x.offline) { said.textContent = 'Pas de réseau. Réessayez dans un moment.'; return false; }
      if (!x.ok || !Array.isArray(x.body.data)) {
        said.textContent = (x.body && text(x.body.message, 300)) || 'Les notes vocales ne se lisent pas pour le moment.';
        return false;
      }
      x.body.data.forEach(function (n) { var b = n && typeof n === 'object' ? note(n) : null; if (b) corps.appendChild(b); });
      said.textContent = corps.children.length ? '' : 'Aucune note vocale reçue de cette personne.';
      return true;
    });
  };
};
`;
