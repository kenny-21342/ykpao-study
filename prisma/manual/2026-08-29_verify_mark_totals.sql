-- Run this BEFORE the update. It writes nothing.
--
-- The update joins on bank_papers."sourcePath", which holds the absolute path
-- the extractor saw. If production was ever loaded from a different checkout,
-- these will not match and the update would silently affect zero rows -- which
-- is exactly the failure mode that makes merge_to_neon.py useless here.
SELECT
  s.code                                                        AS subject,
  COUNT(*)                                                      AS questions,
  COUNT(*) FILTER (WHERE q."totalMarks" IS NULL)                AS still_null,
  COUNT(*) FILTER (WHERE q."totalMarks" IS NOT NULL)            AS already_set
FROM bank_questions q
JOIN bank_papers p   ON p.id = q."paperId"
JOIN bank_subjects s ON s.id = p."subjectId"
WHERE s.code IN ('0606','0478','0610','0620','0625')
  AND p."docType" = 'qp'
GROUP BY s.code
ORDER BY s.code;
