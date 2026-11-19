import { IDENTITY_PIECES } from '../../core/src/conformite/pieces-identite.ts';
import { VAULT_CONTENT_TYPES, VAULT_MAX_BYTES, VAULT_PIECES } from '../../core/src/conformite/coffre.ts';
import { OFFICIAL_PIECES } from '../../core/src/location/index.ts';

/**
 * Compléter un dossier de candidature à l'écran (W18), servi à part (`/app/louer-dossier.js`), chargé au premier geste
 * [R201]. Seules les pièces de la liste officielle sont proposées, selon qui les fournit [R104] ; une pièce d'identité n'y
 * est pas, elle va au coffre [R15] : le geste de W21 l'y dépose, par la route du coffre, et l'écran n'en montre que le
 * fait et la date [R13]. Ni nom de garant, ni montant, ni note : le dossier garde sa place d'arrivée [R105].
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
  already_cotenant: 'Cette personne est colocataire : elle n’est pas aussi garant.',
  already_guarantor: 'Cette personne est garant : elle n’est pas aussi colocataire.',
  too_many: 'Cinq colocataires au plus, en plus du candidat.',
};
const VAULT_REFUSALS = {
  bad_date: 'La date de vérification n’est pas valable : elle ne peut pas être dans l’avenir.',
  bad_content_type: 'Seuls les PDF, JPEG et PNG entrent au coffre.',
  too_large: 'Ce fichier dépasse la taille admise au coffre.',
  empty_content: 'Ce fichier est vide.',
  unknown_piece: 'Choisissez la sorte de pièce.',
  vault_not_configured: 'Le coffre n’est pas encore ouvert : aucune pièce ne peut y être déposée pour le moment.',
};
const IDENTITY_KINDS = Object.fromEntries(VAULT_PIECES.filter((p) => (IDENTITY_PIECES as readonly string[]).includes(p.kind)).map((p) => [p.kind, p.label]));
const PIECES = Object.fromEntries(Object.entries(OFFICIAL_PIECES).map(([k, v]) => [k, { l: v.label, c: v.category, h: v.holders }]));

export const LOUER_DOSSIER_SCRIPT = `'use strict';
globalThis.AIMMO_LOUER_DOSSIER = function (t) {
  var el = t.el, clear = t.clear, send = t.send, button = t.button, select = t.select, say = t.say, piece = t.piece;
  var PIECES = ${JSON.stringify(PIECES)};
  var REFUSALS = ${JSON.stringify(REFUSALS)};
  var VAULT_REFUSALS = ${JSON.stringify(VAULT_REFUSALS)};
  var IDENTITY_KINDS = ${JSON.stringify(IDENTITY_KINDS)};
  var VAULT_TYPES = ${JSON.stringify(VAULT_CONTENT_TYPES)};
  var VAULT_MAX = ${VAULT_MAX_BYTES};
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
  /* L'identité : le fait et sa date, rien de la pièce. La pièce part au coffre, jamais au dossier [R15]. */
  function identity(box, a, guarantors, n) {
    var verified = a.identityVerifiedOn || {};
    var people = [{ holder: 'candidat', personId: a.personId, name: 'Le candidat' }];
    guarantors.forEach(function (g, i) { if (g.kind === 'personne') people.push({ holder: g.guarantorId, personId: g.personId, name: guarantorName(g, i) }); });
    cotenants(a).forEach(function (c, i) { people.push({ holder: 'colocataire:' + c, personId: c, name: 'Colocataire ' + (i + 1) }); });
    box.appendChild(el('h4', 'Identité'));
    var todo = {};
    people.forEach(function (p) {
      var on = verified[p.holder];
      box.appendChild(el('p', p.name + ' : ' + (on ? 'identité vérifiée le ' + t.date(on) : 'identité à vérifier'), 'doux'));
      if (!on && p.personId) todo[p.personId] = p.name;
    });
    if (!Object.keys(todo).length) return;
    box.appendChild(el('p', 'La pièce part au coffre, que seul le responsable de la conformité ouvre. Elle ne reste ni dans le dossier ni à l’écran.', 'doux'));
    var who = select(box, 'dossier-identite-qui-' + n, 'Pour qui', todo, Object.keys(todo)[0]);
    var kind = select(box, 'dossier-identite-sorte-' + n, 'La pièce vue', IDENTITY_KINDS, Object.keys(IDENTITY_KINDS)[0]);
    var seen = t.field(box, 'dossier-identite-date-' + n, 'Vérifiée le');
    seen.setAttribute('type', 'date');
    var file = t.field(box, 'dossier-identite-fichier-' + n, 'Le fichier de la pièce');
    file.setAttribute('type', 'file');
    file.setAttribute('accept', VAULT_TYPES.join(','));
    box.appendChild(button('Déposer au coffre', function () {
      if (sending) return;
      var f = file.files && file.files[0];
      if (!seen.value) { say('Dites d’abord quand la pièce a été vérifiée.'); return; }
      if (!f) { say('Choisissez d’abord le fichier.'); return; }
      if (VAULT_TYPES.indexOf(f.type) === -1) { say(VAULT_REFUSALS.bad_content_type); return; }
      if (f.size > VAULT_MAX) { say(VAULT_REFUSALS.too_large); return; }
      sending = true;
      say('Envoi au coffre…');
      var path = '/v1/conformite/personnes/' + encodeURIComponent(who.value) + '/coffre?sorte=' + encodeURIComponent(kind.value) + '&verifie=' + encodeURIComponent(seen.value);
      t.upload(path, f, f.type, '').then(function (res) {
        sending = false;
        if (res.gone) return null;
        file.value = '';
        if (res.ok) return t.reload('Pièce déposée au coffre.');
        var code = res.body && res.body.code;
        if (VAULT_REFUSALS[code]) { say(VAULT_REFUSALS[code]); return null; }
        if (res.status === 403) { say('Le dépôt au coffre revient à l’agent de cette fiche ou au responsable de la conformité.'); return null; }
        if (res.offline || !res.body || res.status >= 500) { say('Réponse perdue : la pièce est peut-être au coffre. Rouvrez le logement avant de recommencer.'); return null; }
        say('La pièce n’est pas déposée. Vérifiez la saisie.');
        return null;
      });
    }));
  }
  /* AU097 · les colocataires : chacun locataire du même bail, avec ses pièces, son identité, sa signature. */
  function cotenants(a) { return Array.isArray(a.cotenants) ? a.cotenants.filter(function (c) { return t.ID.test(String(c)); }) : []; }
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
    cotenants(a).forEach(function (c, i) { who['colocataire:' + c] = 'Colocataire ' + (i + 1); });
    guarantors.forEach(function (g, i) { who[g.guarantorId] = guarantorName(g, i); });
    var holder = select(box, 'dossier-qui-' + n, 'Qui fournit la pièce', who, 'candidat');
    var slot = el('div');
    box.appendChild(slot);
    var sort = null;
    function drawSorts() {
      clear(slot);
      var g = guarantors.filter(function (x) { return x.guarantorId === holder.value; })[0];
      // Un colocataire fournit les pièces d'un candidat (annexe I).
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
    identity(box, a, guarantors, n);
    box.appendChild(el('h4', 'Ajouter un garant'));
    if (!guarantors.some(function (g) { return g.kind === 'visale'; })) box.appendChild(button('Garant Visale', function () {
      act(appBase + '/garants', { kind: 'visale' }, 'Le garant n’est pas ajouté.', 'Garant ajouté.');
    }));
    chooser(box, base, n, 'garant', 'Choisir un garant parmi mes contacts', 'Le garant', 'Ajouter ce garant', function (id) {
      act(appBase + '/garants', { kind: 'personne', personId: id }, 'Le garant n’est pas ajouté.', 'Garant ajouté.');
    });
    if (a.dossierFacile) return;
    box.appendChild(el('h4', 'Colocataires'));
    box.appendChild(el('p', 'Un seul bail : chaque colocataire y est locataire, avec ses pièces, sa signature et son exemplaire.', 'doux'));
    cotenants(a).forEach(function (c, i) {
      box.appendChild(button('Retirer le colocataire ' + (i + 1), function () {
        act(appBase + '/colocataires', { personId: c, action: 'retrait' }, 'Le colocataire n’est pas retiré.', 'Colocataire retiré : le bail est à refaire.');
      }));
    });
    chooser(box, base, n, 'colocataire', 'Ajouter un colocataire parmi mes contacts', 'Le colocataire', 'Ajouter ce colocataire', function (id) {
      act(appBase + '/colocataires', { personId: id, action: 'ajout' }, 'Le colocataire n’est pas ajouté.', 'Colocataire ajouté : le bail est à refaire.');
    });
  }
  function chooser(box, base, n, tag, open, label, confirm, done) {
    var people = el('div');
    box.appendChild(people);
    people.appendChild(button(open, function () {
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
        var person = select(people, 'dossier-' + tag + '-' + n, label, options, '');
        people.appendChild(button(confirm, function () {
          if (!person.value) { say('Choisissez d’abord la personne.'); return; }
          done(person.value);
        }));
      });
    }));
  }
  return { open: open };
};
`.replace(/^[ \t]*(?:\/\/.*|\/\*.*\*\/)[ \t]*\n/gm, '');
