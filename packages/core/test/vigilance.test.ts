import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { conformite, verifyChain, type Viewer } from '../src/index.ts';
import { RegistreOffres } from '../src/offres/index.ts';
import { setupAnnonce } from './annonces-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Clients, offres, avis de valeur et responsable inventés.
const NOW = new Date('2027-03-10T10:00:00.000Z');
const NO = { politicallyExposed: false, cashPayment: false, legalEntity: false, remoteRelation: false };
const TRIAL = conformite.VIGILANCE_SETTINGS_TRIAL;
const RANGE = { lowEur: 180000, highEur: 210000, validatedOn: '2027-02-01', ref: 'valuation:v-1' };

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
  const vigilance = new conformite.VigilanceRenforcee(t.db, t.acces, t.journal, { now: t.now });
  const offres = new RegistreOffres(t.db, t.acces, t.journal, { now: t.now });
  const buyer = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Acheteur', lastName: 'Exemple' });
  const as = (role: string, userId: string): Viewer => ({ role, userId, networkId: t.network.id }) as Viewer;
  const offer = async (amountEur: number) => {
    const r = await offres.record(t.agent, t.propertyId, {
      buyerPersonId: buyer.id, amountEur, conditions: [], validUntil: '2027-03-20', downPaymentEur: amountEur, loanEur: 0,
      signedRef: 'offres/0b6f1d2e-1111-4a2b-8c3d-000000000001.pdf', receivedAt: '2027-03-10T09:00:00.000Z',
    });
    if (!r.ok) throw new Error(r.code);
    return `offer:${r.value.id}`;
  };
  // Un avis de valeur validé du bien : 180 000 € à 210 000 €.
  const valuation = async (low = 180000, high = 210000, id = 'avis-0000-0001') => {
    await t.db.run(
      `INSERT INTO valuation_reports (id, network_id, property_id, agent_id, status, computed, computed_low, computed_high, text, text_by, created_at, updated_at, validated_by, validated_at)
       VALUES (?, ?, ?, ?, 'validated', '{}', ?, ?, 'avis inventé', 'agent', ?, ?, ?, ?)`,
      [id, t.network.id, t.propertyId, t.alexId, low, high, '2027-02-01T09:00:00.000Z', '2027-02-01T09:00:00.000Z', `agent:${t.alexId}`, '2027-02-01T09:00:00.000Z'],
    );
  };
  return { ...t, risque, vigilance, buyerId: buyer.id, offer, valuation, conformite: as('compliance', 'conformite-1'), partner: as('partner', 'partenaire-1') };
}

describe('L04 · règles de vigilance renforcée', () => {
  it('[R93] [R10] chaque alerte cite sa règle et ses chiffres ; mêmes faits, mêmes alertes', () => {
    const facts = { priceEur: 260000, valuation: RANGE, declared: null };
    const a = conformite.computeVigilance(TRIAL, facts);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      key: 'prix_ecarte_valeur',
      rule: 'R93',
      figures: { priceEur: 260000, lowEur: 180000, highEur: 210000, gapPercent: 23, direction: 'au-dessus', thresholdPercent: 20, valuationOn: '2027-02-01' },
    });
    expect(a[0]!.text).toBe('Prix écarté de la valeur estimée : 260 000 €, soit 23 % au-dessus de la fourchette 180 000 € à 210 000 € de l’avis de valeur validé le 2027-02-01 ; écart réglé : 20 %.');
    expect(conformite.computeVigilance(TRIAL, { ...facts })).toEqual(a);
  });

  it('[R93] le prix n’alerte qu’au-delà de l’écart réglé, au-dessus comme au-dessous', () => {
    const at = (priceEur: number) => conformite.computeVigilance(TRIAL, { priceEur, valuation: RANGE, declared: null }).map((x) => x.key);
    expect(at(252000)).toEqual([]); // 210 000 + 20 % pile
    expect(at(252001)).toEqual(['prix_ecarte_valeur']);
    expect(at(144000)).toEqual([]); // 180 000 − 20 % pile
    expect(at(143999)).toEqual(['prix_ecarte_valeur']);
    expect(conformite.computeVigilance(TRIAL, { priceEur: 100000, valuation: RANGE, declared: null })[0]!.figures).toMatchObject({ direction: 'au-dessous', gapPercent: 44 });
    // Sans avis validé, la règle du prix se tait : rien n'est inventé.
    expect(conformite.computeVigilance(TRIAL, { priceEur: 900000, valuation: null, declared: null })).toEqual([]);
  });

  it('[R93] montant au seuil réglé, personne politiquement exposée et paiement comptant déclarés', () => {
    const declared = { politicallyExposed: true, cashPayment: true, preparedOn: '2027-03-10', ref: 'risk_sheet:r-1' };
    const a = conformite.computeVigilance(TRIAL, { priceEur: 1_000_000, valuation: null, declared });
    expect(a.map((x) => x.key)).toEqual(['montant_inhabituel', 'personne_politiquement_exposee', 'paiement_comptant']);
    expect(a[0]!.text).toBe('Montant inhabituel : 1 000 000 €, au seuil réglé de 1 000 000 € ou au-delà.');
    expect(a[1]!.text).toBe('Personne politiquement exposée déclarée sur la fiche de risque du 2027-03-10.');
    expect(conformite.computeVigilance(TRIAL, { priceEur: 999999, valuation: null, declared: { ...declared, politicallyExposed: false, cashPayment: false } })).toEqual([]);
  });

  it('[R93] [R15] les règles n’appellent ni IA ni envoi', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/conformite/vigilance.ts', import.meta.url)), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort();
    expect(imports).toEqual(['../acces/acces.ts', '../acces/droits.ts', '../db/sql.ts', '../documents/conditions.ts', '../envoi/horaires.ts', '../journal/journal.ts', '../journal/types.ts']);
    expect(source).not.toMatch(/fetch\(|Math\.random/);
  });

  it('[R14] [R93] l’alerte ne bloque rien : aucun autre fichier du code ne lit les tables de vigilance', () => {
    const roots = ['../src', '../../api/src'].map((r) => fileURLToPath(new URL(r, import.meta.url)));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    roots.forEach(walk);
    const readers = files.filter((f) => /vigilance_(alerts|decisions|settings)/.test(readFileSync(f, 'utf8'))).map((f) => f.split(/[\\/]/).slice(-2).join('/'));
    expect(readers).toEqual(['conformite/vigilance.ts']);
  });
});

describeWithSqlite('L04 · vigilance renforcée et origine des fonds', () => {
  it('[R93] [R10] une offre écartée de l’avis de valeur alerte le responsable, avec les chiffres de la base', async () => {
    const t = await setup();
    await t.valuation();
    const ref = await t.offer(300000);
    const r = await t.vigilance.examine(t.conformite, ref);
    if (!r.ok || !r.alerts) throw new Error('examen refusé');
    expect(r.alerts).toHaveLength(1);
    expect(r.alerts[0]).toMatchObject({
      caseRef: ref, personId: t.buyerId, key: 'prix_ecarte_valeur', rule: 'R93', settingsVersion: 'essai-2026-10-28', decision: null,
      figures: { priceEur: 300000, lowEur: 180000, highEur: 210000, valuation: 'valuation:avis-0000-0001', gapPercent: 42 },
    });
    expect(r.alerts[0]!.notice).toBe('L’alerte ne bloque ni ne refuse rien : la décision reste au responsable de la conformité.');
    // Une offre dans la fourchette n'alerte pas, et ne prépare aucune demande.
    const calm = await t.vigilance.examine(t.conformite, await t.offer(200000));
    expect(calm).toEqual({ ok: true, fundsRequest: null, alerts: [] });
  });

  it('[R93] mêmes données, mêmes alertes : un nouvel examen n’en ajoute aucune', async () => {
    const t = await setup();
    await t.valuation();
    const ref = await t.offer(1_200_000);
    const a = await t.vigilance.examine(t.agent, ref);
    t.setClock(new Date('2027-03-11T10:00:00.000Z'));
    const b = await t.vigilance.examine(t.conformite, ref);
    const c = await t.vigilance.examine(t.conformite, ref);
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (!b.ok || !c.ok) return;
    expect(b.alerts!.map((x) => x.key)).toEqual(['prix_ecarte_valeur', 'montant_inhabituel']);
    expect(c.alerts).toEqual(b.alerts);
    expect(await t.db.all('SELECT id FROM vigilance_alerts')).toHaveLength(2);
    expect((await t.journal.all()).filter((e) => e.type === 'vigilance.alerte')).toHaveLength(2);
  });

  it('[R93] le mandat : son prix en vigueur, et les déclarations de la fiche de risque du vendeur', async () => {
    const t = await setup();
    await t.valuation(100000, 120000);
    await t.risque.prepare(t.agent, t.personId, { relation: 'mandat', caseRef: `mandate:${t.mandateId}`, declarations: { ...NO, politicallyExposed: true, cashPayment: true } });
    const r = await t.vigilance.examine(t.conformite, `mandate:${t.mandateId}`);
    if (!r.ok || !r.alerts) throw new Error('examen refusé');
    expect(r.alerts.map((a) => a.key)).toEqual(['prix_ecarte_valeur', 'personne_politiquement_exposee', 'paiement_comptant']);
    expect(r.alerts[0]!.figures).toMatchObject({ lowEur: 100000, highEur: 120000, direction: 'au-dessus' });
    expect(r.alerts[1]!.figures).toMatchObject({ preparedOn: '2027-03-10' });
    expect(String(r.alerts[1]!.figures.sheet)).toMatch(/^risk_sheet:/);
  });

  it('[R93] l’agent reçoit la demande d’origine des fonds décidée par le responsable, neutre, sans l’alerte ni ses chiffres ; rien n’est envoyé', async () => {
    const t = await setup();
    await t.valuation();
    const ref = await t.offer(400000);
    // Tant que le responsable n'a rien décidé, l'agent ne reçoit rien.
    expect(await t.vigilance.examine(t.agent, ref)).toEqual({ ok: true, fundsRequest: null });
    const seen = await t.vigilance.examine(t.conformite, ref);
    const id = seen.ok ? seen.alerts![0]!.alertId : '';
    await t.vigilance.decide(t.conformite, id, { decision: 'origine_des_fonds_demandee', reason: 'apport à justifier', validatorName: 'Camille Conforme' });
    const r = await t.vigilance.examine(t.agent, ref);
    expect(r).toEqual({ ok: true, fundsRequest: { caseRef: ref, text: conformite.FUNDS_REQUEST_TEXT, documents: conformite.FUNDS_REQUEST_DOCUMENTS, sent: false } });
    // Une alerte classée par le responsable ne donne aucune demande.
    const other = await t.offer(1_500_000);
    const o = await t.vigilance.examine(t.conformite, other);
    for (const a of o.ok ? o.alerts! : []) await t.vigilance.decide(t.conformite, a.alertId, { decision: 'classee', reason: 'vente d’un bien justifiée', validatorName: 'Camille Conforme' });
    expect(await t.vigilance.examine(t.agent, other)).toEqual({ ok: true, fundsRequest: null });
    // La direction, qui lit le journal d'une fiche, n'y trouve ni alerte ni décision.
    const j = await t.acces.readJournalOf(t.direction, t.buyerId);
    expect(j.ok && j.value.filter((e) => e.type.startsWith('vigilance.'))).toEqual([]);
    expect(conformite.FUNDS_REQUEST_TEXT).not.toMatch(/\d|alerte|vigilance|soupçon|exposée|comptant|écart|R93/i);
    // L'agent ne lit pas la liste des alertes, ne décide pas, ne règle rien.
    expect(await t.vigilance.list(t.agent)).toEqual({ ok: false, rule: 'R93', code: 'role' });
  });

  it('[R93] [R16] ni un autre agent, ni la direction, ni un partenaire, ni l’autre partie ne voient rien ; chaque refus au journal', async () => {
    const t = await setup();
    await t.valuation();
    const ref = await t.offer(400000);
    expect(await t.vigilance.examine(t.sam, ref)).toMatchObject({ ok: false });
    for (const viewer of [t.direction, t.partner, { ...t.agent, role: 'client' } as unknown as Viewer]) {
      expect(await t.vigilance.examine(viewer, ref)).toEqual({ ok: false, rule: 'R93', code: 'role' });
      expect(await t.vigilance.list(viewer)).toEqual({ ok: false, rule: 'R93', code: 'role' });
    }
    expect(await t.db.first('SELECT id FROM vigilance_alerts')).toBeNull();
    const refused = (await t.journal.all()).filter((e) => e.type === 'acces.refuse');
    expect(refused.length).toBeGreaterThanOrEqual(6);
    expect(JSON.stringify(refused)).not.toMatch(/Acheteur|400000/);
    expect(await t.vigilance.examine(t.conformite, 'offer:inconnue-0001')).toEqual({ ok: false, rule: null, code: 'unknown_case' });
    expect(await t.vigilance.examine(t.conformite, 'Acheteur Exemple')).toEqual({ ok: false, rule: null, code: 'bad_case' });
  });

  it('[R14] [R93] l’alerte ne refuse rien : l’offre reste au registre, la suivante s’inscrit ; seul le responsable décide, une fois', async () => {
    const t = await setup();
    await t.valuation();
    const ref = await t.offer(400000);
    const r = await t.vigilance.examine(t.conformite, ref);
    if (!r.ok || !r.alerts) throw new Error('examen refusé');
    expect(await t.db.first('SELECT amount_eur FROM offer_register WHERE id = ?', [ref.slice('offer:'.length)])).toEqual({ amount_eur: 400000 });
    await expect(t.offer(410000)).resolves.toMatch(/^offer:/);
    const id = r.alerts[0]!.alertId;
    for (const viewer of [t.agent, t.direction, t.partner]) {
      expect(await t.vigilance.decide(viewer, id, { decision: 'classee', reason: 'prix justifié', validatorName: 'Camille Conforme' })).toEqual({ ok: false, rule: 'R93', code: 'role' });
    }
    expect(await t.vigilance.decide(t.conformite, id, { decision: 'refuser_le_client', reason: 'x', validatorName: 'Camille Conforme' })).toEqual({ ok: false, rule: null, code: 'bad_decision' });
    expect(await t.vigilance.decide(t.conformite, id, { decision: 'classee', reason: ' ', validatorName: 'Camille Conforme' })).toEqual({ ok: false, rule: null, code: 'missing_reason' });
    expect(await t.vigilance.decide(t.conformite, id, { decision: 'classee', reason: 'x', validatorName: '' })).toEqual({ ok: false, rule: null, code: 'missing_name' });
    const d = await t.vigilance.decide(t.conformite, id, { decision: 'origine_des_fonds_demandee', reason: 'apport à justifier', validatorName: 'Camille Conforme' });
    expect(d.ok && d.alert.decision).toEqual({ decision: 'origine_des_fonds_demandee', reason: 'apport à justifier', validatorName: 'Camille Conforme', decidedOn: '2027-03-10' });
    expect(await t.vigilance.decide(t.conformite, id, { decision: 'classee', reason: 'x', validatorName: 'Camille Conforme' })).toEqual({ ok: false, rule: null, code: 'already_decided' });
    await expect(t.db.run('DELETE FROM vigilance_alerts')).rejects.toThrow();
    await expect(t.db.run("UPDATE vigilance_decisions SET decision = 'classee'")).rejects.toThrow();
    const events = (await t.journal.all()).filter((e) => e.type.startsWith('vigilance.'));
    expect(events.map((e) => e.type)).toEqual(['vigilance.alerte', 'vigilance.decision']);
    expect(JSON.stringify(events)).not.toMatch(/Camille|apport|400000/);
    expect(await verifyChain(await t.journal.all())).toMatchObject({ ok: true });
  });

  it('[R93] le responsable règle les seuils ; les nouvelles alertes portent le nouveau réglage, les anciennes gardent le leur', async () => {
    const t = await setup();
    await t.valuation();
    const ref = await t.offer(240000);
    expect((await t.vigilance.examine(t.conformite, ref)).ok && (await t.vigilance.list(t.conformite))).toEqual({ ok: true, value: [] });
    expect(await t.vigilance.setSettings(t.agent, { priceGapPercent: 10, amountThresholdEur: 500000, validatorName: 'Camille Conforme' })).toEqual({ ok: false, rule: 'R93', code: 'role' });
    expect(await t.vigilance.setSettings(t.conformite, { priceGapPercent: 0, amountThresholdEur: 500000, validatorName: 'Camille Conforme' })).toEqual({ ok: false, rule: null, code: 'bad_gap' });
    expect(await t.vigilance.setSettings(t.conformite, { priceGapPercent: 10, amountThresholdEur: -1, validatorName: 'Camille Conforme' })).toEqual({ ok: false, rule: null, code: 'bad_amount' });
    const s = await t.vigilance.setSettings(t.conformite, { priceGapPercent: 10, amountThresholdEur: 500000, validatorName: 'Camille Conforme' });
    expect(s).toEqual({ ok: true, settings: { version: 'reglage-1', trial: false, priceGapPercent: 10, amountThresholdEur: 500000, setOn: '2027-03-10', validatorName: 'Camille Conforme' } });
    const r = await t.vigilance.examine(t.conformite, ref);
    expect(r.ok && r.alerts!.map((a) => [a.key, a.settingsVersion, a.figures.thresholdPercent])).toEqual([['prix_ecarte_valeur', 'reglage-1', 10]]);
    await t.vigilance.setSettings(t.conformite, { priceGapPercent: 5, amountThresholdEur: 500000, validatorName: 'Camille Conforme' });
    const again = await t.vigilance.examine(t.conformite, ref);
    expect(again.ok && again.alerts!.map((a) => a.settingsVersion)).toEqual(['reglage-1', 'reglage-2']);
  });
});
