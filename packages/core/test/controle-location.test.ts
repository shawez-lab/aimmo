import { describe, expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { Candidatures, MisesEnLocation, OFFICIAL_PIECES, type RentalFacts } from '../src/location/index.ts';
import {
  base32Decode,
  base32Encode,
  checkPayslips,
  checkTaxNotice,
  checkEmployerFindings,
  ControleDossiers,
  FINDING_TEXTS,
  luhnValid,
  parseTwoDDoc,
  siretKeyValid,
  type CompanyRegistry,
  type EcPublicJwk,
  type Finding,
  type PayslipRead,
  type RegistryAnswer,
  type TrustAnswer,
  type TrustList,
} from '../src/controle-location/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Candidats, employeurs, numéros, avis et montants inventés. Le 12 juillet 2027 est un lundi.
const GS = '\u001d';
const US = '\u001f';
const TODAY = '2027-07-12';

/** Complète un préfixe de chiffres par la clé de Luhn. */
function luhnComplete(prefix: string): string {
  for (let d = 0; d <= 9; d++) if (luhnValid(prefix + d)) return prefix + d;
  throw new Error('clé');
}
/** Un SIRET inventé à clé juste. */
const siretOf = (siren8: string, nic4: string): string => luhnComplete(luhnComplete(siren8) + nic4);
const EMPLOYER = siretOf('90123456', '0001');
const OTHER_EMPLOYER = siretOf('90765432', '0002');
const CLOSED_EMPLOYER = siretOf('90111222', '0003');

async function issuer() {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as import('node:crypto').webcrypto.CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as EcPublicJwk;
  const sign = async (data: string) => new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(data)));
  return { jwk, sign };
}

const NOTICE = { reference: '2771A23456789', fiscalIncome: '31 420', incomeYear: '2026', parts: '1,5' };
const message = (o: { ref?: string; rfr?: string; year?: string; parts?: string } = {}) =>
  `44${o.ref ?? '2771A23456789'}45${o.year ?? '2026'}41${o.rfr ?? '31420'}${GS}43${o.parts ?? '1.5'}`;

/** Un code 2D-Doc d'en-tête version 04, signé par l'émetteur inventé. */
async function code(sign: (d: string) => Promise<Uint8Array>, o: { docType?: string; ca?: string; body?: string } = {}) {
  const header = `DC04${o.ca ?? 'FR00'}0001${'2A1F'}${'2A1F'}${o.docType ?? '28'}01FR`;
  const signed = header + (o.body ?? message());
  return `${signed}${US}${base32Encode(await sign(signed))}`;
}

function trustOf(jwk: EcPublicJwk, o: { revoked?: boolean } = {}): TrustList & { calls: number } {
  const t = {
    calls: 0,
    async certificate(caId: string, certId: string): Promise<TrustAnswer> {
      t.calls += 1;
      return caId === 'FR00' && certId === '0001' ? { status: 'known', publicKey: jwk, revoked: o.revoked ?? false } : { status: 'unknown' };
    },
  };
  return t;
}

function registryOf(map: Record<string, RegistryAnswer> = {}): CompanyRegistry {
  return {
    async establishment(siret: string): Promise<RegistryAnswer> {
      return map[siret] ?? { status: 'unknown' };
    },
  };
}
const REGISTRY = registryOf({
  [EMPLOYER]: { status: 'open' },
  [OTHER_EMPLOYER]: { status: 'open' },
  [CLOSED_EMPLOYER]: { status: 'closed', closedOn: '2027-03-15' },
});

const outcome = (fs: Finding[], control: string, month?: string) => fs.find((f) => f.control === control && (month === undefined || f.month === month))?.outcome;

/** Trois bulletins justes : 2027-04 à 2027-06, net imposable 2 300 €, taux 4,1 %. */
function slip(month: string, cumul: number, patch: Partial<PayslipRead> = {}): PayslipRead {
  return { month, grossCents: 300_000, netBeforeTaxCents: 234_000, taxableNetCents: 230_000, ratePercent: 4.1, taxWithheldCents: 9_430, netPaidCents: 224_570, cumulativeGrossCents: cumul, siret: EMPLOYER, ...patch };
}
const GOOD_SLIPS = [slip('2027-04', 1_200_000), slip('2027-05', 1_500_000), slip('2027-06', 1_800_000)];

describe('HX47 · le code 2D-Doc d’un avis d’impôt', () => {
  it('[R531] base 32 aller-retour, et lecture des champs d’un code signé', async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 17, 64]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    expect(base32Decode('abc!')).toBeNull();
    const { sign } = await issuer();
    const p = parseTwoDDoc(await code(sign));
    expect(p?.header).toEqual({ version: 4, caId: 'FR00', certId: '0001', docType: '28' });
    expect(p?.fields).toEqual({ reference_avis: '2771A23456789', annee_revenus: '2026', revenu_fiscal: '31420', parts: '1.5' });
    expect(p?.signature.length).toBe(64);
    // Un champ que le dictionnaire ne connaît pas : la lecture des champs échoue, la signature se vérifie quand même.
    expect(parseTwoDDoc(await code(sign, { body: `99abc${GS}${message()}` }))?.fields).toBeNull();
    for (const bad of [null, 42, '', 'XX04', 'DC04FR00', `DC04FR0000012A1F2A1F2801FR${message()}`, `DC99FR0000012A1F2A1F2801FR${US}AAAA`]) expect(parseTwoDDoc(bad), String(bad)).toBeNull();
  });

  it('[R531] un avis au code signé et aux valeurs imprimées identiques : chaque ligne est conforme', async () => {
    const { jwk, sign } = await issuer();
    const fs = await checkTaxNotice({ twoDDoc: await code(sign), printed: NOTICE }, trustOf(jwk), TODAY);
    expect(fs).toEqual([
      { control: 'code_2d_doc', outcome: 'conforme' },
      { control: 'code_2d_doc_sorte', outcome: 'conforme' },
      { control: 'avis_reference', outcome: 'conforme' },
      { control: 'avis_revenu_fiscal', outcome: 'conforme' },
      { control: 'avis_annee', outcome: 'conforme' },
      { control: 'avis_parts', outcome: 'conforme' },
      { control: 'avis_recent', outcome: 'conforme' },
    ]);
  });

  it('[R531] un code 2D-Doc faux, données changées après la signature : écart, et rien n’est comparé à ses valeurs', async () => {
    const { jwk, sign } = await issuer();
    const genuine = await code(sign);
    const forged = genuine.replace('41' + '31420', '41' + '91420');
    expect(forged).not.toBe(genuine);
    const fs = await checkTaxNotice({ twoDDoc: forged, printed: { ...NOTICE, fiscalIncome: '91420' } }, trustOf(jwk), TODAY);
    expect(outcome(fs, 'code_2d_doc')).toBe('ecart');
    for (const c of ['code_2d_doc_sorte', 'avis_reference', 'avis_revenu_fiscal', 'avis_annee', 'avis_parts']) expect(outcome(fs, c), c).toBe('non_verifiable');
    // Signé par une autre clé que celle de l'émetteur : écart aussi.
    const other = await issuer();
    expect(outcome(await checkTaxNotice({ twoDDoc: await code(other.sign), printed: NOTICE }, trustOf(jwk), TODAY), 'code_2d_doc')).toBe('ecart');
    // Signature tronquée : un code mal lu, pas une preuve.
    expect(outcome(await checkTaxNotice({ twoDDoc: genuine.slice(0, -8), printed: NOTICE }, trustOf(jwk), TODAY), 'code_2d_doc')).toBe('non_verifiable');
    // Un avis authentique dont le lecteur du téléphone a perdu le séparateur : le code ne se découpe plus, rien n'est prouvé.
    const lost = await checkTaxNotice({ twoDDoc: genuine.replace(GS, ''), printed: NOTICE }, trustOf(jwk), TODAY);
    expect(lost.filter((f) => f.control !== 'avis_recent').every((f) => f.outcome === 'non_verifiable')).toBe(true);
  });

  it('[R531] sans preuve, pas d’écart : code absent ou illisible, émetteur inconnu, certificat révoqué, liste injoignable', async () => {
    const { jwk, sign } = await issuer();
    const unavailable: TrustList = { certificate: async () => ({ status: 'unavailable' }) };
    const throwing: TrustList = {
      certificate: async () => {
        throw new Error('réseau');
      },
    };
    const cases: [unknown, TrustList][] = [
      [undefined, trustOf(jwk)],
      ['pas un code', trustOf(jwk)],
      [await code(sign, { ca: 'FR09' }), trustOf(jwk)],
      [await code(sign), trustOf(jwk, { revoked: true })],
      [await code(sign), unavailable],
      [await code(sign), throwing],
    ];
    for (const [raw, trust] of cases) {
      const fs = await checkTaxNotice({ twoDDoc: raw, printed: NOTICE }, trust, TODAY);
      expect(fs.filter((f) => f.control !== 'avis_recent').every((f) => f.outcome === 'non_verifiable'), String(raw)).toBe(true);
      expect(fs.some((f) => f.outcome === 'ecart')).toBe(false);
    }
  });

  it('[R531] un code signé qui n’est pas celui d’un avis d’impôt ; une valeur imprimée qui diffère du code signé', async () => {
    const { jwk, sign } = await issuer();
    const other = await checkTaxNotice({ twoDDoc: await code(sign, { docType: '01' }), printed: NOTICE }, trustOf(jwk), TODAY);
    expect(outcome(other, 'code_2d_doc')).toBe('conforme');
    expect(outcome(other, 'code_2d_doc_sorte')).toBe('ecart');
    expect(outcome(other, 'avis_revenu_fiscal')).toBe('non_verifiable');
    const fs = await checkTaxNotice({ twoDDoc: await code(sign), printed: { reference: '2771 a234 56789', fiscalIncome: 41420, incomeYear: 2026, parts: '1.50' } }, trustOf(jwk), TODAY);
    expect(outcome(fs, 'avis_reference')).toBe('conforme');
    expect(outcome(fs, 'avis_revenu_fiscal')).toBe('ecart');
    expect(outcome(fs, 'avis_parts')).toBe('conforme');
    // Rien d'imprimé lu : non vérifiable, pas un écart.
    expect(outcome(await checkTaxNotice({ twoDDoc: await code(sign), printed: {} }, trustOf(jwk), TODAY), 'avis_reference')).toBe('non_verifiable');
  });

  it('[R531] le dernier ou l’avant-dernier avis seulement', async () => {
    const { jwk, sign } = await issuer();
    const old = await checkTaxNotice({ twoDDoc: await code(sign, { body: message({ year: '2022' }) }), printed: { ...NOTICE, incomeYear: '2022' } }, trustOf(jwk), TODAY);
    expect(outcome(old, 'avis_recent')).toBe('ecart');
    expect(outcome(old, 'avis_annee')).toBe('conforme');
    // Sans code vérifié, l'année imprimée sert ; sans année du tout, non vérifiable.
    expect(outcome(await checkTaxNotice({ printed: { incomeYear: '2025' } }, trustOf(jwk), TODAY), 'avis_recent')).toBe('conforme');
    expect(outcome(await checkTaxNotice({ printed: { incomeYear: '2027' } }, trustOf(jwk), TODAY), 'avis_recent')).toBe('ecart');
    expect(outcome(await checkTaxNotice({}, trustOf(jwk), TODAY), 'avis_recent')).toBe('non_verifiable');
    // Avant le 1er octobre, l'avis des revenus de l'année moins 3 est encore l'avant-dernier ; en novembre, il ne l'est plus.
    expect(outcome(await checkTaxNotice({ printed: { incomeYear: '2024' } }, trustOf(jwk), '2027-09-30'), 'avis_recent')).toBe('conforme');
    expect(outcome(await checkTaxNotice({ printed: { incomeYear: '2024' } }, trustOf(jwk), '2027-11-08'), 'avis_recent')).toBe('ecart');
    expect(outcome(await checkTaxNotice({ printed: { incomeYear: '2025' } }, trustOf(jwk), '2027-11-08'), 'avis_recent')).toBe('conforme');
  });
});

describe('HX47 · l’employeur au répertoire Sirene', () => {
  it('[R532] la clé du SIRET, avec l’exception de La Poste', () => {
    expect(siretKeyValid(EMPLOYER)).toBe(true);
    expect(siretKeyValid(`${EMPLOYER.slice(0, 3)} ${EMPLOYER.slice(3, 6)} ${EMPLOYER.slice(6, 9)} ${EMPLOYER.slice(9)}`)).toBe(true);
    const wrong = EMPLOYER.slice(0, 13) + String((Number(EMPLOYER[13]) + 1) % 10);
    expect(siretKeyValid(wrong)).toBe(false);
    expect(siretKeyValid('1234')).toBe(false);
    expect(siretKeyValid(12345678901234)).toBe(false);
    // La Poste : la somme des chiffres est un multiple de 5, sans clé de Luhn sur le SIRET entier.
    expect(siretKeyValid('35600000000010')).toBe(true);
    expect(luhnValid('35600000000010')).toBe(false);
    expect(siretKeyValid('35600000000011')).toBe(false);
  });

  it('[R532] ouvert, fermé avant ou après la pièce, inconnu, répertoire injoignable', async () => {
    const at = (siret: unknown, onDate: string, registry: CompanyRegistry = REGISTRY) => checkEmployerFindings(registry, siret, onDate);
    expect(await at(EMPLOYER, TODAY)).toEqual([
      { control: 'employeur_siret', outcome: 'conforme' },
      { control: 'employeur_registre', outcome: 'conforme' },
    ]);
    expect(outcome(await at(CLOSED_EMPLOYER, TODAY), 'employeur_registre')).toBe('ecart');
    expect(outcome(await at(CLOSED_EMPLOYER, '2027-02-01'), 'employeur_registre')).toBe('conforme');
    // Fermé depuis, sans date de pièce connue : rien ne dit qu'il l'était à la signature.
    expect(outcome(await checkEmployerFindings(REGISTRY, CLOSED_EMPLOYER, null), 'employeur_registre')).toBe('non_verifiable');
    expect(outcome(await checkEmployerFindings(REGISTRY, EMPLOYER, null), 'employeur_registre')).toBe('conforme');
    expect(outcome(await at(siretOf('90999888', '0004'), TODAY), 'employeur_registre')).toBe('ecart');
    const bad = await at(EMPLOYER.slice(0, 13) + String((Number(EMPLOYER[13]) + 1) % 10), TODAY);
    expect(bad).toEqual([
      { control: 'employeur_siret', outcome: 'ecart' },
      { control: 'employeur_registre', outcome: 'non_verifiable' },
    ]);
    const down: CompanyRegistry = {
      establishment: async () => {
        throw new Error('réseau');
      },
    };
    expect(outcome(await at(EMPLOYER, TODAY, down), 'employeur_registre')).toBe('non_verifiable');
    expect(outcome(await at(EMPLOYER, TODAY, registryOf({ [EMPLOYER]: { status: 'unavailable' } })), 'employeur_registre')).toBe('non_verifiable');
    expect(outcome(await at(EMPLOYER, TODAY, registryOf({ [EMPLOYER]: { status: 'closed', closedOn: 'hier' } })), 'employeur_registre')).toBe('non_verifiable');
    expect((await at(undefined, TODAY)).every((f) => f.outcome === 'non_verifiable')).toBe(true);
  });
});

describe('HX47 · les trois derniers bulletins recalculés', () => {
  it('[R533] trois bulletins justes : chaque ligne est conforme, mois par mois', async () => {
    const fs = await checkPayslips(GOOD_SLIPS, REGISTRY);
    // Le cumul du premier mois fourni ne se recalcule pas sans le mois d'avant, sauf en janvier.
    expect(fs.filter((f) => f.outcome !== 'conforme')).toEqual([{ control: 'bulletin_cumul', outcome: 'non_verifiable', month: '2027-04', slip: 1 }]);
    expect(fs.map((f) => [f.control, f.month ?? null])).toEqual([
      ['bulletins_mois', null],
      ['bulletin_net_paye', '2027-04'],
      ['bulletin_prelevement', '2027-04'],
      ['bulletin_cumul', '2027-04'],
      ['bulletin_net_paye', '2027-05'],
      ['bulletin_prelevement', '2027-05'],
      ['bulletin_cumul', '2027-05'],
      ['bulletin_net_paye', '2027-06'],
      ['bulletin_prelevement', '2027-06'],
      ['bulletin_cumul', '2027-06'],
      ['employeur_siret', '2027-04'],
      ['employeur_registre', '2027-04'],
    ]);
    const fromJanuary = await checkPayslips([slip('2027-01', 300_000), slip('2027-02', 600_000), slip('2027-03', 900_000)], REGISTRY);
    expect(fromJanuary.every((f) => f.outcome === 'conforme')).toBe(true);
  });

  it('[R533] un net payé, un prélèvement ou un cumul faux : écart sur ce mois seulement', async () => {
    const fs = await checkPayslips([slip('2027-04', 1_200_000), slip('2027-05', 1_500_000, { netPaidCents: 254_570 }), slip('2027-06', 1_800_000)], REGISTRY);
    expect(outcome(fs, 'bulletin_net_paye', '2027-05')).toBe('ecart');
    expect(outcome(fs, 'bulletin_net_paye', '2027-04')).toBe('conforme');
    expect(outcome(fs, 'bulletin_net_paye', '2027-06')).toBe('conforme');
    const pas = await checkPayslips([slip('2027-04', 1_200_000), slip('2027-05', 1_500_000), slip('2027-06', 1_800_000, { taxWithheldCents: 9_000, netPaidCents: 225_000 })], REGISTRY);
    expect(outcome(pas, 'bulletin_prelevement', '2027-06')).toBe('ecart');
    expect(outcome(pas, 'bulletin_net_paye', '2027-06')).toBe('conforme');
    // Un centime d'arrondi est toléré.
    expect(outcome(await checkPayslips([slip('2027-04', 1_200_000, { taxWithheldCents: 9_431, netPaidCents: 224_569 })], REGISTRY), 'bulletin_prelevement', '2027-04')).toBe('conforme');
    const cumul = await checkPayslips([slip('2027-04', 1_200_000), slip('2027-05', 1_600_000), slip('2027-06', 1_900_000)], REGISTRY);
    expect(outcome(cumul, 'bulletin_cumul', '2027-05')).toBe('ecart');
    expect(outcome(cumul, 'bulletin_cumul', '2027-06')).toBe('conforme');
    const jan = await checkPayslips([slip('2027-01', 900_000), slip('2027-02', 1_200_000), slip('2027-03', 1_500_000)], REGISTRY);
    expect(outcome(jan, 'bulletin_cumul', '2027-01')).toBe('ecart');
  });

  it('[R533] trois mois qui se suivent ; un montant manquant rend non vérifiable ; chaque employeur, une fois', async () => {
    expect(outcome(await checkPayslips([slip('2027-02', 0), slip('2027-05', 0), slip('2027-06', 0)], REGISTRY), 'bulletins_mois')).toBe('ecart');
    expect(outcome(await checkPayslips([slip('2027-05', 0), slip('2027-05', 0), slip('2027-06', 0)], REGISTRY), 'bulletins_mois')).toBe('ecart');
    expect(outcome(await checkPayslips([slip('2027-05', 0), slip('2027-06', 0)], REGISTRY), 'bulletins_mois')).toBe('ecart');
    expect(outcome(await checkPayslips([slip('2026-11', 0), slip('2026-12', 0), slip('2027-01', 0)], REGISTRY), 'bulletins_mois')).toBe('conforme');
    expect(outcome(await checkPayslips([slip('2027-05', 0), { ...slip('2027-06', 0), month: 'juin' }], REGISTRY), 'bulletins_mois')).toBe('non_verifiable');
    // Un mois illisible : les contrôles sans date se font quand même, désignés par le rang du bulletin.
    const undated = await checkPayslips([{ ...slip('2027-06', 0), month: undefined, netPaidCents: 99_000 }], REGISTRY);
    expect(undated.find((f) => f.control === 'bulletin_net_paye')).toEqual({ control: 'bulletin_net_paye', outcome: 'ecart', slip: 1 });
    expect(undated.find((f) => f.control === 'bulletin_prelevement')?.outcome).toBe('conforme');
    expect(undated.find((f) => f.control === 'bulletin_cumul')?.outcome).toBe('non_verifiable');
    expect(undated.filter((f) => f.control.startsWith('employeur_')).map((f) => f.outcome)).toEqual(['conforme', 'conforme']);
    const missing = await checkPayslips([slip('2027-04', 1_200_000, { netBeforeTaxCents: undefined, ratePercent: undefined, grossCents: -5 })], REGISTRY);
    expect(outcome(missing, 'bulletin_net_paye', '2027-04')).toBe('non_verifiable');
    expect(outcome(missing, 'bulletin_prelevement', '2027-04')).toBe('non_verifiable');
    expect(outcome(missing, 'bulletin_cumul', '2027-04')).toBe('non_verifiable');
    // Changement d'employeur en mai : le cumul repart chez le nouveau, rien n'est un écart.
    const moved = await checkPayslips([slip('2027-04', 1_200_000), slip('2027-05', 300_000, { siret: OTHER_EMPLOYER }), slip('2027-06', 600_000, { siret: OTHER_EMPLOYER })], REGISTRY);
    expect(moved.some((f) => f.outcome === 'ecart')).toBe(false);
    expect(outcome(moved, 'bulletin_cumul', '2027-06')).toBe('conforme');
    expect(outcome(moved, 'bulletins_mois')).toBe('conforme');
    // Deux employeurs à temps partiel : six bulletins sur trois mois, chaque cumul suivi chez son employeur.
    const both = await checkPayslips(
      [slip('2027-04', 1_200_000), slip('2027-05', 1_500_000), slip('2027-06', 1_800_000), slip('2027-04', 400_000, { siret: OTHER_EMPLOYER }), slip('2027-05', 700_000, { siret: OTHER_EMPLOYER }), slip('2027-06', 1_000_000, { siret: OTHER_EMPLOYER })],
      REGISTRY,
    );
    expect(both.some((f) => f.outcome === 'ecart')).toBe(false);
    expect(both.filter((f) => f.control === 'bulletin_cumul' && f.outcome === 'conforme')).toHaveLength(4);
    // Deux bulletins le même mois se distinguent par leur rang dans ce que l'agent a lu, sans SIRET ni montant.
    expect(both.filter((f) => f.control === 'bulletin_net_paye' && f.month === '2027-05').map((f) => f.slip).sort()).toEqual([2, 5]);
    // Deux bulletins du même employeur le même mois : écart sur les mois.
    expect(outcome(await checkPayslips([slip('2027-04', 0), slip('2027-04', 0), slip('2027-05', 0), slip('2027-06', 0)], REGISTRY), 'bulletins_mois')).toBe('ecart');
    // Deux bulletins le même mois sans SIRET lu : rien ne prouve un doublon.
    const noSiret = { siret: undefined };
    expect(outcome(await checkPayslips([slip('2027-04', 0, noSiret), slip('2027-04', 0, noSiret), slip('2027-05', 0, noSiret), slip('2027-05', 0, noSiret), slip('2027-06', 0, noSiret), slip('2027-06', 0, noSiret)], REGISTRY), 'bulletins_mois')).toBe('non_verifiable');
    expect(outcome(await checkPayslips([slip('2027-04', 0, noSiret), slip('2027-05', 0, noSiret), slip('2027-06', 0, noSiret)], REGISTRY), 'bulletins_mois')).toBe('conforme');
    // Sans SIRET, le cumul ne se suit pas d'un bulletin à l'autre.
    expect(outcome(await checkPayslips([slip('2027-05', 1_500_000, { siret: undefined }), slip('2027-06', 1_800_000, { siret: undefined })], REGISTRY), 'bulletin_cumul', '2027-06')).toBe('non_verifiable');
    const two = await checkPayslips([slip('2027-04', 1_200_000), slip('2027-05', 1_500_000, { siret: OTHER_EMPLOYER }), slip('2027-06', 1_800_000, { siret: CLOSED_EMPLOYER })], REGISTRY);
    // Fermé pendant le mois du bulletin : rien ne dit si c'était avant ou après lui.
    const during = await checkPayslips([slip('2027-03', 0, { siret: CLOSED_EMPLOYER })], REGISTRY);
    expect(outcome(during, 'employeur_registre', '2027-03')).toBe('non_verifiable');
    expect(outcome(await checkPayslips([slip('2027-02', 0, { siret: CLOSED_EMPLOYER })], REGISTRY), 'employeur_registre', '2027-02')).toBe('conforme');
    expect(two.filter((f) => f.control === 'employeur_registre')).toEqual([
      { control: 'employeur_registre', outcome: 'conforme', month: '2027-04', slip: 1 },
      { control: 'employeur_registre', outcome: 'conforme', month: '2027-05', slip: 2 },
      { control: 'employeur_registre', outcome: 'ecart', month: '2027-06', slip: 3 },
    ]);
  });
});

describe('HX47 · des textes qui ne demandent rien d’autre', () => {
  it('[R530] [R534] [R104] chaque texte est fixe, sans chiffre ni conclusion sur la personne, et ne demande que la même pièce', () => {
    for (const [control, texts] of Object.entries(FINDING_TEXTS)) {
      for (const [o, text] of Object.entries(texts)) {
        const where = `${control}/${o}`;
        expect(text.replace(/2D-Doc/g, ''), where).not.toMatch(/\d/);
        expect(text, where).not.toMatch(/fraud|faussaire|menteu|suspect|note|score|classement|solvab|rejet|refuser le candidat/i);
        expect(text, where).not.toMatch(/relev[ée]|bancaire|\bRIB\b|compte|casier|photo|vitale|m[ée]dical|identit/i);
        if (o === 'ecart' && /demander/.test(text)) expect(text, where).toMatch(/cette même pièce/);
      }
    }
  });
});

// ——— Le constat rangé, avec les candidatures de W04 ———

let clock = Date.parse('2027-07-12T08:00:00.000Z');
let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const FACTS: RentalFacts = {
  furnished: false,
  rentCents: 65_000,
  chargesCents: 5_000,
  livingAreaHundredths: 4_250,
  energyClass: 'D',
  finalEnergyKwh: 210,
  buildYear: 1985,
  electricityOver15: false,
  mainRoomHundredths: 1_800,
  ceilingHeightCm: 250,
  localRules: { reference: 'Règlement sanitaire départemental, art. 40', checkedOn: '2027-01-04', compliant: true },
  gas: 'aucune',
  leaseStart: '2027-09-01',
};

async function setup() {
  clock = Date.parse('2027-07-12T08:00:00.000Z');
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const refs = new Set<string>();
  const files = { has: async (r: string) => refs.has(r) };
  const listings = new MisesEnLocation(db, files, journal, { now, newId: uuid });
  const identity = { state: async () => ({ identityVerifiedOn: '2027-07-10' }) };
  const apps = new Candidatures(db, listings, identity, files, journal, { now, newId: uuid });
  const { jwk, sign } = await issuer();
  const controle = new ControleDossiers(db, listings, trustOf(jwk), REGISTRY, journal, { now });
  const network = await store.createNetwork('Réseau Essai');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Essai' });
  const bea = await store.createAgent({ networkId: network.id, firstName: 'Béa', lastName: 'Essai' });
  const owner = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Bailleur', lastName: 'Inventé' });
  const home = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'L-1', kind: 'home', postalCode: '21000' });
  const agent = { role: 'agent' as const, userId: alex.id, networkId: network.id };
  const other = { role: 'agent' as const, userId: bea.id, networkId: network.id };
  const c = await listings.create(agent, { propertyId: home.id, ownerPersonId: owner.id });
  if (!c.ok) throw new Error(c.code);
  const listingId = c.value.listingId;
  await listings.recordFacts(agent, listingId, FACTS);
  /** Une candidature complète ; rend l'identifiant de chaque pièce par sa sorte. */
  const candidate = async (i: number) => {
    const person = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: `Candidat${i}`, lastName: 'Inventé' });
    const a = await apps.apply(agent, listingId, { personId: person.id });
    if (!a.ok) throw new Error(a.code);
    const id = a.value.applicationId;
    for (const sort of ['quittances_loyer', 'contrat_travail', 'bulletins_salaire', 'avis_imposition']) {
      const ref = `location/${listingId}/candidatures/${id}/${uuid()}.pdf`;
      refs.add(ref);
      const r = await apps.addPiece(agent, id, { holder: 'candidat', sort, ref, sha256: 'a'.repeat(64) });
      if (!r.ok) throw new Error(r.code);
    }
    const rows = await db.all<{ id: string; sort: string }>('SELECT id, sort FROM rental_application_pieces WHERE application_id = ?', [id]);
    return { applicationId: id, piece: Object.fromEntries(rows.map((r) => [r.sort, r.id])) as Record<string, string> };
  };
  return { db, journal, apps, listings, controle, agent, other, listingId, candidate, sign };
}

describeWithSqlite('HX47 · le constat rangé, pour l’agent du logement seul', () => {
  it('[R530] [R14] un constat, jamais une note : l’ordre d’arrivée, la complétude et la liste ne changent pas', async () => {
    const t = await setup();
    const first = await t.candidate(1);
    const second = await t.candidate(2);
    const before = await t.apps.list(t.agent, t.listingId);
    const forged = (await code(t.sign)).replace('41' + '31420', '41' + '91420');
    const r = await t.controle.check(t.agent, first.piece.avis_imposition, { twoDDoc: forged, printed: NOTICE });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.value).sort()).toEqual(['checkedAt', 'findings', 'holder', 'pieceId', 'sort', 'version']);
    expect(JSON.stringify(r.value)).not.toMatch(/score|note"|rank|rang|total|grade|level/i);
    expect(r.value.findings[0]).toEqual({ control: 'code_2d_doc', outcome: 'ecart', text: FINDING_TEXTS.code_2d_doc.ecart });
    await t.controle.check(t.agent, second.piece.bulletins_salaire, { payslips: GOOD_SLIPS });
    // Ce que la candidature montre, à l'agent comme à la présentation au propriétaire, n'a pas bougé.
    expect(await t.apps.list(t.agent, t.listingId)).toEqual(before);
    expect(before.ok && before.value.map((a) => a.arrival)).toEqual([1, 2]);
  });

  it('[R530] [R16] seul l’agent du logement contrôle et lit ; seules trois sortes se contrôlent ; un nouveau contrôle s’ajoute', async () => {
    const t = await setup();
    const a = await t.candidate(1);
    expect(await t.controle.check(t.other, a.piece.contrat_travail, { siret: EMPLOYER })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.controle.read(t.other, a.applicationId)).toMatchObject({ ok: false, rule: 'R16' });
    // Ni la direction : le constat est à l'agent du logement seul, et le refus est au journal.
    const dir = { role: 'direction' as const, userId: 'dir-1', networkId: t.agent.networkId };
    expect(await t.controle.check(dir, a.piece.contrat_travail, { siret: EMPLOYER })).toEqual({ ok: false, rule: 'R16', code: 'agent_only' });
    expect(await t.controle.read(dir, a.applicationId)).toEqual({ ok: false, rule: 'R16', code: 'agent_only' });
    expect(await t.db.all("SELECT 1 FROM journal WHERE type = 'acces.refuse' AND data LIKE '%agent_only%'")).toHaveLength(2);
    expect(await t.controle.check(t.agent, 'inconnue', { siret: EMPLOYER })).toMatchObject({ ok: false });
    expect(await t.controle.check(t.agent, a.piece.quittances_loyer, {})).toEqual({ ok: false, rule: null, code: 'not_checkable' });
    expect(await t.controle.check(t.agent, a.piece.contrat_travail, 'texte')).toEqual({ ok: false, rule: null, code: 'bad_read' });
    expect(await t.controle.check(t.agent, a.piece.bulletins_salaire, { payslips: [] })).toEqual({ ok: false, rule: null, code: 'bad_read' });
    expect(await t.controle.check(t.agent, a.piece.avis_imposition, { printed: 'x' })).toEqual({ ok: false, rule: null, code: 'bad_read' });
    expect(await t.controle.check(t.agent, a.piece.contrat_travail, { siret: EMPLOYER, signedOn: '2028-01-01' })).toEqual({ ok: false, rule: null, code: 'bad_read' });
    const v1 = await t.controle.check(t.agent, a.piece.contrat_travail, { siret: CLOSED_EMPLOYER, signedOn: '2027-04-01' });
    expect(v1.ok && v1.value.findings.map((f) => f.outcome)).toEqual(['conforme', 'ecart']);
    const v2 = await t.controle.check(t.agent, a.piece.contrat_travail, { siret: EMPLOYER });
    expect(v1.ok && v1.value.version).toBe(1);
    expect(v2.ok && v2.value.version).toBe(2);
    const read = await t.controle.read(t.agent, a.applicationId);
    expect(read.ok && read.value.map((p) => [p.sort, p.version, p.findings.map((f) => f.outcome)])).toEqual([['contrat_travail', 2, ['conforme', 'conforme']]]);
    expect(await t.db.all('SELECT version FROM rental_piece_findings ORDER BY version')).toHaveLength(2);
    // La lecture du constat est au journal avant d'être rendue [R16].
    expect(await t.db.all("SELECT data FROM journal WHERE type = 'location.lue' AND subject = ?", [`rental_application:${a.applicationId}`])).toEqual([{ data: JSON.stringify({ rule: 'R16', what: 'piece_findings' }) }]);
    // Rien ne s'efface ni ne se réécrit [R17].
    await expect(t.db.run('DELETE FROM rental_piece_findings')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run("UPDATE rental_piece_findings SET findings = '[]'")).rejects.toThrow(/rien ne se réécrit/);
  });

  it('[R534] [R13] aucune valeur lue n’est rangée ni écrite au journal : ni revenu, ni référence, ni SIRET, ni montant', async () => {
    const t = await setup();
    const a = await t.candidate(1);
    await t.controle.check(t.agent, a.piece.avis_imposition, { twoDDoc: await code(t.sign), printed: NOTICE });
    await t.controle.check(t.agent, a.piece.bulletins_salaire, { payslips: GOOD_SLIPS });
    await t.controle.check(t.agent, a.piece.contrat_travail, { siret: EMPLOYER });
    const stored = JSON.stringify(await t.db.all('SELECT * FROM rental_piece_findings'));
    const journal = JSON.stringify(await t.db.all("SELECT * FROM journal WHERE type = 'location.piece_controlee'"));
    expect((await t.db.all("SELECT 1 FROM journal WHERE type = 'location.piece_controlee'")).length).toBe(3);
    for (const secret of ['31420', '31 420', '2771A23456789', EMPLOYER, '224570', '230000', '1800000', 'Candidat']) {
      expect(stored, secret).not.toContain(secret);
      expect(journal, secret).not.toContain(secret);
    }
    // Le journal nomme les contrôles et leurs résultats, rattachés à la candidature.
    expect(journal).toContain(`rental_application:${a.applicationId}`);
    expect(journal).toContain('code_2d_doc');
  });

  it('[R104] les sortes contrôlées sont de la liste officielle', () => {
    for (const sort of ['avis_imposition', 'bulletins_salaire', 'contrat_travail']) expect(Object.prototype.hasOwnProperty.call(OFFICIAL_PIECES, sort), sort).toBe(true);
  });
});
