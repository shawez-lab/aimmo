/**
 * Le coût complet de l'agent moyen à l'écran de la direction (BR108) : pour un mois fini de Paris, la part du réseau,
 * le coût complet par poste, la provision et la marge, si la part couvre le coût, et la part du réseau qui le couvre
 * tout juste ; la direction donne un poste à chaque facture du mois qui n'en a pas, et règle la provision et la marge
 * pour un mois à venir, par les routes de BR02 (`/v1/recrutement/cout-agent`) [R623, R624, R625].
 * Script servi à part (`/app/cout-agent.js`), chargé au premier geste depuis la partie « Phases et régions » [R201].
 * Aucun montant ne se saisit : chaque chiffre vient du serveur, tel quel, rien n'est recalculé ici [R624]. La moyenne
 * seule : aucun nom ni chiffre d'agent, aucun classement [R625, R14]. Chaque refus se dit en mots, jamais par un code ;
 * une réponse perdue se dit incertaine. Tout texte reçu est posé en texte.
 */

export const COUT_AGENT_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  role: 'Seule la direction lit et règle le coût de l’agent moyen.',
  invalid_body: 'La demande n’a pas pu être lue. Rechargez l’écran.',
  unknown_field: 'La demande n’a pas pu être lue. Rechargez l’écran.',
  bad_shape: 'La demande n’a pas pu être lue. Rechargez l’écran.',
  amount_refused: 'Aucun montant ne se saisit : il est calculé à partir des factures et des dossiers.',
  bad_month: 'Choisissez un mois dans la liste.',
  month_not_finished: 'Ce mois n’est pas fini : seuls les mois finis se lisent.',
  mois_passe: 'Un réglage ne vaut jamais pour un mois passé : choisissez ce mois-ci ou un mois à venir.',
  bad_bp: 'Provision et marge : de 0 à 100 %, deux décimales au plus.',
  bad_reason: 'La raison : de 3 à 200 caractères.',
  bad_category: 'Choisissez un poste dans la liste.',
  not_found: 'Cette facture n’est plus rangée : relisez le mois.',
  deja_classee: 'Cette facture a déjà ce poste : relisez le mois.',
  conflit: 'Une autre décision vient de passer : relisez le mois, puis recommencez.',
});

/** Une écriture sans réponse, ou coupée par une panne du serveur, a pu passer : l'écran ne dit ni fait ni pas fait. */
export const COUT_AGENT_LOST = 'La réponse n’est pas arrivée : rien n’est sûr. Relisez le mois avant de recommencer.';

/** Les postes, dans l'ordre de l'Offre aux agents, et la sortie « hors coût des agents » [R623]. */
export const COUT_AGENT_POSTES: Readonly<Record<string, string>> = Object.freeze({
  ia: 'Intelligence artificielle',
  clients_apportes: 'Clients apportés',
  diffusion: 'Diffusion',
  accompagnement: 'Accompagnement',
  conformite: 'Conformité',
  hors_agents: 'Hors coût des agents',
});

/** Le script servi à part (`/app/cout-agent.js`). Il ne lit et n'écrit que `/v1/recrutement/cout-agent` [R16]. */
export const COUT_AGENT_SCRIPT = `'use strict';
globalThis.AIMMO_COUT_AGENT = function (t) {
  var el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field;
  var REFUSALS = ${JSON.stringify(COUT_AGENT_REFUSALS)};
  var POSTES = ${JSON.stringify(COUT_AGENT_POSTES)};
  var LOST = ${JSON.stringify(COUT_AGENT_LOST)};
  var OFFLINE = 'Pas de réseau. Réessayez dans un moment.';
  var BASE = '/v1/recrutement/cout-agent';
  var MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  var MONTH = new RegExp('^[0-9]{4}-(0[1-9]|1[0-2])$');
  var ID = new RegExp('^[A-Za-z0-9_-]{1,64}$');
  var PERCENT = new RegExp('^[0-9]{1,3}([.,][0-9]{1,2})?$');
  var root = null, out = null, status = null, picker = null, reading = 0, busy = false;
  function say(text) { if (status) status.textContent = text; }
  function why(res, fallback) {
    if (res.offline) return OFFLINE;
    var b = res.body || {};
    return REFUSALS[b.code] || fallback;
  }
  function label(m) { return MONTH.test(m) ? MONTHS[Number(m.slice(5)) - 1] + ' ' + m.slice(0, 4) : ''; }
  function of(m) { var n = label(m); return (/^[aeiou]/.test(n) ? 'd’' : 'de ') + n; }
  function today() {
    try { return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }).slice(0, 7); } catch (e) { return new Date().toISOString().slice(0, 7); }
  }
  /* Douze mois depuis celui de Paris : vers le passé pour lire (mois finis), vers l'avenir pour régler. */
  function months(step) {
    var now = today(), y = Number(now.slice(0, 4)), m = Number(now.slice(5, 7)), list = [];
    if (step > 0) list.push(now);
    while (list.length < 12) {
      m += step;
      if (m === 0) { m = 12; y -= 1; }
      if (m === 13) { m = 1; y += 1; }
      list.push(y + '-' + (m < 10 ? '0' : '') + m);
    }
    return list;
  }
  function whole(n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n; }
  /* Des centimes reçus, dits en euros : « 12 345,67 € ». Rien n'est arrondi ni recalculé. */
  function euros(c) {
    if (!whole(c)) return '—';
    var neg = c < 0, a = Math.abs(c), e = String(Math.floor(a / 100)), s = '';
    while (e.length > 3) { s = '\\u202f' + e.slice(-3) + s; e = e.slice(0, -3); }
    var r = a % 100;
    return (neg ? '−' : '') + e + s + ',' + (r < 10 ? '0' : '') + r + '\\u00a0€';
  }
  /* Des points de base reçus, dits en pour cent : 1250 → « 12,5 % ». */
  function pct(bp) {
    if (!whole(bp)) return '—';
    var r = bp % 100, d = r === 0 ? '' : ',' + (r < 10 ? '0' + r : String(r).replace(/0$/, ''));
    return Math.floor(bp / 100) + d + '\\u00a0%';
  }
  /* « 12,5 » → 1250 ; tout autre texte, ou plus de 100 %, est refusé avant l'appel. */
  function bpOf(text) {
    var s = String(text || '').trim();
    if (!PERCENT.test(s)) return null;
    var p = s.replace(',', '.').split('.'), d = (p[1] || '') + '00';
    var bp = Number(p[0]) * 100 + Number(d.slice(0, 2));
    return bp >= 0 && bp <= 10000 ? bp : null;
  }
  function row(dl, k, v) { dl.appendChild(el('dt', k)); dl.appendChild(el('dd', v)); }
  function render(v) {
    clear(out);
    if (!v || !MONTH.test(String(v.month)) || !v.costs || typeof v.costs !== 'object') { say('Le coût de l’agent moyen ne se lit pas pour le moment.'); return; }
    out.appendChild(el('h4', 'Mois ' + of(v.month)));
    var missing = Array.isArray(v.missing) ? v.missing : [];
    var lines = v.lines && typeof v.lines === 'object' ? v.lines : {};
    var unclassified = (Array.isArray(lines.unclassified) ? lines.unclassified : []).filter(function (id) { return typeof id === 'string' && ID.test(id); });
    if (v.complete !== true) {
      out.appendChild(el('p', 'Mois incomplet : il n’est jamais dit couvert.', 'alerte'));
      if (missing.indexOf('reglage') >= 0) out.appendChild(el('p', 'Aucun réglage de provision et de marge ne vaut pour ce mois.', 'alerte'));
      if (missing.indexOf('factures_non_classees') >= 0) out.appendChild(el('p', unclassified.length > 1 ? unclassified.length + ' factures du mois n’ont pas de poste.' : 'Une facture du mois n’a pas de poste.', 'alerte'));
    } else {
      out.appendChild(el('p', v.covered === true ? 'La part du réseau couvre le coût complet de l’agent moyen, marge comprise.' : 'La part du réseau ne couvre pas le coût complet de l’agent moyen, marge comprise.', v.covered === true ? 'compte' : 'alerte'));
    }
    /* Jamais vu : la part du réseau qui couvre tout juste le coût, sur les coûts réels du mois [R625]. */
    if (v.breakEvenUnreachable === true) out.appendChild(el('p', 'Même tous les honoraires au réseau ne couvriraient pas le coût de ce mois.', 'alerte'));
    else if (whole(v.breakEvenNetworkBp)) out.appendChild(el('p', 'Seuil : ' + pct(v.breakEvenNetworkBp) + ' des honoraires au réseau couvrent tout juste le coût, marge comprise' + (whole(v.networkBp) ? ' ; ce mois, le réseau en a gardé ' + pct(v.networkBp) + '.' : '.')));
    else out.appendChild(el('p', 'Aucun honoraire encaissé ce mois : pas de seuil.', 'doux'));
    var dl = el('dl');
    row(dl, 'Agents présents', whole(v.agentsPresent) && v.agentsPresent >= 0 ? String(v.agentsPresent) : '—');
    row(dl, 'Honoraires encaissés, hors taxe', euros(v.feesCents));
    row(dl, 'Part du réseau', euros(v.networkShareCents));
    Object.keys(POSTES).forEach(function (k) { if (k in v.costs) row(dl, POSTES[k], euros(v.costs[k])); });
    row(dl, 'Provision de fin de contrat', euros(v.provisionCents));
    row(dl, 'Coût complet', euros(v.fullCostCents));
    row(dl, 'Marge', euros(v.marginCents));
    row(dl, 'À couvrir', euros(v.requiredCents));
    if (v.averageAgent && typeof v.averageAgent === 'object') {
      row(dl, 'Agent moyen : part du réseau', euros(v.averageAgent.networkShareCents));
      row(dl, 'Agent moyen : à couvrir', euros(v.averageAgent.requiredCents));
    }
    out.appendChild(dl);
    if (whole(v.aiMeasuredCents)) out.appendChild(el('p', 'IA mesurée message par message : ' + euros(v.aiMeasuredCents) + ', pour comparer aux factures ; hors calcul.', 'doux'));
    var st = v.settings;
    if (st && typeof st === 'object' && MONTH.test(String(st.validFrom))) out.appendChild(el('p', 'Réglage de ce mois, depuis ' + label(st.validFrom) + ' : provision ' + pct(st.provisionBp) + ' des parts des agents, marge ' + pct(st.marginBp) + ' du coût complet.', 'doux'));
    if (unclassified.length) {
      out.appendChild(el('h4', 'Factures sans poste'));
      var ul = el('ul', null, 'liste');
      unclassified.forEach(function (id, i) {
        var li = el('li');
        li.appendChild(el('p', 'Facture ' + id));
        var sel = field(li, 'cout-poste-' + i, 'Son poste', 'select');
        var o = el('option', 'Choisir…');
        o.setAttribute('value', '');
        sel.appendChild(o);
        Object.keys(POSTES).forEach(function (k) { var x = el('option', POSTES[k]); x.setAttribute('value', k); sel.appendChild(x); });
        li.appendChild(button('Donner ce poste à la facture ' + id, function () {
          var c = String(sel.value || '');
          if (!POSTES[c]) { say(REFUSALS.bad_category); return; }
          write(BASE + '/factures/' + encodeURIComponent(id) + '/poste', { category: c }, 'Poste rangé pour la facture ' + id + ' : ' + POSTES[c] + '.', 'Le poste n’est pas rangé.');
        }));
        ul.appendChild(li);
      });
      out.appendChild(ul);
    }
  }
  /* Seule la dernière lecture dessine : une réponse arrivée après une autre lecture, ou après la sortie, ne montre rien. */
  function read(m, message) {
    if (!MONTH.test(String(m))) { say(REFUSALS.bad_month); return Promise.resolve(false); }
    var turn = ++reading, mine = t.session();
    clear(out);
    say('Chargement…');
    return send(BASE + '?mois=' + encodeURIComponent(m), 'GET').then(function (res) {
      if (res.gone || turn !== reading || mine !== t.session()) return false;
      if (!res.ok || !res.body || !res.body.data) { say((message ? message + ' ' : '') + why(res, 'Le coût de l’agent moyen ne se lit pas pour le moment.')); return false; }
      render(res.body.data);
      say(message || '');
      return true;
    });
  }
  /* Une seule écriture à la fois ; après une réponse sûre, le mois choisi à l'instant est relu. */
  function write(url, body, done, fallback) {
    if (busy) return Promise.resolve(false);
    busy = true;
    var mine = t.session();
    say('Envoi…');
    return send(url, 'POST', body).then(function (x) {
      busy = false;
      if (x.gone || mine !== t.session()) return false;
      if (x.offline || !x.body || x.status >= 500) { say(LOST); return false; }
      if (!x.ok) { say(why(x, fallback)); return false; }
      return read(picker.value, done);
    }, function () { busy = false; say(LOST); return false; });
  }
  function settings(inner) {
    var d = el('details');
    d.appendChild(el('summary', 'Régler la provision et la marge'));
    d.appendChild(el('p', 'Un réglage vaut à partir du mois choisi, jamais pour un mois passé ; il ne s’efface pas, un nouveau le remplace.', 'doux'));
    var from = field(d, 'cout-depuis', 'À partir de', 'select');
    months(1).forEach(function (m) { var o = el('option', label(m)); o.setAttribute('value', m); from.appendChild(o); });
    from.value = today();
    var prov = field(d, 'cout-provision', 'Provision de fin de contrat, en % des parts des agents');
    var marg = field(d, 'cout-marge', 'Marge, en % du coût complet');
    [prov, marg].forEach(function (f) { f.setAttribute('inputmode', 'decimal'); f.setAttribute('maxlength', '6'); });
    var reason = field(d, 'cout-raison', 'La raison, de 3 à 200 caractères', 'textarea');
    reason.setAttribute('maxlength', '200');
    d.appendChild(button('Ranger ce réglage', function () {
      var m = String(from.value || ''), p = bpOf(prov.value), g = bpOf(marg.value);
      var text = String(reason.value || '').trim().replace(/\\s+/g, ' ');
      if (!MONTH.test(m) || m < today()) { say(REFUSALS.mois_passe); return; }
      if (p === null || g === null) { say(REFUSALS.bad_bp); return; }
      if (text.length < 3 || text.length > 200) { say(REFUSALS.bad_reason); return; }
      write(BASE + '/reglages', { validFrom: m, provisionBp: p, marginBp: g, reason: text }, 'Réglage rangé à partir ' + of(m) + ' : provision ' + pct(p) + ', marge ' + pct(g) + '.', 'Le réglage n’est pas rangé.');
    }));
    inner.appendChild(d);
  }
  function show(inner) {
    if (root !== inner) {
      root = inner;
      clear(inner);
      var list = months(-1);
      picker = field(inner, 'cout-mois', 'Le mois fini à lire', 'select');
      list.forEach(function (m) { var o = el('option', label(m)); o.setAttribute('value', m); picker.appendChild(o); });
      picker.value = list[0];
      inner.appendChild(button('Lire ce mois', function () { read(picker.value); }));
      status = el('p', null, 'etat');
      status.setAttribute('role', 'status');
      inner.appendChild(status);
      out = el('div');
      inner.appendChild(out);
      settings(inner);
    }
    return read(picker.value);
  }
  return { show: show };
};
`;
