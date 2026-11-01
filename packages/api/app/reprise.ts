/**
 * La reprise des contacts sur l'écran du réseau (I05) : la direction dépose les trois exports de H15 depuis son
 * téléphone ou son ordinateur, sans geste technique, et voit où en est la reprise. Le fichier est lu sur l'appareil et
 * envoyé une fois à `/v1/reprise/fichiers` ; rien n'en est gardé sur l'appareil ni montré à l'écran, seulement des
 * nombres [R13]. La direction seule y a droit [R16].
 */

const TOOLS: readonly { id: string; label: string }[] = [
  { id: 'exclusion_list', label: 'Liste d’exclusion' },
  { id: 'gohighlevel', label: 'Contacts de GoHighLevel' },
  { id: 'manychat', label: 'Abonnés de ManyChat' },
];

/** Les messages des refus du dépôt, sans rien recopier du fichier. */
const REFUSALS: Readonly<Record<string, string>> = {
  role: 'Seule la direction dépose les fichiers de la reprise.',
  bad_tool: 'Sorte de fichier inconnue.',
  empty_file: 'Le fichier est vide.',
  file_too_large: 'Le fichier dépasse 20 Mo.',
  unreadable_file: 'Fichier illisible : il faut un CSV avec une ligne d’en-tête et une colonne de mail, de téléphone ou d’Instagram (voir la notice de la reprise).',
  bad_agent: 'L’agent qui reçoit les fiches est inconnu ou parti.',
  invalid_body: 'Le fichier n’a pas pu être envoyé.',
};

const SOURCES: Readonly<Record<string, string>> = { site: 'le site', exclusion_list: 'la liste d’exclusion', gohighlevel: 'GoHighLevel', manychat: 'ManyChat' };

export const REPRISE_ENTRY_HTML = `<section class="bloc" aria-labelledby="titre-reprise">
<h3 id="titre-reprise">Reprise des contacts existants</h3>
<p class="doux">Déposez ici les trois exports : ils restent dans la base AIMMO, jamais ailleurs. La reprise ne tourne qu’avec les trois, et n’envoie rien.</p>
${TOOLS.map((t) => `<label for="reprise-${t.id}">${t.label} (CSV)</label>\n<input id="reprise-${t.id}" type="file" accept=".csv,text/csv,text/plain">`).join('\n')}
<div class="periodes">
<button id="reprise-deposer" type="button" class="secondaire">Déposer les fichiers choisis</button>
<button id="reprise-voir" type="button" class="secondaire">Où en est la reprise</button>
</div>
<p id="reprise-etat" class="etat" role="status"></p>
<ul id="reprise-liste" class="liste"></ul>
</section>
`;

export const REPRISE_JS = `
  /* ---------- I05 : dépôt des fichiers de la reprise par la direction [R13, R16]. ---------- */
  var REPRISE_TOOLS = ${JSON.stringify(TOOLS)};
  var REPRISE_REFUSALS = ${JSON.stringify(REFUSALS)};
  var REPRISE_SOURCES = ${JSON.stringify(SOURCES)};
  function wipeReprise() {
    clear($('reprise-liste'));
    $('reprise-etat').textContent = '';
    REPRISE_TOOLS.forEach(function (t) { $('reprise-' + t.id).value = ''; });
  }
  function repriseLine(text) { $('reprise-liste').appendChild(el('li', text)); }
  function showReprise() {
    var mine = session;
    clear($('reprise-liste'));
    $('reprise-etat').textContent = 'Chargement…';
    return send('/v1/reprise/etat', 'GET').then(function (res) {
      if (res.gone || mine !== session) return false;
      if (!res.ok) { $('reprise-etat').textContent = res.offline ? 'Pas de réseau. Réessayez dans un moment.' : (REPRISE_REFUSALS[(res.body || {}).code] || 'Indisponible pour le moment.'); return false; }
      var d = res.body.data || {}, depots = d.depots || {}, p = d.progress;
      var missing = 0;
      REPRISE_TOOLS.forEach(function (t) {
        var x = depots[t.id];
        if (!x) { missing += 1; repriseLine(t.label + ' : pas encore déposé.'); return; }
        repriseLine(t.label + ' : ' + x.lines + ' ligne' + (x.lines > 1 ? 's' : '') + ', déposé le ' + date(x.depositedAt) + (hour(x.depositedAt) ? ' à ' + hour(x.depositedAt) : '') + '.');
      });
      if (!p) $('reprise-etat').textContent = missing ? 'Il manque ' + missing + ' fichier' + (missing > 1 ? 's' : '') + ' : la reprise attend les trois.' : 'Les trois fichiers sont là : la reprise peut être lancée.';
      else if (p.doneAt) $('reprise-etat').textContent = 'Reprise faite le ' + date(p.doneAt) + '.';
      else $('reprise-etat').textContent = 'Reprise en cours : ' + (REPRISE_SOURCES[p.source] || p.source) + ', ' + p.position + ' contacts repris.';
      return true;
    });
  }
  function depositReprise() {
    var chosen = REPRISE_TOOLS.filter(function (t) { var f = $('reprise-' + t.id).files; return f && f.length === 1; });
    if (!chosen.length) { $('reprise-etat').textContent = 'Choisissez au moins un fichier.'; return Promise.resolve(false); }
    var mine = session;
    $('reprise-etat').textContent = 'Envoi…';
    clear($('reprise-liste'));
    var failed = 0;
    return chosen.reduce(function (chain, t) {
      return chain.then(function () {
        if (mine !== session) return;
        var file = $('reprise-' + t.id).files[0];
        if (file.size > 20000000) { failed += 1; repriseLine(t.label + ' : ' + REPRISE_REFUSALS.file_too_large); return; }
        return file.text().then(function (csv) {
          return send('/v1/reprise/fichiers', 'POST', { tool: t.id, csv: csv });
        }).then(function (res) {
          if (!res || res.gone || mine !== session) return;
          if (!res.ok) { failed += 1; repriseLine(t.label + ' : ' + (res.offline ? 'pas de réseau, rien n’est déposé.' : (REPRISE_REFUSALS[(res.body || {}).code] || 'refusé.'))); return; }
          var v = res.body.data;
          $('reprise-' + t.id).value = '';
          repriseLine(t.label + ' : déposé, ' + v.lines + ' ligne' + (v.lines > 1 ? 's' : '') + (v.unreadableLines ? ', dont ' + v.unreadableLines + ' illisible' + (v.unreadableLines > 1 ? 's' : '') + ' à regarder' : '') + '.');
        }, function () { failed += 1; repriseLine(t.label + ' : fichier illisible sur cet appareil.'); });
      });
    }, Promise.resolve()).then(function () {
      if (mine !== session) return false;
      $('reprise-etat').textContent = failed ? 'Dépôt incomplet : ' + failed + ' fichier' + (failed > 1 ? 's' : '') + ' refusé' + (failed > 1 ? 's' : '') + '.' : 'Dépôt fait.';
      return failed === 0;
    });
  }
`;
