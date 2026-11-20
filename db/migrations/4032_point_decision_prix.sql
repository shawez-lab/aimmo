-- AU078 · Le point de la semaine peut consigner une décision de repositionnement du prix déjà convenue avec le vendeur,
-- validée explicitement par l'agent et liée au rendez-vous tenu avec lui [R53]. Elle ne déclenche rien : ni l'annonce,
-- ni le mandat, ni un message à un acquéreur ne changent.
--
-- `price_decision` : JSON `{ appointmentId, kind, day, priceEur }`, figé avec le point une fois validé ; NULL sans décision.
ALTER TABLE weekly_points ADD COLUMN price_decision TEXT;
DROP TRIGGER IF EXISTS weekly_points_fige;
CREATE TRIGGER IF NOT EXISTS weekly_points_fige
BEFORE UPDATE ON weekly_points
WHEN OLD.status = 'valide' AND (NEW.figures IS NOT OLD.figures OR NEW.next_actions IS NOT OLD.next_actions OR NEW.status IS NOT OLD.status OR NEW.validated_at IS NOT OLD.validated_at OR NEW.price_decision IS NOT OLD.price_decision)
BEGIN
  SELECT RAISE(ABORT, 'point validé : figé');
END;
