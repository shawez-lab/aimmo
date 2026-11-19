import { describe, expect, it } from 'vitest';
import {
  Acces,
  ControlesSignature,
  Diffusion,
  FicheClient,
  FicheUnique,
  Modeles,
  RegistreMandats,
  SignatureAvenant,
  SignaturePapier,
  SqlJournalStore,
  applyMigrations,
  fromSyncSqlite,
  type SqlDatabase,
  type Viewer,
} from '../src/index.ts';
import { FicheBien, MentionsAnnonce, computeMentions, dpeValidOn, dpeValidUntil, euros, feePercent, type MentionsInput, type PropertySheet } from '../src/annonces/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';
import { identiteAuCoffre } from './identite-coffre.ts';
import { designerTout } from './designation-jeu.ts';
import { rangerStatut } from './statut-agent-jeu.ts';

// Biens, mandats et numéro de carte inventés.
const S = ' ';
const N = ' ';
const CARD = 'CPI 2101 2027 000 000 001';
const TODAY = '2027-03-01';

const sheet = (patch: Partial<PropertySheet> = {}): PropertySheet => ({
  characteristics: { bedrooms: 2, floor: 1, floorsTotal: 3, buildYear: 1970, heating: 'collectif', outdoor: [], landM2: null, parkingSpaces: null, elevator: null },
  energy: { energyClass: 'D', climateClass: 'D', annualCostMinEur: 1100, annualCostMaxEur: 1550, costReferenceYear: 2023, diagnosedOn: '2027-01-15' },
  coownership: { isCoownership: false },
  risks: { inRiskZone: false },
  media: [],
  ...patch,
});

// L'agent du bien et son statut, inventés (AU007).
const PRO = { firstName: 'Camille', lastName: 'Exemple', status: 'agent_commercial', rsacNumber: '900 000 001', rsacRegistry: 'Dijon', cardHolder: 'Réseau Test SAS' } as const;
const INTERVENANT = 'Annonce présentée par Camille Exemple, agent commercial immatriculé au registre spécial des agents commerciaux (RSAC) de Dijon sous le n° 900 000 001, habilité par Réseau Test SAS, titulaire de la carte professionnelle ci-dessous.';
const CARTE = `${INTERVENANT}\nCarte professionnelle n° ${CARD}.`;
const energie = (e: string, c: string, min: string, max: string, year: number, excessive = false) =>
  `Classe énergie ${e}, classe climat ${c}.${excessive ? ' Logement à consommation énergétique excessive.' : ''} Montant estimé des dépenses annuelles d'énergie pour un usage standard : entre ${min}${N}€ et ${max}${N}€ par an. Prix moyens des énergies indexés au 1er janvier ${year} (abonnements compris).`;
const GEO = 'Les informations sur les risques auxquels ce bien est exposé sont disponibles sur le site Géorisques : www.georisques.gouv.fr.';

// Les 10 annonces tests de la liste de contrôle des mentions, et leur texte attendu au caractère près [R43].
const CASES: { name: string; input: MentionsInput; price: number; text: string }[] = [
  {
    name: '1 · appartement, honoraires acquéreur, 5 %',
    input: { kind: 'home', terms: { priceEur: 200000, feeEur: 10000, feeCharge: 'acquereur' }, sheet: sheet(), cardNumber: CARD, intervenant: PRO, today: TODAY },
    price: 210000,
    text: [`Prix : 210${S}000${N}€ honoraires inclus, soit 200${S}000${N}€ hors honoraires et 5${N}% TTC du prix hors honoraires, à la charge de l'acquéreur.`, energie('D', 'D', `1${S}100`, `1${S}550`, 2023), CARTE].join('\n'),
  },
  {
    name: '2 · maison, honoraires vendeur',
    input: { kind: 'home', terms: { priceEur: 315000, feeEur: 12000, feeCharge: 'vendeur' }, sheet: sheet(), cardNumber: CARD, intervenant: PRO, today: TODAY },
    price: 315000,
    text: [`Prix : 315${S}000${N}€, honoraires à la charge du vendeur.`, energie('D', 'D', `1${S}100`, `1${S}550`, 2023), CARTE].join('\n'),
  },
  {
    name: '3 · pourcentage arrondi au centième',
    input: { kind: 'home', terms: { priceEur: 210000, feeEur: 9500, feeCharge: 'acquereur' }, sheet: sheet(), cardNumber: CARD, intervenant: PRO, today: TODAY },
    price: 219500,
    text: [`Prix : 219${S}500${N}€ honoraires inclus, soit 210${S}000${N}€ hors honoraires et 4,52${N}% TTC du prix hors honoraires, à la charge de l'acquéreur.`, energie('D', 'D', `1${S}100`, `1${S}550`, 2023), CARTE].join('\n'),
  },
  {
    name: '4 · pourcentage à un chiffre après la virgule',
    input: { kind: 'home', terms: { priceEur: 100000, feeEur: 4500, feeCharge: 'acquereur' }, sheet: sheet(), cardNumber: CARD, intervenant: PRO, today: TODAY },
    price: 104500,
    text: [`Prix : 104${S}500${N}€ honoraires inclus, soit 100${S}000${N}€ hors honoraires et 4,5${N}% TTC du prix hors honoraires, à la charge de l'acquéreur.`, energie('D', 'D', `1${S}100`, `1${S}550`, 2023), CARTE].join('\n'),
  },
  {
    name: '5 · logement classé F, très énergivore',
    input: { kind: 'home', terms: { priceEur: 98000, feeEur: 7000, feeCharge: 'vendeur' }, sheet: sheet({ energy: { energyClass: 'F', climateClass: 'E', annualCostMinEur: 2400, annualCostMaxEur: 3300, costReferenceYear: 2021, diagnosedOn: '2026-11-02' } }), cardNumber: CARD, intervenant: PRO, today: TODAY },
    price: 98000,
    text: [`Prix : 98${S}000${N}€, honoraires à la charge du vendeur.`, energie('F', 'E', `2${S}400`, `3${S}300`, 2021, true), CARTE].join('\n'),
  },
  {
    name: '6 · logement classé G',
    input: { kind: 'home', terms: { priceEur: 75000, feeEur: 6000, feeCharge: 'acquereur' }, sheet: sheet({ energy: { energyClass: 'G', climateClass: 'G', annualCostMinEur: 3900, annualCostMaxEur: 5300, costReferenceYear: 2023, diagnosedOn: '2027-02-20' } }), cardNumber: CARD, intervenant: PRO, today: TODAY },
    price: 81000,
    text: [`Prix : 81${S}000${N}€ honoraires inclus, soit 75${S}000${N}€ hors honoraires et 8${N}% TTC du prix hors honoraires, à la charge de l'acquéreur.`, energie('G', 'G', `3${S}900`, `5${S}300`, 2023, true), CARTE].join('\n'),
  },
  {
    name: '7 · copropriété sans procédure',
    input: { kind: 'home', terms: { priceEur: 180000, feeEur: 9000, feeCharge: 'acquereur' }, sheet: sheet({ coownership: { isCoownership: true, lots: 24, annualChargesEur: 1800, proceedings: false } }), cardNumber: CARD, intervenant: PRO, today: TODAY },
    price: 189000,
    text: [`Prix : 189${S}000${N}€ honoraires inclus, soit 180${S}000${N}€ hors honoraires et 5${N}% TTC du prix hors honoraires, à la charge de l'acquéreur.`, energie('D', 'D', `1${S}100`, `1${S}550`, 2023), `Bien en copropriété : 24 lots, charges annuelles moyennes de 1${S}800${N}€. Aucune procédure en cours.`, CARTE].join('\n'),
  },
  {
    name: '8 · copropriété avec procédure, un seul lot',
    input: { kind: 'home', terms: { priceEur: 120000, feeEur: 8000, feeCharge: 'vendeur' }, sheet: sheet({ coownership: { isCoownership: true, lots: 1, annualChargesEur: 0, proceedings: true } }), cardNumber: CARD, intervenant: PRO, today: TODAY },
    price: 120000,
    text: [`Prix : 120${S}000${N}€, honoraires à la charge du vendeur.`, energie('D', 'D', `1${S}100`, `1${S}550`, 2023), `Bien en copropriété : 1 lot, charges annuelles moyennes de 0${N}€. Le syndicat des copropriétaires fait l'objet d'une procédure en cours.`, CARTE].join('\n'),
  },
  {
    name: '9 · bien en zone de risque',
    input: { kind: 'home', terms: { priceEur: 1250000, feeEur: 50000, feeCharge: 'acquereur' }, sheet: sheet({ risks: { inRiskZone: true } }), cardNumber: CARD, intervenant: PRO, today: TODAY },
    price: 1300000,
    text: [`Prix : 1${S}300${S}000${N}€ honoraires inclus, soit 1${S}250${S}000${N}€ hors honoraires et 4${N}% TTC du prix hors honoraires, à la charge de l'acquéreur.`, energie('D', 'D', `1${S}100`, `1${S}550`, 2023), GEO, CARTE].join('\n'),
  },
  {
    name: '10 · terrain, sans diagnostic énergétique',
    input: { kind: 'land', terms: { priceEur: 65000, feeEur: 5000, feeCharge: 'vendeur' }, sheet: sheet({ energy: null }), cardNumber: CARD, intervenant: PRO, today: TODAY },
    price: 65000,
    text: [`Prix : 65${S}000${N}€, honoraires à la charge du vendeur.`, CARTE].join('\n'),
  },
];

describe('P02 · mentions obligatoires', () => {
  for (const c of CASES) {
    it(`[R43] annonce test ${c.name} : liste complète, texte au caractère près`, () => {
      const r = computeMentions(c.input);
      expect(r.items.filter((i) => i.status === 'manquante')).toEqual([]);
      expect(r.complete).toBe(true);
      expect(r.text).toBe(c.text);
      expect(r.publishedPriceEur).toBe(c.price);
    });
  }

  it('[R45] AU065 : un diagnostic qui cite plusieurs années de prix les garde, telles qu’il les écrit', () => {
    const energy = { energyClass: 'D', climateClass: 'D', annualCostMinEur: 1100, annualCostMaxEur: 1550, costReferenceYear: 2023, costReferenceYears: [2021, 2022, 2023], diagnosedOn: '2026-11-02' } as const;
    const r = computeMentions({ kind: 'home', terms: { priceEur: 315000, feeEur: 12000, feeCharge: 'vendeur' }, sheet: sheet({ energy: { ...energy, costReferenceYears: [...energy.costReferenceYears] } }), cardNumber: CARD, today: TODAY });
    expect(r.text).toContain('Prix moyens des énergies indexés sur les années 2021, 2022 et 2023 (abonnements compris).');
    expect(r.text).not.toContain('1er janvier');
  });

  it('[R43] chaque mention manquante bloque, nommée avec sa raison', () => {
    const base = CASES[0]!.input;
    const missing = (input: MentionsInput) => computeMentions(input).items.flatMap((i) => (i.status === 'manquante' ? [`${i.id}:${i.reason}`] : []));
    expect(missing({ ...base, terms: null })).toEqual(['prix:pas_de_mandat']);
    expect(missing({ ...base, terms: { priceEur: null, feeEur: 1, feeCharge: 'vendeur' } })).toEqual(['prix:prix_inconnu']);
    expect(missing({ ...base, terms: { priceEur: 100000, feeEur: null, feeCharge: 'acquereur' } })).toEqual(['prix:honoraires_inconnus']);
    expect(missing({ ...base, terms: { priceEur: 100000, feeEur: 5000, feeCharge: null } })).toEqual(['prix:honoraires_inconnus']);
    expect(missing({ ...base, sheet: sheet({ coownership: null }) })).toEqual(['copropriete:copropriete_inconnue']);
    expect(missing({ ...base, sheet: sheet({ risks: null }) })).toEqual(['risques:risques_inconnus']);
    expect(missing({ ...base, cardNumber: null })).toEqual(['carte:carte_inconnue']);
    expect(missing({ ...base, cardNumber: '  ' })).toEqual(['carte:carte_inconnue']);
    expect(missing({ ...base, kind: 'commercial' })).toEqual(['prix:type_de_bien_non_pris_en_charge', 'energie:type_de_bien_non_pris_en_charge', 'copropriete:type_de_bien_non_pris_en_charge', 'risques:type_de_bien_non_pris_en_charge']);
    const blocked = computeMentions({ ...base, cardNumber: null });
    expect(blocked.complete).toBe(false);
    expect(blocked.publishedPriceEur).toBeNull();
  });

  it('[R45] sans diagnostic énergétique, rien ne passe, sauf pour un terrain', () => {
    const r = computeMentions({ ...CASES[0]!.input, sheet: sheet({ energy: null }) });
    expect(r.complete).toBe(false);
    expect(r.items).toContainEqual({ id: 'energie', status: 'manquante', reason: 'pas_de_diagnostic' });
    expect(computeMentions({ ...CASES[0]!.input, sheet: null }).items).toContainEqual({ id: 'energie', status: 'manquante', reason: 'pas_de_diagnostic' });
    expect(computeMentions({ ...CASES[0]!.input, kind: 'building', sheet: sheet({ energy: null }) }).complete).toBe(false);
    expect(computeMentions(CASES[9]!.input).items).toContainEqual({ id: 'energie', status: 'sans_objet' });
  });

  it('[R45] AU005 : un diagnostic de 2019 ne passe plus la liste en novembre 2026', () => {
    const dpe2019 = sheet({ energy: { energyClass: 'D', climateClass: 'D', annualCostMinEur: 1100, annualCostMaxEur: 1550, costReferenceYear: 2019, diagnosedOn: '2019-06-12' } });
    const r = computeMentions({ ...CASES[0]!.input, sheet: dpe2019, today: '2026-11-19' });
    expect(r.complete).toBe(false);
    expect(r.publishedPriceEur).toBeNull();
    expect(r.items).toContainEqual({ id: 'energie', status: 'manquante', reason: 'diagnostic_perime' });
    expect(r.text).not.toContain('Classe énergie');
    // Le même diagnostic passait encore à la fin de sa validité transitoire.
    expect(computeMentions({ ...CASES[0]!.input, sheet: dpe2019, today: '2024-12-31' }).complete).toBe(true);
    expect(computeMentions({ ...CASES[0]!.input, sheet: dpe2019, today: '2025-01-01' }).complete).toBe(false);
  });

  it('[R45] validité du diagnostic : fins fixées avant juillet 2021, dix ans depuis, jusqu’à la veille', () => {
    expect(dpeValidUntil('2012-05-01')).toBe('2022-04-30');
    expect(dpeValidUntil('2013-01-01')).toBe('2022-12-31');
    expect(dpeValidUntil('2017-12-31')).toBe('2022-12-31');
    expect(dpeValidUntil('2018-01-01')).toBe('2024-12-31');
    expect(dpeValidUntil('2021-06-30')).toBe('2024-12-31');
    expect(dpeValidUntil('2021-07-01')).toBe('2031-06-30');
    expect(dpeValidUntil('2024-02-29')).toBe('2034-02-28');
    expect(dpeValidUntil('2027-01-15')).toBe('2037-01-14');
    expect(dpeValidUntil('2027-02-30')).toBeNull();
    expect(dpeValidUntil('15/01/2027')).toBeNull();
    expect(dpeValidOn('2021-07-01', '2031-06-30')).toBe(true);
    expect(dpeValidOn('2021-07-01', '2031-07-01')).toBe(false);
    // Daté après le jour du calcul, ou jour du calcul mal formé : jamais retenu.
    expect(dpeValidOn('2027-01-15', '2027-01-14')).toBe(false);
    expect(dpeValidOn('2027-01-15', '')).toBe(false);
    const late = computeMentions({ ...CASES[0]!.input, today: '2037-01-15' });
    expect(late.items).toContainEqual({ id: 'energie', status: 'manquante', reason: 'diagnostic_perime' });
    // Un terrain n'a toujours pas de diagnostic à juger.
    expect(computeMentions({ ...CASES[9]!.input, today: '2040-01-01' }).complete).toBe(true);
  });

  it('pourcentage calculé juste, arrondi au centième le demi vers le haut, et montants écrits à la française', () => {
    expect(feePercent(10000, 200000)).toBe(`5${N}%`);
    expect(feePercent(9500, 210000)).toBe(`4,52${N}%`);
    expect(feePercent(1, 8000)).toBe(`0,01${N}%`); // 0,0125 % → 0,01
    expect(feePercent(3, 8000)).toBe(`0,04${N}%`); // 0,0375 % → 0,04
    expect(feePercent(1, 16000)).toBe(`0,01${N}%`); // 0,00625 % → 0,01 (demi vers le haut)
    expect(feePercent(12345, 123456)).toBe(`10${N}%`); // 9,9996 % → 10
    expect(feePercent(0, 100000)).toBe(`0${N}%`);
    expect(euros(0)).toBe(`0${N}€`);
    expect(euros(999)).toBe(`999${N}€`);
    expect(euros(1000)).toBe(`1${S}000${N}€`);
    expect(euros(12345678)).toBe(`12${S}345${S}678${N}€`);
  });
});

// Un mandat signé et numéroté, puis un avenant de prix, sur des données inventées.
const MANDATE = 'Mandat de test : {{mandant.nom}}, {{bien.prix}}, {{honoraires.montant}} {{honoraires.charge}}, {{mandat.duree_mois}}.\n\nNuméro : {{registre.numero}} · {{bien.adresse}} · {{bien.cadastre}} · {{mandant.domicile}}.';
const AMENDMENT = 'Avenant de test au mandat n° {{mandat.numero}} : {{avenant.objet}}.\n\nMandant : {{mandant.nom}}. Signé le {{signature.date}}, {{signature.lieu}}.';

async function setup(feeCharge: 'vendeur' | 'acquereur' = 'acquereur', place: 'agence' | 'hors_agence' = 'agence') {
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
  for (const [kind, body] of [['mandat_vente_simple', MANDATE], ['avenant_mandat', AMENDMENT]] as const) {
    const v = await modeles.createVersion(direction, kind, body);
    if (!v.ok) throw new Error(v.code);
    await modeles.validate(as('compliance', 'c-1'), v.template.id);
  }
  await controles.setFeeSchedule(direction, { maxRatePercent: 6, minEur: 0 });
  await new RegistreMandats(db, journal, { now }).configure(direction, { prefix: 'T-', firstNumber: 1, width: 3 });
  const p = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Léa', lastName: 'Exemple' });
  const b = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'REF-T-1', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 60, rooms: 3, priceEur: 200000 });
  const project = await store.createProject({ networkId: network.id, agentId: alex.id, personId: p.id, kind: 'sell' });
  await store.linkProjectProperty({ networkId: network.id, agentId: alex.id, projectId: project.id, propertyId: b.id, role: 'owned' });
  await identiteAuCoffre({ db, acces, journal, now }, agent, p.id, { piece: 'carte_identite', seenAt: new Date('2027-02-10T09:00:00.000Z') });
  // Le statut de l'agent du bien, rangé par la direction (AU007).
  await rangerStatut(db, journal, now, direction, [alex.id]);
  const mentions = new MentionsAnnonce(db, acces, journal, { now });
  const fiches = new FicheBien(db, acces, journal, { now });
  const signMandate = async () => {
    await designerTout(db);
    const d = await modeles.generate(agent, { kind: 'mandat_vente_simple', personId: p.id, propertyId: b.id, inputs: { 'honoraires.montant': 10000, 'honoraires.charge': feeCharge, 'mandat.duree_mois': 12 } });
    if (!d.ok) throw new Error(d.code);
    const signed = await new SignaturePapier(db, acces, journal, { now }).register(agent, d.document.id, { signedAt: new Date('2027-02-10T09:00:00.000Z'), place, scanRef: 'scans/mandat.pdf', source: 'referral' });
    if (!signed.ok) throw new Error(signed.code);
    return signed.value.mandateId;
  };
  const signPriceAmendment = async (mandateId: string, priceEur: number) => {
    clock = new Date('2027-03-01T10:00:00.000Z');
    const a = await modeles.generate(agent, { kind: 'avenant_mandat', personId: p.id, propertyId: b.id, mandateId, inputs: { 'avenant.prix': priceEur } });
    if (!a.ok) throw new Error(a.code);
    const r = await new SignatureAvenant(db, acces, journal, { now }).register(agent, a.document.id, { signedAt: new Date('2027-03-01T09:00:00.000Z'), place: 'agence', scanRef: 'scans/avenant.pdf' });
    if (!r.ok) throw new Error(r.code);
  };
  const fullSheet = { energy: { energyClass: 'C', climateClass: 'C', annualCostMinEur: 900, annualCostMaxEur: 1300, costReferenceYear: 2023, diagnosedOn: '2027-01-15' }, coownership: { isCoownership: false }, risks: { inRiskZone: false } };
  return { db, journal, acces, now, setClock: (d: Date) => (clock = d), mentions, fiches, agent, direction, compliance: as('compliance', 'c-1'), sam: as('agent', sam.id), propertyId: b.id, signMandate, signPriceAmendment, fullSheet };
}

describeWithSqlite('P02 · liste de contrôle d’un bien', () => {
  it('[R44] le prix vient du mandat en vigueur, avenant de prix signé compris, jamais de la fiche du bien', async () => {
    const t = await setup();
    await t.mentions.setCardNumber(t.direction, CARD);
    await t.fiches.save(t.agent, t.propertyId, t.fullSheet);
    // Sans mandat signé, pas de prix, même si la fiche du bien en porte un.
    const before = await t.mentions.check(t.agent, t.propertyId);
    expect(before.ok && before.value.items[0]).toEqual({ id: 'prix', status: 'manquante', reason: 'pas_de_mandat' });
    const mandateId = await t.signMandate();
    const signed = await t.mentions.check(t.agent, t.propertyId);
    expect(signed.ok && signed.value).toMatchObject({ complete: true, publishedPriceEur: 210000 });
    // Le prix de la fiche du bien change : le prix publié ne bouge pas.
    await t.db.run('UPDATE properties SET price_eur = 999999 WHERE id = ?', [t.propertyId]);
    const unchanged = await t.mentions.check(t.agent, t.propertyId);
    expect(unchanged.ok && unchanged.value.publishedPriceEur).toBe(210000);
    // Un avenant de prix signé : le prix publié suit, les honoraires du mandat restent.
    await t.signPriceAmendment(mandateId, 190000);
    const after = await t.mentions.check(t.agent, t.propertyId);
    expect(after.ok && after.value.publishedPriceEur).toBe(200000);
    expect(after.ok && after.value.text).toContain(`Prix : 200${S}000${N}€ honoraires inclus, soit 190${S}000${N}€ hors honoraires et 5,26${N}% TTC du prix hors honoraires, à la charge de l'acquéreur.`);
  });

  it('[R43] [R45] une fiche sans diagnostic ou sans carte bloque la liste', async () => {
    const t = await setup('vendeur');
    await t.signMandate();
    await t.fiches.save(t.agent, t.propertyId, { ...t.fullSheet, energy: null });
    const r = await t.mentions.check(t.agent, t.propertyId);
    expect(r.ok && r.value.complete).toBe(false);
    expect(r.ok && r.value.items.filter((i) => i.status === 'manquante').map((i) => i.id)).toEqual(['energie', 'carte']);
    await t.mentions.setCardNumber(t.direction, CARD);
    await t.fiches.save(t.agent, t.propertyId, t.fullSheet);
    const ok = await t.mentions.check(t.agent, t.propertyId);
    expect(ok.ok && ok.value).toMatchObject({ complete: true, publishedPriceEur: 200000 });
  });

  it('[R45] AU005 : la liste juge le diagnostic au jour de Paris de chaque lecture', async () => {
    const t = await setup('vendeur');
    await t.signMandate();
    await t.mentions.setCardNumber(t.direction, CARD);
    await t.fiches.save(t.agent, t.propertyId, { ...t.fullSheet, energy: { ...t.fullSheet.energy, diagnosedOn: '2019-06-12' } });
    const r = await t.mentions.check(t.agent, t.propertyId);
    expect(r.ok && r.value.items.filter((i) => i.status === 'manquante')).toEqual([{ id: 'energie', status: 'manquante', reason: 'diagnostic_perime' }]);
    // Le jour vient de l'horloge, à l'heure de Paris : 22 h 30 UTC le 30 juin, c'est déjà le 1er juillet à Paris.
    t.setClock(new Date('2031-06-30T21:30:00.000Z'));
    expect((await t.mentions.inputFor(t.agent.networkId, t.propertyId))?.today).toBe('2031-06-30');
    t.setClock(new Date('2031-06-30T22:30:00.000Z'));
    expect((await t.mentions.inputFor(t.agent.networkId, t.propertyId))?.today).toBe('2031-07-01');
  });

  it('[R16] seule la direction règle la carte ; un autre agent ne lit pas la liste ; chaque refus au journal', async () => {
    const t = await setup();
    expect(await t.mentions.setCardNumber(t.agent, CARD)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.mentions.setCardNumber(t.direction, 'n°<script>')).toEqual({ ok: false, rule: null, code: 'bad_card' });
    expect(await t.mentions.check(t.sam, t.propertyId)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.mentions.check(t.compliance, t.propertyId)).toMatchObject({ ok: true });
    expect(await t.mentions.check(t.agent, 'bien-inconnu')).toEqual({ ok: false, rule: null, code: 'unknown_property' });
    const refusals = await t.journal.bySubject(`property:${t.propertyId}`);
    expect(refusals.filter((e) => e.type === 'acces.refuse')).toHaveLength(1);
    await expect(t.db.run('DELETE FROM listing_settings')).resolves.toBeDefined(); // table vide : rien à effacer
    await t.mentions.setCardNumber(t.direction, CARD);
    await expect(t.db.run('DELETE FROM listing_settings')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run("UPDATE listing_settings SET card_number = 'X1234'")).rejects.toThrow(/ne change plus/);
  });

  it('[R44] un mandat rétracté, annulé, échu ou sans durée ne donne aucun prix ; en délai de rétractation, si', async () => {
    const price = async (t: Awaited<ReturnType<typeof setup>>) => {
      const r = await t.mentions.check(t.agent, t.propertyId);
      if (!r.ok) throw new Error(r.code);
      return r.value.items[0];
    };
    // En délai de rétractation : le mandat est en vigueur, le prix est connu (la diffusion attend, P04).
    const w = await setup('acquereur', 'hors_agence');
    const wm = await w.signMandate();
    expect((await price(w))!.status).toBe('presente');
    // Rétracté dans le délai : plus de prix.
    w.setClock(new Date('2027-02-12T10:00:00.000Z'));
    const withdrawn = await new Diffusion(w.db, w.acces, w.journal, { now: w.now }).recordWithdrawal(w.agent, wm, { proof: 'lettre recommandée reçue', receivedAt: new Date('2027-02-12T09:00:00.000Z') });
    expect(withdrawn).toEqual({ ok: true });
    expect(await price(w)).toEqual({ id: 'prix', status: 'manquante', reason: 'pas_de_mandat' });
    // Annulé au registre.
    const c = await setup();
    const cm = await c.signMandate();
    expect((await price(c))!.status).toBe('presente');
    expect(await new RegistreMandats(c.db, c.journal, { now: c.now }).cancel(c.direction, cm, 'termination')).toMatchObject({ ok: true });
    expect(await price(c)).toEqual({ id: 'prix', status: 'manquante', reason: 'pas_de_mandat' });
    // Échu : 12 mois après la signature.
    const e = await setup();
    await e.signMandate();
    e.setClock(new Date('2028-02-10T10:00:00.000Z'));
    expect(await price(e)).toEqual({ id: 'prix', status: 'manquante', reason: 'pas_de_mandat' });
    e.setClock(new Date('2028-02-09T10:00:00.000Z'));
    expect((await price(e))!.status).toBe('presente');
  });
});
