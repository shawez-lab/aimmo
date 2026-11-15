/**
 * BR79 · Les programmes neufs à l'écran de la direction (HX48, routes de BR75). Un seul script servi à part
 * (`/app/neuf-direction.js`), chargé au premier geste sous « Engagements de service » de l'écran du réseau, sans rien
 * ajouter au script de l'application [R201].
 *
 * - Les barèmes des frais d'acquisition : lus par `GET /v1/neuf/baremes`, pour le neuf et pour l'ancien, celui qui fait
 *   foi ce jour, ceux à venir et ceux remplacés, chacun avec sa source et son premier jour ; sans barème en vigueur, il
 *   est dit qu'aucun frais n'est calculé [R544]. Un barème se range par `POST /v1/neuf/baremes` : le taux tapé en
 *   pourcentage part en points de base entiers, la source et le premier jour sont exigés avant l'appel.
 * - Les programmes : lus par `GET /v1/neuf/programmes`, chacun avec le nom de son agent, lu dans la liste des agents en
 *   activité (`GET /v1/gagner/recommandations/agents`). Un programme s'ouvre par `POST /v1/neuf/programmes` : le
 *   promoteur est choisi dans l'annuaire par code postal [R73], l'agent dans la liste des agents en activité ; aucun
 *   identifiant n'est tapé.
 *
 * - BR80 · La table d'espérance de vie du viager : les tables importées, lues par `GET /v1/viager/tables`, sans leurs
 *   lignes, celle qui sert aux calculs ce jour dite à part [R541]. Une table s'importe par `POST /v1/viager/tables` depuis
 *   le seul fichier choisi (deux colonnes : âge, espérance en années), relu ligne à ligne sur l'appareil avant tout
 *   envoi : une colonne de plus (le sexe), un âge en double ou hors de 0 à 120, une espérance illisible, et rien ne part,
 *   la ligne fautive dite par son numéro. Le serveur garde ses propres contrôles.
 *
 * Il ne calcule aucun frais. Chaque refus est dit en mots, jamais par son code [R16] ; une écriture sans réponse est
 * dite incertaine et l'écran relu. Tout texte reçu est posé en texte ; un champ mal formé n'est pas dit. Rien n'est
 * gardé sur l'appareil, rien n'est envoyé au promoteur ni à l'agent.
 */

export const NEUF_DIRECTION_KINDS: Readonly<Record<'neuf' | 'ancien', string>> = Object.freeze({ neuf: 'Frais du neuf', ancien: 'Frais de l’ancien' });

/** Les raisons d'un refus, dites à la direction : jamais un code interne. */
export const NEUF_DIRECTION_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  role: 'Les programmes neufs de la direction ne sont pas dans vos droits.',
  kind: 'Choisissez le neuf ou l’ancien.',
  rate: 'Le taux : un pourcentage de 0,01 % à 20 %, deux décimales au plus.',
  source: 'Dites d’où vient le taux (texte, barème, notaire), de 5 à 300 caractères : sans source, il ne se range pas.',
  valid_from: 'Le premier jour du barème est à remplir.',
  unknown: 'Le promoteur ou l’agent n’est plus lisible : cherchez-le de nouveau.',
  name: 'Le nom du programme : de 2 à 120 caractères.',
  city: 'La ville : de 2 à 80 caractères.',
  postal_code: 'Le code postal du programme : cinq chiffres.',
  not_promoter: 'Ce partenaire n’est pas un promoteur de l’annuaire.',
  agent: 'Cet agent n’est plus en activité : choisissez-en un autre.',
  bad_postcode: 'Le code postal : cinq chiffres.',
  invalid_body: 'La saisie n’est pas lisible.',
});

/** Les refus de l'import d'une table d'espérance, dits à la direction (BR80) [R541]. */
export const NEUF_DIRECTION_TABLE_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  role: 'Les tables d’espérance de vie ne sont pas dans vos droits.',
  millesime: 'Le millésime : l’année de la table (2024) ou ses années (2020-2022).',
  source: 'Dites d’où vient la table (INSEE, titre, date), de 5 à 300 caractères.',
  lignes: 'Le serveur n’a pas lu les âges de ce fichier : rien n’est importé.',
  colonnes: 'Le serveur a trouvé une autre colonne que l’âge et l’espérance : rien n’est importé.',
  deja_importee: 'Une table de ce millésime est déjà importée : elle ne change jamais. Une correction s’importe sous un autre millésime.',
  invalid_body: 'Ce fichier n’a pas pu être envoyé : rien n’est importé.',
});

export const NEUF_DIRECTION_NO_TABLE = 'Aucune table importée : un calcul de viager n’a pas d’espérance de vie et reste incomplet, sans rente ni droit d’usage.';
export const NEUF_DIRECTION_TABLE_NOTE = 'Le calcul prend toujours la dernière table importée. Une table importée ne change jamais : une correction s’importe sous un autre millésime.';
export const NEUF_DIRECTION_TABLE_MISSING = 'Choisissez le fichier, puis remplissez le millésime et la source (5 caractères au moins) avant d’importer.';
/** Le poids admis d'un fichier de table : 121 âges tiennent en bien moins. */
export const NEUF_DIRECTION_TABLE_MAX_BYTES = 64 * 1024;

export const NEUF_DIRECTION_OFFLINE = 'Pas de réseau. Réessayez dans un moment.';
export const NEUF_DIRECTION_LOST = 'La réponse n’est pas arrivée : rien n’est sûr. L’écran est relu, vérifiez-le avant de recommencer.';
export const NEUF_DIRECTION_NO_SCALE = 'Aucun barème en vigueur : aucun de ces frais n’est calculé, ni à l’écran de l’agent ni sur le site.';
export const NEUF_DIRECTION_NO_PROGRAM = 'Aucun programme neuf ouvert.';
export const NEUF_DIRECTION_SCALE_MISSING = 'Remplissez la sorte, le taux, la source (5 caractères au moins) et le premier jour avant de ranger.';
export const NEUF_DIRECTION_PROGRAM_MISSING = 'Remplissez le nom, la ville et le code postal, et choisissez le promoteur et l’agent avant d’ouvrir.';
export const NEUF_DIRECTION_LEFT = 'confié à un agent qui n’est plus en activité';

/** Le script servi à part. Il ne lit et n'écrit que sous `/v1/neuf`, et ne lit que l'annuaire et la liste des agents [R16]. */
export const NEUF_DIRECTION_SCRIPT = `'use strict';
globalThis.AIMMO_NEUF_DIRECTION = function (t) {
  var el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field;
  var KINDS = ${JSON.stringify(NEUF_DIRECTION_KINDS)}, REFUSALS = ${JSON.stringify(NEUF_DIRECTION_REFUSALS)};
  var OFFLINE = ${JSON.stringify(NEUF_DIRECTION_OFFLINE)}, LOST = ${JSON.stringify(NEUF_DIRECTION_LOST)}, NO_SCALE = ${JSON.stringify(NEUF_DIRECTION_NO_SCALE)};
  var NO_PROGRAM = ${JSON.stringify(NEUF_DIRECTION_NO_PROGRAM)}, SCALE_MISSING = ${JSON.stringify(NEUF_DIRECTION_SCALE_MISSING)};
  var PROGRAM_MISSING = ${JSON.stringify(NEUF_DIRECTION_PROGRAM_MISSING)}, LEFT = ${JSON.stringify(NEUF_DIRECTION_LEFT)};
  var TABLE_REFUSALS = ${JSON.stringify(NEUF_DIRECTION_TABLE_REFUSALS)}, NO_TABLE = ${JSON.stringify(NEUF_DIRECTION_NO_TABLE)};
  var TABLE_NOTE = ${JSON.stringify(NEUF_DIRECTION_TABLE_NOTE)}, TABLE_MISSING = ${JSON.stringify(NEUF_DIRECTION_TABLE_MISSING)};
  var TABLE_MAX = ${NEUF_DIRECTION_TABLE_MAX_BYTES}, VINTAGE = /^\\d{4}(?:-\\d{4})?$/;
  var ID = /^[A-Za-z0-9_-]{1,64}$/, DAY = /^\\d{4}-\\d{2}-\\d{2}$/, CP = /^\\d{5}$/;
  var root = null, turn = 0, busy = false;
  function own(map, k) { return typeof k === 'string' && Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; }
  function str(v, max) { return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null; }
  function int(x) { return typeof x === 'number' && isFinite(x) && Math.floor(x) === x; }
  function day(d) { return typeof d === 'string' && DAY.test(d) ? d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(0, 4) : null; }
  function refusal(x, fallback, map) {
    if (x.offline) return OFFLINE;
    return own(map || REFUSALS, x.body && x.body.code) || fallback;
  }
  function note() { var p = el('p', '', 'etat'); p.setAttribute('role', 'status'); return p; }
  function choice(box, id, label, map, empty) {
    var f = field(box, id, label, 'select'), first = el('option', empty || 'Choisir…');
    first.value = '';
    f.appendChild(first);
    Object.keys(map).forEach(function (k) { var o = el('option', map[k]); o.value = k; f.appendChild(o); });
    f.value = '';
    return f;
  }
  /** Des points de base reçus, écrits en pourcentage : 260 donne « 2,6 % ». */
  function percent(bp) {
    if (!int(bp) || bp < 1 || bp > 2000) return null;
    var r = bp % 100;
    return String((bp - r) / 100) + (r ? ',' + (r < 10 ? '0' + r : String(r)).replace(/0$/, '') : '') + '\\u00a0%';
  }
  /** Un pourcentage tapé, en points de base entiers : « 2,6 » donne 260 ; une forme douteuse n'est pas lue. */
  function points(s) {
    var m = /^(\\d{1,2})(?:[.,](\\d{1,2}))?$/.exec(String(s || '').replace(/[\\s\\u00a0\\u202f%]/g, ''));
    if (!m) return null;
    var d = m[2] || '';
    return Number(m[1]) * 100 + (d ? Number(d.length === 1 ? d + '0' : d) : 0);
  }
  /** Un barème reçu, relu champ par champ : un champ mal formé, et il n'est pas dit. */
  function scale(s) {
    if (!s || typeof s !== 'object' || !ID.test(s.scaleId || '')) return null;
    var r = { rate: percent(s.rateBp), source: str(s.source, 300), from: day(s.validFrom) };
    return r.rate && r.source && r.from ? r : null;
  }
  function scaleLine(r, lead) {
    var li = el('li');
    li.appendChild(el('strong', lead + r.rate));
    li.appendChild(el('p', 'Source : ' + r.source, 'doux'));
    return li;
  }
  /* Une écriture : une à la fois ; sans réponse lisible, ou une panne du serveur, elle a pu passer : tout est relu. */
  function write(b, path, body, said, done, fallback, map) {
    if (busy) return Promise.resolve(false);
    var mine = t.session();
    busy = true;
    b.disabled = true;
    said.textContent = 'Envoi…';
    return send(path, 'POST', body).then(function (x) {
      busy = false;
      b.disabled = false;
      if (x.gone || mine !== t.session()) return false;
      if (x.offline || !x.body || x.status >= 500) { draw(LOST); return false; }
      if (!x.ok) { said.textContent = refusal(x, fallback, map); return false; }
      draw(done);
      return true;
    });
  }
  /* ---------- Les barèmes [R544] ---------- */
  function scales(box, d) {
    box.appendChild(el('p', 'Le taux qui fait foi un jour est le dernier commencé ; pour un même premier jour, le dernier rangé. Rien ne s’efface : une correction est un nouveau barème.', 'doux'));
    Object.keys(KINDS).forEach(function (k) {
      var g = d && typeof d === 'object' && d[k] && typeof d[k] === 'object' ? d[k] : {};
      var part = el('section', null, 'bloc');
      part.appendChild(el('h5', KINDS[k]));
      var now = scale(g.current);
      var ul = el('ul', null, 'liste');
      if (now) ul.appendChild(scaleLine(now, 'En vigueur depuis le ' + now.from + ' : '));
      else part.appendChild(el('p', NO_SCALE, 'doux'));
      (Array.isArray(g.upcoming) ? g.upcoming : []).map(scale).forEach(function (r) { if (r) ul.appendChild(scaleLine(r, 'À venir, à partir du ' + r.from + ' : ')); });
      (Array.isArray(g.replaced) ? g.replaced : []).map(scale).forEach(function (r) { if (r) ul.appendChild(scaleLine(r, 'Remplacé, du ' + r.from + ' : ')); });
      if (ul.children.length) part.appendChild(ul);
      box.appendChild(part);
    });
    var form = el('section', null, 'bloc');
    form.appendChild(el('h5', 'Ranger un barème'));
    var f = {
      kind: choice(form, 'neuf-bareme-sorte', 'Sorte', KINDS),
      rate: field(form, 'neuf-bareme-taux', 'Taux des frais (%)'),
      source: field(form, 'neuf-bareme-source', 'Source du taux'),
      from: field(form, 'neuf-bareme-debut', 'Premier jour'),
    };
    // Le quatrième argument de field() est la balise : le type se pose à part.
    f.from.setAttribute('type', 'date');
    f.rate.setAttribute('inputmode', 'decimal');
    f.source.setAttribute('maxlength', '300');
    var said = note();
    var go = button('Ranger ce barème', function () {
      var bp = points(f.rate.value), src = String(f.source.value || '').trim();
      if (!own(KINDS, f.kind.value) || bp === null || src.length < 5 || !DAY.test(String(f.from.value || ''))) { said.textContent = SCALE_MISSING; return; }
      write(go, '/v1/neuf/baremes', { kind: f.kind.value, rateBp: bp, source: src, validFrom: f.from.value }, said, 'Barème rangé : l’écran est relu.', 'Le barème n’a pas été rangé.');
    });
    form.appendChild(go);
    form.appendChild(said);
    box.appendChild(form);
  }
  /* ---------- Les programmes ---------- */
  function agentsOf(x) {
    var map = {};
    if (!x.ok || !x.body || !Array.isArray(x.body.data)) return null;
    x.body.data.forEach(function (a) {
      var name = a && typeof a === 'object' ? [str(a.firstName, 80), str(a.lastName, 80)].filter(Boolean).join(' ') : '';
      if (name && ID.test(a.agentId || '')) map[a.agentId] = name;
    });
    return map;
  }
  function programs(box, x, agents) {
    var items = x.ok && x.body && Array.isArray(x.body.data) ? x.body.data : null;
    if (!items) { box.appendChild(el('p', refusal(x, 'Les programmes ne se lisent pas pour le moment.'), 'doux')); return; }
    items = items.filter(function (p) { return p && typeof p === 'object' && ID.test(p.programId || '') && str(p.name, 120); });
    if (!items.length) box.appendChild(el('p', NO_PROGRAM, 'doux'));
    var ul = el('ul', null, 'liste');
    items.forEach(function (p) {
      var li = el('li');
      li.appendChild(el('strong', p.name));
      var who = agents && own(agents, p.agentId) ? 'confié à ' + agents[p.agentId] : agents ? LEFT : '';
      li.appendChild(el('p', [[str(p.postalCode, 5), str(p.city, 80)].filter(Boolean).join(' '), str(p.promoter, 120) ? 'promoteur ' + p.promoter : '', who].filter(Boolean).join(' · '), 'doux'));
      ul.appendChild(li);
    });
    if (items.length) box.appendChild(ul);
  }
  function opening(box, agents) {
    var form = el('section', null, 'bloc');
    form.appendChild(el('h5', 'Ouvrir un programme'));
    form.appendChild(el('p', 'Le promoteur se choisit dans l’annuaire des partenaires, l’agent parmi ceux en activité : l’agent tient ensuite la grille des lots.', 'doux'));
    var f = {
      name: field(form, 'neuf-programme-nom', 'Nom du programme'),
      city: field(form, 'neuf-programme-ville', 'Ville'),
      cp: field(form, 'neuf-programme-cp', 'Code postal'),
    };
    f.name.setAttribute('maxlength', '120');
    f.city.setAttribute('maxlength', '80');
    f.cp.setAttribute('inputmode', 'numeric');
    f.promoter = choice(form, 'neuf-programme-promoteur', 'Promoteur choisi', {}, 'Aucun promoteur choisi');
    var found = el('p', null, 'doux');
    found.setAttribute('role', 'status');
    var look = 0;
    var search = button('Chercher le promoteur dans l’annuaire', function () {
      var cp = String(f.cp.value || '').trim(), mine = t.session(), me = ++look;
      if (!CP.test(cp)) { found.textContent = REFUSALS.bad_postcode; return; }
      while (f.promoter.children.length > 1) f.promoter.removeChild(f.promoter.children[1]);
      f.promoter.value = '';
      found.textContent = 'Recherche…';
      send('/v1/partenaires/annuaire?metier=promoteur&cp=' + encodeURIComponent(cp), 'GET').then(function (x) {
        if (x.gone || mine !== t.session() || me !== look) return;
        var d = x.ok && x.body && x.body.data && typeof x.body.data === 'object' ? x.body.data : null;
        if (!d || !Array.isArray(d.proposable) || !Array.isArray(d.unavailable)) { found.textContent = refusal(x, 'L’annuaire ne se lit pas pour le moment.'); return; }
        var n = 0;
        [[d.proposable, ''], [d.unavailable, ' (pas justifié ce jour)']].forEach(function (g) {
          g[0].forEach(function (p) {
            var name = p && typeof p === 'object' ? str(p.businessName, 120) : null;
            if (!name || !ID.test(p.partnerId || '') || p.trade !== 'promoteur') return;
            var o = el('option', name + g[1]);
            o.value = p.partnerId;
            f.promoter.appendChild(o);
            n++;
          });
        });
        found.textContent = n ? n + (n > 1 ? ' promoteurs trouvés : choisissez-en un.' : ' promoteur trouvé : choisissez-le.') : 'Aucun promoteur dans ce code postal.';
      });
    });
    search.className = 'secondaire';
    form.appendChild(search);
    form.appendChild(found);
    if (agents) f.agent = choice(form, 'neuf-programme-agent', 'Agent qui tient le programme', agents);
    else form.appendChild(el('p', 'La liste des agents en activité ne se lit pas pour le moment : aucun programme ne s’ouvre.', 'doux'));
    var said = note();
    var go = button('Ouvrir le programme', function () {
      var body = { promoterPartnerId: f.promoter.value, agentId: f.agent ? f.agent.value : '', name: String(f.name.value || '').trim(), city: String(f.city.value || '').trim(), postalCode: String(f.cp.value || '').trim() };
      if (!ID.test(body.promoterPartnerId || '') || !own(agents || {}, body.agentId) || body.name.length < 2 || body.city.length < 2 || !CP.test(body.postalCode)) { said.textContent = PROGRAM_MISSING; return; }
      write(go, '/v1/neuf/programmes', body, said, 'Programme ouvert : il est confié à ' + agents[body.agentId] + '.', 'Le programme n’a pas été ouvert.');
    });
    form.appendChild(go);
    form.appendChild(said);
    box.appendChild(form);
  }
  /* ---------- La table d'espérance de vie du viager (BR80) [R541] ---------- */
  /**
   * Le fichier relu ligne à ligne : deux colonnes (âge, espérance en années, une décimale au plus), séparées par « ; »,
   * une tabulation ou « , » (alors la décimale est un point), une ligne de titres permise en tête. Le premier défaut
   * arrête tout : rien ne part, et sa ligne est dite par son numéro.
   */
  function lifeTable(csv) {
    var lines = String(csv).replace(/^\\ufeff/, '').split(/\\r\\n|\\n|\\r/), rows = [], seen = {}, sep = null, first = true;
    function bad(i, why) { return { error: 'Ligne ' + (i + 1) + ' : ' + why + ' Rien n’est envoyé.' }; }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line.trim()) continue;
      if (sep === null) sep = line.indexOf(';') >= 0 ? ';' : line.indexOf('\\t') >= 0 ? '\\t' : ',';
      var cells = line.split(sep).map(function (c) { return c.trim().replace(/^"(.*)"$/, '$1').trim(); });
      var head = first && !/^\\d/.test(cells[0] || '');
      first = false;
      if (/sexe|homme|femme|masculin|f[eé]minin/i.test(line)) return bad(i, 'une colonne de sexe. La table est celle de l’ensemble des deux sexes, sans autre colonne que l’âge et l’espérance.');
      if (cells.length !== 2) return bad(i, cells.length + ' colonnes. La table n’a que deux colonnes : l’âge, puis l’espérance de vie.');
      if (head) continue;
      if (!/^\\d{1,3}$/.test(cells[0]) || Number(cells[0]) > 120) return bad(i, 'l’âge n’est pas lisible (un entier de 0 à 120).');
      var age = Number(cells[0]);
      if (Object.prototype.hasOwnProperty.call(seen, age)) return bad(i, 'l’âge ' + age + ' est déjà plus haut, à la ligne ' + seen[age] + '.');
      var m = (sep === ',' ? /^(\\d{1,3})(?:\\.(\\d))?$/ : /^(\\d{1,3})(?:[.,](\\d))?$/).exec(cells[1]);
      var tenths = m ? Number(m[1]) * 10 + Number(m[2] || 0) : 0;
      if (!m || tenths < 1 || tenths > 1200) return bad(i, 'l’espérance de vie n’est pas lisible (des années, une décimale au plus, de 0,1 à 120).');
      seen[age] = i + 1;
      rows.push({ age: age, expectancyTenths: tenths });
      if (rows.length > 121) return bad(i, 'plus de 121 âges : ce n’est pas une table d’espérance de vie.');
    }
    if (!rows.length) return { error: 'Aucun âge lu dans ce fichier. Rien n’est envoyé.' };
    return { rows: rows };
  }
  function tableOf(x) {
    if (!x || typeof x !== 'object' || !ID.test(x.tableId || '')) return null;
    var r = { vintage: typeof x.vintage === 'string' && VINTAGE.test(x.vintage) ? x.vintage : null, source: str(x.source, 300), at: typeof x.importedAt === 'string' ? day(x.importedAt.slice(0, 10)) : null, count: int(x.rowCount) && x.rowCount > 0 && x.rowCount <= 121 ? x.rowCount : null, inUse: x.inUse === true };
    return r.vintage && r.source && r.at && r.count ? r : null;
  }
  function tables(box, x) {
    var d = x.ok && x.body && x.body.data && typeof x.body.data === 'object' && Array.isArray(x.body.data.tables) ? x.body.data.tables : null;
    if (!d) { box.appendChild(el('p', refusal(x, 'Les tables ne se lisent pas pour le moment.', TABLE_REFUSALS), 'doux')); return; }
    box.appendChild(el('p', TABLE_NOTE, 'doux'));
    var list = d.map(tableOf).filter(Boolean), used = list.filter(function (r) { return r.inUse; })[0] || null;
    if (!used) box.appendChild(el('p', NO_TABLE, 'doux'));
    var ul = el('ul', null, 'liste');
    list.forEach(function (r) {
      var li = el('li');
      li.appendChild(el('strong', (r.inUse ? 'En service pour chaque calcul : millésime ' : 'Plus en service : millésime ') + r.vintage));
      li.appendChild(el('p', 'Source : ' + r.source + ' · importée le ' + r.at + ' · ' + r.count + (r.count > 1 ? ' âges' : ' âge'), 'doux'));
      ul.appendChild(li);
    });
    if (list.length) box.appendChild(ul);
    var form = el('section', null, 'bloc');
    form.appendChild(el('h5', 'Importer une table'));
    form.appendChild(el('p', 'Le fichier CSV de la table, ensemble des deux sexes : deux colonnes, l’âge puis l’espérance de vie en années. Il est relu ici avant tout envoi.', 'doux'));
    var f = { file: field(form, 'viager-table-fichier', 'Fichier de la table'), vintage: field(form, 'viager-table-millesime', 'Millésime'), source: field(form, 'viager-table-source', 'Source de la table') };
    f.file.setAttribute('type', 'file');
    f.file.setAttribute('accept', '.csv,text/csv,text/plain');
    f.source.setAttribute('maxlength', '300');
    var said = note();
    var go = button('Importer cette table', function () {
      var files = f.file.files, file = files && files.length === 1 ? files[0] : null;
      var vintage = String(f.vintage.value || '').trim(), src = String(f.source.value || '').trim();
      if (busy) return;
      if (!file || !VINTAGE.test(vintage) || src.length < 5) { said.textContent = TABLE_MISSING; return; }
      if (!(file.size <= TABLE_MAX)) { said.textContent = 'Ce fichier dépasse 64 Ko : ce n’est pas une table d’espérance de vie. Rien n’est envoyé.'; return; }
      var mine = t.session();
      said.textContent = 'Lecture du fichier…';
      Promise.resolve(file.text()).then(function (csv) {
        if (mine !== t.session()) return;
        var r = lifeTable(csv);
        if (r.error) { said.textContent = r.error; return; }
        write(go, '/v1/viager/tables', { vintage: vintage, source: src, rows: r.rows }, said, 'Table importée (' + r.rows.length + ' âges) : elle sert désormais à chaque calcul.', 'La table n’a pas été importée.', TABLE_REFUSALS);
      }, function () { if (mine === t.session()) said.textContent = 'Ce fichier ne se lit pas : rien n’est envoyé.'; });
    });
    form.appendChild(go);
    form.appendChild(said);
    box.appendChild(form);
  }
  function draw(message) {
    if (!root) return Promise.resolve(false);
    var box = root, mine = t.session(), me = ++turn;
    clear(box);
    var said = note();
    said.textContent = message === LOST ? LOST : 'Chargement…';
    box.appendChild(said);
    return Promise.all([send('/v1/neuf/baremes', 'GET'), send('/v1/neuf/programmes', 'GET'), send('/v1/gagner/recommandations/agents', 'GET'), send('/v1/viager/tables', 'GET')]).then(function (r) {
      if (r[0].gone || r[1].gone || r[2].gone || r[3].gone || box !== root || mine !== t.session() || me !== turn) return false;
      said.textContent = message || '';
      var a = el('section', null, 'bloc');
      a.appendChild(el('h4', 'Barèmes des frais d’acquisition'));
      if (r[0].ok && r[0].body && r[0].body.data && typeof r[0].body.data === 'object') scales(a, r[0].body.data);
      else a.appendChild(el('p', refusal(r[0], 'Les barèmes ne se lisent pas pour le moment.'), 'doux'));
      box.appendChild(a);
      var agents = agentsOf(r[2]);
      var b = el('section', null, 'bloc');
      b.appendChild(el('h4', 'Programmes'));
      programs(b, r[1], agents);
      opening(b, agents);
      box.appendChild(b);
      var c = el('section', null, 'bloc');
      c.appendChild(el('h4', 'Table d’espérance de vie du viager'));
      tables(c, r[3]);
      box.appendChild(c);
      return true;
    });
  }
  return { show: function (box) { root = box; return draw(''); } };
};
`;
