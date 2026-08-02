/**
 * Every 10 minutes: query explore for kind:request caps on beacons we control,
 * then report findings into IRC (#test by default / IRC_CHANNEL).
 *
 * Requires production `eve start` (or dev dispatch) for the cron to fire.
 * Set VIT_CONTROLLED_BEACONS / VIT_CONTROLLED_BEACON_OWNERS to tune ownership.
 * Set VIT_REQUEST_REPORT_EMPTY=1 to also post when there are zero matches.
 */
import { defineSchedule } from "eve/schedules";

import irc from "../channels/irc.js";
import { getControlledBeacons } from "../lib/controlled-beacons.js";
import {
  fetchControlledRequestCaps,
  formatRequestCapsIrcLine,
} from "../lib/vit-request-caps.js";

const REPORT_EMPTY = () =>
  process.env.VIT_REQUEST_REPORT_EMPTY === "1" ||
  process.env.VIT_REQUEST_REPORT_EMPTY === "true";

export default defineSchedule({
  cron: "*/10 * * * *",
  async run({ receive, waitUntil, appAuth }) {
    const rawChannel = process.env.IRC_CHANNEL?.trim() || "#test";
    const channel = rawChannel.startsWith("#") ? rawChannel : `#${rawChannel}`;

    let line: string;
    try {
      const caps = await fetchControlledRequestCaps(50);
      if (caps.length === 0 && !REPORT_EMPTY()) {
        console.error(
          `[vit-request-caps] no request caps on controlled beacons (${getControlledBeacons().join(", ") || "owners-only"}); quiet`,
        );
        return;
      }
      line = formatRequestCapsIrcLine(caps);
      console.error(`[vit-request-caps] ${line}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      line = `vit request-caps: explore check failed — ${msg.replace(/\s+/g, " ").slice(0, 200)}`;
      console.error(`[vit-request-caps] error: ${msg}`);
    }

    // Ask the agent to relay a single IRC line (channel enforces one-line style).
    waitUntil(
      receive(irc, {
        message: `Scheduled vit request-cap report. Reply with EXACTLY this text as your entire message — one line, no tools, no extra words:\n${line}`,
        target: { channel },
        auth: appAuth,
      }),
    );
  },
});
