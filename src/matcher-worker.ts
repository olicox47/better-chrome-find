import { matchBlocks } from "./matcher";
import type { MatchRequest } from "./types";

self.addEventListener("message", (event: MessageEvent<MatchRequest>) => {
  self.postMessage(matchBlocks(event.data.blocks, event.data.search));
});
self.postMessage({ ready: true });
