import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { EffectRecord, EffectStore } from "./types.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const code = (error: unknown) => (error as NodeJS.ErrnoException).code;

/**
 * One JSON file per effect key, with a per-key lock file around every write.
 * Survives kill -9 on one machine, which is enough for local development and
 * the crash demo. For multiple instances, implement EffectStore over
 * Postgres (claim = INSERT ... ON CONFLICT DO NOTHING; replace/release =
 * UPDATE/DELETE ... WHERE owner = $expected) or Redis (SET NX; a Lua
 * compare-and-set).
 */
export function createFileStore(dir: string, options: { staleLockMs?: number } = {}): EffectStore {
  const staleLockMs = options.staleLockMs ?? 10_000;
  mkdirSync(dir, { recursive: true });
  const pathFor = (key: string) => join(dir, encodeURIComponent(key) + ".json");

  const read = (key: string): EffectRecord | undefined => {
    try {
      return JSON.parse(readFileSync(pathFor(key), "utf8")) as EffectRecord;
    } catch (error) {
      if (code(error) === "ENOENT") return undefined;
      throw error;
    }
  };

  // Readers never lock: every write lands via rename, so a reader sees the old file or the new one, never half of one.
  const write = (key: string, record: EffectRecord) => {
    const tmp = `${pathFor(key)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, JSON.stringify(record));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, pathFor(key));
  };

  async function withLock<T>(key: string, fn: () => T): Promise<T> {
    const lock = pathFor(key) + ".lock";
    for (;;) {
      try {
        closeSync(openSync(lock, "wx"));
        break;
      } catch (error) {
        if (code(error) !== "EEXIST") throw error;
        try {
          // A process that died inside the critical section leaves its lock behind.
          if (Date.now() - statSync(lock).mtimeMs > staleLockMs) unlinkSync(lock);
        } catch (e) {
          if (code(e) !== "ENOENT") throw e;
        }
        await sleep(2);
      }
    }
    try {
      return fn();
    } finally {
      unlinkSync(lock);
    }
  }

  return {
    async get(key) {
      return read(key);
    },
    claim(key, record) {
      return withLock(key, () => {
        const existing = read(key);
        if (existing) return existing;
        write(key, record);
        return null;
      });
    },
    replace(key, expectedOwner, next) {
      return withLock(key, () => {
        if (read(key)?.owner !== expectedOwner) return false;
        write(key, next);
        return true;
      });
    },
    release(key, expectedOwner) {
      return withLock(key, () => {
        if (read(key)?.owner !== expectedOwner) return false;
        unlinkSync(pathFor(key));
        return true;
      });
    },
  };
}
