/**
 * L'écran « Offres » de l'application de l'agent (O10), en morceaux posés dans `fichiers.ts` : sa section, son chargeur
 * et son script, servi à part (`/app/offres.js`) et chargé à la première ouverture pour tenir le budget [R201].
 * Il s'ouvre depuis un bien publié de la liste « Mes biens ».
 *
 * L'écran ne lit et n'écrit que par les routes `/v1/offres` [R16]. Il ne décide rien : aucun bouton n'accepte ni ne
 * refuse, l'agent rapporte la réponse du vendeur avec sa preuve [R57] ; les offres restent dans l'ordre d'arrivée, sans
 * tri ni note [R14] ; le prochain pas vient du serveur. Tout texte reçu est posé avec `textContent`.
 */
import { OFFER_DEPOSIT_MAX_BYTES, OFFER_DEPOSIT_TYPES } from '../../core/src/offres/depot-offres.ts';
import { LOAN_TYPE_LABEL } from '../../core/src/offres/registre-offres.ts';

/** Les raisons d'un refus, dites à l'agent : jamais un code interne. */
const REFUSALS = {
  not_on_sale: 'Ce bien n’est plus en vente sous mandat : il ne reçoit plus d’offre.',
  not_assigned: 'Ce bien ou ce contact n’est pas dans vos droits.',
  unknown_buyer: 'Ce contact n’existe plus : rouvrez cet écran.',
  buyer_is_seller: 'Le vendeur de ce bien ne peut pas en être l’acquéreur.',
  remote_slip_unsigned: 'Le bon de la visite à distance n’est pas encore signé : l’offre attend sa signature.',
  busy: 'Le registre est occupé : réessayez dans un moment.',
  request_key_reused: 'Cette offre a déjà été rangée autrement : rouvrez cet écran avant de recommencer.',
  already_transmitted: 'Cette offre a déjà été transmise.',
  already_answered: 'Une réponse est déjà rangée.',
  already_recorded: 'Cette proposition est déjà rangée.',
  already_open: 'Le dossier de vente est déjà ouvert.',
  previous_file_stopped: 'Le dossier de cette offre a été arrêté : un nouveau dossier s’ouvre sur une nouvelle offre acceptée.',
  already_started: 'Le compromis est déjà en préparation.',
  not_transmitted: 'Transmettez d’abord, puis rapportez la réponse.',
  no_counter_asked: 'Aucune contre-offre n’attend de proposition.',
  not_accepted: 'Le dossier s’ouvre après une acceptation rapportée avec sa preuve.',
  other_accepted: 'Une autre offre de ce bien est déjà acceptée.',
  no_owner: 'Le vendeur n’est pas connu : transmettez de vive voix.',
  message_refused: 'Le message n’est pas parti : transmettez de vive voix, ou réessayez plus tard.',
  expired: 'Cette offre est échue : elle ne peut plus être acceptée.',
  bad_date: 'Vérifiez la date : ni à venir, ni avant la transmission, et 60 jours de validité au plus.',
  bad_amount: 'Le montant s’écrit en euros, en chiffres seulement.',
  bad_proof: 'La preuve n’est pas rangée : choisissez de nouveau le fichier.',
  identity_missing: 'Identité de l’acquéreur à vérifier : le compromis reste bloqué.',
  identity_expired: 'La vérification d’identité de l’acquéreur a expiré : le compromis reste bloqué.',
  kbis_missing: 'Extrait Kbis de la société à ranger : le compromis reste bloqué.',
  kbis_expired: 'L’extrait Kbis de la société a expiré : le compromis reste bloqué.',
  beneficial_owners_missing: 'Bénéficiaires effectifs de la société à ranger : le compromis reste bloqué.',
  beneficial_owner_unidentified: 'Un bénéficiaire effectif n’est pas identifié : le compromis reste bloqué.',
  depot_ferme: 'Le dépôt des fichiers n’est pas encore branché.',
  type_refuse: 'Ce fichier n’est pas admis : PDF, JPEG ou PNG.',
  trop_lourd: 'Ce fichier dépasse 20 Mo.',
  fichier_vide: 'Ce fichier est vide.',
  empreinte_differente: 'Le fichier a mal voyagé : réessayez.',
  stockage_indisponible: 'Le stockage ne répond pas : réessayez plus tard.',
};
/** Le champ refusé d'une offre, dit à l'agent. */
const FIELDS = {
  buyerPersonId: 'Choisissez l’acquéreur.',
  amountEur: 'Le montant s’écrit en euros, en chiffres seulement.',
  validUntil: 'Dernier jour de validité : à partir d’aujourd’hui et du jour de réception, deux ans au plus.',
  receivedAt: 'Vérifiez le moment où l’offre a été reçue.',
  downPaymentEur: 'L’apport s’écrit en euros, en chiffres seulement (0 s’il n’y en a pas).',
  loanEur: 'Le prêt s’écrit en euros, en chiffres seulement (0 s’il n’y en a pas).',
  signedRef: 'Joignez l’offre signée.',
  conditions: 'Vérifiez les conditions : le prêt demande son montant et sa durée.',
  'conditions.taux': 'Taux maximal du prêt : en %, de 0,01 à 20, deux décimales au plus, ou laissé vide.',
};
const STATES = { recue: 'reçue', transmise: 'transmise au vendeur', acceptee: 'acceptée', refusee: 'refusée', contre_offre: 'contre-offre en cours', echue: 'échue' };
const STEPS = {
  transmettre: 'Prochain pas : la transmettre au vendeur.',
  reponse_vendeur: 'Prochain pas : rapporter la réponse du vendeur, avec sa preuve.',
  ranger_proposition: 'Prochain pas : ranger la proposition reçue, avec sa preuve.',
  transmettre_proposition: 'Prochain pas : transmettre cette proposition à l’autre partie.',
  reponse_proposition: 'Prochain pas : rapporter la réponse à cette proposition, avec sa preuve.',
  ouvrir_dossier: 'Prochain pas : ouvrir le dossier de vente.',
  preparer_compromis: 'Prochain pas : préparer le compromis, une fois l’identité vérifiée.',
  aucun: 'Rien n’attend sur cette offre.',
};
/** Les types de prêt, dans l'ordre de la liste fermée du registre (AU079). */
const LOAN_TYPES = LOAN_TYPE_LABEL;
const CONDITIONS = { pret: 'prêt', vente_autre_bien: 'vente d’un autre bien', permis_construire: 'permis de construire', certificat_urbanisme: 'certificat d’urbanisme', autre: 'autre condition, voir l’offre signée' };
const EVENTS = {
  recue: 'Reçue', enregistree: 'Enregistrée au registre', controlee: 'Contrôlée',
  'transmise:message': 'Transmise par message', 'transmise:telephone': 'Transmise par téléphone', 'transmise:en_personne': 'Transmise en personne',
  'reponse:acceptee': 'Acceptée par le vendeur', 'reponse:refusee': 'Refusée par le vendeur', 'reponse:contre_offre': 'Contre-offre du vendeur',
};
const PROPOSAL_EVENTS = { vendeur: 'Proposition du vendeur', acquereur: 'Proposition de l’acquéreur', transmise: 'Proposition transmise', acceptee: 'Proposition acceptée', refusee: 'Proposition refusée', contre_offre: 'Nouvelle contre-offre' };

export const OFFRES_HTML = `<section id="offres" hidden>
<button id="offres-retour" type="button" class="retour">Retour à ma journée</button>
<h2 id="offres-titre">Offres</h2>
<p id="offres-etat" class="etat" role="status"></p>
<div id="offres-corps"></div>
</section>
`;

/** Le chargeur posé dans le script de l'application : l'écran est servi à part, chargé une fois, jamais gardé. */
export const OFFRES_JS = `
  /* ---------- M09 : l'écran « Offres » (O10), chargé à la demande [R16, R57, R201]. ---------- */
  var offresScreen = null;
  function wipeOffres() {
    if (offresScreen) { offresScreen.wipe(); return; }
    clear($('offres-corps'));
    $('offres-etat').textContent = '';
  }
  function openOffres(id, reference) {
    if (!currentKey || !ID.test(id)) return Promise.resolve(false);
    if (offresScreen) return offresScreen.open(id, reference);
    session += 1;
    var mine = session;
    wipeOffres();
    show('offres', [id, reference]);
    $('offres-etat').textContent = 'Chargement…';
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.setAttribute('src', '/app/offres.js');
      s.addEventListener('load', function () {
        var make = globalThis.AIMMO_OFFRES;
        try { delete globalThis.AIMMO_OFFRES; } catch (e) { /* rien */ }
        if (mine !== session || typeof make !== 'function') { resolve(false); return; }
        offresScreen = make({ $: $, el: el, clear: clear, send: send, button: button, field: field, checkbox: checkbox, show: show, ID: ID, openDossier: openDossier, key: function () { return currentKey; }, session: function () { return session; }, bump: function () { session += 1; } });
        resolve(offresScreen.open(id, reference));
      });
      s.addEventListener('error', function () {
        if (mine === session) $('offres-etat').textContent = 'Pas de réseau. Réessayez dans un moment.';
        resolve(false);
      });
      $('offres').appendChild(s);
    });
  }
`;

/** Le script de l'écran, servi à part (`/app/offres.js`). Il ne garde rien une fois l'écran quitté. */
export const OFFRES_SCRIPT = `'use strict';
globalThis.AIMMO_OFFRES = function (t) {
  var $ = t.$, el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field, checkbox = t.checkbox, show = t.show, ID = t.ID;
  var NO = ${JSON.stringify(REFUSALS)}, FIELDS = ${JSON.stringify(FIELDS)}, STATES = ${JSON.stringify(STATES)}, STEPS = ${JSON.stringify(STEPS)};
  var LOAN_TYPES = ${JSON.stringify(LOAN_TYPES)};
  var CONDITIONS = ${JSON.stringify(CONDITIONS)}, EVENTS = ${JSON.stringify(EVENTS)}, PROPOSAL_EVENTS = ${JSON.stringify(PROPOSAL_EVENTS)};
  var TYPES = ${JSON.stringify(OFFER_DEPOSIT_TYPES)}, MAX = ${OFFER_DEPOSIT_MAX_BYTES};
  var cur = null, seq = 0, busy = null;
  function state(x) { $('offres-etat').textContent = x; }
  function body() { return $('offres-corps'); }
  function money(n) { return String(n).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ' ') + ' €'; }
  /** Un taux écrit « 3,85 » ou « 3.85 % », en centièmes de point ; vide : null ; illisible ou hors de 0,01 à 20 % : NaN. */
  function rate(f) {
    var s = String(f.value).replace(/[\\s%]/g, '').replace(',', '.');
    if (!s) return null;
    if (!/^\\d{1,2}(\\.\\d{1,2})?$/.test(s)) return NaN;
    var bp = Math.round(Number(s) * 100);
    return bp >= 1 && bp <= 2000 ? bp : NaN;
  }
  function amount(f) { var s = String(f.value).replace(/[\\s€]/g, ''); return /^\\d+$/.test(s) ? Number(s) : NaN; }
  function when(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    try { return d.toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; }
  }
  function why(res, fallback) {
    if (res.offline) return 'Pas de réseau : rien n’est rangé.';
    var b = res.body;
    if (b && b.code === 'buyer_is_seller') return NO.buyer_is_seller;
    if (b && b.field) {
      var head = String(b.field).split('.')[0];
      if (FIELDS[head]) return FIELDS[head];
    }
    return (b && NO[b.code]) || (res.status === 403 || res.status === 404 ? 'Ce bien n’est pas dans vos droits.' : fallback);
  }
  function wipe() { seq += 1; busy = null; clear(body()); state(''); $('offres-titre').textContent = 'Offres'; cur = null; }
  function open(id, reference) {
    if (!t.key() || !ID.test(id)) return Promise.resolve(false);
    t.bump();
    wipe();
    cur = { id: id, reference: reference || 'ce bien' };
    $('offres-titre').textContent = 'Offres · ' + cur.reference;
    show('offres', [id, reference]);
    return load();
  }
  function base() { return '/v1/offres/biens/' + encodeURIComponent(cur.id); }
  function load(message) {
    var mine = ++seq;
    state('Chargement…');
    return send(base() + '/suivi', 'GET').then(function (res) {
      if (res.gone || mine !== seq) return false;
      // Le geste a réussi, seule la relecture manque : on le dit, sans laisser un formulaire périmé à l'écran.
      if (!res.ok && message) { clear(body()); state(message + ' Rouvrez cet écran pour le relire.'); return true; }
      if (!res.ok) { state(res.offline ? 'Pas de réseau. Réessayez dans un moment.' : why(res, 'Indisponible pour le moment. Réessayez plus tard.')); return false; }
      clear(body());
      state(message || '');
      draw(res.body.data);
      return true;
    });
  }
  // Un geste à la fois sur tout l'écran : un double appui ne range jamais deux fois, et un autre bouton ne fait pas
  // oublier la réponse du geste en cours, qu'elle soit un refus ou un succès.
  function act(run) {
    return function () {
      if (busy) return Promise.resolve(false);
      var me = busy = {};
      function done(r) { if (busy === me) busy = null; return r; }
      return Promise.resolve(run()).then(done, function () { done(false); state('Rien n’est rangé : réessayez.'); return false; });
    };
  }
  // Après un geste : relire si c'est rangé, dire la raison sinon, et garder ce qui est saisi.
  function post(path, payload, done, fallback) {
    var mine = ++seq;
    return send(path, 'POST', payload).then(function (res) {
      if (res.gone || mine !== seq) return false;
      if (!res.ok) { state(why(res, fallback)); return false; }
      return load(done);
    });
  }
  function hex(buf) { return Array.from(new Uint8Array(buf), function (b) { return (b + 256).toString(16).slice(1); }).join(''); }
  function upload(kind, file, type, sha) {
    var key = t.key();
    if (!key) return Promise.resolve({ gone: true });
    var mine = t.session();
    return fetch(base() + '/fichiers/' + kind, { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': type, 'x-aimmo-sha256': sha }, body: file, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' }).then(function (r) {
      return r.json().then(function (b) { return b; }, function () { return null; }).then(function (b) {
        if (mine !== t.session()) return { gone: true };
        // Une clé refusée passe par send, qui sait la retirer et le dire.
        if (r.status === 401 || (r.status === 403 && b && b.code === 'agent_inactive')) return send(base() + '/suivi', 'GET').then(function () { return { gone: true }; });
        return { status: r.status, ok: r.ok && !!b && b.ok === true, body: b };
      });
    }, function () { return mine !== t.session() ? { gone: true } : { offline: true }; });
  }
  // Une pièce prise sur le téléphone. Déposée une seule fois : si le geste qui suit est refusé, elle n'est pas renvoyée.
  function piece(box, id, label, kind) {
    var types = TYPES[kind];
    var pick = field(box, id, label);
    pick.setAttribute('type', 'file');
    pick.setAttribute('accept', Object.keys(types).join(','));
    var kept = null;
    return function () {
      var file = pick.files && pick.files[0];
      if (!file) return Promise.resolve(null);
      if (kept && kept.file === file) return Promise.resolve(kept.ref);
      var type = String(file.type || '').toLowerCase();
      if (!Object.prototype.hasOwnProperty.call(types, type)) { state(NO.type_refuse); return Promise.resolve(false); }
      if (file.size > MAX) { state(NO.trop_lourd); return Promise.resolve(false); }
      var mine = t.session();
      state('Envoi du fichier…');
      return file.arrayBuffer().then(function (buf) { return crypto.subtle.digest('SHA-256', buf); }).then(function (sum) {
        if (mine !== t.session()) return false;
        return upload(kind, file, type, hex(sum)).then(function (res) {
          if (res.gone) return false;
          var ref = res.ok && res.body.data && res.body.data.ref;
          if (typeof ref !== 'string') { state(why(res, 'Le fichier n’est pas rangé : réessayez.')); return false; }
          kept = { file: file, ref: ref };
          return ref;
        });
      }, function () { if (mine === t.session()) state('Ce fichier ne se lit pas sur ce téléphone.'); return false; });
    };
  }
  // Un moment dit par l'agent : rend l'heure complète, ou null tant qu'il n'est pas lisible.
  function moment(box, id, label) {
    var f = field(box, id, label);
    f.setAttribute('type', 'datetime-local');
    return function () {
      var d = new Date(f.value);
      return f.value && !isNaN(d.getTime()) ? d.toISOString() : null;
    };
  }
  function select(box, id, label, options) {
    var f = field(box, id, label, 'select');
    options.forEach(function (k) {
      var o = el('option', k[1]);
      o.value = k[0];
      f.appendChild(o);
    });
    return f;
  }
  function draw(data) {
    var seal = el('section', null, 'bloc');
    var n = Number(data.count) || 0;
    seal.appendChild(el('h3', n === 0 ? 'Aucune offre reçue' : n === 1 ? '1 offre reçue' : n + ' offres reçues'));
    seal.appendChild(el('p', data.registerIntact ? 'Registre intact : chaque offre a son rang, aucune n’a été retirée ni changée.' : 'Registre à vérifier : une ligne ne suit plus la chaîne. Prévenez la direction.', data.registerIntact ? 'doux' : 'retard'));
    if (n > 1) seal.appendChild(el('p', 'Dans l’ordre d’arrivée, sans classement.', 'doux'));
    body().appendChild(seal);
    (Array.isArray(data.offers) ? data.offers : []).forEach(function (o) { if (ID.test(o.id)) body().appendChild(card(o)); });
    body().appendChild(button('Enregistrer une offre reçue', act(function () { seq += 1; clear(body()); state(''); return form(); })));
  }
  function buyerName(b) { return b ? [b.firstName, b.lastName].filter(Boolean).join(' ') : ''; }
  function condition(c) {
    if (c.kind === 'pret' && c.amountEur) {
      return 'prêt' + (c.loanType && LOAN_TYPES[c.loanType] ? ' ' + LOAN_TYPES[c.loanType] : '') + ' de ' + money(c.amountEur) + ' sur ' + c.durationMonths + ' mois' +
        (typeof c.maxRateBp === 'number' ? ', taux hors assurance ' + Math.floor(c.maxRateBp / 100) + ',' + String(c.maxRateBp % 100).padStart(2, '0') + ' % au plus' : '');
    }
    return CONDITIONS[c.kind] || 'condition';
  }
  function card(o) {
    var box = el('section', null, 'bloc');
    var name = buyerName(o.buyer);
    box.appendChild(el('h3', 'Offre n° ' + o.seq + (name ? ' · ' + name : '')));
    box.appendChild(el('strong', money(o.amountEur)));
    if (o.amountEur !== o.offeredEur) box.appendChild(el('p', 'Offre d’origine : ' + money(o.offeredEur) + '.', 'doux'));
    if (o.netSellerEur !== null && o.netSellerEur !== undefined) box.appendChild(el('p', 'Net vendeur, honoraires du mandat déduits : ' + money(o.netSellerEur) + '.', 'doux'));
    var conds = Array.isArray(o.conditionDetails) ? o.conditionDetails : [];
    box.appendChild(el('p', conds.length ? 'Conditions : ' + conds.map(condition).join(', ') + '.' : 'Sans condition suspensive.', 'doux'));
    if (o.downPaymentEur !== null && o.loanEur !== null) box.appendChild(el('p', 'Financement déclaré : apport ' + money(o.downPaymentEur) + ', prêt ' + money(o.loanEur) + '.', 'doux'));
    if (o.state === 'echue' && o.next !== 'aucun') box.appendChild(el('p', 'Échue : seul un refus, ou une acceptation donnée à temps, se range encore.', 'doux'));
    var left = typeof o.daysLeft !== 'number' || o.daysLeft < 0 ? '' : o.daysLeft === 0 ? ' · dernier jour' : o.daysLeft === 1 ? ' · reste 1 jour' : ' · reste ' + o.daysLeft + ' jours';
    box.appendChild(el('p', 'État : ' + (STATES[o.state] || 'inconnu') + left));
    box.appendChild(el(o.next === 'aucun' ? 'p' : 'strong', STEPS[o.next] || STEPS.aucun));
    gesture(box, o);
    if (o.file && ID.test(o.file.id)) box.appendChild(button('Voir le dossier de vente', function () { var ref = cur.reference; wipe(); return t.openDossier(o.file.id, ref); }));
    var sheet = el('ul', null, 'constats');
    box.appendChild(button('Voir le contrôle', act(function () { return control(sheet, o.id); })));
    box.appendChild(sheet);
    var hist = Array.isArray(o.history) ? o.history : [];
    if (hist.length) {
      var d = el('details');
      d.appendChild(el('summary', 'Historique'));
      var ul = el('ul');
      hist.forEach(function (e) { ul.appendChild(el('li', when(e.at) + ' · ' + eventText(e))); });
      d.appendChild(ul);
      box.appendChild(d);
    }
    return box;
  }
  function eventText(e) {
    var p = /^proposition:\\d+:([a-z_]+)$/.exec(e.event);
    var text = p ? PROPOSAL_EVENTS[p[1]] || 'Proposition' : EVENTS[e.event] || 'Étape';
    return e.amountEur ? text + ' : ' + money(e.amountEur) : text;
  }
  var LINES = {
    identite: { verifiee: 'Identité vérifiée.', non_verifiee: 'Identité non vérifiée.' },
    financement: { couvert: 'Le financement déclaré couvre le montant.' },
    pret: { coherent: 'Le prêt déclaré suit la condition de prêt.', sans_objet: 'Pas de condition de prêt.' },
    validite: { en_cours: 'Offre dans sa durée de validité.', echue: 'Offre échue.' },
  };
  function lineText(l) {
    if (l.check === 'financement' && l.status === 'ecart') return 'Écart entre le montant et le financement déclaré : ' + money(l.missingEur) + '.';
    if (l.check === 'validite_longue' && l.status === 'atypique') return 'Durée de validité inhabituelle : ' + l.days + ' jours, pour ' + l.usualDays + ' d’habitude. L’offre est gardée telle quelle : vérifiez la date sur l’offre signée.';
    if (l.check === 'pret' && l.status === 'different') return 'Prêt de la condition : ' + money(l.conditionLoanEur) + ', prêt déclaré : ' + money(l.declaredLoanEur) + '.';
    return (LINES[l.check] && LINES[l.check][l.status]) || 'Constat à relire.';
  }
  // Des constats, ligne par ligne : jamais une note [R14].
  function control(sheet, id) {
    var mine = ++seq;
    state('Contrôle…');
    return send('/v1/offres/' + encodeURIComponent(id) + '/controle', 'POST').then(function (res) {
      if (res.gone || mine !== seq) return false;
      if (!res.ok) { state(why(res, 'Le contrôle est indisponible : réessayez.')); return false; }
      state('');
      clear(sheet);
      (Array.isArray(res.body.data) ? res.body.data : []).forEach(function (l) { sheet.appendChild(el('li', lineText(l))); });
      return true;
    });
  }
  // Le seul geste qu'attend le prochain pas : aucun bouton n'accepte ni ne refuse à la place du vendeur [R57].
  function gesture(box, o) {
    var offer = '/v1/offres/' + encodeURIComponent(o.id);
    var uid = 'o' + o.seq;
    if (o.next === 'transmettre') {
      var via = select(box, uid + '-via', 'Comment le vendeur l’a reçue', [['', 'À choisir'], ['telephone', 'Par téléphone'], ['en_personne', 'En personne']]);
      var sentAt = moment(box, uid + '-quand', 'Transmise le');
      box.appendChild(button('Noter la transmission', act(function () {
        if (!via.value) { state('Dites comment le vendeur a reçu cette offre.'); return false; }
        var at = sentAt();
        if (!at) { state('Dites quand le vendeur l’a reçue.'); return false; }
        return post(offer + '/transmission', { via: via.value, at: at }, 'Transmission rangée.', 'La transmission n’est pas rangée : réessayez.');
      })));
    } else if (o.next === 'reponse_vendeur') {
      answer(box, uid, offer + '/reponse', 'Réponse du vendeur');
    } else if (o.next === 'reponse_proposition' && o.proposalId && ID.test(o.proposalId)) {
      answer(box, uid, '/v1/offres/propositions/' + encodeURIComponent(o.proposalId) + '/reponse', 'Réponse à cette proposition');
    } else if (o.next === 'ranger_proposition') {
      var price = field(box, uid + '-montant', 'Montant proposé, en euros');
      price.setAttribute('inputmode', 'numeric');
      var last = field(box, uid + '-validite', 'Dernier jour de validité');
      last.setAttribute('type', 'date');
      var proof = piece(box, uid + '-preuve', 'Preuve de la proposition', 'preuve');
      box.appendChild(button('Ranger la proposition', act(function () {
        var value = amount(price);
        if (Number.isNaN(value)) { state(NO.bad_amount); return false; }
        return proof().then(function (ref) {
          if (ref === false) return false;
          if (ref === null) { state('Joignez la preuve de la proposition.'); return false; }
          return post(offer + '/propositions', { amountEur: value, validUntil: last.value, proofRef: ref }, 'Proposition rangée.', 'La proposition n’est pas rangée : réessayez.');
        });
      })));
    } else if (o.next === 'transmettre_proposition' && o.proposalId && ID.test(o.proposalId)) {
      var how = select(box, uid + '-via', 'Comment l’autre partie l’a reçue', [['', 'À choisir'], ['telephone', 'Par téléphone'], ['en_personne', 'En personne'], ['ecrit', 'Par écrit']]);
      var passedAt = moment(box, uid + '-quand', 'Transmise le');
      box.appendChild(button('Noter la transmission', act(function () {
        if (!how.value) { state('Dites comment l’autre partie a reçu cette proposition.'); return false; }
        var at = passedAt();
        if (!at) { state('Dites quand l’autre partie l’a reçue.'); return false; }
        return post('/v1/offres/propositions/' + encodeURIComponent(o.proposalId) + '/transmission', { via: how.value, at: at }, 'Transmission rangée.', 'La transmission n’est pas rangée : réessayez.');
      })));
    } else if (o.next === 'ouvrir_dossier') {
      box.appendChild(button('Ouvrir le dossier de vente', act(function () {
        return post(offer + '/dossier', undefined, 'Dossier de vente ouvert.', 'Le dossier n’est pas ouvert : réessayez.');
      })));
    } else if (o.next === 'preparer_compromis' && o.file && ID.test(o.file.id)) {
      box.appendChild(button('Préparer le compromis', act(function () {
        return post('/v1/offres/dossiers/' + encodeURIComponent(o.file.id) + '/compromis', undefined, 'Compromis en préparation.', 'Le compromis n’est pas en préparation : réessayez.');
      })));
    }
  }
  // Ce que l'agent rapporte : une réponse choisie, son heure et sa preuve, jamais une réponse par défaut [R57].
  function answer(box, uid, path, title) {
    var outcome = select(box, uid + '-reponse', title, [['', 'À choisir'], ['acceptee', 'Acceptation'], ['refusee', 'Refus'], ['contre_offre', 'Contre-offre']]);
    var at = moment(box, uid + '-heure', 'Reçue le');
    var proof = piece(box, uid + '-preuve', 'Preuve de la réponse', 'preuve');
    box.appendChild(button('Ranger la réponse', act(function () {
      if (!outcome.value) { state('Choisissez la réponse rapportée.'); return false; }
      var iso = at();
      if (!iso) { state('Dites quand la réponse a été reçue.'); return false; }
      return proof().then(function (ref) {
        if (ref === false) return false;
        if (ref === null) { state('Joignez la preuve de la réponse.'); return false; }
        return post(path, { outcome: outcome.value, proofRef: ref, respondedAt: iso }, 'Réponse rangée.', 'La réponse n’est pas rangée : réessayez.');
      });
    })));
  }
  function form() {
    var box = el('section', null, 'bloc');
    box.appendChild(el('h3', 'Enregistrer une offre reçue'));
    var who = select(box, 'of-acquereur', 'Acquéreur', [['', 'Chargement de vos contacts…']]);
    who.disabled = true;
    var price = field(box, 'of-montant', 'Montant de l’offre, en euros');
    var down = field(box, 'of-apport', 'Apport déclaré, en euros');
    var loan = field(box, 'of-pret', 'Prêt déclaré, en euros');
    [price, down, loan].forEach(function (f) { f.setAttribute('inputmode', 'numeric'); });
    var received = moment(box, 'of-recue', 'Reçue le');
    var last = field(box, 'of-validite', 'Dernier jour de validité');
    last.setAttribute('type', 'date');
    box.appendChild(el('p', 'Conditions suspensives', 'doux'));
    var marks = {};
    ['pret', 'vente_autre_bien', 'permis_construire', 'certificat_urbanisme', 'autre'].forEach(function (k) { marks[k] = checkbox(box, 'of-c-' + k, CONDITIONS[k]); });
    var condAmount = field(box, 'of-c-montant', 'Montant de la condition de prêt, en euros');
    condAmount.setAttribute('inputmode', 'numeric');
    var condMonths = field(box, 'of-c-duree', 'Durée de la condition de prêt, en mois');
    condMonths.setAttribute('inputmode', 'numeric');
    // Le taux maximal et le type, quand l'offre les déclare : comparés ensuite au projet du notaire (AU079).
    var condRate = field(box, 'of-c-taux', 'Taux nominal maximal hors assurance, en % (si l’offre le dit)');
    condRate.setAttribute('inputmode', 'decimal');
    var condType = select(box, 'of-c-type', 'Type de prêt (si l’offre le dit)', [['', 'Non précisé']].concat(Object.keys(LOAN_TYPES).map(function (k) { return [k, LOAN_TYPES[k]]; })));
    var signed = piece(box, 'of-signee', 'Offre signée', 'signee');
    // La même clé tant que l'écran reste ouvert : un envoi rejoué après une coupure ne crée pas une seconde ligne [R56].
    var requestKey = crypto.randomUUID();
    box.appendChild(button('Inscrire au registre', act(function () {
      if (!who.value) { state(FIELDS.buyerPersonId); return false; }
      var numbers = [amount(price), amount(down), amount(loan)];
      if (numbers.some(Number.isNaN)) { state('Montant, apport et prêt s’écrivent en euros, en chiffres seulement (0 s’il n’y en a pas).'); return false; }
      var iso = received();
      if (!iso) { state(FIELDS.receivedAt); return false; }
      var conditions = [];
      Object.keys(marks).forEach(function (k) {
        if (!marks[k].checked) return;
        if (k !== 'pret') { conditions.push({ kind: k }); return; }
        var p = { kind: 'pret', amountEur: amount(condAmount), durationMonths: amount(condMonths) };
        var bp = rate(condRate);
        if (bp !== null) p.maxRateBp = bp;
        if (condType.value) p.loanType = condType.value;
        conditions.push(p);
      });
      if (marks.pret.checked && Number.isNaN(rate(condRate))) { state(FIELDS['conditions.taux']); return false; }
      if (marks.pret.checked && (Number.isNaN(amount(condAmount)) || Number.isNaN(amount(condMonths)))) { state(FIELDS.conditions); return false; }
      return signed().then(function (ref) {
        if (ref === false) return false;
        if (ref === null) { state(FIELDS.signedRef); return false; }
        var mine = ++seq;
        return send(base(), 'POST', { buyerPersonId: who.value, amountEur: numbers[0], downPaymentEur: numbers[1], loanEur: numbers[2], conditions: conditions, validUntil: last.value, receivedAt: iso, signedRef: ref, requestKey: requestKey }).then(function (res) {
          if (res.gone || mine !== seq) return false;
          if (!res.ok) { state(why(res, 'L’offre n’est pas inscrite : réessayez.')); return false; }
          // Une durée inhabituelle se dit tout de suite : l'offre est gardée, l'agent vérifie la date (AU080).
          var long = (res.body && res.body.data && Array.isArray(res.body.data.lines) ? res.body.data.lines : []).filter(function (l) { return l && l.check === 'validite_longue'; })[0];
          return load('Offre inscrite au registre, avec son contrôle.' + (long ? ' ' + lineText(long) : ''));
        });
      });
    })));
    box.appendChild(button('Revenir aux offres', act(function () { return load(); })));
    body().appendChild(box);
    // L'acquéreur se choisit parmi les contacts : aucun identifiant à saisir [R16].
    var mine = ++seq;
    state('Chargement de vos contacts…');
    return send(base() + '/contacts', 'GET').then(function (res) {
      if (res.gone || mine !== seq) return false;
      clear(who);
      if (!res.ok) { state(res.offline ? 'Pas de réseau. Réessayez dans un moment.' : 'Vos contacts sont indisponibles pour le moment.'); return false; }
      var list = res.body.data.contacts || [];
      var first = el('option', list.length ? 'À choisir' : 'Aucun contact à proposer');
      first.value = '';
      who.appendChild(first);
      list.forEach(function (c) {
        if (!ID.test(c.personId)) return;
        var o = el('option', buyerName(c) || 'Contact sans nom');
        o.value = c.personId;
        who.appendChild(o);
      });
      who.disabled = list.length === 0;
      state(res.body.data.more ? 'Seuls les 500 premiers contacts sont proposés.' : '');
      return true;
    });
  }
  return { open: open, wipe: wipe };
};
`;
