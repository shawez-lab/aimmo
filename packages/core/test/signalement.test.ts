import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ControleEnvois, DecisionEnvoi, FakeChannel, FicheUnique, SqlSendJournal, conformite, verifyChain, type Channel, type Viewer } from '../src/index.ts';
import { RegistreOffres } from '../src/offres/index.ts';
import { setupAnnonce } from './annonces-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Clients, dossier, agents et responsable inventés. Un mardi de mars, à 10 h à Paris.
const NOW = new Date('2027-03-09T09:00:00.000Z');
const LONG_AGO = new Date('2026-01-01T00:00:00.000Z');
const NOTE = 'Paiement proposé en espèces, sans explication.';

async function setup() {
  const t = await setupAnnonce();
  t.setClock(NOW);
  const signalement = new conformite.SignalementSoupcon(t.db, t.acces, t.journal, { now: t.now });
  const as = (role: string, userId: string): Viewer => ({ role, userId, networkId: t.network.id }) as Viewer;
  // Le contrôle central des envois, avec un faux canal par canal.
  const fiche = new FicheUnique(t.db, t.store, { now: t.now });
  const decisions = new DecisionEnvoi(t.db, t.store, fiche, { now: t.now });
  const outbox = (['email', 'sms'] as Channel[]).map((c) => new FakeChannel(c));
  const controle = new ControleEnvois(t.db, fiche, decisions, { channels: outbox, journal: new SqlSendJournal(t.db), budget: { allows: async () => false }, now: t.now });
  await t.store.addIdentifier({ networkId: t.network.id, personId: t.personId, kind: 'email', value: 'lea.exemple@example.test' });
  await t.store.addConsent({ networkId: t.network.id, personId: t.personId, purpose: 'follow_up', channel: 'email', proof: 'formulaire test', givenAt: LONG_AGO });
  const mandateRef = `mandate:${t.mandateId}`;
  return { ...t, signalement, controle, outbox, mandateRef, conformite: as('compliance', 'conformite-1'), partner: as('partner', 'partenaire-1') };
}

describeWithSqlite('L05 · signaler au responsable', () => {
  it('[R94] [R16] seul le responsable voit le signalement ; l’agent qui l’a fait voit seulement « transmis »', async () => {
    const t = await setup();
    expect(await t.signalement.report(t.agent, t.mandateRef, { note: NOTE })).toEqual({ ok: true, status: 'transmis' });
    // Un autre agent, la direction, un partenaire : refusés, sans savoir si un signalement existe.
    for (const viewer of [t.sam, t.direction, t.partner]) {
      const r = await t.signalement.report(viewer, t.mandateRef, { note: NOTE });
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain('transmis');
      expect(await t.signalement.list(viewer)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    }
    expect(await t.signalement.list(t.agent)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    // Le responsable le voit sans délai, avec la note de l'agent, en attente de sa décision.
    const list = await t.signalement.list(t.conformite);
    expect(list).toMatchObject({ ok: true, value: [{ caseRef: t.mandateRef, personId: t.personId, note: NOTE, reportedBy: `agent:${t.alexId}`, decision: null }] });
    expect(list.ok && list.value[0]!.lines).toBeGreaterThan(3);
    // Entrées refusées.
    expect(await t.signalement.report(t.agent, 'mandate:x', { note: NOTE })).toEqual({ ok: false, rule: null, code: 'bad_case' });
    expect(await t.signalement.report(t.agent, t.mandateRef, { note: ' ' })).toEqual({ ok: false, rule: null, code: 'bad_note' });
    expect(await t.signalement.report(t.agent, 'offer:00000000-0000-4000-8000-000000000000', { note: NOTE })).toEqual({ ok: false, rule: null, code: 'unknown_case' });
  });

  it('[R94] [R17] le dossier est figé : le responsable voit tout changement et toute pièce disparue', async () => {
    const t = await setup();
    await t.signalement.report(t.agent, t.mandateRef, { note: NOTE });
    const id = (await t.signalement.list(t.conformite)).ok ? ((await t.signalement.list(t.conformite)) as { value: conformite.SuspicionReport[] }).value[0]!.reportId : '';
    expect(await t.signalement.checkFrozen(t.conformite, id)).toEqual({ ok: true, value: { intact: true, changed: [], missing: [], added: [] } });
    // Une ligne ajoutée après ne change pas la copie figée ; une ligne changée, si.
    await t.amend(210000);
    const after = await t.signalement.checkFrozen(t.conformite, id);
    expect(after).toMatchObject({ ok: true, value: { intact: true, changed: [], missing: [] } });
    expect(after.ok && after.value.added.map((a) => a.table)).toEqual(expect.arrayContaining(['documents', 'signed_amendments']));
    // Une modification forcée en base, protections retirées : la copie figée la voit.
    await t.db.exec('DROP TRIGGER IF EXISTS mandates_fige');
    await t.db.run("UPDATE mandates SET source_detail = 'modifié' WHERE id = ?", [t.mandateId]);
    expect(await t.signalement.checkFrozen(t.conformite, id)).toMatchObject({ ok: true, value: { intact: false, changed: [{ table: 'mandates', key: t.mandateId }], missing: [] } });
    // Une pièce du coffre effacée de force est dite disparue.
    const piece = (await t.db.first<{ id: string }>('SELECT id FROM compliance_vault_pieces WHERE person_id = ?', [t.personId]))!.id;
    await t.db.exec('DROP TRIGGER IF EXISTS compliance_vault_pieces_sans_effacement');
    await t.db.run('DELETE FROM compliance_vault_pieces WHERE id = ?', [piece]);
    expect(await t.signalement.checkFrozen(t.conformite, id)).toMatchObject({ ok: true, value: { intact: false, missing: [{ table: 'compliance_vault_pieces', key: piece }] } });
    expect(await t.signalement.checkFrozen(t.agent, id)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    // Rien ne s'efface ni ne change du signalement.
    await expect(t.db.run('DELETE FROM suspicion_reports')).rejects.toThrow('signalement gardé');
    await expect(t.db.run("UPDATE suspicion_reports SET note = 'x'")).rejects.toThrow('signalement gardé');
  });

  it('[R94] [R17] une offre ou un dossier de vente figent aussi le mandat, le vendeur et leur conformité', async () => {
    const t = await setup();
    const buyer = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Acheteur', lastName: 'Exemple' });
    const offer = await new RegistreOffres(t.db, t.acces, t.journal, { now: t.now }).record(t.agent, t.propertyId, {
      buyerPersonId: buyer.id, amountEur: 195000, conditions: [], validUntil: '2027-03-20', downPaymentEur: 195000, loanEur: 0,
      signedRef: 'offres/0b6f1d2e-1111-4a2b-8c3d-000000000001.pdf', receivedAt: '2027-03-09T08:00:00.000Z',
    });
    if (!offer.ok) throw new Error(offer.code);
    const fileId = '0b6f1d2e-9999-4a2b-8c3d-000000000009';
    await t.db.run(
      'INSERT INTO sale_files (id, network_id, property_id, offer_id, buyer_person_id, amount_eur, opened_at, opened_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [fileId, t.network.id, t.propertyId, offer.value.id, buyer.id, 195000, NOW.toISOString(), `agent:${t.alexId}`],
    );
    const sellerPiece = (await t.db.first<{ id: string }>('SELECT id FROM compliance_vault_pieces WHERE person_id = ?', [t.personId]))!.id;
    for (const ref of [`offer:${offer.value.id}`, `sale_file:${fileId}`]) {
      expect(await t.signalement.report(t.agent, ref, { note: NOTE })).toEqual({ ok: true, status: 'transmis' });
    }
    const list = await t.signalement.list(t.conformite);
    if (!list.ok) throw new Error(list.code);
    const onOffer = list.value.find((r) => r.caseRef.startsWith('offer:'));
    const onFile = list.value.find((r) => r.caseRef.startsWith('sale_file:'));
    expect(onOffer).toMatchObject({ caseRef: `offer:${offer.value.id}`, personId: buyer.id });
    expect(onFile).toMatchObject({ caseRef: `sale_file:${fileId}`, personId: buyer.id });
    for (const r of [onOffer!, onFile!]) expect(await t.signalement.checkFrozen(t.conformite, r.reportId)).toMatchObject({ ok: true, value: { intact: true } });
    // L'offre d'origine changée de force : le dossier de vente le voit, comme l'offre.
    await t.db.exec('DROP TRIGGER IF EXISTS offer_register_sans_modification');
    await t.db.run('UPDATE offer_register SET amount_eur = 150000 WHERE id = ?', [offer.value.id]);
    for (const r of [onOffer!, onFile!]) {
      expect(await t.signalement.checkFrozen(t.conformite, r.reportId)).toMatchObject({ ok: true, value: { intact: false, changed: [{ table: 'offer_register', key: offer.value.id }] } });
    }
    // La pièce du vendeur effacée de force : le dossier de vente le voit aussi.
    await t.db.exec('DROP TRIGGER IF EXISTS compliance_vault_pieces_sans_effacement');
    await t.db.run('DELETE FROM compliance_vault_pieces WHERE id = ?', [sellerPiece]);
    const check = await t.signalement.checkFrozen(t.conformite, onFile!.reportId);
    expect(check.ok && check.value.missing).toContainEqual({ table: 'compliance_vault_pieces', key: sellerPiece });
  });

  it('[R94] le responsable décide seul, une seule fois, avec sa raison, son nom et sa date ; tout au journal sans nom', async () => {
    const t = await setup();
    await t.signalement.report(t.agent, t.mandateRef, { note: NOTE });
    const list = await t.signalement.list(t.conformite);
    if (!list.ok) throw new Error(list.code);
    const id = list.value[0]!.reportId;
    for (const viewer of [t.agent, t.direction, t.partner]) {
      expect(await t.signalement.decide(viewer, id, { decision: 'declaration_faite', reason: 'Soupçon confirmé', validatorName: 'Camille Conforme' })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    }
    expect(await t.signalement.decide(t.conformite, id, { decision: 'autre', reason: 'x', validatorName: 'Camille Conforme' })).toEqual({ ok: false, rule: null, code: 'bad_decision' });
    expect(await t.signalement.decide(t.conformite, id, { decision: 'declaration_faite', reason: 'x', validatorName: ' ' })).toEqual({ ok: false, rule: null, code: 'missing_name' });
    const d = await t.signalement.decide(t.conformite, id, { decision: 'declaration_faite', reason: 'Soupçon confirmé', validatorName: 'Camille Conforme' });
    expect(d).toMatchObject({ ok: true, value: { decision: { decision: 'declaration_faite', validatorName: 'Camille Conforme', decidedOn: '2027-03-09' } } });
    expect(await t.signalement.decide(t.conformite, id, { decision: 'pas_de_declaration', reason: 'x', validatorName: 'Camille Conforme' })).toEqual({ ok: false, rule: null, code: 'already_decided' });
    const events = (await t.journal.all()).filter((e) => e.type.startsWith('conformite.signalement'));
    expect(events.map((e) => [e.type, e.subject, e.data.rule])).toEqual([
      ['conformite.signalement', `suspicion_report:${id}`, 'R94'],
      ['conformite.signalement_decision', `suspicion_report:${id}`, 'R94'],
    ]);
    // Le journal de la fiche du client ne dit rien du signalement.
    expect(JSON.stringify(await t.journal.bySubject(`person:${t.personId}`))).not.toMatch(/signalement|suspicion/);
    const text = JSON.stringify(await t.journal.all());
    for (const word of ['Camille', 'espèces', 'Soupçon']) expect(text).not.toContain(word);
    expect(await verifyChain(await t.journal.all())).toMatchObject({ ok: true });
  });

  it('[R94] Jamais vu : le client reçoit exactement les mêmes textes, avec ou sans signalement', async () => {
    const run = async (withReport: boolean) => {
      const t = await setup();
      if (withReport) expect(await t.signalement.report(t.agent, t.mandateRef, { note: NOTE })).toMatchObject({ ok: true });
      const sent = [];
      for (const [subject, text] of [
        ['relance:vente-1', 'Bonjour Léa, votre agent vous rappelle cette semaine pour faire le point.'],
        ['relance:vente-1', 'Bonjour Léa, votre agent vous rappelle cette semaine pour faire le point.'],
        ['point:semaine-10', 'Bonjour Léa, voici le point de la semaine sur votre bien.'],
      ] as const) {
        const r = await t.controle.send({ networkId: t.network.id, agentId: t.alexId, personId: t.personId, channel: 'email', kind: 'follow_up', subject, fallbackTexts: [text] });
        sent.push([r.status, r.rule ?? null, r.body ?? null]);
      }
      await t.publication.sync(t.network.id, t.propertyId);
      return {
        sent,
        delivered: t.outbox.map((c) => c.sent.map((m) => [c.channel, m.to, m.body])),
        portals: t.channels.map((c) => c.received.map((p) => JSON.stringify({ ...p, version: undefined, id: undefined }))),
      };
    };
    const without = await run(false);
    const withIt = await run(true);
    expect(without.delivered.flat().length).toBeGreaterThan(0);
    expect(withIt).toEqual(without);
  });

  it('[R94] un signalement rangé sans son événement est repris au journal, une seule fois', async () => {
    const t = await setup();
    let failing = true;
    const flaky = {
      append: async (e: Parameters<typeof t.journal.append>[0]) => {
        if (failing && e.type === 'conformite.signalement') throw new Error('journal en panne');
        return t.journal.append(e);
      },
      last: () => t.journal.last(),
      all: () => t.journal.all(),
      bySubject: (s: string) => t.journal.bySubject(s),
      byPeriod: (a: string, b: string) => t.journal.byPeriod(a, b),
    };
    const s = new conformite.SignalementSoupcon(t.db, t.acces, flaky, { now: t.now });
    await expect(s.report(t.agent, t.mandateRef, { note: NOTE })).rejects.toThrow('journal en panne');
    failing = false;
    await s.list(t.conformite);
    await s.list(t.conformite);
    expect((await t.journal.all()).filter((e) => e.type === 'conformite.signalement')).toHaveLength(1);
  });
});

describe('L05 · rien ne lit le signalement hors de son code', () => {
  it('[R94] ni le contrôle des envois ni aucun autre code ne lit les tables du signalement', () => {
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
    const readers = files.filter((f) => /suspicion_(reports|decisions)|SignalementSoupcon|signalement\.ts/.test(readFileSync(f, 'utf8'))).map((f) => f.split(/[\\/]/).slice(-2).join('/'));
    // Le registre des traitements (L06) nomme les tables sans les lire ; l'index de la conformité exporte le module.
    expect(readers.sort()).toEqual(['conformite/index.ts', 'conformite/registre-traitements.ts', 'conformite/signalement.ts']);
  });
});
