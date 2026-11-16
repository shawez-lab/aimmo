/**
 * BR94 · Les rapports sur mesure à l'écran de la direction (HX62, routes de `/v1/finances/rapports`). Un seul script
 * servi à part (`/app/rapports.js`), chargé au premier geste sous « Engagements de service » de l'écran du réseau, sans
 * rien ajouter au script de l'application [R201].
 *
 * - Composer : des mesures du catalogue fermé, un regroupement (total ou mois de Paris), une période d'un an au plus,
 *   les 12 derniers mois de Paris par défaut [R560]. Une composition fausse est arrêtée avant l'envoi.
 * - Portée : le total du réseau, ou un seul agent choisi dans la liste des agents en activité
 *   (`GET /v1/gagner/recommandations/agents`) ; aucun identifiant ne se tape, jamais deux agents à la fois [R14].
 * - Lire (`POST …/rapports/lecture`), enregistrer sous un nom (`POST …/rapports`), relire un rapport enregistré sur la
 *   période et la portée choisies (`POST …/rapports/<id>/lecture`) ; la liste (`GET …/rapports`) n'a que les siens.
 *
 * Jamais vu : l'écran recompte chaque chiffre sur les lignes reçues avant de le montrer ; un chiffre qui ne tombe pas
 * juste n'est pas montré, il est dit « non vérifiable » ; chaque chiffre s'ouvre sur ses lignes (identifiant et date)
 * [R69]. Changer de portée efface le rapport affiché avant toute lecture, et une réponse d'une autre portée, ou plus
 * ancienne qu'une lecture demandée après elle, est jetée : deux agents ne sont jamais à l'écran ensemble [R14].
 *
 * Chaque refus est dit en mots, jamais par son code [R16]. Tout texte reçu est posé en texte ; un champ mal formé
 * n'est pas montré. Une lecture arrivée après la fin de la session est jetée. Rien n'est gardé sur l'appareil.
 */
import { REPORT_GROUPINGS, REPORT_MEASURES } from '../../core/src/rapports/rapports.ts';

export const RAPPORTS_ROLE = 'Ce n’est pas dans vos droits : la direction lit le total du réseau ou un agent de son réseau.';
export const RAPPORTS_OFFLINE = 'Pas de réseau. Réessayez dans un moment.';
export const RAPPORTS_READ_LOST = 'Les rapports n’ont pas pu être lus. Rouvrez l’écran dans un moment.';
export const RAPPORTS_LOST = 'La réponse n’est pas arrivée. Réessayez dans un moment.';
export const RAPPORTS_FAILED = 'Le serveur n’a pas répondu comme prévu. Réessayez dans un moment.';
export const RAPPORTS_UNCHECKED = 'non vérifiable';
export const RAPPORTS_UNCHECKED_NOTE = 'Un chiffre ne tombe pas juste sur ses lignes : il n’est pas montré. Relisez le rapport dans un moment.';
export const RAPPORTS_NO_MEASURE = 'Cochez au moins une mesure.';
export const RAPPORTS_BAD_PERIOD = 'La période : un jour de début avant le jour de fin, un an au plus.';
export const RAPPORTS_BAD_NAME = 'Le nom du rapport : de 1 à 80 caractères.';
export const RAPPORTS_NEVER_TWO = 'Un rapport se lit pour le total du réseau ou pour un seul agent, jamais deux agents côte à côte.';

export const RAPPORTS_AGENT_ROLE = 'Ce n’est pas dans vos droits : un agent lit ses propres chiffres.';
export const RAPPORTS_AGENT_INACTIVE = 'Votre compte n’est pas en activité : vos rapports ne se lisent pas.';
export const RAPPORTS_AGENT_ONLY = 'Vos chiffres seulement, jamais comparés à ceux de personne.';

export const RAPPORTS_MEASURES: Readonly<Record<(typeof REPORT_MEASURES)[number], string>> = Object.freeze({
  contacts: 'Contacts attribués',
  rendez_vous: 'Rendez-vous tenus',
  mandats: 'Mandats signés',
  ventes: 'Ventes conclues',
});
export const RAPPORTS_GROUPINGS: Readonly<Record<(typeof REPORT_GROUPINGS)[number], string>> = Object.freeze({
  total: 'Le total de la période',
  mois: 'Mois par mois (heure de Paris)',
});

export const RAPPORTS_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  role: RAPPORTS_ROLE,
  agent_inactive: RAPPORTS_ROLE,
  other_network: 'Cet agent n’est pas de votre réseau.',
  unknown: 'Cet agent n’est plus dans la liste : l’écran est relu.',
  compares_agents: RAPPORTS_NEVER_TWO,
  bad_definition: 'Ce rapport ne se compose pas ainsi : choisissez des mesures et un regroupement de la liste.',
  bad_measures: RAPPORTS_NO_MEASURE,
  bad_grouping: 'Choisissez le total ou mois par mois.',
  bad_period: RAPPORTS_BAD_PERIOD,
  bad_name: RAPPORTS_BAD_NAME,
  unknown_report: 'Ce rapport enregistré n’existe plus : l’écran est relu.',
  invalid_body: 'La demande n’a pas pu être envoyée.',
  unknown_field: 'La demande n’a pas pu être envoyée.',
});

/** Les refus que l'agent peut lire : ceux de la portée n'en sont pas, il n'en choisit aucune [R68]. */
export const RAPPORTS_AGENT_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  ...Object.fromEntries(Object.entries(RAPPORTS_REFUSALS).filter(([k]) => !['other_network', 'unknown'].includes(k))),
  role: RAPPORTS_AGENT_ROLE,
  agent_inactive: RAPPORTS_AGENT_INACTIVE,
  compares_agents: RAPPORTS_AGENT_ONLY,
});

/**
 * Le script d'un écran, fait par le même code pour les deux : la direction (`mine` faux) lit sous `/v1/finances/rapports`
 * et la liste des agents ; l'agent (`mine` vrai) ne lit que sous `/v1/finances/rapports`, sans portée, ses seuls chiffres
 * [R16, R68]. Le texte de l'un ne contient rien de ce qui n'est qu'à l'autre.
 */
const rapportsScript = (mine: boolean): string => `'use strict';
globalThis.${mine ? 'AIMMO_RAPPORTS_AGENT' : 'AIMMO_RAPPORTS'} = function (t) {
  var el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field, date = t.date;
  var select = t.select || function (box, id, label, options, value) {
    var s = field(box, id, label, 'select');
    Object.keys(options).forEach(function (k) { var o = el('option', options[k]); o.value = k; s.appendChild(o); });
    s.value = value;
    return s;
  };
  var details = t.details || function (box, title) { var d = el('details'); d.appendChild(el('summary', title)); box.appendChild(d); return d; };
  var REFUSALS = ${JSON.stringify(mine ? RAPPORTS_AGENT_REFUSALS : RAPPORTS_REFUSALS)}, MEASURES = ${JSON.stringify(RAPPORTS_MEASURES)}, GROUPINGS = ${JSON.stringify(RAPPORTS_GROUPINGS)};
  var ORDER = ${JSON.stringify(REPORT_MEASURES)};
  var ROLE = ${JSON.stringify(mine ? RAPPORTS_AGENT_ROLE : RAPPORTS_ROLE)}, OFFLINE = ${JSON.stringify(RAPPORTS_OFFLINE)}, READ_LOST = ${JSON.stringify(RAPPORTS_READ_LOST)};
  var LOST = ${JSON.stringify(RAPPORTS_LOST)}, FAILED = ${JSON.stringify(RAPPORTS_FAILED)}, UNCHECKED = ${JSON.stringify(RAPPORTS_UNCHECKED)}, UNCHECKED_NOTE = ${JSON.stringify(RAPPORTS_UNCHECKED_NOTE)};
  var NO_MEASURE = ${JSON.stringify(RAPPORTS_NO_MEASURE)}, BAD_PERIOD = ${JSON.stringify(RAPPORTS_BAD_PERIOD)}, BAD_NAME = ${JSON.stringify(RAPPORTS_BAD_NAME)}, NEVER_TWO = ${JSON.stringify(mine ? RAPPORTS_AGENT_ONLY : RAPPORTS_NEVER_TWO)};
  /* Sous les engagements de la direction, les titres suivent son h4 ; sous « Mes chiffres », le h2 de l'écran [R201]. */
  var HEAD = '${mine ? 'h3' : 'h5'}';
  var R = '/v1/finances/rapports'${mine ? '' : ", AGENTS = '/v1/gagner/recommandations/agents'"};
  var ID = /^[A-Za-z0-9_-]{1,64}$/, DAY = /^\\d{4}-\\d{2}-\\d{2}$/, MONTH = /^\\d{4}-\\d{2}$/;
  var box = null, status = null, body = null, result = null, busy = false, reads = 0, asked = 0;
  var checks = {}, grouping = null, from = null, to = null, scope = null, name = null, agents = [], me = null;
  function say(text) { if (status) status.textContent = text; }
  function owns(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function today() {
    try { return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }); } catch (e) { return new Date().toISOString().slice(0, 10); }
  }
  function validDay(v) {
    if (typeof v !== 'string' || !DAY.test(v)) return false;
    var d = new Date(v + 'T12:00:00Z');
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }
  /* Les 12 derniers mois de Paris : du premier jour du mois d'il y a 11 mois à aujourd'hui, moins d'un an. */
  function yearAgo(day) {
    var y = Number(day.slice(0, 4)), m = Number(day.slice(5, 7)) - 11;
    if (m < 1) { m += 12; y -= 1; }
    return y + '-' + String(m + 100).slice(1) + '-01';
  }
  function dayText(at) { return validDay(at) ? date(at + 'T12:00:00Z') : date(at); }
  function monthText(key) {
    if (key === 'total') return 'Total de la période';
    var d = new Date(key + '-15T12:00:00Z');
    try { return d.toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', month: 'long', year: 'numeric' }); } catch (e) { return key; }
  }
  function refusal(res) {
    var b = res.body, code = b && typeof b.code === 'string' ? b.code : null;
    return code && owns(REFUSALS, code) ? REFUSALS[code] : FAILED;
  }
  function data(res) { return res && res.ok && res.body && owns(res.body, 'data') ? res.body.data : undefined; }
  function agentName(id) {
    for (var i = 0; i < agents.length; i++) if (agents[i].agentId === id) return agents[i].firstName + ' ' + agents[i].lastName;
    return null;
  }
  /* La composition choisie, ou un message qui dit ce qui manque : rien ne part tant qu'elle n'est pas juste. */
  function composed() {
    var measures = ORDER.filter(function (m) { return checks[m] && checks[m].checked; });
    if (!measures.length) return NO_MEASURE;
    if (!owns(GROUPINGS, grouping.value)) return REFUSALS.bad_grouping;
    var d = period();
    return d ? { measures: measures, grouping: grouping.value, from: d.from, to: d.to } : BAD_PERIOD;
  }
  function period() {
    var a = String(from.value || '').trim(), b = String(to.value || '').trim();
    if (!validDay(a) || !validDay(b) || a > b || (Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000 >= 366) return null;
    return { from: a, to: b };
  }
  /* La portée : le total du réseau, ou un seul agent de la liste ; jamais les deux [R14]. */
  function portee() {
    ${mine ? 'return {};' : "var v = scope.value;\n    if (v === '') return { network: true };\n    return ID.test(v) && agentName(v) ? { agentId: v } : null;"}
  }
  function wipe() { reads += 1; if (result) clear(result); }
  function cells(r, wanted) {
    if (!r || !Array.isArray(r.cells) || !r.definition || !Array.isArray(r.definition.measures)) return null;
    var ok = [];
    for (var i = 0; i < r.cells.length; i++) {
      var c = r.cells[i];
      if (!c || !owns(MEASURES, c.measure) || typeof c.key !== 'string' || !(c.key === 'total' || MONTH.test(c.key))) return null;
      var lines = Array.isArray(c.lines) ? c.lines.filter(function (l) { return l && ID.test(l.id) && typeof l.at === 'string' && dayText(l.at); }) : [];
      /* Le chiffre se recompte ici, sur les lignes reçues : faux, il n'est pas montré [R69]. */
      var checked = Array.isArray(c.lines) && typeof c.value === 'number' && c.value === c.lines.length && lines.length === c.lines.length;
      ok.push({ measure: c.measure, key: c.key, value: checked ? c.value : null, lines: checked ? lines : [] });
    }
    return wanted.definition.measures.every(function (m) { return ok.some(function (c) { return c.measure === m; }); }) ? ok : null;
  }
  function show(r, ask) {
    clear(result);
    var list = cells(r, ask);
    if (!list) { result.appendChild(el('p', READ_LOST, 'etat')); return; }
    var who = ${mine ? "'Mes chiffres seulement'" : "ask.network ? 'Total du réseau' : 'Agent : ' + agentName(ask.agentId)"};
    result.appendChild(el(HEAD, who));
    result.appendChild(el('p', 'Du ' + dayText(ask.from) + ' au ' + dayText(ask.to) + '. Chaque chiffre s’ouvre sur ses lignes : vous pouvez tout recompter.', 'doux'));
    var keys = [];
    list.forEach(function (c) { if (keys.indexOf(c.key) < 0) keys.push(c.key); });
    var ul = el('ul', null, 'liste'), wrong = false;
    keys.forEach(function (k) {
      var li = el('li');
      li.appendChild(el('strong', monthText(k)));
      list.filter(function (c) { return c.key === k; }).forEach(function (c) {
        if (c.value === null) { wrong = true; li.appendChild(el('p', MEASURES[c.measure] + ' : ' + UNCHECKED, 'etat')); return; }
        if (!c.value) { li.appendChild(el('p', MEASURES[c.measure] + ' : 0', 'doux')); return; }
        var d = details(li, MEASURES[c.measure] + ' : ' + c.value);
        var lines = el('ul', null, 'liste');
        c.lines.forEach(function (l) { lines.appendChild(el('li', l.id + ' · ' + dayText(l.at))); });
        d.appendChild(lines);
      });
      ul.appendChild(li);
    });
    result.appendChild(ul);
    if (wrong) result.appendChild(el('p', UNCHECKED_NOTE, 'retard'));
  }
  /* Une lecture : la portée et la période de l'écran au moment du geste ; une réponse d'une autre est jetée. */
  function read(path, payload, ask) {
    if (busy) return;
    var mine = t.session(), n = ++reads;
    busy = true;
    clear(result);
    say('Lecture du rapport…');
    send(path, 'POST', payload).then(function (res) {
      busy = false;
      if (res.gone || mine !== t.session() || n !== reads) return;
      if (res.offline || !res.body) { say(LOST); return; }
      if (!res.ok) { say(res.status >= 500 ? FAILED : refusal(res)); return; }
      var r = data(res);
      var same = r && ${mine ? "r.scope === 'agent' && ID.test(r.agentId) && (me === null || r.agentId === me)" : "(ask.network ? r.scope === 'reseau' && r.agentId === undefined : r.scope === 'agent' && r.agentId === ask.agentId)"} && r.from === ask.from && r.to === ask.to;
      if (!same) { say(READ_LOST); return; }
      ${mine ? '/* La première lecture dit qui est l’agent ; une réponse pour un autre est jetée [R14, R68]. */\n      me = r.agentId;' : ''}
      say('');
      show(r, ask);
    });
  }
  function readNow() {
    var c = composed(), p = portee();
    if (typeof c === 'string') { say(c); return; }
    if (!p) { say(REFUSALS.unknown); return; }
    var ask = { from: c.from, to: c.to, network: p.network === true, agentId: p.agentId, definition: { measures: c.measures, grouping: c.grouping } };
    read(R + '/lecture', Object.assign({ definition: { measures: c.measures, grouping: c.grouping }, from: c.from, to: c.to }, p), ask);
  }
  function readSaved(rep) {
    var d = period(), p = portee();
    if (!d) { say(BAD_PERIOD); return; }
    if (!p) { say(REFUSALS.unknown); return; }
    read(R + '/' + encodeURIComponent(rep.id) + '/lecture', Object.assign({ from: d.from, to: d.to }, p), { from: d.from, to: d.to, network: p.network === true, agentId: p.agentId, definition: rep.definition });
  }
  function save() {
    if (busy) return;
    var ms = ORDER.filter(function (m) { return checks[m] && checks[m].checked; });
    if (!ms.length) { say(NO_MEASURE); return; }
    if (!owns(GROUPINGS, grouping.value)) { say(REFUSALS.bad_grouping); return; }
    var n = String(name.value || '').trim();
    if (n.length < 1 || n.length > 80) { say(BAD_NAME); return; }
    var mine = t.session();
    busy = true;
    say('Envoi…');
    send(R, 'POST', { name: n, definition: { measures: ms, grouping: grouping.value } }).then(function (res) {
      busy = false;
      if (res.gone || mine !== t.session()) return;
      if (res.offline || !res.body) { load('La réponse n’est pas arrivée : le rapport a pu s’enregistrer. La liste est relue : vérifiez-la avant de recommencer.'); return; }
      if (!res.ok) { say(res.status >= 500 ? FAILED : refusal(res)); return; }
      name.value = '';
      load('Rapport « ' + n + ' » enregistré : il ne change plus, et vous seul le relisez.');
    });
  }
  function compose() {
    var p = el('section', null, 'bloc');
    p.appendChild(el(HEAD, 'Composer un rapport'));
    p.appendChild(el('p', 'Des mesures, un regroupement, une période d’un an au plus. ' + NEVER_TWO, 'doux'));
    ORDER.forEach(function (m) {
      var wrap = el('div', null, 'case'), c = el('input'), l = el('label', MEASURES[m]);
      c.setAttribute('type', 'checkbox');
      c.setAttribute('id', '${mine ? 'mes-rapports' : 'rapports'}-' + m);
      l.setAttribute('for', '${mine ? 'mes-rapports' : 'rapports'}-' + m);
      c.checked = m === 'contacts' || m === 'mandats';
      wrap.appendChild(c);
      wrap.appendChild(l);
      p.appendChild(wrap);
      checks[m] = c;
    });
    grouping = select(p, '${mine ? 'mes-rapports' : 'rapports'}-regroupement', 'Regroupement', GROUPINGS, 'mois');
    var end = today();
    from = field(p, '${mine ? 'mes-rapports' : 'rapports'}-du', 'Du');
    from.setAttribute('type', 'date');
    from.value = yearAgo(end);
    to = field(p, '${mine ? 'mes-rapports' : 'rapports'}-au', 'Au');
    to.setAttribute('type', 'date');
    to.value = end;
${mine ? '' : `    var options = { '': 'Le total du réseau' };
    agents.forEach(function (a) { options[a.agentId] = a.firstName + ' ' + a.lastName; });
    scope = select(p, '${mine ? 'mes-rapports' : 'rapports'}-portee', 'Pour', options, '');
    /* Changer de portée efface le rapport affiché, avant toute lecture : jamais deux agents à l'écran [R14]. */
    scope.addEventListener('change', function () { wipe(); busy = false; say(''); });
`}    p.appendChild(button('Lire le rapport', readNow));
    name = field(p, '${mine ? 'mes-rapports' : 'rapports'}-nom', 'Nom, pour l’enregistrer (80 caractères au plus)');
    p.appendChild(button('Enregistrer ce rapport', save));
    return p;
  }
  function saved(list) {
    var p = el('section', null, 'bloc');
    p.appendChild(el(HEAD, 'Mes rapports enregistrés'));
    if (!Array.isArray(list)) { p.appendChild(el('p', READ_LOST, 'etat')); return p; }
    var ok = list.filter(function (r) {
      return r && ID.test(r.id) && typeof r.name === 'string' && r.name.trim() && r.definition && Array.isArray(r.definition.measures) && r.definition.measures.length && r.definition.measures.every(function (m) { return owns(MEASURES, m); }) && owns(GROUPINGS, r.definition.grouping);
    });
    if (!ok.length) { p.appendChild(el('p', 'Aucun rapport enregistré.', 'doux')); return p; }
    p.appendChild(el('p', 'Chacun se relit sur la période et pour la portée choisies ci-dessus.', 'doux'));
    var ul = el('ul', null, 'liste');
    ok.forEach(function (r) {
      var li = el('li');
      li.appendChild(el('strong', r.name));
      li.appendChild(el('p', r.definition.measures.map(function (m) { return MEASURES[m]; }).join(', ') + ' · ' + GROUPINGS[r.definition.grouping], 'doux'));
      li.appendChild(button('Relire « ' + r.name + ' »', function () { readSaved(r); }));
      ul.appendChild(li);
    });
    p.appendChild(ul);
    return p;
  }
  function load(message) {
    var mine = t.session(), n = ++asked;
    if (!message) say('Chargement…');
    return Promise.all([send(R, 'GET')${mine ? '' : ", send(AGENTS, 'GET')"}]).then(function (all) {
      if (mine !== t.session() || n !== asked || all.some(function (x) { return x.gone; })) return false;
      clear(body);
      if (all.some(function (x) { return !x.offline && x.body && x.body.code === 'role'; })) { say(ROLE); return false; }
      if (all.every(function (x) { return x.offline; })) { say(message || OFFLINE); return false; }
${mine ? "      say(message || '');\n" : `      var a = data(all[1]);
      agents = Array.isArray(a) ? a.filter(function (x) { return x && ID.test(x.agentId) && typeof x.firstName === 'string' && typeof x.lastName === 'string'; }) : [];
      say(message || (Array.isArray(a) ? '' : 'La liste des agents n’a pas pu être lue : seul le total du réseau se lit.'));
`}      reads += 1;
      busy = false;
      body.appendChild(compose());
      result = el('div');
      result.setAttribute('aria-live', 'polite');
      body.appendChild(result);
      body.appendChild(saved(data(all[0])));
      return true;
    });
  }
  function mount(inner, said) {
    clear(inner);
    box = el('div', null, 'rapports');
    status = said || el('p', null, 'etat');
    if (!said) { status.setAttribute('role', 'status'); box.appendChild(status); }
    body = el('div');
    box.appendChild(body);
    inner.appendChild(box);
    busy = false;
    me = null;
    return load('');
  }
  /* La direction l'ouvre sous les engagements (\`show\`) ; l'agent par le chargeur commun de « Mes chiffres » (\`open\`). */
  return { show: mount, open: function (_id, inner, said) { return mount(inner, said); } };
};
`;

/** Le script servi à part pour la direction. Il ne lit et n'écrit que sous `/v1/finances/rapports`, et lit la liste des agents [R16]. */
export const RAPPORTS_SCRIPT = rapportsScript(false);
/** Le script servi à part pour l'agent, depuis « Mes chiffres » : ses seuls rapports, sans portée ni liste des agents [R68]. */
export const RAPPORTS_AGENT_SCRIPT = rapportsScript(true);
