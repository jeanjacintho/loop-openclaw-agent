// Loop's setup gate (Meetly's, with Loop's words). Before each of the owner's
// own DM turns it runs setup-status.ts and hands the model the answer, so the
// turn starts from what setup needs now instead of from whatever the chat
// history last asked, and knows the owner's local date and time. The prompt
// keeps "run setup-status.ts first" as the fallback: nothing is added when the
// script cannot run, and the model then runs it itself.
//
// Plain JavaScript on purpose: the image ships it as is, with no build step.
import { execFile } from "node:child_process";

export const OWNER_DM_SESSION = "agent:main:main";
export const SETUP_STATUS = "/opt/plow/skills/loop/scripts/setup-status.ts";

/** The owner's phone DM as the hook sees it: the Plow chat account, the owner's session, a user turn. */
export function isOwnerDmTurn(ctx) {
  return ctx?.channel === "plow" && (ctx.accountId ?? "chat") === "chat" &&
    ctx.sessionKey === OWNER_DM_SESSION && (ctx.trigger === undefined || ctx.trigger === "user");
}

/** What the model is told this turn, from setup-status.ts's JSON line; undefined when that is not a status. */
export function gateContext(stdout) {
  let status;
  try {
    status = JSON.parse(String(stdout).trim().split("\n").at(-1));
  } catch {
    return undefined;
  }
  if (status?.status === "READY") {
    return [
      "Loop setup check, already run for this turn (setup-status.ts): READY.",
      `The owner's local time is ${status.now} (${status.weekday}), time zone ${status.config?.timezone}.`,
      "Do not run setup-status.ts again this turn. Handle the owner's message as \"How Loop works\" says.",
      `setup-status.ts output: ${JSON.stringify(status)}`,
    ].join("\n");
  }
  if (status?.status !== "SETUP_NEEDED") return undefined;
  return [
    "Loop setup check, already run for this turn (setup-status.ts): SETUP_NEEDED. Setup is not finished.",
    "Do not run setup-status.ts again this turn, and ignore any earlier setup question in the chat: this is the current state.",
    "Your reply, in the owner's language:",
    "- If you have not introduced yourself in this conversation yet, open with one line: you are Loop, their follow-through agent, and a few quick questions set you up.",
    "- If the owner asked for something else, say you will do it once setup is done.",
    status.question
      ? `- Then ask this question, translated into the owner's language, and end the turn: ${status.question}`
      : "- Every answer is in: run record-setup.ts --done and follow loop-setup from there.",
    `If the owner's message answers ${status.next ? `the ${status.next} question` : "a question"}, record it first with record-setup.ts (see loop-setup) and ask the question it returns instead.`,
    `setup-status.ts output: ${JSON.stringify(status)}`,
  ].join("\n");
}

// setup-status.ts may ask Plow for the owner's name and the Mac for their time zone.
const runStatus = () => new Promise((resolve, reject) => {
  execFile(process.execPath, [SETUP_STATUS], { env: process.env, timeout: 30_000, maxBuffer: 65_536 },
    (error, stdout) => error ? reject(error) : resolve(stdout));
});

export default {
  id: "loop",
  name: "Loop",
  description: "Runs Loop's setup check before each of the owner's DM turns.",
  register(api) {
    api.on("before_prompt_build", async (_event, ctx) => {
      if (!isOwnerDmTurn(ctx)) return undefined;
      let context;
      try {
        context = gateContext(await runStatus());
      } catch (error) {
        api.logger.info(`loop setup gate unavailable (${error instanceof Error ? error.message : String(error)}); prompt fallback applies`);
        return undefined;
      }
      // One line per owner turn, so a live run shows the gate reached the prompt.
      api.logger.info(context ? `loop setup gate prepended: ${context.split("\n")[0]}` : "loop setup gate: unreadable status; prompt fallback applies");
      return context ? { prependContext: context } : undefined;
    });
  },
};
