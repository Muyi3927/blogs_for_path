-- schema.sql  修改后版本
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  excerpt TEXT,
  content TEXT NOT NULL,
  coverImage TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  categoryId TEXT,
  tags TEXT,
  isFeatured INTEGER DEFAULT 0,
  audioUrl TEXT,
  authorName TEXT DEFAULT 'Admin'
);

-- 只保留已有的列！删掉 description
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
  -- description TEXT   ← 删除这行，或者整行注释
);

-- 默认分类也相应修改
INSERT OR IGNORE INTO categories (id, name) VALUES 
('1', '灵修笔记'),
('2', '古道释经'),
('3', '见证分享');
