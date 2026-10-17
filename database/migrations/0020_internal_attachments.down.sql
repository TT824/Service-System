-- Reverting 0020 removes the attachment rows. The bytes they name stay in the
-- object store — this migration never touched them — so a rollback leaves
-- orphans under `tenants/<tenant>/internal-attachments/` that nothing reads.
-- Named here because a rollback that silently leaks objects is worth knowing
-- about before running it, not after.

DROP TABLE IF EXISTS internal_attachments;
