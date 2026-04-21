const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const db = require('../db');
const storage = require('../storage');
const router = express.Router();

const requireAuth = (req, res, next) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    next();
};

// Ensure uploads directory exists for multer temp/local storage
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Setup Multer for temp file reception
const multerStorage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, uploadsDir) },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname))
    }
})
const upload = multer({ storage: multerStorage, limits: { fileSize: 100 * 1024 * 1024 } });

// --- PUBLIC ROUTE: Account creation + Quote Submission ---
router.post('/public', upload.single('file'), async (req, res) => {
    const { name, email, password, company, title, well_name, api_number, footage, num_logs, curves, notes } = req.body;

    if (!name || !email || !password || !title) {
        if (req.file) try { fs.unlinkSync(req.file.path); } catch (e) {}
        return res.status(400).json({ error: 'Name, email, password, and project title are required.' });
    }

    if (!req.file) {
        return res.status(400).json({ error: 'Source file is required.' });
    }

    // 1. Check if email already exists
    db.get('SELECT id FROM users WHERE email = ?', [email], async (err, row) => {
        if (err) {
            if (req.file) try { fs.unlinkSync(req.file.path); } catch (e) {}
            return res.status(500).json({ error: 'Database error.' });
        }
        if (row) {
            if (req.file) try { fs.unlinkSync(req.file.path); } catch (e) {}
            return res.status(400).json({ error: 'An account with this email already exists. Please log in first.' });
        }

        // 2. Upload file to GCS
        let uploadResult;
        try {
            uploadResult = await storage.uploadFile(req.file);
        } catch (err) {
            console.error('Upload failed:', err);
            if (req.file) try { fs.unlinkSync(req.file.path); } catch (e) {}
            return res.status(500).json({ error: 'File upload failed. Please try again.' });
        }

        // 3. Create user
        const hash = await bcrypt.hash(password, 10);
        db.run(
            `INSERT INTO users (name, email, password_hash, company) VALUES (?, ?, ?, ?)`,
            [name, email, hash, company || null],
            function (err) {
                if (err) {
                    console.error('User insert failed:', err);
                    return res.status(500).json({ error: 'Failed to create user account.' });
                }
                
                const userId = this.lastID;

                // 4. Create log project
                db.run(
                    `INSERT INTO logs (user_id, title, well_name, api_number, footage, num_logs, curves, notes, source_file_url, source_file_key)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        userId,
                        title,
                        well_name || null,
                        api_number || null,
                        parseInt(footage) || 0,
                        parseInt(num_logs) || 1,
                        parseInt(curves) || 1,
                        notes || '',
                        uploadResult.url,
                        uploadResult.key
                    ],
                    function (err) {
                        if (err) {
                            console.error('Log insert failed:', err);
                            return res.status(500).json({ error: 'Account created, but failed to create log project.' });
                        }
                        
                        // 5. Automatically log the user in
                        req.session.userId = userId;
                        res.status(201).json({ message: 'Project submitted successfully!', redirect: '/dashboard' });
                    }
                );
            }
        );
    });
});
// ---------------------------------------------------------

// Get all logs for the logged-in user
router.get('/', requireAuth, (req, res) => {
    db.all(`SELECT * FROM logs WHERE user_id = ? ORDER BY created_at DESC`, [req.session.userId], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json({ logs: rows });
    });
});

// Get a specific log for the logged-in user (with signed download URL)
router.get('/:id', requireAuth, async (req, res) => {
    const logId = req.params.id;
    db.get(`SELECT * FROM logs WHERE id = ? AND user_id = ?`, [logId, req.session.userId], async (err, log) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!log) return res.status(404).json({ error: 'Log not found' });
        // Generate fresh signed URL if using cloud storage
        if (log.source_file_key) {
            try { log.download_url = await storage.getDownloadUrl(log.source_file_key); }
            catch (e) { log.download_url = log.source_file_url; }
        } else {
            log.download_url = log.source_file_url;
        }
        res.json({ log });
    });
});

// Create a new log with file upload
router.post('/', requireAuth, upload.single('file'), async (req, res) => {
    const { title, well_name, api_number, footage, notes, num_logs, curves } = req.body;

    if (!title) {
        if (req.file) try { fs.unlinkSync(req.file.path); } catch (e) {}
        return res.status(400).json({ error: 'Title/Project Name is required' });
    }

    if (!req.file) {
        return res.status(400).json({ error: 'Source file is required (Image or TIFF)' });
    }

    let uploadResult;
    try {
        uploadResult = await storage.uploadFile(req.file);
    } catch (err) {
        console.error('Upload failed:', err);
        try { fs.unlinkSync(req.file.path); } catch (e) {}
        return res.status(500).json({ error: 'File upload failed. Please try again.' });
    }

    db.run(
        `INSERT INTO logs (user_id, title, well_name, api_number, footage, num_logs, curves, notes, source_file_url, source_file_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            req.session.userId,
            title,
            well_name || null,
            api_number || null,
            parseInt(footage) || 0,
            parseInt(num_logs) || 1,
            parseInt(curves) || 1,
            notes || '',
            uploadResult.url,
            uploadResult.key
        ],
        function (err) {
            if (err) {
                console.error('DB insert failed:', err);
                return res.status(500).json({ error: 'Failed to create log' });
            }
            res.status(201).json({ message: 'Log created', log: { id: this.lastID, title, status: 'uploaded' } });
        }
    );
});

module.exports = router;
