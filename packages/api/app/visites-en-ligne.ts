/**
 * BR64 · Les visites réservées en ligne, rattachées à la recherche depuis la fiche (RC32) [R16, R40, R42, R201]. Le bloc
 * est posé par `/app/biens-fiche.js`, seulement sur une fiche qui a un projet d'achat ; son script est servi à part
 * (`/app/visites-en-ligne.js`) et chargé au premier geste : l'application ne grossit pas. Il lit
 * `GET /v1/fiches/<id>/visites-en-ligne` et rattache par `POST /v1/visites/<rendez-vous>/rattachement`. Le bien est dit
 * par sa référence et sa commune, jamais son adresse [R19]. Tout texte reçu est posé en texte ; un champ mal formé
 * n'est pas dit ; chaque refus est dit en mots, jamais par son code ni un identifiant. Rien n'est envoyé d'ici.
 */

/** D'où vient la réservation, en mots. */
export const VISITES_EN_LIGNE_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  site: 'sur le site',
  assistant: 'par l’assistant',
  espace: 'depuis son espace',
});

/** Chaque refus, dit en mots [R16, R40, R42]. */
export const VISITES_EN_LIGNE_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  role: 'Ce geste n’est pas dans vos droits.',
  not_assigned: 'Cette fiche est suivie par un autre agent.',
  other_network: 'Cette fiche n’est pas dans votre réseau.',
  agent_file_incomplete: 'Votre dossier d’agent n’est pas complet : les fiches clients restent fermées.',
  unknown: 'Cette visite n’existe plus : rouvrez la fiche.',
  unknown_project: 'Ce projet d’achat n’existe plus : rouvrez la fiche.',
  other_person: 'Ce projet d’achat n’est pas celui de la personne qui a réservé.',
  not_a_visit: 'Ce rendez-vous n’est pas une visite.',
  no_property: 'Cette visite n’a pas de bien : fixez la visite vous-même.',
  not_booked: 'Cette visite a été annulée ou décalée : rien n’est rattaché.',
  already_attached: 'Cette visite est déjà rattachée : son bon de visite existe.',
  no_template: 'Aucun modèle de bon de visite n’est en service : la direction doit en créer un. Rien n’est rattaché.',
  withdrawal_period: 'Le bien est encore dans le délai de rétractation du mandat : il ne se visite pas encore. Rien n’est rattaché.',
  invalid_project: 'La demande n’a pas pu être lue. Rechargez l’écran.',
  invalid_body: 'La demande n’a pas pu être lue. Rechargez l’écran.',
  unexpected_field: 'La demande n’a pas pu être lue. Rechargez l’écran.',
});

/** Un bien que la diffusion refuse, pour une autre raison que la rétractation [R42]. */
export const VISITES_EN_LIGNE_NOT_DIFFUSABLE = 'Ce bien ne peut pas être visité pour le moment (mandat, statut ou diffusion) : rien n’est rattaché.';

/** Une écriture sans réponse a pu passer : l'écran ne dit ni fait ni pas fait. */
export const VISITES_EN_LIGNE_LOST = 'La réponse n’est pas arrivée : la visite est peut-être rattachée. Relisez la liste : une visite rattachée n’y est plus, et un second rattachement ne la double jamais.';

export const VISITES_EN_LIGNE_SCRIPT = `'use strict';
globalThis.AIMMO_VISITES_EN_LIGNE = function (t) {
  var el = t.el;
  var SOURCES = ${JSON.stringify(VISITES_EN_LIGNE_SOURCES)};
  var REFUSALS = ${JSON.stringify(VISITES_EN_LIGNE_REFUSALS)};
  var NOT_DIFFUSABLE = ${JSON.stringify(VISITES_EN_LIGNE_NOT_DIFFUSABLE)};
  var LOST = ${JSON.stringify(VISITES_EN_LIGNE_LOST)};
  var OFFLINE = 'Pas de réseau. Réessayez dans un moment.';
  var ID = /^[A-Za-z0-9_-]{1,64}$/, INSTANT = /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}/;
  function own(map, k) { return typeof k === 'string' && Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; }
  function text(v, max) { return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null; }
  function when(iso) {
    if (typeof iso !== 'string' || !INSTANT.test(iso) || isNaN(Date.parse(iso))) return null;
    var d = new Date(iso);
    var day = d.toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long' });
    var hm = d.toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }).replace(':', ' h ');
    return day + ' à ' + hm;
  }
  function refusal(res) {
    var b = res.body || {};
    var said = own(REFUSALS, b.code);
    if (said) return said;
    if (b.rule === 'R42') return NOT_DIFFUSABLE;
    return null;
  }
  function button(label, run) {
    var b = el('button', label);
    b.setAttribute('type', 'button');
    b.addEventListener('click', run);
    return b;
  }
  return function (box, personId, projects) {
    var id = t.cSeq();
    var state = t.cState();
    var list = el('ul');
    var labels = {};
    projects.forEach(function (p, n) { labels[p.id] = 'Projet d’achat ' + (n + 1); });
    function line(v, n) {
      var start = when(v.start), ref = v.property && text(v.property.reference, 64), how = own(SOURCES, v.source);
      if (!start || !ref || !how || typeof v.appointmentId !== 'string' || !ID.test(v.appointmentId)) return null;
      var city = v.property && text(v.property.city, 120);
      var li = el('li');
      li.appendChild(el('p', 'Visite du ' + start + ', réf. ' + ref + (city ? ' à ' + city : '') + ', réservée ' + how + '.'));
      var pick = projects.length > 1 ? t.cSelect(li, id + '-projet-' + n, 'Le projet', labels, projects[0].id) : null;
      var said = el('p', null, 'etat');
      said.setAttribute('role', 'status');
      var busy = false;
      var go = button('Rattacher à sa recherche', function () {
        if (busy) return;
        var project = pick ? pick.value : projects[0].id;
        if (!own(labels, project)) return;
        busy = true;
        said.textContent = 'Rattachement…';
        t.send('/v1/visites/' + encodeURIComponent(v.appointmentId) + '/rattachement', 'POST', { projectId: project }).then(function (res) {
          busy = false;
          if (res.gone) return;
          if (!res.ok) {
            var r = refusal(res);
            if (r) { said.textContent = r; return; }
            said.textContent = res.offline || !res.body || res.status >= 500 ? LOST : 'La visite n’est pas rattachée.';
            return;
          }
          var slip = res.body.data && res.body.data.slip;
          li.removeChild(go);
          if (pick && pick.parentNode === li) li.removeChild(pick);
          said.textContent = 'Rattachée à la recherche : le bon de visite est prêt' + (slip && slip.mode === 'essai' ? ', d’essai tant que le modèle n’est pas validé' : '') + '. Il se retrouve avec la visite.';
        }, function () { busy = false; said.textContent = LOST; });
      });
      li.appendChild(go);
      li.appendChild(said);
      return li;
    }
    box.appendChild(el('p', 'Les visites prises par la personne sur le site, par l’assistant ou depuis son espace, pas encore rattachées à sa recherche. Rattachées, elles ont leur bon de visite. Rien n’est envoyé.', 'doux'));
    box.appendChild(state);
    box.appendChild(list);
    state.textContent = 'Lecture…';
    return t.send('/v1/fiches/' + encodeURIComponent(personId) + '/visites-en-ligne', 'GET').then(function (res) {
      if (res.gone) return false;
      if (res.offline) { state.textContent = OFFLINE; return false; }
      if (!res.ok || !res.body || !Array.isArray(res.body.data)) { state.textContent = refusal(res) || 'Les visites en ligne ne se lisent pas pour le moment.'; return false; }
      res.body.data.forEach(function (v, n) { var li = v && typeof v === 'object' ? line(v, n) : null; if (li) list.appendChild(li); });
      state.textContent = list.firstChild ? '' : 'Aucune visite réservée en ligne n’attend.';
      return true;
    });
  };
};
`;
