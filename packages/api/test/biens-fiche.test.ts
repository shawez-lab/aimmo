import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, NAME_CORRECTION_REASONS, NEW_PROPERTY_KINDS, SqlJournalStore, applyMigrations, fromSyncSqlite, type Viewer } from '@aimmo/core';
import { BIENS_FICHE_SCRIPT, CORRECTION_REASONS, KIND_LABELS } from '../app/biens-fiche.ts';
import { BUDGETS, budgetProblems } from '../../core/src/design/audit.ts';
import { AGENT_APP_FILES, AGENT_APP_SHELL } from '../src/agent-app.ts';
import { biensFicheRoutes, type BiensFicheServices } from '../src/biens-fiche.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé.
const BODY = { requestId: '0b6f1d2e-5555-4a2b-8c3d-000000000010', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 62, rooms: 3, priceEur: 200000 };

async function routes() {
  const now = () => new Date('2027-02-03T10:00:00.000Z');
  const db = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const acces = new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now });
  const network = await store.createNetwork('Réseau Essai');
  const a = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Essai' });
  const b = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Essai' });
  const as = (role: string, userId: string): Viewer => ({ role, userId, networkId: network.id }) as Viewer;
  const person = await store.createPerson({ networkId: network.id, agentId: a.id, firstName: 'Client' });
  const s: BiensFicheServices = { db, acces, journal, now };
  const call = async (viewer: Viewer, method: string, body?: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) => {
    const path = `/fiches/${person.id}/biens`;
    const route = biensFicheRoutes().find((r) => r.method === method && r.pattern.test(path))!;
    const request = new Request(`https://api.example.test/v1${path}`, { method, ...(method === 'POST' ? { headers, body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
    const response = await route.handle(s, viewer, route.pattern.exec(path)!.slice(1), request);
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  return { db, journal, call, alex: as('agent', a.id), sam: as('agent', b.id), assistant: as('assistant', 'as-1') };
}

describeWithSqlite('SV06 · routes des biens de la fiche', () => {
  it('[R26] l’agent crée puis relit le bien ; rien n’est envoyé', async () => {
    const t = await routes();
    const created = await t.call(t.alex, 'POST', BODY);
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ ok: true, sent: false, mode: 'essai', data: { already: false, status: 'draft' } });
    const read = await t.call(t.alex, 'GET');
    expect(read.body.data).toHaveLength(1);
    expect(read.body.data[0].reference).toBe(created.body.data.reference);
  });

  it('[R16] un autre agent et un autre rôle sont refusés, le corps n’est pas lu', async () => {
    const t = await routes();
    expect((await t.call(t.sam, 'POST', BODY)).status).toBe(403);
    expect(await t.call(t.assistant, 'POST', 'pas du json')).toMatchObject({ status: 403, body: { code: 'role' } });
    expect(await t.db.all('SELECT id FROM properties')).toEqual([]);
  });

  it('un corps illisible, un champ en trop, une saisie fausse : 400', async () => {
    const t = await routes();
    expect(await t.call(t.alex, 'POST', 'pas du json')).toMatchObject({ status: 400, body: { code: 'invalid_body' } });
    expect(await t.call(t.alex, 'POST', BODY, { 'content-type': 'text/plain' })).toMatchObject({ status: 400, body: { code: 'invalid_body' } });
    expect(await t.call(t.alex, 'POST', 'x'.repeat(3000))).toMatchObject({ status: 400, body: { code: 'invalid_body' } });
    expect(await t.call(t.alex, 'POST', { ...BODY, agentId: 'autre' })).toMatchObject({ status: 400, body: { code: 'unexpected_field' } });
    expect(await t.call(t.alex, 'POST', { ...BODY, postalCode: 'x' })).toMatchObject({ status: 400, body: { code: 'bad_postal_code' } });
  });
});

describe('SV06 · le bloc de la fiche', () => {
  const KEY = 'k'.repeat(40);
  const HTML = AGENT_APP_FILES['/app/']!;
  const ID = '0b6f1d2e-5555-4a2b-8c3d-000000000001';
  const FICHE = { personId: ID, firstName: 'Client', lastName: null, contact: { allowed: true, reasons: [] }, call: null, callRefusal: 'no_phone', callClosesAt: null, callbacks: [], projects: [], sources: [], qualification: null, messages: [] };
  const PLAN = { agentId: 'a1', day: '2026-11-10', computedAt: '2026-11-10T06:30:00.000Z', items: [{ rank: 1, personId: ID, firstName: 'Client', kind: 'callback', reason: 'Rappel', callbackDueAt: null }] };
  const PATH = `/v1/fiches/${ID}/biens`;
  const BIEN = { propertyId: 'x', reference: 'B-ABCD1234', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 62, rooms: null, priceEur: null, status: 'draft' };
  type Call = { url: string; method: string; body: Record<string, unknown> | null };
  const ok = (data: unknown) => async () => Response.json({ ok: true, mode: 'essai', data });

  async function opened(answers: Record<string, (init: { method?: string }) => Promise<Response>> = {}) {
    const { els, listeners, document } = fakeDocument(pageIds(HTML));
    const storage = new Map<string, string>([['aimmo.cle', KEY]]);
    const calls: Call[] = [];
    let keys = 0;
    const answersAll: Record<string, (init: { method?: string }) => Promise<Response>> = {
      '/v1/moi': async () => Response.json({ ok: true, data: { role: 'agent', firstName: 'Alex' } }),
      '/v1/plan-du-jour': ok(PLAN),
      '/v1/contacts-chauds': ok({ slot: 'morning', contacts: [] }),
      '/v1/rendez-vous/jour': ok({ day: '2026-11-10', appointments: [] }),
      [`/v1/fiches/${ID}/resume`]: ok(FICHE),
      [PATH]: ok([]),
      ...answers,
    };
    const context: Record<string, unknown> = {
      document,
      Date,
      Object,
      crypto: { randomUUID: () => `0b6f1d2e-6666-4a2b-8c3d-${String(++keys).padStart(12, '0')}` },
      localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
      fetch: (url: string, init: { method?: string; body?: string }) => {
        calls.push({ url, method: init.method ?? 'GET', body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null });
        const answer = answersAll[url];
        return answer ? answer(init) : Promise.reject(new TypeError('hors ligne'));
      },
      navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
    };
    runInNewContext(AGENT_APP_FILES['/app/app.js']!, context);
    listeners.DOMContentLoaded!();
    const tick = async () => {
      for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    };
    await tick();
    const named = (root: FakeElement, text: string) => root.all().filter((e) => e.tagName === 'button' && e.textContent === text);
    named(els.plan!, 'Voir la fiche')[0]!.listeners.click!({});
    await tick();
    const body = els['fiche-corps']!;
    const scripts = () => body.all().filter((e) => e.tagName === 'script' && e.attributes.src === '/app/biens-fiche.js');
    const load = async () => {
      runInNewContext(BIENS_FICHE_SCRIPT, context);
      for (const e of scripts()) e.listeners.load!({});
      await tick();
    };
    const input = (suffix: string) => body.all().find((e) => e.tagName === 'input' && (e.attributes.id ?? '').endsWith(suffix))!;
    const fill = (v: Record<string, string>) => {
      for (const [k, value] of Object.entries(v)) input(k).value = value;
    };
    const posts = () => calls.filter((c) => c.method === 'POST' && c.url === PATH);
    return { body, calls, tick, named, scripts, load, input, fill, posts, answersAll };
  }
  const GOOD = { '-cp': '21000', '-commune': 'Dijon', '-surface': '62', '-pieces': '3', '-prix': '200000' };
  const POST_THEN = (post: () => Promise<Response>) => ({ [PATH]: (init: { method?: string }) => (init.method === 'POST' ? post() : ok([])()) });

  it('les types offerts sont ceux du socle', () => {
    expect(Object.keys(KIND_LABELS).sort()).toEqual([...NEW_PROPERTY_KINDS].sort());
  });

  it('[R201] chargé à part, à l’ouverture d’une fiche : il liste les biens et ne pèse pas sur l’application', async () => {
    const a = await opened({ [PATH]: ok([BIEN]) });
    expect(a.scripts()).toHaveLength(1);
    await a.load();
    expect(a.body.textContent).toContain('Réf. B-ABCD1234 : Maison ou appartement, Dijon, 62 m².');
    expect(AGENT_APP_SHELL).not.toContain('/app/biens-fiche.js');
    expect(AGENT_APP_FILES['/app/biens-fiche.js']!).toContain('AIMMO_BIENS_FICHE');
    expect(budgetProblems({ html: '', js: BIENS_FICHE_SCRIPT }, BUDGETS.page)).toEqual([]);
    expect(budgetProblems({ html: HTML, css: AGENT_APP_FILES['/app/app.css']!, js: AGENT_APP_FILES['/app/app.js']! }, BUDGETS.application)).toEqual([]);
  });

  it('[R16] le bien part sans identifiant à saisir, une seule fois, et s’ajoute à la liste', async () => {
    const a = await opened(POST_THEN(ok({ ...BIEN, already: false })));
    await a.load();
    a.fill(GOOD);
    // AU070 · maison ou appartement, dit dès la création d'un logement.
    a.body.all().find((e) => e.tagName === 'select' && (e.attributes.id ?? '').endsWith('-logement'))!.value = 'house';
    const b = a.named(a.body, 'Créer le bien')[0]!;
    b.listeners.click!({});
    b.listeners.click!({});
    await a.tick();
    expect(a.posts()).toEqual([{ url: PATH, method: 'POST', body: { requestId: '0b6f1d2e-6666-4a2b-8c3d-000000000001', kind: 'home', dwelling: 'house', postalCode: '21000', city: 'Dijon', surfaceM2: 62, rooms: 3, priceEur: 200000 } }]);
    // Le formulaire est vidé, prêt pour un autre bien, avec une demande neuve.
    expect(a.input('-commune').value).toBe('');
    expect(a.body.textContent).toContain('Bien créé, réf. B-ABCD1234');
    expect(a.body.textContent).toContain('Réf. B-ABCD1234');
  });

  it('une saisie fausse se dit avant tout envoi', async () => {
    const a = await opened();
    await a.load();
    const go = async (v: Record<string, string>) => {
      a.fill({ ...GOOD, ...v });
      a.named(a.body, 'Créer le bien')[0]!.listeners.click!({});
      await a.tick();
    };
    await go({ '-cp': '21' });
    expect(a.body.textContent).toContain('Le code postal : cinq chiffres.');
    await go({ '-commune': '' });
    expect(a.body.textContent).toContain('La commune');
    await go({ '-surface': 'grand' });
    expect(a.body.textContent).toContain('La surface');
    await go({ '-prix': '200 000 €' });
    expect(a.body.textContent).toContain('Le prix');
    expect(a.posts()).toEqual([]);
  });

  it('un refus du serveur se dit en français ; une réponse perdue se dit telle, et le nouvel essai ne double rien', async () => {
    const refused = await opened(POST_THEN(async () => Response.json({ ok: false, rule: null, code: 'no_agent' }, { status: 400 })));
    await refused.load();
    refused.fill(GOOD);
    refused.named(refused.body, 'Créer le bien')[0]!.listeners.click!({});
    await refused.tick();
    expect(refused.body.textContent).toContain('Cette fiche n’a pas encore d’agent');

    const lost = await opened(POST_THEN(() => Promise.reject(new TypeError('hors ligne'))));
    await lost.load();
    lost.fill(GOOD);
    lost.named(lost.body, 'Créer le bien')[0]!.listeners.click!({});
    await lost.tick();
    expect(lost.body.textContent).toContain('le bien est peut-être créé');
    expect(lost.body.textContent).toContain('il ne sera pas créé deux fois');
  });

  it('un bien déjà créé se dit tel, et n’apparaît pas deux fois', async () => {
    const a = await opened({ [PATH]: (init: { method?: string }) => (init.method === 'POST' ? ok({ ...BIEN, already: true })() : ok([BIEN])()) });
    await a.load();
    a.fill(GOOD);
    a.named(a.body, 'Créer le bien')[0]!.listeners.click!({});
    await a.tick();
    expect(a.body.textContent).toContain('Ce bien existe déjà');
    expect(a.body.all().filter((e) => e.tagName === 'li' && e.textContent.startsWith('Réf. B-ABCD1234'))).toHaveLength(1);
  });

  it('une panne du serveur ne dit jamais « pas créé » : même demande au nouvel essai', async () => {
    const a = await opened(POST_THEN(async () => new Response('passerelle', { status: 502 })));
    await a.load();
    a.fill(GOOD);
    a.named(a.body, 'Créer le bien')[0]!.listeners.click!({});
    await a.tick();
    expect(a.body.textContent).toContain('le bien est peut-être créé');
    a.named(a.body, 'Créer le bien')[0]!.listeners.click!({});
    await a.tick();
    const [one, two] = a.posts();
    expect(two!.body!.requestId).toBe(one!.body!.requestId);
  });

  it('un dossier d’agent incomplet se dit, sans inviter à réessayer', async () => {
    const a = await opened(POST_THEN(async () => Response.json({ ok: false, rule: 'R16', code: 'agent_file_incomplete' }, { status: 403 })));
    await a.load();
    a.fill(GOOD);
    a.named(a.body, 'Créer le bien')[0]!.listeners.click!({});
    await a.tick();
    expect(a.body.textContent).toContain('Votre dossier d’agent n’est pas complet');
  });

  it('[R201] téléphone d’abord : chaque champ a son libellé, les chiffres ouvrent le clavier numérique', async () => {
    const a = await opened();
    await a.load();
    const fields = a.body.all().filter((e) => ['input', 'select'].includes(e.tagName) && /-(type|cp|commune|surface|pieces|prix)$/.test(e.attributes.id ?? ''));
    expect(fields).toHaveLength(6);
    for (const f of fields) expect(a.body.all().some((l) => l.tagName === 'label' && l.attributes.for === f.attributes.id), f.attributes.id).toBe(true);
    for (const s of ['-cp', '-surface', '-pieces', '-prix']) expect(a.input(s).attributes.inputmode).toBe('numeric');
  });

  describe('SV07 · le nom du client', () => {
    const NOM = `/v1/fiches/${ID}/nom`;
    const named = (a: Awaited<ReturnType<typeof opened>>) => a.named(a.body, 'Compléter la fiche');

    it('[R201] une fiche complète ne le montre pas ; il manque, seul le champ vide est offert, avec son libellé', async () => {
      const full = await opened({ [`/v1/fiches/${ID}/resume`]: ok({ ...FICHE, lastName: 'Inventé' }) });
      await full.load();
      expect(named(full)).toHaveLength(0);
      const a = await opened();
      await a.load();
      expect(named(a)).toHaveLength(1);
      expect(a.input('-nom')).toBeDefined();
      expect(a.input('-prenom')).toBeUndefined();
      expect(a.body.all().some((l) => l.tagName === 'label' && l.attributes.for === a.input('-nom').attributes.id)).toBe(true);
    });

    it('[R16] le nom part une fois, sans identifiant à saisir, puis la fiche est relue', async () => {
      const a = await opened({ [NOM]: ok({ firstName: 'Client', lastName: 'Inventé' }) });
      await a.load();
      a.input('-nom').value = ' Inventé ';
      const b = named(a)[0]!;
      b.listeners.click!({});
      b.listeners.click!({});
      await a.tick();
      expect(a.calls.filter((c) => c.url === NOM)).toEqual([{ url: NOM, method: 'POST', body: { lastName: 'Inventé' } }]);
      expect(a.calls.filter((c) => c.url === `/v1/fiches/${ID}/resume`).length).toBeGreaterThanOrEqual(2);
    });

    it('rien d’écrit, un nom déjà écrit, une réponse perdue : chacun se dit', async () => {
      const empty = await opened();
      await empty.load();
      named(empty)[0]!.listeners.click!({});
      await empty.tick();
      expect(empty.body.textContent).toContain('Écrivez le nom à ajouter.');
      expect(empty.calls.filter((c) => c.url === NOM)).toEqual([]);

      const taken = await opened({ [NOM]: async () => Response.json({ ok: false, rule: null, code: 'already_named' }, { status: 409 }) });
      await taken.load();
      taken.input('-nom').value = 'Autre';
      named(taken)[0]!.listeners.click!({});
      await taken.tick();
      expect(taken.body.textContent).toContain('il ne se remplace pas ici');

      const lost = await opened({ [NOM]: () => Promise.reject(new TypeError('hors ligne')) });
      await lost.load();
      lost.input('-nom').value = 'Inventé';
      named(lost)[0]!.listeners.click!({});
      await lost.tick();
      expect(lost.body.textContent).toContain('le nom est peut-être écrit');
    });
  });

  describe('SV10 · la direction corrige un nom', () => {
    const CORR = `/v1/fiches/${ID}/nom/corrections`;
    const FULL = { ...FICHE, lastName: 'Exemple', nameCorrectable: true };
    const button = (a: Awaited<ReturnType<typeof opened>>) => a.named(a.body, 'Corriger le nom');
    const PAST = { id: 'c1', oldFirstName: 'Léo', oldLastName: 'Exempel', newFirstName: 'Client', newLastName: 'Exemple', reason: 'faute_de_frappe', actor: 'direction:d', at: '2027-01-02T10:00:00.000Z' };
    const press = async (a: Awaited<ReturnType<typeof opened>>) => {
      button(a)[0]!.listeners.click!({});
      await a.tick();
    };

    it('[R16] l’agent ne voit ni le bloc ni l’appel : il ne dépend que de ce que dit le serveur', async () => {
      const a = await opened({ [`/v1/fiches/${ID}/resume`]: ok({ ...FICHE, lastName: 'Exemple' }) });
      await a.load();
      expect(button(a)).toHaveLength(0);
      expect(a.calls.some((c) => c.url === CORR)).toBe(false);
    });

    it('[R17] la direction lit les valeurs d’avant ; les champs portent leur libellé et la valeur en vigueur', async () => {
      const a = await opened({ [`/v1/fiches/${ID}/resume`]: ok(FULL), [CORR]: ok([PAST]) });
      await a.load();
      expect(button(a)).toHaveLength(1);
      expect(a.body.textContent).toContain('2027-01-02 : Léo Exempel devient Client Exemple (Faute de frappe).');
      expect(a.input('-nom').value).toBe('Exemple');
      const motif = a.body.all().find((e) => e.tagName === 'select' && (e.attributes.id ?? '').endsWith('-motif'))!;
      expect(a.body.all().some((l) => l.tagName === 'label' && l.attributes.for === motif.attributes.id)).toBe(true);
    });

    it('la correction part avec son motif, un champ vidé part nul, puis la fiche est relue', async () => {
      const a = await opened({ [`/v1/fiches/${ID}/resume`]: ok(FULL), [CORR]: async (init) => (init.method === 'POST' ? Response.json({ ok: true, data: { firstName: null, lastName: 'Client', changed: true } }) : Response.json({ ok: true, data: [] })) });
      await a.load();
      a.input('-prenom').value = '  ';
      a.input('-nom').value = 'Client';
      await press(a);
      const post = a.calls.find((c) => c.method === 'POST' && c.url === CORR)!;
      expect(post.body).toEqual({ firstName: null, lastName: 'Client', reason: 'faute_de_frappe' });
      expect(a.calls.filter((c) => c.method === 'POST' && c.url === CORR)).toHaveLength(1);
      expect(a.calls.filter((c) => c.url === `/v1/fiches/${ID}/resume`)).toHaveLength(2);
    });

    it('un refus et une réponse perdue se disent, sans se dire faits', async () => {
      const refusal = await opened({ [`/v1/fiches/${ID}/resume`]: ok(FULL), [CORR]: async (init) => (init.method === 'POST' ? Response.json({ ok: false, code: 'name_changed' }, { status: 409 }) : Response.json({ ok: true, data: [] })) });
      await refusal.load();
      await press(refusal);
      expect(refusal.body.textContent).toContain('Ce nom vient de changer');
      const lost = await opened({ [`/v1/fiches/${ID}/resume`]: ok(FULL), [CORR]: async (init) => (init.method === 'POST' ? new Response('panne', { status: 500 }) : Response.json({ ok: true, data: [] })) });
      await lost.load();
      await press(lost);
      expect(lost.body.textContent).toContain('le nom est peut-être corrigé');
    });

    it('les motifs de l’écran sont ceux du socle ; [R201] le script tient son budget', () => {
      expect(Object.keys(CORRECTION_REASONS).sort()).toEqual([...NAME_CORRECTION_REASONS].sort());
      expect(budgetProblems({ html: '', js: BIENS_FICHE_SCRIPT }, BUDGETS.page)).toEqual([]);
    });
  });

  it('sans réseau, le bloc le dit, sans casser la fiche', async () => {
    const a = await opened();
    const [script] = a.scripts();
    script!.listeners.error!({});
    expect(a.body.textContent).toContain('Pas de réseau : les biens du client reviendront.');
  });
});
