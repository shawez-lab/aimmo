/**
 * Jeu de preuves de mise en service, toutes inventées (AU088) : numéros, émetteurs et références ne désignent rien de
 * réel. `day` est le jour de la relecture des mentions, jamais avant leur dernier changement.
 */
export function launchProofInputs(day: string, cardNumber: string): Record<string, unknown>[] {
  return [
    { prerequisite: 'carte', documentNumber: cardNumber, issuer: 'Chambre inventée', proofRef: 'preuve-carte-inventee', validFrom: '2026-01-01', validUntil: '2028-12-31' },
    { prerequisite: 'garantie', documentNumber: 'GAR-0000', issuer: 'Garant inventé', proofRef: 'preuve-garantie-inventee', validFrom: '2026-01-01', validUntil: '2027-12-31' },
    { prerequisite: 'assurance', documentNumber: 'RCP-0000', issuer: 'Assureur inventé', proofRef: 'preuve-assurance-inventee', validFrom: '2026-01-01', validUntil: '2027-12-31' },
    { prerequisite: 'mediateur', documentNumber: 'MED-0000', issuer: 'Médiateur inventé', proofRef: 'preuve-mediateur-inventee', validFrom: '2026-01-01', validUntil: '2027-12-31' },
    { prerequisite: 'mentions', documentNumber: 'RELECTURE-0000', issuer: 'Cabinet inventé', proofRef: 'preuve-relecture-inventee', validFrom: day },
  ];
}
