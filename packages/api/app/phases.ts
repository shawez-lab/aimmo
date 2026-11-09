/**
 * Les phases et les régions sur l'écran du réseau (BR13) : la direction lit l'état des cinq phases (HX71) et ouvre la
 * suivante, lit les 18 régions (HX72), en ouvre ou en ferme une avec sa raison, et vérifie la chaîne des décisions.
 * Script servi à part (`/app/phases.js`), chargé au premier geste [R201]. Chaque condition et chaque refus se disent en
 * mots, jamais par un code. Ouvrir une phase ne se défait pas : deux appuis, et seulement quand le serveur dit que
 * c'est possible ; c'est lui qui relit la condition à l'instant [R647]. Tout texte reçu est posé en texte.
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
};
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
  var phasesTools = null, phasesLoading = false;
  function wipePhases() {
    clear($('phases-corps'));
    $('phases-etat').textContent = '';
  }
  function withPhases(act) {
    if (!currentKey) return Promise.resolve(false);
    if (phasesTools) return act(phasesTools);
    if (phasesLoading) return Promise.resolve(false);
    phasesLoading = true;
    var mine = session;
    $('phases-etat').textContent = 'Chargement…';
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.setAttribute('src', '/app/phases.js');
      s.addEventListener('load', function () {
        phasesLoading = false;
        var make = globalThis.AIMMO_PHASES;
        try { delete globalThis.AIMMO_PHASES; } catch (e) { /* rien */ }
        if (mine !== session) { resolve(false); return; }
        if (typeof make !== 'function') { $('phases-etat').textContent = 'Indisponible pour le moment. Réessayez dans un moment.'; resolve(false); return; }
        phasesTools = make({ $: $, el: el, clear: clear, send: send, button: button, field: field, date: date, session: function () { return session; } });
        resolve(act(phasesTools));
      });
      s.addEventListener('error', function () {
        phasesLoading = false;
        if (mine === session) $('phases-etat').textContent = 'Pas de réseau. Réessayez dans un moment.';
        resolve(false);
      });
      $('reseau').appendChild(s);
    });
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
  function show(message) {
    var mine = t.session();
    var turn = ++showing;
    clear($('phases-corps'));
    state('Chargement…');
    return Promise.all([send('/v1/phases', 'GET'), send('/v1/regions', 'GET')]).then(function (all) {
      if (all[0].gone || all[1].gone || mine !== t.session() || turn !== showing) return false;
      var p = all[0], r = all[1];
      var body = $('phases-corps');
      var bad = [];
      if (p.ok && p.body && p.body.data && Array.isArray(p.body.data.phases)) renderPhases(body, p.body.data);
      else bad.push(why(p, 'Phases indisponibles pour le moment.'));
      if (r.ok && r.body && r.body.data && Array.isArray(r.body.data.regions)) renderRegions(body, r.body.data);
      else bad.push(why(r, 'Régions indisponibles pour le moment.'));
      state([message].concat(bad).filter(function (x, i, all) { return x && all.indexOf(x) === i; }).join(' '));
      return bad.length === 0;
    });
  }
  return { show: show };
};
`;
