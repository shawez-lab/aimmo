import { describe, expect, it } from 'vitest';
import { nextStep, type OfferStepFacts } from '../src/offres/index.ts';

const facts = (patch: Partial<OfferStepFacts>): OfferStepFacts => ({ state: 'recue', transmitted: false, last: null, file: null, otherTaken: false, ...patch });
const answered = (outcome: string) => ({ transmittedAt: '2027-03-01T10:00:00.000Z', response: { outcome, respondedAt: '2027-03-01T11:00:00.000Z' } }) as OfferStepFacts['last'];

describe('O10 · le prochain pas d’une offre', () => {
  it('[R56] une offre reçue, même échue, reste à transmettre au vendeur', () => {
    expect(nextStep(facts({}))).toBe('transmettre');
    expect(nextStep(facts({ state: 'echue' }))).toBe('transmettre');
  });

  it('[R57] le pas dit ce que la règle attend, sans jamais préjuger de la réponse', () => {
    expect(nextStep(facts({ state: 'transmise', transmitted: true }))).toBe('reponse_vendeur');
    expect(nextStep(facts({ state: 'refusee', transmitted: true }))).toBe('aucun');
  });

  it('[R59] échue sans réponse : la réponse donnée à temps reste à rapporter, pour l’offre comme pour sa dernière proposition', () => {
    expect(nextStep(facts({ state: 'echue', transmitted: true }))).toBe('reponse_vendeur');
    expect(nextStep(facts({ state: 'echue', transmitted: true, last: { transmittedAt: null, response: null } }))).toBe('transmettre_proposition');
    expect(nextStep(facts({ state: 'echue', transmitted: true, last: { transmittedAt: '2027-03-01T10:00:00.000Z', response: null } }))).toBe('reponse_proposition');
  });

  it('suit la chaîne des contre-offres', () => {
    const c = (last: OfferStepFacts['last']) => nextStep(facts({ state: 'contre_offre', transmitted: true, last }));
    expect(c(null)).toBe('ranger_proposition');
    expect(c({ transmittedAt: null, response: null })).toBe('transmettre_proposition');
    expect(c({ transmittedAt: '2027-03-01T10:00:00.000Z', response: null })).toBe('reponse_proposition');
    expect(c(answered('contre_offre'))).toBe('ranger_proposition');
  });

  it('[R58] après une acceptation : le dossier, puis le compromis, une seule offre à la fois', () => {
    expect(nextStep(facts({ state: 'acceptee', transmitted: true }))).toBe('ouvrir_dossier');
    expect(nextStep(facts({ state: 'acceptee', transmitted: true, otherTaken: true }))).toBe('aucun');
    expect(nextStep(facts({ state: 'acceptee', transmitted: true, file: { compromisStarted: false } }))).toBe('preparer_compromis');
    expect(nextStep(facts({ state: 'acceptee', transmitted: true, file: { compromisStarted: true } }))).toBe('aucun');
  });
});
