/**
 * L'écran « Dossier de vente » de l'application de l'agent (N12), en morceaux posés dans `fichiers.ts` : sa section, son
 * chargeur et son script, servi à part (`/app/dossier.js`) et chargé à la première ouverture pour tenir le budget [R201].
 * Il s'ouvre depuis une offre dont le dossier est ouvert, sur l'écran « Offres ».
 *
 * L'écran ne lit et n'écrit que par les routes `/v1/dossiers` [R16]. Il ne calcule rien : le chemin, les pièces attendues
 * et les échéances viennent du code [R60, R61] ; une date manquante se dit, jamais inventée [R10]. Une pièce d'identité
 * ne se range jamais ici [R15]. Tout texte reçu est posé avec `textContent`.
 *
 * N13 : l'agent y fait avancer le dossier. Chaque date part avec sa preuve déposée, sans référence à saisir [R10, R61] ;
 * les étapes du prêt sont une liste fermée, sans montant ni taux [R14] ; l'acte signé se confirme à part, car il clôt.
 */
import { FILE_DEPOSIT_MAX_BYTES, FILE_DEPOSIT_TYPES } from '../../core/src/dossiers/depot.ts';
import { DATE_KINDS, type DateKind } from '../../core/src/dossiers/echeancier.ts';
import { DECLARED_BY, FINANCING_STEPS, type DeclaredBy, type FinancingStep } from '../../core/src/dossiers/financement.ts';

const REFUSALS = {
  business: 'Un fonds de commerce se suit dans « Commerces ».',
  forbidden_piece: 'Cette pièce va au coffre de la conformité, jamais au dossier.',
  unknown_piece: 'Choisissez une pièce de la liste.',
  not_expected: 'Cette pièce n’est pas attendue pour ce bien.',
  closed: 'L’acte est signé : le dossier ne reçoit plus de pièce.',
  bad_date: 'La date du document : un vrai jour, jamais à venir.',
  bad_ref: 'Le fichier n’est pas rangé : choisissez-le de nouveau.',
  not_stored: 'Le fichier n’est pas rangé : choisissez-le de nouveau.',
  ref_used: 'Ce fichier est déjà rangé : choisissez-le de nouveau.',
  busy: 'Le dossier est occupé : réessayez dans un moment.',
  depot_ferme: 'Le dépôt des fichiers n’est pas encore branché.',
  pieces_not_configured: 'Les dossiers ne sont pas encore branchés : aucun stockage des pièces.',
  type_refuse: 'Ce fichier n’est pas admis : PDF, JPEG ou PNG.',
  trop_lourd: 'Ce fichier dépasse 20 Mo.',
  fichier_vide: 'Ce fichier est vide.',
  empreinte_differente: 'Le fichier a mal voyagé : réessayez.',
  stockage_indisponible: 'Le stockage ne répond pas : réessayez plus tard.',
  unknown_date: 'Choisissez la date dans la liste.',
  bad_day: 'Ce jour n’existe pas.',
  bad_proof: 'La preuve n’est pas rangée : choisissez de nouveau le fichier.',
  future_day: 'Ce jour est à venir : seul ce qui a déjà eu lieu se saisit ici.',
  before_compromis: 'Une date ne peut pas précéder le compromis signé.',
  compromis_first: 'Saisissez d’abord la signature du compromis.',
  out_of_order: 'Pour la commune : la suspension suit la réception, la reprise suit la suspension.',
  compromis_not_started: 'Préparez d’abord le compromis depuis l’offre : l’identité de l’acquéreur doit être vérifiée.',
  unknown_step: 'Choisissez l’étape dans la liste.',
  bad_input: 'Dites l’étape, le jour et qui la déclare.',
  no_loan_condition: 'L’offre n’a pas de condition de prêt : rien à suivre.',
  bad_request: 'Dites le nom de la banque ou du courtier, sans numéro de compte ni de dossier.',
  compromis_missing: 'Saisissez d’abord la signature du compromis.',
  already_closed: 'L’acte est déjà rangé.',
  file_stopped: 'Ce dossier est arrêté : il ne reçoit plus rien.',
  not_under_offer: 'Le bien n’est plus sous offre : voyez avec la direction.',
  no_mandate_in_force: 'Aucun mandat en vigueur le jour du compromis : voyez avec la direction.',
  fee_unknown: 'Les honoraires du mandat signé ne se lisent pas : voyez avec la direction.',
};
const PIECE_NAMES = {
  titre_propriete: 'Titre de propriété', fiche_renseignements_vendeur: 'Fiche de renseignements du vendeur', etat_risques: 'État des risques', dpe: 'Diagnostic énergétique',
  amiante: 'Diagnostic amiante', plomb: 'Constat plomb', electricite: 'Diagnostic électricité', gaz: 'Diagnostic gaz', bornage: 'Bornage',
  reglement_copropriete: 'Règlement de copropriété', pv_assemblees: 'Procès-verbaux des assemblées', fiche_synthetique: 'Fiche synthétique', pre_etat_date: 'Pré-état daté',
  carnet_entretien: 'Carnet d’entretien', mesurage_carrez: 'Mesurage Carrez', notice_information: 'Notice d’information', pppt_dtg: 'Plan de travaux ou diagnostic technique',
  dta_parties_communes: 'Amiante des parties communes', fiche_renseignements_acquereur: 'Fiche de renseignements de l’acquéreur',
  audit_energetique: 'Audit énergétique',
  etat_termites: 'État termites', information_merule: 'Information mérule', controle_assainissement: 'Contrôle de l’assainissement non collectif',
};
const DATE_NAMES: Record<DateKind, string> = {
  compromis_signe: 'Compromis signé', notification_acquereur: 'Notification reçue par l’acquéreur', date_limite_pret: 'Date limite du prêt', dia_recue: 'Déclaration reçue par la commune',
  dia_suspension: 'Demande de la commune, délai suspendu', dia_reprise: 'Reprise du délai de la commune', etat_date_attendu: 'État daté attendu', acte_prevu: 'Acte prévu',
};
const STEP_NAMES: Record<FinancingStep, string> = { demande_deposee: 'Demande de prêt déposée', accord_principe: 'Accord de principe', offre_pret_emise: 'Offre de prêt reçue par l’acquéreur', offre_pret_acceptee: 'Offre de prêt acceptée', refus: 'Refus de prêt' };
const BY_NAMES: Record<DeclaredBy, string> = { acquereur: 'l’acquéreur', courtier: 'le courtier' };
const STOPS = { retractation_acquereur: 'Rétractation de l’acquéreur', pret_refuse: 'Prêt refusé', preemption: 'Préemption de la commune', accord_des_parties: 'Accord des parties', autre: 'Autre raison' };
export const DEADLINES = { fin_retractation: 'Fin du délai de rétractation', reponse_preemption: 'Réponse de la commune', date_limite_pret: 'Date limite du prêt', etat_date: 'État daté', acte: 'Acte' };
const ITEMS = { pret: 'le prêt', fiche_bien: 'la fiche du bien', copropriete: 'la copropriété', classe_energie: 'la classe énergie du DPE récent', commune: 'la commune du bien', zone_termites: 'la zone termites de la commune', zone_merule: 'la zone mérule de la commune', assainissement: 'le raccordement aux eaux usées' };
const WHO = { acquereur: 'à l’acquéreur', vendeur: 'au vendeur', commune: 'à la commune', banque: 'à la banque', syndic: 'au syndic', agent: 'à vous' };
const REASONS = {
  fin_retractation: 'Délai de rétractation en cours', reponse_commune: 'Réponse de la commune attendue', delai_commune_suspendu: 'Délai de la commune suspendu',
  etat_date_attendu: 'État daté attendu', reflexion_offre_pret: 'Délai de réflexion sur l’offre de prêt', offre_pret_attendue: 'Offre de prêt attendue',
  acceptation_offre_attendue: 'Acceptation de l’offre de prêt attendue', refus_de_pret: 'Refus de prêt déclaré', piece_manquante: 'Pièce manquante', piece_perimee: 'Pièce périmée',
  identite_a_verifier: 'Identité de l’acquéreur à vérifier', donnee_du_bien_inconnue: 'Donnée du bien à compléter', date_a_saisir: 'Date à saisir',
};
const SCHEDULE = { a_saisir: 'date à saisir', sans_objet: 'sans objet', suspendue: 'suspendue' };
/** Les délais qui s'éteignent d'eux-mêmes : une fois leur jour passé, ils ne tiennent plus le dossier. */
const LAPSING = ['fin_retractation', 'reponse_commune', 'reflexion_offre_pret'];
const IDENTITY = { verifiee: 'Identité de l’acquéreur vérifiée.', non_verifiee: 'Identité de l’acquéreur à vérifier.', non_visible: 'L’identité de l’acquéreur n’est pas dans vos droits.' };

export const DOSSIER_HTML = `<section id="dossier" hidden>
<button id="dossier-retour" type="button" class="retour">Retour à ma journée</button>
<h2 id="dossier-titre">Dossier de vente</h2>
<p id="dossier-etat" class="etat" role="status"></p>
<div id="dossier-corps"></div>
</section>
`;

/** Le chargeur posé dans le script de l'application : l'écran est servi à part, chargé une fois, jamais gardé. */
export const DOSSIER_JS = `
  /* ---------- M10 : l'écran « Dossier de vente » (N12), chargé à la demande [R15, R16, R201]. ---------- */
  var dossierScreen = null;
  function wipeDossier() {
    if (dossierScreen) { dossierScreen.wipe(); return; }
    clear($('dossier-corps'));
    $('dossier-etat').textContent = '';
  }
  function openDossier(id, reference) {
    if (!currentKey || !ID.test(id)) return Promise.resolve(false);
    if (dossierScreen) return dossierScreen.open(id, reference);
    session += 1;
    var mine = session;
    wipeDossier();
    show('dossier', [id, reference]);
    $('dossier-etat').textContent = 'Chargement…';
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.setAttribute('src', '/app/dossier.js');
      s.addEventListener('load', function () {
        var make = globalThis.AIMMO_DOSSIER;
        try { delete globalThis.AIMMO_DOSSIER; } catch (e) { /* rien */ }
        if (mine !== session || typeof make !== 'function') { resolve(false); return; }
        dossierScreen = make({ $: $, el: el, clear: clear, send: send, button: button, field: field, show: show, ID: ID, key: function () { return currentKey; }, session: function () { return session; }, bump: function () { session += 1; } });
        resolve(dossierScreen.open(id, reference));
      });
      s.addEventListener('error', function () {
        if (mine === session) $('dossier-etat').textContent = 'Pas de réseau. Réessayez dans un moment.';
        resolve(false);
      });
      $('dossier').appendChild(s);
    });
  }
`;

/** Le script de l'écran, servi à part (`/app/dossier.js`). Il ne garde rien une fois l'écran quitté. */
export const DOSSIER_SCRIPT = `'use strict';
globalThis.AIMMO_DOSSIER = function (t) {
  var $ = t.$, el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field, show = t.show, ID = t.ID;
  var STOPS = ${JSON.stringify(STOPS)}, NO = ${JSON.stringify(REFUSALS)}, PIECES = ${JSON.stringify(PIECE_NAMES)}, DEADLINES = ${JSON.stringify(DEADLINES)}, ITEMS = ${JSON.stringify(ITEMS)};
  var WHO = ${JSON.stringify(WHO)}, REASONS = ${JSON.stringify(REASONS)}, SCHEDULE = ${JSON.stringify(SCHEDULE)}, IDENTITY = ${JSON.stringify(IDENTITY)}, LAPSING = ${JSON.stringify(LAPSING)};
  var KINDS = ${JSON.stringify(DATE_KINDS)}, DATES = ${JSON.stringify(DATE_NAMES)}, STEPS = ${JSON.stringify(FINANCING_STEPS)}, STEP = ${JSON.stringify(STEP_NAMES)}, BYS = ${JSON.stringify(DECLARED_BY)}, BY = ${JSON.stringify(BY_NAMES)};
  var TYPES = ${JSON.stringify(FILE_DEPOSIT_TYPES)}, MAX = ${FILE_DEPOSIT_MAX_BYTES};
  var cur = null, seq = 0, busy = null;
  function state(x) { $('dossier-etat').textContent = x; }
  function body() { return $('dossier-corps'); }
  function why(res, fallback) {
    if (res.offline) return 'Pas de réseau : rien n’est rangé.';
    return (res.body && NO[res.body.code]) || (res.status === 403 || res.status === 404 ? 'Ce dossier n’est pas dans vos droits.' : fallback);
  }
  function day(d) {
    var x = new Date(String(d) + 'T12:00:00Z');
    if (isNaN(x.getTime())) return '';
    try { return x.toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'long', year: 'numeric' }); } catch (e) { return ''; }
  }
  function wipe() { seq += 1; busy = null; clear(body()); state(''); $('dossier-titre').textContent = 'Dossier de vente'; cur = null; }
  function open(id, reference) {
    if (!t.key() || !ID.test(id)) return Promise.resolve(false);
    t.bump();
    wipe();
    cur = { id: id, reference: reference || 'ce bien' };
    $('dossier-titre').textContent = 'Dossier de vente · ' + cur.reference;
    show('dossier', [id, reference]);
    return load();
  }
  function base() { return '/v1/dossiers/' + encodeURIComponent(cur.id); }
  function load(message) {
    var mine = ++seq;
    state('Chargement…');
    return Promise.all([send(base() + '/chemin', 'GET'), send(base() + '/pieces', 'GET'), send(base() + '/echeancier', 'GET'), send(base() + '/acte', 'GET'), send(base() + '/financement', 'GET'), send(base() + '/arret', 'GET')]).then(function (all) {
      if (mine !== seq || all.some(function (r) { return r.gone; })) return false;
      var failed = all.filter(function (r) { return !r.ok; })[0];
      // Le geste a réussi, seule la relecture manque : on le dit, sans laisser un formulaire périmé à l'écran.
      if (failed && message) { clear(body()); state(message + ' Rouvrez cet écran pour le relire.'); return true; }
      // Une lecture en échec n'est jamais montrée comme un dossier vide.
      if (failed) { clear(body()); state(failed.offline ? 'Pas de réseau. Réessayez dans un moment.' : why(failed, 'Indisponible pour le moment. Réessayez plus tard.')); return false; }
      clear(body());
      state(message || '');
      var closing = all[3].body.data;
      var stopped = all[5].body.data;
      var path = all[0].body.data.path;
      if (stopped) drawStopped(stopped); else if (closing) drawClosed(closing); else drawPath(path, all[1].body.data.identity);
      // Le code a jugé les pièces pour le jour visé : celles qu'il dit périmées ne laissent pas écrire « complet ».
      var stale = closing || all[5].body.data ? [] : (Array.isArray(path.lines) ? path.lines : []).filter(function (l) { return l.reason === 'piece_perimee'; }).map(function (l) { return l.item; });
      var live = !closing && !stopped;
      drawPieces(all[1].body.data, live, stale);
      drawSchedule(all[2].body.data, live);
      drawFinancing(all[4].body.data, live);
      drawCopro();
      drawPreContract();
      if (live) { drawAct(all[2].body.data); drawStop(); }
      return true;
    });
  }
  /* BR88, BR90, BR91 : un bloc dont le script est servi à part et chargé au premier geste, une seule fois [R201]. */
  var lazy = {};
  function drawLazy(title, src, name, gestures) {
    var box = el('section', null, 'bloc');
    box.appendChild(el('h3', title));
    var inner = el('div');
    var id = cur.id, buttons = [];
    function withScript(btn, act) {
      if (btn.disabled) return;
      if (lazy[name]) { act(lazy[name]); return; }
      function hold(v) { buttons.forEach(function (x) { x.disabled = v; }); }
      hold(true);
      var mine = t.session();
      var s = el('script');
      s.setAttribute('src', src);
      s.addEventListener('load', function () {
        var make = globalThis[name];
        try { delete globalThis[name]; } catch (e) { /* rien */ }
        hold(false);
        if (mine !== t.session()) return;
        if (typeof make !== 'function') { clear(inner); inner.appendChild(el('p', 'Indisponible pour le moment. Réessayez dans un moment.', 'etat')); return; }
        lazy[name] = make({ el: el, clear: clear, send: send, session: t.session, sendPdf: function (url, file) { return sendFile(url, file, { 'content-type': 'application/pdf' }); }, proof: proofFile, refresh: function (m) { return load(m); } });
        act(lazy[name]);
      });
      s.addEventListener('error', function () { hold(false); if (mine === t.session()) { clear(inner); inner.appendChild(el('p', 'Pas de réseau. Réessayez dans un moment.', 'etat')); } });
      box.appendChild(s);
    }
    gestures.forEach(function (g) {
      var b = button(g[0], function () { withScript(b, function (c) { c[g[1]](inner, id); }); });
      buttons.push(b);
      box.appendChild(b);
    });
    box.appendChild(inner);
    body().appendChild(box);
  }
  function drawCopro() {
    drawLazy('Copropriété et urbanisme', '/app/copropriete.js', 'AIMMO_COPROPRIETE', [['Lire le résumé de copropriété et d’urbanisme', 'show'], ['Préparer un nouveau résumé depuis les PDF', 'compose']]);
  }
  function drawPreContract() {
    drawLazy('Avant-contrat', '/app/avant-contrat.js', 'AIMMO_AVANT_CONTRAT', [['Ouvrir l’avant-contrat : note, projet du notaire, dépôt', 'show']]);
  }
  /* BR91 : une preuve déposée telle quelle au dossier, avec son empreinte ; rend la réponse du serveur, ou { refused } en mots. */
  function proofFile(file) {
    var type = String((file && file.type) || '').toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(TYPES, type)) return Promise.resolve({ refused: NO.type_refuse });
    if (file.size > MAX) return Promise.resolve({ refused: NO.trop_lourd });
    var mine = t.session();
    return file.arrayBuffer().then(function (buf) { return crypto.subtle.digest('SHA-256', buf); }).then(function (sum) {
      return mine !== t.session() ? { gone: true } : upload('/preuves', file, type, hex(sum));
    }, function () { return { refused: 'Ce fichier ne se lit pas sur ce téléphone.' }; });
  }
  function itemName(item) { return PIECES[item] || DEADLINES[item] || ITEMS[item] || ''; }
  function lineText(l, identity) {
    // Celui qui ne voit pas l'acquéreur ne sait pas si son identité est vérifiée : on ne le lui affirme pas [R10].
    if (l.reason === 'identite_a_verifier' && identity === 'non_visible') return 'Identité de l’acquéreur : hors de vos droits, voyez avec la direction.';
    var name = itemName(l.item);
    return (REASONS[l.reason] || 'À vérifier') + (name ? ' : ' + name : '') + (WHO[l.who] ? ' · ' + WHO[l.who] : '') + (l.notBefore ? ' · pas avant le ' + day(l.notBefore) : '');
  }
  function drawStopped(s) {
    var box = el('section', null, 'bloc');
    box.appendChild(el('h3', 'Dossier arrêté'));
    box.appendChild(el('strong', (STOPS[s.reason] || 'Arrêté') + ', le ' + day(s.on) + '.'));
    box.appendChild(el('p', 'Le dossier reste lisible. Le bien revient à la vente au prochain passage, si son mandat le permet.', 'doux'));
    body().appendChild(box);
  }
  // L'arrêt rend le bien à la vente et ne se reprend pas : il se confirme, sur la raison montrée [R233].
  function drawStop() {
    var box = el('section', null, 'bloc');
    box.appendChild(el('h3', 'Arrêter le dossier'));
    box.appendChild(el('p', 'Si la vente ne se fera pas. L’arrêt est définitif : une reprise demande une nouvelle offre.', 'doux'));
    var which = choice(box, 'dossier-arret-raison', 'La raison', Object.keys(STOPS), function (k) { return STOPS[k]; });
    var proof = picker(box, 'dossier-arret-preuve', 'La preuve : lettre reçue, refus de prêt, accord écrit', '/preuves', 'Joignez la preuve de l’arrêt.');
    var sure = null;
    function drop() { if (sure) { box.removeChild(sure); sure = null; } }
    box.appendChild(button('Arrêter ce dossier', function () {
      drop();
      if (!which.value) { state('Choisissez la raison.'); return; }
      if (!proof.input.files || !proof.input.files[0]) { state('Joignez la preuve de l’arrêt.'); return; }
      var chosen = which.value;
      state('Le dossier sera arrêté et le bien reviendra à la vente : cela ne se défait pas.');
      sure = button('Confirmer l’arrêt : ' + STOPS[chosen], act(function () {
        if (which.value !== chosen) { drop(); state('La raison a changé : recommencez.'); return false; }
        return proof.get().then(function (ref) {
          if (!ref) return false;
          return post('/arret', { reason: chosen, proofRef: ref }, 'Dossier arrêté.', 'Le dossier n’est pas arrêté : réessayez.', proof);
        });
      }));
      box.appendChild(sure);
    }));
    body().appendChild(box);
  }
  function drawClosed(c) {
    var box = el('section', null, 'bloc');
    box.appendChild(el('h3', 'Dossier clos'));
    box.appendChild(el('strong', c.signedOn ? 'Acte signé le ' + day(c.signedOn) + '.' : 'Acte signé.'));
    body().appendChild(box);
  }
  function drawPath(p, identity) {
    var box = el('section', null, 'bloc');
    // Un délai dont le jour est passé ne tient plus rien : il n'est ni en tête, ni dans le reste à lever.
    var live = (Array.isArray(p.lines) ? p.lines : []).filter(function (l) { return !(LAPSING.indexOf(l.reason) >= 0 && l.notBefore && l.notBefore <= p.today); });
    var holder = p.holder && live.indexOf(p.holder) >= 0 ? p.holder : live.filter(function (l) { return p.holder && l.reason === p.holder.reason && l.item === p.holder.item; })[0] || live[0] || null;
    box.appendChild(el('h3', 'Ce qui tient le dossier'));
    box.appendChild(el('strong', holder ? lineText(holder, identity) : 'Rien ne tient ce dossier.'));
    if (p.earliestActDay) box.appendChild(el('p', 'Acte au plus tôt : ' + day(p.earliestActDay) + (p.conditional ? ', si les points sans date sont levés.' : '.'), 'doux'));
    else box.appendChild(el('p', 'Le jour de l’acte ne peut pas encore se calculer.', 'doux'));
    if (p.plannedActDay) box.appendChild(el('p', 'Acte prévu : ' + day(p.plannedActDay) + '.', p.late ? 'retard' : 'doux'));
    if (p.late) box.appendChild(el('p', 'L’acte prévu tombe avant le jour au plus tôt.', 'retard'));
    var rest = live.filter(function (l) { return l !== holder; });
    if (rest.length) {
      var d = el('details');
      d.appendChild(el('summary', 'Le reste à lever (' + rest.length + ')'));
      var ul = el('ul');
      rest.forEach(function (l) { ul.appendChild(el('li', lineText(l, identity))); });
      d.appendChild(ul);
      box.appendChild(d);
    }
    body().appendChild(box);
  }
  function drawSchedule(s, open) {
    var box = el('section', null, 'bloc');
    box.appendChild(el('h3', 'Échéances'));
    var ul = el('ul');
    (Array.isArray(s.lines) ? s.lines : []).forEach(function (l) {
      ul.appendChild(el('li', (DEADLINES[l.deadline] || 'Échéance') + ' : ' + (l.status === 'datee' && l.day ? day(l.day) : SCHEDULE[l.status] || 'à vérifier')));
    });
    box.appendChild(ul);
    var dates = s.dates || {};
    var done = KINDS.filter(function (k) { return dates[k]; });
    if (done.length) {
      box.appendChild(el('p', 'Dates saisies, chacune avec sa preuve :', 'doux'));
      var seen = el('ul');
      done.forEach(function (k) { seen.appendChild(el('li', DATES[k] + ' : ' + day(dates[k].day) + (dates[k].version > 1 ? ', version ' + dates[k].version : ''))); });
      box.appendChild(seen);
    }
    if (open) dateForm(box, s);
    body().appendChild(box);
  }
  // Seules les dates qui peuvent se saisir sont proposées ; le serveur garde le dernier mot sur l'ordre [R61].
  function dateChoices(s) {
    var dates = s.dates || {};
    if (!dates.compromis_signe) return ['compromis_signe'];
    var off = {};
    (Array.isArray(s.lines) ? s.lines : []).forEach(function (l) { if (l.status === 'sans_objet') off[l.from] = true; });
    return KINDS.filter(function (k) {
      if (off[k]) return false;
      if (k === 'dia_suspension') return !!dates.dia_recue;
      if (k === 'dia_reprise') return !!dates.dia_suspension;
      return true;
    });
  }
  function choice(box, id, label, values, name) {
    var f = field(box, id, label, 'select');
    var first = el('option', 'À choisir');
    first.value = '';
    f.appendChild(first);
    values.forEach(function (v) {
      var o = el('option', name(v));
      o.value = v;
      f.appendChild(o);
    });
    return f;
  }
  function dayField(box, id, label) {
    var f = field(box, id, label);
    f.setAttribute('type', 'date');
    return f;
  }
  function act(run) {
    return function () {
      if (busy) return Promise.resolve(false);
      var me = busy = {};
      function done(r) { if (busy === me) busy = null; return r; }
      return Promise.resolve().then(run).then(done, function () { done(false); state('Rien n’est rangé : réessayez.'); return false; });
    };
  }
  // Refusée, la saisie reste à l'écran ; say peut dire le refus plus précisément.
  function post(path, data, done, failed, proof, say) {
    var mine = ++seq;
    return send(base() + path, 'POST', data).then(function (res) {
      if (res.gone || mine !== seq) return false;
      if (res.ok) return load(done);
      if (proof && res.body && (res.body.code === 'not_stored' || res.body.code === 'bad_proof')) proof.forget();
      state((say && say(res)) || why(res, failed));
      return false;
    });
  }
  function dateForm(box, s) {
    var dates = s.dates || {};
    var which = choice(box, 'dossier-saisie-genre', 'Date à saisir', dateChoices(s), function (k) { return DATES[k] + (dates[k] ? ' (corriger le ' + day(dates[k].day) + ')' : ''); });
    var when = dayField(box, 'dossier-saisie-jour', 'Le jour');
    var proof = picker(box, 'dossier-saisie-preuve', 'La preuve : compromis, accusé de réception, courrier reçu', '/preuves', 'Joignez la preuve de cette date.');
    box.appendChild(button('Ranger la date', act(function () {
      if (!which.value) { state('Choisissez la date à saisir.'); return false; }
      if (!when.value) { state('Dites le jour.'); return false; }
      return proof.get().then(function (ref) {
        if (!ref) return false;
        return post('/dates', { kind: which.value, day: when.value, proofRef: ref }, 'Date rangée.', 'La date n’est pas rangée : réessayez.', proof);
      });
    })));
  }
  // Des faits déclarés, rien d'autre : ni montant, ni taux, ni note [R14].
  function drawFinancing(f, open) {
    var box = el('section', null, 'bloc');
    box.appendChild(el('h3', 'Financement déclaré'));
    if (!f.hasLoanCondition) {
      box.appendChild(el('p', 'L’offre n’a pas de condition de prêt : rien à suivre.', 'doux'));
      body().appendChild(box);
      return;
    }
    var steps = Array.isArray(f.steps) ? f.steps : [];
    if (!steps.length) box.appendChild(el('p', 'Aucune étape déclarée.', 'doux'));
    else {
      var ul = el('ul');
      // Chaque demande (banque ou courtier) a sa propre suite d'étapes (AU083) : elles se lisent par demande.
      var groups = [];
      steps.forEach(function (x) {
        var key = typeof x.demande === 'string' ? x.demande.toLocaleLowerCase('fr') : '';
        var g = groups.filter(function (y) { return y.key === key; })[0];
        if (!g) { g = { key: key, name: typeof x.demande === 'string' ? x.demande : '', steps: [] }; groups.push(g); }
        g.steps.push(x);
      });
      groups.forEach(function (g) {
        if (groups.length > 1 || g.name) box.appendChild(el('h4', g.name ? 'Demande : ' + g.name : 'Demande sans banque dite'));
        var ul = el('ul');
        g.steps.forEach(function (x) { ul.appendChild(el('li', (STEP[x.step] || 'Étape') + ' : ' + day(x.day) + ', dit par ' + (BY[x.declaredBy] || 'l’acquéreur'))); });
        box.appendChild(ul);
      });
    }
    if (open) {
      var which = choice(box, 'dossier-pret-etape', 'Étape déclarée', STEPS, function (k) { return STEP[k]; });
      var when = dayField(box, 'dossier-pret-jour', 'Le jour');
      box.appendChild(el('p', 'Pour une offre de prêt, le jour où l’acquéreur l’a reçue : le délai de réflexion en part.', 'doux'));
      var who = choice(box, 'dossier-pret-qui', 'Qui la déclare', BYS, function (k) { var n = BY[k]; return n.charAt(0).toUpperCase() + n.slice(1); });
      var bank = field(box, 'dossier-pret-demande', 'Banque ou courtier (facultatif)');
      box.appendChild(el('p', 'Quand deux banques étudient le dossier, dites laquelle : un refus ne clôt que sa demande. Jamais de numéro de compte ni de dossier.', 'doux'));
      box.appendChild(button('Ranger l’étape', act(function () {
        if (!which.value) { state('Choisissez l’étape.'); return false; }
        if (!when.value) { state('Dites le jour.'); return false; }
        if (!who.value) { state('Dites qui la déclare.'); return false; }
        var sent = { step: which.value, day: when.value, declaredBy: who.value };
        var named = String(bank.value || '').trim();
        if (named) sent.demande = named;
        return post('/financement', sent, 'Étape rangée.', 'L’étape n’est pas rangée : réessayez.');
      })));
    }
    body().appendChild(box);
  }
  // Ce qui manque au jour de l'acte, dit par le code [R60].
  function incomplete(res) {
    var b = res.body;
    if (!b || b.code !== 'incomplete') return null;
    var names = function (list) { return (Array.isArray(list) ? list : []).map(function (p) { return PIECES[p] || 'une pièce'; }).join(', '); };
    var parts = [];
    if (names(b.missing)) parts.push('il manque : ' + names(b.missing));
    if (names(b.expired)) parts.push('périmée au jour de l’acte : ' + names(b.expired));
    if (Array.isArray(b.unknown) && b.unknown.length) parts.push('à compléter : ' + b.unknown.map(function (u) { return ITEMS[u] || 'une donnée'; }).join(', '));
    if (b.identity === 'non_verifiee') parts.push('identité de l’acquéreur non vérifiée ce jour-là');
    if (b.identity === 'non_visible') parts.push('identité de l’acquéreur hors de vos droits');
    return 'L’acte n’est pas rangé' + (parts.length ? ' : ' + parts.join(' ; ') + '.' : '.');
  }
  // L'acte clôt le dossier, rend la commission due et passe le bien vendu : il se confirme, sur le jour montré.
  function drawAct(s) {
    var box = el('section', null, 'bloc');
    box.appendChild(el('h3', 'Acte signé'));
    if (!(s.dates || {}).compromis_signe) {
      box.appendChild(el('p', 'L’acte se range une fois la signature du compromis saisie.', 'doux'));
      body().appendChild(box);
      return;
    }
    var when = dayField(box, 'dossier-acte-jour', 'Le jour de la signature');
    var proof = picker(box, 'dossier-acte-preuve', 'L’attestation du notaire', '/preuves', 'Joignez l’attestation du notaire.');
    var sure = null;
    function drop() { if (sure) { box.removeChild(sure); sure = null; } }
    box.appendChild(button('Ranger l’acte signé', function () {
      drop();
      if (!when.value) { state('Dites le jour de la signature.'); return; }
      if (!proof.input.files || !proof.input.files[0]) { state('Joignez l’attestation du notaire.'); return; }
      var chosen = when.value;
      state('Le dossier sera clos et le bien passera vendu : cela ne se défait pas.');
      sure = button('Confirmer : acte signé le ' + day(chosen), act(function () {
        if (when.value !== chosen) { drop(); state('Le jour a changé : rangez de nouveau.'); return false; }
        return proof.get().then(function (ref) {
          if (!ref) return false;
          return post('/acte', { signedOn: chosen, proofRef: ref }, 'Acte rangé : le dossier est clos.', 'L’acte n’est pas rangé : réessayez.', proof, incomplete);
        });
      }));
      box.appendChild(sure);
    }));
    body().appendChild(box);
  }
  function drawPieces(f, open, stale) {
    var box = el('section', null, 'bloc');
    var lines = Array.isArray(f.lines) ? f.lines : [];
    var missing = lines.filter(function (l) { return !l.received; }).length;
    box.appendChild(el('h3', 'Pièces reçues : ' + (lines.length - missing) + ' sur ' + lines.length));
    if (stale.length) box.appendChild(el('p', 'À renouveler avant l’acte : ' + stale.map(function (p) { return PIECES[p] || 'une pièce'; }).join(', ') + '.', 'retard'));
    if (!f.complete || !stale.length) box.appendChild(el('p', f.complete ? 'Dossier complet.' : IDENTITY[f.identity] || IDENTITY.non_visible, f.complete ? null : 'doux'));
    if ((f.unknown || []).length) box.appendChild(el('p', 'La liste peut encore changer : ' + f.unknown.map(function (u) { return ITEMS[u] || 'une donnée'; }).join(', ') + ' à compléter.', 'retard'));
    var ul = el('ul');
    lines.forEach(function (l) {
      var who = l.side === 'acquereur' ? 'acquéreur' : 'vendeur';
      ul.appendChild(el('li', (PIECES[l.piece] || 'Pièce') + ' (' + who + ') : ' + (l.received ? 'reçue, datée du ' + day(l.received.issuedOn) + (l.received.version > 1 ? ', version ' + l.received.version : '') + (stale.indexOf(l.piece) >= 0 ? ', à renouveler' : '') : 'à recevoir')));
    });
    box.appendChild(ul);
    if (open && lines.length) deposit(box, lines);
    body().appendChild(box);
  }
  function hex(buf) { return Array.from(new Uint8Array(buf), function (b) { return (b + 256).toString(16).slice(1); }).join(''); }
  function upload(path, file, type, sha) { return sendFile(base() + path, file, { 'content-type': type, 'x-aimmo-sha256': sha }); }
  /* Un fichier envoyé tel quel (une pièce ; BR90 : un PDF de la copropriété). */
  function sendFile(url, file, extra) {
    var key = t.key();
    if (!key) return Promise.resolve({ gone: true });
    var mine = t.session(), headers = { authorization: 'Bearer ' + key };
    Object.keys(extra).forEach(function (k) { headers[k] = extra[k]; });
    return fetch(url, { method: 'POST', headers: headers, body: file, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' }).then(function (r) {
      return r.json().then(function (b) { return b; }, function () { return null; }).then(function (b) {
        if (mine !== t.session()) return { gone: true };
        // Une clé refusée passe par send, qui sait la retirer et le dire.
        if (r.status === 401 || (r.status === 403 && b && b.code === 'agent_inactive')) return send(base() + '/pieces', 'GET').then(function () { return { gone: true }; });
        return { status: r.status, ok: r.ok && !!b && b.ok === true, body: b };
      });
    }, function () { return mine !== t.session() ? { gone: true } : { offline: true }; });
  }
  // Un fichier à déposer : il n'est pas renvoyé tant qu'il reste le même, et personne ne saisit de référence.
  function picker(box, id, label, path, absent) {
    var pick = field(box, id, label);
    pick.setAttribute('type', 'file');
    pick.setAttribute('accept', Object.keys(TYPES).join(','));
    var kept = null;
    return {
      input: pick,
      forget: function () { kept = null; },
      get: function () {
        var file = pick.files && pick.files[0];
        if (!file) { state(absent); return Promise.resolve(null); }
        if (kept && kept.file === file) return Promise.resolve(kept.ref);
        var type = String(file.type || '').toLowerCase();
        if (!Object.prototype.hasOwnProperty.call(TYPES, type)) { state(NO.type_refuse); return Promise.resolve(null); }
        if (file.size > MAX) { state(NO.trop_lourd); return Promise.resolve(null); }
        var mine = t.session();
        state('Envoi du fichier…');
        return file.arrayBuffer().then(function (buf) { return crypto.subtle.digest('SHA-256', buf); }).then(function (sum) {
          if (mine !== t.session()) return null;
          return upload(path, file, type, hex(sum)).then(function (res) {
            if (res.gone) return null;
            var ref = res.ok && res.body.data && res.body.data.ref;
            if (typeof ref !== 'string') { state(why(res, 'Le fichier n’est pas rangé : réessayez.')); return null; }
            kept = { file: file, ref: ref };
            return ref;
          });
        }, function () { if (mine === t.session()) state('Ce fichier ne se lit pas sur ce téléphone.'); return null; });
      },
    };
  }
  // La pièce se choisit dans la liste attendue : une pièce d'identité n'y est jamais [R15].
  function deposit(box, lines) {
    box.appendChild(el('p', 'Une pièce d’identité ne se range jamais ici : elle va au coffre de la conformité.', 'doux'));
    var which = field(box, 'dossier-piece', 'Pièce à ranger', 'select');
    var first = el('option', 'À choisir');
    first.value = '';
    which.appendChild(first);
    lines.forEach(function (l) {
      var o = el('option', (PIECES[l.piece] || 'Pièce') + (l.received ? ' (nouvelle version)' : ''));
      o.value = l.piece;
      which.appendChild(o);
    });
    var issued = field(box, 'dossier-date', 'Date du document');
    issued.setAttribute('type', 'date');
    var doc = picker(box, 'dossier-fichier', 'Le document, en PDF ou en photo', '/fichiers', 'Joignez le document.');
    box.appendChild(button('Ranger la pièce', function () {
      if (busy) return Promise.resolve(false);
      if (!which.value) { state('Choisissez la pièce.'); return Promise.resolve(false); }
      if (!issued.value) { state('Dites la date du document.'); return Promise.resolve(false); }
      var me = busy = {};
      function done(r) { if (busy === me) busy = null; return r; }
      return doc.get().then(function (ref) {
        if (!ref) return false;
        var mine = ++seq;
        return send(base() + '/pieces', 'POST', { piece: which.value, ref: ref, issuedOn: issued.value }).then(function (res) {
          if (res.gone || mine !== seq) return false;
          // Refusée, la référence ne sert plus si elle est déjà prise : le fichier sera renvoyé.
          if (!res.ok) { if (res.body && (res.body.code === 'ref_used' || res.body.code === 'not_stored' || res.body.code === 'bad_ref')) doc.forget(); state(why(res, 'La pièce n’est pas rangée : réessayez.')); return false; }
          return load('Pièce rangée.');
        });
      }).then(done, function () { done(false); state('Rien n’est rangé : réessayez.'); return false; });
    }));
  }
  return { open: open, wipe: wipe };
};
`;
