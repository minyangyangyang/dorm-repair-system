import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const databasePath = resolve(fileURLToPath(new URL('../data/repairs.sqlite', import.meta.url)))

export function openDatabase(path = databasePath) {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS repair_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_no TEXT NOT NULL UNIQUE,
      building TEXT NOT NULL CHECK(length(trim(building)) > 0),
      room TEXT NOT NULL CHECK(length(trim(room)) > 0),
      category TEXT NOT NULL CHECK(category IN ('水电', '家具', '网络', '门窗', '其他')),
      description TEXT NOT NULL CHECK(length(trim(description)) > 0),
      contact_name TEXT NOT NULL CHECK(length(trim(contact_name)) > 0),
      contact_phone TEXT NOT NULL CHECK(length(trim(contact_phone)) > 0),
      status TEXT NOT NULL DEFAULT '待处理' CHECK(status IN ('待处理', '已接单', '维修中', '已完成')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    -- 只新增评价表，不重建或清空已有工单表。
    CREATE TABLE IF NOT EXISTS evaluations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repair_order_id INTEGER NOT NULL UNIQUE REFERENCES repair_orders(id),
      rating INTEGER NOT NULL CHECK(typeof(rating) = 'integer' AND rating BETWEEN 1 AND 5),
      comment TEXT NOT NULL DEFAULT '' CHECK(typeof(comment) = 'text' AND length(comment) <= 500),
      created_at TEXT NOT NULL
    );
  `)
  return db
}
