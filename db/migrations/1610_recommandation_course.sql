-- X26 : la garde du lot d'une recommandation de partenaire sur une fiche neuve. Cette table reste toujours vide : le lot
-- y tente une ligne interdite quand une coordonnée donnée vient d'arriver sur une fiche, ce qui l'annule en entier. Deux
-- envois simultanés ne font ainsi jamais deux fiches, deux projets ni deux accords [R142, R17].
CREATE TABLE IF NOT EXISTS partner_recommendation_race_guard (
  never INTEGER NOT NULL CHECK (never = 0)
);
