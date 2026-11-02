/**
 * L'écran « Dossier de vente » de l'application de l'agent (N12), en morceaux posés dans `fichiers.ts` : sa section, son
 * chargeur et son script, servi à part (`/app/dossier.js`) et chargé à la première ouverture pour tenir le budget [R201].
 * Il s'ouvre depuis une offre dont le dossier est ouvert, sur l'écran « Offres ».
 *
 * L'écran ne lit et n'écrit que par les routes `/v1/dossiers` [R16]. Il ne calcule rien : le chemin, les pièces attendues
 * et les échéances viennent du code [R60, R61] ; une date manquante se dit, jamais inventée [R10]. Une pièce d'identité
 * ne se range jamais ici [R15]. Tout texte reçu est posé avec `textContent`.
 */
import { FILE_DEPOSIT_MAX_BYTES, FILE_DEPOSIT_TYPES } from '../../core/src/dossiers/depot.ts';

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
};
const PIECE_NAMES = {
  titre_propriete: 'Titre de propriété', fiche_renseignements_vendeur: 'Fiche de renseignements du vendeur', etat_risques: 'État des risques', dpe: 'Diagnostic énergétique',
  amiante: 'Diagnostic amiante', plomb: 'Constat plomb', electricite: 'Diagnostic électricité', gaz: 'Diagnostic gaz', bornage: 'Bornage',
  reglement_copropriete: 'Règlement de copropriété', pv_assemblees: 'Procès-verbaux des assemblées', fiche_synthetique: 'Fiche synthétique', pre_etat_date: 'Pré-état daté',
  carnet_entretien: 'Carnet d’entretien', mesurage_carrez: 'Mesurage Carrez', notice_information: 'Notice d’information', pppt_dtg: 'Plan de travaux ou diagnostic technique',
  dta_parties_communes: 'Amiante des parties communes', fiche_renseignements_acquereur: 'Fiche de renseignements de l’acquéreur',
};
const DEADLINES = { fin_retractation: 'Fin du délai de rétractation', reponse_preemption: 'Réponse de la commune', date_limite_pret: 'Date limite du prêt', etat_date: 'État daté', acte: 'Acte' };
const ITEMS = { pret: 'le prêt', fiche_bien: 'la fiche du bien', copropriete: 'la copropriété' };
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
    show('dossier');
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
  var NO = ${JSON.stringify(REFUSALS)}, PIECES = ${JSON.stringify(PIECE_NAMES)}, DEADLINES = ${JSON.stringify(DEADLINES)}, ITEMS = ${JSON.stringify(ITEMS)};
  var WHO = ${JSON.stringify(WHO)}, REASONS = ${JSON.stringify(REASONS)}, SCHEDULE = ${JSON.stringify(SCHEDULE)}, IDENTITY = ${JSON.stringify(IDENTITY)}, LAPSING = ${JSON.stringify(LAPSING)};
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
    show('dossier');
    return load();
  }
  function base() { return '/v1/dossiers/' + encodeURIComponent(cur.id); }
  function load(message) {
    var mine = ++seq;
    state('Chargement…');
    return Promise.all([send(base() + '/chemin', 'GET'), send(base() + '/pieces', 'GET'), send(base() + '/echeancier', 'GET'), send(base() + '/acte', 'GET')]).then(function (all) {
      if (mine !== seq || all.some(function (r) { return r.gone; })) return false;
      var failed = all.filter(function (r) { return !r.ok; })[0];
      // Le geste a réussi, seule la relecture manque : on le dit, sans laisser un formulaire périmé à l'écran.
      if (failed && message) { clear(body()); state(message + ' Rouvrez cet écran pour le relire.'); return true; }
      // Une lecture en échec n'est jamais montrée comme un dossier vide.
      if (failed) { clear(body()); state(failed.offline ? 'Pas de réseau. Réessayez dans un moment.' : why(failed, 'Indisponible pour le moment. Réessayez plus tard.')); return false; }
      clear(body());
      state(message || '');
      var closing = all[3].body.data;
      if (closing) drawClosed(closing); else drawPath(all[0].body.data.path, all[1].body.data.identity);
      drawPieces(all[1].body.data, !closing);
      drawSchedule(all[2].body.data);
      return true;
    });
  }
  function itemName(item) { return PIECES[item] || DEADLINES[item] || ITEMS[item] || ''; }
  function lineText(l, identity) {
    // Celui qui ne voit pas l'acquéreur ne sait pas si son identité est vérifiée : on ne le lui affirme pas [R10].
    if (l.reason === 'identite_a_verifier' && identity === 'non_visible') return 'Identité de l’acquéreur : hors de vos droits, voyez avec la direction.';
    var name = itemName(l.item);
    return (REASONS[l.reason] || 'À vérifier') + (name ? ' : ' + name : '') + (WHO[l.who] ? ' · ' + WHO[l.who] : '') + (l.notBefore ? ' · pas avant le ' + day(l.notBefore) : '');
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
  function drawSchedule(s) {
    var box = el('section', null, 'bloc');
    box.appendChild(el('h3', 'Échéances'));
    var ul = el('ul');
    (Array.isArray(s.lines) ? s.lines : []).forEach(function (l) {
      ul.appendChild(el('li', (DEADLINES[l.deadline] || 'Échéance') + ' : ' + (l.status === 'datee' && l.day ? day(l.day) : SCHEDULE[l.status] || 'à vérifier')));
    });
    box.appendChild(ul);
    body().appendChild(box);
  }
  function drawPieces(f, open) {
    var box = el('section', null, 'bloc');
    var lines = Array.isArray(f.lines) ? f.lines : [];
    var missing = lines.filter(function (l) { return !l.received; }).length;
    box.appendChild(el('h3', 'Pièces reçues : ' + (lines.length - missing) + ' sur ' + lines.length));
    box.appendChild(el('p', f.complete ? 'Dossier complet.' : IDENTITY[f.identity] || IDENTITY.non_visible, f.complete ? null : 'doux'));
    if ((f.unknown || []).length) box.appendChild(el('p', 'La liste peut encore changer : ' + f.unknown.map(function (u) { return ITEMS[u] || 'une donnée'; }).join(', ') + ' à compléter.', 'retard'));
    var ul = el('ul');
    lines.forEach(function (l) {
      var who = l.side === 'acquereur' ? 'acquéreur' : 'vendeur';
      ul.appendChild(el('li', (PIECES[l.piece] || 'Pièce') + ' (' + who + ') : ' + (l.received ? 'reçue, datée du ' + day(l.received.issuedOn) + (l.received.version > 1 ? ', version ' + l.received.version : '') : 'à recevoir')));
    });
    box.appendChild(ul);
    if (open && lines.length) deposit(box, lines);
    body().appendChild(box);
  }
  function hex(buf) { return Array.from(new Uint8Array(buf), function (b) { return (b + 256).toString(16).slice(1); }).join(''); }
  function upload(file, type, sha) {
    var key = t.key();
    if (!key) return Promise.resolve({ gone: true });
    var mine = t.session();
    return fetch(base() + '/fichiers', { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': type, 'x-aimmo-sha256': sha }, body: file, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' }).then(function (r) {
      return r.json().then(function (b) { return b; }, function () { return null; }).then(function (b) {
        if (mine !== t.session()) return { gone: true };
        // Une clé refusée passe par send, qui sait la retirer et le dire.
        if (r.status === 401 || (r.status === 403 && b && b.code === 'agent_inactive')) return send(base() + '/pieces', 'GET').then(function () { return { gone: true }; });
        return { status: r.status, ok: r.ok && !!b && b.ok === true, body: b };
      });
    }, function () { return mine !== t.session() ? { gone: true } : { offline: true }; });
  }
  // La pièce se choisit dans la liste attendue : une pièce d'identité n'y est jamais [R15]. Un fichier déjà déposé n'est pas renvoyé.
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
    var pick = field(box, 'dossier-fichier', 'Le document, en PDF ou en photo');
    pick.setAttribute('type', 'file');
    pick.setAttribute('accept', Object.keys(TYPES).join(','));
    var kept = null;
    function stored() {
      var file = pick.files && pick.files[0];
      if (!file) { state('Joignez le document.'); return Promise.resolve(null); }
      if (kept && kept.file === file) return Promise.resolve(kept.ref);
      var type = String(file.type || '').toLowerCase();
      if (!Object.prototype.hasOwnProperty.call(TYPES, type)) { state(NO.type_refuse); return Promise.resolve(null); }
      if (file.size > MAX) { state(NO.trop_lourd); return Promise.resolve(null); }
      var mine = t.session();
      state('Envoi du fichier…');
      return file.arrayBuffer().then(function (buf) { return crypto.subtle.digest('SHA-256', buf); }).then(function (sum) {
        if (mine !== t.session()) return null;
        return upload(file, type, hex(sum)).then(function (res) {
          if (res.gone) return null;
          var ref = res.ok && res.body.data && res.body.data.ref;
          if (typeof ref !== 'string') { state(why(res, 'Le fichier n’est pas rangé : réessayez.')); return null; }
          kept = { file: file, ref: ref };
          return ref;
        });
      }, function () { if (mine === t.session()) state('Ce fichier ne se lit pas sur ce téléphone.'); return null; });
    }
    box.appendChild(button('Ranger la pièce', function () {
      if (busy) return Promise.resolve(false);
      if (!which.value) { state('Choisissez la pièce.'); return Promise.resolve(false); }
      if (!issued.value) { state('Dites la date du document.'); return Promise.resolve(false); }
      var me = busy = {};
      function done(r) { if (busy === me) busy = null; return r; }
      return stored().then(function (ref) {
        if (!ref) return false;
        var mine = ++seq;
        return send(base() + '/pieces', 'POST', { piece: which.value, ref: ref, issuedOn: issued.value }).then(function (res) {
          if (res.gone || mine !== seq) return false;
          // Refusée, la référence ne sert plus si elle est déjà prise : le fichier sera renvoyé.
          if (!res.ok) { if (res.body && (res.body.code === 'ref_used' || res.body.code === 'not_stored' || res.body.code === 'bad_ref')) kept = null; state(why(res, 'La pièce n’est pas rangée : réessayez.')); return false; }
          return load('Pièce rangée.');
        });
      }).then(done, function () { done(false); state('Rien n’est rangé : réessayez.'); return false; });
    }));
  }
  return { open: open, wipe: wipe };
};
`;
