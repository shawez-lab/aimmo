/**
 * La recherche de biens en langage courant depuis la fiche d'un acquéreur (BR40) [R420 à R424, R16, R201], servie à
 * part (`/app/recherche.js`) et chargée au premier geste depuis le bloc de la fiche (`/app/biens-fiche.js`) :
 * l'application ne grossit pas. L'écran ne lit et n'écrit que par `/v1/recherche` (BR39). Il envoie la phrase de la
 * personne et ses gestes (refus d'un bien avec sa raison, commune voisine acceptée), jamais des critères : tout est
 * relu sur le serveur [R420]. Il ne trie ni ne calcule rien, l'ordre reçu est gardé. Aucune adresse n'est montrée
 * [R421]. Ranger demande l'accord en cours de la personne, contrôlé par le serveur seul [R422]. Un refus se dit en
 * mots, jamais par son code ; tout texte reçu est posé en texte.
 */
export const RECHERCHE_KIND_LABELS: Readonly<Record<string, string>> = Object.freeze({
  home: 'Maison ou appartement',
  house: 'Maison',
  apartment: 'Appartement',
  building: 'Immeuble',
  land: 'Terrain',
  commercial: 'Local commercial',
  business_walls: 'Murs commerciaux',
  business: 'Fonds de commerce',
});

/** Les raisons d'un refus, la liste fermée de la couche métier [R424]. */
export const RECHERCHE_REFUSAL_LABELS: Readonly<Record<string, string>> = Object.freeze({
  trop_cher: 'Trop cher',
  trop_petit: 'Trop petit',
  pas_assez_de_pieces: 'Pas assez de pièces',
  pas_assez_de_chambres: 'Pas assez de chambres',
  commune: 'La commune ne convient pas',
  type: 'Le type de bien ne convient pas',
  manque: 'Il manque quelque chose',
});

/** Les contraintes sur le bien, la liste fermée de la fiche acquéreur [R50]. */
export const RECHERCHE_FEATURE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  garden: 'Jardin',
  balcony: 'Balcon',
  terrace: 'Terrasse',
  garage: 'Garage',
  parking: 'Stationnement',
  cellar: 'Cave',
  elevator: 'Ascenseur',
  pool: 'Piscine',
  single_storey: 'Plain-pied',
  quiet: 'Calme',
  bright: 'Lumineux',
  view: 'Vue',
  fireplace: 'Cheminée',
  outbuilding: 'Dépendance',
});

export const RECHERCHE_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  role: 'Ce geste n’est pas dans vos droits.',
  invalid_body: 'La demande n’a pas pu être lue. Rechargez l’écran.',
  unknown_field: 'La demande n’a pas pu être lue. Rechargez l’écran.',
  bad_steps: 'La demande n’a pas pu être lue. Rechargez l’écran.',
  bad_phrase: 'La phrase : de 1 à 500 caractères, telle que la personne la dit.',
  unknown: 'Ce projet n’existe plus : rouvrez la fiche.',
  not_assigned: 'Cette fiche est suivie par un autre agent.',
  sans_accord: 'La personne n’a pas d’accord en cours pour garder sa recherche : rien n’est rangé. Les biens restent lisibles ici.',
  aucun_critere: 'La phrase ne dit rien de ce qui est cherché : rien n’est rangé.',
  a_preciser: 'Après les refus, plus rien ne dit la commune ou le type cherché : précisez la phrase avant de ranger.',
});

/** Une écriture sans réponse a pu passer : l'écran ne dit ni fait ni pas fait. */
export const RECHERCHE_LOST = 'La réponse n’est pas arrivée : la recherche est peut-être rangée. Ranger de nouveau ne la double pas, la fiche garde ses versions.';

export const RECHERCHE_SCRIPT = `'use strict';
globalThis.AIMMO_RECHERCHE = function (t) {
  var el = t.el;
  var KINDS = ${JSON.stringify(RECHERCHE_KIND_LABELS)};
  var REASONS = ${JSON.stringify(RECHERCHE_REFUSAL_LABELS)};
  var FEATURES = ${JSON.stringify(RECHERCHE_FEATURE_LABELS)};
  var REFUSALS = ${JSON.stringify(RECHERCHE_REFUSALS)};
  var LOST = ${JSON.stringify(RECHERCHE_LOST)};
  var OFFLINE = 'Pas de réseau. Réessayez dans un moment.';
  var MAX = 500, ID = /^[A-Za-z0-9_-]{1,64}$/;
  function why(res, fallback) {
    if (res.offline) return OFFLINE;
    var b = res.body || {};
    return REFUSALS[b.code] || fallback;
  }
  function euros(n) { return String(n).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ' ') + ' €'; }
  function whole(n) { return typeof n === 'number' && isFinite(n) && n >= 0 && Math.floor(n) === n; }
  function text(x) { return typeof x === 'string' ? x : ''; }
  return function (box, projects) {
    var id = t.cSeq();
    var state = t.cState();
    var form = el('div', null, 'decision');
    box.appendChild(el('p', 'Tapez la phrase de la personne, avec ses mots. Les critères sont lus par le code, sans IA ; chaque bien dit pourquoi il répond. Les adresses ne sont jamais montrées.', 'doux'));
    var l = el('label', 'Ce que la personne cherche');
    l.setAttribute('for', id + '-phrase');
    var input = el('textarea');
    input.setAttribute('id', id + '-phrase');
    input.setAttribute('maxlength', String(MAX));
    form.appendChild(l);
    form.appendChild(input);
    var out = el('div');
    /* La recherche montrée : sa phrase et ses gestes ; ranger range exactement ce qui est montré. */
    var shown = null, turn = 0, saving = false, pending = false;
    function phraseOf() {
      var v = String(input.value || '').trim();
      return v.length === 0 || v.length > MAX ? null : v;
    }
    function draw(v, phrase, steps) {
      clear(out);
      shown = { phrase: phrase, steps: steps };
      var s = v.search || {};
      (Array.isArray(s.ignored) ? s.ignored : []).forEach(function (w) {
        if (!w || !text(w.words)) return;
        out.appendChild(el('p', '« ' + w.words + ' » : écarté, ' + (w.reason === 'negation' ? 'une négation ne fait jamais un critère.' : 'ce critère ne peut pas servir à choisir un bien.'), 'doux'));
      });
      var results = Array.isArray(v.results) ? v.results : [];
      out.appendChild(el('h4', results.length ? results.length + (results.length > 1 ? ' biens répondent' : ' bien répond') : 'Aucun bien ne répond pour le moment'));
      list(results, steps, phrase);
      var proposed = Array.isArray(v.proposedNeighbours) ? v.proposedNeighbours : [];
      var near = Array.isArray(v.neighbours) ? v.neighbours : [];
      if (proposed.length || near.length) {
        out.appendChild(el('h4', 'Communes voisines'));
        out.appendChild(el('p', 'Aucune n’entre dans la recherche sans l’accord de la personne.', 'doux'));
        proposed.forEach(function (n) {
          if (!n || !text(n.commune)) return;
          out.appendChild(button('Ajouter ' + n.commune + ' (voisine de ' + text(n.of) + ')', function () {
            gesture(phrase, steps.concat([{ acceptNeighbour: n.commune }]));
          }));
        });
        list(near, steps, phrase);
      }
      if (projects.length) save();
    }
    function button(label, act) {
      var b = el('button', label);
      b.setAttribute('type', 'button');
      b.addEventListener('click', act);
      return b;
    }
    function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
    function list(items, steps, phrase) {
      var ul = el('ul', null, 'liste');
      items.forEach(function (r, i) {
        if (!r || !ID.test(text(r.propertyId)) || !text(r.reference)) return;
        var li = el('li');
        li.appendChild(el('strong', 'Réf. ' + r.reference));
        var facts = [KINDS[r.kind] || 'Bien', text(r.city) || null, whole(r.priceEur) ? euros(r.priceEur) : null, whole(r.surfaceM2) ? r.surfaceM2 + ' m²' : null, whole(r.rooms) ? r.rooms + (r.rooms > 1 ? ' pièces' : ' pièce') : null].filter(Boolean).join(', ');
        li.appendChild(el('p', facts + '.'));
        if (text(r.neighbourOf)) li.appendChild(el('p', 'Commune voisine de ' + r.neighbourOf + ' : la personne ne l’a pas cherchée.', 'alerte'));
        if (r.status === 'tolerated') li.appendChild(el('p', 'Un peu en dehors de la recherche, dans la marge admise.', 'doux'));
        var because = el('ul');
        (Array.isArray(r.reasons) ? r.reasons : []).forEach(function (x) {
          if (!x || !text(x.text)) return;
          because.appendChild(el('li', x.text + (text(x.from) ? ' (d’après « ' + x.from + ' »)' : '') + '.'));
        });
        li.appendChild(because);
        var d = el('details');
        d.appendChild(el('summary', 'Ne lui convient pas'));
        var reason = t.cSelect(d, id + '-raison-' + r.propertyId + '-' + i, 'Pourquoi', REASONS, 'trop_cher');
        var feature = t.cSelect(d, id + '-manque-' + r.propertyId + '-' + i, 'Ce qui manque (pour « Il manque quelque chose »)', FEATURES, 'garden');
        d.appendChild(button('Écarter la réf. ' + r.reference, function () {
          var step = { refuse: r.propertyId, reason: reason.value };
          if (!REASONS[reason.value]) return;
          if (reason.value === 'manque') {
            if (!FEATURES[feature.value]) return;
            step.feature = feature.value;
          }
          gesture(phrase, steps.concat([step]));
        }));
        li.appendChild(d);
        ul.appendChild(li);
      });
      if (ul.firstChild) out.appendChild(ul);
    }
    function save() {
      var part = el('div', null, 'decision');
      part.appendChild(el('h4', 'Ranger dans la fiche acquéreur'));
      part.appendChild(el('p', 'Seulement avec l’accord en cours de la personne. Les critères et leurs mots sont gardés, jamais la phrase.', 'doux'));
      var labels = {};
      projects.forEach(function (p, n) { labels[p.id] = 'Projet d’achat ' + (n + 1); });
      var pick = projects.length > 1 ? t.cSelect(part, id + '-projet', 'Le projet', labels, projects[0].id) : null;
      var done = el('p', null, 'etat');
      done.setAttribute('role', 'status');
      part.appendChild(button('Ranger cette recherche', function () {
        if (saving || !shown) return;
        if (pending) { done.textContent = WAIT; return; }
        var project = pick ? pick.value : projects[0].id;
        if (!labels[project]) return;
        saving = true;
        done.textContent = 'Enregistrement…';
        t.send('/v1/recherche/projets/' + encodeURIComponent(project) + '/phrase', 'POST', { phrase: shown.phrase, steps: shown.steps }).then(function (res) {
          saving = false;
          if (res.gone) return;
          if (!res.ok) {
            var code = res.body && res.body.code;
            if (REFUSALS[code]) { done.textContent = REFUSALS[code]; return; }
            if (res.offline || !res.body || res.status >= 500) { done.textContent = LOST; return; }
            done.textContent = 'La recherche n’est pas rangée.';
            return;
          }
          var n = res.body.data && whole(res.body.data.criteria) ? res.body.data.criteria : 0;
          done.textContent = 'Recherche rangée : ' + n + (n > 1 ? ' critères' : ' critère') + ', avec les mots qui les portent. La phrase n’est pas gardée.';
        }, function () { saving = false; done.textContent = LOST; });
      }));
      part.appendChild(done);
      out.appendChild(part);
    }
    /* Seule la dernière recherche dessine : une réponse arrivée après une autre demande ne montre rien. */
    var WAIT = 'Une recherche est en cours : attendez sa réponse, puis recommencez.';
    /* Un geste à la fois : un refus ou une voisine pendant une recherche en cours ne part pas, sinon le geste d'avant
       serait perdu [R424]. Une nouvelle phrase, elle, remplace la recherche en cours. */
    function gesture(phrase, steps) {
      if (pending) { state.textContent = WAIT; return; }
      run(phrase, steps);
    }
    function run(phrase, steps) {
      var mine = ++turn;
      pending = true;
      state.textContent = 'Recherche…';
      return t.send('/v1/recherche/phrase', 'POST', { phrase: phrase, steps: steps }).then(function (res) {
        if (mine === turn) pending = false;
        if (res.gone || mine !== turn) return false;
        if (!res.ok || !res.body || !res.body.data) { state.textContent = why(res, 'La recherche ne répond pas pour le moment.'); return false; }
        state.textContent = '';
        draw(res.body.data, phrase, steps);
        return true;
      });
    }
    form.appendChild(button('Chercher', function () {
      var phrase = phraseOf();
      if (phrase === null) { state.textContent = REFUSALS.bad_phrase; return; }
      run(phrase, []);
    }));
    form.appendChild(state);
    box.appendChild(form);
    box.appendChild(out);
  };
};
`;
