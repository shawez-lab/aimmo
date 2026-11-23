/**
 * Les phases et les régions sur l'écran du réseau (BR13, BR14) : la direction lit l'état des cinq phases (HX71) et ouvre la
 * suivante, lit les 18 régions (HX72), en ouvre ou en ferme une avec sa raison, et vérifie la chaîne des décisions.
 * Script servi à part (`/app/phases.js`), chargé au premier geste [R201]. Chaque condition et chaque refus se disent en
 * mots, jamais par un code. Ouvrir une phase ne se défait pas : deux appuis, et seulement quand le serveur dit que
 * c'est possible ; c'est lui qui relit la condition à l'instant [R647]. Tout texte reçu est posé en texte.
 * BR14 : la direction y lit aussi la comparaison des agents pilotes (HX69) et la série de la phase 1 (HX70), désigne un
 * pilote, range ses mois d'avant avec la référence de la preuve, range un envoi constaté hors d'AIMMO (deux appuis : il
 * n'est jamais retiré) et l'inventaire des tâches planifiées, par les routes de BR10. Une saisie illisible ne part pas.
 */

const REFUSALS: Record<string, string> = {
  role: 'Ce n’est pas dans vos droits.',
  invalid_body: 'La demande n’a pas pu être lue. Rechargez l’écran.',
  unknown_field: 'La demande n’a pas pu être lue. Rechargez l’écran.',
  bad_shape: 'La demande n’a pas pu être lue. Rechargez l’écran.',
  bad_phase: 'Cette phase ne se reconnaît pas : relisez la liste.',
  deja_ouverte: 'C’est déjà ouvert : relisez la liste.',
  deja_fermee: 'Cette région est déjà fermée : relisez la liste.',
  phase_precedente_fermee: 'La phase d’avant n’est pas encore ouverte.',
  condition_non_remplie: 'La condition de la phase d’avant n’est pas remplie à cet instant.',
  condition_inconnue: 'La condition de la phase d’avant ne se lit pas à cet instant : rien ne s’ouvre dans le doute.',
  region_inconnue: 'Cette région ne se reconnaît pas : relisez la liste.',
  region_d_origine: 'La Bourgogne-Franche-Comté est ouverte d’office et ne se ferme pas.',
  bad_open: 'Dites s’il faut ouvrir ou fermer.',
  bad_reason: 'La raison : de 3 à 200 caractères.',
  phase5_fermee: 'La phase 5 n’est pas ouverte : aucune nouvelle région ne s’ouvre avant.',
  region_recente: 'Une autre région s’est ouverte il y a moins de 90 jours.',
  conflit: 'Une autre décision vient de passer : relisez la liste, puis recommencez.',
  bad_agent: 'Donnez l’identifiant de l’agent.',
  agent_inconnu: 'Cet agent ne se trouve pas dans le réseau.',
  agent_parti: 'Cet agent n’est plus actif : il ne peut pas être pilote.',
  trop_tard: 'Sa mesure a déjà commencé : un pilote se désigne avant le 1er du mois qui suit son arrivée.',
  deja_pilote: 'Cet agent est déjà pilote.',
  pas_pilote: 'Cet agent n’est pas pilote : désignez-le d’abord.',
  bad_months: 'Chaque mois d’avant : un nombre entier de mandats, de 0 à 500.',
  bad_proof: 'La référence de la preuve : de 3 à 200 lettres, chiffres ou / _ . : -, sans espace.',
  bad_day: 'Le jour : une date depuis le 1er janvier 2026, jamais dans le futur.',
  bad_application: 'Choisissez l’application où l’envoi a été constaté.',
  bad_tasks: 'Chaque application : un nombre entier de tâches, de 0 à 1000, même à zéro.',
};
const PILOT_STATUS: Record<string, string> = {
  en_cours: 'Mesure en cours.',
  parti: 'Parti avant la fin de sa mesure.',
  avant_non_declare: 'Mois d’avant pas déclarés à temps : il ne pourra pas compter.',
  plus: 'Signe plus qu’avant son arrivée.',
  pas_plus: 'Ne signe pas plus qu’avant son arrivée.',
};
/** Les applications de l'inventaire et des envois constatés hors d'AIMMO (HX70), dans l'ordre du serveur. */
const APPS: [string, string][] = [
  ['gohighlevel', 'GoHighLevel'],
  ['manychat', 'ManyChat'],
  ['site', 'Le site'],
  ['github_actions', 'GitHub Actions'],
  ['autre', 'Autre application'],
];
const CONDITIONS: Record<string, string> = {
  remplie: 'Condition remplie',
  non_remplie: 'Condition pas encore remplie',
  inconnue: 'Condition illisible pour le moment : comptée comme non remplie',
  sans_condition: 'Dernière phase : pas de condition après elle',
};
/** Les raisons rendues par les modules des conditions (HX65, HX69, HX70, IN02, HX71) : toujours dites en mots. */
const CONDITION_REASONS: Record<string, string> = {
  lecture_impossible: 'La condition ne se lit pas pour le moment.',
  inventaire_absent: 'L’inventaire des tâches planifiées hors d’AIMMO n’est pas rangé.',
  taches_planifiees: 'Des tâches sont encore planifiées hors d’AIMMO.',
  serie_trop_courte: 'Moins de 30 jours de suite sans aucun envoi hors règles.',
  chaine_abimee: 'La chaîne des sceaux de la preuve est abîmée.',
  registre_abime: 'Le registre des mandats est abîmé.',
  serie_publiee_trop_courte: 'Pas encore assez de mois publiés de suite.',
  moins_de_3_pilotes: 'Moins de 3 agents pilotes.',
  pilote_en_cours: 'Un agent pilote est encore en cours de mesure.',
  pilote_parti: 'Un agent pilote est parti.',
  avant_non_declare: 'Un agent pilote n’a pas encore ses mois d’avant déclarés.',
  pas_plus: 'Un agent pilote ne signe pas plus qu’avant son arrivée.',
  phase_non_ouverte: 'La phase n’est pas encore ouverte.',
  pas_assez_de_mois: 'Pas encore 3 mois finis depuis l’ouverture de la phase.',
  mois_incomplet: 'Un des 3 derniers mois n’est pas complet.',
  mois_non_couvert: 'Sur un des 3 derniers mois, la part du réseau ne couvre pas le coût complet de l’agent moyen.',
};
const OPENABLE_REASONS: Record<string, string> = {
  phase5_fermee: 'la phase 5 n’est pas ouverte',
  region_recente: 'une autre région s’est ouverte il y a moins de 90 jours',
};

export const PHASES_ENTRY_HTML = `<section class="bloc" aria-labelledby="titre-phases">
<h3 id="titre-phases">Phases et régions</h3>
<p class="doux">Chaque phase ne s’ouvre que sur la preuve de la précédente, lue à l’instant. Les régions s’ouvrent une par une, ensuite.</p>
<button id="phases-voir" type="button" class="secondaire">Voir les phases et les régions</button>
<p id="phases-etat" class="etat" role="status"></p>
<div id="phases-corps"></div>
</section>
`;

/** Le chargeur posé dans le script de l'application : l'écran est servi à part, chargé une fois, jamais gardé. */
export const PHASES_JS = `
  /* ---------- Les phases et les régions sur l'écran du réseau (BR13), chargées au premier geste [R16, R201, R647]. ---------- */
  function wipePhases() {
    clear($('phases-corps'));
    $('phases-etat').textContent = '';
  }
  function withPhases(act) {
    return withTool('phases', 'AIMMO_PHASES', 'phases-etat', 'reseau', act, function () { return { $: $, el: el, clear: clear, send: send, button: button, field: field, date: date, session: function () { return session; } }; });
  }
`;

/** Le script servi à part (`/app/phases.js`). Il ne lit et n'écrit que `/v1/phases` et `/v1/regions` [R16]. */
export const PHASES_SCRIPT = `'use strict';
globalThis.AIMMO_PHASES = function (t) {
  var $ = t.$, el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field, date = t.date;
  var REFUSALS = ${JSON.stringify(REFUSALS)};
  var CONDITIONS = ${JSON.stringify(CONDITIONS)};
  var OPENABLE_REASONS = ${JSON.stringify(OPENABLE_REASONS)};
  var CONDITION_REASONS = ${JSON.stringify(CONDITION_REASONS)};
  var PILOT_STATUS = ${JSON.stringify(PILOT_STATUS)};
  var APPS = ${JSON.stringify(APPS)};
  var MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  /* Mêmes formes que le serveur : une saisie illisible ne part pas. */
  var PROOF = new RegExp('^[A-Za-z0-9][A-Za-z0-9/_.:-]{2,199}$');
  var AGENT = new RegExp('^[A-Za-z0-9_.:-]{1,100}$');
  var DAY = new RegExp('^[0-9]{4}-[0-9]{2}-[0-9]{2}$');
  var WHOLE = new RegExp('^[0-9]{1,4}$');
  var OFFLINE = 'Pas de réseau. Réessayez dans un moment.';
  /* Une écriture sans réponse, ou coupée par une panne du serveur, a pu passer : l'écran ne dit ni fait ni pas fait. */
  var LOST = 'La réponse n’est pas arrivée : rien n’est sûr. Relisez l’écran avant de recommencer.';
  var busy = null, showing = 0;
  function state(text) { $('phases-etat').textContent = text; }
  function once(work) {
    var mine = t.session();
    if (busy === mine) return Promise.resolve(false);
    busy = mine;
    function done(r) { if (busy === mine) busy = null; return r; }
    return work().then(done, function () { return done(false); });
  }
  function why(res, fallback) {
    if (res.offline) return OFFLINE;
    var b = res.body || {};
    var text = REFUSALS[b.code] || fallback;
    if (b.code === 'region_recente' && b.until) text += ' Prochaine ouverture possible le ' + date(b.until) + '.';
    return text;
  }
  function write(path, payload, okText, failText) {
    return once(function () {
      state('Envoi…');
      return send(path, 'POST', payload).then(function (x) {
        if (x.gone) return false;
        if (x.offline || !x.body || x.status >= 500) { state(LOST); return false; }
        if (!x.ok) { state(why(x, failText)); return false; }
        return show(okText);
      });
    });
  }
  /* Ouvrir une phase ne se défait pas : un premier appui demande la confirmation, le second envoie. */
  function openButton(box, phase, name) {
    var b = button('Ouvrir la phase ' + phase + ' : ' + name, function () {
      if (!b.armed) {
        b.armed = true;
        b.textContent = 'Confirmer : la phase ' + phase + ' ouverte ne se referme pas';
        return;
      }
      write('/v1/phases/ouvrir', { phase: phase }, 'Phase ' + phase + ' ouverte : la preuve lue à l’instant est rangée.', 'La phase n’est pas ouverte.');
    });
    box.appendChild(b);
  }
  function renderPhases(body, report) {
    body.appendChild(el('h4', 'Les cinq phases'));
    var ul = el('ul', null, 'liste');
    report.phases.forEach(function (p, i) {
      var li = el('li');
      li.appendChild(el('strong', 'Phase ' + p.phase + ' · ' + p.name));
      var since = !p.open ? 'Fermée.' : p.opening ? 'Ouverte le ' + date(p.opening.openedAt) + '.' : 'Ouverte d’office.';
      li.appendChild(el('p', since, 'doux'));
      if (p.open) {
        li.appendChild(el('p', CONDITIONS[p.condition.state] || CONDITIONS.inconnue));
        /* Un code que l'écran ne connaît pas encore n'est jamais montré tel quel. */
        (p.condition.reasons || []).forEach(function (r) { li.appendChild(el('p', CONDITION_REASONS[r] || 'Une autre raison, que cet écran ne sait pas encore dire.', 'doux')); });
      }
      if (p.fellSince) li.appendChild(el('p', 'Retombée : la phase suivante est ouverte, mais cette condition ne se lit plus remplie. Rien ne se ferme seul.', 'alerte'));
      var next = report.phases[i + 1];
      if (p.nextOpenable && next && !next.open) openButton(li, next.phase, next.name);
      ul.appendChild(li);
    });
    body.appendChild(ul);
  }
  function renderRegions(body, report) {
    body.appendChild(el('h4', 'Les régions'));
    var o = report.openable;
    body.appendChild(el('p', o.ok ? 'Une nouvelle région peut s’ouvrir maintenant.' : 'Aucune nouvelle région ne s’ouvre maintenant : ' + o.reasons.map(function (r) { return OPENABLE_REASONS[r] || 'raison inconnue'; }).join(', ') + (o.until ? ', jusqu’au ' + date(o.until) : '') + '.', 'doux'));
    var ul = el('ul', null, 'liste');
    report.regions.forEach(function (r, i) {
      var li = el('li');
      li.appendChild(el('strong', r.name));
      var line = r.home ? 'Ouverte d’office : la région d’origine.' : r.open ? 'Ouverte le ' + date(r.openSince) + ', version ' + r.version + '.' : r.version ? 'Fermée, version ' + r.version + '.' : 'Fermée.';
      li.appendChild(el('p', line, 'doux'));
      if (!r.home && (r.open || o.ok)) {
        var d = el('details');
        d.appendChild(el('summary', r.open ? 'Fermer cette région' : 'Ouvrir cette région'));
        var reason = field(d, 'region-raison-' + i, 'La raison, de 3 à 200 caractères');
        reason.setAttribute('maxlength', '200');
        d.appendChild(button(r.open ? 'Fermer ' + r.name : 'Ouvrir ' + r.name, function () {
          var text = String(reason.value || '').trim();
          if (text.length < 3 || text.length > 200) { state(REFUSALS.bad_reason); return; }
          write('/v1/regions/decision', { region: r.code, open: !r.open, reason: text }, r.name + (r.open ? ' fermée.' : ' ouverte.') + ' La décision s’ajoute à la chaîne.', 'La décision n’est pas rangée.');
        }));
        li.appendChild(d);
      }
      ul.appendChild(li);
    });
    body.appendChild(ul);
    var check = el('p', null, 'doux');
    body.appendChild(button('Vérifier la chaîne des décisions', function () { verify(check); }));
    body.appendChild(check);
  }
  function month(m) {
    var p = String(m || '').split('-');
    var i = Number(p[1]) - 1;
    return MONTHS[i] ? MONTHS[i] + ' ' + p[0] : '';
  }
  function day(d) { return DAY.test(String(d)) ? date(d + 'T12:00:00.000Z') : ''; }
  function proofOf(input) {
    var v = String(input.value || '').trim();
    return PROOF.test(v) && v.indexOf('..') < 0 ? v : null;
  }
  function whole(input, max) {
    var v = String(input.value || '').trim();
    if (!WHOLE.test(v)) return null;
    var n = Number(v);
    return n <= max ? n : null;
  }
  function numberField(box, id, label) {
    var f = field(box, id, label);
    f.setAttribute('inputmode', 'numeric');
    return f;
  }
  function reasonsOf(box, condition, yes) {
    if (condition.met) { box.appendChild(el('p', yes)); return; }
    (condition.reasons || []).forEach(function (r) { box.appendChild(el('p', CONDITION_REASONS[r] || 'Une autre raison, que cet écran ne sait pas encore dire.', 'doux')); });
  }
  function renderPilots(body, report) {
    body.appendChild(el('h4', 'Les agents pilotes'));
    body.appendChild(el('p', 'Chacun comparé à lui-même : ses 3 mois d’avant, déclarés avec leur preuve, contre ses 3 mois d’après, lus dans le registre. Il en faut au moins ' + report.minimum + ', tous finis, tous en hausse.', 'doux'));
    reasonsOf(body, report.condition, 'Condition des pilotes remplie.');
    var ul = el('ul', null, 'liste');
    report.pilots.forEach(function (p, i) {
      var li = el('li');
      li.appendChild(el('strong', 'Agent ' + p.agentId));
      li.appendChild(el('p', 'Arrivé le ' + date(p.arrivedAt) + ' ; mesuré jusqu’à fin ' + month(p.measureEndMonth) + '.', 'doux'));
      li.appendChild(el('p', PILOT_STATUS[p.status] || 'État que cet écran ne sait pas encore dire.'));
      li.appendChild(el('p', p.before ? 'Avant : ' + p.beforeMonths.map(function (m, j) { return month(m) + ' ' + p.before[j]; }).join(', ') + ' ; total ' + p.beforeTotal + '.' : 'Avant : aucune déclaration rangée à temps.', 'doux'));
      li.appendChild(el('p', 'Après : ' + p.after.map(function (m) { return month(m.month) + ' ' + m.counted; }).join(', ') + ' ; total ' + p.afterTotal + '.', 'doux'));
      li.appendChild(el('p', 'Mois d’arrivée, à part : ' + p.arrivalMonthCounted + ' ; retirés (erreur ou rétractation) : ' + p.withdrawnOrCancelled + '.', 'doux'));
      var late = p.declarations.filter(function (d) { return !d.inTime; }).length;
      if (late) li.appendChild(el('p', late + ' déclaration(s) rangée(s) après le début de la mesure : gardée(s), jamais comptée(s).', 'alerte'));
      var d = el('details');
      d.appendChild(el('summary', 'Déclarer ses mois d’avant'));
      var inputs = p.beforeMonths.map(function (m, j) { return numberField(d, 'pilote-' + i + '-mois-' + j, 'Mandats signés en ' + month(m)); });
      var proof = field(d, 'pilote-' + i + '-preuve', 'Référence de la preuve');
      d.appendChild(button('Ranger les mois d’avant', function () {
        var months = inputs.map(function (f) { return whole(f, 500); });
        if (months.some(function (n) { return n === null; })) { state(REFUSALS.bad_months); return; }
        var ref = proofOf(proof);
        if (!ref) { state(REFUSALS.bad_proof); return; }
        write('/v1/phases/pilotes/avant', { agentId: p.agentId, months: months, proofRef: ref }, 'Mois d’avant rangés : une nouvelle version s’ajoute, rien n’est effacé.', 'Les mois d’avant ne sont pas rangés.');
      }));
      li.appendChild(d);
      ul.appendChild(li);
    });
    body.appendChild(ul);
    var add = el('details');
    add.appendChild(el('summary', 'Désigner un pilote'));
    add.appendChild(el('p', 'Avant le 1er du mois qui suit son arrivée. Un pilote n’est jamais retiré.', 'doux'));
    var who = field(add, 'pilote-agent', 'Identifiant de l’agent');
    add.appendChild(button('Désigner comme pilote', function () {
      var id = String(who.value || '').trim();
      if (!AGENT.test(id)) { state(REFUSALS.bad_agent); return; }
      write('/v1/phases/pilotes', { agentId: id }, 'Pilote désigné.', 'Le pilote n’est pas désigné.');
    }));
    body.appendChild(add);
  }
  var DAY_STATUS = { hors_regles: 'hors règles', sans_donnee: 'sans donnée' };
  function renderPhase1(body, report) {
    body.appendChild(el('h4', 'La phase 1 : 30 jours sans envoi hors règles'));
    reasonsOf(body, report.condition, 'Condition de la phase 1 remplie.');
    body.appendChild(el('p', report.countedSeries + ' jour(s) propre(s) de suite qui comptent, sur ' + report.required + ' ; ' + report.currentSeries + ' de suite en tout jusqu’au ' + day(report.lastDay) + ', meilleure série ' + report.bestSeries + '.'));
    body.appendChild(el('p', report.countFrom ? 'Les jours comptent à partir du ' + day(report.countFrom) + ', lendemain de l’inventaire à zéro.' : 'Aucun jour ne compte encore : l’inventaire n’est pas à zéro.', 'doux'));
    var dark = report.days.slice(-30).filter(function (x) { return x.status !== 'propre'; }).reverse().slice(0, 10);
    if (dark.length) {
      var ul = el('ul', null, 'liste');
      dark.forEach(function (x) {
        var text = day(x.day) + ' : ' + (DAY_STATUS[x.status] || 'état inconnu');
        if (x.recountWorse) text += ', recompté pire qu’au relevé de la nuit';
        ul.appendChild(el('li', text + '.'));
      });
      body.appendChild(ul);
    }
    var inv = report.inventories[report.inventories.length - 1];
    body.appendChild(el('p', inv ? 'Inventaire version ' + inv.version + ' du ' + date(inv.declaredAt) + ' : ' + inv.total + ' tâche(s) encore planifiée(s) hors d’AIMMO (' + APPS.map(function (a) { return a[1] + ' ' + inv.tasks[a[0]]; }).join(', ') + ').' : 'Aucun inventaire des tâches planifiées hors d’AIMMO n’est rangé.', 'doux'));
    var d = el('details');
    d.appendChild(el('summary', 'Ranger l’inventaire des tâches planifiées'));
    var counts = APPS.map(function (a) { return numberField(d, 'inventaire-' + a[0], a[1] + ' : tâches encore planifiées'); });
    var proof = field(d, 'inventaire-preuve', 'Référence de la preuve');
    d.appendChild(button('Ranger l’inventaire', function () {
      var tasks = {}, bad = false;
      APPS.forEach(function (a, j) { var n = whole(counts[j], 1000); if (n === null) bad = true; tasks[a[0]] = n; });
      if (bad) { state(REFUSALS.bad_tasks); return; }
      var ref = proofOf(proof);
      if (!ref) { state(REFUSALS.bad_proof); return; }
      write('/v1/phases/phase1/inventaire', { tasks: tasks, proofRef: ref }, 'Inventaire rangé : une nouvelle version s’ajoute.', 'L’inventaire n’est pas rangé.');
    }));
    body.appendChild(d);
    var o = el('details');
    o.appendChild(el('summary', 'Ranger un envoi hors règles constaté hors d’AIMMO'));
    o.appendChild(el('p', 'Il rend son jour hors règles et n’est jamais retiré.', 'doux'));
    var when = field(o, 'hors-jour', 'Le jour de l’envoi');
    when.setAttribute('type', 'date');
    var app = field(o, 'hors-application', 'L’application', 'select');
    app.appendChild(el('option', 'Choisir…'));
    APPS.forEach(function (a) { var opt = el('option', a[1]); opt.setAttribute('value', a[0]); app.appendChild(opt); });
    var ref = field(o, 'hors-preuve', 'Référence de la preuve');
    var b = button('Ranger cet envoi', function () {
      var dd = String(when.value || '').trim(), aa = String(app.value || '');
      if (!DAY.test(dd)) { state(REFUSALS.bad_day); return; }
      if (!APPS.some(function (a) { return a[0] === aa; })) { state(REFUSALS.bad_application); return; }
      var r = proofOf(ref);
      if (!r) { state(REFUSALS.bad_proof); return; }
      if (!b.armed) { b.armed = true; b.textContent = 'Confirmer : cet envoi ne sera jamais retiré'; return; }
      write('/v1/phases/phase1/envois-hors-aimmo', { day: dd, application: aa, proofRef: r }, 'Envoi hors règles rangé : son jour compte comme hors règles.', 'L’envoi n’est pas rangé.');
    });
    o.appendChild(b);
    body.appendChild(o);
  }
  function verify(out) {
    var mine = t.session();
    out.textContent = 'Vérification…';
    return send('/v1/regions/verification', 'GET').then(function (res) {
      if (res.gone || mine !== t.session()) return false;
      if (!res.ok || !res.body || !res.body.data) { out.textContent = why(res, 'Vérification indisponible pour le moment.'); return false; }
      var c = res.body.data;
      out.textContent = c.intact ? 'Chaîne intacte : ' + c.versions + ' décision(s), aucune réécrite.' : 'Chaîne cassée à la version ' + c.brokenAt + ' : la carte des régions ne peut plus être crue sans enquête.';
      return true;
    });
  }
  /*
   * BR38 · les communes à pourvoir, BR108 · le coût de l'agent moyen : chacun un script servi à part, chargé au premier
   * geste [R201].
   */
  var screens = {};
  function lazy(title, intro, label, src, name) {
    var box = el('section', null, 'bloc');
    box.appendChild(el('h4', title));
    box.appendChild(el('p', intro, 'doux'));
    var inner = el('div');
    var b = button(label, function () {
      if (b.disabled) return;
      if (screens[name]) { screens[name].show(inner); return; }
      b.disabled = true;
      var mine = t.session();
      var s = el('script');
      s.setAttribute('src', src);
      s.addEventListener('load', function () {
        var make = globalThis[name];
        try { delete globalThis[name]; } catch (e) { /* rien */ }
        b.disabled = false;
        if (mine !== t.session()) return;
        if (typeof make !== 'function') { clear(inner); inner.appendChild(el('p', 'Indisponible pour le moment. Réessayez dans un moment.', 'etat')); return; }
        screens[name] = make({ el: el, clear: clear, send: send, button: button, field: field, date: date, session: t.session });
        screens[name].show(inner);
      });
      s.addEventListener('error', function () { b.disabled = false; if (mine === t.session()) { clear(inner); inner.appendChild(el('p', OFFLINE, 'etat')); } });
      box.appendChild(s);
    });
    box.appendChild(b);
    box.appendChild(inner);
    return box;
  }
  function renderCommunes() {
    return lazy('Communes à pourvoir', 'Où des clients sont restés sans agent un mois fini, et où ouvrir ou fermer le recrutement. La page de candidature ne dit que les noms des communes ouvertes, sans aucun chiffre.', 'Ouvrir les communes à pourvoir', '/app/communes.js', 'AIMMO_COMMUNES');
  }
  function renderCout() {
    return lazy('Coût de l’agent moyen', 'Pour un mois fini, si la part du réseau couvre le coût complet de l’agent moyen, marge comprise, et la part qui le couvre tout juste. Aucun montant ne se saisit : tout est calculé sur les factures et les dossiers.', 'Ouvrir le coût de l’agent moyen', '/app/cout-agent.js', 'AIMMO_COUT_AGENT');
  }
  function show(message) {
    var mine = t.session();
    var turn = ++showing;
    clear($('phases-corps'));
    state('Chargement…');
    return Promise.all([send('/v1/phases', 'GET'), send('/v1/regions', 'GET'), send('/v1/phases/pilotes', 'GET'), send('/v1/phases/phase1', 'GET')]).then(function (all) {
      if (all.some(function (x) { return x.gone; }) || mine !== t.session() || turn !== showing) return false;
      var p = all[0], r = all[1], pl = all[2], p1 = all[3];
      var body = $('phases-corps');
      var bad = [];
      if (p.ok && p.body && p.body.data && Array.isArray(p.body.data.phases)) renderPhases(body, p.body.data);
      else bad.push(why(p, 'Phases indisponibles pour le moment.'));
      if (r.ok && r.body && r.body.data && Array.isArray(r.body.data.regions)) renderRegions(body, r.body.data);
      else bad.push(why(r, 'Régions indisponibles pour le moment.'));
      if (pl.ok && pl.body && pl.body.data && Array.isArray(pl.body.data.pilots)) renderPilots(body, pl.body.data);
      else bad.push(why(pl, 'Agents pilotes indisponibles pour le moment.'));
      if (p1.ok && p1.body && p1.body.data && Array.isArray(p1.body.data.days)) renderPhase1(body, p1.body.data);
      else bad.push(why(p1, 'Phase 1 indisponible pour le moment.'));
      body.appendChild(renderCommunes());
      body.appendChild(renderCout());
      state([message].concat(bad).filter(function (x, i, all) { return x && all.indexOf(x) === i; }).join(' '));
      return bad.length === 0;
    });
  }
  return { show: show };
};
`;
