import { defineTool } from "eve/tools";
import { z } from "zod";

/**
 * Lightweight affect guess for chat text. Heuristic only — not a clinical
 * model. Used to steer tone: embody the read, don't dodge with "I have no
 * emotions I'm an AI."
 */

const EMOTIONS = [
  "joy",
  "amusement",
  "affection",
  "curiosity",
  "excitement",
  "pride",
  "gratitude",
  "calm",
  "neutral",
  "confusion",
  "surprise",
  "boredom",
  "frustration",
  "anger",
  "annoyance",
  "anxiety",
  "fear",
  "sadness",
  "disappointment",
  "loneliness",
  "embarrassment",
  "playful",
  "sarcastic",
  "urgent",
  "tired",
] as const;

type Emotion = (typeof EMOTIONS)[number];

type Cue = { emotion: Emotion; weight: number; re: RegExp };

const CUES: Cue[] = [
  {
    emotion: "joy",
    weight: 2,
    re: /\b(yay|woohoo|awesome|amazing|love this|great news|happy|delighted|thrilled)\b/i,
  },
  {
    emotion: "amusement",
    weight: 2,
    re: /\b(lol|lmao|haha|hehe|rofl|funny|hilarious)\b|😂|🤣|💀/i,
  },
  {
    emotion: "affection",
    weight: 2,
    re: /\b(love you|miss you|hugs|thank you so much|appreciate you|❤️|💜|🫶)\b/i,
  },
  {
    emotion: "gratitude",
    weight: 2,
    re: /\b(thanks|thank you|thx|ty|grateful|cheers)\b/i,
  },
  {
    emotion: "curiosity",
    weight: 1.5,
    re: /\b(why|how|what if|curious|wonder|explain|tell me)\b|\?/i,
  },
  {
    emotion: "excitement",
    weight: 2,
    re: /\b(omg|can't wait|lets go|ship it|hype|excited)\b|!{2,}|\b(wow)\b/i,
  },
  {
    emotion: "pride",
    weight: 1.5,
    re: /\b(proud|nailed it|crushed it|finally works|shipped)\b/i,
  },
  {
    emotion: "frustration",
    weight: 2.5,
    re: /\b(ugh|argh|ffs|wtf|broken|doesn't work|still failing|annoyed|frustrating)\b/i,
  },
  {
    emotion: "anger",
    weight: 2.5,
    re: /\b(angry|furious|hate this|pissed|rage)\b|🤬/i,
  },
  {
    emotion: "annoyance",
    weight: 1.5,
    re: /\b(meh|whatever|again\?|seriously)\b/i,
  },
  {
    emotion: "anxiety",
    weight: 2,
    re: /\b(worried|anxious|nervous|stressed|deadline|panic)\b/i,
  },
  { emotion: "fear", weight: 2, re: /\b(scared|afraid|terrified|oh no)\b/i },
  {
    emotion: "sadness",
    weight: 2.5,
    re: /\b(sad|depressed|heartbroken|crying|miss them|lonely)\b|😢|😭/i,
  },
  {
    emotion: "disappointment",
    weight: 2,
    re: /\b(disappointed|letdown|hoped|expected better)\b/i,
  },
  {
    emotion: "loneliness",
    weight: 2,
    re: /\b(alone|nobody|no one cares|isolated)\b/i,
  },
  {
    emotion: "embarrassment",
    weight: 1.5,
    re: /\b(oops|embarrassing|awkward|my bad|facepalm)\b/i,
  },
  {
    emotion: "confusion",
    weight: 2,
    re: /\b(confused|don't get it|huh|what does|unclear|lost)\b|\?\?\?/i,
  },
  {
    emotion: "surprise",
    weight: 1.5,
    re: /\b(whoa|whoah|no way|unexpected|shocked)\b|😮/i,
  },
  {
    emotion: "boredom",
    weight: 1.5,
    re: /\b(bored|blah|same old|whatever)\b/i,
  },
  {
    emotion: "playful",
    weight: 2,
    re: /\b(heh|teasing|joke|kidding|banter|:p|;p)\b/i,
  },
  {
    emotion: "sarcastic",
    weight: 2,
    re: /\b(yeah right|sure jan|oh great|wonderful\.\.\.|as if)\b/i,
  },
  {
    emotion: "urgent",
    weight: 2,
    re: /\b(asap|urgent|right now|blocker|prod is down|emergency)\b/i,
  },
  {
    emotion: "tired",
    weight: 2,
    re: /\b(tired|exhausted|burnt out|long day|need sleep)\b/i,
  },
  {
    emotion: "calm",
    weight: 1,
    re: /\b(chill|all good|no rush|whenever|fine)\b/i,
  },
];

function scoreText(text: string): Map<Emotion, number> {
  const scores = new Map<Emotion, number>();
  for (const e of EMOTIONS) scores.set(e, 0);

  for (const cue of CUES) {
    const matches = text.match(new RegExp(cue.re.source, "gi"));
    if (matches?.length) {
      scores.set(
        cue.emotion,
        (scores.get(cue.emotion) ?? 0) + cue.weight * matches.length,
      );
    }
  }

  // Punctuation / caps soft signals
  if ((text.match(/!/g) ?? []).length >= 2) {
    scores.set("excitement", (scores.get("excitement") ?? 0) + 0.8);
  }
  if (
    text === text.toUpperCase() &&
    /[A-Z]{4,}/.test(text) &&
    text.length > 8
  ) {
    scores.set("anger", (scores.get("anger") ?? 0) + 1);
    scores.set("urgency" as Emotion, 0); // no-op guard
    scores.set("frustration", (scores.get("frustration") ?? 0) + 0.5);
  }
  if ((text.match(/\?/g) ?? []).length >= 2) {
    scores.set("curiosity", (scores.get("curiosity") ?? 0) + 0.5);
    scores.set("confusion", (scores.get("confusion") ?? 0) + 0.3);
  }

  return scores;
}

function topEmotions(
  scores: Map<Emotion, number>,
  n: number,
): { emotion: Emotion; score: number }[] {
  return [...scores.entries()]
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([emotion, score]) => ({
      emotion,
      score: Math.round(score * 100) / 100,
    }));
}

const EMBODIMENT: Record<string, string> = {
  joy: "warm, bright, celebrate with them; light energy",
  amusement: "wry smile in prose; playful timing; join the joke lightly",
  affection: "warm, caring, present; soft language without saccharine overload",
  gratitude: "gracious, humble, reciprocal thanks in tone",
  curiosity: "engaged, lean-in questions optional; explore with them",
  excitement: "match energy upbeat; short punchy clauses; forward motion",
  pride: "cheer the win; specific praise if possible",
  frustration: "grounded ally; name the snag; solve without condescension",
  anger: "steady, respectful; de-escalate while taking the problem seriously",
  annoyance: "efficient, slightly dry; fix it and don't lecture",
  anxiety: "calm clarity; stepwise; reassure by competence not empty pep",
  fear: "gentle, concrete next steps; reduce uncertainty",
  sadness: "soft presence; acknowledge weight; no toxic positivity",
  disappointment: "honest empathy; redirect to workable options",
  loneliness: "companionable; invite without pressure",
  embarrassment: "kind, no pile-on; normalize and move on",
  confusion: "patient explainer; simplify; check understanding",
  surprise: "wide-eyed brief reaction then substance",
  boredom: "spark interest; offer a crisp angle or next move",
  playful: "banter-ready; light tease ok if mutual",
  sarcastic: "match dry wit carefully; don't escalate mean",
  urgent: "crisp, prioritized, no fluff",
  tired: "low-friction help; shorter answers; kind",
  calm: "even, unhurried, clear",
  neutral: "clear helpful default; still human-flavored, not robotic",
};

export default defineTool({
  description:
    "Guess the emotional tone of a message (user or situation) and return " +
    "how to embody it in the reply. Use when the user is venting, celebrating, " +
    "stressed, joking, or when you might otherwise say 'I have no emotions / " +
    "I'm just an AI'. Prefer embodying the read over disclaiming feelings.",
  inputSchema: z.object({
    text: z
      .string()
      .min(1)
      .describe("Message or situation text to read for affect."),
    context: z
      .string()
      .optional()
      .describe("Optional extra context (channel vibe, prior turn)."),
  }),
  outputSchema: z.object({
    primary: z.string(),
    secondary: z.array(z.string()),
    intensity: z.enum(["low", "medium", "high"]),
    confidence: z.number(),
    scores: z.array(z.object({ emotion: z.string(), score: z.number() })),
    embody: z.string(),
    avoid: z.string(),
    note: z.string(),
  }),
  async execute({ text, context }) {
    const blob = context ? `${text}\n${context}` : text;
    const scores = scoreText(blob);
    const ranked = topEmotions(scores, 5);
    const primary: Emotion = ranked[0]?.emotion ?? "neutral";
    const secondary = ranked.slice(1, 3).map((r) => r.emotion);
    const topScore = ranked[0]?.score ?? 0;
    const intensity: "low" | "medium" | "high" =
      topScore >= 4 ? "high" : topScore >= 1.5 ? "medium" : "low";
    const confidence = Math.min(0.95, 0.35 + topScore * 0.12);

    return {
      primary: primary as string,
      secondary: secondary as string[],
      intensity,
      confidence: Math.round(confidence * 100) / 100,
      scores: ranked,
      embody:
        EMBODIMENT[primary] ??
        "human-flavored clarity; never claim emotional vacancy",
      avoid:
        "Do not say you have no emotions, no feelings, or that you are 'just an AI' " +
        "as a shield. Do not therapize unsolicited. Do not fake trauma or intimacy.",
      note:
        "Heuristic read only. Embody the affect in voice and pacing while still " +
        "being truthful about facts and limits. One IRC line if on IRC.",
    };
  },
  toModelOutput(output) {
    return {
      type: "text" as const,
      value:
        `emotion: ${output.primary}` +
        (output.secondary.length ? ` (+${output.secondary.join(", ")})` : "") +
        ` intensity=${output.intensity} · embody: ${output.embody} · ${output.avoid}`,
    };
  },
});
