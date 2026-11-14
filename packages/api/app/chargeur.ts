/**
 * BR69 · Le chargeur commun des blocs de la fiche servis à part [R201]. Un bloc dit son bouton, son script, le nom que ce
 * script pose (retiré aussitôt lu) et, s'il le faut, la classe de son état ; l'outil fait est une fonction, ou a `open`.
 * Rien n'est lu avant le geste. Le script est chargé une fois pour toute la session : les fiches suivantes reprennent
 * l'outil déjà fait. Passent par lui : « Appels reçus » (BR61), « Notes vocales » (BR62), « Réclamations » (BR69),
 * « Dates connues » (G15), « Recommandation d’un proche » (X22) et « Remises du moment » (BR73), pour que l'application tienne son budget.
 */
export const CHARGEUR_JS = `
  var lazyTools = {};
  function lazyBlock(label, src, name, personId, cls) {
    var box = el('section', null, 'bloc'), said = el('p', null, 'etat' + (cls ? ' ' + cls : '')), corps = el('div');
    function run() { var x = lazyTools[src]; return typeof x === 'function' ? x(personId, corps, said) : x.open(personId, corps, said); }
    said.setAttribute('role', 'status');
    var b = button(label, function () {
      if (lazyTools[src]) return run();
      var mine = session, s = document.createElement('script');
      b.disabled = true;
      said.textContent = 'Chargement…';
      s.setAttribute('src', src);
      s.addEventListener('load', function () {
        b.disabled = false;
        var make = globalThis[name];
        try { delete globalThis[name]; } catch (e) { /* rien */ }
        if (mine !== session) return;
        if (typeof make !== 'function') { said.textContent = 'Indisponible pour le moment. Réessayez dans un moment.'; return; }
        lazyTools[src] = make({ el: el, clear: clear, send: send, button: button, field: field, checkbox: checkbox, projects: PROJECTS, date: date, hour: hour, session: function () { return session; } });
        run();
      });
      s.addEventListener('error', function () { b.disabled = false; if (mine === session) said.textContent = 'Pas de réseau. Réessayez dans un moment.'; });
      $('fiche').appendChild(s);
    });
    b.className = 'secondaire';
    box.appendChild(b);
    box.appendChild(said);
    box.appendChild(corps);
    return box;
  }
`;
