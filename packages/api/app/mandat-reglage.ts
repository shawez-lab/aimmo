/**
 * L'écart de prix toléré du mandat par questionnaire à l'écran (BR119 ; M06 Mandats et documents) [R441, R16, R13].
 *
 * Une partie du script des modèles de mandat (`/app/mandat-modeles.js`, D18), sous les clauses (BR118), au même geste :
 * aucun chargeur de plus dans l'application [R201]. Elle lit `GET /v1/questionnaire-mandat/reglage` et dit l'écart en
 * vigueur en pour cent, s'il est le réglage par défaut ou sa date. La direction le règle de 0 à 50 %, deux décimales au
 * plus ; chaque réglage s'ajoute au serveur [R441]. La conformité le lit seulement [R16]. Le serveur décide de tout ;
 * l'écran dit ses refus. Une lecture illisible n'est jamais prise pour le défaut ; rien n'est gardé sur l'appareil [R13].
 */
export const MANDAT_REGLAGE_PART = `
  var gapReads = 0, gapBusy = null;
  function gapPct(b) { return String(b / 100).replace('.', ',') + ' %'; }
  /* « 5 », « 2,5 », « 12.25 % » : en points de base ; null si illisible, hors bornes ou plus de deux décimales. */
  function gapBps(text) {
    var m = /^\\s*(\\d{1,2})(?:[,.](\\d{1,2}))?\\s*%?\\s*$/.exec(String(text || ''));
    if (!m) return null;
    var b = Number(m[1]) * 100 + (m[2] ? Number((m[2] + '0').slice(0, 2)) : 0);
    return b <= 5000 ? b : null;
  }
  function gapReadable(d) {
    return !!d && typeof d.maxGapBps === 'number' && d.maxGapBps % 1 === 0 && d.maxGapBps >= 0 && d.maxGapBps <= 5000 && typeof d.isDefault === 'boolean' && (d.isDefault || typeof d.setAt === 'string');
  }
  function gapFill(list, said, mode, message) {
    var mine = t.session(), r = ++gapReads;
    clear(list);
    said.textContent = 'Chargement de l’écart…';
    return send('/v1/questionnaire-mandat/reglage', 'GET').then(function (res) {
      if (r !== gapReads) return;
      if (res.gone || mine !== t.session()) { clear(list); said.textContent = ''; return; }
      clear(list);
      if (res.status === 403) { said.textContent = 'Ce geste n’est pas dans vos droits.'; return; }
      if (res.offline) { said.textContent = 'Pas de réseau. Réessayez dans un moment.'; return; }
      var d = res.ok && res.body ? res.body.data : null;
      if (!gapReadable(d)) { said.textContent = 'L’écart ne se lit pas pour le moment.'; return; }
      said.textContent = message || '';
      list.appendChild(el('p', 'En vigueur : ' + gapPct(d.maxGapBps) + ' hors de la fourchette de l’avis de valeur validé' + (d.isDefault ? ', réglage par défaut.' : ', réglé le ' + date(d.setAt) + '.'), 'fait'));
      if (!mode.store) { list.appendChild(el('p', 'La direction règle cet écart.', 'doux')); return; }
      var input = field(list, 'mandat-ecart', 'Nouvel écart toléré, en pour cent');
      input.setAttribute('inputmode', 'decimal');
      list.appendChild(el('p', 'De 0 à 50 %, deux décimales au plus. Il vaut pour les prochains mandats préparés ; les réglages passés restent.', 'doux'));
      list.appendChild(button('Régler l’écart', function () {
        var b = gapBps(input.value);
        if (b === null) { said.textContent = 'Un écart se règle de 0 à 50 %, deux décimales au plus : rien n’est envoyé.'; return; }
        if (b === d.maxGapBps) { said.textContent = 'L’écart n’a pas changé : rien n’est envoyé.'; return; }
        if (gapBusy === mine) return;
        gapBusy = mine;
        said.textContent = 'Envoi…';
        send('/v1/questionnaire-mandat/reglage', 'POST', { maxGapBps: b }).then(function (res) {
          if (gapBusy === mine) gapBusy = null;
          if (res.gone || mine !== t.session()) { clear(list); said.textContent = ''; return; }
          if (res.ok) return gapFill(list, said, mode, 'Écart réglé à ' + gapPct(b) + ' pour les prochains mandats préparés.');
          if (res.offline || !res.body || res.status >= 500) {
            clear(list);
            list.appendChild(button('Relire l’écart', function () { gapFill(list, said, mode); }));
            said.textContent = 'Réponse perdue : ce réglage est peut-être rangé. Relisez avant de recommencer.';
            return;
          }
          if (res.status === 403) { said.textContent = 'Ce geste n’est pas dans vos droits.'; return; }
          said.textContent = res.body.code === 'bad_setting' ? 'Un écart se règle de 0 à 50 %, deux décimales au plus : rien n’est rangé.' : 'L’écart n’est pas réglé.';
        });
      }));
    });
  }
  function gapPart(box, mode) {
    var part = el('div');
    part.appendChild(el('h4', 'Écart de prix toléré'));
    part.appendChild(el('p', 'Au-delà de cet écart, le prix du mandat est écrit hors de la fourchette et l’agent du bien doit le montrer au vendeur avant la signature.', 'doux'));
    var said = el('p', null, 'etat');
    said.setAttribute('role', 'status');
    var list = el('div');
    part.appendChild(said);
    part.appendChild(list);
    box.appendChild(part);
    return gapFill(list, said, mode);
  }
`;
