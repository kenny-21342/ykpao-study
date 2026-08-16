export type CopilotIntentName =
  | 'explanation'
  | 'planning'
  | 'practice'
  | 'assessment'
  | 'discovery'
  | 'next-action'
  | 'review';

export type CopilotIntent = {
  name: CopilotIntentName;
  board?: string;
  qualification?: string;
  subjectCode?: string;
  subject?: string;
  level?: string;
  topic?: string;
  year?: number;
  session?: string;
  paper?: string;
  provider?: 'official' | 'personal' | 'school' | 'competition' | 'generated';
  materialKinds: string[];
  purpose: 'explain' | 'plan' | 'practice' | 'assess' | 'discover' | 'review';
  confidence: number;
};

export type CorpusCoverage = {
  status: 'complete' | 'partial' | 'extracting' | 'unavailable';
  label: string;
  board?: string;
  qualification?: string;
  level?: string;
  subjectCode?: string;
  questionCount: number;
  markSchemeCount: number;
  resourceCount: number;
  noteCount: number;
  availableYears: number[];
  availablePapers: string[];
  lastExtractionAt?: string | null;
  lastIndexingAt?: string | null;
  limitations: string[];
};

export type RAGSource = {
  type: 'textbook' | 'note' | 'question' | 'markscheme' | 'resource' | 'syllabus' | 'competition' | 'generated';
  title: string;
  content?: string;
  snippet: string;
  url?: string;
  relevance: number;
  authority: 'official' | 'personal' | 'school' | 'competition' | 'generated' | 'provisional';
  sourceRecordId?: string;
  citation?: string;
  pairSourceRecordId?: string;
};

export type IntakeQuestion = {
  key: 'board' | 'qualification' | 'subject' | 'level' | 'examDate' | 'targetGrade' | 'currentLevel' | 'weeklyStudyMinutes' | 'paper';
  label: string;
  prompt: string;
  type: 'text' | 'date' | 'number' | 'select';
  options?: string[];
};

export type ProposalTask = {
  clientId: string;
  title: string;
  subject: string;
  topic: string;
  taskType: 'practice' | 'review' | 'notes' | 'mock-exam' | 'quiz';
  sourceRef?: { type: string; id?: string; url?: string; label?: string };
  dueAt: string;
  durationMinutes: number;
  selected: boolean;
};

export type AIActionProposalPayload = {
  version: 1;
  action: string;
  title: string;
  summary: string;
  milestones: Array<{ title: string; date: string; description: string }>;
  tasks: ProposalTask[];
  questions?: Array<{ id: number; title: string; subject: string; topic: string; url: string; selected: boolean; official: boolean }>;
  materials?: Array<{ id: string; type: string; title: string; description: string; url: string; selected: boolean }>;
  mockExam?: { title: string; subjectCode: string; questionIds: number[]; totalMarks: number; durationMinutes: number; prediction: boolean };
  assumptions: string[];
  limitations: string[];
  corpusCoverage?: CorpusCoverage;
};

export type AIActionProposalView = {
  id: string;
  actionType: string;
  status: 'draft' | 'confirmed' | 'cancelled' | 'expired' | 'applied';
  payload: AIActionProposalPayload;
  expiresAt: string;
  appliedResult?: unknown;
};
