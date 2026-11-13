import { PARTNER_PURPOSES, PURPOSE_LABEL } from '../../core/src/cles/cles.ts';

/**
 * L'armoire des clés d'un bien, dans l'écran « Mettre en vente » (BR51), par les routes de l'armoire (BR21, RC17) :
 * `GET` et `POST /v1/trousseaux/biens/<id>`, `GET /v1/trousseaux/<id>/mouvements`, `POST /v1/trousseaux/<id>/rendu`,
 * `/perdu` et `/rendu-au-proprietaire` [R270, R271].
 *
 * Rien n'est lu avant le geste. Chaque trousseau dit son numéro, son libellé et où il est, dans l'ordre du serveur ;
 * l'écran ne trie ni ne calcule rien. Ranger envoie le seul libellé : le numéro est donné par le code [R270]. Un trousseau
 * perdu ou rendu au propriétaire ne sort plus [R271] : « Perdu » et « Rendu au propriétaire » ne partent qu'au second
 * appui, et tout autre geste annule la demande. Un seul envoi à la fois ; après une écriture, l'armoire est relue ; une
 * écriture sans réponse est dite incertaine. Chaque refus se dit en mots, jamais par un code. Script servi à part
 * (`/app/armoire.js`), chargé au premier geste [R201]. Tout texte reçu est posé en texte.
 *
 * BR52 : un trousseau à l'agence sort vers un agent ou se remet à un partenaire, au geste « Sortir ou remettre » qui lit
 * `GET /v1/trousseaux/<id>/choix`. On choisit d'abord pour quoi, dans la liste fermée [R271]. Visite ou estimation : un
 * rendez-vous prévu du bien, et le trousseau va à l'agent de ce rendez-vous, jusqu'à sa fin (`POST .../sortie`). Sinon :
 * à qui, un agent en activité ou un partenaire admis [R665] (`POST .../partenaire`), puis dans combien d'heures il
 * revient, 10 au plus, dans les 12 heures de la règle.
 */

export const ARMOIRE_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  role: 'L’armoire des clés se tient par l’agent du bien ou la direction.',
  agent_inactive: 'Votre accès n’est plus actif : l’armoire ne s’ouvre pas.',
  pas_son_bien: 'L’armoire de ce bien se tient par son agent ou la direction.',
  network: 'Ce bien n’est pas dans votre réseau.',
  unknown: 'Ce bien ne se trouve pas : rouvrez-le depuis votre journée.',
  bien_retire: 'Ce bien est retiré : aucun trousseau ne s’y range plus.',
  bad_label: 'Le libellé dit ce que le trousseau ouvre, en 2 à 80 caractères, sans chiffre, adresse ni code d’accès.',
  non_range: 'Le trousseau n’a pas pu être rangé. Relisez l’armoire avant de recommencer.',
  invalid_body: 'La demande n’a pas pu être lue. Rechargez l’écran.',
  pas_sorti: 'Ce trousseau est déjà revenu ou déjà noté perdu : l’armoire est relue.',
  pas_responsable: 'Ce trousseau n’est plus sous votre responsabilité : la direction note son retour.',
  encore_sorti: 'Ce trousseau est dehors : notez d’abord son retour à l’agence.',
  deja_retire: 'Ce trousseau a déjà quitté l’armoire : l’armoire est relue.',
  unknown_key: 'Ce trousseau ne se trouve plus : l’armoire est relue.',
  deja_sorti: 'Ce trousseau vient de sortir : l’armoire est relue.',
  bad_purpose: 'Cette raison ne fait pas sortir un trousseau : choisissez-en une de la liste.',
  bad_holder: 'Cet agent n’est plus en activité : choisissez-en un autre.',
  sans_rendez_vous: 'Pour une visite ou une estimation, choisissez un rendez-vous prévu du bien.',
  bad_appointment: 'Ce rendez-vous n’est pas un rendez-vous prévu de ce bien pour cette raison.',
  rendez_vous_passe: 'Ce rendez-vous est passé ou annulé : rouvrez « Sortir ou remettre ».',
  pas_son_rendez_vous: 'Le trousseau va à l’agent qui tient le rendez-vous.',
  bad_due: 'Le retour se dit dans les 12 heures : choisissez une autre heure.',
  unknown_partner: 'Ce partenaire n’est pas dans l’annuaire du réseau.',
  metier_non_admis: 'Ce métier n’entre pas seul dans un bien : diagnostiqueur, photographe, artisan ou géomètre seulement.',
  justificatif_non_valable: 'Un justificatif de ce partenaire n’est pas valide aujourd’hui : il ne reçoit pas de clé.',
  sans_agent_responsable: 'Le bien n’a pas d’agent en activité pour répondre de la clé : la remise attend.',
});

/** Les codes après lesquels l'armoire est relue : l'état a changé ailleurs. */
const REREAD = ['pas_sorti', 'deja_retire', 'encore_sorti', 'unknown_key', 'deja_sorti'];

/** Dans combien d'heures le trousseau revient, sans rendez-vous : 10 au plus, pour rester dans les 12 heures [R271]. */
export const ARMOIRE_HOURS = Object.freeze([1, 2, 3, 4, 6, 8, 10]);

/** Une écriture partie sans réponse : elle a pu être notée, l'armoire relue le dira. */
export const ARMOIRE_UNSURE = 'La réponse n’est pas arrivée : le geste a peut-être été noté. Relisez l’armoire avant de recommencer.';

/** Le second appui demandé avant un retrait : un trousseau perdu ou rendu au propriétaire ne sort plus [R271]. */
export const ARMOIRE_CONFIRM = 'Un trousseau perdu ou rendu au propriétaire ne sort plus jamais de l’armoire. Appuyez une seconde fois pour le noter.';

/** Le script servi à part (`/app/armoire.js`). Il ne lit et n'écrit que sous `/v1/trousseaux` [R16]. */
export const ARMOIRE_SCRIPT = `'use strict';
globalThis.AIMMO_ARMOIRE = function (t) {
  var el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field, date = t.date, hour = t.hour;
  var REFUSALS = ${JSON.stringify(ARMOIRE_REFUSALS)};
  var REREAD = ${JSON.stringify(REREAD)};
  var UNSURE = ${JSON.stringify(ARMOIRE_UNSURE)};
  var CONFIRM = ${JSON.stringify(ARMOIRE_CONFIRM)};
  var PURPOSES = ${JSON.stringify(PURPOSE_LABEL)};
  var FOR_PARTNER = ${JSON.stringify(PARTNER_PURPOSES)};
  var HOURS = ${JSON.stringify(ARMOIRE_HOURS)};
  var OFFLINE = 'Pas de réseau. Réessayez dans un moment.';
  var ID = /^[A-Za-z0-9_-]{1,64}$/;
  /* L'armoire ouverte : sa zone, son bien. Une réponse d'une armoire d'avant ne dessine rien. */
  var zone = null, state = null, list = null, propertyId = null, reading = 0, writing = false, writes = 0, armed = null, armedLabel = '', picking = 0;
  document.addEventListener('click', function (e) { if (armed && (!e || e.target !== armed)) disarm(); }, true);
  function say(m) { if (state) state.textContent = m; }
  function text(v) { return typeof v === 'string' ? v : ''; }
  function when(iso) { var d = date(iso), h = hour(iso); return d ? 'le ' + d + (h ? ' à ' + h : '') : 'à une date non dite'; }
  function number(k) { return typeof k.number === 'number' && isFinite(k.number) ? 'n° ' + k.number : 'sans numéro'; }
  function purpose(p) { return PURPOSES[p] || 'raison non dite'; }
  function disarm() { if (armed) { armed.textContent = armedLabel; armed = null; } }
  function refusal(res, fallback) { return REFUSALS[(res.body || {}).code] || fallback; }
  /* Où est le trousseau, en mots : à l'agence, chez un agent, chez un partenaire, ou sorti de l'armoire pour de bon. */
  function where(k) {
    if (k.state === 'retire') {
      var r = k.retirement || {};
      return r.reason === 'perdu' ? 'Perdu, noté ' + when(r.at) + ' : il ne sort plus.' : 'Rendu au propriétaire ' + when(r.at) + ' : il ne sort plus.';
    }
    if (k.state === 'sorti' && k.partner) {
      var p = k.partner, resp = (p.responsible && text(p.responsible.name)) || 'un agent';
      return 'Remis à ' + (text(p.businessName) || 'un partenaire') + (text(p.tradeLabel) ? ' (' + p.tradeLabel + ')' : '') + ' par ' + resp + ', qui en répond, ' + when(p.since) + ', pour « ' + purpose(p.purpose) + ' ». À rendre au plus tard ' + when(p.dueAt) + '.';
    }
    if (k.state === 'sorti') {
      var h = k.holder || {};
      return 'Chez ' + (text(h.name) || 'un agent') + ' depuis ' + when(h.since) + ', pour « ' + purpose(h.purpose) + ' ». À rendre au plus tard ' + when(h.dueAt) + '.';
    }
    return 'À l’agence, dans l’armoire.';
  }
  /* Un geste qui retire le trousseau pour toujours : il ne part qu'au second appui. */
  function sure(label, go) {
    var b = button(label, function () {
      if (armed !== b) { disarm(); armed = b; armedLabel = label; b.textContent = 'Confirmer : ' + label.charAt(0).toLowerCase() + label.slice(1); say(CONFIRM); return; }
      armed = null;
      b.textContent = label;
      go();
    });
    b.className = 'secondaire';
    return b;
  }
  function plain(label, go) { var b = button(label, function () { disarm(); go(); }); b.className = 'secondaire'; return b; }
  function row(k) {
    var li = el('li');
    li.appendChild(el('p', 'Trousseau ' + number(k) + ' · ' + (text(k.label) || 'sans libellé')));
    li.appendChild(el('p', where(k), k.state === 'retire' ? 'doux' : null));
    if (!ID.test(text(k.id))) return li;
    var moves = el('div');
    li.appendChild(plain('Mouvements', function () { history(k, moves); }));
    if (k.state === 'sorti') {
      li.appendChild(plain('Rendu à l’agence', function () { write(k, 'rendu', 'Trousseau ' + number(k) + ' noté rendu à l’agence.'); }));
      li.appendChild(sure('Perdu', function () { write(k, 'perdu', 'Trousseau ' + number(k) + ' noté perdu : il ne sortira plus.'); }));
    } else if (k.state === 'armoire') {
      var pick = el('div');
      li.appendChild(plain('Sortir ou remettre', function () { return choose(k, pick); }));
      li.appendChild(pick);
      li.appendChild(sure('Rendu au propriétaire', function () { write(k, 'rendu-au-proprietaire', 'Trousseau ' + number(k) + ' noté rendu au propriétaire : il ne sortira plus.'); }));
    }
    li.appendChild(moves);
    return li;
  }
  function render(keys) {
    clear(list);
    if (!keys.length) { say('Aucun trousseau rangé pour ce bien.'); return; }
    var ul = el('ul', null, 'liste');
    keys.forEach(function (k) { if (k && typeof k === 'object') ul.appendChild(row(k)); });
    list.appendChild(ul);
    var out = keys.filter(function (k) { return k && k.state === 'sorti'; }).length;
    say(keys.length + (keys.length > 1 ? ' trousseaux' : ' trousseau') + (out ? ', dont ' + out + ' dehors.' : ', tous à l’agence ou retirés.'));
  }
  /* Seule la dernière lecture dessine. */
  function read(said) {
    if (writing || !zone) return Promise.resolve(false);
    disarm();
    var turn = ++reading;
    clear(list);
    say('Chargement…');
    return send('/v1/trousseaux/biens/' + encodeURIComponent(propertyId), 'GET').then(function (res) {
      if (turn !== reading) return false;
      if (res.gone) { clear(list); say(''); return false; }
      if (res.offline || !res.body || res.status >= 500) { say(OFFLINE); return false; }
      if (!res.ok || !Array.isArray(res.body.data)) { say(refusal(res, 'L’armoire ne se lit pas pour le moment.')); return false; }
      render(res.body.data);
      if (said) say(said + ' ' + state.textContent);
      return true;
    }, function () { if (turn === reading) say(OFFLINE); return false; });
  }
  /* Un seul envoi à la fois : un second geste pendant l'envoi ne part pas. */
  function post(path, body, done) {
    if (writing) return Promise.resolve(false);
    writing = true;
    var gen = writes, turn = ++reading;
    say('Envoi…');
    return send(path, 'POST', body).then(function (res) {
      if (gen !== writes) return false;
      writing = false;
      if (turn !== reading) return false;
      /* Sans réponse : le geste a pu être noté, les gestes d'avant sont retirés. */
      if (res.gone || res.offline || !res.body || res.status >= 500) { clear(list); say(UNSURE); return false; }
      if (!res.ok) {
        var code = (res.body || {}).code, said = refusal(res, 'Le geste n’a pas pu être noté. Réessayez dans un moment.');
        if (REREAD.indexOf(code) >= 0) return read(said);
        say(said);
        return false;
      }
      return read(done(res.body));
    }, function () { if (gen !== writes) return false; writing = false; if (turn === reading) { clear(list); say(UNSURE); } return false; });
  }
  function write(k, gesture, done) {
    return post('/v1/trousseaux/' + encodeURIComponent(k.id) + '/' + gesture, undefined, function () { return done; });
  }
  /* BR52 · Qui peut recevoir le trousseau, lu au geste ; seule la dernière lecture dessine. */
  function choose(k, box) {
    var mine = zone, turn = ++picking;
    clear(box);
    box.appendChild(el('p', 'Chargement…', 'doux'));
    return send('/v1/trousseaux/' + encodeURIComponent(k.id) + '/choix', 'GET').then(function (res) {
      if (mine !== zone || turn !== picking) return false;
      clear(box);
      if (res.gone) return false;
      if (res.offline || !res.body || res.status >= 500) { box.appendChild(el('p', OFFLINE, 'alerte')); return false; }
      var c = res.body.data;
      if (!res.ok || !c || typeof c !== 'object') {
        var said = refusal(res, 'Les choix ne se lisent pas pour le moment.');
        if (REREAD.indexOf((res.body || {}).code) >= 0) return read(said);
        box.appendChild(el('p', said, 'alerte'));
        return false;
      }
      reasons(k, box, objects(c.agents), objects(c.appointments), objects(c.partners));
      return true;
    }, function () { if (mine === zone && turn === picking) { clear(box); box.appendChild(el('p', OFFLINE, 'alerte')); } return false; });
  }
  function objects(v) { return Array.isArray(v) ? v.filter(function (x) { return x && typeof x === 'object'; }) : []; }
  function step(box, question) {
    clear(box);
    box.appendChild(el('p', question));
    var g = el('div');
    box.appendChild(g);
    return g;
  }
  function cancel(box) { box.appendChild(plain('Annuler', function () { clear(box); })); }
  /* Pour quoi : la liste fermée, dans l'ordre de la règle [R271]. */
  function reasons(k, box, agents, rdvs, partners) {
    var g = step(box, 'Trousseau ' + number(k) + ' : pour quoi sort-il ?');
    Object.keys(PURPOSES).forEach(function (p) {
      g.appendChild(plain(PURPOSES[p], function () {
        if (p === 'visite' || p === 'estimation') return meetings(k, box, p, rdvs.filter(function (r) { return r.kind === p; }));
        holders(k, box, p, agents, FOR_PARTNER.indexOf(p) >= 0 ? partners : []);
      }));
    });
    cancel(box);
  }
  /* Visite ou estimation : un rendez-vous prévu du bien ; le trousseau va à l'agent qui le tient, jusqu'à sa fin. */
  function meetings(k, box, p, rdvs) {
    var g = step(box, PURPOSES[p] + ' : pour quel rendez-vous du bien ?');
    if (!rdvs.length) g.appendChild(el('p', 'Aucun rendez-vous prévu de ce bien pour « ' + PURPOSES[p] + ' » : prenez-le d’abord, la clé suivra.', 'doux'));
    rdvs.forEach(function (r) {
      if (!ID.test(text(r.appointmentId)) || !ID.test(text(r.agentId))) return;
      var who = text(r.name) || 'un agent';
      g.appendChild(plain(when(r.startAt) + ', avec ' + who, function () {
        return post('/v1/trousseaux/' + encodeURIComponent(k.id) + '/sortie', { holderAgentId: r.agentId, purpose: p, appointmentId: r.appointmentId }, function (b) {
          return 'Trousseau ' + number(k) + ' sorti pour ' + who + ', à rendre au plus tard ' + when(b && b.dueAt) + '.';
        });
      }));
    });
    cancel(box);
  }
  /* Sans rendez-vous : à qui, un agent en activité ou un partenaire admis [R665]. */
  function holders(k, box, p, agents, partners) {
    var g = step(box, PURPOSES[p] + ' : à qui va le trousseau ?');
    agents.forEach(function (a) {
      if (!ID.test(text(a.agentId))) return;
      var who = text(a.name) || 'un agent';
      g.appendChild(plain(who, function () { hours(k, box, p, who, '/sortie', { holderAgentId: a.agentId, purpose: p }); }));
    });
    partners.forEach(function (x) {
      if (!ID.test(text(x.partnerId))) return;
      var who = (text(x.businessName) || 'un partenaire') + (text(x.tradeLabel) ? ' (' + x.tradeLabel + ')' : '');
      g.appendChild(plain(who, function () { hours(k, box, p, who, '/partenaire', { partnerId: x.partnerId, purpose: p }); }));
    });
    if (!agents.length && !partners.length) g.appendChild(el('p', 'Personne ne peut le recevoir pour le moment.', 'doux'));
    cancel(box);
  }
  /* Le retour, dans les 12 heures de la règle ; l'heure part au geste. */
  function hours(k, box, p, who, path, body) {
    var g = step(box, PURPOSES[p] + ', pour ' + who + ' : de retour dans combien d’heures ?');
    HOURS.forEach(function (h) {
      g.appendChild(plain(h + ' h', function () {
        body.dueAt = new Date(Date.now() + h * 3600000).toISOString();
        return post('/v1/trousseaux/' + encodeURIComponent(k.id) + path, body, function (b) {
          return 'Trousseau ' + number(k) + ' ' + (path === '/partenaire' ? 'remis à ' : 'sorti pour ') + who + ', à rendre au plus tard ' + when(b && b.dueAt) + '.';
        });
      }));
    });
    cancel(box);
  }
  /* Les mouvements, du plus ancien au plus récent, dans l'ordre du serveur. */
  function history(k, box) {
    var mine = zone;
    clear(box);
    box.appendChild(el('p', 'Chargement…', 'doux'));
    return send('/v1/trousseaux/' + encodeURIComponent(k.id) + '/mouvements', 'GET').then(function (res) {
      if (mine !== zone) return false;
      clear(box);
      if (res.gone) return false;
      if (res.offline || !res.body || res.status >= 500) { box.appendChild(el('p', OFFLINE, 'alerte')); return false; }
      if (!res.ok || !Array.isArray(res.body.data)) { box.appendChild(el('p', refusal(res, 'Les mouvements ne se lisent pas pour le moment.'), 'alerte')); return false; }
      if (!res.body.data.length) { box.appendChild(el('p', 'Jamais sorti de l’armoire.', 'doux')); return true; }
      var ol = el('ol', null, 'liste');
      res.body.data.forEach(function (m) {
        if (!m || typeof m !== 'object') return;
        var by = (m.holder && text(m.holder.name)) || 'un agent';
        var who = m.partner ? 'Remis à ' + (text(m.partner.businessName) || 'un partenaire') + ' par ' + by : 'Sorti par ' + by;
        var back = !m.returned ? 'pas encore revenu, à rendre au plus tard ' + when(m.dueAt) : m.returned.outcome === 'perdu' ? 'noté perdu ' + when(m.returned.at) : 'revenu ' + when(m.returned.at);
        ol.appendChild(el('li', who + ' ' + when(m.outAt) + ', pour « ' + purpose(m.purpose) + ' » : ' + back + '.'));
      });
      box.appendChild(ol);
      return true;
    }, function () { if (mine === zone) { clear(box); box.appendChild(el('p', OFFLINE, 'alerte')); } return false; });
  }
  /* Ouvrir l'armoire d'un bien dans sa zone : tout ce qui venait d'une armoire d'avant est oublié. */
  function open(box, id) {
    if (!ID.test(text(id))) return Promise.resolve(false);
    reading += 1; writes += 1; writing = false; armed = null;
    zone = box; propertyId = id;
    clear(box);
    state = el('p', null, 'etat');
    state.setAttribute('role', 'status');
    list = el('div');
    var form = el('div');
    var label = field(form, 'armoire-libelle', 'Ranger un trousseau : ce qu’il ouvre, sans chiffre, adresse ni code');
    label.setAttribute('maxlength', '80');
    form.appendChild(plain('Ranger dans l’armoire', function () {
      var v = label.value.trim();
      if (v.length < 2) { say(REFUSALS.bad_label); return; }
      return post('/v1/trousseaux/biens/' + encodeURIComponent(propertyId), { label: v }, function (b) {
        label.value = '';
        var n = b && typeof b.number === 'number' ? ' sous le n° ' + b.number : '';
        return 'Trousseau rangé' + n + '.';
      });
    }));
    box.appendChild(state);
    /* Toujours là : après un échec ou une réponse perdue, on relit sans rien écrire ni quitter l'écran. */
    box.appendChild(plain('Relire l’armoire', function () { return read(''); }));
    box.appendChild(list);
    box.appendChild(form);
    return read('');
  }
  return { open: open, read: function () { return read(''); } };
};
`;
