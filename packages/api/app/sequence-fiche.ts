/**
 * La préparation d'une séquence de prospection depuis la fiche (BR34) [R300, R301, R302, R201], servie à part
 * (`/app/sequence-fiche.js`) et chargée au premier geste depuis le bloc de la fiche (`/app/biens-fiche.js`) :
 * l'application ne grossit pas. L'écran n'écrit que par `POST /v1/sequences` ; il ne fait que les contrôles de saisie
 * que le serveur refait. Rien ne part d'ici : les mails et SMS partent à leur jour par le contrôle central, les autres
 * étapes reviennent dans le plan du jour. Un refus se dit en mots, jamais par son code.
 */
export const SEQUENCE_CHANNEL_LABELS: Readonly<Record<string, string>> = Object.freeze({
  letter: 'Courrier',
  door: 'Passage à la porte',
  phone: 'Appel',
  email: 'Mail',
  sms: 'SMS',
});

export const SEQUENCE_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  steps_count: 'Une séquence a de une à huit étapes.',
  channel: 'Choisissez le canal de chaque étape.',
  after_days: 'Chaque jour va de 0 à 90, jamais avant celui de l’étape d’avant.',
  text: 'Un mail ou un SMS demande votre texte, 1 000 caractères au plus ; les autres étapes n’en ont pas.',
  already_active: 'Une séquence est déjà en cours pour cette personne : elle va jusqu’au bout ou s’arrête seule à sa réponse.',
  opposition_reply: 'Cette personne a déjà répondu : une séquence ne lui est pas préparée.',
  opposition_excluded: 'Cette personne est exclue des contacts : aucune séquence.',
  opposition_withdrawn: 'Cette personne a retiré son accord : aucune séquence.',
  opposition_call_refused: 'Cette personne a refusé un appel récemment : aucune séquence.',
  opposition_opposition_list: 'Ce numéro est sur la liste d’opposition au démarchage : aucune séquence.',
  opposition_reassigned: 'Cette fiche est suivie par un autre agent.',
  opposition_agent_gone: 'Votre compte d’agent n’est plus actif.',
  opposition_merged: 'Cette fiche a été réunie à une autre : ouvrez la fiche réunie.',
  not_assigned: 'Cette fiche est suivie par un autre agent.',
  agent_inactive: 'Votre compte d’agent n’est pas actif : la séquence n’est pas préparée.',
  role: 'Ce geste n’est pas dans vos droits.',
  unknown: 'Cette fiche n’existe plus.',
  invalid_body: 'Vos textes sont trop longs ensemble pour une seule séquence : raccourcissez-les, puis réessayez.',
});

export const SEQUENCE_FICHE_SCRIPT = `'use strict';
globalThis.AIMMO_SEQUENCE_FICHE = function (t) {
  var el = t.el;
  var LABELS = ${JSON.stringify(SEQUENCE_CHANNEL_LABELS)};
  var REFUSALS = ${JSON.stringify(SEQUENCE_REFUSALS)};
  var MAX = 8, LAST_DAY = 90, MAX_TEXT = 1000, MAX_BYTES = 16384;
  function bytes(x) { return encodeURIComponent(x).replace(/%[0-9A-F]{2}/g, 'x').length; }
  var LOST = 'La réponse n’est pas arrivée : la séquence est peut-être préparée. Réessayer ne la doublera pas, une seconde serait refusée.';
  function written(c) { return c === 'email' || c === 'sms'; }
  function input(box, id, label, tag) {
    var l = el('label', label);
    l.setAttribute('for', id);
    var i = el(tag || 'input');
    i.setAttribute('id', id);
    box.appendChild(l);
    box.appendChild(i);
    return i;
  }
  return function (box, personId) {
    var id = t.cSeq();
    var state = t.cState();
    var rows = [], made = 0;
    var list = el('ol', null, 'liste');
    var form = el('div', null, 'decision');
    box.appendChild(el('p', 'Rien ne part d’ici. Les mails et SMS partent seuls à leur jour, par le contrôle central, aux heures permises ; appels, courriers et passages vous attendent dans le plan du jour. Tout s’arrête de soi-même à la première réponse ou opposition.', 'doux'));
    form.appendChild(list);
    function draw() {
      while (list.firstChild) list.removeChild(list.firstChild);
      rows.forEach(function (r, n) {
        var li = el('li');
        li.appendChild(el('p', 'Étape ' + (n + 1)));
        li.appendChild(r.box);
        if (rows.length > 1) li.appendChild(t.accordButton('Retirer cette étape', function () {
          rows.splice(rows.indexOf(r), 1);
          draw();
          return Promise.resolve(true);
        }));
        list.appendChild(li);
      });
      more.disabled = rows.length >= MAX;
    }
    function addRow(channel, day) {
      made += 1;
      var k = id + '-' + made;
      var r = { box: el('div') };
      r.channel = t.cSelect(r.box, k + '-canal', 'Canal', LABELS, channel);
      r.day = input(r.box, k + '-jour', 'Jour après le départ (0 = aujourd’hui, 90 au plus)');
      r.day.setAttribute('inputmode', 'numeric');
      r.day.value = String(day);
      r.textBox = el('div');
      r.box.appendChild(r.textBox);
      r.text = null;
      function sync() {
        if (written(r.channel.value) && !r.text) {
          r.text = input(r.textBox, k + '-texte', 'Votre texte, tel qu’il partira (1 000 caractères au plus)', 'textarea');
          r.text.setAttribute('maxlength', String(MAX_TEXT));
        } else if (!written(r.channel.value) && r.text) {
          while (r.textBox.firstChild) r.textBox.removeChild(r.textBox.firstChild);
          r.text = null;
        }
      }
      r.channel.addEventListener('change', sync);
      sync();
      rows.push(r);
    }
    var more = el('button', 'Ajouter une étape', 'secondaire');
    more.setAttribute('type', 'button');
    more.addEventListener('click', function () {
      if (rows.length >= MAX) return;
      var last = rows[rows.length - 1];
      var d = last ? Number(String(last.day.value).trim()) : 0;
      addRow('letter', Number.isInteger(d) ? Math.min(d + 3, LAST_DAY) : 0);
      draw();
    });
    form.appendChild(more);
    addRow('letter', 0);
    draw();
    function read() {
      var steps = [], previous = 0;
      if (rows.length < 1 || rows.length > MAX) return REFUSALS.steps_count;
      for (var n = 0; n < rows.length; n++) {
        var r = rows[n];
        if (!LABELS[r.channel.value]) return REFUSALS.channel;
        var raw = String(r.day.value).trim();
        var day = /^[0-9]{1,2}$/.test(raw) ? Number(raw) : NaN;
        if (!(day >= previous && day <= LAST_DAY)) return 'Étape ' + (n + 1) + ' : ' + REFUSALS.after_days;
        previous = day;
        var step = { channel: r.channel.value, afterDays: day };
        if (written(r.channel.value)) {
          var text = String(r.text ? r.text.value : '').trim();
          if (!text || text.length > MAX_TEXT) return 'Étape ' + (n + 1) + ' : ' + REFUSALS.text;
          step.text = text;
        }
        steps.push(step);
      }
      return steps;
    }
    form.appendChild(t.accordButton('Préparer la séquence', function () {
      var steps = read();
      if (typeof steps === 'string') { state.textContent = steps; return Promise.resolve(false); }
      var payload = { personId: personId, steps: steps };
      if (bytes(JSON.stringify(payload)) > MAX_BYTES) { state.textContent = REFUSALS.invalid_body; return Promise.resolve(false); }
      state.textContent = 'Préparation…';
      return t.send('/v1/sequences', 'POST', payload).then(function (res) {
        if (res.gone) return false;
        if (res.ok) {
          while (box.firstChild) box.removeChild(box.firstChild);
          box.appendChild(el('p', 'Séquence préparée, ' + steps.length + ' étape(s), en mode essai : rien n’est parti. Les étapes à faire de votre main viendront à leur jour dans le plan du jour.', 'fait'));
          return true;
        }
        var code = res.body && res.body.code;
        if (REFUSALS[code]) { state.textContent = REFUSALS[code]; return false; }
        if (res.offline || !res.body || res.status >= 500) { state.textContent = LOST; return false; }
        state.textContent = res.status === 403 ? REFUSALS.role : 'La séquence n’est pas préparée : relisez les étapes, puis réessayez.';
        return false;
      });
    }));
    form.appendChild(state);
    box.appendChild(form);
  };
};
`.replace(/^[ \t]*(?:\/\/.*|\/\*.*\*\/)[ \t]*\n/gm, '');
