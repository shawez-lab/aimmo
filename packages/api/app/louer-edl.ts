import { ELEMENT_STATES, METER_KINDS } from '../../core/src/location/index.ts';

/**
 * Le formulaire de l'état des lieux d'entrée (M15), servi à part (`/app/louer-edl.js`) et chargé au premier geste, pour
 * que l'écran « Louer » tienne son budget [R201]. Aucun état n'est choisi d'avance [R106] ; rien n'est gardé sur l'appareil.
 */
export const LOUER_EDL_SCRIPT = `'use strict';
globalThis.AIMMO_LOUER_EDL = function (t) {
  var $ = t.$, el = t.el, button = t.button, field = t.field, select = t.select, whole = t.whole, ID = t.ID, say = t.say, act = t.act, openLocation = t.openLocation;
  var ELEMENT_STATES = ${JSON.stringify(ELEMENT_STATES)};
  var METERS = ${JSON.stringify(METER_KINDS)};
  var seq = 0;
  function form(box, id, base, p) {
    var n = ++seq;
    var d = box;
    var address = field(d, 'edl-adresse-' + n, 'Adresse du logement');
    var owner = field(d, 'edl-domicile-' + n, 'Domicile du bailleur');
    var rooms = [];
    var roomsBox = el('div');
    d.appendChild(roomsBox);
    function addRoom(name) {
      var k = rooms.length + 1;
      var r = el('fieldset', null, 'piece');
      r.appendChild(el('legend', 'Pièce ' + k));
      var nm = field(r, 'edl-' + n + '-piece-' + k, 'Nom de la pièce');
      nm.value = name || '';
      var items = [];
      var list = el('div');
      r.appendChild(list);
      function addItem(label) {
        var j = items.length + 1;
        var row = el('div', null, 'ligne');
        var a = el('div');
        var b = el('div');
        var what = field(a, 'edl-' + n + '-' + k + '-el-' + j, 'Élément');
        what.value = label || '';
        // Aucun état n'est choisi d'avance : il est constaté, jamais supposé.
        var states = { '': 'À constater' };
        Object.keys(ELEMENT_STATES).forEach(function (s) { states[s] = ELEMENT_STATES[s]; });
        var st = select(b, 'edl-' + n + '-' + k + '-etat-' + j, 'État', states, '');
        row.appendChild(a);
        row.appendChild(b);
        list.appendChild(row);
        items.push([what, st]);
      }
      ['Sol', 'Murs', 'Plafond', 'Fenêtres', 'Portes'].forEach(addItem);
      var more = button('Ajouter un élément', function () { addItem(''); });
      more.className = 'secondaire';
      r.appendChild(more);
      var dict = field(r, 'edl-' + n + '-dicte-' + k, 'Observations dictées (l’IA ne fait que les mettre en forme)', 'textarea');
      dict.setAttribute('rows', '3');
      dict.setAttribute('maxlength', '4000');
      roomsBox.appendChild(r);
      rooms.push({ name: nm, items: items, dict: dict });
    }
    addRoom('Entrée');
    var plus = button('Ajouter une pièce', function () { addRoom(''); });
    plus.className = 'secondaire';
    d.appendChild(plus);
    d.appendChild(el('h4', 'Compteurs'));
    var meters = Object.keys(METERS).map(function (kind) {
      var f = field(d, 'edl-' + n + '-compteur-' + kind, METERS[kind] + ' : index relevé');
      f.setAttribute('inputmode', 'decimal');
      return [kind, f];
    });
    d.appendChild(el('h4', 'Clés remises'));
    var keys = [];
    var keysBox = el('div');
    d.appendChild(keysBox);
    function addKey() {
      var j = keys.length + 1;
      var row = el('div', null, 'ligne');
      var a = el('div');
      var b = el('div');
      var kind = field(a, 'edl-' + n + '-cle-' + j, 'Clé ou badge');
      var count = field(b, 'edl-' + n + '-cles-' + j, 'Nombre');
      count.setAttribute('inputmode', 'numeric');
      row.appendChild(a);
      row.appendChild(b);
      keysBox.appendChild(row);
      keys.push([kind, count]);
    }
    addKey();
    var moreKey = button('Ajouter des clés', addKey);
    moreKey.className = 'secondaire';
    d.appendChild(moreKey);
    var furniture = [];
    if (p.facts && p.facts.furnished) {
      d.appendChild(el('h4', 'Mobilier'));
      var fBox = el('div');
      d.appendChild(fBox);
      var addFurniture = function () {
        var j = furniture.length + 1;
        var row = el('div', null, 'ligne');
        var a = el('div');
        var b = el('div');
        var c = el('div');
        var item = field(a, 'edl-' + n + '-meuble-' + j, 'Meuble');
        var count = field(b, 'edl-' + n + '-meubles-' + j, 'Nombre');
        count.setAttribute('inputmode', 'numeric');
        var states = { '': 'À constater' };
        Object.keys(ELEMENT_STATES).forEach(function (s) { states[s] = ELEMENT_STATES[s]; });
        var st = select(c, 'edl-' + n + '-meuble-etat-' + j, 'État', states, '');
        row.appendChild(a);
        row.appendChild(b);
        row.appendChild(c);
        fBox.appendChild(row);
        furniture.push([item, count, st]);
      };
      addFurniture();
      var moreF = button('Ajouter un meuble', addFurniture);
      moreF.className = 'secondaire';
      d.appendChild(moreF);
    }
    d.appendChild(button('Ranger l’état des lieux', function () {
      var problem = '';
      var b = { rooms: [], meters: [], keys: [], furniture: [] };
      var a1 = String(address.value || '').trim();
      var a2 = String(owner.value || '').trim();
      if (a1) b.address = a1;
      if (a2) b.ownerAddress = a2;
      rooms.forEach(function (r) {
        var name = String(r.name.value || '').trim();
        var els = [];
        r.items.forEach(function (x) {
          var w = String(x[0].value || '').trim();
          if (!w) return;
          if (!x[1].value) problem = 'Constatez l’état de chaque élément, ou retirez son nom.';
          els.push({ name: w, state: x[1].value });
        });
        var dict = String(r.dict.value || '').trim();
        if (!name && !els.length && !dict) return;
        if (!name) problem = 'Donnez un nom à chaque pièce.';
        b.rooms.push({ name: name, elements: els, dictation: dict || null });
      });
      meters.forEach(function (m) { var v = String(m[1].value || '').trim(); if (v) b.meters.push({ kind: m[0], index: v }); });
      keys.forEach(function (k) {
        var kind = String(k[0].value || '').trim();
        if (!kind && !String(k[1].value || '').trim()) return;
        var c = whole(k[1].value, 50);
        if (!kind || !c) problem = 'Pour les clés : une sorte et un nombre.';
        b.keys.push({ kind: kind, count: c });
      });
      furniture.forEach(function (f) {
        var item = String(f[0].value || '').trim();
        if (!item) return;
        var c = whole(f[1].value, 99);
        if (!c || !f[2].value) problem = 'Pour chaque meuble : un nombre et son état constaté.';
        b.furniture.push({ item: item, count: c, state: f[2].value });
      });
      if (problem) { say(problem); return; }
      act(base + '/etat-des-lieux', b, 'L’état des lieux n’est pas rangé.', '', true).then(function (inv) {
        if (!inv || !ID.test(inv.inventoryId)) return;
        openLocation(id, $('louer-titre').textContent, inv.status === 'complet' ? 'État des lieux rangé, complet : relisez-le avec les deux parties, puis signez.' : 'État des lieux rangé, incomplet : ' + (inv.missing || []).join(', ') + '.');
      });
    }));
  }
  return { form: form };
};
`.replace(/^[ \t]*(?:\/\/.*|\/\*.*\*\/)[ \t]*\n/gm, '');
