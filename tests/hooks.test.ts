import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

const SITE = { scroll: { offset: 0, bodyRows: 40 }, view: {} } as const
const PANE = {
  component: 'Pane',
  requestId: 'prompt-coach',
  props: { title: 'Prompt coach', isFocused: true, bodyColumns: 60, placement: 'dock', ...SITE },
} as const
const NARROW_PANE = { ...PANE, props: { ...PANE.props, bodyColumns: 36 } } as const
const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100, ...SITE },
} as const
const USAGE = { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const review = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    score: 2,
    verdict: 'Vague: no file or error named',
    next_step: 'Name the file and paste the error',
    feedback: ['Claude had to search 3 files to find the bug'],
    better: 'Fix the null check in src/login.ts:42 that crashes when email is empty, then run npm test [paste error]',
    tip: 'Use @src/login.ts to point Claude at the file',
    habits: { target: 'missed', verify: 'missed', goal: 'shown' },
    previous_unclear: '',
    ...over,
  })

type Ui = {
  find: (q: { key?: string; text?: RegExp; type?: string }) => Promise<unknown>
  redraw: () => Promise<void>
}

// Stands for the engine: answers every event the mod uses, and records the
// coach's calls. `replies` are the review replies, in order.
function world(on: On, replies: string[], answer?: (call: number) => Promise<string>) {
  const w = { asked: [] as string[], filled: [] as string[], toasts: [] as string[], box: '', clock: mock.clock(on) }
  mock.store(on)
  on('model.complete', async (_$, e) => {
    const system = e.systemBlocks?.[0]?.text ?? e.system ?? ''
    w.asked.push(e.prompt)
    const text = system.startsWith('You rewrite')
      ? 'Improved: fix src/a.ts, then run npm test'
      : answer
        ? await answer(w.asked.length)
        : (replies.shift() ?? review())

    return { value: { isAnswered: true as const, text, usage: USAGE } }
  })
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  on('prompt.change', async (_$, e) => ({ text: e.text }))
  on('tool.call', async () => ({ result: 'ok' }) as never)
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('ui.toast', async (_$, e) => {
    w.toasts.push(JSON.stringify(e))

    return { value: undefined }
  })
  on('session.cwd', async () => ({ value: '/work/app' }))
  on('prompt.read', async () => ({ value: { text: w.box, cursor: w.box.length } }))
  on('prompt.fill', async (_$, e) => {
    w.filled.push(e.text)
    w.box = e.text

    return { isFilled: true } as never
  })

  return w
}

let turns = 0
async function turn($: Engine, prompt: string, answer = 'Done.') {
  await $.prompt.submit({ text: prompt, origin: { kind: 'composer' } } as never)
  await $.tool.call({ tool: 'Grep', pattern: 'login', tool_use_id: `g${turns}` } as never)
  await $.turn.complete({ turnId: `t${turns++}`, answer, durationMs: 42_000, isAborted: false, reason: 'answer' })
}

// Types into the box, as the person would.
async function type($: Engine, w: { box: string }, text: string) {
  w.box = text
  // The engine raises prompt.change on each edit; the test kit's noun is untyped.
  const prompt = $.prompt as unknown as { change: (e: unknown) => Promise<unknown> }
  await prompt.change({ text, cursor: text.length, origin: { kind: 'app' } })
}

async function until(ui: Ui, check: () => Promise<unknown> | unknown) {
  for (let i = 0; i < 80 && !(await check()); i++) await ui.redraw()
}
const settle = (ui: Ui, key: string) => until(ui, () => ui.find({ key }))
const text = (ui: Ui, re: RegExp) => ui.find({ type: 'Text', text: re })

test('a review leads with the next step, shows the rewrite as a diff, and lists missed habits', async ($, on) => {
  const w = world(on, [])
  await turn($, 'fix the login bug')

  const ui = await $.ui.mount({ plugin: 'prompt-coach', surface: 'terminal', ...PANE })
  await settle(ui, 'use')
  expect(w.asked[0]).toContain('fix the login bug')
  expect(w.asked[0]).toContain('Grep: login')
  expect(await text(ui, /→ Name the file and paste the error/)).toBeDefined()
  // Words the rewrite added are their own run; the placeholder is marked.
  expect(await text(ui, /^null check in src\/login\.ts:42/)).toBeDefined()
  expect(await text(ui, /^\[paste error\]$/)).toBeDefined()
  expect(await text(ui, /✗ Point at the code/)).toBeDefined()
  expect(await text(ui, /\+1 ✓/)).toBeDefined()
  expect(await text(ui, /✓ Say what done/)).toBeUndefined()
  expect(await text(ui, /^2\/5$/)).toBeDefined()
  await ui.unmount()
})

test('Use it on an empty box just fills it; over a draft it offers Undo', async ($, on) => {
  const w = world(on, [])
  await turn($, 'fix the login bug')
  const ui = await $.ui.mount({ plugin: 'prompt-coach', surface: 'terminal', ...PANE })
  await settle(ui, 'use')

  await ui.press({ key: 'use' })
  expect(w.box).toContain('src/login.ts:42')
  const band = await $.ui.mount({ plugin: 'prompt-coach', surface: 'terminal', ...BAND })
  expect(await band.find({ key: 'undo-draft' })).toBeUndefined()

  w.box = 'my half-written thought'
  await ui.press({ key: 'use' })
  await band.redraw()
  expect(await text(band, /replaced your draft/)).toBeDefined()
  await band.press({ key: 'undo-draft' })
  expect(w.box).toBe('my half-written thought')
  await band.unmount()
  await ui.unmount()
})

test('j moves to the newer prompt and k to the older one', async ($, on) => {
  world(on, [review({ verdict: 'first one' }), review({ verdict: 'second one' })])
  await turn($, 'fix the login bug')
  const ui = await $.ui.mount({ plugin: 'prompt-coach', surface: 'terminal', ...PANE })
  await settle(ui, 'use')
  await turn($, 'fix the signup bug')
  await until(ui, () => text(ui, /signup bug”/))
  await until(ui, () => ui.find({ key: 'use' }))

  expect(await ui.find({ key: 'newer' })).toBeUndefined()
  await ui.press({ key: 'older' })
  expect(await text(ui, /login bug”/)).toBeDefined()
  await ui.press({ key: 'newer' })
  expect(await text(ui, /signup bug”/)).toBeDefined()
  await ui.unmount()
})

test('the footer names the keys when the sidebar has focus, and how to focus it when not', async ($, on) => {
  world(on, [])
  await turn($, 'fix the login bug')
  const focused = await $.ui.mount({ plugin: 'prompt-coach', surface: 'terminal', ...PANE })
  await settle(focused, 'use')
  expect(await text(focused, /u use · c copy · j\/k move/)).toBeDefined()
  await focused.unmount()

  const unfocused = await $.ui.mount({
    plugin: 'prompt-coach',
    surface: 'terminal',
    ...PANE,
    props: { ...PANE.props, isFocused: false },
  })
  expect(await text(unfocused, /ctrl\+x tab to use keys/)).toBeDefined()
  await unfocused.unmount()
})

test('the welcome card shows once and Got it puts it away', async ($, on) => {
  world(on, [])
  const ui = await $.ui.mount({ plugin: 'prompt-coach', surface: 'terminal', ...PANE })
  expect(await text(ui, /Welcome to Prompt coach/)).toBeDefined()
  await ui.press({ key: 'welcome-ok' })
  expect(await text(ui, /Welcome to Prompt coach/)).toBeUndefined()
  await ui.unmount()
})

test('a trivial follow-up costs no call until Review it is pressed', async ($, on) => {
  const w = world(on, [])
  await $.prompt.submit({ text: 'yes', origin: { kind: 'composer' } } as never)
  await $.turn.complete({ turnId: 'ty', answer: 'Done.', durationMs: 1000, isAborted: false, reason: 'answer' })
  expect(w.asked).toHaveLength(0)

  const ui = await $.ui.mount({ plugin: 'prompt-coach', surface: 'terminal', ...PANE })
  expect(await text(ui, /not reviewed/)).toBeDefined()
  await ui.press({ key: 'review-it' })
  await settle(ui, 'use')
  expect(w.asked).toHaveLength(1)
  await ui.unmount()
})

test('a clear prompt collapses to one line', async ($, on) => {
  world(on, [review({ score: 5, better: '', next_step: '', verdict: 'Named the file and the check' })])
  await turn($, 'add a --json flag to cli/export.ts and run npm test')
  const ui = await $.ui.mount({ plugin: 'prompt-coach', surface: 'terminal', ...PANE })
  await until(ui, () => text(ui, /✓ Clear prompt/))
  expect(await text(ui, /Named the file and the check/)).toBeDefined()
  expect(await ui.find({ key: 'use' })).toBeUndefined()
  await ui.unmount()
})

test('a slow review shows its time and offers Retry, and the retry answers it', async ($, on) => {
  let release: () => void = () => undefined
  const w = world(on, [], async call => {
    if (call === 1) await new Promise<void>(r => (release = r))

    return review({ verdict: `attempt ${call}` })
  })
  await turn($, 'fix the login bug')
  const ui = await $.ui.mount({ plugin: 'prompt-coach', surface: 'terminal', ...PANE })
  expect(await text(ui, /Reviewing… 0s/)).toBeDefined()
  expect(await ui.find({ key: 'retry' })).toBeUndefined()

  await w.clock.advance(31_000)
  await ui.redraw()
  expect(await text(ui, /Reviewing… 31s/)).toBeDefined()
  await ui.press({ key: 'retry' })
  await settle(ui, 'use')
  // The first call's late reply must not overwrite the retry's.
  release()
  await ui.redraw()
  expect(await text(ui, /attempt 2/)).toBeDefined()
  await ui.unmount()
})

test('a correcting prompt marks the prompt it corrected', async ($, on) => {
  world(on, [review(), review({ score: 4, previous_unclear: 'Say it is the signup form, not login' })])
  await turn($, 'fix the form validation')
  const ui = await $.ui.mount({ plugin: 'prompt-coach', surface: 'terminal', ...PANE })
  await settle(ui, 'use')
  await turn($, 'no, I meant the signup form')
  await until(ui, () => ui.find({ key: 'older' }))
  await until(ui, () => text(ui, /^4\/5$/))
  await ui.press({ key: 'older' })
  await until(ui, () => text(ui, /had to correct/))
  expect(await text(ui, /signup form, not login/)).toBeDefined()
  await ui.unmount()
})

test('the habits view names the focus and its streak, and the band shows it', async ($, on) => {
  world(on, [])
  // What the engine draws when the coach steps aside.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Box } = $.ui.resolve(e)

    return h(Box, {}) as RenderElement
  })
  const pane = await $.ui.mount({ plugin: 'prompt-coach', surface: 'terminal', ...PANE })
  for (const p of ['fix the login bug', 'fix the signup bug', 'fix the logout bug']) {
    await turn($, p)
    await until(pane, async () => !(await text(pane, /Reviewing/)))
  }
  await pane.press({ key: 'view-habits' })
  await until(pane, () => text(pane, /Focus:/))
  expect(await text(pane, /Focus: Point at the code/)).toBeDefined()
  expect(await text(pane, /in a row to make it a habit/)).toBeDefined()
  await pane.unmount()

  const band = await $.ui.mount({ plugin: 'prompt-coach', surface: 'terminal', ...BAND })
  expect(await text(band, /Point at the code/)).toBeDefined()
  expect(await band.find({ key: 'improve-draft' })).toBeUndefined()
  await band.press({ key: 'hide-band' })
  expect(await text(band, /Point at the code/)).toBeUndefined()
  await band.unmount()
})

test('keeping the focus habit three times in a row graduates it', async ($, on) => {
  const missed = review({ habits: { verify: 'missed' } })
  const kept = review({ habits: { verify: 'shown' } })
  const w = world(on, [missed, missed, missed, kept, kept, kept])
  const pane = await $.ui.mount({ plugin: 'prompt-coach', surface: 'terminal', ...PANE })
  for (const p of ['add a', 'add b', 'add c', 'add d', 'add e', 'add f']) {
    await turn($, `${p} to the export command`)
    await until(pane, async () => !(await text(pane, /Reviewing/)))
  }
  expect(w.toasts.join()).toContain('is a habit now')
  await pane.press({ key: 'view-habits' })
  expect(await text(pane, /★/)).toBeDefined()
  await pane.unmount()
})

test('a draft is checked as it is typed, with no model call', async ($, on) => {
  const w = world(on, [])
  await turn($, 'fix the login bug')
  const band = await $.ui.mount({ plugin: 'prompt-coach', surface: 'terminal', ...BAND })
  const calls = w.asked.length

  await type($, w, 'the checkout is broken please fix it')
  await band.redraw()
  expect(await text(band, /no error pasted · no file named/)).toBeDefined()
  expect(await band.find({ key: 'improve-draft' })).toBeDefined()

  await type($, w, 'Fix the crash in @src/checkout.ts (error below), then run npm test. Error: TypeError x is undefined')
  await band.redraw()
  expect(await text(band, /Draft looks clear/)).toBeDefined()
  expect(w.asked.length).toBe(calls)
  await band.unmount()
})

test('Improve draft rewrites the box from the conversation, and Undo puts the draft back', async ($, on) => {
  const w = world(on, [])
  await turn($, 'fix the login bug', 'Fixed. The crash came from src/a.ts.')
  const band = await $.ui.mount({ plugin: 'prompt-coach', surface: 'terminal', ...BAND })
  await type($, w, 'now add a test for it')
  await band.redraw()
  await band.press({ key: 'improve-draft' })
  await settle(band, 'undo-draft')
  const asked = w.asked.find(p => p.includes('<draft>')) ?? ''
  expect(asked).toContain('now add a test for it')
  expect(asked).toContain('src/a.ts')
  expect(w.box).toBe('Improved: fix src/a.ts, then run npm test')
  await band.press({ key: 'undo-draft' })
  expect(w.box).toBe('now add a test for it')
  await band.unmount()
})

test('Improve draft with an empty box says what to do and calls no model', async ($, on) => {
  const w = world(on, [])
  await turn($, 'fix the login bug')
  const pane = await $.ui.mount({ plugin: 'prompt-coach', surface: 'terminal', ...PANE })
  await settle(pane, 'use')
  await pane.press({ key: 'improve' })
  const band = await $.ui.mount({ plugin: 'prompt-coach', surface: 'terminal', ...BAND })
  expect(await text(band, /Type a prompt in the box first/)).toBeDefined()
  expect(w.asked.filter(p => p.includes('<draft>'))).toHaveLength(0)
  await band.press({ key: 'dismiss-draft' })
  await band.unmount()
  await pane.unmount()
})

test('a narrow sidebar shortens the quote and expands it on e', async ($, on) => {
  world(on, [])
  await turn($, `fix the login bug ${'with a very long explanation '.repeat(8)}`)
  const ui = await $.ui.mount({ plugin: 'prompt-coach', surface: 'terminal', ...NARROW_PANE })
  await settle(ui, 'use')
  expect(await text(ui, /…”$/)).toBeDefined()
  await ui.press({ key: 'expand' })
  expect(await text(ui, /…”$/)).toBeUndefined()
  await ui.unmount()
})

test('a turn shows its tokens, and a rating reaches the next review', async ($, on) => {
  const w = world(on, [review({ verdict: 'Too generic to act on' }), review()])
  await $.prompt.submit({ text: 'fix the login bug', origin: { kind: 'composer' } } as never)
  await $.turn.complete({
    turnId: 'tu',
    answer: 'Done.',
    durationMs: 9000,
    isAborted: false,
    reason: 'answer',
    usage: { ...USAGE, input_tokens: 40_000, output_tokens: 8_000, model: 'claude-opus-5-5' },
  })
  const ui = await $.ui.mount({ plugin: 'prompt-coach', surface: 'terminal', ...PANE })
  await settle(ui, 'rate-down')
  expect(await text(ui, /48k tok/)).toBeDefined()
  await ui.press({ key: 'rate-down' })

  await turn($, 'fix the signup bug')
  await until(ui, () => w.asked.length >= 2)
  expect(w.asked.at(-1)).toContain('unhelpful: Too generic to act on')
  await until(ui, async () => !(await text(ui, /Reviewing/)))
  await ui.unmount()
})

test('an instruction repeated in two prompts is offered for CLAUDE.md', async ($, on) => {
  const both = review({ standing_instructions: ['Use pnpm, not npm', 'Style with Tailwind only'] })
  const w = world(on, [both, both])
  await turn($, 'add zod, use pnpm not npm')
  const pane = await $.ui.mount({ plugin: 'prompt-coach', surface: 'terminal', ...PANE })
  await settle(pane, 'use')
  await turn($, 'add vitest with pnpm please')
  await until(pane, () => w.asked.length >= 2)
  expect(w.asked.at(-1)).toContain('- Use pnpm, not npm')

  await pane.press({ key: 'view-habits' })
  await settle(pane, 'rule-add-0')
  expect(await text(pane, /^Habits$/)).toBeDefined()
  await pane.press({ key: 'rule-add-0' })
  expect(w.filled.at(-1)).toContain('CLAUDE.md')
  expect(w.toasts.join()).toContain('Use pnpm, not npm')
  await pane.press({ key: 'rule-dismiss-0' })
  expect(await text(pane, /Use pnpm/)).toBeUndefined()
  expect(await text(pane, /Tailwind only/)).toBeDefined()
  await pane.unmount()
})

test('a review cut off by a reload runs again when the module starts over', async ($, on) => {
  let release: (v: unknown) => void = () => undefined
  const w = world(on, [], async call => {
    // The first call never answers: the module that made it is gone.
    if (call === 1) await new Promise(r => (release = r))

    return review()
  })
  on('command.register', async () => ({ value: undefined }) as never)
  on('ui.open', async () => ({ value: { isPlaced: false } }) as never)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }) as never)

  await turn($, 'fix the login bug')
  const ui = await $.ui.mount({ plugin: 'prompt-coach', surface: 'terminal', ...PANE })
  expect(await text(ui, /Reviewing…/)).toBeDefined()

  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: false } as never)
  await settle(ui, 'use')
  expect(w.asked).toHaveLength(2)
  expect(await text(ui, /Reviewing…/)).toBeUndefined()
  release(undefined)
  await ui.unmount()
})

test('the sidebar and the band draw on the desktop surface too', async ($, on) => {
  const w = world(on, [])
  await turn($, 'fix the login bug')
  const pane = await $.ui.mount({ plugin: 'prompt-coach', surface: 'desktop', ...PANE })
  await settle(pane, 'use')
  expect(await pane.find({ key: 'rate-up' })).toBeDefined()
  await pane.press({ key: 'view-habits' })
  await pane.unmount()
  await type($, w, 'the checkout is broken please fix it')
  const band = await $.ui.mount({ plugin: 'prompt-coach', surface: 'desktop', ...BAND })
  expect(await band.find({ key: 'improve-draft' })).toBeDefined()
  await band.unmount()
})
