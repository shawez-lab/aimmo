/**
 * Les finances à l'écran (K10) : le rapport du matin de chacun, sur « Mes chiffres » pour l'agent, sur « Le réseau » pour
 * la direction. Script servi à part (`/app/finances.js`), chargé au premier geste [R201]. Le serveur choisit le rapport du
 * lecteur d'après sa clé : l'écran ne demande jamais le rapport d'un autre [R68]. Rien n'est gardé sur l'appareil.
 *
 * Les commissions pour la direction (K11) : chaque commission, ses parts recomptées à l'écran [R69] et ce qu'elle attend.
 * L'encaissement puis le versement se rapportent avec la référence de leur preuve, en deux appuis ; aucun montant ne se
 * saisit [R67], l'échéance des 24 h ouvrées vient du serveur [R70].
 */

const SHARE_NAMES: Record<string, string> = {
  reseau: 'Part du réseau',
  agent: 'Part de l’agent',
  partage: 'Partage',
  parrainage: 'Prime de parrainage',
};
const SPLIT_REASONS: Record<string, string> = {
  fichier_commun: 'fichier commun',
  binome: 'binôme pendant une absence',
};
const STEP_NAMES: Record<string, string> = {
  prevue: 'Prévue',
  due: 'Due',
  facturee: 'Facturée',
  payee: 'Payée',
};
/** Ce qui se voit en premier : ce que la direction doit faire, le plus pressé d'abord. */
const GROUPS: readonly (readonly [string, string])[] = [
  ['verser', 'À verser'],
  ['encaisser', 'À encaisser'],
  ['facturer', 'À facturer'],
  ['prevue', 'Prévues, en attente de l’acte'],
  ['payee', 'Payées'],
];
const PAY_REFUSALS: Record<string, string> = {
  bad_proof: 'Cette référence n’est pas lisible : lettres sans accent, chiffres, et les signes - _ : . / seulement.',
  bad_time: 'Cette date ne convient pas : elle doit suivre la facture.',
  future_time: 'Cette date est à venir : rapportez seulement ce qui a eu lieu.',
  before_receipt: 'Le versement ne peut pas précéder l’encaissement.',
  not_invoiced: 'Cette commission n’est pas encore facturée.',
  not_received: 'L’encaissement n’est pas encore rapporté.',
  already: 'C’est déjà rapporté.',
  unknown: 'Ce dossier n’existe plus dans la liste.',
  role: 'Ce n’est pas dans vos droits.',
};

/** Une entrée du rapport : `who` distingue les deux écrans, qui ne se montrent jamais ensemble. */
const reportEntry = (who: 'agent' | 'direction'): string => `<section class="bloc" aria-labelledby="rapport-${who}-titre">
<h3 id="rapport-${who}-titre">Rapport du matin</h3>
<p class="doux">Chaque jour ouvré à 7 h 30 : les chiffres de la veille, les contacts à rappeler, les alertes.</p>
<label for="rapport-${who}-jour">Un autre jour (laisser vide pour aujourd’hui)</label>
<input id="rapport-${who}-jour" type="date">
<button id="rapport-${who}-lire" type="button" class="secondaire">Lire le rapport</button>
<p id="rapport-${who}-etat" class="etat" role="status"></p>
<div id="rapport-${who}-corps"></div>
</section>
`;

export const RAPPORT_AGENT_HTML = reportEntry('agent');
export const RAPPORT_DIRECTION_HTML = reportEntry('direction');

export const COMMISSIONS_ENTRY_HTML = `<section class="bloc" aria-labelledby="titre-commissions">
<h3 id="titre-commissions">Commissions</h3>
<p class="doux">Ce que chaque vente doit à chacun, et ce qui attend votre geste. Aucun montant ne se saisit : tout est calculé.</p>
<button id="commissions-voir" type="button" class="secondaire">Voir les commissions</button>
<p id="commissions-etat" class="etat" role="status"></p>
<div id="commissions-corps"></div>
</section>
`;

/** Le chargeur posé dans le script de l'application : l'écran est servi à part, chargé une fois, jamais gardé. */
export const FINANCES_JS = `
  /* ---------- Les finances (K10), chargées au premier geste [R16, R201]. ---------- */
  var financesTools = null, financesLoading = false;
  function wipeFinances() {
    ['agent', 'direction'].forEach(function (who) {
      clear($('rapport-' + who + '-corps'));
      $('rapport-' + who + '-etat').textContent = '';
      $('rapport-' + who + '-jour').value = '';
    });
    clear($('commissions-corps'));
    $('commissions-etat').textContent = '';
  }
  function withFinances(stateId, hostId, act) {
    if (!currentKey) return Promise.resolve(false);
    if (financesTools) return act(financesTools);
    if (financesLoading) return Promise.resolve(false);
    financesLoading = true;
    var mine = session;
    $(stateId).textContent = 'Chargement…';
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.setAttribute('src', '/app/finances.js');
      s.addEventListener('load', function () {
        financesLoading = false;
        var make = globalThis.AIMMO_FINANCES;
        try { delete globalThis.AIMMO_FINANCES; } catch (e) { /* rien */ }
        if (mine !== session) { resolve(false); return; }
        if (typeof make !== 'function') { $(stateId).textContent = 'Indisponible pour le moment. Réessayez dans un moment.'; resolve(false); return; }
        financesTools = make({ $: $, el: el, clear: clear, send: send, date: date, hour: hour, euros: euros, button: button, session: function () { return session; } });
        resolve(act(financesTools));
      });
      s.addEventListener('error', function () {
        financesLoading = false;
        if (mine === session) $(stateId).textContent = 'Pas de réseau. Réessayez dans un moment.';
        resolve(false);
      });
      $(hostId).appendChild(s);
    });
  }
  function readCommissions() {
    return withFinances('commissions-etat', 'reseau', function (f) { return f.commissions(''); });
  }
  function readReport(who, hostId) {
    return withFinances('rapport-' + who + '-etat', hostId, function (f) { return f.report(who); });
  }
`;

/** Le script servi à part (`/app/finances.js`). Il ne lit et n'écrit que les routes de M13 [R16, R68], et ne garde rien. */
export const FINANCES_SCRIPT = `'use strict';
globalThis.AIMMO_FINANCES = function (t) {
  var $ = t.$, el = t.el, clear = t.clear, send = t.send, date = t.date, hour = t.hour, euros = t.euros, button = t.button;
  var SHARE_NAMES = ${JSON.stringify(SHARE_NAMES)};
  var SPLIT_REASONS = ${JSON.stringify(SPLIT_REASONS)};
  var STEP_NAMES = ${JSON.stringify(STEP_NAMES)};
  var GROUPS = ${JSON.stringify(GROUPS)};
  var PAY_REFUSALS = ${JSON.stringify(PAY_REFUSALS)};
  var PROOF = /^[A-Za-z0-9_:.\/-]{1,200}$/;
  var reading = 0, listing = 0, uid = 0;
  function day(iso) { return date(iso + 'T12:00:00Z'); }
  function report(who) {
    var mine = t.session();
    /* Seule la dernière lecture demandée s'affiche : deux appuis ne font pas deux rapports. */
    var turn = ++reading;
    var body = $('rapport-' + who + '-corps'), state = $('rapport-' + who + '-etat');
    var chosen = $('rapport-' + who + '-jour').value;
    clear(body);
    if (chosen && !/^\\d{4}-\\d{2}-\\d{2}$/.test(chosen)) { state.textContent = 'Choisissez un jour.'; return Promise.resolve(false); }
    state.textContent = 'Chargement…';
    return send('/v1/pilotage/rapport-matin' + (chosen ? '?jour=' + chosen : ''), 'GET').then(function (res) {
      if (res.gone || mine !== t.session() || turn !== reading) return false;
      if (!res.ok) {
        if (res.offline) state.textContent = 'Pas de réseau. Réessayez dans un moment.';
        else if (res.body && res.body.rule === 'R16') state.textContent = 'Ce n’est pas dans vos droits.';
        else state.textContent = 'Indisponible pour le moment. Réessayez plus tard.';
        return false;
      }
      var r = res.body.data;
      if (!r || typeof r.text !== 'string') {
        state.textContent = chosen ? 'Aucun rapport rangé pour ce jour.' : 'Aucun rapport rangé aujourd’hui pour le moment : ils s’écrivent les jours ouvrés à 7 h 30.';
        return true;
      }
      var p = r.period || {};
      state.textContent = 'Rapport du ' + day(r.day) + (p.from && p.to ? (p.from === p.to ? ', pour le ' + day(p.from) : ', du ' + day(p.from) + ' au ' + day(p.to)) : '') + '.';
      r.text.split('\\n').forEach(function (line) {
        body.appendChild(el('p', line, line.indexOf('Alerte') === 0 ? 'retard' : undefined));
      });
      return true;
    });
  }
  function field(box, label, type) {
    uid += 1;
    var id = 'finances-champ-' + uid;
    var l = el('label', label);
    l.setAttribute('for', id);
    var i = el('input');
    i.setAttribute('id', id);
    i.setAttribute('type', type);
    box.appendChild(l);
    box.appendChild(i);
    return i;
  }
  /* Le geste : la date et la référence de la preuve, jamais un montant [R67] ; deux appuis espacés, sans suite la demande retombe. */
  function gesture(c, kind) {
    var isReceipt = kind === 'encaissement';
    var box = el('div');
    var when = field(box, isReceipt ? 'Jour et heure de l’encaissement' : 'Jour et heure du versement', 'datetime-local');
    var proof = field(box, 'Référence du relevé de compte, sans nom ni espace', 'text');
    var state = el('p', '', 'etat');
    state.setAttribute('role', 'status');
    var text = isReceipt ? 'Rapporter l’encaissement' : 'Rapporter le versement';
    var armedAt = null;
    var b = button(text, function () {
      if (b.disabled) return;
      var now = Date.now();
      if (armedAt !== null && now - armedAt < 1000) return;
      var at = when.value ? new Date(when.value) : null;
      if (!at || isNaN(at.getTime())) { state.textContent = 'Indiquez le jour et l’heure.'; return; }
      var ref = proof.value.trim();
      if (!PROOF.test(ref)) { state.textContent = PAY_REFUSALS.bad_proof; return; }
      if (armedAt === null || now - armedAt > 15000) {
        armedAt = now;
        b.textContent = 'Confirmer : ' + text.toLowerCase();
        state.textContent = (isReceipt ? 'Le délai de 24 h ouvrées partira de cette heure.' : 'La commission passera à « payée ».') + ' Ce geste ne se reprend pas. Appuyez de nouveau pour confirmer.';
        return;
      }
      armedAt = null;
      b.textContent = text;
      b.disabled = true;
      state.textContent = 'Envoi…';
      var mine = t.session();
      var payload = isReceipt ? { receivedAt: at.toISOString(), proofRef: ref } : { paidAt: at.toISOString(), proofRef: ref };
      send('/v1/pilotage/dossiers/' + encodeURIComponent(c.fileId) + '/' + kind, 'POST', payload).then(function (res) {
        if (res.gone || mine !== t.session()) return;
        if (!res.ok) {
          b.disabled = false;
          var code = res.body && res.body.code;
          var said = res.offline ? 'Pas de réseau : rien n’est rangé. Réessayez dans un moment.' : PAY_REFUSALS[code] || 'Rien n’est rangé. Réessayez plus tard.';
          /* La liste a changé sous l'écran : on la relit, et le refus reste dit. */
          if (code === 'already' || code === 'not_invoiced' || code === 'not_received' || code === 'unknown') { commissions(said); return; }
          state.textContent = said;
          return;
        }
        var v = res.body.data || {};
        if (isReceipt) commissions('Encaissement rangé pour le dossier ' + c.fileId + (v.payoutDueAt ? ' : à verser avant le ' + date(v.payoutDueAt) + ' à ' + hour(v.payoutDueAt) + '.' : '.'));
        else commissions('Versement rangé pour le dossier ' + c.fileId + (v.late ? ', après l’échéance des 24 h ouvrées.' : ', dans les 24 h ouvrées.'));
      });
    });
    box.appendChild(b);
    box.appendChild(state);
    return box;
  }
  function line(c, group, task) {
    var li = el('li');
    li.appendChild(el('strong', 'Dossier ' + c.fileId));
    var charge = c.feeCharge === 'vendeur' ? ', à la charge du vendeur' : c.feeCharge === 'acquereur' ? ', à la charge de l’acquéreur' : '';
    li.appendChild(el('p', 'Agent ' + c.agentId + ' : honoraires ' + euros(c.feeCents) + charge + '.'));
    var parts = el('ul', null, 'liste');
    var sum = 0;
    (c.shares || []).forEach(function (s) {
      sum += Number(s.amountCents);
      var who = s.beneficiaryId ? ', agent ' + s.beneficiaryId : '';
      var why = s.reason && SPLIT_REASONS[s.reason] ? ' (' + SPLIT_REASONS[s.reason] + ')' : '';
      parts.appendChild(el('li', (SHARE_NAMES[s.kind] || 'Autre part') + who + why + ' : ' + euros(s.amountCents)));
    });
    li.appendChild(parts);
    var gap = sum !== Number(c.feeCents);
    if (gap) li.appendChild(el('p', 'Écart de ' + euros(Math.abs(sum - Number(c.feeCents))) + ' entre les parts et les honoraires : ne versez rien, et vérifiez ce dossier.', 'retard'));
    li.appendChild(el('p', (c.steps || []).map(function (s) { return (STEP_NAMES[s.status] || s.status) + ' le ' + date(s.at); }).join(' · '), 'doux'));
    if (group === 'facturer') li.appendChild(el('p', 'En attente de la validation de sa facture, dans les brouillons plus haut.', 'doux'));
    if (group === 'verser' && task) {
      li.appendChild(el('p', 'Encaissé le ' + date(task.receivedAt) + '. À verser avant le ' + date(task.payoutDueAt) + ' à ' + hour(task.payoutDueAt) + '.'));
      if ((task.alerts || []).indexOf('echeance_depassee') !== -1) li.appendChild(el('p', 'Échéance dépassée.', 'retard'));
    }
    if (!gap && group === 'encaisser') li.appendChild(gesture(c, 'encaissement'));
    if (!gap && group === 'verser') li.appendChild(gesture(c, 'reversement'));
    return li;
  }
  function commissions(message) {
    var mine = t.session();
    /* Seule la dernière lecture demandée s'affiche : deux appuis ne font pas deux listes. */
    var turn = ++listing;
    var body = $('commissions-corps'), state = $('commissions-etat');
    clear(body);
    state.textContent = 'Chargement…';
    return Promise.all([send('/v1/pilotage/commissions', 'GET'), send('/v1/pilotage/reversements', 'GET')]).then(function (both) {
      var a = both[0], b = both[1];
      if (a.gone || b.gone || mine !== t.session() || turn !== listing) return false;
      /* Sans les deux réponses, on ne sait pas ce qui attend : aucun geste n'est proposé. */
      if (!a.ok || !b.ok || !Array.isArray(a.body.data) || !Array.isArray(b.body.data)) {
        var bad = !a.ok ? a : b;
        if (bad.offline) state.textContent = 'Pas de réseau. Réessayez dans un moment.';
        else if (bad.body && bad.body.rule === 'R16') state.textContent = PAY_REFUSALS.role;
        else state.textContent = 'Indisponible pour le moment. Réessayez plus tard.';
        return false;
      }
      var tasks = {};
      b.body.data.forEach(function (x) { tasks[x.fileId] = x; });
      var groupOf = function (c) {
        if (c.status === 'payee') return 'payee';
        if (c.status === 'facturee') return Object.prototype.hasOwnProperty.call(tasks, c.fileId) ? 'verser' : 'encaisser';
        return c.status === 'due' ? 'facturer' : 'prevue';
      };
      GROUPS.forEach(function (g) {
        var items = a.body.data.filter(function (c) { return groupOf(c) === g[0]; });
        if (!items.length) return;
        body.appendChild(el('h4', g[1] + ' (' + items.length + ')'));
        var ul = el('ul', null, 'liste');
        items.forEach(function (c) { ul.appendChild(line(c, g[0], tasks[c.fileId])); });
        body.appendChild(ul);
      });
      state.textContent = message || (a.body.data.length ? '' : 'Aucune commission pour le moment : elles naissent au compromis signé.');
      return true;
    });
  }
  return { report: report, commissions: commissions };
};
`;
