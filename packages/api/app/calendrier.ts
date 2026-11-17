import { SOCIAL_CHANNELS } from '../../core/src/studio/publications.ts';

/**
 * Le calendrier de publication à l'écran de l'agent (BR111) : régler combien de publications par réseau et par jour
 * (0 à 3) et à quelles heures de Paris, réserver sa semaine et lire ses créneaux, par les routes de BR03
 * (`/v1/marketing/calendrier`) [R580, R581, R582].
 * Script servi à part (`/app/calendrier.js`), chargé au premier geste depuis l'écran « Gagner des mandats » [R201].
 * Rien ne se publie d'ici : seul le passage planifié fait partir un créneau, par le chemin de publication de X05, en
 * mode essai [R582, R26]. Un réglage vaut à partir du lendemain, jamais pour un jour commencé [R581]. Les créneaux se
 * lisent dans l'ordre reçu ; un créneau refusé dit pourquoi, et d'abord quand le bien n'a aucun lien marqué vers sa
 * page [R582]. Chaque refus se dit en mots, jamais par un code ; une réponse perdue se dit incertaine.
 */

export const CALENDRIER_CHANNELS: Readonly<Record<string, string>> = Object.freeze({ instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn', google: 'Fiche Google', tiktok: 'TikTok', youtube: 'YouTube' });

export const CALENDRIER_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  role: 'Le calendrier de publication est celui de chaque agent.',
  agent_parti: 'Vous n’êtes plus en activité dans le réseau : le calendrier ne se règle plus.',
  invalid_body: 'La demande n’a pas pu être lue. Rechargez l’écran.',
  unknown_field: 'La demande n’a pas pu être lue. Rechargez l’écran.',
  heures_invalides: 'Les heures : de 1 à 3, au format 09:30, de la plus tôt à la plus tard, chacune une seule fois.',
  nombres_invalides: 'Par réseau : de 0 à 3 publications par jour, jamais plus que d’heures choisies.',
  reseau_inconnu: 'Un réseau n’est pas dans la liste : rechargez l’écran.',
  version_concurrente: 'Un autre réglage vient de passer : relisez le calendrier, puis recommencez.',
  jour_invalide: 'Le jour de départ n’a pas pu être lu. Rechargez l’écran.',
  jour_hors_calendrier: 'Le calendrier se réserve à partir d’aujourd’hui, deux semaines au plus.',
  periode_invalide: 'La période n’a pas pu être lue. Rechargez l’écran.',
});

/** Ce qu'est devenu un créneau, dit en mots. */
export const CALENDRIER_OUTCOMES: Readonly<Record<string, string>> = Object.freeze({
  a_venir: 'À venir : il partira par le passage planifié, en mode essai.',
  envoye: 'Parti, en mode essai.',
  echec: 'Le réseau n’a pas confirmé : rien n’est sûr pour ce créneau.',
  manque: 'Manqué : il n’est pas passé à temps, il ne part jamais en retard.',
});

/** La raison d'un créneau refusé (liste fermée du calendrier) [R582, R42, R86]. */
export const CALENDRIER_REASONS: Readonly<Record<string, string>> = Object.freeze({
  sans_lien: 'Refusé : le bien n’avait aucun lien marqué vers sa page en ligne. Rien n’est parti.',
  non_diffusable: 'Refusé : le bien n’était plus diffusable. Rien n’est parti.',
  agent_parti: 'Refusé : l’agent n’était plus en activité. Rien n’est parti.',
  manque: 'Refusé : passé trop tard. Rien n’est parti.',
  controle: 'Refusé par le contrôle de la publication. Rien n’est parti.',
});

export const CALENDRIER_LOST = 'La réponse n’est pas arrivée : rien n’est sûr. Relisez le calendrier avant de recommencer.';

/** Le script servi à part (`/app/calendrier.js`). Il ne lit et n'écrit que `/v1/marketing/calendrier` [R16]. */
export const CALENDRIER_SCRIPT = `'use strict';
globalThis.AIMMO_CALENDRIER = function (t) {
  var el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field;
  var CHANNELS = ${JSON.stringify(CALENDRIER_CHANNELS)};
  var ORDER = ${JSON.stringify(SOCIAL_CHANNELS)};
  var REFUSALS = ${JSON.stringify(CALENDRIER_REFUSALS)};
  var OUTCOMES = ${JSON.stringify(CALENDRIER_OUTCOMES)};
  var REASONS = ${JSON.stringify(CALENDRIER_REASONS)};
  var LOST = ${JSON.stringify(CALENDRIER_LOST)};
  var OFFLINE = 'Pas de réseau. Réessayez dans un moment.';
  var BASE = '/v1/marketing/calendrier';
  var HOUR = new RegExp('^([01][0-9]|2[0-3]):[0-5][0-9]$');
  var DAY = new RegExp('^[0-9]{4}-[0-9]{2}-[0-9]{2}$');
  var TODAY = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' });
  var LONG = new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
  var AT = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
  var root = null, status = null, rulesOut = null, slotsOut = null, reading = 0, busy = false;
  function say(text) { if (status) status.textContent = text; }
  function why(res, fallback) {
    if (res.offline) return OFFLINE;
    return (res.body && REFUSALS[res.body.code]) || fallback;
  }
  function today() { return TODAY.format(new Date(Date.now())); }
  function plus(day, n) {
    var p = day.split('-');
    return new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + n)).toISOString().slice(0, 10);
  }
  /* « 2027-10-12 » → « mardi 12 octobre » ; rien d'autre n'est lu. */
  function dayText(d) {
    if (typeof d !== 'string' || !DAY.test(d)) return '—';
    var p = d.split('-');
    return LONG.format(new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]))));
  }
  function hourText(iso) {
    var d = new Date(String(iso));
    return isNaN(d.getTime()) ? '—' : AT.format(d).replace(':', ' h ');
  }
  /* Un réglage reçu, dit en mots : réseau par réseau, dans l'ordre des réseaux, puis les heures. */
  function rulesText(r) {
    if (!r || typeof r !== 'object' || !r.perDay || !Array.isArray(r.hours)) return 'Aucun réglage.';
    var parts = ORDER.filter(function (c) { return typeof r.perDay[c] === 'number' && r.perDay[c] > 0; }).map(function (c) { return CHANNELS[c] + ' ' + r.perDay[c]; });
    var hours = r.hours.filter(function (h) { return typeof h === 'string' && HOUR.test(h); }).map(function (h) { return h.replace(':', ' h '); });
    return (parts.length ? parts.join(', ') + ' par jour' : 'Aucune publication') + (hours.length ? ', à ' + hours.join(', ') : '') + '.';
  }
  function drawRules(v) {
    clear(rulesOut);
    var today = v && v.today, next = v && v.next;
    rulesOut.appendChild(el('p', 'Aujourd’hui : ' + (today ? rulesText(today) : 'aucun réglage en vigueur.')));
    if (next) rulesOut.appendChild(el('p', 'À partir du ' + dayText(next.effectiveDay) + ' : ' + rulesText(next), 'doux'));
  }
  function slotText(s) {
    if (s.outcome === 'refuse') return REASONS[s.reason] || REASONS.controle;
    if (s.outcome === null || s.outcome === undefined) return OUTCOMES.a_venir;
    return OUTCOMES[s.outcome] || 'État inconnu : relisez le calendrier.';
  }
  /* Les créneaux, dans l'ordre reçu : jamais triés ni recalculés ici [R580]. */
  function drawSlots(list) {
    clear(slotsOut);
    if (!list.length) { slotsOut.appendChild(el('p', 'Aucun créneau réservé sur les deux semaines. Réservez votre semaine : seules vos publications prêtes, d’un bien diffusable avec sa page en ligne, y entrent.', 'doux')); return; }
    var ul = el('ul', null, 'liste');
    list.forEach(function (s) {
      if (!s || typeof s !== 'object') return;
      var li = el('li');
      li.appendChild(el('h4', dayText(s.day) + ' à ' + hourText(s.dueAt) + ' · ' + (CHANNELS[s.channel] || 'Réseau inconnu')));
      li.appendChild(el('p', slotText(s), s.outcome === 'refuse' || s.outcome === 'manque' || s.outcome === 'echec' ? 'alerte' : 'doux'));
      ul.appendChild(li);
    });
    slotsOut.appendChild(ul);
  }
  /* Seule la dernière lecture dessine : une réponse arrivée après une autre lecture, ou après la sortie, ne montre rien. */
  function read(message) {
    var turn = ++reading, mine = t.session(), from = today();
    say('Chargement…');
    return Promise.all([send(BASE + '/reglages', 'GET'), send(BASE + '/creneaux?du=' + from + '&au=' + plus(from, 13), 'GET')]).then(function (all) {
      if (all[0].gone || all[1].gone || turn !== reading || mine !== t.session()) return false;
      var r = all[0], s = all[1];
      if (!r.ok || !r.body || typeof r.body.data !== 'object') { say((message ? message + ' ' : '') + why(r, 'Le calendrier ne se lit pas pour le moment.')); return false; }
      drawRules(r.body.data);
      if (!s.ok || !s.body || !Array.isArray(s.body.data)) { clear(slotsOut); say((message ? message + ' ' : '') + why(s, 'Les créneaux ne se lisent pas pour le moment.')); return false; }
      drawSlots(s.body.data);
      say(message || '');
      return true;
    });
  }
  /* Une seule écriture à la fois ; après une réponse sûre, le calendrier est relu. */
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
      return read(typeof done === 'function' ? done(x.body.data) : done);
    }, function () { busy = false; say(LOST); return false; });
  }
  function settings(inner) {
    var d = el('details');
    d.appendChild(el('summary', 'Régler mon calendrier'));
    d.appendChild(el('p', 'Un nouveau réglage vaut à partir de demain, jamais pour aujourd’hui. Rien ne se publie d’ici.', 'doux'));
    var hours = [0, 1, 2].map(function (i) {
      var f = field(d, 'cal-heure-' + i, 'Heure ' + (i + 1) + (i ? ' (facultative)' : '') + ', par exemple 09:30');
      f.setAttribute('inputmode', 'numeric');
      f.setAttribute('maxlength', '5');
      return f;
    });
    var counts = ORDER.map(function (c) {
      var f = field(d, 'cal-' + c, CHANNELS[c] + ' : publications par jour, de 0 à 3');
      f.setAttribute('inputmode', 'numeric');
      f.setAttribute('maxlength', '1');
      return [c, f];
    });
    d.appendChild(button('Ranger ce réglage', function () {
      var h = hours.map(function (f) { return String(f.value || '').trim(); }).filter(function (x) { return x !== ''; });
      var okHours = h.length >= 1 && h.length <= 3 && h.every(function (x, i) { return HOUR.test(x) && (i === 0 || x > h[i - 1]); });
      if (!okHours) { say(REFUSALS.heures_invalides); return Promise.resolve(false); }
      var perDay = {}, bad = false;
      counts.forEach(function (p) {
        var v = String(p[1].value || '').trim();
        if (v === '') v = '0';
        if (!/^[0-3]$/.test(v) || Number(v) > h.length) bad = true;
        else perDay[p[0]] = Number(v);
      });
      if (bad) { say(REFUSALS.nombres_invalides); return Promise.resolve(false); }
      return write(BASE + '/reglages', { perDay: perDay, hours: h }, function (v) {
        return 'Réglage rangé : il vaut à partir du ' + dayText(v && v.effectiveDay) + ', jamais pour aujourd’hui.';
      }, 'Le réglage n’est pas rangé.');
    }));
    inner.appendChild(d);
  }
  function show(inner) {
    if (root !== inner) {
      root = inner;
      clear(inner);
      status = el('p', null, 'etat');
      status.setAttribute('role', 'status');
      inner.appendChild(status);
      rulesOut = el('div');
      inner.appendChild(rulesOut);
      settings(inner);
      inner.appendChild(el('h4', 'Mes créneaux des deux semaines'));
      inner.appendChild(button('Réserver ma semaine', function () {
        return write(BASE + '/semaine', { from: today() }, function (v) {
          var n = Array.isArray(v) ? v.length : 0;
          return 'Semaine réservée : ' + n + ' créneau' + (n > 1 ? 'x' : '') + ' pour vos publications prêtes.';
        }, 'La semaine n’est pas réservée.');
      }));
      slotsOut = el('div');
      inner.appendChild(slotsOut);
    }
    return read();
  }
  return { show: show };
};
`;
