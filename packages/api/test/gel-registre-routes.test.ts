import { expect, it } from 'vitest';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { MAX_DGTRESOR_BYTES, REGISTRE_GELS_URL, REGISTRE_GELS_USER_AGENT, type RegistreGelsSource } from '../src/securite.ts';
import { registreGelsUrl } from '../src/worker.ts';
import { setupAnnonce } from '../../core/test/annonces-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// BR85. Réseau, agents, clés et fichier inventés, à la forme du fichier public de la DG Trésor : aucune de ces
// personnes ni sociétés n'existe. Le mardi 9 mars 2027, à 10 h à Paris.
const NOW = new Date('2027-03-09T09:00:00.000Z');
const KEYS = {
  alex: 'test-cle-br85-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  direction: 'test-cle-br85-direction-cccccccccccccccccccccc',
  conformite: 'test-cle-br85-conformite-ddddddddddddddddddddd',
};
type Who = keyof typeof KEYS;

const prenoms = (...p: string[]) => ({ TypeChamp: 'PRENOM', Valeur: p.map((x) => ({ Prenom: x })) });
const alias = (...a: string[]) => ({ TypeChamp: 'ALIAS', Valeur: a.map((x) => ({ Alias: x, Commentaire: '' })) });
const ENTREES = [
  { IdRegistre: 9101, Nature: 'Personne physique', Nom: 'FICTIF', RegistreDetail: [prenoms('Marcel', 'Auguste'), alias('Marcel l’Inventé')] },
  { IdRegistre: 9102, Nature: 'Personne morale', Nom: 'SOCIETE IMAGINAIRE SARL', RegistreDetail: [] },
  { IdRegistre: 9103, Nature: 'Navire', Nom: 'NAVIRE INVENTÉ', RegistreDetail: [] },
  // La cliente inventée du jeu, « Léa Exemple », porte le nom d'un alias de cette entrée.
  { IdRegistre: 9104, Nature: 'Personne physique', Nom: 'AUTREMENT', RegistreDetail: [prenoms('Léa'), alias('Léa Exemple')] },
];
const fichier = (detail: unknown[] = ENTREES, date = '2027-03-01T10:00:00') => ({ Publications: { DatePublication: date, PublicationDetail: detail } });

async function setup(source: 'none' | ((r: Request) => Promise<Response>) = 'none') {
  const t = await setupAnnonce();
  t.setClock(NOW);
  const ids: Record<Who, { role: string; userId: string }> = {
    alex: { role: 'agent', userId: t.alexId },
    direction: { role: 'direction', userId: t.direction.userId },
    conformite: { role: 'compliance', userId: 'conformite-1' },
  };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: t.network.id, ...ids[w] }))));
  const asked: Request[] = [];
  const registreGels: RegistreGelsSource | null =
    source === 'none' ? null : { url: 'https://registre.example.test/derniere.json', userAgent: REGISTRE_GELS_USER_AGENT, get: (r) => (asked.push(r), source(r)) };
  const config: ApiConfig = { db: t.db, apiKeys, mode: 'essai', now: t.now, registreGels };
  const http = async (who: Who, method: string, path: string, raw?: string) => {
    const headers: Record<string, string> = { authorization: `Bearer ${KEYS[who]}` };
    if (raw !== undefined) headers['content-type'] = 'application/json';
    const r = await handleRequest(new Request(`https://aimmo-api.example.test/v1${path}`, { method, headers, ...(raw === undefined ? {} : { body: raw }) }), config);
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; rule?: string | null; code?: string; entryId?: string | null } };
  };
  const versions = async () => (await t.db.first<{ n: number }>('SELECT count(*) AS n FROM freeze_registry_versions'))!.n;
  const refusals = async () => (await t.journal.all()).filter((e) => e.type === 'acces.refuse');
  return { ...t, http, asked, versions, refusals };
}

const okFile = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describeWithSqlite('BR85 · le registre des gels importé depuis le fichier de la DG Trésor', () => {
  it('[R16] les deux routes au seul responsable : autre rôle refusé au journal, sans aucun téléchargement', async () => {
    const t = await setup(okFile(fichier()));
    for (const who of ['alex', 'direction'] as Who[]) {
      for (const [path, raw] of [['/securite/gel/registre/dgtresor', undefined], ['/securite/gel/registre/fichier', JSON.stringify(fichier())]] as const) {
        const before = (await t.refusals()).length;
        const r = await t.http(who, 'POST', path, raw);
        expect(r.status, `${who} ${path}`).toBe(403);
        expect(r.body).toMatchObject({ ok: false, rule: 'R16' });
        expect((await t.refusals()).length).toBe(before + 1);
      }
    }
    expect(t.asked).toHaveLength(0);
    expect(await t.versions()).toBe(0);
  });

  it('[R603] [R605] téléchargé avec l’adresse et le User-Agent de la configuration, importé, chaque dossier recontrôlé, l’alias trouvé (Jamais vu)', async () => {
    const t = await setup(okFile(fichier()));
    const r = await t.http('conformite', 'POST', '/securite/gel/registre/dgtresor');
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ entries: 3, vessels: 1, checked: 1, publishedAt: '2027-03-01T09:00:00.000Z', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(t.asked).toHaveLength(1);
    expect(t.asked[0]!.method).toBe('GET');
    expect(t.asked[0]!.url).toBe('https://registre.example.test/derniere.json');
    expect(t.asked[0]!.headers.get('user-agent')).toBe(REGISTRE_GELS_USER_AGENT);
    const matches = await t.http('conformite', 'GET', '/securite/gel/correspondances');
    expect(matches.body.data.map((m: { check: { matches: unknown } }) => m.check.matches)).toEqual([[{ personId: t.personId, entryId: '9104' }]]);
    // Le même fichier une seconde fois : déjà importé, rien de plus rangé.
    expect(await t.http('conformite', 'POST', '/securite/gel/registre/dgtresor')).toMatchObject({ status: 400, body: { code: 'already_imported' } });
    expect(await t.versions()).toBe(1);
  });

  it('[R13] fichier illisible ou refusé : rien rangé, la raison et l’identifiant de l’entrée rendus, jamais un nom', async () => {
    const cases: [unknown, string, string | null][] = [
      [{ Publication: {} }, 'bad_file', null],
      [fichier([...ENTREES, { IdRegistre: 9105, Nature: 'Aéronef', Nom: 'FICTIF AVION', RegistreDetail: [] }]), 'unknown_nature', '9105'],
      [fichier([ENTREES[0], { ...ENTREES[1], IdRegistre: 9101 }]), 'duplicate_entry', '9101'],
    ];
    for (const [file, code, entryId] of cases) {
      const t = await setup(okFile(file));
      const r = await t.http('conformite', 'POST', '/securite/gel/registre/dgtresor');
      expect(r).toEqual({ status: 400, body: { ok: false, rule: null, code, entryId } });
      expect(JSON.stringify(r.body)).not.toMatch(/FICTIF|Marcel|IMAGINAIRE|AVION/);
      expect(await t.versions()).toBe(0);
    }
    const t = await setup(async () => new Response('<html>pas du json</html>', { status: 200 }));
    expect(await t.http('conformite', 'POST', '/securite/gel/registre/dgtresor')).toMatchObject({ status: 400, body: { code: 'bad_file', entryId: null } });
    expect(await t.versions()).toBe(0);
  });

  it('réponse en erreur, coupée, en panne ou trop grosse : rien rangé, dit par un code', async () => {
    const big = new Uint8Array(1024 * 1024).fill(32);
    const sources: [(r: Request) => Promise<Response>, number, string][] = [
      [async () => new Response('Forbidden', { status: 403 }), 502, 'telechargement_echoue'],
      [async () => { throw new TypeError('réseau coupé'); }, 502, 'telechargement_echoue'],
      [async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"Publications":')); c.error(new Error('coupé')); } }), { status: 200 }), 502, 'telechargement_echoue'],
      [async () => new Response('{}', { status: 200, headers: { 'content-length': String(MAX_DGTRESOR_BYTES + 1) } }), 502, 'fichier_trop_gros'],
      [async () => new Response(new ReadableStream({ pull(c) { c.enqueue(big); } }), { status: 200 }), 502, 'fichier_trop_gros'],
    ];
    for (const [source, status, code] of sources) {
      const t = await setup(source);
      expect(await t.http('conformite', 'POST', '/securite/gel/registre/dgtresor'), code).toMatchObject({ status, body: { ok: false, code } });
      expect(await t.versions()).toBe(0);
    }
  });

  it('sans téléchargement configuré : 503, rien rangé ; le dépôt du fichier reste ouvert', async () => {
    const t = await setup();
    expect(await t.http('conformite', 'POST', '/securite/gel/registre/dgtresor')).toMatchObject({ status: 503, body: { code: 'telechargement_absent' } });
    expect(await t.versions()).toBe(0);
    const r = await t.http('conformite', 'POST', '/securite/gel/registre/fichier', '﻿' + JSON.stringify(fichier()));
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ entries: 3, vessels: 1, checked: 1 });
  });

  it('le fichier déposé : même lecture, corps absent, illisible ou trop gros refusé sans rien ranger', async () => {
    const t = await setup();
    expect(await t.http('conformite', 'POST', '/securite/gel/registre/fichier')).toMatchObject({ status: 400, body: { code: 'invalid_body' } });
    expect(await t.http('conformite', 'POST', '/securite/gel/registre/fichier', '{pas du json')).toMatchObject({ status: 400, body: { code: 'bad_file' } });
    expect(await t.http('conformite', 'POST', '/securite/gel/registre/fichier', JSON.stringify(fichier([ENTREES[2]])))).toMatchObject({ status: 400, body: { code: 'no_entries' } });
    const huge = JSON.stringify(fichier()) + ' '.repeat(MAX_DGTRESOR_BYTES);
    expect(await t.http('conformite', 'POST', '/securite/gel/registre/fichier', huge)).toMatchObject({ status: 413, body: { code: 'fichier_trop_gros' } });
    expect(await t.versions()).toBe(0);
  });
});

it('le Worker lit l’adresse https de la configuration, sinon celle de la documentation de la DG Trésor', () => {
  expect(registreGelsUrl(undefined)).toBe(REGISTRE_GELS_URL);
  expect(registreGelsUrl('http://registre.example.test/x.json')).toBe(REGISTRE_GELS_URL);
  expect(registreGelsUrl(' https://registre.example.test/x.json ')).toBe('https://registre.example.test/x.json');
  expect(REGISTRE_GELS_URL.startsWith('https://gels-avoirs.dgtresor.gouv.fr/')).toBe(true);
});
