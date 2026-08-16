-- AlterTable
ALTER TABLE "users" ADD COLUMN     "unlocks" TEXT[] DEFAULT ARRAY[]::TEXT[];

