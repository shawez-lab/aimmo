import { NDA_REVOCATION_REASONS, type NdaRevocationReason } from '../../core/src/commerces/confidentialite.ts';

/**
 * Les demandes et l'engagement de confidentialité à l'écran (CE14), servis à part (`/app/commerces-engagements.js`),
 * chargés au premier geste, pour que l'écran « Commerces » tienne son budget [R201]. L'agent du bien ou la direction
 * range la demande d'un contact, fait lire le texte, note l'accord, recueille le code et le tracé, révoque ; la direction
 * range le modèle. Le serveur seul dit si la porte est ouverte [R113] ; le code passe par le contrôle central, en mode
 * essai, rien ne part [R26]. L'écran ne garde que le numéro de la signature en cours, en mémoire, jamais le code.
 */

const REASON_LABELS: Record<NdaRevocationReason, string> = {
  demande_repreneur: 'Le repreneur le demande',
  manquement: 'Manquement à l’engagement',
  fin_de_vente: 'Fin de la vente',
  autre: 'Autre raison',
};
const REFUSALS = {
  bad_consent: 'Notez l’accord du repreneur : où et quand il l’a donné, en 300 caractères au plus.',
  bad_reason: 'Choisissez la raison dans la liste.',
  bad_body: 'Le modèle fait de 50 à 20 000 caractères.',
  bad_drawing: 'Le tracé est trop long : effacez-le et recommencez.',
  wrong_code: 'Ce code n’est pas le bon. Après 5 essais faux, la signature est bloquée.',
  expired: 'Ce code a expiré : envoyez-en un nouveau.',
  blocked: 'Trop d’essais faux : cette signature est bloquée. Envoyez un nouveau code.',
  unknown_session: 'Cette signature n’existe plus : envoyez un nouveau code.',
  already_signed: 'Cet engagement est déjà signé.',
  already_revoked: 'Cet engagement était déjà révoqué.',
  revoked: 'Cet engagement est révoqué : la porte reste fermée. Refaites une demande pour un nouvel engagement.',
  nda_changed: 'Ce texte a été modifié depuis l’envoi du code : rien n’est signé, la porte reste fermée.',
  send_refused: 'Le code n’est pas parti : heure d’envoi, personne exclue ou arrêtée, ou pas de mail sur la fiche. Rien n’est signé.',
  unknown_nda: 'Cet engagement n’existe plus : relisez le commerce.',
  unknown_person: 'Ce contact n’existe plus : relisez la liste.',
  sorte: 'Ce bien n’est pas un commerce.',
};

export const COMMERCES_ENGAGEMENTS_SCRIPT = `'use strict';
globalThis.AIMMO_CE_ENGAGEMENTS = function (t) {
  var el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field, ID = t.ID, say = t.say, reload = t.reload;
  var REASONS = ${JSON.stringify(REASON_LABELS)};
  var REASON_KEYS = ${JSON.stringify(NDA_REVOCATION_REASONS)};
  var SAY = ${JSON.stringify(REFUSALS)};
  /* Ce qui termine une signature : l'écran l'oublie et relit l'état du serveur. */
  var ENDED = ['expired', 'blocked', 'unknown_session', 'already_signed', 'revoked', 'nda_changed'];
  var signing = {}, seq = 0;
  /* Une vraie chaîne : ID.test(null) lirait « null ». */
  function isId(x) { return typeof x === 'string' && ID.test(x); }
  function why(res, fallback) {
    var code = res.body && res.body.code;
    if (code && Object.prototype.hasOwnProperty.call(SAY, code)) return SAY[code];
    if (res.status === 403) return 'Ce geste n’est pas dans vos droits.';
    if (res.offline || !res.body || res.status >= 500) return 'Réponse perdue : ce geste est peut-être rangé. Relisez la demande avant de recommencer.';
    return fallback;
  }
  /* Un geste : un seul envoi à la fois, et la réponse d'une autre séance est ignorée. */
  function act(path, body, btn, fallback, done, refused) {
    var mine = t.session();
    btn.disabled = true;
    say('Envoi…');
    return send(path, 'POST', body).then(function (res) {
      if (res.gone || mine !== t.session()) return;
      btn.disabled = false;
      if (res.ok) { done(res); return; }
      var code = res.body && res.body.code;
      if (refused && refused(code)) return;
      say(why(res, fallback));
    });
  }
  function request(base, personId, btn) {
    return act(base + '/demandes', { personId: personId }, btn, 'La demande n’est pas rangée.', function (res) {
      var d = res.body.data || {};
      reload(d.ndaId ? 'Demande rangée, rien n’est envoyé au repreneur : l’engagement est prêt à signer.' : 'Demande rangée, rien n’est envoyé au repreneur. La direction doit d’abord ranger le modèle d’engagement : refaites ensuite la demande.');
    });
  }
  /* Une nouvelle demande : le contact se choisit dans la liste, jamais par un identifiant, et rien n'est présélectionné. */
  function demand(box, propertyId, base) {
    clear(box);
    var mine = t.session();
    say('Chargement…');
    return send('/v1/offres/biens/' + encodeURIComponent(propertyId) + '/contacts', 'GET').then(function (res) {
      if (res.gone || mine !== t.session()) return;
      var retry = button('Choisir dans mes contacts', function () { demand(box, propertyId, base); });
      if (!res.ok) { box.appendChild(retry); say(res.offline ? 'Pas de réseau. Réessayez dans un moment.' : 'Vos contacts ne se lisent pas pour le moment.'); return; }
      var list = res.body.data && Array.isArray(res.body.data.contacts) ? res.body.data.contacts : [];
      if (!list.length) { box.appendChild(retry); say('Aucun contact à proposer : ajoutez d’abord le repreneur à vos contacts.'); return; }
      say('');
      var who = field(box, 'ce-demande-contact', 'Le repreneur', 'select');
      t.option(who, '', 'À choisir');
      list.forEach(function (c) { t.option(who, c.personId, [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Contact sans nom'); });
      if (res.body.data.more) box.appendChild(el('p', 'Liste coupée : seuls les premiers contacts sont proposés.', 'doux'));
      var go = button('Ranger la demande', function () {
        if (!who.value) { say('Choisissez le repreneur.'); return; }
        request(base, who.value, go);
      });
      box.appendChild(go);
    });
  }
  /* Le tracé : une suite de points posés du doigt, facultative, pour qui ne peut pas tracer le code suffit. */
  function pad(box) {
    var label = 'Tracé du repreneur, facultatif';
    box.appendChild(el('p', label, 'doux'));
    var c = el('canvas', null, 'trace');
    c.setAttribute('role', 'img');
    c.setAttribute('aria-label', label + ' : tracez avec le doigt dans ce cadre');
    c.setAttribute('width', '320');
    c.setAttribute('height', '140');
    var strokes = [], points = 0, down = false, ctx = null;
    try { ctx = c.getContext ? c.getContext('2d') : null; } catch (e) { ctx = null; }
    function at(e) {
      /* Le cadre s'étire sur la largeur du téléphone : le point est ramené à l'échelle du dessin. */
      var w = Number(c.clientWidth) || 320, h = Number(c.clientHeight) || 140;
      return [Math.max(0, Math.round((Number(e.offsetX) || 0) * 320 / w)), Math.max(0, Math.round((Number(e.offsetY) || 0) * 140 / h))];
    }
    c.addEventListener('pointerdown', function (e) {
      if (e && e.preventDefault) e.preventDefault();
      down = true;
      var p = at(e);
      strokes.push([p]);
      if (ctx) { ctx.beginPath(); ctx.moveTo(p[0], p[1]); }
    });
    c.addEventListener('pointermove', function (e) {
      if (!down || points >= 15000) return;
      var p = at(e);
      strokes[strokes.length - 1].push(p);
      points += 1;
      if (ctx) { ctx.lineTo(p[0], p[1]); ctx.stroke(); }
    });
    c.addEventListener('pointerup', function () { down = false; });
    c.addEventListener('pointerleave', function () { down = false; });
    box.appendChild(c);
    var wipeIt = button('Effacer le tracé', function () {
      strokes = [];
      points = 0;
      if (ctx) try { ctx.clearRect(0, 0, 320, 140); } catch (e) { /* rien à effacer */ }
    });
    wipeIt.className = 'secondaire';
    box.appendChild(wipeIt);
    return function () {
      var text = strokes.filter(function (s) { return s.length > 1; }).map(function (s) { return s.map(function (p) { return p[0] + ',' + p[1]; }).join(' '); }).join(';');
      return text.length >= 10 ? text : '';
    };
  }
  function consentForm(box, ndaId, sha) {
    clear(box);
    var n = ++seq;
    var proof = field(box, 'ce-engagement-accord-' + n, 'Accord du repreneur pour recevoir le code par mail (où, quand)');
    var go = button('Envoyer le code', function () {
      var said = String(proof.value || '').trim();
      if (!said) { say(SAY.bad_consent); return; }
      act('/v1/commerces/engagements/' + encodeURIComponent(ndaId) + '/signature', { consentProof: said }, go, 'Le code n’est pas parti.', function (res) {
        var d = res.body.data || {};
        if (!isId(d.sessionId)) { say('Réponse illisible : relisez la demande avant de recommencer.'); return; }
        /* Le repreneur signe le texte qu'il a lu, et aucun autre. */
        if (d.contentSha256 !== sha) { reload(SAY.nda_changed); return; }
        signing[ndaId] = d.sessionId;
        codeForm(box, ndaId, sha);
        say(d.mode === 'essai' ? 'Code préparé par le contrôle central, en mode essai : rangé dans la boîte d’essai, rien n’est parti.' : 'Code envoyé par le contrôle central.');
      });
    });
    box.appendChild(go);
  }
  function codeForm(box, ndaId, sha) {
    clear(box);
    var n = ++seq;
    var code = field(box, 'ce-engagement-code-' + n, 'Code reçu par le repreneur');
    code.setAttribute('inputmode', 'numeric');
    code.setAttribute('maxlength', '6');
    code.setAttribute('autocomplete', 'one-time-code');
    var drawing = pad(box);
    var go = button('Signer l’engagement', function () {
      var typed = String(code.value || '').trim();
      /* Un code mal saisi ne coûte aucun des 5 essais. */
      if (!/^\\d{6}$/.test(typed)) { say('Le code a 6 chiffres.'); return; }
      var body = { code: typed }, traced = drawing();
      if (traced) body.drawing = traced;
      act('/v1/commerces/signatures/' + encodeURIComponent(signing[ndaId]), body, go, 'La signature n’est pas rangée.', function () {
        delete signing[ndaId];
        reload('Engagement signé (signature d’essai). La porte s’ouvre quand la pièce d’identité est vérifiée.');
      }, function (c) {
        if (c === 'wrong_code') code.value = '';
        if (ENDED.indexOf(c) === -1) return false;
        delete signing[ndaId];
        reload(SAY[c]);
        return true;
      });
    });
    box.appendChild(go);
    var again = button('Envoyer un autre code', function () {
      delete signing[ndaId];
      consentForm(box, ndaId, sha);
      say('Notez de nouveau l’accord, puis envoyez un nouveau code.');
    });
    again.className = 'secondaire';
    box.appendChild(again);
  }
  /* Révoquer se confirme en deux appuis ; changer la raison désarme le premier. */
  function revokeForm(box, ndaId) {
    var f = t.fold(box, 'Révoquer cet engagement');
    var n = ++seq;
    var reason = field(f, 'ce-engagement-raison-' + n, 'Raison', 'select');
    t.option(reason, '', 'À choisir');
    REASON_KEYS.forEach(function (k) { t.option(reason, k, REASONS[k]); });
    var armed = false;
    reason.addEventListener('change', function () { armed = false; });
    var go = button('Révoquer', function () {
      if (!reason.value) { say(SAY.bad_reason); return; }
      if (!armed) { armed = true; say('Plus rien de confidentiel ne partira par cet engagement. Appuyez de nouveau pour confirmer.'); return; }
      armed = false;
      act('/v1/commerces/engagements/' + encodeURIComponent(ndaId) + '/revocation', { reason: reason.value }, go, 'La révocation n’est pas rangée.', function () {
        delete signing[ndaId];
        reload('Engagement révoqué : la porte est fermée, rien de confidentiel ne part plus.');
      }, function (c) {
        if (c !== 'already_revoked') return false;
        reload(SAY.already_revoked);
        return true;
      });
    });
    f.appendChild(go);
  }
  /* L'engagement d'une demande : le texte à lire d'abord, puis l'accord, le code et le tracé. */
  function line(box, base, r) {
    clear(box);
    var codes = Array.isArray(r.codes) ? r.codes : [];
    if (!isId(r.ndaId)) {
      box.appendChild(el('p', codes.indexOf('engagement_revoque') !== -1 ? 'L’ancien engagement reste révoqué. Une nouvelle demande fait un nouvel engagement, à signer de nouveau.' : 'Aucun engagement à signer : le modèle manquait. Une fois le modèle rangé par la direction, refaites la demande.', 'doux'));
      var redo = button('Refaire la demande', function () { request(base, r.personId, redo); });
      box.appendChild(redo);
      return Promise.resolve();
    }
    var mine = t.session();
    say('Chargement…');
    return send('/v1/commerces/engagements/' + encodeURIComponent(r.ndaId), 'GET').then(function (res) {
      if (res.gone || mine !== t.session()) return;
      var d = res.ok ? res.body.data : null;
      if (!d) {
        var retry = button('Lire l’engagement', function () { line(box, base, r); });
        box.appendChild(retry);
        say(res.status === 403 ? 'Ce geste n’est pas dans vos droits.' : res.offline ? 'Pas de réseau. Réessayez dans un moment.' : 'L’engagement ne se lit pas pour le moment.');
        return;
      }
      /* Révoqué depuis la dernière lecture : jamais dit « signé », l'écran relit l'état du serveur [R113]. */
      if (d.revoked) { delete signing[r.ndaId]; reload(SAY.revoked); return; }
      say('');
      var text = t.fold(box, d.signed ? 'Le texte signé' : 'Le texte à faire lire');
      String(d.content).split('\\n').forEach(function (p) { if (p.trim()) text.appendChild(el('p', p)); });
      if (d.signed && codes.indexOf('engagement_modifie') !== -1) box.appendChild(el('p', 'Ce texte a changé depuis sa signature : la porte reste fermée. Révoquez cet engagement, puis refaites la demande.', 'retard'));
      else if (d.signed) box.appendChild(el('p', 'Engagement signé (signature d’essai).', 'fait'));
      else {
        text.setAttribute('open', '');
        box.appendChild(el('p', 'Faites lire ce texte au repreneur avant le code. Signature d’essai tant que l’avocat n’a pas validé le dossier de preuve.', 'doux'));
        var flow = el('div');
        box.appendChild(flow);
        if (signing[r.ndaId]) codeForm(flow, r.ndaId, d.contentSha256); else consentForm(flow, r.ndaId, d.contentSha256);
      }
      revokeForm(box, r.ndaId);
    });
  }
  /* Le modèle de la direction : la dernière version lue, une nouvelle version s'ajoute, les engagements faits gardent leur texte [R17]. */
  function model(box) {
    clear(box);
    var mine = t.session();
    say('Chargement…');
    return send('/v1/commerces/engagements/modeles', 'GET').then(function (res) {
      if (res.gone || mine !== t.session()) return;
      if (!res.ok) {
        box.appendChild(button('Lire le modèle', function () { model(box); }));
        say(res.status === 403 ? 'Ce geste n’est pas dans vos droits.' : res.offline ? 'Pas de réseau. Réessayez dans un moment.' : 'Le modèle ne se lit pas pour le moment.');
        return;
      }
      say('');
      var cur = res.body.data;
      var seen = el('p', cur ? 'En vigueur : version ' + cur.version + ', rangée le ' + t.day(cur.createdAt) + '.' : 'Aucun modèle : aucun engagement ne peut se faire.', cur ? '' : 'retard');
      box.appendChild(seen);
      var text = field(box, 'ce-modele-texte', 'Texte du modèle', 'textarea');
      var held = cur ? String(cur.body) : '';
      text.value = held;
      var go = button('Ranger une nouvelle version', function () {
        var typed = String(text.value || '').trim();
        if (typed === held) { say('Le texte n’a pas changé : aucune version ajoutée.'); return; }
        if (typed.length < 50 || typed.length > 20000) { say(SAY.bad_body); return; }
        act('/v1/commerces/engagements/modeles', { body: typed }, go, 'Le modèle n’est pas rangé.', function (r) {
          var v = r.body.data || {};
          held = typed;
          seen.className = '';
          seen.textContent = 'En vigueur : version ' + v.version + ', rangée le ' + t.day(v.createdAt) + '.';
          say('Version ' + v.version + ' rangée. Les engagements déjà faits gardent leur texte.');
        });
      });
      box.appendChild(go);
    });
  }
  return { demand: demand, line: line, model: model, wipe: function () { signing = {}; } };
};
`;
