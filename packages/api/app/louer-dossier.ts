import { OFFICIAL_PIECES } from '../../core/src/location/index.ts';

/**
 * Compléter un dossier de candidature à l'écran (W18), servi à part (`/app/louer-dossier.js`), chargé au premier geste
 * [R201]. Seules les pièces de la liste officielle sont proposées, selon qui les fournit [R104] ; une pièce d'identité n'y
 * est pas, elle va au coffre [R15]. Ni nom de garant, ni montant, ni note : le dossier garde sa place d'arrivée [R105].
 */
const REFUSALS = {
  not_allowed: 'Cette pièce n’est pas sur la liste officielle : elle ne peut pas être demandée.',
  not_for_holder: 'Cette pièce ne se demande pas à cette personne.',
  one_domicile: 'Un seul justificatif de domicile par personne : il est déjà rangé.',
  identity_in_vault: 'Une pièce d’identité va au coffre, jamais dans le dossier.',
  bad_kind: 'Choisissez la sorte de garant.',
  already_added: 'Ce garant est déjà sur ce dossier.',
  dossierfacile: 'Un dossier DossierFacile est accepté tel quel : il ne reçoit rien de plus.',
  unknown_holder: 'Ce garant n’est plus sur ce dossier : rouvrez le logement.',
  not_stored: 'Le fichier n’est pas rangé. Réessayez.',
  ref_used: 'Ce fichier est déjà rangé.',
  depot_ferme: 'Le dépôt des fichiers n’est pas ouvert pour le moment : rien n’est rangé.',
};
const PIECES = Object.fromEntries(Object.entries(OFFICIAL_PIECES).map(([k, v]) => [k, { l: v.label, c: v.category, h: v.holders }]));

export const LOUER_DOSSIER_SCRIPT = `'use strict';
globalThis.AIMMO_LOUER_DOSSIER = function (t) {
  var el = t.el, clear = t.clear, send = t.send, button = t.button, select = t.select, say = t.say, piece = t.piece;
  var PIECES = ${JSON.stringify(PIECES)};
  var REFUSALS = ${JSON.stringify(REFUSALS)};
  var seq = 0;
  t.refusals.depot_ferme = REFUSALS.depot_ferme;
  var sending = false;
  function act(path, body, fallback, done) {
    if (sending) return Promise.resolve(null);
    sending = true;
    say('Envoi…');
    return send(path, 'POST', body).then(function (res) {
      sending = false;
      if (res.gone) return null;
      if (res.ok) return t.reload(done);
      if (res.offline || !res.body || res.status >= 500) { say('Réponse perdue : ce geste est peut-être rangé. Rouvrez le logement avant de recommencer.'); return null; }
      if (res.status === 403) { say('Ce geste n’est pas dans vos droits.'); return null; }
      say(REFUSALS[res.body.code] || t.refusals[res.body.code] || fallback);
      return null;
    });
  }
  /* Les mêmes conditions que le serveur : Visale, son visa seul ; une personne, ce que l'annexe permet à une caution. */
  function sortsFor(kind, hasDomicile) {
    var out = { '': 'Choisir la pièce' };
    Object.keys(PIECES).forEach(function (k) {
      var p = PIECES[k];
      var allowed = kind === 'visale' ? p.c === 'garantie' : p.h.indexOf(kind === 'candidat' ? 'candidat' : 'caution') !== -1;
      if (allowed && !(hasDomicile && p.c === 'domicile')) out[k] = p.l;
    });
    return out;
  }
  function guarantorName(g, i) { return g.kind === 'visale' ? 'Garant Visale' : 'Garant ' + (i + 1); }
  function open(box, base, a) {
    clear(box);
    var n = ++seq;
    var appBase = '/v1/location/candidatures/' + encodeURIComponent(a.applicationId);
    var guarantors = Array.isArray(a.guarantors) ? a.guarantors : [];
    var held = Array.isArray(a.pieces) ? a.pieces : [];
    if (held.length) {
      var ul = el('ul', null, 'liste');
      held.forEach(function (p) { ul.appendChild(el('li', String(p.label || ''))); });
      box.appendChild(ul);
    } else box.appendChild(el('p', 'Aucune pièce rangée.', 'doux'));
    box.appendChild(el('p', 'Seules les pièces de la liste officielle. Le dossier garde sa place d’arrivée.', 'doux'));
    var who = { candidat: 'Le candidat' };
    guarantors.forEach(function (g, i) { who[g.guarantorId] = guarantorName(g, i); });
    var holder = select(box, 'dossier-qui-' + n, 'Qui fournit la pièce', who, 'candidat');
    var slot = el('div');
    box.appendChild(slot);
    var sort = null;
    function drawSorts() {
      clear(slot);
      var g = guarantors.filter(function (x) { return x.guarantorId === holder.value; })[0];
      var hasDomicile = held.some(function (p) { return p.holder === holder.value && p.category === 'domicile'; });
      sort = select(slot, 'dossier-piece-' + n, 'La pièce', sortsFor(g ? g.kind : 'candidat', hasDomicile), '');
    }
    drawSorts();
    holder.addEventListener('change', drawSorts);
    var file = piece(box, 'dossier-fichier-' + n, 'Le fichier', 'piece');
    var busy = false;
    box.appendChild(button('Ranger la pièce', function () {
      if (busy) return;
      if (!sort.value) { say('Choisissez d’abord la pièce.'); return; }
      if (!file.picked()) { say('Choisissez d’abord le fichier.'); return; }
      busy = true;
      var chosen = { holder: holder.value, sort: sort.value };
      Promise.resolve(file.ref(appBase, '?holder=' + encodeURIComponent(chosen.holder))).then(function (ref) {
        if (!ref) return null;
        return act(appBase + '/pieces', { holder: chosen.holder, sort: chosen.sort, ref: ref, sha256: file.sha() }, 'La pièce n’est pas rangée.', 'Pièce rangée.');
      }).finally(function () { busy = false; });
    }));
    box.appendChild(el('h4', 'Ajouter un garant'));
    if (!guarantors.some(function (g) { return g.kind === 'visale'; })) box.appendChild(button('Garant Visale', function () {
      act(appBase + '/garants', { kind: 'visale' }, 'Le garant n’est pas ajouté.', 'Garant ajouté.');
    }));
    var people = el('div');
    box.appendChild(people);
    people.appendChild(button('Choisir un garant parmi mes contacts', function () {
      say('Chargement…');
      send(base + '/contacts', 'GET').then(function (res) {
        if (res.gone) return;
        if (!res.ok) { say(res.offline ? 'Pas de réseau. Réessayez dans un moment.' : 'Vos contacts sont indisponibles pour le moment.'); return; }
        var list = (res.body.data && res.body.data.contacts) || [];
        if (!list.length) { say('Aucun contact à proposer.'); return; }
        say('');
        clear(people);
        var options = { '': 'Choisir une personne' };
        list.forEach(function (p) { options[p.personId] = [p.firstName, p.lastName].filter(Boolean).join(' ') || 'Contact sans nom'; });
        var person = select(people, 'dossier-garant-' + n, 'Le garant', options, '');
        people.appendChild(button('Ajouter ce garant', function () {
          if (!person.value) { say('Choisissez d’abord la personne.'); return; }
          act(appBase + '/garants', { kind: 'personne', personId: person.value }, 'Le garant n’est pas ajouté.', 'Garant ajouté.');
        }));
      });
    }));
  }
  return { open: open };
};
`.replace(/^[ \t]*(?:\/\/.*|\/\*.*\*\/)[ \t]*\n/gm, '');
