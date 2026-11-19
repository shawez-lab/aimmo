/**
 * Les champs de l'encadrement des loyers (AU015), servis à part (`/app/louer-loyer.js`) et chargés au premier
 * geste, pour que l'écran « Louer » tienne son budget [R201]. L'agent recopie ce qu'il a lu dans l'arrêté préfectoral
 * pour ce logement ; le code calcule le plafond et le contrôle (W01). Rien n'est gardé sur l'appareil.
 */
export const LOUER_LOYER_SCRIPT = `'use strict';
globalThis.AIMMO_LOUER_LOYER = function (t) {
  var el = t.el, field = t.field, say = t.say;
  var seq = 0;
  // « 24,50 » ou « 24.5 » en centimes ; null si ce n'est pas un montant.
  function cents(v) {
    var s = String(v || '').trim().replace(/\\s/g, '').replace(',', '.');
    if (!/^\\d+(\\.\\d{1,2})?$/.test(s)) return null;
    return Math.round(Number(s) * 100);
  }
  function text(c) { return typeof c === 'number' ? (c / 100).toFixed(2).replace('.', ',').replace(/,00$/, '') : ''; }
  /** Ajoute les champs à la boîte des faits ; rend la lecture : l'encadrement, undefined s'il est vidé, false si mal saisi. */
  function form(box, f) {
    var n = ++seq;
    var rc = (f && f.rentControl) || null;
    var d = el('fieldset');
    d.appendChild(el('legend', 'Encadrement des loyers : ce que dit l’arrêté pour ce logement'));
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
      ref.value = text(rc.referenceCentsPerM2);
      maj.value = text(rc.majoredCentsPerM2);
      comp.value = text(rc.complementCents);
      why.value = rc.complementReason || '';
    }
    box.appendChild(d);
    return function () {
      if (!decree.value.trim()) return undefined;
      var out = { decree: decree.value.trim(), readOn: on.value, referenceCentsPerM2: cents(ref.value), majoredCentsPerM2: cents(maj.value), complementCents: comp.value.trim() ? cents(comp.value) : 0, complementReason: why.value.trim() || null };
      if (!out.readOn || out.referenceCentsPerM2 === null || out.majoredCentsPerM2 === null || out.complementCents === null) { say('Encadrement : l’arrêté, le jour de lecture et des montants en euros.'); return false; }
      return out;
    };
  }
  return { form: form };
};
`.replace(/^[ \t]*(?:\/\/.*|\/\*.*\*\/)[ \t]*\n/gm, '');
