import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CollecteBien, PUBLIC_DATA_URLS, SOURCES, publicDataServices, type CollecteServices, type Fetcher } from '../src/index.ts';

// Réponses inventées, au format des services publics : aucune adresse réelle.
const ADDRESS = '1 rue de l’Essai 21000 Dijon';
const BAN = {
  type: 'FeatureCollection',
  features: [
    {
      geometry: { type: 'Point', coordinates: [5.0412, 47.3225] },
      properties: { label: '1 Rue de l’Essai 21000 Dijon', score: 0.93, postcode: '21000', citycode: '21231', city: 'Dijon', id: '21231_9999_00001', type: 'housenumber' },
    },
  ],
};
const CADASTRE = { type: 'FeatureCollection', features: [{ properties: { idu: '21231000AB0123', section: 'AB', numero: '0123', contenance: 412, code_insee: '21231' } }] };
const DPE = { total: 2, results: [{ etiquette_dpe: 'd', etiquette_ges: 'B', date_etablissement_dpe: '2024-03-12', numero_dpe: '2421E0000000X' }] };
const RISKS = {
  data: [
    {
      code_insee: '21231',
      risques_detail: [
        { num_risque: '13', libelle_risque_long: 'Mouvement de terrain' },
        { num_risque: '11', libelle_risque_long: 'Inondation' },
        { num_risque: '13', libelle_risque_long: 'Mouvement de terrain' },
      ],
    },
  ],
};

type Reply = { status: number; body?: unknown } | Error;

function fakeFetch(replies: Partial<Record<keyof typeof PUBLIC_DATA_URLS, Reply>>): Fetcher & { urls: string[] } {
  const urls: string[] = [];
  const fetcher: Fetcher = async (url) => {
    urls.push(url);
    const key = (Object.keys(PUBLIC_DATA_URLS) as (keyof typeof PUBLIC_DATA_URLS)[]).find((k) => url.startsWith(PUBLIC_DATA_URLS[k]));
    const reply = key ? replies[key] : undefined;
    if (!reply) return { ok: false, status: 404, json: async () => null };
    if (reply instanceof Error) throw reply;
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.body };
  };
  return Object.assign(fetcher, { urls });
}

const ALL_OK = { geocoder: { status: 200, body: BAN }, cadastre: { status: 200, body: CADASTRE }, energy: { status: 200, body: DPE }, risks: { status: 200, body: RISKS } };
const NOW = () => new Date('2026-10-27T09:00:00.000Z');
const collect = (services: CollecteServices) => new CollecteBien(services, { now: NOW });

describe('E03 · collecte des données publiques du bien', () => {
  it('retrouve adresse, parcelle, diagnostic et risques, chacun avec sa source et sa date', async () => {
    const facts = await collect(publicDataServices(fakeFetch(ALL_OK))).collect(ADDRESS);
    expect(facts.missing).toEqual([]);
    expect(facts.address).toEqual({
      ok: true,
      source: SOURCES.address,
      collectedAt: '2026-10-27T09:00:00.000Z',
      value: { label: '1 Rue de l’Essai 21000 Dijon', lat: 47.3225, lon: 5.0412, postalCode: '21000', inseeCode: '21231', town: 'Dijon', banId: '21231_9999_00001', score: 0.93 },
    });
    expect(facts.parcel).toMatchObject({ ok: true, source: SOURCES.parcel, value: { id: '21231000AB0123', section: 'AB', number: '0123', area: 412 } });
    expect(facts.energy).toMatchObject({ ok: true, source: SOURCES.energy, value: { energyClass: 'D', ghgClass: 'B', date: '2024-03-12' } });
    expect(facts.risks).toMatchObject({ ok: true, source: SOURCES.risks, value: [{ code: '13', label: 'Mouvement de terrain' }, { code: '11', label: 'Inondation' }] });
    for (const f of [facts.address, facts.parcel, facts.energy, facts.risks]) expect(f.collectedAt).toBe('2026-10-27T09:00:00.000Z');
  });

  it('une source en panne ne bloque pas les autres, et ce qui manque est dit', async () => {
    const facts = await collect(
      publicDataServices(fakeFetch({ ...ALL_OK, cadastre: new Error('délai'), energy: { status: 200, body: { total: 0, results: [] } }, risks: { status: 503 } })),
    ).collect(ADDRESS);
    expect(facts.address.ok).toBe(true);
    expect(facts.parcel).toMatchObject({ ok: false, reason: 'panne' });
    expect(facts.energy).toMatchObject({ ok: false, reason: 'introuvable' });
    expect(facts.risks).toMatchObject({ ok: false, reason: 'panne' });
    expect(facts.missing).toEqual(['parcel', 'energy', 'risks']);
  });

  it('sans adresse sûre, rien d’autre n’est cherché', async () => {
    const lost = fakeFetch({ ...ALL_OK, geocoder: { status: 200, body: { features: [] } } });
    const facts = await collect(publicDataServices(lost)).collect(ADDRESS);
    expect(facts.address).toMatchObject({ ok: false, reason: 'introuvable' });
    expect(facts.parcel).toMatchObject({ ok: false, reason: 'adresse_introuvable' });
    expect(facts.missing).toEqual(['address', 'parcel', 'energy', 'risks']);
    expect(lost.urls).toHaveLength(1);

    const unsure = fakeFetch({ ...ALL_OK, geocoder: { status: 200, body: { features: [{ ...BAN.features[0], properties: { ...BAN.features[0]!.properties, score: 0.3 } }] } } });
    expect((await collect(publicDataServices(unsure)).collect(ADDRESS)).address).toMatchObject({ ok: false, reason: 'adresse_incertaine' });
    expect(unsure.urls).toHaveLength(1);

    const empty = fakeFetch(ALL_OK);
    expect((await collect(publicDataServices(empty)).collect('   ')).address).toMatchObject({ ok: false, reason: 'introuvable' });
    expect(empty.urls).toHaveLength(0);
  });

  it('seule l’adresse du bien part vers les services publics', async () => {
    const f = fakeFetch(ALL_OK);
    await collect(publicDataServices(f)).collect(ADDRESS);
    expect(f.urls).toHaveLength(4);
    expect(decodeURIComponent(f.urls[0]!)).toContain(ADDRESS);
    // Les autres services ne reçoivent que des coordonnées ou l'identifiant de l'adresse, jamais le texte saisi.
    for (const url of f.urls.slice(1)) {
      expect(decodeURIComponent(url)).not.toContain('Essai');
      expect(url.startsWith('https://')).toBe(true);
    }
    expect(decodeURIComponent(f.urls.find((u) => u.startsWith(PUBLIC_DATA_URLS.energy))!)).toContain('identifiant_ban:"21231_9999_00001"');
  });

  it('une réponse mal formée vaut « introuvable », jamais une donnée inventée', async () => {
    const facts = await collect(
      publicDataServices(
        fakeFetch({
          ...ALL_OK,
          cadastre: { status: 200, body: { features: [{ properties: { section: 'AB' } }] } },
          energy: { status: 200, body: { results: [{ etiquette_dpe: 'Z', date_etablissement_dpe: '2024-03-12' }] } },
          risks: { status: 200, body: { data: 'non' } },
        }),
      ),
    ).collect(ADDRESS);
    expect(facts.missing).toEqual(['parcel', 'energy', 'risks']);
  });
});

// La vérification réelle sur 10 biens tests (critère de M04) se lance à la main, hors des tests automatiques :
// `AIMMO_BIENS=/chemin/hors/du/depot/biens.txt npx vitest run packages/core/test/collecte.test.ts`
// (une adresse par ligne). Elle interroge les vrais services publics et dit, par numéro de ligne, ce qui manque.
describe.runIf(process.env.AIMMO_BIENS)('E03 · vérification réelle sur biens tests', () => {
  it('toutes les données sont retrouvées pour chaque bien', { timeout: 120_000 }, async () => {
    const lines = readFileSync(process.env.AIMMO_BIENS!, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const real = new CollecteBien(publicDataServices((url, init) => fetch(url, init)));
    const gaps: string[] = [];
    for (const [i, line] of lines.entries()) {
      const facts = await real.collect(line);
      if (facts.missing.length > 0) gaps.push(`bien ${i + 1} : ${facts.missing.join(', ')}`);
    }
    console.log(`${lines.length - gaps.length} bien(s) sur ${lines.length} complets`, gaps);
    expect(gaps).toEqual([]);
  });
});
