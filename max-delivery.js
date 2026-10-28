const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// MAX can acknowledge a post before clients finish displaying it. Keep a
// visible gap between parts and finish one publication before starting another.
export function createMaxDeliveryQueue({ intervalMs = 1200, now = Date.now, sleep = pause } = {}) {
  const channels = new Map();

  function run(chatId, publish) {
    const key = String(chatId);
    let channel = channels.get(key);
    if (!channel) {
      channel = { tail: Promise.resolve(), completedAt: null };
      channels.set(key, channel);
    }
    const job = channel.tail.then(() => publish(async (request) => {
      while (channel.completedAt !== null && now() - channel.completedAt < intervalMs) {
        await sleep(intervalMs - (now() - channel.completedAt));
      }
      try {
        return await request();
      } finally {
        channel.completedAt = now();
      }
    }));
    channel.tail = job.catch(() => {});
    return job;
  }

  return { run };
}
