/**
 * BR101 · La création à la voix, à l'écran « Ma journée » (HX06, BR100). Le bloc « Dicter un contact, un bien ou un
 * rendez-vous » se charge au geste, dans son script servi à part (`/app/dictee.js`) [R201] : rien n'est lu avant.
 *
 * L'agent dicte avec le micro du clavier de son téléphone, puis l'écran lit la dictée par le socle : chaque champ
 * proposé est montré avec la phrase exacte qui le porte, coché ; l'agent décoche ce qu'il ne garde pas, et valide d'un
 * geste [R260, R261]. Un champ dit deux fois avec deux valeurs n'est pas proposé, et l'écran le dit. L'identifiant de
 * la demande est tiré une fois par dictée : la même dictée revalidée ne double rien. Au créneau pris entre-temps,
 * l'écran dit ce qui est déjà rangé et les créneaux libres. Tout texte reçu est posé en texte, chaque refus dit en mots.
 * La dictée reste à l'écran tant que l'agent ne l'a pas validée : un réseau coupé ne la perd pas.
 */

/** Les deux seules routes que le script appelle. */
export const DICTEE_ROUTES = Object.freeze({ read: '/v1/dictee/lecture', validate: '/v1/dictee/validation' });

export const DICTEE_TARGETS = Object.freeze({ contact: 'Le contact', bien: 'Le bien', rendezvous: 'Le rendez-vous' });

export const DICTEE_LABELS = Object.freeze({
  contact: Object.freeze({ firstName: 'Prénom', lastName: 'Nom', phone: 'Téléphone', email: 'Mail', project: 'Projet' }),
  bien: Object.freeze({ kind: 'Sorte de bien', postalCode: 'Code postal', city: 'Commune', surfaceM2: 'Surface', rooms: 'Pièces', priceEur: 'Prix demandé' }),
  rendezvous: Object.freeze({ appointmentKind: 'Sorte de rendez-vous', start: 'Jour et heure' }),
});

export const DICTEE_VALUES = Object.freeze({
  project: Object.freeze({ sell: 'vendre', buy: 'acheter' }),
  kind: Object.freeze({ home: 'logement', land: 'terrain', building: 'immeuble', commercial: 'local commercial', business_walls: 'murs commerciaux', business: 'fonds de commerce' }),
  appointmentKind: Object.freeze({ estimation: 'estimation', visite: 'visite', signature: 'signature', appel: 'appel' }),
});

/** Chaque refus dit en mots ; un refus inconnu a sa phrase à lui, jamais un code. */
export const DICTEE_REFUSALS = Object.freeze({
  role: 'Seul un agent dicte, pour lui-même.',
  unknown_agent: 'Votre compte n’est plus en activité : rien n’est rangé.',
  bad_dictation: 'La dictée est vide ou trop longue (5 000 caractères au plus).',
  invalid_dictation: 'La dictée est vide ou trop longue (5 000 caractères au plus).',
  not_dictated: 'Un champ gardé n’est plus dans la dictée : relisez-la avant de valider.',
  nothing_kept: 'Aucun champ n’est coché : rien à ranger.',
  contact_without_identity: 'Le projet seul ne fait pas un contact : gardez au moins un nom, un téléphone ou un mail.',
  incomplete_property: 'Le bien demande sa sorte, son code postal, sa commune et sa surface.',
  property_without_owner: 'Un bien se range avec son propriétaire : gardez le contact.',
  property_of_buyer: 'Le contact veut acheter : le bien ne se range pas à son nom.',
  incomplete_appointment: 'Le rendez-vous demande sa sorte, son jour et son heure.',
  appointment_without_person: 'Un rendez-vous se range avec une personne : gardez le contact.',
  visit_needs_listing: 'Une visite se prend à l’écran des visites, avec son bon de visite.',
  ambiguous_contact: 'Le téléphone et le mail dictés sont dans deux fiches différentes : rien n’est rangé, ouvrez les fiches pour trancher.',
  not_assigned: 'Ce contact est déjà suivi par un autre agent : rien n’est rangé.',
  slot_not_free: 'Ce créneau n’est plus libre dans votre agenda.',
  slot_taken_meanwhile: 'Le créneau a été pris pendant la validation.',
  stale_reading: 'La lecture a plus de 12 heures : lisez la dictée de nouveau.',
});

export const DICTEE_OFFLINE = 'Pas de réseau. Votre dictée reste ici : réessayez dans un moment.';
export const DICTEE_FAILED = 'La dictée ne se lit pas pour le moment. Elle reste ici : réessayez plus tard.';
export const DICTEE_OTHER = 'La validation n’est pas passée. Votre dictée reste ici : réessayez plus tard.';
export const DICTEE_DONE = 'Rangé. Aucun message n’est parti au contact.';

/** Le bouton du bloc de « Ma journée », posé par le chargeur commun (BR69) dans `fichiers.ts` : le moins possible [R201]. */
export const DICTEE_LABEL = 'Dicter un contact, un bien ou un rendez-vous';

/** Le script servi à part. Il n'appelle que les deux routes de la dictée [R16]. */
export const DICTEE_SCRIPT = `'use strict';
globalThis.AIMMO_DICTEE = function (t) {
  var el = t.el, clear = t.clear, send = t.send;
  var TARGETS = ${JSON.stringify(DICTEE_TARGETS)}, LABELS = ${JSON.stringify(DICTEE_LABELS)}, VALUES = ${JSON.stringify(DICTEE_VALUES)};
  var REFUSALS = ${JSON.stringify(DICTEE_REFUSALS)};
  var READ = ${JSON.stringify(DICTEE_ROUTES.read)}, VALIDATE = ${JSON.stringify(DICTEE_ROUTES.validate)};
  var turn = 0, n = 0;
  function own(map, k) { return map && typeof k === 'string' && Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; }
  function str(v, max) { return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null; }
  function int(v) { return typeof v === 'number' && isFinite(v) && v >= 0 && Math.floor(v) === v ? v : null; }
  function instant(v) { return str(v, 40) && !isNaN(Date.parse(v)) ? v : null; }
  function euros(v) { try { return v.toLocaleString('fr-FR') + '\\u00a0€'; } catch (e) { return String(v) + '\\u00a0€'; } }
  function when(iso) { var d = new Date(iso); try { return d.toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long' }) + ' à ' + t.hour(iso); } catch (e) { return t.date(iso) + ' à ' + t.hour(iso); } }
  function shown(f) {
    var v = f.value;
    if (f.key === 'project' || f.key === 'kind' || f.key === 'appointmentKind') return own(VALUES[f.key], v);
    if (f.key === 'start') return instant(v) ? when(v) : null;
    if (f.key === 'surfaceM2') return int(v) !== null ? v + '\\u00a0m²' : null;
    if (f.key === 'priceEur') return int(v) !== null ? euros(v) : null;
    if (f.key === 'rooms') return int(v) !== null ? String(v) : null;
    return str(v, 200);
  }
  function labelOf(key) { var parts = String(key).split('.'); return own(own(LABELS, parts[0]), parts[1]); }
  function keysSaid(keys) {
    var words = (Array.isArray(keys) ? keys : []).map(labelOf).filter(Boolean);
    return words.length ? ' (' + words.join(', ') + ')' : '';
  }
  function refusal(b) {
    var code = b && typeof b.code === 'string' ? b.code : '';
    var said = own(REFUSALS, code);
    if (!said && /^report_/.test(code)) said = 'Le compte rendu porte ce que la dictée ne dit pas : corrigez-le à l’écran de la visite.';
    if (!said) return null;
    return said + (code === 'not_dictated' || code === 'incomplete_property' || code === 'incomplete_appointment' ? keysSaid(b.keys) : '');
  }
  function kept(box, k) {
    if (!k || typeof k !== 'object') return;
    var parts = [];
    if (k.contact === 'created') parts.push('la fiche du contact, créée');
    else if (k.contact === 'matched') parts.push('le contact, retrouvé dans sa fiche');
    if (str(k.propertyId, 64)) parts.push('le bien');
    if (parts.length) box.appendChild(el('p', 'Déjà rangé, sans rien doubler : ' + parts.join(' et ') + '. Le rendez-vous n’est pas pris : fixez une autre heure avec le contact, puis dictez son numéro ou son mail avec le nouveau rendez-vous, sans le bien ; le rendez-vous rejoindra sa fiche.'));
  }
  function free(box, slots) {
    var list = (Array.isArray(slots) ? slots : []).filter(instant).slice(0, 3);
    if (!list.length) { box.appendChild(el('p', 'Aucun créneau libre de la même sorte dans les 24 heures autour.', 'doux')); return; }
    box.appendChild(el('p', 'Créneaux libres les plus proches :'));
    var ul = el('ul', null, 'liste');
    list.forEach(function (s) { ul.appendChild(el('li', when(s))); });
    box.appendChild(ul);
  }
  var built = null;
  return function (_personId, corps, said) {
    // Le bouton touché de nouveau ne refait pas l'écran : la dictée en cours reste [R261].
    if (built && built.corps === corps && built.session === t.session()) return true;
    var mine = t.session(), at = ++turn;
    built = { corps: corps, session: mine };
    var current = null, lastText = null, requestId = null, reading = 0;
    clear(corps);
    said.textContent = '';
    corps.appendChild(el('p', 'Touchez le micro du clavier de votre téléphone et dites ce que vous venez d’apprendre : rien n’est rangé avant votre validation.', 'doux'));
    var text = t.field(corps, 'dictee-texte-' + (++n), 'Votre dictée', 'textarea');
    text.setAttribute('maxlength', '5000');
    var result = el('div');
    var answer = el('p', null, 'etat');
    answer.setAttribute('role', 'status');
    function live() { return mine === t.session() && at === turn; }
    // Un geste à la fois : une lecture ou une validation en cours ne laisse partir rien d'autre, et chaque réponse ne vaut
    // que pour la dictée qu'elle lit, avec l'identifiant tiré pour elle [R261].
    var busy = false;
    function wait() { answer.textContent = 'Une demande est en cours : attendez sa réponse.'; }
    function draw(data) {
      clear(result);
      answer.textContent = '';
      var draft = data && data.draft;
      var sentences = draft && Array.isArray(draft.sentences) ? draft.sentences : [];
      var fields = draft && Array.isArray(draft.fields) ? draft.fields : [];
      var checks = [];
      Object.keys(TARGETS).forEach(function (target) {
        var mineFields = fields.filter(function (f) { return f && f.target === target && own(LABELS[target], f.key) && shown(f) !== null; });
        if (!mineFields.length) return;
        var box = el('fieldset', null, 'bloc');
        box.appendChild(el('legend', TARGETS[target]));
        mineFields.forEach(function (f) {
          var c = t.checkbox(box, 'dictee-' + n + '-' + target + '-' + f.key, LABELS[target][f.key] + ' : ' + shown(f));
          c.checked = true;
          checks.push({ box: c, target: target, key: f.key });
          var quote = str(f.quote, 5000), phrase = int(f.sentence) !== null ? str(sentences[f.sentence], 5000) : null;
          if (quote) box.appendChild(el('p', 'Dit : « ' + quote + ' »' + (phrase && phrase !== quote ? ', dans « ' + phrase + ' »' : ''), 'doux'));
        });
        result.appendChild(box);
      });
      var conflicts = draft && Array.isArray(draft.conflicts) ? draft.conflicts : [];
      var twice = conflicts.map(function (c) { return c && own(own(LABELS, c.target), c.key); }).filter(Boolean);
      if (twice.length) result.appendChild(el('p', 'Dit deux fois avec deux valeurs, donc non proposé : ' + twice.join(', ') + '. Saisissez-le vous-même ensuite.'));
      if (!checks.length) { result.appendChild(el('p', 'Rien à proposer dans cette dictée : dites un nom, un numéro, le bien ou le rendez-vous.')); return; }
      result.appendChild(t.button('Valider ce qui est coché', function () {
        var keep = {};
        checks.forEach(function (c) { if (c.box.checked) (keep[c.target] = keep[c.target] || []).push(c.key); });
        if (!Object.keys(keep).length) { answer.textContent = REFUSALS.nothing_kept; return; }
        if (busy) return wait();
        var sent = current;
        if (!sent || sent.reading !== reading) return;
        busy = true;
        answer.textContent = 'Validation…';
        send(VALIDATE, 'POST', { requestId: sent.id, dictation: sent.text, readAt: sent.readAt, keep: keep }).then(function (x) {
          busy = false;
          if (x.gone || !live() || current !== sent) return;
          if (x.offline) { answer.textContent = ${JSON.stringify(DICTEE_OFFLINE)}; return; }
          if (!x.ok) {
            answer.textContent = refusal(x.body) || ${JSON.stringify(DICTEE_OTHER)};
            var b = x.body || {};
            if (b.code === 'slot_not_free' || b.code === 'slot_taken_meanwhile') { kept(result, b.kept); if (b.code === 'slot_taken_meanwhile') free(result, b.freeSlots); }
            return;
          }
          var d = x.body.data || {};
          var parts = [];
          if (d.contact === 'created') parts.push('la fiche du contact, créée');
          else if (d.contact === 'matched') parts.push('le contact, ajouté à sa fiche');
          if (str(d.propertyId, 64)) parts.push('le bien, en brouillon');
          if (str(d.appointmentId, 64)) parts.push('le rendez-vous');
          clear(result);
          answer.textContent = parts.length ? 'Rangé : ' + parts.join(', ') + '. Aucun message n’est parti au contact.' : ${JSON.stringify(DICTEE_DONE)};
          current = null;
          // Une dictée changée depuis l'envoi reste à l'écran, avec son propre identifiant à venir.
          if (text.value === sent.text) text.value = '';
          if (lastText === sent.text) { lastText = null; requestId = null; }
        });
      }));
    }
    corps.appendChild(t.button('Lire la dictée', function () {
      var value = typeof text.value === 'string' ? text.value : '';
      if (!value.trim()) { answer.textContent = 'Dictez ou écrivez d’abord ce que vous voulez ranger.'; return; }
      if (value.length > 5000) { answer.textContent = REFUSALS.bad_dictation; return; }
      if (busy) return wait();
      // Une seule demande par dictée : relue sans changement, elle garde son identifiant et rien ne double.
      if (value !== lastText) { requestId = globalThis.crypto.randomUUID(); lastText = value; }
      var id = requestId, mineReading = ++reading;
      busy = true;
      current = null;
      clear(result);
      answer.textContent = 'Lecture…';
      send(READ, 'POST', { dictation: value }).then(function (x) {
        busy = false;
        if (x.gone || !live() || mineReading !== reading) return;
        if (x.offline) { answer.textContent = ${JSON.stringify(DICTEE_OFFLINE)}; return; }
        if (!x.ok || !x.body.data || !instant(x.body.data.readAt)) { answer.textContent = refusal(x.body) || ${JSON.stringify(DICTEE_FAILED)}; return; }
        current = { text: value, readAt: x.body.data.readAt, id: id, reading: mineReading };
        draw(x.body.data);
      });
    }));
    corps.appendChild(answer);
    corps.appendChild(result);
    return true;
  };
};
`;
