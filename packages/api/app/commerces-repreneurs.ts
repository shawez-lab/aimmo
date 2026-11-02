import { ACTIVITY_LABEL } from '../../core/src/commerces/presentation.ts';
import { BUYER_EXPERIENCES, DECLARED_FINANCINGS, type BuyerExperience, type DeclaredFinancing } from '../../core/src/commerces/repreneurs.ts';

/**
 * Les repreneurs à l'écran (CE15), servis à part (`/app/commerces-repreneurs.js`), chargés au premier geste [R201].
 * L'agent du projet ou la direction complète le profil ; chacun lit les commerces que le code rapproche. Les repreneurs
 * se lisent dans l'ordre d'arrivée, sans note ni score [R14] ; le profil ne porte que le projet et ce que la personne
 * déclare, jamais vérifié ni évalué [R115] ; le rapprochement ne montre que ce que le serveur rend, et seulement ces
 * champs : titre, commune, sorte, activité, fourchette [R110]. Rien n'est lu avant le geste, rien n'est gardé.
 */

const EXPERIENCE_LABELS: Record<BuyerExperience, string> = {
  aucune: 'Aucune dans le commerce',
  salarie_du_metier: 'Salarié du métier',
  gerant_du_metier: 'Gérant du métier',
  gerant_autre_metier: 'Gérant d’un autre métier',
  reconversion: 'En reconversion',
};
const FINANCING_LABELS: Record<DeclaredFinancing, string> = {
  apport_seul: 'Apport seul',
  pret_bancaire: 'Prêt bancaire',
  pret_et_apport: 'Prêt et apport',
  a_definir: 'À définir',
};
const KINDS = { business: 'Fonds de commerce', business_walls: 'Murs commerciaux', commercial: 'Local professionnel' };
const FIELDS = {
  activities: 'les activités',
  kinds: 'les sortes de biens',
  postalCodes: 'les codes postaux',
  budgetMaxEur: 'le budget',
  experience: 'l’expérience',
  declaredContributionEur: 'l’apport déclaré',
  declaredFinancing: 'le financement déclaré',
};

export const COMMERCES_REPRENEURS_SCRIPT = `'use strict';
globalThis.AIMMO_CE_REPRENEURS = function (t) {
  var el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field, ID = t.ID, say = t.say;
  var ACT = ${JSON.stringify(ACTIVITY_LABEL)};
  var KINDS = ${JSON.stringify(KINDS)};
  var EXP = ${JSON.stringify(EXPERIENCE_LABELS)}, EXP_KEYS = ${JSON.stringify(BUYER_EXPERIENCES)};
  var FIN = ${JSON.stringify(FINANCING_LABELS)}, FIN_KEYS = ${JSON.stringify(DECLARED_FINANCINGS)};
  var FIELDS = ${JSON.stringify(FIELDS)};
  function isId(x) { return typeof x === 'string' && ID.test(x); }
  function eur(n) { return String(Math.round(n)).replace(/\\B(?=(\\d{3})+(?!\\d))/g, '\\u202f') + '\\u00a0€'; }
  function plain(res, what) {
    if (res.status === 403) return 'Ce geste n’est pas dans vos droits.';
    return res.offline ? 'Pas de réseau. Réessayez dans un moment.' : what + ' ne se lit pas pour le moment.';
  }
  /* Dans l'ordre d'arrivée, celui du serveur : ni note, ni tri [R14]. */
  function list(box) {
    clear(box);
    var mine = t.session();
    say('Chargement…');
    return send('/v1/commerces/repreneurs', 'GET').then(function (res) {
      if (res.gone || mine !== t.session()) return;
      if (!res.ok) { box.appendChild(button('Voir les repreneurs', function () { list(box); })); say(plain(res, 'La liste')); return; }
      say('');
      var rows = Array.isArray(res.body.data) ? res.body.data : [];
      if (!rows.length) { box.appendChild(el('p', 'Aucun projet de reprise pour le moment.', 'doux')); return; }
      box.appendChild(el('p', 'Dans l’ordre d’arrivée, sans note ni tri.', 'doux'));
      var ul = el('ul', null, 'liste');
      rows.forEach(function (r) {
        if (!isId(r.projectId)) return;
        var li = el('li');
        li.appendChild(el('strong', (r.firstName || 'Repreneur') + ', projet du ' + t.day(r.createdAt)));
        var inner = el('div');
        inner.appendChild(button('Ouvrir le profil', function () { profile(inner, r); }));
        li.appendChild(inner);
        ul.appendChild(li);
      });
      box.appendChild(ul);
    });
  }
  function profile(box, r) {
    clear(box);
    var mine = t.session();
    say('Chargement…');
    return send('/v1/commerces/repreneurs/' + encodeURIComponent(r.projectId), 'GET').then(function (res) {
      if (res.gone || mine !== t.session()) return;
      if (!res.ok) { box.appendChild(button('Ouvrir le profil', function () { profile(box, r); })); say(plain(res, 'Le profil')); return; }
      say('');
      var cur = res.body.data && res.body.data.current;
      var p = (cur && cur.profile) || { activities: [], kinds: [], postalCodes: [], budgetMaxEur: null, experience: null, declaredContributionEur: null, declaredFinancing: null };
      box.appendChild(el('p', cur ? 'Version ' + cur.version + ' du profil.' : 'Profil à compléter.', 'doux'));
      if (r.writable === true) form(box, r, p); else summary(box, p);
      var found = el('div');
      found.appendChild(button('Voir les commerces rapprochés', function () { matches(found, r); }));
      box.appendChild(found);
    });
  }
  /* Qui peut lire sans écrire lit le profil, sans formulaire [R16]. */
  function summary(box, p) {
    var lines = [];
    if (p.activities.length) lines.push('Activités : ' + p.activities.map(function (a) { return ACT[a] || a; }).join(', '));
    if (p.kinds.length) lines.push('Sortes : ' + p.kinds.map(function (k) { return KINDS[k] || k; }).join(', '));
    if (p.postalCodes.length) lines.push('Codes postaux : ' + p.postalCodes.join(', '));
    if (p.budgetMaxEur !== null) lines.push('Budget : ' + eur(p.budgetMaxEur));
    if (p.experience) lines.push('Expérience : ' + (EXP[p.experience] || p.experience));
    if (p.declaredContributionEur !== null) lines.push('Apport déclaré : ' + eur(p.declaredContributionEur));
    if (p.declaredFinancing) lines.push('Financement déclaré : ' + (FIN[p.declaredFinancing] || p.declaredFinancing));
    if (!lines.length) box.appendChild(el('p', 'Rien de rempli pour le moment.', 'doux'));
    lines.forEach(function (x) { box.appendChild(el('p', x)); });
  }
  function checks(box, prefix, title, map, chosen) {
    box.appendChild(el('p', title));
    var all = {};
    Object.keys(map).forEach(function (k) {
      var wrap = el('div', null, 'case'), c = el('input'), id = prefix + k, l = el('label', map[k]);
      c.setAttribute('type', 'checkbox');
      c.setAttribute('id', id);
      c.checked = chosen.indexOf(k) !== -1;
      l.setAttribute('for', id);
      wrap.appendChild(c);
      wrap.appendChild(l);
      box.appendChild(wrap);
      all[k] = c;
    });
    return function () { return Object.keys(all).filter(function (k) { return all[k].checked; }).sort(); };
  }
  function choice(box, id, label, keys, map, value) {
    var s = field(box, id, label, 'select');
    t.option(s, '', 'Non renseigné');
    keys.forEach(function (k) { t.option(s, k, map[k]); });
    s.value = value || '';
    return s;
  }
  function money(box, id, label, value) {
    var f = field(box, id, label);
    f.setAttribute('inputmode', 'numeric');
    f.value = value === null ? '' : String(value);
    return f;
  }
  /* Un montant en euros entiers ; vide retire le champ ; illisible, rien ne part. */
  function euros(text) {
    var s = String(text || '').replace(/[\\s\\u00a0\\u202f€]/g, '');
    if (s === '') return null;
    if (!/^\\d{1,10}$/.test(s) || Number(s) > 1000000000) return undefined;
    return Number(s);
  }
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function form(box, r, p) {
    var n = r.projectId;
    var activities = checks(box, 'ce-rep-act-' + n + '-', 'Activités cherchées', ACT, p.activities);
    var kinds = checks(box, 'ce-rep-sorte-' + n + '-', 'Sortes de biens cherchées', KINDS, p.kinds);
    var codes = field(box, 'ce-rep-codes-' + n, 'Codes postaux, séparés par des virgules');
    codes.value = p.postalCodes.join(', ');
    var budget = money(box, 'ce-rep-budget-' + n, 'Budget le plus haut, en euros', p.budgetMaxEur);
    box.appendChild(el('p', 'Ce qui suit est ce que la personne déclare, tel qu’elle le dit : rien n’est vérifié, évalué ni noté.', 'doux'));
    var experience = choice(box, 'ce-rep-exp-' + n, 'Son expérience', EXP_KEYS, EXP, p.experience);
    var contribution = money(box, 'ce-rep-apport-' + n, 'Apport déclaré, en euros', p.declaredContributionEur);
    var financing = choice(box, 'ce-rep-fin-' + n, 'Financement déclaré', FIN_KEYS, FIN, p.declaredFinancing);
    var go = button('Ranger le profil', function () {
      var list = String(codes.value || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
      if (!list.every(function (x) { return /^\\d{5}$/.test(x); })) { say('Vérifiez les codes postaux : 5 chiffres chacun.'); return; }
      var b = euros(budget.value), c = euros(contribution.value);
      if (b === undefined) { say('Vérifiez le budget : un montant en euros, sans centimes.'); return; }
      if (c === undefined) { say('Vérifiez l’apport déclaré : un montant en euros, sans centimes.'); return; }
      var next = { activities: activities(), kinds: kinds(), postalCodes: list.filter(function (x, i) { return list.indexOf(x) === i; }).sort(), budgetMaxEur: b, experience: experience.value || null, declaredContributionEur: c, declaredFinancing: financing.value || null };
      /* Seuls les champs changés partent : sans changement, aucune version [R17]. */
      var changed = {}, any = false;
      Object.keys(next).forEach(function (k) { if (!same(next[k], p[k])) { changed[k] = next[k]; any = true; } });
      if (!any) { say('Rien n’a changé : aucune version ajoutée.'); return; }
      var mine = t.session();
      go.disabled = true;
      say('Envoi…');
      send('/v1/commerces/repreneurs/' + encodeURIComponent(r.projectId), 'POST', changed).then(function (res) {
        if (res.gone || mine !== t.session()) return;
        go.disabled = false;
        if (res.ok) {
          /* La carte relue depuis le serveur : le rapprochement suit le profil rangé. */
          profile(box, r).then(function () { say('Profil rangé : une nouvelle version s’ajoute.'); });
          return;
        }
        var body = res.body, code = body && body.code;
        if ((code === 'valeur' || code === 'hors_liste') && body.field && FIELDS[body.field]) say('Vérifiez ' + FIELDS[body.field] + '.');
        else if (res.status === 403) say('Ce geste n’est pas dans vos droits.');
        else if (res.offline || !body || res.status >= 500) say('Réponse perdue : ce profil est peut-être rangé. Rouvrez-le avant de recommencer.');
        else say('Le profil n’est pas rangé.');
      });
    });
    box.appendChild(go);
  }
  /* Les commerces que le code rapproche : seulement les champs publics, sans rang ni note [R14, R110]. */
  function matches(box, r) {
    clear(box);
    var mine = t.session();
    say('Chargement…');
    return send('/v1/commerces/repreneurs/' + encodeURIComponent(r.projectId) + '/biens', 'GET').then(function (res) {
      if (res.gone || mine !== t.session()) return;
      if (!res.ok) { box.appendChild(button('Voir les commerces rapprochés', function () { matches(box, r); })); say(plain(res, 'Le rapprochement')); return; }
      say('');
      var rows = Array.isArray(res.body.data) ? res.body.data : [];
      if (!rows.length) { box.appendChild(el('p', 'Aucun commerce diffusable ne répond à ce profil pour le moment.', 'doux')); return; }
      box.appendChild(el('p', 'Les commerces diffusables qui répondent aux critères remplis, du prix le plus bas au plus haut.', 'doux'));
      var ul = el('ul', null, 'liste');
      rows.forEach(function (m) {
        var v = m.publicView || {};
        var li = el('li');
        li.appendChild(el('strong', String(m.title || 'Commerce')));
        li.appendChild(el('p', [KINDS[v.kind] || '', v.activity ? ACT[v.activity] : '', v.city || ''].filter(Boolean).join(' · '), 'doux'));
        if (typeof m.priceLowEuros === 'number' && typeof m.priceHighEuros === 'number') li.appendChild(el('p', 'De ' + eur(m.priceLowEuros) + ' à ' + eur(m.priceHighEuros)));
        ul.appendChild(li);
      });
      box.appendChild(ul);
    });
  }
  return { list: list };
};
`;
