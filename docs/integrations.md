# Integrations

The roadmap works alongside four related plugins. Each section says what is built on `main` and what is still planned.

## Shared rules

- The roadmap only uses what LearnHarness shares with every plugin: native sessions, the Knowledge Graph, and the session tools and instructions.
- It never reads another plugin's data folder.
- It works the same when the other plugin is not installed.
- No code is copied from these plugins. The links below point to the authors' own repositories, not to vendored code. Each section names the author and the licence.
- The licences were read from each repository's licence metadata on GitHub.

## Activity heatmap (built)

Plugin id `activity-heatmap`, by Huskhd, MIT. Repository: https://github.com/Huskhd/learnharness-activity-heatmap

The roadmap counts study days with a rule taken from the heatmap's approach. The rule is implemented in `src/follow-through.ts` (issue #24):

- Each learner action (a message, an answered question, or a practice submission) is dated by its own timestamp.
- A day is a local calendar day, taken from the machine's time zone.
- A day is a study day when it holds at least one action. A session that crosses midnight counts on both days.

When the exact action times are not available, the roadmap falls back to the session's `createdAt` and `updatedAt`, which is an approximation.

## Git (built)

Plugin id `learnharness-git`, by Giuliano Testa, AGPL-3.0. Repository: https://github.com/heohlee/learnharness-git

The Git plugin versions the learning data folder. The roadmap writes a `.gitignore` into that folder on start, with the entries `secrets/`, `logs/` and `*.tmp`, so the API key, the timing log and temporary files stay out of the history. The code is in `src/git-safe-data.ts` (issue #27), and the file is written even when the Git plugin is not installed. The full list of files is in [data.md](data.md).

## Rederive (planned)

Plugin id `rederive-lh`, by Jayden Husein, AGPL-3.0. Repository: https://github.com/jayden-husein/rederive-lh

This is planned, not built. It is an open evaluation epic, issue #30.

## Question Patterns (built)

By sevenRevy, AGPL-3.0. Repository: https://github.com/sevenRevy/question-patterns

The roadmap uses the idea in two places (issue #35):

- The node panel shows one hint line per node type and session kind, from `src/pattern-hint.ts`. The hint names the kind of template that tends to fit. The roadmap does not choose a template.
- Session prompts in `src/framework.ts` no longer fix a question format. When no format is set, the prompt gives only a default way in.
