export type CoachStatus = 'reviewing' | 'done' | 'failed' | 'skipped'

export type HabitId = 'target' | 'goal' | 'evidence' | 'verify' | 'constraints' | 'scope' | 'plan'

export type HabitMark = 'shown' | 'missed'

export type CoachEntry = {
  id: string
  at: number
  prompt: string
  answer: string
  // Tool names, one per call, for the counts.
  tools: string[]
  // One short line per call with its main argument (`Read: src/a.ts`).
  steps?: string[]
  durationMs: number
  status: CoachStatus
  // The turn was interrupted by the person.
  interrupted?: boolean
  score?: number
  verdict?: string
  feedback?: string[]
  better?: string
  tip?: string
  // The habits this prompt showed or missed; a habit that did not apply is absent.
  habits?: Partial<Record<HabitId, HabitMark>>
  // Set when the next prompt had to correct this one.
  followup?: string
  // The directory the session ran in.
  project?: string
  // What the turn cost, all input and output tokens summed.
  tokens?: number
  // Standing instructions the prompt gave, each worded for CLAUDE.md.
  rules?: string[]
  // The person's rating of this review.
  rating?: 'up' | 'down'
  // The one change that would have helped most: the review's headline.
  nextStep?: string
  // When the review in flight started, for its elapsed time.
  reviewStartedAt?: number
  // The start time of the session the prompt was sent in.
  session?: number
  error?: string
}

// Improve draft's progress, and the draft it replaced, for Undo.
export type DraftState =
  | { phase: 'improving' }
  // `use`: Use it replaced the draft with a review's better prompt.
  | { phase: 'improved'; original: string; source: 'improve' | 'use' }
  | { phase: 'failed'; error: string }

declare module 'claude-code' {
  interface PluginState {
    'prompt-coach': {
      entries: CoachEntry[]
      // The id the pane shows in detail; null follows the newest.
      selected: string | null
      view: 'review' | 'habits'
      // Which prompts the review trail lists.
      scope: 'project' | 'all'
      // Repeated instructions the person dismissed, lowercased.
      dismissedRules: string[]
      draft: DraftState | null
      // What the prompt box holds now: whether it has a draft, and the
      // local checks it fails.
      box: { hasText: boolean; hints: string[] }
      // Whether the sidebar is showing.
      paneOpen: boolean
      // The line above the prompt, hidden for this session.
      bandHidden: boolean
      // The quoted prompt shown whole on a narrow sidebar.
      expanded: boolean
      // The first-run card was dismissed.
      welcomed: boolean
      // Habits kept three prompts in a row, no longer the focus.
      graduated: HabitId[]
      // The time, advanced each second while a review runs, to redraw it.
      tick: number
    }
  }
}
