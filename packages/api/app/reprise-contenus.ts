/**
 * Le contenu des fichiers de l'agence sous licence tiré à l'écran (BR83 ; Feuille de route, phase 5 ; Offre aux agents,
 * « Licence du logiciel » ; Conformité, portabilité) [R666, R667, R663, R601, R201, R16].
 *
 * Servi à part (`/app/reprise-contenus.js`), chargé au seul geste « Tirer le contenu de mes fichiers » du bloc
 * « Reprendre mes données » (`licences.ts`), sur le fichier de reprise tiré dans la même séance. Il ne lit que
 * `/v1/export/agence/contenus` (BR82), une preuve de la clé de l'appareil par appel [R601].
 *
 * Décidé, lecture prudente :
 *   - un lot à la fois à l'écran : le suivant remplace le précédent, pour que la mémoire d'un téléphone tienne ;
 *   - une pièce n'est offerte à l'enregistrement que si l'appareil a refait lui-même son SHA-256 et sa taille, et
 *     qu'ils sont ceux qu'AIMMO a dits ; sinon elle est dite altérée en route, jamais enregistrée [R666] ;
 *   - absente ou masquée : dit en mots, sans dire pourquoi elle manque [R663] ;
 *   - une pièce trop grosse se tire tranche par tranche, chacune avec l'empreinte attendue ; une tranche altérée ou
 *     absente arrête tout et rien n'est enregistré [R667]. Son SHA-256 entier n'est refait ici que jusqu'à 64 Mo ;
 *     au-delà, elle est dite « vérifiée tranche par tranche » ;
 *   - le reçu enregistré dit l'empreinte du fichier de reprise, les manifestes des lots et chaque pièce avec
 *     l'empreinte refaite ici, sans aucun contenu.
 *
 * Jamais vu : l'agence qui part ne reçoit aucune pièce que son propre appareil n'a pas vérifiée octet par octet, et
 * repart avec un reçu qui le prouve, pièce par pièce.
 */

const REFUSALS: Record<string, string> = {
  role: 'Ce n’est pas dans vos droits.',
  pas_de_licence: 'Aucune licence n’est rangée pour votre agence.',
  fichier_non_verifie: 'Ce fichier de reprise n’est plus celui qu’AIMMO vous a remis, ou il a changé : tirez-en un nouveau.',
  bad_input: 'La demande n’a pas pu être lue. Tirez un nouveau fichier de reprise.',
  invalid_body: 'La demande n’a pas pu être lue. Rechargez l’écran.',
  unknown_field: 'La demande n’a pas pu être lue. Rechargez l’écran.',
  stockage_sans_plages: 'Ce stockage ne sait pas remettre une pièce en tranches : cette pièce ne se tire pas pour le moment.',
  fichiers_non_branches: 'Le stockage des fichiers n’est pas encore branché : aucun contenu ne se tire pour le moment.',
  cles_non_configurees: 'Les clés d’accès ne sont pas encore ouvertes sur ce service : le contenu ne se tire pas sans elles.',
  second_factor_required: 'Il faut la preuve de la clé de cet appareil.',
  other_action: 'La preuve faite porte sur un autre geste : recommencez.',
  already_used: 'Cette preuve a déjà servi : recommencez.',
  expired: 'La preuve a expiré : elle ne vaut que cinq minutes. Recommencez.',
  device_revoked: 'La clé qui a fait la preuve a été retirée : recommencez avec une clé active.',
  agent_inactive: 'Votre accès n’est plus actif.',
};

/** Au-delà, le SHA-256 entier d'une pièce en tranches n'est pas refait sur l'appareil : chaque tranche l'est. */
export const ENTIERE_MAX_OCTETS = 64 * 1024 * 1024;

/** Le script servi à part. Il ne lit que `/v1/export/agence/contenus` [R16]. */
export const REPRISE_CONTENUS_SCRIPT = `'use strict';
globalThis.AIMMO_REPRISE_CONTENUS = function (t) {
  var el = t.el, clear = t.clear, send = t.send, button = t.button, prove = t.prove;
  var REFUSALS = ${JSON.stringify(REFUSALS)};
  var ENTIERE_MAX = ${ENTIERE_MAX_OCTETS};
  var OFFLINE = 'Pas de réseau. Réessayez dans un moment.';
  var LOST = 'La réponse n’est pas arrivée : rien n’est sûr. Recommencez ce lot.';
  var HEX = new RegExp('^[0-9a-f]{64}$');
  var stateEl = null, listEl = null, busy = false;
  /* Ce qui est tiré dans la séance : la place suivante, le reçu (sans contenu), les comptes. */
  var doc = null, owner = null, suite = 0, recu = null;
  function say(text) { if (stateEl) stateEl.textContent = text; }
  function why(x, fallback) {
    if (x.offline) return OFFLINE;
    return REFUSALS[(x.body || {}).code] || fallback;
  }
  function lost(x) { return x.offline || !x.body || x.status >= 500 && !(x.body && REFUSALS[x.body.code]); }
  function stale() { return owner !== t.session(); }
  function hex(buf) {
    var b = new Uint8Array(buf), s = '';
    for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return s;
  }
  function bytesOf(b64) {
    if (typeof b64 !== 'string') return null;
    try {
      var bin = atob(b64), out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch (e) { return null; }
  }
  function digest(bytes) { return crypto.subtle.digest('SHA-256', bytes).then(hex); }
  function size(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' o';
    if (n < 1048576) return (n / 1024).toFixed(1).replace('.', ',') + ' Ko';
    return (n / 1048576).toFixed(1).replace('.', ',') + ' Mo';
  }
  function nameOf(p) {
    var last = String(p.ref || '').split('/').pop() || 'piece';
    return 'aimmo-' + Number(p.index) + '-' + last.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  }
  function save(parts, name, type) {
    var url = URL.createObjectURL(new Blob(parts, { type: type }));
    var a = el('a', 'Enregistrer');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }
  /* Une preuve de la clé de cet appareil, puis l'appel : une preuve par appel [R601]. */
  function call(path, payload) {
    return prove('export_complet', 'licence:' + String(doc.licenceId)).then(function (p) {
      if (p.gone || stale()) return { gone: true };
      if (!p.ok) return { refused: p.text };
      var body = { document: doc, stepUpId: p.stepUpId };
      for (var k in payload) body[k] = payload[k];
      return send(path, 'POST', body).then(function (x) {
        if (x.gone || stale()) return { gone: true };
        if (lost(x)) return { refused: LOST };
        if (!x.ok) return { refused: why(x, 'Le contenu n’est pas tiré.') };
        return { data: x.body.data || {} };
      });
    });
  }
  /* Une pièce dite une seule fois au reçu : une pièce tirée en tranches remplace sa ligne « en_tranches ». */
  function note(p, statut, sha, taille) {
    var entry = { index: p.index, table: p.table, colonne: p.colonne, ref: p.ref, statut: statut, sha256: sha, taille: taille };
    for (var i = 0; i < recu.pieces.length; i++) {
      if (recu.pieces[i].index !== p.index) continue;
      recu.comptes[recu.pieces[i].statut] -= 1;
      recu.pieces[i] = entry;
      recu.comptes[statut] = (recu.comptes[statut] || 0) + 1;
      return;
    }
    recu.pieces.push(entry);
    recu.comptes[statut] = (recu.comptes[statut] || 0) + 1;
  }
  function line(p, text) {
    var li = el('li');
    li.appendChild(el('span', String(p.table) + ' · ' + String(p.colonne) + ' · ' + nameOf(p) + ' : ' + text));
    listEl.appendChild(li);
    return li;
  }
  /* Une pièce remise : refaite ici, offerte seulement si elle concorde [R666]. */
  function remise(p) {
    var bytes = bytesOf(p.contenu);
    if (!bytes || !HEX.test(String(p.sha256))) { note(p, 'alteree', null, null); line(p, 'altérée en route : non enregistrée.'); return Promise.resolve(); }
    return digest(bytes).then(function (h) {
      if (h !== p.sha256 || bytes.length !== p.taille) { note(p, 'alteree', h, bytes.length); line(p, 'altérée en route : son empreinte refaite ici n’est pas celle qu’AIMMO a dite. Non enregistrée.'); return; }
      note(p, 'verifiee', h, bytes.length);
      var li = line(p, size(bytes.length) + ', empreinte refaite sur cet appareil : identique.');
      li.appendChild(button('Enregistrer ' + nameOf(p), function () { save([bytes], nameOf(p), 'application/octet-stream'); }));
    });
  }
  /* Une pièce trop grosse : tranche par tranche, chacune avec l'empreinte attendue ; un écart arrête tout [R667]. */
  function enTranches(p, li, b) {
    if (busy) return Promise.resolve(false);
    busy = true;
    b.disabled = true;
    function stop(text) { busy = false; b.disabled = false; say(text); return false; }
    say('Empreinte de la pièce…');
    return call('/v1/export/agence/contenus/piece', { index: p.index }).then(function (r) {
      if (r.gone) { busy = false; return false; }
      if (r.refused) return stop(r.refused);
      var e = r.data;
      if (e.statut === 'absente') return stop('Cette pièce est absente : rien n’est enregistré.');
      if (e.statut === 'masquee') return stop('Cette pièce est masquée dans le fichier : elle n’est pas lue.');
      var tranches = Array.isArray(e.tranches) ? e.tranches : [];
      if (e.statut !== 'prete' || !tranches.length || !HEX.test(String(e.sha256))) return stop('Cette pièce ne se tire pas pour le moment : rien n’est enregistré.');
      var parts = [], i = 0;
      function next() {
        if (i >= tranches.length) return finish();
        var d = tranches[i];
        say('Tranche ' + (i + 1) + ' sur ' + tranches.length + ' : preuve de la clé de cet appareil…');
        return call('/v1/export/agence/contenus/tranche', { index: p.index, debut: d.debut, attendue: d.sha256 }).then(function (x) {
          if (x.gone) { busy = false; return false; }
          if (x.refused) return stop(x.refused + ' Rien n’est enregistré.');
          var bytes = x.data.statut === 'remise' ? bytesOf(x.data.contenu) : null;
          if (!bytes) return stop('La tranche ' + (i + 1) + ' a changé ou manque : tout s’arrête, rien n’est enregistré.');
          return digest(bytes).then(function (h) {
            if (h !== d.sha256 || bytes.length !== d.taille || x.data.debut !== d.debut) return stop('La tranche ' + (i + 1) + ' refaite ici n’est pas celle qu’AIMMO a dite : tout s’arrête, rien n’est enregistré.');
            parts.push(bytes);
            i++;
            return next();
          });
        });
      }
      function finish() {
        var total = 0;
        parts.forEach(function (x) { total += x.length; });
        if (total !== e.taille) return stop('La pièce recomposée n’a pas la taille dite : rien n’est enregistré.');
        var whole = total <= ENTIERE_MAX
          ? new Blob(parts).arrayBuffer().then(digest).then(function (h) { return h === e.sha256 ? 'empreinte entière refaite sur cet appareil : identique' : null; })
          : Promise.resolve('vérifiée tranche par tranche (' + parts.length + ' tranches)');
        return whole.then(function (said) {
          if (stale()) { busy = false; return false; }
          if (!said) return stop('La pièce recomposée n’a pas l’empreinte dite : rien n’est enregistré.');
          busy = false;
          note(p, 'verifiee', e.sha256, total);
          clear(li);
          li.appendChild(el('span', String(p.table) + ' · ' + String(p.colonne) + ' · ' + nameOf(p) + ' : ' + size(total) + ', ' + said + '.'));
          li.appendChild(button('Enregistrer ' + nameOf(p), function () { save(parts, nameOf(p), 'application/octet-stream'); }));
          say('Pièce tirée en ' + parts.length + ' tranches.');
          return true;
        });
      }
      return next();
    });
  }
  function piece(p) {
    if (p.statut === 'remise') return remise(p);
    if (p.statut === 'absente') { note(p, 'absente', null, null); line(p, 'absente.'); }
    else if (p.statut === 'masquee') { note(p, 'masquee', null, null); line(p, 'masquée dans le fichier : non lue.'); }
    else if (p.statut === 'trop_grosse') {
      note(p, 'en_tranches', null, null);
      var li = line(p, 'trop grosse pour un lot : elle se tire tranche par tranche, une preuve par tranche.');
      var b = button('Tirer en tranches ' + nameOf(p), function () { enTranches(p, li, b); });
      li.appendChild(b);
    } else { note(p, 'alteree', null, null); line(p, 'illisible : non enregistrée.'); }
    return Promise.resolve();
  }
  function counts() {
    var c = recu.comptes;
    return (c.verifiee || 0) + ' vérifiées, ' + (c.absente || 0) + ' absentes, ' + (c.masquee || 0) + ' masquées, ' + (c.en_tranches || 0) + ' à tirer en tranches, ' + (c.alteree || 0) + ' altérées';
  }
  function lot(b) {
    if (busy || suite === null) return Promise.resolve(false);
    busy = true;
    b.disabled = true;
    say('Preuve de la clé de cet appareil…');
    return call('/v1/export/agence/contenus', { depuis: suite }).then(function (r) {
      if (r.gone) { busy = false; return false; }
      b.disabled = false;
      if (r.refused) { busy = false; say(r.refused); return false; }
      var d = r.data;
      if (!Array.isArray(d.pieces) || d.depuis !== suite || typeof d.manifeste !== 'string') { busy = false; say(LOST); return false; }
      if (recu.fingerprint === null) recu.fingerprint = d.fingerprint;
      recu.lots.push({ depuis: d.depuis, manifeste: d.manifeste });
      clear(listEl);
      var chain = Promise.resolve();
      d.pieces.forEach(function (p) { chain = chain.then(function () { return stale() ? null : piece(p); }); });
      return chain.then(function () {
        busy = false;
        if (stale()) return false;
        suite = typeof d.suite === 'number' ? d.suite : null;
        if (suite === null) {
          b.disabled = true;
          say('Tous les fichiers sont passés : ' + counts() + '. Enregistrez les pièces de ce lot, puis le reçu.');
        } else {
          say('Lot tiré : ' + d.pieces.length + ' pièces. Enregistrez-les avant le lot suivant, qui les remplace à l’écran.');
        }
        return true;
      });
    });
  }
  function receipt() {
    if (!recu || !recu.lots.length) { say('Tirez d’abord un lot.'); return; }
    var r = { format: 'aimmo-reprise-recu/1', licenceId: doc.licenceId, fichier: recu.fingerprint, faitLe: new Date().toISOString(), complet: suite === null, lots: recu.lots, pieces: recu.pieces, comptes: recu.comptes };
    save([JSON.stringify(r)], 'aimmo-reprise-recu-' + r.faitLe.slice(0, 10) + '.json', 'application/json');
    say('Reçu enregistré sur cet appareil : ' + recu.pieces.length + ' pièces dites, sans aucun contenu.');
  }
  /* L'écran, sur le fichier de reprise tiré dans la séance ; un autre fichier recommence à zéro. Rouvert sur le même
     fichier, il garde le lot à l'écran, ses pièces à enregistrer et ses tranches à tirer. */
  var panel = null;
  function show(where, held) {
    clear(where);
    if (!held || typeof held !== 'object' || typeof held.licenceId !== 'string') {
      where.appendChild(el('p', 'Tirez d’abord le fichier de vos données : le contenu se tire sur lui.', 'etat'));
      return false;
    }
    if (held !== doc || stale() || !panel) {
      doc = held; owner = t.session(); suite = 0; busy = false; recu = { fingerprint: null, lots: [], pieces: [], comptes: {} };
      panel = el('div');
      panel.appendChild(el('p', 'Chaque pièce arrive avec son empreinte, refaite sur cet appareil avant d’être offerte. Chaque lot demande la preuve de la clé de cet appareil.', 'doux'));
      var b = button('Tirer le premier lot', function () { lot(b).then(function () { if (recu.lots.length) b.textContent = 'Tirer le lot suivant'; }); });
      panel.appendChild(b);
      panel.appendChild(button('Enregistrer le reçu', receipt));
      stateEl = el('p', '', 'etat');
      stateEl.setAttribute('role', 'status');
      panel.appendChild(stateEl);
      listEl = el('ul');
      panel.appendChild(listEl);
    }
    where.appendChild(panel);
    return true;
  }
  return { show: show };
};
`;
