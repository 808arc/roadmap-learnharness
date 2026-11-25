# Data folder

The plugin keeps its files in the data directory the host gives it (`ctx.dataDirectory`). This page lists what the code on `main` writes, what each file holds, and whether it is safe to commit to Git. The file names come from the modules that write them, mainly `src/store.ts`, `src/plugin-log.ts`, `src/git-safe-data.ts` and the research modules in `src/research/`.

The generated `.gitignore` in this folder (see [Git safety](#git-safety)) decides what a Git plugin such as learnharness-git will commit. The `Git` column below shows the result.

## Roadmap files

Each roadmap is stored in its own file (issue #28).

| Path | Holds | Git |
| --- | --- | --- |
| `roadmaps-index.json` | The roadmap order and the ids of the roadmaps, plus the marker that the one-time migration has run. It sits in the root so no roadmap file can take its name. | Versioned |
| `roadmaps/<stem>.json` | One roadmap. `<stem>` is the lowercase hex SHA-256 of the roadmap id (64 characters). The file stores its own id. | Versioned |
| `learning-paths.json` | The legacy single file. It exists only before the migration has run. | Versioned |
| `learning-paths.json.migrated` | The legacy file, renamed after a verified one-time migration. It is kept, not deleted. If the rename fails, `learning-paths.json` stays in place. | Versioned |

The migration moves each roadmap from `learning-paths.json` into `roadmaps/`, reads every new file back and checks it, and only then renames the legacy file. If any step fails, the new files from that attempt are removed and the legacy file is left as it was.

## Other files

| Path | Holds | Git |
| --- | --- | --- |
| `settings.json` | Versioned plugin settings. The search key is not kept here. | Versioned |
| `sources/<sourceId>.md` | Learner uploads, converted to Markdown. Files are named by UUID, not by the original file name. | Versioned |
| `sources/index.json` | Metadata for each upload, used to skip identical uploads. | Versioned |
| `research/` | One JSON file per research note. Notes are written by research sessions, deep-research runs and diagnostic dossiers, and the Architect reads them back. | Versioned |
| `research-chats.json` | Teaching chats that were opened with a research brief, with their topic and the ids of the notes attached to them. | Versioned |
| `declined-proposals.json` | Ids of chats where the learner chose "not now" on a proposal. | Versioned |
| `secrets/search-key.json` | The learner's optional search API key, as plain text. | Ignored |
| `secrets/.gitignore` | Written by the key store. It contains `*`, which ignores the whole `secrets/` folder. | Ignored |
| `logs/architect-model.jsonl` | The Architect model the learner chose, as one JSON line. It is needed to register the Architect again after a restart. An older `architect-model.json` (or `architect.json`) is copied here once, on first open, and is kept. | Ignored |
| `logs/architect-runs.jsonl` | Local timing log for the Architect: one JSON object per line, with step names, durations, counts, ids, and provider and model names. It never holds the learner's goal, statements, source text or model output. The file is trimmed to its newest half once it passes 512 KB. | Ignored |
| `*.tmp` | Leftovers of an interrupted atomic write. | Ignored |
| `.gitignore` | Written by the plugin on start. See [Git safety](#git-safety). | Versioned |

The plugin never reads or writes the host's own entries: `agents/`, `tasks/` and `usage.jsonl`.

Activation never reads another plugin's data folder. Data from the Learning Paths plugin or from an earlier plugin id is not imported, so nothing is copied into this folder from elsewhere. Older installs may still contain `imported-from-*.json` marker files from earlier versions. Nothing reads them, and they are safe to delete.

## Git safety

On start, the plugin calls `ensureDataGitignore` in `src/git-safe-data.ts`. It makes sure `<data>/.gitignore` contains these entries:

```gitignore
secrets/
logs/
*.tmp
```

The function only adds missing lines. Lines the learner wrote are kept, and a file that already has every entry is not rewritten. A failed write is reported as a warning and the plugin keeps running without it.

The Git plugin then commits everything else in the folder. Removing the `secrets/` or `logs/` entries would put the API key or the timing log into that history.
