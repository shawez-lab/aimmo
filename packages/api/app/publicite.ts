/**
 * La publicité payante à l'écran de la direction (BR110) : le compte rendu de chaque campagne, jugée au mandat signé et
 * à l'acte ; proposer une campagne, valider ses budgets, la lancer et l'arrêter, par les routes de BR03
 * (`/v1/marketing/publicite`) [R587, R588, R589].
 * Script servi à part (`/app/publicite.js`), chargé au premier geste depuis l'écran « Attirer » [R201].
 * Le ciblage n'a que des communes et un rayon : aucun critère interdit pour le logement ne peut être saisi [R589]. Rien
 * n'est recalculé ni trié : chaque chiffre vient du serveur, dans l'ordre reçu [R588]. Lancer et arrêter ne partent
 * qu'au second appui. Chaque refus se dit en mots, jamais par un code ; une réponse perdue se dit incertaine. Tout texte
 * reçu est posé en texte.
 */

export const PUBLICITE_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  role: 'Seule la direction lit les campagnes, valide leurs budgets, les lance et les arrête.',
  invalid_body: 'La demande n’a pas pu être lue. Rechargez l’écran.',
  unknown_field: 'La demande n’a pas pu être lue. Rechargez l’écran.',
  bad_input: 'La demande n’a pas pu être lue. Rechargez l’écran.',
  bad_day: 'La demande n’a pas pu être lue. Rechargez l’écran.',
  bad_amount: 'La demande n’a pas pu être lue. Rechargez l’écran.',
  pas_depuis_une_route: 'Rien ne se publie depuis l’écran.',
  unknown: 'Cette campagne n’est plus rangée : relisez les campagnes.',
  conflict: 'Une autre décision vient de passer : relisez les campagnes, puis recommencez.',
  bad_platform: 'Choisissez une plateforme dans la liste.',
  bad_name: 'Le nom : de 3 à 80 caractères.',
  ciblage_invalide: 'Le ciblage : des communes et un rayon seulement.',
  critere_inconnu: 'Le ciblage : des communes et un rayon seulement.',
  critere_interdit: 'Ce critère est interdit pour une annonce de logement : des communes et un rayon seulement.',
  communes: 'Les communes : de 1 à 30 codes INSEE, chacun une seule fois (5 caractères, par exemple 21231).',
  rayon: 'Le rayon : vide, ou de 15 à 80 km.',
  bad_budget: 'Les budgets : en euros, plus de zéro, le budget total au moins égal au budget du jour.',
  en_cours: 'Cette campagne dépense en ce moment : arrêtez-la avant de valider de nouveaux budgets.',
  pause_en_attente: 'La plateforme n’a pas encore confirmé la pause : rien ne se valide ni ne se lance avant.',
  lancement_en_cours: 'La plateforme n’a pas encore répondu au lancement : attendez sa réponse.',
  sans_validation: 'Validez d’abord les budgets de cette campagne.',
  deja_lancee_ou_arretee: 'Ces budgets ont déjà servi : validez-en de nouveaux pour relancer.',
  seuil: 'La dépense passe déjà le seuil de coût par contact : rien ne repart avec ces budgets.',
  budget: 'Le budget total est déjà dépensé : rien ne repart avec ces budgets.',
  echec_lancement: 'La plateforme n’a pas confirmé le lancement : la campagne est arrêtée, rien n’est dépensé de plus.',
  arretee_au_lancement: 'La campagne a été arrêtée pendant son lancement : la pause est redemandée.',
  reponse_tardive: 'La plateforme a répondu trop tard : la campagne est arrêtée et sa pause redemandée.',
  pas_en_cours: 'Cette campagne n’est pas en cours : rien à arrêter.',
  pas_lancee: 'Cette campagne n’a jamais été lancée.',
  depense_sans_lancement: 'Cette campagne n’a jamais été lancée.',
  depense_hors_validation: 'La demande n’a pas pu être lue. Rechargez l’écran.',
  plafond: 'Le budget total dépasse le plafond réglé pour les campagnes réelles : baissez-le, ou faites relever le plafond.',
});

/** AU038 : le mode de la campagne, lu dans l'accusé de la plateforme. */
export const PUBLICITE_MODES: Readonly<Record<string, string>> = Object.freeze({
  essai: 'Mode essai : rien n’est payé.',
  reel: 'Mode réel : la plateforme dépense, dans les budgets validés et sous le plafond.',
});

/** AU038 : le dernier échec d'un appel à la plateforme, en mots, avec le geste à faire. */
export const PUBLICITE_FAILURES: Readonly<Record<string, string>> = Object.freeze({
  reconnecter: 'La connexion au compte publicitaire a expiré : reconnectez le compte du réseau.',
  acces: 'AIMMO n’a pas l’accès au compte publicitaire : donnez-lui l’accès depuis la plateforme.',
  refusee: 'La plateforme a refusé la campagne : corrigez-la, puis validez de nouveaux budgets.',
  lieu_inconnu: 'Une commune n’est pas encore connue de la plateforme : ajoutez-la aux lieux réglés, puis relancez.',
  rayon: 'Ce rayon est trop petit pour une annonce de logement sur cette plateforme : portez-le à 25 km au moins.',
  indisponible: 'La plateforme n’a pas répondu : réessayez dans un moment.',
  inconnue: 'La plateforme a répondu sans qu’on sache si la campagne est partie : vérifiez sur la plateforme.',
});

export const PUBLICITE_STEPS: Readonly<Record<string, string>> = Object.freeze({ lancement: 'Au lancement', pause: 'À la pause', depense: 'À la lecture de la dépense' });

/** Une écriture sans réponse, ou coupée par une panne du serveur, a pu passer : l'écran ne dit ni fait ni pas fait. */
export const PUBLICITE_LOST = 'La réponse n’est pas arrivée : rien n’est sûr. Relisez les campagnes avant de recommencer.';

export const PUBLICITE_PLATFORMS: Readonly<Record<string, string>> = Object.freeze({ google_ads: 'Google Ads', meta: 'Meta' });

export const PUBLICITE_STATES: Readonly<Record<string, string>> = Object.freeze({
  a_valider: 'À valider : rien ne se dépense avant la validation de ses budgets.',
  validee: 'Validée, pas encore lancée.',
  en_cours: 'En cours.',
  arretee: 'Arrêtée',
});

export const PUBLICITE_STOPS: Readonly<Record<string, string>> = Object.freeze({
  seuil: 'au seuil de coût par contact',
  budget: 'au budget total',
  direction: 'par la direction',
  echec_lancement: 'la plateforme n’a pas confirmé le lancement',
});

/** Le second appui demandé avant de lancer ou d'arrêter. */
export const PUBLICITE_CONFIRM: Readonly<Record<string, string>> = Object.freeze({
  lancer: 'Lancer engage les budgets validés. Appuyez sur « Confirmer : lancer » pour la lancer.',
  arreter: 'Arrêter demande la pause à la plateforme ; relancer demandera une validation nouvelle. Appuyez sur « Confirmer : arrêter ».',
});

/** Le script servi à part (`/app/publicite.js`). Il ne lit et n'écrit que `/v1/marketing/publicite` [R16]. */
export const PUBLICITE_SCRIPT = `'use strict';
globalThis.AIMMO_PUBLICITE = function (t) {
  var el = t.el, clear = t.clear, send = t.send, button = t.button;
  /* Saisir, choisir ou ouvrir un volet est un autre geste : il annule un « Confirmer » en attente. */
  function field(box, id, label, tag) {
    var f = t.field(box, id, label, tag);
    f.addEventListener('input', disarm);
    f.addEventListener('change', disarm);
    f.addEventListener('focus', disarm);
    return f;
  }
  function panel(title) {
    var d = el('details');
    d.addEventListener('toggle', disarm);
    d.appendChild(el('summary', title));
    return d;
  }
  var REFUSALS = ${JSON.stringify(PUBLICITE_REFUSALS)};
  var PLATFORMS = ${JSON.stringify(PUBLICITE_PLATFORMS)};
  var STATES = ${JSON.stringify(PUBLICITE_STATES)};
  var STOPS = ${JSON.stringify(PUBLICITE_STOPS)};
  var MODES = ${JSON.stringify(PUBLICITE_MODES)};
  var FAILURES = ${JSON.stringify(PUBLICITE_FAILURES)};
  var STEPS = ${JSON.stringify(PUBLICITE_STEPS)};
  var CONFIRM = ${JSON.stringify(PUBLICITE_CONFIRM)};
  var LOST = ${JSON.stringify(PUBLICITE_LOST)};
  var OFFLINE = 'Pas de réseau. Réessayez dans un moment.';
  var BASE = '/v1/marketing/publicite/campagnes';
  var ID = new RegExp('^[A-Za-z0-9_-]{1,64}$');
  var INSEE = new RegExp('^([0-9]{5}|2[AB][0-9]{3})$');
  var EUROS = new RegExp('^[0-9]{1,7}([.,][0-9]{1,2})?$');
  var root = null, out = null, status = null, reading = 0, busy = false, armed = null;
  function say(text) { if (status) status.textContent = text; }
  function why(res, fallback) {
    if (res.offline) return OFFLINE;
    var b = res.body || {};
    return REFUSALS[b.code] || fallback;
  }
  function whole(n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n && n >= 0; }
  /* Des centimes reçus, dits en euros : « 1 234,50 € ». Rien n'est arrondi ni recalculé. */
  function euros(c) {
    if (!whole(c)) return '—';
    var e = String(Math.floor(c / 100)), s = '', r = c % 100;
    while (e.length > 3) { s = '\\u202f' + e.slice(-3) + s; e = e.slice(0, -3); }
    return e + s + ',' + (r < 10 ? '0' : '') + r + '\\u00a0€';
  }
  /* « 1 234,5 » → 123450 ; zéro, un signe ou plus de deux décimales : refusé avant l'appel. */
  function centsOf(text) {
    var s = String(text || '').replace(/[\\s\\u00a0\\u202f]/g, '').replace(/€$/, '');
    if (!EUROS.test(s)) return null;
    var p = s.replace(',', '.').split('.'), d = (p[1] || '') + '00';
    var c = Number(p[0]) * 100 + Number(d.slice(0, 2));
    return c > 0 ? c : null;
  }
  /* Tout autre geste annule un « Confirmer » en attente. */
  function disarm() {
    if (armed) { armed.b.textContent = armed.label; armed = null; }
  }
  function confirmed(b, label, kind) {
    if (armed && armed.b === b) { disarm(); return true; }
    disarm();
    armed = { b: b, label: label };
    b.textContent = kind === 'lancer' ? 'Confirmer : lancer' : 'Confirmer : arrêter';
    say(CONFIRM[kind]);
    return false;
  }
  function act(fn) { return function () { disarm(); fn(); }; }
  function row(dl, k, v) { dl.appendChild(el('dt', k)); dl.appendChild(el('dd', v)); }
  function count(n) { return whole(n) ? String(n) : '—'; }
  function per(c, none) { return c === null ? none : euros(c); }
  function budgets(li, id, n) {
    var d = panel('Valider des budgets');
    d.appendChild(el('p', 'Rien ne se dépense sans eux. La campagne s’arrête seule au seuil de coût par contact ou au budget total.', 'doux'));
    var daily = field(d, 'pub-jour-' + n, 'Budget par jour, en euros');
    var total = field(d, 'pub-total-' + n, 'Budget total, en euros');
    var max = field(d, 'pub-seuil-' + n, 'Seuil de coût par contact, en euros');
    [daily, total, max].forEach(function (f) { f.setAttribute('inputmode', 'decimal'); f.setAttribute('maxlength', '12'); });
    d.appendChild(button('Valider ces budgets', act(function () {
      var a = centsOf(daily.value), b = centsOf(total.value), c = centsOf(max.value);
      if (a === null || b === null || c === null || b < a) { say(REFUSALS.bad_budget); return; }
      write(BASE + '/' + encodeURIComponent(id) + '/validation', { dailyBudgetCents: a, totalBudgetCents: b, maxCostPerContactCents: c }, 'Budgets validés : ' + euros(a) + ' par jour, ' + euros(b) + ' au total, seuil ' + euros(c) + ' par contact.', 'Les budgets ne sont pas validés.');
    })));
    li.appendChild(d);
  }
  function campaign(c, n) {
    var li = el('li');
    var name = typeof c.name === 'string' ? c.name : '';
    li.appendChild(el('h4', name + (PLATFORMS[c.platform] ? ' · ' + PLATFORMS[c.platform] : '')));
    var st = STATES[c.state] || 'État inconnu : relisez les campagnes.';
    if (c.state === 'arretee') st += STOPS[c.stopReason] ? ' ' + STOPS[c.stopReason] + '.' : '.';
    li.appendChild(el('p', st, c.state === 'arretee' ? 'alerte' : 'doux'));
    if (MODES[c.mode]) li.appendChild(el('p', MODES[c.mode], c.mode === 'reel' ? 'alerte' : 'doux'));
    var f = c.failure && typeof c.failure === 'object' ? c.failure : null;
    if (f) li.appendChild(el('p', (STEPS[f.step] || 'À un appel') + ' : ' + (FAILURES[f.code] || FAILURES.inconnue), 'alerte'));
    var dl = el('dl');
    row(dl, 'Dépense', euros(c.spendCents));
    row(dl, 'Contacts', count(c.contacts));
    if (whole(c.pendingArrivals) && c.pendingArrivals > 0) row(dl, 'Demandes pas encore rattachées à une fiche', String(c.pendingArrivals));
    row(dl, 'Mandats signés par ces contacts', count(c.mandates));
    row(dl, 'Actes', count(c.sales));
    row(dl, 'Coût par contact', per(c.costPerContactCents, 'pas encore de contact'));
    row(dl, 'Coût par mandat', per(c.costPerMandateCents, 'pas encore de mandat'));
    row(dl, 'Coût par acte', per(c.costPerSaleCents, 'pas encore d’acte'));
    row(dl, 'Seuil par contact', c.maxCostPerContactCents === null ? 'pas encore validé' : euros(c.maxCostPerContactCents));
    li.appendChild(dl);
    var id = String(c.id || '');
    if (!ID.test(id)) return li;
    if (c.state === 'validee') {
      var go = button('Lancer', function () {
        if (!confirmed(go, 'Lancer', 'lancer')) return;
        write(BASE + '/' + encodeURIComponent(id) + '/lancement', null, 'Campagne lancée : son mode et l’accusé de la plateforme se lisent dans la liste.', 'La campagne n’est pas lancée.');
      });
      li.appendChild(go);
    }
    if (c.state === 'en_cours') {
      var halt = button('Arrêter', function () {
        if (!confirmed(halt, 'Arrêter', 'arreter')) return;
        write(BASE + '/' + encodeURIComponent(id) + '/arret', null, 'Campagne arrêtée : la pause est demandée à la plateforme.', 'La campagne n’est pas arrêtée.');
      });
      li.appendChild(halt);
    }
    if (c.state !== 'en_cours') budgets(li, id, n);
    return li;
  }
  function render(list) {
    clear(out);
    disarm();
    if (!list.length) { out.appendChild(el('p', 'Aucune campagne pour le moment.', 'doux')); return; }
    out.appendChild(el('p', 'Chaque campagne est jugée aux mandats signés et aux actes de ses contacts, pas aux clics.', 'doux'));
    var ul = el('ul', null, 'liste');
    list.forEach(function (c, i) { if (c && typeof c === 'object') ul.appendChild(campaign(c, i)); });
    out.appendChild(ul);
  }
  /* Seule la dernière lecture dessine : une réponse arrivée après une autre lecture, ou après la sortie, ne montre rien. */
  function read(message) {
    var turn = ++reading, mine = t.session();
    clear(out);
    disarm();
    say('Chargement…');
    return send(BASE, 'GET').then(function (res) {
      if (res.gone || turn !== reading || mine !== t.session()) return false;
      if (!res.ok || !res.body || !Array.isArray(res.body.data)) { say((message ? message + ' ' : '') + why(res, 'Les campagnes ne se lisent pas pour le moment.')); return false; }
      render(res.body.data);
      say(message || '');
      return true;
    });
  }
  /* Une seule écriture à la fois ; après une réponse sûre, les campagnes sont relues. */
  function write(url, body, done, fallback) {
    if (busy) return Promise.resolve(false);
    busy = true;
    var mine = t.session();
    say('Envoi…');
    return send(url, 'POST', body === null ? undefined : body).then(function (x) {
      busy = false;
      if (x.gone || mine !== t.session()) return false;
      if (x.offline || !x.body || x.status >= 500) { say(LOST); return false; }
      if (!x.ok) { say(why(x, fallback)); return false; }
      return read(done);
    }, function () { busy = false; say(LOST); return false; });
  }
  function propose(inner) {
    var d = panel('Proposer une campagne');
    d.appendChild(el('p', 'Pour le logement, le ciblage ne porte que sur des communes et un rayon, pour tous les adultes. Elle ne dépense rien avant la validation de ses budgets.', 'doux'));
    var platform = field(d, 'pub-plateforme', 'Plateforme', 'select');
    var o = el('option', 'Choisir…');
    o.setAttribute('value', '');
    platform.appendChild(o);
    Object.keys(PLATFORMS).forEach(function (k) { var x = el('option', PLATFORMS[k]); x.setAttribute('value', k); platform.appendChild(x); });
    var name = field(d, 'pub-nom', 'Nom de la campagne, de 3 à 80 caractères');
    name.setAttribute('maxlength', '80');
    var communes = field(d, 'pub-communes', 'Communes : codes INSEE, séparés par des espaces ou des virgules', 'textarea');
    var radius = field(d, 'pub-rayon', 'Rayon en km, de 15 à 80 (facultatif)');
    radius.setAttribute('inputmode', 'numeric');
    radius.setAttribute('maxlength', '2');
    d.appendChild(button('Proposer cette campagne', act(function () {
      var p = String(platform.value || ''), n = String(name.value || '').trim().replace(/\\s+/g, ' ');
      var codes = String(communes.value || '').toUpperCase().split(/[\\s,;]+/).filter(function (x) { return x !== ''; });
      var r = String(radius.value || '').trim();
      if (!PLATFORMS[p]) { say(REFUSALS.bad_platform); return; }
      if (n.length < 3 || n.length > 80) { say(REFUSALS.bad_name); return; }
      var seen = {};
      if (codes.length < 1 || codes.length > 30 || !codes.every(function (x) { var fresh = INSEE.test(x) && !seen[x]; seen[x] = true; return fresh; })) { say(REFUSALS.communes); return; }
      if (r !== '' && (!/^[0-9]{2}$/.test(r) || Number(r) < 15 || Number(r) > 80)) { say(REFUSALS.rayon); return; }
      var targeting = { communes: codes };
      if (r !== '') targeting.rayonKm = Number(r);
      write(BASE, { platform: p, name: n, targeting: targeting }, 'Campagne proposée : elle attend la validation de ses budgets.', 'La campagne n’est pas proposée.');
    })));
    inner.appendChild(d);
  }
  function show(inner) {
    if (root !== inner) {
      root = inner;
      clear(inner);
      status = el('p', null, 'etat');
      status.setAttribute('role', 'status');
      inner.appendChild(status);
      out = el('div');
      inner.appendChild(out);
      propose(inner);
    }
    return read();
  }
  return { show: show };
};
`;
