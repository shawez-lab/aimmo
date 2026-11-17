/**
 * La lettre et le magazine à l'écran de la direction (BR111) : ouvrir une édition de la lettre d'information et tirer
 * le magazine imprimable des biens, par les routes de BR03 (`/v1/marketing/lettre/editions`, `/v1/marketing/magazine`)
 * [R16, R585, R586].
 * Script servi à part (`/app/lettre.js`), chargé au premier geste depuis l'écran « Attirer » [R201].
 * Rien ne part d'ici : une édition ouverte n'est envoyée que par le passage planifié, aux seuls abonnés, avec leur lien
 * de désinscription [R583, R584, R26]. Le titre d'une édition ne porte aucun chiffre [R586] : il est vérifié avant
 * l'appel. Le magazine est demandé avec la clé dans l'en-tête, jamais dans l'adresse, puis enregistré sur le téléphone ;
 * il n'est jamais posé dans la page. Chaque refus se dit en mots, jamais par un code ; une réponse perdue se dit
 * incertaine.
 */

export const LETTRE_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  role: 'Seule la direction ouvre une édition de la lettre.',
  invalid_body: 'La demande n’a pas pu être lue. Rechargez l’écran.',
  unknown_field: 'La demande n’a pas pu être lue. Rechargez l’écran.',
  titre: 'Le titre : de 3 à 80 caractères, sans aucun chiffre. Les chiffres de la lettre viennent de la base, jamais du titre.',
  mentions_absentes: 'Les mentions obligatoires des biens ne se lisent pas : le magazine n’est pas tiré.',
  prix_inconnu: 'Un prix du magazine ne vient pas de la base : il n’est pas tiré. Relisez les prix des biens, puis recommencez.',
  coordonnee: 'Le magazine porterait une adresse mail ou un lien : il n’est pas tiré.',
  texte: 'Le texte du magazine ne passe pas le contrôle des contenus publics : il n’est pas tiré.',
});

/** Une ouverture sans réponse, ou coupée par une panne du serveur, a pu passer : l'écran ne dit ni fait ni pas fait. */
export const LETTRE_LOST = 'La réponse n’est pas arrivée : l’édition est peut-être ouverte. Vérifiez avant de recommencer, pour ne pas en ouvrir deux.';

/** Le script servi à part (`/app/lettre.js`). Il ne lit et n'écrit que `/v1/marketing/lettre` et `/v1/marketing/magazine` [R16]. */
export const LETTRE_SCRIPT = `'use strict';
globalThis.AIMMO_LETTRE = function (t) {
  var el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field;
  var REFUSALS = ${JSON.stringify(LETTRE_REFUSALS)};
  var LOST = ${JSON.stringify(LETTRE_LOST)};
  var OFFLINE = 'Pas de réseau. Réessayez dans un moment.';
  var root = null, status = null, busy = false, printing = 0;
  function say(text) { if (status) status.textContent = text; }
  function why(body, fallback) { return (body && REFUSALS[body.code]) || fallback; }
  /* Le titre, tel qu'il sera rangé : sans espace en trop. Aucun chiffre, de 3 à 80 caractères [R586]. */
  function titleOf(text) {
    var s = String(text || '').trim().replace(/\\s+/g, ' ');
    return s.length >= 3 && s.length <= 80 && !/[0-9]/.test(s) ? s : null;
  }
  function edition(box) {
    var d = el('section', null, 'bloc');
    d.appendChild(el('h4', 'Ouvrir une édition de la lettre'));
    d.appendChild(el('p', 'Rien ne part d’ici : l’édition est envoyée par le passage planifié, aux seuls abonnés, chacun avec son lien de désinscription. Les biens et les prix viennent de la base.', 'doux'));
    var title = field(d, 'lettre-titre', 'Titre de l’édition, de 3 à 80 caractères, sans chiffre');
    title.setAttribute('maxlength', '80');
    d.appendChild(button('Ouvrir cette édition', function () {
      if (busy) return Promise.resolve(false);
      var s = titleOf(title.value);
      if (s === null) { say(REFUSALS.titre); return Promise.resolve(false); }
      busy = true;
      var mine = t.session();
      say('Envoi…');
      return send('/v1/marketing/lettre/editions', 'POST', { title: s }).then(function (x) {
        busy = false;
        if (x.gone || mine !== t.session()) return false;
        if (x.offline || !x.body || x.status >= 500) { say(LOST); return false; }
        if (!x.ok) { say(why(x.body, 'L’édition n’est pas ouverte.')); return false; }
        title.value = '';
        say('Édition « ' + s + ' » ouverte. Elle partira par le passage planifié : rien n’est parti d’ici.');
        return true;
      }, function () { busy = false; say(LOST); return false; });
    }));
    box.appendChild(d);
  }
  /* Le magazine : la clé part dans l'en-tête, jamais dans l'adresse ; la page est enregistrée, jamais posée ici. */
  function magazine(box) {
    var d = el('section', null, 'bloc');
    d.appendChild(el('h4', 'Le magazine imprimable'));
    d.appendChild(el('p', 'Les biens diffusables du réseau, chacun avec ses mentions obligatoires, et les prix au m² de leurs communes. Un bien dont une mention manque n’y entre pas.', 'doux'));
    d.appendChild(button('Tirer le magazine', function () {
      var key = t.key();
      if (!key) return Promise.resolve(false);
      var turn = ++printing, mine = t.session();
      say('Préparation…');
      return fetch('/v1/marketing/magazine', { method: 'GET', headers: { authorization: 'Bearer ' + key }, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' }).then(function (r) {
        if (turn !== printing || mine !== t.session()) return false;
        if (r.status === 401) { say('Clé refusée. Vérifiez-la ou demandez-en une nouvelle.'); return false; }
        var type = String((r.headers && r.headers.get && r.headers.get('content-type')) || '');
        if (!r.ok || type.indexOf('text/html') !== 0) {
          return r.json().then(function (b) { return b; }, function () { return null; }).then(function (b) {
            if (turn === printing && mine === t.session()) say(r.status === 403 ? REFUSALS.role : why(b, 'Le magazine ne se tire pas pour le moment.'));
            return false;
          });
        }
        return r.blob().then(function (blob) {
          if (turn !== printing || mine !== t.session()) return false;
          var url = URL.createObjectURL(blob);
          var a = el('a', 'Enregistrer');
          a.href = url;
          a.download = 'magazine.html';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
          say('Magazine enregistré : ouvrez-le pour l’imprimer ou l’enregistrer en PDF.');
          return true;
        }, function () {
          /* La page coupée en route : rien n'est enregistré. */
          if (turn === printing && mine === t.session()) say(OFFLINE);
          return false;
        });
      }, function () {
        if (turn === printing && mine === t.session()) say(OFFLINE);
        return false;
      });
    }));
    box.appendChild(d);
  }
  function show(inner) {
    if (root !== inner) {
      root = inner;
      clear(inner);
      status = el('p', null, 'etat');
      status.setAttribute('role', 'status');
      inner.appendChild(status);
      edition(inner);
      magazine(inner);
    }
    say('');
    return Promise.resolve(true);
  }
  return { show: show };
};
`;
