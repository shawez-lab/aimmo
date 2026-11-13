import { AUTOMATION_CHANNELS, AUTOMATION_TRIGGERS, DEFAULT_SCENARIO_SETTINGS, FIRST_NAME_SLOT, type AutomationChannel, type AutomationTrigger } from '../../core/src/automatismes/scenarios.ts';
import { PROJECT_KINDS, type ProjectKind } from '../../core/src/db/types.ts';
import { SCENARIO_REFUSALS } from '../src/scenarios.ts';

/**
 * L'écran « Scénarios automatiques » de la direction (BR57, HX24), posé sous « Engagements de service » sur l'écran du
 * réseau, comme les communes sous « Phases et régions » (BR38) : script servi à part (`/app/scenarios.js`), chargé au
 * premier geste, sans rien ajouter au script de l'application [R201].
 *
 * La direction compose un scénario en listes fermées (les quatre déclencheurs, le type de projet seulement pour un
 * nouveau projet), l'essaie sur le mois passé, lit ce qu'il aurait envoyé, puis l'allume ou l'éteint [R403]. Le bouton
 * « Allumer » n'existe que sur un essai de la version affichée que le serveur dit valable à l'instant [R400, R402] ;
 * c'est le serveur qui relit tout. Chaque refus est dit en mots, une réponse perdue est dite incertaine [R16]. Tout texte
 * reçu est posé en texte, rien ne reste une fois quitté.
 */

export const SCENARIO_TRIGGER_LABELS: Readonly<Record<AutomationTrigger, string>> = Object.freeze({
  nouveau_contact: 'Après chaque nouveau contact',
  nouveau_projet: 'Après chaque nouveau projet',
  visite_faite: 'Après chaque visite faite',
  mandat_signe: 'Après chaque mandat signé',
});
export const SCENARIO_CHANNEL_LABELS: Readonly<Record<AutomationChannel, string>> = Object.freeze({ email: 'Mail', sms: 'SMS', whatsapp: 'WhatsApp' });
export const SCENARIO_PROJECT_LABELS: Readonly<Record<ProjectKind, string>> = Object.freeze({
  sell: 'Vendre',
  buy: 'Acheter',
  rent_out: 'Mettre en location',
  rent: 'Louer',
  invest: 'Investir',
  sell_business: 'Céder une entreprise',
  buy_business: 'Reprendre une entreprise',
  valuation: 'Faire estimer',
});

/** Une écriture sans réponse, ou coupée par une panne du serveur, a pu passer : l'écran ne dit ni fait ni pas fait. */
export const SCENARIOS_LOST = 'La réponse n’est pas arrivée : rien n’est sûr. Relisez la liste avant de recommencer.';
export const SCENARIOS_OFFLINE = 'Pas de réseau. Réessayez dans un moment.';

const MAX_WAIT = DEFAULT_SCENARIO_SETTINGS.maxWaitHours;
const MAX_TASK = DEFAULT_SCENARIO_SETTINGS.maxTaskDays;

/** Le script servi à part (`/app/scenarios.js`). Il ne lit et n'écrit que `/v1/scenarios` [R16]. */
export const SCENARIOS_SCRIPT = `'use strict';
globalThis.AIMMO_SCENARIOS = function (t) {
  var el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field, select = t.select, details = t.details, date = t.date;
  var REFUSALS = ${JSON.stringify(SCENARIO_REFUSALS)};
  var TRIGGERS = ${JSON.stringify(SCENARIO_TRIGGER_LABELS)}, TRIGGER_KEYS = ${JSON.stringify(AUTOMATION_TRIGGERS)};
  var CHANNELS = ${JSON.stringify(SCENARIO_CHANNEL_LABELS)}, CHANNEL_KEYS = ${JSON.stringify(AUTOMATION_CHANNELS)};
  var KINDS = ${JSON.stringify(SCENARIO_PROJECT_LABELS)}, KIND_KEYS = ${JSON.stringify(PROJECT_KINDS)};
  var LOST = ${JSON.stringify(SCENARIOS_LOST)}, OFFLINE = ${JSON.stringify(SCENARIOS_OFFLINE)};
  var SLOT = ${JSON.stringify(FIRST_NAME_SLOT)}, MAX_WAIT = ${MAX_WAIT}, MAX_TASK = ${MAX_TASK};
  var root = null, out = null, status = null, reading = 0, busy = null;
  function own(map, k) { return typeof k === 'string' && Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; }
  function say(text) { if (status) status.textContent = text; }
  /* Un refus : ses mots connus, sinon ceux du serveur s'ils sont courts, sinon un texte de secours ; jamais un code. */
  function why(res, fallback) {
    if (res.offline) return OFFLINE;
    var b = res.body || {};
    return own(REFUSALS, b.code) || (typeof b.message === 'string' && b.message.length > 0 && b.message.length < 300 ? b.message : fallback);
  }
  function lost(res) { return res.offline || res.status >= 500 || !res.body; }
  function once(work) {
    var mine = t.session();
    if (busy === mine) return Promise.resolve(false);
    busy = mine;
    function done(r) { if (busy === mine) busy = null; return r; }
    return work().then(done, function () { return done(false); });
  }
  function whole(input, max) {
    var v = String(input.value || '').trim();
    return /^[0-9]{1,4}$/.test(v) && Number(v) <= max ? Number(v) : null;
  }
  function count(n, one, many) { return n + ' ' + (n > 1 ? many : one); }
  function num(n) { return typeof n === 'number' && isFinite(n) && n >= 0 ? Math.floor(n) : 0; }
  function waitText(h) {
    if (h === 0) return 'aussitôt';
    return h % 24 === 0 ? 'après ' + count(h / 24, 'jour', 'jours') : 'après ' + count(h, 'heure', 'heures');
  }
  function describe(li, d) {
    var trigger = own(TRIGGERS, d.trigger) || 'Déclencheur inconnu';
    if (d.trigger === 'nouveau_projet') trigger += ' : ' + (d.projectKind ? own(KINDS, d.projectKind) || 'type inconnu' : 'tous les types');
    li.appendChild(el('p', trigger + ', ' + waitText(num(d.waitHours)) + '.'));
    if (d.message) {
      li.appendChild(el('p', 'Message par ' + (own(CHANNELS, d.message.channel) || 'canal inconnu') + ' :', 'doux'));
      li.appendChild(el('blockquote', String(d.message.text || '')));
    }
    if (d.task) li.appendChild(el('p', 'Tâche pour l’agent : ' + String(d.task.title || '') + ', ' + (num(d.task.dueInDays) === 0 ? 'le jour même' : 'sous ' + count(num(d.task.dueInDays), 'jour', 'jours')) + '.', 'doux'));
  }
  /* Ce que l'essai aurait fait sur le mois passé, chiffres du serveur, sans rien envoyer [R400]. */
  function trial(box, s) {
    var p = el('p', 'Essai du ' + date(s.at) + ', sur les faits du ' + date(s.from) + ' au ' + date(s.to) + ' : ' + count(num(s.messages), 'message aurait été envoyé', 'messages auraient été envoyés') + ', à ' + count(num(s.persons), 'personne', 'personnes') + ', et ' + count(num(s.tasks), 'tâche créée', 'tâches créées') + '. Rien n’est parti.');
    box.appendChild(p);
    var refused = s.refused && typeof s.refused === 'object' ? Object.keys(s.refused) : [];
    refused.forEach(function (rule) {
      var n = num(s.refused[rule]);
      if (n > 0) box.appendChild(el('p', count(n, 'message aurait été refusé', 'messages auraient été refusés') + ' par le contrôle des envois, règle ' + rule + '.', 'doux'));
    });
    if (num(s.sameDayTwice) > 0) box.appendChild(el('p', count(num(s.sameDayTwice), 'message serait tombé', 'messages seraient tombés') + ' le même jour qu’un autre message automatique à la même personne : ce scénario ne peut pas être allumé tel quel.', 'retard'));
  }
  /* Deux appuis pour éteindre : les passages en attente sont annulés, jamais effacés [R401]. */
  function twice(label, confirm, act) {
    var armed = false;
    var b = button(label, function () {
      if (!armed) { armed = true; b.textContent = confirm; return; }
      armed = false;
      b.textContent = label;
      act();
    });
    return b;
  }
  function gesture(path, ok, fallback) {
    return once(function () {
      var mine = t.session();
      say('Envoi…');
      return send(path, 'POST', {}).then(function (res) {
        if (res.gone || mine !== t.session()) return false;
        if (lost(res)) { say(LOST); return false; }
        if (!res.ok) { say(why(res, fallback)); return false; }
        return show(root, ok(res.body.data || {}));
      });
    });
  }
  function scenario(s) {
    var li = el('li');
    var d = s.definition || {};
    li.appendChild(el('strong', String(d.name || '')));
    var version = num(s.version);
    var lit = s.litVersion === null || s.litVersion === undefined ? null : num(s.litVersion);
    li.appendChild(el('p', (lit === null ? 'Éteint' : lit === version ? 'Allumé depuis le ' + date(s.litSince) : 'Allumé en version ' + lit + ' depuis le ' + date(s.litSince) + ' : la version ' + version + ' affichée n’est pas allumée') + ' · version ' + version + ', composée le ' + date(s.composedAt) + '.', 'doux'));
    describe(li, d);
    var id = String(s.scenarioId || '');
    var path = '/v1/scenarios/' + encodeURIComponent(id);
    var sim = s.lastSimulation && typeof s.lastSimulation === 'object' ? s.lastSimulation : null;
    if (sim) trial(li, sim);
    else li.appendChild(el('p', 'Pas encore essayée : sans essai sur le mois passé, cette version ne s’allume pas.', 'doux'));
    li.appendChild(button(sim ? 'Refaire l’essai sur le mois passé' : 'Essayer sur le mois passé', function () {
      gesture(path + '/essai', function (r) { return 'Essai fait : ' + count(num(r.messages), 'message', 'messages') + ' et ' + count(num(r.tasks), 'tâche', 'tâches') + ' sur le mois passé, rien n’est parti.'; }, 'L’essai n’a pas pu se faire.');
    }));
    /* « Allumer » : seulement sur un essai de la version affichée, valable à l'instant selon le serveur [R400]. */
    if (lit !== version) {
      if (sim && sim.canSwitchOn === true) li.appendChild(button('Allumer la version ' + version, function () { gesture(path + '/allumer', function () { return 'Scénario allumé : seuls les faits à venir le déclenchent, en mode essai.'; }, 'Le scénario n’est pas allumé.'); }));
      else if (sim) li.appendChild(el('p', 'Cet essai ne permet pas d’allumer : refaites-le, ou corrigez le scénario.', 'doux'));
    }
    if (lit !== null) li.appendChild(twice('Éteindre', 'Confirmer : éteindre et annuler ses passages en attente', function () { gesture(path + '/eteindre', function (r) { return 'Scénario éteint : ' + count(num(r.cancelled), 'passage en attente annulé', 'passages en attente annulés') + ', rien n’est effacé.'; }, 'Le scénario n’est pas éteint.'); }));
    var again = details(li, 'Composer une nouvelle version');
    form(again, 'scenario-' + id, d, 'Ranger cette version', path);
    return li;
  }
  /* Le formulaire, en listes fermées : le type de projet ne se propose que pour un nouveau projet [R403]. */
  function form(box, prefix, d, submit, path) {
    var name = field(box, prefix + '-nom', 'Nom du scénario');
    name.setAttribute('maxlength', '80');
    name.value = String(d.name || '');
    var trig = {};
    TRIGGER_KEYS.forEach(function (k) { trig[k] = TRIGGERS[k]; });
    var trigger = select(box, prefix + '-declencheur', 'Déclencheur', Object.assign({ '': 'Choisir' }, trig), own(TRIGGERS, d.trigger) ? d.trigger : '');
    var kinds = { '': 'Tous les types de projet' };
    KIND_KEYS.forEach(function (k) { kinds[k] = KINDS[k]; });
    var kindBox = el('div');
    box.appendChild(kindBox);
    var kind = null;
    function kindField() {
      clear(kindBox);
      kind = null;
      if (trigger.value === 'nouveau_projet') kind = select(kindBox, prefix + '-type', 'Type de projet', kinds, d.projectKind && own(KINDS, d.projectKind) ? d.projectKind : '');
    }
    trigger.addEventListener('change', kindField);
    kindField();
    var wait = field(box, prefix + '-attente', 'Attente avant le message, en heures (0 pour aussitôt)');
    wait.setAttribute('inputmode', 'numeric');
    wait.value = d.waitHours === undefined ? '' : String(num(d.waitHours));
    var chans = { '': 'Aucun message' };
    CHANNEL_KEYS.forEach(function (k) { chans[k] = CHANNELS[k]; });
    var channel = select(box, prefix + '-canal', 'Message', chans, d.message && own(CHANNELS, d.message.channel) ? d.message.channel : '');
    var text = field(box, prefix + '-texte', 'Texte du message, avec ' + SLOT + ' une fois, sans aucun chiffre', 'textarea');
    text.setAttribute('maxlength', '4000');
    text.value = d.message ? String(d.message.text || '') : '';
    var title = field(box, prefix + '-tache', 'Tâche pour l’agent (facultative)');
    title.setAttribute('maxlength', '120');
    title.value = d.task ? String(d.task.title || '') : '';
    var due = field(box, prefix + '-delai', 'Délai de la tâche, en jours');
    due.setAttribute('inputmode', 'numeric');
    due.value = d.task ? String(num(d.task.dueInDays)) : '';
    box.appendChild(button(submit, function () {
      var n = String(name.value || '').trim();
      if (!n) { say(REFUSALS.bad_name); return; }
      if (!own(TRIGGERS, trigger.value)) { say(REFUSALS.bad_trigger); return; }
      var h = whole(wait, MAX_WAIT);
      if (h === null) { say(REFUSALS.bad_wait); return; }
      var message = null, task = null;
      if (channel.value) {
        var tx = String(text.value || '').trim();
        if (!tx) { say(REFUSALS.bad_text); return; }
        if (tx.split(SLOT).length !== 2) { say(REFUSALS.first_name_slot); return; }
        message = { channel: channel.value, text: tx };
      }
      var tt = String(title.value || '').trim();
      if (tt) {
        var dd = whole(due, MAX_TASK);
        if (dd === null) { say(REFUSALS.bad_task_due); return; }
        task = { title: tt, dueInDays: dd };
      }
      if (!message && !task) { say(REFUSALS.empty_scenario); return; }
      var body = { name: n, trigger: trigger.value, projectKind: kind && kind.value ? kind.value : null, waitHours: h, message: message, task: task };
      return once(function () {
        var mine = t.session();
        say('Envoi…');
        return send(path, 'POST', body).then(function (res) {
          if (res.gone || mine !== t.session()) return false;
          if (lost(res)) { say(LOST); return false; }
          if (!res.ok) { say(why(res, 'Le scénario n’est pas rangé.')); return false; }
          return show(root, 'Version rangée. Essayez-la sur le mois passé avant de l’allumer.');
        });
      });
    }));
  }
  function show(box, message) {
    if (root !== box) {
      root = box;
      clear(box);
      status = el('p', '', 'etat');
      status.setAttribute('role', 'status');
      out = el('div');
      box.appendChild(status);
      box.appendChild(out);
    }
    var mine = t.session(), turn = ++reading;
    say(message ? message + ' Chargement…' : 'Chargement…');
    return send('/v1/scenarios', 'GET').then(function (res) {
      if (res.gone || mine !== t.session() || turn !== reading || root !== box) return false;
      clear(out);
      if (!res.ok || !Array.isArray(res.body.data)) { say((message ? message + ' ' : '') + why(res, 'Les scénarios ne se lisent pas pour le moment.')); return false; }
      if (!res.body.data.length) out.appendChild(el('p', 'Aucun scénario : composez le premier, puis essayez-le sur le mois passé.', 'doux'));
      var ul = el('ul', null, 'liste');
      res.body.data.forEach(function (s) { if (s && typeof s === 'object') ul.appendChild(scenario(s)); });
      out.appendChild(ul);
      var add = details(out, 'Composer un scénario');
      form(add, 'scenario-nouveau', {}, 'Ranger ce scénario', '/v1/scenarios');
      say(message || '');
      return true;
    });
  }
  return { show: show };
};
`;
