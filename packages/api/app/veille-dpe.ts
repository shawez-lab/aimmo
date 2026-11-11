/**
 * L'écran de la veille des nouveaux diagnostics énergétiques (BR36), servi à part (`/app/veille-dpe.js`) et chargé
 * seulement quand l'agent ouvre la partie « Veille des diagnostics énergétiques » de l'écran « Gagner des mandats » :
 * l'application tient ainsi son budget de poids [R201].
 *
 * Il ne lit et n'écrit que par `/v1/veille-dpe` [R16] : ses secteurs (ouvrir, arrêter), l'alerte du jour, la carte des
 * 90 derniers jours, et la lettre « Au propriétaire » d'un logement F ou G [R289, R290]. Il ne calcule ni ne trie rien :
 * l'ordre reçu est gardé, regroupé par commune. Aucun nom n'est demandé ni montré [R288] ; la lettre se télécharge à
 * imprimer, la clé dans l'en-tête seul, et rien n'est envoyé. La saisie d'un secteur est contrôlée avant tout appel ; le
 * serveur refait tout. Un refus se dit en mots, jamais par son code ; une réponse perdue se dit « rien n'est sûr ». Tout
 * texte reçu est posé avec `textContent` ; rien n'est gardé sur l'appareil.
 */

const KINDS: Readonly<Record<string, string>> = { apartment: 'Appartement', house: 'Maison', building: 'Immeuble' };
/** Les raisons d'un refus, dites à l'agent : jamais un code interne. */
export const VEILLE_DPE_REFUSALS: Readonly<Record<string, string>> = {
  role: 'La veille des diagnostics est celle de l’agent : ce n’est pas dans vos droits.',
  agent_inactive: 'Votre accès d’agent n’est pas actif.',
  hors_zone: 'Cette commune n’est pas dans vos zones en cours.',
  deja_suivi: 'Vous suivez déjà cette commune avec ce code postal.',
  trop_de_secteurs: 'Vous suivez déjà 30 secteurs : arrêtez-en un avant d’en ouvrir un autre.',
  bad_commune: 'Écrivez le nom de la commune.',
  bad_postcode: 'Le code postal a cinq chiffres.',
  deja_ferme: 'Ce secteur est déjà arrêté.',
  unknown_sector: 'Ce secteur n’existe plus.',
  unknown_diagnosis: 'Ce diagnostic n’existe plus.',
  classe_sans_lettre: 'La lettre ne se prépare que pour un logement classé F ou G.',
  sans_date: 'Ce logement n’a pas de date d’interdiction de louer : pas de lettre.',
  deja_preparee: 'La lettre de ce logement est déjà préparée dans le réseau.',
  bad_day: 'Ce jour n’a pas pu être lu.',
  bad_classes: 'Ce filtre n’a pas pu être lu.',
  unknown_field: 'La demande n’a pas pu être lue.',
  invalid_body: 'La demande n’a pas pu être lue.',
};
/** Un code postal français : cinq chiffres, contrôlé avant tout appel. */
export const POSTCODE = /^\d{5}$/;

export const VEILLE_DPE_SCRIPT = `'use strict';
globalThis.AIMMO_VEILLE_DPE = function (t) {
  var el = t.el, clear = t.clear, send = t.send, button = t.button, download = t.download, ID = t.ID;
  var KINDS = ${JSON.stringify(KINDS)};
  var REFUSALS = ${JSON.stringify(VEILLE_DPE_REFUSALS)};
  var POSTCODE = ${POSTCODE.toString()};
  var DAY = /^\\d{4}-\\d{2}-\\d{2}$/;
  var CLASS = /^[A-G]$/;
  var root = null, load = 0, onlyFG = false;
  function isId(x) { return typeof x === 'string' && ID.test(x); }
  function said(res, fallback) {
    if (res.offline) return 'La réponse n’est pas arrivée : rien n’est sûr. Relisez avant de recommencer.';
    var b = res.body || {};
    return REFUSALS[b.code] || fallback;
  }
  function day(s) { var p = typeof s === 'string' && DAY.test(s.slice(0, 10)) ? s.slice(0, 10).split('-') : null; return p ? p[2] + '/' + p[1] + '/' + p[0] : ''; }
  function str(x) { return typeof x === 'string' ? x : ''; }
  function where(a) {
    a = a && typeof a === 'object' ? a : {};
    var line = [str(a.streetNumber), str(a.street)].filter(Boolean).join(' ');
    var town = [str(a.postcode), str(a.commune)].filter(Boolean).join(' ');
    return [line, town].filter(Boolean).join(', ') || 'Adresse inconnue';
  }
  function input(label, mode) {
    var l = el('label', label + ' ');
    var i = el('input');
    i.setAttribute('aria-label', label);
    if (mode) i.setAttribute('inputmode', mode);
    l.appendChild(i);
    return { label: l, input: i };
  }
  /** Après un geste : le mot dit, puis une relecture complète, seule la dernière dessine. */
  function after(note, text) { return open(text).then(function (drawn) { if (!drawn && note) note.textContent = text; return drawn; }); }

  /* Les secteurs : chaque commune suivie, l'arrêter ; en ouvrir un, contrôlé ici puis refait par le serveur [R289]. */
  function sectors(res) {
    var box = el('section', null, 'bloc');
    var list = res.ok && Array.isArray(res.body.data) ? res.body.data : null;
    box.appendChild(el('h4', 'Mes communes suivies' + (list ? ' (' + list.length + ')' : '')));
    var note = el('p', '', 'etat');
    note.setAttribute('role', 'status');
    if (!list) box.appendChild(el('p', said(res, 'Vos communes suivies sont indisponibles pour le moment.'), 'etat'));
    else if (!list.length) box.appendChild(el('p', 'Aucune commune suivie : ouvrez-en une de vos zones.', 'doux'));
    else {
      var ul = el('ul', null, 'liste');
      list.forEach(function (s) {
        if (!s || !isId(s.sectorId)) return;
        var li = el('li');
        li.appendChild(el('strong', str(s.commune) + ' (' + str(s.postcode) + ')'));
        if (s.inZone !== true) li.appendChild(el('p', 'Plus dans vos zones : plus d’alerte pour cette commune.', 'doux'));
        var b = button('Arrêter la veille', function () {
          if (b.disabled) return;
          b.disabled = true;
          note.textContent = 'Envoi…';
          send('/v1/veille-dpe/secteurs/' + encodeURIComponent(s.sectorId) + '/fermeture', 'POST', {}).then(function (r) {
            b.disabled = false;
            if (r.gone) return;
            if (r.ok) after(note, 'Veille arrêtée pour ' + str(s.commune) + ' : ce qui est déjà reçu reste.');
            else note.textContent = said(r, 'La veille n’a pas pu être arrêtée.');
          });
        });
        li.appendChild(b);
        ul.appendChild(li);
      });
      box.appendChild(ul);
    }
    var commune = input('Commune'), postcode = input('Code postal', 'numeric');
    var form = el('p');
    form.appendChild(commune.label);
    form.appendChild(postcode.label);
    var add = button('Suivre cette commune', function () {
      if (add.disabled) return;
      var c = str(commune.input.value).trim(), p = str(postcode.input.value).trim();
      if (!c) { note.textContent = REFUSALS.bad_commune; return; }
      if (!POSTCODE.test(p)) { note.textContent = REFUSALS.bad_postcode; return; }
      add.disabled = true;
      note.textContent = 'Envoi…';
      send('/v1/veille-dpe/secteurs', 'POST', { commune: c, postcode: p }).then(function (r) {
        add.disabled = false;
        if (r.gone) return;
        if (r.ok) after(note, 'Veille ouverte pour ' + c + ' (' + p + ') : l’alerte arrive chaque matin.');
        else note.textContent = said(r, 'La commune n’a pas pu être suivie.');
      });
    });
    form.appendChild(add);
    box.appendChild(el('h5', 'Suivre une commune de mes zones'));
    box.appendChild(form);
    box.appendChild(note);
    return box;
  }

  /* Un diagnostic : ce qui décrit le logement, jamais un nom [R288] ; la lettre pour un F ou un G sans lettre [R290]. */
  function point(p) {
    var li = el('li');
    var energy = CLASS.test(p.energyClass) ? p.energyClass : '?';
    var head = 'Classe ' + energy + (CLASS.test(p.ghgClass) ? ' (climat ' + p.ghgClass + ')' : '') + ' · ' + (KINDS[p.kind] || 'Logement');
    if (typeof p.surfaceM2 === 'number' && isFinite(p.surfaceM2) && p.surfaceM2 > 0) head += ' · ' + Math.round(p.surfaceM2) + ' m²';
    li.appendChild(el('strong', head));
    li.appendChild(el('p', where(p.address)));
    li.appendChild(el('p', 'Diagnostic établi le ' + day(p.diagnosedOn) + ', publié le ' + day(p.receivedOn) + '.', 'doux'));
    if (day(p.rentBanFrom)) li.appendChild(el('p', 'Ne peut plus être loué à partir du ' + day(p.rentBanFrom) + '.'));
    if ((energy !== 'F' && energy !== 'G') || !isId(p.diagnosisId)) return li;
    var note = el('p', '', 'etat');
    note.setAttribute('role', 'status');
    if (isId(p.letterId)) {
      li.appendChild(el('p', 'Lettre « Au propriétaire » déjà préparée dans le réseau.', 'doux'));
      li.appendChild(button('Télécharger la lettre à imprimer', function () { download('/v1/veille-dpe/lettres/' + encodeURIComponent(p.letterId), 'lettre-dpe-' + p.letterId + '.html'); }));
      return li;
    }
    var b = button('Préparer la lettre « Au propriétaire »', function () {
      if (b.disabled) return;
      b.disabled = true;
      note.textContent = 'Préparation…';
      send('/v1/veille-dpe/diagnostics/' + encodeURIComponent(p.diagnosisId) + '/lettre', 'POST', {}).then(function (r) {
        if (r.gone) { b.disabled = false; return; }
        var v = r.ok && r.body.data;
        if (!v || !isId(v.letterId)) { b.disabled = false; note.textContent = said(r, 'La lettre n’a pas pu être préparée.'); return; }
        li.removeChild(b);
        note.textContent = 'Lettre préparée : à imprimer et déposer, rien n’est envoyé.';
        var text = el('pre', str(v.body));
        li.appendChild(text);
        li.appendChild(button('Télécharger la lettre à imprimer', function () { download('/v1/veille-dpe/lettres/' + encodeURIComponent(v.letterId), 'lettre-dpe-' + v.letterId + '.html'); }));
      });
    });
    li.appendChild(b);
    li.appendChild(note);
    return li;
  }
  /** Les diagnostics regroupés par commune, dans l'ordre reçu. */
  function grouped(box, points) {
    var towns = [], by = {};
    points.forEach(function (p) {
      if (!p || typeof p !== 'object') return;
      var town = str(p.address && p.address.commune) || 'Commune inconnue';
      if (!Object.prototype.hasOwnProperty.call(by, town)) { by[town] = []; towns.push(town); }
      by[town].push(p);
    });
    towns.forEach(function (town) {
      box.appendChild(el('h5', town + ' (' + by[town].length + ')'));
      var ul = el('ul', null, 'liste');
      by[town].forEach(function (p) { ul.appendChild(point(p)); });
      box.appendChild(ul);
    });
  }
  function alerts(res) {
    var box = el('section', null, 'bloc');
    var list = res.ok && Array.isArray(res.body.data) ? res.body.data : null;
    if (!list) { box.appendChild(el('h4', 'Alerte du jour')); box.appendChild(el('p', said(res, 'L’alerte du jour est indisponible pour le moment.'), 'etat')); return box; }
    var points = [];
    list.forEach(function (a) { if (a && Array.isArray(a.items)) a.items.forEach(function (p) { points.push(p); }); });
    box.appendChild(el('h4', 'Alerte du jour (' + points.length + ')'));
    if (!points.length) box.appendChild(el('p', 'Aucun nouveau diagnostic aujourd’hui dans vos communes suivies.', 'doux'));
    grouped(box, points);
    return box;
  }
  function map(res) {
    var box = el('section', null, 'bloc');
    var list = res.ok && Array.isArray(res.body.data) ? res.body.data : null;
    var title = onlyFG ? 'Carte des 90 jours, F et G' : 'Carte des 90 jours';
    if (!list) { box.appendChild(el('h4', title)); box.appendChild(el('p', said(res, 'La carte est indisponible pour le moment.'), 'etat')); return box; }
    box.appendChild(el('h4', title + ' (' + list.length + ')'));
    box.appendChild(button(onlyFG ? 'Toutes les classes' : 'Seulement F et G', function () { onlyFG = !onlyFG; open(''); }));
    if (!list.length) box.appendChild(el('p', 'Aucun diagnostic reçu dans vos zones sur 90 jours.', 'doux'));
    grouped(box, list);
    return box;
  }
  function open(message) {
    if (!root) return Promise.resolve(false);
    var box = root, mine = ++load;
    clear(box);
    box.appendChild(el('p', 'Les diagnostics publiés par l’ADEME dans vos communes : aucun nom de propriétaire, rien n’est envoyé. La lettre s’imprime et se dépose.', 'doux'));
    var note = el('p', 'Chargement…', 'etat');
    note.setAttribute('role', 'status');
    box.appendChild(note);
    return Promise.all([
      send('/v1/veille-dpe/secteurs', 'GET'),
      send('/v1/veille-dpe/alertes', 'GET'),
      send('/v1/veille-dpe/carte' + (onlyFG ? '?classes=F,G' : ''), 'GET'),
    ]).then(function (all) {
      // Seule la dernière lecture dessine : une réponse plus ancienne, arrivée après, est oubliée.
      if (box !== root || mine !== load || all.some(function (r) { return r.gone; })) return false;
      if (all.every(function (r) { return r.offline; })) { note.textContent = 'Pas de réseau. Réessayez dans un moment.'; return false; }
      note.textContent = message || '';
      box.appendChild(sectors(all[0]));
      box.appendChild(alerts(all[1]));
      box.appendChild(map(all[2]));
      return true;
    });
  }
  return { show: function (box) { root = box; return open(''); } };
};
`;
