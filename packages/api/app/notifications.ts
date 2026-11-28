/**
 * « Mes notifications » sur l'accueil de l'agent (BR67, HX27), par les routes de BR66 : `GET` et `POST
 * /v1/notifications/reglages`, `GET /v1/notifications`, `GET /v1/notifications/envois/<id>` [R16, R412, R413, R415].
 *
 * Rien n'est lu au chargement de l'accueil : le bloc n'arrive qu'au geste, ou à l'ouverture du lien d'une notification
 * (`/notifications/<envoi>`, renvoyé par le Worker vers `/app/#envoi=<envoi>`, sans rien lire). Ouvert par le lien, le
 * bloc montre d'abord ce que la notification annonçait, puis retire l'envoi de la barre d'adresse. L'agent règle ses
 * heures calmes, dites en heures et rangées en minutes du jour, et le niveau de chaque sorte ; le contact chaud est dit,
 * jamais réglable, et n'est jamais envoyé dans les réglages [R412]. La liste dit la sorte, l'état et la date en mots,
 * dans l'ordre du serveur, et ouvre la fiche en un geste. Chaque refus se dit en mots, jamais par un code ; une écriture
 * sans réponse est dite incertaine. Script servi à part (`/app/notifications.js`), chargé au premier geste [R201]. Tout
 * texte reçu est posé en texte ; un champ mal formé n'est pas dit. Rien n'est envoyé d'ici.
 */

/** Les sortes, en mots. */
export const NOTIFICATIONS_KIND_LABELS: Readonly<Record<string, string>> = Object.freeze({
  contact_chaud: 'Contact chaud à rappeler',
  client_ecrit: 'Message d’un client',
  rendez_vous: 'Rendez-vous',
  piece_recue: 'Pièce reçue',
  tache: 'Tâche à faire',
  info: 'Information',
});

/** Les niveaux d'une sorte réglable, en mots : le rythme de chaque groupe [R414]. */
export const NOTIFICATIONS_LEVEL_LABELS: Readonly<Record<string, string>> = Object.freeze({
  haute: 'Haute : un envoi par quart d’heure au plus',
  normale: 'Normale : un envoi par heure au plus',
  basse: 'Basse : un envoi par jour',
  coupee: 'Coupée : rien n’arrive au téléphone',
});

/** L'état d'une notification, en mots. */
export const NOTIFICATIONS_STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  a_envoyer: 'à envoyer',
  en_envoi: 'en cours d’envoi',
  envoyee: 'envoyée',
  sans_appareil: 'aucun téléphone relié',
  remplacee: 'dite par une autre',
  annulee: 'annulée',
});

/** Le contact chaud, dit et jamais réglable [R412, R413]. */
export const NOTIFICATIONS_HOT_LINE = 'Contact chaud à rappeler : part toujours tout de suite, sauf en heures calmes ; il ne se coupe pas.';

/** Les heures calmes, dites [R413]. */
export const NOTIFICATIONS_QUIET_LINE = 'Pendant vos heures calmes et tout le dimanche, rien ne part, sauf pour une personne qui vient de vous écrire ; le reste part à la fin des heures calmes.';

/** Chaque refus, dit en mots [R16, R412, R413]. */
export const NOTIFICATIONS_SCREEN_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  role: 'Les notifications se règlent et se relisent par l’agent lui-même.',
  not_self: 'Seul un agent en activité dans ce réseau règle et relit ses notifications.',
  invalid_quiet: 'Choisissez l’heure de début et de fin des heures calmes.',
  invalid_level: 'Choisissez un niveau pour chaque sorte.',
  hot_fixed: 'Le contact chaud ne se règle pas : il part toujours tout de suite.',
  unknown: 'Cette notification n’est plus parmi les vôtres.',
  invalid_body: 'La demande n’a pas pu être lue. Rechargez l’écran.',
  unexpected_field: 'La demande n’a pas pu être lue. Rechargez l’écran.',
});

/** Une écriture partie sans réponse : les réglages ont pu être rangés. */
export const NOTIFICATIONS_UNSURE = 'La réponse n’est pas arrivée : vos réglages sont peut-être rangés. Rouvrez le bloc pour les relire.';

export const NOTIFICATIONS_HOME_HTML = `<button id="notifications-ouvrir" type="button" class="secondaire rangee">Mes notifications</button>
<p id="notifications-etat" class="etat" role="status"></p>
<div id="notifications-corps"></div>
`;

/** Le chargeur, dans l'application : le script n'arrive qu'au premier geste ou par le lien d'une notification. */
export const NOTIFICATIONS_JS = `
  /* ---------- HX27 : « Mes notifications » (BR67), chargé au geste ou par le lien [R201]. ---------- */
  var notifTool = null, notifBusy = false;
  function wipeNotifications() { if (notifTool) notifTool.wipe(); clear($('notifications-corps')); $('notifications-etat').textContent = ''; }
  function openNotifications() {
    if (!currentKey || notifBusy) return;
    if (notifTool) return notifTool.show();
    notifBusy = true;
    var mine = session, s = el('script');
    $('notifications-etat').textContent = 'Chargement…';
    s.setAttribute('src', '/app/notifications.js');
    s.addEventListener('load', function () {
      notifBusy = false;
      var make = globalThis.AIMMO_NOTIFICATIONS;
      if (typeof make === 'function') notifTool = make({ $: $, el: el, clear: clear, send: send, date: date, hour: hour, openFiche: openFiche });
      if (mine !== session) $('notifications-etat').textContent = '';
      else if (notifTool) notifTool.show();
      else $('notifications-etat').textContent = 'Pas de réseau. Réessayez dans un moment.';
    });
    s.addEventListener('error', function () { notifBusy = false; $('notifications-etat').textContent = mine === session ? 'Pas de réseau. Réessayez dans un moment.' : ''; });
    $('accueil').appendChild(s);
  }
  // DS007 · l'écran des outils écrit son adresse en s'ouvrant : celle du lien d'envoi est remise aussitôt sur cette entrée,
  // pour que le détail la lise encore, une fois, avant de la retirer [R225].
  function notifLink() {
    var h = typeof location === 'undefined' ? '' : String(location.hash);
    if (h.indexOf('#envoi=') !== 0) return;
    show('outils');
    try { history.replaceState(history.state, '', h); } catch (e) { /* sans historique */ }
    openNotifications();
  }
`;

/** Le script servi à part (`/app/notifications.js`). Il ne lit et n'écrit que par `/v1/notifications` [R16]. */
export const NOTIFICATIONS_SCRIPT = `'use strict';
globalThis.AIMMO_NOTIFICATIONS = function (t) {
  var $ = t.$, el = t.el, clear = t.clear, send = t.send;
  var KINDS = ${JSON.stringify(NOTIFICATIONS_KIND_LABELS)};
  var LEVELS = ${JSON.stringify(NOTIFICATIONS_LEVEL_LABELS)};
  var STATUS = ${JSON.stringify(NOTIFICATIONS_STATUS_LABELS)};
  var REFUSALS = ${JSON.stringify(NOTIFICATIONS_SCREEN_REFUSALS)};
  var HOT = ${JSON.stringify(NOTIFICATIONS_HOT_LINE)};
  var QUIET = ${JSON.stringify(NOTIFICATIONS_QUIET_LINE)};
  var UNSURE = ${JSON.stringify(NOTIFICATIONS_UNSURE)};
  var OFFLINE = 'Pas de réseau. Réessayez dans un moment.';
  var SETTABLE = ['client_ecrit', 'rendez_vous', 'piece_recue', 'tache', 'info'];
  var ID = /^[A-Za-z0-9_-]{1,64}$/, HM = /^(\\d{2}):(\\d{2})$/;
  var round = 0, saving = false, pending = null;
  function own(map, k) { return typeof k === 'string' && Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; }
  function say(m) { $('notifications-etat').textContent = m; }
  function body() { return $('notifications-corps'); }
  function refusal(res) { var b = res && res.body; return (b && own(REFUSALS, b.code)) || null; }
  function minute(v) { return typeof v === 'number' && v % 1 === 0 && v >= 0 && v <= 1439; }
  function hm(v) { var h = Math.floor(v / 60), m = v % 60; return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m; }
  function said(v) { var p = hm(v).split(':'); return Number(p[0]) + ' h' + (p[1] === '00' ? '' : ' ' + p[1]); }
  function fromInput(v) { var m = HM.exec(String(v || '')); if (!m) return -1; var n = Number(m[1]) * 60 + Number(m[2]); return Number(m[1]) < 24 && Number(m[2]) < 60 ? n : -1; }
  function when(iso) { var d = t.date(iso), h = t.hour(iso); return d ? 'le ' + d + (h ? ' à ' + h : '') : ''; }
  /* L'envoi du lien, lu une fois puis retiré de la barre d'adresse et de l'historique. */
  function linked() {
    if (typeof location === 'undefined') return null;
    var h = String(location.hash || '');
    if (h.indexOf('#envoi=') !== 0) return null;
    try { if (typeof history !== 'undefined') history.replaceState(null, '', '/app/'); } catch (e) { /* rien à remplacer */ }
    var id = h.slice(7);
    return ID.test(id) ? id : '';
  }
  function line(n) {
    if (!n || typeof n !== 'object') return null;
    var kind = own(KINDS, n.kind), status = own(STATUS, n.status), at = when(n.createdAt);
    if (!kind || !status || !at || typeof n.personId !== 'string' || !ID.test(n.personId)) return null;
    var li = el('li');
    li.appendChild(el('p', kind + ', ' + at + ' : ' + status + '.'));
    var open = el('button', 'Voir la fiche', 'secondaire');
    open.setAttribute('type', 'button');
    open.addEventListener('click', function () { t.openFiche(n.personId); });
    li.appendChild(open);
    return li;
  }
  function list(rows, empty) {
    var ul = el('ul', null, 'liste');
    (Array.isArray(rows) ? rows : []).forEach(function (n) { var li = line(n); if (li) ul.appendChild(li); });
    return ul.firstChild ? ul : el('p', empty, 'doux');
  }
  function section(title) { var s = el('section', null, 'bloc'); s.appendChild(el('h4', title)); return s; }
  function settingsBlock(v) {
    var s = section('Mes réglages');
    s.appendChild(el('p', QUIET, 'doux'));
    function time(id, label, value) {
      var l = el('label', label);
      l.setAttribute('for', id);
      var i = el('input');
      i.setAttribute('id', id);
      i.setAttribute('type', 'time');
      i.value = hm(value);
      s.appendChild(l);
      s.appendChild(i);
      return i;
    }
    var start = time('notifications-debut', 'Début des heures calmes', v.quietStart);
    var end = time('notifications-fin', 'Fin des heures calmes', v.quietEnd);
    s.appendChild(el('p', 'Aujourd’hui : de ' + said(v.quietStart) + ' à ' + said(v.quietEnd) + ', heure de Paris.', 'doux'));
    s.appendChild(el('p', HOT));
    var picks = {};
    SETTABLE.forEach(function (k) {
      var id = 'notifications-niveau-' + k, l = el('label', KINDS[k]), pick = el('select');
      l.setAttribute('for', id);
      pick.setAttribute('id', id);
      Object.keys(LEVELS).forEach(function (lv) { var o = el('option', LEVELS[lv]); o.value = lv; pick.appendChild(o); });
      pick.value = own(LEVELS, v.levels[k]) ? v.levels[k] : 'normale';
      s.appendChild(l);
      s.appendChild(pick);
      picks[k] = pick;
    });
    var note = el('p', null, 'etat');
    note.setAttribute('role', 'status');
    var save = el('button', 'Ranger mes réglages');
    save.setAttribute('type', 'button');
    save.addEventListener('click', function () {
      if (saving) return;
      var qs = fromInput(start.value), qe = fromInput(end.value);
      if (qs < 0 || qe < 0) { note.textContent = REFUSALS.invalid_quiet; return; }
      var levels = {};
      SETTABLE.forEach(function (k) { levels[k] = picks[k].value; });
      saving = true;
      note.textContent = 'Rangement…';
      send('/v1/notifications/reglages', 'POST', { quietStart: qs, quietEnd: qe, levels: levels }).then(function (res) {
        saving = false;
        if (res.gone) return;
        if (res.ok) { note.textContent = 'Rangé : heures calmes de ' + said(qs) + ' à ' + said(qe) + '.'; return; }
        note.textContent = refusal(res) || (res.offline || !res.body || res.status >= 500 ? UNSURE : 'Vos réglages ne sont pas rangés.');
      }, function () { saving = false; note.textContent = UNSURE; });
    });
    s.appendChild(save);
    s.appendChild(note);
    return s;
  }
  function settingsOk(v) {
    return !!v && typeof v === 'object' && minute(v.quietStart) && minute(v.quietEnd) && !!v.levels && typeof v.levels === 'object';
  }
  function show() {
    var mine = ++round, link = linked();
    /* L'envoi du lien reste en mémoire jusqu'à ce que son détail soit montré : un réseau coupé ne le perd pas. */
    if (link !== null) pending = link;
    var push = pending;
    clear(body());
    say('Lecture…');
    var asks = [send('/v1/notifications/reglages', 'GET'), send('/v1/notifications', 'GET')];
    if (push) asks.push(send('/v1/notifications/envois/' + encodeURIComponent(push), 'GET'));
    return Promise.all(asks).then(function (r) {
      if (mine !== round || r.some(function (x) { return x.gone; })) return false;
      if (r.some(function (x) { return x.offline; })) { say(OFFLINE); return false; }
      if (!r[0].ok || !r[1].ok) { say(refusal(r[0]) || refusal(r[1]) || 'Vos notifications ne se lisent pas pour le moment.'); return false; }
      var out = body();
      if (push !== null) {
        var p = section('Cette notification');
        var rows = r[2] && r[2].ok && r[2].body ? r[2].body.data : null;
        p.appendChild(push && Array.isArray(rows) ? list(rows, REFUSALS.unknown) : el('p', REFUSALS.unknown, 'doux'));
        out.appendChild(p);
        pending = null;
      }
      if (settingsOk(r[0].body.data)) out.appendChild(settingsBlock(r[0].body.data));
      else out.appendChild(el('p', 'Vos réglages ne se lisent pas pour le moment.', 'doux'));
      var all = section('Mes dernières notifications');
      all.appendChild(list(r[1].body.data, 'Aucune notification pour le moment.'));
      out.appendChild(all);
      say('');
      return true;
    }, function () { if (mine === round) say(OFFLINE); return false; });
  }
  return { show: show, wipe: function () { round += 1; saving = false; pending = null; } };
};
`;
