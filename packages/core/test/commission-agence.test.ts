import { expect, it } from 'vitest';
import { ActeVente, Echeancier, PiecesDossier } from '../src/dossiers/index.ts';
import { DossiersVente, TransmissionOffres } from '../src/offres/index.ts';
import { partage } from '../src/index.ts';
import { Commissions } from '../src/pilotage/commissions.ts';
import { Factures } from '../src/pilotage/factures.ts';
import type { Viewer } from '../src/acces/droits.ts';
import { FakePieceStore, PROOF, lieuConnu } from './dossiers-jeu.ts';
import { identiteAuCoffre } from './identite-coffre.ts';
import { setupOffre } from './offres-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Tout est inventé : le bien en vente du jeu de M07, une agence partenaire, son bon à 40 % et une vente à 10 000 €.
const BON = 'preuves/0b6f1d2e-8989-4a2b-8c3d-000000000001.pdf';
const ACT_PROOF = 'preuves/0b6f1d2e-8989-4a2b-8c3d-000000000003.pdf';
const at9 = (day: string) => new Date(`${day}T08:00:00.000Z`);

describeWithSqlite('HX59 · la part de l’agence partenaire déduite de la commission', () => {
  async function setup(attach: 'avant' | 'apres' | 'jamais' = 'avant', options: ConstructorParameters<typeof Commissions>[3] = {}) {
    const t = await setupOffre();
    await t.annonces.validate(t.agent, t.draftId);
    await t.publication.sync(t.network.id, t.propertyId);
    const storage = new FakePieceStore();
    for (const ref of [BON, ACT_PROOF, PROOF]) storage.refs.add(ref);
    const p = new partage.PartageAgences(t.db, t.acces, t.journal, storage, { now: t.now });
    const reg = await p.registerAgency(t.direction, { businessName: 'Agence du Lac Fictive', cardNumber: 'CPI 2101 2027 000 000 011' });
    if (!reg.ok) throw new Error(reg.code);
    const agency: Viewer = { role: 'partner', networkId: t.network.id, userId: reg.value.id };
    const shared = await p.shareProperty(t.agent, t.propertyId, reg.value.id);
    if (!shared.ok) throw new Error(shared.code);
    const shareId = shared.value.shareId;
    expect(await p.proposeDelegation(t.agent, shareId, { partnerShareBp: 4_000 })).toMatchObject({ ok: true });
    expect(await p.acceptDelegation(agency, shareId)).toMatchObject({ ok: true });
    expect(await p.recordSigned(t.agent, shareId, { proofRef: BON, mandateAllowsDelegation: true })).toMatchObject({ ok: true });
    // L'offre de l'acquéreur de l'agence, acceptée ; le dossier s'ouvre.
    const transmission = new TransmissionOffres(t.db, t.acces, t.journal, { now: t.now });
    const offer = await t.record();
    await transmission.transmit(t.agent, offer.id, { via: 'telephone' });
    t.setClock(new Date('2027-03-01T12:00:00.000Z'));
    const r = await transmission.respond(t.agent, offer.id, { outcome: 'acceptee', proofRef: PROOF, respondedAt: '2027-03-01T11:00:00.000Z' });
    if (!r.ok) throw new Error(r.code);
    const dossiers = new DossiersVente(t.db, t.acces, t.journal, { now: t.now });
    const opened = await dossiers.open(t.agent, offer.id);
    if (!opened.ok) throw new Error(opened.code);
    const fileId = opened.value.id;
    if (attach === 'avant') expect(await p.attachFile(t.agent, shareId, fileId)).toMatchObject({ ok: true });
    // Grille à 70 % pour l'agent, compromis signé.
    const c = new Commissions(t.db, t.acces, t.journal, { now: t.now, ...options });
    expect(await c.setGrid(t.direction, { validFrom: '2027-03-01', defaultRateBp: 7000 })).toMatchObject({ ok: true });
    await identiteAuCoffre({ db: t.db, acces: t.acces, journal: t.journal, now: t.now }, t.agent, t.buyerId, { piece: 'passeport', seenAt: new Date('2027-03-01T11:30:00.000Z') });
    expect(await dossiers.startCompromis(t.agent, fileId)).toMatchObject({ ok: true });
    t.setClock(at9('2027-03-11'));
    await new Echeancier(t.db, t.acces, t.journal, { now: t.now }).record(t.agent, fileId, { kind: 'compromis_signe', day: '2027-03-10', proofRef: PROOF });
    expect(await c.sync(t.network.id)).toEqual({ planned: 1, due: 0 });
    /** Les pièces, puis l'acte. */
    const acte = async () => {
      const pieces = new PiecesDossier(t.db, t.acces, t.journal, storage, { now: t.now });
      await lieuConnu(t, t.propertyId);
      const s = await pieces.status(t.agent, fileId);
      if (!s.ok) throw new Error(s.code);
      let n = 0;
      for (const piece of s.value.missing) {
        n += 1;
        const ref = `dossiers/${fileId}/0b6f1d2e-5656-4a2b-8c3d-${String(n).padStart(12, '0')}.pdf`;
        storage.refs.add(ref);
        await pieces.add(t.agent, fileId, { piece, ref, issuedOn: '2027-03-05' });
      }
      t.setClock(at9('2027-06-11'));
      const done = await new ActeVente(t.db, t.acces, t.journal, storage, { now: t.now }).record(t.agent, fileId, { signedOn: '2027-06-10', proofRef: ACT_PROOF });
      if (!done.ok) throw new Error(done.code);
      expect(await c.sync(t.network.id)).toEqual({ planned: 0, due: 1 });
    };
    return { ...t, p, c, agency, shareId, fileId, acte };
  }

  it('[R235] [R69] bon à 40 % et 10 000 € d’honoraires : l’agence 4 000 €, puis la grille sur le reste ; tout fait 10 000 €', async () => {
    const t = await setup('avant');
    const list = await t.c.list(t.direction);
    if (!list.ok) throw new Error();
    expect(list.value[0]!.shares).toEqual([
      { kind: 'reseau', beneficiaryId: null, reason: null, amountCents: 180_000 },
      { kind: 'agent', beneficiaryId: t.alexId, reason: null, amountCents: 420_000 },
      { kind: 'agence', beneficiaryId: `agence:${t.agency.userId}`, reason: null, amountCents: 400_000 },
    ]);
    expect(list.value[0]!.shares.reduce((a, s) => a + s.amountCents, 0)).toBe(1_000_000);
    expect(list.value[0]!.feeCents).toBe(1_000_000);
    // L'agent ne lit que sa part, jamais celle de l'agence.
    const mine = await t.c.list(t.agent);
    expect(mine.ok && mine.value[0]!.shares).toEqual([{ kind: 'agent', beneficiaryId: t.alexId, reason: null, amountCents: 420_000 }]);
    // La part de l'agence ne se saisit pas, ni ne change, par la base.
    await expect(t.db.run('UPDATE commission_agency_shares SET amount_cents = 1')).rejects.toThrow(/rien ne change/);
    // AU091 · une régularisation d'honoraires n'y touche pas : la part et le relevé de l'agence restent ceux du compromis [R678].
    expect(await t.c.regularize(t.direction, t.fileId, { reason: 'Avenant de baisse signé avec le vendeur.' })).toEqual({ ok: false, rule: 'R678', code: 'agence_partenaire' });
    await t.acte();
    // Le relevé de l'acte retrouve la même part.
    expect(await t.p.statement(t.agency, t.shareId)).toMatchObject({ ok: true, value: { partnerCents: 400_000, ownCents: 600_000 } });
  });

  it('[R235] [R69] avec un partage entre agents et une prime de parrainage : tout se calcule sur ce qui reste après l’agence', async () => {
    const seen: number[] = [];
    const t = await setup('avant', {
      partages: { of: async () => [{ agentId: 'agent-binome', ratioBp: 5_000, reason: 'binome' as const }] },
      primes: {
        of: async (_n: string, _a: string, networkShareCents: number) => {
          seen.push(networkShareCents);
          return { parrainId: 'agent-parrain', amountCents: Math.floor(networkShareCents / 10) };
        },
      },
    });
    // 10 000 € : l'agence 4 000 € ; sur 6 000 €, l'agent 4 200 € dont 2 100 € au binôme ; réseau 1 800 € dont 180 € au parrain.
    expect(seen).toEqual([180_000]);
    const list = await t.c.list(t.direction);
    if (!list.ok) throw new Error();
    expect(list.value[0]!.shares.map((s) => [s.kind, s.beneficiaryId, s.amountCents])).toEqual([
      ['reseau', null, 162_000],
      ['agent', t.alexId, 210_000],
      ['partage', 'agent-binome', 210_000],
      ['parrainage', 'agent-parrain', 18_000],
      ['agence', `agence:${t.agency.userId}`, 400_000],
    ]);
    expect(list.value[0]!.shares.reduce((a, s) => a + s.amountCents, 0)).toBe(1_000_000);
    expect(list.value[0]!.status).toBe('prevue');
  });

  it('[R235] aucune facture de reversement ne porte la part de l’agence ; la facture d’honoraires reste entière', async () => {
    const t = await setup('avant');
    await t.acte();
    const f = new Factures(t.db, t.acces, t.journal, { now: t.now });
    expect(await f.prepare(t.network.id)).toBe(2);
    const drafts = await f.drafts(t.direction);
    if (!drafts.ok) throw new Error();
    expect(drafts.value.map((d) => [d.kind, d.issuer, d.amountCents])).toEqual([
      ['honoraires', 'reseau', 1_000_000],
      ['reversement', `agent:${t.alexId}`, 420_000],
    ]);
    expect(JSON.stringify(drafts.value)).not.toContain(t.agency.userId);
  });

  it('[R255] [R235] le jour de l’acte, les factures partent seules, part de l’agence déjà déduite : honoraires entiers, reversement sur le reste', async () => {
    const t = await setup('avant');
    await t.acte();
    const f = new Factures(t.db, t.acces, t.journal, { now: t.now });
    await f.prepare(t.network.id);
    expect(await f.issueOnDeed(t.network.id)).toBe(2);
    const list = await f.list(t.direction);
    if (!list.ok) throw new Error();
    expect(list.value.map((v) => [v.content.kind, v.issuer, v.content.ttcCents])).toEqual([
      ['honoraires', 'reseau', 1_000_000],
      ['reversement', `agent:${t.alexId}`, 420_000],
    ]);
    // Le reversement de l'agent, la part du réseau et celle de l'agence font les honoraires facturés au client [R69].
    const shares = await t.c.list(t.direction);
    if (!shares.ok) throw new Error();
    const reseau = shares.value[0]!.shares.find((s) => s.kind === 'reseau')!.amountCents;
    const agence = shares.value[0]!.shares.find((s) => s.kind === 'agence')!.amountCents;
    expect(420_000 + reseau + agence).toBe(list.value[0]!.content.ttcCents);
    expect(JSON.stringify(list.value)).not.toContain(t.agency.userId);
  });

  it('[R235] un dossier rattaché après la commission prévue ne la change pas : refusé, l’écart au journal, la base le refuse aussi', async () => {
    const t = await setup('apres');
    expect(await t.p.attachFile(t.agent, t.shareId, t.fileId)).toEqual({ ok: false, rule: 'R235', code: 'commission_prevue' });
    expect((await t.journal.all()).filter((e) => e.type === 'partage.ecart').map((e) => e.data)).toEqual([{ rule: 'R235', code: 'commission_prevue' }]);
    const d = (await t.db.first<{ id: string }>('SELECT id FROM agency_delegations'))!;
    await expect(t.db.run("INSERT INTO agency_delegation_files (delegation_id, file_id, at, by) VALUES (?, ?, 'x', 'x')", [d.id, t.fileId])).rejects.toThrow(/commission déjà prévue/);
    // Une part d'agence saisie à la main, sans dossier rattaché, est refusée.
    await expect(
      t.db.run("INSERT INTO commission_agency_shares (file_id, delegation_id, partner_share_bp, amount_cents, created_at) VALUES (?, ?, 4000, 400000, 'x')", [t.fileId, d.id]),
    ).rejects.toThrow(/non calculée/);
    const list = await t.c.list(t.direction);
    expect(list.ok && list.value[0]!.shares.map((s) => [s.kind, s.amountCents])).toEqual([
      ['reseau', 300_000],
      ['agent', 700_000],
    ]);
  });
});
