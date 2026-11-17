/**
 * Le dossier de la lutte contre le blanchiment à l'écran du responsable de la conformité de l'agence sous licence
 * (BR114 ; M12 Conformité, « Anti-blanchiment ») [R662, R663, R664, R601].
 *
 * Script servi à part (`/app/dossier-lcb.js`), chargé au seul geste qui le demande depuis l'écran « Conformité », que
 * seule la clé du rôle `compliance` reçoit [R201, R16]. Il lit la licence de l'agence (`GET /v1/export/agence/lcb`),
 * demande la preuve de la clé de cet appareil pour `licence_lcb:<id>` avant tout envoi, tire le dossier et l'enregistre
 * en fichier sur l'appareil : rien du dossier n'est posé dans la page, seule son empreinte s'y dit [R663]. Il vérifie le
 * dossier tiré dans la séance, ou un dossier choisi sur l'appareil, et dit en phrases simples : vrai, faux, incomplet,
 * pièces qui ne concordent pas [R664]. Chaque refus se dit en mots, sans rien ranger. Tout texte reçu est posé en texte.
 */

/** Le plus gros dossier que la route de vérification lit (son corps compte 4 000 000 octets au plus). */
const MAX_DOSSIER_CHARS = 3_990_000;

const REFUSALS: Record<string, string> = {
  role: 'Réservé au responsable de la conformité.',
  pas_de_licence: 'Votre réseau n’est pas une agence sous licence : il garde son dossier chez lui, rien n’est à reprendre ici.',
  invalid_body: 'La demande n’a pas pu être lue. Rechargez l’écran.',
  unknown_field: 'La demande n’a pas pu être lue. Rechargez l’écran.',
  bad_shape: 'La demande n’a pas pu être lue. Rechargez l’écran.',
  body_too_large: 'Ce dossier est trop gros pour être vérifié ici.',
  second_factor_required: 'Il faut la preuve de la clé de cet appareil pour tirer le dossier.',
  other_action: 'La preuve faite porte sur un autre geste : recommencez.',
  already_used: 'Cette preuve a déjà servi : recommencez.',
  expired: 'La preuve a expiré : elle ne vaut que cinq minutes. Recommencez.',
  device_revoked: 'La clé qui a fait la preuve a été retirée : recommencez avec une clé active.',
  agent_inactive: 'Votre accès n’est plus actif.',
  conflit: 'Un autre dossier vient d’être tiré au même instant : recommencez.',
  cles_non_configurees: 'Les clés d’accès ne sont pas encore ouvertes sur ce service : le dossier ne se tire pas sans elles.',
};

export const DOSSIER_LCB_SCRIPT = `'use strict';
globalThis.AIMMO_DOSSIER_LCB = function (t) {
  var el = t.el, clear = t.clear, send = t.send, button = t.button, prove = t.prove;
  var REFUSALS = ${JSON.stringify(REFUSALS)};
  var MAX = ${MAX_DOSSIER_CHARS};
  var OFFLINE = 'Pas de réseau. Réessayez dans un moment.';
  var LOST = 'La réponse n’est pas arrivée : rien n’est sûr. Recommencez dans un moment.';
  var UNCHECKED = 'La vérification n’a pas abouti : rien n’est dit du dossier. Réessayez dans un moment.';
  /* Le dossier tiré, gardé en mémoire pour la seule séance qui l'a tiré : jamais dans la page ni dans le navigateur. */
  var held = null, heldSession = null, busy = null, say = function () {};
  function once(work) {
    var mine = t.session();
    if (busy === mine) return Promise.resolve(false);
    busy = mine;
    function done(r) { if (busy === mine) busy = null; return r; }
    return work().then(done, function () { return done(false); });
  }
  function why(x, fallback) {
    if (x.offline) return OFFLINE;
    return REFUSALS[(x.body || {}).code] || fallback;
  }
  function verdict(v) {
    if (!v || v.verified !== true) return 'Faux : ce dossier n’est pas celui qu’AIMMO a remis, ou il a changé depuis.';
    var parts = [];
    if (v.complete !== true) parts.push('il ne couvre pas ces tables d’aujourd’hui : ' + (Array.isArray(v.missing) && v.missing.length ? v.missing.join(', ') : 'liste non rendue') + '.');
    if (v.piecesComplete !== true) parts.push('sa liste des pièces ne concorde pas avec ses lignes : des pièces y manquent ou sont en trop.');
    if (!parts.length) return 'Vrai et complet : c’est le dossier remis par AIMMO, il couvre chaque table du traitement d’aujourd’hui et chaque pièce.';
    return 'Vrai mais incomplet : c’est le dossier remis par AIMMO, mais ' + parts.join(' Et ');
  }
  function saveFile(doc, name) {
    var url = URL.createObjectURL(new Blob([JSON.stringify(doc)], { type: 'application/json' }));
    var a = el('a', 'Enregistrer le dossier');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }
  /* La licence de l'agence, relue à chaque tirage : la preuve porte sur elle seule. */
  function licence() {
    return send('/v1/export/agence/lcb', 'GET').then(function (x) {
      if (x.gone) return null;
      if (x.ok && x.body && x.body.data && typeof x.body.data.licenceId === 'string') return x.body.data.licenceId;
      say(why(x, 'Le dossier est indisponible pour le moment.'));
      return null;
    });
  }
  function takeOut() {
    return once(function () {
      say('Lecture de votre licence…');
      return licence().then(function (id) {
        if (id === null) return false;
        say('Preuve de la clé de cet appareil…');
        return prove('export_complet', 'licence_lcb:' + id).then(function (p) {
          if (p.gone) return false;
          if (!p.ok) { say(p.text); return false; }
          say('Préparation du dossier…');
          return send('/v1/export/agence/lcb', 'POST', { stepUpId: p.stepUpId }).then(function (x) {
            if (x.gone) return false;
            if (x.offline || !x.body || x.status >= 500) { say(LOST); return false; }
            if (!x.ok) { say(why(x, 'Le dossier n’est pas tiré.')); return false; }
            var d = x.body.data || {};
            if (!d.document || typeof d.document !== 'object') { say(LOST); return false; }
            held = d.document;
            heldSession = t.session();
            saveFile(held, 'aimmo-dossier-lcb-' + String(held.madeAt || '').slice(0, 10) + '.json');
            say('Dossier enregistré sur cet appareil. Empreinte ' + String(d.fingerprint || '') + '. Vérifiez-le avant de vous en servir.');
            return true;
          });
        });
      });
    });
  }
  function check(doc) {
    return once(function () {
      say('Vérification…');
      return send('/v1/export/agence/lcb/verification', 'POST', { document: doc }).then(function (x) {
        if (x.gone) return false;
        if (x.offline || !x.body || x.status >= 500) { say(UNCHECKED); return false; }
        if (!x.ok) { say(why(x, 'Le dossier n’est pas vérifié.')); return false; }
        say(verdict(x.body.data));
        return true;
      });
    });
  }
  function checkHeld() {
    if (!held || heldSession !== t.session()) { held = null; say('Tirez d’abord le dossier, ou choisissez un dossier enregistré.'); return Promise.resolve(false); }
    return check(held);
  }
  /* Un dossier choisi sur l'appareil : lu ici, envoyé tel quel, jamais montré. */
  function checkFile(input) {
    var f = input.files && input.files[0];
    input.value = '';
    if (!f) return Promise.resolve(false);
    if (f.size > MAX) { say(REFUSALS.body_too_large); return Promise.resolve(false); }
    return f.text().then(function (text) {
      var doc = null;
      try { doc = JSON.parse(text); } catch (e) { doc = null; }
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) { say('Ce fichier n’est pas un dossier AIMMO : rien n’est vérifié.'); return false; }
      return check(doc);
    }, function () { say('Le fichier n’a pas pu être lu sur cet appareil.'); return false; });
  }
  function show(box, state) {
    clear(box);
    say = state;
    box.appendChild(el('p', 'Le dossier de votre agence : chaque table du traitement anti-blanchiment et la liste des pièces du coffre, avec leur empreinte. Il se tire sur la preuve de la clé de cet appareil et reste sur cet appareil : AIMMO n’en garde que l’empreinte.', 'doux'));
    box.appendChild(button('Tirer le dossier anti-blanchiment', function () { takeOut(); }));
    box.appendChild(button('Vérifier le dossier tiré', function () { checkHeld(); }));
    var pick = el('input');
    pick.setAttribute('type', 'file');
    pick.setAttribute('accept', 'application/json,.json');
    pick.setAttribute('id', 'dossier-lcb-fichier');
    var label = el('label', 'Vérifier un dossier enregistré');
    label.setAttribute('for', 'dossier-lcb-fichier');
    pick.addEventListener('change', function () { checkFile(pick); });
    box.appendChild(label);
    box.appendChild(pick);
  }
  return { show: show };
};
`;
