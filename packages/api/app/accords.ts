import { AGENT_CONSENT_LABELS } from '@aimmo/core';

/**
 * Le bloc « Accords » de la fiche (AC03) [R03, R202, R203] : l'agent voit les accords, note celui qu'une personne lui a
 * donné ou sa demande de rappel, et le retire quand elle le demande. Chaque refus se dit en français ; le serveur décide,
 * l'écran ne remplace aucun contrôle. Après chaque geste, la fiche est relue : le bouton d'appel suit l'accord.
 */
const FORM_PURPOSES: Readonly<Record<string, string>> = Object.freeze({
  rappel_demande: AGENT_CONSENT_LABELS.rappel_demande!,
  ...AGENT_CONSENT_LABELS,
});

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
    bad_date: 'Date non valable.',
    future_date: 'La date de l’accord ne peut pas être dans le futur.',
    stopped: 'Cette personne a demandé l’arrêt : aucun accord ne peut être noté.',
    excluded: 'Cette personne est exclue : aucun accord ne peut être noté.',
    given_before_withdrawal: 'Cet accord a été retiré depuis cette date : il faut un accord donné après le retrait.',
    given_before_lift: 'Cette date est antérieure à la fin de son exclusion : il faut un accord donné après.',
    unknown_consent: 'Cet accord n’est plus sur cette fiche.'
  };
  function accordRefusal(res, fallback) {
    if (res.offline) return 'Pas de réseau : rien n’est enregistré.';
    return (res.body && ACCORD_REFUSALS[res.body.code]) || fallback;
  }
  // La date choisie : aujourd'hui vaut maintenant, un jour passé vaut midi, pour une heure que personne n'a inventée de nuit.
  function accordDate(day) {
    if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(day)) return null;
    if (day === cToday()) return new Date().toISOString();
    var at = new Date(day + 'T12:00:00');
    return isNaN(at.getTime()) ? null : at.toISOString();
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
        li.appendChild(button('Retirer cet accord', function () {
          state.textContent = 'Enregistrement…';
          return send(base + '/' + encodeURIComponent(c.id) + '/retrait', 'POST').then(function (res) {
            if (res.gone) return false;
            if (!res.ok) { state.textContent = accordRefusal(res, 'L’accord n’a pas pu être retiré.'); return false; }
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
      var purpose = cSelect(form, id + '-sujet', 'Sujet', ACCORD_PURPOSES);
      var via = cSelect(form, id + '-canal', 'Canal', ACCORD_CHANNELS);
      var day = field(form, id + '-date', 'Donné le');
      day.setAttribute('type', 'date');
      day.value = cToday();
      var proof = field(form, id + '-preuve', 'Comment elle l’a donné : où, quand, par quels mots', 'textarea');
      form.appendChild(button('Noter l’accord', function () {
        var givenAt = accordDate(day.value);
        if (!givenAt) { state.textContent = ACCORD_REFUSALS.bad_date; return false; }
        state.textContent = 'Enregistrement…';
        return send(base, 'POST', { purpose: purpose.value, channel: via.value, proof: proof.value, givenAt: givenAt }).then(function (res) {
          if (res.gone) return false;
          if (!res.ok) { state.textContent = accordRefusal(res, 'L’accord n’a pas pu être noté.'); return false; }
          return openFiche(personId);
        });
      }));
      box.appendChild(form);
    }
    box.appendChild(state);
    return box;
  }
`;
