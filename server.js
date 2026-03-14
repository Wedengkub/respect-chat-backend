const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' })); // Support base64 images
app.use(express.static(path.join(__dirname, 'public')));

// Connect to SQLite DB
const dbPath = path.join(__dirname, '../../../../Downloads/respect_chat_v2.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database', err.message);
    } else {
        console.log('Connected to the SQLite database (v2).');
        
        // Initialize Schema for v2
        db.serialize(() => {
            db.run(`CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                friend_id TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL,
                avatar_seed TEXT NOT NULL,
                phone_number TEXT UNIQUE NOT NULL
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS friends (
                user_id TEXT NOT NULL,
                friend_id TEXT NOT NULL,
                UNIQUE(user_id, friend_id)
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                room_id TEXT NOT NULL,
                sender_id TEXT NOT NULL,
                text TEXT NOT NULL,
                timestamp INTEGER NOT NULL
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS posts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                image_data TEXT,
                caption TEXT NOT NULL,
                timestamp INTEGER NOT NULL
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS post_likes (
                post_id INTEGER NOT NULL,
                user_id TEXT NOT NULL,
                UNIQUE(post_id, user_id)
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS post_comments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                post_id INTEGER NOT NULL,
                user_id TEXT NOT NULL,
                parent_id INTEGER,
                text TEXT NOT NULL,
                timestamp INTEGER NOT NULL
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS notifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                target_user_id TEXT NOT NULL,
                actor_user_id TEXT NOT NULL,
                action_type TEXT NOT NULL,
                post_id INTEGER,
                read_status INTEGER DEFAULT 0,
                timestamp INTEGER NOT NULL
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS groups (
                group_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                avatar TEXT,
                members TEXT NOT NULL,
                created_at INTEGER NOT NULL
            )`);
        });
    }
});

// Helper for DB queries
const dbRun = (query, params = []) => {
    return new Promise((resolve, reject) => {
        db.run(query, params, function (err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
};

const dbGet = (query, params = []) => {
    return new Promise((resolve, reject) => {
        db.get(query, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
};

const dbAll = (query, params = []) => {
    return new Promise((resolve, reject) => {
        db.all(query, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
};

// --- AUTH & USER ---

app.post('/api/register', async (req, res) => {
    const { phone_number, name, avatar } = req.body;
    try {
        const friend_id = Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit ID
        const finalAvatar = avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=random&color=fff`;

        await dbRun(
            `INSERT INTO users (friend_id, name, avatar_seed, phone_number) VALUES (?, ?, ?, ?)`,
            [friend_id, name, finalAvatar, phone_number]
        );
        res.json({ friend_id, name, avatar: finalAvatar, phone_number });
    } catch (err) {
        if (err.message.includes('UNIQUE constraint failed')) {
            res.json({ error: 'เบอร์โทรศัพท์นี้ลงทะเบียนไปแล้วครับ สามารถใช้ Login ได้เลย' });
        } else {
            res.json({ error: 'เกิดข้อผิดพลาด: ' + err.message });
        }
    }
});

app.post('/api/login', async (req, res) => {
    const { phone_number } = req.body;
    try {
        const user = await dbGet(`SELECT friend_id, name, avatar_seed as avatar, phone_number FROM users WHERE phone_number = ?`, [phone_number]);

        if (user) {
            res.json(user);
        } else {
            res.status(404).json({ error: 'ไม่พบเบอร์โทรนี้ในระบบ กรุณาสมัครสมาชิกใหม่ครับ' });
        }
    } catch (err) {
        res.status(500).json({ error: 'เกิดข้อผิดพลาด: ' + err.message });
    }
});

app.put('/api/users/:user_id/name', async (req, res) => {
    const { name } = req.body;
    try {
        await dbRun(`UPDATE users SET name = ? WHERE friend_id = ?`, [name, req.params.user_id]);
        res.json({ success: true, name });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/users/:user_id/avatar', async (req, res) => {
    const { avatar } = req.body;
    try {
        await dbRun(`UPDATE users SET avatar_seed = ? WHERE friend_id = ?`, [avatar, req.params.user_id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- FRIENDS & CONTACTS ---

app.post('/api/add_friend', async (req, res) => {
    const { my_id, target_friend_id } = req.body;
    if (my_id === target_friend_id) return res.json({ error: 'เพิ่มตัวเองไม่ได้ครับ' });

    try {
        const targetUser = await dbGet(`SELECT name FROM users WHERE friend_id = ?`, [target_friend_id]);
        if (!targetUser) return res.json({ error: 'ไม่พบผู้ใช้ที่ระบุ' });

        // Add both ways
        await dbRun(`INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)`, [my_id, target_friend_id]);
        await dbRun(`INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)`, [target_friend_id, my_id]);

        res.json({ name: targetUser.name });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/friends/:user_id', async (req, res) => {
    try {
        const friends = await dbAll(`
            SELECT u.friend_id, u.name, u.avatar_seed as avatar 
            FROM friends f
            JOIN users u ON f.friend_id = u.friend_id
            WHERE f.user_id = ?
        `, [req.params.user_id]);
        res.json(friends);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- GROUPS ---
app.post('/api/groups', async (req, res) => {
    const { name, avatar, members } = req.body; // members is array of friend_id
    try {
        const groupId = 'group-' + Date.now();
        await dbRun(`INSERT INTO groups (group_id, name, avatar, members, created_at) VALUES (?, ?, ?, ?, ?)`, 
            [groupId, name, avatar, JSON.stringify(members), Date.now()]
        );
        res.json({ success: true, group_id: groupId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/groups/:user_id', async (req, res) => {
    try {
        const groups = await dbAll(`SELECT * FROM groups`);
        // Filter groups where user is a member
        const userGroups = groups.filter(g => {
            const members = JSON.parse(g.members);
            return members.includes(req.params.user_id);
        }).map(g => ({
            group_id: g.group_id,
            name: g.name,
            avatar: g.avatar,
            members: JSON.parse(g.members)
        }));
        res.json(userGroups);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- CHAT MESSAGES ---

app.post('/api/messages', async (req, res) => {
    const { room_id, sender_id, text } = req.body;
    try {
        await dbRun(`INSERT INTO messages (room_id, sender_id, text, timestamp) VALUES (?, ?, ?, ?)`,
            [room_id, sender_id, text, Date.now()]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/messages/:room_id', async (req, res) => {
    const after = req.query.after || 0;
    try {
        const messages = await dbAll(`
            SELECT m.*, u.name as sender_name 
            FROM messages m
            LEFT JOIN users u ON m.sender_id = u.friend_id
            WHERE m.room_id = ? AND m.timestamp > ?
            ORDER BY m.timestamp ASC
        `, [req.params.room_id, after]);
        res.json(messages);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// For Notifications polling (Chat Sync)
app.get('/api/chat_sync/:user_id', async (req, res) => {
    try {
        // Find latest message for each room the user is likely part of
        // This is a simplified logic. In real production, we track read states per room.
        const recentMessages = await dbAll(`
            SELECT * FROM messages 
            WHERE room_id LIKE ? OR room_id LIKE ? 
               OR room_id IN (SELECT group_id FROM groups WHERE members LIKE ?)
            ORDER BY timestamp DESC LIMIT 50
        `, [`%${req.params.user_id}%`, `${req.params.user_id}_%`, `%${req.params.user_id}%`]);

        // Group by room to get latest per room
        const result = {};
        for(let msg of recentMessages) {
             // Find who the other person/group is
             let senderId = msg.sender_id;
             let roomKey = '';
             
             if (msg.room_id.startsWith('group-')) {
                 roomKey = msg.room_id;
             } else {
                 const parts = msg.room_id.split('_');
                 roomKey = parts[0] === req.params.user_id ? parts[1] : parts[0];
             }
             
             if (!result[roomKey] || result[roomKey].timestamp < msg.timestamp) {
                 result[roomKey] = msg;
             }
        }
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- POSTS ---

app.post('/api/posts', async (req, res) => {
    const { user_id, image_data, caption } = req.body;
    try {
        await dbRun(`INSERT INTO posts (user_id, image_data, caption, timestamp) VALUES (?, ?, ?, ?)`,
            [user_id, image_data, caption, Date.now()]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/posts', async (req, res) => {
    const currentUserId = req.query.user_id;
    const authorId = req.query.author_id;

    try {
        let query = `
            SELECT p.*, u.name, u.avatar_seed as avatar,
                   (SELECT COUNT(*) FROM post_likes WHERE post_id = p.id) as like_count,
                   (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) as comment_count,
                   (SELECT COUNT(*) FROM post_likes WHERE post_id = p.id AND user_id = ?) as has_liked
            FROM posts p
            JOIN users u ON p.user_id = u.friend_id
        `;
        let params = [currentUserId];

        if (authorId) {
            query += ` WHERE p.user_id = ? `;
            params.push(authorId);
        }

        query += ` ORDER BY p.timestamp DESC`;

        const posts = await dbAll(query, params);
        res.json(posts);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Likes
app.post('/api/posts/:post_id/like', async (req, res) => {
    const { user_id } = req.body;
    const post_id = req.params.post_id;
    try {
        const existingLike = await dbGet(`SELECT * FROM post_likes WHERE post_id = ? AND user_id = ?`, [post_id, user_id]);
        let liked = false;
        if (existingLike) {
            await dbRun(`DELETE FROM post_likes WHERE post_id = ? AND user_id = ?`, [post_id, user_id]);
        } else {
            await dbRun(`INSERT INTO post_likes (post_id, user_id) VALUES (?, ?)`, [post_id, user_id]);
            liked = true;
            
            // Notification logic
            const post = await dbGet(`SELECT user_id FROM posts WHERE id = ?`, [post_id]);
            if (post.user_id !== user_id) {
                await dbRun(`INSERT INTO notifications (target_user_id, actor_user_id, action_type, post_id, timestamp) VALUES (?, ?, 'like', ?, ?)`,
                    [post.user_id, user_id, post_id, Date.now()]
                );
            }
        }

        const countRow = await dbGet(`SELECT COUNT(*) as count FROM post_likes WHERE post_id = ?`, [post_id]);
        res.json({ liked, count: countRow.count });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Comments
app.post('/api/posts/:post_id/comments', async (req, res) => {
    const { user_id, text, parent_id } = req.body;
    const post_id = req.params.post_id;
    try {
        await dbRun(`INSERT INTO post_comments (post_id, user_id, parent_id, text, timestamp) VALUES (?, ?, ?, ?, ?)`,
            [post_id, user_id, parent_id || null, text, Date.now()]
        );

        // Notification logic
        const post = await dbGet(`SELECT user_id FROM posts WHERE id = ?`, [post_id]);
        let targetId = post.user_id;

        if (parent_id) {
            const parentComment = await dbGet(`SELECT user_id FROM post_comments WHERE id = ?`, [parent_id]);
            if (parentComment) targetId = parentComment.user_id;
        }

        if (targetId !== user_id) {
            await dbRun(`INSERT INTO notifications (target_user_id, actor_user_id, action_type, post_id, timestamp) VALUES (?, ?, ?, ?, ?)`,
                [targetId, user_id, parent_id ? 'reply' : 'comment', post_id, Date.now()]
            );
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/posts/:post_id/comments', async (req, res) => {
    try {
        const comments = await dbAll(`
            SELECT c.*, u.name, u.avatar_seed as avatar
            FROM post_comments c
            JOIN users u ON c.user_id = u.friend_id
            WHERE c.post_id = ?
            ORDER BY c.timestamp ASC
        `, [req.params.post_id]);
        res.json(comments);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- NOTIFICATIONS ---
app.get('/api/notifications/:user_id', async (req, res) => {
    try {
        const notifications = await dbAll(`
            SELECT n.*, u.name as actor_name, u.avatar_seed as actor_avatar
            FROM notifications n
            JOIN users u ON n.actor_user_id = u.friend_id
            WHERE n.target_user_id = ?
            ORDER BY n.timestamp DESC LIMIT 30
        `, [req.params.user_id]);
        res.json(notifications);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/notifications/:user_id/read', async (req, res) => {
    try {
        await dbRun(`UPDATE notifications SET read_status = 1 WHERE target_user_id = ?`, [req.params.user_id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// QR Code generation (basic placeholder)
app.get('/api/qr/:friend_id.png', (req, res) => {
    // In a real app we would use 'qrcode' package. 
    // Here we just redirect to a dummy image generator using UI-Avatars or return 404.
    res.redirect(`https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${req.params.friend_id}`);
});

app.listen(port, () => {
    console.log(`Backend server running at http://localhost:${port}`);
});
