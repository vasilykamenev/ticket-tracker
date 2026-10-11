-- AlterTable: reconcile ages a row from its last state change. Existing rows start from their creation time.
ALTER TABLE "Attachment" ADD COLUMN "stateChangedAt" TIMESTAMPTZ(6);
UPDATE "Attachment" SET "stateChangedAt" = "createdAt";
ALTER TABLE "Attachment" ALTER COLUMN "stateChangedAt" SET NOT NULL, ALTER COLUMN "stateChangedAt" SET DEFAULT CURRENT_TIMESTAMP;
