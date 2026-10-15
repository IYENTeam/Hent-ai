# Drawing the missing image

The channel's asset set does not hold a picture for every mood. When `hent media --json` reports
`generate: true`, nothing in the set is close enough to the reply you just rated: draw the missing
picture yourself with the built-in `image_gen` tool, register it so later replies can reuse it, and
send it with the reply as ONE message.

Two rules hold through the whole procedure:

- The reply text never mentions the picture, the drawing, the asset set or that anything was
  generated. The picture is a garnish; the conversation is the point.
- The reply always goes out. Every failure below falls back to sending the text with the existing
  image (or with no image), in the same turn.

## 1. Ask which image fits

```
hent media --channel <channelId> --text "<reply>" --affect "<24 values>|<confidence>" --json
```

One JSON line:

| field | meaning |
| --- | --- |
| `path` | local path of the closest existing image, `null` when the service returned none |
| `mode` | `affect-v2` (affect routing) or `legacy-fallback` |
| `distance` | affect distance from the reply to `path`, `null` in legacy fallback |
| `threshold` | the set's "close enough" distance, `null` in legacy fallback |
| `generate` | `true` when `distance` is past `threshold`: draw a new image |
| `references` | up to three local paths of the closest images - the style reference, filled only when `generate` is true |
| `reason` | only when there is no image at all (`no_media`, `no_affect`, a service failure) |

`generate` false ends it here:

```
hent send --to <channelId> --reply-to <messageId> --text "<reply>" --file <path>
```

With `path` null, send the same command without `--file`.

## 2. Hold the typing indicator

Drawing takes tens of seconds, so raise the indicator before anything else:

```
hent typing --to <channelId> --for 150
```

The command returns at once; the bridge keeps typing until you send to that channel or the seconds
run out (at most 600).

## 3. Draw it

Call the built-in `image_gen` tool with:

- `referenced_image_paths`: the `references` paths from step 1 (up to three). They carry the
  character, the outfit and the art style, and the new image must read as the same character.
- `prompt`: three parts, in this order.
  1. Who she is - the persona in `references/persona.md` (이연, an adult woman) as the reference
     images already show her: same face, hair, outfit and art style, one character, no text in the
     image, same framing as the references.
  2. The expression - the emotion's generation prompt, verbatim from `shared/emotions.ts`:

     | emotion | prompt |
     | --- | --- |
     | `sorry` | looking apologetic, bowing slightly, sheepish expression |
     | `happy` | smiling brightly, giving a thumbs up, celebrating with joy |
     | `confused` | tilting head with a puzzled look, question mark above head |
     | `focused` | concentrating intensely, determined expression, working hard |
     | `loyalty` | saluting attentively, nodding with respect, ready to help |
     | `neutral` | calm and relaxed, default resting expression, at ease |

     Pick the one emotion that matches the reply you rated; that same emotion goes into
     `hent asset add --emotion` in step 6.
  3. The moment - one short clause about what this reply is about (what she is reacting to), with
     no names, no quoted message text and no private detail from the conversation.

The tool saves the PNG as `$CODEX_HOME/generated_images/<session>/<call>.png` and returns that path;
use the returned path verbatim from here on.

## 4. Look at it

`view_image` the saved PNG before it goes anywhere. It is usable when it is the same character as
the references, shows the expression you asked for, and carries no text, no extra characters and no
visible artefacts. If it is not, treat it as a failure (see the last section).

## 5. Rate the image

Rate the picture itself - what the drawing shows, not what the reply says - as a `VisualAffectV2`
object. It is passed inline to `hent asset add` in step 6, so write no file; keep it as one JSON
value:

```json
{
  "schemaVersion": "VisualAffectV2",
  "affectSpaceVersion": "AffectSpaceV2",
  "dimensions": {
    "valence": 0.80, "arousal": 0.55, "dominance": 0.50, "joy": 0.85,
    "anger": 0.00, "irritation": 0.00, "sadness": 0.05, "anxiety": 0.05,
    "fear": 0.00, "surprise": 0.20, "confusion": 0.05, "disgust": 0.00,
    "embarrassment": 0.10, "pride": 0.30, "determination": 0.40, "affection": 0.75,
    "warmth": 0.80, "playfulness": 0.70, "teasing": 0.25, "deference": 0.60,
    "smileIntensity": 0.80, "browTension": 0.30, "eyeOpenness": 0.70, "bodyOpenness": 0.75
  },
  "confidence": 0.80,
  "evidence": ["wide smile", "thumbs up", "open posture"]
}
```

- `dimensions`: all 24 dimensions of `references/affect.md`, in the same order, as **0.00-1.00
  floats**. The `--affect` string uses 0-100 integers; this file does not.
- `confidence`: 0.00-1.00, how sure you are of the rating.
- `evidence`: 1 to 12 short strings, each describing something visible in the image.
- A missing key, an extra key, a value outside 0.00-1.00 or an empty `evidence` is rejected.

## 6. Register it

```
hent asset add --channel <channelId> --file <png path> --emotion <emotion> --visual-affect '<the JSON from step 5, one line>' --prompt "<the image_gen prompt>"
```

It prints `ASSET native_<hash>`. The image joins the channel's set with its tags, so a later reply
whose affect lands near it is answered with it instead of a new drawing. `--emotion` is the one
canonical emotion from step 3.

| exit | meaning | what to do |
| --- | --- | --- |
| 2 | the `--visual-affect` argument is not readable JSON, or a flag is missing | fix the argument, retry once |
| 1 | the service refused: unusable file, or tags the schema rejects (missing/extra dimension, a value outside 0.00-1.00, empty `evidence`) | fix the tags, retry once, then give up on registering |

## 7. Send text and image as one message

```
hent send --to <channelId> --reply-to <messageId> --text "<reply>" --file <png path>
```

One message carries the reply and the picture, and it marks the inbound message handled. Do not send
the text first and the image after; do not send `--affect` here - `--file` is the image you already
chose.

## When something fails

| failure | what to do |
| --- | --- |
| `hent media --json` fails, or `path` and `references` are both empty | send the reply as text only (no `--file`) |
| `image_gen` refuses, errors, or step 4 shows an unusable image | send with the step 1 `path` (`--file <path>`), or text only when it is null |
| `view_image` cannot read the PNG | same as above |
| `hent asset add` exits non-zero | send the drawn PNG anyway (`--file <png path>`); it just will not be reused later |
| `hent send --file` fails | retry the same command once without `--file` so the text goes out |

At most one drawing attempt per inbound message: a second failure means the text goes out with the
existing image. Never explain the failure, the generation or the image in the reply, and never
discuss generation cost or limits anywhere.
