/** Les pièces qui prouvent l'identité d'une personne physique (D03, L01, L03). Sans dépendance, pour éviter les cycles. */
export const IDENTITY_PIECES = ['carte_identite', 'passeport', 'permis_conduire'] as const;
export type IdentityPiece = (typeof IDENTITY_PIECES)[number];
