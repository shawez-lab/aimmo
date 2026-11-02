/**
 * Les finances à l'écran (K10) : le rapport du matin de chacun, sur « Mes chiffres » pour l'agent, sur « Le réseau » pour
 * la direction. Script servi à part (`/app/finances.js`), chargé au premier geste [R201]. Le serveur choisit le rapport du
 * lecteur d'après sa clé : l'écran ne demande jamais le rapport d'un autre [R68]. Rien n'est gardé sur l'appareil.
 */

/** Une entrée du rapport : `who` distingue les deux écrans, qui ne se montrent jamais ensemble. */
const reportEntry = (who: 'agent' | 'direction'): string => `<section class="bloc" aria-labelledby="rapport-${who}-titre">
<h3 id="rapport-${who}-titre">Rapport du matin</h3>
<p class="doux">Chaque jour ouvré à 7 h 30 : les chiffres de la veille, les contacts à rappeler, les alertes.</p>
<label for="rapport-${who}-jour">Un autre jour (laisser vide pour aujourd’hui)</label>
<input id="rapport-${who}-jour" type="date">
<button id="rapport-${who}-lire" type="button" class="secondaire">Lire le rapport</button>
<p id="rapport-${who}-etat" class="etat" role="status"></p>
<div id="rapport-${who}-corps"></div>
</section>
`;

export const RAPPORT_AGENT_HTML = reportEntry('agent');
export const RAPPORT_DIRECTION_HTML = reportEntry('direction');

/** Le chargeur posé dans le script de l'application : l'écran est servi à part, chargé une fois, jamais gardé. */
export const FINANCES_JS = `
  /* ---------- Les finances (K10), chargées au premier geste [R16, R201]. ---------- */
  var financesTools = null, financesLoading = false;
  function wipeFinances() {
    ['agent', 'direction'].forEach(function (who) {
      clear($('rapport-' + who + '-corps'));
      $('rapport-' + who + '-etat').textContent = '';
      $('rapport-' + who + '-jour').value = '';
    });
  }
  function withFinances(stateId, hostId, act) {
    if (!currentKey) return Promise.resolve(false);
    if (financesTools) return act(financesTools);
    if (financesLoading) return Promise.resolve(false);
    financesLoading = true;
    var mine = session;
    $(stateId).textContent = 'Chargement…';
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.setAttribute('src', '/app/finances.js');
      s.addEventListener('load', function () {
        financesLoading = false;
        var make = globalThis.AIMMO_FINANCES;
        try { delete globalThis.AIMMO_FINANCES; } catch (e) { /* rien */ }
        if (mine !== session) { resolve(false); return; }
        if (typeof make !== 'function') { $(stateId).textContent = 'Indisponible pour le moment. Réessayez dans un moment.'; resolve(false); return; }
        financesTools = make({ $: $, el: el, clear: clear, send: send, date: date, session: function () { return session; } });
        resolve(act(financesTools));
      });
      s.addEventListener('error', function () {
        financesLoading = false;
        if (mine === session) $(stateId).textContent = 'Pas de réseau. Réessayez dans un moment.';
        resolve(false);
      });
      $(hostId).appendChild(s);
    });
  }
  function readReport(who, hostId) {
    return withFinances('rapport-' + who + '-etat', hostId, function (f) { return f.report(who); });
  }
`;

/** Le script servi à part (`/app/finances.js`). Il ne lit que la route du rapport [R16, R68], et ne garde rien. */
export const FINANCES_SCRIPT = `'use strict';
globalThis.AIMMO_FINANCES = function (t) {
  var $ = t.$, el = t.el, clear = t.clear, send = t.send, date = t.date;
  var reading = 0;
  function day(iso) { return date(iso + 'T12:00:00Z'); }
  function report(who) {
    var mine = t.session();
    /* Seule la dernière lecture demandée s'affiche : deux appuis ne font pas deux rapports. */
    var turn = ++reading;
    var body = $('rapport-' + who + '-corps'), state = $('rapport-' + who + '-etat');
    var chosen = $('rapport-' + who + '-jour').value;
    clear(body);
    if (chosen && !/^\\d{4}-\\d{2}-\\d{2}$/.test(chosen)) { state.textContent = 'Choisissez un jour.'; return Promise.resolve(false); }
    state.textContent = 'Chargement…';
    return send('/v1/pilotage/rapport-matin' + (chosen ? '?jour=' + chosen : ''), 'GET').then(function (res) {
      if (res.gone || mine !== t.session() || turn !== reading) return false;
      if (!res.ok) {
        if (res.offline) state.textContent = 'Pas de réseau. Réessayez dans un moment.';
        else if (res.body && res.body.rule === 'R16') state.textContent = 'Ce n’est pas dans vos droits.';
        else state.textContent = 'Indisponible pour le moment. Réessayez plus tard.';
        return false;
      }
      var r = res.body.data;
      if (!r || typeof r.text !== 'string') {
        state.textContent = chosen ? 'Pas de rapport pour ce jour : il s’écrit les jours ouvrés seulement.' : 'Pas encore de rapport aujourd’hui : il s’écrit les jours ouvrés à 7 h 30.';
        return true;
      }
      var p = r.period || {};
      state.textContent = 'Rapport du ' + day(r.day) + (p.from && p.to ? (p.from === p.to ? ', pour le ' + day(p.from) : ', du ' + day(p.from) + ' au ' + day(p.to)) : '') + '.';
      r.text.split('\\n').forEach(function (line) {
        body.appendChild(el('p', line, line.indexOf('Alerte') === 0 ? 'retard' : undefined));
      });
      return true;
    });
  }
  return { report: report };
};
`;
