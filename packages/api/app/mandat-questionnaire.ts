/**
 * Le mandat par questionnaire à l'écran de l'agent (BR116 ; M06 Mandats et documents) [R440, R441, R442, R443, R16].
 *
 * Script servi à part (`/app/mandat-questionnaire.js`), chargé au seul geste qui le demande depuis l'écran « Mandat »,
 * pour tenir le budget de l'application [R201]. Il lit les questions et leurs réponses permises à l'API
 * (`GET /v1/questionnaire-mandat`) et les pose en listes fermées : aucune réponse libre ne part [R440]. Il prépare le
 * mandat (`POST /v1/questionnaire-mandat/mandats`), puis montre chaque clause retenue avec la réponse qui l'a fait entrer
 * et le texte de loi qui la fonde, et l'état de son texte (validé, d'essai, pas encore écrit) [R442]. Il dit le prix
 * comparé à l'avis de valeur, et l'agent du bien dit avoir montré l'écart au vendeur [R441]. Il lit enfin ce qui empêche
 * encore de signer, en phrases simples : jamais « prêt » tant qu'un blocage reste. Rien n'est calculé ici : l'écran pose ce
 * que le code rend. Les adresses ne portent que des identifiants, jamais un prix ni un texte [R13]. Rien n'est gardé dans
 * le navigateur ; tout texte reçu est posé en texte.
 */
import { TEMPLATE_FIELDS } from '../../core/src/documents/modeles.ts';

const REFUSALS: Record<string, string> = {
  role: 'Le questionnaire est réservé à l’agent et à la direction.',
  bad_answers: 'Une réponse n’est pas dans la liste : rechargez le questionnaire.',
  bad_input: 'Vérifiez les honoraires et la durée.',
  invalid_ids: 'Choisissez le mandant.',
  no_template: 'Aucun modèle de mandat n’est encore enregistré : voyez avec la direction.',
  not_property_agent: 'Seul l’agent du bien dit avoir montré l’écart au vendeur.',
  nothing_to_acknowledge: 'Le prix est dans la fourchette : rien à montrer.',
  already_acknowledged: 'C’est déjà noté.',
  unknown: 'Ce mandat n’est pas dans vos droits.',
  unknown_field: 'La demande n’a pas pu être lue. Rechargez l’écran.',
  invalid_body: 'La demande n’a pas pu être lue. Rechargez l’écran.',
};

/** Ce qui empêche de signer, dit en français ; un code inconnu reste un blocage, jamais un feu vert [R441]. */
const BLOCKERS: Record<string, string> = {
  essai: 'Document d’essai : un texte de clause ou le modèle n’est pas encore validé, il ne se signe pas.',
  manque: 'Il manque encore des éléments au mandat (liste ci-dessus).',
  ecart_prix: 'L’écart entre le prix et l’avis de valeur n’est pas encore montré au vendeur.',
  sans_avis: 'Le prix n’a pas été comparé à un avis de valeur validé, et le vendeur n’en a pas encore été averti.',
  sans_prix: 'Le bien n’a pas de prix : il n’a pas été comparé à l’avis de valeur, et le vendeur n’en a pas encore été averti.',
};

const STATUSES: Record<string, string> = {
  valide: 'Texte validé par la conformité.',
  essai: 'Texte d’essai : pas encore validé par la conformité.',
  manquante: 'Texte pas encore écrit par la direction.',
};

/** Le geste de l'agent selon le relevé du prix ; « dans la fourchette » n'en a pas [R441]. */
const ACKS: Record<string, string> = {
  ecart: 'J’ai montré l’écart au vendeur',
  sans_avis: 'J’ai dit au vendeur que le prix n’est pas comparé',
  sans_prix: 'J’ai dit au vendeur que le prix n’est pas comparé',
};

const FIELD_NAMES = Object.fromEntries(Object.entries(TEMPLATE_FIELDS).map(([k, v]) => [k, v.label]));

export const MANDAT_QUESTIONNAIRE_SCRIPT = `'use strict';
globalThis.AIMMO_MANDAT_QUESTIONNAIRE = function (t) {
  var el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field, ID = t.ID;
  var NO = ${JSON.stringify(REFUSALS)}, BLOCKERS = ${JSON.stringify(BLOCKERS)}, STATUSES = ${JSON.stringify(STATUSES)};
  var ACKS = ${JSON.stringify(ACKS)}, FIELDS = ${JSON.stringify(FIELD_NAMES)};
  var OFFLINE = 'Pas de réseau. Réessayez dans un moment.';
  var LOST = 'La réponse n’est pas arrivée : rien n’est sûr. Rouvrez l’écran pour voir ce qui est rangé.';
  var BASE = '/v1/questionnaire-mandat';
  /* Chaque ouverture a son tour : une réponse d'un tour passé ne touche plus l'écran. */
  var turn = 0, busy = null;
  function why(x, fallback) {
    if (x.offline) return OFFLINE;
    return NO[(x.body || {}).code] || fallback;
  }
  function once(work) {
    if (busy) return Promise.resolve(false);
    var me = busy = {};
    function done(r) { if (busy === me) busy = null; return r; }
    return Promise.resolve().then(work).then(done, function () { return done(false); });
  }
  function percent(bps) { return (Number(bps) / 100).toLocaleString('fr-FR', { maximumFractionDigits: 2 }) + ' %'; }
  function euros(n) { return Number(n).toLocaleString('fr-FR') + ' €'; }
  function priceLine(p) {
    if (!p || p.check === 'sans_prix') return 'Le bien n’a pas encore de prix : il n’a pas pu être comparé à l’avis de valeur.';
    if (p.check === 'sans_avis') return 'Aucun avis de valeur validé pour ce bien : le prix n’a pas pu être comparé.';
    var head = 'Avis de valeur : entre ' + euros(p.low) + ' et ' + euros(p.high) + '. Prix du mandat : ' + euros(p.priceEur) + '.';
    if (p.check === 'dans_fourchette' && !p.gapBps) return head + ' Le prix est dans la fourchette.';
    var side = Number(p.priceEur) > Number(p.high) ? 'au-dessus' : 'au-dessous';
    return head + ' Écart de ' + percent(p.gapBps) + ' ' + side + ' de la fourchette (toléré : ' + percent(p.maxGapBps) + ').';
  }
  function missingName(m, clauses) {
    var s = String(m);
    if (s.indexOf('champ:') === 0) return FIELDS[s.slice(6)] || 'un champ du modèle';
    if (s.indexOf('clause:') === 0) { var c = clauses[s.slice(7)]; return 'le texte de la clause « ' + (c ? c.title : 'sans nom') + ' »'; }
    return 'un élément du mandat';
  }
  function show(box, ctx) {
    var mine = ++turn;
    busy = null;
    clear(box);
    var stateLine = el('p', '', 'etat');
    stateLine.setAttribute('role', 'status');
    function alive() { return mine === turn && ctx.alive(); }
    function say(x) { if (alive()) stateLine.textContent = x; }
    var form = el('div');
    var result = el('div');
    box.appendChild(form);
    box.appendChild(stateLine);
    box.appendChild(result);
    say('Chargement du questionnaire…');
    return send(BASE, 'GET').then(function (x) {
      if (x.gone || !alive()) return false;
      var cat = x.ok && x.body && x.body.data;
      if (!cat || !Array.isArray(cat.questions) || !Array.isArray(cat.clauses)) { say(x.offline ? OFFLINE : why(x, 'Le questionnaire est indisponible pour le moment.')); return false; }
      draw(form, result, cat, ctx, say, alive);
      say('');
      return true;
    });
  }
  function draw(form, result, cat, ctx, say, alive) {
    var picks = {};
    var questions = {};
    cat.questions.forEach(function (q) {
      if (!q || typeof q.code !== 'string' || !Array.isArray(q.answers)) return;
      questions[q.code] = q;
      var f = field(form, 'mq-' + q.code, String(q.label), 'select');
      var blank = el('option', 'À choisir');
      blank.value = '';
      f.appendChild(blank);
      q.answers.forEach(function (a) { var o = el('option', String(a.label)); o.value = String(a.value); f.appendChild(o); });
      picks[q.code] = f;
    });
    var fee = field(form, 'mq-honoraires', 'Honoraires, en euros');
    fee.setAttribute('inputmode', 'numeric');
    var months = field(form, 'mq-duree', 'Durée, en mois');
    months.setAttribute('inputmode', 'numeric');
    var clauses = {};
    cat.clauses.forEach(function (c) { if (c && typeof c.code === 'string') clauses[c.code] = c; });
    form.appendChild(button('Préparer le mandat par questionnaire', function () {
      return once(function () {
        var person = ctx.personId();
        if (!person || !ID.test(person)) { say('Choisissez le mandant.'); return false; }
        var answers = {}, open = null;
        Object.keys(picks).forEach(function (code) {
          var f = picks[code];
          var permitted = questions[code].answers.some(function (a) { return String(a.value) === f.value; });
          if (!f.value || !permitted) { if (open === null) open = questions[code].label; return; }
          answers[code] = f.value;
        });
        if (open !== null) { say('Répondez à la question : ' + open); return false; }
        var inputs = {}, p = fee.value.trim(), d = months.value.trim();
        if (p && !/^\\d{1,9}$/.test(p)) { say('Les honoraires : un montant en euros, sans centimes.'); return false; }
        if (d && !/^\\d{1,3}$/.test(d)) { say('La durée : un nombre de mois.'); return false; }
        if (p) inputs['honoraires.montant'] = Number(p);
        if (d) inputs['mandat.duree_mois'] = Number(d);
        say('Préparation…');
        return send(BASE + '/mandats', 'POST', { personId: person, propertyId: ctx.propertyId, answers: answers, inputs: inputs }).then(function (x) {
          if (x.gone || !alive()) return false;
          if (x.offline || !x.body || x.status >= 500) { say(LOST); return false; }
          if (!x.ok) { say(why(x, 'Le mandat n’est pas préparé : réessayez.')); return false; }
          var m = x.body.data;
          if (!m || !ID.test(String(m.id))) { say(LOST); return false; }
          say('Mandat préparé. Il est rangé avec les documents du bien.');
          drawMandate(result, m, questions, clauses, say, alive);
          return true;
        });
      });
    }));
  }
  function drawMandate(result, m, questions, clauses, say, alive) {
    clear(result);
    var list = el('ul', null, 'liste');
    var kept = Array.isArray(m.clauses) ? m.clauses : [];
    if (!kept.length) result.appendChild(el('p', 'Aucune clause particulière : les réponses n’en appellent pas.', 'doux'));
    kept.forEach(function (c) {
      var li = el('li');
      li.appendChild(el('strong', String(c.title || 'Clause')));
      var q = questions[c.question];
      var a = q && q.answers.filter(function (x) { return String(x.value) === String(c.answer); })[0];
      li.appendChild(el('p', 'Parce que : ' + (q ? q.label : 'une réponse') + ' → ' + (a ? a.label : 'réponse donnée')));
      li.appendChild(el('p', 'Fondement : ' + String(c.basis || 'non rendu')));
      li.appendChild(el('p', STATUSES[c.status] || STATUSES.manquante, 'doux'));
      list.appendChild(li);
    });
    if (kept.length) result.appendChild(list);
    var missing = Array.isArray(m.missing) ? m.missing : [];
    if (missing.length) result.appendChild(el('p', 'Il manque : ' + missing.map(function (x) { return missingName(x, clauses); }).join(', ') + '.'));
    var p = m.price || {};
    var priceBox = el('div');
    priceBox.appendChild(el('p', priceLine(p)));
    result.appendChild(priceBox);
    var check = el('div');
    result.appendChild(check);
    function readCheck() {
      return send(BASE + '/mandats/' + encodeURIComponent(m.id) + '/avant-signature', 'GET').then(function (x) {
        if (x.gone || !alive()) return false;
        clear(check);
        var d = x.ok && x.body && x.body.data;
        if (!d || !Array.isArray(d.blockers)) { check.appendChild(el('p', x.offline ? OFFLINE : why(x, 'Le contrôle avant signature n’a pas pu être lu : rien n’est dit prêt.'))); return false; }
        check.appendChild(el('h4', 'Avant de signer'));
        if (d.ready === true && d.blockers.length === 0) { check.appendChild(el('p', 'Rien n’empêche de signer : contrôlez le document puis faites-le signer.')); return true; }
        var ul = el('ul');
        (d.blockers.length ? d.blockers : ['inconnu']).forEach(function (b) { ul.appendChild(el('li', BLOCKERS[b] || 'Un point reste à régler : voyez avec la direction.')); });
        check.appendChild(ul);
        return true;
      });
    }
    if (ACKS[p.check]) {
      var ack = button(ACKS[p.check], function () {
        return once(function () {
          say('Enregistrement…');
          return send(BASE + '/mandats/' + encodeURIComponent(m.id) + '/ecart-montre', 'POST', {}).then(function (x) {
            if (x.gone || !alive()) return false;
            if (x.offline || !x.body || x.status >= 500) { say(LOST); return false; }
            var code = (x.body || {}).code;
            if (!x.ok && code !== 'already_acknowledged') { say(code === 'role' ? NO.not_property_agent : why(x, 'Rien n’est noté : réessayez.')); return false; }
            say(x.ok ? 'Noté : le vendeur a vu le prix comparé à l’avis de valeur.' : NO.already_acknowledged);
            ack.hidden = true;
            return readCheck();
          });
        });
      });
      priceBox.appendChild(ack);
    }
    return readCheck();
  }
  return { show: show };
};
`;
