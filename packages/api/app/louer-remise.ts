/**
 * La remise des clés et la gestion par un partenaire à l'écran (W16), servies à part (`/app/louer-remise.js`), chargées
 * au premier geste [R201]. Seule la signature réelle du bail ouvre la remise, jamais celle d'essai : le serveur le dit et
 * l'écran le répète en français [R108]. Aucun champ d'argent : le dépôt et le premier loyer sont déclarés réglés au
 * propriétaire, et le code écrit le récapitulatif [R107]. L'agent choisit un professionnel déjà confié, jamais une
 * référence [R74]. Une réponse perdue est dite telle, sans redemander le geste [R10]. Rien n'est gardé sur l'appareil.
 */
const REFUSALS = {
  lease_not_signed: 'Le bail n’est pas signé pour de vrai : une signature d’essai ne compte pas.',
  inventory_not_closed: 'La remise des clés attend l’état des lieux signé des deux parties.',
  inventory_other_lease: 'L’état des lieux signé porte sur un autre bail : refaites-le pour le bail en vigueur.',
  bad_date: 'Choisissez le jour de la remise : aujourd’hui ou un jour passé.',
  no_fees: 'Les honoraires ne sont pas encore rangés.',
  funds_in_text: 'Le récapitulatif n’a pas pu être préparé : rien n’est rangé.',
  not_manager: 'Ce professionnel n’est pas un gestionnaire.',
  other_listing: 'Cette mise en relation porte sur un autre logement ou un autre propriétaire.',
  not_entrusted: 'La gestion attend l’accord du propriétaire, puis d’être confiée dans l’écran « Partenaires ».',
  partner_unavailable: 'La carte G ou l’assurance de ce gestionnaire n’est pas valide ce jour.',
};
const DONE = {
  already_handed_over: 'La remise des clés était déjà rangée.',
  already_linked: 'Cette gestion était déjà confiée.',
};

export const LOUER_REMISE_SCRIPT = `'use strict';
globalThis.AIMMO_LOUER_REMISE = function (t) {
  var el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field, ID = t.ID, say = t.say, date = t.date, euros = t.euros;
  var REFUSALS = ${JSON.stringify(REFUSALS)};
  var DONE = ${JSON.stringify(DONE)};
  var busy = null;
  function plain(res) {
    if (res.status === 403) return 'Ce geste n’est pas dans vos droits.';
    return res.offline ? 'Pas de réseau. Réessayez dans un moment.' : 'La remise des clés ne se lit pas pour le moment.';
  }
  function act(box, base, path, body, fallback, done) {
    var mine = t.session();
    if (busy === mine) return;
    busy = mine;
    say('Envoi…');
    return send(path, 'POST', body).then(function (res) {
      if (busy === mine) busy = null;
      if (res.gone) return;
      if (res.ok) return t.reload(done);
      if (res.offline || !res.body || res.status >= 500) {
        clear(box);
        box.appendChild(button('Relire la remise des clés', function () { open(box, base); }));
        say('Réponse perdue : ce geste est peut-être rangé. Relisez avant de recommencer.');
        return;
      }
      if (DONE[res.body.code]) return t.reload(DONE[res.body.code]);
      say(res.status === 403 ? 'Ce geste n’est pas dans vos droits.' : REFUSALS[res.body.code] || fallback);
    });
  }
  function feesPart(box, res) {
    box.appendChild(el('h4', 'Honoraires de location'));
    if (!res.ok) {
      box.appendChild(el('p', res.body && REFUSALS[res.body.code] ? REFUSALS[res.body.code] : 'Les honoraires ne se lisent pas pour le moment.', 'doux'));
      return;
    }
    var f = res.body.data || {};
    var parts = euros(f.tenantCents) + ' pour le locataire, ' + euros(f.landlordCents) + ' pour le bailleur';
    if (f.due === true) box.appendChild(el('p', 'Dus depuis le ' + date(f.dueSince) + ' : ' + parts + '.'));
    else box.appendChild(el('p', 'Pas encore dus : ils le deviennent à la signature réelle du bail. Au barème : ' + parts + '.', 'doux'));
    box.appendChild(el('p', 'Facturés à part : rien n’est encaissé ici.', 'doux'));
  }
  function keysPart(box, base, d) {
    box.appendChild(el('h4', 'Remise des clés'));
    if (d.handover) {
      box.appendChild(el('p', 'Rangée, jour du ' + date(d.handover.handedOn) + '.', 'fait'));
      String(d.handover.text || '').split('\\n').forEach(function (x) { box.appendChild(el('p', x)); });
      return;
    }
    if (d.leaseSigned !== true) { box.appendChild(el('p', REFUSALS.lease_not_signed + ' La remise des clés attend la signature réelle.', 'alerte')); return; }
    if (d.inventoryClosed !== true) { box.appendChild(el('p', REFUSALS.inventory_not_closed, 'alerte')); return; }
    if (d.writable !== true) { box.appendChild(el('p', 'Clés pas encore remises.', 'doux')); return; }
    box.appendChild(el('p', 'Le dépôt de garantie et le premier loyer sont réglés directement au propriétaire : rien ne passe par le réseau.', 'doux'));
    var day = field(box, 'remise-jour', 'Jour de la remise des clés');
    day.setAttribute('type', 'date');
    box.appendChild(button('Ranger la remise des clés', function () {
      var v = String(day.value || '').trim();
      if (!v) { say(REFUSALS.bad_date); return; }
      act(box, base, base + '/remise-des-cles', { handedOn: v }, 'La remise des clés n’est pas rangée.', 'Remise des clés rangée.');
    }));
  }
  function managerPart(box, base, d) {
    box.appendChild(el('h4', 'Gestion locative'));
    box.appendChild(el('p', 'Le réseau ne gère jamais : la gestion va à un gestionnaire titulaire de la carte G, avec l’accord du propriétaire.', 'doux'));
    (d.managers || []).forEach(function (m) { box.appendChild(el('p', 'Confiée à ' + m.partnerName + ', le ' + date(m.linkedAt) + '.', 'fait')); });
    if (d.writable !== true) return;
    var rows = Array.isArray(d.entrustable) ? d.entrustable : [];
    if (!rows.length && !(d.managers || []).length) box.appendChild(el('p', 'Aucun gestionnaire confié pour ce logement : passez par l’écran « Partenaires », avec l’accord du propriétaire.', 'doux'));
    rows.forEach(function (r) {
      if (typeof r.referralId !== 'string' || !ID.test(r.referralId)) return;
      if (r.available !== true) { box.appendChild(el('p', r.partnerName + ' : ' + REFUSALS.partner_unavailable, 'alerte')); return; }
      box.appendChild(button('Confier la gestion à ' + r.partnerName, function () {
        act(box, base, base + '/gestion', { referralId: r.referralId }, 'La gestion n’est pas confiée.', 'Gestion confiée à ' + r.partnerName + '.');
      }));
    });
  }
  function open(box, base, keep) {
    clear(box);
    var mine = t.session();
    if (!keep) say('Chargement…');
    return Promise.all([send(base + '/remise-des-cles', 'GET'), send(base + '/honoraires-dus', 'GET')]).then(function (all) {
      if (mine !== t.session() || all[0].gone || all[1].gone) return;
      if (!all[0].ok) { box.appendChild(button('Ouvrir la remise des clés', function () { open(box, base); })); say(plain(all[0])); return; }
      if (!keep) say('');
      var d = all[0].body.data || {};
      feesPart(box, all[1]);
      keysPart(box, base, d);
      managerPart(box, base, d);
    });
  }
  return { open: open };
};
`.replace(/^[ \t]*(?:\/\/.*|\/\*.*\*\/)[ \t]*\n/gm, '');
