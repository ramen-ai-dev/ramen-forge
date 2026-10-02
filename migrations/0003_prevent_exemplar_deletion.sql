-- Migration number: 0003 	 append-only exemplars
-- Enforce append-only invariant on community domain memory
CREATE TRIGGER IF NOT EXISTS prevent_exemplar_deletion
BEFORE DELETE ON exemplars
BEGIN
    SELECT RAISE(FAIL, 'Deletions from the exemplars table are permanently prohibited.');
END;
