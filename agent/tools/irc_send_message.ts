import { defineTool } from "eve/tools";
import { z } from "zod";
import { broadcastPrivmsg, ircBridgeClientCount, IRC_CHANNEL } from "../channels/irc.js";

/**
 * Proactive IRC send — the gap eve itself flagged: replying to a mention
 * always lands back wherever the mention came from, but there was no way to
 * originate a message to a channel/nick on its own initiative (a background
 * update, an alert, "post this to #test now"). This gives the model exactly
 * that, over the same outbound SSE path irc-bridge already listens on for
 * mention replies and schedule → receive() channel posts.
 */
export default defineTool({
  description:
    "Proactively send an IRC message to a channel or nick, independent of " +
    "replying to whoever triggered this turn. Use this to originate a " +
    "message — post an update to a channel you weren't mentioned in, alert " +
    "someone, or follow up later — not for a normal reply to a mention " +
    "(that happens automatically; you don't need this tool for it).",
  inputSchema: z.object({
    target: z
      .string()
      .min(1)
      .describe(
        `IRC channel (e.g. "${IRC_CHANNEL}") or nick to message. Channels start with #.`,
      ),
    text: z
      .string()
      .min(1)
      .max(1000)
      .describe("Message text to send, as one or more IRC lines."),
  }),
  async execute({ target, text }) {
    const listeners = ircBridgeClientCount();
    if (listeners === 0) {
      return {
        ok: false,
        error: "no irc-bridge is currently connected — message was not sent",
      };
    }
    broadcastPrivmsg(target, text);
    return { ok: true, target, text };
  },
});
