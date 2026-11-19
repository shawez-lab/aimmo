-- AU071 · Les équipements impératifs d'une recherche, éliminatoires au rapprochement ; AU115 · le budget dit
-- infranchissable, sans tolérance. Valeurs par défaut pour les versions d'avant [R17].
ALTER TABLE buyer_searches ADD COLUMN required_features TEXT NOT NULL DEFAULT '[]';
ALTER TABLE buyer_searches ADD COLUMN budget_strict INTEGER NOT NULL DEFAULT 0 CHECK (budget_strict IN (0, 1));
