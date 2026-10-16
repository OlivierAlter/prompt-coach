# Prompt coach roadmap

The coach has two jobs:

1. **Habits.** You pick up the habits that make Claude Code work well, and keep them.
2. **Results.** Each prompt gets a better result, ideally before you send it.

Each item below serves one or both, and the cost of each is noted: one model
call per answered turn is the budget, and nothing may add to it without
paying for itself.

**Status:** v0.2 to v0.4 shipped in 0.4.0; v0.5 in 0.5.0; v0.6 in 0.6.0.

## v0.2: accurate, cheaper reviews

| # | Item | Serves | Cost |
|---|---|---|---|
| R1 | Skip trivial follow-ups ("yes", "go on") without a model call; a **Review it** button reviews one anyway | both | −30–50% calls |
| R2 | Show the coach the previous exchange (the earlier prompts and the end of the last answer), and cut long answers in the middle, not at the end | results | ≈ |
| R3 | Show the coach what Claude did, with arguments (`Grep: login`, `Read: src/auth.ts`), so its advice can name the file you should have named | results | + a few hundred tokens |
| R4 | Score examples in the system prompt: steadier scores, and a prompt long enough to be cached | both | ↓ |

## v0.3: habits

| # | Item | Serves | Cost |
|---|---|---|---|
| H1 | Seven named habits (target, goal, evidence, verify, constraints, scope, plan). Each review marks which ones the prompt showed or missed. | habits | ≈ |
| H2 | A **Habits** view: each habit's hit rate over your recent prompts, its trend, and the one habit to focus on | habits | none |
| H3 | A line above the prompt: your focus habit and average score, so it is in view while you type | habits | none |
| H4 | The coach is told your focus habit, so it says when you got it right this time | habits | ≈ |

## v0.4: better results per prompt

| # | Item | Serves | Cost |
|---|---|---|---|
| P1 | **Improve draft**: rewrite what is in the prompt box before you send it, from the conversation and your weak habits, with Undo. Missing facts become `[placeholders]`, never inventions. | results | one call per press |
| P2 | Interrupted turns are reviewed, and when your next prompt corrects the last one, the earlier entry says so | both | ≈ |
| P3 | Settings: the coach's model, and automatic review on or off | cost | none |

## v0.5: closing the loop

| # | Item | Serves | Cost |
|---|---|---|---|
| L1 | **CLAUDE.md suggestions.** The coach notes standing instructions ("use pnpm, not npm"), reusing the wording of ones it has seen. Once one appears in two prompts, a toast says so, and the Habits view offers **Ask Claude to add it** (fills the prompt box) or **Dismiss**. | habits | ≈ |
| L2 | **Per-project history.** Each entry carries its project; the trail shows this project, `p` toggles all. Habits stay personal, across projects. | both | none |
| L3 | **Tokens per turn** beside each entry, given to the coach as evidence; the Habits view says how many fewer tokens your turns used when you kept the focus habit. | both | none |
| L4 | **Rate a review** Helpful / Not helpful (`y` / `n`); the coach sees your last six ratings and leans toward what helped. | both | + ~100 tokens |
| L5 | **Reviews survive a reload.** A hot reload dropped the review in flight and left "Reviewing…" for good; the mod now re-runs the 3 most recent on start. | both | ≤ 3 calls per reload |

## v0.6: sidebar and UX

| # | Item | Serves |
|---|---|---|
| U1 | **Use it** over a draft offers Undo in the line above the prompt | results |
| U2 | `j` = newer (down), `k` = older (up), as every terminal user expects | — |
| U3 | A footer names the keys when the sidebar has focus, and says `ctrl+x tab` when it does not | — |
| U4 | The review leads with the action: next step, then the better prompt and **Use it**; the reasons after | results |
| U5 | One headline (`→ next step`) instead of a grade; the score small, low scores yellow, red kept for nothing | habits |
| U6 | Only missed habits are listed (`✗ … +2 ✓`) | habits |
| U7 | The better prompt is a diff of your prompt: added words green, `[placeholders]` yellow | habits |
| U8 | Tabs look like tabs (active bold underlined), with a badge on Habits for a focus or a CLAUDE.md suggestion | — |
| U9 | Trail rows: colored `●score`, relative age, and a separator between sessions | — |
| U10 | A clear prompt (5/5, no rewrite) collapses to one line | — |
| U11 | **Draft check as you type**, no model call: no file named, no error pasted, no way to check, big change without a plan | results |
| U12 | The line above the prompt: **Improve draft** only when the box has text, **Open** only when the sidebar is closed, ✕ hides it for the session | — |
| U13 | `Reviewing… 8s`; past 30s, **Retry**, and a late reply never overwrites the retry's | — |
| U14 | Below 45 columns: the quote cut to two lines (`e` expands), buttons stacked, token count dropped | — |
| U15 | **Streaks**: keep the focus habit 3 prompts in a row and it graduates (★, toast, next focus); it returns if it slips below half | habits |
| U16 | A first-run welcome card: what the coach does, its cost, three keys | — |

## Later

- A weekly recap: the habit you improved most, and the one to work on next.
- Compare the coach's rewrite with what you actually sent next, to learn which suggestions you adopt.
- Check in the Claude desktop app's pane.
