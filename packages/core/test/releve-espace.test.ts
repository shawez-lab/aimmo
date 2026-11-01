import { describe, expect, it } from 'vitest';
import { MemoryJournalStore } from '../src/index.ts';
import { EspaceVendeur, ReleveEspace, renderView, type ClientViewer, type SourcesVendeur } from '../src/espaces/index.ts';

const NOW = new Date('2027-06-08T08:00:00.000Z');
// Clés inventées pour les tests, jamais celles du Worker.
const KEY = { id: 'essai-a', secret: 'cle-de-test-inventee-pour-le-releve-0001' };
const OLD = { id: 'essai-ancienne', secret: 'ancienne-cle-de-test-inventee-du-releve' };
const VISITEUR = { personId: 'p-visiteur', firstName: 'Bérénice', lastName: 'Inventée', emails: ['berenice.inventee@example.test'], phones: ['0612345678'] };

const sources: SourcesVendeur = {
  sellerPropertiesOf: async (_n, personId) => (personId === 'p-vendeur' ? [{ propertyId: 'b1', reference: 'B-1', city: 'Dijon', status: 'available', statusAt: '2027-05-02T09:00:00.000Z', askingPriceEur: 245_000, mandateSignedAt: '2027-05-01T10:00:00.000Z' }] : []),
  visitsOf: async () => [
    { id: 'v1', at: '2027-06-05T14:00:00.000Z', state: 'faite', report: { text: 'Bérénice a aimé le séjour.', interest: 'intéressée', validatedAt: '2027-06-05T18:00:00.000Z' }, visitor: VISITEUR },
    { id: 'v2', at: '2027-06-06T14:00:00.000Z', state: 'faite', report: { text: 'Lumineux, réserve sur la cuisine.', interest: 'à revoir', validatedAt: '2027-06-06T18:00:00.000Z' }, visitor: VISITEUR },
  ],
  offersOf: async () => [{ id: 'o1', receivedAt: '2027-06-06T11:00:00.000Z', amountEur: 238_000, netSellerEur: 228_480, conditions: ['prêt immobilier'], validUntil: '2027-06-13T11:00:00.000Z', state: 'transmise', stateAt: '2027-06-06T11:05:00.000Z', buyer: null }],
  documentsOf: async () => [{ id: 'd1', title: 'Mandat de vente', kind: 'mandat', addedAt: '2027-05-01T10:00:00.000Z', signature: 'signe', signedAt: '2027-05-01T10:30:00.000Z' }],
  appointmentsOf: async () => [],
  weeklyPointsOf: async () => [],
  earliestDeedOf: async () => null,
};

const viewer: ClientViewer = { kind: 'client', networkId: 'n1', personId: 'p-vendeur', sessionId: 's-1', sides: ['vendeur'] };

async function releve(keys = [KEY]) {
  const journal = new MemoryJournalStore();
  const vue = await new EspaceVendeur(sources, journal, { now: () => NOW }).vue(viewer);
  if (!vue.ok) throw new Error('vue');
  const r = new ReleveEspace(keys, journal, { now: () => NOW });
  return { journal, r, vue: vue.value, made: await r.make(viewer, 'vente de B-1', vue.value) };
}

describe('EC05 · relevé prouvé de l’espace (Jamais vu)', () => {
  it('[R164] un relevé intact est vérifié avec sa date, à partir du relevé seul', async () => {
    const { made } = await releve();
    expect(made).not.toBeNull();
    expect(made!.text).toContain('Prix : 245000 (mandat en vigueur, 2027-05-01T10:00:00.000Z)');
    expect(made!.text).toContain('Compte rendu : Lumineux, réserve sur la cuisine.');
    expect(made!.text).toContain('Fait le : 2027-06-08T08:00:00.000Z');
    // Un autre vérificateur, avec la seule clé : aucune base, aucun journal à lire.
    const verifier = new ReleveEspace([KEY], new MemoryJournalStore());
    expect(await verifier.verify(made!.text)).toEqual({ status: 'intact', madeAt: '2027-06-08T08:00:00.000Z' });
    // Les sauts de ligne Windows d'une copie ne changent rien.
    expect(await verifier.verify(made!.text.replace(/\n/g, '\r\n'))).toEqual({ status: 'intact', madeAt: '2027-06-08T08:00:00.000Z' });
  });

  it('[R164] un relevé modifié d’un seul caractère, n’importe où, est refusé', async () => {
    const { r, made } = await releve();
    const text = made!.text;
    const positions = [0, text.indexOf('245000') + 1, text.indexOf('Lumineux'), text.indexOf('Fait le') + 10, text.indexOf('Clé') + 6, text.indexOf('Signature : ') + 15, text.length - 2];
    for (const i of positions) {
      const ch = text[i] === 'a' ? 'b' : 'a';
      const changed = text.slice(0, i) + ch + text.slice(i + 1);
      expect(await r.verify(changed), `position ${i}`).toEqual({ status: 'modifie' });
    }
    for (const changed of [text.replace('238000', '258000'), text + 'x', text.slice(1), text.replace('Lumineux, ', ''), `${text.split('— — —')[0]}— — —\nFait le : 2027-06-09T08:00:00.000Z\n${text.split('\n').slice(-3).join('\n')}`]) {
      expect(await r.verify(changed)).toEqual({ status: 'modifie' });
    }
    for (const junk of ['', 'bonjour', 42, null, undefined, { text }]) expect(await r.verify(junk)).toEqual({ status: 'modifie' });
  });

  it('[R164] la vérification ne dit que « intact, fait le … » ou « modifié »', async () => {
    const { r, made } = await releve();
    const ok = await r.verify(made!.text);
    expect(Object.keys(ok).sort()).toEqual(['madeAt', 'status']);
    const ko = await r.verify(made!.text.replace('245000', '1'));
    expect(Object.keys(ko)).toEqual(['status']);
  });

  it('[R161] [R164] le relevé ne porte rien d’un autre client', async () => {
    const { made } = await releve();
    for (const secret of ['Bérénice', 'Inventée', 'example.test', '0612345678', 'p-visiteur', 'propertyId', 'p-vendeur']) expect(made!.text).not.toContain(secret);
  });

  it('[R164] la même vue à la même date donne le même relevé et la même empreinte ; une autre date, une autre', async () => {
    const a = await releve();
    const b = await releve();
    expect(b.made!.digest).toBe(a.made!.digest);
    expect(b.made!.text).toBe(a.made!.text);
    const later = await new ReleveEspace([KEY], new MemoryJournalStore(), { now: () => new Date(NOW.getTime() + 60_000) }).make(viewer, 'vente de B-1', a.vue);
    expect(later!.digest).not.toBe(a.made!.digest);
    expect(renderView({ x: { value: 1, source: 's', at: 'd' }, y: [] })).toBe(renderView({ x: { value: 1, source: 's', at: 'd' }, y: [] }));
  });

  it('[R164] rotation : une ancienne clé vérifie encore ; une clé inconnue donne « modifié »', async () => {
    const { made } = await releve([OLD]);
    expect(await new ReleveEspace([KEY, OLD], new MemoryJournalStore()).verify(made!.text)).toMatchObject({ status: 'intact' });
    expect(await new ReleveEspace([KEY], new MemoryJournalStore()).verify(made!.text)).toEqual({ status: 'modifie' });
    // Une signature faite avec une autre clé sous le même nom est refusée.
    expect(await new ReleveEspace([{ id: 'essai-ancienne', secret: 'une-tout-autre-cle-inventee-pour-le-test' }], new MemoryJournalStore()).verify(made!.text)).toEqual({ status: 'modifie' });
  });

  it('[R164] [R13] sans clé, aucun relevé ; la clé n’est jamais dans le relevé ni le journal, le journal ne garde que l’empreinte', async () => {
    const empty = new ReleveEspace([], new MemoryJournalStore());
    expect(empty.available).toBe(false);
    expect(await empty.make(viewer, 'x', {})).toBeNull();
    expect(() => new ReleveEspace([{ id: 'courte', secret: 'trop-courte' }], new MemoryJournalStore())).toThrow();
    expect(() => new ReleveEspace([{ id: 'Pas Bon', secret: KEY.secret }], new MemoryJournalStore())).toThrow();
    const { journal, made } = await releve();
    expect(made!.text).not.toContain(KEY.secret);
    const entries = (await journal.all()).filter((e) => e.type === 'espaces.releve');
    expect(entries.map((e) => e.data)).toEqual([{ rule: 'R164', digest: made!.digest, madeAt: '2027-06-08T08:00:00.000Z' }]);
    expect(JSON.stringify(await journal.all())).not.toContain(KEY.secret);
    expect(JSON.stringify(entries)).not.toContain('Lumineux');
  });
});
