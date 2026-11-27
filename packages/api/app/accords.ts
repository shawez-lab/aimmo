import { AGENT_CONSENT_LABELS } from '@aimmo/core';

/**
 * Le bloc « Accords » de la fiche (AC03) [R03, R202, R203] : l'agent voit les accords, note celui qu'une personne lui a
 * donné ou sa demande de rappel, et le retire quand elle le demande. Chaque refus se dit en français ; le serveur décide,
 * l'écran ne remplace aucun contrôle. Après chaque geste, la fiche est relue : le bouton d'appel suit l'accord. Sujet,
 * canal et jour sont à choisir à chaque fois : rien de présélectionné ne peut rouvrir un accord par distraction. L'écran
 * envoie le jour seul : l'heure est celle du serveur, jamais celle du téléphone. Un refus qui dit que la fiche a changé
 * la fait relire ; un seul envoi à la fois ; une personne exclue n'a plus de formulaire, retirer reste possible [R02, R04].
 * DS010 · ce bloc n'est plus dans le script de l'application : il fait partie de la fiche servie à part
 * (`/app/fiche.js`), qui lui donne ses outils. Ses gestes sont filaires : sur la fiche, seul « Appeler » est plein (DS022).
 */
const FORM_PURPOSES: Readonly<Record<string, string>> = AGENT_CONSENT_LABELS;

export const ACCORDS_JS = `
  var ACCORD_PURPOSES = ${JSON.stringify(FORM_PURPOSES)};
  var ACCORD_SHOWN = { appointment: 'Rendez-vous', reply: 'Demande de la personne' };
  var ACCORD_CHANNELS = { phone: 'Téléphone', email: 'Mail', sms: 'SMS', whatsapp: 'WhatsApp' };
  var ACCORD_REFUSALS = {
    not_assigned: 'Ce client est suivi par un autre agent.',
    bad_purpose: 'Choisissez le sujet.',
    bad_channel: 'Choisissez le canal.',
    bad_proof: 'Écrivez comment la personne a donné son accord : 10 à 1 000 caractères.',
    bad_date: 'Choisissez le jour où la personne l’a donné.',
    future_date: 'Ce jour est dans le futur.',
    stopped: 'Cette personne a demandé l’arrêt : aucun accord possible.',
    excluded: 'Cette personne est exclue : aucun accord possible.',
    given_before_withdrawal: 'Un accord a été retiré depuis ce jour : il faut un accord donné après le retrait.',
    given_before_lift: 'Ce jour précède la fin de son exclusion : il faut un accord donné après.',
    given_before_refusal: 'Elle a refusé depuis ce jour : il faut une demande donnée après.',
    unknown_consent: 'Cet accord n’est plus sur cette fiche.'
  };
  function accordRefusal(res, fallback) {
    if (res.offline) return 'La réponse n’est pas arrivée : rien n’est sûr. Relisez avant de recommencer.';
    return (res.body && ACCORD_REFUSALS[res.body.code]) || fallback;
  }
  var ACCORD_STALE = { stopped: 1, excluded: 1, not_assigned: 1, unknown_consent: 1 };
  function accordFailed(res, personId, state, fallback) {
    var message = accordRefusal(res, fallback);
    if (res.body && ACCORD_STALE[res.body.code]) {
      return openFiche(personId).then(function () { $('fiche-etat').textContent = message; return false; });
    }
    state.textContent = message;
    return false;
  }
  function accordButton(text, act) {
    var busy = false;
    var b = quiet(button(text, function () {
      if (busy) return false;
      busy = true;
      b.disabled = true;
      return act().then(function (done) { busy = false; b.disabled = false; return done; });
    }));
    return b;
  }
  function accordChoices(labels) {
    var out = { '': 'Choisir…' };
    Object.keys(labels).forEach(function (k) { out[k] = labels[k]; });
    return out;
  }
  function accordsBlock(personId, f) {
    var box = el('section', null, 'bloc');
    box.appendChild(el('h3', 'Accords'));
    var base = '/v1/fiches/' + encodeURIComponent(personId) + '/accords';
    var state = cState();
    var list = el('ul', null, 'liste');
    (f.consents || []).forEach(function (c) {
      var li = line((ACCORD_PURPOSES[c.purpose] || ACCORD_SHOWN[c.purpose] || 'Autre accord') + ' par ' + channel(c.channel), c.withdrawnAt ? 'Retiré le ' + date(c.withdrawnAt) : 'Donné le ' + date(c.givenAt));
      if (!c.withdrawnAt && typeof c.id === 'string' && ID.test(c.id)) {
        li.appendChild(accordButton('Retirer cet accord', function () {
          state.textContent = 'Enregistrement…';
          return send(base + '/' + encodeURIComponent(c.id) + '/retrait', 'POST').then(function (res) {
            if (res.gone) return false;
            if (!res.ok) return accordFailed(res, personId, state, 'L’accord n’a pas pu être retiré.');
            return openFiche(personId);
          });
        }));
      }
      list.appendChild(li);
    });
    if (!(f.consents || []).length) box.appendChild(el('p', 'Aucun accord enregistré.', 'doux'));
    box.appendChild(list);
    if (f.contact && f.contact.allowed) {
      var form = el('div', null, 'decision');
      var id = cSeq();
      form.appendChild(el('p', 'Seulement ce que la personne a dit elle-même : la parole d’un proche n’est pas un accord.', 'doux'));
      var purpose = cSelect(form, id + '-sujet', 'Sujet', accordChoices(ACCORD_PURPOSES));
      var via = cSelect(form, id + '-canal', 'Canal', accordChoices(ACCORD_CHANNELS));
      var day = field(form, id + '-date', 'Donné le');
      day.setAttribute('type', 'date');
      day.setAttribute('max', cToday());
      var proof = field(form, id + '-preuve', 'Comment elle l’a donné', 'textarea');
      form.appendChild(accordButton('Noter l’accord', function () {
        state.textContent = 'Enregistrement…';
        return send(base, 'POST', { purpose: purpose.value, channel: via.value, proof: proof.value, givenOn: day.value }).then(function (res) {
          if (res.gone) return false;
          if (!res.ok) return accordFailed(res, personId, state, 'L’accord n’a pas pu être noté.');
          var data = res.body.data || {};
          if (data.already) { state.textContent = 'Déjà noté, le ' + date(data.givenAt) + ' : la nouvelle preuve n’est pas rangée.'; return false; }
          return openFiche(personId);
        });
      }));
      var more = el('details');
      more.appendChild(el('summary', 'Noter un accord'));
      more.appendChild(form);
      box.appendChild(more);
      box.appendChild(espaceEntry(personId, state));
    }
    box.appendChild(state);
    return box;
  }
  var espaceTool = null, espaceBusy = false;
  function espaceEntry(personId, state) {
    var inner = el('div');
    var say = function (x) { state.textContent = x; };
    inner.appendChild(quiet(button('Ouvrir son espace client', function () {
      if (espaceTool) return espaceTool.form(inner, personId, say);
      if (espaceBusy) return;
      espaceBusy = true;
      var mine = session();
      say('Chargement…');
      var s = el('script');
      s.setAttribute('src', '/app/espace-agent.js');
      s.addEventListener('load', function () {
        espaceBusy = false;
        var make = globalThis.AIMMO_ESPACE_AGENT;
        try { delete globalThis.AIMMO_ESPACE_AGENT; } catch (e) {}
        if (typeof make !== 'function') { if (mine === session()) say('Pas de réseau. Réessayez dans un moment.'); return; }
        espaceTool = make({ el: el, clear: clear, send: send, button: accordButton, field: field, seq: cSeq });
        if (mine === session()) { say(''); espaceTool.form(inner, personId, say); }
      });
      s.addEventListener('error', function () {
        espaceBusy = false;
        if (mine === session()) say('Pas de réseau. Réessayez dans un moment.');
      });
      inner.appendChild(s);
    })));
    return inner;
  }
`;
