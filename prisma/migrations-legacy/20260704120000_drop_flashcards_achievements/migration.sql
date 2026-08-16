-- DropForeignKey
ALTER TABLE "achievements" DROP CONSTRAINT "achievements_userId_fkey";

-- DropForeignKey
ALTER TABLE "flashcards" DROP CONSTRAINT "flashcards_userId_fkey";

-- DropForeignKey
ALTER TABLE "review_items" DROP CONSTRAINT "review_items_itemId_fkey";

-- DropForeignKey
ALTER TABLE "review_items" DROP CONSTRAINT "review_items_userId_fkey";

-- DropTable
DROP TABLE "achievements";

-- DropTable
DROP TABLE "flashcards";

-- DropTable
DROP TABLE "review_items";
