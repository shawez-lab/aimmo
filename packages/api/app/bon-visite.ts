/**
 * AU075 · Le bon de visite signé sans papier, depuis l'écran de la visite [R40, R03, R16, R201, R506]. Le bloc est posé
 * par l'écran de la visite sur un bon complet et pas encore signé ; son script est servi à part (`/app/bon-visite.js`)
 * et chargé au premier geste : l'application ne grossit pas.
 *
 * Sur place : l'agent ouvre la signature (`POST /v1/visites/<id>/bon/signature-en-ligne`), le visiteur reçoit son code
 * sur son téléphone, lit le bon sur l'écran de l'agent (`GET …/bon/a-signer`), tape lui-même son code et trace sa
 * signature s'il le veut (`POST …/bon/signature-sur-place`). À distance : le lien et le code partent au visiteur.
 * Tout texte reçu est posé en texte ; chaque refus est dit en mots, jamais par son code ; le code tapé n'est gardé
 * nulle part sur l'appareil.
 */

/** Chaque refus, dit en mots. */
export const BON_VISITE_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  role: 'Ce geste n’est pas dans vos droits.',
  not_assigned: 'Ce visiteur est suivi par un autre agent.',
  unknown: 'Cette visite n’existe plus : rouvrez-la.',
  remote_visit: 'Visite faite à distance : son bon se signe par le lien envoyé à la fin de la visite.',
  not_booked: 'Cette visite n’est plus prévue : le bon ne se signe pas.',
  outside_window: 'Sur place, la signature s’ouvre 30 minutes avant la visite et jusqu’à 2 heures après ; à distance, de l’heure de la visite à 7 jours après.',
  already_signed: 'Le bon est déjà signé.',
  slip_incomplete: 'Le bon est incomplet : complétez la fiche avant de le faire signer.',
  no_phone: 'Pas de téléphone sur la fiche du visiteur : choisissez le mail.',
  no_email: 'Pas de mail sur la fiche du visiteur : choisissez le SMS.',
  no_consent: 'Cochez d’abord l’accord du visiteur.',
  consent_withdrawn: 'Le visiteur a retiré son accord : il ne reçoit rien sur ce canal.',
  send_refused: 'Le message ne peut pas partir maintenant, entre 20 h et 8 h ou le dimanche : rien n’est parti.',
  already_open: 'Une signature vient d’être ouverte : relisez l’écran.',
  not_open: 'Aucune signature en cours : ouvrez-la de nouveau.',
  wrong_code: 'Code faux. Le visiteur peut réessayer.',
  blocked: 'Cinq codes faux : la signature est bloquée. Ouvrez-en une nouvelle.',
  expired: 'Le code a expiré : ouvrez une nouvelle signature.',
  slip_changed: 'Le bon a changé : rouvrez la visite.',
  bad_drawing: 'Le tracé n’a pas pu être lu : effacez-le et recommencez.',
});

export const BON_VISITE_SCRIPT = `'use strict';
globalThis.AIMMO_BON_VISITE = function (t) {
  var el = t.el, REFUSALS = ${JSON.stringify(BON_VISITE_REFUSALS)};
  var ID = /^[A-Za-z0-9_-]{1,64}$/;
  function own(k) { return typeof k === 'string' && Object.prototype.hasOwnProperty.call(REFUSALS, k) ? REFUSALS[k] : null; }
  function say(said, res, fallback) {
    if (res.offline) { said.textContent = 'Pas de réseau. Réessayez dans un moment.'; return; }
    said.textContent = own(res.body && res.body.code) || fallback;
  }
  function pad(box) {
    var c = el('canvas', null, 'brouillon'), path = '', down = false, r = null;
    if (c.style) { c.style.width = '100%'; c.style.height = 'auto'; c.style.touchAction = 'none'; }
    c.setAttribute('width', '600'); c.setAttribute('height', '200');
    c.setAttribute('aria-label', 'Zone de tracé de la signature, facultative');
    var g = c.getContext && c.getContext('2d');
    function at(e) { r = c.getBoundingClientRect(); return Math.round((e.clientX - r.left) * 600 / r.width) + ' ' + Math.round((e.clientY - r.top) * 200 / r.height); }
    c.addEventListener('pointerdown', function (e) { down = true; var p = at(e); path += 'M' + p; if (g) { g.beginPath(); g.moveTo.apply(g, p.split(' ').map(Number)); } });
    c.addEventListener('pointermove', function (e) { if (!down || path.length > 150000) return; var p = at(e); path += 'L' + p; if (g) { g.lineTo.apply(g, p.split(' ').map(Number)); g.stroke(); } });
    ['pointerup', 'pointerleave'].forEach(function (k) { c.addEventListener(k, function () { down = false; }); });
    box.appendChild(c);
    box.appendChild(t.button('Effacer le tracé', function () { path = ''; if (g) g.clearRect(0, 0, 600, 200); }));
    return function () { return path || null; };
  }
  function signHere(id, box, said) {
    t.send('/v1/visites/' + encodeURIComponent(id) + '/bon/a-signer', 'GET').then(function (res) {
      if (res.gone) return;
      if (!res.ok || !res.body || !res.body.data || typeof res.body.data.content !== 'string') { say(said, res, 'Le bon ne se lit pas pour le moment.'); return; }
      t.clear(box);
      box.appendChild(el('p', 'Donnez le téléphone au visiteur : il lit son bon, tape le code reçu, et signe du doigt s’il le veut.', 'doux'));
      box.appendChild(el('p', res.body.data.content, 'brouillon'));
      var code = t.field(box, 'bon-code', 'Code reçu par le visiteur');
      code.setAttribute('inputmode', 'numeric');
      code.setAttribute('autocomplete', 'one-time-code');
      code.setAttribute('maxlength', '6');
      var trace = pad(box);
      var busy = false;
      box.appendChild(t.button('Signer le bon', function () {
        if (busy) return;
        busy = true;
        said.textContent = 'Signature…';
        t.send('/v1/visites/' + encodeURIComponent(id) + '/bon/signature-sur-place', 'POST', { code: String(code.value).trim(), drawing: trace() }).then(function (r) {
          busy = false;
          if (r.gone) return;
          if (!r.ok) { say(said, r, 'Le bon n’est pas signé.'); return; }
          code.value = '';
          t.clear(box);
          var d = r.body.data || {};
          said.textContent = 'Bon signé, sans papier. ' + (d.copy === 'remis' ? 'Le visiteur a reçu son exemplaire avec la preuve de sa signature.' : 'L’exemplaire n’a pas pu partir : il est gardé avec la visite.') + ' Signature d’essai tant que le dossier de preuve n’est pas validé.';
        }, function () { busy = false; said.textContent = 'La réponse n’est pas arrivée : relisez la visite avant de recommencer.'; });
      }));
    });
  }
  return function (id, box, said) {
    if (typeof id !== 'string' || !ID.test(id)) return;
    t.clear(box);
    box.appendChild(el('p', 'Le visiteur signe sans papier : ici, sur votre téléphone, ou plus tard par un lien. Il reçoit son exemplaire avec la preuve.', 'doux'));
    var agreed = t.checkbox(box, 'bon-accord', 'Le visiteur accepte de recevoir son code et son exemplaire');
    var bySms = t.checkbox(box, 'bon-sms', 'Par SMS plutôt que par mail');
    bySms.checked = true;
    function open(place) {
      said.textContent = 'Envoi du code…';
      var body = { place: place, channel: bySms.checked ? 'sms' : 'email' };
      if (agreed.checked) body.consentProof = 'Accord du visiteur pour recevoir le code et l’exemplaire de son bon, recueilli par son agent dans l’application.';
      return t.send('/v1/visites/' + encodeURIComponent(id) + '/bon/signature-en-ligne', 'POST', body).then(function (res) {
        if (res.gone) return;
        if (!res.ok) { say(said, res, 'Rien n’est parti.'); return; }
        said.textContent = place === 'sur_place' ? 'Code envoyé au visiteur, valable 10 minutes.' : 'Lien et code envoyés au visiteur : il signe seul, le lien vit 48 heures.';
        if (place === 'sur_place') signHere(id, box, said);
      });
    }
    box.appendChild(t.button('Signer ici, sur mon téléphone', function () { open('sur_place'); }));
    box.appendChild(t.button('Envoyer le lien pour signer à distance', function () { open('distance'); }));
  };
};
`;
