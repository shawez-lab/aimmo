import { VIAGER_NOTICE } from '../../core/src/neuf-viager/index.ts';

/**
 * Le calcul de viager à l'écran de l'agent (BR81), servi à part (`/app/viager.js`) et chargé seulement quand l'agent
 * ouvre la partie « Viager » de l'écran « Gagner des mandats » : l'application tient ainsi son budget de poids [R201].
 *
 * Il lit les projets de l'agent par `GET /v1/partenaires/projets` (les seuls biens dans ses droits y sont rendus [R16]),
 * calcule par `POST /v1/viager/calculs`, rejoue par `GET /v1/viager/calculs/<id>/rejeu` et propose l'expert du viager
 * par `POST /v1/viager/calculs/<id>/expert`, c'est-à-dire par la mise en relation de M18 : rien n'est écrit à l'expert
 * d'ici, le client choisit [R542]. Il ne calcule rien : bouquet, rente et chaque ligne viennent du serveur, chacune
 * avec sa source, sa date et son hypothèse [R540] ; l'espérance de vie vient de la table de la direction, jamais
 * saisie, et sans elle aucun chiffre n'est écrit [R541]. La mention « ni offre ni conseil » est toujours à l'écran
 * [R542]. Un refus se dit en mots, jamais par son code ; un calcul sans réponse est dit incertain. Tout texte reçu est
 * posé avec `textContent` ; rien n'est gardé sur l'appareil.
 */

/** Le nom de chaque ligne du calcul ; une ligne d'un autre nom n'est pas montrée. */
export const VIAGER_LABELS: Readonly<Record<string, string>> = Object.freeze({
  marketValue: 'Valeur libre',
  occupied: 'Forme du viager',
  'headAges.1': 'Âge de la première tête',
  'headAges.2': 'Âge de la seconde tête',
  bouquet: 'Bouquet',
  annualRateBp: 'Taux technique annuel',
  'expectancies.1': 'Espérance de vie, première tête',
  'expectancies.2': 'Espérance de vie, seconde tête',
  expectancyRetained: 'Espérance retenue',
  usageRight: 'Droit d’usage et d’habitation',
  occupiedValue: 'Valeur occupée',
  bouquetShareBp: 'Part du bouquet dans la valeur occupée',
  capital: 'Capital converti en rente',
  months: 'Durée retenue',
  monthlyRent: 'Rente mensuelle',
  rentTotal: 'Total des rentes',
});
/** Les raisons d'un refus, dites à l'agent : jamais un code interne. */
export const VIAGER_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  role: 'Le viager n’est pas dans vos droits.',
  agent_inactive: 'Votre accès d’agent n’est pas actif.',
  agent_file_incomplete: 'Votre dossier d’agent n’est pas complet : aucune donnée d’un client ne se lit.',
  not_assigned: 'Ce bien ou ce projet est suivi par un autre agent.',
  not_owner: 'Ce bien n’appartient pas au vendeur de ce projet : le viager se calcule sur le bien du vendeur.',
  unknown: 'Introuvable : la liste a changé, rouvrez la partie Viager.',
  bouquet_trop_haut: 'Le bouquet dépasse la valeur occupée du bien : baissez-le.',
  valeur: 'Un chiffre est hors des bornes : valeur d’au moins 10 000 €, âges de 40 à 110 ans, taux de 0 à 15 %.',
  champ: 'La demande n’a pas pu être lue.',
  esperance_saisie: 'L’espérance de vie ne se saisit pas : elle vient de la table de la direction.',
  sans_projet: 'Ce calcul n’est rattaché à aucun projet : l’expert se propose depuis un projet de vente.',
  relation_absente: 'La mise en relation n’est pas en service : aucun expert ne peut être proposé.',
  no_partner: 'Aucun expert du viager de l’annuaire ne travaille dans ce secteur.',
  bad_postcode: 'Le code postal doit avoir cinq chiffres.',
  bad_property: 'Ce bien ne peut pas être cité pour la mise en relation.',
  partner_unavailable: 'L’expert n’est pas disponible pour le moment.',
  bad_page: 'Cette page de projets n’existe pas.',
  invalid_body: 'La demande n’a pas pu être lue.',
});
export const VIAGER_OFFLINE = 'Pas de réseau. Réessayez dans un moment.';
export const VIAGER_LOST = 'La réponse n’est pas arrivée : rien n’est sûr. Rouvrez le bien pour voir si le calcul a été rangé avant de recommencer.';
export const VIAGER_NONE = 'Aucun projet de vente avec un bien dans vos droits : le viager se calcule sur le bien d’un vendeur que vous suivez.';
export const VIAGER_NO_TABLE =
  'Aucun chiffre : la table d’espérance de vie en service manque, ou l’âge saisi n’y figure pas. La direction l’importe depuis l’écran du réseau.';
export const VIAGER_MISSING = 'Remplissez chaque champ, et dites d’où vient chaque chiffre, avant de calculer.';
export const VIAGER_SAME = 'Identique : rejoué depuis ses entrées et la même table, le calcul redonne chaque chiffre au caractère près.';
export const VIAGER_TABLE_CHANGED = 'Écart : la table d’espérance citée par ce calcul ne donne plus les mêmes espérances.';
export const VIAGER_EXPERT_DONE =
  'Tirage fait : les experts du viager proposés sont dans l’écran Partenaires, sous ce projet. Montrez-les au vendeur : c’est lui qui choisit, rien ne leur est envoyé.';

export const VIAGER_SCRIPT = `'use strict';
globalThis.AIMMO_VIAGER = function (t) {
  var el = t.el, clear = t.clear, send = t.send, button = t.button;
  var LABELS = ${JSON.stringify(VIAGER_LABELS)};
  var REFUSALS = ${JSON.stringify(VIAGER_REFUSALS)};
  var NOTICE = ${JSON.stringify(VIAGER_NOTICE)};
  var OFFLINE = ${JSON.stringify(VIAGER_OFFLINE)}, LOST = ${JSON.stringify(VIAGER_LOST)}, NONE = ${JSON.stringify(VIAGER_NONE)};
  var NO_TABLE = ${JSON.stringify(VIAGER_NO_TABLE)}, MISSING = ${JSON.stringify(VIAGER_MISSING)}, SAME = ${JSON.stringify(VIAGER_SAME)};
  var TABLE_CHANGED = ${JSON.stringify(VIAGER_TABLE_CHANGED)}, EXPERT_DONE = ${JSON.stringify(VIAGER_EXPERT_DONE)};
  var ID = /^[A-Za-z0-9_-]{1,64}$/, DAY = /^\\d{4}-\\d{2}-\\d{2}$/, CP = /^\\d{5}$/;
  var root = null, load = 0, page = 0;
  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function str(x) { return typeof x === 'string' ? x : ''; }
  function int(x) { return typeof x === 'number' && isFinite(x) && Math.floor(x) === x; }
  function refusal(x, fallback) {
    if (x.offline) return OFFLINE;
    var c = x.body && typeof x.body.code === 'string' ? x.body.code : '';
    return own(REFUSALS, c) ? REFUSALS[c] : fallback;
  }
  function day(s) { var p = typeof s === 'string' && DAY.test(s) ? s.split('-') : null; return p ? p[2] + '/' + p[1] + '/' + p[0] : ''; }
  function group(n) { return String(n).replace(/\\B(?=(\\d{3})+(?!\\d))/g, '\\u202f'); }
  /** Des centièmes, écrits sans unité : 450 donne « 4,5 ». */
  function plain(h) {
    var r = h % 100;
    return group((h - r) / 100) + (r ? ',' + (r < 10 ? '0' + r : String(r)).replace(/0$/, '') : '');
  }
  /** Ce que l'agent tape, en entier de centièmes : « 4,5 » donne 450 ; une forme douteuse n'est pas lue. */
  function hundredths(s) {
    var m = /^(\\d{1,9})(?:[.,](\\d{1,2}))?$/.exec(String(s).replace(/[\\s\\u00a0\\u202f]/g, ''));
    if (!m) return null;
    var d = m[2] || '';
    return Number(m[1]) * 100 + (d ? Number(d.length === 1 ? d + '0' : d) : 0);
  }
  function age(s) { var v = String(s).trim(); return /^\\d{2,3}$/.test(v) ? Number(v) : null; }
  /** Une valeur reçue, écrite selon son unité ; une unité inconnue ou une valeur mal formée n'est pas écrite. */
  function shown(l) {
    var v = l.value;
    if (!int(v)) return '';
    if (l.unit === 'cents') return v < 0 ? '' : plain(v) + '\\u00a0€';
    if (l.unit === 'bp') return v < 0 ? '' : plain(v) + '\\u00a0%';
    if (l.unit === 'mois') return v < 0 ? '' : group(v) + '\\u00a0mois';
    if (l.unit === 'annees') return v < 0 ? '' : v + '\\u00a0ans';
    if (l.unit === 'dixiemes_annee') return v < 0 ? '' : String((v - (v % 10)) / 10) + (v % 10 ? ',' + (v % 10) : '') + '\\u00a0ans';
    if (l.unit === 'oui_non') return v === 1 ? 'occupé' : v === 0 ? 'libre' : '';
    return '';
  }
  /** La source dite en mots : jamais l'identifiant d'une personne ni d'une table. */
  function source(s) {
    s = str(s);
    if (/^saisi:/.test(s)) return 'saisi à l’écran';
    var c = /^calcul:viager:v(\\d{1,3})$/.exec(s);
    if (c) return 'calcul AIMMO, formule ' + c[1];
    var tb = /^table:[^ ]+ · (.+)$/.exec(s);
    if (tb) return 'table de la direction : ' + tb[1];
    return '';
  }
  function wellFormed(l) { return l && typeof l === 'object' && own(LABELS, l.key) && shown(l) && source(l.source) && DAY.test(str(l.asOf)) && str(l.hypothesis); }
  function field(box, id, label, mode) {
    var l = el('label', label);
    l.setAttribute('for', id);
    var f = el('input');
    f.setAttribute('id', id);
    f.setAttribute('autocomplete', 'off');
    if (mode) f.setAttribute('inputmode', mode);
    box.appendChild(l);
    box.appendChild(f);
    return f;
  }
  function note(text) { var p = el('p', text, 'etat'); p.setAttribute('role', 'status'); return p; }
  function notice() { return el('p', NOTICE, 'doux'); }
  function lines(result) {
    var ol = el('ol', null, 'liste');
    (Array.isArray(result.lines) ? result.lines : []).filter(wellFormed).forEach(function (l) {
      var li = el('li');
      li.appendChild(el('strong', LABELS[l.key] + ' : ' + shown(l)));
      li.appendChild(el('p', l.hypothesis + ' · source : ' + source(l.source) + ' · le ' + day(l.asOf), 'doux'));
      ol.appendChild(li);
    });
    return ol;
  }
  function find(result, key) {
    var all = Array.isArray(result.lines) ? result.lines.filter(wellFormed) : [];
    for (var i = 0; i < all.length; i++) if (all[i].key === key) return all[i];
    return null;
  }
  /** Le rejeu : identique, ou chaque ligne qui a changé, avec son ancienne et sa nouvelle valeur [R540]. */
  function replayed(place, before, r) {
    clear(place);
    if (r.same === true) { place.appendChild(note(SAME)); return; }
    var after = r.result && typeof r.result === 'object' ? r.result : {};
    var ul = el('ul', null, 'liste');
    var keys = {};
    [before, after].forEach(function (x) { (Array.isArray(x.lines) ? x.lines : []).filter(wellFormed).forEach(function (l) { keys[l.key] = true; }); });
    Object.keys(keys).forEach(function (k) {
      var a = find(before, k), b = find(after, k);
      var sa = a ? shown(a) : 'absent', sb = b ? shown(b) : 'absent';
      if (sa !== sb) ul.appendChild(el('li', LABELS[k] + ' : ' + sa + ' au calcul, ' + sb + ' au rejeu'));
    });
    if (!ul.children.length) { place.appendChild(note(TABLE_CHANGED)); return; }
    place.appendChild(note('Écart : le rejeu ne redonne pas le même calcul.'));
    place.appendChild(ul);
  }
  function result(box, calc, ctx) {
    var r = calc.result && typeof calc.result === 'object' ? calc.result : null;
    var out = el('section', null, 'bloc');
    out.appendChild(el('h4', 'Résultat du calcul'));
    out.appendChild(notice());
    box.appendChild(out);
    // Sans table d'espérance, ou un âge absent de la table, aucun chiffre n'est écrit [R541].
    if (!r || r.status !== 'complet') {
      var lacks = r && Array.isArray(r.missing) && r.missing.indexOf('expectancies') >= 0;
      out.appendChild(note(lacks ? NO_TABLE : 'Calcul incomplet : aucun chiffre n’est donné.'));
      return;
    }
    var bq = find(r, 'bouquet'), rent = find(r, 'monthlyRent'), months = find(r, 'months');
    if (bq && rent && months) out.appendChild(el('p', 'Bouquet ' + shown(bq) + ', puis ' + shown(rent) + ' par mois, sur ' + shown(months) + ' : une estimation.', 'etat'));
    out.appendChild(lines(r));
    if (!ID.test(str(calc.id))) return;
    var base = '/v1/viager/calculs/' + encodeURIComponent(calc.id);
    var place = el('div');
    var again = button('Rejouer le calcul', function () {
      if (again.disabled) return;
      again.disabled = true;
      clear(place);
      place.appendChild(note('Rejeu…'));
      send(base + '/rejeu', 'GET').then(function (x) {
        again.disabled = false;
        if (x.gone || ctx.mine !== load) return;
        var d = x.ok && x.body.data && typeof x.body.data === 'object' ? x.body.data : null;
        if (!d) { clear(place); place.appendChild(note(refusal(x, 'Le rejeu n’a pas pu se faire.'))); return; }
        replayed(place, r, d);
      });
    });
    out.appendChild(again);
    out.appendChild(place);
    out.appendChild(expert(base, ctx));
  }
  /** L'expert du viager, proposé par la mise en relation : jamais écrit à sa place, le vendeur choisit [R542]. */
  function expert(base, ctx) {
    var box = el('section', null, 'bloc');
    box.appendChild(el('h4', 'L’expert du viager'));
    box.appendChild(el('p', 'Le bouquet et la rente se fixent avec lui et le notaire. Un tirage au sort dans l’annuaire, montré au vendeur ; rien ne part d’ici.', 'doux'));
    var cp = CP.test(str(ctx.postcode)) ? null : field(box, 'viager-cp', 'Code postal du bien', 'numeric');
    if (cp) cp.setAttribute('maxlength', '5');
    var said = note('');
    var go = button('Proposer l’expert au vendeur', function () {
      if (go.disabled) return;
      var body = {};
      if (cp) {
        var c = String(cp.value).trim();
        if (!CP.test(c)) { said.textContent = REFUSALS.bad_postcode; return; }
        body.postcode = c;
      }
      go.disabled = true;
      said.textContent = 'Tirage…';
      send(base + '/expert', 'POST', body).then(function (x) {
        go.disabled = false;
        if (x.gone || ctx.mine !== load) return;
        if (x.offline || !x.body || x.status >= 500) { said.textContent = 'La réponse n’est pas arrivée : rien n’est sûr. Voyez l’écran Partenaires avant de recommencer.'; return; }
        said.textContent = x.ok ? EXPERT_DONE : refusal(x, 'L’expert n’a pas été proposé.');
      });
    });
    box.appendChild(go);
    box.appendChild(said);
    return box;
  }
  function form(p, b) {
    if (!root) return;
    var box = root, mine = ++load;
    clear(box);
    box.appendChild(button('Retour aux projets', function () { list(); }));
    box.appendChild(el('h4', 'Viager du bien ' + b.reference + (str(b.city) ? ', ' + b.city : '')));
    box.appendChild(notice());
    var ctx = { mine: mine, postcode: b.postcode };
    var f = {
      value: field(box, 'viager-valeur', 'Valeur libre du bien (€)', 'decimal'),
      valueWhy: field(box, 'viager-valeur-source', 'D’où vient cette valeur (avis de valeur, date…)'),
      form: (function () {
        var l = el('label', 'Forme du viager');
        l.setAttribute('for', 'viager-forme');
        var s = el('select');
        s.setAttribute('id', 'viager-forme');
        [['', 'Choisir…'], ['occupe', 'Occupé : le vendeur garde l’usage'], ['libre', 'Libre']].forEach(function (o) { var x = el('option', o[1]); x.value = o[0]; s.appendChild(x); });
        box.appendChild(l);
        box.appendChild(s);
        return s;
      })(),
      age1: field(box, 'viager-age-1', 'Âge du vendeur (ans)', 'numeric'),
      age2: field(box, 'viager-age-2', 'Âge de la seconde tête, s’il y en a une (ans)', 'numeric'),
      bouquet: field(box, 'viager-bouquet', 'Bouquet envisagé (€)', 'decimal'),
      bouquetWhy: field(box, 'viager-bouquet-source', 'D’où vient ce bouquet'),
      rate: field(box, 'viager-taux', 'Taux technique annuel (%)', 'decimal'),
      rateWhy: field(box, 'viager-taux-source', 'D’où vient ce taux'),
    };
    box.appendChild(el('p', 'L’espérance de vie ne se saisit pas : elle vient de la table importée par la direction.', 'doux'));
    var said = note('');
    var place = el('div');
    var go = button('Calculer', function () {
      if (go.disabled) return;
      var v = hundredths(f.value.value), bq = hundredths(f.bouquet.value), rt = hundredths(f.rate.value), a1 = age(f.age1.value);
      var a2text = String(f.age2.value).trim(), a2 = a2text ? age(a2text) : null;
      var why = [f.valueWhy, f.bouquetWhy, f.rateWhy].map(function (x) { return String(x.value).trim(); });
      if (v === null || bq === null || rt === null || a1 === null || (a2text && a2 === null) || !f.form.value || why.some(function (w) { return w.length < 3 || w.length > 200; })) { said.textContent = MISSING; return; }
      var occupied = f.form.value === 'occupe';
      var inputs = {
        marketValue: { value: v, hypothesis: why[0] },
        occupied: { value: occupied, hypothesis: occupied ? 'viager occupé, choisi à l’écran' : 'viager libre, choisi à l’écran' },
        headAges: { value: a2 === null ? [a1] : [a1, a2], hypothesis: 'âge révolu de chaque tête, saisi à l’écran' },
        bouquet: { value: bq, hypothesis: why[1] },
        annualRateBp: { value: rt, hypothesis: why[2] },
      };
      go.disabled = true;
      said.textContent = 'Calcul…';
      clear(place);
      send('/v1/viager/calculs', 'POST', { propertyId: b.propertyId, projectId: p.projectId, inputs: inputs }).then(function (x) {
        go.disabled = false;
        if (x.gone || mine !== load) return;
        if (x.offline || !x.body || x.status >= 500) { said.textContent = LOST; return; }
        var calc = x.ok && x.body.data && typeof x.body.data === 'object' ? x.body.data : null;
        if (!calc) { said.textContent = refusal(x, 'Le calcul n’a pas été fait.'); return; }
        said.textContent = 'Calcul rangé le ' + day(str(calc.createdAt).slice(0, 10)) + '.';
        result(place, calc, ctx);
      });
    });
    box.appendChild(go);
    box.appendChild(said);
    box.appendChild(place);
  }
  function list() {
    if (!root) return Promise.resolve(false);
    var box = root, mine = ++load;
    clear(box);
    box.appendChild(notice());
    var said = note('Chargement…');
    box.appendChild(said);
    return send('/v1/partenaires/projets' + (page ? '?page=' + page : ''), 'GET').then(function (x) {
      if (x.gone || box !== root || mine !== load) return false;
      var d = x.ok && x.body.data && typeof x.body.data === 'object' && Array.isArray(x.body.data.projects) ? x.body.data : null;
      if (!d) { said.textContent = refusal(x, 'Les projets ne se lisent pas pour le moment.'); return false; }
      var ul = el('ul', null, 'liste');
      d.projects.forEach(function (p) {
        if (!p || p.kind !== 'sell' || !ID.test(str(p.projectId))) return;
        var props = Array.isArray(p.properties) ? p.properties.filter(function (b) { return b && ID.test(str(b.propertyId)) && str(b.reference); }) : [];
        if (!props.length) return;
        var li = el('li');
        li.appendChild(el('strong', 'Vendre' + (str(p.firstName) ? ' · ' + p.firstName : '')));
        props.forEach(function (b) { li.appendChild(button('Viager du bien ' + b.reference + (str(b.city) ? ', ' + b.city : ''), function () { form(p, b); })); });
        ul.appendChild(li);
      });
      said.textContent = ul.children.length ? '' : NONE;
      if (ul.children.length) box.appendChild(ul);
      if (page > 0) box.appendChild(button('Projets précédents', function () { page--; list(); }));
      if (d.more === true) box.appendChild(button('Projets suivants', function () { page++; list(); }));
      return true;
    });
  }
  return { show: function (box) { root = box; return list(); } };
};
`;
