import { expect, it } from 'vitest';
import type { EnergyClass, PropertySheet } from '../src/annonces/index.ts';
import { auditClasses, energyAuditCase, expectedPieces } from '../src/dossiers/index.ts';
import { expiredPieces } from '../src/dossiers/acte.ts';
import { reminderText } from '../src/dossiers/relances.ts';
import { PIECES } from '../src/dossiers/pieces.ts';
import { SELLER_PIECES } from '../src/espaces/sources-vendeur.ts';
import { setupDossier } from './dossiers-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// AU010 · L'audit énergétique devient une pièce obligatoire du dossier quand la vente y est soumise
// (art. L126-28-1 du code de la construction et de l'habitation, lu le 2026-11-18).

const energy = (energyClass: EnergyClass, diagnosedOn = '2026-05-10') => ({ energyClass, climateClass: energyClass, annualCostMinEur: 2100, annualCostMaxEur: 2900, costReferenceYear: 2023, diagnosedOn });

const sheet = (patch: { energy?: PropertySheet['energy']; coownership?: PropertySheet['coownership'] } = {}): PropertySheet => ({
  characteristics: { bedrooms: 3, floor: null, floorsTotal: 2, buildYear: 1975, heating: 'fioul', outdoor: ['jardin'], landM2: 600, parkingSpaces: null, elevator: false },
  energy: 'energy' in patch ? patch.energy! : energy('F'),
  coownership: 'coownership' in patch ? patch.coownership! : { isCoownership: false },
  risks: null,
  media: [],
});

const hasAudit = (kind: 'home' | 'building' | 'commercial' | 'land', s: PropertySheet | null, year = 2026) => expectedPieces(kind, s, year)?.pieces.some((p) => p.piece === 'audit_energetique') ?? false;

it('[R60] AU010 · une maison classée F, E ou G hors copropriété demande l’audit énergétique, avec sa raison', () => {
  for (const c of ['E', 'F', 'G'] as const) {
    expect(expectedPieces('home', sheet({ energy: energy(c) }), 2026)?.pieces).toContainEqual({ piece: 'audit_energetique', side: 'vendeur', reason: 'classe_energie_soumise_audit' });
    // Un immeuble d'habitation d'un seul propriétaire (monopropriété) aussi.
    expect(hasAudit('building', sheet({ energy: energy(c) }))).toBe(true);
  }
  for (const c of ['A', 'B', 'C', 'D'] as const) expect(hasAudit('home', sheet({ energy: energy(c) }))).toBe(false);
  expect(expectedPieces('home', sheet({ energy: energy('G') }), 2026)?.unknown).toEqual([]);
});

it('[R60] AU010 · le calendrier légal : F et G depuis 2023, E depuis 2025, D à partir de 2034', () => {
  expect(auditClasses(2022)).toEqual([]);
  expect(auditClasses(2023)).toEqual(['F', 'G']);
  expect(auditClasses(2024)).toEqual(['F', 'G']);
  expect(auditClasses(2025)).toEqual(['E', 'F', 'G']);
  expect(auditClasses(2033)).toEqual(['E', 'F', 'G']);
  expect(auditClasses(2034)).toEqual(['D', 'E', 'F', 'G']);
  expect(hasAudit('home', sheet({ energy: energy('E') }), 2024)).toBe(false);
  expect(hasAudit('home', sheet({ energy: energy('E') }), 2025)).toBe(true);
  expect(hasAudit('home', sheet({ energy: energy('D') }), 2033)).toBe(false);
  expect(hasAudit('home', sheet({ energy: energy('D') }), 2034)).toBe(true);
});

it('[R60] AU010 · un lot de copropriété, un local commercial ou un terrain ne sont pas soumis ; une copropriété inconnue l’est', () => {
  expect(hasAudit('home', sheet({ energy: energy('G'), coownership: { isCoownership: true, lots: 12, annualChargesEur: 1500, proceedings: false } }))).toBe(false);
  expect(hasAudit('building', sheet({ energy: energy('G'), coownership: { isCoownership: true, lots: 6, annualChargesEur: 900, proceedings: false } }))).toBe(false);
  expect(hasAudit('commercial', sheet({ energy: energy('G') }))).toBe(false);
  expect(hasAudit('land', null)).toBe(false);
  // Copropriété inconnue : l'audit est demandé par prudence, et le dossier reste incomplet tant que la fiche ne la dit pas.
  const unknownCopro = expectedPieces('home', sheet({ energy: energy('F'), coownership: null }), 2026);
  expect(unknownCopro?.pieces).toContainEqual({ piece: 'audit_energetique', side: 'vendeur', reason: 'copropriete_inconnue' });
  expect(unknownCopro?.unknown).toEqual(['copropriete']);
});

it('[R60] AU010 · une classe énergie inconnue, ou lue sur un DPE d’avant juillet 2021, interdit le verdict « complet »', () => {
  expect(energyAuditCase('home', sheet({ energy: null }), 2026)).toEqual({ case: 'inconnu' });
  expect(expectedPieces('home', sheet({ energy: null }), 2026)?.unknown).toEqual(['classe_energie']);
  // Un DPE de l'ancienne méthode : sa classe ne compte pas, même si elle dit A.
  expect(energyAuditCase('home', sheet({ energy: energy('A', '2021-06-30') }), 2026)).toEqual({ case: 'inconnu' });
  expect(energyAuditCase('home', sheet({ energy: energy('F', '2021-07-01') }), 2026)).toEqual({ case: 'requis', energyClass: 'F' });
  // Sans fiche du tout, c'est la fiche entière qui manque, déjà dite.
  expect(expectedPieces('home', null, 2026)?.unknown).toEqual(['fiche_bien']);
  expect(energyAuditCase('home', null, 2026)).toEqual({ case: 'inconnu' });
  expect(energyAuditCase('commercial', null, 2026)).toEqual({ case: 'non_requis' });
  // Un lot de copropriété n'en dépend pas : pas de classe à demander.
  expect(expectedPieces('home', sheet({ energy: null, coownership: { isCoownership: true, lots: 8, annualChargesEur: 1200, proceedings: false } }), 2026)?.unknown).toEqual([]);
});

it('[R60] AU010 · l’audit vaut 5 ans au jour de l’acte', () => {
  const line = (issuedOn: string) => [{ piece: 'audit_energetique' as const, received: { issuedOn } }];
  expect(expiredPieces(line('2022-03-15'), '2027-03-14')).toEqual([]);
  expect(expiredPieces(line('2022-03-15'), '2027-03-15')).toEqual(['audit_energetique']);
});

it('AU010 · la relance de la pièce la nomme en français simple', () => {
  expect(reminderText('Camille', 'audit_energetique')).toContain("l'audit énergétique");
});

it('AU010 · l’audit reçu se voit dans l’espace du vendeur, comme chaque pièce que les règles lui demandent', () => {
  expect(SELLER_PIECES.has('audit_energetique')).toBe(true);
  // Toutes les pièces du vendeur, et aucune de l'acquéreur.
  expect([...PIECES].filter((p) => !SELLER_PIECES.has(p))).toEqual(['fiche_renseignements_acquereur']);
});

describeWithSqlite('AU010 · audit énergétique au dossier de vente', () => {
  it('[R60] constat de l’audit : une maison classée F n’est plus « complète » sans audit, et le devient avec lui', async () => {
    const t = await setupDossier('maison');
    const current = await t.db.first<{ data: string; version: number }>('SELECT data, version FROM property_sheets WHERE property_id = ? ORDER BY version DESC LIMIT 1', [t.propertyId]);
    const data = JSON.parse(current!.data) as PropertySheet;
    await t.db.run('INSERT INTO property_sheets (id, property_id, network_id, version, data, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      'v-classe-f', t.propertyId, t.network.id, current!.version + 1, JSON.stringify({ ...data, energy: energy('F', '2026-09-01'), coownership: { isCoownership: false } }), 'agent:test', t.now().toISOString(),
    ]);
    const first = await t.pieces.status(t.agent, t.fileId);
    if (!first.ok) throw new Error(first.code);
    expect(first.value.missing).toContain('audit_energetique');
    for (const piece of first.value.missing.filter((p) => p !== 'audit_energetique')) {
      expect((await t.pieces.add(t.agent, t.fileId, { piece, ref: t.upload(), issuedOn: '2027-02-15' })).ok).toBe(true);
    }
    await t.verifyBuyer();
    // Tout le reste est reçu et l'identité vérifiée : sans l'audit, jamais « complet ».
    expect(await t.pieces.status(t.agent, t.fileId)).toMatchObject({ ok: true, value: { missing: ['audit_energetique'], identity: 'verifiee', complete: false } });
    expect(await t.pieces.add(t.agent, t.fileId, { piece: 'audit_energetique', ref: t.upload(), issuedOn: '2026-09-02' })).toMatchObject({ ok: true, value: { missing: [], complete: true } });
  });

  it('[R60] la maison du jeu, classée hors des classes soumises, n’attend pas d’audit, qui est alors refusé comme non attendu', async () => {
    const t = await setupDossier('maison');
    const s = await t.pieces.status(t.agent, t.fileId);
    expect(s.ok && s.value.lines.map((l) => l.piece)).not.toContain('audit_energetique');
    expect(await t.pieces.add(t.agent, t.fileId, { piece: 'audit_energetique', ref: t.upload(), issuedOn: '2027-02-15' })).toEqual({ ok: false, rule: null, code: 'not_expected' });
  });
});
