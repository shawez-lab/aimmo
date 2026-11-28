import { SITE_MENTION_FIELDS } from '../../core/src/attirer/mentions-site.ts';
import { FRANCE_BOXES } from '../../core/src/attirer/prix-versions.ts';
import type { FACT_KINDS, FACT_UNITS, NeighbourhoodProblem } from '../../core/src/attirer/quartier.ts';

/**
 * L'écran « Attirer » de la direction (AT12), en morceaux posés dans `fichiers.ts` : son entrée sur l'écran du réseau,
 * sa section de page, son chargeur, et son script servi à part (`/app/attirer.js`), chargé à la première ouverture pour
 * tenir le budget de l'application [R201].
 *
 * Sept parties : les agents, leurs mentions et leur site (AT16), les communes et quartiers qui portent les prix (AT15), la part des contacts dont l'origine est connue, mois par mois (AT05), les versions des prix publics
 * et leur recalcul (AT01), les pages de quartier, du fait sourcé au texte validé (AT07, AT13), les sites en service et
 * leur plan (AT04), et les statistiques du site de tout le réseau (BR43), dont le script `/app/site.js` (BR42) est servi
 * à part, chargé au geste, et ne lit que `/v1/site`. Sinon l'écran ne lit et n'écrit que par `/v1/attirer`
 * [R16] ; il ne calcule ni ne trie aucun chiffre, il montre ceux du serveur dans l'ordre reçu. Tout texte reçu est posé
 * avec `textContent`.
 */

/** Les raisons d'un refus, dites à la direction : jamais un code interne. */
const REFUSALS: Record<string, string> = {
  role: 'Ce n’est pas dans vos droits.',
  source_absente: 'La source des ventes publiques n’est pas branchée : aucun recalcul pour le moment.',
  bad_url: 'Saisissez l’adresse complète du site, sans chemin, par exemple https://www.exemple.fr.',
  url_taken: 'Cette adresse sert déjà un autre site : une seule page de référence par bien.',
  url_agent_parti: 'Cette adresse reste gardée par un agent parti : libérez-la dans « Agents, mentions et sites ».',
  bad_month: 'Choisissez un mois dans la liste.',
  rsac: 'Le numéro d’immatriculation n’est pas lisible : neuf chiffres, avec RSAC devant ou non.',
  greffe: 'Saisissez le greffe, 80 caractères au plus.',
  titulaire: 'Saisissez le nom du titulaire de la carte, 120 caractères au plus.',
  agent_parti: 'Cet agent n’est plus en activité : la liste a changé.',
  agent_inconnu: 'Cet agent n’est pas dans le réseau.',
  bad_agent: 'Cet agent n’est pas dans le réseau.',
  unknown_agent: 'Cet agent n’est pas dans le réseau.',
  slug: 'Ce nom ne donne pas d’adresse de page : saisissez-le en lettres latines.',
  nom: 'Saisissez le nom, 120 caractères au plus.',
  source: 'Saisissez la source du contour.',
  contour: 'Ce contour n’est pas lisible : il faut de 3 points au nombre admis, chacun avec sa latitude et sa longitude.',
  insee: 'Le code INSEE a 5 caractères, par exemple 21231.',
  parent: 'Choisissez une commune en service.',
  slug_pris: 'Ce nom est déjà pris dans la liste.',
  hors_france: 'Ces points ne tombent pas en France : latitude et longitude sont peut-être inversées.',
  contour_croise: 'Ce contour se croise ou se touche lui-même : on ne saurait pas quelles ventes il contient. Vérifiez l’ordre des points.',
  hors_commune: 'Ce quartier sort de sa commune : vérifiez le contour et la commune choisie.',
  invalid_body: 'Ce contour est trop long : 2 000 points au plus.',
  chevauchement: 'Ce contour recouvre une zone déjà en service : les mêmes ventes compteraient deux fois.',
  zone: 'Introuvable : la liste a changé.',
  zone_inconnue: 'Ce quartier n’est plus en service : la liste a changé.',
  inconnu: 'Introuvable : la liste a changé.',
  invalide: 'Vérifiez les champs : un titre de 2 à 160 caractères ; un libellé et une source sans adresse, nom de client ni chiffre caché ; une date qui n’est pas dans le futur.',
  sans_donnees: 'Aucune donnée pour ce sujet : ni fait rangé pour le quartier, ni prix publié pour un article sur les prix.',
  deja_valide: 'Ce texte est déjà validé.',
  donnees_changees: 'Les données ont changé depuis ce texte : préparez-en un nouveau.',
  texte_refuse: 'Ce texte ne passe pas le contrôle : rien n’est enregistré.',
};

/** Pourquoi un recalcul n'a rien produit : ce n'est pas une erreur, c'est dit tel quel. */
const NOT_RUN: Record<string, string> = {
  dvf_non_couvert: 'Les ventes publiques ne couvrent pas ce département : aucun prix calculé.',
  aucune_zone: 'Aucune commune n’est définie : aucun prix à calculer.',
  deja_fait: 'Cette publication des ventes est déjà calculée : rien de nouveau.',
  source_incomplete: 'La lecture des ventes publiques est incomplète : les prix en ligne ne changent pas.',
};

const ORIGIN_LABELS: Record<string, string> = {
  bien: 'Page d’un bien',
  prix: 'Page de prix',
  agent: 'Page d’un agent',
  video: 'Vidéo',
  publication: 'Publication',
  quartier: 'Page de quartier',
  simulateur: 'Simulateur de prêt',
  portail: 'Portail',
  inconnue: 'Origine inconnue',
};

const FACT_KIND_LABELS: Record<(typeof FACT_KINDS)[number], string> = {
  transport: 'Transport',
  ecole: 'École',
  commerce: 'Commerce',
  marche: 'Marché',
  parc: 'Parc',
  sport: 'Sport',
  sante: 'Santé',
  culture: 'Culture',
  population: 'Population',
  autre: 'Autre',
};
const FACT_UNIT_LABELS: Record<(typeof FACT_UNITS)[number], string> = { nombre: 'Nombre', m: 'Mètres', km: 'Kilomètres', minutes: 'Minutes', habitants: 'Habitants', pourcent: 'Pour cent' };
const ORIGIN_TEXT_LABELS = { ia: 'Préparé par l’IA', secours: 'Préparé sans IA', redaction: 'Écrit par la direction' };
/** Pourquoi une phrase ne peut pas être publiée [R155, R46]. */
const PROBLEM_LABELS: Record<NeighbourhoodProblem['code'], string> = {
  nombre_sans_source: 'chiffre sans source',
  fait_sans_source: 'fait sans source',
  jugement: 'jugement de valeur',
  nom_client: 'nom d’un client',
  adresse: 'adresse',
  critere_discriminant: 'critère discriminant',
  mot_interdit: 'mot interdit',
};
/** Ce que la direction peut faire préparer : les seuls couples admis par le métier. */
const TEXT_CHOICES = { 'page/quartier': 'La page du quartier', 'article/prix': 'L’article sur les prix', 'article/equipements': 'L’article sur les équipements' };

/** Pourquoi la page d'un agent n'est pas publiée [R152]. */
const MISSING_LABELS: Record<string, string> = {
  statut_manquant: 'Page non publiée : son immatriculation manque.',
  carte_manquante: 'Page non publiée : le numéro de carte professionnelle du réseau manque.',
  titulaire_manquant: 'Page non publiée : le titulaire de la carte manque.',
};

const SITEMAP_LABELS: Record<string, string> = { bien: 'Bien', agent: 'Agent', prix: 'Prix' };

export const ATTIRER_ENTRY_HTML = `<section class="bloc" aria-labelledby="titre-attirer-reseau">
<h3 id="titre-attirer-reseau">Attirer</h3>
<p class="doux">Prix publics, sites en service et origine des contacts.</p>
<button id="attirer-ouvrir" type="button" class="secondaire">Ouvrir</button>
</section>
`;

export const ATTIRER_HTML = `<section id="attirer" hidden>
<button id="attirer-retour" type="button" class="retour">Retour au réseau</button>
<h2 id="attirer-titre">Attirer</h2>
<p class="doux">Chaque chiffre vient de la base. En essai, rien n’est signalé aux moteurs de recherche.</p>
<p id="attirer-etat" class="etat" role="status"></p>
<div id="attirer-corps"></div>
</section>
`;

/** Le chargeur posé dans le script de l'application : l'écran est servi à part, chargé une fois, jamais gardé. */
export const ATTIRER_JS = `
  /* ---------- M01 : l'écran « Attirer » de la direction (AT12), chargé à la demande [R16, R201]. ---------- */
  var attirerScreen = null;
  function wipeAttirer() {
    if (attirerScreen) { attirerScreen.wipe(); return; }
    clear($('attirer-corps'));
    $('attirer-etat').textContent = '';
  }
  function openAttirer() {
    if (!currentKey) return Promise.resolve(false);
    if (attirerScreen) return attirerScreen.open('');
    session += 1;
    var mine = session;
    wipeAttirer();
    show('attirer');
    $('attirer-etat').textContent = 'Chargement…';
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.setAttribute('src', '/app/attirer.js');
      s.addEventListener('load', function () {
        var make = globalThis.AIMMO_ATTIRER;
        try { delete globalThis.AIMMO_ATTIRER; } catch (e) { /* rien */ }
        if (mine !== session || typeof make !== 'function') { resolve(false); return; }
        attirerScreen = make({ $: $, el: el, clear: clear, send: send, show: show, button: button, field: field, select: select, details: details, date: date, openGoogle: openGoogle, key: function () { return currentKey; }, session: function () { return session; }, next: function () { session += 1; return session; } });
        resolve(attirerScreen.open(''));
      });
      s.addEventListener('error', function () {
        if (mine === session) $('attirer-etat').textContent = 'Pas de réseau. Réessayez dans un moment.';
        resolve(false);
      });
      $('attirer').appendChild(s);
    });
  }
`;

/**
 * Le script de l'écran, servi à part (`/app/attirer.js`). Il reçoit les outils de l'application, ne lit et n'écrit que
 * par `/v1/attirer` [R16], et ne garde aucune donnée.
 */
export const ATTIRER_SCRIPT = `'use strict';
globalThis.AIMMO_ATTIRER = function (t) {
  var $ = t.$, el = t.el, clear = t.clear, send = t.send, show = t.show, button = t.button, field = t.field, select = t.select, details = t.details, date = t.date;
  var REFUSALS = ${JSON.stringify(REFUSALS)};
  var NOT_RUN = ${JSON.stringify(NOT_RUN)};
  var ORIGINS = ${JSON.stringify(ORIGIN_LABELS)};
  var SITEMAP = ${JSON.stringify(SITEMAP_LABELS)};
  var FACT_KINDS = ${JSON.stringify(FACT_KIND_LABELS)};
  var FACT_UNITS = ${JSON.stringify(FACT_UNIT_LABELS)};
  var TEXT_ORIGINS = ${JSON.stringify(ORIGIN_TEXT_LABELS)};
  var PROBLEMS = ${JSON.stringify(PROBLEM_LABELS)};
  var TEXT_CHOICES = ${JSON.stringify(TEXT_CHOICES)};
  var MISSING = ${JSON.stringify(MISSING_LABELS)};
  var FRANCE = ${JSON.stringify(FRANCE_BOXES)};
  var MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  var chosenMonth = null, busy = false, inside = false;
  function state(text) { $('attirer-etat').textContent = text; }
  function refusal(res, fallback) {
    if (res.offline) return 'La réponse n’est pas arrivée : rien n’est sûr. Relisez avant de recommencer.';
    return (res.body && REFUSALS[res.body.code]) || fallback;
  }
  function wipe() {
    clear($('attirer-corps'));
    state('');
    chosenMonth = null;
    inside = false;
  }
  function part(title) {
    var box = el('section', null, 'bloc');
    box.appendChild(el('h3', title));
    return box;
  }
  function missing(box, res) {
    box.appendChild(el('p', res.offline ? 'Pas de réseau pour cette partie.' : refusal(res, 'Indisponible pour le moment.'), 'etat'));
    return box;
  }
  function list(res) { return res.ok && Array.isArray(res.body.data) ? res.body.data : null; }
  /* Un geste à la fois, même si l'écran est rouvert entre-temps : seul le geste en cours libère le verrou. */
  function once(work) {
    if (busy) return Promise.resolve(false);
    busy = true;
    return work().then(function (r) { busy = false; return r; }, function () { busy = false; return false; });
  }
  /* Les douze derniers mois, heure de Paris : le plus récent d'abord. */
  function lastMonths() {
    var parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit' }).format(new Date()).split('-');
    var y = Number(parts[0]), m = Number(parts[1]), out = [];
    for (var i = 0; i < 12; i++) {
      out.push({ value: y + '-' + (m < 10 ? '0' : '') + m, label: MONTHS[m - 1] + ' ' + y });
      m -= 1;
      if (m === 0) { m = 12; y -= 1; }
    }
    return out;
  }
  function open(message) {
    if (!t.key()) return Promise.resolve(false);
    var mine = t.next();
    var month = chosenMonth || lastMonths()[0].value;
    wipe();
    legalOpen = false;
    chosenMonth = month;
    show('attirer');
    state('Chargement…');
    return Promise.all([send('/v1/attirer/prix/versions', 'GET'), send('/v1/attirer/sites', 'GET'), send('/v1/attirer/origine/' + month, 'GET'), send('/v1/attirer/quartiers', 'GET'), send('/v1/attirer/prix/zones', 'GET'), send('/v1/attirer/agents', 'GET'), send('/v1/attirer/prix/zones/a-refaire', 'GET')]).then(function (all) {
      if (mine !== t.session() || all.some(function (r) { return r.gone; })) return false;
      if (all.every(function (r) { return r.offline; })) { state('Pas de réseau. Réessayez dans un moment.'); return false; }
      var body = $('attirer-corps');
      body.appendChild(renderOrigin(all[2], month));
      body.appendChild(renderPrices(all[0]));
      body.appendChild(renderQuarters(all[3]));
      body.appendChild(renderZones(all[4], all[6]));
      body.appendChild(renderSites(all[1]));
      body.appendChild(renderSiteStats());
      body.appendChild(renderPublicite());
      body.appendChild(renderLettre());
      body.appendChild(renderAgents(all[5]));
      state(message || '');
      return true;
    });
  }

  /* AT05 · la part des contacts dont l'origine est connue, contre la cible. */
  function renderOrigin(res, month) {
    var box = part('Origine des contacts');
    var options = {};
    lastMonths().forEach(function (o) { options[o.value] = o.label; });
    var f = select(box, 'attirer-mois', 'Mois', options, month);
    f.addEventListener('change', function () { chosenMonth = f.value; open(''); });
    var m = res.ok ? res.body.data : null;
    if (!m) return missing(box, res);
    if (m.contacts === 0) { box.appendChild(el('p', 'Aucun contact ce mois-là.', 'doux')); return box; }
    box.appendChild(el('p', String(m.percent).replace('.', ',') + ' % des contacts ont leur origine connue', 'preuve-taux'));
    var bar = el('progress', null, 'jauge');
    bar.setAttribute('max', '100');
    bar.setAttribute('value', String(m.percent));
    bar.setAttribute('aria-label', 'Part des contacts dont l’origine est connue');
    box.appendChild(bar);
    box.appendChild(el('p', m.withOrigin + ' sur ' + m.contacts + ' contacts. Cible : ' + m.targetPercent + ' %, ' + (m.meetsTarget ? 'tenue.' : 'pas encore tenue.'), 'doux'));
    var kinds = el('ul', null, 'liste');
    (m.byKind || []).forEach(function (k) { kinds.appendChild(el('li', (ORIGINS[k.kind] || 'Autre') + ' : ' + k.contacts)); });
    box.appendChild(kinds);
    if ((m.byContent || []).length) {
      box.appendChild(el('h4', 'Les contenus qui ont amené des contacts'));
      var contents = el('ul', null, 'liste');
      m.byContent.forEach(function (c) { contents.appendChild(el('li', (ORIGINS[c.kind] || 'Contenu') + ' ' + c.title + ' : ' + c.contacts)); });
      box.appendChild(contents);
    }
    return box;
  }

  /* AT01 · les versions des prix publics, et le recalcul. */
  function recompute() {
    return once(function () {
      state('Recalcul…');
      return send('/v1/attirer/prix/recalcul', 'POST').then(function (x) {
        if (x.gone) return false;
        if (!x.ok) { state(refusal(x, 'Le recalcul n’a pas abouti : les prix en ligne ne changent pas.')); return false; }
        var r = x.body.data;
        if (!r.ran) { state(NOT_RUN[r.reason] || 'Rien de nouveau.'); return false; }
        return open('Nouvelle version : ' + r.published + ' prix publiés, ' + r.carried + ' repris de la version d’avant, ' + r.held + ' retenus.');
      });
    });
  }
  function renderPrices(res) {
    var box = part('Prix publics');
    var items = list(res);
    if (!items) return missing(box, res);
    if (!items.length) box.appendChild(el('p', 'Aucune version calculée pour le moment.', 'doux'));
    var ul = el('ul', null, 'liste');
    items.forEach(function (v) {
      var li = el('li');
      li.appendChild(el('strong', 'Calculée le ' + date(v.completedAt)));
      li.appendChild(el('p', v.source + ', ventes jusqu’au ' + date(v.dvfLastSale), 'doux'));
      ul.appendChild(li);
    });
    box.appendChild(ul);
    box.appendChild(quiet(button('Recalculer les prix', recompute)));
    return box;
  }

  /*
   * AT15 · un contour collé : du GeoJSON (longitude puis latitude, retournées ici), ou une ligne « latitude, longitude »
   * par point. Plusieurs morceaux ou une enclave : à la direction de trancher, en le disant dans la source ; en garder un
   * seul ici changerait les ventes comptées sans le dire. Rend { points } ou { problem }.
   */
  var UNREADABLE = { problem: 'Ce contour n’est pas lisible : en GeoJSON, ou une ligne « latitude, longitude » par point, 3 points au moins.' };
  function polygonOf(g) {
    if (g && g.type === 'FeatureCollection' && Array.isArray(g.features) && g.features.length === 1) g = g.features[0];
    if (g && g.type === 'FeatureCollection' && Array.isArray(g.features)) return { pieces: g.features.length };
    if (g && g.type === 'Feature') g = g.geometry;
    if (g && g.type === 'MultiPolygon' && Array.isArray(g.coordinates)) {
      if (g.coordinates.length !== 1) return { pieces: g.coordinates.length };
      return { rings: g.coordinates[0] };
    }
    if (g && g.type === 'Polygon') return { rings: g.coordinates };
    return null;
  }
  function ringOf(text) {
    var raw = text.trim();
    var points = null;
    if (raw.charAt(0) === '{' || raw.charAt(0) === '[') {
      var g;
      try { g = JSON.parse(raw); } catch (e) { return UNREADABLE; }
      var found = polygonOf(g);
      if (!found) return UNREADABLE;
      if (found.pieces) return { problem: 'Ce contour a ' + found.pieces + ' morceaux : collez-en un seul, le principal, et dites-le dans la source.' };
      if (!Array.isArray(found.rings) || !Array.isArray(found.rings[0])) return UNREADABLE;
      if (found.rings.length > 1) return { problem: 'Ce contour contient une enclave : collez-le sans elle, et dites-le dans la source.' };
      points = [];
      for (var i = 0; i < found.rings[0].length; i++) {
        var c = found.rings[0][i];
        if (!Array.isArray(c) || c.length < 2) return UNREADABLE;
        points.push([c[1], c[0]]);
      }
    } else {
      points = raw.split('\\n').filter(function (l) { return l.trim() !== ''; }).map(function (l) {
        var p = l.split(/[,;\\s]+/).filter(function (x) { return x !== ''; });
        return p.length === 2 ? [Number(p[0]), Number(p[1])] : [NaN, NaN];
      });
    }
    if (points.some(function (p) { return typeof p[0] !== 'number' || typeof p[1] !== 'number' || !isFinite(p[0]) || !isFinite(p[1]); })) return UNREADABLE;
    /* Un contour fermé répète son premier point : le métier le ferme lui-même. */
    if (points.length > 1 && points[0][0] === points[points.length - 1][0] && points[0][1] === points[points.length - 1][1]) points.pop();
    if (points.length < 3) return UNREADABLE;
    if (points.length > 2000) return { problem: 'Ce contour a ' + points.length + ' points : 2 000 au plus.' };
    var inside = FRANCE.some(function (b) { return points.every(function (p) { return p[0] >= b[0] && p[0] <= b[1] && p[1] >= b[2] && p[1] <= b[3]; }); });
    if (!inside) return { problem: REFUSALS.hors_france };
    /* Six décimales, une dizaine de centimètres : assez pour un contour, et le corps reste dans sa limite. */
    return { points: points.map(function (p) { return [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6]; }) };
  }
  /* L'adresse publique d'une zone : elle ne se réécrit jamais, donc aucun mot abîmé. */
  function slugOf(name) {
    return factKey(name.toLowerCase().replace(/œ/g, 'oe').replace(/æ/g, 'ae'));
  }
  function saveZone(input, okText) {
    return once(function () {
      state('Envoi…');
      return send('/v1/attirer/prix/zones', 'POST', input).then(function (x) {
        if (x.gone) return false;
        if (!x.ok) { state(refusal(x, 'La zone n’est pas enregistrée. Un contour très long doit être simplifié.')); return false; }
        return open(okText);
      });
    });
  }
  function zoneForm(box, id, title, isCommune, communes) {
    var form = details(box, title);
    var parent = isCommune ? null : (function () {
      var options = {};
      communes.forEach(function (c) { options[c.id] = c.name; });
      return select(form, id + '-commune', 'Commune', options, communes[0].id);
    })();
    var name = field(form, id + '-nom', isCommune ? 'Nom de la commune' : 'Nom du quartier');
    var insee = isCommune ? field(form, id + '-insee', 'Code INSEE') : null;
    var ring = field(form, id + '-contour', 'Contour : GeoJSON, ou une ligne « latitude, longitude » par point', 'textarea');
    var source = field(form, id + '-source', 'Source du contour');
    form.appendChild(button('Ajouter', function () {
      var slug = slugOf(name.value);
      if (!slug) { state('Saisissez le nom, avec au moins une lettre latine ou un chiffre.'); return; }
      var read = ringOf(ring.value);
      if (read.problem) { state(read.problem); return; }
      var input = { level: isCommune ? 'commune' : 'quartier', slug: slug, name: name.value, ring: read.points, ringSource: source.value };
      if (isCommune) input.inseeCode = insee.value.trim(); else input.parentId = parent.value;
      saveZone(input, (isCommune ? 'Commune' : 'Quartier') + ' ajouté' + (isCommune ? 'e' : '') + '. Les prix suivront au prochain calcul.');
    }));
  }
  function zoneLine(z, warning, redraw) {
    var li = el('li');
    li.appendChild(el('strong', z.name));
    if (redraw[z.id]) li.appendChild(el('p', 'Contour à refaire : mise de côté du calcul. Retirez-la, puis retracez-la.', 'etat'));
    li.appendChild(quiet(confirmed('Retirer', warning, function () {
      once(function () {
        state('Envoi…');
        return send('/v1/attirer/prix/zones/' + encodeURIComponent(z.id) + '/retrait', 'POST').then(function (x) {
          if (x.gone) return false;
          if (!x.ok) { state(refusal(x, 'La zone reste en service.')); return false; }
          return open('« ' + z.name + ' » a quitté le site et les prochains calculs.');
        });
      });
    })));
    return li;
  }
  /*
   * BR97 · les zones rangées avant le contrôle des contours, mises de côté du calcul (RC60) : dites en tête, puis marquées
   * dans la liste. Une lecture en échec ne dit jamais « aucune » [R10].
   */
  var LEVELS = { commune: 'commune', quartier: 'quartier' };
  function renderRedraw(box, res) {
    var todo = list(res);
    if (!todo) {
      box.appendChild(el('p', 'Liste des zones à refaire non lue. ' + (res.offline ? 'Pas de réseau.' : refusal(res, 'Indisponible pour le moment.')), 'etat'));
      return {};
    }
    var marked = {};
    if (!todo.length) return marked;
    box.appendChild(el('p', todo.length === 1 ? '1 zone mise de côté du dernier calcul : son contour se touche lui-même, ses prix ne sont pas publiés.' : todo.length + ' zones mises de côté du dernier calcul : leur contour se touche lui-même, leurs prix ne sont pas publiés.', 'etat'));
    var ul = el('ul', null, 'liste');
    todo.forEach(function (z) {
      marked[z.id] = true;
      ul.appendChild(el('li', z.name + ' (' + (LEVELS[z.level] || 'zone') + ')' + (z.level === 'commune' ? ', avec ses quartiers' : '') + ' : retirez-la, puis retracez-la.'));
    });
    box.appendChild(ul);
    return marked;
  }
  function renderZones(res, redrawRes) {
    var box = part('Communes et quartiers des prix');
    var items = list(res);
    if (!items) return missing(box, res);
    var redraw = renderRedraw(box, redrawRes);
    var communes = items.filter(function (z) { return z.level === 'commune'; });
    if (!communes.length) box.appendChild(el('p', 'Aucune commune : aucun prix ne peut être calculé.', 'doux'));
    var ul = el('ul', null, 'liste');
    communes.forEach(function (c) {
      var li = zoneLine(c, 'La commune et ses quartiers quitteront le site : prix et pages de quartier. Appuyez de nouveau pour confirmer.', redraw);
      var inner = el('ul', null, 'liste');
      items.forEach(function (q) { if (q.parentId === c.id) inner.appendChild(zoneLine(q, 'Ce quartier quittera le site : ses prix et sa page. Appuyez de nouveau pour confirmer.', redraw)); });
      li.appendChild(inner);
      ul.appendChild(li);
    });
    box.appendChild(ul);
    zoneForm(box, 'attirer-zc', 'Ajouter une commune', true, communes);
    if (communes.length) zoneForm(box, 'attirer-zq', 'Ajouter un quartier', false, communes);
    return box;
  }

  /* AT16 · une écriture sur les agents : un geste à la fois, puis l'écran relu. */
  function agentWrite(path, payload, okText, failText) {
    return once(function () {
      state('Envoi…');
      return send(path, 'POST', payload).then(function (x) {
        if (x.gone) return false;
        if (!x.ok) { state(refusal(x, failText)); return false; }
        return open(okText);
      });
    });
  }
  function agentLine(a, i) {
    var li = el('li');
    li.appendChild(el('strong', a.name));
    li.appendChild(el('p', a.missing ? (MISSING[a.missing] || 'Page non publiée.') : 'Mentions complètes : sa page peut être servie.', a.missing ? 'etat' : 'doux'));
    var marks = details(li, 'Immatriculation');
    var rsac = field(marks, 'attirer-a-rsac-' + i, 'Numéro RSAC');
    rsac.value = a.rsacNumber || '';
    var registry = field(marks, 'attirer-a-greffe-' + i, 'Greffe');
    registry.value = a.rsacRegistry || '';
    marks.appendChild(button('Enregistrer l’immatriculation', function () {
      agentWrite('/v1/attirer/agents/' + encodeURIComponent(a.agentId) + '/mentions', { rsacNumber: rsac.value, rsacRegistry: registry.value }, 'Immatriculation enregistrée.', 'L’immatriculation n’est pas enregistrée.');
    }));
    var site = a.site;
    li.appendChild(el('p', !site ? 'Pas de site : ses biens sont sur le site du réseau.' : site.active ? 'Site en service : ' + site.baseUrl : 'Site hors service : ' + site.baseUrl, 'doux'));
    function setSite(baseUrl, active, okText) {
      agentWrite('/v1/attirer/sites', { kind: 'agent', agentId: a.agentId, baseUrl: baseUrl, active: active }, okText, 'Le site n’est pas enregistré.');
    }
    if (site && site.active) li.appendChild(quiet(confirmed('Mettre hors service', SITE_WARNING, function () { setSite(site.baseUrl, false, 'Site mis hors service.'); })));
    if (site && !site.active) li.appendChild(quiet(button('Remettre en service', function () { setSite(site.baseUrl, true, 'Site remis en service.'); })));
    var form = details(li, site ? 'Changer l’adresse du site' : 'Ajouter un site');
    var url = field(form, 'attirer-a-site-' + i, 'Adresse du site');
    url.setAttribute('type', 'url');
    url.setAttribute('inputmode', 'url');
    function putOn() { setSite(url.value.trim(), true, 'Site mis en service.'); }
    form.appendChild(site && site.active ? confirmed('Changer l’adresse', SITE_WARNING, putOn) : button('Mettre en service', putOn));
    li.appendChild(quiet(button('Fiche Google de cet agent', function () { t.openGoogle(a.agentId); })));
    return li;
  }
  /* RS05 · les mentions du site : ce qui manque se voit, et le site reste en essai tant que c'est le cas. */
  var LEGAL_LABELS = ${JSON.stringify(SITE_MENTION_FIELDS)};
  var legalOpen = false;
  function openLegal() {
    if (legalOpen) return;
    legalOpen = true;
    var mine = t.session();
    var box = part('Mentions légales du site');
    state('Chargement…');
    send('/v1/attirer/mentions-site', 'GET').then(function (x) {
      if (x.gone || mine !== t.session()) return;
      state('');
      $('attirer-corps').appendChild(box);
      if (!x.ok || !x.body.data) return missing(box, x);
      var data = x.body.data;
      box.appendChild(el('p', data.missing.length ? 'Il manque ' + data.missing.length + ' mention(s) : le site reste en essai. Manquent : ' + data.missing.join(', ') + '.' : 'Toutes les mentions sont réglées.', 'doux'));
      var inputs = {};
      Object.keys(LEGAL_LABELS).forEach(function (k) {
        inputs[k] = field(box, 'mention-' + k, LEGAL_LABELS[k]);
        inputs[k].value = data.values[k] || '';
      });
      box.appendChild(button('Enregistrer les mentions', function () {
        var payload = {};
        Object.keys(inputs).forEach(function (k) { if (inputs[k].value.trim() !== (data.values[k] || '')) payload[k] = inputs[k].value; });
        if (!Object.keys(payload).length) { state('Rien à enregistrer.'); return; }
        agentWrite('/v1/attirer/mentions-site', payload, 'Mentions enregistrées.', 'Les mentions ne sont pas enregistrées.');
      }));
    });
  }
  /* BR43 · les statistiques du site de tout le réseau : le script de « Mon site » (BR42), en mode réseau [R201, R286]. */
  var statsScreen = null;
  function renderSiteStats() {
    var box = part('Statistiques du site');
    box.appendChild(el('p', 'Pour tout le réseau : quelle page amène des vendeurs, prouvé par leurs messages, et la prochaine page à écrire.', 'doux'));
    var inner = el('div');
    var b = button('Ouvrir les statistiques', function () {
      if (b.disabled) return;
      if (statsScreen) { statsScreen.show(inner); return; }
      b.disabled = true;
      var mine = t.session();
      var s = el('script');
      s.setAttribute('src', '/app/site.js');
      s.addEventListener('load', function () {
        var make = globalThis.AIMMO_SITE;
        try { delete globalThis.AIMMO_SITE; } catch (e) { /* rien */ }
        b.disabled = false;
        if (mine !== t.session() || typeof make !== 'function') return;
        statsScreen = make({ el: el, clear: clear, send: send, button: button, scope: 'reseau' });
        statsScreen.show(inner);
      });
      s.addEventListener('error', function () { b.disabled = false; if (mine === t.session()) { clear(inner); inner.appendChild(el('p', 'Pas de réseau. Réessayez dans un moment.', 'etat')); } });
      box.appendChild(s);
    });
    box.appendChild(quiet(b));
    box.appendChild(inner);
    return box;
  }
  /* BR110 · la publicité payante : script servi à part (/app/publicite.js), chargé au premier geste [R201, R587]. */
  var pubScreen = null;
  function renderPublicite() {
    var box = part('Publicité payante');
    box.appendChild(el('p', 'Chaque campagne jugée aux mandats signés et aux actes de ses contacts. Ciblage par communes et rayon seulement ; rien ne se dépense sans vos budgets validés.', 'doux'));
    var inner = el('div');
    var b = button('Ouvrir la publicité payante', function () {
      if (b.disabled) return;
      if (pubScreen) { pubScreen.show(inner); return; }
      b.disabled = true;
      var mine = t.session();
      var s = el('script');
      s.setAttribute('src', '/app/publicite.js');
      s.addEventListener('load', function () {
        var make = globalThis.AIMMO_PUBLICITE;
        try { delete globalThis.AIMMO_PUBLICITE; } catch (e) { /* rien */ }
        b.disabled = false;
        if (mine !== t.session()) return;
        if (typeof make !== 'function') { clear(inner); inner.appendChild(el('p', 'Indisponible pour le moment. Réessayez dans un moment.', 'etat')); return; }
        pubScreen = make({ el: el, clear: clear, send: send, button: button, field: field, session: t.session });
        pubScreen.show(inner);
      });
      s.addEventListener('error', function () { b.disabled = false; if (mine === t.session()) { clear(inner); inner.appendChild(el('p', 'Pas de réseau. Réessayez dans un moment.', 'etat')); } });
      box.appendChild(s);
    });
    box.appendChild(quiet(b));
    box.appendChild(inner);
    return box;
  }
  /* BR111 · la lettre et le magazine : script servi à part (/app/lettre.js), chargé au premier geste [R201, R586]. */
  var lettreScreen = null;
  function renderLettre() {
    var box = part('Lettre et magazine');
    box.appendChild(el('p', 'Ouvrir une édition de la lettre et tirer le magazine imprimable des biens. Rien ne part d’ici.', 'doux'));
    var inner = el('div');
    var b = button('Ouvrir la lettre et le magazine', function () {
      if (b.disabled) return;
      if (lettreScreen) { lettreScreen.show(inner); return; }
      b.disabled = true;
      var mine = t.session();
      var s = el('script');
      s.setAttribute('src', '/app/lettre.js');
      s.addEventListener('load', function () {
        var make = globalThis.AIMMO_LETTRE;
        try { delete globalThis.AIMMO_LETTRE; } catch (e) { /* rien */ }
        b.disabled = false;
        if (mine !== t.session()) return;
        if (typeof make !== 'function') { clear(inner); inner.appendChild(el('p', 'Indisponible pour le moment. Réessayez dans un moment.', 'etat')); return; }
        lettreScreen = make({ el: el, clear: clear, send: send, button: button, field: field, key: t.key, session: t.session });
        lettreScreen.show(inner);
      });
      s.addEventListener('error', function () { b.disabled = false; if (mine === t.session()) { clear(inner); inner.appendChild(el('p', 'Pas de réseau. Réessayez dans un moment.', 'etat')); } });
      box.appendChild(s);
    });
    box.appendChild(quiet(b));
    box.appendChild(inner);
    return box;
  }
  function renderAgents(res) {
    var box = part('Agents, mentions et sites');
    var data = res.ok ? res.body.data : null;
    if (!data) return missing(box, res);
    var holder = field(box, 'attirer-titulaire', 'Titulaire de la carte professionnelle');
    holder.value = data.holder || '';
    box.appendChild(quiet(button('Enregistrer le titulaire', function () {
      agentWrite('/v1/attirer/titulaire', { holder: holder.value }, 'Titulaire enregistré.', 'Le titulaire n’est pas enregistré.');
    })));
    box.appendChild(quiet(button('Mentions légales du site', function () { openLegal(); })));
    box.appendChild(el('p', data.cardNumber ? 'Carte professionnelle : ' + data.cardNumber : 'Numéro de carte professionnelle du réseau : pas encore réglé.', 'doux'));
    if (!data.agents.length) box.appendChild(el('p', 'Aucun agent en activité.', 'doux'));
    var ul = el('ul', null, 'liste');
    data.agents.forEach(function (a, i) { ul.appendChild(agentLine(a, i)); });
    box.appendChild(ul);
    /* AT17 · une adresse gardée par un agent parti : plus servie, mais aucun autre site ne peut la prendre. */
    var kept = data.departed || [];
    if (kept.length) {
      box.appendChild(el('h3', 'Adresses gardées par un agent parti'));
      var left = el('ul', null, 'liste');
      kept.forEach(function (d) {
        var li = el('li');
        li.appendChild(el('strong', d.name));
        li.appendChild(el('p', 'N’est plus en activité. Son site n’est plus servi, son adresse reste prise : ' + d.baseUrl, 'doux'));
        li.appendChild(confirmed('Libérer l’adresse', 'Un autre site pourra prendre cette adresse. Appuyez de nouveau pour confirmer.', function () {
          agentWrite('/v1/attirer/sites', { kind: 'agent', agentId: d.agentId, baseUrl: d.baseUrl, active: false }, 'Adresse libérée.', 'L’adresse n’est pas libérée.');
        }));
        left.appendChild(li);
      });
      box.appendChild(left);
    }
    return box;
  }

  /* AT13 · les quartiers : l'écran n'a aucun identifiant à faire saisir. */
  function renderQuarters(res) {
    var box = part('Pages de quartier');
    var items = list(res);
    if (!items) return missing(box, res);
    if (!items.length) box.appendChild(el('p', 'Aucun quartier défini pour le moment.', 'doux'));
    var ul = el('ul', null, 'liste');
    items.forEach(function (z) {
      var li = el('li');
      li.appendChild(el('strong', z.name));
      li.appendChild(el('p', z.communeName, 'doux'));
      li.appendChild(quiet(button('Ouvrir', function () { openQuarter(z, ''); })));
      ul.appendChild(li);
    });
    box.appendChild(ul);
    return box;
  }
  var STALE = { donnees_changees: true, deja_valide: true, inconnu: true };
  function quarterPath(z, end) { return '/v1/attirer/quartiers/' + encodeURIComponent(z.zoneId) + end; }
  function openQuarter(z, message) {
    var mine = t.next();
    var month = chosenMonth;
    wipe();
    chosenMonth = month;
    inside = true;
    show('attirer');
    state('Chargement…');
    return Promise.all([send(quarterPath(z, '/faits'), 'GET'), send(quarterPath(z, '/textes'), 'GET')]).then(function (all) {
      if (mine !== t.session() || all.some(function (r) { return r.gone; })) return false;
      if (all.every(function (r) { return r.offline; })) { state('Pas de réseau. Réessayez dans un moment.'); return false; }
      var body = $('attirer-corps');
      body.appendChild(el('h3', z.name + ', ' + z.communeName));
      body.appendChild(renderTexts(z, all[1]));
      body.appendChild(renderFacts(z, all[0]));
      state(message || '');
      return true;
    });
  }
  /* Une écriture sur le quartier : un geste à la fois, puis l'écran relu tel que le serveur le dit. */
  function quarterWrite(z, path, payload, okText, failText) {
    return once(function () {
      state('Envoi…');
      return send(path, 'POST', payload).then(function (x) {
        if (x.gone) return false;
        if (!x.ok) {
          /* L'écran dit quelque chose de dépassé : il est relu, pour ne pas laisser un geste que le serveur refusera toujours. */
          if (x.body && STALE[x.body.code]) return openQuarter(z, textRefusal(x, failText));
          state(textRefusal(x, failText));
          return false;
        }
        return openQuarter(z, okText);
      });
    });
  }
  /* Le refus d'un texte nomme chaque passage en cause : c'est ce que la direction doit changer. */
  function textRefusal(x, fallback) {
    var base = refusal(x, fallback);
    var problems = x.body && Array.isArray(x.body.problems) ? x.body.problems : [];
    if (!problems.length) return base;
    return base + ' ' + problems.slice(0, 5).map(function (p) { return '« ' + p.value + ' » : ' + (PROBLEMS[p.code] || 'à retirer') + '.'; }).join(' ');
  }
  function renderText(z, d, i) {
    var li = el('li');
    li.appendChild(el('strong', d.title));
    li.appendChild(el('p', TEXT_CHOICES[d.kind + '/' + d.topic] + ' · ' + (TEXT_ORIGINS[d.origin] || 'Texte'), 'doux'));
    (d.paragraphs || []).forEach(function (p) { li.appendChild(el('p', p)); });
    var trace = d.trace || { ok: false, sentences: [] };
    if (d.validatedAt) li.appendChild(el('p', 'Validé le ' + date(d.validatedAt) + (trace.ok ? '.' : ' : il ne passe plus le contrôle sur les données du jour et n’est plus servi.'), 'etat'));
    else if (!trace.ok) li.appendChild(el('p', 'Ce texte ne passe plus le contrôle sur les données du jour : préparez-en un nouveau.', 'etat'));
    else if (!d.current) li.appendChild(el('p', 'Les données ont changé depuis ce texte : préparez-en un nouveau.', 'etat'));
    var why = details(li, 'Phrase par phrase, avec sa source');
    trace.sentences.forEach(function (s) {
      why.appendChild(el('p', s.text));
      var sources = (s.sources || []).map(function (f) { return f.source + (f.date ? ', ' + date(f.date) : ''); });
      if (sources.length) why.appendChild(el('p', 'Source : ' + sources.join(' ; '), 'doux'));
      (s.problems || []).forEach(function (p) { why.appendChild(el('p', '« ' + p.value + ' » : ' + (PROBLEMS[p.code] || 'à retirer'), 'etat')); });
    });
    if (!d.validatedAt) {
      if (trace.ok && d.current) li.appendChild(button('Je l’ai relu : valider', function () {
        quarterWrite(z, '/v1/attirer/quartiers/textes/' + encodeURIComponent(d.draftId) + '/valider', undefined, 'Texte validé : le site du réseau peut le servir.', 'Le texte n’est pas validé.');
      }));
      var fix = details(li, 'Corriger ce texte');
      var title = field(fix, 'attirer-q-titre-' + i, 'Titre');
      title.value = d.title;
      var text = field(fix, 'attirer-q-texte-' + i, 'Texte', 'textarea');
      text.value = d.body;
      fix.appendChild(button('Enregistrer la correction', function () {
        quarterWrite(z, quarterPath(z, '/texte'), { kind: d.kind, topic: d.topic, title: title.value, body: text.value }, 'Correction enregistrée : relisez-la, puis validez.', 'La correction n’est pas enregistrée.');
      }));
    }
    return li;
  }
  function renderTexts(z, res) {
    var box = part('Textes');
    box.appendChild(el('p', 'Chaque phrase porte une donnée de la base. Rien n’est servi sans votre validation.', 'doux'));
    var what = select(box, 'attirer-q-choix', 'À préparer', TEXT_CHOICES, 'page/quartier');
    box.appendChild(button('Préparer le texte', function () {
      var c = what.value.split('/');
      quarterWrite(z, quarterPath(z, '/brouillon'), { kind: c[0], topic: c[1] }, 'Texte préparé : relisez-le, puis validez.', 'Le texte n’est pas préparé.');
    }));
    var items = list(res);
    if (!items) return missing(box, res);
    if (!items.length) box.appendChild(el('p', 'Aucun texte pour ce quartier.', 'doux'));
    var ul = el('ul', null, 'liste');
    items.forEach(function (d, i) { ul.appendChild(renderText(z, d, i)); });
    box.appendChild(ul);
    return box;
  }
  /* La clé d'un fait vient de son libellé : le même libellé remplace, rien à inventer ni à saisir ; deux libellés différents ne se confondent jamais. */
  function factKey(label) {
    return label.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  }
  function factLine(f) {
    var unit = { nombre: '', m: ' m', km: ' km', minutes: ' min', habitants: ' habitants', pourcent: ' %' };
    return f.label + (f.value === null || f.value === undefined ? '' : ' : ' + f.value + (unit[f.unit] || ''));
  }
  function renderFacts(z, res) {
    var box = part('Faits du quartier');
    var items = list(res);
    if (!items) return missing(box, res);
    if (!items.length) box.appendChild(el('p', 'Aucun fait rangé : un texte n’a rien à dire sans eux.', 'doux'));
    var ul = el('ul', null, 'liste');
    items.forEach(function (f) {
      var li = el('li');
      li.appendChild(el('strong', factLine(f)));
      li.appendChild(el('p', (FACT_KINDS[f.kind] || 'Autre') + ' · ' + f.source + ', ' + date(f.sourceDate), 'doux'));
      li.appendChild(quiet(confirmed('Retirer ce fait', 'Un texte qui le cite ne sera plus servi. Appuyez de nouveau pour confirmer.', function () {
        quarterWrite(z, quarterPath(z, '/faits'), { key: f.key, retired: true }, 'Fait retiré.', 'Le fait reste rangé.');
      })));
      ul.appendChild(li);
    });
    box.appendChild(ul);
    var form = details(box, 'Ranger un fait');
    var kind = select(form, 'attirer-f-sorte', 'Sorte', FACT_KINDS, 'transport');
    var label = field(form, 'attirer-f-libelle', 'Libellé');
    var value = field(form, 'attirer-f-valeur', 'Valeur, si le fait est un chiffre');
    value.setAttribute('inputmode', 'decimal');
    var noUnit = { '': 'Sans unité' };
    Object.keys(FACT_UNITS).forEach(function (k) { noUnit[k] = FACT_UNITS[k]; });
    var unit = select(form, 'attirer-f-unite', 'Unité', noUnit, '');
    var source = field(form, 'attirer-f-source', 'Source');
    var when = field(form, 'attirer-f-date', 'Date de la source');
    when.setAttribute('type', 'date');
    form.appendChild(button('Ranger ce fait', function () {
      var key = factKey(label.value);
      if (!key) { state('Saisissez le libellé du fait, avec au moins une lettre latine ou un chiffre.'); return; }
      var typed = label.value.trim().replace(/\\s+/g, ' ');
      var same = items.filter(function (i) { return i.key === key && i.label !== typed; })[0];
      if (same) { state('Ce libellé se confond avec « ' + same.label + ' » : changez-le, ou retirez d’abord ce fait.'); return; }
      var raw = value.value.trim().replace(',', '.');
      var number = raw === '' ? null : Number(raw);
      if (number !== null && !isFinite(number)) { state('La valeur doit être un chiffre.'); return; }
      if ((number === null) !== (unit.value === '')) { state('Un chiffre va avec son unité, et une unité avec son chiffre.'); return; }
      quarterWrite(z, quarterPath(z, '/faits'), { key: key, kind: kind.value, label: label.value, value: number, unit: unit.value === '' ? null : unit.value, source: source.value, sourceDate: when.value }, 'Fait rangé.', 'Le fait n’est pas rangé.');
    }));
    return box;
  }

  /*
   * Un geste qui retire quelque chose du public se confirme : le premier appui demande de confirmer ; un second appui trop rapproché
   * n'est pas une confirmation ; sans suite, la demande retombe.
   */
  // DS022 · sur cet écran de réglages, rien n'est « le pas à faire » : ouvrir, recalculer, mettre hors service sont
  // filaires ; un bouton plein ne se voit que dans un formulaire ouvert au geste.
  function quiet(b) { b.className = 'secondaire'; return b; }
  function confirmed(text, warning, act) {
    var armedAt = null;
    var b = button(text, function () {
      var now = Date.now();
      if (armedAt !== null && now - armedAt < 1000) return;
      if (armedAt === null || now - armedAt > 15000) {
        armedAt = now;
        b.textContent = 'Confirmer : ' + text.charAt(0).toLowerCase() + text.slice(1);
        state(warning);
        return;
      }
      armedAt = null;
      b.textContent = text;
      act();
    });
    return b;
  }
  /* AT04 · les sites en service et leur plan. Le site d'un agent se lit ici ; il se règle avec AT15. */
  var SITE_WARNING = 'Ce site ne servira plus ses pages à cette adresse. Appuyez de nouveau pour confirmer.';
  function saveSite(baseUrl, active, okText, failText) {
    return once(function () {
      state('Envoi…');
      return send('/v1/attirer/sites', 'POST', { kind: 'reseau', baseUrl: baseUrl, active: active }).then(function (x) {
        if (x.gone) return false;
        if (!x.ok) { state(refusal(x, failText)); return false; }
        return open(okText);
      });
    });
  }
  function openPlan(site, box) {
    return once(function () {
      state('Chargement…');
      return send('/v1/attirer/sites/' + encodeURIComponent(site.siteId) + '/plan', 'GET').then(function (x) {
        if (x.gone) return false;
        var items = list(x);
        if (!items) { state(refusal(x, 'Plan indisponible pour le moment.')); return false; }
        clear(box);
        box.appendChild(el('p', items.length + ' page(s) données aux moteurs de recherche.', 'doux'));
        var ul = el('ul', null, 'liste');
        items.forEach(function (e) { ul.appendChild(el('li', (SITEMAP[e.kind] || 'Page') + ' : ' + e.loc)); });
        box.appendChild(ul);
        state('');
        return true;
      });
    });
  }
  function renderSites(res) {
    var box = part('Sites en service');
    var items = list(res);
    if (!items) return missing(box, res);
    if (!items.length) box.appendChild(el('p', 'Aucun site en service.', 'doux'));
    var ul = el('ul', null, 'liste');
    items.forEach(function (s) {
      var li = el('li');
      li.appendChild(el('strong', s.baseUrl));
      li.appendChild(el('p', s.kind === 'agent' ? 'Site d’un agent' : 'Site du réseau', 'doux'));
      var plan = el('div');
      li.appendChild(quiet(button('Voir le plan', function () { openPlan(s, plan); })));
      if (s.kind !== 'agent') li.appendChild(quiet(confirmed('Mettre hors service', SITE_WARNING, function () { saveSite(s.baseUrl, false, 'Site mis hors service.', 'Le site reste en service.'); })));
      li.appendChild(plan);
      ul.appendChild(li);
    });
    box.appendChild(ul);
    var hasNetwork = items.some(function (s) { return s.kind !== 'agent'; });
    var form = details(box, hasNetwork ? 'Changer l’adresse du site du réseau' : 'Mettre le site du réseau en service');
    var f = field(form, 'attirer-site', 'Adresse du site du réseau');
    f.setAttribute('type', 'url');
    f.setAttribute('inputmode', 'url');
    function putOn() { saveSite(f.value.trim(), true, 'Site mis en service.', 'Le site n’est pas enregistré.'); }
    form.appendChild(hasNetwork ? confirmed('Changer l’adresse', SITE_WARNING, putOn) : button('Mettre en service', putOn));
    return box;
  }
  return { open: open, wipe: wipe, inside: function () { return inside; } };
};
`;
