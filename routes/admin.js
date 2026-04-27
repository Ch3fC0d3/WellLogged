const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const storage = require('../storage');
const stripe = process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY !== 'sk_test_...' ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
const router = express.Router();

const requireAdmin = (req, res, next) => {
    if (!req.session.userId) {
        return res.status(403).json({ error: 'Forbidden: Admins only' });
    }
    // Verify admin role directly from DB to avoid stale session cache
    db.get('SELECT role FROM users WHERE id = ?', [req.session.userId], (err, user) => {
        if (err || !user || user.role !== 'admin') {
            return res.status(403).json({ error: 'Forbidden: Admins only' });
        }
        next();
    });
};

// Multer setup for admin uploads
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
const multerStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => cb(null, 'output-' + Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname))
});
const upload = multer({ storage: multerStorage, limits: { fileSize: 200 * 1024 * 1024 } });

function getLocalUploadPath(keyOrUrl) {
    if (!keyOrUrl) return null;

    const basename = path.basename(keyOrUrl);
    if (!basename || basename === '.' || basename === '..') return null;

    const uploadRoot = path.resolve(uploadsDir);
    const filePath = path.resolve(uploadRoot, basename);
    const relativePath = path.relative(uploadRoot, filePath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) return null;

    return filePath;
}

function attachmentName(keyOrUrl) {
    return path.basename(keyOrUrl || 'source-file').replace(/"/g, '');
}

// Get all users
router.get('/users', requireAdmin, (req, res) => {
    db.all(`
        SELECT u.id, u.name, u.email, u.company, u.address, u.role, u.created_at, u.stripe_customer_id, s.status as subscription_status, s.plan_name 
        FROM users u 
        LEFT JOIN subscriptions s ON u.id = s.user_id 
        ORDER BY u.created_at DESC
    `, (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json({ users: rows });
    });
});

// Get specific user details, including billing
router.get('/users/:id', requireAdmin, async (req, res) => {
    const userId = req.params.id;
    try {
        const user = await new Promise((resolve, reject) => {
            db.get(`SELECT id, name, email, company, address, role, created_at, stripe_customer_id FROM users WHERE id = ?`, [userId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (!user) return res.status(404).json({ error: 'User not found' });

        const subscription = await new Promise((resolve, reject) => {
            db.get(`SELECT * FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`, [userId], (err, row) => {
                if (err) reject(err);
                else resolve(row || null);
            });
        });

        const invoices = await new Promise((resolve, reject) => {
            db.all(`SELECT * FROM invoices WHERE user_id = ? ORDER BY created_at DESC`, [userId], (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });

        res.json({ user, subscription, invoices });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Database error' });
    }
});

// Sync Stripe Data
router.post('/sync-stripe', requireAdmin, async (req, res) => {
    if (!stripe) return res.status(400).json({ error: 'Stripe is not configured properly' });

    try {
        db.all(`SELECT id, email, stripe_customer_id FROM users`, async (err, users) => {
            if (err) return res.status(500).json({ error: 'Database error' });

            let updatedCount = 0;
            const stripeCustomers = await stripe.customers.list({ limit: 100 });

            for (const user of users) {
                let customerId = user.stripe_customer_id;

                // 1. Match missing customer IDs by email
                if (!customerId) {
                    const match = stripeCustomers.data.find(c => c.email === user.email);
                    if (match) {
                        customerId = match.id;
                        db.run(`UPDATE users SET stripe_customer_id = ? WHERE id = ?`, [customerId, user.id]);
                        updatedCount++;
                    }
                }

                // 2. Fetch latest subscription status if they are a known customer
                if (customerId) {
                    const subs = await stripe.subscriptions.list({ customer: customerId, limit: 1 });
                    if (subs.data.length > 0) {
                        const sub = subs.data[0];
                        const planName = sub.items.data[0]?.price?.product || 'Unknown Plan';
                        
                        db.run(`INSERT INTO subscriptions (user_id, stripe_subscription_id, plan_name, status, current_period_end, cancel_at_period_end) 
                                VALUES (?, ?, ?, ?, ?, ?)
                                ON CONFLICT(stripe_subscription_id) DO UPDATE SET 
                                    status=excluded.status, 
                                    plan_name=excluded.plan_name,
                                    current_period_end=excluded.current_period_end, 
                                    cancel_at_period_end=excluded.cancel_at_period_end,
                                    updated_at=CURRENT_TIMESTAMP`,
                            [user.id, sub.id, planName, sub.status, sub.current_period_end, sub.cancel_at_period_end ? 1 : 0]);
                    }
                }
            }

            res.json({ message: `Successfully synced Stripe data. ${updatedCount} records were newly linked.` });
        });
    } catch (e) {
        console.error('Stripe Sync Error:', e);
        res.status(500).json({ error: 'Failed to sync with Stripe' });
    }
});

// Get all logs
router.get('/logs', requireAdmin, (req, res) => {
    db.all(`
        SELECT logs.*, users.email as user_email, users.name as user_name 
        FROM logs 
        JOIN users ON logs.user_id = users.id 
        ORDER BY logs.created_at DESC
    `, (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json({ logs: rows });
    });
});

// Download (or preview) the original user-submitted source file
router.get('/logs/:id/source/download', requireAdmin, async (req, res) => {
    const logId = req.params.id;
    const isPreview = req.query.preview === '1';

    try {
        const log = await new Promise((resolve, reject) => {
            db.get(
                `SELECT source_file_url, source_file_key FROM logs WHERE id = ?`,
                [logId],
                (err, row) => err ? reject(err) : resolve(row)
            );
        });

        if (!log) return res.status(404).json({ error: 'Log not found' });

        const sourceRef = log.source_file_key || log.source_file_url;
        if (!sourceRef) return res.status(404).json({ error: 'Source file not found' });

        // Cloud Storage (GCS): generate signed URL with appropriate disposition
        if (storage.isUsingCloud && log.source_file_key && log.source_file_key.startsWith('logs/')) {
            const filename = attachmentName(log.source_file_key);
            const downloadUrl = await storage.getDownloadUrl(log.source_file_key, isPreview ? undefined : {
                responseDisposition: `attachment; filename="${filename}"`
            });
            return res.redirect(downloadUrl);
        }

        // External URL: redirect as-is
        if (/^https?:\/\//i.test(sourceRef)) {
            return res.redirect(sourceRef);
        }

        // Local file: serve inline or download
        const filePath = getLocalUploadPath(sourceRef);
        if (!filePath || !fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'Source file not found' });
        }

        if (isPreview) {
            return res.sendFile(filePath, (err) => {
                if (err && !res.headersSent) {
                    res.status(500).json({ error: 'File preview failed' });
                }
            });
        }

        return res.download(filePath, attachmentName(sourceRef), (err) => {
            if (err && !res.headersSent) {
                res.status(500).json({ error: 'File download failed' });
            }
        });
    } catch (err) {
        console.error('Source download failed:', err);
        return res.status(500).json({ error: 'File download failed' });
    }
});

// Update a log's status and output file
router.patch('/logs/:id', requireAdmin, (req, res) => {
    const logId = req.params.id;
    const { status, output_file_url, amount_due } = req.body;
    
    db.run(
        `UPDATE logs SET status = COALESCE(?, status), output_file_url = COALESCE(?, output_file_url), amount_due = COALESCE(?, amount_due), updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [status, output_file_url, amount_due, logId],
        function(err) {
            if (err) return res.status(500).json({ error: 'Database error' });
            res.json({ message: 'Log updated successfully' });
        }
    );
});

// Upload output/deliverable file for a log
router.post('/logs/:id/output', requireAdmin, upload.single('file'), async (req, res) => {
    const logId = req.params.id;

    if (!req.file) {
        return res.status(400).json({ error: 'No file provided.' });
    }

    try {
        const uploadResult = await storage.uploadFile(req.file);
        const newStatus = req.body.status || 'ready_unpaid';

        db.run(
            `UPDATE logs SET output_file_url = ?, output_file_key = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [uploadResult.url, uploadResult.key, newStatus, logId],
            function(err) {
                if (err) {
                    console.error('DB update failed:', err);
                    return res.status(500).json({ error: 'Database error' });
                }
                res.json({ message: 'Output file uploaded successfully', url: uploadResult.url, key: uploadResult.key });
            }
        );
    } catch (err) {
        console.error('Output upload failed:', err);
        if (req.file) try { fs.unlinkSync(req.file.path); } catch (e) {}
        return res.status(500).json({ error: 'File upload failed.' });
    }
});

module.exports = router;
