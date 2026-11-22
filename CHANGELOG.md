# Changelog

## 0.5.2

- Every roadmap node opens as a chat (**Open**): latest linked chat, or a new Lesson.
- The Architect's graph brief no longer appears in your chat; it reads the graph through `read_learner_graph`.
- Nodes match the learner's Knowledge Graph by title. The roadmap.sh catalog link and its code are removed.
- Nodes carry real prerequisites written by the Architect; graph and tree show branches.
- The List view is removed; a saved "list" falls back to Tree.
- New installs default the Architect to the cheapest model.
- The Architect log records why a model call stopped (user stop, provider error, timeout).
- Removed unused analytics modules and dead code.

## 0.5.1

- Plugin sync: installs and restarts LearnHarness (`./plugin-sync.sh --force --restart`).
- Release workflow checks the tag against the version.

## 0.5.0

- Graph-based roadmaps from the learner's Knowledge Graph and the nilbuild topic files.
- One file per roadmap, with a verified one-time migration from the old single file.
- Rederive and Question Patterns integration rules; Flashcard seed hands off to graph facts.
