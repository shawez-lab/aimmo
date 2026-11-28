import { CERTIFIED_DOMAINS, PARTNER_TRADES } from '../../core/src/partenaires/annuaire.ts';
import { STUDIO_OPTIONS } from '../../core/src/studio/options.ts';
import { SORT_LABELS } from '../src/partenaires-sortes.ts';

/**
 * L'écran « Partenaires » de l'application de l'agent (M18, U11), en deux morceaux : son chargeur, posé dans le script
 * de l'application, et son script servi à part (`/app/partenaires.js`), chargé à la première ouverture [R201]. L'écran
 * sert de temps en temps ; son dessin pesait quatre kilo-octets compressés dans le script que chaque agent reçoit à
 * chaque mise à jour (DS068).
 *
 * Rien ne change à l'écran ni à ses règles : l'ordre du tirage tel que rangé, jamais retrié ni noté [R75, R14] ;
 * l'accord du client avant toute mise en relation [R74, R76] ; un seul geste à la fois ; une réponse perdue n'est dite
 * ni faite ni pas faite [R10]. Tout texte reçu est posé avec `textContent`.
 */

/** Les métiers et domaines de M18, tels que l'écran les nomme (U11). */
const TRADE_NAMES = PARTNER_TRADES.map((t) => ({ trade: t.trade, label: t.label }));
const DOMAIN_NAMES: Record<string, string> = { ...Object.fromEntries(CERTIFIED_DOMAINS.map((d) => [d.domain, d.label])), mesurage: 'mesurage de la surface' };

/** Le chargeur posé dans le script de l'application : il ouvre l'écran sur une session neuve, puis laisse dessiner. */
export const PARTENAIRES_JS = `
  /* ---------- M18 : l'écran « Partenaires » (U11), servi à part et chargé au premier geste [R201]. ---------- */
  function wipePartenaires() {
    clear($('partenaires-corps'));
    $('partenaires-etat').textContent = '';
  }
  function openPartenaires(message, page) {
    if (!currentKey) return Promise.resolve(false);
    session += 1;
    wipePartenaires();
    show('partenaires');
    return withTool('partenaires', 'AIMMO_PARTENAIRES', 'partenaires-etat', 'partenaires', function (p) { return p.open(message, page); }, function () { return { $: $, el: el, clear: clear, send: send, button: button, field: field, line: line, date: date, hour: hour, projects: PROJECTS, open: openPartenaires, session: function () { return session; } }; });
  }
`;

/** Le script servi à part (`/app/partenaires.js`). */
export const PARTENAIRES_SCRIPT = `'use strict';
globalThis.AIMMO_PARTENAIRES = function (t) {
  var $ = t.$, el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field, line = t.line, date = t.date, hour = t.hour;
  var ID = /^[A-Za-z0-9_-]{1,64}$/;
  var TRADES = ${JSON.stringify(TRADE_NAMES)};
  var DOMAINS = ${JSON.stringify(DOMAIN_NAMES)};
  var STUDIO_OPTIONS = ${JSON.stringify(STUDIO_OPTIONS)};
  var SORTS = ${JSON.stringify(SORT_LABELS)};
  var REFERRAL_STATES = { proposee: 'Proposée au client : à lui de choisir', accord_client: 'Le client a choisi : à confier', confiee: 'Confiée : en attente de sa réponse', en_cours: 'En cours chez le professionnel', terminee: 'Terminée', abandonnee: 'Abandonnée' };
  var CONSENT_CHANNELS = { oral: 'De vive voix', ecrit: 'Par écrit', mail: 'Par mail', sms: 'Par SMS', whatsapp: 'Par WhatsApp' };
  var CONSENT_HOW = { oral: 'de vive voix', ecrit: 'par écrit', mail: 'par mail', sms: 'par SMS', whatsapp: 'par WhatsApp' };
  var DESTINATIONS = { property: 'rangée dans le bien', sale_file: 'rangée dans le dossier de vente', financing: 'rangée au financement', referral: 'gardée avec la demande', agent_queue: 'à ranger par vous' };
  var PARTNER_REFUSALS = {
    no_partner: 'Aucun professionnel de ce métier n’est disponible dans cette zone aujourd’hui.',
    partner_unavailable: 'Professionnel indisponible : un justificatif a expiré. Proposez de nouveau.',
    fees_not_disclosed: 'Montrez d’abord au client le texte des rémunérations, puis notez son accord.',
    not_shown: 'Le client choisit parmi les professionnels tirés au sort, et seulement eux.',
    bad_postcode: 'Indiquez le code postal du lieu, en 5 chiffres.',
    domain_required: 'Choisissez le diagnostic demandé.',
    bad_property: 'Ce bien n’est pas celui du projet.',
    bad_state: 'Cette demande a déjà changé : l’écran est relu.',
    no_consent: 'Notez d’abord l’accord du client.',
    bad_note: 'Notez ce que le client a dit, en 10 à 1 000 caractères.',
    bad_channel: 'Dites comment le client a donné son accord.',
    bad_consent_date: 'L’heure de l’accord n’est pas valable : notez-le de nouveau.',
    not_stored: 'La preuve de l’accord n’est pas rangée : notez-le de nouveau.',
    storage_unavailable: 'Le rangement des preuves n’est pas encore ouvert : rien n’est enregistré.',
    text_refused: 'Le texte des rémunérations n’a pas passé le contrôle : prévenez la direction.',
  };
  function partnerRefusal(body, fallback) { return (body && PARTNER_REFUSALS[body.code]) || fallback; }
  function tradeName(t) {
    for (var i = 0; i < TRADES.length; i++) if (TRADES[i].trade === t) return TRADES[i].label;
    return 'Professionnel';
  }
  function duration(minutes) {
    var m = Math.max(0, Math.round(Number(minutes) || 0));
    if (m < 60) return m + ' min';
    if (m < 1440) return Math.round(m / 60) + ' h';
    return Math.round(m / 1440) + ' j';
  }
  // Les identifiants des champs de cet écran ont leurs propres préfixes : son compteur est à lui.
  var formSeq = 0;
  function partenairesState(text) { $('partenaires-etat').textContent = text; }
  var partenairesPage = 0;
  // La coquille a déjà ouvert l'écran, vidé : ici, la lecture et le dessin.
  function open(message, page) {
    if (typeof page === 'number') partenairesPage = page;
    partenairesState('Chargement…');
    return send('/v1/partenaires/projets' + (partenairesPage ? '?page=' + partenairesPage : ''), 'GET').then(function (res) {
      if (res.gone) return false;
      if (!res.ok) { partenairesState(res.offline ? 'Pas de réseau. Réessayez dans un moment.' : res.status === 403 ? 'Ces demandes ne sont pas dans vos droits.' : 'Indisponible pour le moment. Réessayez plus tard.'); return false; }
      var d = res.body.data || {};
      renderPartenaires(Array.isArray(d.projects) ? d.projects : [], partenairesPage, d.more === true);
      partenairesState(message || '');
      return true;
    });
  }
  // Un geste : la réponse est dite, puis l'écran relu pour montrer l'état rangé.
  // Un geste passé puis une réponse perdue : le refaire tirerait au sort une seconde fois, ou confierait deux fois. L'écran
  // ne dit ni fait ni pas fait [R10] ; un seul geste à la fois, le verrou vaut pour sa session [R74].
  var partActing = null;
  var PART_LOST = 'La réponse n’est pas arrivée : rien n’est sûr. Rouvrez les projets avant de recommencer.';
  function partTake() {
    var mine = t.session();
    if (partActing === mine) { partenairesState('Un autre geste est en cours : attendez sa réponse, puis recommencez.'); return null; }
    partActing = mine;
    return function () { if (partActing === mine) partActing = null; };
  }
  // Un stockage fermé est un refus sûr, sans écriture : il est dit, ce n'est pas une réponse perdue.
  function partLost(res) { return res.offline || !res.body || (res.status >= 500 && res.body.code !== 'storage_unavailable'); }
  function partRefused(res, fallback) {
    partenairesState(partnerRefusal(res.body, fallback));
    if (res.body.code === 'bad_state') return t.open(partnerRefusal(res.body, fallback));
    return false;
  }
  function partWrite(path, body, fallback, done, free) {
    partenairesState('Envoi…');
    return send(path, 'POST', body).then(function (res) {
      free();
      if (res.gone) return false;
      if (partLost(res)) { partenairesState(PART_LOST); return false; }
      if (!res.ok) return partRefused(res, fallback);
      return t.open(done);
    }, function () { free(); return false; });
  }
  function partAct(path, body, fallback, done) {
    var free = partTake();
    return free ? partWrite(path, body, fallback, done, free) : Promise.resolve(false);
  }
  function renderPartenaires(projects, page, more) {
    var body = $('partenaires-corps');
    clear(body);
    if (!projects.length && !page) { body.appendChild(el('p', 'Aucun projet suivi pour le moment.', 'doux')); return; }
    // Les projets dans leur ordre de création, par pages : aucun n'est jamais perdu au-delà de la première.
    if (page) body.appendChild(button('Projets précédents', function () { t.open('', page - 1); }));
    projects.forEach(function (p) {
      if (!ID.test(p.projectId)) return;
      var box = el('section', null, 'vente');
      box.appendChild(el('h3', (t.projects[p.kind] || 'Projet') + (p.firstName ? ' · ' + p.firstName : '')));
      (p.properties || []).forEach(function (b) { box.appendChild(el('p', 'Bien ' + b.reference + (b.city ? ', ' + b.city : ''), 'doux')); });
      (p.referrals || []).forEach(function (r) { box.appendChild(referralBlock(r)); });
      box.appendChild(proposeForm(p));
      body.appendChild(box);
    });
    if (more) body.appendChild(button('Projets suivants', function () { t.open('', page + 1); }));
  }
  function referralBlock(r) {
    var box = el('div', null, 'client');
    box.appendChild(el('h4', tradeName(r.trade) + (r.domain ? ' · ' + (DOMAINS[r.domain] || 'diagnostic') : '')));
    box.appendChild(el('p', REFERRAL_STATES[r.state] || 'État inconnu', r.state === 'terminee' ? 'fait' : null));
    var chosen = null;
    var ol = el('ol', null, 'tirage');
    (r.shown || []).forEach(function (s) {
      var li = el('li', s.businessName);
      if (s.partnerId === r.chosenPartnerId) { chosen = s; li.appendChild(el('span', ' · choisi par le client', 'fait')); }
      ol.appendChild(li);
    });
    box.appendChild(el('p', 'Tirés au sort le ' + date(r.createdAt) + ', dans cet ordre :', 'doux'));
    box.appendChild(ol);
    if (r.consent) box.appendChild(el('p', 'Accord du client ' + (CONSENT_HOW[r.consent.channel] || 'donné') + ', le ' + date(r.consent.at) + ' à ' + hour(r.consent.at) + '.', 'doux'));
    if (!ID.test(r.referralId)) return box;
    var base = '/v1/partenaires/relations/' + encodeURIComponent(r.referralId);
    if (r.state === 'proposee') consentForm(box, r, base);
    if (r.state === 'accord_client' && chosen) {
      var name = chosen.businessName;
      box.appendChild(button('Confier la demande à ' + name, function () { partAct(base + '/confier', undefined, 'La demande n’est pas confiée.', 'Demande confiée à ' + name + '.'); }));
    }
    // Le suivi reste lisible une fois la demande close : les pièces déposées ne disparaissent jamais de l'écran.
    if (r.state === 'confiee' || r.state === 'en_cours' || r.state === 'terminee' || (r.state === 'abandonnee' && r.consent)) {
      var suivi = el('div', null, 'suivi');
      box.appendChild(button('Voir ses réponses et ses pièces', function () { follow(suivi, base); }));
      box.appendChild(suivi);
    }
    if (r.state === 'confiee' || r.state === 'en_cours') {
      box.appendChild(button('Marquer la demande terminée', function () { partAct(base + '/cloture', { outcome: 'terminee' }, 'La demande n’est pas close.', 'Demande terminée.'); }));
    }
    if (r.state !== 'terminee' && r.state !== 'abandonnee') {
      var drop = button('Abandonner la demande', function () {
        if (!drop.confirming) { drop.confirming = true; drop.textContent = 'Confirmer l’abandon'; return; }
        partAct(base + '/cloture', { outcome: 'abandonnee' }, 'La demande n’est pas abandonnée.', 'Demande abandonnée.');
      });
      drop.className = 'secondaire';
      box.appendChild(drop);
    }
    return box;
  }
  // L'accord du client : le texte des rémunérations lui est montré, il choisit parmi les tirés au sort, l'agent note ce qu'il a dit [R74, R75, R76].
  function consentForm(box, r, base) {
    var n = ++formSeq;
    var fees = el('div');
    box.appendChild(button('Montrer au client le texte des rémunérations', function () {
      partenairesState('Chargement…');
      send(base + '/remunerations', 'GET').then(function (res) {
        if (res.gone) return;
        if (!res.ok || !res.body.data) { partenairesState(res.offline ? 'Pas de réseau. Réessayez dans un moment.' : partnerRefusal(res.body, 'Le texte n’est pas disponible.')); return; }
        clear(fees);
        fees.appendChild(el('p', 'À lire au client avant son choix (montré à l’instant) :', 'doux'));
        fees.appendChild(el('p', res.body.data.text, 'brouillon'));
        partenairesState('Texte prêt à montrer au client.');
      });
    }));
    box.appendChild(fees);
    var set = el('fieldset');
    set.appendChild(el('legend', 'Le professionnel choisi par le client'));
    var radios = [];
    (r.shown || []).forEach(function (s, i) {
      if (!ID.test(s.partnerId)) return;
      var wrap = el('div', null, 'case');
      var c = el('input');
      c.setAttribute('type', 'radio');
      c.setAttribute('name', 'choix-' + n);
      c.setAttribute('id', 'choix-' + n + '-' + i);
      c.value = s.partnerId;
      var l = el('label', s.businessName);
      l.setAttribute('for', 'choix-' + n + '-' + i);
      wrap.appendChild(c);
      wrap.appendChild(l);
      set.appendChild(wrap);
      radios.push(c);
    });
    box.appendChild(set);
    var channel = field(box, 'canal-' + n, 'Comment le client a donné son accord', 'select');
    Object.keys(CONSENT_CHANNELS).forEach(function (k) { var o = el('option', CONSENT_CHANNELS[k]); o.value = k; channel.appendChild(o); });
    channel.value = 'oral';
    var note = field(box, 'note-' + n, 'Ce que le client a dit, et quand', 'textarea');
    note.setAttribute('maxlength', '1000');
    note.setAttribute('rows', '3');
    box.appendChild(button('Enregistrer son accord', function () {
      var picked = radios.filter(function (c) { return c.checked; })[0];
      if (!picked) { partenairesState('Cochez le professionnel choisi par le client.'); return; }
      var text = String(note.value || '').trim();
      if (text.length < 10) { partenairesState(PARTNER_REFUSALS.bad_note); return; }
      // Les deux écritures de ce geste sont sous le même verrou : si un autre geste est en cours, aucune preuve n'est écrite.
      var free = partTake();
      if (!free) return;
      partenairesState('Envoi…');
      send(base + '/preuve-accord', 'POST', { channel: channel.value, note: text }).then(function (res) {
        if (!res.gone && !partLost(res) && res.ok && res.body.data) {
          var d = res.body.data;
          return partWrite(base + '/accord', { partnerId: picked.value, consentAt: d.at, channel: d.channel, proofRef: d.proofRef }, 'L’accord n’est pas enregistré.', 'Accord du client enregistré.', free);
        }
        free();
        if (res.gone) return false;
        if (partLost(res)) { partenairesState(PART_LOST); return false; }
        return partRefused(res, 'L’accord n’est pas enregistré.');
      }, function () { free(); return false; });
    }));
  }
  function proposeForm(p) {
    var n = ++formSeq;
    var box = el('div', null, 'proposer');
    box.appendChild(el('h4', 'Proposer un professionnel'));
    var trade = field(box, 'metier-' + n, 'Métier', 'select');
    TRADES.forEach(function (t) { var o = el('option', t.label); o.value = t.trade; trade.appendChild(o); });
    trade.value = TRADES[0].trade;
    var domain = field(box, 'domaine-' + n, 'Diagnostic demandé, pour un diagnostiqueur', 'select');
    var none = el('option', 'Sans objet');
    none.value = '';
    domain.appendChild(none);
    Object.keys(DOMAINS).forEach(function (k) { var o = el('option', DOMAINS[k]); o.value = k; domain.appendChild(o); });
    domain.value = '';
    var props = (p.properties || []).filter(function (b) { return ID.test(b.propertyId); });
    var place = null;
    if (props.length) {
      place = field(box, 'bien-' + n, 'Bien concerné', 'select');
      props.forEach(function (b) { var o = el('option', 'Bien ' + b.reference); o.value = b.propertyId; place.appendChild(o); });
      place.value = props[0].propertyId;
    }
    // Le code postal du bien compte d'abord ; ce champ sert quand le projet n'a pas de bien, ou un bien sans code postal.
    var cp = field(box, 'cp-' + n, props.length ? 'Code postal du lieu, si le bien n’en a pas' : 'Code postal du lieu');
    cp.setAttribute('inputmode', 'numeric');
    cp.setAttribute('maxlength', '5');
    cp.setAttribute('autocomplete', 'off');
    box.appendChild(button('Tirer au sort et proposer au client', function () {
      var body = { projectId: p.projectId, trade: trade.value };
      if (trade.value === 'diagnostiqueur') body.domain = domain.value;
      if (place) body.propertyId = place.value;
      var code = String(cp.value || '').trim();
      if (code || !place) body.postcode = code;
      partAct('/v1/partenaires/relations', body, 'La proposition n’est pas faite.', 'Tirage fait : montrez au client les professionnels proposés, dans cet ordre.');
    }));
    // Une option payante du Studio (X13) est une mise en relation avec un photographe, pour un bien de ce projet [R74, R75].
    if (place) {
      var option = field(box, 'option-' + n, 'Option payante du Studio', 'select');
      Object.keys(STUDIO_OPTIONS).forEach(function (k) { var o = el('option', STUDIO_OPTIONS[k]); o.value = k; option.appendChild(o); });
      box.appendChild(button('Demander cette option et proposer au client', function () {
        var asked = { projectId: p.projectId, propertyId: place.value, option: option.value };
        var where = String(cp.value || '').trim();
        if (where) asked.postcode = where;
        partAct('/v1/studio/options', asked, 'L’option n’est pas demandée.', 'Tirage fait : montrez au client les photographes proposés, dans cet ordre.');
      }));
    }
    return box;
  }
  // Le suivi d'une demande confiée : son délai de réponse, les relances préparées, les pièces rangées, le résumé des faits.
  function follow(box, base) {
    clear(box);
    box.appendChild(el('p', 'Chargement…', 'doux'));
    return Promise.all([send(base + '/suivi', 'GET'), send(base + '/pieces', 'GET'), send(base + '/resume', 'GET')]).then(function (all) {
      clear(box);
      if (all.some(function (x) { return x.gone; })) return false;
      if (all.some(function (x) { return x.offline; })) { box.appendChild(el('p', 'Pas de réseau. Réessayez dans un moment.', 'doux')); return false; }
      if (!all[0].ok) { box.appendChild(el('p', 'Suivi indisponible pour le moment.', 'doux')); return false; }
      var m = (all[0].body.data && all[0].body.data.measure) || {};
      if (m.answered) box.appendChild(el('p', 'Première réponse en ' + duration(m.delayMinutes) + '.', 'fait'));
      else if (m.entrustedAt) box.appendChild(el('p', 'Sans réponse depuis ' + duration(m.delayMinutes) + '.', m.delayMinutes > 2880 ? 'retard' : null));
      ((all[0].body.data && all[0].body.data.followUps) || []).forEach(function (f) {
        box.appendChild(el('p', (f.kind === 'relance' ? 'Relance préparée pour le ' : 'Alerte pour vous le ') + date(f.dueAt) + ' (mode essai, rien ne part).', 'doux'));
      });
      var piecesRead = all[1].ok && Array.isArray(all[1].body.data);
      var pieces = piecesRead ? all[1].body.data : [];
      box.appendChild(el('h4', !piecesRead ? 'Pièces indisponibles pour le moment : réessayez plus tard' : pieces.length ? 'Pièces déposées' : 'Aucune pièce déposée pour le moment'));
      var ul = el('ul', null, 'liste');
      pieces.forEach(function (x) { ul.appendChild(line((SORTS[x.sort] || 'Pièce') + (x.version > 1 ? ', version ' + x.version : ''), DESTINATIONS[x.destination] || 'rangée')); });
      box.appendChild(ul);
      var s = all[2].ok && all[2].body.data && all[2].body.data.summary;
      if (s) {
        box.appendChild(el('p', s.headline, 'brouillon'));
        var pts = el('ul');
        (s.points || []).forEach(function (t) { pts.appendChild(el('li', t)); });
        box.appendChild(pts);
      }
      return true;
    });
  }
  return { open: open };
};
`;
