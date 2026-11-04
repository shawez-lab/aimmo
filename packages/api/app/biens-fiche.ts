/**
 * Les blocs « Nom du client » (SV07) et « Biens du client » (SV06) de la fiche [R16, R201], servi à part (`/app/biens-fiche.js`) et chargé à l'ouverture
 * d'une fiche, pour garder le budget de l'application. Le serveur décide qui peut créer : l'écran n'a rien à vérifier
 * de plus que les chiffres saisis. Aucun envoi.
 */
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
  bad_postal_code: 'Le code postal : cinq chiffres.',
  bad_city: 'La commune : en toutes lettres, sans chiffre.',
  bad_surface: 'La surface : un nombre entier de m².',
  bad_rooms: 'Le nombre de pièces : un nombre entier.',
  bad_price: 'Le prix : un nombre entier d’euros.',
  name_in_first_name: 'Ce nom est déjà écrit comme prénom : il manque le vrai prénom. Voyez avec la direction.',
  bad_name: 'Un nom : des lettres, sans chiffre ni adresse.',
  no_name: 'Écrivez le nom à ajouter.',
  already_named: 'Ce nom est déjà écrit sur la fiche : il ne se remplace pas ici.',
  no_agent: 'Cette fiche n’a pas encore d’agent : attribuez-la d’abord.',
  agent_file_incomplete: 'Votre dossier d’agent n’est pas complet : le bien ne peut pas être créé.',
});

export const BIENS_FICHE_SCRIPT = `'use strict';
globalThis.AIMMO_BIENS_FICHE = function (t) {
  var el = t.el;
  var KINDS = ${JSON.stringify(KIND_LABELS)};
  var CODES = ${JSON.stringify(CODES)};
  var LOST = 'La réponse n’est pas arrivée : le bien est peut-être créé. Réessayez sans changer la saisie : il ne sera pas créé deux fois.';
  function line(b) {
    var facts = [KINDS[b.kind] || 'Bien', b.city, typeof b.surfaceM2 === 'number' ? b.surfaceM2 + ' m²' : null].filter(Boolean).join(', ');
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
  return function (box, personId, f) {
    if (f && (!f.firstName || !f.lastName)) nameBlock(box, personId, f);
    var section = el('section', null, 'bloc');
    section.appendChild(el('h3', 'Biens du client'));
    var list = el('ul');
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
    var postal = field(form, id + '-cp', 'Code postal', true);
    var city = field(form, id + '-commune', 'Commune', false);
    var surface = field(form, id + '-surface', 'Surface, en m²', true);
    var rooms = field(form, id + '-pieces', 'Pièces (facultatif)', true);
    var price = field(form, id + '-prix', 'Prix voulu, en euros (facultatif)', true);
    form.appendChild(t.accordButton('Créer le bien', function () {
      var n = { surfaceM2: count(surface), rooms: count(rooms), priceEur: count(price) };
      if (!/^[0-9]{5}$/.test(postal.value.trim())) { state.textContent = CODES.bad_postal_code; return Promise.resolve(false); }
      if (!city.value.trim()) { state.textContent = CODES.bad_city; return Promise.resolve(false); }
      if (!n.surfaceM2) { state.textContent = CODES.bad_surface; return Promise.resolve(false); }
      if (n.rooms !== null && !n.rooms) { state.textContent = CODES.bad_rooms; return Promise.resolve(false); }
      if (n.priceEur !== null && !n.priceEur) { state.textContent = CODES.bad_price; return Promise.resolve(false); }
      state.textContent = 'Enregistrement…';
      return t.send('/v1/fiches/' + encodeURIComponent(personId) + '/biens', 'POST', { requestId: requestId, kind: kind.value, postalCode: postal.value.trim(), city: city.value.trim(), surfaceM2: n.surfaceM2, rooms: n.rooms, priceEur: n.priceEur }).then(function (res) {
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
    section.appendChild(form);
    box.appendChild(section);
    t.send('/v1/fiches/' + encodeURIComponent(personId) + '/biens', 'GET').then(function (res) {
      if (res.gone) return;
      if (!res.ok) { state.textContent = 'La liste des biens n’a pas pu être lue.'; return; }
      (res.body.data || []).forEach(add);
    });
  };
};
`;
