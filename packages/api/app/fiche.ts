import { ACCORDS_JS } from './accords.ts';

/**
 * DS010, DS050 · La fiche d'un client (A03). La lecture reste dans l'application : elle passe sous la clé et la session
 * de l'agent, et le serveur décide de tout [R16]. Le dessin est servi à part (`/app/fiche.js`) et chargé à la première
 * fiche ouverte : l'application garde ainsi son budget de poids [R201], et la fiche peut dire plus.
 *
 * La fiche ouvre sur le geste du jour : qui est la personne, où en est l'échange, le bouton d'appel ou la raison qui le
 * ferme [R02, R03, R04, R203, R204], les gestes d'appel, puis les rappels encore à faire. Dessous, quatre parties, une
 * seule montrée à la fois : le fil (messages, rappels faits, origines, appels reçus, notes vocales), les projets
 * (projets, classement, séquence, recherche d'un acquéreur, dates connues, recommandation), les biens, et les accords
 * (nom, accords, espace client, réclamations, coffre). Une relecture après un geste garde la partie ouverte.
 *
 * Un seul bouton plein : « Appeler ». Tout autre geste de la fiche est filaire (DS022).
 *
 * Son dessin tient en quatre règles de la feuille de l'application, sans commentaire pour garder son poids : les gestes
 * d'appel sur une ligne quand l'écran le permet (`.gestes`), le sélecteur des parties centré dans sa piste, un plus puis
 * un moins devant un volet (`summary::before`), et un geste posé dans une ligne de liste qui passe sous son texte.
 *
 * Décidé, lecture prudente : aucun lien `sms:` ni `mailto:`. Un message écrit depuis le téléphone de l'agent partirait
 * hors du contrôle central des envois (accords, horaires, arrêt, journal) : la question est au cahier, pas à l'écran.
 */
export const FICHE_JS = `
  /* ---------- A03 · La fiche d'un client : lue ici, dessinée par /app/fiche.js, chargé à la première fiche [R16, R201]. ---------- */
  function openFiche(personId) {
    if (!currentKey || typeof personId !== 'string' || !ID.test(personId)) return Promise.resolve(false);
    wipeFiche();
    // DS064 · le focus rejoint ce titre à l'ouverture : il dit déjà quel écran s'ouvre, le nom vient avec la réponse.
    $('fiche-nom').textContent = 'Fiche du client';
    show('fiche', [personId]);
    var read = send('/v1/fiches/' + encodeURIComponent(personId) + '/resume', 'GET');
    $('fiche-etat').textContent = 'Chargement…';
    return withTool('fiche', 'AIMMO_FICHE', 'fiche-etat', 'fiche', function (draw) {
      return read.then(function (res) {
        if (res.gone) return false;
        if ((res.status === 403 || res.status === 404) && res.body) { $('fiche-etat').textContent = 'Cette fiche n’est pas dans vos droits.'; return false; }
        if (!res.ok) { down($('fiche-etat')); return false; }
        $('fiche-etat').textContent = '';
        draw(res.body.data, personId);
        return true;
      });
    }, function () {
      return { $: $, el: el, clear: clear, send: send, button: button, field: field, line: line, block: block, date: date, hour: hour, channel: channel, stage: stage, projects: PROJECTS, ID: ID, cState: cState, cSeq: cSeq, cSelect: cSelect, cToday: cToday, lazyBlock: lazyBlock, openFiche: openFiche, session: function () { return session; } };
    });
  }
`;

/** Le script servi à part (`/app/fiche.js`). Il ne lit rien lui-même : la fiche lui est donnée, déjà lue sous droits. */
export const FICHE_SCRIPT = `'use strict';
globalThis.AIMMO_FICHE = function (t) {
  var $ = t.$, el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field, line = t.line, block = t.block, date = t.date, hour = t.hour, channel = t.channel, ID = t.ID, cState = t.cState, cSeq = t.cSeq, cSelect = t.cSelect, cToday = t.cToday, session = t.session, lazyBlock = t.lazyBlock;
  var TEL = /^tel:[+]?[0-9]{6,15}$/;
  var EXCLUSIONS = { network_list: 'sur la liste d’exclusion', stop: 'a demandé l’arrêt', refused: 'a dit non', sold: 'a déjà vendu', followed_elsewhere: 'suivi par quelqu’un d’autre' };
  var CLOSED = 'Appel fermé à cette heure : du lundi au vendredi, de 10 h à 13 h et de 14 h à 20 h, hors jours fériés.';
  var PARTS = ['Fil', 'Projets', 'Biens', 'Accords'];
  /* Une relecture demandée depuis la fiche garde la partie ouverte ; une fiche ouverte d'ailleurs commence par le fil. */
  var stay = null, shown = 0;
  function openFiche(personId) { stay = personId; return t.openFiche(personId); }
  /* DS022 · un geste de la fiche est filaire : seul « Appeler » est plein. */
  function quiet(b) { b.className = 'secondaire'; return b; }
${ACCORDS_JS}
  /* Les blocs servis à part et chargés avec la fiche : chacun une fois, puis repris pour les fiches suivantes. */
  var parts = {};
  function part(box, src, name, lost, draw) {
    if (parts[src]) { draw(parts[src]); return; }
    var s = el('script');
    s.setAttribute('src', '/app/' + src + '.js');
    s.addEventListener('load', function () {
      parts[src] = globalThis[name]({ $: $, el: el, send: send, date: date, ID: ID, cState: cState, cSeq: cSeq, cSelect: cSelect, accordButton: accordButton, accordFailed: accordFailed, openFiche: openFiche });
      draw(parts[src]);
    });
    s.addEventListener('error', function () { box.textContent = lost; });
    box.appendChild(s);
  }
  /* « Rappel fait » : rien n'est envoyé ; la fiche est relue pour montrer la ligne gardée [R17]. */
  function callbackDone(taskId, personId) {
    return send('/v1/rappels/' + encodeURIComponent(taskId) + '/fait', 'POST').then(function (res) {
      if (res.gone) return false;
      if (res.offline) { $('fiche-etat').textContent = 'Pas de réseau : le rappel n’est pas marqué fait.'; return false; }
      if (!res.ok) { $('fiche-etat').textContent = 'Le rappel n’a pas pu être marqué fait.'; return false; }
      return openFiche(personId);
    });
  }
  /* Le moyen de contact, ou la raison qui le ferme. Rend vrai si les gestes d'appel ont leur place dessous. */
  function contactTo(body, f) {
    var contact = f.contact || { allowed: false, reasons: [] };
    /* Personne exclue ou qui a demandé l'arrêt : signalée, sans bouton d'appel [R02, R04]. */
    if (!contact.allowed) {
      var reasons = (contact.reasons || []).map(function (r) { return EXCLUSIONS[r] || 'autre raison'; }).join(', ');
      body.appendChild(el('p', 'Ne plus contacter : ' + (reasons || 'exclusion active') + '.', 'alerte'));
      return false;
    }
    if (typeof f.call === 'string' && TEL.test(f.call)) {
      var a = el('a', 'Appeler', 'appel');
      a.setAttribute('href', f.call);
      /* L'application peut rester ouverte : passé la fin du créneau, l'appel ne part plus [R203]. */
      var closes = typeof f.callClosesAt === 'string' ? Date.parse(f.callClosesAt) : NaN;
      if (!isNaN(closes)) {
        a.addEventListener('click', function (event) {
          if (Date.now() < closes) return;
          event.preventDefault();
          a.removeAttribute('href');
          a.textContent = CLOSED;
        });
      }
      body.appendChild(a);
    } else if (f.callRefusal === 'no_consent') {
      /* Pas d'appel sans accord ni demande de la personne [R03]. */
      body.appendChild(el('p', 'Appel fermé : aucun accord ni demande de rappel enregistrés. Notez-les dans « Accords » si la personne vous les a donnés.', 'alerte'));
    } else if (f.callRefusal === 'outside_hours') {
      /* Une prospection acceptée s'appelle aux heures permises [R203]. */
      body.appendChild(el('p', CLOSED, 'alerte'));
    } else if (f.callRefusal === 'refused_request') {
      body.appendChild(el('p', 'Appel fermé : la personne a refusé. Il ne rouvre que si elle redemande à être rappelée.', 'alerte'));
    } else if (f.callReopensAt) {
      /* L'écran dit quand l'appel rouvre [R204]. */
      body.appendChild(el('p', 'Appel fermé : ' + (f.callRefusal === 'refused_recently' ? 'la personne a refusé' : 'trop d’appels récents') + '. Il rouvre le ' + date(f.callReopensAt) + ' à ' + hour(f.callReopensAt) + '.', 'alerte'));
    } else {
      body.appendChild(el('p', 'Aucun numéro sur la fiche.', 'doux'));
    }
    return !!(f.call || (f.callRefusal && f.callRefusal !== 'no_phone'));
  }
  return function (f, personId) {
    var body = $('fiche-corps');
    clear(body);
    $('fiche-nom').textContent = [f.firstName, f.lastName].filter(function (x) { return x; }).join(' ') || 'Nom inconnu';
    var projects = f.projects || [], messages = f.messages || [];
    /* En tête : ce que la personne veut, et où en est l'échange. Les codes internes ne s'affichent jamais. */
    var wants = [];
    projects.forEach(function (p) {
      var w = (t.projects[p.kind] || 'Autre projet').toLowerCase();
      if (wants.indexOf(w) < 0) wants.push(w);
    });
    var last = messages[0];
    body.appendChild(el('p', (wants.length ? (wants.length > 1 ? 'Projets : ' : 'Projet : ') + wants.join(', ') + '.' : 'Aucun projet noté.') + (last ? ' Dernier message ' + (last.direction === 'in' ? 'reçu' : 'envoyé') + ' par ' + channel(last.channel) + ', le ' + date(last.occurredAt) + '.' : ' Aucun message.'), 'doux'));
    if (contactTo(body, f)) {
      var gestures = body.appendChild(el('div'));
      part(gestures, 'appels', 'AIMMO_APPELS', 'Pas de réseau : les gestes d’appel reviendront.', function (draw) { draw(gestures, personId); });
    }
    /* Les rappels encore à faire restent en tête ; un rappel fait garde sa ligne, dans le fil [R17]. */
    var todo = [], done = [];
    (f.callbacks || []).forEach(function (c) {
      var li = line(c.reason, c.doneAt ? 'Fait le ' + date(c.doneAt) : 'À rappeler avant le ' + date(c.dueAt) + ' à ' + hour(c.dueAt));
      if (!c.doneAt && ID.test(c.taskId)) li.appendChild(quiet(button('Rappel fait', function () { callbackDone(c.taskId, personId); })));
      (c.doneAt ? done : todo).push(li);
    });
    if (todo.length) body.appendChild(block('Rappels', todo));
    /* Les quatre parties : une seule montrée, les autres gardées dessous. */
    var tabs = el('div', null, 'periodes'), panels = [], picks = [];
    tabs.setAttribute('role', 'group');
    tabs.setAttribute('aria-label', 'Parties de la fiche');
    function pick(i) {
      shown = i;
      panels.forEach(function (p, j) {
        p.hidden = j !== i;
        picks[j].setAttribute('aria-pressed', j === i ? 'true' : 'false');
      });
    }
    PARTS.forEach(function (name, i) {
      picks.push(tabs.appendChild(quiet(button(name, function () { pick(i); }))));
      panels.push(el('div'));
    });
    body.appendChild(tabs);
    panels.forEach(function (p) { body.appendChild(p); });
    var fil = panels[0], projets = panels[1], biens = panels[2], accords = panels[3];
    fil.appendChild(block('Derniers messages', messages.map(function (m) {
      return line(m.body, (m.direction === 'in' ? 'Reçu' : 'Envoyé') + ' par ' + channel(m.channel) + ', le ' + date(m.occurredAt) + ' à ' + hour(m.occurredAt));
    })));
    if (done.length) fil.appendChild(block('Rappels faits', done));
    fil.appendChild(block('Origines', (f.sources || []).map(function (s) { return line(channel(s.channel) + (s.detail ? ' (' + s.detail + ')' : ''), 'Le ' + date(s.occurredAt)); })));
    /* Les appels reçus (BR61) et les notes vocales transcrites (BR62), relus au geste [R16, R240, R243]. */
    fil.appendChild(lazyBlock('Appels reçus', '/app/appels-recus.js', 'AIMMO_APPELS_RECUS', personId));
    fil.appendChild(lazyBlock('Notes vocales', '/app/notes-vocales.js', 'AIMMO_NOTES_VOCALES', personId));
    projets.appendChild(block('Projets', projects.map(function (p) {
      var budget = p.budgetMaxEur ? ', budget jusqu’à ' + p.budgetMaxEur + ' €' : '';
      var li = line((t.projects[p.kind] || 'Autre projet') + ' (étape : ' + t.stage(p.stage) + ')' + budget, p.deadline ? 'Échéance le ' + date(p.deadline) : null);
      if (p.kind === 'buy' && ID.test(p.id)) var still = li.appendChild(quiet(button('Recherche toujours d’actualité', function () {
        send('/v1/acquereurs/projets/' + p.id + '/recherche/confirmation', 'POST').then(function (r) { if (!r.gone) still.textContent = r.ok ? 'Confirmée' : 'Échec, réessayez'; });
      })));
      return li;
    })));
    if (f.qualification) {
      var ranked = projets.appendChild(el('div'));
      part(ranked, 'classement', 'AIMMO_CLASSEMENT', 'Pas de réseau : le classement reviendra.', function (draw) { draw(ranked, personId, f.qualification); });
    }
    /* Le nom à compléter ou à corriger va avec les accords ; la séquence et la recherche d'un acquéreur, avec les projets. */
    var owned = biens.appendChild(el('div')), named = accords.appendChild(el('div')), sought = projets.appendChild(el('div'));
    part(owned, 'biens-fiche', 'AIMMO_BIENS_FICHE', 'Pas de réseau : les biens du client reviendront.', function (draw) { draw(owned, personId, f, { nom: named, suite: sought }); });
    /* La fin de bail connue, raison écrite d'une relance d'ancien contact (G15) [R143] ; un proche recommandé (X22) [R03, R142]. */
    projets.appendChild(lazyBlock('Dates connues', '/app/fin-de-bail.js', 'AIMMO_FIN_DE_BAIL', personId, 'fin-bail'));
    projets.appendChild(lazyBlock('Recommandation d’un proche', '/app/recommandation.js', 'AIMMO_RECOMMANDATION', personId, 'reco'));
    accords.appendChild(accordsBlock(personId, f));
    /* Les réclamations de la fiche (BR69) [R16, R606, R607] ; le dépôt d'une pièce au coffre (L10, BR102) [R90]. */
    accords.appendChild(lazyBlock('Réclamations', '/app/reclamations.js', 'AIMMO_RECLAMATIONS', personId));
    accords.appendChild(lazyBlock('Pièces au coffre', '/app/coffre.js', 'AIMMO_COFFRE', personId));
    pick(stay === personId ? shown : 0);
    stay = null;
  };
};
`;
