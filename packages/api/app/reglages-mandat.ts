import type { CancelReason, IntegrityReport } from '../../core/src/mandats/registre.ts';

/**
 * Les réglages du mandat sur l'écran du réseau (D13) : la direction règle le barème des honoraires et le format du
 * registre, contrôle le registre et annule un mandat, depuis la liste, sans identifiant à saisir [R16]. Script servi à part
 * (`/app/reglages-mandat.js`), chargé au premier geste [R201]. L'écran ne décide rien : le serveur dit si c'est permis, et
 * son refus est dit en français. Le format ne se règle qu'une fois, l'écran le dit et demande deux appuis [R39] ; une
 * annulation aussi, et elle dit qu'elle rouvre le bien. Tout texte reçu est posé en texte, rien ne reste une fois quitté.
 */

const REFUSALS: Record<string, string> = {
  role: 'Ce n’est pas dans vos droits.',
  bad_schedule: 'Le taux : un pourcentage de 0,01 à 100, au centième au plus. Le minimum : un nombre entier d’euros.',
  bad_tiers: 'Les tranches : une par ligne, « jusqu’à 100 000 : 8 000 € » ou « jusqu’à 250 000 : 4 % », des prix croissants, « au-delà : 3 % » en dernier.',
  bad_settings: 'Le préfixe : 20 caractères au plus, lettres, chiffres, espace, / . _ -. Le premier numéro : 1 ou plus. Le nombre de chiffres : de 1 à 10.',
  already_configured: 'Le format est déjà réglé : il ne change plus.',
  already_cancelled: 'Ce mandat est déjà annulé.',
  not_inscribed: 'Ce mandat n’est pas inscrit au registre.',
  unknown: 'Ce mandat n’est pas au registre de ce réseau.',
  bad_reason: 'Choisissez le motif de l’annulation.',
  register_broken: 'Le registre est abîmé : rien ne s’y ajoute. Prévenez le responsable de la conformité.',
};
/** Ce qui a abîmé le registre, dit en français ; un code inconnu reste un registre abîmé, jamais intact [R39]. */
const PROBLEMS: Record<Exclude<IntegrityReport, { ok: true }>['problem'], string> = {
  hash: 'cette ligne a été modifiée après coup',
  chain: 'le lien avec la ligne précédente est rompu',
  sequence: 'il manque une ligne à cet endroit',
  number: 'le numéro n’est pas celui attendu',
  mandate: 'cette ligne ne correspond plus à son mandat',
  anchor: 'cette ligne ne correspond plus à ce que le journal a retenu',
  missing: 'des lignes ont été effacées à partir d’ici',
};
const REASONS: Record<CancelReason, string> = {
  error: 'erreur',
  termination: 'résiliation',
  withdrawal: 'rétractation',
};
/** Les motifs qu'on peut choisir : une rétractation a sa route, avec sa preuve. */
const CHOSEN_REASONS: readonly (readonly [CancelReason, string])[] = [
  ['error', 'Erreur : ce mandat n’aurait pas dû être inscrit'],
  ['termination', 'Résiliation : le mandat a pris fin avant son terme'],
];

export const REGLAGES_MANDAT_ENTRY_HTML = `<section class="bloc" aria-labelledby="titre-regmandat">
<h3 id="titre-regmandat">Réglages du mandat</h3>
<p class="doux">Sans barème et sans format du registre, aucun mandat ne se signe.</p>
<button id="regmandat-voir" type="button" class="secondaire">Voir le barème et le registre</button>
<button id="regmandat-controle" type="button" class="secondaire">Contrôler le registre</button>
<p id="regmandat-etat" class="etat" role="status"></p>
<div id="regmandat-corps"></div>
</section>
`;

/** Le chargeur posé dans le script de l'application : l'écran est servi à part, chargé une fois, jamais gardé. */
export const REGLAGES_MANDAT_JS = `
  /* ---------- Les réglages du mandat sur l'écran du réseau (D13), chargés au premier geste [R16, R201]. ---------- */
  function wipeReglagesMandat() {
    clear($('regmandat-corps'));
    $('regmandat-etat').textContent = '';
  }
  function withReglagesMandat(act) {
    return withTool('reglages-mandat', 'AIMMO_REGLAGES_MANDAT', 'regmandat-etat', 'reseau', act, function () { return { $: $, el: el, clear: clear, send: send, button: button, field: field, date: date, session: function () { return session; } }; });
  }
`;

/** Le script servi à part (`/app/reglages-mandat.js`). Il ne lit et n'écrit que les routes du barème et du registre [R16]. */
export const REGLAGES_MANDAT_SCRIPT = `'use strict';
globalThis.AIMMO_REGLAGES_MANDAT = function (t) {
  var $ = t.$, el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field, date = t.date;
  var REFUSALS = ${JSON.stringify(REFUSALS)};
  var PROBLEMS = ${JSON.stringify(PROBLEMS)};
  var REASONS = ${JSON.stringify(REASONS)};
  var CHOSEN = ${JSON.stringify(CHOSEN_REASONS)};
  var OFFLINE = 'Pas de réseau. Réessayez dans un moment.';
  /* Une écriture sans réponse, ou coupée par une panne du serveur, a pu passer : l'écran ne dit ni fait ni pas fait. */
  var LOST = 'La réponse n’est pas arrivée : rien n’est sûr. Relisez le barème et le registre avant de recommencer.';
  /* Le verrou d'un geste vaut pour sa session : une réponse qui tarde ne bloque pas la connexion suivante. */
  var busy = null, showing = 0;
  function state(text) { $('regmandat-etat').textContent = text; }
  function once(work) {
    var mine = t.session();
    if (busy === mine) return Promise.resolve(false);
    busy = mine;
    function done(r) { if (busy === mine) busy = null; return r; }
    return work().then(done, function () { return done(false); });
  }
  function why(res, fallback) {
    if (res.offline) return OFFLINE;
    return (res.body && REFUSALS[res.body.code]) || fallback;
  }
  /* Deux appuis espacés, pour ce qui ne se défait pas. Sans suite, ou si la saisie change, la demande retombe. */
  function confirmed(text, confirmText, warn, ready, act) {
    var armedAt = null, armedFor = null;
    var b = button(text, function () {
      var key = ready();
      if (key === null) return;
      var now = Date.now();
      if (armedAt !== null && armedFor === key && now - armedAt < 1000) return;
      if (armedAt === null || armedFor !== key || now - armedAt > 15000) {
        armedAt = now;
        armedFor = key;
        b.textContent = confirmText;
        state(warn(key) + ' Appuyez de nouveau pour confirmer.');
        return;
      }
      armedAt = null;
      armedFor = null;
      b.textContent = text;
      act(key);
    });
    return b;
  }
  /* Un nombre tel que la France l'écrit : 5,5 ou 3 000. Vide ou illisible : null, et rien ne part. */
  function number(input) {
    var v = String(input.value || '').replace(/[\\s\\u00a0\\u202f]/g, '').replace(',', '.');
    if (!/^\\d+(\\.\\d+)?$/.test(v)) return null;
    return Number(v);
  }
  function write(path, body, done, fallback) {
    return once(function () {
      state('Envoi…');
      return send(path, 'POST', body).then(function (x) {
        if (x.gone) return false;
        if (x.offline || !x.body || x.status >= 500) { state(LOST); return false; }
        return done(x, why(x, fallback));
      });
    });
  }
  function part(title) {
    var box = el('div');
    box.appendChild(el('h4', title));
    $('regmandat-corps').appendChild(box);
    return box;
  }
  function euros(n) { return Number(n).toLocaleString('fr-FR') + ' €'; }
  /* « jusqu’à 100 000 : 8 000 € », « jusqu’à 250 000 : 4 % », « au-delà : 3 % » ; null si une ligne ne se lit pas. */
  function readTiers(text) {
    var out = [], bad = false;
    text.split(/\\n/).forEach(function (line) {
      var l = line.replace(/[\\u00a0\\u202f]/g, ' ').trim().toLowerCase();
      if (!l) return;
      var m = /^(?:jusqu['’]?\\s*[aà]\\s*([\\d\\s]+)\\s*€?|au-?\\s*del[aà])\\s*:\\s*([\\d\\s]+(?:[.,]\\d{1,2})?)\\s*(%|€)$/.exec(l);
      if (!m) { bad = true; return; }
      var n = Number(m[2].replace(/\\s/g, '').replace(',', '.'));
      var t = { upToEur: m[1] ? Number(m[1].replace(/\\s/g, '')) : null };
      if (m[3] === '%') t.ratePercent = n; else t.flatEur = n;
      out.push(t);
    });
    return bad ? null : out;
  }
  function percent(n) { return String(n).replace('.', ',') + ' %'; }
  function renderFees(res) {
    var box = part('Barème des honoraires');
    if (!res.ok) { box.appendChild(el('p', why(res, 'Barème indisponible pour le moment.'), 'etat')); return; }
    var v = res.body.data;
    box.appendChild(el('p', v ? 'En vigueur depuis le ' + date(v.setAt) + ' : ' + percent(v.maxRatePercent) + ' du prix au plus, ' + euros(v.minEur) + ' au moins.' : 'Aucun barème : aucun mandat ne passe ses contrôles.', v ? null : 'etat'));
    // AU058 · les tranches en vigueur, chacune avec son plafond.
    if (v && Array.isArray(v.tiers) && v.tiers.length) {
      var ul = el('ul', null, 'liste');
      v.tiers.forEach(function (x) { ul.appendChild(el('li', (x.upToEur === null ? 'Au-delà' : 'Jusqu’à ' + euros(x.upToEur)) + ' : ' + (x.flatEur !== undefined ? euros(x.flatEur) + ' au plus' : percent(x.ratePercent) + ' du prix au plus'))); });
      box.appendChild(ul);
    }
    var rate = field(box, 'regmandat-taux', 'Taux maximal, en % du prix');
    rate.setAttribute('inputmode', 'decimal');
    var min = field(box, 'regmandat-minimum', 'Minimum, en euros');
    min.setAttribute('inputmode', 'numeric');
    var tiersField = field(box, 'regmandat-tranches', 'Tranches (facultatif), une par ligne : « jusqu’à 100 000 : 8 000 € », « jusqu’à 250 000 : 4 % », « au-delà : 3 % »', 'textarea');
    tiersField.setAttribute('rows', '4');
    box.appendChild(el('p', 'Un nouveau barème s’ajoute au précédent, qui reste au journal. Il vaut pour les prochains contrôles.', 'doux'));
    box.appendChild(button('Ranger le barème', function () {
      var r = number(rate), m = number(min);
      if (r === null || m === null) { state(REFUSALS.bad_schedule); return; }
      var tiers = readTiers(String(tiersField.value || ''));
      if (tiers === null) { state(REFUSALS.bad_tiers); return; }
      var body = { maxRatePercent: r, minEur: m };
      if (tiers.length) body.tiers = tiers;
      write('/v1/honoraires/bareme', body, function (x, text) {
        if (!x.ok) { state(text); return false; }
        return show('Barème rangé.');
      }, 'Le barème n’est pas rangé.');
    }));
  }
  function renderFormat(res) {
    var box = part('Format du registre');
    if (!res.ok) { box.appendChild(el('p', why(res, 'Format indisponible pour le moment.'), 'etat')); return; }
    var v = res.body.data;
    if (v) {
      box.appendChild(el('p', 'Réglé le ' + date(v.setAt) + ', une fois pour toutes : il ne change plus.'));
      box.appendChild(el('p', 'Prochain numéro : ' + v.next + '.'));
      return;
    }
    box.appendChild(el('p', 'Ce format ne se règle qu’une seule fois, et ne pourra plus changer. Reprenez celui du registre de l’agence et son prochain numéro libre.', 'etat'));
    var prefix = field(box, 'regmandat-prefixe', 'Préfixe (facultatif)');
    prefix.setAttribute('maxlength', '20');
    var first = field(box, 'regmandat-premier', 'Premier numéro');
    first.setAttribute('inputmode', 'numeric');
    var width = field(box, 'regmandat-largeur', 'Nombre de chiffres');
    width.setAttribute('inputmode', 'numeric');
    function values() {
      var f = number(first), w = number(width);
      if (f === null || w === null) { state(REFUSALS.bad_settings); return null; }
      return JSON.stringify({ prefix: String(prefix.value || ''), firstNumber: f, width: w });
    }
    box.appendChild(confirmed('Régler le format', 'Confirmer : régler le format', function (key) {
      var s = JSON.parse(key);
      return 'Le premier mandat portera le numéro ' + s.prefix + String(s.firstNumber).padStart(s.width, '0') + ', et le format ne changera plus.';
    }, values, function (key) {
      write('/v1/registre/reglage', JSON.parse(key), function (x, text) {
        if (x.ok) return show('Format réglé : il ne change plus.');
        if (x.body && x.body.code === 'already_configured') return show(text);
        state(text);
        return false;
      }, 'Le format n’est pas réglé.');
    }));
  }
  function entry(v, i) {
    var li = el('li');
    li.appendChild(el('strong', v.number));
    li.appendChild(el('p', 'Signé le ' + date(v.signedAt) + (v.agentName ? ', ' + v.agentName : '') + (v.city ? ', ' + v.city : '') + '.', 'doux'));
    if (v.cancelledAt) {
      li.appendChild(el('p', 'Annulé le ' + date(v.cancelledAt) + (REASONS[v.cancelReason] ? ' : ' + REASONS[v.cancelReason] : '') + '. Son numéro reste au registre.'));
      return li;
    }
    var reason = field(li, 'regmandat-motif-' + i, 'Motif de l’annulation', 'select');
    var none = el('option', 'Choisir le motif');
    none.value = '';
    reason.appendChild(none);
    CHOSEN.forEach(function (c) {
      var o = el('option', c[1]);
      o.value = c[0];
      reason.appendChild(o);
    });
    li.appendChild(confirmed('Annuler ce mandat', 'Confirmer : annuler ce mandat', function (key) {
      return 'Annuler ' + v.number + ' pour ' + REASONS[key] + ' rouvre le bien à un nouveau mandat ; sa diffusion s’arrête au prochain passage des annonces. Le numéro reste au registre, rien n’est effacé.';
    }, function () {
      if (!reason.value) { state(REFUSALS.bad_reason); return null; }
      return reason.value;
    }, function (key) {
      write('/v1/mandats/' + encodeURIComponent(v.mandateId) + '/annulation', { reason: key }, function (x, text) {
        if (x.ok) return show(v.number + ' annulé : le bien peut recevoir un nouveau mandat. Le numéro reste au registre.');
        if (x.body && x.body.code === 'already_cancelled') return show(text);
        state(text);
        return false;
      }, 'L’annulation n’a pas abouti : le mandat reste en l’état.');
    }));
    return li;
  }
  function renderLines(res) {
    var box = part('Mandats au registre');
    if (!res.ok || !res.body.data || !Array.isArray(res.body.data.entries)) { box.appendChild(el('p', why(res, 'Liste indisponible pour le moment.'), 'etat')); return; }
    var ul = el('ul', null, 'liste');
    box.appendChild(ul);
    var count = 0;
    function add(data) {
      data.entries.forEach(function (v) { ul.appendChild(entry(v, count++)); });
      if (count === 0) box.appendChild(el('p', 'Aucun mandat inscrit pour le moment.', 'doux'));
      if (data.next === null || data.next === undefined) return;
      var more = button('Voir les précédents', function () {
        var mine = t.session();
        once(function () {
          state('Chargement…');
          return send('/v1/registre/lignes?avant=' + encodeURIComponent(data.next), 'GET').then(function (x) {
            if (x.gone || mine !== t.session()) return false;
            if (!x.ok || !x.body.data || !Array.isArray(x.body.data.entries)) { state(why(x, 'Liste indisponible pour le moment.')); return false; }
            box.removeChild(more);
            state('');
            add(x.body.data);
            return true;
          });
        });
      });
      more.className = 'secondaire';
      box.appendChild(more);
    }
    add(res.body.data);
  }
  function show(message) {
    var mine = t.session();
    /* Seule la dernière lecture demandée s'affiche : deux appuis ne font pas deux listes. */
    var turn = ++showing;
    clear($('regmandat-corps'));
    state('Chargement…');
    return Promise.all(['/v1/honoraires/bareme', '/v1/registre/reglage', '/v1/registre/lignes'].map(function (path) { return send(path, 'GET'); })).then(function (all) {
      if (all.some(function (r) { return r.gone; }) || mine !== t.session() || turn !== showing) return false;
      renderFees(all[0]);
      renderFormat(all[1]);
      renderLines(all[2]);
      state(message || (all.some(function (r) { return r.offline; }) ? OFFLINE : ''));
      return true;
    });
  }
  function control() {
    return once(function () {
      var mine = t.session();
      state('Vérification…');
      return send('/v1/registre/controle', 'GET').then(function (res) {
        if (res.gone || mine !== t.session()) return false;
        if (!res.ok || !res.body.data) { state(why(res, 'Contrôle indisponible pour le moment.')); return false; }
        var d = res.body.data;
        if (d.ok === true) { state(d.lines === 0 ? 'Registre vide : rien à contrôler.' : 'Registre intact : ' + d.lines + ' ligne(s) vérifiée(s).'); return true; }
        state('Registre abîmé à la ligne ' + d.brokenAt + ' : ' + (PROBLEMS[d.problem] || 'une anomalie a été trouvée') + '. Ne touchez à rien et prévenez le responsable de la conformité.');
        return true;
      });
    });
  }
  return { show: show, control: control };
};
`;
