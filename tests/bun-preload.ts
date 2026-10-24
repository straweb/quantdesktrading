// Bun test preload — registered in bunfig.toml ([test] preload).
//
// capital-service (and the brokers layer behind it) imports `node:sqlite`,
// a Node.js built-in that Bun does not ship. The unit tests only exercise
// the pure sizing math, so a stub DatabaseSync is enough to satisfy the
// module graph — no database is ever opened by these tests.
import { mock } from 'bun:test'

mock.module('node:sqlite', () => ({
  DatabaseSync: class DatabaseSyncStub {
    // eslint-disable-next-line @typescript-eslint/no-useless-constructor, @typescript-eslint/no-unused-vars
    constructor(_path?: string) {}
    exec(_sql: string): void {}
    prepare(_sql: string): never {
      throw new Error('DatabaseSync stub — unit tests must not touch the broker DBs')
    }
    close(): void {}
  },
}))
