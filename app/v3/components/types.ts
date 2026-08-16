export type V3AssetView = {
  id: string;
  url: string;
  sha256: string;
  mimeType: string;
  width: number;
  height: number;
  byteSize: number;
  sourcePage: number | null;
  crop: { x0: number; y0: number; x1: number | null; y1: number | null } | null;
  role: string;
  caption: string | null;
  ordering: number;
  blockId: string | null;
  qaOnly: boolean;
};

export type V3PaperView = {
  id: string;
  board: string;
  qualification: string;
  subjectId: string;
  subjectCode: string;
  subjectName: string;
  level: string;
  year: number;
  session: string;
  paperNumber: string;
  paperType: string;
  component: string;
  variant: string;
  timezone: string;
  language: string;
};

export type V3TaxonomyView = {
  id: string;
  code?: string;
  label: string;
  source: string;
  confidence: number;
  taxonomyVersion: string;
  adminOverride: boolean;
};

export type V3QuestionSummary = {
  id: string;
  rootNumber: string;
  marks: number | null;
  confidence: number;
  document: unknown;
  paper: V3PaperView;
  topics: V3TaxonomyView[];
  tags: V3TaxonomyView[];
  assets: V3AssetView[];
  hasMarkScheme: boolean;
};

export type V3QuestionDetail = V3QuestionSummary & {
  schemaVersion: string;
  sourceHash: string;
  sourceDocument: { id: string; sha256: string; pageCount: number; documentType: string };
  resources: Array<{
    id: string;
    type: string;
    label: string;
    mimeType: string | null;
    assetId: string | null;
    sourceDocumentId: string | null;
    url: string | null;
    metadata: unknown;
  }>;
  markScheme: null | {
    id: string;
    rootNumber: string;
    marks: number | null;
    confidence: number;
    document: unknown;
    assets: V3AssetView[];
  };
};

export type V3FilterMetadata = {
  boards: string[];
  qualifications: string[];
  levels: string[];
  subjects: Array<{ id: string; board: string; subjectCode: string; name: string }>;
  years: number[];
  sessions: string[];
  paperTypes: string[];
  variants: string[];
  timezones: string[];
  tags: Array<{ id: string; label: string }>;
  topics: Array<{ id: string; code: string; label: string; taxonomyVersion: string; subjectId: string }>;
};
