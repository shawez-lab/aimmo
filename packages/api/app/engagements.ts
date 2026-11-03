import { COMMITMENT_MEASURES } from '../../core/src/mandats/gagner/dossier-presentation.ts';

/**
 * Les engagements de service sur l'écran du réseau (G15) : la direction lit la dernière version de chacun, en range une
 * nouvelle, en ajoute un. Sans eux, le dossier de présentation dit qu'aucun engagement n'est réglé. Script servi à part
 * (`/app/engagements.js`), chargé au premier geste [R201]. Un engagement dit ce que l'agent fait, jamais un résultat :
 * c'est le serveur qui refuse un chiffre ou une promesse dans le texte [R141]. Une version s'ajoute, l'ancienne reste
 * [R17]. Tout texte reçu est posé en texte, rien ne reste une fois quitté.
 */

const REFUSALS: Record<string, string> = {
  role: 'Ce n’est pas dans vos droits.',
  bad_code: 'Cet engagement ne se reconnaît pas : relisez la liste.',
  bad_measure: 'Choisissez ce qui est mesuré.',
  bad_delay: 'Le délai : un nombre entier d’heures, de 1 à 336.',
  bad_label: 'Le texte : de 5 à 120 caractères.',
  promise: 'Ce texte promet un résultat ou porte un chiffre : le client le lirait comme une promesse. Dites ce que l’agent fait, le délai a son propre champ.',
  wording: 'Écrivez « agent immobilier » et « offert », sans parler d’outil.',
  bad_active: 'Dites si l’engagement est en service.',
  conflict: 'Une autre saisie vient de passer : relisez la liste, puis recommencez.',
};
const MEASURES: Record<(typeof COMMITMENT_MEASURES)[number], string> = {
  compte_rendu_visite: 'Compte rendu de visite',
  point_semaine: 'Point de la semaine',
};

export const ENGAGEMENTS_ENTRY_HTML = `<section class="bloc" aria-labelledby="titre-engagements">
<h3 id="titre-engagements">Engagements de service</h3>
<p class="doux">Ce que vos agents s’engagent à faire, et ce qu’ils ont réellement tenu, dans chaque dossier de présentation.</p>
<button id="engagements-voir" type="button" class="secondaire">Voir les engagements</button>
<p id="engagements-etat" class="etat" role="status"></p>
<div id="engagements-corps"></div>
</section>
`;

/** Le chargeur posé dans le script de l'application : l'écran est servi à part, chargé une fois, jamais gardé. */
export const ENGAGEMENTS_JS = `
  /* ---------- Les engagements de service sur l'écran du réseau (G15), chargés au premier geste [R16, R141, R201]. ---------- */
  var engagementsTools = null, engagementsLoading = false;
  function wipeEngagements() {
    clear($('engagements-corps'));
    $('engagements-etat').textContent = '';
  }
  function withEngagements(act) {
    if (!currentKey) return Promise.resolve(false);
    if (engagementsTools) return act(engagementsTools);
    if (engagementsLoading) return Promise.resolve(false);
    engagementsLoading = true;
    var mine = session;
    $('engagements-etat').textContent = 'Chargement…';
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.setAttribute('src', '/app/engagements.js');
      s.addEventListener('load', function () {
        engagementsLoading = false;
        var make = globalThis.AIMMO_ENGAGEMENTS;
        try { delete globalThis.AIMMO_ENGAGEMENTS; } catch (e) { /* rien */ }
        if (mine !== session) { resolve(false); return; }
        if (typeof make !== 'function') { $('engagements-etat').textContent = 'Indisponible pour le moment. Réessayez dans un moment.'; resolve(false); return; }
        engagementsTools = make({ $: $, el: el, clear: clear, send: send, button: button, field: field, select: select, checkbox: checkbox, details: details, date: date, session: function () { return session; } });
        resolve(act(engagementsTools));
      });
      s.addEventListener('error', function () {
        engagementsLoading = false;
        if (mine === session) $('engagements-etat').textContent = 'Pas de réseau. Réessayez dans un moment.';
        resolve(false);
      });
      $('reseau').appendChild(s);
    });
  }
`;

/** Le script servi à part (`/app/engagements.js`). Il ne lit et n'écrit que la route `/v1/gagner/engagements` [R16]. */
export const ENGAGEMENTS_SCRIPT = `'use strict';
globalThis.AIMMO_ENGAGEMENTS = function (t) {
  var $ = t.$, el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field, select = t.select, checkbox = t.checkbox, details = t.details, date = t.date;
  var REFUSALS = ${JSON.stringify(REFUSALS)};
  var MEASURES = ${JSON.stringify(MEASURES)};
  var PATH = '/v1/gagner/engagements';
  var OFFLINE = 'Pas de réseau. Réessayez dans un moment.';
  /* Une écriture sans réponse, ou coupée par une panne du serveur, a pu passer : l'écran ne dit ni fait ni pas fait. */
  var LOST = 'La réponse n’est pas arrivée : rien n’est sûr. Relisez la liste avant de recommencer.';
  var busy = null, showing = 0;
  function state(text) { $('engagements-etat').textContent = text; }
  function once(work) {
    var mine = t.session();
    if (busy === mine) return Promise.resolve(false);
    busy = mine;
    function done(r) { if (busy === mine) busy = null; return r; }
    return work().then(done, function () { return done(false); });
  }
  function why(res, fallback) {
    if (res.offline) return OFFLINE;
    return (res.body && REFUSALS[res.body.code]) || fallback;
  }
  /* Un nombre entier d'heures, tel que saisi ; illisible : null, et rien ne part. */
  function hours(input) {
    var v = String(input.value || '').trim();
    return /^\\d{1,3}$/.test(v) && Number(v) >= 1 && Number(v) <= 336 ? Number(v) : null;
  }
  function save(payload, done) {
    return once(function () {
      state('Envoi…');
      return send(PATH, 'POST', payload).then(function (x) {
        if (x.gone) return false;
        if (x.offline || !x.body || x.status >= 500) { state(LOST); return false; }
        if (!x.ok) { state(why(x, 'L’engagement n’est pas rangé.')); return false; }
        return show(done);
      });
    });
  }
  /* Le même formulaire pour une nouvelle version et un nouvel engagement ; les contrôles fins sont ceux du serveur. */
  function form(box, prefix, values, submit, make) {
    var label = field(box, prefix + '-texte', 'Ce que l’agent fait, sans chiffre ni promesse');
    label.setAttribute('maxlength', '120');
    label.value = values.label;
    var delay = field(box, prefix + '-delai', 'Délai, en heures');
    delay.setAttribute('inputmode', 'numeric');
    delay.value = values.delay;
    var active = checkbox(box, prefix + '-actif', 'En service : dans les dossiers de présentation');
    active.checked = values.active;
    box.appendChild(button(submit, function () {
      var h = hours(delay);
      if (h === null) { state(REFUSALS.bad_delay); return; }
      make(label.value.trim(), h, active.checked === true);
    }));
  }
  function render(items) {
    var body = $('engagements-corps');
    if (!items.length) body.appendChild(el('p', 'Aucun engagement : le dossier de présentation le dit au client.', 'doux'));
    var ul = el('ul', null, 'liste');
    items.forEach(function (c, i) {
      var li = el('li');
      li.appendChild(el('strong', c.label));
      li.appendChild(el('p', (c.active ? 'En service' : 'Retiré des dossiers') + ' · délai ' + c.delayHours + ' h · version ' + c.version + ', du ' + date(c.setAt) + '.', 'doux'));
      li.appendChild(el('p', c.rule, 'doux'));
      var d = details(li, 'Ranger une nouvelle version');
      form(d, 'engagement-' + i, { label: c.label, delay: String(c.delayHours), active: c.active }, 'Ranger cette version', function (label, h, active) {
        save({ code: c.code, label: label, measure: c.measure, delayHours: h, active: active }, 'Version rangée : l’ancienne reste au journal.');
      });
      ul.appendChild(li);
    });
    body.appendChild(ul);
    var add = details(body, 'Ajouter un engagement');
    var measure = select(add, 'engagement-mesure', 'Ce qui est mesuré', Object.assign({ '': 'Choisir' }, MEASURES), '');
    form(add, 'engagement-nouveau', { label: '', delay: '', active: true }, 'Ajouter cet engagement', function (label, h, active) {
      if (!measure.value) { state(REFUSALS.bad_measure); return; }
      /* Le code nomme la mesure et son délai : le même couple ajoute une version, jamais un doublon. */
      save({ code: measure.value + '_' + h + 'h', label: label, measure: measure.value, delayHours: h, active: active }, 'Engagement ajouté.');
    });
  }
  function show(message) {
    var mine = t.session();
    var turn = ++showing;
    clear($('engagements-corps'));
    state('Chargement…');
    return send(PATH, 'GET').then(function (res) {
      if (res.gone || mine !== t.session() || turn !== showing) return false;
      if (!res.ok || !Array.isArray(res.body.data)) { state((message ? message + ' ' : '') + why(res, 'Engagements indisponibles pour le moment.')); return false; }
      render(res.body.data);
      state(message || '');
      return true;
    });
  }
  return { show: show };
};
`;
