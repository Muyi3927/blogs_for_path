-- drop table if exists posts;
-- drop table if exists categories;

-- schema.sql  修改后版本

-- 文章表
-- 使用自增整数作为主键，更整洁
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  excerpt TEXT,
  content TEXT NOT NULL,
  coverImage TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  categoryId INTEGER, -- 关联到 categories 表的 id
  tags TEXT,
  isFeatured INTEGER DEFAULT 0,
  audioUrl TEXT,
  authorName TEXT DEFAULT 'Admin'
);

-- 分类表
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parentId INTEGER -- 父分类的 ID，用于实现层级关系
);


