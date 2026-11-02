import type { FACT_KINDS, FACT_UNITS, NeighbourhoodProblem } from '../../core/src/attirer/quartier.ts';

/**
 * L'écran « Attirer » de la direction (AT12), en morceaux posés dans `fichiers.ts` : son entrée sur l'écran du réseau,
 * sa section de page, son chargeur, et son script servi à part (`/app/attirer.js`), chargé à la première ouverture pour
 * tenir le budget de l'application [R201].
 *
 * Quatre parties : la part des contacts dont l'origine est connue, mois par mois (AT05), les versions des prix publics
 * et leur recalcul (AT01), les pages de quartier, du fait sourcé au texte validé (AT07, AT13), les sites en service et
 * leur plan (AT04). L'écran ne lit et n'écrit que par `/v1/attirer`
 * [R16] ; il ne calcule ni ne trie aucun chiffre, il montre ceux du serveur dans l'ordre reçu. Tout texte reçu est posé
 * avec `textContent`.
 */

/** Les raisons d'un refus, dites à la direction : jamais un code interne. */
const REFUSALS: Record<string, string> = {
  role: 'Ce n’est pas dans vos droits.',
  source_absente: 'La source des ventes publiques n’est pas branchée : aucun recalcul pour le moment.',
  bad_url: 'Saisissez l’adresse complète du site, sans chemin, par exemple https://www.exemple.fr.',
  url_taken: 'Cette adresse sert déjà un autre site : une seule page de référence par bien.',
  bad_month: 'Choisissez un mois dans la liste.',
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
        attirerScreen = make({ $: $, el: el, clear: clear, send: send, show: show, button: button, field: field, select: select, details: details, date: date, key: function () { return currentKey; }, session: function () { return session; }, next: function () { session += 1; return session; } });
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
  var MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  var chosenMonth = null, busy = false, inside = false;
  function state(text) { $('attirer-etat').textContent = text; }
  function refusal(res, fallback) {
    if (res.offline) return 'Pas de réseau : rien n’est enregistré.';
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
    chosenMonth = month;
    show('attirer');
    state('Chargement…');
    return Promise.all([send('/v1/attirer/prix/versions', 'GET'), send('/v1/attirer/sites', 'GET'), send('/v1/attirer/origine/' + month, 'GET'), send('/v1/attirer/quartiers', 'GET')]).then(function (all) {
      if (mine !== t.session() || all.some(function (r) { return r.gone; })) return false;
      if (all.every(function (r) { return r.offline; })) { state('Pas de réseau. Réessayez dans un moment.'); return false; }
      var body = $('attirer-corps');
      body.appendChild(renderOrigin(all[2], month));
      body.appendChild(renderPrices(all[0]));
      body.appendChild(renderQuarters(all[3]));
      body.appendChild(renderSites(all[1]));
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
      m.byContent.forEach(function (c) { contents.appendChild(el('li', (ORIGINS[c.kind] || 'Contenu') + ' ' + c.ref + ' : ' + c.contacts)); });
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
    box.appendChild(button('Recalculer les prix', recompute));
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
      li.appendChild(button('Ouvrir', function () { openQuarter(z, ''); }));
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
      li.appendChild(confirmed('Retirer ce fait', 'Un texte qui le cite ne sera plus servi. Appuyez de nouveau pour confirmer.', function () {
        quarterWrite(z, quarterPath(z, '/faits'), { key: f.key, retired: true }, 'Fait retiré.', 'Le fait reste rangé.');
      }));
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
      li.appendChild(button('Voir le plan', function () { openPlan(s, plan); }));
      if (s.kind !== 'agent') li.appendChild(confirmed('Mettre hors service', SITE_WARNING, function () { saveSite(s.baseUrl, false, 'Site mis hors service.', 'Le site reste en service.'); }));
      li.appendChild(plan);
      ul.appendChild(li);
    });
    box.appendChild(ul);
    var hasNetwork = items.some(function (s) { return s.kind !== 'agent'; });
    var f = field(box, 'attirer-site', hasNetwork ? 'Changer l’adresse du site du réseau' : 'Adresse du site du réseau');
    f.setAttribute('type', 'url');
    f.setAttribute('inputmode', 'url');
    function putOn() { saveSite(f.value.trim(), true, 'Site mis en service.', 'Le site n’est pas enregistré.'); }
    box.appendChild(hasNetwork ? confirmed('Changer l’adresse', SITE_WARNING, putOn) : button('Mettre en service', putOn));
    return box;
  }
  return { open: open, wipe: wipe, inside: function () { return inside; } };
};
`;
