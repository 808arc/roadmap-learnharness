# Integrations

The roadmap works alongside four related plugins. Each section says what is built on `main` and what is still planned.

## Shared rules

- The roadmap only uses what LearnHarness shares with every plugin: native sessions, the Knowledge Graph, and the session tools and instructions.
- It never reads another plugin's data folder, except in two one-time imports. They read the data folders of the earlier plugin ids `learning-path` (Learning Paths) and `roadmap` (this fork's previous id), copy what they find into this folder, and run once. See [data.md](data.md#import-markers).
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

## Rederive (partly built)

Plugin id `rederive-lh`, by Jayden Husein, AGPL-3.0. Repository: https://github.com/jayden-husein/rederive-lh

Built on `main` (issue #33, merged in 1757172): when a Rederive problem is active in a native teaching session, the roadmap text gives way to it. Three sentences in `src/framework.ts` do this:

- `REDERIVE_DEFERRAL` says Rederive's flow comes first while one of its problems is active: it decides who poses the next question, the question form and when the problem ends. The roadmap does not pose its own check or show a worked solution in its place.
- `REDERIVE_PROGRESS_SENTENCE` keeps the roadmap's progress and error logging at the end of the session, because Rederive's log tools do not replace it.
- `ROADMAP_SAFETY_SENTENCE` keeps the roadmap's rules alongside Rederive: no answers given away, no roadmap grades, errors logged by root cause, and no restructuring of the path.

`tests/rederive-coexist.test.ts` checks the instruction text for these sentences. It runs no session and calls no model.

Issue #32 is also merged on main (commit 7bec5b1, merged in 2d54f5d): a code-understanding node can name a code repository for its Lesson brief. `REDERIVE_DEFERRAL` covers the case of a Rederive problem about the learner's own repo, which stays on the node's topic.

Issue #30 stays open as the epic for what is not yet built.

## Question Patterns (built)

Plugin id `question-patterns`, by sevenRevy, AGPL-3.0. Repository: https://github.com/sevenRevy/question-patterns

The roadmap uses the idea in two places (issue #35):

- The node panel shows one hint line for each node, from `src/pattern-hint.ts`. It is the practice hint for the node's type, or the lesson hint when there is none. The hint names the kind of template that tends to fit. The roadmap does not choose a template. The panel shows the line unless the learner turns off "Show question-template tips" in settings.
- Session prompts in `src/framework.ts` no longer fix a question format. When no format is set, the prompt gives only a default way in.
