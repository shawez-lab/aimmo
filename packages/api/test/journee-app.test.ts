import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, parisInstant } from '@aimmo/core';
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
const INJECTED = '<img src=x onerror="alert(1)">';

type Answers = Record<string, () => Promise<Response>>;

async function run(answers: Answers) {
  const { els, listeners, document } = fakeDocument(pageIds(HTML));
  const storage = new Map<string, string>([['aimmo.cle', KEY]]);
  const calls: string[] = [];
  runInNewContext(AGENT_APP_FILES['/app/app.js']!, {
    document,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    fetch: (url: string) => {
      calls.push(url);
      const answer = answers[url];
      return answer ? answer() : Promise.reject(new TypeError('hors ligne'));
    },
    navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
  });
  listeners.DOMContentLoaded!();
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  return { els, storage, calls };
}

const ME = async () => Response.json({ ok: true, data: { role: 'agent', firstName: 'Alex' } });
const PLAN = {
  agentId: 'a1',
  day: '2026-11-10',
  computedAt: '2026-11-10T06:30:00.000Z',
  // L'ordre du socle : il n'est pas celui des numéros ni des prénoms, l'écran doit le garder tel quel.
  items: [
    { rank: 1, personId: 'p2', firstName: 'Zoé', kind: 'callback', reason: 'A demandé à être rappelée', order: 'règle 1', priority: 'Rappel demandé · demande du 01/11/2026', basis: { kind: 'request', since: '2026-11-01', purpose: null } },
    { rank: 2, personId: 'p1', firstName: INJECTED, kind: 'valuation_follow_up', reason: 'Avis de valeur envoyé il y a 31 jours', order: 'règle 3', priority: 'Avis de valeur envoyé le 10/10/2026 · demande du 01/10/2026', basis: { kind: 'consent', since: '2026-10-01', purpose: 'valuation_follow_up' } },
    { rank: 3, personId: 'p3', firstName: 'Ana', kind: 'appointment_to_offer', reason: 'Estimation sans rendez-vous', order: 'règle 4', basis: { kind: 'request', since: '2026-10-20', purpose: null } },
  ],
  removed: { excluded: 0, withdrawn: 0, noBasis: 0 },
  hiddenSinceFrozen: 1,
};
const HOT = { slot: 'morning', contacts: [{ taskId: 't1', personId: 'p9', firstName: 'Léo', reason: 'Vendeur sous 3 mois', dueAt: '2026-11-10T09:00:00.000Z', overdue: true }] };
const RDV = {
  day: '2026-11-10',
  appointments: [
    {
      id: 'r1',
      kind: 'estimation',
      start: '2026-11-10T09:00:00.000Z',
      end: '2026-11-10T10:00:00.000Z',
      status: 'booked',
      firstName: 'Léa',
      briefMissing: null,
      brief: {
        appointmentId: 'r1',
        kind: 'estimation',
        start: '2026-11-10T09:00:00.000Z',
        preparedAt: '2026-11-10T07:07:00.000Z',
        items: [
          { section: 'client', label: 'Nom', value: 'Léa Exemple', source: 'fiche client' },
          { section: 'histoire', label: 'Dernier message reçu', value: `« ${INJECTED} »`, source: 'messages de la conversation' },
          { section: 'histoire', label: 'Rendez-vous précédents', value: null, missing: 'aucun rendez-vous précédent' },
          { section: 'itineraire', label: 'Itinéraire vers la commune', value: 'https://www.google.com/maps/dir/?api=1&destination=21000%20Dijon%2C%20France', source: 'commune du bien (fiche du bien)' },
          { section: 'itineraire', label: 'Itinéraire piégé', value: 'javascript:alert(1)', source: 'test' },
        ],
      },
    },
    { id: 'r2', kind: 'visite', start: '2026-11-10T13:00:00.000Z', end: '2026-11-10T14:00:00.000Z', status: 'booked', firstName: null, brief: null, briefMissing: 'no_access' },
  ],
};
const ok = (data: unknown) => async () => Response.json({ ok: true, mode: 'essai', data });
const DAY: Answers = { '/v1/moi': ME, '/v1/plan-du-jour': ok(PLAN), '/v1/contacts-chauds': ok(HOT), '/v1/rendez-vous/jour': ok(RDV) };

const items = (list: FakeElement) => list.children.map((li) => li.textContent);

describe('A02 · écran « Ma journée »', () => {
  it('[R35] le plan est montré dans l’ordre du socle, avec la raison et la priorité de chaque ligne, jamais retrié ; jamais un numéro de règle (AU116)', async () => {
    const { els } = await run(DAY);
    expect(els.accueil!.hidden).toBe(false);
    const shown = items(els.plan!);
    expect(shown).toEqual([
      '1. ZoéA demandé à être rappeléeRappel demandé · demande du 01/11/2026Voir la fiche',
      `2. ${INJECTED}Avis de valeur envoyé il y a 31 joursAvis de valeur envoyé le 10/10/2026 · demande du 01/10/2026Voir la fiche`,
      // Une ligne d'un plan figé avant AU116, sans priorité : sa raison seule, jamais « règle 4 ».
      '3. AnaEstimation sans rendez-vousVoir la fiche',
      '1 ligne(s) retirée(s) depuis 7 h 30.',
    ]);
    // Le script ne trie rien : aucun appel de tri dans le code de la page.
    expect(AGENT_APP_FILES['/app/app.js']).not.toMatch(/\.sort\(/);
  });

  it('un texte venu d’un client reste un texte : aucun élément n’est créé par son contenu', async () => {
    const { els } = await run(DAY);
    const all = [els.plan!, els.chauds!, els.rdv!].flatMap((l) => l.all());
    expect(all.map((e) => e.tagName).filter((t) => !['li', 'strong', 'p', 'details', 'summary', 'h4', 'ul', 'span', 'a', 'button'].includes(t))).toEqual([]);
    expect(els.plan!.textContent).toContain(INJECTED);
    expect(els.rdv!.textContent).toContain(INJECTED);
  });

  it('contacts chauds et rendez-vous du jour avec leur brief ; seul l’itinéraire de navigation devient un lien', async () => {
    const { els } = await run(DAY);
    expect(items(els.chauds!)).toEqual(['LéoVendeur sous 3 moisEn retard : à rappeler depuis 10:00Voir la fiche']);
    const [first, second] = els.rdv!.children;
    expect(first!.children[0]!.textContent).toBe('10:00 à 11:00 · Estimation · Léa');
    const links = first!.all().filter((e) => e.tagName === 'a');
    expect(links.map((a) => a.attributes)).toEqual([
      { href: 'https://www.google.com/maps/dir/?api=1&destination=21000%20Dijon%2C%20France', target: '_blank', rel: 'noopener noreferrer' },
    ]);
    expect(first!.textContent).toContain('Itinéraire piégé : javascript:alert(1)');
    expect(first!.textContent).toContain('Rendez-vous précédents : manque, aucun rendez-vous précédent');
    expect(second!.textContent).toBe('14:00 à 15:00 · VisiteFiche suivie par un autre agent : ni brief ni détail.');
  });

  it('listes vides et pannes sont dites ; une panne d’une partie n’empêche pas les autres', async () => {
    const empty = await run({ ...DAY, '/v1/plan-du-jour': ok(null), '/v1/contacts-chauds': ok({ slot: 'morning', contacts: [] }), '/v1/rendez-vous/jour': ok({ day: '2026-11-10', appointments: [] }) });
    expect(empty.els['plan-etat']!.textContent).toBe('Le plan du jour sera prêt à 7 h 30.');
    expect(empty.els['chauds-etat']!.textContent).toBe('Aucun contact chaud à rappeler.');
    expect(empty.els['rdv-etat']!.textContent).toBe('Aucun rendez-vous aujourd’hui.');
    const broken = await run({ ...DAY, '/v1/contacts-chauds': async () => new Response('panne', { status: 503 }), '/v1/rendez-vous/jour': () => Promise.reject(new TypeError('hors ligne')) });
    expect(broken.els['chauds-etat']!.textContent).toMatch(/Indisponible/);
    expect(broken.els['rdv-etat']!.textContent).toMatch(/Indisponible/);
    expect(items(broken.els.plan!)).toHaveLength(4);
    expect(broken.storage.has('aimmo.cle')).toBe(true);
  });

  it('[R16] une clé refusée en cours de route efface l’écran et la clé', async () => {
    const r = await run({ ...DAY, '/v1/rendez-vous/jour': async () => Response.json({ ok: false, rule: 'R16', code: 'agent_inactive' }, { status: 403 }) });
    expect(r.els.accueil!.hidden).toBe(true);
    expect(r.els.connexion!.hidden).toBe(false);
    expect(r.storage.has('aimmo.cle')).toBe(false);
    expect([r.els.plan!, r.els.chauds!, r.els.rdv!].map((l) => l.children.length)).toEqual([0, 0, 0]);
  });

  it('écran fait pour le téléphone : largeur de l’appareil, colonne unique, cibles d’au moins 44 px', () => {
    expect(HTML).toContain('name="viewport" content="width=device-width, initial-scale=1');
    const css = AGENT_APP_FILES['/app/app.css']!;
    // Les mesures viennent du système de design (Z03) : une colonne de 38rem, des cibles de 48 px.
    expect(css).toContain('--cible:48px;--colonne:38rem');
    expect(css).toMatch(/main \{[^}]*max-width: var\(--colonne\)/);
    expect(css).toMatch(/summary \{[^}]*min-height: var\(--cible\)/);
    expect(css).toMatch(/overflow-wrap: ?anywhere/);
  });
});

// La route, de bout en bout dans le Worker.
const BASE = 'https://aimmo-api.example.workers.dev';
const KEY_AGENT = 'test-cle-journee-agent-aaaaaaaaaaaaaaaaaaaaaaaa';
const KEY_OTHER = 'test-cle-journee-autre-bbbbbbbbbbbbbbbbbbbbbbbb';
const KEY_DIRECTION = 'test-cle-journee-direction-cccccccccccccccccccc';

describeWithSqlite('A02 · route /v1/rendez-vous/jour', () => {
  it('[R16, R13] l’agent lit ses rendez-vous du jour ; un autre agent ne les voit pas ; la direction est refusée ; la clé n’est jamais écrite', async () => {
    const d1 = fakeD1(openMemoryDatabase());
    const db = fromD1(d1);
    await applyMigrations(db, loadMigrations());
    const fiches = new FicheClient(db);
    const network = await fiches.createNetwork('Réseau test');
    const alex = await fiches.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
    const bea = await fiches.createAgent({ networkId: network.id, firstName: 'Béa', lastName: 'Agent' });
    const lea = await fiches.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Léa', lastName: 'Exemple' });
    const start = parisInstant('2026-11-10', 10 * 60)!;
    await db.run(
      `INSERT INTO appointments (id, network_id, agent_id, person_id, property_id, kind, start_at, end_at, status, token_hash, source, created_at, updated_at)
       VALUES ('rdv-1', ?, ?, ?, NULL, 'estimation', ?, ?, 'booked', 'empreinte-1', 'agent', ?, ?)`,
      [network.id, alex.id, lea.id, start.toISOString(), new Date(start.getTime() + 3_600_000).toISOString(), start.toISOString(), start.toISOString()],
    );
    const keys = await Promise.all(
      [
        { key: KEY_AGENT, role: 'agent', userId: alex.id },
        { key: KEY_OTHER, role: 'agent', userId: bea.id },
        { key: KEY_DIRECTION, role: 'direction', userId: 'direction-1' },
      ].map(async ({ key, ...rest }) => ({ sha256: await sha256Hex(key), networkId: network.id, ...rest })),
    );
    const env: Env = { DB: d1, MODE: 'essai', API_KEYS: JSON.stringify(keys) };
    const get = (key: string) => worker.fetch(new Request(`${BASE}/v1/rendez-vous/jour`, { headers: { authorization: `Bearer ${key}` } }), env);
    // Le Worker lit l'heure réelle : on vérifie la forme, et le jeu inventé est posé sur un jour fixe.
    const mine = await get(KEY_AGENT);
    expect(mine.status).toBe(200);
    expect(mine.headers.get('cache-control')).toBe('no-store');
    const body = (await mine.json()) as { ok: boolean; mode: string; data: { day: string; appointments: unknown[] } };
    expect(body).toMatchObject({ ok: true, mode: 'essai', data: { day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) } });
    const other = (await (await get(KEY_OTHER)).json()) as { data: { appointments: unknown[] } };
    expect(other.data.appointments).toEqual([]);
    expect((await get(KEY_DIRECTION)).status).toBe(403);
    expect((await worker.fetch(new Request(`${BASE}/v1/rendez-vous/jour`), env)).status).toBe(401);
    const journal = await new SqlJournalStore(db).all();
    expect(JSON.stringify(journal)).not.toMatch(/test-cle|Léa/);
    expect(journal.filter((e) => e.type === 'rdv.jour.lu')).toHaveLength(2);
  });
});

describe('A02 · réponse arrivée après la sortie', () => {
  it('[R16] une réponse d’une session finie n’est jamais montrée, ni chez l’agent suivant', async () => {
    const { els, listeners, document } = fakeDocument(pageIds(HTML));
    const storage = new Map<string, string>([['aimmo.cle', KEY]]);
    const held: Record<string, (r: Response) => void> = {};
    let late = true;
    runInNewContext(AGENT_APP_FILES['/app/app.js']!, {
      document,
      localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
      fetch: (url: string) => {
        if (url === '/v1/moi') return ME();
        // La première session : les réponses sont retenues ; la suivante : réponses vides tout de suite.
        if (late) return new Promise<Response>((resolve) => (held[url] = resolve));
        return ok(url === '/v1/plan-du-jour' ? { ...PLAN, items: [], hiddenSinceFrozen: 0 } : url === '/v1/contacts-chauds' ? { slot: 'morning', contacts: [] } : { day: '2026-11-10', appointments: [] })();
      },
      navigator: { serviceWorker: { register: () => Promise.resolve({}) } },
    });
    listeners.DOMContentLoaded!();
    const tick = async () => {
      for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
    };
    await tick();
    expect(Object.keys(held)).toHaveLength(7);
    els.sortir!.listeners.click!({});
    // L'agent suivant entre sur le même appareil.
    late = false;
    els.cle!.value = 'n'.repeat(40);
    els['form-connexion']!.listeners.submit!({ preventDefault: () => undefined });
    await tick();
    expect(els.accueil!.hidden).toBe(false);
    held['/v1/plan-du-jour']!(Response.json({ ok: true, data: PLAN }));
    held['/v1/alertes-agent']!(Response.json({ ok: true, data: { alerts: [{ id: 'al-1', personId: 'p1', firstName: 'Léa', reason: 'needs_reply', channel: 'email', createdAt: '2026-11-10T08:00:00.000Z', contactClosed: false }], more: false } }));
    held['/v1/contacts-chauds']!(Response.json({ ok: true, data: HOT }));
    held['/v1/rendez-vous/jour']!(Response.json({ ok: false }, { status: 403 }));
    held['/v1/annonces']!(Response.json({ ok: true, data: [{ id: 'b1', reference: 'REF-1', city: 'Dijon', state: null }] }));
    held['/v1/apres-vente/journee']!(Response.json({ ok: true, data: { remercier: [{ fileId: 'f1', personId: 'p1', firstName: 'Léa', side: 'vendeur', reference: 'REF-1' }], recommandations: [], taches: [] } }));
    await tick();
    expect(els.reprendre!.children).toHaveLength(0);
    expect([els.plan!, els.chauds!, els.rdv!, els.semaine!, els.biens!, els['apres-jour']!].map((l) => l.children.length)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(storage.get('aimmo.cle')).toBe('n'.repeat(40));
    expect(els.accueil!.hidden).toBe(false);
  });
});

describe('A04 · « Ma semaine » dans l’application', () => {
  it('[R14] l’agent voit ses seuls jours d’usage du matin, sans comparaison', async () => {
    const days = ['04', '05', '06', '07', '08', '09', '10'].map((d) => ({ day: `2026-11-${d}`, opened: d !== '06' && d !== '10' }));
    const { els } = await run({ ...DAY, '/v1/usage/matin': ok({ scope: 'agent', days, openedDays: 5 }) });
    expect(items(els.semaine!)).toEqual(['Plan ouvert avant midi : 5 jour(s) sur 7.', '04/11 oui · 05/11 oui · 06/11 non · 07/11 oui · 08/11 oui · 09/11 oui · 10/11 non']);
    // Une réponse du réseau n'est pas montrée dans l'écran de l'agent.
    const network = await run({ ...DAY, '/v1/usage/matin': ok({ scope: 'network', days: [], daysUsed: 0, activeAgents: 3 }) });
    expect(network.els['semaine-etat']!.textContent).toBe('Mesure indisponible.');
    expect(network.els.semaine!.children).toHaveLength(0);
  });
});

describeWithSqlite('A04 · route /v1/usage/matin', () => {
  it('[R14, R16] l’agent reçoit ses 7 jours, la direction des nombres sans nom, la conformité est refusée', async () => {
    const d1 = fakeD1(openMemoryDatabase());
    const db = fromD1(d1);
    await applyMigrations(db, loadMigrations());
    const fiches = new FicheClient(db);
    const network = await fiches.createNetwork('Réseau test');
    const alex = await fiches.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
    const keys = await Promise.all(
      [
        { key: KEY_AGENT, role: 'agent', userId: alex.id },
        { key: KEY_DIRECTION, role: 'direction', userId: 'direction-1' },
        { key: KEY_OTHER, role: 'compliance', userId: 'conformite-1' },
      ].map(async ({ key, ...rest }) => ({ sha256: await sha256Hex(key), networkId: network.id, ...rest })),
    );
    const env: Env = { DB: d1, MODE: 'essai', API_KEYS: JSON.stringify(keys) };
    const get = (key: string) => worker.fetch(new Request(`${BASE}/v1/usage/matin`, { headers: { authorization: `Bearer ${key}` } }), env);
    const mine = (await (await get(KEY_AGENT)).json()) as { data: { scope: string; days: unknown[]; openedDays: number } };
    expect(mine.data).toMatchObject({ scope: 'agent', openedDays: 0 });
    expect(mine.data.days).toHaveLength(7);
    const all = (await (await get(KEY_DIRECTION)).json()) as { data: unknown };
    expect(all.data).toMatchObject({ scope: 'network', daysUsed: 0, activeAgents: 1 });
    expect(JSON.stringify(all)).not.toContain(alex.id);
    expect((await get(KEY_OTHER)).status).toBe(403);
  });
});

describe('A04 · la semaine est lue après le plan', () => {
  it('l’usage du matin n’est demandé qu’une fois le plan lu, pour que l’ouverture de ce matin compte', async () => {
    const order: string[] = [];
    let releasePlan: (() => void) | null = null;
    const answers: Answers = {
      ...DAY,
      '/v1/plan-du-jour': () =>
        new Promise<Response>((resolve) => {
          releasePlan = () => {
            order.push('plan lu');
            resolve(Response.json({ ok: true, data: PLAN }));
          };
        }),
      '/v1/usage/matin': async () => {
        order.push('semaine demandée');
        return Response.json({ ok: true, data: { scope: 'agent', days: [{ day: '2026-11-10', opened: true }], openedDays: 1 } });
      },
    };
    const pending = run(answers);
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual([]);
    releasePlan!();
    const { els } = await pending;
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(['plan lu', 'semaine demandée']);
    expect(els.semaine!.children[0]!.textContent).toBe('Plan ouvert avant midi : 1 jour(s) sur 1.');
  });
});
