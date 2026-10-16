import type { CoachEntry, HabitId, HabitMark } from '../types'

export const HABITS: readonly { id: HabitId; name: string; advice: string }[] = [
  { id: 'target', name: 'Point at the code', advice: 'Name the files, functions or commands involved, or @-mention them.' },
  { id: 'goal', name: 'Say what done looks like', advice: 'State the outcome you want, not just the area to work on.' },
  { id: 'evidence', name: 'Paste the evidence', advice: 'Include the error, stack trace, output or steps to reproduce.' },
  { id: 'verify', name: 'Say how to check', advice: 'Tell Claude which test, build or command proves it works.' },
  { id: 'constraints', name: 'Set the limits', advice: "Say what not to touch, and which libraries or style to keep." },
  { id: 'scope', name: 'One task at a time', advice: 'Split unrelated asks; /clear between unrelated tasks.' },
  { id: 'plan', name: 'Plan big changes first', advice: 'Ask for a plan (shift+tab for plan mode) before large or risky edits.' },
]

const HABIT_IDS = new Set<string>(HABITS.map(h => h.id))

export const habitName = (id: HabitId) => HABITS.find(h => h.id === id)?.name ?? id

const HABIT_LINES = HABITS.map(h => `- ${h.id}: ${h.name}. ${h.advice}`).join('\n')

export const SYSTEM = `You are a Claude Code coach. You review one exchange between a developer and Claude Code (an agentic coding CLI) and help the developer build habits that get better results.

Judge the developer's PROMPT, not Claude's work. Use what Claude did as evidence of what the prompt left unclear: many searches or file reads mean the prompt did not say where to look; clarifying questions in the answer mean the goal or constraints were missing; a long turn on a small ask means the scope was vague; an interrupted turn usually means Claude went the wrong way.

Read the earlier prompts and the end of Claude's previous answer first. A short prompt that follows clearly from them (answering Claude's question, "now do the same for the tests") is a GOOD prompt: the context carries it.

The habits, by id:
${HABIT_LINES}

For each habit that APPLIES to this prompt, mark it "shown" or "missed". Leave out a habit that does not apply: "plan" applies only to large or risky changes, "evidence" only to bugs and failures, "verify" only to changes that can be checked, "target" only when the code involved was not already clear from the context.

Scores:
5 = Claude could act right away with no guessing. 4 = one small gap. 3 = Claude had to explore or guess at something the developer knew. 2 = vague: several gaps, Claude searched widely or asked back. 1 = Claude could not tell what was wanted.

Examples (prompt -> score, habits):
- "the login is broken fix it" -> 2; target missed, evidence missed, verify missed, goal missed
- "Login returns 401 for valid users since the token refactor (error below). Fix it in @src/auth/session.ts without changing the public API, then run npm test -- auth. [error]" -> 5; target, evidence, goal, constraints, verify shown
- "yes, and do the same for the signup form" after Claude offered to -> 5; no habits apply
- "refactor the whole data layer to use the repository pattern" -> 2; plan missed, scope missed, goal missed, verify missed
- "add a --json flag to the export command in cli/export.ts" -> 4; target shown, goal shown, verify missed

The developer's focus habit, when given, is the one they are working on: when the prompt shows it, say so first in the feedback ("You said how to check: good."); when it misses it, make that the first point.

If the prompt gives a STANDING instruction, one that would hold for future tasks in this project too (tooling, conventions, style, what never to touch: "use pnpm", "don't edit the generated files"), list it in "standing_instructions", each one short imperative line fit for CLAUDE.md, at most 3. A detail of this one task is not one. When one matches a known standing instruction given, copy that one's text exactly. Otherwise leave the list empty.

The developer's ratings of your past reviews, when given, show what feedback helps them: give more of what they rated helpful, less of what they rated unhelpful.

If THIS prompt corrects or redirects the previous one ("no, I meant...", "that's the wrong file"), set "previous_unclear" to one short line on what the previous prompt should have said; otherwise leave it empty.

Reply with JSON only, no prose, no code fence:
{"score": 1-5, "verdict": "<one short line>", "next_step": "<the single change that would have helped most, as an instruction to the developer, one line; empty if the prompt was a 5>", "feedback": ["<at most 3 short, specific points; name the actual files, errors or commands from the exchange>"], "better": "<the prompt rewritten as the developer should have sent it, keeping their language and intent; empty if it was already a 5>", "tip": "<one Claude Code feature or habit that fits this exchange, one line>", "habits": {"<habit id>": "shown" | "missed"}, "previous_unclear": "", "standing_instructions": []}

Claude Code features worth suggesting when they fit: plan mode (shift+tab), @file mentions, CLAUDE.md for instructions you repeat, /clear between unrelated tasks, /compact, subagents for parallel research, ! to run a shell command yourself so its output lands in context, custom slash commands or skills for repeated workflows, hooks for automatic checks.`

export const IMPROVE_SYSTEM = `You rewrite a developer's draft prompt for Claude Code (an agentic coding CLI) so Claude can act on it right away.

Keep the developer's intent, language and voice. Keep it short: a few sentences, never a spec. Use what the conversation so far makes clear: name the files, functions, errors and commands it mentions. Never invent a fact or a decision you were not given: no new requirements, names or values the developer did not choose. Where a needed fact or decision is missing, put a short bracketed placeholder the developer fills in, like [paste the error] or [env var or config file?]. Add one line on how to verify when the change can be checked. Ask for a plan first only when the change is large or risky.

The habits a strong prompt shows:
${HABIT_LINES}

Reply with the rewritten prompt alone: no preamble, no quotes, no code fence.`

export type Review = Pick<CoachEntry, 'score' | 'verdict' | 'nextStep' | 'feedback' | 'better' | 'tip' | 'habits' | 'rules'> & {
  previousUnclear: string
}

const ACK =
  /^(y|yes|yep|yeah|ya|no|nope|ok|okay|k|sure|go|go ahead|go on|continue|proceed|do it|please do|thanks|thank you|ty|lgtm|sounds good|perfect|great|nice|cool|done|next|retry|try again|keep going|\d+|[a-d])[.!\s]*$/i

// A follow-up a review could only call fine: an acknowledgement, or two words
// that set off little work. "fix the bug" is three words and is reviewed.
export function isTrivial(prompt: string, tools: number): boolean {
  const text = prompt.trim()
  if (ACK.test(text)) return true
  const words = text.split(/\s+/).filter(Boolean).length

  return words <= 2 && tools <= 3
}

export const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

const clipEnd = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}\n[... ${text.length - max} more characters]` : text

// Keeps the opening and, longer, the end: where Claude asks back or sums up.
export function clipMiddle(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.35)
  const tail = max - head

  return `${text.slice(0, head)}\n[... ${text.length - max} characters left out ...]\n${text.slice(-tail)}`
}

const clipTail = (text: string, max: number) => (text.length > max ? `[...]${text.slice(-max)}` : text)

const ARG_KEYS = ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description', 'prompt', 'skill'] as const

// One short line for a tool call: its name and its main argument.
export function stepLine(tool: string, args: Readonly<Record<string, unknown>>): string {
  for (const key of ARG_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') {
      const arg = oneLine(value)

      return `${tool}: ${arg.length > 80 ? `${arg.slice(0, 77)}...` : arg}`
    }
  }

  return tool
}

export function toolSummary(tools: readonly string[]): string {
  if (tools.length === 0) return 'none'
  const counts = new Map<string, number>()
  for (const t of tools) counts.set(t, (counts.get(t) ?? 0) + 1)

  return [...counts].map(([t, n]) => (n > 1 ? `${t} ×${n}` : t)).join(', ')
}

function context(earlier: readonly CoachEntry[]): string[] {
  const prompts = earlier
    .slice(-3)
    .map(e => `- ${clipEnd(oneLine(e.prompt), 300)}`)
    .join('\n')
  const last = earlier[earlier.length - 1]

  return [
    prompts ? `<earlier_prompts oldest_first="true">\n${prompts}\n</earlier_prompts>` : '',
    last && last.answer ? `<end_of_previous_answer>\n${clipTail(last.answer, 1500)}\n</end_of_previous_answer>` : '',
  ]
}

export type ReviewContext = {
  // The habit the developer is working on.
  focus?: HabitId
  // Standing instructions already seen, so a repeat is worded the same.
  rules?: readonly string[]
  // Past reviews the developer rated.
  ratings?: readonly CoachEntry[]
}

export function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens)
}

export function buildPrompt(entry: CoachEntry, earlier: readonly CoachEntry[], ctx: ReviewContext = {}): string {
  const { focus, rules = [], ratings = [] } = ctx
  const rated = ratings
    .filter(e => e.rating && e.verdict)
    .slice(-6)
    .map(e => `- ${e.rating === 'up' ? 'helpful' : 'unhelpful'}: ${e.verdict}${e.feedback?.[0] ? ` | ${e.feedback[0]}` : ''}`)
    .join('\n')

  const steps = entry.steps ?? []
  const shown = steps.slice(0, 25).join('\n')
  const more = steps.length > 25 ? `\n[... ${steps.length - 25} more]` : ''

  return [
    ...context(earlier),
    focus ? `<developer_focus_habit>${focus}: ${habitName(focus)}</developer_focus_habit>` : '',
    rules.length > 0 ? `<known_standing_instructions>\n${rules.map(r => `- ${r}`).join('\n')}\n</known_standing_instructions>` : '',
    rated ? `<developer_ratings_of_past_reviews>\n${rated}\n</developer_ratings_of_past_reviews>` : '',
    `<prompt>\n${clipEnd(entry.prompt, 4000)}\n</prompt>`,
    `<what_claude_did tool_calls="${entry.tools.length}" summary="${toolSummary(entry.tools)}">\n${shown}${more}\n</what_claude_did>`,
    `<turn_seconds>${Math.round(entry.durationMs / 1000)}</turn_seconds>`,
    entry.tokens ? `<turn_tokens>${entry.tokens}</turn_tokens>` : '',
    entry.interrupted ? '<interrupted_by_developer>true</interrupted_by_developer>' : '',
    `<answer>\n${clipMiddle(entry.answer, 6000)}\n</answer>`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function buildImprovePrompt(draft: string, earlier: readonly CoachEntry[], weak: readonly HabitId[]): string {
  return [
    ...context(earlier),
    weak.length > 0 ? `<habits_this_developer_often_misses>${weak.join(', ')}</habits_this_developer_often_misses>` : '',
    `<draft>\n${clipEnd(draft, 6000)}\n</draft>`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

// Strips a fence or quotes a model put around a rewritten prompt.
export function cleanRewrite(text: string): string {
  let t = text.trim()
  const fence = /^```[a-z]*\n([\s\S]*?)\n```$/.exec(t)
  if (fence?.[1] !== undefined) t = fence[1].trim()
  if (t.length > 1 && /^["“]/.test(t) && /["”]$/.test(t)) t = t.slice(1, -1).trim()

  return t
}

export function parseReview(text: string): Review | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  const score = Number(r.score)
  if (!Number.isFinite(score)) return undefined

  const habits: Partial<Record<HabitId, HabitMark>> = {}
  if (typeof r.habits === 'object' && r.habits !== null) {
    for (const [id, mark] of Object.entries(r.habits as Record<string, unknown>)) {
      if (HABIT_IDS.has(id) && (mark === 'shown' || mark === 'missed')) habits[id as HabitId] = mark
    }
  }

  return {
    score: Math.min(5, Math.max(1, Math.round(score))),
    verdict: typeof r.verdict === 'string' ? r.verdict.trim() : '',
    nextStep: typeof r.next_step === 'string' ? r.next_step.trim() : '',
    feedback: Array.isArray(r.feedback)
      ? r.feedback.filter((f): f is string => typeof f === 'string' && f.trim() !== '').slice(0, 3)
      : [],
    better: typeof r.better === 'string' ? r.better.trim() : '',
    tip: typeof r.tip === 'string' ? r.tip.trim() : '',
    habits,
    previousUnclear: typeof r.previous_unclear === 'string' ? r.previous_unclear.trim() : '',
    rules: Array.isArray(r.standing_instructions)
      ? r.standing_instructions
          .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
          .map(oneLine)
          .slice(0, 3)
      : [],
  }
}

export function average(entries: readonly CoachEntry[]): number | undefined {
  const scored = entries.filter(e => e.status === 'done' && e.score !== undefined)
  if (scored.length === 0) return undefined

  return scored.reduce((sum, e) => sum + (e.score ?? 0), 0) / scored.length
}

export type HabitStat = {
  id: HabitId
  name: string
  advice: string
  shown: number
  missed: number
  // Share shown, 0 to 1; undefined before the habit applied to any prompt.
  rate: number | undefined
  // The newer half's rate minus the older half's, when both halves have marks.
  trend: number | undefined
  // Mean tokens per turn when the habit was shown, and when missed: what it saves.
  tokensShown: number | undefined
  tokensMissed: number | undefined
}

const WINDOW = 30
// A habit is a focus candidate once it applied to this many recent prompts.
const MIN_MARKS = 3

export function habitStats(entries: readonly CoachEntry[]): HabitStat[] {
  const recent = entries.filter(e => e.status === 'done' && e.habits).slice(-WINDOW)

  return HABITS.map(h => {
    const marks = recent.map(e => e.habits?.[h.id]).filter((m): m is HabitMark => m !== undefined)
    const meanTokens = (mark: HabitMark) => {
      const ts = recent.filter(e => e.habits?.[h.id] === mark && e.tokens).map(e => e.tokens ?? 0)

      return ts.length >= 2 ? ts.reduce((a, b) => a + b, 0) / ts.length : undefined
    }
    const shown = marks.filter(m => m === 'shown').length
    const rateOf = (ms: HabitMark[]) => (ms.length === 0 ? undefined : ms.filter(m => m === 'shown').length / ms.length)
    const half = Math.floor(marks.length / 2)
    const older = rateOf(marks.slice(0, half))
    const newer = rateOf(marks.slice(half))

    return {
      ...h,
      shown,
      missed: marks.length - shown,
      rate: rateOf(marks),
      trend: marks.length >= 4 && older !== undefined && newer !== undefined ? newer - older : undefined,
      tokensShown: meanTokens('shown'),
      tokensMissed: meanTokens('missed'),
    }
  })
}

// The habits missed most, worst first: the first is the one to work on. A
// graduated habit comes back only once it slips below half.
export function weakHabits(entries: readonly CoachEntry[], count = 2, graduated: readonly HabitId[] = []): HabitId[] {
  return habitStats(entries)
    .filter(s => s.rate !== undefined && s.shown + s.missed >= MIN_MARKS && s.rate < 0.8)
    .filter(s => !graduated.includes(s.id) || (s.rate ?? 1) < 0.5)
    .sort((a, b) => (a.rate ?? 1) - (b.rate ?? 1) || b.missed - a.missed)
    .slice(0, count)
    .map(s => s.id)
}

// The distinct standing instructions seen, newest spelling of each, for the coach to reuse.
export function knownRules(entries: readonly CoachEntry[], max = 15): string[] {
  const byKey = new Map<string, string>()
  for (const e of entries) for (const rule of e.rules ?? []) byKey.set(rule.toLowerCase(), rule)

  return [...byKey.values()].slice(-max)
}

export type RuleSuggestion = { text: string; count: number }

// Standing instructions given in two or more prompts: lines for CLAUDE.md.
export function ruleSuggestions(entries: readonly CoachEntry[], dismissed: readonly string[]): RuleSuggestion[] {
  const counts = new Map<string, RuleSuggestion>()
  for (const e of entries) {
    // Counted once per prompt, however often it says it.
    for (const rule of new Set(e.rules ?? [])) {
      const key = rule.toLowerCase()
      counts.set(key, { text: rule, count: (counts.get(key)?.count ?? 0) + 1 })
    }
  }

  return [...counts]
    .filter(([key, r]) => r.count >= 2 && !dismissed.includes(key))
    .map(([, r]) => r)
    .sort((a, b) => b.count - a.count)
}

export const claudeMdPrompt = (rule: string) =>
  `Add this line to CLAUDE.md, in the section where it fits (create the file at the project root if there is none): "${rule}"`

// How many of the most recent prompts the habit applied to showed it, in a row.
export function streak(entries: readonly CoachEntry[], habit: HabitId): number {
  let n = 0
  for (let i = entries.length - 1; i >= 0; i--) {
    const mark = entries[i]?.status === 'done' ? entries[i]?.habits?.[habit] : undefined
    if (mark === undefined) continue
    if (mark === 'missed') break
    n++
  }

  return n
}

export const STREAK_TO_GRADUATE = 3

// Cheap checks on a draft as it is typed: no model call. At most two, the
// most useful first; none for short drafts, commands and shell lines.
export function lintDraft(text: string): string[] {
  const t = text.trim()
  if (t.startsWith('/') || t.startsWith('!')) return []
  const words = t.split(/\s+/).filter(Boolean).length
  if (words < 4) return []
  const lower = t.toLowerCase()
  const hints: string[] = []
  const isBug = /\b(fix|bug|broken|error|errors|fail|fails|failing|crash|crashes|exception|wrong|issue)\b/.test(lower)
  const hasEvidence = /```|\n\s+at |error:|exception:|traceback|stack|expected .* (got|received)|"[^"]{12,}"|`[^`]{12,}`/i.test(t)
  const hasTarget = /@\S+|[\w-]+\/[\w./-]+|\b[\w-]+\.(ts|tsx|js|jsx|py|go|rs|rb|java|kt|swift|md|json|ya?ml|css|html|sql|sh)\b|`[^`]+`|\b\w+\(\)/i.test(t)
  const isChange = /\b(add|fix|implement|build|create|refactor|change|update|make|rename|remove|delete|migrate|write)\b/.test(lower)
  const hasCheck = /\b(test|tests|run|check|verify|build|lint|typecheck|confirm|ensure|expect|should pass|prove)\b/.test(lower)
  const isBig = /\b(refactor|rewrite|migrate|redesign|overhaul|whole|entire|everything|all the)\b/.test(lower)
  const hasPlan = /\b(plan|first propose|outline|step by step|before (you )?(change|edit|start))\b/.test(lower)

  if (isBug && !hasEvidence) hints.push('no error pasted')
  if (!hasTarget) hints.push('no file named')
  if (isBig && !hasPlan) hints.push('big change: ask for a plan')
  if (isChange && !hasCheck) hints.push('no way to check')

  return hints.slice(0, 2)
}

export type DiffPart = { text: string; isAdded: boolean }

// The words of `after` marked new where they are not in `before`, by a
// longest common subsequence over words; a long pair is not diffed.
export function diffWords(before: string, after: string): DiffPart[] {
  const a = before.split(/(\s+)/).filter(x => x !== '')
  const b = after.split(/(\s+)/).filter(x => x !== '')
  if (a.length * b.length > 250_000) return [{ text: after, isAdded: false }]
  const key = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}@./_-]/gu, '')
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        key(a[i]!) === key(b[j]!) && key(a[i]!) !== '' ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }
  const parts: DiffPart[] = []
  const push = (text: string, isAdded: boolean) => {
    // Whitespace joins whichever run it sits in.
    const added = /^\s+$/.test(text) ? (parts[parts.length - 1]?.isAdded ?? false) : isAdded
    const last = parts[parts.length - 1]
    if (last && last.isAdded === added) last.text += text
    else parts.push({ text, isAdded: added })
  }
  let i = 0
  let j = 0
  while (j < b.length) {
    if (i < a.length && key(a[i]!) === key(b[j]!) && key(a[i]!) !== '') {
      push(b[j]!, false)
      i++
      j++
    } else if (i < a.length && lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      i++
    } else {
      push(b[j]!, true)
      j++
    }
  }

  return parts
}

// Splits text into runs, marking [placeholders] the developer fills in.
export function placeholders(text: string): { text: string; isPlaceholder: boolean }[] {
  return text
    .split(/(\[[^\]\n]{1,60}\])/)
    .filter(x => x !== '')
    .map(x => ({ text: x, isPlaceholder: /^\[[^\]]+\]$/.test(x) }))
}

export function relTime(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86_400) return `${Math.round(s / 3600)}h`

  return `${Math.round(s / 86_400)}d`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function sessionLabel(start: number, now: number): string {
  const d = new Date(start)
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const sameDay = new Date(now).toDateString() === d.toDateString()

  return sameDay ? `today ${time}` : `${MONTHS[d.getMonth()]} ${d.getDate()} ${time}`
}
