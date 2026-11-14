import { describe, expect, it } from 'vitest';
import { GpuUrbanism, approvalDay, documentOf } from '../src/documents/collecte-urbanisme.ts';
import { CoproprieteUrbanisme, PUBLIC_SOURCES, renderSummary } from '../src/documents/copropriete-urbanisme.ts';
import type { Fetcher } from '../src/estimation/collecte.ts';
import { setupDossier } from './dossiers-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Réponses inventées, à la forme de l'API Carto du Géoportail de l'urbanisme.
const POINT = { lat: 47.3216, lon: 5.0415, inseeCode: '21231' };
const NOW = () => new Date('2027-02-27T23:30:00.000Z'); // le 28 février à Paris

const zone = (o: Record<string, unknown> = {}) => ({
  type: 'Feature',
  properties: { libelle: 'UA', libelong: 'Zone urbaine centrale', typezone: 'U', idurba: '21231_PLU_20190101', datappro: '20191216', partition: 'DU_21231', ...o },
});

function fetcherOf(answers: { zones?: unknown; sectors?: unknown; town?: unknown; status?: number }, seen: string[] = []): Fetcher {
  return async (url) => {
    seen.push(url);
    const body = url.includes('/zone-urba') ? answers.zones : url.includes('/secteur-cc') ? answers.sectors : answers.town;
    const status = answers.status ?? (body === undefined ? 404 : 200);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
}

const collect = (answers: Parameters<typeof fetcherOf>[0], seen: string[] = []) => new GpuUrbanism(fetcherOf(answers, seen), { now: NOW }).collect(POINT);

describe('RC43 · la zone du plan d’urbanisme lue au Géoportail', () => {
  it('[R449] la zone au point, son libellé, le type du document et le jour de son approbation', async () => {
    expect(await collect({ zones: { features: [zone()] } })).toEqual({
      ok: true,
      source: PUBLIC_SOURCES.urbanism,
      collectedAt: '2027-02-27T23:30:00.000Z',
      dataDate: '2019-12-16',
      value: { documentType: 'PLU', zone: 'UA', label: 'Zone urbaine centrale' },
    });
    const plui = await collect({ zones: { features: [zone({ idurba: '242100410_PLUI_20200227', datappro: '2020-02-27', libelong: null, typezone: 'AUc', libelle: '1AUc' })] } });
    expect(plui).toMatchObject({ ok: true, dataDate: '2020-02-27', value: { documentType: 'PLUi', zone: '1AUc', label: 'Zone à urbaniser' } });
    // Une carte communale : son secteur se lit à part (`secteur-cc`, `typesect`), quand aucune zone n'est au point.
    const sector = (o: Record<string, unknown> = {}) => ({ properties: { libelle: 'ZC', libelong: '', typesect: '01', idurba: '21231_CC_20100512', datappro: '20100512', ...o } });
    const cc = await collect({ zones: { features: [] }, sectors: { features: [sector()] } });
    expect(cc).toMatchObject({ ok: true, dataDate: '2010-05-12', value: { documentType: 'carte_communale', zone: 'ZC', label: 'Secteur ouvert à la construction' } });
    expect(await collect({ zones: { features: [] }, sectors: { features: [sector({ typesect: '03', libelle: 'ZNC' })] } })).toMatchObject({ ok: true, value: { label: 'Secteur non constructible' } });
    // Un document lu à la mauvaise couche n'est pas cru.
    expect(await collect({ zones: { features: [zone({ idurba: '21231_CC_20100512' })] } })).toMatchObject({ ok: false, reason: 'introuvable' });
    expect(await collect({ zones: { features: [] }, sectors: { features: [sector({ idurba: '21231_PLU_20190101' })] } })).toMatchObject({ ok: false, reason: 'introuvable' });
    expect(await collect({ zones: { features: [] }, sectors: { features: [sector({ idurba: '21054_CC_20100512' })] } })).toMatchObject({ ok: false, reason: 'introuvable' });
    // La même zone rendue deux fois (deux morceaux du même polygone) reste une seule zone.
    expect(await collect({ zones: { features: [zone(), zone()] } })).toMatchObject({ ok: true, value: { zone: 'UA' } });
  });

  it('[R15] seules la position et la commune partent, jamais l’adresse', async () => {
    const seen: string[] = [];
    await collect({ zones: { features: [] }, sectors: { features: [] }, town: { features: [{ properties: { insee: '21231', is_rnu: true } }] } }, seen);
    expect(seen).toHaveLength(3);
    expect(decodeURIComponent(seen[0]!)).toBe('https://apicarto.ign.fr/api/gpu/zone-urba?geom={"type":"Point","coordinates":[5.0415,47.3216]}');
    expect(decodeURIComponent(seen[1]!)).toBe('https://apicarto.ign.fr/api/gpu/secteur-cc?geom={"type":"Point","coordinates":[5.0415,47.3216]}');
    expect(seen[2]).toBe('https://apicarto.ign.fr/api/gpu/municipality?insee=21231');
  });

  it('[R450] jamais deviné : limite de zone, autre commune, POS, date future ou mal formée, zone mal formée', async () => {
    const cases: unknown[][] = [
      [zone(), zone({ libelle: 'UB', libelong: 'Zone urbaine' })], // deux zones au même point
      [zone(), zone({ datappro: '20210101' })], // deux versions du document
      [zone({ idurba: '21054_PLU_20190101' })], // le PLU d'une autre commune
      [zone({ idurba: '21231_POS_19900101' })], // un POS n'est pas un document admis
      [zone({ idurba: '21231_PSMV_20000101' })],
      [zone({ idurba: '2123_PLUI_20200227' })], // un PLUi sans SIREN
      [zone({ datappro: '20270301' })], // approuvé après la collecte
      [zone({ datappro: '20190231' })], // un jour qui n'existe pas
      [zone({ datappro: null })],
      [zone({ libelle: '' })],
      [zone({ libelle: 'UA; DROP' })],
      [zone({ libelle: 'U'.repeat(21) })],
      [zone({ libelong: null, typezone: 'X' })], // ni libellé ni type connu
    ];
    for (const features of cases) expect(await collect({ zones: { features } })).toEqual({ ok: false, source: PUBLIC_SOURCES.urbanism, collectedAt: '2027-02-27T23:30:00.000Z', reason: 'introuvable' });
    // Aucune zone, et la commune n'est pas au RNU (ou c'est une autre commune) : introuvable.
    expect(await collect({ zones: { features: [] }, town: { features: [{ properties: { insee: '21231', is_rnu: false } }] } })).toMatchObject({ ok: false, reason: 'introuvable' });
    expect(await collect({ zones: { features: [] }, town: { features: [{ properties: { insee: '21054', is_rnu: true } }] } })).toMatchObject({ ok: false, reason: 'introuvable' });
    expect(await collect({ zones: { features: [] } })).toMatchObject({ ok: false, reason: 'introuvable' });
    // Un point ou une commune mal formés : rien ne part.
    const seen: string[] = [];
    for (const p of [{ ...POINT, lat: Number.NaN }, { ...POINT, lon: 200 }, { ...POINT, inseeCode: '21 rue' }]) {
      expect(await new GpuUrbanism(fetcherOf({ zones: { features: [zone()] } }, seen), { now: NOW }).collect(p)).toMatchObject({ ok: false, reason: 'introuvable' });
    }
    expect(seen).toEqual([]);
  });

  it('une commune au règlement national d’urbanisme : RNU, daté du jour de la collecte', async () => {
    expect(await collect({ zones: { features: [] }, town: { features: [{ properties: { insee: '21231', is_rnu: true } }] } })).toEqual({
      ok: true,
      source: PUBLIC_SOURCES.urbanism,
      collectedAt: '2027-02-27T23:30:00.000Z',
      dataDate: '2027-02-28',
      value: { documentType: 'RNU', zone: 'RNU', label: "Règlement national d'urbanisme" },
    });
  });

  it('[R12] erreur, réponse illisible ou trop lente : panne, jamais une erreur', async () => {
    expect(await collect({ status: 500, zones: {} })).toMatchObject({ ok: false, reason: 'panne' });
    expect(await collect({ zones: { message: 'quota' } })).toMatchObject({ ok: false, reason: 'panne' });
    const broken: Fetcher = async () => ({ ok: true, status: 200, json: async () => Promise.reject(new Error('JSON')) });
    expect(await new GpuUrbanism(broken, { now: NOW }).collect(POINT)).toMatchObject({ ok: false, reason: 'panne' });
    const thrown: Fetcher = async () => Promise.reject(new Error('réseau'));
    expect(await new GpuUrbanism(thrown, { now: NOW }).collect(POINT)).toMatchObject({ ok: false, reason: 'panne' });
    const slow: Fetcher = () => new Promise(() => {});
    expect(await new GpuUrbanism(slow, { now: NOW, timeoutMs: 20 }).collect(POINT)).toMatchObject({ ok: false, reason: 'panne' });
  });

  it('lit les dates et les documents sans rien deviner', () => {
    expect(approvalDay('20191216')).toBe('2019-12-16');
    expect(approvalDay('2019-12-16')).toBe('2019-12-16');
    expect(approvalDay('2019-02-29')).toBeNull();
    expect(approvalDay(20191216)).toBeNull();
    expect(documentOf('2A004_PLU_20180101')).toEqual({ documentType: 'PLU', owner: '2A004' });
    expect(documentOf('PLU_21231')).toBeNull();
  });
});

describeWithSqlite('RC43 · le fait collecté passe dans le résumé de HX35', () => {
  it('[R449] la zone lue au Géoportail entre telle quelle au résumé, avec sa date et son jour de lecture', async () => {
    const t = await setupDossier('appartement');
    const copro = new CoproprieteUrbanisme(t.db, t.acces, t.journal, { now: t.now });
    const urbanism = await new GpuUrbanism(fetcherOf({ zones: { features: [zone()] } }), { now: t.now }).collect(POINT);
    const rnu = await new GpuUrbanism(fetcherOf({ zones: { features: [] }, town: { features: [{ properties: { insee: '21231', is_rnu: true } }] } }), { now: t.now }).collect(POINT);
    const down = await new GpuUrbanism(fetcherOf({ status: 503, zones: {} }), { now: t.now }).collect(POINT);
    const day = new Date(t.now()).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' });
    const doc = { kind: 'fiche_synthetique' as const, ref: 'dossiers/test/fiche.pdf', pages: ['Fiche synthétique de la copropriété inventée.'] };

    const r = await copro.prepare(t.agent, t.fileId, { documents: [doc], sentences: [], publicData: { urbanism } });
    if (!r.ok) throw new Error(r.code);
    expect(r.value.urbanism).toMatchObject({ found: true, dataDate: '2019-12-16', value: { documentType: 'PLU', zone: 'UA' } });
    expect(renderSummary(r.value)).toContain(`Plan d'urbanisme : PLU, zone UA (Zone urbaine centrale) (Géoportail de l'urbanisme (IGN), donnée du 16/12/2019, lue le ${day}).`);

    const r2 = await copro.prepare(t.agent, t.fileId, { documents: [doc], sentences: [], publicData: { urbanism: rnu } });
    if (!r2.ok) throw new Error(r2.code);
    expect(r2.value.urbanism).toMatchObject({ found: true, value: { documentType: 'RNU' } });

    const r3 = await copro.prepare(t.agent, t.fileId, { documents: [doc], sentences: [], publicData: { urbanism: down } });
    if (!r3.ok) throw new Error(r3.code);
    expect(r3.value.urbanism).toMatchObject({ found: false, text: 'non trouvé', reason: 'panne' });
  });
});
