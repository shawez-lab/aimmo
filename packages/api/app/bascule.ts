import type { RolloutIncident, RolloutStage } from '../../core/src/bascule/paliers.ts';
import type { Automation } from '../../core/src/bascule/automatisations.ts';

/**
 * La bascule sur l'écran du réseau (B05) : la direction voit le palier de chaque automatisation du site et son dernier
 * retour en ombre, la fait passer de l'ombre à 10 %, et vérifie la chaîne du journal. Script servi à part
 * (`/app/bascule.js`), chargé au premier geste [R201]. L'écran ne décide rien : le serveur dit si le passage est permis, et
 * son refus est dit en français [R26]. Seulement des nombres et des dates, jamais le contenu du journal [R13, R16].
 */

const NAMES: Record<Automation, string> = {
  rappel_visite: 'Rappel de la visite d’estimation',
  courrier_vendeur: 'Courrier au vendeur après l’estimation',
};
const STAGES: Record<RolloutStage, string> = {
  shadow: 'En ombre : le site décide seul, le socle compare.',
  ten_percent: 'À 10 % : le socle décide pour un envoi sur dix.',
  everywhere: 'Partout : le socle décide pour tous les envois.',
};
const INCIDENTS: Record<RolloutIncident, string> = {
  unexplained_gap: 'un écart non expliqué',
  failure: 'une panne',
};
const REFUSALS: Record<string, string> = {
  not_open: 'Le passage n’est pas encore ouvert : rien ne bouge, l’automatisation reste en ombre.',
  too_early: 'L’ombre n’a pas encore duré 7 jours : l’automatisation y reste.',
  not_enough_requests: 'Trop peu de demandes comptées en ombre pour prouver quelque chose : l’automatisation y reste.',
  not_in_shadow: 'Cette automatisation n’est plus en ombre : la liste a changé.',
  role: 'Ce n’est pas dans vos droits.',
  not_found: 'Automatisation inconnue : la liste a changé.',
};

export const BASCULE_ENTRY_HTML = `<section class="bloc" aria-labelledby="titre-bascule">
<h3 id="titre-bascule">Bascule des automatisations du site</h3>
<p class="doux">Où en est chaque envoi automatique, et si le journal est intact.</p>
<button id="bascule-voir" type="button" class="secondaire">Voir la bascule</button>
<button id="bascule-journal" type="button" class="secondaire">Vérifier le journal</button>
<p id="bascule-etat" class="etat" role="status"></p>
<div id="bascule-corps"></div>
</section>
`;

/** Le chargeur posé dans le script de l'application : l'écran est servi à part, chargé une fois, jamais gardé. */
export const BASCULE_JS = `
  /* ---------- La bascule sur l'écran du réseau (B05), chargée au premier geste [R16, R201]. ---------- */
  var basculeTools = null, basculeLoading = false;
  function wipeBascule() {
    clear($('bascule-corps'));
    $('bascule-etat').textContent = '';
  }
  function withBascule(act) {
    if (!currentKey) return Promise.resolve(false);
    if (basculeTools) return act(basculeTools);
    if (basculeLoading) return Promise.resolve(false);
    basculeLoading = true;
    var mine = session;
    $('bascule-etat').textContent = 'Chargement…';
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.setAttribute('src', '/app/bascule.js');
      s.addEventListener('load', function () {
        basculeLoading = false;
        var make = globalThis.AIMMO_BASCULE;
        try { delete globalThis.AIMMO_BASCULE; } catch (e) { /* rien */ }
        if (mine !== session) { resolve(false); return; }
        if (typeof make !== 'function') { $('bascule-etat').textContent = 'Indisponible pour le moment. Réessayez dans un moment.'; resolve(false); return; }
        basculeTools = make({ $: $, el: el, clear: clear, send: send, button: button, date: date, session: function () { return session; } });
        resolve(act(basculeTools));
      });
      s.addEventListener('error', function () {
        basculeLoading = false;
        if (mine === session) $('bascule-etat').textContent = 'Pas de réseau. Réessayez dans un moment.';
        resolve(false);
      });
      $('reseau').appendChild(s);
    });
  }
`;

/** Le script servi à part (`/app/bascule.js`). Il ne lit et n'écrit que ces trois routes [R16], et ne garde rien. */
export const BASCULE_SCRIPT = `'use strict';
globalThis.AIMMO_BASCULE = function (t) {
  var $ = t.$, el = t.el, clear = t.clear, send = t.send, button = t.button, date = t.date;
  var NAMES = ${JSON.stringify(NAMES)};
  var STAGES = ${JSON.stringify(STAGES)};
  var INCIDENTS = ${JSON.stringify(INCIDENTS)};
  var REFUSALS = ${JSON.stringify(REFUSALS)};
  /* Le verrou d'un geste vaut pour sa session : une réponse qui tarde ne bloque pas la connexion suivante. */
  var busy = null, showing = 0;
  function state(text) { $('bascule-etat').textContent = text; }
  function refusal(res, fallback) {
    if (res.offline) return 'Pas de réseau. Réessayez dans un moment.';
    return (res.body && REFUSALS[res.body.code]) || fallback;
  }
  function once(work) {
    var mine = t.session();
    if (busy === mine) return Promise.resolve(false);
    busy = mine;
    function done(r) { if (busy === mine) busy = null; return r; }
    return work().then(done, function () { return done(false); });
  }
  function days(n) { return n + (n > 1 ? ' jours' : ' jour'); }
  function advance(v) {
    return once(function () {
      state('Envoi…');
      return send('/v1/automatisations/paliers/' + encodeURIComponent(v.automation) + '/avancer', 'POST').then(function (x) {
        if (x.gone) return false;
        if (!x.ok) {
          var text = refusal(x, 'Le passage n’a pas abouti : rien ne bouge.');
          if (x.body && x.body.code === 'not_in_shadow') return show(text);
          state(text);
          return false;
        }
        return show('Passé à 10 %. Au premier écart non expliqué ou à la première panne, l’automatisation revient d’elle-même en ombre.');
      });
    });
  }
  /* Passer à 10 % change ce qui part : deux appuis espacés. Sans suite, la demande retombe. */
  function advanceButton(v) {
    var text = 'Passer à 10 %', armedAt = null;
    var b = button(text, function () {
      var now = Date.now();
      if (armedAt !== null && now - armedAt < 1000) return;
      if (armedAt === null || now - armedAt > 15000) {
        armedAt = now;
        b.textContent = 'Confirmer : passer à 10 %';
        state('Le socle décidera pour un envoi sur dix. Appuyez de nouveau pour confirmer.');
        return;
      }
      armedAt = null;
      b.textContent = text;
      advance(v);
    });
    return b;
  }
  function line(v) {
    var li = el('li');
    li.appendChild(el('strong', NAMES[v.automation] || 'Autre automatisation'));
    li.appendChild(el('p', STAGES[v.stage] || 'Palier inconnu.'));
    li.appendChild(el('p', v.since ? 'Depuis le ' + date(v.since) + ', ' + v.requests + ' demande(s) comptée(s).' : 'Aucune demande reçue pour le moment.', 'doux'));
    if (v.stage !== 'everywhere' && v.since && v.daysLeft > 0) li.appendChild(el('p', 'Encore ' + days(v.daysLeft) + ' avant de pouvoir quitter ce palier.', 'doux'));
    if (v.lastIncidentAt) li.appendChild(el('p', 'Dernier retour en ombre le ' + date(v.lastIncidentAt) + ', après ' + (INCIDENTS[v.lastIncidentKind] || 'un incident') + '.', 'etat'));
    if (v.stage === 'shadow') li.appendChild(advanceButton(v));
    return li;
  }
  function show(message) {
    var mine = t.session();
    /* Seule la dernière lecture demandée s'affiche : deux appuis ne font pas deux listes. */
    var turn = ++showing;
    clear($('bascule-corps'));
    state('Chargement…');
    return send('/v1/automatisations/paliers', 'GET').then(function (res) {
      if (res.gone || mine !== t.session() || turn !== showing) return false;
      if (!res.ok || !Array.isArray(res.body.data)) { state(refusal(res, 'Indisponible pour le moment.')); return false; }
      var ul = el('ul', null, 'liste');
      res.body.data.forEach(function (v) { ul.appendChild(line(v)); });
      $('bascule-corps').appendChild(ul);
      state(message || '');
      return true;
    });
  }
  function journal() {
    return once(function () {
      var mine = t.session();
      state('Vérification…');
      return send('/v1/journal/verification', 'GET').then(function (res) {
        if (res.gone || mine !== t.session()) return false;
        if (!res.ok || !res.body.data) { state(refusal(res, 'Vérification indisponible pour le moment.')); return false; }
        var d = res.body.data;
        state(d.ok ? 'Journal intact : ' + d.lines + ' ligne(s) vérifiée(s).' : 'Journal abîmé à la ligne ' + d.brokenAt + ' : ne touchez à rien et prévenez le responsable de la conformité.');
        return true;
      });
    });
  }
  return { show: show, journal: journal };
};
`;
