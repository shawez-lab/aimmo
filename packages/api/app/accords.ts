import { AGENT_CONSENT_LABELS } from '@aimmo/core';

/**
 * Le bloc « Accords » de la fiche (AC03) [R03, R202, R203] : l'agent voit les accords, note celui qu'une personne lui a
 * donné ou sa demande de rappel, et le retire quand elle le demande. Chaque refus se dit en français ; le serveur décide,
 * l'écran ne remplace aucun contrôle. Après chaque geste, la fiche est relue : le bouton d'appel suit l'accord. Sujet,
 * canal et jour sont à choisir à chaque fois : rien de présélectionné ne peut rouvrir un accord par distraction. L'écran
 * envoie le jour seul : l'heure est celle du serveur, jamais celle du téléphone.
 */
const FORM_PURPOSES: Readonly<Record<string, string>> = Object.freeze({ ...AGENT_CONSENT_LABELS });

export const ACCORDS_JS = `
  /* ---------- Les accords de la fiche (AC03). ---------- */
  var ACCORD_PURPOSES = ${JSON.stringify(FORM_PURPOSES)};
  var ACCORD_CHANNELS = { phone: 'Téléphone', email: 'Mail', sms: 'SMS', whatsapp: 'WhatsApp' };
  var ACCORD_REFUSALS = {
    role: 'Réservé à l’agent du client et à la direction.',
    not_assigned: 'Ce client est suivi par un autre agent.',
    bad_purpose: 'Choisissez le sujet de l’accord.',
    bad_channel: 'Choisissez le canal de l’accord.',
    bad_proof: 'Écrivez comment la personne a donné son accord : 10 à 1 000 caractères.',
    bad_date: 'Choisissez le jour où la personne l’a donné.',
    future_date: 'La date de l’accord ne peut pas être dans le futur.',
    stopped: 'Cette personne a demandé l’arrêt : aucun accord ne peut être noté.',
    excluded: 'Cette personne est exclue : aucun accord ne peut être noté.',
    given_before_withdrawal: 'Un accord a été retiré depuis ce jour : il faut un accord donné après le retrait.',
    given_before_lift: 'Cette date est antérieure à la fin de son exclusion : il faut un accord donné après.',
    unknown_consent: 'Cet accord n’est plus sur cette fiche.'
  };
  function accordRefusal(res, fallback) {
    if (res.offline) return 'Pas de réseau : rien n’est enregistré.';
    return (res.body && ACCORD_REFUSALS[res.body.code]) || fallback;
  }
  // Ces refus disent que la fiche a changé : elle est relue, et le message reste affiché.
  var ACCORD_STALE = { stopped: 1, excluded: 1, not_assigned: 1, unknown_consent: 1, role: 1 };
  function accordFailed(res, personId, state, fallback) {
    var message = accordRefusal(res, fallback);
    if (res.body && ACCORD_STALE[res.body.code]) {
      return openFiche(personId).then(function () { $('fiche-etat').textContent = message; return false; });
    }
    state.textContent = message;
    return false;
  }
  // Un seul envoi à la fois : un double clic ne range pas deux fois.
  function accordButton(text, act) {
    var busy = false;
    var b = button(text, function () {
      if (busy) return false;
      busy = true;
      b.disabled = true;
      return act().then(function (done) { busy = false; b.disabled = false; return done; });
    });
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
      var li = line((PURPOSES[c.purpose] || ACCORD_PURPOSES[c.purpose] || 'autre accord') + ' par ' + channel(c.channel), c.withdrawnAt ? 'Retiré le ' + date(c.withdrawnAt) : 'Donné le ' + date(c.givenAt));
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
    // Une personne exclue ou arrêtée ne reçoit aucun accord [R02, R04] : retirer reste possible, noter non.
    if (f.contact && f.contact.allowed) {
      var form = el('div', null, 'decision');
      var id = cSeq();
      form.appendChild(el('p', 'Notez seulement ce que la personne vous a dit elle-même. La parole d’un proche n’est pas un accord.', 'doux'));
      var purpose = cSelect(form, id + '-sujet', 'Sujet', accordChoices(ACCORD_PURPOSES));
      var via = cSelect(form, id + '-canal', 'Canal', accordChoices(ACCORD_CHANNELS));
      var day = field(form, id + '-date', 'Donné le');
      day.setAttribute('type', 'date');
      day.setAttribute('max', cToday());
      var proof = field(form, id + '-preuve', 'Comment elle l’a donné : où, quand, par quels mots', 'textarea');
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
      box.appendChild(form);
    }
    box.appendChild(state);
    return box;
  }
`;
