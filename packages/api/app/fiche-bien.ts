import { AMENITIES, ENERGY_CLASSES, HEATING_KINDS, OUTDOOR_KINDS } from '../../core/src/annonces/fiche-bien.ts';
import type { PhotoSubject } from '../../core/src/diffusion/textes.ts';

/**
 * La fiche du bien à l'écran (X19), depuis « Mettre en vente » : ce que l'écran demandait de compléter sans donner de quoi
 * le faire. Script servi à part (`/app/fiche-bien.js`), chargé au premier geste pour tenir le budget [R201].
 *
 * Chaque enregistrement ajoute une version complète [R17] : les photos et vidéos rangées repartent telles quelles, et la
 * version lue est demandée au socle (`siVersion`), pour qu'une photo arrivée entre-temps ne soit jamais perdue. Un champ
 * vide reste « on ne sait pas » : rien n'est deviné [R10] ; 0 reste 0 (rez-de-chaussée, aucune charge). Une fiche sans
 * changement n'ajoute pas de version : une nouvelle version fait tomber l'annonce validée [R47].
 */
/** Ce qu'une photo peut montrer, à l'écran (AU114) : le code n'offre que ce que la fiche porte [R478]. */
const SUBJECTS: Record<PhotoSubject, string> = {
  piece_principale: 'Une pièce principale',
  chambre: 'Une chambre',
  cuisine: 'La cuisine',
  salle_de_bain: 'Une salle d’eau',
  toilettes: 'Les toilettes',
  entree: 'L’entrée',
  facade: 'La façade',
  balcon: 'Le balcon',
  terrasse: 'La terrasse',
  jardin: 'Le jardin',
  cour: 'La cour',
  terrain: 'Le terrain',
  stationnement: 'Le stationnement',
  ascenseur: 'L’ascenseur',
};

const HEATING: Record<(typeof HEATING_KINDS)[number], string> = {
  individuel_gaz: 'Individuel au gaz',
  individuel_electrique: 'Individuel électrique',
  collectif: 'Collectif',
  pompe_a_chaleur: 'Pompe à chaleur',
  bois: 'Bois',
  fioul: 'Fioul',
  autre: 'Autre',
};
const OUTDOOR: Record<(typeof OUTDOOR_KINDS)[number], string> = { balcon: 'Balcon', terrasse: 'Terrasse', jardin: 'Jardin', cour: 'Cour' };
/** AU061 · équipements et état, que l'annonce ne nomme que s'ils sont dits ici. */
const AMENITY: Record<(typeof AMENITIES)[number], string> = { piscine: 'Piscine', cave: 'Cave', cheminee: 'Cheminée', grenier: 'Grenier ou combles', veranda: 'Véranda', climatisation: 'Climatisation' };
/** AU063 · d'où vient chaque surface. */
const SURFACE_SOURCE: Record<string, string> = { mesurage: 'Mesurage d’un professionnel', acte: 'Acte de propriété', vendeur: 'Dite par le vendeur' };
const CONDITION: Record<string, string> = { '': 'Je ne sais pas', neuf: 'Neuf', refait_a_neuf: 'Refait à neuf', bon_etat: 'Bon état', travaux_a_prevoir: 'Travaux à prévoir', a_renover: 'À rénover' };

/** [clé rangée, libellé, groupe] des nombres de la fiche. */
const NUMBERS: readonly (readonly [string, string])[] = [
  ['bedrooms', 'Chambres'],
  ['floor', 'Étage (0 pour le rez-de-chaussée)'],
  ['floorsTotal', 'Étages de l’immeuble'],
  ['buildYear', 'Année de construction'],
  ['landM2', 'Terrain, en m²'],
  ['parkingSpaces', 'Places de stationnement'],
];

const LABELS: Record<string, string> = {
  'characteristics.bedrooms': 'Chambres',
  'characteristics.floor': 'Étage : il ne peut pas dépasser le nombre d’étages',
  'characteristics.floorsTotal': 'Étages de l’immeuble',
  'characteristics.buildYear': 'Année de construction',
  'characteristics.landM2': 'Terrain',
  'characteristics.parkingSpaces': 'Places de stationnement',
  'characteristics.dwelling': 'Logement : maison ou appartement',
  'characteristics.amenities': 'Équipements du bien',
  'characteristics.condition': 'État du bien',
  'characteristics.carrezM2': 'Surface Carrez : en m², au centième au plus',
  'characteristics.usableM2': 'Surface utile : en m², au centième au plus',
  'characteristics.surfaceSources': 'Source d’une surface : elle se dit pour une surface remplie',
  'energy.energyClass': 'Classe énergie du diagnostic',
  'energy.climateClass': 'Classe climat du diagnostic',
  'energy.annualCostMinEur': 'Coût annuel le plus bas du diagnostic, qui ne dépasse pas le plus haut',
  'energy.annualCostMaxEur': 'Coût annuel le plus haut du diagnostic',
  'energy.costReferenceYear': 'Année des prix de l’énergie du diagnostic',
  'energy.costReferenceYears': 'Années des prix de l’énergie : celles du diagnostic, qui se suivent',
  'energy.ademeNumber': 'Numéro ADEME du diagnostic : 13 chiffres et lettres',
  'energy.primaryEnergyKwhM2': 'Énergie primaire : un nombre entier de kWh/m²/an',
  'energy.ghgKgM2': 'Émissions : un nombre entier de kg CO₂/m²/an',
  'energy.diagnosedOn': 'Jour du diagnostic, jamais dans le futur',
  'coownership.lots': 'Nombre de lots de la copropriété',
  'coownership.annualChargesEur': 'Charges annuelles de la copropriété',
  'coownership.proceedings': 'Procédure en cours dans la copropriété',
};

export const FICHE_BIEN_SCRIPT = `'use strict';
globalThis.AIMMO_FICHE_BIEN = function (t) {
  var el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field, checkbox = t.checkbox;
  // AU105 · chaque champ dessiné est suivi : une saisie non enregistrée devient un brouillon de cet appareil.
  var tracking = null;
  function fieldT(box, id, label, kind) { var f = field(box, id, label, kind); if (tracking) tracking.push(f); return f; }
  function checkboxT(box, id, label) { var f = checkbox(box, id, label); if (tracking) tracking.push(f); return f; }
  // AU105 · les brouillons de cet appareil, rangés par ce qu'ils concernent ; la sortie les efface.
  var DRAFTS = 'aimmo.brouillons';
  function dAll() { try { var a = JSON.parse(localStorage.getItem(DRAFTS) || '{}'); return a && typeof a === 'object' && !Array.isArray(a) ? a : {}; } catch (e) { return {}; } }
  function dPut(a) { try { localStorage.setItem(DRAFTS, JSON.stringify(a)); return true; } catch (e) { return false; } }
  var drafts = {
    get: function (k) { var d = dAll()[k]; return d && typeof d === 'object' ? d : null; },
    set: function (k, v) { var a = dAll(); a[k] = { at: new Date().toISOString(), value: v }; return dPut(a); },
    drop: function (k) { var a = dAll(); if (k in a) { delete a[k]; dPut(a); } },
  };
  var HEATING = ${JSON.stringify(HEATING)}, OUTDOOR = ${JSON.stringify(OUTDOOR)}, AMENITY = ${JSON.stringify(AMENITY)}, CONDITION = ${JSON.stringify(CONDITION)}, SURFACE_SOURCE = ${JSON.stringify(SURFACE_SOURCE)}, NUMBERS = ${JSON.stringify(NUMBERS)}, LABELS = ${JSON.stringify(LABELS)}, CLASSES = ${JSON.stringify(ENERGY_CLASSES)}, SUBJECTS = ${JSON.stringify(SUBJECTS)};
  var YES_NO = { oui: 'Oui', non: 'Non' };
  var DWELLING = { house: 'Maison', apartment: 'Appartement' };
  function select(box, id, label, options, value) {
    var f = fieldT(box, id, label, 'select');
    var blank = el('option', 'Je ne sais pas encore');
    blank.setAttribute('value', '');
    f.appendChild(blank);
    Object.keys(options).forEach(function (k) {
      var o = el('option', options[k]);
      o.setAttribute('value', k);
      f.appendChild(o);
    });
    f.value = value === null || value === undefined ? '' : String(value);
    return f;
  }
  function yesNo(v) { return v === true ? 'oui' : v === false ? 'non' : ''; }
  function bool(v) { return v === 'oui' ? true : v === 'non' ? false : null; }
  function text(v) { return v === null || v === undefined ? '' : String(v); }
  function number(box, id, label, value) {
    var f = fieldT(box, id, label);
    f.setAttribute('inputmode', 'numeric');
    f.value = text(value);
    return f;
  }
  function draw(zone, o, version, sheet, resumed) {
    tracking = [];
    var c = sheet.characteristics || {}, e = sheet.energy || {}, k = sheet.coownership || {}, media = sheet.media || [];
    clear(zone);
    if (o.validated) zone.appendChild(el('p', 'Cette annonce est validée. Une nouvelle version de la fiche annule cette validation : au passage suivant, l’annonce est retirée de tous les canaux jusqu’à ce qu’un texte à jour soit validé.', 'retard'));
    zone.appendChild(el('p', 'Un champ vide reste « je ne sais pas » : rien n’est deviné.', 'doux'));
    var nums = {};
    NUMBERS.forEach(function (n) { nums[n[0]] = number(zone, 'fiche-bien-' + n[0], n[1], c[n[0]]); });
    var heating = select(zone, 'fiche-bien-chauffage', 'Chauffage', HEATING, c.heating);
    var elevator = select(zone, 'fiche-bien-ascenseur', 'Ascenseur', YES_NO, yesNo(c.elevator));
    // AU070 · une recherche de maison ne reçoit pas un appartement.
    var dwelling = select(zone, 'fiche-bien-logement', 'Logement : maison ou appartement', DWELLING, c.dwelling);
    var outs = {};
    Object.keys(OUTDOOR).forEach(function (kind) {
      outs[kind] = checkboxT(zone, 'fiche-bien-ext-' + kind, OUTDOOR[kind]);
      outs[kind].checked = (c.outdoor || []).indexOf(kind) >= 0;
    });
    var ams = {};
    Object.keys(AMENITY).forEach(function (kind) {
      ams[kind] = checkboxT(zone, 'fiche-bien-equip-' + kind, AMENITY[kind]);
      ams[kind].checked = (c.amenities || []).indexOf(kind) >= 0;
    });
    var condition = select(zone, 'fiche-bien-etat', 'État du bien', CONDITION, c.condition || '');
    // AU063 · les surfaces Carrez et utile, à côté de la surface habitable, chacune avec sa source.
    zone.appendChild(el('h4', 'Surfaces'));
    var srcs = c.surfaceSources || {};
    var surfaces = {
      carrez: fieldT(zone, 'fiche-bien-carrez', 'Surface Carrez (lot de copropriété), en m²'),
      utile: fieldT(zone, 'fiche-bien-utile', 'Surface utile (local, bureau), en m²'),
    };
    surfaces.carrez.setAttribute('inputmode', 'decimal');
    surfaces.utile.setAttribute('inputmode', 'decimal');
    surfaces.carrez.value = text(c.carrezM2).replace('.', ',');
    surfaces.utile.value = text(c.usableM2).replace('.', ',');
    var surfaceSrc = {
      habitable: select(zone, 'fiche-bien-source-habitable', 'Source de la surface habitable', SURFACE_SOURCE, srcs.habitable),
      carrez: select(zone, 'fiche-bien-source-carrez', 'Source de la surface Carrez', SURFACE_SOURCE, srcs.carrez),
      utile: select(zone, 'fiche-bien-source-utile', 'Source de la surface utile', SURFACE_SOURCE, srcs.utile),
    };
    zone.appendChild(el('h4', 'Diagnostic énergétique'));
    var classes = {};
    CLASSES.forEach(function (x) { classes[x] = x; });
    var energy = {
      energyClass: select(zone, 'fiche-bien-energie', 'Classe énergie', classes, e.energyClass),
      climateClass: select(zone, 'fiche-bien-climat', 'Classe climat', classes, e.climateClass),
      annualCostMinEur: number(zone, 'fiche-bien-cout-min', 'Coût annuel le plus bas, en euros', e.annualCostMinEur),
      annualCostMaxEur: number(zone, 'fiche-bien-cout-max', 'Coût annuel le plus haut, en euros', e.annualCostMaxEur),
      // AU065 · une année, ou celles que le diagnostic cite (« 2021, 2022, 2023 »), telles qu'il les écrit.
      costReferenceYear: fieldT(zone, 'fiche-bien-cout-annee', 'Année ou années des prix de l’énergie, comme sur le diagnostic'),
      diagnosedOn: fieldT(zone, 'fiche-bien-diagnostic', 'Jour du diagnostic'),
      // AU064 · repris du diagnostic pour les portails, sans ressaisie ensuite.
      ademeNumber: fieldT(zone, 'fiche-bien-dpe-numero', 'Numéro ADEME du diagnostic (13 caractères)'),
      primaryEnergyKwhM2: number(zone, 'fiche-bien-dpe-ep', 'Énergie primaire, en kWh/m²/an', e.primaryEnergyKwhM2),
      ghgKgM2: number(zone, 'fiche-bien-dpe-ges', 'Émissions, en kg CO₂/m²/an', e.ghgKgM2),
    };
    energy.ademeNumber.value = text(e.ademeNumber);
    energy.ademeNumber.setAttribute('autocapitalize', 'characters');
    energy.costReferenceYear.setAttribute('inputmode', 'numeric');
    energy.costReferenceYear.value = Array.isArray(e.costReferenceYears) && e.costReferenceYears.length > 1 ? e.costReferenceYears.join(', ') : text(e.costReferenceYear);
    energy.diagnosedOn.setAttribute('type', 'date');
    energy.diagnosedOn.value = text(e.diagnosedOn);
    zone.appendChild(el('h4', 'Copropriété et risques'));
    var isCo = select(zone, 'fiche-bien-copro', 'Le bien est en copropriété', YES_NO, sheet.coownership ? yesNo(k.isCoownership) : '');
    var lots = number(zone, 'fiche-bien-lots', 'Nombre de lots', k.lots);
    var charges = number(zone, 'fiche-bien-charges', 'Charges annuelles, en euros', k.annualChargesEur);
    var proceedings = select(zone, 'fiche-bien-procedure', 'Procédure en cours', YES_NO, yesNo(k.proceedings));
    var risk = select(zone, 'fiche-bien-risques', 'Le bien est en zone de risque', YES_NO, sheet.risks ? yesNo(sheet.risks.inRiskZone) : '');
    if (media.length) zone.appendChild(el('p', media.length + (media.length > 1 ? ' photos ou vidéos rangées restent' : ' photo ou vidéo rangée reste') + ' sur la fiche.', 'doux'));
    // AU114 · ce que montre chaque photo : sa légende sur la page publique, la fiche imprimable et les portails [R478].
    var shown = el('div');
    zone.appendChild(shown);
    function subjects() {
      clear(shown);
      return send(o.base + '/photos/sujets', 'GET').then(function (res) {
      if (res.gone) return;
      // Une lecture ratée est dite, avec de quoi réessayer : jamais confondue avec un bien sans photo.
      if (!res.ok || !res.body || !res.body.data) {
        shown.appendChild(el('p', res.offline ? 'Pas de réseau : ce que montre chaque photo n’a pas pu être lu.' : 'Ce que montre chaque photo n’a pas pu être lu.', 'alerte'));
        shown.appendChild(button('Réessayer', subjects));
        return;
      }
      if (!(res.body.data.photos || []).length) return;
      var allowed = {};
      (res.body.data.allowed || []).forEach(function (k) { if (SUBJECTS[k]) allowed[k] = SUBJECTS[k]; });
      shown.appendChild(el('h4', 'Ce que montre chaque photo'));
      res.body.data.photos.forEach(function (p, i) {
        var s = select(shown, 'fiche-bien-photo-' + (i + 1), 'Photo ' + (i + 1), allowed, p.subject);
        s.addEventListener('change', function () {
          send(o.base + '/photos/sujet', 'POST', { ref: p.ref, subject: s.value || null }).then(function (r) {
            said.textContent = r.ok ? 'Légende de la photo ' + (i + 1) + ' rangée.' : 'La légende n’est pas rangée.';
          });
        });
      });
      });
    }
    subjects();
    /** Lit le formulaire ; un nombre mal écrit est nommé, jamais rangé comme « je ne sais pas ». */
    function read() {
      var bad = null;
      function int(f, label) {
        var v = String(f.value || '').trim().replace(/\\s/g, '');
        if (v === '') return null;
        if (!/^-?\\d+$/.test(v)) { bad = bad || label; return null; }
        return Number(v);
      }
      var out = { bedrooms: null, floor: null, floorsTotal: null, buildYear: null, heating: heating.value || null, outdoor: Object.keys(OUTDOOR).filter(function (x) { return outs[x].checked; }), landM2: null, parkingSpaces: null, elevator: bool(elevator.value) };
      if (dwelling.value) out.dwelling = dwelling.value;
      var am = Object.keys(AMENITY).filter(function (x) { return ams[x].checked; });
      if (am.length) out.amenities = am;
      if (condition.value) out.condition = condition.value;
      function m2(f, label) {
        var v = String(f.value || '').trim().replace(/\\s/g, '').replace(',', '.');
        if (v === '') return null;
        if (!/^\\d+(\\.\\d{1,2})?$/.test(v) || Number(v) <= 0) { bad = bad || label; return null; }
        return Number(v);
      }
      var carrez = m2(surfaces.carrez, 'Surface Carrez'), utile = m2(surfaces.utile, 'Surface utile');
      if (carrez !== null) out.carrezM2 = carrez;
      if (utile !== null) out.usableM2 = utile;
      var ss = {};
      ['habitable', 'carrez', 'utile'].forEach(function (k) { if (surfaceSrc[k].value) ss[k] = surfaceSrc[k].value; });
      if (Object.keys(ss).length) out.surfaceSources = ss;
      NUMBERS.forEach(function (n) { out[n[0]] = int(nums[n[0]], n[1]); });
      var en = null;
      // AU064 · le numéro ADEME ou une valeur saisis seuls ouvrent aussi le diagnostic : il est contrôlé, jamais perdu.
      var costs = [energy.annualCostMinEur, energy.annualCostMaxEur, energy.costReferenceYear, energy.ademeNumber, energy.primaryEnergyKwhM2, energy.ghgKgM2];
      if (energy.energyClass.value || energy.climateClass.value || energy.diagnosedOn.value || costs.some(function (f) { return String(f.value || '').trim() !== ''; })) {
        en = {
          energyClass: energy.energyClass.value,
          climateClass: energy.climateClass.value,
          annualCostMinEur: int(energy.annualCostMinEur, 'Coût annuel le plus bas'),
          annualCostMaxEur: int(energy.annualCostMaxEur, 'Coût annuel le plus haut'),
          diagnosedOn: energy.diagnosedOn.value,
        };
        var num = String(energy.ademeNumber.value || '').replace(/\\s/g, '').toUpperCase();
        if (num) en.ademeNumber = num;
        ['primaryEnergyKwhM2', 'ghgKgM2'].forEach(function (k) { if (String(energy[k].value || '').trim() !== '') en[k] = int(energy[k], k === 'ghgKgM2' ? 'Émissions' : 'Énergie primaire'); });
        if (e.documentRef) en.documentRef = e.documentRef;
        var ys = String(energy.costReferenceYear.value || '').split(/[^0-9]+/).filter(Boolean).map(Number);
        if (!ys.length) bad = bad || 'Année des prix de l’énergie';
        en.costReferenceYear = ys.length ? ys[ys.length - 1] : null;
        if (ys.length > 1) en.costReferenceYears = ys;
      }
      var co = null;
      if (isCo.value === 'non') co = { isCoownership: false };
      if (isCo.value === 'oui') co = { isCoownership: true, lots: int(lots, 'Nombre de lots'), annualChargesEur: int(charges, 'Charges annuelles'), proceedings: bool(proceedings.value) };
      // Des lots ou des charges sans « oui » ne se perdent pas en silence.
      var loose = isCo.value !== 'oui' && (String(lots.value || '').trim() !== '' || String(charges.value || '').trim() !== '' || proceedings.value !== '');
      return { bad: bad, loose: loose, sheet: { characteristics: out, energy: en, coownership: co, risks: risk.value ? { inRiskZone: risk.value === 'oui' } : null, media: media } };
    }
    var said = el('p', null, 'doux');
    said.setAttribute('role', 'status');
    // Le point de départ est la fiche rangée : un brouillon repris ne devient pas la version lue.
    var start = resumed ? resumed.start : JSON.stringify(read().sheet);
    var key = 'fiche-bien:' + o.base;
    var fields = tracking;
    tracking = null;
    function keep() {
      var now = read().sheet, text = JSON.stringify(now);
      if (text === start) drafts.drop(key); else drafts.set(key, { version: version, start: start, sheet: now });
    }
    fields.forEach(function (f) { f.addEventListener('input', keep); f.addEventListener('change', keep); });
    var kept = resumed ? null : drafts.get(key);
    if (kept && kept.value && kept.value.sheet && kept.value.start !== JSON.stringify(kept.value.sheet)) {
      var note = el('div', null, 'retard');
      note.setAttribute('role', 'status');
      var same = Number(kept.value.version) === version;
      note.appendChild(el('p', same ? 'Une saisie de cette fiche n’a pas été enregistrée sur cet appareil.' : 'Une saisie de cette fiche n’a pas été enregistrée sur cet appareil, mais la fiche a changé depuis : la reprendre repart de la version rangée, relisez chaque champ.'));
      note.appendChild(button('Reprendre la saisie', function () { draw(zone, o, version, kept.value.sheet, { start: same ? kept.value.start : start }); }));
      note.appendChild(button('Abandonner la saisie', function () { drafts.drop(key); zone.removeChild(note); }));
      zone.insertBefore(note, zone.firstChild);
    }
    var go = button('Enregistrer la fiche', function () {
      if (t.sending()) return;
      var form = read();
      if (form.bad) { said.textContent = 'À vérifier : ' + form.bad + ', un nombre entier sans lettre.'; return; }
      if (form.loose) { said.textContent = 'À vérifier : les lots, les charges et la procédure vont avec « en copropriété : oui ». Choisissez oui, ou videz-les.'; return; }
      if (JSON.stringify(form.sheet) === start) { said.textContent = 'Rien n’a changé : aucune version ajoutée.'; return; }
      var mine = t.current();
      t.sending(true);
      go.disabled = true;
      said.textContent = 'Envoi…';
      return send(o.base + '/fiche?siVersion=' + version, 'POST', form.sheet).then(function (res) {
        t.sending(false);
        if (res.gone) return false;
        go.disabled = false;
        // Coupée ou en panne, la réponse ne dit pas si la version a été rangée.
        if (res.offline || res.status >= 500 || !res.body) { said.textContent = 'Réponse perdue : la fiche a peut-être été rangée. Rouvrez-la pour le voir, ce que vous avez saisi reste ici.'; return false; }
        if (res.status === 403) { said.textContent = 'Ce bien n’est pas dans vos droits.'; return false; }
        if (!res.ok) {
          var code = res.body.code;
          said.textContent = code === 'invalid' ? (LABELS[res.body.field] ? 'À vérifier : ' + LABELS[res.body.field] + '.' : 'Une valeur de la fiche est refusée : rien n’est rangé.')
            : code === 'stale' ? 'La fiche a changé entre-temps, rien n’est rangé : rouvrez-la pour repartir de la dernière version.'
            : code === 'busy' ? 'Un enregistrement est déjà en cours : réessayez dans un instant.'
            : 'La fiche n’a pas pu être rangée.';
          return false;
        }
        drafts.drop(key);
        return t.saved(mine, res.body.data && res.body.data.version);
      });
    });
    zone.appendChild(go);
    zone.appendChild(said);
  }
  return {
    open: function (zone, o) {
      var mine = t.current();
      clear(zone);
      var said = el('p', 'Chargement…', 'doux');
      said.setAttribute('role', 'status');
      zone.appendChild(said);
      return send(o.base + '/fiche', 'GET').then(function (res) {
        if (res.gone || mine !== t.current()) return false;
        // Une lecture ratée n'ouvre pas de formulaire vide : l'enregistrer effacerait ce qui est rangé.
        if (res.offline) { said.textContent = 'Pas de réseau. Réessayez dans un moment.'; return false; }
        if (res.status === 403) { said.textContent = 'Ce bien n’est pas dans vos droits.'; return false; }
        if (res.status === 404 && res.body && res.body.code === 'no_sheet') { draw(zone, o, 0, {}); return true; }
        if (!res.ok || !res.body.data || !res.body.data.sheet) { said.textContent = 'La fiche n’a pas pu être lue. Réessayez dans un moment.'; return false; }
        draw(zone, o, Number(res.body.data.version), res.body.data.sheet);
        return true;
      });
    },
  };
};
`;
