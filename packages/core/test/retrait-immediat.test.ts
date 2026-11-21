import { expect, it } from 'vitest';
import { DiffusionPortails, DiffusionSurveillee, RetraitsImmediats, type ListingPayload, type PortalAction, type PortalConnector, type PortalReceipt } from '../src/annonces/index.ts';
import { RegistreMandats } from '../src/index.ts';
import { setupAnnonce as setup } from './annonces-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// AU067 · Réseau, bien, mandat et portails inventés.
class FakePortal implements PortalConnector {
  readonly mode = 'reel' as const;
  received: { action: PortalAction; listing: ListingPayload }[] = [];
  failNext = 0;
  private n = 0;
  constructor(readonly portal: string) {}
  async send(op: { key: string; order: number; action: PortalAction; listing: ListingPayload }): Promise<PortalReceipt | null> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('portail_indisponible');
    }
    this.received.push({ action: op.action, listing: op.listing });
    return { receipt: `${this.portal}-ACK-${++this.n}`, portalRef: `${this.portal}-annonce-1` };
  }
}

async function published() {
  const t = await setup();
  t.setClock(new Date('2027-02-12T10:00:00.000Z'));
  await t.annonces.validate(t.agent, t.draftId);
  t.setClock(new Date('2027-03-01T08:00:00.000Z'));
  const a = new FakePortal('seloger');
  const b = new FakePortal('leboncoin');
  const portails = new DiffusionPortails(t.db, t.acces, t.journal, { now: t.now, connectors: [a, b] });
  const surveillance = new DiffusionSurveillee(t.db, t.acces, t.journal, { now: t.now });
  for (const [code, host] of [['seloger', 'www.seloger.com'], ['leboncoin', 'www.leboncoin.fr']] as const) {
    expect(await surveillance.setPortal(t.direction, { code, label: code, host, requiredFields: [], minPhotos: 0, active: true })).toEqual({ ok: true });
    expect(await surveillance.choose(t.agent, t.propertyId, code, true)).toEqual({ ok: true });
  }
  await t.publication.sync(t.network.id, t.propertyId);
  await portails.sync(t.network.id, t.propertyId);
  expect(a.received.map((r) => r.action)).toEqual(['publier']);
  const retraits = new RetraitsImmediats(t.db, t.acces, t.journal, { now: t.now, channels: t.channels, portals: [a, b] });
  // Le mandat s'arrête par la direction : la porte de la diffusion se ferme.
  expect((await new RegistreMandats(t.db, t.journal, { now: t.now }).cancel(t.direction, t.mandateId, 'termination')).ok).toBe(true);
  return { ...t, a, b, portails, retraits };
}

describeWithSqlite('AU067 · le retrait urgent part tout de suite, sans attendre le passage des quarts d’heure', () => {
  it('[R42] constat : le mandat arrêté, rien ne part avant le prochain passage planifié', async () => {
    const t = await published();
    // Sans passage, l'annonce reste en ligne sur chaque portail.
    expect(t.a.received.map((r) => r.action)).toEqual(['publier']);
    expect(t.channels.every((c) => c.received.every((p) => p.state !== 'retiree'))).toBe(true);
  });

  it('[R42] [R668] le passage du seul bien part aussitôt : chaque canal et chaque portail retirent, avec chaque accusé', async () => {
    const t = await published();
    const r = await t.retraits.run(t.network.id, t.propertyId, 'direction:direction-1');
    expect(r).toMatchObject({ state: 'retiree', busy: false, channels: { failed: [] } });
    expect(r.channels.pushed.length).toBeGreaterThan(0);
    expect(r.portals).toEqual([
      { portal: 'leboncoin', outcome: 'accuse', receipt: 'leboncoin-ACK-2' },
      { portal: 'seloger', outcome: 'accuse', receipt: 'seloger-ACK-2' },
    ]);
    expect(t.a.received.map((x) => [x.action, x.listing.state])).toEqual([
      ['publier', 'en_vente'],
      ['retirer', 'retiree'],
    ]);
    const events = (await t.journal.all()).filter((e) => e.type === 'annonce.retrait_immediat');
    expect(events.map((e) => [e.actor, e.data.state])).toEqual([['direction:direction-1', 'retiree']]);
  });

  it('[R668] un portail en panne n’arrête pas les autres ; il reste dû et le passage suivant le retire', async () => {
    const t = await published();
    t.b.failNext = 1;
    const r = await t.retraits.run(t.network.id, t.propertyId, 'direction:direction-1');
    expect(r.portals).toEqual([
      { portal: 'leboncoin', outcome: 'echec', receipt: null },
      { portal: 'seloger', outcome: 'accuse', receipt: 'seloger-ACK-2' },
    ]);
    await t.portails.syncAll(t.network.id);
    expect(t.b.received.map((x) => x.action)).toEqual(['publier', 'retirer']);
    // Rien ne repart vers celui qui a déjà accusé le retrait.
    expect(t.a.received).toHaveLength(2);
  });

  it('[R42] le bien du mandat se retrouve dans son réseau seul', async () => {
    const t = await published();
    expect(await t.retraits.propertyOfMandate(t.network.id, t.mandateId)).toBe(t.propertyId);
    expect(await t.retraits.propertyOfMandate('autre-reseau', t.mandateId)).toBeNull();
  });
});
