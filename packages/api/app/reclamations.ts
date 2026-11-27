/**
 * BR69 · Les réclamations dans la fiche (HX58, routes de BR01). Le bloc « Réclamations » se charge au geste, par le
 * chargeur commun, dans son script servi à part (`/app/reclamations.js`) [R201] : rien n'est lu avant. Il montre les
 * réclamations rangées sur cette fiche ou sur une fiche qui lui est réunie (BR71, dites comme telles), l'échéance écrite par la base et jamais calculée ici [R606], la réponse notée une
 * seule fois, et la proposition du médiateur : envoyée, à remettre (texte mot pour mot et bouton « Remise au client »)
 * ou remise [R607]. Tout texte reçu est posé en texte ; un champ mal formé n'est pas dit. Chaque refus est dit en mots
 * [R16] ; une écriture sans réponse est dite incertaine et la liste est relue. Rien n'est envoyé d'ici.
 *
 * Jamais vu : chaque réclamation ouverte dit en mots combien de jours restent pour répondre.
 */

/** La longueur que le cœur admet pour un motif et pour une réponse. */
export const RECLAMATIONS_TEXT_MAX = 2000;

export const RECLAMATIONS_VIA = Object.freeze({ mail: 'mail', courrier: 'courrier', message: 'message', oral: 'oral (en face ou au téléphone)' });

export const RECLAMATIONS_OUTCOMES = Object.freeze({ reglee: 'Réglée : le client est d’accord avec la réponse', non_reglee: 'Non réglée' });

/** Chaque refus du cœur, dit en mots ; un refus inconnu a sa phrase générale, jamais son code. */
export const RECLAMATIONS_REFUSALS = Object.freeze({
  bad_date: 'Cette date n’est pas lisible.',
  future_date: 'Une réclamation ne peut pas être reçue dans le futur.',
  bad_received_via: 'Dites par où la réclamation est arrivée.',
  bad_summary: 'Écrivez ce que le client reproche, 2 000 caractères au plus.',
  bad_reply: 'La conversation de la réclamation n’est pas lisible.',
  unknown_person: 'Cette fiche n’existe plus.',
  bad_outcome: 'Dites si la réclamation est réglée ou non.',
  bad_note: 'Écrivez la réponse donnée au client, 2 000 caractères au plus.',
  already_answered: 'La réponse est déjà notée : elle ne se change plus.',
  nothing_to_hand: 'Il n’y a plus de proposition du médiateur à remettre.',
  unknown_complaint: 'Cette réclamation n’existe plus.',
  invalid_body: 'La saisie n’est pas lisible.',
  bad_fiche: 'Cette fiche n’est pas lisible.',
  unexpected_field: 'Cette lecture n’est pas lisible.',
});

/** Le bloc de la fiche n'est plus posé dans l'application : la fiche servie à part (`/app/fiche.js`) le demande au chargeur commun (DS010). */
/** Le script servi à part. Il ne lit et n'écrit que les routes des réclamations [R16]. */
export const RECLAMATIONS_SCRIPT = `'use strict';
globalThis.AIMMO_RECLAMATIONS = function (t) {
  var el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field;
  var VIA = ${JSON.stringify(RECLAMATIONS_VIA)}, OUTCOMES = ${JSON.stringify(RECLAMATIONS_OUTCOMES)}, REFUSALS = ${JSON.stringify(RECLAMATIONS_REFUSALS)};
  var MAX = ${RECLAMATIONS_TEXT_MAX};
  var OFFLINE = 'Pas de réseau. Réessayez dans un moment.';
  var DENIED = 'Réservé à l’agent qui suit cette fiche et à la direction.';
  var LOST = 'La réponse n’est pas arrivée : rien n’est sûr. Relisez la liste avant de recommencer.';
  var DAY = /^\\d{4}-\\d{2}-\\d{2}$/, ID = /^[A-Za-z0-9_-]{1,64}$/;
  function own(map, k) { return typeof k === 'string' && Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; }
  function text(v, max) { return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null; }
  function day(d) { return typeof d === 'string' && DAY.test(d) ? d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(0, 4) : null; }
  function today() { try { return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }); } catch (e) { return ''; } }
  function left(due) {
    var a = Date.parse(due + 'T00:00:00Z'), b = Date.parse(today() + 'T00:00:00Z');
    return isNaN(a) || isNaN(b) ? null : Math.round((a - b) / 86400000);
  }
  function refusal(x) {
    if (x.status === 403) return DENIED;
    return own(REFUSALS, x.body && x.body.code) || 'Refusé : relisez la saisie.';
  }
  function choice(box, id, label, map) {
    var f = field(box, id, label, 'select'), first = el('option', 'Choisir…');
    first.value = '';
    f.appendChild(first);
    Object.keys(map).forEach(function (k) { var o = el('option', map[k]); o.value = k; f.appendChild(o); });
    f.value = '';
    return f;
  }
  function due(c) {
    var n = left(c.dueOn), d = day(c.dueOn);
    if (n === null) return el('p', 'Réponse attendue au plus tard le ' + d + '.');
    if (n < 0) return el('p', 'Échéance passée le ' + d + ' : la réponse sera notée en retard.', 'alerte');
    if (n === 0) return el('p', 'Réponse attendue aujourd’hui, dernier jour.', 'alerte');
    return el('p', 'Réponse attendue au plus tard le ' + d + ' : il reste ' + n + (n === 1 ? ' jour.' : ' jours.'), n <= 2 ? 'alerte' : null);
  }
  function mediator(m, c, ctx, box) {
    var on = day(typeof m.createdOn === 'string' ? m.createdOn.slice(0, 10) : null);
    var when = on ? ' le ' + on : '';
    if (m.status === 'envoye') box.appendChild(el('p', 'Proposition du médiateur envoyée au client' + when + ' (mode essai : rien ne part encore vraiment).', 'doux'));
    else if (m.status === 'remis') box.appendChild(el('p', 'Proposition du médiateur remise au client.', 'doux'));
    else if (m.status === 'a_remettre') {
      var said = text(m.text, 4000);
      box.appendChild(el('p', 'Proposition du médiateur à remettre vous-même au client' + (said ? ' :' : '.'), 'alerte'));
      if (said) box.appendChild(el('p', '« ' + said + ' »'));
      var b = button('Remise au client', function () {
        act(b, '/v1/securite/reclamations/' + encodeURIComponent(c.complaintId) + '/mediateur-remis', {}, ctx, 'Remise notée.');
      });
      box.appendChild(b);
    }
  }
  function answerForm(c, ctx, box) {
    var form = el('div'), id = c.complaintId;
    var issue = choice(form, 'rec-issue-' + id, 'Issue', OUTCOMES);
    var note = field(form, 'rec-reponse-' + id, 'Réponse donnée au client', 'textarea');
    note.setAttribute('maxlength', String(MAX));
    form.appendChild(el('p', 'La réponse ne se note qu’une fois.', 'doux'));
    var b = button('Noter la réponse', function () {
      act(b, '/v1/securite/reclamations/' + encodeURIComponent(id) + '/reponse', { outcome: issue.value, note: note.value }, ctx, 'Réponse notée.');
    });
    form.appendChild(b);
    box.appendChild(form);
  }
  function item(c, ctx) {
    var via = own(VIA, c.receivedBy), on = day(c.receivedOn), summary = text(c.summary, MAX);
    if (!ID.test(c.complaintId || '') || !via || !on || !summary || !day(c.dueOn)) return null;
    var box = el('article', null, 'bloc');
    box.appendChild(el('h4', 'Réclamation reçue le ' + on + ' par ' + via));
    if (c.personId !== ctx.personId) box.appendChild(el('p', 'Rangée sur une fiche réunie à celle-ci.', 'doux'));
    box.appendChild(el('p', '« ' + summary + ' »'));
    var a = c.answer && typeof c.answer === 'object' ? c.answer : null;
    if (c.status === 'ouverte' && !a) box.appendChild(due(c));
    else if (a && own(OUTCOMES, a.outcome) && (c.status === a.outcome)) {
      var at = day(a.answeredOn);
      box.appendChild(el('p', own(OUTCOMES, a.outcome) + (at ? ', répondu le ' + at : '') + (a.late === true ? ', en retard.' : '.')));
      var n = text(a.note, MAX);
      if (n) box.appendChild(el('p', '« ' + n + ' »', 'doux'));
    } else return null;
    if (c.mediator && typeof c.mediator === 'object') mediator(c.mediator, c, ctx, box);
    if (c.status === 'ouverte' && !a) answerForm(c, ctx, box);
    return box;
  }
  function recordForm(ctx) {
    var box = el('div', null, 'bloc'), d = today();
    box.appendChild(el('h4', 'Ranger une réclamation reçue'));
    var on = field(box, 'rec-jour', 'Reçue le');
    on.setAttribute('type', 'date');
    if (d) { on.setAttribute('max', d); on.value = d; }
    var via = choice(box, 'rec-voie', 'Arrivée par', VIA);
    var summary = field(box, 'rec-motif', 'Ce que le client reproche', 'textarea');
    summary.setAttribute('maxlength', String(MAX));
    box.appendChild(el('p', 'L’échéance de la réponse est écrite par AIMMO au rangement, d’après le délai du réseau.', 'doux'));
    var b = button('Ranger la réclamation', function () {
      act(b, '/v1/securite/fiches/' + encodeURIComponent(ctx.personId) + '/reclamations', { receivedOn: on.value, receivedBy: via.value, summary: summary.value }, ctx, 'Réclamation rangée.');
    });
    box.appendChild(b);
    return box;
  }
  function act(b, path, body, ctx, done) {
    var c = ctx.corps;
    if (c.aimmoBusy) return Promise.resolve(false);
    var mine = t.session();
    c.aimmoBusy = true;
    b.disabled = true;
    ctx.said.textContent = 'Envoi…';
    return send(path, 'POST', body).then(function (x) {
      c.aimmoBusy = false;
      b.disabled = false;
      if (x.gone || mine !== t.session()) return false;
      // Sans réponse lisible, ou une panne du serveur : la réclamation a pu être rangée quand même.
      if (x.offline || !x.body || x.status >= 500) return load(ctx, LOST);
      if (!x.ok) { ctx.said.textContent = refusal(x); return false; }
      return load(ctx, done);
    });
  }
  function load(ctx, note) {
    // Chaque bloc compte ses lectures : une écriture finie sur une autre fiche n'arrête pas celle-ci.
    var mine = t.session(), at = ctx.corps.aimmoTurn = (ctx.corps.aimmoTurn || 0) + 1;
    clear(ctx.corps);
    ctx.said.textContent = 'Lecture des réclamations…';
    return send('/v1/securite/reclamations?fiche=' + encodeURIComponent(ctx.personId), 'GET').then(function (x) {
      if (x.gone || mine !== t.session() || at !== ctx.corps.aimmoTurn) return false;
      if (x.offline) { ctx.said.textContent = note === LOST ? LOST : OFFLINE; return false; }
      if (!x.ok || !x.body || !Array.isArray(x.body.data)) { ctx.said.textContent = note === LOST ? LOST : refusal(x); return false; }
      x.body.data.forEach(function (c) {
        // Le serveur ne rend que le groupe des fiches réunies à celle-ci (BR71).
        var b = c && typeof c === 'object' && typeof c.personId === 'string' && ID.test(c.personId) ? item(c, ctx) : null;
        if (b) ctx.corps.appendChild(b);
      });
      var none = ctx.corps.children.length === 0;
      ctx.said.textContent = note || (none ? 'Aucune réclamation rangée sur cette fiche.' : '');
      ctx.corps.appendChild(recordForm(ctx));
      return true;
    });
  }
  return function (personId, corps, said) { return load({ personId: personId, corps: corps, said: said }); };
};
`;
