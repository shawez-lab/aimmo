import { expect, it } from 'vitest';
import { DiffusionPortails, DiffusionSurveillee, type ListingPayload, type PortalAction, type PortalConnector, type PortalReceipt } from '../src/annonces/index.ts';
import { setupAnnonce as setup } from './annonces-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

/** Un portail réel de test : il garde chaque geste reçu et rend un accusé, ou tombe en panne à la demande. */
class FakePortal implements PortalConnector {
  readonly mode = 'reel' as const;
  received: { key: string; order: number; action: PortalAction; listing: ListingPayload }[] = [];
  failNext = 0;
  noReceipt = 0;
  private n = 0;
  constructor(readonly portal: string) {}
  async send(op: { key: string; order: number; action: PortalAction; listing: ListingPayload }): Promise<PortalReceipt | null> {
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
  const a = new FakePortal('seloger');
  const b = new FakePortal('leboncoin');
  const portails = new DiffusionPortails(t.db, t.acces, t.journal, { now: t.now, connectors: [a, b] });
  const surveillance = new DiffusionSurveillee(t.db, t.acces, t.journal, { now: t.now });
  await enable(t, surveillance, 'seloger', 'www.seloger.com');
  await enable(t, surveillance, 'leboncoin', 'www.leboncoin.fr');
  return { ...t, a, b, portails, surveillance };
}

/** La direction règle le portail actif (HX38), l'agent le choisit pour son bien. */
async function enable(t: Awaited<ReturnType<typeof setup>>, d: DiffusionSurveillee, code: string, host: string, active = true) {
  expect(await d.setPortal(t.direction, { code, label: code, host, requiredFields: [], minPhotos: 0, active })).toEqual({ ok: true });
  expect(await d.choose(t.agent, t.propertyId, code, true)).toEqual({ ok: true });
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
    await enable(t, new DiffusionSurveillee(t.db, t.acces, t.journal, { now: t.now }), 'seloger', 'www.seloger.com');
    expect(await portails.sync(t.network.id, t.propertyId)).toMatchObject({ acknowledged: [], trial: ['seloger'], failed: [] });
    // Un deuxième passage ne range pas un second essai.
    await portails.sync(t.network.id, t.propertyId);
    expect((await t.db.first<{ n: number }>("SELECT count(*) AS n FROM portal_operations WHERE outcome = 'essai'"))!.n).toBe(1);
    const st = await portails.status(t.agent, t.propertyId);
    expect(st.ok && st.value).toEqual([{ portal: 'seloger', plan: 'a_diffuser', mode: 'essai', state: 'essai', acknowledged: null, expectedSeq: 1, lastError: null }]);
  });

  it('[R668] [R44] publier puis modifier sur chaque portail : accusé réel et statut par portail, au prix publié', async () => {
    const t = await published();
    expect(await t.portails.sync(t.network.id, t.propertyId)).toMatchObject({ acknowledged: ['leboncoin', 'seloger'], failed: [] });
    expect(t.a.received.map((r) => [r.action, r.listing.version, r.listing.priceEur])).toEqual([['publier', 1, 210000]]);
    expect(await stateOf(t, 'seloger')).toMatchObject({ state: 'publiee', mode: 'reel', acknowledged: { seq: 1, action: 'publier', receipt: 'seloger-ACK-1', portalRef: 'seloger-annonce-1' } });
    // Rien n'a changé : rien ne repart.
    await t.portails.sync(t.network.id, t.propertyId);
    expect(t.a.received).toHaveLength(1);
    // Avenant de prix : nouvelle version publiée, puis modifiée sur chaque portail.
    t.setClock(new Date('2027-03-01T08:07:00.000Z'));
    await t.amend(190000);
    await t.publication.sync(t.network.id, t.propertyId);
    expect(await stateOf(t, 'seloger')).toMatchObject({ state: 'en_attente', expectedSeq: 2, acknowledged: { seq: 1 } });
    await t.portails.sync(t.network.id, t.propertyId);
    expect(t.a.received.map((r) => [r.action, r.listing.version, r.listing.priceEur])).toEqual([['publier', 1, 210000], ['modifier', 2, 200000]]);
    expect(t.b.received.at(-1)!.listing.priceEur).toBe(200000);
    expect(await stateOf(t, 'leboncoin')).toMatchObject({ state: 'publiee', acknowledged: { seq: 2, action: 'modifier' } });
    const ev = await t.db.all<{ type: string }>("SELECT type FROM journal WHERE type LIKE 'portail.%' ORDER BY rowid");
    expect(ev.map((e) => e.type)).toEqual(['portail.publiee', 'portail.publiee', 'portail.modifiee', 'portail.modifiee']);
  });

  it('[R668] [R42] retirer : un bien retiré de la vente est retiré de chaque portail, avec son accusé', async () => {
    const t = await published();
    await t.portails.sync(t.network.id, t.propertyId);
    await t.db.run("UPDATE properties SET status = 'withdrawn' WHERE id = ?", [t.propertyId]);
    t.setClock(new Date('2027-03-02T08:00:00.000Z'));
    await t.publication.sync(t.network.id, t.propertyId);
    await t.portails.sync(t.network.id, t.propertyId);
    expect(t.a.received.at(-1)).toMatchObject({ action: 'retirer', listing: { reference: 'REF-T-1', state: 'retiree', title: null, priceEur: null, media: [] } });
    expect(await stateOf(t, 'seloger')).toMatchObject({ state: 'retiree', expectedSeq: null, acknowledged: { action: 'retirer', receipt: 'seloger-ACK-2' } });
    await t.portails.sync(t.network.id, t.propertyId);
    expect(t.a.received).toHaveLength(2);
  });

  it('[R668] [R470] un portail écarté du bien retire l’annonce de ce portail seulement ; repris, elle y revient', async () => {
    const t = await published();
    await t.portails.sync(t.network.id, t.propertyId);
    expect(await t.surveillance.choose(t.agent, t.propertyId, 'leboncoin', false)).toEqual({ ok: true });
    await t.portails.sync(t.network.id, t.propertyId);
    expect(t.b.received.map((r) => r.action)).toEqual(['publier', 'retirer']);
    expect(t.a.received.map((r) => r.action)).toEqual(['publier']);
    expect(await stateOf(t, 'leboncoin')).toMatchObject({ plan: 'non_choisi', state: 'retiree' });
    t.setClock(new Date('2027-03-01T09:00:00.000Z'));
    await t.surveillance.choose(t.agent, t.propertyId, 'leboncoin', true);
    await t.portails.sync(t.network.id, t.propertyId);
    expect(t.b.received.map((r) => r.action)).toEqual(['publier', 'retirer', 'publier']);
    expect(await stateOf(t, 'leboncoin')).toMatchObject({ plan: 'a_diffuser', state: 'publiee' });
  });

  it('[R668] [R472] [R42] un retrait temporaire ou un portail arrêté par la direction retirent l’annonce, avec accusé', async () => {
    const t = await published();
    await t.portails.sync(t.network.id, t.propertyId);
    expect(await t.surveillance.suspend(t.agent, { propertyId: t.propertyId, portal: 'seloger', reason: 'travaux' })).toMatchObject({ ok: true });
    expect(await t.surveillance.setPortal(t.direction, { code: 'leboncoin', label: 'leboncoin', host: 'www.leboncoin.fr', requiredFields: [], minPhotos: 0, active: false })).toEqual({ ok: true });
    await t.portails.sync(t.network.id, t.propertyId);
    expect(t.a.received.map((r) => r.action)).toEqual(['publier', 'retirer']);
    expect(t.b.received.map((r) => r.action)).toEqual(['publier', 'retirer']);
    expect(await stateOf(t, 'seloger')).toMatchObject({ plan: 'suspendu', state: 'retiree' });
    expect(await stateOf(t, 'leboncoin')).toMatchObject({ plan: 'inactif', state: 'retiree' });
  });

  it('[R668] [R470] un portail réglé mais pas choisi pour le bien ne reçoit rien', async () => {
    const t = await published();
    const c = new FakePortal('bienici');
    const p = new DiffusionPortails(t.db, t.acces, t.journal, { now: t.now, connectors: [c] });
    await t.surveillance.setPortal(t.direction, { code: 'bienici', label: 'Bien’ici', host: 'www.bienici.com', requiredFields: [], minPhotos: 0 });
    await p.sync(t.network.id, t.propertyId);
    expect(c.received).toEqual([]);
    const st = await p.status(t.agent, t.propertyId);
    expect(st.ok && st.value.find((x) => x.portal === 'bienici')).toMatchObject({ plan: 'non_choisi', state: 'non_publiee', expectedSeq: null });
  });

  it('[R668] sans accusé ou en panne : échec dit par portail, réessayé au passage suivant, jamais « publiée »', async () => {
    const t = await published();
    t.a.failNext = 1;
    t.b.noReceipt = 1;
    expect(await t.portails.sync(t.network.id, t.propertyId)).toMatchObject({ acknowledged: [], failed: ['leboncoin', 'seloger'] });
    expect(await stateOf(t, 'seloger')).toMatchObject({ state: 'echec', acknowledged: null, lastError: { code: 'portail_indisponible', action: 'publier', seq: 1 } });
    expect(await stateOf(t, 'leboncoin')).toMatchObject({ state: 'echec', lastError: { code: 'accuse_absent' } });
    t.setClock(new Date('2027-03-01T08:15:00.000Z'));
    expect(await t.portails.sync(t.network.id, t.propertyId)).toMatchObject({ acknowledged: ['leboncoin', 'seloger'] });
    expect(await stateOf(t, 'seloger')).toMatchObject({ state: 'publiee', lastError: null });
  });

  it('[R668] [R16] le statut par portail se lit par qui voit le bien en entier', async () => {
    const t = await published();
    expect(await t.portails.status(t.sam, t.propertyId)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.portails.status(t.agent, 'inconnu')).toMatchObject({ ok: false, code: 'unknown_property' });
  });

  it('[R668] deux passages en même temps n’envoient jamais deux fois la même version', async () => {
    const t = await published();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: PortalConnector = { portal: 'seloger', mode: 'reel', send: async (op) => { await gate; t.a.received.push(op); return { receipt: 'LENT-1' }; } };
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
  });

  it('[R668] un accusé arrivé après la fin du bail n’est pas rangé ; le geste repart avec la même clé, sans doublon côté portail', async () => {
    const t = await published();
    const keys: string[] = [];
    let first = true;
    const late: PortalConnector = {
      portal: 'seloger',
      mode: 'reel',
      send: async (op) => {
        keys.push(op.key);
        // Le premier envoi dure plus que le bail : un autre passage a pu le prendre.
        if (first) (first = false), t.setClock(new Date(t.now().getTime() + 6 * 60_000));
        return { receipt: 'ACK-IDEM' };
      },
    };
    const p = new DiffusionPortails(t.db, t.acces, t.journal, { now: t.now, connectors: [late] });
    await p.sync(t.network.id, t.propertyId);
    expect((await t.db.first<{ n: number }>("SELECT count(*) AS n FROM portal_operations WHERE outcome = 'accuse'"))!.n).toBe(0);
    await p.sync(t.network.id, t.propertyId);
    expect(keys).toEqual([`${t.propertyId}:seloger:1`, `${t.propertyId}:seloger:1`]);
    expect((await t.db.first<{ n: number }>("SELECT count(*) AS n FROM portal_operations WHERE outcome = 'accuse'"))!.n).toBe(1);
  });

  it('[R668] [R42] une annonce en ligne dont le connecteur a disparu : échec « connecteur_absent », jamais « essai »', async () => {
    const t = await published();
    await t.portails.sync(t.network.id, t.propertyId);
    await t.db.run("UPDATE properties SET status = 'withdrawn' WHERE id = ?", [t.propertyId]);
    t.setClock(new Date('2027-03-02T08:00:00.000Z'));
    await t.publication.sync(t.network.id, t.propertyId);
    const sans = new DiffusionPortails(t.db, t.acces, t.journal, { now: t.now });
    expect(await sans.sync(t.network.id, t.propertyId)).toMatchObject({ trial: [], failed: ['leboncoin', 'seloger'] });
    const st = await sans.status(t.agent, t.propertyId);
    expect(st.ok && st.value.find((x) => x.portal === 'seloger')).toMatchObject({ mode: 'essai', state: 'echec', lastError: { code: 'connecteur_absent', action: 'retirer' } });
    expect((await t.db.first<{ n: number }>("SELECT count(*) AS n FROM journal WHERE type = 'portail.echec' AND data LIKE '%connecteur_absent%'"))!.n).toBe(2);
    // Le connecteur revient : le retrait part.
    await t.portails.sync(t.network.id, t.propertyId);
    expect(t.a.received.at(-1)!.action).toBe('retirer');
  });

  it('[R668] une annonce remise après un retrait accusé part avec une autre clé : le portail ne rend pas l’ancien accusé', async () => {
    const t = await published();
    await t.portails.sync(t.network.id, t.propertyId);
    await t.surveillance.choose(t.agent, t.propertyId, 'seloger', false);
    await t.portails.sync(t.network.id, t.propertyId);
    t.setClock(new Date('2027-03-01T09:00:00.000Z'));
    await t.surveillance.choose(t.agent, t.propertyId, 'seloger', true);
    await t.portails.sync(t.network.id, t.propertyId);
    expect(t.a.received.map((r) => [r.key, r.order])).toEqual([[`${t.propertyId}:seloger:1`, 1], [`${t.propertyId}:seloger:3`, 3], [`${t.propertyId}:seloger:5`, 5]]);
  });

  it('[R668] [R42] un dépôt sans accusé a pu être appliqué : le bien retiré est quand même retiré de ce portail', async () => {
    const t = await published();
    t.a.noReceipt = 1;
    await t.portails.sync(t.network.id, t.propertyId);
    expect(await stateOf(t, 'seloger')).toMatchObject({ state: 'echec', acknowledged: null });
    await t.db.run("UPDATE properties SET status = 'withdrawn' WHERE id = ?", [t.propertyId]);
    t.setClock(new Date('2027-03-02T08:00:00.000Z'));
    await t.publication.sync(t.network.id, t.propertyId);
    await t.portails.sync(t.network.id, t.propertyId);
    expect(t.a.received.map((r) => r.action)).toEqual(['publier', 'retirer']);
    expect(await stateOf(t, 'seloger')).toMatchObject({ state: 'retiree', acknowledged: { action: 'retirer' } });
    // Leboncoin n'a jamais rien tenté de plus que son accusé : retiré aussi, une seule fois.
    expect(t.b.received.map((r) => r.action)).toEqual(['publier', 'retirer']);
    await t.portails.sync(t.network.id, t.propertyId);
    expect(t.a.received).toHaveLength(2);
  });

  it('[R668] un portail jamais tenté ni accusé ne reçoit pas de retrait', async () => {
    const t = await published();
    await t.db.run("UPDATE properties SET status = 'withdrawn' WHERE id = ?", [t.propertyId]);
    t.setClock(new Date('2027-03-02T08:00:00.000Z'));
    await t.publication.sync(t.network.id, t.propertyId);
    await t.portails.sync(t.network.id, t.propertyId);
    expect(t.a.received).toEqual([]);
    expect(await stateOf(t, 'seloger')).toMatchObject({ state: 'non_publiee' });
  });

  it('[R668] [R42] un dépôt resté sans réponse puis un retrait : le retrait porte un ordre plus grand, le dépôt en retard ne remet rien en ligne', async () => {
    const t = await published();
    // Un portail qui respecte le contrat : il applique chaque clé une fois et ignore un geste d'ordre plus petit.
    let online = false;
    let lastOrder = 0;
    const late: (() => void)[] = [];
    const apply = (op: { order: number; action: PortalAction }) => {
      if (op.order < lastOrder) return;
      lastOrder = op.order;
      online = op.action !== 'retirer';
    };
    let first = true;
    const portal: PortalConnector = {
      portal: 'seloger',
      mode: 'reel',
      send: async (op) => {
        if (first) {
          first = false;
          late.push(() => apply(op));
          throw new Error('delai_depasse');
        }
        apply(op);
        return { receipt: `ACK-${op.order}` };
      },
    };
    const p = new DiffusionPortails(t.db, t.acces, t.journal, { now: t.now, connectors: [portal] });
    await p.sync(t.network.id, t.propertyId);
    await t.db.run("UPDATE properties SET status = 'withdrawn' WHERE id = ?", [t.propertyId]);
    t.setClock(new Date('2027-03-02T08:00:00.000Z'));
    await t.publication.sync(t.network.id, t.propertyId);
    await p.sync(t.network.id, t.propertyId);
    expect(online).toBe(false);
    // Le dépôt d'ordre 1 arrive enfin chez le portail : ignoré, l'annonce reste retirée.
    late.forEach((f) => f());
    expect(online).toBe(false);
    const st = await p.status(t.agent, t.propertyId);
    expect(st.ok && st.value.find((x) => x.portal === 'seloger')).toMatchObject({ state: 'retiree', acknowledged: { action: 'retirer', receipt: 'ACK-3' } });
  });

  it('[R668] un retrait resté sans accusé puis le portail rechoisi : l’annonce est déposée de nouveau, jamais dite « publiée » sur le vieil accusé', async () => {
    const t = await published();
    await t.portails.sync(t.network.id, t.propertyId);
    await t.surveillance.choose(t.agent, t.propertyId, 'seloger', false);
    t.a.noReceipt = 1;
    await t.portails.sync(t.network.id, t.propertyId);
    expect(await stateOf(t, 'seloger')).toMatchObject({ state: 'echec', lastError: { action: 'retirer', code: 'accuse_absent' } });
    t.setClock(new Date('2027-03-01T09:00:00.000Z'));
    await t.surveillance.choose(t.agent, t.propertyId, 'seloger', true);
    expect(await stateOf(t, 'seloger')).not.toMatchObject({ state: 'publiee' });
    await t.portails.sync(t.network.id, t.propertyId);
    expect(t.a.received.map((r) => [r.action, r.order])).toEqual([['publier', 1], ['retirer', 3], ['publier', 5]]);
    expect(await stateOf(t, 'seloger')).toMatchObject({ state: 'publiee', acknowledged: { action: 'publier', receipt: 'seloger-ACK-2' } });
  });

  it('[R668] un retrait sans accusé est renvoyé avec la même clé tant qu’il reste voulu', async () => {
    const t = await published();
    await t.portails.sync(t.network.id, t.propertyId);
    await t.surveillance.choose(t.agent, t.propertyId, 'seloger', false);
    t.a.failNext = 1;
    await t.portails.sync(t.network.id, t.propertyId);
    t.setClock(new Date('2027-03-01T08:15:00.000Z'));
    t.a.noReceipt = 1;
    await t.portails.sync(t.network.id, t.propertyId);
    t.setClock(new Date('2027-03-01T08:30:00.000Z'));
    await t.portails.sync(t.network.id, t.propertyId);
    const retraits = t.a.received.filter((r) => r.action === 'retirer');
    expect(new Set(retraits.map((r) => r.key)).size).toBe(1);
    expect(await stateOf(t, 'seloger')).toMatchObject({ state: 'retiree' });
  });

  it('[R668] [R44] un dépôt appliqué dont l’accusé n’a pu être rangé, puis un nouveau prix : la nouvelle version part avec une autre clé', async () => {
    const t = await published();
    const applied = new Map<string, { receipt: string; priceEur: number | null }>();
    const prices: (number | null)[] = [];
    let lose = true;
    const portal: PortalConnector = {
      portal: 'seloger',
      mode: 'reel',
      send: async (op) => {
        const known = applied.get(op.key);
        if (known) return { receipt: known.receipt };
        applied.set(op.key, { receipt: `ACK-${op.order}`, priceEur: op.listing.priceEur });
        prices.push(op.listing.priceEur);
        // Le premier dépôt dure plus que le bail : son accusé ne sera pas rangé.
        if (lose) (lose = false), t.setClock(new Date(t.now().getTime() + 6 * 60_000));
        return { receipt: `ACK-${op.order}` };
      },
    };
    const p = new DiffusionPortails(t.db, t.acces, t.journal, { now: t.now, connectors: [portal] });
    await p.sync(t.network.id, t.propertyId);
    t.setClock(new Date('2027-03-01T09:00:00.000Z'));
    await t.amend(190000);
    await t.publication.sync(t.network.id, t.propertyId);
    await p.sync(t.network.id, t.propertyId);
    expect(prices).toEqual([210000, 200000]);
    const st = await p.status(t.agent, t.propertyId);
    expect(st.ok && st.value.find((x) => x.portal === 'seloger')).toMatchObject({ state: 'publiee', acknowledged: { seq: 2 } });
  });
});
