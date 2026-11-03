import type { MarketRentKind } from '../../core/src/investir/loyers.ts';

/**
 * Les loyers de marché sur l'écran du réseau (Y10) : la direction dépose le fichier de la Carte des loyers de l'ANIL, un
 * par type de logement et par millésime, voit l'avancée jusqu'au bout, et lit le loyer d'une commune pour vérifier. Script
 * servi à part (`/app/loyers.js`), chargé au premier geste [R201]. L'écran ne lit ni ne corrige le fichier : le serveur le
 * contrôle, le refuse ligne à ligne sans rien ranger, et rend les chiffres, leur source, leur date et leur fiabilité
 * [R10, R122]. Un gros fichier se range en plusieurs appels du même fichier, repris où il en était.
 */

/** Le poids admis par la route `/v1/investir/loyers` (`MAX_RENTS_FILE_BYTES`, vérifié par un test). */
export const LOYERS_MAX_BYTES = 8 * 1024 * 1024;

const KINDS: readonly (readonly [MarketRentKind, string])[] = [
  ['apartment', 'Appartements, toutes tailles'],
  ['apartment_t1_t2', 'Appartements, T1 et T2'],
  ['apartment_t3_plus', 'Appartements, T3 et plus'],
  ['house', 'Maisons'],
];
const REFUSALS: Record<string, string> = {
  role: 'Ce n’est pas dans vos droits.',
  type: 'Choisissez le type de logement du fichier.',
  millesime: 'Le millésime : l’année du fichier, en quatre chiffres.',
  vide: 'Ce fichier est vide : rien n’est rangé.',
  entete: 'Ce fichier n’a pas les colonnes de la Carte des loyers (INSEE_C, loypredm2, lwr.IPm2, upr.IPm2, nbobs_com) : rien n’est rangé.',
  trop_long: 'Ce fichier a trop de lignes pour être la Carte des loyers : rien n’est rangé.',
  invalid_body: 'Ce fichier n’a pas pu être envoyé : il est peut-être trop lourd. Rien n’est rangé.',
};
const ROWS: Record<string, string> = {
  guillemets: 'guillemets mal placés',
  colonnes: 'il manque des colonnes',
  insee: 'code de commune illisible',
  loyer: 'loyer illisible',
  bornes: 'bornes de l’intervalle illisibles',
  observations: 'nombre d’observations illisible',
  doublon: 'commune déjà présente plus haut',
};

const options = KINDS.map(([k, label]) => `<option value="${k}">${label}</option>`).join('');

export const LOYERS_ENTRY_HTML = `<section class="bloc" aria-labelledby="titre-loyers">
<h3 id="titre-loyers">Loyers de marché</h3>
<p class="doux">Un fichier de la Carte des loyers de l’ANIL, sur data.gouv.fr, par type de logement. Le millésime ne change plus une fois le fichier rangé.</p>
<label for="loyers-type">Type de logement du fichier</label>
<select id="loyers-type"><option value="">Choisir le type</option>${options}</select>
<label for="loyers-millesime">Millésime du fichier</label>
<input id="loyers-millesime" inputmode="numeric" maxlength="4">
<label for="loyers-fichier">Fichier (CSV)</label>
<input id="loyers-fichier" type="file" accept=".csv,text/csv,text/plain">
<button id="loyers-importer" type="button" class="secondaire">Importer ce fichier</button>
<label for="loyers-commune">Vérifier une commune, par son code INSEE</label>
<input id="loyers-commune" maxlength="5">
<button id="loyers-lire" type="button" class="secondaire">Lire le loyer de cette commune</button>
<p id="loyers-etat" class="etat" role="status"></p>
<ul id="loyers-liste" class="liste"></ul>
</section>
`;

/** Le chargeur posé dans le script de l'application : l'écran est servi à part, chargé une fois, jamais gardé. */
export const LOYERS_JS = `
  /* ---------- Les loyers de marché sur l'écran du réseau (Y10), chargés au premier geste [R16, R201]. ---------- */
  var loyersTools = null, loyersLoading = false;
  function wipeLoyers() {
    clear($('loyers-liste'));
    $('loyers-etat').textContent = '';
    ['loyers-type', 'loyers-millesime', 'loyers-fichier', 'loyers-commune'].forEach(function (id) { $(id).value = ''; });
  }
  function withLoyers(act) {
    if (!currentKey) return Promise.resolve(false);
    if (loyersTools) return act(loyersTools);
    if (loyersLoading) return Promise.resolve(false);
    loyersLoading = true;
    var mine = session;
    $('loyers-etat').textContent = 'Chargement…';
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.setAttribute('src', '/app/loyers.js');
      s.addEventListener('load', function () {
        loyersLoading = false;
        var make = globalThis.AIMMO_LOYERS;
        try { delete globalThis.AIMMO_LOYERS; } catch (e) { /* rien */ }
        if (mine !== session) { resolve(false); return; }
        if (typeof make !== 'function') { $('loyers-etat').textContent = 'Indisponible pour le moment. Réessayez dans un moment.'; resolve(false); return; }
        loyersTools = make({ $: $, el: el, clear: clear, send: send, date: date, session: function () { return session; } });
        resolve(act(loyersTools));
      });
      s.addEventListener('error', function () {
        loyersLoading = false;
        if (mine === session) $('loyers-etat').textContent = 'Pas de réseau. Réessayez dans un moment.';
        resolve(false);
      });
      $('reseau').appendChild(s);
    });
  }
`;

/** Le script servi à part (`/app/loyers.js`). Il ne lit et n'écrit que la route des loyers [R16], et ne garde rien. */
export const LOYERS_SCRIPT = `'use strict';
globalThis.AIMMO_LOYERS = function (t) {
  var $ = t.$, el = t.el, clear = t.clear, send = t.send, date = t.date;
  var REFUSALS = ${JSON.stringify(REFUSALS)};
  var ROWS = ${JSON.stringify(ROWS)};
  var KINDS = ${JSON.stringify(Object.fromEntries(KINDS))};
  var MAX = ${LOYERS_MAX_BYTES};
  /* Rien ne se perd : le même fichier reprend après les lignes déjà rangées. */
  var LOST = 'La réponse n’est pas arrivée : rien n’est sûr. Rien n’est perdu : déposez le même fichier, l’import reprend où il en était.';
  var STALLED = 'L’import n’avance plus : déposez le même fichier dans un moment, il reprendra où il en était.';
  /* Au plus ce nombre d'appels de suite sans une ligne de plus : jamais de boucle sans fin. */
  var MAX_STALLS = 3, SHOWN = 20;
  var busy = null;
  function state(text) { $('loyers-etat').textContent = text; }
  function line(text) { $('loyers-liste').appendChild(el('li', text)); }
  function once(work) {
    var mine = t.session();
    if (busy === mine) return Promise.resolve(false);
    busy = mine;
    function done(r) { if (busy === mine) busy = null; return r; }
    return work().then(done, function () { return done(false); });
  }
  function refused(res) {
    var body = res.body || {};
    var errors = Array.isArray(body.errors) ? body.errors : [];
    if (body.code === 'lignes' && errors.length) {
      state('Fichier refusé : ' + errors.length + ' ligne(s) à reprendre. Rien n’est rangé.');
      errors.slice(0, SHOWN).forEach(function (e) { line('Ligne ' + e.line + ' : ' + (ROWS[e.code] || 'ligne illisible') + '.'); });
      if (errors.length > SHOWN) line('Et ' + (errors.length - SHOWN) + ' autre(s).');
      return;
    }
    if (body.code === 'millesime_different') { state('Ce fichier est déjà rangé avec le millésime ' + body.vintage + ', qui ne change plus : rien de nouveau n’est rangé.'); return; }
    state(REFUSALS[body.code] || 'Le fichier est refusé : rien n’est rangé.');
  }
  function step(mine, payload, last, stalls) {
    return send('/v1/investir/loyers', 'POST', payload).then(function (res) {
      if (res.gone || mine !== t.session()) return false;
      if (res.offline || !res.body || res.status >= 500) { state(LOST); return false; }
      if (!res.ok) { refused(res); return false; }
      var v = res.body.data;
      if (!v) { state(LOST); return false; }
      if (v.status === 'complet') {
        state(v.created === false && v.stored === v.rows && last < 0 ? 'Ce fichier est importé en entier : ' + v.rows + ' ligne(s).' : 'Import fait : ' + v.rows + ' ligne(s) rangées.');
        $('loyers-fichier').value = '';
        return true;
      }
      var seen = stalls + (v.stored > last ? 0 : 1);
      if (seen >= MAX_STALLS) { state(STALLED); return false; }
      state('Import en cours : ' + v.stored + ' ligne(s) sur ' + v.rows + '. Gardez cet écran ouvert.');
      return step(mine, payload, Math.max(last, v.stored), v.stored > last ? 0 : seen);
    });
  }
  function deposit() {
    var kind = $('loyers-type').value;
    var vintage = String($('loyers-millesime').value || '').trim();
    var files = $('loyers-fichier').files;
    var file = files && files.length === 1 ? files[0] : null;
    if (!kind) { state(REFUSALS.type); return Promise.resolve(false); }
    if (!/^\\d{4}$/.test(vintage)) { state(REFUSALS.millesime); return Promise.resolve(false); }
    if (!file) { state('Choisissez le fichier.'); return Promise.resolve(false); }
    if (file.size > MAX) { state('Ce fichier dépasse 8 Mo : rien n’est envoyé.'); return Promise.resolve(false); }
    return once(function () {
      var mine = t.session();
      clear($('loyers-liste'));
      state('Envoi…');
      return file.text().then(function (csv) {
        if (mine !== t.session()) return false;
        return step(mine, { kind: kind, vintage: Number(vintage), csv: csv }, -1, 0);
      }, function () {
        if (mine === t.session()) state('Fichier illisible sur cet appareil : rien n’est envoyé.');
        return false;
      });
    });
  }
  function euros(cents) { return (Number(cents) / 100).toFixed(2).replace('.', ',') + ' €'; }
  function read() {
    var insee = String($('loyers-commune').value || '').trim().toUpperCase();
    var kind = $('loyers-type').value;
    if (!/^(\\d{5}|2[AB]\\d{3})$/.test(insee)) { state('Le code INSEE : cinq caractères, par exemple 21231.'); return Promise.resolve(false); }
    if (!kind) { state(REFUSALS.type); return Promise.resolve(false); }
    return once(function () {
      var mine = t.session();
      clear($('loyers-liste'));
      state('Chargement…');
      return send('/v1/investir/loyers?insee=' + encodeURIComponent(insee) + '&type=' + encodeURIComponent(kind), 'GET').then(function (res) {
        if (res.gone || mine !== t.session()) return false;
        if (res.offline) { state('Pas de réseau. Réessayez dans un moment.'); return false; }
        if (!res.ok || !res.body.data) { state((res.body && REFUSALS[res.body.code]) || 'Indisponible pour le moment.'); return false; }
        var v = res.body.data;
        if (v.status !== 'connu') { state('Inconnu : aucune donnée pour cette commune et ce type. Aucun loyer n’est donné.'); return true; }
        state('');
        line(euros(v.rentM2Cents) + ' le m², charges comprises, entre ' + euros(v.lowerM2Cents) + ' et ' + euros(v.upperM2Cents) + '.');
        line(v.observations + ' observation(s)' + (v.reliability === 'fiable' ? '.' : ' : peu d’observations, chiffre à prendre avec prudence.'));
        line(v.source === 'anil' ? 'Carte des loyers ' + v.vintage + ', ' + (KINDS[v.kind] || 'type non précisé').toLowerCase() + (v.kind !== kind ? ', faute de données pour le type demandé' : '') + ', importée le ' + date(v.asOf) + '.' : 'Locations du réseau dans la commune, tous types confondus, au ' + date(v.asOf) + '.');
        line(v.citation);
        return true;
      });
    });
  }
  return { deposit: deposit, read: read };
};
`;
