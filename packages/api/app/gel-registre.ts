/**
 * BR85 · Le registre national des gels importé en un appui par le responsable de la conformité (HX57, RC49).
 * Posé sur l'écran « Conformité » : script servi à part (`/app/gel-registre.js`), chargé au premier geste, sans rien
 * ajouter au script de l'application [R201].
 *
 * Deux gestes : « Importer le registre du jour », que le serveur télécharge lui-même chez la DG Trésor ; ou, quand le
 * téléchargement échoue, le fichier publié déposé tel quel. C'est le serveur qui lit tout ; l'écran arrête seulement un
 * fichier trop gros ou illisible avant l'envoi. Chaque refus est dit en mots, jamais un code ; l'entrée fautive est
 * nommée par son identifiant au registre, jamais par un nom [R13]. Une réponse perdue est dite incertaine : l'import a
 * pu se faire, et le refaire est sans danger (un fichier déjà importé est refusé). Tout texte reçu est posé en texte.
 *
 * Jamais vu : en un appui, le registre du jour est téléchargé, lu entier ou refusé entier, puis chaque dossier en cours
 * est recontrôlé contre lui ; l'écran dit la date publiée, les personnes lues, les navires laissés à part et les
 * dossiers recontrôlés.
 */

/** La taille admise par la route du dépôt (`MAX_DGTRESOR_BYTES`), en octets. */
export const GEL_REGISTRE_MAX_BYTES = 40_000_000;

/** Chaque refus, dit en mots ; un refus inconnu a sa phrase générale, jamais son code. */
export const GEL_REGISTRE_REFUSALS = Object.freeze({
  role: 'Ce n’est pas dans vos droits : seul le responsable de la conformité importe le registre des gels.',
  telechargement_absent: 'Le téléchargement depuis la DG Trésor n’est pas branché : déposez le fichier publié ci-dessous.',
  telechargement_echoue: 'Le fichier de la DG Trésor n’a pas pu être téléchargé. Réessayez plus tard, ou déposez le fichier publié ci-dessous.',
  fichier_trop_gros: 'Le fichier dépasse 40 Mo : rien n’est importé.',
  bad_file: 'Ce fichier n’a pas la forme du registre publié par la DG Trésor : rien n’est importé.',
  bad_date: 'La date de publication du fichier est absente ou illisible : rien n’est importé.',
  bad_entry_id: 'Une entrée du fichier a un identifiant illisible : rien n’est importé.',
  duplicate_entry: 'Une entrée figure deux fois dans le fichier : rien n’est importé.',
  unknown_nature: 'Une entrée a une nature inconnue (ni personne physique, ni personne morale, ni navire) : rien n’est importé.',
  bad_names: 'Une entrée n’a aucun nom lisible, ou un nom trop long : rien n’est importé.',
  too_many_names: 'Une entrée porte trop de noms : rien n’est importé.',
  no_entries: 'Le fichier ne contient aucune personne : rien n’est importé.',
  future_date: 'Le fichier est daté dans l’avenir : rien n’est importé.',
  already_imported: 'Ce registre est déjà importé : rien n’a changé.',
  older_version: 'Ce fichier est plus ancien que le registre en service : rien n’est importé.',
  invalid_body: 'Le fichier n’est pas lisible.',
});

export const GEL_REGISTRE_LOST = 'La réponse n’est pas arrivée : l’import a pu se faire. Recommencez sans crainte : un registre déjà importé est refusé.';
export const GEL_REGISTRE_OFFLINE = 'Pas de réseau. Réessayez dans un moment.';
export const GEL_REGISTRE_FAILED = 'L’import n’a pas abouti : rien n’est importé. Réessayez dans un moment.';

/** Le script servi à part. Il n'appelle que les deux routes d'import de `/v1/securite/gel/registre` [R16]. */
export const GEL_REGISTRE_SCRIPT = `'use strict';
globalThis.AIMMO_GEL_REGISTRE = function (t) {
  var el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field;
  var REFUSALS = ${JSON.stringify(GEL_REGISTRE_REFUSALS)};
  var MAX = ${GEL_REGISTRE_MAX_BYTES};
  var FROM_DGT = '/v1/securite/gel/registre/dgtresor', FROM_FILE = '/v1/securite/gel/registre/fichier';
  var LOST = ${JSON.stringify(GEL_REGISTRE_LOST)}, OFFLINE = ${JSON.stringify(GEL_REGISTRE_OFFLINE)}, FAILED = ${JSON.stringify(GEL_REGISTRE_FAILED)};
  var box = null, status = null, result = null, pick = null, busy = false;
  function own(o, k) { return typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : null; }
  function count(v) { return typeof v === 'number' && Math.floor(v) === v && v >= 0 ? v : null; }
  function plural(n, one, many) { return n + ' ' + (n <= 1 ? one : many); }
  function day(iso) {
    if (typeof iso !== 'string') return null;
    var d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    try { return d.toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'long', year: 'numeric' }); } catch (e) { return null; }
  }
  function say(text) { if (status) status.textContent = text; }
  /* L'identifiant de l'entrée fautive, dit seulement s'il a la forme d'un identifiant du registre : jamais un nom. */
  function entry(v) { return typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(v) ? ' Entrée en cause : ' + v + '.' : ''; }
  function refusal(res) {
    if (res.offline) return LOST;
    var b = res.body;
    var text = own(REFUSALS, b && b.code);
    return text ? text + entry(b && b.entryId) : FAILED;
  }
  function done(d) {
    clear(result);
    var entries = d && count(d.entries), vessels = d && count(d.vessels), checked = d && count(d.checked), when = d && day(d.publishedAt);
    if (entries === null || vessels === null || checked === null || when === null) { say('Registre importé. Le détail n’a pas pu être lu : rouvrez l’écran pour le vérifier.'); return; }
    say('Registre importé.');
    result.appendChild(el('p', 'Registre publié le ' + when + ' : ' + plural(entries, 'personne ou société lue', 'personnes ou sociétés lues') + ', ' + plural(vessels, 'navire laissé à part', 'navires laissés à part') + '.'));
    result.appendChild(el('p', plural(checked, 'dossier en cours recontrôlé', 'dossiers en cours recontrôlés') + ' contre ce registre. Une correspondance éventuelle apparaît dans vos contrôles, et nulle part ailleurs.'));
  }
  function run(path, body, waiting) {
    if (busy) return;
    busy = true;
    var mine = t.session();
    clear(result);
    say(waiting);
    send(path, 'POST', body).then(function (res) {
      busy = false;
      if (res.gone || mine !== t.session()) return;
      if (res.ok) done(res.body.data); else say(refusal(res));
    });
  }
  function fromFile() {
    if (busy) return;
    var f = pick && pick.files && pick.files.length === 1 ? pick.files[0] : null;
    if (!f) { say('Choisissez le fichier JSON publié par la DG Trésor.'); return; }
    if (typeof f.size !== 'number' || f.size > MAX) { say(REFUSALS.fichier_trop_gros); return; }
    busy = true;
    say('Lecture du fichier…');
    var mine = t.session();
    f.text().then(function (text) {
      busy = false;
      if (mine !== t.session()) return;
      var data;
      try { data = JSON.parse(String(text).replace(/^\\uFEFF/, '')); } catch (e) { say(REFUSALS.bad_file); return; }
      if (data === null || typeof data !== 'object' || Array.isArray(data)) { say(REFUSALS.bad_file); return; }
      run(FROM_FILE, data, 'Lecture et import du fichier…');
    }, function () { busy = false; if (mine === t.session()) say(REFUSALS.invalid_body); });
  }
  function render(inner) {
    box = el('div', null, 'gel-registre');
    box.appendChild(el('p', 'Le registre national des gels est téléchargé chez la DG Trésor, lu entier ou refusé entier, puis chaque dossier en cours est recontrôlé contre lui.', 'doux'));
    box.appendChild(button('Importer le registre du jour', function () { run(FROM_DGT, undefined, 'Téléchargement et lecture du registre…'); }));
    status = el('p', null, 'etat');
    status.setAttribute('role', 'status');
    box.appendChild(status);
    result = el('div');
    box.appendChild(result);
    var other = el('div', null, 'decision');
    other.appendChild(el('p', 'Si le téléchargement échoue : déposez le fichier JSON publié, tel quel.', 'doux'));
    pick = field(other, 'gel-registre-fichier', 'Fichier publié (JSON, 40 Mo au plus)');
    pick.setAttribute('type', 'file');
    pick.setAttribute('accept', 'application/json,.json');
    other.appendChild(button('Importer ce fichier', fromFile));
    box.appendChild(other);
    inner.appendChild(box);
  }
  return {
    show: function (inner) {
      clear(inner);
      render(inner);
    },
  };
};
`;
