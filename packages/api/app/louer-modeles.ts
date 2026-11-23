import { LEASE_FIELDS } from '../../core/src/location/index.ts';

/**
 * Les modèles de bail à l'écran (W17), servis à part (`/app/louer-modeles.js`), chargés au premier geste [R201]. La
 * direction lit et range une nouvelle version, qui s'ajoute sans toucher à l'ancienne [R17] ; seule la conformité valide :
 * le code ne valide jamais seul, et la direction non plus [H08]. Un modèle non validé est dit d'essai, comme le bail qu'il
 * ferait. Tout texte reçu est posé en texte ; rien n'est gardé sur l'appareil.
 */
const KINDS = { bail_vide: 'Location vide', bail_meuble: 'Location meublée', bail_meuble_etudiant: 'Meublé étudiant (neuf mois)', bail_mobilite: 'Bail mobilité' };
// Sans la clé dont le nom porte le mot que l'écran n'emploie jamais [R07] : ce champ se dit alors par le seul nom rendu par le serveur.
const LABELS = Object.fromEntries(Object.entries(LEASE_FIELDS).filter(([k]) => !/mandataire/i.test(k)).map(([k, v]) => [k, v.label]));
const REFUSALS = {
  empty_body: 'Le modèle est vide : rien n’est rangé.',
  body_too_long: 'Le modèle est trop long : rien n’est rangé.',
  unknown_field: 'Le modèle porte un champ entre accolades que le bail ne connaît pas : rien n’est rangé.',
  busy: 'Une autre demande est en cours : réessayez dans un instant.',
  not_essai: 'Cette version est déjà validée.',
  unknown_template: 'Cette version n’existe plus : relisez les modèles.',
};

export const LOUER_MODELES_SCRIPT = `'use strict';
globalThis.AIMMO_LOUER_MODELES = function (t) {
  var el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field, date = t.date, ID = t.ID;
  var KINDS = ${JSON.stringify(KINDS)};
  var LABELS = ${JSON.stringify(LABELS)};
  var REFUSALS = ${JSON.stringify(REFUSALS)};
  var busy = null;
  var seq = 0;
  var reads = 0;
  function act(box, say, path, body, fallback, done) {
    var mine = t.session();
    if (busy === mine) return;
    busy = mine;
    say('Envoi…');
    return send(path, 'POST', body).then(function (res) {
      if (busy === mine) busy = null;
      if (res.gone) { clear(box); say(''); return; }
      if (res.ok) return open(box, say, typeof done === 'function' ? done(res.body.data) : done);
      if (res.offline || !res.body || res.status >= 500) {
        clear(box);
        box.appendChild(button('Relire les modèles de bail', function () { open(box, say); }));
        say('Réponse perdue : ce geste est peut-être rangé. Relisez avant de recommencer.');
        return;
      }
      if (res.status === 403) { say('Ce geste n’est pas dans vos droits.'); return; }
      if (res.body.code === 'missing_required_field') { say('Il manque le champ {{' + res.body.field + '}}' + (LABELS[res.body.field] ? ' (' + LABELS[res.body.field] + ')' : '') + ' : rien n’est rangé.'); return; }
      say(REFUSALS[res.body.code] || fallback);
    });
  }
  function versionText(v) {
    return v.status === 'valide'
      ? 'Version ' + v.version + ', validée le ' + date(v.validatedAt) + '.'
      : 'Version ' + v.version + ', modèle d’essai, pas validé : le bail qu’il fait reste un document d’essai.';
  }
  function validateButton(box, say, v) {
    if (typeof v.id !== 'string' || !ID.test(v.id)) return;
    var armed = false;
    var b = button('Valider la version ' + v.version, function () {
      if (!armed) { armed = true; b.textContent = 'Confirmer : texte relu par l’avocat'; say('Appuyez encore pour valider la version ' + v.version + '.'); return; }
      act(box, say, '/v1/location/modeles-bail/' + encodeURIComponent(v.id) + '/validation', undefined, 'La version n’est pas validée.', 'Version ' + v.version + ' validée.');
    });
    box.appendChild(b);
  }
  function kindBlock(box, say, k, d) {
    var part = el('div', null, 'vente');
    part.appendChild(el('h4', KINDS[k.kind] || k.kind));
    var cur = k.current, last = k.latest;
    if (!cur) part.appendChild(el('p', 'Aucun modèle : aucun bail de cette sorte ne peut se préparer.', 'alerte'));
    else {
      part.appendChild(el('p', 'En vigueur. ' + versionText(cur), cur.status === 'valide' ? 'fait' : 'alerte'));
      part.appendChild(el('p', String(cur.body), 'brouillon'));
    }
    if (last && cur && last.version !== cur.version) {
      part.appendChild(el('p', 'Dernière version rangée, pas en vigueur tant qu’elle n’est pas validée. ' + versionText(last), 'doux'));
      part.appendChild(el('p', String(last.body), 'brouillon'));
    }
    if (d.canValidate === true && last && last.status === 'essai') validateButton(part, say, last);
    if (d.canStore === true) {
      var n = ++seq;
      var text = field(part, 'bail-modele-' + n, 'Texte de la nouvelle version', 'textarea');
      text.setAttribute('rows', '8');
      var held = last ? String(last.body) : '';
      text.value = held;
      part.appendChild(button('Ranger une nouvelle version', function () {
        var typed = String(text.value || '').trim();
        if (!typed) { say(REFUSALS.empty_body); return; }
        if (typed === held.trim()) { say('Le texte n’a pas changé : aucune version ajoutée.'); return; }
        act(box, say, '/v1/location/modeles-bail', { kind: k.kind, body: typed }, 'Le modèle n’est pas rangé.', function (r) {
          return 'Version ' + r.version + ' rangée, modèle d’essai. L’ancienne version reste.';
        });
      }));
    }
    box.appendChild(part);
  }
  function open(box, say, said) {
    clear(box);
    var mine = t.session();
    var r = ++reads;
    say('Chargement…');
    return send('/v1/location/modeles-bail', 'GET').then(function (res) {
      if (r !== reads) return;
      if (res.gone || mine !== t.session()) { clear(box); say(''); return; }
      clear(box);
      if (!res.ok) { say(res.status === 403 ? 'Ce geste n’est pas dans vos droits.' : res.offline ? 'Pas de réseau. Réessayez dans un moment.' : 'Les modèles ne se lisent pas pour le moment.'); return; }
      say(said || '');
      var d = res.body.data || {};
      (Array.isArray(d.kinds) ? d.kinds : []).forEach(function (k) { kindBlock(box, say, k, d); });
    });
  }
  return { open: open };
};
`.replace(/^[ \t]*(?:\/\/.*|\/\*.*\*\/)[ \t]*\n/gm, '');
