/**
 * Les licences du logiciel sur l'écran du réseau (BR16) : la direction du réseau qui donne les licences lit le tarif en
 * vigueur et les licences données, fixe un nouveau tarif, donne une licence, la suspend, la reprend ou la termine, par
 * les routes de BR15 (`/v1/licences`) [R654, R655, R656]. La direction d'une agence sous licence ne lit que la sienne
 * [R657] : le serveur le dit (`agence_licenciee`), et l'écran passe à `/v1/licences/ma-licence`.
 * Script servi à part (`/app/licences.js`), chargé au premier geste [R201]. Chaque état et chaque refus se disent en
 * mots, jamais par un code. Aucun prix ne se saisit pour une licence : celui du tarif en vigueur s'applique [R655].
 * Terminer une licence ne se défait pas : deux appuis [R656]. Une saisie illisible ne part pas. Tout texte reçu est posé
 * en texte.
 */
import { LICENCE_MAX_CENTS, LICENCE_MIN_CENTS } from '../../core/src/licences/licences.ts';
import { REGIONS } from '../../core/src/regions/regions.ts';

const REFUSALS: Record<string, string> = {
  role: 'Ce n’est pas dans vos droits.',
  invalid_body: 'La demande n’a pas pu être lue. Rechargez l’écran.',
  unknown_field: 'La demande n’a pas pu être lue. Rechargez l’écran.',
  bad_shape: 'La demande n’a pas pu être lue. Rechargez l’écran.',
  not_found: 'Cette licence ne se trouve pas : relisez la liste.',
  agence_licenciee: 'Une agence sous licence ne donne pas de licence.',
  pas_de_licence: 'Aucune licence n’est rangée pour votre agence.',
  bad_price: 'Le tarif : un montant en euros hors taxes, de 1 € à 100 000 € par mois, au centime près.',
  bad_reason: 'La raison : de 3 à 200 caractères.',
  tarif_inchange: 'C’est déjà le tarif en vigueur : rien ne change.',
  tarif_absent: 'Aucun tarif n’est fixé : fixez-le avant de donner une licence.',
  conflit: 'Une autre décision vient de passer : relisez la liste, puis recommencez.',
  bad_name: 'Le nom de l’agence : de 2 à 120 caractères.',
  siren_invalide: 'Le SIREN : 9 chiffres, avec une clé juste.',
  carte_invalide: 'La carte professionnelle : « CPI » suivi de son numéro, et sa date de fin de validité.',
  carte_echue: 'Cette carte professionnelle est échue : aucune licence ne se donne sur elle.',
  departement_inconnu: 'Ce département ne se reconnaît pas.',
  phase5_fermee: 'La phase 5 n’est pas ouverte : aucune licence ne se donne avant.',
  deja_licenciee: 'Cette agence a déjà une licence : relisez la liste.',
  bad_state: 'Choisissez de suspendre, de reprendre ou de terminer.',
  terminee: 'Cette licence est terminée : elle ne bouge plus.',
  etat_inchange: 'La licence est déjà dans cet état : relisez la liste.',
};
const STATES: Record<string, string> = {
  active: 'Active',
  suspendue: 'Suspendue',
  terminee: 'Terminée : elle ne bouge plus',
};
const REGION_NAMES: Record<string, string> = Object.fromEntries(REGIONS.map((r) => [r.code, r.name]));
/** Les départements que connaît la carte des régions (HX72) : un autre ne part pas. */
const DEPARTMENTS: string[] = REGIONS.flatMap((r) => [...r.departments]);

export const LICENCES_ENTRY_HTML = `<section class="bloc" aria-labelledby="titre-licences">
<h3 id="titre-licences">Licences du logiciel</h3>
<p class="doux">Un seul tarif publié pour toutes les agences hors réseau, sans remise cachée. Rien n’est prélevé ni envoyé.</p>
<button id="licences-voir" type="button" class="secondaire">Voir les licences</button>
<p id="licences-etat" class="etat" role="status"></p>
<div id="licences-corps"></div>
</section>
`;

/** Le chargeur posé dans le script de l'application : l'écran est servi à part, chargé une fois, jamais gardé. */
export const LICENCES_JS = `
  /* ---------- Les licences du logiciel sur l'écran du réseau (BR16), chargées au premier geste [R16, R201, R657]. ---------- */
  var licencesTools = null, licencesLoading = false;
  function wipeLicences() {
    clear($('licences-corps'));
    $('licences-etat').textContent = '';
  }
  function withLicences(act) {
    if (!currentKey) return Promise.resolve(false);
    if (licencesTools) return act(licencesTools);
    if (licencesLoading) return Promise.resolve(false);
    licencesLoading = true;
    var mine = session;
    $('licences-etat').textContent = 'Chargement…';
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.setAttribute('src', '/app/licences.js');
      s.addEventListener('load', function () {
        licencesLoading = false;
        var make = globalThis.AIMMO_LICENCES;
        try { delete globalThis.AIMMO_LICENCES; } catch (e) { /* rien */ }
        if (mine !== session) { resolve(false); return; }
        if (typeof make !== 'function') { $('licences-etat').textContent = 'Indisponible pour le moment. Réessayez dans un moment.'; resolve(false); return; }
        licencesTools = make({ $: $, el: el, clear: clear, send: send, button: button, field: field, date: date, session: function () { return session; } });
        resolve(act(licencesTools));
      });
      s.addEventListener('error', function () {
        licencesLoading = false;
        if (mine === session) $('licences-etat').textContent = 'Pas de réseau. Réessayez dans un moment.';
        resolve(false);
      });
      $('reseau').appendChild(s);
    });
  }
`;

/** Le script servi à part (`/app/licences.js`). Il ne lit et n'écrit que `/v1/licences` [R16]. */
export const LICENCES_SCRIPT = `'use strict';
globalThis.AIMMO_LICENCES = function (t) {
  var $ = t.$, el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field, date = t.date;
  var REFUSALS = ${JSON.stringify(REFUSALS)};
  var STATES = ${JSON.stringify(STATES)};
  var REGION_NAMES = ${JSON.stringify(REGION_NAMES)};
  var DEPARTMENTS = ${JSON.stringify(DEPARTMENTS)};
  var MIN_CENTS = ${LICENCE_MIN_CENTS}, MAX_CENTS = ${LICENCE_MAX_CENTS};
  /* Mêmes formes que le serveur : une saisie illisible ne part pas. */
  var EUROS = new RegExp('^[0-9]{1,6}([.,][0-9]{1,2})?$');
  var CARD = new RegExp('^CPI [0-9A-Z ]{6,30}$');
  var DAY = new RegExp('^[0-9]{4}-[0-9]{2}-[0-9]{2}$');
  var OFFLINE = 'Pas de réseau. Réessayez dans un moment.';
  /* Une écriture sans réponse, ou coupée par une panne du serveur, a pu passer : l'écran ne dit ni fait ni pas fait. */
  var LOST = 'La réponse n’est pas arrivée : rien n’est sûr. Relisez l’écran avant de recommencer.';
  var busy = null, showing = 0;
  function state(text) { $('licences-etat').textContent = text; }
  function once(work) {
    var mine = t.session();
    if (busy === mine) return Promise.resolve(false);
    busy = mine;
    function done(r) { if (busy === mine) busy = null; return r; }
    return work().then(done, function () { return done(false); });
  }
  function why(res, fallback) {
    if (res.offline) return OFFLINE;
    var b = res.body || {};
    return REFUSALS[b.code] || fallback;
  }
  function write(path, payload, okText, failText) {
    return once(function () {
      state('Envoi…');
      return send(path, 'POST', payload).then(function (x) {
        if (x.gone) return false;
        if (x.offline || !x.body || x.status >= 500) { state(LOST); return false; }
        if (!x.ok) { state(why(x, failText)); return false; }
        return show(okText);
      });
    });
  }
  function clean(input) { return String(input.value || '').trim().replace(/\\s+/g, ' '); }
  function money(cents) {
    var c = Number(cents);
    if (!isFinite(c) || c < 0) return '';
    var whole = String(Math.floor(c / 100)).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ' ');
    var rest = String(c % 100);
    return whole + ',' + (rest.length < 2 ? '0' + rest : rest) + ' € HT';
  }
  /* Des euros au centime près, en centimes ; null si la saisie ne se lit pas ou sort des bornes. */
  function cents(input) {
    var v = String(input.value || '').trim().replace(/\\s+/g, '');
    if (!EUROS.test(v)) return null;
    var p = v.replace(',', '.').split('.');
    var c = Number(p[0]) * 100 + (p[1] ? Number((p[1] + '0').slice(0, 2)) : 0);
    return c >= MIN_CENTS && c <= MAX_CENTS ? c : null;
  }
  function sirenOf(input) {
    var s = String(input.value || '').replace(/\\s+/g, '');
    if (!new RegExp('^[0-9]{9}$').test(s)) return null;
    var sum = 0;
    for (var i = 0; i < 9; i++) {
      var d = Number(s.charAt(8 - i));
      if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
    }
    return sum % 10 === 0 ? s : null;
  }
  function validDay(v) {
    if (!DAY.test(v)) return false;
    var d = new Date(v + 'T00:00:00Z');
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }
  function day(d) { return validDay(String(d)) ? date(d + 'T12:00:00.000Z') : ''; }
  function reasonOf(input) {
    var r = clean(input);
    return r.length >= 3 && r.length <= 200 ? r : null;
  }
  function stateLine(l) {
    return (STATES[l.state] || 'État que cet écran ne sait pas encore dire') + ' depuis le ' + date(l.stateSince) + '.';
  }
  function priceLine(l) {
    return money(l.monthlyCents) + ' par mois, tarif version ' + l.tariffVersion + (l.oldTariff ? ', à l’ancien tarif : un nouveau tarif ne change pas une licence déjà donnée.' : '.');
  }
  function cardLine(box, l) {
    if (l.cardExpired) box.appendChild(el('p', 'Carte professionnelle échue le ' + day(l.cardExpiresOn) + ' : rien ne se coupe seul, la décision vous revient.', 'alerte'));
    else box.appendChild(el('p', 'Carte professionnelle valable jusqu’au ' + day(l.cardExpiresOn) + '.', 'doux'));
  }
  function renderTariff(body, tariff) {
    body.appendChild(el('h4', 'Le tarif'));
    body.appendChild(el('p', tariff ? money(tariff.monthlyCents) + ' par mois, version ' + tariff.version + ' du ' + date(tariff.decidedAt) + ' : le même pour chaque agence.' : 'Aucun tarif n’est fixé : aucune licence ne se donne avant.'));
    body.appendChild(el('p', 'Chaque changement est publié avec sa date. Une licence garde le tarif du jour où elle est donnée.', 'doux'));
    var d = el('details');
    d.appendChild(el('summary', tariff ? 'Fixer un nouveau tarif' : 'Fixer le tarif'));
    var price = field(d, 'licence-tarif', 'Prix mensuel en euros hors taxes, par agence');
    price.setAttribute('inputmode', 'decimal');
    var reason = field(d, 'licence-tarif-raison', 'La raison, de 3 à 200 caractères');
    reason.setAttribute('maxlength', '200');
    d.appendChild(button('Publier ce tarif', function () {
      var c = cents(price);
      if (c === null) { state(REFUSALS.bad_price); return; }
      var r = reasonOf(reason);
      if (!r) { state(REFUSALS.bad_reason); return; }
      write('/v1/licences/tarif', { monthlyCents: c, reason: r }, 'Tarif publié : ' + money(c) + ' par mois. Les licences déjà données gardent le leur.', 'Le tarif n’est pas publié.');
    }));
    body.appendChild(d);
  }
  function renderLicence(ul, l, i) {
    var li = el('li');
    li.appendChild(el('strong', l.agencyName));
    li.appendChild(el('p', 'SIREN ' + l.siren + ' · département ' + l.department + (REGION_NAMES[l.region] ? ', ' + REGION_NAMES[l.region] : '') + ' · donnée le ' + date(l.grantedAt) + '.', 'doux'));
    li.appendChild(el('p', stateLine(l)));
    li.appendChild(el('p', priceLine(l), 'doux'));
    cardLine(li, l);
    if (l.state === 'active' || l.state === 'suspendue') {
      var d = el('details');
      d.appendChild(el('summary', 'Changer l’état de cette licence'));
      var reason = field(d, 'licence-raison-' + i, 'La raison, de 3 à 200 caractères');
      reason.setAttribute('maxlength', '200');
      var decide = function (next, okText) {
        var r = reasonOf(reason);
        if (!r) { state(REFUSALS.bad_reason); return false; }
        write('/v1/licences/etat', { licenceId: l.id, state: next, reason: r }, okText, 'L’état n’est pas changé.');
        return true;
      };
      if (l.state === 'active') d.appendChild(button('Suspendre ' + l.agencyName, function () { decide('suspendue', 'Licence de ' + l.agencyName + ' suspendue.'); }));
      else d.appendChild(button('Reprendre ' + l.agencyName, function () { decide('active', 'Licence de ' + l.agencyName + ' reprise.'); }));
      /* Terminer ne se défait pas : un premier appui demande la confirmation, le second envoie. */
      var end = button('Terminer ' + l.agencyName, function () {
        if (!reasonOf(reason)) { state(REFUSALS.bad_reason); return; }
        if (!end.armed) { end.armed = true; end.textContent = 'Confirmer : terminée, la licence ne bouge plus'; return; }
        decide('terminee', 'Licence de ' + l.agencyName + ' terminée : elle ne bouge plus.');
      });
      d.appendChild(end);
      li.appendChild(d);
    }
    ul.appendChild(li);
  }
  function renderGrant(body, tariff) {
    var d = el('details');
    d.appendChild(el('summary', 'Donner une licence'));
    d.appendChild(el('p', tariff ? 'Le prix est celui du tarif en vigueur, ' + money(tariff.monthlyCents) + ' par mois : il ne se saisit pas. La licence ne se donne qu’une fois la phase 5 ouverte.' : 'Fixez d’abord le tarif : le prix ne se saisit pas.', 'doux'));
    var name = field(d, 'licence-agence', 'Nom de l’agence');
    name.setAttribute('maxlength', '120');
    var siren = field(d, 'licence-siren', 'SIREN, 9 chiffres');
    siren.setAttribute('inputmode', 'numeric');
    var card = field(d, 'licence-carte', 'Carte professionnelle, « CPI » et son numéro');
    var until = field(d, 'licence-carte-fin', 'Fin de validité de la carte');
    until.setAttribute('type', 'date');
    var dep = field(d, 'licence-departement', 'Département de l’agence, par exemple 21 ou 2A');
    d.appendChild(button('Donner la licence', function () {
      var n = clean(name);
      if (n.length < 2 || n.length > 120) { state(REFUSALS.bad_name); return; }
      var s = sirenOf(siren);
      if (!s) { state(REFUSALS.siren_invalide); return; }
      var c = clean(card).toUpperCase();
      var u = String(until.value || '').trim();
      if (!CARD.test(c) || !validDay(u)) { state(REFUSALS.carte_invalide); return; }
      var dd = String(dep.value || '').trim().toUpperCase();
      if (DEPARTMENTS.indexOf(dd) < 0) { state(REFUSALS.departement_inconnu); return; }
      write('/v1/licences/licence', { agencyName: n, siren: s, cardNumber: c, cardExpiresOn: u, department: dd }, 'Licence donnée à ' + n + ' au tarif en vigueur. L’agence naît comme son propre réseau.', 'La licence n’est pas donnée.');
    }));
    body.appendChild(d);
  }
  function renderGrantor(body, data) {
    renderTariff(body, data.tariff);
    body.appendChild(el('h4', 'Les licences données'));
    if (!data.licences.length) body.appendChild(el('p', 'Aucune licence donnée pour le moment.', 'doux'));
    else {
      var ul = el('ul', null, 'liste');
      data.licences.forEach(function (l, i) { renderLicence(ul, l, i); });
      body.appendChild(ul);
    }
    renderGrant(body, data.tariff);
  }
  /* La direction d'une agence sous licence : la sienne seule, sans aucun geste [R657]. */
  function renderMine(body, l) {
    body.appendChild(el('h4', 'Votre licence'));
    body.appendChild(el('strong', l.agencyName));
    body.appendChild(el('p', 'Donnée le ' + date(l.grantedAt) + ', département ' + l.department + '.', 'doux'));
    body.appendChild(el('p', stateLine(l)));
    body.appendChild(el('p', priceLine(l), 'doux'));
    cardLine(body, l);
  }
  function show(message) {
    var mine = t.session();
    var turn = ++showing;
    clear($('licences-corps'));
    state('Chargement…');
    function stale(x) { return x.gone || mine !== t.session() || turn !== showing; }
    return send('/v1/licences', 'GET').then(function (x) {
      if (stale(x)) return false;
      var body = $('licences-corps');
      if (x.ok && x.body && x.body.data && Array.isArray(x.body.data.licences)) {
        renderGrantor(body, x.body.data);
        state(message || '');
        return true;
      }
      if (!(x.body && x.body.code === 'agence_licenciee')) { state(why(x, 'Licences indisponibles pour le moment.')); return false; }
      return send('/v1/licences/ma-licence', 'GET').then(function (y) {
        if (stale(y)) return false;
        if (y.ok && y.body && y.body.data && y.body.data.agencyName) {
          renderMine(body, y.body.data);
          state(message || '');
          return true;
        }
        state(why(y, 'Votre licence est indisponible pour le moment.'));
        return false;
      });
    });
  }
  return { show: show };
};
`;
