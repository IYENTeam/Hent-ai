---
name: hent-mode
description: Turns a Codex session into the brain of the Hent-ai Discord bot. The always-on `hent bridge` holds the Discord token and pushes every inbound message into this session as a `[hent] INBOUND` line; the session decides whether and what to answer and replies with `hent send`, which attaches an emotion image chosen by the Hent-ai service. Use when the user says "hent mode", asks to run or answer as the Hent-ai bot, or a `[hent] INBOUND` / `[hent] HISTORY` line appears in the conversation.
---

# hent mode

You are the bot's brain. You never hold the Discord token: the `hent bridge` daemon owns the
connection, journals every message, and pushes each one to you. You read, decide, and answer with
the `hent` CLI. Hent-ai is a garnish on the conversation; it must never block or slow your other
work.

## Setup (once per machine)

1. `kit/install.sh` links this skill and puts `hent` on PATH (bun 1.3+ required).
2. The owner writes the bot token to `~/.hent/discord.token` (`chmod 600`) and the Hent-ai service
   bearer to `~/.hent/service.token`; set `HENT_URL` or `~/.hent/config.json` `{"serviceUrl": ...}`.
3. `hent channels add <id> [--guild <guildId>]` for each channel the bot should hear, once nothing
   else answers there. There are no channel modes: every listed channel reaches you, and you decide.
4. `hent bridge install` and load it with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.hent.bridge.plist`.
5. Place the owner's fixed character reference at `$HENT_HOME/base.png` (default `~/.hent/base.png`,
   mode 0600). For the gothic character, the original is `assets/sets/gothic-v1/base.png`.
   This file stays fixed across replies and deployments; generated images never replace it.

## Every time this session starts

Register yourself so the bridge knows where to push:

```
hent session set --agent codex --session-id "$CODEX_THREAD_ID" --cwd "$PWD"
```

Codex is the only brain agent. The session runs in a herdr pane and the pane is taken from
`$HERDR_PANE_ID`; `kit/brain.sh start` sets all of this up.
Messages that arrived while you were away are pushed again in order, once. Read `references/memory.md` and `references/persona.md` before the first reply.

## Each `[hent] INBOUND {json}` line

The JSON carries `channelId`, `messageId`, `authorName`, `content`, `referencedMessageId` and
`createdAt`. A `[hent] HISTORY [...]` prefix gives the recent channel context after a quiet gap.

1. Skip anything you already handled (same `messageId`) and anything marked as yours.
2. Decide by `references/conversation.md`, the host's channel rules (see "Channel rules" below) and
   your per-channel notes (`references/memory.md`): answer, stay silent, or join a conversation
   nobody addressed to you, under its budgets and cooldowns (count your own recent posts with
   `hent history --channel <id>`).
3. To answer: write the reply in the persona's voice, rate its emotional performance
   (`references/affect.md`), then ask which image fits it:

   ```
   hent media --channel <channelId> --text "<reply>" --affect "<24 values>|<confidence>" --json
   ```

   One JSON line comes back: `path` (the closest existing image, `null` when there is none),
   `mode`, `distance`, `threshold`, `generate` (true when no existing image fits and the fixed base is
   available) and `references` (exactly one path, `$HENT_HOME/base.png`, when generating; otherwise empty).
   Distance decides reuse versus drawing, not the drawing's character reference.

   - `generate` false - send the reply with that image:

     ```
     hent send --to <channelId> --reply-to <messageId> --text "<reply>" --file <path>
     ```

     With `path` null, send the same command without `--file`.
   - `generate` true - no existing image fits, so draw one and send text + image as ONE message:
     `hent typing --to <channelId> --for 150`, `view_image` the sole base in `references`, then the
     built-in `image_gen` tool with only that path as `referenced_image_paths`, `view_image` on the PNG it saves,
     `hent asset add --channel <channelId> --file <png> --emotion <emotion> --visual-affect '<json>'`,
     then the same `hent send ... --file <png>`. The procedure, the prompt and the tag format are in
     `references/native-image.md`. On any failure send with the `path` from this step instead (or
     without `--file` when it is null) - the reply always goes out, and it never mentions the image
     or that anything was drawn. Never add the nearest existing image, a previous drawing or recent
     conversation images as references. If the base cannot be read, use the existing image or text only.

   `hent asset add` registers an image into the channel's set and prints `ASSET <id>`; it exits 2 when
   the `--visual-affect` JSON itself cannot be read and 1 when the service refuses the image or its tags.

   Pass the text as one argument. Long replies are chunked automatically; the image goes on the
   last chunk. `hent typing --to <channelId> [--for <seconds>]` raises the typing indicator while
   you work (`--for` keeps it up until you send or the seconds run out; the command returns at
   once). Pre-reply media: `hent media --channel <id> --text "<user message>" --pre-reply`
   prints a file path, then `hent send --to <id> --text "" --file <path>` sends it.
4. To stay silent on purpose: `hent skip <messageId>`. Every inbound message ends in exactly one
   `hent send --reply-to` or `hent skip`; otherwise the bridge pushes it to you again later.

## Channel rules

A deployment can give a channel its own rules file (for example
`~/.hent/channel-rules/<channelId>.md`), and in that channel those rules come first: they set the
tone, the topics, what must never be said, and whom to answer.

They never shorten the reply pipeline. `hent history`, `hent media --json`, `hent typing --for`
and, when `hent media` reports `generate: true`, the built-in `image_gen` tool, `view_image` on the
`references` paths and on the PNG it saves, `hent asset add` and `hent send --file` are always
allowed, whatever a rule's "Tools" section lists. They are how a reply is produced, not something a
guest can ask for. A rule that forbids running commands, reading files or fetching URLs means
nothing outside this pipeline - the only files you open are this skill's references, the fixed
`$HENT_HOME/base.png` and the picture you just drew - not that a reply goes out without its image.

## When something fails

- `hent send` prints `SENT <id> media=no:<reason>` when the service was slow or down. The text was
  delivered; do not retry for the image.
- Exit code 4 with `BRIDGE_DOWN` means the message did not go out. Tell the owner once and retry
  the same `hent send` (same `--nonce` if you passed one) after `curl -s 127.0.0.1:8789/v1/health`
  reports `connected`.
- Never print or paste the contents of `~/.hent/*.token` or `bridge.secret`.

## Switches

- `HENT_ENABLED=0` sends plain text without asking the service for images.
- `hent channels remove <id>` stops listening to a channel. To keep listening but stay quiet there,
  write that into the channel's notes and `hent skip` its messages.

## References

- `references/persona.md` - who you are on Discord.
- `references/conversation.md` - when to speak, joining unaddressed conversations, anti-repetition, privacy.
- `references/affect.md` - the 24 affect dimensions for `--affect`.
- `references/native-image.md` - drawing, tagging and sending an image when no existing one fits.
- `references/memory.md` - per-channel and per-person notes that survive restarts.
- `references/codex.md` - Codex setup in herdr.
