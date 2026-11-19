import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations } from '@aimmo/core';
import { sha256Hex } from '../src/index.ts';
import { AGENT_APP_FILES } from '../src/agent-app.ts';
import { fromD1 } from '../src/d1.ts';
import worker, { type Env } from '../src/worker.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';
import { fakeD1 } from './fake-d1.ts';
import { FakeElement, fakeDocument, pageIds } from './fake-dom.ts';

// Tout est inventé. Clés de test, jamais utilisées ailleurs.
const KEY = 'k'.repeat(40);
const HTML = AGENT_APP_FILES['/app/']!;

type Answer = (init: { method?: string }) => Promise<Response>;

async function app(answers: Record<string, Answer>) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: { url: string; method: string }[] = [];
  runInNewContext(AGENT_APP_FILES['/app/app.js']!, {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string, init: { method?: string; headers: Record<string, string> }) => {
      calls.push({ url, method: init.method ?? 'GET' });
      expect(init.headers).toEqual({ authorization: `Bearer ${KEY}` });
      const answer = answers[url];
      return answer ? answer(init) : Promise.reject(new TypeError('hors ligne'));
    },
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  });
  listeners.DOMContentLoaded!();
  const tick = async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  };
  await tick();
  return { els, storage, calls, tick };
}

const ok = (data: unknown) => async () => Response.json({ ok: true, mode: 'essai', data });
const PLAN = (personId: string) => ({
  agentId: 'a1',
  day: '2026-11-10',
  computedAt: '2026-11-10T06:30:00.000Z',
  items: [{ rank: 1, personId, firstName: 'Léa', kind: 'callback', reason: 'A demandé à être rappelée', order: 'règle 1', basis: { kind: 'request', since: '2026-11-01', purpose: null }, projectId: null, taskId: 't-1', reportId: null }],
  removed: { excluded: 0, withdrawn: 0, noBasis: 0 },
  hiddenSinceFrozen: 0,
});
const FICHE = {
  personId: 'p-1',
  firstName: 'Léa',
  lastName: 'Exemple',
  contact: { allowed: true, reasons: [] },
  call: 'tel:+33600000001',
  projects: [{ kind: 'sell', stage: 'new', deadline: null, budgetMinEur: null, budgetMaxEur: 230000 }],
  sources: [{ channel: 'site', detail: 'formulaire test', occurredAt: '2026-10-01T10:00:00.000Z' }],
  consents: [{ purpose: 'valuation_follow_up', channel: 'email', givenAt: '2026-10-01T10:00:00.000Z', withdrawnAt: null }],
  messages: [{ channel: 'email', direction: 'in', author: 'person', body: '<script>alert(1)</script>', occurredAt: '2026-10-02T09:00:00.000Z' }],
  callbacks: [{ taskId: 't-1', reason: 'Vendeur sous 3 mois', dueAt: '2026-11-10T09:00:00.000Z', doneAt: null }],
};
const base = (personId = 'p-1'): Record<string, Answer> => ({
  '/v1/moi': async () => Response.json({ ok: true, data: { role: 'agent', firstName: 'Alex' } }),
  '/v1/plan-du-jour': ok(PLAN(personId)),
  '/v1/contacts-chauds': ok({ slot: 'morning', contacts: [] }),
  '/v1/rendez-vous/jour': ok({ day: '2026-11-10', appointments: [] }),
});
const buttons = (root: FakeElement, text: string) => root.all().filter((e) => e.tagName === 'button' && e.textContent === text);
const tels = (root: FakeElement) => root.all().filter((e) => e.tagName === 'a' && (e.attributes.href ?? '').startsWith('tel:'));

describe('A03 · fiche du client dans l’application', () => {
  it('depuis une ligne du plan : la fiche, ses projets, origines, accords, messages, et l’appel en un geste', async () => {
    const a = await app({ ...base(), '/v1/fiches/p-1/resume': ok(FICHE) });
    buttons(a.els.plan!, 'Voir la fiche')[0]!.listeners.click!({});
    await a.tick();
    expect(a.els.fiche!.hidden).toBe(false);
    expect(a.els.accueil!.hidden).toBe(true);
    expect(a.els['fiche-nom']!.textContent).toBe('Léa Exemple');
    const body = a.els['fiche-corps']!;
    expect(tels(body).map((t) => t.attributes.href)).toEqual(['tel:+33600000001']);
    for (const text of ['Vendre (étape : nouveau), budget jusqu’à 230000 €', 'site (formulaire test)', 'Suivi de l’avis de valeur par mail', 'Reçu par mail', 'Vendeur sous 3 mois']) expect(body.textContent).toContain(text);
    // Aucun code interne affiché.
    expect(body.textContent).not.toMatch(/\bnew\b|\bemail\b|\bphone\b|valuation_follow_up/);
    // Un message de client reste un texte.
    expect(body.textContent).toContain('<script>alert(1)</script>');
    // Le seul script est celui des gestes d'appel, servi par l'application (AC12).
    expect(body.all().filter((e) => e.tagName === 'script').map((e) => e.attributes.src)).toEqual(['/app/appels.js', '/app/biens-fiche.js']);
    // Retour à la journée.
    a.els.retour!.listeners.click!({});
    await a.tick();
    expect(a.els.accueil!.hidden).toBe(false);
    expect(a.els['fiche-corps']!.children).toHaveLength(0);
  });

  it('AU074 · un projet d’achat se confirme d’un geste, sans changer la recherche', async () => {
    const buy = { id: '00000000-0000-4000-8000-0000000000b1', kind: 'buy', stage: 'new', deadline: null, budgetMinEur: null, budgetMaxEur: 300000 };
    const a = await app({ ...base(), '/v1/fiches/p-1/resume': ok({ ...FICHE, projects: [buy] }), [`/v1/acquereurs/projets/${buy.id}/recherche/confirmation`]: ok({ confirmedAt: '2027-01-01T00:00:00.000Z' }) });
    buttons(a.els.plan!, 'Voir la fiche')[0]!.listeners.click!({});
    await a.tick();
    const body = a.els['fiche-corps']!;
    const still = buttons(body, 'Recherche toujours d’actualité')[0]!;
    still.listeners.click!({});
    await a.tick();
    expect(still.textContent).toBe('Confirmée');
    // Un projet de vente n'a pas ce geste.
    expect(buttons(body, 'Recherche toujours d’actualité')).toHaveLength(0);
  });

  it('[R02, R04] une personne exclue ou arrêtée est signalée, sans bouton d’appel, même si un numéro arrive', async () => {
    const a = await app({ ...base(), '/v1/fiches/p-1/resume': ok({ ...FICHE, contact: { allowed: false, reasons: ['stop'] } }) });
    buttons(a.els.plan!, 'Voir la fiche')[0]!.listeners.click!({});
    await a.tick();
    const body = a.els['fiche-corps']!;
    expect(tels(body)).toEqual([]);
    expect(body.textContent).toContain('Ne plus contacter : a demandé l’arrêt.');
    // Un numéro mal formé n'ouvre pas d'appel non plus.
    const b = await app({ ...base(), '/v1/fiches/p-1/resume': ok({ ...FICHE, call: 'javascript:alert(1)' }) });
    buttons(b.els.plan!, 'Voir la fiche')[0]!.listeners.click!({});
    await b.tick();
    expect(b.els['fiche-corps']!.all().filter((e) => e.tagName === 'a')).toEqual([]);
  });

  it('[R03] sans accord ni demande, pas de bouton d’appel, et l’écran dit pourquoi ; sans numéro, il le dit aussi', async () => {
    const a = await app({ ...base(), '/v1/fiches/p-1/resume': ok({ ...FICHE, call: null, callRefusal: 'no_consent' }) });
    buttons(a.els.plan!, 'Voir la fiche')[0]!.listeners.click!({});
    await a.tick();
    expect(tels(a.els['fiche-corps']!)).toEqual([]);
    expect(a.els['fiche-corps']!.textContent).toContain('Appel fermé : aucun accord ni demande de rappel enregistrés.');
    const h = await app({ ...base(), '/v1/fiches/p-1/resume': ok({ ...FICHE, call: null, callRefusal: 'outside_hours' }) });
    buttons(h.els.plan!, 'Voir la fiche')[0]!.listeners.click!({});
    await h.tick();
    expect(tels(h.els['fiche-corps']!)).toEqual([]);
    // [R203] L'écran dit quand l'appel est permis.
    expect(h.els['fiche-corps']!.textContent).toContain('du lundi au vendredi, de 10 h à 13 h et de 14 h à 20 h');
    const b = await app({ ...base(), '/v1/fiches/p-1/resume': ok({ ...FICHE, call: null, callRefusal: 'no_phone' }) });
    buttons(b.els.plan!, 'Voir la fiche')[0]!.listeners.click!({});
    await b.tick();
    expect(b.els['fiche-corps']!.textContent).toContain('Aucun numéro sur la fiche.');
  });

  it('[R203] passé la fin du créneau, l’application restée ouverte ne laisse plus partir l’appel', async () => {
    const past = await app({ ...base(), '/v1/fiches/p-1/resume': ok({ ...FICHE, callClosesAt: '2020-01-01T12:00:00.000Z' }) });
    buttons(past.els.plan!, 'Voir la fiche')[0]!.listeners.click!({});
    await past.tick();
    const link = past.els['fiche-corps']!.all().find((e) => e.tagName === 'a')!;
    let stopped = false;
    link.listeners.click!({ preventDefault: () => { stopped = true; } });
    expect(stopped).toBe(true);
    expect(tels(past.els['fiche-corps']!)).toEqual([]);
    expect(link.textContent).toContain('Appel fermé à cette heure');

    const open = await app({ ...base(), '/v1/fiches/p-1/resume': ok({ ...FICHE, callClosesAt: '2999-01-01T12:00:00.000Z' }) });
    buttons(open.els.plan!, 'Voir la fiche')[0]!.listeners.click!({});
    await open.tick();
    const live = open.els['fiche-corps']!.all().find((e) => e.tagName === 'a')!;
    let blocked = false;
    live.listeners.click!({ preventDefault: () => { blocked = true; } });
    expect(blocked).toBe(false);
    expect(tels(open.els['fiche-corps']!).map((t) => t.attributes.href)).toEqual(['tel:+33600000001']);
  });

  it('[R16] une fiche refusée ne montre rien et garde la clé ; un identifiant mal formé n’est jamais demandé', async () => {
    const a = await app({ ...base(), '/v1/fiches/p-1/resume': async () => Response.json({ ok: false, rule: 'R16', code: 'not_assigned' }, { status: 403 }) });
    buttons(a.els.plan!, 'Voir la fiche')[0]!.listeners.click!({});
    await a.tick();
    expect(a.els['fiche-etat']!.textContent).toBe('Cette fiche n’est pas dans vos droits.');
    expect(a.els['fiche-corps']!.children).toHaveLength(0);
    expect(a.storage.get('aimmo.cle')).toBe(KEY);
    const b = await app(base('../moi?x=1'));
    buttons(b.els.plan!, 'Voir la fiche')[0]!.listeners.click!({});
    await b.tick();
    expect(b.calls.map((c) => c.url)).toEqual(['/v1/moi', '/v1/plan-du-jour', '/v1/alertes-agent', '/v1/offres/a-tenir', '/v1/contacts-chauds', '/v1/annonces', '/v1/rendez-vous/jour', '/v1/apres-vente/journee', '/v1/usage/matin']);
  });

  it('[R17] « Rappel fait » envoie un POST sans rien envoyer au client, puis relit la fiche où la ligne reste', async () => {
    let done = false;
    const a = await app({
      ...base(),
      '/v1/fiches/p-1/resume': async () => Response.json({ ok: true, data: { ...FICHE, callbacks: [{ ...FICHE.callbacks[0], doneAt: done ? '2026-11-10T09:30:00.000Z' : null }] } }),
      '/v1/rappels/t-1/fait': async (init) => {
        expect(init.method).toBe('POST');
        done = true;
        return Response.json({ ok: true, mode: 'essai', sent: false });
      },
    });
    buttons(a.els.plan!, 'Voir la fiche')[0]!.listeners.click!({});
    await a.tick();
    buttons(a.els['fiche-corps']!, 'Rappel fait')[0]!.listeners.click!({});
    await a.tick();
    expect(a.calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual(['/v1/rappels/t-1/fait']);
    expect(a.els['fiche-corps']!.textContent).toContain('Vendeur sous 3 moisFait le 10/11/2026');
    expect(buttons(a.els['fiche-corps']!, 'Rappel fait')).toEqual([]);
  });
});

const BASE = 'https://aimmo-api.example.workers.dev';
const KEY_AGENT = 'test-cle-fiche-agent-aaaaaaaaaaaaaaaaaaaaaaaaaa';
const KEY_OTHER = 'test-cle-fiche-autre-bbbbbbbbbbbbbbbbbbbbbbbbbb';

describeWithSqlite('A03 · routes de la fiche et du rappel', () => {
  it('[R16, R17, R02] fiche et « rappel fait » pour l’agent de la fiche seulement ; la ligne reste ; rien n’est envoyé', async () => {
    const d1 = fakeD1(openMemoryDatabase());
    const db = fromD1(d1);
    await applyMigrations(db, loadMigrations());
    const fiches = new FicheClient(db);
    const network = await fiches.createNetwork('Réseau test');
    const alex = await fiches.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
    const bea = await fiches.createAgent({ networkId: network.id, firstName: 'Béa', lastName: 'Agent' });
    const lea = await fiches.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Léa', lastName: 'Exemple' });
    await fiches.addIdentifier({ networkId: network.id, personId: lea.id, kind: 'phone', value: '06 00 00 00 01' });
    const at = '2026-11-10T09:00:00.000Z';
    await db.run(`INSERT INTO inbound_messages (id, network_id, dedup_key, channel, kind, body, status, person_id, received_at, created_at) VALUES ('in-1', ?, 'k1', 'email', 'email', 'x', 'processed', ?, ?, ?)`, [network.id, lea.id, at, at]);
    await db.run(`INSERT INTO qualifications (id, network_id, inbound_id, person_id, category, deadline, financing, criteria, source, created_at) VALUES ('q-1', ?, 'in-1', ?, 'seller', NULL, NULL, '[]', 'rules', ?)`, [network.id, lea.id, at]);
    await db.run(`INSERT INTO callback_tasks (id, network_id, person_id, project_id, qualification_id, dedup_key, reason, due_at, created_at, done_at) VALUES ('t-1', ?, ?, NULL, 'q-1', 'k-t1', 'Vendeur', ?, ?, NULL)`, [network.id, lea.id, at, at]);
    const keys = await Promise.all(
      [
        { key: KEY_AGENT, role: 'agent', userId: alex.id },
        { key: KEY_OTHER, role: 'agent', userId: bea.id },
      ].map(async ({ key, ...rest }) => ({ sha256: await sha256Hex(key), networkId: network.id, ...rest })),
    );
    const env: Env = { DB: d1, MODE: 'essai', API_KEYS: JSON.stringify(keys) };
    const call = (path: string, key: string, method = 'GET') => worker.fetch(new Request(`${BASE}${path}`, { method, headers: { authorization: `Bearer ${key}` } }), env);

    const closed = (await (await call(`/v1/fiches/${lea.id}/resume`, KEY_AGENT)).json()) as { data: { call: string | null; callRefusal: string | null } };
    expect(closed.data).toMatchObject({ call: null, callRefusal: 'no_consent' });
    await fiches.addConsent({ networkId: network.id, personId: lea.id, purpose: 'reply', channel: 'phone', proof: 'message reçu test', givenAt: new Date('2025-12-01T00:00:00Z') });
    const mine = await call(`/v1/fiches/${lea.id}/resume`, KEY_AGENT);
    expect(mine.status).toBe(200);
    const body = (await mine.json()) as { data: { call: string; contact: unknown; callbacks: unknown[] } };
    expect(body.data.call).toBe('tel:+33600000001');
    expect(body.data.contact).toEqual({ allowed: true, reasons: [] });
    expect((await call(`/v1/fiches/${lea.id}/resume`, KEY_OTHER)).status).toBe(403);

    await fiches.addExclusion({ networkId: network.id, personId: lea.id, reason: 'network_list', notedAt: new Date('2026-01-01T00:00:00Z') });
    const excluded = (await (await call(`/v1/fiches/${lea.id}/resume`, KEY_AGENT)).json()) as { data: { call: string | null; contact: unknown } };
    expect(excluded.data).toMatchObject({ call: null, contact: { allowed: false, reasons: ['network_list'] } });

    expect((await call('/v1/rappels/t-1/fait', KEY_OTHER, 'POST')).status).toBe(403);
    expect((await call('/v1/rappels/inconnue/fait', KEY_AGENT, 'POST')).status).toBe(403);
    expect((await call('/v1/rappels/t-1/fait', KEY_AGENT)).status).toBe(405);
    const done = await call('/v1/rappels/t-1/fait', KEY_AGENT, 'POST');
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ ok: true, mode: 'essai', sent: false });

    // Q08 : l'identifiant vient de la fiche, jamais d'une saisie ; un autre agent est refusé [R16], l'origine reste [R17].
    const shown = async () => ((await (await call(`/v1/fiches/${lea.id}/resume`, KEY_AGENT)).json()) as { data: { qualification: { id: string; category: string; correction: { category: string; route: string | null } | null } } }).data.qualification;
    const before = await shown();
    expect(before).toMatchObject({ id: 'q-1', category: 'seller', correction: null });
    const correct = (key: string) => worker.fetch(new Request(`${BASE}/v1/qualifications/${before.id}/correction`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ category: 'buyer', route: null }) }), env);
    expect((await correct(KEY_OTHER)).status).toBe(403);
    expect((await shown()).correction).toBeNull();
    expect((await correct(KEY_AGENT)).status).toBe(200);
    expect(await shown()).toMatchObject({ id: 'q-1', category: 'seller', correction: { category: 'buyer', route: null } });
    expect(await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM callback_tasks WHERE id = 't-1' AND done_at IS NOT NULL`)).toEqual({ n: 1 });
    // Rien n'est parti : aucun message sortant n'a été rangé.
    expect(await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM messages WHERE direction = 'out'`)).toEqual({ n: 0 });
    const journal = await new SqlJournalStore(db).all();
    expect(JSON.stringify(journal)).not.toMatch(/test-cle|Léa|\+336/);
    expect(journal.filter((e) => e.type === 'rappel.fait')).toHaveLength(1);
  });
});
