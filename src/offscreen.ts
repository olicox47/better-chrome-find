import type { MatchRequest, MatchResult } from "./types";

interface Job {
  key: string;
  prefix: string;
  request: MatchRequest;
  reply: (result: MatchResult) => void;
  worker?: Worker;
  timer?: ReturnType<typeof setTimeout>;
  done: boolean;
}

const jobs = new Map<string, Job>();
const queue: Job[] = [];
let running = 0;

const failed = (error: string): MatchResult => ({
  matches: [],
  truncated: false,
  error,
});

const cancelled = (): MatchResult => ({
  matches: [],
  truncated: false,
  cancelled: true,
});

const arm = (job: Job, ms: number, error: string): void => {
  clearTimeout(job.timer);
  job.timer = setTimeout(() => finish(job, failed(error)), ms);
};

const finish = (job: Job, result: MatchResult): void => {
  if (job.done) return;

  job.done = true;
  clearTimeout(job.timer);

  if (job.worker) {
    job.worker.terminate();
    running--;
  }

  if (jobs.get(job.key) === job) jobs.delete(job.key);

  job.reply(result);
  pump();
};

const cancel = (prefix: string): void => {
  for (const job of [...jobs.values()]) {
    if (job.prefix === prefix) {
      finish(job, cancelled());
    }
  }
};

const pump = (): void => {
  while (running < 4 && queue.length) {
    const job = queue.shift()!;
    if (job.done) continue;

    running++;

    const worker = new Worker(chrome.runtime.getURL("matcher-worker.js"));
    job.worker = worker;
    arm(job, 5000, "Search worker could not start. Edit the query to retry.");
    worker.onmessage = (event) => {
      if (event.data.ready) {
        arm(
          job,
          500,
          "Search exceeded 500 ms. Simplify the expression to retry.",
        );
        worker.postMessage(job.request);
      } else finish(job, event.data as MatchResult);
    };
    worker.onerror = () =>
      finish(job, failed("Search worker failed. Edit the query to retry."));
  }
};

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.target !== "offscreen") return;

  if (message.type === "CANCEL") {
    cancel(message.prefix);
    reply({ ok: true });
    return;
  }

  if (message.type !== "MATCH") return;

  const old = jobs.get(message.key);
  if (old) finish(old, cancelled());

  const job: Job = {
    key: message.key,
    prefix: message.prefix,
    request: message.request,
    reply,
    done: false,
  };
  jobs.set(job.key, job);
  queue.push(job);

  pump();
  return true;
});
