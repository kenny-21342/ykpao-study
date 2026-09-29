'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  BookOpen,
  CalendarRange,
  ClipboardList,
  CheckCircle2,
  Pencil,
  Save,
  FileText,
  HelpCircle,
  History,
  Library,
  Lightbulb,
  ListOrdered,
  ListTodo,
  Loader2,
  Maximize2,
  MessageSquarePlus,
  Minimize2,
  Plus,
  SearchCheck,
  Send,
  Sparkles,
  Trash2,
  Workflow,
  X,
} from 'lucide-react';
import { useConfirm } from './useConfirm';
import FormattedMessage from './FormattedMessage';
import { useScreenContext } from './ScreenContext';
import type { AIActionProposalPayload, AIActionProposalView, CorpusCoverage, IntakeQuestion } from '@/lib/copilot-types';
import { looksLikePlan } from '@/lib/plan-detection';
import TutorModelPicker, { readSavedTutorModel } from '@/app/components/TutorModelPicker';
import type { SharedModelChoice } from '@/lib/shared-models';

type RAGSource = {
  type: 'textbook' | 'note' | 'question' | 'markscheme' | 'resource' | 'syllabus' | 'competition' | 'generated';
  title: string;
  url?: string;
  snippet: string;
  authority?: string;
  citation?: string;
};

type StudyAction = 'study-week' | 'todo-plan' | 'daily-practice' | 'mock-exam' | 'predicted-paper' | 'materials';
type StudyActionData = {
  action?: StudyAction;
  summary?: string;
  tasksCreated?: number;
  exam?: { id: string; title: string; subjectCode: string; questionCount: number; totalMarks: number };
  materials?: Array<{ id: string; type: 'resource' | 'note'; title: string; description: string; url: string }>;
  questions?: Array<{ id: number; title: string; topic: string; subject: string; url: string }>;
  focus?: Array<{ subject: string; topic: string; mastery: number }>;
  intent?: unknown;
  corpusCoverage?: CorpusCoverage;
  needsInput?: IntakeQuestion[];
  proposal?: AIActionProposalView;
  appliedResult?: unknown;
  eligibleCourses?: Array<{ id: string; name: string; subject: string; level: string }>;
  clarificationRequired?: boolean;
};

type Message = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  sources?: RAGSource[];
  actionType?: string | null;
  actionData?: StudyActionData | null;
  corpusCoverage?: CorpusCoverage;
  needsInput?: IntakeQuestion[];
  createdAt?: string;
};

type Conversation = {
  id: string;
  title: string;
  mode: TutorMode;
  updatedAt: string;
  messages: Array<{ content: string; role: string }>;
  _count: { messages: number };
  courseId: string | null;
};

type LearnerCourse = {
  id: string;
  name: string;
  subject: string;
  level: string;
  scopes: Array<{ subjectCode: string }>;
};

type FloatingAIAssistantProps = {
  isOpen: boolean;
  onClose: () => void;
};

type TutorMode = 'explain' | 'hint' | 'check' | 'worked-example' | 'socratic';
type AssistantView = 'chat' | 'history' | 'actions';
type NavigableTab = 'study' | 'practice' | 'mock-exams';

const TUTOR_MODES: Array<{ id: TutorMode; label: string; icon: typeof Sparkles }> = [
  { id: 'explain', label: 'Explain', icon: Sparkles },
  { id: 'hint', label: 'Hint', icon: Lightbulb },
  { id: 'socratic', label: 'Socratic', icon: HelpCircle },
  { id: 'check', label: 'Check', icon: SearchCheck },
  { id: 'worked-example', label: 'Example', icon: ListOrdered },
];

/**
 * What the student picks between: the two things the assistant does.
 *
 * `TUTOR_MODES` above is still the vocabulary of `mode` -- the API, the
 * stored conversations and the system prompt all keep using it -- but it is
 * no longer a menu put in front of someone who has not asked anything yet.
 */
const ASSISTANT_TABS: Array<{ view: 'chat' | 'actions'; label: string; icon: typeof Sparkles }> = [
  { view: 'chat', label: 'Chat', icon: Sparkles },
  { view: 'actions', label: 'Plan', icon: Workflow },
];

const SUGGESTED_MESSAGES = [
  'What should I study today?',
  'Explain my weakest topic',
  'Quiz me using my notes',
  'Help me review my recent mistakes',
  'Build a plan from my to-dos',
  'Generate a predicted paper',
];

const STUDY_ACTIONS: Array<{
  id: StudyAction;
  title: string;
  description: string;
  icon: typeof Sparkles;
}> = [
  {
    id: 'study-week',
    title: 'Build my study week',
    description: 'Create seven days of practice, note review, a focused mock exam, and reading suggestions.',
    icon: CalendarRange,
  },
  {
    id: 'todo-plan',
    title: 'Plan from to-dos',
    description: 'Rebuild the week around my pending tasks and keep the rest of the plan aligned.',
    icon: ListTodo,
  },
  {
    id: 'daily-practice',
    title: 'Schedule daily practice',
    description: 'Add one targeted past-paper question per day to your plan.',
    icon: ListTodo,
  },
  {
    id: 'mock-exam',
    title: 'Create a focused mock',
    description: 'Assemble a ready-to-take exam from your weakest available topics.',
    icon: ClipboardList,
  },
  {
    id: 'predicted-paper',
    title: 'Generate predicted paper',
    description: 'Create a paper forecast and mark-scheme guide from the question bank.',
    icon: FileText,
  },
  {
    id: 'materials',
    title: 'Recommend materials',
    description: 'Find accessible notes and school resources for your priority topics.',
    icon: Library,
  },
];

function normalizeMessage(raw: {
  id: string;
  role: string;
  content: string;
  sources?: unknown;
  actionType?: string | null;
  actionData?: unknown;
  corpusCoverage?: unknown;
  intent?: unknown;
  needsInput?: unknown;
  createdAt?: string;
}): Message {
  return {
    id: raw.id,
    role: raw.role === 'user' ? 'user' : 'assistant',
    text: raw.content,
    sources: Array.isArray(raw.sources) ? raw.sources as RAGSource[] : undefined,
    actionType: raw.actionType,
    actionData: raw.actionData && typeof raw.actionData === 'object' ? raw.actionData as StudyActionData : null,
    corpusCoverage: raw.corpusCoverage && typeof raw.corpusCoverage === 'object' ? raw.corpusCoverage as CorpusCoverage : (raw.actionData && typeof raw.actionData === 'object' ? (raw.actionData as StudyActionData).corpusCoverage : undefined),
    needsInput: Array.isArray(raw.needsInput) ? raw.needsInput as IntakeQuestion[] : (raw.actionData && typeof raw.actionData === 'object' ? (raw.actionData as StudyActionData).needsInput : undefined),
    createdAt: raw.createdAt,
  };
}

export default function FloatingAIAssistant({ isOpen, onClose }: FloatingAIAssistantProps) {
  const { confirm, confirmDialog } = useConfirm();
  const [chatHistory, setChatHistory] = useState<Message[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversationTitle, setConversationTitle] = useState('New conversation');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [userInput, setUserInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<StudyAction | null>(null);
  const [isMinimized, setIsMinimized] = useState(false);
  /**
   * Which models the tutor can offer right now.
   *
   * Empty for a student on their own key -- they chose their model when they
   * saved it and it is never substituted -- and empty while the first request
   * is in flight, so the picker is not drawn until there is something real to
   * draw.
   */
  const [sharedModels, setSharedModels] = useState<SharedModelChoice[]>([]);
  /** The server's own default, so the picker's label matches what answers. */
  const [configuredModel, setConfiguredModel] = useState<string | null>(null);
  // Read lazily rather than in the effect below: localStorage is not a system
  // to synchronise with, it is just the initial value. The window guard is for
  // SSR, and there is no hydration mismatch to worry about because the picker
  // does not render until `onSharedKey` turns true, which needs a fetch.
  const [model, setModel] = useState<string | null>(
    () => (typeof window === 'undefined' ? null : readSavedTutorModel()),
  );
  const [mode, setMode] = useState<TutorMode>('explain');
  const [view, setView] = useState<AssistantView>('chat');
  const [learnerCourses, setLearnerCourses] = useState<LearnerCourse[]>([]);
  const [activeCourseId, setActiveCourseId] = useState('');
  /** The question a "which course?" clarification interrupted, if any. */
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const [weakTopics, setWeakTopics] = useState<Array<{ courseId: string; topic: string }>>([]);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const localIdRef = useRef(0);
  const screenCtx = useScreenContext();

  const nextLocalId = (prefix: string) => {
    localIdRef.current += 1;
    return `${prefix}-${localIdRef.current}`;
  };

  const loadConversations = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const response = await fetch('/api/ai/conversations');
      if (!response.ok) return;
      const data = await response.json();
      setConversations(data.conversations || []);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const loadStudyContext = useCallback(async () => {
    const response = await fetch('/api/me/study-context');
    if (!response.ok) return;
    const data = await response.json();
    const courses = data.context?.enrolledCourses ?? [];
    setLearnerCourses(courses);
    setWeakTopics(data.context?.weakTopics ?? []);
    setActiveCourseId((current) => {
      if (current && courses.some((course: LearnerCourse) => course.id === current)) return current;
      const pageCourseId = screenCtx.context.data.courseId;
      if (pageCourseId && courses.some((course: LearnerCourse) => course.id === pageCourseId)) return pageCourseId;
      const pageSubjectCode = screenCtx.context.data.subjectCode;
      const pageMatch = pageSubjectCode ? courses.filter((course: LearnerCourse) => course.scopes.some((scope) => scope.subjectCode === pageSubjectCode)) : [];
      return pageMatch.length === 1 ? pageMatch[0].id : courses.length === 1 ? courses[0].id : '';
    });
  }, [screenCtx.context.data.courseId, screenCtx.context.data.subjectCode]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatHistory, isLoading]);

  useEffect(() => {
    if (!isOpen) return;
    window.setTimeout(() => void loadConversations(), 0);
    window.setTimeout(() => void loadStudyContext(), 0);
  }, [isOpen, loadConversations, loadStudyContext]);

  const suggestedMessages = useMemo(() => {
    const weak = weakTopics.find((topic) => !activeCourseId || topic.courseId === activeCourseId);
    return weak ? [`Explain ${weak.topic}`, `Quiz me on ${weak.topic}`, ...SUGGESTED_MESSAGES.slice(0, 4)] : SUGGESTED_MESSAGES;
  }, [activeCourseId, weakTopics]);

  useEffect(() => {
    const openWithPrompt = (event: Event) => {
      const detail = (event as CustomEvent<{ prompt?: string; mode?: TutorMode }>).detail;
      if (detail?.prompt) setUserInput(detail.prompt);
      if (detail?.mode && TUTOR_MODES.some((item) => item.id === detail.mode)) setMode(detail.mode);
      setView('chat');
      setIsMinimized(false);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    };
    window.addEventListener('open-ai-assistant', openWithPrompt);
    return () => window.removeEventListener('open-ai-assistant', openWithPrompt);
  }, []);

  const startNewConversation = () => {
    setConversationId(null);
    setConversationTitle('New conversation');
    setChatHistory([]);
    setUserInput('');
    setView('chat');
    const pageCourse = screenCtx.context.data.courseId;
    const pageCode = screenCtx.context.data.subjectCode;
    const matches = pageCode ? learnerCourses.filter((course) => course.scopes.some((scope) => scope.subjectCode === pageCode)) : [];
    setActiveCourseId(pageCourse && learnerCourses.some((course) => course.id === pageCourse) ? pageCourse : matches.length === 1 ? matches[0].id : learnerCourses.length === 1 ? learnerCourses[0].id : '');
    window.setTimeout(() => inputRef.current?.focus(), 0);
  };

  const openConversation = async (id: string) => {
    setHistoryLoading(true);
    try {
      const response = await fetch(`/api/ai/conversations?conversationId=${encodeURIComponent(id)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load conversation');
      setConversationId(data.conversation.id);
      setConversationTitle(data.conversation.title);
      setActiveCourseId(
        data.conversation.courseId && learnerCourses.some((course) => course.id === data.conversation.courseId)
          ? data.conversation.courseId
          : ''
      );
      if (TUTOR_MODES.some((item) => item.id === data.conversation.mode)) setMode(data.conversation.mode);
      setChatHistory((data.messages || []).map(normalizeMessage));
      setView('chat');
    } finally {
      setHistoryLoading(false);
    }
  };

  const deleteConversation = async (id: string) => {
    const ok = await confirm({
      title: 'Delete this conversation?',
      message: 'The whole exchange is removed permanently. This cannot be undone.',
      confirmLabel: 'Delete conversation',
    });
    if (!ok) return;
    const response = await fetch(`/api/ai/conversations?conversationId=${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!response.ok) return;
    if (conversationId === id) startNewConversation();
    await loadConversations();
  };

  // `changeMode` used to sit here and PATCH the conversation when the student
  // picked a teaching mode. With the mode row gone there is nothing to pick,
  // and the PATCH was always redundant: `mode` is sent with every message
  // (see the rag-chat body below), so the server records it per message and
  // on conversation creation without being told separately.

  const changeCourse = (courseId: string) => {
    setActiveCourseId(courseId);
    if (conversationId) {
      void fetch('/api/ai/conversations', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId, courseId: courseId || null }),
      });
    }
    // Picking a course in answer to "which course should I use for this?" is
    // the student answering the question they were asked. Resume their original
    // turn rather than making them type it again.
    if (pendingQuestion) {
      const question = pendingQuestion;
      setPendingQuestion(null);
      void handleSend({ message: question, courseId });
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    fetch('/api/ai/models')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !Array.isArray(data?.models)) return;
        setSharedModels(data.models);
        setConfiguredModel(typeof data.configured === 'string' ? data.configured : null);
      })
      .catch(() => {
        // A failed lookup is not evidence of anything. An empty list hides the
        // picker and changes nothing else: the server resolves the model on
        // its own whether or not the student ever saw a choice.
      });
    return () => { cancelled = true; };
  }, [isOpen]);

  const handleSend = async (options?: { message?: string; courseId?: string }) => {
    const message = (options?.message ?? userInput).trim();
    if (!message || isLoading) return;
    // `setActiveCourseId` has not committed yet when a resumed turn calls
    // through here, so the chosen course is passed explicitly rather than read
    // back off state.
    const courseId = options?.courseId ?? activeCourseId;
    const previous = chatHistory;
    const optimistic: Message = { id: nextLocalId('local'), role: 'user', text: message };
    setUserInput('');
    setChatHistory([...previous, optimistic]);
    setIsLoading(true);

    try {
      const response = await fetch('/api/ai/rag-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          courseId: courseId || undefined,
          pageCourseId: screenCtx.context.data.courseId,
          pageSubjectCode: screenCtx.context.data.subjectCode,
          bankQuestionId: screenCtx.context.data.bankQuestionId,
          conversationId: conversationId || undefined,
          history: conversationId ? undefined : previous.slice(-12).map((item) => ({ role: item.role, content: item.text })),
          screenContext: screenCtx.toPromptString() || undefined,
          mode,
          model: model || undefined,
        }),
      });
      const data = await response.json().catch(() => null);
      if (data?.conversationId) setConversationId(data.conversationId);
      if (!response.ok) throw new Error(data?.error || 'AI request failed');
      setConversationTitle(data.conversationTitle || conversationTitle);
      if (data.resolvedCourse?.id) setActiveCourseId(data.resolvedCourse.id);
      // Hold the question the clarification interrupted, so choosing a course
      // can answer it. Without this the tutor asked "which course?", accepted
      // the answer, set the dropdown, and then sat there -- the student had to
      // retype the question they had already asked.
      setPendingQuestion(data.clarificationRequired ? message : null);
      setChatHistory([
        ...previous,
        { id: data.userMessageId, role: 'user', text: message },
        { id: data.assistantMessageId, role: 'assistant', text: data.answer || 'No response.', sources: data.sources || [], actionData: { proposal: data.proposal, intent: data.intent, corpusCoverage: data.corpusCoverage, needsInput: data.needsInput, clarificationRequired: data.clarificationRequired, eligibleCourses: data.eligibleCourses }, corpusCoverage: data.corpusCoverage, needsInput: data.needsInput },
      ]);
      void loadConversations();
    } catch (error) {
      setChatHistory([...previous, optimistic, {
        id: nextLocalId('error'),
        role: 'assistant',
        text: error instanceof Error ? error.message : 'Sorry, I could not complete that request.',
      }]);
    } finally {
      setIsLoading(false);
    }
  };

  const runAction = async (action: StudyAction) => {
    if (actionLoading || isLoading) return;
    const definition = STUDY_ACTIONS.find((item) => item.id === action)!;
    const previous = chatHistory;
    setActionLoading(action);
    setView('chat');
    setChatHistory([...previous, { id: nextLocalId('local-action'), role: 'user', text: definition.title }]);
    try {
      const response = await fetch('/api/ai/study-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, conversationId: conversationId || undefined, courseId: activeCourseId || undefined }),
      });
      const data = await response.json().catch(() => null);
      if (data?.conversationId) setConversationId(data.conversationId);
      if (!response.ok) throw new Error(data?.error || 'Study action failed');
      setConversationTitle(data.conversationTitle || conversationTitle);
      setChatHistory([
        ...previous,
        normalizeMessage(data.userMessage),
        normalizeMessage(data.assistantMessage),
      ]);
      void loadConversations();
    } catch (error) {
      setChatHistory([...previous, {
        id: nextLocalId('action-user'),
        role: 'user',
        text: definition.title,
      }, {
        id: nextLocalId('action-error'),
        role: 'assistant',
        text: error instanceof Error ? error.message : 'The study action could not be completed.',
      }]);
    } finally {
      setActionLoading(null);
    }
  };

  const navigate = (tab: NavigableTab, questionId?: number, view?: 'today' | 'plan' | 'mistakes' | 'review' | 'mastery' | 'search') => {
    window.dispatchEvent(new CustomEvent('ai-navigate', { detail: { tab, questionId, view } }));
  };

  if (!isOpen) return null;

  return (
    <div className={`fixed z-50 transition-all duration-200 ${
      isMinimized ? 'bottom-4 right-4' : 'inset-x-3 bottom-3 top-16 sm:inset-x-auto sm:bottom-5 sm:right-5 sm:top-20'
    }`}>
      {confirmDialog}
      <div className={`flex flex-col overflow-hidden rounded-md border border-line bg-surface shadow-overlay ${
        isMinimized ? 'h-14 w-72' : 'h-full w-full sm:w-[430px]'
      }`}>
        <header className="flex min-h-14 items-center gap-2 border-b border-accent bg-accent px-3 text-white">
          {view !== 'chat' ? (
            <button onClick={() => setView('chat')} className="rounded-md p-1.5 hover:bg-white/15" title="Back to conversation" aria-label="Back to conversation"><ArrowLeft className="h-4 w-4" /></button>
          ) : (
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-white/15"><Sparkles className="h-4 w-4" /></div>
          )}
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-bold">{view === 'history' ? 'Chat history' : view === 'actions' ? 'Plan' : conversationTitle}</h3>
            {/* The subtitle read "AI Tutor" under a header that already says so.
                The picker takes that line instead: discoverable without
                crowding the button row, and absent for a student on their own
                key, for whom it would change nothing. */}
            {!isMinimized && view === 'chat' && (
              sharedModels.length > 0
                ? <TutorModelPicker models={sharedModels} model={model} configured={configuredModel} onChange={setModel} />
                : <p className="truncate text-[11px] text-accent-text">AI Tutor</p>
            )}
          </div>
          <button onClick={() => { setView('history'); void loadConversations(); }} className="rounded-md p-1.5 hover:bg-white/15" title="Chat history" aria-label="Chat history"><History className="h-4 w-4" /></button>
          <button onClick={startNewConversation} className="rounded-md p-1.5 hover:bg-white/15" title="New conversation" aria-label="New conversation"><MessageSquarePlus className="h-4 w-4" /></button>
          <button onClick={() => setIsMinimized((value) => !value)} className="rounded-md p-1.5 hover:bg-white/15" title={isMinimized ? 'Maximize' : 'Minimize'} aria-label={isMinimized ? 'Maximize' : 'Minimize'}>{isMinimized ? <Maximize2 className="h-4 w-4" /> : <Minimize2 className="h-4 w-4" />}</button>
          <button onClick={onClose} className="rounded-md p-1.5 hover:bg-white/15" title="Close" aria-label="Close"><X className="h-4 w-4" /></button>
        </header>

        {/* Two things the tutor does, not five ways of asking it.
            
            This row used to offer Explain / Hint / Socratic / Check /
            Example beside a "Plan & act" button -- six controls, five of
            which differ only in the tone of the same answer, above a chat
            box a student has not typed in yet. Choosing between them is a
            decision the student has no basis to make before seeing any
            output, and it pushed the real controls off the edge at panel
            width.

            The teaching modes still exist server-side and still reach the
            prompt: `MODE_RULES` is unchanged, notes' "quiz me" still opens
            in `check`, and a conversation saved in any mode reopens in it.
            What is gone is asking the student to pick one up front. */}
        {!isMinimized && <div className="flex items-center gap-1 border-b border-line bg-surface-raised p-2">
          {ASSISTANT_TABS.map((tab) => {
            const Icon = tab.icon;
            const active = view === tab.view;
            return <button key={tab.view} onClick={() => setView(tab.view)} aria-current={active ? 'page' : undefined} className={`flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md text-xs font-semibold ${active ? 'bg-surface text-accent-text' : 'text-muted hover:bg-surface-hover'}`}><Icon className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{tab.label}</span></button>;
          })}
        </div>}

        {!isMinimized && view === 'chat' && <>
          {learnerCourses.length > 0 && <div className="border-b border-line px-3 py-2"><select aria-label="Chat course" value={activeCourseId} onChange={(event) => changeCourse(event.target.value)} className="h-8 w-full rounded-md border border-strong bg-surface px-2 text-xs font-medium"><option value="">Choose a course</option>{learnerCourses.map((course) => <option key={course.id} value={course.id}>{course.name} · {course.level}</option>)}</select></div>}

          <div className="flex-1 overflow-y-auto p-4">
            {chatHistory.length === 0 && (
              <div className="py-5">
                <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-md bg-accent-subtle text-accent-text"><Sparkles className="h-5 w-5" /></div>
                <h4 className="mt-3 text-center text-sm font-semibold">What are you working on?</h4>
                <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {suggestedMessages.map((message) => <button key={message} onClick={() => { setUserInput(message); window.setTimeout(() => inputRef.current?.focus(), 0); }} className="min-h-11 rounded-md border border-line px-3 py-2 text-left text-xs font-medium text-secondary hover:border-accent hover:bg-accent-subtle">{message}</button>)}
                </div>
                <button onClick={() => setView('actions')} className="mt-3 flex h-10 w-full items-center justify-center gap-2 rounded-md bg-accent text-xs font-bold text-white hover:bg-accent-hover"><Workflow className="h-4 w-4" /> Create a plan or learning activity</button>
              </div>
            )}

            <div className="space-y-4">
              {chatHistory.map((message) => (
                <div key={message.id} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[88%] ${message.role === 'user' ? 'text-right' : ''}`}>
                    <div className={`rounded-md px-3 py-2 text-left text-sm ${message.role === 'user' ? 'bg-accent text-white' : 'bg-surface-raised text-primary'}`}>
                      {message.role === 'user' ? message.text : <FormattedMessage content={message.text} />}
                    </div>
                    {message.corpusCoverage && <CoverageIndicator coverage={message.corpusCoverage} />}
                    {message.needsInput && message.needsInput.length > 0 && <IntakeCard questions={message.needsInput} onSubmit={(details) => { setUserInput(details); window.setTimeout(() => inputRef.current?.focus(), 0); }} />}
                    {message.actionData?.eligibleCourses && message.actionData.eligibleCourses.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{message.actionData.eligibleCourses.map((course) => <button key={course.id} onClick={() => changeCourse(course.id)} className="rounded-md border border-accent-border bg-surface px-2 py-1 text-[11px] font-semibold text-accent-text hover:bg-accent-subtle">{course.name} · {course.level}</button>)}</div>}
                    {message.role === 'assistant' && !message.actionData?.proposal && looksLikePlan(message.text) && <SchedulePlanButton answer={message.text} conversationId={conversationId} onProposal={(proposal) => setChatHistory((items) => items.map((item) => item.id === message.id ? { ...item, actionData: { ...item.actionData, proposal } } : item))} />}
                    {message.actionData && <ActionResult data={message.actionData} onNavigate={navigate} onProposalUpdate={(proposal) => setChatHistory((items) => items.map((item) => item.id === message.id ? { ...item, actionData: { ...item.actionData, proposal }, corpusCoverage: proposal.payload.corpusCoverage || item.corpusCoverage } : item))} />}
                    {message.sources && message.sources.length > 0 && (
                      <details className="mt-1.5 rounded-md border border-line bg-surface text-left">
                        <summary className="cursor-pointer px-2 py-1.5 text-[10px] font-bold uppercase text-muted">Evidence ({message.sources.length})</summary>
                        <div className="space-y-1 border-t border-subtle p-2">
                          {message.sources.map((source, index) => <a key={`${source.title}-${index}`} href={source.url || undefined} target={source.url ? '_blank' : undefined} rel="noreferrer" className="block rounded-sm px-2 py-1.5 hover:bg-surface-hover"><span className="flex items-center gap-1.5 text-[11px] font-semibold text-secondary">{source.type === 'textbook' ? <BookOpen className="h-3 w-3" /> : source.type === 'note' ? <FileText className="h-3 w-3" /> : <HelpCircle className="h-3 w-3" />}<span className="min-w-0 flex-1 truncate">[{source.citation || `S${index + 1}`}] {source.title}</span><span className="rounded-sm bg-surface-raised px-1 py-0.5 text-[9px] uppercase text-muted">{source.authority || 'source'}</span></span><span className="mt-1 block line-clamp-2 text-[10px] leading-4 text-muted">{source.snippet}</span></a>)}
                        </div>
                      </details>
                    )}
                  </div>
                </div>
              ))}
              {(isLoading || actionLoading) && <div className="flex items-center gap-2 text-xs text-muted"><Loader2 className="h-4 w-4 animate-spin text-accent-text" />{actionLoading ? 'Updating your study system' : 'Thinking'}</div>}
              <div ref={chatEndRef} />
            </div>
          </div>

          <div className="border-t border-line p-3">
            <div className="flex items-end gap-2 rounded-md border border-strong bg-surface p-1.5 focus-within:border-accent">
              <textarea ref={inputRef} rows={1} value={userInput} onChange={(event) => setUserInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void handleSend(); } }} placeholder="e.g. Build me a study plan or explain this topic" className="max-h-28 min-h-8 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none" disabled={isLoading || Boolean(actionLoading)} />
              <button onClick={() => void handleSend()} disabled={!userInput.trim() || isLoading || Boolean(actionLoading)} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40" title="Send" aria-label="Send"><Send className="h-4 w-4" /></button>
            </div>
          </div>
        </>}

        {!isMinimized && view === 'history' && (
          <div className="flex-1 overflow-y-auto p-3">
            <button onClick={startNewConversation} className="mb-3 flex h-10 w-full items-center justify-center gap-2 rounded-md bg-accent text-sm font-semibold text-white hover:bg-accent-hover"><Plus className="h-4 w-4" /> New conversation</button>
            {historyLoading ? <div className="flex justify-center py-12 text-muted"><Loader2 className="h-5 w-5 animate-spin" /></div> : conversations.length === 0 ? <p className="py-12 text-center text-sm text-muted">No saved conversations yet.</p> : <div className="divide-y divide-line border-y border-line">{conversations.map((conversation) => <div key={conversation.id} className="flex items-center gap-2 py-2"><button onClick={() => void openConversation(conversation.id)} className="min-w-0 flex-1 rounded-md px-2 py-2 text-left hover:bg-surface-hover"><span className="block truncate text-sm font-semibold">{conversation.title}</span><span className="mt-1 block truncate text-xs text-muted">{conversation.messages[0]?.content || 'Empty conversation'} · {conversation._count.messages} messages</span></button><button onClick={() => void deleteConversation(conversation.id)} className="rounded-md p-2 text-muted hover:bg-danger-subtle hover:text-danger" title="Delete conversation" aria-label="Delete conversation"><Trash2 className="h-4 w-4" /></button></div>)}</div>}
          </div>
        )}

        {!isMinimized && view === 'actions' && (
          <div className="flex-1 overflow-y-auto p-4">
            <div className="space-y-2">
              {STUDY_ACTIONS.map((action) => {
                const Icon = action.icon;
                return <button key={action.id} onClick={() => void runAction(action.id)} disabled={Boolean(actionLoading) || isLoading} className="flex w-full items-start gap-3 rounded-md border border-line p-3 text-left hover:border-accent hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"><span className={'flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface-raised text-secondary'}>{actionLoading === action.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}</span><span className="min-w-0"><span className="block text-sm font-semibold">{action.title}</span><span className="mt-1 block text-xs leading-5 text-muted">{action.description}</span></span></button>;
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function CoverageIndicator({ coverage }: { coverage: CorpusCoverage }) {
  const tone = coverage.status === 'complete' ? 'bg-accent-subtle text-accent-text'
    : coverage.status === 'extracting' ? 'bg-warning-subtle text-warning'
    : 'bg-surface-raised text-secondary';
  return <div className={`mt-2 flex items-start gap-2 rounded-md px-2 py-1.5 text-[10px] ${tone}`}><span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-current" /><span><strong>Corpus: {coverage.status}</strong> {coverage.label}{coverage.limitations.length > 0 && <span className="block mt-0.5">{coverage.limitations[0]}</span>}</span></div>;
}

function IntakeCard({ questions, onSubmit }: { questions: IntakeQuestion[]; onSubmit: (details: string) => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  return <div className="mt-2 rounded-md border border-warning-border bg-warning-subtle p-3 text-left"><p className="text-xs font-bold text-warning">A few details will make this plan useful</p><div className="mt-2 space-y-2">{questions.map((question) => <label key={question.key} className="block"><span className="mb-1 block text-[10px] font-semibold uppercase text-warning">{question.label}</span>{question.type === 'select' ? <select value={values[question.key] || ''} onChange={(event) => setValues((current) => ({ ...current, [question.key]: event.target.value }))} className="h-8 w-full rounded-sm border border-warning-border bg-surface px-2 text-xs"><option value="">Select</option>{question.options?.map((option) => <option key={option} value={option}>{option}</option>)}</select> : <input type={question.type} value={values[question.key] || ''} onChange={(event) => setValues((current) => ({ ...current, [question.key]: event.target.value }))} placeholder={question.prompt} className="h-8 w-full rounded-sm border border-warning-border bg-surface px-2 text-xs" />}</label>)}</div><button onClick={() => onSubmit(`Planning details: ${questions.map((question) => `${question.label}: ${values[question.key] || 'not provided'}`).join('; ')}`)} className="mt-3 flex h-8 items-center gap-1.5 rounded-sm bg-warning px-2.5 text-[11px] font-bold text-white hover:bg-warning"><Send className="h-3.5 w-3.5" /> Use these details</button></div>;
}

/**
 * "Schedule this plan" — the entrance to the proposal pipeline that chat never
 * had. `app/api/ai/rag-chat/route.ts` attaches a draft proposal itself, but
 * only when the intent classifier says `planning` *and* no intake question is
 * outstanding, and those two conditions are mutually exclusive in practice (see
 * `lib/plan-detection.ts` for the details). So a student who asks "what should
 * I study today?" gets a good plan and no way to act on it.
 *
 * This button keys off the answer instead of the question: if the assistant
 * wrote something plan-shaped, offer to schedule it. It only creates a draft —
 * the existing `ProposalCard` below is what the student edits and confirms, so
 * nothing reaches the schedule without a second, explicit press.
 */
function SchedulePlanButton({ answer, conversationId, onProposal }: { answer: string; conversationId: string | null; onProposal: (proposal: AIActionProposalView) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const schedule = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/ai/plan-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer, conversationId: conversationId || undefined }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'The plan could not be prepared.');
      onProposal(data.proposal);
    } catch (planError) {
      setError(planError instanceof Error ? planError.message : 'The plan could not be prepared.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-2">
      <button
        onClick={() => void schedule()}
        disabled={busy}
        className="flex h-7 items-center gap-1.5 rounded-sm border border-accent-border bg-accent-subtle px-2 text-[10px] font-bold text-accent-text hover:bg-accent-subtle/70 disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <CalendarRange className="h-3 w-3" />}
        Schedule this plan
      </button>
      {error && <p className="mt-1 text-[10px] text-danger">{error}</p>}
    </div>
  );
}

function ProposalCard({ proposal, onUpdate, onNavigate }: { proposal: AIActionProposalView; onUpdate: (proposal: AIActionProposalView) => void; onNavigate: (tab: NavigableTab, questionId?: number, view?: 'today' | 'plan' | 'mistakes' | 'review' | 'mastery' | 'search') => void }) {
  const [payload, setPayload] = useState<AIActionProposalPayload>(proposal.payload);
  const [editing, setEditing] = useState(proposal.status === 'draft');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const updateTask = (clientId: string, patch: Partial<AIActionProposalPayload['tasks'][number]>) => setPayload((current) => ({ ...current, tasks: current.tasks.map((task) => task.clientId === clientId ? { ...task, ...patch } : task) }));
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/ai/proposals/${proposal.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'edit', payload: { tasks: payload.tasks, questions: payload.questions, milestones: payload.milestones } }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Draft could not be saved.');
      onUpdate(data.proposal); setEditing(false);
    } catch (saveError) { setError(saveError instanceof Error ? saveError.message : 'Draft could not be saved.'); } finally { setBusy(false); }
  };
  const confirm = async () => {
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/ai/proposals/${proposal.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'confirm' }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Proposal could not be confirmed.');
      onUpdate(data.proposal);
      if (data.result?.taskCount) onNavigate('study', undefined, 'plan');
      if (data.result?.exam) onNavigate('mock-exams');
    } catch (confirmError) { setError(confirmError instanceof Error ? confirmError.message : 'Proposal could not be confirmed.'); } finally { setBusy(false); }
  };
  const cancel = async () => {
    setBusy(true);
    try { const response = await fetch(`/api/ai/proposals/${proposal.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'cancel' }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Proposal could not be cancelled.'); onUpdate(data.proposal); } catch (cancelError) { setError(cancelError instanceof Error ? cancelError.message : 'Proposal could not be cancelled.'); } finally { setBusy(false); }
  };
  const isDraft = proposal.status === 'draft';
  return <div className="mt-2 border-t border-line pt-2 text-left"><div className="flex items-start justify-between gap-2"><div><p className="text-xs font-bold">{payload.title}</p><p className="mt-0.5 text-[10px] text-muted">{payload.summary} {isDraft ? 'Nothing has been applied.' : `Status: ${proposal.status}.`}</p></div>{isDraft && <button onClick={() => setEditing((value) => !value)} className="rounded-sm p-1 text-muted hover:bg-surface-hover" title="Edit draft" aria-label="Edit draft"><Pencil className="h-3.5 w-3.5" /></button>}</div>{payload.corpusCoverage && <CoverageIndicator coverage={payload.corpusCoverage} />}<div className="mt-2 space-y-1.5">{payload.tasks.slice(0, 10).map((task) => <div key={task.clientId} className={`rounded-sm border px-2 py-1.5 ${task.selected ? 'border-line' : 'border-dashed border-strong opacity-60'}`}><div className="flex items-center gap-1.5">{editing && isDraft && <input type="checkbox" checked={task.selected} onChange={(event) => updateTask(task.clientId, { selected: event.target.checked })} />}{task.sourceRef?.type === 'question' ? <span className="rounded-sm bg-accent-subtle px-1 text-[9px] font-bold uppercase text-accent-text">Official</span> : <span className="rounded-sm bg-surface-raised px-1 text-[9px] font-bold uppercase text-muted">Generated</span>}{editing && isDraft ? <input value={task.topic} onChange={(event) => updateTask(task.clientId, { topic: event.target.value })} className="min-w-0 flex-1 rounded-sm border border-line bg-transparent px-1 text-[11px]" /> : <span className="min-w-0 flex-1 truncate text-[11px]">{task.title}</span>}</div>{editing && isDraft && <div className="mt-1 flex gap-1.5"><input type="date" value={task.dueAt.slice(0, 10)} onChange={(event) => updateTask(task.clientId, { dueAt: `${event.target.value}T17:00:00.000Z` })} className="h-6 min-w-0 flex-1 rounded-sm border border-line bg-transparent px-1 text-[10px]" /><input type="number" min={5} max={480} value={task.durationMinutes} onChange={(event) => updateTask(task.clientId, { durationMinutes: Number(event.target.value) })} className="h-6 w-20 rounded-sm border border-line bg-transparent px-1 text-[10px]" /></div>}</div>)}</div>{payload.limitations.length > 0 && <p className="mt-2 text-[10px] leading-4 text-muted">{payload.limitations.join(' ')}</p>}{error && <p className="mt-2 text-[10px] text-danger">{error}</p>}{isDraft && <div className="mt-2 flex flex-wrap gap-1.5">{editing && <button onClick={() => void save()} disabled={busy} className="flex h-7 items-center gap-1 rounded-sm bg-surface-inverse px-2 text-[10px] font-bold text-inverse disabled:opacity-50"><Save className="h-3 w-3" /> Save edits</button>}<button onClick={() => void confirm()} disabled={busy} className="flex h-7 items-center gap-1 rounded-sm bg-accent px-2 text-[10px] font-bold text-white disabled:opacity-50"><CheckCircle2 className="h-3 w-3" /> Confirm</button><button onClick={() => void cancel()} disabled={busy} className="flex h-7 items-center gap-1 rounded-sm border border-strong px-2 text-[10px] font-bold text-secondary disabled:opacity-50">Cancel</button></div>}</div>;
}

function ActionResult({ data, onNavigate, onProposalUpdate }: { data: StudyActionData; onNavigate: (tab: NavigableTab, questionId?: number, view?: 'today' | 'plan' | 'mistakes' | 'review' | 'mastery' | 'search') => void; onProposalUpdate: (proposal: AIActionProposalView) => void }) {
  return (
    <div className="mt-2 rounded-md border border-line bg-surface p-2 text-left">
      {data.proposal && <ProposalCard proposal={data.proposal} onUpdate={onProposalUpdate} onNavigate={onNavigate} />}
      <div className="flex flex-wrap gap-1.5">
        {data.tasksCreated ? <button onClick={() => onNavigate('study', undefined, 'plan')} className="result-link"><CalendarRange className="h-3.5 w-3.5" /> Open study plan</button> : null}
        {data.exam ? <button onClick={() => onNavigate('mock-exams')} className="result-link"><ClipboardList className="h-3.5 w-3.5" /> Open {data.exam.title}</button> : null}
      </div>
      {data.questions && data.questions.length > 0 && <div className="mt-2 border-t border-subtle pt-2"><p className="mb-1 text-[10px] font-bold uppercase text-muted">Practice questions</p>{data.questions.slice(0, 3).map((question) => <button key={question.id} onClick={() => onNavigate('practice', question.id)} className="block w-full truncate rounded-sm px-1.5 py-1 text-left text-xs text-accent-text hover:bg-accent-subtle">{question.topic} · {question.subject}</button>)}</div>}
      {data.materials && data.materials.length > 0 && <div className="mt-2 border-t border-subtle pt-2"><p className="mb-1 text-[10px] font-bold uppercase text-muted">Recommended material</p>{data.materials.slice(0, 4).map((material) => <a key={`${material.type}-${material.id}`} href={material.url} target={material.type === 'resource' ? '_blank' : undefined} rel="noreferrer" className="flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-xs text-secondary hover:bg-surface-hover">{material.type === 'resource' ? <Library className="h-3.5 w-3.5" /> : <FileText className="h-3.5 w-3.5" />}<span className="truncate">{material.title}</span></a>)}</div>}
      <style jsx global>{`
        .result-link { display: inline-flex; min-height: 1.75rem; align-items: center; gap: .375rem; border-radius: .25rem; background: rgb(5 150 105); padding: .25rem .5rem; font-size: .6875rem; font-weight: 700; color: white; }
        .result-link:hover { background: rgb(4 120 87); }
      `}</style>
    </div>
  );
}
