import { ASSET_KINDS, ASSET_LICENCES, ASSET_SOURCES, NEEDS_ATTRIBUTION, WITHDRAWAL_REASONS } from '../../core/src/studio/bibliotheque.ts';
import { MEASURE_SIZE } from '../../core/src/studio/options.ts';

/**
 * La bibliothèque sous licence et la mesure des visuels sur l'écran du réseau (X13) : la direction range une musique ou
 * une image avec sa source, sa licence et sa preuve, retire une entrée et lit la mesure des 20 visuels. Script servi à
 * part (`/app/bibliotheque.js`), chargé au premier geste [R201]. Le serveur décide de ce qui est utilisable [R133] ;
 * l'écran ne range rien sans licence ni preuve. Tout texte reçu est posé en texte, rien ne reste une fois quitté.
 */

const REFUSALS: Record<string, string> = {
  role: 'Ce n’est pas dans vos droits.',
  sorte_inconnue: 'Choisissez musique ou image.',
  titre_invalide: 'Le titre : de 2 à 120 caractères.',
  sans_source: 'Choisissez la source : sans elle, rien n’est rangé.',
  sans_licence: 'Choisissez la licence : sans elle, rien n’est rangé.',
  mention_auteur_invalide: 'La mention de l’auteur : de 2 à 200 caractères.',
  mention_auteur_absente: 'Cette licence exige de nommer l’auteur à chaque usage : écrivez sa mention.',
  date_de_fin_invalide: 'Dites jusqu’à quand vaut la licence, ou qu’elle est sans fin.',
  licence_expiree: 'Cette licence est déjà expirée : elle n’est pas rangée.',
  sans_preuve: 'Choisissez la preuve de la licence : sans elle, rien n’est rangé.',
  preuve_absente: 'La preuve n’est pas retrouvée : déposez-la de nouveau.',
  stockage_indisponible: 'Le stockage des preuves ne répond pas : rien n’est rangé.',
  entree_inconnue: 'Cette entrée n’est pas dans la bibliothèque de ce réseau.',
  motif_inconnu: 'Choisissez le motif du retrait.',
  bad_type: 'La preuve : un fichier PDF, JPEG ou PNG.',
  too_large: 'Cette preuve dépasse 10 Mo : rien n’est envoyé.',
  storage_unavailable: 'Le stockage des preuves n’est pas en service : rien ne peut être rangé pour le moment.',
  studio_files_not_configured: 'Le stockage du Studio n’est pas en service : la bibliothèque est fermée pour le moment.',
};
export const BIBLIOTHEQUE_KINDS: Record<(typeof ASSET_KINDS)[number], string> = { musique: 'Musique', image: 'Image' };
export const BIBLIOTHEQUE_SOURCES: Record<(typeof ASSET_SOURCES)[number], string> = {
  banque_sous_licence: 'Banque sous licence',
  achat_unitaire: 'Achat à l’unité',
  creation_commandee: 'Création commandée',
  domaine_public: 'Domaine public',
};
export const BIBLIOTHEQUE_LICENCES: Record<(typeof ASSET_LICENCES)[number], string> = {
  cc0: 'CC0',
  cc_by: 'CC BY',
  licence_achetee: 'Licence achetée',
  abonnement: 'Abonnement',
  cession_de_droits: 'Cession de droits',
};
export const BIBLIOTHEQUE_REASONS: Record<(typeof WITHDRAWAL_REASONS)[number], string> = {
  licence_retiree: 'Licence retirée',
  preuve_invalide: 'Preuve non valable',
  choix_de_la_direction: 'Choix de la direction',
};
const VERDICTS: Record<string, string> = {
  adresse_visible: 'adresse visible',
  liste_absente: 'liste de contrôle absente',
  liste_refusee: 'liste de contrôle refusée',
};
/** Les formats et le poids que la route accepte (`partenaires.ts`, testé égal) : l'écran ne l'importe pas, le serveur redit non. */
export const BIBLIOTHEQUE_PROOF_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
export const BIBLIOTHEQUE_PROOF_MAX_BYTES = 10 * 1024 * 1024;

export const BIBLIOTHEQUE_ENTRY_HTML = `<section class="bloc" aria-labelledby="titre-bibliotheque">
<h3 id="titre-bibliotheque">Bibliothèque sous licence</h3>
<p class="doux">Musiques et images du Studio, et mesure des visuels publiés.</p>
<button id="bibliotheque-ouvrir" type="button" class="secondaire">Ouvrir la bibliothèque</button>
<p id="bibliotheque-etat" class="etat" role="status"></p>
<div id="bibliotheque-corps"></div>
</section>
`;

/** Le chargeur posé dans le script de l'application : l'écran est servi à part, chargé une fois, jamais gardé. */
export const BIBLIOTHEQUE_JS = `
  /* ---------- La bibliothèque sous licence sur l'écran du réseau (X13), chargée au premier geste [R16, R133, R201]. ---------- */
  function wipeBibliotheque() {
    clear($('bibliotheque-corps'));
    $('bibliotheque-etat').textContent = '';
  }
  function withBibliotheque(act) {
    return withTool('bibliotheque', 'AIMMO_BIBLIOTHEQUE', 'bibliotheque-etat', 'reseau', act, function () { return { $: $, el: el, clear: clear, send: send, button: button, field: field, select: select, details: details, key: function () { return currentKey; }, session: function () { return session; } }; });
  }
`;

/** Le script servi à part (`/app/bibliotheque.js`). Il ne lit et n'écrit que `/v1/studio/bibliotheque` et `/v1/studio/mesure-visuels` [R16]. */
export const BIBLIOTHEQUE_SCRIPT = `'use strict';
globalThis.AIMMO_BIBLIOTHEQUE = function (t) {
  var $ = t.$, el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field, select = t.select, details = t.details;
  var REFUSALS = ${JSON.stringify(REFUSALS)};
  var KINDS = ${JSON.stringify(BIBLIOTHEQUE_KINDS)};
  var SOURCES = ${JSON.stringify(BIBLIOTHEQUE_SOURCES)};
  var LICENCES = ${JSON.stringify(BIBLIOTHEQUE_LICENCES)};
  var REASONS = ${JSON.stringify(BIBLIOTHEQUE_REASONS)};
  var VERDICTS = ${JSON.stringify(VERDICTS)};
  var ATTRIBUTION = ${JSON.stringify(NEEDS_ATTRIBUTION)};
  var TYPES = ${JSON.stringify(BIBLIOTHEQUE_PROOF_TYPES)};
  var MAX = ${BIBLIOTHEQUE_PROOF_MAX_BYTES};
  var SIZE = ${MEASURE_SIZE};
  var BASE = '/v1/studio/bibliotheque';
  var OFFLINE = 'Pas de réseau. Réessayez dans un moment.';
  /* Une écriture sans réponse, ou coupée par une panne du serveur, a pu passer : l'écran ne dit ni fait ni pas fait. */
  var LOST = 'La réponse n’est pas arrivée : rien n’est sûr. Relisez la bibliothèque avant de recommencer.';
  /* Le verrou d'un geste vaut pour sa session : une réponse qui tarde ne bloque pas la connexion suivante. */
  var busy = null, turn = 0;
  function state(text) { $('bibliotheque-etat').textContent = text; }
  function body() { return $('bibliotheque-corps'); }
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
  function lost(x) { return x.offline || !x.body || (x.status >= 500 && x.body.code !== 'storage_unavailable' && x.body.code !== 'studio_files_not_configured'); }
  function write(url, payload, done, fallback, refused) {
    return send(url, 'POST', payload).then(function (x) {
      if (x.gone) return false;
      if (lost(x)) { state(LOST); return false; }
      if (!x.ok) { if (refused) refused(x); state(why(x, fallback)); return false; }
      return done(x.body.data);
    });
  }
  /* Le dépôt de la preuve, sous la session en cours, la clé dans l'en-tête [R13]. Une clé refusée passe par send, qui sait la retirer et le dire. */
  function upload(file) {
    var key = t.key();
    if (!key) return Promise.resolve({ gone: true });
    var mine = t.session();
    return fetch(BASE + '/preuves', { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': file.type }, body: file, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' }).then(function (r) {
      return r.json().then(function (b) { return b; }, function () { return null; }).then(function (b) {
        if (mine !== t.session()) return { gone: true };
        if (r.status === 401 || (r.status === 403 && b && b.code === 'agent_inactive')) return send(BASE, 'GET').then(function (x) { return x.gone ? x : { offline: true }; });
        return { status: r.status, ok: r.ok && !!b && b.ok === true, body: b };
      });
    }, function () { return mine !== t.session() ? { gone: true } : { offline: true }; });
  }
  function frenchDay(day) { return String(day).slice(0, 10).split('-').reverse().join('/'); }
  function choose(text, list) { return Object.assign({ '': text }, list); }

  /* La bibliothèque, l'ajout, la mesure. */
  function show(message) {
    var mine = t.session();
    var at = ++turn;
    clear(body());
    state('Chargement…');
    return send(BASE, 'GET').then(function (res) {
      if (res.gone || mine !== t.session() || at !== turn) return false;
      if (!res.ok || !res.body.data) { state((message ? message + ' ' : '') + why(res, 'Bibliothèque indisponible pour le moment.')); return false; }
      renderList(res.body.data);
      renderAdd();
      renderMeasure();
      state(message || '');
      return true;
    });
  }
  function assetState(a) {
    if (a.withdrawn) return 'Retirée le ' + frenchDay(a.withdrawn.at) + ' : ' + (REASONS[a.withdrawn.reason] || a.withdrawn.reason) + '. Elle n’est plus proposée.';
    if (!a.usable) return 'Licence expirée le ' + frenchDay(a.validUntil) + '. Elle n’est plus proposée.';
    return a.validUntil ? 'Utilisable jusqu’au ' + frenchDay(a.validUntil) + '.' : 'Utilisable, licence sans fin.';
  }
  /* L'ordre reçu. */
  function renderList(list) {
    var box = el('section');
    box.appendChild(el('h4', 'Musiques et images'));
    if (!list.length) box.appendChild(el('p', 'Rien de rangé pour le moment.', 'doux'));
    else {
      var ul = el('ul', null, 'liste');
      list.forEach(function (a) {
        var li = el('li');
        li.appendChild(el('strong', a.title));
        li.appendChild(el('p', (KINDS[a.kind] || '') + ' · ' + (SOURCES[a.source] || '') + ' · ' + (LICENCES[a.licence] || ''), 'doux'));
        if (a.attribution) li.appendChild(el('p', 'Mention : ' + a.attribution, 'doux'));
        li.appendChild(el('p', assetState(a), a.usable ? 'doux' : 'etat'));
        if (!a.withdrawn) renderWithdraw(li, a.id);
        ul.appendChild(li);
      });
      box.appendChild(ul);
    }
    body().appendChild(box);
  }
  function renderAdd() {
    var form = details(body(), 'Ranger une musique ou une image');
    var kind = select(form, 'bibliotheque-sorte', 'Sorte', choose('Choisir', KINDS), '');
    var title = field(form, 'bibliotheque-titre', 'Titre');
    title.setAttribute('maxlength', '120');
    var source = select(form, 'bibliotheque-source', 'Source', choose('Choisir la source', SOURCES), '');
    var licence = select(form, 'bibliotheque-licence', 'Licence', choose('Choisir la licence', LICENCES), '');
    var mention = field(form, 'bibliotheque-mention', 'Mention de l’auteur, si la licence l’exige');
    mention.setAttribute('maxlength', '200');
    var term = select(form, 'bibliotheque-duree', 'Durée de la licence', { '': 'Choisir', date: 'Jusqu’à une date', sans_fin: 'Sans fin' }, '');
    var until = field(form, 'bibliotheque-fin', 'Date de fin');
    until.setAttribute('type', 'date');
    var proof = field(form, 'bibliotheque-preuve', 'Preuve de la licence, en PDF, JPEG ou PNG');
    proof.setAttribute('type', 'file');
    proof.setAttribute('accept', TYPES.join(','));
    /* La preuve n'est pas renvoyée tant que le fichier reste le même. */
    var sent = null;
    form.appendChild(button('Ranger cette entrée', function () {
      if (!kind.value) { state(REFUSALS.sorte_inconnue); return; }
      if (title.value.trim().length < 2) { state(REFUSALS.titre_invalide); return; }
      if (!source.value) { state(REFUSALS.sans_source); return; }
      if (!licence.value) { state(REFUSALS.sans_licence); return; }
      if (ATTRIBUTION.indexOf(licence.value) !== -1 && !mention.value.trim()) { state(REFUSALS.mention_auteur_absente); return; }
      if (!term.value || (term.value === 'date' && !until.value)) { state(REFUSALS.date_de_fin_invalide); return; }
      var file = proof.files && proof.files.length === 1 ? proof.files[0] : null;
      if (!file) { state(REFUSALS.sans_preuve); return; }
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
          var payload = { kind: kind.value, title: title.value.trim(), source: source.value, licence: licence.value, validUntil: term.value === 'date' ? until.value : null, proofRef: ref };
          if (mention.value.trim()) payload.attribution = mention.value.trim();
          return write(BASE, payload, function () { return show('Entrée rangée.'); }, 'L’entrée n’est pas rangée.', function (x) {
            /* Une référence que le serveur ne reconnaît plus : le prochain appui redépose le fichier. */
            if (x.body && (x.body.code === 'preuve_absente' || x.body.code === 'sans_preuve')) sent = null;
          });
        });
      });
    }));
  }
  /* Deux appuis espacés : un retrait ne se défait pas ; l'entrée reste écrite, elle sort seulement des choix [R17]. */
  function renderWithdraw(box, id) {
    var form = details(box, 'Retirer');
    var reason = select(form, 'bibliotheque-motif-' + id, 'Motif', choose('Choisir le motif', REASONS), '');
    var text = 'Retirer cette entrée', armedAt = null;
    var b = button(text, function () {
      if (!reason.value) { state(REFUSALS.motif_inconnu); return; }
      var now = Date.now();
      if (armedAt !== null && now - armedAt < 1000) return;
      if (armedAt === null || now - armedAt > 15000) {
        armedAt = now;
        b.textContent = 'Confirmer : retirer cette entrée';
        state('Elle ne sera plus proposée aux agents, et cela ne se défait pas. Appuyez de nouveau pour confirmer.');
        return;
      }
      armedAt = null;
      b.textContent = text;
      once(function () {
        state('Envoi…');
        return write(BASE + '/' + encodeURIComponent(id) + '/retrait', { reason: reason.value }, function () { return show('Entrée retirée.'); }, 'L’entrée n’est pas retirée.');
      });
    });
    b.className = 'secondaire';
    form.appendChild(b);
  }

  /* La mesure : ce que le serveur a compté, sans rien refaire [R132]. */
  function renderMeasure() {
    var box = el('section');
    box.appendChild(el('h4', 'Mesure des visuels publiés'));
    var note = el('p', '', 'etat');
    note.setAttribute('role', 'status');
    var results = el('div');
    box.appendChild(button('Lire la mesure', function () { readMeasure(note, results); }));
    box.appendChild(note);
    box.appendChild(results);
    body().appendChild(box);
  }
  function measureText(m) {
    if (!m.complete) return m.counted + ' visuel' + (m.counted > 1 ? 's' : '') + ' publié' + (m.counted > 1 ? 's' : '') + ' sur ' + SIZE + ' : la mesure n’est pas encore complète.';
    if (m.passed) return 'Mesure tenue : ' + SIZE + ' visuels publiés, aucune adresse visible.';
    return 'Mesure non tenue : ' + m.named.length + ' visuel' + (m.named.length > 1 ? 's' : '') + ' à revoir sur ' + SIZE + '.';
  }
  function readMeasure(note, results) {
    var mine = t.session();
    var at = ++turn;
    clear(results);
    note.textContent = 'Chargement…';
    return send('/v1/studio/mesure-visuels', 'GET').then(function (res) {
      if (res.gone || mine !== t.session() || at !== turn) return false;
      if (!res.ok || !res.body.data) { note.textContent = why(res, 'Mesure indisponible pour le moment.'); return false; }
      var m = res.body.data;
      note.textContent = measureText(m);
      if (m.named.length) {
        var ul = el('ul', null, 'liste');
        m.named.forEach(function (l) {
          var li = el('li');
          li.appendChild(el('strong', 'Publié le ' + frenchDay(l.sentAt) + ' : ' + (VERDICTS[l.verdict] || l.verdict)));
          li.appendChild(el('p', l.mediaRef, 'doux'));
          ul.appendChild(li);
        });
        results.appendChild(ul);
      }
      return true;
    });
  }
  return { show: show };
};
`;
