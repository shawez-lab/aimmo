/**
 * Les blocs « Nom du client » (SV07) et « Biens du client » (SV06) de la fiche [R16, R201], servi à part (`/app/biens-fiche.js`) et chargé à l'ouverture
 * d'une fiche, pour garder le budget de l'application. Le serveur décide qui peut créer : l'écran n'a rien à vérifier
 * de plus que les chiffres saisis. Aucun envoi. Il ouvre aussi la préparation d'une séquence de prospection (BR34), dont
 * le script `/app/sequence-fiche.js` n'est chargé qu'au geste, et la recherche en langage courant d'un acquéreur (BR40),
 * dont le script `/app/recherche.js` n'est chargé qu'au geste, et les visites réservées en ligne à rattacher (BR64), dont
 * le script `/app/visites-en-ligne.js` n'est chargé qu'au geste.
 */
/** Ce que l'écran dit d'un secteur refusé (AU073). */
const AREA_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  rayon: 'Le rayon : de 0,1 à 50 km.',
  centre: 'Dites le lieu précis : une adresse, une gare, une école…',
  nom: 'Donnez un nom au secteur : quelques mots, sans numéro.',
  lieu_introuvable: 'Ce lieu n’a pas été trouvé : précisez la commune.',
  geocodage_absent: 'La recherche des lieux n’est pas branchée : le secteur attend.',
  not_assigned: 'Ce client est suivi par un autre agent.',
});

export const KIND_LABELS: Readonly<Record<string, string>> = Object.freeze({
  home: 'Maison ou appartement',
  building: 'Immeuble',
  land: 'Terrain',
  commercial: 'Local commercial',
  business_walls: 'Murs commerciaux',
  business: 'Fonds de commerce',
});

const CODES: Readonly<Record<string, string>> = Object.freeze({
  bad_kind: 'Choisissez le type de bien.',
  bad_dwelling: 'Maison ou appartement : seulement pour un logement.',
  bad_postal_code: 'Le code postal : cinq chiffres.',
  bad_city: 'La commune : en toutes lettres, sans chiffre.',
  bad_surface: 'La surface : un nombre de m², au centième près (par exemple 63,42).',
  bad_rooms: 'Le nombre de pièces : un nombre entier.',
  bad_price: 'Le prix : un nombre entier d’euros.',
  name_in_first_name: 'Ce nom est déjà écrit comme prénom : il manque le vrai prénom. Voyez avec la direction.',
  bad_name: 'Un nom : des lettres, sans chiffre ni adresse.',
  no_name: 'Écrivez le nom à ajouter.',
  already_named: 'Ce nom est déjà écrit sur la fiche : il ne se remplace pas ici.',
  bad_reason: 'Choisissez le motif de la correction.',
  name_required: 'Une fiche garde au moins un prénom ou un nom.',
  name_on_merged_fiche: 'Une fiche réunie porte ce nom : écrivez le bon plutôt que de le vider.',
  name_changed: 'Ce nom vient de changer : relisez la fiche, puis recommencez.',
  no_agent: 'Cette fiche n’a pas encore d’agent : attribuez-la d’abord.',
  agent_file_incomplete: 'Votre dossier d’agent n’est pas complet : le bien ne peut pas être créé.',
});

export const CORRECTION_REASONS: Readonly<Record<string, string>> = Object.freeze({
  faute_de_frappe: 'Faute de frappe',
  nom_dans_prenom: 'Nom écrit à la place du prénom',
  demande_de_la_personne: 'Demande de la personne',
  etat_civil: 'Changement d’état civil',
});

export const BIENS_FICHE_SCRIPT = `'use strict';
globalThis.AIMMO_BIENS_FICHE = function (t) {
  var el = t.el;
  var KINDS = ${JSON.stringify(KIND_LABELS)};
  var CODES = ${JSON.stringify(CODES)};
  var AREA_REFUSALS = ${JSON.stringify(AREA_REFUSALS)};
  var REASONS = ${JSON.stringify(CORRECTION_REASONS)};
  var LOST = 'La réponse n’est pas arrivée : le bien est peut-être créé. Réessayez sans changer la saisie : il ne sera pas créé deux fois.';
  function line(b) {
    var facts = [KINDS[b.kind] || 'Bien', b.city, typeof b.surfaceM2 === 'number' ? String(b.surfaceM2).replace('.', ',') + ' m²' : null].filter(Boolean).join(', ');
    return el('li', 'Réf. ' + b.reference + ' : ' + facts + '.');
  }
  function field(form, id, label, numeric) {
    var l = el('label', label);
    l.setAttribute('for', id);
    var i = el('input');
    i.setAttribute('id', id);
    if (numeric) i.setAttribute('inputmode', 'numeric');
    form.appendChild(l);
    form.appendChild(i);
    return i;
  }
  function count(input) {
    var v = input.value.trim();
    return /^[0-9]+$/.test(v) ? Number(v) : v === '' ? null : NaN;
  }
  function nameBlock(box, personId, f) {
    var section = el('section', null, 'bloc');
    section.appendChild(el('h3', 'Nom du client'));
    section.appendChild(el('p', 'Il manque à la fiche : sans lui, un mandat ou un bon de visite reste incomplet.', 'doux'));
    if (f.firstName) section.appendChild(el('p', 'Prénom écrit : ' + f.firstName + '.'));
    if (f.lastName) section.appendChild(el('p', 'Nom écrit : ' + f.lastName + '.'));
    var form = el('div', null, 'decision');
    var id = t.cSeq();
    var state = t.cState();
    var first = f.firstName ? null : field(form, id + '-prenom', 'Prénom', false);
    var last = f.lastName ? null : field(form, id + '-nom', 'Nom de famille', false);
    form.appendChild(t.accordButton('Compléter la fiche', function () {
      var body = {};
      if (first && first.value.trim()) body.firstName = first.value.trim();
      if (last && last.value.trim()) body.lastName = last.value.trim();
      if (!body.firstName && !body.lastName) { state.textContent = CODES.no_name; return Promise.resolve(false); }
      state.textContent = 'Enregistrement…';
      return t.send('/v1/fiches/' + encodeURIComponent(personId) + '/nom', 'POST', body).then(function (res) {
        if (res.gone) return false;
        if (!res.ok) {
          var code = res.body && res.body.code;
          if (CODES[code]) { state.textContent = CODES[code]; return false; }
          if (res.offline || res.status >= 500 || !res.body) { state.textContent = 'La réponse n’est pas arrivée : le nom est peut-être écrit. Réessayez sans changer la saisie.'; return false; }
          return t.accordFailed(res, personId, state, 'Le nom n’est pas écrit : réessayez.');
        }
        return t.openFiche(personId).then(function (read) {
          if (read) t.$('fiche-etat').textContent = 'Fiche complétée.';
          return read;
        });
      });
    }));
    form.appendChild(state);
    section.appendChild(form);
    box.appendChild(section);
  }
  function who(a, b) { return [a, b].filter(Boolean).join(' ') || 'sans nom'; }
  function correctionBlock(box, personId, f) {
    var section = el('section', null, 'bloc');
    section.appendChild(el('h3', 'Corriger le nom'));
    section.appendChild(el('p', 'Le nom d’avant reste lisible ici. Les documents déjà générés ne changent pas.', 'doux'));
    var form = el('div', null, 'decision');
    var id = t.cSeq();
    var state = t.cState();
    var first = field(form, id + '-prenom', 'Prénom', false);
    first.value = f.firstName || '';
    var last = field(form, id + '-nom', 'Nom de famille', false);
    last.value = f.lastName || '';
    var reason = t.cSelect(form, id + '-motif', 'Motif', REASONS, 'faute_de_frappe');
    form.appendChild(t.accordButton('Corriger le nom', function () {
      state.textContent = 'Enregistrement…';
      return t.send('/v1/fiches/' + encodeURIComponent(personId) + '/nom/corrections', 'POST', { firstName: first.value.trim() || null, lastName: last.value.trim() || null, reason: reason.value }).then(function (res) {
        if (res.gone) return false;
        if (!res.ok) {
          var code = res.body && res.body.code;
          if (CODES[code]) { state.textContent = CODES[code]; return false; }
          if (res.offline || res.status >= 500 || !res.body) { state.textContent = 'La réponse n’est pas arrivée : le nom est peut-être corrigé. Réessayez sans changer la saisie.'; return false; }
          return t.accordFailed(res, personId, state, 'Le nom n’est pas corrigé : réessayez.');
        }
        return t.openFiche(personId).then(function (read) {
          if (read) t.$('fiche-etat').textContent = res.body.data.changed ? 'Nom corrigé.' : 'Le nom était déjà celui-ci.';
          return read;
        });
      });
    }));
    form.appendChild(state);
    section.appendChild(form);
    var history = el('ul');
    section.appendChild(history);
    box.appendChild(section);
    t.send('/v1/fiches/' + encodeURIComponent(personId) + '/nom/corrections', 'GET').then(function (res) {
      if (res.gone) return;
      if (!res.ok) { state.textContent = 'Les corrections d’avant n’ont pas pu être lues.'; return; }
      (res.body.data || []).forEach(function (c) {
        history.appendChild(el('li', String(c.at).slice(0, 10) + ' : ' + who(c.oldFirstName, c.oldLastName) + ' devient ' + who(c.newFirstName, c.newLastName) + ' (' + (REASONS[c.reason] || 'motif inconnu') + ').'));
      });
    });
  }
  var seqTool = null, seqBusy = false;
  function sequenceBlock(box, personId) {
    var section = el('section', null, 'bloc');
    section.appendChild(el('h3', 'Séquence de prospection'));
    var inner = el('div');
    var state = t.cState();
    section.appendChild(inner);
    section.appendChild(state);
    box.appendChild(section);
    var open = el('button', 'Préparer une séquence', 'secondaire');
    open.setAttribute('type', 'button');
    function show() { inner.removeChild(open); state.textContent = ''; seqTool(inner, personId); }
    open.addEventListener('click', function () {
      if (seqTool) return show();
      if (seqBusy) return;
      seqBusy = true;
      state.textContent = 'Chargement…';
      var s = el('script');
      s.setAttribute('src', '/app/sequence-fiche.js');
      s.addEventListener('load', function () {
        seqBusy = false;
        var make = globalThis.AIMMO_SEQUENCE_FICHE;
        if (typeof make !== 'function') { state.textContent = 'Pas de réseau. Réessayez dans un moment.'; return; }
        seqTool = make(t);
        show();
      });
      s.addEventListener('error', function () { seqBusy = false; state.textContent = 'Pas de réseau. Réessayez dans un moment.'; });
      section.appendChild(s);
    });
    inner.appendChild(open);
  }
  var searchTool = null, searchBusy = false;
  function searchBlock(box, projects) {
    var section = el('section', null, 'bloc');
    section.appendChild(el('h3', 'Recherche en langage courant'));
    var inner = el('div');
    var state = t.cState();
    section.appendChild(inner);
    section.appendChild(state);
    box.appendChild(section);
    var open = el('button', 'Chercher avec ses mots', 'secondaire');
    open.setAttribute('type', 'button');
    function show() { inner.removeChild(open); state.textContent = ''; searchTool(inner, projects); }
    open.addEventListener('click', function () {
      if (searchTool) return show();
      if (searchBusy) return;
      searchBusy = true;
      state.textContent = 'Chargement…';
      var s = el('script');
      s.setAttribute('src', '/app/recherche.js');
      s.addEventListener('load', function () {
        searchBusy = false;
        var make = globalThis.AIMMO_RECHERCHE;
        if (typeof make !== 'function') { state.textContent = 'Pas de réseau. Réessayez dans un moment.'; return; }
        searchTool = make(t);
        show();
      });
      s.addEventListener('error', function () { searchBusy = false; state.textContent = 'Pas de réseau. Réessayez dans un moment.'; });
      section.appendChild(s);
    });
    inner.appendChild(open);
  }
  // AU073 · Le secteur privé d'une recherche : un rayon autour d'un lieu précis, géocodé par le serveur.
  var areaTool = null, areaBusy = false;
  function areaBlock(box, projects) {
    var section = el('section', null, 'bloc');
    section.appendChild(el('h3', 'Secteur de la recherche'));
    var state = t.cState();
    var id = t.cSeq();
    // Plusieurs projets d'achat : l'agent choisit celui dont il range le secteur.
    var labels = {};
    projects.forEach(function (q, n) { labels[q.id] = 'Projet d’achat ' + (n + 1); });
    var pick = projects.length > 1 ? t.cSelect(section, id + '-projet', 'Le projet', labels, projects[0].id) : null;
    var seen = 0, known = false, picked = 0;
    // Sans le secteur en place lu, rien ne se range ni ne se retire : on ne remplace pas ce qu'on n'a pas vu.
    var retry = el('button', 'Réessayer de lire le secteur', 'secondaire');
    retry.setAttribute('type', 'button');
    retry.addEventListener('click', function () { load(); });
    function unread() { state.textContent = 'Le secteur en place n’est pas lu : réessayez de le lire d’abord.'; return Promise.resolve(false); }
    function base() { return '/v1/acquereurs/projets/' + encodeURIComponent(pick ? pick.value : projects[0].id) + '/secteur'; }
    var now = el('p', null, 'doux');
    section.appendChild(now);
    var fix = section.appendChild(el('div'));
    // DS010 · le réglage ne s'ouvre qu'au geste : le bloc dit d'abord le secteur en place.
    var more = section.appendChild(el('details'));
    more.appendChild(el('summary', 'Régler le secteur'));
    var place = field(more, id + '-lieu', 'Lieu précis (adresse, gare, école…)', false);
    var km = field(more, id + '-rayon', 'Rayon, en km', true);
    var label = field(more, id + '-nom', 'Nom du secteur, pour vous', false);
    var current = null;
    function said(a) { current = a; now.textContent = a ? (a.shape === 'cercle' ? 'Secteur « ' + a.label + ' » : ' + String(a.radiusM / 1000).replace('.', ',') + ' km autour du lieu dit.' : 'Secteur « ' + a.label + ' » dessiné.') : 'Aucun secteur : les communes de la recherche suffisent.'; }
    // Une réponse arrivée après un changement de projet ne s'affiche pas sous le nouveau projet.
    function answer(mine) { return function (res) {
      if (res.gone || mine !== seen) return false;
      if (!res.ok) { state.textContent = AREA_REFUSALS[res.body && res.body.code] || 'Le secteur n’est pas rangé.'; return false; }
      said(res.body.data);
      state.textContent = 'Secteur rangé.';
      return true;
    }; }
    more.appendChild(t.accordButton('Ranger le secteur', function () {
      if (!known) return unread();
      var r = Number(String(km.value).replace(',', '.'));
      if (!(r >= 0.1 && r <= 50)) { state.textContent = AREA_REFUSALS.rayon; return Promise.resolve(false); }
      return t.send(base(), 'POST', { shape: 'cercle', place: place.value.trim(), radiusM: Math.round(r * 1000), label: label.value.trim() }).then(answer(seen));
    }));
    more.appendChild(t.accordButton('Retirer le secteur', function () { return known ? t.send(base(), 'POST', { shape: 'aucun' }).then(answer(seen)) : unread(); }));
    // AU073b · dessiner le contour au doigt sur une carte : le script n'est chargé qu'au geste.
    var drawBox = el('div');
    var drawOpen = el('button', 'Dessiner sur la carte', 'secondaire');
    drawOpen.setAttribute('type', 'button');
    drawOpen.className = 'secondaire';
    // La carte est celle du projet choisi à son ouverture : elle se referme quand le projet change, et rien de ce qu'elle
    // range après un changement de projet ne s'affiche ni ne compte sous le nouveau.
    function drawShow() {
      if (drawOpen.parentNode) drawBox.removeChild(drawOpen);
      var mine = picked, url = base();
      areaTool(drawBox, {
        base: function () { return url; },
        ready: function () { return known && mine === picked; },
        label: function () { return label.value.trim(); },
        current: function () { return current; },
        done: function (a) { if (mine !== picked) return; said(a); state.textContent = 'Secteur rangé.'; },
      });
    }
    function drawReset() { drawBox.textContent = ''; drawBox.appendChild(drawOpen); }
    drawOpen.addEventListener('click', function () {
      if (areaTool) return drawShow();
      if (areaBusy) return;
      areaBusy = true;
      state.textContent = 'Chargement de la carte…';
      var s = el('script');
      s.setAttribute('src', '/app/secteur-carte.js');
      s.addEventListener('load', function () {
        areaBusy = false;
        var make = globalThis.AIMMO_SECTEUR_CARTE;
        try { delete globalThis.AIMMO_SECTEUR_CARTE; } catch (e) { /* rien */ }
        if (typeof make !== 'function') { state.textContent = 'Pas de réseau. Réessayez dans un moment.'; return; }
        areaTool = make(t);
        state.textContent = '';
        drawShow();
      });
      s.addEventListener('error', function () { areaBusy = false; state.textContent = 'Pas de réseau. Réessayez dans un moment.'; });
      section.appendChild(s);
    });
    drawBox.appendChild(drawOpen);
    more.appendChild(drawBox);
    section.appendChild(state);
    box.appendChild(section);
    function load() {
      var mine = ++seen;
      known = false;
      now.textContent = 'Lecture du secteur…';
      state.textContent = '';
      fix.textContent = '';
      t.send(base(), 'GET').then(function (res) {
        if (res.gone || mine !== seen) return;
        if (res.ok) { known = true; said(res.body.data); return; }
        now.textContent = res.offline ? 'Pas de réseau : le secteur en place n’est pas lu.' : 'Le secteur en place n’a pas pu être lu.';
        fix.appendChild(retry);
      });
    }
    // Un changement de projet referme la carte ; une nouvelle lecture du même projet la laisse utilisable.
    if (pick) pick.addEventListener('change', function () { picked++; drawReset(); load(); });
    load();
  }
  var onlineTool = null, onlineBusy = false;
  function onlineBlock(box, personId, projects) {
    var section = el('section', null, 'bloc');
    section.appendChild(el('h3', 'Visites réservées en ligne'));
    var inner = el('div');
    var state = t.cState();
    section.appendChild(inner);
    section.appendChild(state);
    box.appendChild(section);
    var open = el('button', 'Voir les visites à rattacher', 'secondaire');
    open.setAttribute('type', 'button');
    function show() { inner.removeChild(open); state.textContent = ''; onlineTool(inner, personId, projects); }
    open.addEventListener('click', function () {
      if (onlineTool) return show();
      if (onlineBusy) return;
      onlineBusy = true;
      state.textContent = 'Chargement…';
      var s = el('script');
      s.setAttribute('src', '/app/visites-en-ligne.js');
      s.addEventListener('load', function () {
        onlineBusy = false;
        var make = globalThis.AIMMO_VISITES_EN_LIGNE;
        if (typeof make !== 'function') { state.textContent = 'Pas de réseau. Réessayez dans un moment.'; return; }
        onlineTool = make(t);
        show();
      });
      s.addEventListener('error', function () { onlineBusy = false; state.textContent = 'Pas de réseau. Réessayez dans un moment.'; });
      section.appendChild(s);
    });
    inner.appendChild(open);
  }
  // DS010 · la fiche range ses blocs en parties : les biens dans « box », le nom dans « where.nom », la séquence et
  // la recherche d'un acquéreur dans « where.suite ». Sans « where », tout va dans « box », comme avant.
  return function (box, personId, f, where) {
    var named = where ? where.nom : box, rest = where ? where.suite : box;
    // La direction corrige ce qui est écrit ; une fiche sans aucun nom se remplit, avec ou sans elle.
    if (f && f.nameCorrectable === true && (f.firstName || f.lastName)) correctionBlock(named, personId, f);
    else if (f && (!f.firstName || !f.lastName)) nameBlock(named, personId, f);
    var section = el('section', null, 'bloc');
    section.appendChild(el('h3', 'Biens du client'));
    var list = el('ul', null, 'liste');
    section.appendChild(list);
    var shown = {};
    function add(b) {
      if (shown[b.reference]) return;
      shown[b.reference] = 1;
      list.appendChild(line(b));
    }
    var requestId = crypto.randomUUID();
    var form = el('div', null, 'decision');
    var id = t.cSeq();
    var state = t.cState();
    var kind = t.cSelect(form, id + '-type', 'Type de bien', KINDS, 'home');
    // AU070 · une recherche de maison ne reçoit pas un appartement.
    var dwelling = t.cSelect(form, id + '-logement', 'Maison ou appartement', { '': 'Je ne sais pas encore', house: 'Maison', apartment: 'Appartement' }, '');
    var postal = field(form, id + '-cp', 'Code postal', true);
    var city = field(form, id + '-commune', 'Commune', false);
    var surface = field(form, id + '-surface', 'Surface, en m²', true);
    // AU062 · une surface décimale se saisit telle quelle, virgule ou point.
    surface.setAttribute('inputmode', 'decimal');
    var rooms = field(form, id + '-pieces', 'Pièces (facultatif)', true);
    var price = field(form, id + '-prix', 'Prix voulu, en euros (facultatif)', true);
    form.appendChild(t.accordButton('Créer le bien', function () {
      var sv = surface.value.trim().replace(',', '.');
      var n = { surfaceM2: /^[0-9]+(\\.[0-9]{1,2})?$/.test(sv) && Number(sv) > 0 ? Number(sv) : NaN, rooms: count(rooms), priceEur: count(price) };
      if (!/^[0-9]{5}$/.test(postal.value.trim())) { state.textContent = CODES.bad_postal_code; return Promise.resolve(false); }
      if (!city.value.trim()) { state.textContent = CODES.bad_city; return Promise.resolve(false); }
      if (!n.surfaceM2) { state.textContent = CODES.bad_surface; return Promise.resolve(false); }
      if (n.rooms !== null && !n.rooms) { state.textContent = CODES.bad_rooms; return Promise.resolve(false); }
      if (n.priceEur !== null && !n.priceEur) { state.textContent = CODES.bad_price; return Promise.resolve(false); }
      state.textContent = 'Enregistrement…';
      return t.send('/v1/fiches/' + encodeURIComponent(personId) + '/biens', 'POST', { requestId: requestId, kind: kind.value, dwelling: kind.value === 'home' ? dwelling.value || null : null, postalCode: postal.value.trim(), city: city.value.trim(), surfaceM2: n.surfaceM2, rooms: n.rooms, priceEur: n.priceEur }).then(function (res) {
        if (res.gone) return false;
        if (!res.ok) {
          var code = res.body && res.body.code;
          if (CODES[code]) { state.textContent = CODES[code]; return false; }
          if (res.offline || res.status >= 500 || !res.body) { state.textContent = LOST; return false; }
          return t.accordFailed(res, personId, state, 'Le bien n’est pas créé : réessayez.');
        }
        var b = res.body.data;
        add(b);
        requestId = crypto.randomUUID();
        [postal, city, surface, rooms, price].forEach(function (i) { i.value = ''; });
        state.textContent = (b.already ? 'Ce bien existe déjà' : 'Bien créé') + ', réf. ' + b.reference + ' : il est aussi dans « Mes biens à mettre en vente ».';
        return true;
      });
    }));
    form.appendChild(state);
    // DS010 · le formulaire ne s'ouvre qu'au geste : la liste des biens tient en un écran.
    var more = el('details');
    more.appendChild(el('summary', 'Ajouter un bien'));
    more.appendChild(form);
    section.appendChild(more);
    box.appendChild(section);
    t.send('/v1/fiches/' + encodeURIComponent(personId) + '/biens', 'GET').then(function (res) {
      if (res.gone) return;
      if (!res.ok) { state.textContent = 'La liste des biens n’a pas pu être lue.'; return; }
      (res.body.data || []).forEach(add);
    });
    // La séquence de prospection (BR34) : seulement pour une personne joignable [R301].
    if (f && f.contact && f.contact.allowed === true) sequenceBlock(rest, personId);
    // La recherche en langage courant (BR40) : seulement sur un projet d'achat, pour le ranger au bon endroit.
    var buying = (f && Array.isArray(f.projects) ? f.projects : []).filter(function (p) { return p && p.kind === 'buy' && /^[A-Za-z0-9_-]{1,64}$/.test(String(p.id)); });
    if (buying.length) searchBlock(rest, buying);
    if (buying.length) areaBlock(rest, buying);
    // Les visites réservées en ligne, rattachées à la recherche (BR64) : seulement avec un projet d'achat.
    if (buying.length) onlineBlock(rest, personId, buying);
  };
};
`;
