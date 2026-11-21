import { expect, it } from 'vitest';
import { applyMigrations, fromSyncSqlite, type SqlDatabase } from '@aimmo/core';
import { handleRequest, sha256Hex, type ApiConfig } from '../src/index.ts';
import { gzipSize } from '../../core/src/design/audit.ts';
import { ETAPES, PORTEFEUILLE, RESEAU_MOBILE, SEUILS_P95, modeledMs, p95, parcoursProblems, type Echantillon, type Etape } from '../../core/src/design/parcours.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// AU106 · Un portefeuille chargé, entièrement inventé : réseau, agent, clients, messages, rappels, biens et clé.
const BASE = 'https://aimmo-api.example.test';
const KEY = 'test-cle-au106-agent-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SAMPLES = 30;

async function setup() {
  const raw = openMemoryDatabase();
  const plain = fromSyncSqlite(raw);
  await applyMigrations(plain, loadMigrations());
  const at = '2027-03-01T08:00:00.000Z';
  raw.prepare("INSERT INTO networks (id, name, created_at) VALUES ('net-1', 'Réseau test', ?)").run(at);
  raw.prepare("INSERT INTO agents (id, network_id, first_name, last_name, status, created_at, updated_at) VALUES ('agent-1', 'net-1', 'Alex', 'Essai', 'active', ?, ?)").run(at, at);
  const person = raw.prepare("INSERT INTO persons (id, network_id, agent_id, first_name, last_name, created_at, updated_at) VALUES (?, 'net-1', 'agent-1', ?, 'Exemple', ?, ?)");
  const phone = raw.prepare("INSERT INTO person_identifiers (id, network_id, agent_id, person_id, kind, value, created_at) VALUES (?, 'net-1', 'agent-1', ?, 'phone', ?, ?)");
  const inbound = raw.prepare("INSERT INTO inbound_messages (id, network_id, dedup_key, channel, kind, body, status, person_id, received_at, created_at) VALUES (?, 'net-1', ?, 'email', 'email', ?, 'processed', ?, ?, ?)");
  const qualification = raw.prepare("INSERT INTO qualifications (id, network_id, inbound_id, person_id, category, deadline, financing, criteria, source, created_at) VALUES (?, 'net-1', ?, ?, 'seller', NULL, NULL, '[]', 'rules', ?)");
  const task = raw.prepare("INSERT INTO callback_tasks (id, network_id, person_id, project_id, qualification_id, dedup_key, reason, due_at, created_at, done_at) VALUES (?, 'net-1', ?, NULL, ?, ?, 'Vendeur', ?, ?, NULL)");
  const property = raw.prepare("INSERT INTO properties (id, network_id, agent_id, reference, kind, postal_code, city, surface_m2, rooms, price_eur, status, created_at, updated_at) VALUES (?, 'net-1', 'agent-1', ?, 'home', '21000', 'Dijon', ?, ?, ?, 'available', ?, ?)");
  raw.exec('BEGIN');
  for (let i = 0; i < PORTEFEUILLE.clients; i++) {
    const id = `p-${i}`;
    person.run(id, `Client${i}`, at, at);
    phone.run(`pi-${i}`, id, `+3360000${String(i).padStart(4, '0')}`, at);
    for (let m = 0; m < PORTEFEUILLE.messagesParClient; m++) inbound.run(`in-${i}-${m}`, `k-${i}-${m}`, 'Bonjour, je souhaite vendre ma maison. '.repeat(4), id, at, at);
    qualification.run(`q-${i}`, `in-${i}-0`, id, at);
    for (let r = 0; r < PORTEFEUILLE.rappelsParClient; r++) task.run(`t-${i}-${r}`, id, `q-${i}`, `kt-${i}-${r}`, at, at);
  }
  for (let b = 0; b < PORTEFEUILLE.biens; b++) property.run(`b-${b}`, `REF-${b}`, 40 + (b % 120), 1 + (b % 6), 90_000 + b * 1_000, at, at);
  raw.exec('COMMIT');

  // Chaque requête à la base est comptée : le réseau modélisé en fait payer le coût d'une requête D1.
  let queries = 0;
  const db: SqlDatabase = {
    ...plain,
    exec: async (sql) => { queries += 1; await plain.exec?.(sql); },
    run: async (sql, params) => { queries += 1; return plain.run(sql, params); },
    all: async (sql, params) => { queries += 1; return plain.all(sql, params); },
    first: async (sql, params) => { queries += 1; return plain.first(sql, params); },
    batch: async (statements) => { queries += statements.length; return plain.batch!(statements); },
  };
  let clock = Date.parse('2027-03-02T09:00:00.000Z');
  const now = (): Date => new Date((clock += 1_000));
  const apiKeys = JSON.stringify([{ sha256: await sha256Hex(KEY), role: 'agent', userId: 'agent-1', networkId: 'net-1' }]);
  const config: ApiConfig = { db, apiKeys, mode: 'essai', now };
  /** Une étape, mesurée : le temps du serveur, ses requêtes, les octets qui voyagent. */
  const measure = async (method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; sample: Echantillon }> => {
    const text = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = { authorization: `Bearer ${KEY}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const before = queries;
    const started = performance.now();
    const r = await handleRequest(new Request(`${BASE}/v1${path}`, { method, headers, ...(body === undefined ? {} : { body: text }) }), config);
    const answer = await r.text();
    const serverMs = performance.now() - started;
    const requestBytes = Buffer.byteLength(`${method} /v1${path}`) + Object.entries(headers).reduce((n, [k, v]) => n + k.length + v.length + 4, 0) + Buffer.byteLength(text);
    return { status: r.status, sample: { serverMs, queries: queries - before, requestBytes, responseBytes: gzipSize(answer) } };
  };
  return { measure };
}

describeWithSqlite('AU106 · le parcours de l’agent sur téléphone, mesuré au 95e centile', () => {
  it('[R201] constat : un écran léger peut cacher une fiche lente ; le parcours compte le temps du serveur, la base et le réseau', () => {
    // Une réponse de 2 Ko compressés passe le budget de poids, mais 60 requêtes à la base et un serveur lent la rendent lente.
    const slow: Echantillon = { serverMs: 600, queries: 60, requestBytes: 300, responseBytes: 2048 };
    expect(modeledMs(slow)).toBeGreaterThan(SEUILS_P95.ouverture);
    const samples = Object.fromEntries(ETAPES.map((e) => [e, Array.from({ length: 20 }, () => slow)])) as Record<Etape, Echantillon[]>;
    expect(parcoursProblems(samples).problems).toContain(`ouverture : ${Math.round(modeledMs(slow))} ms au 95e centile pour 1000 ms (4G lente)`);
    // Sans échantillon, rien n'est prouvé.
    expect(parcoursProblems({ ouverture: [], recherche: [], sauvegarde: [] }).problems).toHaveLength(3);
    expect(p95([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 100])).toBe(19);
  });

  it(`[R201] ouvrir une fiche, chercher, enregistrer un rappel fait : ${PORTEFEUILLE.clients} clients, ${PORTEFEUILLE.biens} biens, ${RESEAU_MOBILE.name}, sous les seuils au 95e centile`, async () => {
    const t = await setup();
    const samples: Record<Etape, Echantillon[]> = { ouverture: [], recherche: [], sauvegarde: [] };
    // Une première demande réveille le code ; elle ne compte pas.
    expect((await t.measure('GET', '/fiches/p-0/resume')).status).toBe(200);
    for (let i = 0; i < SAMPLES; i++) {
      const client = `p-${(i * 37) % PORTEFEUILLE.clients}`;
      const open = await t.measure('GET', `/fiches/${client}/resume`);
      expect(open.status, 'ouverture').toBe(200);
      samples.ouverture.push(open.sample);
      const search = await t.measure('POST', '/recherche/phrase', { phrase: `maison ${2 + (i % 4)} pièces à Dijon moins de ${200 + i * 5} 000 euros` });
      expect(search.status, 'recherche').toBe(200);
      samples.recherche.push(search.sample);
      const save = await t.measure('POST', `/rappels/t-${(i * 37) % PORTEFEUILLE.clients}-0/fait`);
      expect(save.status, 'sauvegarde').toBe(200);
      samples.sauvegarde.push(save.sample);
    }
    const { mesures, problems } = parcoursProblems(samples);
    // Les mesures sont écrites dans le rapport de la vérification, étape par étape.
    console.info(`AU106 · ${RESEAU_MOBILE.name} : ${mesures.map((m) => `${m.etape} ${m.p95Ms} ms (seuil ${m.seuilMs})`).join(' ; ')}`);
    expect(problems).toEqual([]);
    // Aucune étape ne relit le portefeuille entier : le nombre de requêtes ne dépend pas du nombre de clients.
    for (const etape of ETAPES) expect(Math.max(...samples[etape].map((s) => s.queries)), etape).toBeLessThanOrEqual(40);
  });
});
