import { motionTokens as t } from "../arc/motion-tokens";

/** Shared entrance for anything that appears in the conversation (messages, cards, notices). */
export const enter = {
  initial: { opacity: 0, y: 6, filter: `blur(${t.blur.subtle}px)` },
  animate: { opacity: 1, y: 0, filter: "blur(0px)" },
  transition: { duration: t.duration.standard, ease: t.ease.enter as any },
};

/** Your own message lands from where you typed it: a little scale + rise, settling with a hint of overshoot. */
export const bubbleIn = {
  initial: { opacity: 0, y: 6, scale: .96 },
  animate: { opacity: 1, y: 0, scale: 1 },
  transition: { duration: t.duration.standard + .04, ease: [.34, 1.3, .64, 1] as any },
  style: { transformOrigin: "100% 100%" },
};

export const fade = { duration: t.duration.fast };
