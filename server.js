require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const app = express();

const authRoutes = require('./routes/auth');
const logsRoutes = require('./routes/logs');
const billingRoutes = require('./routes/billing');
const stripeRoutes = require('./routes/stripe');
const adminRoutes = require('./routes/admin');
const db = require('./db');
const storage = require('./storage');
const { sendEmail } = require('./email');

// Webhook route must be before body-parser because it needs raw body
app.use('/api/stripe', stripeRoutes);

// Body Parsing Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS
app.use(cors());

const dataDir = path.resolve(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const sessionDbPath = path.resolve(process.env.SESSION_DB_PATH || path.join(dataDir, 'sessions.db'));
console.log(`[session] Using SQLite session store at: ${sessionDbPath}`);

// Session Configuration
app.set('trust proxy', 1); // Trust first proxy
app.use(session({
    store: new SQLiteStore({
        db: path.basename(sessionDbPath),
        dir: path.dirname(sessionDbPath)
    }),
    secret: process.env.SESSION_SECRET || 'secret_logdigitizing_key_123',
    resave: false,
    saveUninitialized: false,
    cookie: {
        sameSite: 'lax',
        maxAge: 1000 * 60 * 60 * 24 * 7 // 7 days
    }
}));

// Setup API Routes with cache prevention
app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
});

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
const adminOutputUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, uploadsDir),
        filename: (req, file, cb) => cb(null, 'output-' + Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname))
    }),
    limits: { fileSize: 200 * 1024 * 1024 }
});

function requireAdminForOutput(req, res, next) {
    if (!req.session.userId) return res.status(403).json({ error: 'Forbidden: Admins only' });
    db.get('SELECT role FROM users WHERE id = ?', [req.session.userId], (err, user) => {
        if (err || !user || user.role !== 'admin') {
            return res.status(403).json({ error: 'Forbidden: Admins only' });
        }
        next();
    });
}

function storedOutputFiles(log) {
    if (!log || !log.output_file_key) return [];
    try {
        const keyItems = JSON.parse(log.output_file_key);
        if (Array.isArray(keyItems)) {
            let urlItems = [];
            try {
                const parsedUrls = JSON.parse(log.output_file_url || '[]');
                urlItems = Array.isArray(parsedUrls) ? parsedUrls : [];
            } catch (e) {}
            return keyItems.map((item, index) => ({
                name: item.name || `Output file ${index + 1}`,
                key: item.key || item,
                url: (urlItems[index] && (urlItems[index].url || urlItems[index])) || item.url || ''
            })).filter(file => file.key || file.url);
        }
    } catch (e) {}
    return [{ name: path.basename(log.output_file_key || log.output_file_url || 'output-file'), key: log.output_file_key, url: log.output_file_url }];
}

async function attachOutputUrls(log) {
    const files = storedOutputFiles(log);
    if (!files.length) return;
    const signed = [];
    for (const file of files) {
        let downloadUrl = file.url;
        if (file.key) {
            try { downloadUrl = await storage.getDownloadUrl(file.key); }
            catch (e) { downloadUrl = file.url; }
        }
        signed.push({ ...file, download_url: downloadUrl });
    }
    log.output_files = signed;
    log.output_download_url = signed[0].download_url;
}

// Override the legacy single-file output endpoint so the same admin button can submit multiple files.
app.post('/api/admin/logs/:id/output', requireAdminForOutput, adminOutputUpload.array('file', 20), async (req, res) => {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'No files provided.' });

    try {
        const uploadResults = [];
        for (const file of files) {
            const uploadResult = await storage.uploadFile(file);
            uploadResults.push({
                name: file.originalname,
                mimetype: file.mimetype,
                size: file.size,
                url: uploadResult.url,
                key: uploadResult.key
            });
        }

        const outputFileUrl = uploadResults.length === 1
            ? uploadResults[0].url
            : JSON.stringify(uploadResults.map(file => ({ name: file.name, mimetype: file.mimetype, size: file.size, url: file.url })));
        const outputFileKey = uploadResults.length === 1
            ? uploadResults[0].key
            : JSON.stringify(uploadResults.map(file => ({ name: file.name, mimetype: file.mimetype, size: file.size, key: file.key })));

        db.run(
            `UPDATE logs SET output_file_url = ?, output_file_key = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [outputFileUrl, outputFileKey, req.body.status || 'ready_unpaid', req.params.id],
            function(err) {
                if (err) return res.status(500).json({ error: 'Database error' });
                res.json({ message: `${uploadResults.length} output file${uploadResults.length === 1 ? '' : 's'} uploaded successfully`, files: uploadResults });

                db.get(`
                    SELECT logs.title, users.email, users.name, users.email_notifications
                    FROM logs
                    JOIN users ON logs.user_id = users.id
                    WHERE logs.id = ?
                `, [req.params.id], (emailErr, row) => {
                    if (!emailErr && row && row.email_notifications !== 0) {
                        sendEmail({
                            to: row.email,
                            subject: `Project Ready: ${row.title}`,
                            text: `Hi ${row.name || 'there'},\n\nYour project "${row.title}" has been successfully digitized and is ready for download!\n\nPlease log in to your dashboard to view and download your files.\n\nThank you,\nThe Log Digitizing Team`,
                            html: `<p>Hi ${row.name || 'there'},</p><p>Your project "<strong>${row.title}</strong>" has been successfully digitized and is ready for download!</p><p>Please log in to your <a href="https://logdigitizing.ai/dashboard">dashboard</a> to view and download your files.</p><p>Thank you,<br>The Log Digitizing Team</p>`
                        }).catch(e => console.error('Failed to send project ready email:', e));
                    }
                });
            }
        );
    } catch (err) {
        console.error('Output upload failed:', err);
        for (const file of files) {
            try { fs.unlinkSync(file.path); } catch (e) {}
        }
        return res.status(500).json({ error: 'File upload failed.' });
    }
});

app.get('/api/logs/:id', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    db.get(`SELECT * FROM logs WHERE id = ? AND user_id = ?`, [req.params.id, req.session.userId], async (err, log) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!log) return res.status(404).json({ error: 'Log not found' });

        if (log.source_file_key) {
            try { log.download_url = await storage.getDownloadUrl(log.source_file_key); }
            catch (e) { log.download_url = log.source_file_url; }
        } else {
            log.download_url = log.source_file_url;
        }

        db.get('SELECT role FROM users WHERE id = ?', [req.session.userId], async (roleErr, user) => {
            const isAdmin = user && user.role === 'admin';
            if (['paid', 'delivered'].includes(log.status) || isAdmin) {
                await attachOutputUrls(log);
            } else {
                delete log.output_file_key;
                delete log.output_file_url;
                delete log.output_files;
                log.output_download_url = null;
            }
            res.json({ log });
        });
    });
});

app.use('/api/auth', authRoutes);
app.use('/api/logs', logsRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/admin', adminRoutes);

// Serve static frontend files from 'public'
app.use(express.static(path.join(__dirname, 'public')));
// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Protect and serve dashboard routes
app.use('/dashboard', (req, res, next) => {
    // Prevent caching of this route and its redirects to avoid infinite loops
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    
    if (!req.session.userId) {
        console.log(`[Dashboard Redirect] No user session found. Redirecting to login.`);
        return res.redirect('/login.html');
    }
    
    // Serve dashboard.html for SPA routes starting with /dashboard
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
