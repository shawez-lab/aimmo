import { describe, expect, it } from 'vitest';
import { MemoryJournalStore } from '../src/index.ts';
import { CHAMPS_PROPRIETAIRE, EspaceProprietaire, NON_COMMUNIQUE, type ClientViewer, type OwnerApplication, type OwnerValue, type SourcesProprietaire } from '../src/espaces/index.ts';

const NOW = new Date('2027-08-10T08:00:00.000Z');
// Candidats et garants inventés.
const CANDIDAT_A = { personId: 'p-cand-a', firstName: 'Anatole', lastName: 'Inventé', emails: ['anatole.invente@example.test'], phones: ['0611223344'] };
const GARANT_A = { personId: 'p-garant-a', firstName: 'Philomène', lastName: 'Caution', emails: [], phones: [] };
const CANDIDAT_B = { personId: 'p-cand-b', firstName: 'Zélie', lastName: 'Fictive', emails: ['zelie.fictive@example.test'], phones: [] };

function apps(): OwnerApplication[] {
  // Rendues dans le désordre, avec une note qu'une source aurait pu calculer : rien de cela ne doit sortir.
  return [
    { id: 'a2', receivedAt: '2027-08-03T09:00:00.000Z', complete: false, pieces: [{ holder: 'candidat', kind: 'bulletins_salaire' }], guarantors: 0, score: 92, persons: [CANDIDAT_B] },
    {
      id: 'a1',
      receivedAt: '2027-08-02T09:00:00.000Z',
      complete: true,
      pieces: [
        { holder: 'candidat', kind: 'contrat_travail' },
        { holder: 'caution', kind: 'avis_imposition' },
        // Pièces hors de la liste officielle, ou pas pour ce titulaire : jamais montrées [R162].
        { holder: 'candidat', kind: 'releve_bancaire' },
        { holder: 'candidat', kind: 'photo_identite' },
        { holder: 'caution', kind: 'quittances_loyer' },
        { holder: 'candidat', kind: 'toString' },
      ],
      guarantors: 1,
      score: 40,
      persons: [CANDIDAT_A, GARANT_A],
    },
  ];
}

function sources(over: Partial<{ value: OwnerValue | null; applications: OwnerApplication[]; state: string }> = {}): SourcesProprietaire {
  return {
    ownerPropertiesOf: async (_n, personId) => (personId === 'p-proprio' ? [{ propertyId: 'b1', reference: 'L-1', city: 'Dijon' }] : personId === 'p-autre' ? [{ propertyId: 'b2', reference: 'L-2', city: 'Dijon' }] : []),
    rentalsOf: async (_n, propertyId) => [{ rentalId: `r-${propertyId}`, propertyId, openedAt: '2027-08-01T08:00:00.000Z', state: over.state ?? 'candidatures', stateAt: '2027-08-01T08:00:00.000Z' }],
    applicationsOf: async () => over.applications ?? apps(),
    leaseOf: async () => ({ signedAt: '2027-08-09T15:00:00.000Z', startsOn: '2027-09-01', rentEur: 720, chargesEur: null }),
    inspectionsOf: async () => [{ kind: 'entree', signedAt: null }],
    valueOf: async () => (over.value === undefined ? { tracking: true, city: 'Dijon', lowEur: 2_900, highEur: 3_400, computedAt: '2027-07-01T06:00:00.000Z', sources: ['ventes publiques DVF, publication d’avril 2027'] } : over.value),
    documentsOf: async (_n, _p, propertyId) => [
      { id: 'd2', propertyId, title: 'Bail signé', kind: 'bail', addedAt: '2027-08-09T15:00:00.000Z' },
      { id: 'd1', propertyId, title: 'Diagnostic de performance énergétique', kind: 'diagnostic', addedAt: '2027-07-20T10:00:00.000Z' },
      { id: 'dx', propertyId: 'b2', title: 'Document d’un autre bien', kind: 'bail', addedAt: '2027-07-20T10:00:00.000Z' },
    ],
  };
}

const viewer = (personId = 'p-proprio', sides: ClientViewer['sides'] = ['bailleur']): ClientViewer => ({ kind: 'client', networkId: 'n1', personId, sessionId: 's-1', sides });

describe('EC03 · espace du propriétaire', () => {
  it('[R162] [R14] candidatures dans l’ordre d’arrivée, sans note ni tri, sans pièce hors de la liste officielle', async () => {
    const espace = new EspaceProprietaire(sources(), new MemoryJournalStore(), { now: () => NOW });
    const r = await espace.bien(viewer(), 'b1');
    if (!r.ok) throw new Error('vue');
    const list = r.value.rentals[0]!.applications;
    // Seul le dossier complet est présenté ; l'incomplet n'est qu'un nombre, et ne prend pas de rang [R105].
    expect(list.map((a) => [a.rank, a.receivedAt.value, a.complete.value, a.guarantors])).toEqual([[1, '2027-08-02T09:00:00.000Z', true, 1]]);
    expect(r.value.rentals[0]!.waiting).toBe(1);
    // Les pièces du candidat seulement, de la liste officielle ; celles du garant ne sont pas présentées.
    expect(list[0]!.pieces).toEqual([{ holder: 'candidat', label: 'Contrat de travail ou de stage, ou attestation de l’employeur' }]);
    expect(Object.keys(list[0]!).sort()).toEqual([...CHAMPS_PROPRIETAIRE.candidature].sort());
    const text = JSON.stringify(r.value);
    for (const secret of ['score', '92', '"40"', 'releve', 'photo', 'caution', 'imposition', 'bulletins', '2027-08-03T09', 'Anatole', 'Inventé', 'Philomène', 'Zélie', 'example.test', '0611', 'p-cand', 'p-garant']) expect(text).not.toContain(secret);
  });

  it('[R161] [R16] le propriétaire ne voit que ses biens et leurs documents, au même endroit, dans l’ordre des dates', async () => {
    const espace = new EspaceProprietaire(sources(), new MemoryJournalStore(), { now: () => NOW });
    const all = await espace.vue(viewer('p-proprio', ['vendeur']));
    expect(all.ok && all.value.map((b) => b.reference)).toEqual(['L-1']);
    if (!all.ok) return;
    expect(all.value[0]!.documents.map((d) => d.title)).toEqual(['Diagnostic de performance énergétique', 'Bail signé']);
    expect(await espace.bien(viewer(), 'b2')).toEqual({ ok: false, rule: 'R161', code: 'not_party' });
    expect(await espace.vue(viewer('p-proprio', ['acquereur', 'candidat_locataire']))).toEqual({ ok: false, rule: 'R161', code: 'side' });
  });

  it('[R163] [R31] la valeur suivie, seulement si le suivi est demandé et en cours : la fourchette de la commune, avec sa date et ses sources', async () => {
    const shown = await new EspaceProprietaire(sources(), new MemoryJournalStore(), { now: () => NOW }).bien(viewer(), 'b1');
    expect(shown.ok && shown.value.value).toEqual({
      city: 'Dijon',
      range: { value: { lowEur: 2_900, highEur: 3_400 }, source: 'suivi de valeur de la commune', at: '2027-07-01T06:00:00.000Z' },
      sources: ['ventes publiques DVF, publication d’avril 2027'],
    });
    for (const value of [null, { tracking: false, city: 'Dijon', lowEur: 2_900, highEur: 3_400, computedAt: '2027-07-01T06:00:00.000Z', sources: [] }, { tracking: true, city: 'Dijon', lowEur: 3_500, highEur: 3_400, computedAt: '2027-07-01T06:00:00.000Z', sources: ['DVF'] },
      // Une autre commune que celle du bien, ou sans aucune source : rien n'est montré.
      { tracking: true, city: 'Chenôve', lowEur: 2_900, highEur: 3_400, computedAt: '2027-07-01T06:00:00.000Z', sources: ['DVF'] },
      { tracking: true, city: 'Dijon', lowEur: 2_900, highEur: 3_400, computedAt: '2027-07-01T06:00:00.000Z', sources: [] },
    ]) {
      const r = await new EspaceProprietaire(sources({ value }), new MemoryJournalStore(), { now: () => NOW }).bien(viewer(), 'b1');
      expect(r.ok && r.value.value).toBeNull();
    }
  });

  it('[R163] bail et état des lieux avec leur source et leur date ; une donnée absente est « non communiquée »', async () => {
    const r = await new EspaceProprietaire(sources(), new MemoryJournalStore(), { now: () => NOW }).bien(viewer(), 'b1');
    if (!r.ok) throw new Error('vue');
    const rental = r.value.rentals[0]!;
    expect(rental.lease.rent).toEqual({ value: 720, source: 'bail signé', at: '2027-08-09T15:00:00.000Z' });
    expect(rental.lease.charges).toEqual({ value: null, label: NON_COMMUNIQUE });
    expect(rental.inspections).toEqual([{ kind: 'entree', signedAt: { value: null, label: NON_COMMUNIQUE } }]);
    expect(Object.keys(rental).sort()).toEqual([...CHAMPS_PROPRIETAIRE.location].sort());
  });

  it('[R161] [R06] un texte qui cite un candidat ou un garant, ou parle de l’IA, est retenu ; le journal compte sans citer [R13]', async () => {
    const journal = new MemoryJournalStore();
    const espace = new EspaceProprietaire(sources({ state: 'choisi : Philomène se porte caution' }), journal, { now: () => NOW });
    const r = await espace.bien(viewer(), 'b1');
    if (!r.ok) throw new Error('vue');
    expect(r.value.rentals[0]!.state).toEqual({ value: null, label: NON_COMMUNIQUE });
    const ia = await new EspaceProprietaire(sources({ state: 'trié par l’IA' }), journal, { now: () => NOW }).bien(viewer(), 'b1');
    expect(ia.ok && ia.value.rentals[0]!.state).toEqual({ value: null, label: NON_COMMUNIQUE });
    const entries = await journal.all();
    expect(entries.map((e) => e.data)).toEqual([
      { rule: 'R161', side: 'proprietaire', property: 'b1', retained: 1 },
      { rule: 'R161', side: 'proprietaire', property: 'b1', retained: 1 },
    ]);
    expect(JSON.stringify(entries)).not.toMatch(/Philomène|IA/);
  });

  it('[R06] [R161] une source de la valeur qui parle de l’IA ou cite un candidat est retenue', async () => {
    const value = { tracking: true, city: 'Dijon', lowEur: 2_900, highEur: 3_400, computedAt: '2027-07-01T06:00:00.000Z', sources: ['ventes publiques DVF', 'estimation affinée par l’IA', 'vente Zélie Fictive'] };
    const r = await new EspaceProprietaire(sources({ value }), new MemoryJournalStore(), { now: () => NOW }).bien(viewer(), 'b1');
    expect(r.ok && r.value.value?.sources).toEqual(['ventes publiques DVF', NON_COMMUNIQUE, NON_COMMUNIQUE]);
  });
});
