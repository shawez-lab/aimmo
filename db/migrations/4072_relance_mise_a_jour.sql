-- AU094b · Une relance remplacée après un paiement partiel ne consomme pas l'un des trois rangs [R553].
-- Avant : une nouvelle part fermait la relance préparée ou validée, et la suivante prenait un rang ; après trois parts,
-- plus aucune relance ne se préparait. Désormais la relance qui n'est pas partie reste la même ligne, au même rang :
-- une nouvelle part la remet « à valider », sa validation levée, avec la règle `paiement_partiel` (texte à refaire) ;
-- le passage de préparation refait son texte au reste à jour et lève la règle. La direction valide alors le nouveau
-- texte, et seul ce texte part. Rien d'autre ne change : une relance partie, close ou refusée reste figée.
DROP TRIGGER IF EXISTS invoice_reminders_validation;
CREATE TRIGGER IF NOT EXISTS invoice_reminders_validation
BEFORE UPDATE OF status ON invoice_reminders
WHEN (NEW.status = 'validee' AND (OLD.status NOT IN ('a_valider', 'validee') OR NEW.rule IS 'paiement_partiel'))
  OR (NEW.status = 'envoyee' AND (OLD.status <> 'validee' OR NEW.validated_by IS NULL))
  OR (NEW.status = 'refusee' AND OLD.status NOT IN ('validee', 'refusee'))
  -- Le seul retour à « à valider » : une validée pas encore en envoi, remise à valider par une nouvelle part.
  OR (NEW.status = 'a_valider' AND OLD.status <> 'a_valider'
      AND NOT (OLD.status = 'validee' AND OLD.sending_at IS NULL AND NEW.rule IS 'paiement_partiel' AND NEW.validated_by IS NULL AND NEW.validated_at IS NULL))
  OR (OLD.status IN ('envoyee', 'close', 'refusee') AND NEW.status <> OLD.status)
BEGIN SELECT RAISE(ABORT, 'invoice_reminders : aucune relance sans validation'); END;

DROP TRIGGER IF EXISTS invoice_reminders_validation_figee;
CREATE TRIGGER IF NOT EXISTS invoice_reminders_validation_figee
BEFORE UPDATE OF validated_by, validated_at ON invoice_reminders
WHEN OLD.validated_by IS NOT NULL AND (NEW.validated_by IS NOT OLD.validated_by OR NEW.validated_at IS NOT OLD.validated_at)
  AND NOT (OLD.status = 'validee' AND NEW.status = 'a_valider' AND NEW.rule IS 'paiement_partiel' AND NEW.validated_by IS NULL AND NEW.validated_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'invoice_reminders : la validation ne change pas'); END;

DROP TRIGGER IF EXISTS invoice_reminders_texte_fige;
CREATE TRIGGER IF NOT EXISTS invoice_reminders_texte_fige
BEFORE UPDATE OF text, invoice_id, person_id, rank, network_id, prepared_at ON invoice_reminders
WHEN NEW.invoice_id IS NOT OLD.invoice_id OR NEW.person_id IS NOT OLD.person_id OR NEW.rank IS NOT OLD.rank OR NEW.network_id IS NOT OLD.network_id
  -- Le texte ne se refait que sur une relance à valider dont le texte est à refaire, jamais une fois validée.
  OR ((NEW.text IS NOT OLD.text OR NEW.prepared_at IS NOT OLD.prepared_at)
      AND NOT (OLD.status = 'a_valider' AND NEW.status = 'a_valider' AND OLD.rule IS 'paiement_partiel' AND NEW.validated_by IS NULL))
BEGIN SELECT RAISE(ABORT, 'invoice_reminders : le texte validé ne change pas'); END;
