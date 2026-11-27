import { ANNEX_KINDS, CHOICE_CHANNELS, HABITATS, LEASE_FIELDS, RENTAL_DEPOSIT_MAX_BYTES, RENTAL_DEPOSIT_TYPES } from '../../core/src/location/index.ts';

/**
 * L'écran « Louer » de l'application de l'agent (W11), en morceaux posés dans `fichiers.ts` : sa section de page, son
 * entrée sur l'accueil, sa mise en page et son script.
 *
 * L'écran ne lit et n'écrit que par les routes `/v1/location` [R16]. Les contacts proposés pour une candidature (W13)
 * ne sont lus qu'au geste d'ajouter, et leurs noms ne rejoignent jamais un dossier. Les candidatures sont montrées dans l'ordre
 * d'arrivée reçu de l'API, jamais retriées, jamais notées ni filtrées sur un revenu [R105] ; aucun nom de candidat n'est
 * montré, seulement le numéro d'arrivée. Aucun champ ne fait passer d'argent par AIMMO [R107]. Tout texte reçu est posé
 * avec `textContent`. Les montants et les plafonds sont ceux que le code calcule [R102] : l'écran les montre, il ne les
 * calcule pas. L'annexe, la preuve et la notice se déposent depuis le téléphone (W14) : le fichier part tel quel, avec
 * son empreinte calculée sur l'appareil, et l'agent ne voit ni ne saisit jamais de référence.
 */

/** Les libellés de M15, tirés du code métier pour ne jamais diverger. */
const ANNEXES = Object.fromEntries(ANNEX_KINDS.map((a) => [a.kind, a.label]));
/** Les champs du bail, chacun par une clé courte (quatre lettres par partie du nom) : l'écran n'en montre que le libellé. */
const shortKey = (k: string): string => k.split('.').map((x) => x.slice(0, 4)).join('.');
const LEASE_LABELS = { ...Object.fromEntries(Object.entries(LEASE_FIELDS).map(([k, v]) => [shortKey(k), v.label])), [shortKey('annexe.notice_information')]: 'notice d’information' };
const CHANNEL_LABELS: Record<(typeof CHOICE_CHANNELS)[number], string> = { oral: 'De vive voix', ecrit: 'Par écrit', mail: 'Par mail', sms: 'Par SMS', whatsapp: 'Par WhatsApp' };

export const LOUER_HOME_HTML = `<section class="bloc" aria-labelledby="titre-louer-accueil">
<h3 id="titre-louer-accueil">Mes locations</h3>
<p class="etat">Du contrôle du logement à l’état des lieux signé, étape par étape. Aucun loyer ni dépôt ne passe par AIMMO.</p>
<button id="louer-ouvrir" type="button" class="secondaire">Ouvrir mes mises en location</button>
</section>
`;

/** L'entrée des modèles de bail (W17) : sur l'écran du réseau pour la direction, sur celui de la conformité pour la validation. */
const modelesEntry = (p: string, about: string): string => `<section class="bloc" aria-labelledby="${p}-titre">
<h3 id="${p}-titre">Modèles de bail</h3>
<p class="doux">${about}</p>
<button id="${p}-ouvrir" type="button" class="secondaire">Lire les modèles de bail</button>
<p id="${p}-etat" class="etat" role="status"></p>
<div id="${p}-corps"></div>
</section>
`;
export const LOUER_MODELES_ENTRY_HTML = modelesEntry('louer-modeles', 'La direction range les versions, la conformité les valide.');
export const LOUER_MODELES_CONFORMITE_HTML = modelesEntry('louer-modeles-c', 'Valider seulement un texte relu par l’avocat.');

export const LOUER_HTML = `<section id="louer" hidden>
<button id="louer-retour" type="button" class="retour">Retour</button>
<h2 id="louer-titre">Louer</h2>
<p class="doux">Les dossiers complets sont montrés au propriétaire dans leur ordre d’arrivée, sans note ni tri : il choisit.</p>
<p id="louer-etat" class="etat" role="status"></p>
<div id="louer-corps"></div>
</section>
`;

export const LOUER_CSS = `
#louer { padding-top: var(--e-2); }
.parcours { display: flex; flex-wrap: wrap; gap: var(--e-2); margin: 0 0 var(--e-4); padding: 0; list-style: none; counter-reset: etape; }
.parcours li { counter-increment: etape; display: inline-flex; align-items: center; gap: var(--e-2); min-height: 32px; padding: var(--e-1) var(--e-3); border-radius: var(--r-rond); border: 1.5px solid var(--trait); font-size: var(--t-s); }
.parcours li::before { content: counter(etape); font: 600 var(--t-s)/1 var(--police-titre); color: var(--doux); }
.parcours li.fait { border-color: var(--succes); }
.parcours li.fait::before { color: var(--succes); }
.parcours li.bloque { border-color: var(--danger); color: var(--danger); }
.parcours li[aria-current="step"] { background: var(--accent); border-color: var(--accent); color: var(--sur-accent); }
.parcours li[aria-current="step"]::before { color: var(--sur-accent); }
.dossiers { margin: var(--e-2) 0; padding-left: var(--e-6); }
.dossiers > li { padding: var(--e-3) 0; border-top: 1px solid var(--trait); }
.dossiers > li:first-child { border-top: 0; }
.dossiers > li::marker { color: var(--moutarde); font: 600 var(--t-l)/1 var(--police-titre); }
.piece { margin-top: var(--e-4); padding: var(--e-3) var(--e-4); border: 1.5px dashed var(--trait); border-radius: var(--r-m); }
.ligne { display: flex; gap: var(--e-2); align-items: flex-end; }
.ligne > div { flex: 1 1 0; min-width: 0; }
.trace { display: block; width: 100%; height: 140px; margin-top: var(--e-2); background: var(--papier); border: 1.5px solid var(--doux); border-radius: var(--r-m); touch-action: none; cursor: crosshair; }
`;

/** Le script de l'écran : posé dans le script de l'application, il en reprend les outils (`el`, `send`, `field`…). */
export const LOUER_JS = `
  /* ---------- M15 : l'écran « Louer » (W11), chargé à la demande [R105, R16, R201]. ---------- */
  // Des euros saisis (« 650 » ou « 650,50 ») en centimes ; rien d'autre n'est admis.
  function toCents(text) {
    var t = String(text || '').replace(/[\\s\\u00a0\\u202f€]/g, '').replace(',', '.');
    if (!/^\\d{1,7}(\\.\\d{1,2})?$/.test(t)) return null;
    return Math.round(Number(t) * 100);
  }
  function centsText(c) { return typeof c === 'number' ? (c / 100).toFixed(2).replace('.', ',').replace(/,00$/, '') : ''; }
  function whole(text, max) {
    var t = String(text || '').trim();
    if (!/^\\d{1,6}$/.test(t)) return null;
    var n = Number(t);
    return n <= max ? n : null;
  }
  function select(box, id, label, options, value) {
    var s = field(box, id, label, 'select');
    Object.keys(options).forEach(function (k) { var o = el('option', options[k]); o.value = k; s.appendChild(o); });
    s.value = value;
    return s;
  }
  function details(box, title) {
    var d = el('details');
    d.appendChild(el('summary', title));
    box.appendChild(d);
    return d;
  }
  var louerScreen = null;
  var louerId = null;
  function forgetLouer() {
    if (louerScreen) louerScreen.forget();
    wipeModeles();
  }
  function wipeModeles() {
    ['louer-modeles', 'louer-modeles-c'].forEach(function (p) { clear($(p + '-corps')); $(p + '-etat').textContent = ''; });
  }
  /* Les modèles de bail (W17), servis à part, chargés au premier geste [R201]. */
  var modelesTool = null, modelesBusy = false;
  function openModeles(p) {
    if (!currentKey) return;
    var box = $(p + '-corps');
    var say = function (x) { $(p + '-etat').textContent = x; };
    if (modelesTool) return modelesTool.open(box, say);
    if (modelesBusy) return;
    modelesBusy = true;
    var mine = session;
    say('Chargement…');
    var s = el('script');
    s.setAttribute('src', '/app/louer-modeles.js');
    s.addEventListener('load', function () {
      modelesBusy = false;
      var make = globalThis.AIMMO_LOUER_MODELES;
      try { delete globalThis.AIMMO_LOUER_MODELES; } catch (e) { /* rien à retirer */ }
      if (typeof make !== 'function') { if (mine === session) say('Pas de réseau. Réessayez dans un moment.'); return; }
      modelesTool = make({ el: el, clear: clear, send: send, button: button, field: field, date: date, ID: ID, session: function () { return session; } });
      if (mine === session) modelesTool.open(box, say); else say('');
    });
    s.addEventListener('error', function () {
      modelesBusy = false;
      if (mine === session) say('Pas de réseau. Réessayez dans un moment.');
    });
    $('louer').appendChild(s);
  }
  function wipeLouer() {
    if (louerScreen) { louerScreen.wipe(); return; }
    clear($('louer-corps'));
    $('louer-etat').textContent = '';
    $('louer-titre').textContent = 'Louer';
    louerId = null;
  }
  function openLouer(message, page) {
    if (!currentKey) return Promise.resolve(false);
    if (louerScreen) return louerScreen.open(message, page);
    session += 1;
    var mine = session;
    wipeLouer();
    show('louer');
    $('louer-etat').textContent = 'Chargement…';
    return new Promise(function (resolve) {
      var script = document.createElement('script');
      script.setAttribute('src', '/app/louer.js');
      script.addEventListener('load', function () {
        var make = globalThis.AIMMO_LOUER;
        try { delete globalThis.AIMMO_LOUER; } catch (e) { /* rien à retirer */ }
        if (mine !== session || typeof make !== 'function') { resolve(false); return; }
        louerScreen = make({ $: $, el: el, clear: clear, send: send, button: button, field: field, checkbox: checkbox, show: show, ID: ID, date: date, euros: euros, hour: hour, line: line, section: section, toCents: toCents, centsText: centsText, whole: whole, select: select, details: details, setId: function (id) { louerId = id; }, key: function () { return currentKey; }, session: function () { return session; }, bump: function () { session += 1; return session; } });
        resolve(louerScreen.open(message, page));
      });
      script.addEventListener('error', function () {
        if (mine === session) $('louer-etat').textContent = 'Pas de réseau. Réessayez dans un moment.';
        resolve(false);
      });
      $('louer').appendChild(script);
    });
  }
`;

/**
 * Le script de l'écran, servi à part (`/app/louer.js`) et chargé à la première ouverture, pour que l'application tienne
 * son budget [R201], et servi sans ses lignes de commentaire. Il reçoit les outils de l'application et ne garde rien sur l'appareil.
 */
export const LOUER_SCRIPT = `'use strict';
globalThis.AIMMO_LOUER = function (t) {
  var $ = t.$, el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field, checkbox = t.checkbox, show = t.show, ID = t.ID, date = t.date, euros = t.euros, hour = t.hour, line = t.line, section = t.section, toCents = t.toCents, centsText = t.centsText, whole = t.whole, select = t.select, details = t.details;

  /* ---------- M15 : l'écran « Louer » (W11). Les dossiers dans l'ordre d'arrivée reçu, jamais retriés ni notés [R105]. ---------- */
  var ANNEXES = ${JSON.stringify(ANNEXES)};
  var LEASE_LABELS = ${JSON.stringify(LEASE_LABELS)};
  var HABITATS = ${JSON.stringify(HABITATS)};
  var CHOICE_CHANNELS = ${JSON.stringify(CHANNEL_LABELS)};
  var PIECES_MISSING = { identite: 'pièce d’identité vérifiée', domicile: 'justificatif de domicile', activite: 'justificatif d’activité', ressources: 'justificatif de ressources', visa_visale: 'visa Visale' };
  var PARTY_NAMES = { bailleur: 'le bailleur', locataire: 'le locataire' };
  var PARTY_TO = { bailleur: 'au bailleur', locataire: 'au locataire' };
  var PARTY_OF = { bailleur: 'du bailleur', locataire: 'du locataire' };
  var LOUER_REFUSALS = {
    not_assigned: 'Ce logement est suivi par un autre agent.',
    unknown_person: 'Cette fiche n’est pas dans ce réseau.',
    already_applied: 'Cette personne a déjà une candidature sur ce logement.',
    bad_dossierfacile: 'Ce lien n’est pas un lien DossierFacile.',
    no_facts: 'Saisissez d’abord les faits du logement.',
    invalid: 'Un champ n’est pas valable : vérifiez la saisie.',
    no_commune: 'Indiquez d’abord le code INSEE de la commune.',
    bad_insee: 'Le code INSEE compte 5 caractères.',
    commune_set: 'La commune est déjà rangée pour ce logement.',
    tenant_ceiling: 'Les honoraires du locataire dépassent le plafond.',
    inventory_ceiling: 'L’état des lieux du locataire dépasse le plafond.',
    over_landlord: 'La part du locataire ne peut pas dépasser celle du bailleur.',
    inventory_over_landlord: 'L’état des lieux du locataire ne peut pas dépasser celui du bailleur.',
    deposit_ceiling: 'Le dépôt de garantie dépasse le plafond.',
    not_advertisable: 'Le logement n’est pas louable aujourd’hui : refaites le contrôle.',
    not_rentable: 'Le logement n’est pas louable aujourd’hui : refaites le contrôle.',
    no_fees: 'Rangez d’abord les honoraires et le dépôt.',
    missing_energy_cost: 'La fiche du bien n’a pas encore ses dépenses d’énergie.',
    already_validated: 'Cette annonce est déjà validée.',
    no_application: 'Aucune candidature pour le moment.',
    already_chosen: 'Le propriétaire a déjà choisi.',
    not_latest_presentation: 'Une présentation plus récente existe : l’écran est relu.',
    not_presented: 'Le propriétaire choisit parmi les dossiers présentés, et seulement eux.',
    bad_date: 'La date du choix n’est pas valable (pas dans le futur).',
    before_presentation: 'Le choix ne peut pas précéder la présentation.',
    bad_channel: 'Dites comment le propriétaire a fait son choix.',
    incomplete: 'Ce dossier n’est plus complet.',
    no_choice: 'Le propriétaire n’a pas encore choisi.',
    dossier_incomplet: 'Le dossier choisi n’est plus complet : chaque colocataire fournit ses pièces.',
    not_cotenant: 'Cette personne n’est pas colocataire de ce bail.',
    missing_charges_mode: 'Dites dans les faits si les charges sont une provision ou un forfait.',
    lease_start_passed: 'La date de début du bail est passée : rangez de nouveaux faits.',
    bad_address: 'L’adresse n’est pas valable.',
    bad_owner_address: 'Le domicile du bailleur n’est pas valable.',
    bad_equipment: 'La liste des équipements n’est pas valable.',
    bad_card: 'La carte professionnelle s’écrit « CPI » puis son numéro.',
    type_refuse: 'Ce fichier n’est pas accepté : un PDF, une photo JPEG ou PNG.',
    trop_lourd: 'Ce fichier dépasse 20 Mo.',
    bad_habitat: 'Choisissez le type d’habitat.',
    missing_landlord: 'Dites qui est le bailleur.',
    no_template: 'Aucun modèle de bail validé dans le réseau.',
    bad_party: 'Partie inconnue.',
    bad_consent: 'Notez comment la partie a accepté de signer en ligne.',
    already_signed: 'Cette partie a déjà signé.',
    bad_code: 'Code faux : vérifiez-le avec la partie.',
    expired: 'Code expiré : envoyez-en un nouveau.',
    blocked: 'Trop d’essais avec ce code : envoyez-en un nouveau.',
    superseded: 'Un nouveau code a été envoyé : saisissez le dernier reçu.',
    unknown_session: 'Envoyez d’abord le code à la partie.',
    bad_drawing: 'Tracez la signature dans le cadre.',
    lease_changed: 'Le bail a changé depuis : il est à signer de nouveau.',
    not_signed: 'Les deux parties doivent d’abord signer.',
    no_current_lease: 'Aucun bail en vigueur pour ce logement.',
    lease_incomplete: 'Le bail est incomplet : complétez-le d’abord.',
    closed: 'L’état des lieux est déjà signé des deux parties.',
    bad_rooms: 'Une pièce n’est pas valable : un nom, et l’état de chaque élément.',
    bad_meters: 'Un relevé de compteur n’est pas valable : des chiffres seulement.',
    bad_keys: 'Une ligne de clés n’est pas valable : une sorte et un nombre.',
    bad_furniture: 'Une ligne du mobilier n’est pas valable.',
    document_changed: 'L’état des lieux a changé : relisez-le et signez la dernière version.',
    stale: 'L’état des lieux a changé : relisez-le et signez la dernière version.',
    busy: 'Une autre demande est en cours : réessayez dans un instant.',
  };
  function louerRefusal(body, fallback) { return (body && LOUER_REFUSALS[body.code]) || fallback; }
  function louerState(text) { $('louer-etat').textContent = text; }
  // À la sortie ou au changement de clé : rien de la personne précédente ne reste sur l'appareil (texte du bail, séances).
  function forgetLouer() {
    closingOpenFor = null;
    dossierOpen = null;
    leaseTexts = {};
    signing = {};
  }
  function wipeLouer() {
    clear($('louer-corps'));
    $('louer-etat').textContent = '';
    $('louer-titre').textContent = 'Louer';
    louerId = null;
    t.setId(null);
  }
  var louerPage = 0;
  // Le code du dernier refus, pour qu'un geste sache par exemple qu'un code de signature est à renvoyer.
  var louerLastCode = null;
  var louerId = null;
  function openLouer(message, page) {
    if (!t.key()) return Promise.resolve(false);
    if (typeof page === 'number') louerPage = page;
    t.bump();
    wipeLouer();
    show('louer');
    louerState('Chargement…');
    return send('/v1/location' + (louerPage ? '?page=' + louerPage : ''), 'GET').then(function (res) {
      if (res.gone) return false;
      if (!res.ok) { louerState(res.offline ? 'Pas de réseau. Réessayez dans un moment.' : louerRefusal(res.body, 'Indisponible pour le moment. Réessayez plus tard.')); return false; }
      var d = res.body.data || {};
      var list = Array.isArray(d.listings) ? d.listings : [];
      var body = $('louer-corps');
      if (!list.length && !louerPage) body.appendChild(el('p', 'Aucune mise en location pour le moment. Elle s’ouvre depuis le bien du propriétaire.', 'doux'));
      if (louerPage) body.appendChild(button('Logements précédents', function () { openLouer('', louerPage - 1); }));
      var ul = el('ul', null, 'liste');
      list.forEach(function (l) {
        if (!ID.test(l.listingId)) return;
        var li = el('li');
        li.appendChild(el('strong', 'Bien ' + l.reference + (l.city ? ', ' + l.city : '')));
        li.appendChild(el('p', l.decision === 'louable' ? 'Contrôlé : louable' : l.decision === 'bloque' ? 'Contrôlé : bloqué avant toute annonce' : 'Pas encore contrôlé', l.decision === 'louable' ? 'fait' : l.decision === 'bloque' ? 'retard' : 'doux'));
        li.appendChild(button('Ouvrir', function () { openLocation(l.listingId, 'Bien ' + l.reference); }));
        ul.appendChild(li);
      });
      body.appendChild(ul);
      if (d.more === true) body.appendChild(button('Logements suivants', function () { openLouer('', louerPage + 1); }));
      louerState(message || '');
      return true;
    });
  }
  // Un geste sur le logement ouvert : la réponse est dite, puis l'écran relu pour montrer l'état rangé.
  function louerAct(path, body, fallback, done, keep) {
    var id = louerId;
    var title = $('louer-titre').textContent;
    louerState('Envoi…');
    return send(path, 'POST', body).then(function (res) {
      if (res.gone) return null;
      louerLastCode = null;
      if (!res.ok) {
        louerLastCode = (res.body && res.body.code) || null;
        var text = res.offline ? 'La réponse n’est pas arrivée : rien n’est sûr. Relisez avant de recommencer.' : louerRefusal(res.body, fallback);
        if (res.body && Array.isArray(res.body.problems) && res.body.problems.length) text += ' ' + res.body.problems.map(problemText).join(' ');
        louerState(text);
        if (res.body && res.body.code === 'not_latest_presentation') openLocation(id, title, text);
        return null;
      }
      if (keep) { louerState(done); return res.body.data; }
      return openLocation(id, title, done).then(function () { return res.body.data; });
    });
  }
  var DEPOSIT_TYPES = ${JSON.stringify(RENTAL_DEPOSIT_TYPES)};
  var DEPOSIT_MAX = ${RENTAL_DEPOSIT_MAX_BYTES};
  function hex(buf) { return Array.from(new Uint8Array(buf), function (b) { return (b + 256).toString(16).slice(1); }).join(''); }
  // Le dépôt part tel quel, sous la clé en cours ; une clé refusée passe par send, qui sait la retirer et le dire.
  function louerUpload(path, file, type, sha) {
    var key = t.key();
    if (!key) return Promise.resolve({ gone: true });
    var mine = t.session();
    return fetch(path, { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': type, 'x-aimmo-sha256': sha }, body: file, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' }).then(function (r) {
      return r.json().then(function (b) { return b; }, function () { return null; }).then(function (b) {
        if (mine !== t.session()) return { gone: true };
        if (r.status === 401 || (r.status === 403 && b && b.code === 'agent_inactive')) return send('/v1/location', 'GET').then(function () { return { gone: true }; });
        return { status: r.status, ok: r.ok && !!b && b.ok === true, body: b };
      });
    }, function () { return mine !== t.session() ? { gone: true } : { offline: true }; });
  }
  // Une pièce prise sur le téléphone. Déposée une seule fois : si le geste qui suit est refusé, le même fichier n'est pas renvoyé.
  function piece(box, id, label, kind) {
    var types = DEPOSIT_TYPES[kind];
    var pick = field(box, id, label);
    pick.setAttribute('type', 'file');
    pick.setAttribute('accept', Object.keys(types).join(','));
    var kept = null;
    return {
      picked: function () { return !!(pick.files && pick.files[0]); },
      sha: function () { return kept ? kept.sha : null; },
      // La référence du fichier choisi, après l'avoir déposé ; null si rien n'est rangé, la raison étant dite.
      ref: function (base, query) {
        var at = query || '';
        var file = pick.files && pick.files[0];
        if (!file) return Promise.resolve(null);
        if (kept && kept.file === file && kept.at === at) return Promise.resolve(kept.ref);
        var type = String(file.type || '').toLowerCase();
        if (!Object.prototype.hasOwnProperty.call(types, type)) { louerState(LOUER_REFUSALS.type_refuse); return Promise.resolve(null); }
        if (file.size > DEPOSIT_MAX) { louerState(LOUER_REFUSALS.trop_lourd); return Promise.resolve(null); }
        var mine = t.session();
        louerState('Lecture du fichier…');
        return file.arrayBuffer().then(function (buf) { return crypto.subtle.digest('SHA-256', buf); }).then(function (sum) {
          if (mine !== t.session()) return null;
          louerState('Envoi du fichier…');
          return louerUpload(base + '/fichiers/' + kind + at, file, type, hex(sum)).then(function (res) {
            if (res.gone) return null;
            var ref = res.ok && res.body.data && res.body.data.ref;
            if (typeof ref !== 'string') { louerState(res.offline ? 'Pas de réseau : le fichier n’est pas rangé.' : louerRefusal(res.body, 'Le fichier n’est pas rangé. Réessayez.')); return null; }
            kept = { file: file, at: at, ref: ref, sha: hex(sum) };
            return ref;
          });
        }, function () { if (mine === t.session()) louerState('Ce fichier ne se lit pas sur ce téléphone.'); return null; });
      },
    };
  }
  // Un geste à la fois : un double appui ne dépose pas deux fichiers.
  function once(fn) {
    var busy = false;
    return function () {
      if (busy) return;
      busy = true;
      Promise.resolve(fn()).finally(function () { busy = false; });
    };
  }
  function problemText(p) {
    if (p && p.code === 'critere_location') return 'Critère interdit : « ' + p.value + ' ».';
    if (p && p.code === 'fait_sans_source') return 'Fait sans source : « ' + p.value + ' ».';
    return 'Une phrase est à revoir.';
  }
  var louerSeq = 0;
  // Les séances de signature du bail ouvertes depuis cet appareil : le code attend d'être saisi.
  var signing = {};
  // Le texte du bail préparé depuis cet appareil, par version : à relire avec les parties avant de signer.
  var leaseTexts = {};
  function openLocation(id, title, message) {
    if (!t.key() || !ID.test(id)) return Promise.resolve(false);
    var mine = t.bump();
    clear($('louer-corps'));
    louerId = id;
    t.setId(id);
    $('louer-titre').textContent = title || 'Logement';
    show('louer');
    louerState('Chargement…');
    var base = '/v1/location/' + encodeURIComponent(id);
    var reads = [base, base + '/suivi', base + '/plafonds', base + '/annonces', base + '/candidatures', base + '/presentation', base + '/echeances'];
    return Promise.all(reads.map(function (path) { return send(path, 'GET'); })).then(function (all) {
      if (mine !== t.session() || all.some(function (x) { return x.gone; })) return false;
      if (all[0].offline) { louerState('Pas de réseau. Réessayez dans un moment.'); return false; }
      if (!all[0].ok || !all[1].ok) { louerState(all[0].status === 403 ? 'Ce logement n’est pas dans vos droits.' : 'Indisponible pour le moment. Réessayez plus tard.'); return false; }
      var data = all.map(function (x) { return x.ok ? x.body.data : null; });
      renderLocation(id, base, data, all[2].body);
      louerState(message || '');
      return true;
    });
  }
  function renderLocation(id, base, d, ceilingsBody) {
    var status = d[0] || {};
    var p = d[1] || {};
    var ads = Array.isArray(d[3]) ? d[3] : [];
    var apps = Array.isArray(d[4]) ? d[4] : [];
    var pres = (d[5] && d[5].presentation) || null;
    var chosen = (d[5] && d[5].chosenApplicationId) || null;
    var lease = p.lease || null;
    var check = status.check;
    var rentable = !!(check && check.decision === 'louable' && !status.stale);
    var body = $('louer-corps');
    var steps = [
      ['Logement', rentable ? 'fait' : check && check.decision === 'bloque' && !status.stale ? 'bloque' : ''],
      ['Honoraires', p.fees ? 'fait' : ''],
      ['Annonce', ads.some(function (a) { return a.validatedAt; }) ? 'fait' : ''],
      ['Dossiers', pres ? 'fait' : ''],
      ['Choix', chosen ? 'fait' : ''],
      ['Bail', lease && allSigned(lease) ? (lease.mode === 'essai' ? 'essai' : 'fait') : ''],
      ['État des lieux', p.inventoryClosed ? 'fait' : ''],
      ['Remise des clés', p.handedOn ? 'fait' : ''],
    ];
    var rail = el('ol', null, 'parcours');
    rail.setAttribute('aria-label', 'Étapes de la mise en location');
    var current = false;
    steps.forEach(function (s) {
      var li = el('li', s[0] + (s[1] === 'fait' ? ' · fait' : s[1] === 'bloque' ? ' · bloqué' : s[1] === 'essai' ? ' · signé en essai' : ''), s[1] || null);
      if (!current && s[1] !== 'fait') { current = true; li.setAttribute('aria-current', 'step'); }
      rail.appendChild(li);
    });
    body.appendChild(rail);
    body.appendChild(dwellingBlock(base, status, p.facts, d[6] || []));
    body.appendChild(feesBlock(base, d[2], ceilingsBody, p.fees));
    body.appendChild(adBlock(base, ads, rentable));
    body.appendChild(applicationsBlock(base, apps, pres, chosen));
    if (chosen) body.appendChild(leaseBlock(base, lease));
    if (lease && lease.complete) body.appendChild(inventoryBlock(id, base, p));
    if (lease && lease.complete) body.appendChild(closingBlock(id, base, p));
  }
  /* L'état des lieux à remplir (W16), la remise des clés et la gestion (W16) : servis à part, chargés au premier geste [R201]. */
  var lazyTools = {};
  var lazyBusy = {};
  var closingOpenFor = null;
  function lazy(name, global, act) {
    if (lazyTools[name]) return act(lazyTools[name]);
    if (lazyBusy[name]) return;
    lazyBusy[name] = true;
    var mine = t.session();
    louerState('Chargement…');
    var s = el('script');
    s.setAttribute('src', '/app/' + name + '.js');
    s.addEventListener('load', function () {
      lazyBusy[name] = false;
      var make = globalThis[global];
      try { delete globalThis[global]; } catch (e) { /* rien à retirer */ }
      if (typeof make !== 'function') { if (mine === t.session()) louerState('Pas de réseau. Réessayez dans un moment.'); return; }
      lazyTools[name] = make({ $: $, el: el, clear: clear, send: send, button: button, field: field, select: select, whole: whole, checkbox: checkbox, toCents: toCents, centsText: centsText, details: details, ID: ID, session: t.session, say: louerState, date: date, euros: euros, act: louerAct, openLocation: openLocation, piece: piece, upload: louerUpload, refusals: LOUER_REFUSALS, reload: function (said) { return openLocation(louerId, $('louer-titre').textContent, said); } });
      if (mine === t.session()) { louerState(''); act(lazyTools[name]); }
    });
    s.addEventListener('error', function () {
      lazyBusy[name] = false;
      if (mine === t.session()) louerState('Pas de réseau. Réessayez dans un moment.');
    });
    $('louer').appendChild(s);
  }
  var dossierOpen = null;
  function dossierEntry(base, a) {
    var inner = el('div');
    function go() {
      dossierOpen = a.applicationId;
      lazy('louer-dossier', 'AIMMO_LOUER_DOSSIER', function (tool) { tool.open(inner, base, a); });
    }
    inner.appendChild(button('Compléter ce dossier', go));
    if (dossierOpen === a.applicationId) go();
    return inner;
  }
  function closingBlock(id, base, p) {
    var box = section('Remise des clés et gestion');
    if (p.handedOn) box.appendChild(el('p', 'Clés remises le ' + date(p.handedOn) + '.', 'fait'));
    var inner = el('div');
    box.appendChild(inner);
    function go(keep) {
      closingOpenFor = id;
      lazy('louer-remise', 'AIMMO_LOUER_REMISE', function (tool) { tool.open(inner, base, keep); });
    }
    inner.appendChild(button('Ouvrir la remise des clés', function () { go(false); }));
    if (closingOpenFor === id) go(true);
    return box;
  }
  function reasonText(r) {
    var a = ANNEXES[r.kind] || 'Annexe';
    if (r.code === 'energy_class') return 'Classe énergie ' + r.energyClass + ' : interdite à la location depuis le ' + date(r.bannedFrom + 'T12:00:00Z') + '.';
    if (r.code === 'final_energy') return r.finalEnergyKwh + ' kWh/m²/an en énergie finale : au-delà de 450, interdit depuis le ' + date(r.bannedFrom + 'T12:00:00Z') + '.';
    var said = { living_area: 'Trop petit pour être décent.', local_rules_unchecked: 'Règle locale non vérifiée.', previous_rent_missing: 'Classé F ou G : dites le loyer du locataire précédent, ou « aucun ».', local_rules_failed: 'Règle locale non respectée.', dimensions_missing: 'Dimensions manquantes.', rent_control_missing: 'Loyer encadré dans la commune : saisissez l’arrêté.', complement_forbidden: 'Pas de complément de loyer pour un F ou un G.', complement_unjustified: 'Complément de loyer sans justification.' }[r.code];
    if (said) return said;
    if (r.code === 'rent_freeze') return 'Classé F ou G : le loyer ne peut dépasser celui du locataire précédent, ' + centsText(r.previousRentCents) + ' €.';
    if (r.code === 'rent_above_ceiling') return 'Loyer de base ' + centsText(r.baseRentCents) + ' € : plafond ' + centsText(r.ceilingCents) + ' €.';
    if (r.code === 'annex_missing') return a + ' : manquant.';
    if (r.code === 'annex_expired') return a + ' : échu le ' + date(r.validUntil + 'T12:00:00Z') + '.';
    if (r.code === 'annex_future') return a + ' : daté dans le futur.';
    return 'Raison inconnue.';
  }
  function dwellingBlock(base, status, facts, notices) {
    var box = section('Le logement');
    var c = status.check;
    if (!c) box.appendChild(el('p', 'Pas encore contrôlé : saisissez les faits et les annexes, puis contrôlez.', 'doux'));
    else if (status.stale) box.appendChild(el('p', 'Contrôle caduc (faits, annexes, règle ou date) : contrôlez de nouveau.', 'alerte'));
    else if (c.decision === 'louable') box.appendChild(el('p', 'Louable : contrôlé le ' + date(c.checkedAt) + '.', 'fait'));
    else {
      box.appendChild(el('p', 'Bloqué avant toute annonce : ce logement ne peut pas être proposé.', 'alerte'));
      var ul = el('ul');
      (c.reasons || []).forEach(function (r) { ul.appendChild(el('li', reasonText(r))); });
      box.appendChild(ul);
    }
    if (c && c.bannedFrom) box.appendChild(el('p', 'Classe énergie interdite à la location à partir du ' + date(c.bannedFrom + 'T12:00:00Z') + '.', 'doux'));
    if (facts) {
      box.appendChild(el('p', (facts.furnished ? 'Meublé' : 'Vide') + ' · ' + centsText(facts.rentCents) + ' € hors charges · ' + String(facts.livingAreaHundredths / 100).replace('.', ',') + ' m² · classe ' + facts.energyClass + ' · bail au ' + date(facts.leaseStart + 'T12:00:00Z'), 'doux'));
    }
    var held = el('div');
    box.appendChild(button(facts ? 'Corriger les faits du logement' : 'Saisir les faits du logement', function () { lazy('louer-faits', 'AIMMO_LOUER_FAITS', function (x) { clear(held); x.form(held, base, facts); }); }));
    box.appendChild(held);
    var need = (status.required || []).map(function (k) { return ANNEXES[k] || k; });
    if (need.length) box.appendChild(el('p', 'Annexes exigées : ' + need.join(', ') + '.', 'doux'));
    box.appendChild(annexForm(base, status.required || []));
    box.appendChild(button('Contrôler le logement', function () { louerAct(base + '/controle', undefined, 'Le contrôle n’est pas fait.', 'Contrôle fait.'); }));
    notices.forEach(function (n) {
      box.appendChild(el('h4', 'Échéance préparée pour le propriétaire'));
      box.appendChild(el('p', 'Mode essai : elle partira par le contrôle central des envois, rien ne part d’ici.', 'doux'));
      box.appendChild(el('p', n.text, 'brouillon'));
    });
    return box;
  }
  function annexForm(base, required) {
    var n = ++louerSeq;
    var d = details(el('div'), 'Joindre une annexe');
    var kinds = {};
    Object.keys(ANNEXES).forEach(function (k) { kinds[k] = ANNEXES[k]; });
    var kind = select(d, 'annexe-' + n, 'Annexe', kinds, required[0] || 'dpe');
    var file = piece(d, 'annexe-fichier-' + n, 'Le document, en PDF ou en photo', 'annexe');
    var on = field(d, 'annexe-date-' + n, 'Date du diagnostic');
    on.setAttribute('type', 'date');
    d.appendChild(button('Joindre l’annexe', once(function () {
      if (!file.picked()) { louerState('Choisissez d’abord le document.'); return null; }
      if (!on.value) { louerState('Indiquez la date du diagnostic.'); return null; }
      return file.ref(base).then(function (ref) {
        if (!ref) return null;
        return louerAct(base + '/annexes', { kind: kind.value, ref: ref, diagnosedOn: on.value }, 'L’annexe n’est pas jointe : vérifiez le document et la date.', 'Annexe jointe : contrôlez de nouveau le logement.');
      });
    })));
    return d;
  }
  function feesBlock(base, c, ceilingsBody, fees) {
    var box = section('Honoraires et dépôt de garantie');
    box.appendChild(el('p', 'Plafonds selon la surface et la zone. AIMMO ne reçoit jamais ni loyer ni dépôt.', 'doux'));
    if (!c) {
      var code = ceilingsBody && ceilingsBody.code;
      box.appendChild(el('p', code === 'no_commune' ? 'Indiquez la commune du logement pour connaître les plafonds.' : louerRefusal(ceilingsBody, 'Plafonds indisponibles pour le moment.'), 'doux'));
      if (code === 'no_commune') {
        var n = ++louerSeq;
        var insee = field(box, 'insee-' + n, 'Code INSEE de la commune');
        insee.setAttribute('maxlength', '5');
        insee.setAttribute('autocomplete', 'off');
        box.appendChild(button('Ranger la commune', function () { louerAct(base + '/commune', { inseeCode: String(insee.value || '').trim().toUpperCase() }, 'La commune n’est pas rangée.', 'Commune rangée.'); }));
      }
      return box;
    }
    if (c.zone === 'inconnue') box.appendChild(el('p', 'Zone de la commune inconnue : le plafond le plus bas s’applique.', 'doux'));
    var ul = el('ul', null, 'liste');
    ul.appendChild(line('Honoraires du locataire : ' + euros(c.tenantCeilingCents) + ' au plus'));
    ul.appendChild(line('État des lieux à sa charge : ' + euros(c.inventoryCeilingCents) + ' au plus'));
    ul.appendChild(line('Dépôt de garantie : ' + euros(c.depositCeilingCents) + ' au plus'));
    box.appendChild(ul);
    if (fees) box.appendChild(el('p', 'Rangés : à la charge du locataire ' + euros(fees.tenantCents + fees.tenantInventoryCents) + ', dont état des lieux ' + euros(fees.tenantInventoryCents) + ' ; du bailleur ' + euros(fees.landlordCents + fees.landlordInventoryCents) + ', dont état des lieux ' + euros(fees.landlordInventoryCents) + ' ; dépôt ' + euros(fees.depositCents) + '.', 'fait'));
    var m = ++louerSeq;
    var d = details(box, fees ? 'Changer les honoraires' : 'Ranger les honoraires');
    var src = fees || { tenantCents: c.tenantCeilingCents, tenantInventoryCents: c.inventoryCeilingCents, landlordCents: c.tenantCeilingCents, landlordInventoryCents: c.inventoryCeilingCents, depositCents: c.depositCeilingCents };
    var inputs = [['tenantCents', 'Honoraires du locataire, hors état des lieux, en euros'], ['tenantInventoryCents', 'État des lieux à la charge du locataire, en euros'], ['landlordCents', 'Honoraires du bailleur, hors état des lieux, en euros'], ['landlordInventoryCents', 'État des lieux à la charge du bailleur, en euros'], ['depositCents', 'Dépôt de garantie, en euros']].map(function (x, i) {
      var f = field(d, 'hon-' + m + '-' + i, x[1]);
      f.setAttribute('inputmode', 'decimal');
      f.value = centsText(src[x[0]]);
      return [x[0], f];
    });
    d.appendChild(button('Ranger les honoraires', function () {
      var b = {};
      var bad = false;
      inputs.forEach(function (x) { var v = toCents(x[1].value); if (v === null) bad = true; b[x[0]] = v; });
      if (bad) { louerState('Des montants en euros, par exemple 425 ou 425,50.'); return; }
      louerAct(base + '/honoraires', b, 'Les honoraires ne sont pas rangés.', 'Honoraires rangés.');
    }));
    return box;
  }
  function adBlock(base, ads, rentable) {
    var box = section('L’annonce');
    var ad = ads.length ? ads[ads.length - 1] : null;
    if (!rentable) box.appendChild(el('p', 'L’annonce attend un logement contrôlé louable.', 'doux'));
    if (ad) {
      box.appendChild(el('h4', ad.title));
      box.appendChild(el('p', ad.body, 'brouillon'));
      box.appendChild(el('p', ad.mentions, 'doux'));
      box.appendChild(el('p', ad.origin === 'ia' ? 'Rédigée par l’IA, chaque fait relié au code.' : ad.origin === 'secours' ? 'Rédigée sans IA, depuis les faits rangés.' : 'Écrite par vous.', 'doux'));
      if (ad.validatedAt) box.appendChild(el('p', 'Validée le ' + date(ad.validatedAt) + '.', 'fait'));
      else if (ID.test(ad.adId)) box.appendChild(button('Valider l’annonce', function () { louerAct('/v1/location/annonces/' + encodeURIComponent(ad.adId) + '/validation', undefined, 'L’annonce n’est pas validée.', 'Annonce validée.'); }));
    }
    if (rentable) {
      var again = button(ad ? 'Préparer une nouvelle version' : 'Préparer l’annonce', function () { louerAct(base + '/annonces/brouillon', undefined, 'L’annonce n’est pas préparée.', 'Annonce préparée : relisez-la avant de la valider.'); });
      if (ad) again.className = 'secondaire';
      box.appendChild(again);
    }
    return box;
  }
  function missingText(m) { return (PIECES_MISSING[m.what] || 'pièce') + (m.holder === 'candidat' ? '' : ' du garant'); }
  // L'agent choisit parmi ses contacts, sans saisir d'identifiant ; la candidature prend la dernière place d'arrivée.
  function applyBlock(base) {
    var d = el('details');
    d.appendChild(el('summary', 'Ajouter une candidature'));
    var loaded = false;
    d.appendChild(button('Choisir parmi mes contacts', function () {
      if (loaded) return;
      loaded = true;
      louerState('Chargement…');
      send(base + '/contacts', 'GET').then(function (res) {
        if (res.gone) return;
        if (!res.ok) { loaded = false; louerState(res.offline ? 'Pas de réseau. Réessayez dans un moment.' : 'Vos contacts sont indisponibles pour le moment.'); return; }
        var list = res.body.data.contacts || [];
        louerState(list.length ? (res.body.data.more ? 'Seuls les 500 premiers contacts sont proposés.' : '') : 'Aucun autre contact à proposer sur ce logement.');
        if (!list.length) { loaded = false; return; }
        var options = { '': 'Choisir une personne' };
        list.forEach(function (p) {
          options[p.personId] = [p.firstName, p.lastName].filter(Boolean).join(' ') || 'Contact sans nom';
        });
        var who = select(d, 'louer-candidat', 'La personne', options, '');
        var link = field(d, 'louer-candidat-lien', 'Lien DossierFacile (facultatif)');
        var sending = false;
        d.appendChild(button('Ranger la candidature', function () {
          if (sending) return;
          if (!who.value) { louerState('Choisissez d’abord la personne.'); return; }
          sending = true;
          var body = { personId: who.value };
          if (String(link.value || '').trim()) body.dossierFacileUrl = String(link.value).trim();
          louerAct(base + '/candidatures', body, 'La candidature n’est pas rangée.', 'Candidature rangée, à sa place d’arrivée.').then(function () { sending = false; });
        }));
      });
    }));
    return d;
  }
  function applicationsBlock(base, apps, pres, chosen) {
    var box = section('Les candidatures');
    box.appendChild(el('p', 'Dans leur ordre d’arrivée. Seules les pièces de la liste officielle sont demandées.', 'doux'));
    if (!chosen) box.appendChild(applyBlock(base));
    if (!apps.length) { box.appendChild(el('p', 'Aucune candidature pour le moment.', 'doux')); return box; }
    var ol = el('ol', null, 'dossiers');
    // L'ordre reçu de l'API est celui des arrivées : il n'est jamais retrié ici [R105].
    apps.forEach(function (a) {
      var li = el('li');
      li.appendChild(el('strong', 'Dossier arrivé ' + (a.arrival === 1 ? 'en premier' : 'en ' + a.arrival + 'ᵉ') + (a.applicationId === chosen ? ' · choisi par le propriétaire' : '')));
      li.appendChild(el('p', 'Le ' + date(a.arrivedAt) + (a.dossierFacile ? ' · dossier DossierFacile' : '') + ' · ' + (a.pieces || []).length + ' pièce' + ((a.pieces || []).length > 1 ? 's' : '') + (a.guarantors && a.guarantors.length ? ' · garant' : ''), 'doux'));
      li.appendChild(el('p', a.complete ? 'Complet' : 'Incomplet : manque ' + (a.missing || []).map(missingText).join(', ') + '.', a.complete ? 'fait' : null));
      if (!chosen && !a.dossierFacile && ID.test(a.applicationId)) li.appendChild(dossierEntry(base, a));
      ol.appendChild(li);
    });
    box.appendChild(ol);
    if (!chosen) {
      var again = button(pres ? 'Présenter de nouveau au propriétaire' : 'Présenter les dossiers complets au propriétaire', function () {
        louerAct(base + '/presentation', undefined, 'La présentation n’est pas faite.', 'Présentation faite : les reçus d’équité sont préparés en mode essai.');
      });
      if (pres) again.className = 'secondaire';
      box.appendChild(again);
    }
    if (pres) box.appendChild(choiceBlock(base, pres, chosen));
    return box;
  }
  function choiceBlock(base, pres, chosen) {
    var box = el('div', null, 'proposer');
    box.appendChild(el('h4', 'Présentés au propriétaire le ' + date(pres.createdAt)));
    if (!pres.files.length) { box.appendChild(el('p', 'Aucun dossier complet à lui présenter : les candidats ont reçu ce qui leur manque.', 'doux')); return box; }
    var ol = el('ol', null, 'dossiers');
    pres.files.forEach(function (f) {
      var li = el('li', 'Dossier arrivé ' + (f.arrival === 1 ? 'en premier' : 'en ' + f.arrival + 'ᵉ') + ', le ' + date(f.arrivedOn + 'T12:00:00Z'));
      li.appendChild(el('p', (f.pieces || []).join(', ') + (f.guarantors && f.guarantors.length ? ' ; garant : ' + f.guarantors.map(function (g) { return g === 'visale' ? 'Visale' : 'une personne'; }).join(', ') : ''), 'doux'));
      ol.appendChild(li);
    });
    box.appendChild(ol);
    if (chosen) { box.appendChild(el('p', 'Le propriétaire a choisi : son choix est rangé avec sa date et sa preuve.', 'fait')); return box; }
    var n = ++louerSeq;
    var set = el('fieldset');
    set.appendChild(el('legend', 'Le dossier choisi par le propriétaire'));
    var radios = [];
    pres.files.forEach(function (f, i) {
      if (!ID.test(f.applicationId)) return;
      var wrap = el('div', null, 'case');
      var c = el('input');
      c.setAttribute('type', 'radio');
      c.setAttribute('name', 'dossier-' + n);
      c.setAttribute('id', 'dossier-' + n + '-' + i);
      c.value = f.applicationId;
      var l = el('label', 'Dossier arrivé ' + (f.arrival === 1 ? 'en premier' : 'en ' + f.arrival + 'ᵉ'));
      l.setAttribute('for', 'dossier-' + n + '-' + i);
      wrap.appendChild(c);
      wrap.appendChild(l);
      set.appendChild(wrap);
      radios.push(c);
    });
    box.appendChild(set);
    var when = field(box, 'quand-' + n, 'Quand il a choisi');
    when.setAttribute('type', 'datetime-local');
    var how = select(box, 'comment-' + n, 'Comment il l’a dit', CHOICE_CHANNELS, 'oral');
    var proof = piece(box, 'preuve-' + n, 'Sa preuve : photo, PDF ou texte écrit', 'preuve');
    box.appendChild(button('Enregistrer son choix', once(function () {
      var picked = radios.filter(function (c) { return c.checked; })[0];
      if (!picked) { louerState('Cochez le dossier choisi par le propriétaire.'); return null; }
      var at = new Date(when.value);
      if (!when.value || isNaN(at.getTime())) { louerState('Indiquez quand le propriétaire a choisi.'); return null; }
      if (!proof.picked()) { louerState('Choisissez d’abord la preuve de son choix.'); return null; }
      return proof.ref(base).then(function (ref) {
        if (!ref) return null;
        return louerAct(base + '/choix', { presentationId: pres.presentationId, applicationId: picked.value, decidedAt: at.toISOString(), channel: how.value, proofRef: ref }, 'Le choix n’est pas enregistré.', 'Choix du propriétaire enregistré.');
      });
    })));
    return box;
  }
  function leaseBlock(base, lease) {
    var box = section('Le bail');
    if (lease) {
      box.appendChild(el('p', (lease.complete ? 'Bail en vigueur, complet' : 'Bail en vigueur, incomplet : complétez-le') + (lease.mode === 'essai' ? ' · document d’essai, sans valeur avant validation des modèles.' : '.'), lease.complete ? 'fait' : 'alerte'));
      var reading = el('div');
      box.appendChild(reading);
      var showLease = function (text) {
        clear(reading);
        var read = details(reading, 'Lire le bail avec les parties');
        read.setAttribute('open', '');
        read.appendChild(el('p', text, 'brouillon'));
      };
      if (leaseTexts[lease.leaseId]) showLease(leaseTexts[lease.leaseId]);
      else if (lease.complete) reading.appendChild(button('Relire le bail avec les parties', once(function () {
        return send(base + '/bail/texte', 'GET').then(function (res) {
          if (res.gone) return;
          if (!res.ok) { louerState(res.offline ? 'Pas de réseau. Réessayez dans un moment.' : louerRefusal(res.body, 'Indisponible pour le moment. Réessayez plus tard.')); return; }
          leaseTexts[res.body.data.leaseId] = res.body.data.content;
          showLease(res.body.data.content);
        });
      })));
      ['bailleur', 'locataire'].forEach(function (party) { box.appendChild(signBlock(base, lease, party)); });
      (lease.colocataires || []).forEach(function (c, i) { if (ID.test(String(c.personId))) box.appendChild(signBlock(base, lease, 'colocataire', { personId: c.personId, signedAt: c.signedAt, n: i + 1 })); });
      if (allSigned(lease)) {
        if (lease.copiesSent && lease.copiesSent.length === 2 && (lease.cotenantCopiesSent || []).length === (lease.colocataires || []).length) box.appendChild(el('p', 'Un exemplaire préparé pour chacun (mode essai).', 'fait'));
        else box.appendChild(button('Préparer un exemplaire pour chacun', function () { louerAct(base + '/bail/exemplaires', undefined, 'Les exemplaires ne sont pas préparés.', 'Exemplaires préparés : ils partiront par le contrôle central, en mode essai.'); }));
      }
    } else box.appendChild(el('p', 'Bail fait du modèle validé, des faits, des honoraires et du dossier choisi.', 'doux'));
    var n = ++louerSeq;
    var d = details(box, lease ? 'Refaire le bail (les signatures seront à refaire)' : 'Préparer le bail');
    var address = field(d, 'bail-adresse-' + n, 'Adresse du logement');
    var owner = field(d, 'bail-domicile-' + n, 'Domicile du bailleur');
    var habitat = select(d, 'bail-habitat-' + n, 'Type d’habitat', HABITATS, 'collectif');
    var owner2 = select(d, 'bail-qualite-' + n, 'Le bailleur est', { '': 'À choisir', physique: 'Une personne', morale: 'Une société' }, '');
    var equipment = field(d, 'bail-equipements-' + n, 'Équipements du logement', 'textarea');
    equipment.setAttribute('rows', '3');
    equipment.setAttribute('maxlength', '400');
    var card = field(d, 'bail-carte-' + n, 'Carte professionnelle (CPI …)');
    var notice = piece(d, 'bail-notice-' + n, 'La notice d’information, en PDF', 'notice');
    [address, owner, card].forEach(function (x) { x.setAttribute('autocomplete', 'off'); });
    d.appendChild(button('Préparer le bail', once(function () {
      var b = { habitat: habitat.value, landlord: owner2.value };
      [['address', address], ['ownerAddress', owner], ['equipment', equipment], ['professionalCard', card]].forEach(function (x) { var v = String(x[1].value || '').trim(); if (v) b[x[0]] = v; });
      var joined = notice.picked() ? notice.ref(base) : Promise.resolve(undefined);
      return joined.then(function (ref) {
        if (ref === null) return null;
        if (ref) b.noticeRef = ref;
        return louerAct(base + '/bail', b, 'Le bail n’est pas préparé.', '', true).then(function (l) {
          if (!l) return;
          if (ID.test(l.leaseId) && typeof l.content === 'string') leaseTexts[l.leaseId] = l.content;
          var missing = (l.missing || []).map(function (k) { return LEASE_LABELS[String(k).split('.').map(function (x) { return x.slice(0, 4); }).join('.')] || 'un champ'; });
          return openLocation(louerId, $('louer-titre').textContent, missing.length ? 'Bail préparé, à compléter : ' + missing.join(', ') + '.' : 'Bail préparé, complet : il est à signer.');
        });
      });
    })));
    return box;
  }
  // La signature d'une partie : son accord pour signer en ligne, le code reçu, et une trace facultative du doigt.
  // Le bail est signé quand le bailleur, le locataire et chaque colocataire l'ont signé (AU097).
  function allSigned(l) { return !!(l.bailleur && l.locataire) && (l.colocataires || []).every(function (c) { return c.signedAt; }); }
  function signBlock(base, lease, party, co) {
    // AU097 · un colocataire signe le même bail, en son nom.
    var name = co ? 'le colocataire ' + co.n : PARTY_NAMES[party], to = co ? 'au colocataire ' + co.n : PARTY_TO[party], of = co ? 'du colocataire ' + co.n : PARTY_OF[party], at = co ? co.signedAt : lease[party];
    var box = el('div', null, 'client');
    box.appendChild(el('h4', 'Signature ' + of));
    if (at) { box.appendChild(el('p', 'Signé le ' + date(at) + ' à ' + hour(at) + ' (essai).', 'fait')); return box; }
    if (!lease.complete) { box.appendChild(el('p', 'À signer une fois le bail complet.', 'doux')); return box; }
    var n = ++louerSeq;
    var key = lease.leaseId + ':' + party + (co ? ':' + co.personId : '');
    var s = signing[key];
    if (!s) {
      var consent = field(box, 'accord-' + n, 'Comment ' + name + ' a accepté de signer en ligne', 'textarea');
      consent.setAttribute('rows', '2');
      consent.setAttribute('maxlength', '300');
      box.appendChild(button('Envoyer le code de signature ' + to, function () {
        var text = String(consent.value || '').trim();
        if (!text) { louerState(LOUER_REFUSALS.bad_consent); return; }
        louerAct(base + '/bail/signatures', co ? { party: party, personId: co.personId, consentProof: text } : { party: party, consentProof: text }, 'Le code n’est pas envoyé.', '', true).then(function (r) {
          if (!r || !ID.test(r.sessionId)) return;
          signing[key] = r.sessionId;
          // X17b · en essai, le serveur rend le code, posé ici pour essayer le parcours : rien n'est parti.
          var trial = typeof r.trialCode === 'string' && /^[0-9]{6}$/.test(r.trialCode) ? ' Code d’essai : ' + r.trialCode + ' (rien n’est parti).' : '';
          openLocation(louerId, $('louer-titre').textContent, 'Code préparé pour ' + name + ' (mode essai) : saisissez-le quand il vous le dit.' + trial);
        });
      }));
      return box;
    }
    var code = field(box, 'code-' + n, 'Code reçu par ' + name);
    code.setAttribute('inputmode', 'numeric');
    code.setAttribute('maxlength', '6');
    code.setAttribute('autocomplete', 'one-time-code');
    var trace = pad(box, 'Trace de la signature, facultative');
    var resend = button('Renvoyer un code', function () { delete signing[key]; openLocation(louerId, $('louer-titre').textContent, 'Notez de nouveau l’accord, puis envoyez un nouveau code.'); });
    resend.className = 'secondaire';
    box.appendChild(button('Signer pour ' + name, function () {
      var b = { code: String(code.value || '').trim() };
      if (trace.value()) b.drawing = trace.value();
      louerAct('/v1/location/signatures-bail/' + encodeURIComponent(s), b, 'La signature n’est pas rangée.', 'Signature rangée (essai).', true).then(function (r) {
        // Un code expiré, bloqué ou remplacé : la séance est oubliée, l'écran propose d'envoyer un nouveau code.
        if (!r && ['expired', 'blocked', 'superseded', 'unknown_session'].indexOf(louerLastCode) !== -1) {
          var said = louerRefusal({ code: louerLastCode }, '');
          delete signing[key];
          openLocation(louerId, $('louer-titre').textContent, said);
          return;
        }
        if (!r) return;
        delete signing[key];
        openLocation(louerId, $('louer-titre').textContent, 'Signature ' + of + ' rangée (essai).');
      });
    }));
    box.appendChild(resend);
    return box;
  }
  // Une zone où tracer du doigt : la trace est une suite de points, jamais une image envoyée ailleurs.
  function pad(box, label) {
    var n = ++louerSeq;
    box.appendChild(el('p', label, 'doux'));
    var c = el('canvas', null, 'trace');
    c.setAttribute('id', 'trace-' + n);
    c.setAttribute('role', 'img');
    c.setAttribute('aria-label', label + ' : tracez avec le doigt dans ce cadre');
    c.setAttribute('width', '320');
    c.setAttribute('height', '140');
    var strokes = [];
    var down = false;
    var ctx = null;
    try { ctx = c.getContext ? c.getContext('2d') : null; } catch (e) { ctx = null; }
    function at(e) { return [Math.max(0, Math.round(Number(e.offsetX) || 0)), Math.max(0, Math.round(Number(e.offsetY) || 0))]; }
    c.addEventListener('pointerdown', function (e) {
      if (e && e.preventDefault) e.preventDefault();
      down = true;
      strokes.push([at(e)]);
      if (ctx) { ctx.beginPath(); ctx.moveTo(at(e)[0], at(e)[1]); }
    });
    c.addEventListener('pointermove', function (e) {
      if (!down || strokes.length > 200) return;
      var s = strokes[strokes.length - 1];
      if (s.length < 2000) s.push(at(e));
      if (ctx) { ctx.lineTo(at(e)[0], at(e)[1]); ctx.stroke(); }
    });
    c.addEventListener('pointerup', function () { down = false; });
    c.addEventListener('pointerleave', function () { down = false; });
    box.appendChild(c);
    var wipeIt = button('Effacer la trace', function () {
      strokes = [];
      if (ctx) try { ctx.clearRect(0, 0, 320, 140); } catch (e) { /* rien à effacer */ }
    });
    wipeIt.className = 'secondaire';
    box.appendChild(wipeIt);
    return {
      value: function () {
        var t = strokes.filter(function (s) { return s.length > 1; }).map(function (s) { return s.map(function (p) { return p[0] + ',' + p[1]; }).join(' '); }).join(';');
        return t.length >= 10 ? t : '';
      },
    };
  }
  // L'état des lieux d'entrée, pièce par pièce, sur le téléphone : l'IA ne fait que mettre en forme le dicté [R106].
  function inventoryBlock(id, base, p) {
    var box = section('L’état des lieux d’entrée');
    if (p.inventoryClosed) {
      box.appendChild(el('p', 'Signé des deux parties : un exemplaire pour chacun.', 'fait'));
      /* Il porte l'identité des deux parties : lu seulement au geste, jamais gardé [R16, R106]. */
      var copyShown = el('div');
      if (p.closedInventoryId && ID.test(p.closedInventoryId)) box.appendChild(button('Lire l’exemplaire signé', once(function () {
        clear(copyShown);
        return send('/v1/location/etats-des-lieux/' + encodeURIComponent(p.closedInventoryId) + '/exemplaires/bailleur', 'GET').then(function (res) {
          if (res.gone) return;
          if (!res.ok) { louerState(res.offline ? 'Pas de réseau. Réessayez dans un moment.' : res.status === 403 ? 'Cet exemplaire n’est pas dans vos droits : il porte l’identité des deux parties.' : res.body && res.body.code === 'document_changed' ? 'Cet exemplaire ne correspond plus à ce qui a été signé : il n’est pas montré. Prévenez la direction.' : louerRefusal(res.body, 'Indisponible pour le moment. Réessayez plus tard.')); return; }
          louerState('');
          copyShown.appendChild(el('p', res.body.data.content, 'brouillon'));
          copyShown.appendChild(el('p', 'Le même exemplaire pour chacun. Empreinte : ' + res.body.data.contentSha256, 'doux'));
        });
      })));
      box.appendChild(copyShown);
      return box;
    }
    // L'état des lieux rangé et pas encore signé des deux parties est relu du serveur : un rechargement ne le perd pas.
    var done = p.inventory || null;
    if (done) box.appendChild(inventorySign(id, done));
    var holder = el('div');
    box.appendChild(holder);
    var start = button(done ? 'Refaire l’état des lieux' : 'Faire l’état des lieux, pièce par pièce', function () {
      lazy('louer-edl', 'AIMMO_LOUER_EDL', function (tool) { clear(holder); tool.form(holder, id, base, p); });
    });
    if (done) start.className = 'secondaire';
    holder.appendChild(start);
    return box;
  }
  function inventorySign(id, inv) {
    var box = el('div', null, 'vente');
    box.appendChild(el('h4', 'À relire avec les deux parties'));
    box.appendChild(el('p', inv.content, 'brouillon'));
    if (inv.status !== 'complet') { box.appendChild(el('p', 'Incomplet : complétez-le avant de le signer.', 'alerte')); return box; }
    if ((inv.signed || []).length) box.appendChild(el('p', 'Le refaire annulerait la signature déjà donnée : faites signer cette version.', 'doux'));
    ['bailleur', 'locataire'].forEach(function (party) {
      if ((inv.signed || []).indexOf(party) !== -1) { box.appendChild(el('p', 'Signé par ' + PARTY_NAMES[party] + '.', 'fait')); return; }
      var trace = pad(box, party === 'bailleur' ? 'Signature du bailleur' : 'Signature du locataire');
      box.appendChild(button('Signer pour ' + PARTY_NAMES[party], function () {
        var t = trace.value();
        if (!t) { louerState(LOUER_REFUSALS.bad_drawing); return; }
        louerAct('/v1/location/etats-des-lieux/' + encodeURIComponent(inv.inventoryId) + '/signatures', { party: party, contentSha256: inv.contentSha256, drawing: t }, 'La signature n’est pas rangée.', '', true).then(function (r) {
          if (!r) return;
          openLocation(id, $('louer-titre').textContent, r.closed ? 'État des lieux signé des deux parties.' : 'Signature ' + PARTY_OF[party] + ' rangée.');
        });
      }));
    });
    return box;
  }
  return { open: openLouer, wipe: wipeLouer, forget: forgetLouer };
};
`.replace(/^[ \t]*(?:\/\/.*|\/\*.*\*\/)[ \t]*\n/gm, '')
  // L'indentation ne sert qu'à lire la source : elle ne part pas au téléphone (R201). Aucune chaîne du script ne court sur deux lignes.
  .replace(/^[ \t]+/gm, '');
