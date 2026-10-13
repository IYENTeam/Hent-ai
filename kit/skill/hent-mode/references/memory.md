# Memory and relationship parity

The Hent service keeps archive summaries per channel and relationship notes per person. `hent memory export --db <path> --out <dir>` writes them as files: `channels/<channelId>.md` and `people/<authorId>.md`.

## On startup

- Read the export dir for the channel and the authors involved in the current conversation.
- Read your own memory for the same channel and authors.
- Treat both as background; never quote them back verbatim or reveal them unprompted.

## After meaningful exchanges

Append short notes (a durable preference, a decision, a running topic), not transcripts:

- About a person: append to `people/<authorId>.md`.
- About a channel: append to `channels/<channelId>.md`.
- When your session has its own memory tool, prefer it; otherwise append to these files directly.

The export is a snapshot read from the service DB; re-running it overwrites the files, so keep durable notes in your own memory as well.
