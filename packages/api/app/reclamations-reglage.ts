import { DEFAULT_COMPLAINT_RESPONSE_DAYS, mediatorOfferText } from '../../core/src/securite/reclamations.ts';

/**
 * BR70 · Le délai de réponse aux réclamations et le médiateur, réglés par la direction (HX58, routes de BR01 et BR70).
 * Posé sous « Engagements de service » sur l'écran du réseau, comme les scénarios (BR57) : script servi à part
 * (`/app/reclamations-reglage.js`), chargé au premier geste, sans rien ajouter au script de l'application [R201].
 *
 * L'écran relit le réglage en service : sans réglage, rien n'est inventé, le délai de 30 jours est dit et la proposition
 * du médiateur ne part pas [R606, R607]. La direction range une nouvelle version ; l'ancienne reste [R17]. C'est le
 * serveur qui relit tout ; la saisie illisible est arrêtée avant l'appel. Chaque refus est dit en mots [R16], une réponse
 * perdue est dite incertaine et le réglage relu. Tout texte reçu est posé en texte, un champ mal formé n'est pas dit.
 *
 * Jamais vu : avant de ranger, la direction lit mot pour mot le texte que le client recevra avec ce médiateur, écrit par
 * le même code que celui qui l'envoie, et combien de réclamations attendent ce réglage pour que la proposition parte.
 */

/** Le délai admis par le cœur, en jours. */
export const RECLAMATIONS_REGLAGE_MAX_DAYS = 60;

/** Chaque refus du cœur, dit en mots ; un refus inconnu a sa phrase générale, jamais son code. */
export const RECLAMATIONS_REGLAGE_REFUSALS = Object.freeze({
  role: 'Ce n’est pas dans vos droits : seule la direction règle les réclamations.',
  bad_days: `Le délai de réponse : un nombre entier de jours, de 1 à ${RECLAMATIONS_REGLAGE_MAX_DAYS}.`,
  bad_mediator: 'Le nom du médiateur : de 1 à 120 caractères.',
  bad_site: 'Le site du médiateur : une adresse qui commence par https://, 200 caractères au plus.',
  invalid_body: 'La saisie n’est pas lisible.',
});

export const RECLAMATIONS_REGLAGE_LOST = 'La réponse n’est pas arrivée : rien n’est sûr. Le réglage est relu, vérifiez-le avant de recommencer.';
export const RECLAMATIONS_REGLAGE_OFFLINE = 'Pas de réseau. Réessayez dans un moment.';

/** Le texte de la proposition, écrit par le code du cœur, avec deux marques à remplacer à l'écran [R607]. */
const OFFER_TEMPLATE = mediatorOfferText({ name: '%%NOM%%', site: '%%SITE%%' });

/** Le script servi à part. Il ne lit et n'écrit que `/v1/securite/reclamations/reglage` [R16]. */
export const RECLAMATIONS_REGLAGE_SCRIPT = `'use strict';
globalThis.AIMMO_RECLAMATIONS_REGLAGE = function (t) {
  var el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field;
  var REFUSALS = ${JSON.stringify(RECLAMATIONS_REGLAGE_REFUSALS)};
  var TEMPLATE = ${JSON.stringify(OFFER_TEMPLATE)};
  var DEFAULT_DAYS = ${DEFAULT_COMPLAINT_RESPONSE_DAYS}, MAX_DAYS = ${RECLAMATIONS_REGLAGE_MAX_DAYS};
  var PATH = '/v1/securite/reclamations/reglage';
  var OFFLINE = ${JSON.stringify(RECLAMATIONS_REGLAGE_OFFLINE)}, LOST = ${JSON.stringify(RECLAMATIONS_REGLAGE_LOST)};
  var box = null, status = null, busy = false, turn = 0;
  function own(o, k) { return typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : null; }
  function why(res, fallback) {
    if (res.offline) return OFFLINE;
    return own(REFUSALS, res.body && res.body.code) || fallback;
  }
  function say(text) { if (status) status.textContent = text; }
  function str(v, max) { return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null; }
  function count(v) { return typeof v === 'number' && Math.floor(v) === v && v >= 0 ? v : null; }
  function day(iso) {
    if (typeof iso !== 'string') return null;
    var d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    try { return d.toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' }); } catch (e) { return null; }
  }
  /* Le texte du client, tel que le code l'écrit : les deux marques remplacées en un seul passage. */
  function offer(name, site) { return TEMPLATE.replace(/%%(NOM|SITE)%%/g, function (_m, k) { return k === 'NOM' ? name : site; }); }
  /* La saisie, contrôlée comme le serveur la contrôlera ; illisible : le refus en mots, et rien ne part. */
  function read(f) {
    var d = String(f.days.value || '').trim();
    if (!/^\\d{1,2}$/.test(d) || Number(d) < 1 || Number(d) > MAX_DAYS) return { refusal: REFUSALS.bad_days };
    var name = String(f.name.value || '').trim();
    if (name === '' || name.length > 120) return { refusal: REFUSALS.bad_mediator };
    var site = String(f.site.value || '').trim();
    if (site.length > 200 || !/^https:\\/\\/[^\\s\\/@:?#]+(:\\d+)?([\\/?#]\\S*)?$/.test(site)) return { refusal: REFUSALS.bad_site };
    return { value: { responseDays: Number(d), mediatorName: name, mediatorSite: site } };
  }
  function render(data) {
    var version = count(data.version), days = count(data.responseDays), waiting = count(data.waitingForMediator);
    var m = data.mediator && typeof data.mediator === 'object' ? data.mediator : null;
    var name = m ? str(m.name, 120) : null, site = m ? str(m.site, 200) : null;
    var now = el('div');
    if (data.version === null) now.appendChild(el('p', 'Aucun réglage rangé : le délai de réponse est de ' + DEFAULT_DAYS + ' jours, et aucun médiateur n’est réglé. La proposition du médiateur ne part pas : rien n’est inventé.'));
    else {
      if (version !== null) now.appendChild(el('p', 'Version ' + version + (day(data.setAt) ? ', rangée le ' + day(data.setAt) : '') + '.', 'doux'));
      if (days !== null) now.appendChild(el('p', 'Délai de réponse : ' + days + (days > 1 ? ' jours' : ' jour') + '.'));
      if (name && site) now.appendChild(el('p', 'Médiateur : ' + name + ', ' + site + '.'));
    }
    if (waiting !== null && waiting > 0) now.appendChild(el('p', waiting === 1 ? '1 réclamation attend un médiateur : la proposition partira au passage qui suit le réglage.' : waiting + ' réclamations attendent un médiateur : la proposition partira au passage qui suit le réglage.', 'alerte'));
    var text = str(data.offerText, 2000);
    if (text) {
      now.appendChild(el('h5', 'Le texte que reçoit le client'));
      now.appendChild(el('p', text, 'note'));
    }
    box.appendChild(now);
    var form = el('div');
    form.appendChild(el('h5', 'Ranger une nouvelle version'));
    form.appendChild(el('p', 'L’ancienne version reste au journal. Le délai vaut pour les réclamations rangées ensuite.', 'doux'));
    var f = {
      days: field(form, 'reclamations-reglage-delai', 'Délai de réponse, en jours (1 à ' + MAX_DAYS + ')'),
      name: field(form, 'reclamations-reglage-nom', 'Nom du médiateur de la consommation'),
      site: field(form, 'reclamations-reglage-site', 'Site du médiateur (https://…)'),
    };
    f.days.setAttribute('inputmode', 'numeric');
    f.days.value = String(days !== null ? days : DEFAULT_DAYS);
    if (name) f.name.value = name;
    if (site) f.site.value = site;
    var preview = el('div');
    var read1 = null;
    /* Une saisie changée après la lecture retire « Ranger » : on ne range que le texte lu. */
    function stale() { if (read1) { read1 = null; clear(preview); } }
    for (var k in f) { f[k].addEventListener('input', stale); f[k].addEventListener('change', stale); }
    form.appendChild(button('Lire le texte du client', function () {
      var r = read(f);
      clear(preview);
      read1 = null;
      if (r.refusal) { say(r.refusal); return; }
      say('');
      read1 = r.value;
      preview.appendChild(el('h5', 'Ce que lira le client, mot pour mot'));
      preview.appendChild(el('p', offer(r.value.mediatorName, r.value.mediatorSite), 'note'));
      preview.appendChild(button('Ranger cette version', function () { save(f, preview); }));
    }));
    form.appendChild(preview);
    box.appendChild(form);
    function save() {
      if (busy || !read1) return;
      var r = read(f);
      if (r.refusal || r.value.responseDays !== read1.responseDays || r.value.mediatorName !== read1.mediatorName || r.value.mediatorSite !== read1.mediatorSite) { stale(); say('La saisie a changé : lisez de nouveau le texte du client.'); return; }
      busy = true;
      var mine = t.session();
      say('Envoi…');
      send(PATH, 'POST', r.value).then(function (x) {
        busy = false;
        if (x.gone || mine !== t.session()) return;
        if (x.offline || !x.body || x.status >= 500) { load(LOST); return; }
        if (!x.ok) { say(why(x, 'Le réglage n’est pas rangé.')); return; }
        load(typeof x.body.version === 'number' ? 'Version ' + x.body.version + ' rangée : l’ancienne reste au journal.' : 'Réglage rangé.');
      });
    }
  }
  function load(message) {
    var mine = t.session(), me = ++turn;
    clear(box);
    say(message ? message + ' Relecture…' : 'Chargement…');
    return send(PATH, 'GET').then(function (res) {
      if (res.gone || mine !== t.session() || me !== turn) return false;
      var data = res.ok && res.body && res.body.data && typeof res.body.data === 'object' ? res.body.data : null;
      if (!data) { say((message ? message + ' ' : '') + why(res, 'Réglage indisponible pour le moment.')); return false; }
      render(data);
      say(message || '');
      return true;
    });
  }
  function show(inner) {
    clear(inner);
    box = el('div');
    status = el('p', '', 'etat');
    status.setAttribute('role', 'status');
    inner.appendChild(status);
    inner.appendChild(box);
    return load('');
  }
  return { show: show };
};
`;
