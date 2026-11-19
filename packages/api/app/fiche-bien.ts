import { ENERGY_CLASSES, HEATING_KINDS, OUTDOOR_KINDS } from '../../core/src/annonces/fiche-bien.ts';
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
  'energy.energyClass': 'Classe énergie du diagnostic',
  'energy.climateClass': 'Classe climat du diagnostic',
  'energy.annualCostMinEur': 'Coût annuel le plus bas du diagnostic, qui ne dépasse pas le plus haut',
  'energy.annualCostMaxEur': 'Coût annuel le plus haut du diagnostic',
  'energy.costReferenceYear': 'Année des prix de l’énergie du diagnostic',
  'energy.diagnosedOn': 'Jour du diagnostic, jamais dans le futur',
  'coownership.lots': 'Nombre de lots de la copropriété',
  'coownership.annualChargesEur': 'Charges annuelles de la copropriété',
  'coownership.proceedings': 'Procédure en cours dans la copropriété',
};

export const FICHE_BIEN_SCRIPT = `'use strict';
globalThis.AIMMO_FICHE_BIEN = function (t) {
  var el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field, checkbox = t.checkbox;
  var HEATING = ${JSON.stringify(HEATING)}, OUTDOOR = ${JSON.stringify(OUTDOOR)}, NUMBERS = ${JSON.stringify(NUMBERS)}, LABELS = ${JSON.stringify(LABELS)}, CLASSES = ${JSON.stringify(ENERGY_CLASSES)}, SUBJECTS = ${JSON.stringify(SUBJECTS)};
  var YES_NO = { oui: 'Oui', non: 'Non' };
  function select(box, id, label, options, value) {
    var f = field(box, id, label, 'select');
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
    var f = field(box, id, label);
    f.setAttribute('inputmode', 'numeric');
    f.value = text(value);
    return f;
  }
  function draw(zone, o, version, sheet) {
    var c = sheet.characteristics || {}, e = sheet.energy || {}, k = sheet.coownership || {}, media = sheet.media || [];
    clear(zone);
    if (o.validated) zone.appendChild(el('p', 'Cette annonce est validée. Une nouvelle version de la fiche annule cette validation : au passage suivant, l’annonce est retirée de tous les canaux jusqu’à ce qu’un texte à jour soit validé.', 'retard'));
    zone.appendChild(el('p', 'Un champ vide reste « je ne sais pas » : rien n’est deviné.', 'doux'));
    var nums = {};
    NUMBERS.forEach(function (n) { nums[n[0]] = number(zone, 'fiche-bien-' + n[0], n[1], c[n[0]]); });
    var heating = select(zone, 'fiche-bien-chauffage', 'Chauffage', HEATING, c.heating);
    var elevator = select(zone, 'fiche-bien-ascenseur', 'Ascenseur', YES_NO, yesNo(c.elevator));
    var outs = {};
    Object.keys(OUTDOOR).forEach(function (kind) {
      outs[kind] = checkbox(zone, 'fiche-bien-ext-' + kind, OUTDOOR[kind]);
      outs[kind].checked = (c.outdoor || []).indexOf(kind) >= 0;
    });
    zone.appendChild(el('h4', 'Diagnostic énergétique'));
    var classes = {};
    CLASSES.forEach(function (x) { classes[x] = x; });
    var energy = {
      energyClass: select(zone, 'fiche-bien-energie', 'Classe énergie', classes, e.energyClass),
      climateClass: select(zone, 'fiche-bien-climat', 'Classe climat', classes, e.climateClass),
      annualCostMinEur: number(zone, 'fiche-bien-cout-min', 'Coût annuel le plus bas, en euros', e.annualCostMinEur),
      annualCostMaxEur: number(zone, 'fiche-bien-cout-max', 'Coût annuel le plus haut, en euros', e.annualCostMaxEur),
      costReferenceYear: number(zone, 'fiche-bien-cout-annee', 'Année des prix de l’énergie', e.costReferenceYear),
      diagnosedOn: field(zone, 'fiche-bien-diagnostic', 'Jour du diagnostic'),
    };
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
    send(o.base + '/photos/sujets', 'GET').then(function (res) {
      if (!res.ok || !res.body.data || !(res.body.data.photos || []).length) return;
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
      NUMBERS.forEach(function (n) { out[n[0]] = int(nums[n[0]], n[1]); });
      var en = null;
      var costs = [energy.annualCostMinEur, energy.annualCostMaxEur, energy.costReferenceYear];
      if (energy.energyClass.value || energy.climateClass.value || energy.diagnosedOn.value || costs.some(function (f) { return String(f.value || '').trim() !== ''; })) {
        en = {
          energyClass: energy.energyClass.value,
          climateClass: energy.climateClass.value,
          annualCostMinEur: int(energy.annualCostMinEur, 'Coût annuel le plus bas'),
          annualCostMaxEur: int(energy.annualCostMaxEur, 'Coût annuel le plus haut'),
          costReferenceYear: int(energy.costReferenceYear, 'Année des prix de l’énergie'),
          diagnosedOn: energy.diagnosedOn.value,
        };
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
    var start = JSON.stringify(read().sheet);
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
