# School resource folders

The Resource Library opens in folder view. The admin resource manager and both
upload dialogs can navigate and create nested folders. A directory upload keeps
its relative tree under the selected destination. Large folders are paged.

`SchoolResourceFolder` is the shared tree. New resource objects use
`uploads/{files|images}/resources/<folder-id>/<uuid>.<ext>`, while the database
stores the folder relation and the complete URL. Folder IDs keep object keys
stable when a folder is renamed. Older flat URLs remain readable and deletable.

## Existing data

The folder schema was introduced by migration
`20260908140000_school_resource_folders`. Check that migrations are applied
before deploying the UI.

1. Run `npx tsx scripts/backfill-school-resource-folders.ts` to preview old
   directory uploads recorded in descriptions, then rerun with `--apply`.
2. Run `npx tsx scripts/organize-school-resource-root.ts` to preview remaining
   unfiled resources. It groups them by `Subject/Category/Year/Month`; missing
   metadata becomes `Unsorted/General/Year/Month`. Review the preview, then
   rerun with `--apply`.
3. Run `npm run rag:index` after filing existing resources so search titles
   include the new folder paths.

The organizer changes folder relations only. Existing stored object URLs remain
valid in their original location. New uploads use folder-based object keys.
