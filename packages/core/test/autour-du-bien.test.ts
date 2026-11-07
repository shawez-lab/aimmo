import { describe, expect, it } from 'vitest';
import {
  AREA_RADIUS_M,
  areaOf,
  bucketMinutes,
  buyerTrips,
  checkSource,
  distanceM,
  publicSurroundings,
  renderSurroundings,
  streetCore,
  type PointOfInterest,
  type PrivateLocation,
  type Trip,
  type TripProvider,
} from '../src/recherche/autour-du-bien.ts';

// Bien, lieux, sources et acquéreur inventés.
const NOW = Date.parse('2027-03-09T09:00:00.000Z');

const BIEN: PrivateLocation = {
  lat: 47.32173,
  lon: 5.04189,
  number: '17 bis',
  street: 'Rue des Glycines Imaginaires',
  postalCode: '21000',
  commune: 'Dijon',
};

const OSM = { name: 'Carte collaborative (jeu inventé)', url: 'https://donnees.exemple.fr/lieux', date: '2027-01-15' };
const ANNUAIRE = { name: 'Annuaire des écoles (jeu inventé)', url: 'https://ecoles.exemple.fr/annuaire', date: '2026-09-01' };

function poi(id: string, category: PointOfInterest['category'], name: string, dLat: number, dLon: number, source = OSM): PointOfInterest {
  return { id, category, name, lat: BIEN.lat + dLat, lon: BIEN.lon + dLon, source };
}

const POIS: PointOfInterest[] = [
  poi('e1', 'ecole', 'École des Tilleuls Inventés', 0.002, 0.001, ANNUAIRE),
  poi('e2', 'ecole', 'École du Moulin Fictif', -0.004, 0.003, ANNUAIRE),
  poi('e3', 'ecole', 'École des Prés Rêvés', 0.006, -0.002, ANNUAIRE),
  poi('e4', 'ecole', 'École trop loin', 0.03, 0.03, ANNUAIRE),
  poi('c1', 'commerce_alimentaire', 'Épicerie des Glycines Imaginaires', 0.0004, 0.0003),
  poi('p1', 'pharmacie', 'Pharmacie du Pont Fictif', -0.001, 0.002),
  poi('t1', 'tram', 'Arrêt Campus Inventé', 0.003, 0.004),
  poi('s1', 'parc', 'Parc sans source', 0.001, 0.001, { name: 'Inconnue', url: 'http://pas-sur.exemple.fr', date: '2027-01-01' }),
  poi('s2', 'parc', 'Parc sans date', 0.001, 0.002, { name: 'Carte', url: 'https://donnees.exemple.fr', date: '' }),
  poi('s3', 'sport', 'Gymnase du futur', 0.001, 0.003, { ...OSM, date: '2027-12-01' }),
  poi('s4', 'sport', 'Gymnase périmé', 0.001, 0.003, { ...OSM, date: '2023-01-01' }),
  poi('s5', 'parc', 'Parc sans nom de source', 0.001, 0.003, { name: ' ', url: 'https://donnees.exemple.fr', date: '2027-01-01' }),
];

const RESEAU = { name: 'Horaires du réseau de bus et tram (jeu inventé)', url: 'https://reseau.exemple.fr/gtfs', date: '2027-02-01' };
const transitProvider: TripProvider = (from, to, mode) =>
  mode === 'transport' ? { mode, minutes: 3 + distanceM(from, to) / 300, kind: 'calcul', source: RESEAU } : null;

describe('HX29 · sources et dates de chaque lieu', () => {
  it('chaque point d\'intérêt montré cite sa source et sa date [R425]', () => {
    const { page } = publicSurroundings(BIEN, POIS, NOW, transitProvider);
    expect(page.points.length).toBeGreaterThan(0);
    for (const p of page.points) {
      expect(p.source.name.trim()).not.toBe('');
      expect(p.source.url.startsWith('https://')).toBe(true);
      expect(p.source.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      for (const t of p.trips) {
        expect(t.source.name.trim()).not.toBe('');
        expect(t.source.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
    const text = renderSurroundings(page);
    for (const p of page.points) {
      const [y, m, d] = p.source.date.split('-');
      expect(text).toContain(`${p.label}`);
      expect(text).toContain(`Source : ${p.source.name}, relevé du ${d}/${m}/${y}.`);
    }
    expect(page.sources.map((s) => s.name).sort()).toEqual([ANNUAIRE.name, OSM.name].sort());
  });

  it('une donnée sans source sûre, sans date, du futur ou trop vieille n\'est jamais montrée [R425]', () => {
    const { page, rejected } = publicSurroundings(BIEN, POIS, NOW);
    const shownNames = page.points.map((p) => p.name);
    for (const name of ['Parc sans source', 'Parc sans date', 'Gymnase du futur', 'Gymnase périmé', 'Parc sans nom de source']) {
      expect(shownNames).not.toContain(name);
    }
    expect(Object.fromEntries(rejected.map((r) => [r.id, r.reason]))).toEqual({
      s1: 'source',
      s2: 'date',
      s3: 'future',
      s4: 'perimee',
      s5: 'source',
    });
    expect(checkSource({ name: 'X', url: 'https://user:pw@exemple.fr/a', date: '2027-01-01' }, NOW)).toBe('source');
    expect(checkSource({ name: 'X', url: 'https://exemple.fr/a', date: '2027-02-30' }, NOW)).toBe('date');
    expect(checkSource({ name: 'X', url: 'https://exemple.fr/a', date: '2027-01-01' }, NOW)).toBeNull();
    expect(checkSource(null, NOW)).toBe('source');
  });

  it('au plus trois lieux de chaque sorte, à moins de 1,5 km, les plus proches d\'abord', () => {
    const { page } = publicSurroundings(BIEN, POIS, NOW);
    const ecoles = page.points.filter((p) => p.category === 'ecole').map((p) => p.name);
    expect(ecoles).toEqual(['École des Tilleuls Inventés', 'École du Moulin Fictif', 'École des Prés Rêvés']);
    expect(page.points.map((p) => p.name)).not.toContain('École trop loin');
  });

  it('une sorte de lieu inconnue ou une position impossible est écartée', () => {
    const bad = [
      { ...poi('x1', 'ecole', 'X', 0, 0), category: 'casino' as never },
      { ...poi('x2', 'ecole', 'Y', 0, 0), lat: Number.NaN },
    ];
    const { page, rejected } = publicSurroundings(BIEN, bad, NOW);
    expect(page.points).toEqual([]);
    expect(rejected).toEqual([
      { id: 'x1', reason: 'categorie' },
      { id: 'x2', reason: 'position' },
    ]);
    expect(renderSurroundings(page)).toContain('Aucun lieu relevé à moins de 1,5 km avec une source datée.');
  });
});

describe('HX29 · temps de trajet', () => {
  it('à pied, en transport et en voiture, chacun avec sa source et sa date ; l\'estimation est dite [R427]', () => {
    const { page } = publicSurroundings(BIEN, POIS, NOW, transitProvider);
    const tram = page.points.find((p) => p.category === 'tram')!;
    expect(tram.trips.map((t) => [t.mode, t.kind])).toEqual([
      ['pied', 'estimation'],
      ['transport', 'calcul'],
      ['voiture', 'estimation'],
    ]);
    expect(tram.trips[1]!.source).toEqual(RESEAU);
    expect(tram.trips[0]!.text).toMatch(/^moins de \d+ min à pied \(estimation\)$/);
    expect(tram.trips[1]!.text).toMatch(/^moins de \d+ min en transport$/);
    expect(tram.trips[0]!.source.date).toBe('2027-03-09');
    expect(renderSurroundings(page)).toContain("Les estimations sont calculées à vol d'oiseau, détour compté, le 09/03/2027.");
  });

  it('un temps en transport n\'est jamais estimé : sans calcul sourcé, il est dit « non calculé » [R427]', () => {
    const { page } = publicSurroundings(BIEN, POIS, NOW);
    for (const p of page.points) {
      expect(p.trips.map((t) => t.mode)).not.toContain('transport');
      expect(p.absent).toEqual([{ mode: 'transport', text: 'en transport : non calculé, horaires du réseau non relevés' }]);
    }
  });

  it('un calcul sans source sûre, absurde, d\'un autre mode ou en erreur cède la place à l\'estimation ou à « non calculé » [R427]', () => {
    const providers: TripProvider[] = [
      (_f, _t, mode) => ({ mode, minutes: 4, kind: 'calcul', source: { name: 'X', url: 'http://x.exemple.fr', date: '2027-01-01' } }),
      (_f, _t, mode) => ({ mode, minutes: -3, kind: 'calcul', source: RESEAU }),
      (_f, _t, mode) => ({ mode, minutes: Number.NaN, kind: 'calcul', source: RESEAU }),
      () => ({ mode: 'voiture', minutes: 4, kind: 'calcul', source: RESEAU }) as Trip,
      () => {
        throw new Error('service en panne');
      },
      (_f, _t, mode) => ({ mode, minutes: 4, kind: 'calcul', source: { ...RESEAU, date: '2020-01-01' } }),
    ];
    for (const provider of providers) {
      const { page } = publicSurroundings(BIEN, POIS.slice(0, 1), NOW, provider);
      const [p] = page.points;
      const transport = p!.trips.find((t) => t.mode === 'transport');
      if (transport) expect(transport.source).toEqual(RESEAU);
      expect(p!.trips.filter((t) => t.mode === 'pied').every((t) => t.kind === 'estimation')).toBe(true);
    }
  });

  it('les temps sont arrondis à 5 minutes au-dessus, jamais moins de 5 [R426]', () => {
    expect([0, 0.2, 4.9, 5, 5.1, 12, 59.9, 61].map(bucketMinutes)).toEqual([5, 5, 5, 5, 10, 15, 60, 65]);
    const { page } = publicSurroundings(BIEN, POIS, NOW, transitProvider);
    for (const t of page.points.flatMap((p) => p.trips)) expect(t.atMostMinutes % 5).toBe(0);
  });
});

describe('HX29 · jamais l\'adresse exacte', () => {
  const pages = [publicSurroundings(BIEN, POIS, NOW).page, publicSurroundings(BIEN, POIS, NOW, transitProvider).page];

  it('l\'adresse exacte n\'apparaît nulle part dans la page publique [R426]', () => {
    for (const page of pages) {
      for (const shown of [JSON.stringify(page), renderSurroundings(page)]) {
        const normalized = shown.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
        expect(normalized).not.toContain('glycines');
        expect(normalized).not.toContain('imaginaires');
        expect(shown).not.toContain('17 bis');
        expect(shown).not.toContain('21000');
        expect(shown).not.toContain(String(BIEN.lat));
        expect(shown).not.toContain(String(BIEN.lon));
        expect(shown).not.toContain('47.3217');
        expect(shown).not.toContain('5.0418');
        expect(shown).not.toMatch(/à \d+ ?m\b/);
      }
      expect(page.commune).toBe('Dijon');
    }
  });

  it('le nom d\'un lieu qui reprend la rue du bien est remplacé par sa sorte [R426]', () => {
    const [page] = pages;
    const epicerie = page!.points.find((p) => p.category === 'commerce_alimentaire')!;
    expect(epicerie.name).toBeNull();
    expect(epicerie.label).toBe('Commerce alimentaire');
    expect(renderSurroundings(page!)).toContain('Commerce alimentaire : ');
    expect(streetCore('Avenue de la Liberté Fictive')).toBe('liberte fictive');
    expect(streetCore("Allée de l'Orme")).toBe('orme');
  });

  it('la seule position publiée est le centre d\'une case d\'environ 500 m, pas le bien [R426]', () => {
    const area = areaOf(BIEN);
    expect(area).toEqual({ lat: 47.3225, lon: 5.0425, radiusM: AREA_RADIUS_M });
    expect(distanceM(area, BIEN)).toBeGreaterThan(50);
    expect(distanceM(area, BIEN)).toBeLessThan(AREA_RADIUS_M);
    // Deux biens de la même case donnent la même zone.
    expect(areaOf({ lat: 47.3201, lon: 5.0401 })).toEqual(area);
    expect(pages[0]!.area).toEqual(area);
  });

  it('aucune distance en mètres n\'est publiée', () => {
    for (const page of pages) {
      for (const p of page.points) {
        expect(Object.keys(p).sort()).toEqual(['absent', 'category', 'label', 'name', 'source', 'trips']);
        for (const t of p.trips) expect(Object.keys(t).sort()).toEqual(['atMostMinutes', 'kind', 'mode', 'source', 'text']);
      }
      expect(Object.keys(page).sort()).toEqual(['area', 'commune', 'points', 'sources']);
    }
  });

  it('une position du bien impossible arrête le calcul', () => {
    expect(() => publicSurroundings({ ...BIEN, lat: 120 }, POIS, NOW)).toThrow('Position du bien invalide.');
    expect(() => buyerTrips({ ...BIEN, lon: Number.NaN }, POIS, { destinations: [], categories: [] }, NOW)).toThrow('Position du bien invalide.');
  });
});

describe('HX29 · ce qui compte pour cet acquéreur (Jamais vu)', () => {
  const TRAVAIL = { label: 'Mon travail', lat: 47.3401, lon: 5.0702 };
  const ECOLE_LEA = { label: 'École de Léa', lat: 47.3150, lon: 5.0300 };

  it('les temps vers ses destinations, mode par mode, avec source et date [R427]', () => {
    const view = buyerTrips(BIEN, POIS, { destinations: [TRAVAIL, ECOLE_LEA], categories: [] }, NOW, transitProvider);
    expect(view.destinations.map((d) => d.label)).toEqual(['Mon travail', 'École de Léa']);
    for (const d of view.destinations) {
      expect(d.trips.map((t) => t.mode)).toEqual(['pied', 'transport', 'voiture']);
      for (const t of d.trips) expect(t.source.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    const car = view.destinations[0]!.trips.find((t) => t.mode === 'voiture')!;
    const walk = view.destinations[0]!.trips.find((t) => t.mode === 'pied')!;
    expect(car.atMostMinutes).toBeLessThan(walk.atMostMinutes);
  });

  it('le lieu le plus proche de chaque sorte choisie, et ce qui manque à moins de 1,5 km [R427]', () => {
    const view = buyerTrips(BIEN, POIS, { destinations: [], categories: ['ecole', 'pharmacie', 'gare', 'ecole'] }, NOW);
    expect(view.nearest.map((p) => [p.category, p.name])).toEqual([
      ['ecole', 'École des Tilleuls Inventés'],
      ['pharmacie', 'Pharmacie du Pont Fictif'],
    ]);
    expect(view.missingCategories).toEqual(['gare']);
  });

  it('ses destinations n\'entrent jamais dans la page publique, et sa vue ne dit pas l\'adresse [R428] [R426]', () => {
    const view = buyerTrips(BIEN, POIS, { destinations: [TRAVAIL], categories: ['commerce_alimentaire'] }, NOW);
    const { page } = publicSurroundings(BIEN, POIS, NOW);
    const pageText = JSON.stringify(page) + renderSurroundings(page);
    expect(pageText).not.toContain('Mon travail');
    expect(pageText).not.toContain(String(TRAVAIL.lat));
    const viewText = JSON.stringify(view).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    expect(viewText).not.toContain('glycines');
    expect(viewText).not.toContain('17 bis');
    expect(viewText).not.toContain(String(BIEN.lat));
    expect(viewText).not.toContain(String(TRAVAIL.lat));
  });

  it('une destination sans position valable est dite « non calculé », sans rien inventer', () => {
    const view = buyerTrips(BIEN, POIS, { destinations: [{ label: ' ', lat: Number.NaN, lon: 5 }], categories: [] }, NOW);
    expect(view.destinations).toEqual([
      {
        label: 'Destination',
        trips: [],
        absent: [
          { mode: 'pied', text: 'à pied : non calculé' },
          { mode: 'transport', text: 'en transport : non calculé, horaires du réseau non relevés' },
          { mode: 'voiture', text: 'en voiture : non calculé' },
        ],
      },
    ]);
  });
});
