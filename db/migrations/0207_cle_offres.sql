-- O08 · Clé d'envoi d'une offre : un double envoi de la même offre (même clé, même bien) ne crée qu'une ligne au registre.
-- La clé n'entre pas dans l'empreinte de l'offre : ce n'est pas une donnée de l'offre, seulement une garde.
ALTER TABLE offer_register ADD COLUMN request_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS offer_register_request_key ON offer_register (property_id, request_key) WHERE request_key IS NOT NULL;
