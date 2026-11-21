import { expect, it } from 'vitest';
import { annonces, type ListingPayload, type PortalAction, type PortalConnector, type PortalReceipt } from '@aimmo/core';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { setupAnnonce } from '../../core/test/annonces-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// AU067 · Réseau, bien, mandat, portail et clé inventés.
const API = 'https://aimmo-api.example.test';
const KEY = 'test-cle-au067-direction-eeeeeeeeeeeeeeeeeeeeeeeeee';

class FakePortal implements PortalConnector {
  readonly mode = 'reel' as const;
  received: PortalAction[] = [];
  private n = 0;
  constructor(readonly portal: string) {}
  async send(op: { key: string; order: number; action: PortalAction; listing: ListingPayload }): Promise<PortalReceipt | null> {
    this.received.push(op.action);
    return { receipt: `${this.portal}-ACK-${++this.n}`, portalRef: `${this.portal}-annonce-1` };
  }
}

describeWithSqlite('AU067 · l’annulation du mandat, par l’API, retire l’annonce sur-le-champ', () => {
  it('[R42] [R668] la réponse porte chaque accusé de retrait, sans attendre le passage planifié', async () => {
    const t = await setupAnnonce();
    t.setClock(new Date('2027-02-12T10:00:00.000Z'));
    await t.annonces.validate(t.agent, t.draftId);
    t.setClock(new Date('2027-03-01T08:00:00.000Z'));
    const portal = new FakePortal('seloger');
    const surveillance = new annonces.DiffusionSurveillee(t.db, t.acces, t.journal, { now: t.now });
    expect(await surveillance.setPortal(t.direction, { code: 'seloger', label: 'seloger', host: 'www.seloger.com', requiredFields: [], minPhotos: 0, active: true })).toEqual({ ok: true });
    expect(await surveillance.choose(t.agent, t.propertyId, 'seloger', true)).toEqual({ ok: true });
    await t.publication.sync(t.network.id, t.propertyId);
    await new annonces.DiffusionPortails(t.db, t.acces, t.journal, { now: t.now, connectors: [portal] }).sync(t.network.id, t.propertyId);
    expect(portal.received).toEqual(['publier']);

    const apiKeys = JSON.stringify([{ sha256: await sha256Hex(KEY), role: 'direction', userId: 'direction-1', networkId: t.network.id }]);
    const config: ApiConfig = { db: t.db, apiKeys, mode: 'essai', now: t.now, listing: { channels: t.channels, portals: [portal] } };
    const res = await handleRequest(
      new Request(`${API}/v1/mandats/${t.mandateId}/annulation`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'termination' }) }),
      config,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; retraits: { state: string; portals: unknown[]; channels: { failed: string[] } } };
    expect(body).toMatchObject({ ok: true, retraits: { state: 'retiree', channels: { failed: [] }, portals: [{ portal: 'seloger', outcome: 'accuse', receipt: 'seloger-ACK-2' }] } });
    expect(portal.received).toEqual(['publier', 'retirer']);
  });
});
