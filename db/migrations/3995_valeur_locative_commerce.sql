-- AU102 · Un local ou des murs libres s'estiment sur leur valeur locative de marché, saisie avec ce qui la fonde, jamais
-- sur un bail inventé. Colonnes vides pour les fiches d'avant [R17] ; confidentielles comme le reste de la fiche [R110].
ALTER TABLE business_sheets ADD COLUMN market_annual_rent_cents INTEGER CHECK (market_annual_rent_cents IS NULL OR market_annual_rent_cents > 0);
ALTER TABLE business_sheets ADD COLUMN market_rent_basis TEXT CHECK (market_rent_basis IS NULL OR length(market_rent_basis) BETWEEN 5 AND 300);
