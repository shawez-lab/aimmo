-- D16 : une rétractation se juge sur le jour de son envoi. `received_at` reste le moment où elle a été reçue.
ALTER TABLE mandate_withdrawals ADD COLUMN sent_on TEXT;
