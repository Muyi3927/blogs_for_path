import { Hono } from 'hono';
import { cors } from 'hono/cors';

// Placeholder types to fix "Cannot find name" errors when @cloudflare/workers-types is not globally available
type D1Database = any;
type R2Bucket = any;

// Define the structure of our environment variables (bindings)
type Bindings = {
  DB: D1Database;
  BUCKET: R2Bucket;
  // This variable should be set in Cloudflare Dashboard or wrangler.toml
  // For now we default to a hardcoded string in code for simplicity if var is missing
  AUTH_SECRET?: string;
  // The public domain for your R2 bucket (e.g. https://media.yourdomain.com)
  // If not set, we will try to construct a default R2.dev URL, but Custom Domain is recommended.
  R2_PUBLIC_DOMAIN?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// Enable CORS for all routes
app.use('/*', cors());

// --- Auth Helper ---
const checkAuth = (c: any) => {
  const authHeader = c.req.header('Authorization');
  // Default secret if env var is not set. 
  // IMPORTANT: Change this for production!
  const secret = c.env.AUTH_SECRET || "my-secret-password"; 
  
  if (!authHeader || authHeader !== `Bearer ${secret}`) {
    return false;
  }
  return true;
};

// --- 路由 ---

// 1. 获取所有文章
app.get('/api/posts', async (c) => {
  try {
    // D1: 查询 posts 表，按创建时间倒序排序
    const { results } = await c.env.DB.prepare(
      `SELECT * FROM posts ORDER BY createdAt DESC`
    ).all();
    
    // 格式化从数据库取出的数据，以匹配前端 BlogPost 接口
    const posts = results.map((p: any) => ({
      ...p,
      // --- 修复: 确保 categoryId 是字符串，避免前端类型不匹配 ---
      categoryId: p.categoryId ? String(p.categoryId) : null,
      tags: p.tags ? JSON.parse(p.tags) : [],
      isFeatured: Boolean(p.isFeatured),
      author: { username: p.authorName || 'Admin', role: 'ADMIN' } 
    }));
    
    return c.json(posts);
  } catch (e: any) {
    console.error("DB Error:", e);
    return c.json({ error: e.message || "Database error" }, 500);
  }
});

// 2. 获取单篇文章
app.get('/api/posts/:id', async (c) => {
  const id = c.req.param('id');
  try {
    const post = await c.env.DB.prepare('SELECT * FROM posts WHERE id = ?').bind(id).first();
    
    if (!post) return c.json({ error: 'Not found' }, 404);
    
    const formatted = {
      ...post,
      tags: post.tags ? JSON.parse(post.tags as string) : [],
      isFeatured: Boolean(post.isFeatured),
      author: { username: post.authorName || 'Admin', role: 'ADMIN' }
    };
    
    return c.json(formatted);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// 3. 创建或更新文章 (受保护的路由)
app.post('/api/posts', async (c: any) => {
  if (!checkAuth(c)) return c.json({ error: 'Unauthorized' }, 401);

  try {
    const body = await c.req.json();
    // 前端传来的 ID 可能是新文章的 UUID (如果前端生成) 或旧文章的数字 ID
    const { id, title, excerpt, content, coverImage, categoryId, tags, isFeatured, audioUrl, author } = body;
    
    const now = Date.now();
    const tagString = JSON.stringify(tags || []);

    // --- 检查文章是否存在 ---
    const existing = id ? await c.env.DB.prepare('SELECT id FROM posts WHERE id = ?').bind(id).first() : null;

    if (existing) {
        // --- 更新现有文章 ---
        await c.env.DB.prepare(`
            UPDATE posts SET title=?, excerpt=?, content=?, coverImage=?, updatedAt=?, categoryId=?, tags=?, isFeatured=?, audioUrl=?
            WHERE id=?
        `).bind(title, excerpt, content, coverImage, now, categoryId, tagString, isFeatured ? 1 : 0, audioUrl, id).run();
        
        return c.json({ success: true, id: id });

    } else {
        // --- 插入新文章 (让数据库自动生成自增 ID) ---
        const result = await c.env.DB.prepare(`
            INSERT INTO posts (title, excerpt, content, coverImage, createdAt, updatedAt, categoryId, tags, isFeatured, audioUrl, authorName)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(title, excerpt, content, coverImage, now, now, categoryId, tagString, isFeatured ? 1 : 0, audioUrl, author?.username || 'Admin').run();

        const newId = result.meta.last_row_id;
        
        return c.json({ success: true, id: newId });
    }

  } catch (e: any) {
    console.error("Save Error:", e);
    return c.json({ error: e.message }, 500);
  }
});

// 4. 上传文件到 R2 (受保护的路由) - 自动分文件夹
app.put('/api/upload', async (c) => {
  if (!checkAuth(c)) return c.json({ error: 'Unauthorized' }, 401);

  try {
    const formData = await c.req.parseBody();
    const file = formData['file'];

    if (!file || !(file instanceof File)) {
      return c.json({ error: 'No file uploaded' }, 400);
    }

    // === 根据文件类型自动决定文件夹 ===
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    const audioExts = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'webm'];
    const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'];

    let folder = 'others/'; // 默认
    if (imageExts.includes(ext)) {
      folder = 'images/';
    } else if (audioExts.includes(ext)) {
      folder = 'audios/';
    }

    // 生成文件名（时间戳 + 原文件名）
    const safeName = `${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
    const key = `${folder}${safeName}`;  // 关键：这里拼接文件夹

    // 上传到 R2（key 包含文件夹）
    await c.env.BUCKET.put(key, file.stream(), {
      httpMetadata: { contentType: file.type }
    });

    // 生成公开 URL（自动带文件夹）
    let publicUrl = '';
    if (c.env.R2_PUBLIC_DOMAIN) {
      const base = c.env.R2_PUBLIC_DOMAIN.endsWith('/') 
        ? c.env.R2_PUBLIC_DOMAIN.slice(0, -1) 
        : c.env.R2_PUBLIC_DOMAIN;
      publicUrl = `${base}/${key}`;  // 自动变成 /images/xxx.png 或 /audios/xxx.mp3
    } else {
      return c.json({ error: 'R2_PUBLIC_DOMAIN 未配置' }, 500);
    }

    return c.json({ url: publicUrl });
  } catch (e: any) {
    console.error("Upload Error:", e);
    return c.json({ error: e.message }, 500);
  }
});

// 5. 获取所有分类
app.get('/api/categories', async (c) => {
  try {
    const { results } = await c.env.DB.prepare('SELECT * FROM categories').all();
    // --- 修复: 确保所有分类 ID 都是字符串 ---
    const stringifiedResults = results.map((cat: any) => ({
        ...cat,
        id: String(cat.id),
        parentId: cat.parentId ? String(cat.parentId) : null
    }));
    return c.json(stringifiedResults);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// 6. 创建分类 (受保护的路由)
app.post('/api/categories', async (c: any) => {
  if (!checkAuth(c)) return c.json({ error: 'Unauthorized' }, 401);

  try {
    const body = await c.req.json();
    const name = body.name;
    const parentId = body.parentId ?? null;

    if (!name) return c.json({ error: 'Missing name' }, 400);

    // --- 修复: 让 D1 处理自增 ID ---
    // 我们不再在 INSERT 语句中提供 ID。
    const result = await c.env.DB.prepare(
        `INSERT INTO categories (name, parentId) VALUES (?, ?)`
      )
      .bind(name, parentId)
      .run();

    // 获取数据库刚刚生成的 ID。
    const newId = result.meta.last_row_id;

    return c.json({ success: true, category: { id: newId, name, parentId } });
  } catch (e: any) {
    console.error('Create category error:', e);
    return c.json({ error: e.message || String(e) }, 500);
  }
});

// 7. 删除分类 (受保护的路由)
app.delete('/api/categories/:id', async (c: any) => {
  if (!checkAuth(c)) return c.json({ error: 'Unauthorized' }, 401);

  const id = c.req.param('id');
  try {
    // 删除分类
    await c.env.DB.prepare('DELETE FROM categories WHERE id = ?').bind(id).run();

    // 如果有文章引用了这个分类，将其设为未分类
    try {
      await c.env.DB.prepare('UPDATE posts SET categoryId = ? WHERE categoryId = ?').bind('', id).run();
    } catch (e) {
      console.warn('Failed to update posts when deleting category:', e);
    }

    // 如果有子分类引用了这个分类，将其设为顶级分类 (parentId = NULL)
    try {
      await c.env.DB.prepare('UPDATE categories SET parentId = NULL WHERE parentId = ?').bind(id).run();
    } catch (e) {
      // ignore if parentId column doesn't exist
    }

    return c.json({ success: true });
  } catch (e: any) {
    console.error('Delete category error:', e);
    return c.json({ error: e.message || String(e) }, 500);
  }
});

export default app;
