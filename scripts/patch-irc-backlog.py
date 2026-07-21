#!/usr/bin/env python3
"""Patch agent/channels/irc.ts to use adaptive JOIN backlog ignore."""
from __future__ import annotations

import re
import sys
from pathlib import Path


def main() -> int:
    path = Path(sys.argv[1] if len(sys.argv) > 1 else "agent/channels/irc.ts")
    s = path.read_text()
    orig = s

    if "BACKLOG_MIN_MS" not in s:
        s2, n = re.subn(
            r"(const TCP_KEEPALIVE_MS = envMs\(\"IRC_TCP_KEEPALIVE_MS\", 30_000\);)",
            r"""\1
/** Minimum time after JOIN to drop all channel PRIVMSGs (history flood). */
const BACKLOG_MIN_MS = envMs("IRC_BACKLOG_MIN_MS", 10_000);
/** After MIN, end backlog after this quiet gap with no channel PRIVMSG. */
const BACKLOG_GAP_MS = envMs("IRC_BACKLOG_GAP_MS", 3_000);
/** Hard cap: stop ignoring channel traffic after this many ms post-JOIN. */
const BACKLOG_MAX_MS = envMs("IRC_BACKLOG_MAX_MS", 90_000);""",
            s,
            count=1,
        )
        if n != 1:
            print("failed: TCP_KEEPALIVE const", file=sys.stderr)
            return 1
        s = s2
        print("const ok")
    else:
        print("const skip")

    if "backlogActive" not in s:
        s2, n = re.subn(
            r"(  private joinedAt = 0; // ms timestamp of our own JOIN echo; used to drop history backlog\n)"
            r"(  private stopped = false;)",
            r"""\1  /** Drop channel PRIVMSG after JOIN until history flood ends (see shouldDropBacklog). */
  private backlogActive = false;
  /** Last time we saw a channel PRIVMSG while in backlog mode (or JOIN time). */
  private lastChannelMsgAt = 0;
  private backlogDropped = 0;
\2""",
            s,
            count=1,
        )
        if n != 1:
            print("failed: fields", file=sys.stderr)
            return 1
        s = s2
        print("fields ok")
    else:
        print("fields skip")

    if "this.backlogActive = false" not in s:
        s2, n = re.subn(
            r"(    this\.joined = false;\n    this\.joinedAt = 0;\n)(    this\.buf = \"\";)",
            r"""\1    this.backlogActive = false;
    this.lastChannelMsgAt = 0;
    this.backlogDropped = 0;
\2""",
            s,
            count=1,
        )
        if n != 1:
            print("failed: detach", file=sys.stderr)
            return 1
        s = s2
        print("detach ok")
    else:
        print("detach skip")

    if "ignoring channel backlog min=" not in s:
        s2, n = re.subn(
            r"""    if \(cmd === "JOIN" && nickFromPrefix\(m\.prefix\) === this\.nick\) \{
      this\.joined = true;
      this\.joinedAt = Date\.now\(\);
      console\.error\(
        `\[irc\] joined \$\{this\.channel\} on \$\{this\.host\} as \$\{this\.nick\}`,
      \);
      return;
    \}""",
            """    if (cmd === "JOIN" && nickFromPrefix(m.prefix) === this.nick) {
      this.joined = true;
      const now = Date.now();
      this.joinedAt = now;
      this.backlogActive = true;
      this.lastChannelMsgAt = now;
      this.backlogDropped = 0;
      console.error(
        `[irc] joined ${this.channel} on ${this.host} as ${this.nick} ` +
          `(ignoring channel backlog min=${BACKLOG_MIN_MS}ms gap=${BACKLOG_GAP_MS}ms max=${BACKLOG_MAX_MS}ms)`,
      );
      return;
    }""",
            s,
            count=1,
        )
        if n != 1:
            print("failed: join", file=sys.stderr)
            return 1
        s = s2
        print("join ok")
    else:
        print("join skip")

    if "private shouldDropBacklog" not in s:
        # Replace fixed 5s window + handlePrivmsg start through end of method.
        # Match both simple (local) and alias-aware (VM) handlePrivmsg bodies.
        pat = re.compile(
            r"  private handlePrivmsg\(from: string, target: string, text: string\) \{.*?\n  \}\n\n",
            re.S,
        )
        repl = r'''  /**
   * freeq (and similar) replay channel history as normal PRIVMSG after JOIN.
   * Drop channel traffic until past MIN after join, then a GAP with no channel
   * PRIVMSG — or until MAX post-join. DMs are never backlog-dropped.
   */
  private shouldDropBacklog(): boolean {
    if (!this.backlogActive || !this.joinedAt) return false;
    const now = Date.now();
    const sinceJoin = now - this.joinedAt;
    if (sinceJoin >= BACKLOG_MAX_MS) {
      this.endBacklog("max");
      return false;
    }
    if (sinceJoin < BACKLOG_MIN_MS) return true;
    if (now - this.lastChannelMsgAt < BACKLOG_GAP_MS) return true;
    this.endBacklog("gap");
    return false;
  }

  private endBacklog(reason: string) {
    if (!this.backlogActive) return;
    this.backlogActive = false;
    console.error(
      `[irc] backlog ignore ended (${reason}); dropped ${this.backlogDropped} channel msgs ` +
        `after ${Math.round((Date.now() - this.joinedAt) / 1000)}s`,
    );
  }

  private handlePrivmsg(from: string, target: string, text: string) {
    if (from === this.nick) return;
    const isChannel = target.startsWith("#") || target.startsWith("&");
    if (isChannel) {
      if (this.shouldDropBacklog()) {
        this.lastChannelMsgAt = Date.now();
        this.backlogDropped += 1;
        if (this.backlogDropped === 1 || this.backlogDropped % 50 === 0) {
          console.error(
            `[irc] backlog drop #${this.backlogDropped} from ${from} in ${target}`,
          );
        }
        return;
      }
    }
    // rest of body injected below — placeholder
  }

'''
        m = pat.search(s)
        if not m:
            print("failed: handlePrivmsg not found", file=sys.stderr)
            return 1
        old_body = m.group(0)
        # Keep alias mention logic if present
        if "preferredNick" in old_body and "aliases" in old_body:
            body_core = '''    let replyTarget = target;
    let body = text;
    if (isChannel) {
      // Accept current nick, preferred nick, and common aliases.
      const aliases = Array.from(
        new Set(
          [this.nick, this.preferredNick, "eve", "eve-agent"].filter(Boolean),
        ),
      );
      const alt = aliases
        .map((a) => a.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&"))
        .join("|");
      const mention = new RegExp(`^(?:${alt})[,: ]+`, "i");
      if (!mention.test(text)) return;
      body = text.replace(mention, "").trim();
      replyTarget = target;
      console.error(
        `[irc] mention from ${from} in ${target}: ${body.slice(0, 80)}`,
      );
    } else {
      if (this.owners.size && !this.owners.has(from.toLowerCase())) {
        this.sendPrivmsg(from, "not authorized");
        return;
      }
      replyTarget = from;
    }
    if (!body) return;
    this.onMessage(from, replyTarget, body);
  }

'''
        else:
            body_core = '''    if (this.isDuplicatePrivmsg(from, target, text)) return;
    let replyTarget = target;
    let body = text;
    if (isChannel) {
      const mention = new RegExp(`^${this.nick}[,: ]+`, "i");
      if (!mention.test(text)) return;
      body = text.replace(mention, "").trim();
      replyTarget = target;
    } else {
      if (this.owners.size && !this.owners.has(from.toLowerCase())) {
        this.sendPrivmsg(from, "not authorized");
        return;
      }
      replyTarget = from;
    }
    if (!body) return;
    this.onMessage(from, replyTarget, body);
  }

'''
        new_block = (
            """  /**
   * freeq (and similar) replay channel history as normal PRIVMSG after JOIN.
   * Drop channel traffic until past MIN after join, then a GAP with no channel
   * PRIVMSG — or until MAX post-join. DMs are never backlog-dropped.
   */
  private shouldDropBacklog(): boolean {
    if (!this.backlogActive || !this.joinedAt) return false;
    const now = Date.now();
    const sinceJoin = now - this.joinedAt;
    if (sinceJoin >= BACKLOG_MAX_MS) {
      this.endBacklog("max");
      return false;
    }
    if (sinceJoin < BACKLOG_MIN_MS) return true;
    if (now - this.lastChannelMsgAt < BACKLOG_GAP_MS) return true;
    this.endBacklog("gap");
    return false;
  }

  private endBacklog(reason: string) {
    if (!this.backlogActive) return;
    this.backlogActive = false;
    console.error(
      `[irc] backlog ignore ended (${reason}); dropped ${this.backlogDropped} channel msgs ` +
        `after ${Math.round((Date.now() - this.joinedAt) / 1000)}s`,
    );
  }

  private handlePrivmsg(from: string, target: string, text: string) {
    if (from === this.nick) return;
    const isChannel = target.startsWith("#") || target.startsWith("&");
    if (isChannel) {
      if (this.shouldDropBacklog()) {
        this.lastChannelMsgAt = Date.now();
        this.backlogDropped += 1;
        if (this.backlogDropped === 1 || this.backlogDropped % 50 === 0) {
          console.error(
            `[irc] backlog drop #${this.backlogDropped} from ${from} in ${target}`,
          );
        }
        return;
      }
    }
"""
            + body_core
        )
        s = s[: m.start()] + new_block + s[m.end() :]
        print("privmsg ok")
    else:
        print("privmsg skip")

    if s == orig:
        print("no changes", path)
        return 0
    path.write_text(s)
    print("wrote", path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
