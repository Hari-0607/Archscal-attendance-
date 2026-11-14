import { Injectable, OnModuleDestroy } from "@nestjs/common";
import type { ThrottlerStorage, ThrottlerStorageRecord } from "@nestjs/throttler";
import Redis from "ioredis";

@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage, OnModuleDestroy {
  private readonly redis = new Redis(process.env.REDIS_URL!, { lazyConnect: true, maxRetriesPerRequest: 2, enableOfflineQueue: false });
  private readonly script = `
    local hits = redis.call('INCR', KEYS[1])
    if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
    local ttl = redis.call('PTTL', KEYS[1])
    local blocked = redis.call('EXISTS', KEYS[2])
    if hits > tonumber(ARGV[2]) and blocked == 0 then
      redis.call('SET', KEYS[2], '1', 'PX', ARGV[3], 'NX')
      blocked = 1
    end
    local blockTtl = 0
    if blocked == 1 then blockTtl = redis.call('PTTL', KEYS[2]) end
    return {hits, ttl, blocked, blockTtl}`;

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string): Promise<ThrottlerStorageRecord> {
    if (this.redis.status === "wait") await this.redis.connect();
    const safeKey = `attendflow:throttle:${throttlerName}:${key}`;
    const result = await this.redis.eval(this.script, 2, safeKey, `${safeKey}:blocked`, String(ttl), String(limit), String(blockDuration)) as [number, number, number, number];
    return { totalHits: Number(result[0]), timeToExpire: Math.max(0, Number(result[1])), isBlocked: Number(result[2]) === 1, timeToBlockExpire: Math.max(0, Number(result[3])) };
  }

  async onModuleDestroy() { await this.redis.quit(); }
}
