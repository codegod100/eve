---
name: freeq-slide
description: >-
  Freeform AV caption card (slide mode). User says something; Eve shows it on
  the freeq AV tile only — no TTS echo (avoids mic feedback loops). Triggers:
  enter slide mode, exit slide mode. Tools: enter_slide_mode, exit_slide_mode,
  slide_status.
---

# freeq slide captions

## Loop

1. **Wait** — you say or type anything in the channel  
2. **Slide** — freeq AV tile shows your words (`YOU SAID #n`)  
3. **Wait again** until `exit slide mode`

No phrase deck. No witty comments. **No speak-back** (display only).

## Triggers

| Phrase | Action |
|--------|--------|
| enter slide mode / echo test / av echo | `enter_slide_mode` |
| exit slide mode / stop echo | `exit_slide_mode` |
| slide status | `slide_status` |

## Fast-path

- `eve: enter slide mode`
- `eve: exit slide mode`
- While live: **any channel line** is shown on the tile (not spoken)

Join freeq **AV** to see the tile. Voice is STT-only while slide mode is live.
