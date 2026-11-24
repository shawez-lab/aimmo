import { describe, expect, it } from 'vitest';
import { MemoryJournalStore } from '../src/index.ts';
import { CHAMPS_VENDEUR, EspaceVendeur, NON_COMMUNIQUE, citesPerson, speaksOfAi, type ClientViewer, type SellerOffer, type SellerProperty, type SellerVisit, type SourcesVendeur } from '../src/espaces/index.ts';

const NOW = new Date('2027-06-08T08:00:00.000Z');

// Personnes et biens inventés.
const VISITEUR = { personId: 'p-visiteur', firstName: 'Bérénice', lastName: 'Inventée-Martel', emails: ['berenice.inventee@example.test'], phones: ['+33 6 12 34 56 78'] };
const ACQUEREUR = { personId: 'p-acquereur', firstName: 'Octave', lastName: 'Fictif', emails: ['octave.fictif@example.test'], phones: ['0699887766'] };

function property(id: string, over: Partial<SellerProperty> = {}): SellerProperty {
  return { propertyId: id, reference: `B-${id}`, city: 'Dijon', status: 'available', statusAt: '2027-05-02T09:00:00.000Z', askingPriceEur: 245_000, mandateSignedAt: '2027-05-01T10:00:00.000Z', ...over };
}

function sources(over: Partial<{ properties: Record<string, SellerProperty[]>; visits: SellerVisit[]; offers: SellerOffer[]; weekly: { weekOf: string; text: string; validatedAt: string | null }[] }> = {}): SourcesVendeur & { calls: string[] } {
  const calls: string[] = [];
  const props = over.properties ?? { 'p-vendeur': [property('b1')], 'p-autre': [property('b2')] };
  return {
    calls,
    sellerPropertiesOf: async (_n, personId) => props[personId] ?? [],
    visitsOf: async (_n, propertyId) => {
      calls.push(`visits:${propertyId}`);
      return (
        over.visits ?? [
          { id: 'v2', at: '2027-06-05T14:00:00.000Z', state: 'faite', report: { text: 'Visite de 40 minutes. Lumineux, le visiteur a aimé le séjour ; réserve sur la cuisine.', interest: 'intéressé', validatedAt: '2027-06-05T18:00:00.000Z' }, visitor: VISITEUR },
          { id: 'v1', at: '2027-06-01T10:00:00.000Z', state: 'faite', report: null, visitor: ACQUEREUR },
          { id: 'v3', at: '2027-06-10T09:00:00.000Z', state: 'prevue', report: null, visitor: VISITEUR },
        ]
      );
    },
    offersOf: async () =>
      over.offers ?? [
        { id: 'o1', receivedAt: '2027-06-06T11:00:00.000Z', amountEur: 238_000, netSellerEur: 228_480, conditions: ['prêt immobilier'], validUntil: '2027-06-13T11:00:00.000Z', state: 'transmise', stateAt: '2027-06-06T11:05:00.000Z', buyer: ACQUEREUR },
      ],
    documentsOf: async () => [
      { id: 'd1', title: 'Mandat de vente', kind: 'mandat', addedAt: '2027-05-01T10:00:00.000Z', signature: 'signe', signedAt: '2027-05-01T10:30:00.000Z' },
      { id: 'd2', title: 'Avenant de prix', kind: 'avenant', addedAt: '2027-06-07T10:00:00.000Z', signature: 'a_signer', signedAt: null },
    ],
    appointmentsOf: async () => [{ id: 'r1', at: '2027-06-09T16:00:00.000Z', kind: 'point avec l’agent', state: 'confirme' }],
    weeklyPointsOf: async () =>
      over.weekly ?? [
        { weekOf: '2027-06-07', text: 'Cette semaine : 3 visites, 1 offre reçue.', validatedAt: '2027-06-07T07:30:00.000Z' },
        { weekOf: '2027-05-31', text: 'Brouillon pas encore validé.', validatedAt: null },
      ],
    earliestDeedOf: async () => ({ date: null, holds: [{ label: 'offre pas encore acceptée' }], computedAt: '2027-06-08T06:00:00.000Z' }),
  };
}

const viewer = (personId = 'p-vendeur', sides: ClientViewer['sides'] = ['vendeur']): ClientViewer => ({ kind: 'client', networkId: 'n1', personId, sessionId: 's-1', sides });

describe('EC02 · espace du vendeur', () => {
  it('[R161] [R16] le vendeur ne voit que ses biens ; un autre bien est refusé sans rien dire de lui', async () => {
    const src = sources();
    const espace = new EspaceVendeur(src, new MemoryJournalStore(), { now: () => NOW });
    const all = await espace.vue(viewer());
    expect(all.ok && all.value.map((b) => b.reference)).toEqual(['B-b1']);
    expect(await espace.bien(viewer(), 'b2')).toEqual({ ok: false, rule: 'R161', code: 'not_party' });
    expect(await espace.bien(viewer(), 'inconnu')).toEqual({ ok: false, rule: 'R161', code: 'not_party' });
    // Le bien d'un autre n'a même pas été lu.
    expect(src.calls).not.toContain('visits:b2');
    expect(await espace.vue(viewer('p-vendeur', ['acquereur']))).toEqual({ ok: false, rule: 'R161', code: 'side' });
    expect(await espace.bien(viewer('p-inconnu'), 'b1')).toEqual({ ok: false, rule: 'R161', code: 'not_party' });
  });

  it('[R161] ni nom ni coordonnée d’un visiteur ou d’un acquéreur, champ par champ selon la liste écrite', async () => {
    const espace = new EspaceVendeur(sources(), new MemoryJournalStore(), { now: () => NOW });
    const r = await espace.bien(viewer(), 'b1');
    if (!r.ok) throw new Error('vue');
    const text = JSON.stringify(r.value);
    for (const secret of ['p-visiteur', 'p-acquereur', 'Bérénice', 'Inventée', 'Octave', 'Fictif', 'example.test', '12 34 56', '0699887766', 'buyer', 'visitor']) {
      expect(text).not.toContain(secret);
    }
    // Chaque rubrique ne porte que ses champs écrits.
    expect(Object.keys(r.value.visits[0]!).sort()).toEqual([...CHAMPS_VENDEUR.visite].sort());
    expect(Object.keys(r.value.offers[0]!).sort()).toEqual([...CHAMPS_VENDEUR.offre].sort());
    expect(Object.keys(r.value.documents[0]!).sort()).toEqual([...CHAMPS_VENDEUR.document].sort());
    expect(Object.keys(r.value.appointments[0]!).sort()).toEqual([...CHAMPS_VENDEUR.rendezVous].sort());
    expect(Object.keys(r.value.weeklyPoints[0]!).sort()).toEqual([...CHAMPS_VENDEUR.point].sort());
    expect(Object.keys(r.value.deed).sort()).toEqual([...CHAMPS_VENDEUR.acte].sort());
  });

  it('[R161] [R06] un texte qui cite une personne venue pour le bien, ou parle de l’IA, est retenu', async () => {
    const journal = new MemoryJournalStore();
    const espace = new EspaceVendeur(
      sources({
        visits: [
          { id: 'v1', at: '2027-06-01T10:00:00.000Z', state: 'faite', report: { text: 'Mme berenice a adoré.', interest: 'intéressée', validatedAt: '2027-06-01T18:00:00.000Z' }, visitor: VISITEUR },
          { id: 'v2', at: '2027-06-02T10:00:00.000Z', state: 'faite', report: { text: 'Rappeler au 06 12 34 56 78.', interest: null, validatedAt: '2027-06-02T18:00:00.000Z' }, visitor: VISITEUR },
          { id: 'v3', at: '2027-06-03T10:00:00.000Z', state: 'faite', report: { text: 'Résumé rédigé par l’IA.', interest: null, validatedAt: '2027-06-03T18:00:00.000Z' }, visitor: null },
          { id: 'v4', at: '2027-06-04T10:00:00.000Z', state: 'faite', report: { text: 'Le visiteur hésite entre deux biens.', interest: 'à revoir', validatedAt: '2027-06-04T18:00:00.000Z' }, visitor: ACQUEREUR },
        ],
        offers: [{ id: 'o1', receivedAt: '2027-06-06T11:00:00.000Z', amountEur: 238_000, netSellerEur: null, conditions: ['accord de la banque de M. Fictif'], validUntil: null, state: 'transmise', stateAt: '2027-06-06T11:00:00.000Z', buyer: ACQUEREUR }],
        weekly: [{ weekOf: '2027-06-07', text: 'Octave a visité deux fois.', validatedAt: '2027-06-07T07:30:00.000Z' }],
      }),
      journal,
      { now: () => NOW },
    );
    const r = await espace.bien(viewer(), 'b1');
    if (!r.ok) throw new Error('vue');
    expect(r.value.visits.map((v) => v.report.value)).toEqual([null, null, null, 'Le visiteur hésite entre deux biens.']);
    expect(r.value.visits[0]!.report).toEqual({ value: null, label: NON_COMMUNIQUE });
    expect(r.value.offers[0]!.conditions).toEqual({ value: null, label: NON_COMMUNIQUE });
    expect(r.value.weeklyPoints[0]!.text).toEqual({ value: null, label: NON_COMMUNIQUE });
    const text = JSON.stringify(r.value);
    expect(text).not.toMatch(/berenice|Fictif|Octave|12 34|IA/);
    // Le journal compte les textes retenus, sans les citer [R13].
    const entries = await journal.all();
    expect(entries.at(-1)!.data).toMatchObject({ rule: 'R161', side: 'vendeur', property: 'b1', retained: 5 });
    expect(JSON.stringify(entries)).not.toMatch(/berenice|Octave|adoré/i);
  });

  it('[R163] chaque chiffre et chaque date avec sa source et sa date ; une donnée absente est « non communiquée »', async () => {
    const espace = new EspaceVendeur(
      sources({ properties: { 'p-vendeur': [property('b1', { askingPriceEur: null, mandateSignedAt: null })] } }),
      new MemoryJournalStore(),
      { now: () => NOW },
    );
    const r = await espace.bien(viewer(), 'b1');
    if (!r.ok) throw new Error('vue');
    expect(r.value.price).toEqual({ value: null, label: NON_COMMUNIQUE });
    expect(r.value.status).toEqual({ value: 'available', source: 'fiche du bien', at: '2027-05-02T09:00:00.000Z' });
    expect(r.value.offers[0]!.amount).toEqual({ value: 238_000, source: 'registre des offres', at: '2027-06-06T11:00:00.000Z' });
    expect(r.value.offers[0]!.netSeller).toEqual({ value: 228_480, source: 'mandat en vigueur', at: '2027-06-06T11:00:00.000Z' });
    expect(r.value.deed.date).toEqual({ value: null, label: NON_COMMUNIQUE });
    expect(r.value.deed.holds).toEqual({ value: ['offre pas encore acceptée'], source: 'échéancier du dossier', at: '2027-06-08T06:00:00.000Z' });
    // Un compte rendu absent, un point non validé : non communiqués, jamais inventés.
    expect(r.value.visits.map((v) => v.report.value)).toEqual([null, 'Visite de 40 minutes. Lumineux, le visiteur a aimé le séjour ; réserve sur la cuisine.', null]);
    expect(r.value.weeklyPoints.map((w) => w.text.value)).toEqual(['Cette semaine : 3 visites, 1 offre reçue.', null]);
    // Toute valeur montrée porte une source et une date.
    const walk = (x: unknown): void => {
      if (x && typeof x === 'object') {
        if ('value' in x && (x as { value: unknown }).value !== null) {
          expect(x).toHaveProperty('source');
          expect((x as unknown as { at: string }).at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        }
        for (const v of Object.values(x)) walk(v);
      }
    };
    walk(r.value);
    // Visites, offres, documents dans l'ordre des dates, sans tri par une note.
    expect(r.value.visits.map((v) => v.at.value)).toEqual(['2027-06-01T10:00:00.000Z', '2027-06-05T14:00:00.000Z', '2027-06-10T09:00:00.000Z']);
    expect(r.value.documents.map((d) => [d.title, d.signature.value])).toEqual([['Mandat de vente', 'signé'], ['Avenant de prix', 'à signer']]);
  });

  it('[R163] l’état d’une visite et la signature d’un document sont écrits en français, jamais avec le code des sources (DS078)', async () => {
    const base = sources();
    const vue = async (over: Partial<SourcesVendeur>) => {
      const r = await new EspaceVendeur({ ...base, ...over }, new MemoryJournalStore(), { now: () => NOW }).bien(viewer(), 'b1');
      if (!r.ok) throw new Error('vue');
      return r.value;
    };
    // Une valeur, un mot.
    for (const [code, mot] of [['prevue', 'prévue'], ['faite', 'faite'], ['annulee', 'annulée']] as const) {
      const v = await vue({ visitsOf: async () => [{ id: 'v1', at: '2027-06-10T09:00:00.000Z', state: code, report: null, visitor: null }] });
      expect(v.visits[0]!.state).toEqual({ value: mot, source: 'agenda du bien', at: '2027-06-10T09:00:00.000Z' });
    }
    for (const [code, mot] of [['sans', 'pas à signer'], ['a_signer', 'à signer'], ['signe', 'signé']] as const) {
      const v = await vue({ documentsOf: async () => [{ id: 'd1', title: 'Mandat de vente', kind: 'mandat', addedAt: '2027-05-01T10:00:00.000Z', signature: code, signedAt: code === 'signe' ? '2027-05-01T10:30:00.000Z' : null }] });
      expect(v.documents[0]!.signature).toMatchObject({ value: mot, source: 'dossier de vente' });
    }
    // Un code que la liste ne connaît pas n'est jamais montré tel quel.
    const inconnu = await vue({
      visitsOf: async () => [{ id: 'v1', at: '2027-06-10T09:00:00.000Z', state: 'no_show' as never, report: null, visitor: null }],
      documentsOf: async () => [{ id: 'd1', title: 'Mandat de vente', kind: 'mandat', addedAt: '2027-05-01T10:00:00.000Z', signature: 'pending' as never, signedAt: null }],
    });
    expect(inconnu.visits[0]!.state).toEqual({ value: null, label: NON_COMMUNIQUE });
    expect(inconnu.documents[0]!.signature).toEqual({ value: null, label: NON_COMMUNIQUE });
    // Aucun des codes ne sort de la vue du jeu de base.
    expect(JSON.stringify((await vue({})).visits.map((x) => x.state.value).concat((await vue({})).documents.map((d) => d.signature.value)))).not.toMatch(/prevue|annulee|a_signer|"signe"|"sans"/);
  });

  it('[R13] chaque lecture et chaque refus vont au journal, sans donnée personnelle', async () => {
    const journal = new MemoryJournalStore();
    const espace = new EspaceVendeur(sources(), journal, { now: () => NOW });
    await espace.vue(viewer());
    await espace.bien(viewer(), 'b2');
    const entries = (await journal.all()).map((e) => [e.type, e.subject, e.data]);
    expect(entries).toEqual([
      ['espaces.vue', 'person:p-vendeur', { rule: 'R161', side: 'vendeur', properties: 1, retained: 0 }],
      ['espaces.vue', 'person:p-vendeur', { rule: 'R161', side: 'vendeur', status: 'refuse', code: 'not_party' }],
    ]);
  });

  it('[R161] [R06] l’intérêt, les états, les sortes et les statuts passent aussi la retenue', async () => {
    const base = sources();
    const espace = new EspaceVendeur(
      {
        ...base,
        sellerPropertiesOf: async () => [property('b1', { status: 'réservé par Octave' })],
        visitsOf: async () => [{ id: 'v1', at: '2027-06-01T10:00:00.000Z', state: 'faite', report: { text: 'Bonne visite.', interest: 'Bérénice très intéressée', validatedAt: '2027-06-01T18:00:00.000Z' }, visitor: VISITEUR }],
        offersOf: async () => [{ id: 'o1', receivedAt: '2027-06-06T11:00:00.000Z', amountEur: 238_000, netSellerEur: null, conditions: [], validUntil: null, state: 'refusée par M. Fictif', stateAt: '2027-06-06T11:00:00.000Z', buyer: ACQUEREUR }],
        documentsOf: async () => [{ id: 'd1', title: 'Pièce', kind: 'piece_identite_octave_fictif', addedAt: '2027-05-01T10:00:00.000Z', signature: 'sans', signedAt: null }],
        appointmentsOf: async () => [{ id: 'r1', at: '2027-06-09T16:00:00.000Z', kind: 'point', state: 'proposé par l’I.A.' }],
      },
      new MemoryJournalStore(),
      { now: () => NOW },
    );
    const r = await espace.bien(viewer(), 'b1');
    if (!r.ok) throw new Error('vue');
    expect(r.value.status).toEqual({ value: null, label: NON_COMMUNIQUE });
    expect(r.value.visits[0]!.interest).toEqual({ value: null, label: NON_COMMUNIQUE });
    expect(r.value.offers[0]!.state).toEqual({ value: null, label: NON_COMMUNIQUE });
    expect(r.value.documents[0]!.kind).not.toMatch(/octave|fictif/i);
    expect(r.value.appointments[0]!.state).toEqual({ value: null, label: NON_COMMUNIQUE });
    expect(JSON.stringify(r.value)).not.toMatch(/octave|fictif|berenice|bérénice|I\.A\./i);
    expect(r.value.weeklyPoints[0]!.weekOf).toEqual({ value: '2027-06-07', source: 'point de la semaine validé par l’agent', at: '2027-06-07T07:30:00.000Z' });
  });

  it('[R06] reconnaît l’IA sous ses formes écrites', () => {
    for (const t of ['Rédigé par l’I.A. hier', 'Rédigé par l’I.A.', 'des intelligences artificielles', 'estimation automatique', 'selon l’IA', 'un assistant virtuel']) expect(speaksOfAi(t), t).toBe(true);
    for (const t of ['Visite lumineuse via le jardin', 'Mia a visité', 'Idéal pour une famille']) expect(speaksOfAi(t), t).toBe(false);
  });

  it('reconnaît un nom sans accents ni majuscules, un mail ou un téléphone écrit autrement', () => {
    expect(citesPerson('MARTEL viendra', [VISITEUR])).toBe(true);
    expect(citesPerson('écrire à Berenice.Inventee@Example.test', [VISITEUR])).toBe(true);
    expect(citesPerson('06.12.34.56.78', [VISITEUR])).toBe(true);
    expect(citesPerson('Une belle visite, lumineux.', [VISITEUR, ACQUEREUR])).toBe(false);
  });
});
