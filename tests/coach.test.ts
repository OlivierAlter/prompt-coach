import { expect, test } from 'claude-code/testing'

import type { CoachEntry } from '../types'
import { diffWords, lintDraft, placeholders, relTime, streak, buildPrompt, ruleSuggestions, habitStats, cleanRewrite, clipMiddle, isTrivial, parseReview, stepLine, weakHabits } from '../hooks/coach'

const entry = (over: Partial<CoachEntry>): CoachEntry => ({
  id: String(Math.random()),
  at: 0,
  prompt: 'p',
  answer: 'a',
  tools: [],
  durationMs: 1000,
  status: 'done',
  ...over,
})

test('parseReview reads a fenced reply, clamps the score and keeps known habits only', async () => {
  const r = parseReview(
    '```json\n{"score": 9, "verdict": "ok", "feedback": ["a", 3], "better": "", "tip": "t", "habits": {"verify": "missed", "target": "shown", "vibes": "shown", "goal": "maybe"}, "previous_unclear": "name the file", "standing_instructions": ["Use pnpm", 3, ""]}\n```',
  )
  expect(r?.score).toBe(5)
  expect(r?.feedback).toEqual(['a'])
  expect(r?.habits).toEqual({ verify: 'missed', target: 'shown' })
  expect(r?.previousUnclear).toBe('name the file')
  expect(r?.rules).toEqual(['Use pnpm'])
  expect(parseReview('not json')).toBeUndefined()
})

test('isTrivial skips acknowledgements but not short real asks', async () => {
  expect(isTrivial('yes', 30)).toBe(true)
  expect(isTrivial('Go ahead!', 0)).toBe(true)
  expect(isTrivial('2', 5)).toBe(true)
  expect(isTrivial('run tests', 1)).toBe(true)
  expect(isTrivial('run tests', 12)).toBe(false)
  expect(isTrivial('fix the bug', 0)).toBe(false)
})

test('clipMiddle keeps the end of a long answer, where Claude asks back', async () => {
  const answer = `${'x'.repeat(10_000)} Which file did you mean?`
  const clipped = clipMiddle(answer, 1000)
  expect(clipped.length).toBeLessThan(1100)
  expect(clipped).toContain('Which file did you mean?')
})

test('stepLine names the main argument of a tool call', async () => {
  expect(stepLine('Read', { file_path: 'src/auth.ts', tool_use_id: 'x' })).toBe('Read: src/auth.ts')
  expect(stepLine('Grep', { pattern: 'login' })).toBe('Grep: login')
  expect(stepLine('TodoWrite', { todos: [] })).toBe('TodoWrite')
})

test('buildPrompt carries the previous answer, the focus habit and the steps', async () => {
  const earlier = [entry({ prompt: 'add a login page', answer: 'Done. Want me to add tests too?' })]
  const text = buildPrompt(entry({ prompt: 'yes, with vitest', tools: ['Read'], steps: ['Read: src/login.tsx'] }), earlier, { focus: 'verify', rules: ['Use pnpm, not npm'] })
  expect(text).toContain('Want me to add tests too?')
  expect(text).toContain('<developer_focus_habit>verify')
  expect(text).toContain('Read: src/login.tsx')
  expect(text).toContain('- Use pnpm, not npm')
})

test('weakHabits ranks the habit missed most, once it applied often enough', async () => {
  const entries = [
    entry({ habits: { verify: 'missed', target: 'shown' } }),
    entry({ habits: { verify: 'missed', target: 'shown' } }),
    entry({ habits: { verify: 'missed', target: 'shown', plan: 'missed' } }),
    entry({ habits: { verify: 'shown', target: 'shown' } }),
  ]
  expect(weakHabits(entries, 2)).toEqual(['verify'])
  expect(weakHabits([entry({ habits: { plan: 'missed' } })])).toEqual([])
})

test('cleanRewrite strips a fence or quotes around a rewritten prompt', async () => {
  expect(cleanRewrite('```\nFix it in a.ts\n```')).toBe('Fix it in a.ts')
  expect(cleanRewrite('"Fix it in a.ts"')).toBe('Fix it in a.ts')
})

test('ruleSuggestions offers an instruction repeated in two prompts, unless dismissed', async () => {
  const entries = [
    entry({ rules: ['Use pnpm, not npm', 'Use pnpm, not npm'] }),
    entry({ rules: ['use pnpm, not npm', 'Keep tests in tests/'] }),
  ]
  expect(ruleSuggestions(entries, [])).toEqual([{ text: 'use pnpm, not npm', count: 2 }])
  expect(ruleSuggestions(entries, ['use pnpm, not npm'])).toEqual([])
})

test('habitStats compares tokens spent when a habit was shown and missed', async () => {
  const entries = [
    entry({ habits: { target: 'shown' }, tokens: 20_000 }),
    entry({ habits: { target: 'shown' }, tokens: 30_000 }),
    entry({ habits: { target: 'missed' }, tokens: 80_000 }),
    entry({ habits: { target: 'missed' }, tokens: 120_000 }),
  ]
  const target = habitStats(entries).find(s => s.id === 'target')
  expect(target?.tokensShown).toBe(25_000)
  expect(target?.tokensMissed).toBe(100_000)
})

test('lintDraft flags what a draft is missing, and stays quiet on short or complete ones', async () => {
  expect(lintDraft('the checkout is broken please fix it')).toEqual(['no error pasted', 'no file named'])
  expect(lintDraft('refactor the whole data layer to repositories')).toEqual(['no file named', 'big change: ask for a plan'])
  expect(lintDraft('yes do it')).toEqual([])
  expect(lintDraft('/compact keep the auth notes')).toEqual([])
  expect(lintDraft('Add a --json flag to cli/export.ts, then run npm test')).toEqual([])
})

test('diffWords marks only the words the rewrite added', async () => {
  const parts = diffWords('fix the login bug', 'Fix the login bug in src/auth.ts, then run npm test')
  expect(parts.filter(p => !p.isAdded).map(p => p.text.trim())).toEqual(['Fix the login bug'])
  expect(parts.filter(p => p.isAdded).map(p => p.text.trim()).join(' ')).toBe('in src/auth.ts, then run npm test')
})

test('placeholders splits out [fill in] runs', async () => {
  expect(placeholders('Fix it [paste the error] now')).toEqual([
    { text: 'Fix it ', isPlaceholder: false },
    { text: '[paste the error]', isPlaceholder: true },
    { text: ' now', isPlaceholder: false },
  ])
})

test('streak counts the latest prompts that kept a habit, skipping ones it did not apply to', async () => {
  const entries = [
    entry({ habits: { verify: 'missed' } }),
    entry({ habits: { verify: 'shown' } }),
    entry({ habits: { target: 'shown' } }),
    entry({ habits: { verify: 'shown' } }),
  ]
  expect(streak(entries, 'verify')).toBe(2)
  expect(streak(entries, 'plan')).toBe(0)
})

test('relTime reads as a short age', async () => {
  expect(relTime(20_000)).toBe('now')
  expect(relTime(5 * 60_000)).toBe('5m')
  expect(relTime(3 * 3_600_000)).toBe('3h')
  expect(relTime(2 * 86_400_000)).toBe('2d')
})
