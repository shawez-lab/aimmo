-- V09 · La coordonnée choisie à la réservation (mail ou numéro, normalisé) : la confirmation et les rappels la visent,
-- même si la fiche en porte une autre plus ancienne. Elle doit rester une coordonnée de la fiche : le contrôle central
-- refuse sinon. NULL : la première coordonnée de la fiche pour le canal.
ALTER TABLE appointments ADD COLUMN confirmation_to TEXT;
