/**
 * L'écran « Attirer » de la direction (AT12), en morceaux posés dans `fichiers.ts` : son entrée sur l'écran du réseau,
 * sa section de page, son chargeur, et son script servi à part (`/app/attirer.js`), chargé à la première ouverture pour
 * tenir le budget de l'application [R201].
 *
 * Trois parties : les versions des prix publics et leur recalcul (AT01), les sites en service et leur plan (AT04), la
 * part des contacts dont l'origine est connue, mois par mois (AT05). L'écran ne lit et n'écrit que par `/v1/attirer`
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
        attirerScreen = make({ $: $, el: el, clear: clear, send: send, show: show, button: button, field: field, select: select, date: date, key: function () { return currentKey; }, session: function () { return session; }, next: function () { session += 1; return session; } });
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
  var $ = t.$, el = t.el, clear = t.clear, send = t.send, show = t.show, button = t.button, field = t.field, select = t.select, date = t.date;
  var REFUSALS = ${JSON.stringify(REFUSALS)};
  var NOT_RUN = ${JSON.stringify(NOT_RUN)};
  var ORIGINS = ${JSON.stringify(ORIGIN_LABELS)};
  var SITEMAP = ${JSON.stringify(SITEMAP_LABELS)};
  var MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  var chosenMonth = null, busy = false;
  function state(text) { $('attirer-etat').textContent = text; }
  function refusal(res, fallback) {
    if (res.offline) return 'Pas de réseau : rien n’est enregistré.';
    return (res.body && REFUSALS[res.body.code]) || fallback;
  }
  function wipe() {
    clear($('attirer-corps'));
    state('');
    chosenMonth = null;
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
    return Promise.all([send('/v1/attirer/prix/versions', 'GET'), send('/v1/attirer/sites', 'GET'), send('/v1/attirer/origine/' + month, 'GET')]).then(function (all) {
      if (mine !== t.session() || all.some(function (r) { return r.gone; })) return false;
      if (all.every(function (r) { return r.offline; })) { state('Pas de réseau. Réessayez dans un moment.'); return false; }
      var body = $('attirer-corps');
      body.appendChild(renderOrigin(all[2], month));
      body.appendChild(renderPrices(all[0]));
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

  /*
   * Un geste qui coupe un site se confirme : le premier appui demande de confirmer ; un second appui trop rapproché
   * n'est pas une confirmation ; sans suite, la demande retombe.
   */
  function confirmed(text, act) {
    var armedAt = null;
    var b = button(text, function () {
      var now = Date.now();
      if (armedAt !== null && now - armedAt < 1000) return;
      if (armedAt === null || now - armedAt > 15000) {
        armedAt = now;
        b.textContent = 'Confirmer : ' + text.charAt(0).toLowerCase() + text.slice(1);
        state('Ce site ne servira plus ses pages à cette adresse. Appuyez de nouveau pour confirmer.');
        return;
      }
      armedAt = null;
      b.textContent = text;
      act();
    });
    return b;
  }
  /* AT04 · les sites en service et leur plan. Le site d'un agent se lit ici ; il se règle avec AT15. */
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
      if (s.kind !== 'agent') li.appendChild(confirmed('Mettre hors service', function () { saveSite(s.baseUrl, false, 'Site mis hors service.', 'Le site reste en service.'); }));
      li.appendChild(plan);
      ul.appendChild(li);
    });
    box.appendChild(ul);
    var hasNetwork = items.some(function (s) { return s.kind !== 'agent'; });
    var f = field(box, 'attirer-site', hasNetwork ? 'Changer l’adresse du site du réseau' : 'Adresse du site du réseau');
    f.setAttribute('type', 'url');
    f.setAttribute('inputmode', 'url');
    function putOn() { saveSite(f.value.trim(), true, 'Site mis en service.', 'Le site n’est pas enregistré.'); }
    box.appendChild(hasNetwork ? confirmed('Changer l’adresse', putOn) : button('Mettre en service', putOn));
    return box;
  }
  return { open: open, wipe: wipe };
};
`;
