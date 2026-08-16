export type MockExamListItem = {
  id: string;
  title: string;
  description: string;
  subjectCode: string | null;
  durationMinutes: number;
  totalMarks: number;
  difficulty: string;
  topics: string[];
  status: string;
  score: number | null;
  questionCount: number;
  createdAt: string;
  submittedAt: string | null;
};

export type MockExamItemView = {
  id: string;
  sectionTitle: string;
  order: number;
  questionId: number;
  number: number;
  part: string;
  subPart: string;
  content: string;
  latex: string;
  marks: number;
  markschemeContent: string | null;
  answer: string | null;
  score: number | null;
  isCorrect: boolean | null;
  explanation: string | null;
  modelAnswer: string | null;
  strengths: string[];
  weaknesses: string[];
  attemptedAt: string | null;
};

export type MockExamFull = {
  id: string;
  title: string;
  description: string;
  subjectCode: string | null;
  durationMinutes: number;
  totalMarks: number;
  difficulty: string;
  topics: string[];
  status: string;
  score: number | null;
  startedAt: string | null;
  submittedAt: string | null;
  createdAt: string;
  items: MockExamItemView[];
};
