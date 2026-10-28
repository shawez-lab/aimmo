import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { conformite, verifyChain, type Viewer } from '../src/index.ts';
import { RegistreOffres } from '../src/offres/index.ts';
import { setupAnnonce } from './annonces-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Clients, offres et responsable inventés.
const NOW = new Date('2027-03-10T10:00:00.000Z');
const PDF = new TextEncoder().encode('%PDF-test piece inventee');
const NO = { politicallyExposed: false, cashPayment: false, legalEntity: false, remoteRelation: false };

class FakeVault implements conformite.VaultStorage {
  private n = 0;
  async put(networkId: string): Promise<string> {
    return `coffre/${networkId}/${++this.n}`;
  }
}

async function setup() {
  const t = await setupAnnonce();
  t.setClock(NOW);
  const coffre = new conformite.CoffreConformite(t.db, t.acces, new FakeVault(), t.journal, { now: t.now });
  const risque = new conformite.FicheRisque(t.db, t.acces, coffre, t.journal, { now: t.now });
  const offres = new RegistreOffres(t.db, t.acces, t.journal, { now: t.now });
  const buyer = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Acheteur', lastName: 'Exemple' });
  const as = (role: string, userId: string): Viewer => ({ role, userId, networkId: t.network.id }) as Viewer;
  const offer = async (amountEur: number, buyerPersonId = buyer.id) => {
    const r = await offres.record(t.agent, t.propertyId, {
      buyerPersonId, amountEur, conditions: [], validUntil: '2027-03-20', downPaymentEur: amountEur, loanEur: 0,
      signedRef: 'offres/0b6f1d2e-1111-4a2b-8c3d-000000000001.pdf', receivedAt: '2027-03-10T09:00:00.000Z',
    });
    if (!r.ok) throw new Error(r.code);
    return `offer:${r.value.id}`;
  };
  return { ...t, coffre, risque, buyerId: buyer.id, offer, conformite: as('compliance', 'conformite-1'), partner: as('partner', 'partenaire-1') };
}

describe('L02 · grille de risque', () => {
  it('[R91] la grille écrite et datée calcule toujours la même fiche, chaque critère avec sa source', () => {
    const grid = conformite.RISK_GRID_TRIAL;
    const a = conformite.computeRisk(grid, 'offre', { declarations: NO, identityVerifiedOn: '2027-03-09', offerAmountEur: 250000 });
    expect(a.level).toBe('faible');
    expect(a.criteria.map((c) => [c.key, c.source, c.level])).toEqual([
      ['personne_politiquement_exposee', 'declare', 'faible'],
      ['paiement_comptant', 'declare', 'faible'],
      ['societe', 'declare', 'faible'],
      ['relation_a_distance', 'declare', 'faible'],
      ['identite_verifiee', 'document', 'faible'],
      ['montant_offre', 'base', 'faible'],
    ]);
    expect(conformite.computeRisk(grid, 'offre', { declarations: NO, identityVerifiedOn: '2027-03-09', offerAmountEur: 250000 })).toEqual(a);
    expect(conformite.computeRisk(grid, 'mandat', { declarations: { ...NO, legalEntity: true }, identityVerifiedOn: '2027-03-09', offerAmountEur: null }).level).toBe('moyen');
    expect(conformite.computeRisk(grid, 'mandat', { declarations: { ...NO, politicallyExposed: true }, identityVerifiedOn: null, offerAmountEur: null }).level).toBe('eleve');
    expect(conformite.computeRisk(grid, 'mandat', { declarations: NO, identityVerifiedOn: null, offerAmountEur: null }).criteria.find((c) => c.key === 'identite_verifiee')).toMatchObject({ observed: 'aucune pièce valide', level: 'moyen' });
    const big = conformite.computeRisk(grid, 'offre', { declarations: NO, identityVerifiedOn: '2027-03-09', offerAmountEur: 1_000_000 });
    expect(big.criteria.at(-1)).toMatchObject({ observed: '1 000 000 €', level: 'moyen' });
    expect(grid).toMatchObject({ version: 'essai-2026-10-28', datedOn: '2026-10-28', trial: true });
  });

  it('[R91] [R23] la fiche n’appelle aucune IA ni aucun envoi : ses seules sources sont la base, le coffre et le journal', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/conformite/risque.ts', import.meta.url)), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort();
    expect(imports).toEqual(['../acces/acces.ts', '../acces/droits.ts', '../db/sql.ts', '../envoi/horaires.ts', '../journal/journal.ts', '../journal/types.ts', './coffre.ts']);
    expect(source).not.toMatch(/fetch\(|Math\.random/);
  });
});

describeWithSqlite('L02 · fiche de risque de chaque client', () => {
  it('[R91] l’agent prépare la fiche d’un vendeur à l’entrée en relation ; elle ne vaut rien tant qu’elle n’est pas validée, et le dit', async () => {
    const t = await setup();
    const r = await t.risque.prepare(t.agent, t.personId, { relation: 'mandat', caseRef: `mandate:${t.mandateId}`, declarations: NO });
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    expect(r.sheet).toMatchObject({ relation: 'mandat', gridVersion: 'essai-2026-10-28', trialGrid: true, status: 'non_validee', validation: null, computedLevel: 'moyen', preparedBy: `agent:${t.alexId}` });
    // Pas de pièce au coffre (D03 seul ne vaut pas le coffre) : l'identité compte « moyen ».
    expect(r.sheet.criteria.find((c) => c.key === 'identite_verifiee')).toMatchObject({ source: 'document', observed: 'aucune pièce valide' });
    expect(r.sheet.notice).toContain('ne vaut rien tant que le responsable de la conformité ne l’a pas validée');
    expect(r.sheet.notice).toContain('ne trie aucun client et ne refuse rien');
  });

  it('[R91] le même client donne la même fiche avec les mêmes règles, à la même empreinte', async () => {
    const t = await setup();
    await t.coffre.deposit(t.agent, t.personId, { kind: 'carte_identite', content: PDF, contentType: 'application/pdf', verifiedOn: '2027-03-09', validUntil: '2031-01-01' });
    const a = await t.risque.prepare(t.agent, t.personId, { relation: 'mandat', declarations: NO });
    t.setClock(new Date('2027-03-10T15:00:00.000Z'));
    const b = await t.risque.prepare(t.conformite, t.personId, { relation: 'mandat', declarations: { ...NO } });
    if (!a.ok || !b.ok) throw new Error('fiche refusée');
    expect(b.sheet.sheetId).not.toBe(a.sheet.sheetId);
    expect(b.sheet.criteria).toEqual(a.sheet.criteria);
    expect(b.sheet.computedLevel).toBe('faible');
    expect(b.sheet.fingerprint).toBe(a.sheet.fingerprint);
    const c = await t.risque.prepare(t.agent, t.personId, { relation: 'mandat', declarations: { ...NO, cashPayment: true } });
    expect(c.ok && c.sheet.fingerprint).not.toBe(a.sheet.fingerprint);
    expect(c.ok && c.sheet.computedLevel).toBe('eleve');
  });

  it('[R91] pour un acquéreur, le montant vient du registre des offres, jamais d’une saisie', async () => {
    const t = await setup();
    const small = await t.offer(205000);
    const big = await t.offer(1_200_000);
    const s = await t.risque.prepare(t.agent, t.buyerId, { relation: 'offre', caseRef: small, declarations: NO });
    const b = await t.risque.prepare(t.agent, t.buyerId, { relation: 'offre', caseRef: big, declarations: NO });
    expect(s.ok && s.sheet.criteria.at(-1)).toEqual({ key: 'montant_offre', label: 'Montant de l’offre (seuil 1 000 000 €)', source: 'base', observed: '205 000 €', level: 'faible' });
    expect(b.ok && b.sheet.criteria.at(-1)).toMatchObject({ observed: '1 200 000 €', level: 'moyen' });
    // L'offre d'un autre client ne compte pas pour celui-ci.
    const other = await t.risque.prepare(t.agent, t.personId, { relation: 'offre', caseRef: small, declarations: NO });
    expect(other.ok && other.sheet.criteria.at(-1)).toMatchObject({ observed: 'offre absente du registre', level: 'moyen' });
    // Un montant saisi n'existe pas : seules les quatre déclarations entrent.
    expect(await t.risque.prepare(t.agent, t.buyerId, { relation: 'offre', caseRef: small, declarations: { ...NO, amountEur: 10 } })).toEqual({ ok: false, rule: 'R23', code: 'unknown_field' });
    expect(await t.risque.prepare(t.agent, t.buyerId, { relation: 'offre', declarations: NO })).toEqual({ ok: false, rule: null, code: 'bad_case' });
    // Le mandat cité doit être celui du client.
    expect(await t.risque.prepare(t.agent, t.buyerId, { relation: 'mandat', caseRef: `mandate:${t.mandateId}`, declarations: NO })).toEqual({ ok: false, rule: null, code: 'unknown_case' });
    expect(await t.risque.prepare(t.agent, t.personId, { relation: 'mandat', caseRef: 'Léa Exemple', declarations: NO })).toEqual({ ok: false, rule: null, code: 'bad_case' });
  });

  it('[R23] aucun critère n’est tiré d’une donnée sensible : tout champ hors des quatre déclarations est refusé', async () => {
    const t = await setup();
    for (const extra of [{ nationalite: 'x' }, { sante: 'x' }, { religion: 'x' }, { situationFamiliale: 'x' }, { note: 'texte libre' }]) {
      expect(await t.risque.prepare(t.agent, t.personId, { relation: 'mandat', declarations: { ...NO, ...extra } })).toEqual({ ok: false, rule: 'R23', code: 'unknown_field' });
    }
    expect(await t.risque.prepare(t.agent, t.personId, { relation: 'mandat', declarations: { ...NO, cashPayment: 'oui' } })).toEqual({ ok: false, rule: null, code: 'missing_declaration' });
    expect(await t.risque.prepare(t.agent, t.personId, { relation: 'mandat', declarations: { politicallyExposed: false } })).toEqual({ ok: false, rule: null, code: 'missing_declaration' });
    expect(await t.risque.prepare(t.agent, t.personId, { relation: 'location', declarations: NO })).toEqual({ ok: false, rule: null, code: 'bad_relation' });
    expect(await t.db.first('SELECT id FROM risk_sheets')).toBeNull();
  });

  it('[R91] seul le responsable valide, avec son nom et sa date, ou corrige avec sa raison ; une seule fois', async () => {
    const t = await setup();
    const r = await t.risque.prepare(t.agent, t.personId, { relation: 'mandat', declarations: NO });
    if (!r.ok) throw new Error(r.code);
    for (const viewer of [t.agent, t.sam, t.direction, t.partner]) {
      expect(await t.risque.validate(viewer, r.sheet.sheetId, { validatorName: 'Camille Conforme' })).toEqual({ ok: false, rule: 'R91', code: 'role' });
    }
    expect(await t.risque.validate(t.conformite, r.sheet.sheetId, { validatorName: ' ' })).toEqual({ ok: false, rule: null, code: 'missing_name' });
    expect(await t.risque.validate(t.conformite, r.sheet.sheetId, { validatorName: 'Camille Conforme', level: 'faible' })).toEqual({ ok: false, rule: null, code: 'missing_reason' });
    expect(await t.risque.validate(t.conformite, r.sheet.sheetId, { validatorName: 'Camille Conforme', level: 'critique' })).toEqual({ ok: false, rule: null, code: 'bad_level' });
    const v = await t.risque.validate(t.conformite, r.sheet.sheetId, { validatorName: 'Camille Conforme', level: 'faible', reason: 'Pièce vue en agence, dépôt au coffre en cours.' });
    expect(v).toMatchObject({ ok: true, sheet: { status: 'validee', computedLevel: 'moyen', validation: { decision: 'corrigee', level: 'faible', validatorName: 'Camille Conforme', validatedOn: '2027-03-10' } } });
    expect(v.ok && v.sheet.notice).not.toContain('ne vaut rien');
    expect(await t.risque.validate(t.conformite, r.sheet.sheetId, { validatorName: 'Camille Conforme' })).toEqual({ ok: false, rule: null, code: 'already_validated' });
    const r2 = await t.risque.prepare(t.agent, t.personId, { relation: 'mandat', declarations: NO });
    if (!r2.ok) throw new Error(r2.code);
    expect(await t.risque.validate(t.conformite, r2.sheet.sheetId, { validatorName: 'Camille Conforme' })).toMatchObject({ ok: true, sheet: { validation: { decision: 'validee', level: 'moyen', reason: null } } });
    // Chaque validation au journal : la fiche, la décision, le niveau calculé et le niveau retenu, sans nom en clair.
    const validated = (await t.journal.all()).filter((e) => e.type === 'risque.validee');
    expect(validated.map((e) => e.data)).toEqual([
      { rule: 'R91', sheet: `risk_sheet:${r.sheet.sheetId}`, decision: 'corrigee', computed: 'moyen', level: 'faible' },
      { rule: 'R91', sheet: `risk_sheet:${r2.sheet.sheetId}`, decision: 'validee', computed: 'moyen', level: 'moyen' },
    ]);
    const text = JSON.stringify(validated);
    for (const word of ['Camille', 'Léa', 'Exemple', 'Pièce vue']) expect(text).not.toContain(word);
    expect(await verifyChain(await t.journal.all())).toMatchObject({ ok: true });
    // L'agent relit ses fiches, validées ou non, sans jamais pouvoir les valider.
    const list = await t.risque.list(t.agent, t.personId);
    expect(list.ok && list.value.map((s) => s.status)).toEqual(['validee', 'validee']);
  });

  it('[R91] [R14] la fiche ne trie aucun client et ne refuse rien : un risque élevé laisse tout passer, et aucune liste par niveau n’existe', async () => {
    const t = await setup();
    const r = await t.risque.prepare(t.agent, t.buyerId, { relation: 'offre', caseRef: await t.offer(205000), declarations: { politicallyExposed: true, cashPayment: true, legalEntity: true, remoteRelation: true } });
    expect(r.ok && r.sheet.computedLevel).toBe('eleve');
    // L'agent continue : une autre offre s'enregistre, une autre fiche se prépare.
    expect(await t.offer(210000)).toMatch(/^offer:/);
    expect((await t.risque.prepare(t.agent, t.buyerId, { relation: 'mandat', declarations: NO })).ok).toBe(true);
    const methods = Object.getOwnPropertyNames(conformite.FicheRisque.prototype).filter((m) => m !== 'constructor');
    expect(methods.sort()).toEqual(['actor', 'list', 'prepare', 'readable', 'refuse', 'replay', 'toSheet', 'validate', 'validationOf'].sort());
    const source = readFileSync(fileURLToPath(new URL('../src/conformite/risque.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/ORDER BY[^`'"]*level/i);
  });

  it('[R91] [R16] la direction, un partenaire ou un autre agent ne lisent aucune fiche ; chaque refus au journal sans donnée en clair', async () => {
    const t = await setup();
    const r = await t.risque.prepare(t.agent, t.personId, { relation: 'mandat', declarations: NO });
    if (!r.ok) throw new Error(r.code);
    expect(await t.risque.list(t.direction, t.personId)).toEqual({ ok: false, rule: 'R91', code: 'role' });
    expect(await t.risque.list(t.partner, t.personId)).toEqual({ ok: false, rule: 'R91', code: 'role' });
    expect(await t.risque.list(t.sam, t.personId)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.risque.prepare(t.direction, t.personId, { relation: 'mandat', declarations: NO })).toEqual({ ok: false, rule: 'R91', code: 'role' });
    expect(await t.risque.replay(t.agent, r.sheet.sheetId)).toEqual({ ok: false, rule: 'R91', code: 'role' });
    const events = await t.journal.all();
    const mine = events.filter((e) => e.type.startsWith('risque.') || (e.type === 'acces.refuse' && (e.data as { kind?: string }).kind === 'risk_sheet'));
    expect(mine.map((e) => e.type)).toEqual(['risque.prepare', 'acces.refuse', 'acces.refuse', 'acces.refuse', 'acces.refuse']);
    const text = JSON.stringify(mine);
    for (const word of ['Léa', 'Exemple', 'Alex']) expect(text).not.toContain(word);
    expect(await verifyChain(await t.journal.all())).toMatchObject({ ok: true });
  });

  it('[R17] rien ne s’efface ni ne change : ni la fiche, ni sa validation', async () => {
    const t = await setup();
    const r = await t.risque.prepare(t.agent, t.personId, { relation: 'mandat', declarations: NO });
    if (!r.ok) throw new Error(r.code);
    await t.risque.validate(t.conformite, r.sheet.sheetId, { validatorName: 'Camille Conforme' });
    await expect(t.db.run("UPDATE risk_sheets SET level = 'faible'")).rejects.toThrow();
    await expect(t.db.run('DELETE FROM risk_sheets')).rejects.toThrow();
    await expect(t.db.run("UPDATE risk_validations SET level = 'eleve'")).rejects.toThrow();
    await expect(t.db.run('DELETE FROM risk_validations')).rejects.toThrow();
  });

  it('[R91] Jamais vu : le responsable rejoue chaque fiche d’un geste, même calcul et même empreinte, même après un nouveau dépôt au coffre', async () => {
    const t = await setup();
    const r = await t.risque.prepare(t.agent, t.buyerId, { relation: 'offre', caseRef: await t.offer(205000), declarations: NO });
    if (!r.ok) throw new Error(r.code);
    // Les sources bougent après coup : la fiche reste celle du jour de sa préparation.
    await t.coffre.deposit(t.agent, t.buyerId, { kind: 'passeport', content: PDF, contentType: 'application/pdf', verifiedOn: '2027-03-10' });
    expect(await t.risque.replay(t.conformite, r.sheet.sheetId)).toEqual({ ok: true, same: true, fingerprint: r.sheet.fingerprint, differences: [] });
    expect((await t.journal.all()).some((e) => e.type === 'risque.rejouee' && (e.data as { same?: boolean }).same === true)).toBe(true);
    expect(await t.risque.replay(t.conformite, 'inconnue')).toEqual({ ok: false, rule: 'R91', code: 'unknown' });
  });
});
