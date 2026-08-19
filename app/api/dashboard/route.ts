import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { resolveCourseScope } from '@/lib/course-scope'
import { LearnerContextError } from '@/lib/learner-context'

/**
 * Aggregated dashboard stats for the signed-in user.
 *
 * Pulls from BOTH attempt tables:
 *  - PastPaperAttempt  (the real past-paper bank — what users actually answer)
 *  - QuestionAttempt   (the legacy custom Question table)
 *
 * Accuracy is computed from COUNTS, not by loading every row.
 */
export async function GET(req: NextRequest) {
  try {
    // getSessionUser() rather than getServerSession(): it is the chokepoint
    // that enforces bans and credential-fingerprint revocation, so reading the
    // session directly would leave this route answering to a device holding a
    // password that has since been reset.
    const user = await getSessionUser()
    const userId = user?.id

    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const params = new URL(req.url).searchParams
    const courseScope = await resolveCourseScope({ userId, scope: params.get('scope'), courseId: params.get('courseId') })
    const ppWhere = courseScope.effectiveScope === 'enrolled'
      ? { question: { paper: { subject: { code: { in: courseScope.subjectCodes } } } } }
      : {}
    const legacyWhere = courseScope.effectiveScope === 'enrolled'
      ? { question: { courseId: { in: courseScope.courseIds } } }
      : {}

    const [
      ppTotal,
      ppCorrect,
      qTotal,
      qCorrect,
      recentPP,
      studySessions,
      bookmarkCount,
      noteCount,
    ] = await Promise.all([
      prisma.pastPaperAttempt.count({ where: { userId, gradingStatus: 'official', ...ppWhere } }),
      prisma.pastPaperAttempt.count({ where: { userId, gradingStatus: 'official', isCorrect: true, ...ppWhere } }),
      prisma.questionAttempt.count({ where: { userId, ...legacyWhere } }),
      prisma.questionAttempt.count({ where: { userId, isCorrect: true, ...legacyWhere } }),
      prisma.pastPaperAttempt.findMany({
        where: { userId, gradingStatus: 'official', ...ppWhere },
        include: { question: { include: { paper: { include: { subject: true } } } } },
        orderBy: { attemptedAt: 'desc' },
        take: 50,
      }),
      prisma.studySession.findMany({
        where: { userId, ...(courseScope.effectiveScope === 'enrolled' ? { OR: [{ subject: { in: courseScope.subjects } }, { subject: null }] } : {}) },
        orderBy: { startTime: 'desc' },
        take: 60,
      }),
      prisma.bookmark.count({ where: { userId, ...(courseScope.effectiveScope === 'enrolled' ? { question: { courseId: { in: courseScope.courseIds } } } : {}) } }),
      prisma.note.count({ where: { userId, ...(courseScope.effectiveScope === 'enrolled' ? { OR: [{ courseId: { in: courseScope.courseIds } }, { courseId: null }] } : {}) } }),
    ])

    const questionsAnswered = ppTotal + qTotal
    const totalGraded = ppTotal + qTotal
    const totalCorrect = ppCorrect + qCorrect
    const accuracy = totalGraded > 0 ? Math.round((totalCorrect / totalGraded) * 100) : 0

    // ----- Study streak (consecutive calendar days with activity) -----
    // Activity days come from attempts + study sessions.
    const activityDays = new Set<string>()
    const addDay = (d: Date) => {
      const k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
      activityDays.add(k)
    }
    recentPP.forEach((a) => addDay(new Date(a.attemptedAt)))
    studySessions.forEach((s) => addDay(new Date(s.startTime)))

    let studyStreak = 0
    if (activityDays.size > 0) {
      const cursor = new Date()
      cursor.setHours(0, 0, 0, 0)
      // If nothing happened today, allow the streak to count from yesterday
      // (so a user who studied yesterday but not yet today keeps their streak).
      const todayKey = `${cursor.getFullYear()}-${cursor.getMonth()}-${cursor.getDate()}`
      if (!activityDays.has(todayKey)) {
        cursor.setDate(cursor.getDate() - 1)
      }
      // Guard against infinite loops on malformed data.
      for (let i = 0; i < 365; i++) {
        const k = `${cursor.getFullYear()}-${cursor.getMonth()}-${cursor.getDate()}`
        if (activityDays.has(k)) {
          studyStreak++
          cursor.setDate(cursor.getDate() - 1)
        } else {
          break
        }
      }
    }

    // ----- Hours studied (last 30 study sessions) -----
    const totalMinutes = studySessions.reduce((sum, s) => sum + (s.duration ?? 0), 0)
    const hoursStudied = Math.round((totalMinutes / 60) * 10) / 10

    // ----- Recent activity aggregated by subject -----
    // Group the latest attempts by subject, count questions, avg accuracy.
    const bySubject = new Map<string, { count: number; correct: number; lastAt: number }>()
    for (const a of recentPP) {
      const subj = a.question?.paper?.subject?.name ?? 'General'
      const entry = bySubject.get(subj) ?? { count: 0, correct: 0, lastAt: 0 }
      entry.count += 1
      if (a.isCorrect) entry.correct += 1
      entry.lastAt = Math.max(entry.lastAt, new Date(a.attemptedAt).getTime())
      bySubject.set(subj, entry)
    }
    const recentActivity = Array.from(bySubject.entries())
      .map(([subject, e]) => ({
        subject,
        questions: e.count,
        accuracy: e.count > 0 ? Math.round((e.correct / e.count) * 100) : 0,
        time: new Date(e.lastAt).toISOString(),
      }))
      .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
      .slice(0, 5)

    // ----- Week-over-week trend (questions answered) -----
    const now = new Date()
    const weekAgo = new Date(now)
    weekAgo.setDate(weekAgo.getDate() - 7)
    const twoWeeksAgo = new Date(now)
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14)

    const [thisWeek, lastWeek] = await Promise.all([
      prisma.pastPaperAttempt.count({ where: { userId, gradingStatus: 'official', attemptedAt: { gte: weekAgo }, ...ppWhere } }),
      prisma.pastPaperAttempt.count({
        where: { userId, gradingStatus: 'official', attemptedAt: { gte: twoWeeksAgo, lt: weekAgo }, ...ppWhere },
      }),
    ])
    const weekDelta = lastWeek > 0 ? Math.round(((thisWeek - lastWeek) / lastWeek) * 100) : thisWeek > 0 ? 100 : 0

    const [dueReviews, pendingOldTasks] = await Promise.all([
      prisma.reviewItem.count({ where: { userId, status: 'active', nextReviewAt: { lte: now }, ...(courseScope.effectiveScope === 'enrolled' ? { subject: { in: courseScope.subjects } } : {}) } }),
      prisma.studyTask.count({ where: { userId, status: 'pending', dueAt: { lt: weekAgo }, ...(courseScope.effectiveScope === 'enrolled' ? { subject: { in: courseScope.subjects } } : {}) } }),
    ])
    let newIndexedMaterial = 0
    try {
      newIndexedMaterial = await prisma.ragDocument.count({ where: { visibility: 'platform', indexedAt: { gte: weekAgo } } })
    } catch {
      // The index migration may not have run during a rolling deploy.
    }

    return NextResponse.json({
      questionsAnswered,
      accuracy,
      studyStreak,
      hoursStudied,
      bookmarkCount,
      noteCount,
      recentActivity,
      thisWeek,
      lastWeek,
      weekDelta,
      scope: courseScope,
      nudges: [
        ...(dueReviews > 0 ? [{ type: 'reviews', count: dueReviews, label: `${dueReviews} review${dueReviews === 1 ? '' : 's'} due`, action: 'review' }] : []),
        ...(pendingOldTasks > 0 ? [{ type: 'stalled', count: pendingOldTasks, label: `${pendingOldTasks} plan item${pendingOldTasks === 1 ? '' : 's'} stalled`, action: 'plan' }] : []),
        ...(newIndexedMaterial > 0 ? [{ type: 'corpus', count: newIndexedMaterial, label: `${newIndexedMaterial} new question-bank item${newIndexedMaterial === 1 ? '' : 's'} available`, action: 'practice' }] : []),
      ],
    })
  } catch (error) {
    if (error instanceof LearnerContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    console.error('Error fetching dashboard data:', error)
    return NextResponse.json({ error: 'Failed to fetch dashboard data' }, { status: 500 })
  }
}
