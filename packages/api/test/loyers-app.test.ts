import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { ANIL_CITATION } from '../../core/src/investir/loyers.ts';
import { LOYERS_MAX_BYTES, LOYERS_SCRIPT } from '../app/loyers.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL, handleAgentApp } from '../src/agent-app.ts';
import { MAX_RENTS_FILE_BYTES } from '../src/investir.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé : clé, fichier, communes, chiffres.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;
const JS = AGENT_APP_FILES['/app/app.js']!;
const POST = 'POST /v1/investir/loyers';
const CSV = 'INSEE_C;loypredm2;lwr.IPm2;upr.IPm2;nbobs_com\n99001;12,35;10,10;15,01;120';
type Answer = () => Promise<Response>;
const ok = (data: unknown): Answer => async () => Response.json({ ok: true, mode: 'essai', data });
const no = (status: number, body: unknown): Answer => async () => Response.json(body, { status });
const done = (over: Record<string, unknown> = {}) => ok({ importId: 'i1', rows: 900, stored: 900, status: 'complet', created: true, ...over });
const part = (stored: number) => ok({ importId: 'i1', rows: 900, stored, status: 'en_cours', created: false });
const KNOWN = { status: 'connu', inseeCode: '99001', kind: 'apartment', rentM2Cents: 1235, lowerM2Cents: 1010, upperM2Cents: 1501, observations: 120, source: 'anil', citation: `${ANIL_CITATION}, millésime 2026`, vintage: 2026, asOf: '2027-01-10T08:00:00.000Z', importId: 'i1', reliability: 'fiable', reasons: [] };
const settle = async () => {
  for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0));
};
const file = (size = CSV.length, text: () => Promise<string> = async () => CSV) => ({ size, text });

async function run(answers: Record<string, Answer> = {}) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const page = document as typeof document & { body: FakeElement };
  page.body = new FakeElement('body');
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { method: string; url: string; body: unknown }[] = [];
  const table: Record<string, Answer> = { 'GET /v1/moi': ok({ role: 'direction', firstName: null }), 'GET /v1/investir/regles?insee=99001': ok({ canRecord: true, rules: [] }), ...answers };
  const context: Record<string, unknown> = {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; body?: string } = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, body: typeof init.body === 'string' ? JSON.parse(init.body) : null });
      const a = table[`${method} ${url}`];
      return a ? a() : Promise.reject(new TypeError('hors ligne'));
    },
    Intl,
    setTimeout: () => 0,
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  };
  runInNewContext(JS, context);
  listeners.DOMContentLoaded!();
  await settle();
  const state = () => els['loyers-etat']!.textContent;
  const list = () => els['loyers-liste']!.children.map((e) => e.textContent);
  const press = async (id: string) => {
    els[id]!.listeners.click!({});
    await settle();
    const s = els.reseau!.children.filter((e) => e.tagName === 'script' && e.attributes.src === '/app/loyers.js');
    if (s.length === 1 && !context.loaded) {
      runInNewContext(LOYERS_SCRIPT, context);
      context.loaded = true;
      s[0]!.listeners.load!({});
      await settle();
    }
  };
  const fill = (chosen: unknown = file()) => {
    els['loyers-type']!.value = 'apartment';
    els['loyers-millesime']!.value = '2026';
    (els['loyers-fichier'] as FakeElement & { files?: unknown[] }).files = [chosen];
  };
  const posts = () => calls.filter((c) => c.method === 'POST');
  return { els, calls, table, state, list, press, fill, posts };
}

describe('Y10 · importer les loyers de marché depuis l’écran du réseau', () => {
  it('[R122] le fichier part tel quel, avec son type et son millésime, et l’écran dit ce qui est rangé', async () => {
    const t = await run({ [POST]: done() });
    t.fill();
    await t.press('loyers-importer');
    expect(t.posts()).toEqual([{ method: 'POST', url: '/v1/investir/loyers', body: { kind: 'apartment', vintage: 2026, csv: CSV } }]);
    expect(t.state()).toBe('Import fait : 900 ligne(s) rangées.');
    expect(t.els['loyers-fichier']!.value).toBe('');
  });

  it('[R122] un gros fichier se range en plusieurs appels du même fichier, avec l’avancée dite', async () => {
    let n = 0;
    const answers = [part(300), part(600), done({ created: false })];
    const t = await run({ [POST]: async () => answers[n++]!() });
    t.fill();
    await t.press('loyers-importer');
    expect(t.posts()).toHaveLength(3);
    expect(new Set(t.posts().map((c) => JSON.stringify(c.body))).size).toBe(1);
    expect(t.state()).toBe('Import fait : 900 ligne(s) rangées.');
  });

  it('un import qui n’avance plus s’arrête et le dit, sans boucler', async () => {
    const t = await run({ [POST]: part(300) });
    t.fill();
    await t.press('loyers-importer');
    expect(t.posts().length).toBeLessThanOrEqual(4);
    expect(t.state()).toContain('n’avance plus');
  });

  it('un fichier déjà importé ou repris jusqu’au bout est dit importé en entier', async () => {
    const t = await run({ [POST]: done({ created: false }) });
    t.fill();
    await t.press('loyers-importer');
    expect(t.state()).toBe('Ce fichier est importé en entier : 900 ligne(s).');
  });

  it('[R122] un fichier mal formé est dit ligne à ligne en français, et rien n’est dit rangé', async () => {
    const errors = Array.from({ length: 25 }, (_, i) => ({ line: i + 2, code: i === 1 ? 'code_inconnu' : 'loyer' }));
    const t = await run({ [POST]: no(409, { ok: false, rule: 'R122', code: 'lignes', errors }) });
    t.fill();
    await t.press('loyers-importer');
    expect(t.state()).toBe('Fichier refusé : 25 ligne(s) à reprendre. Rien n’est rangé.');
    expect(t.list()[0]).toBe('Ligne 2 : loyer illisible.');
    expect(t.list()[1]).toBe('Ligne 3 : ligne illisible.');
    expect(t.list()).toHaveLength(21);
    expect(t.list()[20]).toBe('Et 5 autre(s).');
  });

  it.each([
    ['entete', 'n’a pas les colonnes'],
    ['vide', 'Ce fichier est vide'],
    ['trop_long', 'trop de lignes'],
    ['millesime', 'Le millésime'],
    ['invalid_body', 'trop lourd'],
    ['role', 'pas dans vos droits'],
  ])('[R16] [R122] le refus %s est dit en français', async (code, said) => {
    const t = await run({ [POST]: no(code === 'role' ? 403 : 409, { ok: false, rule: 'R122', code }) });
    t.fill();
    await t.press('loyers-importer');
    expect(t.state()).toContain(said);
    expect(t.state()).not.toMatch(/entete|trop_long|invalid_body/);
  });

  it('rien ne part sans le type, le millésime, le fichier, ni au-delà du poids admis', async () => {
    const t = await run({ [POST]: done() });
    await t.press('loyers-importer');
    expect(t.state()).toContain('type de logement');
    t.els['loyers-type']!.value = 'house';
    await t.press('loyers-importer');
    expect(t.state()).toContain('Le millésime');
    t.els['loyers-millesime']!.value = '26';
    await t.press('loyers-importer');
    expect(t.state()).toContain('Le millésime');
    t.els['loyers-millesime']!.value = '2026';
    await t.press('loyers-importer');
    expect(t.state()).toBe('Choisissez le fichier.');
    t.fill(file(LOYERS_MAX_BYTES + 1));
    await t.press('loyers-importer');
    expect(t.state()).toContain('dépasse 8 Mo');
    expect(t.posts()).toEqual([]);
    expect(LOYERS_MAX_BYTES).toBe(MAX_RENTS_FILE_BYTES);
  });

  it('[R10] une réponse perdue, une panne ou une réponse illisible ne disent ni fait ni refusé', async () => {
    const t = await run();
    t.fill();
    await t.press('loyers-importer');
    expect(t.state()).toContain('La réponse n’est pas arrivée');
    expect(t.state()).toContain('reprend où il en était');
    t.table[POST] = no(500, { ok: false, code: 'panne' });
    await t.press('loyers-importer');
    expect(t.state()).toContain('La réponse n’est pas arrivée');
    t.table[POST] = async () => new Response('pas du JSON', { status: 200 });
    await t.press('loyers-importer');
    expect(t.state()).toContain('La réponse n’est pas arrivée');
  });

  it('un fichier illisible sur l’appareil n’envoie rien', async () => {
    const t = await run({ [POST]: done() });
    t.fill(file(10, async () => Promise.reject(new Error('illisible'))));
    await t.press('loyers-importer');
    expect(t.state()).toContain('illisible sur cet appareil');
    expect(t.posts()).toEqual([]);
  });

  it('[R122] le loyer d’une commune dit ses chiffres, sa source exacte, sa date et sa fiabilité', async () => {
    const url = 'GET /v1/investir/loyers?insee=99001&type=apartment';
    const t = await run({ [url]: ok(KNOWN) });
    t.els['loyers-type']!.value = 'apartment';
    t.els['loyers-commune']!.value = ' 99001 ';
    await t.press('loyers-lire');
    expect(t.list().slice(0, 4)).toEqual([
      '12,35 € le m², charges comprises, entre 10,10 € et 15,01 €.',
      '120 observation(s).',
      'Carte des loyers 2026, appartements, toutes tailles, importée le 10/01/2027.',
      `${ANIL_CITATION}, millésime 2026`,
    ]);
    t.table[url] = ok({ ...KNOWN, observations: 4, reliability: 'peu_observations', reasons: ['observations'] });
    await t.press('loyers-lire');
    expect(t.list()[1]).toContain('peu d’observations');
    t.table[url] = ok({ ...KNOWN, source: 'reseau', kind: 'all', vintage: null, importId: null, citation: 'Locations du réseau' });
    await t.press('loyers-lire');
    expect(t.list()[2]).toContain('Locations du réseau dans la commune, tous types confondus');
  });

  it('[R122] un repli sur un autre type de logement est dit, le chiffre ne passe pas pour celui demandé', async () => {
    const t = await run({ 'GET /v1/investir/loyers?insee=99001&type=apartment_t1_t2': ok(KNOWN) });
    t.els['loyers-type']!.value = 'apartment_t1_t2';
    t.els['loyers-commune']!.value = '99001';
    await t.press('loyers-lire');
    expect(t.list()[2]).toBe('Carte des loyers 2026, appartements, toutes tailles, faute de données pour le type demandé, importée le 10/01/2027.');
  });

  it('[R10] [R122] le même fichier sous un autre millésime : refusé, et jamais dit fait', async () => {
    const t = await run({ [POST]: no(409, { ok: false, rule: 'R122', code: 'millesime_different', vintage: 2025 }) });
    t.fill();
    await t.press('loyers-importer');
    expect(t.state()).toBe('Ce fichier est déjà rangé avec le millésime 2025, qui ne change plus : rien de nouveau n’est rangé.');
  });

  it('[R10] sans donnée, l’écran dit inconnu, jamais un chiffre', async () => {
    const t = await run({ 'GET /v1/investir/loyers?insee=2A004&type=house': ok({ status: 'inconnu', inseeCode: '2A004', kind: 'house' }) });
    t.els['loyers-type']!.value = 'house';
    t.els['loyers-commune']!.value = '2a004';
    await t.press('loyers-lire');
    expect(t.state()).toContain('Inconnu');
    expect(t.list()).toHaveLength(1);
    expect(t.list()[0]).toContain('Règles de location de la commune');
  });

  it('un code de commune illisible ou un type absent ne part pas ; hors réseau et refus sont dits', async () => {
    const t = await run();
    t.els['loyers-commune']!.value = '123';
    await t.press('loyers-lire');
    expect(t.state()).toContain('Le code INSEE');
    t.els['loyers-commune']!.value = '99001';
    await t.press('loyers-lire');
    expect(t.state()).toContain('type de logement');
    expect(t.calls.filter((c) => c.url.startsWith('/v1/investir/loyers'))).toEqual([]);
    t.els['loyers-type']!.value = 'apartment';
    await t.press('loyers-lire');
    expect(t.state()).toBe('Pas de réseau. Réessayez dans un moment.');
    t.table['GET /v1/investir/loyers?insee=99001&type=apartment'] = no(403, { ok: false, rule: 'R16', code: 'role' });
    await t.press('loyers-lire');
    expect(t.state()).toBe('Ce n’est pas dans vos droits.');
  });

  it('un double appui n’envoie qu’une fois ; quitter efface ce qui est montré et ce qui est saisi', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => { release = r; });
    const t = await run({ [POST]: async () => { await held; return done()(); } });
    t.fill();
    await t.press('loyers-importer');
    await t.press('loyers-importer');
    expect(t.posts()).toHaveLength(1);
    release();
    await settle();
    expect(t.state()).toContain('Import fait');
    t.els.sortir!.listeners.click!({});
    await settle();
    expect(t.state()).toBe('');
    expect(t.els['loyers-liste']!.children).toEqual([]);
    expect(t.els['loyers-millesime']!.value).toBe('');
  });

  it('[R201] le script est servi à part, jamais gardé sur l’appareil, et tient son budget ; aucun code de page', () => {
    expect(AGENT_APP_FILES['/app/loyers.js']).toBe(LOYERS_SCRIPT);
    expect(AGENT_APP_SHELL).not.toContain('/app/loyers.js');
    expect(handleAgentApp(new Request('https://x.test/app/loyers.js'))?.status).toBe(200);
    expect(budgetProblems({ html: '', js: LOYERS_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: JS }, BUDGETS.application)).toEqual([]);
    expect(LOYERS_SCRIPT).not.toContain('innerHTML');
  });

  describe('Y11 · les règles de location d’une commune', () => {
    const READ = 'GET /v1/investir/regles?insee=99001';
    const POST_RULE = 'POST /v1/investir/regles';
    const RENT = 'GET /v1/investir/loyers?insee=99001&type=apartment';
    const RULE = { rule: 'encadrement_loyers', label: 'Encadrement des loyers', effectiveFrom: '2025-03-01', effectiveUntil: '2030-03-01', source: 'Délibération <img src=x>', sourceDate: '2025-01-15' };
    const open = async (data: unknown, answers: Record<string, Answer> = {}) => {
      const t = await run({ [RENT]: ok(KNOWN), [READ]: ok(data), ...answers });
      t.els['loyers-type']!.value = 'apartment';
      t.els['loyers-commune']!.value = '99001';
      await t.press('loyers-lire');
      const box = t.els['loyers-liste']!;
      const input = (label: string) => {
        const l = box.all().find((e) => e.tagName === 'label' && e.textContent === label);
        if (!l) throw new Error(`libellé absent : ${label}`);
        return box.all().find((e) => e.attributes.id === l.attributes.for)!;
      };
      const save = () => box.all().find((e) => e.tagName === 'button' && e.textContent === 'Ranger cette règle');
      const fill = () => {
        input('Règle').value = 'encadrement_loyers';
        input('En vigueur depuis').value = '2025-03-01';
        input('Source : la délibération ou le texte').value = 'Délibération inventée';
        input('Date de la source').value = '2025-01-15';
      };
      return { ...t, box, input, save, fill };
    };

    it('[R10] [Y11] après le loyer, chaque règle dit sa source et sa date, en texte ; sans droit, pas de formulaire', async () => {
      const t = await open({ canRecord: false, rules: [RULE] });
      expect(t.box.textContent).toContain('Encadrement des loyers, depuis le 01/03/2025, jusqu’au 01/03/2030. Source : Délibération <img src=x>, 15/01/2025.');
      expect(t.save()).toBeUndefined();
      expect(LOYERS_SCRIPT).not.toMatch(/innerHTML|insertAdjacentHTML/);
    });

    it('[R10] [Y11] sans règle rangée, rien n’affirme qu’il n’y en a pas ; le loyer inconnu n’empêche pas de les lire', async () => {
      const t = await open({ canRecord: false, rules: [] }, { [RENT]: ok({ status: 'inconnu' }) });
      expect(t.state()).toContain('Inconnu');
      expect(t.box.textContent).toContain('Cela ne prouve pas qu’il n’y en a pas');
    });

    it('[R16] [Y11] la direction, sur l’écran du réseau, range une règle : ce qu’elle a écrit part, puis la commune est relue', async () => {
      expect(AGENT_APP_FILES['/app/reseau']).toContain('id="loyers-commune"');
      let rules: unknown[] = [];
      const t = await open(null, {
        [READ]: async () => Response.json({ ok: true, data: { canRecord: true, rules } }),
        [POST_RULE]: async () => { rules = [RULE]; return Response.json({ ok: true, data: { effectiveFrom: '2025-03-01', effectiveUntil: null } }); },
      });
      t.fill();
      t.save()!.listeners.click!({});
      await settle();
      expect(t.posts().at(-1)!.body).toEqual({ inseeCode: '99001', rule: 'encadrement_loyers', effectiveFrom: '2025-03-01', effectiveUntil: null, source: 'Délibération inventée', sourceDate: '2025-01-15' });
      expect(t.state()).toBe('Règle rangée, en vigueur à partir du 01/03/2025.');
      expect(t.box.textContent).toContain('Encadrement des loyers');
    });

    describe('X21 · la zone de loyer', () => {
      const POST_ZONE = 'POST /v1/location/zones';
      const LIST = 'GET /v1/location/zones?insee=99001';
      const OLD = { zone: 'tres_tendue', effectiveFrom: '2025-03-01', source: 'Texte <img src=x>' };
      const zone = async (answers: Record<string, Answer> = {}, data: unknown = { canRecord: true, rules: [] }) => {
        const t = await open(data, { [LIST]: ok([]), ...answers });
        const press = async () => {
          t.box.all().find((e) => e.tagName === 'button' && e.textContent === 'Ranger cette zone')!.listeners.click!({});
          await settle();
        };
        const fillZone = (day = '2025-03-01') => {
          t.input('Zone').value = 'tendue';
          t.input('Zone en vigueur depuis').value = day;
          t.input('Source de la zone : le texte qui la fixe').value = 'Texte inventé';
        };
        const sent = () => t.posts().filter((c) => c.url === '/v1/location/zones');
        return { ...t, press, fillZone, sent };
      };

      it('[R16] sans droit, ni liste ni formulaire ; la direction range la zone telle qu’écrite, puis tout est relu', async () => {
        const reader = await zone({}, { canRecord: false, rules: [] });
        expect(reader.box.textContent).not.toContain('Ranger cette zone');
        expect(reader.calls.some((c) => c.url === '/v1/location/zones?insee=99001')).toBe(false);
        const t = await zone({ [POST_ZONE]: ok(true) });
        expect(t.box.textContent).toContain('Aucune zone rangée : le plafond le plus bas s’applique.');
        t.fillZone();
        await t.press();
        expect(t.sent().at(-1)!.body).toEqual({ inseeCode: '99001', zone: 'tendue', effectiveFrom: '2025-03-01', source: 'Texte inventé' });
        expect(t.state()).toBe('Zone tendue rangée, avec effet au 01/03/2025.');
        expect(t.calls.at(-1)!.url).toBe('/v1/location/zones?insee=99001');
      });

      it('[R10] les zones rangées sont lues : celle qui décide, celle remplacée, celle à venir, chacune avec sa source', async () => {
        const t = await zone({ [LIST]: ok([{ zone: 'autre', effectiveFrom: '2099-01-01', source: 'À venir' }, { zone: 'tendue', effectiveFrom: '2025-03-01', source: 'Texte <img src=x>' }, { zone: 'autre', effectiveFrom: '2020-01-01', source: 'Ancien' }]) });
        const text = t.box.textContent;
        expect(text).toContain('Autre zone, à venir : décide déjà pour un bail qui commence à partir du 01/01/2099. Source : À venir.');
        expect(text).toContain('Zone tendue, en vigueur depuis le 01/03/2025. Source : Texte <img src=x>.');
        expect(text).toContain('Autre zone, remplacée, depuis le 01/01/2020.');
      });

      it('[R102] une date plus ancienne que la dernière ne corrige rien : dit, et il faut appuyer de nouveau', async () => {
        const t = await zone({ [LIST]: ok([OLD]), [POST_ZONE]: ok(true) });
        t.fillZone('2023-08-26');
        await t.press();
        expect(t.sent()).toEqual([]);
        expect(t.state()).toContain('elle ne changera pas la zone en vigueur');
        await t.press();
        expect(t.sent().length).toBe(1);
      });

      it('[R102] une date dans le futur est dite ; changer la saisie redemande', async () => {
        const t = await zone({ [POST_ZONE]: ok(true) });
        t.fillZone('2099-01-01');
        await t.press();
        expect(t.sent()).toEqual([]);
        expect(t.state()).toContain('Cette date est dans le futur');
        t.fillZone('2098-01-01');
        await t.press();
        expect(t.sent()).toEqual([]);
        await t.press();
        expect(t.sent().length).toBe(1);
      });

      it('[R10] le message dit ce qui est parti, même si un champ change pendant l’envoi', async () => {
        let release: (r: Response) => void = () => undefined;
        const t = await zone({ [POST_ZONE]: () => new Promise<Response>((r) => { release = r; }) });
        t.fillZone();
        await t.press();
        t.input('Zone').value = '';
        t.input('Zone en vigueur depuis').value = '';
        release(Response.json({ ok: true, data: true }));
        await settle();
        expect(t.state()).toBe('Zone tendue rangée, avec effet au 01/03/2025.');
      });

      it('[R10] rien n’est choisi d’avance : sans zone, rien ne part ; une liste non lue n’ouvre pas de formulaire', async () => {
        const t = await zone({ [POST_ZONE]: ok(true) });
        expect(t.input('Zone').value).toBe('');
        await t.press();
        expect(t.sent()).toEqual([]);
        expect(t.state()).toBe('Choisissez la zone.');
        const down = await zone({ [LIST]: no(500, { ok: false }) });
        expect(down.box.textContent).toContain('Zone indisponible pour le moment.');
        expect(down.box.textContent).not.toContain('Ranger cette zone');
        const off = await zone({ [LIST]: () => Promise.reject(new TypeError('hors ligne')) });
        expect(off.box.textContent).toContain('Pas de réseau pour la zone');
      });

      it('[R10] la commune changée depuis la lecture : rien ne part', async () => {
        const t = await zone({ [POST_ZONE]: ok(true) });
        t.fillZone();
        t.els['loyers-commune']!.value = '99002';
        await t.press();
        expect(t.sent()).toEqual([]);
        expect(t.state()).toContain('Le code de la commune a changé');
      });

      it.each([
        [403, 'role', 'Ce n’est pas dans vos droits.'],
        [400, 'bad_source', 'Écrivez la source de la zone'],
        [400, 'bad_date', 'Le jour d’entrée en vigueur'],
        [400, 'already_recorded', 'Pour corriger, choisissez une date d’effet plus récente.'],
        [400, 'autre_chose', 'La zone n’est pas rangée.'],
      ] as [number, string, string][])('[R16] refus %i %s : dit en français, la saisie reste', async (status, code, text) => {
        const t = await zone({ [POST_ZONE]: no(status, { ok: false, rule: null, code }) });
        t.fillZone();
        await t.press();
        expect(t.state()).toContain(text);
        expect(t.input('Source de la zone : le texte qui la fixe').value).toBe('Texte inventé');
      });

      it.each([
        ['hors ligne', () => Promise.reject(new TypeError('hors ligne'))],
        ['une panne', async () => Response.json({ ok: false }, { status: 500 })],
        ['un succès coupé', async () => new Response('{"ok":tr', { status: 200 })],
      ] as [string, Answer][])('réponse perdue (%s) : dite telle', async (_n, answer) => {
        const t = await zone({ [POST_ZONE]: answer });
        t.fillZone();
        await t.press();
        expect(t.state()).toContain('La réponse n’est pas arrivée : rien n’est sûr.');
      });
    });

    it('[Y11] la règle rangée est dite telle, même si la relecture se perd', async () => {
      let reads = 0;
      const t = await open(null, {
        [READ]: async () => { reads += 1; if (reads > 1) throw new TypeError('hors ligne'); return Response.json({ ok: true, data: { canRecord: true, rules: [] } }); },
        [POST_RULE]: ok({ effectiveFrom: '2025-03-01', effectiveUntil: null }),
      });
      t.fill();
      t.save()!.listeners.click!({});
      await settle();
      expect(t.state()).toBe('Règle rangée, en vigueur à partir du 01/03/2025.');
      expect(t.box.textContent).toContain('Pas de réseau pour les règles');
    });

    it('[Y11] une règle déjà finie est dite finie, jamais « en vigueur »', async () => {
      const t = await open({ canRecord: true, rules: [] }, { [POST_RULE]: ok({ effectiveFrom: '2015-01-01', effectiveUntil: '2018-01-01' }) });
      t.fill();
      t.save()!.listeners.click!({});
      await settle();
      expect(t.state()).toContain('finie le 01/01/2018');
      expect(t.state()).not.toContain('en vigueur à partir');
    });

    it('[Y11] la commune retapée sans relecture ne reçoit rien', async () => {
      const t = await open({ canRecord: true, rules: [] });
      t.fill();
      t.els['loyers-commune']!.value = '99002';
      t.save()!.listeners.click!({});
      await settle();
      expect(t.posts()).toHaveLength(0);
      expect(t.state()).toContain('relisez cette commune');
    });

    it('[Y11] refus en français, réponse perdue dite telle, double appui un seul envoi', async () => {
      for (const [code, text] of [['source', 'Écrivez la source'], ['date_source', 'un jour déjà passé'], ['date', 'Les dates de la règle'], ['regle', 'Choisissez la règle'], ['role', 'pas dans vos droits']] as const) {
        const t = await open({ canRecord: true, rules: [] }, { [POST_RULE]: no(409, { ok: false, rule: 'R124', code }) });
        t.fill();
        t.save()!.listeners.click!({});
        await settle();
        expect(t.state()).toContain(text);
      }
      const lost = await open({ canRecord: true, rules: [] });
      lost.fill();
      lost.save()!.listeners.click!({});
      await settle();
      expect(lost.state()).toContain('rien n’est sûr');
      expect(lost.state()).not.toContain('Règle rangée');
      let answer: (r: Response) => void = () => undefined;
      const twice = await open({ canRecord: true, rules: [] }, { [POST_RULE]: () => new Promise<Response>((r) => { answer = r; }) });
      twice.fill();
      const b = twice.save()!;
      b.listeners.click!({});
      b.listeners.click!({});
      await settle();
      expect(twice.posts()).toHaveLength(1);
      answer(Response.json({ ok: false, rule: 'R124', code: 'source' }, { status: 409 }));
      await settle();
      b.listeners.click!({});
      await settle();
      expect(twice.posts()).toHaveLength(2);
    });

    it('[Y11] les règles perdues sont dites à part, le loyer reste lu', async () => {
      const t = await run({ [RENT]: ok(KNOWN), [READ]: () => Promise.reject(new TypeError('hors ligne')) });
      t.els['loyers-type']!.value = 'apartment';
      t.els['loyers-commune']!.value = '99001';
      await t.press('loyers-lire');
      expect(t.els['loyers-liste']!.textContent).toContain('Pas de réseau pour les règles');
      expect(t.els['loyers-liste']!.textContent).toContain('12,35 €');
    });
  });
});
