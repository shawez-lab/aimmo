import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { runScheduler } from '../src/planificateur.ts';
import { SCENARIOS_JOB, refusalWords, scenariosJob, scenariosRoutes } from '../src/scenarios.ts';
import { FicheClient, Planificateur, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type SqlValue } from '../../core/src/index.ts';
import { AUTOMATION_PURPOSE } from '../../core/src/automatismes/scenarios.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Un mardi d'octobre, 10 h à Paris. Réseaux, agents, personnes, adresses et clés d'API inventés.
const TUE_10H = Date.parse('2027-10-12T08:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const KEYS = {
  direction: 'test-cle-br55-direction-aaaaaaaaaaaaaaaaaaaaaaa',
  alex: 'test-cle-br55-alex-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  conformite: 'test-cle-br55-conformite-cccccccccccccccccccc',
  ailleurs: 'test-cle-br55-ailleurs-dddddddddddddddddddddddd',
};
type Who = keyof typeof KEYS;

const WELCOME = {
  name: 'Bienvenue',
  trigger: 'nouveau_contact',
  waitHours: 0,
  message: { channel: 'email', text: 'Bonjour {prenom}, merci pour votre demande. Je vous rappelle très vite pour en parler.' },
  task: { title: 'Appeler le nouveau contact', dueInDays: 1 },
};

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = TUE_10H;
  const now = () => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const net = await store.createNetwork('Réseau test');
  const other = await store.createNetwork('Autre réseau');
  const alex = await store.createAgent({ networkId: net.id, firstName: 'Alex', lastName: 'Essai' });
  const ids: Record<Who, { role: string; userId: string; networkId: string }> = {
    direction: { role: 'direction', userId: 'direction-1', networkId: net.id },
    alex: { role: 'agent', userId: alex.id, networkId: net.id },
    conformite: { role: 'compliance', userId: 'conformite-1', networkId: net.id },
    ailleurs: { role: 'direction', userId: 'direction-2', networkId: other.id },
  };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), ...ids[w] }))));
  const config: ApiConfig = { db, apiKeys, mode: 'essai', now };
  const http = async (who: Who, method: 'GET' | 'POST', path: string, body?: unknown, raw?: string) => {
    const headers: Record<string, string> = { authorization: `Bearer ${KEYS[who]}` };
    if (body !== undefined || raw !== undefined) headers['content-type'] = 'application/json';
    const init: RequestInit = { method, headers };
    if (raw !== undefined) init.body = raw;
    else if (body !== undefined) init.body = JSON.stringify(body);
    const r = await handleRequest(new Request(`https://aimmo-api.example.test/v1${path}`, init), config);
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; rule?: string | null; code?: string; mode?: string; field?: string; message?: string } };
  };
  /** Une personne créée à l'heure de l'horloge, avec son mail et, par défaut, son accord aux messages de scénario. */
  const person = async (firstName: string, consent = true) => {
    const p = await store.createPerson({ networkId: net.id, agentId: alex.id, firstName });
    await store.addIdentifier({ networkId: net.id, personId: p.id, kind: 'email', value: `${firstName.toLowerCase()}@exemple.test` });
    if (consent) await store.addConsent({ networkId: net.id, personId: p.id, purpose: AUTOMATION_PURPOSE, channel: 'email', proof: 'case cochée (test)', givenAt: new Date(clock - HOUR) });
    return p.id;
  };
  const refusals = async () => (await journal.all()).filter((e) => e.type === 'acces.refuse' && e.data.kind === 'automation_scenario');
  const count = async (table: string) => (await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))!.n;
  const outbox = () => db.all<{ person_id: string; channel: string }>('SELECT m.person_id, o.channel FROM trial_outbox o JOIN messages m ON m.id = o.message_id ORDER BY m.rowid');
  /** Le passage des scénarios, seul. */
  const pass = async () => new Planificateur(db, journal, [scenariosJob(db, journal, { now })], { now }).tick();
  return { db, journal, net, other, http, person, refusals, count, outbox, pass, now, at: (t: number) => { clock = t; } };
}

/** Compose, essaie et allume un scénario par les routes ; rend son identifiant. */
async function lit(t: Awaited<ReturnType<typeof setup>>, definition: unknown = WELCOME): Promise<string> {
  const composed = await t.http('direction', 'POST', '/scenarios', definition);
  expect(composed.status).toBe(200);
  const id = composed.body.data.scenarioId as string;
  expect((await t.http('direction', 'POST', `/scenarios/${id}/essai`)).status).toBe(200);
  expect((await t.http('direction', 'POST', `/scenarios/${id}/allumer`)).status).toBe(200);
  return id;
}

describeWithSqlite('BR55 · routes des scénarios automatiques, et leur passage au planificateur', () => {
  it('[R16] [R403] chaque route refuse tout autre rôle que la direction en 403, au journal, avant de lire le corps', async () => {
    const t = await setup();
    const cases: [Who, 'GET' | 'POST', string, string?][] = [
      ['alex', 'GET', '/scenarios'],
      ['alex', 'POST', '/scenarios', '{pas du json'],
      ['conformite', 'POST', '/scenarios', JSON.stringify(WELCOME)],
      ['alex', 'POST', '/scenarios/s1', '{pas du json'],
      ['alex', 'POST', '/scenarios/s1/essai'],
      ['conformite', 'POST', '/scenarios/s1/allumer'],
      ['alex', 'POST', '/scenarios/s1/eteindre'],
    ];
    for (const [who, method, path, raw] of cases) {
      const r = await t.http(who, method, path, undefined, raw);
      expect(r.status, `${who} ${method} ${path}`).toBe(403);
      expect(r.body).toMatchObject({ ok: false, rule: 'R16', code: 'not_direction' });
      expect(r.body.message).toMatch(/Seule la direction/);
    }
    expect((await t.refusals()).length).toBe(cases.length);
    expect(await t.count('automation_scenarios')).toBe(0);
    expect(await t.count('automation_simulations')).toBe(0);
    expect(await t.count('automation_switches')).toBe(0);
  });

  it('[R403] les quatre déclencheurs sont acceptés ; un déclencheur inconnu est refusé en mots, rien n’est rangé', async () => {
    const t = await setup();
    const triggers = [
      { ...WELCOME, name: 'Nouveau contact' },
      { ...WELCOME, name: 'Nouveau projet de vente', trigger: 'nouveau_projet', projectKind: 'sell' },
      { ...WELCOME, name: 'Après la visite', trigger: 'visite_faite', waitHours: 24 },
      { ...WELCOME, name: 'Mandat signé', trigger: 'mandat_signe', waitHours: 48, task: null },
    ];
    for (const definition of triggers) {
      const r = await t.http('direction', 'POST', '/scenarios', definition);
      expect(r.status, definition.trigger).toBe(200);
      expect(r.body).toMatchObject({ ok: true, mode: 'essai', data: { version: 1 } });
    }
    expect(await t.count('automation_scenarios')).toBe(4);
    const unknown = await t.http('direction', 'POST', '/scenarios', { ...WELCOME, trigger: 'anniversaire' });
    expect(unknown.status).toBe(409);
    expect(unknown.body).toMatchObject({ ok: false, rule: 'R403', code: 'bad_trigger' });
    expect(unknown.body.message).toMatch(/déclencheur n’existe pas/);
    // Le type de projet ne se choisit que pour un nouveau projet.
    const kind = await t.http('direction', 'POST', '/scenarios', { ...WELCOME, projectKind: 'sell' });
    expect(kind.body).toMatchObject({ rule: 'R403', code: 'bad_project_kind' });
    expect(kind.body.message).toBeTruthy();
    // Un texte qui porte un chiffre est refusé avec la règle du contrôle central, en mots.
    const figure = await t.http('direction', 'POST', '/scenarios', { ...WELCOME, message: { channel: 'email', text: 'Bonjour {prenom}, -10 % sur nos honoraires ce mois-ci.' } });
    expect(figure.status).toBe(409);
    expect(figure.body).toMatchObject({ rule: 'R10', code: 'text_R10' });
    expect(figure.body.message).toMatch(/aucun chiffre/);
    // Corps illisible, champ ou paramètre non prévu : 400, rien n'est rangé.
    expect((await t.http('direction', 'POST', '/scenarios', undefined, '{pas du json')).body).toMatchObject({ code: 'invalid_body' });
    expect((await t.http('direction', 'POST', '/scenarios', { ...WELCOME, script: 'x' })).body).toMatchObject({ code: 'unknown_field', field: 'script' });
    expect((await t.http('direction', 'GET', '/scenarios?tout=1')).body).toMatchObject({ code: 'unknown_field', field: 'tout' });
    expect((await t.http('direction', 'POST', '/scenarios/s1/essai', { version: 1 })).body).toMatchObject({ code: 'unknown_field', field: 'version' });
    expect(await t.count('automation_scenarios')).toBe(4);
  });

  it('[R403] une nouvelle version garde l’ancienne ; un scénario d’un autre réseau est inconnu ici', async () => {
    const t = await setup();
    const id = (await t.http('direction', 'POST', '/scenarios', WELCOME)).body.data.scenarioId as string;
    const v2 = await t.http('direction', 'POST', `/scenarios/${id}`, { ...WELCOME, waitHours: 4 });
    expect(v2.body).toMatchObject({ ok: true, data: { scenarioId: id, version: 2 } });
    for (const path of [`/scenarios/${id}`, `/scenarios/${id}/essai`, `/scenarios/${id}/allumer`, `/scenarios/${id}/eteindre`]) {
      const r = await t.http('ailleurs', 'POST', path, path === `/scenarios/${id}` ? WELCOME : undefined);
      expect(r.status, path).toBe(404);
      expect(r.body).toMatchObject({ rule: 'R16', code: 'unknown' });
      expect(r.body.message).toMatch(/n’existe pas dans votre réseau/);
    }
    expect((await t.http('ailleurs', 'GET', '/scenarios')).body.data).toEqual([]);
    expect(await t.count('automation_scenarios')).toBe(2);
    // Un identifiant mal formé ne trouve aucune route.
    expect((await t.http('direction', 'POST', '/scenarios/a.b/essai')).status).toBe(404);
  });

  it('[R400] allumer sans essai de la version est refusé ; la liste dit la version, l’état et le dernier essai', async () => {
    const t = await setup();
    const id = (await t.http('direction', 'POST', '/scenarios', WELCOME)).body.data.scenarioId as string;
    const early = await t.http('direction', 'POST', `/scenarios/${id}/allumer`);
    expect(early.status).toBe(409);
    expect(early.body).toMatchObject({ rule: 'R400', code: 'not_simulated' });
    expect(early.body.message).toMatch(/Essayez d’abord/);
    let list = (await t.http('direction', 'GET', '/scenarios')).body.data;
    expect(list).toEqual([expect.objectContaining({ scenarioId: id, version: 1, litVersion: null, litSince: null, lastSimulation: null })]);
    expect(list[0].definition).toMatchObject({ name: 'Bienvenue', trigger: 'nouveau_contact' });
    // L'essai sur le mois passé : un contact avec accord il y a dix jours.
    t.at(TUE_10H - 10 * DAY);
    await t.person('Inès');
    t.at(TUE_10H);
    const essai = await t.http('direction', 'POST', `/scenarios/${id}/essai`);
    expect(essai.status).toBe(200);
    expect(essai.body.data).toMatchObject({ scenarioId: id, version: 1, messages: 1, persons: 1, tasks: 1, sameDayTwice: 0, canSwitchOn: true });
    // L'essai n'envoie rien.
    expect(await t.count('trial_outbox')).toBe(0);
    expect(await t.count('automation_runs')).toBe(0);
    list = (await t.http('direction', 'GET', '/scenarios')).body.data;
    expect(list[0].lastSimulation).toMatchObject({ simulationId: essai.body.data.simulationId, messages: 1, persons: 1, tasks: 1, refused: {}, sameDayTwice: 0, canSwitchOn: true });
    // Une nouvelle version n'a pas d'essai : elle ne s'allume pas sur celui de la version d'avant.
    expect((await t.http('direction', 'POST', `/scenarios/${id}`, { ...WELCOME, waitHours: 2 })).body.data.version).toBe(2);
    expect((await t.http('direction', 'GET', '/scenarios')).body.data[0]).toMatchObject({ version: 2, lastSimulation: null });
    expect((await t.http('direction', 'POST', `/scenarios/${id}/allumer`)).body).toMatchObject({ rule: 'R400', code: 'not_simulated' });
    await t.http('direction', 'POST', `/scenarios/${id}/essai`);
    const on = await t.http('direction', 'POST', `/scenarios/${id}/allumer`);
    expect(on.body).toMatchObject({ ok: true, data: { version: 2 } });
    expect((await t.http('direction', 'GET', '/scenarios')).body.data[0]).toMatchObject({ version: 2, litVersion: 2, litSince: new Date(TUE_10H).toISOString() });
    // Un essai trop ancien ne permet plus d'allumer, et la liste le dit.
    t.at(TUE_10H + 25 * HOUR);
    expect((await t.http('direction', 'GET', '/scenarios')).body.data[0].lastSimulation.canSwitchOn).toBe(false);
    expect((await t.http('direction', 'POST', `/scenarios/${id}/allumer`)).body).toMatchObject({ rule: 'R400', code: 'simulation_too_old' });
    const off = await t.http('direction', 'POST', `/scenarios/${id}/eteindre`);
    expect(off.body).toMatchObject({ ok: true, data: { cancelled: 0 } });
    expect((await t.http('direction', 'GET', '/scenarios')).body.data[0]).toMatchObject({ litVersion: null });
  });

  it('[R401] [R05] [R26] le passage ne fait partir le message que par le contrôle central, en mode essai, une fois par fait', async () => {
    const t = await setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    // Un contact d'avant l'allumage ne déclenche rien.
    t.at(TUE_10H - HOUR);
    await t.person('Avant');
    t.at(TUE_10H);
    await lit(t);
    expect(await t.count('trial_outbox')).toBe(0);
    t.at(TUE_10H + 10 * 60_000);
    const lea = await t.person('Léa');
    await t.person('Sansaccord', false);
    t.at(TUE_10H + HOUR);
    const tick = await t.pass();
    expect(tick.ran).toEqual([SCENARIOS_JOB]);
    // Léa reçoit le message dans la boîte d'essai ; sans accord, le contrôle central refuse ; rien d'autre ne part.
    expect(await t.outbox()).toEqual([{ person_id: lea, channel: 'email' }]);
    const runs = await t.db.all<{ status: string; message_status: string | null; message_rule: string | null }>('SELECT status, message_status, message_rule FROM automation_runs ORDER BY created_at, id');
    expect(runs.map((r) => r.message_status).sort()).toEqual(['essai', 'refuse']);
    expect(runs.every((r) => r.status === 'fait')).toBe(true);
    // Le passage suivant ne renvoie rien : un fait ne déclenche qu'une fois, et jamais deux fois le même texte [R05].
    t.at(TUE_10H + 2 * HOUR);
    await t.pass();
    expect(await t.outbox()).toEqual([{ person_id: lea, channel: 'email' }]);
    expect(await t.count('automation_runs')).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('[R401] [R26] au planificateur du Worker, le passage tourne en mode essai seulement', async () => {
    const t = await setup();
    await lit(t);
    t.at(TUE_10H + 10 * 60_000);
    const lea = await t.person('Léa');
    t.at(TUE_10H + HOUR);
    // Hors mode essai, le planificateur ne passe pas : rien n'est rangé, rien ne part.
    expect(await runScheduler({ db: t.db, mode: 'reel', now: t.now })).toBeNull();
    expect(await t.count('automation_runs')).toBe(0);
    const tick = await runScheduler({ db: t.db, mode: 'essai', now: t.now });
    expect(tick?.ran).toContain(SCENARIOS_JOB);
    expect(await t.outbox()).toEqual([{ person_id: lea, channel: 'email' }]);
  });

  it('[R13] un réseau en panne n’empêche pas les autres ; l’erreur remonte au planificateur', async () => {
    const t = await setup();
    await lit(t);
    t.at(TUE_10H + 10 * 60_000);
    const lea = await t.person('Léa');
    // Un autre réseau dont la lecture tombe en panne : son passage échoue, celui du réseau suivant se fait.
    const calls: string[] = [];
    const db = new Proxy(t.db, {
      get(target, prop, receiver) {
        if (prop === 'all') {
          return async (sql: string, params: readonly SqlValue[] = []) => {
            if (/DISTINCT network_id FROM automation_switches/.test(sql)) {
              calls.push('networks');
              return [{ network_id: 'reseau-en-panne' }, { network_id: t.net.id }];
            }
            if (params[0] === 'reseau-en-panne') throw new Error('panne de test');
            return target.all(sql, params);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as SqlDatabase;
    t.at(TUE_10H + HOUR);
    const job = scenariosJob(db, t.journal, { now: t.now });
    await expect(job.run({ job: SCENARIOS_JOB, slot: 'essai', at: t.now() })).rejects.toThrow('panne de test');
    expect(calls).toEqual(['networks']);
    expect(await t.outbox()).toEqual([{ person_id: lea, channel: 'email' }]);
  });

  it('chaque refus a ses mots, jamais un code nu', () => {
    for (const code of ['not_direction', 'unknown', 'bad_trigger', 'bad_wait', 'first_name_slot', 'text_length', 'not_simulated', 'simulation_too_old', 'simulation_before_last_switch_on', 'same_day_twice', 'empty_scenario']) {
      expect(refusalWords(code, 'R403'), code).not.toMatch(/Refusé par la règle/);
    }
    expect(refusalWords('text_R07', 'R07')).toMatch(/offert/);
    expect(refusalWords('text_R99', 'R99')).toMatch(/R99/);
    expect(refusalWords('autre', null)).toBe('Demande refusée.');
  });

  it('docs/API.md décrit chaque route des scénarios et leur passage', () => {
    const doc = readFileSync(new URL('../../../docs/API.md', import.meta.url), 'utf8');
    const section = doc.slice(doc.indexOf('## Scénarios automatiques (BR55)'));
    expect(section.length).toBeGreaterThan(0);
    expect(doc).toContain('## Scénarios automatiques (BR55)');
    const written = ['`GET /`', '`POST /`', '`POST /<id>`', '`POST /<id>/essai`', '`POST /<id>/allumer`', '`POST /<id>/eteindre`'];
    expect(written.length).toBe(scenariosRoutes().length);
    for (const w of written) expect(section, w).toContain(w);
    expect(section).toContain(SCENARIOS_JOB);
  });
});
