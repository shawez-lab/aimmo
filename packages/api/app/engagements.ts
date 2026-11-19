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
  function wipeEngagements() {
    clear($('engagements-corps'));
    $('engagements-etat').textContent = '';
  }
  function withEngagements(act) {
    return withTool('engagements', 'AIMMO_ENGAGEMENTS', 'engagements-etat', 'reseau', act, function () { return { $: $, el: el, clear: clear, send: send, button: button, field: field, select: select, checkbox: checkbox, details: details, date: date, session: function () { return session; } }; });
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
  function fresh() { return Array.from(crypto.getRandomValues(new Uint8Array(6)), function (b) { return (b + 256).toString(16).slice(1); }).join(''); }
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
      /* Un code neuf à chaque ajout : un nouvel engagement ne remplace jamais un engagement existant [R17]. Seule « nouvelle version » garde le code. */
      save({ code: measure.value + '_' + fresh(), label: label, measure: measure.value, delayHours: h, active: active }, 'Engagement ajouté.');
    });
    body.appendChild(renderScenarios());
    body.appendChild(renderReclamations());
    body.appendChild(subScreen('Remises négociées', 'Les remises obtenues pour les agents et leurs clients, chacune avec sa source et sa date de fin, proposées à l’agent au bon moment du dossier.', 'Ouvrir les remises', '/app/remises.js', 'AIMMO_REMISES'));
    body.appendChild(subScreen('Programmes neufs', 'Les barèmes des frais d’acquisition, chacun avec sa source, et les programmes d’un promoteur de l’annuaire confiés à un agent.', 'Ouvrir les programmes neufs', '/app/neuf-direction.js', 'AIMMO_NEUF_DIRECTION'));
    body.appendChild(subScreen('Banque et relances des impayés', 'L’âge du dernier relevé, son dépôt, les lignes à rapprocher des factures d’honoraires, les encaissements prouvés par la banque et les relances à valider.', 'Ouvrir la banque', '/app/banque.js', 'AIMMO_BANQUE'));
    body.appendChild(subScreen('Rapports sur mesure', 'Des mesures et un regroupement de votre choix, pour le total du réseau ou un seul agent, jamais deux côte à côte ; chaque chiffre s’ouvre sur ses lignes.', 'Ouvrir les rapports', '/app/rapports.js', 'AIMMO_RAPPORTS'));
    body.appendChild(subScreen('Stock de panneaux', 'Les panneaux du réseau par format, ceux posés et à récupérer, et l’ajout au stock avec les numéros à écrire sur les panneaux.', 'Ouvrir le stock', '/app/panneaux.js', 'AIMMO_PANNEAUX'));
  }
  /* Un écran de la direction posé sous les engagements, servi à part et chargé au premier geste [R201] :
     les scénarios automatiques (BR57, \`/app/scenarios.js\`), le réglage des réclamations (BR70, \`/app/reclamations-reglage.js\`), les remises négociées (BR73, \`/app/remises.js\`), les programmes neufs (BR79, \`/app/neuf-direction.js\`), la banque et les relances (BR93, \`/app/banque.js\`), les rapports sur mesure (BR94, \`/app/rapports.js\`), le stock de panneaux (BR105, \`/app/panneaux.js\`). */
  var screens = {};
  function subScreen(title, intro, label, src, name) {
    var box = el('section', null, 'bloc');
    box.appendChild(el('h4', title));
    box.appendChild(el('p', intro, 'doux'));
    var inner = el('div');
    var b = button(label, function () {
      if (b.disabled) return;
      if (screens[src]) { screens[src].show(inner); return; }
      b.disabled = true;
      var mine = t.session();
      var s = el('script');
      s.setAttribute('src', src);
      s.addEventListener('load', function () {
        var make = globalThis[name];
        try { delete globalThis[name]; } catch (e) { /* rien */ }
        b.disabled = false;
        if (mine !== t.session()) return;
        if (typeof make !== 'function') { clear(inner); inner.appendChild(el('p', 'Indisponible pour le moment. Réessayez dans un moment.', 'etat')); return; }
        screens[src] = make({ el: el, clear: clear, send: send, button: button, field: field, select: select, details: details, date: date, session: t.session });
        screens[src].show(inner);
      });
      s.addEventListener('error', function () { b.disabled = false; if (mine === t.session()) { clear(inner); inner.appendChild(el('p', OFFLINE, 'etat')); } });
      box.appendChild(s);
    });
    box.appendChild(b);
    box.appendChild(inner);
    return box;
  }
  function renderScenarios() {
    return subScreen('Scénarios automatiques', 'Un message ou une tâche après un nouveau contact, un nouveau projet, une visite faite ou un mandat signé. Chaque version s’essaie sur le mois passé avant de s’allumer.', 'Ouvrir les scénarios', '/app/scenarios.js', 'AIMMO_SCENARIOS');
  }
  function renderReclamations() {
    return subScreen('Réclamations : délai et médiateur', 'Le délai pour répondre à une réclamation, et le médiateur de la consommation proposé au client quand elle n’est pas réglée.', 'Ouvrir le réglage', '/app/reclamations-reglage.js', 'AIMMO_RECLAMATIONS_REGLAGE');
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
