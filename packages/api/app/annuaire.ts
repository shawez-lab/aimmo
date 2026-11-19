import { CERTIFIED_DOMAINS, CREDENTIAL_KINDS, PARTNER_TRADES, REQUIRED_CREDENTIALS } from '../../core/src/partenaires/annuaire.ts';

/**
 * L'annuaire des partenaires sur l'écran du réseau (U13) : la direction cherche par métier et code postal, ajoute un
 * partenaire, ses zones et ses justificatifs avec leur preuve, lit pourquoi il n'est pas proposable, range son adresse
 * professionnelle et son accord, note son opposition. Script servi à part (`/app/annuaire.js`), chargé au premier geste
 * [R201]. L'écran garde l'ordre reçu : ni note, ni rang, ni avis [R14, R73] ; le serveur décide de ce qui est proposable.
 * Tout texte reçu est posé en texte, rien ne reste une fois quitté.
 */

const REFUSALS: Record<string, string> = {
  role: 'Ce n’est pas dans vos droits.',
  unknown: 'Ce partenaire n’est pas dans l’annuaire de ce réseau.',
  unknown_trade: 'Choisissez le métier.',
  bad_name: 'Le nom de l’entreprise : de 2 à 120 caractères.',
  bad_postcodes: 'Les codes postaux : 5 chiffres chacun, 50 au plus, séparés par un espace ou une virgule.',
  bad_postcode: 'Le code postal : 5 chiffres.',
  domain_required: 'Pour un diagnostiqueur, choisissez le domaine.',
  bad_domain: 'Choisissez le domaine de cette certification.',
  unknown_kind: 'Choisissez le justificatif.',
  kind_not_for_trade: 'Ce justificatif n’est pas demandé pour ce métier.',
  bad_number: 'Le numéro : 40 caractères au plus, lettres, chiffres, espace, point, / et -.',
  bad_dates: 'Les dates de validité : la fin ne vient pas avant le début.',
  bad_ref: 'La preuve n’est pas reconnue : déposez-la de nouveau.',
  not_stored: 'La preuve n’est pas retrouvée : déposez-la de nouveau.',
  ref_used: 'Cette preuve est déjà rangée : relisez la fiche.',
  busy: 'Une autre saisie vient de passer : relisez la fiche, puis recommencez.',
  bad_email: 'L’adresse mail n’est pas lisible.',
  bad_proof: 'Dites où et quand il a donné son accord : de 3 à 500 caractères.',
  opposed: 'Ce partenaire a demandé l’arrêt : il ne reçoit plus rien, une nouvelle adresse ne le rouvre pas.',
  bad_type: 'La preuve : un fichier PDF, JPEG ou PNG.',
  too_large: 'Cette preuve dépasse 10 Mo : rien n’est envoyé.',
  storage_unavailable: 'Le stockage des preuves n’est pas en service : aucun justificatif ne peut être rangé pour le moment.',
};
const STATES: Record<string, string> = { manquant: 'manquant', a_venir: 'à venir', echu: 'échu', valide: 'valide' };
/** Les formats et le poids que la route accepte (`partenaires.ts`, testé égal) : l'écran ne l'importe pas, le serveur redit non. */
export const ANNUAIRE_PROOF_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
export const ANNUAIRE_PROOF_MAX_BYTES = 10 * 1024 * 1024;
const TRADES = Object.fromEntries(PARTNER_TRADES.map((t) => [t.trade, t.label]));
const KINDS = Object.fromEntries(CREDENTIAL_KINDS.map((k) => [k.kind, k.label]));
const DOMAINS = Object.fromEntries(CERTIFIED_DOMAINS.map((d) => [d.domain, d.label]));

export const ANNUAIRE_ENTRY_HTML = `<section class="bloc" aria-labelledby="titre-annuaire">
<h3 id="titre-annuaire">Annuaire des partenaires</h3>
<p class="doux">Un partenaire n’est proposé aux clients que si ses justificatifs sont valides ce jour-là.</p>
<button id="annuaire-ouvrir" type="button" class="secondaire">Ouvrir l’annuaire</button>
<p id="annuaire-etat" class="etat" role="status"></p>
<div id="annuaire-corps"></div>
</section>
`;

/** Le chargeur posé dans le script de l'application : l'écran est servi à part, chargé une fois, jamais gardé. */
export const ANNUAIRE_JS = `
  /* ---------- L'annuaire des partenaires sur l'écran du réseau (U13), chargé au premier geste [R16, R73, R201]. ---------- */
  function wipeAnnuaire() {
    clear($('annuaire-corps'));
    $('annuaire-etat').textContent = '';
  }
  function withAnnuaire(act) {
    return withTool('annuaire', 'AIMMO_ANNUAIRE', 'annuaire-etat', 'reseau', act, function () { return { $: $, el: el, clear: clear, send: send, button: button, field: field, select: select, details: details, key: function () { return currentKey; }, session: function () { return session; } }; });
  }
`;

/** Le script servi à part (`/app/annuaire.js`). Il ne lit et n'écrit que les routes `/v1/partenaires/annuaire` [R16]. */
export const ANNUAIRE_SCRIPT = `'use strict';
globalThis.AIMMO_ANNUAIRE = function (t) {
  var $ = t.$, el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field, select = t.select, details = t.details;
  var REFUSALS = ${JSON.stringify(REFUSALS)};
  var STATES = ${JSON.stringify(STATES)};
  var TRADES = ${JSON.stringify(TRADES)};
  var KINDS = ${JSON.stringify(KINDS)};
  var DOMAINS = ${JSON.stringify(DOMAINS)};
  var REQUIRED = ${JSON.stringify(REQUIRED_CREDENTIALS)};
  var TYPES = ${JSON.stringify(ANNUAIRE_PROOF_TYPES)};
  var MAX = ${ANNUAIRE_PROOF_MAX_BYTES};
  var BASE = '/v1/partenaires/annuaire';
  var OFFLINE = 'Pas de réseau. Réessayez dans un moment.';
  /* Une écriture sans réponse, ou coupée par une panne du serveur, a pu passer : l'écran ne dit ni fait ni pas fait. */
  var LOST = 'La réponse n’est pas arrivée : rien n’est sûr. Relisez la fiche avant de recommencer.';
  /* Le verrou d'un geste vaut pour sa session : une réponse qui tarde ne bloque pas la connexion suivante. */
  var busy = null, turn = 0;
  function state(text) { $('annuaire-etat').textContent = text; }
  function body() { return $('annuaire-corps'); }
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
  /* Une réponse perdue ou une panne : rien n'est sûr. Un stockage absent, lui, est un refus dit en français. */
  function lost(x) { return x.offline || !x.body || (x.status >= 500 && x.body.code !== 'storage_unavailable'); }
  function path(id, end) { return BASE + '/' + encodeURIComponent(id) + (end || ''); }
  /* Des codes postaux saisis à la main : un espace, une virgule ou un retour à la ligne les sépare. Le serveur les contrôle. */
  function postcodes(text) { return String(text || '').split(/[\\s,;]+/).filter(function (p) { return p !== ''; }); }
  function write(url, payload, done, fallback, lostText, refused) {
    return send(url, 'POST', payload).then(function (x) {
      if (x.gone) return false;
      if (lost(x)) { state(lostText || LOST); return false; }
      if (!x.ok) { if (refused) refused(x); state(why(x, fallback)); return false; }
      return done(x.body.data);
    });
  }
  /* Le dépôt d'un fichier, sous la session en cours, la clé dans l'en-tête [R13]. Une clé refusée passe par send, qui sait la retirer et le dire. */
  function upload(id, file) {
    var key = t.key();
    if (!key) return Promise.resolve({ gone: true });
    var mine = t.session();
    return fetch(path(id, '/preuves'), { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': file.type }, body: file, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' }).then(function (r) {
      return r.json().then(function (b) { return b; }, function () { return null; }).then(function (b) {
        if (mine !== t.session()) return { gone: true };
        if (r.status === 401 || (r.status === 403 && b && b.code === 'agent_inactive')) return send(path(id), 'GET').then(function (x) { return x.gone ? x : { offline: true }; });
        return { status: r.status, ok: r.ok && !!b && b.ok === true, body: b };
      });
    }, function () { return mine !== t.session() ? { gone: true } : { offline: true }; });
  }
  function tradeSelect(box, id, label) {
    return select(box, id, label, Object.assign({ '': 'Choisir le métier' }, TRADES), '');
  }

  /* La recherche et l'ajout. */
  function show(message) {
    turn += 1;
    clear(body());
    state(message || '');
    var find = el('section');
    find.appendChild(el('h4', 'Chercher'));
    var trade = tradeSelect(find, 'annuaire-metier', 'Métier');
    var cp = field(find, 'annuaire-cp', 'Code postal');
    cp.setAttribute('inputmode', 'numeric');
    cp.setAttribute('maxlength', '5');
    var domain = select(find, 'annuaire-domaine', 'Domaine, pour un diagnostiqueur', Object.assign({ '': 'Choisir le domaine' }, DOMAINS, { mesurage: 'mesurage' }), '');
    var results = el('div');
    find.appendChild(button('Chercher', function () {
      if (!trade.value) { state(REFUSALS.unknown_trade); return; }
      if (!/^\\d{5}$/.test(cp.value.trim())) { state(REFUSALS.bad_postcode); return; }
      if (trade.value === 'diagnostiqueur' && !domain.value) { state(REFUSALS.domain_required); return; }
      var q = '?metier=' + encodeURIComponent(trade.value) + '&cp=' + encodeURIComponent(cp.value.trim()) + (trade.value === 'diagnostiqueur' ? '&domaine=' + encodeURIComponent(domain.value) : '');
      search(q, results);
    }));
    find.appendChild(results);
    body().appendChild(find);
    var add = details(body(), 'Ajouter un partenaire');
    var newTrade = tradeSelect(add, 'annuaire-nouveau-metier', 'Métier');
    var name = field(add, 'annuaire-nouveau-nom', 'Nom de l’entreprise');
    name.setAttribute('maxlength', '120');
    var zones = field(add, 'annuaire-nouveau-zones', 'Codes postaux couverts');
    add.appendChild(button('Ajouter ce partenaire', function () {
      if (!newTrade.value) { state(REFUSALS.unknown_trade); return; }
      var list = postcodes(zones.value);
      if (!list.length) { state(REFUSALS.bad_postcodes); return; }
      once(function () {
        state('Envoi…');
        return write(BASE, { trade: newTrade.value, businessName: name.value.trim(), postcodes: list }, function (v) {
          return card(v.partnerId, 'Partenaire ajouté : rangez ses justificatifs pour qu’il soit proposable.');
        }, 'Le partenaire n’est pas ajouté.', 'La réponse n’est pas arrivée : rien n’est sûr. Cherchez ce partenaire avant de l’ajouter de nouveau.');
      });
    }));
    return Promise.resolve(true);
  }
  function search(q, results) {
    var mine = t.session();
    var at = ++turn;
    clear(results);
    state('Chargement…');
    return send(BASE + q, 'GET').then(function (res) {
      if (res.gone || mine !== t.session() || at !== turn) return false;
      if (!res.ok || !res.body.data) { state(why(res, 'Annuaire indisponible pour le moment.')); return false; }
      var d = res.body.data;
      state(d.proposable.length + d.unavailable.length === 0 ? 'Aucun partenaire pour ce métier sur ce code postal.' : '');
      group(results, 'Proposables aujourd’hui', d.proposable);
      group(results, 'Pas proposables aujourd’hui', d.unavailable);
      return true;
    });
  }
  /* L'ordre reçu, neutre : ni note, ni rang, ni avis [R14, R73]. */
  function group(results, title, items) {
    if (!items.length) return;
    results.appendChild(el('h4', title));
    var ul = el('ul', null, 'liste');
    items.forEach(function (p) {
      var li = el('li');
      li.appendChild(el('strong', p.businessName));
      li.appendChild(el('p', TRADES[p.trade] || '', 'doux'));
      (Array.isArray(p.reasons) ? p.reasons : []).forEach(function (r) { li.appendChild(el('p', r, 'etat')); });
      li.appendChild(button('Ouvrir', function () { card(p.partnerId, ''); }));
      ul.appendChild(li);
    });
    results.appendChild(ul);
  }

  /* La fiche d'un partenaire : son état du jour, puis ses gestes. */
  function card(id, message) {
    var mine = t.session();
    var at = ++turn;
    clear(body());
    state('Chargement…');
    return send(path(id), 'GET').then(function (res) {
      if (res.gone || mine !== t.session() || at !== turn) return false;
      var back = button('Retour à la recherche', function () { show(''); });
      back.className = 'secondaire';
      body().appendChild(back);
      if (!res.ok || !res.body.data) { state((message ? message + ' ' : '') + why(res, 'Fiche indisponible pour le moment.')); return false; }
      renderCard(id, res.body.data);
      state(message || '');
      return true;
    });
  }
  function renderCard(id, p) {
    var box = body();
    box.appendChild(el('h4', p.businessName));
    box.appendChild(el('p', (TRADES[p.trade] || '') + (p.postcodes.length ? ' · ' + p.postcodes.join(', ') : ''), 'doux'));
    box.appendChild(el('p', p.proposable ? 'Proposable aujourd’hui.' : 'Pas proposable aujourd’hui.'));
    if (Array.isArray(p.domains) && p.domains.length) box.appendChild(el('p', 'Domaines proposables : ' + p.domains.map(function (d) { return DOMAINS[d] || d; }).join(', ') + '.'));
    p.reasons.forEach(function (r) { box.appendChild(el('p', r, 'etat')); });
    var ul = el('ul', null, 'liste');
    p.lines.forEach(function (l) {
      var li = el('li');
      li.appendChild(el('strong', l.label));
      li.appendChild(el('p', (STATES[l.state] || l.state) + (l.validUntil ? ', du ' + l.validFrom + ' au ' + l.validUntil : '') + '.', 'doux'));
      ul.appendChild(li);
    });
    box.appendChild(ul);
    renderCredential(id, p);
    renderZones(id);
    renderAddress(id);
    renderOpposition(id);
  }
  function renderCredential(id, p) {
    var form = details(body(), 'Ranger un justificatif');
    var kinds = {};
    (REQUIRED[p.trade] || []).forEach(function (k) { kinds[k] = KINDS[k]; });
    if (p.trade === 'diagnostiqueur') kinds.certification_diagnostic = KINDS.certification_diagnostic;
    var kind = select(form, 'annuaire-sorte', 'Justificatif', kinds, Object.keys(kinds)[0]);
    var domain = p.trade === 'diagnostiqueur' ? select(form, 'annuaire-certif', 'Domaine, pour une certification', Object.assign({ '': 'Choisir le domaine' }, DOMAINS), '') : null;
    var number = field(form, 'annuaire-numero', 'Numéro');
    number.setAttribute('maxlength', '40');
    var from = field(form, 'annuaire-debut', 'Valide à partir du');
    from.setAttribute('type', 'date');
    var until = field(form, 'annuaire-fin', 'Valide jusqu’au');
    until.setAttribute('type', 'date');
    var proof = field(form, 'annuaire-preuve', 'Sa preuve, en PDF, JPEG ou PNG');
    proof.setAttribute('type', 'file');
    proof.setAttribute('accept', TYPES.join(','));
    form.appendChild(el('p', 'Vérifiez le document avant de le ranger : votre nom reste attaché à cette vérification. Un justificatif rangé ne change plus, une nouvelle version s’ajoute.', 'doux'));
    /* La preuve n'est pas renvoyée tant que le fichier reste le même. */
    var sent = null;
    form.appendChild(button('Ranger ce justificatif', function () {
      var certification = kind.value === 'certification_diagnostic';
      if (certification && !domain.value) { state(REFUSALS.bad_domain); return; }
      if (!number.value.trim()) { state(REFUSALS.bad_number); return; }
      if (!from.value || !until.value || until.value < from.value) { state(REFUSALS.bad_dates); return; }
      var file = proof.files && proof.files.length === 1 ? proof.files[0] : null;
      if (!file) { state('Choisissez la preuve de ce justificatif.'); return; }
      if (TYPES.indexOf(file.type) === -1) { state(REFUSALS.bad_type); return; }
      if (file.size > MAX) { state(REFUSALS.too_large); return; }
      once(function () {
        state('Envoi…');
        var ready = sent && sent.file === file ? Promise.resolve(sent.ref) : upload(id, file).then(function (x) {
          if (x.gone) return null;
          if (lost(x)) { state(LOST); return null; }
          if (!x.ok || !x.body.data || typeof x.body.data.proofRef !== 'string') { state(why(x, 'La preuve n’est pas rangée.')); return null; }
          sent = { file: file, ref: x.body.data.proofRef };
          return sent.ref;
        });
        return ready.then(function (ref) {
          if (ref === null) return false;
          var payload = { kind: kind.value, number: number.value.trim(), validFrom: from.value, validUntil: until.value, proofRef: ref };
          if (certification) payload.domain = domain.value;
          return write(path(id, '/justificatifs'), payload, function () { return card(id, 'Justificatif rangé.'); }, 'Le justificatif n’est pas rangé.', null, function (x) {
            /* Une référence que le serveur ne reconnaît plus : le prochain appui redépose le fichier. */
            if (x.body && (x.body.code === 'not_stored' || x.body.code === 'bad_ref')) sent = null;
          });
        });
      });
    }));
  }
  function renderZones(id) {
    var form = details(body(), 'Ajouter des codes postaux');
    var zones = field(form, 'annuaire-zones', 'Codes postaux');
    form.appendChild(button('Ajouter ces codes postaux', function () {
      var list = postcodes(zones.value);
      if (!list.length) { state(REFUSALS.bad_postcodes); return; }
      once(function () {
        state('Envoi…');
        return write(path(id, '/zones'), { postcodes: list }, function () { return card(id, 'Codes postaux ajoutés.'); }, 'Les codes postaux ne sont pas ajoutés.');
      });
    }));
  }
  function renderAddress(id) {
    var form = details(body(), 'Adresse professionnelle et accord pour le suivi');
    var email = field(form, 'annuaire-mail', 'Adresse mail professionnelle');
    email.setAttribute('type', 'email');
    var consent = field(form, 'annuaire-accord', 'Où et quand il a donné son accord', 'textarea');
    consent.setAttribute('maxlength', '500');
    form.appendChild(el('p', 'Sans son accord, rien ne lui est écrit. Rien ne part d’ici.', 'doux'));
    form.appendChild(button('Ranger l’adresse et l’accord', function () {
      if (!email.value.trim()) { state(REFUSALS.bad_email); return; }
      if (consent.value.trim().length < 3) { state(REFUSALS.bad_proof); return; }
      once(function () {
        state('Envoi…');
        return write(path(id, '/adresse'), { email: email.value.trim(), consentProof: consent.value.trim() }, function () { return card(id, 'Adresse et accord rangés.'); }, 'L’adresse n’est pas rangée.');
      });
    }));
  }
  /* Deux appuis espacés : une opposition ne se défait pas, et chaque adresse connue de ce partenaire est arrêtée avec elle [R04]. */
  function renderOpposition(id) {
    var text = 'Noter son opposition', armedAt = null;
    var b = button(text, function () {
      var now = Date.now();
      if (armedAt !== null && now - armedAt < 1000) return;
      if (armedAt === null || now - armedAt > 15000) {
        armedAt = now;
        b.textContent = 'Confirmer : noter son opposition';
        state('Il ne recevra plus rien de notre part, et cela ne se défait pas. Appuyez de nouveau pour confirmer.');
        return;
      }
      armedAt = null;
      b.textContent = text;
      once(function () {
        state('Envoi…');
        return write(path(id, '/opposition'), undefined, function () { return card(id, 'Opposition notée : il ne recevra plus rien.'); }, 'L’opposition n’est pas notée.');
      });
    });
    b.className = 'secondaire';
    body().appendChild(b);
  }
  return { show: show };
};
`;
