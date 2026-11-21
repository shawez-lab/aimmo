/**
 * BR93 · La banque et les relances d'impayés à l'écran de la direction (HX49, RC55, routes de BR04 et BR92). Un seul
 * script servi à part (`/app/banque.js`), chargé au premier geste sous « Engagements de service » de l'écran du réseau,
 * sans rien ajouter au script de l'application [R201].
 *
 * - La fraîcheur du dernier relevé (`GET /v1/finances/banque/fraicheur`) se lit avant tout : au-delà de 7 jours, ou sans
 *   relevé, aucune relance n'est préparée, faute de preuve [R553].
 * - Le relevé de la banque se dépose tel quel : le fichier choisi est lu sur l'appareil et envoyé sans rien y changer,
 *   sous la clé `csv` (`POST /v1/finances/banque/releve`) ; c'est le serveur qui le lit et n'en garde ni libellé ni
 *   coordonnée bancaire [R15, R551]. Un fichier vide ou trop gros est arrêté avant l'envoi.
 * - Les lignes à choisir (`GET …/propositions`) : chacune dit pourquoi le passage ne l'a pas rapprochée seule ; la
 *   facture citée par le libellé passe en tête. Rapprocher se fait en deux appuis (`POST …/lignes/<id>/rapprochement`),
 *   seulement vers une facture proposée par le serveur : aucun montant ni identifiant ne se tape [R551].
 * - Les rapprochements (`GET …/rapprochements`), par le passage ou par la direction ; un encaissement déjà rangé se dit,
 *   sans geste, avec sa preuve (cette ligne ou une autre) ; l'encaissement d'une autre facture
 *   rapprochée se range en deux appuis, avec la ligne de banque pour preuve (`POST …/factures/<id>/encaissement`) [R552].
 * - Les relances (`GET /v1/finances/relances`) : le texte montré mot pour mot, tel qu'il partira ; seule une relance « à
 *   valider » se valide, en deux appuis (`POST …/relances/<id>/validation`) [R553]. Rien ne part d'ici : l'envoi reste
 *   au passage, en mode essai [R26].
 *
 * Jamais vu : avant même de chercher pourquoi un client n'est pas relancé, la direction lit l'âge de son dernier relevé ;
 * chaque ligne restée à choisir dit pourquoi le passage ne l'a pas tranchée, et la relance se lit telle qu'elle partira.
 *
 * Chaque refus est dit en mots, jamais par son code [R16] ; une écriture sans réponse est dite incertaine et l'écran
 * relu. Tout texte reçu est posé en texte ; un champ mal formé n'est pas montré. Une lecture arrivée après une plus
 * récente, ou après la fin de la session, est jetée. Rien n'est gardé sur l'appareil.
 */

/** La taille admise d'un relevé par la route (`MAX_STATEMENT_BYTES`), en octets. */
export const BANQUE_MAX_BYTES = 1_000_000;

export const BANQUE_ROLE = 'Ce n’est pas dans vos droits : la direction seule tient la banque et les relances.';
export const BANQUE_OFFLINE = 'Pas de réseau. Réessayez dans un moment.';
export const BANQUE_READ_LOST = 'La banque n’a pas pu être lue. Rouvrez l’écran dans un moment.';
export const BANQUE_LOST = 'La réponse n’est pas arrivée : le geste a pu se faire. L’écran est relu : vérifiez-le avant de recommencer.';
export const BANQUE_FAILED = 'Le serveur n’a pas répondu comme prévu : le geste a pu se faire. L’écran est relu : vérifiez-le avant de recommencer.';

/** La fraîcheur du dernier relevé, dite en mots [R553]. */
export const BANQUE_NO_STATEMENT = 'Aucun relevé déposé : aucun encaissement n’est rapproché, et aucune relance n’est préparée faute de preuve. Déposez le relevé de la banque du réseau.';
export const BANQUE_STALE = 'Aucune relance n’est préparée tant qu’un relevé plus récent n’est pas déposé : un client ne doit jamais être relancé pour une facture déjà payée.';
export const BANQUE_FRESH = 'Les relances des factures échues se préparent chaque matin à 6 h, depuis ce relevé.';

/** Pourquoi le passage n'a pas rapproché seul une ligne : déduit de ce que le serveur rend, sans rien deviner. */
export const BANQUE_WHY_NONE = 'Aucune facture d’honoraires libre de ce montant, du jour de la ligne ou d’avant : rien à rapprocher. Un paiement partiel ou groupé ne se rapproche pas.';
export const BANQUE_WHY_UNCITED = 'Le libellé ne cite aucun numéro de facture : le passage ne rapproche jamais seul sans lui. Choisissez la facture que cette ligne paie.';
export const BANQUE_WHY_ELSEWHERE = 'Le libellé cite un numéro, mais aucune facture libre de ce montant ne le porte. Vérifiez la ligne avant de choisir.';
export const BANQUE_WHY_CITED = 'Le libellé cite cette facture, au même montant : soit une autre ligne libre la cite aussi, soit le passage de l’heure n’est pas encore passé. Vérifiez avant de choisir.';

export const BANQUE_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  role: BANQUE_ROLE,
  bad_statement: 'Le relevé n’a pas la forme attendue (jour ; libellé ; montant) : rien n’est rangé.',
  future_day: 'Le relevé porte un jour à venir : rien n’est rangé.',
  invalid_body: 'Le fichier n’a pas pu être envoyé : rien n’est rangé.',
  unknown_field: 'Le fichier n’a pas pu être envoyé : rien n’est rangé.',
  unknown: 'Cette relance n’existe plus : l’écran est relu.',
  unknown_line: 'Cette ligne n’est plus à choisir : l’écran est relu.',
  unknown_invoice: 'Cette facture n’est plus proposée : l’écran est relu.',
  not_credit: 'Cette ligne n’est pas un crédit : elle ne paie aucune facture.',
  amount: 'Le montant de la ligne n’est pas celui de la facture, au centime près : rien n’est rapproché.',
  before_invoice: 'La ligne est d’avant le jour de la facture : elle ne la paie pas.',
  credited: 'Cette facture est corrigée par un avoir : elle ne se rapproche plus.',
  already: 'C’est déjà fait : la ligne ou la facture est déjà rapprochée, ou l’encaissement déjà rangé. L’écran est relu.',
  not_reconciled: 'Cette facture n’est rapprochée d’aucune ligne de banque : son encaissement ne se range pas d’ici.',
  not_invoiced: 'La commission de cette vente n’est pas encore facturée : l’encaissement attend la facture.',
  sale_cancelled: 'Cette vente est annulée par un avoir : aucun encaissement ne se range.',
  bad_time: 'Le jour de la ligne est d’avant la facture validée : l’encaissement ne se range pas.',
  future_time: 'Le jour de la ligne est à venir : l’encaissement attend ce jour.',
  not_pending: 'Cette relance n’attend plus de validation : l’écran est relu.',
  texte_a_refaire: 'Une part de paiement est arrivée : le texte se refait au reste dû au prochain passage, puis se relit avant d’être validé.',
});

export const BANQUE_REMINDER_STATES: Readonly<Record<string, string>> = Object.freeze({
  a_valider: 'À valider : rien ne part sans vous.',
  validee: 'Validée : elle partira au prochain passage, entre 9 h et 19 h, par le contrôle central, en mode essai.',
  envoyee: 'Partie en mode essai : aucun client ne l’a reçue.',
  refusee: 'Arrêtée par le contrôle central des envois (accord, exclusion ou doublon) : rien n’est parti.',
  close: 'Close : la facture a été rapprochée ou corrigée avant l’envoi.',
});

/** Le script servi à part. Il ne lit et n'écrit que sous `/v1/finances/banque` et `/v1/finances/relances` [R16]. */
export const BANQUE_SCRIPT = `'use strict';
globalThis.AIMMO_BANQUE = function (t) {
  var el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field, details = t.details, date = t.date;
  var REFUSALS = ${JSON.stringify(BANQUE_REFUSALS)}, STATES = ${JSON.stringify(BANQUE_REMINDER_STATES)};
  var MAX = ${BANQUE_MAX_BYTES}, ID = /^[A-Za-z0-9_-]{1,64}$/, DAY = /^\\d{4}-\\d{2}-\\d{2}$/, REF = /^F-\\d{4}-\\d{5}$/;
  var ROLE = ${JSON.stringify(BANQUE_ROLE)}, OFFLINE = ${JSON.stringify(BANQUE_OFFLINE)}, READ_LOST = ${JSON.stringify(BANQUE_READ_LOST)};
  var LOST = ${JSON.stringify(BANQUE_LOST)}, FAILED = ${JSON.stringify(BANQUE_FAILED)};
  var NO_STATEMENT = ${JSON.stringify(BANQUE_NO_STATEMENT)}, STALE = ${JSON.stringify(BANQUE_STALE)}, FRESH = ${JSON.stringify(BANQUE_FRESH)};
  var WHY_NONE = ${JSON.stringify(BANQUE_WHY_NONE)}, WHY_UNCITED = ${JSON.stringify(BANQUE_WHY_UNCITED)};
  var WHY_ELSEWHERE = ${JSON.stringify(BANQUE_WHY_ELSEWHERE)}, WHY_CITED = ${JSON.stringify(BANQUE_WHY_CITED)};
  var B = '/v1/finances/banque', R = '/v1/finances/relances';
  var box = null, status = null, body = null, pick = null, busy = false, reads = 0;
  function say(text) { if (status) status.textContent = text; }
  function day(d) { return typeof d === 'string' && DAY.test(d) ? date(d + 'T12:00:00Z') : ''; }
  function cents(n) { return typeof n === 'number' && Math.floor(n) === n; }
  function euros(n) {
    var abs = Math.abs(n), whole = String(Math.floor(abs / 100)).replace(/\\B(?=(\\d{3})+(?!\\d))/g, '\\u202f');
    return (n < 0 ? '−' : '') + whole + ',' + String(abs % 100 + 100).slice(1) + ' €';
  }
  function moment(iso) {
    var d = new Date(iso);
    if (typeof iso !== 'string' || isNaN(d.getTime())) return '';
    try { return d.toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; }
  }
  function refusal(res) {
    var b = res.body, code = b && typeof b.code === 'string' ? b.code : null;
    if (code === 'bad_statement' && typeof b.line === 'number' && b.line > 0 && Math.floor(b.line) === b.line) return 'La ligne ' + b.line + ' du relevé est illisible (jour ; libellé ; montant attendus) : rien n’est rangé.';
    if (code === 'bad_statement' && b.line === 0) return REFUSALS.future_day;
    if (code && Object.prototype.hasOwnProperty.call(REFUSALS, code)) return REFUSALS[code];
    return FAILED;
  }
  /* Un geste qui écrit : deux appuis, la question dite avec ce qui sera rangé, puis la réponse et l'écran relu. */
  function twoSteps(holder, label, question, confirm, act) {
    var b = button(label, function () {
      if (busy) return;
      clear(holder);
      holder.appendChild(el('p', question));
      holder.appendChild(button(confirm, act));
      var no = button('Annuler', function () { clear(holder); holder.appendChild(b); });
      no.className = 'secondaire';
      holder.appendChild(no);
    });
    holder.appendChild(b);
  }
  function write(path, payload, done) {
    if (busy) return;
    busy = true;
    var mine = t.session();
    say('Envoi…');
    send(path, 'POST', payload).then(function (res) {
      busy = false;
      if (res.gone || mine !== t.session()) return;
      var text;
      if (res.offline || !res.body) text = LOST;
      else if (res.ok) text = done(res.body);
      else if (res.status >= 500) text = FAILED;
      else text = refusal(res);
      load(text);
    });
  }
  function freshness(f) {
    var p = el('section', null, 'bloc');
    p.appendChild(el('h5', 'Le dernier relevé'));
    if (!f || typeof f.reason !== 'string') { p.appendChild(el('p', READ_LOST, 'etat')); return p; }
    if (f.reason === 'aucun_releve') { p.appendChild(el('p', NO_STATEMENT, 'retard')); return p; }
    var age = f.ageDays, max = f.maxAgeDays;
    if (!day(f.lastImportDay) || !cents(age) || age < 0 || !cents(max)) { p.appendChild(el('p', READ_LOST, 'etat')); return p; }
    var since = age === 0 ? 'aujourd’hui' : age === 1 ? 'hier' : 'il y a ' + age + ' jours';
    p.appendChild(el('p', 'Dernier relevé déposé le ' + day(f.lastImportDay) + ', ' + since + '.'));
    if (f.reason === 'releve_ancien') p.appendChild(el('p', 'Plus de ' + max + ' jours. ' + STALE, 'retard'));
    else p.appendChild(el('p', FRESH, 'doux'));
    return p;
  }
  function deposit() {
    var p = el('section', null, 'bloc');
    p.appendChild(el('h5', 'Déposer le relevé de la banque'));
    p.appendChild(el('p', 'Le fichier CSV exporté de la banque du réseau (jour ; libellé ; montant), tel quel. Seuls le jour, le montant et les numéros de facture cités sont gardés : ni libellé, ni nom, ni coordonnée bancaire. Le même relevé déposé deux fois ne double rien.', 'doux'));
    pick = field(p, 'banque-releve', 'Relevé (CSV, 1 Mo au plus)');
    pick.setAttribute('type', 'file');
    pick.setAttribute('accept', '.csv,text/csv,text/plain');
    p.appendChild(button('Déposer ce relevé', fromFile));
    return p;
  }
  function fromFile() {
    if (busy) return;
    var f = pick && pick.files && pick.files.length === 1 ? pick.files[0] : null;
    if (!f) { say('Choisissez le fichier du relevé.'); return; }
    if (typeof f.size !== 'number' || f.size > MAX) { say('Le fichier dépasse 1 Mo : rien n’est envoyé. Exportez une période plus courte.'); return; }
    if (f.size === 0) { say('Ce fichier est vide : rien n’est envoyé.'); return; }
    var mine = t.session();
    busy = true;
    say('Lecture du fichier…');
    f.text().then(function (csv) {
      busy = false;
      if (mine !== t.session()) return;
      write(B + '/releve', { csv: String(csv) }, function (b) {
        var added = cents(b.added) ? b.added : null, already = cents(b.already) ? b.already : null;
        if (added === null || already === null) return 'Relevé déposé.';
        return 'Relevé déposé : ' + added + (added > 1 ? ' lignes nouvelles' : ' ligne nouvelle') + ', ' + already + (already > 1 ? ' déjà connues.' : ' déjà connue.');
      });
    }, function () { busy = false; if (mine === t.session()) say(REFUSALS.invalid_body); });
  }
  function why(pr, first) {
    if (!pr.candidates.length) return WHY_NONE;
    if (!pr.cited.length) return WHY_UNCITED;
    return first && pr.cited.indexOf(first.label) >= 0 ? WHY_CITED : WHY_ELSEWHERE;
  }
  function clean(pr) {
    if (!pr || !ID.test(pr.lineId) || !day(pr.day) || !cents(pr.amountCents) || !Array.isArray(pr.cited) || !Array.isArray(pr.candidates)) return null;
    var cited = pr.cited.filter(function (r) { return typeof r === 'string' && REF.test(r); });
    var cands = pr.candidates.filter(function (c) { return c && ID.test(c.invoiceId) && typeof c.label === 'string' && REF.test(c.label); });
    /* La facture citée par le libellé passe en tête, l'ordre du serveur gardé pour les autres. */
    var top = cands.filter(function (c) { return cited.indexOf(c.label) >= 0; }), rest = cands.filter(function (c) { return cited.indexOf(c.label) < 0; });
    return { lineId: pr.lineId, day: pr.day, amountCents: pr.amountCents, cited: cited, candidates: top.concat(rest) };
  }
  function proposal(pr) {
    var li = el('li');
    var line = 'Ligne du ' + day(pr.day) + ' : ' + euros(pr.amountCents);
    li.appendChild(el('strong', line));
    if (pr.cited.length) li.appendChild(el('p', 'Le libellé cite : ' + pr.cited.join(', ') + '.', 'doux'));
    li.appendChild(el('p', why(pr, pr.candidates[0])));
    var ul = el('ul', null, 'liste');
    pr.candidates.forEach(function (c) {
      var item = el('li');
      var cited = pr.cited.indexOf(c.label) >= 0;
      item.appendChild(el('p', 'Facture ' + c.label + ', ' + euros(pr.amountCents) + (cited ? ' · citée par le libellé' : '')));
      var holder = el('div');
      twoSteps(holder, 'Rapprocher de ' + c.label, 'La ligne du ' + day(pr.day) + ' de ' + euros(pr.amountCents) + ' paie la facture ' + c.label + ' : une ligne pour une facture, sans retour en arrière par cet écran.', 'Confirmer le rapprochement', function () {
        write(B + '/lignes/' + encodeURIComponent(pr.lineId) + '/rapprochement', { invoiceId: c.invoiceId }, function () { return 'Ligne du ' + day(pr.day) + ' rapprochée de la facture ' + c.label + '. Rangez maintenant son encaissement.'; });
      });
      item.appendChild(holder);
      ul.appendChild(item);
    });
    if (pr.candidates.length) li.appendChild(ul);
    return li;
  }
  function proposals(list) {
    var p = el('section', null, 'bloc');
    p.appendChild(el('h5', 'Lignes à choisir'));
    if (!Array.isArray(list)) { p.appendChild(el('p', READ_LOST, 'etat')); return p; }
    var all = list.map(clean).filter(function (x) { return x; });
    var open = all.filter(function (x) { return x.candidates.length; }), none = all.filter(function (x) { return !x.candidates.length; });
    if (!open.length) p.appendChild(el('p', 'Aucune ligne à choisir : ce que la banque prouve est rapproché.', 'doux'));
    var ul = el('ul', null, 'liste');
    open.forEach(function (x) { ul.appendChild(proposal(x)); });
    if (open.length) p.appendChild(ul);
    if (none.length) {
      var d = details(p, 'Autres crédits, sans facture de ce montant (' + none.length + ')');
      d.appendChild(el('p', WHY_NONE, 'doux'));
      var other = el('ul', null, 'liste');
      none.forEach(function (x) { other.appendChild(el('li', 'Ligne du ' + day(x.day) + ' : ' + euros(x.amountCents) + (x.cited.length ? ' · cite ' + x.cited.join(', ') : ''))); });
      d.appendChild(other);
    }
    return p;
  }
  function reconciliations(list) {
    var p = el('section', null, 'bloc');
    p.appendChild(el('h5', 'Factures rapprochées'));
    if (!Array.isArray(list)) { p.appendChild(el('p', READ_LOST, 'etat')); return p; }
    var ok = list.filter(function (r) { return r && ID.test(r.invoiceId) && typeof r.label === 'string' && REF.test(r.label) && day(r.day) && cents(r.amountCents) && (r.mode === 'auto' || r.mode === 'direction'); });
    if (!ok.length) { p.appendChild(el('p', 'Aucune facture rapprochée pour le moment.', 'doux')); return p; }
    p.appendChild(el('p', 'L’encaissement se range depuis la facture rapprochée, avec la ligne de banque pour preuve : aucun montant ni jour ne se tape.', 'doux'));
    var ul = el('ul', null, 'liste');
    ok.forEach(function (r) {
      var li = el('li');
      li.appendChild(el('strong', 'Facture ' + r.label + ' : ' + euros(r.amountCents)));
      li.appendChild(el('p', 'Payée par la ligne du ' + day(r.day) + ', rapprochée ' + (r.mode === 'auto' ? 'seule par le passage (numéro cité, même montant, un seul choix).' : 'par la direction.'), 'doux'));
      /* Un encaissement déjà rangé se dit, sans geste : seul ce qui attend la direction garde son bouton. */
      if (r.receipt) {
        var c = r.receipt, got = moment(c.receivedAt), due = moment(c.payoutDueAt);
        if (!got || !due || (c.proof !== 'ligne' && c.proof !== 'autre')) li.appendChild(el('p', 'Un encaissement est rangé, mais son détail n’a pas pu être lu.', 'etat'));
        else li.appendChild(el('p', 'Encaissement rangé, reçu le ' + got + (c.proof === 'ligne' ? ', cette ligne de banque pour preuve' : ', avec une autre preuve, aux commissions') + '. Part de l’agent à verser avant le ' + due + '.', 'doux'));
        ul.appendChild(li);
        return;
      }
      var holder = el('div');
      twoSteps(holder, 'Ranger l’encaissement', 'Ranger l’encaissement de la facture ' + r.label + ', reçu le ' + day(r.day) + ', avec la ligne de banque pour preuve.', 'Confirmer l’encaissement', function () {
        write(B + '/factures/' + encodeURIComponent(r.invoiceId) + '/encaissement', undefined, function (b) {
          var due = moment(b.payoutDueAt);
          return 'Encaissement de la facture ' + r.label + ' rangé, la ligne de banque pour preuve.' + (due ? ' La part de l’agent est à verser avant le ' + due + '.' : '');
        });
      });
      li.appendChild(holder);
      ul.appendChild(li);
    });
    p.appendChild(ul);
    return p;
  }
  function reminders(list) {
    var p = el('section', null, 'bloc');
    p.appendChild(el('h5', 'Relances des factures impayées'));
    if (!Array.isArray(list)) { p.appendChild(el('p', READ_LOST, 'etat')); return p; }
    var ok = list.filter(function (r) { return r && ID.test(r.id) && typeof r.label === 'string' && REF.test(r.label) && cents(r.rank) && r.rank >= 1 && typeof r.text === 'string' && Object.prototype.hasOwnProperty.call(STATES, r.status); });
    if (!ok.length) { p.appendChild(el('p', 'Aucune relance préparée.', 'doux')); return p; }
    p.appendChild(el('p', 'Chaque texte est écrit par le code depuis la seule facture, sans demande de paiement ni coordonnée bancaire. Il partira tel que vous le lisez.', 'doux'));
    /* Ce qui attend la direction passe en premier ; l'ordre du serveur est gardé dans chaque état. */
    var order = ['a_valider', 'validee', 'refusee', 'envoyee', 'close'];
    ok.sort(function (a, b) { return order.indexOf(a.status) - order.indexOf(b.status) || ok.indexOf(a) - ok.indexOf(b); });
    var ul = el('ul', null, 'liste');
    ok.forEach(function (r) {
      var li = el('li');
      li.appendChild(el('strong', 'Facture ' + r.label + ' · relance ' + r.rank + ' sur 3 au plus'));
      li.appendChild(el('p', STATES[r.status], r.status === 'a_valider' ? 'etat' : 'doux'));
      var quote = el('blockquote');
      r.text.split('\\n').forEach(function (line) { if (line.trim()) quote.appendChild(el('p', line)); });
      li.appendChild(quote);
      if (r.status === 'a_valider') {
        var holder = el('div');
        twoSteps(holder, 'Valider ce texte', 'Valider ce texte, tel quel : il partira au prochain passage, par le contrôle central, en mode essai.', 'Confirmer la validation', function () {
          write(R + '/' + encodeURIComponent(r.id) + '/validation', undefined, function () { return 'Relance de la facture ' + r.label + ' validée : elle partira au prochain passage, en mode essai.'; });
        });
        li.appendChild(holder);
      }
      ul.appendChild(li);
    });
    p.appendChild(ul);
    return p;
  }
  function data(res) { return res && res.ok && res.body && Object.prototype.hasOwnProperty.call(res.body, 'data') ? res.body.data : undefined; }
  function load(message) {
    var mine = t.session(), n = ++reads;
    if (!message) say('Chargement…');
    return Promise.all([send(B + '/fraicheur', 'GET'), send(B + '/propositions', 'GET'), send(B + '/rapprochements', 'GET'), send(R, 'GET')]).then(function (all) {
      if (mine !== t.session() || n !== reads || all.some(function (x) { return x.gone; })) return false;
      clear(body);
      if (all.some(function (x) { return !x.offline && x.body && x.body.code === 'role'; })) { say(ROLE); return false; }
      if (all.every(function (x) { return x.offline; })) { say(message || OFFLINE); return false; }
      say(message || '');
      body.appendChild(freshness(data(all[0])));
      body.appendChild(deposit());
      body.appendChild(proposals(data(all[1])));
      body.appendChild(reconciliations(data(all[2])));
      body.appendChild(reminders(data(all[3])));
      return true;
    });
  }
  return {
    show: function (inner) {
      clear(inner);
      box = el('div', null, 'banque');
      status = el('p', null, 'etat');
      status.setAttribute('role', 'status');
      body = el('div');
      body.setAttribute('aria-live', 'polite');
      box.appendChild(status);
      box.appendChild(body);
      inner.appendChild(box);
      busy = false;
      load('');
    },
  };
};
`;
