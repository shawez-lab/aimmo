import { MANDATE_SOURCES } from '../../core/src/mandats/source.ts';

/**
 * La mesure des sources sur l'écran du réseau (G14) : la direction choisit un mois, lit par source les mandats, les
 * rendez-vous, le coût et le coût par mandat, dépose la preuve d'un coût et le saisit, et décide de garder ou d'arrêter
 * une source. Script servi à part (`/app/mesure-sources.js`), chargé au premier geste [R201]. L'écran garde l'ordre reçu
 * et ne recommande rien : il montre des nombres de la base, et chaque décision vient d'un appui de la direction [R144].
 * Une correction s'ajoute à la précédente, rien ne s'efface [R17]. Tout texte reçu est posé en texte, rien ne reste une
 * fois quitté.
 */

const REFUSALS: Record<string, string> = {
  role: 'Ce n’est pas dans vos droits.',
  bad_month: 'Choisissez un mois.',
  bad_source: 'Cette source ne se règle pas ici.',
  bad_amount: 'Le coût : un montant en euros, avec deux décimales au plus.',
  no_proof: 'La preuve n’est pas retrouvée : déposez-la de nouveau.',
  bad_decision: 'Choisissez de garder ou d’arrêter.',
  bad_reason: 'La raison : de 3 à 200 caractères.',
  conflict: 'Une autre saisie vient de passer : relisez le mois, puis recommencez.',
  bad_type: 'La preuve : un fichier PDF, JPEG ou PNG.',
  too_large: 'Cette preuve dépasse 10 Mo : rien n’est envoyé.',
  storage_unavailable: 'Le stockage des preuves n’est pas en service : aucun coût ne peut être rangé pour le moment.',
};
/** Les formats et le poids que la route accepte (`partenaires.ts`, testé égal) : l'écran ne l'importe pas, le serveur redit non. */
export const PROOF_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
export const PROOF_MAX_BYTES = 10 * 1024 * 1024;
const DECISIONS: Record<string, string> = { garder: 'garder', arreter: 'arrêter' };

export const MESURE_SOURCES_ENTRY_HTML = `<section class="bloc" aria-labelledby="titre-mesure">
<h3 id="titre-mesure">Mesure des sources</h3>
<p class="doux">Par source et par mois : les chiffres de la base. Garder ou arrêter une source reste votre décision.</p>
<label for="mesure-mois">Mois (par défaut, le mois passé)</label>
<input id="mesure-mois" type="month">
<button id="mesure-voir" type="button" class="secondaire">Lire le mois</button>
<p id="mesure-etat" class="etat" role="status"></p>
<div id="mesure-corps"></div>
</section>
`;

/** Le chargeur posé dans le script de l'application : l'écran est servi à part, chargé une fois, jamais gardé. */
export const MESURE_SOURCES_JS = `
  /* ---------- La mesure des sources sur l'écran du réseau (G14), chargée au premier geste [R16, R144, R201]. ---------- */
  function wipeMesureSources() {
    clear($('mesure-corps'));
    $('mesure-etat').textContent = '';
    $('mesure-mois').value = '';
  }
  function withMesureSources(act) {
    return withTool('mesure-sources', 'AIMMO_MESURE_SOURCES', 'mesure-etat', 'reseau', act, function () { return { $: $, el: el, clear: clear, send: send, button: button, field: field, details: details, date: date, key: function () { return currentKey; }, session: function () { return session; } }; });
  }
`;

/** Le script servi à part (`/app/mesure-sources.js`). Il ne lit et n'écrit que les routes `/v1/gagner/mesure` [R16]. */
export const MESURE_SOURCES_SCRIPT = `'use strict';
globalThis.AIMMO_MESURE_SOURCES = function (t) {
  var $ = t.$, el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field, details = t.details, date = t.date;
  var REFUSALS = ${JSON.stringify(REFUSALS)};
  var DECISIONS = ${JSON.stringify(DECISIONS)};
  var SETTABLE = ${JSON.stringify(MANDATE_SOURCES)};
  var TYPES = ${JSON.stringify(PROOF_TYPES)};
  var MAX = ${PROOF_MAX_BYTES};
  var BASE = '/v1/gagner/mesure';
  var OFFLINE = 'Pas de réseau. Réessayez dans un moment.';
  /* Une écriture sans réponse, ou coupée par une panne du serveur, a pu passer : l'écran ne dit ni fait ni pas fait. */
  var LOST = 'La réponse n’est pas arrivée : rien n’est sûr. Relisez le mois avant de recommencer.';
  /* Le verrou d'un geste vaut pour sa session : une réponse qui tarde ne bloque pas la connexion suivante. */
  var busy = null, showing = 0;
  function state(text) { $('mesure-etat').textContent = text; }
  function once(work) {
    var mine = t.session();
    if (busy === mine) return Promise.resolve(false);
    busy = mine;
    function done(r) { if (busy === mine) busy = null; return r; }
    return work().then(done, function () { return done(false); });
  }
  function why(res, fallback) {
    if (res.offline) return OFFLINE;
    return (res.body && REFUSALS[res.body.code]) || fallback;
  }
  /* Le mois passé, à l'heure de Paris : celui que la direction lit au début du mois. */
  function lastMonth() {
    var parts = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', year: 'numeric', month: 'numeric' }).formatToParts(new Date(Date.now()));
    function part(type) { return Number(parts.filter(function (p) { return p.type === type; })[0].value); }
    var y = part('year'), m = part('month') - 1;
    if (m === 0) { y -= 1; m = 12; }
    return y + '-' + String(m).padStart(2, '0');
  }
  /* Des centimes, sans passer par un nombre à virgule : 19,99 € font 1999, jamais 1998. Illisible : null, et rien ne part. */
  function cents(text) {
    var m = /^(\\d{1,12})(?:[.,](\\d{1,2}))?$/.exec(String(text || '').replace(/[\\s\\u00a0\\u202f]/g, ''));
    if (!m) return null;
    return Number(m[1]) * 100 + Number(((m[2] || '') + '00').slice(0, 2));
  }
  function euros(c) { return (Number(c) / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'; }
  function count(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  /* Le dépôt d'un fichier, sous la session en cours, la clé dans l'en-tête [R13]. Une clé refusée passe par send, qui sait la retirer et le dire. */
  function upload(file) {
    var key = t.key();
    if (!key) return Promise.resolve({ gone: true });
    var mine = t.session();
    return fetch(BASE + '/preuves', { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': file.type }, body: file, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' }).then(function (r) {
      return r.json().then(function (b) { return b; }, function () { return null; }).then(function (b) {
        if (mine !== t.session()) return { gone: true };
        if (r.status === 401 || (r.status === 403 && b && b.code === 'agent_inactive')) return send(BASE + '/' + lastMonth(), 'GET').then(function () { return { gone: true }; });
        return { status: r.status, ok: r.ok && !!b && b.ok === true, body: b };
      });
    }, function () { return mine !== t.session() ? { gone: true } : { offline: true }; });
  }
  /* Une réponse perdue ou une panne : rien n'est sûr. Un stockage absent, lui, est un refus dit en français. */
  function lost(x) { return x.offline || !x.body || (x.status >= 500 && x.body.code !== 'storage_unavailable'); }
  function write(path, body, done, fallback) {
    return send(BASE + path, 'POST', body).then(function (x) {
      if (x.gone) return false;
      if (lost(x)) { state(LOST); return false; }
      if (!x.ok) { state(why(x, fallback)); return false; }
      return done();
    });
  }
  function renderCost(box, line, i, month) {
    var form = details(box, 'Saisir le coût du mois');
    var amount = field(form, 'mesure-montant-' + i, 'Coût du mois, en euros');
    amount.setAttribute('inputmode', 'decimal');
    var proof = field(form, 'mesure-preuve-' + i, 'Sa preuve : facture ou relevé, en PDF, JPEG ou PNG');
    proof.setAttribute('type', 'file');
    proof.setAttribute('accept', TYPES.join(','));
    form.appendChild(el('p', 'Une correction s’ajoute à la précédente, qui reste rangée.', 'doux'));
    /* La preuve n'est pas renvoyée tant que le fichier reste le même. */
    var sent = null;
    form.appendChild(button('Ranger le coût', function () {
      var c = cents(amount.value);
      if (c === null || !Number.isSafeInteger(c)) { state(REFUSALS.bad_amount); return; }
      var file = proof.files && proof.files.length === 1 ? proof.files[0] : null;
      if (!file) { state('Choisissez la preuve de ce coût.'); return; }
      if (TYPES.indexOf(file.type) === -1) { state(REFUSALS.bad_type); return; }
      if (file.size > MAX) { state(REFUSALS.too_large); return; }
      once(function () {
        state('Envoi…');
        var ready = sent && sent.file === file ? Promise.resolve(sent.ref) : upload(file).then(function (x) {
          if (x.gone) return null;
          if (lost(x)) { state(LOST); return null; }
          if (!x.ok || !x.body.data || typeof x.body.data.proofRef !== 'string') { state(why(x, 'La preuve n’est pas rangée.')); return null; }
          sent = { file: file, ref: x.body.data.proofRef };
          return sent.ref;
        });
        return ready.then(function (ref) {
          if (ref === null) return false;
          return write('/couts', { month: month, source: line.source, amountCents: c, proofRef: ref }, function () { return read(month, 'Coût rangé, avec sa preuve.'); }, 'Le coût n’est pas rangé.');
        });
      });
    }));
  }
  function renderDecision(box, line, i, month) {
    var form = details(box, 'Garder ou arrêter cette source');
    var reason = field(form, 'mesure-raison-' + i, 'Votre raison', 'textarea');
    reason.setAttribute('maxlength', '200');
    form.appendChild(el('p', 'Une nouvelle décision s’ajoute aux précédentes. Rien ne s’arrête tout seul.', 'doux'));
    ['garder', 'arreter'].forEach(function (d) {
      form.appendChild(button(d === 'garder' ? 'Garder cette source' : 'Arrêter cette source', function () {
        var text = String(reason.value || '').trim();
        if (text.length < 3 || text.length > 200) { state(REFUSALS.bad_reason); return; }
        once(function () {
          state('Envoi…');
          return write('/decisions', { month: month, source: line.source, decision: d, reason: text }, function () { return read(month, 'Décision rangée : ' + DECISIONS[d] + '.'); }, 'La décision n’est pas rangée.');
        });
      }));
    });
  }
  function renderLine(ul, line, i, month) {
    var li = el('li');
    li.appendChild(el('strong', line.label));
    li.appendChild(el('p', count(line.mandates, 'mandat signé', 'mandats signés') + ' · ' + count(line.appointments, 'rendez-vous tenu', 'rendez-vous tenus')));
    var cost = line.costCents === null ? 'Coût non saisi.' : 'Coût : ' + euros(line.costCents) + (line.costPerMandateCents === null ? ', aucun mandat sur ce mois.' : ', soit ' + euros(line.costPerMandateCents) + ' par mandat.');
    li.appendChild(el('p', cost, 'doux'));
    if (line.decision) li.appendChild(el('p', 'Votre dernière décision : ' + (DECISIONS[line.decision.decision] || line.decision.decision) + ', le ' + date(line.decision.decidedAt) + ', sur le mois ' + line.decision.month + '.'));
    if (SETTABLE.indexOf(line.source) !== -1) {
      renderCost(li, line, i, month);
      renderDecision(li, line, i, month);
    }
    ul.appendChild(li);
  }
  /* Le mois lu : seule la dernière lecture demandée s'affiche, dans l'ordre reçu, jamais retrié [R144]. */
  function read(month, message) {
    var mine = t.session();
    var turn = ++showing;
    clear($('mesure-corps'));
    state('Chargement…');
    return send(BASE + '/' + encodeURIComponent(month), 'GET').then(function (res) {
      if (res.gone || mine !== t.session() || turn !== showing) return false;
      if (!res.ok || !res.body.data || !Array.isArray(res.body.data.lines)) { state((message ? message + ' ' : '') + why(res, 'Mesure indisponible pour le moment.')); return false; }
      var d = res.body.data, body = $('mesure-corps');
      body.appendChild(el('h4', 'Mois ' + d.month));
      body.appendChild(el('p', 'En tout : ' + count(d.totals.mandates, 'mandat signé', 'mandats signés') + ', ' + count(d.totals.appointments, 'rendez-vous tenu', 'rendez-vous tenus') + ', ' + euros(d.totals.costCents) + ' de coûts saisis.'));
      var ul = el('ul', null, 'liste');
      d.lines.forEach(function (line, i) { renderLine(ul, line, i, d.month); });
      body.appendChild(ul);
      state(message || '');
      return true;
    });
  }
  function show() {
    var month = String($('mesure-mois').value || '');
    if (month === '') {
      month = lastMonth();
      $('mesure-mois').value = month;
    }
    if (!/^\\d{4}-(0[1-9]|1[0-2])$/.test(month)) { state(REFUSALS.bad_month); return Promise.resolve(false); }
    return read(month, '');
  }
  return { show: show };
};
`;
