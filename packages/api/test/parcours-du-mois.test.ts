import { describe, expect, it } from 'vitest';
import type { JourneyReceipt } from '@aimmo/core';
import { journeyLine, recordJourney } from '../outils/parcours-du-mois.ts';

// Tout est inventé.
const at = new Date('2027-03-03T04:23:00.000Z');

describe('BR72 · le second travail du parcours du mois', () => {
  it('le parcours réussi : le reçu est rangé, le travail passe', async () => {
    const kept: JourneyReceipt[] = [];
    const said: string[] = [];
    expect(await recordJourney({ jobResult: 'success', said: 'aucune', now: at, id: 'a' }, async (r) => { kept.push(r); }, (t) => said.push(t))).toBe(0);
    expect(kept).toEqual([{ id: 'a', ranAt: at.toISOString(), month: '2027-03', outcome: 'reussi' }]);
    expect(said).toEqual(['Parcours du mois réussi : toutes les étapes ont passé.']);
  });

  it('le parcours cassé : le reçu raté est rangé avec son étape, et le travail de rangement passe quand même', async () => {
    const kept: JourneyReceipt[] = [];
    const said: string[] = [];
    expect(await recordJourney({ jobResult: 'failure', said: 'offre', now: at, id: 'a' }, async (r) => { kept.push(r); }, (t) => said.push(t))).toBe(0);
    expect(kept[0]).toMatchObject({ outcome: 'rate', step: 'offre' });
    expect(said).toEqual(["Parcours du mois raté à l'étape offre."]);
  });

  it('[R13] une étape illisible n’est jamais recopiée, ni au reçu ni à la sortie', async () => {
    const kept: JourneyReceipt[] = [];
    const said: string[] = [];
    await recordJourney({ jobResult: 'failure', said: 'lea.vendeuse@example.test', now: at, id: 'a' }, async (r) => { kept.push(r); }, (t) => said.push(t));
    expect(kept[0]).toMatchObject({ outcome: 'rate', step: null });
    expect(said).toEqual(['Parcours du mois raté, étape inconnue.']);
    expect(JSON.stringify(kept) + said.join('')).not.toContain('lea.vendeuse');
  });

  it('un reçu non rangé fait échouer le travail, sans recopier l’erreur', async () => {
    const said: string[] = [];
    expect(await recordJourney({ jobResult: 'success', said: 'aucune', now: at, id: 'a' }, async () => { throw new Error('panne inventée'); }, (t) => said.push(t))).toBe(1);
    expect(said.join(' ')).toContain('Reçu non rangé');
    expect(said.join(' ')).not.toContain('panne inventée');
  });

  it('la ligne de sortie ne dit qu’un résultat et une étape', () => {
    expect(journeyLine({ id: 'a', ranAt: 't', month: '2027-03', outcome: 'rate', step: 'apres_vente' })).toBe("Parcours du mois raté à l'étape apres_vente.");
  });
});
