import { expect, it } from 'vitest';
import { DiffusionPortails, type ListingPayload, type PortalAction, type PortalConnector, type PortalReceipt } from '../src/annonces/index.ts';
import { setupAnnonce as setup } from './annonces-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

/** Un portail réel de test : il garde chaque geste reçu et rend un accusé, ou tombe en panne à la demande. */
class FakePortal implements PortalConnector {
  readonly mode = 'reel' as const;
  received: { action: PortalAction; listing: ListingPayload }[] = [];
  failNext = 0;
  noReceipt = 0;
  private n = 0;
  constructor(readonly portal: string) {}
  async send(op: { action: PortalAction; listing: ListingPayload }): Promise<PortalReceipt | null> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('portail_indisponible');
    }
    this.received.push(op);
    if (this.noReceipt > 0) {
      this.noReceipt--;
      return null;
    }
    return { receipt: `${this.portal}-ACK-${++this.n}`, portalRef: `${this.portal}-annonce-1` };
  }
}

async function published() {
  const t = await setup();
  t.setClock(new Date('2027-02-12T10:00:00.000Z'));
  await t.annonces.validate(t.agent, t.draftId);
  t.setClock(new Date('2027-03-01T08:00:00.000Z'));
  await t.publication.sync(t.network.id, t.propertyId);
  const a = new FakePortal('portail-a');
  const b = new FakePortal('portail-b');
  const portails = new DiffusionPortails(t.db, t.acces, t.journal, { now: t.now, connectors: [a, b] });
  await portails.subscribe(t.direction, { portal: 'portail-a', active: true });
  await portails.subscribe(t.direction, { portal: 'portail-b', active: true });
  return { ...t, a, b, portails };
}

const stateOf = async (t: Awaited<ReturnType<typeof published>>, portal: string) => {
  const st = await t.portails.status(t.agent, t.propertyId);
  if (!st.ok) throw new Error(st.code);
  return st.value.find((s) => s.portal === portal)!;
};

describeWithSqlite('AU004 · publier, modifier, retirer sur chaque portail souscrit, avec accusé réel', () => {
  it('[R668] constat : sans connecteur réel, le portail est en essai, rien ne part et rien n’est dit « publiée »', async () => {
    const t = await setup();
    t.setClock(new Date('2027-02-12T10:00:00.000Z'));
    await t.annonces.validate(t.agent, t.draftId);
    t.setClock(new Date('2027-03-01T08:00:00.000Z'));
    await t.publication.sync(t.network.id, t.propertyId);
    const portails = new DiffusionPortails(t.db, t.acces, t.journal, { now: t.now });
    await portails.subscribe(t.direction, { portal: 'portail-a', active: true });
    expect(await portails.sync(t.network.id, t.propertyId)).toMatchObject({ acknowledged: [], trial: ['portail-a'], failed: [] });
    // Un deuxième passage ne range pas un second essai.
    await portails.sync(t.network.id, t.propertyId);
    expect((await t.db.first<{ n: number }>("SELECT count(*) AS n FROM portal_operations WHERE outcome = 'essai'"))!.n).toBe(1);
    const st = await portails.status(t.agent, t.propertyId);
    expect(st.ok && st.value).toEqual([{ portal: 'portail-a', subscribed: true, mode: 'essai', state: 'essai', acknowledged: null, expectedSeq: 1, lastError: null }]);
  });

  it('[R668] [R44] publier puis modifier sur chaque portail : accusé réel et statut par portail, au prix publié', async () => {
    const t = await published();
    expect(await t.portails.sync(t.network.id, t.propertyId)).toMatchObject({ acknowledged: ['portail-a', 'portail-b'], failed: [] });
    expect(t.a.received.map((r) => [r.action, r.listing.version, r.listing.priceEur])).toEqual([['publier', 1, 210000]]);
    expect(await stateOf(t, 'portail-a')).toMatchObject({ state: 'publiee', mode: 'reel', acknowledged: { seq: 1, action: 'publier', receipt: 'portail-a-ACK-1', portalRef: 'portail-a-annonce-1' } });
    // Rien n'a changé : rien ne repart.
    await t.portails.sync(t.network.id, t.propertyId);
    expect(t.a.received).toHaveLength(1);
    // Avenant de prix : nouvelle version publiée, puis modifiée sur chaque portail.
    t.setClock(new Date('2027-03-01T08:07:00.000Z'));
    await t.amend(190000);
    await t.publication.sync(t.network.id, t.propertyId);
    expect(await stateOf(t, 'portail-a')).toMatchObject({ state: 'en_attente', expectedSeq: 2, acknowledged: { seq: 1 } });
    await t.portails.sync(t.network.id, t.propertyId);
    expect(t.a.received.map((r) => [r.action, r.listing.version, r.listing.priceEur])).toEqual([['publier', 1, 210000], ['modifier', 2, 200000]]);
    expect(t.b.received.at(-1)!.listing.priceEur).toBe(200000);
    expect(await stateOf(t, 'portail-b')).toMatchObject({ state: 'publiee', acknowledged: { seq: 2, action: 'modifier' } });
    const ev = await t.db.all<{ type: string }>("SELECT type FROM journal WHERE type LIKE 'portail.%' ORDER BY rowid");
    expect(ev.map((e) => e.type)).toEqual(['portail.abonnement', 'portail.abonnement', 'portail.publiee', 'portail.publiee', 'portail.modifiee', 'portail.modifiee']);
  });

  it('[R668] [R42] retirer : un bien retiré de la vente est retiré de chaque portail, avec son accusé', async () => {
    const t = await published();
    await t.portails.sync(t.network.id, t.propertyId);
    await t.db.run("UPDATE properties SET status = 'withdrawn' WHERE id = ?", [t.propertyId]);
    t.setClock(new Date('2027-03-02T08:00:00.000Z'));
    await t.publication.sync(t.network.id, t.propertyId);
    await t.portails.sync(t.network.id, t.propertyId);
    expect(t.a.received.at(-1)).toMatchObject({ action: 'retirer', listing: { reference: 'REF-T-1', state: 'retiree', title: null, priceEur: null, media: [] } });
    expect(await stateOf(t, 'portail-a')).toMatchObject({ state: 'retiree', expectedSeq: null, acknowledged: { action: 'retirer', receipt: 'portail-a-ACK-2' } });
    await t.portails.sync(t.network.id, t.propertyId);
    expect(t.a.received).toHaveLength(2);
  });

  it('[R668] un abonnement arrêté retire l’annonce de ce portail seulement ; repris, elle y revient', async () => {
    const t = await published();
    await t.portails.sync(t.network.id, t.propertyId);
    await t.portails.subscribe(t.direction, { portal: 'portail-b', active: false });
    await t.portails.sync(t.network.id, t.propertyId);
    expect(t.b.received.map((r) => r.action)).toEqual(['publier', 'retirer']);
    expect(t.a.received.map((r) => r.action)).toEqual(['publier']);
    expect(await stateOf(t, 'portail-b')).toMatchObject({ subscribed: false, state: 'retiree' });
    t.setClock(new Date('2027-03-01T09:00:00.000Z'));
    await t.portails.subscribe(t.direction, { portal: 'portail-b', active: true });
    await t.portails.sync(t.network.id, t.propertyId);
    expect(t.b.received.map((r) => r.action)).toEqual(['publier', 'retirer', 'publier']);
    expect(await stateOf(t, 'portail-b')).toMatchObject({ subscribed: true, state: 'publiee' });
  });

  it('[R668] sans accusé ou en panne : échec dit par portail, réessayé au passage suivant, jamais « publiée »', async () => {
    const t = await published();
    t.a.failNext = 1;
    t.b.noReceipt = 1;
    expect(await t.portails.sync(t.network.id, t.propertyId)).toMatchObject({ acknowledged: [], failed: ['portail-a', 'portail-b'] });
    expect(await stateOf(t, 'portail-a')).toMatchObject({ state: 'echec', acknowledged: null, lastError: { code: 'portail_indisponible', action: 'publier', seq: 1 } });
    expect(await stateOf(t, 'portail-b')).toMatchObject({ state: 'echec', lastError: { code: 'accuse_absent' } });
    t.setClock(new Date('2027-03-01T08:15:00.000Z'));
    expect(await t.portails.sync(t.network.id, t.propertyId)).toMatchObject({ acknowledged: ['portail-a', 'portail-b'] });
    expect(await stateOf(t, 'portail-a')).toMatchObject({ state: 'publiee', lastError: null });
  });

  it('[R668] [R16] seule la direction souscrit ; le statut se lit par qui voit le bien en entier', async () => {
    const t = await published();
    expect(await t.portails.subscribe(t.agent, { portal: 'portail-c', active: true })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.portails.subscribe(t.direction, { portal: 'Portail C!', active: true })).toEqual({ ok: false, rule: null, code: 'invalid_portal' });
    expect(await t.portails.subscribe(t.direction, { portal: 'portail-c', active: 'oui' })).toEqual({ ok: false, rule: null, code: 'invalid_active' });
    expect(await t.portails.status(t.sam, t.propertyId)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.portails.subscriptions(t.network.id)).toEqual([{ portal: 'portail-a', active: true }, { portal: 'portail-b', active: true }]);
  });

  it('[R668] deux passages en même temps n’envoient jamais deux fois la même version', async () => {
    const t = await published();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: PortalConnector = { portal: 'portail-a', mode: 'reel', send: async (op) => { await gate; t.a.received.push(op); return { receipt: 'LENT-1' }; } };
    const p1 = new DiffusionPortails(t.db, t.acces, t.journal, { now: t.now, connectors: [slow] });
    const first = p1.sync(t.network.id, t.propertyId);
    const second = await p1.sync(t.network.id, t.propertyId);
    expect(second.busy).toBe(true);
    release();
    await first;
    expect(t.a.received.filter((r) => r.action === 'publier')).toHaveLength(1);
  });

  it('[R668] les opérations rangées ne s’effacent ni ne se réécrivent', async () => {
    const t = await published();
    await t.portails.sync(t.network.id, t.propertyId);
    await expect(t.db.run('DELETE FROM portal_operations')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run("UPDATE portal_operations SET receipt = 'x'")).rejects.toThrow(/rien ne se réécrit/);
    await expect(t.db.run('DELETE FROM portal_subscriptions')).rejects.toThrow(/rien ne s'efface/);
  });
});
