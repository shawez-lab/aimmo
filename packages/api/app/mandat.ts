/**
 * L'écran « Mandat » de l'application de l'agent (D12), en morceaux posés dans `fichiers.ts` : sa section, son chargeur et
 * son script, servi à part (`/app/mandat.js`) et chargé à la première ouverture pour tenir le budget [R201]. Il s'ouvre
 * depuis « Mes biens ».
 *
 * L'agent génère le mandat, lit le contrôle ligne par ligne, enregistre la signature sur papier avec le scan déposé, voit
 * le numéro au registre et l'exemplaire. L'écran ne lit et n'écrit que par les routes [R16] et ne calcule ni numéro ni
 * honoraires [R39] : il pose ce que le code rend. Le formulaire de signature n'existe qu'après un contrôle réussi [R41].
 * Un document d'essai est dit tel [R40]. Après un contrôle réussi, l'écran dit si la signature en ligne est réelle ou
 * seulement d'essai, et ce qu'elle attend (AU003).
 * X17 : l'agent y fait aussi signer en ligne, accord du mandant noté ; en essai, le code rendu par le serveur est montré
 * pour essayer le parcours, sans valeur juridique ; en réel, il ne part qu'au mandant.
 * L'agent y note aussi la rétractation reçue et la demande écrite de commencer tout de suite (D16) [R42] ; le code seul
 * décide si la date tient, l'écran n'en dit que le refus. Sur un mandat en cours, il lit les conditions en vigueur,
 * prépare et enregistre un avenant de prix ou de durée (D17) [R41].
 * Tout texte reçu est posé avec `textContent`, et rien ne reste à l'écran une fois quitté.
 */
import { FILE_DEPOSIT_MAX_BYTES, FILE_DEPOSIT_TYPES } from '../../core/src/dossiers/depot.ts';
import type { DiffusionReason } from '../../core/src/documents/retractation.ts';
import { TEMPLATE_FIELDS } from '../../core/src/documents/modeles.ts';
import { SIGNATURE_PLACES, type SignaturePlace } from '../../core/src/documents/signature-papier.ts';
import { MANDATE_SOURCES, type MandateSource } from '../../core/src/mandats/source.ts';

const REFUSALS = {
  no_template: 'Aucun modèle de mandat n’est encore enregistré : voyez avec la direction.',
  bad_input: 'Vérifiez les honoraires, leur charge et la durée.',
  unknown_kind: 'Choisissez le type de mandat.',
  bad_date: 'La date de signature : un vrai jour, jamais à venir.',
  bad_place: 'Choisissez le lieu de signature.',
  bad_scan: 'Ce scan n’est pas celui de ce bien : choisissez-le de nouveau.',
  scan_absent: 'Le scan n’est pas rangé : choisissez-le de nouveau.',
  scan_deja_utilise: 'Ce scan prouve déjà une autre signature : choisissez le bon fichier.',
  depot_ferme: 'Le dépôt des fichiers n’est pas encore branché : rien ne se signe sans le scan.',
  already_signed: 'Ce mandat est déjà signé.',
  bad_consent: 'Notez comment le mandant a accepté de signer en ligne (300 caractères au plus).',
  bad_signer: 'Cette personne n’est pas mandant de ce document.',
  send_refused: 'Le code n’est pas parti : le mandant n’a pas de mail, ou l’envoi n’est pas permis à cette heure.',
  wrong_code: 'Code faux : vérifiez-le avec le mandant.',
  expired: 'Le code a expiré : renvoyez-en un.',
  blocked: 'Trop de codes faux : renvoyez un nouveau code.',
  document_changed: 'Le document a changé depuis l’envoi du code : contrôlez-le de nouveau.',
  unknown_session: 'Cette signature n’est plus ouverte : renvoyez un code.',
  mandate_in_force: 'Un mandat est déjà en cours sur ce bien : ce document ne se signe pas.',
  not_a_mandate: 'Ce document n’est pas un mandat.',
  no_number_field: 'Ce modèle n’a pas de place pour le numéro au registre : voyez avec la direction.',
  not_configured: 'Le registre des mandats n’est pas encore réglé : voyez avec la direction.',
  register_broken: 'Le registre des mandats est abîmé : voyez avec la direction.',
  not_inscribed: 'Le mandat n’a pas reçu son numéro : réessayez.',
  no_number_on_copy: 'L’exemplaire ne porte pas son numéro : voyez avec la direction.',
  no_agent: 'Cette fiche n’a pas d’agent : voyez avec la direction.',
  missing_source: 'Dites d’où vient ce mandat.',
  missing_detail: 'Pour « Autre », précisez d’où vient ce mandat.',
  unknown_source: 'Choisissez l’origine dans la liste.',
  detail_too_long: 'La précision est trop longue.',
  forbidden_source: 'Un mandat ne peut pas venir des ventes publiques ni d’une liste achetée.',
  type_refuse: 'Ce fichier n’est pas admis : PDF, JPEG ou PNG.',
  trop_lourd: 'Ce fichier dépasse 20 Mo.',
  fichier_vide: 'Ce fichier est vide.',
  empreinte_differente: 'Le fichier a mal voyagé : réessayez.',
  stockage_indisponible: 'Le stockage ne répond pas : réessayez plus tard.',
  not_signed: 'L’exemplaire n’existe pas encore.',
  bad_mandate: 'Ce mandat n’est plus en cours, ou ce mandant n’est pas le sien : l’avenant n’est pas préparé.',
  no_mandate: 'Le mandat de cet avenant n’est plus en cours : il ne se signe pas.',
  before_mandate: 'Un avenant ne se signe pas avant son mandat : vérifiez le jour.',
  bad_address: 'L’adresse : un numéro et une voie, un code postal à cinq chiffres, une commune.',
  bad_parcels: 'Les parcelles : une section et un numéro, chacune une seule fois.',
};
/** Chaque ligne du contrôle, dite en français ; un code inconnu reste un échec, jamais un succès [R41]. */
const CHECKS = {
  complete: 'Tous les champs sont remplis.',
  missing_fields: 'Des champs obligatoires manquent.',
  validated_template: 'Le modèle est validé.',
  trial_template: 'Document d’essai : son modèle n’est pas validé, il ne se signe pas.',
  fee_in_schedule: 'Les honoraires respectent le barème.',
  fee_or_price_unknown: 'Les honoraires ou le prix ne sont pas connus.',
  fee_payer_unknown: 'On ne sait pas qui paie les honoraires.',
  no_fee_schedule: 'Le barème des honoraires n’est pas réglé : voyez avec la direction.',
  fee_above_schedule: 'Les honoraires dépassent le barème.',
  fee_below_minimum: 'Les honoraires sont sous le minimum du barème.',
  mandants_match: 'Le mandant est bien le propriétaire du bien.',
  no_property: 'Ce document n’est rattaché à aucun bien.',
  owners_unknown: 'Le propriétaire du bien n’est pas connu.',
  mandants_differ: 'Le mandant n’est pas le propriétaire du bien.',
  identity_verified: 'L’identité du mandant est vérifiée.',
  identity_missing: 'L’identité du mandant n’est pas vérifiée : déposez sa pièce au coffre de la conformité.',
  identity_expired: 'La vérification d’identité du mandant a expiré : déposez une pièce à jour au coffre de la conformité.',
  kbis_missing: 'L’extrait Kbis de la société manque : rangez-le au coffre de la conformité.',
  kbis_expired: 'L’extrait Kbis de la société a expiré : rangez-en un à jour au coffre de la conformité.',
  beneficial_owners_missing: 'Les bénéficiaires effectifs ne sont pas renseignés.',
  beneficial_owner_unidentified: 'Un bénéficiaire effectif n’est pas identifié.',
  no_mandate: 'Cet avenant n’est rattaché à aucun mandat.',
  mandate_not_numbered: 'Le mandat de cet avenant n’est pas au registre.',
  mandate_withdrawn: 'Le mandant s’est rétracté : cet avenant ne se signe pas.',
  mandate_cancelled: 'Le mandat de cet avenant est annulé au registre.',
  mandate_expired: 'Le mandat de cet avenant est arrivé à échéance.',
  mandate_in_force: 'Le mandat de cet avenant est en cours.',
  fees_unchanged: 'Les honoraires ne changent pas.',
};
const DIFFUSION: Record<DiffusionReason, string> = {
  no_mandate: 'Le mandat n’est pas au registre : le bien ne se diffuse pas.',
  cancelled: 'Mandat annulé au registre : le bien ne se diffuse pas.',
  withdrawn: 'Le mandant s’est rétracté : le bien ne se diffuse pas.',
  expired: 'Mandat arrivé à échéance : le bien ne se diffuse plus.',
  duration_unknown: 'La durée du mandat n’est pas connue : le bien ne se diffuse pas.',
  withdrawal_period: 'Délai de rétractation en cours : le bien ne se diffuse pas encore.',
  allowed: 'Le bien peut être diffusé.',
  allowed_early_start: 'Le bien peut être diffusé : le mandant a demandé de commencer tout de suite.',
};
/** Les deux gestes sur un mandat signé hors de l'agence (D16). Leurs refus sont à part : `bad_date` n'y parle pas de signature. */
const STOPS = {
  retractation: {
    open: 'Noter une rétractation',
    day: 'Rétractation envoyée le (cachet de la poste, date du mail)',
    field: 'sentOn',
    go: 'Noter la rétractation',
    done: 'Rétractation notée : le mandat est arrêté.',
    again: 'Cette rétractation est déjà notée.',
  },
  'debut-anticipe': {
    open: 'Noter sa demande de commencer tout de suite',
    day: 'Demande écrite reçue le',
    field: 'receivedOn',
    go: 'Noter la demande',
    done: 'Demande notée : le bien peut être diffusé.',
    again: 'Cette demande est déjà notée.',
  },
};
const STOP_REFUSALS = {
  bad_proof: 'Dites en quelques mots la preuve écrite que vous avez reçue, 300 signes au plus.',
  bad_date: 'La date : un vrai jour, depuis la signature, jamais à venir.',
  invalid_date: 'La date : un vrai jour, depuis la signature, jamais à venir.',
  delay_over: 'Cet envoi est après le dernier jour du délai : rien n’est noté, voyez avec la direction.',
  no_withdrawal_period: 'Ce mandat, signé à l’agence, n’a pas de délai de rétractation.',
  withdrawn: 'Le mandant s’est déjà rétracté : rien de plus à noter.',
  unknown_mandate: 'Ce mandat n’est pas dans vos droits.',
};
const KINDS = { mandat_vente_simple: 'Mandat simple', mandat_vente_exclusif: 'Mandat exclusif', avenant_mandat: 'Avenant', mandat_location: 'Mandat de location' };
const PLACES: Record<SignaturePlace, string> = { agence: 'À l’agence', hors_agence: 'Hors de l’agence', distance: 'À distance' };
const SOURCES: Record<MandateSource, string> = {
  site: 'Le site',
  online_valuation: 'Une estimation en ligne',
  value_tracking: 'Le suivi de valeur',
  referral: 'Une recommandation',
  social: 'Les réseaux sociaux',
  portal: 'Un portail',
  agent_network: 'Le réseau de l’agent',
  neighbourhood_letter: 'Une lettre de quartier',
  other: 'Autre',
};
const FIELD_NAMES = Object.fromEntries(Object.entries(TEMPLATE_FIELDS).map(([k, v]) => [k, v.label]));

export const MANDAT_HTML = `<section id="mandat" hidden>
<button id="mandat-retour" type="button" class="retour">Retour</button>
<h2 id="mandat-titre">Mandat</h2>
<p id="mandat-etat" class="etat" role="status"></p>
<div id="mandat-corps"></div>
</section>
`;

export const MANDAT_JS = `
  /* ---------- M06 : l'écran « Mandat » (D12), chargé à la demande [R39, R40, R41, R201]. ---------- */
  var mandatScreen = null;
  function wipeMandat() {
    if (mandatScreen) { mandatScreen.wipe(); return; }
    clear($('mandat-corps'));
    $('mandat-etat').textContent = '';
  }
  function openMandat(id, reference) {
    if (!currentKey || !ID.test(id)) return Promise.resolve(false);
    if (mandatScreen) return mandatScreen.open(id, reference);
    session += 1;
    var mine = session;
    wipeMandat();
    show('mandat', [id, reference]);
    $('mandat-etat').textContent = 'Chargement…';
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.setAttribute('src', '/app/mandat.js');
      s.addEventListener('load', function () {
        var make = globalThis.AIMMO_MANDAT;
        try { delete globalThis.AIMMO_MANDAT; } catch (e) { /* rien */ }
        if (mine !== session || typeof make !== 'function') { resolve(false); return; }
        mandatScreen = make({ $: $, el: el, clear: clear, send: send, button: button, field: field, show: show, ID: ID, key: function () { return currentKey; }, session: function () { return session; }, bump: function () { session += 1; } });
        resolve(mandatScreen.open(id, reference));
      });
      s.addEventListener('error', function () {
        if (mine === session) $('mandat-etat').textContent = 'Pas de réseau. Réessayez dans un moment.';
        resolve(false);
      });
      $('mandat').appendChild(s);
    });
  }
`;

/** Le script de l'écran, servi à part (`/app/mandat.js`). Il ne garde rien une fois l'écran quitté. */
export const MANDAT_SCRIPT = `'use strict';
globalThis.AIMMO_MANDAT = function (t) {
  var $ = t.$, el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field, show = t.show, ID = t.ID;
  var NO = ${JSON.stringify(REFUSALS)}, CHECKS = ${JSON.stringify(CHECKS)}, DIFFUSION = ${JSON.stringify(DIFFUSION)}, KINDS = ${JSON.stringify(KINDS)}, FIELDS = ${JSON.stringify(FIELD_NAMES)};
  var STOPS = ${JSON.stringify(STOPS)}, STOP_NO = ${JSON.stringify(STOP_REFUSALS)};
  var LOST = 'Pas de réponse : la note est peut-être rangée. Réessayez, rien ne se notera deux fois.';
  var PLACE_KEYS = ${JSON.stringify(SIGNATURE_PLACES)}, PLACES = ${JSON.stringify(PLACES)}, SOURCE_KEYS = ${JSON.stringify(MANDATE_SOURCES)}, SOURCES = ${JSON.stringify(SOURCES)};
  var TYPES = ${JSON.stringify(FILE_DEPOSIT_TYPES)}, MAX = ${FILE_DEPOSIT_MAX_BYTES};
  var RESUME_REF = 'mandats/reprise';
  var cur = null, seq = 0, busy = null;
  function state(x) { $('mandat-etat').textContent = x; }
  function body() { return $('mandat-corps'); }
  function why(res, fallback) {
    if (res.offline) return 'Pas de réponse : rouvrez cet écran pour voir ce qui est rangé.';
    return (res.body && NO[res.body.code]) || (res.status === 403 || res.status === 404 ? 'Ce mandat n’est pas dans vos droits.' : fallback);
  }
  function date(iso) {
    var x = new Date(String(iso));
    if (isNaN(x.getTime())) return '';
    try { return x.toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'long', year: 'numeric' }); } catch (e) { return ''; }
  }
  function today() {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); } catch (e) { return ''; }
  }
  // Aujourd'hui vaut l'instant présent ; un jour passé, le milieu de ce jour. Un jour à venir est refusé par le code.
  function instant(day) { return day === today() ? new Date().toISOString() : day + 'T12:00:00.000Z'; }
  function wipe() { seq += 1; busy = null; clear(body()); state(''); $('mandat-titre').textContent = 'Mandat'; cur = null; }
  function open(id, reference) {
    if (!t.key() || !ID.test(id)) return Promise.resolve(false);
    t.bump();
    wipe();
    cur = { id: id, reference: reference || 'ce bien' };
    $('mandat-titre').textContent = 'Mandat · ' + cur.reference;
    show('mandat', [id, reference]);
    return load();
  }
  function base() { return '/v1/biens/' + encodeURIComponent(cur.id); }
  function doc(id) { return '/v1/documents/' + encodeURIComponent(id); }
  function load(message) {
    var mine = ++seq;
    state('Chargement…');
    return send(base() + '/mandat', 'GET').then(function (res) {
      if (res.gone || mine !== seq) return false;
      if (!res.ok) {
        clear(body());
        // Le geste a réussi, seule la relecture manque : on le dit, sans laisser un formulaire périmé.
        if (message) { state(message + ' Rouvrez cet écran pour le relire.'); return true; }
        state(res.offline ? 'Pas de réseau. Réessayez dans un moment.' : why(res, 'Indisponible pour le moment. Réessayez plus tard.'));
        return false;
      }
      clear(body());
      state(message || '');
      draw(res.body.data);
      return true;
    });
  }
  function act(run) {
    return function () {
      if (busy) return Promise.resolve(false);
      var me = busy = {};
      function done(r) { if (busy === me) busy = null; return r; }
      return Promise.resolve().then(run).then(done, function () { done(false); state('Rien n’est rangé : réessayez.'); return false; });
    };
  }
  function bloc(title) {
    var box = el('section', null, 'bloc');
    box.appendChild(el('h3', title));
    body().appendChild(box);
    return box;
  }
  function choice(box, id, label, keys, names, blank) {
    var f = field(box, id, label, 'select');
    if (blank) { var first = el('option', blank); first.value = ''; f.appendChild(first); }
    keys.forEach(function (k) { var o = el('option', names[k] || k); o.value = k; f.appendChild(o); });
    return f;
  }
  function draw(data) {
    var m = data.mandate;
    cur.owners = Array.isArray(data.owners) ? data.owners.filter(function (o) { return o && ID.test(o.personId); }) : [];
    var box = bloc('Mandat en cours');
    if (!m) box.appendChild(el('p', 'Aucun mandat signé pour ce bien.', 'doux'));
    else {
      box.appendChild(el('p', m.number ? 'Numéro au registre : ' + m.number : 'Pas encore de numéro au registre.'));
      if (m.signedAt) box.appendChild(el('p', 'Signé le ' + date(m.signedAt) + '.', 'doux'));
      box.appendChild(el('p', DIFFUSION[m.reason] || (m.allowed ? 'Le bien peut être diffusé.' : 'Le bien ne se diffuse pas.')));
      drawStops(box, m);
      drawTerms(box, m);
    }
    var docs = bloc('Documents du bien');
    var list = Array.isArray(data.documents) ? data.documents : [];
    if (!list.length) docs.appendChild(el('p', 'Aucun document pour ce bien.', 'doux'));
    // Un mandat vivant : ni second mandat à préparer, ni autre document à signer depuis cet écran.
    var free = !m || m.reason === 'cancelled' || m.reason === 'withdrawn' || m.reason === 'expired';
    // Un avenant se signe sur le mandat qu'il modifie, seulement si c'est le mandat en cours.
    var amendable = !free && m.reason !== 'no_mandate' && m.number && ID.test(m.id) ? m.id : null;
    list.forEach(function (d) { if (ID.test(d.id)) drawDocument(docs, d, free, amendable); });
    if (free) drawDesignation(data.designation || null, Array.isArray(data.owners) ? data.owners : []);
    if (free) drawGenerate(Array.isArray(data.owners) ? data.owners : []);
    else if (amendable) drawAmend(m, Array.isArray(data.owners) ? data.owners : []);
  }
  // Les conditions se lisent à part : sans elles, le mandat reste lisible et l'avenant possible.
  function drawTerms(box, m) {
    if (!ID.test(m.id) || m.reason === 'cancelled' || m.reason === 'withdrawn' || m.reason === 'no_mandate') return;
    var mine = seq, line = el('p', '', 'doux');
    box.appendChild(line);
    send('/v1/mandats/' + encodeURIComponent(m.id) + '/conditions', 'GET').then(function (res) {
      if (res.gone || mine !== seq || !res.ok || !res.body.data) return;
      var c = res.body.data, said = [];
      if (typeof c.priceEur === 'number') said.push('prix ' + c.priceEur.toLocaleString('fr-FR') + ' €');
      if (typeof c.durationMonths === 'number') said.push('durée ' + c.durationMonths + ' mois');
      if (said.length) line.textContent = 'En vigueur : ' + said.join(', ') + '.';
      // AU057b · un avenant signé qui prend effet plus tard se dit à part, avec son jour.
      (Array.isArray(c.pending) ? c.pending : []).forEach(function (a) {
        if (!a || typeof a.effectiveOn !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(a.effectiveOn)) return;
        var next = [];
        if (typeof a.priceEur === 'number') next.push('prix ' + a.priceEur.toLocaleString('fr-FR') + ' €');
        if (typeof a.durationMonths === 'number') next.push('durée ' + a.durationMonths + ' mois');
        if (typeof a.feeEur === 'number') next.push('honoraires ' + a.feeEur.toLocaleString('fr-FR') + ' €');
        if (a.feeCharge === 'vendeur' || a.feeCharge === 'acquereur') next.push('honoraires à la charge ' + (a.feeCharge === 'vendeur' ? 'du vendeur' : 'de l’acquéreur'));
        if (a.mandateType === 'exclusif' || a.mandateType === 'simple') next.push('mandat ' + a.mandateType);
        if (next.length) box.appendChild(el('p', 'À partir du ' + a.effectiveOn.slice(8, 10) + '/' + a.effectiveOn.slice(5, 7) + '/' + a.effectiveOn.slice(0, 4) + ' : ' + next.join(', ') + '.', 'doux'));
      });
    });
  }
  function drawAmend(m, owners) {
    var box = bloc('Préparer un avenant');
    var known = owners.filter(function (o) { return ID.test(o.personId); });
    if (!known.length) { box.appendChild(el('p', 'Aucun propriétaire n’est lié à ce bien : l’avenant ne se prépare pas.', 'doux')); return; }
    var names = {};
    known.forEach(function (o) { names[o.personId] = [o.firstName, o.lastName].filter(Boolean).join(' ') || 'Propriétaire sans nom'; });
    var who = choice(box, 'avenant-mandant', 'Mandant', known.map(function (o) { return o.personId; }), names, known.length > 1 ? 'À choisir' : '');
    if (known.length === 1) who.value = known[0].personId;
    var price = field(box, 'avenant-prix', 'Nouveau prix, en euros');
    price.setAttribute('inputmode', 'numeric');
    var months = field(box, 'avenant-duree', 'Nouvelle durée, en mois');
    months.setAttribute('inputmode', 'numeric');
    // AU057 · honoraires, leur charge, type du mandat et date d'effet : chacun facultatif, rien ne change s'il est vide.
    var fee = field(box, 'avenant-honoraires', 'Nouveaux honoraires, en euros');
    fee.setAttribute('inputmode', 'numeric');
    var charge = choice(box, 'avenant-charge', 'Honoraires à la charge', ['vendeur', 'acquereur'], { vendeur: 'du vendeur', acquereur: 'de l’acquéreur' }, 'Sans changement');
    var kind = choice(box, 'avenant-type', 'Type du mandat', ['simple', 'exclusif'], { simple: 'Mandat simple', exclusif: 'Mandat exclusif' }, 'Sans changement');
    var effect = field(box, 'avenant-effet', 'Prend effet le (vide : à la signature)');
    effect.setAttribute('type', 'date');
    box.appendChild(button('Préparer l’avenant', act(function () {
      var inputs = {}, p = price.value.trim(), d = months.value.trim(), h = fee.value.trim(), e = effect.value.trim();
      if (!who.value) { state('Choisissez le mandant.'); return false; }
      if (!p && !d && !h && !charge.value && !kind.value) { state('Dites ce qui change : le nouveau prix, la nouvelle durée, les honoraires, leur charge ou le type du mandat.'); return false; }
      if ((p && !/^[0-9]+$/.test(p)) || (d && !/^[0-9]+$/.test(d)) || (h && !/^[0-9]+$/.test(h))) { state('Le prix, la durée et les honoraires : des nombres entiers, sans espace.'); return false; }
      if (e && !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(e)) { state('La date d’effet : un jour du calendrier.'); return false; }
      if (p) inputs['avenant.prix'] = Number(p);
      if (d) inputs['avenant.duree_mois'] = Number(d);
      if (h) inputs['avenant.honoraires'] = Number(h);
      if (charge.value) inputs['avenant.honoraires_charge'] = charge.value;
      if (kind.value) inputs['avenant.type'] = kind.value;
      if (e) inputs['avenant.date_effet'] = e;
      var mine = ++seq;
      state('Préparation…');
      return send('/v1/documents', 'POST', { kind: 'avenant_mandat', personId: who.value, propertyId: cur.id, mandateId: m.id, inputs: inputs }).then(function (res) {
        if (res.gone || mine !== seq) return false;
        if (res.ok) return load('Avenant préparé : contrôlez-le avant signature.');
        state(res.body && res.body.code === 'bad_input' ? 'Un changement ne convient pas (même type de mandat, date d’effet passée ou à plus d’un an) : vérifiez la saisie.' : res.body && res.body.code === 'no_evidence' ? 'Le modèle d’avenant n’a pas de clause d’exclusivité mise en évidence : l’avenant ne peut pas rendre le mandat exclusif.' : why(res, 'L’avenant n’est pas préparé : réessayez.'));
        return false;
      });
    })));
  }
  // Signé hors de l'agence : le délai est dit, et ses deux gestes restent à portée. La rétractation reste proposée après
  // le délai, car une lettre postée à temps arrive plus tard ; le code refuse un envoi trop tardif [R42].
  function drawStops(box, m) {
    if (m.withdrawalUnfinished && ID.test(m.id)) {
      box.appendChild(el('p', 'La rétractation est notée, mais son numéro n’est pas encore annulé au registre.'));
      box.appendChild(button('Finir la rétractation', act(function () { return post(m, 'retractation', { resume: true }, 'Rétractation finie : le numéro est annulé au registre.', 'Cette rétractation est déjà finie.'); })));
      return;
    }
    var live = m.reason === 'withdrawal_period' || m.reason === 'allowed_early_start' || m.reason === 'allowed';
    if (!live || !m.withdrawalLastDay || !ID.test(m.id)) return;
    box.appendChild(el('p', 'Dernier jour du délai de rétractation : ' + date(m.withdrawalLastDay) + '.', 'doux'));
    var zone = el('div');
    if (m.reason === 'withdrawal_period') box.appendChild(button(STOPS['debut-anticipe'].open, function () { drawStop(zone, m, 'debut-anticipe'); }));
    box.appendChild(button(STOPS.retractation.open, function () { drawStop(zone, m, 'retractation'); }));
    box.appendChild(zone);
  }
  function drawStop(zone, m, kind) {
    var c = STOPS[kind];
    clear(zone);
    state('');
    var when = field(zone, 'mandat-arret-jour', c.day);
    when.setAttribute('type', 'date');
    when.value = today();
    var proof = field(zone, 'mandat-arret-preuve', 'La preuve écrite : sa nature et sa date, sans copier de pièce');
    proof.setAttribute('maxlength', '300');
    zone.appendChild(button(c.go, act(function () {
      if (!when.value) { state(STOP_NO.bad_date); return false; }
      if (!proof.value.trim()) { state(STOP_NO.bad_proof); return false; }
      if (kind !== 'retractation') return stop(m, kind, proof.value.trim(), when.value);
      // Une rétractation ne se défait pas : la conséquence est dite, sur ce que l'agent a saisi, avant le second appui.
      var day = when.value, said = proof.value.trim();
      clear(zone);
      zone.appendChild(el('p', 'Rétractation envoyée le ' + date(day) + ' : le mandat ' + (m.number || '') + ' s’arrête, son numéro est annulé au registre, où il reste, et la diffusion s’arrête au prochain passage des annonces. Cela ne se défait pas.'));
      zone.appendChild(button('Confirmer : noter la rétractation', act(function () { return stop(m, kind, said, day); })));
      zone.appendChild(button('Ne rien noter', function () { clear(zone); state(''); }));
      return true;
    })));
  }
  // Une réponse perdue n'est pas un refus : le geste a pu passer, et le refaire ne note rien deux fois.
  function stop(m, kind, proof, day) {
    var c = STOPS[kind], data = { proof: proof };
    data[c.field] = day;
    return post(m, kind, data, c.done, c.again);
  }
  function post(m, kind, data, done, again) {
    var mine = ++seq;
    state('Enregistrement…');
    return send('/v1/mandats/' + encodeURIComponent(m.id) + '/' + kind, 'POST', data).then(function (res) {
      if (res.gone || mine !== seq) return false;
      if (res.ok) return load(done);
      var code = res.body && res.body.code;
      if (code === 'already_recorded') return load(again);
      // Registre abîmé : la rétractation est peut-être notée sans son annulation ; la relecture le dit, et offre de la finir.
      if (code === 'register_broken') return load(NO.register_broken);
      if (res.offline || !res.body || res.status >= 500) { state(LOST); return false; }
      state(STOP_NO[code] || NO[code] || why(res, 'Rien n’est noté : réessayez.'));
      return false;
    });
  }
  function drawDocument(box, d, free, amendable) {
    var card = el('article');
    box.appendChild(card);
    card.appendChild(el('strong', (KINDS[d.kind] || 'Document') + ', préparé le ' + date(d.createdAt)));
    if (d.mode === 'essai') card.appendChild(el('p', 'Document d’essai : il ne se signe pas.'));
    if (d.status === 'incomplet') card.appendChild(el('p', 'Il manque : ' + (Array.isArray(d.missing) ? d.missing : []).map(function (k) { return FIELDS[k] || 'un champ'; }).join(', ') + '.'));
    var s = d.signature;
    var zone = el('div');
    if (s && s.complete) card.appendChild(el('p', 'Signé le ' + date(s.signedAt) + ', ' + (PLACES[s.place] || '').toLowerCase() + (s.number ? ', n° ' + s.number : '') + '.'));
    if (s && !s.complete) card.appendChild(el('p', 'Enregistrement arrêté en route : ce mandat n’est pas encore signé.'));
    card.appendChild(button('Lire le document', function () { return read(zone, doc(d.id), 'Le document ne se lit pas : réessayez.'); }));
    var isMandate = d.kind === 'mandat_vente_simple' || d.kind === 'mandat_vente_exclusif' || d.kind === 'mandat_location';
    if (s && s.complete) card.appendChild(button('Voir l’exemplaire', function () { return read(zone, doc(d.id) + '/exemplaire', 'L’exemplaire ne se lit pas : réessayez.'); }));
    else if (s && isMandate) card.appendChild(button('Reprendre l’enregistrement', function () { clear(zone); drawResume(zone, d, s); }));
    else if (isMandate && free) card.appendChild(button('Contrôler avant signature', act(function () { return control(zone, d); })));
    else if (isMandate) card.appendChild(el('p', 'Un mandat est déjà en cours sur ce bien : ce document ne se signe pas.', 'doux'));
    else if (d.kind === 'avenant_mandat' && amendable && d.mandateId === amendable) card.appendChild(button('Contrôler avant signature', act(function () { return control(zone, d); })));
    else if (d.kind === 'avenant_mandat') card.appendChild(el('p', 'Le mandat de cet avenant n’est plus en cours : il ne se signe pas.', 'doux'));
    card.appendChild(zone);
  }
  // Le document est du HTML rendu par le code : on n'en garde que le texte, posé par textContent.
  function paragraphs(html) {
    var text = String(html).replace(/^[\\s\\S]*<body[^>]*>/i, '').replace(/<\\/(p|div|h[1-6]|li|tr)>|<br\\s*\\/?>/gi, '\\n').replace(/<[^>]*>/g, '');
    var ent = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&amp;': '&' };
    return text.split('\\n').map(function (l) { return l.replace(/&(lt|gt|quot|#39|amp);/g, function (e) { return ent[e]; }).trim(); }).filter(Boolean);
  }
  function read(zone, path, failed) {
    var mine = ++seq;
    return send(path, 'GET').then(function (res) {
      if (res.gone || mine !== seq) return false;
      clear(zone);
      if (!res.ok || !res.body.data || typeof res.body.data.content !== 'string') { state(why(res, failed)); return false; }
      state('');
      paragraphs(res.body.data.content).forEach(function (l) { zone.appendChild(el('p', l)); });
      return true;
    });
  }
  function drawCheck(zone, check) {
    var ul = el('ul');
    (Array.isArray(check.lines) ? check.lines : []).forEach(function (l) {
      ul.appendChild(el('li', (l.ok ? 'Bon : ' : 'À régler : ') + (CHECKS[l.code] || (l.ok ? 'contrôle passé.' : 'ce contrôle n’est pas passé.'))));
    });
    zone.appendChild(ul);
  }
  function control(zone, d) {
    var mine = ++seq;
    state('Contrôle en cours…');
    return send(doc(d.id) + '/controle', 'POST', {}).then(function (res) {
      if (res.gone || mine !== seq) return false;
      clear(zone);
      if (!res.ok || !res.body.data) { state(why(res, 'Le contrôle n’a pas abouti : réessayez.')); return false; }
      var check = res.body.data;
      drawCheck(zone, check);
      // Un seul échec, et il n'y a rien à signer [R41].
      if (check.passed !== true) { state('Un point au moins n’est pas réglé : rien ne se signe.'); return true; }
      state('Contrôle réussi : vous pouvez enregistrer la signature.');
      drawSign(zone, d);
      if (d.kind !== 'avenant_mandat') online(zone, d);
      return true;
    });
  }
  // La signature en ligne : réelle seulement quand le mail réel et la validation de l'avocat sont là ; sinon d'essai,
  // dite telle, sans valeur juridique (AU003). Le mode vient du serveur, jamais de l'écran.
  function online(zone, d) {
    var line = el('p', '');
    zone.appendChild(line);
    return send('/v1/signature-en-ligne/mode', 'GET').then(function (res) {
      var m = res.ok && res.body && res.body.data;
      if (!m) return;
      line.textContent = m.mode === 'reel'
        ? 'Signature en ligne : réelle, avec dossier de preuve remis à chaque mandant.'
        : 'Signature en ligne : essai seulement, sans valeur juridique' + (m.missing && m.missing.indexOf('validation_avocat') >= 0 ? ' (validation de l’avocat attendue).' : ' (mail réel pas encore branché).');
      if (d) drawOnline(zone, d);
    });
  }
  // X17 · le geste de la signature en ligne : l'accord du mandant, le code, la signature. Le serveur décide du mode ;
  // en essai seulement, il rend le code, posé à l'écran pour essayer le parcours, sans valeur juridique.
  function drawOnline(zone, d) {
    var box = el('div');
    zone.appendChild(box);
    var owners = cur.owners || [], names = {};
    owners.forEach(function (o) { names[o.personId] = [o.firstName, o.lastName].filter(Boolean).join(' ') || 'Propriétaire sans nom'; });
    var who = owners.length > 1 ? choice(box, 'mandat-signataire-' + d.id, 'Mandant qui signe en ligne', owners.map(function (o) { return o.personId; }), names, 'Le premier mandant') : null;
    var proof = field(box, 'mandat-accord-' + d.id, 'Comment le mandant a accepté de recevoir son code par mail');
    var session = null;
    var codeZone = el('div');
    box.appendChild(button('Envoyer le code de signature', act(function () {
      var text = proof.value.trim();
      if (!text) { state('Notez comment le mandant a accepté de signer en ligne.'); return false; }
      var mine = ++seq;
      state('Envoi du code…');
      return send(doc(d.id) + '/signature-en-ligne', 'POST', who && who.value ? { consentProof: text, signerId: who.value } : { consentProof: text }).then(function (res) {
        if (res.gone || mine !== seq) return false;
        if (!res.ok || !res.body.data) {
          if (res.offline || res.status >= 500) { state('Pas de réponse : le code est peut-être parti. Attendez dix minutes avant de le renvoyer.'); return false; }
          state(why(res, 'Le code n’est pas envoyé.'));
          return false;
        }
        session = res.body.data;
        clear(codeZone);
        if (session.mode === 'essai' && typeof session.trialCode === 'string') {
          state('Code préparé pour le mandant (essai, rien n’est parti).');
          codeZone.appendChild(el('p', 'Code d’essai : ' + session.trialCode + '. En réel, seul le mandant le reçoit, par mail.', 'alerte'));
        } else state('Code envoyé au mandant par mail : il vaut dix minutes.');
        var code = field(codeZone, 'mandat-code-' + d.id, 'Code reçu par le mandant');
        codeZone.appendChild(button('Signer en ligne', act(function () { return signOnline(code.value.trim()); })));
        return true;
      });
    })));
    box.appendChild(codeZone);
    function signOnline(code) {
      if (!session || !ID.test(session.sessionId)) return false;
      if (!/^[0-9]{6}$/.test(code)) { state('Le code a six chiffres.'); return false; }
      var mine = ++seq;
      state('Signature…');
      return send('/v1/signatures/' + encodeURIComponent(session.sessionId), 'POST', { code: code }).then(function (res) {
        if (res.gone || mine !== seq) return false;
        if (!res.ok || !res.body.data) {
          if (res.offline || res.status >= 500) { state('Pas de réponse : la signature est peut-être rangée. Rouvrez cet écran.'); return false; }
          state(why(res, 'La signature n’est pas rangée.'));
          return false;
        }
        var r = res.body.data;
        if (r.realSignature !== true) { state('Signé en essai, sans valeur juridique : aucun mandat n’est inscrit.'); return true; }
        if (r.allSigned !== true) { state('Signature rangée : les autres mandants doivent encore signer.'); return true; }
        return load(r.finished && r.finished.ok ? 'Mandat signé en ligne : il est inscrit au registre.' : 'Signé par tous : finissez l’enregistrement du mandat.');
      });
    }
  }
  function drawSource(zone, d) {
    var source = choice(zone, 'mandat-source-' + d.id, 'D’où vient ce mandat', SOURCE_KEYS, SOURCES, 'Celle de la fiche');
    var detail = field(zone, 'mandat-precision-' + d.id, 'Précision, si « Autre »');
    return function () { return { source: source.value || undefined, sourceDetail: detail.value.trim() || undefined }; };
  }
  function drawSign(zone, d) {
    var when = field(zone, 'mandat-jour-' + d.id, 'Signé le');
    when.setAttribute('type', 'date');
    var place = choice(zone, 'mandat-lieu-' + d.id, 'Lieu de signature', PLACE_KEYS, PLACES, 'À choisir');
    var amending = d.kind === 'avenant_mandat';
    var origin = amending ? function () { return {}; } : drawSource(zone, d);
    var pick = field(zone, 'mandat-scan-' + d.id, amending ? 'L’avenant signé, numérisé' : 'Le mandat signé, numérisé');
    pick.setAttribute('type', 'file');
    pick.setAttribute('accept', Object.keys(TYPES).join(','));
    var kept = null;
    zone.appendChild(button('Enregistrer la signature', act(function () {
      if (!when.value) { state('Dites le jour de la signature.'); return false; }
      if (!place.value) { state('Choisissez le lieu de signature.'); return false; }
      var file = pick.files && pick.files[0];
      if (!file) { state(amending ? 'Joignez l’avenant signé, numérisé.' : 'Joignez le mandat signé, numérisé.'); return false; }
      return (kept && kept.file === file ? Promise.resolve(kept.ref) : deposit(file)).then(function (ref) {
        if (!ref) return false;
        kept = { file: file, ref: ref };
        var o = origin();
        return sign(zone, d, { signedAt: instant(when.value), place: place.value, scanRef: ref, source: o.source, sourceDetail: o.sourceDetail }, function () { kept = null; });
      });
    })));
  }
  // Une reprise garde la date, le lieu et le scan de la première demande : rien à redéposer.
  function drawResume(zone, d, s) {
    zone.appendChild(el('p', 'La date, le lieu et le scan restent ceux de la première demande.', 'doux'));
    var origin = drawSource(zone, d);
    zone.appendChild(button('Finir l’enregistrement', act(function () {
      var o = origin();
      return sign(zone, d, { signedAt: s.signedAt, place: s.place, scanRef: RESUME_REF, source: o.source, sourceDetail: o.sourceDetail });
    })));
  }
  function sign(zone, d, data, forget) {
    var mine = ++seq;
    state('Enregistrement…');
    var amending = d.kind === 'avenant_mandat';
    return send(doc(d.id) + (amending ? '/signature-avenant' : '/signature-papier'), 'POST', data).then(function (res) {
      if (res.gone || mine !== seq) return false;
      if (res.ok) return load(amending ? 'Avenant signé : ses conditions sont en vigueur.' : 'Mandat signé : n° ' + res.body.data.number + ' au registre.');
      var code = res.body && res.body.code;
      if (amending && code === 'already_signed') return load('Cet avenant est déjà signé.');
      if (res.offline || !res.body || res.status >= 500) { state('Pas de réponse : la signature est peut-être rangée. Réessayez, rien ne s’enregistre deux fois.'); return false; }
      if (forget && (code === 'bad_scan' || code === 'scan_absent' || code === 'scan_deja_utilise')) forget();
      // Le contrôle a changé depuis : la ligne est dite, et le formulaire s'en va [R41].
      if (code === 'checks_failed' && res.body.check) {
        clear(zone);
        drawCheck(zone, res.body.check);
        state('Un point au moins n’est plus réglé : rien ne se signe.');
        return false;
      }
      state(why(res, 'La signature n’est pas enregistrée : réessayez.'));
      return false;
    });
  }
  function hex(buf) { return Array.from(new Uint8Array(buf), function (b) { return (b + 256).toString(16).slice(1); }).join(''); }
  function deposit(file) {
    var type = String(file.type || '').toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(TYPES, type)) { state(NO.type_refuse); return Promise.resolve(null); }
    if (file.size > MAX) { state(NO.trop_lourd); return Promise.resolve(null); }
    var mine = t.session(), key = t.key();
    if (!key) return Promise.resolve(null);
    state('Envoi du scan…');
    return file.arrayBuffer().then(function (buf) { return crypto.subtle.digest('SHA-256', buf); }).then(function (sum) {
      if (mine !== t.session()) return null;
      return fetch(base() + '/scans-mandat', { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': type, 'x-aimmo-sha256': hex(sum) }, body: file, cache: 'no-store', credentials: 'omit' }).then(function (r) {
        return r.json().then(function (b) { return b; }, function () { return null; }).then(function (b) {
          if (mine !== t.session()) return null;
          // Une clé refusée passe par send, qui sait la retirer et le dire.
          if (r.status === 401 || (r.status === 403 && b && b.code === 'agent_inactive')) return send(base() + '/mandat', 'GET').then(function () { return null; });
          var ref = r.ok && b && b.ok === true && b.data && b.data.ref;
          if (typeof ref !== 'string') { state(why({ status: r.status, body: b }, 'Le scan n’est pas rangé : réessayez.')); return null; }
          return ref;
        });
      }, function () { if (mine === t.session()) state('Pas de réseau : rien n’est rangé.'); return null; });
    }, function () { if (mine === t.session()) state('Ce fichier ne se lit pas sur ce téléphone.'); return null; });
  }
  /* AU002 : l'adresse du bien, ses parcelles et le domicile de chaque mandant, que chaque mandat de vente reprend. */
  function where(a) { return a && a.street ? a.street + ', ' + a.postalCode + ' ' + a.city + (a.country ? ', ' + a.country : '') : null; }
  function addressFields(box, id, a, abroad) {
    var street = field(box, id + '-voie', 'Numéro et voie');
    var cp = field(box, id + '-cp', 'Code postal');
    var city = field(box, id + '-commune', 'Commune');
    var country = abroad ? field(box, id + '-pays', 'Pays, s’il n’est pas en France') : null;
    if (a) { street.value = a.street || ''; cp.value = a.postalCode || ''; city.value = a.city || ''; if (country) country.value = a.country || ''; }
    return function () {
      var out = { street: street.value.trim(), postalCode: cp.value.trim(), city: city.value.trim() };
      if (country && country.value.trim()) out.country = country.value.trim();
      return out;
    };
  }
  function drawDesignation(d, owners) {
    var box = bloc('Désignation pour le mandat');
    box.appendChild(el('p', 'Le mandat reprend ces champs tels quels ; s’il en manque un, il reste incomplet et ne se signe pas.', 'doux'));
    box.appendChild(el('p', where(d && d.address) ? 'Adresse du bien : ' + where(d.address) : 'Adresse du bien : à saisir.'));
    var read = addressFields(box, 'bien-adresse', d && d.address);
    var parcels = field(box, 'bien-parcelles', 'Parcelles (section et numéro, par exemple AB 123, 012 C 45)');
    if (d && Array.isArray(d.parcels)) parcels.value = d.parcels.map(function (p) { return (p.prefix ? p.prefix + ' ' : '') + p.section + ' ' + p.number; }).join(', ');
    box.appendChild(button('Enregistrer la désignation', act(function () {
      var list = [], bad = false;
      parcels.value.split(/[,;]/).forEach(function (part) {
        var x = part.trim();
        if (!x) return;
        var m = /^(?:(\\d{3})\\s+)?([0-9A-Za-z]{1,2})\\s*(?:n°\\s*)?(\\d{1,4})$/.exec(x);
        if (!m) { bad = true; return; }
        list.push(m[1] ? { prefix: m[1], section: m[2], number: m[3] } : { section: m[2], number: m[3] });
      });
      if (bad || !list.length) { state('Les parcelles : une section et un numéro, par exemple AB 123.'); return false; }
      var mine = ++seq;
      return send('/v1/biens/' + cur.id + '/designation', 'POST', { address: read(), parcels: list }).then(function (res) {
        if (res.gone || mine !== seq) return false;
        // AU073 · le bien est situé depuis sa nouvelle adresse, pour les secteurs des acquéreurs ; un échec est dit.
        if (res.ok) return send('/v1/biens/' + cur.id + '/position', 'POST', {}).then(function (pos) {
          if (pos.gone || mine !== seq) return false;
          return load('Désignation enregistrée : le prochain mandat la reprend.' + (pos.ok ? '' : ' Bien non situé : il n’entre dans aucun secteur d’acquéreur. Réenregistrez plus tard.'));
        });
        state(why(res, 'La désignation n’est pas enregistrée : vérifiez l’adresse et les parcelles.'));
        return false;
      });
    })));
    owners.filter(function (o) { return ID.test(o.personId); }).forEach(function (o) {
      var name = [o.firstName, o.lastName].filter(Boolean).join(' ') || 'Propriétaire sans nom';
      var sub = el('div');
      box.appendChild(sub);
      sub.appendChild(el('p', where(o.domicile) ? 'Domicile de ' + name + ' : ' + where(o.domicile) : 'Domicile de ' + name + ' : à saisir.'));
      var get = addressFields(sub, 'domicile-' + o.personId, o.domicile, true);
      sub.appendChild(button('Enregistrer le domicile de ' + name, act(function () {
        var mine = ++seq;
        return send('/v1/fiches/' + o.personId + '/domicile', 'POST', get()).then(function (res) {
          if (res.gone || mine !== seq) return false;
          if (res.ok) return load('Domicile enregistré : le prochain mandat le reprend.');
          state(why(res, 'Le domicile n’est pas enregistré : vérifiez l’adresse.'));
          return false;
        });
      })));
    });
  }
  function drawGenerate(owners) {
    var box = bloc('Préparer un mandat');
    var known = owners.filter(function (o) { return ID.test(o.personId); });
    if (!known.length) { box.appendChild(el('p', 'Aucun propriétaire n’est lié à ce bien sur une fiche que vous voyez : liez d’abord la fiche du propriétaire.', 'doux')); return; }
    var names = {};
    known.forEach(function (o) { names[o.personId] = [o.firstName, o.lastName].filter(Boolean).join(' ') || 'Propriétaire sans nom'; });
    var who = choice(box, 'mandat-mandant', 'Mandant', known.map(function (o) { return o.personId; }), names, known.length > 1 ? 'À choisir' : null);
    if (known.length === 1) who.value = known[0].personId;
    var kind = choice(box, 'mandat-type', 'Type de mandat', ['mandat_vente_simple', 'mandat_vente_exclusif', 'mandat_location'], KINDS, 'À choisir');
    var fee = field(box, 'mandat-honoraires', 'Honoraires, en euros');
    fee.setAttribute('inputmode', 'numeric');
    var charge = choice(box, 'mandat-charge', 'À la charge de', ['vendeur', 'acquereur'], { vendeur: 'Le vendeur', acquereur: 'L’acquéreur' }, 'À choisir');
    var months = field(box, 'mandat-duree', 'Durée, en mois');
    months.setAttribute('inputmode', 'numeric');
    box.appendChild(button('Préparer le mandat', act(function () {
      if (!who.value) { state('Choisissez le mandant.'); return false; }
      if (!kind.value) { state('Choisissez le type de mandat.'); return false; }
      if (!/^\\d{1,9}$/.test(fee.value.trim())) { state('Les honoraires : un montant en euros, sans centimes.'); return false; }
      // AU014 : un mandat de location dit les honoraires du bailleur ; ceux du locataire suivent le barème plafonné.
      var renting = kind.value === 'mandat_location';
      if (!renting && !charge.value) { state('Dites qui paie les honoraires.'); return false; }
      if (!/^\\d{1,3}$/.test(months.value.trim())) { state('La durée : un nombre de mois.'); return false; }
      var mine = ++seq;
      return send('/v1/documents', 'POST', { kind: kind.value, personId: who.value, propertyId: cur.id, inputs: renting ? { 'honoraires.montant': Number(fee.value.trim()), 'mandat.duree_mois': Number(months.value.trim()) } : { 'honoraires.montant': Number(fee.value.trim()), 'honoraires.charge': charge.value, 'mandat.duree_mois': Number(months.value.trim()) } }).then(function (res) {
        if (res.gone || mine !== seq) return false;
        if (res.ok) return load('Mandat préparé : contrôlez-le avant de le signer.');
        state(why(res, 'Le mandat n’est pas préparé : réessayez.'));
        return false;
      });
    })));
    drawQuestionnaire(who);
  }
  /* BR116 : le mandat par questionnaire, script servi à part, chargé au geste [R201, R440, R441]. */
  var questionnaire = null;
  function drawQuestionnaire(who) {
    var box = bloc('Préparer par questionnaire');
    box.appendChild(el('p', 'Six questions au vendeur : chaque clause dit la réponse qui l’a fait entrer et la loi qui la fonde, et le prix est comparé à l’avis de valeur avant la signature.', 'doux'));
    var inner = el('div');
    // Vivant tant que l'écran montre le même bien : quitter ou rouvrir l'écran remplace cur.
    var mine = cur;
    var ctx = { personId: function () { return who.value; }, propertyId: mine.id, alive: function () { return cur === mine; } };
    var b = button('Ouvrir le questionnaire', function () {
      if (b.disabled || !ctx.alive()) return;
      if (questionnaire) { questionnaire.show(inner, ctx); return; }
      b.disabled = true;
      var s = el('script');
      s.setAttribute('src', '/app/mandat-questionnaire.js');
      s.addEventListener('load', function () {
        var make = globalThis.AIMMO_MANDAT_QUESTIONNAIRE;
        try { delete globalThis.AIMMO_MANDAT_QUESTIONNAIRE; } catch (e) { /* rien */ }
        b.disabled = false;
        if (!ctx.alive()) return;
        if (typeof make !== 'function') { state('Indisponible pour le moment. Réessayez dans un moment.'); return; }
        questionnaire = make({ el: el, clear: clear, send: send, button: button, field: field, ID: ID });
        questionnaire.show(inner, ctx);
      });
      s.addEventListener('error', function () { b.disabled = false; if (ctx.alive()) state('Pas de réseau. Réessayez dans un moment.'); });
      box.appendChild(s);
    });
    box.appendChild(b);
    box.appendChild(inner);
  }
  return { open: open, wipe: wipe };
};
`;
