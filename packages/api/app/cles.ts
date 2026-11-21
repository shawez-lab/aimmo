/**
 * La clé de cet appareil et la preuve d'une action sensible, à l'écran (BR18), par les routes de `/v1/cles` (BR05).
 *
 * Chacun (agent, direction, conformité) enregistre la clé de cet appareil par `navigator.credentials.create` sur le
 * défi du serveur, lit ses clés et en retire une en deux appuis [R600]. La direction lit aussi les clés de son réseau,
 * accepte une clé en attente sur la preuve de sa propre clé, et retire toute clé du réseau [R600, R601].
 * Les autres blocs demandent une preuve par `prove(action, objet)` : un défi pour cette action et cet objet seuls,
 * signé par `navigator.credentials.get`, et la preuve rendue n'est acceptée que si elle porte sur ceux-là [R601].
 *
 * La clé publique part au serveur, jamais à l'écran. Chaque état et chaque refus se disent en mots, jamais par un code.
 * Une écriture sans réponse est dite incertaine. Script servi à part (`/app/cles.js`), chargé au premier geste [R201].
 * Tout texte reçu est posé en texte.
 */
import { SENSITIVE_ACTIONS } from '../../core/src/securite/cles-appareil.ts';

const REFUSALS: Record<string, string> = {
  role: 'Ce n’est pas dans vos droits.',
  other_network: 'Cette clé ne se trouve pas : relisez la liste.',
  agent_inactive: 'Votre accès n’est plus actif : aucune clé ne se range.',
  invalid_body: 'La demande n’a pas pu être lue. Rechargez l’écran.',
  unknown_field: 'La demande n’a pas pu être lue. Rechargez l’écran.',
  bad_input: 'La demande n’a pas pu être lue. Rechargez l’écran.',
  cles_non_configurees: 'Les clés d’accès ne sont pas encore ouvertes sur ce service.',
  too_many_devices: 'Vous avez déjà dix clés : retirez-en une avant d’en ranger une autre.',
  already_registered: 'Cette clé est déjà rangée.',
  unknown_challenge: 'La demande a expiré ou ne vous concerne pas : recommencez.',
  challenge_used: 'Cette demande a déjà servi : recommencez.',
  challenge_expired: 'La demande a expiré : elle ne vaut que cinq minutes. Recommencez.',
  no_device: 'Aucune clé active sur vos appareils : rangez d’abord la clé de cet appareil.',
  device_pending: 'Cette clé attend encore l’accord de la direction : elle ne prouve rien.',
  device_revoked: 'Cette clé a été retirée : elle ne prouve plus rien.',
  unknown_device: 'Cette clé n’est pas rangée pour vous : prenez celle de cet appareil.',
  clone_suspect: 'Cette clé semble copiée : elle est refusée. Retirez-la, puis rangez-en une neuve.',
  second_factor_required: 'Il faut la preuve de votre clé pour ce geste.',
  other_action: 'La preuve faite porte sur un autre geste : recommencez.',
  already_used: 'Cette preuve a déjà servi : recommencez.',
  expired: 'La preuve a expiré : elle ne vaut que cinq minutes. Recommencez.',
  not_pending: 'Cette clé n’attend plus d’accord : relisez la liste.',
  already_revoked: 'Cette clé est déjà retirée.',
  bad_client_data: 'La réponse de l’appareil n’a pas pu être lue. Recommencez.',
  wrong_type: 'La réponse de l’appareil n’a pas pu être lue. Recommencez.',
  wrong_challenge: 'La réponse de l’appareil ne répond pas à cette demande. Recommencez.',
  wrong_origin: 'Cette adresse n’est pas celle de l’application : ouvrez AIMMO à son adresse habituelle.',
  wrong_rp: 'Cette adresse n’est pas celle de l’application : ouvrez AIMMO à son adresse habituelle.',
  no_user_presence: 'L’appareil n’a pas vu votre geste. Recommencez.',
  no_user_verification: 'Il faut l’empreinte, le visage ou le code de l’appareil, pas un simple appui.',
  wrong_credential: 'La réponse de l’appareil ne porte pas cette clé. Recommencez.',
  bad_key: 'Cet appareil ne propose pas une clé que le service sait lire.',
  bad_signature: 'La signature de l’appareil est fausse : rien n’est fait.',
};
const STATES: Record<string, string> = {
  actif: 'Active',
  en_attente: 'En attente de l’accord de la direction',
  retire: 'Retirée : elle ne se connecte plus',
};
const ROLES: Record<string, string> = { agent: 'Agent', direction: 'Direction', compliance: 'Conformité' };

/** Les trois endroits du bloc : la journée de l'agent, l'écran du réseau, l'écran de la conformité. */
export type ClesPlace = 'accueil' | 'reseau' | 'conformite';

export const clesEntryHtml = (p: ClesPlace): string => `<section class="bloc" aria-labelledby="titre-cles-${p}">
<h3 id="titre-cles-${p}">Clés de mes appareils</h3>
<p class="doux">L’empreinte, le visage ou le code de l’appareil protège chaque clé. Elle ne quitte jamais l’appareil.</p>
<button id="cles-${p}-voir" type="button" class="secondaire">Voir mes clés</button>
<p id="cles-${p}-etat" class="etat" role="status"></p>
<div id="cles-${p}-corps"></div>
</section>
`;

/** Le chargeur posé dans le script de l'application : l'écran est servi à part, chargé une fois, jamais gardé. */
export const CLES_JS = `
  /* ---------- La clé de cet appareil et la preuve d'une action (BR18), chargées au premier geste [R201, R600, R601]. ---------- */
  var clesTools = null, clesLoading = false;
  function wipeCles() {
    ['accueil', 'reseau', 'conformite'].forEach(function (p) { clear($('cles-' + p + '-corps')); $('cles-' + p + '-etat').textContent = ''; });
  }
  function withCles(p, act) {
    if (!currentKey && p !== 0) return Promise.resolve(false);
    if (clesTools) return act(clesTools);
    if (clesLoading) return Promise.resolve(false);
    clesLoading = true;
    var mine = session, out = p ? $('cles-' + p + '-etat') : null;
    if (out) out.textContent = 'Chargement…';
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.setAttribute('src', '/app/cles.js');
      s.addEventListener('load', function () {
        clesLoading = false;
        var make = globalThis.AIMMO_CLES;
        try { delete globalThis.AIMMO_CLES; } catch (e) { /* rien */ }
        if (mine !== session) { resolve(false); return; }
        if (typeof make !== 'function') { if (out) out.textContent = 'Indisponible pour le moment. Réessayez dans un moment.'; resolve(false); return; }
        clesTools = make({ $: $, el: el, clear: clear, send: send, button: button, field: field, date: date, session: function () { return session; }, handoff: function (text) { forgetKey(currentKey); refuse(text); } });
        resolve(act(clesTools));
      });
      s.addEventListener('error', function () {
        clesLoading = false;
        if (out && mine === session) out.textContent = 'Pas de réseau. Réessayez dans un moment.';
        resolve(false);
      });
      $('reseau').appendChild(s);
    });
  }
  /* La preuve d'une action pour les autres blocs : toujours une réponse lisible, même hors ligne ou pendant le chargement. */
  function proveAction(action, subject) {
    return withCles(null, function (c) { return c.prove(action, subject); }).then(function (r) {
      return r && typeof r === 'object' ? r : { ok: false, text: 'La preuve n’a pas pu commencer : réessayez dans un moment.' };
    });
  }
`;

/** Le script servi à part (`/app/cles.js`). Il ne lit et n'écrit que `/v1/cles` [R16]. */
export const CLES_SCRIPT = `'use strict';
globalThis.AIMMO_CLES = function (t) {
  var $ = t.$, el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field, date = t.date;
  var REFUSALS = ${JSON.stringify(REFUSALS)};
  var STATES = ${JSON.stringify(STATES)};
  var ROLES = ${JSON.stringify(ROLES)};
  var ACTIONS = ${JSON.stringify(SENSITIVE_ACTIONS)};
  /* Mêmes formes que le serveur : une demande illisible ne part pas. */
  var SUBJECT = new RegExp('^[a-z_]{1,24}:[A-Za-z0-9_-]{1,64}$');
  var LABEL = new RegExp('^[\\\\p{L}\\\\p{N} \\'’-]{1,40}$', 'u');
  var ID = new RegExp('^[A-Za-z0-9_-]{1,64}$');
  var OFFLINE = 'Pas de réseau. Réessayez dans un moment.';
  /* Une écriture sans réponse, ou coupée par une panne du serveur, a pu passer : l'écran ne dit ni fait ni pas fait. */
  var LOST = 'La réponse n’est pas arrivée : rien n’est sûr. Relisez l’écran avant de recommencer.';
  var NO_WEBAUTHN = 'Cet appareil ou ce navigateur ne sait pas tenir de clé d’accès : ouvrez AIMMO dans un navigateur à jour.';
  var NO_MEMORY = 'Cet appareil ne peut pas retenir qui il sert : la clé n’est pas rangée. Réessayez dans un moment, hors navigation privée.';
  var BAD_LABEL = 'Le nom de l’appareil : de 1 à 40 lettres, chiffres, espaces, tirets ou apostrophes.';
  var busy = null, showing = 0, place = 'accueil';
  function state(text) { $('cles-' + place + '-etat').textContent = text; }
  function once(work) {
    var mine = t.session();
    if (busy === mine) return Promise.resolve(false);
    busy = mine;
    function done(r) { if (busy === mine) busy = null; return r; }
    return work().then(done, function () { return done(false); });
  }
  function why(res, fallback) {
    if (res.offline) return OFFLINE;
    var b = res.body || {};
    return REFUSALS[b.code] || fallback;
  }
  function supported() {
    var n = globalThis.navigator;
    return typeof globalThis.PublicKeyCredential === 'function' && !!n && !!n.credentials && typeof n.credentials.create === 'function' && typeof n.credentials.get === 'function';
  }
  /* Ce que dit l'appareil quand il ne fait pas la clé : le refus de la personne, le délai passé, une clé déjà là. */
  function deviceError(e) {
    var name = e && e.name;
    if (name === 'NotAllowedError' || name === 'AbortError') return 'Rien n’est fait : la demande a été refusée sur l’appareil, ou son délai est passé.';
    if (name === 'InvalidStateError') return 'Cet appareil tient déjà une de vos clés : elle est dans la liste.';
    if (name === 'SecurityError') return REFUSALS.wrong_origin;
    if (name === 'NotSupportedError') return REFUSALS.bad_key;
    return 'L’appareil n’a pas pu répondre. Réessayez.';
  }
  function bytes(buf) { return buf instanceof Uint8Array ? buf : new Uint8Array(buf); }
  function b64(buf) {
    var b = bytes(buf), s = '';
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  }
  function unb64(text) {
    var s = atob(String(text).replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (String(text).length % 4)) % 4));
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  function allowed(c) {
    return (Array.isArray(c.credentialIds) ? c.credentialIds : []).map(function (id) { return { type: 'public-key', id: unb64(id) }; });
  }
  function challengeOf(x) {
    var c = x.body && x.body.data;
    return c && typeof c.challengeId === 'string' && typeof c.challenge === 'string' && typeof c.rpId === 'string' ? c : null;
  }
  function clean(input) { return String(input.value || '').trim().replace(/\\s+/g, ' '); }

  /* La preuve d'une action sensible sur un objet : seulement ceux-là, rendue à qui la demande [R601]. */
  function prove(action, subject) {
    if (ACTIONS.indexOf(action) < 0 || !SUBJECT.test(String(subject))) return Promise.resolve({ ok: false, text: REFUSALS.bad_input });
    if (!supported()) return Promise.resolve({ ok: false, text: NO_WEBAUTHN });
    return send('/v1/cles/preuve/debut', 'POST', { action: action, subject: subject }).then(function (x) {
      if (x.gone) return { ok: false, gone: true, text: '' };
      var c = x.ok ? challengeOf(x) : null;
      if (!c) return { ok: false, text: why(x, 'La preuve n’a pas pu commencer.') };
      var ask = { challenge: unb64(c.challenge), rpId: c.rpId, allowCredentials: allowed(c), userVerification: 'required', timeout: 120000 };
      return navigator.credentials.get({ publicKey: ask }).then(function (a) {
        var r = a && a.response;
        if (!r) return { ok: false, text: deviceError(null) };
        var payload = { challengeId: c.challengeId, credentialId: b64(a.rawId), clientDataJSON: b64(r.clientDataJSON), authenticatorData: b64(r.authenticatorData), signature: b64(r.signature) };
        return send('/v1/cles/preuve/fin', 'POST', payload).then(function (y) {
          if (y.gone) return { ok: false, gone: true, text: '' };
          if (y.offline || !y.body || y.status >= 500) return { ok: false, text: LOST };
          if (!y.ok) return { ok: false, text: why(y, 'La preuve n’est pas faite.') };
          var d = y.body.data || {};
          /* Une preuve pour un autre geste ou un autre objet ne sert pas ici. */
          if (d.action !== action || d.subject !== subject || typeof d.stepUpId !== 'string' || !ID.test(d.stepUpId)) return { ok: false, text: REFUSALS.other_action };
          return { ok: true, stepUpId: d.stepUpId, text: '' };
        });
      }, function (e) { return { ok: false, text: deviceError(e) }; });
    });
  }

  function register(labelInput) {
    var label = clean(labelInput);
    if (!LABEL.test(label)) { state(BAD_LABEL); return Promise.resolve(false); }
    if (!supported()) { state(NO_WEBAUTHN); return Promise.resolve(false); }
    return once(function () {
      state('Demande à l’appareil…');
      /* AU108 · la clé d'application cesse dès que la clé de l'appareil est rangée : l'identité se lit avant, tant qu'elle sert. */
      /* L'identité d'avant revient si la clé n'est pas rangée : une autre clé de l'appareil reste utilisable. */
      var before = null;
      try { before = localStorage.getItem(WHO); } catch (e) { before = null; }
      var settled = false;
      function restore() { if (settled) return; try { if (before === null) localStorage.removeItem(WHO); else localStorage.setItem(WHO, before); } catch (e) { /* sans mémoire */ } }
      return send('/v1/cles/identite', 'GET').then(function (i) {
        if (i.gone) return false;
        /* Sans identité retenue sur l'appareil, sa clé ne pourrait pas servir à entrer : rien n'est rangé. */
        if (!keepWho(i)) { restore(); state(i.offline ? OFFLINE : NO_MEMORY); return false; }
        return send('/v1/cles/enregistrement/debut', 'POST');
      }).then(function (x) {
        if (x === false || x.gone) return false;
        var c = x.ok ? challengeOf(x) : null;
        if (!c) { state(why(x, 'La clé n’est pas rangée.')); return false; }
        var user = new Uint8Array(16);
        crypto.getRandomValues(user);
        var ask = {
          challenge: unb64(c.challenge),
          rp: { id: c.rpId, name: 'AIMMO' },
          user: { id: user, name: label, displayName: label },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          authenticatorSelection: { userVerification: 'required', residentKey: 'discouraged' },
          attestation: 'none',
          excludeCredentials: allowed(c),
          timeout: 120000,
        };
        return navigator.credentials.create({ publicKey: ask }).then(function (cred) {
          var r = cred && cred.response;
          if (!r || typeof r.getPublicKey !== 'function' || typeof r.getAuthenticatorData !== 'function') { state(NO_WEBAUTHN); return false; }
          var key = r.getPublicKey();
          if (!key || (typeof r.getPublicKeyAlgorithm === 'function' && r.getPublicKeyAlgorithm() !== -7)) { state(REFUSALS.bad_key); return false; }
          /* La clé publique part au serveur ; elle n'est jamais posée à l'écran. */
          var payload = { challengeId: c.challengeId, credentialId: b64(cred.rawId), publicKey: b64(key), clientDataJSON: b64(r.clientDataJSON), authenticatorData: b64(r.getAuthenticatorData()), label: label };
          state('Envoi…');
          return send('/v1/cles/enregistrement/fin', 'POST', payload).then(function (y) {
            if (y.gone) return false;
            if (y.offline || !y.body || y.status >= 500) { state(LOST); return false; }
            if (!y.ok) { state(why(y, 'La clé n’est pas rangée.')); return false; }
            var d = y.body.data || {};
            settled = true;
            return Promise.resolve().then(function () {
              /* AU108 · la clé d'application vient de cesser : l'appareil entre désormais par sa propre clé. */
              if (y.body.handoff === true && typeof t.handoff === 'function') {
                t.handoff(d.status === 'actif' ? 'Clé de cet appareil rangée : elle est active. Entrez avec la clé de cet appareil.' : 'Clé de cet appareil rangée : elle attend l’accord de la direction. Une fois acceptée, entrez avec la clé de cet appareil.');
                return true;
              }
              return show(place, d.status === 'actif' ? 'Clé de cet appareil rangée : elle est active.' : 'Clé de cet appareil rangée : elle attend l’accord de la direction avant de servir.');
            });
          });
        }, function (e) { state(deviceError(e)); return false; });
      }).then(function (r) { restore(); return r; }, function (e) { restore(); throw e; });
    });
  }

  /* AU023 · l'appareil retient qui il sert (réseau, rôle, identifiant : rien de secret), pour proposer sa clé à la connexion. */
  var WHO = 'aimmo.appareil';
  function remember(own) {
    /* Une clé en attente compte aussi : acceptée plus tard par la direction, elle connecte sans que l'agent rouvre la liste. */
    if (!own.some(function (d) { return d && (d.status === 'actif' || d.status === 'en_attente'); })) return;
    send('/v1/cles/identite', 'GET').then(keepWho);
  }
  /* Rend vrai seulement si l'identité est lue et bien retenue sur l'appareil. */
  function keepWho(x) {
    var d = x && x.ok && x.body && x.body.data;
    if (!d || !ID.test(String(d.networkId)) || !ID.test(String(d.userId)) || !ROLES[d.role]) return false;
    var who = JSON.stringify({ networkId: d.networkId, role: d.role, userId: d.userId });
    try { localStorage.setItem(WHO, who); return localStorage.getItem(WHO) === who; } catch (e) { return false; }
  }
  /* Une demande sans clé : la connexion est publique, la clé de l'appareil fait la preuve [R600]. */
  function post(path, payload) {
    var init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' };
    return fetch(path, init).then(function (r) {
      return r.json().then(function (b) { return { status: r.status, ok: r.ok && !!b && b.ok === true, body: b }; }, function () { return { status: r.status, ok: false, body: null }; });
    }, function () { return { offline: true }; });
  }
  var NO_LOGIN = 'Cette clé n’ouvre pas AIMMO : retirée, en attente de l’accord de la direction, ou absente de cet appareil. Demandez votre lien d’accès à la direction.';
  function loginWhy(x) {
    if (x.offline) return OFFLINE;
    if (x.status === 429) return 'Trop d’essais : réessayez dans une heure.';
    if (x.status === 503) return REFUSALS.cles_non_configurees;
    return NO_LOGIN;
  }
  /* La connexion par la clé de cet appareil : un défi, l'empreinte ou le code de l'appareil, une séance ; rien à taper. */
  function login() {
    var who = null;
    try { who = JSON.parse(localStorage.getItem(WHO) || 'null'); } catch (e) { who = null; }
    if (!who || !ID.test(String(who.networkId)) || !ID.test(String(who.userId)) || !ROLES[who.role]) return Promise.resolve({ text: NO_LOGIN });
    if (!supported()) return Promise.resolve({ text: NO_WEBAUTHN });
    return post('/v1/cles/connexion/debut', { networkId: who.networkId, role: who.role, userId: who.userId }).then(function (x) {
      var c = x.ok ? challengeOf(x) : null;
      if (!c) return { text: loginWhy(x) };
      var ask = { challenge: unb64(c.challenge), rpId: c.rpId, allowCredentials: allowed(c), userVerification: 'required', timeout: 120000 };
      return navigator.credentials.get({ publicKey: ask }).then(function (a) {
        var r = a && a.response;
        if (!r) return { text: deviceError(null) };
        return post('/v1/cles/connexion/fin', { challengeId: c.challengeId, credentialId: b64(a.rawId), clientDataJSON: b64(r.clientDataJSON), authenticatorData: b64(r.authenticatorData), signature: b64(r.signature) }).then(function (y) {
          var d = y.ok && y.body.data;
          return d && typeof d.token === 'string' && d.token.length >= 32 ? { token: d.token } : { text: loginWhy(y) };
        });
      }, function (e) { return { text: deviceError(e) }; });
    });
  }
  /* AU023 · la direction prépare le lien d'accès nominatif d'un agent, sur la preuve de sa clé pour cet agent [R601]. */
  function invite(a, lost, out, shown) {
    return once(function () {
      shown.textContent = '';
      out.textContent = 'Preuve de votre clé…';
      return prove('modifier_droits', 'agent:' + a.id).then(function (p) {
        if (p.gone) return false;
        if (!p.ok) { out.textContent = p.text; return false; }
        out.textContent = 'Envoi…';
        return send('/v1/cles/invitations', 'POST', { userId: a.id, stepUpId: p.stepUpId, retirerAnciens: lost.checked === true }).then(function (x) {
          if (x.gone) return false;
          if (x.offline || !x.body || x.status >= 500) { out.textContent = LOST; return false; }
          var d = x.ok && x.body.data;
          if (!d || typeof d.lien !== 'string' || d.lien.indexOf('/app/#invitation=') !== 0) { out.textContent = x.body.code === 'unknown' ? 'Cet agent n’est plus actif dans votre réseau.' : why(x, 'Le lien n’est pas préparé.'); return false; }
          shown.textContent = location.origin + d.lien;
          out.textContent = 'Lien prêt pour ' + a.name + ', valable une fois, jusqu’au ' + date(d.expiresAt) + '. Remettez-le-lui vous-même, à lui seul : il l’ouvre sur son téléphone et entre d’un appui.' +
            (lost.checked === true ? ' Anciens accès coupés : ' + (Number(d.keysRevoked) + Number(d.linksVoided)) + ' lien ou clé d’application, ' + Number(d.devicesRevoked) + ' clé d’appareil. Sa clé neuve attendra votre accord ici. Une clé personnelle remise à la main reste ouverte : faites-la retirer des réglages du service.' : '');
          return true;
        });
      });
    });
  }
  function renderInvite(body) {
    var box = el('details');
    box.appendChild(el('summary', 'Inviter un agent sur un nouvel appareil'));
    box.appendChild(el('p', 'Un lien nominatif, pour un appui sur son téléphone : il n’a aucune clé à voir ni à taper, puis il y range la clé de l’appareil.', 'doux'));
    var lost = el('input');
    lost.setAttribute('type', 'checkbox');
    lost.setAttribute('id', 'cles-perdu');
    var lab = el('label', 'Téléphone perdu ou volé : couper d’abord tous ses anciens accès');
    lab.setAttribute('for', 'cles-perdu');
    box.appendChild(lost);
    box.appendChild(lab);
    var list = el('ul', null, 'liste');
    var out = el('p', null, 'etat');
    out.setAttribute('role', 'status');
    var shown = el('p', null, 'lien');
    box.appendChild(button('Choisir l’agent', function () {
      clear(list);
      out.textContent = 'Chargement…';
      send('/v1/cles/invitations/agents', 'GET').then(function (x) {
        if (x.gone) return;
        var all = listOf(x);
        if (!all) { out.textContent = why(x, 'La liste des agents est indisponible pour le moment.'); return; }
        out.textContent = all.length ? '' : 'Aucun agent actif dans votre réseau.';
        all.forEach(function (a) {
          if (!a || typeof a.id !== 'string' || !ID.test(a.id) || typeof a.name !== 'string') return;
          var li = el('li');
          li.appendChild(button('Lien pour ' + a.name, function () { invite(a, lost, out, shown); }));
          list.appendChild(li);
        });
      });
    }));
    box.appendChild(list);
    box.appendChild(out);
    box.appendChild(shown);
    body.appendChild(box);
  }
  function write(path, payload, okText, failText) {
    state('Envoi…');
    return send(path, 'POST', payload).then(function (x) {
      if (x.gone) return false;
      if (x.offline || !x.body || x.status >= 500) { state(LOST); return false; }
      if (!x.ok) { state(why(x, failText)); return false; }
      return show(place, okText);
    });
  }
  /* Retirer ne se défait pas : un premier appui demande la confirmation, le second envoie. */
  function revokeButton(d) {
    var b = button('Retirer « ' + d.label + ' »', function () {
      if (!b.armed) { b.armed = true; b.textContent = 'Confirmer : « ' + d.label + ' » ne se connectera plus'; return; }
      once(function () { return write('/v1/cles/appareils/' + d.id + '/retrait', undefined, 'Clé « ' + d.label + ' » retirée : elle ne se connecte plus.', 'La clé n’est pas retirée.'); });
    });
    return b;
  }
  function approve(d) {
    return once(function () {
      state('Preuve de votre clé…');
      return prove('approuver_appareil', 'device:' + d.id).then(function (p) {
        if (p.gone) return false;
        if (!p.ok) { state(p.text); return false; }
        return write('/v1/cles/appareils/' + d.id + '/accord', { stepUpId: p.stepUpId }, 'Clé « ' + d.label + ' » acceptée : elle est active.', 'La clé n’est pas acceptée.');
      });
    });
  }
  function line(d) {
    return (STATES[d.status] || 'État que cet écran ne sait pas encore dire') + ' · rangée le ' + date(d.createdAt) + (d.revokedAt ? ', retirée le ' + date(d.revokedAt) : '') + '.';
  }
  function renderList(body, list, withOwner, canApprove) {
    var ul = el('ul', null, 'liste');
    list.forEach(function (d) {
      if (!d || typeof d.id !== 'string' || !ID.test(d.id)) return;
      var li = el('li');
      li.appendChild(el('strong', String(d.label || '')));
      if (withOwner) li.appendChild(el('p', (ROLES[d.userRole] || 'Rôle que cet écran ne sait pas encore dire') + (typeof d.ownerName === 'string' && d.ownerName ? ' · ' + d.ownerName : ''), 'doux'));
      li.appendChild(el('p', line(d)));
      if (withOwner && d.status === 'en_attente' && d.userRole === 'agent' && !d.ownerName) li.appendChild(el('p', 'Le titulaire de cette clé ne se lit pas : ne l’acceptez pas sans savoir à qui elle est.', 'alerte'));
      if (canApprove && d.status === 'en_attente') li.appendChild(button('Accepter « ' + d.label + ' »', function () { approve(d); }));
      if (d.status !== 'retire') li.appendChild(revokeButton(d));
      ul.appendChild(li);
    });
    body.appendChild(ul);
  }
  function renderRegister(body) {
    var box = el('details');
    box.appendChild(el('summary', 'Ranger la clé de cet appareil'));
    if (!supported()) { box.appendChild(el('p', NO_WEBAUTHN, 'alerte')); body.appendChild(box); return; }
    box.appendChild(el('p', 'La première clé sert tout de suite ; une suivante attend l’accord de la direction.', 'doux'));
    var label = field(box, 'cles-' + place + '-nom', 'Nom de cet appareil, par exemple Téléphone pro');
    label.setAttribute('maxlength', '40');
    box.appendChild(button('Ranger la clé de cet appareil', function () { register(label); }));
    body.appendChild(box);
  }
  function listOf(x) { return x.ok && x.body && Array.isArray(x.body.data) ? x.body.data : null; }
  function show(p, message) {
    if (p === 'accueil' || p === 'reseau' || p === 'conformite') place = p;
    var mine = t.session();
    var turn = ++showing;
    var body = $('cles-' + place + '-corps');
    clear(body);
    state('Chargement…');
    function stale(x) { return x.gone || mine !== t.session() || turn !== showing; }
    var asks = [send('/v1/cles/mes-appareils', 'GET')];
    if (place === 'reseau') asks.push(send('/v1/cles/appareils', 'GET'));
    return Promise.all(asks).then(function (all) {
      if (all.some(stale)) return false;
      var own = listOf(all[0]);
      if (!own) { state(why(all[0], 'Vos clés sont indisponibles pour le moment.')); return false; }
      body.appendChild(el('h4', 'Mes clés'));
      if (!own.length) body.appendChild(el('p', 'Aucune clé rangée pour vous : rangez celle de cet appareil.', 'doux'));
      else renderList(body, own, false, place === 'reseau');
      remember(own);
      renderRegister(body);
      if (place === 'reseau') renderInvite(body);
      if (all[1]) {
        var net = listOf(all[1]);
        body.appendChild(el('h4', 'Les clés du réseau'));
        if (!net) body.appendChild(el('p', why(all[1], 'Les clés du réseau sont indisponibles pour le moment.'), 'alerte'));
        else {
          var ids = own.map(function (d) { return d.id; });
          var others = net.filter(function (d) { return d && ids.indexOf(d.id) < 0; });
          if (!others.length) body.appendChild(el('p', 'Aucune autre clé dans le réseau.', 'doux'));
          else {
            body.appendChild(el('p', 'Avant d’accepter une clé, appelez la personne nommée : elle vous dit le nom qu’elle a donné à l’appareil.', 'doux'));
            renderList(body, others, true, true);
          }
        }
      }
      state(message || '');
      return true;
    });
  }
  return { show: show, prove: prove, login: login };
};
`;
