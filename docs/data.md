# Data folder

The plugin keeps its files in the data directory the host gives it (`ctx.dataDirectory`). This page lists what is there on `main`, what each file holds, and whether it is safe to commit to Git.

The generated `.gitignore` in this folder (see [Git safety](#git-safety)) decides what a Git plugin such as learnharness-git will commit. The `Git` column below shows the result.

## Files and folders

| Path | Holds | Git |
| --- | --- | --- |
| `learning-paths.json` | Versioned roadmap records: the learning paths and their nodes. | Versioned |
| `settings.json` | Versioned plugin settings. The search key is not kept here. | Versioned |
| `architect.json` | The Architect model the learner chose. It is needed to register the Architect again after a restart. | Versioned |
| `sources/<sourceId>.md` | Learner uploads, converted to Markdown. Files are named by UUID, not by the original file name. | Versioned |
| `sources/index.json` | Metadata for each upload, used to skip identical uploads. | Versioned |
| `research/` | One JSON file per research note. Notes are written by research sessions and deep-research runs, and the Architect reads them back. | Versioned |
| `research-chats.json` | Teaching chats that were opened with a research brief, with their topic and the ids of the notes attached to them. | Versioned |
| `declined-proposals.json` | Ids of chats where the learner chose "not now" on a proposal. | Versioned |
| `secrets/search-key.json` | The learner's optional search API key, as plain text. | Ignored |
| `secrets/.gitignore` | Written by the key store. It contains `*`, which ignores the whole `secrets/` folder. | Ignored |
| `logs/architect.jsonl` | Local timing log for the Architect: one JSON object per line, with step names, durations, counts, ids, and provider and model names. It never holds the learner's goal, statements, source text or model output. The file is trimmed to its newest half once it passes 512 KB. | Ignored |
| `*.tmp` | Leftovers of an interrupted atomic write. | Ignored |
| `.gitignore` | Written by the plugin on start. See [Git safety](#git-safety). | Versioned |

The plugin never reads or writes the host's own entries: `agents/`, `tasks/` and `usage.jsonl`.

## Git safety

On start, the plugin calls `ensureDataGitignore` in `src/git-safe-data.ts`. It makes sure `<data>/.gitignore` contains these entries:

```gitignore
secrets/
logs/
*.tmp
```

The function only adds missing lines. Lines the learner wrote are kept, and a file that already has every entry is not rewritten. A failed write is reported as a warning and the plugin keeps running without it.

The Git plugin then commits everything else in the folder. Removing the `secrets/` or `logs/` entries would put the API key or the timing log into that history.

## Planned: one file per roadmap

Issue #28 will split `learning-paths.json` into one file per roadmap under `roadmaps/`, with an index file that lists them. This is in progress and is not on `main` yet. Until `src/store.ts` on `main` shows the new layout, the single `learning-paths.json` file above is the one that exists.
