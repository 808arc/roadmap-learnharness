# Integrations

The roadmap works alongside four related plugins. Each section says what is built on `main` and what is still planned.

## Shared rules

- The roadmap only uses what LearnHarness shares with every plugin: native sessions, the Knowledge Graph, and the session tools and instructions.
- It never reads another plugin's data folder.
- It works the same when the other plugin is not installed. Nothing breaks, and nothing is missing from the roadmap's own features.
- No code is copied from these plugins. Where the roadmap follows an idea from another plugin, the section below names the author and the license.

## Activity heatmap (built)

Plugin id `activity-heatmap`, by Huskhd, MIT. Repository: https://github.com/Huskhd/learnharness-activity-heatmap

The roadmap uses the same study-day rule as the heatmap, so the two agree on which days count. The rule is implemented in `src/follow-through.ts` (issue #24):

- Each learner action (a message, an answered question, or a practice submission) is dated by its own timestamp.
- A day is a local calendar day, taken from the machine's time zone.
- A day is a study day when it holds at least one action. A session that crosses midnight counts on both days.

When the exact action times are not available, the roadmap falls back to the session's `createdAt` and `updatedAt`. That fallback is an approximation.

## Git (built)

Plugin id `learnharness-git`, by Giuliano Testa, AGPL-3.0. Repository: https://github.com/heohlee/learnharness-git

The Git plugin versions the learning data folder. The roadmap writes a `.gitignore` into that folder on start, so the API key in `secrets/`, the timing log in `logs/`, and temporary `*.tmp` files stay out of the history. The file is written by `src/git-safe-data.ts` (issue #27), and the roadmap writes it even when the Git plugin is not installed. The full list of files and what is committed is in [data.md](data.md).

## Rederive (planned)

Plugin id `rederive-lh`, by Jayden Husein, AGPL-3.0. Repository: https://github.com/jayden-husein/rederive-lh

This is planned, not built. It is an open evaluation epic, issue #30. Nothing in the roadmap depends on it yet, and this page does not describe its behaviour.

## Question Patterns (built)

By sevenRevy, AGPL-3.0. Repository: https://github.com/sevenRevy/question-patterns

The roadmap follows the same idea in two places (issue #35):

- The node panel shows one hint line per node type and session kind, from `src/pattern-hint.ts`. For example, a concept's lesson suggests an explain-back and its practice suggests recall. The hint names the kind of template that tends to fit. The roadmap never picks a template.
- Session prompts in `src/framework.ts` no longer fix a question format. The format is set by the learner or by an installed session plugin. The prompt only gives a default for when no format is set.
