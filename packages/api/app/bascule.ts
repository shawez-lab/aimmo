import type { RolloutIncident, RolloutStage } from '../../core/src/bascule/paliers.ts';
import type { Automation } from '../../core/src/bascule/automatisations.ts';
import type { OutboundChannelName } from '../../core/src/db/types.ts';

/**
 * La bascule sur l'écran du réseau (B05) : la direction voit le palier de chaque automatisation du site et son dernier
 * retour en ombre, la fait passer de l'ombre à 10 %, et vérifie la chaîne du journal. Script servi à part
 * (`/app/bascule.js`), chargé au premier geste [R201]. L'écran ne décide rien : le serveur dit si le passage est permis, et
 * son refus est dit en français [R26]. Seulement des nombres et des dates, jamais le contenu du journal [R13, R16].
 * Le même bloc montre le palier de chaque canal de captation (C09e) : un canal sans vrai branchement ne fait rien partir,
 * à aucun palier, et l'écran le dit au lieu de son palier.
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
const CHANNEL_NAMES: Record<OutboundChannelName, string> = {
  email: 'Mail',
  phone: 'Téléphone',
  sms: 'SMS',
  instagram: 'Instagram',
  facebook: 'Facebook',
  whatsapp: 'WhatsApp',
  site: 'Assistant du site',
};
const CHANNEL_STAGES: Record<RolloutStage, string> = {
  shadow: 'En essai : rien ne part, les réponses restent dans la boîte d’essai.',
  ten_percent: 'À 10 % : un message sur dix part vraiment, les autres restent en essai.',
  everywhere: 'Partout : tous les messages partent vraiment.',
};
const CHANNEL_REFUSALS: Record<string, string> = {
  not_open: 'Le passage n’est pas encore ouvert : rien ne bouge, le canal reste en essai.',
  no_real_channel: 'Aucun vrai canal n’est branché ici : rien ne bouge, le canal reste en essai.',
  too_early: 'L’essai n’a pas encore duré 7 jours : le canal y reste.',
  not_enough_requests: 'Trop peu de messages comptés en essai pour prouver quelque chose : le canal y reste.',
  not_in_shadow: 'Ce canal n’est plus en essai : la liste a changé.',
  not_found: 'Canal inconnu : la liste a changé.',
};

export const BASCULE_ENTRY_HTML = `<section class="bloc" aria-labelledby="titre-bascule">
<h3 id="titre-bascule">Bascule des automatisations du site</h3>
<p class="doux">Où en est chaque envoi automatique, et si le journal est intact.</p>
<button id="bascule-voir" type="button" class="secondaire">Voir la bascule</button>
<button id="bascule-canaux" type="button" class="secondaire">Voir les canaux</button>
<button id="bascule-journal" type="button" class="secondaire">Vérifier le journal</button>
<p id="bascule-etat" class="etat" role="status"></p>
<div id="bascule-corps"></div>
</section>
`;

/** Le chargeur posé dans le script de l'application : l'écran est servi à part, chargé une fois, jamais gardé. */
export const BASCULE_JS = `
  /* ---------- La bascule sur l'écran du réseau (B05), chargée au premier geste [R16, R201]. ---------- */
  function wipeBascule() {
    clear($('bascule-corps'));
    $('bascule-etat').textContent = '';
  }
  function withBascule(act) {
    return withTool('bascule', 'AIMMO_BASCULE', 'bascule-etat', 'reseau', act, function () { return { $: $, el: el, clear: clear, send: send, button: button, date: date, session: function () { return session; } }; });
  }
`;

/** Le script servi à part (`/app/bascule.js`). Il ne lit et n'écrit que ces cinq routes [R16], et ne garde rien. */
export const BASCULE_SCRIPT = `'use strict';
globalThis.AIMMO_BASCULE = function (t) {
  var $ = t.$, el = t.el, clear = t.clear, send = t.send, button = t.button, date = t.date;
  var NAMES = ${JSON.stringify(NAMES)};
  var STAGES = ${JSON.stringify(STAGES)};
  var INCIDENTS = ${JSON.stringify(INCIDENTS)};
  var REFUSALS = ${JSON.stringify(REFUSALS)};
  var CHANNEL_NAMES = ${JSON.stringify(CHANNEL_NAMES)};
  var CHANNEL_STAGES = ${JSON.stringify(CHANNEL_STAGES)};
  var CHANNEL_REFUSALS = ${JSON.stringify(CHANNEL_REFUSALS)};
  /* Le verrou d'un geste vaut pour sa session : une réponse qui tarde ne bloque pas la connexion suivante. */
  var busy = null, showing = 0;
  function state(text) { $('bascule-etat').textContent = text; }
  function refusal(res, fallback, words) {
    if (res.offline) return 'Pas de réseau. Réessayez dans un moment.';
    return (res.body && ((words && words[res.body.code]) || REFUSALS[res.body.code])) || fallback;
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
  function advanceChannel(v) {
    return once(function () {
      state('Envoi…');
      return send('/v1/captation/paliers/' + encodeURIComponent(v.channel) + '/avancer', 'POST').then(function (x) {
        if (x.gone) return false;
        if (!x.ok) {
          var text = refusal(x, 'Le passage n’a pas abouti : rien ne bouge.', CHANNEL_REFUSALS);
          if (x.body && x.body.code === 'not_in_shadow') return showChannels(text);
          state(text);
          return false;
        }
        return showChannels('Passé à 10 %. À la première panne, le canal revient de lui-même en essai.');
      });
    });
  }
  /* Passer à 10 % change ce qui part : deux appuis espacés. Sans suite, la demande retombe. */
  function advanceButton(go, warning) {
    var text = 'Passer à 10 %', armedAt = null;
    var b = button(text, function () {
      var now = Date.now();
      if (armedAt !== null && now - armedAt < 1000) return;
      if (armedAt === null || now - armedAt > 15000) {
        armedAt = now;
        b.textContent = 'Confirmer : passer à 10 %';
        state(warning + ' Appuyez de nouveau pour confirmer.');
        return;
      }
      armedAt = null;
      b.textContent = text;
      go();
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
    if (v.stage === 'shadow') li.appendChild(advanceButton(function () { advance(v); }, 'Le socle décidera pour un envoi sur dix.'));
    return li;
  }
  function channelLine(v) {
    var li = el('li');
    li.appendChild(el('strong', CHANNEL_NAMES[v.channel] || 'Autre canal'));
    /* Sans vrai canal, rien ne part à aucun palier : dire le palier ferait croire le contraire [R26]. */
    li.appendChild(el('p', v.connected ? (CHANNEL_STAGES[v.stage] || 'Palier inconnu.') : 'Aucun vrai canal branché : rien ne part, les réponses restent dans la boîte d’essai.'));
    li.appendChild(el('p', v.since ? 'Depuis le ' + date(v.since) + ', ' + v.requests + ' message(s) compté(s).' : 'Aucun message reçu pour le moment.', 'doux'));
    if (v.connected && v.stage !== 'everywhere' && v.since && v.daysLeft > 0) li.appendChild(el('p', 'Encore ' + days(v.daysLeft) + ' avant de pouvoir quitter ce palier.', 'doux'));
    if (v.lastIncidentAt) li.appendChild(el('p', 'Dernier retour en essai le ' + date(v.lastIncidentAt) + ', après ' + (INCIDENTS[v.lastIncidentKind] || 'un incident') + '.', 'etat'));
    if (v.connected && v.stage === 'shadow') li.appendChild(advanceButton(function () { advanceChannel(v); }, 'Un message sur dix partira vraiment.'));
    return li;
  }
  function list(url, draw, message) {
    var mine = t.session();
    /* Seule la dernière lecture demandée s'affiche : deux appuis ne font pas deux listes. */
    var turn = ++showing;
    clear($('bascule-corps'));
    state('Chargement…');
    return send(url, 'GET').then(function (res) {
      if (res.gone || mine !== t.session() || turn !== showing) return false;
      if (!res.ok || !Array.isArray(res.body.data)) { state(refusal(res, 'Indisponible pour le moment.')); return false; }
      var ul = el('ul', null, 'liste');
      res.body.data.forEach(function (v) { ul.appendChild(draw(v)); });
      $('bascule-corps').appendChild(ul);
      state(message || '');
      return true;
    });
  }
  function show(message) { return list('/v1/automatisations/paliers', line, message); }
  function showChannels(message) { return list('/v1/captation/paliers', channelLine, message); }
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
  return { show: show, showChannels: showChannels, journal: journal };
};
`;
