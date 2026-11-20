import { describe, expect, it } from 'vitest';
import {
  Acces,
  ControlesSignature,
  FicheClient,
  FicheUnique,
  Modeles,
  RegistreMandats,
  SignaturePapier,
  SqlJournalStore,
  applyMigrations,
  fromSyncSqlite,
  type SqlDatabase,
  type Viewer,
} from '../src/index.ts';
import { Annonces, FACT_KEYS, FicheBien, MentionsAnnonce, bindingHolds, fallbackListing, traceListing, traceSentence, type ListingFacts, type ListingWriter } from '../src/annonces/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';
import { identiteAuCoffre } from './identite-coffre.ts';
import { designerTout } from './designation-jeu.ts';
import { rangerStatut } from './statut-agent-jeu.ts';

// Biens et textes inventés.
const FACTS: ListingFacts = {
  kind: 'home',
  city: 'Dijon',
  postalCode: '21000',
  surfaceM2: 62,
  rooms: 3,
  bedrooms: 2,
  floor: 3,
  floorsTotal: 5,
  buildYear: 1965,
  heating: 'collectif',
  outdoor: ['balcon'],
  landM2: null,
  parkingSpaces: 1,
  elevator: true,
  energyClass: 'D',
  climateClass: 'C',
};

const codes = (s: string, f: ListingFacts = FACTS) => traceSentence(s, f).problems.map((p) => `${p.code}:${p.value}`);

describe('P03 · annonce sourcée, phrase par phrase', () => {
  it('[R47] chaque nombre et chaque fait d’une phrase vraie est relié à son champ', () => {
    const s = traceSentence('Appartement de 62 m² à Dijon, 3 pièces dont 2 chambres, au 3e étage sur 5 avec ascenseur et balcon.', FACTS);
    expect(s.problems).toEqual([]);
    expect(s.sources.map((x) => x.field).sort()).toEqual(['bedrooms', 'city', 'elevator', 'floor', 'floorsTotal', 'outdoor', 'rooms', 'surfaceM2'].sort());
    expect(traceSentence('Construit en 1965, classe énergie D, chauffage collectif, une place de parking.', FACTS).problems).toEqual([]);
    expect(traceSentence('Trois pièces lumineuses, deux chambres.', FACTS).problems).toEqual([]);
  });

  it('[R47] un nombre absent de la fiche est refusé, la phrase en cause nommée', () => {
    expect(codes('Appartement de 75 m².')).toEqual(['nombre_sans_source:75']);
    expect(codes('Quatre chambres.')).toEqual(['nombre_sans_source:quatre']);
    expect(codes('Construit en 1972.')).toEqual(['nombre_sans_source:1972']);
    expect(codes('Belle surface de 62,5 m².')).toEqual(['nombre_sans_source:62,5']);
    // Le prix n'est jamais dans le texte : seules les mentions du code le portent.
    expect(codes('Prix : 210 000 €.')).toEqual(['nombre_sans_source:210 000']);
    const r = traceListing('Appartement 3 pièces à Dijon', 'Beau séjour. Cuisine de 15 m². Deux chambres.', FACTS);
    expect(r.ok).toBe(false);
    expect(r.sentences.filter((x) => x.problems.length > 0).map((x) => x.text)).toEqual(['Cuisine de 15 m².']);
  });

  it('[R47] un fait sans source dans la fiche est refusé : équipement absent, classe fausse, état non prouvé', () => {
    expect(codes('Avec jardin.')).toEqual(['fait_sans_source:jardin']);
    expect(codes('Avec piscine et cave.')).toEqual(['fait_sans_source:piscine', 'fait_sans_source:cave']);
    expect(codes('Entièrement rénové.')).toEqual(['fait_sans_source:rénové']);
    expect(codes('Classe énergie B.')).toEqual(['fait_sans_source:classe energie b']);
    expect(codes('Sans ascenseur.')).toEqual(['fait_sans_source:sans ascenseur']);
    expect(codes('Chauffage au gaz.')).toEqual(['fait_sans_source:chauffage au gaz']);
    expect(codes('Au rez-de-chaussée.')).toEqual(['fait_sans_source:rez-de-chaussée']);
    expect(codes('Sans ascenseur.', { ...FACTS, elevator: false })).toEqual([]);
  });

  it('[R47] AU061 · piscine, cave, cheminée et état du bien se disent quand la fiche les porte, et alors seulement', () => {
    const rich: ListingFacts = { ...FACTS, amenities: ['piscine', 'cave', 'cheminee'], condition: 'travaux_a_prevoir' };
    const text = fallbackListing(rich);
    expect(text.body).toContain('Piscine, cave et cheminée.');
    expect(text.body).toContain('Travaux à prévoir.');
    const r = traceListing(text.title, text.body, rich);
    expect(r.ok).toBe(true);
    expect(r.sentences.flatMap((s) => s.sources).filter((s) => s.field === 'amenities' || s.field === 'condition').map((s) => `${String(s.field)}:${s.value}`).sort()).toEqual(['amenities:cave', 'amenities:cheminée', 'amenities:piscine', 'condition:travaux à prévoir']);
    // Sans la fiche, aucun de ces mots n'a de source.
    expect(traceListing('Appartement à Dijon', 'Avec piscine.', FACTS).ok).toBe(false);
    expect(traceListing('Appartement à Dijon', 'Refait à neuf.', { ...FACTS, condition: 'travaux_a_prevoir' }).ok).toBe(false);
    expect(traceListing('Appartement à Dijon', 'Refait à neuf.', { ...FACTS, condition: 'refait_a_neuf' }).ok).toBe(true);
    expect(traceListing('Appartement à Dijon', 'Logement neuf.', { ...FACTS, condition: 'refait_a_neuf' }).ok).toBe(false);
    // Une négation ne passe pas pour l'état dit : « sans travaux » est faux pour un bien à rénover.
    for (const condition of ['a_renover', 'travaux_a_prevoir'] as const) {
      for (const body of ['Sans travaux.', 'Aucun travaux à prévoir.', 'Pas de travaux.']) expect(traceListing('Appartement à Dijon', body, { ...FACTS, condition }).ok).toBe(false);
    }
    expect(traceListing('Appartement à Dijon', 'Sans travaux.', { ...FACTS, condition: 'bon_etat' }).ok).toBe(true);
    expect(traceListing('Appartement à Dijon', 'Sans travaux.', FACTS).ok).toBe(false);
    // L'absence d'un équipement ne se prouve pas : « sans piscine » est refusé, même quand la fiche dit une piscine.
    for (const body of ['Sans piscine.', 'Pas de cave.', 'Sans cheminée ni cave.']) {
      expect(traceListing('Appartement à Dijon', body, { ...FACTS, amenities: ['piscine', 'cave', 'cheminee'] }).ok).toBe(false);
      expect(traceListing('Appartement à Dijon', body, FACTS).ok).toBe(false);
    }
    // Un état nié ne se prouve pas non plus : « non rénové » est refusé, même sur une fiche « refait à neuf ».
    for (const body of ['Non rénové.', 'Jamais refait.', 'Pas en bon état.', 'Cuisine pas encore refaite.', 'Pas neuf.']) {
      for (const condition of ['refait_a_neuf', 'bon_etat', 'neuf', 'a_renover'] as const) {
        expect(traceListing('Logement à Dijon', body, { ...FACTS, condition }).ok).toBe(false);
      }
    }
    expect(traceListing('Logement à Dijon', 'Rénové.', { ...FACTS, condition: 'refait_a_neuf' }).ok).toBe(true);
  });

  it('[R47] AU066 · une source rangée reste vraie si son champ dit encore la même chose, même quand un autre champ devient égal', () => {
    // « 5 étages » relié au nombre d'étages : l'étage du bien corrigé de 3 à 5 ne le rend pas faux.
    expect(bindingHolds({ field: 'floorsTotal', value: '5' }, { ...FACTS, floor: 5, floorsTotal: 5 })).toBe(true);
    // « 3e étage » relié à l'étage : l'étage corrigé à 2 le rend faux, même si l'immeuble a 3 étages.
    expect(bindingHolds({ field: 'floor', value: '3' }, { ...FACTS, floor: 2, floorsTotal: 3 })).toBe(false);
    expect(bindingHolds({ field: 'outdoor', value: 'balcon' }, { ...FACTS, outdoor: ['balcon'] })).toBe(true);
    expect(bindingHolds({ field: 'outdoor', value: 'balcon' }, { ...FACTS, outdoor: [] })).toBe(false);
    expect(bindingHolds({ field: 'city', value: 'Dijon' }, FACTS)).toBe(true);
    expect(bindingHolds({ field: 'energyClass', value: 'D' }, { ...FACTS, energyClass: 'E' })).toBe(false);
    // Un nombre en lettres se relit comme le contrôle le lit.
    expect(bindingHolds({ field: 'rooms', value: 'Trois' }, { ...FACTS, rooms: 3 })).toBe(true);
    expect(bindingHolds({ field: 'rooms', value: 'trois' }, { ...FACTS, rooms: 4 })).toBe(false);
    expect(bindingHolds({ field: 'rooms', value: 'beaucoup' }, { ...FACTS, rooms: 3 })).toBe(false);
  });

  it('[R47] AU063 · une surface dite Carrez ou utile doit être celle de la fiche, jamais une autre de même valeur', () => {
    const f: ListingFacts = { ...FACTS, carrezM2: 61.35, usableM2: null };
    expect(traceListing('Logement à Dijon', 'Surface Carrez de 61,35 m².', f).ok).toBe(true);
    // La surface habitable n'est pas la Carrez : 61,35 m² habitables est faux, et une Carrez égale à l'habitable aussi.
    expect(traceListing('Logement à Dijon', '61,35 m² habitables.', f).ok).toBe(false);
    expect(traceListing('Logement à Dijon', `Surface Carrez de ${String(FACTS.surfaceM2).replace('.', ',')} m².`, f).ok).toBe(false);
    expect(traceListing('Logement à Dijon', 'Surface utile de 61,35 m².', f).ok).toBe(false);
    // Deux surfaces dans une phrase : chacune la sienne.
    expect(traceListing('Logement à Dijon', `Logement de ${String(FACTS.surfaceM2).replace('.', ',')} m², surface Carrez de 61,35 m².`, f).ok).toBe(true);
    // Chaque mesure a son qualificatif : celui d'une autre mesure de la phrase ne déteint pas.
    const g: ListingFacts = { ...FACTS, surfaceM2: 62, carrezM2: 60, usableM2: null };
    expect(traceListing('Logement à Dijon', 'Surface Carrez de 60 m² et 60 m² habitables.', g).ok).toBe(false);
    expect(traceListing('Logement à Dijon', 'Surface Carrez de 60 m² et 62 m² habitables.', g).ok).toBe(true);
    // Le texte de secours suit la règle de l'annonce : un logement dit l'habitable puis la Carrez, jamais l'utile.
    const text = fallbackListing({ ...f, usableM2: 70 });
    expect(text.body).toContain('Surface Carrez de 61,35 m².');
    expect(text.body).not.toContain('utile');
    expect(traceListing(text.title, text.body, { ...f, usableM2: 70 }).ok).toBe(true);
    // Un local s'annonce d'abord par sa surface utile, au titre comme au texte.
    const local: ListingFacts = { ...FACTS, kind: 'commercial', surfaceM2: 90, usableM2: 82, carrezM2: null };
    const shop = fallbackListing(local);
    expect(shop.title).toContain('82 m² utiles');
    expect(shop.body.startsWith('Local de 82 m² utiles')).toBe(true);
    expect(shop.body).toContain('Surface habitable de 90 m².');
    expect(traceListing(shop.title, shop.body, local).ok).toBe(true);
  });

  it('[R46] une adresse exacte ou une voie nommée est refusée', () => {
    expect(codes('Situé 12 rue des Essais.')).toContain('adresse:12 rue');
    expect(codes('Situé rue des Essais.')).toEqual(['adresse:rue des Essais.']);
    expect(codes('Proche de la place Darcy.').some((c) => c.startsWith('adresse:'))).toBe(true);
    expect(codes("Boulevard de l'Essai, au calme.").some((c) => c.startsWith('adresse:'))).toBe(true);
    expect(codes('Une place de parking.')).toEqual([]);
    expect(codes('Belle avenue arborée.').some((c) => c.startsWith('adresse:'))).toBe(false);
  });

  it('[R46] un critère discriminant est refusé, liste fermée', () => {
    expect(codes('Idéal pour une famille.')).toEqual(['critere_discriminant:ideal pour', 'critere_discriminant:famille']);
    expect(codes('Pas d’enfants, couple uniquement.')).toEqual(["critere_discriminant:pas d'enfants", 'critere_discriminant:couple']);
    expect(codes('Réservé à un retraité.')).toEqual(['critere_discriminant:reserve a', 'critere_discriminant:retraite']);
    expect(codes('Nationalité française exigée.')).toEqual(['critere_discriminant:nationalite', 'critere_discriminant:francaise']);
    expect(codes('Au 3e étage.')).toEqual([]);
  });

  it('« gratuit », « mandataire » et toute mention de l’IA sont refusés', () => {
    expect(codes('Estimation gratuite.')).toEqual(['mot_interdit:gratuite']);
    expect(codes('Votre mandataire vous accueille.')).toEqual(['mot_interdit:mandataire']);
    expect(codes('Texte rédigé par une IA.')).toEqual(['mot_interdit:ia']);
    expect(codes('Description générée automatiquement.')).toEqual(['mot_interdit:generee', 'mot_interdit:automatiquement']);
  });

  it('[R47] un nombre doit venir du champ que son unité désigne ; composés, romains et chiffres non latins n’ont pas de source', () => {
    const f: ListingFacts = { ...FACTS, surfaceM2: 65, floor: 1, floorsTotal: 4, buildYear: 1970 };
    expect(codes('Appartement de 3 chambres.', f)).toEqual(['nombre_sans_source:3']);
    expect(codes('Au 3e étage.', f)).toEqual(['nombre_sans_source:3']);
    expect(codes('Au 1er étage sur 4.', f)).toEqual([]);
    expect(codes('Trois chambres.', f)).toEqual(['nombre_sans_source:trois']);
    expect(codes('Quatre-vingts mètres carrés.', f)).toEqual(['nombre_sans_source:quatre-vingts']);
    expect(codes('À deux cents mètres du centre.', f)).toEqual(['nombre_sans_source:deux cents']);
    expect(codes('Immeuble du XIXe siècle.', f)).toEqual(['nombre_sans_source:XIXe']);
    expect(codes('Surface de ١٢٠ m².', f)).toEqual(['nombre_sans_source:١٢٠']);
    expect(codes('Bâti il y a 3 ans.', f)).toEqual(['nombre_sans_source:3']);
    expect(codes('Construit en 1970.', f)).toEqual([]);
    expect(codes('Résidence de 3 étages.', f).length).toBeGreaterThan(0);
  });

  it('[R47] une classe énergie inventée est refusée, quelle que soit son écriture', () => {
    expect(codes('Classe énergie : B.')).toEqual(['fait_sans_source:classe energie : b']);
    expect(codes('DPE B.')).toEqual(['fait_sans_source:dpe b']);
    expect(codes('Étiquette énergie A.')).toEqual(['fait_sans_source:etiquette energie a']);
    expect(codes('Classé D au DPE, GES C.')).toEqual([]);
  });

  it('[R46] un point d’abréviation ne coupe pas une adresse en deux phrases', () => {
    const r = traceListing('Appartement à Dijon', 'Au 12 av. des Essais. Au 3e étage.', FACTS);
    expect(r.ok).toBe(false);
    expect(r.sentences.map((s) => s.text)).toEqual(['Appartement à Dijon', 'Au 12 av. des Essais.', 'Au 3e étage.']);
    expect(r.sentences[1]!.problems.some((p) => p.code === 'adresse')).toBe(true);
    expect(traceListing('Appartement à Dijon', 'Proche du bd. Essai.', FACTS).ok).toBe(false);
    expect(traceListing('Appartement à Dijon', 'Écrit par une I.A. Au 3e étage.', FACTS).ok).toBe(false);
  });

  it('[R46] critères discriminants lus au pluriel, au féminin, sans accents ; « réservé aux »', () => {
    expect(codes('Réservé aux Français.')).toEqual(['critere_discriminant:reserve aux', 'critere_discriminant:francais']);
    expect(codes('Voisins musulmans.')).toEqual(['critere_discriminant:musulmans']);
    expect(codes("Pas d'etrangers.")).toEqual(['critere_discriminant:etrangers']);
    expect(codes('Ideal pour handicape.')).toEqual(['critere_discriminant:ideal pour', 'critere_discriminant:handicape']);
  });

  it('un retour à la ligne ne coupe pas un terme ; « I.A. » et « gratuits » sont refusés', () => {
    const r = traceListing('Appartement à Dijon', 'Logement sans\nenfants.', FACTS);
    expect(r.ok).toBe(false);
    expect(traceListing('Appartement à Dijon', 'Chauffage\nau gaz.', FACTS).ok).toBe(false);
    expect(traceListing('Appartement à Dijon', 'Écrit par une\nintelligence\nartificielle.', FACTS).ok).toBe(false);
    expect(codes('Texte rédigé par une I.A. au calme.')).toEqual(['mot_interdit:ia']);
    expect(codes('Honoraires gratuits.')).toEqual(['mot_interdit:gratuits']);
  });

  it('le texte de secours fait par le code passe toujours le contrôle, pour des biens variés', () => {
    const variants: ListingFacts[] = [
      FACTS,
      { ...FACTS, floor: 0, floorsTotal: 2, elevator: null, outdoor: ['jardin', 'terrasse', 'cour'], heating: 'pompe_a_chaleur', bedrooms: 1, rooms: 1 },
      { ...FACTS, kind: 'land', rooms: null, bedrooms: null, floor: null, floorsTotal: null, buildYear: null, heating: null, outdoor: [], surfaceM2: 850, landM2: 850, parkingSpaces: null, elevator: null, energyClass: null, climateClass: null },
      { ...FACTS, city: null, surfaceM2: null, heating: 'fioul', parkingSpaces: 2, landM2: 400 },
      { ...FACTS, kind: 'building', heating: 'autre', floor: null, buildYear: 1900, energyClass: 'G', climateClass: 'G' },
    ];
    for (const f of variants) {
      const t = fallbackListing(f);
      const r = traceListing(t.title, t.body, f);
      expect(r.sentences.flatMap((s) => s.problems), `${t.title} / ${t.body}`).toEqual([]);
      expect(r.ok).toBe(true);
    }
    expect(fallbackListing(FACTS)).toEqual({
      title: 'Logement, 3 pièces, 62 m², Dijon',
      body: 'Logement de 62 m² à Dijon, 3 pièces dont 2 chambres. Au 3e étage sur 5, avec ascenseur. Construit en 1965. Balcon. 1 place de stationnement. Chauffage collectif. Classe énergie D.',
    });
  });
});

// Le parcours en base : brouillon, correction, validation.
const MANDATE = 'Mandat de test : {{mandant.nom}}, {{bien.prix}}, {{honoraires.montant}} {{honoraires.charge}}, {{mandat.duree_mois}}.\n\nNuméro : {{registre.numero}} · {{bien.adresse}} · {{bien.cadastre}} · {{mandant.domicile}}.';
const SHEET = (pid: string) => ({
  characteristics: { bedrooms: 2, floor: 3, floorsTotal: 5, buildYear: 1965, heating: 'collectif', outdoor: ['balcon'], parkingSpaces: 1, elevator: true },
  energy: { energyClass: 'D', climateClass: 'C', annualCostMinEur: 1100, annualCostMaxEur: 1550, costReferenceYear: 2023, diagnosedOn: '2027-01-15' },
  coownership: { isCoownership: true, lots: 24, annualChargesEur: 1800, proceedings: false },
  risks: { inRiskZone: false },
  media: [{ ref: `biens/${pid}/0b6f1d2e-1111-4a2b-8c3d-000000000001.jpg`, kind: 'photo', edit: 'aucune' }],
});

async function setup(writer?: ListingWriter, options: { timeoutMs?: number } = {}) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = new Date('2027-02-10T10:00:00.000Z');
  const now = () => clock;
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const acces = new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now });
  const modeles = new Modeles(db, acces, journal, { now });
  const controles = new ControlesSignature(db, acces, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const as = (role: string, userId: string): Viewer => ({ role, userId, networkId: network.id }) as Viewer;
  const agent = as('agent', alex.id);
  const direction = as('direction', 'direction-1');
  const v = await modeles.createVersion(direction, 'mandat_vente_simple', MANDATE);
  if (!v.ok) throw new Error(v.code);
  await modeles.validate(as('compliance', 'c-1'), v.template.id);
  await controles.setFeeSchedule(direction, { maxRatePercent: 6, minEur: 0 });
  await new RegistreMandats(db, journal, { now }).configure(direction, { prefix: 'T-', firstNumber: 1, width: 3 });
  // Le statut des agents, rangé par la direction (AU007) [R152].
  await rangerStatut(db, journal, now, direction, [alex.id, sam.id]);
  const p = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Léa', lastName: 'Exemple' });
  const b = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'REF-T-1', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 62, rooms: 3, priceEur: 200000 });
  const project = await store.createProject({ networkId: network.id, agentId: alex.id, personId: p.id, kind: 'sell' });
  await store.linkProjectProperty({ networkId: network.id, agentId: alex.id, projectId: project.id, propertyId: b.id, role: 'owned' });
  await identiteAuCoffre({ db, acces, journal, now }, agent, p.id, { piece: 'carte_identite', seenAt: new Date('2027-02-10T09:00:00.000Z') });
  const fiches = new FicheBien(db, acces, journal, { now });
  await fiches.save(agent, b.id, SHEET(b.id));
  const mentions = new MentionsAnnonce(db, acces, journal, { now });
  const signMandate = async () => {
    await designerTout(db);
    const d = await modeles.generate(agent, { kind: 'mandat_vente_simple', personId: p.id, propertyId: b.id, inputs: { 'honoraires.montant': 10000, 'honoraires.charge': 'acquereur', 'mandat.duree_mois': 12 } });
    if (!d.ok) throw new Error(d.code);
    const s = await new SignaturePapier(db, acces, journal, { now }).register(agent, d.document.id, { signedAt: new Date('2027-02-10T09:00:00.000Z'), place: 'agence', scanRef: 'scans/mandat.pdf', source: 'referral' });
    if (!s.ok) throw new Error(s.code);
  };
  const annonces = new Annonces(db, acces, journal, { now, ...(writer ? { writer } : {}), ...options });
  return { db, journal, annonces, fiches, mentions, signMandate, network, agent, direction, compliance: as('compliance', 'c-1'), sam: as('agent', sam.id), propertyId: b.id, setClock: (d: Date) => (clock = d) };
}

const fakeWriter = (out: { title: string; body: string } | (() => Promise<never>)): ListingWriter & { seen: ListingFacts[] } => {
  const seen: ListingFacts[] = [];
  return {
    seen,
    async write(facts) {
      seen.push(facts);
      if (typeof out === 'function') return out();
      return out;
    },
  };
};

describeWithSqlite('P03 · brouillon, correction, validation', () => {
  it('[R15] l’IA ne reçoit que les faits contrôlés du bien : ni nom, ni coordonnée, ni adresse', async () => {
    const w = fakeWriter({ title: 'Appartement 3 pièces à Dijon', body: 'Au 3e étage avec ascenseur et balcon. Deux chambres.' });
    const t = await setup(w);
    const r = await t.annonces.propose(t.agent, t.propertyId);
    expect(r).toMatchObject({ ok: true, value: { origin: 'ia', seq: 1, validated: null }, aiRefused: null });
    expect(w.seen).toHaveLength(1);
    expect(Object.keys(w.seen[0]!).sort()).toEqual([...FACT_KEYS].sort());
    expect(JSON.stringify(w.seen[0])).not.toMatch(/Léa|Exemple|REF-T-1|biens\//);
  });

  it('[R47] un texte de l’IA qui invente est refusé : le texte de secours le remplace, les phrases en cause sont rendues', async () => {
    const t = await setup(fakeWriter({ title: 'Appartement 3 pièces', body: 'Superbe terrasse de 20 m². Au 3e étage.' }));
    const r = await t.annonces.propose(t.agent, t.propertyId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.origin).toBe('secours');
    expect(r.aiRefused?.map((s) => s.text)).toEqual(['Superbe terrasse de 20 m².']);
    expect(r.aiRefused?.[0]?.problems).toEqual([{ code: 'nombre_sans_source', value: '20' }, { code: 'fait_sans_source', value: 'terrasse' }]);
    const logged = (await t.journal.bySubject(`property:${t.propertyId}`)).find((e) => e.type === 'annonce.ia_refusee');
    expect(logged?.data).toEqual({ rule: 'R47', codes: ['nombre_sans_source', 'fait_sans_source'] });
    expect(JSON.stringify(logged)).not.toContain('terrasse');
  });

  it('une IA en panne, trop lente ou absente laisse le texte de secours fait par le code', async () => {
    const broken = await setup(fakeWriter(() => Promise.reject(new Error('panne'))));
    expect(await broken.annonces.propose(broken.agent, broken.propertyId)).toMatchObject({ ok: true, value: { origin: 'secours' }, aiRefused: null });
    const slow = await setup({ write: () => new Promise(() => {}) }, { timeoutMs: 20 });
    expect(await slow.annonces.propose(slow.agent, slow.propertyId)).toMatchObject({ ok: true, value: { origin: 'secours' } });
    const none = await setup();
    const r = await none.annonces.propose(none.agent, none.propertyId);
    expect(r.ok && r.value.body).toBe('Logement de 62 m² à Dijon, 3 pièces dont 2 chambres. Au 3e étage sur 5, avec ascenseur. Construit en 1965. Balcon. 1 place de stationnement. Chauffage collectif. Classe énergie D.');
  });

  it('[R46] [R47] la correction de l’agent est contrôlée de la même façon', async () => {
    const t = await setup();
    const bad = await t.annonces.correct(t.agent, t.propertyId, { title: 'Appartement à Dijon', body: 'Situé 4 rue des Essais. Idéal pour une famille.' });
    expect(bad).toMatchObject({ ok: false, rule: 'R46', code: 'refused_text' });
    const invented = await t.annonces.correct(t.agent, t.propertyId, { title: 'Appartement à Dijon', body: 'Avec piscine.' });
    expect(invented).toMatchObject({ ok: false, rule: 'R47', code: 'refused_text', sentences: [{ text: 'Avec piscine.' }] });
    expect(await t.annonces.correct(t.agent, t.propertyId, { title: '', body: 'x' })).toEqual({ ok: false, rule: null, code: 'bad_text' });
    expect(await t.annonces.read(t.agent, t.propertyId)).toEqual({ ok: false, rule: null, code: 'no_draft' });
    const good = await t.annonces.correct(t.agent, t.propertyId, { title: 'Appartement 3 pièces à Dijon', body: 'Au 3e étage sur 5 avec ascenseur. Balcon et deux chambres.' });
    expect(good).toMatchObject({ ok: true, value: { origin: 'agent', seq: 1 } });
  });

  it('[R47] AU066 · un nombre écrit en lettres dans l’annonce validée reste vrai après une nouvelle version de la fiche qui ne le touche pas', async () => {
    const t = await setup();
    await t.mentions.setCardNumber(t.direction, 'CPI 2101 2027 000 000 001');
    await t.signMandate();
    const d = await t.annonces.correct(t.agent, t.propertyId, { title: 'Trois pièces à Dijon', body: 'Au 3e étage avec ascenseur.' });
    if (!d.ok) throw new Error(d.code);
    expect((await t.annonces.validate(t.agent, d.value.id)).ok).toBe(true);
    await t.fiches.save(t.agent, t.propertyId, { ...SHEET(t.propertyId), risks: { inRiskZone: true } });
    expect((await t.annonces.publishable(t.network.id, t.propertyId))?.id).toBe(d.value.id);
  });

  it('[R47] rien n’est publiable sans la validation de l’agent du bien ; seul le dernier brouillon, sur la dernière fiche, se valide', async () => {
    const t = await setup();
    await t.mentions.setCardNumber(t.direction, 'CPI 2101 2027 000 000 001');
    await t.signMandate();
    const d1 = await t.annonces.propose(t.agent, t.propertyId);
    if (!d1.ok) throw new Error(d1.code);
    expect(await t.annonces.publishable(t.network.id, t.propertyId)).toBeNull();
    // La direction écrit, mais ne valide pas ; un autre agent non plus.
    expect(await t.annonces.validate(t.direction, d1.value.id)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.annonces.validate(t.sam, d1.value.id)).toMatchObject({ ok: false, rule: 'R16' });
    // Un nouveau brouillon rend le précédent invalidable.
    const d2 = await t.annonces.correct(t.direction, t.propertyId, { title: 'Appartement 3 pièces à Dijon', body: 'Au 3e étage avec ascenseur.' });
    if (!d2.ok) throw new Error(d2.code);
    expect(await t.annonces.validate(t.agent, d1.value.id)).toEqual({ ok: false, rule: 'R47', code: 'not_latest_draft' });
    const v = await t.annonces.validate(t.agent, d2.value.id);
    expect(v).toMatchObject({ ok: true, value: { seq: 2, validated: { by: `agent:${t.agent.userId}` } } });
    expect(await t.annonces.validate(t.agent, d2.value.id)).toEqual({ ok: false, rule: 'R47', code: 'already_validated' });
    expect((await t.annonces.publishable(t.network.id, t.propertyId))?.id).toBe(d2.value.id);
    expect(await t.annonces.publishable('autre-reseau', t.propertyId)).toBeNull();
    // Une nouvelle version de la fiche qui ne rend aucune phrase fausse : la version validée reste publiable (AU066).
    await t.fiches.save(t.agent, t.propertyId, { ...SHEET(t.propertyId), risks: { inRiskZone: true } });
    expect((await t.annonces.publishable(t.network.id, t.propertyId))?.id).toBe(d2.value.id);
    // Un étage corrigé que le nombre d'étages de l'immeuble « explique » encore : la phrase est fausse, retirée.
    const sheet = SHEET(t.propertyId) as { characteristics: Record<string, unknown> };
    await t.fiches.save(t.agent, t.propertyId, { ...SHEET(t.propertyId), characteristics: { ...sheet.characteristics, floor: 2, floorsTotal: 3 } });
    expect(await t.annonces.publishable(t.network.id, t.propertyId)).toBeNull();
    await t.fiches.save(t.agent, t.propertyId, { ...SHEET(t.propertyId), risks: { inRiskZone: true } });
    expect((await t.annonces.publishable(t.network.id, t.propertyId))?.id).toBe(d2.value.id);
    // Une correction en cours, pas encore validée, ne la retire pas non plus.
    const draft = await t.annonces.correct(t.agent, t.propertyId, { title: 'Appartement 3 pièces à Dijon', body: 'Au 3e étage, avec ascenseur.' });
    expect(draft.ok).toBe(true);
    expect((await t.annonces.publishable(t.network.id, t.propertyId))?.id).toBe(d2.value.id);
    const d3 = await t.annonces.propose(t.agent, t.propertyId);
    if (!d3.ok) throw new Error(d3.code);
    await t.fiches.save(t.agent, t.propertyId, SHEET(t.propertyId));
    expect(await t.annonces.validate(t.agent, d3.value.id)).toEqual({ ok: false, rule: 'R47', code: 'stale_sheet' });
    // Un changement de la fiche de base qui rend un nombre faux : plus publiable.
    const d4 = await t.annonces.propose(t.agent, t.propertyId);
    if (!d4.ok) throw new Error(d4.code);
    expect(await t.annonces.validate(t.agent, d4.value.id)).toMatchObject({ ok: true });
    await t.db.run('UPDATE properties SET surface_m2 = 60 WHERE id = ?', [t.propertyId]);
    expect(await t.annonces.publishable(t.network.id, t.propertyId)).toBeNull();
    await expect(t.db.run('DELETE FROM listing_validations')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run("UPDATE listing_drafts SET body = 'x'")).rejects.toThrow(/ne change plus/);
  });

  it('[R43] la validation exige une liste de contrôle des mentions complète', async () => {
    const t = await setup();
    const d = await t.annonces.propose(t.agent, t.propertyId);
    if (!d.ok) throw new Error(d.code);
    const r = await t.annonces.validate(t.agent, d.value.id);
    expect(r).toMatchObject({ ok: false, rule: 'R43', code: 'mentions_incomplete' });
    expect(!r.ok && 'missing' in r && r.missing.map((m) => m.id)).toEqual(['prix', 'carte']);
  });

  it('[R16] lecture et écriture selon les droits, chaque refus au journal', async () => {
    const t = await setup();
    expect(await t.annonces.propose(t.sam, t.propertyId)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.annonces.propose(t.compliance, t.propertyId)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    await t.annonces.propose(t.agent, t.propertyId);
    expect(await t.annonces.read(t.compliance, t.propertyId)).toMatchObject({ ok: true, value: { seq: 1 } });
    expect(await t.annonces.validate(t.agent, 'brouillon-inconnu')).toEqual({ ok: false, rule: null, code: 'unknown_draft' });
    const refusals = (await t.journal.bySubject(`property:${t.propertyId}`)).filter((e) => e.type === 'acces.refuse');
    expect(refusals.length).toBeGreaterThanOrEqual(2);
  });
});
