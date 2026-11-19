import { RENTAL_ENERGY_CLASSES } from '../../core/src/location/index.ts';

/**
 * Les faits du logement à louer (W01), servis à part (`/app/louer-faits.js`) et chargés au geste « Saisir » ou
 * « Corriger les faits », pour que l'écran « Louer » tienne son budget [R201]. Dans une commune à loyer encadré, l'agent
 * y recopie aussi ce que dit l'arrêté préfectoral pour ce logement (AU015) ; le code calcule le plafond et le contrôle.
 * Rien n'est gardé sur l'appareil.
 */
export const LOUER_FAITS_SCRIPT = `'use strict';
globalThis.AIMMO_LOUER_FAITS = function (t) {
  var el = t.el, field = t.field, select = t.select, checkbox = t.checkbox, button = t.button, whole = t.whole, toCents = t.toCents, centsText = t.centsText, say = t.say, act = t.act;
  var CLASSES = ${JSON.stringify(RENTAL_ENERGY_CLASSES)};
  var GAS = { aucune: 'Pas d’installation de gaz', moins_de_15_ans: 'Gaz, installation de moins de 15 ans', plus_de_15_ans: 'Gaz, installation de plus de 15 ans' };
  var seq = 0;
  /** L'encadrement lu dans l'arrêté ; rend la lecture : l'encadrement, undefined s'il est vidé, false si mal saisi. */
  function rentControlForm(box, f) {
    var n = ++seq;
    var rc = (f && f.rentControl) || null;
    var d = t.details(box, 'Commune à loyer encadré : ce que dit l’arrêté pour ce logement');
    if (rc) d.setAttribute('open', '');
    var decree = field(d, 'enc-arrete-' + n, 'Arrêté préfectoral lu (référence)');
    var on = field(d, 'enc-lu-' + n, 'Lu le');
    on.setAttribute('type', 'date');
    var ref = field(d, 'enc-ref-' + n, 'Loyer de référence, en euros par m² et par mois');
    var maj = field(d, 'enc-maj-' + n, 'Loyer de référence majoré, en euros par m² et par mois');
    var comp = field(d, 'enc-comp-' + n, 'Complément de loyer, en euros par mois (0 sans complément)');
    var why = field(d, 'enc-motif-' + n, 'Ce qui justifie le complément (localisation, confort)');
    [ref, maj, comp].forEach(function (x) { x.setAttribute('inputmode', 'decimal'); x.setAttribute('autocomplete', 'off'); });
    if (rc) {
      decree.value = rc.decree;
      on.value = rc.readOn;
      ref.value = centsText(rc.referenceCentsPerM2);
      maj.value = centsText(rc.majoredCentsPerM2);
      comp.value = centsText(rc.complementCents);
      why.value = rc.complementReason || '';
    }
    return function () {
      if (!decree.value.trim()) return undefined;
      var out = { decree: decree.value.trim(), readOn: on.value, referenceCentsPerM2: toCents(ref.value), majoredCentsPerM2: toCents(maj.value), complementCents: comp.value.trim() ? toCents(comp.value) : 0, complementReason: why.value.trim() || null };
      if (!out.readOn || out.referenceCentsPerM2 === null || out.majoredCentsPerM2 === null || out.complementCents === null) { say('Encadrement : l’arrêté, le jour de lecture et des montants en euros.'); return false; }
      return out;
    };
  }
  function form(box, base, f) {
    var n = ++seq;
    var d = box;
    var furnished = select(d, 'meuble-' + n, 'Location', { vide: 'Vide', meuble: 'Meublée' }, f && f.furnished ? 'meuble' : 'vide');
    var rent = field(d, 'loyer-' + n, 'Loyer hors charges, en euros par mois');
    var charges = field(d, 'charges-' + n, 'Charges, en euros par mois');
    var mode = select(d, 'mode-' + n, 'Les charges sont', { provision: 'Une provision, régularisée chaque année', forfait: 'Un forfait (meublé seulement)' }, (f && f.chargesMode) || 'provision');
    var area = field(d, 'surface-' + n, 'Surface habitable, en m²');
    var room = field(d, 'piece-' + n, 'Pièce principale, en m²');
    var height = field(d, 'hauteur-' + n, 'Hauteur sous plafond, en m');
    var volume = field(d, 'volume-' + n, 'Volume habitable, en m³');
    var prev = field(d, 'prec-' + n, 'Loyer du locataire précédent, hors charges, en euros, ou « aucun »');
    var localRef = field(d, 'rsd-' + n, 'Règle locale lue');
    var localDay = field(d, 'rsd-j-' + n, 'Lue le');
    localDay.type = 'date';
    var localOk = checkbox(d, 'rsd-ok-' + n, 'Respectée');
    var cls = select(d, 'classe-' + n, 'Classe énergie du DPE', CLASSES.reduce(function (o, k) { o[k] = k; return o; }, {}), (f && f.energyClass) || 'D');
    var kwh = field(d, 'kwh-' + n, 'Consommation en énergie finale, kWh/m²/an');
    var year = field(d, 'annee-' + n, 'Année de construction');
    var elec = checkbox(d, 'elec-' + n, 'Installation électrique de plus de 15 ans');
    var gas = select(d, 'gaz-' + n, 'Gaz', GAS, (f && f.gas) || 'aucune');
    var start = field(d, 'debut-' + n, 'Début du bail envisagé');
    start.setAttribute('type', 'date');
    [rent, charges, area, room, height, volume, kwh, year].forEach(function (x) { x.setAttribute('inputmode', 'decimal'); x.setAttribute('autocomplete', 'off'); });
    if (f) {
      rent.value = centsText(f.rentCents);
      charges.value = centsText(f.chargesCents);
      area.value = String(f.livingAreaHundredths / 100).replace('.', ',');
      if (f.mainRoomHundredths) room.value = String(f.mainRoomHundredths / 100).replace('.', ',');
      if (f.ceilingHeightCm) height.value = String(f.ceilingHeightCm / 100).replace('.', ',');
      prev.value = f.firstLetting ? 'aucun' : centsText(f.previousRentCents);
      if (f.localRules) { localRef.value = f.localRules.reference; localDay.value = f.localRules.checkedOn; localOk.checked = !!f.localRules.compliant; }
      if (f.habitableVolumeHundredths) volume.value = String(f.habitableVolumeHundredths / 100).replace('.', ',');
      kwh.value = String(f.finalEnergyKwh);
      year.value = String(f.buildYear);
      elec.checked = !!f.electricityOver15;
      start.value = f.leaseStart;
    }
    var rc = rentControlForm(d, f);
    d.appendChild(button('Ranger les faits', function () {
      var a = toCents(area.value);
      var dims = { mainRoomHundredths: room, ceilingHeightCm: height, habitableVolumeHundredths: volume }, bad = false;
      var b = { furnished: furnished.value === 'meuble', rentCents: toCents(rent.value), chargesCents: toCents(charges.value), livingAreaHundredths: a, energyClass: cls.value, finalEnergyKwh: whole(kwh.value, 10000), buildYear: whole(year.value, 2100), electricityOver15: !!elec.checked, gas: gas.value, leaseStart: start.value, chargesMode: mode.value };
      Object.keys(dims).forEach(function (k) { var t = dims[k].value.trim(); if (t) { var c = toCents(t); if (c === null) bad = true; else b[k] = c; } });
      if (bad) { say('Dimensions : des nombres.'); return; }
      var pv = prev.value.trim().toLowerCase();
      if (pv === 'aucun') b.firstLetting = true; else if (pv) { b.previousRentCents = toCents(pv); if (b.previousRentCents === null) { say('Loyer précédent : un nombre, ou « aucun ».'); return; } }
      if (localRef.value.trim()) b.localRules = { reference: localRef.value.trim(), checkedOn: localDay.value, compliant: !!localOk.checked };
      var r = rc();
      if (r === false) return;
      if (r) b.rentControl = r;
      if (b.rentCents === null || b.chargesCents === null || a === null || b.finalEnergyKwh === null || b.buildYear === null || !start.value) { say('Remplissez chaque champ : des nombres, et la date du bail.'); return; }
      act(base + '/faits', b, 'Les faits ne sont pas rangés.', 'Faits rangés : contrôlez de nouveau le logement.');
    }));
    return d;
  }
  return { form: form };
};
`.replace(/^[ \t]*(?:\/\/.*|\/\*.*\*\/)[ \t]*\n/gm, '');
