-- CreateTable
CREATE TABLE "cloud_documents" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'Untitled',
    "format" TEXT NOT NULL DEFAULT 'hybrid',
    "body" TEXT NOT NULL DEFAULT '',
    "blocks" JSONB,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cloud_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cloud_documents_ownerId_updatedAt_idx" ON "cloud_documents"("ownerId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "cloud_documents_ownerId_clientId_key" ON "cloud_documents"("ownerId", "clientId");

-- AddForeignKey
ALTER TABLE "cloud_documents" ADD CONSTRAINT "cloud_documents_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

