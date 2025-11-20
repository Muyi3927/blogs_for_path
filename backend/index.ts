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

// --- Routes ---

// 1. Get All Posts
app.get('/api/posts', async (c) => {
  try {
    // D1: Select all posts
    const { results } = await c.env.DB.prepare(
      `SELECT * FROM posts ORDER BY createdAt DESC`
    ).all();
    
    // Transform data format to match frontend BlogPost interface
    const posts = results.map((p: any) => ({
      ...p,
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

// 2. Get Single Post
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

// 3. Create/Update Post (Protected)
app.post('/api/posts', async (c) => {
  if (!checkAuth(c)) return c.json({ error: 'Unauthorized' }, 401);

  try {
    const body = await c.req.json();
    const { id, title, excerpt, content, coverImage, categoryId, tags, isFeatured, audioUrl, author } = body;
    
    const now = Date.now();
    const tagString = JSON.stringify(tags || []);

    // Check if post exists
    const existing = await c.env.DB.prepare('SELECT id FROM posts WHERE id = ?').bind(id).first();

    if (existing) {
        await c.env.DB.prepare(`
            UPDATE posts SET title=?, excerpt=?, content=?, coverImage=?, updatedAt=?, categoryId=?, tags=?, isFeatured=?, audioUrl=?
            WHERE id=?
        `).bind(title, excerpt, content, coverImage, now, categoryId, tagString, isFeatured ? 1 : 0, audioUrl, id).run();
    } else {
        await c.env.DB.prepare(`
            INSERT INTO posts (id, title, excerpt, content, coverImage, createdAt, updatedAt, categoryId, tags, isFeatured, audioUrl, authorName)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(id, title, excerpt, content, coverImage, now, now, categoryId, tagString, isFeatured ? 1 : 0, audioUrl, author?.username || 'Admin').run();
    }

    return c.json({ success: true, id });
  } catch (e: any) {
    console.error("Save Error:", e);
    return c.json({ error: e.message }, 500);
  }
});

// 4. Upload File to R2 (Protected)
app.put('/api/upload', async (c) => {
  if (!checkAuth(c)) return c.json({ error: 'Unauthorized' }, 401);

  try {
    const formData = await c.req.parseBody();
    const file = formData['file'];

    if (!file || !(file instanceof File)) {
        return c.json({ error: 'No file uploaded' }, 400);
    }

    const fileName = `${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.-]/g, '')}`;
    
    // Upload to R2
    await c.env.BUCKET.put(fileName, file.stream(), {
        httpMetadata: { contentType: file.type }
    });

    // Construct Public URL
    // 1. Best: Use the configured custom domain from environment variables
    // 2. Fallback: Try to guess an R2.dev URL (Requires R2 "Public Access" enabled in dashboard)
    // 3. Placeholder: If neither is set, user needs to configure it.
    let publicUrl = '';
    
    if (c.env.R2_PUBLIC_DOMAIN) {
        publicUrl = `${c.env.R2_PUBLIC_DOMAIN}/${fileName}`;
    } else {
        // NOTE: This is a placeholder! You need to enable Public Access for your R2 bucket
        // and replace this with your actual R2.dev subdomain or Custom Domain.
        // Go to Cloudflare Dashboard -> R2 -> Your Bucket -> Settings -> Public Access
        publicUrl = `https://REPLACE_WITH_YOUR_R2_SUBDOMAIN.r2.dev/${fileName}`;
    }

    return c.json({ url: publicUrl });
  } catch (e: any) {
    console.error("Upload Error:", e);
    return c.json({ error: e.message }, 500);
  }
});

// 5. Get Categories
app.get('/api/categories', async (c) => {
  try {
    const { results } = await c.env.DB.prepare('SELECT * FROM categories').all();
    return c.json(results);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

export default app;