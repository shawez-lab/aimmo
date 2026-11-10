import { expect, it } from 'vitest';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import type { PigeSource, RawAd } from '../../core/src/pige/index.ts';
import type { AdressePigeServices } from '../../core/src/adresse-pige/index.ts';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../../core/src/index.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Le lundi 7 décembre 2026, 10 h à Paris. Réseau, agents, annonces, diagnostics, parcelles et clés d'API inventés.
const MONDAY_10H = Date.parse('2026-12-07T09:00:00.000Z');
const DAY = 86_400_000;
const KEYS = {
  alex: 'test-cle-br30-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  sam: 'test-cle-br30-sam-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  direction: 'test-cle-br30-direction-cccccccccccccccccccccc',
  conformite: 'test-cle-br30-conformite-ddddddddddddddddddddd',
};
type Who = keyof typeof KEYS;

/** Un diagnostic de la base de l'ADEME, avec des champs de trop qui ne doivent jamais passer. */
const RAW_DIAGNOSIS = {
  numero_dpe: '2621E0000001T',
  date_etablissement_dpe: '2026-09-15',
  date_reception_dpe: '2026-09-16',
  etiquette_dpe: 'F',
  etiquette_ges: 'E',
  type_batiment: 'maison',
  surface_habitable_logement: 90.2,
  numero_voie_ban: '7',
  nom_rue_ban: 'Rue des Essais',
  code_postal_ban: '21240',
  nom_commune_ban: 'Talant',
  _geopoint: '47.33,5.01',
  nom_proprietaire: 'Jean Essai',
  telephone: '0600000000',
};

async function setup(options: { sources?: AdressePigeServices | 'none' } = {}) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = () => new Date(MONDAY_10H);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const net = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: net.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: net.id, firstName: 'Sam', lastName: 'Bienveillant' });
  const zone = async (agentId: string, commune: string) =>
    db.run("INSERT INTO agent_zones (id, network_id, agent_id, commune, created_at, ended_at) VALUES (?, ?, ?, ?, '2026-01-01T00:00:00.000Z', NULL)", [crypto.randomUUID(), net.id, agentId, commune]);
  await zone(alex.id, 'Talant');
  await zone(sam.id, 'Fontaine-lès-Dijon');
  const ads: RawAd[] = [
    {
      source: 'Site A',
      sourceRef: 'a-1',
      kind: 'house',
      commune: 'Talant',
      postalCode: '21240',
      surfaceM2: 90,
      rooms: 4,
      priceEur: 279_000,
      publishedAt: new Date(MONDAY_10H - DAY).toISOString(),
      text: 'Belle maison avec jardin, appelez Jean Particulier au 06 00 00 00 01.',
      phone: '0600000001',
      name: 'Jean Particulier',
      energyClass: 'F',
      diagnosedOn: '2026-09-15',
    } as RawAd,
  ];
  const source: PigeSource = { ads: async () => ads };
  const searches: unknown[] = [];
  let parcelReads = 0;
  const sources: AdressePigeServices =
    options.sources === 'none'
      ? {}
      : (options.sources ?? {
          search: {
            matching: async (q) => {
              searches.push(q);
              return [RAW_DIAGNOSIS];
            },
          },
          cadastre: {
            parcelAt: async () => {
              parcelReads += 1;
              return { id: '21617000AB0042', section: 'AB', number: '0042', area: 600 };
            },
          },
        });
  const ids: Record<Who, { role: string; userId: string }> = {
    alex: { role: 'agent', userId: alex.id },
    sam: { role: 'agent', userId: sam.id },
    direction: { role: 'direction', userId: 'direction-1' },
    conformite: { role: 'compliance', userId: 'conformite-1' },
  };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: net.id, ...ids[w] }))));
  const config: ApiConfig = { db, apiKeys, mode: 'essai', now, pigeSource: source, adressePigeSources: sources };
  const http = async (who: Who, method: 'GET' | 'POST', path: string, body?: unknown, raw?: string) => {
    const headers: Record<string, string> = { authorization: `Bearer ${KEYS[who]}` };
    if (body !== undefined || raw !== undefined) headers['content-type'] = 'application/json';
    const init: RequestInit = { method, headers };
    if (raw !== undefined) init.body = raw;
    else if (body !== undefined) init.body = JSON.stringify(body);
    const r = await handleRequest(new Request(`https://aimmo-api.example.test/v1${path}`, init), config);
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; rule?: string | null; code?: string; mode?: string; field?: string } };
  };
  const refusals = async () => (await journal.all()).filter((e) => e.type === 'acces.refuse' && e.data.kind === 'adresse_pige');
  const count = async (table: string) => (await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))!.n;
  /** La relève de la direction, puis l'annonce de la file d'Alex. */
  const firstAd = async (): Promise<string> => {
    expect((await http('direction', 'POST', '/pige/releve')).status).toBe(200);
    const q = await http('alex', 'GET', '/pige');
    return q.body.data[0].adId as string;
  };
  return { db, net, alex, http, refusals, count, firstAd, searches, parcelReads: () => parcelReads };
}

describeWithSqlite('BR30 · routes de l’adresse probable d’une annonce de pige, et du bien créé sans ressaisie', () => {
  it('[R16] chaque route refuse le mauvais rôle en 403, au journal, avant de lire le corps ou les sources', async () => {
    const t = await setup();
    const cases: [Who, 'GET' | 'POST', string, string?][] = [
      ['direction', 'POST', '/pige/annonces/x1/adresses'],
      ['conformite', 'POST', '/pige/annonces/x1/adresses'],
      // Corps illisible : le rôle est refusé d'abord.
      ['direction', 'POST', '/pige/annonces/x1/bien', '{pas du json'],
      ['conformite', 'POST', '/pige/annonces/x1/bien'],
      ['conformite', 'GET', '/pige/rapport'],
      ['conformite', 'GET', '/pige/biens/p1'],
    ];
    for (const [who, method, path, raw] of cases) {
      const r = await t.http(who, method, path, undefined, raw);
      expect(r.status, `${who} ${path}`).toBe(403);
      expect(r.body).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    }
    expect((await t.refusals()).length).toBe(cases.length);
    expect(t.searches).toHaveLength(0);
    expect(await t.count('pige_address_proposals')).toBe(0);
    expect(await t.count('pige_properties')).toBe(0);
  });

  it('[R294] l’agent de la zone reçoit les adresses probables avec leur confiance et leurs sources ; rien du particulier', async () => {
    const t = await setup();
    const adId = await t.firstAd();
    const r = await t.http('alex', 'POST', `/pige/annonces/${adId}/adresses`);
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe('essai');
    const [c, ...rest] = r.body.data.candidates;
    expect(rest).toEqual([]);
    expect(c).toMatchObject({ diagnosisNumber: '2621E0000001T', streetNumber: '7', street: 'Rue des Essais', confidence: 100, level: 'forte' });
    for (const p of c.points) {
      expect(p.source.length).toBeGreaterThan(3);
      expect(p.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(r.body.data.missing).toEqual([]);
    expect(t.parcelReads()).toBe(1);
    // Seuls le code postal, la sorte, la surface et la classe partent vers l'ADEME.
    expect(t.searches).toEqual([{ postcode: '21240', kind: 'house', surfaceMin: 89, surfaceMax: 91, energyClass: 'F' }]);
    const text = JSON.stringify(r.body);
    expect(text).not.toMatch(/Jean|Particulier|0600000|06 00|telephone|proprietaire/i);
    // La proposition est rangée sans rue ni numéro.
    const stored = await t.db.first<{ candidates: string }>('SELECT candidates FROM pige_address_proposals');
    expect(stored!.candidates).not.toMatch(/Essais/);
    // Un autre agent hors de la zone n'a rien.
    const sam = await t.http('sam', 'POST', `/pige/annonces/${adId}/adresses`);
    expect(sam.status).toBe(403);
    expect(sam.body.code).toBe('hors_zone');
  });

  it('[R294] sans données publiques branchées, seuls les diagnostics de la veille servent, et la réponse le dit', async () => {
    const t = await setup({ sources: 'none' });
    const adId = await t.firstAd();
    const r = await t.http('alex', 'POST', `/pige/annonces/${adId}/adresses`);
    expect(r.status).toBe(200);
    expect(r.body.data.candidates).toEqual([]);
    expect(r.body.data.missing.map((m: { reason: string }) => m.reason).join(' ')).toMatch(/non branchée.*cadastre non branché/);
  });

  it('[R295] [R294] le bien est créé d’un geste avec les champs de l’annonce, source « pige », l’adresse retenue et sa confiance ; une seule fois', async () => {
    const t = await setup();
    const adId = await t.firstAd();
    const p = await t.http('alex', 'POST', `/pige/annonces/${adId}/adresses`);
    const proposalId = p.body.data.proposalId as string;
    // Une adresse qui n'a pas été proposée ne se retient jamais.
    const typed = await t.http('alex', 'POST', `/pige/annonces/${adId}/bien`, { proposalId, diagnosisNumber: '2621E9999999T' });
    expect(typed.status).toBe(409);
    expect(typed.body).toMatchObject({ rule: 'R294', code: 'adresse_inconnue' });
    const r = await t.http('alex', 'POST', `/pige/annonces/${adId}/bien`, { proposalId, diagnosisNumber: '2621E0000001T' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      kind: 'home',
      adKind: 'house',
      postalCode: '21240',
      city: 'Talant',
      surfaceM2: 90,
      rooms: 4,
      priceEur: 279_000,
      energyClass: 'F',
      diagnosedOn: '2026-09-15',
      source: 'pige',
      adSite: 'Site A',
      address: { streetNumber: '7', street: 'Rue des Essais', confidence: 100, level: 'forte', diagnosisNumber: '2621E0000001T' },
    });
    expect(JSON.stringify(r.body)).not.toMatch(/Jean|Particulier|0600000/);
    const again = await t.http('alex', 'POST', `/pige/annonces/${adId}/bien`, {});
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ rule: 'R295', code: 'deja_cree' });
    expect(await t.count('pige_properties')).toBe(1);
    // La source reste « pige » : l'agent du bien et la direction la lisent, un autre agent non.
    const propertyId = r.body.data.propertyId as string;
    const own = await t.http('alex', 'GET', `/pige/biens/${propertyId}`);
    expect(own.status).toBe(200);
    expect(own.body.data).toEqual({ propertyId, source: 'pige', adSite: 'Site A', confidence: 100 });
    expect((await t.http('direction', 'GET', `/pige/biens/${propertyId}`)).status).toBe(200);
    const other = await t.http('sam', 'GET', `/pige/biens/${propertyId}`);
    expect(other.status).toBe(403);
    expect(other.body).toMatchObject({ rule: 'R16', code: 'pas_son_bien' });
    expect((await t.http('direction', 'GET', '/pige/biens/inconnu-1')).status).toBe(404);
  });

  it('[R273] une annonce fermée par le particulier n’est jamais convertie', async () => {
    const t = await setup();
    const adId = await t.firstAd();
    expect((await t.http('alex', 'POST', `/pige/annonces/${adId}/opposition`)).status).toBe(200);
    const r = await t.http('alex', 'POST', `/pige/annonces/${adId}/bien`, {});
    expect(r.status).toBe(409);
    expect(['R273', 'R04']).toContain(r.body.rule);
    expect(await t.count('pige_properties')).toBe(0);
    expect(await t.count('properties')).toBe(0);
  });

  it('[R296] ce que la pige rapporte, par niveau de confiance : l’agent les siens, la direction le réseau', async () => {
    const t = await setup();
    const adId = await t.firstAd();
    expect((await t.http('alex', 'POST', `/pige/annonces/${adId}/bien`)).status).toBe(200);
    const mine = await t.http('alex', 'GET', '/pige/rapport');
    expect(mine.status).toBe(200);
    expect(mine.body.data).toEqual({
      rows: [
        { level: 'forte', properties: 0, mandates: 0 },
        { level: 'moyenne', properties: 0, mandates: 0 },
        { level: 'faible', properties: 0, mandates: 0 },
        { level: 'sans_adresse', properties: 1, mandates: 0 },
      ],
      properties: 1,
      mandates: 0,
      rate: 0,
    });
    expect((await t.http('sam', 'GET', '/pige/rapport')).body.data.properties).toBe(0);
    expect((await t.http('direction', 'GET', '/pige/rapport')).body.data.properties).toBe(1);
  });

  it('corps mal formé, champ ou paramètre non prévu : 400 sans rien ranger', async () => {
    const t = await setup();
    const adId = await t.firstAd();
    const cases: [string, 'GET' | 'POST', unknown, string?][] = [
      [`/pige/annonces/${adId}/adresses`, 'POST', { x: 1 }],
      [`/pige/annonces/${adId}/adresses`, 'POST', undefined, '{pas du json'],
      [`/pige/annonces/${adId}/bien`, 'POST', undefined, '[1]'],
      [`/pige/annonces/${adId}/bien`, 'POST', { street: 'Rue tapée' }],
      [`/pige/annonces/${adId}/bien`, 'POST', { proposalId: 'p1' }],
      [`/pige/annonces/${adId}/bien`, 'POST', { padding: 'x'.repeat(3_000) }],
      ['/pige/rapport?agent=x', 'GET', undefined],
    ];
    for (const [path, method, body, raw] of cases) {
      const r = await t.http('alex', method, path, body, raw);
      expect(r.status, path).toBe(400);
    }
    expect(await t.count('pige_address_proposals')).toBe(0);
    expect(await t.count('pige_properties')).toBe(0);
  });
});
