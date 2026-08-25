export type DeepSeekRole = 'system' | 'user' | 'assistant';

export interface DeepSeekMessage {
  role: DeepSeekRole;
  content: string;
}

export interface DeepSeekResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: DeepSeekRole; content: string };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface GradeResult {
  score: number;
  maxScore: number;
  isCorrect: boolean;
  strengths: string[];
  weaknesses: string[];
  explanation: string;
  modelAnswer: string;
}

export interface MockExamPlan {
  title: string;
  description: string;
  sections: Array<{
    title: string;
    questionIds: number[];
  }>;
}
