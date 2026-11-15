import { expect, it } from 'vitest';
import type { Viewer } from '@aimmo/core';
import { PUBLIC_SOURCES, type SourceDocument } from '../../core/src/documents/copropriete-urbanisme.ts';
import type { CoproExcerpt, UrbanismPoint } from '../../core/src/documents/index.ts';
import type { Geocoded } from '../../core/src/estimation/collecte.ts';
import { MAX_COPROPRIETE_BODY_BYTES, coproprieteRoutes, type CoproprieteServices } from '../src/copropriete.ts';
import { setupDossier } from '../../core/test/dossiers-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// Documents, adresses et réponses inventés.
const PV: SourceDocument = {
  kind: 'pv_assemblee',
  ref: 'dossiers/test/pv-2027-01-15.pdf',
  meetingDay: '2027-01-15',
  pages: [
    "Procès-verbal de l'assemblée générale ordinaire du 15 janvier 2027.",
    "Résolution n° 7 : l'assemblée décide le ravalement de la façade sur rue pour un montant de 48 000 € TTC, exigible le 1er septembre 2027.\nAucune procédure judiciaire n'est en cours contre le syndicat.",
  ],
};
const PLU: SourceDocument = { kind: 'plu_reglement', ref: 'dossiers/test/plu.pdf', pages: ['Zone UA : zone urbaine centrale.\nServitude de protection des monuments historiques sur tout le secteur.'] };
const DOCS = [PV, PLU];
const SENTENCES = [
  {
    topic: 'travaux_votes',
    text: 'Le ravalement de la façade sur rue est voté',
    document: 0,
    page: 2,
    quote: "l'assemblée décide le ravalement de la façade sur rue pour un montant de 48 000 € TTC, exigible le 1er septembre 2027",
    works: { amountEur: 48000, dueOn: '2027-09-01' },
  },
  { topic: 'procedures', text: 'Aucune procédure judiciaire en cours contre le syndicat', document: 0, page: 2, quote: "Aucune procédure judiciaire n'est en cours contre le syndicat" },
];
const ADDRESS = '7 rue des Essais, 21000 Dijon';
const PLACE: Geocoded = { label: '7 Rue des Essais 21000 Dijon', lat: 47.3216, lon: 5.0415, postalCode: '21000', inseeCode: '21231', town: 'Dijon', banId: '21231_0000_00007', score: 0.93 };

async function setup(o: { place?: Geocoded | null | 'panne'; reader?: (e: CoproExcerpt[]) => Promise<unknown> } = {}) {
  const t = await setupDossier('appartement');
  const geocoded: string[] = [];
  const points: UrbanismPoint[] = [];
  const services: CoproprieteServices = {
    db: t.db,
    journal: t.journal,
    now: t.now,
    geocoder: {
      geocode: async (address) => {
        geocoded.push(address);
        if (o.place === 'panne') throw new Error('BAN en panne');
        return o.place === undefined ? PLACE : o.place;
      },
    },
    urbanism: {
      collect: async (point) => {
        points.push(point);
        return { ok: true, source: PUBLIC_SOURCES.urbanism, collectedAt: t.now().toISOString(), dataDate: '2019-12-16', value: { documentType: 'PLU', zone: 'UA', label: 'Zone urbaine centrale' } };
      },
    },
    ...(o.reader ? { reader: { read: o.reader } } : {}),
  };
  const routes = coproprieteRoutes();
  const call = async (viewer: Viewer, method: 'GET' | 'POST', path: string, body?: unknown, over: Partial<CoproprieteServices> = {}, raw?: string) => {
    const route = routes.find((r) => r.method === method && r.pattern.test(path));
    if (!route) throw new Error(`pas de route ${method} ${path}`);
    const params = path.match(route.pattern)!.slice(1);
    const text = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const request = new Request(`https://api.example.test/v1${path}`, { method, ...(text === undefined ? {} : { body: text, headers: { 'content-type': 'application/json' } }) });
    const res = await route.handle({ ...services, ...over }, viewer, params, request);
    return { status: res.status, body: (await res.json()) as { ok: boolean; code?: string; rule?: string | null; data?: any } };
  };
  const journalText = async () => JSON.stringify(await t.db.all('SELECT * FROM journal'));
  return { ...t, call, geocoded, points, journalText, base: `/dossiers/${t.fileId}/copropriete` };
}

describeWithSqlite('RC52 · copropriété et urbanisme résumés par la route', () => {
  it('[R448] [R451] résumé préparé, relu, et les travaux votés à venir dits à l’acquéreur', async () => {
    const t = await setup();
    const r = await t.call(t.agent, 'POST', `${t.base}/resume`, { documents: DOCS, sentences: SENTENCES, address: ADDRESS });
    expect(r.status).toBe(200);
    expect(r.body.data.version).toBe(1);
    expect(r.body.data.topics.find((x: { topic: string }) => x.topic === 'travaux_votes').found).toBe(true);
    expect(r.body.data.worksToNotify).toHaveLength(1);

    const read = await t.call(t.direction, 'GET', `${t.base}/resume`);
    expect(read.status).toBe(200);
    expect(read.body.data.id).toBe(r.body.data.id);
    const buyer = await t.call(t.agent, 'GET', `${t.base}/acquereur`);
    expect(buyer.status).toBe(200);
    expect(buyer.body.data.lines[0]).toContain('Travaux votés en assemblée du 15/01/2027');
    expect(buyer.body.data.lines[0]).toContain('48 000 €');
    expect(buyer.body.data.lines[0]).toContain('échéance le 01/09/2027');
  });

  it('[R449] [R13] la zone est lue au Géoportail au point du bien : seules la position et la commune partent, l’adresse n’est nulle part au journal', async () => {
    const t = await setup();
    const r = await t.call(t.agent, 'POST', `${t.base}/resume`, { documents: DOCS, sentences: SENTENCES, address: `  ${ADDRESS} ` });
    expect(r.status).toBe(200);
    expect(t.geocoded).toEqual([ADDRESS]);
    expect(t.points).toEqual([{ lat: 47.3216, lon: 5.0415, inseeCode: '21231' }]);
    expect(Object.keys(t.points[0]!).sort()).toEqual(['inseeCode', 'lat', 'lon']);
    expect(r.body.data.urbanism).toMatchObject({ found: true, source: PUBLIC_SOURCES.urbanism, dataDate: '2019-12-16', value: { zone: 'UA', documentType: 'PLU' } });
    expect(r.body.data.registry).toMatchObject({ found: false, reason: 'non_collecte' });
    expect(JSON.stringify(r.body)).not.toContain('Essais');
    const log = await t.journalText();
    expect(log).toContain('dossier.urbanisme_collecte');
    for (const leak of ['Essais', '21231_0000', '47.3216', 'UA']) expect(log).not.toContain(leak);
  });

  it('[R449] une donnée publique envoyée par l’écran est refusée, rien n’est collecté ni rangé', async () => {
    const t = await setup();
    const fake = { urbanism: { ok: true, source: PUBLIC_SOURCES.urbanism, collectedAt: '2027-03-01T08:00:00.000Z', dataDate: '2020-01-01', value: { documentType: 'PLU', zone: 'UA', label: 'Constructible' } } };
    for (const body of [{ documents: DOCS, sentences: SENTENCES, publicData: fake }, { documents: DOCS, sentences: SENTENCES, urbanism: fake.urbanism }, { documents: DOCS, sentences: SENTENCES, registry: {} }]) {
      const r = await t.call(t.agent, 'POST', `${t.base}/resume`, body);
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ ok: false, rule: 'R449', code: 'public_data_not_accepted' });
    }
    expect(t.geocoded).toEqual([]);
    expect((await t.call(t.agent, 'GET', `${t.base}/resume`)).status).toBe(404);
  });

  it('adresse d’une autre commune ou géocodage incertain : zone introuvable, rien parti au Géoportail', async () => {
    for (const place of [{ ...PLACE, postalCode: '21800', inseeCode: '21515' }, { ...PLACE, score: 0.4 }, null]) {
      const t = await setup({ place });
      const r = await t.call(t.agent, 'POST', `${t.base}/resume`, { documents: DOCS, sentences: SENTENCES, address: ADDRESS });
      expect(r.status).toBe(200);
      expect(r.body.data.urbanism).toMatchObject({ found: false, text: 'non trouvé', reason: 'introuvable' });
      expect(t.points).toEqual([]);
    }
    const down = await setup({ place: 'panne' });
    const r = await down.call(down.agent, 'POST', `${down.base}/resume`, { documents: DOCS, sentences: SENTENCES, address: ADDRESS });
    expect(r.body.data.urbanism).toMatchObject({ found: false, reason: 'panne' });
    expect(down.points).toEqual([]);
    // Le Géoportail qui lève : panne, jamais une erreur.
    const t = await setup();
    const thrown = await t.call(t.agent, 'POST', `${t.base}/resume`, { documents: DOCS, sentences: SENTENCES, address: ADDRESS }, { urbanism: { collect: async () => Promise.reject(new Error('délai')) } });
    expect(thrown.status).toBe(200);
    expect(thrown.body.data.urbanism).toMatchObject({ found: false, reason: 'panne' });
  });

  it('sans adresse ou sans services : zone non collectée', async () => {
    const t = await setup();
    const none = await t.call(t.agent, 'POST', `${t.base}/resume`, { documents: DOCS, sentences: SENTENCES });
    expect(none.body.data.urbanism).toMatchObject({ found: false, reason: 'non_collecte' });
    const blank = await t.call(t.agent, 'POST', `${t.base}/resume`, { documents: DOCS, sentences: SENTENCES, address: '   ' });
    expect(blank.body.data.urbanism).toMatchObject({ found: false, reason: 'non_collecte' });
    const off = await t.call(t.agent, 'POST', `${t.base}/resume`, { documents: DOCS, sentences: SENTENCES, address: ADDRESS }, { geocoder: null, urbanism: null });
    expect(off.body.data.urbanism).toMatchObject({ found: false, reason: 'non_collecte' });
    expect(off.body.data.version).toBe(3);
    expect(t.geocoded).toEqual([]);
  });

  it('[R12] prélecture sans lecteur : aucune phrase, rubriques à lire ; avec un lecteur, des phrases vérifiées', async () => {
    const t = await setup();
    const manual = await t.call(t.agent, 'POST', `${t.base}/prelecture`, { documents: DOCS });
    expect(manual.status).toBe(200);
    expect(manual.body.data).toMatchObject({ source: 'manuel', sentences: [] });
    expect(manual.body.data.toRead).toContain('travaux_votes');

    const withReader = await setup({
      reader: async () => ({ sentences: [{ topic: 'procedures', text: 'Aucune procédure judiciaire en cours contre le syndicat', document: 0, page: 2, line: 2 }] }),
    });
    const r = await withReader.call(withReader.agent, 'POST', `${withReader.base}/prelecture`, { documents: DOCS });
    expect(r.status).toBe(200);
    expect(r.body.data.source).toBe('ia');
    expect(r.body.data.sentences).toEqual([expect.objectContaining({ topic: 'procedures', quote: "Aucune procédure judiciaire n'est en cours contre le syndicat." })]);
    // La phrase prélue passe telle quelle au résumé.
    const prepared = await withReader.call(withReader.agent, 'POST', `${withReader.base}/resume`, { documents: DOCS, sentences: r.body.data.sentences });
    expect(prepared.status).toBe(200);
    expect(prepared.body.data.rejected).toEqual([]);
  });

  it('[R16] autre agent, rôle refusé, dossier inconnu : refus, aucun géocodage', async () => {
    const t = await setup();
    const other = await t.call(t.sam, 'POST', `${t.base}/resume`, { documents: DOCS, sentences: SENTENCES, address: ADDRESS });
    expect(other.status).toBe(403);
    const dir = await t.call(t.direction, 'POST', `${t.base}/resume`, { documents: DOCS, sentences: SENTENCES, address: ADDRESS });
    expect(dir).toMatchObject({ status: 403, body: { rule: 'R16', code: 'role' } });
    expect((await t.call(t.direction, 'POST', `${t.base}/prelecture`, { documents: DOCS })).status).toBe(403);
    const partner = { role: 'partner', userId: 'p-1', networkId: t.network.id } as Viewer;
    expect((await t.call(partner, 'GET', `${t.base}/resume`)).status).toBe(403);
    expect((await t.call(partner, 'GET', `${t.base}/acquereur`)).status).toBe(403);
    expect((await t.call(t.agent, 'POST', `/dossiers/inconnu/copropriete/resume`, { documents: DOCS, sentences: SENTENCES, address: ADDRESS })).status).toBe(404);
    expect((await t.call(t.sam, 'GET', `${t.base}/resume`)).status).toBe(403);
    expect(t.geocoded).toEqual([]);
    expect(t.points).toEqual([]);
    expect(await t.journalText()).toContain('acces.refuse');
  });

  it('corps mal formé, trop gros, adresse mal formée ou documents mal formés : 400', async () => {
    const t = await setup();
    expect((await t.call(t.agent, 'POST', `${t.base}/resume`, undefined, {}, 'pas du json')).body.code).toBe('invalid_body');
    expect((await t.call(t.agent, 'POST', `${t.base}/resume`, [1, 2])).body.code).toBe('invalid_body');
    const huge = JSON.stringify({ documents: [{ ...PLU, pages: ['x'.repeat(MAX_COPROPRIETE_BODY_BYTES)] }], sentences: [] });
    expect((await t.call(t.agent, 'POST', `${t.base}/resume`, undefined, {}, huge)).body.code).toBe('invalid_body');
    expect((await t.call(t.agent, 'POST', `${t.base}/resume`, { documents: DOCS, sentences: SENTENCES, address: 12 })).body.code).toBe('invalid_address');
    expect((await t.call(t.agent, 'POST', `${t.base}/resume`, { documents: DOCS, sentences: SENTENCES, address: 'x'.repeat(201) })).body.code).toBe('invalid_address');
    expect((await t.call(t.agent, 'POST', `${t.base}/resume`, { documents: 'non', sentences: [] })).body.code).toBe('bad_documents');
    expect((await t.call(t.agent, 'POST', `${t.base}/resume`, { documents: [{ kind: 'autre', ref: 'x', pages: ['a'] }], sentences: [] })).body.code).toBe('bad_documents');
    expect((await t.call(t.agent, 'POST', `${t.base}/prelecture`, { documents: [] })).body.code).toBe('bad_documents');
    expect(t.geocoded).toEqual([]);
  });

  it('chaque route dit ses rôles', () => {
    const roles = Object.fromEntries(coproprieteRoutes().map((r) => [r.name, r.roles]));
    expect(roles).toEqual({
      'copropriete.prelecture': ['agent'],
      'copropriete.preparer': ['agent'],
      'copropriete.resume': ['agent', 'direction', 'compliance'],
      'copropriete.acquereur': ['agent', 'direction', 'compliance'],
    });
  });
});
