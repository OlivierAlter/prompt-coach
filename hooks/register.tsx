import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { CoachEntry, HabitId } from '../types'
import {
  average,
  buildImprovePrompt,
  buildPrompt,
  claudeMdPrompt,
  cleanRewrite,
  diffWords,
  formatTokens,
  habitName,
  habitStats,
  IMPROVE_SYSTEM,
  isTrivial,
  knownRules,
  lintDraft,
  oneLine,
  parseReview,
  placeholders,
  relTime,
  ruleSuggestions,
  sessionLabel,
  stepLine,
  streak,
  STREAK_TO_GRADUATE,
  SYSTEM,
  weakHabits,
} from './coach'

const PANE = 'prompt-coach'
const TITLE = 'Prompt coach'
const KEEP = 300
const STORE_KEY = 'history'
const DISMISSED_KEY = 'dismissedRules'
const WELCOMED_KEY = 'welcomed'
const GRADUATED_KEY = 'graduated'
// A review running longer than this offers Retry.
const SLOW_MS = 30_000
// Below this many columns the sidebar stacks and shortens.
const NARROW = 45

const ENTRIES = atom({ plugin: 'prompt-coach', key: 'entries' } as const, [])
const SELECTED = atom({ plugin: 'prompt-coach', key: 'selected' } as const, null)
const VIEW = atom({ plugin: 'prompt-coach', key: 'view' } as const, 'review')
const SCOPE = atom({ plugin: 'prompt-coach', key: 'scope' } as const, 'project')
const DISMISSED = atom({ plugin: 'prompt-coach', key: 'dismissedRules' } as const, [])
const DRAFT = atom({ plugin: 'prompt-coach', key: 'draft' } as const, null)
const BOX = atom({ plugin: 'prompt-coach', key: 'box' } as const, { hasText: false, hints: [] })
const PANE_OPEN = atom({ plugin: 'prompt-coach', key: 'paneOpen' } as const, false)
const BAND_HIDDEN = atom({ plugin: 'prompt-coach', key: 'bandHidden' } as const, false)
const EXPANDED = atom({ plugin: 'prompt-coach', key: 'expanded' } as const, false)
const WELCOMED = atom({ plugin: 'prompt-coach', key: 'welcomed' } as const, false)
const GRADUATED = atom({ plugin: 'prompt-coach', key: 'graduated' } as const, [])
const TICK = atom({ plugin: 'prompt-coach', key: 'tick' } as const, 0)

// The prompt of the turn now running, and what it ran. Module variables:
// a reload mid-turn only loses that one turn's review.
let pending: { prompt: string; tools: string[]; steps: string[] } | null = null
let counter = 0
// The session's directory and start, read at its start; entries carry both.
let project = ''
let sessionStart = 0
// The latest attempt per entry: a retried review's older reply is dropped.
const attempts = new Map<string, number>()
// Redraws the elapsed time while a review runs.
let ticker: Timer | null = null
// What the box last held, so a keystroke that changes nothing writes nothing.
let lastBoxKey = 'empty'

// Set from the plugin's options each time register runs.
let model = 'sonnet'
let isAutoReview = true

const scoreColor = (score: number) => (score >= 4 ? 'green' : 'yellow')
const bar = (rate: number, width = 10) => {
  const full = Math.round(rate * width)

  return '█'.repeat(full) + '░'.repeat(width - full)
}
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))
const projectName = (dir: string) => dir.split('/').filter(Boolean).pop() ?? dir
const isCommandLine = (text: string) => text.startsWith('/') || text.startsWith('!')

async function save($: EngineInterface, entries: CoachEntry[]) {
  await $.store.set(
    STORE_KEY,
    entries.filter(e => e.status !== 'reviewing').slice(-KEEP),
  )
}

async function openPane($: EngineInterface) {
  const r = await $.ui.open({ id: PANE, title: TITLE })
  await update($, PANE_OPEN, () => r.isPlaced)
}

async function tickOnce($: EngineInterface) {
  const isReviewing = (await read($, ENTRIES)).some(e => e.status === 'reviewing')
  if (!isReviewing) {
    ticker?.cancel()
    ticker = null

    return
  }
  const now = await $.clock.now()
  await update($, TICK, () => now)
}

function startTicker($: EngineInterface) {
  if (!ticker) {
    ticker = $.clock.every(1000, () =>
      // A module the host unloaded can no longer write: stop asking.
      void tickOnce($).catch(() => {
        ticker?.cancel()
        ticker = null
      }),
    )
  }
}

async function review($: EngineInterface, id: string) {
  const attempt = (attempts.get(id) ?? 0) + 1
  attempts.set(id, attempt)
  const startedAt = await $.clock.now()
  const all = await update($, ENTRIES, list =>
    list.map(e => (e.id === id ? { ...e, status: 'reviewing' as const, reviewStartedAt: startedAt } : e)),
  )
  await update($, TICK, () => startedAt)
  startTicker($)
  const at = all.findIndex(e => e.id === id)
  const entry = all[at]
  if (!entry) return
  const earlier = all.slice(0, at)
  const sameProject = earlier.filter(e => e.project === entry.project)
  const graduated = await read($, GRADUATED)
  const [focus] = weakHabits(earlier, 1, graduated)
  let patch: Partial<CoachEntry>
  let previousUnclear = ''
  try {
    const r = await $.model.complete({
      model,
      system: [{ text: SYSTEM, cache: true }],
      prompt: buildPrompt(entry, sameProject, { focus, rules: knownRules(sameProject), ratings: all.filter(e => e.rating) }),
      maxTokens: 1000,
      effort: 'low',
      timeoutMs: 90_000,
    })
    const parsed = r.isAnswered ? parseReview(r.text) : undefined
    if (parsed) {
      const { previousUnclear: note, ...rest } = parsed
      previousUnclear = note
      patch = { status: 'done', error: undefined, ...rest }
    } else {
      patch = {
        status: 'failed',
        error: r.isAnswered ? 'The coach replied in a shape it could not read.' : `No review: ${r.reason}`,
      }
    }
  } catch (err) {
    patch = { status: 'failed', error: errorText(err) }
  }
  // A retry started since: its reply is the one that counts.
  if (attempts.get(id) !== attempt) return
  const previous = sameProject[sameProject.length - 1]
  const next = await update($, ENTRIES, list =>
    list.map(e => {
      if (e.id === id) return { ...e, ...patch, reviewStartedAt: undefined }
      if (previousUnclear && previous && e.id === previous.id) return { ...e, followup: previousUnclear }

      return e
    }),
  )
  await save($, next)

  // Kept the focus habit enough prompts in a row: it graduates.
  if (focus && patch.habits?.[focus] === 'shown' && streak(next, focus) >= STREAK_TO_GRADUATE) {
    const grads = await update($, GRADUATED, list => (list.includes(focus) ? list : [...list, focus]))
    await $.store.set(GRADUATED_KEY, grads)
    const [nextFocus] = weakHabits(next, 1, grads)
    $.ui.toast(
      `Coach: ${STREAK_TO_GRADUATE} in a row: "${habitName(focus)}" is a habit now.${nextFocus ? ` Next focus: ${habitName(nextFocus)}.` : ''}`,
    )
  }

  // Say so once, when an instruction first repeats: it belongs in CLAUDE.md.
  const given = new Set((patch.rules ?? []).map(r => r.toLowerCase()))
  if (given.size > 0) {
    const dismissed = await read($, DISMISSED)
    const repeated = ruleSuggestions(next.filter(e => e.project === entry.project), dismissed).find(
      s => s.count === 2 && given.has(s.text.toLowerCase()),
    )
    if (repeated) $.ui.toast(`Coach: you've asked "${repeated.text}" twice. Habits view can add it to CLAUDE.md.`)
  }
}

async function rate($: EngineInterface, id: string, rating: 'up' | 'down') {
  const next = await update($, ENTRIES, list =>
    list.map(e => (e.id === id ? { ...e, rating: e.rating === rating ? undefined : rating } : e)),
  )
  await save($, next)
}

async function dismissRule($: EngineInterface, text: string) {
  const next = await update($, DISMISSED, list => [...list, text.toLowerCase()])
  await $.store.set(DISMISSED_KEY, next)
}

async function dismissWelcome($: EngineInterface) {
  await update($, WELCOMED, () => true)
  await $.store.set(WELCOMED_KEY, true)
}

// Puts a review's better prompt in the box; a draft it replaces can come back.
async function useBetter($: EngineInterface, text: string) {
  const box = await $.prompt.read()
  const filled = await $.prompt.fill({ text })
  const kept = box.text.trim()
  if (filled.isFilled && kept !== '' && kept !== text.trim()) {
    await update($, DRAFT, () => ({ phase: 'improved' as const, original: box.text, source: 'use' as const }))
  }
}

async function improveDraft($: EngineInterface) {
  if ((await read($, DRAFT))?.phase === 'improving') return
  const box = await $.prompt.read()
  const draft = box.text.trim()
  if (draft === '' || isCommandLine(draft)) {
    await update($, DRAFT, () => ({ phase: 'failed' as const, error: 'Type a prompt in the box first, then press Improve draft.' }))

    return
  }
  await update($, DRAFT, () => ({ phase: 'improving' as const }))
  const entries = await read($, ENTRIES)
  const here = entries.filter(e => e.project === project)
  const graduated = await read($, GRADUATED)
  try {
    const r = await $.model.complete({
      model,
      system: [{ text: IMPROVE_SYSTEM, cache: true }],
      prompt: buildImprovePrompt(draft, here, weakHabits(entries, 2, graduated)),
      maxTokens: 1500,
      effort: 'low',
      timeoutMs: 90_000,
    })
    const improved = r.isAnswered ? cleanRewrite(r.text) : ''
    if (!r.isAnswered || improved === '') {
      await update($, DRAFT, () => ({
        phase: 'failed' as const,
        error: r.isAnswered ? 'The coach returned an empty draft.' : `Could not improve the draft: ${r.reason}`,
      }))

      return
    }
    // Never overwrite what the person typed while the coach worked.
    if ((await $.prompt.read()).text.trim() !== draft) {
      await update($, DRAFT, () => ({ phase: 'failed' as const, error: 'Your draft changed meanwhile; press Improve draft again.' }))

      return
    }
    const filled = await $.prompt.fill({ text: improved })
    await update($, DRAFT, () =>
      filled.isFilled
        ? { phase: 'improved' as const, original: box.text, source: 'improve' as const }
        : { phase: 'failed' as const, error: 'The prompt box could not take the draft.' },
    )
  } catch (err) {
    await update($, DRAFT, () => ({ phase: 'failed' as const, error: errorText(err) }))
  }
}

async function undoDraft($: EngineInterface) {
  const draft = await read($, DRAFT)
  if (draft?.phase === 'improved') await $.prompt.fill({ text: draft.original })
  await update($, DRAFT, () => null)
}

async function noteBox($: EngineInterface, text: string) {
  const t = text.trim()
  const hasText = t !== '' && !isCommandLine(t)
  const hints = hasText ? lintDraft(t) : []
  const key = hasText ? `text:${hints.join('|')}` : 'empty'
  if (key === lastBoxKey) return
  lastBoxKey = key
  await update($, BOX, () => ({ hasText, hints }))
}

export const register: Register = (on, options) => {
  model = typeof options.model === 'string' && options.model.trim() !== '' ? options.model : 'sonnet'
  isAutoReview = options.autoReview !== false

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    project = e.cwd
    sessionStart = await $.clock.now()
    await $.command.register({
      name: 'prompt-coach',
      description: 'Open the prompt coach (args: habits, clear)',
    })
    if ((await read($, ENTRIES)).length === 0) {
      const saved = await $.store.get(STORE_KEY)
      if (Array.isArray(saved)) await update($, ENTRIES, () => saved as CoachEntry[])
      const dismissed = await $.store.get(DISMISSED_KEY)
      if (Array.isArray(dismissed)) await update($, DISMISSED, () => dismissed.filter((d): d is string => typeof d === 'string'))
      const graduated = await $.store.get(GRADUATED_KEY)
      if (Array.isArray(graduated)) await update($, GRADUATED, () => graduated as HabitId[])
      if ((await $.store.get(WELCOMED_KEY)) === true) await update($, WELCOMED, () => true)
    }
    // A reload drops the reviews the old module had in flight, and their
    // entries would read "Reviewing…" for good: run the recent ones again.
    const stuck = (await read($, ENTRIES)).filter(x => x.status === 'reviewing')
    const retry = new Set(stuck.slice(-3).map(x => x.id))
    if (stuck.length > retry.size) {
      await update($, ENTRIES, list =>
        list.map(x =>
          x.status === 'reviewing' && !retry.has(x.id)
            ? { ...x, status: 'failed' as const, error: 'The review was cut off by a reload. Press Review it.' }
            : x,
        ),
      )
    }
    for (const id of retry) void review($, id)
    if (e.isInteractive) void openPane($)

    return r
  })

  on('command.run', { command: 'prompt-coach' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'clear') {
      await update($, ENTRIES, () => [])
      await update($, SELECTED, () => null)
      await $.store.delete(STORE_KEY)

      return { text: 'Prompt coach history cleared.' }
    }
    await update($, VIEW, () => (arg === 'habits' ? 'habits' : 'review'))
    await update($, BAND_HIDDEN, () => false)
    await openPane($)

    return { text: arg === 'habits' ? 'Prompt coach: habits.' : 'Prompt coach opened.' }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    await update($, PANE_OPEN, () => false)

    return next(e)
  })

  on('prompt.change', async ($, e, next) => {
    const r = await next(e)
    await noteBox($, r.text)

    return r
  })

  on('prompt.submit', async ($, e, next) => {
    const isYours = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (isYours && !e.command && !e.isMeta && e.text.trim() !== '') {
      // A prompt typed while a turn runs joins that turn's prompt.
      if (e.turnId && pending) pending.prompt += `\n\n${e.text}`
      else pending = { prompt: e.text, tools: [], steps: [] }
      if (await read($, DRAFT)) await update($, DRAFT, () => null)
    }
    await noteBox($, '')

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (pending && !e.agentId) {
      pending.tools.push(e.tool)
      pending.steps.push(stepLine(e.tool, e as unknown as Record<string, unknown>))
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId || !pending) return r
    const turn = pending
    pending = null
    const interrupted = e.reason === 'aborted'
    if (e.reason !== 'answer' && !interrupted) return r
    // An interrupt before Claude did anything leaves nothing to learn from.
    if (interrupted && turn.tools.length === 0 && e.answer.trim() === '') return r

    const now = await $.clock.now()
    if (!project) project = await $.session.cwd().catch(() => '')
    const u = e.usage
    const tokens = u ? u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens : 0
    const isSkipped = !isAutoReview || (!interrupted && isTrivial(turn.prompt, turn.tools.length))
    const entry: CoachEntry = {
      id: `${now}-${counter++}`,
      at: now,
      prompt: turn.prompt,
      answer: e.answer,
      tools: turn.tools,
      steps: turn.steps,
      durationMs: e.durationMs,
      status: isSkipped ? 'skipped' : 'reviewing',
      project,
      ...(sessionStart ? { session: sessionStart } : {}),
      ...(tokens > 0 ? { tokens } : {}),
      ...(interrupted ? { interrupted: true } : {}),
    }
    const list = await update($, ENTRIES, l => [...l, entry].slice(-KEEP))
    await update($, SELECTED, () => null)
    if (isSkipped) await save($, list)
    else void review($, entry.id)

    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const [entries, draft, box, isPaneOpen, isHidden, graduated] = await Promise.all([
      read($, ENTRIES),
      read($, DRAFT),
      read($, BOX),
      read($, PANE_OPEN),
      read($, BAND_HIDDEN),
      read($, GRADUATED),
    ])
    const { Box, Text, Button } = $.ui.resolve(e)

    // What a press just did comes first, hidden or not: it holds the Undo.
    if (draft?.phase === 'improving') return <Text dimColor>Coach: improving your draft…</Text>
    if (draft?.phase === 'improved') {
      return (
        <Box flexDirection="row" gap={1}>
          <Text color="green">
            {draft.source === 'use' ? 'Coach: replaced your draft with the better prompt.' : 'Coach: draft improved.'}
          </Text>
          {draft.source === 'improve' ? <Text dimColor>Fill in any [placeholders], then send.</Text> : null}
          <Button key="undo-draft" hotkey="u" onPress={() => void undoDraft($)}>
            Undo
          </Button>
        </Box>
      )
    }
    if (draft?.phase === 'failed') {
      return (
        <Box flexDirection="row" gap={1}>
          <Text color="yellow">Coach: {draft.error}</Text>
          <Button key="dismiss-draft" hotkey="x" onPress={() => void update($, DRAFT, () => null)}>
            Dismiss
          </Button>
        </Box>
      )
    }
    if (isHidden) return next(e)

    const hide = (
      <Button key="hide-band" plain dimColor onPress={() => void update($, BAND_HIDDEN, () => true)}>
        ✕
      </Button>
    )

    // A draft in the box: check it as it is typed, and offer to improve it.
    if (box.hasText) {
      return (
        <Box flexDirection="row" gap={1}>
          {box.hints.length > 0 ? (
            <Text>
              <Text dimColor>Draft:</Text> <Text color="yellow">{box.hints.join(' · ')}</Text>
            </Text>
          ) : (
            <Text dimColor>Draft looks clear.</Text>
          )}
          <Button key="improve-draft" hotkey="i" onPress={() => void improveDraft($)}>
            Improve draft
          </Button>
          {hide}
        </Box>
      )
    }

    const avg = average(entries)
    const [focus] = weakHabits(entries, 1, graduated)
    if (avg === undefined && !focus && isPaneOpen) return next(e)

    return (
      <Box flexDirection="row" gap={1}>
        <Text dimColor>
          Coach{avg === undefined ? '' : ` · avg ${avg.toFixed(1)}/5`}
          {focus ? ' · focus: ' : ''}
        </Text>
        {focus ? (
          <Text color="yellow">
            {habitName(focus)}
            <Text dimColor>
              {' '}
              {streak(entries, focus)}/{STREAK_TO_GRADUATE}
            </Text>
          </Text>
        ) : null}
        {isPaneOpen ? null : (
          <Button key="open-coach" hotkey="o" dimColor onPress={() => void openPane($)}>
            Open
          </Button>
        )}
        {hide}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [all, selectedId, view, scope, dismissed, isExpanded, isWelcomed, graduated, tick] = await Promise.all([
      read($, ENTRIES),
      read($, SELECTED),
      read($, VIEW),
      read($, SCOPE),
      read($, DISMISSED),
      read($, EXPANDED),
      read($, WELCOMED),
      read($, GRADUATED),
      read($, TICK),
    ])
    const now = Math.max(tick, await $.clock.now())
    const width = Math.max(20, (e.viewport?.columns ?? e.props.bodyColumns ?? 50) - 2)
    const rows = e.viewport?.rows ?? 30
    const isNarrow = width < NARROW
    const here = all.filter(x => x.project === project)
    const avg = average(all)
    const reviewed = all.filter(x => x.status === 'done').length
    const [focus] = weakHabits(all, 1, graduated)
    const rules = ruleSuggestions(here, dismissed)
    const habitsBadge = (focus ? 1 : 0) + rules.length

    const tab = (key: string, hotkey: string, label: string, isActive: boolean, badge = 0) => (
      <Button key={key} hotkey={hotkey} plain onPress={() => void update($, VIEW, () => (key === 'view-habits' ? 'habits' : 'review') as 'habits' | 'review')}>
        {isActive ? (
          <Text bold underline>
            {label}
          </Text>
        ) : (
          <Text dimColor>{label}</Text>
        )}
        {badge > 0 ? <Text color="yellow">·{badge}</Text> : ''}
      </Button>
    )

    const header = (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>{TITLE}</Text>
          <Box flexDirection="row" gap={2}>
            {tab('view-review', 'r', 'Review', view === 'review')}
            {tab('view-habits', 'h', 'Habits', view === 'habits', habitsBadge)}
          </Box>
        </Box>
        <Text dimColor>{'─'.repeat(Math.min(width, 60))}</Text>
      </Box>
    )

    const footer = (
      <Box flexDirection="column">
        <Text dimColor>{'─'.repeat(Math.min(width, 60))}</Text>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {e.props.isFocused ? (
            <Text dimColor wrap="wrap">
              {view === 'review'
                ? 'u use · c copy · j/k move · e expand · y/n rate · i improve · h habits'
                : 'a add rule · d dismiss · i improve · r review'}
            </Text>
          ) : (
            <Text dimColor>ctrl+x tab to use keys</Text>
          )}
          <Button key="improve" hotkey="i" plain dimColor onPress={() => void improveDraft($)}>
            Improve draft
          </Button>
        </Box>
      </Box>
    )

    const welcome = isWelcomed ? null : (
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text bold>Welcome to Prompt coach</Text>
        <Text wrap="wrap">
          After each answer, the coach reviews the prompt you sent and suggests a better one. That is one {model} call, about
          half a cent; short follow-ups like "yes" are skipped.
        </Text>
        <Text wrap="wrap">
          <Text bold>u</Text> uses the better prompt · <Text bold>i</Text> improves your draft before you send ·{' '}
          <Text bold>h</Text> shows your habits. Press ctrl+x tab to give the sidebar the keys.
        </Text>
        <Button key="welcome-ok" hotkey="g" onPress={() => void dismissWelcome($)}>
          Got it
        </Button>
      </Box>
    )

    if (all.length === 0) {
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          {welcome}
          <Text dimColor wrap="wrap">
            Send a prompt. After Claude answers, a review of your prompt and a better version of it appear here.
          </Text>
          {footer}
        </Box>
      )
    }

    if (view === 'habits') {
      const stats = habitStats(all)
      const focusStat = stats.find(s => s.id === focus)
      const focusStreak = focus ? streak(all, focus) : 0
      const saving =
        focusStat?.tokensShown !== undefined && focusStat.tokensMissed !== undefined && focusStat.tokensMissed > focusStat.tokensShown
          ? Math.round((1 - focusStat.tokensShown / focusStat.tokensMissed) * 100)
          : undefined

      return (
        <Box flexDirection="column" gap={1}>
          {header}
          {welcome}
          {focusStat ? (
            <Box flexDirection="column">
              <Text bold color="yellow">
                Focus: {focusStat.name}
              </Text>
              <Text wrap="wrap">{focusStat.advice}</Text>
              <Text>
                <Text color="green">{'●'.repeat(focusStreak)}</Text>
                <Text dimColor>{'○'.repeat(Math.max(0, STREAK_TO_GRADUATE - focusStreak))}</Text>
                <Text dimColor>
                  {' '}
                  {focusStreak === 0
                    ? `keep it ${STREAK_TO_GRADUATE} prompts in a row to make it a habit`
                    : `${STREAK_TO_GRADUATE - focusStreak} more in a row to make it a habit`}
                </Text>
              </Text>
              {saving !== undefined && saving >= 10 ? (
                <Text color="green" wrap="wrap">
                  Your turns used {saving}% fewer tokens when you did this.
                </Text>
              ) : null}
            </Box>
          ) : (
            <Text dimColor wrap="wrap">
              {reviewed < 3 ? 'A few more reviewed prompts and your habits show here.' : 'No weak habit right now. Keep it up.'}
            </Text>
          )}
          <Box flexDirection="column">
            <Text dimColor>
              Last {Math.min(30, reviewed)} reviewed{avg === undefined ? '' : ` · avg ${avg.toFixed(1)}/5`}
            </Text>
            {stats.map(s => (
              <Text>
                <Text color={s.rate === undefined ? undefined : s.rate >= 0.8 ? 'green' : 'yellow'}>
                  {s.rate === undefined ? '░'.repeat(isNarrow ? 6 : 10) : bar(s.rate, isNarrow ? 6 : 10)}
                </Text>{' '}
                {s.id === focus ? <Text bold>{s.name}</Text> : s.name}
                <Text dimColor>
                  {s.rate === undefined
                    ? '  n/a'
                    : `  ${s.shown}/${s.shown + s.missed}${s.trend === undefined ? '' : s.trend > 0.1 ? ' ↑' : s.trend < -0.1 ? ' ↓' : ' →'}`}
                </Text>
                {graduated.includes(s.id) ? <Text color="green"> ★</Text> : ''}
              </Text>
            ))}
            {graduated.length > 0 ? <Text dimColor>★ kept 3 in a row: a habit now</Text> : null}
          </Box>
          {rules.length > 0 && (
            <Box flexDirection="column">
              <Text bold>You keep repeating these: add them to CLAUDE.md</Text>
              {rules.slice(0, 4).map((r, i) => (
                <Box flexDirection="column">
                  <Text wrap="wrap">
                    “{r.text}” <Text dimColor>· {r.count} prompts</Text>
                  </Text>
                  <Box flexDirection={isNarrow ? 'column' : 'row'} gap={isNarrow ? 0 : 1}>
                    <Button
                      key={`rule-add-${i}`}
                      hotkey={i === 0 ? 'a' : undefined}
                      onPress={() => void $.prompt.fill({ text: claudeMdPrompt(r.text) })}
                    >
                      Ask Claude to add it
                    </Button>
                    <Button key={`rule-dismiss-${i}`} hotkey={i === 0 ? 'd' : undefined} dimColor onPress={() => void dismissRule($, r.text)}>
                      Dismiss
                    </Button>
                  </Box>
                </Box>
              ))}
            </Box>
          )}
          {footer}
        </Box>
      )
    }

    const entries = scope === 'project' && here.length > 0 ? here : all
    const found = selectedId === null ? -1 : entries.findIndex(x => x.id === selectedId)
    const index = found < 0 ? entries.length - 1 : found
    const shown = entries[index] ?? entries[entries.length - 1]!
    const select = (i: number) => {
      const target = entries[i]
      if (target) void update($, SELECTED, () => (i === entries.length - 1 ? null : target.id))
    }
    const missed = Object.entries(shown.habits ?? {}).filter(([, m]) => m === 'missed').map(([id]) => id as HabitId)
    const kept = Object.values(shown.habits ?? {}).filter(m => m === 'shown').length
    const isClear = shown.status === 'done' && (shown.score ?? 0) >= 5 && !shown.better
    const headline = shown.nextStep || shown.feedback?.[0] || ''
    const points = (shown.feedback ?? []).filter(f => f !== headline)
    const quote = oneLine(shown.prompt)
    const quoteMax = isNarrow && !isExpanded ? (width - 2) * 2 : isExpanded ? 4000 : 400
    const elapsed = shown.reviewStartedAt !== undefined ? Math.max(0, now - shown.reviewStartedAt) : 0

    // The trail takes the rows the detail leaves free.
    const room = Math.max(3, rows - (isClear || shown.status !== 'done' ? 16 : 30))
    const start = Math.max(0, Math.min(index - Math.floor(room / 2), entries.length - room))
    const trail = entries.slice(start, start + room)

    const actions = shown.status === 'done' && shown.better ? (
      <Box flexDirection={isNarrow ? 'column' : 'row'} gap={isNarrow ? 0 : 1}>
        <Button key="use" hotkey="u" variant="primary" onPress={() => void useBetter($, shown.better ?? '')}>
          Use it
        </Button>
        <Button key="copy" hotkey="c" onPress={press => void $.ui.copy({ text: shown.better ?? '', surface: press.surface })}>
          Copy
        </Button>
      </Box>
    ) : null

    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {welcome}

        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between">
            <Text dimColor>
              #{index + 1} · {Math.round(shown.durationMs / 1000)}s · {shown.tools.length} call{shown.tools.length === 1 ? '' : 's'}
              {shown.tokens && !isNarrow ? ` · ${formatTokens(shown.tokens)} tok` : ''}
              {shown.interrupted ? ' · interrupted' : ''}
              {scope === 'all' && shown.project && !isNarrow ? ` · ${projectName(shown.project)}` : ''}
            </Text>
            {shown.status === 'done' && shown.score !== undefined ? (
              <Text color={scoreColor(shown.score)} dimColor={shown.score >= 4}>
                {shown.score}/5
              </Text>
            ) : null}
          </Box>
          <Text wrap="wrap">“{quote.length > quoteMax ? `${quote.slice(0, quoteMax - 1)}…` : quote}”</Text>
          {quote.length > quoteMax || isExpanded ? (
            <Button key="expand" hotkey="e" plain dimColor onPress={() => void update($, EXPANDED, x => !x)}>
              {isExpanded ? 'show less' : 'show all'}
            </Button>
          ) : null}
        </Box>

        {shown.status === 'reviewing' ? (
          <Box flexDirection="column">
            <Text dimColor>Reviewing… {Math.round(elapsed / 1000)}s</Text>
            {elapsed > SLOW_MS ? (
              <Box flexDirection="row" gap={1}>
                <Text color="yellow">Taking longer than usual.</Text>
                <Button key="retry" hotkey="v" onPress={() => void review($, shown.id)}>
                  Retry
                </Button>
              </Box>
            ) : null}
          </Box>
        ) : null}
        {shown.status === 'skipped' || shown.status === 'failed' ? (
          <Box flexDirection="column">
            {shown.status === 'skipped' ? (
              <Text dimColor wrap="wrap">
                {isAutoReview ? '· A short follow-up: not reviewed, to save a call.' : 'Automatic review is off.'}
              </Text>
            ) : (
              <Text color="yellow" wrap="wrap">
                {shown.error ?? 'The review failed.'}
              </Text>
            )}
            <Button key="review-it" hotkey="v" onPress={() => void review($, shown.id)}>
              Review it
            </Button>
          </Box>
        ) : null}

        {isClear ? (
          <Text wrap="wrap">
            <Text color="green">✓ Clear prompt.</Text> <Text dimColor>{shown.verdict}</Text>
          </Text>
        ) : null}

        {shown.status === 'done' && !isClear ? (
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="column">
              {headline ? (
                <Text bold wrap="wrap">
                  → {headline}
                </Text>
              ) : null}
              {shown.verdict ? (
                <Text dimColor wrap="wrap">
                  {shown.verdict}
                </Text>
              ) : null}
            </Box>
            {shown.better ? (
              <Box flexDirection="column">
                <Text dimColor>
                  Better prompt <Text color="green">+added</Text> <Text color="yellow">[fill in]</Text>
                </Text>
                <Text wrap="wrap">
                  {diffWords(shown.prompt, shown.better).flatMap(part =>
                    placeholders(part.text).map(run =>
                      run.isPlaceholder ? (
                        <Text color="yellow">{run.text}</Text>
                      ) : part.isAdded ? (
                        <Text color="green">{run.text}</Text>
                      ) : (
                        <Text>{run.text}</Text>
                      ),
                    ),
                  )}
                </Text>
              </Box>
            ) : null}
            {actions}
            {missed.length > 0 || kept > 0 ? (
              <Text wrap="wrap">
                {missed.map(id => (
                  <Text color="yellow">✗ {habitName(id)}{'  '}</Text>
                ))}
                {kept > 0 ? <Text color="green">+{kept} ✓</Text> : ''}
              </Text>
            ) : null}
            {points.length > 0 ? (
              <Box flexDirection="column">
                {points.map(f => (
                  <Text wrap="wrap" dimColor>
                    • {f}
                  </Text>
                ))}
              </Box>
            ) : null}
            {shown.followup ? (
              <Text color="yellow" wrap="wrap">
                ↳ Your next prompt had to correct this: {shown.followup}
              </Text>
            ) : null}
            {shown.tip ? (
              <Text dimColor wrap="wrap">
                Tip: {shown.tip}
              </Text>
            ) : null}
            {(shown.rules ?? []).length > 0 ? (
              <Text dimColor wrap="wrap">
                Standing instructions: {(shown.rules ?? []).map(r => `“${r}”`).join(', ')}
              </Text>
            ) : null}
          </Box>
        ) : null}

        {shown.status === 'done' ? (
          <Box flexDirection="row" gap={1}>
            <Button key="rate-up" hotkey="y" plain dimColor={shown.rating !== 'up'} onPress={() => void rate($, shown.id, 'up')}>
              {shown.rating === 'up' ? '✓ Helpful' : 'Helpful'}
            </Button>
            <Text dimColor>·</Text>
            <Button key="rate-down" hotkey="n" plain dimColor={shown.rating !== 'down'} onPress={() => void rate($, shown.id, 'down')}>
              {shown.rating === 'down' ? '✓ Not helpful' : 'Not helpful'}
            </Button>
          </Box>
        ) : null}

        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text dimColor>Trail ·</Text>
            <Button
              key="scope"
              hotkey="p"
              plain
              dimColor
              onPress={() => void update($, SCOPE, s => (s === 'project' ? ('all' as const) : ('project' as const)))}
            >
              {scope === 'project' && here.length > 0 ? `${projectName(project)} (show all)` : 'all projects (show this one)'}
            </Button>
          </Box>
          {trail.flatMap((x, i) => {
            const n = start + i
            const before = entries[n - 1]
            const isNewSession = x.session !== undefined && before !== undefined && before.session !== x.session
            const time = relTime(now - x.at)
            const textRoom = Math.max(8, width - 6 - time.length)
            const prompt = oneLine(x.prompt)
            const label = prompt.length > textRoom ? `${prompt.slice(0, textRoom - 1)}…` : prompt.padEnd(textRoom)
            const mark =
              x.status === 'reviewing' ? (
                <Text dimColor>… </Text>
              ) : x.status === 'skipped' ? (
                <Text dimColor>·  </Text>
              ) : x.status === 'failed' ? (
                <Text color="yellow">!  </Text>
              ) : (
                <Text color={scoreColor(x.score ?? 0)}>●{x.score ?? '–'} </Text>
              )
            const row = (
              <Button key={`row-${x.id}`} plain dimColor={n !== index} onPress={() => select(n)}>
                {n === index ? '▸' : ' '}
                {mark}
                {label} <Text dimColor>{time}</Text>
              </Button>
            )

            return isNewSession && x.session !== undefined
              ? [<Text dimColor>{`── ${sessionLabel(x.session, now)} ──`}</Text>, row]
              : [row]
          })}
          <Box flexDirection="row" gap={2}>
            {index < entries.length - 1 ? (
              <Button key="newer" hotkey="j" plain dimColor onPress={() => select(index + 1)}>
                newer
              </Button>
            ) : null}
            {index > 0 ? (
              <Button key="older" hotkey="k" plain dimColor onPress={() => select(index - 1)}>
                older
              </Button>
            ) : null}
          </Box>
        </Box>

        {footer}
      </Box>
    )
  })
}
