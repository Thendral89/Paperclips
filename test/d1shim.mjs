// Minimal Cloudflare D1 stand-in using Node 22's built-in SQLite.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";

class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args.map(value => value === undefined ? null : value); return this; }
  async first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
  async run() {
    const result = this.db.prepare(this.sql).run(...this.args);
    return { meta: { last_row_id: Number(result.lastInsertRowid), changes: Number(result.changes) } };
  }
}

export function makeDB() {
  const raw = new DatabaseSync(":memory:");
  for (const file of fs.readdirSync("migrations").filter(file => file.endsWith(".sql")).sort()) {
    raw.exec(fs.readFileSync("migrations/" + file, "utf8"));
  }
  return {
    raw,
    prepare: sql => new Statement(raw, sql),
    async batch(statements) {
      raw.exec("BEGIN");
      try {
        const output = [];
        for (const statement of statements) output.push(await statement.run());
        raw.exec("COMMIT");
        return output;
      } catch (error) {
        raw.exec("ROLLBACK");
        throw error;
      }
    }
  };
}
