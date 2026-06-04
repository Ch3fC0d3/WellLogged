const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const db = require('../db');
const storage = require('../storage');
const { sendEmail } = require('../email');
const { sendAdminSMS } = require('../sms');
const { sendPushoverUploadAlert } = require('../pushover');
const stripe = process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY !== 'sk_test_...' ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
const router = express.Router();

const requireAdmin = (req, res, next) => {
    console.log(`[requireAdmin] Endpoint: ${req.method} ${req.url}`);
    console.log(`[requireAdmin] Session ID: ${req.sessionID}, UserID: ${req.session.userId}`);
    
    if (!req.session.userId) {
        console.log(`[requireAdmin] Rejected: No req.session.userId`);
        return res.status(403).json({ error: 'Forbidden: Admins only' });
    }
    // Verify admin role directly from DB to avoid stale session cache
    db.get('SELECT role, email FROM users WHERE id = ?', [req.session.userId], (err, user) => {
        if (err) {
            console.log(`[requireAdmin] Rejected: DB error: ${err}`);
            return res.status(403).json({ error: 'Forbidden: Admins only (DB error)' });
        }
        if (!user) {
            console.log(`[requireAdmin] Rejected: User ${req.session.userId} not found in DB`);
            return res.status(403).json({ error: 'Forbidden: Admins only (user not found)' });
        }
        if (user.role !== 'admin') {
            console.log(`[requireAdmin] Rejected: User ${user.email} role is "${user.role}", not admin`);
            return res.status(403).json({ error: `Forbidden: Admins only (your role is "${user.role}")` });
        }
        console.log(`[requireAdmin] Accepted: User ${user.email} is admin`);
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

// Reset a user's password (admin only).
// If no password is provided in the body, a secure random one is generated and returned.
router.post('/users/:id/reset-password', requireAdmin, async (req, res) => {
    const userId = req.params.id;
    let { password } = req.body || {};

    try {
        // Generate a strong temporary password when one isn't supplied.
        const generated = !password;
        if (generated) {
            password = crypto.randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
        } else if (typeof password !== 'string' || password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters.' });
        }

        const hash = await bcrypt.hash(password, 10);
        db.run(
            `UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expiry = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [hash, userId],
            function (err) {
                if (err) return res.status(500).json({ error: 'Database error' });
                if (this.changes === 0) return res.status(404).json({ error: 'User not found' });

                // Only return the plaintext password when we generated it, so the admin can relay it.
                res.json({
                    message: 'Password reset successfully.',
                    password: generated ? password : undefined
                });
            }
        );
    } catch (e) {
        console.error('Admin password reset failed:', e);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Send a test email to verify SMTP configuration (admin only).
router.post('/test-email', requireAdmin, async (req, res) => {
    let { to } = req.body || {};
    const fromAddress = process.env.MAIL_FROM || process.env.FROM_EMAIL || process.env.SMTP_USER || 'noreply@logdigitizing.ai';

    // Default to the admin's own account email if no recipient is provided.
    if (!to) {
        try {
            to = await new Promise((resolve) => {
                db.get(`SELECT email FROM users WHERE id = ?`, [req.session.userId], (err, row) => resolve(row && row.email));
            });
        } catch (e) { /* ignore */ }
    }
    if (!to) return res.status(400).json({ error: 'No recipient address available.' });

    try {
        const info = await sendEmail({
            to,
            subject: 'Log Digitizing - Test Email',
            text: `This is a test email confirming your SMTP configuration is working.\n\nSent from: ${fromAddress}\nTime: ${new Date().toISOString()}`,
            html: `<p>This is a test email confirming your SMTP configuration is working.</p><p><strong>Sent from:</strong> ${fromAddress}<br><strong>Time:</strong> ${new Date().toISOString()}</p>`
        });
        res.json({ message: `Test email sent to ${to} (and any BCC monitoring address).`, messageId: info.messageId });
    } catch (e) {
        console.error('Test email failed:', e);
        res.status(500).json({ error: `Failed to send: ${e.message}` });
    }
});

// Send a test SMS to verify Twilio configuration (admin only).
router.post('/test-sms', requireAdmin, async (req, res) => {
    try {
        const msg = await sendAdminSMS(`Log Digitizing - Test SMS\nTime: ${new Date().toLocaleString()}`);
        res.json({ message: 'Test SMS sent successfully.', sid: msg ? msg.sid : null });
    } catch (e) {
        console.error('Test SMS failed:', e);
        res.status(500).json({ error: `Failed to send: ${e.message}` });
    }
});

// Send a test Pushover alert (admin only).
router.post('/test-pushover', requireAdmin, async (req, res) => {
    try {
        const result = await sendPushoverUploadAlert({ clientName: 'Test Client', filename: 'test_well_log.tif', emergency: true });
        if (result) {
            res.json({ message: 'Pushover test alert sent.', receipt: result.receipt || null });
        } else {
            const missing = [];
            if (!process.env.PUSHOVER_API_TOKEN) missing.push('PUSHOVER_API_TOKEN');
            if (!process.env.PUSHOVER_USER_KEY) missing.push('PUSHOVER_USER_KEY');
            if (missing.length > 0) {
                res.status(500).json({ error: `Pushover not configured. Missing Railway variables: ${missing.join(', ')}` });
            } else {
                res.status(500).json({ error: 'Pushover API call failed. Check server logs for details.' });
            }
        }
    } catch (e) {
        console.error('Test Pushover failed:', e);
        res.status(500).json({ error: `Failed to send: ${e.message}` });
    }
});

// List notifications + unread count (admin only).
router.get('/notifications', requireAdmin, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);
    db.all(`SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?`, [limit], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        db.get(`SELECT COUNT(*) AS unread FROM notifications WHERE is_read = 0`, (err2, row) => {
            if (err2) return res.status(500).json({ error: 'Database error' });
            res.json({ notifications: rows || [], unread: row ? row.unread : 0 });
        });
    });
});

// Mark notifications as read. Pass { id } for one, or omit to mark all read.
router.post('/notifications/read', requireAdmin, (req, res) => {
    const { id } = req.body || {};
    if (id) {
        db.run(`UPDATE notifications SET is_read = 1 WHERE id = ?`, [id], (err) => {
            if (err) return res.status(500).json({ error: 'Database error' });
            res.json({ message: 'Notification marked read.' });
        });
    } else {
        db.run(`UPDATE notifications SET is_read = 1 WHERE is_read = 0`, [], (err) => {
            if (err) return res.status(500).json({ error: 'Database error' });
            res.json({ message: 'All notifications marked read.' });
        });
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

            // If the admin set/changed the price, notify the user.
            if (this.changes > 0 && amount_due != null) {
                db.get(`
                    SELECT logs.title, logs.status AS log_status, users.email, users.name, users.email_notifications
                    FROM logs
                    JOIN users ON logs.user_id = users.id
                    WHERE logs.id = ?
                `, [logId], (err2, row) => {
                    if (err2 || !row || row.email_notifications === 0) return;
                    const priceDollars = (amount_due / 100).toFixed(2);
                    const subject = row.log_status === 'ready_unpaid'
                        ? `Project Ready: ${row.title} – Payment Due: $${priceDollars}`
                        : `Price Updated: ${row.title} – New Amount: $${priceDollars}`;
                    sendEmail({
                        to: row.email,
                        subject: subject,
                        text: `Hi ${row.name || 'there'},\n\nYour project "${row.title}" has been updated with a new price of $${priceDollars}.\n\n${row.log_status === 'ready_unpaid' ? 'It is now ready for payment. ' : ''}You can log in to your dashboard to review and complete payment at any time.\n\nThank you,\nThe Log Digitizing Team`,
                        html: `<p>Hi ${row.name || 'there'},</p><p>Your project "<strong>${row.title}</strong>" has been updated with a new price of <strong>$${priceDollars}</strong>.</p>${row.log_status === 'ready_unpaid' ? '<p>It is now ready for payment.</p>' : ''}<p>You can log in to your <a href="https://logdigitizing.ai/dashboard">dashboard</a> to review and complete payment at any time.</p><p>Thank you,<br>The Log Digitizing Team</p>`
                    }).catch(e => console.error('Failed to send price-update email:', e));
                });
            }
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

                // Send Email Notification to User
                db.get(`
                    SELECT logs.title, users.email, users.name, users.email_notifications 
                    FROM logs 
                    JOIN users ON logs.user_id = users.id 
                    WHERE logs.id = ?
                `, [logId], (err, row) => {
                    if (!err && row && row.email_notifications !== 0) {
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
        if (req.file) try { fs.unlinkSync(req.file.path); } catch (e) {}
        return res.status(500).json({ error: 'File upload failed.' });
    }
});

module.exports = router;
