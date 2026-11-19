import { COMMUNE_RULE_LABELS } from '../../core/src/investir/contraintes.ts';
import type { MarketRentKind } from '../../core/src/investir/loyers.ts';

/**
 * Les loyers de marché sur l'écran du réseau (Y10) : la direction dépose le fichier de la Carte des loyers de l'ANIL, un
 * par type de logement et par millésime, voit l'avancée jusqu'au bout, et lit le loyer d'une commune pour vérifier. Script
 * servi à part (`/app/loyers.js`), chargé au premier geste [R201]. L'écran ne lit ni ne corrige le fichier : le serveur le
 * contrôle, le refuse ligne à ligne sans rien ranger, et rend les chiffres, leur source, leur date et leur fiabilité
 * [R10, R122]. Un gros fichier se range en plusieurs appels du même fichier, repris où il en était.
 *
 * La vérification d'une commune dit aussi ses règles de location, chacune avec sa source, et la direction en range
 * (Y11) [R16, R10]. Une règle rangée ne se réécrit pas : le code de la commune est relu avant d'écrire.
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

const RULE_REFUSALS: Record<string, string> = {
  insee: 'Le code INSEE : cinq caractères, par exemple 21231.',
  regle: 'Choisissez la règle.',
  source: 'Écrivez la source de la règle : d’où elle vient, en 300 caractères au plus.',
  date_source: 'La date de la source : un jour déjà passé.',
  date: 'Les dates de la règle : un début, et une fin qui ne vient pas avant lui.',
  role: 'Ce n’est pas dans vos droits.',
};

const ZONE_REFUSALS: Record<string, string> = {
  bad_insee: 'Le code INSEE : cinq caractères, par exemple 21231.',
  bad_zone: 'Choisissez la zone.',
  bad_date: 'Le jour d’entrée en vigueur de la zone n’est pas valable.',
  bad_source: 'Écrivez la source de la zone : d’où elle vient, de 3 à 200 caractères.',
  already_recorded: 'Une zone est déjà rangée à cette date : rien n’est changé. Pour corriger, choisissez une date d’effet plus récente.',
  role: 'Ce n’est pas dans vos droits.',
};
const ZONES = { tres_tendue: 'Zone très tendue', tendue: 'Zone tendue', autre: 'Autre zone' };

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
<label for="loyers-commune">Vérifier une commune, par son code INSEE : son loyer et ses règles de location</label>
<input id="loyers-commune" maxlength="5">
<button id="loyers-lire" type="button" class="secondaire">Lire cette commune</button>
<p id="loyers-etat" class="etat" role="status"></p>
<ul id="loyers-liste" class="liste"></ul>
</section>
`;

/** Le chargeur posé dans le script de l'application : l'écran est servi à part, chargé une fois, jamais gardé. */
export const LOYERS_JS = `
  /* ---------- Les loyers de marché sur l'écran du réseau (Y10), chargés au premier geste [R16, R201]. ---------- */
  function wipeLoyers() {
    clear($('loyers-liste'));
    $('loyers-etat').textContent = '';
    ['loyers-type', 'loyers-millesime', 'loyers-fichier', 'loyers-commune'].forEach(function (id) { $(id).value = ''; });
  }
  function withLoyers(act) {
    return withTool('loyers', 'AIMMO_LOYERS', 'loyers-etat', 'reseau', act, function () { return { $: $, el: el, clear: clear, send: send, date: date, button: button, field: field, select: select, session: function () { return session; } }; });
  }
`;

/** Le script servi à part (`/app/loyers.js`). Il ne lit et n'écrit que la route des loyers [R16], et ne garde rien. */
export const LOYERS_SCRIPT = `'use strict';
globalThis.AIMMO_LOYERS = function (t) {
  var $ = t.$, el = t.el, clear = t.clear, send = t.send, date = t.date;
  var RULES = ${JSON.stringify(COMMUNE_RULE_LABELS)};
  var RULE_REFUSALS = ${JSON.stringify(RULE_REFUSALS)};
  var ZONE_REFUSALS = ${JSON.stringify(ZONE_REFUSALS)};
  var ZONES = ${JSON.stringify(ZONES)};
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
  /* Y11 · les règles de la commune, chacune avec sa source ; « aucune » n'est jamais une preuve [R10]. */
  function day(d) { return date(d + 'T12:00:00Z'); }
  function rules(mine, insee, message) {
    // Dit avant la relecture : une règle rangée le reste, même si la relecture se perd.
    if (message) state(message);
    var box = el('li');
    $('loyers-liste').appendChild(box);
    box.appendChild(el('h4', 'Règles de location de la commune ' + insee));
    return send('/v1/investir/regles?insee=' + encodeURIComponent(insee), 'GET').then(function (res) {
      if (res.gone || mine !== t.session()) return false;
      var data = res.ok && res.body.data;
      if (!data || !Array.isArray(data.rules)) {
        box.appendChild(el('p', res.offline ? 'Pas de réseau pour les règles de cette commune.' : (res.body && RULE_REFUSALS[res.body.code]) || 'Règles indisponibles pour le moment.', 'etat'));
        return false;
      }
      if (!data.rules.length) box.appendChild(el('p', 'Aucune règle rangée en vigueur. Cela ne prouve pas qu’il n’y en a pas : vérifiez auprès de la mairie.', 'doux'));
      data.rules.forEach(function (r) {
        box.appendChild(el('p', (RULES[r.rule] || r.label || 'Règle') + ', depuis le ' + day(r.effectiveFrom) + (r.effectiveUntil ? ', jusqu’au ' + day(r.effectiveUntil) : '') + '. Source : ' + r.source + ', ' + day(r.sourceDate) + '.'));
      });
      if (data.canRecord) { ruleForm(box, insee); return zoneForm(box, insee); }
      return true;
    });
  }
  function ruleForm(box, insee) {
    box.appendChild(el('h4', 'Ranger une règle pour la commune ' + insee));
    box.appendChild(el('p', 'Une règle rangée ne se réécrit pas. Pour une même sorte, la dernière rangée décide : une règle déjà finie met fin à celle rangée avant elle.', 'doux'));
    var kind = t.select(box, 'loyers-regle-sorte', 'Règle', Object.assign({ '': 'Choisissez la règle' }, RULES), '');
    var from = t.field(box, 'loyers-regle-debut', 'En vigueur depuis');
    from.setAttribute('type', 'date');
    var until = t.field(box, 'loyers-regle-fin', 'Jusqu’au, si elle a une fin');
    until.setAttribute('type', 'date');
    var source = t.field(box, 'loyers-regle-source', 'Source : la délibération ou le texte');
    source.setAttribute('maxlength', '300');
    var sourceDate = t.field(box, 'loyers-regle-source-date', 'Date de la source');
    sourceDate.setAttribute('type', 'date');
    box.appendChild(t.button('Ranger cette règle', function () {
      return once(function () {
        var mine = t.session();
        // Le champ a changé depuis la lecture : la règle irait à une autre commune que celle écrite.
        if (String($('loyers-commune').value || '').trim().toUpperCase() !== insee) { state('Le code de la commune a changé : relisez cette commune avant de ranger. Rien n’est rangé.'); return Promise.resolve(false); }
        state('Envoi…');
        return send('/v1/investir/regles', 'POST', { inseeCode: insee, rule: kind.value, effectiveFrom: from.value, effectiveUntil: until.value || null, source: source.value, sourceDate: sourceDate.value }).then(function (res) {
          if (res.gone || mine !== t.session()) return false;
          if (res.offline || !res.body || res.status >= 500) { state('La réponse n’est pas arrivée : rien n’est sûr. Relisez cette commune avant de recommencer.'); return false; }
          if (!res.ok) { state(RULE_REFUSALS[res.body.code] || 'La règle n’est pas rangée.'); return false; }
          var v = res.body.data || {};
          var ended = v.effectiveUntil && v.effectiveUntil < new Date().toISOString().slice(0, 10);
          clear($('loyers-liste'));
          return rules(mine, insee, ended ? 'Règle rangée, finie le ' + day(v.effectiveUntil) + ' : elle n’est plus en vigueur, et met fin à celle de même sorte rangée avant.' : 'Règle rangée, en vigueur à partir du ' + day(v.effectiveFrom) + '.');
        });
      });
    }));
  }
  /* X21 · La zone décide du plafond des honoraires de location [R102] : sans elle, le plafond le plus bas s'applique. */
  function zoneForm(box, insee) {
    box.appendChild(el('h4', 'Zone de loyer de la commune ' + insee));
    var slot = el('div');
    box.appendChild(slot);
    return send('/v1/location/zones?insee=' + encodeURIComponent(insee), 'GET').then(function (res) {
      if (res.gone) return false;
      // Sans la liste, on ne sait pas si la zone saisie décidera : pas de formulaire à l'aveugle.
      if (!res.ok || !Array.isArray(res.body.data)) { slot.appendChild(el('p', res.offline ? 'Pas de réseau pour la zone de cette commune.' : (res.body && ZONE_REFUSALS[res.body.code]) || 'Zone indisponible pour le moment.', 'alerte')); return false; }
      zoneFields(slot, insee, res.body.data);
      return true;
    });
  }
  function zoneFields(box, insee, zones) {
    var today = new Date().toISOString().slice(0, 10);
    var deciding = zones.filter(function (z) { return z.effectiveFrom <= today; })[0];
    if (!zones.length) box.appendChild(el('p', 'Aucune zone rangée : le plafond le plus bas s’applique.', 'doux'));
    zones.forEach(function (z) {
      var when = z.effectiveFrom > today ? 'à venir : décide déjà pour un bail qui commence à partir du ' : z === deciding ? 'en vigueur depuis le ' : 'remplacée, depuis le ';
      box.appendChild(el('p', (ZONES[z.zone] || 'Zone') + ', ' + when + day(z.effectiveFrom) + '. Source : ' + z.source + '.', z === deciding ? null : 'doux'));
    });
    box.appendChild(el('p', 'Elle fixe le plafond des honoraires de location. Une zone rangée ne se réécrit pas : celle dont la date d’effet est la plus récente décide. Pour corriger une erreur, rangez la bonne zone à une date d’effet plus récente.', 'doux'));
    var zone = t.select(box, 'loyers-zone', 'Zone', Object.assign({ '': 'Choisissez la zone' }, ZONES), '');
    var from = t.field(box, 'loyers-zone-debut', 'Zone en vigueur depuis');
    from.setAttribute('type', 'date');
    var source = t.field(box, 'loyers-zone-source', 'Source de la zone : le texte qui la fixe');
    source.setAttribute('maxlength', '200');
    var armed = null;
    box.appendChild(t.button('Ranger cette zone', function () {
      return once(function () {
        var mine = t.session();
        if (String($('loyers-commune').value || '').trim().toUpperCase() !== insee) { state('Le code de la commune a changé : relisez cette commune avant de ranger. Rien n’est rangé.'); return Promise.resolve(false); }
        // Les valeurs envoyées sont gardées : le message dit ce qui est rangé, même si un champ change pendant l'envoi.
        var sent = { inseeCode: insee, zone: zone.value, effectiveFrom: from.value, source: source.value };
        if (!sent.zone) { state(ZONE_REFUSALS.bad_zone); return Promise.resolve(false); }
        var latest = zones[0];
        var odd = sent.effectiveFrom > today ? 'Cette date est dans le futur : la zone décidera dès maintenant pour les baux qui commencent après elle.'
          : latest && sent.effectiveFrom && sent.effectiveFrom < latest.effectiveFrom ? 'Cette date est plus ancienne que celle de la zone rangée du ' + day(latest.effectiveFrom) + ' : elle ne changera pas la zone en vigueur.' : null;
        var entry = JSON.stringify(sent);
        if (odd && armed !== entry) { armed = entry; state(odd + ' Vérifiez, puis appuyez de nouveau.'); return Promise.resolve(false); }
        armed = null;
        state('Envoi…');
        return send('/v1/location/zones', 'POST', sent).then(function (res) {
          if (res.gone || mine !== t.session()) return false;
          if (res.offline || !res.body || res.status >= 500) { state('La réponse n’est pas arrivée : rien n’est sûr. Relisez cette commune avant de recommencer.'); return false; }
          if (!res.ok) { state(ZONE_REFUSALS[res.body.code] || 'La zone n’est pas rangée.'); return false; }
          clear($('loyers-liste'));
          return rules(mine, insee, ZONES[sent.zone] + ' rangée, avec effet au ' + day(sent.effectiveFrom) + '.');
        });
      });
    }));
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
        if (v.status !== 'connu') { state('Inconnu : aucune donnée pour cette commune et ce type. Aucun loyer n’est donné.'); return rules(mine, insee, ''); }
        state('');
        line(euros(v.rentM2Cents) + ' le m², charges comprises, entre ' + euros(v.lowerM2Cents) + ' et ' + euros(v.upperM2Cents) + '.');
        line(v.observations + ' observation(s)' + (v.reliability === 'fiable' ? '.' : ' : peu d’observations, chiffre à prendre avec prudence.'));
        line(v.source === 'anil' ? 'Carte des loyers ' + v.vintage + ', ' + (KINDS[v.kind] || 'type non précisé').toLowerCase() + (v.kind !== kind ? ', faute de données pour le type demandé' : '') + ', importée le ' + date(v.asOf) + '.' : 'Locations du réseau dans la commune, tous types confondus, au ' + date(v.asOf) + '.');
        line(v.citation);
        return rules(mine, insee, '');
      });
    });
  }
  return { deposit: deposit, read: read };
};
`;
